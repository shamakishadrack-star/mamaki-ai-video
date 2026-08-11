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

const LTX_SPACE =
  "https://deeprat-ltx-video-zerogpu-optimized.hf.space";

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
   GRADIO FILE URL
========================================================= */

function makeFileUrl(value) {
  if (!value) return null;

  if (typeof value === "object") {
    if (value.url) {
      return makeFileUrl(value.url);
    }

    if (value.path) {
      return makeFileUrl(value.path);
    }

    if (value.file) {
      return makeFileUrl(value.file);
    }

    if (value.video) {
      return makeFileUrl(value.video);
    }

    return null;
  }

  if (typeof value !== "string") {
    return null;
  }

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

  if (text.startsWith("/gradio_api/file=")) {
    return `${LTX_SPACE}${text}`;
  }

  if (text.startsWith("/file=")) {
    return `${LTX_SPACE}/gradio_api${text}`;
  }

  return `${LTX_SPACE}/gradio_api/file=${encodeURIComponent(text)}`;
}

/* =========================================================
   FIND VIDEO
========================================================= */

function findVideo(value, seen = new Set()) {
  if (
    value === null ||
    value === undefined
  ) {
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
      text.includes(".mp4") ||
      text.includes(".webm") ||
      text.includes(".mov") ||
      text.includes("/tmp/") ||
      text.includes("/home/") ||
      text.includes("/app/")
    ) {
      return makeFileUrl(text);
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

  if (value.path) {
    const result =
      makeFileUrl(value.path);

    if (result) return result;
  }

  if (value.url) {
    const result =
      makeFileUrl(value.url);

    if (result) return result;
  }

  if (value.video) {
    const result =
      findVideo(value.video, seen);

    if (result) return result;
  }

  if (value.file) {
    const result =
      findVideo(value.file, seen);

    if (result) return result;
  }

  if (value.output) {
    const result =
      findVideo(value.output, seen);

    if (result) return result;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const result =
        findVideo(item, seen);

      if (result) return result;
    }

    return null;
  }

  for (const key of Object.keys(value)) {
    const result =
      findVideo(value[key], seen);

    if (result) return result;
  }

  return null;
}

/* =========================================================
   READ ERROR INFORMATION
========================================================= */

function getErrorMessage(data) {
  if (!data) {
    return null;
  }

  if (typeof data === "string") {
    return data;
  }

  if (data.error) {
    return String(data.error);
  }

  if (data.message) {
    return String(data.message);
  }

  if (data.detail) {
    return String(data.detail);
  }

  if (data.reason) {
    return String(data.reason);
  }

  try {
    return JSON.stringify(data);
  } catch {
    return null;
  }
}

/* =========================================================
   PROCESS SSE
========================================================= */

function processSSEEvent(eventText) {
  if (
    !eventText ||
    !eventText.trim()
  ) {
    return null;
  }

  console.log(
    "--------------------------------"
  );

  console.log(
    "MAMAKI: COMPLETE SSE EVENT:"
  );

  console.log(
    eventText.slice(0, 15000)
  );

  console.log(
    "--------------------------------"
  );

  const lines =
    eventText.split(/\r?\n/);

  let eventType = "message";
  let rawData = "";

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType =
        line.slice(6).trim();
    }

    if (line.startsWith("data:")) {
      const part =
        line.slice(5).trim();

      if (rawData) {
        rawData += "\n";
      }

      rawData += part;
    }
  }

  console.log(
    "MAMAKI: EVENT TYPE:",
    eventType
  );

  console.log(
    "MAMAKI: DATA:",
    rawData || "(empty)"
  );

  let data = rawData;

  if (rawData) {
    try {
      data = JSON.parse(rawData);
    } catch {
      data = rawData;
    }
  }

  /* Try video first */

  const video =
    findVideo(data);

  if (video) {
    console.log(
      "MAMAKI: VIDEO FOUND:",
      video
    );

    return {
      type: "video",
      value: video
    };
  }

  /* Handle errors */

  if (
    eventType === "error" ||
    eventType === "process_error"
  ) {
    const message =
      getErrorMessage(data);

    return {
      type: "error",
      value:
        message ||
        "The LTX Space returned an error without a message."
    };
  }

  /* Successful completion without video */

  if (
    eventType === "complete"
  ) {
    return {
      type: "complete",
      value: data
    };
  }

  return null;
}

/* =========================================================
   READ SSE
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

  const reader =
    response.body.getReader();

  const decoder =
    new TextDecoder();

  let buffer = "";
  let timeoutTriggered = false;

  const timeout =
    setTimeout(() => {
      timeoutTriggered = true;

      reader
        .cancel()
        .catch(() => {});
    }, timeoutMs);

  try {
    while (true) {
      const {
        value,
        done
      } = await reader.read();

      if (done) {
        break;
      }

      buffer +=
        decoder.decode(
          value,
          {
            stream: true
          }
        );

      const events =
        buffer.split(
          /\r?\n\r?\n/
        );

      buffer =
        events.pop() || "";

      for (
        const eventText of events
      ) {
        const result =
          processSSEEvent(
            eventText
          );

        if (!result) {
          continue;
        }

        if (
          result.type ===
          "video"
        ) {
          return result.value;
        }

        if (
          result.type ===
          "error"
        ) {
          throw new Error(
            `LTX Space error: ${result.value}`
          );
        }
      }
    }

    buffer +=
      decoder.decode();

    if (buffer.trim()) {
      const result =
        processSSEEvent(buffer);

      if (
        result?.type ===
        "video"
      ) {
        return result.value;
      }

      if (
        result?.type ===
        "error"
      ) {
        throw new Error(
          `LTX Space error: ${result.value}`
        );
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  if (timeoutTriggered) {
    throw new Error(
      "LTX generation timed out after 10 minutes."
    );
  }

  throw new Error(
    "LTX finished without returning a video file."
  );
}

/* =========================================================
   GENERATE LTX
========================================================= */

async function generateWithLTX(
  prompt,
  aspectRatio,
  duration
) {
  const {
    width,
    height
  } = getDimensions(
    aspectRatio
  );

  /*
   IMPORTANT:
   The previous logs showed the frontend
   sending 5 seconds even when 2 seconds
   was selected.

   We now clamp everything safely.
  */

  let safeDuration =
    Number(duration);

  if (
    !Number.isFinite(
      safeDuration
    )
  ) {
    safeDuration = 2;
  }

  safeDuration =
    Math.min(
      8,
      Math.max(
        0.3,
        safeDuration
      )
    );

  const seed =
    Math.floor(
      Math.random() *
      4294967295
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
    seed,
    true,
    3.0,
    false,
    false
  ];

  console.log(
    "================================"
  );

  console.log(
    "MAMAKI: LTX REQUEST"
  );

  console.log(
    "MAMAKI: PROMPT:",
    prompt
  );

  console.log(
    "MAMAKI: WIDTH:",
    width
  );

  console.log(
    "MAMAKI: HEIGHT:",
    height
  );

  console.log(
    "MAMAKI: DURATION:",
    safeDuration
  );

  console.log(
    "MAMAKI: SEED:",
    seed
  );

  console.log(
    "MAMAKI: INPUT COUNT:",
    inputData.length
  );

  console.log(
    "================================"
  );

  /* Start job */

  const startResponse =
    await fetch(
      `${LTX_SPACE}/gradio_api/call/text_to_video`,
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

  const startText =
    await startResponse.text();

  console.log(
    "MAMAKI: START STATUS:",
    startResponse.status
  );

  console.log(
    "MAMAKI: START RESPONSE:",
    startText.slice(
      0,
      10000
    )
  );

  if (!startResponse.ok) {
    throw new Error(
      `LTX start request failed (${startResponse.status}): ${startText.slice(
        0,
        4000
      )}`
    );
  }

  let job;

  try {
    job =
      JSON.parse(
        startText
      );
  } catch {
    throw new Error(
      `LTX returned invalid job data: ${startText.slice(
        0,
        4000
      )}`
    );
  }

  if (!job?.event_id) {
    throw new Error(
      `LTX did not return an event ID. Response: ${JSON.stringify(
        job
      )}`
    );
  }

  console.log(
    "MAMAKI: EVENT ID:",
    job.event_id
  );

  /* Wait for result */

  const resultResponse =
    await fetch(
      `${LTX_SPACE}/gradio_api/call/text_to_video/${encodeURIComponent(
        job.event_id
      )}`,
      {
        headers: {
          Accept:
            "text/event-stream"
        }
      }
    );

  console.log(
    "MAMAKI: RESULT STATUS:",
    resultResponse.status
  );

  if (!resultResponse.ok) {
    const text =
      await resultResponse.text();

    throw new Error(
      `LTX result request failed (${resultResponse.status}): ${text.slice(
        0,
        5000
      )}`
    );
  }

  return await readSSE(
    resultResponse,
    600000
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
    "MAMAKI: DOWNLOADING VIDEO:"
  );

  console.log(
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

  if (
    buffer.length < 1000
  ) {
    throw new Error(
      "LTX returned an invalid video file."
    );
  }

  await fs.writeFile(
    outputPath,
    buffer
  );

  console.log(
    "MAMAKI: VIDEO SAVED:",
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
    "MAMAKI: GENERATING VOICE..."
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
    Buffer.isBuffer(
      result.audio
    )
  ) {
    audioBuffer =
      result.audio;
  } else if (
    result.audio instanceof
    Uint8Array
  ) {
    audioBuffer =
      Buffer.from(
        result.audio
      );
  } else if (
    typeof result.audio
      .arrayBuffer ===
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

  await fs.writeFile(
    outputPath,
    audioBuffer
  );

  console.log(
    "MAMAKI: VOICE CREATED."
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

      const child =
        spawn(
          ffmpegPath,
          args
        );

      let stderr = "";

      child.stderr.on(
        "data",
        (data) => {
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
    "MAMAKI: MERGING VIDEO AND VOICE..."
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
      const body =
        req.body || {};

      const prompt =
        typeof body.prompt ===
        "string"
          ? body.prompt
          : "";

      const voiceText =
        typeof body.voiceText ===
        "string"
          ? body.voiceText
          : "";

      const style =
        body.style ||
        "Realistic";

      const aspectRatio =
        body.aspectRatio ||
        "9:16";

      /*
       If frontend sends nothing,
       use 2 seconds instead of 5.
      */

      let duration =
        Number(
          body.duration
        );

      if (
        !Number.isFinite(
          duration
        )
      ) {
        duration = 2;
      }

      duration =
        Math.min(
          8,
          Math.max(
            0.3,
            duration
          )
        );

      const voice =
        body.voice !== false;

      console.log(
        "================================"
      );

      console.log(
        "MAMAKI: API REQUEST"
      );

      console.log(
        "MAMAKI: REQUEST BODY:",
        JSON.stringify(body)
      );

      console.log(
        "MAMAKI: FINAL DURATION:",
        duration
      );

      console.log(
        "================================"
      );

      if (!prompt.trim()) {
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
        styles.Realistic;

      const finalPrompt =
        `${stylePrompt}. ${prompt.trim()}`;

      /* 1. LTX */

      const videoUrl =
        await generateWithLTX(
          finalPrompt,
          aspectRatio,
          duration
        );

      /* 2. Download */

      await downloadVideo(
        videoUrl,
        videoPath
      );

      /* 3. Voice text */

      const narration =
        voiceText.trim()
          ? voiceText.trim()
          : prompt.trim();

      /* 4. Voice */

      if (voice) {
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

      const finalUrl =
        `/api/video/${path.basename(
          finalPath
        )}`;

      console.log(
        "================================"
      );

      console.log(
        "MAMAKI: SUCCESS"
      );

      console.log(
        "MAMAKI VIDEO:",
        finalUrl
      );

      console.log(
        "================================"
      );

      return res.json({
        ok: true,

        videoUrl:
          finalUrl,

        voiceOver:
          voice,

        message:
          voice
            ? "Video and AI voice-over generated successfully."
            : "Video generated successfully."
      });

    } catch (error) {
      console.error(
        "================================"
      );

      console.error(
        "MAMAKI VIDEO ERROR:"
      );

      console.error(
        error
      );

      console.error(
        "================================"
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

        for (
          const file of files
        ) {
          if (
            file.startsWith(
              "ltx-"
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
        /* Ignore */
      }
    }
  }
);

/* =========================================================
   VIDEO ROUTE
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
   START
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `MAMAKI AI VIDEO running on port ${PORT}`
    );
  }
);
