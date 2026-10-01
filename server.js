import "dotenv/config";
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const app = express();

const PORT = process.env.PORT || 3000;
const MAX_FILES_PER_BATCH =
  Number(process.env.MAX_FILES_PER_BATCH || 20);
const MAX_FILE_MB =
  Number(process.env.MAX_FILE_MB || 25);

const DATA_DIR = path.join(process.cwd(), "jobs");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const OUTPUT_DIR = path.join(DATA_DIR, "outputs");

for (const dir of [
  DATA_DIR,
  UPLOAD_DIR,
  OUTPUT_DIR
]) {
  fs.mkdirSync(dir, { recursive: true });
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: MAX_FILE_MB * 1024 * 1024
  }
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

/* =========================
   HEALTH
========================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "Lynn Movie Recap",
    version: "1.0.0"
  });
});

/* =========================
   TRANSCRIBE MP4 → SRT
========================= */

app.post(
  "/api/transcribe",
  upload.single("video"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "MP4 video ရွေးပါ။"
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      removeFile(req.file.path);

      return res.status(500).json({
        error: "OPENAI_API_KEY မထည့်ရသေးပါ။"
      });
    }

    try {
      const result =
        await client.audio.transcriptions.create({
          file: fs.createReadStream(req.file.path),
          model: "gpt-4o-transcribe",
          response_format: "verbose_json",
          timestamp_granularities: ["segment"]
        });

      const segments =
        result.segments || [];

      const srt =
        segmentsToSrt(segments);

      removeFile(req.file.path);

      res.json({
        ok: true,
        text: result.text || "",
        srt,
        segments: segments.length
      });

    } catch (error) {
      console.error(
        "TRANSCRIBE ERROR:",
        error
      );

      removeFile(req.file.path);

      res.status(500).json({
        error:
          error?.message ||
          "Transcription failed"
      });
    }
  }
);

/* =========================
   TEXT → AI VOICE
========================= */

app.post(
  "/api/tts",
  async (req, res) => {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "OPENAI_API_KEY မထည့်ရသေးပါ။"
      });
    }

    const {
      text,
      voice = "alloy"
    } = req.body;

    if (!text?.trim()) {
      return res.status(400).json({
        error: "AI Voice အတွက် စာသားထည့်ပါ။"
      });
    }

    try {
      const speech =
        await client.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice,
          input: text.trim(),
          response_format: "mp3"
        });

      const buffer =
        Buffer.from(
          await speech.arrayBuffer()
        );

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      res.setHeader(
        "Content-Disposition",
        'inline; filename="lynn-ai-voice.mp3"'
      );

      res.send(buffer);

    } catch (error) {
      console.error(
        "TTS ERROR:",
        error
      );

      res.status(500).json({
        error:
          error?.message ||
          "AI Voice failed"
      });
    }
  }
);

/* =========================
   FINAL RENDER
========================= */

app.post(
  "/api/render",
  upload.fields([
    {
      name: "video",
      maxCount: 1
    },
    {
      name: "logo",
      maxCount: 1
    }
  ]),
  async (req, res) => {

    const video =
      req.files?.video?.[0];

    const logo =
      req.files?.logo?.[0];

    if (!video) {
      return res.status(400).json({
        error: "MP4 video ရွေးပါ။"
      });
    }

    try {

      const {
        srt = "",
        voiceText = "",
        voice = "alloy",
        subtitleSize = "28",
        subtitleMargin = "80",
        subtitleColor = "FFFFFF",
        subtitleOutline = "3",
        blur = "false",
        logoEnabled = "false",
        logoPosition = "top-right"
      } = req.body;

      const jobId =
        crypto.randomUUID();

      const jobDir =
        path.join(DATA_DIR, jobId);

      fs.mkdirSync(
        jobDir,
        { recursive: true }
      );

      const inputVideo =
        path.join(
          jobDir,
          "input.mp4"
        );

      const srtFile =
        path.join(
          jobDir,
          "subtitle.srt"
        );

      const voiceFile =
        path.join(
          jobDir,
          "voice.mp3"
        );

      const outputFile =
        path.join(
          OUTPUT_DIR,
          `${jobId}.mp4`
        );

      fs.copyFileSync(
        video.path,
        inputVideo
      );

      removeFile(video.path);

      if (logo) {
        fs.copyFileSync(
          logo.path,
          path.join(
            jobDir,
            "logo.png"
          )
        );

        removeFile(logo.path);
      }

      if (srt.trim()) {
        fs.writeFileSync(
          srtFile,
          srt,
          "utf8"
        );
      }

      /*
       * Generate AI Voice
       */

      if (voiceText.trim()) {

        if (!process.env.OPENAI_API_KEY) {
          return res.status(500).json({
            error:
              "OPENAI_API_KEY မထည့်ရသေးပါ။"
          });
        }

        const speech =
          await client.audio.speech.create({
            model: "gpt-4o-mini-tts",
            voice,
            input: voiceText.trim(),
            response_format: "mp3"
          });

        const buffer =
          Buffer.from(
            await speech.arrayBuffer()
          );

        fs.writeFileSync(
          voiceFile,
          buffer
        );
      }

      /*
       * Build FFmpeg filters
       */

      const filters = [];

      /*
       * Blur
       */

      if (
        String(blur).toLowerCase() ===
        "true"
      ) {
        filters.push(
          "boxblur=2:1"
        );
      }

      /*
       * Myanmar subtitles
       */

      if (
        srt.trim() &&
        fs.existsSync(srtFile)
      ) {

        const escapedSrt =
          escapeSubtitlePath(
            srtFile
          );

        const size =
          clampNumber(
            subtitleSize,
            12,
            80
          );

        const margin =
          clampNumber(
            subtitleMargin,
            10,
            300
          );

        const outline =
          clampNumber(
            subtitleOutline,
            0,
            10
          );

        const color =
          /^[0-9a-fA-F]{6}$/.test(
            subtitleColor
          )
            ? subtitleColor
            : "FFFFFF";

        filters.push(
          `subtitles='${escapedSrt}':force_style='FontName=Noto Sans Myanmar,FontSize=${size},PrimaryColour=&H${color},OutlineColour=&H000000,Outline=${outline},Shadow=1,MarginV=${margin},Alignment=2'`
        );
      }

      /*
       * Logo
       */

      const logoFile =
        path.join(
          jobDir,
          "logo.png"
        );

      const hasLogo =
        String(logoEnabled)
          .toLowerCase() ===
          "true" &&
        fs.existsSync(logoFile);

      /*
       * FFmpeg arguments
       */

      const args = [
        "-y",
        "-i",
        inputVideo
      ];

      if (hasLogo) {
        args.push(
          "-i",
          logoFile
        );
      }

      if (
        fs.existsSync(voiceFile)
      ) {
        args.push(
          "-i",
          voiceFile
        );
      }

      /*
       * Video filter
       */

      let filterComplex = "";

      if (
        filters.length === 0 &&
        !hasLogo
      ) {
        filterComplex = "";
      } else {

        let videoChain =
          "[0:v]";

        if (filters.length) {
          videoChain +=
            filters.join(",") +
            ",";
        }

        if (hasLogo) {

          videoChain +=
            "format=yuv420p[base]";

          let logoOverlay;

          switch (
            logoPosition
          ) {

            case "top-left":
              logoOverlay =
                "[1:v]scale=180:-1[logo];" +
                "[base][logo]overlay=20:20[vout]";
              break;

            case "bottom-left":
              logoOverlay =
                "[1:v]scale=180:-1[logo];" +
                "[base][logo]overlay=20:H-h-20[vout]";
              break;

            case "bottom-right":
              logoOverlay =
                "[1:v]scale=180:-1[logo];" +
                "[base][logo]overlay=W-w-20:H-h-20[vout]";
              break;

            default:
              logoOverlay =
                "[1:v]scale=180:-1[logo];" +
                "[base][logo]overlay=W-w-20:20[vout]";
          }

          filterComplex =
            videoChain +
            ";" +
            logoOverlay;

        } else {

          videoChain +=
            "format=yuv420p[vout]";

          filterComplex =
            videoChain;
        }
      }

      if (filterComplex) {
        args.push(
          "-filter_complex",
          filterComplex
        );
      }

      /*
       * Video mapping
       */

      if (filterComplex) {
        args.push(
          "-map",
          "[vout]"
        );
      } else {
        args.push(
          "-map",
          "0:v:0"
        );
      }

      /*
       * Audio
       */

      if (
        fs.existsSync(voiceFile)
      ) {

        args.push(
          "-map",
          `${hasLogo ? "2" : "1"}:a:0`
        );

      } else {

        args.push(
          "-map",
          "0:a?"
        );
      }

      args.push(
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "-shortest",
        outputFile
      );

      console.log(
        "FFMPEG:",
        args.join(" ")
      );

      await execFileAsync(
        "ffmpeg",
        args,
        {
          maxBuffer:
            10 * 1024 * 1024
        }
      );

      res.json({
        ok: true,
        jobId,
        download:
          `/api/render/${jobId}`,
        message:
          "Final MP4 ပြီးပါပြီ။"
      });

    } catch (error) {

      console.error(
        "RENDER ERROR:",
        error
      );

      res.status(500).json({
        error:
          error?.stderr ||
          error?.message ||
          "Render failed"
      });

    } finally {

      /*
       * Original uploaded files
       */

      if (video) {
        removeFile(
          video.path
        );
      }

      if (logo) {
        removeFile(
          logo.path
        );
      }
    }
  }
);

/* =========================
   DOWNLOAD FINAL MP4
========================= */

app.get(
  "/api/render/:id",
  (req, res) => {

    const id =
      safeId(req.params.id);

    if (!id) {
      return res.status(400).json({
        error: "Invalid job ID"
      });
    }

    const file =
      path.join(
        OUTPUT_DIR,
        `${id}.mp4`
      );

    if (!fs.existsSync(file)) {
      return res.status(404).json({
        error:
          "Final MP4 မတွေ့ပါ။"
      });
    }

    res.download(
      file,
      `Lynn-Movie-Recap-${id}.mp4`
    );
  }
);

/* =========================
   SRT DOWNLOAD
========================= */

app.post(
  "/api/download-srt",
  (req, res) => {

    const {
      srt = ""
    } = req.body;

    if (!srt.trim()) {
      return res.status(400).json({
        error: "SRT မရှိပါ။"
      });
    }

    res.setHeader(
      "Content-Type",
      "application/x-subrip; charset=utf-8"
    );

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="lynn-movie-recap.srt"'
    );

    res.send(srt);
  }
);

/* =========================
   HELPERS
========================= */

function segmentsToSrt(
  segments
) {

  let output = "";

  segments.forEach(
    (segment, index) => {

      const start =
        formatTime(
          segment.start
        );

      const end =
        formatTime(
          segment.end
        );

      const text =
        String(
          segment.text || ""
        ).trim();

      if (!text) return;

      output +=
`${index + 1}
${start} --> ${end}
${text}

`;
    }
  );

  return output;
}

function formatTime(
  seconds
) {

  const ms =
    Math.max(
      0,
      Math.round(
        Number(seconds || 0) *
        1000
      )
    );

  const hours =
    Math.floor(
      ms / 3600000
    );

  const minutes =
    Math.floor(
      (ms % 3600000) /
      60000
    );

  const secs =
    Math.floor(
      (ms % 60000) /
      1000
    );

  const millis =
    ms % 1000;

  return (
    String(hours)
      .padStart(2, "0") +
    ":" +
    String(minutes)
      .padStart(2, "0") +
    ":" +
    String(secs)
      .padStart(2, "0") +
    "," +
    String(millis)
      .padStart(3, "0")
  );
}

function clampNumber(
  value,
  min,
  max
) {

  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return min;
  }

  return Math.min(
    max,
    Math.max(
      min,
      number
    )
  );
}

function safeId(id) {

  if (
    !id ||
    !/^[a-zA-Z0-9-]+$/.test(id)
  ) {
    return null;
  }

  return id;
}

function removeFile(file) {

  if (!file) return;

  fs.unlink(
    file,
    () => {}
  );
}

function escapeSubtitlePath(
  file
) {

  return file
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

/* =========================
   ERROR HANDLER
========================= */

app.use(
  (err, req, res, next) => {

    console.error(err);

    if (
      err?.code ===
      "LIMIT_FILE_SIZE"
    ) {
      return res.status(413).json({
        error:
          `File size သည် ${MAX_FILE_MB}MB ထက်မကျော်ရပါ။`
      });
    }

    res.status(500).json({
      error:
        err?.message ||
        "Server error"
    });
  }
);

/* =========================
   START
========================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Lynn Movie Recap running on port ${PORT}`
    );
  }
);
