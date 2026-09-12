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

/* =========================================================
   MAMAKI AI VIDEO
   COMPLETE SERVER
   VERSION 15.0.0

   Includes:
   - User registration/login
   - Existing account authentication
   - Admin authentication
   - Admin dashboard
   - Admin account repair
   - Replicate WAN 2.2 T2V
   - Replicate WAN 2.2 I2V
   - 5 seconds - 2 hours duration handling
   - 16:9 / 9:16 / 1:1
   - Projects
   - Video library
   - Free Studio
   - Trim
   - Combine
   - Mute
   - Add music
   - AI narration
   - Password recovery
   - Security logs
   - Error logs
   - Usage tracking
   - Jobs
   - MAMAKI watermark
========================================================= */

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const VERSION = "15.0.0";

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

const ADMIN_EMAIL =
  String(process.env.ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();

const ADMIN_PASSWORD =
  String(process.env.ADMIN_PASSWORD || "");

const SESSION_SECRET =
  String(process.env.SESSION_SECRET || "");

const REPLICATE_API_TOKEN =
  String(process.env.REPLICATE_API_TOKEN || "")
    .trim();

const RESEND_API_KEY =
  String(process.env.RESEND_API_KEY || "")
    .trim();

const RESEND_FROM =
  String(process.env.RESEND_FROM || "")
    .trim();

const APP_URL =
  String(
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

const jobs = new Map();

const upload = multer({
  dest: TMP,
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  "/outputs",
  express.static(OUTPUTS, {
    maxAge: "1h"
  })
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

async function readJSON(file, fallback = {}) {
  try {
    const text = await fs.readFile(file, "utf8");

    if (!text.trim()) {
      return fallback;
    }

    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJSON(file, data) {
  const temp =
    `${file}.${process.pid}.${Date.now()}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  await fs.rename(temp, file);
}

async function ensureJSON(file) {
  if (!(await exists(file))) {
    await writeJSON(file, {});
  }
}

async function ensureStorage() {
  await Promise.all([
    ensureDir(TMP),
    ensureDir(OUTPUTS),
    ensureDir(PROJECTS),
    ensureDir(DATA)
  ]);

  await Promise.all([
    ensureJSON(USERS),
    ensureJSON(SESSIONS),
    ensureJSON(USAGE),
    ensureJSON(ERRORS),
    ensureJSON(SECURITY),
    ensureJSON(RESETS)
  ]);
}

function email(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function safeName(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function normalizeDuration(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return 5;
  }

  if (typeof value === "number") {
    return Math.max(
      MIN_DURATION,
      Math.min(MAX_DURATION, Math.round(value))
    );
  }

  const text =
    String(value)
      .trim()
      .toLowerCase();

  if (text.endsWith("h")) {
    const n =
      Number(text.slice(0, -1));

    return Math.max(
      MIN_DURATION,
      Math.min(MAX_DURATION, Math.round(n * 3600))
    );
  }

  if (text.endsWith("m")) {
    const n =
      Number(text.slice(0, -1));

    return Math.max(
      MIN_DURATION,
      Math.min(MAX_DURATION, Math.round(n * 60))
    );
  }

  if (text.endsWith("s")) {
    const n =
      Number(text.slice(0, -1));

    return Math.max(
      MIN_DURATION,
      Math.min(MAX_DURATION, Math.round(n))
    );
  }

  const n = Number(text);

  if (!Number.isFinite(n)) {
    return 5;
  }

  return Math.max(
    MIN_DURATION,
    Math.min(MAX_DURATION, Math.round(n))
  );
}

function publicUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role || "user",
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null
  };
}

/* =========================================================
   PASSWORDS
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
    if (!salt || !storedHash) {
      return false;
    }

    const hash =
      scryptSync(
        String(password),
        salt,
        64
      );

    const stored =
      Buffer.from(
        storedHash,
        "hex"
      );

    return (
      stored.length === hash.length &&
      timingSafeEqual(
        stored,
        hash
      )
    );
  } catch {
    return false;
  }
}

/* =========================================================
   LOGGING
========================================================= */

async function appendJSONLog(
  file,
  item,
  maxItems = 2000
) {
  const data =
    await readJSON(file, []);

  const list =
    Array.isArray(data)
      ? data
      : [];

  list.unshift({
    id: randomUUID(),
    timestamp:
      new Date().toISOString(),
    ...item
  });

  await writeJSON(
    file,
    list.slice(0, maxItems)
  );
}

async function security(action, details = {}) {
  try {
    await appendJSONLog(
      SECURITY,
      {
        action,
        ...details
      }
    );
  } catch {}
}

async function errorLog(error, details = {}) {
  try {
    await appendJSONLog(
      ERRORS,
      {
        message:
          error?.message ||
          String(error),
        stack:
          error?.stack ||
          null,
        ...details
      }
    );
  } catch {}

  console.error(
    "[MAMAKI ERROR]",
    error
  );
}

/* =========================================================
   SESSIONS
========================================================= */

const SESSION_DAYS = 30;

function sessionHash(token) {
  return createHash("sha256")
    .update(
      `${SESSION_SECRET}:${token}`
    )
    .digest("hex");
}

async function createSession(
  userId,
  role = "user"
) {
  const token =
    randomBytes(48).toString("hex");

  const sessions =
    await readJSON(
      SESSIONS,
      {}
    );

  const now =
    Date.now();

  sessions[sessionHash(token)] = {
    id: randomUUID(),
    userId,
    role,
    createdAt:
      new Date(now).toISOString(),
    expiresAt:
      new Date(
        now +
        SESSION_DAYS *
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

async function destroySession(token) {
  if (!token) {
    return;
  }

  const sessions =
    await readJSON(
      SESSIONS,
      {}
    );

  delete sessions[
    sessionHash(token)
  ];

  await writeJSON(
    SESSIONS,
    sessions
  );
}

async function destroyUserSessions(
  userId
) {
  const sessions =
    await readJSON(
      SESSIONS,
      {}
    );

  const now =
    Date.now();

  for (const [key, session] of
    Object.entries(sessions)) {

    if (
      !session ||
      session.userId === userId ||
      Date.parse(
        session.expiresAt || ""
      ) <= now
    ) {
      delete sessions[key];
    }
  }

  await writeJSON(
    SESSIONS,
    sessions
  );
}

async function currentUser(req) {
  const auth =
    String(
      req.headers.authorization ||
      ""
    );

  if (
    !auth.startsWith(
      "Bearer "
    )
  ) {
    return null;
  }

  const token =
    auth.slice(7).trim();

  if (!token) {
    return null;
  }

  const sessions =
    await readJSON(
      SESSIONS,
      {}
    );

  const session =
    sessions[
      sessionHash(token)
    ];

  if (!session) {
    return null;
  }

  if (
    Date.parse(
      session.expiresAt || ""
    ) <= Date.now()
  ) {
    delete sessions[
      sessionHash(token)
    ];

    await writeJSON(
      SESSIONS,
      sessions
    );

    return null;
  }

  const users =
    await readJSON(
      USERS,
      {}
    );

  const user =
    users[session.userId];

  if (!user) {
    return null;
  }

  if (user.disabled) {
    return null;
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
      return res.status(401).json({
        ok: false,
        error: "UNAUTHORIZED",
        message:
          "Please log in."
      });
    }

    req.user = user;

    next();
  } catch (e) {
    await errorLog(e, {
      route: req.path
    });

    return res.status(500).json({
      ok: false,
      error: "AUTH_ERROR"
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

    if (
      !user ||
      user.role !== "admin"
    ) {
      return res.status(403).json({
        ok: false,
        error: "ADMIN_REQUIRED",
        message:
          "Administrator access required."
      });
    }

    req.user = user;

    next();
  } catch (e) {
    await errorLog(e, {
      route: req.path
    });

    return res.status(500).json({
      ok: false,
      error: "ADMIN_AUTH_ERROR"
    });
  }
}

/* =========================================================
   USAGE
========================================================= */

async function recordUsage(
  userId,
  type,
  extra = {}
) {
  const usage =
    await readJSON(
      USAGE,
      {}
    );

  if (!usage[userId]) {
    usage[userId] = {
      totalGenerations: 0,
      totalSeconds: 0,
      t2v: 0,
      i2v: 0,
      narration: 0,
      studio: 0,
      history: []
    };
  }

  const u =
    usage[userId];

  u.totalGenerations += 1;

  if (
    Number.isFinite(
      Number(extra.duration)
    )
  ) {
    u.totalSeconds +=
      Number(extra.duration);
  }

  if (type === "t2v") {
    u.t2v += 1;
  }

  if (type === "i2v") {
    u.i2v += 1;
  }

  if (type === "narration") {
    u.narration += 1;
  }

  if (type === "studio") {
    u.studio += 1;
  }

  u.history.unshift({
    id: randomUUID(),
    type,
    duration:
      Number(extra.duration) || 0,
    createdAt:
      new Date().toISOString()
  });

  u.history =
    u.history.slice(0, 500);

  await writeJSON(
    USAGE,
    usage
  );
}

/* =========================================================
   USERS
========================================================= */

app.post(
  "/api/auth/register",
  async (req, res) => {
    try {
      const name =
        String(
          req.body.name || ""
        ).trim();

      const mail =
        email(
          req.body.email
        );

      const password =
        String(
          req.body.password || ""
        );

      if (!name) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_NAME",
          message:
            "Name is required."
        });
      }

      if (
        !mail ||
        !mail.includes("@")
      ) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_EMAIL",
          message:
            "Enter a valid email address."
        });
      }

      if (password.length < 6) {
        return res.status(400).json({
          ok: false,
          error: "WEAK_PASSWORD",
          message:
            "Password must be at least 6 characters."
        });
      }

      const users =
        await readJSON(
          USERS,
          {}
        );

      const existing =
        Object.values(users).find(
          u =>
            email(u.email) === mail
        );

      if (existing) {
        return res.status(409).json({
          ok: false,
          error: "EMAIL_EXISTS",
          message:
            "An account with this email already exists."
        });
      }

      const hp =
        hashPassword(password);

      const id =
        randomUUID();

      const user = {
        id,
        name,
        email: mail,
        ...hp,
        role: "user",
        disabled: false,
        createdAt:
          new Date().toISOString(),
        lastLoginAt: null
      };

      users[id] = user;

      await writeJSON(
        USERS,
        users
      );

      await security(
        "ACCOUNT_CREATED",
        {
          userId: id,
          email: mail
        }
      );

      const token =
        await createSession(
          id,
          "user"
        );

      return res.json({
        ok: true,
        token,
        user:
          publicUser(user)
      });
    } catch (e) {
      await errorLog(e, {
        route:
          "/api/auth/register"
      });

      return res.status(500).json({
        ok: false,
        error:
          "REGISTRATION_ERROR"
      });
    }
  }
);

app.post(
  "/api/auth/login",
  async (req, res) => {
    try {
      const mail =
        email(
          req.body.email
        );

      const password =
        String(
          req.body.password || ""
        );

      if (!mail || !password) {
        return res.status(400).json({
          ok: false,
          error:
            "MISSING_CREDENTIALS"
        });
      }

      const users =
        await readJSON(
          USERS,
          {}
        );

      const user =
        Object.values(users).find(
          u =>
            email(u.email) === mail
        );

      if (!user) {
        return res.status(401).json({
          ok: false,
          error:
            "INVALID_CREDENTIALS",
          message:
            "Invalid email or password."
        });
      }

      if (user.disabled) {
        return res.status(403).json({
          ok: false,
          error: "ACCOUNT_DISABLED",
          message:
            "This account has been disabled."
        });
      }

      if (
        !verifyPassword(
          password,
          user.salt,
          user.hash
        )
      ) {
        await security(
          "LOGIN_FAILED",
          {
            email: mail
          }
        );

        return res.status(401).json({
          ok: false,
          error:
            "INVALID_CREDENTIALS",
          message:
            "Invalid email or password."
        });
      }

      user.lastLoginAt =
        new Date().toISOString();

      users[user.id] =
        user;

      await writeJSON(
        USERS,
        users
      );

      const token =
        await createSession(
          user.id,
          user.role || "user"
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

      return res.json({
        ok: true,
        token,
        user:
          publicUser(user)
      });
    } catch (e) {
      await errorLog(e, {
        route:
          "/api/auth/login"
      });

      return res.status(500).json({
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
      const auth =
        String(
          req.headers.authorization ||
          ""
        );

      if (
        auth.startsWith(
          "Bearer "
        )
      ) {
        await destroySession(
          auth.slice(7).trim()
        );
      }

      return res.json({
        ok: true
      });
    } catch {
      return res.json({
        ok: true
      });
    }
  }
);

app.get(
  "/api/auth/me",
  requireUser,
  async (req, res) => {
    return res.json({
      ok: true,
      user:
        publicUser(req.user)
    });
  }
);

/* =========================================================
   PROFILE
========================================================= */

app.get(
  "/api/account",
  requireUser,
  async (req, res) => {
    const usage =
      await readJSON(
        USAGE,
        {}
      );

    return res.json({
      ok: true,
      user:
        publicUser(req.user),
      usage:
        usage[req.user.id] || {
          totalGenerations: 0,
          totalSeconds: 0,
          t2v: 0,
          i2v: 0,
          narration: 0
        }
    });
  }
);

app.post(
  "/api/account/profile",
  requireUser,
  async (req, res) => {
    try {
      const name =
        String(
          req.body.name || ""
        ).trim();

      if (!name) {
        return res.status(400).json({
          ok: false,
          error:
            "NAME_REQUIRED"
        });
      }

      const users =
        await readJSON(
          USERS,
          {}
        );

      const user =
        users[req.user.id];

      if (!user) {
        return res.status(404).json({
          ok: false,
          error:
            "USER_NOT_FOUND"
        });
      }

      user.name =
        name.slice(0, 100);

      users[user.id] =
        user;

      await writeJSON(
        USERS,
        users
      );

      return res.json({
        ok: true,
        user:
          publicUser(user)
      });
    } catch (e) {
      await errorLog(e);

      return res.status(500).json({
        ok: false,
        error:
          "PROFILE_UPDATE_ERROR"
      });
    }
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
        newPassword.length < 6
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "WEAK_PASSWORD",
          message:
            "New password must be at least 6 characters."
        });
      }

      if (
        !verifyPassword(
          currentPassword,
          req.user.salt,
          req.user.hash
        )
      ) {
        return res.status(401).json({
          ok: false,
          error:
            "CURRENT_PASSWORD_INVALID"
        });
      }

      const users =
        await readJSON(
          USERS,
          {}
        );

      const user =
        users[req.user.id];

      const hp =
        hashPassword(
          newPassword
        );

      user.salt =
        hp.salt;

      user.hash =
        hp.hash;

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
            user.id,
          email:
            user.email
        }
      );

      return res.json({
        ok: true,
        message:
          "Password changed successfully. Please log in again."
      });
    } catch (e) {
      await errorLog(e);

      return res.status(500).json({
        ok: false,
        error:
          "PASSWORD_CHANGE_ERROR"
      });
    }
  }
);

/* =========================================================
   PASSWORD RECOVERY
========================================================= */

async function sendRecoveryEmail(
  to,
  resetUrl
) {
  if (
    !RESEND_API_KEY ||
    !RESEND_FROM
  ) {
    return false;
  }

  try {
    const response =
      await fetch(
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: {
            "Authorization":
              `Bearer ${RESEND_API_KEY}`,
            "Content-Type":
              "application/json"
          },
          body:
            JSON.stringify({
              from:
                RESEND_FROM,
              to: [to],
              subject:
                "MAMAKI AI password reset",
              html: `
                <div style="font-family:Arial,sans-serif">
                  <h2>MAMAKI AI</h2>
                  <p>You requested a password reset.</p>
                  <p>
                    <a href="${resetUrl}">
                      Reset your password
                    </a>
                  </p>
                  <p>This link expires in 30 minutes.</p>
                </div>
              `
            })
        }
      );

    return response.ok;
  } catch {
    return false;
  }
}

app.post(
  "/api/auth/forgot-password",
  async (req, res) => {
    try {
      const mail =
        email(
          req.body.email
        );

      const users =
        await readJSON(
          USERS,
          {}
        );

      const user =
        Object.values(users).find(
          u =>
            email(u.email) === mail
        );

      if (user) {
        const resets =
          await readJSON(
            RESETS,
            {}
          );

        const token =
          randomBytes(32)
            .toString("hex");

        resets[
          createHash("sha256")
            .update(token)
            .digest("hex")
        ] = {
          userId:
            user.id,
          expiresAt:
            new Date(
              Date.now() +
              30 * 60 * 1000
            ).toISOString()
        };

        await writeJSON(
          RESETS,
          resets
        );

        const resetUrl =
          `${APP_URL}/reset-password?token=${token}`;

        const sent =
          await sendRecoveryEmail(
            user.email,
            resetUrl
          );

        if (!sent) {
          console.log(
            "[MAMAKI] Recovery email is not configured."
          );
        }

        await security(
          "PASSWORD_RESET_REQUESTED",
          {
            userId:
              user.id,
            email:
              user.email
          }
        );
      }

      return res.json({
        ok: true,
        message:
          "If the email exists, password recovery instructions have been sent."
      });
    } catch (e) {
      await errorLog(e);

      return res.status(500).json({
        ok: false,
        error:
          "RECOVERY_ERROR"
      });
    }
  }
);

app.post(
  "/api/auth/reset-password",
  async (req, res) => {
    try {
      const token =
        String(
          req.body.token || ""
        );

      const password =
        String(
          req.body.password || ""
        );

      if (
        password.length < 6
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "WEAK_PASSWORD"
        });
      }

      const resets =
        await readJSON(
          RESETS,
          {}
        );

      const key =
        createHash("sha256")
          .update(token)
          .digest("hex");

      const record =
        resets[key];

      if (
        !record ||
        Date.parse(
          record.expiresAt
        ) <= Date.now()
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "RESET_TOKEN_INVALID",
          message:
            "This reset link is invalid or expired."
        });
      }

      const users =
        await readJSON(
          USERS,
          {}
        );

      const user =
        users[record.userId];

      if (!user) {
        return res.status(404).json({
          ok: false,
          error:
            "USER_NOT_FOUND"
        });
      }

      const hp =
        hashPassword(password);

      user.salt =
        hp.salt;

      user.hash =
        hp.hash;

      users[user.id] =
        user;

      await writeJSON(
        USERS,
        users
      );

      delete resets[key];

      await writeJSON(
        RESETS,
        resets
      );

      await destroyUserSessions(
        user.id
      );

      await security(
        "PASSWORD_RESET_COMPLETED",
        {
          userId:
            user.id,
          email:
            user.email
        }
      );

      return res.json({
        ok: true,
        message:
          "Password reset successfully."
      });
    } catch (e) {
      await errorLog(e);

      return res.status(500).json({
        ok: false,
        error:
          "RESET_ERROR"
      });
    }
  }
);

/* =========================================================
   FFMPEG
========================================================= */

function runFFmpeg(args) {
  return new Promise(
    (resolve, reject) => {
      const child =
        spawn(
          ffmpegPath,
          args,
          {
            windowsHide: true
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
            resolve({
              ok: true,
              stderr
            });
          } else {
            const error =
              new Error(
                `FFmpeg exited with code ${code}`
              );

            error.stderr =
              stderr;

            reject(error);
          }
        }
      );
    }
  );
}

async function getVideoDuration(
  file
) {
  return new Promise(
    (resolve, reject) => {
      const child =
        spawn(
          ffmpegPath,
          [
            "-i",
            file
          ],
          {
            windowsHide: true
          }
        );

      let text = "";

      child.stderr.on(
        "data",
        chunk => {
          text +=
            chunk.toString();
        }
      );

      child.on(
        "error",
        reject
      );

      child.on(
        "close",
        () => {
          const match =
            text.match(
              /Duration:\s*(\d+):(\d+):([\d.]+)/
            );

          if (!match) {
            return resolve(0);
          }

          resolve(
            Number(match[1]) *
              3600 +
            Number(match[2]) *
              60 +
            Number(match[3])
          );
        }
      );
    }
  );
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
    "drawtext=text='MAMAKI':x=20:y=20:fontsize=26:fontcolor=white@0.75:box=1:boxcolor=black@0.25:boxborderw=8",
    "-c:a",
    "copy",
    output
  ]);
}

async function makeExactDuration(
  input,
  output,
  duration
) {
  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-t",
    String(duration),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    output
  ]);
}

/* =========================================================
   REPLICATE VIDEO
========================================================= */

async function downloadReplicateOutput(
  output,
  target
) {
  let url = null;

  if (
    typeof output === "string"
  ) {
    url = output;
  } else if (
    output &&
    typeof output.url === "function"
  ) {
    url =
      String(
        await output.url()
      );
  } else if (
    output &&
    output.url
  ) {
    url =
      String(output.url);
  } else if (
    output &&
    Array.isArray(output)
  ) {
    const first =
      output[0];

    if (first) {
      if (
        typeof first ===
        "string"
      ) {
        url = first;
      } else if (
        typeof first.url ===
        "function"
      ) {
        url =
          String(
            await first.url()
          );
      } else if (
        first.url
      ) {
        url =
          String(first.url);
      }
    }
  }

  if (!url) {
    throw new Error(
      "Replicate returned no video URL."
    );
  }

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Video download failed: ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  await fs.writeFile(
    target,
    buffer
  );

  return target;
}

function videoDimensions(
  ratio
) {
  if (ratio === "9:16") {
    return {
      width: 480,
      height: 832
    };
  }

  if (ratio === "1:1") {
    return {
      width: 704,
      height: 704
    };
  }

  return {
    width: 832,
    height: 480
  };
}

async function generateVideo(
  {
    prompt,
    imageUrl,
    duration,
    ratio,
    job
  }
) {
  if (!replicate) {
    throw new Error(
      "Replicate is not configured."
    );
  }

  const seconds =
    normalizeDuration(
      duration
    );

  const frames =
    seconds <= 5
      ? 81
      : 121;

  const {
    width,
    height
  } =
    videoDimensions(
      ratio
    );

  if (job) {
    job.status =
      "generating";
    job.progress = 30;
    job.message =
      "MAMAKI AI is generating your video...";
  }

  let output;

  if (imageUrl) {
    output =
      await replicate.run(
        I2V_MODEL,
        {
          input: {
            image:
              imageUrl,
            prompt:
              prompt,
            num_frames:
              frames,
            width,
            height,
            fps: 16,
            go_fast:
              true,
            sample_shift:
              12
          }
        }
      );
  } else {
    output =
      await replicate.run(
        T2V_MODEL,
        {
          input: {
            prompt:
              prompt,
            num_frames:
              frames,
            width,
            height,
            fps: 16,
            go_fast:
              true,
            sample_shift:
              12
          }
        }
      );
  }

  if (job) {
    job.status =
      "processing";
    job.progress = 65;
    job.message =
      "Finishing video...";
  }

  const id =
    randomUUID();

  const raw =
    path.join(
      TMP,
      `${id}-raw.mp4`
    );

  const exact =
    path.join(
      TMP,
      `${id}-exact.mp4`
    );

  const finalFile =
    path.join(
      OUTPUTS,
      `${id}.mp4`
    );

  await downloadReplicateOutput(
    output,
    raw
  );

  await makeExactDuration(
    raw,
    exact,
    seconds
  );

  await addMamakiWatermark(
    exact,
    finalFile
  );

  const finalDuration =
    await getVideoDuration(
      finalFile
    );

  await fs.rm(
    raw,
    {
      force: true
    }
  );

  await fs.rm(
    exact,
    {
      force: true
    }
  );

  return {
    id,
    url:
      `/outputs/${path.basename(finalFile)}`,
    absolutePath:
      finalFile,
    duration:
      finalDuration ||
      seconds
  };
}

/* =========================================================
   JOB CREATION
========================================================= */

function createJob(
  userId,
  type,
  payload
) {
  const id =
    randomUUID();

  const job = {
    id,
    userId,
    type,
    status:
      "queued",
    progress: 5,
    message:
      "Job queued...",
    createdAt:
      new Date().toISOString(),
    updatedAt:
      new Date().toISOString(),
    payload,
    result: null,
    error: null
  };

  jobs.set(
    id,
    job
  );

  return job;
}

function updateJob(
  job,
  values
) {
  Object.assign(
    job,
    values,
    {
      updatedAt:
        new Date().toISOString()
    }
  );
}

async function runGenerationJob(
  job
) {
  try {
    updateJob(
      job,
      {
        status:
          "generating",
        progress:
          10,
        message:
          "Preparing AI generation..."
      }
    );

    const result =
      await generateVideo({
        prompt:
          job.payload.prompt,
        imageUrl:
          job.payload.imageUrl,
        duration:
          job.payload.duration,
        ratio:
          job.payload.ratio,
        job
      });

    updateJob(
      job,
      {
        status:
          "completed",
        progress:
          100,
        message:
          "Video ready.",
        result
      }
    );

    await recordUsage(
      job.userId,
      job.type,
      {
        duration:
          result.duration
      }
    );

    await security(
      "VIDEO_GENERATED",
      {
        userId:
          job.userId,
        jobId:
          job.id,
        type:
          job.type,
        duration:
          result.duration
      }
    );
  } catch (e) {
    updateJob(
      job,
      {
        status:
          "failed",
        progress:
          100,
        message:
          e.message ||
          "Video generation failed.",
        error:
          e.message ||
          String(e)
      }
    );

    await errorLog(
      e,
      {
        route:
          "video-generation",
        userId:
          job.userId,
        jobId:
          job.id
      }
    );
  }
}

/* =========================================================
   VIDEO GENERATION
========================================================= */

app.post(
  "/api/generate",
  requireUser,
  async (req, res) => {
    try {
      const prompt =
        String(
          req.body.prompt || ""
        ).trim();

      const imageUrl =
        String(
          req.body.imageUrl || ""
        ).trim();

      const duration =
        normalizeDuration(
          req.body.duration
        );

      const ratio =
        ["16:9", "9:16", "1:1"]
          .includes(
            String(req.body.ratio)
          )
          ? String(req.body.ratio)
          : "16:9";

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error:
            "PROMPT_REQUIRED",
          message:
            "Enter a prompt."
        });
      }

      const type =
        imageUrl
          ? "i2v"
          : "t2v";

      const job =
        createJob(
          req.user.id,
          type,
          {
            prompt,
            imageUrl,
            duration,
            ratio
          }
        );

      runGenerationJob(
        job
      );

      return res.json({
        ok: true,
        jobId:
          job.id,
        status:
          job.status
      });
    } catch (e) {
      await errorLog(e, {
        route:
          "/api/generate"
      });

      return res.status(500).json({
        ok: false,
        error:
          "GENERATION_ERROR"
      });
    }
  }
);

app.post(
  "/api/generate/text",
  requireUser,
  async (req, res) => {
    req.body.imageUrl =
      "";

    return app._router
      ? (() => {
          const prompt =
            String(
              req.body.prompt || ""
            ).trim();

          const duration =
            normalizeDuration(
              req.body.duration
            );

          const ratio =
            ["16:9", "9:16", "1:1"]
              .includes(
                String(
                  req.body.ratio
                )
              )
              ? String(
                  req.body.ratio
                )
              : "16:9";

          if (!prompt) {
            return res.status(400).json({
              ok: false,
              error:
                "PROMPT_REQUIRED"
            });
          }

          const job =
            createJob(
              req.user.id,
              "t2v",
              {
                prompt,
                imageUrl: "",
                duration,
                ratio
              }
            );

          runGenerationJob(
            job
          );

          return res.json({
            ok: true,
            jobId:
              job.id
          });
        })()
      : null;
  }
);

/* =========================================================
   IMAGE UPLOAD / IMAGE TO VIDEO
========================================================= */

app.post(
  "/api/generate/image",
  requireUser,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "IMAGE_REQUIRED"
        });
      }

      /*
       * Replicate's I2V endpoint requires an image URL.
       * For this free deployment we expose the uploaded image
       * through the output server after moving it there.
       */

      const id =
        randomUUID();

      const extension =
        path.extname(
          req.file.originalname ||
          ""
        ) || ".jpg";

      const destination =
        path.join(
          OUTPUTS,
          `source-${id}${extension}`
        );

      await fs.rename(
        req.file.path,
        destination
      );

      const publicUrl =
        `${APP_URL}/outputs/${path.basename(destination)}`;

      const prompt =
        String(
          req.body.prompt ||
          "Create a cinematic video from this image."
        ).trim();

      const duration =
        normalizeDuration(
          req.body.duration
        );

      const ratio =
        ["16:9", "9:16", "1:1"]
          .includes(
            String(req.body.ratio)
          )
          ? String(req.body.ratio)
          : "16:9";

      const job =
        createJob(
          req.user.id,
          "i2v",
          {
            prompt,
            imageUrl:
              publicUrl,
            duration,
            ratio
          }
        );

      runGenerationJob(
        job
      );

      return res.json({
        ok: true,
        jobId:
          job.id,
        imageUrl:
          publicUrl
      });
    } catch (e) {
      await errorLog(e, {
        route:
          "/api/generate/image"
      });

      if (req.file?.path) {
        await fs.rm(
          req.file.path,
          {
            force: true
          }
        ).catch(() => {});
      }

      return res.status(500).json({
        ok: false,
        error:
          "IMAGE_GENERATION_ERROR",
        message:
          e.message
      });
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
          "JOB_NOT_FOUND"
      });
    }

    if (
      job.userId !==
      req.user.id &&
      req.user.role !== "admin"
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "FORBIDDEN"
      });
    }

    return res.json({
      ok: true,
      job
    });
  }
);

app.get(
  "/api/jobs",
  requireUser,
  async (req, res) => {
    const list =
      [...jobs.values()]
        .filter(
          job =>
            job.userId ===
              req.user.id ||
            req.user.role ===
              "admin"
        )
        .sort(
          (a, b) =>
            Date.parse(
              b.createdAt
            ) -
            Date.parse(
              a.createdAt
            )
        );

    return res.json({
      ok: true,
      jobs: list
    });
  }
);

/* =========================================================
   PROJECTS
========================================================= */

async function projectFile(
  id
) {
  return path.join(
    PROJECTS,
    `${safeName(id)}.json`
  );
}

app.get(
  "/api/projects",
  requireUser,
  async (req, res) => {
    try {
      const files =
        await fs.readdir(
          PROJECTS
        );

      const projects = [];

      for (const file of files) {
        if (
          !file.endsWith(".json")
        ) {
          continue;
        }

        const project =
          await readJSON(
            path.join(
              PROJECTS,
              file
            ),
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

      projects.sort(
        (a, b) =>
          Date.parse(
            b.updatedAt ||
              b.createdAt ||
              0
          ) -
          Date.parse(
            a.updatedAt ||
              a.createdAt ||
              0
          )
      );

      return res.json({
        ok: true,
        projects
      });
    } catch (e) {
      await errorLog(e);

      return res.status(500).json({
        ok: false,
        error:
          "PROJECT_LIST_ERROR"
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

      const now =
        new Date().toISOString();

      const project = {
        id,
        userId:
          req.user.id,
        name:
          String(
            req.body.name ||
            "Untitled MAMAKI Project"
          ).slice(0, 150),
        data:
          req.body.data ||
          {},
        createdAt:
          now,
        updatedAt:
          now
      };

      await writeJSON(
        await projectFile(id),
        project
      );

      return res.json({
        ok: true,
        project
      });
    } catch (e) {
      await errorLog(e);

      return res.status(500).json({
        ok: false,
        error:
          "PROJECT_CREATE_ERROR"
      });
    }
  }
);

app.get(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    const project =
      await readJSON(
        await projectFile(
          req.params.id
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
          "PROJECT_NOT_FOUND"
      });
    }

    return res.json({
      ok: true,
      project
    });
  }
);

app.put(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    try {
      const file =
        await projectFile(
          req.params.id
        );

      const project =
        await readJSON(
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
            "PROJECT_NOT_FOUND"
        });
      }

      if (
        req.body.name !==
        undefined
      ) {
        project.name =
          String(
            req.body.name
          ).slice(0, 150);
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

      await writeJSON(
        file,
        project
      );

      return res.json({
        ok: true,
        project
      });
    } catch (e) {
      await errorLog(e);

      return res.status(500).json({
        ok: false,
        error:
          "PROJECT_UPDATE_ERROR"
      });
    }
  }
);

app.delete(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    const file =
      await projectFile(
        req.params.id
      );

    const project =
      await readJSON(
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
          "PROJECT_NOT_FOUND"
      });
    }

    await fs.rm(
      file,
      {
        force: true
      }
    );

    return res.json({
      ok: true
    });
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
    try {
      if (!req.file) {
        return res.status(400).json({
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

      const end =
        Number(
          req.body.end || 0
        );

      const id =
        randomUUID();

      const output =
        path.join(
          OUTPUTS,
          `${id}-trim.mp4`
        );

      const args = [
        "-y",
        "-ss",
        String(start),
        "-i",
        req.file.path
      ];

      if (
        Number.isFinite(end) &&
        end > start
      ) {
        args.push(
          "-t",
          String(end - start)
        );
      }

      args.push(
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        output
      );

      await runFFmpeg(args);

      await fs.rm(
        req.file.path,
        {
          force: true
        }
      );

      await recordUsage(
        req.user.id,
        "studio"
      );

      return res.json({
        ok: true,
        url:
          `/outputs/${path.basename(output)}`
      });
    } catch (e) {
      await errorLog(e);

      if (req.file?.path) {
        await fs.rm(
          req.file.path,
          {
            force: true
          }
        ).catch(() => {});
      }

      return res.status(500).json({
        ok: false,
        error:
          "TRIM_ERROR",
        message:
          e.message
      });
    }
  }
);

app.post(
  "/api/studio/mute",
  requireUser,
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "VIDEO_REQUIRED"
        });
      }

      const id =
        randomUUID();

      const output =
        path.join(
          OUTPUTS,
          `${id}-mute.mp4`
        );

      await runFFmpeg([
        "-y",
        "-i",
        req.file.path,
        "-c:v",
        "copy",
        "-an",
        output
      ]);

      await fs.rm(
        req.file.path,
        {
          force: true
        }
      );

      await recordUsage(
        req.user.id,
        "studio"
      );

      return res.json({
        ok: true,
        url:
          `/outputs/${path.basename(output)}`
      });
    } catch (e) {
      await errorLog(e);

      return res.status(500).json({
        ok: false,
        error:
          "MUTE_ERROR",
        message:
          e.message
      });
    }
  }
);

app.post(
  "/api/studio/combine",
  requireUser,
  upload.array(
    "videos",
    20
  ),
  async (req, res) => {
    try {
      const files =
        req.files || [];

      if (files.length < 2) {
        return res.status(400).json({
          ok: false,
          error:
            "TWO_VIDEOS_REQUIRED"
        });
      }

      const id =
        randomUUID();

      const listFile =
        path.join(
          TMP,
          `${id}-concat.txt`
        );

      const output =
        path.join(
          OUTPUTS,
          `${id}-combined.mp4`
        );

      const lines =
        files.map(
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
        "-movflags",
        "+faststart",
        output
      ]);

      for (const file of files) {
        await fs.rm(
          file.path,
          {
            force: true
          }
        );
      }

      await fs.rm(
        listFile,
        {
          force: true
        }
      );

      await recordUsage(
        req.user.id,
        "studio"
      );

      return res.json({
        ok: true,
        url:
          `/outputs/${path.basename(output)}`
      });
    } catch (e) {
      await errorLog(e);

      return res.status(500).json({
        ok: false,
        error:
          "COMBINE_ERROR",
        message:
          e.message
      });
    }
  }
);

/* =========================================================
   MUSIC
========================================================= */

app.post(
  "/api/studio/add-music",
  requireUser,
  upload.fields([
    {
      name: "video",
      maxCount: 1
    },
    {
      name: "music",
      maxCount: 1
    }
  ]),
  async (req, res) => {
    try {
      const video =
        req.files?.video?.[0];

      const music =
        req.files?.music?.[0];

      if (!video || !music) {
        return res.status(400).json({
          ok: false,
          error:
            "VIDEO_AND_MUSIC_REQUIRED"
        });
      }

      const id =
        randomUUID();

      const output =
        path.join(
          OUTPUTS,
          `${id}-music.mp4`
        );

      await runFFmpeg([
        "-y",
        "-i",
        video.path,
        "-stream_loop",
        "-1",
        "-i",
        music.path,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-shortest",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        output
      ]);

      await fs.rm(
        video.path,
        {
          force: true
        }
      );

      await fs.rm(
        music.path,
        {
          force: true
        }
      );

      await recordUsage(
        req.user.id,
        "studio"
      );

      return res.json({
        ok: true,
        url:
          `/outputs/${path.basename(output)}`
      });
    } catch (e) {
      await errorLog(e);

      return res.status(500).json({
        ok: false,
        error:
          "MUSIC_ERROR",
        message:
          e.message
      });
    }
  }
);

/* =========================================================
   NARRATION
========================================================= */

app.post(
  "/api/narration",
  requireUser,
  async (req, res) => {
    try {
      const text =
        String(
          req.body.text || ""
        ).trim();

      if (!text) {
        return res.status(400).json({
          ok: false,
          error:
            "TEXT_REQUIRED"
        });
      }

      const id =
        randomUUID();

      const output =
        path.join(
          OUTPUTS,
          `${id}-narration.mp3`
        );

      const voice =
        String(
          req.body.voice ||
          "en-US-EmmaMultilingualNeural"
        );

      const tts =
        new EdgeTTS({
          voice
        });

      await tts.synthesizeToFile(
        text,
        output
      );

      await recordUsage(
        req.user.id,
        "narration"
      );

      return res.json({
        ok: true,
        url:
          `/outputs/${path.basename(output)}`
      });
    } catch (e) {
      await errorLog(e);

      return res.status(500).json({
        ok: false,
        error:
          "NARRATION_ERROR",
        message:
          e.message
      });
    }
  }
);

/* =========================================================
   ADMIN LOGIN
   THIS IS THE IMPORTANT FIX

   Allows:
   1. ADMIN_EMAIL + ADMIN_PASSWORD from Render
   2. Existing account credentials AFTER that account
      has administrator role
   3. Master credentials repair/promote the existing account
   4. Old admin sessions are removed
========================================================= */

app.post(
  "/api/admin/login",
  async (req, res) => {
    try {
      const mail =
        email(
          req.body.email
        );

      const password =
        String(
          req.body.password || ""
        );

      if (!mail || !password) {
        return res.status(400).json({
          ok: false,
          error:
            "MISSING_CREDENTIALS",
          message:
            "Administrator email and password are required."
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
            "Admin environment variables are not configured in Render."
        });
      }

      const users =
        await readJSON(
          USERS,
          {}
        );

      let admin =
        Object.values(
          users
        ).find(
          u =>
            email(u.email) ===
            mail
        );

      const masterCredentialsValid =
        mail ===
          ADMIN_EMAIL &&
        password ===
          ADMIN_PASSWORD;

      const existingAdminValid =
        Boolean(
          admin &&
          admin.role ===
            "admin" &&
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
            email:
              mail,
            reason:
              "INVALID_ADMIN_CREDENTIALS"
          }
        );

        return res.status(401).json({
          ok: false,
          error:
            "INVALID_ADMIN_CREDENTIALS",
          message:
            "Invalid administrator credentials."
        });
      }

      /*
       * MASTER LOGIN
       *
       * If the administrator email already belongs to an
       * account, repair/promote that account.
       *
       * The Render ADMIN_PASSWORD becomes the password for
       * the repaired administrator account.
       */

      if (
        masterCredentialsValid
      ) {
        if (admin) {
          const hp =
            hashPassword(
              ADMIN_PASSWORD
            );

          admin.email =
            ADMIN_EMAIL;

          admin.role =
            "admin";

          admin.disabled =
            false;

          admin.salt =
            hp.salt;

          admin.hash =
            hp.hash;

          admin.lastLoginAt =
            new Date().toISOString();

          users[admin.id] =
            admin;

          await security(
            "ADMIN_ACCOUNT_REPAIRED",
            {
              userId:
                admin.id,
              email:
                admin.email
            }
          );
        } else {
          const id =
            randomUUID();

          const hp =
            hashPassword(
              ADMIN_PASSWORD
            );

          admin = {
            id,
            name:
              "MAMAKI Administrator",
            email:
              ADMIN_EMAIL,
            ...hp,
            role:
              "admin",
            disabled:
              false,
            createdAt:
              new Date().toISOString(),
            lastLoginAt:
              new Date().toISOString()
          };

          users[id] =
            admin;

          await security(
            "ADMIN_ACCOUNT_RESTORED",
            {
              userId:
                admin.id,
              email:
                admin.email
            }
          );
        }
      }

      /*
       * Existing administrator login.
       *
       * Do NOT replace its password when the stored admin
       * password was used.
       */

      admin.role =
        "admin";

      admin.disabled =
        false;

      admin.lastLoginAt =
        new Date().toISOString();

      users[admin.id] =
        admin;

      await writeJSON(
        USERS,
        users
      );

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
          userId:
            admin.id,
          email:
            admin.email,
          method:
            masterCredentialsValid
              ? "MASTER_CREDENTIALS"
              : "EXISTING_ADMIN_ACCOUNT"
        }
      );

      return res.json({
        ok: true,
        token,
        user: {
          id:
            admin.id,
          name:
            admin.name,
          email:
            admin.email,
          role:
            "admin"
        }
      });
    } catch (e) {
      await errorLog(
        e,
        {
          route:
            "/api/admin/login"
        }
      );

      return res.status(500).json({
        ok: false,
        error:
          "ADMIN_LOGIN_ERROR",
        message:
          "Administrator login failed."
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
        await readJSON(
          USERS,
          {}
        );

      const usage =
        await readJSON(
          USAGE,
          {}
        );

      const errors =
        await readJSON(
          ERRORS,
          []
        );

      const securityLogs =
        await readJSON(
          SECURITY,
          []
        );

      const userList =
        Object.values(users);

      let totalGenerations =
        0;

      let totalSeconds =
        0;

      for (const value of
        Object.values(usage)) {
        totalGenerations +=
          Number(
            value.totalGenerations ||
              0
          );

        totalSeconds +=
          Number(
            value.totalSeconds ||
              0
          );
      }

      return res.json({
        ok: true,
        stats: {
          version:
            VERSION,
          users:
            userList.length,
          activeUsers:
            userList.filter(
              u =>
                !u.disabled
            ).length,
          admins:
            userList.filter(
              u =>
                u.role === "admin"
            ).length,
          totalGenerations,
          totalSeconds,
          totalHours:
            totalSeconds / 3600,
          jobs:
            jobs.size,
          errors:
            errors.length,
          securityEvents:
            securityLogs.length,
          replicate:
            Boolean(
              REPLICATE_API_TOKEN
            ),
          recovery:
            Boolean(
              RESEND_API_KEY &&
              RESEND_FROM
            ),
          admin:
            Boolean(
              ADMIN_EMAIL &&
              ADMIN_PASSWORD
            )
        }
      });
    } catch (e) {
      await errorLog(e);

      return res.status(500).json({
        ok: false,
        error:
          "ADMIN_STATS_ERROR"
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
      await readJSON(
        USERS,
        {}
      );

    const usage =
      await readJSON(
        USAGE,
        {}
      );

    const list =
      Object.values(users)
        .map(
          user => ({
            ...publicUser(user),
            usage:
              usage[user.id] ||
              {
                totalGenerations:
                  0,
                totalSeconds:
                  0,
                t2v:
                  0,
                i2v:
                  0,
                narration:
                  0,
                studio:
                  0
              }
          })
        )
        .sort(
          (a, b) =>
            Date.parse(
              b.createdAt || 0
            ) -
            Date.parse(
              a.createdAt || 0
            )
        );

    return res.json({
      ok: true,
      users: list
    });
  }
);

app.get(
  "/api/admin/users/:id",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJSON(
        USERS,
        {}
      );

    const usage =
      await readJSON(
        USAGE,
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
          "USER_NOT_FOUND"
      });
    }

    return res.json({
      ok: true,
      user:
        publicUser(user),
      usage:
        usage[user.id] || {}
    });
  }
);

/* =========================================================
   ADMIN DISABLE / ENABLE USER
========================================================= */

app.post(
  "/api/admin/users/:id/disable",
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
        return res.status(404).json({
          ok: false,
          error:
            "USER_NOT_FOUND"
        });
      }

      if (
        user.id ===
        req.user.id
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "CANNOT_DISABLE_SELF"
        });
      }

      if (
        user.email ===
        ADMIN_EMAIL
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "CANNOT_DISABLE_MAIN_ADMIN"
        });
      }

      const disabled =
        req.body.disabled !==
        undefined
          ? Boolean(
              req.body.disabled
            )
          : !user.disabled;

      user.disabled =
        disabled;

      users[user.id] =
        user;

      await writeJSON(
        USERS,
        users
      );

      if (disabled) {
        await destroyUserSessions(
          user.id
        );
      }

      await security(
        disabled
          ? "USER_DISABLED"
          : "USER_ENABLED",
        {
          adminId:
            req.user.id,
          userId:
            user.id
        }
      );

      return res.json({
        ok: true,
        user:
          publicUser(user)
      });
    } catch (e) {
      await errorLog(e);

      return res.status(500).json({
        ok: false,
        error:
          "USER_STATUS_ERROR"
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
      [...jobs.values()]
        .sort(
          (a, b) =>
            Date.parse(
              b.createdAt
            ) -
            Date.parse(
              a.createdAt
            )
        );

    return res.json({
      ok: true,
      jobs: list
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
      await readJSON(
        ERRORS,
        []
      );

    return res.json({
      ok: true,
      errors:
        Array.isArray(errors)
          ? errors.slice(0, 500)
          : []
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
    const logs =
      await readJSON(
        SECURITY,
        []
      );

    return res.json({
      ok: true,
      security:
        Array.isArray(logs)
          ? logs.slice(0, 500)
          : []
    });
  }
);

/* =========================================================
   ADMIN LOGOUT
========================================================= */

app.post(
  "/api/admin/logout",
  async (req, res) => {
    try {
      const auth =
        String(
          req.headers.authorization ||
          ""
        );

      if (
        auth.startsWith(
          "Bearer "
        )
      ) {
        await destroySession(
          auth.slice(7).trim()
        );
      }

      return res.json({
        ok: true
      });
    } catch {
      return res.json({
        ok: true
      });
    }
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  async (req, res) => {
    return res.json({
      ok: true,
      app:
        "MAMAKI AI",
      version:
        VERSION,
      replicate:
        Boolean(
          REPLICATE_API_TOKEN
        ),
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
      uptime:
        process.uptime(),
      timestamp:
        new Date().toISOString()
    });
  }
);

app.get(
  "/api/status",
  async (req, res) => {
    return res.json({
      ok: true,
      app:
        "MAMAKI AI",
      version:
        VERSION,
      models: {
        t2v:
          T2V_MODEL,
        i2v:
          I2V_MODEL
      },
      duration: {
        min:
          MIN_DURATION,
        max:
          MAX_DURATION
      },
      features: {
        textToVideo:
          Boolean(
            REPLICATE_API_TOKEN
          ),
        imageToVideo:
          Boolean(
            REPLICATE_API_TOKEN
          ),
        freeStudio:
          true,
        narration:
          true,
        projects:
          true,
        admin:
          Boolean(
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

app.get(
  "/",
  async (req, res) => {
    const index =
      path.join(
        ROOT,
        "index.html"
      );

    if (await exists(index)) {
      return res.sendFile(
        index
      );
    }

    return res.send(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>MAMAKI AI</title>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>
          body{
            margin:0;
            background:#080b12;
            color:white;
            font-family:Arial,sans-serif;
            display:flex;
            align-items:center;
            justify-content:center;
            min-height:100vh;
          }
          .box{
            text-align:center;
            padding:40px;
          }
          h1{
            font-size:42px;
          }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>✨ MAMAKI AI</h1>
          <p>AI Video Creative Studio</p>
          <p>Server is running successfully.</p>
        </div>
      </body>
      </html>
    `);
  }
);

/* =========================================================
   ADMIN PAGE
========================================================= */

app.get(
  "/admin",
  async (req, res) => {
    res.send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI Admin</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  background:#080b12;
  color:#fff;
  font-family:Arial,sans-serif;
}
.wrap{
  max-width:1200px;
  margin:auto;
  padding:24px;
}
.card{
  background:#111722;
  border:1px solid #263044;
  border-radius:18px;
  padding:20px;
  margin-bottom:18px;
}
h1,h2{margin-top:0}
input,button{
  width:100%;
  padding:13px;
  border-radius:10px;
  border:1px solid #303a50;
  margin-top:8px;
}
input{
  background:#080b12;
  color:#fff;
}
button{
  background:#fff;
  color:#000;
  font-weight:700;
  cursor:pointer;
}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:14px;
}
.stat{
  background:#171e2b;
  border-radius:14px;
  padding:18px;
}
.num{
  font-size:28px;
  font-weight:800;
}
.small{
  color:#9ca8bd;
  font-size:13px;
}
.hidden{
  display:none;
}
.error{
  color:#ff8585;
  margin-top:10px;
}
table{
  width:100%;
  border-collapse:collapse;
}
td,th{
  text-align:left;
  padding:10px;
  border-bottom:1px solid #263044;
}
.scroll{
  overflow:auto;
}
</style>
</head>

<body>

<div class="wrap">

  <div id="loginBox" class="card">
    <h1>✨ MAMAKI AI</h1>
    <h2>Administrator Login</h2>

    <input
      id="adminEmail"
      type="email"
      placeholder="Administrator email"
    >

    <input
      id="adminPassword"
      type="password"
      placeholder="Administrator password"
    >

    <button onclick="login()">
      Login to Admin Dashboard
    </button>

    <div id="loginError"
         class="error"></div>
  </div>

  <div id="dashboard"
       class="hidden">

    <div class="card">
      <h1>✨ MAMAKI AI Admin Dashboard</h1>
      <p class="small">
        Administrator control center
      </p>

      <button onclick="logout()">
        Logout
      </button>
    </div>

    <div id="stats"
         class="grid"></div>

    <div class="card">
      <h2>Users</h2>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Generations</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="users"></tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Jobs</h2>
      <div id="jobs"></div>
    </div>

    <div class="card">
      <h2>Security Events</h2>
      <div id="security"></div>
    </div>

    <div class="card">
      <h2>Errors</h2>
      <div id="errors"></div>
    </div>

  </div>

</div>

<script>

let adminToken =
  localStorage.getItem(
    "mamaki_admin_token"
  );

function esc(value){
  return String(value ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

async function login(){

  const email =
    document.getElementById(
      "adminEmail"
    ).value.trim();

  const password =
    document.getElementById(
      "adminPassword"
    ).value;

  const error =
    document.getElementById(
      "loginError"
    );

  error.textContent = "";

  try{

    const response =
      await fetch(
        "/api/admin/login",
        {
          method:"POST",
          headers:{
            "Content-Type":
              "application/json"
          },
          body:JSON.stringify({
            email,
            password
          })
        }
      );

    const data =
      await response.json();

    if(!response.ok || !data.ok){
      throw new Error(
        data.message ||
        data.error ||
        "Login failed."
      );
    }

    adminToken =
      data.token;

    localStorage.setItem(
      "mamaki_admin_token",
      adminToken
    );

    document
      .getElementById(
        "loginBox"
      )
      .classList.add(
        "hidden"
      );

    document
      .getElementById(
        "dashboard"
      )
      .classList.remove(
        "hidden"
      );

    await loadDashboard();

  }catch(e){

    error.textContent =
      e.message;
  }
}

async function api(url){

  const response =
    await fetch(
      url,
      {
        headers:{
          "Authorization":
            "Bearer " +
            adminToken
        }
      }
    );

  const data =
    await response.json();

  if(
    response.status === 401 ||
    response.status === 403
  ){
    localStorage.removeItem(
      "mamaki_admin_token"
    );

    adminToken = null;

    document
      .getElementById(
        "dashboard"
      )
      .classList.add(
        "hidden"
      );

    document
      .getElementById(
        "loginBox"
      )
      .classList.remove(
        "hidden"
      );
  }

  if(!response.ok || !data.ok){
    throw new Error(
      data.message ||
      data.error ||
      "Request failed."
    );
  }

  return data;
}

async function loadDashboard(){

  const stats =
    await api(
      "/api/admin/stats"
    );

  const s =
    stats.stats;

  document.getElementById(
    "stats"
  ).innerHTML = `

    <div class="stat">
      <div class="small">
        Users
      </div>
      <div class="num">
        ${s.users}
      </div>
    </div>

    <div class="stat">
      <div class="small">
        Active Users
      </div>
      <div class="num">
        ${s.activeUsers}
      </div>
    </div>

    <div class="stat">
      <div class="small">
        Administrators
      </div>
      <div class="num">
        ${s.admins}
      </div>
    </div>

    <div class="stat">
      <div class="small">
        Generations
      </div>
      <div class="num">
        ${s.totalGenerations}
      </div>
    </div>

    <div class="stat">
      <div class="small">
        Video Seconds
      </div>
      <div class="num">
        ${Math.round(s.totalSeconds)}
      </div>
    </div>

    <div class="stat">
      <div class="small">
        Jobs
      </div>
      <div class="num">
        ${s.jobs}
      </div>
    </div>

    <div class="stat">
      <div class="small">
        Replicate
      </div>
      <div class="num">
        ${s.replicate ? "ON" : "OFF"}
      </div>
    </div>

    <div class="stat">
      <div class="small">
        Version
      </div>
      <div class="num">
        ${esc(s.version)}
      </div>
    </div>
  `;

  const users =
    await api(
      "/api/admin/users"
    );

  document.getElementById(
    "users"
  ).innerHTML =
    users.users.map(
      u => `
        <tr>
          <td>
            ${esc(u.name)}
          </td>

          <td>
            ${esc(u.email)}
          </td>

          <td>
            ${esc(u.role)}
          </td>

          <td>
            ${
              u.disabled
                ? "Disabled"
                : "Active"
            }
          </td>

          <td>
            ${
              u.usage?.totalGenerations ||
              0
            }
          </td>

          <td>
            ${
              u.email ===
              "${ADMIN_EMAIL}"
                ? "Main Admin"
                : `
                  <button
                    onclick="toggleUser(
                      '${esc(u.id)}',
                      ${!u.disabled}
                    )">
                    ${
                      u.disabled
                        ? "Enable"
                        : "Disable"
                    }
                  </button>
                `
            }
          </td>
        </tr>
      `
    ).join("");

  const jobs =
    await api(
      "/api/admin/jobs"
    );

  document.getElementById(
    "jobs"
  ).innerHTML =
    jobs.jobs
      .slice(0,50)
      .map(
        j => `
          <div class="stat">
            <b>
              ${esc(j.type)}
            </b>
            <div class="small">
              ${esc(j.status)}
              —
              ${esc(j.progress)}%
            </div>
            <div class="small">
              ${esc(j.message)}
            </div>
          </div>
        `
      )
      .join("");

  const security =
    await api(
      "/api/admin/security"
    );

  document.getElementById(
    "security"
  ).innerHTML =
    security.security
      .slice(0,50)
      .map(
        item => `
          <div class="stat">
            <b>
              ${esc(item.action)}
            </b>
            <div class="small">
              ${esc(item.timestamp)}
            </div>
            <div class="small">
              ${esc(
                JSON.stringify(item)
              )}
            </div>
          </div>
        `
      )
      .join("");

  const errors =
    await api(
      "/api/admin/errors"
    );

  document.getElementById(
    "errors"
  ).innerHTML =
    errors.errors
      .slice(0,50)
      .map(
        item => `
          <div class="stat">
            <b>
              ${esc(item.message)}
            </b>
            <div class="small">
              ${esc(item.timestamp)}
            </div>
          </div>
        `
      )
      .join("");
}

async function toggleUser(
  id,
  disabled
){

  try{

    await fetch(
      "/api/admin/users/" +
      encodeURIComponent(id) +
      "/disable",
      {
        method:"POST",
        headers:{
          "Content-Type":
            "application/json",
          "Authorization":
            "Bearer " +
            adminToken
        },
        body:JSON.stringify({
          disabled
        })
      }
    );

    await loadDashboard();

  }catch(e){
    alert(e.message);
  }
}

async function logout(){

  try{
    await fetch(
      "/api/admin/logout",
      {
        method:"POST",
        headers:{
          "Authorization":
            "Bearer " +
            adminToken
        }
      }
    );
  }catch{}

  localStorage.removeItem(
    "mamaki_admin_token"
  );

  adminToken = null;

  location.reload();
}

if(adminToken){

  document
    .getElementById(
      "loginBox"
    )
    .classList.add(
      "hidden"
    );

  document
    .getElementById(
      "dashboard"
    )
    .classList.remove(
      "hidden"
    );

  loadDashboard()
    .catch(() => {
      localStorage.removeItem(
        "mamaki_admin_token"
      );

      location.reload();
    });
}

</script>

</body>
</html>
`);
  }
);

/* =========================================================
   404
========================================================= */

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
        path:
          req.path
      });
    }

    return res.status(404).send(
      `
      <h1>MAMAKI AI</h1>
      <p>Page not found.</p>
      `
    );
  }
);

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
  async (err, req, res, next) => {
    await errorLog(
      err,
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
      return next(err);
    }

    return res.status(500).json({
      ok: false,
      error:
        "SERVER_ERROR",
      message:
        err.message ||
        "Internal server error."
    });
  }
);

/* =========================================================
   CLEANUP
========================================================= */

async function cleanupOldFiles() {
  try {
    const now =
      Date.now();

    const files =
      await fs.readdir(
        TMP
      );

    for (const file of files) {
      const full =
        path.join(
          TMP,
          file
        );

      try {
        const stat =
          await fs.stat(
            full
          );

        if (
          now -
            stat.mtimeMs >
          6 * 60 * 60 * 1000
        ) {
          await fs.rm(
            full,
            {
              force: true,
              recursive: true
            }
          );
        }
      } catch {}
    }
  } catch {}
}

setInterval(
  cleanupOldFiles,
  30 * 60 * 1000
);

/* =========================================================
   START
========================================================= */

await ensureStorage();

await cleanupOldFiles();

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      "================================================="
    );

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

    console.log(
      "================================================="
    );
  }
);
