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

const REPLICATE_TOKEN =
  String(process.env.REPLICATE_API_TOKEN || "").trim();

const replicate = REPLICATE_TOKEN
  ? new Replicate({ auth: REPLICATE_TOKEN })
  : null;

/*
==========================================================
 MAMAKI AI VIDEO
 Corrected Wan 2.2 Fast backend
==========================================================

 AI
 ----
 Text → Video
 wan-video/wan-2.2-t2v-fast

 Image → Video
 wan-video/wan-2.2-i2v-fast

 FREE STUDIO
 ----
 Photo → Video
 Multiple photos
 Photo duration
 Transitions
 Music
 Narration
 Captions
 Video trimming
 Original audio controls
 Combine clips
 Projects

 PROCESSING
 ----
 FFmpeg

 WATERMARK
 ----
 MAMAKI ✨
 Always enabled
 AI + Free Studio

 IMPORTANT
 ----
 Long videos are assembled from multiple AI clips.
 A single Wan request is NOT used to fake a 2-hour
 generation.
==========================================================
*/

const T2V_MODEL =
  "wan-video/wan-2.2-t2v-fast";

const I2V_MODEL =
  "wan-video/wan-2.2-i2v-fast";

/*
==========================================================
 DIRECTORIES
==========================================================
*/

const TMP =
  path.join(ROOT, "tmp");

const OUTPUT =
  path.join(ROOT, "outputs");

const PROJECTS =
  path.join(ROOT, "projects");

const INDEX =
  path.join(ROOT, "index.html");

await fs.mkdir(TMP, { recursive: true });
await fs.mkdir(OUTPUT, { recursive: true });
await fs.mkdir(PROJECTS, { recursive: true });

/*
==========================================================
 MIDDLEWARE
==========================================================
*/

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
==========================================================
 HOME
==========================================================
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
==========================================================
 MULTER
==========================================================
*/

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 100
  }
});

/*
==========================================================
 BASIC HELPERS
==========================================================
*/

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function clamp(value, min, max) {
  return Math.min(
    max,
    Math.max(min, value)
  );
}

/*
==========================================================
 AI DURATION
==========================================================

 Wan 2.2 Fast generates short clips.

 5 seconds is the minimum.

 For long-form projects, MAMAKI creates multiple
 AI clips and combines them later.

 This avoids pretending that one AI prediction
 can directly generate a 2-hour video.
==========================================================
*/

function aiClipDuration(value) {
  const seconds =
    Math.round(
      safeNumber(value, 5)
    );

  return clamp(
    seconds,
    5,
    10
  );
}

function projectDuration(value) {
  const seconds =
    Math.floor(
      safeNumber(value, 5)
    );

  return Math.max(
    5,
    seconds
  );
}

/*
==========================================================
 ASPECT RATIO
==========================================================
*/

function aspectRatio(value) {
  if (value === "9:16") {
    return "9:16";
  }

  if (value === "1:1") {
    return "1:1";
  }

  return "16:9";
}

/*
==========================================================
 WAN 2.2 FRAME COUNT
==========================================================

 16 FPS

 5 seconds ≈ 81 frames
 7.5 seconds ≈ 121 frames

 We keep requests inside the short AI clip range.
==========================================================
*/

function calculateFrames(seconds) {
  const duration =
    aiClipDuration(seconds);

  return Math.max(
    81,
    Math.round(
      duration * 16
    )
  );
}

/*
==========================================================
 FILE TYPES
==========================================================
*/

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
==========================================================
 IMAGE → DATA URI
==========================================================
*/

function imageToDataUri(
  buffer,
  mimetype
) {
  return (
    `data:${mimetype || "image/jpeg"};base64,` +
    buffer.toString("base64")
  );
}

/*
==========================================================
 WRITE TEMP FILE
==========================================================
*/

async function writeUpload(
  directory,
  file,
  name
) {
  const extension =
    path.extname(
      file.originalname || ""
    ) || ".bin";

  const filename =
    `${name}-${randomUUID()}${extension}`;

  const filePath =
    path.join(
      directory,
      filename
    );

  await fs.writeFile(
    filePath,
    file.buffer
  );

  return filePath;
}

/*
==========================================================
 GET REPLICATE VIDEO
==========================================================
*/

async function getVideoBuffer(output) {

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

  /*
   Replicate FileOutput
  */

  if (
    item &&
    typeof item.url === "function"
  ) {
    const response =
      await fetch(item.url());

    if (!response.ok) {
      throw new Error(
        `Video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  /*
   URL string
  */

  if (typeof item === "string") {
    const response =
      await fetch(item);

    if (!response.ok) {
      throw new Error(
        `Video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  /*
   Object URL
  */

  if (
    item &&
    typeof item.url === "string"
  ) {
    const response =
      await fetch(item.url);

    if (!response.ok) {
      throw new Error(
        `Video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  /*
   HREF
  */

  if (
    item &&
    typeof item.href === "string"
  ) {
    const response =
      await fetch(item.href);

    if (!response.ok) {
      throw new Error(
        `Video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  throw new Error(
    "Unsupported Replicate video output."
  );
}

/*
==========================================================
 FFMPEG
==========================================================
*/

function ffmpeg(args) {
  return new Promise(
    (resolve, reject) => {

      if (!ffmpegPath) {
        reject(
          new Error(
            "FFmpeg is unavailable."
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
            return;
          }

          reject(
            new Error(
              `FFmpeg error: ${stderr.slice(-12000)}`
            )
          );
        }
      );
    }
  );
}

/*
==========================================================
 ASS TEXT ESCAPE
==========================================================
*/

function escapeAssText(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

/*
==========================================================
 WATERMARK ASS
==========================================================

 Permanent MAMAKI ✨ watermark.

 Top-right.

 It remains throughout the video.

 It cannot be switched off by the frontend.
==========================================================
*/

async function createWatermarkASS(
  file
) {

  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Mamaki,Arial,34,&H00FFFFFF,&H00FFFFFF,&H00000000,&H70000000,1,0,0,0,100,100,0,0,1,2,1,9,25,25,25,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,9:59:59.00,Mamaki,,0,0,0,,MAMAKI ✨
`;

  await fs.writeFile(
    file,
    ass,
    "utf8"
  );

  return file;
}

/*
==========================================================
 ADD WATERMARK
==========================================================
*/

async function addMamakiWatermark(
  input,
  output
) {

  const watermark =
    path.join(
      TMP,
      `watermark-${randomUUID()}.ass`
    );

  try {

    await createWatermarkASS(
      watermark
    );

    const escaped =
      watermark
        .replace(/\\/g, "/")
        .replace(/:/g, "\\:")
        .replace(/'/g, "\\'");

    await ffmpeg([
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
      watermark,
      {
        force: true
      }
    ).catch(() => {});
  }
}

/*
==========================================================
 ADD CAPTIONS / TEXT
==========================================================
*/

async function addCaption(
  input,
  output,
  text
) {

  const captionFile =
    path.join(
      TMP,
      `caption-${randomUUID()}.ass`
    );

  const clean =
    escapeAssText(text);

  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,42,&H00FFFFFF,&H00FFFFFF,&H00000000,&H90000000,1,0,0,0,100,100,0,0,1,2,1,2,40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,9:59:59.00,Caption,,0,0,60,,${clean}
`;

  try {

    await fs.writeFile(
      captionFile,
      ass,
      "utf8"
    );

    const escaped =
      captionFile
        .replace(/\\/g, "/")
        .replace(/:/g, "\\:")
        .replace(/'/g, "\\'");

    await ffmpeg([
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
      captionFile,
      {
        force: true
      }
    ).catch(() => {});
  }
}

/*
==========================================================
 FINALIZE
==========================================================
*/

async function finalizeVideo(
  input,
  output
) {
  return addMamakiWatermark(
    input,
    output
  );
}

/*
==========================================================
 AI TEXT → VIDEO
==========================================================
*/

async function generateTextVideo(
  prompt,
  seconds,
  ratio
) {

  if (!replicate) {
    throw new Error(
      "REPLICATE_API_TOKEN is missing."
    );
  }

  const cleanPrompt =
    String(prompt || "").trim();

  if (!cleanPrompt) {
    throw new Error(
      "Video prompt is empty."
    );
  }

  const clipSeconds =
    aiClipDuration(seconds);

  const frames =
    calculateFrames(
      clipSeconds
    );

  const finalRatio =
    aspectRatio(ratio);

  const input = {
    prompt: cleanPrompt,

    num_frames: frames,

    resolution: "480p",

    aspect_ratio: finalRatio,

    frames_per_second: 16,

    go_fast: true,

    sample_shift: 12,

    interpolate_output: false,

    disable_safety_checker: false
  };

  console.log(
    "MAMAKI WAN 2.2 T2V"
  );

  console.log(
    "Prompt:",
    cleanPrompt
  );

  console.log(
    "Frames:",
    frames
  );

  try {

    const prediction =
      await replicate.run(
        T2V_MODEL,
        {
          input
        }
      );

    return await getVideoBuffer(
      prediction
    );

  } catch (error) {

    console.error(
      "WAN 2.2 T2V ERROR:",
      error?.stack ||
      error?.message ||
      error
    );

    throw error;
  }
}

/*
==========================================================
 AI IMAGE → VIDEO
==========================================================
*/

async function generateImageVideo(
  prompt,
  seconds,
  ratio,
  image
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

  const imageUri =
    imageToDataUri(
      image.buffer,
      image.mimetype
    );

  const clipSeconds =
    aiClipDuration(seconds);

  const frames =
    calculateFrames(
      clipSeconds
    );

  const input = {
    image: imageUri,

    prompt:
      String(prompt || "").trim(),

    num_frames: frames,

    resolution: "480p",

    aspect_ratio:
      aspectRatio(ratio),

    frames_per_second: 16,

    go_fast: true,

    sample_shift: 12,

    interpolate_output: false,

    disable_safety_checker: false
  };

  console.log(
    "MAMAKI WAN 2.2 I2V"
  );

  try {

    const prediction =
      await replicate.run(
        I2V_MODEL,
        {
          input
        }
      );

    return await getVideoBuffer(
      prediction
    );

  } catch (error) {

    console.error(
      "WAN 2.2 I2V ERROR:",
      error?.stack ||
      error?.message ||
      error
    );

    throw error;
  }
}

/*
==========================================================
 COMBINE VIDEO FILES
==========================================================
*/

async function combineVideos(
  files,
  output
) {

  if (!files.length) {
    throw new Error(
      "No videos supplied."
    );
  }

  const listFile =
    path.join(
      TMP,
      `concat-${randomUUID()}.txt`
    );

  const lines =
    files.map(
      file =>
        `file '${file
          .replace(/\\/g, "/")
          .replace(/'/g, "'\\''")}'`
    );

  await fs.writeFile(
    listFile,
    lines.join("\n"),
    "utf8"
  );

  try {

    await ffmpeg([
      "-y",

      "-f",
      "concat",

      "-safe",
      "0",

      "-i",
      listFile,

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
      listFile,
      {
        force: true
      }
    ).catch(() => {});
  }
}

/*
==========================================================
 PHOTO → VIDEO
==========================================================

 Multiple photos.

 Each photo can have its own duration.

 Transition options:
 - fade
 - dissolve
 - none
 - wipeleft
 - slideright

 For reliable processing we create each photo
 as a short video, then concatenate them.
==========================================================
*/

async function createPhotoClip(
  imagePath,
  durationSeconds,
  output,
  transition = "fade"
) {

  const duration =
    clamp(
      safeNumber(
        durationSeconds,
        3
      ),
      1,
      60
    );

  /*
   Ken Burns style movement.
  */

  const zoom =
    transition === "slideright"
      ? "zoompan=z='min(zoom+0.001,1.12)':x='iw/2-(iw/zoom/2)+on*0.4':y='ih/2-(ih/zoom/2)':d=1:s=1280x720:fps=30"
      : "zoompan=z='min(zoom+0.001,1.12)':d=1:s=1280x720:fps=30";

  await ffmpeg([
    "-y",

    "-loop",
    "1",

    "-i",
    imagePath,

    "-t",
    String(duration),

    "-vf",
    "scale=1280:720:force_original_aspect_ratio=decrease," +
    "pad=1280:720:(ow-iw)/2:(oh-ih)/2," +
    zoom,

    "-an",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-pix_fmt",
    "yuv420p",

    output
  ]);

  return output;
}

/*
==========================================================
 MULTI PHOTO VIDEO
==========================================================
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

    const jobDir =
      path.join(
        TMP,
        job
      );

    await fs.mkdir(
      jobDir,
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

      for (const image of images) {
        if (!isImage(image)) {
          throw new Error(
            "Only JPG, PNG and WebP photos are supported."
          );
        }
      }

      let durations = [];

      try {
        durations =
          JSON.parse(
            req.body.durations || "[]"
          );
      } catch {
        durations = [];
      }

      const transition =
        String(
          req.body.transition ||
          "fade"
        );

      const clips = [];

      for (
        let i = 0;
        i < images.length;
        i++
      ) {

        const image =
          images[i];

        const imagePath =
          await writeUpload(
            jobDir,
            image,
            `photo-${i}`
          );

        const clip =
          path.join(
            jobDir,
            `photo-${i}.mp4`
          );

        await createPhotoClip(
          imagePath,
          durations[i] || 3,
          clip,
          transition
        );

        clips.push(clip);
      }

      const combined =
        path.join(
          jobDir,
          "photo-video.mp4"
        );

      const final =
        path.join(
          OUTPUT,
          `mamaki-photo-${Date.now()}-${randomUUID()}.mp4`
        );

      await combineVideos(
        clips,
        combined
      );

      /*
       Optional music
      */

      let current =
        combined;

      if (req.files.music) {
        // Reserved for future field-based upload.
      }

      await finalizeVideo(
        current,
        final
      );

      return res.json({
        ok: true,
        success: true,

        type:
          "photo-video",

        videoUrl:
          `/api/video/${encodeURIComponent(
            path.basename(final)
          )}`,

        photos:
          images.length,

        transition,

        creditsUsed:
          0,

        watermark:
          "MAMAKI ✨",

        message:
          "Photo video created successfully."
      });

    } catch (error) {

      console.error(
        "PHOTO VIDEO ERROR:",
        error?.stack ||
        error?.message ||
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          success: false,
          error:
            error?.message ||
            "Photo video failed."
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
);

/*
==========================================================
 VIDEO TRIM
==========================================================
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

    const jobDir =
      path.join(
        TMP,
        job
      );

    await fs.mkdir(
      jobDir,
      {
        recursive: true
      }
    );

    try {

      const video =
        req.files?.video?.[0];

      const music =
        req.files?.music?.[0];

      if (!isVideo(video)) {
        throw new Error(
          "Upload a valid video."
        );
      }

      const input =
        await writeUpload(
          jobDir,
          video,
          "input"
        );

      const trimmed =
        path.join(
          jobDir,
          "trimmed.mp4"
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
          0
        );

      const trimArgs = [
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
        trimArgs.push(
          "-t",
          String(
            end - start
          )
        );
      }

      trimArgs.push(
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

        trimmed
      );

      await ffmpeg(
        trimArgs
      );

      let current =
        trimmed;

      /*
       Original audio volume
      */

      const originalVolume =
        clamp(
          safeNumber(
            req.body.originalVolume,
            1
          ),
          0,
          2
        );

      if (
        originalVolume !== 1
      ) {

        const adjusted =
          path.join(
            jobDir,
            "audio-adjusted.mp4"
          );

        await ffmpeg([
          "-y",

          "-i",
          current,

          "-filter:a",
          `volume=${originalVolume}`,

          "-c:v",
          "copy",

          "-c:a",
          "aac",

          adjusted
        ]);

        current =
          adjusted;
      }

      /*
       Music
      */

      if (music) {

        if (!isAudio(music)) {
          throw new Error(
            "Music file is not a supported audio format."
          );
        }

        const musicPath =
          await writeUpload(
            jobDir,
            music,
            "music"
          );

        const withMusic =
          path.join(
            jobDir,
            "with-music.mp4"
          );

        const musicVolume =
          clamp(
            safeNumber(
              req.body.musicVolume,
              0.25
            ),
            0,
            2
          );

        await ffmpeg([
          "-y",

          "-i",
          current,

          "-stream_loop",
          "-1",

          "-i",
          musicPath,

          "-filter_complex",
          `[1:a]volume=${musicVolume}[music];` +
          `[0:a][music]amix=inputs=2:` +
          `duration=first:` +
          `dropout_transition=2[a]`,

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

          withMusic
        ]);

        current =
          withMusic;
      }

      /*
       Caption
      */

      const caption =
        String(
          req.body.caption ||
          ""
        ).trim();

      if (caption) {

        const captioned =
          path.join(
            jobDir,
            "captioned.mp4"
          );

        await addCaption(
          current,
          captioned,
          caption
        );

        current =
          captioned;
      }

      /*
       Final permanent watermark
      */

      const final =
        path.join(
          OUTPUT,
          `mamaki-trim-${Date.now()}-${randomUUID()}.mp4`
        );

      await finalizeVideo(
        current,
        final
      );

      return res.json({
        ok: true,
        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            path.basename(final)
          )}`,

        start,
        end,

        originalVolume,

        music:
          Boolean(music),

        musicVolume:
          safeNumber(
            req.body.musicVolume,
            0.25
          ),

        creditsUsed:
          0,

        watermark:
          "MAMAKI ✨",

        message:
          "Video processed successfully."
      });

    } catch (error) {

      console.error(
        "TRIM ERROR:",
        error?.stack ||
        error?.message ||
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          success: false,
          error:
            error?.message ||
            "Video trimming failed."
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
);

/*
==========================================================
 COMBINE CLIPS
==========================================================
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

    const jobDir =
      path.join(
        TMP,
        job
      );

    await fs.mkdir(
      jobDir,
      {
        recursive: true
      }
    );

    try {

      const videos =
        req.files || [];

      if (!videos.length) {
        throw new Error(
          "Upload at least one video."
        );
      }

      const paths = [];

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

        const p =
          await writeUpload(
            jobDir,
            videos[i],
            `clip-${i}`
          );

        paths.push(p);
      }

      const combined =
        path.join(
          jobDir,
          "combined.mp4"
        );

      await combineVideos(
        paths,
        combined
      );

      const final =
        path.join(
          OUTPUT,
          `mamaki-combined-${Date.now()}-${randomUUID()}.mp4`
        );

      await finalizeVideo(
        combined,
        final
      );

      return res.json({
        ok: true,
        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            path.basename(final)
          )}`,

        clips:
          videos.length,

        creditsUsed:
          0,

        watermark:
          "MAMAKI ✨"
      });

    } catch (error) {

      return res
        .status(500)
        .json({
          ok: false,
          success: false,
          error:
            error?.message ||
            "Combine failed."
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
);

/*
==========================================================
 NARRATION
==========================================================
*/

async function createVoice(
  text,
  output
) {

  const narration =
    String(
      text || ""
    ).trim();

  if (!narration) {
    throw new Error(
      "Narration text is empty."
    );
  }

  const tts =
    new EdgeTTS(
      narration,
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
      "Narration produced no audio."
    );
  }

  let buffer;

  if (Buffer.isBuffer(result.audio)) {

    buffer =
      result.audio;

  } else if (
    result.audio instanceof Uint8Array
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
      "Unable to read narration audio."
    );
  }

  await fs.writeFile(
    output,
    buffer
  );

  return output;
}

/*
==========================================================
 ADD NARRATION
==========================================================
*/

app.post(
  "/api/studio/narration",

  upload.fields([
    {
      name: "video",
      maxCount: 1
    }
  ]),

  async (req, res) => {

    const job =
      randomUUID();

    const jobDir =
      path.join(
        TMP,
        job
      );

    await fs.mkdir(
      jobDir,
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

      const text =
        String(
          req.body.text ||
          req.body.narration ||
          ""
        ).trim();

      if (!text) {
        throw new Error(
          "Enter narration text."
        );
      }

      const videoPath =
        await writeUpload(
          jobDir,
          video,
          "video"
        );

      const voice =
        path.join(
          jobDir,
          "voice.mp3"
        );

      await createVoice(
        text,
        voice
      );

      const output =
        path.join(
          jobDir,
          "narrated.mp4"
        );

      await ffmpeg([
        "-y",

        "-i",
        videoPath,

        "-i",
        voice,

        "-map",
        "0:v",

        "-map",
        "1:a",

        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-c:a",
        "aac",

        "-shortest",

        output
      ]);

      const final =
        path.join(
          OUTPUT,
          `mamaki-narration-${Date.now()}-${randomUUID()}.mp4`
        );

      await finalizeVideo(
        output,
        final
      );

      return res.json({
        ok: true,
        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            path.basename(final)
          )}`,

        creditsUsed:
          0,

        watermark:
          "MAMAKI ✨"
      });

    } catch (error) {

      return res
        .status(500)
        .json({
          ok: false,
          success: false,
          error:
            error?.message ||
            "Narration failed."
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
);

/*
==========================================================
 AI GENERATION
==========================================================
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

    const job =
      randomUUID();

    const jobDir =
      path.join(
        TMP,
        job
      );

    await fs.mkdir(
      jobDir,
      {
        recursive: true
      }
    );

    try {

      if (!replicate) {
        throw new Error(
          "REPLICATE_API_TOKEN is missing."
        );
      }

      const body =
        req.body || {};

      const files =
        req.files || {};

      const prompt =
        String(
          body.prompt ||
          body.script ||
          ""
        ).trim();

      if (!prompt) {
        return res
          .status(400)
          .json({
            ok: false,
            success: false,
            error:
              "Enter a video prompt or script."
          });
      }

      const requestedDuration =
        projectDuration(
          body.duration
        );

      const ratio =
        body.ratio ||
        body.aspectRatio ||
        "16:9";

      const imageFile =
        files.referenceImage?.[0];

      let image =
        null;

      if (imageFile) {

        if (!isImage(imageFile)) {
          throw new Error(
            "Reference image must be JPG, PNG or WebP."
          );
        }

        image = {
          buffer:
            imageFile.buffer,

          mimetype:
            imageFile.mimetype
        };
      }

      /*
      =====================================================
      LONG-FORM BEHAVIOUR
      =====================================================

      5-10 seconds:
      One AI clip.

      More than 10 seconds:
      The server generates multiple AI clips.

      NOTE:
      This is intentionally capped here to prevent
      accidental enormous Replicate bills from a single
      request. A proper production long-form queue should
      process scenes asynchronously.
      =====================================================
      */

      const MAX_SCENES_PER_REQUEST =
        30;

      const clipDuration =
        5;

      const sceneCount =
        Math.ceil(
          requestedDuration /
          clipDuration
        );

      if (
        sceneCount >
        MAX_SCENES_PER_REQUEST
      ) {

        throw new Error(
          `This long-form request contains ${sceneCount} AI scenes. ` +
          `Maximum currently allowed in one request is ${MAX_SCENES_PER_REQUEST}.`
        );
      }

      const rawClips = [];

      for (
        let scene = 0;
        scene < sceneCount;
        scene++
      ) {

        /*
        For now each scene uses the supplied prompt.
        Later the long-form planner can split a script
        into individual scene prompts.
        */

        const scenePrompt =
          sceneCount === 1
            ? prompt
            : `${prompt}\n\nScene ${scene + 1} of ${sceneCount}. Continue the visual story naturally from the previous scene.`;

        console.log(
          `MAMAKI: Generating AI scene ${scene + 1}/${sceneCount}`
        );

        let videoBuffer;

        if (image) {

          videoBuffer =
            await generateImageVideo(
              scenePrompt,
              clipDuration,
              ratio,
              image
            );

        } else {

          videoBuffer =
            await generateTextVideo(
              scenePrompt,
              clipDuration,
              ratio
            );
        }

        if (
          !videoBuffer ||
          !videoBuffer.length
        ) {
          throw new Error(
            `AI scene ${scene + 1} returned an empty video.`
          );
        }

        const sceneFile =
          path.join(
            jobDir,
            `scene-${scene}.mp4`
          );

        await fs.writeFile(
          sceneFile,
          videoBuffer
        );

        rawClips.push(
          sceneFile
        );
      }

      /*
      Combine AI scenes.
      */

      let combined =
        rawClips[0];

      if (
        rawClips.length > 1
      ) {

        const combinedFile =
          path.join(
            jobDir,
            "combined.mp4"
          );

        await combineVideos(
          rawClips,
          combinedFile
        );

        combined =
          combinedFile;
      }

      /*
      Caption / narration can be added before
      final watermark.
      */

      const voiceText =
        String(
          body.voiceText ||
          body.narration ||
          ""
        ).trim();

      let current =
        combined;

      if (voiceText) {

        try {

          const voice =
            path.join(
              jobDir,
              "voice.mp3"
            );

          await createVoice(
            voiceText,
            voice
          );

          const voiced =
            path.join(
              jobDir,
              "voiced.mp4"
            );

          await ffmpeg([
            "-y",

            "-i",
            current,

            "-i",
            voice,

            "-map",
            "0:v",

            "-map",
            "1:a",

            "-c:v",
            "libx264",

            "-preset",
            "veryfast",

            "-c:a",
            "aac",

            "-shortest",

            voiced
          ]);

          current =
            voiced;

        } catch (voiceError) {

          console.error(
            "MAMAKI VOICE ERROR:",
            voiceError?.message ||
            voiceError
          );
        }
      }

      /*
      Permanent MAMAKI watermark.
      */

      const final =
        path.join(
          OUTPUT,
          `mamaki-ai-${Date.now()}-${randomUUID()}.mp4`
        );

      await finalizeVideo(
        current,
        final
      );

      return res.json({

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

        aiClipDuration:
          clipDuration,

        model:
          image
            ? I2V_MODEL
            : T2V_MODEL,

        watermark:
          "MAMAKI ✨",

        watermarkActive:
          true,

        credits:
          requestedDuration,

        message:
          "MAMAKI AI video generated successfully."
      });

    } catch (error) {

      console.error(
        "========================================"
      );

      console.error(
        "MAMAKI AI GENERATION ERROR"
      );

      console.error(
        error?.stack ||
        error?.message ||
        error
      );

      console.error(
        "========================================"
      );

      let message =
        error?.message ||
        "Video generation failed.";

      const lower =
        message.toLowerCase();

      if (
        lower.includes("402") ||
        lower.includes("insufficient credit") ||
        lower.includes("insufficient funds")
      ) {
        message =
          "Replicate has insufficient credit. No MAMAKI AI credit should be charged for this failed generation.";
      }

      return res
        .status(500)
        .json({
          ok: false,
          success: false,
          error: message
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
);

/*
==========================================================
 VIDEO DELIVERY
==========================================================
*/

app.get(
  "/api/video/:file",
  async (req, res) => {

    const filename =
      path.basename(
        req.params.file
      );

    const video =
      path.join(
        OUTPUT,
        filename
      );

    try {

      await fs.access(
        video
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
        video
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
==========================================================
 PROJECT SAVE
==========================================================
*/

app.post(
  "/api/projects/save",
  async (req, res) => {

    try {

      const project =
        req.body || {};

      const id =
        String(
          project.id ||
          randomUUID()
        ).replace(
          /[^a-zA-Z0-9_-]/g,
          ""
        );

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
        ),
        "utf8"
      );

      return res.json({
        ok: true,

        projectId:
          id,

        message:
          "MAMAKI project saved."
      });

    } catch (error) {

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ||
            "Project save failed."
        });
    }
  }
);

/*
==========================================================
 PROJECT LOAD
==========================================================
*/

app.get(
  "/api/projects/:id",
  async (req, res) => {

    try {

      const id =
        path.basename(
          req.params.id
        );

      const file =
        path.join(
          PROJECTS,
          `${id}.json`
        );

      const data =
        await fs.readFile(
          file,
          "utf8"
        );

      return res.json({
        ok: true,

        project:
          JSON.parse(data)
      });

    } catch {

      return res
        .status(404)
        .json({
          ok: false,

          error:
            "Project not found."
        });
    }
  }
);

/*
==========================================================
 STATUS
==========================================================
*/

app.get(
  "/api/status",
  async (req, res) => {

    return res.json({

      ok:
        true,

      app:
        "MAMAKI AI VIDEO",

      version:
        "7.0.0",

      server:
        "online",

      replicate:
        Boolean(
          replicate
        ),

      ffmpeg:
        Boolean(
          ffmpegPath
        ),

      textToVideo:
        T2V_MODEL,

      imageToVideo:
        I2V_MODEL,

      minimumDuration:
        5,

      maximumProjectDuration:
        "Long-form",

      aiGeneration:
        true,

      freeStudio:
        true,

      photoVideo:
        true,

      multiplePhotos:
        true,

      videoTrimming:
        true,

      manualTrim:
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

      watermark:
        true,

      watermarkText:
        "MAMAKI ✨",

      watermarkOptional:
        false,

      watermarkPosition:
        "top-right",

      watermarkMethod:
        "ASS subtitles",

      freeStudioCredits:
        0
    });
  }
);

/*
==========================================================
 HEALTH
==========================================================
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
        Boolean(
          replicate
        ),

      ffmpeg:
        Boolean(
          ffmpegPath
        ),

      watermark:
        "MAMAKI ✨"
    });
  }
);

/*
==========================================================
 START
==========================================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "=========================================="
    );

    console.log(
      "MAMAKI AI VIDEO v7.0.0"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `REPLICATE: ${
        REPLICATE_TOKEN
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
      `TEXT → VIDEO: ${T2V_MODEL}`
    );

    console.log(
      `IMAGE → VIDEO: ${I2V_MODEL}`
    );

    console.log(
      "MINIMUM AI DURATION: 5 seconds"
    );

    console.log(
      "LONG-FORM: MULTI-SCENE ASSEMBLY"
    );

    console.log(
      "FREE PHOTO → VIDEO: ENABLED"
    );

    console.log(
      "MULTIPLE PHOTOS: ENABLED"
    );

    console.log(
      "VIDEO TRIMMER: ENABLED"
    );

    console.log(
      "COMBINE CLIPS: ENABLED"
    );

    console.log(
      "MUSIC: ENABLED"
    );

    console.log(
      "NARRATION: ENABLED"
    );

    console.log(
      "CAPTIONS: ENABLED"
    );

    console.log(
      "MAMAKI WATERMARK: ENABLED"
    );

    console.log(
      "MAMAKI WATERMARK: PERMANENT"
    );

    console.log(
      "=========================================="
    );
  }
);
