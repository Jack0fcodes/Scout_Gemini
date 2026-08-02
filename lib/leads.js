// Lead schema handling: normalize raw model output into the exact shape the
// Scout iOS app expects, then merge/dedupe/sort against the existing file.
//
// Schema (matches Scout_Grok / redd0tBot leads.json):
//   post_id, platform, source, author, title, content, url, quality, budget, created_at

import crypto from "node:crypto";

const QUALITY = new Set(["High Quality", "Medium", "Low"]);

function str(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}

// Derive a platform label from a URL host when the model didn't give a clean one.
function platformFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.includes("x.com") || host.includes("twitter.com")) return "Twitter/X";
    if (host.includes("reddit.com")) return "Reddit";
    if (host.includes("instagram.com")) return "Instagram";
    if (host.includes("bsky") ) return "Bluesky";
    if (host.includes("threads")) return "Threads";
    if (host.includes("facebook.com")) return "Facebook";
    return host.split(".")[0].replace(/^\w/, (c) => c.toUpperCase());
  } catch {
    return "Web";
  }
}

function stableId(platform, url, title) {
  const basis = `${platform}|${url || title}`;
  const hash = crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16);
  return `${platform}-${hash}`;
}

function normalizeQuality(q) {
  const v = str(q);
  if (QUALITY.has(v)) return v;
  const lower = v.toLowerCase();
  if (lower.startsWith("high")) return "High Quality";
  if (lower.startsWith("low")) return "Low";
  return "Medium";
}

/** Turn one raw model object into a clean lead, or null if it's unusable. */
export function normalizeLead(raw) {
  if (!raw || typeof raw !== "object") return null;

  const url = str(raw.url);
  const title = str(raw.title);
  const content = str(raw.content);
  // Need at least a title or content plus a url to be a real lead.
  if (!url || (!title && !content)) return null;

  const platform = str(raw.platform) || platformFromUrl(url);
  const post_id = str(raw.post_id) || stableId(platform, url, title);

  // Always emit ISO-8601 UTC with no fractional seconds.
  const parsed = Date.parse(str(raw.created_at));
  const created_at = (Number.isNaN(parsed) ? new Date() : new Date(parsed))
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  return {
    post_id,
    platform,
    source: str(raw.source),
    author: str(raw.author),
    title: title || content.slice(0, 60),
    content,
    url,
    quality: normalizeQuality(raw.quality),
    budget: str(raw.budget),
    created_at,
  };
}

/**
 * Merge new leads into existing ones: dedupe by post_id (and by url as a
 * fallback), keep the newest by created_at, sort newest-first, and cap length.
 */
export function mergeLeads(existing, incoming, { maxLeads = 150 } = {}) {
  const byKey = new Map();

  const add = (lead) => {
    if (!lead) return;
    const keys = [lead.post_id, lead.url].filter(Boolean);
    // If any key already maps to an entry, keep whichever is newer.
    const existingKey = keys.find((k) => byKey.has(k));
    if (existingKey) {
      const prev = byKey.get(existingKey);
      if (Date.parse(lead.created_at) > Date.parse(prev.created_at)) {
        for (const k of keys) byKey.set(k, lead);
      }
      return;
    }
    for (const k of keys) byKey.set(k, lead);
  };

  for (const l of existing) add(l);
  for (const l of incoming) add(normalizeLead(l) || null);

  // Collapse to unique lead objects (a lead may be under two keys).
  const unique = [...new Set(byKey.values())];
  unique.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return unique.slice(0, maxLeads);
}
