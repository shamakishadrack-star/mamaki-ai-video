// MAMAKI AI VIDEO CREATIVE STUDIO
// Complete server.js replacement
// GitHub editor: https://github.com/shamakishadrack-star/mamaki-ai-video/edit/main/server.js
//
// IMPORTANT ENVIRONMENT VARIABLES ON RENDER:
// ADMIN_EMAIL=shamakishadrack@gmail.com
// ADMIN_PASSWORD=YOUR_ADMIN_PASSWORD
// REPLICATE_API_TOKEN=YOUR_REPLICATE_TOKEN
// PAYSTACK_SECRET_KEY=YOUR_PAYSTACK_SECRET_KEY   <-- add later when you have Paystack
// SESSION_SECRET=YOUR_RANDOM_SECRET
//
// MAMAKI pricing:
// Live USD/NGN rate + ₦200 fixed MAMAKI margin.
// Users see ONLY MAMAKI's final price.
// Example at ₦1,350/USD:
// $1 = ₦1,550
// $2 = ₦3,100
// $3 = ₦4,650
//
// AI generation:
// The server calculates the required MAMAKI credits BEFORE generation.
// If the user does not have enough credits, generation is stopped.

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
  createHmac,
} from "node:crypto";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");
const TMP = path.join(ROOT, "tmp");
const OUTPUTS = path.join(ROOT, "outputs");
const PROJECTS = path.join(ROOT, "projects");

const USERS_FILE = path.join(DATA, "users.json");
const SESSIONS_FILE = path.join(DATA, "sessions.json");
const ERRORS_FILE = path.join(DATA, "errors.json");
const USAGE_FILE = path.join(DATA, "usage.json");
const CREDITS_FILE = path.join(DATA, "credits.json");
const FINANCE_FILE = path.join(DATA, "finance.json");
const PRICING_FILE = path.join(DATA, "pricing.json");
const PAYMENTS_FILE = path.join(DATA, "payments.json");
const WITHDRAWALS_FILE = path.join(DATA, "withdrawals.json");
const SECURITY_FILE = path.join(DATA, "security.json");

const ADMIN_EMAIL = String(
  process.env.ADMIN_EMAIL || "shamakishadrack@gmail.com"
).trim().toLowerCase();

const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");

const SESSION_SECRET = String(
  process.env.SESSION_SECRET || randomBytes(32).toString("hex")
);

const REPLICATE_API_TOKEN = String(
  process.env.REPLICATE_API_TOKEN || ""
).trim();

const PAYSTACK_SECRET_KEY = String(
  process.env.PAYSTACK_SECRET_KEY || ""
).trim();

const APP_URL = String(
  process.env.APP_URL || "https://mamaki-ai-video.onrender.com"
).replace(/\/$/, "");

const FX_API_URL = String(
  process.env.FX_API_URL || "https://open.er-api.com/v6/latest/USD"
);

const DEFAULT_USD_NGN_RATE = Number(
  process.env.DEFAULT_USD_NGN_RATE || 1600
);

// MAMAKI's fixed markup.
const MAMAKI_MARKUP_NGN = Number(
  process.env.MAMAKI_MARKUP_NGN || 200
);

// One MAMAKI credit represents 0.5 seconds of standard AI generation.
// 10 credits = 5 seconds.
const CREDITS_PER_5_SECONDS = 10;

const MAX_DURATION_SECONDS = 7200;
const MIN_DURATION_SECONDS = 5;

const T2V_MODEL =
  process.env.REPLICATE_T2V_MODEL ||
  "wan-video/wan-2.2-t2v-fast";

const I2V_MODEL =
  process.env.REPLICATE_I2V_MODEL ||
  "wan-video/wan-2.2-i2v-fast";

const appVersion = "18.0.0";

app.set("trust proxy", 1);

// -----------------------------------------------------------------------------
// BODY PARSING
// -----------------------------------------------------------------------------

// Keep raw webhook bytes so Paystack signature verification works correctly.
app.use(
  express.json({
    limit: "15mb",
    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "15mb",
  })
);

// -----------------------------------------------------------------------------
// STORAGE
// -----------------------------------------------------------------------------

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function ensureFile(file, fallback = []) {
  if (!(await exists(file))) {
    await fs.writeFile(
      file,
      JSON.stringify(fallback, null, 2),
      "utf8"
    );
  }
}

async function ensureStorage() {
  await fs.mkdir(DATA, { recursive: true });
  await fs.mkdir(TMP, { recursive: true });
  await fs.mkdir(OUTPUTS, { recursive: true });
  await fs.mkdir(PROJECTS, { recursive: true });

  await ensureFile(USERS_FILE, []);
  await ensureFile(SESSIONS_FILE, []);
  await ensureFile(ERRORS_FILE, []);
  await ensureFile(USAGE_FILE, []);
  await ensureFile(CREDITS_FILE, {});
  await ensureFile(FINANCE_FILE, []);
  await ensureFile(PRICING_FILE, {});
  await ensureFile(PAYMENTS_FILE, []);
  await ensureFile(WITHDRAWALS_FILE, []);
  await ensureFile(SECURITY_FILE, []);
}

await ensureStorage();

async function readJSON(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJSON(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify(value, null, 2),
    "utf8"
  );

  await fs.rename(temp, file);
}

async function appendCapped(file, item, limit = 1000) {
  const list = await readJSON(file, []);
  list.push(item);

  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }

  await writeJSON(file, list);
}

// -----------------------------------------------------------------------------
// PASSWORDS
// -----------------------------------------------------------------------------

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(
    String(password),
    salt,
    64
  ).toString("hex");

  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;

  if (!stored.startsWith("scrypt:")) {
    return stored === String(password);
  }

  const parts = stored.split(":");

  if (parts.length !== 3) return false;

  const salt = parts[1];
  const expected = Buffer.from(parts[2], "hex");

  try {
    const actual = scryptSync(
      String(password),
      salt,
      expected.length
    );

    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// SECURITY
// -----------------------------------------------------------------------------

async function securityLog(action, user, reference = "") {
  await appendCapped(
    SECURITY_FILE,
    {
      id: randomUUID(),
      action,
      email: user?.email || "",
      userId: user?.id || "",
      reference,
      date: new Date().toISOString(),
    },
    1000
  );
}

async function errorLog(error, req) {
  await appendCapped(
    ERRORS_FILE,
    {
      id: randomUUID(),
      message: String(error?.message || error),
      path: req?.path || "",
      method: req?.method || "",
      date: new Date().toISOString(),
    },
    500
  );
}

// -----------------------------------------------------------------------------
// USERS
// -----------------------------------------------------------------------------

async function getUsers() {
  return readJSON(USERS_FILE, []);
}

async function saveUsers(users) {
  await writeJSON(USERS_FILE, users);
}

async function findUserByEmail(email) {
  const users = await getUsers();

  return users.find(
    u =>
      String(u.email || "").toLowerCase() ===
      String(email || "").trim().toLowerCase()
  );
}

async function findUserById(id) {
  const users = await getUsers();
  return users.find(u => u.id === id);
}

async function ensureAdminAccount() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;

  const users = await getUsers();

  let admin = users.find(
    u =>
      String(u.email || "").toLowerCase() === ADMIN_EMAIL
  );

  if (!admin) {
    admin = {
      id: randomUUID(),
      name: "MAMAKI Administrator",
      email: ADMIN_EMAIL,
      passwordHash: hashPassword(ADMIN_PASSWORD),
      role: "admin",
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    };

    users.push(admin);
    await saveUsers(users);
  } else {
    let changed = false;

    if (admin.role !== "admin") {
      admin.role = "admin";
      changed = true;
    }

    if (!admin.passwordHash && ADMIN_PASSWORD) {
      admin.passwordHash = hashPassword(ADMIN_PASSWORD);
      changed = true;
    }

    if (changed) {
      await saveUsers(users);
    }
  }

  await ensureUserCredits(admin.id);
}

await ensureAdminAccount();

// -----------------------------------------------------------------------------
// SESSIONS
// -----------------------------------------------------------------------------

function sessionHash(token) {
  return createHmac(
    "sha256",
    SESSION_SECRET
  ).update(token).digest("hex");
}

async function createSession(user) {
  const token = randomBytes(48).toString("hex");

  const sessions = await readJSON(SESSIONS_FILE, []);

  sessions.push({
    id: randomUUID(),
    tokenHash: sessionHash(token),
    userId: user.id,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });

  await writeJSON(SESSIONS_FILE, sessions);

  return token;
}

function extractToken(req) {
  const header = String(
    req.headers.authorization || ""
  );

  if (header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }

  return (
    String(req.headers["x-session-token"] || "").trim() ||
    ""
  );
}

async function getSessionUser(req) {
  const token = extractToken(req);

  if (!token) return null;

  const sessions = await readJSON(SESSIONS_FILE, []);
  const hash = sessionHash(token);

  const session = sessions.find(
    s =>
      s.tokenHash === hash &&
      Number(s.expiresAt) > Date.now()
  );

  if (!session) return null;

  return findUserById(session.userId);
}

async function requireUser(req, res, next) {
  try {
    const user = await getSessionUser(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "Authentication required.",
      });
    }

    req.user = user;
    next();
  } catch (error) {
    await errorLog(error, req);

    res.status(500).json({
      ok: false,
      error: "Authentication error.",
    });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await getSessionUser(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "Administrator authentication required.",
      });
    }

    if (user.role !== "admin") {
      return res.status(403).json({
        ok: false,
        error: "Administrator access denied.",
      });
    }

    req.user = user;
    next();
  } catch (error) {
    await errorLog(error, req);

    res.status(500).json({
      ok: false,
      error: "Administrator authentication error.",
    });
  }
}

// -----------------------------------------------------------------------------
// USAGE
// -----------------------------------------------------------------------------

async function getUsage() {
  return readJSON(USAGE_FILE, []);
}

async function saveUsage(value) {
  await writeJSON(USAGE_FILE, value);
}

async function getUserUsage(userId) {
  const usage = await getUsage();

  let item = usage.find(x => x.userId === userId);

  if (!item) {
    item = {
      userId,
      aiGenerations: 0,
      aiSeconds: 0,
      studioJobs: 0,
      narrationJobs: 0,
      updatedAt: new Date().toISOString(),
    };

    usage.push(item);
    await saveUsage(usage);
  }

  return item;
}

async function updateUsage(userId, patch) {
  const usage = await getUsage();

  let item = usage.find(x => x.userId === userId);

  if (!item) {
    item = {
      userId,
      aiGenerations: 0,
      aiSeconds: 0,
      studioJobs: 0,
      narrationJobs: 0,
      updatedAt: new Date().toISOString(),
    };

    usage.push(item);
  }

  Object.assign(item, patch);
  item.updatedAt = new Date().toISOString();

  await saveUsage(usage);
  return item;
}

// -----------------------------------------------------------------------------
// CREDITS
// -----------------------------------------------------------------------------

async function getCreditStore() {
  return readJSON(CREDITS_FILE, {});
}

async function saveCreditStore(value) {
  await writeJSON(CREDITS_FILE, value);
}

async function ensureUserCredits(userId) {
  const credits = await getCreditStore();

  if (!credits[userId]) {
    credits[userId] = {
      balance: 100,
      issued: 100,
      consumed: 0,
      refunded: 0,
      purchased: 0,
      updatedAt: new Date().toISOString(),
    };

    await saveCreditStore(credits);
  }

  return credits[userId];
}

async function creditBalance(userId) {
  const item = await ensureUserCredits(userId);
  return Number(item.balance || 0);
}

async function addCredits(
  userId,
  amount,
  reason = "credit adjustment",
  reference = ""
) {
  amount = Math.max(0, Number(amount) || 0);

  const credits = await getCreditStore();

  if (!credits[userId]) {
    credits[userId] = {
      balance: 0,
      issued: 0,
      consumed: 0,
      refunded: 0,
      purchased: 0,
    };
  }

  credits[userId].balance += amount;
  credits[userId].issued += amount;
  credits[userId].purchased +=
    reason === "purchase" ? amount : 0;

  credits[userId].updatedAt =
    new Date().toISOString();

  await saveCreditStore(credits);

  return credits[userId];
}

async function consumeCredits(
  userId,
  amount,
  reason = "AI generation"
) {
  amount = Math.max(0, Math.ceil(Number(amount) || 0));

  const credits = await getCreditStore();
  const item = credits[userId];

  if (!item || Number(item.balance || 0) < amount) {
    return {
      ok: false,
      balance: Number(item?.balance || 0),
      required: amount,
    };
  }

  item.balance -= amount;
  item.consumed += amount;
  item.updatedAt = new Date().toISOString();

  await saveCreditStore(credits);

  return {
    ok: true,
    balance: item.balance,
    required: amount,
    reason,
  };
}

async function refundCredits(
  userId,
  amount,
  reason = "AI generation refund"
) {
  amount = Math.max(0, Number(amount) || 0);

  const credits = await getCreditStore();

  if (!credits[userId]) {
    credits[userId] = {
      balance: 0,
      issued: 0,
      consumed: 0,
      refunded: 0,
      purchased: 0,
    };
  }

  credits[userId].balance += amount;
  credits[userId].refunded += amount;
  credits[userId].updatedAt =
    new Date().toISOString();

  await saveCreditStore(credits);

  return credits[userId];
}

// -----------------------------------------------------------------------------
// VIDEO CREDIT CALCULATION
// -----------------------------------------------------------------------------

function calculateRequiredCredits(seconds) {
  const safeSeconds = Math.max(
    MIN_DURATION_SECONDS,
    Math.min(
      MAX_DURATION_SECONDS,
      Number(seconds) || MIN_DURATION_SECONDS
    )
  );

  return Math.ceil(safeSeconds / 5) * CREDITS_PER_5_SECONDS;
}

function durationLabel(seconds) {
  const s = Number(seconds) || 0;

  if (s < 60) return `${s} seconds`;

  if (s < 3600) {
    return `${Math.floor(s / 60)} minute${
      Math.floor(s / 60) === 1 ? "" : "s"
    }`;
  }

  return `${(s / 3600).toFixed(2)} hours`;
}

// -----------------------------------------------------------------------------
// FX + SMART PRICING
// -----------------------------------------------------------------------------

let fxCache = {
  rate: DEFAULT_USD_NGN_RATE,
  updatedAt: null,
  status: "FALLBACK",
};

async function getUsdNgnRate() {
  try {
    const now = Date.now();

    if (
      fxCache.updatedAt &&
      now - fxCache.updatedAt < 30 * 60 * 1000
    ) {
      return fxCache;
    }

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      8000
    );

    const response = await fetch(FX_API_URL, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(
        `FX provider returned ${response.status}`
      );
    }

    const data = await response.json();

    const rate = Number(
      data?.rates?.NGN
    );

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("Invalid USD/NGN rate.");
    }

    fxCache = {
      rate,
      updatedAt: now,
      status: "LIVE",
    };

    return fxCache;
  } catch {
    fxCache = {
      rate: DEFAULT_USD_NGN_RATE,
      updatedAt: Date.now(),
      status: "FALLBACK",
    };

    return fxCache;
  }
}

function roundPrice(value) {
  return Math.max(
    50,
    Math.round(Number(value) / 50) * 50
  );
}

async function buildPricing() {
  const fx = await getUsdNgnRate();

  const packages = [
    {
      credits: 100,
      usd: 1,
    },
    {
      credits: 500,
      usd: 5,
    },
    {
      credits: 1000,
      usd: 10,
    },
    {
      credits: 2500,
      usd: 25,
    },
    {
      credits: 5000,
      usd: 50,
    },
  ];

  return {
    currency: "NGN",
    usdNgnRate: fx.rate,
    fxStatus: fx.status,
    updatedAt: fx.updatedAt
      ? new Date(fx.updatedAt).toISOString()
      : null,

    // PRIVATE calculation only.
    // Do not send this breakdown to normal users.
    markupNgn: MAMAKI_MARKUP_NGN,

    packages: packages.map(pkg => {
      const base = pkg.usd * fx.rate;
      const finalPrice = roundPrice(
        base + pkg.usd * MAMAKI_MARKUP_NGN
      );

      return {
        credits: pkg.credits,
        usd: pkg.usd,
        priceNgn: finalPrice,
      };
    }),
  };
}

// -----------------------------------------------------------------------------
// FINANCE
// -----------------------------------------------------------------------------

async function getFinance() {
  return readJSON(FINANCE_FILE, []);
}

async function recordFinance(transaction) {
  const finance = await getFinance();

  finance.push({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...transaction,
  });

  await writeJSON(FINANCE_FILE, finance);
}

async function getPayments() {
  return readJSON(PAYMENTS_FILE, []);
}

async function savePayments(value) {
  await writeJSON(PAYMENTS_FILE, value);
}

// -----------------------------------------------------------------------------
// REPLICATE
// -----------------------------------------------------------------------------

const replicate = REPLICATE_API_TOKEN
  ? new Replicate({
      auth: REPLICATE_API_TOKEN,
    })
  : null;

function dimensionsForRatio(ratio) {
  if (ratio === "9:16") {
    return {
      width: 1080,
      height: 1920,
    };
  }

  if (ratio === "1:1") {
    return {
      width: 1080,
      height: 1080,
    };
  }

  return {
    width: 1920,
    height: 1080,
  };
}

function framesForSeconds(seconds) {
  return Number(seconds) <= 5 ? 81 : 121;
}

function enhancedPrompt(prompt, style) {
  const safeStyle = style || "Cinematic";

  return [
    String(prompt || "").trim(),
    `Visual style: ${safeStyle}.`,
    "Professional cinematic composition.",
    "Natural motion and physically consistent movement.",
    "Strong subject continuity from beginning to end.",
    "No captions.",
    "No subtitles.",
    "No random text.",
    "No logos.",
    "No distorted faces.",
    "No extra limbs.",
    "No flickering.",
  ].join(" ");
}

function pickOutputUrl(output) {
  if (!output) return "";

  if (typeof output === "string") {
    return output;
  }

  if (Array.isArray(output)) {
    for (const item of output) {
      const found = pickOutputUrl(item);
      if (found) return found;
    }
  }

  if (typeof output === "object") {
    for (const key of [
      "url",
      "video",
      "output",
      "file",
    ]) {
      if (output[key]) {
        const found = pickOutputUrl(output[key]);
        if (found) return found;
      }
    }
  }

  return "";
}

async function downloadFile(url, destination) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Generated video download failed: HTTP ${response.status}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  await fs.writeFile(destination, buffer);

  return destination;
}

// -----------------------------------------------------------------------------
// FFMPEG
// -----------------------------------------------------------------------------

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args);

    let stderr = "";

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `FFmpeg failed with code ${code}: ${stderr.slice(-3000)}`
          )
        );
      }
    });
  });
}

async function applyWatermark(input, output) {
  await runFFmpeg([
    "-y",
    "-i",
    input,
    "-vf",
    "drawtext=text='MAMAKI ✨':x=w-tw-28:y=h-th-24:fontsize=28:fontcolor=white@0.85:box=1:boxcolor=black@0.35:boxborderw=8",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    output,
  ]);

  return output;
}

// -----------------------------------------------------------------------------
// MULTER
// -----------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

// -----------------------------------------------------------------------------
// AUTH API
// -----------------------------------------------------------------------------

app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || "");

    if (!name || !email || password.length < 6) {
      return res.status(400).json({
        ok: false,
        error:
          "Name, valid email and a password of at least 6 characters are required.",
      });
    }

    const existing = await findUserByEmail(email);

    if (existing) {
      return res.status(409).json({
        ok: false,
        error: "An account with this email already exists.",
      });
    }

    const user = {
      id: randomUUID(),
      name,
      email,
      passwordHash: hashPassword(password),
      role:
        email === ADMIN_EMAIL
          ? "admin"
          : "user",
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    };

    const users = await getUsers();
    users.push(user);

    await saveUsers(users);
    await ensureUserCredits(user.id);
    await getUserUsage(user.id);

    const token = await createSession(user);

    await securityLog(
      "REGISTER_SUCCESS",
      user
    );

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    await errorLog(error, req);

    res.status(500).json({
      ok: false,
      error: "Registration failed.",
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();

    const password = String(
      req.body?.password || ""
    );

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Email and password are required.",
      });
    }

    let user = await findUserByEmail(email);

    // IMPORTANT ADMIN FIX:
    // The administrator can always authenticate using
    // ADMIN_EMAIL + ADMIN_PASSWORD configured in Render.
    if (
      email === ADMIN_EMAIL &&
      ADMIN_PASSWORD &&
      password === ADMIN_PASSWORD
    ) {
      if (!user) {
        user = {
          id: randomUUID(),
          name: "MAMAKI Administrator",
          email: ADMIN_EMAIL,
          passwordHash: hashPassword(ADMIN_PASSWORD),
          role: "admin",
          createdAt: new Date().toISOString(),
          lastLoginAt: null,
        };

        const users = await getUsers();
        users.push(user);
        await saveUsers(users);
      } else {
        const users = await getUsers();
        const index = users.findIndex(
          x => x.id === user.id
        );

        users[index].role = "admin";
        users[index].passwordHash =
          hashPassword(ADMIN_PASSWORD);
        user = users[index];

        await saveUsers(users);
      }
    } else {
      if (!user) {
        return res.status(401).json({
          ok: false,
          error: "Invalid credentials.",
        });
      }

      if (
        !verifyPassword(
          password,
          user.passwordHash
        )
      ) {
        await securityLog(
          "LOGIN_FAILED",
          user
        );

        return res.status(401).json({
          ok: false,
          error: "Invalid credentials.",
        });
      }

      // Automatically keep the configured admin account as admin.
      if (email === ADMIN_EMAIL && user.role !== "admin") {
        user.role = "admin";

        const users = await getUsers();
        const index = users.findIndex(
          x => x.id === user.id
        );

        if (index >= 0) {
          users[index] = user;
          await saveUsers(users);
        }
      }
    }

    user.lastLoginAt = new Date().toISOString();

    const users = await getUsers();
    const index = users.findIndex(
      x => x.id === user.id
    );

    if (index >= 0) {
      users[index] = user;
      await saveUsers(users);
    }

    await ensureUserCredits(user.id);
    await getUserUsage(user.id);

    const token = await createSession(user);

    await securityLog(
      "LOGIN_SUCCESS",
      user
    );

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    await errorLog(error, req);

    res.status(500).json({
      ok: false,
      error: "Login failed.",
    });
  }
});

app.post("/api/auth/logout", requireUser, async (req, res) => {
  const token = extractToken(req);

  if (token) {
    const sessions = await readJSON(
      SESSIONS_FILE,
      []
    );

    const hash = sessionHash(token);

    await writeJSON(
      SESSIONS_FILE,
      sessions.filter(
        s => s.tokenHash !== hash
      )
    );
  }

  await securityLog(
    "LOGOUT",
    req.user
  );

  res.json({
    ok: true,
  });
});

app.get("/api/auth/me", requireUser, async (req, res) => {
  const credits = await creditBalance(
    req.user.id
  );

  res.json({
    ok: true,
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
    },
    credits,
  });
});

// -----------------------------------------------------------------------------
// CREDITS API
// -----------------------------------------------------------------------------

app.get("/api/credits", requireUser, async (req, res) => {
  const item = await ensureUserCredits(
    req.user.id
  );

  res.json({
    ok: true,
    credits: {
      balance: Number(item.balance || 0),
      issued: Number(item.issued || 0),
      consumed: Number(item.consumed || 0),
      refunded: Number(item.refunded || 0),
      purchased: Number(item.purchased || 0),
    },
  });
});

app.get(
  "/api/credits/required",
  requireUser,
  async (req, res) => {
    const seconds = Number(
      req.query.seconds || 5
    );

    const required =
      calculateRequiredCredits(seconds);

    const balance =
      await creditBalance(req.user.id);

    res.json({
      ok: true,
      durationSeconds: seconds,
      duration: durationLabel(seconds),
      requiredCredits: required,
      availableCredits: balance,
      sufficient: balance >= required,
      shortage: Math.max(
        0,
        required - balance
      ),
    });
  }
);

// -----------------------------------------------------------------------------
// BILLING PRICING API
// -----------------------------------------------------------------------------

app.get(
  "/api/billing/pricing",
  async (req, res) => {
    try {
      const pricing = await buildPricing();

      // SECURITY:
      // Do NOT expose the FX rate or ₦200 markup to normal users.
      res.json({
        ok: true,
        currency: pricing.currency,
        updatedAt: pricing.updatedAt,
        packages: pricing.packages.map(p => ({
          credits: p.credits,
          priceNgn: p.priceNgn,
        })),
      });
    } catch (error) {
      await errorLog(error, req);

      res.status(500).json({
        ok: false,
        error: "Pricing unavailable.",
      });
    }
  }
);

// Private pricing details for admin.
app.get(
  "/api/admin/billing",
  requireAdmin,
  async (req, res) => {
    const pricing = await buildPricing();

    res.json({
      ok: true,
      configured: Boolean(PAYSTACK_SECRET_KEY),
      paystack: {
        configured: Boolean(PAYSTACK_SECRET_KEY),
        status: PAYSTACK_SECRET_KEY
          ? "CONFIGURED"
          : "NOT CONFIGURED",
      },
      fx: {
        usdNgnRate: pricing.usdNgnRate,
        status: pricing.fxStatus,
        updatedAt: pricing.updatedAt,
      },
      markupNgn: MAMAKI_MARKUP_NGN,
      packages: pricing.packages,
    });
  }
);

// -----------------------------------------------------------------------------
// PAYSTACK INITIALIZATION
// -----------------------------------------------------------------------------

app.post(
  "/api/billing/paystack/initialize",
  requireUser,
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        return res.status(503).json({
          ok: false,
          configured: false,
          error:
            "Paystack is not configured yet. MAMAKI billing is ready, but a Paystack Secret Key must be added in Render before live payments can be accepted.",
        });
      }

      const credits = Number(
        req.body?.credits || 0
      );

      const pricing =
        await buildPricing();

      const pack = pricing.packages.find(
        p => p.credits === credits
      );

      if (!pack) {
        return res.status(400).json({
          ok: false,
          error: "Invalid credit package.",
        });
      }

      const reference =
        `MAMAKI-${Date.now()}-${randomUUID()
          .slice(0, 8)
          .toUpperCase()}`;

      const response = await fetch(
        "https://api.paystack.co/transaction/initialize",
        {
          method: "POST",
          headers: {
            Authorization:
              `Bearer ${PAYSTACK_SECRET_KEY}`,
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            email: req.user.email,
            amount: Math.round(
              pack.priceNgn * 100
            ),
            currency: "NGN",
            reference,
            callback_url:
              `${APP_URL}/payment/callback`,
            metadata: {
              mamakiUserId: req.user.id,
              mamakiCredits: pack.credits,
              mamakiAmountNgn:
                pack.priceNgn,
            },
          }),
        }
      );

      const data = await response.json();

      if (!response.ok || !data.status) {
        throw new Error(
          data?.message ||
            "Paystack initialization failed."
        );
      }

      const payments =
        await getPayments();

      payments.push({
        id: randomUUID(),
        reference,
        userId: req.user.id,
        email: req.user.email,
        credits: pack.credits,
        amount: pack.priceNgn,
        currency: "NGN",
        status: "initialized",
        authorizationUrl:
          data.data.authorization_url,
        createdAt:
          new Date().toISOString(),
      });

      await savePayments(payments);

      res.json({
        ok: true,
        reference,
        authorizationUrl:
          data.data.authorization_url,
      });
    } catch (error) {
      await errorLog(error, req);

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Payment initialization failed.",
      });
    }
  }
);

// -----------------------------------------------------------------------------
// PAYSTACK VERIFY
// -----------------------------------------------------------------------------

app.get(
  "/api/billing/paystack/verify/:reference",
  requireUser,
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        return res.status(503).json({
          ok: false,
          configured: false,
          error: "Paystack is not configured.",
        });
      }

      const reference =
        String(req.params.reference);

      const response = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(
          reference
        )}`,
        {
          headers: {
            Authorization:
              `Bearer ${PAYSTACK_SECRET_KEY}`,
          },
        }
      );

      const data = await response.json();

      if (!response.ok || !data.status) {
        return res.status(400).json({
          ok: false,
          error:
            data?.message ||
            "Unable to verify payment.",
        });
      }

      const payment = data.data;

      if (
        String(payment.status).toLowerCase() !==
        "success"
      ) {
        return res.json({
          ok: true,
          paid: false,
          status: payment.status,
        });
      }

      const payments =
        await getPayments();

      const local = payments.find(
        p => p.reference === reference
      );

      if (!local) {
        return res.status(404).json({
          ok: false,
          error: "MAMAKI payment record not found.",
        });
      }

      if (local.userId !== req.user.id) {
        return res.status(403).json({
          ok: false,
          error: "Payment ownership mismatch.",
        });
      }

      if (local.status !== "completed") {
        await addCredits(
          local.userId,
          local.credits,
          "purchase",
          reference
        );

        local.status = "completed";
        local.paidAt =
          new Date().toISOString();

        await savePayments(payments);

        await recordFinance({
          type: "revenue",
          reference,
          userId: local.userId,
          amount: local.amount,
          currency: local.currency,
          description:
            `MAMAKI credit purchase: ${local.credits} credits`,
        });

        await securityLog(
          "PAYMENT_CREDITED",
          req.user,
          reference
        );
      }

      res.json({
        ok: true,
        paid: true,
        credits: local.credits,
        reference,
        status: local.status,
      });
    } catch (error) {
      await errorLog(error, req);

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Payment verification failed.",
      });
    }
  }
);

// -----------------------------------------------------------------------------
// PAYSTACK WEBHOOK
// -----------------------------------------------------------------------------

app.post(
  "/api/billing/paystack/webhook",
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        return res.sendStatus(200);
      }

      const signature =
        String(
          req.headers["x-paystack-signature"] ||
          ""
        );

      const raw =
        req.rawBody ||
        Buffer.from(
          JSON.stringify(req.body || {})
        );

      const expected =
        createHmac(
          "sha512",
          PAYSTACK_SECRET_KEY
        )
          .update(raw)
          .digest("hex");

      if (
        !signature ||
        signature.length !==
          expected.length ||
        !timingSafeEqual(
          Buffer.from(signature),
          Buffer.from(expected)
        )
      ) {
        return res.sendStatus(401);
      }

      const event = req.body;

      if (
        event?.event !==
        "charge.success"
      ) {
        return res.sendStatus(200);
      }

      const transaction =
        event?.data || {};

      const reference =
        String(transaction.reference || "");

      if (!reference) {
        return res.sendStatus(200);
      }

      const payments =
        await getPayments();

      const local = payments.find(
        p => p.reference === reference
      );

      if (!local) {
        return res.sendStatus(200);
      }

      if (local.status !== "completed") {
        await addCredits(
          local.userId,
          local.credits,
          "purchase",
          reference
        );

        local.status = "completed";
        local.paidAt =
          new Date().toISOString();

        await savePayments(payments);

        await recordFinance({
          type: "revenue",
          reference,
          userId: local.userId,
          amount: local.amount,
          currency: local.currency,
          description:
            `Paystack payment: ${local.credits} MAMAKI credits`,
        });

        const user =
          await findUserById(local.userId);

        if (user) {
          await securityLog(
            "PAYMENT_CREDITED",
            user,
            reference
          );
        }
      }

      return res.sendStatus(200);
    } catch (error) {
      await errorLog(error, req);
      return res.sendStatus(200);
    }
  }
);

// -----------------------------------------------------------------------------
// PAYMENT CALLBACK
// -----------------------------------------------------------------------------

app.get(
  "/payment/callback",
  async (req, res) => {
    const reference =
      String(req.query.reference || "");

    res.type("html").send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI Payment</title>
<style>
body{
  font-family:Arial,sans-serif;
  background:#050509;
  color:#fff;
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:100vh;
  margin:0;
}
.card{
  max-width:520px;
  width:90%;
  padding:32px;
  border-radius:22px;
  background:#12121a;
  text-align:center;
}
a{
  display:inline-block;
  margin-top:20px;
  padding:13px 20px;
  border-radius:12px;
  background:#fff;
  color:#000;
  text-decoration:none;
}
</style>
</head>
<body>
<div class="card">
<h1>✨ MAMAKI AI</h1>
<h2>Payment received</h2>
<p>Your payment reference is:</p>
<strong>${reference || "Pending"}</strong>
<p>
Return to MAMAKI and refresh your credits.
Your credits are automatically fulfilled after successful payment verification.
</p>
<a href="/">Return to MAMAKI</a>
</div>
</body>
</html>
`);
  }
);

// -----------------------------------------------------------------------------
// AI VIDEO COST PREVIEW
// -----------------------------------------------------------------------------

app.post(
  "/api/video/cost",
  requireUser,
  async (req, res) => {
    const seconds = Math.max(
      MIN_DURATION_SECONDS,
      Math.min(
        MAX_DURATION_SECONDS,
        Number(req.body?.duration || 5)
      )
    );

    const required =
      calculateRequiredCredits(seconds);

    const balance =
      await creditBalance(req.user.id);

    res.json({
      ok: true,
      durationSeconds: seconds,
      requiredCredits: required,
      availableCredits: balance,
      sufficient: balance >= required,
      shortage: Math.max(
        0,
        required - balance
      ),
    });
  }
);

// -----------------------------------------------------------------------------
// AI VIDEO GENERATION
// -----------------------------------------------------------------------------

app.post(
  "/api/generate",
  requireUser,
  upload.single("image"),
  async (req, res) => {
    let chargedCredits = 0;

    try {
      if (!replicate) {
        return res.status(503).json({
          ok: false,
          error:
            "AI generation requires an active Replicate account and REPLICATE_API_TOKEN.",
        });
      }

      const prompt = String(
        req.body?.prompt || ""
      ).trim();

      const seconds = Math.max(
        MIN_DURATION_SECONDS,
        Math.min(
          MAX_DURATION_SECONDS,
          Number(req.body?.duration || 5)
        )
      );

      const ratio =
        String(req.body?.ratio || "16:9");

      const style =
        String(req.body?.style || "Cinematic");

      const mode =
        String(req.body?.mode || "t2v")
          .toLowerCase();

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error:
            "Please describe the video you want to create.",
        });
      }

      const requiredCredits =
        calculateRequiredCredits(seconds);

      const balance =
        await creditBalance(req.user.id);

      // IMPORTANT:
      // Tell the frontend exactly what is required.
      // Never start Replicate if the user cannot pay.
      if (balance < requiredCredits) {
        return res.status(402).json({
          ok: false,
          code: "INSUFFICIENT_CREDITS",
          error:
            `This video requires ${requiredCredits} MAMAKI credits, but you only have ${balance}. Please top up your MAMAKI credits to continue.`,
          requiredCredits,
          availableCredits: balance,
          shortage:
            requiredCredits - balance,
        });
      }

      const charged =
        await consumeCredits(
          req.user.id,
          requiredCredits,
          "AI video generation"
        );

      if (!charged.ok) {
        return res.status(402).json({
          ok: false,
          code: "INSUFFICIENT_CREDITS",
          error:
            "You do not have enough MAMAKI credits.",
          requiredCredits,
          availableCredits:
            charged.balance,
        });
      }

      chargedCredits = requiredCredits;

      const dimensions =
        dimensionsForRatio(ratio);

      const input = {
        prompt: enhancedPrompt(
          prompt,
          style
        ),
        num_frames:
          framesForSeconds(seconds),
        width: dimensions.width,
        height: dimensions.height,
      };

      let imagePath = null;

      if (
        mode === "i2v" &&
        req.file
      ) {
        const extension =
          path.extname(
            req.file.originalname || ""
          ) || ".jpg";

        imagePath = path.join(
          TMP,
          `${randomUUID()}${extension}`
        );

        await fs.writeFile(
          imagePath,
          req.file.buffer
        );

        input.image =
          `data:${req.file.mimetype};base64,${req.file.buffer.toString(
            "base64"
          )}`;
      }

      const model =
        mode === "i2v"
          ? I2V_MODEL
          : T2V_MODEL;

      const output =
        await replicate.run(
          model,
          { input }
        );

      const videoUrl =
        pickOutputUrl(output);

      if (!videoUrl) {
        throw new Error(
          "Replicate completed but did not return a video file."
        );
      }

      const rawFile =
        path.join(
          TMP,
          `${randomUUID()}.mp4`
        );

      const finalFile =
        path.join(
          OUTPUTS,
          `${randomUUID()}.mp4`
        );

      await downloadFile(
        videoUrl,
        rawFile
      );

      await applyWatermark(
        rawFile,
        finalFile
      );

      const publicUrl =
        `/outputs/${path.basename(
          finalFile
        )}`;

      const usage =
        await getUserUsage(
          req.user.id
        );

      await updateUsage(
        req.user.id,
        {
          aiGenerations:
            Number(
              usage.aiGenerations || 0
            ) + 1,
          aiSeconds:
            Number(
              usage.aiSeconds || 0
            ) + seconds,
        }
      );

      await securityLog(
        "AI_GENERATION_SUCCESS",
        req.user
      );

      if (imagePath) {
        await fs.rm(
          imagePath,
          { force: true }
        ).catch(() => {});
      }

      await fs.rm(
        rawFile,
        { force: true }
      ).catch(() => {});

      res.json({
        ok: true,
        videoUrl: publicUrl,
        durationSeconds: seconds,
        duration: durationLabel(seconds),
        creditsUsed: chargedCredits,
        remainingCredits:
          await creditBalance(
            req.user.id
          ),
      });
    } catch (error) {
      await errorLog(error, req);

      // VERY IMPORTANT:
      // If Replicate fails, return the user's credits.
      if (chargedCredits > 0) {
        await refundCredits(
          req.user.id,
          chargedCredits,
          "AI generation failure"
        );
      }

      const message =
        String(error?.message || "");

      let code = "GENERATION_FAILED";

      if (
        /credit|billing|payment/i.test(
          message
        )
      ) {
        code = "PROVIDER_CREDIT_REQUIRED";
      }

      if (
        /authentication|unauthorized|token/i.test(
          message
        )
      ) {
        code = "PROVIDER_AUTH_REQUIRED";
      }

      if (
        /rate limit|429/i.test(
          message
        )
      ) {
        code = "PROVIDER_RATE_LIMIT";
      }

      res.status(500).json({
        ok: false,
        code,
        error:
          message ||
          "Video generation failed. Your MAMAKI credits have been refunded.",
        creditsRefunded:
          chargedCredits,
        remainingCredits:
          await creditBalance(
            req.user.id
          ),
      });
    }
  }
);

// -----------------------------------------------------------------------------
// PROJECTS
// -----------------------------------------------------------------------------

async function projectFile(userId) {
  return path.join(
    PROJECTS,
    `${userId}.json`
  );
}

async function getProjects(userId) {
  return readJSON(
    await projectFile(userId),
    []
  );
}

async function saveProjects(
  userId,
  projects
) {
  await writeJSON(
    await projectFile(userId),
    projects
  );
}

app.get(
  "/api/projects",
  requireUser,
  async (req, res) => {
    const projects =
      await getProjects(
        req.user.id
      );

    res.json({
      ok: true,
      projects,
    });
  }
);

app.get(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    const projects =
      await getProjects(
        req.user.id
      );

    const project =
      projects.find(
        p => p.id === req.params.id
      );

    if (!project) {
      return res.status(404).json({
        ok: false,
        error: "Project not found.",
      });
    }

    res.json({
      ok: true,
      project,
    });
  }
);

app.delete(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    const projects =
      await getProjects(
        req.user.id
      );

    const filtered =
      projects.filter(
        p => p.id !== req.params.id
      );

    await saveProjects(
      req.user.id,
      filtered
    );

    res.json({
      ok: true,
    });
  }
);

// -----------------------------------------------------------------------------
// FREE STUDIO
// -----------------------------------------------------------------------------

app.post(
  "/api/studio/narration",
  requireUser,
  async (req, res) => {
    try {
      const text = String(
        req.body?.text || ""
      ).trim();

      if (!text) {
        return res.status(400).json({
          ok: false,
          error: "Narration text is required.",
        });
      }

      const output =
        path.join(
          OUTPUTS,
          `${randomUUID()}.mp3`
        );

      const tts =
        new EdgeTTS();

      await tts.synthesize(
        text,
        "en-US-AriaNeural"
      );

      await tts.save(
        output
      );

      const usage =
        await getUserUsage(
          req.user.id
        );

      await updateUsage(
        req.user.id,
        {
          narrationJobs:
            Number(
              usage.narrationJobs || 0
            ) + 1,
        }
      );

      res.json({
        ok: true,
        url:
          `/outputs/${path.basename(
            output
          )}`,
      });
    } catch (error) {
      await errorLog(error, req);

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Narration failed.",
      });
    }
  }
);

app.post(
  "/api/studio/upload",
  requireUser,
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: "No video file uploaded.",
        });
      }

      const file =
        path.join(
          OUTPUTS,
          `${randomUUID()}${path.extname(
            req.file.originalname || ".mp4"
          )}`
        );

      await fs.writeFile(
        file,
        req.file.buffer
      );

      const usage =
        await getUserUsage(
          req.user.id
        );

      await updateUsage(
        req.user.id,
        {
          studioJobs:
            Number(
              usage.studioJobs || 0
            ) + 1,
        }
      );

      res.json({
        ok: true,
        url:
          `/outputs/${path.basename(
            file
          )}`,
      });
    } catch (error) {
      await errorLog(error, req);

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Studio upload failed.",
      });
    }
  }
);

// -----------------------------------------------------------------------------
// ADMIN STATS
// -----------------------------------------------------------------------------

app.get(
  "/api/admin/stats",
  requireAdmin,
  async (req, res) => {
    const users =
      await getUsers();

    const usage =
      await getUsage();

    const payments =
      await getPayments();

    const finance =
      await getFinance();

    const credits =
      await getCreditStore();

    const today =
      new Date();

    const dayStart =
      new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate()
      ).getTime();

    const weekStart =
      dayStart -
      6 * 24 * 60 * 60 * 1000;

    const monthStart =
      new Date(
        today.getFullYear(),
        today.getMonth(),
        1
      ).getTime();

    const totalVideos =
      usage.reduce(
        (a, x) =>
          a +
          Number(
            x.aiGenerations || 0
          ),
        0
      );

    const aiSeconds =
      usage.reduce(
        (a, x) =>
          a +
          Number(
            x.aiSeconds || 0
          ),
        0
      );

    const totalCredits =
      Object.values(credits)
        .reduce(
          (a, x) =>
            a +
            Number(
              x.balance || 0
            ),
          0
        );

    const grossRevenue =
      finance
        .filter(
          x =>
            x.type === "revenue"
        )
        .reduce(
          (a, x) =>
            a +
            Number(
              x.amount || 0
            ),
          0
        );

    const refunds =
      finance
        .filter(
          x =>
            x.type === "refund"
        )
        .reduce(
          (a, x) =>
            a +
            Number(
              x.amount || 0
            ),
          0
        );

    const costs =
      finance
        .filter(
          x =>
            x.type === "cost"
        )
        .reduce(
          (a, x) =>
            a +
            Number(
              x.amount || 0
            ),
          0
        );

    const profit =
      grossRevenue -
      refunds -
      costs;

    const liveUsers =
      users.filter(
        u =>
          u.lastLoginAt &&
          Date.now() -
            new Date(
              u.lastLoginAt
            ).getTime() <
            30 * 60 * 1000
      ).length;

    const newToday =
      users.filter(
        u =>
          new Date(
            u.createdAt
          ).getTime() >=
          dayStart
      ).length;

    const newWeek =
      users.filter(
        u =>
          new Date(
            u.createdAt
          ).getTime() >=
          weekStart
      ).length;

    const newMonth =
      users.filter(
        u =>
          new Date(
            u.createdAt
          ).getTime() >=
          monthStart
      ).length;

    res.json({
      ok: true,
      users: users.length,
      liveActive: liveUsers,
      newToday,
      newWeek,
      newMonth,
      admins:
        users.filter(
          u => u.role === "admin"
        ).length,
      videosGenerated:
        totalVideos,
      aiSeconds,
      credits:
        totalCredits,
      profit,
      grossRevenue,
      refunds,
      totalCosts: costs,
      payments:
        payments.length,
    });
  }
);

// -----------------------------------------------------------------------------
// ADMIN USERS
// -----------------------------------------------------------------------------

app.get(
  "/api/admin/users",
  requireAdmin,
  async (req, res) => {
    const users =
      await getUsers();

    const usage =
      await getUsage();

    const credits =
      await getCreditStore();

    res.json({
      ok: true,
      users: users.map(u => {
        const usageItem =
          usage.find(
            x =>
              x.userId === u.id
          );

        const credit =
          credits[u.id] || {};

        return {
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          credits:
            Number(
              credit.balance || 0
            ),
          videos:
            Number(
              usageItem?.aiGenerations ||
                0
            ),
          aiSeconds:
            Number(
              usageItem?.aiSeconds || 0
            ),
          createdAt:
            u.createdAt,
          lastLoginAt:
            u.lastLoginAt,
        };
      }),
    });
  }
);

// -----------------------------------------------------------------------------
// ADMIN JOBS
// -----------------------------------------------------------------------------

app.get(
  "/api/admin/jobs",
  requireAdmin,
  async (req, res) => {
    const usage =
      await getUsage();

    res.json({
      ok: true,
      jobs: usage.map(
        x => ({
          userId: x.userId,
          aiGenerations:
            x.aiGenerations || 0,
          aiSeconds:
            x.aiSeconds || 0,
          studioJobs:
            x.studioJobs || 0,
          narrationJobs:
            x.narrationJobs || 0,
          updatedAt:
            x.updatedAt,
        })
      ),
    });
  }
);

// -----------------------------------------------------------------------------
// ADMIN CREDITS
// -----------------------------------------------------------------------------

app.get(
  "/api/admin/credits",
  requireAdmin,
  async (req, res) => {
    const credits =
      await getCreditStore();

    const total =
      Object.values(credits)
        .reduce(
          (a, x) =>
            a +
            Number(
              x.balance || 0
            ),
          0
        );

    const issued =
      Object.values(credits)
        .reduce(
          (a, x) =>
            a +
            Number(
              x.issued || 0
            ),
          0
        );

    const consumed =
      Object.values(credits)
        .reduce(
          (a, x) =>
            a +
            Number(
              x.consumed || 0
            ),
          0
        );

    const refunded =
      Object.values(credits)
        .reduce(
          (a, x) =>
            a +
            Number(
              x.refunded || 0
            ),
          0
        );

    res.json({
      ok: true,
      totalBalance: total,
      issued,
      consumed,
      refunded,
      providerConfigured:
        Boolean(
          REPLICATE_API_TOKEN
        ),
      providerBalance: 0,
      balanceKnown: false,
      providerNote:
        "Replicate does not expose an authoritative prepaid balance through the public account API. MAMAKI will not fabricate a balance.",
      modelT2V: T2V_MODEL,
      modelI2V: I2V_MODEL,
    });
  }
);

app.post(
  "/api/admin/credits/adjust",
  requireAdmin,
  async (req, res) => {
    try {
      const email =
        String(
          req.body?.email || ""
        )
          .trim()
          .toLowerCase();

      const amount =
        Number(
          req.body?.amount || 0
        );

      if (!email || !Number.isFinite(amount)) {
        return res.status(400).json({
          ok: false,
          error:
            "Email and valid credit amount are required.",
        });
      }

      const user =
        await findUserByEmail(
          email
        );

      if (!user) {
        return res.status(404).json({
          ok: false,
          error: "User not found.",
        });
      }

      const credits =
        await getCreditStore();

      if (!credits[user.id]) {
        credits[user.id] = {
          balance: 0,
          issued: 0,
          consumed: 0,
          refunded: 0,
          purchased: 0,
        };
      }

      credits[user.id].balance =
        Math.max(
          0,
          Number(
            credits[user.id].balance ||
              0
          ) + amount
        );

      credits[user.id].issued +=
        amount > 0 ? amount : 0;

      credits[user.id].updatedAt =
        new Date().toISOString();

      await saveCreditStore(
        credits
      );

      await securityLog(
        "ADMIN_CREDIT_ADJUSTMENT",
        req.user,
        email
      );

      res.json({
        ok: true,
        balance:
          credits[user.id].balance,
      });
    } catch (error) {
      await errorLog(error, req);

      res.status(500).json({
        ok: false,
        error:
          "Credit adjustment failed.",
      });
    }
  }
);

// -----------------------------------------------------------------------------
// ADMIN FINANCE
// -----------------------------------------------------------------------------

app.get(
  "/api/admin/finance",
  requireAdmin,
  async (req, res) => {
    const finance =
      await getFinance();

    const gross =
      finance
        .filter(
          x => x.type === "revenue"
        )
        .reduce(
          (a, x) =>
            a +
            Number(
              x.amount || 0
            ),
          0
        );

    const refunds =
      finance
        .filter(
          x => x.type === "refund"
        )
        .reduce(
          (a, x) =>
            a +
            Number(
              x.amount || 0
            ),
          0
        );

    const costs =
      finance
        .filter(
          x => x.type === "cost"
        )
        .reduce(
          (a, x) =>
            a +
            Number(
              x.amount || 0
            ),
          0
        );

    const profit =
      gross -
      refunds -
      costs;

    res.json({
      ok: true,
      grossRevenue: gross,
      refunds,
      totalCosts: costs,
      profit,
      transactions:
        finance.slice(-200).reverse(),
    });
  }
);

app.post(
  "/api/admin/finance/transaction",
  requireAdmin,
  async (req, res) => {
    try {
      const type =
        String(
          req.body?.type || ""
        );

      const amount =
        Number(
          req.body?.amount || 0
        );

      const description =
        String(
          req.body?.description || ""
        );

      if (
        ![
          "revenue",
          "refund",
          "cost",
        ].includes(type) ||
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid financial transaction.",
        });
      }

      await recordFinance({
        type,
        amount,
        currency: "NGN",
        description,
        createdBy:
          req.user.email,
      });

      res.json({
        ok: true,
      });
    } catch (error) {
      await errorLog(error, req);

      res.status(500).json({
        ok: false,
        error:
          "Finance transaction failed.",
      });
    }
  }
);

// -----------------------------------------------------------------------------
// ADMIN PAYMENTS
// -----------------------------------------------------------------------------

app.get(
  "/api/admin/payments",
  requireAdmin,
  async (req, res) => {
    const payments =
      await getPayments();

    res.json({
      ok: true,
      payments:
        payments
          .slice()
          .reverse()
          .slice(0, 500),
    });
  }
);

// Existing dashboard compatibility.
app.get(
  "/api/admin/billing/payments",
  requireAdmin,
  async (req, res) => {
    const payments =
      await getPayments();

    res.json({
      ok: true,
      payments:
        payments
          .slice()
          .reverse()
          .slice(0, 500),
    });
  }
);

// -----------------------------------------------------------------------------
// ADMIN SECURITY
// -----------------------------------------------------------------------------

app.get(
  "/api/admin/security",
  requireAdmin,
  async (req, res) => {
    const logs =
      await readJSON(
        SECURITY_FILE,
        []
      );

    res.json({
      ok: true,
      security:
        logs
          .slice()
          .reverse()
          .slice(0, 500),
    });
  }
);

// -----------------------------------------------------------------------------
// ADMIN ERRORS
// -----------------------------------------------------------------------------

app.get(
  "/api/admin/errors",
  requireAdmin,
  async (req, res) => {
    const errors =
      await readJSON(
        ERRORS_FILE,
        []
      );

    res.json({
      ok: true,
      errors:
        errors
          .slice()
          .reverse()
          .slice(0, 500),
    });
  }
);

// -----------------------------------------------------------------------------
// ADMIN WITHDRAWALS
// -----------------------------------------------------------------------------

app.get(
  "/api/admin/withdrawals",
  requireAdmin,
  async (req, res) => {
    const withdrawals =
      await readJSON(
        WITHDRAWALS_FILE,
        []
      );

    res.json({
      ok: true,
      withdrawals:
        withdrawals
          .slice()
          .reverse()
          .slice(0, 500),
      paystackConfigured:
        Boolean(
          PAYSTACK_SECRET_KEY
        ),
    });
  }
);

// Paystack transfers require a configured Paystack account
// and recipient/transfer setup. This route safely refuses
// to pretend a bank withdrawal happened.
app.post(
  "/api/admin/withdraw",
  requireAdmin,
  async (req, res) => {
    try {
      if (!PAYSTACK_SECRET_KEY) {
        return res.status(503).json({
          ok: false,
          configured: false,
          error:
            "Paystack is not configured. Add PAYSTACK_SECRET_KEY after creating your Paystack business account.",
        });
      }

      const amount =
        Number(
          req.body?.amount || 0
        );

      const accountNumber =
        String(
          req.body?.accountNumber || ""
        ).trim();

      const bankCode =
        String(
          req.body?.bankCode || ""
        ).trim();

      const reason =
        String(
          req.body?.reason ||
            "MAMAKI profit withdrawal"
        );

      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        !accountNumber ||
        !bankCode
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Amount, bank account number and bank code are required.",
        });
      }

      const recipientResponse =
        await fetch(
          "https://api.paystack.co/transferrecipient",
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET_KEY}`,
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify({
              type: "nuban",
              name:
                String(
                  req.body?.accountName ||
                    "MAMAKI Owner"
                ),
              account_number:
                accountNumber,
              bank_code:
                bankCode,
              currency: "NGN",
            }),
          }
        );

      const recipientData =
        await recipientResponse.json();

      if (
        !recipientResponse.ok ||
        !recipientData.status
      ) {
        throw new Error(
          recipientData?.message ||
            "Unable to create Paystack transfer recipient."
        );
      }

      const transferResponse =
        await fetch(
          "https://api.paystack.co/transfer",
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${PAYSTACK_SECRET_KEY}`,
              "Content-Type":
                "application/json",
            },
            body: JSON.stringify({
              source: "balance",
              amount:
                Math.round(
                  amount * 100
                ),
              recipient:
                recipientData.data.recipient_code,
              reason,
            }),
          }
        );

      const transferData =
        await transferResponse.json();

      if (
        !transferResponse.ok ||
        !transferData.status
      ) {
        throw new Error(
          transferData?.message ||
            "Paystack transfer failed."
        );
      }

      const withdrawals =
        await readJSON(
          WITHDRAWALS_FILE,
          []
        );

      withdrawals.push({
        id: randomUUID(),
        reference:
          transferData.data.reference,
        amount,
        currency: "NGN",
        status:
          transferData.data.status ||
          "pending",
        account:
          `****${accountNumber.slice(-4)}`,
        reason,
        createdAt:
          new Date().toISOString(),
      });

      await writeJSON(
        WITHDRAWALS_FILE,
        withdrawals
      );

      await recordFinance({
        type: "cost",
        amount,
        currency: "NGN",
        description:
          `Owner profit withdrawal: ${reason}`,
      });

      res.json({
        ok: true,
        reference:
          transferData.data.reference,
        status:
          transferData.data.status,
      });
    } catch (error) {
      await errorLog(error, req);

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Withdrawal failed.",
      });
    }
  }
);

// -----------------------------------------------------------------------------
// ADMIN PAGE
// -----------------------------------------------------------------------------

function adminPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI Admin</title>
<meta name="theme-color" content="#050509">

<style>
*{box-sizing:border-box}

body{
  margin:0;
  font-family:Inter,Arial,sans-serif;
  background:#050509;
  color:#f7f7fb;
}

button,input,select{
  font:inherit;
}

button{
  cursor:pointer;
}

.top{
  position:sticky;
  top:0;
  z-index:20;
  padding:18px;
  background:#08080d;
  border-bottom:1px solid #22222d;
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:15px;
}

.brand{
  font-size:21px;
  font-weight:800;
}

.muted{
  color:#9696a6;
}

.actions{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
}

.btn{
  border:1px solid #30303b;
  background:#15151d;
  color:white;
  border-radius:10px;
  padding:10px 15px;
}

.btn:hover{
  background:#20202a;
}

.btn.primary{
  background:#fff;
  color:#000;
}

.wrap{
  width:min(1400px,94%);
  margin:25px auto 60px;
}

.grid{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:14px;
}

@media(max-width:900px){
  .grid{
    grid-template-columns:repeat(2,1fr);
  }
}

@media(max-width:550px){
  .grid{
    grid-template-columns:1fr;
  }
}

.card{
  background:#101017;
  border:1px solid #252531;
  border-radius:17px;
  padding:18px;
}

.card h2{
  margin-top:0;
}

.stat{
  font-size:29px;
  font-weight:800;
  margin-top:8px;
}

.section{
  margin-top:20px;
}

.two{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:16px;
}

@media(max-width:800px){
  .two{
    grid-template-columns:1fr;
  }
}

.good{
  color:#66e09a;
}

.warn{
  color:#ffd36b;
}

.bad{
  color:#ff7777;
}

table{
  width:100%;
  border-collapse:collapse;
  min-width:700px;
}

.tableWrap{
  overflow:auto;
}

th,td{
  text-align:left;
  padding:11px;
  border-bottom:1px solid #24242e;
  font-size:13px;
}

th{
  color:#aaaabb;
}

.price{
  font-size:25px;
  font-weight:800;
}

input,select{
  width:100%;
  padding:11px;
  border-radius:10px;
  border:1px solid #30303b;
  background:#08080d;
  color:#fff;
  margin:6px 0;
}

.form{
  display:grid;
  gap:8px;
}

.login{
  width:min(430px,92%);
  margin:100px auto;
}

.hidden{
  display:none!important;
}

.badge{
  display:inline-block;
  padding:5px 9px;
  border-radius:99px;
  background:#191922;
  font-size:12px;
}

.notice{
  background:#16161f;
  border:1px solid #292936;
  padding:14px;
  border-radius:12px;
  margin-bottom:15px;
}
</style>
</head>

<body>

<div id="login" class="login card">
  <div class="brand">✨ MAMAKI ADMIN</div>
  <p class="muted">
    Private administrator dashboard.
  </p>

  <div class="form">
    <input id="email" type="email"
      placeholder="Administrator email">

    <input id="password" type="password"
      placeholder="Administrator password">

    <button class="btn primary"
      onclick="login()">
      Administrator Login
    </button>
  </div>

  <p id="loginError" class="bad"></p>
</div>

<div id="app" class="hidden">

<header class="top">
  <div>
    <div class="brand">✨ MAMAKI ADMIN</div>
    <div class="muted">
      Administrator dashboard connected.
    </div>
  </div>

  <div class="actions">
    <a class="btn"
       href="/"
       style="text-decoration:none">
       MAMAKI Interface
    </a>

    <button class="btn"
      onclick="loadAll()">
      Refresh
    </button>

    <button class="btn"
      onclick="logout()">
      Logout
    </button>
  </div>
</header>

<main class="wrap">

<div id="notice" class="notice"></div>

<section class="grid">

<div class="card">
<div class="muted">Total Users</div>
<div id="users" class="stat">0</div>
</div>

<div class="card">
<div class="muted">Live / Active</div>
<div id="live" class="stat">0</div>
</div>

<div class="card">
<div class="muted">New Today</div>
<div id="today" class="stat">0</div>
</div>

<div class="card">
<div class="muted">New This Week</div>
<div id="week" class="stat">0</div>
</div>

<div class="card">
<div class="muted">New This Month</div>
<div id="month" class="stat">0</div>
</div>

<div class="card">
<div class="muted">Total Admins</div>
<div id="admins" class="stat">0</div>
</div>

<div class="card">
<div class="muted">Videos Generated</div>
<div id="videos" class="stat">0</div>
</div>

<div class="card">
<div class="muted">AI Seconds</div>
<div id="seconds" class="stat">0</div>
</div>

<div class="card">
<div class="muted">MAMAKI Credits</div>
<div id="credits" class="stat">0</div>
</div>

<div class="card">
<div class="muted">Profit</div>
<div id="profit" class="stat">₦0.00</div>
</div>

</section>

<section class="two section">

<div class="card">
<h2>Replicate & AI Provider</h2>
<div>
Status:
<span id="replicateStatus"
 class="badge">
 Checking...
</span>
</div>
<p class="muted">
Provider capacity is based on MAMAKI configuration.
</p>
<p>
Provider Balance:
<strong>$0.00</strong>
</p>
<p class="muted">
Replicate does not expose an authoritative
prepaid balance through the public account API.
MAMAKI will not fabricate a balance.
</p>
</div>

<div class="card">
<h2>Smart Credit Pricing & FX</h2>
<p>
USD → NGN:
<strong id="fx">---</strong>
</p>
<p>
FX status:
<strong id="fxStatus">---</strong>
</p>
<p>
Last update:
<span id="fxUpdated">---</span>
</p>
<p>
MAMAKI fixed markup:
<strong>₦200 per USD</strong>
</p>
<p>
Target pricing is automatically calculated from
the live USD/NGN rate plus the MAMAKI margin.
</p>
<div id="packages"></div>
<p>
Paystack:
<strong id="paystack">---</strong>
</p>
</div>

</section>

<section class="two section">

<div class="card">
<h2>Business & Finance</h2>
<p>
Gross Revenue:
<strong id="gross">₦0.00</strong>
</p>
<p>
Refunds:
<strong id="refunds">₦0.00</strong>
</p>
<p>
Total Costs:
<strong id="costs">₦0.00</strong>
</p>
<p>
Profit:
<strong id="financeProfit">₦0.00</strong>
</p>
</div>

<div class="card">
<h2>Owner Profit Withdrawal</h2>

<p class="muted">
Paystack must be configured before live bank
withdrawals can be made.
</p>

<div class="form">
<input id="withdrawAmount"
 type="number"
 placeholder="Amount in NGN">

<input id="accountName"
 placeholder="Bank account name">

<input id="accountNumber"
 placeholder="Bank account number">

<input id="bankCode"
 placeholder="Bank code">

<input id="withdrawReason"
 placeholder="Reason">

<button class="btn primary"
 onclick="withdrawProfit()">
 Withdraw Profit
</button>
</div>

<p id="withdrawResult"></p>
</div>

</section>

<section class="card section">
<h2>Manual MAMAKI Credit Adjustment</h2>

<div class="two">
<div>
<input id="creditEmail"
 placeholder="User email">
</div>

<div>
<input id="creditAmount"
 type="number"
 placeholder="Credits to add/remove">
</div>
</div>

<button class="btn primary"
 onclick="adjustCredits()">
 Apply Credit Adjustment
</button>

<p id="creditResult"></p>
</section>

<section class="card section">
<h2>Users</h2>
<div class="tableWrap">
<table>
<thead>
<tr>
<th>Name</th>
<th>Email</th>
<th>Role</th>
<th>Credits</th>
<th>Videos</th>
<th>AI Seconds</th>
<th>Created</th>
</tr>
</thead>
<tbody id="userRows"></tbody>
</table>
</div>
</section>

<section class="card section">
<h2>Payments</h2>
<div class="tableWrap">
<table>
<thead>
<tr>
<th>Reference</th>
<th>Email</th>
<th>Credits</th>
<th>Amount</th>
<th>Currency</th>
<th>Status</th>
<th>Date</th>
</tr>
</thead>
<tbody id="paymentRows"></tbody>
</table>
</div>
</section>

<section class="card section">
<h2>Security Activity</h2>
<div class="tableWrap">
<table>
<thead>
<tr>
<th>Action</th>
<th>Email/User</th>
<th>Reference</th>
<th>Date</th>
</tr>
</thead>
<tbody id="securityRows"></tbody>
</table>
</div>
</section>

<section class="card section">
<h2>Errors</h2>
<div class="tableWrap">
<table>
<thead>
<tr>
<th>Message</th>
<th>Path</th>
<th>Method</th>
<th>Date</th>
</tr>
</thead>
<tbody id="errorRows"></tbody>
</table>
</div>
</section>

<section class="card section">
<h2>Withdrawal History</h2>
<div class="tableWrap">
<table>
<thead>
<tr>
<th>Reference</th>
<th>Amount</th>
<th>Status</th>
<th>Account</th>
<th>Date</th>
</tr>
</thead>
<tbody id="withdrawRows"></tbody>
</table>
</div>
</section>

</main>
</div>

<script>
const TOKEN_KEY = "mamaki_token";

function token(){
  return localStorage.getItem(TOKEN_KEY) || "";
}

async function api(url, options={}){
  options.headers = {
    ...(options.headers || {}),
    "Authorization":
      "Bearer " + token(),
    "Content-Type":
      "application/json"
  };

  const response =
    await fetch(url, options);

  const text =
    await response.text();

  let data;

  try{
    data = JSON.parse(text);
  }catch{
    throw new Error(
      "Server returned an invalid response."
    );
  }

  if(!response.ok){
    throw new Error(
      data.error ||
      "Request failed."
    );
  }

  return data;
}

async function login(){
  const email =
    document.getElementById("email").value.trim();

  const password =
    document.getElementById("password").value;

  const error =
    document.getElementById("loginError");

  error.textContent = "";

  try{
    const response =
      await fetch(
        "/api/auth/login",
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

    if(!response.ok){
      throw new Error(
        data.error ||
        "Invalid credentials."
      );
    }

    if(data.user.role !== "admin"){
      throw new Error(
        "This account is not an administrator."
      );
    }

    localStorage.setItem(
      TOKEN_KEY,
      data.token
    );

    await openDashboard();

  }catch(e){
    error.textContent =
      e.message;
  }
}

async function openDashboard(){
  try{
    const me =
      await api("/api/auth/me");

    if(me.user.role !== "admin"){
      throw new Error(
        "Administrator access denied."
      );
    }

    document
      .getElementById("login")
      .classList.add("hidden");

    document
      .getElementById("app")
      .classList.remove("hidden");

    await loadAll();

  }catch(e){
    localStorage.removeItem(
      TOKEN_KEY
    );

    document
      .getElementById("login")
      .classList.remove("hidden");

    document
      .getElementById("app")
      .classList.add("hidden");

    document
      .getElementById("loginError")
      .textContent =
      e.message;
  }
}

async function logout(){
  try{
    await api(
      "/api/auth/logout",
      {method:"POST"}
    );
  }catch{}

  localStorage.removeItem(
    TOKEN_KEY
  );

  location.reload();
}

function money(value){
  return "₦" +
    Number(value || 0)
      .toLocaleString(
        "en-NG",
        {
          minimumFractionDigits:2,
          maximumFractionDigits:2
        }
      );
}

function safe(value){
  return String(
    value ?? ""
  )
  .replaceAll("&","&amp;")
  .replaceAll("<","&lt;")
  .replaceAll(">","&gt;")
  .replaceAll('"',"&quot;");
}

function date(value){
  if(!value) return "-";

  const d =
    new Date(value);

  if(Number.isNaN(d.getTime()))
    return safe(value);

  return d.toLocaleString();
}

async function loadAll(){
  try{
    const [
      stats,
      billing,
      finance,
      users,
      payments,
      security,
      errors,
      withdrawals
    ] = await Promise.all([
      api("/api/admin/stats"),
      api("/api/admin/billing"),
      api("/api/admin/finance"),
      api("/api/admin/users"),
      api("/api/admin/payments"),
      api("/api/admin/security"),
      api("/api/admin/errors"),
      api("/api/admin/withdrawals")
    ]);

    document.getElementById("users")
      .textContent = stats.users;

    document.getElementById("live")
      .textContent = stats.liveActive;

    document.getElementById("today")
      .textContent = stats.newToday;

    document.getElementById("week")
      .textContent = stats.newWeek;

    document.getElementById("month")
      .textContent = stats.newMonth;

    document.getElementById("admins")
      .textContent = stats.admins;

    document.getElementById("videos")
      .textContent = stats.videosGenerated;

    document.getElementById("seconds")
      .textContent = stats.aiSeconds;

    document.getElementById("credits")
      .textContent =
      Number(stats.credits || 0)
        .toLocaleString();

    document.getElementById("profit")
      .textContent =
      money(stats.profit);

    document.getElementById("gross")
      .textContent =
      money(finance.grossRevenue);

    document.getElementById("refunds")
      .textContent =
      money(finance.refunds);

    document.getElementById("costs")
      .textContent =
      money(finance.totalCosts);

    document.getElementById("financeProfit")
      .textContent =
      money(finance.profit);

    document.getElementById("replicateStatus")
      .textContent =
      billing.configured
        ? "CONFIGURED"
        : "NOT CONFIGURED";

    document.getElementById("replicateStatus")
      .className =
      "badge " +
      (billing.configured
        ? "good"
        : "warn");

    document.getElementById("fx")
      .textContent =
      Number(
        billing.fx.usdNgnRate
      ).toLocaleString(
        "en-NG",
        {
          minimumFractionDigits:2
        }
      );

    document.getElementById("fxStatus")
      .textContent =
      billing.fx.status;

    document.getElementById("fxUpdated")
      .textContent =
      date(
        billing.fx.updatedAt
      );

    document.getElementById("paystack")
      .textContent =
      billing.paystack.status;

    document.getElementById("packages")
      .innerHTML =
      billing.packages.map(
        p =>
        "<div style='margin:8px 0'>" +
        "<strong>" +
        safe(
          p.credits.toLocaleString()
        ) +
        " credits</strong>: " +
        money(p.priceNgn) +
        "</div>"
      ).join("");

    document.getElementById("notice")
      .innerHTML =
      billing.paystack.configured
      ? "<span class='good'>Paystack is configured.</span> Live payment initialization is available."
      : "<span class='warn'>Paystack is NOT configured.</span> MAMAKI pricing is ready, but live payments cannot be accepted until PAYSTACK_SECRET_KEY is added to Render.";

    document.getElementById("userRows")
      .innerHTML =
      users.users.map(
        u =>
        "<tr>" +
        "<td>" + safe(u.name) + "</td>" +
        "<td>" + safe(u.email) + "</td>" +
        "<td>" + safe(u.role) + "</td>" +
        "<td>" +
        Number(u.credits || 0)
          .toLocaleString() +
        "</td>" +
        "<td>" +
        Number(u.videos || 0)
          .toLocaleString() +
        "</td>" +
        "<td>" +
        Number(u.aiSeconds || 0)
          .toLocaleString() +
        "</td>" +
        "<td>" +
        date(u.createdAt) +
        "</td>" +
        "</tr>"
      ).join("");

    document.getElementById("paymentRows")
      .innerHTML =
      payments.payments.map(
        p =>
        "<tr>" +
        "<td>" + safe(p.reference) + "</td>" +
        "<td>" + safe(p.email) + "</td>" +
        "<td>" + safe(p.credits) + "</td>" +
        "<td>" + money(p.amount) + "</td>" +
        "<td>" + safe(p.currency) + "</td>" +
        "<td>" + safe(p.status) + "</td>" +
        "<td>" + date(p.createdAt) + "</td>" +
        "</tr>"
      ).join("");

    document.getElementById("securityRows")
      .innerHTML =
      security.security.map(
        s =>
        "<tr>" +
        "<td>" + safe(s.action) + "</td>" +
        "<td>" +
        safe(s.email || s.userId) +
        "</td>" +
        "<td>" + safe(s.reference) + "</td>" +
        "<td>" + date(s.date) + "</td>" +
        "</tr>"
      ).join("");

    document.getElementById("errorRows")
      .innerHTML =
      errors.errors.map(
        e =>
        "<tr>" +
        "<td>" + safe(e.message) + "</td>" +
        "<td>" + safe(e.path) + "</td>" +
        "<td>" + safe(e.method) + "</td>" +
        "<td>" + date(e.date) + "</td>" +
        "</tr>"
      ).join("");

    document.getElementById("withdrawRows")
      .innerHTML =
      withdrawals.withdrawals.map(
        w =>
        "<tr>" +
        "<td>" + safe(w.reference) + "</td>" +
        "<td>" + money(w.amount) + "</td>" +
        "<td>" + safe(w.status) + "</td>" +
        "<td>" + safe(w.account) + "</td>" +
        "<td>" + date(w.createdAt) + "</td>" +
        "</tr>"
      ).join("");

  }catch(e){
    document.getElementById("notice")
      .textContent =
      e.message;
  }
}

async function adjustCredits(){
  const email =
    document.getElementById(
      "creditEmail"
    ).value.trim();

  const amount =
    Number(
      document.getElementById(
        "creditAmount"
      ).value
    );

  try{
    const data =
      await api(
        "/api/admin/credits/adjust",
        {
          method:"POST",
          body:JSON.stringify({
            email,
            amount
          })
        }
      );

    document.getElementById(
      "creditResult"
    ).textContent =
      "Updated balance: " +
      Number(
        data.balance || 0
      ).toLocaleString();

    await loadAll();

  }catch(e){
    document.getElementById(
      "creditResult"
    ).textContent =
      e.message;
  }
}

async function withdrawProfit(){
  const amount =
    Number(
      document.getElementById(
        "withdrawAmount"
      ).value
    );

  const accountName =
    document.getElementById(
      "accountName"
    ).value.trim();

  const accountNumber =
    document.getElementById(
      "accountNumber"
    ).value.trim();

  const bankCode =
    document.getElementById(
      "bankCode"
    ).value.trim();

  const reason =
    document.getElementById(
      "withdrawReason"
    ).value.trim();

  const result =
    document.getElementById(
      "withdrawResult"
    );

  try{
    const data =
      await api(
        "/api/admin/withdraw",
        {
          method:"POST",
          body:JSON.stringify({
            amount,
            accountName,
            accountNumber,
            bankCode,
            reason
          })
        }
      );

    result.className =
      "good";

    result.textContent =
      "Withdrawal submitted. Reference: " +
      data.reference;

    await loadAll();

  }catch(e){
    result.className =
      "bad";

    result.textContent =
      e.message;
  }
}

if(token()){
  openDashboard();
}
</script>

</body>
</html>`;
}

app.get(
  ["/admin", "/admin/"],
  async (req, res) => {
    res
      .status(200)
      .type("html")
      .send(adminPage());
  }
);

// -----------------------------------------------------------------------------
// HEALTH
// -----------------------------------------------------------------------------

app.get(
  "/health",
  async (req, res) => {
    res.json({
      ok: true,
      status: "healthy",
      service:
        "MAMAKI AI Video Creative Studio",
      version: appVersion,
      uptime:
        process.uptime(),
      timestamp:
        new Date().toISOString(),
      checks: {
        server: true,
        ffmpeg: Boolean(ffmpegPath),
        replicateConfigured:
          Boolean(
            REPLICATE_API_TOKEN
          ),
        adminConfigured:
          Boolean(
            ADMIN_EMAIL &&
            ADMIN_PASSWORD
          ),
        paystackConfigured:
          Boolean(
            PAYSTACK_SECRET_KEY
          ),
      },
    });
  }
);

// -----------------------------------------------------------------------------
// OUTPUTS
// -----------------------------------------------------------------------------

app.use(
  "/outputs",
  express.static(
    OUTPUTS,
    {
      fallthrough: false,
      maxAge: "1h",
    }
  )
);

// -----------------------------------------------------------------------------
// NORMAL MAMAKI INTERFACE
// -----------------------------------------------------------------------------
//
// IMPORTANT:
// /admin is handled BEFORE this function.
// Therefore the admin dashboard can never accidentally become
// the normal MAMAKI interface.

async function serveFrontend(
  req,
  res,
  next
) {
  if (
    req.path.startsWith("/api") ||
    req.path.startsWith("/outputs") ||
    req.path === "/health" ||
    req.path === "/admin" ||
    req.path === "/admin/"
  ) {
    return next();
  }

  const indexPath =
    path.join(
      ROOT,
      "index.html"
    );

  if (!(await exists(indexPath))) {
    return res
      .status(404)
      .send(
        "MAMAKI AI interface not found."
      );
  }

  let html =
    await fs.readFile(
      indexPath,
      "utf8"
    );

  // ---------------------------------------------------------------------------
  // MAMAKI CREDIT WIDGET
  // ---------------------------------------------------------------------------
  //
  // Injected automatically into the existing interface.
  // It does NOT expose:
  // - live USD/NGN rate
  // - MAMAKI's ₦200 markup
  // - provider cost
  // - profit
  //
  // Users see only their credits and MAMAKI's final package prices.

  const billingWidget = `
<style>
#mamaki-credit-widget{
  position:fixed;
  right:18px;
  bottom:18px;
  z-index:99999;
  font-family:Arial,sans-serif;
}
#mamaki-credit-button{
  border:0;
  border-radius:999px;
  padding:13px 18px;
  background:#fff;
  color:#000;
  font-weight:800;
  cursor:pointer;
  box-shadow:0 10px 35px rgba(0,0,0,.35);
}
#mamaki-credit-panel{
  display:none;
  position:absolute;
  right:0;
  bottom:58px;
  width:min(390px,calc(100vw - 30px));
  background:#101017;
  color:#fff;
  border:1px solid #292936;
  border-radius:18px;
  padding:18px;
  box-shadow:0 18px 50px rgba(0,0,0,.5);
}
#mamaki-credit-panel.open{
  display:block;
}
.mamaki-credit-row{
  display:flex;
  justify-content:space-between;
  gap:10px;
  padding:8px 0;
  border-bottom:1px solid #24242d;
}
.mamaki-credit-package{
  margin-top:10px;
  padding:13px;
  border-radius:13px;
  background:#181821;
  border:1px solid #2b2b36;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
}
.mamaki-credit-package button{
  border:0;
  border-radius:9px;
  padding:8px 12px;
  background:#fff;
  color:#000;
  font-weight:700;
  cursor:pointer;
}
#mamaki-credit-message{
  margin-top:10px;
  font-size:13px;
  color:#aaa;
}
</style>

<div id="mamaki-credit-widget">

<button id="mamaki-credit-button">
✨ Buy MAMAKI Credits
</button>

<div id="mamaki-credit-panel">

<div style="font-size:20px;font-weight:800">
✨ MAMAKI Credits
</div>

<div style="margin-top:10px;color:#999">
Use MAMAKI credits to create AI videos.
</div>

<div class="mamaki-credit-row">
<span>Available Credits</span>
<strong id="mamaki-credit-balance">---</strong>
</div>

<div style="margin-top:14px;font-weight:700">
Credit Packages
</div>

<div id="mamaki-credit-packages">
Loading...
</div>

<div id="mamaki-credit-message">
</div>

</div>
</div>

<script>
(function(){

const KEY = "mamaki_token";

function getToken(){
  return localStorage.getItem(KEY) || "";
}

async function request(url, options={}){
  options.headers = {
    ...(options.headers || {}),
    "Authorization":
      "Bearer " + getToken()
  };

  const response =
    await fetch(url, options);

  const text =
    await response.text();

  let data;

  try{
    data = JSON.parse(text);
  }catch{
    throw new Error(
      "The server returned an invalid response."
    );
  }

  if(!response.ok){
    throw new Error(
      data.error ||
      "Request failed."
    );
  }

  return data;
}

function money(value){
  return "₦" +
    Number(value || 0)
      .toLocaleString(
        "en-NG",
        {
          maximumFractionDigits:0
        }
      );
}

async function loadCredits(){
  try{
    const data =
      await request(
        "/api/credits"
      );

    document.getElementById(
      "mamaki-credit-balance"
    ).textContent =
      Number(
        data.credits.balance || 0
      ).toLocaleString();

  }catch{
    document.getElementById(
      "mamaki-credit-balance"
    ).textContent =
      "---";
  }
}

async function loadPackages(){
  try{
    const data =
      await request(
        "/api/billing/pricing"
      );

    const box =
      document.getElementById(
        "mamaki-credit-packages"
      );

    box.innerHTML =
      data.packages.map(
        p =>
        "<div class='mamaki-credit-package'>" +
        "<div>" +
        "<strong>" +
        Number(p.credits)
          .toLocaleString() +
        " credits</strong>" +
        "<div style='margin-top:4px;font-size:18px;font-weight:800'>" +
        money(p.priceNgn) +
        "</div>" +
        "</div>" +
        "<button data-credit='" +
        p.credits +
        "'>" +
        "Buy" +
        "</button>" +
        "</div>"
      ).join("");

    box.querySelectorAll(
      "button[data-credit]"
    ).forEach(
      button => {
        button.addEventListener(
          "click",
          async function(){
            const credits =
              Number(
                this.dataset.credit
              );

            const message =
              document.getElementById(
                "mamaki-credit-message"
              );

            message.textContent =
              "Opening secure payment...";

            try{
              const result =
                await request(
                  "/api/billing/paystack/initialize",
                  {
                    method:"POST",
                    headers:{
                      "Content-Type":
                        "application/json"
                    },
                    body:JSON.stringify({
                      credits
                    })
                  }
                );

              if(
                result.authorizationUrl
              ){
                window.location.href =
                  result.authorizationUrl;
              }else{
                throw new Error(
                  "Payment link was not returned."
                );
              }

            }catch(error){
              message.textContent =
                error.message;
            }
          }
        );
      }
    );

  }catch(error){
    document.getElementById(
      "mamaki-credit-packages"
    ).innerHTML =
      "<div style='color:#ff8888'>" +
      "Payment is not currently configured." +
      "</div>";
  }
}

async function openWidget(){
  const panel =
    document.getElementById(
      "mamaki-credit-panel"
    );

  panel.classList.toggle(
    "open"
  );

  if(panel.classList.contains("open")){
    await loadCredits();
    await loadPackages();
  }
}

document.getElementById(
  "mamaki-credit-button"
).addEventListener(
  "click",
  openWidget
);

// Refresh credit balance periodically.
loadCredits();

setInterval(
  loadCredits,
  30000
);

})();
</script>
`;

  if (
    html.includes("</body>")
  ) {
    html =
      html.replace(
        "</body>",
        billingWidget +
        "</body>"
      );
  } else {
    html += billingWidget;
  }

  res.type("html").send(html);
}

app.use(
  serveFrontend
);

// -----------------------------------------------------------------------------
// ERROR HANDLER
// -----------------------------------------------------------------------------

app.use(
  async (error, req, res, next) => {
    await errorLog(
      error,
      req
    ).catch(() => {});

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Internal server error.",
    });
  }
);

// -----------------------------------------------------------------------------
// START
// -----------------------------------------------------------------------------

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `MAMAKI AI ${appVersion} running on ${HOST}:${PORT}`
    );

    console.log(
      `Admin dashboard: ${APP_URL}/admin`
    );

    console.log(
      `Replicate configured: ${Boolean(
        REPLICATE_API_TOKEN
      )}`
    );

    console.log(
      `Paystack configured: ${Boolean(
        PAYSTACK_SECRET_KEY
      )}`
    );

    console.log(
      `MAMAKI markup: ₦${MAMAKI_MARKUP_NGN} per USD`
    );
  }
);
