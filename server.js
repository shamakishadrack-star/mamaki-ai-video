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

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "")
  .trim()
  .toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const SESSION_SECRET = String(process.env.SESSION_SECRET || "");
const REPLICATE_API_TOKEN = String(
  process.env.REPLICATE_API_TOKEN || ""
).trim();

const PAYSTACK_SECRET_KEY = String(
  process.env.PAYSTACK_SECRET_KEY || ""
).trim();

const PAYSTACK_PUBLIC_KEY = String(
  process.env.PAYSTACK_PUBLIC_KEY || ""
).trim();

const FX_API_URL = String(
  process.env.FX_API_URL ||
    "https://open.er-api.com/v6/latest/USD"
).trim();

const DEFAULT_USD_NGN_RATE = Math.max(
  1,
  Number(process.env.DEFAULT_USD_NGN_RATE || 1600)
);

const TARGET_MARGIN = Math.min(
  0.90,
  Math.max(
    0.05,
    Number(process.env.MAMAKI_TARGET_MARGIN || 0.40)
  )
);

const PAYMENT_FEE_BUFFER = Math.min(
  0.30,
  Math.max(
    0,
    Number(process.env.MAMAKI_PAYMENT_FEE_BUFFER || 0.04)
  )
);

const FX_BUFFER = Math.min(
  0.30,
  Math.max(
    0,
    Number(process.env.MAMAKI_FX_BUFFER || 0.05)
  )
);

const PROVIDER_COST_480P_USD = Math.max(
  0.0001,
  Number(process.env.WAN_480P_COST_USD || 0.05)
);

const PROVIDER_COST_720P_USD = Math.max(
  PROVIDER_COST_480P_USD,
  Number(process.env.WAN_720P_COST_USD || 0.10)
);

const PAYSTACK_CURRENCY_DEFAULT = String(
  process.env.PAYSTACK_CURRENCY_DEFAULT || "NGN"
).toUpperCase();

const FIXED_NGN_MARKUP_PER_USD = Math.max(
  0,
  Number(
    process.env.MAMAKI_FIXED_NGN_MARKUP_PER_USD ||
      process.env.FIXED_NGN_MARKUP_PER_USD ||
      200
  )
);

const RESEND_API_KEY = String(
  process.env.RESEND_API_KEY || ""
).trim();

const RESEND_FROM = String(
  process.env.RESEND_FROM || ""
).trim();

const APP_URL = String(
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
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  next();
});

/* =========================================================
   STORAGE
========================================================= */

async function ensureStorage() {
  await fs.mkdir(TMP, { recursive: true });
  await fs.mkdir(OUTPUTS, { recursive: true });
  await fs.mkdir(PROJECTS, { recursive: true });
  await fs.mkdir(DATA, { recursive: true });

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
      await fs.writeFile(file, "{}", "utf8");
    }
  }
}

async function readJson(file, fallback = {}) {
  try {
    const raw = await fs.readFile(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(
    temp,
    JSON.stringify(data, null, 2),
    "utf8"
  );
  await fs.rename(temp, file);
}

/* =========================================================
   GENERAL HELPERS
========================================================= */

function cleanText(value, max = 10000) {
  return String(value || "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, max);
}

function normalizeEmail(value) {
  return cleanText(value, 200).toLowerCase();
}

function normalizeDuration(value) {
  if (typeof value === "string") {
    const match = value
      .trim()
      .match(
        /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/i
      );

    if (match) {
      let n = Number(match[1]);
      const unit = String(match[2] || "s").toLowerCase();

      if (["m", "min", "mins"].includes(unit)) {
        n *= 60;
      }

      if (["h", "hr", "hrs"].includes(unit)) {
        n *= 3600;
      }

      return Math.max(
        MIN_DURATION,
        Math.min(MAX_DURATION, Math.round(n))
      );
    }
  }

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return MIN_DURATION;
  }

  return Math.max(
    MIN_DURATION,
    Math.min(MAX_DURATION, Math.round(n))
  );
}

function normalizeRatio(value) {
  const v = String(value || "16:9");

  return ["16:9", "9:16", "1:1"].includes(v)
    ? v
    : "16:9";
}

function ratioSize(ratio) {
  if (ratio === "9:16") return "1080:1920";
  if (ratio === "1:1") return "1080:1080";
  return "1920:1080";
}

function wanFrames(seconds) {
  return Number(seconds) <= 5 ? 81 : 121;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFileName(name, fallback = "file") {
  const base = path.basename(
    String(name || fallback)
  );

  return base
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 150);
}

/* =========================================================
   PASSWORDS / SESSIONS
========================================================= */

function hashPassword(
  password,
  salt = randomBytes(16).toString("hex")
) {
  const hash = scryptSync(
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
    const actual = scryptSync(
      String(password),
      salt,
      64
    );

    const expected = Buffer.from(
      expectedHash,
      "hex"
    );

    if (actual.length !== expected.length) {
      return false;
    }

    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function createToken() {
  const random = randomBytes(32).toString("hex");

  const secretPart = SESSION_SECRET
    ? scryptSync(
        SESSION_SECRET,
        random.slice(0, 16),
        32
      ).toString("hex")
    : "";

  return `${random}.${secretPart}`;
}

async function createSession(userId, role = "user") {
  const sessions = await readJson(
    SESSIONS_FILE,
    {}
  );

  const token = createToken();

  sessions[token] = {
    userId,
    role,
    createdAt: Date.now(),
    lastSeen: Date.now(),
  };

  await writeJson(
    SESSIONS_FILE,
    sessions
  );

  return token;
}

function getBearerToken(req) {
  const header = String(
    req.headers.authorization || ""
  );

  if (
    !header
      .toLowerCase()
      .startsWith("bearer ")
  ) {
    return "";
  }

  return header.slice(7).trim();
}

async function invalidateUserSessions(userId) {
  const sessions = await readJson(
    SESSIONS_FILE,
    {}
  );

  let changed = false;

  for (const [token, session] of Object.entries(
    sessions
  )) {
    if (session.userId === userId) {
      delete sessions[token];
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
  const token = getBearerToken(req);

  if (!token) return null;

  const sessions = await readJson(
    SESSIONS_FILE,
    {}
  );

  const session = sessions[token];

  if (!session) return null;

  const maxAge =
    30 * 24 * 60 * 60 * 1000;

  if (
    Date.now() -
      Number(session.createdAt || 0) >
    maxAge
  ) {
    delete sessions[token];

    await writeJson(
      SESSIONS_FILE,
      sessions
    );

    return null;
  }

  session.lastSeen = Date.now();
  sessions[token] = session;

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
  const session = await getSession(req);

  if (!session) return null;

  const users = await readJson(
    USERS_FILE,
    {}
  );

  const user = users[session.userId];

  if (!user || user.disabled) {
    return null;
  }

  user.lastActiveAt =
    new Date().toISOString();

  users[session.userId] = user;

  await writeJson(
    USERS_FILE,
    users
  );

  return {
    ...user,
    sessionRole: session.role,
  };
}

async function requireUser(
  req,
  res,
  next
) {
  const user = await getCurrentUser(req);

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: "AUTH_REQUIRED",
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
  const user = await getCurrentUser(req);

  if (!user || user.role !== "admin") {
    return res.status(403).json({
      ok: false,
      error: "ADMIN_REQUIRED",
      message:
        "Administrator access required.",
    });
  }

  req.user = user;
  next();
}

/* =========================================================
   ERROR / SECURITY / USAGE
========================================================= */

async function recordError(
  error,
  context = {}
) {
  try {
    const errors = await readJson(
      ERRORS_FILE,
      {}
    );

    const id = randomUUID();

    errors[id] = {
      id,
      createdAt:
        new Date().toISOString(),
      message: String(
        error?.message ||
          error ||
          "Unknown error"
      ).slice(0, 2000),
      code: String(
        error?.code || ""
      ).slice(0, 100),
      context,
    };

    const ids = Object.keys(errors);

    if (ids.length > 500) {
      ids.sort((a, b) =>
        String(
          errors[a].createdAt || ""
        ).localeCompare(
          String(
            errors[b].createdAt || ""
          )
        )
      );

      while (ids.length > 500) {
        const old = ids.shift();

        if (old) {
          delete errors[old];
        }
      }
    }

    await writeJson(
      ERRORS_FILE,
      errors
    );
  } catch {
    // Logging must never crash MAMAKI.
  }
}

async function recordSecurityEvent(
  type,
  details = {}
) {
  try {
    const security = await readJson(
      SECURITY_FILE,
      {}
    );

    const id = randomUUID();

    security[id] = {
      id,
      type,
      createdAt:
        new Date().toISOString(),
      ...details,
    };

    const ids = Object.keys(security);

    if (ids.length > 300) {
      ids.sort((a, b) =>
        String(
          security[a].createdAt || ""
        ).localeCompare(
          String(
            security[b].createdAt || ""
          )
        )
      );

      while (ids.length > 300) {
        const old = ids.shift();

        if (old) {
          delete security[old];
        }
      }
    }

    await writeJson(
      SECURITY_FILE,
      security
    );
  } catch {
    // Security logging must never crash the application.
  }
}

function allowedByRate(
  map,
  key,
  limit,
  windowMs
) {
  const now = Date.now();

  const current =
    map.get(key) || [];

  const recent = current.filter(
    (time) =>
      now - time < windowMs
  );

  if (recent.length >= limit) {
    map.set(key, recent);
    return false;
  }

  recent.push(now);
  map.set(key, recent);

  return true;
}

async function recordUsage(
  userId,
  type,
  seconds = 0
) {
  if (!userId) return;

  const usage = await readJson(
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
      updatedAt: Date.now(),
    };
  }

  if (type === "ai") {
    usage[userId].aiGenerations += 1;
    usage[userId].aiSeconds += Number(
      seconds || 0
    );
  }

  if (type === "studio") {
    usage[userId].studioJobs += 1;
  }

  if (type === "narration") {
    usage[userId].narrationJobs += 1;
  }

  usage[userId].updatedAt = Date.now();

  await writeJson(
    USAGE_FILE,
    usage
  );
}

/* =========================================================
   REPLICATE ERROR CLASSIFICATION
========================================================= */

function classifyReplicateError(
  error
) {
  const text = String(
    error?.message ||
      error ||
      ""
  ).toLowerCase();

  if (
    text.includes("402") ||
    text.includes("payment required") ||
    text.includes("insufficient credit") ||
    text.includes("insufficient funds") ||
    text.includes("billing") ||
    text.includes("credit")
  ) {
    return {
      code: "REPLICATE_CREDIT_REQUIRED",
      message:
        "Replicate requires available credit or billing before this AI generation can start.",
    };
  }

  if (
    text.includes("401") ||
    text.includes("unauthorized") ||
    text.includes("authentication") ||
    text.includes("invalid api token") ||
    text.includes("api token")
  ) {
    return {
      code: "REPLICATE_AUTH_REQUIRED",
      message:
        "Replicate authentication is missing or invalid. Check REPLICATE_API_TOKEN in Render.",
    };
  }

  if (
    text.includes("403") ||
    text.includes("forbidden")
  ) {
    return {
      code: "REPLICATE_FORBIDDEN",
      message:
        "Replicate rejected this request. Check account permissions, model access and billing.",
    };
  }

  if (
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("too many")
  ) {
    return {
      code: "REPLICATE_RATE_LIMIT",
      message:
        "Replicate rate limit reached. Please wait and try again.",
    };
  }

  return {
    code: "REPLICATE_GENERATION_FAILED",
    message:
      "Replicate could not start or complete the AI generation.",
  };
}

/* =========================================================
   FFMPEG / MEDIA
========================================================= */

async function downloadToFile(
  url,
  destination
) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Download failed with HTTP ${response.status}`
    );
  }

  const buffer = Buffer.from(
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
    typeof output === "string" &&
    /^https?:\/\//i.test(output)
  ) {
    return downloadToFile(
      output,
      destination
    );
  }

  if (
    output &&
    typeof output.url === "function"
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
    typeof output.url === "string"
  ) {
    return downloadToFile(
      output.url,
      destination
    );
  }

  if (Buffer.isBuffer(output)) {
    await fs.writeFile(
      destination,
      output
    );

    return destination;
  }

  if (output instanceof Uint8Array) {
    await fs.writeFile(
      destination,
      Buffer.from(output)
    );

    return destination;
  }

  if (
    Array.isArray(output) &&
    output.length > 0
  ) {
    return downloadReplicateOutput(
      output[0],
      destination
    );
  }

  if (
    output &&
    typeof output === "object"
  ) {
    for (const key of [
      "video",
      "output",
      "url",
      "file",
    ]) {
      if (output[key]) {
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

async function runFFmpeg(args) {
  return new Promise(
    (resolve, reject) => {
      const child = spawn(
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
          stderr += chunk.toString();
        }
      );

      child.on(
        "error",
        reject
      );

      child.on(
        "close",
        (code) => {
          if (code === 0) {
            return resolve();
          }

          const error = new Error(
            `FFmpeg failed with code ${code}: ${stderr.slice(
              -4000
            )}`
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
  const size = ratioSize(ratio);

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
  const duration = Math.max(
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
  const listFile = path.join(
    TMP,
    `${randomUUID()}.txt`
  );

  const content = files
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
    await fs
      .unlink(listFile)
      .catch(() => {});
  }

  return output;
}

/* =========================================================
   PROMPTS / SCENES
========================================================= */

function splitIntoScenes(
  script,
  targetSeconds
) {
  const text = cleanText(
    script,
    30000
  );

  if (!text) return [];

  const chunks = text
    .split(
      /(?<=[.!?])\s+|\n+/
    )
    .map((x) => x.trim())
    .filter(Boolean);

  const maxScenes = Math.max(
    1,
    Math.ceil(targetSeconds / 5)
  );

  if (
    chunks.length <= maxScenes
  ) {
    return chunks;
  }

  const scenes = [];

  const perScene = Math.ceil(
    chunks.length / maxScenes
  );

  for (
    let i = 0;
    i < chunks.length;
    i += perScene
  ) {
    scenes.push(
      chunks
        .slice(i, i + perScene)
        .join(" ")
    );
  }

  return scenes;
}

function enhancePrompt(
  prompt,
  style = "Cinematic"
) {
  const clean = cleanText(
    prompt,
    5000
  );

  if (!clean) return "";

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

/* =========================================================
   REPLICATE VIDEO GENERATION
========================================================= */

async function wanTextToVideo(
  prompt,
  seconds,
  ratio,
  quality
) {
  if (!replicate) {
    const error = new Error(
      "REPLICATE_API_TOKEN is not configured."
    );

    error.code =
      "REPLICATE_AUTH_REQUIRED";

    throw error;
  }

  const frames = wanFrames(
    seconds
  );

  const enhanced = enhancePrompt(
    prompt,
    "Cinematic"
  );

  const input = {
    prompt: enhanced,
    size: ratioSize(ratio),
    num_frames: frames,
  };

  const q = String(
    quality || "Standard HD"
  ).toLowerCase();

  if (
    q.includes("high") ||
    q.includes("cinematic")
  ) {
    input.go_fast = false;
  } else {
    input.go_fast = true;
  }

  const prediction =
    await replicate.predictions.create(
      {
        version: T2V_MODEL,
        input,
      }
    );

  let result = prediction;

  const started =
    Date.now();

  while (
    result.status ===
      "starting" ||
    result.status ===
      "processing"
  ) {
    if (
      Date.now() - started >
      25 * 60 * 1000
    ) {
      throw new Error(
        "Replicate generation timed out."
      );
    }

    await sleep(3000);

    result =
      await replicate.predictions.get(
        result.id
      );
  }

  if (result.status !== "succeeded") {
    throw new Error(
      result.error ||
        `Replicate generation ended with status ${result.status}.`
    );
  }

  return result.output;
}

async function wanImageToVideo(
  imagePath,
  prompt,
  seconds,
  ratio,
  quality
) {
  if (!replicate) {
    const error = new Error(
      "REPLICATE_API_TOKEN is not configured."
    );

    error.code =
      "REPLICATE_AUTH_REQUIRED";

    throw error;
  }

  const imageBuffer =
    await fs.readFile(
      imagePath
    );

  const imageBase64 =
    `data:image/png;base64,${imageBuffer.toString(
      "base64"
    )}`;

  const input = {
    image: imageBase64,
    prompt: enhancePrompt(
      prompt,
      "Cinematic"
    ),
    size: ratioSize(ratio),
    num_frames: wanFrames(
      seconds
    ),
  };

  const q = String(
    quality || "Standard HD"
  ).toLowerCase();

  if (
    q.includes("high") ||
    q.includes("cinematic")
  ) {
    input.go_fast = false;
  } else {
    input.go_fast = true;
  }

  const prediction =
    await replicate.predictions.create(
      {
        version: I2V_MODEL,
        input,
      }
    );

  let result = prediction;

  const started =
    Date.now();

  while (
    result.status ===
      "starting" ||
    result.status ===
      "processing"
  ) {
    if (
      Date.now() - started >
      25 * 60 * 1000
    ) {
      throw new Error(
        "Replicate image-to-video generation timed out."
      );
    }

    await sleep(3000);

    result =
      await replicate.predictions.get(
        result.id
      );
  }

  if (result.status !== "succeeded") {
    throw new Error(
      result.error ||
        `Replicate image-to-video ended with status ${result.status}.`
    );
  }

  return result.output;
}

async function generateSingleClip({
  prompt,
  imageBuffer,
  duration,
  ratio,
  quality,
}) {
  const id = randomUUID();

  const raw =
    path.join(
      TMP,
      `${id}-raw.mp4`
    );

  const sized =
    path.join(
      TMP,
      `${id}-sized.mp4`
    );

  const final =
    path.join(
      OUTPUTS,
      `${id}.mp4`
    );

  if (imageBuffer) {
    const imagePath =
      path.join(
        TMP,
        `${id}-input.png`
      );

    await fs.writeFile(
      imagePath,
      imageBuffer
    );

    const output =
      await wanImageToVideo(
        imagePath,
        prompt,
        duration,
        ratio,
        quality
      );

    await downloadReplicateOutput(
      output,
      raw
    );

    await resizeVideo(
      raw,
      sized,
      ratio
    );
  } else {
    const output =
      await wanTextToVideo(
        prompt,
        duration,
        ratio,
        quality
      );

    await downloadReplicateOutput(
      output,
      raw
    );

    await resizeVideo(
      raw,
      sized,
      ratio
    );
  }

  let prepared = sized;

  try {
    const metadataOutput =
      path.join(
        TMP,
        `${id}-duration.mp4`
      );

    await forceDuration(
      prepared,
      metadataOutput,
      duration
    );

    prepared =
      metadataOutput;
  } catch {
    // Preserve source if duration forcing fails.
  }

  await addWatermark(
    prepared,
    final
  );

  return final;
}

async function generateVideoProduction({
  job,
  userId,
  prompt,
  imageBuffer,
  duration,
  ratio,
  style,
  quality,
}) {
  const styledPrompt = [
    prompt,
    `Style: ${style}.`,
    "Professional production quality.",
    "Consistent subject identity.",
    "Natural motion.",
    "Cinematic lighting.",
    "No text or logos.",
  ].join(" ");

  if (
    duration <= 5
  ) {
    job.progress = 20;
    job.message =
      "MAMAKI AI is generating your video.";

    const final =
      await generateSingleClip({
        prompt: styledPrompt,
        imageBuffer,
        duration,
        ratio,
        quality,
      });

    job.progress = 90;
    job.message =
      "Applying MAMAKI finishing.";

    await recordUsage(
      userId,
      "ai",
      duration
    );

    return final;
  }

  const scenes =
    splitIntoScenes(
      prompt,
      duration
    );

  const count =
    Math.max(
      1,
      Math.ceil(
        duration / 5
      )
    );

  const actualScenes =
    scenes.length
      ? scenes
      : [prompt];

  const files = [];

  for (
    let i = 0;
    i < count;
    i++
  ) {
    if (job.cancelled) {
      throw new Error(
        "Production was cancelled."
      );
    }

    const sceneText =
      actualScenes[
        i % actualScenes.length
      ];

    const scenePrompt = [
      sceneText,
      `Overall style: ${style}.`,
      "Maintain visual continuity with the same characters, environment and subject identity.",
      "Professional cinematic composition.",
      "Natural movement.",
      "No text overlays.",
    ].join(" ");

    job.progress = Math.min(
      85,
      Math.round(
        (i / count) * 85
      )
    );

    job.message =
      `Generating scene ${
        i + 1
      } of ${count}.`;

    const file =
      await generateSingleClip({
        prompt: scenePrompt,
        imageBuffer:
          i === 0
            ? imageBuffer
            : null,
        duration:
          i === count - 1
            ? Math.max(
                1,
                duration -
                  5 *
                    (count - 1)
              )
            : 5,
        ratio,
        quality,
      });

    files.push(file);
  }

  const id = randomUUID();

  const combined =
    path.join(
      OUTPUTS,
      `${id}-combined.mp4`
    );

  const final =
    path.join(
      OUTPUTS,
      `${id}.mp4`
    );

  job.message =
    "Assembling all scenes.";

  await combineVideoFiles(
    files,
    combined
  );

  await addWatermark(
    combined,
    final
  );

  await recordUsage(
    userId,
    "ai",
    duration
  );

  return final;
}

/* =========================================================
   CREDITS
========================================================= */

const STARTER_CREDITS =
  Math.max(
    0,
    Number(
      process.env.STARTER_CREDITS ||
        100
    )
  );

const CREDITS_PER_5_SECONDS =
  Math.max(
    1,
    Number(
      process.env.CREDITS_PER_5_SECONDS ||
        10
    )
  );

async function readCredits() {
  const d =
    await readJson(
      CREDITS_FILE,
      {}
    );

  return {
    pool: Number(
      d?.pool || 0
    ),
    users:
      d &&
      typeof d.users ===
        "object" &&
      d.users
        ? d.users
        : {},
    transactions:
      Array.isArray(
        d?.transactions
      )
        ? d.transactions
        : [],
    updatedAt:
      d?.updatedAt ||
      new Date().toISOString(),
  };
}

async function writeCredits(
  d
) {
  d.updatedAt =
    new Date().toISOString();

  await writeJson(
    CREDITS_FILE,
    d
  );
}

async function getUserCredits(
  id
) {
  const d =
    await readCredits();

  if (
    !Object.prototype.hasOwnProperty.call(
      d.users,
      id
    )
  ) {
    d.users[id] =
      STARTER_CREDITS;

    d.transactions.push({
      id: randomUUID(),
      type: "ISSUE",
      source: "STARTER",
      userId: id,
      amount:
        STARTER_CREDITS,
      createdAt:
        new Date().toISOString(),
    });

    await writeCredits(d);
  }

  return Number(
    d.users[id] || 0
  );
}

async function addUserCredits(
  id,
  amount,
  source = "ADMIN"
) {
  const n = Math.floor(
    Number(amount || 0)
  );

  if (
    !Number.isFinite(n) ||
    n <= 0
  ) {
    throw new Error(
      "Credit amount must be greater than zero."
    );
  }

  const d =
    await readCredits();

  d.users[id] =
    Number(
      d.users[id] || 0
    ) + n;

  d.transactions.push({
    id: randomUUID(),
    type: "ISSUE",
    source,
    userId: id,
    amount: n,
    createdAt:
      new Date().toISOString(),
  });

  await writeCredits(d);

  return d.users[id];
}

async function consumeUserCredits(
  id,
  seconds
) {
  const cost = Math.max(
    1,
    Math.ceil(
      Number(seconds || 5) /
        5
    ) *
      CREDITS_PER_5_SECONDS
  );

  const d =
    await readCredits();

  if (
    !Object.prototype.hasOwnProperty.call(
      d.users,
      id
    )
  ) {
    d.users[id] =
      STARTER_CREDITS;
  }

  const bal = Number(
    d.users[id] || 0
  );

  if (bal < cost) {
    const e = new Error(
      `Insufficient MAMAKI credits. Required ${cost}, available ${bal}.`
    );

    e.code =
      "MAMAKI_CREDITS_INSUFFICIENT";

    e.requiredCredits =
      cost;

    e.availableCredits =
      bal;

    throw e;
  }

  d.users[id] =
    bal - cost;

  d.transactions.push({
    id: randomUUID(),
    type: "CONSUME",
    source:
      "AI_GENERATION",
    userId: id,
    amount: -cost,
    seconds: Number(
      seconds || 0
    ),
    createdAt:
      new Date().toISOString(),
  });

  await writeCredits(d);

  return {
    cost,
    balance:
      d.users[id],
  };
}

async function refundUserCredits(
  id,
  amount
) {
  const n = Math.max(
    0,
    Number(amount || 0)
  );

  if (!n) return;

  const d =
    await readCredits();

  d.users[id] =
    Number(
      d.users[id] || 0
    ) + n;

  d.transactions.push({
    id: randomUUID(),
    type: "REFUND",
    source:
      "AI_GENERATION_FAILED",
    userId: id,
    amount: n,
    createdAt:
      new Date().toISOString(),
  });

  await writeCredits(d);
}

/* =========================================================
   FINANCE
========================================================= */

async function readFinance() {
  const d =
    await readJson(
      FINANCE_FILE,
      {}
    );

  return {
    transactions:
      Array.isArray(
        d?.transactions
      )
        ? d.transactions
        : [],
    updatedAt:
      d?.updatedAt ||
      new Date().toISOString(),
  };
}

async function addFinanceTransaction(
  type,
  amount,
  description = ""
) {
  const n =
    Number(amount);

  if (
    !Number.isFinite(n) ||
    n < 0
  ) {
    throw new Error(
      "Invalid financial amount."
    );
  }

  const d =
    await readFinance();

  d.transactions.push({
    id: randomUUID(),
    type,
    amount: n,
    description:
      cleanText(
        description,
        500
      ),
    createdAt:
      new Date().toISOString(),
  });

  await writeJson(
    FINANCE_FILE,
    d
  );
}

function financeSummary(
  transactions
) {
  let grossRevenue = 0;
  let refunds = 0;
  let costs = 0;

  for (
    const t of transactions
  ) {
    const type =
      String(
        t.type || ""
      ).toUpperCase();

    const amount =
      Number(
        t.amount || 0
      );

    if (
      type ===
      "REVENUE"
    ) {
      grossRevenue +=
        amount;
    } else if (
      type ===
      "REFUND"
    ) {
      refunds +=
        amount;
    } else if (
      [
        "AI_COST",
        "INFRASTRUCTURE_COST",
        "OTHER_COST",
        "COST",
      ].includes(type)
    ) {
      costs +=
        amount;
    }
  }

  const netRevenue =
    grossRevenue -
    refunds;

  const profit =
    netRevenue -
    costs;

  return {
    grossRevenue,
    refunds,
    netRevenue,
    costs,
    profit,
    profitMargin:
      netRevenue > 0
        ? (profit /
            netRevenue) *
          100
        : 0,
  };
}

/* =========================================================
   SMART BILLING / FX / PRICING
========================================================= */

async function readStore(
  file,
  fallback
) {
  const d =
    await readJson(
      file,
      fallback
    );

  return d &&
    typeof d ===
      "object"
    ? d
    : fallback;
}

async function writeStore(
  file,
  data
) {
  await writeJson(
    file,
    data
  );
}

function normalizeCurrency(
  value
) {
  const c =
    String(
      value ||
        PAYSTACK_CURRENCY_DEFAULT ||
        "NGN"
    ).toUpperCase();

  return [
    "NGN",
    "USD",
  ].includes(c)
    ? c
    : "NGN";
}

async function getFxRates() {
  const now =
    Date.now();

  const store =
    await readStore(
      PRICING_FILE,
      {
        fx: null,
        updatedAt:
          null,
      }
    );

  if (
    store.fx &&
    store.fx.rates &&
    store.fx.updatedAt &&
    now -
      Date.parse(
        store.fx.updatedAt
      ) <
      30 *
        60 *
        1000
  ) {
    return store.fx;
  }

  try {
    const r =
      await fetch(
        FX_API_URL,
        {
          headers: {
            Accept:
              "application/json",
          },
        }
      );

    if (!r.ok) {
      throw new Error(
        `FX provider HTTP ${r.status}`
      );
    }

    const d =
      await r.json();

    const rates =
      d.rates || {};

    const usdNgn =
      Number(
        rates.NGN || 0
      );

    if (
      !Number.isFinite(
        usdNgn
      ) ||
      usdNgn <= 0
    ) {
      throw new Error(
        "FX provider returned no NGN rate"
      );
    }

    const fx = {
      base: "USD",
      rates: {
        USD: 1,
        NGN: usdNgn,
      },
      source:
        FX_API_URL,
      updatedAt:
        new Date().toISOString(),
      live: true,
    };

    store.fx = fx;

    await writeStore(
      PRICING_FILE,
      store
    );

    return fx;
  } catch (e) {
    const fx = {
      base: "USD",
      rates: {
        USD: 1,
        NGN:
          DEFAULT_USD_NGN_RATE,
      },
      source:
        "configured fallback",
      updatedAt:
        new Date().toISOString(),
      live: false,
      error: String(
        e.message || e
      ),
    };

    store.fx = fx;

    await writeStore(
      PRICING_FILE,
      store
    );

    return fx;
  }
}

function providerCostForCredits(
  credits,
  quality = "Standard HD"
) {
  const scenes =
    Math.max(
      1,
      Math.ceil(
        Number(
          credits || 0
        ) /
          CREDITS_PER_5_SECONDS
      )
    );

  const q =
    String(
      quality ||
        "Standard HD"
    ).toLowerCase();

  const providerCost =
    q.includes("high") ||
    q.includes(
      "cinematic"
    )
      ? PROVIDER_COST_720P_USD
      : PROVIDER_COST_480P_USD;

  return {
    scenes,
    providerCostUsd:
      scenes *
      providerCost,
  };
}

async function calculateCreditPrice(
  credits,
  currency = PAYSTACK_CURRENCY_DEFAULT,
  quality = "Standard HD"
) {
  const c =
    Math.max(
      1,
      Math.floor(
        Number(
          credits || 0
        )
      )
    );

  const cur =
    normalizeCurrency(
      currency
    );

  const fx =
    await getFxRates();

  const base =
    providerCostForCredits(
      c,
      quality
    );

  const pricingUsd =
    c / 100;

  const liveFx =
    Number(
      fx.rates.NGN ||
        DEFAULT_USD_NGN_RATE
    );

  const customerNgnRaw =
    pricingUsd *
    (liveFx +
      FIXED_NGN_MARKUP_PER_USD);

  const amount =
    cur === "NGN"
      ? Math.max(
          100,
          Math.round(
            customerNgnRaw /
              50
          ) * 50
        )
      : Math.max(
          1,
          Math.round(
            pricingUsd *
              100
          ) / 100
        );

  return {
    credits: c,
    currency: cur,
    amount,
    amountSubunit:
      Math.round(
        amount * 100
      ),
    usdPrice:
      Number(
        pricingUsd.toFixed(
          2
        )
      ),
    providerCostUsd:
      Number(
        base.providerCostUsd.toFixed(
          4
        )
      ),
    providerScenes:
      base.scenes,
    fxRate:
      cur === "NGN"
        ? liveFx
        : 1,
    fxLive:
      Boolean(fx.live),
    fxUpdatedAt:
      fx.updatedAt,
    fixedMarkupPerUsd:
      cur === "NGN"
        ? FIXED_NGN_MARKUP_PER_USD
        : 0,
    marginTarget:
      TARGET_MARGIN,
    paymentFeeBuffer:
      PAYMENT_FEE_BUFFER,
    fxBuffer:
      FX_BUFFER,
  };
}

const CREDIT_PACKAGES = [
  100,
  500,
  1000,
  2500,
  5000,
];

async function getPricingPackages(
  currency = PAYSTACK_CURRENCY_DEFAULT
) {
  const list = [];

  for (
    const credits of CREDIT_PACKAGES
  ) {
    list.push(
      await calculateCreditPrice(
        credits,
        currency
      )
    );
  }

  return list;
}

/* =========================================================
   PAYMENTS / PAYSTACK
========================================================= */

async function readPayments() {
  const d =
    await readStore(
      PAYMENTS_FILE,
      {
        transactions: [],
      }
    );

  return {
    transactions:
      Array.isArray(
        d.transactions
      )
        ? d.transactions
        : [],
  };
}

async function writePayments(
  d
) {
  await writeStore(
    PAYMENTS_FILE,
    d
  );
}

async function findPayment(
  reference
) {
  const d =
    await readPayments();

  return (
    d.transactions.find(
      (x) =>
        x.reference ===
        reference
    ) || null
  );
}

async function recordPayment(
  payment
) {
  const d =
    await readPayments();

  d.transactions.push(
    payment
  );

  await writePayments(d);

  return payment;
}

async function paystackRequest(
  endpoint,
  options = {}
) {
  if (
    !PAYSTACK_SECRET_KEY
  ) {
    const e = new Error(
      "PAYSTACK_SECRET_KEY is not configured."
    );

    e.code =
      "PAYSTACK_NOT_CONFIGURED";

    throw e;
  }

  const r =
    await fetch(
      `https://api.paystack.co${endpoint}`,
      {
        ...options,
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type":
            "application/json",
          ...(options.headers ||
            {}),
        },
      }
    );

  const text =
    await r.text();

  let data = {};

  try {
    data =
      JSON.parse(text);
  } catch {
    data = {
      message: text,
    };
  }

  if (
    !r.ok ||
    data.status === false
  ) {
    const e = new Error(
      data.message ||
        `Paystack HTTP ${r.status}`
    );

    e.status =
      r.status;

    e.data =
      data;

    throw e;
  }

  return data;
}

async function fulfillSuccessfulPayment(
  reference,
  supplied = {}
) {
  const existing =
    await findPayment(
      reference
    );

  if (
    existing?.fulfilledAt
  ) {
    return existing;
  }

  let verified =
    supplied;

  if (
    PAYSTACK_SECRET_KEY
  ) {
    const v =
      await paystackRequest(
        `/transaction/verify/${encodeURIComponent(
          reference
        )}`
      );

    verified =
      v.data ||
      supplied;
  }

  if (
    String(
      verified.status || ""
    ).toLowerCase() !==
    "success"
  ) {
    throw new Error(
      "Payment is not successful."
    );
  }

  const meta =
    verified.metadata ||
    existing?.metadata ||
    {};

  const userId =
    cleanText(
      meta.userId ||
        existing?.userId,
      100
    );

  const credits =
    Math.floor(
      Number(
        meta.credits ||
          existing?.credits ||
          0
      )
    );

  if (existing) {
    const gatewayAmount =
      Number(
        verified.amount || 0
      );

    const expectedAmount =
      Number(
        existing.amountSubunit ||
          0
      );

    const gatewayCurrency =
      String(
        verified.currency ||
          existing.currency ||
          ""
      ).toUpperCase();

    const expectedCurrency =
      String(
        existing.currency ||
          ""
      ).toUpperCase();

    if (
      expectedAmount > 0 &&
      gatewayAmount !==
        expectedAmount
    ) {
      throw new Error(
        "Payment amount does not match the MAMAKI order."
      );
    }

    if (
      expectedCurrency &&
      gatewayCurrency &&
      expectedCurrency !==
        gatewayCurrency
    ) {
      throw new Error(
        "Payment currency does not match the MAMAKI order."
      );
    }
  }

  if (
    !userId ||
    !credits
  ) {
    throw new Error(
      "Payment metadata is incomplete; credits were not issued."
    );
  }

  const users =
    await readJson(
      USERS_FILE,
      {}
    );

  if (!users[userId]) {
    throw new Error(
      "Payment user no longer exists."
    );
  }

  const payment =
    existing || {
      id: randomUUID(),
      reference,
      userId,
      credits,
      createdAt:
        new Date().toISOString(),
    };

  if (
    !payment.fulfilledAt
  ) {
    await addUserCredits(
      userId,
      credits,
      "PURCHASE"
    );

    const amount =
      Number(
        verified.amount ||
          payment.amount ||
          0
      ) / 100;

    await addFinanceTransaction(
      "REVENUE",
      amount,
      `Credit purchase ${credits} credits · ${reference}`
    );

    payment.fulfilledAt =
      new Date().toISOString();

    payment.status =
      "success";

    payment.gatewayAmount =
      Number(
        verified.amount ||
          0
      );

    payment.currency =
      verified.currency ||
      payment.currency;

    payment.gatewayReference =
      reference;

    if (!existing) {
      await recordPayment(
        payment
      );
    } else {
      const d =
        await readPayments();

      const i =
        d.transactions.findIndex(
          (x) =>
            x.reference ===
            reference
        );

      if (i >= 0) {
        d.transactions[i] =
          payment;
      } else {
        d.transactions.push(
          payment
        );
      }

      await writePayments(d);
    }
  }

  return payment;
}

/* =========================================================
   WITHDRAWALS
========================================================= */

async function readWithdrawals() {
  const d =
    await readStore(
      WITHDRAWALS_FILE,
      {
        withdrawals: [],
      }
    );

  return {
    withdrawals:
      Array.isArray(
        d.withdrawals
      )
        ? d.withdrawals
        : [],
  };
}

async function writeWithdrawals(
  d
) {
  await writeStore(
    WITHDRAWALS_FILE,
    d
  );
}

async function ownerFinancialSnapshot() {
  const finance =
    await readFinance();

  const summary =
    financeSummary(
      finance.transactions
    );

  const wd =
    await readWithdrawals();

  const withdrawn =
    wd.withdrawals
      .filter(
        (x) =>
          String(
            x.status
          ) === "success"
      )
      .reduce(
        (a, x) =>
          a +
          Number(
            x.amount || 0
          ),
        0
      );

  const pending =
    wd.withdrawals
      .filter(
        (x) =>
          [
            "pending",
            "otp",
          ].includes(
            String(
              x.status
            )
          )
      )
      .reduce(
        (a, x) =>
          a +
          Number(
            x.amount || 0
          ),
        0
      );

  return {
    ...summary,
    withdrawn,
    pendingWithdrawals:
      pending,
    availableToWithdraw:
      Math.max(
        0,
        summary.profit -
          withdrawn -
          pending
      ),
  };
}

/* =========================================================
   PASSWORD RECOVERY
========================================================= */

const PASSWORD_RESET_EXPIRY =
  15 * 60 * 1000;

const PASSWORD_RESET_MAX_ATTEMPTS =
  5;

function createResetCode() {
  return String(
    randomBytes(4).readUInt32BE(
      0
    ) % 1000000
  ).padStart(6, "0");
}

function hashResetCode(
  code
) {
  return createHash(
    "sha256"
  )
    .update(
      `${code}:${SESSION_SECRET}`
    )
    .digest("hex");
}

function resetKey(
  email
) {
  return createHash(
    "sha256"
  )
    .update(
      normalizeEmail(
        email
      )
    )
    .digest("hex");
}

async function savePasswordReset(
  email,
  code
) {
  const records =
    await readJson(
      RESET_FILE,
      {}
    );

  const key =
    resetKey(email);

  records[key] = {
    email:
      normalizeEmail(
        email
      ),
    codeHash:
      hashResetCode(
        code
      ),
    createdAt:
      Date.now(),
    expiresAt:
      Date.now() +
      PASSWORD_RESET_EXPIRY,
    attempts: 0,
  };

  await writeJson(
    RESET_FILE,
    records
  );
}

async function findPasswordReset(
  email
) {
  const records =
    await readJson(
      RESET_FILE,
      {}
    );

  return (
    records[
      resetKey(email)
    ] || null
  );
}

async function deletePasswordReset(
  email
) {
  const records =
    await readJson(
      RESET_FILE,
      {}
    );

  delete records[
    resetKey(email)
  ];

  await writeJson(
    RESET_FILE,
    records
  );
}

async function sendPasswordRecoveryEmail(
  email,
  code
) {
  if (
    !RESEND_API_KEY ||
    !RESEND_FROM
  ) {
    const error =
      new Error(
        "Password recovery email service is not configured."
      );

    error.code =
      "RECOVERY_EMAIL_NOT_CONFIGURED";

    throw error;
  }

  const response =
    await fetch(
      "https://api.resend.com/emails",
      {
        method:
          "POST",
        headers: {
          Authorization:
            `Bearer ${RESEND_API_KEY}`,
          "Content-Type":
            "application/json",
        },
        body:
          JSON.stringify({
            from:
              RESEND_FROM,
            to: [email],
            subject:
              "MAMAKI AI password recovery code",
            html: `
              <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
                <h2>✨ MAMAKI AI</h2>
                <p>We received a request to reset the password for your MAMAKI account.</p>
                <p>Your recovery code is:</p>
                <div style="font-size:32px;font-weight:700;letter-spacing:8px;padding:18px;background:#f3f3f3;text-align:center">${code}</div>
                <p>This code expires in 15 minutes. If you did not request this, you can ignore this message.</p>
                <p>For your security, never share this code with anyone.</p>
              </div>
            `,
          }),
      }
    );

  if (!response.ok) {
    const text =
      await response.text();

    const error =
      new Error(
        `Recovery email failed with HTTP ${response.status}: ${text.slice(
          0,
          1000
        )}`
      );

    error.code =
      "RECOVERY_EMAIL_FAILED";

    throw error;
  }
}

/* =========================================================
   BASIC SYSTEM / HEALTH
========================================================= */

app.get(
  "/health",
  async (req, res) => {
    res.status(200).json({
      ok: true,
      status: "healthy",
      service:
        "MAMAKI AI Video Creative Studio",
      version: VERSION,
      uptime:
        process.uptime(),
      timestamp:
        new Date().toISOString(),
      checks: {
        server: true,
        ffmpeg:
          Boolean(
            ffmpegPath
          ),
        replicateConfigured:
          Boolean(
            REPLICATE_API_TOKEN
          ),
        adminConfigured:
          Boolean(
            ADMIN_EMAIL &&
              ADMIN_PASSWORD
          ),
        paystackConfigured:
          Boolean(
            PAYSTACK_SECRET_KEY
          ),
        recoveryConfigured:
          Boolean(
            RESEND_API_KEY &&
              RESEND_FROM
          ),
      },
    });
  }
);

app.get(
  "/api/status",
  async (req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      ai: {
        configured:
          Boolean(
            REPLICATE_API_TOKEN
          ),
        t2vModel:
          T2V_MODEL,
        i2vModel:
          I2V_MODEL,
      },
      recovery: {
        configured:
          Boolean(
            RESEND_API_KEY &&
              RESEND_FROM
          ),
        method:
          "email_code",
      },
      paystack: {
        configured:
          Boolean(
            PAYSTACK_SECRET_KEY
          ),
        publicKeyConfigured:
          Boolean(
            PAYSTACK_PUBLIC_KEY
          ),
        webhookPath:
          "/api/paystack/webhook",
      },
      features: {
        textToVideo: true,
        imageToVideo: true,
        autopilot: true,
        photoToVideo: true,
        videoTrim: true,
        combineVideos: true,
        narration: true,
        subtitles: true,
        promptEnhancement: true,
        socialPresets: true,
        accounts: true,
        projects: true,
        admin:
          Boolean(
            ADMIN_EMAIL &&
              ADMIN_PASSWORD
          ),
        internalCredits: true,
        finance: true,
        watermark:
          "MAMAKI ✨",
      },
    });
  }
);

/* =========================================================
   AUTHENTICATION
========================================================= */

app.post(
  "/api/auth/register",
  async (req, res) => {
    try {
      const name =
        cleanText(
          req.body.name,
          100
        );

      const email =
        normalizeEmail(
          req.body.email
        );

      const password =
        String(
          req.body.password ||
            ""
        );

      if (
        !name ||
        !email ||
        !password
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_INPUT",
          message:
            "Name, email and password are required.",
        });
      }

      if (
        password.length < 6
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "WEAK_PASSWORD",
          message:
            "Password must contain at least 6 characters.",
        });
      }

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      const existing =
        Object.values(
          users
        ).find(
          (user) =>
            String(
              user.email
            ).toLowerCase() ===
            email
        );

      if (existing) {
        return res.status(409).json({
          ok: false,
          error:
            "EMAIL_EXISTS",
          message:
            "An account with this email already exists.",
        });
      }

      const credentials =
        hashPassword(
          password
        );

      const id =
        randomUUID();

      const user = {
        id,
        name,
        email,
        salt:
          credentials.salt,
        passwordHash:
          credentials.hash,
        role: "user",
        disabled: false,
        createdAt:
          new Date().toISOString(),
        lastLoginAt: null,
        lastActiveAt: null,
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

      const token =
        await createSession(
          id,
          "user"
        );

      await recordSecurityEvent(
        "USER_REGISTERED",
        {
          userId: id,
          email,
        }
      );

      res.status(201).json({
        ok: true,
        token,
        user: {
          id,
          name,
          email,
          role: "user",
          credits:
            await getUserCredits(
              id
            ),
        },
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/auth/register",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "REGISTER_FAILED",
        message:
          "Unable to create the account.",
      });
    }
  }
);

app.post(
  "/api/auth/login",
  async (req, res) => {
    try {
      const email =
        normalizeEmail(
          req.body.email
        );

      const password =
        String(
          req.body.password ||
            ""
        );

      if (
        !email ||
        !password
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_INPUT",
          message:
            "Email and password are required.",
        });
      }

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      const user =
        Object.values(
          users
        ).find(
          (item) =>
            String(
              item.email
            ).toLowerCase() ===
            email
        );

      if (
        !user ||
        user.disabled ||
        !verifyPassword(
          password,
          user.salt,
          user.passwordHash
        )
      ) {
        await recordSecurityEvent(
          "USER_LOGIN_FAILED",
          {
            email,
          }
        );

        return res.status(401).json({
          ok: false,
          error:
            "INVALID_LOGIN",
          message:
            "Invalid email or password.",
        });
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

      const token =
        await createSession(
          user.id,
          user.role ===
            "admin"
            ? "admin"
            : "user"
        );

      await recordSecurityEvent(
        "USER_LOGIN_SUCCESS",
        {
          userId:
            user.id,
          email,
          role:
            user.role,
        }
      );

      res.json({
        ok: true,
        token,
        user: {
          id:
            user.id,
          name:
            user.name,
          email:
            user.email,
          role:
            user.role,
          credits:
            await getUserCredits(
              user.id
            ),
        },
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/auth/login",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "LOGIN_FAILED",
        message:
          "Unable to complete login.",
      });
    }
  }
);

app.post(
  "/api/auth/logout",
  async (req, res) => {
    try {
      const token =
        getBearerToken(req);

      if (token) {
        const sessions =
          await readJson(
            SESSIONS_FILE,
            {}
          );

        delete sessions[
          token
        ];

        await writeJson(
          SESSIONS_FILE,
          sessions
        );
      }

      res.json({
        ok: true,
      });
    } catch {
      res.json({
        ok: true,
      });
    }
  }
);

app.get(
  "/api/auth/me",
  async (req, res) => {
    const user =
      await getCurrentUser(
        req
      );

    if (!user) {
      return res.status(401).json({
        ok: false,
        error:
          "AUTH_REQUIRED",
        message:
          "Please log in.",
      });
    }

    res.json({
      ok: true,
      user: {
        id:
          user.id,
        name:
          user.name,
        email:
          user.email,
        role:
          user.role,
        credits:
          await getUserCredits(
            user.id
          ),
        disabled:
          Boolean(
            user.disabled
          ),
      },
    });
  }
);

app.post(
  "/api/auth/forgot-password",
  async (req, res) => {
    const email =
      normalizeEmail(
        req.body.email
      );

    const generic = {
      ok: true,
      message:
        "If an account exists for that email, a recovery code has been sent.",
    };

    if (!email) {
      return res.status(400).json({
        ok: false,
        error:
          "EMAIL_REQUIRED",
        message:
          "Enter your account email.",
      });
    }

    if (
      !allowedByRate(
        resetRate,
        email,
        3,
        15 * 60 * 1000
      )
    ) {
      await recordSecurityEvent(
        "password_recovery_rate_limited",
        {
          email,
        }
      );

      return res.json(
        generic
      );
    }

    try {
      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      const user =
        Object.values(
          users
        ).find(
          (item) =>
            String(
              item.email
            ).toLowerCase() ===
            email
        );

      if (
        !user ||
        user.disabled
      ) {
        return res.json(
          generic
        );
      }

      const code =
        createResetCode();

      await savePasswordReset(
        email,
        code
      );

      await sendPasswordRecoveryEmail(
        email,
        code
      );

      await recordSecurityEvent(
        "password_recovery_requested",
        {
          userId:
            user.id,
          email,
        }
      );

      return res.json(
        generic
      );
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/auth/forgot-password",
        }
      );

      return res.status(503).json({
        ok: false,
        error:
          error.code ||
          "RECOVERY_UNAVAILABLE",
        message:
          "Password recovery email is temporarily unavailable. Please try again later.",
      });
    }
  }
);

app.post(
  "/api/auth/reset-password",
  async (req, res) => {
    const email =
      normalizeEmail(
        req.body.email
      );

    const code =
      cleanText(
        req.body.code,
        20
      );

    const newPassword =
      String(
        req.body.password ||
          ""
      );

    if (
      !email ||
      !code ||
      !newPassword
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "INVALID_INPUT",
        message:
          "Email, recovery code and new password are required.",
      });
    }

    if (
      newPassword.length < 6
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "WEAK_PASSWORD",
        message:
          "Password must contain at least 6 characters.",
      });
    }

    try {
      const record =
        await findPasswordReset(
          email
        );

      if (
        !record ||
        Date.now() >
          Number(
            record.expiresAt ||
              0
          )
      ) {
        await deletePasswordReset(
          email
        );

        return res.status(400).json({
          ok: false,
          error:
            "RESET_EXPIRED",
          message:
            "This recovery code has expired. Request a new one.",
        });
      }

      if (
        Number(
          record.attempts ||
            0
        ) >=
        PASSWORD_RESET_MAX_ATTEMPTS
      ) {
        await deletePasswordReset(
          email
        );

        await recordSecurityEvent(
          "password_recovery_locked",
          {
            email,
          }
        );

        return res.status(429).json({
          ok: false,
          error:
            "RESET_ATTEMPTS_EXCEEDED",
          message:
            "Too many incorrect attempts. Request a new recovery code.",
        });
      }

      const records =
        await readJson(
          RESET_FILE,
          {}
        );

      const key =
        resetKey(email);

      record.attempts =
        Number(
          record.attempts ||
            0
        ) + 1;

      records[key] =
        record;

      await writeJson(
        RESET_FILE,
        records
      );

      if (
        hashResetCode(
          code
        ) !==
        record.codeHash
      ) {
        await recordSecurityEvent(
          "password_recovery_invalid_code",
          {
            email,
          }
        );

        return res.status(400).json({
          ok: false,
          error:
            "INVALID_RESET_CODE",
          message:
            "The recovery code is incorrect.",
        });
      }

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      const user =
        Object.values(
          users
        ).find(
          (item) =>
            String(
              item.email
            ).toLowerCase() ===
            email
        );

      if (
        !user ||
        user.disabled
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "ACCOUNT_NOT_FOUND",
          message:
            "Unable to reset this account.",
        });
      }

      const credentials =
        hashPassword(
          newPassword
        );

      user.salt =
        credentials.salt;

      user.passwordHash =
        credentials.hash;

      user.passwordChangedAt =
        new Date().toISOString();

      users[user.id] =
        user;

      await writeJson(
        USERS_FILE,
        users
      );

      await deletePasswordReset(
        email
      );

      await invalidateUserSessions(
        user.id
      );

      await recordSecurityEvent(
        "password_changed",
        {
          userId:
            user.id,
          email,
        }
      );

      res.json({
        ok: true,
        message:
          "Password changed successfully. Please log in with your new password.",
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/auth/reset-password",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "PASSWORD_RESET_FAILED",
        message:
          "Unable to reset the password.",
      });
    }
  }
);

/* =========================================================
   USER PROFILE / CREDITS
========================================================= */

app.get(
  "/api/credits",
  requireUser,
  async (req, res) => {
    res.json({
      ok: true,
      credits:
        await getUserCredits(
          req.user.id
        ),
    });
  }
);

app.post(
  "/api/ai/quote",
  requireUser,
  async (req, res) => {
    try {
      const duration =
        normalizeDuration(
          req.body.duration
        );

      const creditsRequired =
        Math.max(
          1,
          Math.ceil(
            duration / 5
          ) *
            CREDITS_PER_5_SECONDS
        );

      const availableCredits =
        await getUserCredits(
          req.user.id
        );

      res.json({
        ok: true,
        duration,
        creditsRequired,
        availableCredits,
        canGenerate:
          availableCredits >=
          creditsRequired,
        message:
          `This video requires ${creditsRequired} MAMAKI credits.`,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error:
          "QUOTE_FAILED",
        message:
          "Unable to calculate video credits.",
      });
    }
  }
);

/* =========================================================
   VIDEO GENERATION
========================================================= */

app.post(
  "/api/generate",
  upload.single("image"),
  async (req, res) => {
    try {
      const user =
        await getCurrentUser(
          req
        );

      if (!user) {
        return res.status(401).json({
          ok: false,
          error:
            "AUTH_REQUIRED",
          message:
            "Log in to your MAMAKI account before starting AI production.",
        });
      }

      if (
        !REPLICATE_API_TOKEN
      ) {
        return res.status(503).json({
          ok: false,
          error:
            "REPLICATE_AUTH_REQUIRED",
          message:
            "AI generation is not configured. Add REPLICATE_API_TOKEN to the Render environment variables.",
        });
      }

      const billingState =
        await readStore(
          PRICING_FILE,
          {}
        );

      if (
        billingState.providerBlockedUntil &&
        Date.now() <
          Number(
            billingState.providerBlockedUntil
          )
      ) {
        return res.status(402).json({
          ok: false,
          error:
            "REPLICATE_CREDIT_REQUIRED",
          message:
            "AI generation is temporarily unavailable because the connected Replicate account has no usable credit.",
        });
      }

      const prompt =
        cleanText(
          req.body.prompt,
          30000
        );

      const style =
        cleanText(
          req.body.style ||
            "Cinematic",
          100
        );

      const duration =
        normalizeDuration(
          req.body.duration
        );

      const ratio =
        normalizeRatio(
          req.body.ratio ||
            req.body.format
        );

      const quality =
        cleanText(
          req.body.quality ||
            "Standard HD",
          100
        );

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error:
            "PROMPT_REQUIRED",
          message:
            "Describe the video you want to create.",
        });
      }

      let creditReservation;

      try {
        creditReservation =
          await consumeUserCredits(
            user.id,
            duration
          );
      } catch (e) {
        return res.status(402).json({
          ok: false,
          error:
            e.code ||
            "MAMAKI_CREDITS_INSUFFICIENT",
          message:
            e.message,
          requiredCredits:
            e.requiredCredits ||
            null,
          availableCredits:
            e.availableCredits ??
            (await getUserCredits(
              user.id
            )),
        });
      }

      const jobId =
        randomUUID();

      const job = {
        id: jobId,
        userId:
          user.id,
        status:
          "queued",
        progress: 0,
        message:
          "Production queued.",
        createdAt:
          new Date().toISOString(),
        duration,
        ratio,
        style,
        quality,
        cancelled: false,
        creditCost:
          creditReservation.cost,
      };

      jobs.set(
        jobId,
        job
      );

      res.status(202).json({
        ok: true,
        jobId,
        status:
          "queued",
        progress: 0,
        message:
          "Production started.",
      });

      setImmediate(
        async () => {
          try {
            job.status =
              "processing";

            job.message =
              "MAMAKI AI Director is planning your production.";

            const final =
              await generateVideoProduction(
                {
                  job,
                  userId:
                    user.id,
                  prompt,
                  imageBuffer:
                    req.file
                      ?.buffer ||
                    null,
                  duration,
                  ratio,
                  style,
                  quality,
                }
              );

            job.status =
              "completed";

            job.progress =
              100;

            job.message =
              "Production completed successfully.";

            job.video =
              `/api/video/${path.basename(
                final
              )}`;

            job.completedAt =
              new Date().toISOString();

            await recordEstimatedProviderCost(
              duration,
              quality,
              user.id,
              jobId
            );
          } catch (error) {
            const classified =
              classifyReplicateError(
                error
              );

            job.status =
              "failed";

            job.progress =
              0;

            job.message =
              classified.message;

            job.error =
              classified.code;

            job.completedAt =
              new Date().toISOString();

            await refundUserCredits(
              user.id,
              job.creditCost
            );

            await recordError(
              error,
              {
                route:
                  "/api/generate",
                userId:
                  user.id,
                jobId,
                classified:
                  classified.code,
              }
            );

            if (
              classified.code ===
              "REPLICATE_CREDIT_REQUIRED"
            ) {
              const store =
                await readStore(
                  PRICING_FILE,
                  {}
                );

              store.providerBlockedUntil =
                Date.now() +
                10 *
                  60 *
                  1000;

              await writeStore(
                PRICING_FILE,
                store
              );
            }
          }
        }
      );
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/generate",
        }
      );

      if (
        !res.headersSent
      ) {
        res.status(500).json({
          ok: false,
          error:
            "GENERATION_FAILED",
          message:
            "Unable to start video generation.",
        });
      }
    }
  }
);

async function recordEstimatedProviderCost(
  duration,
  quality,
  userId,
  jobId
) {
  const q =
    String(
      quality || ""
    ).toLowerCase();

  const costPerScene =
    q.includes("high") ||
    q.includes("cinematic")
      ? PROVIDER_COST_720P_USD
      : PROVIDER_COST_480P_USD;

  const scenes =
    Math.max(
      1,
      Math.ceil(
        Number(
          duration
        ) / 5
      )
    );

  const cost =
    scenes *
    costPerScene;

  await addFinanceTransaction(
    "AI_COST",
    cost,
    `Estimated Replicate cost · ${jobId}`
  );

  return {
    userId,
    jobId,
    cost,
  };
}

app.get(
  "/api/generate/:jobId",
  requireUser,
  async (req, res) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).json({
        ok: false,
        error:
          "JOB_NOT_FOUND",
        message:
          "Production job was not found.",
      });
    }

    if (
      job.userId !==
      req.user.id &&
      req.user.role !==
        "admin"
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "FORBIDDEN",
        message:
          "You cannot access this production.",
      });
    }

    res.json({
      ok: true,
      job,
    });
  }
);

app.post(
  "/api/generate/:jobId/cancel",
  requireUser,
  async (req, res) => {
    const job =
      jobs.get(
        req.params.jobId
      );

    if (!job) {
      return res.status(404).json({
        ok: false,
        error:
          "JOB_NOT_FOUND",
      });
    }

    if (
      job.userId !==
      req.user.id
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "FORBIDDEN",
      });
    }

    if (
      job.status ===
        "completed" ||
      job.status ===
        "failed"
    ) {
      return res.json({
        ok: true,
        message:
          "Production is already finished.",
        job,
      });
    }

    job.cancelled =
      true;

    res.json({
      ok: true,
      message:
        "Cancellation requested.",
      job,
    });
  }
);

/* =========================================================
   VIDEO FILE SERVING
========================================================= */

app.get(
  "/api/video/:file",
  async (req, res) => {
    const file =
      safeFileName(
        req.params.file
      );

    if (
      !file.endsWith(
        ".mp4"
      )
    ) {
      return res.status(400).send(
        "Invalid video."
      );
    }

    const full =
      path.join(
        OUTPUTS,
        file
      );

    try {
      await fs.access(
        full
      );

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.sendFile(
        full
      );
    } catch {
      res.status(404).send(
        "Video not found."
      );
    }
  }
);

/* =========================================================
   PROJECTS
========================================================= */

async function saveProject(
  project
) {
  const id =
    project.id ||
    randomUUID();

  const file =
    path.join(
      PROJECTS,
      `${safeFileName(
        id
      )}.json`
    );

  const record = {
    ...project,
    id,
    updatedAt:
      new Date().toISOString(),
    createdAt:
      project.createdAt ||
      new Date().toISOString(),
  };

  await fs.writeFile(
    file,
    JSON.stringify(
      record,
      null,
      2
    ),
    "utf8"
  );

  return record;
}

async function getAllProjects() {
  const files =
    await fs
      .readdir(PROJECTS)
      .catch(
        () => []
      );

  const result = [];

  for (
    const name of files
  ) {
    if (
      !name.endsWith(
        ".json"
      )
    ) {
      continue;
    }

    try {
      result.push(
        JSON.parse(
          await fs.readFile(
            path.join(
              PROJECTS,
              name
            ),
            "utf8"
          )
        )
      );
    } catch {
      // Ignore malformed project files.
    }
  }

  return result;
}

app.get(
  "/api/projects",
  requireUser,
  async (req, res) => {
    try {
      const projects =
        await getAllProjects();

      const own =
        projects.filter(
          (p) =>
            p.userId ===
            req.user.id
        );

      res.json({
        ok: true,
        projects:
          own,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/projects",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "PROJECTS_FAILED",
      });
    }
  }
);

app.post(
  "/api/projects",
  requireUser,
  async (req, res) => {
    try {
      const name =
        cleanText(
          req.body.name ||
            "Untitled Project",
          200
        );

      const project =
        await saveProject({
          userId:
            req.user.id,
          name,
          prompt:
            cleanText(
              req.body.prompt,
              30000
            ),
          duration:
            normalizeDuration(
              req.body.duration
            ),
          ratio:
            normalizeRatio(
              req.body.ratio
            ),
          style:
            cleanText(
              req.body.style ||
                "Cinematic",
              100
            ),
          status:
            "draft",
        });

      res.status(201).json({
        ok: true,
        project,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/projects",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "PROJECT_CREATE_FAILED",
      });
    }
  }
);

/* =========================================================
   FREE STUDIO — PHOTO TO VIDEO
========================================================= */

app.post(
  "/api/studio/photo-video",
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "IMAGE_REQUIRED",
          message:
            "Upload an image first.",
        });
      }

      const user =
        await getCurrentUser(
          req
        );

      if (!user) {
        return res.status(401).json({
          ok: false,
          error:
            "AUTH_REQUIRED",
          message:
            "Log in before using Free Studio.",
        });
      }

      const prompt =
        cleanText(
          req.body.prompt ||
            "Create a smooth cinematic animation from this image.",
          10000
        );

      const duration =
        normalizeDuration(
          req.body.duration ||
            5
        );

      const ratio =
        normalizeRatio(
          req.body.ratio
        );

      const quality =
        cleanText(
          req.body.quality ||
            "Standard HD",
          100
        );

      const final =
        await generateSingleClip({
          prompt,
          imageBuffer:
            req.file.buffer,
          duration,
          ratio,
          quality,
        });

      await recordUsage(
        user.id,
        "studio",
        duration
      );

      res.json({
        ok: true,
        video:
          `/api/video/${path.basename(
            final
          )}`,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/studio/photo-video",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "PHOTO_VIDEO_FAILED",
        message:
          "Unable to turn the photo into a video.",
      });
    }
  }
);

/* =========================================================
   FREE STUDIO — TRIM
========================================================= */

app.post(
  "/api/studio/trim",
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "VIDEO_REQUIRED",
        });
      }

      const id =
        randomUUID();

      const input =
        path.join(
          TMP,
          `${id}-input.mp4`
        );

      const output =
        path.join(
          OUTPUTS,
          `${id}.mp4`
        );

      await fs.writeFile(
        input,
        req.file.buffer
      );

      const start =
        Math.max(
          0,
          Number(
            req.body.start ||
              0
          )
        );

      const end =
        Math.max(
          start + 0.1,
          Number(
            req.body.end ||
              999999
          )
        );

      await runFFmpeg([
        "-y",
        "-ss",
        String(start),
        "-i",
        input,
        "-to",
        String(
          end - start
        ),
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

      const final =
        path.join(
          OUTPUTS,
          `${id}-watermarked.mp4`
        );

      await addWatermark(
        output,
        final
      );

      res.json({
        ok: true,
        video:
          `/api/video/${path.basename(
            final
          )}`,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/studio/trim",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "TRIM_FAILED",
        message:
          "Unable to trim the video.",
      });
    }
  }
);

/* =========================================================
   FREE STUDIO — COMBINE
========================================================= */

app.post(
  "/api/studio/combine",
  upload.array(
    "videos",
    50
  ),
  async (req, res) => {
    try {
      const videos =
        req.files || [];

      if (
        videos.length < 2
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "TWO_VIDEOS_REQUIRED",
          message:
            "Add at least two videos.",
        });
      }

      const id =
        randomUUID();

      const inputs = [];

      for (
        let i = 0;
        i < videos.length;
        i++
      ) {
        const file =
          path.join(
            TMP,
            `${id}-${i}.mp4`
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
          OUTPUTS,
          `${id}-combined.mp4`
        );

      const final =
        path.join(
          OUTPUTS,
          `${id}.mp4`
        );

      await combineVideoFiles(
        inputs,
        combined
      );

      await addWatermark(
        combined,
        final
      );

      const user =
        await getCurrentUser(
          req
        );

      if (user) {
        await recordUsage(
          user.id,
          "studio",
          0
        );
      }

      res.json({
        ok: true,
        video:
          `/api/video/${path.basename(
            final
          )}`,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/studio/combine",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "COMBINE_FAILED",
        message:
          "Unable to combine the videos.",
      });
    }
  }
);

/* =========================================================
   FREE STUDIO — NARRATION
========================================================= */

app.post(
  "/api/studio/narration",
  async (req, res) => {
    try {
      const text =
        cleanText(
          req.body.text,
          10000
        );

      const voice =
        cleanText(
          req.body.voice ||
            "en-US-AriaNeural",
          200
        );

      if (!text) {
        return res.status(400).json({
          ok: false,
          error:
            "NARRATION_TEXT_REQUIRED",
          message:
            "Enter narration text.",
        });
      }

      const id =
        randomUUID();

      const output =
        path.join(
          OUTPUTS,
          `${id}.mp3`
        );

      const tts =
        new EdgeTTS(
          text,
          voice
        );

      await tts.save(
        output
      );

      const user =
        await getCurrentUser(
          req
        );

      if (user) {
        await recordUsage(
          user.id,
          "narration",
          0
        );
      }

      res.json({
        ok: true,
        audio:
          `/api/audio/${path.basename(
            output
          )}`,
        voice,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/studio/narration",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "NARRATION_FAILED",
        message:
          "Unable to create narration with the configured voice service.",
      });
    }
  }
);

app.get(
  "/api/audio/:file",
  async (req, res) => {
    const file =
      safeFileName(
        req.params.file
      );

    if (
      !file.endsWith(
        ".mp3"
      )
    ) {
      return res.status(400).send(
        "Invalid audio."
      );
    }

    const full =
      path.join(
        OUTPUTS,
        file
      );

    try {
      await fs.access(
        full
      );

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      res.sendFile(
        full
      );
    } catch {
      res.status(404).send(
        "Audio not found."
      );
    }
  }
);

/* =========================================================
   FREE STUDIO — SOCIAL EXPORT
========================================================= */

app.post(
  "/api/studio/social",
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "VIDEO_REQUIRED",
        });
      }

      const ratio =
        normalizeRatio(
          req.body.ratio ||
            "9:16"
        );

      const id =
        randomUUID();

      const input =
        path.join(
          TMP,
          `${id}-input.mp4`
        );

      const resized =
        path.join(
          OUTPUTS,
          `${id}-resized.mp4`
        );

      const final =
        path.join(
          OUTPUTS,
          `${id}.mp4`
        );

      await fs.writeFile(
        input,
        req.file.buffer
      );

      await resizeVideo(
        input,
        resized,
        ratio
      );

      await addWatermark(
        resized,
        final
      );

      res.json({
        ok: true,
        ratio,
        video:
          `/api/video/${path.basename(
            final
          )}`,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/studio/social",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "SOCIAL_EXPORT_FAILED",
        message:
          "Unable to create the social preset export.",
      });
    }
  }
);

/* =========================================================
   BILLING API
========================================================= */

app.get(
  "/api/billing/pricing",
  async (req, res) => {
    try {
      const currency =
        normalizeCurrency(
          req.query.currency
        );

      res.json({
        ok: true,
        currency,
        packages:
          await getPricingPackages(
            currency
          ),
        paystackConfigured:
          Boolean(
            PAYSTACK_SECRET_KEY
          ),
        publicKey:
          PAYSTACK_PUBLIC_KEY ||
          null,
      });
    } catch (e) {
      await recordError(
        e,
        {
          route:
            "/api/billing/pricing",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "PRICING_UNAVAILABLE",
        message:
          "Unable to calculate current pricing.",
      });
    }
  }
);

app.post(
  "/api/billing/paystack/initialize",
  requireUser,
  async (req, res) => {
    try {
      if (
        !PAYSTACK_SECRET_KEY
      ) {
        return res.status(503).json({
          ok: false,
          error:
            "PAYMENT_NOT_CONFIGURED",
          message:
            "MAMAKI payments are not configured yet.",
        });
      }

      const credits =
        Math.floor(
          Number(
            req.body.credits ||
              0
          )
        );

      if (
        !CREDIT_PACKAGES.includes(
          credits
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_CREDIT_PACKAGE",
          message:
            "Select a valid MAMAKI credit package.",
        });
      }

      const currency =
        normalizeCurrency(
          req.body.currency
        );

      const pricing =
        await calculateCreditPrice(
          credits,
          currency,
          req.body.quality ||
            "Standard HD"
        );

      const reference =
        `mamaki_${Date.now()}_${randomBytes(
          6
        ).toString("hex")}`;

      const callback =
        `${APP_URL}/?payment=complete&reference=${encodeURIComponent(
          reference
        )}`;

      const payload = {
        email:
          req.user.email,
        amount:
          pricing.amountSubunit,
        currency,
        reference,
        callback_url:
          callback,
        metadata: {
          userId:
            req.user.id,
          credits,
          pricing,
          product:
            "MAMAKI AI Credits",
        },
      };

      const result =
        await paystackRequest(
          "/transaction/initialize",
          {
            method:
              "POST",
            body:
              JSON.stringify(
                payload
              ),
          }
        );

      await recordPayment({
        id: randomUUID(),
        reference,
        userId:
          req.user.id,
        credits,
        currency,
        amount:
          pricing.amount,
        amountSubunit:
          pricing.amountSubunit,
        pricing,
        status:
          "initialized",
        createdAt:
          new Date().toISOString(),
      });

      res.json({
        ok: true,
        authorizationUrl:
          result.data
            ?.authorization_url,
        accessCode:
          result.data
            ?.access_code,
        reference,
        pricing,
      });
    } catch (e) {
      await recordError(
        e,
        {
          route:
            "/api/billing/paystack/initialize",
          userId:
            req.user?.id,
        }
      );

      res.status(500).json({
        ok: false,
        error:
          e.code ||
          "PAYMENT_INITIALIZATION_FAILED",
        message:
          e.message,
      });
    }
  }
);

app.get(
  "/api/billing/paystack/verify/:reference",
  requireUser,
  async (req, res) => {
    try {
      const existing =
        await findPayment(
          req.params.reference
        );

      if (
        !existing ||
        existing.userId !==
          req.user.id
      ) {
        return res.status(404).json({
          ok: false,
          error:
            "PAYMENT_NOT_FOUND",
          message:
            "Payment record was not found.",
        });
      }

      const payment =
        await fulfillSuccessfulPayment(
          existing.reference
        );

      res.json({
        ok: true,
        payment,
      });
    } catch (e) {
      await recordError(
        e,
        {
          route:
            "/api/billing/paystack/verify/:reference",
          reference:
            req.params.reference,
          userId:
            req.user.id,
        }
      );

      res.status(400).json({
        ok: false,
        error:
          e.code ||
          "PAYMENT_VERIFY_FAILED",
        message:
          e.message,
      });
    }
  }
);

app.get(
  "/api/billing/payment/:reference",
  requireUser,
  async (req, res) => {
    try {
      const payment =
        await findPayment(
          req.params.reference
        );

      if (
        !payment ||
        payment.userId !==
          req.user.id
      ) {
        return res.status(404).json({
          ok: false,
          error:
            "PAYMENT_NOT_FOUND",
        });
      }

      res.json({
        ok: true,
        payment,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/billing/payment/:reference",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "PAYMENT_LOOKUP_FAILED",
      });
    }
  }
);

app.get(
  "/api/paystack/callback",
  (req, res) => {
    const reference =
      cleanText(
        req.query.reference,
        200
      );

    const target =
      reference
        ? `/?payment=complete&reference=${encodeURIComponent(
            reference
          )}`
        : "/";

    res.redirect(
      target
    );
  }
);

app.post(
  [
    "/api/payments/paystack/webhook",
    "/api/paystack/webhook",
    "/api/billing/paystack/webhook",
  ],
  async (req, res) => {
    try {
      if (
        !PAYSTACK_SECRET_KEY
      ) {
        return res
          .status(503)
          .json({
            ok: false,
          });
      }

      const signature =
        String(
          req.headers[
            "x-paystack-signature"
          ] || ""
        );

      const raw =
        req.rawBody ||
        Buffer.from(
          JSON.stringify(
            req.body || {}
          )
        );

      const expected =
        createHmac(
          "sha512",
          PAYSTACK_SECRET_KEY
        )
          .update(raw)
          .digest("hex");

      if (
        !signature ||
        signature.length !==
          expected.length ||
        !timingSafeEqual(
          Buffer.from(
            signature
          ),
          Buffer.from(
            expected
          )
        )
      ) {
        return res
          .status(401)
          .json({
            ok: false,
          });
      }

      if (
        req.body?.event ===
        "charge.success"
      ) {
        await fulfillSuccessfulPayment(
          req.body?.data
            ?.reference,
          req.body?.data ||
            {}
        );
      }

      res.json({
        ok: true,
      });
    } catch (e) {
      await recordError(
        e,
        {
          route:
            "/api/paystack/webhook",
        }
      );

      res.status(200).json({
        ok: true,
      });
    }
  }
);

/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post(
  "/api/admin/login",
  async (req, res) => {
    if (
      !ADMIN_EMAIL ||
      !ADMIN_PASSWORD
    ) {
      return res.status(503).json({
        ok: false,
        error:
          "ADMIN_NOT_CONFIGURED",
        message:
          "Admin credentials are not configured in Render.",
      });
    }

    const email =
      normalizeEmail(
        req.body.email
      );

    const password =
      String(
        req.body.password ||
          ""
      );

    if (
      !allowedByRate(
        adminLoginRate,
        email ||
          "unknown",
        5,
        15 * 60 * 1000
      )
    ) {
      await recordSecurityEvent(
        "admin_login_rate_limited",
        {
          email,
        }
      );

      return res.status(429).json({
        ok: false,
        error:
          "ADMIN_RATE_LIMITED",
        message:
          "Too many administrator login attempts. Try again later.",
      });
    }

    if (
      email !==
        ADMIN_EMAIL ||
      password !==
        ADMIN_PASSWORD
    ) {
      await recordSecurityEvent(
        "admin_login_failed",
        {
          email,
        }
      );

      return res.status(401).json({
        ok: false,
        error:
          "INVALID_ADMIN_LOGIN",
        message:
          "Invalid administrator credentials.",
      });
    }

    try {
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

      let restored =
        false;

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

        restored =
          true;
      }

      admin.role =
        "admin";

      admin.disabled =
        false;

      admin.lastLoginAt =
        new Date().toISOString();

      users[admin.id] =
        admin;

      for (
        const dup of matches.slice(
          1
        )
      ) {
        delete users[
          dup.id
        ];

        await invalidateUserSessions(
          dup.id
        );
      }

      await writeJson(
        USERS_FILE,
        users
      );

      await getUserCredits(
        admin.id
      );

      const token =
        await createSession(
          admin.id,
          "admin"
        );

      if (restored) {
        await recordSecurityEvent(
          "ADMIN_ACCOUNT_RESTORED",
          {
            userId:
              admin.id,
            email:
              ADMIN_EMAIL,
          }
        );
      }

      await recordSecurityEvent(
        "ADMIN_LOGIN_SUCCESS",
        {
          userId:
            admin.id,
          email:
            ADMIN_EMAIL,
          method:
            "MASTER_CREDENTIALS",
        }
      );

      res.json({
        ok: true,
        token,
        admin: {
          id:
            admin.id,
          email:
            admin.email,
          role:
            "admin",
        },
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/login",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "ADMIN_LOGIN_FAILED",
        message:
          "Unable to complete administrator login.",
      });
    }
  }
);

/* =========================================================
   ADMIN STATS
========================================================= */

app.get(
  "/api/admin/stats",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJson(
        USERS_FILE,
        {}
      );

    const usage =
      await readJson(
        USAGE_FILE,
        {}
      );

    const projects =
      await getAllProjects();

    const userList =
      Object.values(
        users
      );

    let aiGenerations =
      0;

    let aiSeconds =
      0;

    let studioJobs =
      0;

    let narrationJobs =
      0;

    for (
      const item of Object.values(
        usage
      )
    ) {
      aiGenerations +=
        Number(
          item.aiGenerations ||
            0
        );

      aiSeconds +=
        Number(
          item.aiSeconds ||
            0
        );

      studioJobs +=
        Number(
          item.studioJobs ||
            0
        );

      narrationJobs +=
        Number(
          item.narrationJobs ||
            0
        );
    }

    const jobList =
      Array.from(
        jobs.values()
      );

    res.json({
      ok: true,
      stats: {
        version:
          VERSION,
        totalUsers:
          userList.length,
        activeUsers:
          userList.filter(
            (user) =>
              !user.disabled
          ).length,
        disabledUsers:
          userList.filter(
            (user) =>
              user.disabled
          ).length,
        totalProjects:
          projects.length,
        aiGenerations,
        aiSeconds,
        studioJobs,
        narrationJobs,
        jobsInMemory:
          jobList.length,
        completedJobs:
          jobList.filter(
            (job) =>
              job.status ===
              "completed"
          ).length,
        processingJobs:
          jobList.filter(
            (job) =>
              job.status ===
                "processing" ||
              job.status ===
                "queued"
          ).length,
        failedJobs:
          jobList.filter(
            (job) =>
              job.status ===
              "failed"
          ).length,
        replicateConfigured:
          Boolean(
            REPLICATE_API_TOKEN
          ),
        recoveryConfigured:
          Boolean(
            RESEND_API_KEY &&
              RESEND_FROM
          ),
        paystackConfigured:
          Boolean(
            PAYSTACK_SECRET_KEY
          ),
        pricingConfigured:
          true,
        uptime:
          process.uptime(),
      },
    });
  }
);

/* =========================================================
   ADMIN USERS
========================================================= */

app.get(
  "/api/admin/users",
  requireAdmin,
  async (req, res) => {
    try {
      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      const list =
        await Promise.all(
          Object.values(
            users
          ).map(
            async (u) => ({
              id:
                u.id,
              name:
                u.name,
              email:
                u.email,
              role:
                u.role,
              disabled:
                Boolean(
                  u.disabled
                ),
              createdAt:
                u.createdAt,
              lastLoginAt:
                u.lastLoginAt,
              lastActiveAt:
                u.lastActiveAt,
              credits:
                await getUserCredits(
                  u.id
                ),
            })
          )
        );

      res.json({
        ok: true,
        users:
          list,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/users",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "ADMIN_USERS_FAILED",
      });
    }
  }
);

app.post(
  "/api/admin/users/:id/credits",
  requireAdmin,
  async (req, res) => {
    try {
      const amount =
        Number(
          req.body.amount
        );

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      if (
        !users[
          req.params.id
        ]
      ) {
        return res.status(404).json({
          ok: false,
          error:
            "USER_NOT_FOUND",
        });
      }

      const balance =
        await addUserCredits(
          req.params.id,
          amount,
          "ADMIN_ADJUSTMENT"
        );

      await recordSecurityEvent(
        "ADMIN_CREDIT_ADJUSTMENT",
        {
          adminId:
            req.user.id,
          userId:
            req.params.id,
          amount,
        }
      );

      res.json({
        ok: true,
        balance,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/users/:id/credits",
        }
      );

      res.status(400).json({
        ok: false,
        error:
          "CREDIT_ADJUSTMENT_FAILED",
        message:
          error.message,
      });
    }
  }
);

/* =========================================================
   ADMIN JOBS / ERRORS / SECURITY
========================================================= */

app.get(
  "/api/admin/jobs",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      jobs:
        Array.from(
          jobs.values()
        ).reverse(),
    });
  }
);

app.get(
  "/api/admin/errors",
  requireAdmin,
  async (req, res) => {
    const errors =
      await readJson(
        ERRORS_FILE,
        {}
      );

    res.json({
      ok: true,
      errors:
        Object.values(
          errors
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
        ),
    });
  }
);

app.get(
  "/api/admin/security",
  requireAdmin,
  async (req, res) => {
    const security =
      await readJson(
        SECURITY_FILE,
        {}
      );

    res.json({
      ok: true,
      events:
        Object.values(
          security
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
        ),
    });
  }
);

/* =========================================================
   ADMIN FINANCE
========================================================= */

app.get(
  "/api/admin/finance",
  requireAdmin,
  async (req, res) => {
    try {
      const finance =
        await readFinance();

      const summary =
        financeSummary(
          finance.transactions
        );

      const wallet =
        await ownerFinancialSnapshot();

      res.json({
        ok: true,
        summary,
        wallet,
        transactions:
          finance.transactions
            .slice()
            .reverse(),
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/finance",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "FINANCE_FAILED",
      });
    }
  }
);

app.post(
  "/api/admin/finance",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        cleanText(
          req.body.type ||
            "OTHER_COST",
          100
        );

      const amount =
        Number(
          req.body.amount
        );

      const description =
        cleanText(
          req.body.description,
          500
        );

      await addFinanceTransaction(
        type,
        amount,
        description
      );

      await recordSecurityEvent(
        "ADMIN_FINANCE_ADJUSTMENT",
        {
          adminId:
            req.user.id,
          type,
          amount,
          description,
        }
      );

      res.json({
        ok: true,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/finance",
        }
      );

      res.status(400).json({
        ok: false,
        error:
          "FINANCE_ADJUSTMENT_FAILED",
        message:
          error.message,
      });
    }
  }
);

/* =========================================================
   ADMIN PAYMENTS / PRICING
========================================================= */

app.get(
  "/api/admin/payments",
  requireAdmin,
  async (req, res) => {
    try {
      const payments =
        await readPayments();

      res.json({
        ok: true,
        payments:
          payments.transactions
            .slice()
            .reverse(),
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/payments",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "ADMIN_PAYMENTS_FAILED",
      });
    }
  }
);

app.get(
  "/api/admin/pricing",
  requireAdmin,
  async (req, res) => {
    try {
      const fx =
        await getFxRates();

      const packages =
        await getPricingPackages(
          "NGN"
        );

      res.json({
        ok: true,
        fx,
        packages,
        configuration: {
          targetMargin:
            TARGET_MARGIN,
          fixedMarkupPerUsd:
            FIXED_NGN_MARKUP_PER_USD,
          paymentFeeBuffer:
            PAYMENT_FEE_BUFFER,
          fxBuffer:
            FX_BUFFER,
        },
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/pricing",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "ADMIN_PRICING_FAILED",
      });
    }
  }
);

/* =========================================================
   ADMIN WITHDRAWAL
========================================================= */

app.post(
  "/api/admin/withdraw",
  requireAdmin,
  async (req, res) => {
    try {
      if (
        !PAYSTACK_SECRET_KEY
      ) {
        return res.status(503).json({
          ok: false,
          error:
            "PAYSTACK_NOT_CONFIGURED",
          message:
            "Paystack is not configured.",
        });
      }

      const amount =
        Number(
          req.body.amount
        );

      const name =
        cleanText(
          req.body.name,
          200
        );

      const accountNumber =
        cleanText(
          req.body.accountNumber,
          50
        );

      const bankCode =
        cleanText(
          req.body.bankCode,
          50
        );

      if (
        !Number.isFinite(
          amount
        ) ||
        amount <= 0 ||
        !name ||
        !accountNumber ||
        !bankCode
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_WITHDRAWAL_INPUT",
          message:
            "Amount, name, account number and bank code are required.",
        });
      }

      const wallet =
        await ownerFinancialSnapshot();

      if (
        amount >
        wallet.availableToWithdraw
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "WITHDRAWAL_EXCEEDS_AVAILABLE_PROFIT",
          available:
            wallet.availableToWithdraw,
        });
      }

      const recipient =
        await paystackRequest(
          "/transferrecipient",
          {
            method:
              "POST",
            body:
              JSON.stringify({
                type:
                  "nuban",
                name,
                account_number:
                  accountNumber,
                bank_code:
                  bankCode,
                currency:
                  "NGN",
                description:
                  "MAMAKI owner payout",
              }),
          }
        );

      const reference =
        `mamaki_payout_${Date.now()}_${randomBytes(
          5
        ).toString(
          "hex"
        )}`;

      const transfer =
        await paystackRequest(
          "/transfer",
          {
            method:
              "POST",
            body:
              JSON.stringify({
                source:
                  "balance",
                amount:
                  amount * 100,
                recipient:
                  recipient.data
                    .recipient_code,
                reference,
                reason:
                  "MAMAKI owner profit withdrawal",
                currency:
                  "NGN",
              }),
          }
        );

      const status =
        transfer.data
          ?.status ||
        "pending";

      const d =
        await readWithdrawals();

      d.withdrawals.push({
        id: randomUUID(),
        reference,
        amount,
        name,
        accountNumber:
          accountNumber.slice(
            -4
          ),
        bankCode,
        status,
        transferCode:
          transfer.data
            ?.transfer_code ||
          null,
        createdAt:
          new Date().toISOString(),
      });

      await writeWithdrawals(
        d
      );

      if (
        status ===
        "success"
      ) {
        await addFinanceTransaction(
          "OWNER_WITHDRAWAL",
          amount,
          `Owner profit withdrawal ${reference}`
        );
      }

      await recordSecurityEvent(
        "OWNER_WITHDRAWAL_INITIATED",
        {
          userId:
            req.user.id,
          reference,
          amount,
          status,
        }
      );

      res.json({
        ok: true,
        reference,
        status,
        message:
          status ===
          "otp"
            ? "Transfer requires OTP finalization."
            : "Withdrawal submitted.",
      });
    } catch (e) {
      await recordError(
        e,
        {
          route:
            "/api/admin/withdraw",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "WITHDRAWAL_FAILED",
        message:
          e.message,
      });
    }
  }
);

/* =========================================================
   ADMIN HTML
========================================================= */

app.get(
  "/admin",
  async (req, res) => {
    res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>MAMAKI Administrator</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  background:#07070b;
  color:#fff;
  font-family:Arial,Helvetica,sans-serif;
}
.wrap{
  max-width:1200px;
  margin:auto;
  padding:24px;
}
.card{
  background:#111117;
  border:1px solid #292932;
  border-radius:18px;
  padding:20px;
  margin-bottom:18px;
}
h1,h2,h3{margin-top:0}
input,select,button,textarea{
  width:100%;
  padding:13px;
  border-radius:10px;
  border:1px solid #33333d;
  background:#0a0a0f;
  color:#fff;
  margin:6px 0;
}
button{
  cursor:pointer;
  background:#fff;
  color:#000;
  font-weight:700;
}
button:disabled{
  opacity:.55;
  cursor:not-allowed;
}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:12px;
}
.stat{
  background:#0b0b10;
  border:1px solid #272730;
  padding:16px;
  border-radius:14px;
}
.num{
  font-size:28px;
  font-weight:800;
}
.muted{
  color:#9999a5;
}
pre{
  white-space:pre-wrap;
  word-break:break-word;
  max-height:450px;
  overflow:auto;
  background:#08080c;
  padding:14px;
  border-radius:12px;
}
.hidden{display:none!important}
.primary{
  background:#fff;
  color:#000;
}
.danger{
  background:#ff5252;
  color:#fff;
}
.success{
  color:#65e6a1;
}
</style>
</head>
<body>
<div class="wrap">

<div id="login" class="card">
<h1>🔐 MAMAKI Administrator</h1>
<p class="muted">Private administrator access.</p>

<input id="email"
type="email"
placeholder="Administrator email"
autocomplete="username">

<input id="password"
type="password"
placeholder="Administrator password"
autocomplete="current-password">

<button class="primary" onclick="login()">Login</button>

<div id="msg" class="muted"></div>
</div>

<div id="dash" class="hidden">

<div class="card">
<h1>✨ MAMAKI Administrator</h1>
<p id="statusText" class="muted">
Loading administrator dashboard...
</p>
<button onclick="logout()">Logout</button>
</div>

<div class="card">
<h2>Overview</h2>
<div id="stats" class="grid"></div>
</div>

<div class="card">
<h2>Finance</h2>
<div id="finance" class="grid"></div>
</div>

<div class="card">
<h2>Pricing</h2>
<pre id="pricing"></pre>
</div>

<div class="card">
<h2>Users</h2>
<pre id="users"></pre>
</div>

<div class="card">
<h2>Jobs</h2>
<pre id="jobs"></pre>
</div>

<div class="card">
<h2>Payments</h2>
<pre id="payments"></pre>
</div>

<div class="card">
<h2>Security</h2>
<pre id="security"></pre>
</div>

<div class="card">
<h2>Errors</h2>
<pre id="errors"></pre>
</div>

<div class="card">
<h2>Manual Credit Adjustment</h2>

<input id="creditUser"
placeholder="User ID">

<input id="creditAmount"
type="number"
placeholder="Credits to add">

<button onclick="addCredits()">
Add Credits
</button>

<div id="creditMsg" class="muted"></div>
</div>

<div class="card">
<h2>Owner Profit Withdrawal</h2>

<input id="withdrawAmount"
type="number"
placeholder="Amount in NGN">

<input id="withdrawName"
placeholder="Account name">

<input id="withdrawAccount"
placeholder="Bank account number">

<input id="withdrawBank"
placeholder="Bank code">

<button onclick="withdraw()">
Submit Withdrawal
</button>

<div id="withdrawMsg" class="muted"></div>
</div>

</div>

</div>

<script>
let token=localStorage.getItem(
  "mamaki_admin_token"
)||"";

const $=id=>document.getElementById(id);

async function api(url,options={}){
  options.headers={
    ...(options.headers||{}),
    Authorization:"Bearer "+token,
    Accept:"application/json"
  };

  const r=await fetch(url,options);
  const text=await r.text();

  let d={};

  try{
    d=JSON.parse(text);
  }catch{
    throw new Error(
      "Server returned invalid response HTTP "+r.status
    );
  }

  if(!r.ok||!d.ok){
    throw new Error(
      d.message||
      d.error||
      "Request failed"
    );
  }

  return d;
}

async function login(){
  const m=$("msg");
  const b=document.querySelector(
    "#login button.primary"
  );

  try{
    m.textContent="Signing in...";
    b.disabled=true;

    const email=String(
      $("email").value||""
    ).trim().toLowerCase();

    const password=String(
      $("password").value||""
    );

    if(!email||!password){
      throw new Error(
        "Enter the administrator email and password."
      );
    }

    const r=await fetch(
      "/api/admin/login",
      {
        method:"POST",
        headers:{
          "Content-Type":
            "application/json",
          Accept:
            "application/json"
        },
        body:JSON.stringify({
          email,
          password
        }),
        cache:"no-store"
      }
    );

    const text=await r.text();

    let d={};

    try{
      d=JSON.parse(text);
    }catch{
      throw new Error(
        "Server returned an invalid response (HTTP "+r.status+"). Refresh the page and try again."
      );
    }

    if(!r.ok||!d.ok){
      throw new Error(
        d.message||
        d.error||
        "Administrator login failed."
      );
    }

    if(!d.token){
      throw new Error(
        "Login succeeded but no administrator session token was returned."
      );
    }

    token=d.token;

    localStorage.setItem(
      "mamaki_admin_token",
      token
    );

    m.textContent=
      "Login successful. Loading dashboard...";

    await loadAll(true);

  }catch(e){
    localStorage.removeItem(
      "mamaki_admin_token"
    );

    token="";

    m.textContent=
      e?.message||
      "Administrator login failed.";

  }finally{
    b.disabled=false;
  }
}

async function loadAll(fromLogin=false){
  try{
    $("login").classList.add(
      "hidden"
    );

    $("dash").classList.remove(
      "hidden"
    );

    const[
      stats,
      finance,
      pricing,
      users,
      jobs,
      payments,
      security,
      errors
    ]=await Promise.all([
      api("/api/admin/stats"),
      api("/api/admin/finance"),
      api("/api/admin/pricing"),
      api("/api/admin/users"),
      api("/api/admin/jobs"),
      api("/api/admin/payments"),
      api("/api/admin/security"),
      api("/api/admin/errors")
    ]);

    const s=stats.stats||{};

    $("stats").innerHTML=
      stat("Total Users",s.totalUsers) +
      stat("Active Users",s.activeUsers) +
      stat("Administrators",
        (users.users||[]).filter(
          u=>u.role==="admin"
        ).length
      )+
      stat("Projects",s.totalProjects)+
      stat("AI Generations",s.aiGenerations)+
      stat("AI Seconds",s.aiSeconds)+
      stat("Completed",s.completedJobs)+
      stat("Processing",s.processingJobs)+
      stat("Failed",s.failedJobs);

    const f=
      finance.wallet||
      finance.summary||
      {};

    $("finance").innerHTML=
      stat("Gross Revenue",
        money(f.grossRevenue)
      )+
      stat("Refunds",
        money(f.refunds)
      )+
      stat("Costs",
        money(f.costs)
      )+
      stat("Profit",
        money(f.profit)
      )+
      stat("Withdrawn",
        money(f.withdrawn)
      )+
      stat("Available",
        money(f.availableToWithdraw)
      );

    $("pricing").textContent=
      JSON.stringify(
        pricing,
        null,
        2
      );

    $("users").textContent=
      JSON.stringify(
        users.users||[],
        null,
        2
      );

    $("jobs").textContent=
      JSON.stringify(
        jobs.jobs||[],
        null,
        2
      );

    $("payments").textContent=
      JSON.stringify(
        payments.payments||[],
        null,
        2
      );

    $("security").textContent=
      JSON.stringify(
        security.events||[],
        null,
        2
      );

    $("errors").textContent=
      JSON.stringify(
        errors.errors||[],
        null,
        2
      );

    $("statusText").textContent=
      "System healthy · Version "+
      (s.version||"18.1.0");

  }catch(e){
    if(
      String(
        e.message||""
      ).includes(
        "Administrator access required"
      )||
      String(
        e.message||""
      ).includes(
        "AUTH_REQUIRED"
      )
    ){
      localStorage.removeItem(
        "mamaki_admin_token"
      );

      token="";

      $("login").classList.remove(
        "hidden"
      );

      $("dash").classList.add(
        "hidden"
      );

      $("msg").textContent=
        "Your administrator session expired. Please sign in again.";
    }else{
      $("statusText").textContent=
        e.message;
    }
  }
}

function stat(name,value){
  return '<div class="stat">'+
    '<div class="muted">'+
    esc(name)+
    '</div>'+
    '<div class="num">'+
    esc(value) +
    '</div>'+
    '</div>';
}

function money(value){
  const n=Number(value||0);
  return "₦"+
    n.toLocaleString(
      "en-NG",
      {
        maximumFractionDigits:2
      }
    );
}

function esc(v){
  return String(v??"")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}

async function addCredits(){
  try{
    const id=
      $("creditUser").value.trim();

    const amount=
      Number(
        $("creditAmount").value
      );

    const d=await api(
      "/api/admin/users/"+
      encodeURIComponent(id)+
      "/credits",
      {
        method:"POST",
        headers:{
          "Content-Type":
            "application/json"
        },
        body:JSON.stringify({
          amount
        })
      }
    );

    $("creditMsg").textContent=
      "Credits updated. New balance: "+
      d.balance;

    await loadAll();

  }catch(e){
    $("creditMsg").textContent=
      e.message;
  }
}

async function withdraw(){
  try{
    const d=await api(
      "/api/admin/withdraw",
      {
        method:"POST",
        headers:{
          "Content-Type":
            "application/json"
        },
        body:JSON.stringify({
          amount:Number(
            $("withdrawAmount").value
          ),
          name:
            $("withdrawName").value,
          accountNumber:
            $("withdrawAccount").value,
          bankCode:
            $("withdrawBank").value
        })
      }
    );

    $("withdrawMsg").textContent=
      d.message||
      ("Withdrawal "+
       d.status+
       " · "+
       d.reference);

    await loadAll();

  }catch(e){
    $("withdrawMsg").textContent=
      e.message;
  }
}

async function logout(){
  try{
    if(token){
      await fetch(
        "/api/auth/logout",
        {
          method:"POST",
          headers:{
            Authorization:
              "Bearer "+token
          }
        }
      );
    }
  }catch{}

  token="";

  localStorage.removeItem(
    "mamaki_admin_token"
  );

  $("dash").classList.add(
    "hidden"
  );

  $("login").classList.remove(
    "hidden"
  );

  $("msg").textContent=
    "Logged out.";
}

if(token){
  loadAll();
}
</script>
</body>
</html>
`);
  }
);

/* =========================================================
   PUBLIC ROOT
   Keeps index.html as the main interface and injects
   Buy Credits + Password Recovery without removing
   the existing interface.
========================================================= */

app.get(
  "/",
  async (req, res) => {
    try {
      let html =
        await fs.readFile(
          path.join(
            ROOT,
            "index.html"
          ),
          "utf8"
        );

      const injection = `
<style>
#mamakiBillingLauncher,
#mamakiRecoveryLauncher{
  position:fixed;
  right:18px;
  z-index:9998;
  border:0;
  border-radius:999px;
  padding:13px 18px;
  font-weight:800;
  cursor:pointer;
  box-shadow:0 10px 35px rgba(0,0,0,.35);
}
#mamakiBillingLauncher{
  bottom:76px;
  background:#fff;
  color:#000;
}
#mamakiRecoveryLauncher{
  bottom:18px;
  background:#16161d;
  color:#fff;
  border:1px solid #33333d;
}
#mamakiBillingModal,
#mamakiRecoveryModal{
  position:fixed;
  inset:0;
  z-index:10000;
  background:rgba(0,0,0,.72);
  display:none;
  align-items:center;
  justify-content:center;
  padding:18px;
}
.mamakiModalCard{
  width:min(620px,100%);
  max-height:90vh;
  overflow:auto;
  background:#101016;
  color:#fff;
  border:1px solid #30303a;
  border-radius:20px;
  padding:22px;
  box-shadow:0 25px 80px rgba(0,0,0,.5);
}
.mamakiModalCard input,
.mamakiModalCard select,
.mamakiModalCard button{
  width:100%;
  box-sizing:border-box;
  margin:6px 0;
  padding:13px;
  border-radius:10px;
  border:1px solid #35353f;
}
.mamakiModalCard input,
.mamakiModalCard select{
  background:#08080d;
  color:#fff;
}
.mamakiModalCard button{
  cursor:pointer;
  background:#fff;
  color:#000;
  font-weight:800;
}
.mamakiClose{
  float:right;
  width:auto!important;
  padding:8px 12px!important;
  background:#22222a!important;
  color:#fff!important;
}
.mamakiPackages{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
  gap:10px;
  margin:14px 0;
}
.mamakiPackage{
  border:1px solid #33333d;
  background:#0b0b10;
  color:#fff;
  padding:15px;
  border-radius:14px;
  cursor:pointer;
  text-align:left;
}
.mamakiPackage:hover{
  border-color:#fff;
}
.mamakiPackage strong{
  display:block;
  font-size:20px;
  margin-bottom:4px;
}
.mamakiMuted{
  color:#9999a5;
}
.mamakiMsg{
  min-height:24px;
  margin-top:8px;
}
@media(max-width:600px){
  #mamakiBillingLauncher,
  #mamakiRecoveryLauncher{
    right:10px;
  }
}
</style>

<button id="mamakiBillingLauncher">
🪙 Buy MAMAKI Credits
</button>

<button id="mamakiRecoveryLauncher">
🔐 Recover Password
</button>

<div id="mamakiBillingModal">
  <div class="mamakiModalCard">
    <button class="mamakiClose"
      onclick="closeMamakiBilling()">
      ✕
    </button>

    <h2>🪙 Buy MAMAKI AI Credits</h2>

    <p class="mamakiMuted">
      Select a credit package and continue securely with Paystack.
    </p>

    <div id="mamakiPackages"
      class="mamakiPackages">
      Loading current prices...
    </div>

    <div id="mamakiBillingMsg"
      class="mamakiMsg">
    </div>
  </div>
</div>

<div id="mamakiRecoveryModal">
  <div class="mamakiModalCard">
    <button class="mamakiClose"
      onclick="closeMamakiRecovery()">
      ✕
    </button>

    <h2>🔐 Recover MAMAKI Password</h2>

    <p class="mamakiMuted">
      Enter the email connected to your MAMAKI account.
    </p>

    <input
      id="mamakiRecoveryEmail"
      type="email"
      placeholder="Your account email"
    >

    <button
      id="mamakiSendCode">
      Send Recovery Code
    </button>

    <div id="mamakiRecoveryStep2"
      style="display:none">

      <input
        id="mamakiRecoveryCode"
        inputmode="numeric"
        maxlength="6"
        placeholder="6-digit recovery code"
      >

      <input
        id="mamakiNewPassword"
        type="password"
        placeholder="New password"
      >

      <button
        id="mamakiResetPassword">
        Change Password
      </button>
    </div>

    <div id="mamakiRecoveryMsg"
      class="mamakiMsg">
    </div>
  </div>
</div>

<script>
(function(){

const billingModal=
  document.getElementById(
    "mamakiBillingModal"
  );

const recoveryModal=
  document.getElementById(
    "mamakiRecoveryModal"
  );

const billingMsg=
  document.getElementById(
    "mamakiBillingMsg"
  );

const recoveryMsg=
  document.getElementById(
    "mamakiRecoveryMsg"
  );

function token(){
  return localStorage.getItem(
    "mamaki_token"
  )||
  localStorage.getItem(
    "token"
  )||
  "";
}

function openBilling(){
  billingModal.style.display=
    "flex";
  loadPackages();
}

function closeBilling(){
  billingModal.style.display=
    "none";
}

function openRecovery(){
  recoveryModal.style.display=
    "flex";
}

function closeRecovery(){
  recoveryModal.style.display=
    "none";
}

window.closeMamakiBilling=
  closeBilling;

window.closeMamakiRecovery=
  closeRecovery;

document.getElementById(
  "mamakiBillingLauncher"
).addEventListener(
  "click",
  openBilling
);

document.getElementById(
  "mamakiRecoveryLauncher"
).addEventListener(
  "click",
  openRecovery
);

async function loadPackages(){
  const box=
    document.getElementById(
      "mamakiPackages"
    );

  box.innerHTML=
    "Loading current prices...";

  try{
    const r=
      await fetch(
        "/api/billing/pricing?currency=NGN",
        {
          cache:"no-store"
        }
      );

    const d=
      await r.json();

    if(!r.ok||!d.ok){
      throw new Error(
        d.message||
        "Unable to load prices."
      );
    }

    if(!d.paystackConfigured){
      billingMsg.textContent=
        "Payments are not configured yet.";
    }

    box.innerHTML=
      "";

    (d.packages||[])
      .forEach(
        p=>{
          const button=
            document.createElement(
              "button"
            );

          button.className=
            "mamakiPackage";

          button.innerHTML=
            "<strong>"+
            p.credits.toLocaleString()+
            " credits</strong>"+
            "<span>₦"+
            Number(
              p.amount
            ).toLocaleString(
              "en-NG"
            )+
            "</span>";

          button.addEventListener(
            "click",
            ()=>buyCredits(
              p.credits
            )
          );

          box.appendChild(
            button
          );
        }
      );

  }catch(e){
    box.innerHTML=
      "Unable to load current prices.";

    billingMsg.textContent=
      e.message;
  }
}

async function buyCredits(
  credits
){
  billingMsg.textContent=
    "Preparing secure Paystack checkout...";

  const t=
    token();

  if(!t){
    billingMsg.textContent=
      "Please log in to your MAMAKI account before buying credits.";
    return;
  }

  try{
    const r=
      await fetch(
        "/api/billing/paystack/initialize",
        {
          method:"POST",
          headers:{
            "Content-Type":
              "application/json",
            Authorization:
              "Bearer "+t
          },
          body:JSON.stringify({
            credits,
            currency:"NGN"
          })
        }
      );

    const d=
      await r.json();

    if(!r.ok||!d.ok){
      throw new Error(
        d.message||
        d.error||
        "Unable to initialize payment."
      );
    }

    if(
      !d.authorizationUrl
    ){
      throw new Error(
        "Paystack did not return a checkout URL."
      );
    }

    window.location.href=
      d.authorizationUrl;

  }catch(e){
    billingMsg.textContent=
      e.message;
  }
}

async function sendRecoveryCode(){
  const email=
    document.getElementById(
      "mamakiRecoveryEmail"
    ).value
    .trim()
    .toLowerCase();

  if(!email){
    recoveryMsg.textContent=
      "Enter your account email.";
    return;
  }

  const button=
    document.getElementById(
      "mamakiSendCode"
    );

  button.disabled=
    true;

  recoveryMsg.textContent=
    "Sending recovery code...";

  try{
    const r=
      await fetch(
        "/api/auth/forgot-password",
        {
          method:"POST",
          headers:{
            "Content-Type":
              "application/json"
          },
          body:JSON.stringify({
            email
          })
        }
      );

    const d=
      await r.json();

    if(!r.ok||!d.ok){
      throw new Error(
        d.message||
        d.error||
        "Unable to send recovery code."
      );
    }

    document.getElementById(
      "mamakiRecoveryStep2"
    ).style.display=
      "block";

    recoveryMsg.textContent=
      d.message||
      "If the account exists, a recovery code has been sent.";

  }catch(e){
    recoveryMsg.textContent=
      e.message;
  }finally{
    button.disabled=
      false;
  }
}

async function resetPassword(){
  const email=
    document.getElementById(
      "mamakiRecoveryEmail"
    ).value
    .trim()
    .toLowerCase();

  const code=
    document.getElementById(
      "mamakiRecoveryCode"
    ).value
    .trim();

  const password=
    document.getElementById(
      "mamakiNewPassword"
    ).value;

  if(
    !email||
    !code||
    !password
  ){
    recoveryMsg.textContent=
      "Email, recovery code and new password are required.";
    return;
  }

  const button=
    document.getElementById(
      "mamakiResetPassword"
    );

  button.disabled=
    true;

  recoveryMsg.textContent=
    "Changing password...";

  try{
    const r=
      await fetch(
        "/api/auth/reset-password",
        {
          method:"POST",
          headers:{
            "Content-Type":
              "application/json"
          },
          body:JSON.stringify({
            email,
            code,
            password
          })
        }
      );

    const d=
      await r.json();

    if(!r.ok||!d.ok){
      throw new Error(
        d.message||
        d.error||
        "Unable to change password."
      );
    }

    recoveryMsg.textContent=
      d.message||
      "Password changed successfully.";

    document.getElementById(
      "mamakiRecoveryCode"
    ).value=
      "";

    document.getElementById(
      "mamakiNewPassword"
    ).value=
      "";

  }catch(e){
    recoveryMsg.textContent=
      e.message;
  }finally{
    button.disabled=
      false;
  }
}

document.getElementById(
  "mamakiSendCode"
).addEventListener(
  "click",
  sendRecoveryCode
);

document.getElementById(
  "mamakiResetPassword"
).addEventListener(
  "click",
  resetPassword
);

async function verifyPaymentFromReturn(){
  const params=
    new URLSearchParams(
      window.location.search
    );

  if(
    params.get(
      "payment"
    )!=="complete"
  ){
    return;
  }

  const reference=
    params.get(
      "reference"
    );

  if(!reference){
    return;
  }

  const t=
    token();

  if(!t){
    return;
  }

  try{
    const r=
      await fetch(
        "/api/billing/paystack/verify/"+
        encodeURIComponent(
          reference
        ),
        {
          headers:{
            Authorization:
              "Bearer "+t
          },
          cache:"no-store"
        }
      );

    const d=
      await r.json();

    if(
      r.ok&&
      d.ok
    ){
      alert(
        "Payment successful. Your MAMAKI credits have been added."
      );
    }else{
      alert(
        d.message||
        "Payment verification is still pending."
      );
    }

    const cleanUrl=
      window.location.origin+
      window.location.pathname;

    window.history.replaceState(
      {},
      document.title,
      cleanUrl
    );

  }catch(e){
    console.error(
      "MAMAKI payment verification:",
      e
    );
  }
}

verifyPaymentFromReturn();

})();
</script>
`;

      if (
        html.includes(
          "</body>"
        )
      ) {
        html =
          html.replace(
            "</body>",
            injection +
              "</body>"
          );
      } else {
        html +=
          injection;
      }

      res.type("html").send(
        html
      );
    } catch (error) {
      await recordError(
        error,
        {
          route: "/",
        }
      );

      res.status(500).send(
        "MAMAKI interface could not be loaded."
      );
    }
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        "NOT_FOUND",
      message:
        "MAMAKI endpoint not found.",
    });
  }
);

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
  async (
    error,
    req,
    res,
    next
  ) => {
    await recordError(
      error,
      {
        route:
          req.originalUrl,
        method:
          req.method,
      }
    );

    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }

    res.status(500).json({
      ok: false,
      error:
        "INTERNAL_SERVER_ERROR",
      message:
        "MAMAKI encountered an unexpected server error.",
    });
  }
);

/* =========================================================
   JOB CLEANUP
========================================================= */

setInterval(
  () => {
    const now =
      Date.now();

    for (
      const [
        id,
        job,
      ] of jobs.entries()
    ) {
      const finished =
        job.status ===
          "completed" ||
        job.status ===
          "failed";

      const time =
        Date.parse(
          job.completedAt ||
            job.createdAt ||
            ""
        );

      if (
        finished &&
        Number.isFinite(
          time
        ) &&
        now - time >
          60 *
            60 *
            1000
      ) {
        jobs.delete(
          id
        );
      }
    }
  },
  10 *
    60 *
    1000
);

/* =========================================================
   START SERVER
========================================================= */

await ensureStorage();

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `✨ MAMAKI AI v${VERSION} running on ${HOST}:${PORT}`
    );

    console.log(
      `Replicate configured: ${Boolean(
        REPLICATE_API_TOKEN
      )}`
    );

    console.log(
      `Admin configured: ${Boolean(
        ADMIN_EMAIL &&
          ADMIN_PASSWORD
      )}`
    );

    console.log(
      `Paystack configured: ${Boolean(
        PAYSTACK_SECRET_KEY
      )}`
    );

    console.log(
      `Password recovery configured: ${Boolean(
        RESEND_API_KEY &&
          RESEND_FROM
      )}`
    );
  }
);
