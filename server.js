import express from "express";
import multer from "multer";
import Replicate from "replicate";
import { EdgeTTS } from "edge-tts-universal";
import ffmpegPath from "ffmpeg-static";

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const app = express();

const PORT = Number(process.env.PORT || 10000);

const TOKEN =
  String(process.env.REPLICATE_API_TOKEN || "").trim();

const replicate = TOKEN
  ? new Replicate({ auth: TOKEN })
  : null;

const T2V_MODEL =
  "wan-video/wan-2.5-t2v-fast";

const I2V_MODEL =
  "wan-video/wan-2.5-i2v";

const ROOT =
  process.cwd();

const TMP =
  path.join(ROOT, "tmp");

const OUTPUT =
  path.join(ROOT, "outputs");

const PUBLIC =
  path.join(ROOT, "public");

const MAX_UPLOAD =
  100 * 1024 * 1024;

await fs.mkdir(TMP, { recursive: true });
await fs.mkdir(OUTPUT, { recursive: true });
await fs.mkdir(PUBLIC, { recursive: true });

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({
  extended: true,
  limit: "5mb"
}));

app.use(express.static(PUBLIC));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD,
    files: 10
  }
});

/* =========================================================
   HELPERS
========================================================= */

function safeName(name) {
  return String(name || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sizeForRatio(ratio) {
  if (ratio === "9:16") return "720*1280";
  if (ratio === "1:1") return "720*720";
  return "1280*720";
}

function clampDuration(value) {
  const n = Number(value || 5);

  if (!Number.isFinite(n)) return 5;

  return Math.max(
    5,
    Math.min(10, Math.round(n))
  );
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

function isVideo(file) {
  if (!file) return false;

  return file.mimetype === "video/mp4";
}

async function writeUpload(file, prefix) {
  if (!file) return null;

  const fileName =
    `${prefix}-${randomUUID()}-${safeName(file.originalname)}`;

  const filePath =
    path.join(TMP, fileName);

  await fs.writeFile(
    filePath,
    file.buffer
  );

  return filePath;
}

/* =========================================================
   REPLICATE AUTH
========================================================= */

async function checkReplicate() {
  if (!TOKEN) {
    return {
      ok: false,
      error:
        "REPLICATE_API_TOKEN is missing."
    };
  }

  try {
    const r =
      await fetch(
        "https://api.replicate.com/v1/account",
        {
          headers: {
            Authorization:
              `Bearer ${TOKEN}`,
            Accept:
              "application/json"
          }
        }
      );

    if (!r.ok) {
      return {
        ok: false,
        error:
          `Replicate rejected the token. HTTP ${r.status}.`
      };
    }

    const data =
      await r.json();

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

/* =========================================================
   REPLICATE OUTPUT
========================================================= */

function firstOutput(output) {
  if (!output) return null;

  if (Array.isArray(output)) {
    return output[0] || null;
  }

  return output;
}

async function outputToBuffer(output) {
  const item =
    firstOutput(output);

  if (!item) {
    throw new Error(
      "Model returned no output."
    );
  }

  if (
    Buffer.isBuffer(item)
  ) {
    return item;
  }

  if (
    item instanceof Uint8Array
  ) {
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
    const r =
      await fetch(item.url());

    if (!r.ok) {
      throw new Error(
        "Could not download model output."
      );
    }

    return Buffer.from(
      await r.arrayBuffer()
    );
  }

  if (
    typeof item === "string"
  ) {
    const r =
      await fetch(item);

    if (!r.ok) {
      throw new Error(
        `Output download failed: HTTP ${r.status}`
      );
    }

    return Buffer.from(
      await r.arrayBuffer()
    );
  }

  throw new Error(
    "Unsupported model output format."
  );
}

/* =========================================================
   VIDEO GENERATION
========================================================= */

async function generateTextVideo({
  prompt,
  duration,
  ratio,
  audio
}) {
  if (!replicate) {
    throw new Error(
      "Replicate is not configured."
    );
  }

  const input = {
    prompt,
    duration:
      clampDuration(duration),
    size:
      sizeForRatio(ratio),
    negative_prompt:
      "blurry, distorted, flickering, deformed, low quality, bad anatomy",
    enable_prompt_expansion:
      true
  };

  /*
   Wan 2.5 supports an optional audio
   input for synchronized audio/voice/music.
  */

  if (audio) {
    input.audio = audio;
  }

  console.log(
    "MAMAKI: T2V generation started."
  );

  const output =
    await replicate.run(
      T2V_MODEL,
      { input }
    );

  return outputToBuffer(output);
}

/* =========================================================
   IMAGE → VIDEO
========================================================= */

async function generateImageVideo({
  image,
  prompt,
  duration,
  ratio,
  audio
}) {
  if (!replicate) {
    throw new Error(
      "Replicate is not configured."
    );
  }

  if (!image) {
    throw new Error(
      "Image-to-video requires an image."
    );
  }

  const input = {
    image,
    prompt,
    duration:
      clampDuration(duration),
    size:
      sizeForRatio(ratio)
  };

  if (audio) {
    input.audio = audio;
  }

  console.log(
    "MAMAKI: I2V generation started."
  );

  const output =
    await replicate.run(
      I2V_MODEL,
      { input }
    );

  return outputToBuffer(output);
}

/* =========================================================
   EDGE TTS
========================================================= */

async function makeVoice(
  text,
  destination
) {
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

  if (
    !result ||
    !result.audio
  ) {
    throw new Error(
      "TTS returned no audio."
    );
  }

  let buffer;

  if (
    Buffer.isBuffer(
      result.audio
    )
  ) {
    buffer =
      result.audio;
  } else if (
    result.audio instanceof
    Uint8Array
  ) {
    buffer =
      Buffer.from(result.audio);
  } else if (
    typeof result.audio.arrayBuffer ===
    "function"
  ) {
    buffer =
      Buffer.from(
        await result.audio.arrayBuffer()
      );
  } else {
    throw new Error(
      "Unable to read TTS audio."
    );
  }

  await fs.writeFile(
    destination,
    buffer
  );

  return destination;
}

/* =========================================================
   FFMPEG
========================================================= */

function ffmpeg(args) {
  return new Promise(
    (resolve, reject) => {
      if (!ffmpegPath) {
        reject(
          new Error(
            "FFmpeg binary unavailable."
          )
        );

        return;
      }

      const child =
        spawn(
          ffmpegPath,
          args
        );

      let stderr = "";

      child.stderr.on(
        "data",
        data => {
          stderr +=
            data.toString();
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
                `FFmpeg error: ${stderr.slice(-5000)}`
              )
            );
          }
        }
      );
    }
  );
}

/* =========================================================
   AUDIO MIXING
========================================================= */

async function mixAudio({
  video,
  voice,
  music,
  effects,
  output
}) {
  const inputs = [];

  const args = [
    "-y",
    "-i",
    video
  ];

  if (voice) {
    args.push(
      "-i",
      voice
    );

    inputs.push("voice");
  }

  if (music) {
    args.push(
      "-i",
      music
    );

    inputs.push("music");
  }

  if (effects) {
    args.push(
      "-i",
      effects
    );

    inputs.push("effects");
  }

  if (!inputs.length) {
    await fs.copyFile(
      video,
      output
    );

    return;
  }

  /*
   * Audio levels:
   * voice = full
   * music = 20%
   * effects = 45%
   */

  const filters = [];
  const labels = [];

  let index = 0;

  if (voice) {
    filters.push(
      `[${index}:a]volume=1.0[voice]`
    );

    labels.push(
      "[voice]"
    );

    index++;
  }

  if (music) {
    filters.push(
      `[${index}:a]volume=0.20[music]`
    );

    labels.push(
      "[music]"
    );

    index++;
  }

  if (effects) {
    filters.push(
      `[${index}:a]volume=0.45[effects]`
    );

    labels.push(
      "[effects]"
    );

    index++;
  }

  filters.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=2[aout]`
  );

  args.push(
    "-filter_complex",
    filters.join(";")
  );

  args.push(
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

/* =========================================================
   SUBTITLES
========================================================= */

function timestamp(seconds) {
  const ms =
    Math.floor(
      (seconds % 1) * 1000
    );

  const total =
    Math.floor(seconds);

  const s =
    total % 60;

  const m =
    Math.floor(total / 60) % 60;

  const h =
    Math.floor(total / 3600);

  return (
    `${String(h).padStart(2, "0")}:` +
    `${String(m).padStart(2, "0")}:` +
    `${String(s).padStart(2, "0")},` +
    `${String(ms).padStart(3, "0")}`
  );
}

function createSRT(
  text,
  seconds
) {
  const words =
    String(text || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  if (!words.length) {
    return "";
  }

  const chunkSize = 7;

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

  const totalWords =
    words.length;

  const wordTime =
    seconds / totalWords;

  return chunks
    .map(
      (chunk, index) => {
        const startWord =
          index * chunkSize;

        const endWord =
          Math.min(
            totalWords,
            startWord +
              chunk.length
          );

        const start =
          startWord * wordTime;

        const end =
          endWord * wordTime;

        return (
          `${index + 1}\n` +
          `${timestamp(start)} --> ${timestamp(end)}\n` +
          `${chunk.join(" ")}\n`
        );
      }
    )
    .join("\n");
}

async function addSubtitles({
  video,
  text,
  duration,
  output
}) {
  const srt =
    createSRT(
      text,
      duration
    );

  const srtPath =
    path.join(
      TMP,
      `captions-${randomUUID()}.srt`
    );

  await fs.writeFile(
    srtPath,
    srt,
    "utf8"
  );

  /*
   * subtitles filter requires an escaped
   * path on some systems.
   */

  const escaped =
    srtPath
      .replace(/\\/g, "/")
      .replace(/:/g, "\\:");

  await ffmpeg([
    "-y",
    "-i",
    video,
    "-vf",
    `subtitles=${escaped}:force_style='FontName=Arial,FontSize=20,Alignment=2,MarginV=45'`,
    "-c:a",
    "copy",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-movflags",
    "+faststart",
    output
  ]);

  await fs.unlink(
    srtPath
  ).catch(() => {});
}

/* =========================================================
   SCENE JOINING
========================================================= */

async function concatVideos(
  videos,
  output
) {
  if (!videos.length) {
    throw new Error(
      "No scenes to join."
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

  const content =
    videos
      .map(
        file =>
          `file '${file.replace(/'/g, "'\\''")}'`
      )
      .join("\n");

  await fs.writeFile(
    listPath,
    content
  );

  try {
    await ffmpeg([
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
    await fs.unlink(
      listPath
    ).catch(() => {});
  }
}

/* =========================================================
   COMPLETE PIPELINE
========================================================= */

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
    path.join(
      TMP,
      job
    );

  await fs.mkdir(
    jobDir,
    { recursive: true }
  );

  try {
    let sceneList = [];

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

    const generated =
      [];

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

      if (!scenePrompt) {
        continue;
      }

      const sceneDuration =
        clampDuration(
          scene.duration ||
          duration
        );

      const sceneFile =
        path.join(
          jobDir,
          `scene-${i + 1}.mp4`
        );

      let videoBuffer;

      if (referenceImage) {
        videoBuffer =
          await generateImageVideo({
            image:
              referenceImage,
            prompt:
              scenePrompt,
            duration:
              sceneDuration,
            ratio
          });
      } else {
        videoBuffer =
          await generateTextVideo({
            prompt:
              scenePrompt,
            duration:
              sceneDuration,
            ratio
          });
      }

      await fs.writeFile(
        sceneFile,
        videoBuffer
      );

      generated.push(
        sceneFile
      );

      console.log(
        `MAMAKI: Scene ${i + 1}/${sceneList.length} complete.`
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

    let current =
      joined;

    /*
     * Voice-over
     */

    let voiceFile =
      null;

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
     * Audio mixing
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
        video:
          current,
        voice:
          voiceFile,
        music,
        effects,
        output:
          mixed
      });

      current =
        mixed;
    }

    /*
     * Subtitles
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
        video:
          current,
        text:
          script,
        duration:
          totalDuration,
        output:
          captioned
      });

      current =
        captioned;
    }

    /*
     * Final output
     */

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
      finalPath,
      finalName
    };

  } finally {
    /*
     * Keep final output, delete working files.
     */

    await fs.rm(
      jobDir,
      {
        recursive: true,
        force: true
      }
    );
  }
}

/* =========================================================
   GENERATE API
========================================================= */

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
      const auth =
        await checkReplicate();

      if (!auth.ok) {
        return res.status(503).json({
          ok: false,
          stage: "authentication",
          error: auth.error
        });
      }

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
        "9:16";

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

      let referenceImage =
        null;

      let music =
        null;

      let effects =
        null;

      if (
        files.referenceImage?.[0]
      ) {
        if (
          !isImage(
            files.referenceImage[0]
          )
        ) {
          throw new Error(
            "Reference image must be JPG, PNG, or WebP."
          );
        }

        referenceImage =
          files.referenceImage[0].buffer;
      }

      if (
        files.music?.[0]
      ) {
        if (
          !isAudio(
            files.music[0]
          )
        ) {
          throw new Error(
            "Music must be an audio file."
          );
        }

        music =
          await writeUpload(
            files.music[0],
            "music"
          );
      }

      if (
        files.effects?.[0]
      ) {
        if (
          !isAudio(
            files.effects[0]
          )
        ) {
          throw new Error(
            "Sound effects must be an audio file."
          );
        }

        effects =
          await writeUpload(
            files.effects[0],
            "effects"
          );
      }

      /*
       * Character/reference image is passed
       * directly as a Buffer to Replicate.
       */

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

      /*
       * Cleanup uploaded audio.
       */

      if (music) {
        await fs.unlink(
          music
        ).catch(() => {});
      }

      if (effects) {
        await fs.unlink(
          effects
        ).catch(() => {});
      }

      return res.json({
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
        "MAMAKI PIPELINE ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        success: false,
        error:
          error.message ||
          "Generation failed."
      });
    }
  }
);

/* =========================================================
   VIDEO DELIVERY
========================================================= */

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
      await fs.access(
        location
      );

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${file}"`
      );

      return res.sendFile(
        location
      );

    } catch {
      return res.status(404).json({
        ok: false,
        error:
          "Video not found."
      });
    }
  }
);

/* =========================================================
   STATUS
========================================================= */

app.get(
  "/api/status",
  async (req, res) => {
    const auth =
      await checkReplicate();

    res.json({
      app:
        "MAMAKI AI VIDEO",
      version:
        "4.0.0",
      server:
        "online",
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
      referenceImage:
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

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",
      app:
        "MAMAKI AI VIDEO",
      version:
        "4.0.0"
    });
  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "======================================"
    );

    console.log(
      "MAMAKI AI VIDEO v4.0.0"
    );

    console.log(
      `PORT: ${PORT}`
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
      "TEXT VIDEO: ENABLED"
    );

    console.log(
      "IMAGE VIDEO: ENABLED"
    );

    console.log(
      "VOICE: ENABLED"
    );

    console.log(
      "MUSIC: ENABLED"
    );

    console.log(
      "SFX: ENABLED"
    );

    console.log(
      "SUBTITLES: ENABLED"
    );

    console.log(
      "MULTI-SCENE: ENABLED"
    );

    console.log(
      "LONG-FORM: ENABLED"
    );

    console.log(
      "======================================"
    );
  }
);
