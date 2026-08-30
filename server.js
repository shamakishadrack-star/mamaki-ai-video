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
  ? new Replicate({
      auth: REPLICATE_API_TOKEN
    })
  : null;

/* =====================================================
   MAMAKI AI VIDEO — FINAL STABLE SERVER
   ===================================================== */

const T2V_MODEL = "wan-video/wan-2.2-t2v-fast";
const I2V_MODEL = "wan-video/wan-2.2-i2v-fast";

const TMP = path.join(ROOT, "tmp");
const OUTPUT = path.join(ROOT, "outputs");
const PROJECTS = path.join(ROOT, "projects");
const INDEX = path.join(ROOT, "index.html");

await fs.mkdir(TMP, { recursive: true });
await fs.mkdir(OUTPUT, { recursive: true });
await fs.mkdir(PROJECTS, { recursive: true });

/* =====================================================
   BODY PARSERS
   ===================================================== */

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

/* =====================================================
   IMPORTANT ROOT ROUTE
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

/* Static files */
app.use(
  express.static(ROOT, {
    index: false
  })
);

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

function normalizeRatio(value) {
  if (value === "9:16") return "9:16";
  if (value === "1:1") return "1:1";
  return "16:9";
}

/*
 * Project duration may be up to two hours.
 * Wan itself still generates short clips.
 */
function normalizeDuration(value) {
  const n = safeNumber(value, 5);

  return clamp(
    Math.round(n),
    5,
    7200
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
   REPLICATE OUTPUT
   ===================================================== */

async function downloadUrl(url) {
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

async function replicateOutputToBuffer(output) {
  if (!output) {
    throw new Error(
      "MAMAKI did not receive a video file."
    );
  }

  if (
    output instanceof Uint8Array ||
    Buffer.isBuffer(output)
  ) {
    return Buffer.from(output);
  }

  if (
    typeof output.url === "function"
  ) {
    const url = output.url();

    if (!url) {
      throw new Error(
        "Replicate returned an empty video URL."
      );
    }

    return downloadUrl(url);
  }

  if (
    typeof output.url === "string"
  ) {
    return downloadUrl(output.url);
  }

  if (typeof output === "string") {
    if (
      output.startsWith("http://") ||
      output.startsWith("https://")
    ) {
      return downloadUrl(output);
    }
  }

  if (Array.isArray(output)) {
    if (!output.length) {
      throw new Error(
        "Replicate returned no video."
      );
    }

    return replicateOutputToBuffer(
      output[0]
    );
  }

  /*
   * Some Replicate SDK outputs can expose
   * a blob-like object.
   */
  if (
    typeof output.arrayBuffer === "function"
  ) {
    return Buffer.from(
      await output.arrayBuffer()
    );
  }

  throw new Error(
    "MAMAKI did not receive a video file."
  );
}

/* =====================================================
   FFMPEG
   ===================================================== */

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
                `FFmpeg failed: ${stderr.slice(-12000)}`
              )
            );
          }
        }
      );
    }
  );
}

/* =====================================================
   WATERMARK
   ===================================================== */

async function addWatermark(input, output) {
  /*
   * MAMAKI watermark.
   *
   * The filter is deliberately simple and
   * compatible with ffmpeg-static builds.
   */

  await runFFmpeg([
    "-y",

    "-i",
    input,

    "-vf",
    "drawtext=text='MAMAKI':fontcolor=white:fontsize=28:borderw=2:bordercolor=black@0.75:x=w-tw-25:y=h-th-25",

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
   SOFT MUSIC
   ===================================================== */

/*
 * Creates a small, gentle instrumental-style
 * background track using FFmpeg tones.
 *
 * This avoids requiring an external music file.
 */

async function createSoftMusic(
  output,
  duration
) {
  const seconds = clamp(
    safeNumber(duration, 5) + 2,
    5,
    7205
  );

  /*
   * Multiple low-volume sine tones.
   * This is intentionally subtle.
   */

  const filter =
    "volume=0.035";

  await runFFmpeg([
    "-y",

    "-f",
    "lavfi",

    "-i",
    `sine=frequency=261.63:duration=${seconds}`,

    "-af",
    filter,

    "-c:a",
    "aac",

    "-b:a",
    "96k",

    output
  ]);

  return output;
}

/* =====================================================
   ADD BACKGROUND MUSIC
   ===================================================== */

async function addSoftMusic(
  video,
  output,
  duration
) {
  const music =
    path.join(
      TMP,
      `soft-${randomUUID()}.m4a`
    );

  try {
    await createSoftMusic(
      music,
      duration
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
      "[1:a]volume=0.16[music];[0:a]volume=1[original];[original][music]amix=inputs=2:duration=first:dropout_transition=2[a]",

      "-map",
      "0:v",

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

      "-shortest",

      "-movflags",
      "+faststart",

      output
    ]);

    return output;
  } finally {
    await fs.rm(
      music,
      {
        force: true
      }
    ).catch(() => {});
  }
}

/* =====================================================
   WAN TEXT → VIDEO
   ===================================================== */

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
    "MAMAKI T2V:",
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

/* =====================================================
   WAN IMAGE → VIDEO
   ===================================================== */

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
    "MAMAKI I2V:",
    {
      prompt: input.prompt,
      filename: image.originalname,
      type: image.mimetype
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

/* =====================================================
   SCENES
   ===================================================== */

function splitScenes(
  prompt,
  duration
) {
  const text =
    String(prompt || "").trim();

  if (!text) return [];

  /*
   * WAN clips are kept around 5 seconds.
   */
  const count =
    Math.max(
      1,
      Math.ceil(duration / 5)
    );

  const sentences =
    text
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
        : text;

    scenes.push(
      `${base}. Cinematic professional video, realistic natural movement, smooth camera motion, detailed environment, consistent subject appearance, realistic lighting, high quality filmmaking.`
    );
  }

  return scenes;
}

/* =====================================================
   COMBINE VIDEOS
   ===================================================== */

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

/* =====================================================
   PHOTO → VIDEO
   ===================================================== */

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
    {
      recursive: true
    }
  );

  const clips = [];

  try {
    let size = "1280:720";

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

/* =====================================================
   TRIM
   ===================================================== */

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

/* =====================================================
   MUTE
   ===================================================== */

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

/* =====================================================
   MUSIC MIX
   ===================================================== */

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
    `[0:a]volume=${ov}[a0];[1:a]volume=${mv}[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[a]`,

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

    "-movflags",
    "+faststart",

    output
  ]);

  return output;
}

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
      await fs.access(file);

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

/* =====================================================
   MAIN AI GENERATOR
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
    let jobDir = null;

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

      const duration =
        normalizeDuration(
          req.body.duration
        );

      const ratio =
        normalizeRatio(
          req.body.ratio ||
          req.body.aspectRatio
        );

      const mode =
        String(
          req.body.mode || ""
        ).toLowerCase();

      const image =
        req.files
          ?.referenceImage
          ?.[0] || null;

      jobDir =
        path.join(
          TMP,
          randomUUID()
        );

      await fs.mkdir(
        jobDir,
        {
          recursive: true
        }
      );

      /*
       * Keep normal generation short enough
       * to avoid unnecessarily huge jobs.
       *
       * Long projects are assembled scene-by-scene.
       */

      const sceneCount =
        Math.ceil(
          duration / 5
        );

      const scenes =
        splitScenes(
          prompt,
          duration
        );

      const clips = [];

      /*
       * Image mode uses the image for the
       * first AI scene, preserving the
       * working I2V implementation.
       */
      for (
        let i = 0;
        i < sceneCount;
        i++
      ) {
        console.log(
          `MAMAKI: scene ${i + 1}/${sceneCount}`
        );

        const scenePrompt =
          scenes[i] ||
          `${prompt}. Cinematic continuation.`;

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

        clips.push(clip);
      }

      const combined =
        path.join(
          jobDir,
          "combined.mp4"
        );

      await combineVideos(
        clips,
        combined
      );

      /*
       * Image-to-video:
       * automatically add soft music.
       *
       * Text-to-video:
       * don't alter the successful
       * generation path unnecessarily.
       */
      let audioVersion =
        combined;

      if (image) {
        const musicVideo =
          path.join(
            jobDir,
            "music.mp4"
          );

        try {
          await addSoftMusic(
            combined,
            musicVideo,
            duration
          );

          audioVersion =
            musicVideo;

        } catch (musicError) {
          console.error(
            "SOFT MUSIC ERROR:",
            musicError.message
          );

          /*
           * Never destroy a successful
           * Image-to-Video result merely
           * because optional music failed.
           */
          audioVersion =
            combined;
        }
      }

      /*
       * FINAL WATERMARK
       */
      const finalName =
        `mamaki-ai-${Date.now()}-${randomUUID()}.mp4`;

      const final =
        path.join(
          OUTPUT,
          finalName
        );

      let watermarkActive =
        false;

      try {
        await addWatermark(
          audioVersion,
          final
        );

        watermarkActive =
          true;

      } catch (watermarkError) {
        console.error(
          "MAMAKI WATERMARK ERROR:",
          watermarkError.message
        );

        /*
         * Preserve a working video if
         * the optional watermark filter
         * fails on a particular FFmpeg build.
         */
        await fs.copyFile(
          audioVersion,
          final
        );
      }

      const stats =
        await fs.stat(final);

      if (!stats.size) {
        throw new Error(
          "MAMAKI created an empty video."
        );
      }

      /*
       * Automatically save project metadata.
       */
      const projectId =
        randomUUID();

      const project = {
        id: projectId,
        title:
          prompt.slice(0, 70),
        prompt,
        mode:
          image
            ? "Image to Video"
            : "Text to Video",
        duration,
        ratio,
        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,
        file:
          finalName,
        createdAt:
          new Date().toISOString(),
        watermark:
          watermarkActive
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

      return res.json({
        ok: true,
        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        file:
          finalName,

        projectId,

        requestedDuration:
          duration,

        generatedScenes:
          sceneCount,

        mode:
          image
            ? "image-to-video"
            : "text-to-video",

        model:
          image
            ? I2V_MODEL
            : T2V_MODEL,

        music:
          Boolean(image),

        watermark:
          "MAMAKI",

        watermarkActive,

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

      let message =
        error?.message ||
        "Video generation failed.";

      const lower =
        message.toLowerCase();

      if (
        lower.includes("insufficient") ||
        lower.includes("credit") ||
        lower.includes("402")
      ) {
        message =
          "Replicate has insufficient credit or the Replicate account is not active.";
      }

      return res.status(500).json({
        ok: false,
        success: false,
        error: message
      });

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
);

/* =====================================================
   PROJECTS
   ===================================================== */

app.get(
  "/api/projects",
  async (req, res) => {
    try {
      const files =
        await fs.readdir(
          PROJECTS
        );

      const projects = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;

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
          new Date(b.createdAt || 0) -
          new Date(a.createdAt || 0)
      );

      return res.json({
        ok: true,
        projects
      });

    } catch (error) {
      return res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

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

      return res.json({
        ok: true,
        projectId: id
      });

    } catch (error) {
      return res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* =====================================================
   FREE STUDIO — PHOTO → VIDEO
   ===================================================== */

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

      await createPhotoVideo(
        images,
        req.body.duration,
        raw,
        req.body.ratio
      );

      /*
       * Optional uploaded music.
       */
      const music =
        req.files?.music?.[0];

      let current =
        raw;

      if (isAudio(music)) {
        const musicFile =
          path.join(
            dir,
            "music"
          );

        const mixed =
          path.join(
            dir,
            "photo-music.mp4"
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

        current =
          mixed;
      }

      try {
        await addWatermark(
          current,
          final
        );
      } catch {
        await fs.copyFile(
          current,
          final
        );
      }

      return res.json({
        ok: true,
        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        watermark:
          "MAMAKI",

        aiCredits:
          0
      });

    } catch (error) {
      return res.status(500).json({
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

/* =====================================================
   FREE STUDIO — TRIM
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
        req.files
          ?.music
          ?.[0];

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

      try {
        await addWatermark(
          current,
          final
        );
      } catch {
        await fs.copyFile(
          current,
          final
        );
      }

      return res.json({
        ok: true,
        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        watermark:
          "MAMAKI",

        aiCredits:
          0
      });

    } catch (error) {
      return res.status(500).json({
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

/* =====================================================
   FREE STUDIO — COMBINE
   ===================================================== */

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

      return res.json({
        ok: true,
        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        watermark:
          "MAMAKI",

        aiCredits:
          0
      });

    } catch (error) {
      return res.status(500).json({
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

/* =====================================================
   STATUS
   ===================================================== */

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
        Boolean(ffmpegPath),
      textToVideo:
        T2V_MODEL,
      imageToVideo:
        I2V_MODEL,
      longForm:
        true,
      maxDurationSeconds:
        7200,
      photoVideo:
        true,
      photoVideoMusic:
        true,
      trimmer:
        true,
      combine:
        true,
      watermark:
        "MAMAKI",
      projects:
        true
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
        Boolean(ffmpegPath)
    });
  }
);

/* =====================================================
   ERROR HANDLER
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
      "========================================"
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
      `T2V: ${T2V_MODEL}`
    );

    console.log(
      `I2V: ${I2V_MODEL}`
    );

    console.log(
      "PROJECTS: ENABLED"
    );

    console.log(
      "FREE STUDIO: ENABLED"
    );

    console.log(
      "PHOTO MUSIC: ENABLED"
    );

    console.log(
      "WATERMARK: MAMAKI"
    );

    console.log(
      "========================================"
    );
  }
);
