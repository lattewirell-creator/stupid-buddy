/* The Stupid Buddy: talking to the AI. Today that's Ollama on this Mac (free, nothing leaves the computer).
 * chat() sends a conversation (and the tools a helper may use) and returns the AI's next message. */
'use strict';
const AI = (() => {
  const BASE = 'http://localhost:11434';
  const DEFAULT_MODEL = 'qwen3-vl:8b-instruct';
  let controller = null;
  /** Where the brain runs: 'ollama' (this Mac) or an online service with a free key. */
  const PROVIDERS = {
    ollama: { name: 'This Mac (Ollama)', free: 'Free, private, nothing leaves your Mac' },
    gemini: { name: 'Google Gemini', free: 'Free key, generous daily amount', keyUrl: 'https://aistudio.google.com/apikey', model: 'gemini-2.5-flash' },
    groq: { name: 'Groq', free: 'Free key, very fast', keyUrl: 'https://console.groq.com/keys', model: 'llama-3.3-70b-versatile' },
    openrouter: { name: 'OpenRouter', free: 'Free key, pick a model marked “free”', keyUrl: 'https://openrouter.ai/keys', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  };
  const onPhone = window.__platform === 'android';
  if (onPhone) delete PROVIDERS.ollama;   // no Ollama on a phone: an online AI with a free key
  const provider = () => { const p = localStorage.getItem('provider'); return PROVIDERS[p] ? p : onPhone ? 'groq' : 'ollama'; };

  async function status() {
    const p = provider();
    if (p !== 'ollama') {
      if (!(await Native.call('keys.has', { provider: p }).catch(() => false))) return { running: false, models: [], needsKey: true, provider: p };
      try {
        const r = await Native.call('ai.request', { provider: p, path: 'models' });
        const d = JSON.parse(r.body || '{}');
        if (r.status === 401 || r.status === 403) return { running: false, models: [], badKey: true, provider: p };
        const models = (d.data || d.models || []).map((m) => ({ name: String(m.id || m.name || '').replace(/^models\//, '') })).filter((m) => m.name);
        return { running: true, models, provider: p };
      } catch { return { running: false, models: [], provider: p }; }
    }
    try {
      const r = await fetch(BASE + '/api/tags', { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      return { running: true, models: (d.models || []).map((m) => ({ name: m.name, size: m.size })), provider: 'ollama' };
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
    if (provider() !== 'ollama') return cloudChat({ model, messages, tools, signal });
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
      return { content: m.content || '', toolCalls: (m.tool_calls || []).map((c, i) => ({ id: c.id || 'call_' + i, name: c.function && c.function.name, args: parseArgs(c.function && c.function.arguments) })) };
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
  /** The same step through an online service (OpenAI format), sent by the Mac side with your key. */
  async function cloudChat({ model, messages, tools, signal }) {
    const p = provider();
    const toOpenAI = messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id || m.tool_name, content: String(m.content) };
      if (m.role === 'assistant' && m.tool_calls) return { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls.map((c, i) => ({ id: c.id || 'call_' + i, type: 'function', function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments || {}) } })) };
      return { role: m.role, content: m.content };
    });
    const body = { model: model || PROVIDERS[p].model, messages: toOpenAI, temperature: 0.3, max_tokens: tools ? 1200 : 1600 };
    if (tools) body.tools = tools;
    let stopped = false; const onAbort = () => { stopped = true; }; if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let r;
    try { r = await Native.call('ai.request', { provider: p, path: 'chat/completions', body: JSON.stringify(body) }); }
    catch (e) { throw new Error(e.message === 'nokey' ? 'nokey' : 'offline'); }
    if (stopped) throw new Error('stopped');
    if (r.status === 401 || r.status === 403) throw new Error('badkey');
    if (r.status === 429) throw new Error('ratelimit');
    if (r.status === 404) throw new Error('nomodel');
    let d; try { d = JSON.parse(r.body); } catch { throw new Error('AI error: ' + String(r.body).slice(0, 160)); }
    if (r.status >= 400) throw new Error('AI error: ' + ((d.error && (d.error.message || d.error)) || r.status));
    const m = (d.choices && d.choices[0] && d.choices[0].message) || {};
    if (window.__debugAI) window.__debugAI({ content: m.content, tool_calls: (m.tool_calls || []).map((c) => ({ function: { name: c.function.name, arguments: c.function.arguments } })) });
    return { content: m.content || '', toolCalls: (m.tool_calls || []).map((c) => ({ id: c.id, name: c.function && c.function.name, args: parseArgs(c.function && c.function.arguments) })) };
  }
  function parseArgs(a) {
    if (!a) return {};
    if (typeof a === 'object') return a;
    try { return JSON.parse(a); } catch { return {}; }
  }
  return { status, chat, stop, DEFAULT_MODEL, PROVIDERS, provider };
})();
