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
VERSION 10.0
=========================================================

TEXT → VIDEO
IMAGE → VIDEO

FREE STUDIO
PHOTO → VIDEO + MUSIC
VIDEO TRIMMER
COMBINE VIDEOS
MUTE VIDEO
ADD MUSIC

AI TOOLS
PROMPT ENHANCER
STYLE PRESETS
AI NARRATION

PROJECTS
GENERATION JOBS
VIDEO LIBRARY

WATERMARK
MAMAKI - REQUIRED

LONG DURATION
5 seconds → 2 hours
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

const INDEX =
  path.join(ROOT, "index.html");

await fs.mkdir(TMP, { recursive: true });
await fs.mkdir(OUTPUT, { recursive: true });
await fs.mkdir(PROJECTS, { recursive: true });

/*
=========================================================
BODY
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

/*
=========================================================
FRONTEND
=========================================================
*/

app.get("/", (req, res) => {
  res.sendFile(
    path.join(process.cwd(), "index.html")
  );
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
JOBS
=========================================================
*/

const jobs = new Map();

/*
=========================================================
HELPERS
=========================================================
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

function normalizeRatio(value) {
  if (value === "9:16") {
    return "9:16";
  }

  if (value === "1:1") {
    return "1:1";
  }

  return "16:9";
}

function normalizeDuration(value) {
  return clamp(
    Math.round(
      safeNumber(value, 5)
    ),
    5,
    7200
  );
}

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

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

/*
=========================================================
PROMPT ENHANCER
=========================================================
*/

function enhancePrompt(
  prompt,
  style = "Cinematic"
) {
  const clean =
    String(prompt || "").trim();

  if (!clean) {
    return "";
  }

  const styleMap = {
    Cinematic:
      "cinematic filmmaking, professional camera movement, realistic lighting, natural motion, detailed environment, depth of field, high visual quality",

    Realistic:
      "photorealistic, physically accurate movement, natural lighting, realistic textures, realistic human motion",

    Documentary:
      "documentary filmmaking style, authentic environment, natural camera movement, realistic lighting, observational cinematography",

    Commercial:
      "premium commercial advertisement, polished cinematography, studio-quality lighting, elegant camera movement, highly detailed product presentation",

    "3D Animation":
      "high-quality 3D animation, detailed models, smooth animation, cinematic lighting, polished rendering",

    Anime:
      "high-quality anime visual style, expressive characters, dynamic camera movement, detailed anime environment",

    Fantasy:
      "cinematic fantasy world, magical atmosphere, dramatic lighting, detailed environment, epic visual composition",

    "Sci-Fi":
      "cinematic science-fiction environment, futuristic technology, atmospheric lighting, detailed production design",

    Horror:
      "cinematic horror atmosphere, dramatic shadows, suspenseful camera movement, realistic environment",

    Cartoon:
      "high-quality animated cartoon style, expressive movement, colorful environment, smooth animation"
  };

  return `${clean}. ${styleMap[style] || styleMap.Cinematic}. Smooth coherent motion, consistent subjects, professional composition.`;
}

/*
=========================================================
REPLICATE OUTPUT
=========================================================
*/

async function replicateOutputToBuffer(output) {
  if (!output) {
    throw new Error(
      "MAMAKI did not receive a video file."
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
    return Buffer.from(output);
  }

  if (
    typeof output === "string" &&
    /^https?:\/\//i.test(output)
  ) {
    const response =
      await fetch(output);

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
    typeof output.url === "function"
  ) {
    const url =
      await output.url();

    const response =
      await fetch(url);

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
    typeof output.url === "string"
  ) {
    const response =
      await fetch(output.url);

    if (!response.ok) {
      throw new Error(
        `Video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  if (Array.isArray(output)) {
    if (!output.length) {
      throw new Error(
        "MAMAKI did not receive a video file."
      );
    }

    return replicateOutputToBuffer(
      output[0]
    );
  }

  if (
    output &&
    typeof output.getReader === "function"
  ) {
    const reader =
      output.getReader();

    const chunks = [];

    while (true) {
      const {
        done,
        value
      } = await reader.read();

      if (done) {
        break;
      }

      if (value) {
        chunks.push(
          Buffer.from(value)
        );
      }
    }

    return Buffer.concat(chunks);
  }

  throw new Error(
    "MAMAKI did not receive a usable video file."
  );
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

async function addMamakiWatermark(
  input,
  output
) {
  /*
   * Watermark is mandatory.
   *
   * Do NOT silently copy the original
   * if watermarking fails.
   */

  await runFFmpeg([
    "-y",

    "-i",
    input,

    "-vf",
    "drawtext=text='MAMAKI':font='DejaVu Sans':fontcolor=white@0.92:fontsize=30:borderw=3:bordercolor=black@0.75:box=1:boxcolor=black@0.28:boxborderw=10:x=w-tw-28:y=h-th-28",

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

  const stats =
    await fs.stat(output);

  if (!stats.size) {
    throw new Error(
      "MAMAKI watermark process created an empty file."
    );
  }

  return output;
}

/*
=========================================================
TEXT → VIDEO
=========================================================
*/

async function generateTextVideo(
  prompt,
  ratio
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

    lora_scale_transformer: 1,

    lora_scale_transformer_2: 1
  };

  console.log(
    "MAMAKI T2V INPUT:",
    JSON.stringify(input)
  );

  const output =
    await replicate.run(
      T2V_MODEL,
      {
        input
      }
    );

  return replicateOutputToBuffer(
    output
  );
}

/*
=========================================================
IMAGE → VIDEO
=========================================================
*/

async function generateImageVideo(
  prompt,
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

  console.log(
    "MAMAKI I2V INPUT:",
    {
      prompt: input.prompt,
      filename: image.originalname,
      type: image.mimetype,
      size: image.size
    }
  );

  const output =
    await replicate.run(
      I2V_MODEL,
      {
        input
      }
    );

  return replicateOutputToBuffer(
    output
  );
}

/*
=========================================================
SCENES
=========================================================
*/

function splitScenes(
  prompt,
  seconds
) {
  const clean =
    String(prompt || "").trim();

  const count =
    Math.max(
      1,
      Math.ceil(seconds / 5)
    );

  const sentences =
    clean
      .split(
        /(?<=[.!?])\s+/
      )
      .map(
        x => x.trim()
      )
      .filter(Boolean);

  const scenes = [];

  for (
    let i = 0;
    i < count;
    i++
  ) {
    const base =
      sentences.length
        ? sentences[
            i % sentences.length
          ]
        : clean;

    scenes.push(
      `${base}. Cinematic continuation, coherent subject, smooth natural movement, consistent lighting, professional camera motion.`
    );
  }

  return scenes;
}

/*
=========================================================
COMBINE
=========================================================
*/

async function combineVideos(
  files,
  output
) {
  if (!files.length) {
    throw new Error(
      "No video clips supplied."
    );
  }

  if (files.length === 1) {
    await fs.copyFile(
      files[0],
      output
    );

    return output;
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
WITH MUSIC
=========================================================
*/

async function createPhotoVideo(
  images,
  seconds,
  output,
  ratio,
  music
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

    const perImage =
      clamp(
        safeNumber(
          seconds,
          3
        ),
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
        String(perImage),

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

      clips.push(
        clipFile
      );
    }

    const raw =
      path.join(
        job,
        "photos.mp4"
      );

    await combineVideos(
      clips,
      raw
    );

    /*
     * Optional music.
     */

    if (
      music &&
      isAudio(music)
    ) {
      const musicFile =
        path.join(
          job,
          "music"
        );

      const mixed =
        path.join(
          job,
          "photos-music.mp4"
        );

      await fs.writeFile(
        musicFile,
        music.buffer
      );

      await runFFmpeg([
        "-y",

        "-i",
        raw,

        "-stream_loop",
        "-1",

        "-i",
        musicFile,

        "-filter_complex",
        "[1:a]volume=0.55[music]",

        "-map",
        "0:v:0",

        "-map",
        "[music]",

        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-crf",
        "23",

        "-c:a",
        "aac",

        "-shortest",

        "-movflags",
        "+faststart",

        mixed
      ]);

      return mixed;
    }

    return raw;
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
      safeNumber(
        start,
        0
      )
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
ADD MUSIC TO EXISTING VIDEO
=========================================================
*/

async function addMusicToVideo(
  video,
  music,
  output,
  volume = 0.5
) {
  const v =
    clamp(
      safeNumber(
        volume,
        0.5
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
    `[1:a]volume=${v}[music]`,

    "-map",
    "0:v:0",

    "-map",
    "[music]",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-crf",
    "23",

    "-c:a",
    "aac",

    "-shortest",

    "-movflags",
    "+faststart",

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
  output,
  voice
) {
  const clean =
    String(text || "").trim();

  if (!clean) {
    throw new Error(
      "Narration text is empty."
    );
  }

  const selectedVoice =
    voice ||
    "en-US-EmmaMultilingualNeural";

  const tts =
    new EdgeTTS(
      clean,
      selectedVoice
    );

  const result =
    await tts.synthesize();

  const buffer =
    Buffer.from(
      await result.audio.arrayBuffer()
    );

  await fs.writeFile(
    output,
    buffer
  );

  return output;
}

/*
=========================================================
SAVE PROJECT
=========================================================
*/

async function saveProject(
  project
) {
  const id =
    project.id ||
    randomUUID();

  const file =
    path.join(
      PROJECTS,
      `${id}.json`
    );

  const data = {
    ...project,
    id,
    updatedAt:
      new Date().toISOString()
  };

  await fs.writeFile(
    file,
    JSON.stringify(
      data,
      null,
      2
    ),
    "utf8"
  );

  return data;
}

/*
=========================================================
LIST PROJECTS
=========================================================
*/

app.get(
  "/api/projects",
  async (req, res) => {
    try {
      const files =
        await fs.readdir(
          PROJECTS
        );

      const projects = [];

      for (const filename of files) {
        if (!filename.endsWith(".json")) {
          continue;
        }

        try {
          const text =
            await fs.readFile(
              path.join(
                PROJECTS,
                filename
              ),
              "utf8"
            );

          projects.push(
            JSON.parse(text)
          );
        } catch {}
      }

      projects.sort(
        (a, b) =>
          String(
            b.updatedAt || ""
          ).localeCompare(
            String(
              a.updatedAt || ""
            )
          )
      );

      res.json({
        ok: true,
        projects
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
SAVE PROJECT API
=========================================================
*/

app.post(
  "/api/projects/save",
  async (req, res) => {
    try {
      const project =
        await saveProject(
          req.body || {}
        );

      res.json({
        ok: true,
        project
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
ASYNC AI GENERATION
=========================================================
*/

async function processGenerationJob(
  jobId,
  options
) {
  const job =
    jobs.get(jobId);

  if (!job) {
    return;
  }

  let jobDir = null;

  try {
    job.status =
      "processing";

    job.message =
      "Preparing your AI video...";

    const {
      prompt,
      duration,
      ratio,
      image,
      style
    } = options;

    const enhanced =
      enhancePrompt(
        prompt,
        style
      );

    const sceneCount =
      Math.ceil(
        duration / 5
      );

    const scenes =
      splitScenes(
        enhanced,
        duration
      );

    job.total =
      sceneCount;

    job.current =
      0;

    job.message =
      `Generating scene 1 of ${sceneCount}...`;

    jobDir =
      path.join(
        TMP,
        jobId
      );

    await fs.mkdir(
      jobDir,
      {
        recursive: true
      }
    );

    const clips = [];

    for (
      let i = 0;
      i < sceneCount;
      i++
    ) {
      job.current =
        i + 1;

      job.message =
        `Generating scene ${i + 1} of ${sceneCount}...`;

      console.log(
        `MAMAKI: scene ${i + 1}/${sceneCount}`
      );

      const scenePrompt =
        scenes[i] ||
        `${enhanced}. Cinematic continuation.`;

      let videoBuffer;

      if (
        image &&
        i === 0
      ) {
        videoBuffer =
          await generateImageVideo(
            scenePrompt,
            image
          );
      } else {
        videoBuffer =
          await generateTextVideo(
            scenePrompt,
            ratio
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

      const clip =
        path.join(
          jobDir,
          `scene-${i}.mp4`
        );

      await fs.writeFile(
        clip,
        videoBuffer
      );

      clips.push(
        clip
      );
    }

    job.message =
      "Combining scenes...";

    const combined =
      path.join(
        jobDir,
        "combined.mp4"
      );

    await combineVideos(
      clips,
      combined
    );

    job.message =
      "Applying MAMAKI watermark...";

    const finalName =
      `mamaki-${Date.now()}-${randomUUID()}.mp4`;

    const final =
      path.join(
        OUTPUT,
        finalName
      );

    /*
     * This MUST succeed.
     * We no longer silently remove
     * the watermark if FFmpeg fails.
     */

    await addMamakiWatermark(
      combined,
      final
    );

    const stats =
      await fs.stat(final);

    if (!stats.size) {
      throw new Error(
        "Final MAMAKI video is empty."
      );
    }

    const project =
      await saveProject({
        name:
          prompt
            .slice(0, 60) ||
          "Untitled Project",

        type:
          image
            ? "Image to Video"
            : "Text to Video",

        prompt,

        enhancedPrompt:
          enhanced,

        duration,

        ratio,

        style,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        file:
          finalName,

        watermark:
          "MAMAKI",

        createdAt:
          new Date().toISOString()
      });

    job.status =
      "completed";

    job.progress =
      100;

    job.current =
      sceneCount;

    job.videoUrl =
      project.videoUrl;

    job.projectId =
      project.id;

    job.message =
      "MAMAKI video generated successfully.";

    console.log(
      "MAMAKI COMPLETE:",
      final
    );
  } catch (error) {
    console.error(
      "MAMAKI GENERATION ERROR:",
      error?.stack ||
      error?.message ||
      error
    );

    job.status =
      "failed";

    job.message =
      error?.message ||
      "Video generation failed.";
  } finally {
    if (jobDir) {
      await fs.rm(
        jobDir,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});
    }
  }
}

/*
=========================================================
GENERATE ENDPOINT
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
        return res.status(500).json({
          ok: false,
          error:
            "REPLICATE_API_TOKEN is missing."
        });
      }

      const prompt =
        String(
          req.body.prompt || ""
        ).trim();

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error:
            "Enter a video prompt."
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

      const style =
        String(
          req.body.style ||
          "Cinematic"
        );

      const image =
        req.files
          ?.referenceImage
          ?.[0] || null;

      if (
        image &&
        !isImage(image)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Reference image must be JPG, PNG or WebP."
        });
      }

      const jobId =
        randomUUID();

      jobs.set(
        jobId,
        {
          id: jobId,

          status:
            "queued",

          progress:
            0,

          current:
            0,

          total:
            Math.ceil(
              duration / 5
            ),

          message:
            "Generation queued...",

          createdAt:
            Date.now()
        }
      );

      /*
       * Keep uploaded image in memory
       * while the background job runs.
       */

      const imageCopy =
        image
          ? {
              buffer:
                Buffer.from(
                  image.buffer
                ),

              originalname:
                image.originalname,

              mimetype:
                image.mimetype,

              size:
                image.size
            }
          : null;

      void processGenerationJob(
        jobId,
        {
          prompt,
          duration,
          ratio,
          style,
          image:
            imageCopy
        }
      );

      return res.status(202).json({
        ok: true,

        jobId,

        status:
          "queued",

        message:
          "MAMAKI generation started."
      });
    } catch (error) {
      console.error(
        "GENERATE REQUEST ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/*
=========================================================
JOB STATUS
=========================================================
*/

app.get(
  "/api/generate/:jobId",
  (req, res) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).json({
        ok: false,
        error:
          "Generation job not found. The server may have restarted."
      });
    }

    const progress =
      job.total
        ? Math.round(
            (job.current /
              job.total) *
              100
          )
        : job.status ===
          "completed"
        ? 100
        : 0;

    return res.json({
      ok: true,

      jobId:
        job.id,

      status:
        job.status,

      progress,

      current:
        job.current,

      total:
        job.total,

      message:
        job.message,

      videoUrl:
        job.videoUrl ||
        null,

      projectId:
        job.projectId ||
        null
    });
  }
);

/*
=========================================================
PHOTO → VIDEO
=========================================================
*/

app.post(
  "/api/studio/photo-video",

  upload.fields([
    {
      name:
        "images",
      maxCount:
        50
    },

    {
      name:
        "music",
      maxCount:
        1
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
      const images =
        req.files
          ?.images || [];

      const music =
        req.files
          ?.music
          ?.[0] || null;

      if (!images.length) {
        throw new Error(
          "Add at least one photo."
        );
      }

      if (
        music &&
        !isAudio(music)
      ) {
        throw new Error(
          "Music must be MP3, WAV, AAC, OGG or WebM audio."
        );
      }

      const raw =
        path.join(
          dir,
          "photo-video.mp4"
        );

      const finalName =
        `mamaki-photo-${Date.now()}-${randomUUID()}.mp4`;

      const final =
        path.join(
          OUTPUT,
          finalName
        );

      const source =
        await createPhotoVideo(
          images,
          req.body.duration,
          raw,
          req.body.ratio,
          music
        );

      await addMamakiWatermark(
        source,
        final
      );

      const project =
        await saveProject({
          name:
            "Photo Video",

          type:
            "Free Studio - Photo to Video",

          duration:
            safeNumber(
              req.body.duration,
              3
            ),

          ratio:
            normalizeRatio(
              req.body.ratio
            ),

          music:
            Boolean(music),

          videoUrl:
            `/api/video/${encodeURIComponent(
              finalName
            )}`,

          file:
            finalName,

          watermark:
            "MAMAKI"
        });

      res.json({
        ok: true,

        success: true,

        videoUrl:
          project.videoUrl,

        projectId:
          project.id,

        watermark:
          "MAMAKI"
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
TRIM
=========================================================
*/

app.post(
  "/api/studio/trim",

  upload.fields([
    {
      name:
        "video",
      maxCount:
        1
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
        req.files
          ?.video
          ?.[0];

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

      await addMamakiWatermark(
        trimmed,
        final
      );

      res.json({
        ok: true,

        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        watermark:
          "MAMAKI"
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

      await addMamakiWatermark(
        combined,
        final
      );

      res.json({
        ok: true,

        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        watermark:
          "MAMAKI"
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
MUTE
=========================================================
*/

app.post(
  "/api/studio/mute",

  upload.single(
    "video"
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
      if (!isVideo(req.file)) {
        throw new Error(
          "Upload a valid video."
        );
      }

      const input =
        path.join(
          dir,
          "input.mp4"
        );

      const muted =
        path.join(
          dir,
          "muted.mp4"
        );

      const finalName =
        `mamaki-muted-${Date.now()}-${randomUUID()}.mp4`;

      const final =
        path.join(
          OUTPUT,
          finalName
        );

      await fs.writeFile(
        input,
        req.file.buffer
      );

      await muteVideo(
        input,
        muted
      );

      await addMamakiWatermark(
        muted,
        final
      );

      res.json({
        ok: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        watermark:
          "MAMAKI"
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
ADD MUSIC
=========================================================
*/

app.post(
  "/api/studio/music",

  upload.fields([
    {
      name:
        "video",
      maxCount:
        1
    },

    {
      name:
        "music",
      maxCount:
        1
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
        req.files
          ?.video
          ?.[0];

      const music =
        req.files
          ?.music
          ?.[0];

      if (!isVideo(video)) {
        throw new Error(
          "Upload a valid video."
        );
      }

      if (!isAudio(music)) {
        throw new Error(
          "Upload a valid music file."
        );
      }

      const videoFile =
        path.join(
          dir,
          "video.mp4"
        );

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

      const finalName =
        `mamaki-music-${Date.now()}-${randomUUID()}.mp4`;

      const final =
        path.join(
          OUTPUT,
          finalName
        );

      await fs.writeFile(
        videoFile,
        video.buffer
      );

      await fs.writeFile(
        musicFile,
        music.buffer
      );

      await addMusicToVideo(
        videoFile,
        musicFile,
        mixed,
        req.body.volume
      );

      await addMamakiWatermark(
        mixed,
        final
      );

      res.json({
        ok: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        watermark:
          "MAMAKI"
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
NARRATION
=========================================================
*/

app.post(
  "/api/studio/narration",

  upload.single(
    "video"
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
      const video =
        req.file;

      if (!isVideo(video)) {
        throw new Error(
          "Upload a valid video."
        );
      }

      const videoFile =
        path.join(
          dir,
          "video.mp4"
        );

      const voiceFile =
        path.join(
          dir,
          "voice.mp3"
        );

      const finalFile =
        path.join(
          dir,
          "narrated.mp4"
        );

      const finalName =
        `mamaki-narration-${Date.now()}-${randomUUID()}.mp4`;

      const final =
        path.join(
          OUTPUT,
          finalName
        );

      await fs.writeFile(
        videoFile,
        video.buffer
      );

      await createNarration(
        req.body.text,
        voiceFile,
        req.body.voice
      );

      await runFFmpeg([
        "-y",

        "-i",
        videoFile,

        "-i",
        voiceFile,

        "-filter_complex",
        "[1:a]volume=1[narration]",

        "-map",
        "0:v:0",

        "-map",
        "[narration]",

        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-crf",
        "23",

        "-c:a",
        "aac",

        "-shortest",

        "-movflags",
        "+faststart",

        finalFile
      ]);

      await addMamakiWatermark(
        finalFile,
        final
      );

      res.json({
        ok: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        watermark:
          "MAMAKI"
      });
    } catch (error) {
      console.error(
        "NARRATION ERROR:",
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
AI PROMPT ENHANCER API
=========================================================
*/

app.post(
  "/api/ai/enhance",
  (req, res) => {
    try {
      const prompt =
        String(
          req.body.prompt || ""
        ).trim();

      const style =
        String(
          req.body.style ||
          "Cinematic"
        );

      const enhanced =
        enhancePrompt(
          prompt,
          style
        );

      res.json({
        ok: true,
        prompt: enhanced
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

      const stats =
        await fs.stat(
          file
        );

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
  (req, res) => {
    res.json({
      ok: true,

      app:
        "MAMAKI AI VIDEO",

      version:
        "10.0.0",

      server:
        "online",

      replicate:
        Boolean(
          REPLICATE_API_TOKEN
        ),

      ffmpeg:
        Boolean(
          ffmpegPath
        ),

      textToVideo:
        T2V_MODEL,

      imageToVideo:
        I2V_MODEL,

      freeStudio:
        true,

      photoToVideo:
        true,

      photoMusic:
        true,

      trimmer:
        true,

      combine:
        true,

      mute:
        true,

      music:
        true,

      narration:
        true,

      projects:
        true,

      promptEnhancer:
        true,

      watermark:
        "MAMAKI",

      watermarkRequired:
        true,

      maximumDurationSeconds:
        7200
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
        "10.0.0",

      replicate:
        Boolean(
          REPLICATE_API_TOKEN
        ),

      ffmpeg:
        Boolean(
          ffmpegPath
        )
    });
  }
);

/*
=========================================================
404 API
=========================================================
*/

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        "MAMAKI API route not found."
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

/*
=========================================================
START
=========================================================
*/

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        "=========================================="
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
        "PHOTO + MUSIC: ENABLED"
      );

      console.log(
        "PROJECTS: ENABLED"
      );

      console.log(
        "PROMPT ENHANCER: ENABLED"
      );

      console.log(
        "NARRATION: ENABLED"
      );

      console.log(
        "WATERMARK: MANDATORY"
      );

      console.log(
        "MAX DURATION: 7200 SECONDS"
      );

      console.log(
        "=========================================="
      );
    }
  );

/*
 * Give Render/Node more time for
 * long-running background processing.
 */

server.keepAliveTimeout =
  120000;

server.headersTimeout =
  125000;
