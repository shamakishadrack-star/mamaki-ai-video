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
  Number(process.env.FIXED_NGN_MARKUP_PER_USD || 200)
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
  ? new Replicate({ auth: REPLICATE_API_TOKEN })
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
      const unit = String(
        match[2] || "s"
      ).toLowerCase();

      if (
        ["m", "min", "mins"].includes(unit)
      ) {
        n *= 60;
      }

      if (
        ["h", "hr", "hrs"].includes(unit)
      ) {
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
  if (ratio === "9:16") {
    return "1080:1920";
  }

  if (ratio === "1:1") {
    return "1080:1080";
  }

  return "1920:1080";
}

function wanFrames(seconds) {
  return Number(seconds) <= 5 ? 81 : 121;
}

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function safeFileName(name, fallback = "file") {
  const base = path.basename(
    String(name || fallback)
  );

  return base
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 150);
}

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
    randomBytes(32).toString("hex");

  const secretPart = SESSION_SECRET
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

  for (
    const [token, session]
    of Object.entries(sessions)
  ) {
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

  if (!token) {
    return null;
  }

  const sessions = await readJson(
    SESSIONS_FILE,
    {}
  );

  const session = sessions[token];

  if (!session) {
    return null;
  }

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

  if (!session) {
    return null;
  }

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

  if (
    !user ||
    user.role !== "admin"
  ) {
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
    // Logging must never crash the application.
  }
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

function classifyReplicateError(error) {
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
    const url = await output.url();

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
    for (
      const key of [
        "video",
        "output",
        "url",
        "file",
      ]
    ) {
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

          const error =
            new Error(
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
    Math.ceil(
      targetSeconds / 5
    )
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

  const enhanced =
    `${prompt}\n\nOutput requirements: ${ratio} aspect ratio, professional ${
      quality || "standard"
    } quality.`;

  const input = {
    prompt: enhanced,
    num_frames: frames,
    aspect_ratio: ratio,
  };

  try {
    return await replicate.run(
      T2V_MODEL,
      { input }
    );
  } catch (error) {
    const classified =
      classifyReplicateError(
        error
      );

    error.code =
      classified.code;

    error.mamakiMessage =
      classified.message;

    throw error;
  }
}

async function wanImageToVideo(
  prompt,
  imageBuffer,
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

  const base64 =
    imageBuffer.toString(
      "base64"
    );

  const dataUri =
    `data:image/jpeg;base64,${base64}`;

  const input = {
    prompt:
      `${prompt}\n\nCreate coherent motion from the supplied reference image. Aspect ratio ${ratio}. Quality ${
        quality || "standard"
      }.`,
    image: dataUri,
    num_frames: frames,
    aspect_ratio: ratio,
  };

  try {
    return await replicate.run(
      I2V_MODEL,
      { input }
    );
  } catch (error) {
    const classified =
      classifyReplicateError(
        error
      );

    error.code =
      classified.code;

    error.mamakiMessage =
      classified.message;

    throw error;
  }
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
  const scenes =
    splitIntoScenes(
      prompt,
      duration
    );

  if (!scenes.length) {
    throw new Error(
      "Please describe the video you want to create."
    );
  }

  const sceneDuration = 5;
  const files = [];

  job.totalScenes =
    scenes.length;

  for (
    let i = 0;
    i < scenes.length;
    i++
  ) {
    if (job.cancelled) {
      throw new Error(
        "Production cancelled."
      );
    }

    job.currentScene =
      i + 1;

    job.progress = Math.round(
      (i / scenes.length) *
        75
    );

    const scenePrompt =
      enhancePrompt(
        scenes[i],
        style
      );

    const rawFile =
      path.join(
        TMP,
        `${job.id}-scene-${i}.mp4`
      );

    const output =
      imageBuffer && i === 0
        ? await wanImageToVideo(
            scenePrompt,
            imageBuffer,
            sceneDuration,
            ratio,
            quality
          )
        : await wanTextToVideo(
            scenePrompt,
            sceneDuration,
            ratio,
            quality
          );

    await downloadReplicateOutput(
      output,
      rawFile
    );

    files.push(rawFile);

    job.progress = Math.round(
      ((i + 1) /
        scenes.length) *
        75
    );
  }

  const combined =
    path.join(
      OUTPUTS,
      `${job.id}-combined.mp4`
    );

  await combineVideoFiles(
    files,
    combined
  );

  job.progress = 82;

  const durationFile =
    path.join(
      OUTPUTS,
      `${job.id}-duration.mp4`
    );

  await forceDuration(
    combined,
    durationFile,
    duration
  );

  job.progress = 88;

  const music =
    path.join(
      TMP,
      `${job.id}-music.m4a`
    );

  await createSoftMusic(
    music,
    duration
  );

  const audioFile =
    path.join(
      OUTPUTS,
      `${job.id}-audio.mp4`
    );

  await attachAudio(
    durationFile,
    music,
    audioFile
  );

  job.progress = 93;

  const final =
    path.join(
      OUTPUTS,
      `${job.id}.mp4`
    );

  await addWatermark(
    audioFile,
    final
  );

  job.progress = 100;

  await recordUsage(
    userId,
    "ai",
    duration
  );

  return final;
}

async function cleanupJobFiles(
  jobId
) {
  const outputNames = [
    `${jobId}-combined.mp4`,
    `${jobId}-duration.mp4`,
    `${jobId}-audio.mp4`,
    `${jobId}.mp4`,
  ];

  for (const name of outputNames) {
    await fs
      .unlink(
        path.join(
          OUTPUTS,
          name
        )
      )
      .catch(() => {});
  }

  const tmpEntries =
    await fs
      .readdir(TMP)
      .catch(() => []);

  for (
    const name of tmpEntries
  ) {
    if (
      name.startsWith(
        `${jobId}-`
      )
    ) {
      await fs
        .unlink(
          path.join(
            TMP,
            name
          )
        )
        .catch(() => {});
    }
  }
}

async function saveProjectForUser(
  userId,
  project
) {
  const id =
    project.id ||
    randomUUID();

  const file = path.join(
    PROJECTS,
    `${safeFileName(id)}.json`
  );

  const record = {
    ...project,
    id,
    userId,
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
      .catch(() => []);

  const result = [];

  for (const name of files) {
    if (!name.endsWith(".json")) {
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

/* ========================================================= PASSWORD RECOVERY ========================================================= */

const PASSWORD_RESET_EXPIRY =
  15 * 60 * 1000;

const PASSWORD_RESET_MAX_ATTEMPTS = 5;

function createResetCode() {
  return String(
    randomBytes(4).readUInt32BE(0) %
      1000000
  ).padStart(6, "0");
}

function hashResetCode(code) {
  return createHash("sha256")
    .update(
      `${code}:${SESSION_SECRET}`
    )
    .digest("hex");
}

function resetKey(email) {
  return createHash("sha256")
    .update(
      normalizeEmail(email)
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
      normalizeEmail(email),
    codeHash:
      hashResetCode(code),
    createdAt: Date.now(),
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
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${RESEND_API_KEY}`,
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          from: RESEND_FROM,
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

    if (ids.length > 300) {
      ids.sort((a, b) =>
        String(
          security[a]
            .createdAt
        ).localeCompare(
          String(
            security[b]
              .createdAt
          )
        )
      );

      while (ids.length > 300) {
        const old =
          ids.shift();

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

  const recent =
    current.filter(
      (time) =>
        now - time <
        windowMs
    );

  if (
    recent.length >=
    limit
  ) {
    map.set(
      key,
      recent
    );

    return false;
  }

  recent.push(now);

  map.set(
    key,
    recent
  );

  return true;
}

/* ========================================================= CREDITS & FINANCE ========================================================= */

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

async function writeCredits(d) {
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

    await writeCredits(
      d
    );
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

  await writeCredits(
    d
  );

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

  const bal =
    Number(
      d.users[id] || 0
    );

  if (bal < cost) {
    const e =
      new Error(
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
    seconds:
      Number(seconds || 0),
    createdAt:
      new Date().toISOString(),
  });

  await writeCredits(
    d
  );

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

  await writeCredits(
    d
  );
}

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

function financeSummary(ts) {
  let grossRevenue = 0;
  let refunds = 0;
  let costs = 0;

  for (const t of ts) {
    const type =
      String(
        t.type || ""
      ).toUpperCase();

    const a =
      Number(
        t.amount || 0
      );

    if (
      type ===
      "REVENUE"
    ) {
      grossRevenue += a;
    } else if (
      type ===
      "REFUND"
    ) {
      refunds += a;
    } else if (
      [
        "AI_COST",
        "INFRASTRUCTURE_COST",
        "OTHER_COST",
        "COST",
      ].includes(type)
    ) {
      costs += a;
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

/* ========================================================= SMART BILLING / PRICING / PAYMENTS ========================================================= */

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
  const c = String(
    value ||
      PAYSTACK_CURRENCY_DEFAULT ||
      "NGN"
  ).toUpperCase();

  return ["NGN", "USD"].includes(
    c
  )
    ? c
    : "USD";
}

async function getFxRates() {
  const now = Date.now();

  const store =
    await readStore(
      PRICING_FILE,
      {
        fx: null,
        updatedAt: null,
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
      30 * 60 * 1000
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
      error:
        String(
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
        Number(credits || 0) /
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
    q.includes("cinematic")
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
  const c = Math.max(
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
            customerNgnRaw / 50
          ) * 50
        )
      : Math.max(
          1,
          Math.round(
            pricingUsd * 100
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

async function writePayments(d) {
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

  await writePayments(
    d
  );

  return payment;
}

async function paystackRequest(
  endpoint,
  options = {}
) {
  if (!PAYSTACK_SECRET_KEY) {
    const e =
      new Error(
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
          Authorization:
            `Bearer ${PAYSTACK_SECRET_KEY}`,
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
    const e =
      new Error(
        data.message ||
          `Paystack HTTP ${r.status}`
      );

    e.status =
      r.status;

    e.data = data;

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
        verified.amount ||
          0
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
        verified.amount || 0
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

      await writePayments(
        d
      );
    }
  }

  return payment;
}

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

async function writeWithdrawals(d) {
  await writeStore(
    WITHDRAWALS_FILE,
    d
  );
}

function withdrawalTotals(
  withdrawals
) {
  return withdrawals
    .filter((x) =>
      [
        "success",
        "pending",
        "otp",
      ].includes(
        String(x.status)
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
      .filter((x) =>
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
        return res
          .status(503)
          .json({
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
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "INVALID_CREDIT_PACKAGE",
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
            method: "POST",
            body: JSON.stringify(
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
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "PAYMENT_NOT_FOUND",
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
            req.params
              .reference,
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
            "/api/payments/paystack/webhook",
        }
      );

      res.status(200).json({
        ok: true,
      });
    }
  }
);

app.get(
  "/api/billing/payment/:reference",
  requireUser,
  async (req, res) => {
    try {
      const p =
        await findPayment(
          req.params.reference
        );

      if (
        !p ||
        p.userId !==
          req.user.id
      ) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "PAYMENT_NOT_FOUND",
          });
      }

      if (
        PAYSTACK_SECRET_KEY &&
        !p.fulfilledAt
      ) {
        try {
          await fulfillSuccessfulPayment(
            p.reference
          );
        } catch {}
      }

      const fresh =
        await findPayment(
          p.reference
        );

      res.json({
        ok: true,
        payment:
          fresh,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error:
          "PAYMENT_STATUS_FAILED",
      });
    }
  }
);

app.get(
  "/api/admin/billing",
  requireAdmin,
  async (req, res) => {
    try {
      const [
        wallet,
        pricing,
        payments,
        withdrawals,
        fx,
      ] = await Promise.all([
        ownerFinancialSnapshot(),
        getPricingPackages(
          "NGN"
        ),
        readPayments(),
        readWithdrawals(),
        getFxRates(),
      ]);

      res.json({
        ok: true,
        wallet,
        fx,
        pricing,
        payments:
          payments.transactions
            .slice(-200)
            .reverse(),
        withdrawals:
          withdrawals.withdrawals
            .slice(-100)
            .reverse(),
        paystack: {
          configured:
            Boolean(
              PAYSTACK_SECRET_KEY
            ),
          publicKey:
            PAYSTACK_PUBLIC_KEY ||
            null,
          webhook:
            `${APP_URL}/api/paystack/webhook`,
        },
        fixedMarkupPerUsd:
          FIXED_NGN_MARKUP_PER_USD,
      });
    } catch (e) {
      await recordError(
        e,
        {
          route:
            "/api/admin/billing",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "BILLING_DASHBOARD_FAILED",
      });
    }
  }
);

app.post(
  "/api/admin/withdraw",
  requireAdmin,
  async (req, res) => {
    try {
      if (
        !PAYSTACK_SECRET_KEY
      ) {
        return res
          .status(503)
          .json({
            ok: false,
            error:
              "PAYOUT_NOT_CONFIGURED",
            message:
              "PAYSTACK_SECRET_KEY is not configured.",
          });
      }

      const amount =
        Math.floor(
          Number(
            req.body.amount ||
              0
          )
        );

      const name =
        cleanText(
          req.body.name,
          100
        );

      const accountNumber =
        cleanText(
          req.body
            .accountNumber,
          30
        );

      const bankCode =
        cleanText(
          req.body.bankCode,
          20
        );

      if (
        amount < 1000 ||
        !name ||
        !accountNumber ||
        !bankCode
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "INVALID_WITHDRAWAL_DETAILS",
          });
      }

      const wallet =
        await ownerFinancialSnapshot();

      if (
        amount >
        wallet.availableToWithdraw
      ) {
        return res
          .status(400)
          .json({
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
            method: "POST",
            body: JSON.stringify({
              type: "nuban",
              name,
              account_number:
                accountNumber,
              bank_code:
                bankCode,
              currency: "NGN",
              description:
                "MAMAKI owner payout",
            }),
          }
        );

      const reference =
        `mamaki_payout_${Date.now()}_${randomBytes(
          5
        ).toString("hex")}`;

      const transfer =
        await paystackRequest(
          "/transfer",
          {
            method: "POST",
            body: JSON.stringify({
              source: "balance",
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

/* ========================================================= BASIC SYSTEM ========================================================= */

app.get(
  "/health",
  async (req, res) => {
    res.json({
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
          Boolean(ffmpegPath),
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
        promptEnhancement:
          true,
        socialPresets: true,
        accounts: true,
        projects: true,
        admin:
          Boolean(
            ADMIN_EMAIL &&
              ADMIN_PASSWORD
          ),
        watermark:
          "MAMAKI ✨",
      },
    });
  }
);

/* ========================================================= AUTHENTICATION ========================================================= */

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
        return res
          .status(400)
          .json({
            ok: false,
            error:
             
