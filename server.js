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
BACKEND v8
=========================================================

AI:
WAN 2.2 FAST T2V
WAN 2.2 FAST I2V

FREE STUDIO:
PHOTO → VIDEO
VIDEO TRIMMER
COMBINE CLIPS
MUSIC
NARRATION
PROJECTS

PROCESSING:
FFmpeg

WATERMARK:
MAMAKI ✨

IMPORTANT:
Wan generates short clips.
Long projects are assembled from multiple clips.
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

await fs.mkdir(
  TMP,
  { recursive: true }
);

await fs.mkdir(
  OUTPUT,
  { recursive: true }
);

await fs.mkdir(
  PROJECTS,
  { recursive: true }
);

/*
=========================================================
BODY PARSERS
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

app.get(
  "/",
  async (req, res) => {
    try {
      await fs.access(INDEX);

      return res.sendFile(
        INDEX
      );
    } catch {
      return res
        .status(404)
        .send(
          "MAMAKI index.html is missing."
        );
    }
  }
);

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

function normalizeDuration(
  value
) {
  return Math.max(
    5,
    Math.round(
      safeNumber(
        value,
        5
      )
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

function imageDataUri(
  file
) {
  return (
    `data:${file.mimetype};base64,` +
    file.buffer.toString("base64")
  );
}

/*
=========================================================
WAN FRAME CALCULATION
=========================================================
*/

function wanFrames(
  seconds
) {
  const requested =
    safeNumber(
      seconds,
      5
    );

  if (
    requested <= 5
  ) {
    return 81;
  }

  return 121;
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
WATERMARK
=========================================================
*/

async function createWatermarkASS(
  file
) {
  const content =
`[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Mamaki,Arial,28,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,
