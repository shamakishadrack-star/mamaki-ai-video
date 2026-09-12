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
  createHash
} from "node:crypto";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
const VERSION = "16.0.0";

const ROOT = process.cwd();
const TMP = path.join(ROOT, "tmp");
const OUTPUTS = path.join(ROOT, "outputs");
const PROJECTS = path.join(ROOT, "projects");
const DATA = path.join(ROOT, "data");

const USERS = path.join(DATA, "users.json");
const SESSIONS = path.join(DATA, "sessions.json");
const USAGE = path.join(DATA, "usage.json");
const ERRORS = path.join(DATA, "errors.json");
const SECURITY = path.join(DATA, "security.json");
const RESETS = path.join(DATA, "password-resets.json");
const CREDITS = path.join(DATA, "credits.json");
const FINANCE = path.join(DATA, "finance.json");

const MIN_DURATION = 5;
const MAX_DURATION = 7200;

const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

const FREE_STARTER_CREDITS = Math.max(
  0,
  Number(process.env.FREE_STARTER_CREDITS || 100)
);

const CREDITS_PER_5_SECONDS = Math.max(
  1,
  Number(process.env.CREDITS_PER_5_SECONDS || 10)
);

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "")
  .trim()
  .toLowerCase();

const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");

const SESSION_SECRET = String(
  process.env.SESSION_SECRET || ""
);

const REPLICATE_API_TOKEN = String(
  process.env.REPLICATE_API_TOKEN || ""
).trim();

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

const T2V_MODEL =
  process.env.T2V_MODEL ||
  "wan-video/wan-2.2-t2v-fast";

const I2V_MODEL =
  process.env.I2V_MODEL ||
  "wan-video/wan-2.2-i2v-fast";

const replicate = REPLICATE_API_TOKEN
  ? new Replicate({
      auth: REPLICATE_API_TOKEN
    })
  : null;

const upload = multer({
  dest: TMP,
  limits: {
    fileSize: 200 * 1024 * 1024
  }
});

const jobs = new Map();

/*
 * Lightweight in-memory rate limiter.
 *
 * This is intentionally simple because MAMAKI is currently
 * running on the Render free instance. It protects the most
 * sensitive authentication endpoints without requiring Redis.
 */
const rateBuckets = new Map();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const existing = rateBuckets.get(key);

  if (
    !existing ||
    existing.resetAt <= now
  ) {
    const fresh = {
      count: 1,
      resetAt: now + windowMs
    };

    rateBuckets.set(key, fresh);

    return {
      allowed: true,
      remaining: Math.max(0, limit - 1),
      resetAt: fresh.resetAt
    };
  }

  existing.count += 1;

  return {
    allowed: existing.count <= limit,
    remaining: Math.max(
      0,
      limit - existing.count
    ),
    resetAt: existing.resetAt
  };
}

function requestIp(req) {
  return String(
    req.headers["x-forwarded-for"] ||
      req.socket?.remoteAddress ||
      "unknown"
  )
    .split(",")[0]
    .trim();
}

function authRateKey(req, extra = "") {
  return `${requestIp(req)}:${extra}`;
}

setInterval(() => {
  const now = Date.now();

  for (const [
    key,
    bucket
  ] of rateBuckets.entries()) {
    if (
      !bucket ||
      bucket.resetAt <= now
    ) {
      rateBuckets.delete(key);
    }
  }
}, 10 * 60 * 1000).unref();

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

app.use(
  "/outputs",
  express.static(OUTPUTS)
);

app.use(
  "/projects",
  express.static(PROJECTS)
);

/* =========================================================
   BASIC HELPERS
========================================================= */

async function ensureDir(dir) {
  await fs.mkdir(dir, {
    recursive: true
  });
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJSON(file, fallback) {
  try {
    const text = await fs.readFile(
      file,
      "utf8"
    );

    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJSON(file, value) {
  await ensureDir(
    path.dirname(file)
  );

  const temp =
    `${file}.${randomUUID()}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify(
      value,
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

function cleanEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function cleanName(value) {
  return String(value || "")
    .trim()
    .slice(0, 100);
}

function clampNumber(
  value,
  min,
  max,
  fallback
) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return Math.min(
    max,
    Math.max(min, n)
  );
}

function normalizeDuration(value) {
  if (typeof value === "number") {
    return clampNumber(
      value,
      MIN_DURATION,
      MAX_DURATION,
      5
    );
  }

  const text = String(
    value || "5"
  )
    .trim()
    .toLowerCase();

  if (
    /^\d+(\.\d+)?s$/.test(text)
  ) {
    return clampNumber(
      parseFloat(text),
      MIN_DURATION,
      MAX_DURATION,
      5
    );
  }

  if (
    /^\d+(\.\d+)?m$/.test(text)
  ) {
    return clampNumber(
      parseFloat(text) * 60,
      MIN_DURATION,
      MAX_DURATION,
      5
    );
  }

  if (
    /^\d+(\.\d+)?h$/.test(text)
  ) {
    return clampNumber(
      parseFloat(text) * 3600,
      MIN_DURATION,
      MAX_DURATION,
      5
    );
  }

  return clampNumber(
    text,
    MIN_DURATION,
    MAX_DURATION,
    5
  );
}

function safeFileName(name) {
  return String(
    name || "file"
  )
    .replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    )
    .slice(0, 180);
}

function publicUrl(fileName) {
  return (
    `${APP_URL}/outputs/` +
    encodeURIComponent(fileName)
  );
}

function projectUrl(fileName) {
  return (
    `${APP_URL}/projects/` +
    encodeURIComponent(fileName)
  );
}

function nowISO() {
  return new Date().toISOString();
}

function startOfToday() {
  const d = new Date();

  d.setHours(
    0,
    0,
    0,
    0
  );

  return d.getTime();
}

function startOfWeek() {
  const d = new Date();

  const day = d.getDay();

  const diff =
    day === 0
      ? 6
      : day - 1;

  d.setDate(
    d.getDate() - diff
  );

  d.setHours(
    0,
    0,
    0,
    0
  );

  return d.getTime();
}

function startOfMonth() {
  const d = new Date();

  d.setDate(1);

  d.setHours(
    0,
    0,
    0,
    0
  );

  return d.getTime();
}

function isWithin(timestamp, since) {
  if (!timestamp) {
    return false;
  }

  const time =
    new Date(timestamp).getTime();

  return (
    Number.isFinite(time) &&
    time >= since
  );
}

/* =========================================================
   PASSWORD / AUTH
========================================================= */

function hashPassword(password) {
  const salt =
    randomBytes(16).toString("hex");

  const hash =
    scryptSync(
      String(password),
      salt,
      64
    ).toString("hex");

  return {
    salt,
    hash
  };
}

function verifyPassword(
  password,
  salt,
  storedHash
) {
  try {
    if (
      !salt ||
      !storedHash
    ) {
      return false;
    }

    const a = Buffer.from(
      scryptSync(
        String(password),
        salt,
        64
      )
    );

    const b = Buffer.from(
      storedHash,
      "hex"
    );

    if (
      a.length !==
      b.length
    ) {
      return false;
    }

    return timingSafeEqual(
      a,
      b
    );
  } catch {
    return false;
  }
}

function sessionHash(token) {
  return createHash("sha256")
    .update(
      `${SESSION_SECRET}:${token}`
    )
    .digest("hex");
}

function resetTokenHash(token) {
  return createHash("sha256")
    .update(
      `${SESSION_SECRET}:RESET:${token}`
    )
    .digest("hex");
}

async function createSession(
  userId,
  kind = "user"
) {
  const sessions =
    await readJSON(
      SESSIONS,
      {}
    );

  const token =
    randomBytes(48).toString(
      "hex"
    );

  const id =
    randomUUID();

  sessions[id] = {
    id,
    userId,
    kind,
    tokenHash:
      sessionHash(token),
    createdAt:
      nowISO(),
    expiresAt:
      new Date(
        Date.now() +
          30 *
            24 *
            60 *
            60 *
            1000
      ).toISOString()
  };

  await writeJSON(
    SESSIONS,
    sessions
  );

  return token;
}

async function destroyUserSessions(
  userId
) {
  const sessions =
    await readJSON(
      SESSIONS,
      {}
    );

  let changed = false;

  for (
    const id of Object.keys(
      sessions
    )
  ) {
    if (
      sessions[id]?.userId ===
      userId
    ) {
      delete sessions[id];
      changed = true;
    }
  }

  if (changed) {
    await writeJSON(
      SESSIONS,
      sessions
    );
  }
}

async function getSession(token) {
  if (!token) {
    return null;
  }

  const sessions =
    await readJSON(
      SESSIONS,
      {}
    );

  const wanted =
    sessionHash(token);

  for (
    const session of Object.values(
      sessions
    )
  ) {
    if (!session) {
      continue;
    }

    if (
      session.tokenHash ===
        wanted &&
      new Date(
        session.expiresAt
      ).getTime() >
        Date.now()
    ) {
      return session;
    }
  }

  return null;
}

function bearerToken(req) {
  const header = String(
    req.headers.authorization ||
      ""
  );

  if (
    !header.startsWith(
      "Bearer "
    )
  ) {
    return "";
  }

  return header
    .slice(7)
    .trim();
}

async function currentUser(req) {
  const token =
    bearerToken(req);

  if (!token) {
    return null;
  }

  const session =
    await getSession(token);

  if (!session) {
    return null;
  }

  const users =
    await readJSON(
      USERS,
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

  /*
   * Every authenticated request updates activity.
   * This makes the admin "active users" metric useful
   * without requiring another paid service.
   */
  const previous =
    user.lastActiveAt;

  const now =
    Date.now();

  if (
    !previous ||
    now -
      new Date(
        previous
      ).getTime() >
      60 * 1000
  ) {
    user.lastActiveAt =
      new Date(now).toISOString();

    users[user.id] = user;

    await writeJSON(
      USERS,
      users
    );
  }

  return user;
}

async function requireUser(
  req,
  res,
  next
) {
  try {
    const user =
      await currentUser(req);

    if (!user) {
      return res
        .status(401)
        .json({
          ok: false,
          error:
            "UNAUTHORIZED",
          message:
            "Please log in."
        });
    }

    req.user = user;

    next();
  } catch (error) {
    await errorLog(
      error,
      {
        route:
          req.path
      }
    );

    res
      .status(500)
      .json({
        ok: false,
        error:
          "AUTH_ERROR"
      });
  }
}

async function requireAdmin(
  req,
  res,
  next
) {
  try {
    const user =
      await currentUser(req);

    if (!user) {
      return res
        .status(401)
        .json({
          ok: false,
          error:
            "UNAUTHORIZED"
        });
    }

    if (
      user.role !==
      "admin"
    ) {
      return res
        .status(403)
        .json({
          ok: false,
          error:
            "ADMIN_ONLY"
        });
    }

    req.user = user;

    next();
  } catch (error) {
    await errorLog(
      error,
      {
        route:
          req.path
      }
    );

    res
      .status(500)
      .json({
        ok: false,
        error:
          "ADMIN_AUTH_ERROR"
      });
  }
}

/* =========================================================
   LOGGING
========================================================= */

async function errorLog(
  error,
  meta = {}
) {
  try {
    const errors =
      await readJSON(
        ERRORS,
        []
      );

    errors.unshift({
      id:
        randomUUID(),
      message:
        String(
          error?.message ||
            error
        ),
      stack:
        String(
          error?.stack ||
            ""
        ),
      meta,
      createdAt:
        nowISO()
    });

    await writeJSON(
      ERRORS,
      errors.slice(
        0,
        500
      )
    );
  } catch {}
}

async function security(
  event,
  meta = {}
) {
  try {
    const events =
      await readJSON(
        SECURITY,
        []
      );

    events.unshift({
      id:
        randomUUID(),
      event,
      meta,
      createdAt:
        nowISO()
    });

    await writeJSON(
      SECURITY,
      events.slice(
        0,
        1000
      )
    );
  } catch {}
}

/* =========================================================
   USAGE
========================================================= */

async function addUsage(
  userId,
  type,
  amount = 1
) {
  const usage =
    await readJSON(
      USAGE,
      {}
    );

  const day =
    new Date()
      .toISOString()
      .slice(0, 10);

  if (!usage[userId]) {
    usage[userId] = {};
  }

  if (
    !usage[userId][day]
  ) {
    usage[userId][day] = {};
  }

  usage[userId][day][type] =
    Number(
      usage[userId][day][type] ||
        0
    ) + amount;

  await writeJSON(
    USAGE,
    usage
  );
}

/* =========================================================
   INTERNAL CREDIT SYSTEM
========================================================= */

function creditCostForDuration(
  duration
) {
  const safe =
    normalizeDuration(
      duration
    );

  return Math.max(
    1,
    Math.ceil(
      safe / 5
    ) *
      CREDITS_PER_5_SECONDS
  );
}

async function readCredits() {
  return readJSON(
    CREDITS,
    {
      users: {},
      transactions: []
    }
  );
}

async function ensureCreditAccount(
  userId,
  grantStarter = true
) {
  const data =
    await readCredits();

  if (
    !data.users[userId]
  ) {
    data.users[userId] = {
      userId,
      freeCredits: 0,
      paidCredits: 0,
      promotionalCredits: 0,
      consumedCredits: 0,
      createdAt:
        nowISO(),
      updatedAt:
        nowISO()
    };

    if (grantStarter) {
      data.users[userId]
        .freeCredits =
        FREE_STARTER_CREDITS;

      data.transactions.unshift({
        id:
          randomUUID(),
        userId,
        type:
          "credit_issue",
        bucket:
          "free",
        amount:
          FREE_STARTER_CREDITS,
        reason:
          "MAMAKI starter credits",
        createdAt:
          nowISO()
      });
    }

    await writeJSON(
      CREDITS,
      data
    );
  }

  return data.users[userId];
}

function availableCredits(
  account
) {
  return (
    Number(
      account?.freeCredits || 0
    ) +
    Number(
      account?.paidCredits || 0
    ) +
    Number(
      account?.promotionalCredits ||
        0
    )
  );
}

async function getCreditBalance(
  userId
) {
  const account =
    await ensureCreditAccount(
      userId,
      true
    );

  return {
    freeCredits:
      Number(
        account.freeCredits ||
          0
      ),
    paidCredits:
      Number(
        account.paidCredits ||
          0
      ),
    promotionalCredits:
      Number(
        account.promotionalCredits ||
          0
      ),
    consumedCredits:
      Number(
        account.consumedCredits ||
          0
      ),
    total:
      availableCredits(
        account
      )
  };
}

async function changeCredits({
  userId,
  amount,
  bucket = "promotional",
  reason = "",
  adminId = null,
  type = "credit_adjustment"
}) {
  const numeric =
    Number(amount);

  if (
    !Number.isFinite(
      numeric
    ) ||
    numeric === 0
  ) {
    throw new Error(
      "Credit amount must be a non-zero number."
    );
  }

  const validBuckets = [
    "free",
    "paid",
    "promotional"
  ];

  if (
    !validBuckets.includes(
      bucket
    )
  ) {
    throw new Error(
      "Invalid credit bucket."
    );
  }

  const data =
    await readCredits();

  const account =
    data.users[userId] ||
    {
      userId,
      freeCredits: 0,
      paidCredits: 0,
      promotionalCredits: 0,
      consumedCredits: 0,
      createdAt:
        nowISO(),
      updatedAt:
        nowISO()
    };

  const field =
    bucket === "free"
      ? "freeCredits"
      : bucket === "paid"
        ? "paidCredits"
        : "promotionalCredits";

  const before =
    Number(
      account[field] || 0
    );

  const after =
    before + numeric;

  if (after < 0) {
    throw new Error(
      "Credit balance cannot become negative."
    );
  }

  account[field] =
    after;

  account.updatedAt =
    nowISO();

  data.users[userId] =
    account;

  data.transactions.unshift({
    id:
      randomUUID(),
    userId,
    adminId,
    type,
    bucket,
    amount:
      numeric,
    balanceAfter:
      availableCredits(
        account
      ),
    reason:
      String(reason || "")
        .slice(0, 500),
    createdAt:
      nowISO()
  });

  data.transactions =
    data.transactions.slice(
      0,
      5000
    );

  await writeJSON(
    CREDITS,
    data
  );

  return account;
}

async function reserveCredits(
  userId,
  amount,
  reason
) {
  const cost =
    Math.max(
      1,
      Number(amount)
    );

  const data =
    await readCredits();

  const account =
    data.users[userId] ||
    await ensureCreditAccount(
      userId,
      true
    );

  const free =
    Number(
      account.freeCredits ||
        0
    );

  const paid =
    Number(
      account.paidCredits ||
        0
    );

  const promo =
    Number(
      account.promotionalCredits ||
        0
    );

  if (
    free +
      paid +
      promo <
    cost
  ) {
    const error =
      new Error(
        "Insufficient MAMAKI credits."
      );

    error.code =
      "INSUFFICIENT_CREDITS";

    throw error;
  }

  let remaining =
    cost;

  const consumed = {
    free: 0,
    paid: 0,
    promotional: 0
  };

  const freeUse =
    Math.min(
      free,
      remaining
    );

  account.freeCredits -=
    freeUse;

  remaining -=
    freeUse;

  consumed.free =
    freeUse;

  const promoUse =
    Math.min(
      promo,
      remaining
    );

  account.promotionalCredits -=
    promoUse;

  remaining -=
    promoUse;

  consumed.promotional =
    promoUse;

  const paidUse =
    Math.min(
      paid,
      remaining
    );

  account.paidCredits -=
    paidUse;

  remaining -=
    paidUse;

  consumed.paid =
    paidUse;

  account.consumedCredits =
    Number(
      account.consumedCredits ||
        0
    ) + cost;

  account.updatedAt =
    nowISO();

  data.users[userId] =
    account;

  data.transactions.unshift({
    id:
      randomUUID(),
    userId,
    type:
      "credit_consumption",
    amount:
      -cost,
    reason:
      String(
        reason || "AI generation"
      ).slice(0, 500),
    consumed,
    balanceAfter:
      availableCredits(
        account
      ),
    createdAt:
      nowISO()
  });

  await writeJSON(
    CREDITS,
    data
  );

  return {
    amount: cost,
    consumed,
    transactionId:
      data.transactions[0].id
  };
}

async function refundCredits(
  userId,
  reservation,
  reason
) {
  if (
    !reservation ||
    !reservation.consumed
  ) {
    return;
  }

  const data =
    await readCredits();

  const account =
    data.users[userId] ||
    {
      userId,
      freeCredits: 0,
      paidCredits: 0,
      promotionalCredits: 0,
      consumedCredits: 0,
      createdAt:
        nowISO(),
      updatedAt:
        nowISO()
    };

  const free =
    Number(
      reservation.consumed
        .free || 0
    );

  const promo =
    Number(
      reservation.consumed
        .promotional || 0
    );

  const paid =
    Number(
      reservation.consumed
        .paid || 0
    );

  account.freeCredits +=
    free;

  account.promotionalCredits +=
    promo;

  account.paidCredits +=
    paid;

  account.consumedCredits =
    Math.max(
      0,
      Number(
        account.consumedCredits ||
          0
      ) -
        Number(
          reservation.amount ||
            0
        )
    );

  account.updatedAt =
    nowISO();

  data.users[userId] =
    account;

  data.transactions.unshift({
    id:
      randomUUID(),
    userId,
    type:
      "credit_refund",
    amount:
      Number(
        reservation.amount ||
          0
      ),
    reason:
      String(
        reason ||
          "AI generation failed"
      ).slice(0, 500),
    createdAt:
      nowISO()
  });

  await writeJSON(
    CREDITS,
    data
  );
}

/* =========================================================
   FINANCE / BUSINESS METRICS
========================================================= */

async function readFinance() {
  return readJSON(
    FINANCE,
    {
      transactions: []
    }
  );
}

async function addFinanceTransaction({
  type,
  amount,
  category,
  description,
  adminId = null,
  userId = null
}) {
  const numeric =
    Number(amount);

  if (
    !Number.isFinite(
      numeric
    ) ||
    numeric <= 0
  ) {
    throw new Error(
      "Financial amount must be greater than zero."
    );
  }

  const validTypes = [
    "revenue",
    "refund",
    "cost"
  ];

  if (
    !validTypes.includes(
      type
    )
  ) {
    throw new Error(
      "Invalid financial transaction type."
    );
  }

  const data =
    await readFinance();

  const item = {
    id:
      randomUUID(),
    type,
    amount:
      numeric,
    category:
      String(
        category || "general"
      ).slice(0, 100),
    description:
      String(
        description || ""
      ).slice(0, 500),
    adminId,
    userId,
    createdAt:
      nowISO()
  };

  data.transactions.unshift(
    item
  );

  data.transactions =
    data.transactions.slice(
      0,
      5000
    );

  await writeJSON(
    FINANCE,
    data
  );

  return item;
}

function calculateFinance(
  transactions,
  since = 0
) {
  let revenue = 0;
  let refunds = 0;
  let costs = 0;

  for (
    const item of transactions
  ) {
    const timestamp =
      new Date(
        item.createdAt
      ).getTime();

    if (
      !Number.isFinite(
        timestamp
      ) ||
      timestamp < since
    ) {
      continue;
    }

    const amount =
      Number(
        item.amount || 0
      );

    if (
      item.type ===
      "revenue"
    ) {
      revenue +=
        amount;
    }

    if (
      item.type ===
      "refund"
    ) {
      refunds +=
        amount;
    }

    if (
      item.type ===
      "cost"
    ) {
      costs +=
        amount;
    }
  }

  const netRevenue =
    revenue -
    refunds;

  const profit =
    netRevenue -
    costs;

  const margin =
    netRevenue > 0
      ? (
          profit /
          netRevenue
        ) *
        100
      : 0;

  return {
    revenue,
    refunds,
    netRevenue,
    costs,
    profit,
    profitMargin:
      Number(
        margin.toFixed(2)
      )
  };
}

/* =========================================================
   AUTH API
========================================================= */

app.post(
  "/api/auth/register",
  async (req, res) => {
    try {
      const limiter =
        rateLimit(
          authRateKey(
            req,
            "register"
          ),
          10,
          60 * 60 * 1000
        );

      if (
        !limiter.allowed
      ) {
        return res
          .status(429)
          .json({
            ok: false,
            error:
              "RATE_LIMITED",
            message:
              "Too many registration attempts. Please try again later."
          });
      }

      const name =
        cleanName(
          req.body.name
        );

      const mail =
        cleanEmail(
          req.body.email
        );

      const password =
        String(
          req.body.password ||
            ""
        );

      if (
        !name ||
        !mail ||
        password.length < 6
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "INVALID_REGISTRATION",
            message:
              "Name, valid email and password of at least 6 characters are required."
          });
      }

      const users =
        await readJSON(
          USERS,
          {}
        );

      const existsUser =
        Object.values(
          users
        ).find(
          u =>
            cleanEmail(
              u.email
            ) === mail
        );

      if (existsUser) {
        return res
          .status(409)
          .json({
            ok: false,
            error:
              "EMAIL_EXISTS",
            message:
              "An account with this email already exists."
          });
      }

      const hp =
        hashPassword(
          password
        );

      const id =
        randomUUID();

      users[id] = {
        id,
        name,
        email: mail,
        ...hp,
        role:
          mail ===
          ADMIN_EMAIL
            ? "admin"
            : "user",
        disabled: false,
        createdAt:
          nowISO(),
        lastLoginAt:
          null,
        lastActiveAt:
          nowISO()
      };

      await writeJSON(
        USERS,
        users
      );

      await ensureCreditAccount(
        id,
        true
      );

      const token =
        await createSession(
          id,
          users[id].role ===
            "admin"
            ? "admin"
            : "user"
        );

      await security(
        "REGISTER",
        {
          userId: id,
          email: mail
        }
      );

      res.json({
        ok: true,
        token,
        user: {
          id,
          name,
          email: mail,
          role:
            users[id].role
        },
        credits:
          await getCreditBalance(
            id
          )
      });
    } catch (error) {
      await errorLog(
        error,
        {
          route:
            "/api/auth/register"
        }
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "REGISTER_ERROR"
        });
    }
  }
);

app.post(
  "/api/auth/login",
  async (req, res) => {
    try {
      const limiter =
        rateLimit(
          authRateKey(
            req,
            "login"
          ),
          15,
          15 * 60 * 1000
        );

      if (
        !limiter.allowed
      ) {
        return res
          .status(429)
          .json({
            ok: false,
            error:
              "RATE_LIMITED",
            message:
              "Too many login attempts. Please wait and try again."
          });
      }

      const mail =
        cleanEmail(
          req.body.email
        );

      const password =
        String(
          req.body.password ||
            ""
        );

      const users =
        await readJSON(
          USERS,
          {}
        );

      const user =
        Object.values(
          users
        ).find(
          u =>
            cleanEmail(
              u.email
            ) === mail
        );

      if (
        !user ||
        user.disabled ||
        !verifyPassword(
          password,
          user.salt,
          user.hash
        )
      ) {
        await security(
          "LOGIN_FAILED",
          {
            email:
              mail,
            ip:
              requestIp(req)
          }
        );

        return res
          .status(401)
          .json({
            ok: false,
            error:
              "INVALID_CREDENTIALS",
            message:
              "Invalid email or password."
          });
      }

      user.lastLoginAt =
        nowISO();

      user.lastActiveAt =
        nowISO();

      users[user.id] =
        user;

      await writeJSON(
        USERS,
        users
      );

      await ensureCreditAccount(
        user.id,
        true
      );

      const token =
        await createSession(
          user.id,
          user.role ===
            "admin"
            ? "admin"
            : "user"
        );

      await security(
        "LOGIN_SUCCESS",
        {
          userId:
            user.id,
          email:
            user.email
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
            user.role
        },
        credits:
          await getCreditBalance(
            user.id
          )
      });
    } catch (error) {
      await errorLog(
        error,
        {
          route:
            "/api/auth/login"
        }
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "LOGIN_ERROR"
        });
    }
  }
);

app.post(
  "/api/auth/logout",
  async (req, res) => {
    try {
      const token =
        bearerToken(req);

      if (token) {
        const sessions =
          await readJSON(
            SESSIONS,
            {}
          );

        const wanted =
          sessionHash(token);

        for (
          const id of Object.keys(
            sessions
          )
        ) {
          if (
            sessions[id]
              ?.tokenHash ===
            wanted
          ) {
            delete sessions[id];
          }
        }

        await writeJSON(
          SESSIONS,
          sessions
        );
      }

      res.json({
        ok: true
      });
    } catch {
      res.json({
        ok: true
      });
    }
  }
);

app.get(
  "/api/auth/me",
  requireUser,
  async (req, res) => {
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
          req.user.role
      },
      credits:
        await getCreditBalance(
          req.user.id
        )
    });
  }
);

app.post(
  "/api/auth/heartbeat",
  requireUser,
  async (req, res) => {
    res.json({
      ok: true,
      activeAt:
        req.user.lastActiveAt
    });
  }
);

/* =========================================================
   ACCOUNT
========================================================= */

app.get(
  "/api/account",
  requireUser,
  async (req, res) => {
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
        createdAt:
          req.user.createdAt,
        lastLoginAt:
          req.user.lastLoginAt,
        lastActiveAt:
          req.user.lastActiveAt
      },
      credits:
        await getCreditBalance(
          req.user.id
        )
    });
  }
);

app.get(
  "/api/account/credits",
  requireUser,
  async (req, res) => {
    res.json({
      ok: true,
      credits:
        await getCreditBalance(
          req.user.id
        )
    });
  }
);

app.post(
  "/api/account/profile",
  requireUser,
  async (req, res) => {
    try {
      const users =
        await readJSON(
          USERS,
          {}
        );

      const user =
        users[req.user.id];

      user.name =
        cleanName(
          req.body.name
        ) ||
        user.name;

      user.lastActiveAt =
        nowISO();

      users[user.id] =
        user;

      await writeJSON(
        USERS,
        users
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
            user.role
        }
      });
    } catch (error) {
      await errorLog(
        error,
        {
          route:
            "/api/account/profile"
        }
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "PROFILE_ERROR"
        });
    }
  }
);

app.post(
  "/api/account/change-password",
  requireUser,
  async (req, res) => {
    try {
      const oldPassword =
        String(
          req.body.oldPassword ||
            ""
        );

      const newPassword =
        String(
          req.body.newPassword ||
            ""
        );

      const users =
        await readJSON(
          USERS,
          {}
        );

      const user =
        users[req.user.id];

      if (
        !verifyPassword(
          oldPassword,
          user.salt,
          user.hash
        )
      ) {
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "WRONG_PASSWORD"
          });
      }

      if (
        newPassword.length < 6
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "PASSWORD_TOO_SHORT"
          });
      }

      const hp =
        hashPassword(
          newPassword
        );

      user.salt =
        hp.salt;

      user.hash =
        hp.hash;

      user.lastActiveAt =
        nowISO();

      users[user.id] =
        user;

      await writeJSON(
        USERS,
        users
      );

      await destroyUserSessions(
        user.id
      );

      await security(
        "PASSWORD_CHANGED",
        {
          userId:
            user.id
        }
      );

      const token =
        await createSession(
          user.id,
          user.role ===
            "admin"
            ? "admin"
            : "user"
        );

      res.json({
        ok: true,
        token
      });
    } catch (error) {
      await errorLog(
        error,
        {
