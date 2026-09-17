import express from "express";
import multer from "multer";
import Replicate from "replicate";
import { EdgeTTS } from "edge-tts-universal";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  randomUUID,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
  createHmac,
} from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
const VERSION = "18.1.0";

const ROOT = process.cwd();
const TMP = path.join(ROOT, "tmp");
const OUTPUTS = path.join(ROOT, "outputs");
const PROJECTS = path.join(ROOT, "projects");
const DATA = path.join(ROOT, "data");

const USERS_FILE = path.join(DATA, "users.json");
const SESSIONS_FILE = path.join(DATA, "sessions.json");
const ERRORS_FILE = path.join(DATA, "errors.json");
const USAGE_FILE = path.join(DATA, "usage.json");
const RESET_FILE = path.join(DATA, "password-resets.json");
const SECURITY_FILE = path.join(DATA, "security.json");
const CREDITS_FILE = path.join(DATA, "credits.json");
const FINANCE_FILE = path.join(DATA, "finance.json");
const PRICING_FILE = path.join(DATA, "pricing.json");
const PAYMENTS_FILE = path.join(DATA, "payments.json");
const WITHDRAWALS_FILE = path.join(DATA, "withdrawals.json");

const T2V_MODEL =
  process.env.T2V_MODEL || "wan-video/wan-2.2-t2v-fast";

const I2V_MODEL =
  process.env.I2V_MODEL || "wan-video/wan-2.2-i2v-fast";

const MAX_DURATION = 7200;
const MIN_DURATION = 5;

const ADMIN_EMAIL =
  String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();

const ADMIN_PASSWORD =
  String(process.env.ADMIN_PASSWORD || "");

const SESSION_SECRET =
  String(process.env.SESSION_SECRET || "");

const REPLICATE_API_TOKEN =
  String(process.env.REPLICATE_API_TOKEN || "").trim();

const PAYSTACK_SECRET_KEY =
  String(process.env.PAYSTACK_SECRET_KEY || "").trim();

const PAYSTACK_PUBLIC_KEY =
  String(process.env.PAYSTACK_PUBLIC_KEY || "").trim();

const FX_API_URL =
  String(
    process.env.FX_API_URL ||
      "https://open.er-api.com/v6/latest/USD"
  ).trim();

const DEFAULT_USD_NGN_RATE =
  Math.max(
    1,
    Number(process.env.DEFAULT_USD_NGN_RATE || 1600)
  );

const TARGET_MARGIN =
  Math.min(
    0.90,
    Math.max(
      0.05,
      Number(
        process.env.MAMAKI_TARGET_MARGIN || 0.40
      )
    )
  );

const PAYMENT_FEE_BUFFER =
  Math.min(
    0.30,
    Math.max(
      0,
      Number(
        process.env.MAMAKI_PAYMENT_FEE_BUFFER || 0.04
      )
    )
  );

const FX_BUFFER =
  Math.min(
    0.30,
    Math.max(
      0,
      Number(process.env.MAMAKI_FX_BUFFER || 0.05)
    )
  );

const PROVIDER_COST_480P_USD =
  Math.max(
    0.0001,
    Number(
      process.env.WAN_480P_COST_USD || 0.05
    )
  );

const PROVIDER_COST_720P_USD =
  Math.max(
    PROVIDER_COST_480P_USD,
    Number(
      process.env.WAN_720P_COST_USD || 0.10
    )
  );

const PAYSTACK_CURRENCY_DEFAULT =
  String(
    process.env.PAYSTACK_CURRENCY_DEFAULT || "NGN"
  ).toUpperCase();

const FIXED_NGN_MARKUP_PER_USD =
  Math.max(
    0,
    Number(
      process.env.MAMAKI_FIXED_NGN_MARKUP_PER_USD || 200
    )
  );

const RESEND_API_KEY =
  String(process.env.RESEND_API_KEY || "").trim();

const RESEND_FROM =
  String(process.env.RESEND_FROM || "").trim();

const APP_URL =
  String(
    process.env.APP_URL ||
      "https://mamaki-ai-video.onrender.com"
  ).replace(/\/$/, "");

const replicate = REPLICATE_API_TOKEN
  ? new Replicate({
      auth: REPLICATE_API_TOKEN,
    })
  : null;

const jobs = new Map();
const resetRate = new Map();
const adminLoginRate = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

app.disable("x-powered-by");

app.use(
  express.json({
    limit: "20mb",
    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "20mb",
  })
);

app.use((req, res, next) => {
  res.setHeader("X-MAMAKI-Version", VERSION);
  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );
  res.setHeader(
    "Referrer-Policy",
    "no-referrer"
  );
  res.setHeader(
    "X-Frame-Options",
    "SAMEORIGIN"
  );
  next();
});

async function ensureStorage() {
  await fs.mkdir(TMP, {
    recursive: true,
  });

  await fs.mkdir(OUTPUTS, {
    recursive: true,
  });

  await fs.mkdir(PROJECTS, {
    recursive: true,
  });

  await fs.mkdir(DATA, {
    recursive: true,
  });

  for (const file of [
    USERS_FILE,
    SESSIONS_FILE,
    ERRORS_FILE,
    USAGE_FILE,
    RESET_FILE,
    SECURITY_FILE,
    CREDITS_FILE,
    FINANCE_FILE,
    PRICING_FILE,
    PAYMENTS_FILE,
    WITHDRAWALS_FILE,
  ]) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(
        file,
        "{}",
        "utf8"
      );
    }
  }
}

async function readJson(
  file,
  fallback = {}
) {
  try {
    const raw = await fs.readFile(
      file,
      "utf8"
    );

    if (!raw.trim()) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  const temp =
    `${file}.${randomUUID()}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify(
      data,
      null,
      2
    ),
    "utf8"
  );

  await fs.rename(
    temp,
    file
  );
}

function cleanText(
  value,
  max = 10000
) {
  return String(
    value || ""
  )
    .replace(/\0/g, "")
    .trim()
    .slice(0, max);
}

function normalizeEmail(value) {
  return cleanText(
    value,
    200
  ).toLowerCase();
}

function normalizeDuration(value) {
  if (typeof value === "string") {
    const match =
      value
        .trim()
        .match(
          /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/i
        );

    if (match) {
      let n = Number(
        match[1]
      );

      const unit =
        String(
          match[2] || "s"
        ).toLowerCase();

      if (
        ["m", "min", "mins"]
          .includes(unit)
      ) {
        n *= 60;
      }

      if (
        ["h", "hr", "hrs"]
          .includes(unit)
      ) {
        n *= 3600;
      }

      return Math.max(
        MIN_DURATION,
        Math.min(
          MAX_DURATION,
          Math.round(n)
        )
      );
    }
  }

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return MIN_DURATION;
  }

  return Math.max(
    MIN_DURATION,
    Math.min(
      MAX_DURATION,
      Math.round(n)
    )
  );
}

function normalizeRatio(value) {
  const v =
    String(
      value || "16:9"
    );

  return [
    "16:9",
    "9:16",
    "1:1",
  ].includes(v)
    ? v
    : "16:9";
}

function ratioSize(ratio) {
  if (ratio === "9:16") {
    return "1080:1920";
  }

  if (ratio === "1:1") {
    return "1080:1080";
  }

  return "1920:1080";
}

function wanFrames(seconds) {
  return Number(seconds) <= 5
    ? 81
    : 121;
}

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

function safeFileName(
  name,
  fallback = "file"
) {
  const base =
    path.basename(
      String(
        name || fallback
      )
    );

  return base
    .replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    )
    .slice(0, 150);
}

function hashPassword(
  password,
  salt = randomBytes(16).toString("hex")
) {
  const hash =
    scryptSync(
      String(password),
      salt,
      64
    ).toString("hex");

  return {
    salt,
    hash,
  };
}

function verifyPassword(
  password,
  salt,
  expectedHash
) {
  try {
    const actual =
      scryptSync(
        String(password),
        salt,
        64
      );

    const expected =
      Buffer.from(
        expectedHash,
        "hex"
      );

    if (
      actual.length !==
      expected.length
    ) {
      return false;
    }

    return timingSafeEqual(
      actual,
      expected
    );
  } catch {
    return false;
  }
}

function createToken() {
  const random =
    randomBytes(
      32
    ).toString("hex");

  const secretPart =
    SESSION_SECRET
      ? scryptSync(
          SESSION_SECRET,
          random.slice(0, 16),
          32
        ).toString("hex")
      : "";

  return `${random}.${secretPart}`;
}

async function createSession(
  userId,
  role = "user"
) {
  const sessions =
    await readJson(
      SESSIONS_FILE,
      {}
    );

  const token =
    createToken();

  sessions[token] = {
    userId,
    role,
    createdAt:
      Date.now(),
    lastSeen:
      Date.now(),
  };

  await writeJson(
    SESSIONS_FILE,
    sessions
  );

  return token;
}

function getBearerToken(req) {
  const header =
    String(
      req.headers.authorization ||
        ""
    );

  if (
    !header
      .toLowerCase()
      .startsWith("bearer ")
  ) {
    return "";
  }

  return header
    .slice(7)
    .trim();
}

async function invalidateUserSessions(
  userId
) {
  const sessions =
    await readJson(
      SESSIONS_FILE,
      {}
    );

  let changed = false;

  for (
    const [
      token,
      session,
    ] of Object.entries(
      sessions
    )
  ) {
    if (
      session.userId ===
      userId
    ) {
      delete sessions[
        token
      ];

      changed = true;
    }
  }

  if (changed) {
    await writeJson(
      SESSIONS_FILE,
      sessions
    );
  }
}

async function getSession(req) {
  const token =
    getBearerToken(req);

  if (!token) {
    return null;
  }

  const sessions =
    await readJson(
      SESSIONS_FILE,
      {}
    );

  const session =
    sessions[token];

  if (!session) {
    return null;
  }

  const maxAge =
    30 *
    24 *
    60 *
    60 *
    1000;

  if (
    Date.now() -
      Number(
        session.createdAt ||
          0
      ) >
    maxAge
  ) {
    delete sessions[
      token
    ];

    await writeJson(
      SESSIONS_FILE,
      sessions
    );

    return null;
  }

  session.lastSeen =
    Date.now();

  sessions[token] =
    session;

  await writeJson(
    SESSIONS_FILE,
    sessions
  );

  return {
    token,
    ...session,
  };
}

async function getCurrentUser(req) {
  const session =
    await getSession(req);

  if (!session) {
    return null;
  }

  const users =
    await readJson(
      USERS_FILE,
      {}
    );

  const user =
    users[session.userId];

  if (
    !user ||
    user.disabled
  ) {
    return null;
  }

  return {
    ...user,
    sessionRole:
      session.role,
  };
}

async function requireUser(
  req,
  res,
  next
) {
  const user =
    await getCurrentUser(req);

  if (!user) {
    return res.status(401).json({
      ok: false,
      error:
        "AUTH_REQUIRED",
      message:
        "Please log in to your MAMAKI account.",
    });
  }

  req.user = user;
  next();
}

async function requireAdmin(
  req,
  res,
  next
) {
  const user =
    await getCurrentUser(req);

  if (
    !user ||
    user.role !== "admin"
  ) {
    return res.status(403).json({
      ok: false,
      error:
        "ADMIN_REQUIRED",
      message:
        "Administrator access required.",
    });
  }

  req.user = user;
  next();
}

async function recordError(
  error,
  context = {}
) {
  try {
    const errors =
      await readJson(
        ERRORS_FILE,
        {}
      );

    const id =
      randomUUID();

    errors[id] = {
      id,
      createdAt:
        new Date().toISOString(),
      message:
        String(
          error?.message ||
            error ||
            "Unknown error"
        ).slice(0, 2000),
      code:
        String(
          error?.code || ""
        ).slice(0, 100),
      context,
    };

    const ids =
      Object.keys(
        errors
      );

    if (
      ids.length >
      500
    ) {
      ids.sort(
        (a, b) =>
          String(
            errors[a]
              .createdAt ||
              ""
          ).localeCompare(
            String(
              errors[b]
                .createdAt ||
                ""
            )
          )
      );

      while (
        ids.length >
        500
      ) {
        const old =
          ids.shift();

        if (old) {
          delete errors[
            old
          ];
        }
      }
    }

    await writeJson(
      ERRORS_FILE,
      errors
    );
  } catch {
    // Logging must never crash the application.
  }
}

async function recordUsage(
  userId,
  type,
  seconds = 0
) {
  if (!userId) {
    return;
  }

  const usage =
    await readJson(
      USAGE_FILE,
      {}
    );

  if (!usage[userId]) {
    usage[userId] = {
      userId,
      aiGenerations: 0,
      aiSeconds: 0,
      studioJobs: 0,
      narrationJobs: 0,
      updatedAt:
        Date.now(),
    };
  }

  if (type === "ai") {
    usage[userId]
      .aiGenerations += 1;

    usage[userId]
      .aiSeconds +=
      Number(
        seconds || 0
      );
  }

  if (type === "studio") {
    usage[userId]
      .studioJobs += 1;
  }

  if (type === "narration") {
    usage[userId]
      .narrationJobs += 1;
  }

  usage[userId]
    .updatedAt =
    Date.now();

  await writeJson(
    USAGE_FILE,
    usage
  );
}

function classifyReplicateError(
  error
) {
  const text =
    String(
      error?.message ||
        error ||
        ""
    ).toLowerCase();

  if (
    text.includes("402") ||
    text.includes(
      "payment required"
    ) ||
    text.includes(
      "insufficient credit"
    ) ||
    text.includes(
      "insufficient funds"
    ) ||
    text.includes(
      "billing"
    ) ||
    text.includes(
      "credit"
    )
  ) {
    return {
      code:
        "REPLICATE_CREDIT_REQUIRED",
      message:
        "Replicate requires available credit or billing before this AI generation can start.",
    };
  }

  if (
    text.includes("401") ||
    text.includes(
      "unauthorized"
    ) ||
    text.includes(
      "authentication"
    ) ||
    text.includes(
      "invalid api token"
    ) ||
    text.includes(
      "api token"
    )
  ) {
    return {
      code:
        "REPLICATE_AUTH_REQUIRED",
      message:
        "Replicate authentication is missing or invalid. Check REPLICATE_API_TOKEN in Render.",
    };
  }

  if (
    text.includes("403") ||
    text.includes(
      "forbidden"
    )
  ) {
    return {
      code:
        "REPLICATE_FORBIDDEN",
      message:
        "Replicate rejected this request. Check account permissions, model access and billing.",
    };
  }

  if (
    text.includes("429") ||
    text.includes(
      "rate limit"
    ) ||
    text.includes(
      "too many"
    )
  ) {
    return {
      code:
        "REPLICATE_RATE_LIMIT",
      message:
        "Replicate rate limit reached. Please wait and try again.",
    };
  }

  return {
    code:
      "REPLICATE_GENERATION_FAILED",
    message:
      "Replicate could not start or complete the AI generation.",
  };
}

async function downloadToFile(
  url,
  destination
) {
  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Download failed with HTTP ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  await fs.writeFile(
    destination,
    buffer
  );

  return destination;
}

async function downloadReplicateOutput(
  output,
  destination
) {
  if (!output) {
    throw new Error(
      "Replicate returned no output."
    );
  }

  if (
    typeof output ===
      "string" &&
    /^https?:\/\//i.test(
      output
    )
  ) {
    return downloadToFile(
      output,
      destination
    );
  }

  if (
    output &&
    typeof output.url ===
      "function"
  ) {
    const url =
      await output.url();

    return downloadToFile(
      String(url),
      destination
    );
  }

  if (
    output &&
    typeof output.url ===
      "string"
  ) {
    return downloadToFile(
      output.url,
      destination
    );
  }

  if (
    Buffer.isBuffer(
      output
    )
  ) {
    await fs.writeFile(
      destination,
      output
    );

    return destination;
  }

  if (
    output instanceof
    Uint8Array
  ) {
    await fs.writeFile(
      destination,
      Buffer.from(
        output
      )
    );

    return destination;
  }

  if (
    Array.isArray(
      output
    ) &&
    output.length > 0
  ) {
    return downloadReplicateOutput(
      output[0],
      destination
    );
  }

  if (
    output &&
    typeof output ===
      "object"
  ) {
    for (
      const key of [
        "video",
        "output",
        "url",
        "file",
      ]
    ) {
      if (
        output[key]
      ) {
        return downloadReplicateOutput(
          output[key],
          destination
        );
      }
    }
  }

  throw new Error(
    "Replicate finished without returning a usable video file."
  );
}

async function runFFmpeg(
  args
) {
  return new Promise(
    (resolve, reject) => {
      const child =
        spawn(
          ffmpegPath,
          args,
          {
            stdio: [
              "ignore",
              "pipe",
              "pipe",
            ],
          }
        );

      let stderr = "";

      child.stderr.on(
        "data",
        (chunk) => {
          stderr +=
            chunk.toString();
        }
      );

      child.on(
        "error",
        reject
      );

      child.on(
        "close",
        (code) => {
          if (
            code === 0
          ) {
            return resolve();
          }

          const error =
            new Error(
              `FFmpeg failed with code ${code}: ${stderr.slice(-4000)}`
            );

          error.code =
            "FFMPEG_FAILED";

          reject(error);
        }
      );
    }
  );
}

async function addWatermark(
  input,
  output
) {
  const filter =
    "drawtext=text='MAMAKI ✨':fontcolor=white@0.78:fontsize=28:borderw=2:bordercolor=black@0.45:x=w-tw-28:y=h-th-24";

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
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    output,
  ]);

  return output;
}

async function forceDuration(
  input,
  output,
  seconds
) {
  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-t",
    String(seconds),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    output,
  ]);

  return output;
}

async function resizeVideo(
  input,
  output,
  ratio
) {
  const size =
    ratioSize(
      ratio
    );

  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    `scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    output,
  ]);

  return output;
}

async function createSoftMusic(
  output,
  seconds = 5
) {
  const duration =
    Math.max(
      1,
      Number(seconds)
    );

  await runFFmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=220:sample_rate=44100:duration=${duration}`,
    "-af",
    `volume=0.035,afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(
      0,
      duration - 1
    )}:d=1`,
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    output,
  ]);

  return output;
}

async function attachAudio(
  video,
  audio,
  output
) {
  await runFFmpeg([
    "-y",
    "-i",
    video,
    "-i",
    audio,
    "-filter_complex",
    "[1:a]volume=0.18[a1];[0:a][a1]amix=inputs=2:duration=first:dropout_transition=2[a]",
    "-map",
    "0:v:0",
    "-map",
    "[a]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-shortest",
    "-movflags",
    "+faststart",
    output,
  ]);

  return output;
}

async function combineVideoFiles(
  files,
  output
) {
  const listFile =
    path.join(
      TMP,
      `${randomUUID()}.txt`
    );

  const content =
    files
      .map(
        (file) =>
          `file '${file.replace(
            /'/g,
            "'\\''"
          )}'`
      )
      .join("\n");

  await fs.writeFile(
    listFile,
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
      listFile,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output,
    ]);
  } catch {
    await runFFmpeg([
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
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      output,
    ]);
  } finally {
    await fs.unlink(
      listFile
    ).catch(() => {});
  }

  return output;
}

function splitIntoScenes(
  script,
  targetSeconds
) {
  const text =
    cleanText(
      script,
      30000
    );

  if (!text) {
    return [];
  }

  const chunks =
    text
      .split(
        /(?<=[.!?])\s+|\n+/
      )
      .map(
        (x) =>
          x.trim()
      )
      .filter(Boolean);

  const maxScenes =
    Math.max(
      1,
      Math.ceil(
        targetSeconds /
          5
      )
    );

  if (
    chunks.length <=
    maxScenes
  ) {
    return chunks;
  }

  const scenes = [];

  const perScene =
    Math.ceil(
      chunks.length /
        maxScenes
    );

  for (
    let i = 0;
    i < chunks.length;
    i += perScene
  ) {
    scenes.push(
      chunks
        .slice(
          i,
          i + perScene
        )
        .join(" ")
    );
  }

  return scenes;
}

function enhancePrompt(
  prompt,
  style = "Cinematic"
) {
  const clean =
    cleanText(
      prompt,
      5000
    );

  if (!clean) {
    return "";
  }

  return [
    clean,
    `Visual style: ${style}.`,
    "Create a coherent professional video sequence.",
    "Use strong composition, natural motion, consistent subjects, realistic lighting, cinematic depth and detailed environments.",
    "Maintain continuity between shots.",
    "Avoid text overlays, logos and unwanted distortions.",
    "Use smooth camera movement appropriate to the scene.",
  ].join(" ");
}

function getQualitySettings(
  quality
) {
  const q =
    String(
      quality || "Standard HD"
    ).toLowerCase();

  if (
    q.includes("cinematic")
  ) {
    return {
      quality:
        "Cinematic",
      resolution:
        "720p",
      cost:
        PROVIDER_COST_720P_USD,
    };
  }

  if (
    q.includes("high")
  ) {
    return {
      quality:
        "High",
      resolution:
        "720p",
      cost:
        PROVIDER_COST_720P_USD,
    };
  }

  return {
    quality:
      "Standard HD",
    resolution:
      "480p",
    cost:
      PROVIDER_COST_480P_USD,
  };
}

function creditsForSeconds(
  seconds
) {
  return Math.max(
    10,
    Math.ceil(
      Number(seconds) /
        5
    ) * 10
  );
}

function providerCostFor(
  seconds,
  quality
) {
  const settings =
    getQualitySettings(
      quality
    );

  const blocks =
    Math.max(
      1,
      Math.ceil(
        Number(seconds) /
          5
      )
    );

  return (
    blocks *
    settings.cost
  );
}

async function getUserCredits(
  userId
) {
  const credits =
    await readJson(
      CREDITS_FILE,
      {}
    );

  if (!credits[userId]) {
    credits[userId] = {
      userId,
      credits: 100,
      issued: 100,
      consumed: 0,
      refunded: 0,
      updatedAt:
        new Date().toISOString(),
    };

    await writeJson(
      CREDITS_FILE,
      credits
    );
  }

  return credits[userId];
}

async function changeUserCredits(
  userId,
  amount,
  reason = "manual"
) {
  const credits =
    await readJson(
      CREDITS_FILE,
      {}
    );

  if (!credits[userId]) {
    credits[userId] = {
      userId,
      credits: 100,
      issued: 100,
      consumed: 0,
      refunded: 0,
      updatedAt:
        new Date().toISOString(),
    };
  }

  const n =
    Number(amount);

  credits[userId]
    .credits =
    Math.max(
      0,
      Number(
        credits[userId]
          .credits || 0
      ) + n
    );

  if (n > 0) {
    credits[userId]
      .issued += n;
  }

  credits[userId]
    .updatedAt =
    new Date().toISOString();

  await writeJson(
    CREDITS_FILE,
    credits
  );

  return credits[userId];
}

async function consumeCredits(
  userId,
  amount
) {
  const credits =
    await getUserCredits(
      userId
    );

  const n =
    Math.max(
      0,
      Number(amount)
    );

  if (
    Number(
      credits.credits || 0
    ) < n
  ) {
    const error =
      new Error(
        "Insufficient MAMAKI credits."
      );

    error.code =
      "INSUFFICIENT_CREDITS";

    throw error;
  }

  credits.credits -= n;
  credits.consumed += n;
  credits.updatedAt =
    new Date().toISOString();

  const all =
    await readJson(
      CREDITS_FILE,
      {}
    );

  all[userId] =
    credits;

  await writeJson(
    CREDITS_FILE,
    all
  );

  return credits;
}

async function refundCredits(
  userId,
  amount
) {
  const credits =
    await getUserCredits(
      userId
    );

  const n =
    Math.max(
      0,
      Number(amount)
    );

  credits.credits += n;
  credits.refunded += n;
  credits.updatedAt =
    new Date().toISOString();

  const all =
    await readJson(
      CREDITS_FILE,
      {}
    );

  all[userId] =
    credits;

  await writeJson(
    CREDITS_FILE,
    all
  );

  return credits;
}

async function recordSecurityEvent(
  type,
  details = {}
) {
  try {
    const security =
      await readJson(
        SECURITY_FILE,
        {}
      );

    const id =
      randomUUID();

    security[id] = {
      id,
      type,
      createdAt:
        new Date().toISOString(),
      ...details,
    };

    const ids =
      Object.keys(
        security
      );

    if (
      ids.length >
      500
    ) {
      ids.sort(
        (a, b) =>
          String(
            security[a]
              .createdAt ||
              ""
          ).localeCompare(
            String(
              security[b]
                .createdAt ||
                ""
            )
          )
      );

      while (
        ids.length >
        500
      ) {
        const old =
          ids.shift();

        if (old) {
          delete security[
            old
          ];
        }
      }
    }

    await writeJson(
      SECURITY_FILE,
      security
    );
  } catch {
    // Security logging must never crash the app.
  }
}

function allowedByRate(
  map,
  key,
  limit,
  windowMs
) {
  const now =
    Date.now();

  const old =
    map.get(key) || [];

  const active =
    old.filter(
      (time) =>
        now - time <
        windowMs
    );

  if (
    active.length >=
    limit
  ) {
    map.set(
      key,
      active
    );

    return false;
  }

  active.push(now);

  map.set(
    key,
    active
  );

  return true;
}

async function ensureAdminAccount() {
  if (
    !ADMIN_EMAIL ||
    !ADMIN_PASSWORD
  ) {
    return null;
  }

  const users =
    await readJson(
      USERS_FILE,
      {}
    );

  const matches =
    Object.values(
      users
    )
      .filter(
        (u) =>
          normalizeEmail(
            u.email
          ) ===
          ADMIN_EMAIL
      )
      .sort(
        (a, b) =>
          String(
            a.createdAt ||
              ""
          ).localeCompare(
            String(
              b.createdAt ||
                ""
            )
          )
      );

  let admin =
    matches[0];

  if (!admin) {
    const id =
      randomUUID();

    const credentials =
      hashPassword(
        ADMIN_PASSWORD
      );

    admin = {
      id,
      name:
        "MAMAKI Administrator",
      email:
        ADMIN_EMAIL,
      salt:
        credentials.salt,
      passwordHash:
        credentials.hash,
      role:
        "admin",
      disabled:
        false,
      createdAt:
        new Date().toISOString(),
      lastLoginAt:
        null,
    };

    users[id] =
      admin;

    await recordSecurityEvent(
      "ADMIN_ACCOUNT_CREATED",
      {
        userId:
          id,
        email:
          ADMIN_EMAIL,
      }
    );
  } else {
    admin.role =
      "admin";

    admin.disabled =
      false;

    users[admin.id] =
      admin;
  }

  for (
    const duplicate of
      matches.slice(1)
  ) {
    delete users[
      duplicate.id
    ];

    await invalidateUserSessions(
      duplicate.id
    );
  }

  await writeJson(
    USERS_FILE,
    users
  );

  await getUserCredits(
    admin.id
  );

  return admin;
}

async function createUser(
  name,
  email,
  password
) {
  const users =
    await readJson(
      USERS_FILE,
      {}
    );

  const normalized =
    normalizeEmail(
      email
    );

  const existing =
    Object.values(
      users
    ).find(
      (u) =>
        normalizeEmail(
          u.email
        ) ===
        normalized
    );

  if (existing) {
    const error =
      new Error(
        "An account with this email already exists."
      );

    error.code =
      "EMAIL_EXISTS";

    throw error;
  }

  const id =
    randomUUID();

  const credentials =
    hashPassword(
      password
    );

  const user = {
    id,
    name:
      cleanText(
        name,
        150
      ) ||
      "MAMAKI User",
    email:
      normalized,
    salt:
      credentials.salt,
    passwordHash:
      credentials.hash,
    role:
      "user",
    disabled:
      false,
    createdAt:
      new Date().toISOString(),
    lastActiveAt:
      new Date().toISOString(),
    lastLoginAt:
      null,
  };

  users[id] =
    user;

  await writeJson(
    USERS_FILE,
    users
  );

  await getUserCredits(
    id
  );

  await recordSecurityEvent(
    "USER_ACCOUNT_CREATED",
    {
      userId:
        id,
      email:
        normalized,
    }
  );

  return user;
}

async function authenticateUser(
  email,
  password
) {
  const users =
    await readJson(
      USERS_FILE,
      {}
    );

  const normalized =
    normalizeEmail(
      email
    );

  const user =
    Object.values(
      users
    ).find(
      (u) =>
        normalizeEmail(
          u.email
        ) ===
          normalized &&
        u.role !==
          "admin"
    );

  if (
    !user ||
    user.disabled
  ) {
    return null;
  }

  if (
    !verifyPassword(
      password,
      user.salt,
      user.passwordHash
    )
  ) {
    return null;
  }

  user.lastLoginAt =
    new Date().toISOString();

  user.lastActiveAt =
    new Date().toISOString();

  users[user.id] =
    user;

  await writeJson(
    USERS_FILE,
    users
  );

  return user;
}

async function authenticateAdmin(
  email,
  password
) {
  if (
    !ADMIN_EMAIL ||
    !ADMIN_PASSWORD
  ) {
    return null;
  }

  if (
    normalizeEmail(
      email
    ) !==
    ADMIN_EMAIL
  ) {
    return null;
  }

  if (
    String(password) !==
    ADMIN_PASSWORD
  ) {
    return null;
  }

  const admin =
    await ensureAdminAccount();

  if (!admin) {
    return null;
  }

  admin.lastLoginAt =
    new Date().toISOString();

  const users =
    await readJson(
      USERS_FILE,
      {}
    );

  users[admin.id] =
    admin;

  await writeJson(
    USERS_FILE,
    users
  );

  return admin;
}

async function getFXRate() {
  try {
    const response =
      await fetch(
        FX_API_URL,
        {
          headers: {
            Accept:
              "application/json",
          },
          signal:
            AbortSignal.timeout(
              8000
            ),
        }
      );

    if (!response.ok) {
      throw new Error(
        `FX HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    const rate =
      Number(
        data?.rates?.NGN
      );

    if (
      !Number.isFinite(
        rate
      ) ||
      rate <= 0
    ) {
      throw new Error(
        "Invalid FX rate."
      );
    }

    return {
      rate,
      live:
        true,
      updatedAt:
        new Date().toISOString(),
      source:
        FX_API_URL,
    };
  } catch {
    return {
      rate:
        DEFAULT_USD_NGN_RATE,
      live:
        false,
      updatedAt:
        new Date().toISOString(),
      source:
        "fallback",
    };
  }
}

function roundPrice(
  amount
) {
  return (
    Math.ceil(
      Number(amount) /
        50
    ) * 50
  );
}

async function buildPricing() {
  const fx =
    await getFXRate();

  const packages = [
    100,
    500,
    1000,
    2500,
    5000,
  ];

  const pricing =
    packages.map(
      (credits) => {
        const usdPrice =
          credits /
          100;

        const mamakiRate =
          fx.rate +
          FIXED_NGN_MARKUP_PER_USD;

        const raw =
          usdPrice *
          mamakiRate;

        const amount =
          roundPrice(
            raw
          );

        const providerCostUsd =
          providerCostFor(
            credits / 2,
            "Standard HD"
          );

        return {
          credits,
          providerCostUsd,
          usdPrice,
          amount,
          fxRate:
            fx.rate,
          mamakiRate,
          marginTarget:
            TARGET_MARGIN,
          paymentFeeBuffer:
            PAYMENT_FEE_BUFFER,
          fxBuffer:
            FX_BUFFER,
          updatedAt:
            fx.updatedAt,
        };
      }
    );

  await writeJson(
    PRICING_FILE,
    {
      updatedAt:
        new Date().toISOString(),
      fx,
      packages:
        pricing,
    }
  );

  return {
    pricing,
    fx,
  };
}

async function getPricing() {
  const stored =
    await readJson(
      PRICING_FILE,
      {}
    );

  if (
    stored.updatedAt &&
    Date.now() -
      Date.parse(
        stored.updatedAt
      ) <
      30 *
        60 *
        1000 &&
    Array.isArray(
      stored.packages
    ) &&
    stored.packages.length
  ) {
    return {
      pricing:
        stored.packages,
      fx:
        stored.fx,
    };
  }

  return buildPricing();
}

function calculateVideoQuote(
  seconds,
  quality
) {
  const duration =
    normalizeDuration(
      seconds
    );

  const credits =
    creditsForSeconds(
      duration
    );

  const providerCostUsd =
    providerCostFor(
      duration,
      quality
    );

  return {
    duration,
    credits,
    providerCostUsd,
    quality:
      getQualitySettings(
        quality
      ).quality,
  };
}

async function recordFinance(
  type,
  amount,
  description,
  metadata = {}
) {
  const finance =
    await readJson(
      FINANCE_FILE,
      {}
    );

  const id =
    randomUUID();

  finance[id] = {
    id,
    type:
      String(type || "")
        .toUpperCase(),
    amount:
      Number(amount || 0),
    description:
      cleanText(
        description,
        1000
      ),
    metadata,
    createdAt:
      new Date().toISOString(),
  };

  await writeJson(
    FINANCE_FILE,
    finance
  );

  return finance[id];
}

async function getFinanceSummary() {
  const finance =
    await readJson(
      FINANCE_FILE,
      {}
    );

  let grossRevenue = 0;
  let refunds = 0;
  let costs = 0;

  const transactions =
    Object.values(
      finance
    ).sort(
      (a, b) =>
        String(
          b.createdAt ||
            ""
        ).localeCompare(
          String(
            a.createdAt ||
              ""
          )
        )
    );

  for (
    const item of
      transactions
  ) {
    const amount =
      Number(
        item.amount || 0
      );

    const type =
      String(
        item.type || ""
      ).toUpperCase();

    if (
      type ===
      "REVENUE"
    ) {
      grossRevenue +=
        amount;
    } else if (
      type ===
      "REF
