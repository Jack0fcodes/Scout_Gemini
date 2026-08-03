// One-off diagnostic: is the blocker the model, or the google_search grounding
// tool? Tests a small matrix of {model} x {plain, grounded} and prints a
// compact status per combination. Run via the "Scout Gemini Diagnose" workflow.

import dotenv from "dotenv";
dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY;
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODELS = ["gemini-3.6-flash", "gemini-2.5-flash"];

async function call(model, grounded) {
  const body = {
    contents: [{ role: "user", parts: [{ text: "Reply with exactly: OK" }] }],
  };
  if (grounded) body.tools = [{ google_search: {} }];

  const res = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const q = data?.error?.details?.find((d) =>
      String(d["@type"]).includes("QuotaFailure")
    );
    const viol = q?.violations?.[0];
    const quotaInfo = viol ? ` [${viol.quotaMetric || viol.quotaId}=${viol.quotaValue ?? "?"}]` : "";
    return `${res.status} ${data?.error?.status || ""}${quotaInfo}`;
  }
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  return `200 OK "${text.trim().slice(0, 20)}"`;
}

async function main() {
  if (!API_KEY) {
    console.error("Missing GEMINI_API_KEY");
    process.exit(1);
  }
  console.log("model                | plain (no tools)         | grounded (google_search)");
  console.log("---------------------|--------------------------|-------------------------");
  for (const model of MODELS) {
    const plain = await call(model, false).catch((e) => `ERR ${e.message}`);
    const grounded = await call(model, true).catch((e) => `ERR ${e.message}`);
    console.log(`${model.padEnd(20)} | ${plain.padEnd(24)} | ${grounded}`);
  }
}

main();
