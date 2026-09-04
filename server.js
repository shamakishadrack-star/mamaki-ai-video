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

const TOKEN = String(process.env.REPLICATE_API_TOKEN || "").trim();
const replicate = TOKEN ? new Replicate({ auth: TOKEN }) : null;

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

const jobs = new Map();

function createJob(data = {}) {
  const id = randomUUID();

  const job = {
    id,
    status: "queued",
    progress: 0,
    stage: "Preparing",
    message: "MAMAKI is preparing your production.",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...data
  };

  jobs.set(id, job);
  return job;
}

function updateJob(id, changes = {}) {
  const job = jobs.get(id);
  if (!job) return null;

  Object.assign(job, changes, {
    updatedAt: new Date().toISOString()
  });

  return job;
}

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
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();

    if (/^\d+(\.\d+)?s$/.test(text))
      return clamp(Math.round(parseFloat(text)), 5, 7200);

    if (/^\d+(\.\d+)?m$/.test(text))
      return clamp(Math.round(parseFloat(text) * 60), 5, 7200);

    if (/^\d+(\.\d+)?h$/.test(text))
      return clamp(Math.round(parseFloat(text) * 3600), 5, 7200);
  }

  return clamp(Math.round(safeNumber(value, 5)), 5, 7200);
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;

  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function isImage(file) {
  return !!file &&
    ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 50
  }
});

/* =========================
   REPLICATE OUTPUT
========================= */

async function downloadUrl(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Video download failed: HTTP ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function outputToBuffer(output) {
  if (!output) {
    throw new Error("MAMAKI did not receive a video file.");
  }

  if (Buffer.isBuffer(output) || output instanceof Uint8Array) {
    return Buffer.from(output);
  }

  if (typeof output.url === "function") {
    const url = output.url();
    if (!url) throw new Error("Replicate returned an empty video URL.");
    return downloadUrl(url);
  }

  if (typeof output.url === "string") {
    return downloadUrl(output.url);
  }

  if (typeof output === "string") {
    if (output.startsWith("http://") || output.startsWith("https://")) {
      return downloadUrl(output);
    }
  }

  if (Array.isArray(output)) {
    if (!output.length) {
      throw new Error("Replicate returned no video.");
    }

    return outputToBuffer(output[0]);
  }

  if (typeof output.arrayBuffer === "function") {
    return Buffer.from(await output.arrayBuffer());
  }

  throw new Error("MAMAKI received an unusable video file.");
}

/* =========================
   FFMPEG
========================= */

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("FFmpeg is not available."));
      return;
    }

    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

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
          new Error(`FFmpeg failed: ${stderr.slice(-10000)}`)
        );
      }
    });
  });
}

/* =========================
   AUDIO DETECTION
========================= */

async function hasAudio(input) {
  return new Promise(resolve => {
    if (!ffmpegPath) {
      resolve(false);
      return;
    }

    const child = spawn(ffmpegPath, [
      "-hide_banner",
      "-i",
      input,
      "-map",
      "0:a:0",
      "-f",
      "null",
      "-"
    ], {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", () => resolve(false));

    child.on("close", code => {
      resolve(
        code === 0 &&
        /Audio:/i.test(stderr)
      );
    });
  });
}

/* =========================
   PROFESSIONAL SOFT MUSIC
========================= */

async function createSoftMusic(output, duration) {
  const seconds = clamp(
    safeNumber(duration, 5) + 2,
    5,
    7205
  );

  /*
   Soft multi-tone ambient bed.
   This is intentionally quiet so narration/dialogue
   can remain understandable.
  */

  const filter = [
    "sine=frequency=261.63:duration=" + seconds,
    "volume=0.035",
    "afade=t=in:st=0:d=2",
    `afade=t=out:st=${Math.max(0, seconds - 3)}:d=3`
  ].join(",");

  await runFFmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    filter,
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-ac",
    "2",
    output
  ]);

  return output;
}

/*
 * IMPORTANT:
 * This function works whether the source video
 * already has audio OR has no audio at all.
 */
async function addSoftMusic(video, output, duration) {
  const music = path.join(
    TMP,
    `music-${randomUUID()}.m4a`
  );

  try {
    await createSoftMusic(music, duration);

    const sourceHasAudio = await hasAudio(video);

    if (sourceHasAudio) {
      await runFFmpeg([
        "-y",
        "-i",
        video,
        "-stream_loop",
        "-1",
        "-i",
        music,

        "-filter_complex",
        "[0:a]volume=1.0[voice];" +
        "[1:a]volume=0.18[music];" +
        "[voice][music]amix=inputs=2:duration=first:" +
        "dropout_transition=2[a]",

        "-map",
        "0:v:0",
        "-map",
        "[a]",

        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",

        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-shortest",
        "-movflags",
        "+faststart",
        output
      ]);
    } else {
      /*
       * WAN video has NO audio.
       * Therefore music becomes the audio stream.
       */
      await runFFmpeg([
        "-y",
        "-i",
        video,
        "-stream_loop",
        "-1",
        "-i",
        music,

        "-map",
        "0:v:0",
        "-map",
        "1:a:0",

        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",

        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-shortest",
        "-movflags",
        "+faststart",
        output
      ]);
    }

    return output;
  } finally {
    await fs.rm(music, { force: true }).catch(() => {});
  }
}

/* =========================
   WATERMARK
========================= */

async function findFont() {
  const fonts = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
  ];

  for (const font of fonts) {
    try {
      await fs.access(font);
      return font;
    } catch {}
  }

  return null;
}

async function addWatermark(input, output) {
  const font = await findFont();

  if (!font) {
    throw new Error(
      "MAMAKI watermark failed: compatible font not found."
    );
  }

  const text = "MAMAKI ✨";

  const escapedFont = font
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:");

  const escapedText = text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");

  await runFFmpeg([
    "-y",
    "-i",
    input,

    "-vf",
    `drawtext=fontfile='${escapedFont}':` +
    `text='${escapedText}':` +
    `fontcolor=white:` +
    `fontsize=30:` +
    `borderw=3:` +
    `bordercolor=black@0.75:` +
    `box=1:` +
    `boxcolor=black@0.28:` +
    `boxborderw=8:` +
    `x=w-tw-25:` +
    `y=h-th-25`,

    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",

    "-c:a",
    "aac",
    "-b:a",
    "128k",

    "-movflags",
    "+faststart",
    output
  ]);

  return output;
}

/* =========================
   EXACT DURATION
========================= */

async function forceDuration(input, output, seconds) {
  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-t",
    String(seconds),

    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",

    "-c:a",
    "aac",
    "-b:a",
    "128k",

    "-movflags",
    "+faststart",
    output
  ]);

  return output;
}

/* =========================
   WAN T2V
========================= */

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

  console.log("MAMAKI T2V:", input.prompt);

  const output = await replicate.run(
    T2V_MODEL,
    { input }
  );

  return outputToBuffer(output);
}

/* =========================
   WAN I2V
========================= */

async function generateImageVideo(prompt, image) {
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
    sample_shift: 12,
    frames_per_second: 16,
    interpolate_output: false,
    lora_scale_transformer: 1,
    lora_scale_transformer_2: 1
  };

  console.log("MAMAKI I2V:", input.prompt);

  const output = await replicate.run(
    I2V_MODEL,
    { input }
  );

  return outputToBuffer(output);
}

/* =========================
   SCENE PLANNER
========================= */

function splitScenes(prompt, duration) {
  const text = String(prompt || "").trim();

  if (!text) return [];

  const count = Math.max(
    1,
    Math.ceil(duration / 5)
  );

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(x => x.trim())
    .filter(Boolean);

  const cameras = [
    "wide establishing shot",
    "medium cinematic shot",
    "close-up detail shot",
    "slow tracking shot",
    "over-the-shoulder shot",
    "cinematic reveal",
    "environmental shot",
    "professional documentary shot"
  ];

  const scenes = [];

  for (let i = 0; i < count; i++) {
    const base =
      sentences.length
        ? sentences[i % sentences.length]
        : text;

    scenes.push(
      `${base}. ${cameras[i % cameras.length]}, ` +
      `cinematic professional filmmaking, realistic natural ` +
      `movement, coherent lighting, detailed environment, ` +
      `realistic subject appearance, smooth camera motion, ` +
      `high quality video, maintain visual continuity.`
    );
  }

  return scenes;
}

/* =========================
   CONCAT
========================= */

async function combineVideos(files, output) {
  if (!files.length) {
    throw new Error("No video clips supplied.");
  }

  if (files.length === 1) {
    await fs.copyFile(files[0], output);
    return output;
  }

  const list = path.join(
    TMP,
    `concat-${randomUUID()}.txt`
  );

  const content = files
    .map(file =>
      `file '${file.replace(/'/g, "'\\''")}'`
    )
    .join("\n");

  await fs.writeFile(list, content, "utf8");

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
      "-b:a",
      "128k",

      "-movflags",
      "+faststart",
      output
    ]);

    return output;
  } finally {
    await fs.rm(list, { force: true }).catch(() => {});
  }
}

/* =========================
   AUTOPILOT
========================= */

async function runAutopilot(jobId, options) {
  const {
    prompt,
    duration,
    ratio,
    image
  } = options;

  const jobDir = path.join(TMP, jobId);

  await fs.mkdir(jobDir, { recursive: true });

  try {
    const sceneCount = Math.ceil(duration / 5);

    updateJob(jobId, {
      status: "processing",
      progress: 1,
      stage: "AI Director",
      message: `Planning ${sceneCount} production scenes.`
    });

    const scenes = splitScenes(
      prompt,
      duration
    );

    const clips = [];

    for (let i = 0; i < sceneCount; i++) {
      const sceneNumber = i + 1;

      updateJob(jobId, {
        status: "processing",
        progress: Math.max(
          2,
          Math.min(
            85,
            Math.round((i / sceneCount) * 80)
          )
        ),
        stage: "Generating scenes",
        currentScene: sceneNumber,
        message:
          `Generating scene ${sceneNumber} of ${sceneCount}.`
      });

      const scenePrompt =
        scenes[i] ||
        `${prompt}. Cinematic continuation.`;

      let buffer;

      if (image && i === 0) {
        buffer = await generateImageVideo(
          scenePrompt,
          image
        );
      } else {
        buffer = await generateTextVideo(
          scenePrompt,
          ratio
        );
      }

      if (!buffer?.length) {
        throw new Error(
          `Scene ${sceneNumber} returned an empty video.`
        );
      }

      const clip = path.join(
        jobDir,
        `scene-${String(i).padStart(5, "0")}.mp4`
      );

      await fs.writeFile(
        clip,
        buffer
      );

      clips.push(clip);
    }

    updateJob(jobId, {
      progress: 87,
      stage: "Assembling",
      message: "Combining generated scenes."
    });

    const combined = path.join(
      jobDir,
      "combined.mp4"
    );

    await combineVideos(
      clips,
      combined
    );

    updateJob(jobId, {
      progress: 90,
      stage: "Matching duration",
      message:
        `Preparing ${formatDuration(duration)} output.`
    });

    const exact = path.join(
      jobDir,
      "exact.mp4"
    );

    await forceDuration(
      combined,
      exact,
      duration
    );

    updateJob(jobId, {
      progress: 93,
      stage: "Audio production",
      message:
        "Adding MAMAKI soft background music."
    });

    const audioVideo = path.join(
      jobDir,
      "audio.mp4"
    );

    /*
     * MUSIC IS NO LONGER OPTIONAL.
     * If source has audio → mix.
     * If source has no audio → attach music.
     */
    await addSoftMusic(
      exact,
      audioVideo,
      duration
    );

    updateJob(jobId, {
      progress: 96,
      stage: "Branding",
      message:
        "Applying MAMAKI ✨ watermark."
    });

    const finalName =
      `mamaki-ai-${Date.now()}-${randomUUID()}.mp4`;

    const final = path.join(
      OUTPUT,
      finalName
    );

    await addWatermark(
      audioVideo,
      final
    );

    const stats = await fs.stat(final);

    if (!stats.size) {
      throw new Error(
        "Final MAMAKI video is empty."
      );
    }

    const videoUrl =
      `/api/video/${encodeURIComponent(finalName)}`;

    const projectId = randomUUID();

    const project = {
      id: projectId,
      title: prompt.slice(0, 70),
      prompt,
      mode: image
        ? "Image to Video"
        : "Text to Video",
      duration,
      durationLabel: formatDuration(duration),
      ratio,
      videoUrl,
      file: finalName,
      createdAt: new Date().toISOString(),
      watermark: "MAMAKI ✨",
      watermarkActive: true,
      music: true,
      autopilot: true,
      sceneCount
    };

    await fs.writeFile(
      path.join(
        PROJECTS,
        `${projectId}.json`
      ),
      JSON.stringify(
        project,
        null,
        2
      ),
      "utf8"
    );

    updateJob(jobId, {
      progress: 100,
      status: "completed",
      stage: "Production complete",
      message:
        "MAMAKI production completed successfully.",
      videoUrl,
      file: finalName,
      projectId,
      watermarkActive: true,
      musicActive: true,
      model: image
        ? I2V_MODEL
        : T2V_MODEL
    });

  } catch (error) {
    console.error(
      "AUTOPILOT ERROR:",
      error?.stack || error?.message || error
    );

    updateJob(jobId, {
      status: "failed",
      progress: 0,
      stage: "Production failed",
      message:
        error?.message ||
        "MAMAKI production failed."
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

/* =========================
   GENERATE
========================= */

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
          error:
            "REPLICATE_API_TOKEN is missing."
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
        normalizeDuration(
          req.body.duration
        );

      const ratio =
        normalizeRatio(
          req.body.ratio ||
          req.body.aspectRatio
        );

      const image =
        req.files?.referenceImage?.[0] ||
        null;

      const job = createJob({
        prompt,
        duration,
        durationLabel:
          formatDuration(duration),
        ratio,
        mode: image
          ? "image-to-video"
          : "text-to-video"
      });

      setImmediate(() => {
        runAutopilot(
          job.id,
          {
            prompt,
            duration,
            ratio,
            image
          }
        ).catch(error => {
          console.error(
            "BACKGROUND ERROR:",
            error
          );

          updateJob(
            job.id,
            {
              status: "failed",
              message:
                error?.message ||
                "Background production failed."
            }
          );
        });
      });

      return res.status(202).json({
        ok: true,
        queued: true,
        jobId: job.id,
        status: "queued",
        statusUrl:
          `/api/jobs/${job.id}`,
        requestedDuration: duration,
        duration:
          formatDuration(duration),
        message:
          "MAMAKI production started."
      });

    } catch (error) {
      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Video generation failed."
      });
    }
  }
);

/* =========================
   JOB STATUS
========================= */

app.get(
  "/api/jobs/:id",
  (req, res) => {
    const job =
      jobs.get(req.params.id);

    if (!job) {
      return res.status(404).json({
        ok: false,
        error:
          "Production job not found."
      });
    }

    res.json({
      ok: true,
      ...job
    });
  }
);

/* =========================
   VIDEO
========================= */

app.get(
  "/api/video/:file",
  async (req, res) => {
    const filename =
      path.basename(req.params.file);

    const file =
      path.join(
        OUTPUT,
        filename
      );

    try {
      const stats =
        await fs.stat(file);

      if (!stats.size) {
        return res.status(404).json({
          ok: false,
          error:
            "Video file is empty."
        });
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
        error:
          "Video not found."
      });
    }
  }
);

/* =========================
   PROJECTS
========================= */

app.get(
  "/api/projects",
  async (req, res) => {
    try {
      const files =
        await fs.readdir(PROJECTS);

      const projects = [];

      for (const file of files) {
        if (!file.endsWith(".json"))
          continue;

        try {
          const data =
            await fs.readFile(
              path.join(
                PROJECTS,
                file
              ),
              "utf8"
            );

          projects.push(
            JSON.parse(data)
          );
        } catch {}
      }

      projects.sort(
        (a, b) =>
          new Date(
            b.createdAt || 0
          ) -
          new Date(
            a.createdAt || 0
          )
      );

      res.json({
        ok: true,
        projects
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

/* =========================
   SAVE PROJECT
========================= */

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

/* =========================
   PHOTO → VIDEO
========================= */

async function createPhotoVideo(
  images,
  seconds,
  output,
  ratio
) {
  if (!images.length) {
    throw new Error(
      "Add at least one photo."
    );
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

    if (normalizeRatio(ratio) === "9:16")
      size = "720:1280";

    if (normalizeRatio(ratio) === "1:1")
      size = "1080:1080";

    for (let i = 0; i < images.length; i++) {
      if (!isImage(images[i])) {
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
        images[i].buffer
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
            safeNumber(
              seconds,
              3
            ),
            1,
            60
          )
        ),

        "-vf",
        `scale=${size}:force_original_aspect_ratio=decrease,` +
        `pad=${size}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,

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

/* =========================
   PHOTO VIDEO + MUSIC
========================= */

app.post(
  "/api/studio/photo-video",
  upload.fields([
    {
      name: "images",
      maxCount: 50
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
      const images =
        req.files?.images || [];

      if (!images.length) {
        throw new Error(
          "Add at least one photo."
        );
      }

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

      let current = raw;

      const music =
        req.files?.music?.[0];

      /*
       * If user uploads music,
       * use it.
       */
      if (isAudio(music)) {
        const musicFile =
          path.join(
            dir,
            "music"
          );

        const mixed =
          path.join(
            dir,
            "mixed.mp4"
          );

        await fs.writeFile(
          musicFile,
          music.buffer
        );

        await mixMusic(
          current,
          musicFile,
          mixed,
          req.body.musicVolume || 0.3,
          req.body.originalVolume || 1
        );

        current = mixed;

      } else {
        /*
         * No music uploaded:
         * automatically add soft MAMAKI music.
         */
        const autoMusic =
          path.join(
            dir,
            "auto-music.mp4"
          );

        await addSoftMusic(
          current,
          autoMusic,
          Number(
            req.body.duration || 5
          )
        );

        current = autoMusic;
      }

      await addWatermark(
        current,
        final
      );

      res.json({
        ok: true,
        success: true,
        videoUrl:
          `/api/video/${encodeURIComponent(finalName)}`,
        watermark:
          "MAMAKI ✨",
        watermarkActive: true,
        musicActive: true,
        aiCredits: 0
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
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

/* =========================
   MIX MUSIC
========================= */

async function mixMusic(
  video,
  music,
  output,
  musicVolume = 0.25,
  originalVolume = 1
) {
  const mv =
    clamp(
      safeNumber(
        musicVolume,
        0.25
      ),
      0,
      2
    );

  const ov =
    clamp(
      safeNumber(
        originalVolume,
        1
      ),
      0,
      2
    );

  const sourceHasAudio =
    await hasAudio(video);

  if (!sourceHasAudio) {
    await runFFmpeg([
      "-y",
      "-i",
      video,
      "-stream_loop",
      "-1",
      "-i",
      music,

      "-map",
      "0:v:0",
      "-map",
      "1:a:0",

      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",

      "-c:a",
      "aac",
      "-b:a",
      "128k",

      "-shortest",
      "-movflags",
      "+faststart",
      output
    ]);

    return output;
  }

  await runFFmpeg([
    "-y",
    "-i",
    video,
    "-stream_loop",
    "-1",
    "-i",
    music,

    "-filter_complex",
    `[0:a]volume=${ov}[a0];` +
    `[1:a]volume=${mv}[a1];` +
    `[a0][a1]amix=inputs=2:duration=first:` +
    `dropout_transition=2[a]`,

    "-map",
    "0:v:0",
    "-map",
    "[a]",

    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",

    "-c:a",
    "aac",
    "-b:a",
    "128k",

    "-shortest",
    "-movflags",
    "+faststart",
    output
  ]);

  return output;
}

/* =========================
   TRIM
========================= */

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
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    output
  );

  await runFFmpeg(args);

  return output;
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

      let current =
        trimmed;

      const music =
        req.files?.music?.[0];

      if (isAudio(music)) {
        const musicFile =
          path.join(
            dir,
            "music"
          );

        const mixed =
          path.join(
            dir,
            "mixed.mp4"
          );

        await fs.writeFile(
          musicFile,
          music.buffer
        );

        await mixMusic(
          current,
          musicFile,
          mixed,
          req.body.musicVolume,
          req.body.originalVolume
        );

        current =
          mixed;
      }

      await addWatermark(
        current,
        final
      );

      res.json({
        ok: true,
        success: true,
        videoUrl:
          `/api/video/${encodeURIComponent(finalName)}`,
        watermark:
          "MAMAKI ✨",
        watermarkActive: true,
        aiCredits: 0
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
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

/* =========================
   COMBINE
========================= */

app.post(
  "/api/studio/combine",
  upload.array(
    "videos",
    50
  ),
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

      await addWatermark(
        combined,
        final
      );

      res.json({
        ok: true,
        success: true,
        videoUrl:
          `/api/video/${encodeURIComponent(finalName)}`,
        watermark:
          "MAMAKI ✨",
        watermarkActive: true,
        aiCredits: 0
      });

    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
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

/* =========================
   STATUS
========================= */

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      ok: true,
      app: "MAMAKI AI VIDEO",
      version: "12.0.0",
      server: "online",
      replicate: Boolean(TOKEN),
      ffmpeg: Boolean(ffmpegPath),

      textToVideo: T2V_MODEL,
      imageToVideo: I2V_MODEL,

      backgroundJobs: true,
      autopilot: true,

      minDurationSeconds: 5,
      maxDurationSeconds: 7200,
      maxDuration: "2 hours",

      music: true,
      automaticMusicForImageVideo: true,

      watermark: "MAMAKI ✨",
      watermarkRequired: true,

      photoVideo: true,
      photoVideoMusic: true,
      trimmer: true,
      combine: true,
      projects: true
    });
  }
);

/* =========================
   HEALTH
========================= */

app.get(
  "/health",
  (req, res) => {
    res.status(200).json({
      status: "ok",
      app: "MAMAKI AI VIDEO",
      version: "12.0.0",
      replicate: Boolean(TOKEN),
      ffmpeg: Boolean(ffmpegPath)
    });
  }
);

/* =========================
   ERROR HANDLER
========================= */

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

    res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Server error."
    });
  }
);

/* =========================
   ROOT
========================= */

app.get(
  "/",
  async (req, res) => {
    try {
      await fs.access(INDEX);
      res.sendFile(INDEX);
    } catch {
      res.status(404).send(
        "MAMAKI index.html is missing."
      );
    }
  }
);

app.use(
  express.static(ROOT, {
    index: false
  })
);

/* =========================
   START
========================= */

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        "======================================"
      );

      console.log(
        "MAMAKI AI VIDEO v12.0.0"
      );

      console.log(
        `PORT: ${PORT}`
      );

      console.log(
        `REPLICATE: ${TOKEN ? "FOUND" : "MISSING"}`
      );

      console.log(
        `FFMPEG: ${ffmpegPath ? "FOUND" : "MISSING"}`
      );

      console.log(
        "T2V: " + T2V_MODEL
      );

      console.log(
        "I2V: " + I2V_MODEL
      );

      console.log(
        "BACKGROUND JOBS: ENABLED"
      );

      console.log(
        "MUSIC: AUTOMATIC"
      );

      console.log(
        "WATERMARK: MAMAKI ✨"
      );

      console.log(
        "DURATION: 5 SECONDS → 2 HOURS"
      );

      console.log(
        "======================================"
      );
    }
  );

/*
 * Helps avoid intermittent connection problems
 * with Render's HTTP edge.
 */
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

process.on(
  "SIGTERM",
  () => {
    console.log(
      "SIGTERM received. Shutting down gracefully."
    );

    server.close(() => {
      process.exit(0);
    });

    setTimeout(
      () => process.exit(0),
      25000
    ).unref();
  }
);
