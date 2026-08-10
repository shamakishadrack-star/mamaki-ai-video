import "dotenv/config";
import express from "express";

const app = express();

app.use(express.json());
app.use(express.static("."));

const LTX_SPACE =
  "https://deeprat-ltx-video-zerogpu-optimized.hf.space";

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

function getDimensions(aspectRatio) {
  if (aspectRatio === "9:16") {
    return { height: 704, width: 512 };
  }

  if (aspectRatio === "1:1") {
    return { height: 512, width: 512 };
  }

  return { height: 512, width: 704 };
}

async function generateWithLTX(prompt, aspectRatio) {
  const { height, width } = getDimensions(aspectRatio);

  const response = await fetch(
    `${LTX_SPACE}/gradio_api/call/text_to_video`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        data: [
          prompt,
          "worst quality, blurry, jittery, distorted, inconsistent motion",
          null,
          null,
          height,
          width,
          "text-to-video",
          2,
          9,
          42,
          true,
          3.0,
          false,
          false
        ]
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `LTX request failed (${response.status}): ${errorText.slice(0, 500)}`
    );
  }

  const job = await response.json();

  if (!job.event_id) {
    throw new Error("LTX did not return a generation job ID.");
  }

  const resultResponse = await fetch(
    `${LTX_SPACE}/gradio_api/call/text_to_video/${job.event_id}`
  );

  if (!resultResponse.ok) {
    const errorText = await resultResponse.text();
    throw new Error(
      `LTX result request failed (${resultResponse.status}): ${errorText.slice(0, 500)}`
    );
  }

  const stream = await resultResponse.text();

  const lines = stream.split("\n");

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;

    const jsonText = line.substring(5).trim();

    if (!jsonText) continue;

    let event;

    try {
      event = JSON.parse(jsonText);
    } catch {
      continue;
    }
if (!event || typeof event !== "object") {
  continue;
}
    if (event.msg === "error") {
      throw new Error(
        event.error || "LTX video generation failed."
      );
    }

    if (!Array.isArray(event.data)) continue;

    for (const item of event.data) {
      if (!item) continue;

      if (typeof item === "string") {
        if (
          item.startsWith("http://") ||
          item.startsWith("https://")
        ) {
          return item;
        }
      }

    if (typeof item === "object") {
  if (item.url) return item.url;
  if (item.video?.url) return item.video.url;
  if (item.path) return item.path;
  if (item.video?.path) return item.video.path;
  if (item.data?.url) return item.data.url;
  if (item.data?.path) return item.data.path;
}
    }
  }

  throw new Error(
    "LTX finished without returning a video file."
  );
}

app.post("/api/generate", async (req, res) => {
  try {
    const {
      prompt,
      style = "Realistic",
      aspectRatio = "9:16"
    } = req.body;

  if (!prompt || !prompt.trim()) {
  return res.status(400).json({
    error: "Please describe your video."
  });
}

const stylePrompt =
  styles[style] || "high-quality video";

const finalPrompt =
  `${stylePrompt}. ${prompt.trim()}`;

console.log(
  "MAMAKI: Starting LTX video generation..."
);

const videoUrl = await generateWithLTX(
  finalPrompt,
  aspectRatio
);

console.log(
  "MAMAKI: Video generated:",
  videoUrl
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

    return res.status(500).json({
      error:
        error?.message ||
        "Video generation failed."
    });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    app: "MAMAKI AI VIDEO",
    api: "running",
    engine: "LTX ZeroGPU"
  });
});

app.get("*splat", (req, res) => {
  res.sendFile(
    process.cwd() + "/index.html"
  );
});

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
       
