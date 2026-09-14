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
} from "node:crypto";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
const VERSION = "17.1.0";

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

const T2V_MODEL =
  process.env.T2V_MODEL || "wan-video/wan-2.2-t2v-fast";

const I2V_MODEL =
  process.env.I2V_MODEL || "wan-video/wan-2.2-i2v-fast";

const MIN_DURATION = 5;
const MAX_DURATION = 7200;

const ADMIN_EMAIL =
  String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();

const ADMIN_PASSWORD =
  String(process.env.ADMIN_PASSWORD || "");

const SESSION_SECRET =
  String(process.env.SESSION_SECRET || "");

const REPLICATE_API_TOKEN =
  String(process.env.REPLICATE_API_TOKEN || "").trim();

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
  ? new Replicate({ auth: REPLICATE_API_TOKEN })
  : null;

const jobs = new Map();

const adminLoginRate = new Map();
const forgotIpRate = new Map();
const resetIpRate = new Map();
const resetRate = new Map();

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

  const defaults = {
    [USERS_FILE]: {},
    [SESSIONS_FILE]: {},
    [ERRORS_FILE]: {},
    [USAGE_FILE]: {},
    [RESET_FILE]: {},
    [SECURITY_FILE]: {},
    [CREDITS_FILE]: {
      users: {},
      transactions: [],
    },
    [FINANCE_FILE]: {
      transactions: [],
    },
  };

  for (const [file, fallback] of Object.entries(defaults)) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(
        file,
        JSON.stringify(fallback, null, 2),
        "utf8"
      );
    }
  }

  await repairStorage();
}

async function readJson(file, fallback = {}) {
  try {
    const raw = await fs.readFile(file, "utf8");

    if (!raw.trim()) {
      return fallback;
    }

    const parsed = JSON.parse(raw);

    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  const temp =
    file + "." + randomUUID() + ".tmp";

  await fs.writeFile(
    temp,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  await fs.rename(temp, file);
}

async function repairStorage() {
  const credits = await readJson(CREDITS_FILE, {
    users: {},
    transactions: [],
  });

  if (
    !credits ||
    typeof credits !== "object" ||
    Array.isArray(credits)
  ) {
    await writeJson(CREDITS_FILE, {
      users: {},
      transactions: [],
    });
  } else {
    if (
      !credits.users ||
      typeof credits.users !== "object" ||
      Array.isArray(credits.users)
    ) {
      credits.users = {};
    }

    if (!Array.isArray(credits.transactions)) {
      credits.transactions = [];
    }

    await writeJson(CREDITS_FILE, credits);
  }

  const finance = await readJson(FINANCE_FILE, {
    transactions: [],
  });

  if (
    !finance ||
    typeof finance !== "object" ||
    Array.isArray(finance)
  ) {
    await writeJson(FINANCE_FILE, {
      transactions: [],
    });
  } else {
    if (!Array.isArray(finance.transactions)) {
      finance.transactions = [];
    }

    await writeJson(FINANCE_FILE, finance);
  }
}

/* =========================================================
   HELPERS
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
      .match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/i);

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
  const ratio = String(value || "16:9");

  return [
    "16:9",
    "9:16",
    "1:1",
  ].includes(ratio)
    ? ratio
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

function safeFileName(
  name,
  fallback = "file"
) {
  return path
    .basename(String(name || fallback))
    .replace(/[^a-zA-Z0-9._-]/g, "")
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
    randomBytes(32).toString("hex");

  const secretPart = SESSION_SECRET
    ? scryptSync(
        SESSION_SECRET,
        random.slice(0, 16),
        32
      ).toString("hex")
    : "";

  return random + "." + secretPart;
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

  return header
    .slice(7)
    .trim();
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
  const token =
    getBearerToken(req);

  if (!token) {
    return null;
  }

  const sessions = await readJson(
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

  const users = await readJson(
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

  const activeAt =
    Date.parse(
      String(
        user.lastActiveAt || ""
      )
    );

  if (
    !Number.isFinite(activeAt) ||
    Date.now() - activeAt >
      60 * 1000
  ) {
    user.lastActiveAt =
      new Date().toISOString();

    users[user.id] =
      user;

    await writeJson(
      USERS_FILE,
      users
    );
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
  try {
    const user =
      await getCurrentUser(req);

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
  } catch (error) {
    await recordError(
      error,
      {
        route: req.originalUrl,
      }
    );

    res.status(500).json({
      ok: false,
      error: "AUTH_ERROR",
      message:
        "Unable to verify your account.",
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
      await getCurrentUser(req);

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
  } catch (error) {
    await recordError(
      error,
      {
        route: req.originalUrl,
      }
    );

    res.status(500).json({
      ok: false,
      error: "ADMIN_AUTH_ERROR",
      message:
        "Unable to verify administrator access.",
    });
  }
}

/* =========================================================
   LOGGING
========================================================= */

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

    const ids =
      Object.keys(errors);

    if (ids.length > 500) {
      ids.sort(
        (a, b) =>
          String(
            errors[a].createdAt ||
              ""
          ).localeCompare(
            String(
              errors[b].createdAt ||
                ""
            )
          )
      );

      while (ids.length > 500) {
        const old =
          ids.shift();

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
      Object.keys(security);

    if (ids.length > 1000) {
      ids.sort(
        (a, b) =>
          String(
            security[a].createdAt ||
              ""
          ).localeCompare(
            String(
              security[b].createdAt ||
                ""
            )
          )
      );

      while (ids.length > 1000) {
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
  } catch {}
}

/* =========================================================
   USAGE
========================================================= */

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
      updatedAt: Date.now(),
    };
  }

  if (type === "ai") {
    usage[userId]
      .aiGenerations += 1;

    usage[userId]
      .aiSeconds +=
      Number(seconds || 0);
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
    .updatedAt = Date.now();

  await writeJson(
    USAGE_FILE,
    usage
  );
}

/* =========================================================
   CREDITS
========================================================= */

const STARTER_CREDITS =
  Math.max(
    0,
    Number(
      process.env.FREE_STARTER_CREDITS ||
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

/* FIXED v17.1 STORAGE INITIALIZATION */
async function readCredits() {
  const data =
    await readJson(
      CREDITS_FILE,
      {
        users: {},
        transactions: [],
      }
    );

  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return {
      users: {},
      transactions: [],
    };
  }

  if (
    !data.users ||
    typeof data.users !== "object" ||
    Array.isArray(data.users)
  ) {
    data.users = {};
  }

  if (!Array.isArray(data.transactions)) {
    data.transactions = [];
  }

  return data;
}

function availableCredits(account) {
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

function creditCost(seconds) {
  return (
    Math.ceil(
      normalizeDuration(seconds) / 5
    ) *
    CREDITS_PER_5_SECONDS
  );
}

function newCreditAccount() {
  return {
    freeCredits:
      STARTER_CREDITS,
    paidCredits: 0,
    promotionalCredits: 0,
    consumedCredits: 0,
    createdAt:
      new Date().toISOString(),
    updatedAt:
      new Date().toISOString(),
  };
}

async function ensureCredits(userId) {
  const data =
    await readCredits();

  if (!data.users[userId]) {
    data.users[userId] =
      newCreditAccount();

    data.transactions.push({
      id: randomUUID(),
      type: "credit_issue",
      userId,
      amount:
        STARTER_CREDITS,
      bucket: "free",
      reason:
        "MAMAKI starter credits",
      createdAt:
        new Date().toISOString(),
    });

    await writeJson(
      CREDITS_FILE,
      data
    );
  }

  return data.users[userId];
}

async function reserveCredits(
  userId,
  amount
) {
  const data =
    await readCredits();

  if (!data.users[userId]) {
    data.users[userId] =
      newCreditAccount();
  }

  const account =
    data.users[userId];

  if (
    availableCredits(account) <
    amount
  ) {
    return null;
  }

  let remaining =
    amount;

  const used = {
    freeCredits: 0,
    promotionalCredits: 0,
    paidCredits: 0,
  };

  for (
    const bucket of [
      "freeCredits",
      "promotionalCredits",
      "paidCredits",
    ]
  ) {
    const take =
      Math.min(
        Number(
          account[bucket] || 0
        ),
        remaining
      );

    account[bucket] -=
      take;

    used[bucket] =
      take;

    remaining -=
      take;
  }

  account.consumedCredits =
    Number(
      account.consumedCredits || 0
    ) + amount;

  account.updatedAt =
    new Date().toISOString();

  data.transactions.push({
    id: randomUUID(),
    type: "credit_consumption",
    userId,
    amount,
    buckets: used,
    createdAt:
      new Date().toISOString(),
  });

  await writeJson(
    CREDITS_FILE,
    data
  );

  return used;
}

async function refundCredits(
  userId,
  used,
  reason = "Generation failed"
) {
  if (!used) {
    return;
  }

  const data =
    await readCredits();

  const account =
    data.users[userId];

  if (!account) {
    return;
  }

  let total = 0;

  for (
    const bucket of [
      "freeCredits",
      "promotionalCredits",
      "paidCredits",
    ]
  ) {
    const amount =
      Number(
        used[bucket] || 0
      );

    account[bucket] =
      Number(
        account[bucket] || 0
      ) + amount;

    total +=
      amount;
  }

  account.consumedCredits =
    Math.max(
      0,
      Number(
        account.consumedCredits || 0
      ) - total
    );

  account.updatedAt =
    new Date().toISOString();

  data.transactions.push({
    id: randomUUID(),
    type: "credit_refund",
    userId,
    amount: total,
    reason,
    createdAt:
      new Date().toISOString(),
  });

  await writeJson(
    CREDITS_FILE,
    data
  );
}

/* =========================================================
   FINANCE
========================================================= */

async function readFinance() {
  const data =
    await readJson(
      FINANCE_FILE,
      {
        transactions: [],
      }
    );

  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return {
      transactions: [],
    };
  }

  if (
    !Array.isArray(data.transactions)
  ) {
    data.transactions = [];
  }

  return data;
}

async function addFinance(
  type,
  amount,
  category,
  description,
  adminId,
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
      String(
        category || "other"
      ),
    description:
      cleanText(
        description,
        500
      ),
    adminId,
    userId,
    createdAt:
      new Date().toISOString(),
    currency: "NGN",
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

  for (
    const transaction of
      transactions || []
  ) {
    const amount =
      Number(
        transaction.amount
      ) || 0;

    if (
      transaction.type ===
      "revenue"
    ) {
      revenue +=
        amount;
    } else if (
      transaction.type ===
      "refund"
    ) {
      refunds +=
        amount;
    } else if (
      transaction.type ===
      "cost"
    ) {
      costs +=
        amount;
    }
  }

  const netRevenue =
    revenue - refunds;

  const profit =
    netRevenue - costs;

  return {
    grossRevenue:
      revenue,
    refunds,
    netRevenue,
    totalCosts:
      costs,
    profit,
    profitMargin:
      netRevenue
        ? (profit /
            netRevenue) *
          100
        : 0,
  };
}

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
      "Download failed with HTTP " +
        response.status
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
    Buffer.isBuffer(output)
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
      Buffer.from(output)
    );

    return destination;
  }

  if (
    Array.isArray(output) &&
    output.length
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

/* =========================================================
   FFMPEG
========================================================= */

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

      let stderr =
        "";

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
            return resolve();
          }

          const error =
            new Error(
              "FFmpeg failed with code " +
                code +
                ": " +
                stderr.slice(
                  -4000
                )
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
    ratioSize(ratio);

  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    "scale=" +
      size +
      ":force_original_aspect_ratio=decrease,pad=" +
      size +
      ":(ow-iw)/2:(oh-ih)/2",
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
    "sine=frequency=220:sample_rate=44100:duration=" +
      duration,
    "-af",
    "volume=0.035,afade=t=in:st=0:d=1,afade=t=out:st=" +
      Math.max(
        0,
        duration - 1
      ) +
      ":d=1",
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
      randomUUID() +
        ".txt"
    );

  const content =
    files
      .map(
        file =>
          "file '" +
          file.replace(
            /'/g,
            "'\\''"
          ) +
          "'"
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
   AI DIRECTOR
========================================================= */

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
        x => x.trim()
      )
      .filter(Boolean);

  const maxScenes =
    Math.max(
      1,
      Math.ceil(
        targetSeconds / 5
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
    "Visual style: " +
      style +
      ".",
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
    const error =
      new Error(
        "REPLICATE_API_TOKEN is not configured."
      );

    error.code =
      "REPLICATE_AUTH_REQUIRED";

    throw error;
  }

  const frames =
    wanFrames(seconds);

  const enhanced =
    prompt +
    "\n\nOutput requirements: " +
    ratio +
    " aspect ratio, professional " +
    (quality ||
      "standard") +
    " quality.";

  try {
    return await replicate.run(
      T2V_MODEL,
      {
        input: {
          prompt: enhanced,
          num_frames: frames,
          aspect_ratio: ratio,
        },
      }
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
    const error =
      new Error(
        "REPLICATE_API_TOKEN is not configured."
      );

    error.code =
      "REPLICATE_AUTH_REQUIRED";

    throw error;
  }

  const frames =
    wanFrames(seconds);

  const base64 =
    imageBuffer.toString(
      "base64"
    );

  const dataUri =
    "data:image/jpeg;base64," +
    base64;

  try {
    return await replicate.run(
      I2V_MODEL,
      {
        input: {
          prompt:
            prompt +
            "\n\nCreate coherent motion from the supplied reference image. Aspect ratio " +
            ratio +
            ". Quality " +
            (quality ||
              "standard") +
            ".",
          image: dataUri,
          num_frames: frames,
          aspect_ratio: ratio,
        },
      }
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

  const sceneDuration =
    5;

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

    job.progress =
      Math.round(
        (i /
          scenes.length) *
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
        job.id +
          "-scene-" +
          i +
          ".mp4"
      );

    const output =
      imageBuffer &&
      i === 0
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

    files.push(
      rawFile
    );

    job.progress =
      Math.round(
        ((i + 1) /
          scenes.length) *
          75
      );
  }

  const combined =
    path.join(
      OUTPUTS,
      job.id +
        "-combined.mp4"
    );

  await combineVideoFiles(
    files,
    combined
  );

  job.progress = 82;

  const durationFile =
    path.join(
      OUTPUTS,
      job.id +
        "-duration.mp4"
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
      job.id +
        "-music.m4a"
    );

  await createSoftMusic(
    music,
    duration
  );

  const audioFile =
    path.join(
      OUTPUTS,
      job.id +
        "-audio.mp4"
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
      job.id +
        ".mp4"
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
    jobId +
      "-combined.mp4",
    jobId +
      "-duration.mp4",
    jobId +
      "-audio.mp4",
    jobId +
      ".mp4",
  ];

  for (
    const name of outputNames
  ) {
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
        jobId + "-"
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

/* =========================================================
   PROJECTS
========================================================= */

async function saveProjectForUser(
  userId,
  project
) {
  const id =
    project.id ||
    randomUUID();

  const file =
    path.join(
      PROJECTS,
      safeFileName(id) +
        ".json"
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
    } catch {}
  }

  return result;
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
  return createHash(
    "sha256"
  )
    .update(
      code +
        ":" +
        SESSION_SECRET
    )
    .digest("hex");
}

function resetKey(email) {
  return createHash(
    "sha256"
  )
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
        method: "POST",
        headers: {
          Authorization:
            "Bearer " +
            RESEND_API_KEY,
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          from:
            RESEND_FROM,
          to: [email],
          subject:
            "MAMAKI AI password recovery code",
          html:
            "<div style=\"font-family:Arial,sans-serif;max-width:560px;margin:auto\">" +
            "<h2>✨ MAMAKI AI</h2>" +
            "<p>We received a request to reset your MAMAKI account password.</p>" +
            "<p>Your recovery code is:</p>" +
            "<div style=\"font-size:32px;font-weight:700;letter-spacing:8px;padding:18px;background:#f3f3f3;text-align:center\">" +
            code +
            "</div>" +
            "<p>This code expires in 15 minutes.</p>" +
            "<p>If you did not request this, you can ignore this email.</p>" +
            "</div>",
        }),
      }
    );

  if (!response.ok) {
    const text =
      await response.text();

    const error =
      new Error(
        "Recovery email failed with HTTP " +
          response.status +
          ": " +
          text.slice(0, 1000)
      );

    error.code =
      "RECOVERY_EMAIL_FAILED";

    throw error;
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

  const current =
    map.get(key) || [];

  const recent =
    current.filter(
      time =>
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

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  async (req, res) => {
    res.status(200).json({
      ok: true,
      status:
        "healthy",
      service:
        "MAMAKI AI Video Creative Studio",
      version:
        VERSION,
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
      version:
        VERSION,
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
        internalCredits:
          true,
        finance: true,
        watermark:
          "MAMAKI ✨",
      },
    });
  }
);

/* =========================================================
   AUTH
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
          user =>
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

      const role =
        email ===
          ADMIN_EMAIL &&
        ADMIN_EMAIL
          ? "admin"
          : "user";

      users[id] = {
        id,
        name,
        email,
        salt:
          credentials.salt,
        passwordHash:
          credentials.hash,
        role,
        disabled: false,
        createdAt:
          new Date().toISOString(),
        lastLoginAt:
          null,
        lastActiveAt:
          new Date().toISOString(),
      };

      await writeJson(
        USERS_FILE,
        users
      );

      await ensureCredits(
        id
      );

      const token =
        await createSession(
          id,
          role
        );

      await recordSecurityEvent(
        "REGISTER",
        {
          userId: id,
          email,
          role,
        }
      );

      res.status(201).json({
        ok: true,
        message:
          "MAMAKI account created successfully.",
        token,
        user: {
          id,
          name,
          email,
          role,
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

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      const user =
        Object.values(
          users
        ).find(
          item =>
            String(
              item.email
            ).toLowerCase() ===
            email
        );

      if (
        !user ||
        !verifyPassword(
          password,
          user.salt,
          user.passwordHash
        )
      ) {
        await recordSecurityEvent(
          "LOGIN_FAILED",
          { email }
        );

        return res.status(401).json({
          ok: false,
          error:
            "INVALID_LOGIN",
          message:
            "Incorrect email or password.",
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

      await ensureCredits(
        user.id
      );

      const role =
        user.role || "user";

      const token =
        await createSession(
          user.id,
          role
        );

      await recordSecurityEvent(
        role === "admin"
          ? "ADMIN_LOGIN_SUCCESS"
          : "LOGIN_SUCCESS",
        {
          userId:
            user.id,
          email:
            user.email,
          role,
          method:
            "ACCOUNT_CREDENTIALS",
        }
      );

      res.json({
        ok: true,
        message:
          "Login successful.",
        token,
        user: {
          id:
            user.id,
          name:
            user.name,
          email:
            user.email,
          role,
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
      message:
        "Logged out successfully.",
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
      return res.status(401).json({
        ok: false,
        authenticated:
          false,
      });
    }

    res.json({
      ok: true,
      authenticated:
        true,
      user: {
        id:
          user.id,
        name:
          user.name,
        email:
          user.email,
        role:
          user.role,
        createdAt:
          user.createdAt,
        lastActiveAt:
          user.lastActiveAt,
      },
    });
  }
);

app.post(
  "/api/auth/heartbeat",
  async (req, res) => {
    const user =
      await getCurrentUser(
        req
      );

    if (!user) {
      return res.status(401).json({
        ok: false,
        authenticated:
          false,
      });
    }

    res.json({
      ok: true,
      authenticated:
        true,
      activeAt:
        user.lastActiveAt ||
        new Date().toISOString(),
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
    const usage =
      await readJson(
        USAGE_FILE,
        {}
      );

    const mine =
      usage[req.user.id] || {
        aiGenerations: 0,
        aiSeconds: 0,
        studioJobs: 0,
        narrationJobs: 0,
      };

    const credits =
      await ensureCredits(
        req.user.id
      );

    res.json({
      ok: true,
      account: {
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
      },
      usage: mine,
      credits: {
        available:
          availableCredits(
            credits
          ),
        free:
          Number(
            credits.freeCredits ||
              0
          ),
        paid:
          Number(
            credits.paidCredits ||
              0
          ),
        promotional:
          Number(
            credits.promotionalCredits ||
              0
          ),
        consumed:
          Number(
            credits.consumedCredits ||
              0
          ),
      },
      limits: {
        maximumProductionSeconds:
          MAX_DURATION,
        freeStudio:
          true,
      },
    });
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

app.put(
  "/api/account/profile",
  requireUser,
  async (req, res) => {
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
          "USER_NOT_FOUND",
      });
    }

    const name =
      cleanText(
        req.body.name,
        100
      );

    if (name) {
      user.name =
        name;
    }

    user.lastActiveAt =
      new Date().toISOString();

    users[user.id] =
      user;

    await writeJson(
      USERS_FILE,
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
          user.role,
      },
    });
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
            req.body.password ||
            ""
        );

      if (
        !oldPassword ||
        !newPassword
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "PASSWORDS_REQUIRED",
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
            "USER_NOT_FOUND",
        });
      }

      if (
        !verifyPassword(
          oldPassword,
          user.salt,
          user.passwordHash
        )
      ) {
        return res.status(401).json({
          ok: false,
          error:
            "INVALID_CURRENT_PASSWORD",
          message:
            "Your current password is incorrect.",
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

      if (!REPLICATE_API_TOKEN) {
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

      const reservation =
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
            "This production requires " +
            generationCredits +
            " MAMAKI credits.",
        });
      }

      const jobId =
        randomUUID();

      const job = {
        id:
          jobId,
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
        cancelled:
          false,
        creditCost:
          generationCredits,
        creditReservation:
          reservation,
      };

      jobs.set(
        jobId,
        job
      );

      await recordSecurityEvent(
        "AI_GENERATION_REQUEST",
        {
          userId:
            user.id,
          jobId,
          duration,
          credits:
            generationCredits,
        }
      );

      res.status(202).json({
        ok: true,
        jobId,
        status:
          "queued",
        progress: 0,
        creditsReserved:
          generationCredits,
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
              await generateVideoProduction({
                job,
                userId:
                  user.id,
                prompt,
                imageBuffer:
                  req.file?.buffer ||
                  null,
                duration,
                ratio,
                style,
                quality,
              });

            job.status =
              "completed";

            job.progress =
              100;

            job.message =
              "Production completed successfully.";

            job.video =
              "/api/video/" +
              path.basename(
                final
              );

            job.completedAt =
              new Date().toISOString();
          } catch (error) {
            const classified =
              error.mamakiMessage
                ? {
                    code:
                      error.code ||
                      "GENERATION_FAILED",
                    message:
                      error.mamakiMessage,
                  }
                : classifyReplicateError(
                    error
                  );

            job.status =
              "failed";

            job.progress =
              0;

            job.error =
              classified.code;

            job.message =
              classified.message;

            await recordError(
              error,
              {
                route:
                  "/api/generate",
                jobId,
                userId:
                  user.id,
              }
            );

            await cleanupJobFiles(
              jobId
            );

            await refundCredits(
              user.id,
              job.creditReservation,
              "AI generation failed"
            );
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

      res.status(500).json({
        ok: false,
        error:
          "GENERATION_START_FAILED",
        message:
          "Unable to start production.",
      });
    }
  }
);

app.get(
  "/api/jobs/:id",
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
        message:
          "Production job was not found.",
      });
    }

    const user =
      await getCurrentUser(
        req
      );

    if (
      job.userId &&
      (!user ||
        user.id !==
          job.userId)
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "JOB_ACCESS_DENIED",
      });
    }

    res.json({
      ok: true,
      job: {
        id:
          job.id,
        status:
          job.status,
        progress:
          job.progress,
        message:
          job.message,
        video:
          job.video ||
          null,
        error:
          job.error ||
          null,
        currentScene:
          job.currentScene ||
          null,
        totalScenes:
          job.totalScenes ||
          null,
      },
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
        req.params.file,
        ""
      );

    if (
      !file.endsWith(
        ".mp4"
      )
    ) {
      return res
        .status(400)
        .send(
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
        "Cache-Control",
        "private, max-age=3600"
      );

      res.sendFile(
        full
      );
    } catch {
      res
        .status(404)
        .send(
          "Video not found."
        );
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
    const all =
      await getAllProjects();

    const mine =
      all.filter(
        project =>
          project.userId ===
          req.user.id
      );

    res.json({
      ok: true,
      projects:
        mine.sort(
          (a, b) =>
            String(
              b.updatedAt ||
                ""
            ).localeCompare(
              String(
                a.updatedAt ||
                  ""
              )
            )
        ),
    });
  }
);

app.get(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    const id =
      safeFileName(
        req.params.id
      );

    const file =
      path.join(
        PROJECTS,
        id + ".json"
      );

    try {
      const project =
        JSON.parse(
          await fs.readFile(
            file,
            "utf8"
          )
        );

      if (
        project.userId !==
        req.user.id
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
    } catch {
      res.status(404).json({
        ok: false,
        error:
          "PROJECT_NOT_FOUND",
      });
    }
  }
);

app.post(
  "/api/projects/save",
  requireUser,
  async (req, res) => {
    try {
      const project =
        await saveProjectForUser(
          req.user.id,
          {
            ...req.body,
            userId:
              req.user.id,
          }
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
            "/api/projects/save",
          userId:
            req.user.id,
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "PROJECT_SAVE_FAILED",
        message:
          "Unable to save project.",
      });
    }
  }
);

/* =========================================================
   FREE STUDIO
========================================================= */

app.post(
  "/api/studio/photo-video",
  upload.array(
    "photos",
    50
  ),
  async (req, res) => {
    try {
      const user =
        await getCurrentUser(
          req
        );

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
            id +
              "-" +
              i +
              ".jpg"
          );

        const clip =
          path.join(
            TMP,
            id +
              "-" +
              i +
              ".mp4"
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
          "scale=" +
            size +
            ":force_original_aspect_ratio=decrease,pad=" +
            size +
            ":(ow-iw)/2:(oh-ih)/2",
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
          id +
            "-combined.mp4"
        );

      await combineVideoFiles(
        clips,
        combined
      );

      const watermarked =
        path.join(
          OUTPUTS,
          id + ".mp4"
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
          "/api/video/" +
          path.basename(
            watermarked
          ),
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
          id +
            "-input.mp4"
        );

      const trimmed =
        path.join(
          OUTPUTS,
          id +
            "-trimmed.mp4"
        );

      const final =
        path.join(
          OUTPUTS,
          id + ".mp4"
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
          "/api/video/" +
          path.basename(
            final
          ),
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
            id +
              "-" +
              i +
              ".mp4"
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
          id +
            "-combined.mp4"
        );

      const final =
        path.join(
          OUTPUTS,
          id + ".mp4"
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
          "/api/video/" +
          path.basename(
            final
          ),
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
          id + ".mp3"
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
          "/api/audio/" +
          path.basename(
            output
          ),
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
      return res
        .status(400)
        .send(
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
      res
        .status(404)
        .send(
          "Audio not found."
        );
    }
  }
);

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
          req.body.subtitles,
          30000
        );

      if (!subtitles) {
        return res.status(400).json({
          ok: false,
          error:
            "SUBTITLES_REQUIRED",
          message:
            "Provide subtitle text in SRT/VTT format.",
        });
      }

      const id =
        randomUUID();

      const input =
        path.join(
          TMP,
          id +
            "-input.mp4"
        );

      const subtitleFile =
        path.join(
          TMP,
          id + ".srt"
        );

      const subtitled =
        path.join(
          OUTPUTS,
          id +
            "-subtitled.mp4"
        );

      const final =
        path.join(
          OUTPUTS,
          id + ".mp4"
        );

      await fs.writeFile(
        input,
        req.file.buffer
      );

      let srt =
        subtitles;

      if (
        subtitles
          .toLowerCase()
          .includes(
            "webvtt"
          )
      ) {
        srt =
          subtitles.replace(
            /^WEBVTT\s*/i,
            ""
          );
      }

      await fs.writeFile(
        subtitleFile,
        srt,
        "utf8"
      );

      const escaped =
        subtitleFile
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
          );

      await runFFmpeg([
        "-y",
        "-i",
        input,
        "-vf",
        "subtitles='" +
          escaped +
          "'",
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
        subtitled,
      ]);

      await addWatermark(
        subtitled,
        final
      );

      res.json({
        ok: true,
        video:
          "/api/video/" +
          path.basename(
            final
          ),
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
          "Unable to burn subtitles into the video.",
      });
    }
  }
);

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
          req.body.ratio
        );

      const id =
        randomUUID();

      const input =
        path.join(
          TMP,
          id +
            "-input.mp4"
        );

      const resized =
        path.join(
          OUTPUTS,
          id +
            "-resized.mp4"
        );

      const final =
        path.join(
          OUTPUTS,
          id + ".mp4"
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
          "/api/video/" +
          path.basename(
            final
          ),
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
   FIXED ADMIN LOGIN
========================================================= */

app.post(
  "/api/admin/login",
  async (req, res) => {
    try {
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
          10,
          15 * 60 * 1000
        )
      ) {
        await recordSecurityEvent(
          "ADMIN_LOGIN_RATE_LIMITED",
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

      if (
        email !==
          ADMIN_EMAIL ||
        password !==
          ADMIN_PASSWORD
      ) {
        await recordSecurityEvent(
          "ADMIN_LOGIN_FAILED",
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

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      let admin =
        Object.values(
          users
        ).find(
          user =>
            String(
              user.email
            ).toLowerCase() ===
            ADMIN_EMAIL
        );

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
          lastActiveAt:
            new Date().toISOString(),
        };

        users[id] =
          admin;

        await recordSecurityEvent(
          "ADMIN_ACCOUNT_RESTORED",
          {
            userId:
              id,
            email:
              ADMIN_EMAIL,
          }
        );
      } else {
        /*
         * IMPORTANT:
         * The configured Render master credentials
         * are authoritative for /api/admin/login.
         *
         * We do NOT verify the old stored password here.
         * This prevents an old/broken password hash from
         * locking the configured administrator out.
         */
        admin.role =
          "admin";

        admin.disabled =
          false;

        admin.lastActiveAt =
          new Date().toISOString();
      }

      admin.lastLoginAt =
        new Date().toISOString();

      users[admin.id] =
        admin;

      await writeJson(
        USERS_FILE,
        users
      );

      /*
       * FIX:
       * Always ensure credits after readCredits()
       * has normalized the storage structure.
       */
      await ensureCredits(
        admin.id
      );

      const token =
        await createSession(
          admin.id,
          "admin"
        );

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
        message:
          "Administrator login successful.",
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
      console.error(
        "ADMIN LOGIN ERROR:",
        error
      );

      await recordError(
        error,
        {
          route:
            "/api/admin/login",
          adminEmail:
            ADMIN_EMAIL,
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

    let aiGenerations = 0;
    let aiSeconds = 0;
    let studioJobs = 0;
    let narrationJobs = 0;

    for (
      const item of
        Object.values(
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
        totalAdmins:
          userList.filter(
            user =>
              user.role ===
              "admin"
          ).length,
        activeUsers:
          userList.filter(
            user =>
              !user.disabled
          ).length,
        disabledUsers:
          userList.filter(
            user =>
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
        processingJobs:
          jobList.filter(
            job =>
              job.status ===
              "processing"
          ).length,
        completedJobs:
          jobList.filter(
            job =>
              job.status ===
              "completed"
          ).length,
        failedJobs:
          jobList.filter(
            job =>
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
        uptime:
          process.uptime(),
      },
    });
  }
);

/* =========================================================
   ADMIN ANALYTICS
========================================================= */

app.get(
  "/api/admin/analytics",
  requireAdmin,
  async (req, res) => {
    const users =
      Object.values(
        await readJson(
          USERS_FILE,
          {}
        )
      );

    const usage =
      Object.values(
        await readJson(
          USAGE_FILE,
          {}
        )
      );

    const projects =
      await getAllProjects();

    const credits =
      await readCredits();

    const finance =
      await readFinance();

    const now =
      Date.now();

    const day =
      24 *
      60 *
      60 *
      1000;

    const activeUsers =
      users.filter(
        user => {
          const time =
            Date.parse(
              user.lastActiveAt ||
                ""
            );

          return (
            Number.isFinite(
              time
            ) &&
            now - time <=
              15 *
                60 *
                1000
          );
        }
      ).length;

    const newUsersToday =
      users.filter(
        user => {
          const time =
            Date.parse(
              user.createdAt ||
                ""
            );

          return (
            Number.isFinite(
              time
            ) &&
            now - time <
              day
          );
        }
      ).length;

    const newUsersWeek =
      users.filter(
        user => {
          const time =
            Date.parse(
              user.createdAt ||
                ""
            );

          return (
            Number.isFinite(
              time
            ) &&
            now - time <
              7 * day
          );
        }
      ).length;

    const newUsersMonth =
      users.filter(
        user => {
          const time =
            Date.parse(
              user.createdAt ||
                ""
            );

          return (
            Number.isFinite(
              time
            ) &&
            now - time <
              30 * day
          );
        }
      ).length;

    const totals =
      usage.reduce(
        (acc, item) => ({
          aiGenerations:
            acc.aiGenerations +
            Number(
              item.aiGenerations ||
                0
            ),
          aiSeconds:
            acc.aiSeconds +
            Number(
              item.aiSeconds ||
                0
            ),
          studioJobs:
            acc.studioJobs +
            Number(
              item.studioJobs ||
                0
            ),
          narrationJobs:
            acc.narrationJobs +
            Number(
              item.narrationJobs ||
                0
            ),
        }),
        {
          aiGenerations: 0,
          aiSeconds: 0,
          studioJobs: 0,
          narrationJobs: 0,
        }
      );

    const balances =
      Object.values(
        credits.users
      );

    const creditIssued =
      credits.transactions
        .filter(
          x =>
            x.type ===
            "credit_issue"
        )
        .reduce(
          (n, x) =>
            n +
            Number(
              x.amount || 0
            ),
          0
        );

    const creditConsumed =
      balances.reduce(
        (n, x) =>
          n +
          Number(
            x.consumedCredits ||
              0
          ),
        0
      );

    const creditRemaining =
      balances.reduce(
        (n, x) =>
          n +
          availableCredits(
            x
          ),
        0
      );

    res.json({
      ok: true,
      analytics: {
        users:
          users.length,
        admins:
          users.filter(
            u =>
              u.role ===
              "admin"
          ).length,
        activeUsers,
        newUsersToday,
        newUsersWeek,
        newUsersMonth,
        disabledUsers:
          users.filter(
            u =>
              u.disabled
          ).length,
        projects:
          projects.length,
        ...totals,
        credits: {
          issued:
            creditIssued,
          consumed:
            creditConsumed,
          remaining:
            creditRemaining,
          free:
            balances.reduce(
              (n, x) =>
                n +
                Number(
                  x.freeCredits ||
                    0
                ),
              0
            ),
          paid:
            balances.reduce(
              (n, x) =>
                n +
                Number(
                  x.paidCredits ||
                    0
                ),
              0
            ),
          promotional:
            balances.reduce(
              (n, x) =>
                n +
                Number(
                  x.promotionalCredits ||
                    0
                ),
              0
            ),
        },
        finance:
          financeTotals(
            finance.transactions
          ),
        provider: {
          replicateConfigured:
            Boolean(
              REPLICATE_API_TOKEN
            ),
          t2v:
            T2V_MODEL,
          i2v:
            I2V_MODEL,
        },
        system: {
          uptime:
            process.uptime(),
          ffmpeg:
            Boolean(
              ffmpegPath
            ),
          recoveryConfigured:
            Boolean(
              RESEND_API_KEY &&
                RESEND_FROM
            ),
          server: true,
          authentication:
            true,
          storage:
            true,
        },
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

    res.json({
      ok: true,
      credits:
        data,
    });
  }
);

app.post(
  "/api/admin/users/:id/credits",
  requireAdmin,
  async (req, res) => {
    const amount =
      Number(
        req.body.amount
      );

    const bucket =
      [
        "freeCredits",
        "paidCredits",
        "promotionalCredits",
      ].includes(
        req.body.bucket
      )
        ? req.body.bucket
        : "promotionalCredits";

    if (
      !Number.isFinite(
        amount
      ) ||
      amount === 0
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "INVALID_AMOUNT",
      });
    }

    const data =
      await readCredits();

    if (
      !data.users[
        req.params.id
      ]
    ) {
      data.users[
        req.params.id
      ] =
        newCreditAccount();

      data.users[
        req.params.id
      ].freeCredits = 0;
    }

    const account =
      data.users[
        req.params.id
      ];

    account[bucket] =
      Math.max(
        0,
        Number(
          account[bucket] ||
            0
        ) + amount
      );

    account.updatedAt =
      new Date().toISOString();

    data.transactions.push({
      id: randomUUID(),
      type:
        "admin_credit_adjustment",
      userId:
        req.params.id,
      amount,
      bucket,
      reason:
        cleanText(
          req.body.reason ||
            "Admin adjustment",
          300
        ),
      adminId:
        req.user.id,
      createdAt:
        new Date().toISOString(),
    });

    await writeJson(
      CREDITS_FILE,
      data
    );

    await recordSecurityEvent(
      "ADMIN_CREDIT_ADJUSTMENT",
      {
        adminId:
          req.user.id,
        userId:
          req.params.id,
        amount,
        bucket,
      }
    );

    res.json({
      ok: true,
      account,
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
    const data =
      await readFinance();

    res.json({
      ok: true,
      transactions:
        data.transactions,
      totals:
        financeTotals(
          data.transactions
        ),
    });
  }
);

app.post(
  "/api/admin/finance",
  requireAdmin,
  async (req, res) => {
    const type =
      [
        "revenue",
        "refund",
        "cost",
      ].includes(
        req.body.type
      )
        ? req.body.type
        : null;

    const amount =
      Number(
        req.body.amount
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

    await addFinance(
      type,
      amount,
      req.body.category,
      req.body.description,
      req.user.id,
      req.body.userId ||
        null
    );

    await recordSecurityEvent(
      "ADMIN_FINANCE_ENTRY",
      {
        adminId:
          req.user.id,
        type,
        amount,
      }
    );

    res.json({
      ok: true,
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
      await readCredits();

    const list =
      Object.values(
        users
      ).map(user => {
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
          disabled:
            Boolean(
              user.disabled
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
              : 0,
          usage:
            usage[
              user.id
            ] || {
              aiGenerations: 0,
              aiSeconds: 0,
              studioJobs: 0,
              narrationJobs: 0,
            },
        };
      });

    res.json({
      ok: true,
      users:
        list,
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
        project =>
          project.userId ===
          user.id
      );

    const credits =
      await ensureCredits(
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
          user.lastLoginAt,
        lastActiveAt:
          user.lastActiveAt,
      },
      usage:
        usage[
          user.id
        ] || {},
      credits: {
        available:
          availableCredits(
            credits
          ),
        free:
          credits.freeCredits,
        paid:
          credits.paidCredits,
        promotional:
          credits.promotionalCredits,
        consumed:
          credits.consumedCredits,
      },
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
      user.email ===
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
      Boolean(
        req.body.disabled !==
          undefined
          ? req.body.disabled
          : true
      );

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
      "ADMIN_ACCOUNT_STATUS_CHANGED",
      {
        adminId:
          req.user.id,
        userId:
          user.id,
        disabled:
          user.disabled,
      }
    );

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

app.post(
  "/api/admin/users/:id/role",
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
      user.email ===
      ADMIN_EMAIL
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "ADMIN_PROTECTED",
      });
    }

    user.role =
      req.body.role ===
      "admin"
        ? "admin"
        : "user";

    users[user.id] =
      user;

    await writeJson(
      USERS_FILE,
      users
    );

    await recordSecurityEvent(
      "ADMIN_ROLE_CHANGED",
      {
        adminId:
          req.user.id,
        userId:
          user.id,
        role:
          user.role,
      }
    );

    res.json({
      ok: true,
      user: {
        id:
          user.id,
        role:
          user.role,
      },
    });
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
        ).map(job => ({
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
        })),
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
      errors:
        list,
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
      events:
        list,
    });
  }
);

/* =========================================================
   PRIVATE ADMIN DASHBOARD
========================================================= */

app.get(
  "/admin",
  (req, res) => {
    res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI Admin</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0b0d12;color:#f5f7fb;font-family:Arial,sans-serif}
.wrap{max-width:1200px;margin:auto;padding:24px}
.card{background:#151922;border:1px solid #282d38;border-radius:18px;padding:20px;margin-bottom:18px}
h1{margin:0 0 8px;font-size:28px}
h2{font-size:18px}
.sub{color:#9da5b5;margin-bottom:20px}
input,button,select{width:100%;padding:13px;border-radius:10px;border:1px solid #343a47;background:#0e1118;color:white;margin-top:8px}
button{cursor:pointer;font-weight:700}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.stat{background:#0e1118;border:1px solid #292f3a;border-radius:14px;padding:16px}
.label{font-size:12px;color:#929aaa}
.value{font-size:24px;font-weight:800;margin-top:7px}
.hidden{display:none}
pre{white-space:pre-wrap;word-break:break-word;color:#aeb6c7}
.ok{color:#75e6a3}
.bad{color:#ff7d8a}
</style>
</head>
<body>
<div class="wrap">
<div class="card">
<h1>✨ MAMAKI AI</h1>
<div class="sub">Administrator Control Center · Private · v17.1.0</div>

<div id="loginBox">
<h2>Administrator Login</h2>
<input id="email" type="email" placeholder="Administrator email">
<input id="password" type="password" placeholder="Password">
<button onclick="login()">Sign in</button>
<div id="msg"></div>
</div>

<div id="dashboard" class="hidden">
<button onclick="logout()">Logout</button>

<h2>Overview</h2>
<div class="grid">
<div class="stat"><div class="label">Total Users</div><div id="users" class="value">0</div></div>
<div class="stat"><div class="label">Live / Active</div><div id="active" class="value">0</div></div>
<div class="stat"><div class="label">New Today</div><div id="today" class="value">0</div></div>
<div class="stat"><div class="label">Videos Generated</div><div id="videos" class="value">0</div></div>
<div class="stat"><div class="label">Narrations</div><div id="narrations" class="value">0</div></div>
<div class="stat"><div class="label">Projects</div><div id="projects" class="value">0</div></div>
<div class="stat"><div class="label">Credits Remaining</div><div id="credits" class="value">0</div></div>
<div class="stat"><div class="label">Profit NGN</div><div id="profit" class="value">₦0</div></div>
</div>

<h2>Business & Finance</h2>
<div class="grid">
<div class="stat"><div class="label">Gross Revenue</div><div id="revenue" class="value">₦0</div></div>
<div class="stat"><div class="label">Refunds</div><div id="refunds" class="value">₦0</div></div>
<div class="stat"><div class="label">Costs</div><div id="costs" class="value">₦0</div></div>
<div class="stat"><div class="label">Profit Margin</div><div id="margin" class="value">0%</div></div>
</div>

<p class="sub">Financial figures remain zero until real transactions are recorded.</p>

<h2>AI Provider & System Health</h2>
<pre id="system">Loading...</pre>

<h2>Users</h2>
<pre id="userData">Loading...</pre>

<h2>Jobs</h2>
<pre id="jobData">Loading...</pre>

<h2>Security Activity</h2>
<pre id="securityData">Loading...</pre>

<h2>Errors</h2>
<pre id="errorData">Loading...</pre>
</div>
</div>
</div>

<script>
let token=localStorage.getItem("mamaki_admin_token")||"";

function authHeaders(){
  return {
    "Authorization":"Bearer "+token,
    "Content-Type":"application/json"
  };
}

function money(n){
  return "₦"+Number(n||0).toLocaleString();
}

function showDashboard(){
  document.getElementById("loginBox").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");
}

function showLogin(){
  document.getElementById("loginBox").classList.remove("hidden");
  document.getElementById("dashboard").classList.add("hidden");
}

async function login(){
  const email=document.getElementById("email").value.trim();
  const password=document.getElementById("password").value;
  const msg=document.getElementById("msg");

  msg.textContent="Signing in...";

  try{
    const r=await fetch("/api/admin/login",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({email,password})
    });

    const d=await r.json();

    if(!r.ok || !d.ok){
      msg.textContent=d.message||"Administrator login failed.";
      return;
    }

    token=d.token;
    localStorage.setItem("mamaki_admin_token",token);
    msg.textContent="Administrator login successful.";
    showDashboard();
    loadAll();
  }catch(e){
    msg.textContent="Unable to connect to MAMAKI.";
  }
}

function logout(){
  token="";
  localStorage.removeItem("mamaki_admin_token");
  showLogin();
}

async function api(path){
  const r=await fetch(path,{
    headers:{"Authorization":"Bearer "+token}
  });

  if(r.status===401 || r.status===403){
    logout();
    throw new Error("Admin session expired.");
  }

  return r.json();
}

async function loadAll(){
  try{
    const a=await api("/api/admin/analytics");
    if(!a.ok)throw new Error(a.message||"Analytics failed");

    const x=a.analytics;

    document.getElementById("users").textContent=x.users||0;
    document.getElementById("active").textContent=x.activeUsers||0;
    document.getElementById("today").textContent=x.newUsersToday||0;
    document.getElementById("videos").textContent=x.aiGenerations||0;
    document.getElementById("narrations").textContent=x.narrationJobs||0;
    document.getElementById("projects").textContent=x.projects||0;
    document.getElementById("credits").textContent=(x.credits&&x.credits.remaining)||0;

    const f=x.finance||{};
    document.getElementById("profit").textContent=money(f.profit);
    document.getElementById("revenue").textContent=money(f.grossRevenue);
    document.getElementById("refunds").textContent=money(f.refunds);
    document.getElementById("costs").textContent=money(f.totalCosts);
    document.getElementById("margin").textContent=Number(f.profitMargin||0).toFixed(2)+"%";

    document.getElementById("system").textContent=
      JSON.stringify({
        version:x.provider?"17.1.0":"17.1.0",
        provider:x.provider,
        system:x.system
      },null,2);

    const users=await api("/api/admin/users");
    document.getElementById("userData").textContent=
      JSON.stringify(users.users||[],null,2);

    const jobs=await api("/api/admin/jobs");
    document.getElementById("jobData").textContent=
      JSON.stringify(jobs.jobs||[],null,2);

    const security=await api("/api/admin/security");
    document.getElementById("securityData").textContent=
      JSON.stringify(security.events||[],null,2);

    const errors=await api("/api/admin/errors");
    document.getElementById("errorData").textContent=
      JSON.stringify(errors.errors||[],null,2);

  }catch(e){
    if(token){
      document.getElementById("system").textContent=e.message;
    }
  }
}

if(token){
  showDashboard();
  loadAll();
}else{
  showLogin();
}

setInterval(()=>{
  if(token)loadAll();
},30000);
</script>
</body>
</html>
`);
  }
);

/* =========================================================
   ACCOUNT PAGE
========================================================= */

app.get(
  "/account",
  (req, res) => {
    res.type("html").send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI Account</title>
</head>
<body style="font-family:Arial;padding:30px">
<h1>✨ MAMAKI AI</h1>
<p>Personal Account</p>
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
        jobs.delete(id);
      }
    }
  },
  10 * 60 * 1000
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
      "✨ MAMAKI AI v" +
        VERSION +
        " running on " +
        HOST +
        ":" +
        PORT
    );

    console.log(
      "Replicate configured: " +
        Boolean(
          REPLICATE_API_TOKEN
        )
    );

    console.log(
      "Admin configured: " +
        Boolean(
          ADMIN_EMAIL &&
            ADMIN_PASSWORD
        )
    );

    console.log(
      "Password recovery configured: " +
        Boolean(
          RESEND_API_KEY &&
            RESEND_FROM
        )
    );
  }
);
