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
  0.9,
  Math.max(
    0.05,
    Number(process.env.MAMAKI_TARGET_MARGIN || 0.4)
  )
);

const PAYMENT_FEE_BUFFER = Math.min(
  0.3,
  Math.max(
    0,
    Number(process.env.MAMAKI_PAYMENT_FEE_BUFFER || 0.04)
  )
);

const FX_BUFFER = Math.min(
  0.3,
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
  Number(process.env.WAN_720P_COST_USD || 0.1)
);

const PAYSTACK_CURRENCY_DEFAULT = String(
  process.env.PAYSTACK_CURRENCY_DEFAULT || "NGN"
).toUpperCase();

const FIXED_NGN_MARKUP_PER_USD = Math.max(
  0,
  Number(
    process.env.MAMAKI_FIXED_NGN_MARKUP_PER_USD || 200
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

    if (!raw.trim()) {
      return fallback;
    }

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

      if (["m", "min", "mins"].includes(unit)) {
        n *= 60;
      }

      if (["h", "hr", "hrs"].includes(unit)) {
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
  const v = String(value || "16:9");

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
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function safeFileName(
  name,
  fallback = "file"
) {
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

async function invalidateUserSessions(
  userId
) {
  const sessions = await readJson(
    SESSIONS_FILE,
    {}
  );

  let changed = false;

  for (
    const [token, session] of Object.entries(
      sessions
    )
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
    30 *
    24 *
    60 *
    60 *
    1000;

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

  const user =
    users[session.userId];

  if (!user || user.disabled) {
    return null;
  }

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
  if (!userId) {
    return;
  }

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
      code:
        "REPLICATE_CREDIT_REQUIRED",
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
      code:
        "REPLICATE_AUTH_REQUIRED",
      message:
        "Replicate authentication is missing or invalid. Check REPLICATE_API_TOKEN in Render.",
    };
  }

  if (
    text.includes("403") ||
    text.includes("forbidden")
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
    text.includes("rate limit") ||
    text.includes("too many")
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
    for (const item of output) {
      try {
        return await downloadReplicateOutput(
          item,
          destination
        );
      } catch {}
    }
  }

  throw new Error(
    "Replicate returned an unsupported video output."
  );
}

function ffmpegArgsForConcat(
  inputList,
  outputFile
) {
  return [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    inputList,
    "-c",
    "copy",
    outputFile,
  ];
}

function runProcess(
  command,
  args,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {
      const child = spawn(
        command,
        args,
        {
          ...options,
          stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        }
      );

      let stdout = "";
      let stderr = "";

      child.stdout.on(
        "data",
        (chunk) => {
          stdout += chunk.toString();
        }
      );

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
            resolve({
              code,
              stdout,
              stderr,
            });
          } else {
            const error =
              new Error(
                `Process exited with code ${code}`
              );

            error.code = code;
            error.stdout = stdout;
            error.stderr = stderr;

            reject(error);
          }
        }
      );
    }
  );
}

async function runFfmpeg(
  args
) {
  if (!ffmpegPath) {
    throw new Error(
      "FFmpeg is not available."
    );
  }

  return runProcess(
    ffmpegPath,
    args
  );
}

async function ensureAdminAccount() {
  if (!ADMIN_EMAIL) {
    return null;
  }

  const users = await readJson(
    USERS_FILE,
    {}
  );

  let existing = Object.values(
    users
  ).find(
    (user) =>
      normalizeEmail(user.email) ===
      ADMIN_EMAIL
  );

  if (existing) {
    if (existing.role !== "admin") {
      existing.role = "admin";
      existing.updatedAt = Date.now();
      users[existing.id] = existing;
      await writeJson(
        USERS_FILE,
        users
      );
    }

    return existing;
  }

  if (!ADMIN_PASSWORD) {
    return null;
  }

  const passwordData =
    hashPassword(ADMIN_PASSWORD);

  const id = randomUUID();

  existing = {
    id,
    email: ADMIN_EMAIL,
    name: "MAMAKI Administrator",
    role: "admin",
    passwordHash:
      passwordData.hash,
    salt: passwordData.salt,
    disabled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  users[id] = existing;

  await writeJson(
    USERS_FILE,
    users
  );

  return existing;
}

function publicUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name:
      user.name ||
      user.fullName ||
      "MAMAKI User",
    role: user.role || "user",
    disabled: Boolean(
      user.disabled
    ),
    createdAt: user.createdAt,
  };
}

async function findUserByEmail(
  email
) {
  const normalized =
    normalizeEmail(email);

  const users = await readJson(
    USERS_FILE,
    {}
  );

  return Object.values(
    users
  ).find(
    (user) =>
      normalizeEmail(user.email) ===
      normalized
  ) || null;
}

async function getCreditsState() {
  return readJson(
    CREDITS_FILE,
    {}
  );
}

async function getUserCredits(
  userId
) {
  const credits =
    await getCreditsState();

  const entry =
    credits[userId];

  if (!entry) {
    return 0;
  }

  return Math.max(
    0,
    Number(
      entry.balance ||
        entry.credits ||
        0
    )
  );
}

async function setUserCredits(
  userId,
  balance,
  meta = {}
) {
  const credits =
    await getCreditsState();

  if (!credits[userId]) {
    credits[userId] = {
      userId,
      balance: 0,
      transactions: [],
      createdAt: Date.now(),
    };
  }

  credits[userId].balance =
    Math.max(
      0,
      Math.floor(
        Number(balance) || 0
      )
    );

  credits[userId].updatedAt =
    Date.now();

  if (
    meta &&
    Object.keys(meta).length
  ) {
    credits[userId].transactions =
      Array.isArray(
        credits[userId]
          .transactions
      )
        ? credits[userId]
            .transactions
        : [];

    credits[userId].transactions.push(
      {
        id: randomUUID(),
        createdAt: Date.now(),
        ...meta,
      }
    );

    if (
      credits[userId]
        .transactions.length > 500
    ) {
      credits[userId].transactions =
        credits[userId]
          .transactions.slice(-500);
    }
  }

  await writeJson(
    CREDITS_FILE,
    credits
  );

  return credits[userId].balance;
}

async function addCredits(
  userId,
  amount,
  meta = {}
) {
  const current =
    await getUserCredits(
      userId
    );

  return setUserCredits(
    userId,
    current +
      Math.max(
        0,
        Math.floor(
          Number(amount) || 0
        )
      ),
    {
      ...meta,
      type:
        meta.type ||
        "credit",
      amount:
        Math.floor(
          Number(amount) || 0
        ),
    }
  );
}

async function deductCredits(
  userId,
  amount,
  meta = {}
) {
  const n = Math.max(
    0,
    Math.floor(
      Number(amount) || 0
    )
  );

  const current =
    await getUserCredits(
      userId
    );

  if (current < n) {
    return {
      ok: false,
      balance: current,
      required: n,
    };
  }

  const balance =
    await setUserCredits(
      userId,
      current - n,
      {
        ...meta,
        type:
          meta.type ||
          "debit",
        amount: n,
      }
    );

  return {
    ok: true,
    balance,
    required: n,
  };
}

async function refundCredits(
  userId,
  amount,
  meta = {}
) {
  return addCredits(
    userId,
    amount,
    {
      ...meta,
      type:
        meta.type ||
        "refund",
    }
  );
}

function basePricing() {
  return {
    currency:
      PAYSTACK_CURRENCY_DEFAULT,
    packages: [
      {
        id: "starter",
        name: "Starter",
        credits: 100,
        priceNGN: 5000,
      },
      {
        id: "creator",
        name: "Creator",
        credits: 250,
        priceNGN: 10000,
      },
      {
        id: "pro",
        name: "Pro",
        credits: 600,
        priceNGN: 20000,
      },
      {
        id: "studio",
        name: "Studio",
        credits: 1500,
        priceNGN: 45000,
      },
    ],
    updatedAt: Date.now(),
  };
}

async function getPricing() {
  const pricing =
    await readJson(
      PRICING_FILE,
      {}
    );

  if (
    !pricing.packages ||
    !Array.isArray(
      pricing.packages
    )
  ) {
    const defaults =
      basePricing();

    await writeJson(
      PRICING_FILE,
      defaults
    );

    return defaults;
  }

  return {
    ...basePricing(),
    ...pricing,
  };
}

async function calculatePrice(
  packageData
) {
  const pricing =
    await getPricing();

  const pkg =
    pricing.packages.find(
      (item) =>
        item.id ===
        packageData
    );

  if (!pkg) {
    return null;
  }

  return {
    ...pkg,
    currency:
      pricing.currency ||
      PAYSTACK_CURRENCY_DEFAULT,
  };
}

async function recordPayment(
  payment
) {
  const payments =
    await readJson(
      PAYMENTS_FILE,
      {}
    );

  payments[payment.id] =
    payment;

  const ids =
    Object.keys(
      payments
    );

  if (ids.length > 5000) {
    ids.sort(
      (a, b) =>
        Number(
          payments[a]
            .createdAt || 0
        ) -
        Number(
          payments[b]
            .createdAt || 0
        )
    );

    while (
      ids.length > 5000
    ) {
      const old =
        ids.shift();

      if (old) {
        delete payments[old];
      }
    }
  }

  await writeJson(
    PAYMENTS_FILE,
    payments
  );
}

async function recordFinance(
  entry
) {
  const finance =
    await readJson(
      FINANCE_FILE,
      {}
    );

  const id =
    entry.id ||
    randomUUID();

  finance[id] = {
    id,
    createdAt:
      Date.now(),
    ...entry,
  };

  await writeJson(
    FINANCE_FILE,
    finance
  );

  return finance[id];
}

function paystackHeaders() {
  return {
    Authorization:
      `Bearer ${PAYSTACK_SECRET_KEY}`,
    "Content-Type":
      "application/json",
  };
}

async function paystackInitialize(
  email,
  amount,
  reference,
  metadata
) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error(
      "Paystack secret key is not configured."
    );
  }

  const response =
    await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers:
          paystackHeaders(),
        body: JSON.stringify({
          email,
          amount:
            Math.round(
              Number(amount)
            ),
          currency:
            PAYSTACK_CURRENCY_DEFAULT,
          reference,
          callback_url:
            `${APP_URL}/payment/callback`,
          metadata,
        }),
      }
    );

  const data =
    await response.json()
      .catch(() => ({}));

  if (
    !response.ok ||
    !data.status
  ) {
    throw new Error(
      data.message ||
        "Unable to initialize Paystack payment."
    );
  }

  return data.data;
}

async function paystackVerify(
  reference
) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error(
      "Paystack secret key is not configured."
    );
  }

  const response =
    await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(
        reference
      )}`,
      {
        headers:
          paystackHeaders(),
      }
    );

  const data =
    await response.json()
      .catch(() => ({}));

  if (
    !response.ok ||
    !data.status
  ) {
    throw new Error(
      data.message ||
        "Unable to verify Paystack payment."
    );
  }

  return data.data;
}

function verifyPaystackWebhook(
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
    Buffer.from("");

  const expected =
    createHmac(
      "sha512",
      PAYSTACK_SECRET_KEY
    )
      .update(body)
      .digest("hex");

  return (
    signature.length ===
      expected.length &&
    timingSafeEqual(
      Buffer.from(
        signature
      ),
      Buffer.from(
        expected
      )
    )
  );
}

async function sendEmail({
  to,
  subject,
  html,
  text,
}) {
  if (
    !RESEND_API_KEY ||
    !RESEND_FROM
  ) {
    return {
      ok: false,
      configured: false,
    };
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
          from:
            RESEND_FROM,
          to: [to],
          subject,
          html,
          text,
        }),
      }
    );

  const data =
    await response.json()
      .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message ||
        "Email provider rejected the message."
    );
  }

  return {
    ok: true,
    configured: true,
    data,
  };
}

function recoveryTokenHash(
  token
) {
  return createHash(
    "sha256"
  )
    .update(
      String(token)
    )
    .digest("hex");
}

async function createPasswordReset(
  user
) {
  const token =
    randomBytes(32)
      .toString("hex");

  const hash =
    recoveryTokenHash(
      token
    );

  const resets =
    await readJson(
      RESET_FILE,
      {}
    );

  const id =
    randomUUID();

  resets[id] = {
    id,
    userId:
      user.id,
    tokenHash:
      hash,
    createdAt:
      Date.now(),
    expiresAt:
      Date.now() +
      30 *
        60 *
        1000,
    used: false,
  };

  await writeJson(
    RESET_FILE,
    resets
  );

  return token;
}

async function consumePasswordReset(
  token,
  newPassword
) {
  const hash =
    recoveryTokenHash(
      token
    );

  const resets =
    await readJson(
      RESET_FILE,
      {}
    );

  const item =
    Object.values(
      resets
    ).find(
      (entry) =>
        entry.tokenHash ===
          hash &&
        !entry.used &&
        Number(
          entry.expiresAt || 0
        ) >
          Date.now()
    );

  if (!item) {
    return {
      ok: false,
      message:
        "This password recovery link is invalid or expired.",
    };
  }

  const users =
    await readJson(
      USERS_FILE,
      {}
    );

  const user =
    users[item.userId];

  if (!user) {
    return {
      ok: false,
      message:
        "Account not found.",
    };
  }

  const passwordData =
    hashPassword(
      newPassword
    );

  user.passwordHash =
    passwordData.hash;
  user.salt =
    passwordData.salt;
  user.updatedAt =
    Date.now();

  users[user.id] =
    user;

  item.used = true;
  item.usedAt =
    Date.now();

  await writeJson(
    USERS_FILE,
    users
  );

  await writeJson(
    RESET_FILE,
    resets
  );

  await invalidateUserSessions(
    user.id
  );

  return {
    ok: true,
    user,
  };
}

function rateAllowed(
  map,
  key,
  limit,
  windowMs
) {
  const now =
    Date.now();

  const current =
    map.get(key);

  if (
    !current ||
    now -
      current.startedAt >
      windowMs
  ) {
    map.set(
      key,
      {
        startedAt:
          now,
        count: 1,
      }
    );

    return true;
  }

  if (
    current.count >=
    limit
  ) {
    return false;
  }

  current.count += 1;

  return true;
}

app.get(
  "/health",
  async (req, res) => {
    let ffmpegOk =
      Boolean(ffmpegPath);

    try {
      if (ffmpegPath) {
        await fs.access(
          ffmpegPath
        );
      }
    } catch {
      ffmpegOk = false;
    }

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
        ffmpeg: ffmpegOk,
        replicateConfigured:
          Boolean(
            REPLICATE_API_TOKEN
          ),
        adminConfigured:
          Boolean(
            ADMIN_EMAIL &&
              ADMIN_PASSWORD
          ),
        recoveryConfigured:
          Boolean(
            RESEND_API_KEY &&
              RESEND_FROM
          ),
        paystackConfigured:
          Boolean(
            PAYSTACK_SECRET_KEY &&
              PAYSTACK_PUBLIC_KEY
          ),
      },
    });
  }
);

app.get(
  "/api/health",
  async (req, res) => {
    res.json({
      ok: true,
      status: "healthy",
      service:
        "MAMAKI AI Video Creative Studio",
      version: VERSION,
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
      recoveryConfigured:
        Boolean(
          RESEND_API_KEY &&
            RESEND_FROM
        ),
      paystackConfigured:
        Boolean(
          PAYSTACK_SECRET_KEY &&
            PAYSTACK_PUBLIC_KEY
        ),
    });
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
      return res.json({
        ok: true,
        authenticated:
          false,
        user: null,
      });
    }

    res.json({
      ok: true,
      authenticated:
        true,
      user:
        publicUser(user),
      credits:
        await getUserCredits(
          user.id
        ),
    });
  }
);

app.post(
  "/api/auth/register",
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

      const name =
        cleanText(
          req.body.name ||
            req.body.fullName ||
            "MAMAKI User",
          150
        );

      if (
        !email ||
        !email.includes("@")
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "Enter a valid email address.",
        });
      }

      if (
        password.length < 6
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "Password must be at least 6 characters.",
        });
      }

      const existing =
        await findUserByEmail(
          email
        );

      if (existing) {
        return res.status(409).json({
          ok: false,
          message:
            "An account with this email already exists.",
        });
      }

      const passwordData =
        hashPassword(
          password
        );

      const id =
        randomUUID();

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      users[id] = {
        id,
        email,
        name,
        role: "user",
        passwordHash:
          passwordData.hash,
        salt:
          passwordData.salt,
        disabled: false,
        createdAt:
          Date.now(),
        updatedAt:
          Date.now(),
      };

      await writeJson(
        USERS_FILE,
        users
      );

      await setUserCredits(
        id,
        0,
        {
          type:
            "account_created",
          amount: 0,
        }
      );

      const token =
        await createSession(
          id,
          "user"
        );

      res.json({
        ok: true,
        message:
          "Account created successfully.",
        token,
        user:
          publicUser(
            users[id]
          ),
        credits: 0,
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

      const user =
        await findUserByEmail(
          email
        );

      if (
        !user ||
        user.disabled
      ) {
        return res.status(401).json({
          ok: false,
          message:
            "Invalid email or password.",
        });
      }

      if (
        !verifyPassword(
          password,
          user.salt,
          user.passwordHash
        )
      ) {
        return res.status(401).json({
          ok: false,
          message:
            "Invalid email or password.",
        });
      }

      const token =
        await createSession(
          user.id,
          user.role === "admin"
            ? "admin"
            : "user"
        );

      res.json({
        ok: true,
        message:
          "Login successful.",
        token,
        user:
          publicUser(user),
        credits:
          await getUserCredits(
            user.id
          ),
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
        message:
          "Unable to log in.",
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

        delete sessions[token];

        await writeJson(
          SESSIONS_FILE,
          sessions
        );
      }

      res.json({
        ok: true,
        message:
          "Logged out successfully.",
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/auth/logout",
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Unable to log out.",
      });
    }
  }
);

app.post(
  "/api/admin/login",
  async (req, res) => {
    try {
      const ip =
        String(
          req.ip ||
            req.headers[
              "x-forwarded-for"
            ] ||
            "unknown"
        );

      if (
        !rateAllowed(
          adminLoginRate,
          ip,
          20,
          15 * 60 * 1000
        )
      ) {
        return res.status(429).json({
          ok: false,
          message:
            "Too many login attempts. Please try again later.",
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

      const masterCredentialsMatch =
        Boolean(
          ADMIN_EMAIL &&
            ADMIN_PASSWORD &&
            email ===
              ADMIN_EMAIL &&
            password ===
              ADMIN_PASSWORD
        );

      let user =
        await findUserByEmail(
          email
        );

      const storedAdminMatch =
        Boolean(
          user &&
            user.role ===
              "admin" &&
            verifyPassword(
              password,
              user.salt,
              user.passwordHash
            )
        );

      if (
        !masterCredentialsMatch &&
        !storedAdminMatch
      ) {
        return res.status(401).json({
          ok: false,
          message:
            "Invalid administrator email or password.",
        });
      }

      if (
        masterCredentialsMatch &&
        (!user ||
          user.role !==
            "admin")
      ) {
        const users =
          await readJson(
            USERS_FILE,
            {}
          );

        if (!user) {
          const passwordData =
            hashPassword(
              password
            );

          user = {
            id:
              randomUUID(),
            email,
            name:
              "MAMAKI Administrator",
            role:
              "admin",
            passwordHash:
              passwordData.hash,
            salt:
              passwordData.salt,
            disabled: false,
            createdAt:
              Date.now(),
            updatedAt:
              Date.now(),
          };

          users[user.id] =
            user;
        } else {
          user.role =
            "admin";
          user.disabled =
            false;
          user.updatedAt =
            Date.now();
          users[user.id] =
            user;
        }

        await writeJson(
          USERS_FILE,
          users
        );
      }

      if (
        !user ||
        user.disabled
      ) {
        return res.status(403).json({
          ok: false,
          message:
            "Administrator account is disabled.",
        });
      }

      const token =
        await createSession(
          user.id,
          "admin"
        );

      res.json({
        ok: true,
        message:
          "Administrator login successful.",
        token,
        user:
          publicUser(
            user
          ),
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
        message:
          "Administrator login failed.",
      });
    }
  }
);

app.post(
  "/api/auth/forgot-password",
  async (req, res) => {
    try {
      const email =
        normalizeEmail(
          req.body.email
        );

      const ip =
        String(
          req.ip ||
            req.headers[
              "x-forwarded-for"
            ] ||
            "unknown"
        );

      if (
        !rateAllowed(
          resetRate,
          ip,
          5,
          15 * 60 * 1000
        )
      ) {
        return res.status(429).json({
          ok: false,
          message:
            "Too many recovery requests. Please try again later.",
        });
      }

      const generic = {
        ok: true,
        message:
          "If an account exists for that email, recovery instructions have been sent.",
      };

      if (
        !email ||
        !email.includes("@")
      ) {
        return res.json(
          generic
        );
      }

      const user =
        await findUserByEmail(
          email
        );

      if (!user) {
        return res.json(
          generic
        );
      }

      if (
        !RESEND_API_KEY ||
        !RESEND_FROM
      ) {
        return res.status(503).json({
          ok: false,
          error:
            "RECOVERY_NOT_CONFIGURED",
          message:
            "Password recovery email is not configured yet. Add RESEND_API_KEY and RESEND_FROM in Render.",
        });
      }

      const token =
        await createPasswordReset(
          user
        );

      const resetUrl =
        `${APP_URL}/?reset=${encodeURIComponent(
          token
        )}`;

      await sendEmail({
        to:
          user.email,
        subject:
          "MAMAKI AI password reset",
        text:
          `Reset your MAMAKI AI password using this link: ${resetUrl}`,
        html:
          `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>MAMAKI AI</h2><p>You requested a password reset.</p><p><a href="${resetUrl}">Reset your password</a></p><p>This link expires in 30 minutes.</p></div>`,
      });

      res.json(
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

      res.status(500).json({
        ok: false,
        message:
          "Unable to process password recovery.",
      });
    }
  }
);

app.post(
  "/api/auth/reset-password",
  async (req, res) => {
    try {
      const token =
        cleanText(
          req.body.token,
          500
        );

      const password =
        String(
          req.body.password ||
            ""
        );

      if (
        !token ||
        password.length < 6
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "A valid recovery token and password of at least 6 characters are required.",
        });
      }

      const result =
        await consumePasswordReset(
          token,
          password
        );

      if (!result.ok) {
        return res.status(400).json(
          result
        );
      }

      res.json({
        ok: true,
        message:
          "Password reset successfully. You can now log in.",
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
        message:
          "Unable to reset password.",
      });
    }
  }
);

app.get(
  "/api/pricing",
  async (req, res) => {
    try {
      const pricing =
        await getPricing();

      res.json({
        ok: true,
        pricing,
        packages:
          pricing.packages,
        paystackPublicKey:
          PAYSTACK_PUBLIC_KEY,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/pricing",
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Unable to load pricing.",
      });
    }
  }
);

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
  "/api/payments/initialize",
  requireUser,
  async (req, res) => {
    try {
      if (
        !PAYSTACK_SECRET_KEY
      ) {
        return res.status(503).json({
          ok: false,
          message:
            "Paystack payments are not configured.",
        });
      }

      const packageId =
        cleanText(
          req.body.packageId,
          100
        );

      const pkg =
        await calculatePrice(
          packageId
        );

      if (!pkg) {
        return res.status(400).json({
          ok: false,
          message:
            "Invalid credit package.",
        });
      }

      const reference =
        `MAMAKI-${Date.now()}-${randomBytes(
          5
        ).toString("hex")}`;

      const metadata = {
        userId:
          req.user.id,
        packageId:
          pkg.id,
        credits:
          pkg.credits,
        customerEmail:
          req.user.email,
        product:
          "MAMAKI AI Credits",
      };

      const payment =
        await paystackInitialize(
          req.user.email,
          pkg.priceNGN * 100,
          reference,
          metadata
        );

      await recordPayment({
        id:
          reference,
        reference,
        userId:
          req.user.id,
        packageId:
          pkg.id,
        credits:
          pkg.credits,
        amountNGN:
          pkg.priceNGN,
        status:
          "initialized",
        createdAt:
          Date.now(),
      });

      res.json({
        ok: true,
        authorization_url:
          payment.authorization_url,
        access_code:
          payment.access_code,
        reference,
        package:
          pkg,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/payments/initialize",
          userId:
            req.user?.id,
        }
      );

      res.status(500).json({
        ok: false,
        message:
          error.message ||
          "Unable to initialize payment.",
      });
    }
  }
);

app.get(
  "/api/payments/verify/:reference",
  requireUser,
  async (req, res) => {
    try {
      const reference =
        cleanText(
          req.params.reference,
          200
        );

      const data =
        await paystackVerify(
          reference
        );

      if (
        data.status !==
        "success"
      ) {
        return res.json({
          ok: true,
          paid: false,
          status:
            data.status,
        });
      }

      const metadata =
        data.metadata ||
        {};

      const userId =
        String(
          metadata.userId ||
            ""
        );

      if (
        userId &&
        userId !==
          req.user.id
      ) {
        return res.status(403).json({
          ok: false,
          message:
            "Payment does not belong to this account.",
        });
      }

      const packageId =
        cleanText(
          metadata.packageId,
          100
        );

      const pkg =
        await calculatePrice(
          packageId
        );

      if (!pkg) {
        return res.status(400).json({
          ok: false,
          message:
            "Payment package could not be identified.",
        });
      }

      const payments =
        await readJson(
          PAYMENTS_FILE,
          {}
        );

      const existing =
        payments[
          reference
        ];

      if (
        !existing ||
        existing.status !==
          "success"
      ) {
        const credits =
          Number(
            metadata.credits ||
              pkg.credits
          );

        await addCredits(
          req.user.id,
          credits,
          {
            type:
              "purchase",
            reference,
            packageId:
              pkg.id,
            amountNGN:
              pkg.priceNGN,
          }
        );

        await recordPayment({
          ...(existing || {}),
          id:
            reference,
          reference,
          userId:
            req.user.id,
          packageId:
            pkg.id,
          credits,
          amountNGN:
            Number(
              data.amount || 0
            ) / 100,
          status:
            "success",
          paidAt:
            Date.now(),
          createdAt:
            existing?.createdAt ||
            Date.now(),
        });

        await recordFinance({
          type:
            "credit_purchase",
          userId:
            req.user.id,
          reference,
          amountNGN:
            Number(
              data.amount || 0
            ) / 100,
          credits,
        });
      }

      res.json({
        ok: true,
        paid: true,
        status:
          "success",
        reference,
        credits:
          await getUserCredits(
            req.user.id
          ),
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/payments/verify",
          userId:
            req.user?.id,
        }
      );

      res.status(500).json({
        ok: false,
        message:
          error.message ||
          "Unable to verify payment.",
      });
    }
  }
);

app.post(
  "/api/paystack/webhook",
  async (req, res) => {
    try {
      if (
        !verifyPaystackWebhook(
          req
        )
      ) {
        return res.status(401).send(
          "invalid signature"
        );
      }

      const event =
        req.body || {};

      if (
        event.event !==
        "charge.success"
      ) {
        return res.json({
          ok: true,
          ignored: true,
        });
      }

      const data =
        event.data ||
        {};

      const metadata =
        data.metadata ||
        {};

      const userId =
        String(
          metadata.userId ||
            ""
        );

      const packageId =
        cleanText(
          metadata.packageId,
          100
        );

      if (
        !userId ||
        !packageId
      ) {
        return res.json({
          ok: true,
          ignored: true,
        });
      }

      const pkg =
        await calculatePrice(
          packageId
        );

      if (!pkg) {
        return res.json({
          ok: true,
          ignored: true,
        });
      }

      const reference =
        cleanText(
          data.reference,
          200
        );

      if (!reference) {
        return res.json({
          ok: true,
          ignored: true,
        });
      }

      const payments =
        await readJson(
          PAYMENTS_FILE,
          {}
        );

      if (
        payments[
          reference
        ]?.status ===
        "success"
      ) {
        return res.json({
          ok: true,
          duplicate: true,
        });
      }

      const credits =
        Number(
          metadata.credits ||
            pkg.credits
        );

      await addCredits(
        userId,
        credits,
        {
          type:
            "purchase",
          reference,
          packageId,
          amountNGN:
            Number(
              data.amount ||
                0
            ) / 100,
        }
      );

      await recordPayment({
        id:
          reference,
        reference,
        userId,
        packageId,
        credits,
        amountNGN:
          Number(
            data.amount ||
              0
          ) / 100,
        status:
          "success",
        paidAt:
          Date.now(),
        createdAt:
          Date.now(),
      });

      await recordFinance({
        type:
          "credit_purchase",
        userId,
        reference,
        amountNGN:
          Number(
            data.amount ||
              0
          ) / 100,
        credits,
      });

      res.json({
        ok: true,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/paystack/webhook",
        }
      );

      res.status(500).json({
        ok: false,
      });
    }
  }
);

app.get(
  "/payment/callback",
  async (req, res) => {
    const reference =
      cleanText(
        req.query.reference,
        200
      );

    res.type("html").send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI Payment</title>
<style>
body{margin:0;background:#050509;color:#fff;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{max-width:520px;margin:20px;padding:30px;border:1px solid #272733;border-radius:20px;background:#101018;text-align:center}
button{padding:13px 20px;border:0;border-radius:12px;background:#7c5cff;color:white;font-weight:700;cursor:pointer}
</style>
</head>
<body>
<div class="box">
<h1>MAMAKI AI</h1>
<p>Payment received. Return to MAMAKI AI and verify your transaction.</p>
${reference ? `<p>Reference: ${reference}</p>` : ""}
<button onclick="location.href='/'">Return to MAMAKI AI</button>
</div>
</body>
</html>
`);
  }
);

async function buildWanInput({
  prompt,
  duration,
  ratio,
  imageUrl,
}) {
  const seconds =
    Math.min(
      5,
      normalizeDuration(
        duration
      )
    );

  const input = {
    prompt:
      cleanText(
        prompt,
        5000
      ),
    num_frames:
      wanFrames(seconds),
    resolution:
      "480p",
    aspect_ratio:
      normalizeRatio(
        ratio
      ),
    go_fast: true,
  };

  if (imageUrl) {
    input.image =
      imageUrl;
  }

  return input;
}

async function runReplicateGeneration({
  prompt,
  duration,
  ratio,
  imageUrl,
}) {
  if (!replicate) {
    const error =
      new Error(
        "Replicate API is not configured."
      );

    error.code =
      "REPLICATE_AUTH_REQUIRED";

    throw error;
  }

  const input =
    await buildWanInput({
      prompt,
      duration,
      ratio,
      imageUrl,
    });

  const model =
    imageUrl
      ? I2V_MODEL
      : T2V_MODEL;

  return replicate.run(
    model,
    {
      input,
    }
  );
}

async function generateScene({
  prompt,
  ratio,
  imageUrl,
  userId,
}) {
  const output =
    await runReplicateGeneration({
      prompt,
      duration: 5,
      ratio,
      imageUrl,
    });

  const file =
    path.join(
      OUTPUTS,
      `${randomUUID()}.mp4`
    );

  await downloadReplicateOutput(
    output,
    file
  );

  await recordUsage(
    userId,
    "ai",
    5
  );

  return file;
}

async function concatVideos(
  files,
  outputFile
) {
  if (!files.length) {
    throw new Error(
      "No video files were supplied."
    );
  }

  if (files.length === 1) {
    await fs.copyFile(
      files[0],
      outputFile
    );

    return outputFile;
  }

  const listFile =
    path.join(
      TMP,
      `${randomUUID()}.txt`
    );

  const lines =
    files.map(
      (file) =>
        `file '${file.replace(
          /'/g,
          "'\\''"
        )}'`
    );

  await fs.writeFile(
    listFile,
    lines.join("\n"),
    "utf8"
  );

  try {
    await runFfmpeg(
      ffmpegArgsForConcat(
        listFile,
        outputFile
      )
    );
  } finally {
    await fs.rm(
      listFile,
      {
        force: true,
      }
    );
  }

  return outputFile;
}

async function applyWatermark(
  inputFile,
  outputFile
) {
  const filter =
    "drawtext=text='MAMAKI AI':fontcolor=white@0.78:fontsize=28:box=1:boxcolor=black@0.28:boxborderw=8:x=w-tw-24:y=h-th-24";

  await runFfmpeg([
    "-y",
    "-i",
    inputFile,
    "-vf",
    filter,
    "-c:a",
    "copy",
    outputFile,
  ]);

  return outputFile;
}

function estimateCredits({
  duration,
  resolution,
}) {
  const seconds =
    normalizeDuration(
      duration
    );

  const providerCost =
    String(
      resolution ||
        "480p"
    ).includes("720")
      ? PROVIDER_COST_720P_USD
      : PROVIDER_COST_480P_USD;

  const fiveSecondUnits =
    Math.max(
      1,
      Math.ceil(
        seconds / 5
      )
    );

  const costUSD =
    fiveSecondUnits *
    providerCost;

  const customerUSD =
    costUSD /
    Math.max(
      0.01,
      1 -
        TARGET_MARGIN
    );

  return Math.max(
    1,
    Math.ceil(
      customerUSD *
        100
    )
  );
}

app.post(
  "/api/generate",
  requireUser,
  async (req, res) => {
    const prompt =
      cleanText(
        req.body.prompt,
        5000
      );

    const duration =
      normalizeDuration(
        req.body.duration
      );

    const ratio =
      normalizeRatio(
        req.body.ratio
      );

    const imageUrl =
      cleanText(
        req.body.imageUrl,
        5000
      );

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        message:
          "Please enter a prompt.",
      });
    }

    const requiredCredits =
      estimateCredits({
        duration,
        resolution:
          req.body.resolution ||
          "480p",
      });

    const debit =
      await deductCredits(
        req.user.id,
        requiredCredits,
        {
          type:
            "generation_start",
          prompt:
            prompt.slice(
              0,
              200
            ),
        }
      );

    if (!debit.ok) {
      return res.status(402).json({
        ok: false,
        error:
          "INSUFFICIENT_CREDITS",
        message:
          "You do not have enough MAMAKI credits for this generation.",
        credits:
          debit.balance,
        requiredCredits,
      });
    }

    const jobId =
      randomUUID();

    jobs.set(
      jobId,
      {
        id: jobId,
        userId:
          req.user.id,
        status:
          "queued",
        createdAt:
          Date.now(),
        prompt,
        duration,
        ratio,
        requiredCredits,
      }
    );

    res.json({
      ok: true,
      jobId,
      status:
        "queued",
      credits:
        debit.balance,
      requiredCredits,
    });

    (async () => {
      const job =
        jobs.get(jobId);

      try {
        job.status =
          "generating";
        jobs.set(
          jobId,
          job
        );

        const sceneFiles =
          [];

        const sceneCount =
          Math.max(
            1,
            Math.ceil(
              duration / 5
            )
          );

        for (
          let i = 0;
          i < sceneCount;
          i++
        ) {
          const scene =
            await generateScene({
              prompt,
              ratio,
              imageUrl:
                i === 0
                  ? imageUrl
                  : "",
              userId:
                req.user.id,
            });

          sceneFiles.push(
            scene
          );

          job.progress =
            Math.round(
              ((i + 1) /
                sceneCount) *
                85
            );

          jobs.set(
            jobId,
            job
          );
        }

        const combined =
          path.join(
            OUTPUTS,
            `${jobId}-combined.mp4`
          );

        await concatVideos(
          sceneFiles,
          combined
        );

        const watermarked =
          path.join(
            OUTPUTS,
            `${jobId}.mp4`
          );

        await applyWatermark(
          combined,
          watermarked
        );

        job.status =
          "completed";
        job.progress = 100;
        job.outputUrl =
          `/outputs/${path.basename(
            watermarked
          )}`;
        job.completedAt =
          Date.now();

        jobs.set(
          jobId,
          job
        );
      } catch (error) {
        await refundCredits(
          req.user.id,
          requiredCredits,
          {
            type:
              "generation_refund",
            jobId,
            reason:
              String(
                error?.message ||
                  error
              ).slice(
                0,
                500
              ),
          }
        );

        await recordError(
          error,
          {
            route:
              "/api/generate",
            jobId,
            userId:
              req.user.id,
          }
        );

        const classified =
          classifyReplicateError(
            error
          );

        job.status =
          "failed";
        job.error =
          classified.message;
        job.errorCode =
          classified.code;
        job.failedAt =
          Date.now();

        jobs.set(
          jobId,
          job
        );
      }
    })();
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

    if (
      !job ||
      job.userId !==
        req.user.id
    ) {
      return res.status(404).json({
        ok: false,
        message:
          "Generation job not found.",
      });
    }

    res.json({
      ok: true,
      job,
    });
  }
);

app.post(
  "/api/studio/upload",
  requireUser,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          message:
            "Please upload a file.",
        });
      }

      const filename =
        `${randomUUID()}-${safeFileName(
          req.file.originalname
        )}`;

      const destination =
        path.join(
          TMP,
          filename
        );

      await fs.writeFile(
        destination,
        req.file.buffer
      );

      await recordUsage(
        req.user.id,
        "studio",
        0
      );

      res.json({
        ok: true,
        file:
          `/tmp/${filename}`,
        filename,
        size:
          req.file.size,
        mime:
          req.file.mimetype,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/studio/upload",
          userId:
            req.user?.id,
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Upload failed.",
      });
    }
  }
);

app.post(
  "/api/studio/photo-to-video",
  requireUser,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!replicate) {
        return res.status(503).json({
          ok: false,
          message:
            "Replicate is not configured.",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          ok: false,
          message:
            "Please upload an image.",
        });
      }

      const prompt =
        cleanText(
          req.body.prompt ||
            "Create a smooth cinematic animation from this image.",
          5000
        );

      const imagePath =
        path.join(
          TMP,
          `${randomUUID()}-${safeFileName(
            req.file.originalname,
            "image"
          )}`
        );

      await fs.writeFile(
        imagePath,
        req.file.buffer
      );

      const output =
        await runReplicateGeneration({
          prompt,
          duration: 5,
          ratio:
            normalizeRatio(
              req.body.ratio
            ),
          imageUrl:
            `file://${imagePath}`,
        });

      const destination =
        path.join(
          OUTPUTS,
          `${randomUUID()}.mp4`
        );

      await downloadReplicateOutput(
        output,
        destination
      );

      await recordUsage(
        req.user.id,
        "studio",
        5
      );

      res.json({
        ok: true,
        url:
          `/outputs/${path.basename(
            destination
          )}`,
      });

      await fs.rm(
        imagePath,
        {
          force: true,
        }
      );
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/studio/photo-to-video",
          userId:
            req.user?.id,
        }
      );

      res.status(500).json({
        ok: false,
        message:
          error.message ||
          "Photo-to-video failed.",
      });
    }
  }
);

app.post(
  "/api/studio/trim",
  requireUser,
  async (req, res) => {
    try {
      const input =
        cleanText(
          req.body.input,
          1000
        );

      const start =
        Math.max(
          0,
          Number(
            req.body.start || 0
          )
        );

      const duration =
        Math.max(
          0.1,
          Number(
            req.body.duration ||
              5
          )
        );

      if (!input) {
        return res.status(400).json({
          ok: false,
          message:
            "Input video is required.",
        });
      }

      const source =
        path.join(
          ROOT,
          input.replace(
            /^\/+/,
            ""
          )
        );

      const output =
        path.join(
          OUTPUTS,
          `${randomUUID()}-trim.mp4`
        );

      await runFfmpeg([
        "-y",
        "-ss",
        String(start),
        "-i",
        source,
        "-t",
        String(duration),
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        output,
      ]);

      await recordUsage(
        req.user.id,
        "studio",
        duration
      );

      res.json({
        ok: true,
        url:
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
          userId:
            req.user?.id,
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Video trimming failed.",
      });
    }
  }
);

app.post(
  "/api/studio/combine",
  requireUser,
  async (req, res) => {
    try {
      const files =
        Array.isArray(
          req.body.files
        )
          ? req.body.files
          : [];

      if (!files.length) {
        return res.status(400).json({
          ok: false,
          message:
            "At least one video is required.",
        });
      }

      const absoluteFiles =
        files.map(
          (file) =>
            path.join(
              ROOT,
              String(
                file
              ).replace(
                /^\/+/,
                ""
              )
            )
        );

      const output =
        path.join(
          OUTPUTS,
          `${randomUUID()}-combined.mp4`
        );

      await concatVideos(
        absoluteFiles,
        output
      );

      await recordUsage(
        req.user.id,
        "studio",
        0
      );

      res.json({
        ok: true,
        url:
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
          userId:
            req.user?.id,
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Video combining failed.",
      });
    }
  }
);

app.post(
  "/api/narration",
  requireUser,
  async (req, res) => {
    try {
      const text =
        cleanText(
          req.body.text,
          20000
        );

      if (!text) {
        return res.status(400).json({
          ok: false,
          message:
            "Narration text is required.",
        });
      }

      const voice =
        cleanText(
          req.body.voice ||
            "en-US-AriaNeural",
          150
        );

      const output =
        path.join(
          OUTPUTS,
          `${randomUUID()}.mp3`
        );

      const tts =
        new EdgeTTS(
          text,
          voice
        );

      await tts.save(
        output
      );

      await recordUsage(
        req.user.id,
        "narration",
        0
      );

      res.json({
        ok: true,
        url:
          `/outputs/${path.basename(
            output
          )}`,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/narration",
          userId:
            req.user?.id,
        }
      );

      res.status(500).json({
        ok: false,
        message:
          error.message ||
          "Narration failed.",
      });
    }
  }
);

app.get(
  "/api/projects",
  requireUser,
  async (req, res) => {
    try {
      const userDir =
        path.join(
          PROJECTS,
          req.user.id
        );

      await fs.mkdir(
        userDir,
        {
          recursive: true,
        }
      );

      const entries =
        await fs.readdir(
          userDir,
          {
            withFileTypes: true,
          }
        );

      const projects =
        [];

      for (
        const entry of entries
      ) {
        if (
          !entry.isFile() ||
          !entry.name.endsWith(
            ".json"
          )
        ) {
          continue;
        }

        const file =
          path.join(
            userDir,
            entry.name
          );

        const data =
          await readJson(
            file,
            null
          );

        if (data) {
          projects.push(
            data
          );
        }
      }

      projects.sort(
        (a, b) =>
          Number(
            b.updatedAt ||
              b.createdAt ||
              0
          ) -
          Number(
            a.updatedAt ||
              a.createdAt ||
              0
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
          userId:
            req.user?.id,
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Unable to load projects.",
      });
    }
  }
);

app.post(
  "/api/projects",
  requireUser,
  async (req, res) => {
    try {
      const userDir =
        path.join(
          PROJECTS,
          req.user.id
        );

      await fs.mkdir(
        userDir,
        {
          recursive: true,
        }
      );

      const project = {
        id:
          randomUUID(),
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
          Date.now(),
        updatedAt:
          Date.now(),
      };

      const file =
        path.join(
          userDir,
          `${project.id}.json`
        );

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
            "/api/projects",
          userId:
            req.user?.id,
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Unable to save project.",
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
          req.user.id,
          `${id}.json`
        );

      const project =
        await readJson(
          file,
          null
        );

      if (!project) {
        return res.status(404).json({
          ok: false,
          message:
            "Project not found.",
        });
      }

      project.name =
        cleanText(
          req.body.name ||
            project.name ||
            "Untitled Project",
          200
        );

      if (
        req.body.data !==
        undefined
      ) {
        project.data =
          req.body.data;
      }

      project.updatedAt =
        Date.now();

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
          userId:
            req.user?.id,
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Unable to update project.",
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

      const file =
        path.join(
          PROJECTS,
          req.user.id,
          `${id}.json`
        );

      await fs.rm(
        file,
        {
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
          userId:
            req.user?.id,
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Unable to delete project.",
      });
    }
  }
);

app.get(
  "/api/admin/dashboard",
  requireAdmin,
  async (req, res) => {
    try {
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

      const payments =
        await readJson(
          PAYMENTS_FILE,
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

      const list =
        Object.values(
          users
        );

      const today =
        new Date();

      today.setHours(
        0,
        0,
        0,
        0
      );

      const newToday =
        list.filter(
          (user) =>
            Number(
              user.createdAt ||
                0
            ) >=
            today.getTime()
        ).length;

      const revenue =
        Object.values(
          payments
        )
          .filter(
            (payment) =>
              payment.status ===
              "success"
          )
          .reduce(
            (sum, payment) =>
              sum +
              Number(
                payment.amountNGN ||
                  0
              ),
            0
          );

      const totalCredits =
        Object.values(
          credits
        ).reduce(
          (sum, item) =>
            sum +
            Number(
              item.balance ||
                0
            ),
          0
        );

      const aiGenerations =
        Object.values(
          usage
        ).reduce(
          (sum, item) =>
            sum +
            Number(
              item.aiGenerations ||
                0
            ),
          0
        );

      const narrationJobs =
        Object.values(
          usage
        ).reduce(
          (sum, item) =>
            sum +
            Number(
              item.narrationJobs ||
                0
            ),
          0
        );

      const projects =
        Object.values(
          usage
        ).reduce(
          (sum, item) =>
            sum +
            Number(
              item.studioJobs ||
                0
            ),
          0
        );

      res.json({
        ok: true,
        version:
          VERSION,
        users: {
          total:
            list.length,
          active:
            list.filter(
              (u) =>
                !u.disabled
            ).length,
          newToday,
          admins:
            list.filter(
              (u) =>
                u.role ===
                "admin"
            ).length,
        },
        videos:
          aiGenerations,
        narrations:
          narrationJobs,
        projects,
        credits: {
          remaining:
            totalCredits,
        },
        finance: {
          revenueNGN:
            revenue,
          profitNGN:
            Number(
              finance.profitNGN ||
                0
            ),
        },
        paystackConfigured:
          Boolean(
            PAYSTACK_SECRET_KEY &&
              PAYSTACK_PUBLIC_KEY
          ),
        recoveryConfigured:
          Boolean(
            RESEND_API_KEY &&
              RESEND_FROM
          ),
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/dashboard",
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Unable to load admin dashboard.",
      });
    }
  }
);

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

      const credits =
        await readJson(
          CREDITS_FILE,
          {}
        );

      const usage =
        await readJson(
          USAGE_FILE,
          {}
        );

      const result =
        Object.values(
          users
        ).map(
          (user) => ({
            ...publicUser(
              user
            ),
            credits:
              Number(
                credits[
                  user.id
                ]?.balance ||
                  0
              ),
            usage:
              usage[
                user.id
              ] || null,
          })
        );

      res.json({
        ok: true,
        users: result,
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
        message:
          "Unable to load users.",
      });
    }
  }
);

app.post(
  "/api/admin/users/:id/credits",
  requireAdmin,
  async (req, res) => {
    try {
      const userId =
        cleanText(
          req.params.id,
          100
        );

      const amount =
        Math.floor(
          Number(
            req.body.amount
          ) || 0
        );

      if (
        !amount
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "A non-zero credit amount is required.",
        });
      }

      const balance =
        amount > 0
          ? await addCredits(
              userId,
              amount,
              {
                type:
                  "admin_adjustment",
                adminId:
                  req.user.id,
              }
            )
          : await setUserCredits(
              userId,
              Math.max(
                0,
                (
                  await getUserCredits(
                    userId
                  )
                ) +
                  amount
              ),
              {
                type:
                  "admin_adjustment",
                adminId:
                  req.user.id,
                amount,
              }
            );

      res.json({
        ok: true,
        credits:
          balance,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/users/credits",
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Unable to adjust credits.",
      });
    }
  }
);

app.post(
  "/api/admin/users/:id/disable",
  requireAdmin,
  async (req, res) => {
    try {
      const userId =
        cleanText(
          req.params.id,
          100
        );

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      const user =
        users[userId];

      if (!user) {
        return res.status(404).json({
          ok: false,
          message:
            "User not found.",
        });
      }

      if (
        user.id ===
        req.user.id
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "You cannot disable your own administrator account.",
        });
      }

      user.disabled =
        true;
      user.updatedAt =
        Date.now();

      users[userId] =
        user;

      await writeJson(
        USERS_FILE,
        users
      );

      await invalidateUserSessions(
        userId
      );

      res.json({
        ok: true,
        user:
          publicUser(
            user
          ),
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/users/disable",
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Unable to disable user.",
      });
    }
  }
);

app.post(
  "/api/admin/users/:id/enable",
  requireAdmin,
  async (req, res) => {
    try {
      const userId =
        cleanText(
          req.params.id,
          100
        );

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      const user =
        users[userId];

      if (!user) {
        return res.status(404).json({
          ok: false,
          message:
            "User not found.",
        });
      }

      user.disabled =
        false;
      user.updatedAt =
        Date.now();

      users[userId] =
        user;

      await writeJson(
        USERS_FILE,
        users
      );

      res.json({
        ok: true,
        user:
          publicUser(
            user
          ),
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/users/enable",
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Unable to enable user.",
      });
    }
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

    const list =
      Object.values(
        errors
      ).sort(
        (a, b) =>
          Number(
            b.createdAt || 0
          ) -
          Number(
            a.createdAt || 0
          )
      );

    res.json({
      ok: true,
      errors:
        list.slice(0, 200),
    });
  }
);

app.get(
  "/api/admin/payments",
  requireAdmin,
  async (req, res) => {
    const payments =
      await readJson(
        PAYMENTS_FILE,
        {}
      );

    res.json({
      ok: true,
      payments:
        Object.values(
          payments
        ).sort(
          (a, b) =>
            Number(
              b.createdAt || 0
            ) -
            Number(
              a.createdAt || 0
            )
        ),
    });
  }
);

app.get(
  "/api/admin/finance",
  requireAdmin,
  async (req, res) => {
    const finance =
      await readJson(
        FINANCE_FILE,
        {}
      );

    res.json({
      ok: true,
      finance:
        Object.values(
          finance
        ).sort(
          (a, b) =>
            Number(
              b.createdAt || 0
            ) -
            Number(
              a.createdAt || 0
            )
        ),
    });
  }
);

app.get(
  "/api/admin/pricing",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      pricing:
        await getPricing(),
    });
  }
);

app.post(
  "/api/admin/pricing",
  requireAdmin,
  async (req, res) => {
    try {
      const incoming =
        req.body || {};

      const current =
        await getPricing();

      const packages =
        Array.isArray(
          incoming.packages
        )
          ? incoming.packages
          : current.packages;

      const normalized =
        packages
          .map(
            (pkg) => ({
              id:
                cleanText(
                  pkg.id,
                  100
                ),
              name:
                cleanText(
                  pkg.name,
                  100
                ),
              credits:
                Math.max(
                  1,
                  Math.floor(
                    Number(
                      pkg.credits
                    ) || 0
                  )
                ),
              priceNGN:
                Math.max(
                  1,
                  Math.floor(
                    Number(
                      pkg.priceNGN
                    ) || 0
                  )
                ),
            })
          )
          .filter(
            (pkg) =>
              pkg.id &&
              pkg.credits &&
              pkg.priceNGN
          );

      const pricing = {
        ...current,
        ...incoming,
        currency:
          PAYSTACK_CURRENCY_DEFAULT,
        packages:
          normalized,
        updatedAt:
          Date.now(),
      };

      await writeJson(
        PRICING_FILE,
        pricing
      );

      res.json({
        ok: true,
        pricing,
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
        message:
          "Unable to update pricing.",
      });
    }
  }
);

app.get(
  "/api/admin/withdrawals",
  requireAdmin,
  async (req, res) => {
    const withdrawals =
      await readJson(
        WITHDRAWALS_FILE,
        {}
      );

    res.json({
      ok: true,
      withdrawals:
        Object.values(
          withdrawals
        ).sort(
          (a, b) =>
            Number(
              b.createdAt || 0
            ) -
            Number(
              a.createdAt || 0
            )
        ),
    });
  }
);

app.post(
  "/api/admin/withdrawals",
  requireAdmin,
  async (req, res) => {
    try {
      const amount =
        Math.floor(
          Number(
            req.body.amountNGN
          ) || 0
        );

      if (
        amount <= 0
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "Withdrawal amount must be greater than zero.",
        });
      }

      const withdrawals =
        await readJson(
          WITHDRAWALS_FILE,
          {}
        );

      const id =
        randomUUID();

      withdrawals[id] = {
        id,
        amountNGN:
          amount,
        status:
          "requested",
        note:
          cleanText(
            req.body.note,
            500
          ),
        createdAt:
          Date.now(),
        createdBy:
          req.user.id,
      };

      await writeJson(
        WITHDRAWALS_FILE,
        withdrawals
      );

      res.json({
        ok: true,
        withdrawal:
          withdrawals[id],
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/withdrawals",
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Unable to create withdrawal request.",
      });
    }
  }
);

app.use(
  "/outputs",
  express.static(
    OUTPUTS,
    {
      maxAge:
        "1h",
    }
  )
);

app.use(
  "/tmp",
  express.static(
    TMP,
    {
      maxAge:
        "10m",
    }
  )
);

const PUBLIC_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="theme-color" content="#050509">
<meta name="description" content="MAMAKI AI — Intelligent AI Video Creative Studio">
<title>MAMAKI AI — Intelligent AI Video Creative Studio</title>
<style>
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
 margin:0;
 background:#050509;
 color:#fff;
 font-family:Inter,Arial,sans-serif;
 min-height:100vh;
}
button,input,textarea,select{font:inherit}
button{cursor:pointer}
a{color:inherit;text-decoration:none}
.container{width:min(1200px,92%);margin:auto}
header{
 position:sticky;
 top:0;
 z-index:50;
 backdrop-filter:blur(20px);
 background:rgba(5,5,9,.86);
 border-bottom:1px solid #20202b;
}
.nav{
 min-height:70px;
 display:flex;
 align-items:center;
 justify-content:space-between;
 gap:18px;
}
.logo{
 font-size:22px;
 font-weight:900;
 letter-spacing:1px;
}
.logo span{color:#9b7cff}
.navlinks{
 display:flex;
 gap:8px;
 flex-wrap:wrap;
}
.navlinks button,.navbtn{
 background:transparent;
 border:1px solid transparent;
 color:#cfcfe2;
 padding:10px 13px;
 border-radius:10px;
}
.navlinks button:hover,.navbtn:hover{
 background:#11111a;
 border-color:#29293a;
 color:#fff;
}
.primary{
 background:linear-gradient(135deg,#7657ff,#a16cff);
 border:0;
 color:#fff;
 padding:11px 16px;
 border-radius:11px;
 font-weight:800;
}
.secondary{
 background:#11111a;
 border:1px solid #2b2b3b;
 color:#fff;
 padding:11px 16px;
 border-radius:11px;
 font-weight:700;
}
.hero{
 padding:70px 0 35px;
}
.heroGrid{
 display:grid;
 grid-template-columns:1.5fr .8fr;
 gap:28px;
 align-items:start;
}
.badge{
 display:inline-flex;
 padding:7px 11px;
 border:1px solid #29293b;
 border-radius:999px;
 color:#a993ff;
 background:#0d0d15;
 font-size:13px;
}
h1{
 font-size:clamp(40px,7vw,78px);
 line-height:.98;
 margin:18px 0;
 letter-spacing:-3px;
}
.gradient{
 background:linear-gradient(90deg,#fff,#a991ff);
 -webkit-background-clip:text;
 background-clip:text;
 color:transparent;
}
.hero p{
 color:#a7a7ba;
 font-size:18px;
 line-height:1.7;
 max-width:700px;
}
.card{
 background:linear-gradient(180deg,#101019,#0b0b11);
 border:1px solid #242432;
 border-radius:20px;
 padding:20px;
 box-shadow:0 20px 60px rgba(0,0,0,.25);
}
.studio{
 margin:25px 0 70px;
}
.grid{
 display:grid;
 grid-template-columns:1.5fr .8fr;
 gap:20px;
}
.field{margin-bottom:18px}
label{
 display:block;
 color:#aaaabc;
 font-size:13px;
 margin-bottom:8px;
 font-weight:700;
}
textarea,input,select{
 width:100%;
 color:#fff;
 background:#07070d;
 border:1px solid #292936;
 border-radius:12px;
 padding:13px;
 outline:none;
}
textarea{min-height:170px;resize:vertical}
textarea:focus,input:focus,select:focus{
 border-color:#8064ff;
}
.row{
 display:grid;
 grid-template-columns:repeat(3,1fr);
 gap:12px;
}
.styles{
 display:flex;
 gap:8px;
 flex-wrap:wrap;
}
.style{
 padding:9px 12px;
 border-radius:10px;
 background:#0b0b12;
 color:#bbb;
 border:1px solid #272733;
}
.style.active{
 color:#fff;
 border-color:#8165ff;
 background:#161329;
}
.actions{
 display:flex;
 gap:10px;
 flex-wrap:wrap;
 margin-top:18px;
}
.progress{
 height:9px;
 background:#171720;
 border-radius:20px;
 overflow:hidden;
 margin-top:15px;
}
.progress div{
 height:100%;
 width:0%;
 background:linear-gradient(90deg,#7457ff,#bb85ff);
 transition:.3s;
}
.status{
 color:#a7a7b8;
 margin-top:10px;
 font-size:14px;
 line-height:1.5;
}
.video{
 width:100%;
 max-height:500px;
 background:#000;
 border-radius:15px;
 margin-top:15px;
}
.section{
 padding:35px 0;
}
.section h2{font-size:34px}
.features{
 display:grid;
 grid-template-columns:repeat(3,1fr);
 gap:15px;
}
.feature{
 background:#0c0c13;
 border:1px solid #222230;
 padding:20px;
 border-radius:16px;
}
.feature h3{margin-top:0}
.feature p{
 color:#9696a8;
 line-height:1.6;
}
.modal{
 position:fixed;
 inset:0;
 z-index:100;
 background:rgba(0,0,0,.76);
 display:none;
 align-items:center;
 justify-content:center;
 padding:20px;
}
.modal.open{display:flex}
.modalBox{
 width:min(560px,100%);
 max-height:90vh;
 overflow:auto;
 background:#0d0d15;
 border:1px solid #2a2a38;
 border-radius:20px;
 padding:22px;
}
.modalHead{
 display:flex;
 align-items:center;
 justify-content:space-between;
 gap:12px;
}
.close{
 width:38px;
 height:38px;
 border-radius:10px;
 background:#171720;
 border:1px solid #2a2a38;
 color:#fff;
}
.packageGrid{
 display:grid;
 grid-template-columns:repeat(2,1fr);
 gap:12px;
}
.package{
 padding:18px;
 border:1px solid #2b2b3a;
 background:#101019;
 border-radius:16px;
}
.package h3{margin:0 0 8px}
.package .price{
 font-size:24px;
 font-weight:900;
 margin:12px 0;
}
.authTabs{
 display:flex;
 gap:8px;
 margin-bottom:18px;
}
.authTab{
 flex:1;
 padding:10px;
 background:#11111a;
 border:1px solid #2a2a37;
 color:#aaa;
 border-radius:10px;
}
.authTab.active{
 background:#17132a;
 border-color:#7e61ff;
 color:#fff;
}
.small{
 color:#88899a;
 font-size:12px;
 line-height:1.5;
}
.notice{
 background:#11111a;
 border:1px solid #2b2b3a;
 padding:12px;
 border-radius:12px;
 margin:10px 0;
 color:#c6c6d5;
}
.toast{
 position:fixed;
 right:18px;
 bottom:18px;
 z-index:300;
 max-width:360px;
 background:#12121b;
 border:1px solid #343447;
 border-radius:13px;
 padding:14px 16px;
 display:none;
 box-shadow:0 15px 40px rgba(0,0,0,.35);
}
.toast.show{display:block}
footer{
 border-top:1px solid #20202b;
 padding:30px 0;
 color:#777789;
}
@media(max-width:800px){
 .heroGrid,.grid{grid-template-columns:1fr}
 .features{grid-template-columns:1fr}
 .row{grid-template-columns:1fr}
 .navlinks{display:none}
 h1{letter-spacing:-2px}
 .packageGrid{grid-template-columns:1fr}
}
</style>
</head>
<body>

<header>
<div class="container nav">
<div class="logo">MAMAKI <span>AI</span></div>
<div class="navlinks">
<button onclick="scrollToId('studio')">Studio</button>
<button onclick="scrollToId('projects')">Projects</button>
<button onclick="scrollToId('free')">Free Studio</button>
<button onclick="scrollToId('features')">Features</button>
</div>
<div class="actions" style="margin:0">
<button class="secondary" id="creditNav" onclick="openCredits()">🪙 Buy MAMAKI Credits</button>
<button class="primary" id="authButton" onclick="openAuth()">Login</button>
</div>
</div>
</header>

<main>
<section class="hero">
<div class="container heroGrid">
<div>
<div class="badge">AI VIDEO CREATIVE STUDIO</div>
<h1>Create <span class="gradient">cinematic AI videos</span> from your ideas.</h1>
<p>MAMAKI AI turns prompts and images into videos, narration and creative projects from one simple studio.</p>
<div class="actions">
<button class="primary" onclick="scrollToId('studio')">Start Creating</button>
<button class="secondary" onclick="openCredits()">🪙 Buy MAMAKI Credits</button>
</div>
</div>
<div class="card">
<h3>AI Director</h3>
<p class="small">Create scenes, choose a visual style, control duration and export your result.</p>
<div class="notice">MAMAKI watermark protects generated videos.</div>
<div id="accountCard">Not logged in.</div>
</div>
</div>
</section>

<section class="studio" id="studio">
<div class="container grid">
<div class="card">
<h2>AI Studio</h2>
<div class="field">
<label>Describe your video</label>
<textarea id="prompt" placeholder="Example: A cinematic aerial shot of a futuristic African city at sunset, realistic lighting, smooth camera movement..."></textarea>
</div>

<div class="field">
<label>Visual style</label>
<div class="styles" id="styles">
<button class="style active" data-style="Cinematic">Cinematic</button>
<button class="style" data-style="Realistic">Realistic</button>
<button class="style" data-style="Documentary">Documentary</button>
<button class="style" data-style="Commercial">Commercial</button>
<button class="style" data-style="3D">3D</button>
<button class="style" data-style="Anime">Anime</button>
<button class="style" data-style="Fantasy">Fantasy</button>
<button class="style" data-style="Sci-Fi">Sci-Fi</button>
<button class="style" data-style="Horror">Horror</button>
<button class="style" data-style="Cartoon">Cartoon</button>
</div>
</div>

<div class="row">
<div class="field">
<label>Duration</label>
<select id="duration">
<option value="5">5s</option>
<option value="10">10s</option>
<option value="15">15s</option>
<option value="20">20s</option>
<option value="30">30s</option>
<option value="60">1m</option>
<option value="120">2m</option>
<option value="300">5m</option>
<option value="600">10m</option>
<option value="1800">30m</option>
<option value="3600">1h</option>
<option value="7200">2h</option>
</select>
</div>
<div class="field">
<label>Aspect ratio</label>
<select id="ratio">
<option value="16:9">16:9</option>
<option value="9:16">9:16</option>
<option value="1:1">1:1</option>
</select>
</div>
<div class="field">
<label>Image URL optional</label>
<input id="imageUrl" placeholder="https://...">
</div>
</div>

<div class="actions">
<button class="primary" id="generateBtn" onclick="generateVideo()">Generate Video</button>
<button class="secondary" onclick="openCredits()">🪙 Buy Credits</button>
</div>

<div class="progress"><div id="progressBar"></div></div>
<div class="status" id="status">Log in to begin generating.</div>
<div id="result"></div>
</div>

<div class="card">
<h3>Your MAMAKI Account</h3>
<div id="creditsBox" class="notice">Credits: —</div>
<button class="primary" style="width:100%" onclick="openCredits()">🪙 Buy MAMAKI Credits</button>
<button class="secondary" style="width:100%;margin-top:10px" onclick="openAuth()">Login / Account</button>
<div class="notice">
<p class="small">Long videos are assembled from generated scenes.</p>
<p class="small">Every generated video carries the MAMAKI AI watermark.</p>
</div>
</div>
</div>
</section>

<section class="section" id="projects">
<div class="container">
<h2>Projects</h2>
<div class="card">
<p class="small">Your saved MAMAKI projects appear here when you are logged in.</p>
<div id="projectsList">Log in to view your projects.</div>
</div>
</div>
</section>

<section class="section" id="free">
<div class="container">
<h2>Free Studio</h2>
<div class="features">
<div class="feature">
<h3>Photo → Video</h3>
<p>Animate an image into a short AI video.</p>
<button class="secondary" onclick="document.getElementById('photoInput').click()">Choose Image</button>
<input id="photoInput" type="file" accept="image/*" hidden onchange="photoToVideo()">
</div>
<div class="feature">
<h3>Trim</h3>
<p>Trim generated videos with FFmpeg.</p>
<button class="secondary" onclick="alert('Use the generated video tools after login.')">Open Tool</button>
</div>
<div class="feature">
<h3>Combine</h3>
<p>Combine video scenes into one export.</p>
<button class="secondary" onclick="alert('Generate or upload videos first.')">Open Tool</button>
</div>
</div>
</div>
</section>

<section class="section" id="features">
<div class="container">
<h2>Features</h2>
<div class="features">
<div class="feature"><h3>Text → Video</h3><p>Turn descriptions into AI video scenes.</p></div>
<div class="feature"><h3>Image → Video</h3><p>Bring still images to life with AI motion.</p></div>
<div class="feature"><h3>AI Narration</h3><p>Create natural voice narration.</p></div>
<div class="feature"><h3>Projects</h3><p>Save and manage your creative projects.</p></div>
<div class="feature"><h3>Paystack Credits</h3><p>Purchase MAMAKI credits securely through Paystack.</p></div>
<div class="feature"><h3>Password Recovery</h3><p>Recover your account when email recovery is configured.</p></div>
</div>
</div>
</section>
</main>

<footer>
<div class="container">© ${new Date().getFullYear()} MAMAKI AI — Intelligent AI Video Creative Studio</div>
</footer>

<div class="modal" id="authModal">
<div class="modalBox">
<div class="modalHead">
<h2 id="authTitle">MAMAKI Login</h2>
<button class="close" onclick="closeModal('authModal')">×</button>
</div>

<div class="authTabs">
<button class="authTab active" id="loginTab" onclick="setAuthMode('login')">Login</button>
<button class="authTab" id="registerTab" onclick="setAuthMode('register')">Create Account</button>
</div>

<div id="registerNameWrap" class="field" style="display:none">
<label>Name</label>
<input id="authName" placeholder="Your name">
</div>

<div class="field">
<label>Email</label>
<input id="authEmail" type="email" placeholder="you@example.com">
</div>

<div class="field">
<label>Password</label>
<input id="authPassword" type="password" placeholder="Password">
</div>

<div id="forgotWrap">
<button class="secondary" onclick="showRecovery()" style="width:100%;margin-bottom:10px">Forgot password?</button>
</div>

<button class="primary" onclick="submitAuth()" id="authSubmit" style="width:100%">Login</button>
<div class="status" id="authStatus"></div>
</div>
</div>

<div class="modal" id="recoveryModal">
<div class="modalBox">
<div class="modalHead">
<h2>Password Recovery</h2>
<button class="close" onclick="closeModal('recoveryModal')">×</button>
</div>
<p class="small">Enter your account email. If recovery email is configured, MAMAKI will send a secure reset link.</p>
<div class="field">
<label>Email</label>
<input id="recoveryEmail" type="email" placeholder="you@example.com">
</div>
<button class="primary" onclick="requestRecovery()" style="width:100%">Send Recovery Link</button>
<div class="status" id="recoveryStatus"></div>
</div>
</div>

<div class="modal" id="resetModal">
<div class="modalBox">
<div class="modalHead">
<h2>Reset Password</h2>
<button class="close" onclick="closeModal('resetModal')">×</button>
</div>
<div class="field">
<label>New password</label>
<input id="resetPassword" type="password" placeholder="At least 6 characters">
</div>
<button class="primary" onclick="resetPassword()" style="width:100%">Reset Password</button>
<div class="status" id="resetStatus"></div>
</div>
</div>

<div class="modal" id="creditsModal">
<div class="modalBox">
<div class="modalHead">
<h2>🪙 Buy MAMAKI Credits</h2>
<button class="close" onclick="closeModal('creditsModal')">×</button>
</div>
<p class="small">Choose a credit package. You will be redirected to Paystack to complete payment.</p>
<div class="packageGrid" id="packages">Loading packages...</div>
<div class="status" id="paymentStatus"></div>
</div>
</div>

<div class="toast" id="toast"></div>

<script>
let token = localStorage.getItem("mamaki_token") || "";
let currentUser = null;
let authMode = "login";
let selectedStyle = "Cinematic";
let polling = null;

function scrollToId(id){
 const el=document.getElementById(id);
 if(el) el.scrollIntoView({behavior:"smooth"});
}

function showToast(message){
 const el=document.getElementById("toast");
 el.textContent=message;
 el.classList.add("show");
 setTimeout(()=>el.classList.remove("show"),4000);
}

function openModal(id){
 document.getElementById(id).classList.add("open");
}

function closeModal(id){
 document.getElementById(id).classList.remove("open");
}

function openAuth(){
 openModal("authModal");
}

function openCredits(){
 if(!token){
   openAuth();
   showToast("Please log in or create an account before buying credits.");
   return;
 }
 openModal("creditsModal");
 loadPricing();
}

function setAuthMode(mode){
 authMode=mode;
 document.getElementById("loginTab").classList.toggle("active",mode==="login");
 document.getElementById("registerTab").classList.toggle("active",mode==="register");
 document.getElementById("registerNameWrap").style.display=mode==="register"?"block":"none";
 document.getElementById("authTitle").textContent=mode==="register"?"Create MAMAKI Account":"MAMAKI Login";
 document.getElementById("authSubmit").textContent=mode==="register"?"Create Account":"Login";
 document.getElementById("forgotWrap").style.display=mode==="register"?"none":"block";
 document.getElementById("authStatus").textContent="";
}

async function api(url,options={}){
 const headers={...(options.headers||{})};
 if(token) headers.Authorization="Bearer "+token;
 if(options.body && !(options.body instanceof FormData)){
   headers["Content-Type"]="application/json";
 }
 const response=await fetch(url,{...options,headers});
 const data=await response.json().catch(()=>({}));
 if(!response.ok) throw new Error(data.message||data.error||"Request failed");
 return data;
}

async function submitAuth(){
 const email=document.getElementById("authEmail").value.trim();
 const password=document.getElementById("authPassword").value;
 const status=document.getElementById("authStatus");
 status.textContent="Please wait...";
 try{
   const data=await api(authMode==="register"?"/api/auth/register":"/api/auth/login",{
     method:"POST",
     body:JSON.stringify({
       email,
       password,
       name:document.getElementById("authName").value.trim()
     })
   });
   token=data.token;
   localStorage.setItem("mamaki_token",token);
   currentUser=data.user;
   closeModal("authModal");
   updateAccountUI(data);
   loadProjects();
   showToast("Login successful.");
 }catch(error){
   status.textContent=error.message;
 }
}

async function refreshMe(){
 try{
   const data=await api("/api/auth/me");
   if(data.authenticated){
     currentUser=data.user;
     updateAccountUI(data);
     loadProjects();
   }else{
     currentUser=null;
     updateAccountUI(null);
   }
 }catch{
   currentUser=null;
   updateAccountUI(null);
 }
}

function updateAccountUI(data){
 const button=document.getElementById("authButton");
 const card=document.getElementById("accountCard");
 const credits=document.getElementById("creditsBox");

 if(currentUser){
   button.textContent="Logout";
   button.onclick=logout;
   card.innerHTML="<strong>"+escapeHtml(currentUser.name||currentUser.email)+"</strong><br><span class='small'>"+escapeHtml(currentUser.email)+"</span><br><span class='small'>Role: "+escapeHtml(currentUser.role||"user")+"</span>";
   credits.textContent="Credits: "+Number(data?.credits??0);
 }else{
   button.textContent="Login";
   button.onclick=openAuth;
   card.textContent="Not logged in.";
   credits.textContent="Credits: —";
 }
}

async function logout(){
 try{
   await api("/api/auth/logout",{method:"POST"});
 }catch{}
 token="";
 currentUser=null;
 localStorage.removeItem("mamaki_token");
 updateAccountUI(null);
 document.getElementById("projectsList").textContent="Log in to view your projects.";
 showToast("Logged out.");
}

function escapeHtml(value){
 return String(value??"").replace(/[&<>"']/g,c=>({
   "&":"&amp;",
   "<":"&lt;",
   ">":"&gt;",
   '"':"&quot;",
   "'":"&#039;"
 }[c]));
}

function showRecovery(){
 closeModal("authModal");
 document.getElementById("recoveryEmail").value=document.getElementById("authEmail").value.trim();
 openModal("recoveryModal");
}

async function requestRecovery(){
 const email=document.getElementById("recoveryEmail").value.trim();
 const status=document.getElementById("recoveryStatus");
 status.textContent="Sending...";
 try{
   const data=await fetch("/api/auth/forgot-password",{
     method:"POST",
     headers:{"Content-Type":"application/json"},
     body:JSON.stringify({email})
   }).then(async r=>{
     const d=await r.json().catch(()=>({}));
     if(!r.ok) throw new Error(d.message||d.error||"Recovery request failed.");
     return d;
   });
   status.textContent=data.message||"Recovery request sent.";
 }catch(error){
   status.textContent=error.message;
 }
}

async function resetPassword(){
 const params=new URLSearchParams(location.search);
 const tokenValue=params.get("reset")||"";
 const password=document.getElementById("resetPassword").value;
 const status=document.getElementById("resetStatus");
 status.textContent="Resetting...";
 try{
   const data=await fetch("/api/auth/reset-password",{
     method:"POST",
     headers:{"Content-Type":"application/json"},
     body:JSON.stringify({token:tokenValue,password})
   }).then(async r=>{
     const d=await r.json().catch(()=>({}));
     if(!r.ok) throw new Error(d.message||d.error||"Password reset failed.");
     return d;
   });
   status.textContent=data.message||"Password reset successfully.";
   history.replaceState({},document.title,"/");
 }catch(error){
   status.textContent=error.message;
 }
}

async function loadPricing(){
 const container=document.getElementById("packages");
 const status=document.getElementById("paymentStatus");
 container.innerHTML="Loading...";
 status.textContent="";
 try{
   const data=await fetch("/api/pricing").then(async r=>{
     const d=await r.json();
     if(!r.ok) throw new Error(d.message||"Unable to load pricing.");
     return d;
   });
   container.innerHTML="";
   (data.packages||[]).forEach(pkg=>{
     const div=document.createElement("div");
     div.className="package";
     div.innerHTML=
       "<h3>"+escapeHtml(pkg.name)+"</h3>"+
       "<div>"+Number(pkg.credits)+" MAMAKI Credits</div>"+
       "<div class='price'>₦"+Number(pkg.priceNGN).toLocaleString()+"</div>"+
       "<button class='primary' style='width:100%'>Buy Now</button>";
     div.querySelector("button").onclick=()=>buyPackage(pkg.id);
     container.appendChild(div);
   });
 }catch(error){
   container.innerHTML="<div class='notice'>"+escapeHtml(error.message)+"</div>";
 }
}

async function buyPackage(packageId){
 if(!token){
   closeModal("creditsModal");
   openAuth();
   return;
 }
 const status=document.getElementById("paymentStatus");
 status.textContent="Opening Paystack...";
 try{
   const data=await api("/api/payments/initialize",{
     method:"POST",
     body:JSON.stringify({packageId})
   });
   if(data.authorization_url){
     location.href=data.authorization_url;
   }else{
     throw new Error("Paystack did not return a payment URL.");
   }
 }catch(error){
   status.textContent=error.message;
 }
}

async function generateVideo(){
 if(!token){
   openAuth();
   showToast("Please log in before generating a video.");
   return;
 }

 const prompt=document.getElementById("prompt").value.trim();
 if(!prompt){
   showToast("Enter a video prompt first.");
   return;
 }

 const style=selectedStyle;
 const finalPrompt=prompt+"\nVisual style: "+style+".";
 const duration=document.getElementById("duration").value;
 const ratio=document.getElementById("ratio").value;
 const imageUrl=document.getElementById("imageUrl").value.trim();

 const button=document.getElementById("generateBtn");
 const status=document.getElementById("status");
 const bar=document.getElementById("progressBar");
 const result=document.getElementById("result");

 button.disabled=true;
 bar.style.width="5%";
 status.textContent="Starting generation...";
 result.innerHTML="";

 try{
   const data=await api("/api/generate",{
     method:"POST",
     body:JSON.stringify({
       prompt:finalPrompt,
       duration,
       ratio,
       imageUrl
     })
   });

   status.textContent="Generating your video...";
   pollJob(data.jobId);
 }catch(error){
   button.disabled=false;
   bar.style.width="0%";
   status.textContent=error.message;
 }
}

async function pollJob(jobId){
 clearInterval(polling);
 const button=document.getElementById("generateBtn");
 const status=document.getElementById("status");
 const bar=document.getElementById("progressBar");
 const result=document.getElementById("result");

 polling=setInterval(async()=>{
   try{
     const data=await api("/api/jobs/"+encodeURIComponent(jobId));
     const job=data.job;
     bar.style.width=(Number(job.progress||0))+"%";
     status.textContent=job.status==="generating"
       ? "Generating... "+Number(job.progress||0)+"%"
       : job.status;

     if(job.status==="completed"){
       clearInterval(polling);
       button.disabled=false;
       bar.style.width="100%";
       status.textContent="Video generation completed.";
       result.innerHTML=
         "<video class='video' controls src='"+escapeHtml(job.outputUrl)+"'></video>"+
         "<div class='actions'><a class='primary' href='"+escapeHtml(job.outputUrl)+"' download>Download Video</a></div>";
       refreshMe();
     }

     if(job.status==="failed"){
       clearInterval(polling);
       button.disabled=false;
       status.textContent=job.error||"Generation failed.";
       bar.style.width="0%";
       refreshMe();
     }
   }catch(error){
     clearInterval(polling);
     button.disabled=false;
     status.textContent=error.message;
   }
 },2000);
}

async function photoToVideo(){
 if(!token){
   openAuth();
   return;
 }

 const input=document.getElementById("photoInput");
 if(!input.files[0]) return;

 const form=new FormData();
 form.append("image",input.files[0]);
 form.append("prompt","Create a smooth cinematic animation from this image.");
 form.append("ratio",document.getElementById("ratio").value);

 const status=document.getElementById("status");
 status.textContent="Uploading image and generating video...";

 try{
   const response=await fetch("/api/studio/photo-to-video",{
     method:"POST",
     headers:token?{Authorization:"Bearer "+token}:{},
     body:form
   });
   const data=await response.json();
   if(!response.ok) throw new Error(data.message||"Photo-to-video failed.");
   document.getElementById("result").innerHTML=
     "<video class='video' controls src='"+escapeHtml(data.url)+"'></video>"+
     "<div class='actions'><a class='primary' href='"+escapeHtml(data.url)+"' download>Download Video</a></div>";
   status.textContent="Photo-to-video completed.";
 }catch(error){
   status.textContent=error.message;
 }
}

async function loadProjects(){
 if(!token) return;
 try{
   const data=await api("/api/projects");
   const list=document.getElementById("projectsList");
   if(!data.projects?.length){
     list.textContent="No saved projects yet.";
     return;
   }
   list.innerHTML=data.projects.map(project=>
     "<div class='notice'><strong>"+escapeHtml(project.name)+"</strong><br><span class='small'>Updated "+new Date(project.updatedAt||project.createdAt).toLocaleString()+"</span></div>"
   ).join("");
 }catch(error){
   document.getElementById("projectsList").textContent=error.message;
 }
}

document.querySelectorAll(".style").forEach(button=>{
 button.addEventListener("click",()=>{
   document.querySelectorAll(".style").forEach(x=>x.classList.remove("active"));
   button.classList.add("active");
   selectedStyle=button.dataset.style||"Cinematic";
 });
});

async function checkPaymentCallback(){
 const params=new URLSearchParams(location.search);
 const reference=params.get("reference");
 if(!reference || !token) return;
 try{
   const data=await api("/api/payments/verify/"+encodeURIComponent(reference));
   if(data.paid){
     showToast("Payment successful. Credits added to your account.");
     refreshMe();
   }
 }catch(error){
   showToast(error.message);
 }
}

(async()=>{
 await refreshMe();
 await checkPaymentCallback();

 const params=new URLSearchParams(location.search);
 if(params.get("reset")){
   openModal("resetModal");
 }
})();
</script>
</body>
</html>`;

app.get(
  "/",
  async (req, res) => {
    res.type("html").send(
      PUBLIC_HTML
    );
  }
);

app.use(
  async (
    err,
    req,
    res,
    next
  ) => {
    await recordError(
      err,
      {
        route:
          req.path,
        method:
          req.method,
      }
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    res.status(500).json({
      ok: false,
      message:
        "An unexpected server error occurred.",
    });
  }
);

async function cleanupOldFiles() {
  const now =
    Date.now();

  const maxAge =
    24 *
    60 *
    60 *
    1000;

  for (
    const directory of [
      TMP,
      OUTPUTS,
    ]
  ) {
    try {
      const entries =
        await fs.readdir(
          directory,
          {
            withFileTypes:
              true,
          }
        );

      for (
        const entry of entries
      ) {
        if (
          !entry.isFile()
        ) {
          continue;
        }

        const file =
          path.join(
            directory,
            entry.name
          );

        try {
          const stat =
            await fs.stat(
              file
            );

          if (
            now -
              stat.mtimeMs >
            maxAge
          ) {
            await fs.rm(
              file,
              {
                force: true,
              }
            );
          }
        } catch {}
      }
    } catch {}
  }
}

async function start() {
  await ensureStorage();
  await ensureAdminAccount();

  setInterval(
    () => {
      cleanupOldFiles().catch(
        () => {}
      );
    },
    60 *
      60 *
      1000
  ).unref();

  app.listen(
    PORT,
    HOST,
    () => {
      console.log(
        `MAMAKI AI ${VERSION} listening on ${HOST}:${PORT}`
      );
      console.log(
        `APP_URL=${APP_URL}`
      );
      console.log(
        `Replicate configured=${Boolean(
          REPLICATE_API_TOKEN
        )}`
      );
      console.log(
        `Paystack configured=${Boolean(
          PAYSTACK_SECRET_KEY &&
            PAYSTACK_PUBLIC_KEY
        )}`
      );
      console.log(
        `Recovery configured=${Boolean(
          RESEND_API_KEY &&
            RESEND_FROM
        )}`
      );
    }
  );
}

process.on(
  "unhandledRejection",
  (error) => {
    recordError(
      error,
      {
        event:
          "unhandledRejection",
      }
    ).catch(() => {});
  }
);

process.on(
  "uncaughtException",
  (error) => {
    recordError(
      error,
      {
        event:
          "uncaughtException",
      }
    ).catch(() => {});
  }
);

start().catch(
  async (error) => {
    await recordError(
      error,
      {
        event:
          "startup",
      }
    );

    console.error(
      "MAMAKI startup failed:",
      error
    );

    process.exit(1);
  }
);
