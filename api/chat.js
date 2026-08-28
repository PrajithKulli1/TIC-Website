import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// Hugging Face configuration
const HF_TOKEN = process.env.HF_TOKEN;
const MODEL = "HuggingFaceTB/SmolLM3-3B";

// Get the directory containing this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project structure:
//
// TIC/
// ├── api/
// │   └── chat.js
// └── knowledge/
//     └── tic.md
//
// Therefore, knowledge/tic.md is one directory above api/

const knowledgePath = path.join(
  __dirname,
  "..",
  "knowledge",
  "tic.md"
);

// Load TIC knowledge
function loadKnowledge() {
  try {
    return fs.readFileSync(knowledgePath, "utf8");
  } catch (error) {
    console.error("Could not load TIC knowledge file:", error);
    throw new Error("TIC knowledge file could not be loaded.");
  }
}

// Split knowledge into chunks
function splitIntoChunks(text) {
  return text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

// Score how relevant a chunk is to the user's question
function scoreChunk(chunk, query) {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 2);

  const lowerChunk = chunk.toLowerCase();

  let score = 0;

  for (const word of words) {
    if (lowerChunk.includes(word)) {
      score++;
    }
  }

  return score;
}

// Retrieve the most relevant knowledge chunks
function retrieveRelevantChunks(knowledge, query) {
  const chunks = splitIntoChunks(knowledge);

  return chunks
    .map((chunk) => ({
      chunk,
      score: scoreChunk(chunk, query),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => item.chunk);
}

// Send the question to Hugging Face
async function askHuggingFace(message, context) {
  const response = await fetch(
    "https://router.huggingface.co/v1/chat/completions",
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        model: MODEL,

        messages: [
          {
            role: "system",

            content: `
You are the official AI assistant for TIC — Technology & Innovation Consulting.

Answer questions about TIC accurately, helpfully, and conversationally.

Use the provided TIC knowledge as your primary source of truth.

Rules:

1. Do not invent facts about TIC.
2. If the knowledge does not contain enough information to answer a question, say that you don't have enough information.
3. Do not pretend TIC has projects, clients, partnerships, awards, employees, or capabilities that are not supported by the knowledge.
4. Do not make up prices, services, statistics, timelines, or other business information.
5. Keep answers concise and conversational.
6. When appropriate, direct potential clients toward contacting TIC.
7. Be professional but not overly corporate.
8. If a user asks something unrelated to TIC, answer briefly if appropriate, but make it clear that you are TIC's assistant.
9. Never claim to be a human employee of TIC.
10. Only use the knowledge provided below when making factual claims about TIC.

TIC KNOWLEDGE:

${context}
            `,
          },

          {
            role: "user",
            content: message,
          },
        ],

        max_tokens: 500,
        temperature: 0.3,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    console.error(
      "Hugging Face API error:",
      response.status,
      errorText
    );

    throw new Error("Hugging Face request failed.");
  }

  const data = await response.json();

  const answer =
    data.choices?.[0]?.message?.content;

  if (!answer) {
    console.error("Unexpected Hugging Face response:", data);

    throw new Error(
      "Hugging Face returned an invalid response."
    );
  }

  return answer;
}

// Chat endpoint
app.post("/chat", async (req, res) => {
  try {
    const message = req.body?.message?.trim();

    // Validate message
    if (!message) {
      return res.status(400).json({
        error: "Please provide a message.",
      });
    }

    // Validate Hugging Face token
    if (!HF_TOKEN) {
      console.error("HF_TOKEN environment variable is missing.");

      return res.status(500).json({
        error: "Hugging Face token is not configured.",
      });
    }

    // Load knowledge
    const knowledge = loadKnowledge();

    // Retrieve relevant information
    const relevantChunks = retrieveRelevantChunks(
      knowledge,
      message
    );

    // Combine retrieved information
    const context = relevantChunks.join(
      "\n\n---\n\n"
    );

    // Generate answer
    const answer = await askHuggingFace(
      message,
      context
    );

    // Send response
    return res.json({
      answer,
    });
  } catch (error) {
    console.error("Chat API error:", error);

    return res.status(500).json({
      error:
        "The AI assistant could not process your request.",
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("TIC AI backend is running.");
});

// Start server
app.listen(PORT, () => {
  console.log(
    `TIC AI server running on port ${PORT}`
  );

  console.log(
    `Knowledge file: ${knowledgePath}`
  );
});
