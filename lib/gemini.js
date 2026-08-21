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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Transient statuses worth retrying: model overloaded / server hiccup / rate limit.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export async function groundedGenerate({ apiKey, model, prompt, temperature, thinkingLevel, maxRetries = 4 }) {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
  };
  const genCfg = {};
  // Only override temperature when explicitly configured.
  if (typeof temperature === "number") genCfg.temperature = temperature;
  // Lower thinking = far fewer (output-priced) thinking tokens. Extraction
  // tasks don't need deep reasoning, so this is the main cost lever.
  if (thinkingLevel) genCfg.thinkingConfig = { thinkingLevel };
  if (Object.keys(genCfg).length) body.generationConfig = genCfg;

  let data, res;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Auth via header (keeps the key out of URLs / request logs) per
    // https://ai.google.dev/gemini-api/docs/api-key
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });
    data = await res.json();
    if (res.ok) break;

    // Retry transient errors (e.g. 503 "model overloaded") with backoff.
    if (RETRYABLE.has(res.status) && attempt < maxRetries) {
      const waitMs = Math.min(30000, 2000 * 2 ** attempt); // 2s, 4s, 8s, 16s…
      console.warn(
        `  [${model}] ${res.status} ${data?.error?.status || ""} — retry ${attempt + 1}/${maxRetries} in ${waitMs / 1000}s`
      );
      await sleep(waitMs);
      continue;
    }

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

  // Token usage, so cost can be logged/estimated per run.
  const u = data?.usageMetadata ?? {};
  const usage = {
    input: u.promptTokenCount ?? 0,
    thoughts: u.thoughtsTokenCount ?? 0,
    output: u.candidatesTokenCount ?? 0,
    total: u.totalTokenCount ?? 0,
  };

  return { text, sources, usage };
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
