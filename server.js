async function generateWithLTX(prompt, options = {}) {
  console.log("MAMAKI: Starting LTX video generation...");

  try {
    const result = await fal.subscribe("fal-ai/ltx-video-v095", {
      input: {
        prompt: prompt,
        resolution: options.resolution || "480p",
        aspect_ratio: options.aspect_ratio || "16:9",
        num_inference_steps: options.num_inference_steps || 40,
        expand_prompt: true
      },

      logs: true,

      onQueueUpdate: (update) => {
        console.log("MAMAKI: LTX status:", update.status);

        if (update.logs) {
          update.logs.forEach((log) => {
            if (log.message) {
              console.log("LTX:", log.message);
            }
          });
        }
      }
    });

    console.log("MAMAKI: LTX generation completed.");
    console.log(
      "MAMAKI: LTX result:",
      JSON.stringify(result)
    );

    const videoUrl = result?.data?.video?.url;

    if (!videoUrl) {
      console.error(
        "MAMAKI: LTX returned no video URL."
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
      videoUrl: videoUrl,
      url: videoUrl,
      requestId: result?.requestId || null
    };

  } catch (error) {
    console.error(
      "MAMAKI VIDEO ERROR:",
      error
    );

    throw error;
  }
}
