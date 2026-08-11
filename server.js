import "dotenv/config";
import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { ttsSave } from "edge-tts";
import ffmpegPath from "ffmpeg-static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 10000;

const LTX_SPACE =
  "https://deeprat-ltx-video-zerogpu-optimized.hf.space";

const NEGATIVE_PROMPT =
  "worst quality, blurry, distorted, jittery, inconsistent motion, bad anatomy";

const styles = {
  Realistic:
    "photorealistic live-action, natural realistic motion, realistic lighting",

  Cinematic:
    "cinematic film look, professional camera movement, dramatic lighting",

  Cartoon:
    "high quality 3D cartoon animation, expressive characters, smooth motion",

  "3D Animation":
    "high quality 3D animated scene, smooth camera movement",

  "AI Avatar":
    "professional digital presenter, realistic human movement, studio lighting"
};

function getDimensions(aspectRatio) {
  if (aspectRatio === "9:16") {
    return { width: 400, height: 704 };
  }

  if (aspectRatio === "1:1") {
    return { width: 512, height: 512 };
  }

  return { width: 704, height: 400 };
}

/* =========================================================
   FIND A VIDEO FILE ANYWHERE INSIDE GRADIO RESPONSE
   ========================================================= */

function findVideo(value, visited = new Set()) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const text = value.trim();

    if (!text) {
      return null;
    }

    /*
     * Sometimes Gradio returns JSON as a string.
     */
    if (
      (text.startsWith("{") && text.endsWith("}")) ||
      (text.startsWith("[") && text.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(text);
        const nested = findVideo(parsed, visited);

        if (nested) {
          return nested;
        }
      } catch {}
    }

    if (
      text.startsWith("http://") ||
      text.startsWith("https://")
    ) {
      if (
        text.includes(".mp4") ||
        text.includes("/file=") ||
        text.includes("video")
      ) {
        return text;
      }
    }

    if (
      text.includes(".mp4") ||
      text.includes("/tmp/") ||
      text.includes("/home/") ||
      text.includes("/app/")
    ) {
      return `${LTX_SPACE}/gradio_api/file=${encodeURIComponent(text)}`;
    }

    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  if (visited.has(value)) {
    return null;
  }

  visited.add(value);

  /*
   * Known Gradio video structures.
   */
  if (value.url) {
    const result = findVideo(value.url, visited);
    if (result) return result;
  }

  if (value.path) {
    const result = findVideo(value.path, visited);
    if (result) return result;
  }

  if (value.video) {
    const result = findVideo(value.video, visited);
    if (result) return result;
  }

  if (value.data) {
    const result = findVideo(value.data, visited);
    if (result) return result;
  }

  for (const key of Object.keys(value)) {
    const result = findVideo(value[key], visited);

    if (result) {
      return result;
    }
  }

  return null;
}

/* =========================================================
   PROCESS ONE SSE EVENT
   ========================================================= */

function processSSEEvent(eventText) {
  if (!eventText || !eventText.trim()) {
    return null;
  }

  let eventType = "message";
  let rawData = "";

  const lines = eventText.split(/\r?\n/);

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

  console.log("MAMAKI LTX EVENT:", eventType);
  console.log("MAMAKI LTX DATA:", rawData.slice(0, 3000));

  let data = rawData;

  try {
    data = JSON.parse(rawData);
  } catch {}

  const video = findVideo(data);

  if (video) {
    console.log("MAMAKI VIDEO FOUND:", video);
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
   READ GRADIO SSE
   ========================================================= */

async function readSSE(response, timeoutMs = 300000) {
  if (!response.body) {
    throw new Error("LTX returned no event stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let finished = false;

  const timeout = setTimeout(() => {
    finished = true;
    reader.cancel().catch(() => {});
  }, timeoutMs);

  try {
    while (!finished) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, {
        stream: true
      });

      const events = buffer.split(/\r?\n\r?\n/);

      buffer = events.pop() || "";

      for (const event of events) {
        const video = processSSEEvent(event);

        if (video) {
          return video;
        }
      }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
      const video = processSSEEvent(buffer);

      if (video) {
        return video;
      }
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }

  if (finished) {
    throw new Error("LTX generation timed out.");
  }

  throw new Error(
    "LTX finished but no MP4 file was returned by the Gradio Space."
  );
}

/* =========================================================
   GENERATE LTX VIDEO
   ========================================================= */

async function generateWithLTX(
  prompt,
  aspectRatio,
  duration
) {
  const { width, height } =
    getDimensions(aspectRatio);

  let safeDuration = Number(duration);

  if (!Number.isFinite(safeDuration)) {
    safeDuration = 5;
  }

  safeDuration = Math.max(
    2,
    Math.min(8, safeDuration)
  );

  console.log("MAMAKI: STARTING LTX...");
  console.log("MAMAKI: SIZE:", width, height);
  console.log("MAMAKI: DURATION:", safeDuration);

  const startResponse = await fetch(
    `${LTX_SPACE}/gradio_api/call/text_to_video`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },

      body: JSON.stringify({
        data: [
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
        ]
      })
    }
  );

  const startText =
    await startResponse.text();

  console.log(
    "MAMAKI LTX START:",
    startText.slice(0, 3000)
  );

  if (!startResponse.ok) {
    throw new Error(
      `LTX start failed (${startResponse.status}): ${startText}`
    );
  }

  let job;

  try {
    job = JSON.parse(startText);
  } catch {
    throw new Error(
      "LTX returned an invalid job response."
    );
  }

  const eventId = job?.event_id;

  if (!eventId) {
    throw new Error(
      "LTX did not return an event ID."
    );
  }

  console.log(
    "MAMAKI LTX JOB:",
    eventId
  );

  const resultResponse = await fetch(
    `${LTX_SPACE}/gradio_api/call/text_to_video/${encodeURIComponent(
      eventId
    )}`,
    {
      headers: {
        Accept: "text/event-stream"
      }
    }
  );

  if (!resultResponse.ok) {
    const text =
      await resultResponse.text();

    throw new Error(
      `LTX result failed (${resultResponse.status}): ${text}`
    );
  }

  return await readSSE(
    resultResponse,
    300000
  );
}

/* =========================================================
   DOWNLOAD VIDEO
   ========================================================= */

async function downloadVideo(
  url,
  destination
) {
  console.log(
    "MAMAKI: DOWNLOADING VIDEO..."
  );

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Unable to download generated video (${response.status}).`
    );
  }

  const data =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (data.length < 1000) {
    throw new Error(
      "Generated video file is too small."
    );
  }

  await fs.writeFile(
    destination,
    data
  );

  console.log(
    "MAMAKI: VIDEO SAVED:",
    destination
  );
}

/* =========================================================
   AI VOICE
   ========================================================= */

async function generateVoice(
  text,
  outputPath
) {
  const narration =
    String(text || "").trim();

  if (!narration) {
    throw new Error(
      "Voice-over text is empty."
    );
  }

  console.log(
    "MAMAKI: GENERATING AI VOICE..."
  );

  await ttsSave(
    narration,
    outputPath,
    {
      voice: "en-US-AriaNeural",
      rate: "+0%",
      volume: "+0%",
      pitch: "+0Hz"
    }
  );

  console.log(
    "MAMAKI: VOICE CREATED:",
    outputPath
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
            "FFmpeg binary is unavailable."
          )
        );

        return;
      }

      const child =
        spawn(
          ffmpegPath,
          args
        );

      let errorOutput = "";

      child.stderr.on(
        "data",
        data => {
          errorOutput +=
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
                `FFmpeg failed (${code}): ${errorOutput.slice(-4000)}`
              )
            );
          }
        }
      );
    }
  );
}

/* =========================================================
   COMBINE VIDEO + VOICE
   ========================================================= */

async function combineMedia(
  videoPath,
  audioPath,
  finalPath
) {
  console.log(
    "MAMAKI: COMBINING VIDEO + VOICE..."
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

    finalPath
  ]);

  console.log(
    "MAMAKI: FINAL VIDEO READY:",
    finalPath
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

    let videoPath;
    let audioPath;
    let finalPath;

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
            "Please enter a video prompt."
        });
      }

      await fs.mkdir(
        workDir,
        {
          recursive: true
        }
      );

      const id =
        Date.now();

      videoPath =
        path.join(
          workDir,
          `ltx-${id}.mp4`
        );

      audioPath =
        path.join(
          workDir,
          `voice-${id}.mp3`
        );

      finalPath =
        path.join(
          workDir,
          `mamaki-${id}.mp4`
        );

      const stylePrompt =
        styles[style] ||
        styles.Realistic;

      const finalPrompt =
        `${stylePrompt}. ${prompt.trim()}`;

      console.log(
        "================================"
      );

      console.log(
        "MAMAKI: NEW GENERATION"
      );

      console.log(
        "MAMAKI PROMPT:",
        finalPrompt
      );

      /* VIDEO */

      const videoUrl =
        await generateWithLTX(
          finalPrompt,
          aspectRatio,
          duration
        );

      await downloadVideo(
        videoUrl,
        videoPath
      );

      /* VOICE */

      const narration =
        typeof voiceText === "string" &&
        voiceText.trim()
          ? voiceText.trim()
          : prompt.trim();

      if (voice !== false) {
        await generateVoice(
          narration,
          audioPath
        );

        await combineMedia(
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

      const filename =
        path.basename(
          finalPath
        );

      const videoUrlForBrowser =
        `/api/video/${encodeURIComponent(
          filename
        )}`;

      console.log(
        "MAMAKI: SUCCESS:",
        videoUrlForBrowser
      );

      return res.json({
        ok: true,

        videoUrl:
          videoUrlForBrowser,

        voiceOver:
          voice !== false,

        message:
          voice !== false
            ? "MAMAKI generated the video and AI voice-over successfully."
            : "MAMAKI generated the video successfully."
      });

    } catch (error) {
      console.error(
        "MAMAKI GENERATION ERROR:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Video generation failed."
      });

    } finally {
      /*
       * Keep the final MP4.
       * Remove only temporary LTX/audio files.
       */

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
            ).catch(
              () => {}
            );
          }
        }
      } catch {}
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
      app: "MAMAKI AI VIDEO",
      api: "running",
      engine:
        "LTX Video + Edge TTS + FFmpeg",
      voice:
        "Edge TTS",
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

  
