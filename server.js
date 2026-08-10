async function generateWithLTX(prompt, options = {}) {
  console.log("MAMAKI: Starting LTX video generation...");

  try {
    const result = await fal.subscribe("fal-ai/ltx-video", {
      input: {
        prompt: prompt,
        ...(options.aspect_ratio
          ? { aspect_ratio: options.aspect_ratio }
          : {}),
        ...(options.resolution
          ? { resolution: options.resolution }
          : {}),
        ...(options.num_inference_steps
          ? { num_inference_steps: options.num_inference_steps }
          : {}),
      },

      logs: true,

      onQueueUpdate: (update) => {
        console.log(
          "MAMAKI: LTX status:",
          update.status
        );

        if (update.logs) {
          update.logs.forEach((log) => {
            if (log.message) {
              console.log("LTX:", log.message);
            }
          });
        }
      },
    });

    console.log("MAMAKI: LTX generation completed.");

    const data = result?.data;

    console.log(
      "MAMAKI: LTX result received:",
      JSON.stringify(data)
    );

    // Official LTX output:
    // { video: { url: "https://..." } }

    const videoUrl = data?.video?.url;

    if (!videoUrl) {
      console.error(
        "MAMAKI: LTX returned no video URL.",
        JSON.stringify(data)
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
