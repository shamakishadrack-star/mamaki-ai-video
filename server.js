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
MAMAKI BUSINESS SETTINGS
=========================================================
*/

const CREDIT_PRICE_USD =
  0.068;

/*
1 AI credit = 1 second of AI video.

IMPORTANT:
The final project can be much longer than the
AI-generated video because MAMAKI can assemble:

AI clips
AI images
photos
templates
text
transitions
user media
narration
*/

const FREE_CREDITS =
  15;

const MAX_SINGLE_AI_CLIP_SECONDS =
  10;

const MIN_AI_CLIP_SECONDS =
  5;

/*
=========================================================
DIRECTORIES
=========================================================
*/

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

/*
=========================================================
MIDDLEWARE
=========================================================
*/

app.use(
  express.json({
    limit: "20mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "20mb"
  })
);

app.use(
  express.static(ROOT, {
    index: false
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
    return res.status(404).send(
      "MAMAKI interface not found."
    );
  }
});

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
        100 * 1024 * 1024,

      files: 10
    }
  });

/*
=========================================================
HELPERS
=========================================================
*/

function isImage(file) {
  return !!file &&
    [
      "image/jpeg",
      "image/png",
      "image/webp"
    ].includes(file.mimetype);
}

function duration(value) {
  const n =
    Number(value || 5);

  if (!Number.isFinite(n)) {
    return 5;
  }

  return Math.max(
    MIN_AI_CLIP_SECONDS,
    Math.min(
      MAX_SINGLE_AI_CLIP_SECONDS,
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

function imageToDataUri(
  buffer,
  mimetype
) {
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
REPLICATE VIDEO OUTPUT
=========================================================
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
    "Unsupported Replicate video output."
  );
}

/*
=========================================================
GENERATE ONE AI VIDEO CLIP
=========================================================
*/

async function generateAIClip({
  prompt,
  seconds,
  ratio,
  image
}) {
  if (!replicate) {
    throw new Error(
      "REPLICATE_API_TOKEN is missing."
    );
  }

  const cleanPrompt =
    String(prompt || "").trim();

  if (!cleanPrompt) {
    throw new Error(
      "AI video prompt is empty."
    );
  }

  const clipDuration =
    duration(seconds);

  /*
  -------------------------------------------------------
  IMAGE → VIDEO
  -------------------------------------------------------
  */

  if (image) {
    console.log(
      "MAMAKI: IMAGE → VIDEO"
    );

    const imageUri =
      imageToDataUri(
        image.buffer,
        image.mimetype
      );

    const output =
      await replicate.run(
        I2V_MODEL,
        {
          input: {
            image: imageUri,
            prompt: cleanPrompt,
            duration: clipDuration,
            resolution: "720p",
            negative_prompt:
              "blurry, distorted, flickering, deformed, low quality",
            enable_prompt_expansion: true
          }
        }
      );

    return getVideoBuffer(output);
  }

  /*
  -------------------------------------------------------
  TEXT → VIDEO
  -------------------------------------------------------
  */

  console.log(
    "MAMAKI: TEXT → VIDEO"
  );

  const output =
    await replicate.run(
      T2V_MODEL,
      {
        input: {
          prompt: cleanPrompt,
          size: size(ratio),
          duration: clipDuration,
          negative_prompt:
            "blurry, distorted, flickering, deformed, low quality",
          enable_prompt_expansion: true
        }
      }
    );

  return getVideoBuffer(output);
}

/*
=========================================================
LONG SCRIPT PLANNER
=========================================================
*/

function estimateScenes(
  script
) {
  const text =
    String(script || "").trim();

  if (!text) {
    return [];
  }

  /*
  Rough narration estimate.

  Average spoken narration:
  about 130 words/minute.
  */

  const words =
    text.split(/\s+/).filter(Boolean);

  const estimatedMinutes =
    Math.max(
      1,
      Math.ceil(words.length / 130)
    );

  /*
  One visual scene roughly every
  20 seconds.

  This is only a planning estimate.
  */

  const sceneCount =
    Math.max(
      1,
      Math.ceil(
        (estimatedMinutes * 60) / 20
      )
    );

  const scenes = [];

  for (
    let i = 0;
    i < sceneCount;
    i++
  ) {
    scenes.push({
      scene:
        i + 1,

      type:
        i % 3 === 0
          ? "ai-video"
          : "ai-image-or-template",

      estimatedDuration:
        20
    });
  }

  return {
    wordCount:
      words.length,

    estimatedMinutes,

    estimatedFinalSeconds:
      estimatedMinutes * 60,

    sceneCount,

    scenes
  };
}

/*
=========================================================
LONG VIDEO PLAN API

THIS DOES NOT SPEND REPLICATE CREDIT.
=========================================================
*/

app.post(
  "/api/long-video/plan",

  async (req, res) => {
    try {
      const script =
        String(
          req.body?.script || ""
        ).trim();

      if (!script) {
        return res.status(400).json({
          ok: false,
          error:
            "Paste your script first."
        });
      }

      const plan =
        estimateScenes(script);

      /*
      Conservative default:

      Only a portion of the project
      is initially planned as AI video.

      The rest can use:
      images
      templates
      text
      transitions
      user media
      */

      const aiVideoMinutes =
        Math.min(
          10,
          Math.max(
            1,
            Math.ceil(
              plan.estimatedMinutes * 0.08
            )
          )
        );

      const aiVideoSeconds =
        aiVideoMinutes * 60;

      const estimatedAI =
        aiVideoSeconds *
        CREDIT_PRICE_USD;

      return res.json({
        ok: true,

        plan,

        strategy: {
          finalVideo:
            `${plan.estimatedMinutes} minutes`,

          aiVideoSeconds,

          aiVideoMinutes,

          estimatedAICostUSD:
            Number(
              estimatedAI.toFixed(2)
            ),

          freeAssembly:
            true,

          narration:
            true,

          images:
            true,

          templates:
            true,

          transitions:
            true,

          ffmpeg:
            true
        },

        message:
          "Plan created without spending AI credits."
      });

    } catch (error) {
      console.error(
        "LONG VIDEO PLAN ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Could not create video plan."
      });
    }
  }
);

/*
=========================================================
VOICE
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
      "Unable to read generated voice."
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
FFMPEG
=========================================================
*/

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

/*
=========================================================
GENERATE NORMAL VIDEO API
=========================================================
*/

app.post(
  "/api/generate",

  upload.fields([
    {
      name:
        "referenceImage",
      maxCount: 1
    },

    {
      name:
        "music",
      maxCount: 1
    },

    {
      name:
        "effects",
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
        return res.status(503).json({
          ok: false,
          success: false,
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
        return res.status(400).json({
          ok: false,
          success: false,
          error:
            "Enter a video prompt."
        });
      }

      let referenceImage =
        null;

      if (
        files
          .referenceImage?.[0]
      ) {
        const file =
          files
            .referenceImage[0];

        if (!isImage(file)) {
          throw new Error(
            "Reference image must be JPG, PNG, or WebP."
          );
        }

        referenceImage = {
          buffer:
            file.buffer,

          mimetype:
            file.mimetype
        };
      }

      /*
      -------------------------------------------------------
      AI GENERATION
      -------------------------------------------------------
      */

      const videoBuffer =
        await generateAIClip({
          prompt,
          seconds,
          ratio,
          image:
            referenceImage
        });

      if (
        !videoBuffer ||
        !videoBuffer.length
      ) {
        throw new Error(
          "AI returned an empty video."
        );
      }

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

      /*
      -------------------------------------------------------
      OPTIONAL VOICE
      -------------------------------------------------------
      */

      if (
        body.voiceEnabled !==
          "false" &&
        script
      ) {
        try {
          const voicePath =
            path.join(
              jobDir,
              "voice.mp3"
            );

          await createVoice(
            script,
            voicePath
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

      return res.json({
        ok: true,
        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            videoName
          )}`,

        file:
          videoName,

        creditsUsed:
          seconds,

        estimatedModelCostUSD:
          Number(
            (
              seconds *
              CREDIT_PRICE_USD
            ).toFixed(3)
          ),

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

    const video =
      path.join(
        OUTPUT,
        filename
      );

    try {
      await fs.access(video);

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${filename}"`
      );

      return res.sendFile(video);

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

      pricePerAISecondUSD:
        CREDIT_PRICE_USD,

      freeCreatorCredits:
        FREE_CREDITS,

      maxSingleAIClipSeconds:
        MAX_SINGLE_AI_CLIP_SECONDS,

      longVideoPlanning:
        true,

      freeEditing:
        true,

      photoVideoMaker:
        true,

      templates:
        true,

      ffmpeg:
        Boolean(ffmpegPath),

      interface:
        "index.html",

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

  (req, res) => {
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
      "MAMAKI AI VIDEO v6.0.0"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `TEXT → VIDEO: ${T2V_MODEL}`
    );

    console.log(
      `IMAGE → VIDEO: ${I2V_MODEL}`
    );

    console.log(
      `AI COST: $${CREDIT_PRICE_USD}/second`
    );

    console.log(
      `FREE CREDITS: ${FREE_CREDITS}`
    );

    console.log(
      `FFMPEG: ${
        ffmpegPath
          ? "FOUND"
          : "MISSING"
      }`
    );

    console.log(
      "LONG VIDEO PLANNER: ENABLED"
    );

    console.log(
      "FREE CREATOR TOOLS: ENABLED"
    );

    console.log(
      "======================================"
    );
  }
);
