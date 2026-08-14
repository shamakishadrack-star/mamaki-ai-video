import express from "express";
import multer from "multer";
import Replicate from "replicate";
import { EdgeTTS } from "edge-tts-universal";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const TOKEN = String(process.env.REPLICATE_API_TOKEN || "").trim();

const replicate = TOKEN
  ? new Replicate({ auth: TOKEN })
  : null;

const T2V_MODEL = "wan-video/wan-2.5-t2v-fast";
const I2V_MODEL = "wan-video/wan-2.5-i2v";

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "public");
const TMP = path.join(ROOT, "tmp");
const OUTPUT = path.join(ROOT, "outputs");

await fs.mkdir(PUBLIC, { recursive: true });
await fs.mkdir(TMP, { recursive: true });
await fs.mkdir(OUTPUT, { recursive: true });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(PUBLIC));

app.get("/", async (req, res) => {
  const index = path.join(PUBLIC, "index.html");

  try {
    await fs.access(index);
    res.sendFile(index);
  } catch {
    res.status(404).send("MAMAKI interface not found.");
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 10
  }
});

function duration(value) {
  const n = Number(value || 5);
  if (!Number.isFinite(n)) return 5;
  return Math.max(5, Math.min(10, Math.round(n)));
}

function ratioSize(ratio) {
  if (ratio === "9:16") return "720x1280";
  if (ratio === "1:1") return "720x720";
  return "1280x720";
}

function isImage(file) {
  return file &&
    ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
}

function isAudio(file) {
  return file &&
    [
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/x-wav",
      "audio/mp4",
      "audio/aac",
      "audio/ogg",
      "audio/webm"
    ].includes(file.mimetype);
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      return reject(new Error("FFmpeg is unavailable."));
    }

    const p = spawn(ffmpegPath, args);
    let stderr = "";

    p.stderr.on("data", d => {
      stderr += d.toString();
    });

    p.on("error", reject);

    p.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-6000)));
    });
  });
}

async function downloadOutput(output) {
  let item = Array.isArray(output) ? output[0] : output;

  if (!item) {
    throw new Error("Replicate returned no video output.");
  }

  if (Buffer.isBuffer(item)) return item;

  if (item instanceof Uint8Array) {
    return Buffer.from(item);
  }

  if (typeof item.url === "function") {
    const response = await fetch(item.url());

    if (!response.ok) {
      throw new Error(
        `Video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  if (typeof item === "string") {
    const response = await fetch(item);

    if (!response.ok) {
      throw new Error(
        `Video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  throw new Error("Unsupported Replicate video output.");
}

async function replicateVideo(model, input) {
  if (!replicate) {
    throw new Error("REPLICATE_API_TOKEN is missing.");
  }

  console.log("MAMAKI: Creating Replicate prediction.");
  console.log("MODEL:", model);
  console.log("INPUT:", JSON.stringify(input));

  let prediction;

  try {
    prediction = await replicate.predictions.create({
      model,
      input
    });
  } catch (error) {
    const message =
      error?.response?.data?.detail ||
      error?.response?.data?.error ||
      error?.message ||
      String(error);

    throw new Error(`Replicate creation failed: ${message}`);
  }

  console.log("MAMAKI PREDICTION:", prediction.id);
  console.log("STATUS:", prediction.status);

  try {
    prediction = await replicate.wait(prediction);
  } catch (error) {
    const current = await replicate.predictions
      .get(prediction.id)
      .catch(() => null);

    const detail =
      current?.error ||
      error?.message ||
      String(error);

    throw new Error(
      `Prediction failed (${prediction.id}): ${detail}`
    );
  }

  console.log(
    "MAMAKI FINAL STATUS:",
    prediction.status
  );

  if (prediction.status !== "succeeded") {
    throw new Error(
      `Prediction ${prediction.id} ended with status ` +
      `${prediction.status}: ` +
      `${prediction.error || "Unknown Replicate error"}`
    );
  }

  return downloadOutput(prediction.output);
}

async function generateTextVideo(prompt, d, ratio) {
  const input = {
    prompt: String(prompt).trim(),
    duration: duration(d),
    size: ratioSize(ratio),
    negative_prompt:
      "blurry, distorted, flickering, deformed, low quality, bad anatomy",
    enable_prompt_expansion: true
  };

  return replicateVideo(T2V_MODEL, input);
}

async function generateImageVideo(
  imageBuffer,
  prompt,
  d,
  ratio
) {
  const input = {
    image: imageBuffer,
    prompt: String(prompt).trim(),
    duration: duration(d),
    resolution:
      ratio === "9:16"
        ? "720p"
        : ratio === "1:1"
          ? "720p"
          : "1080p"
  };

  return replicateVideo(I2V_MODEL, input);
}

async function makeVoice(text, output) {
  const tts = new EdgeTTS(
    String(text).trim(),
    "en-US-AriaNeural",
    {
      rate: "+0%",
      volume: "+0%",
      pitch: "+0Hz"
    }
  );

  const result = await tts.synthesize();

  if (!result?.audio) {
    throw new Error("Voice-over generation returned no audio.");
  }

  let buffer;

  if (Buffer.isBuffer(result.audio)) {
    buffer = result.audio;
  } else if (result.audio instanceof Uint8Array) {
    buffer = Buffer.from(result.audio);
  } else if (typeof result.audio.arrayBuffer === "function") {
    buffer = Buffer.from(await result.audio.arrayBuffer());
  } else {
    throw new Error("Unable to read generated voice-over.");
  }

  await fs.writeFile(output, buffer);
}

async function mixAudio(video, voice, music, effects, output) {
  const args = ["-y", "-i", video];
  const filters = [];
  const labels = [];

  let index = 1;

  if (voice) {
    args.push("-i", voice);
    filters.push(`[${index}:a]volume=1.0[v]`);
    labels.push("[v]");
    index++;
  }

  if (music) {
    args.push("-i", music);
    filters.push(`[${index}:a]volume=0.20[m]`);
    labels.push("[m]");
    index++;
  }

  if (effects) {
    args.push("-i", effects);
    filters.push(`[${index}:a]volume=0.45[e]`);
    labels.push("[e]");
  }

  if (!labels.length) {
    await fs.copyFile(video, output);
    return;
  }

  filters.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=2[aout]`
  );

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "0:v:0",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    output
  );

  await ffmpeg(args);
}

function srtTime(seconds) {
  const total = Math.floor(seconds);
  const ms = Math.floor((seconds % 1) * 1000);

  return (
    `${String(Math.floor(total / 3600)).padStart(2, "0")}:` +
    `${String(Math.floor(total / 60) % 60).padStart(2, "0")}:` +
    `${String(total % 60).padStart(2, "0")},` +
    `${String(ms).padStart(3, "0")}`
  );
}

function createSRT(text, seconds) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) return "";

  const chunk = 7;
  const wordTime = seconds / words.length;
  let result = "";

  for (let i = 0; i < words.length; i += chunk) {
    const part = words.slice(i, i + chunk);
    const start = i * wordTime;
    const end = Math.min(
      words.length,
      i + part.length
    ) * wordTime;

    result +=
      `${Math.floor(i / chunk) + 1}\n` +
      `${srtTime(start)} --> ${srtTime(end)}\n` +
      `${part.join(" ")}\n\n`;
  }

  return result;
}

async function subtitles(video, text, seconds, output) {
  const srtPath = path.join(
    TMP,
    `sub-${randomUUID()}.srt`
  );

  await fs.writeFile(
    srtPath,
    createSRT(text, seconds),
    "utf8"
  );

  const escaped = srtPath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:");

  try {
    await ffmpeg([
      "-y",
      "-i",
      video,
      "-vf",
      `subtitles=${escaped}:force_style='FontName=Arial,FontSize=20,Alignment=2,MarginV=45'`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      output
    ]);
  } finally {
    await fs.unlink(srtPath).catch(() => {});
  }
}

async function concat(videos, output) {
  if (videos.length === 1) {
    await fs.copyFile(videos[0], output);
    return;
  }

  const list = path.join(
    TMP,
    `list-${randomUUID()}.txt`
  );

  await fs.writeFile(
    list,
    videos
      .map(v => `file '${v.replace(/'/g, "'\\''")}'`)
      .join("\n")
  );

  try {
    await ffmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output
    ]);
  } finally {
    await fs.unlink(list).catch(() => {});
  }
}

app.post(
  "/api/generate",
  upload.fields([
    { name: "referenceImage", maxCount: 1 },
    { name: "music", maxCount: 1 },
    { name: "effects", maxCount: 1 }
  ]),
  async (req, res) => {
    const job = randomUUID();
    const jobDir = path.join(TMP, job);

    await fs.mkdir(jobDir, { recursive: true });

    try {
      if (!replicate) {
        return res.status(503).json({
          ok: false,
          error: "REPLICATE_API_TOKEN is missing on Render."
        });
      }

      const body = req.body || {};
      const files = req.files || {};

      const prompt = String(body.prompt || "").trim();

      const script = String(
        body.script ||
        body.voiceText ||
        ""
      ).trim();

      if (!prompt && !body.scenes) {
        return res.status(400).json({
          ok: false,
          error: "Enter a video prompt."
        });
      }

      let scenes = [];

      if (body.scenes) {
        try {
          scenes = JSON.parse(body.scenes);
        } catch {
          return res.status(400).json({
            ok: false,
            error: "Invalid scenes JSON."
          });
        }
      }

      if (!Array.isArray(scenes) || !scenes.length) {
        scenes = [
          {
            prompt,
            duration: body.duration || 5
          }
        ];
      }

      scenes = scenes.slice(0, 30);

      const ratio =
        body.ratio ||
        body.aspectRatio ||
        "9:16";

      const reference =
        files.referenceImage?.[0];

      if (reference && !isImage(reference)) {
        throw new Error(
          "Reference image must be JPG, PNG or WebP."
        );
      }

      const musicFile =
        files.music?.[0];

      const effectsFile =
        files.effects?.[0];

      if (musicFile && !isAudio(musicFile)) {
        throw new Error("Invalid background music.");
      }

      if (effectsFile && !isAudio(effectsFile)) {
        throw new Error("Invalid sound effects.");
      }

      const generated = [];

      for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];

        const scenePrompt =
          String(
            scene?.prompt ||
            prompt ||
            ""
          ).trim();

        if (!scenePrompt) continue;

        const sceneDuration =
          duration(
            scene?.duration ||
            body.duration ||
            5
          );

        console.log(
          `MAMAKI: Generating scene ${i + 1}/${scenes.length}`
        );

        const buffer =
          reference
            ? await generateImageVideo(
                reference.buffer,
                scenePrompt,
                sceneDuration,
                ratio
              )
            : await generateTextVideo(
                scenePrompt,
                sceneDuration,
                ratio
              );

        const scenePath = path.join(
          jobDir,
          `scene-${i + 1}.mp4`
        );

        await fs.writeFile(
          scenePath,
          buffer
        );

        generated.push(scenePath);
      }

      if (!generated.length) {
        throw new Error("No video was generated.");
      }

      let current = path.join(
        jobDir,
        "joined.mp4"
      );

      await concat(
        generated,
        current
      );

      const voiceEnabled =
        body.voiceEnabled !== "false";

      if (
        voiceEnabled &&
        script
      ) {
        const voicePath = path.join(
          jobDir,
          "voice.mp3"
        );

        await makeVoice(
          script,
          voicePath
        );

        const mixed = path.join(
          jobDir,
          "voice-mixed.mp4"
        );

        await mixAudio(
          current,
          voicePath,
          musicFile?.buffer
            ? await writeTempAudio(
                musicFile.buffer,
                jobDir,
                "music"
              )
            : null,
          effectsFile?.buffer
            ? await writeTempAudio(
                effectsFile.buffer,
                jobDir,
                "effects"
              )
            : null,
          mixed
        );

        current = mixed;
      } else if (
        musicFile ||
        effectsFile
      ) {
        const mixed = path.join(
          jobDir,
          "mixed.mp4"
        );

        await mixAudio(
          current,
          null,
          musicFile
            ? await writeTempAudio(
                musicFile.buffer,
                jobDir,
                "music"
              )
            : null,
          effectsFile
            ? await writeTempAudio(
                effectsFile.buffer,
                jobDir,
                "effects"
              )
            : null,
          mixed
        );

        current = mixed;
      }

      if (
        body.subtitles === "true" &&
        script
      ) {
        const captioned = path.join(
          jobDir,
          "captioned.mp4"
        );

        const total = scenes.reduce(
          (sum, s) =>
            sum +
            duration(
              s?.duration ||
              body.duration ||
              5
            ),
          0
        );

        await subtitles(
          current,
          script,
          total,
          captioned
        );

        current = captioned;
      }

      const finalName =
        `mamaki-${Date.now()}-${randomUUID()}.mp4`;

      await fs.copyFile(
        current,
        path.join(OUTPUT, finalName)
      );

      return res.json({
        ok: true,
        success: true,
        videoUrl:
          `/api/video/${encodeURIComponent(finalName)}`,
        file: finalName,
        message:
          "MAMAKI video generated successfully."
      });

    } catch (error) {
      console.error(
        "=============================="
      );

      console.error(
        "MAMAKI GENERATION ERROR"
      );

      console.error(
        error?.stack ||
        error?.message ||
        error
      );

      console.error(
        "=============================="
      );

      return res.status(500).json({
        ok: false,
        success: false,
        error:
          error?.message ||
          "Video generation failed."
      });

    } finally {
      await fs.rm(
        jobDir,
        {
          recursive: true,
          force: true
        }
      ).catch(() => {});
    }
  }
);

async function writeTempAudio(
  buffer,
  dir,
  name
) {
  const file = path.join(
    dir,
    `${name}-${randomUUID()}`
  );

  await fs.writeFile(
    file,
    buffer
  );

  return file;
}

app.get(
  "/api/video/:file",
  async (req, res) => {
    const file = path.basename(
      req.params.file
    );

    const location = path.join(
      OUTPUT,
      file
    );

    try {
      await fs.access(location);

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${file}"`
      );

      return res.sendFile(location);

    } catch {
      return res.status(404).json({
        ok: false,
        error: "Video not found."
      });
    }
  }
);

app.get(
  "/api/status",
  async (req, res) => {
    let authenticated = false;
    let account = null;
    let authError = null;

    if (!TOKEN) {
      authError = "REPLICATE_API_TOKEN missing.";
    } else {
      try {
        const r = await fetch(
          "https://api.replicate.com/v1/account",
          {
            headers: {
              Authorization: `Bearer ${TOKEN}`
            }
          }
        );

        if (r.ok) {
          const data = await r.json();
          authenticated = true;
          account =
            data.username ||
            data.name ||
            null;
        } else {
          authError =
            `Replicate authentication HTTP ${r.status}`;
        }
      } catch (e) {
        authError = e.message;
      }
    }

    res.json({
      app: "MAMAKI AI VIDEO",
      version: "5.0.0",
      server: "online",
      replicate: authenticated,
      account,
      authentication:
        authenticated
          ? "valid"
          : "invalid",
      textToVideo: T2V_MODEL,
      imageToVideo: I2V_MODEL,
      voiceOver: true,
      backgroundMusic: true,
      soundEffects: true,
      subtitles: true,
      multiScene: true,
      longFormAssembly: true,
      ffmpeg: Boolean(ffmpegPath),
      error: authError
    });
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",
      app: "MAMAKI AI VIDEO",
      version: "5.0.0"
    });
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `MAMAKI AI VIDEO v5.0.0 running on ${PORT}`
    );

    console.log(
      "Replicate:",
      TOKEN ? "TOKEN FOUND" : "TOKEN MISSING"
    );

    console.log(
      "FFmpeg:",
      ffmpegPath ? "FOUND" : "MISSING"
    );
  }
);
```0
