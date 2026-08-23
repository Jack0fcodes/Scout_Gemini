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

// ---- code-side filtering (the "cleaner") ----------------------------------
// Gemini searches broadly; these deterministic rules do the filtering, so they
// can be tuned in config.json without re-prompting or spending tokens.

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

// A generic landing/search/category page rather than a specific post.
function isGenericUrl(url) {
  try {
    const u = new URL(url);
    const p = (u.pathname || "/").replace(/\/+$/, "") || "/";
    if (p === "/") return true; // site root
    return [
      /^\/jobs$/i, /^\/jobs\/all$/i, /^\/careers$/i,
      /^\/search$/i, /\/search\//i, /^\/explore$/i,
      /^\/category/i, /^\/categories/i, /^\/tag/i, /^\/tags/i,
      /^\/board$/i, /^\/forum$/i, /^\/browse/i,
    ].some((re) => re.test(p));
  } catch {
    return true;
  }
}

const UNPAID_RE =
  /(unpaid|for exposure|for credit|rev[\s-]?share|revenue[\s-]?share|profit[\s-]?share|\bno pay\b|no budget|volunteer|for free|spec work|portfolio only)/i;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Filter normalized leads by config-driven rules:
 *   excludePlatforms  – drop leads whose url host is on these domains
 *   rejectGenericUrls – drop board/search/category/root URLs (default true)
 *   blockKeywords     – drop if any keyword appears (word-boundary) in title/content
 *   paidOnly          – drop leads whose text signals unpaid / rev-share
 * Returns { kept, dropped } with a reason tally for logging.
 */
export function cleanLeads(leads, opts = {}) {
  const excluded = opts.excludePlatforms || [];
  const rejectGeneric = opts.rejectGenericUrls !== false;
  const paidOnly = !!opts.paidOnly;
  const kwRes = (opts.blockKeywords || []).map(
    (k) => new RegExp(`\\b${escapeRe(String(k).toLowerCase())}\\b`, "i")
  );

  const dropped = { host: 0, generic: 0, keyword: 0, unpaid: 0, badurl: 0 };
  const kept = leads.filter((l) => {
    const host = hostOf(l.url);
    if (!host) { dropped.badurl++; return false; }
    if (excluded.some((b) => host === b || host.endsWith("." + b))) { dropped.host++; return false; }
    if (rejectGeneric && isGenericUrl(l.url)) { dropped.generic++; return false; }
    const text = `${l.title || ""} ${l.content || ""}`.toLowerCase();
    if (kwRes.some((re) => re.test(text))) { dropped.keyword++; return false; }
    if (paidOnly && UNPAID_RE.test(text)) { dropped.unpaid++; return false; }
    return true;
  });
  return { kept, dropped };
}

// Dedupe key from platform + normalized title (catches the same post surfaced
// under two different URLs across runs). Only used for reasonably specific titles.
function titleKey(lead) {
  const t = (lead.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return t.length >= 12 ? `${lead.platform}|${t}` : null;
}

/**
 * Normalize + optionally clean, then dedupe (by post_id, url, and title+platform),
 * keep the newest on conflict, sort newest-first, and cap length.
 */
export function mergeLeads(existing, incoming, { maxLeads = 150, clean = null } = {}) {
  let all = [...existing, ...incoming].map(normalizeLead).filter(Boolean);
  if (clean) all = cleanLeads(all, clean).kept;

  const byKey = new Map();
  const add = (lead) => {
    const keys = [lead.post_id, lead.url, titleKey(lead)].filter(Boolean);
    const hit = keys.find((k) => byKey.has(k));
    if (hit) {
      const prev = byKey.get(hit);
      if (Date.parse(lead.created_at) > Date.parse(prev.created_at)) {
        for (const k of keys) byKey.set(k, lead);
      }
      return;
    }
    for (const k of keys) byKey.set(k, lead);
  };
  for (const l of all) add(l);

  const unique = [...new Set(byKey.values())];
  unique.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return unique.slice(0, maxLeads);
}
