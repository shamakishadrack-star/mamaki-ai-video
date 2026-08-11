
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
   CONVERT GRADIO FILE PATH TO URL
   ========================================================= */

function filePathToUrl(value) {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return null;
  }

  const text = value.trim();

  if (
    text.startsWith("http://") ||
    text.startsWith("https://")
  ) {
    return text;
  }

  return `${LTX_SPACE}/gradio_api/file=${encodeURIComponent(
    text
  )}`;
}


/* =========================================================
   FIND VIDEO INSIDE ANY GRADIO RESPONSE
   ========================================================= */

function findVideoUrl(
  value,
  seen = new Set()
) {
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
      text.toLowerCase().includes(".mp4") ||
      text.includes("/tmp/") ||
      text.includes("/home/") ||
      text.includes("/app/")
    ) {
      return filePathToUrl(text);
    }

    return null;
  }

  if (
    typeof value !== "object" ||
    seen.has(value)
  ) {
    return null;
  }

  seen.add(value);

  if (
    typeof value.url === "string"
  ) {
    const url =
      filePathToUrl(value.url);

    if (url) {
      return url;
    }
  }

  if (
    typeof value.path === "string"
  ) {
    const url =
      filePathToUrl(value.path);

    if (url) {
      return url;
    }
  }

  if (
    typeof value.video === "string"
  ) {
    const url =
      filePathToUrl(value.video);

    if (url) {
      return url;
    }
  }

  if (value.video) {
    const url =
      findVideoUrl(
        value.video,
        seen
      );

    if (url) {
      return url;
    }
  }

  for (
    const key of Object.keys(value)
  ) {
    const found =
      findVideoUrl(
        value[key],
        seen
      );

    if (found) {
      return found;
    }
  }

  return null;
}


/* =========================================================
   EXTRACT VIDEO FROM SSE DATA
   ========================================================= */

function extractVideo(value) {
  if (value == null) {
    return null;
  }

  let found =
    findVideoUrl(value);

  if (found) {
    return found;
  }

  if (typeof value === "string") {
    const text =
      value.trim();

    if (!text) {
      return null;
    }

    /*
     * Gradio may return JSON encoded
     * inside a string.
     */

    try {
      const parsed =
        JSON.parse(text);

      found =
        findVideoUrl(parsed);

      if (found) {
        return found;
      }
    } catch {
      // Continue with raw string.
    }

    /*
     * Look for a direct MP4 URL.
     */

    const httpMatch =
      text.match(
        /https?:\/\/[^\s"'\\]+\.mp4[^\s"'\\]*/i
      );

    if (httpMatch) {
      return httpMatch[0];
    }

    /*
     * Look for a local temporary
     * Gradio MP4 file.
     */

    const pathMatch =
      text.match(
        /(?:\/tmp\/|\/home\/|\/app\/)[^\s"'\\]+\.mp4/i
      );

    if (pathMatch) {
      return filePathToUrl(
        pathMatch[0]
      );
    }
  }

  return null;
}


/* =========================================================
   PROCESS ONE SERVER-SENT EVENT
   ========================================================= */

function processSSEEvent(
  eventText
) {
  if (
    !eventText ||
    !eventText.trim()
  ) {
    return null;
  }

  const lines =
    eventText.split(/\r?\n/);

  let eventType =
    "message";

  let rawData = "";

  for (
    const line of lines
  ) {
    if (
      line.startsWith("event:")
    ) {
      eventType =
        line
          .slice(6)
          .trim();
    }

    if (
      line.startsWith("data:")
    ) {
      const part =
        line
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
    "MAMAKI: LTX event:",
    eventType
  );

  console.log(
    "MAMAKI: LTX raw data:",
    rawData.slice(0, 3000)
  );

  let data;

  try {
    data =
      JSON.parse(rawData);
  } catch {
    data =
      rawData;
  }

  /*
   * Check parsed response.
   */

  let videoUrl =
    extractVideo(data);

  /*
   * Check raw SSE response.
   */

  if (!videoUrl) {
    videoUrl =
      extractVideo(rawData);
  }

  if (videoUrl) {
    console.log(
      "MAMAKI: VIDEO URL FOUND:",
      videoUrl
    );

    return videoUrl;
  }

  /*
   * Handle explicit Gradio errors.
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
   * Handle final Gradio event.
   */

  if (
    eventType === "complete"
  ) {
    console.log(
      "MAMAKI: LTX COMPLETE EVENT RECEIVED"
    );

    console.log(
      "MAMAKI: COMPLETE RAW DATA:",
      rawData
    );
  }

  return null;
}


/* =========================================================
   READ GRADIO SERVER-SENT EVENTS
   ========================================================= */

async function readSSE(
  response,
  timeoutMs = 180000
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

  const timeout =
    setTimeout(() => {
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
       * Process anything remaining
       * when the stream closes.
       */

      if (done) {
        if (buffer.trim()) {
          const finalResult =
            processSSEEvent(
              buffer
            );

          if (finalResult) {
            return finalResult;
          }
        }

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

      /*
       * Keep the unfinished event.
       */

      buffer =
        events.pop() || "";

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
     * Flush remaining decoder data.
     */

    buffer +=
      decoder.decode();

    if (buffer.trim()) {
      const finalResult =
        processSSEEvent(
          buffer
        );

      if (finalResult) {
        return finalResult;
      }
    }

  } finally {
    clearTimeout(timeout);
  }

  throw new Error(
    "LTX completed but no video file was found in the final Gradio response."
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
  } =
    getDimensions(
      aspectRatio
    );

  const requestedDuration =
    Number(duration);

  const safeDuration =
    Math.min(
      6,
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
        1000
      )}`
    );
  }

  const job =
    await response.json();

  console.log(
    "MAMAKI: LTX start response:",
    JSON.stringify(job)
  );

  if (!job?.event_id) {
    throw new Error(
      "LTX did not return a generation job ID."
    );
  }

  console.log(
    "MAMAKI: LTX job:",
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
        1000
      )}`
    );
  }

  const videoUrl =
    await readSSE(
      resultResponse,
      180000
    );

  if (!videoUrl) {
    throw new Error(
      "LTX completed but no video file was returned."
    );
  }

  console.log(
    "MAMAKI: Final video URL:",
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
      } =
        req.body || {};

      if (
        typeof prompt !==
          "string" ||
        !prompt.trim()
      ) {
        return res
          .status(400)
          .json({
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
        "MAMAKI: Starting LTX video generation..."
      );

      console.log(
        "MAMAKI: Final prompt:",
        finalPrompt
      );

      const videoUrl =
        await generateWithLTX(
          finalPrompt,
          aspectRatio,
          duration
        );

      console.log(
        "MAMAKI: Generation successful."
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
