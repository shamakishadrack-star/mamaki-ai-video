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

const T2V_MODEL =
  process.env.T2V_MODEL ||
  "wan-video/wan-2.2-t2v-fast";

const I2V_MODEL =
  process.env.I2V_MODEL ||
  "wan-video/wan-2.2-i2v-fast";

const replicate = REPLICATE_API_TOKEN
  ? new Replicate({ auth: REPLICATE_API_TOKEN })
  : null;

const jobs = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

app.disable("x-powered-by");

app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "30mb"
}));

app.use((req, res, next) => {
  res.setHeader("X-MAMAKI-Version", VERSION);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

/* ========================= STORAGE ========================= */

async function ensureStorage() {
  await fs.mkdir(TMP, { recursive: true });
  await fs.mkdir(OUTPUTS, { recursive: true });
  await fs.mkdir(PROJECTS, { recursive: true });
  await fs.mkdir(DATA, { recursive: true });

  for (const file of [
    USERS,
    SESSIONS,
    USAGE,
    ERRORS,
    SECURITY,
    RESETS
  ]) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, "{}", "utf8");
    }
  }
}

async function readJSON(file, fallback = {}) {
  try {
    const data = await fs.readFile(file, "utf8");
    return data.trim() ? JSON.parse(data) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJSON(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(
    temp,
    JSON.stringify(data, null, 2),
    "utf8"
  );
  await fs.rename(temp, file);
}

/* ========================= HELPERS ========================= */

function text(value, max = 10000) {
  return String(value || "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, max);
}

function email(value) {
  return text(value, 200).toLowerCase();
}

function duration(value) {
  if (typeof value === "string") {
    const m = value.trim().match(
      /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/i
    );

    if (m) {
      let n = Number(m[1]);
      const unit = String(m[2] || "s").toLowerCase();

      if (["m", "min", "mins"].includes(unit)) n *= 60;
      if (["h", "hr", "hrs"].includes(unit)) n *= 3600;

      return Math.max(
        MIN_DURATION,
        Math.min(MAX_DURATION, Math.round(n))
      );
    }
  }

  const n = Number(value);

  if (!Number.isFinite(n)) return MIN_DURATION;

  return Math.max(
    MIN_DURATION,
    Math.min(MAX_DURATION, Math.round(n))
  );
}

function ratio(value) {
  return ["16:9", "9:16", "1:1"].includes(String(value))
    ? String(value)
    : "16:9";
}

function ratioSize(r) {
  if (r === "9:16") return "1080:1920";
  if (r === "1:1") return "1080:1080";
  return "1920:1080";
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: scryptSync(
      String(password),
      salt,
      64
    ).toString("hex")
  };
}

function verifyPassword(password, salt, expected) {
  try {
    const actual = scryptSync(
      String(password),
      salt,
      64
    );

    const stored = Buffer.from(expected, "hex");

    return (
      actual.length === stored.length &&
      timingSafeEqual(actual, stored)
    );
  } catch {
    return false;
  }
}

function token() {
  const random = randomBytes(32).toString("hex");

  const secret = SESSION_SECRET
    ? scryptSync(
        SESSION_SECRET,
        random.slice(0, 16),
        32
      ).toString("hex")
    : "";

  return `${random}.${secret}`;
}

function bearer(req) {
  const h = String(
    req.headers.authorization || ""
  );

  return h.toLowerCase().startsWith("bearer ")
    ? h.slice(7).trim()
    : "";
}

async function createSession(userId, role) {
  const sessions = await readJSON(SESSIONS, {});
  const t = token();

  sessions[t] = {
    userId,
    role,
    createdAt: Date.now(),
    lastSeen: Date.now()
  };

  await writeJSON(SESSIONS, sessions);

  return t;
}

async function currentUser(req) {
  const t = bearer(req);

  if (!t) return null;

  const sessions = await readJSON(SESSIONS, {});
  const s = sessions[t];

  if (!s) return null;

  if (
    Date.now() -
      Number(s.createdAt || 0) >
    30 * 24 * 60 * 60 * 1000
  ) {
    delete sessions[t];
    await writeJSON(SESSIONS, sessions);
    return null;
  }

  const users = await readJSON(USERS, {});
  const u = users[s.userId];

  if (!u || u.disabled) return null;

  s.lastSeen = Date.now();
  sessions[t] = s;

  await writeJSON(SESSIONS, sessions);

  return {
    ...u,
    sessionRole: s.role
  };
}

async function requireUser(req, res, next) {
  const u = await currentUser(req);

  if (!u) {
    return res.status(401).json({
      ok: false,
      error: "AUTH_REQUIRED",
      message: "Please log in."
    });
  }

  req.user = u;
  next();
}

async function requireAdmin(req, res, next) {
  const u = await currentUser(req);

  if (!u || u.role !== "admin") {
    return res.status(403).json({
      ok: false,
      error: "ADMIN_REQUIRED",
      message: "Administrator access required."
    });
  }

  req.user = u;
  next();
}

/* ========================= LOGGING ========================= */

async function security(type, data = {}) {
  const db = await readJSON(SECURITY, {});
  const id = randomUUID();

  db[id] = {
    id,
    type,
    createdAt: new Date().toISOString(),
    ...data
  };

  const keys = Object.keys(db);

  if (keys.length > 500) {
    keys
      .sort(
        (a, b) =>
          String(db[a].createdAt)
            .localeCompare(
              String(db[b].createdAt)
            )
      )
      .slice(0, keys.length - 500)
      .forEach(k => delete db[k]);
  }

  await writeJSON(SECURITY, db);
}

async function errorLog(err, context = {}) {
  const db = await readJSON(ERRORS, {});
  const id = randomUUID();

  db[id] = {
    id,
    createdAt: new Date().toISOString(),
    message: String(
      err?.message || err || "Unknown error"
    ).slice(0, 2000),
    context
  };

  await writeJSON(ERRORS, db);
}

async function usage(userId, type, seconds = 0) {
  const db = await readJSON(USAGE, {});

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
    db[userId].aiGenerations++;
    db[userId].aiSeconds += Number(seconds || 0);
  }

  if (type === "studio") {
    db[userId].studioJobs++;
  }

  if (type === "narration") {
    db[userId].narrationJobs++;
  }

  db[userId].updatedAt = Date.now();

  await writeJSON(USAGE, db);
}

/* ========================= AUTH ========================= */

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = text(req.body.name, 100);
    const mail = email(req.body.email);
    const password = String(req.body.password || "");

    if (!name || !mail || password.length < 6) {
      return res.status(400).json({
        ok: false,
        message:
          "Name, valid email and password of at least 6 characters are required."
      });
    }

    const users = await readJSON(USERS, {});

    if (
      Object.values(users)
        .some(u => u.email === mail)
    ) {
      return res.status(409).json({
        ok: false,
        message: "An account with this email already exists."
      });
    }

    const id = randomUUID();
    const hp = hashPassword(password);

    users[id] = {
      id,
      name,
      email: mail,
      ...hp,
      role: "user",
      disabled: false,
      createdAt: new Date().toISOString()
    };

    await writeJSON(USERS, users);

    const t = await createSession(id, "user");

    await security("ACCOUNT_CREATED", {
      userId: id,
      email: mail
    });

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
    await errorLog(e, { route: req.originalUrl });

    res.status(500).json({
      ok: false,
      message: "Registration failed."
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const mail = email(req.body.email);
    const password = String(req.body.password || "");

    const users = await readJSON(USERS, {});
    const u = Object.values(users)
      .find(x => x.email === mail);

    if (
      !u ||
      u.disabled ||
      !verifyPassword(
        password,
        u.salt,
        u.hash
      )
    ) {
      await security("LOGIN_FAILED", {
        email: mail
      });

      return res.status(401).json({
        ok: false,
        message: "Invalid email or password."
      });
    }

    u.lastLoginAt = new Date().toISOString();
    users[u.id] = u;

    await writeJSON(USERS, users);

    const t = await createSession(
      u.id,
      u.role
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
      message: "Login failed."
    });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  const t = bearer(req);

  if (t) {
    const sessions = await readJSON(
      SESSIONS,
      {}
    );

    delete sessions[t];

    await writeJSON(
      SESSIONS,
      sessions
    );
  }

  res.json({ ok: true });
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

/* ========================= PASSWORD RECOVERY ========================= */

function resetHash(code) {
  return createHash("sha256")
    .update(String(code))
    .digest("hex");
}

async function sendRecoveryEmail(to, code) {
  if (!RESEND_API_KEY || !RESEND_FROM) {
    return false;
  }

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        subject: "MAMAKI AI password recovery",
        html: `
          <h2>✨ MAMAKI AI</h2>
          <p>Your password recovery code is:</p>
          <h1>${code}</h1>
          <p>This code expires in 15 minutes.</p>
          <p>If you did not request this, ignore this email.</p>
        `
      })
    }
  );

  return response.ok;
}

app.post("/api/auth/forgot-password", async (req, res) => {
  const mail = email(req.body.email);
  const users = await readJSON(USERS, {});

  const u = Object.values(users)
    .find(x => x.email === mail);

  /*
   Always return a neutral response so attackers
   cannot easily discover which emails have accounts.
  */

  if (!u) {
    return res.json({
      ok: true,
      message:
        "If the account exists, recovery instructions will be sent."
    });
  }

  const code =
    String(
      Math.floor(
        100000 +
        Math.random() * 900000
      )
    );

  const resets = await readJSON(
    RESETS,
    {}
  );

  resets[u.id] = {
    userId: u.id,
    email: u.email,
    codeHash: resetHash(code),
    attempts: 0,
    createdAt: Date.now(),
    expiresAt:
      Date.now() +
      15 * 60 * 1000
  };

  await writeJSON(
    RESETS,
    resets
  );

  const sent = await sendRecoveryEmail(
    u.email,
    code
  );

  await security(
    "PASSWORD_RECOVERY_REQUEST",
    {
      userId: u.id,
      email: u.email,
      emailSent: sent
    }
  );

  res.json({
    ok: true,
    emailSent: sent,
    message:
      sent
        ? "Recovery code sent to your email."
        : "Recovery email is not configured yet."
  });
});

app.post("/api/auth/reset-password", async (req, res) => {
  const mail = email(req.body.email);
  const code = text(req.body.code, 20);
  const newPassword =
    String(req.body.password || "");

  if (newPassword.length < 6) {
    return res.status(400).json({
      ok: false,
      message:
        "New password must be at least 6 characters."
    });
  }

  const users = await readJSON(USERS, {});
  const u = Object.values(users)
    .find(x => x.email === mail);

  const resets = await readJSON(
    RESETS,
    {}
  );

  const r = u ? resets[u.id] : null;

  if (
    !u ||
    !r ||
    Date.now() > r.expiresAt ||
    r.attempts >= 5
  ) {
    return res.status(400).json({
      ok: false,
      message:
        "Invalid or expired recovery code."
    });
  }

  r.attempts++;

  if (
    resetHash(code) !== r.codeHash
  ) {
    resets[u.id] = r;
    await writeJSON(RESETS, resets);

    await security(
      "PASSWORD_RECOVERY_FAILED",
      {
        userId: u.id,
        email: u.email
      }
    );

    return res.status(400).json({
      ok: false,
      message: "Invalid recovery code."
    });
  }

  const hp = hashPassword(
    newPassword
  );

  u.salt = hp.salt;
  u.hash = hp.hash;
  u.passwordChangedAt =
    new Date().toISOString();

  users[u.id] = u;

  await writeJSON(
    USERS,
    users
  );

  delete resets[u.id];

  await writeJSON(
    RESETS,
    resets
  );

  /* Revoke existing sessions after password reset. */

  const sessions = await readJSON(
    SESSIONS,
    {}
  );

  for (const [t, s] of Object.entries(sessions)) {
    if (s.userId === u.id) {
      delete sessions[t];
    }
  }

  await writeJSON(
    SESSIONS,
    sessions
  );

  await security(
    "PASSWORD_CHANGED",
    {
      userId: u.id,
      email: u.email
    }
  );

  res.json({
    ok: true,
    message:
      "Password changed successfully. Please log in again."
  });
});

/* ========================= AI GENERATION ========================= */

async function downloadOutput(output, filename) {
  let url = "";

  if (typeof output === "string") {
    url = output;
  } else if (output?.url) {
    url = String(output.url());
  }

  if (!url) {
    throw new Error(
      "Replicate returned no video URL."
    );
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Download failed with HTTP ${response.status}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  const file = path.join(
    OUTPUTS,
    filename
  );

  await fs.writeFile(
    file,
    buffer
  );

  return file;
}

function runFFmpeg(args) {
  return new Promise(
    (resolve, reject) => {
      const p = spawn(
        ffmpegPath,
        args
      );

      let stderr = "";

      p.stderr.on(
        "data",
        d => {
          stderr += d.toString();
        }
      );

      p.on("close", code => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              stderr.slice(-4000) ||
              `FFmpeg exited with code ${code}`
            )
          );
        }
      });
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

  await fs.rename(
    output,
    input
  );
}

async function watermark(input) {
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
    "drawtext=text='MAMAKI ✨':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.45:boxborderw=8:x=20:y=h-th-20",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-c:a",
    "copy",
    output
  ]);

  await fs.rename(
    output,
    input
  );
}

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
      seconds <= 5 ? 81 : 121,
    width: ratioValue === "9:16"
      ? 480
      : ratioValue === "1:1"
        ? 480
        : 640,
    height: ratioValue === "9:16"
      ? 640
      : ratioValue === "1:1"
        ? 480
        : 480,
    fps: 16
  };

  if (image) {
    input.image = image;
  }

  const output =
    await replicate.run(
      model,
      { input }
    );

  const filename =
    `${randomUUID()}.mp4`;

  const file =
    await downloadOutput(
      output,
      filename
    );

  await exactDuration(
    file,
    seconds
  );

  try {
    await watermark(file);
  } catch {
    /* Video remains usable if watermark fails. */
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

/* ========================= GENERATION API ========================= */

app.post(
  "/api/generate",
  requireUser,
  upload.single("image"),
  async (req, res) => {
    try {
      const prompt =
        text(req.body.prompt, 10000);

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          message:
            "Please enter a video prompt."
        });
      }

      const seconds =
        duration(req.body.duration);

      const r =
        ratio(req.body.ratio);

      let image = null;

      if (req.file) {
        const ext =
          path.extname(
            req.file.originalname
          ) || ".jpg";

        const imageFile =
          path.join(
            TMP,
            `${randomUUID()}${ext}`
          );

        await fs.writeFile(
          imageFile,
          req.file.buffer
        );

        image =
          `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      }

      const id = randomUUID();

      jobs.set(id, {
        id,
        userId: req.user.id,
        status: "processing",
        progress: 5,
        createdAt: new Date().toISOString()
      });

      res.json({
        ok: true,
        jobId: id,
        status: "processing"
      });

      try {
        jobs.get(id).progress = 20;

        const result =
          await generateVideo({
            prompt,
            image,
            seconds,
            ratioValue: r,
            userId: req.user.id
          });

        jobs.get(id).progress = 100;
        jobs.get(id).status =
          "completed";

        jobs.get(id).url =
          result.url;

        jobs.get(id).completedAt =
          new Date().toISOString();
      } catch (e) {
        jobs.get(id).status =
          "failed";

        jobs.get(id).error =
          String(
            e?.message || e
          );

        await errorLog(e, {
          jobId: id,
          userId: req.user.id
        });
      }
    } catch (e) {
      await errorLog(e);

      res.status(500).json({
        ok: false,
        message:
          "Video generation failed."
      });
    }
  }
);

app.get(
  "/api/jobs/:id",
  requireUser,
  async (req, res) => {
    const job =
      jobs.get(req.params.id);

    if (
      !job ||
      job.userId !== req.user.id
    ) {
      return res.status(404).json({
        ok: false,
        message: "Job not found."
      });
    }

    res.json({
      ok: true,
      job
    });
  }
);

/* ========================= PROJECTS ========================= */

app.get(
  "/api/projects",
  requireUser,
  async (req, res) => {
    const files =
      await fs.readdir(
        PROJECTS
      );

    const projects = [];

    for (const f of files) {
      if (!f.endsWith(".json")) continue;

      const p =
        await readJSON(
          path.join(PROJECTS, f),
          null
        );

      if (
        p &&
        p.userId === req.user.id
      ) {
        projects.push(p);
      }
    }

    res.json({
      ok: true,
      projects
    });
  }
);

app.post(
  "/api/projects",
  requireUser,
  async (req, res) => {
    const p = {
      id: randomUUID(),
      userId: req.user.id,
      name:
        text(req.body.name, 200) ||
        "Untitled Project",
      prompt:
        text(req.body.prompt, 10000),
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
  }
);

/* ========================= FREE STUDIO ========================= */

app.post(
  "/api/studio/trim",
  requireUser,
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          message: "Video required."
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
          Number(req.body.start || 0)
        );

      const end =
        Math.max(
          start + 0.1,
          Number(req.body.end || 5)
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
        "-c:a",
        "aac",
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
          "Video trimming failed."
      });
    }
  }
);

app.post(
  "/api/studio/combine",
  requireUser,
  upload.array("videos", 20),
  async (req, res) => {
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

      const list =
        path.join(
          TMP,
          `${randomUUID()}.txt`
        );

      const inputs = [];

      for (const file of req.files) {
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
              `file '${p.replace(/'/g, "'\\''")}'`
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
    }
  }
);

/* ========================= NARRATION ========================= */

app.post(
  "/api/narration",
  requireUser,
  async (req, res) => {
    try {
      const script =
        text(req.body.text, 15000);

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

/* ========================= ACCOUNT ========================= */

app.get(
  "/api/account",
  requireUser,
  async (req, res) => {
    const u =
      await readJSON(
        USAGE,
        {}
      );

    res.json({
      ok: true,
      user: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role
      },
      usage:
        u[req.user.id] || {
          aiGenerations: 0,
          aiSeconds: 0,
          studioJobs: 0,
          narrationJobs: 0
        }
    });
  }
);

/* ========================= ADMIN ========================= */

app.post(
  "/api/admin/login",
  async (req, res) => {
    const mail =
      email(req.body.email);

    const password =
      String(req.body.password || "");

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
      mail !== ADMIN_EMAIL ||
      password !== ADMIN_PASSWORD
    ) {
      await security(
        "ADMIN_LOGIN_FAILED",
        { email: mail }
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

    let admin =
      Object.values(users)
        .find(
          u =>
            u.email ===
            ADMIN_EMAIL
        );

    if (!admin) {
      const hp =
        hashPassword(
          ADMIN_PASSWORD
        );

      admin = {
        id: randomUUID(),
        name: "MAMAKI Administrator",
        email: ADMIN_EMAIL,
        ...hp,
        role: "admin",
        disabled: false,
        createdAt:
          new Date().toISOString()
      };

      users[admin.id] =
        admin;

      await writeJSON(
        USERS,
        users
      );
    }

    const t =
      await createSession(
        admin.id,
        "admin"
      );

    await security(
      "ADMIN_LOGIN_SUCCESS",
      {
        userId: admin.id,
        email: admin.email
      }
    );

    res.json({
      ok: true,
      token: t,
      user: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: "admin"
      }
    });
  }
);

app.get(
  "/api/admin/stats",
  requireAdmin,
  async (req, res) => {
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

    for (const u of Object.values(
      usageDb
    )) {
      generations +=
        Number(
          u.aiGenerations || 0
        );

      seconds +=
        Number(
          u.aiSeconds || 0
        );

      studio +=
        Number(
          u.studioJobs || 0
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
            f.endsWith(".json")
        ).length;
    } catch {}

    res.json({
      ok: true,
      stats: {
        totalUsers:
          Object.keys(users).length,
        totalProjects:
          projects,
        aiGenerations:
          generations,
        aiSeconds:
          seconds,
        studioJobs:
          studio,
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
        ).map(u => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          disabled:
            Boolean(u.disabled),
          createdAt:
            u.createdAt,
          usage:
            usageDb[u.id] || {}
        }))
    });
  }
);

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
        Object.values(db)
          .reverse()
          .slice(0, 200)
    });
  }
);

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
        Object.values(db)
          .reverse()
          .slice(0, 200)
    });
  }
);

/* ========================= OUTPUT FILES ========================= */

app.use(
  "/outputs",
  express.static(OUTPUTS)
);

/* ========================= HEALTH ========================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      app: "MAMAKI AI",
      version: VERSION,
      replicate:
        Boolean(
          REPLICATE_API_TOKEN
        ),
      recovery:
        Boolean(
          RESEND_API_KEY &&
          RESEND_FROM
        ),
      uptime:
        process.uptime()
    });
  }
);

/* ========================= ROOT ========================= */

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

/* ========================= 404 ========================= */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error: "NOT_FOUND"
    });
  }
);

/* ========================= ERROR ========================= */

app.use(
  async (err, req, res, next) => {
    await errorLog(
      err,
      {
        route:
          req.originalUrl,
        method:
          req.method
      }
    );

    if (res.headersSent) {
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

/* ========================= CLEANUP ========================= */

setInterval(() => {
  const now = Date.now();

  for (
    const [id, job]
    of jobs.entries()
  ) {
    if (
      ["completed", "failed"]
        .includes(job.status)
    ) {
      const time =
        Date.parse(
          job.completedAt ||
          job.createdAt ||
          ""
        );

      if (
        Number.isFinite(time) &&
        now - time >
          60 * 60 * 1000
      ) {
        jobs.delete(id);
      }
    }
  }
}, 10 * 60 * 1000);

/* ========================= START ========================= */

await ensureStorage();

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `✨ MAMAKI AI v${VERSION} running on ${HOST}:${PORT}`
    );

    console.log(
      `Replicate configured: ${Boolean(REPLICATE_API_TOKEN)}`
    );

    console.log(
      `Admin configured: ${Boolean(ADMIN_EMAIL && ADMIN_PASSWORD)}`
    );

    console.log(
      `Password recovery configured: ${Boolean(RESEND_API_KEY && RESEND_FROM)}`
    );
  }
);
