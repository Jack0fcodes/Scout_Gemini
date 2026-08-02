# Scout Gemini API

A thin proxy over Google's **free-tier Gemini API** for the Scout app agent.

Your Google AI Studio key stays on the server — the Scout agent (and the demo
web page) call clean JSON endpoints instead of talking to Google directly, so
the key is never shipped to the client.

## Why a proxy?

Calling Gemini straight from browser/client code exposes your API key to
anyone who opens dev tools. This proxy holds the key, exposes `/api/chat` and
`/api/generate`, and gives you one place to add rate limiting, logging, or
model switching later.

## Quick start

```bash
# 1. Install deps
npm install

# 2. Add your free key
cp .env.example .env
#   then edit .env and paste your key from
#   https://aistudio.google.com/app/apikey

# 3. Run it
npm start
```

Open <http://localhost:3000> for the demo chat UI, or point your Scout agent at
the endpoints below.

## Endpoints

| Method | Path                | Body                                                        |
| ------ | ------------------- | ----------------------------------------------------------- |
| GET    | `/health`           | –                                                           |
| POST   | `/api/generate`     | `{ prompt, system?, model?, temperature? }`                 |
| POST   | `/api/chat`         | `{ messages: [{role,content}], system?, model?, temperature? }` |
| POST   | `/api/chat/stream`  | same as `/api/chat`, streams text as SSE                    |

`role` is `"user"` or `"assistant"`. A `system` string sets the system
instruction.

### curl example

```bash
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Give me a one-line summary of this lead."}'
```

## Using it from the Scout agent

```js
import { ScoutGemini } from "./scoutGemini.js";

const gemini = new ScoutGemini({
  baseUrl: "http://localhost:3000",
  system: "You are Scout, a concise research assistant.",
});

// Single shot
const summary = await gemini.generate("Summarize: ...");

// Multi-turn
const reply = await gemini.chat([
  { role: "user", content: "Find me B2B SaaS leads in fintech." },
]);

// Streaming
await gemini.chatStream(
  [{ role: "user", content: "Draft an outreach email." }],
  (delta) => process.stdout.write(delta)
);
```

## Configuration

| Variable         | Default            | Notes                                             |
| ---------------- | ------------------ | ------------------------------------------------- |
| `GEMINI_API_KEY` | –                  | **Required.** Free key from Google AI Studio.     |
| `GEMINI_MODEL`   | `gemini-2.0-flash` | Any Gemini model on the free tier.                |
| `PORT`           | `3000`             | Server port.                                      |

Free-tier models worth using: `gemini-2.0-flash` (fast, default),
`gemini-2.5-flash`, `gemini-1.5-flash`. The free tier has generous per-minute
and per-day request limits — see Google's docs for current numbers.

## Deploying

It's a standard Node 18+ Express app, so it runs anywhere that runs Node
(Render, Railway, Fly.io, a VPS) or as a serverless function with light
adaptation. Set `GEMINI_API_KEY` as an environment variable in your host —
never commit `.env`.

## License

MIT
