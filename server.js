import "dotenv/config";
import express from "express";

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static("."));

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

  /*
   * Gradio file endpoint.
   *
   * Encode only the individual path segments so that
   * the Gradio file route receives a valid file path.
   */

  const encodedPath = text
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  return `${LTX_SPACE}/gradio_api/file=${encodedPath}`;
}


/* =========================================================
   FIND VIDEO FILE IN GRADIO RESPONSE
   ========================================================= */

function findVideoUrl(value, seen = new Set()) {
  if (value == null) {
    return null;
  }

  /*
   * STRING
   */

  if (typeof value === "string") {
    const text = value.trim();

    if (!text) {
      return null;
    }

    /*
     * Direct URL.
     */

    if (
      text.startsWith("http://") ||
      text.startsWith("https://")
    ) {
      return text;
    }

    /*
     * Local Gradio file path.
     */

    if (
      text.toLowerCase().includes(".mp4") ||
      text.includes("/tmp/") ||
      text.includes("/home/") ||
      text.includes("/app/")
    ) {
      return filePathToUrl(text);
    }

    return null;
  }


  /*
   * OBJECT
   */

  if (
    typeof value !== "object" ||
    seen.has(value)
  ) {
    return null;
  }

  seen.add(value);


  /*
   * IMPORTANT:
   * Gradio FileData commonly contains:
   *
   * {
   *   path: "...",
   *   url: "...",
   *   orig_name: "...",
   *   mime_type: "video/mp4"
   * }
   */

  if (typeof value.path === "string") {
    const path = value.path.trim();

    if (
      path &&
      (
        path.toLowerCase().includes(".mp4") ||
        value.mime_type?.startsWith("video/")
      )
    ) {
      return filePathToUrl(path);
    }
  }


  /*
   * Prefer Gradio's supplied URL when available.
   */

  if (typeof value.url === "string") {
    const url = value.url.trim();

    if (url) {
      return url;
    }
  }


  /*
   * Direct video property.
   */

  if (value.video) {
    const result = findVideoUrl(
      value.video,
      seen
    );

    if (result) {
      return result;
    }
  }


  /*
   * Recursively inspect all properties.
   */

  for (const key of Object.keys(value)) {
    const result = findVideoUrl(
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
   EXTRACT VIDEO FROM ANY RESPONSE
   ========================================================= */

function extractVideo(value) {
  if (value == null) {
    return null;
  }

  /*
   * First inspect the object directly.
   */

  let videoUrl = findVideoUrl(value);

  if (videoUrl) {
    return videoUrl;
  }


  /*
   * If the response is a JSON string,
   * parse it and inspect it again.
   */

  if (typeof value === "string") {
    const text = value.trim();

    if (!text) {
      return null;
    }

    try {
      const parsed = JSON.parse(text);

      videoUrl = findVideoUrl(parsed);

      if (videoUrl) {
        return videoUrl;
      }
    } catch {
      // Not JSON. Continue below.
    }


    /*
     * Search raw text for an MP4 URL.
     */

    const httpMatch = text.match(
      /https?:\/\/[^\s"'\\]+\.mp4[^\s"'\\]*/i
    );

    if (httpMatch) {
      return httpMatch[0];
    }


    /*
     * Search raw text for a local MP4 path.
     */

    const pathMatch = text.match(
      /(?:\/tmp\/|\/home\/|\/app\/)[^\s"'\\]+\.mp4/i
    );

    if (pathMatch) {
      return filePathToUrl(pathMatch[0]);
    }
  }

  return null;
}


/* =========================================================
   PROCESS ONE SSE EVENT
   ========================================================= */

function processSSEEvent(eventText) {
  if (
    !eventText ||
    !eventText.trim()
  ) {
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


  if (
    !rawData ||
    rawData === "null"
  ) {
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


  /*
   * Parse JSON.
   */

  let data;

  try {
    data = JSON.parse(rawData);
  } catch {
    data = rawData;
  }


  /*
   * IMPORTANT:
   * Gradio text_to_video returns the video
   * inside the completion data.
   */

  let videoUrl = extractVideo(data);

  if (!videoUrl) {
    videoUrl = extractVideo(rawData);
  }


  if (videoUrl) {
    console.log(
      "MAMAKI: VIDEO FOUND:",
      videoUrl
    );

    return videoUrl;
  }


  /*
   * Handle errors.
   */

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


  /*
   * Gradio heartbeat/status events.
   */

  if (
    eventType === "generating" ||
    eventType === "process_starts" ||
    eventType === "heartbeat"
  ) {
    console.log(
      "MAMAKI: LTX still processing..."
    );
  }


  /*
   * Completion event.
   */

  if (eventType === "complete") {
    console.log(
      "MAMAKI: LTX COMPLETE EVENT RECEIVED"
    );

    console.log(
      "MAMAKI: COMPLETE DATA:",
      rawData.slice(0, 10000)
    );
  }

  return null;
}


/* =========================================================
   READ GRADIO SSE STREAM
   ========================================================= */

async function readSSE(
  response,
  timeoutMs = 300000
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

  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;

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


      /*
       * Stream finished.
       */

      if (done) {

        /*
         * Process any remaining event.
         */

        if (buffer.trim()) {

          const result =
            processSSEEvent(buffer);

          if (result) {
            return result;
          }
        }

        break;
      }


      /*
       * Decode incoming bytes.
       */

      buffer += decoder.decode(
        value,
        {
          stream: true
        }
      );


      /*
       * SSE events are separated
       * by a blank line.
       */

      const events =
        buffer.split(
          /\r?\n\r?\n/
        );


      /*
       * Keep unfinished event.
       */

      buffer =
        events.pop() || "";


      /*
       * Process completed events.
       */

      for (
        const eventText of events
      ) {

        const videoUrl =
          processSSEEvent(
            eventText
          );

        if (videoUrl) {
          return videoUrl;
        }
      }
    }


    /*
     * Flush decoder.
     */

    buffer +=
      decoder.decode();


    if (buffer.trim()) {

      const result =
        processSSEEvent(buffer);

      if (result) {
        return result;
      }
    }


  } finally {

    clearTimeout(timeout);

  }


  if (timedOut) {
    throw new Error(
      "LTX video generation timed out."
    );
  }


  throw new Error(
    "LTX completed, but the Gradio response did not contain a video file."
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
  } = getDimensions(
    aspectRatio
  );


  const requestedDuration =
    Number(duration);


  const safeDuration =
    Math.min(
      8.5,
      Math.max(
        0.3,
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


  /*
   * Exact parameter order confirmed
   * from the Gradio API information:
   *
   * 1 prompt
   * 2 negative_prompt
   * 3 input_image_filepath
   * 4 input_video_filepath
   * 5 height
   * 6 width
   * 7 mode
   * 8 duration
   * 9 frames
   * 10 seed
   * 11 randomize_seed
   * 12 guidance_scale
   * 13 improve_texture_flag
   * 14 slow_motion_flag
   */

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

            1,

            true,

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
        2000
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


  /*
   * Connect to the Gradio event stream.
   */

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
        2000
      )}`
    );
  }


  const videoUrl =
    await readSSE(
      resultResponse,
      300000
    );


  if (!videoUrl) {

    throw new Error(
      "LTX completed but no video URL was returned."
    );
  }


  console.log(
    "MAMAKI: FINAL VIDEO URL:",
    videoUrl
  );


  return videoUrl;
}


/* =========================================================
   GENERATE API
   ========================================================= */

app.post(
  "/api/generate",
  async (req, res) => {

    try {

      const {
        prompt,
        style = "Realistic",
        aspectRatio = "9:16",
        duration = 5
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


      const videoUrl =
        await generateWithLTX(
          finalPrompt,
          aspectRatio,
          duration
        );


      console.log(
        "MAMAKI: GENERATION SUCCESSFUL"
      );


      return res.json({
        ok: true,
        videoUrl
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
        "LTX Video ZeroGPU"
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
      process.cwd() +
      "/index.html"
    );
  }
);


/* =========================================================
   START SERVER
   ========================================================= */

const PORT =
  process.env.PORT || 3000;


app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `MAMAKI AI VIDEO running on port ${PORT}`
    );
  }
);
