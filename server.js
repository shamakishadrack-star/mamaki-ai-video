// ================================================================
// MAMAKI AI VIDEO STUDIO
// SERVER v13.0.0 — 90% PRODUCT BACKEND
// ================================================================

import express from "express";
import multer from "multer";
import Replicate from "replicate";
import { EdgeTTS } from "edge-tts-universal";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const ROOT = process.cwd();

const TMP = path.join(ROOT, "tmp");
const OUTPUT = path.join(ROOT, "outputs");
const PROJECTS = path.join(ROOT, "projects");
const DATA = path.join(ROOT, "data");

const USERS_FILE = path.join(DATA, "users.json");
const SESSIONS_FILE = path.join(DATA, "sessions.json");
const USAGE_FILE = path.join(DATA, "usage.json");
const ERRORS_FILE = path.join(DATA, "errors.json");

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);

const T2V_MODEL =
  process.env.T2V_MODEL || "wan-video/wan-2.2-t2v-fast";

const I2V_MODEL =
  process.env.I2V_MODEL || "wan-video/wan-2.2-i2v-fast";

const REPLICATE_API_TOKEN =
  process.env.REPLICATE_API_TOKEN || "";

const ADMIN_EMAIL =
  String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();

const ADMIN_PASSWORD =
  String(process.env.ADMIN_PASSWORD || "");

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.randomBytes(48).toString("hex");

const appStartTime = Date.now();

const jobs = new Map();

const upload = multer({
  dest: TMP,
  limits: {
    fileSize: MAX_UPLOAD_BYTES
  }
});

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Powered-By", "MAMAKI-AI");
  res.setHeader("X-MAMAKI-Version", "13.0.0");
  next();
});

// ================================================================
// INITIALIZATION
// ================================================================

async function ensureDirectories() {
  await fs.mkdir(TMP, { recursive: true });
  await fs.mkdir(OUTPUT, { recursive: true });
  await fs.mkdir(PROJECTS, { recursive: true });
  await fs.mkdir(DATA, { recursive: true });

  await ensureJsonFile(USERS_FILE, []);
  await ensureJsonFile(SESSIONS_FILE, []);
  await ensureJsonFile(USAGE_FILE, []);
  await ensureJsonFile(ERRORS_FILE, []);
}

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

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  await fs.rename(temp, file);
}

await ensureDirectories();

// ================================================================
// GENERAL HELPERS
// ================================================================

function nowIso() {
  return new Date().toISOString();
}

function safeName(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeDuration(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 5;

  return clamp(Math.round(n), 5, 7200);
}

function normalizeRatio(value) {
  const allowed = ["16:9", "9:16", "1:1"];

  return allowed.includes(value)
    ? value
    : "16:9";
}

function normalizeStyle(value) {
  const allowed = [
    "cinematic",
    "realistic",
    "documentary",
    "commercial",
    "3d",
    "anime",
    "fantasy",
    "sci-fi",
    "horror",
    "cartoon"
  ];

  const v = String(value || "")
    .toLowerCase()
    .trim();

  return allowed.includes(v) ? v : "cinematic";
}

function wanFrames(seconds) {
  return Number(seconds) <= 5 ? 81 : 121;
}

function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString("hex");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(
    String(password),
    salt,
    64
  ).toString("hex");

  return {
    salt,
    hash
  };
}

function verifyPassword(password, storedHash, salt) {
  try {
    const calculated = crypto.scryptSync(
      String(password),
      salt,
      64
    ).toString("hex");

    return crypto.timingSafeEqual(
      Buffer.from(calculated, "hex"),
      Buffer.from(storedHash, "hex")
    );
  } catch {
    return false;
  }
}

function signSession(sessionId) {
  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(sessionId)
    .digest("hex");

  return `${sessionId}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || !token.includes(".")) {
    return null;
  }

  const [sessionId, signature] = token.split(".");

  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(sessionId)
    .digest("hex");

  if (signature.length !== expected.length) {
    return null;
  }

  try {
    if (
      !crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return sessionId;
}

function extractToken(req) {
  const auth = req.headers.authorization || "";

  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }

  if (req.headers["x-session-token"]) {
    return String(req.headers["x-session-token"]);
  }

  if (req.body && req.body.token) {
    return String(req.body.token);
  }

  return null;
}

function publicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role || "user",
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt
  };
}

function errorResponse(res, status, code, message, extra = {}) {
  return res.status(status).json({
    ok: false,
    code,
    message,
    ...extra
  });
}

async function logError(error, context = {}) {
  try {
    const errors = await readJson(ERRORS_FILE, []);

    errors.push({
      id: randomUUID(),
      time: nowIso(),
      message:
        error?.message ||
        String(error),
      context
    });

    while (errors.length > 500) {
      errors.shift();
    }

    await writeJson(ERRORS_FILE, errors);
  } catch {
    // Logging must never crash the server.
  }
}

function isReplicateCreditError(error) {
  const text = String(
    error?.message ||
    error?.detail ||
    error ||
    ""
  ).toLowerCase();

  return (
    text.includes("insufficient credit") ||
    text.includes("insufficient credits") ||
    text.includes("billing") ||
    text.includes("payment required") ||
    text.includes("credit balance") ||
    text.includes("spend limit")
  );
}

function isReplicateAuthError(error) {
  const text = String(
    error?.message ||
    error?.detail ||
    error ||
    ""
  ).toLowerCase();

  return (
    text.includes("unauthorized") ||
    text.includes("authentication") ||
    text.includes("invalid token") ||
    text.includes("api token") ||
    text.includes("401")
  );
}

// ================================================================
// AUTHENTICATION
// ================================================================

async function createSession(userId) {
  const sessions = await readJson(SESSIONS_FILE, []);

  const sessionId = randomToken(32);

  const session = {
    id: sessionId,
    userId,
    createdAt: nowIso(),
    expiresAt:
      new Date(
        Date.now() +
        SESSION_DAYS * 24 * 60 * 60 * 1000
      ).toISOString()
  };

  sessions.push(session);

  await writeJson(SESSIONS_FILE, sessions);

  return signSession(sessionId);
}

async function getUserFromRequest(req) {
  const token = extractToken(req);

  if (!token) return null;

  const sessionId = verifySessionToken(token);

  if (!sessionId) return null;

  const sessions = await readJson(SESSIONS_FILE, []);

  const session = sessions.find(
    s => s.id === sessionId
  );

  if (!session) return null;

  if (
    new Date(session.expiresAt).getTime() <
    Date.now()
  ) {
    return null;
  }

  const users = await readJson(USERS_FILE, []);

  const user = users.find(
    u => u.id === session.userId
  );

  if (!user || user.disabled) {
    return null;
  }

  return user;
}

async function requireAuth(req, res, next) {
  const user = await getUserFromRequest(req);

  if (!user) {
    return errorResponse(
      res,
      401,
      "AUTHENTICATION_REQUIRED",
      "Please log in to continue."
    );
  }

  req.user = user;

  next();
}

async function requireAdmin(req, res, next) {
  const user = await getUserFromRequest(req);

  if (!user || user.role !== "admin") {
    return errorResponse(
      res,
      403,
      "ADMIN_ACCESS_REQUIRED",
      "Administrator access required."
    );
  }

  req.user = user;

  next();
}

// ================================================================
// USER AUTH ROUTES
// ================================================================

app.post("/api/auth/signup", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "");

    if (name.length < 2) {
      return errorResponse(
        res,
        400,
        "INVALID_NAME",
        "Name must contain at least 2 characters."
      );
    }

    if (
      !email.includes("@") ||
      email.length < 5
    ) {
      return errorResponse(
        res,
        400,
        "INVALID_EMAIL",
        "Enter a valid email address."
      );
    }

    if (password.length < 8) {
      return errorResponse(
        res,
        400,
        "WEAK_PASSWORD",
        "Password must contain at least 8 characters."
      );
    }

    const users = await readJson(
      USERS_FILE,
      []
    );

    const exists = users.some(
      u => u.email === email
    );

    if (exists) {
      return errorResponse(
        res,
        409,
        "EMAIL_ALREADY_EXISTS",
        "An account with this email already exists."
      );
    }

    const passwordData =
      hashPassword(password);

    const user = {
      id: randomUUID(),
      name,
      email,
      passwordHash: passwordData.hash,
      passwordSalt: passwordData.salt,
      role: "user",
      disabled: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastLoginAt: null
    };

    users.push(user);

    await writeJson(
      USERS_FILE,
      users
    );

    const token =
      await createSession(user.id);

    res.json({
      ok: true,
      message: "Account created successfully.",
      token,
      user: publicUser(user)
    });
  } catch (error) {
    await logError(error, {
      route: "/api/auth/signup"
    });

    errorResponse(
      res,
      500,
      "SIGNUP_FAILED",
      "Unable to create account."
    );
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const password = String(
      req.body.password || ""
    );

    const users = await readJson(
      USERS_FILE,
      []
    );

    const user = users.find(
      u => u.email === email
    );

    if (
      !user ||
      !verifyPassword(
        password,
        user.passwordHash,
        user.passwordSalt
      )
    ) {
      return errorResponse(
        res,
        401,
        "INVALID_CREDENTIALS",
        "Email or password is incorrect."
      );
    }

    if (user.disabled) {
      return errorResponse(
        res,
        403,
        "ACCOUNT_DISABLED",
        "This account has been disabled."
      );
    }

    user.lastLoginAt = nowIso();
    user.updatedAt = nowIso();

    await writeJson(
      USERS_FILE,
      users
    );

    const token =
      await createSession(user.id);

    res.json({
      ok: true,
      message: "Login successful.",
      token,
      user: publicUser(user)
    });
  } catch (error) {
    await logError(error, {
      route: "/api/auth/login"
    });

    errorResponse(
      res,
      500,
      "LOGIN_FAILED",
      "Unable to log in."
    );
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = extractToken(req);

    if (token) {
      const sessionId =
        verifySessionToken(token);

      if (sessionId) {
        const sessions =
          await readJson(
            SESSIONS_FILE,
            []
          );

        const remaining =
          sessions.filter(
            s => s.id !== sessionId
          );

        await writeJson(
          SESSIONS_FILE,
          remaining
        );
      }
    }

    res.json({
      ok: true,
      message: "Logged out."
    });
  } catch {
    res.json({
      ok: true,
      message: "Logged out."
    });
  }
});

app.get("/api/auth/me", async (req, res) => {
  const user =
    await getUserFromRequest(req);

  res.json({
    ok: true,
    authenticated: Boolean(user),
    user: publicUser(user)
  });
});

// ================================================================
// ACCOUNT
// ================================================================

app.get(
  "/api/account",
  requireAuth,
  async (req, res) => {
    const usage =
      await getUserUsage(req.user.id);

    const projects =
      await getUserProjects(
        req.user.id
      );

    res.json({
      ok: true,
      user: publicUser(req.user),
      usage,
      projectsCount: projects.length,
      features: {
        aiVideo: true,
        imageToVideo: true,
        freeStudio: true,
        narration: true,
        subtitles: true,
        promptEnhancement: true,
        socialPresets: true
      }
    });
  }
);

app.put(
  "/api/account/profile",
  requireAuth,
  async (req, res) => {
    try {
      const users =
        await readJson(
          USERS_FILE,
          []
        );

      const user =
        users.find(
          u => u.id === req.user.id
        );

      if (!user) {
        return errorResponse(
          res,
          404,
          "USER_NOT_FOUND",
          "Account not found."
        );
      }

      if (req.body.name !== undefined) {
        const name =
          String(req.body.name).trim();

        if (name.length < 2) {
          return errorResponse(
            res,
            400,
            "INVALID_NAME",
            "Name is too short."
          );
        }

        user.name = name;
      }

      user.updatedAt = nowIso();

      await writeJson(
        USERS_FILE,
        users
      );

      res.json({
        ok: true,
        user: publicUser(user)
      });
    } catch (error) {
      await logError(error, {
        route: "/api/account/profile"
      });

      errorResponse(
        res,
        500,
        "PROFILE_UPDATE_FAILED",
        "Unable to update profile."
      );
    }
  }
);

app.post(
  "/api/account/change-password",
  requireAuth,
  async (req, res) => {
    try {
      const currentPassword =
        String(
          req.body.currentPassword || ""
        );

      const newPassword =
        String(
          req.body.newPassword || ""
        );

      if (newPassword.length < 8) {
        return errorResponse(
          res,
          400,
          "WEAK_PASSWORD",
          "New password must contain at least 8 characters."
        );
      }

      const users =
        await readJson(
          USERS_FILE,
          []
        );

      const user =
        users.find(
          u => u.id === req.user.id
        );

      if (
        !user ||
        !verifyPassword(
          currentPassword,
          user.passwordHash,
          user.passwordSalt
        )
      ) {
        return errorResponse(
          res,
          401,
          "CURRENT_PASSWORD_INVALID",
          "Current password is incorrect."
        );
      }

      const passwordData =
        hashPassword(newPassword);

      user.passwordHash =
        passwordData.hash;

      user.passwordSalt =
        passwordData.salt;

      user.updatedAt = nowIso();

      await writeJson(
        USERS_FILE,
        users
      );

      res.json({
        ok: true,
        message: "Password changed successfully."
      });
    } catch (error) {
      await logError(error, {
        route:
          "/api/account/change-password"
      });

      errorResponse(
        res,
        500,
        "PASSWORD_CHANGE_FAILED",
        "Unable to change password."
      );
    }
  }
);

// ================================================================
// USAGE
// ================================================================

async function getUserUsage(userId) {
  const usage =
    await readJson(
      USAGE_FILE,
      []
    );

  const records =
    usage.filter(
      r => r.userId === userId
    );

  const aiSeconds =
    records
      .filter(r => r.type === "ai")
      .reduce(
        (sum, r) =>
          sum + Number(r.seconds || 0),
        0
      );

  const aiJobs =
    records.filter(
      r => r.type === "ai"
    ).length;

  const studioJobs =
    records.filter(
      r => r.type === "studio"
    ).length;

  return {
    aiJobs,
    aiSeconds,
    aiMinutes:
      Math.round(
        (aiSeconds / 60) * 100
      ) / 100,
    studioJobs,
    totalJobs:
      records.length
  };
}

async function recordUsage({
  userId,
  type,
  seconds = 0,
  action = ""
}) {
  const usage =
    await readJson(
      USAGE_FILE,
      []
    );

  usage.push({
    id: randomUUID(),
    userId,
    type,
    seconds: Number(seconds || 0),
    action,
    createdAt: nowIso()
  });

  while (usage.length > 10000) {
    usage.shift();
  }

  await writeJson(
    USAGE_FILE,
    usage
  );
}

app.get(
  "/api/account/usage",
  requireAuth,
  async (req, res) => {
    res.json({
      ok: true,
      usage:
        await getUserUsage(
          req.user.id
        )
    });
  }
);

// ================================================================
// PROJECTS
// ================================================================

function projectFile(userId, projectId) {
  return path.join(
    PROJECTS,
    `${safeName(userId)}_${safeName(projectId)}.json`
  );
}

async function getUserProjects(userId) {
  const files =
    await fs.readdir(PROJECTS)
      .catch(() => []);

  const result = [];

  for (const file of files) {
    if (
      !file.startsWith(
        `${safeName(userId)}_`
      ) ||
      !file.endsWith(".json")
    ) {
      continue;
    }

    try {
      const data =
        await readJson(
          path.join(PROJECTS, file),
          null
        );

      if (data) result.push(data);
    } catch {
      // Ignore broken project files.
    }
  }

  return result.sort(
    (a, b) =>
      new Date(
        b.updatedAt ||
        b.createdAt ||
        0
      ) -
      new Date(
        a.updatedAt ||
        a.createdAt ||
        0
      )
  );
}

app.get(
  "/api/projects",
  requireAuth,
  async (req, res) => {
    const projects =
      await getUserProjects(
        req.user.id
      );

    res.json({
      ok: true,
      projects
    });
  }
);

app.get(
  "/api/projects/:id",
  requireAuth,
  async (req, res) => {
    const file =
      projectFile(
        req.user.id,
        req.params.id
      );

    try {
      const project =
        await readJson(
          file,
          null
        );

      if (!project) {
        return errorResponse(
          res,
          404,
          "PROJECT_NOT_FOUND",
          "Project not found."
        );
      }

      res.json({
        ok: true,
        project
      });
    } catch {
      errorResponse(
        res,
        404,
        "PROJECT_NOT_FOUND",
        "Project not found."
      );
    }
  }
);

app.post(
  "/api/projects/save",
  requireAuth,
  async (req, res) => {
    try {
      const incoming =
        req.body || {};

      const id =
        String(
          incoming.id ||
          randomUUID()
        );

      const project = {
        id,
        userId: req.user.id,
        name:
          String(
            incoming.name ||
            incoming.title ||
            "Untitled Project"
          ).slice(0, 150),
        type:
          incoming.type ||
          "video",
        prompt:
          incoming.prompt ||
          "",
        videoUrl:
          incoming.videoUrl ||
          incoming.url ||
          null,
        thumbnail:
          incoming.thumbnail ||
          null,
        duration:
          Number(
            incoming.duration || 0
          ),
        ratio:
          normalizeRatio(
            incoming.ratio
          ),
        style:
          normalizeStyle(
            incoming.style
          ),
        metadata:
          incoming.metadata ||
          {},
        createdAt:
          incoming.createdAt ||
          nowIso(),
        updatedAt:
          nowIso()
      };

      await writeJson(
        projectFile(
          req.user.id,
          id
        ),
        project
      );

      res.json({
        ok: true,
        project
      });
    } catch (error) {
      await logError(error, {
        route: "/api/projects/save",
        userId: req.user.id
      });

      errorResponse(
        res,
        500,
        "PROJECT_SAVE_FAILED",
        "Unable to save project."
      );
    }
  }
);

app.delete(
  "/api/projects/:id",
  requireAuth,
  async (req, res) => {
    try {
      await fs.unlink(
        projectFile(
          req.user.id,
          req.params.id
        )
      );

      res.json({
        ok: true,
        message: "Project deleted."
      });
    } catch {
      errorResponse(
        res,
        404,
        "PROJECT_NOT_FOUND",
        "Project not found."
      );
    }
  }
);

// ================================================================
// PROMPT ENHANCEMENT
// ================================================================

function enhancePrompt(prompt, style, ratio) {
  const clean =
    String(prompt || "")
      .trim();

  if (!clean) {
    return "";
  }

  const styleText = {
    cinematic:
      "cinematic composition, dramatic lighting, film-quality visual language, realistic depth and atmosphere",
    realistic:
      "photorealistic details, natural lighting, realistic textures, authentic movement",
    documentary:
      "documentary cinematography, natural camera movement, authentic environment, observational realism",
    commercial:
      "premium commercial production, polished composition, controlled lighting, attractive product-quality visuals",
    "3d":
      "high-quality 3D animation, detailed materials, professional rendering, smooth motion",
    anime:
      "high-quality anime visual style, expressive composition, detailed backgrounds, fluid animation",
    fantasy:
      "epic fantasy atmosphere, detailed environment, magical lighting, cinematic scale",
    "sci-fi":
      "futuristic science-fiction environment, advanced technology, atmospheric lighting, cinematic scale",
    horror:
      "dark atmospheric horror cinematography, suspenseful composition, unsettling environment, controlled shadows",
    cartoon:
      "stylized cartoon animation, expressive characters, clean shapes, colorful visual storytelling"
  }[style] || "cinematic visual quality";

  const formatText =
    ratio === "9:16"
      ? "vertical social-video composition"
      : ratio === "1:1"
      ? "square social-media composition"
      : "widescreen cinematic composition";

  return [
    clean,
    "",
    `Visual direction: ${styleText}.`,
    `Format: ${formatText}.`,
    "High production value, coherent subject appearance, consistent environment, natural motion, strong composition, detailed foreground and background.",
    "Camera movement should be smooth and intentional.",
    "Maintain visual continuity throughout the shot.",
    "Avoid distorted anatomy, duplicate objects, unwanted text, logos, watermarks, flickering and unstable details."
  ].join(" ");
}

app.post(
  "/api/ai/enhance-prompt",
  async (req, res) => {
    try {
      const prompt =
        String(
          req.body.prompt || ""
        );

      const style =
        normalizeStyle(
          req.body.style
        );

      const ratio =
        normalizeRatio(
          req.body.ratio
        );

      if (!prompt.trim()) {
        return errorResponse(
          res,
          400,
          "PROMPT_REQUIRED",
          "Enter a prompt first."
        );
      }

      res.json({
        ok: true,
        original: prompt,
        enhanced:
          enhancePrompt(
            prompt,
            style,
            ratio
          )
      });
    } catch (error) {
      await logError(error, {
        route:
          "/api/ai/enhance-prompt"
      });

      errorResponse(
        res,
        500,
        "PROMPT_ENHANCEMENT_FAILED",
        "Unable to enhance prompt."
      );
    }
  }
);

// ================================================================
// REPLICATE HELPERS
// ================================================================

let replicate = null;

if (REPLICATE_API_TOKEN) {
  replicate = new Replicate({
    auth: REPLICATE_API_TOKEN
  });
}

async function outputToBuffer(output) {
  if (!output) {
    throw new Error(
      "Replicate returned an empty output."
    );
  }

  if (Buffer.isBuffer(output)) {
    return output;
  }

  if (
    output instanceof Uint8Array
  ) {
    return Buffer.from(output);
  }

  if (
    typeof output === "string"
  ) {
    const response =
      await fetch(output);

    if (!response.ok) {
      throw new Error(
        `Unable to download Replicate output (${response.status}).`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  if (
    Array.isArray(output) &&
    output.length
  ) {
    return outputToBuffer(
      output[0]
    );
  }

  if (
    typeof output.url ===
    "function"
  ) {
    return outputToBuffer(
      await output.url()
    );
  }

  if (output.url) {
    return outputToBuffer(
      output.url
    );
  }

  if (
    output.output
  ) {
    return outputToBuffer(
      output.output
    );
  }

  throw new Error(
    "Replicate returned an unsupported output format."
  );
}

async function wanTextToVideo({
  prompt,
  duration,
  ratio
}) {
  if (!replicate) {
    const error =
      new Error(
        "REPLICATE_API_TOKEN is not configured."
      );

    error.code =
      "REPLICATE_AUTH_REQUIRED";

    throw error;
  }

  const seconds =
    Math.min(
      5,
      Number(duration || 5)
    );

  const frames =
    wanFrames(seconds);

  const output =
    await replicate.run(
      T2V_MODEL,
      {
        input: {
          prompt,
          num_frames: frames,
          aspect_ratio:
            normalizeRatio(ratio)
        }
      }
    );

  return outputToBuffer(
    output
  );
}

async function wanImageToVideo({
  prompt,
  imagePath,
  duration,
  ratio
}) {
  if (!replicate) {
    const error =
      new Error(
        "REPLICATE_API_TOKEN is not configured."
      );

    error.code =
      "REPLICATE_AUTH_REQUIRED";

    throw error;
  }

  const imageBuffer =
    await fs.readFile(
      imagePath
    );

  const seconds =
    Math.min(
      5,
      Number(duration || 5)
    );

  const frames =
    wanFrames(seconds);

  const output =
    await replicate.run(
      I2V_MODEL,
      {
        input: {
          prompt,
          image: imageBuffer,
          num_frames: frames,
          aspect_ratio:
            normalizeRatio(ratio)
        }
      }
    );

  return outputToBuffer(
    output
  );
}

// ================================================================
// FFMPEG
// ================================================================

function runFFmpeg(args) {
  return new Promise(
    (resolve, reject) => {
      const child =
        spawn(
          ffmpegPath,
          [
            "-y",
            ...args
          ]
        );

      let stderr = "";

      child.stderr.on(
        "data",
        data => {
          stderr += data.toString();
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
                `FFmpeg failed (${code}): ${stderr.slice(-4000)}`
              )
            );
          }
        }
      );
    }
  );
}

async function writeBuffer(
  buffer,
  extension = ".mp4"
) {
  const filename =
    `${randomUUID()}${extension}`;

  const file =
    path.join(
      TMP,
      filename
    );

  await fs.writeFile(
    file,
    buffer
  );

  return file;
}

async function createSoftMusic(
  duration,
  output
) {
  const seconds =
    Math.max(
      1,
      Number(duration || 5)
    );

  await runFFmpeg([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=220:sample_rate=44100:duration=${seconds}`,
    "-af",
    "volume=0.025",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    output
  ]);
}

async function addSoftMusic(
  video,
  duration
) {
  const music =
    path.join(
      TMP,
      `${randomUUID()}_music.m4a`
    );

  const output =
    path.join(
      TMP,
      `${randomUUID()}_audio.mp4`
    );

  try {
    await createSoftMusic(
      duration,
      music
    );

    await runFFmpeg([
      "-i",
      video,
      "-i",
      music,
      "-filter_complex",
      "[1:a]volume=0.08[a]",
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
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
  } catch {
    return video;
  } finally {
    await fs.unlink(
      music
    ).catch(() => {});
  }
}

async function addWatermark(
  video,
  output
) {
  const filter =
    "drawtext=text='MAMAKI ✨':x=w-tw-30:y=h-th-25:fontsize=26:fontcolor=white@0.78:shadowcolor=black@0.7:shadowx=2:shadowy=2";

  await runFFmpeg([
    "-i",
    video,
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
    "-movflags",
    "+faststart",
    output
  ]);

  return output;
}

async function forceDuration(
  input,
  seconds,
  output
) {
  await runFFmpeg([
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
    "-movflags",
    "+faststart",
    output
  ]);

  return output;
}

async function resizeVideo(
  input,
  ratio,
  output
) {
  const size =
    ratio === "9:16"
      ? "1080:1920"
      : ratio === "1:1"
      ? "1080:1080"
      : "1920:1080";

  await runFFmpeg([
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
    "-movflags",
    "+faststart",
    output
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
      `${randomUUID()}_concat.txt`
    );

  const content =
    files
      .map(
        file =>
          `file '${file.replace(
            /'/g,
            "'\\''"
          )}'`
      )
      .join("\n");

  await fs.writeFile(
    listFile,
    content,
    "utf8"
  );

  try {
    await runFFmpeg([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-c",
      "copy",
      output
    ]);
  } catch {
    await runFFmpeg([
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
      output
    ]);
  } finally {
    await fs.unlink(
      listFile
    ).catch(() => {});
  }

  return output;
}

// ================================================================
// JOB SYSTEM
// ================================================================

function createJob(userId) {
  const id =
    randomUUID();

  const job = {
    id,
    userId,
    status: "queued",
    progress: 0,
    message: "Queued",
    result: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  jobs.set(id, job);

  return job;
}

function updateJob(
  job,
  data
) {
  Object.assign(
    job,
    data,
    {
      updatedAt: nowIso()
    }
  );
}

function cleanupJobs() {
  const cutoff =
    Date.now() -
    60 * 60 * 1000;

  for (
    const [id, job]
    of jobs
  ) {
    const time =
      new Date(
        job.updatedAt ||
        job.createdAt
      ).getTime();

    if (
      ["completed", "failed", "cancelled"]
        .includes(job.status) &&
      time < cutoff
    ) {
      jobs.delete(id);
    }
  }
}

setInterval(
  cleanupJobs,
  10 * 60 * 1000
);

async function runGenerationJob(
  job,
  options
) {
  const workingFiles = [];

  try {
    updateJob(
      job,
      {
        status: "running",
        progress: 2,
        message:
          "Preparing production..."
      }
    );

    const duration =
      normalizeDuration(
        options.duration
      );

    const ratio =
      normalizeRatio(
        options.ratio
      );

    const style =
      normalizeStyle(
        options.style
      );

    const basePrompt =
      enhancePrompt(
        options.prompt,
        style,
        ratio
      );

    if (!basePrompt) {
      throw new Error(
        "Prompt is required."
      );
    }

    const sceneLength = 5;

    const sceneCount =
      Math.ceil(
        duration /
        sceneLength
      );

    const scenes = [];

    for (
      let i = 0;
      i < sceneCount;
      i++
    ) {
      const remaining =
        duration -
        i * sceneLength;

      const currentSeconds =
        Math.min(
          sceneLength,
          remaining
        );

      updateJob(
        job,
        {
          progress:
            Math.round(
              (i /
                sceneCount) *
                70
            ),
          message:
            `Generating scene ${i + 1} of ${sceneCount}...`
        }
      );

      const scenePrompt =
        `${basePrompt} Scene ${i + 1} of ${sceneCount}. Maintain continuity with the same visual subject and world.`;

      let buffer;

      if (
        options.imagePath
      ) {
        buffer =
          await wanImageToVideo({
            prompt:
              scenePrompt,
            imagePath:
              options.imagePath,
            duration:
              currentSeconds,
            ratio
          });
      } else {
        buffer =
          await wanTextToVideo({
            prompt:
              scenePrompt,
            duration:
              currentSeconds,
            ratio
          });
      }

      const sceneFile =
        await writeBuffer(
          buffer,
          ".mp4"
        );

      workingFiles.push(
        sceneFile
      );

      scenes.push(
        sceneFile
      );
    }

    updateJob(
      job,
      {
        progress: 72,
        message:
          "Assembling scenes..."
      }
    );

    const combined =
      path.join(
        TMP,
        `${job.id}_combined.mp4`
      );

    await combineVideoFiles(
      scenes,
      combined
    );

    workingFiles.push(
      combined
    );

    updateJob(
      job,
      {
        progress: 80,
        message:
          "Preparing audio..."
      }
    );

    const audioVideo =
      await addSoftMusic(
        combined,
        duration
      );

    workingFiles.push(
      audioVideo
    );

    const timed =
      path.join(
        TMP,
        `${job.id}_timed.mp4`
      );

    await forceDuration(
      audioVideo,
      duration,
      timed
    );

    workingFiles.push(
      timed
    );

    updateJob(
      job,
      {
        progress: 88,
        message:
          "Applying MAMAKI watermark..."
      }
    );

    const finalFile =
      path.join(
        OUTPUT,
        `${job.id}.mp4`
      );

    await addWatermark(
      timed,
      finalFile
    );

    updateJob(
      job,
      {
        status: "completed",
        progress: 100,
        message:
          "Video completed.",
        result: {
          url:
            `/api/video/${path.basename(
              finalFile
            )}`,
          file:
            path.basename(
              finalFile
            ),
          duration,
          ratio,
          style
        }
      }
    );

    await recordUsage({
      userId: job.userId,
      type: "ai",
      seconds: duration,
      action:
        options.imagePath
          ? "image-to-video"
          : "text-to-video"
    });
  } catch (error) {
    await logError(
      error,
      {
        jobId: job.id,
        userId: job.userId,
        type: "generation"
      }
    );

    let code =
      "GENERATION_FAILED";

    let message =
      "Video generation failed.";

    if (
      error?.code ===
      "REPLICATE_AUTH_REQUIRED"
    ) {
      code =
        "REPLICATE_AUTH_REQUIRED";

      message =
        "AI generation is unavailable because the Replicate API token is not configured.";
    } else if (
      isReplicateCreditError(
        error
      )
    ) {
      code =
        "REPLICATE_CREDIT_REQUIRED";

      message =
        "AI generation requires available Replicate credit. Add billing/credit to the connected Replicate account.";
    } else if (
      isReplicateAuthError(
        error
      )
    ) {
      code =
        "REPLICATE_AUTH_ERROR";

      message =
        "The Replicate authentication is invalid or unavailable.";
    } else if (
      error?.message
    ) {
      message =
        error.message;
    }

    updateJob(
      job,
      {
        status: "failed",
        progress:
          job.progress || 0,
        message,
        error: {
          code,
          message
        }
      }
    );
  } finally {
    if (
      options.imagePath
    ) {
      await fs.unlink(
        options.imagePath
      ).catch(() => {});
    }

    for (
      const file
      of workingFiles
    ) {
      if (
        file &&
        !file.startsWith(
          OUTPUT
        )
      ) {
        await fs.unlink(
          file
        ).catch(() => {});
      }
    }
  }
}

// ================================================================
// GENERATE VIDEO
// ================================================================

app.post(
  "/api/generate",
  requireAuth,
  upload.single("image"),
  async (req, res) => {
    try {
      const prompt =
        String(
          req.body.prompt || ""
        ).trim();

      if (!prompt) {
        return errorResponse(
          res,
          400,
          "PROMPT_REQUIRED",
          "Please enter a video prompt."
        );
      }

      const duration =
        normalizeDuration(
          req.body.duration
        );

      const ratio =
        normalizeRatio(
          req.body.ratio
        );

      const style =
        normalizeStyle(
          req.body.style
        );

      const job =
        createJob(
          req.user.id
        );

      let imagePath =
        null;

      if (
        req.file
      ) {
        imagePath =
          req.file.path;
      }

      runGenerationJob(
        job,
        {
          prompt,
          duration,
          ratio,
          style,
          imagePath
        }
      );

      res.status(202).json({
        ok: true,
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        message:
          "Video generation started."
      });
    } catch (error) {
      await logError(
        error,
        {
          route: "/api/generate",
          userId:
            req.user?.id
        }
      );

      errorResponse(
        res,
        500,
        "GENERATION_START_FAILED",
        "Unable to start video generation."
      );
    }
  }
);

// ================================================================
// JOB STATUS
// ================================================================

app.get(
  "/api/jobs/:id",
  requireAuth,
  async (req, res) => {
    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return errorResponse(
        res,
        404,
        "JOB_NOT_FOUND",
        "Generation job not found or has expired."
      );
    }

    if (
      job.userId !==
      req.user.id &&
      req.user.role !== "admin"
    ) {
      return errorResponse(
        res,
        403,
        "JOB_ACCESS_DENIED",
        "You cannot access this job."
      );
    }

    res.json({
      ok: true,
      job
    });
  }
);

// ================================================================
// VIDEO DELIVERY
// ================================================================

app.get(
  "/api/video/:file",
  async (req, res) => {
    const filename =
      safeName(
        req.params.file
      );

    if (
      filename !==
      req.params.file
    ) {
      return res.status(400).end();
    }

    const file =
      path.join(
        OUTPUT,
        filename
      );

    try {
      await fs.access(
        file
      );

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Cache-Control",
        "public, max-age=3600"
      );

      res.sendFile(
        file
      );
    } catch {
      res.status(404).json({
        ok: false,
        code: "VIDEO_NOT_FOUND",
        message:
          "Video not found."
      });
    }
  }
);

// ================================================================
// VOICE & NARRATION
// ================================================================

app.post(
  "/api/studio/narration",
  requireAuth,
  async (req, res) => {
    try {
      const text =
        String(
          req.body.text || ""
        ).trim();

      const voice =
        String(
          req.body.voice ||
          "en-US-AriaNeural"
        );

      const rate =
        String(
          req.body.rate ||
          "+0%"
        );

      const pitch =
        String(
          req.body.pitch ||
          "+0Hz"
        );

      if (!text) {
        return errorResponse(
          res,
          400,
          "TEXT_REQUIRED",
          "Enter narration text."
        );
      }

      const filename =
        `${randomUUID()}_narration.mp3`;

      const output =
        path.join(
          OUTPUT,
          filename
        );

      const tts =
        new EdgeTTS();

      await tts.synthesize(
        text,
        voice,
        {
          rate,
          pitch
        }
      ).then(
        async result => {
          if (
            Buffer.isBuffer(
              result
            )
          ) {
            await fs.writeFile(
              output,
              result
            );
          } else if (
            result?.audio
          ) {
            await fs.writeFile(
              output,
              result.audio
            );
          } else if (
            result?.toBuffer
          ) {
            await fs.writeFile(
              output,
              await result.toBuffer()
            );
          } else {
            throw new Error(
              "Narration provider returned unsupported audio data."
            );
          }
        }
      );

      await recordUsage({
        userId:
          req.user.id,
        type:
          "studio",
        action:
          "narration"
      });

      res.json({
        ok: true,
        audioUrl:
          `/api/audio/${filename}`,
        file:
          filename
      });
    } catch (error) {
      await logError(
        error,
        {
          route:
            "/api/studio/narration",
          userId:
            req.user.id
        }
      );

      errorResponse(
        res,
        500,
        "NARRATION_FAILED",
        "Unable to create narration. Check the selected voice and try again."
      );
    }
  }
);

app.get(
  "/api/audio/:file",
  async (req, res) => {
    const filename =
      safeName(
        req.params.file
      );

    const file =
      path.join(
        OUTPUT,
        filename
      );

    try {
      await fs.access(
        file
      );

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      res.sendFile(
        file
      );
    } catch {
      res.status(404).end();
    }
  }
);

// ================================================================
// SUBTITLE CREATION
// ================================================================

function escapeSubtitleText(
  text
) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

app.post(
  "/api/studio/subtitles",
  requireAuth,
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return errorResponse(
          res,
          400,
          "VIDEO_REQUIRED",
          "Upload a video first."
        );
      }

      const text =
        String(
          req.body.text || ""
        ).trim();

      if (!text) {
        await fs.unlink(
          req.file.path
        ).catch(() => {});

        return errorResponse(
          res,
          400,
          "SUBTITLE_TEXT_REQUIRED",
          "Enter subtitle text."
        );
      }

      const duration =
        Number(
          req.body.duration || 10
        );

      const output =
        path.join(
          OUTPUT,
          `${randomUUID()}_subtitled.mp4`
        );

      const escaped =
        escapeSubtitleText(
          text
        );

      await runFFmpeg([
        "-i",
        req.file.path,
        "-vf",
        `drawtext=text='${escaped}':x=(w-tw)/2:y=h-th-80:fontsize=34:fontcolor=white:borderw=3:bordercolor=black`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-t",
        String(
          Math.max(
            1,
            duration
          )
        ),
        "-movflags",
        "+faststart",
        output
      ]);

      await fs.unlink(
        req.file.path
      ).catch(() => {});

      await recordUsage({
        userId:
          req.user.id,
        type:
          "studio",
        action:
          "subtitles"
      });

      res.json({
        ok: true,
        videoUrl:
          `/api/video/${path.basename(
            output
          )}`
      });
    } catch (error) {
      await fs.unlink(
        req.file?.path
      ).catch(() => {});

      await logError(
        error,
        {
          route:
            "/api/studio/subtitles",
          userId:
            req.user.id
        }
      );

      errorResponse(
        res,
        500,
        "SUBTITLE_FAILED",
        "Unable to add subtitles."
      );
    }
  }
);

// ================================================================
// PHOTO → VIDEO
// ================================================================

app.post(
  "/api/studio/photo-video",
  requireAuth,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return errorResponse(
          res,
          400,
          "IMAGE_REQUIRED",
          "Upload an image."
        );
      }

      const duration =
        normalizeDuration(
          req.body.duration || 5
        );

      const ratio =
        normalizeRatio(
          req.body.ratio
        );

      const output =
        path.join(
          OUTPUT,
          `${randomUUID()}_photo_video.mp4`
        );

      const size =
        ratio === "9:16"
          ? "1080:1920"
          : ratio === "1:1"
          ? "1080:1080"
          : "1920:1080";

      await runFFmpeg([
        "-loop",
        "1",
        "-i",
        req.file.path,
        "-t",
        String(duration),
        "-vf",
        `scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
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
        "-movflags",
        "+faststart",
        output
      ]);

      await fs.unlink(
        req.file.path
      ).catch(() => {});

      await recordUsage({
        userId:
          req.user.id,
        type:
          "studio",
        seconds:
          duration,
        action:
          "photo-to-video"
      });

      res.json({
        ok: true,
        videoUrl:
          `/api/video/${path.basename(
            output
          )}`
      });
    } catch (error) {
      await fs.unlink(
        req.file?.path
      ).catch(() => {});

      await logError(
        error,
        {
          route:
            "/api/studio/photo-video",
          userId:
            req.user.id
        }
      );

      errorResponse(
        res,
        500,
        "PHOTO_VIDEO_FAILED",
        "Unable to create photo video."
      );
    }
  }
);

// ================================================================
// VIDEO TRIMMER
// ================================================================

app.post(
  "/api/studio/trim",
  requireAuth,
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return errorResponse(
          res,
          400,
          "VIDEO_REQUIRED",
          "Upload a video."
        );
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
            req.body.duration || 5
          )
        );

      const output =
        path.join(
          OUTPUT,
          `${randomUUID()}_trimmed.mp4`
        );

      await runFFmpeg([
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
        "-crf",
        "20",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        output
      ]);

      await fs.unlink(
        req.file.path
      ).catch(() => {});

      await recordUsage({
        userId:
          req.user.id,
        type:
          "studio",
        seconds:
          duration,
        action:
          "trim"
      });

      res.json({
        ok: true,
        videoUrl:
          `/api/video/${path.basename(
            output
          )}`
      });
    } catch (error) {
      await fs.unlink(
        req.file?.path
      ).catch(() => {});

      await logError(
        error,
        {
          route:
            "/api/studio/trim",
          userId:
            req.user.id
        }
      );

      errorResponse(
        res,
        500,
        "TRIM_FAILED",
        "Unable to trim video."
      );
    }
  }
);

// ================================================================
// COMBINE VIDEOS
// ================================================================

app.post(
  "/api/studio/combine",
  requireAuth,
  upload.array("videos", 20),
  async (req, res) => {
    const files =
      req.files || [];

    try {
      if (
        files.length < 2
      ) {
        return errorResponse(
          res,
          400,
          "VIDEOS_REQUIRED",
          "Upload at least two videos."
        );
      }

      const paths =
        files.map(
          f => f.path
        );

      const output =
        path.join(
          OUTPUT,
          `${randomUUID()}_combined.mp4`
        );

      await combineVideoFiles(
        paths,
        output
      );

      for (
        const file
        of paths
      ) {
        await fs.unlink(
          file
        ).catch(() => {});
      }

      await recordUsage({
        userId:
          req.user.id,
        type:
          "studio",
        action:
          "combine"
      });

      res.json({
        ok: true,
        videoUrl:
          `/api/video/${path.basename(
            output
          )}`
      });
    } catch (error) {
      for (
        const file
        of files
      ) {
        await fs.unlink(
          file.path
        ).catch(() => {});
      }

      await logError(
        error,
        {
          route:
            "/api/studio/combine",
          userId:
            req.user.id
        }
      );

      errorResponse(
        res,
        500,
        "COMBINE_FAILED",
        "Unable to combine videos."
      );
    }
  }
);

// ================================================================
// SOCIAL PRESETS
// ================================================================

app.post(
  "/api/studio/social-preset",
  requireAuth,
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return errorResponse(
          res,
          400,
          "VIDEO_REQUIRED",
          "Upload a video."
        );
      }

      const ratio =
        normalizeRatio(
          req.body.ratio
        );

      const output =
        path.join(
          OUTPUT,
          `${randomUUID()}_${ratio.replace(
            ":",
            "x"
          )}.mp4`
        );

      await resizeVideo(
        req.file.path,
        ratio,
        output
      );

      await fs.unlink(
        req.file.path
      ).catch(() => {});

      await recordUsage({
        userId:
          req.user.id,
        type:
          "studio",
        action:
          `social-preset-${ratio}`
      });

      res.json({
        ok: true,
        ratio,
        videoUrl:
          `/api/video/${path.basename(
            output
          )}`
      });
    } catch (error) {
      await fs.unlink(
        req.file?.path
      ).catch(() => {});

      await logError(
        error,
        {
          route:
            "/api/studio/social-preset",
          userId:
            req.user.id
        }
      );

      errorResponse(
        res,
        500,
        "SOCIAL_PRESET_FAILED",
        "Unable to create social preset."
      );
    }
  }
);

// ================================================================
// ADMIN
// ================================================================

async function ensureAdminAccount() {
  if (
    !ADMIN_EMAIL ||
    !ADMIN_PASSWORD
  ) {
    return;
  }

  const users =
    await readJson(
      USERS_FILE,
      []
    );

  let admin =
    users.find(
      u =>
        u.email ===
        ADMIN_EMAIL
    );

  if (!admin) {
    const passwordData =
      hashPassword(
        ADMIN_PASSWORD
      );

    admin = {
      id: randomUUID(),
      name: "MAMAKI Administrator",
      email: ADMIN_EMAIL,
      passwordHash:
        passwordData.hash,
      passwordSalt:
        passwordData.salt,
      role: "admin",
      disabled: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastLoginAt: null
    };

    users.push(admin);
  } else {
    admin.role = "admin";
    admin.disabled = false;
  }

  await writeJson(
    USERS_FILE,
    users
  );
}

await ensureAdminAccount();

app.post(
  "/api/admin/login",
  async (req, res) => {
    const email =
      String(
        req.body.email || ""
      )
      .trim()
      .toLowerCase();

    const password =
      String(
        req.body.password || ""
      );

    if (
      !ADMIN_EMAIL ||
      !ADMIN_PASSWORD
    ) {
      return errorResponse(
        res,
        503,
        "ADMIN_NOT_CONFIGURED",
        "Admin account is not configured. Add ADMIN_EMAIL and ADMIN_PASSWORD to Render Environment Variables."
      );
    }

    const users =
      await readJson(
        USERS_FILE,
        []
      );

    const admin =
      users.find(
        u =>
          u.email ===
            email &&
          u.role ===
            "admin"
      );

    if (
      !admin ||
      !verifyPassword(
        password,
        admin.passwordHash,
        admin.passwordSalt
      )
    ) {
      return errorResponse(
        res,
        401,
        "INVALID_ADMIN_CREDENTIALS",
        "Invalid administrator credentials."
      );
    }

    const token =
      await createSession(
        admin.id
      );

    res.json({
      ok: true,
      token,
      user:
        publicUser(admin)
    });
  }
);

app.get(
  "/api/admin/stats",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJson(
        USERS_FILE,
        []
      );

    const usage =
      await readJson(
        USAGE_FILE,
        []
      );

    const errors =
      await readJson(
        ERRORS_FILE,
        []
      );

    let projectCount = 0;

    try {
      const files =
        await fs.readdir(
          PROJECTS
        );

      projectCount =
        files.filter(
          f =>
            f.endsWith(
              ".json"
            )
        ).length;
    } catch {}

    const aiUsage =
      usage.filter(
        r =>
          r.type ===
          "ai"
      );

    const aiSeconds =
      aiUsage.reduce(
        (sum, r) =>
          sum +
          Number(
            r.seconds || 0
          ),
        0
      );

    res.json({
      ok: true,
      stats: {
        users:
          users.length,
        activeUsers:
          users.filter(
            u =>
              !u.disabled
          ).length,
        disabledUsers:
          users.filter(
            u =>
              u.disabled
          ).length,
        projects:
          projectCount,
        totalUsageEvents:
          usage.length,
        aiJobs:
          aiUsage.length,
        aiSeconds,
        aiMinutes:
          Math.round(
            (aiSeconds / 60) *
              100
          ) / 100,
        errors:
          errors.length,
        jobsInMemory:
          jobs.size,
        uptimeSeconds:
          Math.round(
            (Date.now() -
              appStartTime) /
              1000
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
      await readJson(
        USERS_FILE,
        []
      );

    res.json({
      ok: true,
      users:
        users.map(
          publicUser
        )
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
        []
      );

    const user =
      users.find(
        u =>
          u.id ===
          req.params.id
      );

    if (!user) {
      return errorResponse(
        res,
        404,
        "USER_NOT_FOUND",
        "User not found."
      );
    }

    const usage =
      await getUserUsage(
        user.id
      );

    const projects =
      await getUserProjects(
        user.id
      );

    res.json({
      ok: true,
      user:
        publicUser(user),
      usage,
      projects
    });
  }
);

app.patch(
  "/api/admin/users/:id/status",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJson(
        USERS_FILE,
        []
      );

    const user =
      users.find(
        u =>
          u.id ===
          req.params.id
      );

    if (!user) {
      return errorResponse(
        res,
        404,
        "USER_NOT_FOUND",
        "User not found."
      );
    }

    if (
      user.role ===
      "admin"
    ) {
      return errorResponse(
        res,
        400,
        "ADMIN_PROTECTED",
        "Administrator account cannot be disabled from this endpoint."
      );
    }

    user.disabled =
      Boolean(
        req.body.disabled
      );

    user.updatedAt =
      nowIso();

    await writeJson(
      USERS_FILE,
      users
    );

    res.json({
      ok: true,
      user:
        publicUser(user)
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
    const errors =
      await readJson(
        ERRORS_FILE,
        []
      );

    res.json({
      ok: true,
      errors:
        errors.slice(-200)
          .reverse()
    });
  }
);

// ================================================================
// SYSTEM STATUS
// ================================================================

app.get(
  "/api/status",
  async (req, res) => {
    const authenticatedUser =
      await getUserFromRequest(
        req
      );

    res.json({
      ok: true,
      version:
        "13.0.0",
      name:
        "MAMAKI AI Video Studio",
      status:
        "online",
      uptimeSeconds:
        Math.round(
          (Date.now() -
            appStartTime) /
            1000
        ),
      node:
        process.version,
      ffmpeg:
        Boolean(ffmpegPath),
      replicate:
        {
          configured:
            Boolean(
              REPLICATE_API_TOKEN
            ),
          textToVideo:
            T2V_MODEL,
          imageToVideo:
            I2V_MODEL
        },
      features: {
        authentication:
          true,
        personalAccount:
          true,
        projects:
          true,
        usageTracking:
          true,
        textToVideo:
          true,
        imageToVideo:
          true,
        photoToVideo:
          true,
        videoTrimmer:
          true,
        combineVideos:
          true,
        narration:
          true,
        subtitles:
          true,
        promptEnhancement:
          true,
        socialPresets:
          true,
        watermark:
          true,
        admin:
          Boolean(
            ADMIN_EMAIL &&
            ADMIN_PASSWORD
          )
      },
      authenticated:
        Boolean(
          authenticatedUser
        )
    });
  }
);

app.get(
  "/health",
  async (req, res) => {
    res.json({
      ok: true,
      service:
        "mamaki-ai-video",
      version:
        "13.0.0",
      timestamp:
        nowIso()
    });
  }
);

// ================================================================
// ADMIN WEB DASHBOARD
// ================================================================

app.get(
  "/admin",
  (req, res) => {
    res.type("html").send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI Admin</title>
<style>
body{
  margin:0;
  background:#080808;
  color:#fff;
  font-family:Arial,sans-serif;
}
main{
  max-width:1100px;
  margin:auto;
  padding:30px 20px;
}
.card{
  background:#151515;
  border:1px solid #292929;
  border-radius:16px;
  padding:20px;
  margin-bottom:20px;
}
input,button{
  width:100%;
  box-sizing:border-box;
  padding:13px;
  margin:6px 0;
  border-radius:10px;
  border:1px solid #333;
}
button{
  cursor:pointer;
  background:#fff;
  color:#000;
  font-weight:bold;
}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:12px;
}
.stat{
  background:#101010;
  padding:18px;
  border-radius:12px;
}
.stat b{
  display:block;
  font-size:28px;
  margin-top:8px;
}
pre{
  white-space:pre-wrap;
  overflow:auto;
}
</style>
</head>
<body>
<main>

<h1>✨ MAMAKI ADMIN</h1>
<p>Private platform administration dashboard</p>

<div id="login" class="card">
<h2>Administrator Login</h2>
<input id="email" type="email" placeholder="Admin email">
<input id="password" type="password" placeholder="Admin password">
<button onclick="login()">Login</button>
<p id="loginStatus"></p>
</div>

<div id="dashboard" style="display:none">

<div class="card">
<h2>Platform Overview</h2>
<div class="grid" id="stats"></div>
</div>

<div class="card">
<h2>Users</h2>
<pre id="users">Loading...</pre>
</div>

<div class="card">
<h2>Jobs</h2>
<pre id="jobs">Loading...</pre>
</div>

<div class="card">
<h2>Error Monitor</h2>
<pre id="errors">Loading...</pre>
</div>

<button onclick="logout()">Logout</button>

</div>

</main>

<script>
let token = localStorage.getItem("mamaki_admin_token");

async function api(url, options={}){
  options.headers = {
    ...(options.headers || {}),
    "Authorization":"Bearer " + token,
    "Content-Type":"application/json"
  };

  const response = await fetch(url, options);
  return response.json();
}

async function login(){
  const email =
    document.getElementById("email").value;

  const password =
    document.getElementById("password").value;

  const response =
    await fetch("/api/admin/login",{
      method:"POST",
      headers:{
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        email,
        password
      })
    });

  const data =
    await response.json();

  if(!data.ok){
    document.getElementById("loginStatus").textContent =
      data.message || "Login failed";
    return;
  }

  token=data.token;

  localStorage.setItem(
    "mamaki_admin_token",
    token
  );

  document.getElementById("login").style.display="none";
  document.getElementById("dashboard").style.display="block";

  loadDashboard();
}

async function loadDashboard(){

  const stats =
    await api("/api/admin/stats");

  if(!stats.ok){
    logout();
    return;
  }

  const s=stats.stats;

  document.getElementById("stats").innerHTML = [
    ["Users",s.users],
    ["Active Users",s.activeUsers],
    ["Projects",s.projects],
    ["AI Jobs",s.aiJobs],
    ["AI Minutes",s.aiMinutes],
    ["Errors",s.errors],
    ["Running Jobs",s.jobsInMemory],
    ["Uptime",s.uptimeSeconds+"s"]
  ].map(x =>
    '<div class="stat">'+
    x[0]+'<b>'+x[1]+'</b>'+
    '</div>'
  ).join("");

  const users =
    await api("/api/admin/users");

  document.getElementById("users").textContent =
    JSON.stringify(users.users,null,2);

  const jobs =
    await api("/api/admin/jobs");

  document.getElementById("jobs").textContent =
    JSON.stringify(jobs.jobs,null,2);

  const errors =
    await api("/api/admin/errors");

  document.getElementById("errors").textContent =
    JSON.stringify(errors.errors,null,2);
}

function logout(){
  localStorage.removeItem(
    "mamaki_admin_token"
  );

  location.reload();
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

// ================================================================
// ACCOUNT WEB DASHBOARD
// ================================================================

app.get(
  "/account",
  (req, res) => {
    res.type("html").send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI Account</title>
<style>
body{
  margin:0;
  background:#090909;
  color:#fff;
  font-family:Arial,sans-serif;
}
main{
  max-width:900px;
  margin:auto;
  padding:30px 20px;
}
.card{
  background:#151515;
  border:1px solid #292929;
  border-radius:16px;
  padding:20px;
  margin-bottom:18px;
}
input,button{
  width:100%;
  box-sizing:border-box;
  padding:13px;
  margin:6px 0;
  border-radius:10px;
  border:1px solid #333;
}
button{
  background:#fff;
  color:#000;
  font-weight:bold;
}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:12px;
}
.stat{
  padding:18px;
  border-radius:12px;
  background:#101010;
}
.stat b{
  display:block;
  font-size:26px;
  margin-top:7px;
}
</style>
</head>

<body>
<main>

<h1>✨ MAMAKI ACCOUNT</h1>

<div id="auth" class="card">
<h2>Login</h2>
<input id="email" placeholder="Email">
<input id="password" type="password" placeholder="Password">
<button onclick="login()">Login</button>

<hr>

<h2>Create Account</h2>
<input id="name" placeholder="Full name">
<input id="signupEmail" placeholder="Email">
<input id="signupPassword" type="password" placeholder="Password">
<button onclick="signup()">Create Account</button>

<p id="message"></p>
</div>

<div id="account" style="display:none">

<div class="card">
<h2 id="welcome"></h2>
<p id="accountEmail"></p>
</div>

<div class="card">
<h2>Usage</h2>
<div id="usage" class="grid"></div>
</div>

<div class="card">
<h2>My Projects</h2>
<div id="projects"></div>
</div>

<button onclick="logout()">Logout</button>

</div>

</main>

<script>

let token =
localStorage.getItem(
  "mamaki_token"
);

async function request(
  url,
  options={}
){
  options.headers={
    ...(options.headers||{}),
    "Content-Type":"application/json"
  };

  if(token){
    options.headers.Authorization =
      "Bearer " + token;
  }

  const response =
    await fetch(url,options);

  return response.json();
}

async function login(){

  const data =
    await request(
      "/api/auth/login",
      {
        method:"POST",
        body:JSON.stringify({
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

  if(!data.ok){
    document.getElementById(
      "message"
    ).textContent =
      data.message;
    return;
  }

  token=data.token;

  localStorage.setItem(
    "mamaki_token",
    token
  );

  loadAccount();
}

async function signup(){

  const data =
    await request(
      "/api/auth/signup",
      {
        method:"POST",
        body:JSON.stringify({
          name:
            document.getElementById(
              "name"
            ).value,
          email:
            document.getElementById(
              "signupEmail"
            ).value,
          password:
            document.getElementById(
              "signupPassword"
            ).value
        })
      }
    );

  if(!data.ok){
    document.getElementById(
      "message"
    ).textContent =
      data.message;
    return;
  }

  token=data.token;

  localStorage.setItem(
    "mamaki_token",
    token
  );

  loadAccount();
}

async function loadAccount(){

  const data =
    await request(
      "/api/account"
    );

  if(!data.ok){
    logout();
    return;
  }

  document.getElementById(
    "auth"
  ).style.display="none";

  document.getElementById(
    "account"
  ).style.display="block";

  document.getElementById(
    "welcome"
  ).textContent =
    "Welcome, " +
    data.user.name;

  document.getElementById(
    "accountEmail"
  ).textContent =
    data.user.email;

  const u=data.usage;

  document.getElementById(
    "usage"
  ).innerHTML=[
    ["AI Jobs",u.aiJobs],
    ["AI Minutes",u.aiMinutes],
    ["Studio Jobs",u.studioJobs],
    ["Total Jobs",u.totalJobs],
    ["Projects",data.projectsCount]
  ].map(x =>
    '<div class="stat">'+
    x[0]+
    '<b>'+
    x[1]+
    '</b></div>'
  ).join("");

  const projects =
    await request(
      "/api/projects"
    );

  document.getElementById(
    "projects"
  ).innerHTML =
    projects.projects.length
    ? projects.projects.map(
        p =>
          '<div class="card">'+
          '<b>'+
          p.name+
          '</b><br>'+
          (p.type||"video")+
          '<br>'+
          (p.videoUrl||
            "No video")+
          '</div>'
      ).join("")
    : "<p>No projects yet.</p>";
}

async function logout(){

  await request(
    "/api/auth/logout",
    {
      method:"POST"
    }
  ).catch(()=>{});

  localStorage.removeItem(
    "mamaki_token"
  );

  location.reload();
}

if(token){
  loadAccount();
}

</script>

</body>
</html>
`);
  }
);

// ================================================================
// STATIC FRONTEND
// ================================================================

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

// ================================================================
// 404
// ================================================================

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      code: "NOT_FOUND",
      message:
        "MAMAKI endpoint not found."
    });
  }
);

// ================================================================
// GLOBAL ERROR HANDLER
// ================================================================

app.use(
  async (
    error,
    req,
    res,
    next
  ) => {
    await logError(
      error,
      {
        route:
          req.originalUrl
      }
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    errorResponse(
      res,
      500,
      "SERVER_ERROR",
      "An unexpected server error occurred."
    );
  }
);

// ================================================================
// START
// ================================================================

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      "================================================"
    );

    console.log(
      "✨ MAMAKI AI VIDEO STUDIO"
    );

    console.log(
      "Server version: 13.0.0"
    );

    console.log(
      `Server running on ${HOST}:${PORT}`
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
      "Authentication: ENABLED"
    );

    console.log(
      "Personal accounts: ENABLED"
    );

    console.log(
      "Projects: ENABLED"
    );

    console.log(
      "Voice & narration: ENABLED"
    );

    console.log(
      "Subtitles: ENABLED"
    );

    console.log(
      "Prompt enhancement: ENABLED"
    );

    console.log(
      "Social presets: ENABLED"
    );

    console.log(
      "================================================"
    );
  }
);
