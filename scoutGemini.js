// Drop-in client for your Scout agent.
//
// Point it at your running proxy (default http://localhost:3000) so the
// Gemini API key never has to live inside the agent. No dependencies — uses
// Node 18+ / browser `fetch`.
//
//   import { ScoutGemini } from "./scoutGemini.js";
//   const gemini = new ScoutGemini({ baseUrl: "http://localhost:3000" });
//   const answer = await gemini.generate("Summarize this lead in one line.");
//   const reply  = await gemini.chat([{ role: "user", content: "hi" }]);

export class ScoutGemini {
  constructor({ baseUrl = "http://localhost:3000", model, system } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.system = system;
  }

  async #post(path, payload) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }

  /** Single prompt in, text out. */
  async generate(prompt, opts = {}) {
    const data = await this.#post("/api/generate", {
      prompt,
      system: opts.system ?? this.system,
      model: opts.model ?? this.model,
      temperature: opts.temperature,
    });
    return data.text;
  }

  /** Multi-turn chat. `messages` is [{ role: "user"|"assistant", content }]. */
  async chat(messages, opts = {}) {
    const data = await this.#post("/api/chat", {
      messages,
      system: opts.system ?? this.system,
      model: opts.model ?? this.model,
      temperature: opts.temperature,
    });
    return data.text;
  }

  /**
   * Streaming chat. Calls onChunk(textDelta) as tokens arrive, resolves with
   * the full concatenated text. Works in Node 18+ and modern browsers.
   */
  async chatStream(messages, onChunk, opts = {}) {
    const res = await fetch(`${this.baseUrl}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        system: opts.system ?? this.system,
        model: opts.model ?? this.model,
        temperature: opts.temperature,
      }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error || `Stream failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return full;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.error) throw new Error(parsed.error);
          if (parsed.text) {
            full += parsed.text;
            onChunk?.(parsed.text);
          }
        } catch {
          // skip non-JSON lines
        }
      }
    }
    return full;
  }
}

export default ScoutGemini;
