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

const INDEX = path.join(ROOT, "index.html");
const TMP = path.join(ROOT, "tmp");
const OUTPUT = path.join(ROOT, "outputs");
const PROJECTS = path.join(ROOT, "projects");

const REPLICATE_API_TOKEN =
  String(process.env.REPLICATE_API_TOKEN || "").trim();

const replicate = REPLICATE_API_TOKEN
  ? new Replicate({ auth: REPLICATE_API_TOKEN })
  : null;

const T2V_MODEL = "wan-video/wan-2.2-t2v-fast";
const I2V_MODEL = "wan-video/wan-2.2-i2v-fast";

await fs.mkdir(TMP, { recursive: true });
await fs.mkdir(OUTPUT, { recursive: true });
await fs.mkdir(PROJECTS, { recursive: true });

app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "100mb"
}));

/* =====================================================
   FRONTEND
===================================================== */

app.get("/", async (req, res) => {
  try {
    await fs.access(INDEX);
    return res.sendFile(INDEX);
  } catch {
    return res.status(404).send(
      "MAMAKI index.html is missing."
    );
  }
});

app.use(express.static(ROOT, {
  index: false
}));

/* =====================================================
   UPLOAD
===================================================== */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 50
  }
});

/* =====================================================
   HELPERS
===================================================== */

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function ratio(value) {
  if (value === "9:16") return "9:16";
  if (value === "1:1") return "1:1";
  return "16:9";
}

function duration(value) {
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

/* =====================================================
   FFMPEG
===================================================== */

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

/* =====================================================
   REPLICATE OUTPUT
===================================================== */

async function outputToBuffer(output) {
  if (!output) {
    throw new Error(
      "MAMAKI did not receive a video file."
    );
  }

  if (
    Buffer.isBuffer(output) ||
    output instanceof Uint8Array
  ) {
    return Buffer.from(output);
  }

  if (Array.isArray(output)) {
    if (!output.length) {
      throw new Error(
        "MAMAKI did not receive a video file."
      );
    }

    return outputToBuffer(output[0]);
  }

  let url = null;

  if (typeof output === "string") {
    url = output;
  }

  if (
    !url &&
    typeof output.url === "function"
  ) {
    url = output.url();
  }

  if (
    !url &&
    typeof output.url === "string"
  ) {
    url = output.url;
  }

  if (!url) {
    throw new Error(
      "MAMAKI received an invalid video response from Replicate."
    );
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Video download failed: HTTP ${response.status}`
    );
  }

  return Buffer.from(
    await response.arrayBuffer()
  );
}

/* =====================================================
   REPLICATE IMAGE UPLOAD
===================================================== */

async function imageToDataURL(file) {
  return (
    `data:${file.mimetype};base64,` +
    file.buffer.toString("base64")
  );
}

/* =====================================================
   AI TEXT TO VIDEO
===================================================== */

async function generateT2V(prompt, aspectRatio) {
  if (!replicate) {
    throw new Error(
      "REPLICATE_API_TOKEN is missing."
    );
  }

  const input = {
    prompt: String(prompt).trim(),
    go_fast: true,
    num_frames: 81,
    resolution: "480p",
    aspect_ratio: ratio(aspectRatio),
    sample_shift: 12,
    frames_per_second: 16
  };

  console.log(
    "MAMAKI T2V:",
    JSON.stringify(input)
  );

  const output = await replicate.run(
    T2V_MODEL,
    { input }
  );

  return outputToBuffer(output);
}

/* =====================================================
   AI IMAGE TO VIDEO
===================================================== */

async function generateI2V(
  prompt,
  aspectRatio,
  image
) {
  if (!replicate) {
    throw new Error(
      "REPLICATE_API_TOKEN is missing."
    );
  }

  if (!image || !isImage(image)) {
    throw new Error(
      "A valid JPG, PNG or WebP reference image is required."
    );
  }

  const imageURL =
    await imageToDataURL(image);

  const input = {
    image: imageURL,
    prompt: String(prompt).trim(),
    go_fast: true,
    num_frames: 81,
    resolution: "480p",
    sample_shift: 12,
    frames_per_second: 16
  };

  console.log(
    "MAMAKI I2V:",
    {
      prompt: input.prompt,
      filename: image.originalname,
      size: image.size
    }
  );

  const output = await replicate.run(
    I2V_MODEL,
    { input }
  );

  return outputToBuffer(output);
}

/* =====================================================
   WATERMARK
===================================================== */

async function addWatermark(input, output) {
  await runFFmpeg([
    "-y",
    "-i",
    input,

    "-vf",
    "drawtext=text='MAMAKI':fontcolor=white:fontsize=30:borderw=2:bordercolor=black@0.75:x=w-tw-25:y=h-th-25",

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

/* =====================================================
   EXTEND CLIP LOCALLY
===================================================== */

async function extendVideo(
  input,
  output,
  seconds
) {
  const extra = Math.max(
    0,
    Number(seconds) || 0
  );

  if (extra <= 0) {
    await fs.copyFile(input, output);
    return output;
  }

  /*
   * Loop the generated clip.
   *
   * This is intentionally local so a 30/60-second
   * request does not create multiple Replicate jobs.
   */

  await runFFmpeg([
    "-y",

    "-stream_loop",
    "-1",

    "-i",
    input,

    "-t",
    String(extra),

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

/* =====================================================
   GENERATE API
===================================================== */

app.post(
  "/api/generate",

  upload.fields([
    {
      name: "referenceImage",
      maxCount: 1
    }
  ]),

  async (req, res) => {
    const job = randomUUID();
    const dir = path.join(TMP, job);

    try {
      if (!replicate) {
        throw new Error(
          "REPLICATE_API_TOKEN is missing. Add it in Render Environment Variables."
        );
      }

      const prompt =
        String(req.body.prompt || "").trim();

      if (!prompt) {
        throw new Error(
          "Please enter a video prompt."
        );
      }

      const requestedDuration =
        duration(req.body.duration);

      const aspectRatio =
        ratio(
          req.body.ratio ||
          req.body.aspectRatio
        );

      const image =
        req.files?.referenceImage?.[0] ||
        null;

      await fs.mkdir(dir, {
        recursive: true
      });

      console.log(
        "===================================="
      );

      console.log(
        "MAMAKI GENERATION START"
      );

      console.log(
        "Duration:",
        requestedDuration
      );

      console.log(
        "Ratio:",
        aspectRatio
      );

      console.log(
        "Mode:",
        image
          ? "IMAGE TO VIDEO"
          : "TEXT TO VIDEO"
      );

      /*
       * Generate ONE AI clip.
       * This avoids Render waiting for multiple
       * Replicate predictions.
       */

      let videoBuffer;

      if (image) {
        videoBuffer =
          await generateI2V(
            prompt,
            aspectRatio,
            image
          );
      } else {
        videoBuffer =
          await generateT2V(
            prompt,
            aspectRatio
          );
      }

      if (
        !videoBuffer ||
        !videoBuffer.length
      ) {
        throw new Error(
          "MAMAKI did not receive a video file."
        );
      }

      const aiClip =
        path.join(
          dir,
          "ai-clip.mp4"
        );

      await fs.writeFile(
        aiClip,
        videoBuffer
      );

      /*
       * WAN Fast normally produces the short
       * base clip. For longer user-selected
       * durations we extend locally.
       */

      const prepared =
        path.join(
          dir,
          "prepared.mp4"
        );

      if (requestedDuration <= 5) {
        await fs.copyFile(
          aiClip,
          prepared
        );
      } else {
        await extendVideo(
          aiClip,
          prepared,
          requestedDuration
        );
      }

      const finalName =
        `mamaki-${Date.now()}-${randomUUID()}.mp4`;

      const final =
        path.join(
          OUTPUT,
          finalName
        );

      try {
        await addWatermark(
          prepared,
          final
        );
      } catch (watermarkError) {
        console.error(
          "WATERMARK ERROR:",
          watermarkError.message
        );

        await fs.copyFile(
          prepared,
          final
        );
      }

      const stats =
        await fs.stat(final);

      if (!stats.size) {
        throw new Error(
          "MAMAKI created an empty video file."
        );
      }

      console.log(
        "MAMAKI GENERATION COMPLETE"
      );

      console.log(
        "File:",
        finalName
      );

      console.log(
        "===================================="
      );

      return res.json({
        ok: true,
        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        file: finalName,

        requestedDuration,

        aspectRatio,

        mode:
          image
            ? "image-to-video"
            : "text-to-video",

        model:
          image
            ? I2V_MODEL
            : T2V_MODEL,

        watermark: "MAMAKI",

        message:
          "MAMAKI AI video generated successfully."
      });

    } catch (error) {
      console.error(
        "===================================="
      );

      console.error(
        "MAMAKI GENERATION ERROR"
      );

      console.error(
        error?.stack ||
        error?.message ||
        error
      );

      console.error(
        "===================================="
      );

      return res.status(500).json({
        ok: false,
        success: false,
        error:
          error?.message ||
          "Video generation failed."
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

/* =====================================================
   PHOTO → VIDEO
===================================================== */

async function createPhotoVideo(
  images,
  seconds,
  output,
  aspectRatio
) {
  if (!images.length) {
    throw new Error(
      "Add at least one photo."
    );
  }

  const job =
    path.join(
      TMP,
      `photo-${randomUUID()}`
    );

  await fs.mkdir(job, {
    recursive: true
  });

  const clips = [];

  try {
    let size = "1280:720";

    if (ratio(aspectRatio) === "9:16") {
      size = "720:1280";
    }

    if (ratio(aspectRatio) === "1:1") {
      size = "1080:1080";
    }

    const each =
      clamp(
        safeNumber(seconds, 3),
        1,
        60
      );

    for (
      let i = 0;
      i < images.length;
      i++
    ) {
      const image =
        images[i];

      if (!isImage(image)) {
        throw new Error(
          "Photos must be JPG, PNG or WebP."
        );
      }

      const input =
        path.join(
          job,
          `image-${i}`
        );

      const clip =
        path.join(
          job,
          `clip-${i}.mp4`
        );

      await fs.writeFile(
        input,
        image.buffer
      );

      await runFFmpeg([
        "-y",

        "-loop",
        "1",

        "-i",
        input,

        "-t",
        String(each),

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

        clip
      ]);

      clips.push(clip);
    }

    const list =
      path.join(
        job,
        "list.txt"
      );

    await fs.writeFile(
      list,
      clips
        .map(
          f =>
            `file '${f.replace(/'/g, "'\\''")}'`
        )
        .join("\n")
    );

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

      "-pix_fmt",
      "yuv420p",

      output
    ]);

    return output;

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

  upload.array(
    "images",
    50
  ),

  async (req, res) => {
    const dir =
      path.join(
        TMP,
        randomUUID()
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
          "photo.mp4"
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
          `/api/video/${encodeURIComponent(
            finalName
          )}`,
        watermark: "MAMAKI"
      });

    } catch (error) {
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

/* =====================================================
   VIDEO TRIMMER
===================================================== */

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
    const dir =
      path.join(
        TMP,
        randomUUID()
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

      const output =
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

      const start =
        Math.max(
          0,
          safeNumber(
            req.body.start,
            0
          )
        );

      const end =
        safeNumber(
          req.body.end,
          NaN
        );

      const args = [
        "-y",
        "-ss",
        String(start),
        "-i",
        input
      ];

      if (
        Number.isFinite(end) &&
        end > start
      ) {
        args.push(
          "-t",
          String(end - start)
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

      try {
        await addWatermark(
          output,
          final
        );
      } catch {
        await fs.copyFile(
          output,
          final
        );
      }

      res.json({
        ok: true,
        success: true,
        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,
        watermark: "MAMAKI"
      });

    } catch (error) {
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

/* =====================================================
   COMBINE VIDEOS
===================================================== */

app.post(
  "/api/studio/combine",

  upload.array(
    "videos",
    50
  ),

  async (req, res) => {
    const dir =
      path.join(
        TMP,
        randomUUID()
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

      const list = [];

      for (
        let i = 0;
        i < videos.length;
        i++
      ) {
        if (!isVideo(videos[i])) {
          throw new Error(
            "All uploaded files must be videos."
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

        list.push(file);
      }

      const concat =
        path.join(
          dir,
          "list.txt"
        );

      await fs.writeFile(
        concat,
        list
          .map(
            f =>
              `file '${f.replace(/'/g, "'\\''")}'`
          )
          .join("\n")
      );

      const combined =
        path.join(
          dir,
          "combined.mp4"
        );

      await runFFmpeg([
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concat,
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
        combined
      ]);

      const finalName =
        `mamaki-combined-${Date.now()}-${randomUUID()}.mp4`;

      const final =
        path.join(
          OUTPUT,
          finalName
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
          `/api/video/${encodeURIComponent(
            finalName
          )}`,
        watermark: "MAMAKI"
      });

    } catch (error) {
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

/* =====================================================
   PROJECTS
===================================================== */

app.post(
  "/api/projects/save",
  async (req, res) => {
    try {
      const project =
        req.body || {};

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
        )
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

/* =====================================================
   VIDEO DELIVERY
===================================================== */

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
        throw new Error(
          "Empty file."
        );
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

/* =====================================================
   STATUS
===================================================== */

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      ok: true,
      app: "MAMAKI AI VIDEO",
      version: "10.0.0",
      server: "online",
      replicate:
        Boolean(REPLICATE_API_TOKEN),
      ffmpeg:
        Boolean(ffmpegPath),
      textToVideo: T2V_MODEL,
      imageToVideo: I2V_MODEL,
      freeStudio: true,
      photoVideo: true,
      trimmer: true,
      combine: true,
      watermark: "MAMAKI"
    });
  }
);

/* =====================================================
   HEALTH
===================================================== */

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",
      app: "MAMAKI AI VIDEO",
      version: "10.0.0",
      replicate:
        Boolean(REPLICATE_API_TOKEN),
      ffmpeg:
        Boolean(ffmpegPath)
    });
  }
);

/* =====================================================
   404 JSON API
===================================================== */

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      ok: false,
      error: "API endpoint not found."
    });
  }
);

/* =====================================================
   SERVER ERROR
===================================================== */

app.use(
  (error, req, res, next) => {
    console.error(
      "MAMAKI SERVER ERROR:",
      error
    );

    if (
      error?.code ===
      "LIMIT_FILE_SIZE"
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

/* =====================================================
   START
===================================================== */

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
          ? "CONNECTED"
          : "MISSING"
      }`
    );

    console.log(
      `FFMPEG: ${
        ffmpegPath
          ? "AVAILABLE"
          : "MISSING"
      }`
    );

    console.log(
      `T2V: ${T2V_MODEL}`
    );

    console.log(
      `I2V: ${I2V_MODEL}`
    );

    console.log(
      "FREE STUDIO: ENABLED"
    );

    console.log(
      "======================================"
    );
  }
);
