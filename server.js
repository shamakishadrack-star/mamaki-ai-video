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

const T2V_MODEL = process.env.T2V_MODEL || "wan-video/wan-2.2-t2v-fast";
const I2V_MODEL = process.env.I2V_MODEL || "wan-video/wan-2.2-i2v-fast";
const MAX_DURATION = 7200;
const MIN_DURATION = 5;

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const SESSION_SECRET = String(process.env.SESSION_SECRET || "");
const REPLICATE_API_TOKEN = String(process.env.REPLICATE_API_TOKEN || "").trim();
const PAYSTACK_SECRET_KEY = String(process.env.PAYSTACK_SECRET_KEY || "").trim();
const PAYSTACK_PUBLIC_KEY = String(process.env.PAYSTACK_PUBLIC_KEY || "").trim();
const FX_API_URL = String(
  process.env.FX_API_URL ||
    "https://open.er-api.com/v6/latest/USD"
).trim();
const DEFAULT_USD_NGN_RATE = Math.max(
  1,
  Number(process.env.DEFAULT_USD_NGN_RATE || 1600)
);
const TARGET_MARGIN = Math.min(
  0.9,
  Math.max(0.05, Number(process.env.MAMAKI_TARGET_MARGIN || 0.4))
);
const PAYMENT_FEE_BUFFER = Math.min(
  0.3,
  Math.max(0, Number(process.env.MAMAKI_PAYMENT_FEE_BUFFER || 0.04))
);
const FX_BUFFER = Math.min(
  0.3,
  Math.max(0, Number(process.env.MAMAKI_FX_BUFFER || 0.05))
);
const PROVIDER_COST_480P_USD = Math.max(
  0.0001,
  Number(process.env.WAN_480P_COST_USD || 0.05)
);
const PROVIDER_COST_720P_USD = Math.max(
  PROVIDER_COST_480P_USD,
  Number(process.env.WAN_720P_COST_USD || 0.1)
);
const PAYSTACK_CURRENCY_DEFAULT = String(
  process.env.PAYSTACK_CURRENCY_DEFAULT || "NGN"
).toUpperCase();
const FIXED_NGN_MARKUP_PER_USD = Math.max(
  0,
  Number(process.env.MAMAKI_FIXED_NGN_MARKUP_PER_USD || 200)
);

const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
const RESEND_FROM = String(process.env.RESEND_FROM || "").trim();
const APP_URL = String(
  process.env.APP_URL || "https://mamaki-ai-video.onrender.com"
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

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, max = 10000) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeEmail(value) {
  return cleanText(value, 320).toLowerCase();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback) {
  try {
    const text = await fs.readFile(file, "utf8");
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(
    temporary,
    JSON.stringify(value, null, 2),
    "utf8"
  );
  await fs.rename(temporary, file);
}

async function ensureJson(file, initial) {
  if (!(await fileExists(file))) {
    await writeJson(file, initial);
  }
}

async function ensureStorage() {
  await Promise.all([
    ensureDir(TMP),
    ensureDir(OUTPUTS),
    ensureDir(PROJECTS),
    ensureDir(DATA),
  ]);

  await ensureJson(USERS_FILE, {});
  await ensureJson(SESSIONS_FILE, {});
  await ensureJson(ERRORS_FILE, []);
  await ensureJson(USAGE_FILE, {
    aiGenerations: 0,
    aiSeconds: 0,
    studioJobs: 0,
    narrationJobs: 0,
    completed: 0,
    processing: 0,
    failed: 0,
  });
  await ensureJson(RESET_FILE, {});
  await ensureJson(SECURITY_FILE, []);
  await ensureJson(CREDITS_FILE, {});
  await ensureJson(FINANCE_FILE, {
    grossRevenue: 0,
    providerSpend: 0,
    profit: 0,
    withdrawn: 0,
    pendingWithdrawals: 0,
    transactions: 0,
  });
  await ensureJson(PRICING_FILE, {});
  await ensureJson(PAYMENTS_FILE, {});
  await ensureJson(WITHDRAWALS_FILE, []);
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
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

function verifyPassword(password, user) {
  try {
    if (!user?.salt || !user?.passwordHash) return false;

    const derived = scryptSync(
      String(password),
      String(user.salt),
      64
    );

    const stored = Buffer.from(
      String(user.passwordHash),
      "hex"
    );

    return (
      stored.length === derived.length &&
      timingSafeEqual(stored, derived)
    );
  } catch {
    return false;
  }
}

function hashToken(value) {
  return createHash("sha256")
    .update(String(value))
    .digest("hex");
}

function hashResetCode(code) {
  return createHash("sha256")
    .update(String(code))
    .digest("hex");
}

function resetKey(email) {
  return hashToken(normalizeEmail(email));
}

function createResetCode() {
  return String(
    Math.floor(100000 + Math.random() * 900000)
  );
}

function createSessionToken() {
  return `${randomBytes(32).toString("hex")}.${randomBytes(32).toString(
    "hex"
  )}`;
}

async function createSession(userId, role = "user") {
  const sessions = await readJson(SESSIONS_FILE, {});
  const rawToken = createSessionToken();
  const key = hashToken(rawToken);

  sessions[key] = {
    userId,
    role,
    createdAt: nowIso(),
    expiresAt: new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000
    ).toISOString(),
  };

  await writeJson(SESSIONS_FILE, sessions);
  return rawToken;
}

async function getSession(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return null;

  const token = header.slice(7).trim();
  if (!token) return null;

  const sessions = await readJson(SESSIONS_FILE, {});
  const session = sessions[hashToken(token)];

  if (!session) return null;

  if (
    session.expiresAt &&
    Date.now() > new Date(session.expiresAt).getTime()
  ) {
    delete sessions[hashToken(token)];
    await writeJson(SESSIONS_FILE, sessions);
    return null;
  }

  const users = await readJson(USERS_FILE, {});
  const user = users[session.userId];

  if (!user || user.disabled) return null;

  return {
    ...session,
    token,
    user,
  };
}

async function invalidateUserSessions(userId) {
  const sessions = await readJson(SESSIONS_FILE, {});

  for (const [key, value] of Object.entries(sessions)) {
    if (value?.userId === userId) {
      delete sessions[key];
    }
  }

  await writeJson(SESSIONS_FILE, sessions);
}

async function requireUser(req, res, next) {
  const session = await getSession(req);

  if (!session) {
    return res.status(401).json({
      ok: false,
      error: "AUTH_REQUIRED",
      message: "Authentication required.",
    });
  }

  req.session = session;
  req.user = session.user;
  next();
}

async function requireAdmin(req, res, next) {
  const session = await getSession(req);

  if (!session || session.role !== "admin") {
    return res.status(401).json({
      ok: false,
      error: "ADMIN_REQUIRED",
      message: "Administrator access required.",
    });
  }

  req.session = session;
  req.user = session.user;
  next();
}

async function recordError(error, context = {}) {
  try {
    const errors = ensureArray(
      await readJson(ERRORS_FILE, [])
    );

    errors.unshift({
      id: randomUUID(),
      at: nowIso(),
      message: String(error?.message || error),
      stack: String(error?.stack || ""),
      context,
    });

    await writeJson(
      ERRORS_FILE,
      errors.slice(0, 500)
    );
  } catch {}
}

async function recordSecurityEvent(type, data = {}) {
  try {
    const events = ensureArray(
      await readJson(SECURITY_FILE, [])
    );

    events.unshift({
      id: randomUUID(),
      type,
      at: nowIso(),
      ...data,
    });

    await writeJson(
      SECURITY_FILE,
      events.slice(0, 500)
    );
  } catch {}
}

function allowedByRate(map, key, limit, windowMs) {
  const now = Date.now();
  const current = map.get(key) || [];

  const valid = current.filter(
    (timestamp) => now - timestamp < windowMs
  );

  if (valid.length >= limit) {
    map.set(key, valid);
    return false;
  }

  valid.push(now);
  map.set(key, valid);
  return true;
}

async function getUserCredits(userId) {
  const credits = await readJson(CREDITS_FILE, {});

  if (!credits[userId]) {
    credits[userId] = {
      balance: 100,
      lifetimePurchased: 0,
      lifetimeConsumed: 0,
      updatedAt: nowIso(),
    };

    await writeJson(CREDITS_FILE, credits);
  }

  return credits[userId];
}

async function setUserCredits(userId, record) {
  const credits = await readJson(CREDITS_FILE, {});

  credits[userId] = {
    ...record,
    balance: Math.max(
      0,
      Math.floor(safeNumber(record.balance))
    ),
    updatedAt: nowIso(),
  };

  await writeJson(CREDITS_FILE, credits);
  return credits[userId];
}

async function consumeCredits(userId, amount) {
  const count = Math.max(0, Math.ceil(Number(amount) || 0));
  const current = await getUserCredits(userId);

  if (current.balance < count) {
    const error = new Error(
      `Insufficient MAMAKI credits. You need ${count} credits and have ${current.balance}.`
    );
    error.code = "INSUFFICIENT_CREDITS";
    throw error;
  }

  current.balance -= count;
  current.lifetimeConsumed =
    Number(current.lifetimeConsumed || 0) + count;

  return setUserCredits(userId, current);
}

async function addCredits(userId, amount, purchase = false) {
  const count = Math.max(0, Math.floor(Number(amount) || 0));
  const current = await getUserCredits(userId);

  current.balance += count;

  if (purchase) {
    current.lifetimePurchased =
      Number(current.lifetimePurchased || 0) + count;
  }

  return setUserCredits(userId, current);
}

async function updateUsage(patch = {}) {
  const usage = ensureObject(
    await readJson(USAGE_FILE, {})
  );

  for (const [key, value] of Object.entries(patch)) {
    usage[key] = safeNumber(usage[key]) + safeNumber(value);
  }

  await writeJson(USAGE_FILE, usage);
  return usage;
}

async function updateFinance(patch = {}) {
  const finance = ensureObject(
    await readJson(FINANCE_FILE, {})
  );

  for (const [key, value] of Object.entries(patch)) {
    finance[key] =
      safeNumber(finance[key]) + safeNumber(value);
  }

  await writeJson(FINANCE_FILE, finance);
  return finance;
}

async function savePasswordReset(email, code) {
  const records = await readJson(RESET_FILE, {});
  const key = resetKey(email);

  records[key] = {
    email: normalizeEmail(email),
    codeHash: hashResetCode(code),
    createdAt: nowIso(),
    expiresAt: new Date(
      Date.now() + 15 * 60 * 1000
    ).toISOString(),
    attempts: 0,
  };

  await writeJson(RESET_FILE, records);
}

async function findPasswordReset(email) {
  const records = await readJson(RESET_FILE, {});
  return records[resetKey(email)] || null;
}

async function deletePasswordReset(email) {
  const records = await readJson(RESET_FILE, {});
  delete records[resetKey(email)];
  await writeJson(RESET_FILE, records);
}

async function sendPasswordRecoveryEmail(email, code) {
  if (!RESEND_API_KEY || !RESEND_FROM) {
    const error = new Error(
      "Password recovery email is not configured."
    );
    error.code = "RECOVERY_EMAIL_NOT_CONFIGURED";
    throw error;
  }

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [email],
        subject: "MAMAKI AI password recovery",
        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.6">
            <h2>MAMAKI AI Password Recovery</h2>
            <p>Your password recovery code is:</p>
            <div style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</div>
            <p>This code expires in 15 minutes.</p>
            <p>If you did not request this, you can ignore this email.</p>
          </div>
        `,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(
      `Recovery email failed: ${body.slice(0, 300)}`
    );
    error.code = "RECOVERY_EMAIL_FAILED";
    throw error;
  }
}

async function getFxRate() {
  const pricing = await readJson(PRICING_FILE, {});

  if (
    pricing.fx &&
    pricing.fx.updatedAt &&
    Date.now() -
      new Date(pricing.fx.updatedAt).getTime() <
      30 * 60 * 1000
  ) {
    return pricing.fx;
  }

  try {
    const response = await fetch(FX_API_URL, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `FX request failed with ${response.status}`
      );
    }

    const data = await response.json();
    const rate = Number(data?.rates?.NGN);

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("Invalid NGN FX rate.");
    }

    const fx = {
      base: "USD",
      rates: {
        USD: 1,
        NGN: rate,
      },
      source: FX_API_URL,
      updatedAt: nowIso(),
      live: true,
    };

    pricing.fx = fx;
    await writeJson(PRICING_FILE, pricing);

    return fx;
  } catch (error) {
    const fx = {
      base: "USD",
      rates: {
        USD: 1,
        NGN: DEFAULT_USD_NGN_RATE,
      },
      source: "fallback",
      updatedAt: nowIso(),
      live: false,
    };

    pricing.fx = fx;
    await writeJson(PRICING_FILE, pricing);

    return fx;
  }
}

function calculatePackagePrice(usdPrice, fxRate) {
  const providerCost =
    Number(usdPrice) * PROVIDER_COST_480P_USD;

  const fxCost =
    Number(usdPrice) * fxRate;

  const markup =
    Number(usdPrice) * FIXED_NGN_MARKUP_PER_USD;

  const feeBuffer =
    fxCost * PAYMENT_FEE_BUFFER;

  const fxBuffer =
    fxCost * FX_BUFFER;

  const marginAmount =
    (fxCost + feeBuffer + fxBuffer) *
    TARGET_MARGIN;

  return Math.ceil(
    (fxCost + markup + marginAmount + feeBuffer) /
      50
  ) * 50;
}

async function buildPricing() {
  const fx = await getFxRate();

  const packageDefs = [
    { credits: 100, usdPrice: 1 },
    { credits: 500, usdPrice: 5 },
    { credits: 1000, usdPrice: 10 },
    { credits: 2500, usdPrice: 25 },
    { credits: 5000, usdPrice: 50 },
  ];

  const packages = packageDefs.map((item) => {
    const amount =
      calculatePackagePrice(item.usdPrice, fx.rates.NGN);

    return {
      credits: item.credits,
      currency: PAYSTACK_CURRENCY_DEFAULT,
      amount,
      amountSubunit: Math.round(amount * 100),
      usdPrice: item.usdPrice,
      providerCostUsd:
        item.usdPrice * PROVIDER_COST_480P_USD,
      providerScenes: item.credits / 10,
      fxRate: fx.rates.NGN,
      fxLive: fx.live,
      fxUpdatedAt: fx.updatedAt,
      fixedMarkupPerUsd: FIXED_NGN_MARKUP_PER_USD,
      marginTarget: TARGET_MARGIN,
      paymentFeeBuffer: PAYMENT_FEE_BUFFER,
      fxBuffer: FX_BUFFER,
    };
  });

  const result = {
    ok: true,
    fx,
    packages,
    configuration: {
      targetMargin: TARGET_MARGIN,
      fixedMarkupPerUsd: FIXED_NGN_MARKUP_PER_USD,
      paymentFeeBuffer: PAYMENT_FEE_BUFFER,
      fxBuffer: FX_BUFFER,
    },
  };

  const stored = await readJson(PRICING_FILE, {});
  await writeJson(PRICING_FILE, {
    ...stored,
    ...result,
  });

  return result;
}

function getRatioDimensions(ratio) {
  switch (String(ratio || "16:9")) {
    case "9:16":
      return {
        width: 1080,
        height: 1920,
      };
    case "1:1":
      return {
        width: 1080,
        height: 1080,
      };
    default:
      return {
        width: 1920,
        height: 1080,
      };
  }
}

function getWanFrames(duration) {
  return Number(duration) <= 5 ? 81 : 121;
}

function normalizeDuration(value) {
  return clamp(
    Math.round(
      safeNumber(value, 5)
    ),
    MIN_DURATION,
    MAX_DURATION
  );
}

function cleanPrompt(prompt) {
  return cleanText(prompt, 10000);
}

function enhancePrompt(prompt, style = "Cinematic") {
  const base = cleanPrompt(prompt);

  if (!base) return "";

  return `${base}. Visual style: ${style}. Cinematic composition, natural motion, coherent subjects, realistic lighting, strong continuity, detailed environment, professional visual quality, no subtitles, no captions, no logos, no watermark text.`;
}

function splitPromptIntoScenes(prompt, duration) {
  const total = normalizeDuration(duration);
  const sceneCount = Math.max(
    1,
    Math.ceil(total / 5)
  );

  if (sceneCount === 1) {
    return [prompt];
  }

  const sentences = String(prompt)
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);

  if (sentences.length <= 1) {
    return Array.from(
      { length: sceneCount },
      (_, index) =>
        `${prompt}. Scene ${index + 1} of ${sceneCount}, maintain exact visual continuity with the previous scene.`
    );
  }

  const scenes = [];

  for (let i = 0; i < sceneCount; i++) {
    const sentence =
      sentences[i % sentences.length];

    scenes.push(
      `${sentence} Scene ${i + 1} of ${sceneCount}. Maintain character, environment, lighting, camera style and visual continuity.`
    );
  }

  return scenes;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr,
        });
      } else {
        const error = new Error(
          `${command} exited with code ${code}: ${stderr.slice(
            -1000
          )}`
        );
        error.code = code;
        reject(error);
      }
    });
  });
}

async function downloadFile(url, destination) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Download failed with HTTP ${response.status}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  await fs.writeFile(destination, buffer);
  return destination;
}

async function ffmpeg(args) {
  if (!ffmpegPath) {
    throw new Error("FFmpeg is not available.");
  }

  return runProcess(ffmpegPath, args);
}

async function applyWatermark(input, output) {
  await ffmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    "drawtext=text='MAMAKI ✨':fontcolor=white@0.72:fontsize=24:x=w-tw-24:y=h-th-24:box=1:boxcolor=black@0.25:boxborderw=8",
    "-c:a",
    "copy",
    output,
  ]);

  return output;
}

async function forceDuration(input, output, duration) {
  await ffmpeg([
    "-y",
    "-i",
    input,
    "-t",
    String(duration),
    "-c",
    "copy",
    output,
  ]);

  return output;
}

async function resizeVideo(input, output, ratio) {
  const dimensions = getRatioDimensions(ratio);

  await ffmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    `scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease,pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    output,
  ]);

  return output;
}

async function combineVideos(inputs, output) {
  if (!inputs.length) {
    throw new Error("No videos to combine.");
  }

  if (inputs.length === 1) {
    await fs.copyFile(inputs[0], output);
    return output;
  }

  const listFile = path.join(
    TMP,
    `concat-${randomUUID()}.txt`
  );

  const content = inputs
    .map(
      (file) =>
        `file '${file.replace(/'/g, "'\\''")}'`
    )
    .join("\n");

  await fs.writeFile(
    listFile,
    content,
    "utf8"
  );

  try {
    await ffmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-c",
      "copy",
      output,
    ]);
  } finally {
    await fs.rm(listFile, {
      force: true,
    });
  }

  return output;
}

async function attachAudio(video, audio, output) {
  await ffmpeg([
    "-y",
    "-i",
    video,
    "-i",
    audio,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-shortest",
    output,
  ]);

  return output;
}

async function addMusic(video, music, output) {
  await ffmpeg([
    "-y",
    "-i",
    video,
    "-stream_loop",
    "-1",
    "-i",
    music,
    "-filter_complex",
    "[1:a]volume=0.18[music]",
    "-map",
    "0:v:0",
    "-map",
    "[music]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-shortest",
    output,
  ]);

  return output;
}

function extractVideoUrl(output) {
  if (!output) return null;

  if (typeof output === "string") {
    return output;
  }

  if (
    typeof output.url === "function"
  ) {
    try {
      return String(output.url());
    } catch {}
  }

  if (typeof output.url === "string") {
    return output.url;
  }

  if (output.video) {
    return extractVideoUrl(output.video);
  }

  if (output.output) {
    return extractVideoUrl(output.output);
  }

  if (Array.isArray(output)) {
    for (const item of output) {
      const found = extractVideoUrl(item);
      if (found) return found;
    }
  }

  if (
    typeof output === "object"
  ) {
    for (const value of Object.values(output)) {
      const found = extractVideoUrl(value);
      if (found) return found;
    }
  }

  return null;
}

function classifyProviderError(error) {
  const text = String(
    error?.message || error || ""
  ).toLowerCase();

  if (
    text.includes("credit") ||
    text.includes("billing") ||
    text.includes("payment")
  ) {
    return "PROVIDER_CREDITS";
  }

  if (
    text.includes("401") ||
    text.includes("unauthorized") ||
    text.includes("authentication")
  ) {
    return "PROVIDER_AUTH";
  }

  if (
    text.includes("403") ||
    text.includes("forbidden")
  ) {
    return "PROVIDER_FORBIDDEN";
  }

  if (
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("too many")
  ) {
    return "PROVIDER_RATE_LIMIT";
  }

  return "PROVIDER_ERROR";
}

async function generateReplicateVideo({
  prompt,
  imageUrl,
  duration,
  ratio,
  quality,
}) {
  if (!replicate) {
    const error = new Error(
      "Replicate is not configured."
    );
    error.code = "REPLICATE_NOT_CONFIGURED";
    throw error;
  }

  const seconds = normalizeDuration(duration);
  const frames = getWanFrames(seconds);
  const dimensions = getRatioDimensions(ratio);

  const input = {
    prompt,
    duration: Math.min(seconds, 5),
    frames,
    width: dimensions.width,
    height: dimensions.height,
  };

  if (quality) {
    input.quality = quality;
  }

  if (imageUrl) {
    input.image = imageUrl;
  }

  const model = imageUrl
    ? I2V_MODEL
    : T2V_MODEL;

  const output =
    await replicate.run(
      model,
      {
        input,
      }
    );

  const videoUrl = extractVideoUrl(output);

  if (!videoUrl) {
    const error = new Error(
      "Replicate completed but no video file was returned."
    );
    error.code = "NO_VIDEO_OUTPUT";
    throw error;
  }

  return {
    videoUrl,
    model,
    frames,
  };
}

async function generateLongVideo({
  prompt,
  imageUrl,
  duration,
  ratio,
  style,
  quality,
}) {
  const totalDuration = normalizeDuration(duration);
  const scenes = splitPromptIntoScenes(
    enhancePrompt(prompt, style),
    totalDuration
  );

  const sceneFiles = [];

  try {
    for (let index = 0; index < scenes.length; index++) {
      const result =
        await generateReplicateVideo({
          prompt: scenes[index],
          imageUrl,
          duration: Math.min(
            5,
            totalDuration
          ),
          ratio,
          quality,
        });

      const rawFile = path.join(
        TMP,
        `${randomUUID()}-raw.mp4`
      );

      await downloadFile(
        result.videoUrl,
        rawFile
      );

      const resized = path.join(
        TMP,
        `${randomUUID()}-resized.mp4`
      );

      await resizeVideo(
        rawFile,
        resized,
        ratio
      );

      sceneFiles.push(resized);

      await fs.rm(rawFile, {
        force: true,
      });
    }

    const combined = path.join(
      TMP,
      `${randomUUID()}-combined.mp4`
    );

    await combineVideos(
      sceneFiles,
      combined
    );

    const finalFile = path.join(
      OUTPUTS,
      `${randomUUID()}.mp4`
    );

    await applyWatermark(
      combined,
      finalFile
    );

    await fs.rm(combined, {
      force: true,
    });

    return {
      file: finalFile,
      scenes: scenes.length,
    };
  } finally {
    for (const file of sceneFiles) {
      await fs.rm(file, {
        force: true,
      });
    }
  }
}

function publicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role || "user",
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
  };
}

async function createUser({
  name,
  email,
  password,
  role = "user",
}) {
  const users = await readJson(
    USERS_FILE,
    {}
  );

  const normalized = normalizeEmail(email);

  if (!normalized) {
    throw new Error("Email is required.");
  }

  if (String(password || "").length < 6) {
    throw new Error(
      "Password must contain at least 6 characters."
    );
  }

  const existing = Object.values(users).find(
    (user) =>
      normalizeEmail(user.email) === normalized
  );

  if (existing) {
    const error = new Error(
      "An account with that email already exists."
    );
    error.code = "EMAIL_EXISTS";
    throw error;
  }

  const credentials =
    hashPassword(password);

  const user = {
    id: randomUUID(),
    name:
      cleanText(name, 100) ||
      "MAMAKI User",
    email: normalized,
    salt: credentials.salt,
    passwordHash: credentials.hash,
    role,
    disabled: false,
    createdAt: nowIso(),
    lastLoginAt: null,
  };

  users[user.id] = user;

  await writeJson(
    USERS_FILE,
    users
  );

  await getUserCredits(user.id);

  return user;
}

app.get("/health", async (req, res) => {
  let storage = true;

  try {
    await ensureStorage();
  } catch {
    storage = false;
  }

  res.json({
    ok:
      Boolean(
        storage &&
          ffmpegPath &&
          REPLICATE_API_TOKEN &&
          ADMIN_EMAIL &&
          ADMIN_PASSWORD
      ),
    status:
      storage &&
      ffmpegPath &&
      REPLICATE_API_TOKEN &&
      ADMIN_EMAIL &&
      ADMIN_PASSWORD
        ? "healthy"
        : "degraded",
    service:
      "MAMAKI AI Video Creative Studio",
    version: VERSION,
    uptime: process.uptime(),
    timestamp: nowIso(),
    checks: {
      server: true,
      ffmpeg: Boolean(ffmpegPath),
      replicateConfigured:
        Boolean(REPLICATE_API_TOKEN),
      adminConfigured:
        Boolean(
          ADMIN_EMAIL &&
            ADMIN_PASSWORD
        ),
      paystackConfigured:
        Boolean(PAYSTACK_SECRET_KEY),
      recoveryConfigured:
        Boolean(
          RESEND_API_KEY &&
            RESEND_FROM
        ),
      storage,
      authentication: Boolean(
        SESSION_SECRET ||
          ADMIN_PASSWORD
      ),
    },
  });
});

app.get("/api/version", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    service:
      "MAMAKI AI Video Creative Studio",
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const user = await createUser({
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
    });

    const token =
      await createSession(
        user.id,
        "user"
      );

    res.json({
      ok: true,
      token,
      user: publicUser(user),
      credits:
        await getUserCredits(user.id),
    });
  } catch (error) {
    await recordError(error, {
      route: "/api/auth/register",
    });

    res.status(
      error.code === "EMAIL_EXISTS"
        ? 409
        : 400
    ).json({
      ok: false,
      error:
        error.code ||
        "REGISTER_FAILED",
      message:
        error.message ||
        "Unable to create account.",
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email =
      normalizeEmail(req.body.email);

    const password =
      String(
        req.body.password || ""
      );

    const users =
      await readJson(
        USERS_FILE,
        {}
      );

    const user =
      Object.values(users).find(
        (item) =>
          normalizeEmail(item.email) ===
          email
      );

    if (
      !user ||
      user.disabled ||
      !verifyPassword(
        password,
        user
      )
    ) {
      return res.status(401).json({
        ok: false,
        error: "INVALID_CREDENTIALS",
        message:
          "Invalid email or password.",
      });
    }

    user.lastLoginAt =
      nowIso();

    users[user.id] = user;

    await writeJson(
      USERS_FILE,
      users
    );

    const role =
      user.role === "admin"
        ? "admin"
        : "user";

    const token =
      await createSession(
        user.id,
        role
      );

    res.json({
      ok: true,
      token,
      user: publicUser(user),
      credits:
        await getUserCredits(
          user.id
        ),
    });
  } catch (error) {
    await recordError(error, {
      route: "/api/auth/login",
    });

    res.status(500).json({
      ok: false,
      error: "LOGIN_FAILED",
      message:
        "Unable to complete login.",
    });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  const header =
    String(
      req.headers.authorization || ""
    );

  if (header.startsWith("Bearer ")) {
    const token =
      header.slice(7).trim();

    const sessions =
      await readJson(
        SESSIONS_FILE,
        {}
      );

    delete sessions[
      hashToken(token)
    ];

    await writeJson(
      SESSIONS_FILE,
      sessions
    );
  }

  res.json({
    ok: true,
  });
});

app.get("/api/auth/me", requireUser, async (req, res) => {
  res.json({
    ok: true,
    user: publicUser(req.user),
    credits:
      await getUserCredits(
        req.user.id
      ),
  });
});

app.post("/api/auth/forgot-password", async (req, res) => {
  const email =
    normalizeEmail(req.body.email);

  const generic = {
    ok: true,
    message:
      "If an account exists for that email, a recovery code has been sent.",
  };

  if (!email) {
    return res.status(400).json({
      ok: false,
      error: "EMAIL_REQUIRED",
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
      { email }
    );

    return res.json(generic);
  }

  try {
    const users =
      await readJson(
        USERS_FILE,
        {}
      );

    const user =
      Object.values(users).find(
        (item) =>
          String(
            item.email || ""
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
        userId: user.id,
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
});

app.post("/api/auth/reset-password", async (req, res) => {
  const email =
    normalizeEmail(req.body.email);

  const code =
    cleanText(
      req.body.code,
      20
    );

  const newPassword =
    String(
      req.body.password || ""
    );

  if (
    !email ||
    !code ||
    !newPassword
  ) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_INPUT",
      message:
        "Email, recovery code and new password are required.",
    });
  }

  if (
    newPassword.length < 6
  ) {
    return res.status(400).json({
      ok: false,
      error: "WEAK_PASSWORD",
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
          record.expiresAt || 0
        )
    ) {
      await deletePasswordReset(
        email
      );

      return res.status(400).json({
        ok: false,
        error: "RESET_EXPIRED",
        message:
          "This recovery code has expired. Request a new one.",
      });
    }

    if (
      Number(
        record.attempts || 0
      ) >= 5
    ) {
      await deletePasswordReset(
        email
      );

      await recordSecurityEvent(
        "password_recovery_locked",
        { email }
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
        record.attempts || 0
      ) + 1;

    records[key] =
      record;

    await writeJson(
      RESET_FILE,
      records
    );

    if (
      hashResetCode(code) !==
      record.codeHash
    ) {
      await recordSecurityEvent(
        "password_recovery_invalid_code",
        { email }
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
      Object.values(users).find(
        (item) =>
          String(
            item.email || ""
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
      nowIso();

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
        userId: user.id,
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
});

app.post("/api/admin/login", async (req, res) => {
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
      req.body.password || ""
    );

  if (
    !allowedByRate(
      adminLoginRate,
      email || "unknown",
      5,
      15 * 60 * 1000
    )
  ) {
    await recordSecurityEvent(
      "admin_login_rate_limited",
      { email }
    );

    return res.status(429).json({
      ok: false,
      error:
        "ADMIN_RATE_LIMITED",
      message:
        "Too many administrator login attempts. Try again later.",
    });
  }

  const users =
    await readJson(
      USERS_FILE,
      {}
    );

  const matches =
    Object.values(users)
      .filter(
        (u) =>
          normalizeEmail(
            u.email
          ) === email &&
          u.role === "admin" &&
          !u.disabled
      );

  const storedAdmin =
    matches[0] || null;

  const masterCredentialsMatch =
    email === ADMIN_EMAIL &&
    password === ADMIN_PASSWORD;

  const storedCredentialsMatch =
    storedAdmin &&
    verifyPassword(
      password,
      storedAdmin
    );

  if (
    !masterCredentialsMatch &&
    !storedCredentialsMatch
  ) {
    await recordSecurityEvent(
      "admin_login_failed",
      { email }
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
    let admin =
      storedAdmin;

    let restored =
      false;

    if (!admin) {
      const credentials =
        hashPassword(
          ADMIN_PASSWORD
        );

      admin = {
        id: randomUUID(),
        name:
          "MAMAKI Administrator",
        email:
          ADMIN_EMAIL,
        salt:
          credentials.salt,
        passwordHash:
          credentials.hash,
        role: "admin",
        disabled: false,
        createdAt: nowIso(),
        lastLoginAt: null,
      };

      users[admin.id] =
        admin;

      restored = true;
    }

    admin.role =
      "admin";

    admin.disabled =
      false;

    admin.lastLoginAt =
      nowIso();

    users[admin.id] =
      admin;

    for (
      const duplicate
      of matches.slice(1)
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
            admin.email,
        }
      );
    }

    await recordSecurityEvent(
      "ADMIN_LOGIN_SUCCESS",
      {
        userId:
          admin.id,
        email:
          admin.email,
        method:
          masterCredentialsMatch
            ? "MASTER_CREDENTIALS"
            : "STORED_ADMIN_PASSWORD",
      }
    );

    res.json({
      ok: true,
      token,
      admin: {
        id: admin.id,
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
});

app.post(
  "/api/admin/logout",
  requireAdmin,
  async (req, res) => {
    const header =
      String(
        req.headers.authorization || ""
      );

    if (
      header.startsWith(
        "Bearer "
      )
    ) {
      const token =
        header.slice(7).trim();

      const sessions =
        await readJson(
          SESSIONS_FILE,
          {}
        );

      delete sessions[
        hashToken(token)
      ];

      await writeJson(
        SESSIONS_FILE,
        sessions
      );
    }

    res.json({
      ok: true,
    });
  }
);

app.get(
  "/api/admin/overview",
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

    const finance =
      await readJson(
        FINANCE_FILE,
        {}
      );

    const credits =
      await readJson(
        CREDITS_FILE,
        {}
      );

    const userList =
      Object.values(users);

    let totalCredits =
      0;

    for (
      const record
      of Object.values(
        credits
      )
    ) {
      totalCredits +=
        safeNumber(
          record.balance
        );
    }

    res.json({
      ok: true,
      version: VERSION,
      overview: {
        totalUsers:
          userList.length,
        activeUsers:
          userList.filter(
            (u) =>
              !u.disabled
          ).length,
        administrators:
          userList.filter(
            (u) =>
              u.role ===
              "admin"
          ).length,
        projects:
          safeNumber(
            usage.projects
          ),
        aiGenerations:
          safeNumber(
            usage.aiGenerations
          ),
        aiSeconds:
          safeNumber(
            usage.aiSeconds
          ),
        completed:
          safeNumber(
            usage.completed
          ),
        processing:
          safeNumber(
            usage.processing
          ),
        failed:
          safeNumber(
            usage.failed
          ),
        totalCredits,
      },
      finance,
    });
  }
);

app.get(
  "/api/admin/users",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJson(
        USERS_FILE,
        {}
      );

    const credits =
      await readJson(
        CREDITS_FILE,
        {}
      );

    const list =
      Object.values(users)
        .map((user) => ({
          ...publicUser(user),
          credits:
            credits[user.id] ||
            {
              balance: 0,
              lifetimePurchased:
                0,
              lifetimeConsumed:
                0,
            },
        }))
        .sort(
          (a, b) =>
            String(
              b.createdAt || ""
            ).localeCompare(
              String(
                a.createdAt || ""
              )
            )
        );

    res.json({
      ok: true,
      users: list,
    });
  }
);

app.get(
  "/api/admin/security",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      security:
        await readJson(
          SECURITY_FILE,
          []
        ),
    });
  }
);

app.get(
  "/api/admin/errors",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      errors:
        await readJson(
          ERRORS_FILE,
          []
        ),
    });
  }
);

app.get(
  "/api/admin/jobs",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      jobs:
        Array.from(
          jobs.values()
        ),
    });
  }
);

app.get(
  "/api/admin/pricing",
  requireAdmin,
  async (req, res) => {
    res.json(
      await buildPricing()
    );
  }
);

app.get(
  "/api/billing/pricing",
  async (req, res) => {
    try {
      res.json(
        await buildPricing()
      );
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/billing/pricing",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "PRICING_FAILED",
        message:
          "Unable to load pricing.",
      });
    }
  }
);

app.get(
  "/api/billing/balance",
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
  "/api/billing/paystack/initialize",
  requireUser,
  async (req, res) => {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({
        ok: false,
        error:
          "PAYSTACK_NOT_CONFIGURED",
        message:
          "Paystack is not configured.",
      });
    }

    try {
      const pricing =
        await buildPricing();

      const credits =
        Math.floor(
          Number(
            req.body.credits
          )
        );

      const pkg =
        pricing.packages.find(
          (item) =>
            item.credits ===
            credits
        );

      if (!pkg) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_PACKAGE",
          message:
            "Invalid MAMAKI credit package.",
        });
      }

      const reference =
        `MAMAKI-${Date.now()}-${randomBytes(
          5
        ).toString("hex")}`;

      const response =
        await fetch(
          "https://api.paystack.co/transaction/initialize",
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET_KEY}`,
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify({
              email:
                req.user.email,
              amount:
                pkg.amountSubunit,
              currency:
                pkg.currency,
              reference,
              callback_url:
                `${APP_URL}/?payment=${encodeURIComponent(
                  reference
                )}`,
              metadata: {
                mamaki: true,
                userId:
                  req.user.id,
                credits:
                  pkg.credits,
              },
            }),
          }
        );

      const data =
        await response.json();

      if (
        !response.ok ||
        !data?.status
      ) {
        throw new Error(
          data?.message ||
            "Paystack initialization failed."
        );
      }

      const payments =
        await readJson(
          PAYMENTS_FILE,
          {}
        );

      payments[
        reference
      ] = {
        reference,
        userId:
          req.user.id,
        email:
          req.user.email,
        credits:
          pkg.credits,
        amount:
          pkg.amount,
        amountSubunit:
          pkg.amountSubunit,
        currency:
          pkg.currency,
        status:
          "initialized",
        createdAt:
          nowIso(),
        fulfilledAt:
          null,
      };

      await writeJson(
        PAYMENTS_FILE,
        payments
      );

      res.json({
        ok: true,
        reference,
        authorization_url:
          data.data.authorization_url,
        access_code:
          data.data.access_code,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/billing/paystack/initialize",
        }
      );

      res.status(502).json({
        ok: false,
        error:
          "PAYSTACK_INITIALIZE_FAILED",
        message:
          error.message ||
          "Unable to initialize payment.",
      });
    }
  }
);

async function fulfillPaystackPayment(
  reference,
  source = "verify"
) {
  const payments =
    await readJson(
      PAYMENTS_FILE,
      {}
    );

  const payment =
    payments[reference];

  if (!payment) {
    const error = new Error(
      "Payment reference not found."
    );
    error.code =
      "PAYMENT_NOT_FOUND";
    throw error;
  }

  if (
    payment.status ===
      "fulfilled" &&
    payment.fulfilledAt
  ) {
    return payment;
  }

  await addCredits(
    payment.userId,
    payment.credits,
    true
  );

  payment.status =
    "fulfilled";

  payment.fulfilledAt =
    nowIso();

  payment.fulfillmentSource =
    source;

  payments[reference] =
    payment;

  await writeJson(
    PAYMENTS_FILE,
    payments
  );

  await updateFinance({
    grossRevenue:
      payment.amount,
    transactions: 1,
  });

  await recordSecurityEvent(
    "PAYMENT_FULFILLED",
    {
      reference,
      userId:
        payment.userId,
      credits:
        payment.credits,
      amount:
        payment.amount,
      source,
    }
  );

  return payment;
}

function verifyPaystackSignature(
  req
) {
  if (!PAYSTACK_SECRET_KEY) {
    return false;
  }

  const signature =
    String(
      req.headers[
        "x-paystack-signature"
      ] || ""
    );

  if (!signature) {
    return false;
  }

  const body =
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
      .update(body)
      .digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(
        signature
      ),
      Buffer.from(
        expected
      )
    );
  } catch {
    return false;
  }
}

app.post(
  "/api/billing/paystack/webhook",
  async (req, res) => {
    if (
      !verifyPaystackSignature(
        req
      )
    ) {
      return res.status(401).json({
        ok: false,
        error:
          "INVALID_SIGNATURE",
      });
    }

    try {
      const event =
        req.body || {};

      if (
        event.event ===
        "charge.success"
      ) {
        const reference =
          String(
            event?.data?.reference ||
              ""
          );

        if (reference) {
          await fulfillPaystackPayment(
            reference,
            "webhook"
          );
        }
      }

      res.json({
        ok: true,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/billing/paystack/webhook",
        }
      );

      res.status(500).json({
        ok: false,
      });
    }
  }
);

app.post(
  "/api/payments/paystack/webhook",
  async (req, res) => {
    if (
      !verifyPaystackSignature(
        req
      )
    ) {
      return res.status(401).json({
        ok: false,
        error:
          "INVALID_SIGNATURE",
      });
    }

    try {
      const event =
        req.body || {};

      if (
        event.event ===
        "charge.success"
      ) {
        const reference =
          String(
            event?.data?.reference ||
              ""
          );

        if (reference) {
          await fulfillPaystackPayment(
            reference,
            "webhook"
          );
        }
      }

      res.json({
        ok: true,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/payments/paystack/webhook",
        }
      );

      res.status(500).json({
        ok: false,
      });
    }
  }
);

app.get(
  "/api/billing/paystack/verify/:reference",
  requireUser,
  async (req, res) => {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({
        ok: false,
        error:
          "PAYSTACK_NOT_CONFIGURED",
        message:
          "Paystack is not configured.",
      });
    }

    const reference =
      cleanText(
        req.params.reference,
        200
      );

    try {
      const response =
        await fetch(
          `https://api.paystack.co/transaction/verify/${encodeURIComponent(
            reference
          )}`,
          {
            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET_KEY}`,
              Accept:
                "application/json",
            },
          }
        );

      const data =
        await response.json();

      if (
        !response.ok ||
        !data?.status
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "PAYMENT_VERIFY_FAILED",
          message:
            data?.message ||
            "Unable to verify payment.",
        });
      }

      if (
        data?.data?.status ===
        "success"
      ) {
        const payments =
          await readJson(
            PAYMENTS_FILE,
            {}
          );

        const payment =
          payments[
            reference
          ];

        if (
          payment &&
          payment.userId ===
            req.user.id
        ) {
          await fulfillPaystackPayment(
            reference,
            "verify"
          );
        }
      }

      res.json({
        ok: true,
        status:
          data?.data?.status ||
          "unknown",
        reference,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/billing/paystack/verify",
        }
      );

      res.status(502).json({
        ok: false,
        error:
          "PAYMENT_VERIFY_FAILED",
        message:
          error.message ||
          "Unable to verify payment.",
      });
    }
  }
);

app.get(
  "/api/billing/payment/:reference",
  async (req, res) => {
    const payments =
      await readJson(
        PAYMENTS_FILE,
        {}
      );

    const payment =
      payments[
        cleanText(
          req.params.reference,
          200
        )
      ];

    if (!payment) {
      return res.status(404).json({
        ok: false,
        error:
          "PAYMENT_NOT_FOUND",
      });
    }

    res.json({
      ok: true,
      payment: {
        reference:
          payment.reference,
        status:
          payment.status,
        credits:
          payment.credits,
        amount:
          payment.amount,
        currency:
          payment.currency,
        createdAt:
          payment.createdAt,
        fulfilledAt:
          payment.fulfilledAt,
      },
    });
  }
);

app.post(
  "/api/admin/credits/adjust",
  requireAdmin,
  async (req, res) => {
    try {
      const userId =
        cleanText(
          req.body.userId,
          200
        );

      const amount =
        Math.trunc(
          safeNumber(
            req.body.amount
          )
        );

      const reason =
        cleanText(
          req.body.reason ||
            "Manual administrator adjustment",
          500
        );

      if (!userId) {
        return res.status(400).json({
          ok: false,
          error:
            "USER_REQUIRED",
        });
      }

      if (!amount) {
        return res.status(400).json({
          ok: false,
          error:
            "AMOUNT_REQUIRED",
          message:
            "Enter a non-zero credit adjustment.",
        });
      }

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      if (!users[userId]) {
        return res.status(404).json({
          ok: false,
          error:
            "USER_NOT_FOUND",
        });
      }

      const current =
        await getUserCredits(
          userId
        );

      current.balance =
        Math.max(
          0,
          current.balance +
            amount
        );

      if (amount > 0) {
        current.lifetimePurchased =
          Number(
            current.lifetimePurchased ||
              0
          ) + amount;
      } else {
        current.lifetimeConsumed =
          Number(
            current.lifetimeConsumed ||
              0
          ) +
          Math.abs(
            amount
          );
      }

      await setUserCredits(
        userId,
        current
      );

      await recordSecurityEvent(
        "ADMIN_CREDIT_ADJUSTMENT",
        {
          adminId:
            req.user.id,
          userId,
          amount,
          reason,
        }
      );

      res.json({
        ok: true,
        credits:
          await getUserCredits(
            userId
          ),
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/credits/adjust",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "CREDIT_ADJUSTMENT_FAILED",
        message:
          error.message ||
          "Unable to adjust credits.",
      });
    }
  }
);

app.post(
  "/api/admin/withdraw",
  requireAdmin,
  async (req, res) => {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({
        ok: false,
        error:
          "PAYSTACK_NOT_CONFIGURED",
        message:
          "Paystack is not configured.",
      });
    }

    try {
      const amount =
        Math.round(
          safeNumber(
            req.body.amount
          )
        );

      const recipientCode =
        cleanText(
          req.body.recipientCode,
          200
        );

      const reason =
        cleanText(
          req.body.reason ||
            "MAMAKI owner withdrawal",
          500
        );

      if (
        amount <= 0 ||
        !recipientCode
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_WITHDRAWAL",
          message:
            "A valid amount and Paystack recipient code are required.",
        });
      }

      const reference =
        `MAMAKI-WD-${Date.now()}-${randomBytes(
          4
        ).toString("hex")}`;

      const response =
        await fetch(
          "https://api.paystack.co/transfer",
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET_KEY}`,
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify({
              source:
                "balance",
              amount:
                amount * 100,
              recipient:
                recipientCode,
              reason,
              reference,
            }),
          }
        );

      const data =
        await response.json();

      if (
        !response.ok ||
        !data?.status
      ) {
        throw new Error(
          data?.message ||
            "Paystack transfer failed."
        );
      }

      const withdrawals =
        await readJson(
          WITHDRAWALS_FILE,
          []
        );

      withdrawals.unshift({
        id: randomUUID(),
        reference,
        amount,
        recipientCode,
        reason,
        status:
          data?.data?.status ||
          "pending",
        createdAt:
          nowIso(),
        adminId:
          req.user.id,
      });

      await writeJson(
        WITHDRAWALS_FILE,
        withdrawals.slice(
          0,
          500
        )
      );

      await updateFinance({
        withdrawn:
          amount,
        pendingWithdrawals:
          0,
      });

      res.json({
        ok: true,
        reference,
        transfer:
          data.data,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/withdraw",
        }
      );

      res.status(502).json({
        ok: false,
        error:
          "WITHDRAWAL_FAILED",
        message:
          error.message ||
          "Unable to complete withdrawal.",
      });
    }
  }
);

app.post(
  "/api/video/generate",
  requireUser,
  upload.single("image"),
  async (req, res) => {
    const jobId =
      randomUUID();

    const duration =
      normalizeDuration(
        req.body.duration
      );

    const prompt =
      cleanPrompt(
        req.body.prompt
      );

    const ratio =
      cleanText(
        req.body.ratio ||
          "16:9",
        20
      );

    const style =
      cleanText(
        req.body.style ||
          "Cinematic",
        50
      );

    const quality =
      cleanText(
        req.body.quality ||
          "480p",
        50
      );

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error:
          "PROMPT_REQUIRED",
        message:
          "Enter a video prompt.",
      });
    }

    const creditCost =
      Math.max(
        1,
        Math.ceil(
          duration / 5
        )
      );

    let consumed = false;

    jobs.set(jobId, {
      id: jobId,
      type:
        "ai-video",
      status:
        "processing",
      userId:
        req.user.id,
      prompt,
      duration,
      ratio,
      style,
      quality,
      creditCost,
      createdAt:
        nowIso(),
    });

    await updateUsage({
      processing: 1,
    });

    try {
      await consumeCredits(
        req.user.id,
        creditCost
      );

      consumed = true;

      let imagePath =
        null;

      if (req.file) {
        imagePath =
          path.join(
            TMP,
            `${jobId}-reference-${req.file.originalname.replace(
              /[^a-zA-Z0-9._-]/g,
              "_"
            )}`
          );

        await fs.writeFile(
          imagePath,
          req.file.buffer
        );
      }

      let imageUrl =
        null;

      if (imagePath) {
        const error =
          new Error(
            "Reference-image generation requires an externally accessible image URL. Upload processing is available, but the current Replicate setup does not expose the temporary file publicly."
          );

        error.code =
          "IMAGE_URL_REQUIRED";

        throw error;
      }

      const generated =
        await generateLongVideo({
          prompt,
          imageUrl,
          duration,
          ratio,
          style,
          quality,
        });

      jobs.set(
        jobId,
        {
          ...jobs.get(
            jobId
          ),
          status:
            "completed",
          output:
            `/outputs/${path.basename(
              generated.file
            )}`,
          scenes:
            generated.scenes,
          completedAt:
            nowIso(),
        }
      );

      await updateUsage({
        processing: -1,
        completed: 1,
        aiGenerations: 1,
        aiSeconds:
          duration,
      });

      res.json({
        ok: true,
        jobId,
        status:
          "completed",
        output:
          `/outputs/${path.basename(
            generated.file
          )}`,
        creditsUsed:
          creditCost,
        credits:
          await getUserCredits(
            req.user.id
          ),
      });
    } catch (error) {
      if (consumed) {
        await addCredits(
          req.user.id,
          creditCost,
          false
        );
      }

      const job =
        jobs.get(jobId);

      jobs.set(
        jobId,
        {
          ...job,
          status:
            "failed",
          error:
            error.message,
          errorCode:
            classifyProviderError(
              error
            ),
          failedAt:
            nowIso(),
        }
      );

      await updateUsage({
        processing: -1,
        failed: 1,
      });

      await recordError(
        error,
        {
          route:
            "/api/video/generate",
          jobId,
          userId:
            req.user.id,
        }
      );

      res.status(500).json({
        ok: false,
        error:
          error.code ||
          "VIDEO_GENERATION_FAILED",
        message:
          error.message ||
          "Video generation failed.",
        credits:
          await getUserCredits(
            req.user.id
          ),
      });
    }
  }
);

app.get(
  "/api/video/job/:id",
  requireUser,
  async (req, res) => {
    const job =
      jobs.get(
        cleanText(
          req.params.id,
          100
        )
      );

    if (
      !job ||
      job.userId !==
        req.user.id
    ) {
      return res.status(404).json({
        ok: false,
        error:
          "JOB_NOT_FOUND",
      });
    }

    res.json({
      ok: true,
      job,
    });
  }
);

app.post(
  "/api/studio/narration",
  requireUser,
  upload.single("textFile"),
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
          100
        );

      if (!text) {
        return res.status(400).json({
          ok: false,
          error:
            "TEXT_REQUIRED",
          message:
            "Enter narration text.",
        });
      }

      const output =
        path.join(
          OUTPUTS,
          `${randomUUID()}.mp3`
        );

      const tts =
        new EdgeTTS();

      await tts.synthesize(
        text,
        voice,
        {
          outputFile:
            output,
        }
      );

      await updateUsage({
        narrationJobs: 1,
      });

      res.json({
        ok: true,
        output:
          `/outputs/${path.basename(
            output
          )}`,
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
          error.message ||
          "Narration generation failed.",
      });
    }
  }
);

app.post(
  "/api/studio/combine",
  requireUser,
  upload.array("videos", 20),
  async (req, res) => {
    try {
      if (
        !req.files?.length
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "VIDEOS_REQUIRED",
          message:
            "Upload videos to combine.",
        });
      }

      const files =
        [];

      for (
        const file
        of req.files
      ) {
        const filePath =
          path.join(
            TMP,
            `${randomUUID()}-${file.originalname.replace(
              /[^a-zA-Z0-9._-]/g,
              "_"
            )}`
          );

        await fs.writeFile(
          filePath,
          file.buffer
        );

        files.push(
          filePath
        );
      }

      const output =
        path.join(
          OUTPUTS,
          `${randomUUID()}.mp4`
        );

      try {
        await combineVideos(
          files,
          output
        );
      } finally {
        for (
          const file
          of files
        ) {
          await fs.rm(
            file,
            {
              force: true,
            }
          );
        }
      }

      await updateUsage({
        studioJobs: 1,
      });

      res.json({
        ok: true,
        output:
          `/outputs/${path.basename(
            output
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
          error.message ||
          "Unable to combine videos.",
      });
    }
  }
);

app.post(
  "/api/studio/trim",
  requireUser,
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

      const start =
        Math.max(
          0,
          safeNumber(
            req.body.start
          )
        );

      const duration =
        Math.max(
          0.1,
          safeNumber(
            req.body.duration,
            5
          )
        );

      const input =
        path.join(
          TMP,
          `${randomUUID()}-trim-input.mp4`
        );

      const output =
        path.join(
          OUTPUTS,
          `${randomUUID()}.mp4`
        );

      await fs.writeFile(
        input,
        req.file.buffer
      );

      try {
        await ffmpeg([
          "-y",
          "-ss",
          String(start),
          "-i",
          input,
          "-t",
          String(duration),
          "-c",
          "copy",
          output,
        ]);
      } finally {
        await fs.rm(
          input,
          {
            force: true,
          }
        );
      }

      await updateUsage({
        studioJobs: 1,
      });

      res.json({
        ok: true,
        output:
          `/outputs/${path.basename(
            output
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
          error.message ||
          "Unable to trim video.",
      });
    }
  }
);

app.post(
  "/api/studio/photo-video",
  requireUser,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "IMAGE_REQUIRED",
        });
      }

      const duration =
        normalizeDuration(
          req.body.duration ||
            5
        );

      const input =
        path.join(
          TMP,
          `${randomUUID()}-photo`
        );

      const output =
        path.join(
          OUTPUTS,
          `${randomUUID()}.mp4`
        );

      await fs.writeFile(
        input,
        req.file.buffer
      );

      try {
        await ffmpeg([
          "-y",
          "-loop",
          "1",
          "-i",
          input,
          "-t",
          String(duration),
          "-vf",
          "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
          "-r",
          "30",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          output,
        ]);
      } finally {
        await fs.rm(
          input,
          {
            force: true,
          }
        );
      }

      await updateUsage({
        studioJobs: 1,
      });

      res.json({
        ok: true,
        output:
          `/outputs/${path.basename(
            output
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
          error.message ||
          "Unable to create photo video.",
      });
    }
  }
);

app.post(
  "/api/studio/watermark",
  requireUser,
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

      const input =
        path.join(
          TMP,
          `${randomUUID()}-watermark-input.mp4`
        );

      const output =
        path.join(
          OUTPUTS,
          `${randomUUID()}.mp4`
        );

      await fs.writeFile(
        input,
        req.file.buffer
      );

      try {
        await applyWatermark(
          input,
          output
        );
      } finally {
        await fs.rm(
          input,
          {
            force: true,
          }
        );
      }

      await updateUsage({
        studioJobs: 1,
      });

      res.json({
        ok: true,
        output:
          `/outputs/${path.basename(
            output
          )}`,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/studio/watermark",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "WATERMARK_FAILED",
        message:
          error.message ||
          "Unable to apply watermark.",
      });
    }
  }
);

app.get(
  "/outputs/:file",
  async (req, res) => {
    const name =
      path.basename(
        req.params.file
      );

    const file =
      path.join(
        OUTPUTS,
        name
      );

    if (!(await fileExists(file))) {
      return res.status(404).send(
        "Output not found."
      );
    }

    res.sendFile(file);
  }
);

app.get(
  "/api/projects",
  requireUser,
  async (req, res) => {
    try {
      const entries =
        await fs.readdir(
          PROJECTS,
          {
            withFileTypes:
              true,
          }
        );

      const projects =
        [];

      for (
        const entry
        of entries
      ) {
        if (
          !entry.isDirectory()
        ) {
          continue;
        }

        const file =
          path.join(
            PROJECTS,
            entry.name,
            "project.json"
          );

        if (
          await fileExists(
            file
          )
        ) {
          const project =
            await readJson(
              file,
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
      }

      projects.sort(
        (a, b) =>
          String(
            b.updatedAt ||
              b.createdAt ||
              ""
          ).localeCompare(
            String(
              a.updatedAt ||
                a.createdAt ||
                ""
            )
          )
      );

      res.json({
        ok: true,
        projects,
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
      const id =
        randomUUID();

      const directory =
        path.join(
          PROJECTS,
          id
        );

      await ensureDir(
        directory
      );

      const project = {
        id,
        userId:
          req.user.id,
        name:
          cleanText(
            req.body.name ||
              "Untitled Project",
            200
          ),
        data:
          req.body.data ||
          {},
        createdAt:
          nowIso(),
        updatedAt:
          nowIso(),
      };

      await writeJson(
        path.join(
          directory,
          "project.json"
        ),
        project
      );

      await updateUsage({
        projects: 1,
      });

      res.json({
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

app.put(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    try {
      const id =
        cleanText(
          req.params.id,
          100
        );

      const file =
        path.join(
          PROJECTS,
          id,
          "project.json"
        );

      const project =
        await readJson(
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
            "PROJECT_NOT_FOUND",
        });
      }

      project.name =
        cleanText(
          req.body.name ||
            project.name,
          200
        );

      project.data =
        req.body.data ||
        project.data;

      project.updatedAt =
        nowIso();

      await writeJson(
        file,
        project
      );

      res.json({
        ok: true,
        project,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/projects/update",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "PROJECT_UPDATE_FAILED",
      });
    }
  }
);

app.delete(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    try {
      const id =
        cleanText(
          req.params.id,
          100
        );

      const directory =
        path.join(
          PROJECTS,
          id
        );

      const project =
        await readJson(
          path.join(
            directory,
            "project.json"
          ),
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
            "PROJECT_NOT_FOUND",
        });
      }

      await fs.rm(
        directory,
        {
          recursive: true,
          force: true,
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
            "/api/projects/delete",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "PROJECT_DELETE_FAILED",
      });
    }
  }
);

const PUBLIC_ACCOUNT_FEATURES = `
<style>
.mamaki-account-tools{
  display:flex;
  flex-wrap:wrap;
  gap:12px;
  align-items:center;
  justify-content:center;
  margin:22px auto;
  max-width:1100px;
}
.mamaki-account-tools button{
  border:1px solid rgba(255,255,255,.16);
  border-radius:14px;
  padding:12px 18px;
  background:#11131c;
  color:#fff;
  cursor:pointer;
  font-weight:700;
}
.mamaki-account-tools button.primary{
  background:#6d5dfc;
  border-color:#6d5dfc;
}
.mamaki-account-modal{
  position:fixed;
  inset:0;
  z-index:99999;
  display:none;
  align-items:center;
  justify-content:center;
  padding:20px;
  background:rgba(0,0,0,.75);
}
.mamaki-account-modal.show{
  display:flex;
}
.mamaki-account-card{
  width:min(560px,100%);
  max-height:90vh;
  overflow:auto;
  background:#0b0d14;
  border:1px solid rgba(255,255,255,.14);
  border-radius:22px;
  padding:24px;
  color:#fff;
  box-shadow:0 20px 80px rgba(0,0,0,.5);
}
.mamaki-account-card h2{
  margin-top:0;
}
.mamaki-account-card input{
  width:100%;
  padding:13px 14px;
  margin:8px 0;
  border-radius:12px;
  border:1px solid rgba(255,255,255,.16);
  background:#151824;
  color:#fff;
  outline:none;
}
.mamaki-account-card button{
  width:100%;
  padding:13px;
  margin-top:10px;
  border:0;
  border-radius:12px;
  background:#6d5dfc;
  color:#fff;
  font-weight:800;
  cursor:pointer;
}
.mamaki-account-close{
  float:right;
  width:auto!important;
  padding:7px 11px!important;
  margin:0!important;
  background:#202331!important;
}
.mamaki-package{
  border:1px solid rgba(255,255,255,.12);
  background:#121521;
  border-radius:16px;
  padding:15px;
  margin:10px 0;
}
.mamaki-package strong{
  font-size:18px;
}
.mamaki-account-message{
  margin-top:12px;
  line-height:1.5;
  white-space:pre-wrap;
}
</style>

<div class="mamaki-account-tools">
  <button
    type="button"
    class="primary"
    onclick="mamakiOpenCredits()"
  >
    🪙 Buy MAMAKI Credits
  </button>

  <button
    type="button"
    onclick="mamakiOpenRecovery()"
  >
    🔐 Recover Password
  </button>
</div>

<div
  id="mamakiAccountModal"
  class="mamaki-account-modal"
>
  <div class="mamaki-account-card">
    <button
      type="button"
      class="mamaki-account-close"
      onclick="mamakiCloseModal()"
    >
      ✕
    </button>

    <div id="mamakiAccountBody"></div>
  </div>
</div>

<script>
(function(){
  const modal =
    document.getElementById(
      'mamakiAccountModal'
    );

  const body =
    document.getElementById(
      'mamakiAccountBody'
    );

  function getToken(){
    return localStorage.getItem(
      'mamaki_token'
    ) || '';
  }

  window.mamakiCloseModal =
    function(){
      modal.classList.remove(
        'show'
      );
    };

  window.mamakiOpenCredits =
    async function(){
      modal.classList.add(
        'show'
      );

      body.innerHTML =
        '<h2>🪙 Buy MAMAKI Credits</h2><p>Loading packages...</p>';

      try{
        const r =
          await fetch(
            '/api/billing/pricing',
            {
              cache:'no-store'
            }
          );

        const d =
          await r.json();

        if(!r.ok || !d.ok){
          throw new Error(
            d.message ||
            'Unable to load pricing.'
          );
        }

        const token =
          getToken();

        let html =
          '<h2>🪙 Buy MAMAKI Credits</h2>' +
          '<p>Select a credit package.</p>';

        for(
          const pkg
          of d.packages || []
        ){
          html +=
            '<div class="mamaki-package">' +
            '<strong>' +
            Number(pkg.credits).toLocaleString() +
            ' Credits</strong>' +
            '<div>₦' +
            Number(pkg.amount).toLocaleString() +
            '</div>' +
            '<button type="button" onclick="mamakiBuyPackage(' +
            Number(pkg.credits) +
            ')">Pay with Paystack</button>' +
            '</div>';
        }

        if(!token){
          html +=
            '<p class="mamaki-account-message">' +
            'Please log in first before buying credits.' +
            '</p>';
        }

        body.innerHTML =
          html;
      }catch(e){
        body.innerHTML =
          '<h2>🪙 Buy MAMAKI Credits</h2>' +
          '<p class="mamaki-account-message">' +
          (e.message || 'Unable to load pricing.') +
          '</p>';
      }
    };

  window.mamakiBuyPackage =
    async function(credits){
      const token =
        getToken();

      if(!token){
        alert(
          'Please log in first.'
        );
        return;
      }

      try{
        const r =
          await fetch(
            '/api/billing/paystack/initialize',
            {
              method:'POST',
              headers:{
                'Content-Type':
                  'application/json',
                'Authorization':
                  'Bearer ' + token
              },
              body:JSON.stringify({
                credits
              })
            }
          );

        const d =
          await r.json();

        if(!r.ok || !d.ok){
          throw new Error(
            d.message ||
            'Unable to initialize payment.'
          );
        }

        window.location.href =
          d.authorization_url;
      }catch(e){
        alert(
          e.message ||
          'Unable to initialize payment.'
        );
      }
    };

  window.mamakiOpenRecovery =
    function(){
      modal.classList.add(
        'show'
      );

      body.innerHTML =
        '<h2>🔐 Recover Password</h2>' +
        '<p>Enter your account email to receive a recovery code.</p>' +
        '<input id="mamakiRecoveryEmail" type="email" placeholder="Email address">' +
        '<button type="button" onclick="mamakiRequestRecovery()">Send Recovery Code</button>' +
        '<div id="mamakiRecoveryMessage" class="mamaki-account-message"></div>';
    };

  window.mamakiRequestRecovery =
    async function(){
      const email =
        document.getElementById(
          'mamakiRecoveryEmail'
        )?.value?.trim();

      const message =
        document.getElementById(
          'mamakiRecoveryMessage'
        );

      if(!email){
        message.textContent =
          'Enter your email address.';
        return;
      }

      try{
        const r =
          await fetch(
            '/api/auth/forgot-password',
            {
              method:'POST',
              headers:{
                'Content-Type':
                  'application/json'
              },
              body:JSON.stringify({
                email
              })
            }
          );

        const d =
          await r.json();

        if(!r.ok || !d.ok){
          throw new Error(
            d.message ||
            'Unable to request recovery.'
          );
        }

        body.innerHTML =
          '<h2>🔐 Reset Password</h2>' +
          '<p>Enter the recovery code sent to your email and choose a new password.</p>' +
          '<input id="mamakiResetEmail" type="email" value="' +
          email.replace(/"/g,'&quot;') +
          '" placeholder="Email address">' +
          '<input id="mamakiResetCode" type="text" inputmode="numeric" placeholder="Recovery code">' +
          '<input id="mamakiResetPassword" type="password" placeholder="New password">' +
          '<button type="button" onclick="mamakiResetPassword()">Change Password</button>' +
          '<div id="mamakiRecoveryMessage" class="mamaki-account-message">If the account exists, a recovery code has been sent.</div>';
      }catch(e){
        message.textContent =
          e.message ||
          'Unable to request recovery.';
      }
    };

  window.mamakiResetPassword =
    async function(){
      const email =
        document.getElementById(
          'mamakiResetEmail'
        )?.value?.trim();

      const code =
        document.getElementById(
          'mamakiResetCode'
        )?.value?.trim();

      const password =
        document.getElementById(
          'mamakiResetPassword'
        )?.value || '';

      const message =
        document.getElementById(
          'mamakiRecoveryMessage'
        );

      try{
        const r =
          await fetch(
            '/api/auth/reset-password',
            {
              method:'POST',
              headers:{
                'Content-Type':
                  'application/json'
              },
              body:JSON.stringify({
                email,
                code,
                password
              })
            }
          );

        const d =
          await r.json();

        if(!r.ok || !d.ok){
          throw new Error(
            d.message ||
            'Unable to change password.'
          );
        }

        message.textContent =
          d.message ||
          'Password changed successfully.';
      }catch(e){
        message.textContent =
          e.message ||
          'Unable to change password.';
      }
    };

  window.addEventListener(
    'click',
    function(event){
      if(
        event.target ===
        modal
      ){
        mamakiCloseModal();
      }
    }
  );
})();
</script>
`;

app.get("/", async (req, res) => {
  try {
    const indexFile =
      path.join(
        ROOT,
        "index.html"
      );

    if (
      await fileExists(
        indexFile
      )
    ) {
      let html =
        await fs.readFile(
          indexFile,
          "utf8"
        );

      if (
        !html.includes(
          "mamakiAccountModal"
        )
      ) {
        html =
          html.replace(
            /<\/body>/i,
            `${PUBLIC_ACCOUNT_FEATURES}</body>`
          );
      }

      res
        .type("html")
        .send(html);

      return;
    }

    res.type("html").send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI</title>
</head>
<body>
<h1>✨ MAMAKI AI</h1>
<p>Intelligent AI Video Creative Studio</p>
${PUBLIC_ACCOUNT_FEATURES}
</body>
</html>
`);
  } catch (error) {
    await recordError(
      error,
      {
        route: "/",
      }
    );

    res.status(500).send(
      "Unable to load MAMAKI."
    );
  }
});

app.get("/admin", async (req, res) => {
  res.type("html").send(`
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI Administrator</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  font-family:Arial,Helvetica,sans-serif;
  background:#06070b;
  color:#f5f7ff;
}
button,input,select{
  font:inherit;
}
.wrap{
  width:min(1400px,94%);
  margin:0 auto;
}
.top{
  padding:30px 0 20px;
}
.card{
  background:#0d1018;
  border:1px solid #202534;
  border-radius:18px;
  padding:20px;
  margin:16px 0;
}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
  gap:14px;
}
.metric{
  background:#121621;
  border:1px solid #22293a;
  border-radius:15px;
  padding:18px;
}
.metric small{
  display:block;
  opacity:.7;
  margin-bottom:8px;
}
.metric strong{
  font-size:27px;
}
input,select{
  width:100%;
  padding:12px 14px;
  border-radius:11px;
  border:1px solid #2a3041;
  background:#0a0c12;
  color:#fff;
  margin:7px 0;
}
button{
  padding:12px 16px;
  border:0;
  border-radius:11px;
  background:#6d5dfc;
  color:white;
  cursor:pointer;
  font-weight:700;
}
button.secondary{
  background:#202638;
}
button.danger{
  background:#9f2939;
}
.hidden{
  display:none!important;
}
.muted{
  opacity:.7;
}
.msg{
  min-height:24px;
  margin-top:10px;
  white-space:pre-wrap;
}
table{
  width:100%;
  border-collapse:collapse;
  min-width:800px;
}
.table-wrap{
  overflow:auto;
}
th,td{
  text-align:left;
  padding:11px;
  border-bottom:1px solid #202534;
  vertical-align:top;
}
pre{
  white-space:pre-wrap;
  overflow:auto;
  background:#080a10;
  border:1px solid #202534;
  border-radius:12px;
  padding:14px;
}
.badge{
  display:inline-block;
  padding:5px 9px;
  border-radius:999px;
  background:#1a2130;
  font-size:12px;
}
.login{
  width:min(470px,94%);
  margin:70px auto;
}
.actions{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
}
h1,h2,h3{
  margin-top:0;
}
a{
  color:#a99cff;
}
</style>
</head>
<body>
<div class="wrap">

<section id="login" class="login card">
  <h1>🔐 MAMAKI Administrator</h1>
  <p class="muted">Private administrator access.</p>

  <label>Email</label>
  <input
    id="email"
    type="email"
    autocomplete="username"
    placeholder="Administrator email"
  >

  <label>Password</label>
  <input
    id="password"
    type="password"
    autocomplete="current-password"
    placeholder="Administrator password"
  >

  <button
    class="primary"
    onclick="login()"
  >
    Login
  </button>

  <div
    id="msg"
    class="msg"
  ></div>
</section>

<section
  id="dash"
  class="hidden"
>
  <div class="top">
    <h1>✨ MAMAKI Administrator</h1>
    <div
      id="health"
      class="muted"
    ></div>
  </div>

  <div
    id="actions"
    class="actions hidden"
  >
    <button
      onclick="loadAll(true)"
    >
      Refresh
    </button>

    <button
      class="secondary"
      onclick="logout()"
    >
      Logout
    </button>
  </div>

  <div class="card">
    <h2>Overview</h2>
    <div
      id="overview"
      class="grid"
    ></div>
  </div>

  <div class="card">
    <h2>Finance</h2>
    <div
      id="finance"
      class="grid"
    ></div>
  </div>

  <div class="card">
    <h2>Pricing</h2>
    <div
      id="pricing"
    ></div>
  </div>

  <div class="card">
    <h2>Users</h2>
    <div
      id="users"
    ></div>
  </div>

  <div class="card">
    <h2>Jobs</h2>
    <div
      id="jobs"
    ></div>
  </div>

  <div class="card">
    <h2>Security</h2>
    <div
      id="security"
    ></div>
  </div>

  <div class="card">
    <h2>Errors</h2>
    <div
      id="errors"
    ></div>
  </div>

  <div class="card">
    <h2>Manual Credit Adjustment</h2>

    <input
      id="creditUser"
      placeholder="User ID"
    >

    <input
      id="creditAmount"
      type="number"
      placeholder="Credits: +100 or -100"
    >

    <input
      id="creditReason"
      placeholder="Reason"
    >

    <button
      onclick="adjustCredits()"
    >
      Apply Adjustment
    </button>

    <div
      id="creditMsg"
      class="msg"
    ></div>
  </div>

  <div class="card">
    <h2>Owner Profit Withdrawal</h2>

    <input
      id="withdrawAmount"
      type="number"
      placeholder="Amount in NGN"
    >

    <input
      id="recipientCode"
      placeholder="Paystack recipient code"
    >

    <input
      id="withdrawReason"
      placeholder="Reason"
      value="MAMAKI owner withdrawal"
    >

    <button
      onclick="withdrawProfit()"
    >
      Withdraw
    </button>

    <div
      id="withdrawMsg"
      class="msg"
    ></div>
  </div>
</section>

</div>

<script>
let token =
  localStorage.getItem(
    'mamaki_admin_token'
  ) || '';

function $(id){
  return document.getElementById(id);
}

function esc(value){
  return String(
    value ?? ''
  )
  .replaceAll('&','&amp;')
  .replaceAll('<','&lt;')
  .replaceAll('>','&gt;')
  .replaceAll('"','&quot;')
  .replaceAll("'","&#039;");
}

function money(value){
  return '₦' +
    Number(
      value || 0
    ).toLocaleString();
}

async function api(
  url,
  options={}
){
  const headers = {
    ...(options.headers || {}),
    Accept:
      'application/json'
  };

  if(token){
    headers.Authorization =
      'Bearer ' + token;
  }

  const response =
    await fetch(
      url,
      {
        ...options,
        headers,
        cache:'no-store'
      }
    );

  const text =
    await response.text();

  let data = {};

  try{
    data =
      text
        ? JSON.parse(text)
        : {};
  }catch{
    throw new Error(
      'Server returned invalid JSON (HTTP ' +
      response.status +
      ').'
    );
  }

  if(
    response.status === 401
  ){
    throw new Error(
      'Administrator access required.'
    );
  }

  if(
    !response.ok ||
    data.ok === false
  ){
    throw new Error(
      data.message ||
      data.error ||
      'Request failed.'
    );
  }

  return data;
}

async function login(){
  const m =
    $('msg');

  const b =
    document.querySelector(
      '#login button.primary'
    );

  try{
    m.textContent =
      'Signing in...';

    b.disabled =
      true;

    const email =
      String(
        $('email').value ||
        ''
      )
      .trim()
      .toLowerCase();

    const password =
      String(
        $('password').value ||
        ''
      );

    if(
      !email ||
      !password
    ){
      throw new Error(
        'Enter the administrator email and password.'
      );
    }

    const r =
      await fetch(
        '/api/admin/login',
        {
          method:'POST',
          headers:{
            'Content-Type':
              'application/json',
            Accept:
              'application/json'
          },
          body:
            JSON.stringify({
              email,
              password
            }),
          cache:'no-store'
        }
      );

    const text =
      await r.text();

    let d = {};

    try{
      d =
        JSON.parse(text);
    }catch{
      throw new Error(
        'Server returned an invalid response (HTTP ' +
        r.status +
        '). Refresh the page and try again.'
      );
    }

    if(
      !r.ok ||
      !d.ok
    ){
      throw new Error(
        d.message ||
        d.error ||
        'Administrator login failed.'
      );
    }

    if(!d.token){
      throw new Error(
        'Login succeeded but no administrator session token was returned.'
      );
    }

    token =
      d.token;

    localStorage.setItem(
      'mamaki_admin_token',
      token
    );

    m.textContent =
      'Login successful. Loading dashboard...';

    await loadAll(true);
  }catch(e){
    localStorage.removeItem(
      'mamaki_admin_token'
    );

    token = '';

    m.textContent =
      e?.message ||
      'Administrator login failed.';
  }finally{
    b.disabled =
      false;
  }
}

async function logout(){
  try{
    if(token){
      await fetch(
        '/api/admin/logout',
        {
          method:'POST',
          headers:{
            Authorization:
              'Bearer ' + token
          }
        }
      );
    }
  }catch{}

  localStorage.removeItem(
    'mamaki_admin_token'
  );

  token = '';

  $('dash')
    .classList
    .add('hidden');

  $('actions')
    .classList
    .add('hidden');

  $('login')
    .classList
    .remove('hidden');

  $('msg').textContent =
    'Logged out.';
}

function renderMetrics(
  target,
  entries
){
  $(target).innerHTML =
    entries
      .map(
        ([label,value]) =>
          '<div class="metric">' +
          '<small>' +
          esc(label) +
          '</small>' +
          '<strong>' +
          esc(
            typeof value ===
            'number'
              ? value.toLocaleString()
              : value
          ) +
          '</strong>' +
          '</div>'
      )
      .join('');
}

function renderPricing(data){
  const packages =
    Array.isArray(
      data.packages
    )
      ? data.packages
      : [];

  let html =
    '<div class="muted">FX: ' +
    esc(
      data.fx?.live
        ? 'Live'
        : 'Fallback'
    ) +
    ' · ₦' +
    esc(
      Number(
        data.fx?.rates?.NGN ||
        0
      ).toLocaleString()
    ) +
    ' per USD</div>';

  html +=
    '<div class="table-wrap"><table>' +
    '<thead><tr>' +
    '<th>Credits</th>' +
    '<th>Price</th>' +
    '<th>USD</th>' +
    '<th>Provider Cost</th>' +
    '<th>Scenes</th>' +
    '</tr></thead><tbody>';

  for(
    const p of packages
  ){
    html +=
      '<tr>' +
      '<td>' +
      Number(
        p.credits || 0
      ).toLocaleString() +
      '</td>' +
      '<td>' +
      money(p.amount) +
      '</td>' +
      '<td>$' +
      esc(
        Number(
          p.usdPrice || 0
        ).toFixed(2)
      ) +
      '</td>' +
      '<td>$' +
      esc(
        Number(
          p.providerCostUsd ||
          0
        ).toFixed(2)
      ) +
      '</td>' +
      '<td>' +
      esc(
        p.providerScenes
      ) +
      '</td>' +
      '</tr>';
  }

  html +=
    '</tbody></table></div>';

  $('pricing').innerHTML =
    html;
}

function renderUsers(data){
  const users =
    Array.isArray(
      data.users
    )
      ? data.users
      : [];

  let html =
    '<div class="table-wrap"><table>' +
    '<thead><tr>' +
    '<th>Name</th>' +
    '<th>Email</th>' +
    '<th>Role</th>' +
    '<th>Credits</th>' +
    '<th>Status</th>' +
    '<th>ID</th>' +
    '</tr></thead><tbody>';

  for(
    const user of users
  ){
    html +=
      '<tr>' +
      '<td>' +
      esc(user.name) +
      '</td>' +
      '<td>' +
      esc(user.email) +
      '</td>' +
      '<td>' +
      '<span class="badge">' +
      esc(user.role) +
      '</span></td>' +
      '<td>' +
      Number(
        user.credits?.balance ||
        0
      ).toLocaleString() +
      '</td>' +
      '<td>' +
      (
        user.disabled
          ? 'Disabled'
          : 'Active'
      ) +
      '</td>' +
      '<td>' +
      esc(user.id) +
      '</td>' +
      '</tr>';
  }

  html +=
    '</tbody></table></div>';

  $('users').innerHTML =
    html;
}

function renderJobs(data){
  const list =
    Array.isArray(
      data.jobs
    )
      ? data.jobs
      : [];

  if(!list.length){
    $('jobs').innerHTML =
      '<p class="muted">No jobs.</p>';
    return;
  }

  $('jobs').innerHTML =
    '<div class="table-wrap"><table>' +
    '<thead><tr>' +
    '<th>ID</th>' +
    '<th>Status</th>' +
    '<th>Type</th>' +
    '<th>User</th>' +
    '<th>Created</th>' +
    '</tr></thead><tbody>' +
    list.map(
      j =>
        '<tr>' +
        '<td>' +
        esc(j.id) +
        '</td>' +
        '<td>' +
        esc(j.status) +
        '</td>' +
        '<td>' +
        esc(j.type) +
        '</td>' +
        '<td>' +
        esc(j.userId) +
        '</td>' +
        '<td>' +
        esc(j.createdAt) +
        '</td>' +
        '</tr>'
    ).join('') +
    '</tbody></table></div>';
}

function renderSecurity(data){
  const list =
    Array.isArray(
      data.security
    )
      ? data.security
      : [];

  if(!list.length){
    $('security').innerHTML =
      '<p class="muted">No security events.</p>';
    return;
  }

  $('security').innerHTML =
    '<div class="table-wrap"><table>' +
    '<thead><tr>' +
    '<th>Time</th>' +
    '<th>Type</th>' +
    '<th>Email</th>' +
    '<th>User</th>' +
    '</tr></thead><tbody>' +
    list.map(
      x =>
        '<tr>' +
        '<td>' +
        esc(x.at) +
        '</td>' +
        '<td>' +
        esc(x.type) +
        '</td>' +
        '<td>' +
        esc(x.email) +
        '</td>' +
        '<td>' +
        esc(x.userId) +
        '</td>' +
        '</tr>'
    ).join('') +
    '</tbody></table></div>';
}

function renderErrors(data){
  const list =
    Array.isArray(
      data.errors
    )
      ? data.errors
      : [];

  if(!list.length){
    $('errors').innerHTML =
      '<p class="muted">No errors recorded.</p>';
    return;
  }

  $('errors').innerHTML =
    '<div class="table-wrap"><table>' +
    '<thead><tr>' +
    '<th>Time</th>' +
    '<th>Message</th>' +
    '<th>Route</th>' +
    '</tr></thead><tbody>' +
    list.map(
      x =>
        '<tr>' +
        '<td>' +
        esc(x.at) +
        '</td>' +
        '<td>' +
        esc(x.message) +
        '</td>' +
        '<td>' +
        esc(x.context?.route) +
        '</td>' +
        '</tr>'
    ).join('') +
    '</tbody></table></div>';
}

async function loadAll(
  fromLogin=false
){
  try{
    const [
      overview,
      pricing,
      users,
      jobs,
      security,
      errors,
      health
    ] =
      await Promise.all([
        api(
          '/api/admin/overview'
        ),
        api(
          '/api/admin/pricing'
        ),
        api(
          '/api/admin/users'
        ),
        api(
          '/api/admin/jobs'
        ),
        api(
          '/api/admin/security'
        ),
        api(
          '/api/admin/errors'
        ),
        fetch(
          '/health',
          {
            cache:'no-store'
          }
        ).then(
          r => r.json()
        )
      ]);

    $('login')
      .classList
      .add('hidden');

    $('dash')
      .classList
      .remove('hidden');

    $('actions')
      .classList
      .remove('hidden');

    $('health').textContent =
      (
        health.ok
          ? 'System healthy'
          : 'System degraded'
      ) +
      ' · Version ' +
      (health.version ||
        '');

    renderMetrics(
      'overview',
      [
        [
          'Total Users',
          overview.overview?.totalUsers ||
            0
        ],
        [
          'Active Users',
          overview.overview?.activeUsers ||
            0
        ],
        [
          'Administrators',
          overview.overview?.administrators ||
            0
        ],
        [
          'Projects',
          overview.overview?.projects ||
            0
        ],
        [
          'AI Generations',
          overview.overview?.aiGenerations ||
            0
        ],
        [
          'AI Seconds',
          overview.overview?.aiSeconds ||
            0
        ],
        [
          'Completed',
          overview.overview?.completed ||
            0
        ],
        [
          'Processing',
          overview.overview?.processing ||
            0
        ],
        [
          'Failed',
          overview.overview?.failed ||
            0
        ]
      ]
    );

    const finance =
      overview.finance ||
      {};

    renderMetrics(
      'finance',
      [
        [
          'Gross Revenue',
          money(
            finance.grossRevenue
          )
        ],
        [
          'Provider Spend',
          money(
            finance.providerSpend
          )
        ],
        [
          'Profit',
          money(
            finance.profit
          )
        ],
        [
          'Withdrawn',
          money(
            finance.withdrawn
          )
        ],
        [
          'Transactions',
          finance.transactions ||
            0
        ]
      ]
    );

    renderPricing(
      pricing
    );

    renderUsers(
      users
    );

    renderJobs(
      jobs
    );

    renderSecurity(
      security
    );

    renderErrors(
      errors
    );

  }catch(e){
    if(
      String(
        e.message || ''
      ).includes(
        'Administrator access required'
      ) ||
      String(
        e.message || ''
      ).includes(
        'AUTH_REQUIRED'
      )
    ){
      localStorage.removeItem(
        'mamaki_admin_token'
      );

      token = '';

      $('login')
        .classList
        .remove('hidden');

      $('dash')
        .classList
        .add('hidden');

      $('actions')
        .classList
        .add('hidden');

      $('msg').textContent =
        'Your administrator session expired. Please sign in again.';
    }else{
      $('msg').textContent =
        e.message;
    }
  }
}

async function adjustCredits(){
  const message =
    $('creditMsg');

  try{
    const data =
      await api(
        '/api/admin/credits/adjust',
        {
          method:'POST',
          headers:{
            'Content-Type':
              'application/json'
          },
          body:
            JSON.stringify({
              userId:
                $('creditUser')
                  .value
                  .trim(),
              amount:
                Number(
                  $('creditAmount')
                    .value
                ),
              reason:
                $('creditReason')
                  .value
                  .trim()
            })
        }
      );

    message.textContent =
      'Updated. New balance: ' +
      Number(
        data.credits?.balance ||
        0
      ).toLocaleString();

    await loadAll();
  }catch(e){
    message.textContent =
      e.message;
  }
}

async function withdrawProfit(){
  const message =
    $('withdrawMsg');

  try{
    const data =
      await api(
        '/api/admin/withdraw',
        {
          method:'POST',
          headers:{
            'Content-Type':
              'application/json'
          },
          body:
            JSON.stringify({
              amount:
                Number(
                  $('withdrawAmount')
                    .value
                ),
              recipientCode:
                $('recipientCode')
                  .value
                  .trim(),
              reason:
                $('withdrawReason')
                  .value
                  .trim()
            })
        }
      );

    message.textContent =
      'Withdrawal submitted. Reference: ' +
      data.reference;

    await loadAll();
  }catch(e){
    message.textContent =
      e.message;
  }
}

if(token){
  loadAll();
}
</script>
</body>
</html>
`);
});

app.use(
  express.static(
    ROOT,
    {
      index: false,
      maxAge: 0,
    }
  )
);

app.use(
  (req, res) => {
    if (
      req.path.startsWith(
        "/api/"
      )
    ) {
      return res.status(404).json({
        ok: false,
        error:
          "NOT_FOUND",
        message:
          "API endpoint not found.",
      });
    }

    res.status(404).send(
      "MAMAKI page not found."
    );
  }
);

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
        error.code ||
        "SERVER_ERROR",
      message:
        error.message ||
        "Internal server error.",
    });
  }
);

async function cleanupOldFiles() {
  try {
    const entries =
      await fs.readdir(
        TMP,
        {
          withFileTypes:
            true,
        }
      );

    const cutoff =
      Date.now() -
      24 * 60 * 60 * 1000;

    for (
      const entry
      of entries
    ) {
      const file =
        path.join(
          TMP,
          entry.name
        );

      try {
        const stat =
          await fs.stat(
            file
          );

        if (
          stat.mtimeMs <
          cutoff
        ) {
          await fs.rm(
            file,
            {
              recursive:
                true,
              force:
                true,
            }
          );
        }
      } catch {}
    }
  } catch {}
}

async function cleanupExpiredSessions() {
  try {
    const sessions =
      await readJson(
        SESSIONS_FILE,
        {}
      );

    const now =
      Date.now();

    let changed =
      false;

    for (
      const [
        key,
        session
      ]
      of Object.entries(
        sessions
      )
    ) {
      if (
        session?.expiresAt &&
        now >
          new Date(
            session.expiresAt
          ).getTime()
      ) {
        delete sessions[key];
        changed = true;
      }
    }

    if(changed){
      await writeJson(
        SESSIONS_FILE,
        sessions
      );
    }
  } catch {}
}

async function start() {
  await ensureStorage();

  await cleanupOldFiles();

  await cleanupExpiredSessions();

  try {
    await buildPricing();
  } catch {}

  app.listen(
    PORT,
    HOST,
    () => {
      console.log(
        `MAMAKI AI ${VERSION} listening on ${HOST}:${PORT}`
      );
    }
  );
}

start().catch(
  async (error) => {
    await recordError(
      error,
      {
        phase:
          "startup",
      }
    );

    console.error(
      error
    );

    process.exit(1);
  }
);
