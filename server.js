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

const TOKEN = String(
  process.env.REPLICATE_API_TOKEN || ""
).trim();

const replicate = TOKEN
  ? new Replicate({ auth: TOKEN })
  : null;

/*
=========================================================
MAMAKI AI ENGINE
=========================================================
*/

const T2V_MODEL = "wan-video/wan-2.5-t2v-fast";
const I2V_MODEL = "wan-video/wan-2.5-i2v-fast";

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "public");
const TMP = path.join(ROOT, "tmp");
const OUTPUT = path.join(ROOT, "outputs");

const MAX_UPLOAD = 100 * 1024 * 1024;
const MAX_SCENES = 12;

await fs.mkdir(PUBLIC, { recursive: true });
await fs.mkdir(TMP, { recursive: true });
await fs.mkdir(OUTPUT, { recursive: true });

/*
=========================================================
EXPRESS
=========================================================
*/

app.use(express.json({ limit: "10mb" }));

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb"
  })
);

app.use(express.static(PUBLIC));

/*
=========================================================
UPLOADS
=========================================================
*/

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_UPLOAD,
    files: 10
  }
});

/*
=========================================================
HELPERS
=========================================================
*/

function safeName(name) {
  return String(name || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function clampDuration(value) {
  const n = Number(value || 5);

  if (!Number.isFinite(n)) {
    return 5;
  }

  return Math.max(
    5,
    Math.min(10, Math.round(n))
  );
}

function resolutionForRatio(ratio) {
  if (ratio === "9:16") {
    return "720p";
  }

  if (ratio === "1:1") {
    return "720p";
  }

  return "720p";
}

function sizeForRatio(ratio) {
  if (ratio === "9:16") {
    return "720*1280";
  }

  if (ratio === "1:1") {
    return "720*720";
  }

  return "1280*720";
}

function isImage(file) {
  if (!file) return false;

  return [
    "image/jpeg",
    "image/png",
    "image/webp"
  ].includes(file.mimetype);
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

async function saveUpload(file, prefix) {
  const filename =
    `${prefix}-${randomUUID()}-${safeName(
      file.originalname
    )}`;

  const location =
    path.join(TMP, filename);

  await fs.writeFile(
    location,
    file.buffer
  );

  return location;
}

/*
=========================================================
REPLICATE AUTHENTICATION
=========================================================
*/

async function checkReplicate() {
  if (!TOKEN) {
    return {
      ok: false,
      error:
        "REPLICATE_API_TOKEN is missing from Render Environment Variables."
    };
  }

  try {
    const response = await fetch(
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

    if (!response.ok) {
      const text =
        await response.text();

      return {
        ok: false,
        error:
          `Replicate authentication failed: HTTP ${response.status} ${text}`
      };
    }

    const account =
      await response.json();

    return {
      ok: true,
      username:
        account.username ||
        account.name ||
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
=========================================================
REPLICATE FILE CONVERSION
=========================================================
*/

function bufferToFile(
  buffer,
  filename,
  mimetype
) {
  return new File(
    [buffer],
    filename,
    {
      type: mimetype
    }
  );
}

/*
=========================================================
REPLICATE OUTPUT
=========================================================
*/

async function outputToBuffer(output) {
  if (!output) {
    throw new Error(
      "AI model returned no output."
    );
  }

  let item = output;

  if (Array.isArray(output)) {
    item = output[0];
  }

  if (!item) {
    throw new Error(
      "AI model returned an empty output."
    );
  }

  if (Buffer.isBuffer(item)) {
    return item;
  }

  if (item instanceof Uint8Array) {
    return Buffer.from(item);
  }

  if (
    typeof item.arrayBuffer ===
    "function"
  ) {
    return Buffer.from(
      await item.arrayBuffer()
    );
  }

  if (
    typeof item.url ===
    "function"
  ) {
    const url =
      item.url();

    const response =
      await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Unable to download generated video: HTTP ${response.status}`
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
        `Unable to download generated video: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }

  throw new Error(
    "Unsupported AI video output format."
  );
}

/*
=========================================================
PROMPT / CHARACTER CONSISTENCY
=========================================================
*/

function buildCharacterPrompt({
  characterDescription,
  scenePrompt
}) {
  const character =
    String(
      characterDescription || ""
    ).trim();

  const scene =
    String(scenePrompt || "")
      .trim();

  if (!character) {
    return scene;
  }

  return `
CHARACTER CONSISTENCY:
Keep the same main character throughout the entire video.
Preserve the character's face, identity, hairstyle, hair color,
skin tone, body proportions, clothing identity and recognizable
visual features.

CHARACTER DESCRIPTION:
${character}

SCENE:
${scene}

Maintain visual continuity with the reference character.
Do not redesign, replace, age, morph, or substantially change
the character between shots.
`.trim();
}

/*
=========================================================
TEXT → VIDEO
=========================================================
*/

async function generateTextVideo({
  prompt,
  duration,
  ratio,
  seed
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
      "blurry, distorted, flickering, deformed, duplicate person, changing face, changing clothing, bad anatomy, low quality",

    enable_prompt_expansion:
      true
  };

  if (
    Number.isInteger(seed)
  ) {
    input.seed = seed;
  }

  console.log(
    "MAMAKI: Text-to-video request started."
  );

  try {
    const output =
      await replicate.run(
        T2V_MODEL,
        { input }
      );

    return outputToBuffer(output);
  } catch (error) {
    throw normalizeReplicateError(error);
  }
}

/*
=========================================================
IMAGE → VIDEO
=========================================================
*/

async function generateImageVideo({
  imageBuffer,
  imageMime,
  prompt,
  duration,
  seed
}) {
  if (!replicate) {
    throw new Error(
      "Replicate is not configured."
    );
  }

  if (!imageBuffer) {
    throw new Error(
      "A reference image is required."
    );
  }

  const image =
    bufferToFile(
      imageBuffer,
      "character-reference.png",
      imageMime || "image/png"
    );

  const input = {
    image,

    prompt,

    duration:
      clampDuration(duration),

    resolution:
      "720p",

    negative_prompt:
      "face changing, identity changing, different person, different clothing, distorted face, extra limbs, flickering, blurry, low quality",

    enable_prompt_expansion:
      true
  };

  if (
    Number.isInteger(seed)
  ) {
    input.seed = seed;
  }

  console.log(
    "MAMAKI: Image-to-video request started."
  );

  try {
    const output =
      await replicate.run(
        I2V_MODEL,
        { input }
      );

    return outputToBuffer(output);
  } catch (error) {
    throw normalizeReplicateError(error);
  }
}

/*
=========================================================
REPLICATE ERROR HANDLING
=========================================================
*/

function normalizeReplicateError(error) {
  const message =
    String(
      error?.message ||
      error ||
      "Unknown Replicate error"
    );

  if (
    message.includes("402") ||
    /insufficient credit/i.test(
      message
    )
  ) {
    return new Error(
      "Replicate has insufficient credit. Add credit to the Replicate account, wait a few minutes, then try again."
    );
  }

  if (
    message.includes("401") ||
    /authentication/i.test(
      message
    )
  ) {
    return new Error(
      "Replicate authentication failed. Check REPLICATE_API_TOKEN in Render."
    );
  }

  if (
    message.includes("429") ||
    /too many requests/i.test(
      message
    )
  ) {
    return new Error(
      "Replicate rate limit reached. Wait a moment and try again."
    );
  }

  return new Error(
    message
  );
}

/*
=========================================================
VOICE OVER
=========================================================
*/

async function makeVoice(
  text,
  destination
) {
  const narration =
    String(text || "")
      .trim();

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
      "Voice-over engine returned no audio."
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
      Buffer.from(
        result.audio
      );
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
=========================================================
FFMPEG
=========================================================
*/

function runFFmpeg(args) {
  return new Promise(
    (resolve, reject) => {
      if (!ffmpegPath) {
        reject(
          new Error(
            "FFmpeg is unavailable."
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
                `FFmpeg failed: ${stderr.slice(-5000)}`
              )
            );
          }
        }
      );
    }
  );
}

/*
=========================================================
VIDEO NORMALIZATION / SCENE JOINING
=========================================================
*/

async function concatVideos(
  videos,
  output
) {
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

  const content =
    videos
      .map(
        file =>
          `file '${file.replace(/'/g, "'\\''")}'`
      )
      .join("\n");

  await fs.writeFile(
    listPath,
    content,
    "utf8"
  );

  try {
    /*
     * Re-encode all scenes so different
     * AI outputs cannot break concat.
     */

    await runFFmpeg([
      "-y",

      "-f",
      "concat",

      "-safe",
      "0",

      "-i",
      listPath,

      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",

      "-c:v",
      "libx264",

      "-preset",
      "veryfast",

      "-crf",
      "20",

      "-c:a",
      "aac",

      "-b:a",
      "128k",

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

/*
=========================================================
AUDIO MIXING
=========================================================
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
    args.push(
      "-i",
      voice
    );

    labels.push(
      `[${inputIndex}:a]volume=1.0[voice]`
    );

    inputIndex++;
  }

  if (music) {
    args.push(
      "-stream_loop",
      "-1",
      "-i",
      music
    );

    labels.push(
      `[${inputIndex}:a]volume=0.20[music]`
    );

    inputIndex++;
  }

  if (effects) {
    args.push(
      "-stream_loop",
      "-1",
      "-i",
      effects
    );

    labels.push(
      `[${inputIndex}:a]volume=0.40[effects]`
    );

    inputIndex++;
  }

  if (!labels.length) {
    await fs.copyFile(
      video,
      output
    );

    return;
  }

  const streams = [];

  if (voice) {
    streams.push("[voice]");
  }

  if (music) {
    streams.push("[music]");
  }

  if (effects) {
    streams.push("[effects]");
  }

  labels.push(
    `${streams.join("")}amix=inputs=${streams.length}:duration=first:dropout_transition=2[aout]`
  );

  args.push(
    "-filter_complex",
    labels.join(";"),

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

  await runFFmpeg(args);
}

/*
=========================================================
SUBTITLES
=========================================================
*/

function timestamp(seconds) {
  const total =
    Math.max(
      0,
      Number(seconds) || 0
    );

  const ms =
    Math.floor(
      (total % 1) * 1000
    );

  const whole =
    Math.floor(total);

  const sec =
    whole % 60;

  const min =
    Math.floor(
      whole / 60
    ) % 60;

  const hour =
    Math.floor(
      whole / 3600
    );

  return (
    `${String(hour).padStart(2, "0")}:` +
    `${String(min).padStart(2, "0")}:` +
    `${String(sec).padStart(2, "0")},` +
    `${String(ms).padStart(3, "0")}`
  );
}

function createSRT(
  text,
  duration
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

  const totalWords =
    words.length;

  const wordTime =
    duration /
    totalWords;

  const entries = [];

  for (
    let i = 0;
    i < words.length;
    i += chunkSize
  ) {
    const chunk =
      words.slice(
        i,
        i + chunkSize
      );

    const start =
      i * wordTime;

    const end =
      Math.min(
        totalWords,
        i + chunk.length
      ) * wordTime;

    entries.push(
      `${entries.length + 1}\n` +
      `${timestamp(start)} --> ${timestamp(end)}\n` +
      `${chunk.join(" ")}\n`
    );
  }

  return entries.join("\n");
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

  if (!srt) {
    await fs.copyFile(
      video,
      output
    );

    return;
  }

  const srtPath =
    path.join(
      TMP,
      `subtitle-${randomUUID()}.srt`
    );

  await fs.writeFile(
    srtPath,
    srt,
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
      "aac",

      "-b:a",
      "192k",

      "-movflags",
      "+faststart",

      output
    ]);
  } finally {
    await fs.unlink(
      srtPath
    ).catch(() => {});
  }
}

/*
=========================================================
BUILD COMPLETE VIDEO
=========================================================
*/

async function buildVideo({
  prompt,
  script,
  duration,
  ratio,
  scenes,
  referenceImage,
  referenceMime,
  characterDescription,
  voiceEnabled,
  music,
  effects,
  subtitles
}) {
  const jobId =
    randomUUID();

  const jobDir =
    path.join(
      TMP,
      jobId
    );

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
        scenes
          .slice(0, MAX_SCENES)
          .filter(
            scene =>
              scene &&
              String(
                scene.prompt || ""
              ).trim()
          );
    } else {
      sceneList = [
        {
          prompt,
          duration
        }
      ];
    }

    if (!sceneList.length) {
      throw new Error(
        "No valid scenes were supplied."
      );
    }

    const generated = [];

    /*
     * Use the same reference image for EVERY
     * scene. This is the main MAMAKI character
     * consistency mechanism.
     */

    for (
      let i = 0;
      i < sceneList.length;
      i++
    ) {
      const scene =
        sceneList[i];

      const scenePrompt =
        buildCharacterPrompt({
          characterDescription,
          scenePrompt:
            scene.prompt ||
            prompt
        });

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

      /*
       * Give every scene a deterministic seed
       * when requested by the caller.
       */

      const seed =
        Number.isInteger(
          Number(scene.seed)
        )
          ? Number(scene.seed)
          : undefined;

      let buffer;

      if (referenceImage) {
        buffer =
          await generateImageVideo({
            imageBuffer:
              referenceImage,

            imageMime:
              referenceMime,

            prompt:
              scenePrompt,

            duration:
              sceneDuration,

            seed
          });
      } else {
        buffer =
          await generateTextVideo({
            prompt:
              scenePrompt,

            duration:
              sceneDuration,

            ratio,

            seed
          });
      }

      await fs.writeFile(
        sceneFile,
        buffer
      );

      generated.push(
        sceneFile
      );

      console.log(
        `MAMAKI: Scene ${i + 1}/${sceneList.length} complete.`
      );
    }

    /*
     * Join scenes.
     */

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
     * Voice-over.
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
     * Audio post-production.
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
     * Subtitles.
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
     * Final MP4.
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
      finalName,
      finalPath,

      scenes:
        generated.length,

      duration:
        sceneList.reduce(
          (sum, scene) =>
            sum +
            clampDuration(
              scene.duration ||
              duration
            ),
          0
        )
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
=========================================================
GENERATE API
=========================================================
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
      const auth =
        await checkReplicate();

      if (!auth.ok) {
        return res.status(503).json({
          ok: false,
          stage:
            "authentication",
          error:
            auth.error
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
        String(
          body.ratio ||
          body.aspectRatio ||
          "16:9"
        );

      const voiceEnabled =
        body.voiceEnabled !==
        "false";

      const subtitles =
        body.subtitles ===
        "true";

      const characterDescription =
        String(
          body.characterDescription ||
          body.character ||
          ""
        ).trim();

      let scenes = [];

      if (body.scenes) {
        try {
          scenes =
            typeof body.scenes ===
            "string"
              ? JSON.parse(
                  body.scenes
                )
              : body.scenes;
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
            "Enter a video prompt."
        });
      }

      const files =
        req.files || {};

      let referenceImage =
        null;

      let referenceMime =
        "image/png";

      let music =
        null;

      let effects =
        null;

      try {
        /*
         * Character reference image.
         */

        const reference =
          files
            .referenceImage?.[0];

        if (reference) {
          if (!isImage(reference)) {
            throw new Error(
              "Reference image must be JPG, PNG or WebP."
            );
          }

          referenceImage =
            reference.buffer;

          referenceMime =
            reference.mimetype;
        }

        /*
         * Background music.
         */

        const musicFile =
          files.music?.[0];

        if (musicFile) {
          if (!isAudio(musicFile)) {
            throw new Error(
              "Background music must be an audio file."
            );
          }

          music =
            await saveUpload(
              musicFile,
              "music"
            );
        }

        /*
         * Sound effects.
         */

        const effectsFile =
          files.effects?.[0];

        if (effectsFile) {
          if (!isAudio(effectsFile)) {
            throw new Error(
              "Sound effects must be an audio file."
            );
          }

          effects =
            await saveUpload(
              effectsFile,
              "effects"
            );
        }

        /*
         * Complete pipeline.
         */

        const result =
          await buildVideo({
            prompt,

            script,

            duration,

            ratio,

            scenes,

            referenceImage,

            referenceMime,

            characterDescription,

            voiceEnabled,

            music,

            effects,

            subtitles
          });

        return res.json({
          ok: true,
          success: true,

          videoUrl:
            `/api/video/${encodeURIComponent(
              result.finalName
            )}`,

          file:
            result.finalName,

          scenes:
            result.scenes,

          duration:
            result.duration,

          features: {
            textToVideo:
              !referenceImage,

            imageToVideo:
              Boolean(
                referenceImage
              ),

            characterConsistency:
              Boolean(
                referenceImage ||
                characterDescription
              ),

            voiceOver:
              Boolean(
                voiceEnabled &&
                script
              ),

            backgroundMusic:
              Boolean(music),

            soundEffects:
              Boolean(effects),

            subtitles:
              Boolean(
                subtitles &&
                script
              ),

            multiScene:
              result.scenes > 1,

            longFormAssembly:
              result.scenes > 1
          },

          message:
            "MAMAKI AI VIDEO generated successfully."
        });
      } finally {
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
      }
    } catch (error) {
      console.error(
        "MAMAKI GENERATION ERROR:",
        error
      );

      return res.status(500).json({
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
=========================================================
VIDEO DELIVERY
=========================================================
*/

app.get(
  "/api/video/:file",
  async (req, res) => {
    const filename =
      path.basename(
        req.params.file
      );

    const location =
      path.join(
        OUTPUT,
        filename
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
        `inline; filename="${filename}"`
      );

      return res.sendFile(
        location
      );
    } catch {
      return res.status(404).json({
        ok: false,
        error:
          "Generated video was not found."
      });
    }
  }
);

/*
=========================================================
STATUS
=========================================================
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
        "5.0.0",

      server:
        "online",

      replicate:
        auth.ok,

      authentication:
        auth.ok
          ? "valid"
          : "invalid",

      account:
        auth.username ||
        null,

      models: {
        textToVideo:
          T2V_MODEL,

        imageToVideo:
          I2V_MODEL
      },

      features: {
        actualAIGeneration:
          Boolean(replicate),

        textToVideo:
          true,

        imageToVideo:
          true,

        characterConsistency:
          true,

        multiScene:
          true,

        longFormAssembly:
          true,

        voiceOver:
          true,

        backgroundMusic:
          true,

        soundEffects:
          true,

        subtitles:
          true,

        advancedEditingPipeline:
          true
      },

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
=========================================================
HEALTH
=========================================================
*/

app.get(
  "/health",
  (req, res) => {
    res.json({
      status:
        "ok",

      app:
        "MAMAKI AI VIDEO",

      version:
        "5.0.0"
    });
  }
);

/*
=========================================================
ROOT FALLBACK
=========================================================
*/

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      path.join(
        PUBLIC,
        "index.html"
      )
    );
  }
);

/*
=========================================================
START
=========================================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "========================================"
    );

    console.log(
      "MAMAKI AI VIDEO v5.0.0"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `REPLICATE TOKEN: ${
        TOKEN
          ? "FOUND"
          : "MISSING"
      }`
    );

    console.log(
      `FFMPEG: ${
        ffmpegPath
          ? "FOUND"
          : "MISSING"
      }`
    );

    console.log(
      `T2V: ${T2V_MODEL}`
    );

    console.log(
      `I2V: ${I2V_MODEL}`
    );

    console.log(
      "CHARACTER CONSISTENCY: ENABLED"
    );

    console.log(
      "MULTI-SCENE: ENABLED"
    );

    console.log(
      "LONG-FORM ASSEMBLY: ENABLED"
    );

    console.log(
      "VOICE-OVER: ENABLED"
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
      "========================================"
    );
  }
);
