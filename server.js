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
const VERSION = "17.0.0";

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
const JOBS = path.join(DATA, "jobs.json");
const PROJECT_INDEX = path.join(DATA, "projects.json");

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

const ADMIN_EMAIL = String(
  process.env.ADMIN_EMAIL || ""
)
  .trim()
  .toLowerCase();

const ADMIN_PASSWORD = String(
  process.env.ADMIN_PASSWORD || ""
);

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
const rateBuckets = new Map();

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
   STORAGE
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

async function ensureStorage() {
  await Promise.all([
    ensureDir(TMP),
    ensureDir(OUTPUTS),
    ensureDir(PROJECTS),
    ensureDir(DATA)
  ]);

  const defaults = [
    [USERS, {}],
    [SESSIONS, {}],
    [USAGE, {}],
    [ERRORS, []],
    [SECURITY, []],
    [RESETS, {}],
    [CREDITS, {
      users: {},
      transactions: []
    }],
    [FINANCE, {
      transactions: []
    }],
    [JOBS, {}],
    [PROJECT_INDEX, []]
  ];

  for (const [file, value] of defaults) {
    if (!(await exists(file))) {
      await writeJSON(
        file,
        value
      );
    }
  }

  /*
   * Keep the configured master administrator
   * protected and automatically restore the admin
   * role if the account already exists.
   */
  if (ADMIN_EMAIL) {
    const users =
      await readJSON(
        USERS,
        {}
      );

    const admin =
      Object.values(users).find(
        user =>
          String(
            user?.email || ""
          ).toLowerCase() ===
          ADMIN_EMAIL
      );

    if (admin) {
      let changed = false;

      if (admin.role !== "admin") {
        admin.role = "admin";
        changed = true;
      }

      if (admin.disabled) {
        admin.disabled = false;
        changed = true;
      }

      if (changed) {
        users[admin.id] = admin;

        await writeJSON(
          USERS,
          users
        );

        await security(
          "ADMIN_ACCOUNT_RESTORED",
          {
            userId: admin.id,
            email: admin.email
          }
        );
      }
    }
  }
}

/* =========================================================
   GENERAL HELPERS
========================================================= */

function nowISO() {
  return new Date().toISOString();
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

function safeFileName(value) {
  return String(
    value || "file"
  )
    .replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    )
    .slice(0, 180);
}

function clampNumber(
  value,
  min,
  max,
  fallback
) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(
    max,
    Math.max(min, number)
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

  if (/^\d+(\.\d+)?s$/.test(text)) {
    return clampNumber(
      parseFloat(text),
      MIN_DURATION,
      MAX_DURATION,
      5
    );
  }

  if (/^\d+(\.\d+)?m$/.test(text)) {
    return clampNumber(
      parseFloat(text) * 60,
      MIN_DURATION,
      MAX_DURATION,
      5
    );
  }

  if (/^\d+(\.\d+)?h$/.test(text)) {
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

function startOfToday() {
  const date = new Date();

  date.setHours(
    0,
    0,
    0,
    0
  );

  return date.getTime();
}

function startOfWeek() {
  const date = new Date();
  const day = date.getDay();
  const difference =
    day === 0
      ? 6
      : day - 1;

  date.setDate(
    date.getDate() -
      difference
  );

  date.setHours(
    0,
    0,
    0,
    0
  );

  return date.getTime();
}

function startOfMonth() {
  const date = new Date();

  date.setDate(1);

  date.setHours(
    0,
    0,
    0,
    0
  );

  return date.getTime();
}

function startOfYear() {
  const date = new Date();

  date.setMonth(0);
  date.setDate(1);

  date.setHours(
    0,
    0,
    0,
    0
  );

  return date.getTime();
}

function isWithin(
  timestamp,
  since
) {
  const value =
    new Date(
      timestamp || ""
    ).getTime();

  return (
    Number.isFinite(value) &&
    value >= since
  );
}

function publicUrl(name) {
  return (
    `${APP_URL}/outputs/` +
    encodeURIComponent(name)
  );
}

function projectUrl(name) {
  return (
    `${APP_URL}/projects/` +
    encodeURIComponent(name)
  );
}

/* =========================================================
   RATE LIMITING
========================================================= */

function requestIp(req) {
  return String(
    req.headers["x-forwarded-for"] ||
      req.socket?.remoteAddress ||
      "unknown"
  )
    .split(",")[0]
    .trim();
}

function rateLimit(
  key,
  limit,
  windowMs
) {
  const now = Date.now();
  const current =
    rateBuckets.get(key);

  if (
    !current ||
    current.resetAt <= now
  ) {
    const fresh = {
      count: 1,
      resetAt:
        now + windowMs
    };

    rateBuckets.set(
      key,
      fresh
    );

    return {
      allowed: true,
      remaining:
        Math.max(
          0,
          limit - 1
        ),
      resetAt:
        fresh.resetAt
    };
  }

  current.count += 1;

  return {
    allowed:
      current.count <=
      limit,
    remaining:
      Math.max(
        0,
        limit -
          current.count
      ),
    resetAt:
      current.resetAt
  };
}

function authRateKey(
  req,
  extra
) {
  return (
    requestIp(req) +
    ":" +
    String(extra || "")
  );
}

setInterval(
  () => {
    const now =
      Date.now();

    for (
      const [
        key,
        value
      ] of rateBuckets.entries()
    ) {
      if (
        !value ||
        value.resetAt <= now
      ) {
        rateBuckets.delete(
          key
        );
      }
    }
  },
  10 * 60 * 1000
).unref();

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
   PASSWORDS / SESSIONS
========================================================= */

function hashPassword(
  password
) {
  const salt =
    randomBytes(16).toString(
      "hex"
    );

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

    const derived =
      Buffer.from(
        scryptSync(
          String(password),
          salt,
          64
        )
      );

    const stored =
      Buffer.from(
        storedHash,
        "hex"
      );

    if (
      derived.length !==
      stored.length
    ) {
      return false;
    }

    return timingSafeEqual(
      derived,
      stored
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

function bearerToken(req) {
  const header =
    String(
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

async function getSession(
  token
) {
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
    if (
      session &&
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

async function currentUser(
  req
) {
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

  const previous =
    new Date(
      user.lastActiveAt ||
        0
    ).getTime();

  if (
    !Number.isFinite(
      previous
    ) ||
    Date.now() -
      previous >
      60 * 1000
  ) {
    user.lastActiveAt =
      nowISO();

    users[user.id] =
      user;

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
            "UNAUTHORIZED"
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
      await security(
        "ADMIN_ACCESS_DENIED",
        {
          userId:
            user.id,
          email:
            user.email,
          path:
            req.path,
          ip:
            requestIp(req)
        }
      );

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
    ) + Number(amount);

  await writeJSON(
    USAGE,
    usage
  );
}

async function usageTotals() {
  const usage =
    await readJSON(
      USAGE,
      {}
    );

  const totals = {
    videoGeneration: 0,
    narration: 0,
    aiGenerationRequest: 0,
    passwordReset: 0
  };

  for (
    const userData of Object.values(
      usage
    )
  ) {
    for (
      const dayData of Object.values(
        userData || {}
      )
    ) {
      for (
        const key of Object.keys(
          totals
        )
      ) {
        totals[key] +=
          Number(
            dayData?.[key] ||
              0
          );
      }
    }
  }

  return totals;
}

/* =========================================================
   CREDITS
========================================================= */

function creditCostForDuration(
  duration
) {
  return Math.max(
    1,
    Math.ceil(
      normalizeDuration(
        duration
      ) / 5
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
      freeCredits:
        grantStarter
          ? FREE_STARTER_CREDITS
          : 0,
      paidCredits: 0,
      promotionalCredits: 0,
      consumedCredits: 0,
      createdAt:
        nowISO(),
      updatedAt:
        nowISO()
    };

    if (
      grantStarter &&
      FREE_STARTER_CREDITS >
        0
    ) {
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
  const data =
    await readCredits();

  if (
    !data.users[userId]
  ) {
    await ensureCreditAccount(
      userId,
      true
    );

    return getCreditBalance(
      userId
    );
  }

  const account =
    data.users[userId];

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

  if (
    ![
      "free",
      "paid",
      "promotional"
    ].includes(bucket)
  ) {
    throw new Error(
      "Invalid credit bucket."
    );
  }

  const data =
    await readCredits();

  if (!data.users[userId]) {
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
  }

  const account =
    data.users[userId];

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
      String(
        reason || ""
      ).slice(0, 500),
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

  /*
   * FIX:
   * The old implementation could call
   * ensureCreditAccount() on a separate object
   * and then continue using the stale object.
   * This implementation creates the account directly
   * inside the same data object.
   */
  if (!data.users[userId]) {
    data.users[userId] = {
      userId,
      freeCredits:
        FREE_STARTER_CREDITS,
      paidCredits: 0,
      promotionalCredits: 0,
      consumedCredits: 0,
      createdAt:
        nowISO(),
      updatedAt:
        nowISO()
    };

    if (
      FREE_STARTER_CREDITS >
      0
    ) {
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
  }

  const account =
    data.users[userId];

  const free =
    Number(
      account.freeCredits || 0
    );

  const promo =
    Number(
      account.promotionalCredits ||
        0
    );

  const paid =
    Number(
      account.paidCredits || 0
    );

  if (
    free +
      promo +
      paid <
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
    promotional: 0,
    paid: 0
  };

  consumed.free =
    Math.min(
      free,
      remaining
    );

  account.freeCredits -=
    consumed.free;

  remaining -=
    consumed.free;

  consumed.promotional =
    Math.min(
      promo,
      remaining
    );

  account.promotionalCredits -=
    consumed.promotional;

  remaining -=
    consumed.promotional;

  consumed.paid =
    Math.min(
      paid,
      remaining
    );

  account.paidCredits -=
    consumed.paid;

  account.consumedCredits =
    Number(
      account.consumedCredits ||
        0
    ) + cost;

  account.updatedAt =
    nowISO();

  const transaction = {
    id:
      randomUUID(),
    userId,
    type:
      "credit_consumption",
    amount:
      -cost,
    reason:
      String(
        reason ||
          "AI generation"
      ).slice(0, 500),
    consumed,
    balanceAfter:
      availableCredits(
        account
      ),
    createdAt:
      nowISO()
  };

  data.transactions.unshift(
    transaction
  );

  await writeJSON(
    CREDITS,
    data
  );

  return {
    amount: cost,
    consumed,
    transactionId:
      transaction.id
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

  if (!data.users[userId]) {
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
  }

  const account =
    data.users[userId];

  const free =
    Number(
      reservation.consumed.free ||
        0
    );

  const promotional =
    Number(
      reservation.consumed
        .promotional || 0
    );

  const paid =
    Number(
      reservation.consumed.paid ||
        0
    );

  account.freeCredits +=
    free;

  account.promotionalCredits +=
    promotional;

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

  data.transactions.unshift({
    id:
      randomUUID(),
    userId,
    type:
      "credit_refund",
    amount:
      Number(
        reservation.amount || 0
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
   FINANCE
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
  userId = null,
  currency = "NGN"
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
      "Amount must be greater than zero."
    );
  }

  if (
    ![
      "revenue",
      "refund",
      "cost"
    ].includes(type)
  ) {
    throw new Error(
      "Invalid financial type."
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
    currency:
      String(
        currency || "NGN"
      ).slice(0, 10),
    category:
      String(
        category ||
          "general"
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

  const categories = {
    ai: 0,
    infrastructure: 0,
    other: 0
  };

  for (
    const item of transactions
  ) {
    const time =
      new Date(
        item.createdAt || ""
      ).getTime();

    if (
      !Number.isFinite(time) ||
      time < since
    ) {
      continue;
    }

    const amount =
      Number(
        item.amount || 0
      );

    if (
      item.type === "revenue"
    ) {
      revenue += amount;
    }

    if (
      item.type === "refund"
    ) {
      refunds += amount;
    }

    if (
      item.type === "cost"
    ) {
      costs += amount;

      const category =
        String(
          item.category ||
            "other"
        ).toLowerCase();

      if (
        category.includes(
          "ai"
        ) ||
        category.includes(
          "replicate"
        )
      ) {
        categories.ai +=
          amount;
      } else if (
        category.includes(
          "infra"
        ) ||
        category.includes(
          "hosting"
        ) ||
        category.includes(
          "server"
        )
      ) {
        categories.infrastructure +=
          amount;
      } else {
        categories.other +=
          amount;
      }
    }
  }

  const netRevenue =
    revenue - refunds;

  const profit =
    netRevenue - costs;

  return {
    revenue,
    refunds,
    netRevenue,
    costs,
    aiCosts:
      categories.ai,
    infrastructureCosts:
      categories.infrastructure,
    otherCosts:
      categories.other,
    profit,
    profitMargin:
      netRevenue > 0
        ? Number(
            (
              (profit /
                netRevenue) *
              100
            ).toFixed(2)
          )
        : 0
  };
}

/* =========================================================
   AUTHENTICATION
========================================================= */

app.post(
  "/api/auth/register",
  async (req, res) => {
    try {
      const limit =
        rateLimit(
          authRateKey(
            req,
            "register"
          ),
          10,
          60 * 60 * 1000
        );

      if (!limit.allowed) {
        return res
          .status(429)
          .json({
            ok: false,
            error:
              "RATE_LIMITED"
          });
      }

      const name =
        cleanName(
          req.body.name
        );

      const email =
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
        !email ||
        password.length < 6
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "INVALID_REGISTRATION"
          });
      }

      const users =
        await readJSON(
          USERS,
          {}
        );

      const existing =
        Object.values(
          users
        ).find(
          user =>
            cleanEmail(
              user.email
            ) === email
        );

      if (existing) {
        return res
          .status(409)
          .json({
            ok: false,
            error:
              "EMAIL_EXISTS"
          });
      }

      const passwordData =
        hashPassword(
          password
        );

      const id =
        randomUUID();

      const role =
        ADMIN_EMAIL &&
        email ===
          ADMIN_EMAIL
          ? "admin"
          : "user";

      users[id] = {
        id,
        name,
        email,
        salt:
          passwordData.salt,
        hash:
          passwordData.hash,
        role,
        disabled: false,
        plan: "free",
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
          role
        );

      await security(
        "REGISTER",
        {
          userId: id,
          email,
          role,
          ip:
            requestIp(req)
        }
      );

      res.json({
        ok: true,
        token,
        user: {
          id,
          name,
          email,
          role
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
      const limit =
        rateLimit(
          authRateKey(
            req,
            "login"
          ),
          15,
          15 * 60 * 1000
        );

      if (!limit.allowed) {
        return res
          .status(429)
          .json({
            ok: false,
            error:
              "RATE_LIMITED"
          });
      }

      const email =
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
          item =>
            cleanEmail(
              item.email
            ) === email
        );

      const valid =
        Boolean(
          user &&
          !user.disabled &&
          verifyPassword(
            password,
            user.salt,
            user.hash
          )
        );

      if (!valid) {
        await security(
          "LOGIN_FAILED",
          {
            email,
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
        user.role ===
          "admin"
          ? "ADMIN_LOGIN_SUCCESS"
          : "LOGIN_SUCCESS",
        {
          userId:
            user.id,
          email:
            user.email,
          method:
            "PASSWORD",
          ip:
            requestIp(req)
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
    } catch {}

    res.json({
      ok: true
    });
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
          req.user.role,
        plan:
          req.user.plan ||
          "free"
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
   FORGOT PASSWORD
========================================================= */

async function sendResetEmail(
  email,
  token
) {
  if (
    !RESEND_API_KEY ||
    !RESEND_FROM
  ) {
    return {
      sent: false,
      configured: false
    };
  }

  const link =
    `${APP_URL}/reset-password?token=` +
    encodeURIComponent(token);

  const response =
    await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${RESEND_API_KEY}`,
          "Content-Type":
            "application/json"
        },
        body:
          JSON.stringify({
            from:
              RESEND_FROM,
            to: [email],
            subject:
              "Reset your MAMAKI AI password",
            html:
              [
                "<div style=\"font-family:Arial,sans-serif;max-width:600px;margin:auto\">",
                "<h2>MAMAKI AI</h2>",
                "<p>We received a request to reset your password.</p>",
                "<p>This link expires in 30 minutes and can only be used once.</p>",
                `<p><a href="${link}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:8px">Reset Password</a></p>`,
                "<p>If you did not request this, you can safely ignore this email.</p>",
                "</div>"
              ].join("")
          })
      }
    );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Password reset email failed: ${response.status} ${body}`
    );
  }

  return {
    sent: true,
    configured: true
  };
}

app.post(
  "/api/auth/forgot-password",
  async (req, res) => {
    try {
      const email =
        cleanEmail(
          req.body.email
        );

      const limit =
        rateLimit(
          authRateKey(
            req,
            `forgot:${email}`
          ),
          5,
          15 * 60 * 1000
        );

      if (!limit.allowed) {
        return res
          .status(429)
          .json({
            ok: false,
            error:
              "RATE_LIMITED",
            message:
              "Too many password reset requests. Please try again later."
          });
      }

      /*
       * Always use a generic response so that the
       * endpoint cannot be used to enumerate accounts.
       */
      const generic = {
        ok: true,
        message:
          "If an account exists for that email, a password reset link will be sent."
      };

      if (!email) {
        return res.json(
          generic
        );
      }

      const users =
        await readJSON(
          USERS,
          {}
        );

      const user =
        Object.values(
          users
        ).find(
          item =>
            cleanEmail(
              item.email
            ) === email
        );

      if (!user || user.disabled) {
        await security(
          "PASSWORD_RESET_REQUEST",
          {
            email,
            found: false,
            ip:
              requestIp(req)
          }
        );

        return res.json(
          generic
        );
      }

      if (
        !RESEND_API_KEY ||
        !RESEND_FROM
      ) {
        await security(
          "PASSWORD_RESET_NOT_CONFIGURED",
          {
            userId:
              user.id,
            email,
            ip:
              requestIp(req)
          }
        );

        return res
          .status(503)
          .json({
            ok: false,
            error:
              "RECOVERY_NOT_CONFIGURED",
            message:
              "Password recovery email is not configured yet. Please contact the administrator."
          });
      }

      const rawToken =
        randomBytes(48).toString(
          "hex"
        );

      const hash =
        resetTokenHash(
          rawToken
        );

      const resets =
        await readJSON(
          RESETS,
          {}
        );

      for (
        const id of Object.keys(
          resets
        )
      ) {
        if (
          resets[id]?.userId ===
            user.id ||
          new Date(
            resets[id]?.expiresAt ||
              0
          ).getTime() <=
            Date.now()
        ) {
          delete resets[id];
        }
      }

      const resetId =
        randomUUID();

      resets[resetId] = {
        id:
          resetId,
        userId:
          user.id,
        tokenHash:
          hash,
        createdAt:
          nowISO(),
        expiresAt:
          new Date(
            Date.now() +
              RESET_TOKEN_TTL_MS
          ).toISOString(),
        used: false
      };

      await writeJSON(
        RESETS,
        resets
      );

      await sendResetEmail(
        user.email,
        rawToken
      );

      await addUsage(
        user.id,
        "passwordReset",
        1
      );

      await security(
        "PASSWORD_RESET_REQUEST",
        {
          userId:
            user.id,
          email:
            user.email,
          ip:
            requestIp(req)
        }
      );

      res.json(
        generic
      );
    } catch (error) {
      await errorLog(
        error,
        {
          route:
            "/api/auth/forgot-password"
        }
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "PASSWORD_RESET_ERROR"
        });
    }
  }
);

app.post(
  "/api/auth/reset-password",
  async (req, res) => {
    try {
      const limit =
        rateLimit(
          authRateKey(
            req,
            "reset-password"
          ),
          10,
          15 * 60 * 1000
        );

      if (!limit.allowed) {
        return res
          .status(429)
          .json({
            ok: false,
            error:
              "RATE_LIMITED"
          });
      }

      const token =
        String(
          req.body.token ||
            ""
        ).trim();

      const password =
        String(
          req.body.password ||
            ""
        );

      const confirm =
        String(
          req.body.confirmPassword ||
            ""
        );

      if (
        token.length < 40 ||
        password.length < 6 ||
        password !== confirm
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "INVALID_RESET"
          });
      }

      const resets =
        await readJSON(
          RESETS,
          {}
        );

      const wanted =
        resetTokenHash(
          token
        );

      const entry =
        Object.values(
          resets
        ).find(
          item =>
            item &&
            item.tokenHash ===
              wanted &&
            item.used !== true &&
            new Date(
              item.expiresAt
            ).getTime() >
              Date.now()
        );

      if (!entry) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "INVALID_OR_EXPIRED_TOKEN",
            message:
              "This password reset link is invalid or has expired."
          });
      }

      const users =
        await readJSON(
          USERS,
          {}
        );

      const user =
        users[entry.userId];

      if (
        !user ||
        user.disabled
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "INVALID_RESET"
          });
      }

      const hp =
        hashPassword(
          password
        );

      user.salt =
        hp.salt;

      user.hash =
        hp.hash;

      user.lastActiveAt =
        nowISO();

      users[user.id] =
        user;

      /*
       * Invalidate all old sessions after a
       * successful password reset.
       */
      await destroyUserSessions(
        user.id
      );

      entry.used = true;
      entry.usedAt =
        nowISO();

      resets[entry.id] =
        entry;

      await writeJSON(
        USERS,
        users
      );

      await writeJSON(
        RESETS,
        resets
      );

      await security(
        "PASSWORD_RESET_SUCCESS",
        {
          userId:
            user.id,
          email:
            user.email,
          ip:
            requestIp(req)
        }
      );

      const newSession =
        await createSession(
          user.id,
          user.role ===
            "admin"
            ? "admin"
            : "user"
        );

      res.json({
        ok: true,
        token:
          newSession,
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
            "/api/auth/reset-password"
        }
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "PASSWORD_RESET_ERROR"
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
        plan:
          req.user.plan ||
          "free",
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

      if (!user) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "USER_NOT_FOUND"
          });
      }

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

      const users =
        await readJSON(
          USERS,
          {}
        );

      const user =
        users[req.user.id];

      if (
        !user ||
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

      const token =
        await createSession(
          user.id,
          user.role ===
            "admin"
            ? "admin"
            : "user"
        );

      await security(
        "PASSWORD_CHANGED",
        {
          userId:
            user.id,
          email:
            user.email
        }
      );

      res.json({
        ok: true,
        token
      });
    } catch (error) {
      await errorLog(
        error,
        {
          route:
            "/api/account/change-password"
        }
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "PASSWORD_CHANGE_ERROR"
        });
    }
  }
);

/* =========================================================
   ADMIN ANALYTICS
========================================================= */

async function buildAdminAnalytics() {
  const users =
    await readJSON(
      USERS,
      {}
    );

  const jobsData =
    await readJSON(
      JOBS,
      {}
    );

  const credits =
    await readCredits();

  const finance =
    await readFinance();

  const securityEvents =
    await readJSON(
      SECURITY,
      []
    );

  const errors =
    await readJSON(
      ERRORS,
      []
    );

  const userList =
    Object.values(users);

  const jobList =
    Object.values(jobsData);

  const now =
    Date.now();

  const activeUsers =
    userList.filter(
      user => {
        const time =
          new Date(
            user.lastActiveAt ||
              0
          ).getTime();

        return (
          Number.isFinite(time) &&
          now - time <=
            ACTIVE_WINDOW_MS
        );
      }
    ).length;

  const usersToday =
    userList.filter(
      user =>
        isWithin(
          user.createdAt,
          startOfToday()
        )
    ).length;

  const usersWeek =
    userList.filter(
      user =>
        isWithin(
          user.createdAt,
          startOfWeek()
        )
    ).length;

  const usersMonth =
    userList.filter(
      user =>
        isWithin(
          user.createdAt,
          startOfMonth()
        )
    ).length;

  const videos =
    jobList.filter(
      job =>
        job.type ===
          "video" ||
        job.type ===
          "generation" ||
        job.kind ===
          "video"
    );

  const narrations =
    jobList.filter(
      job =>
        job.type ===
        "narration"
    );

  const completed =
    jobList.filter(
      job =>
        job.status ===
        "completed"
    ).length;

  const processing =
    jobList.filter(
      job =>
        job.status ===
          "processing" ||
        job.status ===
          "queued"
    ).length;

  const failed =
    jobList.filter(
      job =>
        job.status ===
        "failed"
    ).length;

  const videosToday =
    videos.filter(
      job =>
        isWithin(
          job.createdAt,
          startOfToday()
        )
    ).length;

  let totalFree = 0;
  let totalPaid = 0;
  let totalPromotional = 0;
  let totalConsumed = 0;

  for (
    const account of Object.values(
      credits.users || {}
    )
  ) {
    totalFree +=
      Number(
        account.freeCredits ||
          0
      );

    totalPaid +=
      Number(
        account.paidCredits ||
          0
      );

    totalPromotional +=
      Number(
        account.promotionalCredits ||
          0
      );

    totalConsumed +=
      Number(
        account.consumedCredits ||
          0
      );
  }

  const allFinance =
    calculateFinance(
      finance.transactions || [],
      0
    );

  const todayFinance =
    calculateFinance(
      finance.transactions || [],
      startOfToday()
    );

  const monthFinance =
    calculateFinance(
      finance.transactions || [],
      startOfMonth()
    );

  const yearFinance =
    calculateFinance(
      finance.transactions || [],
      startOfYear()
    );

  const usage =
    await usageTotals();

  const successfulLogins =
    securityEvents.filter(
      event =>
        event.event ===
          "LOGIN_SUCCESS" ||
        event.event ===
          "ADMIN_LOGIN_SUCCESS"
    ).length;

  const failedLogins =
    securityEvents.filter(
      event =>
        event.event ===
        "LOGIN_FAILED"
    ).length;

  const passwordResets =
    securityEvents.filter(
      event =>
        event.event ===
          "PASSWORD_RESET_REQUEST" ||
        event.event ===
          "PASSWORD_RESET_SUCCESS"
    ).length;

  return {
    generatedAt:
      nowISO(),

    overview: {
      totalUsers:
        userList.length,
      activeUsers:
        activeUsers,
      activeUsersToday:
        userList.filter(
          user =>
            isWithin(
              user.lastActiveAt,
              startOfToday()
            )
        ).length,
      newUsersToday:
        usersToday,
      newUsersThisWeek:
        usersWeek,
      newUsersThisMonth:
        usersMonth,
      admins:
        userList.filter(
          user =>
            user.role ===
            "admin"
        ).length,
      suspendedUsers:
        userList.filter(
          user =>
            user.disabled
        ).length,
      totalVideos:
        videos.length,
      videosToday,
      totalNarrations:
        narrations.length,
      totalJobs:
        jobList.length,
      completedJobs:
        completed,
      processingJobs:
        processing,
      failedJobs:
        failed,
      aiGenerationRequests:
        usage.aiGenerationRequest
    },

    credits: {
      freeCredits:
        totalFree,
      paidCredits:
        totalPaid,
      promotionalCredits:
        totalPromotional,
      remainingCredits:
        totalFree +
        totalPaid +
        totalPromotional,
      consumedCredits:
        totalConsumed,
      totalIssued:
        totalFree +
        totalPaid +
        totalPromotional +
        totalConsumed
    },

    finance: {
      allTime:
        allFinance,
      today:
        todayFinance,
      month:
        monthFinance,
      year:
        yearFinance
    },

    growth: {
      registrations:
        usage,
      usersToday,
      usersThisWeek:
        usersWeek,
      usersThisMonth:
        usersMonth,
      activeUsers:
        activeUsers,
      aiGenerations:
        usage.aiGenerationRequest,
      videoGenerations:
        usage.videoGeneration,
      narrations:
        usage.narration
    },

    security: {
      successfulLogins,
      failedLogins,
      passwordResets,
      securityEvents:
        securityEvents.slice(
          0,
          50
        ),
      errors:
        errors.slice(
          0,
          50
        )
    },

    provider: {
      replicateConfigured:
        Boolean(
          REPLICATE_API_TOKEN
        ),
      tokenConfigured:
        Boolean(
          REPLICATE_API_TOKEN
        ),
      t2vModel:
        T2V_MODEL,
      i2vModel:
        I2V_MODEL,
      creditBalanceKnown:
        false,
      creditBalanceMessage:
        "Replicate provider balance is not exposed by MAMAKI unless a verified provider billing API is connected."
    },

    system: {
      server:
        "online",
      database:
        "json-storage-online",
      authentication:
        "online",
      ffmpeg:
        Boolean(ffmpegPath)
          ? "available"
          : "unavailable",
      storage:
        "available",
      sessions:
        "online",
      ai:
        replicate
          ? "configured"
          : "not-configured"
    }
  };
}

app.get(
  "/api/admin/dashboard",
  requireAdmin,
  async (req, res) => {
    try {
      const analytics =
        await buildAdminAnalytics();

      res.json({
        ok: true,
        version: VERSION,
        admin: {
          id:
            req.user.id,
          name:
            req.user.name,
          email:
            req.user.email
        },
        analytics
      });
    } catch (error) {
      await errorLog(
        error,
        {
          route:
            "/api/admin/dashboard"
        }
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "ADMIN_DASHBOARD_ERROR"
        });
    }
  }
);

app.get(
  "/api/admin/analytics",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      analytics:
        await buildAdminAnalytics()
    });
  }
);

app.get(
  "/api/admin/users",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJSON(
        USERS,
        {}
      );

    const credits =
      await readCredits();

    const list =
      Object.values(
        users
      ).map(
        user => {
          const account =
            credits.users[
              user.id
            ];

          return {
            id:
              user.id,
            name:
              user.name,
            email:
              user.email,
            role:
              user.role,
            plan:
              user.plan ||
              "free",
            disabled:
              Boolean(
                user.disabled
              ),
            verified:
              Boolean(
                user.verified
              ),
            createdAt:
              user.createdAt,
            lastLoginAt:
              user.lastLoginAt,
            lastActiveAt:
              user.lastActiveAt,
            credits:
              account
                ? availableCredits(
                    account
                  )
                : 0
          };
        }
      );

    res.json({
      ok: true,
      users: list
    });
  }
);

/* =========================================================
   ADMIN USER CONTROLS
========================================================= */

app.post(
  "/api/admin/users/:id/status",
  requireAdmin,
  async (req, res) => {
    try {
      const users =
        await readJSON(
          USERS,
          {}
        );

      const user =
        users[
          req.params.id
        ];

      if (!user) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "USER_NOT_FOUND"
          });
      }

      if (
        user.role ===
        "admin" &&
        user.id ===
          req.user.id
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "PROTECTED_ADMIN"
          });
      }

      user.disabled =
        Boolean(
          req.body.disabled
        );

      users[user.id] =
        user;

      await writeJSON(
        USERS,
        users
      );

      if (user.disabled) {
        await destroyUserSessions(
          user.id
        );
      }

      await security(
        "ADMIN_USER_STATUS_CHANGE",
        {
          adminId:
            req.user.id,
          userId:
            user.id,
          disabled:
            user.disabled
        }
      );

      res.json({
        ok: true,
        disabled:
          user.disabled
      });
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
            "USER_STATUS_ERROR"
        });
    }
  }
);

app.post(
  "/api/admin/users/:id/role",
  requireAdmin,
  async (req, res) => {
    try {
      const users =
        await readJSON(
          USERS,
          {}
        );

      const user =
        users[
          req.params.id
        ];

      if (!user) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "USER_NOT_FOUND"
          });
      }

      if (
        user.id ===
        req.user.id
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "PROTECTED_ADMIN"
          });
      }

      const role =
        String(
          req.body.role || ""
        );

      if (
        ![
          "user",
          "admin"
        ].includes(role)
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "INVALID_ROLE"
          });
      }

      user.role =
        role;

      users[user.id] =
        user;

      await writeJSON(
        USERS,
        users
      );

      await security(
        "ADMIN_ROLE_CHANGE",
        {
          adminId:
            req.user.id,
          userId:
            user.id,
          role
        }
      );

      res.json({
        ok: true,
        role
      });
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
            "ROLE_CHANGE_ERROR"
        });
    }
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

    res.json({
      ok: true,
      credits: data
    });
  }
);

app.post(
  "/api/admin/users/:id/credits",
  requireAdmin,
  async (req, res) => {
    try {
      const users =
        await readJSON(
          USERS,
          {}
        );

      if (
        !users[
          req.params.id
        ]
      ) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "USER_NOT_FOUND"
          });
      }

      const account =
        await changeCredits({
          userId:
            req.params.id,
          amount:
            Number(
              req.body.amount
            ),
          bucket:
            String(
              req.body.bucket ||
                "promotional"
            ),
          reason:
            req.body.reason ||
            "Admin credit adjustment",
          adminId:
            req.user.id,
          type:
            "admin_credit_adjustment"
        });

      await security(
        "ADMIN_CREDIT_ADJUSTMENT",
        {
          adminId:
            req.user.id,
          userId:
            req.params.id,
          amount:
            Number(
              req.body.amount
            ),
          bucket:
            req.body.bucket
        }
      );

      res.json({
        ok: true,
        credits: {
          freeCredits:
            account.freeCredits,
          paidCredits:
            account.paidCredits,
          promotionalCredits:
            account.promotionalCredits,
          consumedCredits:
            account.consumedCredits,
          total:
            availableCredits(
              account
            )
        }
      });
    } catch (error) {
      await errorLog(
        error,
        {
          route:
            req.path
        }
      );

      res
        .status(400)
        .json({
          ok: false,
          error:
            error.message
        });
    }
  }
);

/* =========================================================
   ADMIN FINANCE
========================================================= */

app.get(
  "/api/admin/finance",
  requireAdmin,
  async (req, res) => {
    const data =
      await readFinance();

    res.json({
      ok: true,
      finance: {
        transactions:
          data.transactions,
        today:
          calculateFinance(
            data.transactions,
            startOfToday()
          ),
        month:
          calculateFinance(
            data.transactions,
            startOfMonth()
          ),
        year:
          calculateFinance(
            data.transactions,
            startOfYear()
          ),
        allTime:
          calculateFinance(
            data.transactions,
            0
          )
      }
    });
  }
);

app.post(
  "/api/admin/finance",
  requireAdmin,
  async (req, res) => {
    try {
      const item =
        await addFinanceTransaction({
          type:
            req.body.type,
          amount:
            req.body.amount,
          category:
            req.body.category,
          description:
            req.body.description,
          userId:
            req.body.userId ||
            null,
          adminId:
            req.user.id,
          currency:
            req.body.currency ||
            "NGN"
        });

      await security(
        "ADMIN_FINANCE_ENTRY",
        {
          adminId:
            req.user.id,
          type:
            item.type,
          amount:
            item.amount,
          category:
            item.category
        }
      );

      res.json({
        ok: true,
        transaction:
          item
      });
    } catch (error) {
      await errorLog(
        error,
        {
          route:
            req.path
        }
      );

      res
        .status(400)
        .json({
          ok: false,
          error:
            error.message
        });
    }
  }
);

/* =========================================================
   ADMIN SECURITY / ERRORS
========================================================= */

app.get(
  "/api/admin/security",
  requireAdmin,
  async (req, res) => {
    const events =
      await readJSON(
        SECURITY,
        []
      );

    res.json({
      ok: true,
      events:
        events.slice(
          0,
          250
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
        ERRORS,
        []
      );

    res.json({
      ok: true,
      errors:
        errors.slice(
          0,
          250
        )
    });
  }
);

/* =========================================================
   GENERATION HELPERS
========================================================= */

function enhancePrompt(
  prompt,
  style
) {
  const clean =
    String(
      prompt || ""
    ).trim();

  return [
    clean,
    `Visual style: ${style || "Cinematic"}.`,
    "High quality coherent motion.",
    "Maintain subject identity and scene continuity.",
    "No subtitles, no captions, no logos, no watermarks."
  ].join(" ");
}

function dimensionsForRatio(
  ratio
) {
  if (ratio === "9:16") {
    return {
      width: 1080,
      height: 1920
    };
  }

  if (ratio === "1:1") {
    return {
      width: 1080,
      height: 1080
    };
  }

  return {
    width: 1920,
    height: 1080
  };
}

async function runReplicateGeneration({
  prompt,
  imageUrl,
  duration,
  ratio
}) {
  if (!replicate) {
    const error =
      new Error(
        "AI generation is currently unavailable because the connected Replicate account is not configured."
      );

    error.code =
      "REPLICATE_NOT_CONFIGURED";

    throw error;
  }

  const seconds =
    normalizeDuration(
      duration
    );

  const dimensions =
    dimensionsForRatio(
      ratio
    );

  const frames =
    seconds <= 5
      ? 81
      : 121;

  const input = {
    prompt:
      enhancePrompt(
        prompt,
        "Cinematic"
      ),
    num_frames:
      frames,
    width:
      dimensions.width,
    height:
      dimensions.height
  };

  if (imageUrl) {
    input.image =
      imageUrl;
  }

  const model =
    imageUrl
      ? I2V_MODEL
      : T2V_MODEL;

  return replicate.run(
    model,
    {
      input
    }
  );
}

async function outputToUrl(
  output,
  fileName
) {
  let url = "";

  if (
    typeof output ===
    "string"
  ) {
    url = output;
  } else if (
    output &&
    typeof output.url ===
      "function"
  ) {
    url = String(
      output.url()
    );
  } else if (
    output &&
    output.url
  ) {
    url =
      String(output.url);
  } else if (
    Array.isArray(output) &&
    output.length
  ) {
    return outputToUrl(
      output[0],
      fileName
    );
  }

  if (!url) {
    throw new Error(
      "Replicate completed but did not return a usable video URL."
    );
  }

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Unable to download generated video: ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  const destination =
    path.join(
      OUTPUTS,
      fileName
    );

  await fs.writeFile(
    destination,
    buffer
  );

  return publicUrl(
    fileName
  );
}

/* =========================================================
   AI VIDEO API
========================================================= */

app.post(
  "/api/generate",
  requireUser,
  async (req, res) => {
    const started =
      Date.now();

    let reservation =
      null;

    const duration =
      normalizeDuration(
        req.body.duration
      );

    const cost =
      creditCostForDuration(
        duration
      );

    try {
      if (!replicate) {
        return res
          .status(503)
          .json({
            ok: false,
            error:
              "REPLICATE_NOT_CONFIGURED",
            message:
              "AI generation is currently unavailable because the connected Replicate account is not configured."
          });
      }

      const prompt =
        String(
          req.body.prompt ||
            ""
        ).trim();

      if (!prompt) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "PROMPT_REQUIRED"
          });
      }

      reservation =
        await reserveCredits(
          req.user.id,
          cost,
          "AI video generation"
        );

      const jobId =
        randomUUID();

      const job = {
        id:
          jobId,
        userId:
          req.user.id,
        type:
          "video",
        kind:
          "generation",
        status:
          "processing",
        prompt:
          prompt.slice(
            0,
            1000
          ),
        duration,
        creditCost:
          cost,
        createdAt:
          nowISO(),
        startedAt:
          nowISO()
      };

      const jobsData =
        await readJSON(
          JOBS,
          {}
        );

      jobsData[jobId] =
        job;

      await writeJSON(
        JOBS,
        jobsData
      );

      await addUsage(
        req.user.id,
        "aiGenerationRequest",
        1
      );

      await addUsage(
        req.user.id,
        "videoGeneration",
        1
      );

      const output =
        await runReplicateGeneration({
          prompt,
          imageUrl:
            req.body.imageUrl ||
            "",
          duration,
          ratio:
            req.body.ratio ||
            "16:9"
        });

      const fileName =
        `${jobId}-${safeFileName(
          prompt.slice(
            0,
            60
          )
        )}.mp4`;

      const url =
        await outputToUrl(
          output,
          fileName
        );

      job.status =
        "completed";

      job.completedAt =
        nowISO();

      job.durationMs =
        Date.now() -
        started;

      job.url =
        url;

      jobsData[jobId] =
        job;

      await writeJSON(
        JOBS,
        jobsData
      );

      res.json({
        ok: true,
        jobId,
        status:
          "completed",
        url,
        duration,
        creditsUsed:
          cost,
        credits:
          await getCreditBalance(
            req.user.id
          )
      });
    } catch (error) {
      if (reservation) {
        await refundCredits(
          req.user.id,
          reservation,
          "AI generation failed"
        );
      }

      await errorLog(
        error,
        {
          route:
            "/api/generate",
          userId:
            req.user.id,
          code:
            error.code ||
            ""
        }
      );

      if (
        error.code ===
        "INSUFFICIENT_CREDITS"
      ) {
        return res
          .status(402)
          .json({
            ok: false,
            error:
              "INSUFFICIENT_CREDITS",
            message:
              "You do not have enough MAMAKI credits for this generation.",
            requiredCredits:
              cost,
            credits:
              await getCreditBalance(
                req.user.id
              )
          });
      }

      res
        .status(500)
        .json({
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

app.post(
  "/api/video/generate",
  requireUser,
  async (req, res) => {
    req.url =
      "/api/generate";

    return app._router
      ? res.status(307).json({
          ok: false,
          error:
            "USE_API_GENERATE"
        })
      : res
          .status(500)
          .json({
            ok: false
          });
  }
);

/* =========================================================
   JOBS
========================================================= */

app.get(
  "/api/jobs",
  requireUser,
  async (req, res) => {
    const data =
      await readJSON(
        JOBS,
        {}
      );

    const list =
      Object.values(
        data
      )
        .filter(
          job =>
            job.userId ===
            req.user.id
        )
        .sort(
          (a, b) =>
            new Date(
              b.createdAt
            ).getTime() -
            new Date(
              a.createdAt
            ).getTime()
        );

    res.json({
      ok: true,
      jobs: list
    });
  }
);

app.get(
  "/api/jobs/:id",
  requireUser,
  async (req, res) => {
    const data =
      await readJSON(
        JOBS,
        {}
      );

    const job =
      data[
        req.params.id
      ];

    if (
      !job ||
      job.userId !==
        req.user.id
    ) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "JOB_NOT_FOUND"
        });
    }

    res.json({
      ok: true,
      job
    });
  }
);

/* =========================================================
   FREE STUDIO
========================================================= */

function runFFmpeg(
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
              "pipe"
            ]
          }
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
                stderr ||
                  `FFmpeg exited with code ${code}`
              )
            );
          }
        }
      );
    }
  );
}

app.post(
  "/api/studio/trimmer",
  requireUser,
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "VIDEO_REQUIRED"
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
          1,
          Number(
            req.body.duration ||
              5
          )
        );

      const name =
        `${randomUUID()}-trim.mp4`;

      const output =
        path.join(
          OUTPUTS,
          name
        );

      await runFFmpeg([
        "-y",
        "-ss",
        String(start),
        "-i",
        req.file.path,
        "-t",
        String(duration),
        "-c",
        "copy",
        output
      ]);

      await fs.unlink(
        req.file.path
      ).catch(
        () => {}
      );

      res.json({
        ok: true,
        url:
          publicUrl(name)
      });
    } catch (error) {
      if (req.file?.path) {
        await fs.unlink(
          req.file.path
        ).catch(
          () => {}
        );
      }

      await errorLog(
        error,
        {
          route:
            "/api/studio/trimmer",
          userId:
            req.user.id
        }
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "TRIM_FAILED",
          message:
            error.message
        });
    }
  }
);

app.post(
  "/api/studio/narration",
  requireUser,
  async (req, res) => {
    try {
      const text =
        String(
          req.body.text ||
            ""
        ).trim();

      if (!text) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "TEXT_REQUIRED"
          });
      }

      const voice =
        String(
          req.body.voice ||
            "en-US-AriaNeural"
        );

      const tts =
        new EdgeTTS();

      const result =
        await tts.synthesize(
          text,
          voice
        );

      const name =
        `${randomUUID()}-narration.mp3`;

      const destination =
        path.join(
          OUTPUTS,
          name
        );

      if (
        result?.audio
      ) {
        await fs.writeFile(
          destination,
          Buffer.from(
            result.audio
          )
        );
      } else if (
        result?.audioData
      ) {
        await fs.writeFile(
          destination,
          Buffer.from(
            result.audioData
          )
        );
      } else {
        throw new Error(
          "Narration provider returned no audio."
        );
      }

      await addUsage(
        req.user.id,
        "narration",
        1
      );

      const data =
        await readJSON(
          JOBS,
          {}
        );

      const id =
        randomUUID();

      data[id] = {
        id,
        userId:
          req.user.id,
        type:
          "narration",
        status:
          "completed",
        createdAt:
          nowISO(),
        url:
          publicUrl(name)
      };

      await writeJSON(
        JOBS,
        data
      );

      res.json({
        ok: true,
        url:
          publicUrl(name)
      });
    } catch (error) {
      await errorLog(
        error,
        {
          route:
            "/api/studio/narration",
          userId:
            req.user.id
        }
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "NARRATION_FAILED",
          message:
            error.message
        });
    }
  }
);

/* =========================================================
   PASSWORD RESET PAGE
========================================================= */

app.get(
  "/reset-password",
  async (req, res) => {
    const token =
      String(
        req.query.token || ""
      );

    const html =
      [
        "<!doctype html>",
        "<html>",
        "<head>",
        "<meta charset=\"utf-8\">",
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
        "<title>MAMAKI AI - Reset Password</title>",
        "<style>",
        "body{margin:0;background:#0b0b0f;color:#fff;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}",
        ".card{width:100%;max-width:430px;background:#15151c;border:1px solid #292934;border-radius:18px;padding:28px;box-sizing:border-box;box-shadow:0 20px 60px rgba(0,0,0,.4)}",
        "h1{margin:0 0 8px;font-size:26px}",
        "p{color:#aaa;line-height:1.5}",
        "input{width:100%;box-sizing:border-box;background:#0d0d12;color:#fff;border:1px solid #333;border-radius:10px;padding:13px;margin:7px 0 12px}",
        "button{width:100%;border:0;border-radius:10px;padding:14px;background:#fff;color:#000;font-weight:700;cursor:pointer}",
        "#message{margin-top:16px;padding:10px;border-radius:8px}",
        "</style>",
        "</head>",
        "<body>",
        "<div class=\"card\">",
        "<h1>Reset your password</h1>",
        "<p>Create a new secure password for your MAMAKI AI account.</p>",
        "<form id=\"form\">",
        "<label>New password</label>",
        "<input id=\"password\" type=\"password\" minlength=\"6\" required>",
        "<label>Confirm password</label>",
        "<input id=\"confirm\" type=\"password\" minlength=\"6\" required>",
        "<button type=\"submit\">Reset Password</button>",
        "</form>",
        "<div id=\"message\"></div>",
        "</div>",
        "<script>",
        "const token=",
        JSON.stringify(token),
        ";",
        "const form=document.getElementById('form');",
        "const message=document.getElementById('message');",
        "form.addEventListener('submit',async function(event){",
        "event.preventDefault();",
        "message.textContent='Updating password...';",
        "try{",
        "const response=await fetch('/api/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,password:document.getElementById('password').value,confirmPassword:document.getElementById('confirm').value})});",
        "const data=await response.json();",
        "if(!response.ok||!data.ok){throw new Error(data.message||data.error||'Password reset failed.');}",
        "message.textContent='Password reset successfully. You can now return to MAMAKI AI and log in.';",
        "form.style.display='none';",
        "}catch(error){message.textContent=error.message;}",
        "});",
        "</script>",
        "</body>",
        "</html>"
      ].join("");

    res
      .type("html")
      .send(html);
  }
);

/* =========================================================
   PROFESSIONAL ADMIN DASHBOARD
========================================================= */

app.get(
  "/admin",
  requireAdmin,
  async (req, res) => {
    const html = [
      "<!doctype html>",
      "<html>",
      "<head>",
      "<meta charset=\"utf-8\">",
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
      "<title>MAMAKI AI Admin</title>",
      "<style>",
      ":root{--bg:#08090d;--panel:#11131a;--panel2:#171923;--line:#262a36;--text:#f5f7fb;--muted:#9299a8;--good:#46d88a;--warn:#f3bd4b;--bad:#ff6262;--accent:#fff}",
      "*{box-sizing:border-box}",
      "body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,Arial,sans-serif}",
      "header{position:sticky;top:0;z-index:10;background:rgba(8,9,13,.94);backdrop-filter:blur(14px);border-bottom:1px solid var(--line);padding:16px 24px;display:flex;justify-content:space-between;align-items:center}",
      ".brand{font-size:19px;font-weight:800}.sub{color:var(--muted);font-size:12px;margin-top:3px}",
      "button{border:1px solid var(--line);background:var(--panel2);color:var(--text);padding:10px 14px;border-radius:9px;cursor:pointer}",
      "button:hover{border-color:#555b6c}.danger{color:#ff8b8b}",
      "main{padding:24px;max-width:1600px;margin:auto}",
      ".grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:20px}",
      ".card{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:18px}",
      ".label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}",
      ".value{font-size:27px;font-weight:800;margin-top:8px}",
      ".small{font-size:12px;color:var(--muted);margin-top:6px}",
      ".section{margin-top:25px}.section h2{font-size:17px;margin:0 0 12px}",
      ".twocol{display:grid;grid-template-columns:1fr 1fr;gap:14px}",
      ".tablewrap{overflow:auto;border:1px solid var(--line);border-radius:12px}",
      "table{width:100%;border-collapse:collapse;min-width:760px}",
      "th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line);font-size:12px}",
      "th{color:var(--muted);font-weight:600;background:#0e1016}",
      ".pill{display:inline-block;border-radius:99px;padding:4px 8px;font-size:10px;font-weight:700}",
      ".online{background:rgba(70,216,138,.12);color:var(--good)}",
      ".offline{background:rgba(255,98,98,.12);color:var(--bad)}",
      ".warning{background:rgba(243,189,75,.12);color:var(--warn)}",
      ".toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}",
      ".log{font-family:monospace;font-size:11px;white-space:pre-wrap;color:#c9ced8;max-height:300px;overflow:auto}",
      ".statusline{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}",
      ".money{font-variant-numeric:tabular-nums}",
      "@media(max-width:1000px){.grid{grid-template-columns:repeat(2,1fr)}.twocol{grid-template-columns:1fr}}",
      "@media(max-width:600px){main{padding:14px}.grid{grid-template-columns:1fr 1fr}.value{font-size:20px}header{padding:14px}}",
      "</style>",
      "</head>",
      "<body>",
      "<header>",
      "<div><div class=\"brand\">✨ MAMAKI AI Admin</div><div class=\"sub\">Administrator Control Center · Protected</div></div>",
      "<div><span id=\"updated\" class=\"sub\">Loading...</span> <button onclick=\"logout()\">Logout</button></div>",
      "</header>",
      "<main>",
      "<div class=\"toolbar\">",
      "<button onclick=\"loadAll()\">Refresh Dashboard</button>",
      "<button onclick=\"loadUsers()\">Users</button>",
      "<button onclick=\"loadSecurity()\">Security</button>",
      "<button onclick=\"loadErrors()\">Errors</button>",
      "</div>",
      "<div id=\"overview\" class=\"grid\"></div>",
      "<div class=\"section\"><h2>Credits</h2><div id=\"credits\" class=\"grid\"></div></div>",
      "<div class=\"section\"><h2>Revenue, Cost & Profit</h2><div id=\"finance\" class=\"grid\"></div></div>",
      "<div class=\"section twocol\">",
      "<div class=\"card\"><h2>AI Provider</h2><div id=\"provider\"></div></div>",
      "<div class=\"card\"><h2>System Health</h2><div id=\"system\"></div></div>",
      "</div>",
      "<div class=\"section\"><h2>User Management</h2><div class=\"card\"><div id=\"users\"></div></div></div>",
      "<div class=\"section twocol\">",
      "<div class=\"card\"><h2>Security Activity</h2><div id=\"security\" class=\"log\"></div></div>",
      "<div class=\"card\"><h2>Application Errors</h2><div id=\"errors\" class=\"log\"></div></div>",
      "</div>",
      "</main>",
      "<script>",
      "const token=localStorage.getItem('mamaki_token')||sessionStorage.getItem('mamaki_token')||'';",
      "if(!token){location.href='/';}",
      "async function api(url,options={}){",
      "options.headers=Object.assign({'Content-Type':'application/json','Authorization':'Bearer '+token},options.headers||{});",
      "const response=await fetch(url,options);",
      "const data=await response.json().catch(()=>({}));",
      "if(response.status===401||response.status===403){location.href='/';throw new Error('Admin session expired.');}",
      "if(!response.ok||data.ok===false)throw new Error(data.message||data.error||'Request failed');",
      "return data;",
      "}",
      "function money(value){return '₦'+Number(value||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});}",
      "function card(label,value,sub){return '<div class=\"card\"><div class=\"label\">'+label+'</div><div class=\"value\">'+value+'</div><div class=\"small\">'+(sub||'')+'</div></div>';}",
      "async function loadAll(){",
      "try{",
      "const data=await api('/api/admin/dashboard');",
      "const a=data.analytics;",
      "document.getElementById('updated').textContent='Updated '+new Date(a.generatedAt).toLocaleString();",
      "const o=a.overview;",
      "document.getElementById('overview').innerHTML=[",
      "card('Total Users',o.totalUsers,'Registered accounts'),",
      "card('Active Users',o.activeUsers,'Active within 15 minutes'),",
      "card('New Today',o.newUsersToday,'Registrations today'),",
      "card('This Week',o.newUsersThisWeek,'New registrations'),",
      "card('This Month',o.newUsersThisMonth,'New registrations'),",
      "card('Admins',o.admins,'Protected administrators'),",
      "card('Videos',o.totalVideos,'Total video jobs'),",
      "card('Videos Today',o.videosToday,'Generated today'),",
      "card('Narrations',o.totalNarrations,'Narration jobs'),",
      "card('Completed',o.completedJobs,'Completed jobs'),",
      "card('Processing',o.processingJobs,'Queued or processing'),",
      "card('Failed',o.failedJobs,'Failed jobs'),",
      "card('AI Requests',o.aiGenerationRequests,'Generation requests'),",
      "card('Suspended',o.suspendedUsers,'Disabled accounts')",
      "].join('');",
      "const c=a.credits;",
      "document.getElementById('credits').innerHTML=[",
      "card('Remaining',c.remainingCredits.toLocaleString(),'Available MAMAKI credits'),",
      "card('Consumed',c.consumedCredits.toLocaleString(),'Credits used'),",
      "card('Free',c.freeCredits.toLocaleString(),'Free credits'),",
      "card('Paid',c.paidCredits.toLocaleString(),'Purchased credits'),",
      "card('Promotional',c.promotionalCredits.toLocaleString(),'Promotional credits'),",
      "card('Issued',c.totalIssued.toLocaleString(),'Issued + consumed')",
      "].join('');",
      "const f=a.finance;",
      "document.getElementById('finance').innerHTML=[",
      "card('Gross Revenue',money(f.allTime.revenue),'All time'),",
      "card('Refunds',money(f.allTime.refunds),'All time'),",
      "card('Net Revenue',money(f.allTime.netRevenue),'Revenue after refunds'),",
      "card('AI Costs',money(f.allTime.aiCosts),'Recorded AI/provider costs'),",
      "card('Infrastructure',money(f.allTime.infrastructureCosts),'Recorded infrastructure costs'),",
      "card('Total Costs',money(f.allTime.costs),'All recorded costs'),",
      "card('Profit',money(f.allTime.profit),'Net revenue minus costs'),",
      "card('Margin',Number(f.allTime.profitMargin||0).toFixed(2)+'%','Profit margin')",
      "].join('');",
      "const p=a.provider;",
      "document.getElementById('provider').innerHTML=",
      "'<div class=\"statusline\"><span>Replicate</span><span class=\"pill '+(p.replicateConfigured?'online':'offline')+'\">'+(p.replicateConfigured?'CONFIGURED':'NOT CONFIGURED')+'</span></div>'+",
      "'<div class=\"statusline\"><span>Token</span><span class=\"pill '+(p.tokenConfigured?'online':'offline')+'\">'+(p.tokenConfigured?'PRESENT':'MISSING')+'</span></div>'+",
      "'<div class=\"statusline\"><span>T2V</span><span>'+p.t2vModel+'</span></div>'+",
      "'<div class=\"statusline\"><span>I2V</span><span>'+p.i2vModel+'</span></div>'+",
      "'<p class=\"small\">'+p.creditBalanceMessage+'</p>';",
      "const s=a.system;",
      "document.getElementById('system').innerHTML=Object.entries(s).map(function(entry){return '<div class=\"statusline\"><span>'+entry[0]+'</span><span class=\"pill '+(entry[1]==='online'||entry[1]==='available'||entry[1]==='configured'?'online':'warning')+'\">'+entry[1]+'</span></div>';}).join('');",
      "await loadUsers();",
      "await loadSecurity();",
      "await loadErrors();",
      "}catch(error){alert(error.message);}",
      "}",
      "async function loadUsers(){",
      "try{",
      "const data=await api('/api/admin/users');",
      "document.getElementById('users').innerHTML='<div class=\"tablewrap\"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Plan</th><th>Status</th><th>Credits</th><th>Last Active</th><th>Action</th></tr></thead><tbody>'+data.users.map(function(u){return '<tr><td>'+escapeHtml(u.name)+'</td><td>'+escapeHtml(u.email)+'</td><td>'+u.role+'</td><td>'+u.plan+'</td><td>'+(u.disabled?'<span class=\"pill offline\">DISABLED</span>':'<span class=\"pill online\">ACTIVE</span>')+'</td><td>'+Number(u.credits||0).toLocaleString()+'</td><td>'+(u.lastActiveAt?new Date(u.lastActiveAt).toLocaleString():'Never')+'</td><td>'+(u.role==='admin'&&u.id===data.users.find(function(x){return x.email===u.email})?.id?'Protected':'<button onclick=\"toggleUser(\\''+u.id+'\\','+(!u.disabled)+')\">'+(u.disabled?'Enable':'Disable')+'</button>')+'</td></tr>';}).join('')+'</tbody></table></div>';",
      "}catch(error){document.getElementById('users').textContent=error.message;}",
      "}",
      "async function toggleUser(id,disabled){",
      "if(!confirm(disabled?'Disable this account?':'Enable this account?'))return;",
      "await api('/api/admin/users/'+encodeURIComponent(id)+'/status',{method:'POST',body:JSON.stringify({disabled:disabled})});",
      "await loadAll();",
      "}",
      "async function loadSecurity(){",
      "try{const data=await api('/api/admin/security');document.getElementById('security').textContent=data.events.map(function(e){return '['+e.createdAt+'] '+e.event+' '+JSON.stringify(e.meta);}).join('\\n\\n')||'No security events.';}catch(error){document.getElementById('security').textContent=error.message;}",
      "}",
      "async function loadErrors(){",
      "try{const data=await api('/api/admin/errors');document.getElementById('errors').textContent=data.errors.map(function(e){return '['+e.createdAt+'] '+e.message+' '+JSON.stringify(e.meta);}).join('\\n\\n')||'No errors recorded.';}catch(error){document.getElementById('errors').textContent=error.message;}",
      "}",
      "function escapeHtml(value){return String(value||'').replace(/[&<>'\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;',\"'\":'&#39;','\"':'&quot;'}[c];});}",
      "async function logout(){await api('/api/auth/logout',{method:'POST'}).catch(function(){});localStorage.removeItem('mamaki_token');sessionStorage.removeItem('mamaki_token');location.href='/';}",
      "loadAll();",
      "setInterval(loadAll,60000);",
      "</script>",
      "</body>",
      "</html>"
    ].join("");

    res
      .type("html")
      .send(html);
  }
);

/* =========================================================
   HEALTH / VERSION
========================================================= */

app.get(
  "/api/health",
  async (req, res) => {
    res.json({
      ok: true,
      service:
        "MAMAKI AI",
      version:
        VERSION,
      status:
        "online",
      replicate:
        Boolean(replicate),
      ffmpeg:
        Boolean(ffmpegPath),
      time:
        nowISO()
    });
  }
);

app.get(
  "/api/version",
  async (req, res) => {
    res.json({
      ok: true,
      version:
        VERSION,
      service:
        "MAMAKI AI"
    });
  }
);

/* =========================================================
   FALLBACKS
========================================================= */

app.use(
  async (
    error,
    req,
    res,
    next
  ) => {
    await errorLog(
      error,
      {
        route:
          req.path,
        method:
          req.method
      }
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res
      .status(500)
      .json({
        ok: false,
        error:
          "SERVER_ERROR",
        message:
          error.message
      });
  }
);

app.use(
  (req, res) => {
    if (
      req.path.startsWith(
        "/api/"
      )
    ) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "NOT_FOUND"
        });
    }

    res
      .status(404)
      .send(
        "MAMAKI AI"
      );
  }
);

/* =========================================================
   STARTUP
========================================================= */

async function start() {
  try {
    await ensureStorage();

    app.listen(
      PORT,
      HOST,
      () => {
        console.log(
          `MAMAKI AI v${VERSION} running on ${HOST}:${PORT}`
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
          `Password recovery email configured: ${Boolean(
            RESEND_API_KEY &&
              RESEND_FROM
          )}`
        );
      }
    );
  } catch (error) {
    console.error(
      "MAMAKI startup failed:",
      error
    );

    process.exit(1);
  }
}

start();
