import express from "express";
import multer from "multer";
import Replicate from "replicate";
import { EdgeTTS } from "edge-tts-universal";
import ffmpegPath from "ffmpeg-static";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const ROOT = process.cwd();

const TOKEN = String(
  process.env.REPLICATE_API_TOKEN || ""
).trim();

const replicate = TOKEN
  ? new Replicate({
      auth: TOKEN
    })
  : null;


/* =========================================================
   MODELS
========================================================= */

const T2V_MODEL =
  "wan-video/wan-2.5-t2v";

const I2V_MODEL =
  "wan-video/wan-2.5-i2v";


/* =========================================================
   DIRECTORIES
========================================================= */

const TMP =
  path.join(ROOT, "tmp");

const OUTPUT =
  path.join(ROOT, "outputs");

const INDEX =
  path.join(ROOT, "index.html");


await fs.mkdir(TMP, {
  recursive: true
});

await fs.mkdir(OUTPUT, {
  recursive: true
});


/* =========================================================
   BODY PARSERS
========================================================= */

app.use(
  express.json({
    limit: "10mb"
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb"
  })
);


/* =========================================================
   INTERFACE
========================================================= */

app.get("/", async (req, res) => {
  try {
    await fs.access(INDEX);

    return res.sendFile(INDEX);

  } catch {
    return res
      .status(404)
      .send(
        "MAMAKI interface not found. index.html is missing."
      );
  }
});


app.use(
  express.static(ROOT, {
    index: false
  })
);


/* =========================================================
   UPLOAD
========================================================= */

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 10
  },

  fileFilter: (req, file, cb) => {

    const allowedImages = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    const allowedAudio = [
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/x-wav",
      "audio/mp4",
      "audio/aac",
      "audio/ogg",
      "audio/webm"
    ];

    if (
      file.fieldname === "referenceImage"
    ) {

      if (
        allowedImages.includes(
          file.mimetype
        )
      ) {
        return cb(null, true);
      }

      return cb(
        new Error(
          "Reference image must be JPG, PNG, or WebP."
        )
      );
    }

    if (
      file.fieldname === "music" ||
      file.fieldname === "effects"
    ) {

      if (
        allowedAudio.includes(
          file.mimetype
        )
      ) {
        return cb(null, true);
      }

      return cb(
        new Error(
          "Audio file format is not supported."
        )
      );
    }

    cb(null, true);
  }
});


/* =========================================================
   HELPERS
========================================================= */

function getDuration(value) {

  const n =
    Number(value || 5);

  if (!Number.isFinite(n)) {
    return 5;
  }

  return Math.max(
    5,
    Math.min(
      10,
      Math.round(n)
    )
  );
}


function getSize(ratio) {

  if (ratio === "9:16") {
    return "720*1280";
  }

  if (ratio === "16:9") {
    return "1280*720";
  }

  if (ratio === "1:1") {
    return "720*720";
  }

  if (ratio === "9:16-HD") {
    return "1080*1920";
  }

  if (ratio === "16:9-HD") {
    return "1920*1080";
  }

  return "1280*720";
}


function isImage(file) {

  return !!file &&
    [
      "image/jpeg",
      "image/png",
      "image/webp"
    ].includes(
      file.mimetype
    );
}


/* =========================================================
   REPLICATE FILE UPLOAD
========================================================= */

async function uploadImageToReplicate(file) {

  if (!file) {
    throw new Error(
      "No reference image was received."
    );
  }

  if (!isImage(file)) {
    throw new Error(
      "Reference image must be JPG, PNG, or WebP."
    );
  }

  console.log(
    "MAMAKI: Uploading reference image to Replicate..."
  );

  try {

    /*
     * Replicate's Node SDK accepts a Buffer
     * as a file input.
     */

    const uploaded =
      await replicate.files.create(
        file.buffer,
        {
          filename:
            file.originalname ||
            `mamaki-${Date.now()}.jpg`
        }
      );

    console.log(
      "MAMAKI: Reference image uploaded."
    );

    /*
     * The SDK normally returns a file object
     * containing a URL.
     */

    if (
      uploaded &&
      typeof uploaded.url === "function"
    ) {
      return uploaded.url();
    }

    if (
      uploaded &&
      typeof uploaded.url === "string"
    ) {
      return uploaded.url;
    }

    if (
      typeof uploaded === "string"
    ) {
      return uploaded;
    }

    throw new Error(
      "Replicate did not return an image URL."
    );

  } catch (error) {

    console.error(
      "MAMAKI IMAGE UPLOAD ERROR:",
      error?.stack ||
      error?.message ||
      error
    );

    throw new Error(
      `Reference image upload failed: ${
        error?.message ||
        "Unknown error"
      }`
    );
  }
}


/* =========================================================
   DOWNLOAD VIDEO FROM REPLICATE
========================================================= */

async function getVideoBuffer(output) {

  if (!output) {
    throw new Error(
      "Replicate returned no video output."
    );
  }


  /*
   * Replicate Wan 2.5 normally returns
   * a FileOutput/URI.
   */

  if (
    typeof output.url === "function"
  ) {

    const url =
      output.url();

    const response =
      await fetch(url);

    if (!response.ok) {

      throw new Error(
        `Video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }


  if (
    typeof output.url === "string"
  ) {

    const response =
      await fetch(output.url);

    if (!response.ok) {

      throw new Error(
        `Video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }


  if (
    typeof output === "string"
  ) {

    const response =
      await fetch(output);

    if (!response.ok) {

      throw new Error(
        `Video download failed: HTTP ${response.status}`
      );
    }

    return Buffer.from(
      await response.arrayBuffer()
    );
  }


  if (
    Buffer.isBuffer(output)
  ) {
    return output;
  }


  if (
    output instanceof Uint8Array
  ) {
    return Buffer.from(output);
  }


  /*
   * Some Replicate SDK outputs can behave
   * like readable file objects.
   */

  if (
    typeof output.arrayBuffer === "function"
  ) {

    return Buffer.from(
      await output.arrayBuffer()
    );
  }


  throw new Error(
    "Unsupported Replicate video output format."
  );
}


/* =========================================================
   AI VIDEO GENERATION
========================================================= */

async function generateVideo(
  prompt,
  seconds,
  ratio,
  imageFile
) {

  if (!replicate) {

    throw new Error(
      "REPLICATE_API_TOKEN is missing."
    );
  }


  const cleanPrompt =
    String(
      prompt || ""
    ).trim();


  if (!cleanPrompt) {

    throw new Error(
      "Video prompt is empty."
    );
  }


  const videoDuration =
    getDuration(seconds);


  console.log(
    "======================================"
  );

  console.log(
    "MAMAKI AI VIDEO GENERATION"
  );

  console.log(
    "PROMPT:",
    cleanPrompt
  );

  console.log(
    "DURATION:",
    videoDuration
  );


  /* =======================================================
     IMAGE → VIDEO
  ======================================================= */

  if (imageFile) {

    console.log(
      "MODE: IMAGE TO VIDEO"
    );

    console.log(
      "MODEL:",
      I2V_MODEL
    );


    /*
     * Upload image first.
     */

    const imageUrl =
      await uploadImageToReplicate(
        imageFile
      );


    console.log(
      "MAMAKI: I2V image URL obtained."
    );


    const input = {

      image:
        imageUrl,

      prompt:
        cleanPrompt,

      duration:
        videoDuration,

      resolution:
        "720p",

      negative_prompt:
        "blurry, distorted, flickering, deformed, low quality, bad anatomy",

      enable_prompt_expansion:
        true
    };


    console.log(
      "MAMAKI: Calling Wan 2.5 I2V..."
    );


    try {

      const output =
        await replicate.run(
          I2V_MODEL,
          {
            input
          }
        );


      console.log(
        "MAMAKI: I2V completed."
      );


      return await getVideoBuffer(
        output
      );


    } catch (error) {

      console.error(
        "MAMAKI I2V ERROR:",
        error?.stack ||
        error?.message ||
        error
      );


      throw new Error(
        `Replicate Image-to-Video failed: ${
          error?.message ||
          "Unknown Replicate error"
        }`
      );
    }
  }


  /* =======================================================
     TEXT → VIDEO
  ======================================================= */

  console.log(
    "MODE: TEXT TO VIDEO"
  );

  console.log(
    "MODEL:",
    T2V_MODEL
  );


  const input = {

    size:
      getSize(ratio),

    prompt:
      cleanPrompt,

    duration:
      videoDuration,

    negative_prompt:
      "",

    enable_prompt_expansion:
      true
  };


  console.log(
    "SIZE:",
    input.size
  );


  console.log(
    "MAMAKI: Calling Wan 2.5 T2V..."
  );


  try {

    const output =
      await replicate.run(
        T2V_MODEL,
        {
          input
        }
      );


    console.log(
      "MAMAKI: T2V completed."
    );


    return await getVideoBuffer(
      output
    );


  } catch (error) {

    console.error(
      "MAMAKI T2V ERROR:",
      error?.stack ||
      error?.message ||
      error
    );


    throw new Error(
      `Replicate Text-to-Video failed: ${
        error?.message ||
        "Unknown Replicate error"
      }`
    );
  }
}


/* =========================================================
   FFMPEG
========================================================= */

function ffmpeg(args) {

  return new Promise(
    (
      resolve,
      reject
    ) => {

      if (!ffmpegPath) {

        reject(
          new Error(
            "FFmpeg unavailable."
          )
        );

        return;
      }


      const child =
        spawn(
          ffmpegPath,
          args
        );


      let stderr = "";


      child.stderr.on(
        "data",
        data => {

          stderr +=
            data.toString();

        }
      );


      child.on(
        "error",
        reject
      );


      child.on(
        "close",
        code => {

          if (code === 0) {

            resolve();

          } else {

            reject(
              new Error(
                `FFmpeg error: ${stderr.slice(-5000)}`
              )
            );

          }

        }
      );

    }
  );
}


/* =========================================================
   VOICE
========================================================= */

async function createVoice(
  text,
  output
) {

  const narration =
    String(
      text || ""
    ).trim();


  if (!narration) {

    throw new Error(
      "Voice text is empty."
    );
  }


  const tts =
    new EdgeTTS(
      narration,
      "en-US-AriaNeural",
      {
        rate: "+0%",
        volume: "+0%",
        pitch: "+0Hz"
      }
    );


  const result =
    await tts.synthesize();


  if (!result?.audio) {

    throw new Error(
      "Voice generation returned no audio."
    );
  }


  let buffer;


  if (
    Buffer.isBuffer(
      result.audio
    )
  ) {

    buffer =
      result.audio;

  }

  else if (
    result.audio instanceof
    Uint8Array
  ) {

    buffer =
      Buffer.from(
        result.audio
      );

  }

  else if (
    typeof result.audio.arrayBuffer ===
    "function"
  ) {

    buffer =
      Buffer.from(
        await result.audio.arrayBuffer()
      );

  }

  else {

    throw new Error(
      "Unable to read generated voice."
    );
  }


  await fs.writeFile(
    output,
    buffer
  );


  return output;
}


/* =========================================================
   GENERATE API
========================================================= */

app.post(
  "/api/generate",

  upload.fields([
    {
      name:
        "referenceImage",
      maxCount:
        1
    },

    {
      name:
        "music",
      maxCount:
        1
    },

    {
      name:
        "effects",
      maxCount:
        1
    }
  ]),

  async (
    req,
    res
  ) => {

    const job =
      randomUUID();


    const jobDir =
      path.join(
        TMP,
        job
      );


    await fs.mkdir(
      jobDir,
      {
        recursive: true
      }
    );


    try {

      if (!replicate) {

        return res
          .status(503)
          .json({
            ok: false,
            success: false,
            error:
              "REPLICATE_API_TOKEN is missing."
          });
      }


      const body =
        req.body || {};


      const files =
        req.files || {};


      const prompt =
        String(
          body.prompt || ""
        ).trim();


      const script =
        String(
          body.script ||
          body.voiceText ||
          ""
        ).trim();


      const seconds =
        getDuration(
          body.duration
        );


      const ratio =
        body.ratio ||
        body.aspectRatio ||
        "16:9";


      if (!prompt) {

        return res
          .status(400)
          .json({
            ok: false,
            success: false,
            error:
              "Enter a video prompt."
          });
      }


      /* ====================================================
         REFERENCE IMAGE
      ==================================================== */

      let referenceImage =
        null;


      if (
        files.referenceImage &&
        files.referenceImage[0]
      ) {

        const file =
          files.referenceImage[0];


        if (!isImage(file)) {

          return res
            .status(400)
            .json({
              ok: false,
              success: false,
              error:
                "Reference image must be JPG, PNG, or WebP."
            });
        }


        referenceImage =
          file;
      }


      /* ====================================================
         GENERATE
      ==================================================== */

      const videoBuffer =
        await generateVideo(
          prompt,
          seconds,
          ratio,
          referenceImage
        );


      if (
        !videoBuffer ||
        !videoBuffer.length
      ) {

        throw new Error(
          "AI model returned an empty video."
        );
      }


      /* ====================================================
         SAVE VIDEO
      ==================================================== */

      const videoName =
        `mamaki-${Date.now()}-${randomUUID()}.mp4`;


      const videoPath =
        path.join(
          OUTPUT,
          videoName
        );


      await fs.writeFile(
        videoPath,
        videoBuffer
      );


      console.log(
        "MAMAKI: Video saved:",
        videoName
      );


      /* ====================================================
         OPTIONAL VOICE
      ==================================================== */

      if (
        body.voiceEnabled !== "false" &&
        script
      ) {

        try {

          const voice =
            path.join(
              jobDir,
              "voice.mp3"
            );


          await createVoice(
            script,
            voice
          );


          console.log(
            "MAMAKI: Voice generated."
          );


        } catch (
          voiceError
        ) {

          console.error(
            "VOICE ERROR:",
            voiceError?.message ||
            voiceError
          );
        }
      }


      /* ====================================================
         SUCCESS
      ==================================================== */

      return res.json({

        ok: true,

        success: true,

        videoUrl:
          `/api/video/${encodeURIComponent(
            videoName
          )}`,

        file:
          videoName,

        message:
          "MAMAKI video generated successfully."
      });


    } catch (error) {

      console.error(
        "======================================"
      );

      console.error(
        "MAMAKI GENERATION ERROR:"
      );

      console.error(
        error?.stack ||
        error?.message ||
        error
      );

      console.error(
        "======================================"
      );


      return res
        .status(500)
        .json({

          ok: false,

          success: false,

          error:
            error?.message ||
            "Video generation failed."
        });


    } finally {

      await fs.rm(
        jobDir,
        {
          recursive: true,
          force: true
        }
      ).catch(
        () => {}
      );

    }
  }
);


/* =========================================================
   MULTER / UPLOAD ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    if (
      error instanceof multer.MulterError
    ) {

      console.error(
        "MULTER ERROR:",
        error
      );


      return res
        .status(400)
        .json({

          ok: false,

          success: false,

          error:
            `Upload error: ${error.message}`
        });
    }


    if (error) {

      console.error(
        "UPLOAD ERROR:",
        error?.stack ||
        error?.message ||
        error
      );


      return res
        .status(400)
        .json({

          ok: false,

          success: false,

          error:
            error?.message ||
            "File upload failed."
        });
    }


    next();
  }
);


/* =========================================================
   VIDEO DELIVERY
========================================================= */

app.get(
  "/api/video/:file",

  async (
    req,
    res
  ) => {

    const filename =
      path.basename(
        req.params.file
      );


    const video =
      path.join(
        OUTPUT,
        filename
      );


    try {

      await fs.access(
        video
      );


      res.setHeader(
        "Content-Type",
        "video/mp4"
      );


      res.setHeader(
        "Content-Disposition",
        `inline; filename="${filename}"`
      );


      return res.sendFile(
        video
      );


    } catch {

      return res
        .status(404)
        .json({

          ok: false,

          error:
            "Video not found."
        });
    }
  }
);


/* =========================================================
   STATUS
========================================================= */

app.get(
  "/api/status",

  async (
    req,
    res
  ) => {

    return res.json({

      app:
        "MAMAKI AI VIDEO",

      version:
        "5.3.0",

      server:
        "online",

      replicate:
        Boolean(replicate),

      textToVideo:
        T2V_MODEL,

      imageToVideo:
        I2V_MODEL,

      voiceOver:
        true,

      ffmpeg:
        Boolean(ffmpegPath),

      interface:
        "index.html",

      aiGeneration:
        true
    });
  }
);


/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",

  (
    req,
    res
  ) => {

    return res.json({

      status:
        "ok",

      app:
        "MAMAKI AI VIDEO",

      version:
        "5.3.0"
    });
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
      "======================================"
    );

    console.log(
      "MAMAKI AI VIDEO v5.3.0"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `INDEX: ${INDEX}`
    );

    console.log(
      `REPLICATE TOKEN: ${
        TOKEN
          ? "FOUND"
          : "MISSING"
      }`
    );

    console.log(
      `FFMPEG: ${
        ffmpegPath
          ? "FOUND"
          : "MISSING"
      }`
    );

    console.log(
      `TEXT TO VIDEO: ${T2V_MODEL}`
    );

    console.log(
      `IMAGE TO VIDEO: ${I2V_MODEL}`
    );

    console.log(
      "IMAGE UPLOAD: ENABLED"
    );

    console.log(
      "AI GENERATION: ENABLED"
    );

    console.log(
      "======================================"
    );
  }
);
