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
const VERSION = "17.2.0";

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

const MAX_DURATION = 7200;
const MIN_DURATION = 5;

const ADMIN_EMAIL = String(
  process.env.ADMIN_EMAIL || ""
).trim().toLowerCase();

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
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "20mb",
  })
);

app.use((req, res, next) => {
  res.setHeader(
    "X-MAMAKI-Version",
    VERSION
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "Referrer-Policy",
    "no-referrer"
  );

  res.setHeader(
    "X-Frame-Options",
    "SAMEORIGIN"
  );

  next();
});

/* =========================================================
   STORAGE
========================================================= */

async function ensureStorage() {
  await fs.mkdir(TMP, {
    recursive: true,
  });

  await fs.mkdir(OUTPUTS, {
    recursive: true,
  });

  await fs.mkdir(PROJECTS, {
    recursive: true,
  });

  await fs.mkdir(DATA, {
    recursive: true,
  });

  for (const file of [
    USERS_FILE,
    SESSIONS_FILE,
    ERRORS_FILE,
    USAGE_FILE,
    RESET_FILE,
    SECURITY_FILE,
    CREDITS_FILE,
    FINANCE_FILE,
  ]) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(
        file,
        "{}",
        "utf8"
      );
    }
  }

  const credits = await readJson(
    CREDITS_FILE,
    {}
  );

  if (
    !credits ||
    typeof credits !== "object" ||
    Array.isArray(credits)
  ) {
    await writeJson(
      CREDITS_FILE,
      {
        pool: 0,
        users: {},
        transactions: [],
        updatedAt:
          new Date().toISOString(),
      }
    );
  }
}

async function readJson(
  file,
  fallback = {}
) {
  try {
    const raw = await fs.readFile(
      file,
      "utf8"
    );

    if (!raw.trim()) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(
  file,
  data
) {
  const temp =
    `${file}.${randomUUID()}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify(
      data,
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

/* =========================================================
   HELPERS
========================================================= */

function cleanText(
  value,
  max = 10000
) {
  return String(value || "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, max);
}

function normalizeEmail(value) {
  return cleanText(
    value,
    200
  ).toLowerCase();
}

function normalizeDuration(
  value
) {
  if (
    typeof value === "string"
  ) {
    const match =
      value
        .trim()
        .match(
          /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/i
        );

    if (match) {
      let n = Number(
        match[1]
      );

      const unit =
        String(
          match[2] || "s"
        ).toLowerCase();

      if (
        [
          "m",
          "min",
          "mins",
        ].includes(unit)
      ) {
        n *= 60;
      }

      if (
        [
          "h",
          "hr",
          "hrs",
        ].includes(unit)
      ) {
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

function normalizeRatio(
  value
) {
  const v = String(
    value || "16:9"
  );

  return [
    "16:9",
    "9:16",
    "1:1",
  ].includes(v)
    ? v
    : "16:9";
}

function ratioSize(
  ratio
) {
  if (ratio === "9:16") {
    return "1080:1920";
  }

  if (ratio === "1:1") {
    return "1080:1080";
  }

  return "1920:1080";
}

function wanFrames(
  seconds
) {
  return Number(seconds) <= 5
    ? 81
    : 121;
}

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}

function safeFileName(
  name,
  fallback = "file"
) {
  const base =
    path.basename(
      String(
        name || fallback
      )
    );

  return base
    .replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    )
    .slice(0, 150);
}

/* =========================================================
   PASSWORDS / SESSIONS
========================================================= */

function hashPassword(
  password,
  salt = randomBytes(16).toString("hex")
) {
  const hash =
    scryptSync(
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
    const actual =
      scryptSync(
        String(password),
        salt,
        64
      );

    const expected =
      Buffer.from(
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
    randomBytes(32).toString(
      "hex"
    );

  const secretPart =
    SESSION_SECRET
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
  const sessions =
    await readJson(
      SESSIONS_FILE,
      {}
    );

  const token =
    createToken();

  sessions[token] = {
    userId,
    role,
    createdAt:
      Date.now(),
    lastSeen:
      Date.now(),
  };

  await writeJson(
    SESSIONS_FILE,
    sessions
  );

  return token;
}

function getBearerToken(
  req
) {
  const header =
    String(
      req.headers.authorization ||
        ""
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
  const sessions =
    await readJson(
      SESSIONS_FILE,
      {}
    );

  let changed = false;

  for (
    const [
      token,
      session,
    ] of Object.entries(
      sessions
    )
  ) {
    if (
      session.userId ===
      userId
    ) {
      delete sessions[
        token
      ];
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

async function getSession(
  req
) {
  const token =
    getBearerToken(req);

  if (!token) {
    return null;
  }

  const sessions =
    await readJson(
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
      Number(
        session.createdAt || 0
      ) >
    maxAge
  ) {
    delete sessions[
      token
    ];

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

async function getCurrentUser(
  req
) {
  const session =
    await getSession(req);

  if (!session) {
    return null;
  }

  const users =
    await readJson(
      USERS_FILE,
      {}
    );

  const user =
    users[
      session.userId
    ];

  if (
    !user ||
    user.disabled
  ) {
    return null;
  }

  if (
    !user.lastActiveAt ||
    Date.now() -
      Date.parse(
        user.lastActiveAt
      ) >
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
  const user =
    await getCurrentUser(
      req
    );

  if (!user) {
    return res
      .status(401)
      .json({
        ok: false,
        error:
          "AUTH_REQUIRED",
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
  const user =
    await getCurrentUser(
      req
    );

  if (
    !user ||
    user.role !==
      "admin"
  ) {
    return res
      .status(403)
      .json({
        ok: false,
        error:
          "ADMIN_REQUIRED",
        message:
          "Administrator access required.",
      });
  }

  req.user = user;
  next();
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
      message:
        String(
          error?.message ||
            error ||
            "Unknown error"
        ).slice(0, 2000),
      code:
        String(
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
            errors[a]
              .createdAt || ""
          ).localeCompare(
            String(
              errors[b]
                .createdAt || ""
            )
          )
      );

      while (
        ids.length > 500
      ) {
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
  } catch {
    // Logging must never crash MAMAKI.
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
      type: String(
        type || "SECURITY_EVENT"
      ).toUpperCase(),
      createdAt:
        new Date().toISOString(),
      ...details,
    };

    const ids =
      Object.keys(
        security
      );

    if (ids.length > 500) {
      ids.sort(
        (a, b) =>
          String(
            security[a]
              .createdAt || ""
          ).localeCompare(
            String(
              security[b]
                .createdAt || ""
            )
          )
      );

      while (
        ids.length > 500
      ) {
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
    // Security logging must never crash the app.
  }
}

async function recordUsage(
  userId,
  type,
  seconds = 0
) {
  if (!userId) return;

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
      updatedAt:
        Date.now(),
    };
  }

  if (type === "ai") {
    usage[userId]
      .aiGenerations += 1;

    usage[userId]
      .aiSeconds +=
      Number(
        seconds || 0
      );
  }

  if (type === "studio") {
    usage[userId]
      .studioJobs += 1;
  }

  if (
    type === "narration"
  ) {
    usage[userId]
      .narrationJobs += 1;
  }

  usage[userId]
    .updatedAt =
    Date.now();

  await writeJson(
    USAGE_FILE,
    usage
  );
}

/* =========================================================
   RATE LIMIT
========================================================= */

function allowedByRate(
  map,
  key,
  maxAttempts,
  windowMs
) {
  const now =
    Date.now();

  const item =
    map.get(key) || {
      count: 0,
      started: now,
    };

  if (
    now - item.started >
    windowMs
  ) {
    item.count = 0;
    item.started = now;
  }

  item.count += 1;
  map.set(key, item);

  return item.count <=
    maxAttempts;
}

/* =========================================================
   REPLICATE ERROR HANDLING
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
    ) ||
    text.includes(
      "credit"
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
    ) ||
    text.includes(
      "api token"
    )
  ) {
    return {
      code:
        "REPLICATE_AUTH_REQUIRED",
      message:
        "The Replicate API token is invalid or not authorized.",
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
        "Replicate denied this request.",
    };
  }

  if (
    text.includes("429") ||
    text.includes(
      "rate limit"
    ) ||
    text.includes(
      "too many requests"
    )
  ) {
    return {
      code:
        "REPLICATE_RATE_LIMIT",
      message:
        "Replicate rate limit reached. Please try again later.",
    };
  }

  return {
    code:
      "REPLICATE_GENERATION_FAILED",
    message:
      "Replicate could not complete the AI generation.",
  };
}

/* =========================================================
   AI PROMPT
========================================================= */

function enhancePrompt(
  prompt,
  style = "Cinematic"
) {
  const base =
    cleanText(
      prompt,
      30000
    );

  return [
    base,
    `Style: ${style}.`,
    "High visual quality.",
    "Natural realistic motion.",
    "Strong subject consistency.",
    "Smooth camera movement.",
    "Detailed lighting and environment.",
    "Maintain continuity throughout the scene.",
    "No subtitles.",
    "No captions.",
    "No logos.",
    "No watermarks except MAMAKI branding added during final processing.",
  ].join(" ");
}

/* =========================================================
   FFMPEG
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
              "pipe",
            ],
          }
        );

      let stdout = "";
      let stderr = "";

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
          if (code === 0) {
            resolve({
              stdout,
              stderr,
            });
          } else {
            const error =
              new Error(
                `FFmpeg exited with code ${code}: ${stderr.slice(-3000)}`
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
    "drawtext=text='MAMAKI ✨':fontcolor=white@0.78:fontsize=24:box=1:boxcolor=black@0.35:boxborderw=8:x=w-tw-24:y=h-th-24",
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
}

async function combineVideoFiles(
  files,
  output
) {
  const list =
    path.join(
      TMP,
      `${randomUUID()}.txt`
    );

  const content =
    files
      .map(
        (file) =>
          `file '${String(
            file
          ).replace(
            /'/g,
            "'\\''"
          )}'`
      )
      .join("\n");

  await fs.writeFile(
    list,
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
      list,
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
      .unlink(list)
      .catch(() => {});
  }

  return output;
}

/* =========================================================
   PROJECTS
========================================================= */

async function getAllProjects() {
  const files =
    await fs.readdir(
      PROJECTS
    );

  const projects = [];

  for (
    const file of files
  ) {
    if (
      !file.endsWith(
        ".json"
      )
    ) {
      continue;
    }

    try {
      const data =
        JSON.parse(
          await fs.readFile(
            path.join(
              PROJECTS,
              file
            ),
            "utf8"
          )
        );

      projects.push(
        data
      );
    } catch {
      // Ignore corrupt project files.
    }
  }

  return projects;
}

async function saveProjectForUser(
  userId,
  project
) {
  const id =
    safeFileName(
      project.id ||
        randomUUID()
    );

  const now =
    new Date().toISOString();

  const output = {
    ...project,
    id,
    userId,
    createdAt:
      project.createdAt ||
      now,
    updatedAt: now,
  };

  await fs.writeFile(
    path.join(
      PROJECTS,
      `${id}.json`
    ),
    JSON.stringify(
      output,
      null,
      2
    ),
    "utf8"
  );

  return output;
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
    pool:
      Number(
        d?.pool || 0
      ),

    users:
      d &&
      typeof d.users ===
        "object" &&
      !Array.isArray(
        d.users
      )
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
  data
) {
  data.updatedAt =
    new Date().toISOString();

  await writeJson(
    CREDITS_FILE,
    data
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
  const n =
    Math.floor(
      Number(
        amount || 0
      )
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
  const cost =
    Math.max(
      1,
      Math.ceil(
        Number(
          seconds || 5
        ) / 5
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

  const balance =
    Number(
      d.users[id] || 0
    );

  if (
    balance < cost
  ) {
    const error =
      new Error(
        `Insufficient MAMAKI credits. Required ${cost}, available ${balance}.`
      );

    error.code =
      "MAMAKI_CREDITS_INSUFFICIENT";

    error.requiredCredits =
      cost;

    error.availableCredits =
      balance;

    throw error;
  }

  d.users[id] =
    balance - cost;

  d.transactions.push({
    id: randomUUID(),
    type: "CONSUME",
    source:
      "AI_GENERATION",
    userId: id,
    amount: -cost,
    seconds:
      Number(
        seconds || 0
      ),
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

function creditSummary(
  transactions
) {
  let issued = 0;
  let consumed = 0;
  let refunded = 0;

  for (
    const transaction of
      transactions
  ) {
    const amount =
      Number(
        transaction.amount ||
          0
      );

    if (
      transaction.type ===
        "ISSUE" &&
      amount > 0
    ) {
      issued += amount;
    }

    if (
      transaction.type ===
        "CONSUME" &&
      amount < 0
    ) {
      consumed +=
        Math.abs(amount);
    }

    if (
      transaction.type ===
        "REFUND" &&
      amount > 0
    ) {
      refunded += amount;
    }
  }

  return {
    issued,
    consumed,
    refunded,
  };
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
    const transaction of
      transactions
  ) {
    const amount =
      Number(
        transaction.amount ||
          0
      );

    switch (
      transaction.type
    ) {
      case "REVENUE":
        grossRevenue +=
          amount;
        break;

      case "REFUND":
        refunds +=
          amount;
        break;

      case "AI_COST":
      case "INFRASTRUCTURE_COST":
      case "OTHER_COST":
        costs +=
          amount;
        break;
    }
  }

  const netRevenue =
    grossRevenue -
    refunds;

  const profit =
    netRevenue -
    costs;

  const profitMargin =
    grossRevenue > 0
      ? (profit /
          grossRevenue) *
        100
      : 0;

  return {
    grossRevenue,
    refunds,
    netRevenue,
    costs,
    profit,
    profitMargin,
  };
}

/* =========================================================
   REPLICATE BALANCE
========================================================= */

async function getReplicateBalance() {
  /*
    Replicate does not provide a universally reliable
    account-credit balance through the generation API.

    Therefore MAMAKI NEVER FABRICATES A BALANCE.

    If no authoritative balance is available,
    the dashboard correctly reports $0.00 and marks
    balanceKnown=false.
  */

  return {
    configured:
      Boolean(
        REPLICATE_API_TOKEN
      ),
    balance: 0,
    balanceKnown: false,
    source:
      "No authoritative Replicate account balance available through the configured API.",
  };
}

/* =========================================================
   AI GENERATION
========================================================= */

async function runReplicatePrediction(
  input
) {
  if (!replicate) {
    const error =
      new Error(
        "Replicate is not configured."
      );

    error.code =
      "REPLICATE_AUTH_REQUIRED";

    throw error;
  }

  const model =
    input.imageBuffer
      ? I2V_MODEL
      : T2V_MODEL;

  const frames =
    wanFrames(
      input.duration
    );

  const prediction =
    await replicate.run(
      model,
      {
        input: {
          prompt:
            input.prompt,

          num_frames:
            frames,

          width:
            input.ratio ===
            "9:16"
              ? 480
              : input.ratio ===
                "1:1"
              ? 480
              : 832,

          height:
            input.ratio ===
            "9:16"
              ? 832
              : input.ratio ===
                "1:1"
              ? 480
              : 480,

          fps: 16,

          sample_shift: 12,

          go_fast: true,

          ...(input.imageBuffer
            ? {
                image:
                  `data:image/jpeg;base64,${input.imageBuffer.toString(
                    "base64"
                  )}`,
              }
            : {}),
        },
      }
    );

  return prediction;
}

async function predictionToFile(
  prediction,
  jobId
) {
  let url = null;

  if (
    typeof prediction ===
    "string"
  ) {
    url = prediction;
  } else if (
    prediction &&
    typeof prediction.url ===
      "function"
  ) {
    url =
      prediction.url();
  } else if (
    prediction?.output
  ) {
    if (
      typeof prediction.output ===
      "string"
    ) {
      url =
        prediction.output;
    } else if (
      Array.isArray(
        prediction.output
      )
    ) {
      url =
        prediction.output[0];
    }
  } else if (
    Array.isArray(
      prediction
    )
  ) {
    url =
      prediction[0];
  }

  if (!url) {
    const error =
      new Error(
        "Replicate completed but returned no video file."
      );

    error.code =
      "REPLICATE_NO_VIDEO_FILE";

    throw error;
  }

  const response =
    await fetch(
      String(url)
    );

  if (!response.ok) {
    throw new Error(
      `Unable to download generated video: HTTP ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  const file =
    path.join(
      TMP,
      `${jobId}-replicate.mp4`
    );

  await fs.writeFile(
    file,
    buffer
  );

  return file;
}

async function generateVideoProduction(
  {
    job,
    userId,
    prompt,
    imageBuffer,
    duration,
    ratio,
    style,
    quality,
  }
) {
  if (!REPLICATE_API_TOKEN) {
    const error =
      new Error(
        "Replicate is not configured."
      );

    error.code =
      "REPLICATE_AUTH_REQUIRED";

    throw error;
  }

  const credit =
    await consumeUserCredits(
      userId,
      duration
    );

  job.creditCost =
    credit.cost;

  job.creditBalance =
    credit.balance;

  const sceneLength = 5;

  const sceneCount =
    Math.max(
      1,
      Math.ceil(
        duration /
          sceneLength
      )
    );

  job.totalScenes =
    sceneCount;

  const clips = [];

  try {
    for (
      let i = 0;
      i < sceneCount;
      i++
    ) {
      job.currentScene =
        i + 1;

      job.progress =
        Math.round(
          (i /
            sceneCount) *
            90
        );

      job.message =
        `Generating AI scene ${i + 1} of ${sceneCount}.`;

      const remaining =
        duration -
        i * sceneLength;

      const sceneDuration =
        Math.min(
          sceneLength,
          remaining
        );

      const scenePrompt =
        enhancePrompt(
          prompt,
          style
        );

      const prediction =
        await runReplicatePrediction(
          {
            prompt:
              scenePrompt,

            imageBuffer:
              i === 0
                ? imageBuffer
                : null,

            duration:
              sceneDuration,

            ratio,
            quality,
          }
        );

      const raw =
        await predictionToFile(
          prediction,
          `${job.id}-${i}`
        );

      const normalized =
        path.join(
          TMP,
          `${job.id}-${i}-normalized.mp4`
        );

      await runFFmpeg([
        "-y",
        "-i",
        raw,
        "-t",
        String(
          sceneDuration
        ),
        "-vf",
        `scale=${ratioSize(
          ratio
        )}:force_original_aspect_ratio=decrease,pad=${ratioSize(
          ratio
        )}:(ow-iw)/2:(oh-ih)/2`,
        "-r",
        "30",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-an",
        normalized,
      ]);

      clips.push(
        normalized
      );
    }

    job.message =
      "Assembling final MAMAKI production.";

    job.progress = 94;

    const combined =
      path.join(
        TMP,
        `${job.id}-combined.mp4`
      );

    await combineVideoFiles(
      clips,
      combined
    );

    const final =
      path.join(
        OUTPUTS,
        `${job.id}.mp4`
      );

    job.progress = 98;

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
  } catch (error) {
    /*
      Refund internal MAMAKI credits if the generation
      fails before completion.
    */
    if (
      job.creditCost
    ) {
      try {
        const d =
          await readCredits();

        d.users[userId] =
          Number(
            d.users[userId] ||
              0
          ) +
          Number(
            job.creditCost ||
              0
          );

        d.transactions.push({
          id: randomUUID(),
          type: "REFUND",
          source:
            "FAILED_AI_GENERATION",
          userId,
          amount:
            Number(
              job.creditCost ||
                0
            ),
          createdAt:
            new Date().toISOString(),
        });

        await writeCredits(
          d
        );
      } catch {
        // Never hide the original generation error.
      }
    }

    throw error;
  }
}

async function cleanupJobFiles(
  jobId
) {
  try {
    const files =
      await fs.readdir(
        TMP
      );

    await Promise.all(
      files
        .filter(
          (file) =>
            file.includes(
              jobId
            )
        )
        .map(
          (file) =>
            fs
              .unlink(
                path.join(
                  TMP,
                  file
                )
              )
              .catch(
                () => {}
              )
        )
    );
  } catch {
    // Cleanup failure is non-fatal.
  }
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  async (
    req,
    res
  ) => {
    let ffmpegOk = false;

    try {
      await fs.access(
        ffmpegPath
      );
      ffmpegOk = true;
    } catch {
      ffmpegOk = false;
    }

    res.json({
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
      },
    });
  }
);

app.get(
  "/api/status",
  async (
    req,
    res
  ) => {
    res.json({
      ok: true,
      version:
        VERSION,
      features: {
        textToVideo: true,
        imageToVideo: true,
        freeStudio: true,
        photoToVideo: true,
        trimmer: true,
        combine: true,
        narration: true,
        subtitles: true,
        socialExport: true,
        projects: true,
        adminDashboard: true,
        credits: true,
        finance: true,
        passwordRecovery:
          Boolean(
            RESEND_API_KEY &&
              RESEND_FROM
          ),
      },
      provider: {
        configured:
          Boolean(
            REPLICATE_API_TOKEN
          ),
        t2v:
          T2V_MODEL,
        i2v:
          I2V_MODEL,
      },
    });
  }
);

/* =========================================================
   AUTH
========================================================= */

app.post(
  "/api/auth/register",
  async (
    req,
    res
  ) => {
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
            "MAMAKI User",
          100
        );

      if (
        !email ||
        !password
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "EMAIL_PASSWORD_REQUIRED",
          });
      }

      if (
        password.length <
        6
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "PASSWORD_TOO_SHORT",
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
            normalizeEmail(
              user.email
            ) === email
        );

      if (existing) {
        return res
          .status(409)
          .json({
            ok: false,
            error:
              "ACCOUNT_EXISTS",
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
        name:
          name ||
          "MAMAKI User",
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

      await recordSecurityEvent(
        "USER_REGISTERED",
        {
          userId: id,
          email,
        }
      );

      const token =
        await createSession(
          id,
          "user"
        );

      res.json({
        ok: true,
        token,
        user: {
          id,
          name:
            user.name,
          email,
          role:
            user.role,
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

      res
        .status(500)
        .json({
          ok: false,
          error:
            "REGISTER_FAILED",
          message:
            "Unable to create your MAMAKI account.",
        });
    }
  }
);

app.post(
  "/api/auth/login",
  async (
    req,
    res
  ) => {
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
        await recordSecurityEvent(
          "USER_LOGIN_FAILED",
          {
            email,
          }
        );

        return res
          .status(401)
          .json({
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
        user.lastLoginAt;

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

      await recordSecurityEvent(
        "USER_LOGIN_SUCCESS",
        {
          userId:
            user.id,
          email:
            user.email,
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

      res
        .status(500)
        .json({
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
  async (
    req,
    res
  ) => {
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
  async (
    req,
    res
  ) => {
    const user =
      await getCurrentUser(
        req
      );

    if (!user) {
      return res.json({
        ok: true,
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
        credits:
          await getUserCredits(
            user.id
          ),
      },
    });
  }
);

app.post(
  "/api/auth/heartbeat",
  requireUser,
  async (
    req,
    res
  ) => {
    res.json({
      ok: true,
      active:
        true,
      timestamp:
        new Date().toISOString(),
    });
  }
);

/* =========================================================
   PASSWORD RECOVERY
========================================================= */

app.post(
  "/api/auth/forgot-password",
  async (
    req,
    res
  ) => {
    const email =
      normalizeEmail(
        req.body.email
      );

    if (
      !allowedByRate(
        resetRate,
        email ||
          "unknown",
        3,
        60 * 60 * 1000
      )
    ) {
      return res
        .status(429)
        .json({
          ok: false,
          error:
            "RESET_RATE_LIMITED",
          message:
            "Too many password-reset requests. Try again later.",
        });
    }

    /*
      Do not reveal whether an account exists.
    */

    const generic =
      {
        ok: true,
        message:
          "If an account exists for that email, password recovery instructions will be sent.",
      };

    if (
      !RESEND_API_KEY ||
      !RESEND_FROM
    ) {
      return res.json({
        ...generic,
        recoveryConfigured:
          false,
      });
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

      if (!user) {
        return res.json(
          generic
        );
      }

      const rawToken =
        randomBytes(
          32
        ).toString(
          "hex"
        );

      const tokenHash =
        createHash(
          "sha256"
        )
          .update(
            rawToken
          )
          .digest(
            "hex"
          );

      const resets =
        await readJson(
          RESET_FILE,
          {}
        );

      resets[tokenHash] = {
        userId:
          user.id,
        createdAt:
          Date.now(),
        expiresAt:
          Date.now() +
          30 * 60 * 1000,
        used: false,
      };

      await writeJson(
        RESET_FILE,
        resets
      );

      const link =
        `${APP_URL}/reset-password?token=${encodeURIComponent(
          rawToken
        )}`;

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
            body: JSON.stringify(
              {
                from:
                  RESEND_FROM,
                to: [
                  user.email,
                ],
                subject:
                  "MAMAKI AI password reset",
                html:
                  `<p>Your MAMAKI password reset link:</p><p><a href="${link}">${link}</a></p><p>This link expires in 30 minutes.</p>`,
              }
            ),
          }
        );

      if (!response.ok) {
        throw new Error(
          `Password reset email failed with HTTP ${response.status}`
        );
      }

      await recordSecurityEvent(
        "PASSWORD_RESET_REQUESTED",
        {
          userId:
            user.id,
          email:
            user.email,
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

      return res.json(
        generic
      );
    }
  }
);

app.post(
  "/api/auth/reset-password",
  async (
    req,
    res
  ) => {
    try {
      const token =
        cleanText(
          req.body.token,
          200
        );

      const password =
        String(
          req.body.password ||
            ""
        );

      if (
        !token ||
        password.length <
          6
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "INVALID_RESET_REQUEST",
            message:
              "A valid reset token and password are required.",
          });
      }

      const tokenHash =
        createHash(
          "sha256"
        )
          .update(
            token
          )
          .digest(
            "hex"
          );

      const resets =
        await readJson(
          RESET_FILE,
          {}
        );

      const item =
        resets[
          tokenHash
        ];

      if (
        !item ||
        item.used ||
        Date.now() >
          Number(
            item.expiresAt ||
              0
          )
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "RESET_TOKEN_INVALID",
            message:
              "This password-reset link is invalid or expired.",
          });
      }

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      const user =
        users[
          item.userId
        ];

      if (!user) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "USER_NOT_FOUND",
          });
      }

      const credentials =
        hashPassword(
          password
        );

      user.salt =
        credentials.salt;

      user.passwordHash =
        credentials.hash;

      users[user.id] =
        user;

      await writeJson(
        USERS_FILE,
        users
      );

      item.used = true;
      resets[tokenHash] =
        item;

      await writeJson(
        RESET_FILE,
        resets
      );

      await invalidateUserSessions(
        user.id
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
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/auth/reset-password",
        }
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "RESET_FAILED",
          message:
            "Unable to reset the password.",
        });
    }
  }
);

app.get(
  "/reset-password",
  (
    req,
    res
  ) => {
    res
      .type("html")
      .send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI Password Reset</title>
<style>
body{font-family:Arial,sans-serif;background:#08080d;color:#fff;padding:30px}
main{max-width:500px;margin:auto}
.card{background:#171720;padding:25px;border-radius:16px}
input,button{width:100%;padding:13px;margin:7px 0;border-radius:9px;border:1px solid #333;background:#0d0d13;color:#fff}
button{cursor:pointer}
</style>
</head>
<body>
<main>
<div class="card">
<h1>✨ MAMAKI AI</h1>
<h2>Reset Password</h2>
<input id="password" type="password" placeholder="New password">
<button onclick="resetPassword()">Reset Password</button>
<p id="msg"></p>
</div>
</main>
<script>
const token=new URLSearchParams(location.search).get("token")||"";
async function resetPassword(){
  const password=document.getElementById("password").value;
  const r=await fetch("/api/auth/reset-password",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({token,password})
  });
  const d=await r.json();
  document.getElementById("msg").textContent=d.message||d.error||"Request completed.";
}
</script>
</body>
</html>`);
  }
);

/* =========================================================
   ACCOUNT
========================================================= */

app.get(
  "/api/account",
  requireUser,
  async (
    req,
    res
  ) => {
    const usage =
      await readJson(
        USAGE_FILE,
        {}
      );

    const mine =
      usage[
        req.user.id
      ] || {
        aiGenerations: 0,
        aiSeconds: 0,
        studioJobs: 0,
        narrationJobs: 0,
      };

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
      credits:
        await getUserCredits(
          req.user.id
        ),
      limits: {
        maximumProductionSeconds:
          MAX_DURATION,
        freeStudio: true,
      },
    });
  }
);

app.get(
  "/api/account/credits",
  requireUser,
  async (
    req,
    res
  ) => {
    res.json({
      ok: true,
      credits:
        await getUserCredits(
          req.user.id
        ),
    });
  }
);

app.put(
  "/api/account/profile",
  requireUser,
  async (
    req,
    res
  ) => {
    const users =
      await readJson(
        USERS_FILE,
        {}
      );

    const user =
      users[
        req.user.id
      ];

    if (!user) {
      return res
        .status(404)
        .json({
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

app.put(
  "/api/account/password",
  requireUser,
  async (
    req,
    res
  ) => {
    try {
      const current =
        String(
          req.body.currentPassword ||
            ""
        );

      const next =
        String(
          req.body.newPassword ||
            ""
        );

      if (
        next.length < 6
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "PASSWORD_TOO_SHORT",
          });
      }

      if (
        !verifyPassword(
          current,
          req.user.salt,
          req.user.passwordHash
        )
      ) {
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "CURRENT_PASSWORD_INVALID",
          });
      }

      const users =
        await readJson(
          USERS_FILE,
          {}
        );

      const user =
        users[
          req.user.id
        ];

      if (!user) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "USER_NOT_FOUND",
          });
      }

      const credentials =
        hashPassword(
          next
        );

      user.salt =
        credentials.salt;

      user.passwordHash =
        credentials.hash;

      users[user.id] =
        user;

      await writeJson(
        USERS_FILE,
        users
      );

      await invalidateUserSessions(
        user.id
      );

      await recordSecurityEvent(
        "PASSWORD_CHANGED",
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
          "Password changed successfully. Please log in again.",
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/account/password",
        }
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "PASSWORD_CHANGE_FAILED",
        });
    }
  }
);

/* =========================================================
   AI PROMPT ENHANCEMENT
========================================================= */

app.post(
  "/api/ai/enhance",
  async (
    req,
    res
  ) => {
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
      return res
        .status(400)
        .json({
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
  async (
    req,
    res
  ) => {
    try {
      const user =
        await getCurrentUser(
          req
        );

      if (!user) {
        return res
          .status(401)
          .json({
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
        return res
          .status(503)
          .json({
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
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "PROMPT_REQUIRED",
            message:
              "Describe the video you want to create.",
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
        cancelled:
          false,
      };

      jobs.set(
        jobId,
        job
      );

      res
        .status(202)
        .json({
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
                    req.file?.buffer ||
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

      res
        .status(500)
        .json({
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
  async (
    req,
    res
  ) => {
    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return res
        .status(404)
        .json({
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
      return res
        .status(403)
        .json({
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
  async (
    req,
    res
  ) => {
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
   PROJECT WORKSPACE
========================================================= */

app.get(
  "/api/projects",
  requireUser,
  async (
    req,
    res
  ) => {
    const all =
      await getAllProjects();

    const mine =
      all.filter(
        (project) =>
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
  async (
    req,
    res
  ) => {
    const id =
      safeFileName(
        req.params.id
      );

    const file =
      path.join(
        PROJECTS,
        `${id}.json`
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
        return res
          .status(403)
          .json({
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
      res
        .status(404)
        .json({
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
  async (
    req,
    res
  ) => {
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

      res
        .status(500)
        .json({
          ok: false,
          error:
            "PROJECT_SAVE_FAILED",
          message:
            "Unable to save project.",
        });
    }
  }
);

app.delete(
  "/api/projects/:id",
  requireUser,
  async (
    req,
    res
  ) => {
    const id =
      safeFileName(
        req.params.id
      );

    const file =
      path.join(
        PROJECTS,
        `${id}.json`
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
        return res
          .status(403)
          .json({
            ok: false,
            error:
              "PROJECT_ACCESS_DENIED",
          });
      }

      await fs.unlink(
        file
      );

      res.json({
        ok: true,
        message:
          "Project deleted.",
      });
    } catch {
      res
        .status(404)
        .json({
          ok: false,
          error:
            "PROJECT_NOT_FOUND",
        });
    }
  }
);

/* =========================================================
   PHOTO TO VIDEO
========================================================= */

app.post(
  "/api/studio/photo-video",
  upload.array(
    "photos",
    50
  ),
  async (
    req,
    res
  ) => {
    try {
      const user =
        await getCurrentUser(
          req
        );

      const photos =
        req.files || [];

      if (!photos.length) {
        return res
          .status(400)
          .json({
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
          String(
            seconds
          ),
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

      await combineVideoFiles(
        clips,
        combined
      );

      const watermarked =
        path.join(
          OUTPUTS,
          `${id}.mp4`
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

      res
        .status(500)
        .json({
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
  upload.single(
    "video"
  ),
  async (
    req,
    res
  ) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "VIDEO_REQUIRED",
          });
      }

      const start =
        Math.max(
          0,
          Number(
            req.body.start ||
              0
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

      res
        .status(500)
        .json({
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
  async (
    req,
    res
  ) => {
    try {
      const videos =
        req.files || [];

      if (
        videos.length < 2
      ) {
        return res
          .status(400)
          .json({
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

      res
        .status(500)
        .json({
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
  async (
    req,
    res
  ) => {
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
        return res
          .status(400)
          .json({
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

      res
        .status(500)
        .json({
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
  async (
    req,
    res
  ) => {
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

/* =========================================================
   SUBTITLES
========================================================= */

app.post(
  "/api/studio/subtitles",
  upload.single(
    "video"
  ),
  async (
    req,
    res
  ) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({
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
        return res
          .status(400)
          .json({
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
          `${id}-input.mp4`
        );

      const subtitleFile =
        path.join(
          TMP,
          `${id}.srt`
        );

      const subtitled =
        path.join(
          OUTPUTS,
          `${id}-subtitled.mp4`
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
        `subtitles='${escaped}'`,
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

      res
        .status(500)
        .json({
          ok: false,
          error:
            "SUBTITLE_FAILED",
          message:
            "Unable to burn subtitles into the video.",
        });
    }
  }
);

/* =========================================================
   SOCIAL EXPORT
========================================================= */

app.post(
  "/api/studio/social",
  upload.single(
    "video"
  ),
  async (
    req,
    res
  ) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({
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

      res
        .status(500)
        .json({
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
   ADMIN LOGIN
========================================================= */

app.post(
  "/api/admin/login",
  async (
    req,
    res
  ) => {
    try {
      if (
        !ADMIN_EMAIL ||
        !ADMIN_PASSWORD
      ) {
        return res
          .status(503)
          .json({
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
          15 *
            60 *
            1000
        )
      ) {
        await recordSecurityEvent(
          "ADMIN_LOGIN_RATE_LIMITED",
          {
            email,
          }
        );

        return res
          .status(429)
          .json({
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
          {
            email,
          }
        );

        return res
          .status(401)
          .json({
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

      /*
        IMPORTANT:
        Find every existing record for the configured
        administrator email and keep ONE permanent
        administrator ID.

        The oldest existing matching account is retained.
        Any accidental duplicate admin records are merged
        into that one account and removed from USERS_FILE.
      */

      const matches =
        Object.values(
          users
        )
          .filter(
            (user) =>
              normalizeEmail(
                user.email
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
        matches[0] ||
        null;

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
          lastActiveAt:
            null,
        };

        users[id] =
          admin;

        restored = true;
      } else {
        if (
          admin.role !==
          "admin"
        ) {
          admin.role =
            "admin";
          restored = true;
        }

        if (
          admin.disabled
        ) {
          admin.disabled =
            false;
          restored = true;
        }

        if (
          !admin.salt ||
          !admin.passwordHash
        ) {
          const credentials =
            hashPassword(
              ADMIN_PASSWORD
            );

          admin.salt =
            credentials.salt;

          admin.passwordHash =
            credentials.hash;

          restored = true;
        }

        /*
          The master Render credentials remain authoritative.
          We do not generate a new ID.
        */
        users[
          admin.id
        ] = admin;

        /*
          Remove accidental duplicate records for the same
          configured admin email while preserving the oldest ID.
        */
        for (
          const duplicate of
            matches.slice(1)
        ) {
          if (
            duplicate.id &&
            duplicate.id !==
              admin.id
          ) {
            delete users[
              duplicate.id
            ];
          }
        }
      }

      admin.lastLoginAt =
        new Date().toISOString();

      admin.lastActiveAt =
        admin.lastLoginAt;

      users[admin.id] =
        admin;

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
          credits:
            await getUserCredits(
              admin.id
            ),
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

      res
        .status(500)
        .json({
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
  async (
    req,
    res
  ) => {
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

    const now =
      Date.now();

    const day =
      24 * 60 * 60 * 1000;

    const newToday =
      userList.filter(
        (user) =>
          Date.parse(
            user.createdAt ||
              ""
          ) >
          now - day
      ).length;

    const newWeek =
      userList.filter(
        (user) =>
          Date.parse(
            user.createdAt ||
              ""
          ) >
          now - 7 * day
      ).length;

    const newMonth =
      userList.filter(
        (user) =>
          Date.parse(
            user.createdAt ||
              ""
          ) >
          now - 30 * day
      ).length;

    const activeUsers =
      userList.filter(
        (user) =>
          !user.disabled &&
          user.lastActiveAt &&
          now -
            Date.parse(
              user.lastActiveAt
            ) <
            15 *
              60 *
              1000
      ).length;

    const completedJobs =
      jobList.filter(
        (job) =>
          job.status ===
          "completed"
      ).length;

    const processingJobs =
      jobList.filter(
        (job) =>
          job.status ===
          "processing" ||
          job.status ===
            "queued"
      ).length;

    const failedJobs =
      jobList.filter(
        (job) =>
          job.status ===
          "failed"
      ).length;

    const adminCount =
      userList.filter(
        (user) =>
          user.role ===
          "admin"
      ).length;

    res.json({
      ok: true,
      stats: {
        version:
          VERSION,

        totalUsers:
          userList.length,

        activeUsers,

        liveUsers:
          activeUsers,

        disabledUsers:
          userList.filter(
            (user) =>
              user.disabled
          ).length,

        newToday,
        newWeek,
        newMonth,

        totalAdmins:
          adminCount,

        totalProjects:
          projects.length,

        aiGenerations,

        aiSeconds,

        studioJobs,

        narrationJobs,

        videosGenerated:
          aiGenerations,

        videosToday:
          0,

        jobsInMemory:
          jobList.length,

        completedJobs,

        processingJobs,

        failedJobs,

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

        ffmpeg:
          Boolean(
            ffmpegPath
          ),

        authentication:
          true,

        storage:
          true,
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
  async (
    req,
    res
  ) => {
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

    const list =
      await Promise.all(
        Object.values(
          users
        ).map(
          async (
            user
          ) => ({
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

            credits:
              await getUserCredits(
                user.id
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
        )
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
  async (
    req,
    res
  ) => {
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
      return res
        .status(404)
        .json({
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
        lastActiveAt:
          user.lastActiveAt ||
          null,
        credits:
          await getUserCredits(
            user.id
          ),
      },
      usage:
        usage[
          user.id
        ] || {},
      projects,
    });
  }
);

app.post(
  "/api/admin/users/:id/disable",
  requireAdmin,
  async (
    req,
    res
  ) => {
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
      return res
        .status(404)
        .json({
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
      return res
        .status(400)
        .json({
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
          ? req.body
              .disabled
          : true
      );

    users[user.id] =
      user;

    await writeJson(
      USERS_FILE,
      users
    );

    if (
      user.disabled
    ) {
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
   ADMIN JOBS
========================================================= */

app.get(
  "/api/admin/jobs",
  requireAdmin,
  async (
    req,
    res
  ) => {
    res.json({
      ok: true,
      jobs:
        Array.from(
          jobs.values()
        ).map(
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
            duration:
              job.duration ||
              0,
            creditCost:
              job.creditCost ||
              0,
          })
        ),
    });
  }
);

/* =========================================================
   ADMIN ERRORS
========================================================= */

app.get(
  "/api/admin/errors",
  requireAdmin,
  async (
    req,
    res
  ) => {
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

/* =========================================================
   ADMIN SECURITY
========================================================= */

app.get(
  "/api/admin/security",
  requireAdmin,
  async (
    req,
    res
  ) => {
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
          200
        );

    res.json({
      ok: true,
      events: list,
    });
  }
);

/* =========================================================
   ADMIN CREDITS
========================================================= */

app.get(
  "/api/credits",
  requireUser,
  async (
    req,
    res
  ) => {
    res.json({
      ok: true,
      credits:
        await getUserCredits(
          req.user.id
        ),
    });
  }
);

app.get(
  "/api/admin/credits",
  requireAdmin,
  async (
    req,
    res
  ) => {
    const d =
      await readCredits();

    const summary =
      creditSummary(
        d.transactions
      );

    const balances =
      await Promise.all(
        Object.entries(
          d.users
        ).map(
          async (
            [
              userId,
              credits,
            ]
          ) => {
            const users =
              await readJson(
                USERS_FILE,
                {}
              );

            return {
              userId,
              email:
                users[
                  userId
                ]?.email ||
                null,
              name:
                users[
                  userId
                ]?.name ||
                null,
              credits:
                Number(
                  credits || 0
                ),
            };
          }
        )
      );

    const totalUserCredits =
      balances.reduce(
        (
          total,
          item
        ) =>
          total +
          Number(
            item.credits ||
              0
          ),
        0
      );

    const replicate =
      await getReplicateBalance();

    res.json({
      ok: true,

      mamaki: {
        internalPool:
          Number(
            d.pool || 0
          ),

        totalUserCredits,

        issued:
          summary.issued,

        consumed:
          summary.consumed,

        refunded:
          summary.refunded,

        balances,
      },

      replicate,
    });
  }
);

app.post(
  "/api/admin/users/:id/credits",
  requireAdmin,
  async (
    req,
    res
  ) => {
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
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "USER_NOT_FOUND",
          });
      }

      const amount =
        Math.floor(
          Number(
            req.body.amount ||
              0
          )
        );

      if (
        !Number.isFinite(
          amount
        ) ||
        amount === 0
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "INVALID_CREDIT_AMOUNT",
          });
      }

      if (
        amount > 0
      ) {
        await addUserCredits(
          user.id,
          amount,
          "ADMIN"
        );
      } else {
        const d =
          await readCredits();

        d.users[
          user.id
        ] = Math.max(
          0,
          Number(
            d.users[
              user.id
            ] || 0
          ) + amount
        );

        d.transactions.push({
          id:
            randomUUID(),
          type:
            "DEBIT",
          source:
            "ADMIN",
          userId:
            user.id,
          amount,
          createdAt:
            new Date().toISOString(),
        });

        await writeCredits(
          d
        );
      }

      await recordSecurityEvent(
        "ADMIN_CREDIT_ADJUSTMENT",
        {
          userId:
            user.id,
          email:
            user.email,
          amount,
          adminId:
            req.user.id,
        }
      );

      res.json({
        ok: true,
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
            "/api/admin/users/:id/credits",
        }
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "CREDIT_UPDATE_FAILED",
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
  async (
    req,
    res
  ) => {
    const d =
      await readFinance();

    res.json({
      ok: true,
      summary:
        financeSummary(
          d.transactions
        ),
      transactions:
        d.transactions
          .slice()
          .sort(
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
          )
          .slice(
            0,
            500
          ),
    });
  }
);

app.post(
  "/api/admin/finance",
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      const type =
        cleanText(
          req.body.type,
          50
        ).toUpperCase();

      const amount =
        Number(
          req.body.amount
        );

      if (
        ![
          "REVENUE",
          "REFUND",
          "AI_COST",
          "INFRASTRUCTURE_COST",
          "OTHER_COST",
        ].includes(type) ||
        !Number.isFinite(
          amount
        ) ||
        amount < 0
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "INVALID_FINANCE_ENTRY",
          });
      }

      await addFinanceTransaction(
        type,
        amount,
        req.body.description ||
          ""
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

      const d =
        await readFinance();

      res.json({
        ok: true,
        summary:
          financeSummary(
            d.transactions
          ),
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/admin/finance",
        }
      );

      res
        .status(500)
        .json({
          ok: false,
          error:
            "FINANCE_UPDATE_FAILED",
        });
    }
  }
);

/* =========================================================
   ADMIN ANALYTICS
========================================================= */

app.get(
  "/api/admin/analytics",
  requireAdmin,
  async (
    req,
    res
  ) => {
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

    const security =
      await readJson(
        SECURITY_FILE,
        {}
      );

    const finance =
      await readFinance();

    const credits =
      await readCredits();

    const userList =
      Object.values(
        users
      );

    const totalAi =
      Object.values(
        usage
      ).reduce(
        (
          total,
          item
        ) =>
          total +
          Number(
            item.aiGenerations ||
              0
          ),
        0
      );

    const totalAiSeconds =
      Object.values(
        usage
      ).reduce(
        (
          total,
          item
        ) =>
          total +
          Number(
            item.aiSeconds ||
              0
          ),
        0
      );

    const totalStudio =
      Object.values(
        usage
      ).reduce(
        (
          total,
          item
        ) =>
          total +
          Number(
            item.studioJobs ||
              0
          ),
        0
      );

    const totalNarration =
      Object.values(
        usage
      ).reduce(
        (
          total,
          item
        ) =>
          total +
          Number(
            item.narrationJobs ||
              0
          ),
        0
      );

    const failedSecurity =
      Object.values(
        security
      ).filter(
        (item) =>
          String(
            item.type ||
              ""
          ).includes(
            "FAILED"
          )
      ).length;

    const summary =
      financeSummary(
        finance.transactions
      );

    const creditTotals =
      creditSummary(
        credits.transactions
      );

    res.json({
      ok: true,

      users: {
        total:
          userList.length,

        admins:
          userList.filter(
            (u) =>
              u.role ===
              "admin"
          ).length,

        active:
          userList.filter(
            (u) =>
              !u.disabled
          ).length,

        disabled:
          userList.filter(
            (u) =>
              u.disabled
          ).length,
      },

      usage: {
        aiGenerations:
          totalAi,

        aiSeconds:
          totalAiSeconds,

        studioJobs:
          totalStudio,

        narrationJobs:
          totalNarration,
      },

      credits: {
        issued:
          creditTotals.issued,

        consumed:
          creditTotals.consumed,

        refunded:
          creditTotals.refunded,

        remaining:
          Object.values(
            credits.users
          ).reduce(
            (
              total,
              value
            ) =>
              total +
              Number(
                value || 0
              ),
            0
          ),
      },

      finance:
        summary,

      security: {
        events:
          Object.keys(
            security
          ).length,

        failed:
          failedSecurity,
      },

      provider: {
        configured:
          Boolean(
            REPLICATE_API_TOKEN
          ),
        t2v:
          T2V_MODEL,
        i2v:
          I2V_MODEL,
      },

      system: {
        version:
          VERSION,
        uptime:
          process.uptime(),
        ffmpeg:
          Boolean(
            ffmpegPath
          ),
        authentication:
          true,
        storage:
          true,
        recoveryConfigured:
          Boolean(
            RESEND_API_KEY &&
              RESEND_FROM
          ),
      },
    });
  }
);

/* =========================================================
   ADMIN PAGE
========================================================= */

app.get(
  "/admin",
  (
    req,
    res
  ) => {
    res
      .type("html")
      .send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI Admin</title>
<style>
*{box-sizing:border-box}
body{
  font-family:Arial,sans-serif;
  background:#07070b;
  color:#fff;
  margin:0;
  padding:20px;
}
main{
  max-width:1250px;
  margin:auto;
}
h1,h2,h3{
  margin-top:0;
}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
  gap:12px;
}
.card{
  background:#15151d;
  border:1px solid #292936;
  border-radius:16px;
  padding:16px;
  margin:10px 0;
}
.value{
  font-size:26px;
  font-weight:700;
  margin-top:7px;
}
.small{
  font-size:12px;
}
.muted{
  color:#aaa;
}
.ok{
  color:#7ee787;
}
.bad{
  color:#ff7b72;
}
.warn{
  color:#f2cc60;
}
input,select,button{
  padding:11px;
  border-radius:9px;
  border:1px solid #333;
  background:#0e0e14;
  color:#fff;
  margin:4px;
}
button{
  cursor:pointer;
}
button:hover{
  opacity:.85;
}
.hidden{
  display:none;
}
.scroll{
  overflow:auto;
  max-height:450px;
}
table{
  width:100%;
  border-collapse:collapse;
}
th,td{
  padding:9px;
  border-bottom:1px solid #292936;
  text-align:left;
  font-size:13px;
}
pre{
  white-space:pre-wrap;
  overflow:auto;
  max-height:450px;
  background:#0d0d13;
  padding:14px;
  border-radius:10px;
}
.section-title{
  margin-top:28px;
}
.badge{
  display:inline-block;
  padding:5px 9px;
  border-radius:999px;
  background:#242431;
  font-size:12px;
}
.actions{
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  gap:4px;
}
.status{
  font-weight:bold;
}
</style>
</head>

<body>
<main>

<h1>✨ MAMAKI AI</h1>
<p class="muted">
Administrator Control Center · Private · v${VERSION}
</p>

<section
  id="login"
  class="card"
>
<h2>Administrator Login</h2>

<input
  id="email"
  type="email"
  placeholder="Admin email"
>

<input
  id="password"
  type="password"
  placeholder="Admin password"
>

<button onclick="login()">
Sign in
</button>

<span id="msg"></span>
</section>

<section
  id="dash"
  class="hidden"
>

<div class="actions">
<button onclick="loadAll()">
Refresh Dashboard
</button>

<button onclick="logout()">
Logout
</button>
</div>

<h2 class="section-title">
Overview
</h2>

<div class="grid">

<div class="card">
Total Users
<div
 id="users"
 class="value"
>0</div>
</div>

<div class="card">
Live / Active
<div
 id="active"
 class="value"
>0</div>
</div>

<div class="card">
New Today
<div
 id="today"
 class="value"
>0</div>
</div>

<div class="card">
New This Week
<div
 id="week"
 class="value"
>0</div>
</div>

<div class="card">
New This Month
<div
 id="month"
 class="value"
>0</div>
</div>

<div class="card">
Total Admins
<div
 id="admins"
 class="value"
>0</div>
</div>

<div class="card">
Videos Generated
<div
 id="videos"
 class="value"
>0</div>
</div>

<div class="card">
AI Seconds
<div
 id="seconds"
 class="value"
>0</div>
</div>

<div class="card">
Narrations
<div
 id="narrations"
 class="value"
>0</div>
</div>

<div class="card">
Projects
<div
 id="projects"
 class="value"
>0</div>
</div>

<div class="card">
Completed Jobs
<div
 id="completed"
 class="value"
>0</div>
</div>

<div class="card">
Processing Jobs
<div
 id="processing"
 class="value"
>0</div>
</div>

<div class="card">
Failed Jobs
<div
 id="failed"
 class="value"
>0</div>
</div>

<div class="card">
MAMAKI Credits
<div
 id="credits"
 class="value"
>0</div>
</div>

<div class="card">
Profit NGN
<div
 id="profit"
 class="value"
>₦0</div>
</div>

</div>

<h2 class="section-title">
MAMAKI Credits
</h2>

<div class="grid">

<div class="card">
Credits Issued
<div
 id="issued"
 class="value"
>0</div>
</div>

<div class="card">
Credits Consumed
<div
 id="consumed"
 class="value"
>0</div>
</div>

<div class="card">
Credits Refunded
<div
 id="crefund"
 class="value"
>0</div>
</div>

<div class="card">
Credits Remaining
<div
 id="remaining"
 class="value"
>0</div>
</div>

</div>

<section class="card">
<h3>Manual User Credit Adjustment</h3>

<input
 id="uid"
 placeholder="User ID"
>

<input
 id="amount"
 type="number"
 placeholder="+100 or -100"
>

<button onclick="adjustCredits()">
Apply
</button>

<span id="cmsg"></span>
</section>

<h2 class="section-title">
Replicate & AI Provider
</h2>

<div class="grid">

<div class="card">
Replicate Credit
<div
 id="rep"
 class="value"
>$0.00</div>

<div
 id="repnote"
 class="muted small"
>
No authoritative provider balance available.
</div>
</div>

<div class="card">
Replicate Status
<div
 id="repstatus"
 class="value"
>—</div>
</div>

<div class="card">
T2V Model
<div
 id="t2v"
 class="muted small"
></div>
</div>

<div class="card">
I2V Model
<div
 id="i2v"
 class="muted small"
></div>
</div>

</div>

<h2 class="section-title">
Business & Finance
</h2>

<div class="grid">

<div class="card">
Gross Revenue
<div
 id="gross"
 class="value"
>₦0</div>
</div>

<div class="card">
Refunds
<div
 id="refunds"
 class="value"
>₦0</div>
</div>

<div class="card">
Net Revenue
<div
 id="net"
 class="value"
>₦0</div>
</div>

<div class="card">
Total Costs
<div
 id="costs"
 class="value"
>₦0</div>
</div>

<div class="card">
Profit
<div
 id="profit2"
 class="value"
>₦0</div>
</div>

<div class="card">
Profit Margin
<div
 id="margin"
 class="value"
>0.00%</div>
</div>

</div>

<section class="card">
<h3>Record Real Financial Transaction</h3>

<select id="ftype">
<option value="REVENUE">
Revenue
</option>

<option value="REFUND">
Refund
</option>

<option value="AI_COST">
AI Cost
</option>

<option value="INFRASTRUCTURE_COST">
Infrastructure Cost
</option>

<option value="OTHER_COST">
Other Cost
</option>
</select>

<input
 id="famount"
 type="number"
 step="0.01"
 placeholder="NGN amount"
>

<input
 id="fdesc"
 placeholder="Description"
>

<button onclick="finance()">
Record
</button>

<span id="fmsg"></span>
</section>

<h2 class="section-title">
System Health
</h2>

<div class="grid">

<div class="card">
Server
<div
 id="server"
 class="value ok"
>✓</div>
</div>

<div class="card">
FFmpeg
<div
 id="ffmpeg"
 class="value ok"
>✓</div>
</div>

<div class="card">
Authentication
<div
 id="auth"
 class="value ok"
>✓</div>
</div>

<div class="card">
Storage
<div
 id="storage"
 class="value ok"
>✓</div>
</div>

<div class="card">
Password Recovery
<div
 id="recovery"
 class="value"
>Not configured</div>
</div>

<div class="card">
Uptime
<div
 id="uptime"
 class="value"
>0</div>
</div>

</div>

<h2 class="section-title">
Users
</h2>

<section class="card">
<div class="scroll">
<table>
<thead>
<tr>
<th>Name</th>
<th>Email</th>
<th>Role</th>
<th>Credits</th>
<th>AI</th>
<th>AI Seconds</th>
<th>Studio</th>
<th>Narration</th>
<th>Last Active</th>
<th>Status</th>
</tr>
</thead>

<tbody id="utable"></tbody>
</table>
</div>
</section>

<h2 class="section-title">
Jobs
</h2>

<section class="card">
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
</tr>
</thead>
<tbody id="jobtable"></tbody>
</table>
</div>
</section>

<h2 class="section-title">
Security Activity
</h2>

<section class="card">
<div class="scroll">
<table>
<thead>
<tr>
<th>Time</th>
<th>Event</th>
<th>Email</th>
<th>User</th>
<th>Method</th>
</tr>
</thead>
<tbody id="securitytable"></tbody>
</table>
</div>
</section>

<h2 class="section-title">
Errors
</h2>

<section class="card">
<div class="scroll">
<table>
<thead>
<tr>
<th>Time</th>
<th>Code</th>
<th>Message</th>
<th>Route</th>
</tr>
</thead>
<tbody id="errortable"></tbody>
</table>
</div>
</section>

<h2 class="section-title">
Financial Transactions
</h2>

<section class="card">
<div class="scroll">
<table>
<thead>
<tr>
<th>Time</th>
<th>Type</th>
<th>Amount</th>
<th>Description</th>
</tr>
</thead>
<tbody id="financetable"></tbody>
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
  (id) =>
    document.getElementById(
      id
    );

const hdr =
  () => ({
    Authorization:
      "Bearer " +
      token
  });

async function get(
  url
) {
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

  if (
    !response.ok ||
    !data.ok
  ) {
    throw new Error(
      data.message ||
      data.error ||
      "Request failed."
    );
  }

  return data;
}

function esc(
  value
) {
  return String(
    value ??
      ""
  ).replace(
    /[&<>"']/g,
    function(
      match
    ) {
      return {
        "&":
          "&amp;",
        "<":
          "&lt;",
        ">":
          "&gt;",
        '"':
          "&quot;",
        "'":
          "&#039;"
      }[match];
    }
  );
}

function money(
  value
) {
  return (
    "₦" +
    Number(
      value || 0
    ).toLocaleString(
      undefined,
      {
        maximumFractionDigits:
          2
      }
    )
  );
}

function dateText(
  value
) {
  if (!value) {
    return "-";
  }

  const d =
    new Date(
      value
    );

  if (
    Number.isNaN(
      d.getTime()
    )
  ) {
    return String(
      value
    );
  }

  return d.toLocaleString();
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
        data.error ||
        "Invalid administrator credentials."
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

    $("msg")
      .textContent =
      "";

    await loadAll();
  } catch (
    error
  ) {
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
  if (!token) {
    return;
  }

  try {
    const [
      stats,
      users,
      jobs,
      errors,
      security,
      credits,
      finance
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
        )
      ]);

    const st =
      stats.stats;

    $("users")
      .textContent =
      st.totalUsers;

    $("active")
      .textContent =
      st.activeUsers;

    $("today")
      .textContent =
      st.newToday;

    $("week")
      .textContent =
      st.newWeek;

    $("month")
      .textContent =
      st.newMonth;

    $("admins")
      .textContent =
      st.totalAdmins;

    $("videos")
      .textContent =
      st.videosGenerated;

    $("seconds")
      .textContent =
      st.aiSeconds;

    $("narrations")
      .textContent =
      st.narrationJobs;

    $("projects")
      .textContent =
      st.totalProjects;

    $("completed")
      .textContent =
      st.completedJobs;

    $("processing")
      .textContent =
      st.processingJobs;

    $("failed")
      .textContent =
      st.failedJobs;

    $("credits")
      .textContent =
      credits
        .mamaki
        .totalUserCredits;

    $("remaining")
      .textContent =
      credits
        .mamaki
        .totalUserCredits;

    $("issued")
      .textContent =
      credits
        .mamaki
        .issued;

    $("consumed")
      .textContent =
      credits
        .mamaki
        .consumed;

    $("crefund")
      .textContent =
      credits
        .mamaki
        .refunded;

    const fs =
      finance.summary;

    $("gross")
      .textContent =
      money(
        fs.grossRevenue
      );

    $("refunds")
      .textContent =
      money(
        fs.refunds
      );

    $("net")
      .textContent =
      money(
        fs.netRevenue
      );

    $("costs")
      .textContent =
      money(
        fs.costs
      );

    $("profit")
      .textContent =
      money(
        fs.profit
      );

    $("profit2")
      .textContent =
      money(
        fs.profit
      );

    $("margin")
      .textContent =
      Number(
        fs.profitMargin ||
          0
      ).toFixed(
        2
      ) +
      "%";

    $("rep")
      .textContent =
      "$" +
      Number(
        credits
          .replicate
          .balance ||
          0
      ).toFixed(
        2
      );

    $("repnote")
      .textContent =
      credits
        .replicate
        .balanceKnown
        ? "Actual provider balance."
        : "No authoritative provider balance available; showing $0.00.";

    $("repstatus")
      .textContent =
      credits
        .replicate
        .configured
        ? "Configured"
        : "Not configured";

    $("t2v")
      .textContent =
      st.t2v ||
      "${T2V_MODEL}";

    $("i2v")
      .textContent =
      st.i2v ||
      "${I2V_MODEL}";

    $("server")
      .textContent =
      "✓ Healthy";

    $("ffmpeg")
      .textContent =
      st.ffmpeg
        ? "✓ Ready"
        : "✕";

    $("auth")
      .textContent =
      st.authentication
        ? "✓ Active"
        : "✕";

    $("storage")
      .textContent =
      st.storage
        ? "✓ Healthy"
        : "✕";

    $("recovery")
      .textContent =
      st.recoveryConfigured
        ? "✓ Configured"
        : "Not configured";

    $("uptime")
      .textContent =
      Number(
        st.uptime || 0
      ).toFixed(
        0
      ) +
      " sec";

    $("utable")
      .innerHTML =
      (users.users ||
        [])
        .map(
          function(
            user
          ) {
            const usage =
              user.usage ||
              {};

            return (
              "<tr>" +
              "<td>" +
              esc(
                user.name
              ) +
              "</td>" +
              "<td>" +
              esc(
                user.email
              ) +
              "</td>" +
              "<td>" +
              esc(
                user.role
              ) +
              "</td>" +
              "<td>" +
              Number(
                user.credits ||
                  0
              ) +
              "</td>" +
              "<td>" +
              Number(
                usage.aiGenerations ||
                  0
              ) +
              "</td>" +
              "<td>" +
              Number(
                usage.aiSeconds ||
                  0
              ) +
              "</td>" +
              "<td>" +
              Number(
                usage.studioJobs ||
                  0
              ) +
              "</td>" +
              "<td>" +
              Number(
                usage.narrationJobs ||
                  0
              ) +
              "</td>" +
              "<td>" +
              esc(
                dateText(
                  user.lastActiveAt
                )
              ) +
              "</td>" +
              "<td>" +
              (
                user.disabled
                  ? '<span class="bad">Disabled</span>'
                  : '<span class="ok">Active</span>'
              ) +
              "</td>" +
              "</tr>"
            );
          }
        )
        .join("");

    $("jobtable")
      .innerHTML =
      (jobs.jobs ||
        [])
        .map(
          function(
            job
          ) {
            return (
              "<tr>" +
              "<td>" +
              esc(
                job.id
              ) +
              "</td>" +
              "<td>" +
              esc(
                job.userId
              ) +
              "</td>" +
              "<td>" +
              esc(
                job.status
              ) +
              "</td>" +
              "<td>" +
              Number(
                job.progress ||
                  0
              ) +
              "%</td>" +
              "<td>" +
              Number(
                job.duration ||
                  0
              ) +
              "s</td>" +
              "<td>" +
              Number(
                job.creditCost ||
                  0
              ) +
              "</td>" +
              "<td>" +
              esc(
                job.message
              ) +
              "</td>" +
              "</tr>"
            );
          }
        )
        .join("");

    $("securitytable")
      .innerHTML =
      (security.events ||
        [])
        .map(
          function(
            event
          ) {
            return (
              "<tr>" +
              "<td>" +
              esc(
                dateText(
                  event.createdAt
                )
              ) +
              "</td>" +
              "<td>" +
              esc(
                event.type
              ) +
              "</td>" +
              "<td>" +
              esc(
                event.email
              ) +
              "</td>" +
              "<td>" +
              esc(
                event.userId
              ) +
              "</td>" +
              "<td>" +
              esc(
                event.method
              ) +
              "</td>" +
              "</tr>"
            );
          }
        )
        .join("");

    $("errortable")
      .innerHTML =
      (errors.errors ||
        [])
        .map(
          function(
            error
          ) {
            const route =
              error
                .context
                ?.route ||
              "";

            return (
              "<tr>" +
              "<td>" +
              esc(
                dateText(
                  error.createdAt
                )
              ) +
              "</td>" +
              "<td>" +
              esc(
                error.code
              ) +
              "</td>" +
              "<td>" +
              esc(
                error.message
              ) +
              "</td>" +
              "<td>" +
              esc(
                route
              ) +
              "</td>" +
              "</tr>"
            );
          }
        )
        .join("");

    $("financetable")
      .innerHTML =
      (finance.transactions ||
        [])
        .map(
          function(
            transaction
          ) {
            return (
              "<tr>" +
              "<td>" +
              esc(
                dateText(
                  transaction.createdAt
                )
              ) +
              "</td>" +
              "<td>" +
              esc(
                transaction.type
              ) +
              "</td>" +
              "<td>" +
              money(
                transaction.amount
              ) +
              "</td>" +
              "<td>" +
              esc(
                transaction.description
              ) +
              "</td>" +
              "</tr>"
            );
          }
        )
        .join("");
  } catch (
    error
  ) {
    $("msg")
      .textContent =
      error.message;
  }
}

async function adjustCredits() {
  try {
    const userId =
      $("uid")
        .value
        .trim();

    const amount =
      Number(
        $("amount")
          .value
      );

    if (!userId) {
      $("cmsg")
        .textContent =
        "Enter a user ID.";

      return;
    }

    if (
      !Number.isFinite(
        amount
      ) ||
      amount === 0
    ) {
      $("cmsg")
        .textContent =
        "Enter a non-zero credit adjustment.";

      return;
    }

    const response =
      await fetch(
        "/api/admin/users/" +
          encodeURIComponent(
            userId
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
              amount
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
          data.error ||
          "Unable to update credits.";

    await loadAll();
  } catch (
    error
  ) {
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
        ? "Recorded successfully."
        : data.message ||
          data.error ||
          "Unable to record transaction.";

    await loadAll();
  } catch (
    error
  ) {
    $("fmsg")
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

  loadAll();
}
</script>

</main>
</body>
</html>`);
  }
);

/* =========================================================
   ACCOUNT PAGE
========================================================= */

app.get(
  "/account",
  (
    req,
    res
  ) => {
    res
      .type("html")
      .send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI Account</title>
<style>
body{
  font-family:Arial,sans-serif;
  background:#0b0b10;
  color:#fff;
  padding:30px
}
main{
  max-width:760px;
  margin:auto
}
section{
  background:#171720;
  padding:22px;
  border-radius:16px;
  margin:15px 0
}
input,button{
  padding:12px;
  border-radius:10px;
  border:0;
  margin:5px 0
}
button{
  cursor:pointer
}
pre{
  white-space:pre-wrap
}
</style>
</head>
<body>
<main>

<h1>✨ MAMAKI AI</h1>

<p>Personal Account</p>

<section>
<h2>Login</h2>

<input
 id="email"
 type="email"
 placeholder="Email"
>

<br>

<input
 id="password"
 type="password"
 placeholder="Password"
>

<br>

<button onclick="login()">
Login
</button>

<button onclick="logout()">
Logout
</button>

<p id="msg"></p>
</section>

<section>
<h2>📊 Usage</h2>
<pre id="usage">
Log in to view your usage.
</pre>
</section>

<section>
<h2>💳 Credits</h2>
<pre id="credits">
Log in to view your credits.
</pre>
</section>

<section>
<h2>📁 My Projects</h2>
<pre id="projects">
Log in to load projects.
</pre>
</section>

</main>

<script>
let token =
  localStorage.getItem(
    "mamaki_token"
  ) || "";

const msg =
  document.getElementById(
    "msg"
  );

async function login() {
  const r =
    await fetch(
      "/api/auth/login",
      {
        method:
          "POST",
        headers:{
          "Content-Type":
            "application/json"
        },
        body:
          JSON.stringify({
            email:
              document.getElementById(
                "email"
              ).value,
            password:
              document.getElementById(
                "password"
              ).value
          })
      }
    );

  const d =
    await r.json();

  if (d.ok) {
    token =
      d.token;

    localStorage.setItem(
      "mamaki_token",
      token
    );

    msg.textContent =
      "Login successful.";

    load();
  } else {
    msg.textContent =
      d.message ||
      "Login failed.";
  }
}

async function logout() {
  if (token) {
    await fetch(
      "/api/auth/logout",
      {
        method:
          "POST",
        headers:{
          Authorization:
            "Bearer " +
            token
        }
      }
    );
  }

  token = "";

  localStorage.removeItem(
    "mamaki_token"
  );

  msg.textContent =
    "Logged out.";
}

async function load() {
  if (!token) {
    return;
  }

  const headers = {
    Authorization:
      "Bearer " +
      token
  };

  const account =
    await (
      await fetch(
        "/api/account",
        {
          headers
        }
      )
    ).json();

  if (
    account.ok
  ) {
    document.getElementById(
      "usage"
    ).textContent =
      JSON.stringify(
        account.usage,
        null,
        2
      );

    document.getElementById(
      "credits"
    ).textContent =
      String(
        account.credits
      );
  }

  const p =
    await (
      await fetch(
        "/api/projects",
        {
          headers
        }
      )
    ).json();

  if (p.ok) {
    document.getElementById(
      "projects"
    ).textContent =
      JSON.stringify(
        p.projects,
        null,
        2
      );
  }
}

if (token) {
  load();
}
</script>

</body>
</html>`);
  }
);

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  async (
    req,
    res
  ) => {
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
  (
    req,
    res
  ) => {
    res
      .status(404)
      .json({
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

    res
      .status(500)
      .json({
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
   START
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
      `Password recovery configured: ${Boolean(
        RESEND_API_KEY &&
          RESEND_FROM
      )}`
    );
  }
);
