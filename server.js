// GitHub editor: https://github.com/shamakishadrack-star/mamaki-ai-video/edit/main/server.js
// MAMAKI AI VIDEO — COMPLETE SERVER
// Billing model: LIVE USD/NGN RATE + FIXED ₦200 MAMAKI MARKUP PER USD
// Customer never sees the FX rate or markup.
// 100 MAMAKI credits = 1 MAMAKI USD unit.
// Video generation cost is calculated automatically and enforced server-side.

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
  createHmac
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
const SECURITY_FILE = path.join(DATA, "security.json");
const CREDITS_FILE = path.join(DATA, "credits.json");
const FINANCE_FILE = path.join(DATA, "finance.json");
const PRICING_FILE = path.join(DATA, "pricing.json");
const PAYMENTS_FILE = path.join(DATA, "payments.json");
const WITHDRAWALS_FILE = path.join(DATA, "withdrawals.json");

const VERSION = "18.0.0";

const ADMIN_EMAIL =
  String(process.env.ADMIN_EMAIL || "shamakishadrack@gmail.com")
    .trim()
    .toLowerCase();

const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "");

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  createHash("sha256")
    .update(`${ADMIN_EMAIL}:${process.env.RENDER_SERVICE_NAME || "mamaki"}:${ROOT}`)
    .digest("hex");

const REPLICATE_TOKEN =
  process.env.REPLICATE_API_TOKEN ||
  process.env.REPLICATE_API_KEY ||
  "";

const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY ||
  "";

const PAYSTACK_PUBLIC_KEY =
  process.env.PAYSTACK_PUBLIC_KEY ||
  "";

const FX_API_URL =
  process.env.FX_API_URL ||
  "https://open.er-api.com/v6/latest/USD";

const DEFAULT_USD_NGN_RATE =
  Number(process.env.DEFAULT_USD_NGN_RATE || 1600);

const MAMAKI_MARKUP_NGN =
  Number(process.env.MAMAKI_MARKUP_NGN || 200);

const FX_CACHE_MS =
  Number(process.env.FX_CACHE_MS || 30 * 60 * 1000);

const STARTER_CREDITS =
  Number(process.env.STARTER_CREDITS || 100);

const T2V_MODEL =
  process.env.REPLICATE_T2V_MODEL ||
  "wan-video/wan-2.2-t2v-fast";

const I2V_MODEL =
  process.env.REPLICATE_I2V_MODEL ||
  "wan-video/wan-2.2-i2v-fast";

const STYLE_DEFAULT = "Cinematic";

let providerBlocked = false;

let fxCache = {
  rate: null,
  updatedAt: 0,
  source: "none"
};

const replicate = REPLICATE_TOKEN
  ? new Replicate({ auth: REPLICATE_TOKEN })
  : null;

app.disable("x-powered-by");

app.use(
  express.json({
    limit: "10mb",
    verify(req, res, buf) {
      req.rawBody = Buffer.from(buf);
    }
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb"
  })
);

app.use((req, res, next) => {
  res.setHeader("X-MAMAKI-Version", VERSION);
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

/* =========================================================
   STORAGE
========================================================= */

async function ensureStorage() {
  await Promise.all([
    fs.mkdir(DATA, { recursive: true }),
    fs.mkdir(TMP, { recursive: true }),
    fs.mkdir(OUTPUTS, { recursive: true }),
    fs.mkdir(PROJECTS, { recursive: true })
  ]);

  const defaults = [
    [USERS_FILE, []],
    [SESSIONS_FILE, []],
    [ERRORS_FILE, []],
    [USAGE_FILE, {}],
    [SECURITY_FILE, []],
    [CREDITS_FILE, {}],
    [FINANCE_FILE, []],
    [PRICING_FILE, {}],
    [PAYMENTS_FILE, []],
    [WITHDRAWALS_FILE, []]
  ];

  for (const [file, value] of defaults) {
    try {
      await fs.access(file);
    } catch {
      await writeJSON(file, value);
    }
  }
}

async function readJSON(file, fallback) {
  try {
    const text = await fs.readFile(file, "utf8");
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJSON(file, data) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(temp, file);
}

async function updateJSON(file, fallback, updater) {
  const data = await readJSON(file, fallback);
  const result = await updater(data);
  await writeJSON(file, result === undefined ? data : result);
  return result === undefined ? data : result;
}

/* =========================================================
   HELPERS
========================================================= */

function now() {
  return new Date().toISOString();
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function publicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role || "user",
    createdAt: user.createdAt
  };
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(
    String(password),
    salt,
    64
  ).toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, expected] = String(stored).split(":");

    if (!salt || !expected) return false;

    const actual = scryptSync(
      String(password),
      salt,
      64
    ).toString("hex");

    return timingSafeEqual(
      Buffer.from(actual, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

function createSessionToken(userId) {
  const payload = `${userId}.${Date.now()}.${randomBytes(24).toString("hex")}`;

  const signature = createHmac(
    "sha256",
    SESSION_SECRET
  )
    .update(payload)
    .digest("hex");

  return `${payload}.${signature}`;
}

function validateTokenFormat(token) {
  if (!token || typeof token !== "string") return false;

  const parts = token.split(".");

  if (parts.length < 4) return false;

  const signature = parts.pop();
  const payload = parts.join(".");

  const expected = createHmac(
    "sha256",
    SESSION_SECRET
  )
    .update(payload)
    .digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

async function getSessionUser(token) {
  if (!validateTokenFormat(token)) return null;

  const sessions = await readJSON(SESSIONS_FILE, []);
  const session = sessions.find(
    x =>
      x.token === token &&
      Number(x.expiresAt) > Date.now()
  );

  if (!session) return null;

  const users = await readJSON(USERS_FILE, []);

  return users.find(
    u => u.id === session.userId
  ) || null;
}

function getBearer(req) {
  const header = String(
    req.headers.authorization || ""
  );

  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }

  return (
    req.headers["x-session-token"] ||
    req.body?.token ||
    req.query?.token ||
    null
  );
}

async function requireUser(req, res, next) {
  const user = await getSessionUser(getBearer(req));

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: "Authentication required."
    });
  }

  req.user = user;
  next();
}

async function requireAdmin(req, res, next) {
  const user = await getSessionUser(getBearer(req));

  if (!user || user.role !== "admin") {
    return res.status(403).json({
      ok: false,
      error: "Administrator access required."
    });
  }

  req.user = user;
  next();
}

async function recordSecurity(action, user, reference = "", meta = {}) {
  const rows = await readJSON(SECURITY_FILE, []);

  rows.unshift({
    id: randomUUID(),
    action,
    email: user?.email || meta.email || "",
    userId: user?.id || meta.userId || "",
    reference,
    date: now(),
    ip: meta.ip || "",
    meta
  });

  await writeJSON(
    SECURITY_FILE,
    rows.slice(0, 1000)
  );
}

async function recordError(error, req = null) {
  const rows = await readJSON(ERRORS_FILE, []);

  rows.unshift({
    id: randomUUID(),
    message: String(error?.message || error),
    path: req?.path || "",
    method: req?.method || "",
    date: now()
  });

  await writeJSON(
    ERRORS_FILE,
    rows.slice(0, 500)
  );
}

async function getUsage(userId) {
  const usage = await readJSON(USAGE_FILE, {});

  if (!usage[userId]) {
    usage[userId] = {
      aiGenerations: 0,
      aiSeconds: 0,
      studioJobs: 0,
      narrationJobs: 0,
      updatedAt: now()
    };

    await writeJSON(USAGE_FILE, usage);
  }

  return usage[userId];
}

async function addUsage(userId, field, amount = 1) {
  const usage = await readJSON(USAGE_FILE, {});

  if (!usage[userId]) {
    usage[userId] = {
      aiGenerations: 0,
      aiSeconds: 0,
      studioJobs: 0,
      narrationJobs: 0,
      updatedAt: now()
    };
  }

  usage[userId][field] =
    Number(usage[userId][field] || 0) + Number(amount);

  usage[userId].updatedAt = now();

  await writeJSON(USAGE_FILE, usage);
}

/* =========================================================
   FX + MAMAKI SELLING RATE
========================================================= */

async function getLiveFX() {
  const fresh =
    fxCache.rate &&
    Date.now() - fxCache.updatedAt < FX_CACHE_MS;

  if (fresh) {
    return fxCache;
  }

  try {
    const response = await fetch(FX_API_URL, {
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      throw new Error(`FX HTTP ${response.status}`);
    }

    const data = await response.json();

    const rate = Number(
      data?.rates?.NGN
    );

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("Invalid NGN FX rate.");
    }

    fxCache = {
      rate,
      updatedAt: Date.now(),
      source: "live"
    };

    return fxCache;
  } catch (error) {
    await recordError(error);

    fxCache = {
      rate: DEFAULT_USD_NGN_RATE,
      updatedAt: Date.now(),
      source: "fallback"
    };

    return fxCache;
  }
}

function mamakiSellingRate(fxRate) {
  return Number(fxRate) + MAMAKI_MARKUP_NGN;
}

function roundPrice(value) {
  const n = Math.max(0, Number(value) || 0);

  // Professional customer-facing rounding.
  // Examples: 1547 -> 1550, 1549 -> 1550.
  return Math.ceil(n / 50) * 50;
}

function creditsToUSD(credits) {
  return Number(credits) / 100;
}

function packagePriceNGN(credits, sellingRate) {
  return roundPrice(
    creditsToUSD(credits) * sellingRate
  );
}

const CREDIT_PACKAGES = [
  { credits: 100, label: "100 credits" },
  { credits: 500, label: "500 credits" },
  { credits: 1000, label: "1,000 credits" },
  { credits: 2500, label: "2,500 credits" },
  { credits: 5000, label: "5,000 credits" }
];

/* =========================================================
   VIDEO CREDIT CALCULATOR
========================================================= */

// 100 credits = 1 USD-equivalent MAMAKI unit.
// 5 seconds = 10 credits.
// Therefore:
// 5 sec = 10
// 10 sec = 20
// 30 sec = 60
// 60 sec = 120
// 2 min = 240
// etc.

function calculateVideoCredits(seconds, quality = "Standard HD") {
  const duration = clampNumber(
    seconds,
    5,
    7200,
    5
  );

  const qualityMultiplier = {
    "Standard HD": 1,
    "High": 1.5,
    "Cinematic": 2
  };

  const multiplier =
    qualityMultiplier[quality] || 1;

  const base =
    Math.ceil(duration / 5) * 10;

  return Math.max(
    10,
    Math.ceil(base * multiplier)
  );
}

function calculateVideoCost(seconds, quality) {
  const credits = calculateVideoCredits(
    seconds,
    quality
  );

  return {
    credits,
    usdEquivalent: creditsToUSD(credits)
  };
}

/* =========================================================
   CREDIT STORAGE
========================================================= */

async function getCreditRecord(userId) {
  const credits = await readJSON(CREDITS_FILE, {});

  if (!credits[userId]) {
    credits[userId] = {
      balance: STARTER_CREDITS,
      issued: STARTER_CREDITS,
      consumed: 0,
      refunded: 0,
      purchased: 0,
      updatedAt: now()
    };

    await writeJSON(CREDITS_FILE, credits);
  }

  return credits[userId];
}

async function changeCredits(
  userId,
  amount,
  reason = "adjustment",
  reference = ""
) {
  const credits = await readJSON(CREDITS_FILE, {});

  if (!credits[userId]) {
    credits[userId] = {
      balance: STARTER_CREDITS,
      issued: STARTER_CREDITS,
      consumed: 0,
      refunded: 0,
      purchased: 0,
      updatedAt: now()
    };
  }

  const n = Number(amount);

  credits[userId].balance =
    Math.max(
      0,
      Number(credits[userId].balance || 0) + n
    );

  if (n > 0) {
    credits[userId].issued =
      Number(credits[userId].issued || 0) + n;

    if (reason === "purchase") {
      credits[userId].purchased =
        Number(credits[userId].purchased || 0) + n;
    }

    if (reason === "refund") {
      credits[userId].refunded =
        Number(credits[userId].refunded || 0) + n;
    }
  }

  if (n < 0) {
    credits[userId].consumed =
      Number(credits[userId].consumed || 0) + Math.abs(n);
  }

  credits[userId].updatedAt = now();

  await writeJSON(
    CREDITS_FILE,
    credits
  );

  return credits[userId];
}

/* =========================================================
   PROJECT STORAGE
========================================================= */

async function userProjectDir(userId) {
  const dir = path.join(
    PROJECTS,
    String(userId)
  );

  await fs.mkdir(dir, { recursive: true });

  return dir;
}

async function readUserProjects(userId) {
  const dir = await userProjectDir(userId);

  const files = await fs.readdir(
    dir,
    { withFileTypes: true }
  );

  const projects = [];

  for (const entry of files) {
    if (!entry.isFile()) continue;

    if (!entry.name.endsWith(".json")) continue;

    try {
      const item = await readJSON(
        path.join(dir, entry.name),
        null
      );

      if (item) projects.push(item);
    } catch {}
  }

  projects.sort(
    (a, b) =>
      new Date(b.createdAt || 0) -
      new Date(a.createdAt || 0)
  );

  return projects;
}

async function saveProject(userId, project) {
  const dir = await userProjectDir(userId);

  await writeJSON(
    path.join(dir, `${project.id}.json`),
    project
  );

  return project;
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", async (req, res) => {
  let ffmpegOK = false;

  try {
    ffmpegOK = Boolean(
      ffmpegPath &&
      await fs.access(ffmpegPath).then(() => true)
    );
  } catch {}

  res.json({
    ok: true,
    status: "healthy",
    service: "MAMAKI AI Video Creative Studio",
    version: VERSION,
    uptime: process.uptime(),
    timestamp: now(),
    checks: {
      server: true,
      ffmpeg: ffmpegOK,
      replicateConfigured: Boolean(REPLICATE_TOKEN),
      adminConfigured: Boolean(ADMIN_EMAIL && ADMIN_PASSWORD),
      recoveryConfigured: false,
      paystackConfigured: Boolean(PAYSTACK_SECRET_KEY)
    }
  });
});

/* =========================================================
   AUTH
========================================================= */

app.post("/api/auth/register", async (req, res) => {
  try {
    const name =
      String(req.body?.name || "").trim();

    const email =
      safeEmail(req.body?.email);

    const password =
      String(req.body?.password || "");

    if (!name || !email || password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "Name, valid email and password of at least 6 characters are required."
      });
    }

    const users =
      await readJSON(USERS_FILE, []);

    if (
      users.some(
        u => safeEmail(u.email) === email
      )
    ) {
      return res.status(409).json({
        ok: false,
        error: "An account with this email already exists."
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
      createdAt: now()
    };

    users.push(user);

    await writeJSON(
      USERS_FILE,
      users
    );

    await getCreditRecord(user.id);

    const token =
      createSessionToken(user.id);

    const sessions =
      await readJSON(SESSIONS_FILE, []);

    sessions.push({
      token,
      userId: user.id,
      createdAt: Date.now(),
      expiresAt:
        Date.now() +
        30 * 24 * 60 * 60 * 1000
    });

    await writeJSON(
      SESSIONS_FILE,
      sessions.slice(-2000)
    );

    await recordSecurity(
      "REGISTER_SUCCESS",
      user
    );

    res.json({
      ok: true,
      token,
      user: publicUser(user),
      credits: STARTER_CREDITS
    });
  } catch (error) {
    await recordError(error, req);

    res.status(500).json({
      ok: false,
      error: "Registration failed."
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email =
      safeEmail(req.body?.email);

    const password =
      String(req.body?.password || "");

    const users =
      await readJSON(USERS_FILE, []);

    const user =
      users.find(
        u => safeEmail(u.email) === email
      );

    if (!user) {
      await recordSecurity(
        "LOGIN_FAILED",
        null,
        "",
        { email }
      );

      return res.status(401).json({
        ok: false,
        error: "Invalid credentials."
      });
    }

    if (
      !verifyPassword(
        password,
        user.passwordHash
      )
    ) {
      await recordSecurity(
        "LOGIN_FAILED",
        user
      );

      return res.status(401).json({
        ok: false,
        error: "Invalid credentials."
      });
    }

    // Automatically preserve the owner administrator account.
    if (
      safeEmail(user.email) === ADMIN_EMAIL &&
      user.role !== "admin"
    ) {
      user.role = "admin";

      const index =
        users.findIndex(
          u => u.id === user.id
        );

      if (index >= 0) {
        users[index] = user;
        await writeJSON(
          USERS_FILE,
          users
        );
      }
    }

    const token =
      createSessionToken(user.id);

    const sessions =
      await readJSON(SESSIONS_FILE, []);

    sessions.push({
      token,
      userId: user.id,
      createdAt: Date.now(),
      expiresAt:
        Date.now() +
        30 * 24 * 60 * 60 * 1000
    });

    await writeJSON(
      SESSIONS_FILE,
      sessions.slice(-2000)
    );

    await getCreditRecord(user.id);

    await recordSecurity(
      "LOGIN_SUCCESS",
      user
    );

    res.json({
      ok: true,
      token,
      user: publicUser(user),
      credits:
        (await getCreditRecord(user.id)).balance
    });
  } catch (error) {
    await recordError(error, req);

    res.status(500).json({
      ok: false,
      error: "Login failed."
    });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  const token = getBearer(req);

  if (token) {
    const sessions =
      await readJSON(SESSIONS_FILE, []);

    await writeJSON(
      SESSIONS_FILE,
      sessions.filter(
        s => s.token !== token
      )
    );
  }

  res.json({ ok: true });
});

app.get("/api/auth/me", requireUser, async (req, res) => {
  const credits =
    await getCreditRecord(req.user.id);

  res.json({
    ok: true,
    user: publicUser(req.user),
    credits: credits.balance
  });
});

/* =========================================================
   CREDIT API
========================================================= */

app.get("/api/credits", requireUser, async (req, res) => {
  const record =
    await getCreditRecord(req.user.id);

  res.json({
    ok: true,
    credits: {
      available: Number(record.balance || 0),
      remaining: Number(record.balance || 0),
      issued: Number(record.issued || 0),
      consumed: Number(record.consumed || 0),
      refunded: Number(record.refunded || 0),
      purchased: Number(record.purchased || 0)
    }
  });
});

app.get("/api/video/cost", requireUser, async (req, res) => {
  const seconds =
    clampNumber(
      req.query.seconds,
      5,
      7200,
      5
    );

  const quality =
    String(
      req.query.quality ||
      "Standard HD"
    );

  const cost =
    calculateVideoCost(
      seconds,
      quality
    );

  const balance =
    (await getCreditRecord(
      req.user.id
    )).balance;

  res.json({
    ok: true,
    seconds,
    quality,
    requiredCredits: cost.credits,
    availableCredits: balance,
    sufficient: balance >= cost.credits,
    // Customer does not need FX details here.
    message:
      balance >= cost.credits
        ? `This video costs ${cost.credits} MAMAKI credits.`
        : `You need ${cost.credits} MAMAKI credits to generate this video.`
  });
});

/* =========================================================
   BILLING PRICING
========================================================= */

app.get("/api/billing/pricing", requireUser, async (req, res) => {
  const fx =
    await getLiveFX();

  const sellingRate =
    mamakiSellingRate(fx.rate);

  const packages =
    CREDIT_PACKAGES.map(pkg => ({
      credits: pkg.credits,
      label: pkg.label,
      currency: "NGN",
      amount: packagePriceNGN(
        pkg.credits,
        sellingRate
      ),
      amountNGN: packagePriceNGN(
        pkg.credits,
        sellingRate
      )
    }));

  // Do NOT expose the FX rate or markup to customers.
  res.json({
    ok: true,
    currency: "NGN",
    packages,
    paymentConfigured:
      Boolean(PAYSTACK_SECRET_KEY),
    paymentMessage:
      PAYSTACK_SECRET_KEY
        ? "Secure payment available."
        : "Online payment is temporarily unavailable."
  });
});

/* =========================================================
   PAYSTACK
========================================================= */

async function paystackRequest(
  endpoint,
  options = {}
) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error(
      "Paystack is not configured."
    );
  }

  const response =
    await fetch(
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

  const data =
    await response.json();

  if (!response.ok || !data.status) {
    throw new Error(
      data?.message ||
      `Paystack request failed (${response.status})`
    );
  }

  return data;
}

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
            "Online payment is temporarily unavailable. Paystack has not been connected yet."
        });
      }

      const credits =
        Number(req.body?.credits);

      const pkg =
        CREDIT_PACKAGES.find(
          x => x.credits === credits
        );

      if (!pkg) {
        return res.status(400).json({
          ok: false,
          error: "Invalid credit package."
        });
      }

      const fx =
        await getLiveFX();

      const sellingRate =
        mamakiSellingRate(fx.rate);

      const amountNGN =
        packagePriceNGN(
          credits,
          sellingRate
        );

      const reference =
        `MAMAKI-${Date.now()}-${randomBytes(5).toString("hex")}`;

      const payment = {
        id: randomUUID(),
        reference,
        userId: req.user.id,
        email: req.user.email,
        credits,
        amount: amountNGN,
        currency: "NGN",
        status: "pending",
        createdAt: now(),
        paidAt: null,
        fxSource: fx.source,
        internalRate: sellingRate
      };

      const payments =
        await readJSON(
          PAYMENTS_FILE,
          []
        );

      payments.unshift(payment);

      await writeJSON(
        PAYMENTS_FILE,
        payments.slice(0, 5000)
      );

      const callbackUrl =
        process.env.PAYSTACK_CALLBACK_URL ||
        `${req.protocol}://${req.get("host")}/api/billing/paystack/callback`;

      const result =
        await paystackRequest(
          "/transaction/initialize",
          {
            method: "POST",
            body: JSON.stringify({
              email: req.user.email,
              amount: Math.round(
                amountNGN * 100
              ),
              currency: "NGN",
              reference,
              callback_url: callbackUrl,
              metadata: {
                mamakiUserId:
                  req.user.id,
                credits,
                mamakiPaymentId:
                  payment.id
              }
            })
          }
        );

      res.json({
        ok: true,
        authorization_url:
          result.data.authorization_url,
        access_code:
          result.data.access_code,
        reference
      });
    } catch (error) {
      await recordError(error, req);

      res.status(500).json({
        ok: false,
        error:
          error.message ||
          "Unable to initialize payment."
      });
    }
  }
);

async function fulfillPayment(
  reference
) {
  const payments =
    await readJSON(
      PAYMENTS_FILE,
      []
    );

  const payment =
    payments.find(
      p => p.reference === reference
    );

  if (!payment) {
    throw new Error(
      "MAMAKI payment reference not found."
    );
  }

  if (payment.status === "success") {
    return payment;
  }

  const verification =
    await paystackRequest(
      `/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: "GET"
      }
    );

  const transaction =
    verification?.data;

  if (
    transaction?.status !== "success"
  ) {
    throw new Error(
      "Payment has not been confirmed."
    );
  }

  if (
    String(transaction.currency || "")
      .toUpperCase() !== "NGN"
  ) {
    throw new Error(
      "Payment currency mismatch."
    );
  }

  const expectedAmount =
    Number(payment.amount) * 100;

  if (
    Number(transaction.amount) !==
    expectedAmount
  ) {
    throw new Error(
      "Payment amount mismatch."
    );
  }

  const index =
    payments.findIndex(
      p => p.reference === reference
    );

  payment.status = "success";
  payment.paidAt = now();
  payment.gatewayReference =
    transaction.reference;

  if (index >= 0) {
    payments[index] = payment;
  }

  await writeJSON(
    PAYMENTS_FILE,
    payments
  );

  await changeCredits(
    payment.userId,
    payment.credits,
    "purchase",
    payment.reference
  );

  await recordSecurity(
    "CREDIT_PURCHASE_SUCCESS",
    {
      id: payment.userId,
      email: payment.email
    },
    payment.reference
  );

  await addFinanceTransaction({
    type: "revenue",
    reference: payment.reference,
    description:
      `MAMAKI credit purchase: ${payment.credits} credits`,
    amount: payment.amount,
    currency: "NGN",
    userId: payment.userId,
    email: payment.email
  });

  return payment;
}

app.get(
  "/api/billing/paystack/callback",
  async (req, res) => {
    const reference =
      String(
        req.query.reference ||
        req.query.trxref ||
        ""
      );

    if (!reference) {
      return res.status(400).send(
        "Missing payment reference."
      );
    }

    try {
      const payment =
        await fulfillPayment(
          reference
        );

      res.send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI Payment</title>
<style>
body{
  margin:0;
  min-height:100vh;
  display:grid;
  place-items:center;
  background:#050509;
  color:white;
  font-family:Arial,sans-serif;
}
.box{
  max-width:520px;
  padding:35px;
  border:1px solid #27272f;
  border-radius:20px;
  background:#111116;
  text-align:center;
}
a{
  display:inline-block;
  margin-top:20px;
  padding:13px 20px;
  border-radius:10px;
  background:#fff;
  color:#000;
  text-decoration:none;
}
</style>
</head>
<body>
<div class="box">
<h1>✨ MAMAKI</h1>
<h2>Payment Successful</h2>
<p>${Number(payment.credits)} MAMAKI credits have been added to your account.</p>
<a href="/">Return to MAMAKI</a>
</div>
</body>
</html>
      `);
    } catch (error) {
      await recordError(error, req);

      res.status(400).send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI Payment</title>
</head>
<body style="font-family:Arial;text-align:center;padding:50px">
<h2>MAMAKI Payment</h2>
<p>Payment could not be confirmed yet.</p>
<p>Please return to MAMAKI and check your credit balance.</p>
<a href="/">Return to MAMAKI</a>
</body>
</html>
      `);
    }
  }
);

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
        signature.length !== expected.length ||
        !timingSafeEqual(
          Buffer.from(signature),
          Buffer.from(expected)
        )
      ) {
        return res.sendStatus(401);
      }

      if (
        req.body?.event ===
        "charge.success"
      ) {
        const reference =
          req.body?.data?.reference;

        if (reference) {
          try {
            await fulfillPayment(
              reference
            );
          } catch (error) {
            await recordError(
              error,
              req
            );
          }
        }
      }

      res.sendStatus(200);
    } catch (error) {
      await recordError(error, req);
      res.sendStatus(200);
    }
  }
);

app.get(
  "/api/billing/payment/:reference",
  requireUser,
  async (req, res) => {
    const payments =
      await readJSON(
        PAYMENTS_FILE,
        []
      );

    const payment =
      payments.find(
        p =>
          p.reference ===
            req.params.reference &&
          p.userId ===
            req.user.id
      );

    if (!payment) {
      return res.status(404).json({
        ok: false,
        error: "Payment not found."
      });
    }

    res.json({
      ok: true,
      payment: {
        reference: payment.reference,
        credits: payment.credits,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        createdAt: payment.createdAt,
        paidAt: payment.paidAt
      }
    });
  }
);

/* =========================================================
   AI GENERATION
========================================================= */

function normalizeRatio(ratio) {
  if (
    ["16:9", "9:16", "1:1"].includes(
      ratio
    )
  ) {
    return ratio;
  }

  return "16:9";
}

function dimensionsForRatio(ratio) {
  return {
    "16:9": {
      width: 1920,
      height: 1080
    },
    "9:16": {
      width: 1080,
      height: 1920
    },
    "1:1": {
      width: 1080,
      height: 1080
    }
  }[ratio];
}

function wanFrames(seconds) {
  return seconds <= 5
    ? 81
    : 121;
}

function enhancedPrompt(
  prompt,
  style
) {
  return [
    String(prompt || "").trim(),
    `Visual style: ${style || STYLE_DEFAULT}.`,
    "High quality cinematic composition.",
    "Natural motion and coherent camera movement.",
    "Strong subject continuity.",
    "No subtitles.",
    "No text overlays.",
    "No logos.",
    "No watermarks except the final MAMAKI branding."
  ].join(" ");
}

async function saveBuffer(
  buffer,
  extension
) {
  const filename =
    `${randomUUID()}${extension}`;

  const full =
    path.join(
      TMP,
      filename
    );

  await fs.writeFile(
    full,
    buffer
  );

  return full;
}

async function downloadURLToFile(
  url,
  outputPath
) {
  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Video download failed: HTTP ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  await fs.writeFile(
    outputPath,
    buffer
  );

  return outputPath;
}

async function watermarkVideo(
  inputPath,
  outputPath
) {
  if (!ffmpegPath) {
    throw new Error(
      "FFmpeg is not available."
    );
  }

  return new Promise(
    (resolve, reject) => {
      const args = [
        "-y",
        "-i",
        inputPath,
        "-vf",
        "drawtext=text='MAMAKI ✨':x=w-tw-28:y=h-th-24:fontsize=24:fontcolor=white@0.88:box=1:boxcolor=black@0.35:boxborderw=8",
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
        outputPath
      ];

      const child =
        spawn(
          ffmpegPath,
          args
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
            resolve(
              outputPath
            );
          } else {
            reject(
              new Error(
                `FFmpeg failed: ${stderr.slice(-2000)}`
              )
            );
          }
        }
      );
    }
  );
}

async function createReplicateVideo({
  prompt,
  imagePath,
  seconds,
  ratio,
  quality,
  style
}) {
  if (!replicate) {
    throw new Error(
      "AI provider is not configured. Add REPLICATE_API_TOKEN."
    );
  }

  if (providerBlocked) {
    throw new Error(
      "AI provider is temporarily unavailable."
    );
  }

  const dimensions =
    dimensionsForRatio(
      ratio
    );

  const frames =
    wanFrames(seconds);

  const enhanced =
    enhancedPrompt(
      prompt,
      style
    );

  const input = {
    prompt: enhanced,
    width: dimensions.width,
    height: dimensions.height,
    num_frames: frames
  };

  if (
    quality === "High"
  ) {
    input.go_fast = true;
  }

  if (
    quality === "Cinematic"
  ) {
    input.go_fast = false;
  }

  if (imagePath) {
    input.image =
      await fs.readFile(
        imagePath
      );

    const result =
      await replicate.run(
        I2V_MODEL,
        { input }
      );

    return extractReplicateURL(
      result
    );
  }

  const result =
    await replicate.run(
      T2V_MODEL,
      { input }
    );

  return extractReplicateURL(
    result
  );
}

function extractReplicateURL(
  result
) {
  if (typeof result === "string") {
    return result;
  }

  if (
    result &&
    typeof result.url === "function"
  ) {
    const value =
      result.url();

    if (value) return String(value);
  }

  if (
    result &&
    typeof result === "object"
  ) {
    if (
      typeof result.url === "string"
    ) {
      return result.url;
    }

    if (
      Array.isArray(result) &&
      result.length
    ) {
      return extractReplicateURL(
        result[0]
      );
    }

    for (
      const key of [
        "video",
        "output",
        "file",
        "url"
      ]
    ) {
      if (result[key]) {
        try {
          return extractReplicateURL(
            result[key]
          );
        } catch {}
      }
    }
  }

  throw new Error(
    "Replicate completed but no video file was returned."
  );
}

app.post(
  "/api/generate",
  requireUser,
  upload.single("image"),
  async (req, res) => {
    let inputPath = null;
    let rawPath = null;

    try {
      const prompt =
        String(
          req.body?.prompt ||
          req.body?.description ||
          ""
        ).trim();

      const seconds =
        clampNumber(
          req.body?.duration ||
          req.body?.seconds,
          5,
          7200,
          5
        );

      const quality =
        String(
          req.body?.quality ||
          "Standard HD"
        );

      const style =
        String(
          req.body?.style ||
          STYLE_DEFAULT
        );

      const ratio =
        normalizeRatio(
          String(
            req.body?.ratio ||
            "16:9"
          )
        );

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error:
            "Please describe the video you want to create."
        });
      }

      const requiredCredits =
        calculateVideoCredits(
          seconds,
          quality
        );

      const creditRecord =
        await getCreditRecord(
          req.user.id
        );

      const available =
        Number(
          creditRecord.balance || 0
        );

      // HARD SERVER-SIDE CREDIT PROTECTION.
      if (
        available <
        requiredCredits
      ) {
        return res.status(402).json({
          ok: false,
          code: "INSUFFICIENT_CREDITS",
          error:
            "You do not have enough MAMAKI credits for this video.",
          requiredCredits,
          availableCredits: available,
          topUpRequired: true
        });
      }

      // Reserve credits before generation.
      await changeCredits(
        req.user.id,
        -requiredCredits,
        "generation",
        ""
      );

      const started =
        Date.now();

      try {
        if (req.file) {
          inputPath =
            await saveBuffer(
              req.file.buffer,
              path.extname(
                req.file.originalname ||
                ".jpg"
              ) || ".jpg"
            );
        }

        const sourceURL =
          await createReplicateVideo({
            prompt,
            imagePath: inputPath,
            seconds,
            ratio,
            quality,
            style
          });

        const rawFilename =
          `${randomUUID()}-raw.mp4`;

        rawPath =
          path.join(
            TMP,
            rawFilename
          );

        await downloadURLToFile(
          sourceURL,
          rawPath
        );

        const finalFilename =
          `${randomUUID()}.mp4`;

        const finalPath =
          path.join(
            OUTPUTS,
            finalFilename
          );

        await watermarkVideo(
          rawPath,
          finalPath
        );

        const project = {
          id: randomUUID(),
          userId: req.user.id,
          title:
            prompt.slice(0, 80),
          prompt,
          style,
          ratio,
          quality,
          duration: seconds,
          creditsUsed:
            requiredCredits,
          videoUrl:
            `/outputs/${finalFilename}`,
          createdAt: now(),
          generationMs:
            Date.now() - started,
          status: "completed"
        };

        await saveProject(
          req.user.id,
          project
        );

        await addUsage(
          req.user.id,
          "aiGenerations",
          1
        );

        await addUsage(
          req.user.id,
          "aiSeconds",
          seconds
        );

        await recordSecurity(
          "AI_GENERATION_SUCCESS",
          req.user,
          project.id
        );

        const remaining =
          (
            await getCreditRecord(
              req.user.id
            )
          ).balance;

        res.json({
          ok: true,
          project,
          videoUrl:
            project.videoUrl,
          requiredCredits,
          usedCredits:
            requiredCredits,
          remainingCredits:
            remaining
        });
      } catch (generationError) {
        // AUTOMATIC REFUND if provider generation fails.
        await changeCredits(
          req.user.id,
          requiredCredits,
          "refund",
          ""
        );

        throw generationError;
      }
    } catch (error) {
      await recordError(
        error,
        req
      );

      const message =
        String(
          error?.message ||
          error
        );

      if (
        /credit|billing|payment|required/i.test(
          message
        )
      ) {
        providerBlocked = true;
      }

      res.status(500).json({
        ok: false,
        error: message,
        creditsRefunded: true
      });
    } finally {
      for (
        const file of [
          inputPath,
          rawPath
        ]
      ) {
        if (file) {
          try {
            await fs.unlink(file);
          } catch {}
        }
      }
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
    try {
      const projects =
        await readUserProjects(
          req.user.id
        );

      res.json({
        ok: true,
        projects
      });
    } catch (error) {
      await recordError(
        error,
        req
      );

      res.status(500).json({
        ok: false,
        error:
          "Unable to load projects."
      });
    }
  }
);

app.get(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    const projects =
      await readUserProjects(
        req.user.id
      );

    const project =
      projects.find(
        p => p.id === req.params.id
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

app.delete(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    const dir =
      await userProjectDir(
        req.user.id
      );

    const file =
      path.join(
        dir,
        `${req.params.id}.json`
      );

    try {
      await fs.unlink(file);

      res.json({
        ok: true
      });
    } catch {
      res.status(404).json({
        ok: false,
        error:
          "Project not found."
      });
    }
  }
);

/* =========================================================
   FREE STUDIO
========================================================= */

app.post(
  "/api/studio/narration",
  requireUser,
  async (req, res) => {
    try {
      const text =
        String(
          req.body?.text || ""
        ).trim();

      if (!text) {
        return res.status(400).json({
          ok: false,
          error:
            "Narration text is required."
        });
      }

      const filename =
        `${randomUUID()}.mp3`;

      const output =
        path.join(
          OUTPUTS,
          filename
        );

      const tts =
        new EdgeTTS();

      await tts.synthesize(
        text,
        "en-US-AriaNeural",
        {
          outputFormat:
            "audio-24khz-96kbitrate-mono-mp3"
        }
      );

      const data =
        tts.toBuffer
          ? await tts.toBuffer()
          : null;

      if (data) {
        await fs.writeFile(
          output,
          data
        );
      }

      await addUsage(
        req.user.id,
        "narrationJobs",
        1
      );

      res.json({
        ok: true,
        audioUrl:
          `/outputs/${filename}`
      });
    } catch (error) {
      await recordError(
        error,
        req
      );

      res.status(500).json({
        ok: false,
        error:
          "Narration generation failed."
      });
    }
  }
);

app.post(
  "/api/studio/upload",
  requireUser,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "No file uploaded."
        });
      }

      const ext =
        path.extname(
          req.file.originalname ||
          ""
        ) || ".bin";

      const filename =
        `${randomUUID()}${ext}`;

      await fs.writeFile(
        path.join(
          OUTPUTS,
          filename
        ),
        req.file.buffer
      );

      await addUsage(
        req.user.id,
        "studioJobs",
        1
      );

      res.json({
        ok: true,
        url:
          `/outputs/${filename}`
      });
    } catch (error) {
      await recordError(
        error,
        req
      );

      res.status(500).json({
        ok: false,
        error:
          "Studio upload failed."
      });
    }
  }
);

/* =========================================================
   FINANCE
========================================================= */

async function addFinanceTransaction(item) {
  const rows =
    await readJSON(
      FINANCE_FILE,
      []
    );

  rows.unshift({
    id: randomUUID(),
    date: now(),
    ...item
  });

  await writeJSON(
    FINANCE_FILE,
    rows.slice(0, 5000)
  );
}

async function calculateFinance() {
  const finance =
    await readJSON(
      FINANCE_FILE,
      []
    );

  let grossRevenue = 0;
  let refunds = 0;
  let totalCosts = 0;

  for (const item of finance) {
    const amount =
      Number(item.amount || 0);

    if (
      item.type === "revenue"
    ) {
      grossRevenue += amount;
    }

    if (
      item.type === "refund"
    ) {
      refunds += amount;
    }

    if (
      item.type === "cost"
    ) {
      totalCosts += amount;
    }
  }

  const netRevenue =
    grossRevenue - refunds;

  const profit =
    netRevenue - totalCosts;

  const margin =
    netRevenue > 0
      ? (profit / netRevenue) * 100
      : 0;

  return {
    grossRevenue,
    refunds,
    netRevenue,
    totalCosts,
    profit,
    profitMargin: margin
  };
}

/* =========================================================
   ADMIN PAGE
========================================================= */

function adminHTML() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#050509">
<title>MAMAKI ADMIN</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  background:#050509;
  color:#f7f7fa;
  font-family:Inter,Arial,sans-serif;
}
a{color:inherit}
button{
  border:0;
  cursor:pointer;
}
.top{
  position:sticky;
  top:0;
  z-index:10;
  background:#09090d;
  border-bottom:1px solid #24242d;
  padding:16px 22px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:15px;
}
.brand{
  font-size:21px;
  font-weight:800;
}
.sub{
  color:#92929d;
  font-size:13px;
  margin-top:3px;
}
.actions{
  display:flex;
  gap:8px;
  flex-wrap:wrap;
}
.btn{
  padding:10px 14px;
  border-radius:10px;
  background:#1b1b23;
  color:#fff;
  border:1px solid #30303a;
}
.btn.primary{
  background:#fff;
  color:#050509;
}
.btn.danger{
  background:#35161b;
  color:#ffb8c0;
}
.wrap{
  max-width:1500px;
  margin:auto;
  padding:25px;
}
.notice{
  border:1px solid #2a2a34;
  background:#101016;
  border-radius:15px;
  padding:14px 16px;
  margin-bottom:20px;
}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:12px;
}
.card{
  background:#101016;
  border:1px solid #24242d;
  border-radius:16px;
  padding:18px;
}
.label{
  color:#92929d;
  font-size:12px;
}
.value{
  font-size:25px;
  font-weight:800;
  margin-top:8px;
}
.section{
  margin-top:25px;
}
.section h2{
  font-size:18px;
}
.status{
  display:inline-flex;
  padding:5px 9px;
  border-radius:999px;
  background:#17311f;
  color:#8df0a6;
  font-size:12px;
}
.warn{
  background:#3b3014;
  color:#ffd76b;
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
  padding:12px;
  border-bottom:1px solid #24242d;
  font-size:13px;
}
th{
  color:#92929d;
}
input,select{
  width:100%;
  background:#08080c;
  color:#fff;
  border:1px solid #30303a;
  border-radius:9px;
  padding:11px;
}
.form{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:10px;
  align-items:end;
}
.muted{
  color:#92929d;
  font-size:12px;
}
.hidden{display:none}
#error{
  color:#ff9da7;
  margin-top:10px;
}
@media(max-width:700px){
  .wrap{padding:14px}
  .top{padding:14px}
}
</style>
</head>
<body>

<header class="top">
<div>
<div class="brand">✨ MAMAKI ADMIN</div>
<div class="sub">Private administrator dashboard</div>
</div>
<div class="actions">
<a class="btn" href="/">MAMAKI Interface</a>
<button class="btn" onclick="refreshAll()">Refresh</button>
<button class="btn danger" onclick="logout()">Logout</button>
</div>
</header>

<main class="wrap">

<div class="notice">
<strong>Administrator dashboard connected.</strong>
<div class="muted" id="adminInfo">Checking administrator authentication...</div>
<div id="error"></div>
</div>

<section>
<div class="grid" id="overview"></div>
</section>

<section class="section">
<h2>Replicate & AI Provider</h2>
<div class="card" id="provider"></div>
</section>

<section class="section">
<h2>Business & Finance</h2>
<div class="grid" id="finance"></div>
</section>

<section class="section">
<h2>Smart Credit Pricing & FX</h2>
<div class="card" id="pricing"></div>
</section>

<section class="section">
<h2>MAMAKI Credit Management</h2>
<div class="card">
<div class="form">
<div>
<label>User ID</label>
<input id="creditUser" placeholder="User ID">
</div>
<div>
<label>Credit adjustment</label>
<input id="creditAmount" type="number" placeholder="100 or -100">
</div>
<div>
<button class="btn primary" onclick="adjustCredits()">Adjust Credits</button>
</div>
</div>
</div>
</section>

<section class="section">
<h2>Owner Profit Withdrawal</h2>
<div class="card">
<div class="form">
<div>
<label>Amount NGN</label>
<input id="withdrawAmount" type="number" placeholder="Amount">
</div>
<div>
<label>Bank / account description</label>
<input id="withdrawAccount" placeholder="Owner withdrawal account">
</div>
<div>
<button class="btn primary" onclick="withdrawProfit()">Withdraw Profit</button>
</div>
</div>
<div class="muted" style="margin-top:10px">
Withdrawals remain disabled until the relevant payment/transfer provider is configured.
</div>
</div>
</section>

<section class="section">
<h2>Users</h2>
<div class="card tableWrap">
<table>
<thead><tr>
<th>Name</th><th>Email</th><th>Role</th><th>Credits</th>
<th>Videos</th><th>AI Seconds</th><th>Created</th>
</tr></thead>
<tbody id="users"></tbody>
</table>
</div>
</section>

<section class="section">
<h2>Payments</h2>
<div class="card tableWrap">
<table>
<thead><tr>
<th>Reference</th><th>Email</th><th>Credits</th>
<th>Amount</th><th>Currency</th><th>Status</th><th>Date</th>
</tr></thead>
<tbody id="payments"></tbody>
</table>
</div>
</section>

<section class="section">
<h2>Security Activity</h2>
<div class="card tableWrap">
<table>
<thead><tr>
<th>Action</th><th>Email/User</th><th>Reference</th><th>Date</th>
</tr></thead>
<tbody id="security"></tbody>
</table>
</div>
</section>

<section class="section">
<h2>Errors</h2>
<div class="card tableWrap">
<table>
<thead><tr>
<th>Message</th><th>Path</th><th>Method</th><th>Date</th>
</tr></thead>
<tbody id="errors"></tbody>
</table>
</div>
</section>

<section class="section">
<h2>Withdrawal History</h2>
<div class="card tableWrap">
<table>
<thead><tr>
<th>Reference</th><th>Amount</th><th>Status</th><th>Account</th><th>Date</th>
</tr></thead>
<tbody id="withdrawals"></tbody>
</table>
</div>
</section>

</main>

<script>
function token(){
  const keys=[
    "mamaki_token",
    "mamakiToken",
    "sessionToken",
    "authToken",
    "token",
    "MAMAKI_TOKEN",
    "mamaki_session"
  ];

  for(const k of keys){
    const v=localStorage.getItem(k);
    if(v && v.length>20) return v;
  }

  for(let i=0;i<localStorage.length;i++){
    const k=localStorage.key(i);
    const v=localStorage.getItem(k);
    if(v && typeof v==="string" && v.length>60){
      if(v.split(".").length>=4) return v;
    }
  }

  return "";
}

async function api(url,options={}){
  const headers={
    ...(options.headers||{}),
    Authorization:"Bearer "+token()
  };

  if(options.body && !headers["Content-Type"]){
    headers["Content-Type"]="application/json";
  }

  const r=await fetch(url,{
    ...options,
    headers
  });

  const text=await r.text();

  let data;

  try{
    data=JSON.parse(text);
  }catch{
    throw new Error(
      "Server returned an invalid response: "+
      text.slice(0,120)
    );
  }

  if(!r.ok || data.ok===false){
    throw new Error(
      data.error || "Request failed."
    );
  }

  return data;
}

function money(n){
  return "₦"+Number(n||0).toLocaleString(
    undefined,
    {minimumFractionDigits:2,maximumFractionDigits:2}
  );
}

function esc(v){
  return String(v??"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;");
}

async function loadMe(){
  const d=await api("/api/auth/me");

  if(d.user.role!=="admin"){
    throw new Error("Administrator access required.");
  }

  document.getElementById("adminInfo").textContent=
    "Signed in as "+d.user.name+" ("+d.user.email+").";
}

async function loadStats(){
  const d=await api("/api/admin/stats");
  const s=d.stats||{};

  const items=[
    ["Total Users",s.totalUsers],
    ["Live / Active",s.activeUsers],
    ["New Today",s.newToday],
    ["New This Week",s.newWeek],
    ["New This Month",s.newMonth],
    ["Total Admins",s.totalAdmins],
    ["Videos Generated",s.videosGenerated],
    ["AI Seconds",s.aiSeconds],
    ["Narrations",s.narrations],
    ["Projects",s.projects],
    ["Completed Jobs",s.completedJobs],
    ["Processing Jobs",s.processingJobs],
    ["Failed Jobs",s.failedJobs],
    ["MAMAKI Credits",s.mamakiCredits],
    ["Profit",money(s.profit)]
  ];

  document.getElementById("overview").innerHTML=
    items.map(x=>\`
      <div class="card">
        <div class="label">\${esc(x[0])}</div>
        <div class="value">\${esc(x[1])}</div>
      </div>
    \`).join("");
}

async function loadProvider(){
  const d=await api("/api/admin/credits");
  const p=d.provider||d;

  document.getElementById("provider").innerHTML=\`
    <div class="grid">
      <div>
        <div class="label">Configured</div>
        <div class="value">\${p.configured?"YES":"NO"}</div>
      </div>
      <div>
        <div class="label">Provider Capacity</div>
        <div class="value">\${p.usable===false?"BLOCKED":"AVAILABLE"}</div>
      </div>
      <div>
        <div class="label">Provider Balance</div>
        <div class="value">$\${Number(p.balance||0).toFixed(2)}</div>
      </div>
    </div>
    <p class="muted">
      Replicate does not expose an authoritative prepaid balance
      through the public account API. MAMAKI will not fabricate a balance.
    </p>
  \`;
}

async function loadFinance(){
  const d=await api("/api/admin/finance");
  const f=d.finance||d;

  document.getElementById("finance").innerHTML=
    [
      ["Gross Revenue",money(f.grossRevenue)],
      ["Refunds",money(f.refunds)],
      ["Net Revenue",money(f.netRevenue)],
      ["Total Costs",money(f.totalCosts)],
      ["Profit",money(f.profit)],
      ["Profit Margin",Number(f.profitMargin||0).toFixed(2)+"%"]
    ].map(x=>\`
      <div class="card">
        <div class="label">\${esc(x[0])}</div>
        <div class="value">\${esc(x[1])}</div>
      </div>
    \`).join("");
}

async function loadPricing(){
  const d=await api("/api/admin/billing");
  const p=d.pricing||d;

  document.getElementById("pricing").innerHTML=\`
    <div class="grid">
      <div>
        <div class="label">Live USD → NGN</div>
        <div class="value">₦\${Number(p.fxRate||0).toLocaleString()}</div>
      </div>
      <div>
        <div class="label">MAMAKI Markup / USD</div>
        <div class="value">₦\${Number(p.markup||0).toLocaleString()}</div>
      </div>
      <div>
        <div class="label">MAMAKI Selling Rate</div>
        <div class="value">₦\${Number(p.sellingRate||0).toLocaleString()}</div>
      </div>
      <div>
        <div class="label">FX Status</div>
        <div class="value">\${esc(p.fxSource||"UNKNOWN")}</div>
      </div>
      <div>
        <div class="label">100 Credits</div>
        <div class="value">₦\${Number(p.packages?.[0]?.amount||0).toLocaleString()}</div>
      </div>
      <div>
        <div class="label">Paystack</div>
        <div class="value">\${p.paystackConfigured?"CONFIGURED":"NOT CONFIGURED"}</div>
      </div>
    </div>
    <p class="muted">
      The FX rate and markup are internal business calculations.
      Customers see only the final package price.
    </p>
  \`;
}

async function loadUsers(){
  const d=await api("/api/admin/users");

  document.getElementById("users").innerHTML=
    (d.users||[]).map(u=>\`
      <tr>
        <td>\${esc(u.name)}</td>
        <td>\${esc(u.email)}</td>
        <td>\${esc(u.role)}</td>
        <td>\${esc(u.credits)}</td>
        <td>\${esc(u.videos)}</td>
        <td>\${esc(u.aiSeconds)}</td>
        <td>\${esc(u.createdAt)}</td>
      </tr>
    \`).join("");
}

async function loadPayments(){
  const d=await api("/api/admin/billing");
  const rows=d.payments||[];

  document.getElementById("payments").innerHTML=
    rows.map(p=>\`
      <tr>
        <td>\${esc(p.reference)}</td>
        <td>\${esc(p.email)}</td>
        <td>\${esc(p.credits)}</td>
        <td>\${money(p.amount)}</td>
        <td>\${esc(p.currency)}</td>
        <td>\${esc(p.status)}</td>
        <td>\${esc(p.createdAt)}</td>
      </tr>
    \`).join("");
}

async function loadSecurity(){
  const d=await api("/api/admin/security");

  document.getElementById("security").innerHTML=
    (d.security||[]).map(x=>\`
      <tr>
        <td>\${esc(x.action)}</td>
        <td>\${esc(x.email)}</td>
        <td>\${esc(x.reference)}</td>
        <td>\${esc(x.date)}</td>
      </tr>
    \`).join("");
}

async function loadErrors(){
  const d=await api("/api/admin/errors");

  document.getElementById("errors").innerHTML=
    (d.errors||[]).map(x=>\`
      <tr>
        <td>\${esc(x.message)}</td>
        <td>\${esc(x.path)}</td>
        <td>\${esc(x.method)}</td>
        <td>\${esc(x.date)}</td>
      </tr>
    \`).join("");
}

async function loadWithdrawals(){
  const d=await api("/api/admin/withdrawals");

  document.getElementById("withdrawals").innerHTML=
    (d.withdrawals||[]).map(x=>\`
      <tr>
        <td>\${esc(x.reference)}</td>
        <td>\${money(x.amount)}</td>
        <td>\${esc(x.status)}</td>
        <td>\${esc(x.account)}</td>
        <td>\${esc(x.date)}</td>
      </tr>
    \`).join("");
}

async function adjustCredits(){
  try{
    const userId=
      document.getElementById("creditUser").value.trim();

    const amount=
      Number(
        document.getElementById("creditAmount").value
      );

    await api("/api/admin/credits/adjust",{
      method:"POST",
      body:JSON.stringify({
        userId,
        amount
      })
    });

    alert("Credits updated.");
    await refreshAll();
  }catch(e){
    alert(e.message);
  }
}

async function withdrawProfit(){
  try{
    const amount=
      Number(
        document.getElementById("withdrawAmount").value
      );

    const account=
      document.getElementById("withdrawAccount").value.trim();

    const d=
      await api("/api/admin/withdrawals",{
        method:"POST",
        body:JSON.stringify({
          amount,
          account
        })
      });

    alert(d.message||"Withdrawal request recorded.");
    await refreshAll();
  }catch(e){
    alert(e.message);
  }
}

async function refreshAll(){
  try{
    document.getElementById("error").textContent="";
    await loadMe();

    await Promise.all([
      loadStats(),
      loadProvider(),
      loadFinance(),
      loadPricing(),
      loadUsers(),
      loadPayments(),
      loadSecurity(),
      loadErrors(),
      loadWithdrawals()
    ]);
  }catch(e){
    document.getElementById("error").textContent=e.message;

    if(
      /authentication|administrator/i.test(e.message)
    ){
      setTimeout(
        ()=>location.href="/",
        1200
      );
    }
  }
}

async function logout(){
  try{
    await api("/api/auth/logout",{
      method:"POST"
    });
  }catch{}

  localStorage.removeItem("mamaki_token");
  localStorage.removeItem("mamakiToken");
  localStorage.removeItem("sessionToken");
  localStorage.removeItem("authToken");
  localStorage.removeItem("token");

  location.href="/";
}

refreshAll();
</script>
</body>
</html>`;
}

/* =========================================================
   ADMIN API
========================================================= */

app.get(
  "/api/admin/stats",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJSON(
        USERS_FILE,
        []
      );

    const usage =
      await readJSON(
        USAGE_FILE,
        {}
      );

    const credits =
      await readJSON(
        CREDITS_FILE,
        {}
      );

    const payments =
      await readJSON(
        PAYMENTS_FILE,
        []
      );

    const finance =
      await calculateFinance();

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

    let aiSeconds = 0;
    let videosGenerated = 0;
    let narrations = 0;

    for (const item of Object.values(usage)) {
      aiSeconds +=
        Number(item.aiSeconds || 0);

      videosGenerated +=
        Number(item.aiGenerations || 0);

      narrations +=
        Number(item.narrationJobs || 0);
    }

    let mamakiCredits = 0;

    for (const item of Object.values(credits)) {
      mamakiCredits +=
        Number(item.balance || 0);
    }

    const newToday =
      users.filter(
        u =>
          new Date(
            u.createdAt
          ).getTime() >= dayStart
      ).length;

    const newWeek =
      users.filter(
        u =>
          new Date(
            u.createdAt
          ).getTime() >= weekStart
      ).length;

    const newMonth =
      users.filter(
        u =>
          new Date(
            u.createdAt
          ).getTime() >= monthStart
      ).length;

    const projectCount =
      await countAllProjects();

    const successPayments =
      payments.filter(
        p => p.status === "success"
      ).length;

    res.json({
      ok: true,
      stats: {
        totalUsers:
          users.length,

        activeUsers:
          users.length,

        newToday,
        newWeek,
        newMonth,

        totalAdmins:
          users.filter(
            u => u.role === "admin"
          ).length,

        videosGenerated,
        aiSeconds,
        narrations,
        projects:
          projectCount,

        completedJobs:
          videosGenerated,

        processingJobs: 0,
        failedJobs: 0,

        mamakiCredits,

        successfulPayments:
          successPayments,

        profit:
          finance.profit
      }
    });
  }
);

async function countAllProjects() {
  const users =
    await readJSON(
      USERS_FILE,
      []
    );

  let count = 0;

  for (const user of users) {
    try {
      const projects =
        await readUserProjects(
          user.id
        );

      count +=
        projects.length;
    } catch {}
  }

  return count;
}

app.get(
  "/api/admin/users",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJSON(
        USERS_FILE,
        []
      );

    const usage =
      await readJSON(
        USAGE_FILE,
        {}
      );

    const credits =
      await readJSON(
        CREDITS_FILE,
        {}
      );

    res.json({
      ok: true,
      users:
        users.map(u => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          credits:
            credits[u.id]?.balance ||
            0,
          videos:
            usage[u.id]?.aiGenerations ||
            0,
          aiSeconds:
            usage[u.id]?.aiSeconds ||
            0,
          createdAt:
            u.createdAt
        }))
    });
  }
);

app.get(
  "/api/admin/jobs",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJSON(
        USERS_FILE,
        []
      );

    const jobs = [];

    for (const user of users) {
      const projects =
        await readUserProjects(
          user.id
        );

      for (const project of projects) {
        jobs.push({
          ...project,
          email: user.email
        });
      }
    }

    jobs.sort(
      (a,b)=>
        new Date(b.createdAt || 0) -
        new Date(a.createdAt || 0)
    );

    res.json({
      ok: true,
      jobs
    });
  }
);

app.get(
  "/api/admin/errors",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      errors:
        await readJSON(
          ERRORS_FILE,
          []
        )
    });
  }
);

app.get(
  "/api/admin/security",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      security:
        await readJSON(
          SECURITY_FILE,
          []
        )
    });
  }
);

app.get(
  "/api/admin/credits",
  requireAdmin,
  async (req, res) => {
    const records =
      await readJSON(
        CREDITS_FILE,
        {}
      );

    let balance = 0;
    let consumed = 0;
    let issued = 0;
    let refunded = 0;

    for (const item of Object.values(records)) {
      balance +=
        Number(item.balance || 0);

      consumed +=
        Number(item.consumed || 0);

      issued +=
        Number(item.issued || 0);

      refunded +=
        Number(item.refunded || 0);
    }

    res.json({
      ok: true,
      credits: {
        balance,
        consumed,
        issued,
        refunded
      },
      provider: {
        configured:
          Boolean(REPLICATE_TOKEN),
        usable:
          Boolean(REPLICATE_TOKEN) &&
          !providerBlocked,
        balance: 0,
        balanceKnown: false,
        note:
          "Replicate does not expose an authoritative prepaid balance through the public account API."
      }
    });
  }
);

app.post(
  "/api/admin/credits/adjust",
  requireAdmin,
  async (req, res) => {
    try {
      const userId =
        String(
          req.body?.userId || ""
        ).trim();

      const amount =
        Number(
          req.body?.amount
        );

      if (
        !userId ||
        !Number.isFinite(amount) ||
        amount === 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Valid user ID and non-zero credit adjustment are required."
        });
      }

      const users =
        await readJSON(
          USERS_FILE,
          []
        );

      const user =
        users.find(
          u => u.id === userId
        );

      if (!user) {
        return res.status(404).json({
          ok: false,
          error: "User not found."
        });
      }

      const record =
        await changeCredits(
          userId,
          amount,
          "admin_adjustment",
          req.user.email
        );

      await recordSecurity(
        "ADMIN_CREDIT_ADJUSTMENT",
        req.user,
        userId,
        {
          amount,
          targetEmail:
            user.email
        }
      );

      res.json({
        ok: true,
        credits: record
      });
    } catch (error) {
      await recordError(
        error,
        req
      );

      res.status(500).json({
        ok: false,
        error:
          "Credit adjustment failed."
      });
    }
  }
);

app.get(
  "/api/admin/finance",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      finance:
        await calculateFinance()
    });
  }
);

app.get(
  "/api/admin/billing",
  requireAdmin,
  async (req, res) => {
    const fx =
      await getLiveFX();

    const sellingRate =
      mamakiSellingRate(
        fx.rate
      );

    const payments =
      await readJSON(
        PAYMENTS_FILE,
        []
      );

    res.json({
      ok: true,

      pricing: {
        fxRate:
          fx.rate,

        markup:
          MAMAKI_MARKUP_NGN,

        sellingRate,

        fxSource:
          fx.source,

        paystackConfigured:
          Boolean(
            PAYSTACK_SECRET_KEY
          ),

        packages:
          CREDIT_PACKAGES.map(
            pkg => ({
              credits:
                pkg.credits,
              amount:
                packagePriceNGN(
                  pkg.credits,
                  sellingRate
                )
            })
          )
      },

      payments:
        payments.slice(0, 500)
    });
  }
);

app.get(
  "/api/admin/withdrawals",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      withdrawals:
        await readJSON(
          WITHDRAWALS_FILE,
          []
        )
    });
  }
);

app.post(
  "/api/admin/withdrawals",
  requireAdmin,
  async (req, res) => {
    try {
      const amount =
        Number(
          req.body?.amount
        );

      const account =
        String(
          req.body?.account || ""
        ).trim();

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Enter a valid withdrawal amount."
        });
      }

      const reference =
        `MAMAKI-WD-${Date.now()}-${randomBytes(4).toString("hex")}`;

      const withdrawals =
        await readJSON(
          WITHDRAWALS_FILE,
          []
        );

      const item = {
        id: randomUUID(),
        reference,
        amount,
        status:
          "pending_provider_configuration",
        account,
        date: now()
      };

      withdrawals.unshift(item);

      await writeJSON(
        WITHDRAWALS_FILE,
        withdrawals.slice(0, 1000)
      );

      await recordSecurity(
        "WITHDRAWAL_REQUEST",
        req.user,
        reference,
        { amount, account }
      );

      res.json({
        ok: true,
        withdrawal: item,
        message:
          "Withdrawal request recorded. Automatic bank transfer requires a configured transfer provider."
      });
    } catch (error) {
      await recordError(
        error,
        req
      );

      res.status(500).json({
        ok: false,
        error:
          "Withdrawal request failed."
      });
    }
  }
);

/* =========================================================
   ADMIN ROUTE
   IMPORTANT: THIS MUST COME BEFORE FRONTEND FALLBACK.
========================================================= */

app.get(
  "/admin",
  async (req, res) => {
    res
      .status(200)
      .type("html")
      .send(adminHTML());
  }
);

app.get(
  "/admin/",
  async (req, res) => {
    res
      .status(200)
      .type("html")
      .send(adminHTML());
  }
);

/* =========================================================
   OUTPUT FILES
========================================================= */

app.use(
  "/outputs",
  express.static(
    OUTPUTS,
    {
      maxAge: "1h",
      fallthrough: true
    }
  )
);

/* =========================================================
   FRONTEND BILLING WIDGET
========================================================= */

function injectBillingWidget(html) {
  const widget = `
<style>
#mamaki-credit-widget{
position:fixed;
right:18px;
bottom:18px;
z-index:99999;
font-family:Arial,sans-serif;
}
#mamaki-credit-button{
border:1px solid rgba(255,255,255,.18);
background:#111116;
color:#fff;
padding:13px 17px;
border-radius:14px;
cursor:pointer;
box-shadow:0 10px 35px rgba(0,0,0,.4);
font-weight:700;
}
#mamaki-credit-panel{
display:none;
position:absolute;
right:0;
bottom:58px;
width:min(390px,calc(100vw - 30px));
background:#101016;
border:1px solid #292933;
border-radius:18px;
padding:18px;
color:#fff;
box-shadow:0 20px 60px rgba(0,0,0,.55);
}
#mamaki-credit-panel.open{display:block}
.mamaki-credit-title{
font-size:18px;
font-weight:800;
margin-bottom:12px;
}
.mamaki-credit-balance{
display:grid;
grid-template-columns:1fr 1fr;
gap:9px;
margin-bottom:15px;
}
.mamaki-credit-stat{
background:#08080c;
border:1px solid #24242d;
border-radius:12px;
padding:12px;
}
.mamaki-credit-stat small{
display:block;
color:#92929d;
font-size:11px;
}
.mamaki-credit-stat strong{
display:block;
font-size:20px;
margin-top:4px;
}
.mamaki-credit-packages{
display:grid;
gap:8px;
}
.mamaki-credit-package{
width:100%;
display:flex;
justify-content:space-between;
align-items:center;
padding:12px;
border:1px solid #292933;
border-radius:12px;
background:#15151b;
color:#fff;
cursor:pointer;
}
.mamaki-credit-package:hover{
border-color:#777783;
}
.mamaki-credit-close{
margin-top:10px;
width:100%;
padding:10px;
border:1px solid #292933;
border-radius:10px;
background:#08080c;
color:#aaa;
cursor:pointer;
}
.mamaki-credit-message{
font-size:12px;
color:#92929d;
line-height:1.45;
margin-top:10px;
}
</style>

<div id="mamaki-credit-widget">
<button id="mamaki-credit-button">✨ Buy MAMAKI Credits</button>
<div id="mamaki-credit-panel">
<div class="mamaki-credit-title">✨ MAMAKI Credits</div>

<div class="mamaki-credit-balance">
<div class="mamaki-credit-stat">
<small>Available Credits</small>
<strong id="mamaki-available">—</strong>
</div>
<div class="mamaki-credit-stat">
<small>Video Cost</small>
<strong id="mamaki-video-cost">—</strong>
</div>
</div>

<div class="mamaki-credit-packages" id="mamaki-credit-packages">
Loading...
</div>

<div class="mamaki-credit-message" id="mamaki-credit-message">
Choose a credit package to continue.
</div>

<button class="mamaki-credit-close" id="mamaki-credit-close">
Close
</button>
</div>
</div>

<script>
(function(){

function getToken(){
const keys=[
"mamaki_token",
"mamakiToken",
"sessionToken",
"authToken",
"token",
"MAMAKI_TOKEN",
"mamaki_session"
];

for(const k of keys){
const v=localStorage.getItem(k);
if(v && v.length>20)return v;
}

for(let i=0;i<localStorage.length;i++){
const k=localStorage.key(i);
const v=localStorage.getItem(k);
if(v && v.length>60 && v.split(".").length>=4){
return v;
}
}

return "";
}

async function request(url,options={}){
const headers={
...(options.headers||{}),
Authorization:"Bearer "+getToken()
};

if(options.body && !headers["Content-Type"]){
headers["Content-Type"]="application/json";
}

const r=await fetch(url,{
...options,
headers
});

const text=await r.text();

let data;

try{
data=JSON.parse(text);
}catch{
throw new Error("Unexpected server response.");
}

if(!r.ok || data.ok===false){
throw new Error(data.error||"Request failed.");
}

return data;
}

const button=
document.getElementById("mamaki-credit-button");

const panel=
document.getElementById("mamaki-credit-panel");

const close=
document.getElementById("mamaki-credit-close");

const packages=
document.getElementById("mamaki-credit-packages");

const available=
document.getElementById("mamaki-available");

const videoCost=
document.getElementById("mamaki-video-cost");

const message=
document.getElementById("mamaki-credit-message");

async function loadCredits(){

try{

const me=
await request("/api/auth/me");

available.textContent=
Number(me.credits||0).toLocaleString();

let seconds=5;
let quality="Standard HD";

const duration=
document.querySelector(
'select[name="duration"],#duration,[data-duration]'
);

if(duration){
seconds=Number(duration.value)||5;
}

const qualityInput=
document.querySelector(
'select[name="quality"],#quality,[data-quality]'
);

if(qualityInput){
quality=qualityInput.value||quality;
}

try{

const cost=
await request(
"/api/video/cost?seconds="+
encodeURIComponent(seconds)+
"&quality="+
encodeURIComponent(quality)
);

videoCost.textContent=
Number(cost.requiredCredits||0)
.toLocaleString();

}catch{
videoCost.textContent="—";
}

}catch{
available.textContent="Login";
videoCost.textContent="—";
}

}

async function loadPackages(){

try{

const d=
await request("/api/billing/pricing");

if(!d.packages?.length){

packages.innerHTML=
"<div style='color:#ffb8c0'>Online payment is temporarily unavailable.</div>";

return;
}

packages.innerHTML=
d.packages.map(p=>\`

<button class="mamaki-credit-package"
data-credits="\${Number(p.credits)}">

<span>\${Number(p.credits).toLocaleString()} credits</span>
<strong>₦\${Number(p.amountNGN||p.amount||0).toLocaleString()}</strong>

</button>

\`).join("");

packages
.querySelectorAll(".mamaki-credit-package")
.forEach(btn=>{
btn.addEventListener("click",async()=>{
await buy(
Number(btn.dataset.credits)
);
});
});

}catch(error){

packages.innerHTML=
"<div style='color:#ffb8c0'>Online payment is temporarily unavailable.</div>";

message.textContent=
"Payment has not been connected yet. Your credit system is ready for payment activation.";

}

}

async function buy(credits){

try{

message.textContent=
"Opening secure payment...";

const d=
await request(
"/api/billing/paystack/initialize",
{
method:"POST",
body:JSON.stringify({
credits
})
}
);

if(d.authorization_url){

window.location.href=
d.authorization_url;

return;
}

throw new Error(
"Secure payment is temporarily unavailable."
);

}catch(error){

message.textContent=
error.message;

}

}

button.addEventListener(
"click",
async()=>{
panel.classList.toggle("open");

if(panel.classList.contains("open")){
await loadCredits();
await loadPackages();
}
}
);

close.addEventListener(
"click",
()=>{
panel.classList.remove("open");
}
);

window.MAMAKI_CREDIT_WIDGET={
refresh:loadCredits
};

})();
</script>
`;

  const marker =
    "</body>";

  if (
    html.toLowerCase().includes(
      marker
    )
  ) {
    return html.replace(
      /<\/body>/i,
      `${widget}</body>`
    );
  }

  return html + widget;
}

/* =========================================================
   FRONTEND FALLBACK
========================================================= */

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

  try {
    const html =
      await fs.readFile(
        indexPath,
        "utf8"
      );

    res
      .status(200)
      .type("html")
      .send(
        injectBillingWidget(
          html
        )
      );
  } catch {
    res.status(404).send(
      "MAMAKI AI interface not found."
    );
  }
}

app.use(
  serveFrontend
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  async (error, req, res, next) => {
    await recordError(
      error,
      req
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      ok: false,
      error:
        error?.message ||
        "Internal server error."
    });
  }
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
      `✨ MAMAKI AI ${VERSION} running on ${HOST}:${PORT}`
    );

    console.log(
      `Admin: /admin`
    );

    console.log(
      `Replicate configured: ${Boolean(REPLICATE_TOKEN)}`
    );

    console.log(
      `Paystack configured: ${Boolean(PAYSTACK_SECRET_KEY)}`
    );

    console.log(
      `MAMAKI markup: ₦${MAMAKI_MARKUP_NGN}/USD`
    );
  }
);
