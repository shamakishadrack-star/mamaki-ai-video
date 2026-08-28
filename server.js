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
  ? new Replicate({ auth: REPLICATE_API_TOKEN })
  : null;

/*
=========================================================
MAMAKI AI VIDEO
BACKEND v7
=========================================================

AI:
WAN 2.2 FAST T2V
WAN 2.2 FAST I2V

FREE STUDIO:
PHOTO → VIDEO
VIDEO TRIMMER
COMBINE CLIPS
MUSIC
NARRATION
CAPTIONS
PROJECTS

PROCESSING:
FFmpeg

WATERMARK:
MAMAKI ✨

IMPORTANT:
Wan generates short clips.
Long projects are assembled from multiple clips.
=========================================================
*/

const T2V_MODEL =
  "wan-video/wan-2.2-t2v-fast";

const I2V_MODEL =
  "wan-video/wan-2.2-i2v-fast";

const TMP = path.join(ROOT, "tmp");
const OUTPUT = path.join(ROOT, "outputs");
const PROJECTS = path.join(ROOT, "projects");
const INDEX = path.join(ROOT, "index.html");

await fs.mkdir(TMP, { recursive: true });
await fs.mkdir(OUTPUT, { recursive: true });
await fs.mkdir(PROJECTS, { recursive: true });

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

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
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
  if (value === "9:16") return "9:16";
  if (value === "1:1") return "1:1";
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

function imageDataUri(file) {
  return (
    `data:${file.mimetype};base64,` +
    file.buffer.toString("base64")
  );
}

/*
=========================================================
WAN 2.2 FRAME CALCULATION
=========================================================

Wan 2.2 Fast currently accepts:
81–121 frames.

At 16 FPS this is roughly:
5.06–7.56 seconds.

Therefore:
LONG VIDEOS ARE NOT GENERATED AS ONE WAN PREDICTION.

MAMAKI creates multiple scenes and combines them.
=========================================================
*/

function wanFrames(seconds) {
  const requested =
    safeNumber(seconds, 5);

  if (requested <= 5) {
    return 81;
  }

  return 121;
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

      const child = spawn(
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

Watermark is ALWAYS applied.

There is no user on/off switch.

=========================================================
*/

async function createWatermarkASS(file) {

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
        .replace(/\\/g, "/")
        .replace(/:/g, "\\:")
        .replace(/'/g, "\\'");

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
      { force: true }
    ).catch(() => {});
  }
}

/*
=========================================================
REPLICATE OUTPUT
=========================================================
*/

async function downloadReplicateOutput(output) {

  const item =
    Array.isArray(output)
      ? output[0]
      : output;

  if (!item) {
    throw new Error(
      "Replicate returned no video."
    );
  }

  if (Buffer.isBuffer(item)) {
    return item;
  }

  if (item instanceof Uint8Array) {
    return Buffer.from(item);
  }

  if (
    typeof item.url === "function"
  ) {

    const response =
      await fetch(
        item.url()
      );

    if (!response.ok) {
      throw new Error(
        `Replicate video download failed: ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  if (typeof item === "string") {

    const response =
      await fetch(item);

    if (!response.ok) {
      throw new Error(
        `Replicate video download failed: ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  if (
    item &&
    typeof item.url === "string"
  ) {

    const response =
      await fetch(item.url);

    if (!response.ok) {
      throw new Error(
        `Replicate video download failed: ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  throw new Error(
    "Unsupported Replicate output."
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
    prompt: String(prompt).trim(),

    go_fast: true,

    num_frames: 81,

    resolution: "480p",

    aspect_ratio:
      normalizeRatio(ratio),

    sample_shift: 12,

    frames_per_second: 16,

    interpolate_output: false,

    optimize_prompt: false,

    lora_scale_transformer: 1,

    lora_scale_transformer_2: 1
  };

  console.log(
    "MAMAKI T2V:",
    input
  );

  const output =
    await replicate.run(
      T2V_MODEL,
      { input }
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
  image,
  ratio = "16:9"
) {

  if (!replicate) {
    throw new Error(
      "REPLICATE_API_TOKEN is missing."
    );
  }

  if (!image) {
    throw new Error(
      "Reference image is required."
    );
  }

  const input = {

    image:
      imageDataUri(image),

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

  /*
   * Only include aspect_ratio when
   * the model/frontend requests it.
   */

  input.aspect_ratio =
    normalizeRatio(ratio);

  console.log(
    "MAMAKI I2V:",
    input
  );

  const output =
    await replicate.run(
      I2V_MODEL,
      { input }
    );

  return downloadReplicateOutput(
    output
  );
}

/*
=========================================================
LONG-FORM SCENE SPLITTER
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

  /*
   * Roughly one scene every 5 seconds.
   * Each scene becomes one AI clip.
   */

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
        i % Math.max(
          1,
          sentences.length
        )
      ] ||
      text;

    scenes.push(
      `${sentence}. Cinematic continuous scene, natural motion, coherent camera movement, professional video production.`
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
      { force: true }
    ).catch(() => {});
  }
}

/*
=========================================================
PHOTO → VIDEO
MULTIPLE PHOTOS
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
    { recursive: true }
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
        size = "720:1280";
      }

      if (
        normalizeRatio(ratio) ===
        "1:1"
      ) {
        size = "1080:1080";
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
TRIM VIDEO
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

  await runFFmpeg(args);

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
    `[0:a]volume=${ov}[original];` +
    `[1:a]volume=${mv}[music];` +
    `[original][music]amix=inputs=2:duration=first:dropout_transition=2[a]`,

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
MUTE ORIGINAL VIDEO
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

  if (Buffer.isBuffer(result.audio)) {

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
ADD NARRATION
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
        error: error.message
      });
    }
  }
);

/*
=========================================================
FREE PHOTO → VIDEO API
MULTIPLE PHOTOS
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
      { recursive: true }
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
        watermark: true,
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
FREE VIDEO TRIMMER API
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

      /*
       * Remove original audio
       */

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

      /*
       * Add music
       */

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
        watermark: true,
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
COMBINE VIDEOS
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
        watermark: true,
        aiCredits: 0
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

/*
=========================================================
NARRATION API
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
      { recursive: true }
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
MAIN AI GENERATOR
=========================================================
*/

app.post(
  "/api/generate",

  upload.fields([
    {
      name:
        "referenceImage",
      maxCount: 1
    }
  ]),

  async (req, res) => {

    try {

      if (!replicate) {
        throw new Error(
          "REPLICATE_API_TOKEN is missing."
        );
      }

      const prompt =
        String(
          req.body.prompt || ""
        ).trim();

      if (!prompt) {
        throw new Error(
          "Enter a video prompt."
        );
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
        req.files?.referenceImage?.[0] ||
        null;

      /*
       * IMPORTANT:
       *
       * A single Wan prediction is only
       * around 5–7.5 seconds.
       *
       * Therefore:
       *
       * <= 5 sec:
       * one prediction
       *
       * > 5 sec:
       * generate multiple scenes
       * and combine them.
       */

      const sceneDuration =
        5;

      const sceneCount =
        Math.ceil(
          requestedDuration /
          sceneDuration
        );

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

        const clips = [];

        /*
         * For a long project, divide
         * the prompt into scenes.
         */

        const scenes =
          splitIntoScenes(
            prompt,
            requestedDuration
          );

        /*
         * Limit concurrent generation
         * to prevent overwhelming the
         * server/Replicate.
         */

        for (
          let i = 0;
          i < sceneCount;
          i++
        ) {

          const scenePrompt =
            scenes[i] ||
            `${prompt}. Cinematic continuation of the previous scene.`;

          console.log(
            `MAMAKI: generating scene ${i + 1}/${sceneCount}`
          );

          let buffer;

          if (
            image &&
            i === 0
          ) {

            buffer =
              await wanImageToVideo(
                scenePrompt,
                image,
                ratio
              );

          } else {

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
        }

        /*
         * Combine scenes.
         */

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
         * Final MAMAKI watermark.
         */

        const final =
          path.join(
            OUTPUT,
            `mamaki-ai-${Date.now()}-${randomUUID()}.mp4`
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

          file:
            path.basename(final),

          requestedDuration,

          generatedScenes:
            sceneCount,

          watermark:
            "MAMAKI ✨",

          watermarkActive:
            true,

          model:
            image
              ? I2V_MODEL
              : T2V_MODEL,

          message:
            "MAMAKI AI video generated successfully."
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

    } catch (error) {

      console.error(
        "MAMAKI GENERATION ERROR:",
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
          "Replicate has insufficient credit or the account is disabled. MAMAKI cannot generate AI video until the Replicate account is active.";
      }

      res.status(500).json({
        ok: false,
        success: false,
        error: message
      });
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

      await fs.access(file);

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

      return res.status(404).json({
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

      app:
        "MAMAKI AI VIDEO",

      version:
        "7.0.0",

      server:
        "online",

      replicate:
        Boolean(replicate),

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

      captions:
        true,

      projects:
        true,

      ffmpeg:
        Boolean(ffmpegPath),

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
        "7.0.0",

      replicate:
        Boolean(replicate),

      ffmpeg:
        Boolean(ffmpegPath),

      freeStudio:
        true,

      watermark:
        "MAMAKI ✨"
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
      "MAMAKI AI VIDEO v7.0.0"
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
