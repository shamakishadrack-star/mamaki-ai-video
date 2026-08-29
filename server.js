async function generateImageVideo(prompt, image) {
  if (!replicate) {
    throw new Error("REPLICATE_API_TOKEN is missing.");
  }

  if (!image || !image.buffer || !image.buffer.length) {
    throw new Error("Reference image is required.");
  }

  try {
    const cleanPrompt = String(prompt || "").trim();

    if (!cleanPrompt) {
      throw new Error("Image-to-video prompt is empty.");
    }

    /*
     * Wan 2.2 I2V accepts a Node.js Buffer directly.
     * Replicate's Node SDK handles the file upload automatically.
     */
    const input = {
      image: image.buffer,
      prompt: cleanPrompt,

      go_fast: true,

      num_frames: 81,

      resolution: "480p",

      sample_shift: 12,

      frames_per_second: 16,

      interpolate_output: false,

      lora_scale_transformer: 1,

      lora_scale_transformer_2: 1
    };

    console.log("MAMAKI I2V INPUT:", {
      prompt: cleanPrompt,
      filename: image.originalname,
      type: image.mimetype,
      size: image.size
    });

    console.log("MAMAKI I2V: Sending image to Wan 2.2...");

    const output = await replicate.run(
      I2V_MODEL,
      {
        input
      }
    );

    if (!output) {
      throw new Error(
        "Replicate did not return a video."
      );
    }

    console.log(
      "MAMAKI I2V: Replicate returned video output."
    );

    const videoBuffer =
      await replicateOutputToBuffer(output);

    if (!videoBuffer || !videoBuffer.length) {
      throw new Error(
        "Replicate returned an empty video file."
      );
    }

    console.log(
      "MAMAKI I2V: Video received successfully:",
      videoBuffer.length,
      "bytes"
    );

    return videoBuffer;

  } catch (error) {
    console.error(
      "MAMAKI I2V ERROR:",
      error?.stack ||
      error?.message ||
      error
    );

    throw new Error(
      `Image to Video generation failed: ${
        error?.message ||
        "Unknown Replicate error"
      }`
    );
  }
}
