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
  ? new Replicate({
      auth: TOKEN
    })
  : null;

/* =========================================================
   AI MODELS
========================================================= */

const T2V_MODEL =
  "wan-video/wan-2.5-t2v";

const I2V_MODEL =
  "wan-video/wan-2.5-i2v";

/* =========================================================
   DIRECTORIES
========================================================= */

const TMP =
  path.join(ROOT, "tmp");

const OUTPUT =
  path.join(ROOT, "outputs");

const INDEX =
  path.join(ROOT, "index.html");

await fs.mkdir(TMP, {
  recursive: true
});

await fs.mkdir(OUTPUT, {
  recursive: true
});

/* =========================================================
   EXPRESS
========================================================= */

app.use(
  express.json({
    limit: "10mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb"
  })
);

/* =========================================================
   MAMAKI INTERFACE
========================================================= */

app.get("/", async (req, res) => {
  try {
    await fs.access(INDEX);

    return res.sendFile(INDEX);
  } catch {
    return res.status(404).send(
      "MAMAKI interface not found. index.html is missing."
    );
  }
});

app.use(
  express.static(ROOT, {
    index: false
  })
);

/* =========================================================
   UPLOAD
========================================================= */

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 10
  }
});

/* =========================================================
   HELPERS
========================================================= */

function duration(value) {
  const n = Number(value || 5);

  if (!Number.isFinite(n)) {
    return 5;
  }

  return Math.max(
    5,
    Math.min(
      10,
      Math.round(n)
    )
  );
}

function size(ratio) {
  if (ratio === "9:16") {
    return "720*1280";
  }

  if (ratio === "16:9") {
    return "1280*720";
  }

  if (ratio === "1:1") {
    return "720*720";
  }

  return "1280*720";
}

function isImage(file) {
  return !!file &&
    [
      "image/jpeg",
      "image/png",
      "image/webp"
    ].includes(file.mimetype);
}

/* =========================================================
   REPLICATE VIDEO OUTPUT
========================================================= */

async function getVideoBuffer(output) {

  if (!output) {
    throw new Error(
      "Replicate returned no video output."
    );
  }

  /*
   * Current Replicate Node SDK returns
   * FileOutput objects for generated files.
   */

  if (Buffer.isBuffer(output)) {
    return output;
  }

  if (output instanceof Uint8Array) {
    return Buffer.from(output);
  }

  /*
   * FileOutput can expose url()
   */

  if (
    typeof output.url === "function"
  ) {
    const url = output.url();

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

  /*
   * Some versions may return
   * an array of FileOutput objects.
   */

  if (Array.isArray(output)) {

    const first =
      output[0];

    if (!first) {
      throw new Error(
        "Replicate returned an empty video array."
      );
    }

    return getVideoBuffer(first);
  }

  /*
   * URL string fallback
   */

  if (typeof output === "string") {

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

  /*
   * Older object format
   */

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

  throw new Error(
    "Unsupported Replicate video output format."
  );
}

/* =========================================================
   AI VIDEO GENERATION
========================================================= */

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

  const cleanPrompt =
    String(prompt || "").trim();

  if (!cleanPrompt) {
    throw new Error(
      "Video prompt is empty."
    );
  }

  const videoDuration =
    duration(seconds);

  console.log(
    "======================================"
  );

  console.log(
    "MAMAKI AI VIDEO GENERATION"
  );

  console.log(
    "PROMPT:",
    cleanPrompt
  );

  console.log(
    "DURATION:",
    videoDuration
  );

  /* =======================================================
     IMAGE → VIDEO
  ======================================================= */

  if (image) {

    console.log(
      "MODE: IMAGE TO VIDEO"
    );

    console.log(
      "MODEL:",
      I2V_MODEL
    );

    console.log(
      "IMAGE TYPE:",
      image.mimetype
    );

    console.log(
      "IMAGE SIZE:",
      image.buffer.length,
      "bytes"
    );

    if (!isImage(image)) {
      throw new Error(
        "Reference image must be JPG, PNG, or WebP."
      );
    }

    /*
     * IMPORTANT:
     *
     * We send the Buffer directly to Replicate.
     *
     * DO NOT convert it to base64.
     *
     * Replicate's Node SDK uploads the Buffer
     * automatically.
     */

    const input = {

      image:
        image.buffer,

      prompt:
        cleanPrompt,

      duration:
        videoDuration,

      resolution:
        "720p",

      negative_prompt:
        "blurry, distorted, flickering, deformed, low quality, bad anatomy",

      enable_prompt_expansion:
        true
    };

    console.log(
      "MAMAKI: Sending image Buffer to Replicate..."
    );

    try {

      const output =
        await replicate.run(
          I2V_MODEL,
          {
            input
          }
        );

      console.log(
        "MAMAKI: I2V generation completed."
      );

      return await getVideoBuffer(
        output
      );

    } catch (error) {

      console.error(
        "MAMAKI I2V ERROR:"
      );

      console.error(
        error?.stack ||
        error?.message ||
        error
      );

      throw new Error(
        `Replicate Image-to-Video failed: ${
          error?.message ||
          "Unknown Replicate error"
        }`
      );
    }
  }

  /* =======================================================
     TEXT → VIDEO
  ======================================================= */

  console.log(
    "MODE: TEXT TO VIDEO"
  );

  console.log(
    "MODEL:",
    T2V_MODEL
  );

  const input = {

    size:
      size(ratio),

    prompt:
      cleanPrompt,

    duration:
      videoDuration,

    negative_prompt:
      "",

    enable_prompt_expansion:
      true
  };

  console.log(
    "SIZE:",
    input.size
  );

  console.log(
    "MAMAKI: Calling Replicate T2V..."
  );

  try {

    const output =
      await replicate.run(
        T2V_MODEL,
        {
          input
        }
      );

    console.log(
      "MAMAKI: T2V completed."
    );

    return await getVideoBuffer(
      output
    );

  } catch (error) {

    console.error(
      "MAMAKI T2V ERROR:"
    );

    console.error(
      error?.stack ||
      error?.message ||
      error
    );

    throw new Error(
      `Replicate Text-to-Video failed: ${
        error?.message ||
        "Unknown Replicate error"
      }`
    );
  }
}

/* =========================================================
   FFMPEG
========================================================= */

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
                `FFmpeg error: ${stderr.slice(-5000)}`
              )
            );
          }
        }
      );
    }
  );
}

/* =========================================================
   VOICE GENERATION
========================================================= */

async function createVoice(
  text,
  output
) {

  const narration =
    String(text || "").trim();

  if (!narration) {
    throw new Error(
      "Voice text is empty."
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
    Buffer.isBuffer(result.audio)
  ) {

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
      "Unable to read generated voice."
    );
  }

  await fs.writeFile(
    output,
    buffer
  );

  return output;
}

/* =========================================================
   GENERATE API
========================================================= */

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

        return res
          .status(503)
          .json({

            ok:
              false,

            success:
              false,

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
        "16:9";

      if (!prompt) {

        return res
          .status(400)
          .json({

            ok:
              false,

            success:
              false,

            error:
              "Enter a video prompt."
          });
      }

      /* ==================================================
         REFERENCE IMAGE
      ================================================== */

      let referenceImage =
        null;

      if (
        files.referenceImage &&
        files.referenceImage[0]
      ) {

        const file =
          files.referenceImage[0];

        console.log(
          "MAMAKI: Reference image received."
        );

        console.log(
          "Filename:",
          file.originalname
        );

        console.log(
          "Mimetype:",
          file.mimetype
        );

        console.log(
          "Size:",
          file.size
        );

        if (!isImage(file)) {

          return res
            .status(400)
            .json({

              ok:
                false,

              success:
                false,

              error:
                "Reference image must be JPG, PNG, or WebP."
            });
        }

        referenceImage = {

          buffer:
            file.buffer,

          mimetype:
            file.mimetype
        };
      }

      /* ==================================================
         GENERATE VIDEO
      ================================================== */

      const videoBuffer =
        await generateVideo(
          prompt,
          seconds,
          ratio,
          referenceImage
        );

      if (
        !videoBuffer ||
        !videoBuffer.length
      ) {

        throw new Error(
          "AI model returned an empty video."
        );
      }

      /* ==================================================
         SAVE VIDEO
      ================================================== */

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

      console.log(
        "MAMAKI: Video saved:",
        videoName
      );

      /* ==================================================
         OPTIONAL VOICE
      ================================================== */

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

          console.log(
            "MAMAKI: Voice generated."
          );

        } catch (voiceError) {

          console.error(
            "VOICE ERROR:",
            voiceError?.message ||
            voiceError
          );
        }
      }

      /* ==================================================
         SUCCESS
      ================================================== */

      return res.json({

        ok:
          true,

        success:
          true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            videoName
          )}`,

        file:
          videoName,

        message:
          "MAMAKI video generated successfully."
      });

    } catch (error) {

      console.error(
        "======================================"
      );

      console.error(
        "MAMAKI GENERATION ERROR:"
      );

      console.error(
        error?.stack ||
        error?.message ||
        error
      );

      console.error(
        "======================================"
      );

      return res
        .status(500)
        .json({

          ok:
            false,

          success:
            false,

          error:
            error?.message ||
            "Video generation failed."
        });

    } finally {

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
);

/* =========================================================
   VIDEO DELIVERY
========================================================= */

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

          ok:
            false,

          error:
            "Video not found."
        });
    }
  }
);

/* =========================================================
   STATUS
========================================================= */

app.get(
  "/api/status",

  async (req, res) => {

    return res.json({

      app:
        "MAMAKI AI VIDEO",

      version:
        "5.3.0",

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
        Boolean(ffmpegPath),

      interface:
        "index.html",

      aiGeneration:
        true,

      imageUpload:
        true
    });
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",

  (req, res) => {

    return res.json({

      status:
        "ok",

      app:
        "MAMAKI AI VIDEO",

      version:
        "5.3.0"
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "======================================"
    );

    console.log(
      "MAMAKI AI VIDEO v5.3.0"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `INDEX: ${INDEX}`
    );

    console.log(
      `REPLICATE TOKEN: ${
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
      `TEXT TO VIDEO: ${T2V_MODEL}`
    );

    console.log(
      `IMAGE TO VIDEO: ${I2V_MODEL}`
    );

    console.log(
      "DIRECT IMAGE UPLOAD: ENABLED"
    );

    console.log(
      "AI GENERATION: ENABLED"
    );

    console.log(
      "======================================"
    );
  }
);
