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
MAMAKI CREDIT SYSTEM
=========================================================

1 credit = 1 second

5 second video = 5 credits
10 second video = 10 credits

New user = 15 free credits
*/

const NEW_USER_CREDITS = 15;
const CREDIT_PER_SECOND = 1;

/*
Approximate Replicate provider cost.

Wan 2.5 Fast 720p:
$0.068 / second
*/

const PROVIDER_COST_PER_SECOND = 0.068;

/*
=========================================================
FILES
=========================================================
*/

const TMP =
  path.join(ROOT, "tmp");

const OUTPUT =
  path.join(ROOT, "outputs");

const INDEX =
  path.join(ROOT, "index.html");

await fs.mkdir(
  TMP,
  {
    recursive: true
  }
);

await fs.mkdir(
  OUTPUT,
  {
    recursive: true
  }
);

/*
=========================================================
EXPRESS
=========================================================
*/

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

/*
=========================================================
MAMAKI INTERFACE
=========================================================
*/

app.get(
  "/",
  async (req, res) => {
    try {
      await fs.access(INDEX);

      return res.sendFile(INDEX);

    } catch {
      return res.status(404).send(
        "MAMAKI interface not found."
      );
    }
  }
);

app.use(
  express.static(
    ROOT,
    {
      index: false
    }
  )
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
        100 * 1024 * 1024,

      files: 10
    }
  });

/*
=========================================================
TEMPORARY USER CREDIT SYSTEM
=========================================================

IMPORTANT:

This is the first working version.

Credits are associated with a browser
using an HTTP cookie.

For the final public Play Store/web
version we should move this to a
real database such as PostgreSQL.

=========================================================
*/

const users =
  new Map();

function getUserId(req) {

  let userId =
    req.headers[
      "x-mamaki-user"
    ];

  if (
    !userId ||
    typeof userId !== "string"
  ) {
    userId =
      randomUUID();
  }

  return userId;
}

function getUser(req) {

  const userId =
    getUserId(req);

  if (!users.has(userId)) {

    users.set(
      userId,
      {
        credits:
          NEW_USER_CREDITS,

        reserved:
          0,

        createdAt:
          new Date().toISOString(),

        generations:
          0
      }
    );
  }

  return {
    userId,
    user:
      users.get(userId)
  };
}

/*
=========================================================
CREDIT RESERVATION
=========================================================
*/

function reserveCredits(
  req,
  seconds
) {

  const {
    userId,
    user
  } =
    getUser(req);

  const required =
    seconds *
    CREDIT_PER_SECOND;

  if (
    user.credits <
    required
  ) {

    const error =
      new Error(
        `Not enough MAMAKI credits. You need ${required} credits but only have ${user.credits}.`
      );

    error.code =
      "INSUFFICIENT_CREDITS";

    throw error;
  }

  user.credits -=
    required;

  user.reserved +=
    required;

  return {
    userId,
    required
  };
}

/*
=========================================================
CONFIRM CREDITS
=========================================================
*/

function confirmCredits(
  reservation
) {

  const user =
    users.get(
      reservation.userId
    );

  if (!user) {
    return;
  }

  user.reserved -=
    reservation.required;

  user.generations += 1;
}

/*
=========================================================
REFUND CREDITS
=========================================================
*/

function refundCredits(
  reservation
) {

  const user =
    users.get(
      reservation.userId
    );

  if (!user) {
    return;
  }

  user.reserved -=
    reservation.required;

  user.credits +=
    reservation.required;
}

/*
=========================================================
DURATION
=========================================================
*/

function duration(value) {

  const n =
    Number(value || 5);

  if (
    !Number.isFinite(n)
  ) {
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

/*
=========================================================
VIDEO SIZE
=========================================================
*/

function size(ratio) {

  if (
    ratio === "9:16"
  ) {
    return "720*1280";
  }

  if (
    ratio === "16:9"
  ) {
    return "1280*720";
  }

  if (
    ratio === "1:1"
  ) {
    return "720*720";
  }

  return "1280*720";
}

/*
=========================================================
IMAGE VALIDATION
=========================================================
*/

function isImage(file) {

  return !!file &&
    [
      "image/jpeg",
      "image/png",
      "image/webp"
    ].includes(
      file.mimetype
    );
}

/*
=========================================================
IMAGE → DATA URI
=========================================================
*/

function imageToDataUri(
  buffer,
  mimetype
) {

  if (!buffer) {
    return null;
  }

  const type =
    mimetype ||
    "image/jpeg";

  return (
    `data:${type};base64,` +
    buffer.toString("base64")
  );
}

/*
=========================================================
REPLICATE OUTPUT
=========================================================
*/

async function getVideoBuffer(
  output
) {

  const item =
    Array.isArray(output)
      ? output[0]
      : output;

  if (!item) {

    throw new Error(
      "Replicate returned no video output."
    );
  }

  if (
    Buffer.isBuffer(item)
  ) {
    return item;
  }

  if (
    item instanceof Uint8Array
  ) {
    return Buffer.from(item);
  }

  if (
    typeof item.url ===
    "function"
  ) {

    const response =
      await fetch(
        item.url()
      );

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
    typeof item ===
    "string"
  ) {

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
    typeof item.url ===
    "string"
  ) {

    const response =
      await fetch(
        item.url
      );

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
MAMAKI AI GENERATION
=========================================================
*/

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
    String(
      prompt || ""
    ).trim();

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

  /*
  =======================================================
  IMAGE → VIDEO
  =======================================================
  */

  if (image) {

    console.log(
      "MODE: IMAGE TO VIDEO"
    );

    console.log(
      "MODEL:",
      I2V_MODEL
    );

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

    try {

      const output =
        await replicate.run(
          I2V_MODEL,
          {
            input
          }
        );

      console.log(
        "MAMAKI: Fast I2V completed."
      );

      return await getVideoBuffer(
        output
      );

    } catch (error) {

      console.error(
        "MAMAKI FAST I2V ERROR:",
        error?.stack ||
        error?.message ||
        error
      );

      throw new Error(
        `Replicate Image-to-Video failed: ${
          error?.message ||
          "Unknown error"
        }`
      );
    }
  }

  /*
  =======================================================
  TEXT → VIDEO
  =======================================================
  */

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
      "blurry, distorted, flickering, deformed, low quality",

    enable_prompt_expansion:
      true
  };

  try {

    const output =
      await replicate.run(
        T2V_MODEL,
        {
          input
        }
      );

    console.log(
      "MAMAKI: Fast T2V completed."
    );

    return await getVideoBuffer(
      output
    );

  } catch (error) {

    console.error(
      "MAMAKI FAST T2V ERROR:",
      error?.stack ||
      error?.message ||
      error
    );

    throw new Error(
      `Replicate Text-to-Video failed: ${
        error?.message ||
        "Unknown error"
      }`
    );
  }
}

/*
=========================================================
FFMPEG
=========================================================
*/

function ffmpeg(args) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

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

          if (
            code === 0
          ) {

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
MAMAKI WATERMARK
=========================================================

Adds:

MAMAKI ✨

to the top-right.

It gently fades in/out continuously.
=========================================================
*/

async function addMamakiWatermark(
  inputVideo,
  outputVideo
) {

  if (!ffmpegPath) {

    throw new Error(
      "FFmpeg is not available."
    );
  }

  /*
  DejaVu Sans is normally available
  in the Render Linux environment.

  The emoji may not render on every
  FFmpeg font installation, so we use
  "MAMAKI" plus a sparkle character
  where supported.
  */

  const fontPath =
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

  const filter =
    `drawtext=fontfile=${fontPath}:text='MAMAKI ✨':fontcolor=white:fontsize=28:borderw=2:bordercolor=black@0.55:x=w-tw-28:y=25:alpha='0.82+0.18*sin(2*PI*t/3)'`;

  await ffmpeg([
    "-y",

    "-i",
    inputVideo,

    "-vf",
    filter,

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-crf",
    "23",

    "-c:a",
    "copy",

    "-movflags",
    "+faststart",

    outputVideo
  ]);

  return outputVideo;
}

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
    String(
      text || ""
    ).trim();

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
CREDIT API
=========================================================
*/

app.get(
  "/api/credits",
  (req, res) => {

    const {
      userId,
      user
    } =
      getUser(req);

    res.setHeader(
      "X-MAMAKI-USER",
      userId
    );

    return res.json({

      ok:
        true,

      credits:
        user.credits,

      reserved:
        user.reserved,

      freeCredits:
        NEW_USER_CREDITS,

      creditPerSecond:
        CREDIT_PER_SECOND,

      providerCostPerSecond:
        PROVIDER_COST_PER_SECOND,

      freeVideos:
        Math.floor(
          user.credits / 5
        )
    });
  }
);

/*
=========================================================
GENERATE API
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
        recursive:
          true
      }
    );

    let reservation =
      null;

    try {

      if (!replicate) {

        return res
          .status(503)
          .json({

            ok:
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

            error:
              "Enter a video prompt."
          });
      }

      /*
      =====================================================
      RESERVE CREDITS
      =====================================================
      */

      try {

        reservation =
          reserveCredits(
            req,
            seconds
          );

      } catch (creditError) {

        if (
          creditError.code ===
          "INSUFFICIENT_CREDITS"
        ) {

          return res
            .status(402)
            .json({

              ok:
                false,

              code:
                "INSUFFICIENT_CREDITS",

              error:
                creditError.message
            });
        }

        throw creditError;
      }

      /*
      =====================================================
      REFERENCE IMAGE
      =====================================================
      */

      let referenceImage =
        null;

      if (
        files
          .referenceImage?.[0]
      ) {

        const file =
          files
            .referenceImage[0];

        if (
          !isImage(file)
        ) {

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
      =====================================================
      AI GENERATION
      =====================================================
      */

      console.log(
        "MAMAKI: Credits reserved:",
        reservation.required
      );

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

      /*
      =====================================================
      SAVE ORIGINAL VIDEO
      =====================================================
      */

      const rawName =
        `raw-${Date.now()}-${randomUUID()}.mp4`;

      const finalName =
        `mamaki-${Date.now()}-${randomUUID()}.mp4`;

      const rawPath =
        path.join(
          jobDir,
          rawName
        );

      const finalPath =
        path.join(
          OUTPUT,
          finalName
        );

      await fs.writeFile(
        rawPath,
        videoBuffer
      );

      /*
      =====================================================
      MAMAKI WATERMARK
      =====================================================
      */

      console.log(
        "MAMAKI: Adding watermark..."
      );

      try {

        await addMamakiWatermark(
          rawPath,
          finalPath
        );

      } catch (watermarkError) {

        console.error(
          "MAMAKI WATERMARK ERROR:",
          watermarkError?.message ||
          watermarkError
        );

        /*
        If watermarking fails, do NOT
        deliver an unwatermarked video.
        */

        throw new Error(
          "MAMAKI could not add the required watermark."
        );
      }

      /*
      =====================================================
      CONFIRM CREDITS
      =====================================================
      */

      confirmCredits(
        reservation
      );

      reservation =
        null;

      /*
      =====================================================
      OPTIONAL VOICE
      =====================================================
      */

      const script =
        String(
          body.script ||
          body.voiceText ||
          ""
        ).trim();

      if (
        body.voiceEnabled !==
          "false" &&
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

        } catch (
          voiceError
        ) {

          console.error(
            "VOICE ERROR:",
            voiceError?.message ||
            voiceError
          );
        }
      }

      /*
      =====================================================
      USER CREDIT BALANCE
      =====================================================
      */

      const {
        user
      } =
        getUser(req);

      console.log(
        "MAMAKI: Video completed."
      );

      console.log(
        "MAMAKI: Remaining credits:",
        user.credits
      );

      return res.json({

        ok:
          true,

        success:
          true,

        videoUrl:
          `/api/video/${encodeURIComponent(finalName)}`,

        file:
          finalName,

        creditsUsed:
          seconds,

        creditsRemaining:
          user.credits,

        message:
          "MAMAKI video generated successfully."
      });

    } catch (error) {

      /*
      =====================================================
      GENERATION FAILED
      =====================================================

      IMPORTANT:
      Return reserved credits.
      =====================================================
      */

      if (reservation) {

        console.log(
          "MAMAKI: Refunding credits:",
          reservation.required
        );

        refundCredits(
          reservation
        );
      }

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

          creditsRefunded:
            reservation
              ? reservation.required
              : 0,

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
        Boolean(
          replicate
        ),

      textToVideo:
        T2V_MODEL,

      imageToVideo:
        I2V_MODEL,

      providerCostPerSecond:
        PROVIDER_COST_PER_SECOND,

      mamakiCreditPerSecond:
        CREDIT_PER_SECOND,

      newUserCredits:
        NEW_USER_CREDITS,

      freeVideos:
        3,

      watermark:
        "MAMAKI ✨",

      watermarkEngine:
        "FFmpeg",

      voiceOver:
        true,

      ffmpeg:
        Boolean(
          ffmpegPath
        ),

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
      "CREDIT SYSTEM: 1 CREDIT = 1 SECOND"
    );

    console.log(
      "NEW USER: 15 FREE CREDITS"
    );

    console.log(
      "WATERMARK: MAMAKI ✨"
    );

    console.log(
      "======================================"
    );
  }
);
