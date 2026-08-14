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

const T2V_MODEL = "wan-video/wan-2.5-t2v-fast";
const I2V_MODEL = "wan-video/wan-2.5-i2v";

const TMP = path.join(ROOT, "tmp");
const OUTPUT = path.join(ROOT, "outputs");
const INDEX = path.join(ROOT, "index.html");

await fs.mkdir(TMP, { recursive: true });
await fs.mkdir(OUTPUT, { recursive: true });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "10mb"
}));

/* =========================
   MAMAKI INTERFACE
========================= */

app.get("/", async (req, res) => {
  try {
    await fs.access(INDEX);
    res.sendFile(INDEX);
  } catch {
    res.status(404).send(
      "MAMAKI interface not found. index.html is missing."
    );
  }
});

/* Serve other files beside index.html */
app.use(express.static(ROOT, {
  index: false
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 10
  }
});

/* =========================
   HELPERS
========================= */

function duration(value) {
  const n = Number(value || 5);

  if (!Number.isFinite(n)) return 5;

  return Math.max(
    5,
    Math.min(10, Math.round(n))
  );
}

function size(ratio) {
  if (ratio === "9:16") return "720x1280";
  if (ratio === "1:1") return "720x720";
  return "1280x720";
}

function isImage(file) {
  return !!file &&
    [
      "image/jpeg",
      "image/png",
      "image/webp"
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

/* =========================
   REPLICATE
========================= */

async function getVideoBuffer(output) {
  const item = Array.isArray(output)
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

  throw new Error(
    "Unsupported Replicate output."
  );
}

async function generateVideo(
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

  const model = image
    ? I2V_MODEL
    : T2V_MODEL;

  const input = image
    ? {
        image,
        prompt,
        duration: duration(seconds),
        resolution: "720p"
      }
    : {
        prompt,
        duration: duration(seconds),
        size: size(ratio),
        negative_prompt:
          "blurry, distorted, flickering, deformed, low quality, bad anatomy",
        enable_prompt_expansion: true
      };

  console.log(
    "MAMAKI: Starting",
    image ? "IMAGE TO VIDEO" : "TEXT TO VIDEO"
  );

  console.log(
    "MAMAKI MODEL:",
    model
  );

  let prediction;

  try {
    prediction =
      await replicate.predictions.create({
        model,
        input
      });
  } catch (error) {
    throw new Error(
      error?.message ||
      "Replicate prediction creation failed."
    );
  }

  console.log(
    "MAMAKI PREDICTION:",
    prediction.id
  );

  while (
    prediction.status === "starting" ||
    prediction.status === "processing"
  ) {
    await new Promise(
      resolve => setTimeout(resolve, 3000)
    );

    prediction =
      await replicate.predictions.get(
        prediction.id
      );

    console.log(
      "MAMAKI:",
      prediction.status
    );
  }

  if (
    prediction.status !== "succeeded"
  ) {
    throw new Error(
      `Prediction ${prediction.id} failed: ${
        prediction.error ||
        "Unknown Replicate error"
      }`
    );
  }

  return getVideoBuffer(
    prediction.output
  );
}

/* =========================
   FFMPEG
========================= */

function ffmpeg(args) {
  return new Promise(
    (resolve, reject) => {
      if (!ffmpegPath) {
        reject(
          new Error(
            "FFmpeg unavailable."
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
                stderr.slice(-5000)
              )
            );
          }
        }
      );
    }
  );
}

/* =========================
   VOICE
========================= */

async function createVoice(
  text,
  output
) {
  const tts =
    new EdgeTTS(
      String(text).trim(),
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
      "Voice generation failed."
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
      Buffer.from(result.audio);
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
      "Unable to read voice audio."
    );
  }

  await fs.writeFile(
    output,
    buffer
  );
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
    },
    {
      name: "music",
      maxCount: 1
    },
    {
      name: "effects",
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
      { recursive: true }
    );

    try {
      if (!replicate) {
        return res.status(503).json({
          ok: false,
          error:
            "REPLICATE_API_TOKEN is missing."
        });
      }

      const body =
        req.body || {};

      const files =
        req.files || {};

      const prompt =
        String(
          body.prompt || ""
        ).trim();

      const script =
        String(
          body.script ||
          body.voiceText ||
          ""
        ).trim();

      const seconds =
        duration(
          body.duration
        );

      const ratio =
        body.ratio ||
        body.aspectRatio ||
        "9:16";

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error:
            "Enter a video prompt."
        });
      }

      let image = null;

      if (
        files.referenceImage?.[0]
      ) {
        const file =
          files.referenceImage[0];

        if (!isImage(file)) {
          throw new Error(
            "Reference image must be JPG, PNG or WebP."
          );
        }

        image =
          file.buffer;
      }

      const videoBuffer =
        await generateVideo(
          prompt,
          seconds,
          ratio,
          image
        );

      const videoName =
        `mamaki-${Date.now()}-${randomUUID()}.mp4`;

      const videoPath =
        path.join(
          OUTPUT,
          videoName
        );

      await fs.writeFile(
        videoPath,
        videoBuffer
      );

      /* Voice is prepared only when requested.
         Video generation remains independent. */

      if (
        body.voiceEnabled !== "false" &&
        script
      ) {
        try {
          const voice =
            path.join(
              jobDir,
              "voice.mp3"
            );

          await createVoice(
            script,
            voice
          );
        } catch (voiceError) {
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
          `/api/video/${encodeURIComponent(videoName)}`,
        file:
          videoName,
        message:
          "MAMAKI video generated successfully."
      });

    } catch (error) {
      console.error(
        "MAMAKI GENERATION ERROR:",
        error?.stack ||
        error?.message ||
        error
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
        jobDir,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});
    }
  }
);

/* =========================
   VIDEO DELIVERY
========================= */

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

      res.sendFile(
        video
      );

    } catch {
      res.status(404).json({
        ok: false,
        error:
          "Video not found."
      });
    }
  }
);

/* =========================
   STATUS
========================= */

app.get(
  "/api/status",
  async (req, res) => {
    res.json({
      app:
        "MAMAKI AI VIDEO",
      version:
        "5.1.0",
      server:
        "online",
      replicate:
        Boolean(replicate),
      textToVideo:
        T2V_MODEL,
      imageToVideo:
        I2V_MODEL,
      voiceOver:
        true,
      ffmpeg:
        Boolean(ffmpegPath)
    });
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",
      app:
        "MAMAKI AI VIDEO",
      version:
        "5.1.0"
    });
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "================================"
    );

    console.log(
      "MAMAKI AI VIDEO v5.1.0"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `INDEX: ${
        INDEX
      }`
    );

    console.log(
      `REPLICATE: ${
        TOKEN ? "FOUND" : "MISSING"
      }`
    );

    console.log(
      "================================"
    );
  }
);
