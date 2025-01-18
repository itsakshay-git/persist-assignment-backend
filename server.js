import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import cors from "cors";
import { RevAiApiClient } from 'revai-node-sdk';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { get } from "firebase/database"; 
import admin from "firebase-admin";

dotenv.config();

// Rev.ai API key
const REV_API_KEY = process.env.REVA_AI;

const app = express();
app.use(express.json()); 
const port = 5000;

// Load the service account JSON file
const serviceAccountPath = path.resolve('./persist-ventures-assignm-4ddad-firebase-adminsdk-fbsvc-e63ec0165c.json');
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://persist-ventures-assignm-4ddad-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();
const ref = db.ref("transcripts");

app.use(
  cors({
    origin: "https://aistoriesgenerator.netlify.app",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// Initialize Google Generative AI client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API); 
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Multer setup for handling file uploads
const upload = multer({ dest: "uploads/" });

// Initialize Rev.ai client
const client = new RevAiApiClient(REV_API_KEY);

app.post("/api/transcribe-video", upload.single("video"), async (req, res) => {
  try {
    const videoPath = req.file.path;
    console.log("Video Path:", videoPath);
    const absolutePath = path.resolve(videoPath);

    if (!fs.existsSync(absolutePath)) {
      return res.status(400).json({ error: "File not found" });
    }
    
    const job = await client.submitJobLocalFile(absolutePath);
    console.log("Job ID:", job.id);

    let transcriptText = null;
    let retryCount = 0;

    while (!transcriptText && retryCount < 10) {
      const jobStatus = await client.getJobDetails(job.id);
      console.log("Job Status:", jobStatus.status);

      if (jobStatus.status === 'transcribed') {
        transcriptText = await client.getTranscriptText(job.id);
        break;
      }

      retryCount++;
      console.log(`Retrying... Attempt ${retryCount}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Save the transcript to Firebase
    if (transcriptText) {
      const newTranscriptRef = ref.push();
      await newTranscriptRef.set({
        job_id: job.id,
        video_path: videoPath,
        transcript: transcriptText,
        created_at: new Date().toISOString(),
      });

      res.json({ text: transcriptText });
    } else {
      res.status(500).json({ error: "Failed to transcribe the video" });
    }

    // Clean up the uploaded file
    fs.unlinkSync(absolutePath);
    
  } catch (error) {
    console.error("Error during transcription:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to transcribe video" });
  }
});

// Route: Generate story
app.post("/api/generate-story", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  try {
    // Fetch all transcripts from Firebase
    const snapshot = await get(ref);

    if (!snapshot.exists()) {
      return res.status(404).json({ error: "No transcripts found" });
    }

    // Extract and combine all transcript data into one string
    const results = snapshot.val();
    let combinedText = Object.values(results).map((result) => result.transcript).join("\n");

    // Generate a story using Google Gemini AI
    const fullPrompt = `${combinedText}\n\nUse the following information to create a story: ${prompt}`;

    const result = await model.generateContent(fullPrompt);
    console.log(result.response.candidates);

    if (result && result.response.text()) {
      return res.json({ story: result.response.text() });
    } else {
      return res.status(500).json({ error: "Failed to generate story" });
    }
  } catch (error) {
    console.error("Error generating story:", error.message || error.response?.data);
    return res.status(500).json({ error: "An error occurred while generating the story" });
  }
});


// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
