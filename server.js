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
  timingSafeEqual
} from "node:crypto";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const VERSION = "14.0.0";

const ROOT = process.cwd();

const TMP = path.join(ROOT, "tmp");
const OUTPUTS = path.join(ROOT, "outputs");
const PROJECTS = path.join(ROOT, "projects");
const DATA = path.join(ROOT, "data");

const USERS_FILE = path.join(DATA, "users.json");
const SESSIONS_FILE = path.join(DATA, "sessions.json");
const ERRORS_FILE = path.join(DATA, "errors.json");
const USAGE_FILE = path.join(DATA, "usage.json");

const WALLETS_FILE = path.join(DATA, "wallets.json");
const CREDIT_TX_FILE = path.join(DATA, "credit-transactions.json");
const FINANCE_FILE = path.join(DATA, "finance.json");
const GENERATIONS_FILE = path.join(DATA, "generations.json");
const EXPENSES_FILE = path.join(DATA, "expenses.json");
const WITHDRAWALS_FILE = path.join(DATA, "withdrawals.json");
const AUDIT_FILE = path.join(DATA, "audit.json");

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

const replicate = REPLICATE_API_TOKEN
  ? new Replicate({ auth: REPLICATE_API_TOKEN })
  : null;

const jobs = new Map();

const upload = multer({
  dest: TMP,
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

/*
===========================================================
MAMAKI AI v14
CREDIT + BUSINESS ENGINE
===========================================================

IMPORTANT:

Credits are NOT money.

Customer payment:
    Payment
       ↓
    Credits
       ↓
    AI generation
       ↓
    Credits consumed

Financial accounting:
    Revenue
       ↓
    Operations
    API Reserve
    Owner Allocation

No daily generation limit exists.

A user can generate as many videos as their
available MAMAKI credit balance allows.

===========================================================
*/

const CREDIT_RATE = Number(
  process.env.MAMAKI_CREDIT_RATE || 10
);

/*
Default:
₦1 = 10 MAMAKI credits

This is intentionally configurable.

For example:

₦1,000 = 10,000 credits
₦5,000 = 50,000 credits
₦10,000 = 100,000 credits
*/

const CREDIT_COST_PER_SECOND = Number(
  process.env.CREDIT_COST_PER_SECOND || 20
);

/*
Example:
5 seconds = 100 credits
30 seconds = 600 credits
5 minutes = 6,000 credits
30 minutes = 36,000 credits
2 hours = 144,000 credits

Change through environment variable when your
actual Replicate pricing and margin are finalized.
*/

const OPERATIONS_PERCENT = Number(
  process.env.OPERATIONS_PERCENT || 40
);

const API_RESERVE_PERCENT = Number(
  process.env.API_RESERVE_PERCENT || 35
);

const OWNER_PERCENT = Number(
  process.env.OWNER_PERCENT || 25
);

function now() {
  return new Date().toISOString();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function ensureFile(file, fallback) {
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(
      file,
      JSON.stringify(fallback, null, 2)
    );
  }
}

async function readJSON(file, fallback) {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJSON(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify(data, null, 2)
  );

  await fs.rename(temp, file);
}

async function ensureStorage() {
  await ensureDir(TMP);
  await ensureDir(OUTPUTS);
  await ensureDir(PROJECTS);
  await ensureDir(DATA);

  await ensureFile(USERS_FILE, []);
  await ensureFile(SESSIONS_FILE, []);
  await ensureFile(ERRORS_FILE, []);
  await ensureFile(USAGE_FILE, []);

  await ensureFile(WALLETS_FILE, {});
  await ensureFile(CREDIT_TX_FILE, []);
  await ensureFile(FINANCE_FILE, {
    totalRevenue: 0,
    totalCreditsSold: 0,
    totalCreditsConsumed: 0,
    totalApiCost: 0,
    totalExpenses: 0,
    operationsBalance: 0,
    apiReserveBalance: 0,
    ownerBalance: 0,
    ownerWithdrawn: 0,
    operationsPercent: OPERATIONS_PERCENT,
    apiReservePercent: API_RESERVE_PERCENT,
    ownerPercent: OWNER_PERCENT
  });

  await ensureFile(GENERATIONS_FILE, []);
  await ensureFile(EXPENSES_FILE, []);
  await ensureFile(WITHDRAWALS_FILE, []);
  await ensureFile(AUDIT_FILE, []);
}

/*
===========================================================
AUTHENTICATION
===========================================================
*/

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");

  const hash = scryptSync(
    password,
    salt,
    64
  ).toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(":");

    if (!salt || !hash) return false;

    const calculated = scryptSync(
      password,
      salt,
      64
    );

    const storedBuffer =
      Buffer.from(hash, "hex");

    return (
      storedBuffer.length === calculated.length &&
      timingSafeEqual(
        calculated,
        storedBuffer
      )
    );
  } catch {
    return false;
  }
}

function createToken() {
  return randomBytes(48).toString("hex");
}

async function createSession(userId, role = "user") {
  const sessions = await readJSON(
    SESSIONS_FILE,
    []
  );

  const token = createToken();

  sessions.push({
    token,
    userId,
    role,
    createdAt: now(),
    expiresAt:
      Date.now() +
      30 * 24 * 60 * 60 * 1000
  });

  await writeJSON(
    SESSIONS_FILE,
    sessions
  );

  return token;
}

async function getSession(req) {
  const header =
    req.headers.authorization || "";

  const token =
    header.startsWith("Bearer ")
      ? header.slice(7).trim()
      : null;

  if (!token) return null;

  const sessions = await readJSON(
    SESSIONS_FILE,
    []
  );

  const session =
    sessions.find(
      x =>
        x.token === token &&
        Number(x.expiresAt) > Date.now()
    );

  return session || null;
}

async function getCurrentUser(req) {
  const session =
    await getSession(req);

  if (!session) return null;

  const users = await readJSON(
    USERS_FILE,
    []
  );

  return (
    users.find(
      u => u.id === session.userId
    ) || null
  );
}

async function requireUser(req, res, next) {
  const user =
    await getCurrentUser(req);

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: "LOGIN_REQUIRED"
    });
  }

  if (user.disabled) {
    return res.status(403).json({
      ok: false,
      error: "ACCOUNT_DISABLED"
    });
  }

  req.user = user;
  next();
}

async function requireAdmin(req, res, next) {
  const user =
    await getCurrentUser(req);

  if (!user || user.role !== "admin") {
    return res.status(403).json({
      ok: false,
      error: "ADMIN_REQUIRED"
    });
  }

  req.user = user;
  next();
}

/*
===========================================================
WALLET ENGINE
===========================================================
*/

async function getWallet(userId) {
  const wallets =
    await readJSON(
      WALLETS_FILE,
      {}
    );

  if (!wallets[userId]) {
    wallets[userId] = {
      userId,
      balance: 0,
      reserved: 0,
      lifetimePurchased: 0,
      lifetimeConsumed: 0,
      createdAt: now(),
      updatedAt: now()
    };

    await writeJSON(
      WALLETS_FILE,
      wallets
    );
  }

  return wallets[userId];
}

async function saveWallet(wallet) {
  const wallets =
    await readJSON(
      WALLETS_FILE,
      {}
    );

  wallets[wallet.userId] = {
    ...wallet,
    updatedAt: now()
  };

  await writeJSON(
    WALLETS_FILE,
    wallets
  );
}

async function addCredits({
  userId,
  credits,
  type = "purchase",
  reference = "",
  note = ""
}) {
  credits = Math.max(
    0,
    Math.floor(Number(credits) || 0)
  );

  if (!credits) {
    throw new Error(
      "Credits must be greater than zero."
    );
  }

  const wallet =
    await getWallet(userId);

  wallet.balance += credits;
  wallet.lifetimePurchased += credits;

  await saveWallet(wallet);

  const transactions =
    await readJSON(
      CREDIT_TX_FILE,
      []
    );

  transactions.push({
    id: randomUUID(),
    userId,
    type,
    credits,
    reference,
    note,
    createdAt: now()
  });

  await writeJSON(
    CREDIT_TX_FILE,
    transactions
  );

  return wallet;
}

async function reserveCredits(
  userId,
  credits,
  jobId
) {
  credits = Math.ceil(
    Number(credits) || 0
  );

  const wallet =
    await getWallet(userId);

  const available =
    wallet.balance -
    wallet.reserved;

  if (available < credits) {
    const error =
      new Error(
        "Insufficient MAMAKI credits."
      );

    error.code =
      "INSUFFICIENT_CREDITS";

    error.available =
      available;

    error.required =
      credits;

    throw error;
  }

  wallet.reserved += credits;

  await saveWallet(wallet);

  const transactions =
    await readJSON(
      CREDIT_TX_FILE,
      []
    );

  transactions.push({
    id: randomUUID(),
    userId,
    type: "reservation",
    credits: -credits,
    reference: jobId,
    note:
      "Credits reserved for generation",
    createdAt: now()
  });

  await writeJSON(
    CREDIT_TX_FILE,
    transactions
  );

  return wallet;
}

async function consumeReservedCredits(
  userId,
  credits,
  jobId
) {
  credits = Math.ceil(
    Number(credits) || 0
  );

  const wallet =
    await getWallet(userId);

  wallet.reserved =
    Math.max(
      0,
      wallet.reserved - credits
    );

  wallet.balance =
    Math.max(
      0,
      wallet.balance - credits
    );

  wallet.lifetimeConsumed +=
    credits;

  await saveWallet(wallet);

  const transactions =
    await readJSON(
      CREDIT_TX_FILE,
      []
    );

  transactions.push({
    id: randomUUID(),
    userId,
    type: "generation",
    credits: -credits,
    reference: jobId,
    note:
      "Generation completed",
    createdAt: now()
  });

  await writeJSON(
    CREDIT_TX_FILE,
    transactions
  );

  return wallet;
}

async function refundReservedCredits(
  userId,
  credits,
  jobId
) {
  credits = Math.ceil(
    Number(credits) || 0
  );

  const wallet =
    await getWallet(userId);

  wallet.reserved =
    Math.max(
      0,
      wallet.reserved - credits
    );

  await saveWallet(wallet);

  const transactions =
    await readJSON(
      CREDIT_TX_FILE,
      []
    );

  transactions.push({
    id: randomUUID(),
    userId,
    type: "refund",
    credits,
    reference: jobId,
    note:
      "Generation failed; reserved credits returned",
    createdAt: now()
  });

  await writeJSON(
    CREDIT_TX_FILE,
    transactions
  );

  return wallet;
}

/*
===========================================================
CREDIT PRICING
===========================================================
*/

function normalizeDuration(value) {
  if (typeof value === "number") {
    return Math.max(
      MIN_DURATION,
      Math.min(
        MAX_DURATION,
        Math.round(value)
      )
    );
  }

  const text =
    String(value || "5")
      .trim()
      .toLowerCase();

  const match =
    text.match(
      /^([\d.]+)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/
    );

  if (!match) return 5;

  const number =
    Number(match[1]);

  const unit =
    match[2] || "s";

  let seconds = number;

  if (
    unit === "m" ||
    unit === "min" ||
    unit === "mins"
  ) {
    seconds *= 60;
  }

  if (
    unit === "h" ||
    unit === "hr" ||
    unit === "hrs"
  ) {
    seconds *= 3600;
  }

  return Math.max(
    MIN_DURATION,
    Math.min(
      MAX_DURATION,
      Math.round(seconds)
    )
  );
}

function calculateGenerationCredits(
  seconds
) {
  const duration =
    normalizeDuration(seconds);

  return Math.ceil(
    duration *
      CREDIT_COST_PER_SECOND
  );
}

function creditsFromNaira(amount) {
  return Math.floor(
    Number(amount) * CREDIT_RATE
  );
}

/*
===========================================================
FINANCE ENGINE
===========================================================
*/

async function allocateRevenue(
  amount,
  reference = ""
) {
  amount =
    Math.max(
      0,
      Number(amount) || 0
    );

  const finance =
    await readJSON(
      FINANCE_FILE,
      {}
    );

  const operations =
    amount *
    (Number(
      finance.operationsPercent ??
      OPERATIONS_PERCENT
    ) / 100);

  const apiReserve =
    amount *
    (Number(
      finance.apiReservePercent ??
      API_RESERVE_PERCENT
    ) / 100);

  const owner =
    amount *
    (Number(
      finance.ownerPercent ??
      OWNER_PERCENT
    ) / 100);

  finance.totalRevenue =
    Number(
      finance.totalRevenue || 0
    ) + amount;

  finance.operationsBalance =
    Number(
      finance.operationsBalance || 0
    ) + operations;

  finance.apiReserveBalance =
    Number(
      finance.apiReserveBalance || 0
    ) + apiReserve;

  finance.ownerBalance =
    Number(
      finance.ownerBalance || 0
    ) + owner;

  await writeJSON(
    FINANCE_FILE,
    finance
  );

  await audit(
    "system",
    "REVENUE_ALLOCATION",
    reference,
    {
      amount,
      operations,
      apiReserve,
      owner
    }
  );

  return {
    amount,
    operations,
    apiReserve,
    owner
  };
}

async function recordApiCost(
  amount,
  reference = ""
) {
  amount =
    Math.max(
      0,
      Number(amount) || 0
    );

  const finance =
    await readJSON(
      FINANCE_FILE,
      {}
    );

  finance.totalApiCost =
    Number(
      finance.totalApiCost || 0
    ) + amount;

  finance.apiReserveBalance =
    Number(
      finance.apiReserveBalance || 0
    ) - amount;

  await writeJSON(
    FINANCE_FILE,
    finance
  );

  const expenses =
    await readJSON(
      EXPENSES_FILE,
      []
    );

  expenses.push({
    id: randomUUID(),
    category: "API",
    provider: "Replicate",
    amount,
    reference,
    createdAt: now()
  });

  await writeJSON(
    EXPENSES_FILE,
    expenses
  );
}

async function recordExpense({
  category,
  provider,
  amount,
  note = ""
}) {
  amount =
    Math.max(
      0,
      Number(amount) || 0
    );

  const expenses =
    await readJSON(
      EXPENSES_FILE,
      []
    );

  expenses.push({
    id: randomUUID(),
    category,
    provider,
    amount,
    note,
    createdAt: now()
  });

  await writeJSON(
    EXPENSES_FILE,
    expenses
  );

  const finance =
    await readJSON(
      FINANCE_FILE,
      {}
    );

  finance.totalExpenses =
    Number(
      finance.totalExpenses || 0
    ) + amount;

  await writeJSON(
    FINANCE_FILE,
    finance
  );

  return finance;
}

async function audit(
  actor,
  action,
  reference = "",
  details = {}
) {
  const logs =
    await readJSON(
      AUDIT_FILE,
      []
    );

  logs.push({
    id: randomUUID(),
    actor,
    action,
    reference,
    details,
    createdAt: now()
  });

  if (logs.length > 10000) {
    logs.splice(
      0,
      logs.length - 10000
    );
  }

  await writeJSON(
    AUDIT_FILE,
    logs
  );
}

/*
===========================================================
ERROR LOGGING
===========================================================
*/

async function logError(
  error,
  context = {}
) {
  const errors =
    await readJSON(
      ERRORS_FILE,
      []
    );

  errors.push({
    id: randomUUID(),
    message:
      error?.message ||
      String(error),
    stack:
      error?.stack || "",
    context,
    createdAt: now()
  });

  if (errors.length > 1000) {
    errors.splice(
      0,
      errors.length - 1000
    );
  }

  await writeJSON(
    ERRORS_FILE,
    errors
  );
}

/*
===========================================================
REPLICATE
===========================================================
*/

function classifyReplicateError(error) {
  const message =
    String(
      error?.message ||
      error ||
      ""
    ).toLowerCase();

  if (
    message.includes("credit") ||
    message.includes("billing")
  ) {
    return {
      code:
        "REPLICATE_CREDIT_REQUIRED",
      message:
        "Replicate requires available billing credits."
    };
  }

  if (
    message.includes("unauthorized") ||
    message.includes("authentication")
  ) {
    return {
      code:
        "REPLICATE_AUTH_REQUIRED",
      message:
        "Replicate authentication failed."
    };
  }

  if (
    message.includes("forbidden")
  ) {
    return {
      code:
        "REPLICATE_FORBIDDEN",
      message:
        "Replicate rejected this request."
    };
  }

  if (
    message.includes("rate limit")
  ) {
    return {
      code:
        "REPLICATE_RATE_LIMIT",
      message:
        "Replicate rate limit reached."
    };
  }

  return {
    code:
      "REPLICATE_GENERATION_FAILED",
    message:
      error?.message ||
      "Video generation failed."
  };
}

async function wanTextToVideo({
  prompt,
  duration,
  aspectRatio = "16:9"
}) {
  if (!replicate) {
    const error =
      new Error(
        "REPLICATE_API_TOKEN is not configured."
      );

    error.code =
      "REPLICATE_AUTH_REQUIRED";

    throw error;
  }

  const seconds =
    normalizeDuration(duration);

  const frames =
    Math.max(
      81,
      Math.round(
        seconds * 16
      )
    );

  const input = {
    prompt,
    num_frames:
      Math.min(frames, 97),
    width:
      aspectRatio === "9:16"
        ? 480
        : 832,
    height:
      aspectRatio === "9:16"
        ? 832
        : 480,
    fps: 16,
    sample_shift: 12,
    go_fast: true
  };

  try {
    const output =
      await replicate.run(
        T2V_MODEL,
        { input }
      );

    return extractVideoURL(output);
  } catch (error) {
    const classified =
      classifyReplicateError(error);

    error.code =
      classified.code;

    throw error;
  }
}

async function wanImageToVideo({
  prompt,
  image,
  duration,
  aspectRatio = "16:9"
}) {
  if (!replicate) {
    const error =
      new Error(
        "REPLICATE_API_TOKEN is not configured."
      );

    error.code =
      "REPLICATE_AUTH_REQUIRED";

    throw error;
  }

  const input = {
    prompt,
    image,
    num_frames: 81,
    fps: 16,
    sample_shift: 12,
    go_fast: true,
    width:
      aspectRatio === "9:16"
        ? 480
        : 832,
    height:
      aspectRatio === "9:16"
        ? 832
        : 480
  };

  try {
    const output =
      await replicate.run(
        I2V_MODEL,
        { input }
      );

    return extractVideoURL(output);
  } catch (error) {
    const classified =
      classifyReplicateError(error);

    error.code =
      classified.code;

    throw error;
  }
}

function extractVideoURL(output) {
  if (typeof output === "string") {
    return output;
  }

  if (
    output &&
    typeof output.url === "function"
  ) {
    return String(
      output.url()
    );
  }

  if (
    output &&
    output.url
  ) {
    return String(
      output.url
    );
  }

  if (Array.isArray(output)) {
    for (const item of output) {
      if (
        typeof item === "string" &&
        /^https?:\/\//.test(item)
      ) {
        return item;
      }

      if (
        item &&
        item.url
      ) {
        return String(
          item.url
        );
      }
    }
  }

  if (
    output &&
    output.output
  ) {
    return extractVideoURL(
      output.output
    );
  }

  throw new Error(
    "Replicate returned no usable video URL."
  );
}

/*
===========================================================
FFMPEG
===========================================================
*/

function runFFmpeg(args) {
  return new Promise(
    (resolve, reject) => {
      const child =
        spawn(
          ffmpegPath,
          args
        );

      let stderr = "";

      child.stderr.on(
        "data",
        chunk => {
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
        code => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                `FFmpeg failed: ${stderr.slice(-3000)}`
              )
            );
          }
        }
      );
    }
  );
}

async function downloadFile(
  url,
  destination
) {
  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Download failed: HTTP ${response.status}`
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

async function addMamakiWatermark(
  input,
  output
) {
  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    "drawtext=text='MAMAKI ✨':x=20:y=20:fontsize=28:fontcolor=white@0.88:box=1:boxcolor=black@0.35:boxborderw=8",
    "-c:a",
    "copy",
    output
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
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    output
  ]);

  return output;
}

async function addSoftMusic(
  input,
  output
) {
  const music =
    path.join(
      TMP,
      `${randomUUID()}-music.wav`
    );

  await runFFmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=44100",
    "-t",
    "7200",
    "-ac",
    "2",
    music
  ]);

  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-i",
    music,
    "-filter_complex",
    "[1:a]volume=0.12[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[a]",
    "-map",
    "0:v",
    "-map",
    "[a]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    output
  ]).catch(async () => {
    await fs.copyFile(
      input,
      output
    );
  });

  await fs.rm(
    music,
    { force: true }
  );

  return output;
}

/*
===========================================================
SCENE PLANNER
===========================================================
*/

function planScenes(
  prompt,
  duration
) {
  const seconds =
    normalizeDuration(duration);

  const sceneCount =
    Math.max(
      1,
      Math.ceil(
        seconds / 5
      )
    );

  const pieces =
    String(prompt)
      .split(/[.!?]+/)
      .map(x => x.trim())
      .filter(Boolean);

  const scenes = [];

  for (
    let i = 0;
    i < sceneCount;
    i++
  ) {
    const base =
      pieces[i % pieces.length] ||
      prompt;

    scenes.push({
      number: i + 1,
      duration:
        Math.min(
          5,
          seconds -
            i * 5
        ),
      prompt:
        `${base}. Cinematic coherent scene, natural motion, detailed environment, consistent subject, professional video quality.`
    });
  }

  return scenes;
}

async function generateVideoProduction({
  prompt,
  duration,
  image,
  aspectRatio,
  jobId,
  onProgress
}) {
  const seconds =
    normalizeDuration(duration);

  const scenes =
    planScenes(
      prompt,
      seconds
    );

  const clips = [];

  for (
    let i = 0;
    i < scenes.length;
    i++
  ) {
    const scene =
      scenes[i];

    onProgress?.(
      Math.round(
        (i /
          scenes.length) *
          75
      ),
      `Generating scene ${i + 1} of ${scenes.length}`
    );

    const url =
      i === 0 && image
        ? await wanImageToVideo({
            prompt:
              scene.prompt,
            image,
            duration:
              scene.duration,
            aspectRatio
          })
        : await wanTextToVideo({
            prompt:
              scene.prompt,
            duration:
              scene.duration,
            aspectRatio
          });

    const sceneFile =
      path.join(
        TMP,
        `${jobId}-scene-${i}.mp4`
      );

    await downloadFile(
      url,
      sceneFile
    );

    clips.push(
      sceneFile
    );
  }

  onProgress?.(
    80,
    "Assembling scenes"
  );

  const concatFile =
    path.join(
      TMP,
      `${jobId}-concat.txt`
    );

  await fs.writeFile(
    concatFile,
    clips
      .map(
        file =>
          `file '${file.replace(/'/g, "'\\''")}'`
      )
      .join("\n")
  );

  const joined =
    path.join(
      TMP,
      `${jobId}-joined.mp4`
    );

  await runFFmpeg([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatFile,
    "-c",
    "copy",
    joined
  ]);

  const exact =
    path.join(
      TMP,
      `${jobId}-exact.mp4`
    );

  await forceDuration(
    joined,
    exact,
    seconds
  );

  onProgress?.(
    88,
    "Adding audio"
  );

  const audio =
    path.join(
      TMP,
      `${jobId}-audio.mp4`
    );

  await addSoftMusic(
    exact,
    audio
  );

  onProgress?.(
    94,
    "Applying MAMAKI watermark"
  );

  const final =
    path.join(
      OUTPUTS,
      `${jobId}.mp4`
    );

  await addMamakiWatermark(
    audio,
    final
  );

  for (const file of [
    ...clips,
    concatFile,
    joined,
    exact,
    audio
  ]) {
    await fs.rm(
      file,
      { force: true }
    ).catch(() => {});
  }

  onProgress?.(
    100,
    "Complete"
  );

  return `/outputs/${path.basename(final)}`;
}

/*
===========================================================
GENERATION RECORDING
===========================================================
*/

async function recordGeneration(data) {
  const generations =
    await readJSON(
      GENERATIONS_FILE,
      []
    );

  generations.push({
    id: randomUUID(),
    ...data,
    createdAt: now()
  });

  await writeJSON(
    GENERATIONS_FILE,
    generations
  );
}

/*
===========================================================
AUTH API
===========================================================
*/

app.post(
  "/api/auth/register",
  async (req, res) => {
    try {
      const {
        email,
        password
      } = req.body || {};

      const normalized =
        String(email || "")
          .trim()
          .toLowerCase();

      if (
        !normalized ||
        !normalized.includes("@")
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_EMAIL"
        });
      }

      if (
        String(password || "")
          .length < 6
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "PASSWORD_TOO_SHORT"
        });
      }

      const users =
        await readJSON(
          USERS_FILE,
          []
        );

      if (
        users.some(
          u => u.email === normalized
        )
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "EMAIL_ALREADY_EXISTS"
        });
      }

      const user = {
        id: randomUUID(),
        email: normalized,
        passwordHash:
          hashPassword(password),
        role:
          normalized === ADMIN_EMAIL &&
          ADMIN_EMAIL
            ? "admin"
            : "user",
        disabled: false,
        createdAt: now()
      };

      users.push(user);

      await writeJSON(
        USERS_FILE,
        users
      );

      await getWallet(
        user.id
      );

      const token =
        await createSession(
          user.id,
          user.role
        );

      res.json({
        ok: true,
        token,
        user: {
          id: user.id,
          email: user.email,
          role: user.role
        }
      });
    } catch (error) {
      await logError(error, {
        route:
          "/api/auth/register"
      });

      res.status(500).json({
        ok: false,
        error:
          "REGISTRATION_FAILED"
      });
    }
  }
);

app.post(
  "/api/auth/login",
  async (req, res) => {
    try {
      const {
        email,
        password
      } = req.body || {};

      const normalized =
        String(email || "")
          .trim()
          .toLowerCase();

      const users =
        await readJSON(
          USERS_FILE,
          []
        );

      const user =
        users.find(
          u => u.email === normalized
        );

      if (
        !user ||
        !verifyPassword(
          password,
          user.passwordHash
        )
      ) {
        return res.status(401).json({
          ok: false,
          error:
            "INVALID_CREDENTIALS"
        });
      }

      if (user.disabled) {
        return res.status(403).json({
          ok: false,
          error:
            "ACCOUNT_DISABLED"
        });
      }

      const token =
        await createSession(
          user.id,
          user.role
        );

      await getWallet(
        user.id
      );

      res.json({
        ok: true,
        token,
        user: {
          id: user.id,
          email: user.email,
          role: user.role
        }
      });
    } catch (error) {
      await logError(error, {
        route:
          "/api/auth/login"
      });

      res.status(500).json({
        ok: false,
        error: "LOGIN_FAILED"
      });
    }
  }
);

app.post(
  "/api/auth/logout",
  async (req, res) => {
    const session =
      await getSession(req);

    if (session) {
      const sessions =
        await readJSON(
          SESSIONS_FILE,
          []
        );

      await writeJSON(
        SESSIONS_FILE,
        sessions.filter(
          x =>
            x.token !==
            session.token
        )
      );
    }

    res.json({
      ok: true
    });
  }
);

app.get(
  "/api/auth/me",
  async (req, res) => {
    const user =
      await getCurrentUser(req);

    if (!user) {
      return res.json({
        ok: true,
        authenticated: false
      });
    }

    const wallet =
      await getWallet(
        user.id
      );

    res.json({
      ok: true,
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      },
      wallet: {
        balance:
          wallet.balance,
        reserved:
          wallet.reserved,
        available:
          wallet.balance -
          wallet.reserved
      }
    });
  }
);

/*
===========================================================
WALLET API
===========================================================
*/

app.get(
  "/api/wallet",
  requireUser,
  async (req, res) => {
    const wallet =
      await getWallet(
        req.user.id
      );

    const transactions =
      await readJSON(
        CREDIT_TX_FILE,
        []
      );

    res.json({
      ok: true,
      wallet: {
        balance:
          wallet.balance,
        reserved:
          wallet.reserved,
        available:
          wallet.balance -
          wallet.reserved,
        lifetimePurchased:
          wallet.lifetimePurchased,
        lifetimeConsumed:
          wallet.lifetimeConsumed
      },
      transactions:
        transactions
          .filter(
            x =>
              x.userId ===
              req.user.id
          )
          .slice(-100)
          .reverse()
    });
  }
);

/*
===========================================================
GENERATION COST API
===========================================================
*/

app.post(
  "/api/generation-cost",
  requireUser,
  async (req, res) => {
    const duration =
      normalizeDuration(
        req.body?.duration
      );

    const credits =
      calculateGenerationCredits(
        duration
      );

    const wallet =
      await getWallet(
        req.user.id
      );

    res.json({
      ok: true,
      duration,
      credits,
      balance:
        wallet.balance,
      reserved:
        wallet.reserved,
      available:
        wallet.balance -
        wallet.reserved,
      sufficient:
        wallet.balance -
          wallet.reserved >=
        credits
    });
  }
);

/*
===========================================================
MAIN AI GENERATION
===========================================================
*/

app.post(
  "/api/generate",
  requireUser,
  upload.single("image"),
  async (req, res) => {
    let reserved = false;

    try {
      if (!REPLICATE_API_TOKEN) {
        return res.status(503).json({
          ok: false,
          error:
            "REPLICATE_NOT_CONFIGURED"
        });
      }

      const prompt =
        String(
          req.body?.prompt || ""
        ).trim();

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error:
            "PROMPT_REQUIRED"
        });
      }

      const duration =
        normalizeDuration(
          req.body?.duration
        );

      const aspectRatio =
        String(
          req.body?.format ||
          req.body?.aspectRatio ||
          "16:9"
        );

      const credits =
        calculateGenerationCredits(
          duration
        );

      const jobId =
        randomUUID();

      /*
      Reserve before calling Replicate.
      */

      await reserveCredits(
        req.user.id,
        credits,
        jobId
      );

      reserved = true;

      const image =
        req.file
          ? `/tmp/${path.basename(
              req.file.path
            )}`
          : null;

      const job = {
        id: jobId,
        userId:
          req.user.id,
        status: "queued",
        progress: 0,
        message:
          "Generation queued",
        prompt,
        duration,
        creditsReserved:
          credits,
        creditsConsumed: 0,
        createdAt: now()
      };

      jobs.set(
        jobId,
        job
      );

      res.json({
        ok: true,
        jobId,
        creditsReserved:
          credits,
        duration,
        message:
          "Credits reserved. Generation started."
      });

      (
        async () => {
          try {
            job.status =
              "generating";

            const output =
              await generateVideoProduction({
                prompt,
                duration,
                image:
                  req.file?.path ||
                  null,
                aspectRatio,
                jobId,
                onProgress:
                  (
                    progress,
                    message
                  ) => {
                    job.progress =
                      progress;
                    job.message =
                      message;
                  }
              });

            await consumeReservedCredits(
              req.user.id,
              credits,
              jobId
            );

            await recordGeneration({
              userId:
                req.user.id,
              jobId,
              duration,
              creditsUsed:
                credits,
              estimatedApiCost:
                0,
              status:
                "completed",
              output
            });

            job.status =
              "completed";

            job.progress = 100;

            job.message =
              "Generation complete";

            job.output =
              output;

            job.creditsConsumed =
              credits;

            /*
            API cost is intentionally recorded
            separately when actual Replicate
            billing data is available.
            */

            await recordUsage(
              req.user.id,
              "aiGenerations",
              duration
            );
          } catch (error) {
            await logError(
              error,
              {
                route:
                  "/api/generate",
                userId:
                  req.user.id,
                jobId
              }
            );

            if (reserved) {
              await refundReservedCredits(
                req.user.id,
                credits,
                jobId
              );
            }

            job.status =
              "failed";

            job.progress = 0;

            job.message =
              error.code ===
              "INSUFFICIENT_CREDITS"
                ? "Insufficient credits."
                : error.message ||
                  "Generation failed.";

            job.error =
              error.code ||
              "GENERATION_FAILED";
          } finally {
            if (req.file?.path) {
              await fs.rm(
                req.file.path,
                { force: true }
              ).catch(
                () => {}
              );
            }
          }
        }
      )();
    } catch (error) {
      await logError(
        error,
        {
          route:
            "/api/generate",
          userId:
            req.user?.id
        }
      );

      if (
        reserved &&
        error.code
      ) {
        /*
        Reservation cleanup is handled
        inside the async generation path.
        */
      }

      if (
        error.code ===
        "INSUFFICIENT_CREDITS"
      ) {
        return res.status(402).json({
          ok: false,
          error:
            "INSUFFICIENT_CREDITS",
          required:
            error.required,
          available:
            error.available
        });
      }

      res.status(500).json({
        ok: false,
        error:
          error.code ||
          "GENERATION_FAILED",
        message:
          error.message
      });
    }
  }
);

app.get(
  "/api/jobs/:id",
  requireUser,
  async (req, res) => {
    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return res.status(404).json({
        ok: false,
        error:
          "JOB_NOT_FOUND"
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
          "FORBIDDEN"
      });
    }

    res.json({
      ok: true,
      job
    });
  }
);

/*
===========================================================
USAGE
===========================================================
*/

async function recordUsage(
  userId,
  type,
  seconds = 0
) {
  const usage =
    await readJSON(
      USAGE_FILE,
      []
    );

  let row =
    usage.find(
      x => x.userId === userId
    );

  if (!row) {
    row = {
      userId,
      aiGenerations: 0,
      aiSeconds: 0,
      studioJobs: 0,
      narrationJobs: 0
    };

    usage.push(row);
  }

  if (
    type ===
    "aiGenerations"
  ) {
    row.aiGenerations++;
    row.aiSeconds +=
      Number(seconds) || 0;
  }

  if (
    type ===
    "studioJobs"
  ) {
    row.studioJobs++;
  }

  if (
    type ===
    "narrationJobs"
  ) {
    row.narrationJobs++;
  }

  await writeJSON(
    USAGE_FILE,
    usage
  );
}

/*
===========================================================
PROJECTS
===========================================================
*/

app.get(
  "/api/projects",
  requireUser,
  async (req, res) => {
    const files =
      await fs.readdir(
        PROJECTS
      );

    const projects = [];

    for (const file of files) {
      if (!file.endsWith(".json"))
        continue;

      const project =
        await readJSON(
          path.join(
            PROJECTS,
            file
          ),
          null
        );

      if (
        project &&
        project.userId ===
          req.user.id
      ) {
        projects.push(
          project
        );
      }
    }

    res.json({
      ok: true,
      projects
    });
  }
);

app.post(
  "/api/projects/save",
  requireUser,
  async (req, res) => {
    const project = {
      id:
        req.body?.id ||
        randomUUID(),
      userId:
        req.user.id,
      name:
        req.body?.name ||
        "Untitled Project",
      data:
        req.body?.data ||
        {},
      updatedAt: now(),
      createdAt:
        req.body?.createdAt ||
        now()
    };

    await writeJSON(
      path.join(
        PROJECTS,
        `${project.id}.json`
      ),
      project
    );

    res.json({
      ok: true,
      project
    });
  }
);

app.get(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    const file =
      path.join(
        PROJECTS,
        `${req.params.id}.json`
      );

    const project =
      await readJSON(
        file,
        null
      );

    if (
      !project ||
      project.userId !==
        req.user.id
    ) {
      return res.status(404).json({
        ok: false,
        error:
          "PROJECT_NOT_FOUND"
      });
    }

    res.json({
      ok: true,
      project
    });
  }
);

app.delete(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    const file =
      path.join(
        PROJECTS,
        `${req.params.id}.json`
      );

    const project =
      await readJSON(
        file,
        null
      );

    if (
      !project ||
      project.userId !==
        req.user.id
    ) {
      return res.status(404).json({
        ok: false,
        error:
          "PROJECT_NOT_FOUND"
      });
    }

    await fs.rm(
      file,
      { force: true }
    );

    res.json({
      ok: true
    });
  }
);

/*
===========================================================
ADMIN
===========================================================
*/

app.get(
  "/api/admin/stats",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJSON(
        USERS_FILE,
        []
      );

    const usage =
      await readJSON(
        USAGE_FILE,
        []
      );

    const projects =
      await fs.readdir(
        PROJECTS
      );

    const finance =
      await readJSON(
        FINANCE_FILE,
        {}
      );

    const wallets =
      await readJSON(
        WALLETS_FILE,
        {}
      );

    const generations =
      await readJSON(
        GENERATIONS_FILE,
        []
      );

    let creditsHeld = 0;
    let creditsConsumed = 0;

    for (const wallet of Object.values(
      wallets
    )) {
      creditsHeld +=
        Number(
          wallet.balance || 0
        );

      creditsConsumed +=
        Number(
          wallet.lifetimeConsumed ||
            0
        );
    }

    const payingUsers =
      Object.values(
        wallets
      ).filter(
        wallet =>
          Number(
            wallet.lifetimePurchased ||
              0
          ) > 0
      ).length;

    const freeUsers =
      Math.max(
        0,
        users.length -
          payingUsers
      );

    const completed =
      generations.filter(
        x =>
          x.status ===
          "completed"
      ).length;

    const failed =
      generations.filter(
        x =>
          x.status ===
          "failed"
      ).length;

    const netProfit =
      Number(
        finance.totalRevenue ||
          0
      ) -
      Number(
        finance.totalApiCost ||
          0
      ) -
      Number(
        finance.totalExpenses ||
          0
      );

    res.json({
      ok: true,

      version: VERSION,

      users: {
        total:
          users.length,

        active:
          users.filter(
            x => !x.disabled
          ).length,

        disabled:
          users.filter(
            x => x.disabled
          ).length,

        paying:
          payingUsers,

        free:
          freeUsers
      },

      projects:
        projects.filter(
          x =>
            x.endsWith(".json")
        ).length,

      generations: {
        total:
          generations.length,

        completed,

        failed
      },

      credits: {
        sold:
          Number(
            finance.totalCreditsSold ||
              0
          ),

        held:
          creditsHeld,

        consumed:
          creditsConsumed
      },

      finance: {
        totalRevenue:
          Number(
            finance.totalRevenue ||
              0
          ),

        totalApiCost:
          Number(
            finance.totalApiCost ||
              0
          ),

        totalExpenses:
          Number(
            finance.totalExpenses ||
              0
          ),

        grossRevenue:
          Number(
            finance.totalRevenue ||
              0
          ),

        netProfit,

        operationsBalance:
          Number(
            finance.operationsBalance ||
              0
          ),

        apiReserveBalance:
          Number(
            finance.apiReserveBalance ||
              0
          ),

        ownerBalance:
          Number(
            finance.ownerBalance ||
              0
          ),

        ownerWithdrawn:
          Number(
            finance.ownerWithdrawn ||
              0
          )
      },

      allocation: {
        operations:
          Number(
            finance.operationsPercent ??
              OPERATIONS_PERCENT
          ),

        apiReserve:
          Number(
            finance.apiReservePercent ??
              API_RESERVE_PERCENT
          ),

        owner:
          Number(
            finance.ownerPercent ??
              OWNER_PERCENT
          )
      },

      usage,

      jobsInMemory:
        jobs.size,

      uptime:
        process.uptime(),

      replicateConfigured:
        Boolean(
          REPLICATE_API_TOKEN
        )
    });
  }
);

/*
===========================================================
ADMIN USERS
===========================================================
*/

app.get(
  "/api/admin/users",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJSON(
        USERS_FILE,
        []
      );

    const wallets =
      await readJSON(
        WALLETS_FILE,
        {}
      );

    const result =
      users.map(user => {
        const wallet =
          wallets[user.id] || {
            balance: 0,
            reserved: 0,
            lifetimePurchased: 0,
            lifetimeConsumed: 0
          };

        return {
          id: user.id,
          email: user.email,
          role: user.role,
          disabled:
            Boolean(
              user.disabled
            ),
          createdAt:
            user.createdAt,

          wallet: {
            balance:
              wallet.balance,
            reserved:
              wallet.reserved,
            available:
              wallet.balance -
              wallet.reserved,
            lifetimePurchased:
              wallet.lifetimePurchased,
            lifetimeConsumed:
              wallet.lifetimeConsumed
          }
        };
      });

    res.json({
      ok: true,
      users: result
    });
  }
);

/*
===========================================================
ADMIN ADD CREDIT
===========================================================
*/

app.post(
  "/api/admin/users/:id/credits",
  requireAdmin,
  async (req, res) => {
    try {
      const credits =
        Math.floor(
          Number(
            req.body?.credits
          )
        );

      if (
        !Number.isFinite(
          credits
        ) ||
        credits <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_CREDITS"
        });
      }

      const wallet =
        await addCredits({
          userId:
            req.params.id,
          credits,
          type:
            "admin_adjustment",
          reference:
            req.user.id,
          note:
            req.body?.note ||
            "Admin credit adjustment"
        });

      await audit(
        req.user.id,
        "ADMIN_CREDIT_ADJUSTMENT",
        req.params.id,
        {
          credits
        }
      );

      res.json({
        ok: true,
        wallet
      });
    } catch (error) {
      await logError(
        error,
        {
          route:
            "/api/admin/users/:id/credits"
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "CREDIT_ADJUSTMENT_FAILED"
      });
    }
  }
);

/*
===========================================================
ADMIN FINANCE
===========================================================
*/

app.get(
  "/api/admin/finance",
  requireAdmin,
  async (req, res) => {
    const finance =
      await readJSON(
        FINANCE_FILE,
        {}
      );

    const generations =
      await readJSON(
        GENERATIONS_FILE,
        []
      );

    const expenses =
      await readJSON(
        EXPENSES_FILE,
        []
      );

    const withdrawals =
      await readJSON(
        WITHDRAWALS_FILE,
        []
      );

    const credits =
      await readJSON(
        CREDIT_TX_FILE,
        []
      );

    const netProfit =
      Number(
        finance.totalRevenue ||
          0
      ) -
      Number(
        finance.totalApiCost ||
          0
      ) -
      Number(
        finance.totalExpenses ||
          0
      );

    res.json({
      ok: true,

      finance: {
        ...finance,
        netProfit
      },

      generations:
        generations
          .slice(-500)
          .reverse(),

      expenses:
        expenses
          .slice(-500)
          .reverse(),

      withdrawals:
        withdrawals
          .slice(-500)
          .reverse(),

      creditTransactions:
        credits
          .slice(-500)
          .reverse()
    });
  }
);

/*
===========================================================
ADMIN ALLOCATION SETTINGS
===========================================================
*/

app.post(
  "/api/admin/finance/allocation",
  requireAdmin,
  async (req, res) => {
    const operations =
      Number(
        req.body?.operations
      );

    const apiReserve =
      Number(
        req.body?.apiReserve
      );

    const owner =
      Number(
        req.body?.owner
      );

    if (
      !Number.isFinite(
        operations
      ) ||
      !Number.isFinite(
        apiReserve
      ) ||
      !Number.isFinite(
        owner
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "INVALID_ALLOCATION"
      });
    }

    const total =
      operations +
      apiReserve +
      owner;

    if (
      Math.abs(total - 100) >
      0.0001
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "ALLOCATION_MUST_EQUAL_100"
      });
    }

    if (
      operations < 0 ||
      apiReserve < 0 ||
      owner < 0
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "INVALID_PERCENTAGES"
      });
    }

    const finance =
      await readJSON(
        FINANCE_FILE,
        {}
      );

    finance.operationsPercent =
      operations;

    finance.apiReservePercent =
      apiReserve;

    finance.ownerPercent =
      owner;

    await writeJSON(
      FINANCE_FILE,
      finance
    );

    await audit(
      req.user.id,
      "ALLOCATION_CHANGED",
      "",
      {
        operations,
        apiReserve,
        owner
      }
    );

    res.json({
      ok: true,
      allocation: {
        operations,
        apiReserve,
        owner
      }
    });
  }
);

/*
===========================================================
ADMIN RECORD PAYMENT
===========================================================

This endpoint is deliberately separated from
payment-provider webhooks.

Do NOT expose it publicly as a payment confirmation
mechanism.

A real Paystack/Flutterwave webhook should call the
same internal accounting function after verifying
the provider transaction.
===========================================================
*/

app.post(
  "/api/admin/finance/payment",
  requireAdmin,
  async (req, res) => {
    try {
      const userId =
        String(
          req.body?.userId || ""
        );

      const amount =
        Number(
          req.body?.amount
        );

      const reference =
        String(
          req.body?.reference ||
            randomUUID()
        );

      if (
        !userId ||
        !Number.isFinite(
          amount
        ) ||
        amount <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_PAYMENT"
        });
      }

      const credits =
        creditsFromNaira(
          amount
        );

      if (credits <= 0) {
        return res.status(400).json({
          ok: false,
          error:
            "PAYMENT_TOO_SMALL"
        });
      }

      const wallet =
        await addCredits({
          userId,
          credits,
          type:
            "verified_payment",
          reference,
          note:
            `Customer payment ₦${amount}`
        });

      const finance =
        await readJSON(
          FINANCE_FILE,
          {}
        );

      finance.totalCreditsSold =
        Number(
          finance.totalCreditsSold ||
            0
        ) + credits;

      await writeJSON(
        FINANCE_FILE,
        finance
      );

      const allocation =
        await allocateRevenue(
          amount,
          reference
        );

      await audit(
        req.user.id,
        "PAYMENT_CREDITED",
        reference,
        {
          userId,
          amount,
          credits
        }
      );

      res.json({
        ok: true,
        amount,
        credits,
        wallet,
        allocation
      });
    } catch (error) {
      await logError(
        error,
        {
          route:
            "/api/admin/finance/payment"
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "PAYMENT_PROCESSING_FAILED"
      });
    }
  }
);

/*
===========================================================
ADMIN EXPENSE
===========================================================
*/

app.post(
  "/api/admin/finance/expense",
  requireAdmin,
  async (req, res) => {
    try {
      const finance =
        await recordExpense({
          category:
            req.body?.category ||
            "OTHER",
          provider:
            req.body?.provider ||
            "Unknown",
          amount:
            Number(
              req.body?.amount
            ),
          note:
            req.body?.note ||
            ""
        });

      await audit(
        req.user.id,
        "EXPENSE_RECORDED",
        "",
        req.body
      );

      res.json({
        ok: true,
        finance
      });
    } catch (error) {
      await logError(
        error,
        {
          route:
            "/api/admin/finance/expense"
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "EXPENSE_FAILED"
      });
    }
  }
);

/*
===========================================================
ADMIN WITHDRAWAL
===========================================================
*/

app.post(
  "/api/admin/finance/withdrawal",
  requireAdmin,
  async (req, res) => {
    try {
      const amount =
        Number(
          req.body?.amount
        );

      if (
        !Number.isFinite(
          amount
        ) ||
        amount <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_WITHDRAWAL"
        });
      }

      const finance =
        await readJSON(
          FINANCE_FILE,
          {}
        );

      const available =
        Number(
          finance.ownerBalance ||
            0
        );

      if (
        amount > available
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INSUFFICIENT_OWNER_BALANCE",
          available
        });
      }

      finance.ownerBalance =
        available - amount;

      finance.ownerWithdrawn =
        Number(
          finance.ownerWithdrawn ||
            0
        ) + amount;

      await writeJSON(
        FINANCE_FILE,
        finance
      );

      const withdrawals =
        await readJSON(
          WITHDRAWALS_FILE,
          []
        );

      withdrawals.push({
        id: randomUUID(),
        amount,
        status:
          "recorded",
        createdAt: now()
      });

      await writeJSON(
        WITHDRAWALS_FILE,
        withdrawals
      );

      await audit(
        req.user.id,
        "OWNER_WITHDRAWAL",
        "",
        {
          amount
        }
      );

      res.json({
        ok: true,
        amount,
        ownerBalance:
          finance.ownerBalance
      });
    } catch (error) {
      await logError(
        error,
        {
          route:
            "/api/admin/finance/withdrawal"
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "WITHDRAWAL_FAILED"
      });
    }
  }
);

/*
===========================================================
ADMIN JOBS
===========================================================
*/

app.get(
  "/api/admin/jobs",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      jobs:
        Array.from(
          jobs.values()
        )
    });
  }
);

app.get(
  "/api/admin/errors",
  requireAdmin,
  async (req, res) => {
    const errors =
      await readJSON(
        ERRORS_FILE,
        []
      );

    res.json({
      ok: true,
      errors:
        errors
          .slice(-200)
          .reverse()
    });
  }
);

/*
===========================================================
PUBLIC HEALTH
===========================================================
*/

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      app:
        "MAMAKI AI",
      version:
        VERSION,
      replicateConfigured:
        Boolean(
          REPLICATE_API_TOKEN
        ),
      uptime:
        process.uptime()
    });
  }
);

/*
===========================================================
STATIC FILES
===========================================================
*/

app.use(
  "/outputs",
  express.static(
    OUTPUTS
  )
);

app.use(
  express.static(ROOT)
);

/*
===========================================================
ERROR HANDLER
===========================================================
*/

app.use(
  async (
    error,
    req,
    res,
    next
  ) => {
    await logError(
      error,
      {
        route:
          req.originalUrl
      }
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      ok: false,
      error:
        "INTERNAL_SERVER_ERROR"
    });
  }
);

/*
===========================================================
STARTUP
===========================================================
*/

await ensureStorage();

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      "=========================================="
    );

    console.log(
      `MAMAKI AI v${VERSION}`
    );

    console.log(
      `Server running on ${HOST}:${PORT}`
    );

    console.log(
      `Replicate configured: ${Boolean(
        REPLICATE_API_TOKEN
      )}`
    );

    console.log(
      `Credit rate: ${CREDIT_RATE} credits/₦`
    );

    console.log(
      `Generation cost: ${CREDIT_COST_PER_SECOND} credits/sec`
    );

    console.log(
      `Allocation: ${OPERATIONS_PERCENT}% operations / ${API_RESERVE_PERCENT}% API / ${OWNER_PERCENT}% owner`
    );

    console.log(
      "Unlimited generation = sufficient credits"
    );

    console.log(
      "=========================================="
    );
  }
);

/*
===========================================================
CLEANUP
===========================================================
*/

setInterval(
  async () => {
    try {
      const oneHour =
        Date.now() -
        60 * 60 * 1000;

      for (
        const [
          id,
          job
        ] of jobs
      ) {
        if (
          (
            job.status ===
              "completed" ||
            job.status ===
              "failed"
          ) &&
          new Date(
            job.createdAt
          ).getTime() <
            oneHour
        ) {
          jobs.delete(id);
        }
      }

      const sessions =
        await readJSON(
          SESSIONS_FILE,
          []
        );

      const active =
        sessions.filter(
          x =>
            Number(
              x.expiresAt
            ) > Date.now()
        );

      if (
        active.length !==
        sessions.length
      ) {
        await writeJSON(
          SESSIONS_FILE,
          active
        );
      }
    } catch (error) {
      console.error(
        "Cleanup error:",
        error.message
      );
    }
  },
  15 * 60 * 1000
);
