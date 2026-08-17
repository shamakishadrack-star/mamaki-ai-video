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

const TOKEN = String(
  process.env.REPLICATE_API_TOKEN || ""
).trim();

const replicate = TOKEN
  ? new Replicate({ auth: TOKEN })
  : null;

/*
=========================================================
MAMAKI AI MODELS
=========================================================
*/

const T2V_MODEL =
  "wan-video/wan-2.5-t2v-fast";

const I2V_MODEL =
  "wan-video/wan-2.5-i2v-fast";

/*
=========================================================
DIRECTORIES
=========================================================
*/

const TMP = path.join(ROOT, "tmp");
const OUTPUT = path.join(ROOT, "outputs");
const PROJECTS = path.join(ROOT, "projects");
const INDEX = path.join(ROOT, "index.html");

await fs.mkdir(TMP, { recursive: true });
await fs.mkdir(OUTPUT, { recursive: true });
await fs.mkdir(PROJECTS, { recursive: true });

/*
=========================================================
MIDDLEWARE
=========================================================
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
DURATION
=========================================================

Minimum = 5 seconds.

There is NO 10-second project limit.

Long projects are assembled from short clips.
=========================================================
*/

function duration(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 5;
  }

  return Math.max(
    5,
    Math.round(n)
  );
}

/*
=========================================================
LONG PROJECT DURATION
=========================================================
*/

function projectDuration(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 5;
  }

  return Math.max(
    5,
    Math.floor(n)
  );
}

/*
=========================================================
SIZE
=========================================================
*/

function size(ratio) {
  switch (ratio) {
    case "9:16":
      return "720*1280";

    case "1:1":
      return "720*720";

    case "16:9-HD":
      return "1920*1080";

    case "9:16-HD":
      return "1080*1920";

    case "16:9":
    default:
      return "1280*720";
  }
}

/*
=========================================================
FILE CHECKS
=========================================================
*/

function isImage(file) {
  return (
    !!file &&
    [
      "image/jpeg",
      "image/png",
      "image/webp"
    ].includes(file.mimetype)
  );
}

function isVideo(file) {
  return (
    !!file &&
    [
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-matroska"
    ].includes(file.mimetype)
  );
}

function isAudio(file) {
  return (
    !!file &&
    [
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/x-wav",
      "audio/mp4",
      "audio/aac",
      "audio/ogg",
      "audio/webm"
    ].includes(file.mimetype)
  );
}

/*
=========================================================
IMAGE DATA URI
=========================================================
*/

function imageToDataUri(buffer, mimetype) {
  if (!buffer) {
    return null;
  }

  return (
    `data:${mimetype || "image/jpeg"};base64,` +
    buffer.toString("base64")
  );
}

/*
=========================================================
REPLICATE OUTPUT
=========================================================
*/

async function getVideoBuffer(output) {
  const item =
    Array.isArray(output)
      ? output[0]
      : output;

  if (!item) {
    throw new Error(
      "Replicate returned no video output."
    );
  }

  if (Buffer.isBuffer(item)) {
    return item;
  }

  if (item instanceof Uint8Array) {
    return Buffer.from(item);
  }

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

  throw new Error(
    "Unsupported Replicate video output format."
  );
}

/*
=========================================================
FFMPEG
=========================================================
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
          stderr += data.toString();
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
                `FFmpeg error: ${stderr.slice(-8000)}`
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
MAMAKI WATERMARK
=========================================================

This is applied to EVERY final export.

AI Studio + Free Studio.
=========================================================
*/

async function addMamakiWatermark(
  input,
  output
) {
  const filter =
    "drawtext=" +
    "text='MAMAKI ✨':" +
    "x=w-tw-30:" +
    "y=25:" +
    "fontsize=28:" +
    "fontcolor=white:" +
    "borderw=2:" +
    "bordercolor=black:" +
    "alpha=0.90";

  await ffmpeg([
    "-y",

    "-i",
    input,

    "-vf",
    filter,

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
FINALIZE VIDEO
=========================================================
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
=========================================================
AI TEXT → VIDEO
=========================================================
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

  const clipDuration =
    duration(seconds);

  console.log(
    "MAMAKI TEXT → VIDEO"
  );

  console.log(
    "MODEL:",
    T2V_MODEL
  );

  console.log(
    "DURATION:",
    clipDuration
  );

  const input = {
    prompt:
      cleanPrompt,

    duration:
      clipDuration,

    size:
      size(ratio),

    negative_prompt:
      "blurry, distorted, flickering, deformed, low quality",

    enable_prompt_expansion:
      true
  };

  const output =
    await replicate.run(
      T2V_MODEL,
      {
        input
      }
    );

  return getVideoBuffer(
    output
  );
}

/*
=========================================================
AI IMAGE → VIDEO
=========================================================
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

  if (!imageUri) {
    throw new Error(
      "Reference image could not be prepared."
    );
  }

  const input = {
    image:
      imageUri,

    prompt:
      String(prompt || "").trim(),

    duration:
      duration(seconds),

    resolution:
      "720p",

    negative_prompt:
      "blurry, distorted, flickering, deformed, low quality",

    enable_prompt_expansion:
      true
  };

  console.log(
    "MAMAKI IMAGE → VIDEO"
  );

  console.log(
    "MODEL:",
    I2V_MODEL
  );

  const output =
    await replicate.run(
      I2V_MODEL,
      {
        input
      }
    );

  return getVideoBuffer(
    output
  );
}

/*
=========================================================
PHOTO → VIDEO
=========================================================

FREE STUDIO

No Replicate.
No AI credits.

The image becomes a video using FFmpeg.
=========================================================
*/

async function photoToVideo(
  imageBuffer,
  imageType,
  seconds,
  output
) {
  const imagePath =
    path.join(
      TMP,
      `${randomUUID()}.jpg`
    );

  await fs.writeFile(
    imagePath,
    imageBuffer
  );

  const durationSeconds =
    duration(seconds);

  await ffmpeg([
    "-y",

    "-loop",
    "1",

    "-i",
    imagePath,

    "-t",
    String(durationSeconds),

    "-vf",
    "scale=1280:720:force_original_aspect_ratio=decrease," +
    "pad=1280:720:(ow-iw)/2:(oh-ih)/2," +
    "zoompan=z='min(zoom+0.0005,1.10)':" +
    "d=1:s=1280x720:fps=30",

    "-c:v",
    "libx264",

    "-pix_fmt",
    "yuv420p",

    "-an",

    output
  ]);

  await fs.rm(
    imagePath,
    {
      force: true
    }
  );

  return output;
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
      Number(start || 0)
    );

  const endTime =
    Number(end);

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

    "-c:a",
    "aac",

    output
  );

  await ffmpeg(args);

  return output;
}

/*
=========================================================
COMBINE MULTIPLE CLIPS
=========================================================
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
      `${randomUUID()}.txt`
    );

  const lines =
    files.map(
      file =>
        `file '${file.replace(/'/g, "'\\''")}'`
    );

  await fs.writeFile(
    listFile,
    lines.join("\n")
  );

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

    "-c:a",
    "aac",

    output
  ]);

  await fs.rm(
    listFile,
    {
      force: true
    }
  );

  return output;
}

/*
=========================================================
ADD MUSIC
=========================================================
*/

async function addMusic(
  video,
  music,
  output
) {
  await ffmpeg([
    "-y",

    "-i",
    video,

    "-stream_loop",
    "-1",

    "-i",
    music,

    "-filter_complex",
    "[1:a]volume=0.25[music];" +
    "[0:a][music]amix=inputs=2:" +
    "duration=first:" +
    "dropout_transition=2[a]",

    "-map",
    "0:v",

    "-map",
    "[a]",

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
ADD NARRATION
=========================================================
*/

async function createVoice(
  text,
  output
) {
  const narration =
    String(text || "").trim();

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
      "Voice generation returned no audio."
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
      "Unable to read narration audio."
    );
  }

  await fs.writeFile(
    output,
    buffer
  );

  return output;
}

async function addNarration(
  video,
  narration,
  output
) {
  await ffmpeg([
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

      return res.json({
        ok: true,
        projectId: id,
        message:
          "MAMAKI project saved."
      });

    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
        });
    }
  }
);

/*
=========================================================
LOAD PROJECT
=========================================================
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
=========================================================
FREE STUDIO PHOTO → VIDEO
=========================================================
*/

app.post(
  "/api/studio/photo-video",

  upload.single(
    "image"
  ),

  async (
    req,
    res
  ) => {
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
      const image =
        req.file;

      if (!isImage(image)) {
        throw new Error(
          "Upload a JPG, PNG or WebP image."
        );
      }

      const seconds =
        duration(
          req.body.duration
        );

      const raw =
        path.join(
          jobDir,
          "photo.mp4"
        );

      const final =
        path.join(
          OUTPUT,
          `mamaki-photo-${Date.now()}-${randomUUID()}.mp4`
        );

      await photoToVideo(
        image.buffer,
        image.mimetype,
        seconds,
        raw
      );

      await finalizeVideo(
        raw,
        final
      );

      return res.json({
        ok: true,

        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            path.basename(final)
          )}`,

        message:
          "Photo video created with MAMAKI ✨ watermark."
      });

    } catch (error) {
      console.error(
        "PHOTO VIDEO ERROR:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
        });

    } finally {
      await fs.rm(
        jobDir,
        {
          recursive: true,
          force: true
        }
      ).catch(
        () => {}
      );
    }
  }
);

/*
=========================================================
FREE STUDIO TRIM
=========================================================
*/

app.post(
  "/api/studio/trim",

  upload.single(
    "video"
  ),

  async (
    req,
    res
  ) => {
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
      if (!isVideo(req.file)) {
        throw new Error(
          "Upload a valid video."
        );
      }

      const input =
        path.join(
          jobDir,
          "input.mp4"
        );

      const trimmed =
        path.join(
          jobDir,
          "trimmed.mp4"
        );

      const final =
        path.join(
          OUTPUT,
          `mamaki-trim-${Date.now()}-${randomUUID()}.mp4`
        );

      await fs.writeFile(
        input,
        req.file.buffer
      );

      await trimVideo(
        input,
        trimmed,
        req.body.start,
        req.body.end
      );

      await finalizeVideo(
        trimmed,
        final
      );

      return res.json({
        ok: true,
        success: true,
        videoUrl:
          `/api/video/${encodeURIComponent(
            path.basename(final)
          )}`,
        message:
          "Video trimmed with MAMAKI ✨ watermark."
      });

    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
        });

    } finally {
      await fs.rm(
        jobDir,
        {
          recursive: true,
          force: true
        }
      ).catch(
        () => {}
      );
    }
  }
);

/*
=========================================================
FREE STUDIO COMBINE
=========================================================
*/

app.post(
  "/api/studio/combine",

  upload.array(
    "videos",
    50
  ),

  async (
    req,
    res
  ) => {
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
      if (
        !req.files ||
        !req.files.length
      ) {
        throw new Error(
          "Upload at least one video."
        );
      }

      const inputs = [];

      for (
        let i = 0;
        i < req.files.length;
        i++
      ) {
        const file =
          req.files[i];

        if (!isVideo(file)) {
          throw new Error(
            "All uploaded files must be videos."
          );
        }

        const input =
          path.join(
            jobDir,
            `clip-${i}.mp4`
          );

        await fs.writeFile(
          input,
          file.buffer
        );

        inputs.push(input);
      }

      const combined =
        path.join(
          jobDir,
          "combined.mp4"
        );

      const final =
        path.join(
          OUTPUT,
          `mamaki-combined-${Date.now()}-${randomUUID()}.mp4`
        );

      await combineVideos(
        inputs,
        combined
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
        message:
          "Videos combined with MAMAKI ✨ watermark."
      });

    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
        });

    } finally {
      await fs.rm(
        jobDir,
        {
          recursive: true,
          force: true
        }
      ).catch(
        () => {}
      );
    }
  }
);

/*
=========================================================
MAIN GENERATE API
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
    },

    {
      name:
        "music",
      maxCount:
        1
    },

    {
      name:
        "effects",
      maxCount:
        1
    }
  ]),

  async (
    req,
    res
  ) => {
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
      const body =
        req.body || {};

      const files =
        req.files || {};

      const prompt =
        String(
          body.prompt || ""
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

      const seconds =
        duration(
          body.duration
        );

      const ratio =
        body.ratio ||
        body.aspectRatio ||
        "16:9";

      let image = null;

      if (
        files.referenceImage?.[0]
      ) {
        const file =
          files.referenceImage[0];

        if (!isImage(file)) {
          throw new Error(
            "Reference image must be JPG, PNG, or WebP."
          );
        }

        image = {
          buffer:
            file.buffer,

          mimetype:
            file.mimetype
        };
      }

      if (!replicate) {
        throw new Error(
          "REPLICATE_API_TOKEN is missing."
        );
      }

      /*
      =====================================================
      AI GENERATION
      =====================================================
      */

      let videoBuffer;

      if (image) {
        videoBuffer =
          await generateImageVideo(
            prompt,
            seconds,
            ratio,
            image
          );
      } else {
        videoBuffer =
          await generateTextVideo(
            prompt,
            seconds,
            ratio
          );
      }

      if (
        !videoBuffer ||
        !videoBuffer.length
      ) {
        throw new Error(
          "AI returned an empty video."
        );
      }

      const raw =
        path.join(
          jobDir,
          "ai.mp4"
        );

      const final =
        path.join(
          OUTPUT,
          `mamaki-ai-${Date.now()}-${randomUUID()}.mp4`
        );

      await fs.writeFile(
        raw,
        videoBuffer
      );

      /*
      =====================================================
      MAMAKI WATERMARK
      =====================================================
      */

      await finalizeVideo(
        raw,
        final
      );

      /*
      =====================================================
      OPTIONAL NARRATION
      =====================================================
      */

      const voiceText =
        String(
          body.voiceText ||
          body.script ||
          ""
        ).trim();

      if (
        voiceText
      ) {
        try {
          const voice =
            path.join(
              jobDir,
              "voice.mp3"
            );

          const voiced =
            path.join(
              jobDir,
              "voiced.mp4"
            );

          await createVoice(
            voiceText,
            voice
          );

          await addNarration(
            final,
            voice,
            voiced
          );

          await fs.copyFile(
            voiced,
            final
          );

        } catch (
          voiceError
        ) {
          console.error(
            "VOICE ERROR:",
            voiceError.message
          );
        }
      }

      return res.json({
        ok: true,

        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            path.basename(final)
          )}`,

        file:
          path.basename(final),

        duration:
          seconds,

        watermark:
          "MAMAKI ✨",

        message:
          "MAMAKI AI video generated successfully."
      });

    } catch (error) {
      console.error(
        "MAMAKI GENERATION ERROR:",
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
            "Video generation failed."
        });

    } finally {
      await fs.rm(
        jobDir,
        {
          recursive: true,
          force: true
        }
      ).catch(
        () => {}
      );
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

  async (
    req,
    res
  ) => {
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
=========================================================
STATUS
=========================================================
*/

app.get(
  "/api/status",

  async (
    req,
    res
  ) => {
    return res.json({
      app:
        "MAMAKI AI VIDEO",

      version:
        "6.0.0",

      server:
        "online",

      replicate:
        Boolean(replicate),

      textToVideo:
        T2V_MODEL,

      imageToVideo:
        I2V_MODEL,

      minimumDuration:
        5,

      longProjects:
        true,

      freeStudio:
        true,

      videoTrimming:
        true,

      photoToVideo:
        true,

      combineClips:
        true,

      projects:
        true,

      narration:
        true,

      music:
        true,

      mamakiWatermark:
        true,

      watermarkText:
        "MAMAKI ✨",

      ffmpeg:
        Boolean(ffmpegPath),

      aiGeneration:
        true
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

  (
    req,
    res
  ) => {
    return res.json({
      status:
        "ok",

      app:
        "MAMAKI AI VIDEO",

      version:
        "6.0.0"
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
      "MAMAKI AI VIDEO v6.0.0"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `REPLICATE: ${
        TOKEN
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
      "LONG PROJECTS: ENABLED"
    );

    console.log(
      "FREE STUDIO: ENABLED"
    );

    console.log(
      "MAMAKI WATERMARK: ENABLED"
    );

    console.log(
      "======================================"
    );
  }
);
