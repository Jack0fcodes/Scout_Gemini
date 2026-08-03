// Scout Gemini agent
// ------------------
// Runs the prompt in prompt.txt against Gemini + Google Search grounding to
// discover open-web "client hiring an artist" posts (excluding X / Reddit /
// Meta, which other agents cover), normalizes them into the Scout lead schema,
// merges into leads.json (dedupe by post_id, newest-first), and writes it.
//
// The Scout iOS app fetches this leads.json alongside Scout_Grok / redd0tBot
// and merges everything by post_id.
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
const PROMPT_PATH = path.join(__dirname, "prompt.txt");

const DRY_RUN = process.argv.includes("--dry-run");
const API_KEY = process.env.GEMINI_API_KEY;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Drop leads that other agents own or that have an unusable URL.
function isAllowed(lead, excluded) {
  if (!lead?.url) return false;
  try {
    const host = new URL(lead.url).hostname.replace(/^www\./, "");
    return !excluded.some((bad) => host === bad || host.endsWith("." + bad));
  } catch {
    return false; // not a real, parseable link
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
  // Support either a single `model` or an ordered `models` fallback list.
  const candidates = Array.isArray(config.models) && config.models.length
    ? config.models
    : [config.model || "gemini-3.5-flash"];
  const maxLeads = config.maxLeadsInFile || 150;
  const passes = Math.max(1, config.passes || 1);
  const excluded = config.excludePlatforms || [];

  const prompt = (await fs.readFile(PROMPT_PATH, "utf8")).trim();
  const existing = await readJson(LEADS_PATH, []);
  console.log(
    `Loaded ${existing.length} existing leads. Candidates: ${candidates.join(", ")}. Running ${passes} pass(es)…`
  );

  // Run one grounded pass, trying candidate models until one responds. Once a
  // model works, stick with it for the rest of the run.
  let workingModel = null;
  async function runPass(i) {
    const toTry = workingModel ? [workingModel] : candidates;
    for (const model of toTry) {
      try {
        const { text, sources } = await groundedGenerate({ apiKey: API_KEY, model, prompt });
        workingModel = model;
        const items = extractJsonArray(text);
        const allowed = items.filter((it) => isAllowed(it, excluded));
        console.log(
          `  pass ${i} [${model}]: ${items.length} parsed, ${allowed.length} kept (grounded on ${sources.length} sources)`
        );
        return allowed;
      } catch (err) {
        const detail = err.details ? ` | ${JSON.stringify(err.details.details || err.details.status || "")}` : "";
        console.warn(`  pass ${i} [${model}]: ${err.status || ""} ${err.message}${detail}`);
      }
    }
    return [];
  }

  const found = [];
  for (let i = 1; i <= passes; i++) {
    found.push(...(await runPass(i)));
  }
  if (!workingModel) {
    console.warn("No candidate model succeeded — see errors above (likely free-tier/billing).");
  }

  const merged = mergeLeads(existing, found, { maxLeads });
  const added = merged.length - existing.length;
  console.log(
    `\nDiscovered ${found.length} raw leads; file now has ${merged.length} (${added >= 0 ? "+" : ""}${added}).`
  );

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
