/* The Stupid Buddy: talking to the AI. Today that's Ollama on this Mac (free, nothing leaves the computer).
 * chat() sends a conversation (and the tools a helper may use) and returns the AI's next message. */
'use strict';
const AI = (() => {
  const BASE = 'http://localhost:11434';
  const DEFAULT_MODEL = 'qwen3-vl:8b-instruct';
  let controller = null;

  async function status() {
    try {
      const r = await fetch(BASE + '/api/tags', { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return { running: true, models: (d.models || []).map((m) => ({ name: m.name, size: m.size })) };
    } catch { return { running: false, models: [] }; }
  }
  /** Stops whatever the team is waiting for. */
  function stop() { if (controller) controller.abort(); }

  /**
   * One step of a conversation. messages: [{ role, content, images?, tool_calls?, tool_name? }].
   * tools: Ollama/OpenAI-style function list. Returns { content, toolCalls: [{ name, args }] }.
   * onText(text) streams the reply as it's written (only when no tools are offered).
   */
  async function chat({ model, messages, tools, onText, signal }) {
    controller = new AbortController();
    const abort = () => controller.abort();
    if (signal) signal.addEventListener('abort', abort, { once: true });
    const stream = !tools && !!onText;
    const body = { model: model || DEFAULT_MODEL, messages, stream, think: false, keep_alive: '10m', options: { temperature: 0.3, num_ctx: 16384, num_predict: tools ? 1200 : 1600 } };   // a step never rambles on for minutes
    if (tools) body.tools = tools;
    let res;
    try { res = await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal }); }
    catch (e) { if (controller.signal.aborted) throw new Error('stopped'); throw new Error('offline'); }
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(/not found/i.test(t) ? 'nomodel' : 'AI error: ' + t.slice(0, 160)); }
    if (!stream) {
      const d = await res.json();
      const m = d.message || {};
      if (window.__debugAI) window.__debugAI(m);
      return { content: m.content || '', toolCalls: (m.tool_calls || []).map((c) => ({ name: c.function && c.function.name, args: parseArgs(c.function && c.function.arguments) })) };
    }
    // Streaming: one JSON object per line.
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', text = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          const piece = (o.message && o.message.content) || '';
          if (piece) { text += piece; onText(text); }
        }
      }
    } catch (e) { if (controller.signal.aborted) throw new Error('stopped'); throw e; }
    return { content: text, toolCalls: [] };
  }
  function parseArgs(a) {
    if (!a) return {};
    if (typeof a === 'object') return a;
    try { return JSON.parse(a); } catch { return {}; }
  }
  return { status, chat, stop, DEFAULT_MODEL };
})();
