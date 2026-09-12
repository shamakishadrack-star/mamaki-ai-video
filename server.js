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
        spawn
