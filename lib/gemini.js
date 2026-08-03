// Gemini call with Google Search grounding — the Scout agent's discovery brain.
//
// Grounding lets Gemini pull in fresh, real web results (its analog to Grok's
// live X search), so leads reference posts that actually exist rather than
// being made up. Free key: https://aistudio.google.com/app/apikey

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Run one grounded generation and return { text, sources }.
 * `sources` is the list of web URLs Gemini actually grounded on, which we use
 * to sanity-check that a lead's URL wasn't invented.
 */
export async function groundedGenerate({ apiKey, model, prompt, temperature }) {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
  };
  // Only override temperature when explicitly configured — Gemini 3 "thinking"
  // models reason best at their default sampling.
  if (typeof temperature === "number") {
    body.generationConfig = { temperature };
  }

  // Auth via header (keeps the key out of URLs / request logs) per
  // https://ai.google.dev/gemini-api/docs/api-key
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `Gemini request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = data?.error; // includes QuotaFailure metric/limit when present
    throw err;
  }

  const cand = data?.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text).filter(Boolean).join("") ?? "";

  // Grounding metadata: the real URLs backing this answer.
  const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
  const sources = chunks
    .map((c) => c?.web?.uri)
    .filter(Boolean);

  return { text, sources };
}

/**
 * Pull the first JSON array out of a model response. Gemini sometimes wraps
 * JSON in ```json fences or adds prose around it, so we extract defensively.
 */
export function extractJsonArray(text) {
  if (!text) return [];
  // Strip code fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;

  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];

  const slice = candidate.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
