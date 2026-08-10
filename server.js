async function generateWithLTX(prompt, options = {}) {
  console.log("MAMAKI: Starting LTX video generation...");
  console.log("MAMAKI: Prompt:", prompt);

  try {
    if (!process.env.FAL_KEY) {
      throw new Error("FAL_KEY is missing from Render environment variables.");
    }

    const result = await fal.subscribe("fal-ai/ltx-video-v095", {
      input: {
        prompt: String(prompt),

        resolution: options.resolution || "480p",

        aspect_ratio: options.aspect_ratio || "16:9",

        num_inference_steps:
          Number(options.num_inference_steps) || 40,

        expand_prompt: true
      },

      logs: true,

      onQueueUpdate(update) {
        console.log(
          "MAMAKI: LTX status:",
          update?.status || "UNKNOWN"
        );

        if (Array.isArray(update?.logs)) {
          for (const log of update.logs) {
            if (log?.message) {
              console.log("LTX:", log.message);
            }
          }
        }
      }
    });

    console.log("MAMAKI: LTX generation completed.");

    console.log(
      "MAMAKI: LTX result:",
      JSON.stringify(result)
    );

    const videoUrl =
      result?.data?.video?.url ||
      result?.video?.url ||
      result?.data?.video_url ||
      result?.video_url;

    if (!videoUrl) {
      console.error(
        "MAMAKI: LTX completed but no video URL was found."
      );

      console.error(
        "MAMAKI: Full LTX response:",
        JSON.stringify(result)
      );

      throw new Error(
        "LTX completed but did not return a video URL."
      );
    }

    console.log(
      "MAMAKI: LTX video URL:",
      videoUrl
    );

    return {
      videoUrl,
      url: videoUrl,
      requestId: result?.requestId || null
    };

  } catch (error) {
    console.error(
      "MAMAKI: LTX generation failed:",
      error?.message || error
    );

    throw error;
  }
}
