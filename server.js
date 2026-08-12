import "dotenv/config";
import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { EdgeTTS } from "edge-tts-universal";
import ffmpegPath from "ffmpeg-static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static("."));

const PORT = process.env.PORT || 3000;

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

const REPLICATE_MODEL =
  "wan-video/wan-2.5-t2v-fast";

const NEGATIVE_PROMPT =
  "worst quality, blurry, jittery, distorted, deformed, low quality, flickering";

const styles = {
  Realistic:
    "photorealistic live-action, natural motion, realistic lighting",

  Cinematic:
    "cinematic film look, professional camera movement, dramatic lighting",

  Cartoon:
    "high-quality 3D cartoon animation, expressive characters",

  "3D Animation":
    "high-quality 3D animated scene, smooth camera movement",

  "AI Avatar":
    "professional digital presenter avatar, natural movement"
};

/* =========================================================
   DIMENSIONS
========================================================= */

function getSize(aspectRatio) {
  if (aspectRatio === "9:16") {
    return "720*1280";
  }

  if (aspectRatio === "1:1") {
    return "720*720";
  }

  return "1280*720";
}

/* =========================================================
   REPLICATE VIDEO GENERATION
========================================================= */

async function generateWithReplicate(
  prompt,
  aspectRatio,
  duration
) {
  if (!REPLICATE_API_TOKEN) {
    throw new Error(
      "REPLICATE_API_TOKEN is missing. Add it to Render Environment Variables."
    );
  }

  let safeDuration = Number(duration);

  if (!Number.isFinite(safeDuration)) {
    safeDuration = 5;
  }

  /*
   Wan 2.5 T2V Fast currently requires
   at least 5 seconds.
  */
  safeDuration = Math.min(
    10,
    Math.max(5, Math.round(safeDuration))
  );

  const size = getSize(aspectRatio);

  console.log("================================");
  console.log("MAMAKI: STARTING REPLICATE");
  console.log("MAMAKI: MODEL:", REPLICATE_MODEL);
  console.log("MAMAKI: PROMPT:", prompt);
  console.log("MAMAKI: SIZE:", size);
  console.log("MAMAKI: DURATION:", safeDuration);
  console.log("================================");

  const response = await fetch(
    "https://api.replicate.com/v1/models/wan-video/wan-2.5-t2v-fast/predictions",
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
        Prefer: "wait=60"
      },

      body: JSON.stringify({
        input: {
          prompt,
          negative_prompt: NEGATIVE_PROMPT,
          size,
          duration: safeDuration,
          enable_prompt_expansion: true
        }
      })
    }
  );

  const responseText = await response.text();

  console.log(
    "MAMAKI: REPLICATE STATUS:",
    response.status
  );

  console.log(
    "MAMAKI: REPLICATE RESPONSE:",
    responseText.slice(0, 10000)
  );

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Replicate returned invalid JSON: ${responseText.slice(
        0,
        1000
      )}`
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.detail ||
      data?.error ||
      `Replicate request failed (${response.status}).`
    );
  }

  /*
   Replicate normally returns:
   output: "https://replicate.delivery/.../output.mp4"
  */

  if (typeof data?.output === "string") {
    return data.output;
  }

  /*
   Some responses may contain an array.
  */

  if (
    Array.isArray(data?.output) &&
    data.output.length > 0
  ) {
    const first = data.output[0];

    if (typeof first === "string") {
      return first;
    }

    if (first?.url) {
      return first.url;
    }
  }

  /*
   If the prediction is still processing,
   poll it until finished.
  */

  if (data?.id) {
    return await waitForReplicatePrediction(
      data.id
    );
  }

  throw new Error(
    "Replicate completed without returning a video URL."
  );
}

/* =========================================================
   WAIT FOR REPLICATE PREDICTION
========================================================= */

async function waitForReplicatePrediction(
  predictionId
) {
  console.log(
    "MAMAKI: Waiting for Replicate prediction:",
    predictionId
  );

  const maxAttempts = 120;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((resolve) =>
      setTimeout(resolve, 3000)
    );

    const response = await fetch(
      `https://api.replicate.com/v1/predictions/${encodeURIComponent(
        predictionId
      )}`,
      {
        headers: {
          Authorization:
            `Bearer ${REPLICATE_API_TOKEN}`
        }
      }
    );

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        "Replicate returned invalid prediction data."
      );
    }

    console.log(
      `MAMAKI: REPLICATE STATUS ${attempt}:`,
      data?.status
    );

    if (data?.status === "succeeded") {
      if (typeof data.output === "string") {
        return data.output;
      }

      if (
        Array.isArray(data.output) &&
        data.output.length > 0
      ) {
        const first = data.output[0];

        if (typeof first === "string") {
          return first;
        }

        if (first?.url) {
          return first.url;
        }
      }

      throw new Error(
        "Replicate succeeded but returned no video URL."
      );
    }

    if (
      data?.status === "failed" ||
      data?.status === "canceled"
    ) {
      throw new Error(
        data?.error ||
        `Replicate video generation ${data.status}.`
      );
    }
  }

  throw new Error(
    "Replicate video generation timed out."
  );
}

/* =========================================================
   DOWNLOAD VIDEO
========================================================= */

async function downloadVideo(
  videoUrl,
  outputPath
) {
  console.log(
    "MAMAKI: Downloading video:",
    videoUrl
  );

  const response = await fetch(videoUrl);

  if (!response.ok) {
    throw new Error(
      `Unable to download generated video (${response.status}).`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (buffer.length < 1000) {
    throw new Error(
      "Replicate returned an invalid video file."
    );
  }

  await fs.writeFile(
    outputPath,
    buffer
  );

  console.log(
    "MAMAKI: Video saved:",
    outputPath
  );
}

/* =========================================================
   EDGE TTS VOICE
========================================================= */

async function generateVoice(
  text,
  outputPath
) {
  const cleanText = String(text || "").trim();

  if (!cleanText) {
    throw new Error(
      "Voice-over text is empty."
    );
  }

  console.log(
    "MAMAKI: Generating AI voice..."
  );

  const tts = new EdgeTTS(
    cleanText,
    "en-US-AriaNeural",
    {
      rate: "+0%",
      volume: "+0%",
      pitch: "+0Hz"
    }
  );

  const result = await tts.synthesize();

  if (!result || !result.audio) {
    throw new Error(
      "Edge TTS returned no audio."
    );
  }

  let audioBuffer;

  if (Buffer.isBuffer(result.audio)) {
    audioBuffer = result.audio;
  } else if (
    result.audio instanceof Uint8Array
  ) {
    audioBuffer = Buffer.from(
      result.audio
    );
  } else if (
    typeof result.audio.arrayBuffer ===
    "function"
  ) {
    audioBuffer = Buffer.from(
      await result.audio.arrayBuffer()
    );
  } else {
    throw new Error(
      "Unable to read Edge TTS audio."
    );
  }

  if (audioBuffer.length < 1000) {
    throw new Error(
      "Generated voice file is too small."
    );
  }

  await fs.writeFile(
    outputPath,
    audioBuffer
  );

  console.log(
    "MAMAKI: Voice created."
  );
}

/* =========================================================
   FFMPEG
========================================================= */

function runFFmpeg(args) {
  return new Promise(
    (resolve, reject) => {
      if (!ffmpegPath) {
        reject(
          new Error(
            "FFmpeg binary was not found."
          )
        );
        return;
      }

      const process = spawn(
        ffmpegPath,
        args
      );

      let stderr = "";

      process.stderr.on(
        "data",
        (data) => {
          stderr += data.toString();
        }
      );

      process.on(
        "error",
        reject
      );

      process.on(
        "close",
        (code) => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(
            new Error(
              `FFmpeg failed with code ${code}: ${stderr.slice(
                -5000
              )}`
            )
          );
        }
      );
    }
  );
}

/* =========================================================
   MERGE VIDEO + VOICE
========================================================= */

async function mergeVideoAndVoice(
  videoPath,
  audioPath,
  outputPath
) {
  console.log(
    "MAMAKI: Combining video + AI voice..."
  );

  await runFFmpeg([
    "-y",

    "-i",
    videoPath,

    "-i",
    audioPath,

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

    outputPath
  ]);

  console.log(
    "MAMAKI: Final video created."
  );
}

/* =========================================================
   GENERATE API
========================================================= */

app.post(
  "/api/generate",
  async (req, res) => {
    const workDir = path.join(
      __dirname,
      "tmp"
    );

    let videoPath = null;
    let audioPath = null;
    let finalPath = null;

    try {
      const {
        prompt,
        voiceText,
        style = "Realistic",
        aspectRatio = "9:16",
        duration = 5,
        voice = true
      } = req.body || {};

      if (
        typeof prompt !== "string" ||
        !prompt.trim()
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Please describe your video."
        });
      }

      await fs.mkdir(
        workDir,
        {
          recursive: true
        }
      );

      const timestamp =
        Date.now();

      videoPath = path.join(
        workDir,
        `replicate-${timestamp}.mp4`
      );

      audioPath = path.join(
        workDir,
        `voice-${timestamp}.mp3`
      );

      finalPath = path.join(
        workDir,
        `mamaki-${timestamp}.mp4`
      );

      const stylePrompt =
        styles[style] ||
        "high-quality video";

      const finalPrompt =
        `${stylePrompt}. ${prompt.trim()}`;

      console.log(
        "================================"
      );

      console.log(
        "MAMAKI AI VIDEO"
      );

      console.log(
        "ENGINE: REPLICATE WAN 2.5"
      );

      console.log(
        "================================"
      );

      /* 1. Generate video */

      const videoUrl =
        await generateWithReplicate(
          finalPrompt,
          aspectRatio,
          duration
        );

      if (!videoUrl) {
        throw new Error(
          "Replicate returned no video URL."
        );
      }

      /* 2. Download video */

      await downloadVideo(
        videoUrl,
        videoPath
      );

      /* 3. Narration text */

      const narration =
        typeof voiceText === "string" &&
        voiceText.trim()
          ? voiceText.trim()
          : prompt.trim();

      /* 4. Voice-over */

      if (voice !== false) {
        await generateVoice(
          narration,
          audioPath
        );

        /* 5. Merge */

        await mergeVideoAndVoice(
          videoPath,
          audioPath,
          finalPath
        );
      } else {
        await fs.copyFile(
          videoPath,
          finalPath
        );
      }

      /* 6. Return */

      const finalUrl =
        `/api/video/${path.basename(
          finalPath
        )}`;

      console.log(
        "================================"
      );

      console.log(
        "MAMAKI: GENERATION SUCCESSFUL"
      );

      console.log(
        "VIDEO:",
        finalUrl
      );

      console.log(
        "VOICE:",
        voice !== false
      );

      console.log(
        "================================"
      );

      return res.json({
        ok: true,

        videoUrl: finalUrl,

        voiceOver:
          voice !== false,

        message:
          voice !== false
            ? "Video and AI voice-over generated successfully."
            : "Video generated successfully."
      });

    } catch (error) {
      console.error(
        "================================"
      );

      console.error(
        "MAMAKI VIDEO ERROR:",
        error
      );

      console.error(
        "================================"
      );

      return res.status(500).json({
        ok: false,

        error:
          error?.message ||
          "Video generation failed."
      });

    } finally {

      /*
       Keep the final mamaki-*.mp4 file
       so the browser can play it.

       Delete temporary source video
       and voice files.
      */

      try {
        const files =
          await fs.readdir(
            workDir
          );

        for (
          const file of files
        ) {
          if (
            file.startsWith(
              "replicate-"
            ) ||
            file.startsWith(
              "voice-"
            )
          ) {
            await fs.unlink(
              path.join(
                workDir,
                file
              )
            ).catch(
              () => {}
            );
          }
        }
      } catch {
        /* Ignore cleanup errors */
      }
    }
  }
);

/* =========================================================
   SERVE FINAL VIDEO
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
            "Invalid video filename."
          );
      }

      const videoPath =
        path.join(
          __dirname,
          "tmp",
          filename
        );

      try {
        await fs.access(
          videoPath
        );
      } catch {
        return res
          .status(404)
          .send(
            "Video not found."
          );
      }

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${filename}"`
      );

      return res.sendFile(
        videoPath
      );

    } catch (error) {
      console.error(
        "MAMAKI SERVE ERROR:",
        error
      );

      return res
        .status(500)
        .send(
          "Unable to serve video."
        );
    }
  }
);

/* =========================================================
   STATUS
========================================================= */

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      ok: true,

      app:
        "MAMAKI AI VIDEO",

      api:
        "running",

      engine:
        "Replicate Wan 2.5 T2V Fast + Edge TTS + FFmpeg",

      replicate:
        Boolean(
          REPLICATE_API_TOKEN
        ),

      ffmpeg:
        Boolean(ffmpegPath),

      voice:
        true
    });
  }
);

/* =========================================================
   FRONTEND
========================================================= */

app.get(
  /.*/,
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
   START
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `MAMAKI AI VIDEO running on port ${PORT}`
    );

    console.log(
      "MAMAKI: Replicate:",
      Boolean(
        REPLICATE_API_TOKEN
      )
    );

    console.log(
      "MAMAKI: FFmpeg:",
      Boolean(ffmpegPath)
    );

    console.log(
      "MAMAKI: Voice-over: ENABLED"
    );
  }
);
