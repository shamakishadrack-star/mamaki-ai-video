import express from "express";
import multer from "multer";
import Replicate from "replicate";
import { EdgeTTS } from "edge-tts-universal";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const VERSION = "13.0.0";

const ROOT = process.cwd();
const TMP = path.join(ROOT, "tmp");
const OUTPUTS = path.join(ROOT, "outputs");
const PROJECTS = path.join(ROOT, "projects");
const DATA = path.join(ROOT, "data");

const USERS_FILE = path.join(DATA, "users.json");
const SESSIONS_FILE = path.join(DATA, "sessions.json");
const ERRORS_FILE = path.join(DATA, "errors.json");
const USAGE_FILE = path.join(DATA, "usage.json");

const T2V_MODEL =
  process.env.T2V_MODEL || "wan-video/wan-2.2-t2v-fast";

const I2V_MODEL =
  process.env.I2V_MODEL || "wan-video/wan-2.2-i2v-fast";

const MAX_DURATION = 7200;
const MIN_DURATION = 5;

const ADMIN_EMAIL =
  String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();

const ADMIN_PASSWORD =
  String(process.env.ADMIN_PASSWORD || "");

const SESSION_SECRET =
  String(process.env.SESSION_SECRET || "");

const REPLICATE_API_TOKEN =
  String(process.env.REPLICATE_API_TOKEN || "").trim();

const replicate = REPLICATE_API_TOKEN
  ? new Replicate({
      auth: REPLICATE_API_TOKEN,
    })
  : null;

const jobs = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

app.use((req, res, next) => {
  res.setHeader("X-MAMAKI-Version", VERSION);
  res.setHeader("X-Content-Type-Options", "nosniff");
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

function normalizeDuration(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 5;
  }

  return Math.max(
    MIN_DURATION,
    Math.min(MAX_DURATION, Math.round(n))
  );
}

function normalizeRatio(value) {
  const v = String(value || "16:9");

  if (["16:9", "9:16", "1:1"].includes(v)) {
    return v;
  }

  return "16:9";
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
  return Number(seconds) <= 5 ? 81 : 121;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeFileName(name, fallback = "file") {
  const base = path.basename(String(name || fallback));

  return base
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 150);
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

function verifyPassword(password, salt, expectedHash) {
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

    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function createToken() {
  const random = randomBytes(32).toString("hex");

  const secretPart = SESSION_SECRET
    ? scryptSync(
        SESSION_SECRET,
        random.slice(0, 16),
        32
      ).toString("hex")
    : "";

  return `${random}.${secretPart}`;
}

async function createSession(userId, role = "user") {
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

  if (!header.toLowerCase().startsWith("bearer ")) {
    return "";
  }

  return header.slice(7).trim();
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

  const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

  if (
    Date.now() - Number(session.createdAt || 0) >
    MAX_AGE
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

  const user = users[session.userId];

  if (!user || user.disabled) {
    return null;
  }

  return {
    ...user,
    sessionRole: session.role,
  };
}

async function requireUser(req, res, next) {
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

async function requireAdmin(req, res, next) {
  const user = await getCurrentUser(req);

  if (
    !user ||
    user.role !== "admin"
  ) {
    return res.status(403).json({
      ok: false,
      error: "ADMIN_REQUIRED",
      message: "Administrator access required.",
    });
  }

  req.user = user;

  next();
}

async function recordError(error, context = {}) {
  try {
    const errors = await readJson(
      ERRORS_FILE,
      {}
    );

    const id = randomUUID();

    errors[id] = {
      id,
      createdAt: new Date().toISOString(),
      message: String(
        error?.message || error || "Unknown error"
      ).slice(0, 2000),
      code: String(
        error?.code || ""
      ).slice(0, 100),
      context,
    };

    const ids = Object.keys(errors);

    if (ids.length > 500) {
      const sorted = ids
        .map(id => ({
          id,
          time: errors[id].createdAt || "",
        }))
        .sort((a, b) =>
          String(a.time).localeCompare(
            String(b.time)
          )
        );

      while (sorted.length > 500) {
        const old = sorted.shift();

        if (old) {
          delete errors[old.id];
        }
      }
    }

    await writeJson(
      ERRORS_FILE,
      errors
    );
  } catch {
    // Logging must never crash the application.
  }
}

async function recordUsage(userId, type, seconds = 0) {
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
    usage[userId].aiSeconds += Number(seconds || 0);
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
      code: "REPLICATE_CREDIT_REQUIRED",
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
      code: "REPLICATE_AUTH_REQUIRED",
      message:
        "Replicate authentication is missing or invalid. Check REPLICATE_API_TOKEN in Render.",
    };
  }

  if (
    text.includes("403") ||
    text.includes("forbidden")
  ) {
    return {
      code: "REPLICATE_FORBIDDEN",
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
      code: "REPLICATE_RATE_LIMIT",
      message:
        "Replicate rate limit reached. Please wait and try again.",
    };
  }

  return {
    code: "REPLICATE_GENERATION_FAILED",
    message:
      "Replicate could not start or complete the AI generation.",
  };
}

async function downloadToFile(url, destination) {
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

async function downloadReplicateOutput(output, destination) {
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

  if (
    Buffer.isBuffer(output)
  ) {
    await fs.writeFile(
      destination,
      output
    );

    return destination;
  }

  if (
    output instanceof Uint8Array
  ) {
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
        chunk => {
          stderr += chunk.toString();
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
            const error =
              new Error(
                `FFmpeg failed with code ${code}: ${stderr.slice(-4000)}`
              );

            error.code = "FFMPEG_FAILED";

            reject(error);
          }
        }
      );
    }
  );
}

async function addWatermark(input, output) {
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
  const duration =
    Math.max(1, Number(seconds));

  await runFFmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=220:sample_rate=44100:duration=${duration}`,
    "-af",
    "volume=0.035,afade=t=in:st=0:d=1,afade=t=out:st=" +
      Math.max(0, duration - 1) +
      ":d=1",
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
    .map(file =>
      `file '${file.replace(/'/g, "'\\''")}'`
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
    await fs.unlink(listFile).catch(() => {});
  }

  return output;
}

function splitIntoScenes(
  script,
  targetSeconds
) {
  const text = cleanText(script, 30000);

  if (!text) {
    return [];
  }

  const chunks = text
    .split(
      /(?<=[.!?])\s+|\n+/
    )
    .map(x => x.trim())
    .filter(Boolean);

  const maxScenes = Math.ceil(
    targetSeconds / 5
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
    "",
    `Visual style: ${style}.`,
    "Create a coherent professional video sequence.",
    "Use strong composition, natural motion, consistent subjects, realistic lighting, cinematic depth and detailed environments.",
    "Maintain continuity between shots.",
    "Avoid text overlays, logos and unwanted distortions.",
    "Use smooth camera movement appropriate to the scene.",
  ].join(" ");
}

async function wanTextToVideo(
  prompt,
  seconds,
  ratio,
  quality
) {
  if (!replicate) {
    const error =
      new Error(
        "REPLICATE_API_TOKEN is not configured."
      );

    error.code =
      "REPLICATE_AUTH_REQUIRED";

    throw error;
  }

  const frames =
    wanFrames(seconds);

  const enhanced =
    `${prompt}\n\nOutput requirements: ${ratio} aspect ratio, professional ${quality || "standard"} quality.`;

  const input = {
    prompt: enhanced,
    num_frames: frames,
    aspect_ratio: ratio,
  };

  try {
    const result =
      await replicate.run(
        T2V_MODEL,
        { input }
      );

    return result;
  } catch (error) {
    const classified =
      classifyReplicateError(error);

    error.code =
      classified.code;

    error.mamakiMessage =
      classified.message;

    throw error;
  }
}

async function wanImageToVideo(
  prompt,
  imageBuffer,
  seconds,
  ratio,
  quality
) {
  if (!replicate) {
    const error =
      new Error(
        "REPLICATE_API_TOKEN is not configured."
      );

    error.code =
      "REPLICATE_AUTH_REQUIRED";

    throw error;
  }

  const frames =
    wanFrames(seconds);

  const base64 =
    imageBuffer.toString("base64");

  const dataUri =
    `data:image/jpeg;base64,${base64}`;

  const input = {
    prompt:
      `${prompt}\n\nCreate coherent motion from the supplied reference image. Aspect ratio ${ratio}. Quality ${quality || "standard"}.`,
    image: dataUri,
    num_frames: frames,
    aspect_ratio: ratio,
  };

  try {
    const result =
      await replicate.run(
        I2V_MODEL,
        { input }
      );

    return result;
  } catch (error) {
    const classified =
      classifyReplicateError(error);

    error.code =
      classified.code;

    error.mamakiMessage =
      classified.message;

    throw error;
  }
}

async function generateVideoProduction({
  job,
  userId,
  prompt,
  imageBuffer,
  duration,
  ratio,
  style,
  quality,
}) {
  const scenes =
    splitIntoScenes(
      prompt,
      duration
    );

  if (!scenes.length) {
    throw new Error(
      "Please describe the video you want to create."
    );
  }

  const sceneDuration =
    duration <= 5
      ? 5
      : 5;

  const files = [];

  job.totalScenes =
    scenes.length;

  for (
    let i = 0;
    i < scenes.length;
    i++
  ) {
    if (job.cancelled) {
      throw new Error(
        "Production cancelled."
      );
    }

    job.currentScene =
      i + 1;

    job.progress = Math.round(
      (i /
        scenes.length) *
        75
    );

    const scenePrompt =
      enhancePrompt(
        scenes[i],
        style
      );

    const rawFile = path.join(
      TMP,
      `${job.id}-scene-${i}.mp4`
    );

    let output;

    if (imageBuffer && i === 0) {
      output =
        await wanImageToVideo(
          scenePrompt,
          imageBuffer,
          sceneDuration,
          ratio,
          quality
        );
    } else {
      output =
        await wanTextToVideo(
          scenePrompt,
          sceneDuration,
          ratio,
          quality
        );
    }

    await downloadReplicateOutput(
      output,
      rawFile
    );

    files.push(rawFile);

    job.progress = Math.round(
      ((i + 1) /
        scenes.length) *
        75
    );
  }

  const combined =
    path.join(
      OUTPUTS,
      `${job.id}-combined.mp4`
    );

  await combineVideoFiles(
    files,
    combined
  );

  job.progress = 82;

  const durationFile =
    path.join(
      OUTPUTS,
      `${job.id}-duration.mp4`
    );

  await forceDuration(
    combined,
    durationFile,
    duration
  );

  job.progress = 88;

  const music =
    path.join(
      TMP,
      `${job.id}-music.m4a`
    );

  await createSoftMusic(
    music,
    duration
  );

  const audioFile =
    path.join(
      OUTPUTS,
      `${job.id}-audio.mp4`
    );

  await attachAudio(
    durationFile,
    music,
    audioFile
  );

  job.progress = 93;

  const final =
    path.join(
      OUTPUTS,
      `${job.id}.mp4`
    );

  await addWatermark(
    audioFile,
    final
  );

  job.progress = 100;

  await recordUsage(
    userId,
    "ai",
    duration
  );

  return final;
}

async function cleanupJobFiles(jobId) {
  const names = [
    `${jobId}-combined.mp4`,
    `${jobId}-duration.mp4`,
    `${jobId}-audio.mp4`,
    `${jobId}-music.m4a`,
    `${jobId}.mp4`,
  ];

  for (const name of names) {
    await fs
      .unlink(
        path.join(
          OUTPUTS,
          name
        )
      )
      .catch(() => {});
  }

  const tmpEntries =
    await fs
      .readdir(TMP)
      .catch(() => []);

  for (const name of tmpEntries) {
    if (
      name.startsWith(`${jobId}-`)
    ) {
      await fs
        .unlink(
          path.join(
            TMP,
            name
          )
        )
        .catch(() => {});
    }
  }
}

async function saveProjectForUser(
  userId,
  project
) {
  const id =
    project.id ||
    randomUUID();

  const file =
    path.join(
      PROJECTS,
      `${id}.json`
    );

  const record = {
    ...project,
    id,
    userId,
    updatedAt:
      new Date().toISOString(),
    createdAt:
      project.createdAt ||
      new Date().toISOString(),
  };

  await fs.writeFile(
    file,
    JSON.stringify(
      record,
      null,
      2
    ),
    "utf8"
  );

  return record;
}

async function getAllProjects() {
  const files =
    await fs
      .readdir(PROJECTS)
      .catch(() => []);

  const result = [];

  for (const name of files) {
    if (!name.endsWith(".json")) {
      continue;
    }

    try {
      const data =
        JSON.parse(
          await fs.readFile(
            path.join(
              PROJECTS,
              name
            ),
            "utf8"
          )
        );

      result.push(data);
    } catch {}
  }

  return result;
}

/* =========================================================
   BASIC SYSTEM
========================================================= */

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    service: "MAMAKI AI Video Creative Studio",
    version: VERSION,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/status", async (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    ai: {
      configured: Boolean(
        REPLICATE_API_TOKEN
      ),
      t2vModel: T2V_MODEL,
      i2vModel: I2V_MODEL,
    },
    features: {
      textToVideo: true,
      imageToVideo: true,
      autopilot: true,
      photoToVideo: true,
      videoTrim: true,
      combineVideos: true,
      narration: true,
      subtitles: true,
      promptEnhancement: true,
      socialPresets: true,
      accounts: true,
      projects: true,
      admin: Boolean(
        ADMIN_EMAIL &&
        ADMIN_PASSWORD
      ),
      watermark: "MAMAKI ✨",
    },
  });
});

/* =========================================================
   AUTHENTICATION
========================================================= */

app.post("/api/auth/register", async (req, res) => {
  try {
    const name =
      cleanText(
        req.body.name,
        100
      );

    const email =
      cleanText(
        req.body.email,
        200
      ).toLowerCase();

    const password =
      String(
        req.body.password || ""
      );

    if (
      !name ||
      !email ||
      !password
    ) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_INPUT",
        message:
          "Name, email and password are required.",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "WEAK_PASSWORD",
        message:
          "Password must contain at least 6 characters.",
      });
    }

    const users =
      await readJson(
        USERS_FILE,
        {}
      );

    const existing =
      Object.values(users)
        .find(
          user =>
            String(user.email)
              .toLowerCase() ===
            email
        );

    if (existing) {
      return res.status(409).json({
        ok: false,
        error: "EMAIL_EXISTS",
        message:
          "An account with this email already exists.",
      });
    }

    const id =
      randomUUID();

    const credentials =
      hashPassword(
        password
      );

    users[id] = {
      id,
      name,
      email,
      salt:
        credentials.salt,
      passwordHash:
        credentials.hash,
      role: "user",
      disabled: false,
      createdAt:
        new Date().toISOString(),
      lastLoginAt: null,
    };

    await writeJson(
      USERS_FILE,
      users
    );

    const token =
      await createSession(
        id,
        "user"
      );

    res.status(201).json({
      ok: true,
      message:
        "MAMAKI account created successfully.",
      token,
      user: {
        id,
        name,
        email,
        role: "user",
      },
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
      error: "REGISTER_FAILED",
      message:
        "Unable to create the account.",
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email =
      cleanText(
        req.body.email,
        200
      ).toLowerCase();

    const password =
      String(
        req.body.password || ""
      );

    const users =
      await readJson(
        USERS_FILE,
        {}
      );

    const user =
      Object.values(users)
        .find(
          item =>
            String(item.email)
              .toLowerCase() ===
            email
        );

    if (
      !user ||
      !verifyPassword(
        password,
        user.salt,
        user.passwordHash
      )
    ) {
      return res.status(401).json({
        ok: false,
        error: "INVALID_LOGIN",
        message:
          "Incorrect email or password.",
      });
    }

    if (user.disabled) {
      return res.status(403).json({
        ok: false,
        error: "ACCOUNT_DISABLED",
        message:
          "This MAMAKI account has been disabled.",
      });
    }

    user.lastLoginAt =
      new Date().toISOString();

    users[user.id] =
      user;

    await writeJson(
      USERS_FILE,
      users
    );

    const token =
      await createSession(
        user.id,
        user.role || "user"
      );

    res.json({
      ok: true,
      message:
        "Login successful.",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role:
          user.role || "user",
      },
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
      error: "LOGIN_FAILED",
      message:
        "Unable to complete login.",
    });
  }
});

app.post("/api/auth/logout", async (req, res) => {
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
    message:
      "Logged out successfully.",
  });
});

app.get("/api/auth/me", async (req, res) => {
  const user =
    await getCurrentUser(req);

  if (!user) {
    return res.status(401).json({
      ok: false,
      authenticated: false,
    });
  }

  res.json({
    ok: true,
    authenticated: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt:
        user.createdAt,
    },
  });
});

/* =========================================================
   PERSONAL ACCOUNT
========================================================= */

app.get(
  "/api/account",
  requireUser,
  async (req, res) => {
    const usage =
      await readJson(
        USAGE_FILE,
        {}
      );

    const mine =
      usage[req.user.id] || {
        aiGenerations: 0,
        aiSeconds: 0,
        studioJobs: 0,
        narrationJobs: 0,
      };

    res.json({
      ok: true,
      account: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        createdAt:
          req.user.createdAt,
      },
      usage: mine,
      limits: {
        maximumProductionSeconds:
          MAX_DURATION,
        freeStudio: true,
      },
    });
  }
);

app.put(
  "/api/account/profile",
  requireUser,
  async (req, res) => {
    const users =
      await readJson(
        USERS_FILE,
        {}
      );

    const user =
      users[req.user.id];

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "USER_NOT_FOUND",
      });
    }

    const name =
      cleanText(
        req.body.name,
        100
      );

    if (name) {
      user.name = name;
    }

    users[user.id] =
      user;

    await writeJson(
      USERS_FILE,
      users
    );

    res.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  }
);

/* =========================================================
   AI PROMPT ENHANCEMENT
========================================================= */

app.post(
  "/api/ai/enhance",
  async (req, res) => {
    const prompt =
      cleanText(
        req.body.prompt,
        5000
      );

    const style =
      cleanText(
        req.body.style ||
          "Cinematic",
        100
      );

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error: "PROMPT_REQUIRED",
      });
    }

    const enhanced =
      enhancePrompt(
        prompt,
        style
      );

    res.json({
      ok: true,
      original: prompt,
      enhanced,
      style,
    });
  }
);

/* =========================================================
   AI VIDEO GENERATION
========================================================= */

app.post(
  "/api/generate",
  upload.single("image"),
  async (req, res) => {
    try {
      const user =
        await getCurrentUser(req);

      if (!user) {
        return res.status(401).json({
          ok: false,
          error: "AUTH_REQUIRED",
          message:
            "Log in to your MAMAKI account before starting AI production.",
        });
      }

      if (!REPLICATE_API_TOKEN) {
        return res.status(503).json({
          ok: false,
          error:
            "REPLICATE_AUTH_REQUIRED",
          message:
            "AI generation is not configured. Add REPLICATE_API_TOKEN to the Render environment variables.",
        });
      }

      const prompt =
        cleanText(
          req.body.prompt,
          30000
        );

      const style =
        cleanText(
          req.body.style ||
            "Cinematic",
          100
        );

      const duration =
        normalizeDuration(
          req.body.duration
        );

      const ratio =
        normalizeRatio(
          req.body.ratio ||
            req.body.format
        );

      const quality =
        cleanText(
          req.body.quality ||
            "Standard HD",
          100
        );

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error:
            "PROMPT_REQUIRED",
          message:
            "Describe the video you want to create.",
        });
      }

      const jobId =
        randomUUID();

      const job = {
        id: jobId,
        userId: user.id,
        status: "queued",
        progress: 0,
        message:
          "Production queued.",
        createdAt:
          new Date().toISOString(),
        duration,
        ratio,
        style,
        quality,
        cancelled: false,
      };

      jobs.set(
        jobId,
        job
      );

      res.status(202).json({
        ok: true,
        jobId,
        status: "queued",
        progress: 0,
        message:
          "Production started.",
      });

      setImmediate(
        async () => {
          try {
            job.status =
              "processing";

            job.message =
              "MAMAKI AI Director is planning your production.";

            const final =
              await generateVideoProduction({
                job,
                userId: user.id,
                prompt,
                imageBuffer:
                  req.file?.buffer ||
                  null,
                duration,
                ratio,
                style,
                quality,
              });

            job.status =
              "completed";

            job.progress = 100;

            job.message =
              "Production completed successfully.";

            job.video =
              `/api/video/${path.basename(final)}`;

            job.completedAt =
              new Date().toISOString();
          } catch (error) {
            const classified =
              error.mamakiMessage
                ? {
                    code:
                      error.code ||
                      "GENERATION_FAILED",
                    message:
                      error.mamakiMessage,
                  }
                : classifyReplicateError(
                    error
                  );

            job.status =
              "failed";

            job.progress = 0;

            job.error =
              classified.code;

            job.message =
              classified.message;

            await recordError(
              error,
              {
                route:
                  "/api/generate",
                jobId,
                userId:
                  user.id,
              }
            );

            await cleanupJobFiles(
              jobId
            );
          }
        }
      );
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/generate",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "GENERATION_START_FAILED",
        message:
          "Unable to start production.",
      });
    }
  }
);

app.get(
  "/api/jobs/:id",
  async (req, res) => {
    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return res.status(404).json({
        ok: false,
        error: "JOB_NOT_FOUND",
        message:
          "Production job was not found.",
      });
    }

    const user =
      await getCurrentUser(req);

    if (
      job.userId &&
      (!user ||
        user.id !== job.userId)
    ) {
      return res.status(403).json({
        ok: false,
        error: "JOB_ACCESS_DENIED",
      });
    }

    res.json({
      ok: true,
      job: {
        id: job.id,
        status: job.status,
        progress:
          job.progress,
        message:
          job.message,
        video:
          job.video || null,
        error:
          job.error || null,
        currentScene:
          job.currentScene || null,
        totalScenes:
          job.totalScenes || null,
      },
    });
  }
);

/* =========================================================
   VIDEO DELIVERY
========================================================= */

app.get(
  "/api/video/:file",
  async (req, res) => {
    const file =
      safeFileName(
        req.params.file,
        ""
      );

    if (!file.endsWith(".mp4")) {
      return res.status(400).send(
        "Invalid video."
      );
    }

    const full =
      path.join(
        OUTPUTS,
        file
      );

    try {
      await fs.access(full);

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Cache-Control",
        "private, max-age=3600"
      );

      res.sendFile(full);
    } catch {
      res.status(404).send(
        "Video not found."
      );
    }
  }
);

/* =========================================================
   PROJECT WORKSPACE
========================================================= */

app.get(
  "/api/projects",
  requireUser,
  async (req, res) => {
    const all =
      await getAllProjects();

    const mine =
      all.filter(
        project =>
          project.userId ===
          req.user.id
      );

    res.json({
      ok: true,
      projects:
        mine.sort(
          (a, b) =>
            String(
              b.updatedAt || ""
            ).localeCompare(
              String(
                a.updatedAt || ""
              )
            )
        ),
    });
  }
);

app.get(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    const file =
      path.join(
        PROJECTS,
        `${safeFileName(
          req.params.id
        )}.json`
      );

    try {
      const project =
        JSON.parse(
          await fs.readFile(
            file,
            "utf8"
          )
        );

      if (
        project.userId !==
        req.user.id
      ) {
        return res.status(403).json({
          ok: false,
          error:
            "PROJECT_ACCESS_DENIED",
        });
      }

      res.json({
        ok: true,
        project,
      });
    } catch {
      res.status(404).json({
        ok: false,
        error:
          "PROJECT_NOT_FOUND",
      });
    }
  }
);

app.post(
  "/api/projects/save",
  requireUser,
  async (req, res) => {
    try {
      const project =
        await saveProjectForUser(
          req.user.id,
          {
            ...req.body,
            userId:
              req.user.id,
          }
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
            "/api/projects/save",
          userId:
            req.user.id,
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "PROJECT_SAVE_FAILED",
        message:
          "Unable to save project.",
      });
    }
  }
);

app.delete(
  "/api/projects/:id",
  requireUser,
  async (req, res) => {
    const id =
      safeFileName(
        req.params.id
      );

    const file =
      path.join(
        PROJECTS,
        `${id}.json`
      );

    try {
      const project =
        JSON.parse(
          await fs.readFile(
            file,
            "utf8"
          )
        );

      if (
        project.userId !==
        req.user.id
      ) {
        return res.status(403).json({
          ok: false,
          error:
            "PROJECT_ACCESS_DENIED",
        });
      }

      await fs.unlink(
        file
      );

      res.json({
        ok: true,
        message:
          "Project deleted.",
      });
    } catch {
      res.status(404).json({
        ok: false,
        error:
          "PROJECT_NOT_FOUND",
      });
    }
  }
);

/* =========================================================
   PHOTO -> VIDEO
========================================================= */

app.post(
  "/api/studio/photo-video",
  upload.array("photos", 50),
  async (req, res) => {
    try {
      const user =
        await getCurrentUser(req);

      const photos =
        req.files || [];

      if (!photos.length) {
        return res.status(400).json({
          ok: false,
          error:
            "PHOTOS_REQUIRED",
          message:
            "Add at least one photo.",
        });
      }

      const seconds =
        normalizeDuration(
          req.body.seconds ||
            req.body.duration ||
            5
        );

      const ratio =
        normalizeRatio(
          req.body.ratio
        );

      const id =
        randomUUID();

      const clips = [];

      for (
        let i = 0;
        i < photos.length;
        i++
      ) {
        const image =
          path.join(
            TMP,
            `${id}-${i}.jpg`
          );

        const clip =
          path.join(
            TMP,
            `${id}-${i}.mp4`
          );

        await fs.writeFile(
          image,
          photos[i].buffer
        );

        await runFFmpeg([
          "-y",
          "-loop",
          "1",
          "-i",
          image,
          "-t",
          String(seconds),
          "-vf",
          `scale=${ratioSize(
            ratio
          )}:force_original_aspect_ratio=decrease,pad=${ratioSize(
            ratio
          )}:(ow-iw)/2:(oh-ih)/2`,
          "-r",
          "30",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          clip,
        ]);

        clips.push(clip);
      }

      const combined =
        path.join(
          OUTPUTS,
          `${id}-combined.mp4`
        );

      await combineVideoFiles(
        clips,
        combined
      );

      let final =
        combined;

      if (
        req.file ||
        req.body.music
      ) {
        // Reserved for future uploaded-music workflow.
      }

      const watermarked =
        path.join(
          OUTPUTS,
          `${id}.mp4`
        );

      await addWatermark(
        final,
        watermarked
      );

      if (user) {
        await recordUsage(
          user.id,
          "studio",
          photos.length *
            seconds
        );
      }

      res.json({
        ok: true,
        video:
          `/api/video/${path.basename(
            watermarked
          )}`,
        duration:
          photos.length *
          seconds,
        ratio,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/studio/photo-video",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "PHOTO_VIDEO_FAILED",
        message:
          "Unable to create the photo video.",
      });
    }
  }
);

/* =========================================================
   VIDEO TRIMMER
========================================================= */

app.post(
  "/api/studio/trim",
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "VIDEO_REQUIRED",
        });
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
            req.body.duration ||
              5
          )
        );

      const id =
        randomUUID();

      const input =
        path.join(
          TMP,
          `${id}-input.mp4`
        );

      const trimmed =
        path.join(
          OUTPUTS,
          `${id}-trimmed.mp4`
        );

      const final =
        path.join(
          OUTPUTS,
          `${id}.mp4`
        );

      await fs.writeFile(
        input,
        req.file.buffer
      );

      await runFFmpeg([
        "-y",
        "-ss",
        String(start),
        "-i",
        input,
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
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        trimmed,
      ]);

      await addWatermark(
        trimmed,
        final
      );

      const user =
        await getCurrentUser(req);

      if (user) {
        await recordUsage(
          user.id,
          "studio",
          duration
        );
      }

      res.json({
        ok: true,
        video:
          `/api/video/${path.basename(
            final
          )}`,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/studio/trim",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "TRIM_FAILED",
        message:
          "Unable to trim the video.",
      });
    }
  }
);

/* =========================================================
   COMBINE VIDEOS
========================================================= */

app.post(
  "/api/studio/combine",
  upload.array("videos", 50),
  async (req, res) => {
    try {
      const videos =
        req.files || [];

      if (
        videos.length < 2
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "TWO_VIDEOS_REQUIRED",
          message:
            "Add at least two videos.",
        });
      }

      const id =
        randomUUID();

      const inputs = [];

      for (
        let i = 0;
        i < videos.length;
        i++
      ) {
        const file =
          path.join(
            TMP,
            `${id}-${i}.mp4`
          );

        await fs.writeFile(
          file,
          videos[i].buffer
        );

        inputs.push(file);
      }

      const combined =
        path.join(
          OUTPUTS,
          `${id}-combined.mp4`
        );

      const final =
        path.join(
          OUTPUTS,
          `${id}.mp4`
        );

      await combineVideoFiles(
        inputs,
        combined
      );

      await addWatermark(
        combined,
        final
      );

      const user =
        await getCurrentUser(req);

      if (user) {
        await recordUsage(
          user.id,
          "studio",
          0
        );
      }

      res.json({
        ok: true,
        video:
          `/api/video/${path.basename(
            final
          )}`,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/studio/combine",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "COMBINE_FAILED",
        message:
          "Unable to combine the videos.",
      });
    }
  }
);

/* =========================================================
   VOICE & NARRATION
========================================================= */

app.post(
  "/api/studio/narration",
  async (req, res) => {
    try {
      const text =
        cleanText(
          req.body.text,
          10000
        );

      const voice =
        cleanText(
          req.body.voice ||
            "en-US-AriaNeural",
          200
        );

      if (!text) {
        return res.status(400).json({
          ok: false,
          error:
            "NARRATION_TEXT_REQUIRED",
        });
      }

      const id =
        randomUUID();

      const output =
        path.join(
          OUTPUTS,
          `${id}.mp3`
        );

      const tts =
        new EdgeTTS(
          text,
          voice
        );

      await tts.save(
        output
      );

      const user =
        await getCurrentUser(req);

      if (user) {
        await recordUsage(
          user.id,
          "narration",
          0
        );
      }

      res.json({
        ok: true,
        audio:
          `/api/audio/${path.basename(
            output
          )}`,
        voice,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/studio/narration",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "NARRATION_FAILED",
        message:
          "Unable to create narration with the configured voice service.",
      });
    }
  }
);

app.get(
  "/api/audio/:file",
  async (req, res) => {
    const file =
      safeFileName(
        req.params.file
      );

    if (!file.endsWith(".mp3")) {
      return res.status(400).send(
        "Invalid audio."
      );
    }

    const full =
      path.join(
        OUTPUTS,
        file
      );

    try {
      await fs.access(full);

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      res.sendFile(full);
    } catch {
      res.status(404).send(
        "Audio not found."
      );
    }
  }
);

/* =========================================================
   SUBTITLES
========================================================= */

app.post(
  "/api/studio/subtitles",
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "VIDEO_REQUIRED",
        });
      }

      const subtitles =
        cleanText(
          req.body.subtitles,
          30000
        );

      if (!subtitles) {
        return res.status(400).json({
          ok: false,
          error:
            "SUBTITLES_REQUIRED",
          message:
            "Provide subtitle text in SRT/VTT format.",
        });
      }

      const id =
        randomUUID();

      const input =
        path.join(
          TMP,
          `${id}-input.mp4`
        );

      const subtitleFile =
        path.join(
          TMP,
          `${id}.srt`
        );

      const subtitled =
        path.join(
          OUTPUTS,
          `${id}-subtitled.mp4`
        );

      const final =
        path.join(
          OUTPUTS,
          `${id}.mp4`
        );

      await fs.writeFile(
        input,
        req.file.buffer
      );

      let srt =
        subtitles;

      if (
        subtitles
          .toLowerCase()
          .includes("webvtt")
      ) {
        srt =
          subtitles
            .replace(
              /^WEBVTT\s*/i,
              ""
            )
            .replace(
              /\./g,
              ","
            );
      }

      await fs.writeFile(
        subtitleFile,
        srt,
        "utf8"
      );

      const escaped =
        subtitleFile
          .replace(/\\/g, "\\\\")
          .replace(/:/g, "\\:")
          .replace(/'/g, "\\'");

      await runFFmpeg([
        "-y",
        "-i",
        input,
        "-vf",
        `subtitles='${escaped}'`,
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
        subtitled,
      ]);

      await addWatermark(
        subtitled,
        final
      );

      res.json({
        ok: true,
        video:
          `/api/video/${path.basename(
            final
          )}`,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/studio/subtitles",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "SUBTITLE_FAILED",
        message:
          "Unable to burn subtitles into the video.",
      });
    }
  }
);

/* =========================================================
   SOCIAL PRESETS
========================================================= */

app.post(
  "/api/studio/social",
  upload.single("video"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error:
            "VIDEO_REQUIRED",
        });
      }

      const ratio =
        normalizeRatio(
          req.body.ratio
        );

      const id =
        randomUUID();

      const input =
        path.join(
          TMP,
          `${id}-input.mp4`
        );

      const resized =
        path.join(
          OUTPUTS,
          `${id}-resized.mp4`
        );

      const final =
        path.join(
          OUTPUTS,
          `${id}.mp4`
        );

      await fs.writeFile(
        input,
        req.file.buffer
      );

      await resizeVideo(
        input,
        resized,
        ratio
      );

      await addWatermark(
        resized,
        final
      );

      res.json({
        ok: true,
        ratio,
        video:
          `/api/video/${path.basename(
            final
          )}`,
      });
    } catch (error) {
      await recordError(
        error,
        {
          route:
            "/api/studio/social",
        }
      );

      res.status(500).json({
        ok: false,
        error:
          "SOCIAL_EXPORT_FAILED",
        message:
          "Unable to create the social preset export.",
      });
    }
  }
);

/* =========================================================
   ADMIN
========================================================= */

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
      cleanText(
        req.body.email,
        200
      ).toLowerCase();

    const password =
      String(
        req.body.password || ""
      );

    if (
      email !==
        ADMIN_EMAIL ||
      password !==
        ADMIN_PASSWORD
    ) {
      return res.status(401).json({
        ok: false,
        error:
          "INVALID_ADMIN_LOGIN",
        message:
          "Invalid administrator credentials.",
      });
    }

    const users =
      await readJson(
        USERS_FILE,
        {}
      );

    let admin =
      Object.values(users)
        .find(
          user =>
            user.email ===
            ADMIN_EMAIL
        );

    if (!admin) {
      const id =
        randomUUID();

      const credentials =
        hashPassword(
          ADMIN_PASSWORD
        );

      admin = {
        id,
        name: "MAMAKI Administrator",
        email:
          ADMIN_EMAIL,
        salt:
          credentials.salt,
        passwordHash:
          credentials.hash,
        role: "admin",
        disabled: false,
        createdAt:
          new Date().toISOString(),
        lastLoginAt: null,
      };

      users[id] =
        admin;

      await writeJson(
        USERS_FILE,
        users
      );
    }

    const token =
      await createSession(
        admin.id,
        "admin"
      );

    res.json({
      ok: true,
      token,
      admin: {
        id: admin.id,
        email:
          admin.email,
        role: "admin",
      },
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
        {}
      );

    const usage =
      await readJson(
        USAGE_FILE,
        {}
      );

    const projects =
      await getAllProjects();

    const userList =
      Object.values(users);

    let aiGenerations = 0;
    let aiSeconds = 0;
    let studioJobs = 0;
    let narrationJobs = 0;

    for (const item of Object.values(
      usage
    )) {
      aiGenerations +=
        Number(
          item.aiGenerations || 0
        );

      aiSeconds +=
        Number(
          item.aiSeconds || 0
        );

      studioJobs +=
        Number(
          item.studioJobs || 0
        );

      narrationJobs +=
        Number(
          item.narrationJobs || 0
        );
    }

    const jobList =
      Array.from(
        jobs.values()
      );

    const failedJobs =
      jobList.filter(
        job =>
          job.status ===
          "failed"
      ).length;

    res.json({
      ok: true,
      stats: {
        version: VERSION,
        totalUsers:
          userList.length,
        activeUsers:
          userList.filter(
            user =>
              !user.disabled
          ).length,
        disabledUsers:
          userList.filter(
            user =>
              user.disabled
          ).length,
        totalProjects:
          projects.length,
        aiGenerations,
        aiSeconds,
        studioJobs,
        narrationJobs,
        jobsInMemory:
          jobList.length,
        failedJobs,
        replicateConfigured:
          Boolean(
            REPLICATE_API_TOKEN
          ),
        uptime:
          process.uptime(),
      },
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
        {}
      );

    const usage =
      await readJson(
        USAGE_FILE,
        {}
      );

    const list =
      Object.values(users)
        .map(user => ({
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
          usage:
            usage[user.id] || {
              aiGenerations: 0,
              aiSeconds: 0,
              studioJobs: 0,
              narrationJobs: 0,
            },
        }));

    res.json({
      ok: true,
      users: list,
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
        {}
      );

    const usage =
      await readJson(
        USAGE_FILE,
        {}
      );

    const user =
      users[
        req.params.id
      ];

    if (!user) {
      return res.status(404).json({
        ok: false,
        error:
          "USER_NOT_FOUND",
      });
    }

    const projects =
      (
        await getAllProjects()
      ).filter(
        project =>
          project.userId ===
          user.id
      );

    res.json({
      ok: true,
      user: {
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
      },
      usage:
        usage[user.id] || {},
      projects,
    });
  }
);

app.post(
  "/api/admin/users/:id/disable",
  requireAdmin,
  async (req, res) => {
    const users =
      await readJson(
        USERS_FILE,
        {}
      );

    const user =
      users[
        req.params.id
      ];

    if (!user) {
      return res.status(404).json({
        ok: false,
        error:
          "USER_NOT_FOUND",
      });
    }

    user.disabled =
      Boolean(
        req.body.disabled !==
          undefined
          ? req.body.disabled
          : true
      );

    users[user.id] =
      user;

    await writeJson(
      USERS_FILE,
      users
    );

    res.json({
      ok: true,
      user: {
        id: user.id,
        disabled:
          user.disabled,
      },
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
        ).map(job => ({
          id: job.id,
          userId:
            job.userId,
          status:
            job.status,
          progress:
            job.progress,
          message:
            job.message,
          createdAt:
            job.createdAt,
          completedAt:
            job.completedAt ||
            null,
          error:
            job.error ||
            null,
        })),
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

    const list =
      Object.values(errors)
        .sort(
          (a, b) =>
            String(
              b.createdAt
            ).localeCompare(
              String(
                a.createdAt
              )
            )
        )
        .slice(0, 200);

    res.json({
      ok: true,
      errors: list,
    });
  }
);

/* =========================================================
   BUILT-IN ACCOUNT PAGE
========================================================= */

app.get(
  "/account",
  (req, res) => {
    res.type("html").send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI Account</title>
<style>
body{
  margin:0;
  font-family:Arial,sans-serif;
  background:#08090d;
  color:#fff;
}
main{
  max-width:900px;
  margin:40px auto;
  padding:20px;
}
.card{
  background:#12151d;
  border:1px solid #252a35;
  border-radius:18px;
  padding:24px;
  margin-bottom:20px;
}
button{
  padding:12px 18px;
  border:0;
  border-radius:10px;
  cursor:pointer;
}
input{
  width:100%;
  box-sizing:border-box;
  padding:12px;
  margin:7px 0;
  border-radius:8px;
  border:1px solid #333;
  background:#090b10;
  color:white;
}
.hidden{display:none}
.stat{
  font-size:28px;
  font-weight:bold;
}
</style>
</head>
<body>
<main>

<div class="card">
<h1>✨ MAMAKI AI</h1>
<p>Personal Account</p>
</div>

<div id="auth" class="card">
<h2>Login</h2>
<input id="email" placeholder="Email">
<input id="password" type="password" placeholder="Password">
<button onclick="login()">Login</button>
<p id="message"></p>
</div>

<div id="dashboard" class="hidden">

<div class="card">
<h2 id="name"></h2>
<p id="accountEmail"></p>
<button onclick="logout()">Logout</button>
</div>

<div class="card">
<h2>📊 Usage</h2>
<p>AI Generations</p>
<div id="generations" class="stat">0</div>
<p>AI Seconds</p>
<div id="seconds" class="stat">0</div>
<p>Free Studio Jobs</p>
<div id="studio" class="stat">0</div>
<p>Narration Jobs</p>
<div id="narration" class="stat">0</div>
</div>

<div class="card">
<h2>📁 My Projects</h2>
<div id="projects">Loading...</div>
</div>

</div>

</main>

<script>
let token = localStorage.getItem("mamaki_token");

async function api(url, options={}) {
  options.headers = {
    ...(options.headers || {}),
    ...(token ? {Authorization:"Bearer "+token} : {})
  };

  const response = await fetch(url, options);
  return response.json();
}

async function login(){
  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  const data = await api("/api/auth/login",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({email,password})
  });

  document.getElementById("message").textContent =
    data.message || "";

  if(data.ok){
    token = data.token;
    localStorage.setItem("mamaki_token", token);
    load();
  }
}

async function load(){
  const data = await api("/api/account");

  if(!data.ok){
    document.getElementById("auth").classList.remove("hidden");
    document.getElementById("dashboard").classList.add("hidden");
    return;
  }

  document.getElementById("auth").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");

  document.getElementById("name").textContent =
    "Welcome, " + data.account.name;

  document.getElementById("accountEmail").textContent =
    data.account.email;

  document.getElementById("generations").textContent =
    data.usage.aiGenerations || 0;

  document.getElementById("seconds").textContent =
    data.usage.aiSeconds || 0;

  document.getElementById("studio").textContent =
    data.usage.studioJobs || 0;

  document.getElementById("narration").textContent =
    data.usage.narrationJobs || 0;

  const projects = await api("/api/projects");

  if(projects.ok && projects.projects.length){
    document.getElementById("projects").innerHTML =
      projects.projects.map(p =>
        "<div class='card'><strong>"+
        (p.name || p.title || "MAMAKI Production")+
        "</strong><br>"+
        (p.video || "")+
        "</div>"
      ).join("");
  }else{
    document.getElementById("projects").textContent =
      "No projects yet.";
  }
}

async function logout(){
  await api("/api/auth/logout",{method:"POST"});
  localStorage.removeItem("mamaki_token");
  token = "";
  location.reload();
}

load();
</script>

</body>
</html>
`);
  }
);

/* =========================================================
   BUILT-IN ADMIN PAGE
========================================================= */

app.get(
  "/admin",
  (req, res) => {
    res.type("html").send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAMAKI AI Admin</title>
<style>
body{
  margin:0;
  font-family:Arial,sans-serif;
  background:#07080c;
  color:white;
}
main{
  max-width:1100px;
  margin:30px auto;
  padding:20px;
}
.card{
  background:#12151d;
  border:1px solid #272c38;
  border-radius:18px;
  padding:22px;
  margin-bottom:18px;
}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:14px;
}
.stat{
  font-size:30px;
  font-weight:bold;
}
input{
  display:block;
  width:100%;
  box-sizing:border-box;
  margin:8px 0;
  padding:12px;
  background:#080a0f;
  border:1px solid #333;
  color:#fff;
  border-radius:8px;
}
button{
  padding:12px 18px;
  border:0;
  border-radius:10px;
  cursor:pointer;
}
.hidden{display:none}
table{
  width:100%;
  border-collapse:collapse;
}
td,th{
  padding:10px;
  border-bottom:1px solid #292d37;
  text-align:left;
}
</style>
</head>
<body>
<main>

<div class="card">
<h1>✨ MAMAKI AI ADMIN</h1>
<p>Private platform control center</p>
</div>

<div id="login" class="card">
<h2>Administrator Login</h2>
<input id="email" placeholder="Admin email">
<input id="password" type="password" placeholder="Admin password">
<button onclick="login()">Login</button>
<p id="msg"></p>
</div>

<div id="dashboard" class="hidden">

<div class="grid">

<div class="card">
<p>Users</p>
<div id="users" class="stat">0</div>
</div>

<div class="card">
<p>Projects</p>
<div id="projects" class="stat">0</div>
</div>

<div class="card">
<p>AI Generations</p>
<div id="generations" class="stat">0</div>
</div>

<div class="card">
<p>AI Seconds</p>
<div id="seconds" class="stat">0</div>
</div>

<div class="card">
<p>Studio Jobs</p>
<div id="studio" class="stat">0</div>
</div>

<div class="card">
<p>Failed Jobs</p>
<div id="failed" class="stat">0</div>
</div>

</div>

<div class="card">
<h2>👥 Users</h2>
<div id="userTable">Loading...</div>
</div>

<div class="card">
<h2>🎬 Jobs</h2>
<div id="jobTable">Loading...</div>
</div>

<div class="card">
<h2>🚨 Errors</h2>
<div id="errorTable">Loading...</div>
</div>

</div>

</main>

<script>

let token = localStorage.getItem("mamaki_admin_token");

async function api(url, options={}){
  options.headers = {
    ...(options.headers || {}),
    ...(token ? {Authorization:"Bearer "+token} : {})
  };

  const response = await fetch(url, options);
  return response.json();
}

async function login(){

  const email =
    document.getElementById("email").value;

  const password =
    document.getElementById("password").value;

  const data =
    await api("/api/admin/login",{
      method:"POST",
      headers:{
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        email,
        password
      })
    });

  document.getElementById("msg").textContent =
    data.message || "";

  if(data.ok){

    token = data.token;

    localStorage.setItem(
      "mamaki_admin_token",
      token
    );

    loadDashboard();
  }
}

async function loadDashboard(){

  const stats =
    await api("/api/admin/stats");

  if(!stats.ok){
    document.getElementById("login")
      .classList.remove("hidden");

    document.getElementById("dashboard")
      .classList.add("hidden");

    return;
  }

  document.getElementById("login")
    .classList.add("hidden");

  document.getElementById("dashboard")
    .classList.remove("hidden");

  document.getElementById("users").textContent =
    stats.stats.totalUsers;

  document.getElementById("projects").textContent =
    stats.stats.totalProjects;

  document.getElementById("generations").textContent =
    stats.stats.aiGenerations;

  document.getElementById("seconds").textContent =
    stats.stats.aiSeconds;

  document.getElementById("studio").textContent =
    stats.stats.studioJobs;

  document.getElementById("failed").textContent =
    stats.stats.failedJobs;

  const users =
    await api("/api/admin/users");

  if(users.ok){

    document.getElementById("userTable").innerHTML =
      "<table><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>AI</th></tr>"+
      users.users.map(u =>
        "<tr>"+
        "<td>"+escapeHtml(u.name)+"</td>"+
        "<td>"+escapeHtml(u.email)+"</td>"+
        "<td>"+escapeHtml(u.role)+"</td>"+
        "<td>"+(u.disabled ? "Disabled":"Active")+"</td>"+
        "<td>"+(u.usage.aiGenerations || 0)+"</td>"+
        "</tr>"
      ).join("")+
      "</table>";
  }

  const jobs =
    await api("/api/admin/jobs");

  if(jobs.ok){

    document.getElementById("jobTable").innerHTML =
      jobs.jobs.length
      ? jobs.jobs.map(j =>
        "<div class='card'>"+
        "<strong>"+escapeHtml(j.id)+"</strong><br>"+
        "Status: "+escapeHtml(j.status)+
        "<br>Progress: "+j.progress+"%"+
        "<br>"+escapeHtml(j.message || "")+
        "</div>"
      ).join("")
      : "No active jobs.";
  }

  const errors =
    await api("/api/admin/errors");

  if(errors.ok){

    document.getElementById("errorTable").innerHTML =
      errors.errors.length
      ? errors.errors.slice(0,20).map(e =>
        "<div class='card'>"+
        "<strong>"+escapeHtml(e.code || "ERROR")+"</strong><br>"+
        escapeHtml(e.message || "")+
        "<br><small>"+escapeHtml(e.createdAt || "")+"</small>"+
        "</div>"
      ).join("")
      : "No recorded errors.";
  }
}

function escapeHtml(value){
  return String(value || "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

loadDashboard();

</script>

</body>
</html>
`);
  }
);

/* =========================================================
   ROOT
========================================================= */

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

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        "NOT_FOUND",
      message:
        "MAMAKI endpoint not found.",
    });
  }
);

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
  async (error, req, res, next) => {
    await recordError(
      error,
      {
        route:
          req.originalUrl,
        method:
          req.method,
      }
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      ok: false,
      error:
        "INTERNAL_SERVER_ERROR",
      message:
        "MAMAKI encountered an unexpected server error.",
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

    for (const [
      id,
      job,
    ] of jobs.entries()) {
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
        Number.isFinite(time) &&
        now - time >
          60 * 60 * 1000
      ) {
        jobs.delete(id);
      }
    }
  },
  10 * 60 * 1000
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
  }
);
