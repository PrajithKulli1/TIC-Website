import { TIC_KNOWLEDGE } from "./_knowledge.js";

const HF_TOKEN = process.env.HF_TOKEN;
const MODEL = "Qwen/Qwen2.5-7B-Instruct:featherless-ai";

// Contact info is the single most reputation-sensitive thing this bot can
// get wrong (a fabricated email or phone number actively misdirects real
// leads). Rather than trust the model to stay grounded every time, we
// answer contact-type questions directly from a fixed string and skip the
// LLM call entirely for these. Update this text if TIC's contact details
// ever change — it does NOT read from _knowledge.js automatically.
const CONTACT_REGEX =
  /\b(contact|e-?mail|phone|call you|call us|reach (you|out|us)|get in touch|how (can|do) i reach)\b/i;

const CONTACT_ANSWER =
  "You can reach us by email at ticnc.inc@gmail.com. We're based in Raleigh, NC, and remote-friendly. " +
  "We don't have a phone number set up yet — email is the best way to reach us, and we typically reply within two business days.";

const REAL_EMAIL = "ticnc.inc@gmail.com";
const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Loose match for common US phone formats. TIC doesn't publish a phone
// number, so any number matching this shape in a model response is almost
// certainly hallucinated and gets stripped.
const PHONE_REGEX = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

// Belt-and-suspenders safety net: even with strong prompt instructions, a
// small model can still invent a plausible-looking email or phone number
// on its own initiative (not just when directly asked for contact info).
// This runs on every model response and forcibly corrects or removes
// anything that doesn't match TIC's actual, real contact details.
function sanitizeAnswer(text) {
  let cleaned = text.replace(EMAIL_REGEX, (match) =>
    match.toLowerCase() === REAL_EMAIL ? REAL_EMAIL : REAL_EMAIL
  );

  // Remove the whole "...by phone at 555-1234" style clause, not just the
  // digits, so we don't leave an awkward dangling "at ." behind.
  cleaned = cleaned.replace(
    /(,?\s*(or\s+)?(by\s+)?(phone|call(ing)?)\s*(us|you)?\s*(at)?\s*)?(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b\.?/gi,
    ""
  );

  cleaned = cleaned
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .trim();

  return cleaned;
}

// Comma-separated list of allowed frontend origins.
// Set ALLOWED_ORIGINS in your Vercel project's Environment Variables, e.g.:
// ALLOWED_ORIGINS=https://prajithkulli1.github.io
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((origin) => origin.trim());

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;

  if (ALLOWED_ORIGINS.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function splitIntoChunks(text) {
  return text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function scoreChunk(chunk, query) {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 2);

  const lowerChunk = chunk.toLowerCase();
  let score = 0;

  for (const word of words) {
    if (lowerChunk.includes(word)) score++;
  }

  return score;
}

function retrieveRelevantChunks(knowledge, query) {
  const chunks = splitIntoChunks(knowledge);

  return chunks
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => item.chunk);
}

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
You are TIC's own AI assistant, speaking on behalf of TIC — Technology & Innovation Consulting.

Always speak in first person as TIC. Use "we" and "us" (e.g. "we focus on small businesses," "you can reach us at..."). Never refer to TIC in the third person (never say "they" or "TIC does X" as if you were an outside observer describing the company).

Answer questions about TIC accurately and helpfully.

Use the provided TIC knowledge as your primary source of truth.

Rules:

1. Do not invent facts about TIC.
2. If the knowledge does not contain enough information, say you don't have enough information.
3. Do not pretend TIC has projects, clients, partnerships, awards, employees, or capabilities that are not supported by the knowledge.
4. Keep answers concise and conversational.
5. When appropriate, invite the person to reach out to us directly.
6. Be professional but not overly corporate.
7. If asked for contact details, give ONLY the exact email address written in the knowledge below. TIC has no phone number and no social media accounts — never invent one, even to sound more complete or helpful.
8. Do not volunteer contact information (email, phone, etc.) unless the person specifically asks how to reach TIC. A plain greeting or general question does not need a sign-off with contact details.

TIC knowledge:

${context}
`,
          },
          { role: "user", content: message },
        ],
        max_tokens: 500,
        temperature: 0.3,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Hugging Face error:", errorText);
    throw new Error("Hugging Face request failed");
  }

  const data = await response.json();

  const rawAnswer =
    data.choices?.[0]?.message?.content ||
    "I wasn't able to generate a response.";

  return sanitizeAnswer(rawAnswer);
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const message = (req.body?.message || "").trim();

    if (!message) {
      return res.status(400).json({ error: "Please provide a message." });
    }

    if (CONTACT_REGEX.test(message)) {
      return res.status(200).json({ answer: CONTACT_ANSWER });
    }

    if (!HF_TOKEN) {
      return res.status(500).json({
        error: "Hugging Face token is not configured.",
      });
    }

    const relevantChunks = retrieveRelevantChunks(TIC_KNOWLEDGE, message);
    const context = relevantChunks.join("\n\n---\n\n");
    const answer = await askHuggingFace(message, context);

    res.status(200).json({ answer });
  } catch (error) {
    console.error("Chat API error:", error);
    res.status(500).json({
      error: "The AI assistant could not process your request.",
    });
  }
}
