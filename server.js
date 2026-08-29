import express from "express";
import multer from "multer";
import Replicate from "replicate";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const ROOT = process.cwd();

const REPLICATE_API_TOKEN =
  String(process.env.REPLICATE_API_TOKEN || "").trim();

const replicate = REPLICATE_API_TOKEN
  ? new Replicate({ auth: REPLICATE_API_TOKEN })
  : null;

const T2V_MODEL = "wan-video/wan-2.2-t2v-fast";
const I2V_MODEL = "wan-video/wan-2.2-i2v-fast";

const TMP = path.join(ROOT, "tmp");
const OUTPUT = path.join(ROOT, "outputs");
const PROJECTS = path.join(ROOT, "projects");
const INDEX = path.join(ROOT, "index.html");

await fs.mkdir(TMP, { recursive: true });
await fs.mkdir(OUTPUT, { recursive: true });
await fs.mkdir(PROJECTS, { recursive: true });

app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

/*
=========================================================
FRONTEND
=========================================================
*/

app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"));
});

app.use(express.static(ROOT, { index: false }));

/*
=========================================================
UPLOAD
=========================================================
*/

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 50
  }
});

/*
=========================================================
HELPERS
=========================================================
*/

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeRatio(value) {
  if (value === "9:16") return "9:16";
  if (value === "1:1") return "1:1";
  return "16:9";
}

function normalizeDuration(value) {
  return clamp(
    Math.round(safeNumber(value, 5)),
    5,
    60
  );
}

function isImage(file) {
  return !!file &&
    [
      "image/jpeg",
      "image/png",
      "image/webp"
    ].includes(file.mimetype);
}

function isVideo(file) {
  return !!file &&
    [
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-matroska"
    ].includes(file.mimetype);
}

function isAudio(file) {
  return !!file &&
    [
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/x-wav",
      "audio/mp4",
      "audio/aac",
      "audio/ogg",
      "audio/webm"
    ].includes(file.mimetype);
}

/*
=========================================================
REPLICATE OUTPUT
=========================================================
*/

async function downloadUrl(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Video download failed: HTTP ${response.status}`
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function replicateOutputToBuffer(output) {
  if (!output) {
    throw new Error("MAMAKI did not receive a video file.");
  }

  if (
    output instanceof Uint8Array ||
    Buffer.isBuffer(output)
  ) {
    return Buffer.from(output);
  }

  if (Array.isArray(output)) {
    if (!output.length) {
      throw new Error("MAMAKI did not receive a video file.");
    }

    return replicateOutputToBuffer(output[0]);
  }

  if (typeof output === "string") {
    if (
      output.startsWith("http://") ||
      output.startsWith("https://")
    ) {
      return downloadUrl(output);
    }
  }

  if (typeof output.url === "function") {
    const url = output.url();

    if (!url) {
      throw new Error("MAMAKI received an empty video URL.");
    }

    return downloadUrl(url);
  }

  if (typeof output.url === "string") {
    return downloadUrl(output.url);
  }

  throw new Error("MAMAKI did not receive a video file.");
}

/*
=========================================================
FFMPEG
=========================================================
*/

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("FFmpeg is not available."));
      return;
    }

    const child = spawn(ffmpegPath, args);

    let stderr = "";

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `FFmpeg failed: ${stderr.slice(-10000)}`
          )
        );
      }
    });
  });
}

/*
=========================================================
WATERMARK
=========================================================
*/

async function addWatermark(input, output) {
  await runFFmpeg([
    "-y",
    "-i",
    input,

    "-vf",
    "drawtext=text='MAMAKI':fontcolor=white:fontsize=28:borderw=2:bordercolor=black@0.7:x=w-tw-25:y=h-th-25",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-crf",
    "23",

    "-c:a",
    "aac",

    "-movflags",
    "+faststart",

    output
  ]);

  return output;
}

/*
=========================================================
WAN TEXT TO VIDEO
=========================================================
*/

async function generateTextVideo(prompt, ratio) {
  if (!replicate) {
    throw new Error("REPLICATE_API_TOKEN is missing.");
  }

  const input = {
    prompt: String(prompt).trim(),
    go_fast: true,
    num_frames: 81,
    resolution: "480p",
    aspect_ratio: normalizeRatio(ratio),
    sample_shift: 12,
    frames_per_second: 16,
    interpolate_output: false,
    lora_scale_transformer: 1,
    lora_scale_transformer_2: 1
  };

  console.log(
    "MAMAKI T2V:",
    JSON.stringify(input)
  );

  const output = await replicate.run(
    T2V_MODEL,
    { input }
  );

  return replicateOutputToBuffer(output);
}

/*
=========================================================
WAN IMAGE TO VIDEO
=========================================================
*/

async function generateImageVideo(prompt, image, ratio) {
  if (!replicate) {
    throw new Error("REPLICATE_API_TOKEN is missing.");
  }

  if (!image) {
    throw new Error("Reference image is required.");
  }

  const input = {
    image: image.buffer,
    prompt: String(prompt).trim(),
    go_fast: true,
    num_frames: 81,
    resolution: "480p",
    aspect_ratio: normalizeRatio(ratio),
    sample_shift: 12,
    frames_per_second: 16,
    interpolate_output: false,
    lora_scale_transformer: 1,
    lora_scale_transformer_2: 1
  };

  console.log(
    "MAMAKI I2V:",
    image.originalname,
    image.mimetype,
    image.size
  );

  const output = await replicate.run(
    I2V_MODEL,
    { input }
  );

  return replicateOutputToBuffer(output);
}

/*
=========================================================
JOB SYSTEM
=========================================================
*/

const jobs = new Map();

function createJob() {
  const id = randomUUID();

  jobs.set(id, {
    id,
    status: "queued",
    progress: 0,
    message: "Waiting for MAMAKI AI...",
    videoUrl: null,
    error: null,
    createdAt: Date.now()
  });

  return id;
}

function updateJob(id, data) {
  const job = jobs.get(id);

  if (!job) return;

  Object.assign(job, data);
}

function cleanupOldJobs() {
  const now = Date.now();

  for (const [id, job] of jobs) {
    if (now - job.createdAt > 60 * 60 * 1000) {
      jobs.delete(id);
    }
  }
}

setInterval(cleanupOldJobs, 10 * 60 * 1000);

/*
=========================================================
MAIN GENERATION WORKER
=========================================================
*/

async function processGeneration(jobId, data) {
  const jobDir = path.join(TMP, jobId);

  try {
    await fs.mkdir(jobDir, { recursive: true });

    updateJob(jobId, {
      status: "generating",
      progress: 5,
      message: "MAMAKI is preparing your video..."
    });

    const {
      prompt,
      ratio,
      duration,
      image
    } = data;

    /*
     * IMPORTANT:
     *
     * We intentionally generate one high-quality
     * short Wan clip per job.
     *
     * This prevents Render's HTTP request timeout.
     *
     * The frontend still accepts 5–60 seconds,
     * while the backend safely handles the AI
     * prediction asynchronously.
     */

    updateJob(jobId, {
      progress: 15,
      message: image
        ? "MAMAKI is animating your reference image..."
        : "MAMAKI is creating your scene..."
    });

    let videoBuffer;

    if (image) {
      videoBuffer = await generateImageVideo(
        prompt,
        image,
        ratio
      );
    } else {
      videoBuffer = await generateTextVideo(
        prompt,
        ratio
      );
    }

    if (!videoBuffer?.length) {
      throw new Error(
        "MAMAKI did not receive a video file."
      );
    }

    updateJob(jobId, {
      progress: 75,
      message: "MAMAKI received the AI video. Finalizing..."
    });

    const raw = path.join(
      jobDir,
      "raw.mp4"
    );

    await fs.writeFile(
      raw,
      videoBuffer
    );

    const finalName =
      `mamaki-ai-${Date.now()}-${randomUUID()}.mp4`;

    const final =
      path.join(
        OUTPUT,
        finalName
      );

    try {
      await addWatermark(
        raw,
        final
      );
    } catch (watermarkError) {
      console.error(
        "Watermark failed:",
        watermarkError.message
      );

      await fs.copyFile(
        raw,
        final
      );
    }

    const stats = await fs.stat(final);

    if (!stats.size) {
      throw new Error(
        "MAMAKI created an empty video."
      );
    }

    updateJob(jobId, {
      status: "completed",
      progress: 100,
      message: "Your MAMAKI video is ready.",
      videoUrl:
        `/api/video/${encodeURIComponent(finalName)}`,
      duration,
      model: image
        ? I2V_MODEL
        : T2V_MODEL
    });

  } catch (error) {
    console.error(
      "MAMAKI GENERATION ERROR:",
      error?.stack || error
    );

    updateJob(jobId, {
      status: "failed",
      progress: 100,
      message: "Video generation failed.",
      error:
        error?.message ||
        "Video generation failed."
    });

  } finally {
    await fs.rm(
      jobDir,
      {
        recursive: true,
        force: true
      }
    ).catch(() => {});
  }
}

/*
=========================================================
START GENERATION
=========================================================
*/

app.post(
  "/api/generate",

  upload.fields([
    {
      name: "referenceImage",
      maxCount: 1
    }
  ]),

  async (req, res) => {
    try {
      if (!replicate) {
        return res.status(500).json({
          ok: false,
          error: "REPLICATE_API_TOKEN is missing."
        });
      }

      const prompt =
        String(req.body.prompt || "").trim();

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error: "Enter a video prompt."
        });
      }

      const duration =
        normalizeDuration(req.body.duration);

      const ratio =
        normalizeRatio(
          req.body.ratio ||
          req.body.aspectRatio
        );

      const image =
        req.files?.referenceImage?.[0] || null;

      if (image && !isImage(image)) {
        return res.status(400).json({
          ok: false,
          error:
            "Reference image must be JPG, PNG or WebP."
        });
      }

      const jobId = createJob();

      /*
       * Return immediately.
       *
       * This is the important 504 fix.
       */

      res.status(202).json({
        ok: true,
        accepted: true,
        jobId,
        message:
          "MAMAKI generation started."
      });

      processGeneration(
        jobId,
        {
          prompt,
          ratio,
          duration,
          image
        }
      ).catch(error => {
        console.error(
          "BACKGROUND GENERATION ERROR:",
          error
        );
      });

    } catch (error) {
      console.error(
        "GENERATE REQUEST ERROR:",
        error
      );

      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error:
            error?.message ||
            "Video generation failed."
        });
      }
    }
  }
);

/*
=========================================================
JOB STATUS
=========================================================
*/

app.get(
  "/api/generate/status/:jobId",
  (req, res) => {
    const job =
      jobs.get(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        ok: false,
        error: "Generation job not found."
      });
    }

    return res.json({
      ok: true,
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      message: job.message,
      videoUrl: job.videoUrl,
      error: job.error
    });
  }
);

/*
=========================================================
SAVE PROJECT
=========================================================
*/

app.post(
  "/api/projects/save",
  async (req, res) => {
    try {
      const project = req.body || {};

      const id =
        project.id ||
        randomUUID();

      await fs.writeFile(
        path.join(
          PROJECTS,
          `${id}.json`
        ),
        JSON.stringify(
          {
            ...project,
            id,
            updatedAt:
              new Date().toISOString()
          },
          null,
          2
        ),
        "utf8"
      );

      res.json({
        ok: true,
        projectId: id
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

/*
=========================================================
PHOTO → VIDEO
=========================================================
*/

async function combineVideos(files, output) {
  const list =
    path.join(
      TMP,
      `concat-${randomUUID()}.txt`
    );

  await fs.writeFile(
    list,
    files
      .map(
        file =>
          `file '${file.replace(
            /'/g,
            "'\\''"
          )}'`
      )
      .join("\n"),
    "utf8"
  );

  try {
    await runFFmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      output
    ]);

    return output;
  } finally {
    await fs.rm(
      list,
      { force: true }
    ).catch(() => {});
  }
}

async function createPhotoVideo(
  images,
  seconds,
  output,
  ratio
) {
  if (!images.length) {
    throw new Error("Add at least one photo.");
  }

  const job =
    path.join(
      TMP,
      `photos-${randomUUID()}`
    );

  await fs.mkdir(
    job,
    { recursive: true }
  );

  const clips = [];

  try {
    let size = "1280:720";

    if (normalizeRatio(ratio) === "9:16") {
      size = "720:1280";
    }

    if (normalizeRatio(ratio) === "1:1") {
      size = "1080:1080";
    }

    for (let i = 0; i < images.length; i++) {
      const image = images[i];

      if (!isImage(image)) {
        throw new Error(
          "All photos must be JPG, PNG or WebP."
        );
      }

      const imageFile =
        path.join(
          job,
          `image-${i}`
        );

      const clipFile =
        path.join(
          job,
          `clip-${i}.mp4`
        );

      await fs.writeFile(
        imageFile,
        image.buffer
      );

      await runFFmpeg([
        "-y",
        "-loop",
        "1",
        "-i",
        imageFile,
        "-t",
        String(
          clamp(
            safeNumber(seconds, 3),
            1,
            60
          )
        ),
        "-vf",
        `scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-an",
        clipFile
      ]);

      clips.push(clipFile);
    }

    return combineVideos(
      clips,
      output
    );

  } finally {
    await fs.rm(
      job,
      {
        recursive: true,
        force: true
      }
    ).catch(() => {});
  }
}

app.post(
  "/api/studio/photo-video",
  upload.array("images", 50),
  async (req, res) => {
    const job =
      randomUUID();

    const dir =
      path.join(
        TMP,
        job
      );

    await fs.mkdir(
      dir,
      { recursive: true }
    );

    try {
      const images =
        req.files || [];

      const raw =
        path.join(
          dir,
          "raw.mp4"
        );

      const finalName =
        `mamaki-photo-${Date.now()}-${randomUUID()}.mp4`;

      const final =
        path.join(
          OUTPUT,
          finalName
        );

      await createPhotoVideo(
        images,
        req.body.duration,
        raw,
        req.body.ratio
      );

      try {
        await addWatermark(
          raw,
          final
        );
      } catch {
        await fs.copyFile(
          raw,
          final
        );
      }

      res.json({
        ok: true,
        success: true,
        videoUrl:
          `/api/video/${encodeURIComponent(finalName)}`,
        watermark: "MAMAKI",
        aiCredits: 0
      });

    } catch (error) {
      console.error(
        "PHOTO VIDEO ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error: error.message
      });

    } finally {
      await fs.rm(
        dir,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});
    }
  }
);

/*
=========================================================
TRIM
=========================================================
*/

async function trimVideo(
  input,
  output,
  start,
  end
) {
  const startTime =
    Math.max(
      0,
      safeNumber(start, 0)
    );

  const endTime =
    safeNumber(end, NaN);

  const args = [
    "-y",
    "-ss",
    String(startTime),
    "-i",
    input
  ];

  if (
    Number.isFinite(endTime) &&
    endTime > startTime
  ) {
    args.push(
      "-t",
      String(
        endTime - startTime
      )
    );
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    output
  );

  await runFFmpeg(args);
}

app.post(
  "/api/studio/trim",
  upload.fields([
    {
      name: "video",
      maxCount: 1
    },
    {
      name: "music",
      maxCount: 1
    }
  ]),
  async (req, res) => {
    const job =
      randomUUID();

    const dir =
      path.join(
        TMP,
        job
      );

    await fs.mkdir(
      dir,
      { recursive: true }
    );

    try {
      const video =
        req.files?.video?.[0];

      if (!isVideo(video)) {
        throw new Error(
          "Upload a valid video."
        );
      }

      const input =
        path.join(
          dir,
          "input.mp4"
        );

      const trimmed =
        path.join(
          dir,
          "trimmed.mp4"
        );

      const finalName =
        `mamaki-trim-${Date.now()}-${randomUUID()}.mp4`;

      const final =
        path.join(
          OUTPUT,
          finalName
        );

      await fs.writeFile(
        input,
        video.buffer
      );

      await trimVideo(
        input,
        trimmed,
        req.body.start,
        req.body.end
      );

      await fs.copyFile(
        trimmed,
        final
      );

      res.json({
        ok: true,
        success: true,
        videoUrl:
          `/api/video/${encodeURIComponent(finalName)}`,
        watermark: "MAMAKI",
        aiCredits: 0
      });

    } catch (error) {
      console.error(
        "TRIM ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error: error.message
      });

    } finally {
      await fs.rm(
        dir,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});
    }
  }
);

/*
=========================================================
COMBINE
=========================================================
*/

app.post(
  "/api/studio/combine",
  upload.array("videos", 50),
  async (req, res) => {
    const job =
      randomUUID();

    const dir =
      path.join(
        TMP,
        job
      );

    await fs.mkdir(
      dir,
      { recursive: true }
    );

    try {
      const videos =
        req.files || [];

      if (!videos.length) {
        throw new Error(
          "Upload videos to combine."
        );
      }

      const inputs = [];

      for (
        let i = 0;
        i < videos.length;
        i++
      ) {
        if (!isVideo(videos[i])) {
          throw new Error(
            "All files must be videos."
          );
        }

        const file =
          path.join(
            dir,
            `clip-${i}.mp4`
          );

        await fs.writeFile(
          file,
          videos[i].buffer
        );

        inputs.push(file);
      }

      const combined =
        path.join(
          dir,
          "combined.mp4"
        );

      const finalName =
        `mamaki-combined-${Date.now()}-${randomUUID()}.mp4`;

      const final =
        path.join(
          OUTPUT,
          finalName
        );

      await combineVideos(
        inputs,
        combined
      );

      try {
        await addWatermark(
          combined,
          final
        );
      } catch {
        await fs.copyFile(
          combined,
          final
        );
      }

      res.json({
        ok: true,
        success: true,
        videoUrl:
          `/api/video/${encodeURIComponent(finalName)}`,
        watermark: "MAMAKI",
        aiCredits: 0
      });

    } catch (error) {
      console.error(
        "COMBINE ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error: error.message
      });

    } finally {
      await fs.rm(
        dir,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});
    }
  }
);

/*
=========================================================
VIDEO DELIVERY
=========================================================
*/

app.get(
  "/api/video/:file",
  async (req, res) => {
    const filename =
      path.basename(
        req.params.file
      );

    const file =
      path.join(
        OUTPUT,
        filename
      );

    try {
      const stats =
        await fs.stat(file);

      if (!stats.size) {
        throw new Error();
      }

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Length",
        String(stats.size)
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${filename}"`
      );

      return res.sendFile(file);

    } catch {
      return res.status(404).json({
        ok: false,
        error: "Video not found."
      });
    }
  }
);

/*
=========================================================
STATUS
=========================================================
*/

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      ok: true,
      app: "MAMAKI AI VIDEO",
      version: "10.0.0",
      server: "online",
      replicate: Boolean(REPLICATE_API_TOKEN),
      ffmpeg: Boolean(ffmpegPath),
      textToVideo: T2V_MODEL,
      imageToVideo: I2V_MODEL,
      aiModel: "Wan 2.2 Fast",
      asynchronousGeneration: true,
      freeStudio: true,
      photoVideo: true,
      trimmer: true,
      combine: true,
      watermark: "MAMAKI"
    });
  }
);

/*
=========================================================
HEALTH
=========================================================
*/

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",
      app: "MAMAKI AI VIDEO",
      version: "10.0.0",
      replicate: Boolean(REPLICATE_API_TOKEN),
      ffmpeg: Boolean(ffmpegPath)
    });
  }
);

/*
=========================================================
ERROR HANDLER
=========================================================
*/

app.use(
  (error, req, res, next) => {
    console.error(
      "MAMAKI SERVER ERROR:",
      error
    );

    if (
      error?.code === "LIMIT_FILE_SIZE"
    ) {
      return res.status(413).json({
        ok: false,
        error:
          "Uploaded file is too large."
      });
    }

    return res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Server error."
    });
  }
);

/*
=========================================================
START
=========================================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "======================================"
    );

    console.log(
      "MAMAKI AI VIDEO v10.0.0"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `REPLICATE: ${
        REPLICATE_API_TOKEN
          ? "FOUND"
          : "MISSING"
      }`
    );

    console.log(
      `FFMPEG: ${
        ffmpegPath
          ? "FOUND"
          : "MISSING"
      }`
    );

    console.log(
      "ASYNC GENERATION: ENABLED"
    );

    console.log(
      "FREE STUDIO: ENABLED"
    );

    console.log(
      "PHOTO VIDEO: ENABLED"
    );

    console.log(
      "TRIMMER: ENABLED"
    );

    console.log(
      "COMBINE: ENABLED"
    );

    console.log(
      "======================================"
    );
  }
);
