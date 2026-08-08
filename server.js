
import "dotenv/config";
import express from "express";
import { fal } from "@fal-ai/client";

const app = express();

app.use(express.json());
app.use(express.static("."));

if (process.env.FAL_KEY) {
  fal.config({ credentials: process.env.FAL_KEY });
}

app.post("/api/generate", async (req, res) => {
  try {
    if (!process.env.FAL_KEY) {
      return res.status(503).json({
        error: "The AI video engine is not connected yet."
      });
    }

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

    const styles = {
      Realistic:
        "photorealistic live-action, natural motion, realistic lighting",

      Cinematic:
        "cinematic film look, professional camera movement, dramatic lighting",

      Cartoon:
        "high-quality 3D cartoon animation, expressive characters",

      "3D Animation":
        "high-quality 3D animated scene, smooth camera motion",

      "AI Avatar":
        "professional digital presenter/avatar, natural movement"
    };

    const finalPrompt =
      `${styles[style] || "high-quality video"}. ${prompt.trim()}`;

    const result = await fal.subscribe(
      "fal-ai/wan-25-preview/text-to-video",
      {
        input: {
          prompt: finalPrompt,
          aspect_ratio: aspectRatio,
          resolution: "480p",
          duration: "5",
          enable_prompt_expansion: true,
          enable_safety_checker: true
        },
        logs: false
      }
    );

    const videoUrl = result?.data?.video?.url;

    if (!videoUrl) {
      return res.status(502).json({
        error: "No video was returned."
      });
    }

    res.json({
      ok: true,
      videoUrl
    });

  } catch (error) {
    console.error("VIDEO GENERATION ERROR:", error);

    res.status(500).json({
      error:
        error?.body?.detail ||
        error?.message ||
        "Video generation failed."
    });
  }
});

app.get("*splat", (req, res) => {
  res.sendFile(process.cwd() + "/index.html");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MAMAKI AI VIDEO running on port ${PORT}`);
});
