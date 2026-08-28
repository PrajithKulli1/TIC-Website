import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const HF_TOKEN = process.env.HF_TOKEN;
const MODEL = "HuggingFaceTB/SmolLM3-3B";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// knowledge/tic.md is one folder above api/
const knowledgePath = path.join(
  process.cwd(),
  "..",
  "knowledge",
  "tic.md"
);

function loadKnowledge() {
  return fs.readFileSync(knowledgePath, "utf8");
}

function splitIntoChunks(text) {
  return text
    .split(/\n\s*\n/)
    .map(chunk => chunk.trim())
    .filter(Boolean);
}

function scoreChunk(chunk, query) {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter(word => word.length > 2);

  const lowerChunk = chunk.toLowerCase();

  let score = 0;

  for (const word of words) {
    if (lowerChunk.includes(word)) {
      score++;
    }
  }

  return score;
}

function retrieveRelevantChunks(knowledge, query) {
  const chunks = splitIntoChunks(knowledge);

  return chunks
    .map(chunk => ({
      chunk,
      score: scoreChunk(chunk, query)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(item => item.chunk);
}

async function askHuggingFace(message, context) {
  const response = await fetch(
    "https://router.huggingface.co/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "system",
            content: `
You are the official AI assistant for TIC — Technology & Innovation Consulting.

Answer questions about TIC accurately and helpfully.

Use the provided TIC knowledge as your primary source of truth.

Rules:

1. Do not invent facts about TIC.
2. If the knowledge does not contain enough information, say you don't have enough information.
3. Do not pretend TIC has projects, clients, partnerships, awards, employees, or capabilities that are not supported by the knowledge.
4. Keep answers concise and conversational.
5. When appropriate, direct potential clients toward contacting TIC.
6. Be professional but not overly corporate.

TIC knowledge:

${context}
`
          },
          {
            role: "user",
            content: message
          }
        ],
        max_tokens: 500,
        temperature: 0.3
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Hugging Face error:", errorText);
    throw new Error("Hugging Face request failed");
  }

  const data = await response.json();

  return (
    data.choices?.[0]?.message?.content ||
    "I wasn't able to generate a response."
  );
}

app.post("/chat", async (req, res) => {
  try {
    const message = req.body?.message?.trim();

    if (!message) {
      return res.status(400).json({
        error: "Please provide a message."
      });
    }

    if (!HF_TOKEN) {
      return res.status(500).json({
        error: "Hugging Face token is not configured."
      });
    }

    const knowledge = loadKnowledge();

    const relevantChunks = retrieveRelevantChunks(
      knowledge,
      message
    );

    const context = relevantChunks.join(
      "\n\n---\n\n"
    );

    const answer = await askHuggingFace(
      message,
      context
    );

    res.json({
      answer
    });

  } catch (error) {
    console.error("Chat API error:", error);

    res.status(500).json({
      error: "The AI assistant could not process your request."
    });
  }
});

app.get("/", (req, res) => {
  res.send("TIC AI backend is running.");
});

app.listen(PORT, () => {
  console.log(`TIC AI server running on port ${PORT}`);
});
