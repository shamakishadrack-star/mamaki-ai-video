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

const TOKEN = String(
  process.env.REPLICATE_API_TOKEN || ""
).trim();

const replicate = TOKEN
  ? new Replicate({ auth: TOKEN })
  : null;

const T2V_MODEL =
  "wan-video/wan-2.2-t2v-fast";

const I2V_MODEL =
  "wan-video/wan-2.2-i2v-fast";

const OUTPUT = path.join(ROOT, "outputs");
const TMP = path.join(ROOT, "tmp");
const PROJECTS = path.join(ROOT, "projects");
const INDEX = path.join(ROOT, "index.html");

await fs.mkdir(OUTPUT, { recursive: true });
await fs.mkdir(TMP, { recursive: true });
await fs.mkdir(PROJECTS, { recursive: true });

app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "100mb"
}));

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
    return res.status(404).send(
      "MAMAKI index.html is missing."
    );
  }
});

/*
=========================================================
STATIC FILES
=========================================================
*/

app.use(express.static(ROOT, {
  index: false
}));

/*
=========================================================
UPLOAD
=========================================================
*/

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 20
  }
});

/*
=========================================================
HELPERS
=========================================================
*/

function ratio(value) {
  if (value === "9:16") return "9:16";
  if (value === "1:1") return "1:1";
  return "16:9";
}

function number(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function duration(value) {
  return Math.min(
    60,
    Math.max(
      5,
      Math.round(number(value, 5))
    )
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

/*
=========================================================
REPLICATE OUTPUT
=========================================================
*/

async function outputToBuffer(output) {
  if (!output) {
    throw new Error(
      "Replicate returned no video output."
    );
  }

  if (
    Buffer.isBuffer(output) ||
    output instanceof Uint8Array
  ) {
    return Buffer.from(output);
  }

  if (typeof output === "string") {
    if (
      output.startsWith("http://") ||
      output.startsWith("https://")
    ) {
      return download(output);
    }
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

    return download(url);
  }

  if (typeof output.url === "string") {
    return download(output.url);
  }

  if (Array.isArray(output)) {
    if (!output.length) {
      throw new Error(
        "Replicate returned an empty output."
      );
    }

    return outputToBuffer(output[0]);
  }

  if (
    typeof output.read === "function"
  ) {
    return Buffer.from(
      await output.read()
    );
  }

  throw new Error(
    "MAMAKI could not read the Replicate video output."
  );
}

async function download(url) {
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

/*
=========================================================
FFMPEG
=========================================================
*/

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      return reject(
        new Error("FFmpeg is not available.")
      );
    }

    const child = spawn(ffmpegPath, args);

    let errorText = "";

    child.stderr.on("data", data => {
      errorText += data.toString();
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `FFmpeg failed: ${errorText.slice(-8000)}`
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

async function watermark(input, output) {
  await ffmpeg([
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
}

/*
=========================================================
TEXT → VIDEO
=========================================================
*/

async function textToVideo(prompt, aspect) {
  if (!replicate) {
    throw new Error(
      "REPLICATE_API_TOKEN is missing on Render."
    );
  }

  const input = {
    prompt,
    go_fast: true,
    num_frames: 81,
    resolution: "480p",
    aspect_ratio: ratio(aspect),
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

/*
=========================================================
IMAGE → VIDEO
=========================================================
*/

async function imageToVideo(
  prompt,
  image
) {
  if (!replicate) {
    throw new Error(
      "REPLICATE_API_TOKEN is missing on Render."
    );
  }

  if (!image) {
    throw new Error(
      "Reference image is missing."
    );
  }

  /*
   * Replicate accepts a data URI for image input.
   * This avoids relying on a temporary public URL.
   */

  const dataUri =
    `data:${image.mimetype};base64,` +
    image.buffer.toString("base64");

  const input = {
    image: dataUri,
    prompt,
    go_fast: true,
    num_frames: 81,
    resolution: "480p",
    sample_shift: 12,
    frames_per_second: 16
  };

  console.log(
    "MAMAKI I2V:",
    {
      type: image.mimetype,
      size: image.size
    }
  );

  const output = await replicate.run(
    I2V_MODEL,
    { input }
  );

  return outputToBuffer(output);
}

/*
=========================================================
MAIN GENERATOR
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

    let job = null;

    try {
      if (!replicate) {
        return res.status(503).json({
          ok: false,
          error:
            "REPLICATE_API_TOKEN is not configured on Render."
        });
      }

      const prompt =
        String(req.body.prompt || "").trim();

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error:
            "Please enter a video prompt."
        });
      }

      const aspect =
        ratio(
          req.body.ratio ||
          req.body.aspectRatio
        );

      const requested =
        duration(req.body.duration);

      /*
       * Wan Fast is best at 81 frames.
       * One generation is approximately 5 seconds.
       *
       * To avoid unnecessary failures on the
       * Render free instance, generate ONE clip
       * first. The frontend can request another
       * generation when needed.
       */

      job = path.join(
        TMP,
        randomUUID()
      );

      await fs.mkdir(job, {
        recursive: true
      });

      const image =
        req.files?.referenceImage?.[0] || null;

      console.log(
        "===================================="
      );

      console.log(
        "MAMAKI GENERATION STARTED"
      );

      console.log(
        "Prompt:",
        prompt
      );

      console.log(
        "Aspect:",
        aspect
      );

      console.log(
        "Requested duration:",
        requested
      );

      console.log(
        "Image:",
        image ? "YES" : "NO"
      );

      console.log(
        "===================================="
      );

      let buffer;

      if (image) {
        if (!isImage(image)) {
          throw new Error(
            "Reference image must be JPG, PNG or WebP."
          );
        }

        buffer =
          await imageToVideo(
            prompt,
            image
          );
      } else {
        buffer =
          await textToVideo(
            prompt,
            aspect
          );
      }

      if (!buffer || !buffer.length) {
        throw new Error(
          "Replicate returned an empty video."
        );
      }

      const raw =
        path.join(
          job,
          "generated.mp4"
        );

      await fs.writeFile(
        raw,
        buffer
      );

      const filename =
        `mamaki-${Date.now()}-${randomUUID()}.mp4`;

      const final =
        path.join(
          OUTPUT,
          filename
        );

      /*
       * Watermark is attempted.
       * If FFmpeg fails, the original generated
       * video is preserved.
       */

      try {
        await watermark(
          raw,
          final
        );
      } catch (error) {
        console.error(
          "WATERMARK FAILED:",
          error.message
        );

        await fs.copyFile(
          raw,
          final
        );
      }

      const stat =
        await fs.stat(final);

      if (!stat.size) {
        throw new Error(
          "Final video file is empty."
        );
      }

      console.log(
        "MAMAKI VIDEO READY:",
        filename,
        stat.size,
        "bytes"
      );

      return res.json({
        ok: true,
        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(filename)}`,

        file: filename,

        model:
          image
            ? I2V_MODEL
            : T2V_MODEL,

        requestedDuration:
          requested,

        actualGeneratedClip:
          "approximately 5 seconds",

        aspectRatio:
          aspect,

        watermark:
          "MAMAKI",

        message:
          "MAMAKI video generated successfully."
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

      let message =
        error?.message ||
        "Video generation failed.";

      if (
        message.includes("402") ||
        message.toLowerCase().includes("credit") ||
        message.toLowerCase().includes("billing") ||
        message.toLowerCase().includes("balance")
      ) {
        message =
          "Replicate rejected the generation because of account billing/credit status.";
      }

      return res.status(500).json({
        ok: false,
        success: false,
        error: message
      });

    } finally {

      if (job) {
        await fs.rm(job, {
          recursive: true,
          force: true
        }).catch(() => {});
      }
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

      const stat =
        await fs.stat(file);

      if (!stat.size) {
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
        String(stat.size)
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
      version: "9.0.0",
      server: "online",
      replicate: Boolean(TOKEN),
      ffmpeg: Boolean(ffmpegPath),
      textToVideo: T2V_MODEL,
      imageToVideo: I2V_MODEL
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
      version: "9.0.0",
      replicate: Boolean(TOKEN),
      ffmpeg: Boolean(ffmpegPath)
    });
  }
);

/*
=========================================================
404 JSON FOR API
=========================================================
*/

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        `API route not found: ${req.method} ${req.path}`
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
      error?.stack ||
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

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "===================================="
    );

    console.log(
      "MAMAKI AI VIDEO v9.0.0"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `REPLICATE: ${
        TOKEN ? "FOUND" : "MISSING"
      }`
    );

    console.log(
      `FFMPEG: ${
        ffmpegPath ? "FOUND" : "MISSING"
      }`
    );

    console.log(
      `T2V: ${T2V_MODEL}`
    );

    console.log(
      `I2V: ${I2V_MODEL}`
    );

    console.log(
      "===================================="
    );
  }
);
