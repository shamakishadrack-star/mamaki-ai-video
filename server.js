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

const PAYSTACK_SECRET_KEY = String(
  process.env.PAYSTACK_SECRET_KEY || ""
).trim();

const PAYSTACK_PUBLIC_KEY = String(
  process.env.PAYSTACK_PUBLIC_KEY || ""
).trim();

const FX_API_URL = String(
  process.env.FX_API_URL || "https://open.er-api.com/v6/latest/USD"
).trim();

const DEFAULT_USD_NGN_RATE = Math.max(
  1,
  Number(process.env.DEFAULT_USD_NGN_RATE || 1600)
);

const TARGET_MARGIN = Math.min(
  0.90,
  Math.max(0.05, Number(process.env.MAMAKI_TARGET_MARGIN || 0.40))
);

const PAYMENT_FEE_BUFFER = Math.min(
  0.30,
  Math.max(0, Number(process.env.MAMAKI_PAYMENT_FEE_BUFFER || 0.04))
);

const FX_BUFFER = Math.min(
  0.30,
  Math.max(0, Number(process.env.MAMAKI_FX_BUFFER || 0.05))
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
  await fs.writeFile(temp, JSON.stringify(data, null, 2), "utf8");
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

      if (["m", "min", "mins"].includes(unit)) n *= 60;
      if (["h", "hr", "hrs"].includes(unit)) n *= 3600;

      return Math.max(
        MIN_DURATION,
        Math.min(MAX_DURATION, Math.round(n))
      );
    }
  }

  const n = Number(value);

  if (!Number.isFinite(n)) return MIN_DURATION;

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
  const base = path.basename(String(name || fallback));

  return base
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 150);
}

/* =========================================================
   PASSWORDS / TOKENS
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

/* =========================================================
   SESSIONS
========================================================= */

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

  if (!header.toLowerCase().startsWith("bearer ")) {
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

  if (!session) return null;

  const users = await readJson(
    USERS_FILE,
    {}
  );

  const user = users[session.userId];

  if (!user || user.disabled) {
    return null;
  }

  return {
    ...user,
    sessionRole: session.role,
  };
}

async function requireUser(req, res, next) {
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

async function requireAdmin(req, res, next) {
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
   ERROR / SECURITY LOGGING
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
    // Never allow logging to crash MAMAKI.
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
          security[a].createdAt
        ).localeCompare(
          String(
            security[b].createdAt
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

/* =========================================================
   USAGE
========================================================= */

async function ensureUsage(userId) {
  const usage = await readJson(
    USAGE_FILE,
    {}
  );

  if (!usage[userId]) {
    usage[userId] = {
      aiGenerations: 0,
      aiSeconds: 0,
      studioJobs: 0,
      narrationJobs: 0,
      updatedAt:
        new Date().toISOString(),
    };

    await writeJson(
      USAGE_FILE,
      usage
    );
  }

  return usage[userId];
}

async function recordUsage(
  userId,
  type,
  seconds = 0
) {
  const usage = await readJson(
    USAGE_FILE,
    {}
  );

  if (!usage[userId]) {
    usage[userId] = {
      aiGenerations: 0,
      aiSeconds: 0,
      studioJobs: 0,
      narrationJobs: 0,
      updatedAt:
        new Date().toISOString(),
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

  usage[userId].updatedAt =
    new Date().toISOString();

  await writeJson(
    USAGE_FILE,
    usage
  );
}

/* =========================================================
   CREDITS
========================================================= */

const STARTER_CREDITS = 100;

function creditCost(seconds) {
  return Math.max(
    10,
    Math.ceil(
      Number(seconds || 5) / 5
    ) * 10
  );
}

async function ensureCredits(userId) {
  const credits = await readJson(
    CREDITS_FILE,
    {}
  );

  if (!credits[userId]) {
    credits[userId] = {
      userId,
      freeCredits:
        STARTER_CREDITS,
      paidCredits: 0,
      promotionalCredits: 0,
      consumedCredits: 0,
      refundedCredits: 0,
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

function availableCredits(account) {
  return (
    Number(account.freeCredits || 0) +
    Number(account.paidCredits || 0) +
    Number(account.promotionalCredits || 0)
  );
}

async function reserveCredits(
  userId,
  amount
) {
  const credits = await readJson(
    CREDITS_FILE,
    {}
  );

  if (!credits[userId]) {
    credits[userId] = {
      userId,
      freeCredits:
        STARTER_CREDITS,
      paidCredits: 0,
      promotionalCredits: 0,
      consumedCredits: 0,
      refundedCredits: 0,
      updatedAt:
        new Date().toISOString(),
    };
  }

  const account = credits[userId];

  if (
    availableCredits(account) <
    amount
  ) {
    return false;
  }

  let remaining = Number(amount);

  const freeTake = Math.min(
    Number(account.freeCredits || 0),
    remaining
  );

  account.freeCredits -= freeTake;
  remaining -= freeTake;

  const paidTake = Math.min(
    Number(account.paidCredits || 0),
    remaining
  );

  account.paidCredits -= paidTake;
  remaining -= paidTake;

  const promoTake = Math.min(
    Number(
      account.promotionalCredits || 0
    ),
    remaining
  );

  account.promotionalCredits -=
    promoTake;

  account.consumedCredits +=
    Number(amount);

  account.updatedAt =
    new Date().toISOString();

  await writeJson(
    CREDITS_FILE,
    credits
  );

  return {
    amount,
    userId,
  };
}

async function refundCredits(
  userId,
  amount
) {
  const credits = await readJson(
    CREDITS_FILE,
    {}
  );

  if (!credits[userId]) {
    credits[userId] = {
      userId,
      freeCredits: 0,
      paidCredits: 0,
      promotionalCredits: 0,
      consumedCredits: 0,
      refundedCredits: 0,
      updatedAt:
        new Date().toISOString(),
    };
  }

  const account = credits[userId];

  account.paidCredits =
    Number(account.paidCredits || 0) +
    Number(amount || 0);

  account.refundedCredits =
    Number(account.refundedCredits || 0) +
    Number(amount || 0);

  account.updatedAt =
    new Date().toISOString();

  await writeJson(
    CREDITS_FILE,
    credits
  );
}

async function addPaidCredits(
  userId,
  amount
) {
  const credits = await readJson(
    CREDITS_FILE,
    {}
  );

  if (!credits[userId]) {
    credits[userId] = {
      userId,
      freeCredits: 0,
      paidCredits: 0,
      promotionalCredits: 0,
      consumedCredits: 0,
      refundedCredits: 0,
      updatedAt:
        new Date().toISOString(),
    };
  }

  credits[userId].paidCredits =
    Number(
      credits[userId].paidCredits || 0
    ) + Number(amount || 0);

  credits[userId].updatedAt =
    new Date().toISOString();

  await writeJson(
    CREDITS_FILE,
    credits
  );
}

/* =========================================================
   FINANCE
========================================================= */

async function ensureFinance() {
  const finance = await readJson(
    FINANCE_FILE,
    {}
  );

  if (!finance.transactions) {
    finance.transactions = {};
  }

  if (!finance.ownerWallet) {
    finance.ownerWallet = {
      grossRevenue: 0,
      refunds: 0,
      costs: 0,
      profit: 0,
      withdrawn: 0,
      pendingWithdrawals: 0,
    };
  }

  await writeJson(
    FINANCE_FILE,
    finance
  );

  return finance;
}

async function addFinanceTransaction(
  type,
  amount,
  description,
  metadata = {}
) {
  const finance =
    await ensureFinance();

  const id = randomUUID();

  finance.transactions[id] = {
    id,
    type,
    amount: Number(amount || 0),
    description:
      String(description || ""),
    metadata,
    createdAt:
      new Date().toISOString(),
  };

  const value = Number(amount || 0);

  if (
    type === "sale" ||
    type === "revenue"
  ) {
    finance.ownerWallet.grossRevenue +=
      value;
  }

  if (type === "refund") {
    finance.ownerWallet.refunds +=
      value;
  }

  if (
    type === "cost" ||
    type === "provider_cost"
  ) {
    finance.ownerWallet.costs +=
      value;
  }

  finance.ownerWallet.profit =
    Number(
      finance.ownerWallet.grossRevenue
    ) -
    Number(
      finance.ownerWallet.refunds
    ) -
    Number(
      finance.ownerWallet.costs
    );

  await writeJson(
    FINANCE_FILE,
    finance
  );

  return finance.transactions[id];
}

/* =========================================================
   FX / PRICING
========================================================= */

let fxCache = {
  rate: DEFAULT_USD_NGN_RATE,
  updatedAt: null,
  live: false,
};

async function getUsdNgnRate() {
  try {
    const response = await fetch(
      FX_API_URL,
      {
        headers: {
          Accept:
            "application/json",
        },
        signal:
          AbortSignal.timeout(8000),
      }
    );

    if (!response.ok) {
      throw new Error(
        `FX HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    const rate = Number(
      data?.rates?.NGN
    );

    if (
      !Number.isFinite(rate) ||
      rate <= 0
    ) {
      throw new Error(
        "Invalid NGN FX rate."
      );
    }

    fxCache = {
      rate,
      updatedAt:
        new Date().toISOString(),
      live: true,
    };

    return fxCache;
  } catch {
    if (
      fxCache.rate &&
      fxCache.updatedAt
    ) {
      return {
        ...fxCache,
        live: false,
      };
    }

    fxCache = {
      rate:
        DEFAULT_USD_NGN_RATE,
      updatedAt:
        new Date().toISOString(),
      live: false,
    };

    return fxCache;
  }
}

function roundNaira(value) {
  return Math.ceil(
    Number(value || 0) / 50
  ) * 50;
}

function calculatePackagePrice(
  credits,
  fxRate
) {
  const usdPrice =
    Number(credits) / 100;

  const mamakiRate =
    Number(fxRate) +
    FIXED_NGN_MARKUP_PER_USD;

  return {
    credits: Number(credits),
    usdPrice,
    fxRate: Number(fxRate),
    mamakiRate,
    amount: roundNaira(
      usdPrice * mamakiRate
    ),
  };
}

async function buildPricing() {
  const fx =
    await getUsdNgnRate();

  const packages = [
    100,
    500,
    1000,
    2500,
    5000,
  ];

  const pricing = packages.map(
    (credits) => {
      const item =
        calculatePackagePrice(
          credits,
          fx.rate
        );

      const providerCostUsd =
        Math.max(
          0.01,
          (credits / 10) *
            PROVIDER_COST_480P_USD
        );

      return {
        ...item,
        providerCostUsd,
        marginTarget:
          TARGET_MARGIN,
      };
    }
  );

  const pricingData = {
    updatedAt:
      new Date().toISOString(),
    fx,
    fixedMarkupPerUsd:
      FIXED_NGN_MARKUP_PER_USD,
    pricing,
  };

  await writeJson(
    PRICING_FILE,
    pricingData
  );

  return pricingData;
}

/* =========================================================
   PASSWORD RECOVERY
========================================================= */

const PASSWORD_RESET_EXPIRY =
  15 * 60 * 1000;

const PASSWORD_RESET_MAX_ATTEMPTS = 5;

function createResetCode() {
  return String(
    randomBytes(4)
      .readUInt32BE(0) %
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

  const key = resetKey(email);

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

/* =========================================================
   PROMPT ENHANCEMENT
========================================================= */

function enhancePrompt(
  prompt,
  style = "Cinematic"
) {
  const styleText =
    String(style || "Cinematic");

  return `${prompt}. Style: ${styleText}. Cinematic visual quality, coherent composition, natural motion, consistent subjects and environment, realistic lighting, detailed textures, smooth camera movement, temporal consistency, professional production quality. Maintain continuity throughout the shot. No subtitles, no captions, no logos, no text overlays, no watermarks.`;
}

/* =========================================================
   FFMPEG
========================================================= */

function runFFmpeg(args) {
  return new Promise(
    (resolve, reject) => {
      if (!ffmpegPath) {
        return reject(
          new Error(
            "FFmpeg is not available."
          )
        );
      }

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
      let stdout = "";

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
              stdout,
              stderr,
            });
          } else {
            const error =
              new Error(
                `FFmpeg exited with code ${code}: ${stderr.slice(
                  -4000
                )}`
              );

            error.code =
              "FFMPEG_FAILED";

            reject(error);
          }
        }
      );
    }
  );
}

async function addWatermark(
  input,
  output
) {
  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    "drawtext=text='MAMAKI ✨':x=w-tw-24:y=h-th-20:fontsize=24:fontcolor=white@0.72:box=1:boxcolor=black@0.28:boxborderw=8",
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

async function combineVideoFiles(
  inputs,
  output
) {
  if (!inputs.length) {
    throw new Error(
      "No video inputs."
    );
  }

  const listFile = path.join(
    TMP,
    `${randomUUID()}-concat.txt`
  );

  const content = inputs
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

/* =========================================================
   REPLICATE HELPERS
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
    typeof output === "string" &&
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

  if (Buffer.isBuffer(output)) {
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
    typeof output ===
      "object"
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

async function runReplicateVideo(
  prompt,
  duration,
  ratio,
  imageBuffer = null
) {
  if (!replicate) {
    const error =
      new Error(
        "Replicate API is not configured."
      );

    error.code =
      "REPLICATE_AUTH_REQUIRED";

    throw error;
  }

  const frames =
    wanFrames(duration);

  const size =
    ratioSize(ratio);

  const input = {
    prompt,
    num_frames: frames,
    size,
  };

  if (
    imageBuffer &&
    imageBuffer.length
  ) {
    input.image = `data:image/jpeg;base64,${imageBuffer.toString(
      "base64"
    )}`;
  }

  const model =
    imageBuffer
      ? I2V_MODEL
      : T2V_MODEL;

  const output =
    await replicate.run(
      model,
      {
        input,
      }
    );

  return output;
}

/* =========================================================
   HEALTH / STATUS
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
            PAYSTACK_SECRET_KEY
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

      payments: {
        paystackConfigured:
          Boolean(
            PAYSTACK_SECRET_KEY
          ),
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
        billing: true,
        paystack: true,
        watermark:
          "MAMAKI ✨",
      },
    });
  }
);

/* =========================================================
   AUTH - REGISTER
========================================================= */

app.post(
  "/api/auth/register",
  async (req, res) => {
    try {
      const name = cleanText(
        req.body.name,
        100
      );

      const email =
        normalizeEmail(
          req.body.email
        );

      const password = String(
        req.body.password || ""
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
        Object.values(users).find(
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

      const id =
        randomUUID();

      const credentials =
        hashPassword(
          password
        );

      const user = {
        id,
        name,
        email,
        salt:
          credentials.salt,
        passwordHash:
          credentials.hash,
        role:
          ADMIN_EMAIL &&
          email === ADMIN_EMAIL
            ? "admin"
            : "user",
        credits:
          STARTER_CREDITS,
        disabled: false,
        createdAt:
          new Date().toISOString(),
        lastActiveAt:
          new Date().toISOString(),
      };

      users[id] = user;

      await writeJson(
        USERS_FILE,
        users
      );

      await ensureCredits(id);
      await ensureUsage(id);

      const token =
        await createSession(
          id,
          user.role
        );

      await recordSecurityEvent(
        "REGISTER",
        {
          userId: id,
          email,
          role: user.role,
        }
      );

      res.json({
        ok: true,
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          credits:
            STARTER_CREDITS,
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
          "Unable to create your MAMAKI account.",
      });
    }
  }
);

/* =========================================================
   AUTH - LOGIN
========================================================= */

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
          req.body.password || ""
        );

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      let user =
        Object.values(users).find(
          (item) =>
            String(
              item.email
            ).toLowerCase() ===
            email
        );

      /*
       * Keep the configured administrator account synchronized
       * with the Render ADMIN_EMAIL / ADMIN_PASSWORD credentials.
       */
      if (
        ADMIN_EMAIL &&
        ADMIN_PASSWORD &&
        email === ADMIN_EMAIL
      ) {
        if (!user) {
          const id =
            randomUUID();

          const credentials =
            hashPassword(
              ADMIN_PASSWORD
            );

          user = {
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
            credits:
              STARTER_CREDITS,
            disabled: false,
            createdAt:
              new Date().toISOString(),
            lastActiveAt:
              new Date().toISOString(),
          };

          users[id] = user;

          await writeJson(
            USERS_FILE,
            users
          );

          await ensureCredits(id);
          await ensureUsage(id);
        } else {
          user.role =
            "admin";
          user.disabled =
            false;
        }
      }

      if (!user) {
        return res.status(401).json({
          ok: false,
          error:
            "INVALID_CREDENTIALS",
          message:
            "Invalid email or password.",
        });
      }

      /*
       * If the email is the configured master administrator,
       * allow the Render ADMIN_PASSWORD to restore admin access.
       */
      const adminMasterLogin =
        Boolean(
          ADMIN_EMAIL &&
            ADMIN_PASSWORD &&
            email === ADMIN_EMAIL &&
            password ===
              ADMIN_PASSWORD
        );

      const valid =
        adminMasterLogin ||
        verifyPassword(
          password,
          user.salt,
          user.passwordHash
        );

      if (!valid) {
        await recordSecurityEvent(
          "LOGIN_FAILED",
          {
            email,
            method:
              "PASSWORD",
          }
        );

        return res.status(401).json({
          ok: false,
          error:
            "INVALID_CREDENTIALS",
          message:
            "Invalid email or password.",
        });
      }

      if (user.disabled) {
        return res.status(403).json({
          ok: false,
          error:
            "ACCOUNT_DISABLED",
          message:
            "This MAMAKI account has been disabled.",
        });
      }

      if (
        adminMasterLogin
      ) {
        user.role =
          "admin";

        const credentials =
          hashPassword(
            password
          );

        user.salt =
          credentials.salt;

        user.passwordHash =
          credentials.hash;
      }

      user.lastActiveAt =
        new Date().toISOString();

      users[user.id] =
        user;

      await writeJson(
        USERS_FILE,
        users
      );

      await ensureCredits(
        user.id
      );

      await ensureUsage(
        user.id
      );

      const token =
        await createSession(
          user.id,
          user.role
        );

      await recordSecurityEvent(
        "LOGIN_SUCCESS",
        {
          userId:
            user.id,
          email:
            user.email,
          role:
            user.role,
        }
      );

      const account =
        await ensureCredits(
          user.id
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
            availableCredits(
              account
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
          "Unable to log in.",
      });
    }
  }
);

/* =========================================================
   AUTH - ME
========================================================= */

app.get(
  "/api/auth/me",
  requireUser,
  async (req, res) => {
    const account =
      await ensureCredits(
        req.user.id
      );

    res.json({
      ok: true,
      user: {
        id:
          req.user.id,
        name:
          req.user.name,
        email:
          req.user.email,
        role:
          req.user.role,
        credits:
          availableCredits(
            account
          ),
      },
    });
  }
);

/* =========================================================
   AUTH - LOGOUT
========================================================= */

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
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/auth/logout",
        }
      );

      res.json({
        ok: true,
      });
    }
  }
);

/* =========================================================
   PASSWORD RESET - REQUEST
========================================================= */

app.post(
  "/api/auth/forgot-password",
  async (req, res) => {
    try {
      const email =
        normalizeEmail(
          req.body.email
        );

      if (!email) {
        return res.status(400).json({
          ok: false,
          error:
            "EMAIL_REQUIRED",
          message:
            "Email is required.",
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
        return res.status(429).json({
          ok: false,
          error:
            "TOO_MANY_REQUESTS",
          message:
            "Too many password recovery requests. Please try again later.",
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
              item.email
            ).toLowerCase() ===
            email
        );

      /*
       * Do not reveal whether an email exists.
       */
      if (!user) {
        return res.json({
          ok: true,
          message:
            "If the account exists, a recovery code has been sent.",
        });
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
        "PASSWORD_RESET_REQUESTED",
        {
          userId:
            user.id,
          email,
        }
      );

      res.json({
        ok: true,
        message:
          "If the account exists, a recovery code has been sent.",
      });
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
        error:
          "PASSWORD_RESET_REQUEST_FAILED",
        message:
          "Unable to send the recovery code.",
      });
    }
  }
);

/* =========================================================
   PASSWORD RESET - COMPLETE
========================================================= */

app.post(
  "/api/auth/reset-password",
  async (req, res) => {
    try {
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
          req.body.password || ""
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
        newPassword.length <
        6
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "WEAK_PASSWORD",
          message:
            "Password must contain at least 6 characters.",
        });
      }

      const reset =
        await findPasswordReset(
          email
        );

      if (!reset) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_RESET",
          message:
            "The recovery code is invalid or expired.",
        });
      }

      if (
        Date.now() >
        Number(
          reset.expiresAt
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
            "The recovery code has expired.",
        });
      }

      if (
        Number(
          reset.attempts || 0
        ) >=
        PASSWORD_RESET_MAX_ATTEMPTS
      ) {
        await deletePasswordReset(
          email
        );

        return res.status(400).json({
          ok: false,
          error:
            "RESET_LOCKED",
          message:
            "Too many incorrect recovery-code attempts.",
        });
      }

      const expected =
        hashResetCode(code);

      if (
        !timingSafeEqual(
          Buffer.from(
            expected,
            "hex"
          ),
          Buffer.from(
            reset.codeHash,
            "hex"
          )
        )
      ) {
        reset.attempts =
          Number(
            reset.attempts || 0
          ) + 1;

        const records =
          await readJson(
            RESET_FILE,
            {}
          );

        records[
          resetKey(email)
        ] = reset;

        await writeJson(
          RESET_FILE,
          records
        );

        return res.status(400).json({
          ok: false,
          error:
            "INVALID_CODE",
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
              item.email
            ).toLowerCase() ===
            email
        );

      if (!user) {
        return res.status(400).json({
          ok: false,
          error:
            "ACCOUNT_NOT_FOUND",
          message:
            "Account not found.",
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

      await invalidateUserSessions(
        user.id
      );

      await deletePasswordReset(
        email
      );

      const token =
        await createSession(
          user.id,
          user.role
        );

      await recordSecurityEvent(
        "PASSWORD_RESET_COMPLETED",
        {
          userId:
            user.id,
          email:
            user.email,
        }
      );

      res.json({
        ok: true,
        message:
          "Password reset successfully.",
        token,
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
          "Unable to reset your password.",
      });
    }
  }
);

/* =========================================================
   ACCOUNT
========================================================= */

app.get(
  "/api/account",
  requireUser,
  async (req, res) => {
    const account =
      await ensureCredits(
        req.user.id
      );

    const usage =
      await ensureUsage(
        req.user.id
      );

    res.json({
      ok: true,
      user: {
        id:
          req.user.id,
        name:
          req.user.name,
        email:
          req.user.email,
        role:
          req.user.role,
      },
      credits: {
        available:
          availableCredits(
            account
          ),
        free:
          Number(
            account.freeCredits ||
              0
          ),
        paid:
          Number(
            account.paidCredits ||
              0
          ),
        promotional:
          Number(
            account.promotionalCredits ||
              0
          ),
        consumed:
          Number(
            account.consumedCredits ||
              0
          ),
      },
      usage,
    });
  }
);

app.post(
  "/api/account/change-password",
  requireUser,
  async (req, res) => {
    try {
      const currentPassword =
        String(
          req.body.currentPassword ||
            ""
        );

      const newPassword =
        String(
          req.body.newPassword ||
            ""
        );

      if (
        !currentPassword ||
        !newPassword
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_INPUT",
          message:
            "Current and new passwords are required.",
        });
      }

      if (
        newPassword.length <
        6
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "WEAK_PASSWORD",
          message:
            "New password must contain at least 6 characters.",
        });
      }

      if (
        !verifyPassword(
          currentPassword,
          req.user.salt,
          req.user.passwordHash
        )
      ) {
        return res.status(401).json({
          ok: false,
          error:
            "INVALID_PASSWORD",
          message:
            "Current password is incorrect.",
        });
      }

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      const user =
        users[req.user.id];

      if (!user) {
        return res.status(404).json({
          ok: false,
          error:
            "ACCOUNT_NOT_FOUND",
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

      await invalidateUserSessions(
        user.id
      );

      const token =
        await createSession(
          user.id,
          user.role
        );

      await recordSecurityEvent(
        "PASSWORD_CHANGED",
        {
          userId:
            user.id,
          email:
            user.email,
          method:
            "CHANGE_PASSWORD",
        }
      );

      res.json({
        ok: true,
        message:
          "Password changed successfully.",
        token,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/account/change-password",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "CHANGE_PASSWORD_FAILED",
        message:
          "Unable to change your password.",
      });
    }
  }
);

app.get(
  "/api/account/credits",
  requireUser,
  async (req, res) => {
    const account =
      await ensureCredits(
        req.user.id
      );

    res.json({
      ok: true,
      credits: {
        available:
          availableCredits(
            account
          ),
        free:
          Number(
            account.freeCredits ||
              0
          ),
        paid:
          Number(
            account.paidCredits ||
              0
          ),
        promotional:
          Number(
            account.promotionalCredits ||
              0
          ),
        consumed:
          Number(
            account.consumedCredits ||
              0
          ),
      },
    });
  }
);

/* =========================================================
   AI PROMPT ENHANCEMENT
========================================================= */

app.post(
  "/api/ai/enhance",
  async (req, res) => {
    const prompt =
      cleanText(
        req.body.prompt,
        5000
      );

    const style =
      cleanText(
        req.body.style ||
          "Cinematic",
        100
      );

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error:
          "PROMPT_REQUIRED",
      });
    }

    res.json({
      ok: true,
      original:
        prompt,
      enhanced:
        enhancePrompt(
          prompt,
          style
        ),
      style,
    });
  }
);

/* =========================================================
   AI VIDEO GENERATION
========================================================= */

app.post(
  "/api/generate",
  upload.single("image"),
  async (req, res) => {
    let reservation = null;

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

      const generationCredits =
        creditCost(
          duration
        );

      reservation =
        await reserveCredits(
          user.id,
          generationCredits
        );

      if (!reservation) {
        return res.status(402).json({
          ok: false,
          error:
            "INSUFFICIENT_CREDITS",
          message:
            `This production requires ${generationCredits} MAMAKI credits.`,
          requiredCredits:
            generationCredits,
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
        prompt,
        style,
        duration,
        ratio,
        quality,
        creditCost:
          generationCredits,
        createdAt:
          new Date().toISOString(),
      };

      jobs.set(
        jobId,
        job
      );

      /*
       * Return immediately so the browser does not sit waiting
       * for the entire Replicate production.
       */
      res.json({
        ok: true,
        jobId,
        status:
          "queued",
        creditsUsed:
          generationCredits,
        creditsRemaining:
          availableCredits(
            await ensureCredits(
              user.id
            )
          ),
      });

      (async () => {
        try {
          job.status =
            "processing";
          job.progress = 10;
          job.message =
            "Preparing your MAMAKI production.";

          const enhanced =
            enhancePrompt(
              prompt,
              style
            );

          /*
           * For productions up to 5 seconds, generate one clip.
           * Longer productions are assembled from multiple 5-second
           * generations so MAMAKI can support long-form projects.
           */
          if (duration <= 5) {
            const output =
              await runReplicateVideo(
                enhanced,
                duration,
                ratio,
                req.file?.buffer ||
                  null
              );

            job.progress = 70;
            job.message =
              "Downloading generated video.";

            const rawFile =
              path.join(
                TMP,
                `${jobId}-raw.mp4`
              );

            const finalFile =
              path.join(
                OUTPUTS,
                `${jobId}.mp4`
              );

            await downloadReplicateOutput(
              output,
              rawFile
            );

            job.progress = 85;
            job.message =
              "Applying MAMAKI finishing.";

            await addWatermark(
              rawFile,
              finalFile
            );

            job.status =
              "completed";
            job.progress = 100;
            job.message =
              "Production completed.";
            job.video =
              `/api/video/${path.basename(
                finalFile
              )}`;
            job.completedAt =
              new Date().toISOString();

            await recordUsage(
              user.id,
              "ai",
              duration
            );

            const providerCost =
              duration <= 5
                ? PROVIDER_COST_480P_USD
                : PROVIDER_COST_720P_USD;

            await addFinanceTransaction(
              "provider_cost",
              providerCost,
              "Replicate AI video generation",
              {
                jobId,
                userId:
                  user.id,
                duration,
                model:
                  req.file?.buffer
                    ? I2V_MODEL
                    : T2V_MODEL,
              }
            );
          } else {
            const sceneCount =
              Math.ceil(
                duration / 5
              );

            const sceneFiles =
              [];

            for (
              let i = 0;
              i < sceneCount;
              i++
            ) {
              const remaining =
                duration -
                i * 5;

              const sceneDuration =
                Math.min(
                  5,
                  remaining
                );

              const scenePrompt =
                `${enhanced} Scene ${i + 1} of ${sceneCount}. Continue naturally from the previous scene and preserve the same subject, appearance, setting, lighting, camera language and visual identity.`;

              job.progress = Math.min(
                75,
                10 +
                  Math.round(
                    (i /
                      sceneCount) *
                      60
                  )
              );

              job.message =
                `Generating scene ${i + 1} of ${sceneCount}.`;

              const output =
                await runReplicateVideo(
                  scenePrompt,
                  sceneDuration,
                  ratio,
                  i === 0
                    ? req.file?.buffer ||
                        null
                    : null
                );

              const sceneFile =
                path.join(
                  TMP,
                  `${jobId}-scene-${i}.mp4`
                );

              await downloadReplicateOutput(
                output,
                sceneFile
              );

              sceneFiles.push(
                sceneFile
              );

              await sleep(250);
            }

            const combined =
              path.join(
                TMP,
                `${jobId}-combined.mp4`
              );

            const finalFile =
              path.join(
                OUTPUTS,
                `${jobId}.mp4`
              );

            job.progress = 85;
            job.message =
              "Assembling your long-form production.";

            await combineVideoFiles(
              sceneFiles,
              combined
            );

            job.progress = 92;
            job.message =
              "Applying MAMAKI finishing.";

            await forceDuration(
              combined,
              path.join(
                TMP,
                `${jobId}-duration.mp4`
              ),
              duration
            );

            await addWatermark(
              path.join(
                TMP,
                `${jobId}-duration.mp4`
              ),
              finalFile
            );

            job.status =
              "completed";
            job.progress = 100;
            job.message =
              "Production completed.";
            job.video =
              `/api/video/${path.basename(
                finalFile
              )}`;
            job.completedAt =
              new Date().toISOString();

            await recordUsage(
              user.id,
              "ai",
              duration
            );

            const providerCost =
              sceneCount *
              PROVIDER_COST_480P_USD;

            await addFinanceTransaction(
              "provider_cost",
              providerCost,
              "Replicate long-form AI production",
              {
                jobId,
                userId:
                  user.id,
                duration,
                scenes:
                  sceneCount,
              }
            );
          }

          jobs.set(
            jobId,
            job
          );
        } catch (error) {
          const classified =
            classifyReplicateError(
              error
            );

          job.status =
            "failed";
          job.progress = 0;
          job.message =
            classified.message;
          job.error =
            classified.code;
          job.completedAt =
            new Date().toISOString();

          await refundCredits(
            user.id,
            generationCredits
          );

          await recordError(
            error,
            {
              route:
                "/api/generate",
              jobId,
              userId:
                user.id,
              classified:
                classified.code,
            }
          );

          jobs.set(
            jobId,
            job
          );
        }
      })();
    } catch (error) {
      if (reservation) {
        try {
          await refundCredits(
            req.user?.id,
            reservation.amount
          );
        } catch {}
      }

      await recordError(
        error,
        {
          route:
            "/api/generate",
        }
      );

      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error:
            "GENERATION_FAILED",
          message:
            "Unable to start the MAMAKI AI production.",
        });
      }
    }
  }
);

/* =========================================================
   JOB STATUS
========================================================= */

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
          "JOB_NOT_FOUND",
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
      });
    }

    res.json({
      ok: true,
      job,
    });
  }
);

/* =========================================================
   VIDEO DELIVERY
========================================================= */

app.get(
  "/api/video/:file",
  async (req, res) => {
    const file =
      safeFileName(
        req.params.file
      );

    if (!file.endsWith(".mp4")) {
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

      res.setHeader(
        "Accept-Ranges",
        "bytes"
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
   FREE STUDIO - PHOTO VIDEO
========================================================= */

app.post(
  "/api/studio/photo-video",
  upload.array(
    "photos",
    50
  ),
  async (req, res) => {
    try {
      const photos =
        req.files || [];

      if (!photos.length) {
        return res.status(400).json({
          ok: false,
          error:
            "PHOTOS_REQUIRED",
          message:
            "Add at least one photo.",
        });
      }

      const user =
        await getCurrentUser(
          req
        );

      const seconds =
        normalizeDuration(
          req.body.seconds ||
            req.body.duration ||
            5
        );

      const ratio =
        normalizeRatio(
          req.body.ratio
        );

      const id =
        randomUUID();

      const clips = [];

      for (
        let i = 0;
        i < photos.length;
        i++
      ) {
        const image =
          path.join(
            TMP,
            `${id}-${i}.jpg`
          );

        const clip =
          path.join(
            TMP,
            `${id}-${i}.mp4`
          );

        await fs.writeFile(
          image,
          photos[i].buffer
        );

        const size =
          ratioSize(
            ratio
          );

        await runFFmpeg([
          "-y",
          "-loop",
          "1",
          "-i",
          image,
          "-t",
          String(seconds),
          "-vf",
          `scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2`,
          "-r",
          "30",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          clip,
        ]);

        clips.push(
          clip
        );
      }

      const combined =
        path.join(
          OUTPUTS,
          `${id}-combined.mp4`
        );

      const watermarked =
        path.join(
          OUTPUTS,
          `${id}.mp4`
        );

      await combineVideoFiles(
        clips,
        combined
      );

      await addWatermark(
        combined,
        watermarked
      );

      if (user) {
        await recordUsage(
          user.id,
          "studio",
          photos.length *
            seconds
        );
      }

      res.json({
        ok: true,
        video:
          `/api/video/${path.basename(
            watermarked
          )}`,
        duration:
          photos.length *
          seconds,
        ratio,
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
          "Unable to create the photo video.",
      });
    }
  }
);

/* =========================================================
   VIDEO TRIMMER
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

      const id =
        randomUUID();

      const input =
        path.join(
          TMP,
          `${id}-input.mp4`
        );

      const trimmed =
        path.join(
          OUTPUTS,
          `${id}-trimmed.mp4`
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

      await runFFmpeg([
        "-y",
        "-ss",
        String(start),
        "-i",
        input,
        "-t",
        String(duration),
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
        trimmed,
      ]);

      await addWatermark(
        trimmed,
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
          duration
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
   COMBINE VIDEOS
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
   NARRATION
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

    if (!file.endsWith(".mp3")) {
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
   SUBTITLES
========================================================= */

app.post(
  "/api/studio/subtitles",
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

      const subtitles =
        cleanText(
          req.body.subtitles ||
            req.body.text,
          30000
        );

      if (!subtitles) {
        return res.status(400).json({
          ok: false,
          error:
            "SUBTITLES_REQUIRED",
          message:
            "Subtitle text is required.",
        });
      }

      const id =
        randomUUID();

      const input =
        path.join(
          TMP,
          `${id}-input.mp4`
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

      const escaped =
        subtitles
          .replace(
            /\\/g,
            "\\\\"
          )
          .replace(
            /:/g,
            "\\:"
          )
          .replace(
            /'/g,
            "\\'"
          )
          .replace(
            /\n/g,
            "\\n"
          );

      await runFFmpeg([
        "-y",
        "-i",
        input,
        "-vf",
        `drawtext=text='${escaped}':x=(w-text_w)/2:y=h-text_h-50:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=10`,
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
        final,
      ]);

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
            "/api/studio/subtitles",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "SUBTITLE_FAILED",
        message:
          "Unable to add subtitles.",
      });
    }
  }
);

/* =========================================================
   SOCIAL EXPORT
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

      const preset =
        cleanText(
          req.body.preset ||
            "vertical",
          100
        );

      let size =
        "1080:1920";

      if (
        preset === "square"
      ) {
        size =
          "1080:1080";
      }

      if (
        preset ===
        "landscape"
      ) {
        size =
          "1920:1080";
      }

      const id =
        randomUUID();

      const input =
        path.join(
          TMP,
          `${id}-input.mp4`
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
        final,
      ]);

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
        preset,
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
          "Unable to export the social video.",
      });
    }
  }
);

/* =========================================================
   PROJECTS
========================================================= */

app.get(
  "/api/projects",
  requireUser,
  async (req, res) => {
    try {
      const files =
        await fs.readdir(
          PROJECTS
        );

      const list = [];

      for (const file of files) {
        if (
          !file.endsWith(
            ".json"
          )
        ) {
          continue;
        }

        try {
          const raw =
            await fs.readFile(
              path.join(
                PROJECTS,
                file
              ),
              "utf8"
            );

          const project =
            JSON.parse(raw);

          if (
            project.userId ===
            req.user.id ||
            req.user.role ===
              "admin"
          ) {
            list.push(
              project
            );
          }
        } catch {}
      }

      list.sort(
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
        projects:
          list,
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
            "Untitled MAMAKI Project",
          200
        );

      const id =
        randomUUID();

      const project = {
        id,
        userId:
          req.user.id,
        name,
        data:
          req.body.data ||
          {},
        createdAt:
          new Date().toISOString(),
        updatedAt:
          new Date().toISOString(),
      };

      await fs.writeFile(
        path.join(
          PROJECTS,
          `${id}.json`
        ),
        JSON.stringify(
          project,
          null,
          2
        ),
        "utf8"
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

app.get(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    try {
      const id =
        safeFileName(
          req.params.id
        );

      const file =
        path.join(
          PROJECTS,
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
          error:
            "PROJECT_NOT_FOUND",
        });
      }

      if (
        project.userId !==
          req.user.id &&
        req.user.role !==
          "admin"
      ) {
        return res.status(403).json({
          ok: false,
          error:
            "FORBIDDEN",
        });
      }

      res.json({
        ok: true,
        project,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/projects/:id",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "PROJECT_READ_FAILED",
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
        safeFileName(
          req.params.id
        );

      const file =
        path.join(
          PROJECTS,
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
          error:
            "PROJECT_NOT_FOUND",
        });
      }

      if (
        project.userId !==
          req.user.id &&
        req.user.role !==
          "admin"
      ) {
        return res.status(403).json({
          ok: false,
          error:
            "FORBIDDEN",
        });
      }

      if (
        req.body.name
      ) {
        project.name =
          cleanText(
            req.body.name,
            200
          );
      }

      if (
        req.body.data !==
        undefined
      ) {
        project.data =
          req.body.data;
      }

      project.updatedAt =
        new Date().toISOString();

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
            "/api/projects/:id",
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
        safeFileName(
          req.params.id
        );

      const file =
        path.join(
          PROJECTS,
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
          error:
            "PROJECT_NOT_FOUND",
        });
      }

      if (
        project.userId !==
          req.user.id &&
        req.user.role !==
          "admin"
      ) {
        return res.status(403).json({
          ok: false,
          error:
            "FORBIDDEN",
        });
      }

      await fs.unlink(
        file
      );

      res.json({
        ok: true,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/projects/:id",
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

/* =========================================================
   BILLING - PUBLIC PRICING
========================================================= */

app.get(
  "/api/billing/pricing",
  async (req, res) => {
    try {
      const data =
        await buildPricing();

      res.json({
        ok: true,
        currency:
          PAYSTACK_CURRENCY_DEFAULT,
        packages:
          data.pricing.map(
            (item) => ({
              credits:
                item.credits,
              amount:
                item.amount,
              currency:
                PAYSTACK_CURRENCY_DEFAULT,
            })
          ),
        fx: {
          live:
            data.fx.live,
          updatedAt:
            data.fx.updatedAt,
        },
      });
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
      });
    }
  }
);

/* =========================================================
   PAYSTACK API
========================================================= */

async function paystackRequest(
  endpoint,
  options = {}
) {
  if (
    !PAYSTACK_SECRET_KEY
  ) {
    const error =
      new Error(
        "Paystack is not configured."
      );

    error.code =
      "PAYSTACK_NOT_CONFIGURED";

    throw error;
  }

  const response =
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
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
  } catch {
    data = {
      status: false,
      message: text,
    };
  }

  if (
    !response.ok ||
    data?.status === false
  ) {
    const error =
      new Error(
        data?.message ||
          `Paystack HTTP ${response.status}`
      );

    error.code =
      "PAYSTACK_REQUEST_FAILED";

    error.status =
      response.status;

    error.paystack =
      data;

    throw error;
  }

  return data;
}

/* =========================================================
   PAYSTACK - INITIALIZE
========================================================= */

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
            "PAYSTACK_NOT_CONFIGURED",
          message:
            "Paystack payment is not configured yet.",
        });
      }

      const credits =
        Number(
          req.body.credits
        );

      if (
        !Number.isFinite(
          credits
        ) ||
        ![
          100,
          500,
          1000,
          2500,
          5000,
        ].includes(
          credits
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_PACKAGE",
          message:
            "Select a valid MAMAKI credit package.",
        });
      }

      const pricing =
        await buildPricing();

      const selected =
        pricing.pricing.find(
          (item) =>
            Number(
              item.credits
            ) === credits
        );

      if (!selected) {
        return res.status(400).json({
          ok: false,
          error:
            "PACKAGE_NOT_FOUND",
        });
      }

      const reference =
        `MAMAKI-${Date.now()}-${randomBytes(
          5
        ).toString("hex")}`;

      const payments =
        await readJson(
          PAYMENTS_FILE,
          {}
        );

      payments[reference] = {
        reference,
        userId:
          req.user.id,
        email:
          req.user.email,
        credits,
        amount:
          selected.amount,
        currency:
          PAYSTACK_CURRENCY_DEFAULT,
        status:
          "initialized",
        fulfilledAt:
          null,
        createdAt:
          new Date().toISOString(),
      };

      await writeJson(
        PAYMENTS_FILE,
        payments
      );

      const data =
        await paystackRequest(
          "/transaction/initialize",
          {
            method:
              "POST",
            body:
              JSON.stringify({
                email:
                  req.user.email,
                amount:
                  Math.round(
                    selected.amount *
                      100
                  ),
                currency:
                  PAYSTACK_CURRENCY_DEFAULT,
                reference,
                callback_url:
                  `${APP_URL}/?payment=complete&reference=${encodeURIComponent(
                    reference
                  )}`,
                metadata: {
                  userId:
                    req.user.id,
                  credits,
                  mamaki: true,
                },
              }),
          }
        );

      payments[
        reference
      ].status =
        "pending";

      payments[
        reference
      ].authorizationUrl =
        data.data
          ?.authorization_url ||
        null;

      await writeJson(
        PAYMENTS_FILE,
        payments
      );

      res.json({
        ok: true,
        reference,
        authorizationUrl:
          data.data
            ?.authorization_url,
        accessCode:
          data.data
            ?.access_code,
        amount:
          selected.amount,
        credits,
        currency:
          PAYSTACK_CURRENCY_DEFAULT,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/billing/paystack/initialize",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          error.code ||
          "PAYSTACK_INITIALIZE_FAILED",
        message:
          error.message ||
          "Unable to initialize Paystack payment.",
      });
    }
  }
);

/* =========================================================
   PAYSTACK - VERIFY
========================================================= */

async function fulfillPayment(
  reference,
  verifiedData
) {
  const payments =
    await readJson(
      PAYMENTS_FILE,
      {}
    );

  const payment =
    payments[reference];

  if (!payment) {
    throw new Error(
      "MAMAKI payment record not found."
    );
  }

  if (
    payment.fulfilledAt
  ) {
    return {
      alreadyFulfilled:
        true,
      payment,
    };
  }

  if (
    String(
      verifiedData?.status ||
        ""
    ).toLowerCase() !==
    "success"
  ) {
    payment.status =
      String(
        verifiedData?.status ||
          "failed"
      );

    payments[reference] =
      payment;

    await writeJson(
      PAYMENTS_FILE,
      payments
    );

    return {
      alreadyFulfilled:
        false,
      payment,
    };
  }

  if (
    Number(
      verifiedData?.amount
    ) !==
    Math.round(
      Number(payment.amount) *
        100
    )
  ) {
    throw new Error(
      "Paystack amount verification failed."
    );
  }

  if (
    String(
      verifiedData?.currency ||
        ""
    ).toUpperCase() !==
    String(
      payment.currency
    ).toUpperCase()
  ) {
    throw new Error(
      "Paystack currency verification failed."
    );
  }

  await addPaidCredits(
    payment.userId,
    payment.credits
  );

  payment.status =
    "success";

  payment.fulfilledAt =
    new Date().toISOString();

  payment.paystackData =
    verifiedData;

  payments[reference] =
    payment;

  await writeJson(
    PAYMENTS_FILE,
    payments
  );

  await addFinanceTransaction(
    "sale",
    payment.amount,
    "MAMAKI credit purchase",
    {
      reference,
      userId:
        payment.userId,
      credits:
        payment.credits,
      currency:
        payment.currency,
    }
  );

  return {
    alreadyFulfilled:
      false,
    payment,
  };
}

app.get(
  "/api/billing/payment/:reference",
  requireUser,
  async (req, res) => {
    try {
      const reference =
        cleanText(
          req.params.reference,
          200
        );

      const payments =
        await readJson(
          PAYMENTS_FILE,
          {}
        );

      const payment =
        payments[reference];

      if (!payment) {
        return res.status(404).json({
          ok: false,
          error:
            "PAYMENT_NOT_FOUND",
        });
      }

      if (
        payment.userId !==
        req.user.id &&
        req.user.role !==
          "admin"
      ) {
        return res.status(403).json({
          ok: false,
          error:
            "FORBIDDEN",
        });
      }

      /*
       * Verify pending transactions directly with Paystack.
       */
      if (
        PAYSTACK_SECRET_KEY &&
        !payment.fulfilledAt
      ) {
        try {
          const verified =
            await paystackRequest(
              `/transaction/verify/${encodeURIComponent(
                reference
              )}`
            );

          await fulfillPayment(
            reference,
            verified.data
          );
        } catch (error) {
          await recordError(
            error,
            {
              route:
                "/api/billing/payment/:reference",
              reference,
            }
          );
        }
      }

      const fresh =
        await readJson(
          PAYMENTS_FILE,
          {}
        );

      const result =
        fresh[reference];

      const account =
        await ensureCredits(
          req.user.id
        );

      res.json({
        ok: true,
        payment: {
          reference:
            result.reference,
          status:
            result.status,
          credits:
            result.credits,
          amount:
            result.amount,
          currency:
            result.currency,
          fulfilledAt:
            result.fulfilledAt,
        },
        credits:
          availableCredits(
            account
          ),
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
          "PAYMENT_STATUS_FAILED",
      });
    }
  }
);

/* =========================================================
   PAYSTACK - WEBHOOK SIGNATURE
========================================================= */

function verifyPaystackSignature(
  req
) {
  if (
    !PAYSTACK_SECRET_KEY
  ) {
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

  try {
    return timingSafeEqual(
      Buffer.from(
        signature,
        "utf8"
      ),
      Buffer.from(
        expected,
        "utf8"
      )
    );
  } catch {
    return false;
  }
}

async function processPaystackWebhook(
  req,
  res
) {
  try {
    if (
      !verifyPaystackSignature(
        req
      )
    ) {
      await recordSecurityEvent(
        "PAYSTACK_WEBHOOK_INVALID",
        {
          method:
            req.method,
        }
      );

      return res.status(401).json({
        ok: false,
        error:
          "INVALID_SIGNATURE",
      });
    }

    const event =
      req.body || {};

    const reference =
      cleanText(
        event?.data?.reference,
        200
      );

    if (
      event.event ===
        "charge.success" &&
      reference
    ) {
      try {
        const verified =
          await paystackRequest(
            `/transaction/verify/${encodeURIComponent(
              reference
            )}`
          );

        await fulfillPayment(
          reference,
          verified.data
        );
      } catch (error) {
        await recordError(
          error,
          {
            route:
              req.originalUrl,
            reference,
          }
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
          req.originalUrl,
      }
    );

    res.status(500).json({
      ok: false,
      error:
        "WEBHOOK_FAILED",
    });
  }
}

app.post(
  "/api/billing/paystack/webhook",
  processPaystackWebhook
);

app.post(
  "/api/payments/paystack/webhook",
  processPaystackWebhook
);

/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post(
  "/api/admin/login",
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

      const rateKey =
        `${email}:${req.ip}`;

      if (
        !allowedByRate(
          adminLoginRate,
          rateKey,
          10,
          15 * 60 * 1000
        )
      ) {
        return res.status(429).json({
          ok: false,
          error:
            "TOO_MANY_REQUESTS",
          message:
            "Too many administrator login attempts.",
        });
      }

      if (
        !ADMIN_EMAIL ||
        !ADMIN_PASSWORD
      ) {
        return res.status(503).json({
          ok: false,
          error:
            "ADMIN_NOT_CONFIGURED",
          message:
            "Administrator credentials are not configured.",
        });
      }

      if (
        email !==
          ADMIN_EMAIL ||
        password !==
          ADMIN_PASSWORD
      ) {
        await recordSecurityEvent(
          "ADMIN_LOGIN_FAILED",
          {
            email,
            ip:
              req.ip,
          }
        );

        return res.status(401).json({
          ok: false,
          error:
            "INVALID_CREDENTIALS",
          message:
            "Invalid administrator credentials.",
        });
      }

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      let user =
        Object.values(
          users
        ).find(
          (item) =>
            String(
              item.email
            ).toLowerCase() ===
            ADMIN_EMAIL
        );

      if (!user) {
        const id =
          randomUUID();

        const credentials =
          hashPassword(
            ADMIN_PASSWORD
          );

        user = {
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
          credits:
            STARTER_CREDITS,
          disabled: false,
          createdAt:
            new Date().toISOString(),
          lastActiveAt:
            new Date().toISOString(),
        };

        users[id] =
          user;
      } else {
        user.role =
          "admin";
        user.disabled =
          false;

        const credentials =
          hashPassword(
            ADMIN_PASSWORD
          );

        user.salt =
          credentials.salt;

        user.passwordHash =
          credentials.hash;

        user.lastActiveAt =
          new Date().toISOString();

        users[user.id] =
          user;
      }

      await writeJson(
        USERS_FILE,
        users
      );

      await ensureCredits(
        user.id
      );

      await ensureUsage(
        user.id
      );

      const token =
        await createSession(
          user.id,
          "admin"
        );

      await recordSecurityEvent(
        "ADMIN_LOGIN_SUCCESS",
        {
          userId:
            user.id,
          email:
            user.email,
          ip:
            req.ip,
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
          "Unable to log in to the administrator dashboard.",
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

      const projects =
        await fs
          .readdir(
            PROJECTS
          )
          .catch(
            () => []
          );

      let aiGenerations = 0;
      let aiSeconds = 0;
      let studioJobs = 0;
      let narrationJobs = 0;

      for (const value of Object.values(
        usage
      )) {
        aiGenerations +=
          Number(
            value.aiGenerations ||
              0
          );

        aiSeconds +=
          Number(
            value.aiSeconds ||
              0
          );

        studioJobs +=
          Number(
            value.studioJobs ||
              0
          );

        narrationJobs +=
          Number(
            value.narrationJobs ||
              0
          );
      }

      res.json({
        ok: true,
        stats: {
          totalUsers:
            Object.keys(
              users
            ).length,
          totalProjects:
            projects.filter(
              (x) =>
                x.endsWith(
                  ".json"
                )
            ).length,
          aiGenerations,
          aiSeconds,
          studioJobs,
          narrationJobs,
          recoveryConfigured:
            Boolean(
              RESEND_API_KEY &&
                RESEND_FROM
            ),
          uptime:
            process.uptime(),
        },
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/stats",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "ADMIN_STATS_FAILED",
      });
    }
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

      const usage =
        await readJson(
          USAGE_FILE,
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
        ).map(
          (user) => ({
            ...user,
            passwordHash:
              undefined,
            salt:
              undefined,
            credits:
              availableCredits(
                credits[
                  user.id
                ] || {
                  freeCredits: 0,
                  paidCredits: 0,
                  promotionalCredits: 0,
                }
              ),
            usage:
              usage[
                user.id
              ] || {
                aiGenerations: 0,
                aiSeconds: 0,
                studioJobs: 0,
                narrationJobs: 0,
              },
          })
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

/* =========================================================
   ADMIN USER DETAILS
========================================================= */

app.get(
  "/api/admin/users/:id",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJson(
        USERS_FILE,
        {}
      );

    const user =
      users[
        req.params.id
      ];

    if (!user) {
      return res.status(404).json({
        ok: false,
        error:
          "USER_NOT_FOUND",
      });
    }

    const credits =
      await ensureCredits(
        user.id
      );

    const usage =
      await ensureUsage(
        user.id
      );

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
        disabled:
          user.disabled,
        createdAt:
          user.createdAt,
        lastActiveAt:
          user.lastActiveAt,
      },
      credits,
      usage,
    });
  }
);

/* =========================================================
   ADMIN DISABLE USER
========================================================= */

app.post(
  "/api/admin/users/:id/disable",
  requireAdmin,
  async (req, res) => {
    try {
      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      const user =
        users[
          req.params.id
        ];

      if (!user) {
        return res.status(404).json({
          ok: false,
          error:
            "USER_NOT_FOUND",
        });
      }

      if (
        user.id ===
        req.user.id
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "CANNOT_DISABLE_SELF",
        });
      }

      user.disabled =
        req.body.disabled !==
        false;

      users[user.id] =
        user;

      await writeJson(
        USERS_FILE,
        users
      );

      if (user.disabled) {
        await invalidateUserSessions(
          user.id
        );
      }

      await recordSecurityEvent(
        user.disabled
          ? "USER_DISABLED"
          : "USER_ENABLED",
        {
          userId:
            user.id,
          email:
            user.email,
          adminId:
            req.user.id,
        }
      );

      res.json({
        ok: true,
        disabled:
          user.disabled,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/users/:id/disable",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "USER_UPDATE_FAILED",
      });
    }
  }
);

/* =========================================================
   ADMIN CREDIT ADJUSTMENT
========================================================= */

app.post(
  "/api/admin/users/:id/credits",
  requireAdmin,
  async (req, res) => {
    try {
      const amount =
        Number(
          req.body.amount
        );

      if (
        !Number.isFinite(
          amount
        ) ||
        amount === 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_CREDIT_AMOUNT",
        });
      }

      const account =
        await ensureCredits(
          req.params.id
        );

      if (
        amount > 0
      ) {
        account.paidCredits +=
          amount;
      } else {
        let remove =
          Math.abs(
            amount
          );

        const fromPaid =
          Math.min(
            account.paidCredits,
            remove
          );

        account.paidCredits -=
          fromPaid;

        remove -=
          fromPaid;

        const fromPromo =
          Math.min(
            account.promotionalCredits,
            remove
          );

        account.promotionalCredits -=
          fromPromo;

        remove -=
          fromPromo;

        const fromFree =
          Math.min(
            account.freeCredits,
            remove
          );

        account.freeCredits -=
          fromFree;
      }

      account.updatedAt =
        new Date().toISOString();

      const credits =
        await readJson(
          CREDITS_FILE,
          {}
        );

      credits[
        req.params.id
      ] = account;

      await writeJson(
        CREDITS_FILE,
        credits
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
        credits:
          availableCredits(
            account
          ),
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/users/:id/credits",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "CREDIT_ADJUSTMENT_FAILED",
      });
    }
  }
);

/* =========================================================
   ADMIN JOBS
========================================================= */

app.get(
  "/api/admin/jobs",
  requireAdmin,
  async (req, res) => {
    const list =
      Array.from(
        jobs.values()
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

    res.json({
      ok: true,
      jobs:
        list,
    });
  }
);

/* =========================================================
   ADMIN ERRORS
========================================================= */

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

    res.json({
      ok: true,
      errors:
        list.slice(
          0,
          500
        ),
    });
  }
);

/* =========================================================
   ADMIN SECURITY
========================================================= */

app.get(
  "/api/admin/security",
  requireAdmin,
  async (req, res) => {
    const security =
      await readJson(
        SECURITY_FILE,
        {}
      );

    const events =
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
      );

    res.json({
      ok: true,
      events:
        events.slice(
          0,
          300
        ),
    });
  }
);

/* =========================================================
   ADMIN CREDITS
========================================================= */

app.get(
  "/api/admin/credits",
  requireAdmin,
  async (req, res) => {
    const credits =
      await readJson(
        CREDITS_FILE,
        {}
      );

    let issued = 0;
    let consumed = 0;
    let refunded = 0;
    let usable = 0;

    const balances =
      [];

    for (const [
      userId,
      account,
    ] of Object.entries(
      credits
    )) {
      const available =
        availableCredits(
          account
        );

      issued +=
        Number(
          account.freeCredits ||
            0
        ) +
        Number(
          account.paidCredits ||
            0
        ) +
        Number(
          account.promotionalCredits ||
            0
        ) +
        Number(
          account.consumedCredits ||
            0
        );

      consumed +=
        Number(
          account.consumedCredits ||
            0
        );

      refunded +=
        Number(
          account.refundedCredits ||
            0
        );

      usable +=
        available;

      balances.push({
        userId,
        credits:
          available,
      });
    }

    res.json({
      ok: true,
      mamaki: {
        issued,
        consumed,
        refunded,
        usableCredits:
          usable,
        balances,
      },
      replicate: {
        configured:
          Boolean(
            REPLICATE_API_TOKEN
          ),
        usable:
          Boolean(
            REPLICATE_API_TOKEN
          ),
        balanceKnown:
          false,
        balance: null,
        note:
          "Replicate does not expose an authoritative account credit balance through this server endpoint. Provider usage should be checked in the Replicate account.",
      },
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
    const finance =
      await ensureFinance();

    res.json({
      ok: true,
      transactions:
        Object.values(
          finance.transactions ||
            {}
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
      wallet:
        finance.ownerWallet,
    });
  }
);

/* =========================================================
   ADMIN FINANCE MANUAL ENTRY
========================================================= */

app.post(
  "/api/admin/finance",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        cleanText(
          req.body.type,
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

      if (
        !type ||
        !Number.isFinite(
          amount
        ) ||
        amount <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_FINANCE_ENTRY",
        });
      }

      const allowed = [
        "sale",
        "revenue",
        "refund",
        "cost",
        "provider_cost",
      ];

      if (
        !allowed.includes(
          type
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_FINANCE_TYPE",
        });
      }

      await addFinanceTransaction(
        type,
        amount,
        description,
        {
          adminId:
            req.user.id,
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

      res.status(500).json({
        ok: false,
        error:
          "FINANCE_ENTRY_FAILED",
      });
    }
  }
);

/* =========================================================
   ADMIN BILLING DASHBOARD DATA
========================================================= */

app.get(
  "/api/admin/billing",
  requireAdmin,
  async (req, res) => {
    try {
      const pricing =
        await buildPricing();

      const payments =
        await readJson(
          PAYMENTS_FILE,
          {}
        );

      const withdrawals =
        await readJson(
          WITHDRAWALS_FILE,
          {}
        );

      const finance =
        await ensureFinance();

      const wallet =
        finance.ownerWallet;

      const withdrawn =
        Number(
          wallet.withdrawn ||
            0
        );

      const pendingWithdrawals =
        Number(
          wallet.pendingWithdrawals ||
            0
        );

      const availableToWithdraw =
        Math.max(
          0,
          Number(
            wallet.profit ||
              0
          ) -
            withdrawn -
            pendingWithdrawals
        );

      const profitMargin =
        Number(
          wallet.grossRevenue ||
            0
        ) > 0
          ? (
              Number(
                wallet.profit ||
                  0
              ) /
              Number(
                wallet.grossRevenue ||
                  0
              )
            ) *
            100
          : 0;

      res.json({
        ok: true,

        pricing:
          pricing.pricing,

        fx:
          pricing.fx,

        paystack: {
          configured:
            Boolean(
              PAYSTACK_SECRET_KEY
            ),
          publicConfigured:
            Boolean(
              PAYSTACK_PUBLIC_KEY
            ),
          currency:
            PAYSTACK_CURRENCY_DEFAULT,
          fixedMarkupPerUsd:
            FIXED_NGN_MARKUP_PER_USD,
        },

        wallet: {
          ...wallet,
          availableToWithdraw,
          profitMargin,
        },

        payments:
          Object.values(
            payments
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

        withdrawals:
          Object.values(
            withdrawals
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
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/billing",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "ADMIN_BILLING_FAILED",
      });
    }
  }
);

/* =========================================================
   ADMIN OWNER WITHDRAWAL
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
            "Paystack is not configured for withdrawals.",
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
            "INVALID_WITHDRAWAL",
          message:
            "Amount, account name, account number and bank code are required.",
        });
      }

      const finance =
        await ensureFinance();

      const available =
        Math.max(
          0,
          Number(
            finance.ownerWallet
              .profit || 0
          ) -
            Number(
              finance.ownerWallet
                .withdrawn || 0
            ) -
            Number(
              finance.ownerWallet
                .pendingWithdrawals ||
                0
            )
        );

      if (
        amount >
        available
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INSUFFICIENT_PROFIT",
          message:
            "The requested withdrawal is greater than the available MAMAKI profit.",
          available,
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
              }),
          }
        );

      const recipientCode =
        recipient.data
          ?.recipient_code;

      if (!recipientCode) {
        throw new Error(
          "Paystack did not return a transfer recipient code."
        );
      }

      const reference =
        `MAMAKI-WD-${Date.now()}-${randomBytes(
          4
        ).toString("hex")}`;

      const withdrawals =
        await readJson(
          WITHDRAWALS_FILE,
          {}
        );

      withdrawals[
        reference
      ] = {
        reference,
        amount,
        name,
        accountNumber:
          accountNumber.slice(
            -4
          ),
        bankCode,
        status:
          "pending",
        createdAt:
          new Date().toISOString(),
      };

      await writeJson(
        WITHDRAWALS_FILE,
        withdrawals
      );

      finance.ownerWallet.pendingWithdrawals =
        Number(
          finance.ownerWallet
            .pendingWithdrawals ||
            0
        ) + amount;

      await writeJson(
        FINANCE_FILE,
        finance
      );

      try {
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
                    Math.round(
                      amount *
                        100
                    ),
                  recipient:
                    recipientCode,
                  reason:
                    "MAMAKI owner profit withdrawal",
                  reference,
                }),
            }
          );

        withdrawals[
          reference
        ].status =
          transfer.data
            ?.status ||
          "processing";

        withdrawals[
          reference
        ].paystack =
          transfer.data ||
          null;

        await writeJson(
          WITHDRAWALS_FILE,
          withdrawals
        );

        finance.ownerWallet.pendingWithdrawals =
          Math.max(
            0,
            Number(
              finance.ownerWallet
                .pendingWithdrawals ||
                0
            ) - amount
          );

        finance.ownerWallet.withdrawn =
          Number(
            finance.ownerWallet
              .withdrawn ||
              0
          ) + amount;

        await writeJson(
          FINANCE_FILE,
          finance
        );

        await recordSecurityEvent(
          "OWNER_WITHDRAWAL",
          {
            adminId:
              req.user.id,
            reference,
            amount,
          }
        );

        return res.json({
          ok: true,
          message:
            "Owner profit withdrawal submitted to Paystack.",
          reference,
          status:
            withdrawals[
              reference
            ].status,
        });
      } catch (transferError) {
        withdrawals[
          reference
        ].status =
          "failed";

        withdrawals[
          reference
        ].error =
          String(
            transferError?.message ||
              transferError
          );

        await writeJson(
          WITHDRAWALS_FILE,
          withdrawals
        );

        finance.ownerWallet.pendingWithdrawals =
          Math.max(
            0,
            Number(
              finance.ownerWallet
                .pendingWithdrawals ||
                0
            ) - amount
          );

        await writeJson(
          FINANCE_FILE,
          finance
        );

        throw transferError;
      }
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/withdraw",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          error.code ||
          "WITHDRAWAL_FAILED",
        message:
          error.message ||
          "Unable to process the owner withdrawal.",
      });
    }
  }
);

/* =========================================================
   ADMIN DASHBOARD
   PRIVATE - NOT EXPOSED THROUGH NORMAL USER INTERFACE
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
<meta name="robots" content="noindex,nofollow,noarchive">
<title>MAMAKI AI — Private Administrator Dashboard</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  background:#050509;
  color:#f4f4f7;
  font-family:Arial,Helvetica,sans-serif;
}
main{
  max-width:1500px;
  margin:auto;
  padding:24px;
}
.card{
  background:#111118;
  border:1px solid #272733;
  border-radius:18px;
  padding:20px;
  margin-bottom:18px;
}
h1,h2,h3{margin-top:0}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:14px;
}
.stat{
  background:#0c0c12;
  border:1px solid #24242f;
  border-radius:14px;
  padding:16px;
}
.stat b{
  display:block;
  font-size:28px;
  margin-top:8px;
}
input,select,button{
  width:100%;
  padding:12px;
  border-radius:10px;
  border:1px solid #30303c;
  background:#09090e;
  color:#fff;
  margin-top:8px;
}
button{
  cursor:pointer;
  font-weight:700;
  background:#f4f4f7;
  color:#050509;
}
table{
  width:100%;
  border-collapse:collapse;
  min-width:900px;
}
th,td{
  text-align:left;
  padding:10px;
  border-bottom:1px solid #252531;
}
.scroll{
  overflow:auto;
}
.hidden{
  display:none!important;
}
.muted{
  color:#a8a8b5;
}
.row{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:10px;
}
.danger{
  color:#ff8b8b;
}
.success{
  color:#8dffb1;
}
</style>
</head>
<body>
<main>

<section id="login" class="card">
  <h1>🔐 MAMAKI Administrator</h1>
  <p class="muted">Private administrator access.</p>
  <input id="email" type="email" placeholder="Administrator email">
  <input id="password" type="password" placeholder="Administrator password">
  <button onclick="login()">Login</button>
  <p id="msg" class="danger"></p>
</section>

<section id="actions" class="card hidden">
  <button onclick="loadAll()">Refresh Dashboard</button>
  <button onclick="logout()">Logout</button>
</section>

<section id="dash" class="hidden">

<div class="card">
<h1>✨ MAMAKI AI Control Center</h1>
<p class="muted">Private business, usage, security, billing and infrastructure monitoring.</p>
</div>

<section class="grid">
<div class="stat">Total Users<b id="users">0</b></div>
<div class="stat">Active Users<b id="active">0</b></div>
<div class="stat">New Today<b id="today">0</b></div>
<div class="stat">New This Week<b id="week">0</b></div>
<div class="stat">New This Month<b id="month">0</b></div>
<div class="stat">Admins<b id="admins">0</b></div>
<div class="stat">Videos Generated<b id="videos">0</b></div>
<div class="stat">AI Seconds<b id="seconds">0</b></div>
<div class="stat">Narrations<b id="narrations">0</b></div>
<div class="stat">Projects<b id="projects">0</b></div>
<div class="stat">Completed Jobs<b id="completed">0</b></div>
<div class="stat">Processing Jobs<b id="processing">0</b></div>
<div class="stat">Failed Jobs<b id="failed">0</b></div>
</section>

<section class="card">
<h2>💰 Business & Finance</h2>
<div class="grid">
<div class="stat">Gross Revenue<b id="gross">₦0</b></div>
<div class="stat">Refunds<b id="refunds">₦0</b></div>
<div class="stat">Costs<b id="costs">₦0</b></div>
<div class="stat">Profit<b id="profit">₦0</b></div>
<div class="stat">Withdrawn<b id="withdrawn">₦0</b></div>
<div class="stat">Pending Withdrawals<b id="pending">₦0</b></div>
<div class="stat">Available to Withdraw<b id="available">₦0</b></div>
<div class="stat">Profit Margin<b id="margin">0%</b></div>
</div>
</section>

<section class="card">
<h2>💳 Paystack & Smart Pricing</h2>
<div class="grid">
<div class="stat">Paystack Status<b id="paystatus">—</b></div>
<div class="stat">Live USD/NGN<b id="fx">—</b></div>
<div class="stat">Markup<b id="markup">—</b></div>
<div class="stat">Target Margin<b id="targetmargin">—</b></div>
</div>
<p id="fxnote" class="muted"></p>
<div class="scroll">
<table>
<thead>
<tr>
<th>Credits</th>
<th>Provider Cost USD</th>
<th>USD Price</th>
<th>User Price</th>
<th>FX</th>
<th>Margin Target</th>
</tr>
</thead>
<tbody id="pricing"></tbody>
</table>
</div>
</section>

<section class="card">
<h2>🤖 Replicate</h2>
<div class="grid">
<div class="stat">Configuration<b id="repstatus">—</b></div>
<div class="stat">Provider Balance<b id="rep">Unknown</b></div>
<div class="stat">AI Availability<b id="aiavail">—</b></div>
<div class="stat">T2V Model<b id="t2v">—</b></div>
<div class="stat">I2V Model<b id="i2v">—</b></div>
</div>
<p id="repnote" class="muted"></p>
</section>

<section class="card">
<h2>🪙 MAMAKI Credits</h2>
<div class="grid">
<div class="stat">Issued<b id="issued">0</b></div>
<div class="stat">Consumed<b id="consumed">0</b></div>
<div class="stat">Refunded<b id="crefund">0</b></div>
<div class="stat">Current Balances<b id="credits">0</b></div>
<div class="stat">Usable Credits<b id="usable">0</b></div>
</div>
</section>

<section class="card">
<h2>⚙️ System</h2>
<div class="grid">
<div class="stat">Server<b id="server">—</b></div>
<div class="stat">FFmpeg<b id="ffmpeg">—</b></div>
<div class="stat">Authentication<b id="auth">—</b></div>
<div class="stat">Storage<b id="storage">—</b></div>
<div class="stat">Recovery<b id="recovery">—</b></div>
<div class="stat">Uptime<b id="uptime">—</b></div>
</div>
</section>

<section class="card">
<h2>👥 Users</h2>
<div class="scroll">
<table>
<thead>
<tr>
<th>Name</th>
<th>Email</th>
<th>Role</th>
<th>Credits</th>
<th>AI Generations</th>
<th>AI Seconds</th>
<th>Studio Jobs</th>
<th>Narration Jobs</th>
<th>Last Active</th>
<th>Status</th>
</tr>
</thead>
<tbody id="utable"></tbody>
</table>
</div>
</section>

<section class="card">
<h2>🛠 Manual Credit Adjustment</h2>
<div class="row">
<input id="uid" placeholder="User ID">
<input id="amount" type="number" placeholder="Credits (+/-)">
<button onclick="adjustCredits()">Adjust Credits</button>
</div>
<p id="cmsg"></p>
</section>

<section class="card">
<h2>📒 Manual Finance Entry</h2>
<div class="row">
<select id="ftype">
<option value="sale">Sale</option>
<option value="revenue">Revenue</option>
<option value="refund">Refund</option>
<option value="cost">Cost</option>
<option value="provider_cost">Provider Cost</option>
</select>
<input id="famount" type="number" placeholder="Amount ₦">
<input id="fdesc" placeholder="Description">
<button onclick="finance()">Record</button>
</div>
<p id="fmsg"></p>
</section>

<section class="card">
<h2>🏦 Owner Profit Withdrawal</h2>
<div class="row">
<input id="wamount" type="number" placeholder="Amount ₦">
<input id="wname" placeholder="Account Name">
<input id="waccount" placeholder="Account Number">
<input id="wbank" placeholder="Bank Code">
<button onclick="withdraw()">Withdraw</button>
</div>
<p id="wmsg"></p>
</section>

<section class="card">
<h2>💳 Payment History</h2>
<div class="scroll">
<table>
<thead>
<tr>
<th>Date</th>
<th>Reference</th>
<th>User</th>
<th>Credits</th>
<th>Amount</th>
<th>Status</th>
</tr>
</thead>
<tbody id="payments"></tbody>
</table>
</div>
</section>

<section class="card">
<h2>💸 Withdrawal History</h2>
<div class="scroll">
<table>
<thead>
<tr>
<th>Date</th>
<th>Reference</th>
<th>Amount</th>
<th>Account</th>
<th>Status</th>
</tr>
</thead>
<tbody id="withdrawals"></tbody>
</table>
</div>
</section>

<section class="card">
<h2>🎬 Jobs</h2>
<div class="scroll">
<table>
<thead>
<tr>
<th>ID</th>
<th>User</th>
<th>Status</th>
<th>Progress</th>
<th>Duration</th>
<th>Credits</th>
<th>Message</th>
<th>Date</th>
</tr>
</thead>
<tbody id="jobs"></tbody>
</table>
</div>
</section>

<section class="card">
<h2>🔒 Security Events</h2>
<div class="scroll">
<table>
<thead>
<tr>
<th>Date</th>
<th>Type</th>
<th>Email</th>
<th>User</th>
<th>Method</th>
</tr>
</thead>
<tbody id="security"></tbody>
</table>
</div>
</section>

<section class="card">
<h2>🚨 Errors</h2>
<div class="scroll">
<table>
<thead>
<tr>
<th>Date</th>
<th>Code</th>
<th>Message</th>
<th>Route</th>
</tr>
</thead>
<tbody id="errors"></tbody>
</table>
</div>
</section>

<section class="card">
<h2>📒 Finance Transactions</h2>
<div class="scroll">
<table>
<thead>
<tr>
<th>Date</th>
<th>Type</th>
<th>Amount</th>
<th>Description</th>
</tr>
</thead>
<tbody id="fin"></tbody>
</table>
</div>
</section>

</section>

<script>
let token =
  localStorage.getItem(
    "mamaki_admin_token"
  ) || "";

const $ =
  (x) =>
    document.getElementById(
      x
    );

const hdr = () => ({
  Authorization:
    "Bearer " + token
});

async function get(url) {
  const response =
    await fetch(
      url,
      {
        headers:
          hdr()
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data.message ||
      data.error ||
      "Request failed"
    );
  }

  return data;
}

function esc(value) {
  return String(
    value ?? ""
  ).replace(
    /[&<>"]/g,
    (m) =>
      ({
        "&":
          "&amp;",
        "<":
          "&lt;",
        ">":
          "&gt;",
        "\"":
          "&quot;"
      }[m] || m)
  );
}

function money(n) {
  return (
    "₦" +
    Number(
      n || 0
    ).toLocaleString(
      undefined,
      {
        maximumFractionDigits:
          2
      }
    )
  );
}

function dt(v) {
  if (!v) return "—";

  const d =
    new Date(v);

  return Number.isNaN(
    d.getTime()
  )
    ? esc(v)
    : d.toLocaleString();
}

function set(
  id,
  value
) {
  $(id).textContent =
    value;
}

async function login() {
  try {
    const response =
      await fetch(
        "/api/admin/login",
        {
          method:
            "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body:
            JSON.stringify({
              email:
                $("email")
                  .value,
              password:
                $("password")
                  .value
            })
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      !data.ok
    ) {
      throw new Error(
        data.message ||
        "Invalid credentials"
      );
    }

    token =
      data.token;

    localStorage.setItem(
      "mamaki_admin_token",
      token
    );

    $("login")
      .classList
      .add(
        "hidden"
      );

    $("dash")
      .classList
      .remove(
        "hidden"
      );

    $("actions")
      .classList
      .remove(
        "hidden"
      );

    loadAll();
  } catch (error) {
    $("msg")
      .textContent =
      error.message;
  }
}

async function logout() {
  try {
    await fetch(
      "/api/auth/logout",
      {
        method:
          "POST",
        headers:
          hdr()
      }
    );
  } catch {}

  localStorage.removeItem(
    "mamaki_admin_token"
  );

  location.reload();
}

async function loadAll() {
  if (!token)
    return;

  try {
    const [
      s,
      u,
      j,
      e,
      sec,
      c,
      f,
      b
    ] =
      await Promise.all([
        get(
          "/api/admin/stats"
        ),
        get(
          "/api/admin/users"
        ),
        get(
          "/api/admin/jobs"
        ),
        get(
          "/api/admin/errors"
        ),
        get(
          "/api/admin/security"
        ),
        get(
          "/api/admin/credits"
        ),
        get(
          "/api/admin/finance"
        ),
        get(
          "/api/admin/billing"
        )
      ]);

    const st =
      s.stats;

    const users =
      u.users || [];

    set(
      "users",
      st.totalUsers
    );

    set(
      "active",
      users.filter(
        x =>
          !x.disabled &&
          x.lastActiveAt &&
          Date.now() -
            Date.parse(
              x.lastActiveAt
            ) <
            15 *
              60 *
              1000
      ).length
    );

    set(
      "today",
      users.filter(
        x =>
          Date.now() -
            Date.parse(
              x.createdAt ||
                0
            ) <
          86400000
      ).length
    );

    set(
      "week",
      users.filter(
        x =>
          Date.now() -
            Date.parse(
              x.createdAt ||
                0
            ) <
          7 *
            86400000
      ).length
    );

    set(
      "month",
      users.filter(
        x =>
          Date.now() -
            Date.parse(
              x.createdAt ||
                0
            ) <
          30 *
            86400000
      ).length
    );

    set(
      "admins",
      users.filter(
        x =>
          x.role ===
          "admin"
      ).length
    );

    set(
      "videos",
      st.aiGenerations
    );

    set(
      "seconds",
      st.aiSeconds
    );

    set(
      "narrations",
      st.narrationJobs
    );

    set(
      "projects",
      st.totalProjects
    );

    const jobs =
      j.jobs || [];

    set(
      "completed",
      jobs.filter(
        x =>
          x.status ===
          "completed"
      ).length
    );

    set(
      "processing",
      jobs.filter(
        x =>
          [
            "queued",
            "processing"
          ].includes(
            x.status
          )
      ).length
    );

    set(
      "failed",
      jobs.filter(
        x =>
          x.status ===
          "failed"
      ).length
    );

    set(
      "gross",
      money(
        b.wallet
          .grossRevenue
      )
    );

    set(
      "refunds",
      money(
        b.wallet
          .refunds
      )
    );

    set(
      "costs",
      money(
        b.wallet
          .costs
      )
    );

    set(
      "profit",
      money(
        b.wallet
          .profit
      )
    );

    set(
      "withdrawn",
      money(
        b.wallet
          .withdrawn
      )
    );

    set(
      "pending",
      money(
        b.wallet
          .pendingWithdrawals
      )
    );

    set(
      "available",
      money(
        b.wallet
          .availableToWithdraw
      )
    );

    set(
      "margin",
      Number(
        b.wallet
          .profitMargin ||
          0
      ).toFixed(
        2
      ) +
        "%"
    );

    set(
      "fx",
      b.fx?.rate
        ? "₦" +
            Number(
              b.fx.rate
            ).toFixed(
              2
            )
        : "—"
    );

    set(
      "fxnote",
      (b.fx?.live
        ? "Live FX rate"
        : "Fallback FX rate") +
        " · " +
        dt(
          b.fx?.updatedAt
        )
    );

    set(
      "targetmargin",
      Number(
        (
          b.pricing?.[0]
            ?.marginTarget ||
          0
        )
      ) *
        100 +
        "%"
    );

    set(
      "markup",
      b.paystack
        ?.fixedMarkupPerUsd !=
        null
        ? "₦" +
            Number(
              b.paystack
                .fixedMarkupPerUsd
            ).toLocaleString() +
            " / USD"
        : "—"
    );

    set(
      "paystatus",
      b.paystack
        ?.configured
        ? "Configured"
        : "Not configured"
    );

    set(
      "issued",
      c.mamaki
        .issued
    );

    set(
      "consumed",
      c.mamaki
        .consumed
    );

    set(
      "crefund",
      c.mamaki
        .refunded
    );

    set(
      "credits",
      (
        c.mamaki
          .balances ||
        []
      ).reduce(
        (a, x) =>
          a +
          Number(
            x.credits ||
              0
          ),
        0
      )
    );

    set(
      "usable",
      c.mamaki
        .usableCredits
    );

    set(
      "rep",
      c.replicate
        .balanceKnown
        ? "$" +
            Number(
              c.replicate
                .balance ||
                0
            ).toFixed(
              2
            )
        : "Unknown"
    );

    set(
      "repnote",
      c.replicate
        .note ||
        "No authoritative provider balance available."
    );

    set(
      "repstatus",
      c.replicate
        .configured
        ? "Configured"
        : "Not configured"
    );

    set(
      "aiavail",
      c.replicate
        .usable
        ? "Ready"
        : "Blocked / unavailable"
    );

    set(
      "t2v",
      ${JSON.stringify(T2V_MODEL)}
    );

    set(
      "i2v",
      ${JSON.stringify(I2V_MODEL)}
    );

    set(
      "server",
      "✓ Healthy"
    );

    set(
      "ffmpeg",
      "✓ Ready"
    );

    set(
      "auth",
      "✓ Active"
    );

    set(
      "storage",
      "✓ Healthy"
    );

    set(
      "recovery",
      st.recoveryConfigured
        ? "Configured"
        : "Not configured"
    );

    set(
      "uptime",
      Math.round(
        st.uptime
      ) +
        " sec"
    );

    $("utable")
      .innerHTML =
      users
        .map(
          x =>
            "<tr>" +
            "<td>" +
            esc(x.name) +
            "</td>" +
            "<td>" +
            esc(x.email) +
            "</td>" +
            "<td>" +
            esc(x.role) +
            "</td>" +
            "<td>" +
            x.credits +
            "</td>" +
            "<td>" +
            Number(
              x.usage
                ?.aiGenerations ||
                0
            ) +
            "</td>" +
            "<td>" +
            Number(
              x.usage
                ?.aiSeconds ||
                0
            ) +
            "</td>" +
            "<td>" +
            Number(
              x.usage
                ?.studioJobs ||
                0
            ) +
            "</td>" +
            "<td>" +
            Number(
              x.usage
                ?.narrationJobs ||
                0
            ) +
            "</td>" +
            "<td>" +
            dt(
              x.lastActiveAt
            ) +
            "</td>" +
            "<td>" +
            (!x.disabled
              ? "Active"
              : "Disabled") +
            "</td>" +
            "</tr>"
        )
        .join("");

    $("jobs")
      .innerHTML =
      jobs
        .map(
          x =>
            "<tr>" +
            "<td>" +
            esc(x.id) +
            "</td>" +
            "<td>" +
            esc(
              x.userId
            ) +
            "</td>" +
            "<td>" +
            esc(
              x.status
            ) +
            "</td>" +
            "<td>" +
            Number(
              x.progress ||
                0
            ) +
            "%</td>" +
            "<td>" +
            esc(
              x.duration
            ) +
            "s</td>" +
            "<td>" +
            esc(
              x.creditCost ||
                x.credits ||
                "—"
            ) +
            "</td>" +
            "<td>" +
            esc(
              x.message ||
                x.error ||
                ""
            ) +
            "</td>" +
            "<td>" +
            dt(
              x.createdAt
            ) +
            "</td>" +
            "</tr>"
        )
        .join("") ||
      '<tr><td colspan="8">No jobs</td></tr>';

    $("security")
      .innerHTML =
      (sec.events ||
        [])
        .map(
          x =>
            "<tr>" +
            "<td>" +
            dt(
              x.createdAt
            ) +
            "</td>" +
            "<td>" +
            esc(
              x.type ||
                x.event
            ) +
            "</td>" +
            "<td>" +
            esc(
              x.email ||
                x.details?.email ||
                ""
            ) +
            "</td>" +
            "<td>" +
            esc(
              x.userId ||
                x.details?.userId ||
                ""
            ) +
            "</td>" +
            "<td>" +
            esc(
              x.method ||
                x.details?.method ||
                ""
            ) +
            "</td>" +
            "</tr>"
        )
        .join("") ||
      '<tr><td colspan="5">No security events</td></tr>';

    $("errors")
      .innerHTML =
      (e.errors ||
        [])
        .map(
          x =>
            "<tr>" +
            "<td>" +
            dt(
              x.createdAt
            ) +
            "</td>" +
            "<td>" +
            esc(x.code) +
            "</td>" +
            "<td>" +
            esc(
              x.message
            ) +
            "</td>" +
            "<td>" +
            esc(
              x.context
                ?.route ||
                ""
            ) +
            "</td>" +
            "</tr>"
        )
        .join("") ||
      '<tr><td colspan="4">No errors</td></tr>';

    $("fin")
      .innerHTML =
      (f.transactions ||
        [])
        .map(
          x =>
            "<tr>" +
            "<td>" +
            dt(
              x.createdAt
            ) +
            "</td>" +
            "<td>" +
            esc(x.type) +
            "</td>" +
            "<td>" +
            money(
              x.amount
            ) +
            "</td>" +
            "<td>" +
            esc(
              x.description
            ) +
            "</td>" +
            "</tr>"
        )
        .join("") ||
      '<tr><td colspan="4">No transactions</td></tr>';

    $("pricing")
      .innerHTML =
      (b.pricing ||
        [])
        .map(
          x =>
            "<tr>" +
            "<td>" +
            x.credits +
            "</td>" +
            "<td>$" +
            Number(
              x.providerCostUsd
            ).toFixed(
              4
            ) +
            "</td>" +
            "<td>$" +
            Number(
              x.usdPrice
            ).toFixed(
              2
            ) +
            "</td>" +
            "<td>" +
            money(
              x.amount
            ) +
            "</td>" +
            "<td>" +
            Number(
              x.fxRate
            ).toFixed(
              2
            ) +
            "</td>" +
            "<td>" +
            Number(
              x.marginTarget *
                100
            ).toFixed(
              0
            ) +
            "%</td>" +
            "</tr>"
        )
        .join("");

    $("payments")
      .innerHTML =
      (b.payments ||
        [])
        .map(
          x =>
            "<tr>" +
            "<td>" +
            dt(
              x.createdAt
            ) +
            "</td>" +
            "<td>" +
            esc(
              x.reference
            ) +
            "</td>" +
            "<td>" +
            esc(
              x.userId
            ) +
            "</td>" +
            "<td>" +
            x.credits +
            "</td>" +
            "<td>" +
            esc(
              x.currency
            ) +
            " " +
            Number(
              x.amount ||
                0
            ).toLocaleString() +
            "</td>" +
            "<td>" +
            esc(
              x.status
            ) +
            "</td>" +
            "</tr>"
        )
        .join("") ||
      '<tr><td colspan="6">No payments yet</td></tr>';

    $("withdrawals")
      .innerHTML =
      (b.withdrawals ||
        [])
        .map(
          x =>
            "<tr>" +
            "<td>" +
            dt(
              x.createdAt
            ) +
            "</td>" +
            "<td>" +
            esc(
              x.reference
            ) +
            "</td>" +
            "<td>" +
            money(
              x.amount
            ) +
            "</td>" +
            "<td>****" +
            esc(
              x.accountNumber
            ) +
            "</td>" +
            "<td>" +
            esc(
              x.status
            ) +
            "</td>" +
            "</tr>"
        )
        .join("") ||
      '<tr><td colspan="5">No withdrawals yet</td></tr>';
  } catch (error) {
    $("msg")
      .textContent =
      error.message;
  }
}

async function adjustCredits() {
  try {
    const response =
      await fetch(
        "/api/admin/users/" +
          encodeURIComponent(
            $("uid").value
          ) +
          "/credits",
        {
          method:
            "POST",
          headers:
            Object.assign(
              {
                "Content-Type":
                  "application/json"
              },
              hdr()
            ),
          body:
            JSON.stringify({
              amount:
                Number(
                  $("amount")
                    .value
                )
            })
        }
      );

    const data =
      await response.json();

    $("cmsg")
      .textContent =
      data.ok
        ? "Credits: " +
          data.credits
        : data.message ||
          data.error;

    loadAll();
  } catch (error) {
    $("cmsg")
      .textContent =
      error.message;
  }
}

async function finance() {
  try {
    const response =
      await fetch(
        "/api/admin/finance",
        {
          method:
            "POST",
          headers:
            Object.assign(
              {
                "Content-Type":
                  "application/json"
              },
              hdr()
            ),
          body:
            JSON.stringify({
              type:
                $("ftype")
                  .value,
              amount:
                Number(
                  $("famount")
                    .value
                ),
              description:
                $("fdesc")
                  .value
            })
        }
      );

    const data =
      await response.json();

    $("fmsg")
      .textContent =
      data.ok
        ? "Recorded"
        : data.message ||
          data.error;

    loadAll();
  } catch (error) {
    $("fmsg")
      .textContent =
      error.message;
  }
}

async function withdraw() {
  if (
    !confirm(
      "Withdraw this amount from the MAMAKI owner wallet?"
    )
  ) {
    return;
  }

  try {
    const response =
      await fetch(
        "/api/admin/withdraw",
        {
          method:
            "POST",
          headers:
            Object.assign(
              {
                "Content-Type":
                  "application/json"
              },
              hdr()
            ),
          body:
            JSON.stringify({
              amount:
                Number(
                  $("wamount")
                    .value
                ),
              name:
                $("wname")
                  .value,
              accountNumber:
                $("waccount")
                  .value,
              bankCode:
                $("wbank")
                  .value
            })
        }
      );

    const data =
      await response.json();

    $("wmsg")
      .textContent =
      data.ok
        ? data.message
        : data.message ||
          data.error;

    loadAll();
  } catch (error) {
    $("wmsg")
      .textContent =
      error.message;
  }
}

if (token) {
  $("login")
    .classList
    .add(
      "hidden"
    );

  $("dash")
    .classList
    .remove(
      "hidden"
    );

  $("actions")
    .classList
    .remove(
      "hidden"
    );

  loadAll();
}
</script>

</main>
</body>
</html>
`);
  }
);

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  async (req, res) => {
    res.sendFile(
      path.join(
        ROOT,
        "index.html"
      )
    );
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
  10 * 60 * 1000
);

/* =========================================================
   START
========================================================= */

await ensureStorage();
await ensureFinance();

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
      `Password recovery configured: ${Boolean(
        RESEND_API_KEY &&
          RESEND_FROM
      )}`
    );

    console.log(
      `Paystack configured: ${Boolean(
        PAYSTACK_SECRET_KEY
      )}`
    );
  }
);
