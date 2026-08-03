# Scout Gemini

A Gemini-powered lead scout for the **Scout iOS app**.

Scout fetches `leads.json` from several agent repos and merges them by
`post_id`. This repo is the **Gemini agent**: it discovers fresh "someone is
looking to hire / commission an artist" posts using **Gemini + Google Search
grounding**, normalizes them into the shared lead schema, and writes
`leads.json` — served to the app at:

```
https://raw.githubusercontent.com/Jack0fcodes/Scout_Gemini/main/leads.json
```

It runs alongside the existing agents (`Scout_Grok`, `redd0tBot`), which the
app fetches concurrently and dedupes.

## Lead schema

Each entry in `leads.json` matches the other agents exactly:

```json
{
  "post_id": "Twitter/X-2083751751232983462",
  "platform": "Twitter/X",
  "source": "@handle",
  "author": "Display Name",
  "title": "Looking for a concept artist",
  "content": "…the post text…",
  "url": "https://x.com/handle/status/…",
  "quality": "High Quality",
  "budget": "$200",
  "created_at": "2026-08-02T03:08:26Z"
}
```

`quality` is `High Quality | Medium | Low`. `post_id` is taken from the source
when available, otherwise derived as `<platform>-<hash>` so dedupe stays stable.

## How it works

1. The agent reads the instruction in **`prompt.txt`** — the single source of
   truth for what to search and how to shape output. Edit that file to change
   behavior; no code changes needed.
2. It sends the prompt to Gemini with **Google Search grounding** (`google_search`
   tool) — its analog to Grok's live X search — and Gemini returns a bare JSON
   array of leads. The prompt targets the **open web** (Kickstarter, itch.io,
   Bandcamp, Tumblr, ArtStation, Craigslist, TCG/TTRPG/VTuber forums, …) and
   **excludes X, Reddit, and Meta apps**, which the other agents cover.
3. Leads are filtered (drop excluded platforms + unparseable URLs), normalized
   to the schema, then **merged into `leads.json`**: deduped by `post_id`/`url`,
   newest kept on conflict, sorted newest-first, capped at `maxLeadsInFile`.

> Note: grounding surfaces real web results, but an LLM can still misattribute a
> link. `prompt.txt` forbids invented URLs and the platform filter drops
> anything another agent owns; tune the prompt and `quality` handling to taste.

## Run it

```bash
npm install
cp .env.example .env        # add your free key from https://aistudio.google.com/app/apikey
npm run dry-run             # discover + print, don't write the file
npm start                  # discover, merge, write leads.json
```

## Automated refresh (GitHub Actions)

`.github/workflows/scout.yml` runs every 6 hours (and on manual dispatch),
then commits `leads.json` if it changed — so the app's raw URL stays fresh.

**One-time setup:** add your key as a repo secret named `GEMINI_API_KEY`
(Settings → Secrets and variables → Actions → New repository secret). The
workflow already has `contents: write` permission to push the update.

## Configuration (`config.json`)

| Field              | Default            | Meaning                                       |
| ------------------ | ------------------ | --------------------------------------------- |
| `model`            | `gemini-3.6-flash` | Any current free-tier, grounding-capable Gemini model. |
| `maxLeadsInFile`   | `150`              | Cap on `leads.json` length.                   |
| `passes`           | `1`                | How many times to run the prompt per refresh. |
| `excludePlatforms` | X/Reddit/Meta hosts | Lead URLs on these hosts are dropped.         |

The search instruction itself lives in **`prompt.txt`**, not here.

## License

MIT
