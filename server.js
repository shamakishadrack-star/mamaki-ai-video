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
  createHmac,
} from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";
const VERSION = "17.3.0";

const ROOT = process.cwd();
const TMP = path.join(ROOT, "tmp");
const OUTPUTS = path.join(ROOT, "outputs");
const PROJECTS = path.join(ROOT, "projects");
const DATA = path.join(ROOT, "data");

const USERS_FILE = path.join(DATA, "users.json");
const SESSIONS_FILE = path.join(DATA, "sessions.json");
const ERRORS_FILE = path.join(DATA, "errors.json");
const USAGE_FILE = path.join(DATA, "usage.json");
const RESET_FILE = path.join(DATA, "password-resets.json");
const SECURITY_FILE = path.join(DATA, "security.json");
const CREDITS_FILE = path.join(DATA, "credits.json");
const FINANCE_FILE = path.join(DATA, "finance.json");
const PRICING_FILE = path.join(DATA, "pricing.json");
const PAYMENTS_FILE = path.join(DATA, "payments.json");
const WITHDRAWALS_FILE = path.join(DATA, "withdrawals.json");

const T2V_MODEL =
  process.env.T2V_MODEL || "wan-video/wan-2.2-t2v-fast";
const I2V_MODEL =
  process.env.I2V_MODEL || "wan-video/wan-2.2-i2v-fast";

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

const PAYSTACK_SECRET_KEY = String(
  process.env.PAYSTACK_SECRET_KEY || ""
).trim();

const PAYSTACK_PUBLIC_KEY = String(
  process.env.PAYSTACK_PUBLIC_KEY || ""
).trim();

const FX_API_URL = String(
  process.env.FX_API_URL ||
    "https://open.er-api.com/v6/latest/USD"
).trim();

const DEFAULT_USD_NGN_RATE = Math.max(
  1,
  Number(process.env.DEFAULT_USD_NGN_RATE || 1600)
);

const TARGET_MARGIN = Math.min(
  0.9,
  Math.max(
    0.05,
    Number(process.env.MAMAKI_TARGET_MARGIN || 0.4)
  )
);

const PAYMENT_FEE_BUFFER = Math.min(
  0.3,
  Math.max(
    0,
    Number(process.env.MAMAKI_PAYMENT_FEE_BUFFER || 0.04)
  )
);

const FX_BUFFER = Math.min(
  0.3,
  Math.max(
    0,
    Number(process.env.MAMAKI_FX_BUFFER || 0.05)
  )
);

const PROVIDER_COST_480P_USD = Math.max(
  0.0001,
  Number(process.env.WAN_480P_COST_USD || 0.05)
);

const PROVIDER_COST_720P_USD = Math.max(
  PROVIDER_COST_480P_USD,
  Number(process.env.WAN_720P_COST_USD || 0.1)
);

const PAYSTACK_CURRENCY_DEFAULT = String(
  process.env.PAYSTACK_CURRENCY_DEFAULT || "NGN"
).toUpperCase();

const RESEND_API_KEY = String(
  process.env.RESEND_API_KEY || ""
).trim();

const RESEND_FROM = String(
  process.env.RESEND_FROM || ""
).trim();

const APP_URL = String(
  process.env.APP_URL ||
    "https://mamaki-ai-video.onrender.com"
).replace(/\/$/, "");

const replicate = REPLICATE_API_TOKEN
  ? new Replicate({ auth: REPLICATE_API_TOKEN })
  : null;

const STARTER_CREDITS = Math.max(
  0,
  Number(process.env.STARTER_CREDITS || 100)
);

const CREDITS_PER_5_SECONDS = Math.max(
  1,
  Number(process.env.CREDITS_PER_5_SECONDS || 10)
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

function now() {
  return new Date().toISOString();
}

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

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(
    temp,
    JSON.stringify(value, null, 2),
    "utf8"
  );
  await fs.rename(temp, file);
}

async function readStore(file, fallback) {
  return readJson(file, fallback);
}

async function writeStore(file, value) {
  return writeJson(file, value);
}

async function ensureStorage() {
  await Promise.all([
    ensureDir(TMP),
    ensureDir(OUTPUTS),
    ensureDir(PROJECTS),
    ensureDir(DATA),
  ]);

  const files = [
    [USERS_FILE, []],
    [SESSIONS_FILE, {}],
    [ERRORS_FILE, []],
    [USAGE_FILE, {}],
    [RESET_FILE, {}],
    [SECURITY_FILE, []],
    [CREDITS_FILE, {
      pool: 0,
      users: {},
      transactions: [],
      updatedAt: now(),
    }],
    [FINANCE_FILE, {
      transactions: [],
      wallet: {
        revenue: 0,
        refunds: 0,
        costs: 0,
        profit: 0,
      },
    }],
    [PRICING_FILE, {
      fx: null,
      updatedAt: null,
    }],
    [PAYMENTS_FILE, []],
    [WITHDRAWALS_FILE, []],
  ];

  for (const [file, fallback] of files) {
    if (!(await exists(file))) {
      await writeJson(file, fallback);
    }
  }
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeCurrency(value) {
  const currency = String(
    value || PAYSTACK_CURRENCY_DEFAULT
  ).toUpperCase();

  return currency === "USD" ? "USD" : "NGN";
}

function safeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name || "",
    role: user.role || "user",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(
    String(password),
    salt,
    64
  ).toString("hex");

  return {
    salt,
    hash,
  };
}

function verifyPassword(password, storedHash, salt) {
  try {
    const candidate = scryptSync(
      String(password),
      salt,
      64
    );

    const stored = Buffer.from(
      String(storedHash),
      "hex"
    );

    return (
      candidate.length === stored.length &&
      timingSafeEqual(candidate, stored)
    );
  } catch {
    return false;
  }
}

function sessionHash(token) {
  return createHash("sha256")
    .update(`${SESSION_SECRET}:${token}`)
    .digest("hex");
}

function generateToken() {
  return randomBytes(48).toString("hex");
}

async function getUsers() {
  const data = await readJson(USERS_FILE, []);
  return Array.isArray(data) ? data : [];
}

async function saveUsers(users) {
  await writeJson(USERS_FILE, users);
}

async function findUserByEmail(email) {
  const users = await getUsers();
  const normalized = normalizeEmail(email);

  return (
    users.find(
      (u) => normalizeEmail(u.email) === normalized
    ) || null
  );
}

async function findUserById(id) {
  const users = await getUsers();
  return users.find((u) => u.id === id) || null;
}

async function ensureAdminAccount() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;

  const users = await getUsers();
  let user = users.find(
    (u) => normalizeEmail(u.email) === ADMIN_EMAIL
  );

  if (!user) {
    const password = hashPassword(ADMIN_PASSWORD);

    user = {
      id: randomUUID(),
      email: ADMIN_EMAIL,
      name: "MAMAKI Administrator",
      role: "admin",
      passwordHash: password.hash,
      passwordSalt: password.salt,
      createdAt: now(),
      updatedAt: now(),
    };

    users.push(user);
    await saveUsers(users);
    return;
  }

  if (user.role !== "admin") {
    user.role = "admin";
    user.updatedAt = now();
    await saveUsers(users);
  }
}

async function createSession(user) {
  const sessions = await readJson(
    SESSIONS_FILE,
    {}
  );

  const token = generateToken();
  const key = sessionHash(token);

  sessions[key] = {
    userId: user.id,
    createdAt: now(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };

  await writeJson(SESSIONS_FILE, sessions);

  return token;
}

async function destroySession(token) {
  if (!token) return;

  const sessions = await readJson(
    SESSIONS_FILE,
    {}
  );

  delete sessions[sessionHash(token)];

  await writeJson(SESSIONS_FILE, sessions);
}

function getBearer(req) {
  const auth = String(
    req.headers.authorization || ""
  );

  if (auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }

  return "";
}

async function getCurrentUser(req) {
  const token =
    getBearer(req) ||
    String(req.headers["x-session-token"] || "");

  if (!token) return null;

  const sessions = await readJson(
    SESSIONS_FILE,
    {}
  );

  const session = sessions[sessionHash(token)];

  if (!session) return null;

  if (
    !session.expiresAt ||
    Number(session.expiresAt) < Date.now()
  ) {
    delete sessions[sessionHash(token)];
    await writeJson(SESSIONS_FILE, sessions);
    return null;
  }

  return findUserById(session.userId);
}

async function requireUser(req, res, next) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "Authentication required.",
      });
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "Authentication required.",
      });
    }

    if (user.role !== "admin") {
      return res.status(403).json({
        ok: false,
        error: "Administrator access required.",
      });
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

async function addSecurityEvent(event) {
  const events = await readJson(
    SECURITY_FILE,
    []
  );

  events.unshift({
    id: randomUUID(),
    createdAt: now(),
    ...event,
  });

  await writeJson(
    SECURITY_FILE,
    events.slice(0, 1000)
  );
}

async function recordError(error, req = null) {
  const errors = await readJson(
    ERRORS_FILE,
    []
  );

  errors.unshift({
    id: randomUUID(),
    message: String(
      error?.message || error || "Unknown error"
    ),
    stack: String(error?.stack || ""),
    path: req?.originalUrl || "",
    method: req?.method || "",
    createdAt: now(),
  });

  await writeJson(
    ERRORS_FILE,
    errors.slice(0, 500)
  );
}

async function getUsage() {
  const value = await readJson(
    USAGE_FILE,
    {}
  );

  return value &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : {};
}

async function updateUsage(
  userId,
  changes = {}
) {
  const usage = await getUsage();

  if (!usage[userId]) {
    usage[userId] = {
      aiGenerations: 0,
      aiSeconds: 0,
      studioJobs: 0,
      narrationJobs: 0,
      updatedAt: now(),
    };
  }

  for (const [key, value] of Object.entries(changes)) {
    usage[userId][key] =
      Number(usage[userId][key] || 0) +
      Number(value || 0);
  }

  usage[userId].updatedAt = now();

  await writeJson(USAGE_FILE, usage);

  return usage[userId];
}

async function readCredits() {
  const data = await readJson(
    CREDITS_FILE,
    {}
  );

  return {
    pool: Number(data?.pool || 0),
    users:
      data &&
      typeof data.users === "object" &&
      data.users
        ? data.users
        : {},
    transactions: Array.isArray(data?.transactions)
      ? data.transactions
      : [],
    updatedAt: data?.updatedAt || now(),
  };
}

async function writeCredits(data) {
  data.updatedAt = now();
  await writeJson(CREDITS_FILE, data);
}

async function getUserCredits(userId) {
  const data = await readCredits();

  if (
    !Object.prototype.hasOwnProperty.call(
      data.users,
      userId
    )
  ) {
    data.users[userId] = STARTER_CREDITS;

    data.transactions.push({
      id: randomUUID(),
      type: "ISSUE",
      source: "STARTER",
      userId,
      amount: STARTER_CREDITS,
      createdAt: now(),
    });

    await writeCredits(data);
  }

  return Number(data.users[userId] || 0);
}

async function addUserCredits(
  userId,
  amount,
  source = "ADMIN"
) {
  const n = Math.floor(Number(amount || 0));

  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      "Credit amount must be greater than zero."
    );
  }

  const data = await readCredits();

  data.users[userId] =
    Number(data.users[userId] || 0) + n;

  data.transactions.push({
    id: randomUUID(),
    type: "ISSUE",
    source,
    userId,
    amount: n,
    createdAt: now(),
  });

  await writeCredits(data);

  return data.users[userId];
}

async function consumeUserCredits(
  userId,
  seconds
) {
  const cost = Math.max(
    1,
    Math.ceil(
      Number(seconds || 5) /
        5
    ) * CREDITS_PER_5_SECONDS
  );

  const data = await readCredits();

  if (
    !Object.prototype.hasOwnProperty.call(
      data.users,
      userId
    )
  ) {
    data.users[userId] = STARTER_CREDITS;
  }

  const balance = Number(
    data.users[userId] || 0
  );

  if (balance < cost) {
    const error = new Error(
      `Insufficient MAMAKI credits. Required ${cost}, available ${balance}.`
    );

    error.code =
      "MAMAKI_CREDITS_INSUFFICIENT";

    error.requiredCredits = cost;
    error.availableCredits = balance;

    throw error;
  }

  data.users[userId] = balance - cost;

  data.transactions.push({
    id: randomUUID(),
    type: "CONSUME",
    source: "AI_GENERATION",
    userId,
    amount: -cost,
    seconds: Number(seconds || 0),
    createdAt: now(),
  });

  await writeCredits(data);

  return {
    cost,
    balance: data.users[userId],
  };
}

async function refundUserCredits(
  userId,
  amount
) {
  const n = Math.max(
    0,
    Number(amount || 0)
  );

  if (!n) return;

  const data = await readCredits();

  data.users[userId] =
    Number(data.users[userId] || 0) + n;

  data.transactions.push({
    id: randomUUID(),
    type: "REFUND",
    source: "AI_GENERATION_FAILED",
    userId,
    amount: n,
    createdAt: now(),
  });

  await writeCredits(data);
}

async function getFxRates() {
  const current = Date.now();

  const store = await readStore(
    PRICING_FILE,
    {
      fx: null,
      updatedAt: null,
    }
  );

  if (
    store.fx &&
    store.fx.rates &&
    store.fx.updatedAt &&
    current -
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
          Accept:
            "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `FX provider HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    const usdNgn = Number(
      data?.rates?.NGN || 0
    );

    if (
      !Number.isFinite(usdNgn) ||
      usdNgn <= 0
    ) {
      throw new Error(
        "FX provider returned no NGN rate."
      );
    }

    const fx = {
      base: "USD",
      rates: {
        USD: 1,
        NGN: usdNgn,
      },
      source: FX_API_URL,
      updatedAt: now(),
      live: true,
    };

    store.fx = fx;

    await writeStore(
      PRICING_FILE,
      store
    );

    return fx;
  } catch (error) {
    const fx = {
      base: "USD",
      rates: {
        USD: 1,
        NGN: DEFAULT_USD_NGN_RATE,
      },
      source: "configured fallback",
      updatedAt: now(),
      live: false,
      error: String(
        error?.message || error
      ),
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
  const scenes = Math.max(
    1,
    Math.ceil(
      Number(credits || 0) /
        CREDITS_PER_5_SECONDS
    )
  );

  const q = String(
    quality || "Standard HD"
  ).toLowerCase();

  const providerCost =
    q.includes("high") ||
    q.includes("cinematic")
      ? PROVIDER_COST_720P_USD
      : PROVIDER_COST_480P_USD;

  return {
    scenes,
    providerCostUsd:
      scenes * providerCost,
  };
}

async function calculateCreditPrice(
  credits,
  currency = PAYSTACK_CURRENCY_DEFAULT,
  quality = "Standard HD"
) {
  const c = Math.max(
    1,
    Math.floor(Number(credits || 0))
  );

  const cur =
    normalizeCurrency(currency);

  const fx =
    await getFxRates();

  const base =
    providerCostForCredits(
      c,
      quality
    );

  const denominator =
    Math.max(
      0.05,
      1 -
        TARGET_MARGIN -
        PAYMENT_FEE_BUFFER -
        FX_BUFFER
    );

  const customerUsd =
    base.providerCostUsd /
    denominator;

  const amount =
    cur === "NGN"
      ? customerUsd *
        Number(
          fx.rates.NGN ||
            DEFAULT_USD_NGN_RATE
        )
      : customerUsd;

  const rounded =
    cur === "NGN"
      ? Math.max(
          100,
          Math.ceil(
            amount / 50
          ) * 50
        )
      : Math.max(
          1,
          Math.ceil(
            amount * 100
          ) / 100
        );

  return {
    credits: c,
    currency: cur,
    amount: rounded,
    amountSubunit:
      Math.round(
        rounded * 100
      ),
    usdPrice:
      Number(
        customerUsd.toFixed(4)
      ),
    providerCostUsd:
      Number(
        base.providerCostUsd.toFixed(
          4
        )
      ),
    providerScenes:
      base.scenes,
    fxRate:
      cur === "NGN"
        ? Number(
            fx.rates.NGN ||
              DEFAULT_USD_NGN_RATE
          )
        : 1,
    fxLive: Boolean(fx.live),
    fxUpdatedAt: fx.updatedAt,
    marginTarget:
      TARGET_MARGIN,
    paymentFeeBuffer:
      PAYMENT_FEE_BUFFER,
    fxBuffer: FX_BUFFER,
  };
}

async function addFinanceTransaction(
  transaction
) {
  const data =
    await readJson(
      FINANCE_FILE,
      {
        transactions: [],
        wallet: {
          revenue: 0,
          refunds: 0,
          costs: 0,
          profit: 0,
        },
      }
    );

  if (
    !Array.isArray(
      data.transactions
    )
  ) {
    data.transactions = [];
  }

  if (!data.wallet) {
    data.wallet = {
      revenue: 0,
      refunds: 0,
      costs: 0,
      profit: 0,
    };
  }

  const item = {
    id: randomUUID(),
    createdAt: now(),
    ...transaction,
  };

  data.transactions.unshift(item);

  if (item.type === "REVENUE") {
    data.wallet.revenue +=
      Number(item.amount || 0);
  }

  if (item.type === "REFUND") {
    data.wallet.refunds +=
      Number(item.amount || 0);
  }

  if (item.type === "COST") {
    data.wallet.costs +=
      Number(item.amount || 0);
  }

  data.wallet.profit =
    Number(data.wallet.revenue || 0) -
    Number(data.wallet.refunds || 0) -
    Number(data.wallet.costs || 0);

  await writeJson(
    FINANCE_FILE,
    data
  );

  return item;
}

async function getFinance() {
  const data =
    await readJson(
      FINANCE_FILE,
      {
        transactions: [],
        wallet: {
          revenue: 0,
          refunds: 0,
          costs: 0,
          profit: 0,
        },
      }
    );

  return {
    transactions:
      Array.isArray(
        data.transactions
      )
        ? data.transactions
        : [],
    wallet: {
      revenue:
        Number(
          data?.wallet?.revenue ||
            0
        ),
      refunds:
        Number(
          data?.wallet?.refunds ||
            0
        ),
      costs:
        Number(
          data?.wallet?.costs ||
            0
        ),
      profit:
        Number(
          data?.wallet?.profit ||
            0
        ),
    },
  };
}

async function getPayments() {
  const data =
    await readJson(
      PAYMENTS_FILE,
      []
    );

  return Array.isArray(data)
    ? data
    : [];
}

async function savePayments(payments) {
  await writeJson(
    PAYMENTS_FILE,
    payments
  );
}

async function recordPayment(payment) {
  const payments =
    await getPayments();

  const index =
    payments.findIndex(
      (item) =>
        item.reference ===
        payment.reference
    );

  if (index >= 0) {
    payments[index] = {
      ...payments[index],
      ...payment,
      updatedAt: now(),
    };
  } else {
    payments.unshift({
      id: randomUUID(),
      createdAt: now(),
      ...payment,
    });
  }

  await savePayments(
    payments
  );
}

function wanFrames(seconds) {
  return Number(seconds) <= 5
    ? 81
    : 121;
}

function clampDuration(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return MIN_DURATION;
  }

  return Math.min(
    MAX_DURATION,
    Math.max(
      MIN_DURATION,
      Math.round(n)
    )
  );
}

function validRatio(value) {
  const ratio =
    String(value || "16:9");

  return [
    "16:9",
    "9:16",
    "1:1",
  ].includes(ratio)
    ? ratio
    : "16:9";
}

function dimensionsForRatio(
  ratio
) {
  switch (
    validRatio(ratio)
  ) {
    case "9:16":
      return "1080x1920";

    case "1:1":
      return "1080x1080";

    default:
      return "1920x1080";
  }
}

function enhancePrompt(
  prompt,
  style = "Cinematic"
) {
  return [
    String(prompt || "").trim(),
    `Visual style: ${style}.`,
    "High quality cinematic composition.",
    "Strong visual continuity.",
    "Natural motion.",
    "No subtitles.",
    "No captions.",
    "No logos.",
    "No watermarks.",
  ]
    .filter(Boolean)
    .join(" ");
}

function providerIsConfigured() {
  return Boolean(
    REPLICATE_API_TOKEN &&
      replicate
  );
}

let providerBlocked = false;

async function runReplicate(
  model,
  input
) {
  if (!replicate) {
    const error =
      new Error(
        "Replicate is not configured."
      );

    error.code =
      "REPLICATE_NOT_CONFIGURED";

    throw error;
  }

  try {
    const output =
      await replicate.run(
        model,
        {
          input,
        }
      );

    providerBlocked = false;

    return output;
  } catch (error) {
    const message =
      String(
        error?.message ||
          error
      );

    if (
      /402|insufficient|credit|billing|payment required/i.test(
        message
      )
    ) {
      providerBlocked = true;
    }

    throw error;
  }
}

async function outputToUrl(
  output
) {
  if (!output) {
    return null;
  }

  if (
    typeof output ===
    "string"
  ) {
    return output;
  }

  if (
    typeof output.url ===
    "function"
  ) {
    try {
      return String(
        output.url()
      );
    } catch {}
  }

  if (
    typeof output.url ===
    "string"
  ) {
    return output.url;
  }

  if (
    output instanceof URL
  ) {
    return String(
      output
    );
  }

  if (
    Array.isArray(output)
  ) {
    for (
      const item of output
    ) {
      const url =
        await outputToUrl(
          item
        );

      if (url) return url;
    }
  }

  if (
    typeof output ===
    "object"
  ) {
    for (
      const key of [
        "video",
        "output",
        "url",
      ]
    ) {
      if (
        output[key] !==
        undefined
      ) {
        const url =
          await outputToUrl(
            output[key]
          );

        if (url) return url;
      }
    }
  }

  return null;
}

async function downloadFile(
  url,
  destination
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
    destination,
    buffer
  );

  return destination;
}

function runCommand(
  command,
  args,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {
      const child =
        spawn(
          command,
          args,
          {
            stdio: [
              "ignore",
              "pipe",
              "pipe",
            ],
            ...options,
          }
        );

      let stdout = "";
      let stderr = "";

      child.stdout.on(
        "data",
        (chunk) => {
          stdout +=
            chunk.toString();
        }
      );

      child.stderr.on(
        "data",
        (chunk) => {
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
        (code) => {
          if (
            code === 0
          ) {
            resolve({
              stdout,
              stderr,
            });
          } else {
            const error =
              new Error(
                stderr ||
                  stdout ||
                  `Command failed with code ${code}`
              );

            error.code =
              code;

            reject(error);
          }
        }
      );
    }
  );
}

async function applyWatermark(
  input,
  output
) {
  if (!ffmpegPath) {
    return input;
  }

  try {
    await runCommand(
      ffmpegPath,
      [
        "-y",
        "-i",
        input,
        "-vf",
        "drawtext=text='MAMAKI ✨':fontcolor=white@0.85:fontsize=22:borderw=2:bordercolor=black@0.45:x=w-tw-24:y=h-th-24",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        output,
      ]
    );

    return output;
  } catch {
    return input;
  }
}

async function createGeneration(
  req,
  mode
) {
  const user =
    req.user;

  const body =
    req.body || {};

  const prompt =
    String(
      body.prompt || ""
    ).trim();

  if (
    mode === "text" &&
    !prompt
  ) {
    throw new Error(
      "A video prompt is required."
    );
  }

  const duration =
    clampDuration(
      body.duration
    );

  const ratio =
    validRatio(
      body.ratio
    );

  const style =
    String(
      body.style ||
        "Cinematic"
    );

  const quality =
    String(
      body.quality ||
        "Standard HD"
    );

  const providerCost =
    providerCostForCredits(
      Math.max(
        1,
        Math.ceil(
          duration / 5
        ) *
          CREDITS_PER_5_SECONDS
      ),
      quality
    );

  const creditResult =
    await consumeUserCredits(
      user.id,
      duration
    );

  if (
    providerBlocked
  ) {
    await refundUserCredits(
      user.id,
      creditResult.cost
    );

    const error =
      new Error(
        "Replicate currently has insufficient provider credit. Please restore provider credit before generating AI videos."
      );

    error.code =
      "REPLICATE_PROVIDER_BLOCKED";

    throw error;
  }

  let imageUrl = null;

  if (
    req.file &&
    mode === "image"
  ) {
    const extension =
      path.extname(
        req.file.originalname ||
          ".jpg"
      ) || ".jpg";

    const imagePath =
      path.join(
        TMP,
        `${randomUUID()}${extension}`
      );

    await fs.writeFile(
      imagePath,
      req.file.buffer
    );

    imageUrl =
      `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
  }

  const input = {
    prompt: enhancePrompt(
      prompt,
      style
    ),
    num_frames:
      wanFrames(
        duration
      ),
    aspect_ratio:
      ratio,
    size:
      dimensionsForRatio(
        ratio
      ),
  };

  if (
    imageUrl
  ) {
    input.image =
      imageUrl;
  }

  let output;

  try {
    output =
      await runReplicate(
        mode === "image"
          ? I2V_MODEL
          : T2V_MODEL,
        input
      );
  } catch (error) {
    await refundUserCredits(
      user.id,
      creditResult.cost
    );

    throw error;
  }

  const videoUrl =
    await outputToUrl(
      output
    );

  if (!videoUrl) {
    await refundUserCredits(
      user.id,
      creditResult.cost
    );

    throw new Error(
      "Replicate completed but returned no video file."
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

  await updateUsage(
    user.id,
    {
      aiGenerations: 1,
      aiSeconds: duration,
    }
  );

  await addFinanceTransaction({
    type: "COST",
    category:
      "AI_PROVIDER",
    provider:
      "Replicate",
    amount:
      Number(
        providerCost.providerCostUsd
      ),
    currency: "USD",
    userId:
      user.id,
    seconds:
      duration,
  });

  return {
    ok: true,
    videoUrl:
      `${APP_URL}/outputs/${path.basename(finalFile)}`,
    providerVideoUrl:
      videoUrl,
    duration,
    ratio,
    style,
    quality,
    creditsUsed:
      creditResult.cost,
    creditsRemaining:
      creditResult.balance,
    model:
      mode === "image"
        ? I2V_MODEL
        : T2V_MODEL,
  };
}

app.use(
  "/outputs",
  express.static(OUTPUTS, {
    maxAge: "1h",
  })
);

app.get(
  "/health",
  async (req, res) => {
    res.json({
      ok: true,
      status: "healthy",
      service:
        "MAMAKI AI Video Creative Studio",
      version: VERSION,
      uptime:
        process.uptime(),
      timestamp: now(),
      checks: {
        server: true,
        ffmpeg: Boolean(
          ffmpegPath
        ),
        replicateConfigured:
          providerIsConfigured(),
        adminConfigured:
          Boolean(
            ADMIN_EMAIL &&
              ADMIN_PASSWORD
          ),
        recoveryConfigured:
          Boolean(
            RESEND_API_KEY &&
              RESEND_FROM
          ),
      },
    });
  }
);

app.get(
  "/api/health",
  async (req, res) => {
    res.json({
      ok: true,
      service:
        "MAMAKI AI Video Creative Studio",
      version: VERSION,
      replicateConfigured:
        providerIsConfigured(),
      timestamp: now(),
    });
  }
);

app.post(
  "/api/auth/register",
  async (req, res, next) => {
    try {
      const email =
        normalizeEmail(
          req.body?.email
        );

      const password =
        String(
          req.body?.password ||
            ""
        );

      const name =
        String(
          req.body?.name ||
            ""
        ).trim();

      if (
        !email ||
        !password
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Email and password are required.",
        });
      }

      if (
        password.length < 6
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Password must be at least 6 characters.",
        });
      }

      const existing =
        await findUserByEmail(
          email
        );

      if (existing) {
        return res.status(409).json({
          ok: false,
          error:
            "An account with this email already exists.",
        });
      }

      const credentials =
        hashPassword(
          password
        );

      const user = {
        id: randomUUID(),
        email,
        name:
          name ||
          email.split("@")[0],
        role:
          email ===
          ADMIN_EMAIL
            ? "admin"
            : "user",
        passwordHash:
          credentials.hash,
        passwordSalt:
          credentials.salt,
        createdAt: now(),
        updatedAt: now(),
      };

      const users =
        await getUsers();

      users.push(user);

      await saveUsers(
        users
      );

      await getUserCredits(
        user.id
      );

      await addSecurityEvent({
        action:
          "REGISTER",
        userId:
          user.id,
        email:
          user.email,
      });

      const token =
        await createSession(
          user
        );

      res.json({
        ok: true,
        token,
        user:
          safeUser(user),
        credits:
          await getUserCredits(
            user.id
          ),
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/auth/login",
  async (req, res, next) => {
    try {
      const email =
        normalizeEmail(
          req.body?.email
        );

      const password =
        String(
          req.body?.password ||
            ""
        );

      const user =
        await findUserByEmail(
          email
        );

      if (
        !user ||
        !verifyPassword(
          password,
          user.passwordHash,
          user.passwordSalt
        )
      ) {
        await addSecurityEvent({
          action:
            "LOGIN_FAILED",
          email,
        });

        return res.status(401).json({
          ok: false,
          error:
            "Invalid credentials.",
        });
      }

      if (
        email ===
        ADMIN_EMAIL &&
        user.role !==
          "admin"
      ) {
        user.role =
          "admin";

        const users =
          await getUsers();

        const index =
          users.findIndex(
            (item) =>
              item.id ===
              user.id
          );

        if (index >= 0) {
          users[index] =
            user;
          await saveUsers(
            users
          );
        }
      }

      const token =
        await createSession(
          user
        );

      await addSecurityEvent({
        action:
          "LOGIN_SUCCESS",
        userId:
          user.id,
        email:
          user.email,
      });

      res.json({
        ok: true,
        token,
        user:
          safeUser(user),
        credits:
          await getUserCredits(
            user.id
          ),
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/auth/logout",
  async (req, res) => {
    await destroySession(
      getBearer(req)
    );

    res.json({
      ok: true,
    });
  }
);

app.get(
  "/api/auth/me",
  requireUser,
  async (req, res) => {
    res.json({
      ok: true,
      user:
        safeUser(req.user),
      credits:
        await getUserCredits(
          req.user.id
        ),
      usableCredits:
        providerIsConfigured() &&
        !providerBlocked
          ? await getUserCredits(
              req.user.id
            )
          : 0,
      providerConfigured:
        providerIsConfigured(),
      providerBlocked,
    });
  }
);

app.get(
  "/api/billing/pricing",
  requireUser,
  async (req, res, next) => {
    try {
      const currency =
        normalizeCurrency(
          req.query.currency
        );

      const quality =
        String(
          req.query.quality ||
            "Standard HD"
        );

      const packages = [
        100,
        500,
        1000,
        2500,
        5000,
      ];

      const prices =
        await Promise.all(
          packages.map(
            (credits) =>
              calculateCreditPrice(
                credits,
                currency,
                quality
              )
          )
        );

      res.json({
        ok: true,
        currentCredits:
          await getUserCredits(
            req.user.id
          ),
        usableCredits:
          providerIsConfigured() &&
          !providerBlocked
            ? await getUserCredits(
                req.user.id
              )
            : 0,
        currency,
        quality,
        packages: prices,
        paymentProvider:
          PAYSTACK_SECRET_KEY
            ? "Paystack"
            : null,
        paymentConfigured:
          Boolean(
            PAYSTACK_SECRET_KEY
          ),
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/billing/paystack/initialize",
  requireUser,
  async (req, res, next) => {
    try {
      if (
        !PAYSTACK_SECRET_KEY
      ) {
        return res.status(503).json({
          ok: false,
          error:
            "Paystack is not configured.",
        });
      }

      const credits =
        Math.max(
          1,
          Math.floor(
            Number(
              req.body?.credits
            )
          )
        );

      const currency =
        normalizeCurrency(
          req.body?.currency
        );

      const quality =
        String(
          req.body?.quality ||
            "Standard HD"
        );

      const pricing =
        await calculateCreditPrice(
          credits,
          currency,
          quality
        );

      const callbackUrl =
        String(
          req.body?.callbackUrl ||
            `${APP_URL}/?payment=complete`
        );

      const response =
        await fetch(
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
              email:
                req.user.email,
              amount:
                pricing.amountSubunit,
              currency:
                pricing.currency,
              callback_url:
                callbackUrl,
              metadata: {
                mamaki: true,
                userId:
                  req.user.id,
                credits:
                  pricing.credits,
                currency:
                  pricing.currency,
                usdPrice:
                  pricing.usdPrice,
                providerCostUsd:
                  pricing.providerCostUsd,
                fxRate:
                  pricing.fxRate,
                fxLive:
                  pricing.fxLive,
              },
            }),
          }
        );

      const data =
        await response.json();

      if (
        !response.ok ||
        !data.status
      ) {
        throw new Error(
          data?.message ||
            "Paystack initialization failed."
        );
      }

      await recordPayment({
        reference:
          data.data.reference,
        userId:
          req.user.id,
        email:
          req.user.email,
        credits:
          pricing.credits,
        amount:
          pricing.amount,
        amountSubunit:
          pricing.amountSubunit,
        currency:
          pricing.currency,
        status:
          "initialized",
        pricing,
        authorizationUrl:
          data.data.authorization_url,
      });

      res.json({
        ok: true,
        reference:
          data.data.reference,
        authorizationUrl:
          data.data.authorization_url,
        accessCode:
          data.data.access_code,
        pricing,
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/billing/payment/:reference",
  requireUser,
  async (req, res, next) => {
    try {
      const reference =
        String(
          req.params.reference ||
            ""
        ).trim();

      const payments =
        await getPayments();

      const payment =
        payments.find(
          (item) =>
            item.reference ===
            reference &&
            item.userId ===
              req.user.id
        );

      if (!payment) {
        return res.status(404).json({
          ok: false,
          error:
            "Payment not found.",
        });
      }

      res.json({
        ok: true,
        payment,
        credits:
          await getUserCredits(
            req.user.id
          ),
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/payments/paystack/webhook",
  async (req, res, next) => {
    try {
      if (
        !PAYSTACK_SECRET_KEY
      ) {
        return res.status(503).send(
          "Paystack not configured"
        );
      }

      const signature =
        String(
          req.headers[
            "x-paystack-signature"
          ] || ""
        );

      const rawBody =
        JSON.stringify(
          req.body || {}
        );

      const expected =
        createHmac(
          "sha512",
          PAYSTACK_SECRET_KEY
        )
          .update(rawBody)
          .digest("hex");

      if (
        !signature ||
        signature !== expected
      ) {
        return res.status(401).send(
          "Invalid signature"
        );
      }

      const event =
        req.body || {};

      if (
        event.event !==
        "charge.success"
      ) {
        return res.json({
          ok: true,
          ignored: true,
        });
      }

      const data =
        event.data || {};

      const reference =
        String(
          data.reference || ""
        );

      const metadata =
        data.metadata || {};

      const userId =
        String(
          metadata.userId || ""
        );

      const credits =
        Math.max(
          0,
          Math.floor(
            Number(
              metadata.credits ||
                0
            )
          )
        );

      if (
        !reference ||
        !userId ||
        credits <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid payment metadata.",
        });
      }

      const payments =
        await getPayments();

      const existing =
        payments.find(
          (item) =>
            item.reference ===
            reference
        );

      if (
        existing?.fulfilled
      ) {
        return res.json({
          ok: true,
          alreadyFulfilled:
            true,
        });
      }

      const user =
        await findUserById(
          userId
        );

      if (!user) {
        return res.status(400).json({
          ok: false,
          error:
            "Payment user not found.",
        });
      }

      const newBalance =
        await addUserCredits(
          userId,
          credits,
          "PAYSTACK"
        );

      await recordPayment({
        reference,
        userId,
        email:
          user.email,
        credits,
        amount:
          Number(
            data.amount || 0
          ) / 100,
        currency:
          String(
            data.currency ||
              metadata.currency ||
              "NGN"
          ),
        status:
          "success",
        fulfilled:
          true,
        fulfilledAt:
          now(),
        gateway:
          "Paystack",
      });

      await addFinanceTransaction({
        type: "REVENUE",
        category:
          "CREDIT_PURCHASE",
        provider:
          "Paystack",
        amount:
          Number(
            data.amount || 0
          ) / 100,
        currency:
          String(
            data.currency ||
              metadata.currency ||
              "NGN"
          ),
        userId,
        reference,
        credits,
      });

      await addSecurityEvent({
        action:
          "PAYMENT_FULFILLED",
        userId,
        reference,
        credits,
      });

      res.json({
        ok: true,
        fulfilled: true,
        credits,
        balance:
          newBalance,
      });
    } catch (error) {
      await recordError(
        error,
        req
      );
      next(error);
    }
  }
);

app.get(
  "/api/credits",
  requireUser,
  async (req, res) => {
    const credits =
      await getUserCredits(
        req.user.id
      );

    res.json({
      ok: true,
      credits,
      remainingCredits:
        credits,
      usableCredits:
        providerIsConfigured() &&
        !providerBlocked
          ? credits
          : 0,
      providerConfigured:
        providerIsConfigured(),
      providerBlocked,
      creditsPer5Seconds:
        CREDITS_PER_5_SECONDS,
    });
  }
);

app.post(
  "/api/generate/text",
  requireUser,
  async (req, res, next) => {
    try {
      const result =
        await createGeneration(
          req,
          "text"
        );

      res.json(result);
    } catch (error) {
      await recordError(
        error,
        req
      );

      if (
        error.code ===
        "MAMAKI_CREDITS_INSUFFICIENT"
      ) {
        return res.status(402).json({
          ok: false,
          error:
            error.message,
          requiredCredits:
            error.requiredCredits,
          availableCredits:
            error.availableCredits,
        });
      }

      if (
        error.code ===
        "REPLICATE_PROVIDER_BLOCKED"
      ) {
        return res.status(402).json({
          ok: false,
          error:
            error.message,
        });
      }

      next(error);
    }
  }
);

app.post(
  "/api/generate/image",
  requireUser,
  upload.single("image"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "Reference image is required.",
        });
      }

      const result =
        await createGeneration(
          req,
          "image"
        );

      res.json(result);
    } catch (error) {
      await recordError(
        error,
        req
      );

      if (
        error.code ===
        "MAMAKI_CREDITS_INSUFFICIENT"
      ) {
        return res.status(402).json({
          ok: false,
          error:
            error.message,
          requiredCredits:
            error.requiredCredits,
          availableCredits:
            error.availableCredits,
        });
      }

      next(error);
    }
  }
);

app.post(
  "/api/studio/narration",
  requireUser,
  async (req, res, next) => {
    try {
      const text =
        String(
          req.body?.text ||
            ""
        ).trim();

      if (!text) {
        return res.status(400).json({
          ok: false,
          error:
            "Narration text is required.",
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
            "audio-24khz-48kbitrate-mono-mp3",
        }
      );

      const audio =
        await tts.toFile();

      await fs.writeFile(
        output,
        audio
      );

      await updateUsage(
        req.user.id,
        {
          narrationJobs: 1,
        }
      );

      res.json({
        ok: true,
        audioUrl:
          `${APP_URL}/outputs/${filename}`,
      });
    } catch (error) {
      await recordError(
        error,
        req
      );
      next(error);
    }
  }
);

app.get(
  "/api/admin/stats",
  requireAdmin,
  async (req, res, next) => {
    try {
      const users =
        await getUsers();

      const usage =
        await getUsage();

      const finance =
        await getFinance();

      const credits =
        await readCredits();

      let videos = 0;
      let seconds = 0;
      let narration = 0;
      let projects = 0;

      for (
        const item of Object.values(
          usage
        )
      ) {
        videos +=
          Number(
            item.aiGenerations ||
              0
          );

        seconds +=
          Number(
            item.aiSeconds ||
              0
          );

        narration +=
          Number(
            item.narrationJobs ||
              0
          );

        projects +=
          Number(
            item.studioJobs ||
              0
          );
      }

      const today =
        new Date();

      const startDay =
        new Date(
          today
        );

      startDay.setHours(
        0,
        0,
        0,
        0
      );

      const startWeek =
        new Date(
          today
        );

      startWeek.setDate(
        startWeek.getDate() -
          7
      );

      const startMonth =
        new Date(
          today
        );

      startMonth.setDate(
        startMonth.getDate() -
          30
      );

      const newToday =
        users.filter(
          (u) =>
            Date.parse(
              u.createdAt
            ) >=
            startDay.getTime()
        ).length;

      const newWeek =
        users.filter(
          (u) =>
            Date.parse(
              u.createdAt
            ) >=
            startWeek.getTime()
        ).length;

      const newMonth =
        users.filter(
          (u) =>
            Date.parse(
              u.createdAt
            ) >=
            startMonth.getTime()
        ).length;

      const sessions =
        await readJson(
          SESSIONS_FILE,
          {}
        );

      const active =
        Object.values(
          sessions
        ).filter(
          (s) =>
            Number(
              s.expiresAt || 0
            ) >
            Date.now()
        ).length;

      const errors =
        await readJson(
          ERRORS_FILE,
          []
        );

      res.json({
        ok: true,
        version: VERSION,
        users:
          users.length,
        active,
        newToday,
        newWeek,
        newMonth,
        admins:
          users.filter(
            (u) =>
              u.role === "admin"
          ).length,
        videosGenerated:
          videos,
        aiSeconds:
          seconds,
        narrations:
          narration,
        projects,
        completedJobs:
          videos,
        processingJobs: 0,
        failedJobs:
          errors.length,
        mamakiCredits:
          Object.values(
            credits.users
          ).reduce(
            (a, b) =>
              a +
              Number(b || 0),
            0
          ),
        profitNGN:
          finance.wallet.profit,
        uptime:
          process.uptime(),
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/admin/users",
  requireAdmin,
  async (req, res, next) => {
    try {
      const users =
        await getUsers();

      const usage =
        await getUsage();

      const credits =
        await readCredits();

      res.json({
        ok: true,
        users:
          users.map(
            (user) => ({
              ...safeUser(
                user
              ),
              credits:
                Number(
                  credits.users[
                    user.id
                  ] || 0
                ),
              usage:
                usage[
                  user.id
                ] || {
                  aiGenerations: 0,
                  aiSeconds: 0,
                  narrationJobs: 0,
                  studioJobs: 0,
                },
            })
          ),
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/admin/jobs",
  requireAdmin,
  async (req, res) => {
    const errors =
      await readJson(
        ERRORS_FILE,
        []
      );

    res.json({
      ok: true,
      jobs:
        errors.map(
          (item) => ({
            id:
              item.id,
            status:
              "failed",
            error:
              item.message,
            createdAt:
              item.createdAt,
          })
        ),
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
        await readJson(
          ERRORS_FILE,
          []
        ),
    });
  }
);

app.get(
  "/api/admin/security",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      events:
        await readJson(
          SECURITY_FILE,
          []
        ),
    });
  }
);

app.get(
  "/api/admin/credits",
  requireAdmin,
  async (req, res, next) => {
    try {
      const data =
        await readCredits();

      const transactions =
        data.transactions;

      const issued =
        transactions
          .filter(
            (t) =>
              t.type ===
              "ISSUE"
          )
          .reduce(
            (sum, t) =>
              sum +
              Number(
                t.amount || 0
              ),
            0
          );

      const consumed =
        transactions
          .filter(
            (t) =>
              t.type ===
              "CONSUME"
          )
          .reduce(
            (sum, t) =>
              sum +
              Math.abs(
                Number(
                  t.amount || 0
                )
              ),
            0
          );

      const refunded =
        transactions
          .filter(
            (t) =>
              t.type ===
              "REFUND"
          )
          .reduce(
            (sum, t) =>
              sum +
              Number(
                t.amount || 0
              ),
            0
          );

      const assigned =
        Object.values(
          data.users
        ).reduce(
          (sum, value) =>
            sum +
            Number(
              value || 0
            ),
          0
        );

      res.json({
        ok: true,
        issued,
        consumed,
        refunded,
        remaining:
          assigned,
        users:
          data.users,
        transactions:
          transactions.slice(
            0,
            500
          ),
        replicate: {
          configured:
            Boolean(
              REPLICATE_API_TOKEN
            ),
          balance: 0,
          balanceKnown: false,
          usable:
            Boolean(
              REPLICATE_API_TOKEN
            ) &&
            !providerBlocked,
          note:
            providerBlocked
              ? "Replicate recently reported insufficient credit. AI generation is blocked until provider credit is restored."
              : "Replicate's public account API does not expose prepaid balance, so no provider balance is fabricated.",
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/admin/credits/adjust",
  requireAdmin,
  async (req, res, next) => {
    try {
      const userId =
        String(
          req.body?.userId ||
            ""
        );

      const amount =
        Number(
          req.body?.amount
        );

      if (
        !userId ||
        !Number.isFinite(
          amount
        ) ||
        amount === 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Valid userId and non-zero amount are required.",
        });
      }

      if (amount > 0) {
        const balance =
          await addUserCredits(
            userId,
            amount,
            "ADMIN_ADJUSTMENT"
          );

        await addSecurityEvent({
          action:
            "ADMIN_CREDIT_ADJUSTMENT",
          adminId:
            req.user.id,
          userId,
          amount,
        });

        return res.json({
          ok: true,
          balance,
        });
      }

      const data =
        await readCredits();

      const balance =
        Number(
          data.users[userId] ||
            0
        );

      const deduction =
        Math.abs(
          Math.floor(
            amount
          )
        );

      if (
        balance <
        deduction
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "User does not have enough credits for this adjustment.",
        });
      }

      data.users[userId] =
        balance -
        deduction;

      data.transactions.push({
        id: randomUUID(),
        type: "CONSUME",
        source:
          "ADMIN_ADJUSTMENT",
        userId,
        amount:
          -deduction,
        createdAt:
          now(),
      });

      await writeCredits(
        data
      );

      await addSecurityEvent({
        action:
          "ADMIN_CREDIT_ADJUSTMENT",
        adminId:
          req.user.id,
        userId,
        amount:
          -deduction,
      });

      res.json({
        ok: true,
        balance:
          data.users[userId],
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/admin/finance",
  requireAdmin,
  async (req, res, next) => {
    try {
      const finance =
        await getFinance();

      res.json({
        ok: true,
        ...finance,
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/admin/billing",
  requireAdmin,
  async (req, res, next) => {
    try {
      const finance =
        await getFinance();

      const payments =
        await getPayments();

      const fx =
        await getFxRates();

      const pricing =
        await calculateCreditPrice(
          100,
          "NGN"
        );

      res.json({
        ok: true,
        provider:
          PAYSTACK_SECRET_KEY
            ? "Paystack"
            : null,
        configured:
          Boolean(
            PAYSTACK_SECRET_KEY
          ),
        publicKey:
          PAYSTACK_PUBLIC_KEY ||
          null,
        fx,
        pricing,
        finance,
        payments:
          payments.slice(
            0,
            500
          ),
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/admin/finance/transaction",
  requireAdmin,
  async (req, res, next) => {
    try {
      const type =
        String(
          req.body?.type ||
            "COST"
        ).toUpperCase();

      const amount =
        Number(
          req.body?.amount
        );

      const currency =
        normalizeCurrency(
          req.body?.currency
        );

      if (
        ![
          "REVENUE",
          "REFUND",
          "COST",
        ].includes(type)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid transaction type.",
        });
      }

      if (
        !Number.isFinite(
          amount
        ) ||
        amount <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Amount must be greater than zero.",
        });
      }

      const item =
        await addFinanceTransaction({
          type,
          category:
            String(
              req.body?.category ||
                "ADMIN"
            ),
          amount,
          currency,
          description:
            String(
              req.body?.description ||
                ""
            ),
        });

      res.json({
        ok: true,
        transaction:
          item,
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  "/api/admin/withdraw",
  requireAdmin,
  async (req, res, next) => {
    try {
      if (
        !PAYSTACK_SECRET_KEY
      ) {
        return res.status(503).json({
          ok: false,
          error:
            "Paystack is not configured for withdrawals.",
        });
      }

      const amount =
        Number(
          req.body?.amount
        );

      const accountNumber =
        String(
          req.body?.accountNumber ||
            ""
        ).trim();

      const bankCode =
        String(
          req.body?.bankCode ||
            ""
        ).trim();

      const accountName =
        String(
          req.body?.accountName ||
            ""
        ).trim();

      if (
        !Number.isFinite(
          amount
        ) ||
        amount <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Withdrawal amount must be greater than zero.",
        });
      }

      if (
        !accountNumber ||
        !bankCode
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Bank account number and bank code are required.",
        });
      }

      const finance =
        await getFinance();

      if (
        finance.wallet.profit <
        amount
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Withdrawal exceeds available profit.",
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
                accountName ||
                "MAMAKI Owner",
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
              source:
                "balance",
              amount:
                Math.round(
                  amount * 100
                ),
              recipient:
                recipientData.data.recipient_code,
              reason:
                "MAMAKI AI profit withdrawal",
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
            "Paystack withdrawal failed."
        );
      }

      const withdrawal = {
        id: randomUUID(),
        reference:
          transferData.data.reference,
        amount,
        currency:
          "NGN",
        status:
          transferData.data.status ||
          "pending",
        accountNumber:
          accountNumber.slice(-4),
        bankCode,
        createdAt:
          now(),
      };

      const withdrawals =
        await readJson(
          WITHDRAWALS_FILE,
          []
        );

      withdrawals.unshift(
        withdrawal
      );

      await writeJson(
        WITHDRAWALS_FILE,
        withdrawals
      );

      await addFinanceTransaction({
        type: "COST",
        category:
          "PROFIT_WITHDRAWAL",
        provider:
          "Paystack",
        amount,
        currency:
          "NGN",
        description:
          "Owner profit withdrawal",
        reference:
          withdrawal.reference,
      });

      await addSecurityEvent({
        action:
          "OWNER_PROFIT_WITHDRAWAL",
        adminId:
          req.user.id,
        amount,
        reference:
          withdrawal.reference,
      });

      res.json({
        ok: true,
        withdrawal,
      });
    } catch (error) {
      await recordError(
        error,
        req
      );
      next(error);
    }
  }
);

app.get(
  "/api/admin/withdrawals",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      withdrawals:
        await readJson(
          WITHDRAWALS_FILE,
          []
        ),
    });
  }
);

app.get(
  "/api/admin/config",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      appUrl:
        APP_URL,
      models: {
        textToVideo:
          T2V_MODEL,
        imageToVideo:
          I2V_MODEL,
      },
      limits: {
        minimumDuration:
          MIN_DURATION,
        maximumDuration:
          MAX_DURATION,
        uploadMB: 100,
      },
      payments: {
        provider:
          PAYSTACK_SECRET_KEY
            ? "Paystack"
            : null,
        configured:
          Boolean(
            PAYSTACK_SECRET_KEY
          ),
      },
      replicate: {
        configured:
          providerIsConfigured(),
        providerBlocked,
      },
    });
  }
);

app.use(
  async (
    error,
    req,
    res,
    next
  ) => {
    try {
      await recordError(
        error,
        req
      );
    } catch {}

    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }

    const status =
      Number(
        error?.status ||
          error?.statusCode ||
          500
      );

    res.status(
      status >= 400 &&
        status < 600
        ? status
        : 500
    ).json({
      ok: false,
      error:
        String(
          error?.message ||
            "Internal server error."
        ),
      version:
        VERSION,
    });
  }
);

app.get(
  "/api",
  async (req, res) => {
    res.json({
      ok: true,
      service:
        "MAMAKI AI Video Creative Studio",
      version: VERSION,
      endpoints: {
        health:
          "/health",
        login:
          "/api/auth/login",
        register:
          "/api/auth/register",
        credits:
          "/api/credits",
        pricing:
          "/api/billing/pricing",
        paystack:
          "/api/billing/paystack/initialize",
        textToVideo:
          "/api/generate/text",
        imageToVideo:
          "/api/generate/image",
        admin:
          "/admin",
      },
    });
  }
);

async function serveFrontend(
  req,
  res,
  next
) {
  if (
    req.path.startsWith(
      "/api"
    ) ||
    req.path.startsWith(
      "/outputs"
    ) ||
    req.path ===
      "/health"
  ) {
    return next();
  }

  const indexPath =
    path.join(
      ROOT,
      "index.html"
    );

  if (
    await exists(
      indexPath
    )
  ) {
    return res.sendFile(
      indexPath
    );
  }

  res.status(404).send(
    "MAMAKI AI interface not found."
  );
}

app.use(
  serveFrontend
);

await ensureStorage();
await ensureAdminAccount();

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `MAMAKI AI ${VERSION} running on ${HOST}:${PORT}`
    );
    console.log(
      `Replicate configured: ${providerIsConfigured()}`
    );
    console.log(
      `Paystack configured: ${Boolean(PAYSTACK_SECRET_KEY)}`
    );
    console.log(
      `Admin configured: ${Boolean(ADMIN_EMAIL && ADMIN_PASSWORD)}`
    );
  }
);
