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
const VERSION = "18.2.0";
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
const MAX_DURATION = 7200;
const MIN_DURATION = 5;
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
0.90,
Math.max(
0.05,
Number(process.env.MAMAKI_TARGET_MARGIN || 0.40)
)
);
const PAYMENT_FEE_BUFFER = Math.min(
0.30,
Math.max(
0,
Number(process.env.MAMAKI_PAYMENT_FEE_BUFFER || 0.04)
)
);
const FX_BUFFER = Math.min(
0.30,
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
Number(process.env.WAN_720P_COST_USD || 0.10)
);
const PAYSTACK_CURRENCY_DEFAULT = String(
process.env.PAYSTACK_CURRENCY_DEFAULT || "NGN"
).toUpperCase();
const FIXED_NGN_MARKUP_PER_USD = Math.max(
0,
Number(
process.env.MAMAKI_FIXED_NGN_MARKUP_PER_USD || 200
)
);
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
const jobs = new Map();
const resetRate = new Map();
const adminLoginRate = new Map();
const upload = multer({
storage: multer.memoryStorage(),
limits: {
fileSize: 100 * 1024 * 1024,
},
});
app.disable("x-powered-by");
app.use(
express.json({
limit: "20mb",
verify: (req, res, buf) => {
req.rawBody = Buffer.from(buf);
},
})
);
app.use(
express.urlencoded({
extended: true,
limit: "20mb",
})
);
app.use((req, res, next) => {
res.setHeader("X-MAMAKI-Version", VERSION);
res.setHeader("X-Content-Type-Options", "nosniff");
res.setHeader("Referrer-Policy", "no-referrer");
res.setHeader("X-Frame-Options", "SAMEORIGIN");
next();
});
async function ensureStorage() {
await fs.mkdir(TMP, { recursive: true });
await fs.mkdir(OUTPUTS, { recursive: true });
await fs.mkdir(PROJECTS, { recursive: true });
await fs.mkdir(DATA, { recursive: true });
for (const file of [
USERS_FILE,
SESSIONS_FILE,
ERRORS_FILE,
USAGE_FILE,
RESET_FILE,
SECURITY_FILE,
CREDITS_FILE,
FINANCE_FILE,
PRICING_FILE,
PAYMENTS_FILE,
WITHDRAWALS_FILE,
]) {
try {
await fs.access(file);
} catch {
await fs.writeFile(file, "{}", "utf8");
}
}
}
async function readJson(file, fallback = {}) {
try {
const raw = await fs.readFile(file, "utf8");
if (!raw.trim()) {
return fallback;
}
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
function cleanText(value, max = 10000) {
return String(value || "")
.replace(/\0/g, "")
.trim()
.slice(0, max);
}
function normalizeEmail(value) {
return cleanText(value, 200).toLowerCase();
}
function normalizeDuration(value) {
if (typeof value === "string") {
const match = value
.trim()
.match(
/^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/i
);
if (match) {
let n = Number(match[1]);
const unit = String(
match[2] || "s"
).toLowerCase();
if (["m", "min", "mins"].includes(unit)) {
n *= 60;
}
if (["h", "hr", "hrs"].includes(unit)) {
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
const n = Number(value);
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
function normalizeRatio(value) {
const v = String(value || "16:9");
return [
"16:9",
"9:16",
"1:1",
].includes(v)
? v
: "16:9";
}
function ratioSize(ratio) {
if (ratio === "9:16") {
return "1080:1920";
}
if (ratio === "1:1") {
return "1080:1080";
}
return "1920:1080";
}
function wanFrames(seconds) {
return Number(seconds) <= 5
? 81
: 121;
}
function sleep(ms) {
return new Promise((resolve) =>
setTimeout(resolve, ms)
);
}
function safeFileName(
name,
fallback = "file"
) {
const base = path.basename(
String(name || fallback)
);
return base
.replace(/[^a-zA-Z0-9._-]/g, "_")
.slice(0, 150);
}
function hashPassword(
password,
salt = randomBytes(16).toString("hex")
) {
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
function verifyPassword(
password,
salt,
expectedHash
) {
try {
const actual = scryptSync(
String(password),
salt,
64
);
const expected = Buffer.from(
expectedHash,
"hex"
);
if (actual.length !== expected.length) {
return false;
}
return timingSafeEqual(
actual,
expected
);
} catch {
return false;
}
}
function createToken() {
const random =
randomBytes(32).toString("hex");
const secretPart = SESSION_SECRET
? scryptSync(
SESSION_SECRET,
random.slice(0, 16),
32
).toString("hex")
: "";
return `${random}.${secretPart}`;
}
async function createSession(
userId,
role = "user"
) {
const sessions = await readJson(
SESSIONS_FILE,
{}
);
const token = createToken();
sessions[token] = {
userId,
role,
createdAt: Date.now(),
lastSeen: Date.now(),
};
await writeJson(
SESSIONS_FILE,
sessions
);
return token;
}
function getBearerToken(req) {
const header = String(
req.headers.authorization || ""
);
if (
!header
.toLowerCase()
.startsWith("bearer ")
) {
return "";
}
return header.slice(7).trim();
}
async function invalidateUserSessions(
userId
) {
const sessions = await readJson(
SESSIONS_FILE,
{}
);
let changed = false;
for (
const [
token,
session,
] of Object.entries(
sessions
)
) {
if (session.userId === userId) {
delete sessions[token];
changed = true;
}
}
if (changed) {
await writeJson(
SESSIONS_FILE,
sessions
);
}
}
async function getSession(req) {
const token = getBearerToken(req);
if (!token) {
return null;
}
const sessions = await readJson(
SESSIONS_FILE,
{}
);
const session = sessions[token];
if (!session) {
return null;
}
const maxAge =
30 *
24 *
60 *
60 *
1000;
if (
Date.now() -
Number(session.createdAt || 0) >
maxAge
) {
delete sessions[token];
await writeJson(
SESSIONS_FILE,
sessions
);
return null;
}
session.lastSeen = Date.now();
sessions[token] = session;
await writeJson(
SESSIONS_FILE,
sessions
);
return {
token,
...session,
};
}
async function getCurrentUser(req) {
const session = await getSession(req);
if (!session) {
return null;
}
const users = await readJson(
USERS_FILE,
{}
);
const user =
users[session.userId];
if (!user || user.disabled) {
return null;
}
return {
...user,
sessionRole: session.role,
};
}
async function requireUser(
req,
res,
next
) {
const user = await getCurrentUser(req);
if (!user) {
return res.status(401).json({
ok: false,
error: "AUTH_REQUIRED",
message:
"Please log in to your MAMAKI account.",
});
}
req.user = user;
next();
}
async function requireAdmin(
req,
res,
next
) {
const user = await getCurrentUser(req);
if (
!user ||
user.role !==
"admin"
) {
return res.status(403).json({
ok: false,
error: "ADMIN_REQUIRED",
message:
"Administrator access required.",
});
}
req.user = user;
next();
}
async function recordError(
error,
context = {}
) {
try {
const errors = await readJson(
ERRORS_FILE,
{}
);
const id = randomUUID();
errors[id] = {
id,
createdAt:
new Date().toISOString(),
message: String(
error?.message ||
error ||
"Unknown error"
).slice(0, 2000),
code: String(
error?.code || ""
).slice(0, 100),
context,
};
const ids = Object.keys(errors);
if (ids.length > 500) {
ids.sort((a, b) =>
String(
errors[a].createdAt || ""
).localeCompare(
String(
errors[b].createdAt || ""
)
)
);
while (ids.length > 500) {
const old = ids.shift();
if (old) {
delete errors[old];
}
}
}
await writeJson(
ERRORS_FILE,
errors
);
} catch {
}
}
async function recordUsage(
userId,
type,
seconds = 0
) {
if (!userId) {
return;
}
const usage = await readJson(
USAGE_FILE,
{}
);
if (!usage[userId]) {
usage[userId] = {
userId,
aiGenerations: 0,
aiSeconds: 0,
studioJobs: 0,
narrationJobs: 0,
updatedAt: Date.now(),
};
}
if (type === "ai") {
usage[userId].aiGenerations += 1;
usage[userId].aiSeconds += Number(
seconds || 0
);
}
if (type === "studio") {
usage[userId].studioJobs += 1;
}
if (type === "narration") {
usage[userId].narrationJobs += 1;
}
usage[userId].updatedAt = Date.now();
await writeJson(
USAGE_FILE,
usage
);
}
function classifyReplicateError(error) {
const text = String(
error?.message ||
error ||
""
).toLowerCase();
if (
text.includes("402") ||
text.includes("payment required") ||
text.includes("insufficient credit") ||
text.includes("insufficient funds") ||
text.includes("billing") ||
text.includes("credit")
) {
return {
code:
"REPLICATE_CREDIT_REQUIRED",
message:
"Replicate requires available credit or billing before this AI generation can start.",
};
}
if (
text.includes("401") ||
text.includes("unauthorized") ||
text.includes("authentication") ||
text.includes("invalid api token") ||
text.includes("api token")
) {
return {
code:
"REPLICATE_AUTH_REQUIRED",
message:
"Replicate authentication is missing or invalid. Check REPLICATE_API_TOKEN in Render.",
};
}
if (
text.includes("403") ||
text.includes("forbidden")
) {
return {
code:
"REPLICATE_FORBIDDEN",
message:
"Replicate rejected this request. Check account permissions, model access and billing.",
};
}
if (
text.includes("429") ||
text.includes("rate limit") ||
text.includes("too many")
) {
return {
code:
"REPLICATE_RATE_LIMIT",
message:
"Replicate rate limit reached. Please wait and try again.",
};
}
return {
code:
"REPLICATE_GENERATION_FAILED",
message:
"Replicate could not start or complete the AI generation.",
};
}
async function downloadToFile(
url,
destination
) {
const response = await fetch(url);
if (!response.ok) {
throw new Error(
`Download failed with HTTP ${response.status}`
);
}
const buffer = Buffer.from(
await response.arrayBuffer()
);
await fs.writeFile(
destination,
buffer
);
return destination;
}
async function downloadReplicateOutput(
output,
destination
) {
if (!output) {
throw new Error(
"Replicate returned no output."
);
}
if (
typeof output === "string" &&
/^https?:\/\//i.test(output)
) {
return downloadToFile(
output,
destination
);
}
if (
output &&
typeof output.url === "function"
) {
const url = await output.url();
return downloadToFile(
String(url),
destination
);
}
if (
output &&
typeof output.url === "string"
) {
return downloadToFile(
output.url,
destination
);
}
if (Buffer.isBuffer(output)) {
await fs.writeFile(
destination,
output
);
return destination;
}
if (output instanceof Uint8Array) {
await fs.writeFile(
destination,
Buffer.from(output)
);
return destination;
}
if (
Array.isArray(output) &&
output.length > 0
) {
return downloadReplicateOutput(
output[0],
destination
);
}
if (
output &&
typeof output === "object"
) {
for (const key of [
"video",
"output",
"url",
"file",
]) {
if (output[key]) {
return downloadReplicateOutput(
output[key],
destination
);
}
}
}
throw new Error(
"Replicate finished without returning a usable video file."
);
}
async function runFFmpeg(args) {
return new Promise(
(resolve, reject) => {
const child = spawn(
ffmpegPath,
args,
{
stdio: [
"ignore",
"pipe",
"pipe",
],
}
);
let stderr = "";
child.stderr.on(
"data",
(chunk) => {
stderr += chunk.toString();
}
);
child.on(
"error",
reject
);
child.on(
"close",
(code) => {
if (code === 0) {
return resolve();
}
const error = new Error(
`FFmpeg failed with code ${code}: ${stderr.slice(
-4000
)}`
);
error.code =
"FFMPEG_FAILED";
reject(error);
}
);
}
);
}
async function addWatermark(
input,
output
) {
const filter =
"drawtext=text='MAMAKI ✨':fontcolor=white@0.78:fontsize=28:borderw=2:bordercolor=black@0.45:x=w-tw-28:y=h-th-24";
await runFFmpeg([
"-y",
"-i",
input,
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
"-b:a",
"160k",
"-movflags",
"+faststart",
output,
]);
return output;
}
async function forceDuration(
input,
output,
seconds
) {
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
"-crf",
"20",
"-c:a",
"aac",
"-b:a",
"160k",
"-movflags",
"+faststart",
output,
]);
return output;
}
async function resizeVideo(
input,
output,
ratio
) {
const size = ratioSize(ratio);
await runFFmpeg([
"-y",
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
"-b:a",
"160k",
"-movflags",
"+faststart",
output,
]);
return output;
}
async function createSoftMusic(
output,
seconds = 5
) {
const duration = Math.max(
1,
Number(seconds)
);
await runFFmpeg([
"-y",
"-f",
"lavfi",
"-i",
`sine=frequency=220:sample_rate=44100:duration=${duration}`,
"-af",
`volume=0.035,afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(
0,
duration - 1
)}:d=1`,
"-c:a",
"aac",
"-b:a",
"128k",
output,
]);
return output;
}
async function attachAudio(
video,
audio,
output
) {
await runFFmpeg([
"-y",
"-i",
video,
"-i",
audio,
"-filter_complex",
"[1:a]volume=0.18[a1];[0:a][a1]amix=inputs=2:duration=first:dropout_transition=2[a]",
"-map",
"0:v:0",
"-map",
"[a]",
"-c:v",
"copy",
"-c:a",
"aac",
"-b:a",
"160k",
"-shortest",
"-movflags",
"+faststart",
output,
]);
return output;
}
async function combineVideoFiles(
files,
output
) {
const listFile = path.join(
TMP,
`${randomUUID()}.txt`
);
const content = files
.map(
(file) =>
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
"-y",
"-f",
"concat",
"-safe",
"0",
"-i",
listFile,
"-c",
"copy",
"-movflags",
"+faststart",
output,
]);
} catch {
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
"-crf",
"20",
"-c:a",
"aac",
"-b:a",
"160k",
"-movflags",
"+faststart",
output,
]);
} finally {
await fs
.unlink(listFile)
.catch(() => {});
}
return output;
}
function splitIntoScenes(
script,
targetSeconds
) {
const text = cleanText(
script,
30000
);
if (!text) {
return [];
}
const chunks = text
.split(
/(?<=[.!?])\s+|\n+/
)
.map((x) => x.trim())
.filter(Boolean);
const maxScenes = Math.max(
1,
Math.ceil(
targetSeconds / 5
)
);
if (chunks.length <= maxScenes) {
return chunks;
}
const scenes = [];
const perScene = Math.ceil(
chunks.length / maxScenes
);
for (
let i = 0;
i < chunks.length;
i += perScene
) {
scenes.push(
chunks
.slice(i, i + perScene)
.join(" ")
);
}
return scenes;
}
function enhancePrompt(
prompt,
style = "Cinematic"
) {
const clean = cleanText(
prompt,
5000
);
if (!clean) {
return "";
}
return [
clean,
`Visual style: ${style}.`,
"Create a coherent professional video sequence.",
"Use strong composition, natural motion, consistent subjects, realistic lighting, cinematic depth and detailed environments.",
"Maintain continuity between shots.",
"Avoid text overlays, logos and unwanted distortions.",
"Use smooth camera movement appropriate to the scene.",
].join(" ");
}
function allowedByRate(
map,
key,
limit,
windowMs
) {
const now = Date.now();
const list = map.get(key) || [];
const fresh = list.filter(
(t) => now - t < windowMs
);
fresh.push(now);
map.set(key, fresh);
return fresh.length <= limit;
}
async function recordSecurityEvent(
type,
details = {}
) {
try {
const security = await readJson(
SECURITY_FILE,
{ events: [] }
);
if (!Array.isArray(security.events)) {
security.events = [];
}
security.events.push({
id: randomUUID(),
type,
createdAt:
new Date().toISOString(),
...details,
});
if (
security.events.length >
1000
) {
security.events =
security.events.slice(-1000);
}
await writeJson(
SECURITY_FILE,
security
);
} catch {
}
}
function clampNumber(
value,
min,
max
) {
const n = Number(value);
if (!Number.isFinite(n)) {
return min;
}
return Math.max(
min,
Math.min(max, n)
);
}
function roundUp50(value) {
return Math.ceil(
Number(value || 0) / 50
) * 50;
}
function roundMoney(value) {
return Math.round(
Number(value || 0) * 100
) / 100;
}
async function getUserCredits(
userId
) {
const credits = await readJson(
CREDITS_FILE,
{}
);
if (!credits[userId]) {
credits[userId] = {
userId,
credits: 100,
issued: 100,
consumed: 0,
refunded: 0,
updatedAt: Date.now(),
};
await writeJson(
CREDITS_FILE,
credits
);
}
return credits[userId];
}
async function saveUserCredits(
userId,
record
) {
const credits = await readJson(
CREDITS_FILE,
{}
);
credits[userId] = {
...record,
userId,
updatedAt: Date.now(),
};
await writeJson(
CREDITS_FILE,
credits
);
return credits[userId];
}
async function addCredits(
userId,
amount,
reason = "Credit purchase"
) {
const record =
await getUserCredits(userId);
const n = Math.max(
0,
Math.round(
Number(amount || 0)
)
);
record.credits += n;
record.issued += n;
if (!Array.isArray(record.history)) {
record.history = [];
}
record.history.push({
id: randomUUID(),
type: "credit",
amount: n,
reason,
createdAt:
new Date().toISOString(),
});
if (
record.history.length >
500
) {
record.history =
record.history.slice(-500);
}
return saveUserCredits(
userId,
record
);
}
async function consumeCredits(
userId,
amount,
reason = "AI generation"
) {
const record =
await getUserCredits(userId);
const n = Math.max(
0,
Math.round(
Number(amount || 0)
)
);
if (
record.credits < n
) {
return {
ok: false,
credits: record.credits,
required: n,
};
}
record.credits -= n;
record.consumed += n;
if (!Array.isArray(record.history)) {
record.history = [];
}
record.history.push({
id: randomUUID(),
type: "consume",
amount: -n,
reason,
createdAt:
new Date().toISOString(),
});
await saveUserCredits(
userId,
record
);
return {
ok: true,
credits: record.credits,
consumed: n,
};
}
async function refundCredits(
userId,
amount,
reason = "Generation refund"
) {
const record =
await getUserCredits(userId);
const n = Math.max(
0,
Math.round(
Number(amount || 0)
)
);
record.credits += n;
record.refunded += n;
if (!Array.isArray(record.history)) {
record.history = [];
}
record.history.push({
id: randomUUID(),
type: "refund",
amount: n,
reason,
createdAt:
new Date().toISOString(),
});
await saveUserCredits(
userId,
record
);
return record;
}
async function getFinance() {
const finance = await readJson(
FINANCE_FILE,
{}
);
return {
revenue: Number(
finance.revenue || 0
),
refunds: Number(
finance.refunds || 0
),
providerCosts: Number(
finance.providerCosts || 0
),
fees: Number(
finance.fees || 0
),
otherExpenses: Number(
finance.otherExpenses || 0
),
withdrawals: Number(
finance.withdrawals || 0
),
transactions:
Array.isArray(
finance.transactions
)
? finance.transactions
: [],
};
}
async function saveFinance(finance) {
await writeJson(
FINANCE_FILE,
finance
);
return finance;
}
async function recordFinance(
type,
amount,
description,
meta = {}
) {
const finance =
await getFinance();
const n = Number(amount || 0);
if (type === "revenue") {
finance.revenue += n;
}
if (type === "refund") {
finance.refunds += n;
}
if (type === "provider_cost") {
finance.providerCosts += n;
}
if (type === "fee") {
finance.fees += n;
}
if (type === "expense") {
finance.otherExpenses += n;
}
if (type === "withdrawal") {
finance.withdrawals += n;
}
finance.transactions.push({
id: randomUUID(),
type,
amount: n,
description:
description || "",
createdAt:
new Date().toISOString(),
...meta,
});
if (
finance.transactions.length >
2000
) {
finance.transactions =
finance.transactions.slice(-2000);
}
await saveFinance(finance);
return finance;
}
function calculateProfit(
finance
) {
return (
Number(finance.revenue || 0) -
Number(finance.refunds || 0) -
Number(finance.providerCosts || 0) -
Number(finance.fees || 0) -
Number(finance.otherExpenses || 0)
);
}
async function getFXRate() {
try {
const response = await fetch(
FX_API_URL,
{
headers: {
Accept:
"application/json",
},
signal: AbortSignal.timeout(
8000
),
}
);
if (!response.ok) {
throw new Error(
`FX HTTP ${response.status}`
);
}
const data =
await response.json();
const rate = Number(
data?.rates?.NGN
);
if (
!Number.isFinite(rate) ||
rate <= 0
) {
throw new Error(
"Invalid NGN FX rate."
);
}
return {
rate,
live: true,
source: FX_API_URL,
updatedAt:
new Date().toISOString(),
};
} catch {
return {
rate:
DEFAULT_USD_NGN_RATE,
live: false,
source: "fallback",
updatedAt:
new Date().toISOString(),
};
}
}
async function getPricing() {
const pricing =
await readJson(
PRICING_FILE,
{}
);
const now = Date.now();
if (
pricing.updatedAt &&
now -
Number(
pricing.updatedAt
) <
30 * 60 * 1000 &&
pricing.fx
) {
return pricing;
}
const fx =
await getFXRate();
const packages = [
100,
500,
1000,
2500,
5000,
];
const list =
packages.map(
(credits) => {
const usd =
credits / 100;
const userRate =
fx.rate +
FIXED_NGN_MARKUP_PER_USD;
const amount =
roundUp50(
usd * userRate
);
const providerCostUsd =
credits <= 500
? (credits / 100) *
PROVIDER_COST_480P_USD
: (credits / 100) *
PROVIDER_COST_720P_USD;
const paymentFee =
amount *
PAYMENT_FEE_BUFFER;
const expectedProfit =
amount -
providerCostUsd *
userRate -
paymentFee;
const margin =
amount > 0
? expectedProfit /
amount
: 0;
return {
credits,
usdPrice: roundMoney(
usd
),
amount,
currency: "NGN",
fxRate: fx.rate,
userRate,
providerCostUsd:
roundMoney(
providerCostUsd
),
marginTarget:
TARGET_MARGIN,
expectedProfit:
roundMoney(
expectedProfit
),
expectedMargin:
margin,
};
}
);
const result = {
updatedAt: now,
fx: {
rates: {
NGN: fx.rate,
},
live: fx.live,
source: fx.source,
updatedAt: fx.updatedAt,
},
fixedMarkupPerUsd:
FIXED_NGN_MARKUP_PER_USD,
packages: list,
};
await writeJson(
PRICING_FILE,
result
);
return result;
}
function creditsForDuration(
seconds
) {
const s = normalizeDuration(
seconds
);
return Math.max(
10,
Math.ceil(s / 5) * 10
);
}
async function createUser(
name,
email,
password,
role = "user"
) {
const users = await readJson(
USERS_FILE,
{}
);
const normalized =
normalizeEmail(email);
const existing =
Object.values(users).find(
(u) =>
normalizeEmail(
u.email
) === normalized
);
if (existing) {
return {
ok: false,
error:
"EMAIL_ALREADY_EXISTS",
user: existing,
};
}
const credentials =
hashPassword(password);
const id = randomUUID();
const user = {
id,
name:
cleanText(
name,
120
) ||
normalized.split("@")[0],
email: normalized,
salt: credentials.salt,
passwordHash:
credentials.hash,
role,
disabled: false,
createdAt:
new Date().toISOString(),
lastLoginAt: null,
lastActiveAt:
new Date().toISOString(),
};
users[id] = user;
await writeJson(
USERS_FILE,
users
);
await getUserCredits(id);
return {
ok: true,
user,
};
}
async function ensureAdminAccount() {
if (
!ADMIN_EMAIL ||
!ADMIN_PASSWORD
) {
return null;
}
const users = await readJson(
USERS_FILE,
{}
);
const matches =
Object.values(users)
.filter(
(u) =>
normalizeEmail(
u.email
) === ADMIN_EMAIL
)
.sort(
(a, b) =>
String(
a.createdAt || ""
).localeCompare(
String(
b.createdAt || ""
)
)
);
let admin =
matches[0];
if (!admin) {
const credentials =
hashPassword(
ADMIN_PASSWORD
);
admin = {
id: randomUUID(),
name:
"MAMAKI Administrator",
email: ADMIN_EMAIL,
salt: credentials.salt,
passwordHash:
credentials.hash,
role: "admin",
disabled: false,
createdAt:
new Date().toISOString(),
lastLoginAt: null,
lastActiveAt:
new Date().toISOString(),
};
users[admin.id] = admin;
await writeJson(
USERS_FILE,
users
);
await getUserCredits(
admin.id
);
return admin;
}
admin.role = "admin";
admin.disabled = false;
users[admin.id] =
admin;
for (
const duplicate of matches.slice(
1
)
) {
delete users[
duplicate.id
];
await invalidateUserSessions(
duplicate.id
);
}
await writeJson(
USERS_FILE,
users
);
await getUserCredits(
admin.id
);
return admin;
}
async function sendRecoveryEmail(
email,
resetUrl
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
"application/json",
},
body: JSON.stringify({
from: RESEND_FROM,
to: [email],
subject:
"MAMAKI AI password reset",
html: `
<div style="font-family:Arial,sans-serif">
<h2>MAMAKI AI</h2>
<p>Your password reset request was received.</p>
<p><a href="${resetUrl}">Reset your password</a></p>
<p>This link expires in 30 minutes.</p>
</div>
`,
}),
signal: AbortSignal.timeout(
10000
),
}
);
return response.ok;
}
async function createResetToken(
userId,
email
) {
const resets =
await readJson(
RESET_FILE,
{}
);
const now = Date.now();
for (const [oldToken, record] of Object.entries(resets)) {
if (
record?.userId === userId ||
Number(record?.expiresAt || 0) <= now
) {
delete resets[oldToken];
}
}
const token =
randomBytes(32).toString(
"hex"
);
resets[token] = {
userId,
email,
createdAt: now,
expiresAt:
now +
30 * 60 * 1000,
};
await writeJson(
RESET_FILE,
resets
);
return token;
}
async function findUserByEmail(
email
) {
const users = await readJson(
USERS_FILE,
{}
);
const normalized =
normalizeEmail(email);
return Object.values(
users
).find(
(u) =>
normalizeEmail(
u.email
) === normalized
);
}
async function getJob(
id
) {
return jobs.get(id) || null;
}
function publicJob(job) {
if (!job) {
return null;
}
return {
id: job.id,
userId: job.userId,
status: job.status,
progress:
job.progress || 0,
message:
job.message || "",
error:
job.error || "",
duration:
job.duration || 0,
ratio:
job.ratio || "16:9",
style:
job.style || "Cinematic",
credits:
job.creditCost || 0,
creditCost:
job.creditCost || 0,
createdAt:
job.createdAt,
completedAt:
job.completedAt ||
null,
videoUrl:
job.videoUrl ||
null,
};
}
async function createVideoJob(
user,
input
) {
const duration =
normalizeDuration(
input.duration
);
const ratio =
normalizeRatio(
input.ratio
);
const style =
cleanText(
input.style ||
"Cinematic",
50
);
const prompt =
cleanText(
input.prompt,
5000
);
if (!prompt) {
throw new Error(
"Please enter a video prompt."
);
}
const image =
input.image || null;
const creditCost =
creditsForDuration(
duration
);
const job = {
id: randomUUID(),
userId: user.id,
status: "queued",
progress: 0,
message:
"Preparing your MAMAKI AI video...",
createdAt:
new Date().toISOString(),
duration,
ratio,
style,
prompt,
image,
creditCost,
videoUrl: null,
};
jobs.set(
job.id,
job
);
return job;
}
async function generateSingleClip(
prompt,
duration,
ratio,
imagePath
) {
if (!replicate) {
const error = new Error(
"Replicate is not configured."
);
error.code =
"REPLICATE_NOT_CONFIGURED";
throw error;
}
const model =
imagePath
? I2V_MODEL
: T2V_MODEL;
const input = {
prompt,
width:
ratio === "9:16"
? 1080
: 1920,
height:
ratio === "9:16"
? 1920
: 1080,
num_frames:
wanFrames(duration),
};
if (imagePath) {
const buffer =
await fs.readFile(
imagePath
);
const base64 =
buffer.toString(
"base64"
);
const ext =
path
.extname(
imagePath
)
.toLowerCase();
const mime =
ext === ".png"
? "image/png"
: ext === ".webp"
? "image/webp"
: "image/jpeg";
input.image =
`data:${mime};base64,${base64}`;
}
const output =
await replicate.run(
model,
{
input,
}
);
const destination =
path.join(
TMP,
`${randomUUID()}.mp4`
);
await downloadReplicateOutput(
output,
destination
);
return destination;
}
async function processVideoJob(
job
) {
let charged = true;
const temporaryFiles =
[];
try {
job.status =
"processing";
job.progress = 5;
job.message =
"Sending your request to the AI video engine.";
let imagePath = null;
if (
job.image &&
Buffer.isBuffer(
job.image.buffer
)
) {
imagePath =
path.join(
TMP,
`${randomUUID()}-${safeFileName(
job.image.originalname,
"reference.jpg"
)}`
);
await fs.writeFile(
imagePath,
job.image.buffer
);
temporaryFiles.push(
imagePath
);
}
const sceneTarget =
Math.min(
5,
job.duration
);
const scenes =
splitIntoScenes(
job.prompt,
job.duration
);
const actualScenes =
scenes.length
? scenes
: [job.prompt];
const clipFiles =
[];
for (
let i = 0;
i < actualScenes.length;
i++
) {
const scene =
actualScenes[i];
job.progress =
10 +
Math.round(
(i /
actualScenes.length) *
65
);
job.message =
`Generating scene ${
i + 1
} of ${
actualScenes.length
}...`;
const clip =
await generateSingleClip(
enhancePrompt(
scene,
job.style
),
sceneTarget,
job.ratio,
imagePath
);
clipFiles.push(clip);
temporaryFiles.push(clip);
}
job.progress = 78;
job.message =
"Combining generated scenes...";
const combined =
path.join(
TMP,
`${randomUUID()}-combined.mp4`
);
await combineVideoFiles(
clipFiles,
combined
);
temporaryFiles.push(
combined
);
job.progress = 84;
job.message =
"Preparing final MAMAKI video...";
const resized =
path.join(
TMP,
`${randomUUID()}-resized.mp4`
);
await resizeVideo(
combined,
resized,
job.ratio
);
temporaryFiles.push(
resized
);
const durationFixed =
path.join(
TMP,
`${randomUUID()}-duration.mp4`
);
await forceDuration(
resized,
durationFixed,
job.duration
);
temporaryFiles.push(
durationFixed
);
const watermarked =
path.join(
OUTPUTS,
`${job.id}.mp4`
);
await addWatermark(
durationFixed,
watermarked
);
job.progress = 95;
job.message =
"Finalizing your MAMAKI AI video...";
job.videoUrl =
`/api/video/file/${path.basename(
watermarked
)}`;
job.status =
"completed";
job.progress = 100;
job.message =
"Your MAMAKI AI video is ready.";
job.completedAt =
new Date().toISOString();
await recordUsage(
job.userId,
"ai",
job.duration
);
await recordFinance(
"provider_cost",
job.duration >= 10
? PROVIDER_COST_720P_USD *
(job.duration / 5) *
(DEFAULT_USD_NGN_RATE)
: PROVIDER_COST_480P_USD *
(job.duration / 5) *
(DEFAULT_USD_NGN_RATE),
"MAMAKI AI generation provider cost",
{
jobId: job.id,
userId: job.userId,
duration: job.duration,
}
);
return job;
} catch (error) {
const classified =
classifyReplicateError(
error
);
job.status =
"failed";
job.error =
classified.message;
job.message =
classified.message;
job.completedAt =
new Date().toISOString();
if (charged) {
await refundCredits(
job.userId,
job.creditCost,
"Failed AI generation"
);
}
await recordError(
error,
{
route:
"/api/video/generate",
jobId:
job.id,
userId:
job.userId,
code:
classified.code,
}
);
return job;
} finally {
for (
const file of temporaryFiles
) {
await fs
.unlink(file)
.catch(() => {});
}
}
}
async function runStudioJob(
userId,
type,
fn
) {
const job = {
id: randomUUID(),
userId,
type,
status: "processing",
createdAt:
new Date().toISOString(),
};
jobs.set(
job.id,
job
);
try {
const result =
await fn(job);
job.status =
"completed";
job.progress =
100;
job.result =
result;
job.completedAt =
new Date().toISOString();
await recordUsage(
userId,
"studio"
);
return job;
} catch (error) {
job.status =
"failed";
job.error =
String(
error?.message ||
error
);
job.completedAt =
new Date().toISOString();
await recordError(
error,
{
studioType:
type,
userId,
}
);
throw error;
}
}
async function createNarration(
text,
voice,
output
) {
const tts =
new EdgeTTS();
await tts.synthesize(
cleanText(
text,
30000
),
voice ||
"en-US-AriaNeural",
{
output,
}
);
return output;
}
async function paystackRequest(
endpoint,
options = {}
) {
if (!PAYSTACK_SECRET_KEY) {
const error =
new Error(
"Paystack is not configured. Add PAYSTACK_SECRET_KEY in Render Environment."
);
error.code =
"PAYSTACK_NOT_CONFIGURED";
throw error;
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
Accept:
"application/json",
...(options.headers || {}),
},
signal:
options.signal ||
AbortSignal.timeout(15000),
}
);
let data = {};
try {
data =
await response.json();
} catch {
data = {};
}
if (!response.ok || data.status === false) {
const error =
new Error(
data?.message ||
`Paystack request failed with HTTP ${response.status}.`
);
error.code =
"PAYSTACK_REQUEST_FAILED";
error.status =
response.status;
error.response =
data;
throw error;
}
return data;
}
function paystackAmountToNaira(
amount
) {
return Math.round(
Number(amount || 0)
);
}
async function findPaymentByReference(
reference
) {
const payments =
await readJson(
PAYMENTS_FILE,
{}
);
return Object.values(
payments
).find(
(p) =>
p.reference ===
reference
);
}
async function savePayment(
payment
) {
const payments =
await readJson(
PAYMENTS_FILE,
{}
);
payments[payment.id] =
payment;
await writeJson(
PAYMENTS_FILE,
payments
);
return payment;
}
async function fulfillPayment(
reference,
providerData = null
) {
const existing =
await findPaymentByReference(
reference
);
if (!existing) {
throw new Error(
"Payment reference was not found."
);
}
if (
existing.fulfilledAt
) {
return existing;
}
const credits =
Number(
existing.credits || 0
);
if (
!Number.isFinite(
credits
) ||
credits <= 0
) {
throw new Error(
"Invalid payment credit quantity."
);
}
const expectedAmountKobo = Math.round(
Number(existing.amount || 0) * 100
);
if (
Number.isFinite(Number(providerData?.amount)) &&
Number(providerData.amount) !== expectedAmountKobo
) {
const error = new Error(
"Paystack payment amount does not match the MAMAKI order."
);
error.code = "PAYMENT_AMOUNT_MISMATCH";
throw error;
}
const expectedCurrency = String(
existing.currency || PAYSTACK_CURRENCY_DEFAULT
).toUpperCase();
if (
providerData?.currency &&
String(providerData.currency).toUpperCase() !== expectedCurrency
) {
const error = new Error(
"Paystack payment currency does not match the MAMAKI order."
);
error.code = "PAYMENT_CURRENCY_MISMATCH";
throw error;
}
await addCredits(
existing.userId,
credits,
`Paystack payment ${reference}`
);
existing.status =
"success";
existing.fulfilledAt =
new Date().toISOString();
existing.providerData =
providerData;
await savePayment(
existing
);
await recordFinance(
"revenue",
Number(
existing.amount || 0
),
"MAMAKI credit purchase",
{
paymentId:
existing.id,
reference,
userId:
existing.userId,
credits,
}
);
return existing;
}
function verifyPaystackSignature(
req
) {
if (!PAYSTACK_SECRET_KEY) {
return false;
}
const signature = String(
req.headers[
"x-paystack-signature"
] || ""
);
if (!signature) {
return false;
}
const raw =
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
.update(raw)
.digest("hex");
return (
signature.length ===
expected.length &&
timingSafeEqual(
Buffer.from(
signature
),
Buffer.from(
expected
)
)
);
}
function paymentReference() {
return `MAMAKI-${Date.now()}-${randomBytes(
5
).toString("hex")}`;
}
async function listUsers() {
const users =
await readJson(
USERS_FILE,
{}
);
const usage =
await readJson(
USAGE_FILE,
{}
);
const credits =
await readJson(
CREDITS_FILE,
{}
);
return Object.values(
users
).map((user) => ({
id: user.id,
name: user.name,
email: user.email,
role: user.role,
disabled:
Boolean(
user.disabled
),
createdAt:
user.createdAt,
lastLoginAt:
user.lastLoginAt,
lastActiveAt:
user.lastActiveAt,
credits:
Number(
credits[
user.id
]?.credits ||
0
),
usage:
usage[
user.id
] || {
aiGenerations: 0,
aiSeconds: 0,
studioJobs: 0,
narrationJobs: 0,
},
}));
}
async function getAdminStats() {
const users =
await listUsers();
const usage =
await readJson(
USAGE_FILE,
{}
);
const projects =
await fs
.readdir(
PROJECTS
)
.catch(() => []);
let aiGenerations = 0;
let aiSeconds = 0;
let narrationJobs = 0;
for (
const record of Object.values(
usage
)
) {
aiGenerations +=
Number(
record.aiGenerations ||
0
);
aiSeconds +=
Number(
record.aiSeconds ||
0
);
narrationJobs +=
Number(
record.narrationJobs ||
0
);
}
return {
totalUsers:
users.length,
aiGenerations,
aiSeconds,
narrationJobs,
totalProjects:
projects.length,
recoveryConfigured:
Boolean(
RESEND_API_KEY &&
RESEND_FROM
),
uptime:
process.uptime(),
};
}
async function getReplicateStatus() {
if (!REPLICATE_API_TOKEN) {
return {
configured: false,
usable: false,
balanceKnown: false,
balance: null,
note:
"REPLICATE_API_TOKEN is not configured.",
};
}
return {
configured: true,
usable: true,
balanceKnown: false,
balance: null,
note:
"Replicate token is configured. Replicate does not provide a universal account balance through this server endpoint.",
};
}
async function getWallet() {
const finance =
await getFinance();
const grossRevenue =
Number(
finance.revenue || 0
);
const refunds =
Number(
finance.refunds || 0
);
const costs =
Number(
finance.providerCosts ||
0
) +
Number(
finance.fees || 0
) +
Number(
finance.otherExpenses ||
0
);
const profit =
grossRevenue -
refunds -
costs;
const withdrawn =
Number(
finance.withdrawals ||
0
);
const withdrawals =
await readJson(
WITHDRAWALS_FILE,
{}
);
const pendingWithdrawals =
Object.values(
withdrawals
)
.filter(
(x) =>
String(
x.status || ""
).toLowerCase() ===
"pending"
)
.reduce(
(sum, x) =>
sum +
Number(
x.amount || 0
),
0
);
const availableToWithdraw =
Math.max(
0,
profit -
withdrawn
);
return {
grossRevenue,
refunds,
costs,
profit,
withdrawn,
pendingWithdrawals,
availableToWithdraw,
};
}
async function getCreditsAdminData() {
const credits =
await readJson(
CREDITS_FILE,
{}
);
let issued = 0;
let consumed = 0;
let refunded = 0;
let current = 0;
for (
const record of Object.values(
credits
)
) {
issued +=
Number(
record.issued || 0
);
consumed +=
Number(
record.consumed || 0
);
refunded +=
Number(
record.refunded || 0
);
current +=
Number(
record.credits || 0
);
}
const payments =
await readJson(
PAYMENTS_FILE,
{}
);
const soldCredits =
Object.values(
payments
)
.filter(
(p) =>
p.fulfilledAt &&
p.status ===
"success"
)
.reduce(
(sum, p) =>
sum +
Number(
p.credits || 0
),
0
);
return {
issued,
consumed,
refunded,
current,
usable: current,
soldCredits,
};
}
async function getBillingData() {
const pricing =
await getPricing();
const finance =
await getFinance();
const wallet =
await getWallet();
const payments =
await readJson(
PAYMENTS_FILE,
{}
);
return {
paystackConfigured:
Boolean(
PAYSTACK_SECRET_KEY
),
paystackPublicKey:
PAYSTACK_PUBLIC_KEY ||
null,
currency:
PAYSTACK_CURRENCY_DEFAULT,
pricing,
payments:
Object.values(
payments
)
.sort(
(a, b) =>
String(
b.createdAt || ""
).localeCompare(
String(
a.createdAt || ""
)
)
)
.slice(0, 500),
finance,
wallet,
};
}
async function serveOutput(
req,
res
) {
const name = safeFileName(
req.params.name,
""
);
if (!name) {
return res.status(404).end();
}
const file = path.join(
OUTPUTS,
name
);
try {
await fs.access(file);
return res.sendFile(file);
} catch {
return res.status(404).json({
ok: false,
error:
"FILE_NOT_FOUND",
message:
"Requested media file was not found.",
});
}
}
app.get(
"/api/video/file/:name",
requireUser,
serveOutput
);
app.get(
"/api/studio/file/:name",
requireUser,
serveOutput
);
app.post(
"/api/auth/register",
async (req, res) => {
try {
const name =
cleanText(
req.body.name,
120
);
const email =
normalizeEmail(
req.body.email
);
const password =
String(
req.body.password ||
""
);
if (
!email ||
!password
) {
return res.status(400).json({
ok: false,
error:
"INVALID_INPUT",
message:
"Name, email and password are required.",
});
}
if (
password.length <
6
) {
return res.status(400).json({
ok: false,
error:
"WEAK_PASSWORD",
message:
"Password must contain at least 6 characters.",
});
}
const result =
await createUser(
name,
email,
password,
"user"
);
if (!result.ok) {
return res.status(409).json(
result
);
}
const token =
await createSession(
result.user.id,
"user"
);
await recordSecurityEvent(
"USER_REGISTERED",
{
userId:
result.user.id,
email,
}
);
res.json({
ok: true,
token,
user: {
id:
result.user.id,
name:
result.user.name,
email:
result.user.email,
role:
result.user.role,
},
credits: 100,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/auth/register",
}
);
res.status(500).json({
ok: false,
error:
"REGISTER_FAILED",
message:
"Unable to create your account.",
});
}
}
);
app.post(
"/api/auth/login",
async (req, res) => {
try {
const email =
normalizeEmail(
req.body.email
);
const password =
String(
req.body.password ||
""
);
const user =
await findUserByEmail(
email
);
if (
!user ||
user.disabled ||
!verifyPassword(
password,
user.salt,
user.passwordHash
)
) {
await recordSecurityEvent(
"USER_LOGIN_FAILED",
{
email,
}
);
return res.status(401).json({
ok: false,
error:
"INVALID_LOGIN",
message:
"Invalid email or password.",
});
}
user.lastLoginAt =
new Date().toISOString();
user.lastActiveAt =
new Date().toISOString();
const users =
await readJson(
USERS_FILE,
{}
);
users[user.id] =
user;
await writeJson(
USERS_FILE,
users
);
const token =
await createSession(
user.id,
user.role
);
await recordSecurityEvent(
"USER_LOGIN_SUCCESS",
{
userId:
user.id,
email:
user.email,
}
);
const credits =
await getUserCredits(
user.id
);
res.json({
ok: true,
token,
user: {
id:
user.id,
name:
user.name,
email:
user.email,
role:
user.role,
},
credits:
credits.credits,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/auth/login",
}
);
res.status(500).json({
ok: false,
error:
"LOGIN_FAILED",
message:
"Unable to complete login.",
});
}
}
);
app.post(
"/api/auth/logout",
async (req, res) => {
try {
const token =
getBearerToken(req);
if (token) {
const sessions =
await readJson(
SESSIONS_FILE,
{}
);
delete sessions[token];
await writeJson(
SESSIONS_FILE,
sessions
);
}
res.json({
ok: true,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/auth/logout",
}
);
res.json({
ok: true,
});
}
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
user: {
id: req.user.id,
name: req.user.name,
email: req.user.email,
role: req.user.role,
},
credits:
credits.credits,
});
}
);
app.post(
"/api/auth/forgot-password",
async (req, res) => {
try {
const email =
normalizeEmail(
req.body.email
);
if (
!allowedByRate(
resetRate,
email ||
"unknown",
3,
15 * 60 * 1000
)
) {
return res.status(429).json({
ok: false,
error:
"RATE_LIMITED",
message:
"Too many password reset requests. Try again later.",
});
}
const user =
await findUserByEmail(
email
);
if (!user) {
return res.json({
ok: true,
message:
"If the email exists, password reset instructions have been sent.",
});
}
const token =
await createResetToken(
user.id,
user.email
);
const resetUrl =
`${APP_URL}/?reset=${encodeURIComponent(
token
)}`;
const sent =
await sendRecoveryEmail(
user.email,
resetUrl
);
if (!sent) {
const resets = await readJson(RESET_FILE, {});
delete resets[token];
await writeJson(RESET_FILE, resets);
return res.status(503).json({
ok: false,
error:
"RECOVERY_NOT_CONFIGURED",
message:
"Password recovery email is not configured. Add RESEND_API_KEY and RESEND_FROM in Render Environment.",
});
}
await recordSecurityEvent(
"PASSWORD_RESET_REQUESTED",
{
userId:
user.id,
email:
user.email,
}
);
res.json({
ok: true,
message:
"Password reset instructions have been sent.",
});
} catch (error) {
await recordError(
error,
{
route:
"/api/auth/forgot-password",
}
);
res.status(500).json({
ok: false,
error:
"RECOVERY_FAILED",
message:
"Unable to process password recovery.",
});
}
}
);
app.post(
"/api/auth/reset-password",
async (req, res) => {
try {
const token =
cleanText(
req.body.token,
200
);
const password =
String(
req.body.password ||
""
);
if (
password.length <
6
) {
return res.status(400).json({
ok: false,
error:
"WEAK_PASSWORD",
message:
"Password must contain at least 6 characters.",
});
}
const resets =
await readJson(
RESET_FILE,
{}
);
const reset =
resets[token];
if (
!reset ||
Date.now() >
Number(
reset.expiresAt || 0
)
) {
return res.status(400).json({
ok: false,
error:
"INVALID_RESET_TOKEN",
message:
"This password reset link is invalid or expired.",
});
}
const users =
await readJson(
USERS_FILE,
{}
);
const user =
users[reset.userId];
if (!user) {
return res.status(400).json({
ok: false,
error:
"USER_NOT_FOUND",
message:
"Account not found.",
});
}
const credentials =
hashPassword(
password
);
user.salt =
credentials.salt;
user.passwordHash =
credentials.hash;
users[user.id] =
user;
await writeJson(
USERS_FILE,
users
);
delete resets[token];
await writeJson(
RESET_FILE,
resets
);
await invalidateUserSessions(
user.id
);
await recordSecurityEvent(
"PASSWORD_RESET_COMPLETED",
{
userId:
user.id,
email:
user.email,
}
);
res.json({
ok: true,
message:
"Password updated successfully.",
});
} catch (error) {
await recordError(
error,
{
route:
"/api/auth/reset-password",
}
);
res.status(500).json({
ok: false,
error:
"RESET_FAILED",
message:
"Unable to reset your password.",
});
}
}
);
app.post(
"/api/video/generate",
requireUser,
upload.single("image"),
async (req, res) => {
try {
const input = {
prompt:
cleanText(
req.body.prompt,
5000
),
duration:
req.body.duration,
ratio:
req.body.ratio,
style:
req.body.style,
image:
req.file
? {
buffer:
req.file.buffer,
originalname:
req.file.originalname,
}
: null,
};
const job =
await createVideoJob(
req.user,
input
);
const charge =
await consumeCredits(
req.user.id,
job.creditCost,
`AI video generation ${job.id}`
);
if (!charge.ok) {
return res.status(402).json({
ok: false,
error:
"INSUFFICIENT_CREDITS",
message:
"You do not have enough MAMAKI credits for this video.",
credits:
charge.credits,
required:
charge.required,
});
}
job.status =
"queued";
processVideoJob(
job
).catch(
async (error) => {
await recordError(
error,
{
route:
"/api/video/generate/background",
jobId:
job.id,
}
);
}
);
res.json({
ok: true,
job:
publicJob(job),
credits:
charge.credits,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/video/generate",
userId:
req.user.id,
}
);
res.status(500).json({
ok: false,
error:
"VIDEO_GENERATION_FAILED",
message:
error?.message ||
"Unable to start video generation.",
});
}
}
);
app.get(
"/api/video/job/:id",
requireUser,
async (req, res) => {
const job =
await getJob(
req.params.id
);
if (
!job ||
job.userId !==
req.user.id
) {
return res.status(404).json({
ok: false,
error:
"JOB_NOT_FOUND",
message:
"Video job not found.",
});
}
res.json({
ok: true,
job:
publicJob(job),
});
}
);
app.get(
"/api/user/dashboard",
requireUser,
async (req, res) => {
const credits =
await getUserCredits(
req.user.id
);
const usage =
await readJson(
USAGE_FILE,
{}
);
const pricing =
await getPricing();
res.json({
ok: true,
user: {
id: req.user.id,
name: req.user.name,
email: req.user.email,
role: req.user.role,
},
credits:
credits.credits,
usage:
usage[
req.user.id
] || {},
pricing:
pricing.packages,
});
}
);
app.post(
"/api/user/change-password",
requireUser,
async (req, res) => {
try {
const current =
String(
req.body.currentPassword ||
""
);
const next =
String(
req.body.newPassword ||
""
);
if (
!verifyPassword(
current,
req.user.salt,
req.user.passwordHash
)
) {
return res.status(401).json({
ok: false,
error:
"INVALID_PASSWORD",
message:
"Current password is incorrect.",
});
}
if (
next.length <
6
) {
return res.status(400).json({
ok: false,
error:
"WEAK_PASSWORD",
message:
"New password must contain at least 6 characters.",
});
}
const users =
await readJson(
USERS_FILE,
{}
);
const user =
users[req.user.id];
const credentials =
hashPassword(
next
);
user.salt =
credentials.salt;
user.passwordHash =
credentials.hash;
users[user.id] =
user;
await writeJson(
USERS_FILE,
users
);
await invalidateUserSessions(
user.id
);
const token =
await createSession(
user.id,
user.role
);
res.json({
ok: true,
token,
message:
"Password changed successfully.",
});
} catch (error) {
await recordError(
error,
{
route:
"/api/user/change-password",
userId:
req.user.id,
}
);
res.status(500).json({
ok: false,
error:
"CHANGE_PASSWORD_FAILED",
message:
"Unable to change your password.",
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
const projectDir =
path.join(
PROJECTS,
safeFileName(
req.user.id
)
);
await fs.mkdir(
projectDir,
{ recursive: true }
);
const file =
path.join(
projectDir,
`${safeFileName(id)}.json`
);
const project = {
id,
userId:
req.user.id,
name:
cleanText(
req.body.name,
200
) ||
"MAMAKI Project",
script:
cleanText(
req.body.script,
30000
),
duration:
normalizeDuration(
req.body.duration
),
ratio:
normalizeRatio(
req.body.ratio
),
style:
cleanText(
req.body.style,
50
) ||
"Cinematic",
createdAt:
new Date().toISOString(),
updatedAt:
new Date().toISOString(),
};
await fs.writeFile(
file,
JSON.stringify(
project,
null,
2
),
"utf8"
);
res.json({
ok: true,
project,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/projects",
userId:
req.user.id,
}
);
res.status(500).json({
ok: false,
error:
"PROJECT_CREATE_FAILED",
message:
"Unable to save project.",
});
}
}
);
app.get(
"/api/projects",
requireUser,
async (req, res) => {
try {
const dir =
path.join(
PROJECTS,
safeFileName(
req.user.id
)
);
const names =
await fs
.readdir(
dir
)
.catch(() => []);
const projects = [];
for (const name of names) {
if (!name.endsWith(".json")) {
continue;
}
try {
const raw =
await fs.readFile(
path.join(
dir,
name
),
"utf8"
);
const item =
JSON.parse(raw);
if (
item &&
item.userId ===
req.user.id
) {
projects.push(item);
}
} catch {}
}
projects.sort(
(a, b) =>
String(
b.updatedAt ||
b.createdAt ||
""
).localeCompare(
String(
a.updatedAt ||
a.createdAt ||
""
)
)
);
res.json({
ok: true,
projects,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/projects/list",
userId:
req.user.id,
}
);
res.status(500).json({
ok: false,
error:
"PROJECT_LIST_FAILED",
message:
"Unable to load projects.",
});
}
}
);
app.get(
"/api/projects/:id",
requireUser,
async (req, res) => {
try {
const file =
path.join(
PROJECTS,
safeFileName(
req.user.id
),
`${safeFileName(
req.params.id
)}.json`
);
const raw =
await fs.readFile(
file,
"utf8"
);
const project =
JSON.parse(raw);
if (
project.userId !==
req.user.id
) {
return res.status(403).json({
ok: false,
error:
"PROJECT_FORBIDDEN",
message:
"Project access denied.",
});
}
res.json({
ok: true,
project,
});
} catch (error) {
res.status(404).json({
ok: false,
error:
"PROJECT_NOT_FOUND",
message:
"Project not found.",
});
}
}
);
app.put(
"/api/projects/:id",
requireUser,
async (req, res) => {
try {
const file =
path.join(
PROJECTS,
safeFileName(
req.user.id
),
`${safeFileName(
req.params.id
)}.json`
);
const raw =
await fs.readFile(
file,
"utf8"
);
const project =
JSON.parse(raw);
if (
project.userId !==
req.user.id
) {
return res.status(403).json({
ok: false,
error:
"PROJECT_FORBIDDEN",
message:
"Project access denied.",
});
}
project.name =
cleanText(
req.body.name,
200
) ||
project.name ||
"MAMAKI Project";
project.script =
cleanText(
req.body.script,
30000
);
project.duration =
normalizeDuration(
req.body.duration
);
project.ratio =
normalizeRatio(
req.body.ratio
);
project.style =
cleanText(
req.body.style,
50
) ||
project.style ||
"Cinematic";
project.updatedAt =
new Date().toISOString();
await fs.writeFile(
file,
JSON.stringify(
project,
null,
2
),
"utf8"
);
res.json({
ok: true,
project,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/projects/:id",
userId:
req.user.id,
}
);
res.status(500).json({
ok: false,
error:
"PROJECT_UPDATE_FAILED",
message:
"Unable to update project.",
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
safeFileName(
req.user.id
),
`${safeFileName(
req.params.id
)}.json`
);
await fs.unlink(
file
);
res.json({
ok: true,
});
} catch (error) {
res.status(404).json({
ok: false,
error:
"PROJECT_NOT_FOUND",
message:
"Project not found.",
});
}
}
);
app.post(
"/api/billing/paystack/initialize",
requireUser,
async (req, res) => {
try {
if (
!PAYSTACK_SECRET_KEY
) {
return res.status(503).json({
ok: false,
error:
"PAYSTACK_NOT_CONFIGURED",
message:
"Paystack is not configured yet.",
});
}
const credits =
Math.max(
1,
Math.round(
Number(
req.body.credits
)
)
);
const pricing =
await getPricing();
const packageData =
pricing.packages.find(
(p) =>
p.credits ===
credits
);
if (!packageData) {
return res.status(400).json({
ok: false,
error:
"INVALID_CREDIT_PACKAGE",
message:
"This credit package is not available.",
});
}
const amount =
paystackAmountToNaira(
packageData.amount
);
const reference =
paymentReference();
const payment = {
id: randomUUID(),
reference,
userId:
req.user.id,
email:
req.user.email,
credits,
amount,
currency:
PAYSTACK_CURRENCY_DEFAULT,
status:
"initialized",
createdAt:
new Date().toISOString(),
fulfilledAt: null,
};
await savePayment(
payment
);
const data =
await paystackRequest(
"/transaction/initialize",
{
method: "POST",
body: JSON.stringify({
email:
req.user.email,
amount:
amount * 100,
currency:
PAYSTACK_CURRENCY_DEFAULT,
reference,
callback_url:
`${APP_URL}/?payment=${encodeURIComponent(
reference
)}`,
metadata: {
mamakiUserId:
req.user.id,
credits,
reference,
},
}),
}
);
payment.status =
"pending";
payment.authorizationUrl =
data.data?.authorization_url ||
null;
payment.accessCode =
data.data?.access_code ||
null;
await savePayment(
payment
);
res.json({
ok: true,
reference,
amount,
credits,
currency:
PAYSTACK_CURRENCY_DEFAULT,
authorizationUrl:
payment.authorizationUrl,
accessCode:
payment.accessCode,
publicKey:
PAYSTACK_PUBLIC_KEY ||
null,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/billing/paystack/initialize",
userId:
req.user.id,
}
);
res.status(500).json({
ok: false,
error:
error?.code ||
"PAYSTACK_INITIALIZE_FAILED",
message:
error?.message ||
"Unable to initialize Paystack payment.",
});
}
}
);
app.get(
"/api/billing/pricing",
async (req, res) => {
try {
const pricing =
await getPricing();
res.json({
ok: true,
configured:
Boolean(
PAYSTACK_SECRET_KEY
),
publicKey:
PAYSTACK_PUBLIC_KEY ||
null,
currency:
PAYSTACK_CURRENCY_DEFAULT,
fx:
pricing.fx,
packages: (pricing.packages || []).map((p) => ({
credits: Number(p.credits || 0),
amount: Number(p.amount || 0),
currency: String(
p.currency || PAYSTACK_CURRENCY_DEFAULT
).toUpperCase(),
usdPrice: Number(p.usdPrice || 0),
})),
});
} catch (error) {
await recordError(
error,
{
route:
"/api/billing/pricing",
}
);
res.status(500).json({
ok: false,
error:
"PRICING_FAILED",
message:
"Unable to load MAMAKI credit packages.",
});
}
}
);
app.get(
"/api/billing/payment/:reference",
requireUser,
async (req, res) => {
try {
const payment =
await findPaymentByReference(
req.params.reference
);
if (
!payment ||
payment.userId !==
req.user.id
) {
return res.status(404).json({
ok: false,
error:
"PAYMENT_NOT_FOUND",
message:
"Payment not found.",
});
}
if (
PAYSTACK_SECRET_KEY &&
payment.status !==
"success"
) {
try {
const verified =
await paystackRequest(
`/transaction/verify/${encodeURIComponent(
payment.reference
)}`,
{
method: "GET",
}
);
if (
verified.data?.status ===
"success"
) {
await fulfillPayment(
payment.reference,
verified.data
);
}
} catch {
}
}
const latest =
await findPaymentByReference(
payment.reference
);
res.json({
ok: true,
payment:
latest || payment,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/billing/payment/:reference",
userId:
req.user.id,
}
);
res.status(500).json({
ok: false,
error:
"PAYMENT_STATUS_FAILED",
message:
"Unable to check payment status.",
});
}
}
);
async function processPaystackWebhook(
req,
res
) {
if (
!verifyPaystackSignature(
req
)
) {
return res.status(401).json({
ok: false,
error:
"INVALID_SIGNATURE",
});
}
try {
const event =
req.body || {};
if (
event.event ===
"charge.success" &&
event.data?.reference
) {
await fulfillPayment(
event.data.reference,
event.data
);
}
res.sendStatus(200);
} catch (error) {
await recordError(
error,
{
route:
req.originalUrl,
}
);
res.sendStatus(200);
}
}
app.post(
"/api/billing/paystack/webhook",
processPaystackWebhook
);
app.post(
"/api/payments/paystack/webhook",
processPaystackWebhook
);
app.post(
"/api/studio/photo-video",
requireUser,
upload.single("image"),
async (req, res) => {
try {
if (!req.file) {
return res.status(400).json({
ok: false,
error:
"IMAGE_REQUIRED",
message:
"Please upload an image.",
});
}
const inputFile =
path.join(
TMP,
`${randomUUID()}-${safeFileName(
req.file.originalname,
"image.jpg"
)}`
);
await fs.writeFile(
inputFile,
req.file.buffer
);
const clip =
path.join(
TMP,
`${randomUUID()}.mp4`
);
const output =
path.join(
OUTPUTS,
`${randomUUID()}.mp4`
);
await runFFmpeg([
"-y",
"-loop",
"1",
"-i",
inputFile,
"-t",
String(
normalizeDuration(
req.body.duration || 5
)
),
"-vf",
`scale=${ratioSize(
normalizeRatio(
req.body.ratio ||
"9:16"
)
)}:force_original_aspect_ratio=decrease,pad=${ratioSize(
normalizeRatio(
req.body.ratio ||
"9:16"
)
)}:(ow-iw)/2:(oh-ih)/2`,
"-r",
"24",
"-c:v",
"libx264",
"-preset",
"veryfast",
"-crf",
"20",
"-pix_fmt",
"yuv420p",
"-an",
clip,
]);
await addWatermark(
clip,
output
);
await fs
.unlink(inputFile)
.catch(() => {});
await fs
.unlink(clip)
.catch(() => {});
await recordUsage(
req.user.id,
"studio"
);
res.json({
ok: true,
videoUrl:
`/api/studio/file/${path.basename(
output
)}`,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/studio/photo-video",
userId:
req.user.id,
}
);
res.status(500).json({
ok: false,
error:
"PHOTO_VIDEO_FAILED",
message:
error?.message ||
"Unable to create photo video.",
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
"VIDEO_REQUIRED",
message:
"Please upload a video.",
});
}
const input =
path.join(
TMP,
`${randomUUID()}-${safeFileName(
req.file.originalname,
"video.mp4"
)}`
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
req.body.start || 0
)
);
const end =
Math.max(
start,
Number(
req.body.end ||
start + 5
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
"-crf",
"20",
"-c:a",
"aac",
"-b:a",
"160k",
"-movflags",
"+faststart",
output,
]);
await fs
.unlink(input)
.catch(() => {});
await recordUsage(
req.user.id,
"studio"
);
res.json({
ok: true,
videoUrl:
`/api/studio/file/${path.basename(
output
)}`,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/studio/trim",
userId:
req.user.id,
}
);
res.status(500).json({
ok: false,
error:
"TRIM_FAILED",
message:
error?.message ||
"Unable to trim video.",
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
!Array.isArray(req.files) ||
!req.files.length
) {
return res.status(400).json({
ok: false,
error:
"VIDEOS_REQUIRED",
message:
"Please upload one or more videos.",
});
}
const inputs = [];
for (const file of req.files) {
const input =
path.join(
TMP,
`${randomUUID()}-${safeFileName(
file.originalname,
"video.mp4"
)}`
);
await fs.writeFile(
input,
file.buffer
);
inputs.push(
input
);
}
const output =
path.join(
OUTPUTS,
`${randomUUID()}.mp4`
);
await combineVideoFiles(
inputs,
output
);
for (
const input of inputs
) {
await fs
.unlink(input)
.catch(() => {});
}
await recordUsage(
req.user.id,
"studio"
);
res.json({
ok: true,
videoUrl:
`/api/studio/file/${path.basename(
output
)}`,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/studio/combine",
userId:
req.user.id,
}
);
res.status(500).json({
ok: false,
error:
"COMBINE_FAILED",
message:
error?.message ||
"Unable to combine videos.",
});
}
}
);
app.post(
"/api/studio/narration",
requireUser,
async (req, res) => {
try {
const text =
cleanText(
req.body.text,
30000
);
if (!text) {
return res.status(400).json({
ok: false,
error:
"TEXT_REQUIRED",
message:
"Narration text is required.",
});
}
const output =
path.join(
OUTPUTS,
`${randomUUID()}.mp3`
);
await createNarration(
text,
cleanText(
req.body.voice,
100
) ||
"en-US-AriaNeural",
output
);
await recordUsage(
req.user.id,
"narration"
);
res.json({
ok: true,
audioUrl:
`/api/studio/file/${path.basename(
output
)}`,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/studio/narration",
userId:
req.user.id,
}
);
res.status(500).json({
ok: false,
error:
"NARRATION_FAILED",
message:
error?.message ||
"Unable to create narration.",
});
}
}
);
app.post(
"/api/studio/captions",
requireUser,
upload.single("video"),
async (req, res) => {
try {
if (!req.file) {
return res.status(400).json({
ok: false,
error:
"VIDEO_REQUIRED",
message:
"Please upload a video.",
});
}
const input =
path.join(
TMP,
`${randomUUID()}-${safeFileName(
req.file.originalname,
"video.mp4"
)}`
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
const caption =
cleanText(
req.body.caption,
300
).replace(
/[\r\n]/g,
" "
);
const safeCaption =
caption.replace(
/'/g,
"\\'"
);
if (safeCaption) {
await runFFmpeg([
"-y",
"-i",
input,
"-vf",
`drawtext=text='${safeCaption}':fontcolor=white:fontsize=30:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-100`,
"-c:v",
"libx264",
"-preset",
"veryfast",
"-crf",
"20",
"-c:a",
"aac",
"-b:a",
"160k",
"-movflags",
"+faststart",
output,
]);
} else {
await fs.copyFile(
input,
output
);
}
await fs
.unlink(input)
.catch(() => {});
await recordUsage(
req.user.id,
"studio"
);
res.json({
ok: true,
videoUrl:
`/api/studio/file/${path.basename(
output
)}`,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/studio/captions",
userId:
req.user.id,
}
);
res.status(500).json({
ok: false,
error:
"CAPTIONS_FAILED",
message:
error?.message ||
"Unable to add captions.",
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
"VIDEO_REQUIRED",
message:
"Please upload a video.",
});
}
const input =
path.join(
TMP,
`${randomUUID()}-${safeFileName(
req.file.originalname,
"video.mp4"
)}`
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
const ratio =
normalizeRatio(
req.body.ratio ||
"9:16"
);
await resizeVideo(
input,
output,
ratio
);
await fs
.unlink(input)
.catch(() => {});
await recordUsage(
req.user.id,
"studio"
);
res.json({
ok: true,
videoUrl:
`/api/studio/file/${path.basename(
output
)}`,
ratio,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/studio/social",
userId:
req.user.id,
}
);
res.status(500).json({
ok: false,
error:
"SOCIAL_EXPORT_FAILED",
message:
error?.message ||
"Unable to export video.",
});
}
}
);
app.get(
"/api/health",
async (req, res) => {
res.json({
ok: true,
status:
"healthy",
service:
"MAMAKI AI Video Creative Studio",
version:
VERSION,
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
recoveryConfigured:
Boolean(
RESEND_API_KEY &&
RESEND_FROM
),
authentication: true,
storage: true,
},
});
}
);
app.get(
"/api/admin/stats",
requireAdmin,
async (req, res) => {
try {
res.json({
ok: true,
stats:
await getAdminStats(),
});
} catch (error) {
await recordError(
error,
{
route:
"/api/admin/stats",
}
);
res.status(500).json({
ok: false,
error:
"ADMIN_STATS_FAILED",
message:
"Unable to load administrator statistics.",
});
}
}
);
app.get(
"/api/admin/users",
requireAdmin,
async (req, res) => {
try {
res.json({
ok: true,
users:
await listUsers(),
});
} catch (error) {
await recordError(
error,
{
route:
"/api/admin/users",
}
);
res.status(500).json({
ok: false,
error:
"ADMIN_USERS_FAILED",
message:
"Unable to load users.",
});
}
}
);
app.get(
"/api/admin/jobs",
requireAdmin,
async (req, res) => {
const list =
Array.from(
jobs.values()
)
.sort(
(a, b) =>
String(
b.createdAt || ""
).localeCompare(
String(
a.createdAt || ""
)
)
)
.slice(0, 500);
res.json({
ok: true,
jobs:
list.map(
publicJob
),
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
{}
);
res.json({
ok: true,
errors:
Object.values(
errors
).sort(
(a, b) =>
String(
b.createdAt || ""
).localeCompare(
String(
a.createdAt || ""
)
)
),
});
}
);
app.get(
"/api/admin/security",
requireAdmin,
async (req, res) => {
const security =
await readJson(
SECURITY_FILE,
{ events: [] }
);
res.json({
ok: true,
events:
Array.isArray(
security.events
)
? security.events
.slice()
.reverse()
: [],
});
}
);
app.get(
"/api/admin/credits",
requireAdmin,
async (req, res) => {
res.json({
ok: true,
...(await getCreditsAdminData()),
});
}
);
app.get(
"/api/admin/finance",
requireAdmin,
async (req, res) => {
const finance =
await getFinance();
res.json({
ok: true,
finance,
transactions:
finance.transactions
.slice()
.reverse(),
});
}
);
app.get(
"/api/admin/billing",
requireAdmin,
async (req, res) => {
try {
res.json({
ok: true,
...(await getBillingData()),
});
} catch (error) {
await recordError(
error,
{
route:
"/api/admin/billing",
}
);
res.status(500).json({
ok: false,
error:
"ADMIN_BILLING_FAILED",
message:
"Unable to load billing data.",
});
}
}
);
app.post(
"/api/admin/users/:id/credits",
requireAdmin,
async (req, res) => {
try {
const amount =
Math.round(
Number(
req.body.amount
)
);
if (
!Number.isFinite(
amount
) ||
amount === 0
) {
return res.status(400).json({
ok: false,
error:
"INVALID_AMOUNT",
message:
"Credit adjustment must be a non-zero number.",
});
}
const record =
await getUserCredits(
req.params.id
);
if (amount > 0) {
await addCredits(
req.params.id,
amount,
"Administrator credit adjustment"
);
} else {
const debit =
Math.abs(
amount
);
if (
record.credits <
debit
) {
return res.status(400).json({
ok: false,
error:
"INSUFFICIENT_USER_CREDITS",
message:
"User does not have enough credits for this debit.",
});
}
record.credits -=
debit;
record.consumed +=
debit;
if (
!Array.isArray(
record.history
)
) {
record.history =
[];
}
record.history.push({
id: randomUUID(),
type:
"admin_debit",
amount:
-debit,
reason:
"Administrator credit adjustment",
createdAt:
new Date().toISOString(),
});
await saveUserCredits(
req.params.id,
record
);
}
const updated =
await getUserCredits(
req.params.id
);
await recordSecurityEvent(
"ADMIN_CREDIT_ADJUSTMENT",
{
adminId:
req.user.id,
userId:
req.params.id,
amount,
}
);
res.json({
ok: true,
credits:
updated.credits,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/admin/users/:id/credits",
}
);
res.status(500).json({
ok: false,
error:
"CREDIT_ADJUSTMENT_FAILED",
message:
"Unable to adjust credits.",
});
}
}
);
app.post(
"/api/admin/users/:id/disable",
requireAdmin,
async (req, res) => {
try {
const users =
await readJson(
USERS_FILE,
{}
);
const user =
users[req.params.id];
if (!user) {
return res.status(404).json({
ok: false,
error:
"USER_NOT_FOUND",
message:
"User not found.",
});
}
const disabled =
Boolean(
req.body.disabled
);
user.disabled =
disabled;
users[user.id] =
user;
await writeJson(
USERS_FILE,
users
);
if (disabled) {
await invalidateUserSessions(
user.id
);
}
await recordSecurityEvent(
"ADMIN_USER_STATUS_CHANGED",
{
adminId:
req.user.id,
userId:
user.id,
disabled,
}
);
res.json({
ok: true,
user: {
id:
user.id,
disabled:
user.disabled,
},
});
} catch (error) {
await recordError(
error,
{
route:
"/api/admin/users/:id/disable",
}
);
res.status(500).json({
ok: false,
error:
"USER_STATUS_FAILED",
message:
"Unable to change user status.",
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
String(
req.body.type ||
"expense"
);
const allowed = [
"revenue",
"refund",
"provider_cost",
"fee",
"expense",
];
if (
!allowed.includes(
type
)
) {
return res.status(400).json({
ok: false,
error:
"INVALID_FINANCE_TYPE",
message:
"Invalid finance transaction type.",
});
}
const amount =
Number(
req.body.amount
);
if (
!Number.isFinite(
amount
) ||
amount < 0
) {
return res.status(400).json({
ok: false,
error:
"INVALID_AMOUNT",
message:
"Invalid finance amount.",
});
}
await recordFinance(
type,
amount,
cleanText(
req.body.description,
500
) ||
"Administrator finance entry",
{
adminId:
req.user.id,
}
);
res.json({
ok: true,
message:
"Finance transaction recorded.",
});
} catch (error) {
await recordError(
error,
{
route:
"/api/admin/finance",
}
);
res.status(500).json({
ok: false,
error:
"FINANCE_FAILED",
message:
"Unable to record finance transaction.",
});
}
}
);
app.post(
"/api/admin/withdraw",
requireAdmin,
async (req, res) => {
try {
if (
!PAYSTACK_SECRET_KEY
) {
return res.status(503).json({
ok: false,
error:
"PAYSTACK_NOT_CONFIGURED",
message:
"Paystack is not configured.",
});
}
const amount =
Math.round(
Number(
req.body.amount
)
);
const name =
cleanText(
req.body.name,
150
);
const accountNumber =
cleanText(
req.body.accountNumber,
30
);
const bankCode =
cleanText(
req.body.bankCode,
30
);
if (
!Number.isFinite(
amount
) ||
amount <= 0 ||
!name ||
!accountNumber ||
!bankCode
) {
return res.status(400).json({
ok: false,
error:
"INVALID_WITHDRAWAL",
message:
"Amount, account name, account number and bank code are required.",
});
}
const wallet =
await getWallet();
if (
amount >
wallet.availableToWithdraw
) {
return res.status(400).json({
ok: false,
error:
"INSUFFICIENT_PROFIT",
message:
"Withdrawal amount exceeds available MAMAKI profit.",
available:
wallet.availableToWithdraw,
});
}
const recipient =
await paystackRequest(
"/transferrecipient",
{
method: "POST",
body: JSON.stringify({
type:
"nuban",
name,
account_number:
accountNumber,
bank_code:
bankCode,
currency:
"NGN",
}),
}
);
const transfer =
await paystackRequest(
"/transfer",
{
method: "POST",
body: JSON.stringify({
source:
"balance",
amount:
amount * 100,
recipient:
recipient.data.recipient_code,
reason:
"MAMAKI AI owner profit withdrawal",
}),
}
);
const withdrawals =
await readJson(
WITHDRAWALS_FILE,
{}
);
const reference =
transfer.data?.reference ||
paymentReference();
const record = {
id: randomUUID(),
reference,
amount,
accountNumber,
bankCode,
status:
transfer.data?.status ||
"pending",
createdAt:
new Date().toISOString(),
paystackData:
transfer.data ||
null,
};
withdrawals[
record.id
] = record;
await writeJson(
WITHDRAWALS_FILE,
withdrawals
);
await recordFinance(
"withdrawal",
amount,
"Owner profit withdrawal",
{
withdrawalId:
record.id,
reference,
adminId:
req.user.id,
}
);
await recordSecurityEvent(
"ADMIN_PROFIT_WITHDRAWAL",
{
adminId:
req.user.id,
amount,
reference,
}
);
res.json({
ok: true,
message:
"Profit withdrawal submitted to Paystack.",
withdrawal:
record,
});
} catch (error) {
await recordError(
error,
{
route:
"/api/admin/withdraw",
}
);
res.status(500).json({
ok: false,
error:
error?.code ||
"WITHDRAWAL_FAILED",
message:
error?.message ||
"Unable to process owner withdrawal.",
});
}
}
);
app.post(
"/api/admin/login",
async (req, res) => {
if (
!ADMIN_EMAIL ||
!ADMIN_PASSWORD
) {
return res.status(503).json({
ok: false,
error:
"ADMIN_NOT_CONFIGURED",
message:
"Admin credentials are not configured in Render.",
});
}
const email =
normalizeEmail(
req.body.email
);
const password =
String(
req.body.password ||
""
);
if (
!allowedByRate(
adminLoginRate,
email ||
"unknown",
5,
15 * 60 * 1000
)
) {
await recordSecurityEvent(
"admin_login_rate_limited",
{
email,
}
);
return res.status(429).json({
ok: false,
error:
"ADMIN_RATE_LIMITED",
message:
"Too many administrator login attempts. Try again later.",
});
}
if (
email !==
ADMIN_EMAIL ||
password !==
ADMIN_PASSWORD
) {
await recordSecurityEvent(
"admin_login_failed",
{
email,
}
);
return res.status(401).json({
ok: false,
error:
"INVALID_ADMIN_LOGIN",
message:
"Invalid administrator credentials.",
});
}
try {
const users =
await readJson(
USERS_FILE,
{}
);
const matches =
Object.values(users)
.filter(
(u) =>
normalizeEmail(
u.email
) ===
ADMIN_EMAIL
)
.sort(
(a, b) =>
String(
a.createdAt || ""
).localeCompare(
String(
b.createdAt || ""
)
)
);
let admin =
matches[0];
let restored = false;
if (!admin) {
const credentials =
hashPassword(
ADMIN_PASSWORD
);
admin = {
id: randomUUID(),
name:
"MAMAKI Administrator",
email:
ADMIN_EMAIL,
salt:
credentials.salt,
passwordHash:
credentials.hash,
role:
"admin",
disabled:
false,
createdAt:
new Date().toISOString(),
lastLoginAt:
null,
lastActiveAt:
new Date().toISOString(),
};
users[admin.id] =
admin;
await writeJson(
USERS_FILE,
users
);
await getUserCredits(
admin.id
);
} else {
if (
admin.role !==
"admin" ||
admin.disabled
) {
restored = true;
}
admin.role =
"admin";
admin.disabled =
false;
admin.salt =
admin.salt ||
hashPassword(
ADMIN_PASSWORD
).salt;
if (
!verifyPassword(
ADMIN_PASSWORD,
admin.salt,
admin.passwordHash
)
) {
const credentials =
hashPassword(
ADMIN_PASSWORD
);
admin.salt =
credentials.salt;
admin.passwordHash =
credentials.hash;
}
admin.lastLoginAt =
new Date().toISOString();
admin.lastActiveAt =
new Date().toISOString();
users[admin.id] =
admin;
for (
const duplicate of matches.slice(
1
)
) {
delete users[
duplicate.id
];
await invalidateUserSessions(
duplicate.id
);
}
await writeJson(
USERS_FILE,
users
);
await getUserCredits(
admin.id
);
}
const token =
await createSession(
admin.id,
"admin"
);
if (restored) {
await recordSecurityEvent(
"ADMIN_ACCOUNT_RESTORED",
{
userId:
admin.id,
email:
ADMIN_EMAIL,
}
);
}
await recordSecurityEvent(
"ADMIN_LOGIN_SUCCESS",
{
userId:
admin.id,
email:
ADMIN_EMAIL,
method:
"MASTER_CREDENTIALS",
}
);
res.json({
ok: true,
token,
admin: {
id:
admin.id,
email:
admin.email,
role:
"admin",
},
});
} catch (error) {
await recordError(
error,
{
route:
"/api/admin/login",
}
);
res.status(500).json({
ok: false,
error:
"ADMIN_LOGIN_FAILED",
message:
"Unable to complete administrator login.",
});
}
}
);
/* ========================================================= ADMIN DASHBOARD
========================================================= */
app.get(
"/admin",
async (req, res) => {
res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>MAMAKI Administrator</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#050509;color:#f4f4f7;font-family:Inter,Arial,sans-serif}
body{min-height:100vh}
main{max-width:1500px;margin:auto;padding:24px}
.card{background:#0d0d15;border:1px solid #252535;border-radius:18px;padding:20px;margin-bottom:18px;box-shadow:0 12px 40px rgba(0,0,0,.22)}
h1,h2,h3{margin-top:0}
h1{font-size:30px}
h2{font-size:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.stat{padding:16px;background:#12121b;border:1px solid #272739;border-radius:14px}
.stat b{display:block;font-size:25px;margin-top:6px}
label{display:block;margin:12px 0 6px;color:#aaa}
input,select,button{width:100%;padding:12px;border-radius:10px;border:1px solid
#303044;background:#090910;color:#fff}
button{cursor:pointer;font-weight:700}
button.primary{background:#fff;color:#050509}
button.danger{background:#39151a;border-color:#6d252e}
button:disabled{opacity:.55;cursor:not-allowed}
table{width:100%;border-collapse:collapse;display:block;overflow:auto}
th,td{padding:10px;border-bottom:1px solid #252535;text-align:left;white-space:nowrap}
small,.muted{color:#9a9aaa}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.hidden{display:none!important}
.msg{margin-top:12px;min-height:22px;color:#ddd}
.badge{display:inline-block;padding:5px 9px;border-radius:999px;background:#181827;border:1px solid
#303047;font-size:12px}
.actions{display:flex;gap:10px;flex-wrap:wrap}
.actions button{width:auto}
</style>
</head>
<body>
<main>
<section id="login" class="card">
<h1>🔐 MAMAKI Administrator</h1>
<p class="muted">Private administrator access.</p>
<label for="email">Administrator email</label>
<input id="email" type="email" autocomplete="username" placeholder="Administrator email">
<label for="password">Administrator password</label>
<input id="password" type="password" autocomplete="current-password" placeholder="Administrator password">
<div style="margin-top:14px">
<button class="primary" onclick="login()">Login</button>
</div>
<div id="msg" class="msg"></div>
</section>
<section id="dash" class="hidden">
<div class="card">
<h1>📊 MAMAKI AI Administrator Dashboard</h1>
<p class="muted">Private business, users, credits, payments, AI and system control center.</p>
<div class="actions" id="actions">
<button onclick="loadAll(true)">Refresh</button>
<button onclick="logout()">Logout</button>
</div>
</div>
<section class="grid">
<div class="stat">Total Users<b id="users">0</b></div>
<div class="stat">Active Users<b id="active">0</b></div>
<div class="stat">Today<b id="today">0</b></div>
<div class="stat">This Week<b id="week">0</b></div>
<div class="stat">This Month<b id="month">0</b></div>
<div class="stat">Administrators<b id="admins">0</b></div>
<div class="stat">Videos Generated<b id="videos">0</b></div>
<div class="stat">AI Seconds<b id="seconds">0</b></div>
<div class="stat">Narrations<b id="narrations">0</b></div>
<div class="stat">Projects<b id="projects">0</b></div>
<div class="stat">Completed Jobs<b id="completed">0</b></div>
<div class="stat">Processing Jobs<b id="processing">0</b></div>
<div class="stat">Failed Jobs<b id="failed">0</b></div>
<div class="stat">Recovery<b id="recovery">—</b></div>
<div class="stat">Uptime<b id="uptime">—</b></div>
</section>
<section class="card">
<h2>🤖 AI Provider</h2>
<div class="grid">
<div class="stat">Replicate<b id="repstatus">—</b></div>
<div class="stat">AI Availability<b id="aiavail">—</b></div>
<div class="stat">Replicate Balance<b id="rep">—</b></div>
<div class="stat">T2V Model<b id="t2v">—</b></div>
<div class="stat">I2V Model<b id="i2v">—</b></div>
</div>
<p id="repnote" class="muted"></p>
</section>
<section class="card">
<h2>💰 Business & Finance</h2>
<div class="grid">
<div class="stat">Gross Revenue<b id="gross">₦0</b></div>
<div class="stat">Refunds<b id="refunds">₦0</b></div>
<div class="stat">Costs<b id="costs">₦0</b></div>
<div class="stat">Profit<b id="profit">₦0</b></div>
<div class="stat">Withdrawn<b id="withdrawn">₦0</b></div>
<div class="stat">Pending Withdrawals<b id="pending">₦0</b></div>
<div class="stat">Available Profit<b id="available">₦0</b></div>
<div class="stat">Profit Margin<b id="margin">0%</b></div>
</div>
</section>
<section class="card">
<h2>💳 Paystack & Pricing</h2>
<div class="grid">
<div class="stat">Paystack<b id="paystatus">—</b></div>
<div class="stat">Live USD/NGN<b id="fx">—</b></div>
<div class="stat">FX Status<b id="fxnote">—</b></div>
<div class="stat">Target Margin<b id="targetmargin">—</b></div>
<div class="stat">Fixed Markup<b id="markup">—</b></div>
<div class="stat">Credits Sold<b id="soldcredits">0</b></div>
</div>
</section>
<section class="card">
<h2>🪙 MAMAKI Credits</h2>
<div class="grid">
<div class="stat">Issued<b id="issued">0</b></div>
<div class="stat">Consumed<b id="consumed">0</b></div>
<div class="stat">Refunded<b id="crefund">0</b></div>
<div class="stat">Current Credits<b id="credits">0</b></div>
<div class="stat">Usable Credits<b id="usable">0</b></div>
</div>
</section>
<section class="card">
<h2>👥 Users</h2>
<table>
<thead>
<tr>
<th>Name</th>
<th>Email</th>
<th>Role</th>
<th>Credits</th>
<th>AI Generations</th>
<th>AI Seconds</th>
<th>Studio</th>
<th>Narration</th>
<th>Last Active</th>
<th>Status</th>
</tr>
</thead>
<tbody id="utable"></tbody>
</table>
</section>
<section class="card">
<h2>🪙 Manual Credit Adjustment</h2>
<div class="row">
<div>
<label>User ID</label>
<input id="uid" placeholder="User ID">
</div>
<div>
<label>Credit amount</label>
<input id="amount" type="number" placeholder="100 or -100">
</div>
</div>
<button style="margin-top:12px" onclick="adjustCredits()">Adjust Credits</button>
<div id="cmsg" class="msg"></div>
</section>
<section class="card">
<h2>📒 Manual Finance Entry</h2>
<div class="row">
<div>
<label>Type</label>
<select id="ftype">
<option value="revenue">Revenue</option>
<option value="refund">Refund</option>
<option value="provider_cost">Provider Cost</option>
<option value="fee">Fee</option>
<option value="expense">Expense</option>
</select>
</div>
<div>
<label>Amount NGN</label>
<input id="famount" type="number" min="0">
</div>
<div>
<label>Description</label>
<input id="fdesc">
</div>
</div>
<button style="margin-top:12px" onclick="finance()">Record Finance</button>
<div id="fmsg" class="msg"></div>
</section>
<section class="card">
<h2>🏦 Owner Profit Withdrawal</h2>
<div class="row">
<div>
<label>Amount NGN</label>
<input id="wamount" type="number" min="1">
</div>
<div>
<label>Account Name</label>
<input id="wname">
</div>
<div>
<label>Account Number</label>
<input id="waccount" inputmode="numeric">
</div>
<div>
<label>Bank Code</label>
<input id="wbank" placeholder="Paystack bank code">
</div>
</div>
<button class="danger" style="margin-top:12px" onclick="withdraw()">Withdraw Profit</button>
<div id="wmsg" class="msg"></div>
</section>
<section class="card">
<h2>🎬 Jobs</h2>
<pre id="jobs" style="white-space:pre-wrap;max-height:400px;overflow:auto"></pre>
</section>
<section class="card">
<h2>⚠️ Errors</h2>
<pre id="errors" style="white-space:pre-wrap;max-height:400px;overflow:auto"></pre>
</section>
<section class="card">
<h2>🔐 Security Events</h2>
<pre id="security" style="white-space:pre-wrap;max-height:400px;overflow:auto"></pre>
</section>
<section class="card">
<h2>💳 Payments</h2>
<pre id="payments" style="white-space:pre-wrap;max-height:400px;overflow:auto"></pre>
</section>
</section>
</main>
<script>
let token = localStorage.getItem("mamaki_admin_token") || "";
const $ = (id) => document.getElementById(id);
function hdr(){
return {
"Content-Type":"application/json",
Accept:"application/json",
Authorization:"Bearer "+token
};
}
async function get(url){
const r = await fetch(url,{
headers:{
Accept:"application/json",
Authorization:"Bearer "+token
},
cache:"no-store"
});
const text = await r.text();
let data={};
try{
data = text ? JSON.parse(text) : {};
}catch{
throw new Error("Server returned invalid JSON (HTTP "+r.status+").");
}
if(!r.ok || !data.ok){
throw new Error(data.message || data.error || "Request failed.");
}
return data;
}
function set(id,value){
if($(id)) $(id).textContent=String(value ?? "—");
}
function money(n){
return "₦"+Number(n||0).toLocaleString();
}
async function login(){
const button =
document.querySelector('#login button.primary');
if(button) button.disabled=true;
$("msg").textContent="";
try{
const email=String($("email").value||"").trim().toLowerCase();
const password=String($("password").value||"");
if(!email || !password){
throw new Error("Enter the administrator email and password.");
}
const response=await fetch("/api/admin/login",{
method:"POST",
headers:{
"Content-Type":"application/json",
Accept:"application/json",
},
body:JSON.stringify({email,password}),
cache:"no-store",
});
const text=await response.text();
let data={};
try{
data=JSON.parse(text);
}catch{
throw new Error(
"Server returned an invalid response (HTTP "+response.status+"). Refresh the page and try again."
);
}
if(!response.ok || !data.ok){
throw new Error(
data.message ||
data.error ||
"Administrator login failed."
);
}
if(!data.token){
throw new Error(
"Login succeeded but no administrator session token was returned."
);
}
token=data.token;
localStorage.setItem("mamaki_admin_token",token);
$("msg").textContent="Login successful. Loading dashboard…";
await loadAll(true);
}catch(error){
localStorage.removeItem(
"mamaki_admin_token"
);
token="";
$("login").classList.remove(
"hidden"
);
$("dash").classList.add(
"hidden"
);
$("actions").classList.add(
"hidden"
);
$("msg").textContent =
error?.message ||
"Administrator login failed.";
}finally{
if(button) button.disabled=false;
}
}
async function logout(){
try{
await fetch(
"/api/auth/logout",
{
method:"POST",
headers:hdr(),
}
);
}catch{}
localStorage.removeItem(
"mamaki_admin_token"
);
location.reload();
}
async function loadAll(
fromLogin = false
){
if(!token){
$("login").classList.remove(
"hidden"
);
$("dash").classList.add(
"hidden"
);
return;
}
try{
const [
statsData,
usersData,
jobsData,
errorsData,
securityData,
creditsData,
financeData,
billingData,
] = await Promise.all([
get("/api/admin/stats"),
get("/api/admin/users"),
get("/api/admin/jobs"),
get("/api/admin/errors"),
get("/api/admin/security"),
get("/api/admin/credits"),
get("/api/admin/finance"),
get("/api/admin/billing"),
]);
$("login").classList.add(
"hidden"
);
$("dash").classList.remove(
"hidden"
);
$("actions").classList.remove(
"hidden"
);
const st =
statsData.stats;
const users =
usersData.users || [];
set(
"users",
st.totalUsers
);
set(
"active",
users.filter(
(x) =>
!x.disabled &&
x.lastActiveAt &&
Date.now() -
Date.parse(
x.lastActiveAt
) <
15 *
60 *
1000
).length
);
set(
"today",
users.filter(
(x) =>
Date.now() -
Date.parse(
x.createdAt ||
0
) <
86400000
).length
);
set(
"week",
users.filter(
(x) =>
Date.now() -
Date.parse(
x.createdAt ||
0
) <
7 *
86400000
).length
);
set(
"month",
users.filter(
(x) =>
Date.now() -
Date.parse(
x.createdAt ||
0
) <
30 *
86400000
).length
);
set(
"admins",
users.filter(
(x) =>
x.role ===
"admin"
).length
);
set(
"videos",
st.aiGenerations
);
set(
"seconds",
st.aiSeconds
);
set(
"narrations",
st.narrationJobs
);
set(
"projects",
st.totalProjects
);
const jobs =
jobsData.jobs || [];
set(
"completed",
jobs.filter(
(x) =>
x.status ===
"completed"
).length
);
set(
"processing",
jobs.filter(
(x) =>
[
"queued",
"processing",
].includes(
x.status
)
).length
);
set(
"failed",
jobs.filter(
(x) =>
x.status ===
"failed"
).length
);
set(
"recovery",
st.recoveryConfigured
? "Configured"
: "Not configured"
);
set(
"uptime",
Math.floor(
Number(
st.uptime || 0
)
)+"s"
);
const rep =
await get("/api/health");
set(
"repstatus",
rep.checks?.replicateConfigured
? "Configured"
: "Not configured"
);
set(
"aiavail",
rep.checks?.replicateConfigured
? "Available"
: "Unavailable"
);
set(
"rep",
"Not exposed"
);
set(
"t2v",
"",
);
set(
"i2v",
"",
);
$("repnote").textContent =
"Replicate token configured. Account balance is not exposed by this server endpoint.";
const finance =
financeData.finance ||
{};
const wallet =
billingData.wallet ||
{};
set(
"gross",
money(
finance.revenue
)
);
set(
"refunds",
money(
finance.refunds
)
);
const costs =
Number(
finance.providerCosts ||
0
) +
Number(
finance.fees ||
0
) +
Number(
finance.otherExpenses ||
0
);
set(
"costs",
money(
costs
)
);
set(
"profit",
money(
wallet.profit
)
);
set(
"withdrawn",
money(
wallet.withdrawn
)
);
set(
"pending",
money(
wallet.pendingWithdrawals
)
);
set(
"available",
money(
wallet.availableToWithdraw
)
);
const revenue =
Number(
finance.revenue ||
0
);
const profit =
Number(
wallet.profit ||
0
);
set(
"margin",
(
revenue > 0
?
((profit / revenue) * 100)
: 0
).toFixed(1)+"%"
);
const pricing =
billingData.pricing || {};
set(
"paystatus",
billingData.paystackConfigured
? "Configured"
: "Not configured"
);
set(
"fx",
Number(
pricing.fx?.rates?.NGN || 0
).toFixed(2)
);
set(
"fxnote",
pricing.fx?.live
? "Live"
: "Fallback"
);
set(
"targetmargin",
(
Number(
pricing.packages?.[0]?.marginTarget || 0
) * 100
).toFixed(0)+"%"
);
set(
"markup",
"₦"+Number(
pricing.fixedMarkupPerUsd || 0
).toLocaleString()
);
set(
"soldcredits",
creditsData.soldCredits || 0
);
set(
"issued",
creditsData.issued || 0
);
set(
"consumed",
creditsData.consumed || 0
);
set(
"crefund",
creditsData.refunded || 0
);
set(
"credits",
creditsData.current || 0
);
set(
"usable",
creditsData.usable || 0
);
$("utable").innerHTML =
users
.map(
(x) =>
`<tr>
<td>${escapeHtml(x.name || "")}</td>
<td>${escapeHtml(x.email || "")}</td>
<td>${escapeHtml(x.role || "")}</td>
<td>${Number(x.credits||0).toLocaleString()}</td>
<td>${Number(x.usage?.aiGenerations||0).toLocaleString()}</td>
<td>${Number(x.usage?.aiSeconds||0).toLocaleString()}</td>
<td>${Number(x.usage?.studioJobs||0).toLocaleString()}</td>
<td>${Number(x.usage?.narrationJobs||0).toLocaleString()}</td>
<td>${escapeHtml(x.lastActiveAt || "")}</td>
<td>${x.disabled ? "Disabled":"Active"}</td>
</tr>`
)
.join("");
$("jobs").textContent =
JSON.stringify(
jobs,
null,
2
);
$("errors").textContent =
JSON.stringify(
errorsData.errors || [],
null,
2
);
$("security").textContent =
JSON.stringify(
securityData.events || [],
null,
2
);
$("payments").textContent =
JSON.stringify(
billingData.payments || [],
null,
2
);
}catch(error){
localStorage.removeItem(
"mamaki_admin_token"
);
token="";
$("login").classList.remove(
"hidden"
);
$("dash").classList.add(
"hidden"
);
$("actions").classList.add(
"hidden"
);
$("msg").textContent =
error?.message ||
"Unable to load administrator dashboard.";
}
}
function escapeHtml(value){
return String(value ?? "")
.replace(/&/g,"&amp;")
.replace(/</g,"&lt;")
.replace(/>/g,"&gt;")
.replace(/"/g,"&quot;")
.replace(/'/g,"&#039;");
}
async function adjustCredits(){
const userId =
String(
$("uid").value || ""
).trim();
const amount =
Number(
$("amount").value
);
if(!userId || !Number.isFinite(amount)){
$("cmsg").textContent="Enter a valid user ID and credit amount.";
return;
}
try{
const r =
await fetch(
"/api/admin/users/"+encodeURIComponent(userId)+"/credits",
{
method:"POST",
headers:hdr(),
body:JSON.stringify({amount}),
}
);
const d =
await r.json();
if(!r.ok || !d.ok){
throw new Error(
d.message ||
d.error ||
"Credit adjustment failed."
);
}
$("cmsg").textContent =
"Credits updated: "+
Number(d.credits||0).toLocaleString();
await loadAll();
}catch(error){
$("cmsg").textContent =
error.message;
}
}
async function finance(){
const type =
$("ftype").value;
const amount =
Number(
$("famount").value
);
const description =
String(
$("fdesc").value ||
""
);
try{
const r =
await fetch(
"/api/admin/finance",
{
method:"POST",
headers:hdr(),
body:JSON.stringify({
type,
amount,
description,
}),
}
);
const d =
await r.json();
if(!r.ok || !d.ok){
throw new Error(
d.message ||
d.error ||
"Finance entry failed."
);
}
$("fmsg").textContent =
"Finance transaction recorded.";
await loadAll();
}catch(error){
$("fmsg").textContent =
error.message;
}
}
async function withdraw(){
const amount =
Number(
$("wamount").value
);
const name =
String(
$("wname").value ||
""
);
const accountNumber =
String(
$("waccount").value ||
""
);
const bankCode =
String(
$("wbank").value ||
""
);
try{
const r =
await fetch(
"/api/admin/withdraw",
{
method:"POST",
headers:hdr(),
body:JSON.stringify({
amount,
name,
accountNumber,
bankCode,
}),
}
);
const d =
await r.json();
if(!r.ok || !d.ok){
throw new Error(
d.message ||
d.error ||
"Withdrawal failed."
);
}
$("wmsg").textContent =
d.message ||
"Profit withdrawal submitted.";
await loadAll();
}catch(error){
$("wmsg").textContent =
error.message;
}
}
$("login").classList.remove(
"hidden"
);
$("dash").classList.add(
"hidden"
);
$("actions").classList.remove(
"hidden"
);
if(token){
loadAll();
}
</script>
</main>
</body>
</html>`);
});
/* ========================================================= PUBLIC INTERFACE ENHANCEMENTS
========================================================= */
function publicEnhancementHtml() {
return `
<style id="mamaki-public-enhancements">
#mamaki-credit-launcher{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.18);background:rgba(16,16,24,.96);color:#fff;padding:12px 16px;border-radius:999px;box-shadow:0 16px 50px rgba(0,0,0,.35);font:700 14px/1.2 Arial,sans-serif;cursor:pointer;backdrop-filter:blur(12px)}
#mamaki-credit-launcher:hover{transform:translateY(-1px)}
#mamaki-public-modal{position:fixed;inset:0;z-index:2147482999;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(0,0,0,.72);font-family:Arial,sans-serif}
#mamaki-public-modal.show{display:flex}
.mamaki-public-card{width:min(720px,100%);max-height:min(88vh,850px);overflow:auto;background:#0c0c14;color:#fff;border:1px solid #2b2b3b;border-radius:22px;padding:22px;box-shadow:0 24px 90px rgba(0,0,0,.55)}
.mamaki-public-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.mamaki-public-head h2{margin:0 0 6px;font-size:22px}.mamaki-public-muted{color:#a7a7b8;font-size:13px}.mamaki-public-close{width:auto!important;padding:8px 11px!important;border-radius:10px!important;background:#171722!important;color:#fff;border:1px solid #343448!important;font-size:18px!important;cursor:pointer}
.mamaki-public-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:18px}.mamaki-public-package{border:1px solid #2f2f42;border-radius:16px;padding:16px;background:#12121b}.mamaki-public-package strong{display:block;font-size:20px}.mamaki-public-package button{margin-top:12px;width:100%;padding:11px 13px;border-radius:11px;border:1px solid #fff;background:#fff;color:#07070b;font-weight:800;cursor:pointer}.mamaki-public-package button:disabled{opacity:.55;cursor:not-allowed}.mamaki-public-msg{min-height:22px;margin-top:14px;font-size:13px;color:#ddd}.mamaki-public-balance{margin-top:12px;padding:12px 14px;border-radius:12px;background:#11111a;border:1px solid #2a2a3c}.mamaki-public-field{display:block;width:100%;margin-top:10px;padding:12px 13px;border-radius:11px;border:1px solid #36364b;background:#090910;color:#fff;outline:none}.mamaki-public-primary{width:100%;padding:12px 14px;border-radius:11px;border:1px solid #fff;background:#fff;color:#08080d;font-weight:800;cursor:pointer;margin-top:12px}.mamaki-public-secondary{width:100%;padding:10px 14px;border-radius:11px;border:1px solid #353549;background:#171721;color:#fff;font-weight:700;cursor:pointer;margin-top:8px}.mamaki-public-link{display:inline-block;margin-top:9px;color:#fff;text-decoration:underline;cursor:pointer;font-size:13px}.mamaki-public-success{color:#8ff0b0}.mamaki-public-error{color:#ff9b9b}
@media(max-width:640px){#mamaki-credit-launcher{right:10px;bottom:10px;font-size:13px;padding:11px 13px}.mamaki-public-card{padding:17px;border-radius:18px}.mamaki-public-grid{grid-template-columns:1fr}}
</style>
<button id="mamaki-credit-launcher" type="button" aria-label="Buy MAMAKI AI Credits">🪙 Buy MAMAKI AI Credits</button>
<div id="mamaki-public-modal" aria-hidden="true">
<div class="mamaki-public-card" role="dialog" aria-modal="true" aria-labelledby="mamaki-public-title">
<div class="mamaki-public-head">
<div>
<h2 id="mamaki-public-title">🪙 Buy MAMAKI AI Credits</h2>
<div class="mamaki-public-muted">Choose a package and pay securely with Paystack.</div>
</div>
<button class="mamaki-public-close" id="mamaki-public-close" type="button" aria-label="Close">×</button>
</div>
<div id="mamaki-public-balance" class="mamaki-public-balance">Checking your account…</div>
<div id="mamaki-public-packages" class="mamaki-public-grid"></div>
<div id="mamaki-public-msg" class="mamaki-public-msg"></div>
</div>
</div>
<div id="mamaki-recovery-modal" aria-hidden="true" style="display:none;position:fixed;inset:0;z-index:2147483001;align-items:center;justify-content:center;padding:18px;background:rgba(0,0,0,.75);font-family:Arial,sans-serif">
<div class="mamaki-public-card" role="dialog" aria-modal="true" aria-labelledby="mamaki-recovery-title">
<div class="mamaki-public-head">
<div>
<h2 id="mamaki-recovery-title">🔐 MAMAKI Password Recovery</h2>
<div class="mamaki-public-muted" id="mamaki-recovery-subtitle">Reset your MAMAKI account password.</div>
</div>
<button class="mamaki-public-close" id="mamaki-recovery-close" type="button" aria-label="Close">×</button>
</div>
<div id="mamaki-recovery-form-area">
<input id="mamaki-recovery-email" class="mamaki-public-field" type="email" autocomplete="email" placeholder="Enter your account email">
<button id="mamaki-recovery-send" class="mamaki-public-primary" type="button">Send reset link</button>
<div id="mamaki-recovery-msg" class="mamaki-public-msg"></div>
</div>
<div id="mamaki-reset-form-area" style="display:none">
<input id="mamaki-reset-password" class="mamaki-public-field" type="password" autocomplete="new-password" placeholder="New password (6+ characters)">
<input id="mamaki-reset-password2" class="mamaki-public-field" type="password" autocomplete="new-password" placeholder="Confirm new password">
<button id="mamaki-reset-submit" class="mamaki-public-primary" type="button">Reset password</button>
<div id="mamaki-reset-msg" class="mamaki-public-msg"></div>
</div>
</div>
</div>
<script id="mamaki-public-enhancement-script">
(function(){
"use strict";
const $ = (id) => document.getElementById(id);
const modal = $("mamaki-public-modal");
const recoveryModal = $("mamaki-recovery-modal");
const msg = $("mamaki-public-msg");
const recoveryMsg = $("mamaki-recovery-msg");
const resetMsg = $("mamaki-reset-msg");
let packages = [];
let currentToken = "";
let recoveryToken = "";
function setText(el, value){ if(el) el.textContent = String(value || ""); }
function setRecoveryVisible(show){
if(!recoveryModal) return;
recoveryModal.style.display = show ? "flex" : "none";
recoveryModal.setAttribute("aria-hidden", show ? "false" : "true");
}
function setBuyVisible(show){
if(!modal) return;
modal.classList.toggle("show", !!show);
modal.setAttribute("aria-hidden", show ? "false" : "true");
}
function likelyToken(value){
const v=String(value||"").trim();
return v.length >= 20 && v.length <= 500 && !v.startsWith("{") && !v.startsWith("[");
}
function tokenCandidates(){
const out=[];
const seen=new Set();
const add=(v)=>{
if(likelyToken(v)&&!seen.has(v)){
seen.add(v);
out.push(v);
}
};
for(const storage of [window.localStorage,window.sessionStorage]){
try{
for(let i=0;i<storage.length;i++){
const key=String(storage.key(i)||"");
const value=storage.getItem(key)||"";
if(/token|auth|session|mamaki/i.test(key)) add(value);
try{
const obj=JSON.parse(value);
if(obj && typeof obj === "object"){
add(obj.token);
add(obj.accessToken);
add(obj.sessionToken);
}
}catch{}
}
}catch{}
}
return out.slice(0,30);
}
function rememberToken(token){
currentToken=String(token||"");
if(!currentToken) return;
try{localStorage.setItem("mamaki_token",currentToken);}catch{}
}
function clearKnownTokens(){
currentToken="";
for(const storage of [window.localStorage,window.sessionStorage]){
try{
const keys=[];
for(let i=0;i<storage.length;i++){
const key=String(storage.key(i)||"");
if(/token|auth|session/i.test(key)) keys.push(key);
}
keys.forEach(k=>{
try{storage.removeItem(k);}catch{}
});
}catch{}
}
}
async function api(path, options={}, tokenOverride=""){
const headers=Object.assign({Accept:"application/json"}, options.headers||{});
const token=tokenOverride || currentToken;
if(token) headers.Authorization="Bearer "+token;
const response=await fetch(path,Object.assign({},options,{headers,cache:"no-store"}));
const text=await response.text();
let data={};
try{
data=text?JSON.parse(text):{};
}catch{
throw new Error("Server returned an invalid response (HTTP "+response.status+").");
}
if(!response.ok || data.ok===false){
const error=new Error(data.message||data.error||("Request failed (HTTP "+response.status+")."));
error.status=response.status;
error.data=data;
throw error;
}
return data;
}
async function discoverAuth(){
if(likelyToken(currentToken)){
try{
const data=await api("/api/auth/me",{},currentToken);
return data;
}catch{
currentToken="";
}
}
for(const candidate of tokenCandidates()){
try{
const data=await api("/api/auth/me",{},candidate);
rememberToken(candidate);
return data;
}catch{}
}
return null;
}
function money(amount,currency){
try{
return new Intl.NumberFormat(
"en-NG",
{
style:"currency",
currency:currency||"NGN",
maximumFractionDigits:0
}
).format(Number(amount||0));
}catch{
return "₦"+Number(amount||0).toLocaleString();
}
}
async function loadPricing(){
const data=await api("/api/billing/pricing");
packages=Array.isArray(data.packages)?data.packages:[];
const wrap=$("mamaki-public-packages");
if(!wrap) return;
wrap.innerHTML="";
if(!packages.length){
setText(msg,"No credit packages are currently available.");
return;
}
for(const item of packages){
const box=document.createElement("div");
box.className="mamaki-public-package";
const strong=document.createElement("strong");
strong.textContent=Number(item.credits).toLocaleString()+" credits";
const small=document.createElement("div");
small.className="mamaki-public-muted";
small.textContent=money(item.amount,item.currency||data.currency||"NGN");
const btn=document.createElement("button");
btn.type="button";
btn.textContent="Buy now";
btn.addEventListener("click",()=>startPurchase(item.credits,btn));
box.append(strong,small,btn);
wrap.appendChild(box);
}
}
async function refreshBalance(){
const el=$("mamaki-public-balance");
const user=await discoverAuth();
if(user){
setText(
el,
"Current balance: "+
Number(user.credits||0).toLocaleString()+
" MAMAKI credits · "+
(user.user?.email||"")
);
}else{
setText(
el,
"Please log in to purchase credits. Your current credit balance will appear here after login."
);
}
return user;
}
async function openBuy(){
setText(msg,"");
setBuyVisible(true);
try{
await refreshBalance();
await loadPricing();
}catch(error){
setText(msg,error.message);
}
}
async function startPurchase(credits, button){
setText(msg,"");
const user=await discoverAuth();
if(!user){
setText(
msg,
"Please log in to your MAMAKI account first, then open Buy MAMAKI AI Credits again."
);
return;
}
if(button) button.disabled=true;
try{
const data=await api(
"/api/billing/paystack/initialize",
{
method:"POST",
headers:{
"Content-Type":"application/json"
},
body:JSON.stringify({
credits:Number(credits)
})
}
);
if(!data.authorizationUrl){
throw new Error(
"Paystack did not return a payment link."
);
}
setText(
msg,
"Opening secure Paystack checkout…"
);
window.location.href=data.authorizationUrl;
}catch(error){
setText(
msg,
error.message||"Unable to start payment."
);
}finally{
if(button) button.disabled=false;
}
}
function openRecovery(token){
setText(recoveryMsg,"");
setText(resetMsg,"");
recoveryToken=String(token||"");
const requestArea=$("mamaki-recovery-form-area");
const resetArea=$("mamaki-reset-form-area");
if(recoveryToken){
requestArea.style.display="none";
resetArea.style.display="block";
setText(
$("mamaki-recovery-subtitle"),
"Create a new password. This reset link expires after 30 minutes."
);
}else{
requestArea.style.display="block";
resetArea.style.display="none";
let email="";
try{
const possible=document.querySelectorAll('input[type="email"]');
for(const input of possible){
if(input.value){
email=input.value;
break;
}
}
}catch{}
$("mamaki-recovery-email").value=email;
setText(
$("mamaki-recovery-subtitle"),
"Enter the email used for your MAMAKI account."
);
}
setRecoveryVisible(true);
}
async function sendRecovery(){
const email=String(
$("mamaki-recovery-email").value||""
).trim().toLowerCase();
setText(recoveryMsg,"");
if(!email){
setText(recoveryMsg,"Enter your account email.");
return;
}
const button=$("mamaki-recovery-send");
button.disabled=true;
try{
const data=await api(
"/api/auth/forgot-password",
{
method:"POST",
headers:{
"Content-Type":"application/json"
},
body:JSON.stringify({email})
}
);
setText(
recoveryMsg,
data.message||
"If the email exists, reset instructions have been sent."
);
}catch(error){
setText(
recoveryMsg,
error.message||
"Unable to process password recovery."
);
}finally{
button.disabled=false;
}
}
async function resetPassword(){
const p=String(
$("mamaki-reset-password").value||""
);
const p2=String(
$("mamaki-reset-password2").value||""
);
setText(resetMsg,"");
if(p.length<6){
setText(
resetMsg,
"Password must contain at least 6 characters."
);
return;
}
if(p!==p2){
setText(
resetMsg,
"The passwords do not match."
);
return;
}
const button=$("mamaki-reset-submit");
button.disabled=true;
try{
const data=await api(
"/api/auth/reset-password",
{
method:"POST",
headers:{
"Content-Type":"application/json"
},
body:JSON.stringify({
token:recoveryToken,
password:p
})
}
);
setText(
resetMsg,
data.message||"Password updated successfully."
);
resetMsg.className="mamaki-public-msg mamaki-public-success";
clearKnownTokens();
setTimeout(()=>{
window.location.href=window.location.pathname;
},900);
}catch(error){
resetMsg.className="mamaki-public-msg mamaki-public-error";
setText(
resetMsg,
error.message||"Unable to reset your password."
);
}finally{
button.disabled=false;
}
}
async function checkPayment(){
const reference =
new URLSearchParams(
window.location.search
).get("payment");
if(!reference) return;
const user=await discoverAuth();
if(!user) return;
setBuyVisible(true);
setText(
msg,
"Checking your Paystack payment…"
);
try{
await loadPricing();
}catch{}
for(let i=0;i<8;i++){
try{
const data=await api(
"/api/billing/payment/"+
encodeURIComponent(reference)
);
const payment=data.payment||{};
if(
payment.status==="success" ||
payment.fulfilledAt
){
const latest=await discoverAuth();
setText(
msg,
"Payment successful. "+
Number(payment.credits||0).toLocaleString()+
" credits have been added to your account."
);
setText(
$("mamaki-public-balance"),
"Current balance: "+
Number(latest?.credits||0).toLocaleString()+
" MAMAKI credits · "+
(latest?.user?.email||"")
);
return;
}
}catch{}
await new Promise(
resolve=>setTimeout(resolve,1800)
);
}
setText(
msg,
"Payment is still being confirmed. Your credits will be added automatically when Paystack confirms the transaction. You can close this window and continue using MAMAKI."
);
}
function wireForgot(){
const buttons=document.querySelectorAll('button,a');
let found=false;
buttons.forEach((el)=>{
const text=String(
el.textContent||""
).toLowerCase();
if(
text.includes("forgot") &&
text.includes("password")
){
found=true;
if(!el.dataset.mamakiRecovery){
el.dataset.mamakiRecovery="1";
el.addEventListener(
"click",
(event)=>{
event.preventDefault();
openRecovery("");
}
);
}
}
});
if(!found){
const link=document.createElement("a");
link.href="#";
link.className="mamaki-public-link";
link.textContent="Forgot password?";
link.addEventListener(
"click",
(event)=>{
event.preventDefault();
openRecovery("");
}
);
const passwordInput=
document.querySelector(
'input[type="password"]'
);
if(
passwordInput &&
passwordInput.parentElement
) {
passwordInput.parentElement.appendChild(
link
);
}else{
document.body.appendChild(
link
);
}
}
}
window.MAMAKI={
openBuyCredits:openBuy,
forgotPassword:()=>openRecovery("")
};
document.addEventListener(
"click",
(event)=>{
if(
event.target===
$("mamaki-public-close")
){
setBuyVisible(false);
}
if(
event.target===
$("mamaki-recovery-close")
){
setRecoveryVisible(false);
}
if(
event.target===modal
){
setBuyVisible(false);
}
if(
event.target===recoveryModal
){
setRecoveryVisible(false);
}
}
);
$("mamaki-credit-launcher")?.addEventListener(
"click",
openBuy
);
$("mamaki-recovery-send")?.addEventListener(
"click",
sendRecovery
);
$("mamaki-reset-submit")?.addEventListener(
"click",
resetPassword
);
const params=
new URLSearchParams(
window.location.search
);
window.addEventListener(
"load",
async()=>{
wireForgot();
const reset=params.get(
"reset"
);
if(reset) openRecovery(reset);
await checkPayment();
}
);
})();
</script>
`;
}
/* ========================================================= ROOT
========================================================= */
app.get(
"/",
async (req, res) => {
try {
const file =
await fs.readFile(
path.join(
ROOT,
"index.html"
),
"utf8"
);
const enhancement =
publicEnhancementHtml();
const lower =
file.toLowerCase();
const bodyIndex =
lower.lastIndexOf(
"</body>"
);
if (bodyIndex >= 0) {
const page =
file.slice(0, bodyIndex) +
enhancement +
file.slice(bodyIndex);
return res
.type("html")
.send(page);
}
return res
.type("html")
.send(file + enhancement);
} catch (error) {
await recordError(
error,
{
route: "/",
}
);
res.status(500).type("html").send(
`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAMAKI AI</title></head><body style="font-family:Arial,sans-serif;padding:24px"><h1>MAMAKI AI</h1><p>Unable to load the public interface. Make sure index.html is present in the project.</p></body></html>`
);
}
});
app.use(
(req, res) => {
res.status(404).json({
ok: false,
error:
"NOT_FOUND",
message:
"MAMAKI endpoint not found.",
});
});
app.use(
async (
err,
req,
res,
next
) => {
await recordError(
err,
{
route:
req.originalUrl,
method:
req.method,
}
);
if(
res.headersSent
){
return next(err);
}
res.status(
err?.status ||
500
).json({
ok: false,
error:
err?.code ||
"SERVER_ERROR",
message:
err?.message ||
"MAMAKI encountered an unexpected server error.",
});
});
setInterval(
() => {
const now =
Date.now();
for (
const [
id,
job,
] of jobs.entries()
) {
const finished =
job.status ===
"completed" ||
job.status ===
"failed";
const time =
Date.parse(
job.completedAt ||
job.createdAt ||
""
);
if (
finished &&
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
},
10 *
60 *
1000
);
await ensureStorage();
await ensureAdminAccount();
app.listen(
PORT,
HOST,
() => {
console.log(
` ✨  MAMAKI AI v${VERSION} running on ${HOST}:${PORT}`
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
