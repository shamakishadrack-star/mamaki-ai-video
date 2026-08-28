import express from "express";
import multer from "multer";
import Replicate from "replicate";
import { EdgeTTS } from "edge-tts-universal";
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
  ? new Replicate({
      auth: REPLICATE_API_TOKEN
    })
  : null;

/*
=========================================================
MAMAKI AI VIDEO
BACKEND v8
=========================================================

AI:
WAN 2.2 FAST T2V
WAN 2.2 FAST I2V

IMPORTANT:
AI generation now uses JOBS.

POST /api/generate
      ↓
returns jobId immediately
      ↓
background generation
      ↓
GET /api/generate/status/:jobId
      ↓
completed video

This prevents the browser from losing the
connection while Replicate is generating.

=========================================================
*/

const T2V_MODEL =
  "wan-video/wan-2.2-t2v-fast";

const I2V_MODEL =
  "wan-video/wan-2.2-i2v-fast";

const TMP =
  path.join(ROOT, "tmp");

const OUTPUT =
  path.join(ROOT, "outputs");

const PROJECTS =
  path.join(ROOT, "projects");

const JOBS =
  path.join(ROOT, "jobs");

const INDEX =
  path.join(ROOT, "index.html");

await fs.mkdir(TMP, {
  recursive: true
});

await fs.mkdir(OUTPUT, {
  recursive: true
});

await fs.mkdir(PROJECTS, {
  recursive: true
});

await fs.mkdir(JOBS, {
  recursive: true
});

app.use(
  express.json({
    limit: "100mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "100mb"
  })
);

/*
=========================================================
HOME
=========================================================
*/

app.get("/", async (req, res) => {
  try {
    await fs.access(INDEX);
    return res.sendFile(INDEX);
  } catch {
    return res
      .status(404)
      .send("MAMAKI index.html is missing.");
  }
});

app.use(
  express.static(ROOT, {
    index: false
  })
);

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

function safeNumber(
  value,
  fallback = 0
) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function clamp(
  value,
  min,
  max
) {
  return Math.min(
    max,
    Math.max(min, value)
  );
}

function normalizeDuration(value) {
  return Math.max(
    5,
    Math.round(
      safeNumber(value, 5)
    )
  );
}

function normalizeRatio(value) {
  if (value === "9:16") {
    return "9:16";
  }

  if (value === "1:1") {
    return "1:1";
  }

  return "16:9";
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
JOB SYSTEM
=========================================================
*/

const jobs = new Map();

function createJob(data = {}) {

  const id =
    randomUUID();

  const job = {
    id,

    status:
      "queued",

    progress:
      0,

    message:
      "Waiting for generation to start.",

    videoUrl:
      null,

    error:
      null,

    createdAt:
      new Date().toISOString(),

    updatedAt:
      new Date().toISOString(),

    ...data
  };

  jobs.set(
    id,
    job
  );

  return job;
}

function updateJob(
  id,
  updates
) {

  const job =
    jobs.get(id);

  if (!job) {
    return null;
  }

  Object.assign(
    job,
    updates,
    {
      updatedAt:
        new Date().toISOString()
    }
  );

  return job;
}

/*
Keep jobs in memory while the Render
instance is running.

Also save a small JSON copy so debugging
is easier.
*/

async function saveJob(job) {

  const file =
    path.join(
      JOBS,
      `${job.id}.json`
    );

  await fs.writeFile(
    file,
    JSON.stringify(
      job,
      null,
      2
    ),
    "utf8"
  ).catch(() => {});
}

/*
=========================================================
FFMPEG
=========================================================
*/

function runFFmpeg(args) {

  return new Promise(
    (resolve, reject) => {

      if (!ffmpegPath) {

        reject(
          new Error(
            "FFmpeg is not available."
          )
        );

        return;
      }

      const child =
        spawn(
          ffmpegPath,
          args
        );

      let stderr = "";

      child.stderr.on(
        "data",
        data => {
          stderr +=
            data.toString();
        }
      );

      child.on(
        "error",
        reject
      );

      child.on(
        "close",
        code => {

          if (code === 0) {

            resolve();

          } else {

            reject(
              new Error(
                `FFmpeg failed: ${stderr.slice(-12000)}`
              )
            );
          }
        }
      );
    }
  );
}

/*
=========================================================
WATERMARK
=========================================================
*/

async function createWatermarkASS(
  file
) {

  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Mamaki,Arial,28,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,2,1,9,20,20,25,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,9:59:59.00,Mamaki,,0,0,0,,MAMAKI ✨
`;

  await fs.writeFile(
    file,
    content,
    "utf8"
  );
}

async function addWatermark(
  input,
  output
) {

  const ass =
    path.join(
      TMP,
      `watermark-${randomUUID()}.ass`
    );

  try {

    await createWatermarkASS(
      ass
    );

    const escaped =
      ass
        .replace(
          /\\/g,
          "/"
        )
        .replace(
          /:/g,
          "\\:"
        )
        .replace(
          /'/g,
          "\\'"
        );

    await runFFmpeg([
      "-y",

      "-i",
      input,

      "-vf",
      `subtitles='${escaped}'`,

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
      ass,
      {
        force: true
      }
    ).catch(() => {});
  }
}

/*
=========================================================
REPLICATE OUTPUT
=========================================================
*/

async function downloadReplicateOutput(
  output
) {

  if (!output) {

    throw new Error(
      "Replicate returned no video."
    );
  }

  /*
   * Current Wan output is a FileOutput
   * with .url().
   */

  if (
    typeof output.url ===
    "function"
  ) {

    const url =
      output.url();

    const response =
      await fetch(url);

    if (!response.ok) {

      throw new Error(
        `Replicate video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  /*
   * Some client versions may return
   * an array.
   */

  if (
    Array.isArray(output)
  ) {

    return downloadReplicateOutput(
      output[0]
    );
  }

  if (
    typeof output === "string"
  ) {

    const response =
      await fetch(output);

    if (!response.ok) {

      throw new Error(
        `Replicate video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  if (
    output &&
    typeof output.url ===
    "string"
  ) {

    const response =
      await fetch(
        output.url
      );

    if (!response.ok) {

      throw new Error(
        `Replicate video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  if (
    Buffer.isBuffer(output)
  ) {

    return output;
  }

  if (
    output instanceof Uint8Array
  ) {

    return Buffer.from(
      output
    );
  }

  throw new Error(
    "Unsupported Replicate output format."
  );
}

/*
=========================================================
IMAGE → DATA URL
=========================================================

Wan I2V accepts image URI/data URL.

For small images we can safely use
a data URL.

For very large images, compress with
FFmpeg first.
=========================================================
*/

async function prepareImageForReplicate(
  image,
  jobDir
) {

  if (!image) {

    throw new Error(
      "Reference image is required."
    );
  }

  if (!isImage(image)) {

    throw new Error(
      "Reference image must be JPG, PNG or WebP."
    );
  }

  /*
   * Replicate recommends data URLs for
   * small files (<=256 KB).
   *
   * Therefore we first check the upload.
   */

  if (
    image.buffer.length <=
    240 * 1024
  ) {

    return (
      `data:${image.mimetype};base64,` +
      image.buffer.toString("base64")
    );
  }

  /*
   * Compress/rescale large image with FFmpeg.
   */

  const source =
    path.join(
      jobDir,
      `reference-${randomUUID()}.${image.mimetype === "image/png" ? "png" : "jpg"}`
    );

  const compressed =
    path.join(
      jobDir,
      `reference-small-${randomUUID()}.jpg`
    );

  await fs.writeFile(
    source,
    image.buffer
  );

  await runFFmpeg([
    "-y",

    "-i",
    source,

    "-vf",
    "scale=1024:1024:force_original_aspect_ratio=decrease",

    "-q:v",
    "5",

    compressed
  ]);

  const compressedBuffer =
    await fs.readFile(
      compressed
    );

  /*
   * If still reasonably small,
   * use the data URL.
   */

  if (
    compressedBuffer.length <=
    240 * 1024
  ) {

    return (
      "data:image/jpeg;base64," +
      compressedBuffer.toString(
        "base64"
      )
    );
  }

  /*
   * Try a smaller image.
   */

  const tiny =
    path.join(
      jobDir,
      `reference-tiny-${randomUUID()}.jpg`
    );

  await runFFmpeg([
    "-y",

    "-i",
    compressed,

    "-vf",
    "scale=768:768:force_original_aspect_ratio=decrease",

    "-q:v",
    "8",

    tiny
  ]);

  const tinyBuffer =
    await fs.readFile(
      tiny
    );

  if (
    tinyBuffer.length >
    256 * 1024
  ) {

    throw new Error(
      "Reference image is too large for direct Replicate upload. Please use a smaller image."
    );
  }

  return (
    "data:image/jpeg;base64," +
    tinyBuffer.toString(
      "base64"
    )
  );
}

/*
=========================================================
WAN TEXT → VIDEO
=========================================================
*/

async function wanTextToVideo(
  prompt,
  ratio = "16:9"
) {

  if (!replicate) {

    throw new Error(
      "REPLICATE_API_TOKEN is missing."
    );
  }

  const input = {

    prompt:
      String(prompt).trim(),

    go_fast:
      true,

    num_frames:
      81,

    resolution:
      "480p",

    aspect_ratio:
      normalizeRatio(ratio),

    sample_shift:
      12,

    frames_per_second:
      16,

    interpolate_output:
      false,

    optimize_prompt:
      false,

    lora_scale_transformer:
      1,

    lora_scale_transformer_2:
      1
  };

  console.log(
    "MAMAKI T2V INPUT:",
    input
  );

  const output =
    await replicate.run(
      T2V_MODEL,
      {
        input
      }
    );

  return downloadReplicateOutput(
    output
  );
}

/*
=========================================================
WAN IMAGE → VIDEO
=========================================================
*/

async function wanImageToVideo(
  prompt,
  imageUri
) {

  if (!replicate) {

    throw new Error(
      "REPLICATE_API_TOKEN is missing."
    );
  }

  if (!imageUri) {

    throw new Error(
      "Reference image is required."
    );
  }

  /*
   * IMPORTANT:
   * I2V does NOT need aspect_ratio
   * in the current fast model schema.
   */

  const input = {

    image:
      imageUri,

    prompt:
      String(prompt || "").trim(),

    go_fast:
      true,

    num_frames:
      81,

    resolution:
      "480p",

    sample_shift:
      12,

    frames_per_second:
      16,

    interpolate_output:
      false,

    lora_scale_transformer:
      1,

    lora_scale_transformer_2:
      1
  };

  console.log(
    "MAMAKI I2V INPUT:",
    {
      ...input,
      image:
        "[IMAGE DATA HIDDEN]"
    }
  );

  const output =
    await replicate.run(
      I2V_MODEL,
      {
        input
      }
    );

  return downloadReplicateOutput(
    output
  );
}

/*
=========================================================
LONG FORM SCENE SPLITTER
=========================================================
*/

function splitIntoScenes(
  script,
  targetSeconds
) {

  const text =
    String(script || "")
      .trim();

  if (!text) {
    return [];
  }

  const sceneCount =
    Math.max(
      1,
      Math.ceil(
        targetSeconds / 5
      )
    );

  const sentences =
    text
      .split(
        /(?<=[.!?])\s+/
      )
      .filter(Boolean);

  const scenes = [];

  for (
    let i = 0;
    i < sceneCount;
    i++
  ) {

    const sentence =
      sentences[
        i %
        Math.max(
          1,
          sentences.length
        )
      ] ||
      text;

    scenes.push(
      `${sentence}. Cinematic continuous scene, natural realistic motion, coherent camera movement, detailed environment, professional video production.`
    );
  }

  return scenes;
}

/*
=========================================================
COMBINE VIDEO FILES
=========================================================
*/

async function combineVideoFiles(
  files,
  output
) {

  if (!files.length) {

    throw new Error(
      "No video clips supplied."
    );
  }

  const list =
    path.join(
      TMP,
      `concat-${randomUUID()}.txt`
    );

  const content =
    files
      .map(
        file =>
          `file '${file.replace(
            /'/g,
            "'\\''"
          )}'`
      )
      .join("\n");

  await fs.writeFile(
    list,
    content,
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
      {
        force: true
      }
    ).catch(() => {});
  }
}

/*
=========================================================
PHOTO → VIDEO
=========================================================
*/

async function createPhotoVideo(
  images,
  secondsPerPhoto,
  output,
  ratio = "16:9"
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
    {
      recursive: true
    }
  );

  const clips = [];

  try {

    for (
      let i = 0;
      i < images.length;
      i++
    ) {

      const image =
        images[i];

      if (!isImage(image)) {

        throw new Error(
          "All photos must be JPG, PNG or WebP."
        );
      }

      const imagePath =
        path.join(
          job,
          `image-${i}.jpg`
        );

      const clipPath =
        path.join(
          job,
          `clip-${i}.mp4`
        );

      await fs.writeFile(
        imagePath,
        image.buffer
      );

      let size =
        "1280:720";

      if (
        normalizeRatio(ratio) ===
        "9:16"
      ) {
        size =
          "720:1280";
      }

      if (
        normalizeRatio(ratio) ===
        "1:1"
      ) {
        size =
          "1080:1080";
      }

      await runFFmpeg([
        "-y",

        "-loop",
        "1",

        "-i",
        imagePath,

        "-t",
        String(
          clamp(
            secondsPerPhoto,
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

        clipPath
      ]);

      clips.push(
        clipPath
      );
    }

    return combineVideoFiles(
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
    safeNumber(
      end,
      NaN
    );

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
        endTime -
        startTime
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

  await runFFmpeg(
    args
  );

  return output;
}

/*
=========================================================
MUSIC
=========================================================
*/

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

  await runFFmpeg([
    "-y",

    "-i",
    video,

    "-stream_loop",
    "-1",

    "-i",
    music,

    "-filter_complex",
    `[0:a]volume=${ov}[original];[1:a]volume=${mv}[music];[original][music]amix=inputs=2:duration=first:dropout_transition=2[a]`,

    "-map",
    "0:v",

    "-map",
    "[a]",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-c:a",
    "aac",

    "-shortest",

    output
  ]);

  return output;
}

/*
=========================================================
MUTE
=========================================================
*/

async function muteVideo(
  input,
  output
) {

  await runFFmpeg([
    "-y",

    "-i",
    input,

    "-c:v",
    "copy",

    "-an",

    output
  ]);

  return output;
}

/*
=========================================================
NARRATION
=========================================================
*/

async function createNarration(
  text,
  output
) {

  const clean =
    String(text || "")
      .trim();

  if (!clean) {

    throw new Error(
      "Narration text is empty."
    );
  }

  const tts =
    new EdgeTTS(
      clean,
      "en-US-AriaNeural",
      {
        rate: "+0%",
        volume: "+0%",
        pitch: "+0Hz"
      }
    );

  const result =
    await tts.synthesize();

  if (!result?.audio) {

    throw new Error(
      "Narration generation failed."
    );
  }

  let buffer;

  if (
    Buffer.isBuffer(
      result.audio
    )
  ) {

    buffer =
      result.audio;

  } else if (
    result.audio instanceof
    Uint8Array
  ) {

    buffer =
      Buffer.from(
        result.audio
      );

  } else if (
    typeof result.audio.arrayBuffer ===
    "function"
  ) {

    buffer =
      Buffer.from(
        await result.audio.arrayBuffer()
      );

  } else {

    throw new Error(
      "Unsupported narration output."
    );
  }

  await fs.writeFile(
    output,
    buffer
  );

  return output;
}

/*
=========================================================
ATTACH NARRATION
=========================================================
*/

async function attachNarration(
  video,
  narration,
  output
) {

  await runFFmpeg([
    "-y",

    "-i",
    video,

    "-i",
    narration,

    "-map",
    "0:v",

    "-map",
    "1:a",

    "-c:v",
    "copy",

    "-c:a",
    "aac",

    "-shortest",

    output
  ]);

  return output;
}

/*
=========================================================
SAVE PROJECT
=========================================================
*/

app.post(
  "/api/projects/save",

  async (req, res) => {

    try {

      const project =
        req.body || {};

      const id =
        project.id ||
        randomUUID();

      const file =
        path.join(
          PROJECTS,
          `${id}.json`
        );

      await fs.writeFile(
        file,
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
        error:
          error.message
      });
    }
  }
);

/*
=========================================================
FREE PHOTO VIDEO
=========================================================
*/

app.post(
  "/api/studio/photo-video",

  upload.array(
    "images",
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
      {
        recursive: true
      }
    );

    try {

      const images =
        req.files || [];

      if (!images.length) {

        throw new Error(
          "Add at least one photo."
        );
      }

      const seconds =
        clamp(
          safeNumber(
            req.body.duration,
            3
          ),
          1,
          60
        );

      const raw =
        path.join(
          dir,
          "photo-video.mp4"
        );

      const final =
        path.join(
          OUTPUT,
          `mamaki-photo-${Date.now()}-${randomUUID()}.mp4`
        );

      await createPhotoVideo(
        images,
        seconds,
        raw,
        req.body.ratio
      );

      await addWatermark(
        raw,
        final
      );

      res.json({
        ok: true,
        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            path.basename(final)
          )}`,

        watermark:
          true,

        aiCredits:
          0
      });

    } catch (error) {

      console.error(
        "PHOTO VIDEO ERROR:",
        error
      );

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

/*
=========================================================
TRIM API
=========================================================
*/

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
      {
        recursive: true
      }
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

      const final =
        path.join(
          OUTPUT,
          `mamaki-trim-${Date.now()}-${randomUUID()}.mp4`
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

      if (
        String(
          req.body.muteOriginal
        ) === "true"
      ) {

        const muted =
          path.join(
            dir,
            "muted.mp4"
          );

        await muteVideo(
          current,
          muted
        );

        current =
          muted;
      }

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
          `/api/video/${encodeURIComponent(
            path.basename(final)
          )}`,

        watermark:
          true,

        aiCredits:
          0
      });

    } catch (error) {

      console.error(
        "TRIM ERROR:",
        error
      );

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

/*
=========================================================
COMBINE
=========================================================
*/

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
      {
        recursive: true
      }
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

        inputs.push(
          file
        );
      }

      const combined =
        path.join(
          dir,
          "combined.mp4"
        );

      const final =
        path.join(
          OUTPUT,
          `mamaki-combined-${Date.now()}-${randomUUID()}.mp4`
        );

      await combineVideoFiles(
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
          `/api/video/${encodeURIComponent(
            path.basename(final)
          )}`,

        watermark:
          true,

        aiCredits:
          0
      });

    } catch (error) {

      console.error(
        "COMBINE ERROR:",
        error
      );

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

/*
=========================================================
NARRATION
=========================================================
*/

app.post(
  "/api/studio/narration",

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
      {
        recursive: true
      }
    );

    try {

      const output =
        path.join(
          dir,
          "narration.mp3"
        );

      await createNarration(
        req.body.text,
        output
      );

      res.json({
        ok: true,
        success: true,

        message:
          "Narration created."
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

/*
=========================================================
BACKGROUND AI GENERATION
=========================================================
*/

async function processGenerationJob(
  jobId,
  data
) {

  const job =
    jobs.get(jobId);

  if (!job) {
    return;
  }

  const {
    prompt,
    requestedDuration,
    ratio,
    imageBuffer,
    imageMime
  } = data;

  const dir =
    path.join(
      TMP,
      jobId
    );

  await fs.mkdir(
    dir,
    {
      recursive: true
    }
  );

  try {

    updateJob(
      jobId,
      {
        status:
          "processing",

        progress:
          5,

        message:
          "Preparing your video..."
      }
    );

    await saveJob(
      jobs.get(jobId)
    );

    if (!replicate) {

      throw new Error(
        "REPLICATE_API_TOKEN is missing."
      );
    }

    /*
     * Rebuild uploaded image object
     * from the job's temporary data.
     */

    let image = null;

    if (imageBuffer) {

      image = {
        buffer:
          Buffer.from(
            imageBuffer,
            "base64"
          ),

        mimetype:
          imageMime
      };
    }

    let imageUri = null;

    if (image) {

      updateJob(
        jobId,
        {
          progress:
            8,

          message:
            "Preparing reference image..."
        }
      );

      imageUri =
        await prepareImageForReplicate(
          image,
          dir
        );
    }

    /*
     * 5-second scenes.
     */

    const sceneDuration =
      5;

    const sceneCount =
      Math.ceil(
        requestedDuration /
        sceneDuration
      );

    const scenes =
      splitIntoScenes(
        prompt,
        requestedDuration
      );

    const clips = [];

    /*
     * Generate sequentially.
     *
     * This is intentional:
     * it prevents Render's limited CPU/RAM
     * and the Replicate account from being
     * flooded with predictions.
     */

    for (
      let i = 0;
      i < sceneCount;
      i++
    ) {

      const sceneNumber =
        i + 1;

      const scenePrompt =
        scenes[i] ||
        `${prompt}. Cinematic continuation of the previous scene.`;

      const generationProgress =
        Math.round(
          10 +
          (
            (i / sceneCount) *
            65
          )
        );

      updateJob(
        jobId,
        {
          status:
            "generating",

          progress:
            generationProgress,

          message:
            `Generating scene ${sceneNumber} of ${sceneCount}...`
        }
      );

      await saveJob(
        jobs.get(jobId)
      );

      let buffer;

      if (
        imageUri &&
        i === 0
      ) {

        console.log(
          `MAMAKI JOB ${jobId}: I2V scene ${sceneNumber}`
        );

        buffer =
          await wanImageToVideo(
            scenePrompt,
            imageUri
          );

      } else {

        console.log(
          `MAMAKI JOB ${jobId}: T2V scene ${sceneNumber}`
        );

        buffer =
          await wanTextToVideo(
            scenePrompt,
            ratio
          );
      }

      const clip =
        path.join(
          dir,
          `scene-${i}.mp4`
        );

      await fs.writeFile(
        clip,
        buffer
      );

      clips.push(
        clip
      );

      updateJob(
        jobId,
        {
          progress:
            Math.round(
              10 +
              (
                (sceneNumber / sceneCount) *
                65
              )
            ),

          message:
            `Scene ${sceneNumber} completed.`
        }
      );

      await saveJob(
        jobs.get(jobId)
      );
    }

    /*
     * Combine.
     */

    updateJob(
      jobId,
      {
        status:
          "processing",

        progress:
          78,

        message:
          "Combining video scenes..."
      }
    );

    await saveJob(
      jobs.get(jobId)
    );

    const combined =
      path.join(
        dir,
        "combined.mp4"
      );

    await combineVideoFiles(
      clips,
      combined
    );

    /*
     * Watermark.
     */

    updateJob(
      jobId,
      {
        progress:
          88,

        message:
          "Applying MAMAKI watermark..."
      }
    );

    await saveJob(
      jobs.get(jobId)
    );

    const final =
      path.join(
        OUTPUT,
        `mamaki-ai-${Date.now()}-${randomUUID()}.mp4`
      );

    await addWatermark(
      combined,
      final
    );

    /*
     * Success.
     */

    const filename =
      path.basename(final);

    const videoUrl =
      `/api/video/${encodeURIComponent(
        filename
      )}`;

    updateJob(
      jobId,
      {
        status:
          "completed",

        progress:
          100,

        message:
          "MAMAKI AI video generated successfully.",

        videoUrl,

        model:
          imageUri
            ? I2V_MODEL
            : T2V_MODEL,

        generatedScenes:
          sceneCount,

        requestedDuration,

        watermark:
          "MAMAKI ✨"
      }
    );

    await saveJob(
      jobs.get(jobId)
    );

    console.log(
      `MAMAKI JOB ${jobId}: COMPLETE`
    );

  } catch (error) {

    console.error(
      `MAMAKI JOB ${jobId} ERROR:`,
      error?.stack ||
      error?.message ||
      error
    );

    let message =
      error?.message ||
      "Video generation failed.";

    const lower =
      message.toLowerCase();

    if (
      lower.includes(
        "insufficient credit"
      ) ||
      lower.includes(
        "insufficient funds"
      ) ||
      lower.includes(
        "402"
      )
    ) {

      message =
        "Replicate has insufficient credit or the account is disabled.";
    }

    updateJob(
      jobId,
      {
        status:
          "failed",

        progress:
          0,

        message:
          "Video generation failed.",

        error:
          message
      }
    );

    await saveJob(
      jobs.get(jobId)
    );

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

/*
=========================================================
MAIN AI GENERATOR
=========================================================

IMPORTANT:
This endpoint returns immediately.

The actual AI generation runs
in the background.

=========================================================
*/

app.post(
  "/api/generate",

  upload.fields([
    {
      name:
        "referenceImage",

      maxCount:
        1
    }
  ]),

  async (req, res) => {

    try {

      if (!replicate) {

        return res
          .status(503)
          .json({
            ok: false,

            success: false,

            error:
              "REPLICATE_API_TOKEN is missing on the server."
          });
      }

      const prompt =
        String(
          req.body.prompt || ""
        ).trim();

      if (!prompt) {

        return res
          .status(400)
          .json({
            ok: false,

            success: false,

            error:
              "Enter a video prompt."
          });
      }

      const requestedDuration =
        normalizeDuration(
          req.body.duration
        );

      const ratio =
        normalizeRatio(
          req.body.ratio ||
          req.body.aspectRatio
        );

      const image =
        req.files
          ?.referenceImage
          ?.[0] ||
        null;

      /*
       * Store image in base64 inside
       * job data so the background task
       * can continue after this request
       * has returned.
       */

      let imageBuffer = null;
      let imageMime = null;

      if (image) {

        if (!isImage(image)) {

          return res
            .status(400)
            .json({
              ok: false,

              success: false,

              error:
                "Reference image must be JPG, PNG or WebP."
            });
        }

        imageBuffer =
          image.buffer.toString(
            "base64"
          );

        imageMime =
          image.mimetype;
      }

      const job =
        createJob({
          prompt,

          requestedDuration,

          ratio
        });

      await saveJob(
        job
      );

      /*
       * IMPORTANT:
       * Return to browser FIRST.
       */

      res.status(202).json({

        ok: true,

        success: true,

        queued: true,

        jobId:
          job.id,

        status:
          "queued",

        progress:
          0,

        message:
          "Your MAMAKI AI video is being generated."
      });

      /*
       * Start generation after
       * response has been sent.
       */

      setImmediate(
        () => {

          processGenerationJob(
            job.id,
            {
              prompt,

              requestedDuration,

              ratio,

              imageBuffer,

              imageMime
            }
          ).catch(
            error => {

              console.error(
                "UNHANDLED JOB ERROR:",
                error
              );
            }
          );
        }
      );

    } catch (error) {

      console.error(
        "MAMAKI /api/generate ERROR:",
        error
      );

      res.status(500).json({
        ok: false,

        success: false,

        error:
          error?.message ||
          "Could not create video generation job."
      });
    }
  }
);

/*
=========================================================
GENERATION STATUS
=========================================================
*/

app.get(
  "/api/generate/status/:jobId",

  async (req, res) => {

    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {

      /*
       * Try disk backup.
       */

      try {

        const file =
          path.join(
            JOBS,
            `${path.basename(
              req.params.jobId
            )}.json`
          );

        const data =
          await fs.readFile(
            file,
            "utf8"
          );

        return res.json(
          JSON.parse(data)
        );

      } catch {

        return res
          .status(404)
          .json({
            ok: false,

            error:
              "Generation job not found."
          });
      }
    }

    return res.json({
      ok: true,

      ...job
    });
  }
);

/*
=========================================================
ALIAS STATUS ENDPOINT
=========================================================
*/

app.get(
  "/api/job/:jobId",

  async (req, res) => {

    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {

      return res
        .status(404)
        .json({
          ok: false,

          error:
            "Job not found."
        });
    }

    return res.json({
      ok: true,

      ...job
    });
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

      await fs.access(
        file
      );

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${filename}"`
      );

      return res.sendFile(
        file
      );

    } catch {

      return res
        .status(404)
        .json({
          ok: false,

          error:
            "Video not found."
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

  async (req, res) => {

    res.json({

      ok:
        true,

      app:
        "MAMAKI AI VIDEO",

      version:
        "8.0.0",

      server:
        "online",

      replicate:
        Boolean(
          replicate
        ),

      textToVideo:
        T2V_MODEL,

      imageToVideo:
        I2V_MODEL,

      aiModelGeneration:
        "Wan 2.2 Fast",

      minimumProjectDuration:
        5,

      longFormProjects:
        true,

      backgroundJobs:
        true,

      jobStatusEndpoint:
        "/api/generate/status/:jobId",

      freeStudio:
        true,

      photoVideo:
        true,

      multiplePhotos:
        true,

      videoTrimming:
        true,

      combineClips:
        true,

      music:
        true,

      narration:
        true,

      projects:
        true,

      ffmpeg:
        Boolean(
          ffmpegPath
        ),

      watermark:
        "MAMAKI ✨",

      watermarkAlwaysApplied:
        true,

      aiCreditsForFreeStudio:
        0
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

      status:
        "ok",

      app:
        "MAMAKI AI VIDEO",

      version:
        "8.0.0",

      replicate:
        Boolean(
          replicate
        ),

      ffmpeg:
        Boolean(
          ffmpegPath
        ),

      backgroundJobs:
        true,

      freeStudio:
        true,

      watermark:
        "MAMAKI ✨"
    });
  }
);

/*
=========================================================
START SERVER
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
      "MAMAKI AI VIDEO v8.0.0"
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
      `T2V: ${T2V_MODEL}`
    );

    console.log(
      `I2V: ${I2V_MODEL}`
    );

    console.log(
      "BACKGROUND JOBS: ENABLED"
    );

    console.log(
      "LONG FORM: ENABLED"
    );

    console.log(
      "PHOTO VIDEO: ENABLED"
    );

    console.log(
      "MULTIPLE PHOTOS: ENABLED"
    );

    console.log(
      "TRIMMER: ENABLED"
    );

    console.log(
      "MUSIC: ENABLED"
    );

    console.log(
      "NARRATION: ENABLED"
    );

    console.log(
      "COMBINE: ENABLED"
    );

    console.log(
      "WATERMARK: MAMAKI ✨"
    );

    console.log(
      "FREE STUDIO: ENABLED"
    );

    console.log(
      "======================================"
    );
  }
);
