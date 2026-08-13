import express from "express";
import multer from "multer";
import Replicate from "replicate";
import { EdgeTTS } from "edge-tts-universal";
import ffmpegPath from "ffmpeg-static";

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const ROOT = process.cwd();

const TOKEN = String(
  process.env.REPLICATE_API_TOKEN || ""
).trim();

const replicate = TOKEN
  ? new Replicate({ auth: TOKEN })
  : null;

const T2V_MODEL = "wan-video/wan-2.5-t2v-fast";
const I2V_MODEL = "wan-video/wan-2.5-i2v";

const OUTPUT = path.join(ROOT, "outputs");
const TMP = path.join(ROOT, "tmp");

/*
 * MAMAKI currently has index.html at the repository root.
 * We therefore serve ROOT directly.
 */
const INDEX_FILE = path.join(ROOT, "index.html");

await fs.mkdir(OUTPUT, { recursive: true });
await fs.mkdir(TMP, { recursive: true });

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "10mb"
}));

/*
 * =========================================================
 * FRONTEND
 * =========================================================
 */

/*
 * Serve static frontend files from repository root.
 */
app.use(express.static(ROOT, {
  index: false
}));

/*
 * ROOT ROUTE
 *
 * This fixes:
 * Cannot GET /
 */
app.get("/", async (req, res) => {
  try {
    await fs.access(INDEX_FILE);

    res.sendFile(INDEX_FILE);
  } catch {
    res.status(404).send(`
      <!doctype html>
      <html>
        <head>
          <title>MAMAKI AI VIDEO</title>
        </head>
        <body>
          <h1>MAMAKI AI VIDEO</h1>
          <p>index.html was not found.</p>
          <p>Please make sure index.html exists in the repository root.</p>
        </body>
      </html>
    `);
  }
});

/*
 * =========================================================
 * UPLOAD
 * =========================================================
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 10
  }
});

/*
 * =========================================================
 * HELPERS
 * =========================================================
 */

function clampDuration(value) {
  const n = Number(value || 5);

  if (!Number.isFinite(n)) return 5;

  return Math.max(
    5,
    Math.min(10, Math.round(n))
  );
}

function sizeForRatio(ratio) {
  if (ratio === "9:16") return "720*1280";
  if (ratio === "1:1") return "720*720";
  return "1280*720";
}

function isAudio(file) {
  if (!file) return false;

  return [
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

function isImage(file) {
  if (!file) return false;

  return [
    "image/jpeg",
    "image/png",
    "image/webp"
  ].includes(file.mimetype);
}

async function writeTempFile(file, prefix) {
  const name =
    `${prefix}-${randomUUID()}-${file.originalname
      .replace(/[^a-zA-Z0-9._-]/g, "_")}`;

  const location = path.join(TMP, name);

  await fs.writeFile(location, file.buffer);

  return location;
}

/*
 * =========================================================
 * REPLICATE AUTH
 * =========================================================
 */

async function checkReplicate() {
  if (!TOKEN) {
    return {
      ok: false,
      error: "REPLICATE_API_TOKEN is missing."
    };
  }

  try {
    const response = await fetch(
      "https://api.replicate.com/v1/account",
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: "application/json"
        }
      }
    );

    if (!response.ok) {
      return {
        ok: false,
        error:
          `Replicate authentication failed: HTTP ${response.status}`
      };
    }

    const data = await response.json();

    return {
      ok: true,
      username:
        data.username ||
        data.name ||
        "authenticated"
    };
  } catch (error) {
    return {
      ok: false,
      error:
        `Replicate connection failed: ${error.message}`
    };
  }
}

/*
 * =========================================================
 * REPLICATE OUTPUT
 * =========================================================
 */

function firstOutput(output) {
  if (!output) return null;

  if (Array.isArray(output)) {
    return output[0] || null;
  }

  return output;
}

async function outputToBuffer(output) {
  const item = firstOutput(output);

  if (!item) {
    throw new Error("Model returned no video.");
  }

  if (Buffer.isBuffer(item)) {
    return item;
  }

  if (item instanceof Uint8Array) {
    return Buffer.from(item);
  }

  if (
    typeof item === "object" &&
    typeof item.arrayBuffer === "function"
  ) {
    return Buffer.from(
      await item.arrayBuffer()
    );
  }

  if (
    typeof item === "object" &&
    typeof item.url === "function"
  ) {
    const response =
      await fetch(item.url());

    if (!response.ok) {
      throw new Error(
        `Video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  if (typeof item === "string") {
    const response =
      await fetch(item);

    if (!response.ok) {
      throw new Error(
        `Video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  throw new Error(
    "Unsupported Replicate video output."
  );
}

/*
 * =========================================================
 * TEXT → VIDEO
 * =========================================================
 */

async function generateTextVideo({
  prompt,
  duration,
  ratio
}) {
  if (!replicate) {
    throw new Error(
      "Replicate API token is not configured."
    );
  }

  const input = {
    prompt,
    duration: clampDuration(duration),
    size: sizeForRatio(ratio),
    negative_prompt:
      "blurry, distorted, flickering, deformed, low quality, bad anatomy",
    enable_prompt_expansion: true
  };

  console.log(
    "MAMAKI: Starting text-to-video..."
  );

  try {
    const output =
      await replicate.run(
        T2V_MODEL,
        { input }
      );

    return await outputToBuffer(output);

  } catch (error) {
    if (
      error?.status === 402 ||
      error?.message?.includes("402")
    ) {
      throw new Error(
        "Replicate has insufficient credit. Add billing credit to Replicate before generating."
      );
    }

    if (
      error?.status === 429 ||
      error?.message?.includes("429")
    ) {
      throw new Error(
        "Replicate rate limit reached. Please wait and try again."
      );
    }

    throw error;
  }
}

/*
 * =========================================================
 * IMAGE → VIDEO
 * =========================================================
 */

async function generateImageVideo({
  image,
  prompt,
  duration,
  ratio
}) {
  if (!replicate) {
    throw new Error(
      "Replicate API token is not configured."
    );
  }

  if (!image) {
    throw new Error(
      "Image-to-video requires an image."
    );
  }

  /*
   * Convert uploaded image to a data URL.
   * This is safer than passing a raw Buffer.
   */
  const mime =
    image.mimetype || "image/jpeg";

  const imageData =
    `data:${mime};base64,${image.buffer.toString("base64")}`;

  const input = {
    image: imageData,
    prompt,
    duration: clampDuration(duration),
    size: sizeForRatio(ratio)
  };

  console.log(
    "MAMAKI: Starting image-to-video..."
  );

  try {
    const output =
      await replicate.run(
        I2V_MODEL,
        { input }
      );

    return await outputToBuffer(output);

  } catch (error) {
    if (
      error?.status === 402 ||
      error?.message?.includes("402")
    ) {
      throw new Error(
        "Replicate has insufficient credit. Add billing credit to Replicate before generating."
      );
    }

    throw error;
  }
}

/*
 * =========================================================
 * VOICEOVER
 * =========================================================
 */

async function makeVoice(text, destination) {
  const narration =
    String(text || "").trim();

  if (!narration) {
    throw new Error(
      "Voice-over text is empty."
    );
  }

  const tts =
    new EdgeTTS(
      narration,
      "en-US-AriaNeural",
      {
        rate: "+0%",
        volume: "+0%",
        pitch: "+0Hz"
      }
    );

  const result =
    await tts.synthesize();

  if (!result?.audio) {
    throw new Error(
      "Voice-over generation returned no audio."
    );
  }

  let buffer;

  if (Buffer.isBuffer(result.audio)) {
    buffer = result.audio;
  } else if (
    result.audio instanceof Uint8Array
  ) {
    buffer = Buffer.from(result.audio);
  } else if (
    typeof result.audio.arrayBuffer ===
    "function"
  ) {
    buffer = Buffer.from(
      await result.audio.arrayBuffer()
    );
  } else {
    throw new Error(
      "Could not read voice-over audio."
    );
  }

  await fs.writeFile(
    destination,
    buffer
  );

  return destination;
}

/*
 * =========================================================
 * FFMPEG
 * =========================================================
 */

function runFFmpeg(args) {
  return new Promise(
    (resolve, reject) => {
      if (!ffmpegPath) {
        reject(
          new Error(
            "FFmpeg is not available."
          )
        );
        return;
      }

      const child =
        spawn(ffmpegPath, args);

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
                `FFmpeg failed: ${stderr.slice(-4000)}`
              )
            );
          }
        }
      );
    }
  );
}

/*
 * =========================================================
 * AUDIO MIXING
 * =========================================================
 */

async function mixAudio({
  video,
  voice,
  music,
  effects,
  output
}) {
  const args = [
    "-y",
    "-i",
    video
  ];

  const labels = [];

  let inputIndex = 1;

  if (voice) {
    args.push("-i", voice);

    args.push(
      "-filter_complex",
      `[1:a]volume=1.0[voice]`
    );

    labels.push("[voice]");
    inputIndex++;
  }

  if (music) {
    args.push("-i", music);
    inputIndex++;
  }

  if (effects) {
    args.push("-i", effects);
    inputIndex++;
  }

  /*
   * Simpler reliable mixing path.
   */

  const filters = [];
  const mixLabels = [];

  let audioIndex = 1;

  if (voice) {
    filters.push(
      `[${audioIndex}:a]volume=1.0[v]`
    );
    mixLabels.push("[v]");
    audioIndex++;
  }

  if (music) {
    filters.push(
      `[${audioIndex}:a]volume=0.20[m]`
    );
    mixLabels.push("[m]");
    audioIndex++;
  }

  if (effects) {
    filters.push(
      `[${audioIndex}:a]volume=0.45[e]`
    );
    mixLabels.push("[e]");
  }

  if (!mixLabels.length) {
    await fs.copyFile(video, output);
    return;
  }

  filters.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=2[aout]`
  );

  /*
   * Rebuild arguments cleanly.
   */
  const ffArgs = [
    "-y",
    "-i",
    video
  ];

  if (voice) ffArgs.push("-i", voice);
  if (music) ffArgs.push("-i", music);
  if (effects) ffArgs.push("-i", effects);

  ffArgs.push(
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

  await runFFmpeg(ffArgs);
}

/*
 * =========================================================
 * SUBTITLES
 * =========================================================
 */

function createSRT(text, duration) {
  const words =
    String(text || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  if (!words.length) return "";

  const chunkSize = 7;
  const wordTime =
    duration / words.length;

  const chunks = [];

  for (
    let i = 0;
    i < words.length;
    i += chunkSize
  ) {
    chunks.push(
      words.slice(
        i,
        i + chunkSize
      )
    );
  }

  function stamp(seconds) {
    const totalMs =
      Math.floor(seconds * 1000);

    const ms =
      totalMs % 1000;

    const totalSec =
      Math.floor(totalMs / 1000);

    const sec =
      totalSec % 60;

    const min =
      Math.floor(totalSec / 60) % 60;

    const hour =
      Math.floor(totalSec / 3600);

    return (
      `${String(hour).padStart(2, "0")}:` +
      `${String(min).padStart(2, "0")}:` +
      `${String(sec).padStart(2, "0")},` +
      `${String(ms).padStart(3, "0")}`
    );
  }

  return chunks
    .map((chunk, i) => {
      const start =
        i * chunkSize * wordTime;

      const end =
        Math.min(
          words.length,
          (i + 1) * chunkSize
        ) * wordTime;

      return (
        `${i + 1}\n` +
        `${stamp(start)} --> ${stamp(end)}\n` +
        `${chunk.join(" ")}\n`
      );
    })
    .join("\n");
}

async function addSubtitles({
  video,
  text,
  duration,
  output
}) {
  const srtPath =
    path.join(
      TMP,
      `subtitles-${randomUUID()}.srt`
    );

  await fs.writeFile(
    srtPath,
    createSRT(text, duration),
    "utf8"
  );

  const escaped =
    srtPath
      .replace(/\\/g, "/")
      .replace(/:/g, "\\:");

  try {
    await runFFmpeg([
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

/*
 * =========================================================
 * CONCATENATE SCENES
 * =========================================================
 */

async function concatVideos(videos, output) {
  if (!videos.length) {
    throw new Error(
      "No generated scenes."
    );
  }

  if (videos.length === 1) {
    await fs.copyFile(
      videos[0],
      output
    );
    return;
  }

  const listPath =
    path.join(
      TMP,
      `concat-${randomUUID()}.txt`
    );

  const list =
    videos
      .map(
        file =>
          `file '${file.replace(/'/g, "'\\''")}'`
      )
      .join("\n");

  await fs.writeFile(
    listPath,
    list
  );

  try {
    await runFFmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output
    ]);
  } finally {
    await fs.unlink(listPath).catch(() => {});
  }
}

/*
 * =========================================================
 * COMPLETE GENERATION PIPELINE
 * =========================================================
 */

async function buildVideo({
  prompt,
  script,
  duration,
  ratio,
  scenes,
  referenceImage,
  voiceEnabled,
  music,
  effects,
  subtitles
}) {
  const job =
    randomUUID();

  const jobDir =
    path.join(TMP, job);

  await fs.mkdir(
    jobDir,
    { recursive: true }
  );

  try {
    let sceneList;

    if (
      Array.isArray(scenes) &&
      scenes.length
    ) {
      sceneList =
        scenes.slice(0, 30);
    } else {
      sceneList = [
        {
          prompt,
          duration
        }
      ];
    }

    const generated = [];

    for (
      let i = 0;
      i < sceneList.length;
      i++
    ) {
      const scene =
        sceneList[i];

      const scenePrompt =
        String(
          scene.prompt ||
          prompt ||
          ""
        ).trim();

      if (!scenePrompt) continue;

      const sceneDuration =
        clampDuration(
          scene.duration ||
          duration
        );

      const outputPath =
        path.join(
          jobDir,
          `scene-${i + 1}.mp4`
        );

      let buffer;

      if (referenceImage) {
        buffer =
          await generateImageVideo({
            image: referenceImage,
            prompt: scenePrompt,
            duration: sceneDuration,
            ratio
          });
      } else {
        buffer =
          await generateTextVideo({
            prompt: scenePrompt,
            duration: sceneDuration,
            ratio
          });
      }

      await fs.writeFile(
        outputPath,
        buffer
      );

      generated.push(
        outputPath
      );

      console.log(
        `MAMAKI: Scene ${i + 1}/${sceneList.length} completed.`
      );
    }

    if (!generated.length) {
      throw new Error(
        "No video scenes were generated."
      );
    }

    const joined =
      path.join(
        jobDir,
        "joined.mp4"
      );

    await concatVideos(
      generated,
      joined
    );

    let current = joined;

    /*
     * VOICEOVER
     */
    let voiceFile = null;

    if (
      voiceEnabled &&
      script
    ) {
      voiceFile =
        path.join(
          jobDir,
          "voice.mp3"
        );

      await makeVoice(
        script,
        voiceFile
      );
    }

    /*
     * AUDIO
     */
    if (
      voiceFile ||
      music ||
      effects
    ) {
      const mixed =
        path.join(
          jobDir,
          "mixed.mp4"
        );

      await mixAudio({
        video: current,
        voice: voiceFile,
        music,
        effects,
        output: mixed
      });

      current = mixed;
    }

    /*
     * SUBTITLES
     */
    if (
      subtitles &&
      script
    ) {
      const captioned =
        path.join(
          jobDir,
          "captioned.mp4"
        );

      const totalDuration =
        sceneList.reduce(
          (sum, scene) =>
            sum +
            clampDuration(
              scene.duration ||
              duration
            ),
          0
        );

      await addSubtitles({
        video: current,
        text: script,
        duration: totalDuration,
        output: captioned
      });

      current = captioned;
    }

    const finalName =
      `mamaki-${Date.now()}-${randomUUID()}.mp4`;

    const finalPath =
      path.join(
        OUTPUT,
        finalName
      );

    await fs.copyFile(
      current,
      finalPath
    );

    return {
      finalName,
      finalPath
    };

  } finally {
    await fs.rm(
      jobDir,
      {
        recursive: true,
        force: true
      }
    );
  }
}

/*
 * =========================================================
 * GENERATE API
 * =========================================================
 */

app.post(
  "/api/generate",
  upload.fields([
    {
      name: "referenceImage",
      maxCount: 1
    },
    {
      name: "music",
      maxCount: 1
    },
    {
      name: "effects",
      maxCount: 1
    }
  ]),
  async (req, res) => {
    try {
      const body =
        req.body || {};

      const prompt =
        String(
          body.prompt || ""
        ).trim();

      const script =
        String(
          body.script ||
          body.voiceText ||
          ""
        ).trim();

      const duration =
        clampDuration(
          body.duration
        );

      const ratio =
        body.ratio ||
        body.aspectRatio ||
        "16:9";

      const voiceEnabled =
        body.voiceEnabled !== "false";

      const subtitles =
        body.subtitles === "true";

      let scenes = [];

      if (body.scenes) {
        try {
          scenes =
            JSON.parse(
              body.scenes
            );
        } catch {
          return res.status(400).json({
            ok: false,
            error:
              "Scenes must be valid JSON."
          });
        }
      }

      if (
        !prompt &&
        !scenes.length
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Enter a prompt."
        });
      }

      const files =
        req.files || {};

      let referenceImage = null;
      let music = null;
      let effects = null;

      if (
        files.referenceImage?.[0]
      ) {
        const file =
          files.referenceImage[0];

        if (!isImage(file)) {
          throw new Error(
            "Reference image must be JPG, PNG, or WebP."
          );
        }

        referenceImage = file;
      }

      if (files.music?.[0]) {
        const file =
          files.music[0];

        if (!isAudio(file)) {
          throw new Error(
            "Music must be an audio file."
          );
        }

        music =
          await writeTempFile(
            file,
            "music"
          );
      }

      if (files.effects?.[0]) {
        const file =
          files.effects[0];

        if (!isAudio(file)) {
          throw new Error(
            "Sound effects must be an audio file."
          );
        }

        effects =
          await writeTempFile(
            file,
            "effects"
          );
      }

      const result =
        await buildVideo({
          prompt,
          script,
          duration,
          ratio,
          scenes,
          referenceImage,
          voiceEnabled,
          music,
          effects,
          subtitles
        });

      if (music) {
        await fs.unlink(music).catch(() => {});
      }

      if (effects) {
        await fs.unlink(effects).catch(() => {});
      }

      res.json({
        ok: true,
        success: true,
        videoUrl:
          `/api/video/${encodeURIComponent(result.finalName)}`,
        file:
          result.finalName,
        message:
          "MAMAKI video completed successfully."
      });

    } catch (error) {
      console.error(
        "MAMAKI GENERATION ERROR:",
        error
      );

      res.status(500).json({
        ok: false,
        success: false,
        error:
          error.message ||
          "Video generation failed."
      });
    }
  }
);

/*
 * =========================================================
 * VIDEO DELIVERY
 * =========================================================
 */

app.get(
  "/api/video/:file",
  async (req, res) => {
    const file =
      path.basename(
        req.params.file
      );

    const location =
      path.join(
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
        error:
          "Video not found."
      });
    }
  }
);

/*
 * =========================================================
 * STATUS
 * =========================================================
 */

app.get(
  "/api/status",
  async (req, res) => {
    const auth =
      await checkReplicate();

    res.json({
      app:
        "MAMAKI AI VIDEO",
      version:
        "4.1.0",
      server:
        "online",
      interface:
        true,
      replicate:
        auth.ok,
      authentication:
        auth.ok
          ? "valid"
          : "invalid",
      account:
        auth.username || null,
      textToVideo:
        T2V_MODEL,
      imageToVideo:
        I2V_MODEL,
      voiceOver:
        true,
      backgroundMusic:
        true,
      soundEffects:
        true,
      subtitles:
        true,
      multiScene:
        true,
      characterReference:
        true,
      longFormAssembly:
        true,
      ffmpeg:
        Boolean(ffmpegPath),
      error:
        auth.ok
          ? null
          : auth.error
    });
  }
);

/*
 * =========================================================
 * HEALTH
 * =========================================================
 */

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",
      app:
        "MAMAKI AI VIDEO",
      version:
        "4.1.0"
    });
  }
);

/*
 * =========================================================
 * START
 * =========================================================
 */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "======================================"
    );
    console.log(
      "MAMAKI AI VIDEO v4.1.0"
    );
    console.log(
      `PORT: ${PORT}`
    );
    console.log(
      `INDEX: ${
        "index.html"
      }`
    );
    console.log(
      `REPLICATE TOKEN: ${
        TOKEN ? "FOUND" : "MISSING"
      }`
    );
    console.log(
      `FFMPEG: ${
        ffmpegPath ? "FOUND" : "MISSING"
      }`
    );
    console.log(
      "ROOT INTERFACE: ENABLED"
    );
    console.log(
      "TEXT-TO-VIDEO: ENABLED"
    );
    console.log(
      "IMAGE-TO-VIDEO: ENABLED"
    );
    console.log(
      "VOICEOVER: ENABLED"
    );
    console.log(
      "BACKGROUND MUSIC: ENABLED"
    );
    console.log(
      "SOUND EFFECTS: ENABLED"
    );
    console.log(
      "SUBTITLES: ENABLED"
    );
    console.log(
      "MULTI-SCENE: ENABLED"
    );
    console.log(
      "LONG-FORM ASSEMBLY: ENABLED"
    );
    console.log(
      "======================================"
    );
  }
);
