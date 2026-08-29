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

/*
=========================================================
MAMAKI AI VIDEO
FINAL SERVER
=========================================================

KEEPING WORKING:
- WAN 2.2 Text → Video
- WAN 2.2 Image → Video
- 16:9
- 9:16
- 1:1
- 5 seconds → 2 hours
- Projects
- Free Studio
- Photo → Video
- Photo → Video + Music
- Video Trimmer
- Combine Videos
- Mute Video
- Add Music
- MAMAKI watermark
- Health/status APIs
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
EXPRESS
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
IMPORTANT: ROOT ROUTE BEFORE STATIC
=========================================================
*/

app.get("/", async (req, res) => {
  try {
    await fs.access(INDEX);

    return res.sendFile(
      INDEX,
      {
        root: ROOT
      }
    );
  } catch {
    return res.status(404).send(
      "MAMAKI index.html is missing."
    );
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

const upload =
  multer({
    storage:
      multer.memoryStorage(),

    limits: {
      fileSize:
        500 * 1024 * 1024,

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
  const n =
    Number(value);

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
    Math.max(
      min,
      value
    )
  );
}

function normalizeRatio(
  value
) {
  if (
    value === "9:16"
  ) {
    return "9:16";
  }

  if (
    value === "1:1"
  ) {
    return "1:1";
  }

  return "16:9";
}

/*
  5 seconds → 2 hours
*/

function normalizeDuration(
  value
) {
  const seconds =
    Math.round(
      safeNumber(
        value,
        5
      )
    );

  return clamp(
    seconds,
    5,
    7200
  );
}

function isImage(
  file
) {
  return (
    !!file &&
    [
      "image/jpeg",
      "image/png",
      "image/webp"
    ].includes(
      file.mimetype
    )
  );
}

function isVideo(
  file
) {
  return (
    !!file &&
    [
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-matroska"
    ].includes(
      file.mimetype
    )
  );
}

function isAudio(
  file
) {
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
    ].includes(
      file.mimetype
    )
  );
}

/*
=========================================================
REPLICATE OUTPUT
=========================================================
*/

async function downloadUrl(
  url
) {
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

async function replicateOutputToBuffer(
  output
) {
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
    typeof output.url === "function"
  ) {
    const url =
      output.url();

    if (!url) {
      throw new Error(
        "MAMAKI received an empty video URL."
      );
    }

    return downloadUrl(url);
  }

  if (
    typeof output.url === "string"
  ) {
    return downloadUrl(
      output.url
    );
  }

  if (
    Array.isArray(output)
  ) {
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
    typeof output === "string" &&
    (
      output.startsWith("http://") ||
      output.startsWith("https://")
    )
  ) {
    return downloadUrl(
      output
    );
  }

  if (
    typeof output === "object"
  ) {
    const possible =
      output.video ||
      output.file ||
      output.output;

    if (
      possible &&
      possible !== output
    ) {
      return replicateOutputToBuffer(
        possible
      );
    }
  }

  throw new Error(
    "MAMAKI did not receive a video file."
  );
}

/*
=========================================================
FFMPEG
=========================================================
*/

function runFFmpeg(
  args
) {
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
          if (
            code === 0
          ) {
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
FIND FONT
=========================================================
*/

async function findFont() {
  const fonts = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf"
  ];

  for (
    const font of fonts
  ) {
    try {
      await fs.access(font);
      return font;
    } catch {}
  }

  return null;
}

/*
=========================================================
MAMAKI WATERMARK
=========================================================
*/

async function addWatermark(
  input,
  output
) {
  const font =
    await findFont();

  let filter;

  if (font) {
    filter =
      `drawtext=fontfile='${font}':text='MAMAKI':fontcolor=white:fontsize=30:borderw=3:bordercolor=black@0.75:x=w-tw-28:y=h-th-28`;
  } else {
    filter =
      "drawtext=text='MAMAKI':fontcolor=white:fontsize=30:borderw=3:bordercolor=black@0.75:x=w-tw-28:y=h-th-28";
  }

  await runFFmpeg([
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

  const stats =
    await fs.stat(output);

  if (!stats.size) {
    throw new Error(
      "MAMAKI watermark output is empty."
    );
  }

  return output;
}

/*
=========================================================
WAN TEXT → VIDEO
KEEPING WORKING INPUT
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

    lora_scale_transformer:
      1,

    lora_scale_transformer_2:
      1
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

  console.log(
    "MAMAKI T2V OUTPUT RECEIVED"
  );

  return replicateOutputToBuffer(
    output
  );
}

/*
=========================================================
WAN IMAGE → VIDEO
KEEPING WORKING INPUT
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
    image:
      image.buffer,

    prompt:
      String(prompt).trim(),

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
      prompt:
        input.prompt,

      filename:
        image.originalname,

      type:
        image.mimetype,

      size:
        image.size
    }
  );

  const output =
    await replicate.run(
      I2V_MODEL,
      {
        input
      }
    );

  console.log(
    "MAMAKI I2V OUTPUT RECEIVED"
  );

  return replicateOutputToBuffer(
    output
  );
}

/*
=========================================================
PROMPT / SCENES
=========================================================
*/

function splitScenes(
  prompt,
  duration
) {
  const text =
    String(prompt || "")
      .trim();

  if (!text) {
    return [];
  }

  const count =
    Math.ceil(
      duration / 5
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
      `${base}. Cinematic professional filmmaking, realistic natural movement, smooth camera motion, detailed environment, consistent lighting, high quality.`
    );
  }

  return scenes;
}

/*
=========================================================
COMBINE VIDEOS
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
WITH MUSIC SUPPORT
=========================================================
*/

async function createPhotoVideo(
  images,
  secondsPerImage,
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
              secondsPerImage,
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

    const combined =
      path.join(
        job,
        "combined.mp4"
      );

    await combineVideos(
      clips,
      combined
    );

    if (
      music &&
      isAudio(music)
    ) {
      const musicFile =
        path.join(
          job,
          "music"
        );

      const musicVideo =
        path.join(
          job,
          "music-video.mp4"
        );

      await fs.writeFile(
        musicFile,
        music.buffer
      );

      await runFFmpeg([
        "-y",

        "-i",
        combined,

        "-stream_loop",
        "-1",

        "-i",
        musicFile,

        "-filter_complex",
        "[1:a]volume=0.35[music]",

        "-map",
        "0:v",

        "-map",
        "[music]",

        "-c:v",
        "copy",

        "-c:a",
        "aac",

        "-shortest",

        "-movflags",
        "+faststart",

        musicVideo
      ]);

      await fs.copyFile(
        musicVideo,
        output
      );
    } else {
      await fs.copyFile(
        combined,
        output
      );
    }

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

async function mixMusic(
  video,
  music,
  output,
  musicVolume = 0.3,
  originalVolume = 1
) {
  const mv =
    clamp(
      safeNumber(
        musicVolume,
        0.3
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
        error:
          error.message
      });
    }
  }
);

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

      for (
        const filename of files
      ) {
        if (
          !filename.endsWith(".json")
        ) {
          continue;
        }

        try {
          const content =
            await fs.readFile(
              path.join(
                PROJECTS,
                filename
              ),
              "utf8"
            );

          projects.push(
            JSON.parse(content)
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

      const image =
        req.files
          ?.referenceImage
          ?.[0] ||
        null;

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

      for (
        let i = 0;
        i < sceneCount;
        i++
      ) {
        console.log(
          `MAMAKI: generating scene ${i + 1}/${sceneCount}`
        );

        const scenePrompt =
          scenes[i] ||
          `${prompt}. Cinematic continuation.`;

        let videoBuffer;

        /*
         * IMPORTANT:
         * Image is only used for the
         * first scene.
         *
         * This keeps the existing
         * working I2V behavior.
         */

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

        console.log(
          `MAMAKI: scene ${i + 1} saved (${videoBuffer.length} bytes)`
        );
      }

      const combined =
        path.join(
          jobDir,
          "combined.mp4"
        );

      if (
        clips.length === 1
      ) {
        await fs.copyFile(
          clips[0],
          combined
        );
      } else {
        await combineVideos(
          clips,
          combined
        );
      }

      const finalName =
        `mamaki-ai-${Date.now()}-${randomUUID()}.mp4`;

      const final =
        path.join(
          OUTPUT,
          finalName
        );

      /*
       * WATERMARK IS NOW REQUIRED.
       *
       * We no longer silently copy the
       * unwatermarked file if watermarking
       * fails.
       */

      await addWatermark(
        combined,
        final
      );

      const stats =
        await fs.stat(
          final
        );

      if (!stats.size) {
        throw new Error(
          "MAMAKI created an empty video file."
        );
      }

      const projectId =
        randomUUID();

      await fs.writeFile(
        path.join(
          PROJECTS,
          `${projectId}.json`
        ),
        JSON.stringify(
          {
            id:
              projectId,

            title:
              prompt.slice(
                0,
                60
              ),

            type:
              image
                ? "Image → Video"
                : "Text → Video",

            prompt,

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

            updatedAt:
              new Date().toISOString(),

            watermark:
              true,

            model:
              image
                ? I2V_MODEL
                : T2V_MODEL
          },
          null,
          2
        ),
        "utf8"
      );

      console.log(
        "MAMAKI FINAL VIDEO:",
        final
      );

      return res.json({
        ok:
          true,

        success:
          true,

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

        model:
          image
            ? I2V_MODEL
            : T2V_MODEL,

        watermark:
          "MAMAKI",

        watermarkActive:
          true,

        message:
          "MAMAKI AI video generated successfully."
      });

    } catch (error) {
      console.error(
        "======================================"
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
        "======================================"
      );

      let message =
        error?.message ||
        "Video generation failed.";

      const lower =
        message.toLowerCase();

      if (
        lower.includes(
          "insufficient"
        ) ||
        lower.includes(
          "credit"
        ) ||
        lower.includes(
          "402"
        )
      ) {
        message =
          "Replicate has insufficient credit or the Replicate account is not active.";
      }

      return res.status(500).json({
        ok:
          false,

        success:
          false,

        error:
          message
      });

    } finally {
      if (jobDir) {
        await fs.rm(
          jobDir,
          {
            recursive:
              true,

            force:
              true
          }
        ).catch(
          () => {}
        );
      }
    }
  }
);

/*
=========================================================
FREE STUDIO
PHOTO → VIDEO + MUSIC
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
        recursive:
          true
      }
    );

    try {
      const images =
        req.files
          ?.images ||
        [];

      const music =
        req.files
          ?.music
          ?.[0] ||
        null;

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
          "Music must be an audio file."
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
        req.body.ratio,
        music
      );

      await addWatermark(
        raw,
        final
      );

      const projectId =
        randomUUID();

      await fs.writeFile(
        path.join(
          PROJECTS,
          `${projectId}.json`
        ),
        JSON.stringify(
          {
            id:
              projectId,

            title:
              "Photo Video",

            type:
              "Free Studio — Photo → Video",

            duration:
              req.body.duration,

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
              true,

            createdAt:
              new Date().toISOString(),

            updatedAt:
              new Date().toISOString()
          },
          null,
          2
        ),
        "utf8"
      );

      res.json({
        ok:
          true,

        success:
          true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        projectId,

        watermark:
          "MAMAKI",

        watermarkActive:
          true,

        musicAdded:
          Boolean(music),

        aiCredits:
          0
      });

    } catch (error) {
      console.error(
        "PHOTO VIDEO ERROR:",
        error
      );

      res.status(500).json({
        ok:
          false,

        error:
          error.message
      });

    } finally {
      await fs.rm(
        dir,
        {
          recursive:
            true,

          force:
            true
        }
      ).catch(
        () => {}
      );
    }
  }
);

/*
=========================================================
TRIM + MUSIC + MUTE
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
        recursive:
          true
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
          ?.[0] ||
        null;

      if (
        !isVideo(video)
      ) {
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
        ) ===
        "true"
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

      if (
        music &&
        isAudio(music)
      ) {
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
        ok:
          true,

        success:
          true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        watermark:
          "MAMAKI",

        watermarkActive:
          true,

        musicAdded:
          Boolean(
            music &&
            isAudio(music)
          ),

        aiCredits:
          0
      });

    } catch (error) {
      console.error(
        "TRIM ERROR:",
        error
      );

      res.status(500).json({
        ok:
          false,

        error:
          error.message
      });

    } finally {
      await fs.rm(
        dir,
        {
          recursive:
            true,

          force:
            true
        }
      ).catch(
        () => {}
      );
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
      {
        recursive:
          true
      }
    );

    try {
      const videos =
        req.files ||
        [];

      if (!videos.length) {
        throw new Error(
          "Upload videos to combine."
        );
      }

      const inputs =
        [];

      for (
        let i = 0;
        i < videos.length;
        i++
      ) {
        if (
          !isVideo(
            videos[i]
          )
        ) {
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

      await addWatermark(
        combined,
        final
      );

      res.json({
        ok:
          true,

        success:
          true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        watermark:
          "MAMAKI",

        watermarkActive:
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
        ok:
          false,

        error:
          error.message
      });

    } finally {
      await fs.rm(
        dir,
        {
          recursive:
            true,

          force:
            true
        }
      ).catch(
        () => {}
      );
    }
  }
);

/*
=========================================================
MUTE VIDEO
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
        recursive:
          true
      }
    );

    try {
      if (
        !isVideo(
          req.file
        )
      ) {
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

      await addWatermark(
        muted,
        final
      );

      res.json({
        ok:
          true,

        success:
          true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            finalName
          )}`,

        watermark:
          "MAMAKI",

        watermarkActive:
          true,

        aiCredits:
          0
      });

    } catch (error) {
      console.error(
        "MUTE ERROR:",
        error
      );

      res.status(500).json({
        ok:
          false,

        error:
          error.message
      });

    } finally {
      await fs.rm(
        dir,
        {
          recursive:
            true,

          force:
            true
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
          ok:
            false,

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
        ok:
          false,

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
      ok:
        true,

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

      aiModel:
        "Wan 2.2 Fast",

      durationMinimum:
        5,

      durationMaximum:
        7200,

      longForm:
        true,

      projects:
        true,

      freeStudio:
        true,

      photoVideo:
        true,

      photoVideoMusic:
        true,

      trimmer:
        true,

      combine:
        true,

      mute:
        true,

      watermark:
        "MAMAKI",

      watermarkAlwaysApplied:
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
        ok:
          false,

        error:
          "Uploaded file is too large."
      });
    }

    return res.status(500).json({
      ok:
        false,

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
        "PHOTO VIDEO: ENABLED"
      );

      console.log(
        "PHOTO VIDEO MUSIC: ENABLED"
      );

      console.log(
        "TRIMMER: ENABLED"
      );

      console.log(
        "COMBINE: ENABLED"
      );

      console.log(
        "MUTE: ENABLED"
      );

      console.log(
        "WATERMARK: MAMAKI"
      );

      console.log(
        "======================================"
      );
    }
  );

/*
=========================================================
KEEPALIVE / TIMEOUT SETTINGS
=========================================================
*/

server.keepAliveTimeout =
  120000;

server.headersTimeout =
  125000;
