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
const VERSION = "15.1.0";

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

const MIN_DURATION = 5;
const MAX_DURATION = 7200;

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "")
  .trim()
  .toLowerCase();

const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const SESSION_SECRET = String(process.env.SESSION_SECRET || "");
const REPLICATE_API_TOKEN = String(
  process.env.REPLICATE_API_TOKEN || ""
).trim();

const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
const RESEND_FROM = String(process.env.RESEND_FROM || "").trim();

const APP_URL = String(
  process.env.APP_URL || "https://mamaki-ai-video.onrender.com"
).replace(/\/$/, "");

const T2V_MODEL =
  process.env.T2V_MODEL || "wan-video/wan-2.2-t2v-fast";

const I2V_MODEL =
  process.env.I2V_MODEL || "wan-video/wan-2.2-i2v-fast";

const replicate = REPLICATE_API_TOKEN
  ? new Replicate({ auth: REPLICATE_API_TOKEN })
  : null;

const upload = multer({
  dest: TMP,
  limits: {
    fileSize: 200 * 1024 * 1024
  }
});

const jobs = new Map();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use("/outputs", express.static(OUTPUTS));
app.use("/projects", express.static(PROJECTS));

/* =========================================================
   BASIC HELPERS
========================================================= */

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
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
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJSON(file, value) {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify(value, null, 2),
    "utf8"
  );

  await fs.rename(temp, file);
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanName(value) {
  return String(value || "").trim().slice(0, 100);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeDuration(value) {
  if (typeof value === "number") {
    return clampNumber(value, MIN_DURATION, MAX_DURATION, 5);
  }

  const text = String(value || "5").trim().toLowerCase();

  if (/^\d+(\.\d+)?s$/.test(text)) {
    return clampNumber(parseFloat(text), MIN_DURATION, MAX_DURATION, 5);
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

  return clampNumber(text, MIN_DURATION, MAX_DURATION, 5);
}

function safeFileName(name) {
  return String(name || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 180);
}

function publicUrl(fileName) {
  return `${APP_URL}/outputs/${encodeURIComponent(fileName)}`;
}

function projectUrl(fileName) {
  return `${APP_URL}/projects/${encodeURIComponent(fileName)}`;
}

/* =========================================================
   PASSWORD / AUTH
========================================================= */

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");

  const hash = scryptSync(
    String(password),
    salt,
    64
  ).toString("hex");

  return { salt, hash };
}

function verifyPassword(password, salt, storedHash) {
  try {
    if (!salt || !storedHash) return false;

    const a = Buffer.from(
      scryptSync(String(password), salt, 64)
    );

    const b = Buffer.from(storedHash, "hex");

    if (a.length !== b.length) return false;

    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function sessionHash(token) {
  return createHash("sha256")
    .update(`${SESSION_SECRET}:${token}`)
    .digest("hex");
}

async function createSession(userId, kind = "user") {
  const sessions = await readJSON(SESSIONS, {});
  const token = randomBytes(48).toString("hex");
  const id = randomUUID();

  sessions[id] = {
    id,
    userId,
    kind,
    tokenHash: sessionHash(token),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000
    ).toISOString()
  };

  await writeJSON(SESSIONS, sessions);

  return token;
}

async function destroyUserSessions(userId) {
  const sessions = await readJSON(SESSIONS, {});
  let changed = false;

  for (const id of Object.keys(sessions)) {
    if (sessions[id]?.userId === userId) {
      delete sessions[id];
      changed = true;
    }
  }

  if (changed) {
    await writeJSON(SESSIONS, sessions);
  }
}

async function getSession(token) {
  if (!token) return null;

  const sessions = await readJSON(SESSIONS, {});
  const wanted = sessionHash(token);

  for (const session of Object.values(sessions)) {
    if (!session) continue;

    if (
      session.tokenHash === wanted &&
      new Date(session.expiresAt).getTime() > Date.now()
    ) {
      return session;
    }
  }

  return null;
}

function bearerToken(req) {
  const header = String(
    req.headers.authorization || ""
  );

  if (!header.startsWith("Bearer ")) return "";

  return header.slice(7).trim();
}

async function currentUser(req) {
  const token = bearerToken(req);

  if (!token) return null;

  const session = await getSession(token);

  if (!session) return null;

  const users = await readJSON(USERS, {});
  const user = users[session.userId];

  if (!user || user.disabled) return null;

  return user;
}

async function requireUser(req, res, next) {
  try {
    const user = await currentUser(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "UNAUTHORIZED",
        message: "Please log in."
      });
    }

    req.user = user;
    next();
  } catch (error) {
    await errorLog(error, { route: req.path });

    res.status(500).json({
      ok: false,
      error: "AUTH_ERROR"
    });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await currentUser(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "UNAUTHORIZED"
      });
    }

    if (user.role !== "admin") {
      return res.status(403).json({
        ok: false,
        error: "ADMIN_ONLY"
      });
    }

    req.user = user;
    next();
  } catch (error) {
    await errorLog(error, { route: req.path });

    res.status(500).json({
      ok: false,
      error: "ADMIN_AUTH_ERROR"
    });
  }
}

/* =========================================================
   LOGGING
========================================================= */

async function errorLog(error, meta = {}) {
  try {
    const errors = await readJSON(ERRORS, []);

    errors.unshift({
      id: randomUUID(),
      message: String(error?.message || error),
      stack: String(error?.stack || ""),
      meta,
      createdAt: new Date().toISOString()
    });

    await writeJSON(
      ERRORS,
      errors.slice(0, 500)
    );
  } catch {}
}

async function security(event, meta = {}) {
  try {
    const events = await readJSON(SECURITY, []);

    events.unshift({
      id: randomUUID(),
      event,
      meta,
      createdAt: new Date().toISOString()
    });

    await writeJSON(
      SECURITY,
      events.slice(0, 1000)
    );
  } catch {}
}

/* =========================================================
   USAGE
========================================================= */

async function addUsage(userId, type, amount = 1) {
  const usage = await readJSON(USAGE, {});
  const day = new Date().toISOString().slice(0, 10);

  if (!usage[userId]) {
    usage[userId] = {};
  }

  if (!usage[userId][day]) {
    usage[userId][day] = {};
  }

  usage[userId][day][type] =
    Number(usage[userId][day][type] || 0) + amount;

  await writeJSON(USAGE, usage);
}

/* =========================================================
   AUTH API
========================================================= */

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = cleanName(req.body.name);
    const mail = cleanEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!name || !mail || password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_REGISTRATION",
        message:
          "Name, valid email and password of at least 6 characters are required."
      });
    }

    const users = await readJSON(USERS, {});

    const existsUser = Object.values(users).find(
      u => cleanEmail(u.email) === mail
    );

    if (existsUser) {
      return res.status(409).json({
        ok: false,
        error: "EMAIL_EXISTS",
        message: "An account with this email already exists."
      });
    }

    const hp = hashPassword(password);
    const id = randomUUID();

    users[id] = {
      id,
      name,
      email: mail,
      ...hp,
      role: mail === ADMIN_EMAIL ? "admin" : "user",
      disabled: false,
      createdAt: new Date().toISOString(),
      lastLoginAt: null
    };

    await writeJSON(USERS, users);

    const token = await createSession(
      id,
      users[id].role === "admin" ? "admin" : "user"
    );

    await security("REGISTER", {
      userId: id,
      email: mail
    });

    res.json({
      ok: true,
      token,
      user: {
        id,
        name,
        email: mail,
        role: users[id].role
      }
    });
  } catch (error) {
    await errorLog(error, {
      route: "/api/auth/register"
    });

    res.status(500).json({
      ok: false,
      error: "REGISTER_ERROR"
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const mail = cleanEmail(req.body.email);
    const password = String(req.body.password || "");

    const users = await readJSON(USERS, {});

    const user = Object.values(users).find(
      u => cleanEmail(u.email) === mail
    );

    if (
      !user ||
      user.disabled ||
      !verifyPassword(password, user.salt, user.hash)
    ) {
      await security("LOGIN_FAILED", {
        email: mail
      });

      return res.status(401).json({
        ok: false,
        error: "INVALID_CREDENTIALS",
        message: "Invalid email or password."
      });
    }

    user.lastLoginAt = new Date().toISOString();
    users[user.id] = user;

    await writeJSON(USERS, users);

    const token = await createSession(
      user.id,
      user.role === "admin" ? "admin" : "user"
    );

    await security("LOGIN_SUCCESS", {
      userId: user.id,
      email: user.email
    });

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    await errorLog(error, {
      route: "/api/auth/login"
    });

    res.status(500).json({
      ok: false,
      error: "LOGIN_ERROR"
    });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = bearerToken(req);

    if (token) {
      const sessions = await readJSON(SESSIONS, {});
      const wanted = sessionHash(token);

      for (const id of Object.keys(sessions)) {
        if (sessions[id]?.tokenHash === wanted) {
          delete sessions[id];
        }
      }

      await writeJSON(SESSIONS, sessions);
    }

    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

app.get("/api/auth/me", requireUser, async (req, res) => {
  res.json({
    ok: true,
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role
    }
  });
});

/* =========================================================
   ACCOUNT
========================================================= */

app.get("/api/account", requireUser, async (req, res) => {
  res.json({
    ok: true,
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      createdAt: req.user.createdAt,
      lastLoginAt: req.user.lastLoginAt
    }
  });
});

app.post("/api/account/profile", requireUser, async (req, res) => {
  try {
    const users = await readJSON(USERS, {});
    const user = users[req.user.id];

    user.name = cleanName(req.body.name) || user.name;

    users[user.id] = user;

    await writeJSON(USERS, users);

    res.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    await errorLog(error, {
      route: "/api/account/profile"
    });

    res.status(500).json({
      ok: false,
      error: "PROFILE_ERROR"
    });
  }
});

app.post(
  "/api/account/change-password",
  requireUser,
  async (req, res) => {
    try {
      const oldPassword = String(
        req.body.oldPassword || ""
      );

      const newPassword = String(
        req.body.newPassword || ""
      );

      const users = await readJSON(USERS, {});
      const user = users[req.user.id];

      if (
        !verifyPassword(
          oldPassword,
          user.salt,
          user.hash
        )
      ) {
        return res.status(401).json({
          ok: false,
          error: "WRONG_PASSWORD"
        });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({
          ok: false,
          error: "PASSWORD_TOO_SHORT"
        });
      }

      const hp = hashPassword(newPassword);

      user.salt = hp.salt;
      user.hash = hp.hash;

      users[user.id] = user;

      await writeJSON(USERS, users);
      await destroyUserSessions(user.id);

      const token = await createSession(
        user.id,
        user.role === "admin" ? "admin" : "user"
      );

      res.json({
        ok: true,
        token
      });
    } catch (error) {
      await errorLog(error, {
        route: "/api/account/change-password"
      });

      res.status(500).json({
        ok: false,
        error: "PASSWORD_CHANGE_ERROR"
      });
    }
  }
);

/* =========================================================
   PASSWORD RECOVERY
========================================================= */

app.post(
  "/api/auth/forgot-password",
  async (req, res) => {
    try {
      const mail = cleanEmail(req.body.email);
      const users = await readJSON(USERS, {});

      const user = Object.values(users).find(
        u => cleanEmail(u.email) === mail
      );

      if (!user) {
        return res.json({
          ok: true,
          message:
            "If that account exists, recovery instructions will be sent."
        });
      }

      const token = randomBytes(32).toString("hex");
      const resets = await readJSON(RESETS, {});

      resets[token] = {
        userId: user.id,
        expiresAt: new Date(
          Date.now() + 30 * 60 * 1000
        ).toISOString()
      };

      await writeJSON(RESETS, resets);

      if (RESEND_API_KEY && RESEND_FROM) {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: RESEND_FROM,
            to: [user.email],
            subject: "MAMAKI AI Password Reset",
            html:
              `<p>Hello ${user.name || "there"},</p>` +
              `<p>Your password reset link is:</p>` +
              `<p><a href="${APP_URL}/reset-password?token=${token}">Reset Password</a></p>` +
              `<p>This link expires in 30 minutes.</p>`
          })
        });
      }

      res.json({
        ok: true,
        message:
          "If that account exists, recovery instructions will be sent.",
        recoveryConfigured: Boolean(
          RESEND_API_KEY && RESEND_FROM
        )
      });
    } catch (error) {
      await errorLog(error, {
        route: "/api/auth/forgot-password"
      });

      res.status(500).json({
        ok: false,
        error: "RECOVERY_ERROR"
      });
    }
  }
);

app.post(
  "/api/auth/reset-password",
  async (req, res) => {
    try {
      const token = String(req.body.token || "");
      const password = String(req.body.password || "");

      if (!token || password.length < 6) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_RESET"
        });
      }

      const resets = await readJSON(RESETS, {});
      const item = resets[token];

      if (
        !item ||
        new Date(item.expiresAt).getTime() < Date.now()
      ) {
        return res.status(400).json({
          ok: false,
          error: "RESET_EXPIRED"
        });
      }

      const users = await readJSON(USERS, {});
      const user = users[item.userId];

      if (!user) {
        return res.status(400).json({
          ok: false,
          error: "USER_NOT_FOUND"
        });
      }

      const hp = hashPassword(password);

      user.salt = hp.salt;
      user.hash = hp.hash;

      users[user.id] = user;

      await writeJSON(USERS, users);

      delete resets[token];
      await writeJSON(RESETS, resets);

      await destroyUserSessions(user.id);

      res.json({
        ok: true
      });
    } catch (error) {
      await errorLog(error, {
        route: "/api/auth/reset-password"
      });

      res.status(500).json({
        ok: false,
        error: "RESET_ERROR"
      });
    }
  }
);

/* =========================================================
   VIDEO HELPERS
========================================================= */

function dimensions(format) {
  if (format === "9:16") {
    return { width: 480, height: 832 };
  }

  if (format === "1:1") {
    return { width: 704, height: 704 };
  }

  return { width: 832, height: 480 };
}

function sceneCount(duration) {
  if (duration <= 10) return 1;
  return Math.max(1, Math.ceil(duration / 5));
}

async function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", d => {
      stdout += d.toString();
    });

    child.stderr.on("data", d => {
      stderr += d.toString();
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(
            `FFmpeg exited with code ${code}: ${stderr.slice(-3000)}`
          )
        );
      }
    });
  });
}

async function downloadToFile(url, destination) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Download failed with status ${response.status}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  await fs.writeFile(destination, buffer);

  return destination;
}

async function makeExactDuration(
  input,
  output,
  duration,
  format = "16:9"
) {
  const { width, height } = dimensions(format);

  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-t",
    String(duration),
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    "-r",
    "16",
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

async function addMamakiWatermark(
  input,
  output
) {
  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    "drawtext=text='MAMAKI AI':fontcolor=white@0.75:fontsize=22:x=18:y=18:box=1:boxcolor=black@0.25:boxborderw=8",
    "-c:a",
    "copy",
    output
  ]);

  return output;
}

async function addSoftMusic(
  input,
  output,
  duration
) {
  const music = path.join(
    TMP,
    `music-${randomUUID()}.wav`
  );

  try {
    await runFFmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=44100",
      "-t",
      String(duration),
      "-c:a",
      "pcm_s16le",
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
      "-shortest",
      output
    ]);
  } catch {
    await fs.copyFile(input, output);
  }

  await fs.rm(music, {
    force: true
  });

  return output;
}

async function replicateVideo(input) {
  if (!replicate) {
    throw new Error(
      "Replicate is not configured. Add REPLICATE_API_TOKEN in Render."
    );
  }

  const result = await replicate.run(
    T2V_MODEL,
    { input }
  );

  if (!result) {
    throw new Error(
      "Replicate returned an empty result."
    );
  }

  let url = null;

  if (typeof result === "string") {
    url = result;
  } else if (result?.url) {
    url = String(result.url);
  } else if (Array.isArray(result)) {
    for (const item of result) {
      if (typeof item === "string") {
        url = item;
        break;
      }

      if (item?.url) {
        url = String(item.url);
        break;
      }
    }
  }

  if (!url) {
    throw new Error(
      "Replicate completed but no video URL was returned."
    );
  }

  return url;
}

function progressJob(id, value, message) {
  const job = jobs.get(id);

  if (!job) return;

  job.progress = Math.max(
    0,
    Math.min(100, Number(value))
  );

  job.message = message || job.message;
  job.updatedAt = new Date().toISOString();
}

async function generateVideo({
  prompt,
  duration,
  format,
  imageUrl,
  jobId
}) {
  const safeDuration = normalizeDuration(duration);
  const dims = dimensions(format);

  progressJob(
    jobId,
    5,
    "Planning your video..."
  );

  const frames =
    safeDuration <= 5 ? 81 : 121;

  let input = {
    prompt: String(prompt || "").slice(0, 5000),
    num_frames: frames,
    width: dims.width,
    height: dims.height,
    sample_shift: 12,
    go_fast: true,
    fps: 16
  };

  let model = T2V_MODEL;

  if (imageUrl) {
    model = I2V_MODEL;

    input = {
      prompt: String(prompt || "").slice(0, 5000),
      image: imageUrl,
      num_frames: frames,
      width: dims.width,
      height: dims.height,
      sample_shift: 12,
      go_fast: true,
      fps: 16
    };
  }

  progressJob(
    jobId,
    15,
    "Sending request to WAN AI..."
  );

  if (!replicate) {
    throw new Error(
      "REPLICATE_API_TOKEN is missing."
    );
  }

  const result = await replicate.run(
    model,
    { input }
  );

  progressJob(
    jobId,
    60,
    "Downloading generated video..."
  );

  let url = null;

  if (typeof result === "string") {
    url = result;
  } else if (result?.url) {
    url = String(result.url);
  } else if (Array.isArray(result)) {
    for (const item of result) {
      if (typeof item === "string") {
        url = item;
        break;
      }

      if (item?.url) {
        url = String(item.url);
        break;
      }
    }
  }

  if (!url) {
    throw new Error(
      "AI completed but no video file was returned."
    );
  }

  const raw = path.join(
    TMP,
    `${jobId}-raw.mp4`
  );

  const exact = path.join(
    TMP,
    `${jobId}-exact.mp4`
  );

  const music = path.join(
    TMP,
    `${jobId}-music.mp4`
  );

  const finalName =
    `${jobId}-${Date.now()}.mp4`;

  const finalFile = path.join(
    OUTPUTS,
    finalName
  );

  await downloadToFile(url, raw);

  progressJob(
    jobId,
    75,
    "Preparing exact duration..."
  );

  await makeExactDuration(
    raw,
    exact,
    safeDuration,
    format
  );

  progressJob(
    jobId,
    84,
    "Adding audio..."
  );

  await addSoftMusic(
    exact,
    music,
    safeDuration
  );

  progressJob(
    jobId,
    92,
    "Applying MAMAKI watermark..."
  );

  await addMamakiWatermark(
    music,
    finalFile
  );

  await fs.rm(raw, { force: true });
  await fs.rm(exact, { force: true });
  await fs.rm(music, { force: true });

  progressJob(
    jobId,
    100,
    "Video ready."
  );

  return {
    url: publicUrl(finalName),
    file: finalName,
    duration: safeDuration,
    format
  };
}

/* =========================================================
   VIDEO GENERATION
========================================================= */

app.post(
  "/api/generate",
  requireUser,
  upload.single("image"),
  async (req, res) => {
    const jobId = randomUUID();

    try {
      const prompt = String(
        req.body.prompt || ""
      ).trim();

      const duration = normalizeDuration(
        req.body.duration
      );

      const format =
        req.body.format === "9:16"
          ? "9:16"
          : req.body.format === "1:1"
            ? "1:1"
            : "16:9";

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error: "PROMPT_REQUIRED"
        });
      }

      jobs.set(jobId, {
        id: jobId,
        userId: req.user.id,
        type: req.file
          ? "image-to-video"
          : "text-to-video",
        status: "processing",
        progress: 0,
        message: "Starting...",
        createdAt: new Date().toISOString()
      });

      let imageUrl = null;

      if (req.file) {
        const destinationName =
          `${jobId}-${safeFileName(req.file.originalname)}`;

        const destination = path.join(
          OUTPUTS,
          destinationName
        );

        await fs.rename(
          req.file.path,
          destination
        );

        imageUrl = publicUrl(destinationName);
      }

      res.json({
        ok: true,
        jobId,
        status: "processing"
      });

      generateVideo({
        prompt,
        duration,
        format,
        imageUrl,
        jobId
      })
        .then(async result => {
          const job = jobs.get(jobId);

          if (job) {
            job.status = "completed";
            job.progress = 100;
            job.result = result;
            job.completedAt =
              new Date().toISOString();
          }

          await addUsage(
            req.user.id,
            "videoGeneration",
            1
          );
        })
        .catch(async error => {
          const job = jobs.get(jobId);

          if (job) {
            job.status = "failed";
            job.progress = 100;
            job.message =
              error.message || "Generation failed.";
            job.error =
              error.message || "Generation failed.";
          }

          await errorLog(error, {
            route: "/api/generate",
            userId: req.user.id,
            jobId
          });
        });
    } catch (error) {
      await errorLog(error, {
        route: "/api/generate"
      });

      res.status(500).json({
        ok: false,
        error: "GENERATION_ERROR",
        message: error.message
      });
    }
  }
);

app.get(
  "/api/jobs/:id",
  requireUser,
  async (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job || job.userId !== req.user.id) {
      return res.status(404).json({
        ok: false,
        error: "JOB_NOT_FOUND"
      });
    }

    res.json({
      ok: true,
      job
    });
  }
);

app.get(
  "/api/jobs",
  requireUser,
  async (req, res) => {
    const result = [...jobs.values()]
      .filter(j => j.userId === req.user.id)
      .sort(
        (a, b) =>
          new Date(b.createdAt) -
          new Date(a.createdAt)
      );

    res.json({
      ok: true,
      jobs: result.slice(0, 100)
    });
  }
);

/* =========================================================
   NARRATION
========================================================= */

app.post(
  "/api/narration",
  requireUser,
  async (req, res) => {
    const text = String(
      req.body.text || ""
    ).trim();

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "TEXT_REQUIRED"
      });
    }

    const id = randomUUID();

    const output = path.join(
      OUTPUTS,
      `${id}.mp3`
    );

    try {
      const tts = new EdgeTTS();

      await tts.synthesize(
        text,
        "en-US-EmmaMultilingualNeural",
        {
          rate: "+0%",
          pitch: "+0Hz"
        },
        output
      );

      await addUsage(
        req.user.id,
        "narration",
        1
      );

      res.json({
        ok: true,
        url: publicUrl(`${id}.mp3`)
      });
    } catch (error) {
      await errorLog(error, {
        route: "/api/narration"
      });

      res.status(500).json({
        ok: false,
        error: "NARRATION_ERROR",
        message: error.message
      });
    }
  }
);

/* =========================================================
   FREE STUDIO
========================================================= */

app.post(
  "/api/studio/trim",
  requireUser,
  upload.single("video"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "VIDEO_REQUIRED"
      });
    }

    const start = Math.max(
      0,
      Number(req.body.start || 0)
    );

    const duration = Math.max(
      0.1,
      Number(req.body.duration || 5)
    );

    const id = randomUUID();
    const outputName = `${id}-trim.mp4`;

    try {
      await runFFmpeg([
        "-y",
        "-ss",
        String(start),
        "-i",
        req.file.path,
        "-t",
        String(duration),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        path.join(OUTPUTS, outputName)
      ]);

      await fs.rm(req.file.path, {
        force: true
      });

      res.json({
        ok: true,
        url: publicUrl(outputName)
      });
    } catch (error) {
      await errorLog(error, {
        route: "/api/studio/trim"
      });

      res.status(500).json({
        ok: false,
        error: "TRIM_ERROR",
        message: error.message
      });
    }
  }
);

app.post(
  "/api/studio/mute",
  requireUser,
  upload.single("video"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "VIDEO_REQUIRED"
      });
    }

    const id = randomUUID();
    const outputName = `${id}-mute.mp4`;

    try {
      await runFFmpeg([
        "-y",
        "-i",
        req.file.path,
        "-c:v",
        "copy",
        "-an",
        path.join(OUTPUTS, outputName)
      ]);

      await fs.rm(req.file.path, {
        force: true
      });

      res.json({
        ok: true,
        url: publicUrl(outputName)
      });
    } catch (error) {
      await errorLog(error, {
        route: "/api/studio/mute"
      });

      res.status(500).json({
        ok: false,
        error: "MUTE_ERROR",
        message: error.message
      });
    }
  }
);

app.post(
  "/api/studio/combine",
  requireUser,
  upload.array("videos", 20),
  async (req, res) => {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({
        ok: false,
        error: "TWO_VIDEOS_REQUIRED"
      });
    }

    const id = randomUUID();
    const listFile = path.join(
      TMP,
      `${id}-concat.txt`
    );

    const outputName =
      `${id}-combined.mp4`;

    try {
      const lines = req.files.map(
        file =>
          `file '${file.path.replace(/'/g, "'\\''")}'`
      );

      await fs.writeFile(
        listFile,
        lines.join("\n"),
        "utf8"
      );

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
        "-c:a",
        "aac",
        path.join(OUTPUTS, outputName)
      ]);

      for (const file of req.files) {
        await fs.rm(file.path, {
          force: true
        });
      }

      await fs.rm(listFile, {
        force: true
      });

      res.json({
        ok: true,
        url: publicUrl(outputName)
      });
    } catch (error) {
      await errorLog(error, {
        route: "/api/studio/combine"
      });

      res.status(500).json({
        ok: false,
        error: "COMBINE_ERROR",
        message: error.message
      });
    }
  }
);

app.post(
  "/api/studio/add-music",
  requireUser,
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "music", maxCount: 1 }
  ]),
  async (req, res) => {
    const video = req.files?.video?.[0];
    const music = req.files?.music?.[0];

    if (!video || !music) {
      return res.status(400).json({
        ok: false,
        error: "VIDEO_AND_MUSIC_REQUIRED"
      });
    }

    const id = randomUUID();
    const outputName =
      `${id}-music.mp4`;

    try {
      await runFFmpeg([
        "-y",
        "-i",
        video.path,
        "-stream_loop",
        "-1",
        "-i",
        music.path,
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-shortest",
        path.join(OUTPUTS, outputName)
      ]);

      await fs.rm(video.path, {
        force: true
      });

      await fs.rm(music.path, {
        force: true
      });

      res.json({
        ok: true,
        url: publicUrl(outputName)
      });
    } catch (error) {
      await errorLog(error, {
        route: "/api/studio/add-music"
      });

      res.status(500).json({
        ok: false,
        error: "MUSIC_ERROR",
        message: error.message
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
    const list = [];

    if (await exists(PROJECTS)) {
      const files = await fs.readdir(
        PROJECTS
      );

      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const data = await readJSON(
          path.join(PROJECTS, file),
          null
        );

        if (
          data &&
          data.userId === req.user.id
        ) {
          list.push(data);
        }
      }
    }

    list.sort(
      (a, b) =>
        new Date(b.updatedAt || b.createdAt) -
        new Date(a.updatedAt || a.createdAt)
    );

    res.json({
      ok: true,
      projects: list
    });
  }
);

app.post(
  "/api/projects",
  requireUser,
  async (req, res) => {
    const id = randomUUID();

    const project = {
      id,
      userId: req.user.id,
      name:
        String(req.body.name || "Untitled Project")
          .trim()
          .slice(0, 150),
      data: req.body.data || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await writeJSON(
      path.join(PROJECTS, `${id}.json`),
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
    const file = path.join(
      PROJECTS,
      `${req.params.id}.json`
    );

    const project = await readJSON(
      file,
      null
    );

    if (
      !project ||
      project.userId !== req.user.id
    ) {
      return res.status(404).json({
        ok: false,
        error: "PROJECT_NOT_FOUND"
      });
    }

    res.json({
      ok: true,
      project
    });
  }
);

app.put(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    const file = path.join(
      PROJECTS,
      `${req.params.id}.json`
    );

    const project = await readJSON(
      file,
      null
    );

    if (
      !project ||
      project.userId !== req.user.id
    ) {
      return res.status(404).json({
        ok: false,
        error: "PROJECT_NOT_FOUND"
      });
    }

    project.name =
      String(
        req.body.name ||
          project.name ||
          "Untitled Project"
      ).slice(0, 150);

    project.data =
      req.body.data ?? project.data;

    project.updatedAt =
      new Date().toISOString();

    await writeJSON(file, project);

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
    const file = path.join(
      PROJECTS,
      `${req.params.id}.json`
    );

    const project = await readJSON(
      file,
      null
    );

    if (
      !project ||
      project.userId !== req.user.id
    ) {
      return res.status(404).json({
        ok: false,
        error: "PROJECT_NOT_FOUND"
      });
    }

    await fs.rm(file, {
      force: true
    });

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   ADMIN LOGIN
   IMPORTANT: THIS FIXES THE ADMIN ACCOUNT PROBLEM
========================================================= */

app.post(
  "/api/admin/login",
  async (req, res) => {
    try {
      const mail = cleanEmail(
        req.body.email
      );

      const password = String(
        req.body.password || ""
      );

      if (!mail || !password) {
        return res.status(400).json({
          ok: false,
          error: "EMAIL_AND_PASSWORD_REQUIRED"
        });
      }

      if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
        return res.status(503).json({
          ok: false,
          error: "ADMIN_NOT_CONFIGURED",
          message:
            "ADMIN_EMAIL and ADMIN_PASSWORD are not configured in Render."
        });
      }

      const users = await readJSON(
        USERS,
        {}
      );

      let admin = Object.values(users).find(
        u => cleanEmail(u.email) === mail
      );

      const masterCredentialsValid =
        mail === ADMIN_EMAIL &&
        password === ADMIN_PASSWORD;

      const existingAdminValid =
        Boolean(
          admin &&
          admin.role === "admin" &&
          !admin.disabled &&
          verifyPassword(
            password,
            admin.salt,
            admin.hash
          )
        );

      if (
        !masterCredentialsValid &&
        !existingAdminValid
      ) {
        await security(
          "ADMIN_LOGIN_FAILED",
          {
            email: mail,
            reason: "INVALID_ADMIN_CREDENTIALS"
          }
        );

        return res.status(401).json({
          ok: false,
          error: "INVALID_ADMIN_CREDENTIALS",
          message:
            "Invalid administrator credentials."
        });
      }

      /*
       * MASTER ADMIN LOGIN
       *
       * If the Render master account already exists,
       * repair it and make sure it is really an admin.
       *
       * If it does not exist, create it.
       */

      if (masterCredentialsValid) {
        if (admin) {
          const hp =
            hashPassword(
              ADMIN_PASSWORD
            );

          admin.email = ADMIN_EMAIL;
          admin.role = "admin";
          admin.disabled = false;
          admin.salt = hp.salt;
          admin.hash = hp.hash;
          admin.lastLoginAt =
            new Date().toISOString();

          users[admin.id] = admin;

          await security(
            "ADMIN_ACCOUNT_REPAIRED",
            {
              userId: admin.id,
              email: admin.email
            }
          );
        } else {
          const id = randomUUID();

          const hp =
            hashPassword(
              ADMIN_PASSWORD
            );

          admin = {
            id,
            name: "MAMAKI Administrator",
            email: ADMIN_EMAIL,
            ...hp,
            role: "admin",
            disabled: false,
            createdAt:
              new Date().toISOString(),
            lastLoginAt:
              new Date().toISOString()
          };

          users[id] = admin;

          await security(
            "ADMIN_ACCOUNT_RESTORED",
            {
              userId: admin.id,
              email: admin.email
            }
          );
        }
      }

      admin.role = "admin";
      admin.disabled = false;
      admin.lastLoginAt =
        new Date().toISOString();

      users[admin.id] = admin;

      await writeJSON(
        USERS,
        users
      );

      /*
       * Remove old/stale admin sessions.
       * This prevents an old broken token from
       * interfering with the new dashboard login.
       */
      await destroyUserSessions(
        admin.id
      );

      const token =
        await createSession(
          admin.id,
          "admin"
        );

      await security(
        "ADMIN_LOGIN_SUCCESS",
        {
          userId: admin.id,
          email: admin.email,
          method:
            masterCredentialsValid
              ? "MASTER_CREDENTIALS"
              : "EXISTING_ADMIN_ACCOUNT"
        }
      );

      res.json({
        ok: true,
        token,
        user: {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          role: "admin"
        }
      });
    } catch (error) {
      await errorLog(error, {
        route: "/api/admin/login"
      });

      res.status(500).json({
        ok: false,
        error: "ADMIN_LOGIN_ERROR",
        message:
          "Administrator login failed."
      });
    }
  }
);

app.post(
  "/api/admin/logout",
  requireAdmin,
  async (req, res) => {
    await destroyUserSessions(
      req.user.id
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   ADMIN API
========================================================= */

app.get(
  "/api/admin/stats",
  requireAdmin,
  async (req, res) => {
    const users = await readJSON(
      USERS,
      {}
    );

    const usage = await readJSON(
      USAGE,
      {}
    );

    const userList =
      Object.values(users);

    let generatedVideos = 0;
    let narrations = 0;

    for (const user of Object.values(
      usage
    )) {
      for (const day of Object.values(
        user || {}
      )) {
        generatedVideos +=
          Number(
            day?.videoGeneration || 0
          );

        narrations +=
          Number(
            day?.narration || 0
          );
      }
    }

    let completed = 0;
    let processing = 0;
    let failed = 0;

    for (const job of jobs.values()) {
      if (job.status === "completed")
        completed++;

      if (job.status === "processing")
        processing++;

      if (job.status === "failed")
        failed++;
    }

    res.json({
      ok: true,
      stats: {
        version: VERSION,
        users: userList.length,
        admins: userList.filter(
          u => u.role === "admin"
        ).length,
        disabledUsers:
          userList.filter(
            u => u.disabled
          ).length,
        generatedVideos,
        narrations,
        jobs: jobs.size,
        completed,
        processing,
        failed,
        replicateConfigured:
          Boolean(REPLICATE_API_TOKEN),
        recoveryConfigured:
          Boolean(
            RESEND_API_KEY &&
            RESEND_FROM
          ),
        adminConfigured:
          Boolean(
            ADMIN_EMAIL &&
            ADMIN_PASSWORD
          )
      }
    });
  }
);

app.get(
  "/api/admin/users",
  requireAdmin,
  async (req, res) => {
    const users = await readJSON(
      USERS,
      {}
    );

    const list =
      Object.values(users)
        .map(user => ({
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          disabled: Boolean(
            user.disabled
          ),
          createdAt: user.createdAt,
          lastLoginAt:
            user.lastLoginAt
        }))
        .sort(
          (a, b) =>
            new Date(
              b.createdAt
            ) -
            new Date(
              a.createdAt
            )
        );

    res.json({
      ok: true,
      users: list
    });
  }
);

app.get(
  "/api/admin/users/:id",
  requireAdmin,
  async (req, res) => {
    const users = await readJSON(
      USERS,
      {}
    );

    const user =
      users[req.params.id];

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "USER_NOT_FOUND"
      });
    }

    res.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        disabled: Boolean(
          user.disabled
        ),
        createdAt: user.createdAt,
        lastLoginAt:
          user.lastLoginAt
      }
    });
  }
);

app.post(
  "/api/admin/users/:id/disable",
  requireAdmin,
  async (req, res) => {
    const users = await readJSON(
      USERS,
      {}
    );

    const user =
      users[req.params.id];

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "USER_NOT_FOUND"
      });
    }

    /*
     * Never allow the main configured
     * administrator to be disabled.
     */
    if (
      cleanEmail(user.email) ===
      ADMIN_EMAIL
    ) {
      return res.status(400).json({
        ok: false,
        error: "MAIN_ADMIN_PROTECTED",
        message:
          "The main administrator cannot be disabled."
      });
    }

    user.disabled =
      Boolean(
        req.body.disabled
      );

    users[user.id] = user;

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
      user.disabled
        ? "USER_DISABLED"
        : "USER_ENABLED",
      {
        targetUserId: user.id,
        adminId: req.user.id
      }
    );

    res.json({
      ok: true,
      disabled:
        user.disabled
    });
  }
);

app.get(
  "/api/admin/jobs",
  requireAdmin,
  async (req, res) => {
    const list =
      [...jobs.values()]
        .sort(
          (a, b) =>
            new Date(b.createdAt) -
            new Date(a.createdAt)
        )
        .slice(0, 200);

    res.json({
      ok: true,
      jobs: list
    });
  }
);

app.get(
  "/api/admin/errors",
  requireAdmin,
  async (req, res) => {
    const errors = await readJSON(
      ERRORS,
      []
    );

    res.json({
      ok: true,
      errors: errors.slice(0, 200)
    });
  }
);

app.get(
  "/api/admin/security",
  requireAdmin,
  async (req, res) => {
    const events = await readJSON(
      SECURITY,
      []
    );

    res.json({
      ok: true,
      events: events.slice(0, 300)
    });
  }
);

/* =========================================================
   ADMIN DASHBOARD
   IMPORTANT:
   NO NESTED BACKTICKS ARE USED HERE.
   This prevents the previous SyntaxError.
========================================================= */

app.get("/admin", async (req, res) => {
  const adminEmailForBrowser =
    JSON.stringify(
      ADMIN_EMAIL || ""
    );

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>MAMAKI AI Admin</title>
<style>
*{box-sizing:border-box}
body{
margin:0;
font-family:Arial,Helvetica,sans-serif;
background:#0b0d12;
color:#fff;
}
button,input{
font:inherit;
}
.wrap{
max-width:1250px;
margin:auto;
padding:20px;
}
.card{
background:#151923;
border:1px solid #272d3a;
border-radius:16px;
padding:20px;
margin-bottom:18px;
box-shadow:0 10px 35px rgba(0,0,0,.18);
}
.login{
max-width:460px;
margin:8vh auto;
}
h1,h2,h3{
margin-top:0;
}
input{
width:100%;
padding:13px;
border-radius:10px;
border:1px solid #353b49;
background:#0d1017;
color:#fff;
margin:7px 0 12px;
outline:none;
}
button{
border:0;
border-radius:10px;
padding:11px 15px;
cursor:pointer;
background:#6d5dfc;
color:#fff;
font-weight:700;
}
button.secondary{
background:#292f3c;
}
button.danger{
background:#c93b4b;
}
.hidden{
display:none!important;
}
.grid{
display:grid;
grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
gap:14px;
}
.stat{
background:#10131b;
border:1px solid #282e3a;
border-radius:13px;
padding:18px;
}
.stat strong{
font-size:28px;
display:block;
margin-top:7px;
}
.muted{
color:#9aa2b1;
}
.table-wrap{
overflow:auto;
}
table{
width:100%;
border-collapse:collapse;
}
th,td{
padding:12px;
border-bottom:1px solid #282e3a;
text-align:left;
font-size:14px;
}
.badge{
display:inline-block;
padding:5px 9px;
border-radius:20px;
background:#292f3c;
font-size:12px;
}
.badge.admin{
background:#4d3ba8;
}
.badge.disabled{
background:#7d2935;
}
.top{
display:flex;
align-items:center;
justify-content:space-between;
gap:15px;
margin-bottom:20px;
}
pre{
white-space:pre-wrap;
word-break:break-word;
background:#090b10;
padding:12px;
border-radius:10px;
overflow:auto;
}
.error{
color:#ff7785;
margin-top:10px;
}
.success{
color:#65d391;
margin-top:10px;
}
small{
color:#8d95a5;
}
</style>
</head>
<body>

<div id="loginPage" class="wrap">
<div class="card login">
<h1>✨ MAMAKI AI</h1>
<h2>Administrator Login</h2>
<p class="muted">
Sign in with your administrator account.
</p>

<form id="loginForm">
<label>Email</label>
<input
id="email"
type="email"
autocomplete="username"
placeholder="Administrator email"
required
>

<label>Password</label>
<input
id="password"
type="password"
autocomplete="current-password"
placeholder="Administrator password"
required
>

<button type="submit">Sign in to Admin</button>
</form>

<div id="loginMessage"></div>

<p>
<small>
Your normal MAMAKI user password will work here
if that account has administrator privileges.
The Render ADMIN_EMAIL / ADMIN_PASSWORD credentials
can also repair the main administrator account.
</small>
</p>
</div>
</div>

<div id="dashboard" class="wrap hidden">

<div class="top">
<div>
<h1>✨ MAMAKI AI Admin</h1>
<div class="muted">
Administrator Control Center
</div>
</div>

<button
id="logoutButton"
class="secondary"
>
Logout
</button>
</div>

<div class="grid" id="stats"></div>

<div class="card">
<h2>Users</h2>
<div class="table-wrap">
<table>
<thead>
<tr>
<th>Name</th>
<th>Email</th>
<th>Role</th>
<th>Status</th>
<th>Created</th>
<th>Action</th>
</tr>
</thead>
<tbody id="usersBody"></tbody>
</table>
</div>
</div>

<div class="card">
<h2>Jobs</h2>
<div class="table-wrap">
<table>
<thead>
<tr>
<th>ID</th>
<th>User</th>
<th>Type</th>
<th>Status</th>
<th>Progress</th>
<th>Message</th>
</tr>
</thead>
<tbody id="jobsBody"></tbody>
</table>
</div>
</div>

<div class="card">
<h2>Security Activity</h2>
<pre id="securityBox">Loading...</pre>
</div>

<div class="card">
<h2>Errors</h2>
<pre id="errorsBox">Loading...</pre>
</div>

</div>

<script>
var ADMIN_EMAIL = ${adminEmailForBrowser};
var TOKEN_KEY = "mamaki_admin_token";

function byId(id){
  return document.getElementById(id);
}

function escapeHtml(value){
  return String(value == null ? "" : value)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

function token(){
  return localStorage.getItem(TOKEN_KEY) || "";
}

function showLogin(){
  byId("loginPage").classList.remove("hidden");
  byId("dashboard").classList.add("hidden");
}

function showDashboard(){
  byId("loginPage").classList.add("hidden");
  byId("dashboard").classList.remove("hidden");
  loadDashboard();
}

async function api(url, options){
  options = options || {};
  options.headers = options.headers || {};

  options.headers["Content-Type"] =
    "application/json";

  if(token()){
    options.headers["Authorization"] =
      "Bearer " + token();
  }

  var response = await fetch(
    url,
    options
  );

  var data = {};

  try{
    data = await response.json();
  }catch(e){}

  if(
    response.status === 401 ||
    response.status === 403
  ){
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
    throw new Error(
      "Administrator session expired."
    );
  }

  if(!response.ok){
    throw new Error(
      data.message ||
      data.error ||
      "Request failed."
    );
  }

  return data;
}

byId("loginForm").addEventListener(
  "submit",
  async function(event){
    event.preventDefault();

    var message = byId("loginMessage");

    message.className = "muted";
    message.textContent =
      "Signing in...";

    try{
      var result = await fetch(
        "/api/admin/login",
        {
          method:"POST",
          headers:{
            "Content-Type":
              "application/json"
          },
          body:JSON.stringify({
            email:byId("email").value,
            password:byId("password").value
          })
        }
      );

      var data = await result.json();

      if(!result.ok){
        throw new Error(
          data.message ||
          data.error ||
          "Invalid administrator credentials."
        );
      }

      localStorage.setItem(
        TOKEN_KEY,
        data.token
      );

      message.className = "success";
      message.textContent =
        "Login successful.";

      showDashboard();

    }catch(error){
      message.className = "error";
      message.textContent =
        error.message;
    }
  }
);

byId("logoutButton").addEventListener(
  "click",
  async function(){
    try{
      await api(
        "/api/admin/logout",
        {
          method:"POST"
        }
      );
    }catch(e){}

    localStorage.removeItem(
      TOKEN_KEY
    );

    showLogin();
  }
);

async function loadStats(){
  var data =
    await api("/api/admin/stats");

  var s = data.stats;

  byId("stats").innerHTML =
    '<div class="stat"><span class="muted">Users</span><strong>' +
    escapeHtml(s.users) +
    '</strong></div>' +

    '<div class="stat"><span class="muted">Admins</span><strong>' +
    escapeHtml(s.admins) +
    '</strong></div>' +

    '<div class="stat"><span class="muted">Videos Generated</span><strong>' +
    escapeHtml(s.generatedVideos) +
    '</strong></div>' +

    '<div class="stat"><span class="muted">Narrations</span><strong>' +
    escapeHtml(s.narrations) +
    '</strong></div>' +

    '<div class="stat"><span class="muted">Completed Jobs</span><strong>' +
    escapeHtml(s.completed) +
    '</strong></div>' +

    '<div class="stat"><span class="muted">Processing</span><strong>' +
    escapeHtml(s.processing) +
    '</strong></div>' +

    '<div class="stat"><span class="muted">Failed Jobs</span><strong>' +
    escapeHtml(s.failed) +
    '</strong></div>' +

    '<div class="stat"><span class="muted">Replicate</span><strong>' +
    (s.replicateConfigured ? "ON" : "OFF") +
    '</strong></div>';
}

async function loadUsers(){
  var data =
    await api("/api/admin/users");

  var body =
    byId("usersBody");

  body.innerHTML =
    data.users.map(
      function(user){
        var roleClass =
          user.role === "admin"
            ? "badge admin"
            : "badge";

        var status =
          user.disabled
            ? '<span class="badge disabled">Disabled</span>'
            : '<span class="badge">Active</span>';

        var mainAdmin =
          String(user.email).toLowerCase() ===
          String(ADMIN_EMAIL).toLowerCase();

        var action = mainAdmin
          ? '<span class="muted">Protected</span>'
          : (
            '<button class="' +
            (user.disabled ? "" : "danger") +
            '" onclick="toggleUser(\\'' +
            escapeHtml(user.id) +
            '\\',' +
            (!user.disabled) +
            ')">' +
            (user.disabled ? "Enable" : "Disable") +
            '</button>'
          );

        return (
          "<tr>" +
          "<td>" +
          escapeHtml(user.name) +
          "</td>" +

          "<td>" +
          escapeHtml(user.email) +
          "</td>" +

          "<td>" +
          '<span class="' +
          roleClass +
          '">' +
          escapeHtml(user.role) +
          "</span>" +
          "</td>" +

          "<td>" +
          status +
          "</td>" +

          "<td>" +
          escapeHtml(
            user.createdAt || ""
          ) +
          "</td>" +

          "<td>" +
          action +
          "</td>" +

          "</tr>"
        );
      }
    ).join("");
}

async function toggleUser(id, disabled){
  try{
    await api(
      "/api/admin/users/" +
      encodeURIComponent(id) +
      "/disable",
      {
        method:"POST",
        body:JSON.stringify({
          disabled:disabled
        })
      }
    );

    await loadUsers();
    await loadStats();

  }catch(error){
    alert(error.message);
  }
}

async function loadJobs(){
  var data =
    await api("/api/admin/jobs");

  byId("jobsBody").innerHTML =
    data.jobs.map(
      function(job){
        return (
          "<tr>" +

          "<td>" +
          escapeHtml(
            String(job.id).slice(0,12)
          ) +
          "</td>" +

          "<td>" +
          escapeHtml(job.userId) +
          "</td>" +

          "<td>" +
          escapeHtml(job.type) +
          "</td>" +

          "<td>" +
          escapeHtml(job.status) +
          "</td>" +

          "<td>" +
          escapeHtml(job.progress) +
          "%</td>" +

          "<td>" +
          escapeHtml(job.message) +
          "</td>" +

          "</tr>"
        );
      }
    ).join("");
}

async function loadSecurity(){
  var data =
    await api(
      "/api/admin/security"
    );

  byId("securityBox").textContent =
    JSON.stringify(
      data.events,
      null,
      2
    );
}

async function loadErrors(){
  var data =
    await api(
      "/api/admin/errors"
    );

  byId("errorsBox").textContent =
    JSON.stringify(
      data.errors,
      null,
      2
    );
}

async function loadDashboard(){
  try{
    await loadStats();
    await loadUsers();
    await loadJobs();
    await loadSecurity();
    await loadErrors();
  }catch(error){
    console.error(error);
  }
}

if(token()){
  showDashboard();
}else{
  showLogin();
}
</script>

</body>
</html>
`;

  res.type("html").send(html);
});

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  async (req, res) => {
    res.json({
      ok: true,
      app: "MAMAKI AI",
      version: VERSION,
      replicate:
        Boolean(REPLICATE_API_TOKEN),
      recovery:
        Boolean(
          RESEND_API_KEY &&
          RESEND_FROM
        ),
      admin:
        Boolean(
          ADMIN_EMAIL &&
          ADMIN_PASSWORD
        ),
      uptime: process.uptime(),
      timestamp:
        new Date().toISOString()
    });
  }
);

app.get(
  "/api/status",
  async (req, res) => {
    res.json({
      ok: true,
      app: "MAMAKI AI",
      version: VERSION,
      models: {
        t2v: T2V_MODEL,
        i2v: I2V_MODEL
      },
      duration: {
        min: MIN_DURATION,
        max: MAX_DURATION
      },
      features: {
        textToVideo: true,
        imageToVideo: true,
        freeStudio: true,
        narration: true,
        projects: true,
        admin: Boolean(
          ADMIN_EMAIL &&
          ADMIN_PASSWORD
        )
      }
    });
  }
);

/* =========================================================
   ROOT
========================================================= */

app.get("/", async (req, res) => {
  res.sendFile(
    path.join(ROOT, "index.html")
  );
});

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  if (
    req.path.startsWith("/api/")
  ) {
    return res.status(404).json({
      ok: false,
      error: "NOT_FOUND"
    });
  }

  res.status(404).send(
    "MAMAKI AI: Page not found."
  );
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(async (error, req, res, next) => {
  await errorLog(error, {
    route: req.path,
    method: req.method
  });

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    ok: false,
    error: "SERVER_ERROR",
    message:
      error.message ||
      "Internal server error."
  });
});

/* =========================================================
   STARTUP
========================================================= */

async function cleanupOldFiles() {
  await ensureDir(TMP);
  await ensureDir(OUTPUTS);
  await ensureDir(PROJECTS);
  await ensureDir(DATA);

  const files = await fs.readdir(TMP);

  const cutoff =
    Date.now() -
    24 * 60 * 60 * 1000;

  for (const file of files) {
    const full =
      path.join(TMP, file);

    try {
      const stat =
        await fs.stat(full);

      if (
        stat.mtimeMs < cutoff
      ) {
        await fs.rm(full, {
          force: true,
          recursive: true
        });
      }
    } catch {}
  }
}

async function init() {
  await ensureDir(TMP);
  await ensureDir(OUTPUTS);
  await ensureDir(PROJECTS);
  await ensureDir(DATA);

  if (!(await exists(USERS))) {
    await writeJSON(USERS, {});
  }

  if (!(await exists(SESSIONS))) {
    await writeJSON(SESSIONS, {});
  }

  if (!(await exists(USAGE))) {
    await writeJSON(USAGE, {});
  }

  if (!(await exists(ERRORS))) {
    await writeJSON(ERRORS, []);
  }

  if (!(await exists(SECURITY))) {
    await writeJSON(SECURITY, []);
  }

  if (!(await exists(RESETS))) {
    await writeJSON(RESETS, {});
  }

  await cleanupOldFiles();

  app.listen(
    PORT,
    HOST,
    () => {
      console.log(
        `✨ MAMAKI AI ${VERSION}`
      );

      console.log(
        `Server listening on ${HOST}:${PORT}`
      );

      console.log(
        `App URL: ${APP_URL}`
      );

      console.log(
        `Replicate configured: ${Boolean(
          REPLICATE_API_TOKEN
        )}`
      );

      console.log(
        `Password recovery configured: ${Boolean(
          RESEND_API_KEY &&
          RESEND_FROM
        )}`
      );

      console.log(
        `Admin configured: ${Boolean(
          ADMIN_EMAIL &&
          ADMIN_PASSWORD
        )}`
      );

      console.log(
        `T2V model: ${T2V_MODEL}`
      );

      console.log(
        `I2V model: ${I2V_MODEL}`
      );

      console.log(
        `Duration range: ${MIN_DURATION}s - ${MAX_DURATION}s`
      );
    }
  );
}

init().catch(error => {
  console.error(
    "MAMAKI startup failed:",
    error
  );

  process.exit(1);
});
