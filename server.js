import "dotenv/config";
import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import Replicate from "replicate";
import { EdgeTTS } from "edge-tts-universal";
import ffmpegPath from "ffmpeg-static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 10000;

const REPLICATE_API_TOKEN =
  (process.env.REPLICATE_API_TOKEN || "").trim();

const replicate = REPLICATE_API_TOKEN
  ? new Replicate({
      auth: REPLICATE_API_TOKEN
    })
  : null;

const MODEL =
  "wan-video/wan-2.5-t2v-fast";

const TMP_DIR = path.join(
  __dirname,
  "tmp"
);

const styles = {
  Realistic:
    "photorealistic live-action, realistic human movement, natural lighting, realistic camera motion",

  Cinematic:
    "cinematic live-action, professional film camera, dramatic lighting, smooth camera movement",

  Cartoon:
    "high quality 3D cartoon animation, expressive characters, smooth animation",

  "3D Animation":
    "high quality 3D animation, detailed environment, smooth camera movement",

  "AI Avatar":
    "professional digital presenter, realistic human movement, natural facial expressions"
};

const negativePrompt =
  "blurry, distorted, deformed, low quality, jittery, flickering, bad anatomy, unnatural motion";

/* =========================================================
   BASIC SETUP
========================================================= */

app.use(
  express.json({
    limit: "5mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "5mb"
  })
);

app.use(
  express.static(__dirname)
);

/* =========================================================
   DIRECTORY
========================================================= */

async function ensureTmp() {
  await fs.mkdir(
    TMP_DIR,
    {
      recursive: true
    }
  );
}

/* =========================================================
   VIDEO SIZE
========================================================= */

function getVideoSize(
  aspectRatio
) {
  switch (aspectRatio) {
    case "9:16":
      return "720*1280";

    case "1:1":
      return "720*720";

    case "16:9":
    default:
      return "1280*720";
  }
}

/* =========================================================
   REPLICATE AUTHENTICATION
========================================================= */

async function checkReplicateAuthentication() {
  if (!REPLICATE_API_TOKEN) {
    return {
      valid: false,
      reason:
        "REPLICATE_API_TOKEN is missing from Render."
    };
  }

  try {
    const response = await fetch(
      "https://api.replicate.com/v1/account",
      {
        method: "GET",
        headers: {
          Authorization:
            `Bearer ${REPLICATE_API_TOKEN}`,
          Accept:
            "application/json"
        }
      }
    );

    if (!response.ok) {
      return {
        valid: false,
        reason:
          `Replicate rejected the token. HTTP ${response.status}.`
      };
    }

    const account =
      await response.json();

    return {
      valid: true,
      account:
        account.username ||
        account.name ||
        "authenticated"
    };

  } catch (error) {
    return {
      valid: false,
      reason:
        `Could not connect to Replicate: ${error.message}`
    };
  }
}

/* =========================================================
   GET VIDEO URL FROM REPLICATE OUTPUT
========================================================= */

function getOutputUrl(output) {
  if (!output) {
    return null;
  }

  if (
    typeof output === "string"
  ) {
    return output;
  }

  if (
    typeof output.url === "function"
  ) {
    return output.url();
  }

  if (
    typeof output.url === "string"
  ) {
    return output.url;
  }

  if (
    Array.isArray(output) &&
    output.length
  ) {
    return getOutputUrl(
      output[0]
    );
  }

  return null;
}

/* =========================================================
   DOWNLOAD FILE
========================================================= */

async function downloadFile(
  url,
  destination
) {
  console.log(
    "MAMAKI: Downloading:",
    url
  );

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Video download failed. HTTP ${response.status}.`
    );
  }

  const data =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (data.length < 1000) {
    throw new Error(
      "Downloaded video is empty or invalid."
    );
  }

  await fs.writeFile(
    destination,
    data
  );

  console.log(
    "MAMAKI: Video downloaded:",
    data.length,
    "bytes"
  );
}

/* =========================================================
   GENERATE VIDEO WITH WAN 2.5 FAST
========================================================= */

async function generateVideo({
  prompt,
  duration,
  aspectRatio
}) {
  if (!replicate) {
    throw new Error(
      "REPLICATE_API_TOKEN is missing."
    );
  }

  const authentication =
    await checkReplicateAuthentication();

  if (!authentication.valid) {
    throw new Error(
      authentication.reason
    );
  }

  let seconds =
    Number(duration);

  if (
    !Number.isFinite(seconds)
  ) {
    seconds = 5;
  }

  seconds =
    Math.max(
      5,
      Math.min(
        10,
        Math.round(seconds)
      )
    );

  const size =
    getVideoSize(
      aspectRatio
    );

  console.log(
    "========================================"
  );

  console.log(
    "MAMAKI: WAN 2.5 FAST"
  );

  console.log(
    "MAMAKI: SIZE:",
    size
  );

  console.log(
    "MAMAKI: DURATION:",
    seconds
  );

  console.log(
    "MAMAKI: PROMPT:",
    prompt
  );

  console.log(
    "========================================"
  );

  const input = {
    size,
    prompt,
    duration: seconds,
    negative_prompt:
      negativePrompt,
    enable_prompt_expansion:
      true
  };

  const output =
    await replicate.run(
      MODEL,
      {
        input
      }
    );

  const videoUrl =
    getOutputUrl(
      output
    );

  if (!videoUrl) {
    throw new Error(
      "Wan 2.5 completed but did not return a video URL."
    );
  }

  return videoUrl;
}

/* =========================================================
   EDGE TTS
========================================================= */

async function generateVoice(
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

  console.log(
    "MAMAKI: Creating voice-over..."
  );

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
      "Edge TTS did not return audio."
    );
  }

  let audio;

  if (
    Buffer.isBuffer(
      result.audio
    )
  ) {
    audio =
      result.audio;

  } else if (
    result.audio instanceof
    Uint8Array
  ) {
    audio =
      Buffer.from(
        result.audio
      );

  } else if (
    typeof result.audio
      .arrayBuffer ===
    "function"
  ) {
    audio =
      Buffer.from(
        await result.audio
          .arrayBuffer()
      );

  } else {
    throw new Error(
      "Could not read Edge TTS audio."
    );
  }

  await fs.writeFile(
    destination,
    audio
  );

  console.log(
    "MAMAKI: Voice-over created."
  );
}

/* =========================================================
   FFMPEG
========================================================= */

function runFFmpeg(
  args
) {
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
                `FFmpeg failed: ${stderr.slice(-3000)}`
              )
            );
          }
        }
      );
    }
  );
}

/* =========================================================
   ADD VOICE TO VIDEO
========================================================= */

async function combineVideoAudio(
  video,
  audio,
  output
) {
  console.log(
    "MAMAKI: Combining video and voice..."
  );

  await runFFmpeg([
    "-y",

    "-i",
    video,

    "-i",
    audio,

    "-map",
    "0:v:0",

    "-map",
    "1:a:0",

    "-c:v",
    "copy",

    "-c:a",
    "aac",

    "-b:a",
    "128k",

    "-shortest",

    "-movflags",
    "+faststart",

    output
  ]);
}

/* =========================================================
   GENERATE ENDPOINT
========================================================= */

app.post(
  "/api/generate",
  async (req, res) => {
    const id =
      Date.now();

    let sourceVideo =
      null;

    let voiceFile =
      null;

    let finalVideo =
      null;

    try {
      await ensureTmp();

      const body =
        req.body || {};

      const rawPrompt =
        body.prompt ||
        body.description ||
        body.text ||
        "";

      const prompt =
        String(rawPrompt)
          .trim();

      if (!prompt) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Please enter a video prompt."
          });
      }

      const style =
        body.style ||
        "Realistic";

      const aspectRatio =
        body.aspectRatio ||
        body.aspect ||
        "9:16";

      const duration =
        body.duration ||
        5;

      const styleText =
        styles[style] ||
        styles.Realistic;

      const finalPrompt =
        `${styleText}. ${prompt}`;

      const voiceEnabled =
        !(
          body.voice === false ||
          body.voice === "false" ||
          body.voiceOver === false ||
          body.voiceOver === "false"
        );

      const narration =
        String(
          body.voiceText ||
          body.narration ||
          body.script ||
          prompt
        ).trim();

      sourceVideo =
        path.join(
          TMP_DIR,
          `source-${id}.mp4`
        );

      voiceFile =
        path.join(
          TMP_DIR,
          `voice-${id}.mp3`
        );

      finalVideo =
        path.join(
          TMP_DIR,
          `mamaki-${id}.mp4`
        );

      /* Generate */

      const videoUrl =
        await generateVideo({
          prompt:
            finalPrompt,
          duration,
          aspectRatio
        });

      /* Download */

      await downloadFile(
        videoUrl,
        sourceVideo
      );

      /* Voice */

      if (voiceEnabled) {
        await generateVoice(
          narration,
          voiceFile
        );

        await combineVideoAudio(
          sourceVideo,
          voiceFile,
          finalVideo
        );

      } else {
        await fs.copyFile(
          sourceVideo,
          finalVideo
        );
      }

      const videoEndpoint =
        `/api/video/${path.basename(
          finalVideo
        )}`;

      console.log(
        "MAMAKI: GENERATION SUCCESS"
      );

      return res.json({
        ok: true,

        success: true,

        videoUrl:
          videoEndpoint,

        url:
          videoEndpoint,

        voiceOver:
          voiceEnabled,

        message:
          "MAMAKI video generated successfully."
      });

    } catch (error) {
      console.error(
        "MAMAKI VIDEO ERROR:",
        error.message
      );

      return res
        .status(500)
        .json({
          ok: false,
          success: false,
          error:
            error.message ||
            "Video generation failed."
        });

    } finally {
      /* Delete temporary files,
         keep final MP4. */

      for (
        const file of [
          sourceVideo,
          voiceFile
        ]
      ) {
        if (file) {
          await fs
            .unlink(file)
            .catch(
              () => {}
            );
        }
      }
    }
  }
);

/* =========================================================
   VIDEO DELIVERY
========================================================= */

app.get(
  "/api/video/:filename",
  async (req, res) => {
    try {
      const filename =
        path.basename(
          req.params.filename
        );

      if (
        !filename.startsWith(
          "mamaki-"
        ) ||
        !filename.endsWith(
          ".mp4"
        )
      ) {
        return res
          .status(400)
          .send(
            "Invalid video."
          );
      }

      const file =
        path.join(
          TMP_DIR,
          filename
        );

      await fs.access(
        file
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
        file
      );

    } catch {
      return res
        .status(404)
        .send(
          "Video not found."
        );
    }
  }
);

/* =========================================================
   STATUS / AUTHENTICATION TEST
========================================================= */

app.get(
  "/api/status",
  async (req, res) => {
    const auth =
      await checkReplicateAuthentication();

    return res.json({
      ok:
        auth.valid,

      app:
        "MAMAKI AI VIDEO",

      engine:
        "Replicate Wan 2.5 T2V Fast",

      replicate:
        auth.valid,

      authentication:
        auth.valid
          ? "valid"
          : "invalid",

      account:
        auth.account ||
        null,

      error:
        auth.valid
          ? null
          : auth.reason,

      ffmpeg:
        Boolean(
          ffmpegPath
        ),

      voiceOver:
        true
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
      status:
        "ok",
      app:
        "MAMAKI AI VIDEO"
    });
  }
);

/* =========================================================
   FRONTEND
========================================================= */

app.get(
  "*",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "========================================"
    );

    console.log(
      "MAMAKI AI VIDEO"
    );

    console.log(
      `Running on port ${PORT}`
    );

    console.log(
      "Replicate token:",
      REPLICATE_API_TOKEN
        ? "FOUND"
        : "MISSING"
    );

    console.log(
      "Replicate model:",
      MODEL
    );

    console.log(
      "Voice-over: ENABLED"
    );

    console.log(
      "FFmpeg:",
      ffmpegPath
        ? "FOUND"
        : "MISSING"
    );

    console.log(
      "========================================"
    );
  }
);
