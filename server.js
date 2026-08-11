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
GRADIO FILE -> URL
========================================================= */

function gradioFileToUrl(value) {
if (!value) {
return null;
}

if (typeof value === "object") {
if (value.url) {
return gradioFileToUrl(value.url);
}

if (value.path) {
  return gradioFileToUrl(value.path);
}

if (value.video) {
  return gradioFileToUrl(value.video);
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

return "${LTX_SPACE}/gradio_api/file=${encodeURIComponent(text)}";
}

/* =========================================================
FIND VIDEO OUTPUT
========================================================= */

function findVideoOutput(value, seen = new Set()) {
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
  if (
    /\.(mp4|webm|mov)(\?|$)/i.test(text) ||
    text.includes("/gradio_api/file=")
  ) {
    return text;
  }
}

if (
  /\.(mp4|webm|mov)(\?|$)/i.test(text) ||
  text.includes("/tmp/") ||
  text.includes("/home/") ||
  text.includes("/app/")
) {
  return gradioFileToUrl(text);
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

/* Gradio VideoData */
if (value.video) {
const result = findVideoOutput(
value.video,
seen
);

if (result) {
  return result;
}

}

/* Gradio FileData */
if (value.path) {
const result = gradioFileToUrl(value.path);

if (result) {
  return result;
}

}

if (value.url) {
const result = gradioFileToUrl(value.url);

if (result) {
  return result;
}

}

if (value.file) {
const result = findVideoOutput(
value.file,
seen
);

if (result) {
  return result;
}

}

/* Search arrays and other objects */
if (Array.isArray(value)) {
for (const item of value) {
const result = findVideoOutput(
item,
seen
);

  if (result) {
    return result;
  }
}

return null;

}

for (const key of Object.keys(value)) {
const result = findVideoOutput(
value[key],
seen
);

if (result) {
  return result;
}

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
eventType = line
.slice(6)
.trim();
}

if (line.startsWith("data:")) {
  const part = line
    .slice(5)
    .trim();

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
"MAMAKI: LTX RAW DATA:",
rawData.slice(0, 8000)
);

let data;

try {
data = JSON.parse(rawData);
} catch {
data = rawData;
}

/* Gradio normally returns:
[
{
"path": "/tmp/...mp4",
"url": "...",
...
},
seed
]
*/

const video =
findVideoOutput(data);

if (video) {
console.log(
"MAMAKI: LTX VIDEO FOUND:",
video
);

return video;

}

if (
eventType === "error" ||
eventType === "process_error"
) {
let message =
"LTX video generation failed.";

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

const timeout = setTimeout(() => {
timeoutTriggered = true;

reader.cancel().catch(() => {});

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

  buffer += decoder.decode(
    value,
    { stream: true }
  );

  const events =
    buffer.split(/\r?\n\r?\n/);

  buffer =
    events.pop() || "";

  for (
    const eventText of events
  ) {
    const video =
      processSSEEvent(
        eventText
      );

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

if (timeoutTriggered) {
throw new Error(
"LTX generation timed out."
);
}

throw new Error(
"LTX finished, but no video file was returned."
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
const {
height,
width
} = getDimensions(
aspectRatio
);

let safeDuration =
Number(duration);

if (
!Number.isFinite(
safeDuration
)
) {
safeDuration = 2;
}

/*

* The Hugging Face Space supports
* approximately 0.3 to 8.5 seconds.
* 
* Start with a short duration for
* maximum reliability on ZeroGPU.
  */
  safeDuration =
  Math.min(
  8,
  Math.max(
  0.3,
  safeDuration
  )
  );

console.log(
"MAMAKI: Starting LTX..."
);

console.log(
"MAMAKI: Prompt:",
prompt
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

/*

* Exact input order used by the
* DeepRat LTX Space:
* 
* 1 prompt
* 2 negative prompt
* 3 image
* 4 video
* 5 height
* 6 width
* 7 mode
* 8 duration
* 9 frames to use
* 10 seed
* 11 randomize seed
* 12 guidance scale
* 13 improve texture
* 14 slow motion
  */

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
Math.random() *
4294967295
),
true,
3.0,
false,
false
];

const startResponse =
await fetch(
"${LTX_SPACE}/gradio_api/call/text_to_video",
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
"MAMAKI: LTX JOB RESPONSE:",
JSON.stringify(job)
);

if (!job?.event_id) {
throw new Error(
"LTX did not return an event ID."
);
}

console.log(
"MAMAKI: LTX EVENT ID:",
job.event_id
);

const resultResponse =
await fetch(
"${LTX_SPACE}/gradio_api/call/text_to_video/${encodeURIComponent( job.event_id )}",
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
"MAMAKI: Downloading:",
videoUrl
);

const response =
await fetch(videoUrl);

if (!response.ok) {
throw new Error(
"Unable to download LTX video (${response.status})."
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
"MAMAKI: LTX video saved:",
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
Buffer.isBuffer(
result.audio
)
) {
audioBuffer =
result.audio;
} else if (
result.audio instanceof Uint8Array
) {
audioBuffer =
Buffer.from(
result.audio
);
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

if (
audioBuffer.length < 1000
) {
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
    data => {
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
    code => {
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
    typeof prompt !==
      "string" ||
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

  /* 1. Generate LTX video */

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

  /* 2. Download video */

  await downloadVideo(
    ltxVideoUrl,
    videoPath
  );

  /* 3. Narration */

  const narration =
    typeof voiceText ===
      "string" &&
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
    `/api/video/${path.basename(
      finalPath
    )}`;

  console.log(
    "MAMAKI: GENERATION SUCCESSFUL"
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
START
========================================================= */

app.listen(
PORT,
"0.0.0.0",
() => {
console.log(
"MAMAKI AI VIDEO running on port ${PORT}"
);
}
);
