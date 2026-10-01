import "dotenv/config";
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

app.use(express.json({ limit: "5mb" }));
app.use(express.static("public"));

/* -----------------------------
   Health Check
----------------------------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "Lynn Movie Recap"
  });
});

/* -----------------------------
   MP4 → SRT
----------------------------- */

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
      fs.unlink(req.file.path, () => {});

      return res.status(500).json({
        error: "OPENAI_API_KEY မထည့်ရသေးပါ။"
      });
    }

    try {

      const result =
        await client.audio.transcriptions.create({
          file: fs.createReadStream(
            req.file.path
          ),
          model: "gpt-4o-transcribe",
          response_format: "verbose_json",
          timestamp_granularities: [
            "segment"
          ]
        });

      const segments =
        result.segments || [];

      let srt = "";

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

          srt +=
`${index + 1}
${start} --> ${end}
${segment.text.trim()}

`;
        }
      );

      fs.unlink(
        req.file.path,
        () => {}
      );

      res.json({
        text: result.text || "",
        srt,
        segments: segments.length
      });

    } catch (error) {

      console.error(error);

      fs.unlink(
        req.file.path,
        () => {}
      );

      res.status(500).json({
        error:
          error.message ||
          "Transcription failed"
      });
    }
  }
);

/* -----------------------------
   SRT → AI Voice
----------------------------- */

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

    if (!text) {
      return res.status(400).json({
        error: "စာသားထည့်ပါ။"
      });
    }

    try {

      const speech =
        await client.audio.speech.create({
          model: "gpt-4o-mini-tts",
          voice,
          input: text,
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

      res.send(buffer);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error:
          error.message ||
          "TTS failed"
      });
    }
  }
);

/* -----------------------------
   Helpers
----------------------------- */

function formatTime(seconds) {

  const ms =
    Math.max(
      0,
      Math.round(seconds * 1000)
    );

  const hours =
    Math.floor(
      ms / 3600000
    );

  const minutes =
    Math.floor(
      (ms % 3600000) / 60000
    );

  const secs =
    Math.floor(
      (ms % 60000) / 1000
    );

  const millis =
    ms % 1000;

  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(secs).padStart(2, "0") +
    "," +
    String(millis).padStart(3, "0")
  );
}

/* -----------------------------
   Start Server
----------------------------- */

app.listen(
  PORT,
  () => {
    console.log(
      `Lynn Movie Recap running on port ${PORT}`
    );
  }
);
