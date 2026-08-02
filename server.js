// Scout Gemini API — a thin proxy over Google's free-tier Gemini API.
//
// Your Google AI Studio key lives here on the server (never in the client /
// Scout agent), and the app calls simple JSON endpoints instead of talking to
// Google directly. Free key: https://aistudio.google.com/app/apikey
//
// Endpoints:
//   GET  /health              -> liveness + configured model
//   POST /api/generate        -> { prompt, system?, model?, temperature? }
//   POST /api/chat            -> { messages: [{role,content}], system?, model?, temperature? }
//   POST /api/chat/stream     -> same body as /api/chat, streams text chunks (SSE)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.GEMINI_API_KEY;
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const PORT = process.env.PORT || 3000;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

if (!API_KEY) {
  console.warn(
    "\n[warn] GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.\n" +
      "       Get a free key at https://aistudio.google.com/app/apikey\n"
  );
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Let the demo page reuse the same client module the Scout agent imports.
app.get("/scoutGemini.js", (_req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "scoutGemini.js"));
});

// ---- helpers ---------------------------------------------------------------

// Convert an OpenAI-style messages array into Gemini's `contents` format.
function toGeminiContents(messages) {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content ?? "") }],
    }));
}

function buildBody({ contents, system, temperature }) {
  const body = { contents };
  if (system) {
    body.systemInstruction = { parts: [{ text: String(system) }] };
  }
  if (temperature != null) {
    body.generationConfig = { temperature: Number(temperature) };
  }
  return body;
}

async function callGemini({ model, body, signal }) {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json();
  if (!res.ok) {
    const message = data?.error?.message || `Gemini request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.details = data?.error;
    throw err;
  }
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  return { text, raw: data };
}

function requireKey(res) {
  if (!API_KEY) {
    res.status(500).json({
      error:
        "Server missing GEMINI_API_KEY. Add it to .env — see README / .env.example.",
    });
    return false;
  }
  return true;
}

// ---- routes ----------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    model: DEFAULT_MODEL,
    keyConfigured: Boolean(API_KEY),
  });
});

// Single-shot prompt.
app.post("/api/generate", async (req, res) => {
  if (!requireKey(res)) return;
  const { prompt, system, model, temperature } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Body must include a string `prompt`." });
  }
  try {
    const body = buildBody({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      system,
      temperature,
    });
    const { text } = await callGemini({ model: model || DEFAULT_MODEL, body });
    res.json({ text, model: model || DEFAULT_MODEL });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

// Multi-turn chat.
app.post("/api/chat", async (req, res) => {
  if (!requireKey(res)) return;
  const { messages, system, model, temperature } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Body must include a non-empty `messages` array." });
  }
  // A leading system message is honored if `system` isn't passed explicitly.
  const sys = system || messages.find((m) => m.role === "system")?.content;
  try {
    const body = buildBody({
      contents: toGeminiContents(messages),
      system: sys,
      temperature,
    });
    const { text } = await callGemini({ model: model || DEFAULT_MODEL, body });
    res.json({ text, model: model || DEFAULT_MODEL });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

// Streaming chat over Server-Sent Events.
app.post("/api/chat/stream", async (req, res) => {
  if (!requireKey(res)) return;
  const { messages, system, model, temperature } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Body must include a non-empty `messages` array." });
  }
  const sys = system || messages.find((m) => m.role === "system")?.content;
  const useModel = model || DEFAULT_MODEL;
  const body = buildBody({
    contents: toGeminiContents(messages),
    system: sys,
    temperature,
  });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const url = `${GEMINI_BASE}/models/${encodeURIComponent(useModel)}:streamGenerateContent?alt=sse&key=${API_KEY}`;
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!upstream.ok || !upstream.body) {
      const errData = await upstream.json().catch(() => ({}));
      res.write(
        `data: ${JSON.stringify({ error: errData?.error?.message || "stream failed" })}\n\n`
      );
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const json = trimmed.slice(5).trim();
        if (!json) continue;
        try {
          const parsed = JSON.parse(json);
          const chunk =
            parsed?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
          if (chunk) res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
        } catch {
          // ignore partial/non-JSON keepalive lines
        }
      }
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Scout Gemini API listening on http://localhost:${PORT}`);
  console.log(`Model: ${DEFAULT_MODEL} | Demo UI: http://localhost:${PORT}/`);
});
