/*
✨ MAMAKI AI VIDEO CREATIVE STUDIO
SERVER VERSION 13.0.0 — 90% PLATFORM FOUNDATION

Includes:
- Text → Video
- Image → Video
- WAN 2.2 Fast
- AI Director / scene planning
- Long-form scene assembly
- FFmpeg processing
- MAMAKI watermark
- Free Studio
- Photo → Video
- Video Trim
- Video Combine
- Audio mixing
- Voice / Narration with Edge TTS
- Subtitles / caption burn-in
- AI Enhance endpoint
- User registration
- User login/logout
- Session authentication
- User profiles
- Per-user projects
- Usage tracking
- Credit ledger foundation
- Admin authentication
- Admin dashboard API
- Admin user management
- Admin project monitoring
- Job monitoring
- Production statistics
- Secure upload validation
- Better error handling
- Replicate credit detection
- Health/status endpoints

IMPORTANT:
AI generation still requires a funded Replicate account.
No application code can bypass Replicate billing/credit limits.
*/

import express from "express";
import multer from "multer";
import Replicate from "replicate";
import { EdgeTTS } from "edge-tts-universal";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const VERSION = "13.0.0";
const APP_NAME = "MAMAKI AI";

const ROOT = process.cwd();
const PUBLIC_DIR = ROOT;
const TMP = path.join(ROOT, "tmp");
const OUTPUT = path.join(ROOT, "outputs");
const PROJECTS = path.join(ROOT, "projects");
const DATA = path.join(ROOT, "data");
const USERS = path.join(DATA, "users.json");
const LEDGER = path.join(DATA, "credits.json");
const JOBS_FILE = path.join(DATA, "job-history.json");

const MAX_UPLOAD_MB = Number(process.env.MAMAKI_MAX_UPLOAD_MB || 100);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const MAX_DURATION = 7200;
const MIN_DURATION = 5;

const T2V_MODEL =
  process.env.MAMAKI_T2V_MODEL ||
  "wan-video/wan-2.2-t2v-fast";

const I2V_MODEL =
  process.env.MAMAKI_I2V_MODEL ||
  "wan-video/wan-2.2-i2v-fast";

const replicate = process.env.REPLICATE_API_TOKEN
  ? new Replicate({
      auth: process.env.REPLICATE_API_TOKEN
    })
  : null;

/*
------------------------------------------------------------
DIRECTORIES
------------------------------------------------------------
*/

await Promise.all([
  fs.mkdir(TMP, { recursive: true }),
  fs.mkdir(OUTPUT, { recursive: true }),
  fs.mkdir(PROJECTS, { recursive: true }),
  fs.mkdir(DATA, { recursive: true })
]);

/*
------------------------------------------------------------
DEFAULT DATA
------------------------------------------------------------
*/

async function ensureJsonFile(file, fallback) {
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

await ensureJsonFile(USERS, []);
await ensureJsonFile(LEDGER, []);
await ensureJsonFile(JOBS_FILE, []);

/*
------------------------------------------------------------
EXPRESS
------------------------------------------------------------
*/

app.disable("x-powered-by");

app.use(express.json({
  limit: "5mb"
}));

app.use(express.urlencoded({
  extended: true,
  limit: "5mb"
}));

app.use((req, res, next) => {
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

  next();
});

/*
------------------------------------------------------------
UPLOAD
------------------------------------------------------------
*/

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 30
  }
});

/*
------------------------------------------------------------
IN-MEMORY SESSIONS
------------------------------------------------------------
*/

const sessions = new Map();

/*
------------------------------------------------------------
BACKGROUND JOBS
------------------------------------------------------------
*/

const jobs = new Map();

/*
------------------------------------------------------------
UTILITY
------------------------------------------------------------
*/

function now() {
  return new Date().toISOString();
}

function safeString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  return String(value).trim();
}

function clampNumber(value, min, max, fallback) {
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
  return clampNumber(
    value,
    MIN_DURATION,
    MAX_DURATION,
    5
  );
}

function normalizeRatio(value) {
  const allowed = [
    "16:9",
    "9:16",
    "1:1"
  ];

  return allowed.includes(value)
    ? value
    : "16:9";
}

function normalizeQuality(value) {
  return value === "Cinematic"
    ? "Cinematic"
    : "Standard HD";
}

function normalizeStyle(value) {
  return safeString(
    value,
    "Cinematic"
  ).slice(0, 80);
}

function randomId(prefix = "") {
  return `${prefix}${randomUUID()}`;
}

function basenameSafe(file) {
  return path.basename(file);
}

function filePathSafe(file) {
  return path.join(
    OUTPUT,
    basenameSafe(file)
  );
}

function isVideoFile(name) {
  return /\.(mp4|mov|webm|mkv|avi)$/i.test(name);
}

function isImageFile(name) {
  return /\.(jpg|jpeg|png|webp)$/i.test(name);
}

function isAudioFile(name) {
  return /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(name);
}

/*
------------------------------------------------------------
JSON DATABASE HELPERS
------------------------------------------------------------
*/

let dbWriteQueue = Promise.resolve();

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(
      file,
      "utf8"
    );

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  dbWriteQueue = dbWriteQueue.then(async () => {
    const temporary = `${file}.${process.pid}.tmp`;

    await fs.writeFile(
      temporary,
      JSON.stringify(
        data,
        null,
        2
      ),
      "utf8"
    );

    await fs.rename(
      temporary,
      file
    );
  });

  return dbWriteQueue;
}

/*
------------------------------------------------------------
PASSWORD HASHING
------------------------------------------------------------
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
    const [salt, originalHash] =
      String(stored).split(":");

    if (!salt || !originalHash) {
      return false;
    }

    const hash = scryptSync(
      password,
      salt,
      64
    );

    const original = Buffer.from(
      originalHash,
      "hex"
    );

    if (hash.length !== original.length) {
      return false;
    }

    return timingSafeEqual(
      hash,
      original
    );
  } catch {
    return false;
  }
}

/*
------------------------------------------------------------
USER HELPERS
------------------------------------------------------------
*/

function publicUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    plan: user.plan,
    credits: Number(user.credits || 0),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
    status: user.status || "active"
  };
}

async function findUserByEmail(email) {
  const users = await readJson(
    USERS,
    []
  );

  const normalized = safeString(
    email
  ).toLowerCase();

  return users.find(
    u =>
      String(u.email).toLowerCase() ===
      normalized
  );
}

async function findUserById(id) {
  const users = await readJson(
    USERS,
    []
  );

  return users.find(
    u => u.id === id
  );
}

async function saveUser(user) {
  const users = await readJson(
    USERS,
    []
  );

  const index = users.findIndex(
    u => u.id === user.id
  );

  if (index === -1) {
    users.push(user);
  } else {
    users[index] = user;
  }

  await writeJson(
    USERS,
    users
  );

  return user;
}

async function updateUser(id, patch) {
  const users = await readJson(
    USERS,
    []
  );

  const index = users.findIndex(
    u => u.id === id
  );

  if (index === -1) {
    return null;
  }

  users[index] = {
    ...users[index],
    ...patch,
    updatedAt: now()
  };

  await writeJson(
    USERS,
    users
  );

  return users[index];
}

/*
------------------------------------------------------------
AUTH MIDDLEWARE
------------------------------------------------------------
*/

function getToken(req) {
  const auth =
    req.headers.authorization || "";

  if (auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }

  const cookie =
    req.headers.cookie || "";

  const match =
    cookie.match(
      /mamaki_session=([^;]+)/
    );

  return match
    ? match[1]
    : null;
}

async function authenticate(req, res, next) {
  const token = getToken(req);

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "Authentication required.",
      errorCode: "AUTH_REQUIRED"
    });
  }

  const session = sessions.get(token);

  if (!session) {
    return res.status(401).json({
      ok: false,
      error: "Session expired. Please login again.",
      errorCode: "SESSION_EXPIRED"
    });
  }

  if (
    session.expiresAt <
    Date.now()
  ) {
    sessions.delete(token);

    return res.status(401).json({
      ok: false,
      error: "Session expired.",
      errorCode: "SESSION_EXPIRED"
    });
  }

  const user =
    await findUserById(
      session.userId
    );

  if (!user) {
    sessions.delete(token);

    return res.status(401).json({
      ok: false,
      error: "Account no longer exists.",
      errorCode: "USER_NOT_FOUND"
    });
  }

  if (
    user.status &&
    user.status !== "active"
  ) {
    return res.status(403).json({
      ok: false,
      error: "This account is not active.",
      errorCode: "ACCOUNT_DISABLED"
    });
  }

  req.user = user;
  req.sessionToken = token;

  next();
}

async function requireAdmin(req, res, next) {
  await authenticate(
    req,
    res,
    () => {
      if (
        req.user.role !== "admin"
      ) {
        return res.status(403).json({
          ok: false,
          error: "Administrator access required.",
          errorCode: "ADMIN_REQUIRED"
        });
      }

      next();
    }
  );
}

/*
------------------------------------------------------------
AUTH ROUTES
------------------------------------------------------------
*/

app.post(
  "/api/auth/register",
  async (req, res) => {
    try {
      const name = safeString(
        req.body.name
      );

      const email = safeString(
        req.body.email
      ).toLowerCase();

      const password =
        safeString(
          req.body.password
        );

      if (
        name.length < 2 ||
        name.length > 80
      ) {
        return res.status(400).json({
          ok: false,
          error: "Please provide a valid name."
        });
      }

      if (
        !email.includes("@") ||
        email.length > 180
      ) {
        return res.status(400).json({
          ok: false,
          error: "Please provide a valid email."
        });
      }

      if (
        password.length < 8
      ) {
        return res.status(400).json({
          ok: false,
          error: "Password must contain at least 8 characters."
        });
      }

      const existing =
        await findUserByEmail(
          email
        );

      if (existing) {
        return res.status(409).json({
          ok: false,
          error: "An account with this email already exists.",
          errorCode: "EMAIL_EXISTS"
        });
      }

      const user = {
        id: randomId("usr_"),
        name,
        email,
        passwordHash:
          hashPassword(password),
        role: "user",
        plan: "free",
        credits: 0,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
        lastLoginAt: null
      };

      await saveUser(user);

      const token =
        createSession(user);

      return res.status(201).json({
        ok: true,
        user: publicUser(user),
        token
      });
    } catch (error) {
      console.error(
        "REGISTER ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "Unable to create account."
      });
    }
  }
);

function createSession(user) {
  const token =
    randomBytes(32)
      .toString("hex");

  sessions.set(
    token,
    {
      userId: user.id,
      createdAt: Date.now(),
      expiresAt:
        Date.now() +
        1000 * 60 * 60 * 24 * 30
    }
  );

  return token;
}

app.post(
  "/api/auth/login",
  async (req, res) => {
    try {
      const email =
        safeString(
          req.body.email
        ).toLowerCase();

      const password =
        safeString(
          req.body.password
        );

      const user =
        await findUserByEmail(
          email
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
          error: "Invalid email or password.",
          errorCode: "INVALID_LOGIN"
        });
      }

      if (
        user.status &&
        user.status !== "active"
      ) {
        return res.status(403).json({
          ok: false,
          error: "This account is not active.",
          errorCode: "ACCOUNT_DISABLED"
        });
      }

      user.lastLoginAt = now();

      await saveUser(user);

      const token =
        createSession(user);

      return res.json({
        ok: true,
        user: publicUser(user),
        token
      });
    } catch (error) {
      console.error(
        "LOGIN ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "Unable to login."
      });
    }
  }
);

app.post(
  "/api/auth/logout",
  authenticate,
  async (req, res) => {
    sessions.delete(
      req.sessionToken
    );

    res.json({
      ok: true
    });
  }
);

app.get(
  "/api/auth/me",
  authenticate,
  async (req, res) => {
    res.json({
      ok: true,
      user: publicUser(
        req.user
      )
    });
  }
);

app.patch(
  "/api/account/profile",
  authenticate,
  async (req, res) => {
    const patch = {};

    if (req.body.name) {
      patch.name =
        safeString(
          req.body.name
        ).slice(0, 80);
    }

    const user =
      await updateUser(
        req.user.id,
        patch
      );

    res.json({
      ok: true,
      user: publicUser(user)
    });
  }
);

app.patch(
  "/api/account/password",
  authenticate,
  async (req, res) => {
    const currentPassword =
      safeString(
        req.body.currentPassword
      );

    const newPassword =
      safeString(
        req.body.newPassword
      );

    if (
      !verifyPassword(
        currentPassword,
        req.user.passwordHash
      )
    ) {
      return res.status(401).json({
        ok: false,
        error: "Current password is incorrect."
      });
    }

    if (
      newPassword.length < 8
    ) {
      return res.status(400).json({
        ok: false,
        error: "New password must contain at least 8 characters."
      });
    }

    const user =
      await updateUser(
        req.user.id,
        {
          passwordHash:
            hashPassword(
              newPassword
            )
        }
      );

    res.json({
      ok: true,
      message:
        "Password updated successfully."
    });
  }
);

/*
------------------------------------------------------------
CREDITS / USAGE
------------------------------------------------------------
*/

async function addLedgerEntry({
  userId,
  type,
  amount,
  reason,
  metadata = {}
}) {
  const ledger =
    await readJson(
      LEDGER,
      []
    );

  ledger.push({
    id: randomId("led_"),
    userId,
    type,
    amount,
    reason,
    metadata,
    createdAt: now()
  });

  await writeJson(
    LEDGER,
    ledger
  );
}

async function changeCredits(
  userId,
  amount,
  reason,
  metadata = {}
) {
  const user =
    await findUserById(
      userId
    );

  if (!user) {
    throw new Error(
      "User not found"
    );
  }

  const current =
    Number(user.credits || 0);

  const next =
    Math.max(
      0,
      current + Number(amount)
    );

  await updateUser(
    user.id,
    {
      credits: next
    }
  );

  await addLedgerEntry({
    userId: user.id,
    type:
      Number(amount) >= 0
        ? "credit"
        : "debit",
    amount:
      Number(amount),
    reason,
    metadata
  });

  return next;
}

async function recordUsage(
  userId,
  details
) {
  await addLedgerEntry({
    userId,
    type: "usage",
    amount: 0,
    reason: "AI production usage",
    metadata: details
  });
}

app.get(
  "/api/account/usage",
  authenticate,
  async (req, res) => {
    const ledger =
      await readJson(
        LEDGER,
        []
      );

    const own =
      ledger.filter(
        x =>
          x.userId ===
          req.user.id
      );

    const creditsAdded =
      own
        .filter(
          x =>
            x.type === "credit"
        )
        .reduce(
          (sum, x) =>
            sum + Number(x.amount || 0),
          0
        );

    const creditsUsed =
      Math.abs(
        own
          .filter(
            x =>
              x.type === "debit"
          )
          .reduce(
            (sum, x) =>
              sum + Number(x.amount || 0),
            0
          )
      );

    res.json({
      ok: true,
      credits:
        Number(req.user.credits || 0),
      creditsAdded,
      creditsUsed,
      entries:
        own.slice(-100).reverse()
    });
  }
);

/*
------------------------------------------------------------
PROJECTS
------------------------------------------------------------
*/

function projectPublic(project) {
  return {
    id: project.id,
    userId: project.userId,
    name: project.name,
    type: project.type,
    duration: project.duration,
    ratio: project.ratio,
    status: project.status,
    videoUrl: project.videoUrl || null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
}

async function saveProjectRecord(project) {
  const projects =
    await readJson(
      PROJECTS_DB(),
      []
    );

  const index =
    projects.findIndex(
      p =>
        p.id === project.id
    );

  if (index === -1) {
    projects.push(project);
  } else {
    projects[index] = project;
  }

  await writeJson(
    PROJECTS_DB(),
    projects
  );

  return project;
}

function PROJECTS_DB() {
  return path.join(
    DATA,
    "projects.json"
  );
}

await ensureJsonFile(
  PROJECTS_DB(),
  []
);

app.get(
  "/api/projects",
  authenticate,
  async (req, res) => {
    const projects =
      await readJson(
        PROJECTS_DB(),
        []
      );

    const own =
      projects
        .filter(
          p =>
            p.userId ===
            req.user.id
        )
        .sort(
          (a, b) =>
            new Date(b.updatedAt || b.createdAt) -
            new Date(a.updatedAt || a.createdAt)
        );

    res.json({
      ok: true,
      projects:
        own.map(projectPublic)
    });
  }
);

app.get(
  "/api/projects/:id",
  authenticate,
  async (req, res) => {
    const projects =
      await readJson(
        PROJECTS_DB(),
        []
      );

    const project =
      projects.find(
        p =>
          p.id ===
            req.params.id &&
          p.userId ===
            req.user.id
      );

    if (!project) {
      return res.status(404).json({
        ok: false,
        error: "Project not found."
      });
    }

    res.json({
      ok: true,
      project
    });
  }
);

app.post(
  "/api/projects/save",
  authenticate,
  async (req, res) => {
    const project = {
      id:
        safeString(
          req.body.id
        ) ||
        randomId("project_"),

      userId:
        req.user.id,

      name:
        safeString(
          req.body.name,
          "Untitled MAMAKI Production"
        ).slice(0, 150),

      type:
        safeString(
          req.body.type,
          "video"
        ).slice(0, 50),

      duration:
        normalizeDuration(
          req.body.duration
        ),

      ratio:
        normalizeRatio(
          req.body.ratio
        ),

      status:
        safeString(
          req.body.status,
          "completed"
        ),

      prompt:
        safeString(
          req.body.prompt
        ).slice(0, 10000),

      style:
        normalizeStyle(
          req.body.style
        ),

      videoUrl:
        safeString(
          req.body.videoUrl
        ),

      metadata:
        req.body.metadata || {},

      createdAt:
        req.body.createdAt ||
        now(),

      updatedAt:
        now()
    };

    await saveProjectRecord(
      project
    );

    res.json({
      ok: true,
      project:
        projectPublic(project)
    });
  }
);

app.delete(
  "/api/projects/:id",
  authenticate,
  async (req, res) => {
    const projects =
      await readJson(
        PROJECTS_DB(),
        []
      );

    const project =
      projects.find(
        p =>
          p.id ===
            req.params.id &&
          p.userId ===
            req.user.id
      );

    if (!project) {
      return res.status(404).json({
        ok: false,
        error: "Project not found."
      });
    }

    const remaining =
      projects.filter(
        p =>
          p.id !==
          req.params.id
      );

    await writeJson(
      PROJECTS_DB(),
      remaining
    );

    res.json({
      ok: true,
      message:
        "Project deleted."
    });
  }
);

/*
------------------------------------------------------------
FFMPEG
------------------------------------------------------------
*/

function runFFmpeg(
  args,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {
      const child =
        spawn(
          ffmpegPath,
          args,
          {
            windowsHide: true,
            ...options
          }
        );

      let stdout = "";
      let stderr = "";

      child.stdout?.on(
        "data",
        chunk => {
          stdout +=
            chunk.toString();
        }
      );

      child.stderr?.on(
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
            resolve({
              stdout,
              stderr
            });
          } else {
            const error =
              new Error(
                `FFmpeg exited with code ${code}`
              );

            error.stderr =
              stderr.slice(-12000);

            reject(error);
          }
        }
      );
    }
  );
}

/*
------------------------------------------------------------
VIDEO HELPERS
------------------------------------------------------------
*/

async function getVideoDuration(
  input
) {
  try {
    const result =
      await runFFmpeg([
        "-hide_banner",
        "-i",
        input
      ]);

    const match =
      result.stderr.match(
        /Duration:\s*(\d+):(\d+):([\d.]+)/
      );

    if (!match) {
      return 0;
    }

    return (
      Number(match[1]) * 3600 +
      Number(match[2]) * 60 +
      Number(match[3])
    );
  } catch {
    return 0;
  }
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
    "-an",
    output
  ]);

  return output;
}

/*
------------------------------------------------------------
WATERMARK
------------------------------------------------------------
*/

async function addWatermark(
  input,
  output
) {
  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    "drawtext=text='MAMAKI ✨':fontcolor=white@0.88:fontsize=28:box=1:boxcolor=black@0.35:boxborderw=10:x=w-tw-30:y=h-th-25",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-an",
    output
  ]);

  return output;
}

/*
------------------------------------------------------------
SOFT MUSIC
------------------------------------------------------------
*/

async function createSoftMusic(
  seconds,
  output
) {
  const duration =
    clampNumber(
      seconds,
      1,
      MAX_DURATION,
      10
    );

  await runFFmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=220:sample_rate=44100:duration=${duration}`,
    "-af",
    "volume=0.045,afade=t=in:st=0:d=2,afade=t=out:st=" +
      Math.max(
        0,
        duration - 3
      ) +
      ":d=3",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    output
  ]);

  return output;
}

async function mixAudio(
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
    "[1:a]volume=0.35[a]",
    "-map",
    "0:v:0",
    "-map",
    "[a]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-shortest",
    output
  ]);

  return output;
}

/*
------------------------------------------------------------
VOICE / NARRATION
------------------------------------------------------------
*/

const DEFAULT_VOICE =
  process.env.MAMAKI_TTS_VOICE ||
  "en-US-AriaNeural";

async function createNarration(
  text,
  output,
  voice = DEFAULT_VOICE
) {
  const cleanText =
    safeString(
      text
    ).slice(0, 15000);

  if (!cleanText) {
    throw new Error(
      "Narration text is empty."
    );
  }

  const tts =
    new EdgeTTS();

  await tts.synthesize(
    cleanText,
    voice,
    {
      rate:
        safeString(
          process.env.MAMAKI_TTS_RATE,
          "+0%"
        ),
      volume:
        safeString(
          process.env.MAMAKI_TTS_VOLUME,
          "+0%"
        ),
      pitch:
        safeString(
          process.env.MAMAKI_TTS_PITCH,
          "+0Hz"
        )
    }
  );

  const audioBuffer =
    await tts.toBuffer();

  await fs.writeFile(
    output,
    audioBuffer
  );

  return output;
}

app.post(
  "/api/studio/narration",
  authenticate,
  async (req, res) => {
    try {
      const text =
        safeString(
          req.body.text
        );

      const voice =
        safeString(
          req.body.voice,
          DEFAULT_VOICE
        );

      const id =
        randomId("narration_");

      const output =
        path.join(
          OUTPUT,
          `${id}.mp3`
        );

      await createNarration(
        text,
        output,
        voice
      );

      res.json({
        ok: true,
        audioUrl:
          `/api/video/${path.basename(output)}`,
        voice
      });
    } catch (error) {
      console.error(
        "NARRATION ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          "Narration generation failed."
      });
    }
  }
);

/*
------------------------------------------------------------
SUBTITLES
------------------------------------------------------------
*/

function escapeSubtitleText(text) {
  return safeString(
    text
  )
    .replace(
      /\\/g,
      "\\\\"
    )
    .replace(
      /"/g,
      '\\"'
    );
}

async function createAss(
  text,
  output
) {
  const lines =
    safeString(
      text
    )
      .split(/\r?\n/)
      .map(
        x => x.trim()
      )
      .filter(Boolean);

  let current =
    0;

  const duration =
    5;

  let events = "";

  for (
    const line of lines
  ) {
    const start =
      assTime(current);

    const end =
      assTime(
        current + duration
      );

    events +=
      `Dialogue: 0,${start},${end},Default,,0,0,0,,${escapeSubtitleText(line)}\n`;

    current +=
      duration;
  }

  const content = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,46,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,1,0,0,0,100,100,0,0,1,3,1,2,60,60,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}`;

  await fs.writeFile(
    output,
    content,
    "utf8"
  );

  return output;
}

function assTime(seconds) {
  const h =
    Math.floor(
      seconds / 3600
    );

  const m =
    Math.floor(
      (seconds % 3600) / 60
    );

  const s =
    Math.floor(
      seconds % 60
    );

  const cs =
    Math.floor(
      (seconds % 1) * 100
    );

  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

async function burnSubtitles(
  input,
  ass,
  output
) {
  const filter =
    `subtitles='${ass.replace(/'/g, "'\\''")}'`;

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
    "-pix_fmt",
    "yuv420p",
    "-an",
    output
  ]);

  return output;
}

app.post(
  "/api/studio/subtitles",
  authenticate,
  async (req, res) => {
    try {
      const text =
        safeString(
          req.body.text
        );

      if (!text) {
        return res.status(400).json({
          ok: false,
          error:
            "Subtitle text is required."
        });
      }

      const input =
        safeString(
          req.body.video
        );

      const inputPath =
        filePathSafe(
          input
        );

      if (
        !input ||
        !isVideoFile(input) ||
        !fsSync.existsSync(inputPath)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "A valid MAMAKI video is required."
        });
      }

      const id =
        randomId("subtitles_");

      const ass =
        path.join(
          TMP,
          `${id}.ass`
        );

      const output =
        path.join(
          OUTPUT,
          `${id}.mp4`
        );

      await createAss(
        text,
        ass
      );

      await burnSubtitles(
        inputPath,
        ass,
        output
      );

      res.json({
        ok: true,
        videoUrl:
          `/api/video/${path.basename(output)}`
      });
    } catch (error) {
      console.error(
        "SUBTITLE ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          "Subtitle export failed."
      });
    }
  }
);

/*
------------------------------------------------------------
AI ENHANCE
------------------------------------------------------------
*/

app.post(
  "/api/ai/enhance",
  authenticate,
  async (req, res) => {
    const prompt =
      safeString(
        req.body.prompt
      );

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error:
          "Prompt is required."
      });
    }

    const enhanced =
      `Create a professional cinematic production based on this concept: ${prompt}. ` +
      `Use strong visual storytelling, clear subject continuity, natural movement, ` +
      `cinematic composition, realistic lighting, coherent environments, purposeful camera ` +
      `movement, professional pacing, high visual quality, and a polished commercial finish. ` +
      `Avoid unwanted text, distorted anatomy, duplicated subjects, unstable objects, ` +
      `flickering backgrounds, and inconsistent scene continuity.`;

    res.json({
      ok: true,
      original: prompt,
      enhanced
    });
  }
);

/*
------------------------------------------------------------
WAN FRAMES
------------------------------------------------------------
*/

function wanFrames(seconds) {
  return seconds <= 5
    ? 81
    : 121;
}

/*
------------------------------------------------------------
REPLICATE OUTPUT HANDLING
------------------------------------------------------------
*/

async function outputToBuffer(output) {
  if (!output) {
    throw new Error(
      "Model returned no output."
    );
  }

  if (
    Buffer.isBuffer(output)
  ) {
    return output;
  }

  if (
    output instanceof Uint8Array
  ) {
    return Buffer.from(
      output
    );
  }

  if (
    typeof output === "string"
  ) {
    const response =
      await fetch(output);

    if (!response.ok) {
      throw new Error(
        `Unable to download model output: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  if (
    output?.url &&
    typeof output.url ===
      "function"
  ) {
    const url =
      output.url();

    const response =
      await fetch(
        String(url)
      );

    if (!response.ok) {
      throw new Error(
        `Unable to download model output: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  if (
    Array.isArray(output)
  ) {
    for (
      const item of output
    ) {
      try {
        return await outputToBuffer(
          item
        );
      } catch {}
    }
  }

  if (
    typeof output === "object"
  ) {
    if (
      output.url
    ) {
      return await outputToBuffer(
        typeof output.url ===
          "function"
          ? output.url()
          : output.url
      );
    }

    if (
      output.video
    ) {
      return await outputToBuffer(
        output.video
      );
    }

    if (
      output.output
    ) {
      return await outputToBuffer(
        output.output
      );
    }
  }

  throw new Error(
    "Unsupported model output format."
  );
}

/*
------------------------------------------------------------
REPLICATE ERROR CLASSIFICATION
------------------------------------------------------------
*/

function classifyReplicateError(
  error
) {
  const message =
    String(
      error?.message ||
      error ||
      ""
    ).toLowerCase();

  if (
    message.includes(
      "insufficient"
    ) &&
    (
      message.includes(
        "credit"
      ) ||
      message.includes(
        "fund"
      ) ||
      message.includes(
        "balance"
      )
    )
  ) {
    return {
      code:
        "REPLICATE_CREDIT_REQUIRED",
      status: 402,
      message:
        "AI generation requires available credit on the connected Replicate account."
    };
  }

  if (
    message.includes(
      "billing"
    ) ||
    message.includes(
      "payment"
    )
  ) {
    return {
      code:
        "REPLICATE_BILLING_REQUIRED",
      status: 402,
      message:
        "The connected AI provider requires billing before this generation can continue."
    };
  }

  if (
    message.includes(
      "unauthorized"
    ) ||
    message.includes(
      "authentication"
    ) ||
    message.includes(
      "invalid token"
    )
  ) {
    return {
      code:
        "REPLICATE_AUTH_ERROR",
      status: 503,
      message:
        "The AI provider authentication is not configured correctly."
    };
  }

  return {
    code:
      "AI_GENERATION_ERROR",
    status: 500,
    message:
      "AI generation failed. Please try again."
  };
}

/*
------------------------------------------------------------
WAN TEXT → VIDEO
------------------------------------------------------------
*/

async function wanTextToVideo({
  prompt,
  duration,
  ratio,
  quality
}) {
  if (!replicate) {
    const error =
      new Error(
        "REPLICATE_API_TOKEN is not configured."
      );

    error.code =
      "REPLICATE_AUTH_ERROR";

    throw error;
  }

  const frames =
    wanFrames(duration);

  const enhancedPrompt =
    `${prompt}. ` +
    `Visual style: ${quality}. ` +
    `Aspect ratio: ${ratio}. ` +
    `Professional cinematic video, coherent motion, stable camera, detailed environment.`;

  try {
    const result =
      await replicate.run(
        T2V_MODEL,
        {
          input: {
            prompt:
              enhancedPrompt,
            num_frames:
              frames
          }
        }
      );

    return await outputToBuffer(
      result
    );
  } catch (error) {
    const classified =
      classifyReplicateError(
        error
      );

    error.code =
      classified.code;

    error.publicMessage =
      classified.message;

    throw error;
  }
}

/*
------------------------------------------------------------
WAN IMAGE → VIDEO
------------------------------------------------------------
*/

async function wanImageToVideo({
  prompt,
  image,
  duration,
  ratio,
  quality
}) {
  if (!replicate) {
    const error =
      new Error(
        "REPLICATE_API_TOKEN is not configured."
      );

    error.code =
      "REPLICATE_AUTH_ERROR";

    throw error;
  }

  const frames =
    wanFrames(duration);

  const extension =
    image.mimetype ===
      "image/png"
      ? "png"
      : "jpg";

  const dataUrl =
    `data:${image.mimetype};base64,${image.buffer.toString("base64")}`;

  try {
    const result =
      await replicate.run(
        I2V_MODEL,
        {
          input: {
            prompt:
              `${prompt}. Professional cinematic motion. Quality: ${quality}. Ratio: ${ratio}.`,
            image:
              dataUrl,
            num_frames:
              frames
          }
        }
      );

    return await outputToBuffer(
      result
    );
  } catch (error) {
    const classified =
      classifyReplicateError(
        error
      );

    error.code =
      classified.code;

    error.publicMessage =
      classified.message;

    throw error;
  }
}

/*
------------------------------------------------------------
SCENE PLANNING
------------------------------------------------------------
*/

function splitIntoScenes(
  prompt,
  targetSeconds
) {
  const count =
    Math.max(
      1,
      Math.ceil(
        targetSeconds / 5
      )
    );

  const base =
    safeString(
      prompt
    );

  const scenes = [];

  for (
    let i = 0;
    i < count;
    i++
  ) {
    scenes.push({
      index: i + 1,
      duration:
        i === count - 1
          ? Math.max(
              1,
              targetSeconds -
                i * 5
            )
          : 5,
      prompt:
        `${base}. Scene ${i + 1} of ${count}. Maintain visual continuity with the overall production.`
    });
  }

  return scenes;
}

/*
------------------------------------------------------------
COMBINE VIDEOS
------------------------------------------------------------
*/

async function combineVideoFiles(
  files,
  output
) {
  if (!files.length) {
    throw new Error(
      "No video files supplied."
    );
  }

  const listFile =
    path.join(
      TMP,
      `${randomId("concat_")}.txt`
    );

  const content =
    files
      .map(
        file =>
          `file '${file.replace(/'/g, "'\\''")}'`
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
      "-pix_fmt",
      "yuv420p",
      "-an",
      output
    ]);
  } finally {
    await fs.rm(
      listFile,
      {
        force: true
      }
    );
  }

  return output;
}

/*
------------------------------------------------------------
JOB HELPERS
------------------------------------------------------------
*/

async function saveJobHistory(job) {
  const history =
    await readJson(
      JOBS_FILE,
      []
    );

  history.push({
    id: job.id,
    userId:
      job.userId || null,
    status:
      job.status,
    type:
      job.type,
    createdAt:
      job.createdAt,
    finishedAt:
      job.finishedAt || null,
    errorCode:
      job.errorCode || null
  });

  const trimmed =
    history.slice(-1000);

  await writeJson(
    JOBS_FILE,
    trimmed
  );
}

function updateJob(
  id,
  patch
) {
  const job =
    jobs.get(id);

  if (!job) {
    return;
  }

  Object.assign(
    job,
    patch,
    {
      updatedAt:
        now()
    }
  );
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress:
      Number(job.progress || 0),
    stage:
      job.stage || "",
    message:
      job.message || "",
    videoUrl:
      job.videoUrl || null,
    error:
      job.error || null,
    errorCode:
      job.errorCode || null,
    createdAt:
      job.createdAt,
    updatedAt:
      job.updatedAt
  };
}

/*
------------------------------------------------------------
AUTOPILOT
------------------------------------------------------------
*/

async function runAutopilot(
  job,
  {
    prompt,
    duration,
    ratio,
    quality,
    image
  }
) {
  const sceneList =
    splitIntoScenes(
      prompt,
      duration
    );

  const sceneFiles = [];

  updateJob(
    job.id,
    {
      status:
        "processing",
      stage:
        "scene-planning",
      progress:
        3,
      message:
        `Planning ${sceneList.length} scene(s)...`
    }
  );

  await new Promise(
    resolve =>
      setTimeout(
        resolve,
        250
      )
  );

  for (
    let i = 0;
    i < sceneList.length;
    i++
  ) {
    const scene =
      sceneList[i];

    const percentage =
      Math.round(
        8 +
          (i /
            sceneList.length) *
            65
      );

    updateJob(
      job.id,
      {
        stage:
          "ai-generation",
        progress:
          percentage,
        message:
          `Generating scene ${i + 1} of ${sceneList.length}...`
      }
    );

    const buffer =
      image && i === 0
        ? await wanImageToVideo({
            prompt:
              scene.prompt,
            image,
            duration:
              scene.duration,
            ratio,
            quality
          })
        : await wanTextToVideo({
            prompt:
              scene.prompt,
            duration:
              scene.duration,
            ratio,
            quality
          });

    const scenePath =
      path.join(
        TMP,
        `${job.id}_scene_${i + 1}.mp4`
      );

    await fs.writeFile(
      scenePath,
      buffer
    );

    sceneFiles.push(
      scenePath
    );

    updateJob(
      job.id,
      {
        progress:
          Math.round(
            8 +
              ((i + 1) /
                sceneList.length) *
                65
          )
      }
    );
  }

  updateJob(
    job.id,
    {
      stage:
        "assembling",
      progress:
        76,
      message:
        "Assembling production..."
    }
  );

  const combined =
    path.join(
      TMP,
      `${job.id}_combined.mp4`
    );

  await combineVideoFiles(
    sceneFiles,
    combined
  );

  updateJob(
    job.id,
    {
      stage:
        "audio-processing",
      progress:
        82,
      message:
        "Processing audio..."
    }
  );

  const music =
    path.join(
      TMP,
      `${job.id}_music.wav`
    );

  await createSoftMusic(
    duration,
    music
  );

  const withMusic =
    path.join(
      TMP,
      `${job.id}_audio.mp4`
    );

  try {
    await mixAudio(
      combined,
      music,
      withMusic
    );
  } catch {
    await fs.copyFile(
      combined,
      withMusic
    );
  }

  updateJob(
    job.id,
    {
      stage:
        "finalizing",
      progress:
        89,
      message:
        "Applying final production settings..."
    }
  );

  const normalized =
    path.join(
      TMP,
      `${job.id}_normalized.mp4`
    );

  await forceDuration(
    withMusic,
    normalized,
    duration
  );

  updateJob(
    job.id,
    {
      stage:
        "branding",
      progress:
        94,
      message:
        "Applying MAMAKI branding..."
    }
  );

  const finalName =
    `${job.id}.mp4`;

  const finalPath =
    path.join(
      OUTPUT,
      finalName
    );

  await addWatermark(
    normalized,
    finalPath
  );

  updateJob(
    job.id,
    {
      status:
        "completed",
      progress:
        100,
      stage:
        "completed",
      message:
        "Production completed successfully.",
      videoUrl:
        `/api/video/${finalName}`,
      finishedAt:
        now()
    }
  );

  await recordUsage(
    job.userId,
    {
      jobId:
        job.id,
      duration,
      scenes:
        sceneList.length,
      type:
        image
          ? "image-to-video"
          : "text-to-video"
    }
  );

  const project = {
    id:
      randomId("project_"),
    userId:
      job.userId,
    name:
      prompt.slice(0, 70) ||
      "MAMAKI AI Production",
    type:
      image
        ? "image-to-video"
        : "text-to-video",
    duration,
    ratio,
    status:
      "completed",
    prompt,
    quality,
    videoUrl:
      `/api/video/${finalName}`,
    createdAt:
      now(),
    updatedAt:
      now()
  };

  await saveProjectRecord(
    project
  );

  for (
    const file of sceneFiles
  ) {
    await fs.rm(
      file,
      {
        force: true
      }
    );
  }

  await fs.rm(
    combined,
    {
      force: true
    }
  );

  await fs.rm(
    music,
    {
      force: true
    }
  );

  await fs.rm(
    withMusic,
    {
      force: true
    }
  );

  await fs.rm(
    normalized,
    {
      force: true
    }
  );
}

/*
------------------------------------------------------------
GENERATION API
------------------------------------------------------------
*/

app.post(
  "/api/generate",
  authenticate,
  upload.single("image"),
  async (req, res) => {
    try {
      const prompt =
        safeString(
          req.body.prompt
        );

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error:
            "Please describe the video you want to create."
        });
      }

      const duration =
        normalizeDuration(
          req.body.duration
        );

      const ratio =
        normalizeRatio(
          req.body.ratio
        );

      const quality =
        normalizeQuality(
          req.body.quality
        );

      const style =
        normalizeStyle(
          req.body.style
        );

      const fullPrompt =
        `${prompt}. Style: ${style}.`;

      const job = {
        id:
          randomId("job_"),
        userId:
          req.user.id,
        status:
          "queued",
        progress:
          0,
        stage:
          "queued",
        message:
          "Production queued.",
        type:
          req.file
            ? "image-to-video"
            : "text-to-video",
        createdAt:
          now(),
        updatedAt:
          now(),
        finishedAt:
          null,
        videoUrl:
          null,
        error:
          null,
        errorCode:
          null
      };

      jobs.set(
        job.id,
        job
      );

      await saveJobHistory(
        job
      );

      res.status(202).json({
        ok: true,
        job:
          publicJob(job)
      });

      runAutopilot(
        job,
        {
          prompt:
            fullPrompt,
          duration,
          ratio,
          quality,
          image:
            req.file || null
        }
      )
        .catch(
          async error => {
            console.error(
              "AUTOPILOT ERROR:",
              error
            );

            const classified =
              classifyReplicateError(
                error
              );

            updateJob(
              job.id,
              {
                status:
                  "failed",
                progress:
                  0,
                stage:
                  "failed",
                error:
                  error.publicMessage ||
                  classified.message,
                errorCode:
                  error.code ||
                  classified.code,
                finishedAt:
                  now()
              }
            );

            await saveJobHistory(
              jobs.get(
                job.id
              )
            );
          }
        );
    } catch (error) {
      console.error(
        "GENERATE ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          "Unable to start production."
      });
    }
  }
);

/*
------------------------------------------------------------
JOB STATUS
------------------------------------------------------------
*/

app.get(
  "/api/jobs/:id",
  authenticate,
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
        error:
          "Production job not found."
      });
    }

    res.json({
      ok: true,
      job:
        publicJob(job)
    });
  }
);

/*
------------------------------------------------------------
VIDEO SERVING
------------------------------------------------------------
*/

app.get(
  "/api/video/:file",
  async (req, res) => {
    const filename =
      basenameSafe(
        req.params.file
      );

    if (
      filename !==
      req.params.file
    ) {
      return res.status(400).end();
    }

    const file =
      filePathSafe(
        filename
      );

    try {
      await fs.access(
        file
      );
    } catch {
      return res.status(404).json({
        ok: false,
        error:
          "Video file not found."
      });
    }

    res.setHeader(
      "Content-Type",
      "video/mp4"
    );

    res.setHeader(
      "Content-Disposition",
      "inline"
    );

    res.sendFile(
      file
    );
  }
);

/*
------------------------------------------------------------
FREE STUDIO — PHOTO → VIDEO
------------------------------------------------------------
*/

app.post(
  "/api/studio/photo-video",
  authenticate,
  upload.array(
    "photos",
    30
  ),
  async (req, res) => {
    try {
      const photos =
        req.files || [];

      if (!photos.length) {
        return res.status(400).json({
          ok: false,
          error:
            "Please upload at least one photo."
        });
      }

      for (
        const photo of photos
      ) {
        if (
          !isImageFile(
            photo.originalname
          )
        ) {
          return res.status(400).json({
            ok: false,
            error:
              "Only JPG, JPEG, PNG and WebP images are supported."
          });
        }
      }

      const seconds =
        clampNumber(
          req.body.secondsPerPhoto,
          5,
          30,
          5
        );

      const ratio =
        normalizeRatio(
          req.body.ratio
        );

      const tempVideos =
        [];

      for (
        let i = 0;
        i < photos.length;
        i++
      ) {
        const photo =
          photos[i];

        const imagePath =
          path.join(
            TMP,
            `${randomId("photo_")}.jpg`
          );

        const clipPath =
          path.join(
            TMP,
            `${randomId("photo_clip_")}.mp4`
          );

        await fs.writeFile(
          imagePath,
          photo.buffer
        );

        let sizeFilter;

        if (
          ratio ===
          "9:16"
        ) {
          sizeFilter =
            "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2";
        } else if (
          ratio ===
          "1:1"
        ) {
          sizeFilter =
            "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2";
        } else {
          sizeFilter =
            "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2";
        }

        await runFFmpeg([
          "-y",
          "-loop",
          "1",
          "-i",
          imagePath,
          "-t",
          String(seconds),
          "-vf",
          `${sizeFilter},format=yuv420p`,
          "-r",
          "30",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-pix_fmt",
          "yuv420p",
          clipPath
        ]);

        tempVideos.push(
          clipPath
        );

        await fs.rm(
          imagePath,
          {
            force: true
          }
        );
      }

      const combined =
        path.join(
          TMP,
          `${randomId("photo_combined_")}.mp4`
        );

      await combineVideoFiles(
        tempVideos,
        combined
      );

      const musicChoice =
        safeString(
          req.body.music
        );

      let audioVideo =
        combined;

      if (
        musicChoice !==
        "none"
      ) {
        const music =
          path.join(
            TMP,
            `${randomId("photo_music_")}.wav`
          );

        const duration =
          photos.length *
          seconds;

        await createSoftMusic(
          duration,
          music
        );

        const mixed =
          path.join(
            TMP,
            `${randomId("photo_mixed_")}.mp4`
          );

        try {
          await mixAudio(
            combined,
            music,
            mixed
          );

          audioVideo =
            mixed;
        } catch {
          audioVideo =
            combined;
        }
      }

      const finalName =
        `${randomId("studio_photo_")}.mp4`;

      const finalPath =
        path.join(
          OUTPUT,
          finalName
        );

      await addWatermark(
        audioVideo,
        finalPath
      );

      const project = {
        id:
          randomId("project_"),
        userId:
          req.user.id,
        name:
          "MAMAKI Photo Video",
        type:
          "photo-video",
        duration:
          photos.length *
          seconds,
        ratio,
        status:
          "completed",
        videoUrl:
          `/api/video/${finalName}`,
        createdAt:
          now(),
        updatedAt:
          now()
      };

      await saveProjectRecord(
        project
      );

      for (
        const file of tempVideos
      ) {
        await fs.rm(
          file,
          {
            force: true
          }
        );
      }

      res.json({
        ok: true,
        videoUrl:
          `/api/video/${finalName}`,
        project:
          projectPublic(project)
      });
    } catch (error) {
      console.error(
        "PHOTO VIDEO ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          "Photo-to-video creation failed."
      });
    }
  }
);

/*
------------------------------------------------------------
FREE STUDIO — TRIM
------------------------------------------------------------
*/

app.post(
  "/api/studio/trim",
  authenticate,
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "Please upload a video."
        });
      }

      const start =
        clampNumber(
          req.body.start,
          0,
          7200,
          0
        );

      const end =
        clampNumber(
          req.body.end,
          start + 1,
          7200,
          start + 5
        );

      if (
        end <= start
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "End time must be greater than start time."
        });
      }

      const input =
        path.join(
          TMP,
          `${randomId("trim_input_")}.mp4`
        );

      await fs.writeFile(
        input,
        req.file.buffer
      );

      const outputName =
        `${randomId("trim_")}.mp4`;

      const output =
        path.join(
          OUTPUT,
          outputName
        );

      const raw =
        path.join(
          TMP,
          `${randomId("trim_raw_")}.mp4`
        );

      await runFFmpeg([
        "-y",
        "-ss",
        String(start),
        "-i",
        input,
        "-t",
        String(end - start),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-an",
        raw
      ]);

      await addWatermark(
        raw,
        output
      );

      const project = {
        id:
          randomId("project_"),
        userId:
          req.user.id,
        name:
          "MAMAKI Trimmed Video",
        type:
          "trim",
        duration:
          end - start,
        ratio:
          "16:9",
        status:
          "completed",
        videoUrl:
          `/api/video/${outputName}`,
        createdAt:
          now(),
        updatedAt:
          now()
      };

      await saveProjectRecord(
        project
      );

      await fs.rm(
        input,
        {
          force: true
        }
      );

      await fs.rm(
        raw,
        {
          force: true
        }
      );

      res.json({
        ok: true,
        videoUrl:
          `/api/video/${outputName}`,
        project:
          projectPublic(project)
      });
    } catch (error) {
      console.error(
        "TRIM ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          "Video trimming failed."
      });
    }
  }
);

/*
------------------------------------------------------------
FREE STUDIO — COMBINE
------------------------------------------------------------
*/

app.post(
  "/api/studio/combine",
  authenticate,
  upload.array(
    "videos",
    30
  ),
  async (req, res) => {
    try {
      const videos =
        req.files || [];

      if (
        videos.length <
        2
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Upload at least two videos."
        });
      }

      const tempFiles =
        [];

      for (
        const video of videos
      ) {
        if (
          !isVideoFile(
            video.originalname
          )
        ) {
          return res.status(400).json({
            ok: false,
            error:
              "Unsupported video format."
          });
        }

        const file =
          path.join(
            TMP,
            `${randomId("combine_")}.mp4`
          );

        await fs.writeFile(
          file,
          video.buffer
        );

        tempFiles.push(
          file
        );
      }

      const raw =
        path.join(
          TMP,
          `${randomId("combined_")}.mp4`
        );

      const finalName =
        `${randomId("combined_final_")}.mp4`;

      const final =
        path.join(
          OUTPUT,
          finalName
        );

      await combineVideoFiles(
        tempFiles,
        raw
      );

      await addWatermark(
        raw,
        final
      );

      const project = {
        id:
          randomId("project_"),
        userId:
          req.user.id,
        name:
          "MAMAKI Combined Production",
        type:
          "combine",
        duration:
          await getVideoDuration(
            raw
          ),
        ratio:
          "16:9",
        status:
          "completed",
        videoUrl:
          `/api/video/${finalName}`,
        createdAt:
          now(),
        updatedAt:
          now()
      };

      await saveProjectRecord(
        project
      );

      for (
        const file of tempFiles
      ) {
        await fs.rm(
          file,
          {
            force: true
          }
        );
      }

      await fs.rm(
        raw,
        {
          force: true
        }
      );

      res.json({
        ok: true,
        videoUrl:
          `/api/video/${finalName}`,
        project:
          projectPublic(project)
      });
    } catch (error) {
      console.error(
        "COMBINE ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          "Video combining failed."
      });
    }
  }
);

/*
------------------------------------------------------------
ADMIN
------------------------------------------------------------

Recommended Render environment variables:

MAMAKI_ADMIN_EMAIL
MAMAKI_ADMIN_PASSWORD

These are NOT placed in GitHub.
------------------------------------------------------------
*/

async function ensureAdminAccount() {
  const adminEmail =
    safeString(
      process.env.MAMAKI_ADMIN_EMAIL
    ).toLowerCase();

  const adminPassword =
    safeString(
      process.env.MAMAKI_ADMIN_PASSWORD
    );

  if (
    !adminEmail ||
    !adminPassword
  ) {
    console.warn(
      "MAMAKI ADMIN: Set MAMAKI_ADMIN_EMAIL and MAMAKI_ADMIN_PASSWORD in Render Environment Variables."
    );

    return;
  }

  if (
    adminPassword.length <
    12
  ) {
    console.warn(
      "MAMAKI ADMIN: MAMAKI_ADMIN_PASSWORD should contain at least 12 characters."
    );

    return;
  }

  const existing =
    await findUserByEmail(
      adminEmail
    );

  if (!existing) {
    await saveUser({
      id:
        randomId("admin_"),
      name:
        "MAMAKI Administrator",
      email:
        adminEmail,
      passwordHash:
        hashPassword(
          adminPassword
        ),
      role:
        "admin",
      plan:
        "professional",
      credits:
        0,
      status:
        "active",
      createdAt:
        now(),
      updatedAt:
        now(),
      lastLoginAt:
        null
    });

    console.log(
      "MAMAKI ADMIN: Administrator account created."
    );
  } else if (
    existing.role !==
    "admin"
  ) {
    await updateUser(
      existing.id,
      {
        role:
          "admin",
        plan:
          "professional"
      }
    );
  }
}

await ensureAdminAccount();

/*
------------------------------------------------------------
ADMIN LOGIN
------------------------------------------------------------
*/

app.post(
  "/api/admin/login",
  async (req, res) => {
    try {
      const email =
        safeString(
          req.body.email
        ).toLowerCase();

      const password =
        safeString(
          req.body.password
        );

      const user =
        await findUserByEmail(
          email
        );

      if (
        !user ||
        user.role !==
          "admin" ||
        !verifyPassword(
          password,
          user.passwordHash
        )
      ) {
        return res.status(401).json({
          ok: false,
          error:
            "Invalid administrator credentials."
        });
      }

      const token =
        createSession(user);

      return res.json({
        ok: true,
        user:
          publicUser(user),
        token
      });
    } catch {
      return res.status(500).json({
        ok: false,
        error:
          "Administrator login failed."
      });
    }
  }
);

/*
------------------------------------------------------------
ADMIN OVERVIEW
------------------------------------------------------------
*/

app.get(
  "/api/admin/overview",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJson(
        USERS,
        []
      );

    const projects =
      await readJson(
        PROJECTS_DB(),
        []
      );

    const ledger =
      await readJson(
        LEDGER,
        []
      );

    const history =
      await readJson(
        JOBS_FILE,
        []
      );

    const aiJobs =
      history.filter(
        x =>
          x.type ===
            "text-to-video" ||
          x.type ===
            "image-to-video"
      );

    const failedJobs =
      history.filter(
        x =>
          x.status ===
          "failed"
      );

    const activeUsers =
      users.filter(
        x =>
          x.status ===
          "active"
      );

    const creditsIssued =
      ledger
        .filter(
          x =>
            x.type ===
            "credit"
        )
        .reduce(
          (sum, x) =>
            sum +
            Number(
              x.amount || 0
            ),
          0
        );

    const creditsUsed =
      Math.abs(
        ledger
          .filter(
            x =>
              x.type ===
              "debit"
          )
          .reduce(
            (sum, x) =>
              sum +
              Number(
                x.amount || 0
              ),
            0
          )
      );

    res.json({
      ok: true,
      overview: {
        version:
          VERSION,
        totalUsers:
          users.length,
        activeUsers:
          activeUsers.length,
        totalProjects:
          projects.length,
        totalJobs:
          history.length,
        aiJobs:
          aiJobs.length,
        failedJobs:
          failedJobs.length,
        creditsIssued,
        creditsUsed,
        activeBackgroundJobs:
          Array.from(
            jobs.values()
          ).filter(
            j =>
              j.status ===
                "queued" ||
              j.status ===
                "processing"
          ).length
      }
    });
  }
);

/*
------------------------------------------------------------
ADMIN USERS
------------------------------------------------------------
*/

app.get(
  "/api/admin/users",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJson(
        USERS,
        []
      );

    res.json({
      ok: true,
      users:
        users
          .map(
            publicUser
          )
          .sort(
            (a, b) =>
              new Date(
                b.createdAt
              ) -
              new Date(
                a.createdAt
              )
          )
    });
  }
);

app.get(
  "/api/admin/users/:id",
  requireAdmin,
  async (req, res) => {
    const user =
      await findUserById(
        req.params.id
      );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error:
          "User not found."
      });
    }

    res.json({
      ok: true,
      user:
        publicUser(user)
    });
  }
);

app.patch(
  "/api/admin/users/:id",
  requireAdmin,
  async (req, res) => {
    const user =
      await findUserById(
        req.params.id
      );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error:
          "User not found."
      });
    }

    const patch = {};

    if (
      req.body.status ===
        "active" ||
      req.body.status ===
        "suspended"
    ) {
      patch.status =
        req.body.status;
    }

    if (
      req.body.plan
    ) {
      patch.plan =
        safeString(
          req.body.plan
        );
    }

    const updated =
      await updateUser(
        user.id,
        patch
      );

    res.json({
      ok: true,
      user:
        publicUser(updated)
    });
  }
);

/*
------------------------------------------------------------
ADMIN CREDIT MANAGEMENT
------------------------------------------------------------
*/

app.post(
  "/api/admin/users/:id/credits",
  requireAdmin,
  async (req, res) => {
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
          "A non-zero credit amount is required."
      });
    }

    const user =
      await findUserById(
        req.params.id
      );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error:
          "User not found."
      });
    }

    const balance =
      await changeCredits(
        user.id,
        amount,
        "Administrator credit adjustment",
        {
          adminId:
            req.user.id
        }
      );

    res.json({
      ok: true,
      userId:
        user.id,
      balance
    });
  }
);

/*
------------------------------------------------------------
ADMIN PROJECTS
------------------------------------------------------------
*/

app.get(
  "/api/admin/projects",
  requireAdmin,
  async (req, res) => {
    const projects =
      await readJson(
        PROJECTS_DB(),
        []
      );

    res.json({
      ok: true,
      projects:
        projects
          .sort(
            (a, b) =>
              new Date(
                b.updatedAt ||
                  b.createdAt
              ) -
              new Date(
                a.updatedAt ||
                  a.createdAt
              )
          )
          .slice(
            0,
            500
          )
    });
  }
);

/*
------------------------------------------------------------
ADMIN JOBS
------------------------------------------------------------
*/

app.get(
  "/api/admin/jobs",
  requireAdmin,
  async (req, res) => {
    const history =
      await readJson(
        JOBS_FILE,
        []
      );

    res.json({
      ok: true,
      active:
        Array.from(
          jobs.values()
        ).map(
          publicJob
        ),
      history:
        history
          .slice(-500)
          .reverse()
    });
  }
);

/*
------------------------------------------------------------
ADMIN SYSTEM STATUS
------------------------------------------------------------
*/

app.get(
  "/api/admin/system",
  requireAdmin,
  async (req, res) => {
    const storage =
      await getStorageStats();

    res.json({
      ok: true,
      system: {
        app:
          APP_NAME,
        version:
          VERSION,
        node:
          process.version,
        platform:
          process.platform,
        uptime:
          process.uptime(),
        replicateConfigured:
          Boolean(
            process.env
              .REPLICATE_API_TOKEN
          ),
        t2vModel:
          T2V_MODEL,
        i2vModel:
          I2V_MODEL,
        maxDuration:
          MAX_DURATION,
        maxUploadMB:
          MAX_UPLOAD_MB,
        storage
      }
    });
  }
);

/*
------------------------------------------------------------
STORAGE
------------------------------------------------------------
*/

async function getDirectorySize(
  directory
) {
  let total = 0;

  try {
    const entries =
      await fs.readdir(
        directory,
        {
          withFileTypes:
            true
        }
      );

    for (
      const entry of entries
    ) {
      const full =
        path.join(
          directory,
          entry.name
        );

      if (
        entry.isDirectory()
      ) {
        total +=
          await getDirectorySize(
            full
          );
      } else {
        try {
          const stat =
            await fs.stat(
              full
            );

          total +=
            stat.size;
        } catch {}
      }
    }
  } catch {}

  return total;
}

async function getStorageStats() {
  const outputBytes =
    await getDirectorySize(
      OUTPUT
    );

  const tmpBytes =
    await getDirectorySize(
      TMP
    );

  return {
    outputsBytes:
      outputBytes,
    temporaryBytes:
      tmpBytes,
    outputsMB:
      Number(
        (
          outputBytes /
          1024 /
          1024
        ).toFixed(2)
      ),
    temporaryMB:
      Number(
        (
          tmpBytes /
          1024 /
          1024
        ).toFixed(2)
      )
  };
}

/*
------------------------------------------------------------
PUBLIC STATUS
------------------------------------------------------------
*/

app.get(
  "/api/status",
  async (req, res) => {
    const storage =
      await getStorageStats();

    res.json({
      ok: true,
      app:
        APP_NAME,
      version:
        VERSION,

      ai: {
        provider:
          "Replicate",
        configured:
          Boolean(
            process.env
              .REPLICATE_API_TOKEN
          ),
        textToVideo:
          T2V_MODEL,
        imageToVideo:
          I2V_MODEL
      },

      features: {
        textToVideo:
          true,
        imageToVideo:
          true,
        aiDirector:
          true,
        longForm:
          true,
        automaticMusic:
          true,
        watermark:
          true,
        voiceNarration:
          true,
        subtitles:
          true,
        aiEnhance:
          true,
        photoVideo:
          true,
        trim:
          true,
        combine:
          true,
        accounts:
          true,
        projects:
          true,
        admin:
          true,
        creditLedger:
          true
      },

      limits: {
        minimumDuration:
          MIN_DURATION,
        maximumDuration:
          MAX_DURATION,
        maximumUploadMB:
          MAX_UPLOAD_MB
      },

      storage
    });
  }
);

/*
------------------------------------------------------------
HEALTH
------------------------------------------------------------
*/

app.get(
  "/health",
  async (req, res) => {
    res.json({
      ok: true,
      app:
        APP_NAME,
      version:
        VERSION,
      uptime:
        process.uptime(),
      timestamp:
        now()
    });
  }
);

/*
------------------------------------------------------------
ADMIN DASHBOARD HTML
------------------------------------------------------------
*/

app.get(
  "/admin",
  (req, res) => {
    res.type(
      "html"
    ).send(`
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI — Admin</title>
<style>
body{
  margin:0;
  font-family:Arial,Helvetica,sans-serif;
  background:#0b0b10;
  color:#fff;
}
main{
  max-width:1200px;
  margin:auto;
  padding:30px;
}
h1{margin-bottom:5px}
.muted{opacity:.65}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:15px;
  margin:25px 0;
}
.card{
  background:#171720;
  border:1px solid #292936;
  border-radius:16px;
  padding:20px;
}
.value{
  font-size:30px;
  font-weight:bold;
  margin-top:8px;
}
button{
  padding:12px 18px;
  border:0;
  border-radius:10px;
  cursor:pointer;
}
input{
  display:block;
  width:100%;
  max-width:400px;
  box-sizing:border-box;
  padding:13px;
  margin:10px 0;
  border-radius:9px;
  border:1px solid #333;
  background:#111118;
  color:#fff;
}
#dashboard{display:none}
</style>
</head>
<body>
<main>
<h1>✨ MAMAKI AI — Admin</h1>
<p class="muted">MAMAKI Platform Control Center</p>

<section id="login">
<h2>Administrator Login</h2>
<input id="email" type="email" placeholder="Administrator email">
<input id="password" type="password" placeholder="Administrator password">
<button onclick="login()">Login</button>
<p id="loginMsg"></p>
</section>

<section id="dashboard">
<button onclick="logout()">Logout</button>

<div class="grid">
<div class="card">
<div>Total Users</div>
<div class="value" id="users">0</div>
</div>

<div class="card">
<div>Active Users</div>
<div class="value" id="active">0</div>
</div>

<div class="card">
<div>Total Projects</div>
<div class="value" id="projects">0</div>
</div>

<div class="card">
<div>AI Jobs</div>
<div class="value" id="jobs">0</div>
</div>

<div class="card">
<div>Failed Jobs</div>
<div class="value" id="failed">0</div>
</div>

<div class="card">
<div>Credits Used</div>
<div class="value" id="credits">0</div>
</div>
</div>

<div class="card">
<h2>System</h2>
<pre id="system"></pre>
</div>
</section>
</main>

<script>
let token = localStorage.getItem("mamaki_admin_token");

async function api(url, options={}){
  options.headers = {
    ...(options.headers || {}),
    "Authorization":"Bearer "+token,
    "Content-Type":"application/json"
  };
  const r = await fetch(url, options);
  return await r.json();
}

async function login(){
  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  const r = await fetch("/api/admin/login",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({email,password})
  });

  const data = await r.json();

  if(!data.ok){
    document.getElementById("loginMsg").textContent = data.error || "Login failed";
    return;
  }

  token = data.token;
  localStorage.setItem("mamaki_admin_token",token);

  document.getElementById("login").style.display="none";
  document.getElementById("dashboard").style.display="block";

  loadDashboard();
}

async function loadDashboard(){
  const data = await api("/api/admin/overview");

  if(!data.ok){
    logout();
    return;
  }

  const o = data.overview;

  document.getElementById("users").textContent=o.totalUsers;
  document.getElementById("active").textContent=o.activeUsers;
  document.getElementById("projects").textContent=o.totalProjects;
  document.getElementById("jobs").textContent=o.aiJobs;
  document.getElementById("failed").textContent=o.failedJobs;
  document.getElementById("credits").textContent=o.creditsUsed;

  const system = await api("/api/admin/system");

  document.getElementById("system").textContent =
    JSON.stringify(system.system,null,2);
}

function logout(){
  localStorage.removeItem("mamaki_admin_token");
  token=null;
  document.getElementById("login").style.display="block";
  document.getElementById("dashboard").style.display="none";
}

if(token){
  document.getElementById("login").style.display="none";
  document.getElementById("dashboard").style.display="block";
  loadDashboard();
}
</script>
</body>
</html>
`);
  }
);

/*
------------------------------------------------------------
USER ACCOUNT DASHBOARD
------------------------------------------------------------
*/

app.get(
  "/account",
  (req, res) => {
    res.type(
      "html"
    ).send(`
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI — Account</title>
<style>
body{
margin:0;
font-family:Arial,Helvetica,sans-serif;
background:#0b0b10;
color:white;
}
main{
max-width:1000px;
margin:auto;
padding:30px;
}
.card{
background:#171720;
border:1px solid #292936;
border-radius:18px;
padding:22px;
margin:15px 0;
}
.grid{
display:grid;
grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
gap:15px;
}
.value{
font-size:30px;
font-weight:bold;
margin-top:8px;
}
input{
width:100%;
max-width:450px;
box-sizing:border-box;
padding:13px;
margin:7px 0;
background:#111118;
border:1px solid #333;
border-radius:9px;
color:white;
}
button{
padding:12px 18px;
border:0;
border-radius:10px;
cursor:pointer;
}
#app{display:none}
</style>
</head>
<body>
<main>
<h1>✨ MAMAKI AI</h1>
<p>Your creative workspace</p>

<section id="login">
<div class="card">
<h2>Login</h2>
<input id="loginEmail" placeholder="Email">
<input id="loginPassword" type="password" placeholder="Password">
<button onclick="login()">Login</button>
<p id="msg"></p>
</div>

<div class="card">
<h2>Create Account</h2>
<input id="regName" placeholder="Full name">
<input id="regEmail" placeholder="Email">
<input id="regPassword" type="password" placeholder="Password — 8+ characters">
<button onclick="register()">Create Account</button>
</div>
</section>

<section id="app">
<button onclick="logout()">Logout</button>

<div class="card">
<h2 id="welcome"></h2>
<p id="email"></p>
</div>

<div class="grid">
<div class="card">
<div>Plan</div>
<div class="value" id="plan">Free</div>
</div>

<div class="card">
<div>AI Credits</div>
<div class="value" id="credits">0</div>
</div>

<div class="card">
<div>Projects</div>
<div class="value" id="projects">0</div>
</div>
</div>

<div class="card">
<h2>My Projects</h2>
<div id="projectList"></div>
</div>
</section>
</main>

<script>
let token=localStorage.getItem("mamaki_token");

async function api(url,options={}){
options.headers={
...(options.headers||{}),
"Authorization":"Bearer "+token,
"Content-Type":"application/json"
};
const r=await fetch(url,options);
return await r.json();
}

async function login(){
const email=document.getElementById("loginEmail").value;
const password=document.getElementById("loginPassword").value;

const r=await fetch("/api/auth/login",{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({email,password})
});

const d=await r.json();

if(!d.ok){
document.getElementById("msg").textContent=d.error;
return;
}

token=d.token;
localStorage.setItem("mamaki_token",token);
showApp();
}

async function register(){
const name=document.getElementById("regName").value;
const email=document.getElementById("regEmail").value;
const password=document.getElementById("regPassword").value;

const r=await fetch("/api/auth/register",{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({name,email,password})
});

const d=await r.json();

if(!d.ok){
document.getElementById("msg").textContent=d.error;
return;
}

token=d.token;
localStorage.setItem("mamaki_token",token);
showApp();
}

async function showApp(){
const me=await api("/api/auth/me");

if(!me.ok){
logout();
return;
}

document.getElementById("login").style.display="none";
document.getElementById("app").style.display="block";

document.getElementById("welcome").textContent=
"Welcome, "+me.user.name+" 👋";

document.getElementById("email").textContent=
me.user.email;

document.getElementById("plan").textContent=
me.user.plan;

document.getElementById("credits").textContent=
me.user.credits;

const p=await api("/api/projects");

document.getElementById("projects").textContent=
p.projects.length;

document.getElementById("projectList").innerHTML=
p.projects.length
? p.projects.map(x =>
'<div class="card"><b>'+escapeHtml(x.name)+'</b><br>'+
x.type+' • '+x.duration+' sec<br>'+
(x.videoUrl
? '<a style="color:#fff" href="'+x.videoUrl+'" target="_blank">Open Video</a>'
: '')+
'</div>'
).join("")
: "<p>No projects yet.</p>";
}

function escapeHtml(value){
return String(value).replace(/[&<>"']/g,m=>({
"&":"&amp;",
"<":"&lt;",
">":"&gt;",
'"':"&quot;",
"'":"&#039;"
}[m]));
}

function logout(){
localStorage.removeItem("mamaki_token");
token=null;
document.getElementById("login").style.display="block";
document.getElementById("app").style.display="none";
}

if(token){
showApp();
}
</script>
</body>
</html>
`);
  }
);

/*
------------------------------------------------------------
ROOT
------------------------------------------------------------
*/

app.get(
  "/",
  async (req, res) => {
    try {
      res.sendFile(
        path.join(
          PUBLIC_DIR,
          "index.html"
        )
      );
    } catch {
      res.status(500).send(
        "MAMAKI AI is running, but index.html could not be loaded."
      );
    }
  }
);

/*
------------------------------------------------------------
404
------------------------------------------------------------
*/

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        "MAMAKI API endpoint not found."
    });
  }
);

/*
------------------------------------------------------------
ERROR HANDLER
------------------------------------------------------------
*/

app.use(
  (error, req, res, next) => {
    console.error(
      "UNHANDLED ERROR:",
      error
    );

    if (
      error?.code ===
      "LIMIT_FILE_SIZE"
    ) {
      return res.status(413).json({
        ok: false,
        error:
          `File is too large. Maximum size is ${MAX_UPLOAD_MB}MB.`
      });
    }

    res.status(500).json({
      ok: false,
      error:
        "MAMAKI encountered an unexpected server error."
    });
  }
);

/*
------------------------------------------------------------
JOB CLEANUP
------------------------------------------------------------
*/

setInterval(
  () => {
    const cutoff =
      Date.now() -
      1000 * 60 * 60 * 2;

    for (
      const [
        id,
        job
      ] of jobs
    ) {
      const time =
        new Date(
          job.updatedAt ||
            job.createdAt
        ).getTime();

      if (
        (
          job.status ===
            "completed" ||
          job.status ===
            "failed"
        ) &&
        time <
          cutoff
      ) {
        jobs.delete(
          id
        );
      }
    }
  },
  1000 * 60 * 30
);

/*
------------------------------------------------------------
GRACEFUL SHUTDOWN
------------------------------------------------------------
*/

async function shutdown(
  signal
) {
  console.log(
    `MAMAKI: ${signal} received. Shutting down...`
  );

  try {
    await writeJson(
      USERS,
      await readJson(
        USERS,
        []
      )
    );

    await writeJson(
      PROJECTS_DB(),
      await readJson(
        PROJECTS_DB(),
        []
      )
    );
  } catch {}

  process.exit(
    0
  );
}

process.on(
  "SIGTERM",
  () =>
    shutdown(
      "SIGTERM"
    )
);

process.on(
  "SIGINT",
  () =>
    shutdown(
      "SIGINT"
    )
);

/*
------------------------------------------------------------
START
------------------------------------------------------------
*/

const server =
  app.listen(
    PORT,
    HOST,
    () => {
      console.log(
        "=========================================="
      );

      console.log(
        `✨ ${APP_NAME} SERVER`
      );

      console.log(
        `Version: ${VERSION}`
      );

      console.log(
        `Port: ${PORT}`
      );

      console.log(
        `Host: ${HOST}`
      );

      console.log(
        `T2V: ${T2V_MODEL}`
      );

      console.log(
        `I2V: ${I2V_MODEL}`
      );

      console.log(
        `Replicate configured: ${Boolean(
          process.env
            .REPLICATE_API_TOKEN
        )}`
      );

      console.log(
        `Admin configured: ${Boolean(
          process.env
            .MAMAKI_ADMIN_EMAIL &&
          process.env
            .MAMAKI_ADMIN_PASSWORD
        )}`
      );

      console.log(
        "=========================================="
      );
    }
  );

server.keepAliveTimeout =
  120000;

server.headersTimeout =
  125000;
