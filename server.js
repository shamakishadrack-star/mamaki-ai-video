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
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

/*
  IMPORTANT:
  Keep this as a normal string.
  Do NOT write ${LTX_SPACE} outside JavaScript.
*/
const LTX_SPACE =
  "https://deeprat-ltx-video-zerogpu-optimized.hf.space";

const LTX_API =
  LTX_SPACE + "/gradio_api/call/text_to_video";

const NEGATIVE_PROMPT =
  "worst quality, inconsistent motion, blurry, jittery, distorted, deformed";

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

function getDimensions(aspectRatio) {
  if (aspectRatio === "9:16") {
    return {
      width: 400,
      height: 704
    };
  }

  if (aspectRatio === "1:1") {
    return {
      width: 512,
      height: 512
    };
  }

  return {
    width: 704,
    height: 400
  };
}

/* =========================================================
   FIND VIDEO IN GRADIO RESPONSE
========================================================= */

function findVideo(value, seen = new Set()) {
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    const text = value.trim();

    if (!text) {
      return null;
    }

    if (
      text.startsWith("http://") ||
      text.startsWith("https://")
    ) {
      return text;
    }

    if (
      /\.(mp4|webm|mov)(\?|$)/i.test(text) ||
      text.includes("/tmp/") ||
      text.includes("/home/") ||
      text.includes("/app/")
    ) {
      return (
        LTX_SPACE +
        "/gradio_api/file=" +
        encodeURIComponent(text)
      );
    }

    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }

  seen.add(value);

  const keys = [
    "video",
    "file",
    "output",
    "result",
    "data",
    "url",
    "path"
  ];

  for (const key of keys) {
    if (key in value) {
      const found = findVideo(value[key], seen);

      if (found) {
        return found;
      }
    }
  }

  for (const key of Object.keys(value)) {
    const found = findVideo(value[key], seen);

    if (found) {
      return found;
    }
  }

  return null;
}

/* =========================================================
   PROCESS GRADIO SSE
========================================================= */

function processSSEEvent(eventText) {
  if (!eventText || !eventText.trim()) {
    return null;
  }

  const lines = eventText.split(/\r?\n/);

  let eventType = "message";
  let rawData = "";

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    }

    if (line.startsWith("data:")) {
      const part = line.slice(5).trim();

      if (rawData) {
        rawData += "\n";
      }

      rawData += part;
    }
  }

  if (!rawData || rawData === "null") {
    return null;
  }

  console.log("MAMAKI: LTX EVENT:", eventType);
  console.log(
    "MAMAKI: LTX DATA:",
    rawData.slice(0, 8000)
  );

  let data;

  try {
    data = JSON.parse(rawData);
  } catch {
    data = rawData;
  }

  const video = findVideo(data);

  if (video) {
    console.log(
      "MAMAKI: VIDEO FOUND:",
      video
    );

    return video;
  }

  if (
    eventType === "error" ||
    eventType === "process_error"
  ) {
    let message = "LTX video generation failed.";

    if (typeof data === "string") {
      message = data;
    } else if (data?.error) {
      message = data.error;
    } else if (data?.message) {
      message = data.message;
    }

    throw new Error(message);
  }

  return null;
}

/* =========================================================
   READ SSE STREAM
========================================================= */

async function readSSE(
  response,
  timeoutMs = 600000
) {
  if (!response.body) {
    throw new Error(
      "LTX returned no event stream."
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, timeoutMs);

  try {
    while (true) {
      const { value, done } =
        await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(
        value,
        { stream: true }
      );

      const events =
        buffer.split(/\r?\n\r?\n/);

      buffer =
        events.pop() || "";

      for (const eventText of events) {
        const video =
          processSSEEvent(eventText);

        if (video) {
          return video;
        }
      }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
      const video =
        processSSEEvent(buffer);

      if (video) {
        return video;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  if (timedOut) {
    throw new Error(
      "LTX generation timed out."
    );
  }

  throw new Error(
    "LTX completed, but no video file was returned."
  );
}

/* =========================================================
   GENERATE VIDEO WITH LTX
========================================================= */

async function generateWithLTX(
  prompt,
  aspectRatio,
  duration
) {
  const {
    width,
    height
  } = getDimensions(aspectRatio);

  let safeDuration =
    Number(duration);

  if (!Number.isFinite(safeDuration)) {
    safeDuration = 2;
  }

  safeDuration = Math.min(
    8,
    Math.max(0.3, safeDuration)
  );

  console.log(
    "MAMAKI: Starting LTX..."
  );

  console.log(
    "MAMAKI: LTX endpoint:",
    LTX_API
  );

  console.log(
    "MAMAKI: Size:",
    width,
    "x",
    height
  );

  console.log(
    "MAMAKI: Duration:",
    safeDuration
  );

  const inputData = [
    prompt,
    NEGATIVE_PROMPT,
    null,
    null,
    height,
    width,
    "text-to-video",
    safeDuration,
    9,
    Math.floor(
      Math.random() * 4294967295
    ),
    true,
    3.0,
    false,
    false
  ];

  const startResponse =
    await fetch(
      LTX_API,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Accept:
            "application/json"
        },

        body: JSON.stringify({
          data: inputData
        })
      }
    );

  if (!startResponse.ok) {
    const text =
      await startResponse.text();

    throw new Error(
      `LTX start failed (${startResponse.status}): ${text.slice(
        0,
        3000
      )}`
    );
  }

  const job =
    await startResponse.json();

  console.log(
    "MAMAKI: LTX JOB:",
    JSON.stringify(job)
  );

  if (!job?.event_id) {
    throw new Error(
      "LTX did not return an event ID."
    );
  }

  const resultURL =
    LTX_SPACE +
    "/gradio_api/call/text_to_video/" +
    encodeURIComponent(
      job.event_id
    );

  console.log(
    "MAMAKI: LTX RESULT URL:",
    resultURL
  );

  const resultResponse =
    await fetch(
      resultURL,
      {
        headers: {
          Accept:
            "text/event-stream"
        }
      }
    );

  if (!resultResponse.ok) {
    const text =
      await resultResponse.text();

    throw new Error(
      `LTX result failed (${resultResponse.status}): ${text.slice(
        0,
        3000
      )}`
    );
  }

  return await readSSE(
    resultResponse
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

  const response =
    await fetch(videoUrl);

  if (!response.ok) {
    throw new Error(
      `Unable to download LTX video (${response.status}).`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (buffer.length < 1000) {
    throw new Error(
      "LTX returned an invalid video file."
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
   EDGE TTS
========================================================= */

async function generateVoice(
  text,
  outputPath
) {
  const cleanText =
    String(text || "").trim();

  if (!cleanText) {
    throw new Error(
      "Voice-over text is empty."
    );
  }

  console.log(
    "MAMAKI: Generating AI voice..."
  );

  const tts =
    new EdgeTTS(
      cleanText,
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
      "Edge TTS returned no audio."
    );
  }

  let audioBuffer;

  if (
    Buffer.isBuffer(result.audio)
  ) {
    audioBuffer =
      result.audio;
  } else if (
    result.audio instanceof
    Uint8Array
  ) {
    audioBuffer =
      Buffer.from(result.audio);
  } else if (
    typeof result.audio.arrayBuffer ===
    "function"
  ) {
    audioBuffer =
      Buffer.from(
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

      const process =
        spawn(
          ffmpegPath,
          args
        );

      let stderr = "";

      process.stderr.on(
        "data",
        (data) => {
          stderr +=
            data.toString();
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
                -4000
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
    "MAMAKI: Combining video and voice..."
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
    "MAMAKI: FINAL VIDEO CREATED:",
    outputPath
  );
}

/* =========================================================
   GENERATE API
========================================================= */

app.post(
  "/api/generate",
  async (req, res) => {
    const workDir =
      path.join(
        __dirname,
        "tmp"
      );

    try {
      const {
        prompt,
        voiceText,
        style = "Realistic",
        aspectRatio = "9:16",
        duration = 2,
        voice = true
      } = req.body || {};

      if (
        typeof prompt !== "string" ||
        !prompt.trim()
      ) {
        return res
          .status(400)
          .json({
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

      const videoPath =
        path.join(
          workDir,
          `ltx-${timestamp}.mp4`
        );

      const audioPath =
        path.join(
          workDir,
          `voice-${timestamp}.mp3`
        );

      const finalPath =
        path.join(
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
        "MAMAKI AI VIDEO GENERATION"
      );

      console.log(
        "================================"
      );

      /* 1. Generate video */

      const ltxVideoUrl =
        await generateWithLTX(
          finalPrompt,
          aspectRatio,
          duration
        );

      /* 2. Download */

      await downloadVideo(
        ltxVideoUrl,
        videoPath
      );

      /* 3. Narration */

      const narration =
        typeof voiceText === "string" &&
        voiceText.trim()
          ? voiceText.trim()
          : prompt.trim();

      /* 4. Voice */

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
        "/api/video/" +
        path.basename(finalPath);

      console.log(
        "MAMAKI: GENERATION SUCCESSFUL"
      );

      return res.json({
        ok: true,

        videoUrl:
          finalUrl,

        voiceOver:
          voice !== false,

        message:
          voice !== false
            ? "Video and AI voice-over generated successfully."
            : "Video generated successfully."
      });

    } catch (error) {
      console.error(
        "MAMAKI VIDEO ERROR:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ||
            "Video generation failed."
        });

    } finally {
      try {
        const files =
          await fs.readdir(
            workDir
          );

        for (const file of files) {
          if (
            file.startsWith("ltx-") ||
            file.startsWith("voice-")
          ) {
            await fs.unlink(
              path.join(
                workDir,
                file
              )
            ).catch(() => {});
          }
        }
      } catch {
        // Ignore cleanup errors.
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
        "LTX Video + Edge TTS + FFmpeg",

      ffmpeg:
        Boolean(ffmpegPath)
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
   START SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `MAMAKI AI VIDEO running on port ${PORT}`
    );

    console.log(
      "MAMAKI LTX endpoint:",
      LTX_API
    );
  }
);
