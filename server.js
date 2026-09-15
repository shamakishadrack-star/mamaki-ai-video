// VERIFIED MAMAKI AI SERVER.JS v18.0.0
// GitHub editor: https://github.com/shamakishadrack-star/mamaki-ai-video/edit/main/server.js
//
// IMPORTANT:
// 1. /admin is now a PRIVATE, SEPARATE ADMIN DASHBOARD.
// 2. / is the normal MAMAKI user interface.
// 3. A Buy MAMAKI Credits panel is injected into the normal interface.
// 4. User credits are shown in the user interface.
// 5. Paystack payments are automatically fulfilled through the webhook.
// 6. FX pricing updates automatically.
// 7. Admin finance, credits, payments and withdrawals remain private.
// 8. This file is intentionally self-contained and syntax-safe.

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
const VERSION = "18.0.0";

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

const ADMIN_EMAIL =
  String(process.env.ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();

const ADMIN_PASSWORD =
  String(process.env.ADMIN_PASSWORD || "");

const SESSION_SECRET =
  String(process.env.SESSION_SECRET || "");

const REPLICATE_API_TOKEN =
  String(process.env.REPLICATE_API_TOKEN || "").trim();

const PAYSTACK_SECRET_KEY =
  String(process.env.PAYSTACK_SECRET_KEY || "").trim();

const PAYSTACK_PUBLIC_KEY =
  String(process.env.PAYSTACK_PUBLIC_KEY || "").trim();

const FX_API_URL =
  String(
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

const PAYSTACK_CURRENCY_DEFAULT =
  String(
    process.env.PAYSTACK_CURRENCY_DEFAULT || "NGN"
  ).toUpperCase();

const RESEND_API_KEY =
  String(process.env.RESEND_API_KEY || "").trim();

const RESEND_FROM =
  String(process.env.RESEND_FROM || "").trim();

const APP_URL =
  String(
    process.env.APP_URL ||
      "https://mamaki-ai-video.onrender.com"
  ).replace(/\/$/, "");

const STARTER_CREDITS = Math.max(
  0,
  Number(process.env.STARTER_CREDITS || 100)
);

const CREDITS_PER_5_SECONDS = Math.max(
  1,
  Number(process.env.CREDITS_PER_5_SECONDS || 10)
);

const replicate =
  REPLICATE_API_TOKEN
    ? new Replicate({
        auth: REPLICATE_API_TOKEN,
      })
    : null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

/*
|--------------------------------------------------------------------------
| BODY PARSING
|--------------------------------------------------------------------------
*/

app.use(
  express.json({
    limit: "10mb",
    verify: (req, res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
  })
);

/*
|--------------------------------------------------------------------------
| BASIC HELPERS
|--------------------------------------------------------------------------
*/

function now() {
  return new Date().toISOString();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, {
    recursive: true,
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

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(
      file,
      "utf8"
    );

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await ensureDir(
    path.dirname(file)
  );

  const temporary =
    `${file}.${randomUUID()}.tmp`;

  await fs.writeFile(
    temporary,
    JSON.stringify(
      value,
      null,
      2
    ),
    "utf8"
  );

  await fs.rename(
    temporary,
    file
  );
}

async function readStore(
  file,
  fallback
) {
  return readJson(
    file,
    fallback
  );
}

async function writeStore(
  file,
  value
) {
  return writeJson(
    file,
    value
  );
}

async function ensureStorage() {
  await Promise.all([
    ensureDir(TMP),
    ensureDir(OUTPUTS),
    ensureDir(PROJECTS),
    ensureDir(DATA),
  ]);

  const files = [
    [
      USERS_FILE,
      [],
    ],
    [
      SESSIONS_FILE,
      {},
    ],
    [
      ERRORS_FILE,
      [],
    ],
    [
      USAGE_FILE,
      {},
    ],
    [
      RESET_FILE,
      {},
    ],
    [
      SECURITY_FILE,
      [],
    ],
    [
      CREDITS_FILE,
      {
        pool: 0,
        users: {},
        transactions: [],
        updatedAt: now(),
      },
    ],
    [
      FINANCE_FILE,
      {
        transactions: [],
        wallet: {
          revenue: 0,
          refunds: 0,
          costs: 0,
          profit: 0,
        },
      },
    ],
    [
      PRICING_FILE,
      {
        fx: null,
        updatedAt: null,
      },
    ],
    [
      PAYMENTS_FILE,
      [],
    ],
    [
      WITHDRAWALS_FILE,
      [],
    ],
  ];

  for (const [file, fallback] of files) {
    if (!(await exists(file))) {
      await writeJson(
        file,
        fallback
      );
    }
  }
}

/*
|--------------------------------------------------------------------------
| NORMALIZATION
|--------------------------------------------------------------------------
*/

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeCurrency(value) {
  const currency =
    String(
      value ||
        PAYSTACK_CURRENCY_DEFAULT
    ).toUpperCase();

  return currency === "USD"
    ? "USD"
    : "NGN";
}

function safeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name || "",
    role: user.role || "user",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/*
|--------------------------------------------------------------------------
| PASSWORDS
|--------------------------------------------------------------------------
*/

function hashPassword(
  password,
  salt = randomBytes(16).toString("hex")
) {
  const hash =
    scryptSync(
      String(password),
      salt,
      64
    ).toString("hex");

  return {
    salt,
    hash,
  };
}

function verifyPassword(
  password,
  storedHash,
  salt
) {
  try {
    const candidate =
      scryptSync(
        String(password),
        salt,
        64
      );

    const stored =
      Buffer.from(
        String(storedHash),
        "hex"
      );

    return (
      candidate.length ===
        stored.length &&
      timingSafeEqual(
        candidate,
        stored
      )
    );
  } catch {
    return false;
  }
}

/*
|--------------------------------------------------------------------------
| SESSIONS
|--------------------------------------------------------------------------
*/

function sessionHash(token) {
  return createHash("sha256")
    .update(
      `${SESSION_SECRET}:${token}`
    )
    .digest("hex");
}

function generateToken() {
  return randomBytes(48).toString("hex");
}

async function getUsers() {
  const data =
    await readJson(
      USERS_FILE,
      []
    );

  return Array.isArray(data)
    ? data
    : [];
}

async function saveUsers(users) {
  await writeJson(
    USERS_FILE,
    users
  );
}

async function findUserByEmail(
  email
) {
  const users =
    await getUsers();

  const normalized =
    normalizeEmail(email);

  return (
    users.find(
      (user) =>
        normalizeEmail(
          user.email
        ) === normalized
    ) || null
  );
}

async function findUserById(id) {
  const users =
    await getUsers();

  return (
    users.find(
      (user) =>
        user.id === id
    ) || null
  );
}

async function ensureAdminAccount() {
  if (
    !ADMIN_EMAIL ||
    !ADMIN_PASSWORD
  ) {
    return;
  }

  const users =
    await getUsers();

  let user =
    users.find(
      (item) =>
        normalizeEmail(
          item.email
        ) === ADMIN_EMAIL
    );

  if (!user) {
    const credentials =
      hashPassword(
        ADMIN_PASSWORD
      );

    user = {
      id: randomUUID(),
      email: ADMIN_EMAIL,
      name:
        "MAMAKI Administrator",
      role: "admin",
      passwordHash:
        credentials.hash,
      passwordSalt:
        credentials.salt,
      createdAt: now(),
      updatedAt: now(),
    };

    users.push(user);

    await saveUsers(
      users
    );

    return;
  }

  let changed = false;

  if (user.role !== "admin") {
    user.role = "admin";
    changed = true;
  }

  if (
    ADMIN_PASSWORD &&
    !verifyPassword(
      ADMIN_PASSWORD,
      user.passwordHash,
      user.passwordSalt
    )
  ) {
    const credentials =
      hashPassword(
        ADMIN_PASSWORD
      );

    user.passwordHash =
      credentials.hash;

    user.passwordSalt =
      credentials.salt;

    changed = true;
  }

  if (changed) {
    user.updatedAt = now();

    await saveUsers(
      users
    );
  }
}

async function createSession(user) {
  const sessions =
    await readJson(
      SESSIONS_FILE,
      {}
    );

  const token =
    generateToken();

  const key =
    sessionHash(token);

  sessions[key] = {
    userId: user.id,
    createdAt: now(),
    expiresAt:
      Date.now() +
      30 *
        24 *
        60 *
        60 *
        1000,
  };

  await writeJson(
    SESSIONS_FILE,
    sessions
  );

  return token;
}

async function destroySession(
  token
) {
  if (!token) {
    return;
  }

  const sessions =
    await readJson(
      SESSIONS_FILE,
      {}
    );

  delete sessions[
    sessionHash(token)
  ];

  await writeJson(
    SESSIONS_FILE,
    sessions
  );
}

function getBearer(req) {
  const authorization =
    String(
      req.headers.authorization ||
        ""
    );

  if (
    authorization.startsWith(
      "Bearer "
    )
  ) {
    return authorization
      .slice(7)
      .trim();
  }

  return String(
    req.headers[
      "x-session-token"
    ] || ""
  ).trim();
}

async function getCurrentUser(req) {
  const token =
    getBearer(req);

  if (!token) {
    return null;
  }

  const sessions =
    await readJson(
      SESSIONS_FILE,
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
    !session.expiresAt ||
    Number(session.expiresAt) <
      Date.now()
  ) {
    delete sessions[
      sessionHash(token)
    ];

    await writeJson(
      SESSIONS_FILE,
      sessions
    );

    return null;
  }

  return findUserById(
    session.userId
  );
}

async function requireUser(
  req,
  res,
  next
) {
  try {
    const user =
      await getCurrentUser(
        req
      );

    if (!user) {
      return res.status(401).json({
        ok: false,
        error:
          "Authentication required.",
      });
    }

    req.user = user;

    next();
  } catch (error) {
    next(error);
  }
}

async function requireAdmin(
  req,
  res,
  next
) {
  try {
    const user =
      await getCurrentUser(
        req
      );

    if (!user) {
      return res.status(401).json({
        ok: false,
        error:
          "Authentication required.",
      });
    }

    if (
      user.role !== "admin"
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "Administrator access required.",
      });
    }

    req.user = user;

    next();
  } catch (error) {
    next(error);
  }
}

/*
|--------------------------------------------------------------------------
| SECURITY / ERRORS
|--------------------------------------------------------------------------
*/

async function addSecurityEvent(
  event
) {
  const events =
    await readJson(
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
    events.slice(
      0,
      1000
    )
  );
}

async function recordError(
  error,
  req = null
) {
  const errors =
    await readJson(
      ERRORS_FILE,
      []
    );

  errors.unshift({
    id: randomUUID(),
    message:
      String(
        error?.message ||
          error ||
          "Unknown error"
      ),
    stack:
      String(
        error?.stack || ""
      ),
    path:
      req?.originalUrl ||
      "",
    method:
      req?.method ||
      "",
    createdAt: now(),
  });

  await writeJson(
    ERRORS_FILE,
    errors.slice(
      0,
      500
    )
  );
}

/*
|--------------------------------------------------------------------------
| USAGE
|--------------------------------------------------------------------------
*/

async function getUsage() {
  const value =
    await readJson(
      USAGE_FILE,
      {}
    );

  return value &&
    typeof value ===
      "object" &&
    !Array.isArray(value)
    ? value
    : {};
}

async function updateUsage(
  userId,
  changes = {}
) {
  const usage =
    await getUsage();

  if (!usage[userId]) {
    usage[userId] = {
      aiGenerations: 0,
      aiSeconds: 0,
      studioJobs: 0,
      narrationJobs: 0,
      updatedAt: now(),
    };
  }

  for (
    const [
      key,
      value,
    ] of Object.entries(
      changes
    )
  ) {
    usage[userId][key] =
      Number(
        usage[userId][key] ||
          0
      ) +
      Number(value || 0);
  }

  usage[userId].updatedAt =
    now();

  await writeJson(
    USAGE_FILE,
    usage
  );

  return usage[userId];
}

/*
|--------------------------------------------------------------------------
| MAMAKI CREDITS
|--------------------------------------------------------------------------
*/

async function readCredits() {
  const data =
    await readJson(
      CREDITS_FILE,
      {}
    );

  return {
    pool:
      Number(
        data?.pool || 0
      ),
    users:
      data &&
      typeof data.users ===
        "object" &&
      data.users
        ? data.users
        : {},
    transactions:
      Array.isArray(
        data?.transactions
      )
        ? data.transactions
        : [],
    updatedAt:
      data?.updatedAt ||
      now(),
  };
}

async function writeCredits(
  data
) {
  data.updatedAt = now();

  await writeJson(
    CREDITS_FILE,
    data
  );
}

async function getUserCredits(
  userId
) {
  const data =
    await readCredits();

  if (
    !Object.prototype.hasOwnProperty.call(
      data.users,
      userId
    )
  ) {
    data.users[userId] =
      STARTER_CREDITS;

    data.transactions.push({
      id: randomUUID(),
      type: "ISSUE",
      source: "STARTER",
      userId,
      amount:
        STARTER_CREDITS,
      createdAt: now(),
    });

    await writeCredits(
      data
    );
  }

  return Number(
    data.users[userId] || 0
  );
}

async function addUserCredits(
  userId,
  amount,
  source = "ADMIN"
) {
  const n =
    Math.floor(
      Number(amount || 0)
    );

  if (
    !Number.isFinite(n) ||
    n <= 0
  ) {
    throw new Error(
      "Credit amount must be greater than zero."
    );
  }

  const data =
    await readCredits();

  data.users[userId] =
    Number(
      data.users[userId] || 0
    ) + n;

  data.transactions.push({
    id: randomUUID(),
    type: "ISSUE",
    source,
    userId,
    amount: n,
    createdAt: now(),
  });

  await writeCredits(
    data
  );

  return data.users[userId];
}

async function consumeUserCredits(
  userId,
  seconds
) {
  const cost =
    Math.max(
      1,
      Math.ceil(
        Number(seconds || 5) /
          5
      ) *
        CREDITS_PER_5_SECONDS
    );

  const data =
    await readCredits();

  if (
    !Object.prototype.hasOwnProperty.call(
      data.users,
      userId
    )
  ) {
    data.users[userId] =
      STARTER_CREDITS;
  }

  const balance =
    Number(
      data.users[userId] || 0
    );

  if (
    balance < cost
  ) {
    const error =
      new Error(
        `Insufficient MAMAKI credits. Required ${cost}, available ${balance}.`
      );

    error.code =
      "MAMAKI_CREDITS_INSUFFICIENT";

    error.requiredCredits =
      cost;

    error.availableCredits =
      balance;

    throw error;
  }

  data.users[userId] =
    balance - cost;

  data.transactions.push({
    id: randomUUID(),
    type: "CONSUME",
    source:
      "AI_GENERATION",
    userId,
    amount: -cost,
    seconds:
      Number(seconds || 0),
    createdAt: now(),
  });

  await writeCredits(
    data
  );

  return {
    cost,
    balance:
      data.users[userId],
  };
}

async function refundUserCredits(
  userId,
  amount
) {
  const n =
    Math.max(
      0,
      Number(amount || 0)
    );

  if (!n) {
    return;
  }

  const data =
    await readCredits();

  data.users[userId] =
    Number(
      data.users[userId] || 0
    ) + n;

  data.transactions.push({
    id: randomUUID(),
    type: "REFUND",
    source:
      "AI_GENERATION_FAILED",
    userId,
    amount: n,
    createdAt: now(),
  });

  await writeCredits(
    data
  );
}

/*
|--------------------------------------------------------------------------
| FX + SMART PRICING
|--------------------------------------------------------------------------
*/

async function getFxRates() {
  const current =
    Date.now();

  const store =
    await readStore(
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
      Date.parse(
        store.fx.updatedAt
      ) <
      30 *
        60 *
        1000
  ) {
    return store.fx;
  }

  try {
    const response =
      await fetch(
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

    const usdNgn =
      Number(
        data?.rates?.NGN || 0
      );

    if (
      !Number.isFinite(
        usdNgn
      ) ||
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
      source:
        FX_API_URL,
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
        NGN:
          DEFAULT_USD_NGN_RATE,
      },
      source:
        "configured fallback",
      updatedAt: now(),
      live: false,
      error:
        String(
          error?.message ||
            error
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
  const scenes =
    Math.max(
      1,
      Math.ceil(
        Number(credits || 0) /
          CREDITS_PER_5_SECONDS
      )
    );

  const q =
    String(
      quality ||
        "Standard HD"
    ).toLowerCase();

  const providerCost =
    q.includes("high") ||
    q.includes("cinematic")
      ? PROVIDER_COST_720P_USD
      : PROVIDER_COST_480P_USD;

  return {
    scenes,
    providerCostUsd:
      scenes *
      providerCost,
  };
}

async function calculateCreditPrice(
  credits,
  currency = PAYSTACK_CURRENCY_DEFAULT,
  quality = "Standard HD"
) {
  const c =
    Math.max(
      1,
      Math.floor(
        Number(credits || 0)
      )
    );

  const cur =
    normalizeCurrency(
      currency
    );

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
        customerUsd.toFixed(
          4
        )
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
    fxLive:
      Boolean(fx.live),
    fxUpdatedAt:
      fx.updatedAt,
    marginTarget:
      TARGET_MARGIN,
    paymentFeeBuffer:
      PAYMENT_FEE_BUFFER,
    fxBuffer:
      FX_BUFFER,
  };
}

/*
|--------------------------------------------------------------------------
| FINANCE
|--------------------------------------------------------------------------
*/

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
    data.transactions =
      [];
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

  data.transactions.unshift(
    item
  );

  if (
    item.type ===
    "REVENUE"
  ) {
    data.wallet.revenue +=
      Number(
        item.amount || 0
      );
  }

  if (
    item.type ===
    "REFUND"
  ) {
    data.wallet.refunds +=
      Number(
        item.amount || 0
      );
  }

  if (
    item.type ===
    "COST"
  ) {
    data.wallet.costs +=
      Number(
        item.amount || 0
      );
  }

  data.wallet.profit =
    Number(
      data.wallet.revenue || 0
    ) -
    Number(
      data.wallet.refunds || 0
    ) -
    Number(
      data.wallet.costs || 0
    );

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

/*
|--------------------------------------------------------------------------
| PAYMENTS
|--------------------------------------------------------------------------
*/

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

async function savePayments(
  payments
) {
  await writeJson(
    PAYMENTS_FILE,
    payments
  );
}

async function recordPayment(
  payment
) {
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

/*
|--------------------------------------------------------------------------
| VIDEO HELPERS
|--------------------------------------------------------------------------
*/

function wanFrames(
  seconds
) {
  return Number(seconds) <= 5
    ? 81
    : 121;
}

function clampDuration(
  value
) {
  const n =
    Number(value);

  if (
    !Number.isFinite(n)
  ) {
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

function validRatio(
  value
) {
  const ratio =
    String(
      value || "16:9"
    );

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
    String(
      prompt || ""
    ).trim(),
    `Visual style: ${style}.`,
    "High quality cinematic composition.",
    "Strong visual continuity.",
    "Natural realistic motion.",
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

    providerBlocked =
      false;

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
      providerBlocked =
        true;
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

      if (url) {
        return url;
      }
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

        if (url) {
          return url;
        }
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
        "drawtext=text='MAMAKI':fontcolor=white@0.85:fontsize=22:borderw=2:bordercolor=black@0.45:x=w-tw-24:y=h-th-24",
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

/*
|--------------------------------------------------------------------------
| GENERATION
|--------------------------------------------------------------------------
*/

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

  const creditEstimate =
    Math.max(
      1,
      Math.ceil(
        duration / 5
      ) *
        CREDITS_PER_5_SECONDS
    );

  const providerCost =
    providerCostForCredits(
      creditEstimate,
      quality
    );

  if (
    providerBlocked
  ) {
    const error =
      new Error(
        "Replicate currently has insufficient provider credit. Please restore provider credit before generating AI videos."
      );

    error.code =
      "REPLICATE_PROVIDER_BLOCKED";

    throw error;
  }

  const creditResult =
    await consumeUserCredits(
      user.id,
      duration
    );

  let imageUrl =
    null;

  if (
    req.file &&
    mode === "image"
  ) {
    imageUrl =
      `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
  }

  const input = {
    prompt:
      enhancePrompt(
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

  if (imageUrl) {
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

  try {
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
        aiSeconds:
          duration,
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
      currency:
        "USD",
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
  } catch (error) {
    await refundUserCredits(
      user.id,
      creditResult.cost
    );

    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| OUTPUTS
|--------------------------------------------------------------------------
*/

app.use(
  "/outputs",
  express.static(
    OUTPUTS,
    {
      maxAge: "1h",
    }
  )
);

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get(
  "/health",
  async (req, res) => {
    res.json({
      ok: true,
      status: "healthy",
      service:
        "MAMAKI AI Video Creative Studio",
      version:
        VERSION,
      uptime:
        process.uptime(),
      timestamp:
        now(),
      checks: {
        server: true,
        ffmpeg:
          Boolean(
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
      version:
        VERSION,
      replicateConfigured:
        providerIsConfigured(),
      timestamp:
        now(),
    });
  }
);

/*
|--------------------------------------------------------------------------
| AUTH
|--------------------------------------------------------------------------
*/

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
        password.length <
        6
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
        createdAt:
          now(),
        updatedAt:
          now(),
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
        ADMIN_EMAIL
      ) {
        if (
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

          if (
            index >= 0
          ) {
            users[index] =
              user;

            await saveUsers(
              users
            );
          }
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
        role:
          user.role,
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
    const credits =
      await getUserCredits(
        req.user.id
      );

    res.json({
      ok: true,
      user:
        safeUser(
          req.user
        ),
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
    });
  }
);

/*
|--------------------------------------------------------------------------
| BILLING / USER CREDIT PURCHASE
|--------------------------------------------------------------------------
*/

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

      const currentCredits =
        await getUserCredits(
          req.user.id
        );

      res.json({
        ok: true,
        currentCredits,
        remainingCredits:
          currentCredits,
        usableCredits:
          providerIsConfigured() &&
          !providerBlocked
            ? currentCredits
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
        fxSource:
          "Automatic FX pricing",
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
            body:
              JSON.stringify({
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
        !data.status ||
        !data.data
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
        fulfilled:
          false,
        pricing,
        authorizationUrl:
          data.data.authorization_url,
      });

      await addSecurityEvent({
        action:
          "PAYMENT_INITIALIZED",
        userId:
          req.user.id,
        reference:
          data.data.reference,
        credits:
          pricing.credits,
        amount:
          pricing.amount,
        currency:
          pricing.currency,
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

/*
|--------------------------------------------------------------------------
| PAYSTACK WEBHOOK
|--------------------------------------------------------------------------
*/

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
        req.rawBody ||
        Buffer.from(
          JSON.stringify(
            req.body || {}
          )
        );

      const expected =
        createHmac(
          "sha512",
          PAYSTACK_SECRET_KEY
        )
          .update(
            rawBody
          )
          .digest(
            "hex"
          );

      const signaturesMatch =
        signature.length ===
          expected.length &&
        timingSafeEqual(
          Buffer.from(
            signature
          ),
          Buffer.from(
            expected
          )
        );

      if (
        !signature ||
        !signaturesMatch
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

      const paidAmount =
        Number(
          data.amount || 0
        ) / 100;

      const paidCurrency =
        String(
          data.currency ||
            metadata.currency ||
            "NGN"
        ).toUpperCase();

      await recordPayment({
        reference,
        userId,
        email:
          user.email,
        credits,
        amount:
          paidAmount,
        currency:
          paidCurrency,
        status:
          "success",
        fulfilled:
          true,
        fulfilledAt:
          now(),
        gateway:
          "Paystack",
        gatewayStatus:
          data.status ||
          "success",
      });

      await addFinanceTransaction({
        type: "REVENUE",
        category:
          "CREDIT_PURCHASE",
        provider:
          "Paystack",
        amount:
          paidAmount,
        currency:
          paidCurrency,
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
        amount:
          paidAmount,
        currency:
          paidCurrency,
      });

      res.json({
        ok: true,
        fulfilled:
          true,
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

/*
|--------------------------------------------------------------------------
| USER CREDITS
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| VIDEO GENERATION
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| FREE STUDIO - NARRATION
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| ADMIN STATS
|--------------------------------------------------------------------------
*/

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
          (user) =>
            Date.parse(
              user.createdAt
            ) >=
            startDay.getTime()
        ).length;

      const newWeek =
        users.filter(
          (user) =>
            Date.parse(
              user.createdAt
            ) >=
            startWeek.getTime()
        ).length;

      const newMonth =
        users.filter(
          (user) =>
            Date.parse(
              user.createdAt
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
          (session) =>
            Number(
              session.expiresAt ||
                0
            ) >
            Date.now()
        ).length;

      const errors =
        await readJson(
          ERRORS_FILE,
          []
        );

      const issued =
        credits.transactions
          .filter(
            (item) =>
              item.type ===
              "ISSUE"
          )
          .reduce(
            (sum, item) =>
              sum +
              Number(
                item.amount || 0
              ),
            0
          );

      const consumed =
        credits.transactions
          .filter(
            (item) =>
              item.type ===
              "CONSUME"
          )
          .reduce(
            (sum, item) =>
              sum +
              Math.abs(
                Number(
                  item.amount || 0
                )
              ),
            0
          );

      const refunded =
        credits.transactions
          .filter(
            (item) =>
              item.type ===
              "REFUND"
          )
          .reduce(
            (sum, item) =>
              sum +
              Number(
                item.amount || 0
              ),
            0
          );

      const remaining =
        Object.values(
          credits.users
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
        version:
          VERSION,
        users:
          users.length,
        active,
        newToday,
        newWeek,
        newMonth,
        admins:
          users.filter(
            (user) =>
              user.role ===
              "admin"
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
          remaining,
        creditsIssued:
          issued,
        creditsConsumed:
          consumed,
        creditsRefunded:
          refunded,
        profitNGN:
          finance.wallet.profit,
        revenue:
          finance.wallet.revenue,
        refunds:
          finance.wallet.refunds,
        costs:
          finance.wallet.costs,
        providerConfigured:
          providerIsConfigured(),
        providerBlocked,
        paystackConfigured:
          Boolean(
            PAYSTACK_SECRET_KEY
          ),
        uptime:
          process.uptime(),
      });
    } catch (error) {
      next(error);
    }
  }
);

/*
|--------------------------------------------------------------------------
| ADMIN USERS
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| ADMIN JOBS
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| ADMIN ERRORS
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| ADMIN SECURITY
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| ADMIN CREDITS
|--------------------------------------------------------------------------
*/

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
            (item) =>
              item.type ===
              "ISSUE"
          )
          .reduce(
            (sum, item) =>
              sum +
              Number(
                item.amount || 0
              ),
            0
          );

      const consumed =
        transactions
          .filter(
            (item) =>
              item.type ===
              "CONSUME"
          )
          .reduce(
            (sum, item) =>
              sum +
              Math.abs(
                Number(
                  item.amount || 0
                )
              ),
            0
          );

      const refunded =
        transactions
          .filter(
            (item) =>
              item.type ===
              "REFUND"
          )
          .reduce(
            (sum, item) =>
              sum +
              Number(
                item.amount || 0
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
            providerIsConfigured(),
          balance: 0,
          balanceKnown: false,
          usable:
            providerIsConfigured() &&
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
        ).trim();

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

      const user =
        await findUserById(
          userId
        );

      if (!user) {
        return res.status(404).json({
          ok: false,
          error:
            "User not found.",
        });
      }

      if (
        amount > 0
      ) {
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

/*
|--------------------------------------------------------------------------
| ADMIN FINANCE
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| ADMIN BILLING
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| OWNER PROFIT WITHDRAWAL
|--------------------------------------------------------------------------
*/

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
            body:
              JSON.stringify({
                type: "nuban",
                name:
                  accountName ||
                  "MAMAKI Owner",
                account_number:
                  accountNumber,
                bank_code:
                  bankCode,
                currency:
                  "NGN",
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
            body:
              JSON.stringify({
                source:
                  "balance",
                amount:
                  Math.round(
                    amount * 100
                  ),
                recipient:
                  recipientData
                    .data
                    .recipient_code,
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
          accountNumber.slice(
            -4
          ),
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

/*
|--------------------------------------------------------------------------
| ADMIN CONFIG
|--------------------------------------------------------------------------
*/

app.get(
  "/api/admin/config",
  requireAdmin,
  async (req, res) => {
    res.json({
      ok: true,
      version:
        VERSION,
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
      credits: {
        starter:
          STARTER_CREDITS,
        creditsPer5Seconds:
          CREDITS_PER_5_SECONDS,
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

/*
|--------------------------------------------------------------------------
| API INFORMATION
|--------------------------------------------------------------------------
*/

app.get(
  "/api",
  async (req, res) => {
    res.json({
      ok: true,
      service:
        "MAMAKI AI Video Creative Studio",
      version:
        VERSION,
      endpoints: {
        health:
          "/health",
        login:
          "/api/auth/login",
        register:
          "/api/auth/register",
        me:
          "/api/auth/me",
        credits:
          "/api/credits",
        pricing:
          "/api/billing/pricing",
        paystack:
          "/api/billing/paystack/initialize",
        paymentStatus:
          "/api/billing/payment/:reference",
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

/*
|--------------------------------------------------------------------------
| PRIVATE ADMIN DASHBOARD
|
| THIS IS THE IMPORTANT FIX:
| /admin NO LONGER SERVES THE NORMAL MAMAKI INTERFACE.
|--------------------------------------------------------------------------
*/

const ADMIN_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="robots" content="noindex,nofollow">
<title>MAMAKI AI — Administrator Dashboard</title>
<style>
*{box-sizing:border-box}
body{
 margin:0;
 background:#050509;
 color:#f5f5f7;
 font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
button,input,select{font:inherit}
.top{
 position:sticky;
 top:0;
 z-index:20;
 background:rgba(5,5,9,.96);
 border-bottom:1px solid #222;
 padding:18px 22px;
 display:flex;
 justify-content:space-between;
 align-items:center;
 gap:12px;
}
.brand{font-size:20px;font-weight:800}
.brand span{opacity:.65}
.back{
 color:#fff;
 text-decoration:none;
 border:1px solid #333;
 border-radius:10px;
 padding:9px 13px;
}
.wrap{max-width:1450px;margin:auto;padding:24px}
.hidden{display:none!important}
.notice{
 padding:14px;
 border:1px solid #30303a;
 border-radius:12px;
 background:#0c0c12;
 margin-bottom:18px;
}
.grid{
 display:grid;
 grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
 gap:14px;
 margin-bottom:18px;
}
.card{
 background:#0d0d13;
 border:1px solid #22232b;
 border-radius:16px;
 padding:18px;
}
.card small{color:#9d9da8}
.value{font-size:27px;font-weight:800;margin-top:8px}
.section{
 background:#0b0b10;
 border:1px solid #22232b;
 border-radius:16px;
 padding:18px;
 margin-bottom:18px;
 overflow:auto;
}
.section h2{margin-top:0}
table{
 width:100%;
 border-collapse:collapse;
 min-width:650px;
}
th,td{
 text-align:left;
 padding:11px;
 border-bottom:1px solid #222;
 font-size:13px;
}
th{color:#a9a9b3}
.badge{
 display:inline-block;
 padding:5px 8px;
 border-radius:999px;
 background:#191923;
 border:1px solid #30303b;
}
.controls{
 display:flex;
 flex-wrap:wrap;
 gap:10px;
 margin-bottom:15px;
}
.controls input,.controls select{
 background:#09090d;
 color:#fff;
 border:1px solid #333;
 padding:10px;
 border-radius:10px;
}
.btn{
 background:#fff;
 color:#000;
 border:0;
 padding:10px 14px;
 border-radius:10px;
 cursor:pointer;
 font-weight:700;
}
.btn.dark{
 background:#17171f;
 color:#fff;
 border:1px solid #333;
}
.login{
 max-width:430px;
 margin:12vh auto;
 background:#0d0d13;
 border:1px solid #272731;
 border-radius:18px;
 padding:24px;
}
.login input{
 width:100%;
 padding:13px;
 margin:7px 0;
 background:#08080c;
 color:#fff;
 border:1px solid #333;
 border-radius:10px;
}
.error{color:#ff7b7b;margin-top:10px}
.success{color:#79e2a0;margin-top:10px}
</style>
</head>
<body>

<div id="loginBox" class="login">
<h1>MAMAKI AI</h1>
<p>Private Administrator Dashboard</p>
<input id="adminEmail" type="email" placeholder="Administrator email">
<input id="adminPassword" type="password" placeholder="Password">
<button class="btn" style="width:100%;margin-top:8px" onclick="adminLogin()">Access Admin Dashboard</button>
<div id="loginMessage"></div>
</div>

<div id="dashboard" class="hidden">
<div class="top">
 <div class="brand">✨ MAMAKI <span>ADMIN</span></div>
 <div>
  <a class="back" href="/">MAMAKI Interface</a>
  <button class="back" onclick="adminLogout()" style="background:#0d0d13;color:#fff;cursor:pointer">Logout</button>
 </div>
</div>

<div class="wrap">

<div id="dashMessage" class="notice">Loading administrator data...</div>

<div class="grid">
 <div class="card"><small>Total Users</small><div id="users" class="value">0</div></div>
 <div class="card"><small>Live / Active</small><div id="active" class="value">0</div></div>
 <div class="card"><small>New Today</small><div id="newToday" class="value">0</div></div>
 <div class="card"><small>New This Week</small><div id="newWeek" class="value">0</div></div>
 <div class="card"><small>New This Month</small><div id="newMonth" class="value">0</div></div>
 <div class="card"><small>Total Admins</small><div id="admins" class="value">0</div></div>
 <div class="card"><small>Videos Generated</small><div id="videos" class="value">0</div></div>
 <div class="card"><small>AI Seconds</small><div id="seconds" class="value">0</div></div>
 <div class="card"><small>MAMAKI Credits</small><div id="credits" class="value">0</div></div>
 <div class="card"><small>Profit</small><div id="profit" class="value">₦0</div></div>
</div>

<div class="section">
<h2>Replicate & AI Provider</h2>
<div class="grid">
 <div class="card"><small>Configured</small><div id="replicateConfigured" class="value">—</div></div>
 <div class="card"><small>Provider Capacity</small><div id="replicateUsable" class="value">—</div></div>
 <div class="card"><small>Provider Balance</small><div class="value">$0.00</div></div>
</div>
<p style="color:#999">Replicate does not expose an authoritative prepaid balance through the public account API. MAMAKI will not fabricate a balance.</p>
</div>

<div class="section">
<h2>Business & Finance</h2>
<div class="grid">
 <div class="card"><small>Gross Revenue</small><div id="revenue" class="value">₦0</div></div>
 <div class="card"><small>Refunds</small><div id="refunds" class="value">₦0</div></div>
 <div class="card"><small>Total Costs</small><div id="costs" class="value">₦0</div></div>
 <div class="card"><small>Profit</small><div id="financeProfit" class="value">₦0</div></div>
</div>
</div>

<div class="section">
<h2>Smart Credit Pricing & FX</h2>
<div id="pricingBox">Loading...</div>
</div>

<div class="section">
<h2>Owner Profit Withdrawal</h2>
<div class="controls">
<input id="withdrawAmount" type="number" min="1" placeholder="Amount in NGN">
<input id="withdrawAccount" placeholder="Bank account number">
<input id="withdrawBankCode" placeholder="Bank code">
<input id="withdrawName" placeholder="Account name">
<button class="btn" onclick="withdrawProfit()">Withdraw Profit</button>
</div>
<div id="withdrawMessage"></div>
</div>

<div class="section">
<h2>Users</h2>
<table>
<thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Credits</th><th>Videos</th><th>AI Seconds</th><th>Created</th></tr></thead>
<tbody id="usersTable"></tbody>
</table>
</div>

<div class="section">
<h2>Payments</h2>
<table>
<thead><tr><th>Reference</th><th>Email</th><th>Credits</th><th>Amount</th><th>Currency</th><th>Status</th><th>Date</th></tr></thead>
<tbody id="paymentsTable"></tbody>
</table>
</div>

<div class="section">
<h2>Security Activity</h2>
<table>
<thead><tr><th>Action</th><th>Email/User</th><th>Reference</th><th>Date</th></tr></thead>
<tbody id="securityTable"></tbody>
</table>
</div>

<div class="section">
<h2>Errors</h2>
<table>
<thead><tr><th>Message</th><th>Path</th><th>Method</th><th>Date</th></tr></thead>
<tbody id="errorsTable"></tbody>
</table>
</div>

<div class="section">
<h2>Withdrawal History</h2>
<table>
<thead><tr><th>Reference</th><th>Amount</th><th>Status</th><th>Account</th><th>Date</th></tr></thead>
<tbody id="withdrawalsTable"></tbody>
</table>
</div>

</div>
</div>

<script>
let adminToken=localStorage.getItem("mamaki_token")||localStorage.getItem("mamakiToken")||localStorage.getItem("sessionToken")||localStorage.getItem("token")||"";

function saveToken(token){
 adminToken=token||"";
 if(adminToken){
  localStorage.setItem("mamaki_token",adminToken);
 }
}

function headers(){
 return {
  "Content-Type":"application/json",
  "Authorization":"Bearer "+adminToken
 };
}

async function api(url,options={}){
 options.headers={
  ...(options.headers||{}),
  ...headers()
 };
 const r=await fetch(url,options);
 let d={};
 try{d=await r.json()}catch{}
 if(!r.ok)throw new Error(d.error||"Request failed");
 return d;
}

async function adminLogin(){
 const email=document.getElementById("adminEmail").value.trim();
 const password=document.getElementById("adminPassword").value;
 const msg=document.getElementById("loginMessage");
 msg.className="";
 msg.textContent="Signing in...";
 try{
  const r=await fetch("/api/auth/login",{
   method:"POST",
   headers:{"Content-Type":"application/json"},
   body:JSON.stringify({email,password})
  });
  const d=await r.json();
  if(!r.ok)throw new Error(d.error||"Invalid credentials");
  if(d.user.role!=="admin")throw new Error("This account is not an administrator.");
  saveToken(d.token);
  showDashboard();
 }catch(e){
  msg.className="error";
  msg.textContent=e.message;
 }
}

function showDashboard(){
 document.getElementById("loginBox").classList.add("hidden");
 document.getElementById("dashboard").classList.remove("hidden");
 loadDashboard();
}

async function loadDashboard(){
 try{
  const me=await api("/api/auth/me");
  if(me.user.role!=="admin")throw new Error("Administrator access required.");

  const [stats,users,credits,billing,security,errors,withdrawals]=await Promise.all([
   api("/api/admin/stats"),
   api("/api/admin/users"),
   api("/api/admin/credits"),
   api("/api/admin/billing"),
   api("/api/admin/security"),
   api("/api/admin/errors"),
   api("/api/admin/withdrawals")
  ]);

  document.getElementById("dashMessage").textContent="Administrator dashboard connected.";

  document.getElementById("users").textContent=stats.users;
  document.getElementById("active").textContent=stats.active;
  document.getElementById("newToday").textContent=stats.newToday;
  document.getElementById("newWeek").textContent=stats.newWeek;
  document.getElementById("newMonth").textContent=stats.newMonth;
  document.getElementById("admins").textContent=stats.admins;
  document.getElementById("videos").textContent=stats.videosGenerated;
  document.getElementById("seconds").textContent=stats.aiSeconds;
  document.getElementById("credits").textContent=stats.mamakiCredits;
  document.getElementById("profit").textContent=money(stats.profitNGN);

  document.getElementById("replicateConfigured").textContent=stats.providerConfigured?"YES":"NO";
  document.getElementById("replicateUsable").textContent=credits.replicate.usable?"AVAILABLE":"BLOCKED";

  document.getElementById("revenue").textContent=money(billing.finance.wallet.revenue);
  document.getElementById("refunds").textContent=money(billing.finance.wallet.refunds);
  document.getElementById("costs").textContent=money(billing.finance.wallet.costs);
  document.getElementById("financeProfit").textContent=money(billing.finance.wallet.profit);

  document.getElementById("pricingBox").innerHTML=
   "<p><b>USD → NGN:</b> "+Number(billing.fx.rates.NGN||0).toFixed(2)+"</p>"+
   "<p><b>FX status:</b> "+(billing.fx.live?"LIVE":"FALLBACK")+"</p>"+
   "<p><b>Last update:</b> "+new Date(billing.fx.updatedAt).toLocaleString()+"</p>"+
   "<p><b>100 credits:</b> "+formatPrice(billing.pricing)+"</p>"+
   "<p><b>Target margin:</b> "+(billing.pricing.marginTarget*100).toFixed(0)+"%</p>"+
   "<p><b>Paystack:</b> "+(billing.configured?"CONFIGURED":"NOT CONFIGURED")+"</p>";

  document.getElementById("usersTable").innerHTML=users.users.map(u=>
   "<tr><td>"+esc(u.name)+"</td><td>"+esc(u.email)+"</td><td><span class='badge'>"+esc(u.role)+"</span></td><td>"+Number(u.credits||0)+"</td><td>"+Number(u.usage?.aiGenerations||0)+"</td><td>"+Number(u.usage?.aiSeconds||0)+"</td><td>"+date(u.createdAt)+"</td></tr>"
  ).join("");

  document.getElementById("paymentsTable").innerHTML=(billing.payments||[]).map(p=>
   "<tr><td>"+esc(p.reference)+"</td><td>"+esc(p.email)+"</td><td>"+Number(p.credits||0)+"</td><td>"+Number(p.amount||0).toLocaleString()+"</td><td>"+esc(p.currency||"")+"</td><td><span class='badge'>"+esc(p.status||"")+"</span></td><td>"+date(p.createdAt||p.updatedAt)+"</td></tr>"
  ).join("");

  document.getElementById("securityTable").innerHTML=(security.events||[]).slice(0,100).map(e=>
   "<tr><td>"+esc(e.action||"")+"</td><td>"+esc(e.email||e.userId||"")+"</td><td>"+esc(e.reference||"")+"</td><td>"+date(e.createdAt)+"</td></tr>"
  ).join("");

  document.getElementById("errorsTable").innerHTML=(errors.errors||[]).slice(0,100).map(e=>
   "<tr><td>"+esc(e.message||"")+"</td><td>"+esc(e.path||"")+"</td><td>"+esc(e.method||"")+"</td><td>"+date(e.createdAt)+"</td></tr>"
  ).join("");

  document.getElementById("withdrawalsTable").innerHTML=(withdrawals.withdrawals||[]).map(w=>
   "<tr><td>"+esc(w.reference||"")+"</td><td>"+money(w.amount||0)+"</td><td>"+esc(w.status||"")+"</td><td>****"+esc(w.accountNumber||"")+"</td><td>"+date(w.createdAt)+"</td></tr>"
  ).join("");

 }catch(e){
  document.getElementById("dashMessage").className="notice error";
  document.getElementById("dashMessage").textContent=e.message;
 }
}

async function withdrawProfit(){
 const msg=document.getElementById("withdrawMessage");
 msg.className="";
 msg.textContent="Processing...";
 try{
  const d=await api("/api/admin/withdraw",{
   method:"POST",
   body:JSON.stringify({
    amount:Number(document.getElementById("withdrawAmount").value),
    accountNumber:document.getElementById("withdrawAccount").value.trim(),
    bankCode:document.getElementById("withdrawBankCode").value.trim(),
    accountName:document.getElementById("withdrawName").value.trim()
   })
  });
  msg.className="success";
  msg.textContent="Withdrawal submitted: "+(d.withdrawal?.reference||"");
  loadDashboard();
 }catch(e){
  msg.className="error";
  msg.textContent=e.message;
 }
}

async function adminLogout(){
 try{
  await api("/api/auth/logout",{method:"POST"});
 }catch{}
 localStorage.removeItem("mamaki_token");
 localStorage.removeItem("mamakiToken");
 localStorage.removeItem("sessionToken");
 localStorage.removeItem("token");
 location.reload();
}

function money(n){
 return "₦"+Number(n||0).toLocaleString("en-NG",{minimumFractionDigits:2,maximumFractionDigits:2});
}

function formatPrice(p){
 return p.currency==="NGN"
  ? "₦"+Number(p.amount||0).toLocaleString("en-NG")
  : "$"+Number(p.amount||0).toFixed(2);
}

function date(v){
 if(!v)return"";
 try{return new Date(v).toLocaleString()}catch{return String(v)}
}

function esc(v){
 return String(v??"").replace(/[&<>"']/g,m=>({
  "&":"&amp;",
  "<":"&lt;",
  ">":"&gt;",
  '"':"&quot;",
  "'":"&#39;"
 }[m]));
}

if(adminToken){
 showDashboard();
}
</script>
</body>
</html>
`;

app.get(
  "/admin",
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    res.setHeader(
      "X-Robots-Tag",
      "noindex, nofollow"
    );

    res.type("html").send(
      ADMIN_HTML
    );
  }
);

app.get(
  "/admin/",
  async (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    res.setHeader(
      "X-Robots-Tag",
      "noindex, nofollow"
    );

    res.type("html").send(
      ADMIN_HTML
    );
  }
);

/*
|--------------------------------------------------------------------------
| USER BILLING WIDGET
|
| This is injected into the normal MAMAKI interface.
| It gives users:
| - Available credits
| - Remaining credits
| - Buy credits button
| - Current automatically calculated prices
| - Paystack checkout
|--------------------------------------------------------------------------
*/

function injectBillingWidget(
  html
) {
  if (
    !html ||
    html.includes(
      "MAMAKI-CREDITS-WIDGET"
    )
  ) {
    return html;
  }

  const widget = `
<!-- MAMAKI-CREDITS-WIDGET -->
<style>
#mamakicreditbox{
 position:fixed;
 right:18px;
 bottom:18px;
 z-index:999999;
 font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
#mamakicreditbutton{
 border:1px solid rgba(255,255,255,.18);
 background:rgba(10,10,15,.94);
 color:#fff;
 border-radius:14px;
 padding:12px 16px;
 cursor:pointer;
 box-shadow:0 12px 35px rgba(0,0,0,.35);
 font-weight:800;
}
#mamakicreditbutton:hover{transform:translateY(-1px)}
#mamakicreditmodal{
 display:none;
 position:fixed;
 inset:0;
 background:rgba(0,0,0,.72);
 backdrop-filter:blur(7px);
 align-items:center;
 justify-content:center;
 padding:18px;
}
#mamakicreditpanel{
 width:min(470px,100%);
 max-height:90vh;
 overflow:auto;
 background:#0d0d13;
 color:#fff;
 border:1px solid #292934;
 border-radius:20px;
 padding:22px;
 box-shadow:0 30px 80px rgba(0,0,0,.55);
}
#mamakicreditpanel h2{margin-top:0}
.mcpBalance{
 display:grid;
 grid-template-columns:1fr 1fr;
 gap:10px;
 margin:15px 0;
}
.mcpCard{
 background:#15151d;
 border:1px solid #292934;
 border-radius:13px;
 padding:13px;
}
.mcpCard small{color:#aaa}
.mcpCard strong{
 display:block;
 font-size:24px;
 margin-top:5px;
}
.mcpPackages{
 display:grid;
 grid-template-columns:1fr 1fr;
 gap:10px;
 margin:14px 0;
}
.mcpPackage{
 background:#121219;
 border:1px solid #292934;
 border-radius:13px;
 padding:13px;
 cursor:pointer;
 color:#fff;
 text-align:left;
}
.mcpPackage:hover{
 border-color:#fff;
}
.mcpPackage.selected{
 border-color:#fff;
}
.mcpPackage strong{display:block;font-size:18px}
.mcpPackage span{color:#aaa}
#mcpPay{
 width:100%;
 padding:13px;
 border:0;
 border-radius:12px;
 background:#fff;
 color:#000;
 font-weight:800;
 cursor:pointer;
}
#mcpClose{
 width:100%;
 margin-top:9px;
 padding:11px;
 border:1px solid #333;
 border-radius:12px;
 background:#111117;
 color:#fff;
 cursor:pointer;
}
#mcpStatus{
 margin-top:12px;
 font-size:13px;
 color:#aaa;
}
@media(max-width:600px){
 #mamakicreditbox{right:10px;bottom:10px}
 .mcpPackages{grid-template-columns:1fr}
}
</style>

<div id="mamakicreditbox">
<button id="mamakicreditbutton">✨ Buy MAMAKI Credits</button>
</div>

<div id="mamakicreditmodal">
<div id="mamakicreditpanel">
<h2>✨ MAMAKI Credits</h2>
<p style="color:#aaa">Use MAMAKI credits to create AI videos.</p>

<div class="mcpBalance">
<div class="mcpCard">
<small>Available Credits</small>
<strong id="mcpAvailable">—</strong>
</div>
<div class="mcpCard">
<small>Remaining Credits</small>
<strong id="mcpRemaining">—</strong>
</div>
</div>

<div id="mcpProvider" style="color:#aaa;font-size:13px;margin-bottom:12px"></div>

<div style="display:flex;gap:8px;margin-bottom:10px">
<select id="mcpCurrency" style="flex:1;padding:11px;border-radius:10px;background:#111117;color:#fff;border:1px solid #333">
<option value="NGN">NGN ₦</option>
<option value="USD">USD $</option>
</select>

<select id="mcpQuality" style="flex:1;padding:11px;border-radius:10px;background:#111117;color:#fff;border:1px solid #333">
<option>Standard HD</option>
<option>High</option>
<option>Cinematic</option>
</select>
</div>

<div id="mcpPackages" class="mcpPackages"></div>

<button id="mcpPay">Continue to Secure Payment</button>
<button id="mcpClose">Close</button>

<div id="mcpStatus"></div>
</div>
</div>

<script>
(function(){

let mcpToken=
 localStorage.getItem("mamaki_token")||
 localStorage.getItem("mamakiToken")||
 localStorage.getItem("sessionToken")||
 localStorage.getItem("token")||
 "";

let selectedCredits=100;

function mcpHeaders(){
 return {
  "Content-Type":"application/json",
  "Authorization":"Bearer "+mcpToken
 };
}

async function mcpFetch(url,options={}){
 options.headers={
  ...(options.headers||{}),
  ...mcpHeaders()
 };
 const r=await fetch(url,options);
 let d={};
 try{d=await r.json()}catch{}
 if(!r.ok)throw new Error(d.error||"Request failed");
 return d;
}

function mcpOpen(){
 document.getElementById("mamakicreditmodal").style.display="flex";
 loadMcp();
}

function mcpClose(){
 document.getElementById("mamakicreditmodal").style.display="none";
}

async function loadMcp(){
 const status=document.getElementById("mcpStatus");

 mcpToken=
  localStorage.getItem("mamaki_token")||
  localStorage.getItem("mamakiToken")||
  localStorage.getItem("sessionToken")||
  localStorage.getItem("token")||
  "";

 if(!mcpToken){
  status.textContent="Please log in to your MAMAKI account before purchasing credits.";
  return;
 }

 try{
  const me=await mcpFetch("/api/auth/me");

  document.getElementById("mcpAvailable").textContent=Number(me.credits||0).toLocaleString();
  document.getElementById("mcpRemaining").textContent=Number(me.remainingCredits||0).toLocaleString();

  document.getElementById("mcpProvider").textContent=
   me.providerBlocked
    ? "AI provider capacity is currently unavailable. Your credits remain safe."
    : me.providerConfigured
      ? "AI provider connected."
      : "AI provider is not configured.";

  await loadPrices();

 }catch(e){
  status.textContent=e.message;
 }
}

async function loadPrices(){
 const currency=document.getElementById("mcpCurrency").value;
 const quality=document.getElementById("mcpQuality").value;

 const data=await mcpFetch(
  "/api/billing/pricing?currency="+encodeURIComponent(currency)+"&quality="+encodeURIComponent(quality)
 );

 const box=document.getElementById("mcpPackages");

 box.innerHTML="";

 (data.packages||[]).forEach(p=>{
  const button=document.createElement("button");
  button.className="mcpPackage"+(p.credits===selectedCredits?" selected":"");

  const price=
   p.currency==="NGN"
    ? "₦"+Number(p.amount||0).toLocaleString("en-NG")
    : "$"+Number(p.amount||0).toFixed(2);

  button.innerHTML=
   "<strong>"+Number(p.credits).toLocaleString()+" credits</strong>"+
   "<span>"+price+"</span>";

  button.onclick=()=>{
   selectedCredits=p.credits;

   document.querySelectorAll(".mcpPackage").forEach(x=>{
    x.classList.remove("selected");
   });

   button.classList.add("selected");
  };

  box.appendChild(button);
 });
}

async function buyCredits(){
 const status=document.getElementById("mcpStatus");

 if(!mcpToken){
  status.textContent="Please log in first.";
  return;
 }

 try{
  status.textContent="Preparing secure payment...";

  const currency=
   document.getElementById("mcpCurrency").value;

  const quality=
   document.getElementById("mcpQuality").value;

  const data=await mcpFetch(
   "/api/billing/paystack/initialize",
   {
    method:"POST",
    body:JSON.stringify({
     credits:selectedCredits,
     currency,
     quality,
     callbackUrl:
      location.origin+
      location.pathname+
      "?payment=complete"
    })
   }
  );

  if(data.authorizationUrl){
   location.href=data.authorizationUrl;
   return;
  }

  throw new Error("Payment page was not returned.");

 }catch(e){
  status.textContent=e.message;
 }
}

document.getElementById("mamakicreditbutton").onclick=mcpOpen;
document.getElementById("mcpClose").onclick=mcpClose;
document.getElementById("mcpPay").onclick=buyCredits;
document.getElementById("mcpCurrency").onchange=loadPrices;
document.getElementById("mcpQuality").onchange=loadPrices;

})();
</script>
`;

  if (
    html.includes(
      "</body>"
    )
  ) {
    return html.replace(
      "</body>",
      widget +
        "</body>"
    );
  }

  return html +
    widget;
}

/*
|--------------------------------------------------------------------------
| NORMAL MAMAKI FRONTEND
|
| /admin is handled above.
| Every other normal page continues to use index.html.
|--------------------------------------------------------------------------
*/

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
      "/health" ||
    req.path ===
      "/admin" ||
    req.path ===
      "/admin/"
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
    try {
      let html =
        await fs.readFile(
          indexPath,
          "utf8"
        );

      html =
        injectBillingWidget(
          html
        );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      return res
        .type("html")
        .send(html);
    } catch (error) {
      return next(error);
    }
  }

  res.status(404).send(
    "MAMAKI AI interface not found."
  );
}

app.use(
  serveFrontend
);

/*
|--------------------------------------------------------------------------
| FINAL ERROR HANDLER
|--------------------------------------------------------------------------
*/

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

    let status =
      Number(
        error?.status ||
          error?.statusCode ||
          500
      );

    if (
      error?.code ===
      "MAMAKI_CREDITS_INSUFFICIENT"
    ) {
      status = 402;
    }

    if (
      status < 400 ||
      status >= 600
    ) {
      status = 500;
    }

    res.status(
      status
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

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

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

    console.log(
      `Private admin dashboard: ${APP_URL}/admin`
    );
  }
);
