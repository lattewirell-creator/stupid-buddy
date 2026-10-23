// Does Buddy hand each request to the right helper? Runs the real lead (ui/ai.js + ui/team.js) against a set of
// typical requests and checks which helpers it picks. Helpers don't run: each one just reports back "done", so
// nothing on the computer is touched.
//
//   node scripts/route-test.mjs                      # Ollama on this computer (qwen3-vl:8b-instruct)
//   node scripts/route-test.mjs --model llama3.1:8b  # another Ollama model
//   GROQ_API_KEY=… node scripts/route-test.mjs --provider groq     (also gemini, openrouter)
//   node scripts/route-test.mjs --platform linux     # the Linux team: System Buddy, no Hands Buddy
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const provider = arg('provider', 'ollama');
const model = arg('model', undefined);
const platform = arg('platform', undefined);
const BASES = { gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/', groq: 'https://api.groq.com/openai/v1/', openrouter: 'https://openrouter.ai/api/v1/' };
const key = process.env[provider.toUpperCase() + '_API_KEY'];
if (provider !== 'ollama' && !key) { console.error(`Set ${provider.toUpperCase()}_API_KEY first.`); process.exit(1); }

// [request, helpers Buddy should use (in any order; [] = just answer)]
const CASES = [
  ['Hi! How are you today?', []],
  ['What is 15% of 240?', []],
  ['Tidy up my Downloads folder', ['files']],
  ['Find the PDF with my rental contract', ['files']],
  ['Write a short, friendly email to my landlord saying the heater in the bedroom is broken', ['writer']],
  ['Summarize this for me in three bullet points: The meeting moved to Thursday at 10. Anna will bring the budget. We need a decision on the new office before Friday.', ['writer']],
  ['What are the opening hours of the Vasa Museum in Stockholm today?', ['web']],
  ['Compare the prices of the iPhone 17 and the Pixel 10', ['web']],
  ['Open Notes and make a note that says buy milk', ['hands']],
  ['Find three good pizza places in Gothenburg and write them into a document on my Desktop', ['web', 'writer']],
  ['Städa min skrivbordsmapp', ['files']],
  ['Skriv ett kort tack-mejl till Lisa för igår', ['writer']],
  ['Vad kostar ett SL-kort för en månad?', ['web']],
];
if (platform === 'linux') {
  CASES.splice(CASES.findIndex(([, w]) => w.includes('hands')), 1);   // no Hands Buddy on Linux
  CASES.push(['Turn the volume down a bit', ['system']], ['Sätt på mörkt läge', ['system']], ['Remind me to call mom in 20 minutes', ['system']], ['Öppna Inställningar för wifi', ['system']]);
}

// A window for the two scripts: the app bridge answers like the real app, minus anything that touches the computer.
const reply = (id, ok, value) => setTimeout(() => ctx.window.__native.reply(id, ok, value), 0);
async function bridge(msg) {
  if (msg.op === 'files.roots') return reply(msg.id, true, ['~/Desktop', '~/Documents', '~/Downloads']);
  if (msg.op === 'keys.has') return reply(msg.id, true, true);
  if (msg.op === 'ai.request') {
    try {
      const r = await fetch(BASES[msg.provider] + msg.path, { method: msg.body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: msg.body });
      return reply(msg.id, true, { status: r.status, body: await r.text() });
    } catch (e) { return reply(msg.id, false, 'offline'); }
  }
  if (msg.op === 'ollama.request') {   // --platform windows/linux: Ollama goes through the app
    try { const r = await fetch('http://localhost:11434/' + msg.path, { method: msg.body ? 'POST' : 'GET', body: msg.body }); return reply(msg.id, true, { status: r.status, body: await r.text() }); }
    catch (e) { return reply(msg.id, false, 'offline'); }
  }
  reply(msg.id, false, 'not in the test');
}
const store = new Map([['provider', provider]]);
const ctx = vm.createContext({
  console, fetch, setTimeout, clearTimeout, AbortController, AbortSignal, TextDecoder, URL,
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
});
ctx.window = ctx;
ctx.__platform = platform;
ctx.window.webkit = { messageHandlers: { buddy: { postMessage: (m) => { bridge(m); } } } };
for (const f of ['ui/ai.js', 'ui/team.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
// The helpers only say they're done; the test is about who gets the work.
vm.runInContext('runHelper = async (key, task) => "Done (" + key + "): " + task.slice(0, 60);', ctx);

const models = { lead: model || (provider === 'ollama' ? vm.runInContext('AI.DEFAULT_MODEL', ctx) : undefined) };
console.log(`Routing test: ${provider}${models.lead ? ' / ' + models.lead : ''}\n`);
let pass = 0;
for (const [text, want] of CASES) {
  const got = [];
  const ui = { job: (k) => { got.push(k); return { step() {}, done() {} }; }, typing() {} };
  const t0 = Date.now();
  let error = '';
  try { vm.runInContext('Team.reset()', ctx); await vm.runInContext('Team', ctx).ask(text, ui, { models, signal: new AbortController().signal }); }
  catch (e) { error = e.message; }
  const ok = !error && [...new Set(got)].sort().join() === [...want].sort().join();
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${text.slice(0, 70)}\n      wanted ${want.join(' + ') || 'just an answer'}, got ${got.join(' + ') || 'just an answer'}${error ? ' (error: ' + error + ')' : ''}  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
console.log(`\n${pass} of ${CASES.length} routed right.`);
process.exit(pass === CASES.length ? 0 : 1);
