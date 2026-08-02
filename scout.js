// Scout Gemini agent
// ------------------
// Discovers fresh "looking to hire an artist" posts using Gemini + Google
// Search grounding, normalizes them into the Scout lead schema, merges them
// into leads.json (dedupe by post_id, newest-first), and writes the file.
//
// The Scout iOS app fetches this leads.json alongside the other agents'
// (Scout_Grok, redd0tBot) and merges them all by post_id.
//
// Usage:
//   node scout.js            # discover, merge, write leads.json
//   node scout.js --dry-run  # discover + print, don't write the file

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { groundedGenerate, extractJsonArray } from "./lib/gemini.js";
import { mergeLeads } from "./lib/leads.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEADS_PATH = path.join(__dirname, "leads.json");
const CONFIG_PATH = path.join(__dirname, "config.json");

const DRY_RUN = process.argv.includes("--dry-run");
const API_KEY = process.env.GEMINI_API_KEY;

function buildPrompt(query, recencyDays) {
  return `You are a lead-scout for a marketplace that connects clients with artists.

TASK: Using web search, find REAL, RECENT public social-media / forum posts
(from roughly the last ${recencyDays} days) where someone is looking to HIRE or
COMMISSION an artist. Focus on this intent: "${query}".

Only include posts that are genuine hiring/commission requests from the person
who wants to hire — not artists advertising themselves, not news, not listicles.

Return ONLY a JSON array (no prose, no markdown fences). Each element:
{
  "platform":  "e.g. Twitter/X, Reddit, Instagram",
  "source":    "the poster's @handle or username",
  "author":    "the poster's display name",
  "title":     "short summary of what they want, e.g. 'Looking for concept artist'",
  "content":   "the relevant text of the post",
  "url":       "the DIRECT link to the post (must be a real URL you found)",
  "quality":   "High Quality | Medium | Low (High if budget stated / detailed brief)",
  "budget":    "stated budget like '$200' or '' if none",
  "created_at": "ISO 8601 timestamp of the post if known, else ''"
}

Rules:
- Do NOT fabricate URLs, handles, or posts. If you cannot verify a link, omit it.
- Prefer posts that mention a budget or a clear brief.
- If you find nothing credible, return [].
- Return at most 15 items.`;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  if (!API_KEY) {
    console.error(
      "Missing GEMINI_API_KEY. Set it in .env (local) or as a repo secret (CI).\n" +
        "Free key: https://aistudio.google.com/app/apikey"
    );
    process.exit(1);
  }

  const config = await readJson(CONFIG_PATH, {});
  const model = config.model || "gemini-2.0-flash";
  const recencyDays = config.recencyDays || 7;
  const maxLeads = config.maxLeadsInFile || 150;
  const queries = Array.isArray(config.queries) && config.queries.length
    ? config.queries
    : ["looking to hire an artist for a paid commission"];

  const existing = await readJson(LEADS_PATH, []);
  console.log(`Loaded ${existing.length} existing leads. Running ${queries.length} queries with ${model}…`);

  const found = [];
  for (const query of queries) {
    try {
      const { text, sources } = await groundedGenerate({
        apiKey: API_KEY,
        model,
        prompt: buildPrompt(query, recencyDays),
      });
      const items = extractJsonArray(text);

      // Keep only leads whose URL host appears among grounded sources, when we
      // have grounding data — a cheap guard against invented links.
      const grounded = items.filter((it) => {
        if (!sources.length) return true; // no metadata -> don't over-filter
        try {
          const host = new URL(it.url).hostname.replace(/^www\./, "");
          return sources.some((s) => s.includes(host) || host.includes("x.com"));
        } catch {
          return false;
        }
      });

      console.log(`  "${query}" -> ${items.length} parsed, ${grounded.length} kept`);
      found.push(...grounded);
    } catch (err) {
      console.warn(`  "${query}" -> error: ${err.message}`);
    }
  }

  const merged = mergeLeads(existing, found, { maxLeads });
  const added = merged.length - existing.length;
  console.log(`\nDiscovered ${found.length} raw leads; file now has ${merged.length} (${added >= 0 ? "+" : ""}${added}).`);

  if (DRY_RUN) {
    console.log("\n--dry-run: not writing leads.json. Sample of newest:\n");
    console.log(JSON.stringify(merged.slice(0, 3), null, 2));
    return;
  }

  await fs.writeFile(LEADS_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
  console.log(`Wrote ${LEADS_PATH}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
