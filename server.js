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

app.use(express.json({ limit: "1mb" }));
app.use(express.static("."));

const PORT = process.env.PORT || 3000;

const LTX_SPACE =
  "https://deeprat-ltx-video-zerogpu-optimized.hf.space";

const NEGATIVE_PROMPT =
  "worst quality, inconsistent motion, blurry, jittery, distorted";

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
   VIDEO DIMENSIONS
   ========================================================= */

function getDimensions(aspectRatio) {
  if (aspectRatio === "9:16") {
    return {
      height: 704,
      width: 400
    };
  }

  if (aspectRatio === "1:1") {
    return {
      height: 512,
      width: 512
    };
  }

  return {
    height: 400,
    width: 704
  };
}

/* =========================================================
   CONVERT GRADIO FILE DATA TO URL
   ========================================================= */

function filePathToUrl(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "object") {
    if (value.url) {
      return filePathToUrl(value.url);
    }

    if (value.path) {
      return filePathToUrl(value.path);
    }

    if (value.video) {
      return filePathToUrl(value.video);
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

  return `${LTX_SPACE}/gradio_api/file=${encodeURIComponent(text)}`;
}

/* =========================================================
   FIND VIDEO IN GRADIO RESPONSE
   ========================================================= */

function findVideoUrl(value, seen = new Set()) {
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    const text = value.trim();

    if (
      text.startsWith("http://") ||
      text.startsWith("https://")
    ) {
      return text;
    }

    if (
      text.includes(".mp4") ||
      text.includes("/tmp/") ||
      text.includes("/home/") ||
      text.includes("/app/")
    ) {
      return filePathToUrl(text);
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

  /*
   * Exact Gradio VideoData structure:
   *
   * {
   *   video: {
   *     path: "...",
   *     url: "...",
   *     ...
   *   },
   *   subtitles: null
   * }
   */

  if (value.video) {
    const result = findVideoUrl(value.video, seen);

    if (result) {
      return result;
    }
  }

  if (value.url) {
    const result = filePathToUrl(value.url);

    if (result) {
      return result;
    }
  }

  if (value.path) {
    const result = filePathToUrl(value.path);

    if (result) {
      return result;
    }
  }

  for (const key of Object.keys(value)) {
    const result = findVideoUrl(value[key], seen);

    if (result) {
      return result;
    }
  }

  return null;
}

/* =========================================================
   EXTRACT VIDEO FROM GRADIO DATA
   ========================================================= */

function extractVideo(value) {
  if (value == null) {
    return null;
  }

  const direct = findVideoUrl(value);

  if (direct) {
    return direct;
  }

  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();

  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);

    const parsedVideo = findVideoUrl(parsed);

    if (parsedVideo) {
      return parsedVideo;
    }
  } catch {
    // Not JSON. Continue.
  }

  const mp4Match = text.match(
    /https?:\/\/[^\s"'\\]+\.mp4[^\s"'\\]*/i
  );

  if (mp4Match) {
    return mp4Match[0];
  }

  const pathMatch = text.match(
    /(?:\/tmp\/|\/home\/|\/app\/)[^\s"'\\]+\.mp4/i
  );

  if (pathMatch) {
    return filePathToUrl(pathMatch[0]);
  }

  return null;
}

/* =========================================================
   PROCESS SSE EVENT
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

  console.log(
    "MAMAKI: LTX EVENT:",
    eventType
  );

  console.log(
    "MAMAKI: LTX DATA:",
    rawData.slice(0, 5000)
  );

  let data;

  try {
    data = JSON.parse(rawData);
  } catch {
    data = rawData;
  }

  const videoUrl = extractVideo(data);

  if (videoUrl) {
    console.log(
      "MAMAKI: VIDEO FILE FOUND:",
      videoUrl
    );

    return videoUrl;
  }

  if (
    eventType === "error" ||
    eventType === "process_error"
  ) {
    throw new Error(
      typeof data === "string"
        ? data
        : data?.error ||
          data?.message ||
          "LTX video generation failed."
    );
  }

  return null;
}

/* =========================================================
   READ GRADIO SSE STREAM
   ========================================================= */

async function readSSE(response, timeoutMs = 300000) {
  if (!response.body) {
    throw new Error(
      "LTX returned no event stream."
    );
  }

  const reader = response.body.getReader();

  const decoder = new TextDecoder();

  let buffer = "";

  let timeoutTriggered = false;

  const timeout = setTimeout(() => {
    timeoutTriggered = true;

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

      const events = buffer.split(
        /\r?\n\r?\n/
      );

      buffer = events.pop() || "";

      for (const eventText of events) {
        const videoUrl =
          processSSEEvent(eventText);

        if (videoUrl) {
          return videoUrl;
        }
      }
    }

    buffer += decoder.decode();

    if (buffer.trim()) {
      const videoUrl =
        processSSEEvent(buffer);

      if (videoUrl) {
        return videoUrl;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  if (timeoutTriggered) {
    throw new Error(
      "LTX generation timed out."
    );
  }

  throw new Error(
    "LTX completed, but the Gradio response did not contain a video file."
  );
}

/* =========================================================
   DOWNLOAD GENERATED LTX VIDEO
   ========================================================= */

async function downloadVideo(videoUrl, outputPath) {
  console.log(
    "MAMAKI: Downloading generated video..."
  );

  const response = await fetch(videoUrl);

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
      "Downloaded LTX video file is unexpectedly small."
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
   GENERATE VIDEO WITH LTX
   ========================================================= */

async function generateWithLTX(
  prompt,
  aspectRatio,
  duration
) {
  const {
    height,
    width
  } = getDimensions(aspectRatio);

  const requestedDuration =
    Number(duration);

  const safeDuration =
    Math.min(
      8,
      Math.max(
        2,
        Number.isFinite(
          requestedDuration
        )
          ? requestedDuration
          : 5
      )
    );

  console.log(
    "MAMAKI: Sending request to LTX..."
  );

  console.log(
    "MAMAKI: Resolution:",
    width,
    "x",
    height
  );

  console.log(
    "MAMAKI: Duration:",
    safeDuration
  );

  const response =
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
              Math.random() *
                4294967295
            ),
            true,
            3.0,
            false,
            false
          ]
        })
      }
    );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `LTX start failed (${response.status}): ${text.slice(
        0,
        1500
      )}`
    );
  }

  const job =
    await response.json();

  console.log(
    "MAMAKI: LTX START RESPONSE:",
    JSON.stringify(job)
  );

  if (!job?.event_id) {
    throw new Error(
      "LTX did not return a generation job ID."
    );
  }

  console.log(
    "MAMAKI: LTX JOB:",
    job.event_id
  );

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

  if (!resultResponse.ok) {
    const text =
      await resultResponse.text();

    throw new Error(
      `LTX result failed (${resultResponse.status}): ${text.slice(
        0,
        1500
      )}`
    );
  }

  return await readSSE(
    resultResponse,
    300000
  );
}

/* =========================================================
   GENERATE AI VOICE
   ========================================================= */

async function generateVoice(
  text,
  outputPath
) {
  console.log(
    "MAMAKI: Generating AI voice-over..."
  );

  const cleanText =
    String(text || "").trim();

  if (!cleanText) {
    throw new Error(
      "Voice-over text is empty."
    );
  }

  /*
   * Natural English female voice.
   * This can be changed later.
   */
  await ttsSave(
    cleanText,
    outputPath,
    {
      voice:
        "en-US-AriaNeural",
      rate:
        "+0%",
      volume:
        "+0%",
      pitch:
        "+0Hz"
    }
  );

  console.log(
    "MAMAKI: Voice-over created:",
    outputPath
  );
}

/* =========================================================
   RUN FFMPEG
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

      console.log(
        "MAMAKI: Starting FFmpeg..."
      );

      const process =
        spawn(
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
                -3000
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
    "MAMAKI: Combining video and voice-over..."
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
        duration = 5,
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
        "MAMAKI: STARTING LTX GENERATION..."
      );

      console.log(
        "MAMAKI: FINAL PROMPT:",
        finalPrompt
      );

      /*
       * STEP 1:
       * Generate the video.
       */

      const ltxVideoUrl =
        await generateWithLTX(
          finalPrompt,
          aspectRatio,
          duration
        );

      if (!ltxVideoUrl) {
        throw new Error(
          "LTX returned no video URL."
        );
      }

      /*
       * STEP 2:
       * Download the LTX video.
       */

      await downloadVideo(
        ltxVideoUrl,
        videoPath
      );

      /*
       * STEP 3:
       * Generate voice-over.
       *
       * If voiceText is supplied by the
       * frontend, use it.
       *
       * Otherwise use the original prompt.
       */

      const narration =
        typeof voiceText === "string" &&
        voiceText.trim()
          ? voiceText.trim()
          : prompt.trim();

      /*
       * Voice can be disabled by sending:
       * "voice": false
       */

      if (voice !== false) {
        await generateVoice(
          narration,
          audioPath
        );

        /*
         * STEP 4:
         * Combine video + voice.
         */

        await mergeVideoAndVoice(
          videoPath,
          audioPath,
          finalPath
        );
      } else {
        /*
         * If voice is disabled,
         * return the original video.
         */

        await fs.copyFile(
          videoPath,
          finalPath
        );
      }

      /*
       * STEP 5:
       * Return final video.
       */

      const finalUrl =
        `/api/video/${path.basename(
          finalPath
        )}`;

      console.log(
        "MAMAKI: GENERATION SUCCESSFUL:"
      );

      console.log(
        finalUrl
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
      /*
       * Do not delete the final video here.
       * It must remain available for the browser.
       *
       * Delete only temporary source files.
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
      } catch {
        // Ignore cleanup errors.
      }
    }
  }
);

/* =========================================================
   SERVE GENERATED VIDEOS
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
        "MAMAKI VIDEO SERVE ERROR:",
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
   STATUS API
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
        "LTX Video + AI Voice-over + FFmpeg",
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
  }
);
