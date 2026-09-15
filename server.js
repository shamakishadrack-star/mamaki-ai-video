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

const VERSION = "17.2.0";
const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const ROOT = process.cwd();
const TMP = path.join(ROOT, "tmp");
const OUTPUTS = path.join(ROOT, "outputs");
const PROJECTS = path.join(ROOT, "projects");
const DATA = path.join(ROOT, "data");

const USERS_FILE = path.join(DATA, "users.json");
const SESSIONS_FILE = path.join(DATA, "sessions.json");
const ERRORS_FILE = path.join(DATA, "errors.json");
const USAGE_FILE = path.join(DATA, "usage.json");
const CREDITS_FILE = path.join(DATA, "credits.json");
const FINANCE_FILE = path.join(DATA, "finance.json");
const PRICING_FILE = path.join(DATA, "pricing.json");
const PAYMENTS_FILE = path.join(DATA, "payments.json");
const WITHDRAWALS_FILE = path.join(DATA, "withdrawals.json");

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");
const SESSION_SECRET = String(process.env.SESSION_SECRET || "");

const REPLICATE_API_TOKEN = String(process.env.REPLICATE_API_TOKEN || "").trim();
const T2V_MODEL = String(
  process.env.REPLICATE_T2V_MODEL || "wan-video/wan-2.2-t2v-fast"
);
const I2V_MODEL = String(
  process.env.REPLICATE_I2V_MODEL || "wan-video/wan-2.2-i2v-fast"
);

const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
const RESEND_FROM = String(process.env.RESEND_FROM || "").trim();

const PAYSTACK_SECRET_KEY = String(
  process.env.PAYSTACK_SECRET_KEY || ""
).trim();
const PAYSTACK_PUBLIC_KEY = String(
  process.env.PAYSTACK_PUBLIC_KEY || ""
).trim();

const APP_URL = String(
  process.env.APP_URL || "https://mamaki-ai-video.onrender.com"
).replace(/\/+$/, "");

const FX_API_URL = String(
  process.env.FX_API_URL ||
    "https://open.er-api.com/v6/latest/USD"
).trim();

const DEFAULT_USD_NGN_RATE = Number(
  process.env.DEFAULT_USD_NGN_RATE || 1600
);

const TARGET_MARGIN = Math.min(
  0.95,
  Math.max(0.05, Number(process.env.MAMAKI_TARGET_MARGIN || 0.35))
);

const FX_BUFFER = Math.max(
  0,
  Number(process.env.MAMAKI_FX_BUFFER || 0.08)
);

const PAYMENT_FEE_BUFFER = Math.max(
  0,
  Number(process.env.MAMAKI_PAYMENT_FEE_BUFFER || 0.04)
);

const PROVIDER_COST_480P_USD = Math.max(
  0,
  Number(process.env.PROVIDER_COST_480P_USD || 0.08)
);

const PROVIDER_COST_720P_USD = Math.max(
  0,
  Number(process.env.PROVIDER_COST_720P_USD || 0.14)
);

const MIN_DURATION = 5;
const MAX_DURATION = 7200;

const RATIOS = {
  "16:9": "1920x1080",
  "9:16": "1080x1920",
  "1:1": "1080x1080"
};

const STYLES = [
  "Cinematic",
  "Realistic",
  "Documentary",
  "Commercial",
  "3D",
  "Anime",
  "Fantasy",
  "Sci-Fi",
  "Horror",
  "Cartoon"
];

const app = express();

const replicate = REPLICATE_API_TOKEN
  ? new Replicate({ auth: REPLICATE_API_TOKEN })
  : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

const adminLoginRate = new Map();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

async function ensureStorage() {
  await Promise.all([
    fs.mkdir(TMP, { recursive: true }),
    fs.mkdir(OUTPUTS, { recursive: true }),
    fs.mkdir(PROJECTS, { recursive: true }),
    fs.mkdir(DATA, { recursive: true })
  ]);

  const defaults = {
    [USERS_FILE]: [],
    [SESSIONS_FILE]: {},
    [ERRORS_FILE]: [],
    [USAGE_FILE]: {},
    [CREDITS_FILE]: {
      pool: 0,
      users: {},
      transactions: [],
      updatedAt: new Date().toISOString()
    },
    [FINANCE_FILE]: {
      transactions: []
    },
    [PRICING_FILE]: {
      fx: null,
      updatedAt: null
    },
    [PAYMENTS_FILE]: {
      transactions: []
    },
    [WITHDRAWALS_FILE]: {
      withdrawals: []
    }
  ];

  for (const [file, value] of Object.entries(defaults)) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, JSON.stringify(value, null, 2));
    }
  }
}

async function readJson(file, fallback) {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

async function readStore(file, fallback) {
  return readJson(file, fallback);
}

async function writeStore(file, data) {
  return writeJson(file, data);
}

function cleanText(value, max = 5000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeEmail(value) {
  return cleanText(value, 320).toLowerCase();
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    if (!String(stored).startsWith("scrypt:")) return false;
    const [, salt, hex] = String(stored).split(":");
    const actual = scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hex, "hex");
    return (
      actual.length === expected.length &&
      timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}

function hashToken(value) {
  return createHash("sha256")
    .update(`${SESSION_SECRET}:${value}`)
    .digest("hex");
}

function createSession(userId, role = "user") {
  const raw = randomBytes(32).toString("hex");
  return {
    token: raw,
    tokenHash: hashToken(raw),
    userId,
    role,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString()
  };
}

function getBearer(req) {
  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Bearer ")) return "";
  return h.slice(7).trim();
}

async function readUsers() {
  const data = await readJson(USERS_FILE, []);
  return Array.isArray(data) ? data : [];
}

async function writeUsers(users) {
  await writeJson(USERS_FILE, users);
}

async function readSessions() {
  const data = await readJson(SESSIONS_FILE, {});
  return data && typeof data === "object" ? data : {};
}

async function writeSessions(sessions) {
  await writeJson(SESSIONS_FILE, sessions);
}

async function readUsage() {
  const data = await readJson(USAGE_FILE, {});
  return data && typeof data === "object" ? data : {};
}

async function writeUsage(usage) {
  await writeJson(USAGE_FILE, usage);
}

async function readErrors() {
  const data = await readJson(ERRORS_FILE, []);
  return Array.isArray(data) ? data : [];
}

async function recordError(error, context = {}) {
  try {
    const errors = await readErrors();
    errors.push({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      code: error?.code || "ERROR",
      message: String(error?.message || error || "Unknown error").slice(
        0,
        2000
      ),
      context
    });

    while (errors.length > 500) errors.shift();
    await writeJson(ERRORS_FILE, errors);
  } catch {}
}

async function logSecurity(type, details = {}) {
  try {
    const file = path.join(DATA, "security.json");
    const data = await readJson(file, []);
    const events = Array.isArray(data) ? data : [];

    events.push({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      type,
      ...details
    });

    while (events.length > 500) events.shift();
    await writeJson(file, events);
  } catch {}
}

async function readSecurity() {
  const file = path.join(DATA, "security.json");
  const data = await readJson(file, []);
  return Array.isArray(data) ? data : [];
}

async function findUserById(id) {
  const users = await readUsers();
  return users.find((u) => u.id === id) || null;
}

async function findUserByEmail(email) {
  const normalized = safeEmail(email);
  const users = await readUsers();
  return (
    users.find((u) => safeEmail(u.email) === normalized) ||
    null
  );
}

async function saveUser(user) {
  const users = await readUsers();
  const index = users.findIndex((u) => u.id === user.id);

  if (index >= 0) users[index] = user;
  else users.push(user);

  await writeUsers(users);
  return user;
}

async function ensureAdminAccount() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return null;

  let user = await findUserByEmail(ADMIN_EMAIL);

  if (!user) {
    user = {
      id: randomUUID(),
      name: "MAMAKI Administrator",
      email: ADMIN_EMAIL,
      passwordHash: hashPassword(ADMIN_PASSWORD),
      role: "admin",
      disabled: false,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString()
    };

    await saveUser(user);
    await logSecurity("ADMIN_ACCOUNT_CREATED", {
      email: ADMIN_EMAIL,
      userId: user.id,
      method: "MASTER_CREDENTIALS"
    });
  } else {
    let changed = false;

    if (user.role !== "admin") {
      user.role = "admin";
      changed = true;
    }

    if (user.disabled) {
      user.disabled = false;
      changed = true;
    }

    if (!verifyPassword(ADMIN_PASSWORD, user.passwordHash)) {
      user.passwordHash = hashPassword(ADMIN_PASSWORD);
      changed = true;
    }

    if (changed) {
      await saveUser(user);
      await logSecurity("ADMIN_ACCOUNT_RESTORED", {
        email: ADMIN_EMAIL,
        userId: user.id,
        method: "MASTER_CREDENTIALS"
      });
    }
  }

  return user;
}

async function authenticate(req) {
  const token = getBearer(req);
  if (!token) return null;

  const sessions = await readSessions();
  const hash = hashToken(token);
  const session = sessions[hash];

  if (!session) return null;

  if (Date.parse(session.expiresAt || 0) < Date.now()) {
    delete sessions[hash];
    await writeSessions(sessions);
    return null;
  }

  const user = await findUserById(session.userId);
  if (!user || user.disabled) return null;

  user.lastActiveAt = new Date().toISOString();
  await saveUser(user);

  return {
    user,
    session
  };
}

async function requireUser(req, res, next) {
  try {
    const auth = await authenticate(req);

    if (!auth) {
      return res.status(401).json({
        ok: false,
        error: "AUTH_REQUIRED",
        message: "Please sign in."
      });
    }

    req.user = auth.user;
    req.session = auth.session;
    next();
  } catch (e) {
    await recordError(e, { route: req.path });
    res.status(500).json({
      ok: false,
      error: "AUTHENTICATION_FAILED"
    });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const auth = await authenticate(req);

    if (!auth || auth.user.role !== "admin") {
      return res.status(403).json({
        ok: false,
        error: "ADMIN_REQUIRED",
        message: "Administrator access required."
      });
    }

    req.user = auth.user;
    req.session = auth.session;
    next();
  } catch (e) {
    await recordError(e, { route: req.path });
    res.status(500).json({
      ok: false,
      error: "ADMIN_AUTHENTICATION_FAILED"
    });
  }
}

async function createUser(email, password, name = "") {
  const normalized = safeEmail(email);

  if (!normalized || !password) {
    throw new Error("Email and password are required.");
  }

  const existing = await findUserByEmail(normalized);

  if (existing) {
    throw new Error("An account with this email already exists.");
  }

  const user = {
    id: randomUUID(),
    name: cleanText(name, 120) || normalized.split("@")[0],
    email: normalized,
    passwordHash: hashPassword(password),
    role: "user",
    disabled: false,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString()
  };

  await saveUser(user);
  await getUserCredits(user.id);

  await logSecurity("USER_ACCOUNT_CREATED", {
    email: user.email,
    userId: user.id
  });

  return user;
}

async function loginUser(email, password, admin = false) {
  const normalized = safeEmail(email);

  if (admin) {
    const now = Date.now();
    const key = normalized || "unknown";
    const recent = adminLoginRate.get(key) || [];

    const filtered = recent.filter((x) => now - x < 15 * 60000);

    if (filtered.length >= 10) {
      throw new Error("Too many login attempts. Try again later.");
    }

    filtered.push(now);
    adminLoginRate.set(key, filtered);
  }

  const user = await findUserByEmail(normalized);

  if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) {
    if (admin) {
      await logSecurity("ADMIN_LOGIN_FAILED", {
        email: normalized,
        method: "PASSWORD"
      });
    }

    throw new Error("Invalid credentials.");
  }

  if (admin && user.role !== "admin") {
    throw new Error("Administrator access required.");
  }

  const session = createSession(user.id, user.role);
  const sessions = await readSessions();

  sessions[session.tokenHash] = {
    userId: session.userId,
    role: session.role,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt
  };

  await writeSessions(sessions);

  user.lastActiveAt = new Date().toISOString();
  await saveUser(user);

  await logSecurity(admin ? "ADMIN_LOGIN_SUCCESS" : "USER_LOGIN_SUCCESS", {
    email: user.email,
    userId: user.id,
    method: admin ? "PASSWORD" : undefined
  });

  return {
    user,
    token: session.token
  };
}

app.get("/api/health", async (req, res) => {
  const adminConfigured = Boolean(ADMIN_EMAIL && ADMIN_PASSWORD);
  const recoveryConfigured = Boolean(RESEND_API_KEY && RESEND_FROM);

  res.json({
    ok: true,
    status: "healthy",
    service: "MAMAKI AI Video Creative Studio",
    version: VERSION,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks: {
      server: true,
      ffmpeg: Boolean(ffmpegPath),
      replicateConfigured: Boolean(REPLICATE_API_TOKEN),
      adminConfigured,
      recoveryConfigured
    }
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const user = await createUser(
      req.body?.email,
      req.body?.password,
      req.body?.name
    );

    const result = await loginUser(user.email, req.body.password);

    res.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      },
      token: result.token
    });
  } catch (e) {
    await recordError(e, { route: "/api/auth/register" });
    res.status(400).json({
      ok: false,
      error: "REGISTRATION_FAILED",
      message: e.message
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const result = await loginUser(
      req.body?.email,
      req.body?.password,
      false
    );

    res.json({
      ok: true,
      user: {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        role: result.user.role
      },
      token: result.token
    });
  } catch (e) {
    await recordError(e, { route: "/api/auth/login" });
    res.status(401).json({
      ok: false,
      error: "INVALID_CREDENTIALS",
      message: "Invalid credentials."
    });
  }
});

app.post("/api/admin/login", async (req, res) => {
  try {
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      return res.status(503).json({
        ok: false,
        error: "ADMIN_NOT_CONFIGURED",
        message: "Administrator credentials are not configured."
      });
    }

    const result = await loginUser(
      req.body?.email,
      req.body?.password,
      true
    );

    if (result.user.role !== "admin") {
      return res.status(403).json({
        ok: false,
        error: "ADMIN_REQUIRED"
      });
    }

    res.json({
      ok: true,
      token: result.token,
      user: {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        role: result.user.role
      }
    });
  } catch (e) {
    await recordError(e, { route: "/api/admin/login" });
    res.status(401).json({
      ok: false,
      error: "INVALID_CREDENTIALS",
      message: "Invalid credentials."
    });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = getBearer(req);

    if (token) {
      const sessions = await readSessions();
      delete sessions[hashToken(token)];
      await writeSessions(sessions);
    }

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });
  }
});

app.get("/api/auth/me", requireUser, async (req, res) => {
  const credits = await getUserCredits(req.user.id);

  res.json({
    ok: true,
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role
    },
    credits
  });
});

async function readCredits() {
  const d = await readJson(CREDITS_FILE, {});

  return {
    pool: Number(d?.pool || 0),
    users:
      d &&
      typeof d.users === "object" &&
      d.users
        ? d.users
        : {},
    transactions: Array.isArray(d?.transactions)
      ? d.transactions
      : [],
    updatedAt:
      d?.updatedAt || new Date().toISOString()
  };
}

async function writeCredits(data) {
  data.updatedAt = new Date().toISOString();
  await writeJson(CREDITS_FILE, data);
}

async function getUserCredits(userId) {
  const data = await readCredits();

  if (!data.users[userId]) {
    data.users[userId] = {
      credits: 100,
      issued: 100,
      consumed: 0,
      refunded: 0,
      free: 100,
      paid: 0,
      promotional: 0
    };

    data.transactions.push({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      type: "ISSUE",
      userId,
      amount: 100,
      source: "STARTER"
    });

    await writeCredits(data);
  }

  const c = data.users[userId];

  return {
    credits: Math.max(0, Number(c.credits || 0)),
    issued: Number(c.issued || 0),
    consumed: Number(c.consumed || 0),
    refunded: Number(c.refunded || 0),
    free: Number(c.free || 0),
    paid: Number(c.paid || 0),
    promotional: Number(c.promotional || 0)
  };
}

async function addUserCredits(
  userId,
  amount,
  type = "ADMIN",
  source = "MANUAL"
) {
  const n = Math.floor(Number(amount));

  if (!Number.isFinite(n) || n === 0) {
    throw new Error("Credit amount must be a non-zero number.");
  }

  const data = await readCredits();

  if (!data.users[userId]) {
    await getUserCredits(userId);
    return addUserCredits(userId, amount, type, source);
  }

  const c = data.users[userId];

  c.credits = Math.max(0, Number(c.credits || 0) + n);

  if (n > 0) {
    c.issued = Number(c.issued || 0) + n;

    if (source === "PAID") c.paid = Number(c.paid || 0) + n;
    else if (source === "PROMOTIONAL")
      c.promotional = Number(c.promotional || 0) + n;
    else c.free = Number(c.free || 0) + n;
  } else {
    const remove = Math.abs(n);
    c.issued = Math.max(0, Number(c.issued || 0) - remove);
    c.free = Math.max(0, Number(c.free || 0) - remove);
  }

  data.transactions.push({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    type,
    userId,
    amount: n,
    source
  });

  await writeCredits(data);
  return c;
}

async function consumeUserCredits(userId, amount, metadata = {}) {
  const n = Math.floor(Number(amount));

  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("Invalid credit consumption.");
  }

  const data = await readCredits();

  if (!data.users[userId]) {
    await getUserCredits(userId);
    return consumeUserCredits(userId, amount, metadata);
  }

  const c = data.users[userId];

  if (Number(c.credits || 0) < n) {
    const error = new Error("Insufficient MAMAKI credits.");
    error.code = "INSUFFICIENT_CREDITS";
    throw error;
  }

  c.credits -= n;
  c.consumed = Number(c.consumed || 0) + n;

  let remaining = n;

  const free = Math.min(Number(c.free || 0), remaining);
  c.free -= free;
  remaining -= free;

  const promo = Math.min(
    Number(c.promotional || 0),
    remaining
  );

  c.promotional -= promo;
  remaining -= promo;

  c.paid = Math.max(
    0,
    Number(c.paid || 0) - remaining
  );

  data.transactions.push({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    type: "CONSUME",
    userId,
    amount: n,
    metadata
  });

  await writeCredits(data);
  return c;
}

async function refundUserCredits(userId, amount, metadata = {}) {
  const n = Math.floor(Number(amount));

  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("Invalid refund amount.");
  }

  const data = await readCredits();

  if (!data.users[userId]) {
    await getUserCredits(userId);
    return refundUserCredits(userId, amount, metadata);
  }

  const c = data.users[userId];

  c.credits = Number(c.credits || 0) + n;
  c.refunded = Number(c.refunded || 0) + n;
  c.issued = Number(c.issued || 0) + n;
  c.paid = Number(c.paid || 0) + n;

  data.transactions.push({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    type: "REFUND",
    userId,
    amount: n,
    metadata
  });

  await writeCredits(data);
  return c;
}

async function creditSummary() {
  const data = await readCredits();

  let issued = 0;
  let consumed = 0;
  let refunded = 0;
  let remaining = 0;

  const balances = [];

  for (const [userId, c] of Object.entries(data.users)) {
    const credits = Number(c.credits || 0);
    issued += Number(c.issued || 0);
    consumed += Number(c.consumed || 0);
    refunded += Number(c.refunded || 0);
    remaining += credits;

    balances.push({
      userId,
      credits,
      free: Number(c.free || 0),
      paid: Number(c.paid || 0),
      promotional: Number(c.promotional || 0)
    });
  }

  return {
    issued,
    consumed,
    refunded,
    remaining,
    balances
  };
}

async function providerCapacityAvailable() {
  if (!REPLICATE_API_TOKEN || !replicate) return false;

  const state = await readStore(PRICING_FILE, {});

  if (
    state.providerBlockedUntil &&
    Date.parse(state.providerBlockedUntil) > Date.now()
  ) {
    return false;
  }

  return true;
}

async function markProviderBlocked(minutes = 10) {
  const state = await readStore(PRICING_FILE, {});

  state.providerBlockedUntil = new Date(
    Date.now() + minutes * 60000
  ).toISOString();

  await writeStore(PRICING_FILE, state);
}

async function enhancePrompt(prompt, style = "Cinematic") {
  const p = cleanText(prompt, 12000);

  return [
    p,
    `Visual style: ${style}.`,
    "Create a coherent professional video.",
    "Maintain visual continuity.",
    "Avoid captions, subtitles, watermarks and logos inside the generated scene.",
    "Use cinematic composition, natural movement and consistent subjects."
  ].join(" ");
}

function normalizeDuration(value) {
  const n = Number(value || 5);

  if (!Number.isFinite(n)) return 5;

  return Math.min(
    MAX_DURATION,
    Math.max(MIN_DURATION, Math.round(n))
  );
}

function normalizeRatio(value) {
  return RATIOS[value] ? value : "16:9";
}

function normalizeStyle(value) {
  return STYLES.includes(value) ? value : "Cinematic";
}

function wanFrames(duration) {
  return duration <= 5 ? 81 : 121;
}

function isProviderBillingError(error) {
  const message = String(
    error?.message || error || ""
  ).toLowerCase();

  return (
    message.includes("402") ||
    message.includes("insufficient credit") ||
    message.includes("payment required") ||
    message.includes("billing") ||
    message.includes("credit required")
  );
}

function providerErrorMessage(error) {
  if (isProviderBillingError(error)) {
    return "Replicate requires available credit or billing before this AI generation can start.";
  }

  const message = String(error?.message || error || "");

  if (
    message.toLowerCase().includes("unauthorized") ||
    message.toLowerCase().includes("authentication")
  ) {
    return "Replicate authentication failed. Check the configured API token.";
  }

  if (
    message.toLowerCase().includes("forbidden")
  ) {
    return "Replicate rejected this request. Check account permissions, model access and billing.";
  }

  return message.slice(0, 2000) || "AI generation failed.";
}

function estimateCreditCost(duration, quality = "Standard HD") {
  const seconds = Math.max(5, Number(duration || 5));
  const multiplier =
    String(quality).toLowerCase().includes("cinematic")
      ? 1.8
      : String(quality).toLowerCase().includes("high")
        ? 1.4
        : 1;

  return Math.max(
    1,
    Math.ceil(seconds * 2 * multiplier)
  );
}

async function addUsage(
  userId,
  field,
  amount = 1
) {
  const usage = await readUsage();

  if (!usage[userId]) {
    usage[userId] = {
      aiGenerations: 0,
      aiSeconds: 0,
      studioJobs: 0,
      narrationJobs: 0,
      updatedAt: new Date().toISOString()
    };
  }

  usage[userId][field] =
    Number(usage[userId][field] || 0) + Number(amount || 0);

  usage[userId].updatedAt =
    new Date().toISOString();

  await writeUsage(usage);
}

async function readJobs() {
  const file = path.join(DATA, "jobs.json");
  const data = await readJson(file, []);

  return Array.isArray(data) ? data : [];
}

async function writeJobs(jobs) {
  const file = path.join(DATA, "jobs.json");
  await writeJson(file, jobs);
}

async function saveJob(job) {
  const jobs = await readJobs();
  const i = jobs.findIndex((x) => x.id === job.id);

  if (i >= 0) jobs[i] = job;
  else jobs.push(job);

  while (jobs.length > 500) jobs.shift();

  await writeJobs(jobs);
  return job;
}

async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      return reject(new Error("FFmpeg is unavailable."));
    }

    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(
          `FFmpeg exited with code ${code}: ${stderr.slice(-3000)}`
        );
        error.code = "FFMPEG_FAILED";
        reject(error);
      }
    });
  });
}

async function applyMamakiWatermark(input, output) {
  await runFfmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    "drawtext=text='MAMAKI ✨':x=w-tw-24:y=h-th-24:fontsize=28:fontcolor=white@0.78:box=1:boxcolor=black@0.25:boxborderw=8",
    "-c:a",
    "copy",
    output
  ]);
}

async function generateWithReplicate({
  prompt,
  imageUrl,
  duration,
  ratio,
  quality
}) {
  if (!replicate || !REPLICATE_API_TOKEN) {
    const error = new Error(
      "Replicate is not configured."
    );
    error.code = "REPLICATE_NOT_CONFIGURED";
    throw error;
  }

  const frames = wanFrames(duration);
  const size = RATIOS[ratio] || RATIOS["16:9"];

  const input = {
    prompt,
    num_frames: frames,
    width: Number(size.split("x")[0]),
    height: Number(size.split("x")[1]),
    go_fast: true
  };

  if (imageUrl) {
    input.image = imageUrl;
  }

  let model = T2V_MODEL;

  if (imageUrl) {
    model = I2V_MODEL;
  }

  const output = await replicate.run(model, {
    input
  });

  let url = "";

  if (typeof output === "string") {
    url = output;
  } else if (output?.url) {
    url = String(output.url());
  } else if (Array.isArray(output)) {
    const first = output[0];

    if (typeof first === "string") {
      url = first;
    } else if (first?.url) {
      url = String(first.url());
    }
  }

  if (!url) {
    throw new Error(
      "Replicate completed but no video file was returned."
    );
  }

  return {
    url,
    model,
    frames,
    quality
  };
}

async function downloadToFile(url, file) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Unable to download generated media: HTTP ${response.status}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  await fs.writeFile(file, buffer);

  return file;
}

async function recordEstimatedProviderCost(
  duration,
  quality,
  userId,
  jobId
) {
  try {
    const scenes = Math.max(
      1,
      Math.ceil(Number(duration || 5) / 5)
    );

    const q = String(quality || "Standard HD").toLowerCase();

    const usd =
      scenes *
      (
        q.includes("high") ||
        q.includes("cinematic")
          ? PROVIDER_COST_720P_USD
          : PROVIDER_COST_480P_USD
      );

    const fx = await getFxRates();

    const ngn =
      usd *
      Number(
        fx.rates.NGN ||
        DEFAULT_USD_NGN_RATE
      );

    await addFinanceTransaction(
      "AI_COST",
      Number(ngn.toFixed(2)),
      `Estimated Replicate AI cost · ${scenes} scenes · ${userId} · job ${jobId} · $${usd.toFixed(4)}`
    );
  } catch (e) {
    await recordError(e, {
      route: "/billing/provider-cost",
      jobId,
      userId
    });
  }
}

app.post(
  "/api/generate",
  requireUser,
  upload.single("image"),
  async (req, res) => {
    const job = {
      id: randomUUID(),
      userId: req.user.id,
      type: req.file ? "image-to-video" : "text-to-video",
      status: "queued",
      progress: 0,
      duration: normalizeDuration(req.body?.duration),
      quality: cleanText(
        req.body?.quality || "Standard HD",
        50
      ),
      ratio: normalizeRatio(req.body?.ratio),
      style: normalizeStyle(req.body?.style),
      prompt: cleanText(req.body?.prompt, 12000),
      creditCost: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    try {
      if (!job.prompt) {
        return res.status(400).json({
          ok: false,
          error: "PROMPT_REQUIRED",
          message: "Describe the video you want to create."
        });
      }

      job.creditCost = estimateCreditCost(
        job.duration,
        job.quality
      );

      const billingState =
        await readStore(PRICING_FILE, {});

      if (
        billingState.providerBlockedUntil &&
        Date.parse(
          billingState.providerBlockedUntil
        ) > Date.now()
      ) {
        return res.status(503).json({
          ok: false,
          error: "AI_PROVIDER_UNAVAILABLE",
          message:
            "AI generation is temporarily unavailable because the connected provider is not ready."
        });
      }

      const providerReady =
        await providerCapacityAvailable();

      if (!providerReady) {
        return res.status(503).json({
          ok: false,
          error: "AI_PROVIDER_UNAVAILABLE",
          message:
            "AI generation requires an active Replicate account and available credit."
        });
      }

      const credits =
        await getUserCredits(req.user.id);

      if (credits.credits < job.creditCost) {
        return res.status(402).json({
          ok: false,
          error: "INSUFFICIENT_CREDITS",
          message:
            `You need ${job.creditCost} MAMAKI Credits for this production.`,
          required: job.creditCost,
          available: credits.credits
        });
      }

      await consumeUserCredits(
        req.user.id,
        job.creditCost,
        { jobId: job.id }
      );

      await saveJob(job);

      job.status = "processing";
      job.progress = 10;
      job.updatedAt = new Date().toISOString();
      await saveJob(job);

      const prompt = await enhancePrompt(
        job.prompt,
        job.style
      );

      let imageUrl = "";

      if (req.file) {
        const extension =
          path.extname(req.file.originalname || ".jpg") ||
          ".jpg";

        const imagePath = path.join(
          TMP,
          `${randomUUID()}${extension}`
        );

        await fs.writeFile(
          imagePath,
          req.file.buffer
        );

        imageUrl = imagePath;
      }

      let generated;

      try {
        generated = await generateWithReplicate({
          prompt,
          imageUrl,
          duration: job.duration,
          ratio: job.ratio,
          quality: job.quality
        });
      } catch (e) {
        if (isProviderBillingError(e)) {
          await markProviderBlocked(10);

          await refundUserCredits(
            req.user.id,
            job.creditCost,
            {
              jobId: job.id,
              reason: "PROVIDER_BILLING_FAILURE"
            }
          );
        }

        throw e;
      }

      job.progress = 65;
      job.updatedAt = new Date().toISOString();
      await saveJob(job);

      const rawPath = path.join(
        TMP,
        `${job.id}-raw.mp4`
      );

      const finalPath = path.join(
        OUTPUTS,
        `${job.id}.mp4`
      );

      await downloadToFile(
        generated.url,
        rawPath
      );

      await applyMamakiWatermark(
        rawPath,
        finalPath
      );

      job.progress = 100;
      job.status = "completed";
      job.output = `/outputs/${path.basename(finalPath)}`;
      job.model = generated.model;
      job.completedAt = new Date().toISOString();
      job.updatedAt = new Date().toISOString();

      await saveJob(job);

      await addUsage(
        req.user.id,
        "aiGenerations",
        1
      );

      await addUsage(
        req.user.id,
        "aiSeconds",
        job.duration
      );

      await recordEstimatedProviderCost(
        job.duration,
        job.quality,
        req.user.id,
        job.id
      );

      res.json({
        ok: true,
        job: {
          id: job.id,
          status: job.status,
          progress: job.progress,
          output: job.output,
          duration: job.duration,
          creditsUsed: job.creditCost
        }
      });
    } catch (e) {
      job.status = "failed";
      job.progress = 0;
      job.message = providerErrorMessage(e);
      job.error = job.message;
      job.updatedAt = new Date().toISOString();

      await saveJob(job);
      await recordError(e, {
        route: "/api/generate",
        userId: req.user.id,
        jobId: job.id
      });

      res.status(
        isProviderBillingError(e) ? 402 : 500
      ).json({
        ok: false,
        error: isProviderBillingError(e)
          ? "PROVIDER_CREDIT_REQUIRED"
          : "GENERATION_FAILED",
        message: providerErrorMessage(e),
        jobId: job.id
      });
    }
  }
);

app.use(
  "/outputs",
  express.static(OUTPUTS, {
    maxAge: "1h"
  })
);

async function readFinance() {
  const d = await readJson(
    FINANCE_FILE,
    { transactions: [] }
  );

  return {
    transactions: Array.isArray(d.transactions)
      ? d.transactions
      : []
  };
}

async function writeFinance(data) {
  await writeJson(FINANCE_FILE, data);
}

async function addFinanceTransaction(
  type,
  amount,
  description,
  extra = {}
) {
  const data = await readFinance();

  data.transactions.push({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    type: String(type).toUpperCase(),
    amount: Number(amount || 0),
    description: cleanText(description, 1000),
    ...extra
  });

  await writeFinance(data);

  return data.transactions[
    data.transactions.length - 1
  ];
}

function financeSummary(ts) {
  let grossRevenue = 0;
  let refunds = 0;
  let costs = 0;

  for (const t of ts) {
    const type = String(
      t.type || ""
    ).toUpperCase();

    const a = Number(t.amount || 0);

    if (type === "REVENUE") {
      grossRevenue += a;
    } else if (type === "REFUND") {
      refunds += a;
    } else if (
      [
        "AI_COST",
        "INFRASTRUCTURE_COST",
        "OTHER_COST",
        "COST"
      ].includes(type)
    ) {
      costs += a;
    }
  }

  const netRevenue =
    grossRevenue - refunds;

  const profit =
    netRevenue - costs;

  return {
    grossRevenue,
    refunds,
    netRevenue,
    costs,
    profit,
    profitMargin:
      netRevenue > 0
        ? (profit / netRevenue) * 100
        : 0
  };
}

function normalizeCurrency(value) {
  const c = String(value || "NGN")
    .trim()
    .toUpperCase();

  return [
    "NGN",
    "USD",
    "GBP",
    "EUR"
  ].includes(c)
    ? c
    : "NGN";
}

async function getFxRates() {
  const now = Date.now();

  const store = await readStore(
    PRICING_FILE,
    {
      fx: null,
      updatedAt: null
    }
  );

  if (
    store.fx &&
    store.fx.rates &&
    store.fx.updatedAt &&
    now -
      Date.parse(store.fx.updatedAt) <
      30 * 60 * 1000
  ) {
    return store.fx;
  }

  try {
    const response = await fetch(
      FX_API_URL,
      {
        headers: {
          Accept: "application/json"
        }
      }
    );

    if (!response.ok) {
      throw new Error(
        `FX service returned ${response.status}`
      );
    }

    const data = await response.json();

    const usdNgn = Number(
      data?.rates?.NGN
    );

    if (
      !Number.isFinite(usdNgn) ||
      usdNgn <= 0
    ) {
      throw new Error(
        "FX service returned an invalid NGN rate."
      );
    }

    const fx = {
      base: "USD",
      rates: {
        USD: 1,
        NGN: usdNgn,
        GBP: Number(data?.rates?.GBP || 0),
        EUR: Number(data?.rates?.EUR || 0)
      },
      source: FX_API_URL,
      updatedAt: new Date().toISOString(),
      live: true
    };

    store.fx = fx;
    await writeStore(
      PRICING_FILE,
      store
    );

    return fx;
  } catch (e) {
    const fx = {
      base: "USD",
      rates: {
        USD: 1,
        NGN: DEFAULT_USD_NGN_RATE
      },
      source: "configured fallback",
      updatedAt: new Date().toISOString(),
      live: false,
      error: String(
        e.message || e
      )
    };

    store.fx = fx;

    await writeStore(
      PRICING_FILE,
      store
    );

    return fx;
  }
}

function providerCostForCredits(
  credits,
  quality = "Standard HD"
) {
  const c = Math.max(
    1,
    Number(credits || 1)
  );

  const qualityText =
    String(quality).toLowerCase();

  const costPerCredit =
    qualityText.includes("cinematic")
      ? 0.0018
      : qualityText.includes("high")
        ? 0.0014
        : 0.001;

  return c * costPerCredit;
}

async function calculateCreditPrice(
  credits,
  currency = "NGN",
  quality = "Standard HD"
) {
  const c = Math.max(
    1,
    Math.floor(Number(credits || 1))
  );

  const cur =
    normalizeCurrency(currency);

  const fx = await getFxRates();

  const providerUsd =
    providerCostForCredits(
      c,
      quality
    );

  const protectedUsd =
    providerUsd *
    (1 + FX_BUFFER);

  const paymentProtectedUsd =
    protectedUsd *
    (1 + PAYMENT_FEE_BUFFER);

  const customerUsd =
    paymentProtectedUsd /
    Math.max(
      0.05,
      1 - TARGET_MARGIN
    );

  let amount;

  if (cur === "NGN") {
    amount =
      customerUsd *
      Number(
        fx.rates.NGN ||
        DEFAULT_USD_NGN_RATE
      );

    amount =
      Math.max(
        100,
        Math.ceil(amount / 50) * 50
      );
  } else {
    amount =
      customerUsd *
      Number(fx.rates[cur] || 1);

    amount =
      Math.max(
        1,
        Math.ceil(amount * 100) / 100
      );
  }

  return {
    credits: c,
    currency: cur,
    providerCostUsd:
      providerUsd,
    protectedProviderCostUsd:
      protectedUsd,
    usdPrice: customerUsd,
    amount,
    amountSubunit:
      cur === "NGN"
        ? Math.round(amount * 100)
        : Math.round(amount * 100),
    providerScenes: Math.max(
      1,
      Math.ceil(c / 10)
    ),
    fxRate:
      cur === "NGN"
        ? Number(
            fx.rates.NGN ||
              DEFAULT_USD_NGN_RATE
          )
        : Number(
            fx.rates[cur] || 1
          ),
    fxLive: Boolean(fx.live),
    fxUpdatedAt: fx.updatedAt,
    marginTarget: TARGET_MARGIN,
    paymentFeeBuffer:
      PAYMENT_FEE_BUFFER,
    fxBuffer: FX_BUFFER
  };
}

async function getPricingPackages(
  currency = "NGN"
) {
  const packages = [
    100,
    250,
    500,
    1000,
    2500,
    5000,
    10000
  ];

  const result = [];

  for (const credits of packages) {
    result.push(
      await calculateCreditPrice(
        credits,
        currency
      )
    );
  }

  return result;
}

async function readPayments() {
  const d = await readStore(
    PAYMENTS_FILE,
    { transactions: [] }
  );

  return {
    transactions:
      Array.isArray(d.transactions)
        ? d.transactions
        : []
  };
}

async function writePayments(data) {
  await writeStore(
    PAYMENTS_FILE,
    data
  );
}

async function recordPayment(payment) {
  const data =
    await readPayments();

  const existing =
    data.transactions.find(
      (x) =>
        x.reference === payment.reference
    );

  if (existing) {
    Object.assign(
      existing,
      payment
    );
  } else {
    data.transactions.push(payment);
  }

  await writePayments(data);

  return payment;
}

async function findPayment(reference) {
  const data =
    await readPayments();

  return (
    data.transactions.find(
      (x) =>
        x.reference === reference
    ) || null
  );
}

async function paystackRequest(
  endpoint,
  options = {}
) {
  if (!PAYSTACK_SECRET_KEY) {
    const error = new Error(
      "Paystack is not configured."
    );
    error.code =
      "PAYMENT_NOT_CONFIGURED";
    throw error;
  }

  const response = await fetch(
    `https://api.paystack.co${endpoint}`,
    {
      ...options,
      headers: {
        Authorization:
          `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type":
          "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      message: text
    };
  }

  if (
    !response.ok ||
    data.status === false
  ) {
    const error =
      new Error(
        data.message ||
          `Paystack request failed with status ${response.status}`
      );

    error.code =
      "PAYSTACK_REQUEST_FAILED";

    throw error;
  }

  return data;
}

async function fulfillSuccessfulPayment(
  reference
) {
  const existing =
    await findPayment(reference);

  if (!existing) {
    throw new Error(
      "Payment record not found."
    );
  }

  const verified =
    await paystackRequest(
      `/transaction/verify/${encodeURIComponent(
        reference
      )}`
    );

  const status =
    String(
      verified?.data?.status || ""
    ).toLowerCase();

  if (status !== "success") {
    existing.status =
      status || "pending";

    await recordPayment(existing);

    return existing;
  }

  const verifiedAmount =
    Number(
      verified?.data?.amount || 0
    );

  const expectedAmount =
    Number(
      existing.amountSubunit || 0
    );

  const verifiedCurrency =
    String(
      verified?.data?.currency ||
        existing.currency ||
        "NGN"
    ).toUpperCase();

  if (
    expectedAmount > 0 &&
    verifiedAmount !== expectedAmount
  ) {
    existing.status =
      "amount_mismatch";

    await recordPayment(existing);

    const error =
      new Error(
        "Payment amount does not match the MAMAKI order."
      );

    error.code =
      "PAYMENT_AMOUNT_MISMATCH";

    throw error;
  }

  if (
    existing.fulfilledAt
  ) {
    return existing;
  }

  const user =
    await findUserById(
      existing.userId
    );

  if (!user) {
    throw new Error(
      "Payment user no longer exists."
    );
  }

  await addUserCredits(
    existing.userId,
    existing.credits,
    "PURCHASE",
    "PAID"
  );

  existing.fulfilledAt =
    new Date().toISOString();

  existing.status =
    "success";

  existing.gatewayAmount =
    verifiedAmount;

  existing.currency =
    verifiedCurrency;

  existing.gatewayReference =
    reference;

  await recordPayment(existing);

  const amountMajor =
    verifiedAmount / 100;

  await addFinanceTransaction(
    "REVENUE",
    amountMajor,
    `MAMAKI credit purchase · ${existing.credits} credits · ${reference}`,
    {
      userId: existing.userId,
      paymentReference: reference,
      currency: verifiedCurrency
    }
  );

  return existing;
}

app.get(
  "/api/billing/pricing",
  async (req, res) => {
    try {
      const currency =
        normalizeCurrency(
          req.query.currency
        );

      res.json({
        ok: true,
        currency,
        packages:
          await getPricingPackages(
            currency
          ),
        paystackConfigured:
          Boolean(
            PAYSTACK_SECRET_KEY
          ),
        publicKey:
          PAYSTACK_PUBLIC_KEY ||
          null
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/billing/pricing"
      });

      res.status(500).json({
        ok: false,
        error:
          "PRICING_UNAVAILABLE",
        message:
          "Unable to calculate current pricing."
      });
    }
  }
);

app.post(
  "/api/billing/paystack/initialize",
  requireUser,
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        return res.status(503).json({
          ok: false,
          error:
            "PAYMENT_NOT_CONFIGURED",
          message:
            "MAMAKI payments are not configured yet."
        });
      }

      const credits = Math.floor(
        Number(
          req.body?.credits || 0
        )
      );

      if (
        !Number.isFinite(credits) ||
        credits < 1
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_CREDIT_AMOUNT"
        });
      }

      const currency =
        normalizeCurrency(
          req.body?.currency
        );

      if (currency !== "NGN") {
        return res.status(400).json({
          ok: false,
          error:
            "CURRENCY_NOT_SUPPORTED_FOR_GATEWAY",
          message:
            "This MAMAKI checkout currently uses Paystack NGN checkout. International customers should use a supported international payment configuration."
        });
      }

      const pricing =
        await calculateCreditPrice(
          credits,
          currency,
          req.body?.quality ||
            "Standard HD"
        );

      const reference =
        `MAMAKI-${Date.now()}-${randomBytes(
          5
        ).toString("hex")}`;

      const callback =
        `${APP_URL}/?payment=complete&reference=${encodeURIComponent(
          reference
        )}`;

      const payload = {
        email: req.user.email,
        amount:
          pricing.amountSubunit,
        currency,
        reference,
        callback_url: callback,
        metadata: {
          userId: req.user.id,
          credits,
          pricing,
          product:
            "MAMAKI AI Credits"
        }
      };

      const result =
        await paystackRequest(
          "/transaction/initialize",
          {
            method: "POST",
            body: JSON.stringify(
              payload
            )
          }
        );

      await recordPayment({
        id: randomUUID(),
        reference,
        userId: req.user.id,
        credits,
        currency,
        amount: pricing.amount,
        amountSubunit:
          pricing.amountSubunit,
        pricing,
        status:
          "initialized",
        createdAt:
          new Date().toISOString()
      });

      res.json({
        ok: true,
        authorizationUrl:
          result.data
            ?.authorization_url,
        accessCode:
          result.data
            ?.access_code,
        reference,
        pricing
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/billing/paystack/initialize",
        userId:
          req.user?.id
      });

      res.status(500).json({
        ok: false,
        error:
          e.code ||
          "PAYMENT_INITIALIZATION_FAILED",
        message:
          e.message
      });
    }
  }
);

app.post(
  "/api/payments/paystack/webhook",
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        return res
          .status(200)
          .json({ ok: true });
      }

      const signature =
        String(
          req.headers[
            "x-paystack-signature"
          ] || ""
        );

      const body =
        JSON.stringify(req.body);

      const expected =
        createHash("sha512")
          .update(
            body
          )
          .digest("hex");

      if (
        !signature ||
        signature !== expected
      ) {
        return res.status(401).json({
          ok: false,
          error:
            "INVALID_WEBHOOK_SIGNATURE"
        });
      }

      const event =
        req.body || {};

      if (
        event.event ===
        "charge.success"
      ) {
        const reference =
          event.data?.reference;

        if (reference) {
          await fulfillSuccessfulPayment(
            reference
          );
        }
      }

      res.json({ ok: true });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/payments/paystack/webhook"
      });

      res
        .status(200)
        .json({ ok: true });
    }
  }
);

app.get(
  "/api/billing/payment/:reference",
  requireUser,
  async (req, res) => {
    try {
      const p =
        await findPayment(
          req.params.reference
        );

      if (
        !p ||
        p.userId !== req.user.id
      ) {
        return res.status(404).json({
          ok: false,
          error:
            "PAYMENT_NOT_FOUND"
        });
      }

      if (
        PAYSTACK_SECRET_KEY &&
        !p.fulfilledAt
      ) {
        try {
          await fulfillSuccessfulPayment(
            p.reference
          );
        } catch {}
      }

      const fresh =
        await findPayment(
          p.reference
        );

      res.json({
        ok: true,
        payment: fresh
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/billing/payment/:reference",
        userId:
          req.user?.id
      });

      res.status(500).json({
        ok: false,
        error:
          "PAYMENT_STATUS_FAILED"
      });
    }
  }
);

async function readWithdrawals() {
  const d =
    await readStore(
      WITHDRAWALS_FILE,
      { withdrawals: [] }
    );

  return {
    withdrawals:
      Array.isArray(
        d.withdrawals
      )
        ? d.withdrawals
        : []
  };
}

async function writeWithdrawals(
  data
) {
  await writeStore(
    WITHDRAWALS_FILE,
    data
  );
}

async function ownerFinancialSnapshot() {
  const finance =
    await readFinance();

  const summary =
    financeSummary(
      finance.transactions
    );

  const wd =
    await readWithdrawals();

  const withdrawn =
    wd.withdrawals
      .filter(
        (x) =>
          String(x.status) ===
          "success"
      )
      .reduce(
        (a, x) =>
          a + Number(x.amount || 0),
        0
      );

  const pending =
    wd.withdrawals
      .filter((x) =>
        [
          "pending",
          "otp"
        ].includes(
          String(x.status)
        )
      )
      .reduce(
        (a, x) =>
          a + Number(x.amount || 0),
        0
      );

  return {
    ...summary,
    withdrawn,
    pendingWithdrawals:
      pending,
    availableToWithdraw:
      Math.max(
        0,
        summary.profit -
          withdrawn -
          pending
      )
  };
}

app.get(
  "/api/account/billing",
  requireUser,
  async (req, res) => {
    try {
      const currency =
        normalizeCurrency(
          req.query.currency
        );

      const pricing =
        await getPricingPackages(
          currency
        );

      const credits =
        await getUserCredits(
          req.user.id
        );

      res.json({
        ok: true,
        credits,
        pricing,
        currency,
        paymentsConfigured:
          Boolean(
            PAYSTACK_SECRET_KEY
          ),
        publicKey:
          PAYSTACK_PUBLIC_KEY ||
          null
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error:
          "BILLING_STATUS_FAILED"
      });
    }
  }
);

app.get(
  "/api/admin/billing",
  requireAdmin,
  async (req, res) => {
    try {
      const [
        wallet,
        pricing,
        payments,
        withdrawals,
        fx
      ] = await Promise.all([
        ownerFinancialSnapshot(),
        getPricingPackages("NGN"),
        readPayments(),
        readWithdrawals(),
        getFxRates()
      ]);

      res.json({
        ok: true,
        wallet,
        fx,
        pricing,
        payments:
          payments.transactions
            .slice(-200)
            .reverse(),
        withdrawals:
          withdrawals.withdrawals
            .slice(-100)
            .reverse(),
        paystack: {
          configured:
            Boolean(
              PAYSTACK_SECRET_KEY
            ),
          publicKey:
            PAYSTACK_PUBLIC_KEY ||
            null
        }
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/admin/billing"
      });

      res.status(500).json({
        ok: false,
        error:
          "BILLING_DASHBOARD_FAILED"
      });
    }
  }
);

app.post(
  "/api/admin/withdraw",
  requireAdmin,
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        return res.status(503).json({
          ok: false,
          error:
            "PAYMENT_NOT_CONFIGURED",
          message:
            "Owner bank payout requires Paystack to be configured."
        });
      }

      const amount = Number(
        req.body?.amount || 0
      );

      const name = cleanText(
        req.body?.name,
        160
      );

      const accountNumber =
        cleanText(
          req.body?.accountNumber,
          30
        ).replace(/\D/g, "");

      const bankCode =
        cleanText(
          req.body?.bankCode,
          30
        );

      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        !name ||
        accountNumber.length < 8 ||
        !bankCode
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_WITHDRAWAL_DETAILS",
          message:
            "Enter a valid amount, account name, account number and bank code."
        });
      }

      const wallet =
        await ownerFinancialSnapshot();

      if (
        amount >
        wallet.availableToWithdraw
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "WITHDRAWAL_EXCEEDS_AVAILABLE_PROFIT",
          available:
            wallet.availableToWithdraw
        });
      }

      const recipient =
        await paystackRequest(
          "/transferrecipient",
          {
            method: "POST",
            body: JSON.stringify({
              type: "nuban",
              name,
              account_number:
                accountNumber,
              bank_code: bankCode,
              currency: "NGN",
              description:
                "MAMAKI owner payout"
            })
          }
        );

      const reference =
        `MAMAKI-WD-${Date.now()}-${randomBytes(
          4
        ).toString("hex")}`;

      const transfer =
        await paystackRequest(
          "/transfer",
          {
            method: "POST",
            body: JSON.stringify({
              source: "balance",
              amount:
                Math.round(
                  amount * 100
                ),
              recipient:
                recipient.data
                  ?.recipient_code,
              reference,
              reason:
                "MAMAKI owner profit withdrawal",
              currency: "NGN"
            })
          }
        );

      const status =
        String(
          transfer.data?.status ||
            "pending"
        ).toLowerCase();

      const data =
        await readWithdrawals();

      data.withdrawals.push({
        id: randomUUID(),
        reference,
        amount,
        name,
        accountNumber:
          accountNumber.slice(-4),
        bankCode,
        status,
        transferCode:
          transfer.data
            ?.transfer_code ||
          null,
        createdAt:
          new Date().toISOString()
      });

      await writeWithdrawals(
        data
      );

      if (
        status === "success"
      ) {
        await addFinanceTransaction(
          "OWNER_WITHDRAWAL",
          amount,
          `Owner profit withdrawal ${reference}`
        );
      }

      res.json({
        ok: true,
        message:
          status === "success"
            ? "Withdrawal completed."
            : "Withdrawal submitted and is being processed.",
        reference,
        status
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/admin/withdraw"
      });

      res.status(500).json({
        ok: false,
        error:
          "WITHDRAWAL_FAILED",
        message:
          e.message
      });
    }
  }
);

app.post(
  "/api/admin/users/:id/credits",
  requireAdmin,
  async (req, res) => {
    try {
      const user =
        await findUserById(
          req.params.id
        );

      if (!user) {
        return res.status(404).json({
          ok: false,
          error:
            "USER_NOT_FOUND"
        });
      }

      const amount = Math.floor(
        Number(
          req.body?.amount || 0
        )
      );

      const source =
        cleanText(
          req.body?.source ||
            "MANUAL",
          40
        ).toUpperCase();

      if (
        !Number.isFinite(amount) ||
        amount === 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_CREDIT_AMOUNT"
        });
      }

      let result;

      if (amount > 0) {
        result =
          await addUserCredits(
            user.id,
            amount,
            "ADMIN_ADJUSTMENT",
            source
          );
      } else {
        result =
          await consumeUserCredits(
            user.id,
            Math.abs(amount),
            {
              reason:
                "ADMIN_ADJUSTMENT"
            }
          );
      }

      await logSecurity(
        "ADMIN_CREDIT_ADJUSTMENT",
        {
          email:
            req.user.email,
          adminUserId:
            req.user.id,
          userId:
            user.id,
          amount
        }
      );

      res.json({
        ok: true,
        credits:
          result.credits,
        userId:
          user.id
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/admin/users/:id/credits"
      });

      res.status(400).json({
        ok: false,
        error:
          e.code ||
          "CREDIT_ADJUSTMENT_FAILED",
        message:
          e.message
      });
    }
  }
);

app.post(
  "/api/admin/finance",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        cleanText(
          req.body?.type,
          50
        ).toUpperCase();

      const amount = Number(
        req.body?.amount || 0
      );

      const description =
        cleanText(
          req.body?.description,
          1000
        );

      const allowed = [
        "REVENUE",
        "REFUND",
        "AI_COST",
        "INFRASTRUCTURE_COST",
        "OTHER_COST"
      ];

      if (!allowed.includes(type)) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_FINANCE_TYPE"
        });
      }

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "INVALID_FINANCE_AMOUNT"
        });
      }

      const transaction =
        await addFinanceTransaction(
          type,
          amount,
          description,
          {
            adminUserId:
              req.user.id
          }
        );

      res.json({
        ok: true,
        transaction
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/admin/finance"
      });

      res.status(500).json({
        ok: false,
        error:
          "FINANCE_ENTRY_FAILED"
      });
    }
  }
);

app.get(
  "/api/admin/finance",
  requireAdmin,
  async (req, res) => {
    const finance =
      await readFinance();

    res.json({
      ok: true,
      ...finance,
      summary:
        financeSummary(
          finance.transactions
        )
    });
  }
);

app.get(
  "/api/admin/credits",
  requireAdmin,
  async (req, res) => {
    try {
      const summary =
        await creditSummary();

      const fx =
        await getFxRates();

      const providerConfigured =
        Boolean(
          REPLICATE_API_TOKEN
        );

      const providerBlocked =
        !providerConfigured ||
        !await providerCapacityAvailable();

      res.json({
        ok: true,
        mamaki: {
          issued:
            summary.issued,
          consumed:
            summary.consumed,
          refunded:
            summary.refunded,
          remaining:
            summary.remaining,
          balances:
            summary.balances,
          usableCredits:
            providerBlocked
              ? 0
              : summary.remaining
        },
        replicate: {
          configured:
            providerConfigured,
          balanceKnown: false,
          balance: 0,
          usable:
            !providerBlocked,
          note:
            providerConfigured
              ? "Replicate does not expose an authoritative provider credit balance through the configured integration. Usable AI capacity is determined by provider availability and billing responses."
              : "Replicate is not configured.",
          fx: {
            usdNgn:
              fx.rates?.NGN ||
              DEFAULT_USD_NGN_RATE,
            live:
              Boolean(fx.live),
            updatedAt:
              fx.updatedAt
          }
        }
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/admin/credits"
      });

      res.status(500).json({
        ok: false,
        error:
          "CREDIT_DASHBOARD_FAILED"
      });
    }
  }
);

async function adminStats() {
  const [
    users,
    usage,
    jobs,
    finance,
    credits
  ] = await Promise.all([
    readUsers(),
    readUsage(),
    readJobs(),
    readFinance(),
    creditSummary()
  ]);

  let aiGenerations = 0;
  let aiSeconds = 0;
  let studioJobs = 0;
  let narrationJobs = 0;

  for (const u of Object.values(
    usage
  )) {
    aiGenerations += Number(
      u.aiGenerations || 0
    );

    aiSeconds += Number(
      u.aiSeconds || 0
    );

    studioJobs += Number(
      u.studioJobs || 0
    );

    narrationJobs += Number(
      u.narrationJobs || 0
    );
  }

  const projectsFile =
    path.join(
      DATA,
      "projects.json"
    );

  const projects =
    await readJson(
      projectsFile,
      []
    );

  const totalProjects =
    Array.isArray(projects)
      ? projects.length
      : 0;

  const now = Date.now();

  const today =
    users.filter(
      (u) =>
        now -
          Date.parse(
            u.createdAt || 0
          ) <
        86400000
    ).length;

  const week =
    users.filter(
      (u) =>
        now -
          Date.parse(
            u.createdAt || 0
          ) <
        7 * 86400000
    ).length;

  const month =
    users.filter(
      (u) =>
        now -
          Date.parse(
            u.createdAt || 0
          ) <
        30 * 86400000
    ).length;

  const active =
    users.filter(
      (u) =>
        !u.disabled &&
        u.lastActiveAt &&
        now -
          Date.parse(
            u.lastActiveAt
          ) <
        15 * 60000
    ).length;

  const summary =
    financeSummary(
      finance.transactions
    );

  return {
    totalUsers:
      users.length,
    activeUsers:
      active,
    newToday:
      today,
    newThisWeek:
      week,
    newThisMonth:
      month,
    totalAdmins:
      users.filter(
        (u) =>
          u.role === "admin"
      ).length,
    aiGenerations,
    aiSeconds,
    narrationJobs,
    studioJobs,
    totalProjects,
    totalJobs:
      jobs.length,
    completedJobs:
      jobs.filter(
        (j) =>
          j.status ===
          "completed"
      ).length,
    processingJobs:
      jobs.filter((j) =>
        [
          "queued",
          "processing"
        ].includes(
          j.status
        )
      ).length,
    failedJobs:
      jobs.filter(
        (j) =>
          j.status === "failed"
      ).length,
    credits,
    finance:
      summary,
    recoveryConfigured:
      Boolean(
        RESEND_API_KEY &&
          RESEND_FROM
      ),
    uptime:
      process.uptime(),
    version:
      VERSION
  };
}

app.get(
  "/api/admin/stats",
  requireAdmin,
  async (req, res) => {
    try {
      res.json({
        ok: true,
        stats:
          await adminStats()
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/admin/stats"
      });

      res.status(500).json({
        ok: false,
        error:
          "ADMIN_STATS_FAILED"
      });
    }
  }
);

app.get(
  "/api/admin/users",
  requireAdmin,
  async (req, res) => {
    try {
      const [
        users,
        usage
      ] = await Promise.all([
        readUsers(),
        readUsage()
      ]);

      const result = [];

      for (const u of users) {
        const credits =
          await getUserCredits(
            u.id
          );

        result.push({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          disabled:
            Boolean(u.disabled),
          createdAt:
            u.createdAt,
          lastActiveAt:
            u.lastActiveAt,
          credits:
            credits.credits,
          usage:
            usage[u.id] || {
              aiGenerations: 0,
              aiSeconds: 0,
              studioJobs: 0,
              narrationJobs: 0
            }
        });
      }

      res.json({
        ok: true,
        users: result
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/admin/users"
      });

      res.status(500).json({
        ok: false,
        error:
          "ADMIN_USERS_FAILED"
      });
    }
  }
);

app.get(
  "/api/admin/jobs",
  requireAdmin,
  async (req, res) => {
    try {
      const jobs =
        await readJobs();

      res.json({
        ok: true,
        jobs:
          jobs
            .slice()
            .reverse()
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/admin/jobs"
      });

      res.status(500).json({
        ok: false,
        error:
          "ADMIN_JOBS_FAILED"
      });
    }
  }
);

app.get(
  "/api/admin/errors",
  requireAdmin,
  async (req, res) => {
    try {
      const errors =
        await readErrors();

      res.json({
        ok: true,
        errors:
          errors
            .slice()
            .reverse()
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error:
          "ADMIN_ERRORS_FAILED"
      });
    }
  }
);

app.get(
  "/api/admin/security",
  requireAdmin,
  async (req, res) => {
    try {
      const events =
        await readSecurity();

      res.json({
        ok: true,
        events:
          events
            .slice()
            .reverse()
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error:
          "ADMIN_SECURITY_FAILED"
      });
    }
  }
);

app.get(
  "/api/admin/health",
  requireAdmin,
  async (req, res) => {
    const provider =
      Boolean(
        REPLICATE_API_TOKEN
      );

    const providerUsable =
      provider &&
      await providerCapacityAvailable();

    res.json({
      ok: true,
      version:
        VERSION,
      provider: {
        replicateConfigured:
          provider,
        t2v:
          T2V_MODEL,
        i2v:
          I2V_MODEL,
        usable:
          providerUsable
      },
      system: {
        uptime:
          process.uptime(),
        ffmpeg:
          Boolean(ffmpegPath),
        recoveryConfigured:
          Boolean(
            RESEND_API_KEY &&
              RESEND_FROM
          ),
        server: true,
        authentication: true,
        storage: true
      }
    });
  }
);

app.get(
  "/api/projects",
  requireUser,
  async (req, res) => {
    try {
      const file =
        path.join(
          DATA,
          "projects.json"
        );

      const projects =
        await readJson(
          file,
          []
        );

      const mine =
        Array.isArray(projects)
          ? projects.filter(
              (p) =>
                p.userId ===
                req.user.id
            )
          : [];

      res.json({
        ok: true,
        projects:
          mine.reverse()
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/projects",
        userId:
          req.user.id
      });

      res.status(500).json({
        ok: false,
        error:
          "PROJECTS_FAILED"
      });
    }
  }
);

app.post(
  "/api/projects",
  requireUser,
  async (req, res) => {
    try {
      const file =
        path.join(
          DATA,
          "projects.json"
        );

      const projects =
        await readJson(
          file,
          []
        );

      const project = {
        id: randomUUID(),
        userId:
          req.user.id,
        name:
          cleanText(
            req.body?.name ||
              "Untitled MAMAKI Production",
            200
          ),
        description:
          cleanText(
            req.body?.description,
            2000
          ),
        videoUrl:
          cleanText(
            req.body?.videoUrl,
            2000
          ),
        createdAt:
          new Date().toISOString(),
        updatedAt:
          new Date().toISOString()
      };

      projects.push(project);

      await writeJson(
        file,
        projects
      );

      res.json({
        ok: true,
        project
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/projects/create",
        userId:
          req.user.id
      });

      res.status(500).json({
        ok: false,
        error:
          "PROJECT_CREATE_FAILED"
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
          DATA,
          "projects.json"
        );

      const projects =
        await readJson(
          file,
          []
        );

      const filtered =
        Array.isArray(projects)
          ? projects.filter(
              (p) =>
                !(
                  p.id ===
                    req.params.id &&
                  p.userId ===
                    req.user.id
                )
            )
          : [];

      await writeJson(
        file,
        filtered
      );

      res.json({
        ok: true
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error:
          "PROJECT_DELETE_FAILED"
      });
    }
  }
);

app.post(
  "/api/studio/narration",
  requireUser,
  async (req, res) => {
    const text =
      cleanText(
        req.body?.text,
        30000
      );

    if (!text) {
      return res.status(400).json({
        ok: false,
        error:
          "TEXT_REQUIRED"
      });
    }

    try {
      const voice =
        cleanText(
          req.body?.voice ||
            "en-US-AriaNeural",
          100
        );

      const audioPath =
        path.join(
          OUTPUTS,
          `${randomUUID()}.mp3`
        );

      const tts =
        new EdgeTTS({
          voice
        });

      await tts.synthesize(
        text,
        audioPath
      );

      await addUsage(
        req.user.id,
        "narrationJobs",
        1
      );

      res.json({
        ok: true,
        output:
          `/outputs/${path.basename(
            audioPath
          )}`
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/studio/narration",
        userId:
          req.user.id
      });

      res.status(500).json({
        ok: false,
        error:
          "NARRATION_FAILED",
        message:
          e.message
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
        !req.files.length
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "VIDEOS_REQUIRED"
        });
      }

      const list = [];

      for (const file of req.files) {
        const p =
          path.join(
            TMP,
            `${randomUUID()}-${file.originalname}`
          );

        await fs.writeFile(
          p,
          file.buffer
        );

        list.push(p);
      }

      const concat =
        path.join(
          TMP,
          `${randomUUID()}.txt`
        );

      await fs.writeFile(
        concat,
        list
          .map(
            (p) =>
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

      await runFfmpeg([
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concat,
        "-c",
        "copy",
        output
      ]);

      await addUsage(
        req.user.id,
        "studioJobs",
        1
      );

      res.json({
        ok: true,
        output:
          `/outputs/${path.basename(
            output
          )}`
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/studio/combine",
        userId:
          req.user.id
      });

      res.status(500).json({
        ok: false,
        error:
          "COMBINE_FAILED",
        message:
          e.message
      });
    }
  }
);

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
            req.body?.start || 0
          )
        );

      const duration =
        Math.max(
          0.1,
          Number(
            req.body?.duration ||
              5
          )
        );

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

      await runFfmpeg([
        "-y",
        "-ss",
        String(start),
        "-i",
        input,
        "-t",
        String(duration),
        "-c",
        "copy",
        output
      ]);

      await addUsage(
        req.user.id,
        "studioJobs",
        1
      );

      res.json({
        ok: true,
        output:
          `/outputs/${path.basename(
            output
          )}`
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/studio/trim",
        userId:
          req.user.id
      });

      res.status(500).json({
        ok: false,
        error:
          "TRIM_FAILED",
        message:
          e.message
      });
    }
  }
);

app.post(
  "/api/studio/subtitles",
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

      const subtitles =
        cleanText(
          req.body?.subtitles,
          30000
        );

      if (!subtitles) {
        return res.status(400).json({
          ok: false,
          error:
            "SUBTITLES_REQUIRED"
        });
      }

      const input =
        path.join(
          TMP,
          `${randomUUID()}.mp4`
        );

      const srt =
        path.join(
          TMP,
          `${randomUUID()}.srt`
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

      await fs.writeFile(
        srt,
        subtitles
      );

      const escaped =
        srt
          .replace(/\\/g, "\\\\")
          .replace(/:/g, "\\:");

      await runFfmpeg([
        "-y",
        "-i",
        input,
        "-vf",
        `subtitles=${escaped}`,
        "-c:a",
        "copy",
        output
      ]);

      await addUsage(
        req.user.id,
        "studioJobs",
        1
      );

      res.json({
        ok: true,
        output:
          `/outputs/${path.basename(
            output
          )}`
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/studio/subtitles",
        userId:
          req.user.id
      });

      res.status(500).json({
        ok: false,
        error:
          "SUBTITLE_FAILED",
        message:
          e.message
      });
    }
  }
);

app.post(
  "/api/studio/social",
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

      const ratio =
        normalizeRatio(
          req.body?.ratio
        );

      const size =
        RATIOS[ratio];

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

      await runFfmpeg([
        "-y",
        "-i",
        input,
        "-vf",
        `scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2`,
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        output
      ]);

      await addUsage(
        req.user.id,
        "studioJobs",
        1
      );

      res.json({
        ok: true,
        output:
          `/outputs/${path.basename(
            output
          )}`
      });
    } catch (e) {
      await recordError(e, {
        route:
          "/api/studio/social",
        userId:
          req.user.id
      });

      res.status(500).json({
        ok: false,
        error:
          "SOCIAL_EXPORT_FAILED",
        message:
          e.message
      });
    }
  }
);

app.get("/", async (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="theme-color" content="#050509">
<meta name="description" content="MAMAKI AI — Intelligent AI Video Creative Studio">
<title>MAMAKI AI — Intelligent AI Video Creative Studio</title>
<style>
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:#050509;color:#f7f7fb;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button,input,select,textarea{font:inherit}
button{cursor:pointer}
a{color:inherit}
.container{width:min(1180px,92%);margin:auto}
nav{position:sticky;top:0;z-index:20;background:rgba(5,5,9,.92);backdrop-filter:blur(18px);border-bottom:1px solid #222}
.nav{min-height:68px;display:flex;align-items:center;justify-content:space-between;gap:15px}
.brand{font-size:20px;font-weight:900;letter-spacing:.4px}
.brand span{opacity:.7}
.navlinks{display:flex;gap:8px;flex-wrap:wrap}
.navlinks button,.navlinks a{border:1px solid #2b2b35;background:#11111a;color:#fff;padding:9px 13px;border-radius:10px;text-decoration:none}
.hero{padding:80px 0 45px}
.hero h1{font-size:clamp(38px,7vw,76px);line-height:.98;margin:0 0 20px}
.hero p{max-width:760px;color:#aaaab8;font-size:18px;line-height:1.7}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.two{grid-template-columns:repeat(2,1fr)}
.card{background:#0d0d15;border:1px solid #242430;border-radius:18px;padding:22px}
.card h2,.card h3{margin-top:0}
.muted{color:#9292a3}
.section{padding:28px 0}
label{display:block;color:#bbb;margin:14px 0 7px}
input,select,textarea{width:100%;background:#08080e;color:#fff;border:1px solid #30303d;border-radius:10px;padding:12px}
textarea{min-height:150px;resize:vertical}
.btn{border:0;border-radius:11px;padding:12px 18px;background:#fff;color:#08080e;font-weight:800}
.btn.alt{background:#171722;color:#fff;border:1px solid #343443}
.btn.danger{background:#6d1820;color:#fff}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:15px}
.pill{display:inline-block;padding:5px 9px;border-radius:999px;background:#181822;color:#ddd;font-size:12px}
.status{padding:12px;border-radius:12px;background:#11111a;border:1px solid #282833;margin-top:15px}
footer{padding:50px 0;color:#777;border-top:1px solid #222}
.hidden{display:none!important}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;display:flex;align-items:center;justify-content:center;padding:20px}
.modalbox{width:min(480px,100%);background:#0d0d15;border:1px solid #30303b;border-radius:18px;padding:25px}
.package{border:1px solid #30303b;border-radius:15px;padding:18px}
.package strong{font-size:25px}
@media(max-width:800px){.grid,.two{grid-template-columns:1fr}.nav{align-items:flex-start;padding:12px 0}.hero{padding-top:50px}}
</style>
</head>
<body>
<nav>
<div class="container nav">
<div class="brand">✨MAMAKI AI <span>Video Studio</span></div>
<div class="navlinks">
<a href="#create">Create</a>
<a href="#projects">Projects</a>
<a href="#studio">Free Studio</a>
<button onclick="openAuth()">Account</button>
<button onclick="openBilling()">Credits</button>
</div>
</div>
</nav>

<main>
<section class="hero container" id="create">
<div class="pill">✨ Intelligent creative production platform</div>
<h1>Create with MAMAKI AI</h1>
<p>Turn ideas, scripts and images into professional video productions with AI generation, creative tools, narration, subtitles and social-ready exports.</p>

<div class="card">
<h2>🎬 AI Video Studio</h2>
<p class="muted">Build a production with MAMAKI's AI Director.</p>

<div class="actions">
<button class="btn alt" onclick="setMode('text')">✍️ Text → Video</button>
<button class="btn alt" onclick="setMode('image')">🖼️ Image → Video</button>
</div>

<label>Describe your video</label>
<textarea id="prompt" placeholder="Describe the scene, subject, camera movement, lighting and atmosphere..."></textarea>

<div class="actions">
<button class="btn alt" onclick="enhance()">✨ AI Enhance Prompt</button>
<button class="btn alt" onclick="document.getElementById('prompt').value=''">Clear</button>
</div>

<div class="grid two">
<div>
<label>Visual Style</label>
<select id="style">
${STYLES.map((x)=>`<option>${x}</option>`).join("")}
</select>
</div>
<div>
<label>Production Duration</label>
<select id="duration">
<option value="5">5 seconds</option>
<option value="10">10 seconds</option>
<option value="15">15 seconds</option>
<option value="20">20 seconds</option>
<option value="30">30 seconds</option>
<option value="60">1 minute</option>
<option value="120">2 minutes</option>
<option value="300">5 minutes</option>
<option value="600">10 minutes</option>
<option value="1800">30 minutes</option>
<option value="3600">1 hour</option>
<option value="7200">2 hours</option>
</select>
</div>
<div>
<label>Aspect Ratio</label>
<select id="ratio">
<option>16:9</option>
<option>9:16</option>
<option>1:1</option>
</select>
</div>
<div>
<label>Quality</label>
<select id="quality">
<option>Standard HD</option>
<option>High</option>
<option>Cinematic</option>
</select>
</div>
</div>

<label>Reference Image</label>
<p class="muted">Used for Image → Video or as the first scene reference.</p>
<input id="image" type="file" accept="image/*">

<div class="actions">
<button class="btn" onclick="generate()">✨ Generate AI Video</button>
<button class="btn alt" onclick="openBilling()">💳 Buy Credits</button>
</div>
<div id="generationStatus" class="status hidden"></div>
</div>
</section>

<section class="section container">
<div class="card">
<h2>🤖 MAMAKI Autopilot</h2>
<p><strong>Ready</strong></p>
<p class="muted">MAMAKI automatically manages the production pipeline after you submit your idea.</p>
<div class="grid">
<div><h3>🧠 AI Director</h3><p class="muted">Structures your idea and prepares scene-ready prompts.</p></div>
<div><h3>🎥 AI Generation</h3><p class="muted">Uses your connected AI video generation provider.</p></div>
<div><h3>🎞️ Multi-Scene Production</h3><p class="muted">Long productions are assembled from multiple generated scenes.</p></div>
<div><h3>🎵 Audio</h3><p class="muted">MAMAKI can process production audio through the studio workflow.</p></div>
<div><h3>✨ MAMAKI Branding</h3><p class="muted">Final generated productions receive MAMAKI branding.</p></div>
<div><h3>📁 Personal Projects</h3><p class="muted">Save your productions under your authenticated MAMAKI account.</p></div>
</div>
<div class="status">AI generation requires an active Replicate account/credit. Free Studio tools remain separate from AI generation.</div>
</div>
</section>

<section class="section container" id="projects">
<div class="card">
<h2>📁 My Projects</h2>
<p class="muted">Your saved MAMAKI productions.</p>
<button class="btn alt" onclick="loadProjects()">🔄 Refresh</button>
<div id="projectsList" style="margin-top:18px"></div>
</div>
</section>

<section class="section container" id="studio">
<h2>🛠️ Free Studio</h2>
<p class="muted">Practical video production tools that do not require AI generation.</p>
<div class="grid">
<div class="card"><h3>🖼️ Photo → Video</h3><p class="muted">Turn up to 50 photos into a branded video presentation.</p><button class="btn alt" onclick="alert('Photo → Video studio workflow is available through the production tools.')">Open Tool</button></div>
<div class="card"><h3>✂️ Video Trimmer</h3><p class="muted">Cut a section from an uploaded video.</p><button class="btn alt" onclick="openTool('trim')">Open Tool</button></div>
<div class="card"><h3>🎞️ Combine Videos</h3><p class="muted">Join multiple video clips into one production.</p><button class="btn alt" onclick="openTool('combine')">Open Tool</button></div>
<div class="card"><h3>🎙️ AI Narration</h3><p class="muted">Convert written text into a downloadable narration track.</p><button class="btn alt" onclick="openTool('narration')">Open Tool</button></div>
<div class="card"><h3>💬 Subtitles</h3><p class="muted">Burn SRT or compatible subtitle text directly into a video.</p><button class="btn alt" onclick="openTool('subtitles')">Open Tool</button></div>
<div class="card"><h3>📱 Social Export</h3><p class="muted">Prepare videos for landscape, vertical or square platforms.</p><button class="btn alt" onclick="openTool('social')">Open Tool</button></div>
</div>
</section>

<section class="section container">
<div class="card">
<h2>✨ MAMAKI Platform</h2>
<p class="muted">Built around the production workflow rather than a single AI button.</p>
<div class="grid">
<div><h3>🎬 AI Video Creation</h3><p class="muted">Text-to-video and image-to-video production through the connected AI engine.</p></div>
<div><h3>🤖 Autopilot Director</h3><p class="muted">Multi-scene production and automated assembly for longer projects.</p></div>
<div><h3>🎙️ Voice & Narration</h3><p class="muted">Create downloadable narration audio using the configured voice service.</p></div>
<div><h3>💬 Subtitles</h3><p class="muted">Burn subtitle text into uploaded videos through FFmpeg processing.</p></div>
<div><h3>📱 Social Presets</h3><p class="muted">Create landscape, vertical and square versions of videos.</p></div>
<div><h3>📁 Projects</h3><p class="muted">Save, preview, open, download and delete your personal project records.</p></div>
<div><h3>🔐 Accounts</h3><p class="muted">Personal authentication and user-specific project access.</p></div>
<div><h3>✨ MAMAKI Branding</h3><p class="muted">Studio and AI outputs can receive the MAMAKI watermark.</p></div>
</div>
</div>
</section>
</main>

<footer>
<div class="container">✨ MAMAKI AI Video Studio · Intelligent creative production platform</div>
</footer>

<div id="authModal" class="modal hidden">
<div class="modalbox">
<h2>👤 MAMAKI Account</h2>
<div class="actions">
<button class="btn alt" onclick="authMode('login')">Login</button>
<button class="btn alt" onclick="authMode('register')">Create Account</button>
</div>
<input id="authName" class="hidden" placeholder="Name">
<input id="authEmail" placeholder="Email">
<input id="authPassword" type="password" placeholder="Password">
<div class="actions">
<button class="btn" onclick="submitAuth()">Continue</button>
<button class="btn alt" onclick="closeAuth()">Close</button>
</div>
<p id="authMsg" class="muted"></p>
</div>
</div>

<div id="billingModal" class="modal hidden">
<div class="modalbox">
<h2>💳 MAMAKI Credits</h2>
<p>Your credits: <strong id="myCredits">0</strong></p>
<div id="packages"></div>
<div class="actions"><button class="btn alt" onclick="closeBilling()">Close</button></div>
<p id="billingMsg" class="muted"></p>
</div>
</div>

<div id="toolModal" class="modal hidden">
<div class="modalbox">
<h2 id="toolTitle">Free Studio</h2>
<div id="toolBody"></div>
<div class="actions"><button class="btn alt" onclick="closeTool()">Close</button></div>
</div>
</div>

<script>
let token=localStorage.getItem("mamaki_token")||"";
let authAction="login";
let mode="text";

const $=id=>document.getElementById(id);

function esc(v){
 return String(v??"").replace(/[&<>"']/g,m=>({
 "&":"&amp;",
 "<":"&lt;",
 ">":"&gt;",
 '"':"&quot;",
 "'":"&#39;"
 }[m]));
}

function setMode(v){
 mode=v;
 $("image").required=v==="image";
}

function openAuth(){
 $("authModal").classList.remove("hidden");
 authMode(token?"login":"login");
}

function closeAuth(){
 $("authModal").classList.add("hidden");
}

function authMode(v){
 authAction=v;
 $("authName").classList.toggle("hidden",v!=="register");
 $("authMsg").textContent="";
}

async function submitAuth(){
 try{
  const body={
   email:$("authEmail").value,
   password:$("authPassword").value
  };

  if(authAction==="register"){
   body.name=$("authName").value;
  }

  const endpoint=
   authAction==="register"
    ?"/api/auth/register"
    :"/api/auth/login";

  const r=await fetch(endpoint,{
   method:"POST",
   headers:{"Content-Type":"application/json"},
   body:JSON.stringify(body)
  });

  const d=await r.json();

  if(!r.ok||!d.ok)
   throw new Error(d.message||d.error||"Authentication failed.");

  token=d.token;
  localStorage.setItem("mamaki_token",token);
  $("authMsg").textContent="Signed in successfully.";
  closeAuth();
  loadProjects();
 }catch(e){
  $("authMsg").textContent=e.message;
 }
}

async function api(url,options={}){
 const headers=Object.assign(
  {},
  options.headers||{},
  token?{Authorization:"Bearer "+token}:{}
 );

 const r=await fetch(url,Object.assign({},options,{headers}));
 const d=await r.json();

 if(!r.ok)
  throw new Error(d.message||d.error||"Request failed.");

 return d;
}

function enhance(){
 const p=$("prompt").value.trim();

 if(!p)return;

 $("prompt").value=
  p+
  " Cinematic professional production, coherent subject continuity, natural movement, detailed environment, professional lighting and camera work.";
}

async function generate(){
 if(!token){
  openAuth();
  return;
 }

 const prompt=$("prompt").value.trim();

 if(!prompt){
  $("generationStatus").classList.remove("hidden");
  $("generationStatus").textContent="Please describe your video first.";
  return;
 }

 const form=new FormData();

 form.append("prompt",prompt);
 form.append("duration",$("duration").value);
 form.append("ratio",$("ratio").value);
 form.append("quality",$("quality").value);
 form.append("style",$("style").value);

 if($("image").files[0])
  form.append("image",$("image").files[0]);

 $("generationStatus").classList.remove("hidden");
 $("generationStatus").textContent="MAMAKI is preparing your production...";

 try{
  const r=await fetch("/api/generate",{
   method:"POST",
   headers:token?{Authorization:"Bearer "+token}:{},
   body:form
  });

  const d=await r.json();

  if(!r.ok||!d.ok)
   throw new Error(d.message||d.error||"Generation failed.");

  $("generationStatus").innerHTML=
   "Production complete. <a href='"+esc(d.job.output)+"' target='_blank'>Open video</a>";

  loadProjects();
 }catch(e){
  $("generationStatus").textContent=e.message;
 }
}

async function loadProjects(){
 if(!token)return;

 try{
  const d=await api("/api/projects");

  const list=d.projects||[];

  $("projectsList").innerHTML=
   list.length
    ?list.map(p=>`
     <div class="card" style="margin-top:12px">
      <h3>${esc(p.name)}</h3>
      <p class="muted">${esc(p.description||"")}</p>
      ${p.videoUrl?`<a class="btn" href="${esc(p.videoUrl)}" target="_blank">Open Production</a>`:""}
      <button class="btn danger" onclick="deleteProject('${esc(p.id)}')">Delete</button>
     </div>
    `).join("")
    :'<p class="muted">No projects yet. Generate a video and save it here.</p>';
 }catch{}
}

async function deleteProject(id){
 try{
  await api("/api/projects/"+encodeURIComponent(id),{
   method:"DELETE"
  });

  loadProjects();
 }catch(e){
  alert(e.message);
 }
}

async function openBilling(){
 $("billingModal").classList.remove("hidden");

 try{
  const d=await api("/api/account/billing?currency=NGN");

  $("myCredits").textContent=d.credits.credits;

  $("packages").innerHTML=(d.pricing||[]).map(p=>`
   <div class="package" style="margin-top:10px">
    <strong>${p.credits.toLocaleString()} Credits</strong>
    <p>₦${Number(p.amount).toLocaleString()} · FX ₦${Number(p.fxRate).toFixed(2)}/$1</p>
    <button class="btn" onclick="buyCredits(${p.credits})">
     Buy Credits
    </button>
   </div>
  `).join("");

  $("billingMsg").textContent=
   d.paymentsConfigured
    ?"Automatic payment is available."
    :"Payments are not configured yet.";
 }catch(e){
  $("billingMsg").textContent=e.message;
 }
}

function closeBilling(){
 $("billingModal").classList.add("hidden");
}

async function buyCredits(credits){
 try{
  const d=await api("/api/billing/paystack/initialize",{
   method:"POST",
   headers:{"Content-Type":"application/json"},
   body:JSON.stringify({
    credits,
    currency:"NGN"
   })
  });

  if(d.authorizationUrl)
   location.href=d.authorizationUrl;
 }catch(e){
  $("billingMsg").textContent=e.message;
 }
}

function openTool(type){
 $("toolModal").classList.remove("hidden");

 const titles={
  trim:"✂️ Video Trimmer",
  combine:"🎞️ Combine Videos",
  narration:"🎙️ AI Narration",
  subtitles:"💬 Subtitles",
  social:"📱 Social Export"
 };

 $("toolTitle").textContent=titles[type]||"Free Studio";

 if(type==="narration"){
  $("toolBody").innerHTML=`
   <textarea id="toolText" placeholder="Enter narration text..."></textarea>
   <label>Voice</label>
   <input id="toolVoice" value="en-US-AriaNeural">
   <div class="actions"><button class="btn" onclick="runNarration()">Create Narration</button></div>
  `;
 }else{
  $("toolBody").innerHTML=
   "<p class='muted'>Upload and processing controls for this studio tool are available through the MAMAKI production workflow.</p>";
 }
}

function closeTool(){
 $("toolModal").classList.add("hidden");
}

async function runNarration(){
 try{
  const d=await api("/api/studio/narration",{
   method:"POST",
   headers:{"Content-Type":"application/json"},
   body:JSON.stringify({
    text:$("toolText").value,
    voice:$("toolVoice").value
   })
  });

  $("toolBody").innerHTML+=
   `<p><a class="btn" href="${esc(d.output)}" target="_blank">Download Narration</a></p>`;
 }catch(e){
  alert(e.message);
 }
}

if(location.search.includes("payment=complete")){
 setTimeout(()=>{
  if(token)openBilling();
 },1000);
}

loadProjects();
</script>
</body>
</html>`);
});

app.get("/admin", async (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#050509">
<title>MAMAKI AI — Administrator Control Center</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#06060a;color:#f5f5f8;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:min(1500px,94%);margin:auto;padding:30px 0 70px}
h1,h2,h3{margin-top:0}
.muted{color:#9292a3}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.card{background:#0e0e16;border:1px solid #252530;border-radius:16px;padding:18px}
.value{font-size:28px;font-weight:900;margin-top:8px}
header{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:25px}
button{background:#fff;color:#08080b;border:0;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer}
button.alt{background:#171720;color:#fff;border:1px solid #343442}
button.danger{background:#711820;color:#fff}
input,select{width:100%;background:#08080e;color:#fff;border:1px solid #30303d;border-radius:9px;padding:11px}
.formrow{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;align-items:end}
.scroll{overflow:auto}
table{width:100%;border-collapse:collapse;min-width:700px}
th,td{padding:11px;border-bottom:1px solid #24242f;text-align:left;vertical-align:top;font-size:13px}
th{color:#aaa}
.badge{display:inline-block;padding:4px 8px;border-radius:999px;background:#171720}
.hidden{display:none!important}
.login{width:min(430px,100%);margin:90px auto}
.actions{display:flex;gap:10px;flex-wrap:wrap}
section{margin-top:25px}
.small{font-size:12px}
@media(max-width:1000px){.grid{grid-template-columns:repeat(2,1fr)}.grid3{grid-template-columns:1fr 1fr}.formrow{grid-template-columns:1fr 1fr}}
@media(max-width:650px){.grid,.grid3,.formrow{grid-template-columns:1fr}}
</style>
</head>
<body>
<main>
<section id="login" class="login card">
<h1>✨ MAMAKI AI</h1>
<p class="muted">Private Administrator Control Center · v${VERSION}</p>
<input id="email" placeholder="Administrator email">
<input id="password" type="password" placeholder="Administrator password" style="margin-top:10px">
<div class="actions" style="margin-top:12px">
<button onclick="login()">Administrator Login</button>
</div>
<p id="msg" class="muted"></p>
</section>

<section id="dash" class="hidden">
<header>
<div>
<h1>✨ MAMAKI AI</h1>
<p class="muted">Administrator Control Center · Private · v${VERSION}</p>
</div>
<div class="actions" id="actions">
<button class="alt" onclick="loadAll()">Refresh Dashboard</button>
<button class="danger" onclick="logout()">Logout</button>
</div>
</header>

<section>
<h2>Overview</h2>
<div class="grid">
<div class="card">Total Users<div id="users" class="value">0</div></div>
<div class="card">Live / Active<div id="active" class="value">0</div></div>
<div class="card">New Today<div id="today" class="value">0</div></div>
<div class="card">New This Week<div id="week" class="value">0</div></div>
<div class="card">New This Month<div id="month" class="value">0</div></div>
<div class="card">Total Admins<div id="admins" class="value">0</div></div>
<div class="card">Videos Generated<div id="videos" class="value">0</div></div>
<div class="card">AI Seconds<div id="seconds" class="value">0</div></div>
<div class="card">Narrations<div id="narrations" class="value">0</div></div>
<div class="card">Projects<div id="projects" class="value">0</div></div>
<div class="card">Completed Jobs<div id="completed" class="value">0</div></div>
<div class="card">Processing Jobs<div id="processing" class="value">0</div></div>
<div class="card">Failed Jobs<div id="failed" class="value">0</div></div>
<div class="card">MAMAKI Credits<div id="credits" class="value">0</div></div>
<div class="card">Usable AI Credits<div id="usable" class="value">0</div></div>
<div class="card">Profit NGN<div id="profit" class="value">₦0</div></div>
</div>
</section>

<section>
<h2>💳 MAMAKI Credits</h2>
<div class="grid">
<div class="card">Credits Issued<div id="issued" class="value">0</div></div>
<div class="card">Credits Consumed<div id="consumed" class="value">0</div></div>
<div class="card">Credits Refunded<div id="crefund" class="value">0</div></div>
<div class="card">Credits Remaining<div id="cremaining" class="value">0</div></div>
</div>
<div class="card" style="margin-top:14px">
<h3>Manual User Credit Adjustment</h3>
<div class="formrow">
<div><label>User ID</label><input id="uid" placeholder="User ID"></div>
<div><label>Amount</label><input id="amount" type="number" placeholder="100 or -100"></div>
<div><label>Source</label><select id="csource"><option>MANUAL</option><option>PROMOTIONAL</option><option>FREE</option></select></div>
<div><button onclick="adjustCredits()">Apply</button></div>
</div>
<p id="cmsg" class="muted"></p>
</div>
</section>

<section>
<h2>💵 Replicate & AI Provider</h2>
<div class="grid3">
<div class="card">Replicate Credit<div id="rep" class="value">Unknown</div><p id="repnote" class="muted small"></p></div>
<div class="card">Replicate Status<div id="repstatus" class="value">—</div></div>
<div class="card">AI Availability<div id="aiavail" class="value">—</div></div>
<div class="card">T2V Model<div id="t2v" class="small"></div></div>
<div class="card">I2V Model<div id="i2v" class="small"></div></div>
<div class="card">FX Rate<div id="fx" class="value">—</div><p id="fxnote" class="muted small"></p></div>
</div>
</section>

<section>
<h2>📈 Business & Finance</h2>
<div class="grid">
<div class="card">Gross Revenue<div id="gross" class="value">₦0</div></div>
<div class="card">Refunds<div id="refunds" class="value">₦0</div></div>
<div class="card">Net Revenue<div id="net" class="value">₦0</div></div>
<div class="card">Total Costs<div id="costs" class="value">₦0</div></div>
<div class="card">Profit<div id="profit2" class="value">₦0</div></div>
<div class="card">Profit Margin<div id="margin" class="value">0%</div></div>
<div class="card">Withdrawn<div id="withdrawn" class="value">₦0</div></div>
<div class="card">Available to Withdraw<div id="available" class="value">₦0</div></div>
</div>

<div class="card" style="margin-top:14px">
<h3>Automatic Pricing Engine</h3>
<p class="muted">MAMAKI calculates customer pricing from estimated provider cost, FX, payment-fee protection and the configured target margin. Prices update automatically when the cached FX rate changes.</p>
<p>Target Margin: <strong id="targetmargin">0%</strong></p>
<div class="scroll">
<table>
<thead><tr><th>Credits</th><th>Provider Cost USD</th><th>Customer USD</th><th>NGN Price</th><th>FX</th><th>Margin</th></tr></thead>
<tbody id="pricing"></tbody>
</table>
</div>
</div>

<div class="card" style="margin-top:14px">
<h3>Record Real Financial Transaction</h3>
<div class="formrow">
<div><label>Type</label><select id="ftype"><option>REVENUE</option><option>REFUND</option><option>AI_COST</option><option>INFRASTRUCTURE_COST</option><option>OTHER_COST</option></select></div>
<div><label>Amount NGN</label><input id="famount" type="number" step="0.01" placeholder="0"></div>
<div><label>Description</label><input id="fdesc" placeholder="Description"></div>
<div><button onclick="finance()">Record</button></div>
</div>
<span id="fmsg" class="muted"></span>
</div>

<div class="card" style="margin-top:14px">
<h3>🏦 Owner Profit Withdrawal</h3>
<p class="muted">Withdraw only from recorded available profit. MAMAKI never treats customer credits as owner money.</p>
<div class="formrow">
<div><label>Amount NGN</label><input id="wamount" type="number" step="0.01" placeholder="Amount"></div>
<div><label>Account Name</label><input id="wname" placeholder="Bank account name"></div>
<div><label>Account Number</label><input id="waccount" placeholder="Bank account number"></div>
<div><label>Bank Code</label><input id="wbank" placeholder="Bank code"></div>
</div>
<div class="actions" style="margin-top:12px">
<button onclick="withdraw()">Withdraw Profit</button>
</div>
<p id="wmsg" class="muted"></p>
</div>
</section>

<section>
<h2>👥 Users</h2>
<div class="card scroll">
<table>
<thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Credits</th><th>AI</th><th>AI Seconds</th><th>Studio</th><th>Narration</th><th>Last Active</th><th>Status</th></tr></thead>
<tbody id="utable"></tbody>
</table>
</div>
</section>

<section>
<h2>🎬 Jobs</h2>
<div class="card scroll">
<table>
<thead><tr><th>ID</th><th>User</th><th>Status</th><th>Progress</th><th>Duration</th><th>Credits</th><th>Message</th><th>Created</th></tr></thead>
<tbody id="jobs"></tbody>
</table>
</div>
</section>

<section>
<h2>🔐 Security Activity</h2>
<div class="card scroll">
<table>
<thead><tr><th>Time</th><th>Event</th><th>Email</th><th>User</th><th>Method</th></tr></thead>
<tbody id="security"></tbody>
</table>
</div>
</section>

<section>
<h2>⚠️ Errors</h2>
<div class="card scroll">
<table>
<thead><tr><th>Time</th><th>Code</th><th>Message</th><th>Route</th></tr></thead>
<tbody id="errors"></tbody>
</table>
</div>
</section>

<section>
<h2>💳 Financial Transactions</h2>
<div class="card scroll">
<table>
<thead><tr><th>Time</th><th>Type</th><th>Amount</th><th>Description</th></tr></thead>
<tbody id="fin"></tbody>
</table>
</div>
</section>

<section>
<h2>💰 Customer Payments</h2>
<div class="card scroll">
<table>
<thead><tr><th>Time</th><th>Reference</th><th>User</th><th>Credits</th><th>Amount</th><th>Status</th></tr></thead>
<tbody id="payments"></tbody>
</table>
</div>
</section>

<section>
<h2>🏦 Withdrawal History</h2>
<div class="card scroll">
<table>
<thead><tr><th>Time</th><th>Reference</th><th>Amount</th><th>Account</th><th>Status</th></tr></thead>
<tbody id="withdrawals"></tbody>
</table>
</div>
</section>
</section>
</main>

<script>
let token=localStorage.getItem("mamaki_admin_token")||"";
const $=x=>document.getElementById(x);

function hdr(){
 return token
  ?{Authorization:"Bearer "+token}
  :{};
}

async function get(url){
 const r=await fetch(url,{headers:hdr()});
 const d=await r.json();

 if(!r.ok)
  throw new Error(d.message||d.error||"Request failed");

 return d;
}

function esc(v){
 return String(v??"").replace(/[&<>"']/g,m=>({
  "&":"&amp;",
  "<":"&lt;",
  ">":"&gt;",
  '"':"&quot;",
  "'":"&#39;"
 }[m]||m));
}

function money(n){
 return "₦"+Number(n||0).toLocaleString(undefined,{
  maximumFractionDigits:2
 });
}

function dt(v){
 if(!v)return "—";

 const d=new Date(v);

 return Number.isNaN(d.getTime())
  ?esc(v)
  :d.toLocaleString();
}

function set(id,v){
 const el=$(id);
 if(el)el.textContent=v;
}

async function login(){
 try{
  const r=await fetch("/api/admin/login",{
   method:"POST",
   headers:{"Content-Type":"application/json"},
   body:JSON.stringify({
    email:$("email").value,
    password:$("password").value
   })
  });

  const d=await r.json();

  if(!r.ok||!d.ok)
   throw new Error(d.message||"Invalid credentials");

  token=d.token;
  localStorage.setItem(
   "mamaki_admin_token",
   token
  );

  $("login").classList.add("hidden");
  $("dash").classList.remove("hidden");

  loadAll();
 }catch(e){
  $("msg").textContent=e.message;
 }
}

async function logout(){
 try{
  await fetch("/api/auth/logout",{
   method:"POST",
   headers:hdr()
  });
 }catch{}

 localStorage.removeItem(
  "mamaki_admin_token"
 );

 location.reload();
}

async function loadAll(){
 if(!token)return;

 try{
  const [
   s,
   u,
   j,
   e,
   sec,
   c,
   f,
   b
  ]=await Promise.all([
   get("/api/admin/stats"),
   get("/api/admin/users"),
   get("/api/admin/jobs"),
   get("/api/admin/errors"),
   get("/api/admin/security"),
   get("/api/admin/credits"),
   get("/api/admin/finance"),
   get("/api/admin/billing")
  ]);

  const st=s.stats;
  const users=u.users||[];

  set("users",st.totalUsers);
  set("active",st.activeUsers);
  set("today",st.newToday);
  set("week",st.newThisWeek);
  set("month",st.newThisMonth);
  set("admins",st.totalAdmins);
  set("videos",st.aiGenerations);
  set("seconds",st.aiSeconds);
  set("narrations",st.narrationJobs);
  set("projects",st.totalProjects);
  set("completed",st.completedJobs);
  set("processing",st.processingJobs);
  set("failed",st.failedJobs);

  set("gross",money(b.wallet.grossRevenue));
  set("refunds",money(b.wallet.refunds));
  set("net",money(b.wallet.netRevenue));
  set("costs",money(b.wallet.costs));
  set("profit",money(b.wallet.profit));
  set("profit2",money(b.wallet.profit));
  set("withdrawn",money(b.wallet.withdrawn));
  set("available",money(b.wallet.availableToWithdraw));
  set("margin",Number(b.wallet.profitMargin||0).toFixed(2)+"%");

  set("fx",
   b.fx?.rates?.NGN
    ?"₦"+Number(b.fx.rates.NGN).toFixed(2)
    :"—"
  );

  set(
   "fxnote",
   (b.fx?.live?"Live FX rate":"Fallback FX rate")+
   " · "+dt(b.fx?.updatedAt)
  );

  set(
   "targetmargin",
   (Number(
    b.pricing?.[0]?.marginTarget||0
   )*100).toFixed(0)+"%"
  );

  set(
   "issued",
   c.mamaki.issued
  );

  set(
   "consumed",
   c.mamaki.consumed
  );

  set(
   "crefund",
   c.mamaki.refunded
  );

  set(
   "cremaining",
   c.mamaki.remaining
  );

  set(
   "credits",
   c.mamaki.remaining
  );

  set(
   "usable",
   c.mamaki.usableCredits
  );

  set(
   "rep",
   c.replicate.balanceKnown
    ?"$"+Number(
      c.replicate.balance||0
     ).toFixed(2)
    :"Unknown"
  );

  set(
   "repnote",
   c.replicate.note||
   "No authoritative provider balance available."
  );

  set(
   "repstatus",
   c.replicate.configured
    ?"Configured"
    :"Not configured"
  );

  set(
   "aiavail",
   c.replicate.usable
    ?"Ready"
    :"Blocked / unavailable"
  );

  set(
   "t2v",
   "${T2V_MODEL}"
  );

  set(
   "i2v",
   "${I2V_MODEL}"
  );

  const jobs=j.jobs||[];

  $("utable").innerHTML=
   users.map(x=>`
    <tr>
     <td>${esc(x.name)}</td>
     <td>${esc(x.email)}</td>
     <td>${esc(x.role)}</td>
     <td>${x.credits}</td>
     <td>${Number(x.usage?.aiGenerations||0)}</td>
     <td>${Number(x.usage?.aiSeconds||0)}</td>
     <td>${Number(x.usage?.studioJobs||0)}</td>
     <td>${Number(x.usage?.narrationJobs||0)}</td>
     <td>${dt(x.lastActiveAt)}</td>
     <td>${!x.disabled?"Active":"Disabled"}</td>
    </tr>
   `).join("")
   ||"<tr><td colspan='10'>No users</td></tr>";

  $("jobs").innerHTML=
   jobs.map(x=>`
    <tr>
     <td>${esc(x.id)}</td>
     <td>${esc(x.userId)}</td>
     <td><span class="badge">${esc(x.status)}</span></td>
     <td>${Number(x.progress||0)}%</td>
     <td>${esc(x.duration)}s</td>
     <td>${esc(x.creditCost||x.credits||"—")}</td>
     <td>${esc(x.message||x.error||"")}</td>
     <td>${dt(x.createdAt)}</td>
    </tr>
   `).join("")
   ||"<tr><td colspan='8'>No jobs</td></tr>";

  $("security").innerHTML=
   (sec.events||[]).map(x=>`
    <tr>
     <td>${dt(x.createdAt)}</td>
     <td>${esc(x.type||x.event)}</td>
     <td>${esc(x.email||x.details?.email||"")}</td>
     <td>${esc(x.userId||x.details?.userId||"")}</td>
     <td>${esc(x.method||x.details?.method||"")}</td>
    </tr>
   `).join("")
   ||"<tr><td colspan='5'>No security events</td></tr>";

  $("errors").innerHTML=
   (e.errors||[]).map(x=>`
    <tr>
     <td>${dt(x.createdAt)}</td>
     <td>${esc(x.code)}</td>
     <td>${esc(x.message)}</td>
     <td>${esc(x.context?.route||"")}</td>
    </tr>
   `).join("")
   ||"<tr><td colspan='4'>No errors</td></tr>";

  $("fin").innerHTML=
   (f.transactions||[]).map(x=>`
    <tr>
     <td>${dt(x.createdAt)}</td>
     <td>${esc(x.type)}</td>
     <td>${money(x.amount)}</td>
     <td>${esc(x.description)}</td>
    </tr>
   `).join("")
   ||"<tr><td colspan='4'>No transactions</td></tr>";

  $("pricing").innerHTML=
   (b.pricing||[]).map(x=>`
    <tr>
     <td>${Number(x.credits).toLocaleString()}</td>
     <td>$${Number(x.providerCostUsd).toFixed(4)}</td>
     <td>$${Number(x.usdPrice).toFixed(2)}</td>
     <td>${money(x.amount)}</td>
     <td>${Number(x.fxRate).toFixed(2)}</td>
     <td>${Number(x.marginTarget*100).toFixed(0)}%</td>
    </tr>
   `).join("");

  $("payments").innerHTML=
   (b.payments||[]).map(x=>`
    <tr>
     <td>${dt(x.createdAt)}</td>
     <td>${esc(x.reference)}</td>
     <td>${esc(x.userId)}</td>
     <td>${Number(x.credits||0).toLocaleString()}</td>
     <td>${esc(x.currency)} ${Number(x.amount||0).toLocaleString()}</td>
     <td>${esc(x.status)}</td>
    </tr>
   `).join("")
   ||"<tr><td colspan='6'>No payments yet</td></tr>";

  $("withdrawals").innerHTML=
   (b.withdrawals||[]).map(x=>`
    <tr>
     <td>${dt(x.createdAt)}</td>
     <td>${esc(x.reference)}</td>
     <td>${money(x.amount)}</td>
     <td>****${esc(x.accountNumber)}</td>
     <td>${esc(x.status)}</td>
    </tr>
   `).join("")
   ||"<tr><td colspan='5'>No withdrawals</td></tr>";

 }catch(e){
  $("msg").textContent=e.message;
 }
}

async function adjustCredits(){
 try{
  const r=await fetch(
   "/api/admin/users/"+
   encodeURIComponent(
    $("uid").value
   )+
   "/credits",
   {
    method:"POST",
    headers:Object.assign(
     {
      "Content-Type":
       "application/json"
     },
     hdr()
    ),
    body:JSON.stringify({
     amount:Number(
      $("amount").value
     ),
     source:$("csource").value
    })
   }
  );

  const x=await r.json();

  $("cmsg").textContent=
   x.ok
    ?"Credits: "+x.credits
    :(x.message||x.error);

  loadAll();
 }catch(e){
  $("cmsg").textContent=e.message;
 }
}

async function finance(){
 try{
  const r=await fetch(
   "/api/admin/finance",
   {
    method:"POST",
    headers:Object.assign(
     {
      "Content-Type":
       "application/json"
     },
     hdr()
    ),
    body:JSON.stringify({
     type:$("ftype").value,
     amount:Number(
      $("famount").value
     ),
     description:$("fdesc").value
    })
   }
  );

  const d=await r.json();

  $("fmsg").textContent=
   d.ok
    ?"Recorded"
    :(d.message||d.error);

  loadAll();
 }catch(e){
  $("fmsg").textContent=e.message;
 }
}

async function withdraw(){
 if(!confirm(
  "Withdraw this amount from the MAMAKI owner profit wallet?"
 ))return;

 try{
  const r=await fetch(
   "/api/admin/withdraw",
   {
    method:"POST",
    headers:Object.assign(
     {
      "Content-Type":
       "application/json"
     },
     hdr()
    ),
    body:JSON.stringify({
     amount:Number(
      $("wamount").value
     ),
     name:$("wname").value,
     accountNumber:
      $("waccount").value,
     bankCode:
      $("wbank").value
    })
   }
  );

  const d=await r.json();

  $("wmsg").textContent=
   d.ok
    ?d.message
    :(d.message||d.error);

  loadAll();
 }catch(e){
  $("wmsg").textContent=e.message;
 }
}

if(token){
 $("login").classList.add("hidden");
 $("dash").classList.remove("hidden");
 loadAll();
}
</script>
</body>
</html>`);
});

app.use(
  express.static(ROOT, {
    index: false
  })
);

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        "NOT_FOUND",
      path:
        req.path
    });
  }
);

app.use(
  async (err, req, res, next) => {
    await recordError(err, {
      route: req.path,
      method: req.method
    });

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

setInterval(
  async () => {
    try {
      const now = Date.now();

      const sessions =
        await readSessions();

      let changed = false;

      for (const [hash, session] of Object.entries(
        sessions
      )) {
        if (
          Date.parse(
            session.expiresAt || 0
          ) < now
        ) {
          delete sessions[hash];
          changed = true;
        }
      }

      if (changed) {
        await writeSessions(
          sessions
        );
      }
    } catch {}
  },
  30 * 60 * 1000
);

setInterval(
  async () => {
    try {
      const files =
        await fs.readdir(TMP);

      const cutoff =
        Date.now() -
        24 * 60 * 60 * 1000;

      for (const name of files) {
        const file =
          path.join(
            TMP,
            name
          );

        try {
          const stat =
            await fs.stat(file);

          if (
            stat.isFile() &&
            stat.mtimeMs <
              cutoff
          ) {
            await fs.unlink(
              file
            );
          }
        } catch {}
      }
    } catch {}
  },
  60 * 60 * 1000
);

await ensureStorage();
await ensureAdminAccount();

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
    console.log(
      `Paystack configured: ${Boolean(
        PAYSTACK_SECRET_KEY
      )}`
    );
  }
);
