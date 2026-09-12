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
const VERSION = "14.0.0";

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

const jobs = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

app.disable("x-powered-by");

app.use(
  express.json({
    limit: "30mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "30mb"
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
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );

  next();
});


/* =========================================================
   STORAGE
========================================================= */

async function ensureStorage() {
  await fs.mkdir(TMP, {
    recursive: true
  });

  await fs.mkdir(OUTPUTS, {
    recursive: true
  });

  await fs.mkdir(PROJECTS, {
    recursive: true
  });

  await fs.mkdir(DATA, {
    recursive: true
  });

  for (
    const file of [
      USERS,
      SESSIONS,
      USAGE,
      ERRORS,
      SECURITY,
      RESETS
    ]
  ) {
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
}

async function readJSON(
  file,
  fallback = {}
) {
  try {
    const data =
      await fs.readFile(
        file,
        "utf8"
      );

    if (!data.trim()) {
      return fallback;
    }

    return JSON.parse(data);
  } catch {
    return fallback;
  }
}

async function writeJSON(
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

function text(
  value,
  max = 10000
) {
  return String(value ?? "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, max);
}

function email(value) {
  return text(
    value,
    200
  ).toLowerCase();
}

function safeFileName(value) {
  const base =
    path.basename(
      String(value || "")
    );

  const cleaned =
    base
      .replace(
        /[^a-zA-Z0-9._-]/g,
        ""
      )
      .slice(0, 150);

  return (
    cleaned ||
    `${randomUUID()}.bin`
  );
}

function duration(value) {
  if (
    typeof value ===
    "string"
  ) {
    const m =
      value
        .trim()
        .match(
          /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/i
        );

    if (m) {
      let n =
        Number(m[1]);

      const unit =
        String(
          m[2] || "s"
        ).toLowerCase();

      if (
        [
          "m",
          "min",
          "mins"
        ].includes(unit)
      ) {
        n *= 60;
      }

      if (
        [
          "h",
          "hr",
          "hrs"
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

  const n =
    Number(value);

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

function ratio(value) {
  return [
    "16:9",
    "9:16",
    "1:1"
  ].includes(
    String(value)
  )
    ? String(value)
    : "16:9";
}

function ratioSize(r) {
  if (r === "9:16") {
    return "1080:1920";
  }

  if (r === "1:1") {
    return "1080:1080";
  }

  return "1920:1080";
}

function hashPassword(
  password,
  salt =
    randomBytes(16)
      .toString("hex")
) {
  return {
    salt,
    hash:
      scryptSync(
        String(password),
        salt,
        64
      ).toString("hex")
  };
}

function verifyPassword(
  password,
  salt,
  expected
) {
  try {
    if (
      !salt ||
      !expected
    ) {
      return false;
    }

    const actual =
      scryptSync(
        String(password),
        salt,
        64
      );

    const stored =
      Buffer.from(
        expected,
        "hex"
      );

    return (
      actual.length ===
        stored.length &&
      timingSafeEqual(
        actual,
        stored
      )
    );
  } catch {
    return false;
  }
}

function token() {
  const random =
    randomBytes(32)
      .toString("hex");

  const secret =
    SESSION_SECRET
      ? scryptSync(
          SESSION_SECRET,
          random.slice(
            0,
            16
          ),
          32
        ).toString("hex")
      : randomBytes(16)
          .toString("hex");

  return `${random}.${secret}`;
}

function bearer(req) {
  const h =
    String(
      req.headers.authorization ||
      ""
    );

  return h
    .toLowerCase()
    .startsWith("bearer ")
    ? h.slice(7).trim()
    : "";
}


/* =========================================================
   SESSIONS
========================================================= */

async function createSession(
  userId,
  role
) {
  const sessions =
    await readJSON(
      SESSIONS,
      {}
    );

  const t =
    token();

  sessions[t] = {
    userId,
    role,
    createdAt:
      Date.now(),
    lastSeen:
      Date.now()
  };

  await writeJSON(
    SESSIONS,
    sessions
  );

  return t;
}

async function destroyUserSessions(
  userId
) {
  const sessions =
    await readJSON(
      SESSIONS,
      {}
    );

  for (
    const [
      sessionToken,
      session
    ] of Object.entries(
      sessions
    )
  ) {
    if (
      session.userId ===
      userId
    ) {
      delete sessions[
        sessionToken
      ];
    }
  }

  await writeJSON(
    SESSIONS,
    sessions
  );
}

async function currentUser(req) {
  const t =
    bearer(req);

  if (!t) {
    return null;
  }

  const sessions =
    await readJSON(
      SESSIONS,
      {}
    );

  const s =
    sessions[t];

  if (!s) {
    return null;
  }

  if (
    Date.now() -
      Number(
        s.createdAt || 0
      ) >
    30 *
      24 *
      60 *
      60 *
      1000
  ) {
    delete sessions[t];

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

  const u =
    users[s.userId];

  if (
    !u ||
    u.disabled
  ) {
    return null;
  }

  s.lastSeen =
    Date.now();

  sessions[t] = s;

  await writeJSON(
    SESSIONS,
    sessions
  );

  return {
    ...u,
    sessionRole:
      s.role
  };
}

async function requireUser(
  req,
  res,
  next
) {
  const u =
    await currentUser(req);

  if (!u) {
    return res.status(401).json({
      ok: false,
      error:
        "AUTH_REQUIRED",
      message:
        "Please log in."
    });
  }

  req.user = u;

  next();
}

async function requireAdmin(
  req,
  res,
  next
) {
  const u =
    await currentUser(req);

  if (
    !u ||
    u.role !== "admin"
  ) {
    return res.status(403).json({
      ok: false,
      error:
        "ADMIN_REQUIRED",
      message:
        "Administrator access required."
    });
  }

  req.user = u;

  next();
}


/* =========================================================
   LOGGING
========================================================= */

async function security(
  type,
  data = {}
) {
  const db =
    await readJSON(
      SECURITY,
      {}
    );

  const id =
    randomUUID();

  db[id] = {
    id,
    type,
    createdAt:
      new Date().toISOString(),
    ...data
  };

  const keys =
    Object.keys(db);

  if (
    keys.length > 500
  ) {
    keys
      .sort(
        (a, b) =>
          String(
            db[a].createdAt
          ).localeCompare(
            String(
              db[b].createdAt
            )
          )
      )
      .slice(
        0,
        keys.length - 500
      )
      .forEach(
        k => delete db[k]
      );
  }

  await writeJSON(
    SECURITY,
    db
  );
}

async function errorLog(
  err,
  context = {}
) {
  try {
    const db =
      await readJSON(
        ERRORS,
        {}
      );

    const id =
      randomUUID();

    db[id] = {
      id,
      createdAt:
        new Date().toISOString(),
      message:
        String(
          err?.message ||
          err ||
          "Unknown error"
        ).slice(0, 2000),
      context
    };

    const keys =
      Object.keys(db);

    if (
      keys.length > 500
    ) {
      keys
        .sort(
          (a, b) =>
            String(
              db[a].createdAt
            ).localeCompare(
              String(
                db[b].createdAt
              )
            )
        )
        .slice(
          0,
          keys.length - 500
        )
        .forEach(
          k => delete db[k]
        );
    }

    await writeJSON(
      ERRORS,
      db
    );
  } catch {
    console.error(
      "Unable to write error log."
    );
  }
}

async function usage(
  userId,
  type,
  seconds = 0
) {
  const db =
    await readJSON(
      USAGE,
      {}
    );

  if (!db[userId]) {
    db[userId] = {
      userId,
      aiGenerations: 0,
      aiSeconds: 0,
      studioJobs: 0,
      narrationJobs: 0
    };
  }

  if (type === "ai") {
    db[userId]
      .aiGenerations++;

    db[userId]
      .aiSeconds +=
      Number(
        seconds || 0
      );
  }

  if (type === "studio") {
    db[userId]
      .studioJobs++;
  }

  if (
    type === "narration"
  ) {
    db[userId]
      .narrationJobs++;
  }

  db[userId]
    .updatedAt =
    Date.now();

  await writeJSON(
    USAGE,
    db
  );
}


/* =========================================================
   AUTH — REGISTER
========================================================= */

app.post(
  "/api/auth/register",
  async (req, res) => {
    try {
      const name =
        text(
          req.body.name,
          100
        );

      const mail =
        email(
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
        !password ||
        password.length < 6
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "Name, valid email and password of at least 6 characters are required."
        });
      }

      const users =
        await readJSON(
          USERS,
          {}
        );

      if (
        Object.values(users)
          .some(
            u =>
              u.email ===
              mail
          )
      ) {
        return res.status(409).json({
          ok: false,
          message:
            "An account with this email already exists."
        });
      }

      const id =
        randomUUID();

      const hp =
        hashPassword(
          password
        );

      users[id] = {
        id,
        name,
        email: mail,
        ...hp,
        role: "user",
        disabled: false,
        createdAt:
          new Date().toISOString()
      };

      await writeJSON(
        USERS,
        users
      );

      const t =
        await createSession(
          id,
          "user"
        );

      await security(
        "ACCOUNT_CREATED",
        {
          userId: id,
          email: mail
        }
      );

      res.json({
        ok: true,
        token: t,
        user: {
          id,
          name,
          email: mail,
          role: "user"
        }
      });
    } catch (e) {
      await errorLog(
        e,
        {
          route:
            req.originalUrl
        }
      );

      res.status(500).json({
        ok: false,
        message:
          "Registration failed."
      });
    }
  }
);


/* =========================================================
   AUTH — LOGIN
========================================================= */

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
          req.body.password ||
          ""
        );

      const users =
        await readJSON(
          USERS,
          {}
        );

      const u =
        Object.values(users)
          .find(
            x =>
              x.email ===
              mail
          );

      if (
        !u ||
        u.disabled ||
        !verifyPassword(
          password,
          u.salt,
          u.hash
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
          message:
            "Invalid email or password."
        });
      }

      u.lastLoginAt =
        new Date().toISOString();

      users[u.id] = u;

      await writeJSON(
        USERS,
        users
      );

      const t =
        await createSession(
          u.id,
          u.role
        );

      await security(
        "LOGIN_SUCCESS",
        {
          userId: u.id,
          email: u.email
        }
      );

      res.json({
        ok: true,
        token: t,
        user: {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role
        }
      });
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Login failed."
      });
    }
  }
);


/* =========================================================
   AUTH — LOGOUT
========================================================= */

app.post(
  "/api/auth/logout",
  async (req, res) => {
    try {
      const t =
        bearer(req);

      if (t) {
        const sessions =
          await readJSON(
            SESSIONS,
            {}
          );

        delete sessions[t];

        await writeJSON(
          SESSIONS,
          sessions
        );
      }

      res.json({
        ok: true
      });
    } catch (e) {
      await errorLog(e);

      res.json({
        ok: true
      });
    }
  }
);


/* =========================================================
   AUTH — CURRENT USER
========================================================= */

app.get(
  "/api/auth/me",
  requireUser,
  async (req, res) => {
    res.json({
      ok: true,
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role
      }
    });
  }
);


/* =========================================================
   PASSWORD RECOVERY
========================================================= */

function resetHash(code) {
  return createHash(
    "sha256"
  )
    .update(
      String(code)
    )
    .digest("hex");
}

function recoveryCode() {
  return String(
    randomBytes(4)
      .readUInt32BE(0) %
      900000 +
      100000
  );
}

async function sendRecoveryEmail(
  to,
  code
) {
  if (
    !RESEND_API_KEY ||
    !RESEND_FROM
  ) {
    return false;
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
            "application/json"
        },

        body:
          JSON.stringify({
            from:
              RESEND_FROM,

            to: [to],

            subject:
              "MAMAKI AI password recovery",

            html:
              "<!doctype html>" +
              "<html><body style=\"font-family:Arial,sans-serif;background:#f5f5f5;padding:30px\">" +
              "<div style=\"max-width:520px;margin:auto;background:white;padding:30px;border-radius:16px\">" +
              "<h2>✨ MAMAKI AI</h2>" +
              "<p>Your password recovery code is:</p>" +
              "<div style=\"font-size:36px;font-weight:bold;letter-spacing:8px;padding:20px 0\">" +
              text(code, 20) +
              "</div>" +
              "<p>This code expires in 15 minutes.</p>" +
              "<p>If you did not request this password reset, you can safely ignore this email.</p>" +
              "</div></body></html>"
          })
      }
    );

  return response.ok;
}


/* =========================================================
   FORGOT PASSWORD
========================================================= */

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

      const u =
        Object.values(users)
          .find(
            x =>
              x.email ===
              mail
          );

      if (!u) {
        return res.json({
          ok: true,
          message:
            "If the account exists, recovery instructions will be sent."
        });
      }

      const code =
        recoveryCode();

      const resets =
        await readJSON(
          RESETS,
          {}
        );

      resets[u.id] = {
        userId: u.id,
        email: u.email,
        codeHash:
          resetHash(code),
        attempts: 0,
        createdAt:
          Date.now(),
        expiresAt:
          Date.now() +
          15 *
            60 *
            1000
      };

      await writeJSON(
        RESETS,
        resets
      );

      let sent = false;

      try {
        sent =
          await sendRecoveryEmail(
            u.email,
            code
          );
      } catch (e) {
        await errorLog(
          e,
          {
            action:
              "SEND_RECOVERY_EMAIL",
            userId:
              u.id
          }
        );
      }

      await security(
        "PASSWORD_RECOVERY_REQUEST",
        {
          userId:
            u.id,
          email:
            u.email,
          emailSent:
            sent
        }
      );

      res.json({
        ok: true,
        emailSent:
          sent,
        message:
          sent
            ? "Recovery code sent to your email."
            : "Recovery email is not configured yet. Please configure RESEND_API_KEY and RESEND_FROM."
      });
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Password recovery request failed."
      });
    }
  }
);


/* =========================================================
   RESET PASSWORD
========================================================= */

app.post(
  "/api/auth/reset-password",
  async (req, res) => {
    try {
      const mail =
        email(
          req.body.email
        );

      const code =
        text(
          req.body.code,
          20
        );

      const newPassword =
        String(
          req.body.password ||
          ""
        );

      if (
        newPassword.length < 6
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "New password must be at least 6 characters."
        });
      }

      const users =
        await readJSON(
          USERS,
          {}
        );

      const u =
        Object.values(users)
          .find(
            x =>
              x.email ===
              mail
          );

      const resets =
        await readJSON(
          RESETS,
          {}
        );

      const r =
        u
          ? resets[u.id]
          : null;

      if (
        !u ||
        !r ||
        Date.now() >
          Number(
            r.expiresAt
          ) ||
        Number(
          r.attempts || 0
        ) >= 5
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "Invalid or expired recovery code."
        });
      }

      r.attempts =
        Number(
          r.attempts || 0
        ) + 1;

      if (
        resetHash(code) !==
        r.codeHash
      ) {
        resets[u.id] =
          r;

        await writeJSON(
          RESETS,
          resets
        );

        await security(
          "PASSWORD_RECOVERY_FAILED",
          {
            userId:
              u.id,
            email:
              u.email
          }
        );

        return res.status(400).json({
          ok: false,
          message:
            "Invalid recovery code."
        });
      }

      const hp =
        hashPassword(
          newPassword
        );

      u.salt =
        hp.salt;

      u.hash =
        hp.hash;

      u.passwordChangedAt =
        new Date().toISOString();

      users[u.id] =
        u;

      await writeJSON(
        USERS,
        users
      );

      delete resets[u.id];

      await writeJSON(
        RESETS,
        resets
      );

      await destroyUserSessions(
        u.id
      );

      await security(
        "PASSWORD_CHANGED",
        {
          userId:
            u.id,
          email:
            u.email
        }
      );

      res.json({
        ok: true,
        message:
          "Password changed successfully. Please log in again."
      });
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Password reset failed."
      });
    }
  }
);


/* =========================================================
   FORGOT PASSWORD WEB PAGE
========================================================= */

app.get(
  "/forgot-password",
  (req, res) => {
    res.type("html").send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI — Forgot Password</title>
<style>
body{margin:0;background:#080b12;color:white;font-family:Arial,sans-serif}
.box{max-width:430px;margin:80px auto;padding:25px;background:#111722;border:1px solid #283246;border-radius:18px}
input,button{width:100%;padding:14px;margin-top:10px;box-sizing:border-box;border-radius:10px}
input{background:#080c14;border:1px solid #30394d;color:white}
button{border:0;font-weight:bold;cursor:pointer}
</style>
</head>
<body>
<div class="box">
<h2>✨ MAMAKI AI</h2>
<p>Enter your account email and we will send you a recovery code.</p>
<form id="form">
<input id="email" type="email" placeholder="Email address" required>
<button type="submit">Send Recovery Code</button>
</form>
<p id="msg"></p>
<a href="/">← Back to MAMAKI AI</a>
</div>
<script>
document.getElementById("form").addEventListener("submit",async function(e){
e.preventDefault();
const msg=document.getElementById("msg");
try{
const r=await fetch("/api/auth/forgot-password",{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({email:document.getElementById("email").value})
});
const d=await r.json();
msg.textContent=d.message||"Request completed.";
}catch(e){
msg.textContent="Request failed.";
}
});
</script>
</body>
</html>
    `);
  }
);


/* =========================================================
   RESET PASSWORD WEB PAGE
========================================================= */

app.get(
  "/reset-password",
  (req, res) => {
    res.type("html").send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI — Reset Password</title>
<style>
body{margin:0;background:#080b12;color:white;font-family:Arial,sans-serif}
.box{max-width:430px;margin:60px auto;padding:25px;background:#111722;border:1px solid #283246;border-radius:18px}
input,button{width:100%;padding:14px;margin-top:10px;box-sizing:border-box;border-radius:10px}
input{background:#080c14;border:1px solid #30394d;color:white}
button{border:0;font-weight:bold;cursor:pointer}
</style>
</head>
<body>
<div class="box">
<h2>✨ MAMAKI AI</h2>
<p>Enter your recovery code and choose a new password.</p>
<form id="form">
<input id="email" type="email" placeholder="Email address" required>
<input id="code" type="text" inputmode="numeric" maxlength="6" placeholder="6-digit recovery code" required>
<input id="password" type="password" minlength="6" placeholder="New password" required>
<input id="confirm" type="password" minlength="6" placeholder="Confirm new password" required>
<button type="submit">Reset Password</button>
</form>
<p id="msg"></p>
<a href="/">← Back to MAMAKI AI</a>
</div>
<script>
document.getElementById("form").addEventListener("submit",async function(e){
e.preventDefault();

const password=document.getElementById("password").value;
const confirm=document.getElementById("confirm").value;
const msg=document.getElementById("msg");

if(password!==confirm){
msg.textContent="Passwords do not match.";
return;
}

try{
const r=await fetch("/api/auth/reset-password",{
method:"POST",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({
email:document.getElementById("email").value,
code:document.getElementById("code").value,
password
})
});

const d=await r.json();

msg.textContent=d.message||"Request completed.";

if(d.ok){
setTimeout(function(){
location.href="/";
},1500);
}
}catch(e){
msg.textContent="Password reset failed.";
}
});
</script>
</body>
</html>
    `);
  }
);


/* =========================================================
   ACCOUNT
========================================================= */

app.get(
  "/api/account",
  requireUser,
  async (req, res) => {
    const db =
      await readJSON(
        USAGE,
        {}
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
          req.user.role
      },

      usage:
        db[req.user.id] ||
        {
          aiGenerations: 0,
          aiSeconds: 0,
          studioJobs: 0,
          narrationJobs: 0
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
        text(
          req.body.name,
          100
        );

      if (!name) {
        return res.status(400).json({
          ok: false,
          message:
            "Name is required."
        });
      }

      const users =
        await readJSON(
          USERS,
          {}
        );

      const u =
        users[req.user.id];

      if (!u) {
        return res.status(404).json({
          ok: false,
          message:
            "Account not found."
        });
      }

      u.name =
        name;

      users[u.id] =
        u;

      await writeJSON(
        USERS,
        users
      );

      res.json({
        ok: true,
        user: {
          id:
            u.id,
          name:
            u.name,
          email:
            u.email,
          role:
            u.role
        }
      });
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Profile update failed."
      });
    }
  }
);


/* =========================================================
   VIDEO HELPERS
========================================================= */

async function downloadOutput(
  output,
  filename
) {
  let url = "";

  if (
    typeof output ===
    "string"
  ) {
    url = output;
  } else if (
    output?.url
  ) {
    const result =
      output.url();

    url =
      typeof result ===
      "string"
        ? result
        : String(result);
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
      `Download failed with HTTP ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  const file =
    path.join(
      OUTPUTS,
      safeFileName(
        filename
      )
    );

  await fs.writeFile(
    file,
    buffer
  );

  return file;
}

function runFFmpeg(
  args
) {
  return new Promise(
    (resolve, reject) => {
      const p =
        spawn(
          ffmpegPath,
          args
        );

      let stderr = "";

      p.stderr.on(
        "data",
        d => {
          stderr +=
            d.toString();
        }
      );

      p.on(
        "error",
        reject
      );

      p.on(
        "close",
        code => {
          if (
            code === 0
          ) {
            resolve();
          } else {
            reject(
              new Error(
                stderr.slice(-5000) ||
                `FFmpeg exited with code ${code}`
              )
            );
          }
        }
      );
    }
  );
}

async function exactDuration(
  input,
  seconds
) {
  const output =
    path.join(
      OUTPUTS,
      `${randomUUID()}.mp4`
    );

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
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    output
  ]);

  await fs.rm(
    input,
    {
      force: true
    }
  );

  await fs.rename(
    output,
    input
  );
}

async function watermark(
  input
) {
  const output =
    path.join(
      OUTPUTS,
      `${randomUUID()}.mp4`
    );

  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    "drawtext=text='MAMAKI':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.45:boxborderw=8:x=20:y=h-th-20",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-c:a",
    "copy",
    output
  ]);

  await fs.rm(
    input,
    {
      force: true
    }
  );

  await fs.rename(
    output,
    input
  );
}


/* =========================================================
   AI VIDEO GENERATION
========================================================= */

async function generateVideo({
  prompt,
  image,
  seconds,
  ratioValue,
  userId
}) {
  if (!replicate) {
    throw new Error(
      "REPLICATE_API_TOKEN is not configured."
    );
  }

  const model =
    image
      ? I2V_MODEL
      : T2V_MODEL;

  const input = {
    prompt,

    num_frames:
      seconds <= 5
        ? 81
        : 121,

    width:
      ratioValue === "9:16"
        ? 480
        : ratioValue === "1:1"
          ? 480
          : 640,

    height:
      ratioValue === "9:16"
        ? 640
        : ratioValue === "1:1"
          ? 480
          : 480,

    fps: 16
  };

  if (image) {
    input.image =
      image;
  }

  const output =
    await replicate.run(
      model,
      {
        input
      }
    );

  const file =
    await downloadOutput(
      output,
      `${randomUUID()}.mp4`
    );

  await exactDuration(
    file,
    seconds
  );

  try {
    await watermark(
      file
    );
  } catch (e) {
    await errorLog(
      e,
      {
        action:
          "WATERMARK"
      }
    );
  }

  await usage(
    userId,
    "ai",
    seconds
  );

  return {
    file,

    url:
      `/outputs/${path.basename(file)}`
  };
}


/* =========================================================
   GENERATE VIDEO
========================================================= */

app.post(
  "/api/generate",
  requireUser,
  upload.single("image"),
  async (req, res) => {
    try {
      const prompt =
        text(
          req.body.prompt,
          10000
        );

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          message:
            "Please enter a video prompt."
        });
      }

      const seconds =
        duration(
          req.body.duration
        );

      const r =
        ratio(
          req.body.ratio
        );

      let image =
        null;

      let temporaryImage =
        null;

      if (req.file) {
        const ext =
          path.extname(
            safeFileName(
              req.file.originalname
            )
          ) || ".jpg";

        temporaryImage =
          path.join(
            TMP,
            `${randomUUID()}${ext}`
          );

        await fs.writeFile(
          temporaryImage,
          req.file.buffer
        );

        image =
          `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      }

      const id =
        randomUUID();

      jobs.set(
        id,
        {
          id,
          userId:
            req.user.id,
          status:
            "processing",
          progress: 5,
          createdAt:
            new Date().toISOString()
        }
      );

      res.json({
        ok: true,
        jobId: id,
        status:
          "processing"
      });

      (async () => {
        try {
          const job =
            jobs.get(id);

          if (job) {
            job.progress =
              20;
          }

          const result =
            await generateVideo({
              prompt,
              image,
              seconds,
              ratioValue: r,
              userId:
                req.user.id
            });

          const finished =
            jobs.get(id);

          if (finished) {
            finished.progress =
              100;

            finished.status =
              "completed";

            finished.url =
              result.url;

            finished.completedAt =
              new Date().toISOString();
          }
        } catch (e) {
          const failed =
            jobs.get(id);

          if (failed) {
            failed.status =
              "failed";

            failed.progress =
              100;

            failed.error =
              String(
                e?.message ||
                e
              );

            failed.completedAt =
              new Date().toISOString();
          }

          await errorLog(
            e,
            {
              jobId: id,
              userId:
                req.user.id
            }
          );
        } finally {
          if (
            temporaryImage
          ) {
            await fs.rm(
              temporaryImage,
              {
                force: true
              }
            );
          }
        }
      })();

    } catch (e) {
      await errorLog(e);

      if (
        !res.headersSent
      ) {
        res.status(500).json({
          ok: false,
          message:
            "Video generation failed."
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

    if (
      !job ||
      job.userId !==
        req.user.id
    ) {
      return res.status(404).json({
        ok: false,
        message:
          "Job not found."
      });
    }

    res.json({
      ok: true,
      job
    });
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

      const projects =
        [];

      for (
        const f of files
      ) {
        if (
          !f.endsWith(
            ".json"
          )
        ) {
          continue;
        }

        const p =
          await readJSON(
            path.join(
              PROJECTS,
              f
            ),
            null
          );

        if (
          p &&
          p.userId ===
            req.user.id
        ) {
          projects.push(p);
        }
      }

      projects.sort(
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
        projects
      });
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Unable to load projects."
      });
    }
  }
);

app.post(
  "/api/projects",
  requireUser,
  async (req, res) => {
    try {
      const p = {
        id:
          randomUUID(),

        userId:
          req.user.id,

        name:
          text(
            req.body.name,
            200
          ) ||
          "Untitled Project",

        prompt:
          text(
            req.body.prompt,
            10000
          ),

        createdAt:
          new Date().toISOString()
      };

      await writeJSON(
        path.join(
          PROJECTS,
          `${p.id}.json`
        ),
        p
      );

      res.json({
        ok: true,
        project: p
      });
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Project creation failed."
      });
    }
  }
);

app.delete(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    try {
      const file =
        path.join(
          PROJECTS,
          `${safeFileName(
            req.params.id
          )}.json`
        );

      const p =
        await readJSON(
          file,
          null
        );

      if (
        !p ||
        p.userId !==
          req.user.id
      ) {
        return res.status(404).json({
          ok: false,
          message:
            "Project not found."
        });
      }

      await fs.rm(
        file,
        {
          force: true
        }
      );

      res.json({
        ok: true
      });
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Project deletion failed."
      });
    }
  }
);


/* =========================================================
   FREE STUDIO — TRIM
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
          message:
            "Video required."
        });
      }

      const input =
        path.join(
          TMP,
          `${randomUUID()}.mp4`
        );

      const output =
        path.join(
          OUTPUTS,
          `${randomUUID()}.mp4`
        );

      await fs.writeFile(
        input,
        req.file.buffer
      );

      const start =
        Math.max(
          0,
          Number(
            req.body.start ||
            0
          )
        );

      const end =
        Math.max(
          start + 0.1,
          Number(
            req.body.end ||
            5
          )
        );

      await runFFmpeg([
        "-y",
        "-ss",
        String(start),
        "-i",
        input,
        "-t",
        String(
          end - start
        ),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        output
      ]);

      await fs.rm(
        input,
        {
          force: true
        }
      );

      await usage(
        req.user.id,
        "studio"
      );

      res.json({
        ok: true,
        url:
          `/outputs/${path.basename(output)}`
      });
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Video trimming failed."
      });
    }
  }
);


/* =========================================================
   FREE STUDIO — COMBINE
========================================================= */

app.post(
  "/api/studio/combine",
  requireUser,
  upload.array(
    "videos",
    20
  ),
  async (req, res) => {
    const inputs = [];
    let list = null;

    try {
      if (
        !req.files ||
        req.files.length < 2
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "At least two videos are required."
        });
      }

      list =
        path.join(
          TMP,
          `${randomUUID()}.txt`
        );

      for (
        const file of req.files
      ) {
        const p =
          path.join(
            TMP,
            `${randomUUID()}.mp4`
          );

        await fs.writeFile(
          p,
          file.buffer
        );

        inputs.push(p);
      }

      await fs.writeFile(
        list,
        inputs
          .map(
            p =>
              `file '${p.replace(
                /'/g,
                "'\\''"
              )}'`
          )
          .join("\n")
      );

      const output =
        path.join(
          OUTPUTS,
          `${randomUUID()}.mp4`
        );

      await runFFmpeg([
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-c",
        "copy",
        output
      ]);

      await usage(
        req.user.id,
        "studio"
      );

      res.json({
        ok: true,
        url:
          `/outputs/${path.basename(output)}`
      });
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Video combination failed."
      });
    } finally {
      for (
        const p of inputs
      ) {
        await fs.rm(
          p,
          {
            force: true
          }
        );
      }

      if (list) {
        await fs.rm(
          list,
          {
            force: true
          }
        );
      }
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
      const script =
        text(
          req.body.text,
          15000
        );

      if (!script) {
        return res.status(400).json({
          ok: false,
          message:
            "Narration text is required."
        });
      }

      const voice =
        text(
          req.body.voice,
          200
        ) ||
        "en-US-EmmaMultilingualNeural";

      const file =
        path.join(
          OUTPUTS,
          `${randomUUID()}.mp3`
        );

      const tts =
        new EdgeTTS({
          voice
        });

      await tts.synthesize(
        script,
        file
      );

      await usage(
        req.user.id,
        "narration"
      );

      res.json({
        ok: true,
        url:
          `/outputs/${path.basename(file)}`
      });
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Narration generation failed."
      });
    }
  }
);


/* =========================================================
   ADMIN LOGIN
   IMPORTANT:
   DOES NOT CREATE A NEW ADMIN ACCOUNT.
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
          req.body.password ||
          ""
        );

      if (
        !ADMIN_EMAIL ||
        !ADMIN_PASSWORD
      ) {
        return res.status(503).json({
          ok: false,
          message:
            "Admin environment variables are not configured."
        });
      }

      if (
        mail !==
          ADMIN_EMAIL ||
        password !==
          ADMIN_PASSWORD
      ) {
        await security(
          "ADMIN_LOGIN_FAILED",
          {
            email: mail
          }
        );

        return res.status(401).json({
          ok: false,
          message:
            "Invalid administrator credentials."
        });
      }

      const users =
        await readJSON(
          USERS,
          {}
        );

      /*
       * IMPORTANT:
       * Search for the existing administrator.
       * NEVER create another admin account.
       */

      const admin =
        Object.values(users)
          .find(
            u =>
              u.email ===
                ADMIN_EMAIL &&
              u.role ===
                "admin"
          );

      if (!admin) {
        return res.status(404).json({
          ok: false,
          error:
            "ADMIN_ACCOUNT_NOT_FOUND",
          message:
            "The configured administrator account was not found. Your existing admin account must be restored rather than creating another account."
        });
      }

      if (admin.disabled) {
        return res.status(403).json({
          ok: false,
          message:
            "Administrator account is disabled."
        });
      }

      const t =
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
            admin.email
        }
      );

      res.json({
        ok: true,
        token: t,
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
      await errorLog(e);

      res.status(500).json({
        ok: false,
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

      const usageDb =
        await readJSON(
          USAGE,
          {}
        );

      const errors =
        await readJSON(
          ERRORS,
          {}
        );

      let generations = 0;
      let seconds = 0;
      let studio = 0;
      let narration = 0;

      for (
        const u of Object.values(
          usageDb
        )
      ) {
        generations +=
          Number(
            u.aiGenerations ||
            0
          );

        seconds +=
          Number(
            u.aiSeconds ||
            0
          );

        studio +=
          Number(
            u.studioJobs ||
            0
          );

        narration +=
          Number(
            u.narrationJobs ||
            0
          );
      }

      let projects = 0;

      try {
        const files =
          await fs.readdir(
            PROJECTS
          );

        projects =
          files.filter(
            f =>
              f.endsWith(
                ".json"
              )
          ).length;
      } catch {}

      res.json({
        ok: true,

        stats: {
          totalUsers:
            Object.keys(
              users
            ).length,

          totalProjects:
            projects,

          aiGenerations:
            generations,

          aiSeconds:
            seconds,

          studioJobs:
            studio,

          narrationJobs:
            narration,

          failedJobs:
            Array.from(
              jobs.values()
            ).filter(
              j =>
                j.status ===
                "failed"
            ).length,

          recordedErrors:
            Object.keys(
              errors
            ).length,

          replicateConfigured:
            Boolean(
              REPLICATE_API_TOKEN
            ),

          recoveryConfigured:
            Boolean(
              RESEND_API_KEY &&
              RESEND_FROM
            )
        }
      });
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Unable to load administrator statistics."
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
        await readJSON(
          USERS,
          {}
        );

      const usageDb =
        await readJSON(
          USAGE,
          {}
        );

      res.json({
        ok: true,

        users:
          Object.values(
            users
          ).map(
            u => ({
              id:
                u.id,

              name:
                u.name,

              email:
                u.email,

              role:
                u.role,

              disabled:
                Boolean(
                  u.disabled
                ),

              createdAt:
                u.createdAt,

              lastLoginAt:
                u.lastLoginAt ||
                null,

              usage:
                usageDb[u.id] ||
                {}
            })
          )
      });
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Unable to load users."
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
    try {
      const users =
        await readJSON(
          USERS,
          {}
        );

      const u =
        users[
          req.params.id
        ];

      if (!u) {
        return res.status(404).json({
          ok: false,
          message:
            "User not found."
        });
      }

      const usageDb =
        await readJSON(
          USAGE,
          {}
        );

      res.json({
        ok: true,

        user: {
          id:
            u.id,

          name:
            u.name,

          email:
            u.email,

          role:
            u.role,

          disabled:
            Boolean(
              u.disabled
            ),

          createdAt:
            u.createdAt,

          lastLoginAt:
            u.lastLoginAt ||
            null,

          usage:
            usageDb[u.id] ||
            {}
        }
      });
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Unable to load user."
      });
    }
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

      const u =
        users[
          req.params.id
        ];

      if (!u) {
        return res.status(404).json({
          ok: false,
          message:
            "User not found."
        });
      }

      /*
       * NEVER allow the main administrator
       * to be disabled here.
       */

      if (
        u.email ===
        ADMIN_EMAIL
      ) {
        return res.status(400).json({
          ok: false,
          message:
            "The main administrator account cannot be disabled from this endpoint."
        });
      }

      u.disabled =
        Boolean(
          req.body.disabled !==
            false
        );

      users[u.id] =
        u;

      await writeJSON(
        USERS,
        users
      );

      if (u.disabled) {
        await destroyUserSessions(
          u.id
        );
      }

      await security(
        u.disabled
          ? "USER_DISABLED"
          : "USER_ENABLED",
        {
          userId:
            u.id,
          email:
            u.email,
          adminId:
            req.user.id
        }
      );

      res.json({
        ok: true,
        disabled:
          Boolean(
            u.disabled
          )
      });
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Unable to update user."
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
    res.json({
      ok: true,
      jobs:
        Array.from(
          jobs.values()
        )
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
    const db =
      await readJSON(
        ERRORS,
        {}
      );

    res.json({
      ok: true,

      errors:
        Object.values(
          db
        )
          .reverse()
          .slice(
            0,
            200
          )
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
    const db =
      await readJSON(
        SECURITY,
        {}
      );

    res.json({
      ok: true,

      events:
        Object.values(
          db
        )
          .reverse()
          .slice(
            0,
            200
          )
    });
  }
);


/* =========================================================
   ADMIN PAGE
   IMPORTANT:
   NO NESTED BACKTICKS INSIDE THIS HTML TEMPLATE.
========================================================= */

app.get(
  "/admin",
  (req, res) => {
    res.type("html").send(`
<!doctype html>
<html lang="en">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>MAMAKI AI — Admin</title>

<style>

*{
  box-sizing:border-box;
}

body{
  margin:0;
  background:#080b12;
  color:#fff;
  font-family:Arial,sans-serif;
}

header{
  padding:20px;
  border-bottom:1px solid #252d3d;
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:15px;
  flex-wrap:wrap;
}

.logo{
  font-weight:900;
  font-size:22px;
}

button{
  border:0;
  border-radius:10px;
  padding:11px 16px;
  cursor:pointer;
  font-weight:700;
}

.primary{
  background:#fff;
  color:#000;
}

.danger{
  background:#ff4d4d;
  color:#fff;
}

main{
  max-width:1300px;
  margin:auto;
  padding:25px;
}

.card{
  background:#111722;
  border:1px solid #263044;
  border-radius:18px;
  padding:20px;
  margin-bottom:20px;
}

.grid{
  display:grid;
  grid-template-columns:
    repeat(
      auto-fit,
      minmax(180px,1fr)
    );
  gap:15px;
}

.stat{
  background:#0c111b;
  border:1px solid #252f42;
  border-radius:15px;
  padding:18px;
}

.stat b{
  display:block;
  font-size:28px;
  margin-top:8px;
}

table{
  width:100%;
  border-collapse:collapse;
}

th,
td{
  padding:12px;
  text-align:left;
  border-bottom:1px solid #252d3d;
  font-size:14px;
}

.scroll{
  overflow:auto;
}

#login{
  max-width:430px;
  margin:70px auto;
}

input{
  width:100%;
  padding:14px;
  margin:7px 0;
  background:#090e16;
  border:1px solid #303a4e;
  border-radius:10px;
  color:#fff;
}

.notice{
  padding:12px;
  border-radius:10px;
  margin-top:12px;
  display:none;
  background:#35151b;
  border:1px solid #73303b;
}

</style>

</head>

<body>

<header>

<div class="logo">
✨ MAMAKI AI ADMIN
</div>

<button
  class="danger"
  onclick="logout()"
>
Logout
</button>

</header>

<main>

<section
  id="login"
  class="card"
>

<h2>
Administrator Login
</h2>

<form
  id="loginForm"
>

<input
  id="email"
  type="email"
  placeholder="Administrator email"
  required
>

<input
  id="password"
  type="password"
  placeholder="Administrator password"
  required
>

<button
  class="primary"
  style="width:100%;margin-top:10px"
  type="submit"
>
Login
</button>

</form>

<div
  id="loginMsg"
  class="notice"
></div>

</section>


<section
  id="dashboard"
  style="display:none"
>

<div
  class="grid"
  id="stats"
></div>


<div class="card">

<h2>
Users
</h2>

<div class="scroll">

<table>

<thead>

<tr>

<th>Name</th>
<th>Email</th>
<th>Role</th>
<th>Status</th>
<th>AI Generations</th>
<th>AI Seconds</th>
<th>Action</th>

</tr>

</thead>

<tbody
  id="users"
></tbody>

</table>

</div>

</div>


<div class="card">

<h2>
Current Jobs
</h2>

<div class="scroll">

<table>

<thead>

<tr>

<th>ID</th>
<th>User</th>
<th>Status</th>
<th>Progress</th>
<th>Created</th>

</tr>

</thead>

<tbody
  id="jobs"
></tbody>

</table>

</div>

</div>


<div class="card">

<h2>
Recent Security Events
</h2>

<div class="scroll">

<table>

<thead>

<tr>

<th>Type</th>
<th>Email</th>
<th>Date</th>

</tr>

</thead>

<tbody
  id="security"
></tbody>

</table>

</div>

</div>


<div class="card">

<h2>
Recent Errors
</h2>

<div class="scroll">

<table>

<thead>

<tr>

<th>Date</th>
<th>Message</th>

</tr>

</thead>

<tbody
  id="errors"
></tbody>

</table>

</div>

</div>

</section>

</main>


<script>

let adminToken =
  localStorage.getItem(
    "mamaki_admin_token"
  ) || "";


function esc(v){

  return String(
    v == null ? "" : v
  )
  .replaceAll(
    "&",
    "&amp;"
  )
  .replaceAll(
    "<",
    "&lt;"
  )
  .replaceAll(
    ">",
    "&gt;"
  )
  .replaceAll(
    '"',
    "&quot;"
  )
  .replaceAll(
    "'",
    "&#039;"
  );

}


function showLoginMessage(
  message
){

  const el =
    document.getElementById(
      "loginMsg"
    );

  el.style.display =
    "block";

  el.textContent =
    message;

}


async function api(
  url,
  options
){

  options =
    options || {};

  options.headers =
    Object.assign(
      {},
      options.headers || {},
      {
        Authorization:
          "Bearer " +
          adminToken,

        "Content-Type":
          "application/json"
      }
    );

  const r =
    await fetch(
      url,
      options
    );

  const data =
    await r.json()
      .catch(
        function(){
          return {};
        }
      );

  if(!r.ok){

    throw new Error(
      data.message ||
      "Request failed."
    );

  }

  return data;

}


function logout(){

  localStorage.removeItem(
    "mamaki_admin_token"
  );

  adminToken = "";

  location.reload();

}


document
  .getElementById(
    "loginForm"
  )
  .addEventListener(
    "submit",
    async function(e){

      e.preventDefault();

      try{

        const r =
          await fetch(
            "/api/admin/login",
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
                    document
                      .getElementById(
                        "email"
                      )
                      .value,

                  password:
                    document
                      .getElementById(
                        "password"
                      )
                      .value
                })
            }
          );

        const data =
          await r.json();

        if(!r.ok){

          throw new Error(
            data.message ||
            "Login failed."
          );

        }

        adminToken =
          data.token;

        localStorage.setItem(
          "mamaki_admin_token",
          adminToken
        );

        await loadDashboard();

      }catch(e){

        showLoginMessage(
          e.message
        );

      }

    }
  );


async function loadDashboard(){

  try{

    const result =
      await Promise.all([
        api(
          "/api/admin/stats"
        ),

        api(
          "/api/admin/users"
        ),

        api(
          "/api/admin/jobs"
        ),

        api(
          "/api/admin/security"
        ),

        api(
          "/api/admin/errors"
        )
      ]);

    const stats =
      result[0];

    const users =
      result[1];

    const jobs =
      result[2];

    const security =
      result[3];

    const errors =
      result[4];


    document
      .getElementById(
        "login"
      )
      .style.display =
      "none";


    document
      .getElementById(
        "dashboard"
      )
      .style.display =
      "block";


    const s =
      stats.stats;


    let statsHTML =
      "";

    statsHTML +=
      '<div class="stat">Users<b>' +
      esc(s.totalUsers) +
      '</b></div>';

    statsHTML +=
      '<div class="stat">Projects<b>' +
      esc(s.totalProjects) +
      '</b></div>';

    statsHTML +=
      '<div class="stat">AI Generations<b>' +
      esc(s.aiGenerations) +
      '</b></div>';

    statsHTML +=
      '<div class="stat">AI Seconds<b>' +
      esc(s.aiSeconds) +
      '</b></div>';

    statsHTML +=
      '<div class="stat">Studio Jobs<b>' +
      esc(s.studioJobs) +
      '</b></div>';

    statsHTML +=
      '<div class="stat">Narration Jobs<b>' +
      esc(s.narrationJobs) +
      '</b></div>';

    statsHTML +=
      '<div class="stat">Failed Jobs<b>' +
      esc(s.failedJobs) +
      '</b></div>';

    statsHTML +=
      '<div class="stat">Errors<b>' +
      esc(s.recordedErrors) +
      '</b></div>';

    document
      .getElementById(
        "stats"
      )
      .innerHTML =
      statsHTML;


    let usersHTML =
      "";

    if(
      users.users &&
      users.users.length
    ){

      users.users.forEach(
        function(u){

          let action =
            "Admin";

          if(
            u.role !==
            "admin"
          ){

            action =
              '<button onclick="toggleUser(' +
              JSON.stringify(
                u.id
              ) +
              "," +
              String(
                !u.disabled
              ) +
              ')">' +
              (
                u.disabled
                  ? "Enable"
                  : "Disable"
              ) +
              "</button>";

          }

          usersHTML +=
            "<tr>" +

            "<td>" +
            esc(u.name) +
            "</td>" +

            "<td>" +
            esc(u.email) +
            "</td>" +

            "<td>" +
            esc(u.role) +
            "</td>" +

            "<td>" +
            (
              u.disabled
                ? "Disabled"
                : "Active"
            ) +
            "</td>" +

            "<td>" +
            esc(
              u.usage &&
              u.usage.aiGenerations ||
              0
            ) +
            "</td>" +

            "<td>" +
            esc(
              u.usage &&
              u.usage.aiSeconds ||
              0
            ) +
            "</td>" +

            "<td>" +
            action +
            "</td>" +

            "</tr>";

        }
      );

    }else{

      usersHTML =
        '<tr><td colspan="7">No users found.</td></tr>';

    }

    document
      .getElementById(
        "users"
      )
      .innerHTML =
      usersHTML;


    let jobsHTML =
      "";

    if(
      jobs.jobs &&
      jobs.jobs.length
    ){

      jobs.jobs.forEach(
        function(j){

          jobsHTML +=
            "<tr>" +

            "<td>" +
            esc(j.id) +
            "</td>" +

            "<td>" +
            esc(j.userId) +
            "</td>" +

            "<td>" +
            esc(j.status) +
            "</td>" +

            "<td>" +
            esc(
              j.progress ||
              0
            ) +
            "%</td>" +

            "<td>" +
            esc(j.createdAt) +
            "</td>" +

            "</tr>";

        }
      );

    }else{

      jobsHTML =
        '<tr><td colspan="5">No active jobs.</td></tr>';

    }

    document
      .getElementById(
        "jobs"
      )
      .innerHTML =
      jobsHTML;


    let securityHTML =
      "";

    if(
      security.events &&
      security.events.length
    ){

      security.events
        .slice(
          0,
          100
        )
        .forEach(
          function(e){

            securityHTML +=
              "<tr>" +

              "<td>" +
              esc(e.type) +
              "</td>" +

              "<td>" +
              esc(
                e.email ||
                ""
              ) +
              "</td>" +

              "<td>" +
              esc(e.createdAt) +
              "</td>" +

              "</tr>";

          }
        );

    }else{

      securityHTML =
        '<tr><td colspan="3">No events.</td></tr>';

    }

    document
      .getElementById(
        "security"
      )
      .innerHTML =
      securityHTML;


    let errorsHTML =
      "";

    if(
      errors.errors &&
      errors.errors.length
    ){

      errors.errors
        .slice(
          0,
          100
        )
        .forEach(
          function(e){

            errorsHTML +=
              "<tr>" +

              "<td>" +
              esc(e.createdAt) +
              "</td>" +

              "<td>" +
              esc(e.message) +
              "</td>" +

              "</tr>";

          }
        );

    }else{

      errorsHTML =
        '<tr><td colspan="2">No errors.</td></tr>';

    }

    document
      .getElementById(
        "errors"
      )
      .innerHTML =
      errorsHTML;

  }catch(e){

    localStorage.removeItem(
      "mamaki_admin_token"
    );

    adminToken =
      "";

    document
      .getElementById(
        "dashboard"
      )
      .style.display =
      "none";

    document
      .getElementById(
        "login"
      )
      .style.display =
      "block";

    showLoginMessage(
      e.message
    );

  }

}


async function toggleUser(
  id,
  disabled
){

  if(
    !confirm(
      disabled
        ? "Disable this user?"
        : "Enable this user?"
    )
  ){

    return;

  }

  try{

    await api(
      "/api/admin/users/" +
      encodeURIComponent(
        id
      ) +
      "/disable",
      {
        method:
          "POST",

        body:
          JSON.stringify({
            disabled:
              disabled
          })
      }
    );

    await loadDashboard();

  }catch(e){

    alert(
      e.message
    );

  }

}


if(adminToken){

  loadDashboard();

}

</script>

</body>
</html>
    `);
  }
);


/* =========================================================
   OUTPUTS
========================================================= */

app.use(
  "/outputs",
  express.static(
    OUTPUTS,
    {
      maxAge: "1h",
      etag: true
    }
  )
);


/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {

    res.json({
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
  "/health",
  (req, res) => {

    res.json({
      ok: true,
      app:
        "MAMAKI AI",
      version:
        VERSION,
      uptime:
        process.uptime()
    });

  }
);


/* =========================================================
   STATUS
========================================================= */

app.get(
  "/api/status",
  (req, res) => {

    res.json({
      ok: true,
      app:
        "MAMAKI AI",

      version:
        VERSION,

      replicate:
        Boolean(
          REPLICATE_API_TOKEN
        ),

      models: {
        textToVideo:
          T2V_MODEL,

        imageToVideo:
          I2V_MODEL
      },

      duration: {
        minimum:
          MIN_DURATION,

        maximum:
          MAX_DURATION
      },

      recovery:
        Boolean(
          RESEND_API_KEY &&
          RESEND_FROM
        )
    });

  }
);


/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {

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
      path:
        req.originalUrl
    });

  }
);


/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
  async (
    err,
    req,
    res,
    next
  ) => {

    await errorLog(
      err,
      {
        route:
          req.originalUrl,
        method:
          req.method
      }
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    res.status(500).json({
      ok: false,
      error:
        "INTERNAL_SERVER_ERROR",
      message:
        "MAMAKI encountered an unexpected server error."
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
        job
      ] of jobs.entries()
    ) {

      if (
        [
          "completed",
          "failed"
        ].includes(
          job.status
        )
      ) {

        const time =
          Date.parse(
            job.completedAt ||
            job.createdAt ||
            ""
          );

        if (
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

    }

  },
  10 *
  60 *
  1000
);


/* =========================================================
   TEMP FILE CLEANUP
========================================================= */

async function cleanupTempFiles() {

  try {

    const files =
      await fs.readdir(
        TMP
      );

    const now =
      Date.now();

    for (
      const file of files
    ) {

      try {

        const full =
          path.join(
            TMP,
            file
          );

        const stat =
          await fs.stat(
            full
          );

        if (
          now -
            stat.mtimeMs >
          2 *
            60 *
            60 *
            1000
        ) {

          await fs.rm(
            full,
            {
              force: true
            }
          );

        }

      } catch {}

    }

  } catch {}

}

setInterval(
  cleanupTempFiles,
  30 *
  60 *
  1000
);


/* =========================================================
   START
========================================================= */

await ensureStorage();

await cleanupTempFiles();

app.listen(
  PORT,
  HOST,
  () => {

    console.log(
      `✨ MAMAKI AI v${VERSION} running on ${HOST}:${PORT}`
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

    console.log(
      "App URL: " +
      APP_URL
    );

  }
);
