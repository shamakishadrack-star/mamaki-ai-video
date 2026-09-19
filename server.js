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
const VERSION = "18.2.0";

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
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const SESSION_SECRET = String(process.env.SESSION_SECRET || "");
const REPLICATE_API_TOKEN =
  String(process.env.REPLICATE_API_TOKEN || "").trim();
const PAYSTACK_SECRET_KEY =
  String(process.env.PAYSTACK_SECRET_KEY || "").trim();
const PAYSTACK_PUBLIC_KEY =
  String(process.env.PAYSTACK_PUBLIC_KEY || "").trim();

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
  Number(process.env.MAMAKI_FIXED_NGN_MARKUP_PER_USD || 200)
);

const RESEND_API_KEY =
  String(process.env.RESEND_API_KEY || "").trim();

const RESEND_FROM =
  String(process.env.RESEND_FROM || "").trim();

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
  if (
    req.path === "/admin" ||
    req.path.startsWith("/api/admin/")
  ) {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
  }

  res.setHeader("X-MAMAKI-Version", VERSION);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");

  next();
});

async function ensureDir(dir) {
  await fs.mkdir(dir, {
    recursive: true,
  });
}

async function ensureStorage() {
  await Promise.all([
    ensureDir(TMP),
    ensureDir(OUTPUTS),
    ensureDir(PROJECTS),
    ensureDir(DATA),
  ]);

  const defaults = [
    [USERS_FILE, {}],
    [SESSIONS_FILE, {}],
    [ERRORS_FILE, {}],
    [USAGE_FILE, {}],
    [RESET_FILE, {}],
    [SECURITY_FILE, {}],
    [
      CREDITS_FILE,
      {
        pool: 0,
        users: {},
        transactions: [],
        updatedAt: new Date().toISOString(),
      },
    ],
    [
      FINANCE_FILE,
      {
        transactions: [],
      },
    ],
    [
      PRICING_FILE,
      {
        updatedAt: new Date().toISOString(),
      },
    ],
    [
      PAYMENTS_FILE,
      {
        transactions: [],
      },
    ],
    [
      WITHDRAWALS_FILE,
      {
        withdrawals: [],
      },
    ],
  ];

  for (const [file, value] of defaults) {
    try {
      await fs.access(file);
    } catch {
      await writeJson(file, value);
    }
  }
}

async function readJson(file, fallback) {
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

async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify(value, null, 2),
    "utf8"
  );

  await fs.rename(temp, file);
}

function cleanText(value, max = 5000) {
  return String(value ?? "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, max);
}

function normalizeEmail(value) {
  return cleanText(value, 320).toLowerCase();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function money(value) {
  return `₦${Math.round(safeNumber(value)).toLocaleString(
    "en-NG"
  )}`;
}

function isoNow() {
  return new Date().toISOString();
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

function verifyPassword(password, salt, expectedHash) {
  try {
    const actual = scryptSync(
      String(password),
      String(salt),
      64
    );

    const expected = Buffer.from(
      String(expectedHash),
      "hex"
    );

    return (
      expected.length === actual.length &&
      timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}

function createSessionToken(userId, role) {
  const payload = {
    userId,
    role,
    iat: Date.now(),
    nonce: randomBytes(16).toString("hex"),
  };

  const body = Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url");

  const sig = createHmac(
    "sha256",
    SESSION_SECRET || "mamaki-development-secret"
  )
    .update(body)
    .digest("base64url");

  return `${body}.${sig}`;
}

function decodeSessionToken(token) {
  try {
    const [body, sig] = String(token || "").split(".");

    if (!body || !sig) return null;

    const expected = createHmac(
      "sha256",
      SESSION_SECRET || "mamaki-development-secret"
    )
      .update(body)
      .digest("base64url");

    const a = Buffer.from(sig);
    const b = Buffer.from(expected);

    if (
      a.length !== b.length ||
      !timingSafeEqual(a, b)
    ) {
      return null;
    }

    return JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    );
  } catch {
    return null;
  }
}

async function createSession(userId, role) {
  const token = createSessionToken(userId, role);
  const sessions = await readJson(SESSIONS_FILE, {});

  sessions[token] = {
    userId,
    role,
    createdAt: isoNow(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };

  await writeJson(SESSIONS_FILE, sessions);

  return token;
}

async function getSession(token) {
  if (!token) return null;

  const decoded = decodeSessionToken(token);

  if (!decoded) return null;

  const sessions = await readJson(
    SESSIONS_FILE,
    {}
  );

  const session = sessions[token];

  if (!session) return null;

  if (
    Number(session.expiresAt || 0) < Date.now()
  ) {
    delete sessions[token];
    await writeJson(SESSIONS_FILE, sessions);
    return null;
  }

  return {
    ...session,
    token,
  };
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
    await writeJson(SESSIONS_FILE, sessions);
  }
}

async function getRequestSession(req) {
  const auth = String(
    req.headers.authorization || ""
  );

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  return getSession(
    auth.slice("Bearer ".length).trim()
  );
}

async function requireAuth(req, res, next) {
  const session = await getRequestSession(req);

  if (!session) {
    return res.status(401).json({
      ok: false,
      error: "AUTH_REQUIRED",
      message: "Please log in.",
    });
  }

  const users = await readJson(
    USERS_FILE,
    {}
  );

  const user = users[session.userId];

  if (!user || user.disabled) {
    return res.status(401).json({
      ok: false,
      error: "ACCOUNT_DISABLED",
      message: "Account unavailable.",
    });
  }

  req.user = user;
  req.session = session;

  next();
}

async function requireAdmin(req, res, next) {
  const session = await getRequestSession(req);

  if (!session) {
    return res.status(401).json({
      ok: false,
      error: "AUTH_REQUIRED",
      message: "Administrator login required.",
    });
  }

  const users = await readJson(
    USERS_FILE,
    {}
  );

  const user = users[session.userId];

  if (
    !user ||
    user.disabled ||
    user.role !== "admin"
  ) {
    return res.status(403).json({
      ok: false,
      error: "ADMIN_REQUIRED",
      message: "Administrator access required.",
    });
  }

  req.user = user;
  req.session = session;

  next();
}

async function recordError(error, context = {}) {
  try {
    const errors = await readJson(
      ERRORS_FILE,
      {}
    );

    const id = randomUUID();

    errors[id] = {
      id,
      message: String(
        error?.message || error || "Unknown error"
      ).slice(0, 2000),
      stack: String(
        error?.stack || ""
      ).slice(0, 6000),
      context,
      createdAt: isoNow(),
    };

    const ids = Object.keys(errors);

    if (ids.length > 500) {
      ids.sort(
        (a, b) =>
          String(errors[a].createdAt).localeCompare(
            String(errors[b].createdAt)
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
  } catch {}
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
      createdAt: isoNow(),
      ...details,
    };

    const ids = Object.keys(security);

    if (ids.length > 300) {
      ids.sort(
        (a, b) =>
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
  } catch {}
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
   BASIC SYSTEM
========================================================= */

app.get("/health", async (req, res) => {
  const checks = {
    server: true,
    ffmpeg: Boolean(ffmpegPath),
    replicateConfigured:
      Boolean(REPLICATE_API_TOKEN),
    adminConfigured:
      Boolean(
        ADMIN_EMAIL &&
          ADMIN_PASSWORD &&
          SESSION_SECRET
      ),
    paystackConfigured:
      Boolean(PAYSTACK_SECRET_KEY),
    recoveryConfigured:
      Boolean(
        RESEND_API_KEY &&
          RESEND_FROM
      ),
    storage: true,
    authentication: true,
  };

  res.json({
    ok: true,
    status: "healthy",
    service:
      "MAMAKI AI Video Creative Studio",
    version: VERSION,
    uptime: process.uptime(),
    timestamp: isoNow(),
    checks,
    models: {
      textToVideo: T2V_MODEL,
      imageToVideo: I2V_MODEL,
    },
  });
});

/* =========================================================
   CREDITS
========================================================= */

const STARTER_CREDITS = Math.max(
  0,
  Number(
    process.env.STARTER_CREDITS || 100
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
  const d = await readJson(
    CREDITS_FILE,
    {}
  );

  return {
    pool: Number(d?.pool || 0),
    users:
      d &&
      typeof d.users === "object" &&
      d.users
        ? d.users
        : {},
    transactions:
      Array.isArray(d?.transactions)
        ? d.transactions
        : [],
    updatedAt:
      d?.updatedAt ||
      isoNow(),
  };
}

async function writeCredits(data) {
  data.updatedAt = isoNow();

  await writeJson(
    CREDITS_FILE,
    data
  );
}

async function getUserCredits(userId) {
  const data = await readCredits();

  if (!data.users[userId]) {
    data.users[userId] = {
      freeCredits: STARTER_CREDITS,
      promotionalCredits: 0,
      paidCredits: 0,
      consumedCredits: 0,
      refundedCredits: 0,
      updatedAt: isoNow(),
    };

    await writeCredits(data);
  }

  return data.users[userId];
}

function usableCredits(account) {
  return (
    Number(account.freeCredits || 0) +
    Number(account.promotionalCredits || 0) +
    Number(account.paidCredits || 0)
  );
}

async function consumeCredits(
  userId,
  amount,
  reason = "AI generation"
) {
  const needed = Math.max(
    0,
    Math.ceil(
      Number(amount || 0)
    )
  );

  if (!needed) {
    return {
      ok: true,
      used: {
        freeCredits: 0,
        promotionalCredits: 0,
        paidCredits: 0,
      },
    };
  }

  const data =
    await readCredits();

  const account =
    data.users[userId] ||
    {
      freeCredits:
        STARTER_CREDITS,
      promotionalCredits: 0,
      paidCredits: 0,
      consumedCredits: 0,
      refundedCredits: 0,
      updatedAt: isoNow(),
    };

  if (
    usableCredits(account) <
    needed
  ) {
    return {
      ok: false,
      error: "INSUFFICIENT_CREDITS",
      message:
        "You do not have enough MAMAKI credits.",
      required: needed,
      available:
        usableCredits(account),
    };
  }

  let remaining = needed;

  const used = {
    freeCredits: 0,
    promotionalCredits: 0,
    paidCredits: 0,
  };

  for (const bucket of [
    "freeCredits",
    "promotionalCredits",
    "paidCredits",
  ]) {
    const available = Number(
      account[bucket] || 0
    );

    const take = Math.min(
      available,
      remaining
    );

    account[bucket] =
      available - take;

    used[bucket] = take;

    remaining -= take;

    if (remaining <= 0) {
      break;
    }
  }

  account.consumedCredits =
    Number(
      account.consumedCredits || 0
    ) + needed;

  account.updatedAt = isoNow();

  data.users[userId] =
    account;

  data.transactions.push({
    id: randomUUID(),
    type: "credit_consumed",
    userId,
    amount: needed,
    reason,
    used,
    createdAt: isoNow(),
  });

  await writeCredits(data);

  return {
    ok: true,
    used,
  };
}

async function refundCredits(
  userId,
  used,
  reason = "Generation failed"
) {
  if (!used) return;

  const data =
    await readCredits();

  const account =
    data.users[userId];

  if (!account) return;

  let total = 0;

  for (const bucket of [
    "freeCredits",
    "promotionalCredits",
    "paidCredits",
  ]) {
    const amount = Number(
      used[bucket] || 0
    );

    account[bucket] =
      Number(
        account[bucket] || 0
      ) + amount;

    total += amount;
  }

  account.consumedCredits =
    Math.max(
      0,
      Number(
        account.consumedCredits || 0
      ) - total
    );

  account.refundedCredits =
    Number(
      account.refundedCredits || 0
    ) + total;

  account.updatedAt = isoNow();

  data.transactions.push({
    id: randomUUID(),
    type: "credit_refund",
    userId,
    amount: total,
    reason,
    createdAt: isoNow(),
  });

  data.users[userId] =
    account;

  await writeCredits(data);
}

/* =========================================================
   FINANCE
========================================================= */

async function readFinance() {
  return readJson(
    FINANCE_FILE,
    {
      transactions: [],
    }
  );
}

async function addFinance(
  type,
  amount,
  category,
  description,
  adminId = null,
  userId = null
) {
  const data =
    await readFinance();

  data.transactions.push({
    id: randomUUID(),
    type,
    amount:
      Number(amount) || 0,
    category:
      cleanText(
        category,
        200
      ),
    description:
      cleanText(
        description,
        500
      ),
    adminId,
    userId,
    currency: "NGN",
    createdAt: isoNow(),
  });

  await writeJson(
    FINANCE_FILE,
    data
  );
}

function financeTotals(
  transactions
) {
  let revenue = 0;
  let refunds = 0;
  let costs = 0;

  for (const t of transactions) {
    const amount =
      Number(t.amount) || 0;

    if (t.type === "revenue") {
      revenue += amount;
    }

    if (t.type === "refund") {
      refunds += amount;
    }

    if (t.type === "cost") {
      costs += amount;
    }
  }

  const netRevenue =
    revenue - refunds;

  const profit =
    netRevenue - costs;

  return {
    grossRevenue: revenue,
    refunds,
    netRevenue,
    totalCosts: costs,
    profit,
    profitMargin:
      netRevenue
        ? (profit / netRevenue) *
          100
        : 0,
  };
}

/* =========================================================
   PAYMENTS
========================================================= */

async function readPayments() {
  return readJson(
    PAYMENTS_FILE,
    {
      transactions: [],
    }
  );
}

async function writePayments(
  data
) {
  await writeJson(
    PAYMENTS_FILE,
    data
  );
}

async function readWithdrawals() {
  return readJson(
    WITHDRAWALS_FILE,
    {
      withdrawals: [],
    }
  );
}

async function writeWithdrawals(
  data
) {
  await writeJson(
    WITHDRAWALS_FILE,
    data
  );
}

async function paystackRequest(
  endpoint,
  options = {}
) {
  if (!PAYSTACK_SECRET_KEY) {
    const error =
      new Error(
        "PAYSTACK_SECRET_KEY is not configured."
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
          ...(options.headers || {}),
        },
      }
    );

  const text =
    await response.text();

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
    !response.ok ||
    data.status === false
  ) {
    const error =
      new Error(
        data.message ||
          `Paystack HTTP ${response.status}`
      );

    error.status =
      response.status;

    error.paystack =
      data;

    throw error;
  }

  return data;
}

/* =========================================================
   FX / PRICING
========================================================= */

let fxCache = {
  data: null,
  updatedAt: 0,
};

async function getFxRates() {
  if (
    fxCache.data &&
    Date.now() -
      fxCache.updatedAt <
      30 * 60 * 1000
  ) {
    return fxCache.data;
  }

  try {
    const response =
      await fetch(
        FX_API_URL,
        {
          headers: {
            Accept:
              "application/json",
          },
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
      !Number.isFinite(rate) ||
      rate <= 0
    ) {
      throw new Error(
        "Invalid NGN FX rate."
      );
    }

    fxCache = {
      data: {
        base:
          data.base_code ||
          "USD",
        rates: {
          USD: 1,
          NGN: rate,
        },
        source:
          FX_API_URL,
        updatedAt:
          isoNow(),
        live: true,
      },
      updatedAt:
        Date.now(),
    };

    return fxCache.data;
  } catch {
    return {
      base: "USD",
      rates: {
        USD: 1,
        NGN:
          DEFAULT_USD_NGN_RATE,
      },
      source:
        "environment fallback",
      updatedAt:
        isoNow(),
      live: false,
    };
  }
}

async function getPricingPackages(
  currency = "NGN"
) {
  const fx =
    await getFxRates();

  const rate =
    Number(
      fx?.rates?.NGN ||
        DEFAULT_USD_NGN_RATE
    );

  const usdPackages = [
    {
      credits: 100,
      usdPrice: 1,
    },
    {
      credits: 500,
      usdPrice: 5,
    },
    {
      credits: 1000,
      usdPrice: 10,
    },
    {
      credits: 2500,
      usdPrice: 25,
    },
    {
      credits: 5000,
      usdPrice: 50,
    },
  ];

  return usdPackages.map(
    (pkg) => {
      const providerCostUsd =
        pkg.usdPrice *
        0.5;

      const rawNgn =
        pkg.usdPrice *
          rate *
          (1 + FX_BUFFER) +
        pkg.usdPrice *
          FIXED_NGN_MARKUP_PER_USD;

      const marginAdjusted =
        rawNgn /
        Math.max(
          0.01,
          1 -
            TARGET_MARGIN -
            PAYMENT_FEE_BUFFER
        );

      const amount =
        Math.max(
          100,
          Math.round(
            marginAdjusted /
              50
          ) * 50
        );

      return {
        credits:
          pkg.credits,
        currency,
        amount,
        amountSubunit:
          amount * 100,
        usdPrice:
          pkg.usdPrice,
        providerCostUsd,
        providerScenes:
          Math.ceil(
            pkg.credits /
              CREDITS_PER_5_SECONDS
          ),
        fxRate: rate,
        fxLive:
          Boolean(fx.live),
        fxUpdatedAt:
          fx.updatedAt,
        fixedMarkupPerUsd:
          FIXED_NGN_MARKUP_PER_USD,
        marginTarget:
          TARGET_MARGIN,
        paymentFeeBuffer:
          PAYMENT_FEE_BUFFER,
        fxBuffer:
          FX_BUFFER,
      };
    }
  );
}

async function ownerFinancialSnapshot() {
  const finance =
    await readFinance();

  const totals =
    financeTotals(
      finance.transactions
    );

  const withdrawals =
    await readWithdrawals();

  const successfulWithdrawals =
    withdrawals.withdrawals
      .filter(
        (w) =>
          w.status ===
          "success"
      )
      .reduce(
        (sum, w) =>
          sum +
          Number(
            w.amount || 0
          ),
        0
      );

  const pendingWithdrawals =
    withdrawals.withdrawals
      .filter(
        (w) =>
          ![
            "success",
            "failed",
            "reversed",
          ].includes(
            w.status
          )
      )
      .reduce(
        (sum, w) =>
          sum +
          Number(
            w.amount || 0
          ),
        0
      );

  return {
    ...totals,
    withdrawn:
      successfulWithdrawals,
    pendingWithdrawals,
    availableToWithdraw:
      Math.max(
        0,
        totals.profit -
          successfulWithdrawals -
          pendingWithdrawals
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
    randomBytes(4)
      .readUInt32BE(0) %
      1000000
  ).padStart(6, "0");
}

function hashResetCode(code) {
  return createHash("sha256")
    .update(
      `${code}:${
        SESSION_SECRET ||
        "mamaki-development-secret"
      }`
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
<p>This code expires in 15 minutes.</p>
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
            normalizeEmail(
              item.email
            ) === email
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
          "Password recovery email is temporarily unavailable.",
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
            "This recovery code has expired.",
        });
      }

      if (
        Number(
          record.attempts || 0
        ) >=
        PASSWORD_RESET_MAX_ATTEMPTS
      ) {
        await deletePasswordReset(
          email
        );

        return res.status(429).json({
          ok: false,
          error:
            "RESET_ATTEMPTS_EXCEEDED",
          message:
            "Too many incorrect attempts.",
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
        hashResetCode(
          code
        ) !==
        record.codeHash
      ) {
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
            normalizeEmail(
              item.email
            ) === email
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
        isoNow();

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

      return res.json({
        ok: true,
        message:
          "Password changed successfully.",
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/auth/reset-password",
        }
      );

      return res.status(500).json({
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
   USER AUTH
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
        password.length <
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

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      const existing =
        Object.values(
          users
        ).find(
          (u) =>
            normalizeEmail(
              u.email
            ) === email
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

      const user = {
        id: randomUUID(),
        name,
        email,
        salt:
          credentials.salt,
        passwordHash:
          credentials.hash,
        role: "user",
        disabled: false,
        createdAt:
          isoNow(),
        lastLoginAt:
          null,
        lastActiveAt:
          isoNow(),
      };

      users[user.id] =
        user;

      await writeJson(
        USERS_FILE,
        users
      );

      await getUserCredits(
        user.id
      );

      const token =
        await createSession(
          user.id,
          "user"
        );

      return res.status(201).json({
        ok: true,
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
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

      return res.status(500).json({
        ok: false,
        error:
          "REGISTRATION_FAILED",
        message:
          "Unable to create account.",
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
            normalizeEmail(
              item.email
            ) === email
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
        return res.status(401).json({
          ok: false,
          error:
            "INVALID_LOGIN",
          message:
            "Invalid email or password.",
        });
      }

      user.lastLoginAt =
        isoNow();

      user.lastActiveAt =
        isoNow();

      users[user.id] =
        user;

      await writeJson(
        USERS_FILE,
        users
      );

      await getUserCredits(
        user.id
      );

      const token =
        await createSession(
          user.id,
          user.role
        );

      return res.json({
        ok: true,
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
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

      return res.status(500).json({
        ok: false,
        error:
          "LOGIN_FAILED",
        message:
          "Unable to complete login.",
      });
    }
  }
);

app.get(
  "/api/auth/me",
  requireAuth,
  async (req, res) => {
    req.user.lastActiveAt =
      isoNow();

    const users =
      await readJson(
        USERS_FILE,
        {}
      );

    users[req.user.id] =
      req.user;

    await writeJson(
      USERS_FILE,
      users
    );

    const credits =
      await getUserCredits(
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
        free:
          Number(
            credits.freeCredits ||
              0
          ),
        promotional:
          Number(
            credits.promotionalCredits ||
              0
          ),
        paid:
          Number(
            credits.paidCredits ||
              0
          ),
        usable:
          usableCredits(
            credits
          ),
      },
    });
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
      !ADMIN_PASSWORD ||
      !SESSION_SECRET
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
                a.createdAt || ""
              ).localeCompare(
                String(
                  b.createdAt || ""
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
          role: "admin",
          disabled: false,
          createdAt:
            isoNow(),
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
        isoNow();

      admin.lastActiveAt =
        isoNow();

      users[admin.id] =
        admin;

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

      return res.json({
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

      return res.status(500).json({
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

async function getAllProjects() {
  try {
    const entries =
      await fs.readdir(
        PROJECTS,
        {
          withFileTypes:
            true,
        }
      );

    const projects = [];

    for (
      const entry of
        entries
    ) {
      if (
        !entry.isFile() ||
        !entry.name.endsWith(
          ".json"
        )
      ) {
        continue;
      }

      const project =
        await readJson(
          path.join(
            PROJECTS,
            entry.name
          ),
          null
        );

      if (project) {
        projects.push(
          project
        );
      }
    }

    return projects;
  } catch {
    return [];
  }
}

async function getUsageTotals() {
  const usage =
    await readJson(
      USAGE_FILE,
      {}
    );

  let aiGenerations = 0;
  let aiSeconds = 0;
  let studioJobs = 0;
  let narrationJobs = 0;

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

  return {
    aiGenerations,
    aiSeconds,
    studioJobs,
    narrationJobs,
  };
}

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

      const projects =
        await getAllProjects();

      const usage =
        await getUsageTotals();

      const jobList =
        Array.from(
          jobs.values()
        );

      const finance =
        await ownerFinancialSnapshot();

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      res.json({
        ok: true,
        stats: {
          totalUsers:
            Object.keys(
              users
            ).length,

          totalAdmins:
            Object.values(
              users
            ).filter(
              (u) =>
                u.role ===
                "admin"
            ).length,

          totalProjects:
            projects.length,

          aiGenerations:
            usage.aiGenerations,

          aiSeconds:
            usage.aiSeconds,

          studioJobs:
            usage.studioJobs,

          narrationJobs:
            usage.narrationJobs,

          completedJobs:
            jobList.filter(
              (j) =>
                j.status ===
                "completed"
            ).length,

          processingJobs:
            jobList.filter(
              (j) =>
                [
                  "queued",
                  "processing",
                ].includes(
                  j.status
                )
            ).length,

          failedJobs:
            jobList.filter(
              (j) =>
                j.status ===
                "failed"
            ).length,
        },

        finance,
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
    const users =
      await readJson(
        USERS_FILE,
        {}
      );

    const credits =
      await readCredits();

    const list =
      Object.values(
        users
      )
        .map((user) => {
          const account =
            credits.users[
              user.id
            ] || {};

          return {
            id:
              user.id,
            name:
              user.name,
            email:
              user.email,
            role:
              user.role,
            disabled:
              Boolean(
                user.disabled
              ),
            createdAt:
              user.createdAt,
            lastLoginAt:
              user.lastLoginAt ||
              null,
            lastActiveAt:
              user.lastActiveAt ||
              null,
            credits: {
              free:
                Number(
                  account.freeCredits ||
                    0
                ),
              promotional:
                Number(
                  account.promotionalCredits ||
                    0
                ),
              paid:
                Number(
                  account.paidCredits ||
                    0
                ),
              usable:
                usableCredits(
                  account
                ),
              consumed:
                Number(
                  account.consumedCredits ||
                    0
                ),
            },
          };
        })
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

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    res.json({
      ok: true,
      users: list,
    });
  }
);

app.get(
  "/api/admin/users/:id",
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

    const projects =
      (
        await getAllProjects()
      ).filter(
        (project) =>
          project.userId ===
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
          Boolean(
            user.disabled
          ),
        createdAt:
          user.createdAt,
        lastLoginAt:
          user.lastLoginAt ||
          null,
      },
      usage:
        usage[user.id] ||
        {},
      projects,
    });
  }
);

app.post(
  "/api/admin/users/:id/disable",
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

    if (
      user.role ===
        "admin" &&
      normalizeEmail(
        user.email
      ) ===
        ADMIN_EMAIL
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "ADMIN_PROTECTED",
        message:
          "The configured administrator account cannot be disabled here.",
      });
    }

    user.disabled =
      req.body.disabled !==
      undefined
        ? Boolean(
            req.body.disabled
          )
        : true;

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

    res.json({
      ok: true,
      user: {
        id:
          user.id,
        disabled:
          user.disabled,
      },
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
    const data =
      await readCredits();

    const users =
      await readJson(
        USERS_FILE,
        {}
      );

    const balances =
      Object.values(
        users
      ).map(
        (user) => {
          const account =
            data.users[
              user.id
            ] || {};

          return {
            userId:
              user.id,
            name:
              user.name,
            email:
              user.email,
            role:
              user.role,
            credits:
              usableCredits(
                account
              ),
            consumed:
              Number(
                account.consumedCredits ||
                  0
              ),
            refunded:
              Number(
                account.refundedCredits ||
                  0
              ),
          };
        }
      );

    const issued =
      data.transactions
        .filter(
          (t) =>
            t.type ===
              "credit_purchase" ||
            t.type ===
              "credit_grant"
        )
        .reduce(
          (sum, t) =>
            sum +
            Number(
              t.amount || 0
            ),
          0
        );

    const consumed =
      data.transactions
        .filter(
          (t) =>
            t.type ===
            "credit_consumed"
        )
        .reduce(
          (sum, t) =>
            sum +
            Number(
              t.amount || 0
            ),
          0
        );

    const refunded =
      data.transactions
        .filter(
          (t) =>
            t.type ===
            "credit_refund"
        )
        .reduce(
          (sum, t) =>
            sum +
            Number(
              t.amount || 0
            ),
          0
        );

    res.json({
      ok: true,
      mamaki: {
        issued,
        consumed,
        refunded,
        usableCredits:
          balances.reduce(
            (sum, item) =>
              sum +
              Number(
                item.credits ||
                  0
              ),
            0
          ),
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
        balance:
          null,
        note:
          "Replicate provider balance is not exposed as an authoritative value by this application.",
      },
    });
  }
);

app.post(
  "/api/admin/credits/adjust",
  requireAdmin,
  async (req, res) => {
    const userId =
      cleanText(
        req.body.userId,
        200
      );

    const amount =
      Math.trunc(
        Number(
          req.body.amount || 0
        )
      );

    const bucket =
      [
        "freeCredits",
        "promotionalCredits",
        "paidCredits",
      ].includes(
        req.body.bucket
      )
        ? req.body.bucket
        : "promotionalCredits";

    const reason =
      cleanText(
        req.body.reason ||
          "Manual administrator credit adjustment",
        500
      );

    if (
      !userId ||
      !Number.isFinite(
        amount
      ) ||
      amount === 0
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "INVALID_CREDIT_ADJUSTMENT",
        message:
          "User ID and a non-zero credit amount are required.",
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

    const data =
      await readCredits();

    const account =
      data.users[userId] ||
      {
        freeCredits: 0,
        promotionalCredits: 0,
        paidCredits: 0,
        consumedCredits: 0,
        refundedCredits: 0,
      };

    account[bucket] =
      Math.max(
        0,
        Number(
          account[bucket] || 0
        ) + amount
      );

    account.updatedAt =
      isoNow();

    data.users[userId] =
      account;

    data.transactions.push({
      id: randomUUID(),
      type:
        amount > 0
          ? "credit_grant"
          : "credit_adjustment",
      userId,
      amount,
      bucket,
      reason,
      adminId:
        req.user.id,
      createdAt:
        isoNow(),
    });

    await writeCredits(
      data
    );

    await recordSecurityEvent(
      "ADMIN_CREDIT_ADJUSTMENT",
      {
        adminId:
          req.user.id,
        userId,
        amount,
        bucket,
        reason,
      }
    );

    res.json({
      ok: true,
      userId,
      amount,
      bucket,
      credits:
        usableCredits(
          account
        ),
    });
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
      )
        .map(
          (job) => ({
            id:
              job.id,
            userId:
              job.userId,
            status:
              job.status,
            progress:
              job.progress,
            message:
              job.message,
            createdAt:
              job.createdAt,
            completedAt:
              job.completedAt ||
              null,
            error:
              job.error ||
              null,
            creditCost:
              job.creditCost ||
              0,
          })
        )
        .sort(
          (a, b) =>
            String(
              b.createdAt
            ).localeCompare(
              String(
                a.createdAt
              )
            )
        );

    res.json({
      ok: true,
      jobs: list,
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

    const list =
      Object.values(
        errors
      )
        .sort(
          (a, b) =>
            String(
              b.createdAt
            ).localeCompare(
              String(
                a.createdAt
              )
            )
        )
        .slice(
          0,
          200
        );

    res.json({
      ok: true,
      errors: list,
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

    const list =
      Object.values(
        security
      )
        .sort(
          (a, b) =>
            String(
              b.createdAt
            ).localeCompare(
              String(
                a.createdAt
              )
            )
        )
        .slice(
          0,
          300
        );

    res.json({
      ok: true,
      events: list,
    });
  }
);

/* =========================================================
   ADMIN BILLING
========================================================= */

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
      ] =
        await Promise.all([
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
            .slice(
              -200
            )
            .reverse(),
        withdrawals:
          withdrawals.withdrawals
            .slice(
              -100
            )
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
            `${APP_URL}/api/billing/paystack/webhook`,
        },
        fixedMarkupPerUsd:
          FIXED_NGN_MARKUP_PER_USD,
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
          "BILLING_DASHBOARD_FAILED",
        message:
          "Unable to load billing dashboard.",
      });
    }
  }
);

/* =========================================================
   PAYSTACK INITIALIZE
========================================================= */

app.post(
  "/api/billing/paystack/initialize",
  requireAuth,
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

      const credits =
        Math.max(
          0,
          Math.trunc(
            Number(
              req.body.credits ||
                0
            )
          )
        );

      const packages =
        await getPricingPackages(
          "NGN"
        );

      const pkg =
        packages.find(
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
        `mamaki_${Date.now()}_${randomBytes(
          6
        ).toString("hex")}`;

      const result =
        await paystackRequest(
          "/transaction/initialize",
          {
            method: "POST",
            body:
              JSON.stringify({
                email:
                  req.user.email,
                amount:
                  pkg.amountSubunit,
                currency:
                  "NGN",
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
                  packageAmount:
                    pkg.amount,
                },
              }),
          }
        );

      const payments =
        await readPayments();

      payments.transactions.push(
        {
          id: randomUUID(),
          reference,
          userId:
            req.user.id,
          email:
            req.user.email,
          credits:
            pkg.credits,
          amount:
            pkg.amount,
          currency:
            "NGN",
          status:
            "initialized",
          fulfilledAt:
            null,
          createdAt:
            isoNow(),
        }
      );

      await writePayments(
        payments
      );

      res.json({
        ok: true,
        reference,
        authorization_url:
          result.data?.authorization_url,
        access_code:
          result.data?.access_code,
        amount:
          pkg.amount,
        credits:
          pkg.credits,
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
          "PAYMENT_INITIALIZATION_FAILED",
        message:
          error.message ||
          "Unable to initialize payment.",
      });
    }
  }
);

/* =========================================================
   PAYSTACK VERIFY
========================================================= */

async function fulfillPayment(
  reference
) {
  const payments =
    await readPayments();

  const payment =
    payments.transactions.find(
      (item) =>
        item.reference ===
        reference
    );

  if (!payment) {
    return {
      ok: false,
      error:
        "PAYMENT_NOT_FOUND",
    };
  }

  if (
    payment.fulfilledAt
  ) {
    return {
      ok: true,
      alreadyFulfilled:
        true,
      payment,
    };
  }

  const verification =
    await paystackRequest(
      `/transaction/verify/${encodeURIComponent(
        reference
      )}`
    );

  const transaction =
    verification.data;

  if (
    transaction?.status !==
    "success"
  ) {
    return {
      ok: false,
      error:
        "PAYMENT_NOT_SUCCESSFUL",
      status:
        transaction?.status ||
        "unknown",
    };
  }

  const metadata =
    transaction.metadata ||
    {};

  const userId =
    payment.userId ||
    metadata.userId;

  const credits =
    Number(
      payment.credits ||
        metadata.credits ||
        0
    );

  if (
    !userId ||
    !credits
  ) {
    return {
      ok: false,
      error:
        "PAYMENT_METADATA_INVALID",
    };
  }

  const data =
    await readCredits();

  const account =
    data.users[userId] ||
    {
      freeCredits: 0,
      promotionalCredits: 0,
      paidCredits: 0,
      consumedCredits: 0,
      refundedCredits: 0,
    };

  account.paidCredits =
    Number(
      account.paidCredits ||
        0
    ) + credits;

  account.updatedAt =
    isoNow();

  data.users[userId] =
    account;

  data.transactions.push({
    id: randomUUID(),
    type:
      "credit_purchase",
    userId,
    amount:
      credits,
    reason:
      `Paystack payment ${reference}`,
    reference,
    createdAt:
      isoNow(),
  });

  await writeCredits(
    data
  );

  payment.status =
    "success";

  payment.fulfilledAt =
    isoNow();

  payment.paystackStatus =
    transaction.status;

  payment.paystackAmount =
    Number(
      transaction.amount ||
        0
    ) / 100;

  await writePayments(
    payments
  );

  await addFinance(
    "revenue",
    Number(
      transaction.amount ||
        0
    ) / 100,
    "credit_sale",
    `MAMAKI credit purchase ${credits} credits via Paystack`,
    null,
    userId
  );

  await recordSecurityEvent(
    "PAYMENT_FULFILLED",
    {
      userId,
      reference,
      credits,
      amount:
        payment.paystackAmount,
    }
  );

  return {
    ok: true,
    alreadyFulfilled:
      false,
    payment,
    creditsAdded:
      credits,
  };
}

app.get(
  "/api/billing/paystack/verify/:reference",
  requireAuth,
  async (req, res) => {
    try {
      const reference =
        cleanText(
          req.params.reference,
          200
        );

      const payments =
        await readPayments();

      const payment =
        payments.transactions.find(
          (item) =>
            item.reference ===
            reference
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

      const result =
        await fulfillPayment(
          reference
        );

      if (!result.ok) {
        return res.status(400).json(
          result
        );
      }

      res.json(
        result
      );
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/billing/paystack/verify",
        }
      );

      res.status(500).json({
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

/* =========================================================
   PAYSTACK WEBHOOK
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

  const a =
    Buffer.from(
      signature
    );

  const b =
    Buffer.from(
      expected
    );

  return (
    a.length ===
      b.length &&
    timingSafeEqual(
      a,
      b
    )
  );
}

async function paystackWebhookHandler(
  req,
  res
) {
  try {
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

    const event =
      req.body || {};

    if (
      event.event ===
      "charge.success"
    ) {
      const reference =
        event.data?.reference;

      if (reference) {
        try {
          await fulfillPayment(
            reference
          );
        } catch (error) {
          await recordError(
            error,
            {
              route:
                "/api/billing/paystack/webhook",
              reference,
            }
          );
        }
      }
    }

    return res.json({
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

    return res.status(500).json({
      ok: false,
      error:
        "WEBHOOK_FAILED",
    });
  }
}

app.post(
  "/api/billing/paystack/webhook",
  paystackWebhookHandler
);

app.post(
  "/api/payments/paystack/webhook",
  paystackWebhookHandler
);

/* =========================================================
   PAYMENT STATUS
========================================================= */

app.get(
  "/api/billing/payment/:reference",
  requireAuth,
  async (req, res) => {
    const reference =
      cleanText(
        req.params.reference,
        200
      );

    const payments =
      await readPayments();

    const payment =
      payments.transactions.find(
        (item) =>
          item.reference ===
          reference
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
            "PAYOUT_NOT_CONFIGURED",
          message:
            "PAYSTACK_SECRET_KEY is not configured.",
        });
      }

      const amount =
        Math.floor(
          Number(
            req.body.amount || 0
          )
        );

      const name =
        cleanText(
          req.body.name,
          100
        );

      const accountNumber =
        cleanText(
          req.body.accountNumber,
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
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_WITHDRAWAL_DETAILS",
          message:
            "Amount, account name, account number and bank code are required.",
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
        ).toString("hex")}`;

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
                    ?.recipient_code,
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

      const data =
        await readWithdrawals();

      data.withdrawals.push({
        id:
          randomUUID(),
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
          isoNow(),
      });

      await writeWithdrawals(
        data
      );

      if (
        status ===
        "success"
      ) {
        await addFinance(
          "cost",
          amount,
          "owner_withdrawal",
          `Owner profit withdrawal ${reference}`,
          req.user.id
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
          "WITHDRAWAL_FAILED",
        message:
          error.message ||
          "Withdrawal failed.",
      });
    }
  }
);

/* =========================================================
   REPLICATE
========================================================= */

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
    )
  ) {
    return {
      code:
        "REPLICATE_AUTH_REQUIRED",
      message:
        "Replicate authentication is missing or invalid. Check REPLICATE_API_TOKEN.",
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
        "Replicate rejected this request. Check model access and billing.",
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

function normalizeAspectRatio(
  ratio
) {
  if (
    [
      "9:16",
      "1:1",
      "16:9",
    ].includes(
      ratio
    )
  ) {
    return ratio;
  }

  return "16:9";
}

function ratioDimensions(
  ratio
) {
  if (ratio === "9:16") {
    return {
      width: 1080,
      height: 1920,
    };
  }

  if (ratio === "1:1") {
    return {
      width: 1080,
      height: 1080,
    };
  }

  return {
    width: 1920,
    height: 1080,
  };
}

function sceneFrameCount(
  duration
) {
  return duration <= 5
    ? 81
    : 121;
}

function enhancePrompt(
  prompt,
  style
) {
  const base =
    cleanText(
      prompt,
      10000
    );

  const selectedStyle =
    cleanText(
      style ||
        "Cinematic",
      100
    );

  return `${base}

Visual style: ${selectedStyle}.
Create coherent motion and strong visual continuity.
Keep the main subject consistent.
Natural lighting, realistic movement and clean composition.
No subtitles, captions, logos, watermarks or written text.
Avoid distorted faces, duplicated objects, extra limbs and unstable anatomy.`;
}

function splitPromptIntoScenes(
  prompt,
  duration
) {
  const seconds =
    Math.max(
      MIN_DURATION,
      Math.min(
        MAX_DURATION,
        Number(duration) ||
          5
      )
    );

  const sceneCount =
    Math.max(
      1,
      Math.ceil(
        seconds / 5
      )
    );

  const base =
    cleanText(
      prompt,
      10000
    );

  return Array.from(
    {
      length:
        sceneCount,
    },
    (_, index) => ({
      index:
        index + 1,
      duration:
        index ===
        sceneCount - 1
          ? Math.max(
              1,
              seconds -
                index * 5
            )
          : 5,
      prompt:
        `${base}\n\nScene ${
          index + 1
        } of ${sceneCount}. Maintain continuity with the previous and next scenes.`,
    })
  );
}

async function downloadToFile(
  url,
  destination
) {
  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Media download failed with HTTP ${response.status}`
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

function runFfmpeg(
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

      let stdout =
        "";

      let stderr =
        "";

      child.stdout.on(
        "data",
        (chunk) => {
          stdout +=
            chunk.toString();
        }
      );

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
            code !== 0
          ) {
            const error =
              new Error(
                `FFmpeg failed (${code}): ${stderr.slice(
                  -4000
                )}`
              );

            error.stdout =
              stdout;

            error.stderr =
              stderr;

            reject(error);

            return;
          }

          resolve({
            stdout,
            stderr,
          });
        }
      );
    }
  );
}

async function addWatermark(
  input,
  output
) {
  await runFfmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    "drawtext=text='MAMAKI ✨':fontcolor=white@0.82:fontsize=26:box=1:boxcolor=black@0.25:boxborderw=10:x=w-tw-24:y=h-th-24",
    "-c:a",
    "copy",
    output,
  ]);

  return output;
}

async function forceDuration(
  input,
  output,
  duration
) {
  await runFfmpeg([
    "-y",
    "-i",
    input,
    "-t",
    String(duration),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    output,
  ]);

  return output;
}

async function combineVideos(
  inputs,
  output
) {
  const listFile =
    path.join(
      TMP,
      `concat-${randomUUID()}.txt`
    );

  const content =
    inputs
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
    await runFfmpeg([
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
    await fs.rm(
      listFile,
      {
        force: true,
      }
    );
  }

  return output;
}

async function generateVideoWithReplicate(
  prompt,
  duration,
  ratio,
  imageUrl = null,
  style = "Cinematic"
) {
  if (!replicate) {
    const error =
      new Error(
        "REPLICATE_API_TOKEN is not configured."
      );

    error.code =
      "REPLICATE_NOT_CONFIGURED";

    throw error;
  }

  const safeDuration =
    Math.max(
      MIN_DURATION,
      Math.min(
        5,
        Number(duration) ||
          5
      )
    );

  const dimensions =
    ratioDimensions(
      ratio
    );

  const frames =
    sceneFrameCount(
      safeDuration
    );

  const input = {
    prompt:
      enhancePrompt(
        prompt,
        style
      ),
    width:
      dimensions.width,
    height:
      dimensions.height,
    num_frames:
      frames,
    fps: 16,
    go_fast: true,
    sample_shift: 12,
  };

  if (imageUrl) {
    input.image =
      imageUrl;
  }

  const model =
    imageUrl
      ? I2V_MODEL
      : T2V_MODEL;

  const output =
    await replicate.run(
      model,
      {
        input,
      }
    );

  if (
    typeof output ===
      "string"
  ) {
    return output;
  }

  if (
    output &&
    typeof output.url ===
      "function"
  ) {
    return String(
      output.url()
    );
  }

  if (
    output &&
    typeof output.url ===
      "string"
  ) {
    return output.url;
  }

  if (
    output &&
    Array.isArray(
      output
    ) &&
    output[0]
  ) {
    return String(
      output[0]
    );
  }

  if (
    output &&
    typeof output ===
      "object"
  ) {
    for (
      const value of Object.values(
        output
      )
    ) {
      if (
        typeof value ===
          "string" &&
        /^https?:\/\//i.test(
          value
        )
      ) {
        return value;
      }
    }
  }

  throw new Error(
    "Replicate completed but no video URL was returned."
  );
}

async function updateUsage(
  userId,
  changes
) {
  const usage =
    await readJson(
      USAGE_FILE,
      {}
    );

  usage[userId] =
    usage[userId] ||
    {
      aiGenerations: 0,
      aiSeconds: 0,
      studioJobs: 0,
      narrationJobs: 0,
    };

  for (
    const [
      key,
      value,
    ] of Object.entries(
      changes
    )
  ) {
    usage[userId][key] =
      Number(
        usage[userId][key] ||
          0
      ) +
      Number(value || 0);
  }

  usage[userId].updatedAt =
    isoNow();

  await writeJson(
    USAGE_FILE,
    usage
  );
}

/* =========================================================
   AI VIDEO GENERATION
========================================================= */

app.post(
  "/api/video/generate",
  requireAuth,
  upload.single("image"),
  async (req, res) => {
    const userId =
      req.user.id;

    let usedCredits =
      null;

    try {
      const prompt =
        cleanText(
          req.body.prompt,
          10000
        );

      const type =
        cleanText(
          req.body.type ||
            "text-to-video",
          100
        );

      const style =
        cleanText(
          req.body.style ||
            "Cinematic",
          100
        );

      const ratio =
        normalizeAspectRatio(
          req.body.ratio
        );

      const duration =
        Math.max(
          MIN_DURATION,
          Math.min(
            MAX_DURATION,
            Number(
              req.body.duration ||
                5
            )
          )
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

      if (
        !REPLICATE_API_TOKEN
      ) {
        return res.status(503).json({
          ok: false,
          error:
            "REPLICATE_NOT_CONFIGURED",
          message:
            "AI generation is not configured yet.",
        });
      }

      const estimatedCredits =
        Math.max(
          1,
          Math.ceil(
            duration / 5
          ) *
            CREDITS_PER_5_SECONDS
        );

      const creditResult =
        await consumeCredits(
          userId,
          estimatedCredits,
          "AI video generation"
        );

      if (!creditResult.ok) {
        return res.status(402).json(
          creditResult
        );
      }

      usedCredits =
        creditResult.used;

      const jobId =
        randomUUID();

      const job = {
        id: jobId,
        userId,
        type,
        prompt,
        style,
        ratio,
        duration,
        status: "processing",
        progress: 5,
        message:
          "Preparing AI generation…",
        createdAt:
          isoNow(),
        creditCost:
          estimatedCredits,
      };

      jobs.set(
        jobId,
        job
      );

      res.status(202).json({
        ok: true,
        jobId,
        status:
          "processing",
        message:
          "Video generation started.",
        creditCost:
          estimatedCredits,
      });

      void (async () => {
        try {
          let imageUrl =
            null;

          if (
            req.file
          ) {
            const extension =
              path.extname(
                req.file.originalname ||
                  ""
              ) ||
              ".jpg";

            const imagePath =
              path.join(
                TMP,
                `${jobId}${extension}`
              );

            await fs.writeFile(
              imagePath,
              req.file.buffer
            );

            imageUrl =
              `file://${imagePath}`;
          }

          job.progress =
            15;

          job.message =
            "Generating AI video…";

          const scenes =
            splitPromptIntoScenes(
              prompt,
              duration
            );

          const sceneFiles =
            [];

          for (
            let i = 0;
            i <
            scenes.length;
            i++
          ) {
            const scene =
              scenes[i];

            job.progress =
              Math.min(
                90,
                15 +
                  Math.floor(
                    (i /
                      scenes.length) *
                      70
                  )
              );

            job.message =
              `Generating scene ${
                i + 1
              } of ${
                scenes.length
              }…`;

            const mediaUrl =
              await generateVideoWithReplicate(
                scene.prompt,
                scene.duration,
                ratio,
                imageUrl,
                style
              );

            const scenePath =
              path.join(
                TMP,
                `${jobId}-scene-${i}.mp4`
              );

            await downloadToFile(
              mediaUrl,
              scenePath
            );

            sceneFiles.push(
              scenePath
            );
          }

          job.progress =
            92;

          job.message =
            "Assembling video…";

          let rawOutput;

          if (
            sceneFiles.length ===
            1
          ) {
            rawOutput =
              sceneFiles[0];
          } else {
            rawOutput =
              path.join(
                TMP,
                `${jobId}-combined.mp4`
              );

            await combineVideos(
              sceneFiles,
              rawOutput
            );
          }

          const finalPath =
            path.join(
              OUTPUTS,
              `${jobId}.mp4`
            );

          await addWatermark(
            rawOutput,
            finalPath
          );

          const publicUrl =
            `/media/${path.basename(
              finalPath
            )}`;

          job.status =
            "completed";

          job.progress =
            100;

          job.message =
            "Video generated successfully.";

          job.completedAt =
            isoNow();

          job.outputUrl =
            publicUrl;

          await updateUsage(
            userId,
            {
              aiGenerations:
                1,
              aiSeconds:
                duration,
            }
          );

          for (
            const file of
              sceneFiles
          ) {
            await fs.rm(
              file,
              {
                force: true,
              }
            );
          }

          if (
            imageUrl?.startsWith(
              "file://"
            )
          ) {
            await fs.rm(
              imageUrl.replace(
                "file://",
                ""
              ),
              {
                force: true,
              }
            );
          }
        } catch (error) {
          const classified =
            classifyReplicateError(
              error
            );

          job.status =
            "failed";

          job.progress =
            0;

          job.error =
            classified.message;

          job.message =
            classified.message;

          job.completedAt =
            isoNow();

          await refundCredits(
            userId,
            usedCredits,
            classified.message
          );

          await recordError(
            error,
            {
              route:
                "/api/video/generate",
              userId,
              jobId,
            }
          );
        }
      })();

      return;
    } catch (error) {
      if (usedCredits) {
        await refundCredits(
          userId,
          usedCredits,
          "Generation request failed"
        );
      }

      await recordError(
        error,
        {
          route:
            "/api/video/generate",
          userId,
        }
      );

      const classified =
        classifyReplicateError(
          error
        );

      return res.status(500).json({
        ok: false,
        error:
          classified.code,
        message:
          classified.message,
      });
    }
  }
);

app.get(
  "/api/video/job/:id",
  requireAuth,
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
          "JOB_ACCESS_DENIED",
      });
    }

    res.json({
      ok: true,
      job,
    });
  }
);

/* =========================================================
   MEDIA
========================================================= */

app.get(
  "/media/:filename",
  async (req, res) => {
    const filename =
      path.basename(
        req.params.filename
      );

    const file =
      path.join(
        OUTPUTS,
        filename
      );

    try {
      await fs.access(
        file
      );

      res.setHeader(
        "Cache-Control",
        "public, max-age=3600"
      );

      res.sendFile(
        file
      );
    } catch {
      res.status(404).json({
        ok: false,
        error:
          "MEDIA_NOT_FOUND",
      });
    }
  }
);

/* =========================================================
   PROJECTS
========================================================= */

app.post(
  "/api/projects",
  requireAuth,
  async (req, res) => {
    try {
      const name =
        cleanText(
          req.body.name ||
            "Untitled Project",
          200
        );

      const project = {
        id:
          randomUUID(),
        userId:
          req.user.id,
        name,
        scenes:
          Array.isArray(
            req.body.scenes
          )
            ? req.body.scenes
            : [],
        createdAt:
          isoNow(),
        updatedAt:
          isoNow(),
      };

      await writeJson(
        path.join(
          PROJECTS,
          `${project.id}.json`
        ),
        project
      );

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

app.get(
  "/api/projects",
  requireAuth,
  async (req, res) => {
    const projects =
      (
        await getAllProjects()
      ).filter(
        (project) =>
          project.userId ===
          req.user.id
      );

    res.json({
      ok: true,
      projects,
    });
  }
);

app.get(
  "/api/projects/:id",
  requireAuth,
  async (req, res) => {
    const project =
      await readJson(
        path.join(
          PROJECTS,
          `${path.basename(
            req.params.id
          )}.json`
        ),
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
          "PROJECT_ACCESS_DENIED",
      });
    }

    res.json({
      ok: true,
      project,
    });
  }
);

/* =========================================================
   ADMIN DASHBOARD
========================================================= */

function adminTable(
  headers,
  rows,
  emptyText
) {
  if (
    !Array.isArray(rows) ||
    rows.length === 0
  ) {
    return `<div class="empty">${emptyText}</div>`;
  }

  const head =
    headers
      .map(
        (h) =>
          `<th>${h}</th>`
      )
      .join("");

  const body =
    rows
      .map(
        (row) =>
          `<tr>${row
            .map(
              (cell) =>
                `<td>${cell}</td>`
            )
            .join("")}</tr>`
      )
      .join("");

  return `
<table>
<thead>
<tr>${head}</tr>
</thead>
<tbody>${body}</tbody>
</table>`;
}

function escapeHtml(
  value
) {
  return String(
    value ?? ""
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}

app.get(
  "/admin",
  (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );

    res.setHeader(
      "Pragma",
      "no-cache"
    );

    res.setHeader(
      "Expires",
      "0"
    );

    res.setHeader(
      "Surrogate-Control",
      "no-store"
    );

    res.type(
      "html"
    ).send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>MAMAKI Administrator — Private administrator access</title>
<style>
:root{
  --bg:#07070b;
  --panel:#111118;
  --panel2:#171720;
  --line:#292936;
  --text:#f5f5f7;
  --muted:#9b9ba9;
  --good:#57d68d;
  --bad:#ff6868;
  --accent:#b77cff;
}
*{box-sizing:border-box}
body{
  margin:0;
  background:var(--bg);
  color:var(--text);
  font-family:Arial,Helvetica,sans-serif;
}
main{
  width:min(1400px,94%);
  margin:0 auto;
  padding:24px 0 80px;
}
.top{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:15px;
  flex-wrap:wrap;
}
h1,h2,h3{
  margin-top:0;
}
.muted{
  color:var(--muted);
}
.small{
  font-size:13px;
}
.hidden{
  display:none!important;
}
.card{
  background:var(--panel);
  border:1px solid var(--line);
  border-radius:18px;
  padding:18px;
  margin:14px 0;
}
.hero{
  background:linear-gradient(135deg,#171322,#101017);
}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
  gap:12px;
}
.value{
  font-size:25px;
  font-weight:800;
  margin-top:8px;
}
.formrow{
  display:flex;
  flex-wrap:wrap;
  gap:9px;
}
input,select,button{
  border:1px solid var(--line);
  background:#0d0d13;
  color:white;
  border-radius:10px;
  padding:12px 13px;
}
input{
  min-width:220px;
}
button{
  cursor:pointer;
  font-weight:700;
}
button.primary{
  background:#8c52ff;
  border-color:#8c52ff;
}
button.danger{
  background:#351414;
  border-color:#693333;
}
.notice{
  padding:12px;
  border:1px solid var(--line);
  border-radius:12px;
  background:var(--panel2);
}
.good{
  color:var(--good);
}
.bad{
  color:var(--bad);
}
.table-wrap{
  overflow:auto;
}
table{
  width:100%;
  border-collapse:collapse;
  min-width:720px;
}
th,td{
  padding:10px;
  border-bottom:1px solid var(--line);
  text-align:left;
  vertical-align:top;
}
th{
  color:#cfcfe0;
  font-size:12px;
  text-transform:uppercase;
}
.empty{
  color:var(--muted);
  padding:12px;
}
pre{
  white-space:pre-wrap;
  overflow:auto;
  max-height:350px;
}
.package{
  background:var(--panel2);
  border:1px solid var(--line);
  border-radius:14px;
  padding:14px;
}
.packages{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
  gap:10px;
}
</style>
</head>
<body>
<main>
<div class="top">
<div>
<h1>✨ MAMAKI Administrator</h1>
<div class="muted">
Private administrator access · Version ${VERSION}
</div>
</div>
<div id="actions" class="hidden">
<button onclick="loadAll()">Refresh Dashboard</button>
<button onclick="logout()">Logout</button>
</div>
</div>

<section id="login" class="card">
<h2>Administrator Login</h2>
<div class="formrow">
<input id="email" type="email" autocomplete="username" placeholder="Administrator email">
<input id="password" type="password" autocomplete="current-password" placeholder="Password">
<button class="primary" onclick="login()">Sign in</button>
</div>
<p id="msg" class="muted"></p>
</section>

<section id="dash" class="hidden">

<div class="card hero">
<h2>Business Control Center</h2>
<div class="muted">
Monitor customers, AI usage, pricing, payments, profit, provider configuration and security.
</div>
</div>

<h2>Overview</h2>
<div class="grid">
<div class="card">Total Users<div id="users" class="value">0</div></div>
<div class="card">Live / Active<div id="active" class="value">0</div></div>
<div class="card">New Today<div id="today" class="value">0</div></div>
<div class="card">New This Week<div id="week" class="value">0</div></div>
<div class="card">New This Month<div id="month" class="value">0</div></div>
<div class="card">Administrators<div id="admins" class="value">0</div></div>
<div class="card">Videos Generated<div id="videos" class="value">0</div></div>
<div class="card">AI Seconds<div id="seconds" class="value">0</div></div>
<div class="card">Narrations<div id="narrations" class="value">0</div></div>
<div class="card">Projects<div id="projects" class="value">0</div></div>
<div class="card">Completed Jobs<div id="completed" class="value">0</div></div>
<div class="card">Processing Jobs<div id="processing" class="value">0</div></div>
<div class="card">Failed Jobs<div id="failed" class="value">0</div></div>
</div>

<h2>Owner Wallet & Profit</h2>
<div class="grid">
<div class="card">Gross Revenue<div id="gross" class="value">₦0</div></div>
<div class="card">Refunds<div id="refunds" class="value">₦0</div></div>
<div class="card">Costs<div id="costs" class="value">₦0</div></div>
<div class="card">Profit<div id="profit" class="value">₦0</div></div>
<div class="card">Profit Margin<div id="margin" class="value">0%</div></div>
<div class="card">Withdrawn<div id="withdrawn" class="value">₦0</div></div>
<div class="card">Pending Withdrawals<div id="pending" class="value">₦0</div></div>
<div class="card">Available<div id="available" class="value">₦0</div></div>
</div>

<h2>AI Provider & System Health</h2>
<div class="grid">
<div class="card">Replicate<div id="repstatus" class="value">—</div><div id="repnote" class="muted small"></div></div>
<div class="card">Paystack<div id="paystatus" class="value">—</div></div>
<div class="card">FX<div id="fx" class="value">—</div><div id="fxnote" class="muted small"></div></div>
<div class="card">Target Margin<div id="targetmargin" class="value">—</div></div>
</div>

<h2>MAMAKI Credits</h2>
<div class="grid">
<div class="card">Issued<div id="issued" class="value">0</div></div>
<div class="card">Consumed<div id="consumed" class="value">0</div></div>
<div class="card">Refunded<div id="crefund" class="value">0</div></div>
<div class="card">Usable<div id="credits" class="value">0</div></div>
</div>

<section class="card">
<h2>Pricing</h2>
<div id="pricing" class="packages"></div>
</section>

<section class="card">
<h2>Users</h2>
<div id="usersTable"></div>
</section>

<section class="card">
<h2>Jobs</h2>
<div id="jobsTable"></div>
</section>

<section class="card">
<h2>Payments</h2>
<div id="paymentsTable"></div>
</section>

<section class="card">
<h2>Withdrawals</h2>
<div id="withdrawalsTable"></div>
</section>

<section class="card">
<h2>Security Activity</h2>
<div id="securityTable"></div>
</section>

<section class="card">
<h2>Errors</h2>
<div id="errorsTable"></div>
</section>

<section class="card">
<h2>Manual Credit Adjustment</h2>
<div class="formrow">
<input id="creditUser" placeholder="User ID">
<input id="creditAmount" type="number" placeholder="Credits (+/-)">
<select id="creditBucket">
<option value="promotionalCredits">Promotional Credits</option>
<option value="freeCredits">Free Credits</option>
<option value="paidCredits">Paid Credits</option>
</select>
<input id="creditReason" placeholder="Reason">
<button class="primary" onclick="adjustCredits()">Adjust Credits</button>
</div>
<p id="creditMsg" class="muted"></p>
</section>

<section class="card">
<h2>Owner Profit Withdrawal</h2>
<div class="formrow">
<input id="withdrawAmount" type="number" placeholder="Amount NGN">
<input id="withdrawName" placeholder="Account name">
<input id="withdrawAccount" placeholder="Account number">
<input id="withdrawBank" placeholder="Bank code">
<button class="primary" onclick="withdraw()">Withdraw</button>
</div>
<p id="withdrawMsg" class="muted"></p>
</section>

</section>
</main>

<script>
let token =
  localStorage.getItem(
    "mamaki_admin_token"
  ) || "";

const $ = (id) =>
  document.getElementById(id);

function esc(value){
  return String(value ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function money(value){
  return "₦" +
    Math.round(
      Number(value || 0)
    ).toLocaleString("en-NG");
}

function dt(value){
  if(!value)return "—";
  const d = new Date(value);
  if(Number.isNaN(d.getTime()))
    return esc(value);
  return d.toLocaleString();
}

async function getJson(url){
  const response =
    await fetch(
      url + (url.includes("?") ? "&" : "?") + "_=" + Date.now(),
      {
        cache:"no-store",
        headers:{
          Authorization:
            "Bearer " + token,
          Accept:
            "application/json"
        }
      }
    );

  const text =
    await response.text();

  let data = {};

  try{
    data =
      JSON.parse(text);
  }catch{
    throw new Error(
      "Server returned invalid JSON for " +
      url +
      " (HTTP " +
      response.status +
      ")."
    );
  }

  if(
    response.status === 401 ||
    response.status === 403
  ){
    const error =
      new Error(
        data.message ||
        "Administrator access required."
      );
    error.auth = true;
    throw error;
  }

  if(!response.ok || data.ok === false){
    throw new Error(
      data.message ||
      data.error ||
      "Request failed."
    );
  }

  return data;
}

async function login(){
  const msg =
    $("msg");

  const button =
    document.querySelector(
      "#login button.primary"
    );

  try{
    msg.textContent =
      "Signing in…";

    button.disabled =
      true;

    const email =
      String(
        $("email").value || ""
      )
      .trim()
      .toLowerCase();

    const password =
      String(
        $("password").value || ""
      );

    if(
      !email ||
      !password
    ){
      throw new Error(
        "Enter the administrator email and password."
      );
    }

    const response =
      await fetch(
        "/api/admin/login",
        {
          method:"POST",
          cache:"no-store",
          headers:{
            "Content-Type":
              "application/json",
            Accept:
              "application/json"
          },
          body:
            JSON.stringify({
              email,
              password
            })
        }
      );

    const text =
      await response.text();

    let data = {};

    try{
      data =
        JSON.parse(text);
    }catch{
      throw new Error(
        "Server returned an invalid response (HTTP " +
        response.status +
        ")."
      );
    }

    if(
      !response.ok ||
      !data.ok
    ){
      throw new Error(
        data.message ||
        data.error ||
        "Administrator login failed."
      );
    }

    if(!data.token){
      throw new Error(
        "Login succeeded but no administrator session token was returned."
      );
    }

    token =
      data.token;

    localStorage.setItem(
      "mamaki_admin_token",
      token
    );

    msg.textContent =
      "Login successful. Loading dashboard…";

    await loadAll(
      true
    );
  }catch(error){
    localStorage.removeItem(
      "mamaki_admin_token"
    );

    token = "";

    msg.textContent =
      error.message ||
      "Administrator login failed.";
  }finally{
    button.disabled =
      false;
  }
}

function logout(){
  token = "";

  localStorage.removeItem(
    "mamaki_admin_token"
  );

  $("dash").classList.add(
    "hidden"
  );

  $("actions").classList.add(
    "hidden"
  );

  $("login").classList.remove(
    "hidden"
  );

  $("msg").textContent =
    "Logged out.";
}

function showDashboard(){
  $("login").classList.add(
    "hidden"
  );

  $("dash").classList.remove(
    "hidden"
  );

  $("actions").classList.remove(
    "hidden"
  );
}

function renderPricing(
  packages
){
  if(
    !Array.isArray(
      packages
    ) ||
    !packages.length
  ){
    $("pricing").innerHTML =
      '<div class="empty">No pricing packages available.</div>';
    return;
  }

  $("pricing").innerHTML =
    packages
      .map(
        p => \`
<div class="package">
<div><b>\${esc(p.credits)} Credits</b></div>
<div class="value">\${money(p.amount)}</div>
<div class="muted small">USD reference: $\${Number(p.usdPrice || 0).toFixed(2)}</div>
<div class="muted small">Provider estimate: $\${Number(p.providerCostUsd || 0).toFixed(2)}</div>
<div class="muted small">FX: \${Number(p.fxRate || 0).toFixed(2)} NGN/USD</div>
<div class="muted small">Margin target: \${Number(p.marginTarget || 0) * 100}%</div>
</div>\`
      )
      .join("");
}

function renderUsers(
  users
){
  $("usersTable").innerHTML =
    adminTable(
      [
        "Name",
        "Email",
        "Role",
        "Credits",
        "Status",
        "Created",
        "Last Active",
        "User ID"
      ],
      users.map(
        u => [
          esc(u.name),
          esc(u.email),
          esc(u.role),
          esc(
            u.credits?.usable ??
            0
          ),
          u.disabled
            ? '<span class="bad">Disabled</span>'
            : '<span class="good">Active</span>',
          dt(
            u.createdAt
          ),
          dt(
            u.lastActiveAt
          ),
          esc(u.id)
        ]
      ),
      "No users."
    );
}

function renderJobs(
  jobs
){
  $("jobsTable").innerHTML =
    adminTable(
      [
        "Job",
        "User",
        "Status",
        "Progress",
        "Credits",
        "Created",
        "Completed",
        "Message"
      ],
      jobs.map(
        j => [
          esc(j.id),
          esc(j.userId),
          esc(j.status),
          esc(
            (Number(
              j.progress || 0
            )) +
            "%"
          ),
          esc(
            j.creditCost ||
            0
          ),
          dt(
            j.createdAt
          ),
          dt(
            j.completedAt
          ),
          esc(
            j.message ||
            j.error ||
            ""
          )
        ]
      ),
      "No jobs."
    );
}

function renderPayments(
  payments
){
  $("paymentsTable").innerHTML =
    adminTable(
      [
        "Reference",
        "User",
        "Credits",
        "Amount",
        "Status",
        "Created",
        "Fulfilled"
      ],
      payments.map(
        p => [
          esc(
            p.reference
          ),
          esc(
            p.email ||
            p.userId
          ),
          esc(
            p.credits
          ),
          money(
            p.amount
          ),
          esc(
            p.status
          ),
          dt(
            p.createdAt
          ),
          dt(
            p.fulfilledAt
          )
        ]
      ),
      "No payments."
    );
}

function renderWithdrawals(
  rows
){
  $("withdrawalsTable").innerHTML =
    adminTable(
      [
        "Reference",
        "Amount",
        "Account",
        "Bank",
        "Status",
        "Created"
      ],
      rows.map(
        w => [
          esc(
            w.reference
          ),
          money(
            w.amount
          ),
          esc(
            w.name +
            " ••••" +
            (
              w.accountNumber ||
              ""
            )
          ),
          esc(
            w.bankCode
          ),
          esc(
            w.status
          ),
          dt(
            w.createdAt
          )
        ]
      ),
      "No withdrawals."
    );
}

function renderSecurity(
  rows
){
  $("securityTable").innerHTML =
    adminTable(
      [
        "Time",
        "Event",
        "User",
        "Email",
        "Details"
      ],
      rows.map(
        e => [
          dt(
            e.createdAt
          ),
          esc(
            e.type
          ),
          esc(
            e.userId ||
            e.adminId ||
            ""
          ),
          esc(
            e.email ||
            ""
          ),
          esc(
            JSON.stringify(
              e
            )
          )
        ]
      ),
      "No security events."
    );
}

function renderErrors(
  rows
){
  $("errorsTable").innerHTML =
    adminTable(
      [
        "Time",
        "Message",
        "Route",
        "Details"
      ],
      rows.map(
        e => [
          dt(
            e.createdAt
          ),
          esc(
            e.message
          ),
          esc(
            e.context?.route ||
            ""
          ),
          esc(
            JSON.stringify(
              e.context ||
              {}
            )
          )
        ]
      ),
      "No recorded errors."
    );
}

function adminTable(
  headers,
  rows,
  emptyText
){
  if(
    !Array.isArray(rows) ||
    !rows.length
  ){
    return (
      '<div class="empty">' +
      esc(emptyText) +
      "</div>"
    );
  }

  return \`
<div class="table-wrap">
<table>
<thead>
<tr>
\${headers
  .map(
    h =>
      "<th>" +
      esc(h) +
      "</th>"
  )
  .join("")}
</tr>
</thead>
<tbody>
\${rows
  .map(
    row =>
      "<tr>" +
      row
        .map(
          cell =>
            "<td>" +
            cell +
            "</td>"
        )
        .join("") +
      "</tr>"
  )
  .join("")}
</tbody>
</table>
</div>\`;
}

async function loadAll(
  fromLogin = false
){
  try{
    if(!token){
      return;
    }

    showDashboard();

    const [
      stats,
      users,
      jobs,
      errors,
      security,
      credits,
      billing
    ] =
      await Promise.all([
        getJson(
          "/api/admin/stats"
        ),
        getJson(
          "/api/admin/users"
        ),
        getJson(
          "/api/admin/jobs"
        ),
        getJson(
          "/api/admin/errors"
        ),
        getJson(
          "/api/admin/security"
        ),
        getJson(
          "/api/admin/credits"
        ),
        getJson(
          "/api/admin/billing"
        )
      ]);

    const st =
      stats.stats || {};

    const userList =
      users.users || [];

    const jobList =
      jobs.jobs || [];

    const active =
      userList.filter(
        user =>
          !user.disabled &&
          user.lastActiveAt &&
          Date.now() -
            Date.parse(
              user.lastActiveAt
            ) <
            15 *
              60 *
              1000
      ).length;

    const today =
      userList.filter(
        user =>
          Date.now() -
            Date.parse(
              user.createdAt ||
                0
            ) <
            24 *
              60 *
              60 *
              1000
      ).length;

    const week =
      userList.filter(
        user =>
          Date.now() -
            Date.parse(
              user.createdAt ||
                0
            ) <
            7 *
              24 *
              60 *
              60 *
              1000
      ).length;

    const month =
      userList.filter(
        user =>
          Date.now() -
            Date.parse(
              user.createdAt ||
                0
            ) <
            30 *
              24 *
              60 *
              60 *
              1000
      ).length;

    $("users").textContent =
      st.totalUsers ||
      0;

    $("active").textContent =
      active;

    $("today").textContent =
      today;

    $("week").textContent =
      week;

    $("month").textContent =
      month;

    $("admins").textContent =
      st.totalAdmins ||
      0;

    $("videos").textContent =
      st.aiGenerations ||
      0;

    $("seconds").textContent =
      st.aiSeconds ||
      0;

    $("narrations").textContent =
      st.narrationJobs ||
      0;

    $("projects").textContent =
      st.totalProjects ||
      0;

    $("completed").textContent =
      st.completedJobs ||
      0;

    $("processing").textContent =
      st.processingJobs ||
      0;

    $("failed").textContent =
      st.failedJobs ||
      0;

    const wallet =
      billing.wallet ||
      {};

    $("gross").textContent =
      money(
        wallet.grossRevenue
      );

    $("refunds").textContent =
      money(
        wallet.refunds
      );

    $("costs").textContent =
      money(
        wallet.totalCosts
      );

    $("profit").textContent =
      money(
        wallet.profit
      );

    $("margin").textContent =
      Number(
        wallet.profitMargin ||
          0
      ).toFixed(2) +
      "%";

    $("withdrawn").textContent =
      money(
        wallet.withdrawn
      );

    $("pending").textContent =
      money(
        wallet.pendingWithdrawals
      );

    $("available").textContent =
      money(
        wallet.availableToWithdraw
      );

    $("fx").textContent =
      billing.fx?.rates?.NGN
        ? "₦" +
          Number(
            billing.fx.rates.NGN
          ).toFixed(2)
        : "—";

    $("fxnote").textContent =
      (
        billing.fx?.live
          ? "Live FX rate"
          : "Fallback FX rate"
      ) +
      " · " +
      dt(
        billing.fx?.updatedAt
      );

    $("paystatus").textContent =
      billing.paystack
        ?.configured
        ? "Configured"
        : "Not configured";

    $("targetmargin").textContent =
      Number(
        billing.pricing?.[0]
          ?.marginTarget ||
          0
      ) *
        100 +
      "%";

    const creditData =
      credits.mamaki ||
      {};

    $("issued").textContent =
      Number(
        creditData.issued ||
          0
      ).toLocaleString();

    $("consumed").textContent =
      Number(
        creditData.consumed ||
          0
      ).toLocaleString();

    $("crefund").textContent =
      Number(
        creditData.refunded ||
          0
      ).toLocaleString();

    $("credits").textContent =
      Number(
        creditData.usableCredits ||
          0
      ).toLocaleString();

    $("repstatus").textContent =
      credits.replicate
        ?.configured
        ? "Configured"
        : "Not configured";

    $("repnote").textContent =
      credits.replicate
        ?.note ||
      "";

    renderPricing(
      billing.pricing ||
      []
    );

    renderUsers(
      userList
    );

    renderJobs(
      jobList
    );

    renderPayments(
      billing.payments ||
      []
    );

    renderWithdrawals(
      billing.withdrawals ||
      []
    );

    renderSecurity(
      security.events ||
      []
    );

    renderErrors(
      errors.errors ||
      []
    );

    $("msg").textContent =
      "Dashboard updated successfully.";

  }catch(error){
    if(
      error.auth
    ){
      localStorage.removeItem(
        "mamaki_admin_token"
      );

      token = "";

      $("login").classList.remove(
        "hidden"
      );

      $("dash").classList.add(
        "hidden"
      );

      $("actions").classList.add(
        "hidden"
      );

      $("msg").textContent =
        "Your administrator session expired. Please sign in again.";

      return;
    }

    $("msg").textContent =
      error.message ||
      "Unable to load dashboard.";
  }
}

async function adjustCredits(){
  try{
    const response =
      await fetch(
        "/api/admin/credits/adjust",
        {
          method:"POST",
          cache:"no-store",
          headers:{
            Authorization:
              "Bearer " + token,
            "Content-Type":
              "application/json",
            Accept:
              "application/json"
          },
          body:
            JSON.stringify({
              userId:
                $("creditUser").value,
              amount:
                Number(
                  $("creditAmount").value
                ),
              bucket:
                $("creditBucket").value,
              reason:
                $("creditReason").value
            })
          }
        );

    const data =
      await response.json();

    if(
      !response.ok ||
      !data.ok
    ){
      throw new Error(
        data.message ||
        data.error ||
        "Credit adjustment failed."
      );
    }

    $("creditMsg").textContent =
      "Credit adjustment completed.";

    await loadAll();
  }catch(error){
    $("creditMsg").textContent =
      error.message;
  }
}

async function withdraw(){
  try{
    const response =
      await fetch(
        "/api/admin/withdraw",
        {
          method:"POST",
          cache:"no-store",
          headers:{
            Authorization:
              "Bearer " + token,
            "Content-Type":
              "application/json",
            Accept:
              "application/json"
          },
          body:
            JSON.stringify({
              amount:
                Number(
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

    const data =
      await response.json();

    if(
      !response.ok ||
      !data.ok
    ){
      throw new Error(
        data.message ||
        data.error ||
        "Withdrawal failed."
      );
    }

    $("withdrawMsg").textContent =
      data.message ||
      "Withdrawal submitted.";

    await loadAll();
  }catch(error){
    $("withdrawMsg").textContent =
      error.message;
  }
}

if(token){
  loadAll();
}
</script>
</body>
</html>`);
  }
);

/* =========================================================
   ACCOUNT PAGE
========================================================= */

app.get(
  "/account",
  (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    res.type(
      "html"
    ).send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI Account</title>
<style>
body{
font-family:Arial,sans-serif;
background:#08080d;
color:white;
padding:30px;
}
main{
max-width:760px;
margin:auto;
}
section{
background:#16161f;
padding:22px;
border-radius:16px;
margin:15px 0;
}
input,button{
padding:12px;
border-radius:10px;
border:1px solid #333;
background:#0d0d12;
color:white;
margin:5px 0;
}
button{
cursor:pointer;
}
</style>
</head>
<body>
<main>
<h1>✨ MAMAKI AI</h1>
<section>
<h2>Account</h2>
<p>Your account page is ready.</p>
<p>Use the main MAMAKI interface to generate videos, manage credits and projects.</p>
</section>
</main>
</body>
</html>`);
  }
);

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );

    res.setHeader(
      "Pragma",
      "no-cache"
    );

    res.setHeader(
      "Expires",
      "0"
    );

    res.setHeader(
      "Surrogate-Control",
      "no-store"
    );

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
        "MAMAKI encountered an internal server error.",
    });
  }
);

/* =========================================================
   JOB CLEANUP
========================================================= */

setInterval(
  () => {
    const cutoff =
      Date.now() -
      24 *
        60 *
        60 *
        1000;

    for (
      const [
        id,
        job,
      ] of jobs
    ) {
      if (
        Date.parse(
          job.createdAt ||
            0
        ) <
        cutoff
      ) {
        jobs.delete(id);
      }
    }
  },
  60 * 60 * 1000
);

/* =========================================================
   START
========================================================= */

await ensureStorage();

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `MAMAKI AI Video Creative Studio v${VERSION} listening on ${HOST}:${PORT}`
    );
  }
);
