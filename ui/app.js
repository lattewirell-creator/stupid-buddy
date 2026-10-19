/* The Stupid Buddy: the window. Closed it's just Buddy's ball (drag it anywhere, click to open); open it's the
 * conversation, with a card for each helper while the team works. */
'use strict';
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const ballEl = (color) => { const b = el('span', 'ball'); b.append(el('i'), el('i')); if (color) b.style.setProperty('--c', color); return b; };

let models = Object.assign({ lead: AI.DEFAULT_MODEL, files: AI.DEFAULT_MODEL, writer: AI.DEFAULT_MODEL, web: AI.DEFAULT_MODEL, hands: AI.DEFAULT_MODEL }, JSON.parse(localStorage.getItem('models') || '{}'));
let busy = null, ready = false;
const onPhone = window.__platform === 'android';
if (onPhone) delete models.hands;
if (onPhone) { document.body.classList.remove('closed'); for (const k of Object.keys(models)) if (/qwen|llama3|:8b/.test(models[k]) && !/70b|versatile/.test(models[k])) models[k] = AI.PROVIDERS[AI.provider()].model; }

/* ---------------- open / close, and dragging the ball ---------------- */
function open() { document.body.classList.remove('closed'); Native.call('window', { mode: 'open' }); setTimeout(() => $('input').focus(), 120); }
function close() { if (onPhone) return; document.body.classList.add('closed'); Native.call('window', { mode: 'ball' }); }
{
  // Drag the ball anywhere; fling it and it flies, bounces off the screen edges and lands (Physics.swift).
  const ball = $('ball'); let start = null, moved = false, samples = [];
  ball.addEventListener('pointerdown', (e) => { start = { x: e.screenX, y: e.screenY }; moved = false; samples = [{ t: performance.now(), x: e.screenX, y: e.screenY }]; ball.setPointerCapture(e.pointerId); ball.classList.add('held'); });
  ball.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.screenX - start.x, dy = e.screenY - start.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true; start = { x: e.screenX, y: e.screenY };
    const now = performance.now(); samples.push({ t: now, x: e.screenX, y: e.screenY }); while (samples.length > 2 && now - samples[0].t > 90) samples.shift();
    Native.call('drag', { dx, dy });
  });
  ball.addEventListener('pointerup', () => {
    ball.classList.remove('held');
    if (!start) return; start = null;
    if (!moved) { open(); return; }
    const a = samples[0], b = samples[samples.length - 1], dt = Math.max(16, b.t - a.t) / 1000;
    Native.call('release', { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt });
  });
  // Rolling: spin by how far it travels; squash on hard bumps.
  let angle = 0, squashT;
  Native.on('roll', (r) => {
    angle += (r.vx / 60) / 36 * (180 / Math.PI);
    ball.style.rotate = angle.toFixed(1) + 'deg';
    if (r.hit > 650) { ball.classList.remove('squash'); void ball.offsetWidth; ball.classList.add('squash'); clearTimeout(squashT); squashT = setTimeout(() => ball.classList.remove('squash'), 260); face(r.hit > 1800 ? 'blink' : ''); }
  });
  Native.on('landed', () => { face('happy'); setTimeout(() => face(''), 900); });
}
$('closeBtn').addEventListener('click', close);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.body.classList.contains('closed')) { if (busy) stop(); else close(); } });

/* ---------------- on the phone: throw Buddy around the screen ---------------- */
// Grab the ball in the header and fling it: it flies, bounces off the edges and lands above the box you type in.
if (onPhone) {
  const head = $('headBall');
  head.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = head.getBoundingClientRect(), size = 72;
    const b = ballEl(); b.classList.add('float-ball'); Look.dress(b); document.body.appendChild(b);
    let x = r.left + r.width / 2 - size / 2, y = r.top + r.height / 2 - size / 2, vx = 0, vy = 0, angle = 0, samples = [], held = true, raf = 0, last = 0;
    const place = () => { b.style.transform = `translate(${x}px, ${y}px) rotate(${angle}deg)`; };
    const floor = () => $('ask').getBoundingClientRect().top - size - 6;
    place(); head.style.visibility = 'hidden';
    const move = (ev) => { x = ev.clientX - size / 2; y = ev.clientY - size / 2; samples.push({ t: performance.now(), x: ev.clientX, y: ev.clientY }); while (samples.length > 2 && performance.now() - samples[0].t > 90) samples.shift(); place(); };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); held = false;
      const a = samples[0], z = samples[samples.length - 1];
      if (a && z && z.t > a.t) { vx = (z.x - a.x) / ((z.t - a.t) / 1000); vy = (z.y - a.y) / ((z.t - a.t) / 1000); }
      last = performance.now(); raf = requestAnimationFrame(tick);
    };
    const tick = (now) => {
      const dt = Math.min(1 / 30, (now - last) / 1000); last = now;
      vy += 2600 * dt; vx *= 0.995; x += vx * dt; y += vy * dt;
      const W = innerWidth - size, F = floor(); let hit = 0, onFloor = false;
      if (x < 0) { x = 0; hit = Math.abs(vx); vx = -vx * 0.52; } if (x > W) { x = W; hit = Math.abs(vx); vx = -vx * 0.52; }
      if (y < 0) { y = 0; hit = Math.max(hit, Math.abs(vy)); vy = -vy * 0.52; }
      if (y >= F) { y = F; if (vy > 0) { hit = Math.max(hit, Math.abs(vy)); vy = -vy * 0.52; } if (Math.abs(vy) < 120) { vy = 0; onFloor = true; vx *= 0.82; } }
      angle += (vx / 60) / (size / 2) * (180 / Math.PI); place();
      if (hit > 650) { b.classList.remove('squash'); void b.offsetWidth; b.classList.add('squash'); }
      if (onFloor && Math.abs(vx) < 15) { b.classList.add('happy'); setTimeout(() => b.classList.remove('happy'), 900); return; }
      raf = requestAnimationFrame(tick);
    };
    // Tap the ball when it's resting to put Buddy back in the header.
    b.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); if (held) return; cancelAnimationFrame(raf); held = true; samples = []; vx = vy = 0; addEventListener('pointermove', move); addEventListener('pointerup', (u) => { if (samples.length < 2) { b.remove(); head.style.visibility = ''; removeEventListener('pointermove', move); } else up(u); }, { once: true }); });
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
}

/* ---------------- Buddy's face ---------------- */
const faces = [$('ball'), $('headBall')];
Look.apply();   // your Buddy's name, colour, eyes, mouth and hat (look.js)
const face = (state) => faces.forEach((f) => { f.className = f.className.replace(/\b(blink|happy|sleepy|think|work)\b/g, '').trim(); if (state) f.classList.add(...state.split(' ')); });
setInterval(() => { if (!busy && ready) { face('blink'); setTimeout(() => face(''), 140); } }, 4200);
function status(t) { $('status').textContent = t; }

/* ---------------- the conversation ---------------- */
const log = $('log');
function md(text) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = []; let list = null;
  for (const line of String(text).split('\n')) {
    const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (m) { if (!list) { list = /^\s*\d/.test(line) ? 'ol' : 'ul'; out.push(`<${list}>`); } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if (list) { out.push(`</${list}>`); list = null; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}
const scroll = () => { log.scrollTop = log.scrollHeight; };
function say(who, text) { const b = el('div', 'msg ' + who); if (who === 'bot') b.innerHTML = md(text); else b.textContent = text; log.appendChild(b); scroll(); return b; }
function note(text, action) { const n = el('div', 'note', text); if (action) { const b = el('button', null, action.label); b.addEventListener('click', action.fn); n.appendChild(b); } log.appendChild(n); scroll(); }

function greet() {
  log.replaceChildren();
  const L = Look.get();
  say('bot', `Hi${L.call ? ' ' + L.call : ''}! I’m **${L.name}**, and I’ve got a little team:\n- **File Buddy** finds, reads and tidies your files\n- **Writer Buddy** writes emails, notes and documents\n- **Web Buddy** looks things up for you` +
    (HELPERS.hands ? '\n- **Hands Buddy** uses your other apps (it asks first, and Esc stops it)' : '') + `\nTell me what you need. I’ll always ask before moving or deleting anything.`);
  chips(['Tidy my Downloads folder', 'What’s in my Documents?', onPhone ? 'Find the best free note apps for Android' : `Find the best free note apps for ${window.__platform === 'windows' ? 'Windows' : 'Mac'}`, 'Write a short thank-you email']);
}
function chips(list) {
  const box = $('chips'); box.replaceChildren();
  for (const t of list) { const c = el('button', 'chip', t); c.addEventListener('click', () => ask(t)); box.appendChild(c); }
}

/** The team's work for one request: a card per helper task, with its steps. */
function workArea() {
  const area = el('div', 'work'); log.appendChild(area);
  return {
    job(key, task) {
      const h = HELPERS[key];
      const card = el('div', 'job'), body = el('div', 'body'), steps = el('div', 'steps');
      const b = ballEl(h.color); b.classList.add('work');
      body.append(el('div', 'title', h.name), el('div', 'task', task.length > 140 ? task.slice(0, 140) + '…' : task), steps);
      card.append(b, body); area.appendChild(card); scroll();
      status(`${h.name} is working…`);
      return {
        step(text, err) { const s = el('div', 'step' + (err ? ' err' : ''), (err ? '⚠︎ ' : '· ') + text); steps.appendChild(s); while (steps.children.length > 6) steps.firstChild.remove(); scroll(); },
        done() { card.classList.add('done'); b.classList.remove('work'); status('Thinking…'); },
      };
    },
  };
}

const ERRORS = { offline: 'I can’t reach my brain. Is Ollama running (or the internet on)? Then try again.', nomodel: 'That AI model isn’t available. Pick another in Settings.',
  nokey: 'Add your free key in Settings first.', badkey: 'That key didn’t work. Check it in Settings.', ratelimit: 'The free daily amount is used up for now. Try again later, or switch to This ' + DEVICE + ' in Settings.' };
async function ask(text) {
  text = String(text ?? $('input').value).trim();
  if (!text || busy) return;
  $('input').value = ''; grow(); $('chips').replaceChildren();
  say('me', text);
  const controller = new AbortController(); busy = controller;
  document.body.classList.add('busy'); face('think'); status('Thinking…'); sendButton(true);
  const area = workArea();
  const thinking = say('bot', ''); thinking.classList.add('typing');
  try {
    const answer = await Team.ask(text, area, { models, name: Look.name(), persona: Look.persona(), signal: controller.signal });
    thinking.classList.remove('typing'); thinking.innerHTML = md(answer);
    face('happy'); setTimeout(() => face(''), 1600);
  } catch (e) {
    thinking.remove();
    if (e.message === 'stopped') note('Stopped.');
    else note(ERRORS[e.message] || 'Something went wrong: ' + e.message, ['nomodel', 'offline', 'nokey', 'badkey', 'ratelimit'].includes(e.message) ? { label: 'Settings', fn: showSettings } : null);
    face('');
  } finally {
    busy = null; document.body.classList.remove('busy'); sendButton(false); refreshStatus();
    if (document.body.classList.contains('closed')) { /* the ball's dot stops pulsing */ }
    scroll();
  }
}
function stop() { if (busy) { busy.abort(); AI.stop(); } }
Native.on('hands:stopped', stop);   // you pressed Esc while Hands Buddy was working
function sendButton(stopping) {
  const b = $('send'); b.classList.toggle('stop', stopping); b.setAttribute('aria-label', stopping ? 'Stop' : 'Send');
  b.innerHTML = stopping ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M5 12h13M12.5 6l6 6-6 6"/></svg>';
}
const grow = () => { const i = $('input'); i.style.height = 'auto'; i.style.height = Math.min(140, i.scrollHeight) + 'px'; };
$('input').addEventListener('input', grow);
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
$('ask').addEventListener('submit', (e) => { e.preventDefault(); if (busy) stop(); else ask(); });
$('newBtn').addEventListener('click', () => { if (busy) stop(); Team.reset(); greet(); });

/* ---------------- settings ---------------- */
function renderProviders() {
  const box = $('providers'); box.replaceChildren();
  const cur = AI.provider();
  for (const [key, p] of Object.entries(AI.PROVIDERS)) {
    const b = el('button', 'prov' + (key === cur ? ' on' : '')); b.appendChild(el('span', 'dot'));
    const t = el('div'); t.append(el('div', null, p.name), el('small', null, p.free)); b.appendChild(t);
    b.addEventListener('click', () => {
      if (key === AI.provider()) return;
      localStorage.setItem('provider', key);
      const m = key === 'ollama' ? AI.DEFAULT_MODEL : p.model;
      for (const k of Object.keys(models)) models[k] = m;
      localStorage.setItem('models', JSON.stringify(models));
      showSettings(); refreshStatus();
    });
    box.appendChild(b);
  }
  const p = AI.PROVIDERS[cur];
  $('keyBox').classList.toggle('hidden', cur === 'ollama');
  $('keyGet').onclick = () => p.keyUrl && Native.call('web.open', { url: p.keyUrl });
}
$('keySave').addEventListener('click', async () => {
  const key = $('keyInput').value.trim(); $('keyInput').value = '';
  try { await Native.call('keys.set', { provider: AI.provider(), key }); } catch (e) { $('ollamaState').textContent = e.message; return; }
  showSettings(); refreshStatus();
});
async function showSettings() {
  Look.render($('lookBox'));
  $('settings').classList.remove('hidden'); $('log').classList.add('hidden'); $('ask').classList.add('hidden'); $('chips').classList.add('hidden');
  renderProviders();
  const s = await AI.status();
  const pName = AI.PROVIDERS[AI.provider()].name;
  $('ollamaState').textContent = s.provider !== 'ollama'
    ? (s.needsKey ? `Get a free key from ${pName} and paste it above. It’s kept ${DEVICE === 'Mac' ? 'in your Mac’s Keychain' : 'safely on this ' + DEVICE}.` : s.badKey ? 'That key didn’t work. Paste a new one above.' : s.running ? `Connected to ${pName}. Your requests go to ${pName} over the internet.` : `Can’t reach ${pName} right now.`)
    : s.running ? (s.models.length ? `Ollama is running with ${s.models.length} model${s.models.length === 1 ? '' : 's'}. Everything stays on this ${DEVICE}.` : 'Ollama is running, but no AI model is downloaded yet. In a terminal: ollama pull ' + AI.DEFAULT_MODEL)
    : 'Ollama isn’t running. Install it from ollama.com (free), open it, then come back.';
  const names = s.models.map((m) => m.name);
  // An online service's list changes over time: if a chosen model isn't offered any more, take a good one.
  if (s.provider !== 'ollama' && s.running && names.length) {
    const prefer = [/gpt-oss-120b/, /llama-3\.3-70b/, /70b/, /gemini-2\.5-flash$/, /flash/, /:free$/, /./];
    const best = prefer.map((re) => names.find((n) => re.test(n) && !/whisper|tts|guard|embed|vision-preview/i.test(n))).find(Boolean) || names[0];
    let changed = false;
    for (const k of Object.keys(models)) if (!names.includes(models[k])) { models[k] = best; changed = true; }
    if (changed) { localStorage.setItem('models', JSON.stringify(models)); refreshStatus(); }
  }
  const box = $('models'); box.replaceChildren();
  for (const [key, label, color] of [['lead', 'Buddy (the lead)', null], ...Object.entries(HELPERS).map(([k, h]) => [k, h.name, h.color])]) {
    const row = el('div', 'row'); row.appendChild(ballEl(color));
    const g = el('div', 'grow'); g.append(el('div', null, label)); row.appendChild(g);
    const sel = el('select'); for (const n of new Set([...names, models[key]])) { const o = el('option', null, n); o.value = n; if (n === models[key]) o.selected = true; sel.appendChild(o); }
    sel.addEventListener('change', () => { models[key] = sel.value; localStorage.setItem('models', JSON.stringify(models)); });
    row.appendChild(sel); box.appendChild(row);
  }
  renderRoots(await Native.call('files.roots').catch(() => []));
  const team = $('teamList'); team.replaceChildren();
  for (const h of Object.values(HELPERS)) { const r = el('div', 'row'); r.appendChild(ballEl(h.color)); const g = el('div', 'grow'); g.append(el('div', null, h.name), el('small', null, 'Can: ' + h.job)); r.appendChild(g); team.appendChild(r); }
}
function renderRoots(list) { $('roots').textContent = list.join(' · '); }
// Windows: Buddy updates itself (windows/src/update.rs); here you can also check by hand.
if (window.__platform === 'windows') {
  const btn = $('updateBtn'), note = $('updateNote');
  btn.classList.remove('hidden');
  Native.call('update.version').then((v) => { btn.textContent = `Check for updates (you have ${v})`; }).catch(() => {});
  btn.addEventListener('click', async () => {
    btn.disabled = true; note.classList.remove('hidden'); note.textContent = 'Checking…';
    try { note.textContent = (await Native.call('update.check')) || 'You have the newest Buddy.'; } catch (e) { note.textContent = e.message; }
    btn.disabled = false;
  });
}
$('addRoot').addEventListener('click', async () => renderRoots(await Native.call('files.addRoot').catch(() => [])));
function hideSettings() { $('settings').classList.add('hidden'); $('log').classList.remove('hidden'); $('ask').classList.remove('hidden'); $('chips').classList.remove('hidden'); }
$('setBtn').addEventListener('click', () => ($('settings').classList.contains('hidden') ? showSettings() : hideSettings()));
$('setDone').addEventListener('click', hideSettings);
$('quitBtn').addEventListener('click', () => Native.call('quit'));

/* ---------------- start ---------------- */
async function refreshStatus() {
  const s = await AI.status();
  if (s.provider !== 'ollama') {
    ready = s.running;
    const n = AI.PROVIDERS[s.provider].name;
    if (s.needsKey) { status(`Needs a free ${n} key (Settings)`); face('sleepy'); }
    else if (s.badKey) { status(`${n} key didn’t work (Settings)`); face('sleepy'); }
    else if (!s.running) { status(`Can’t reach ${n}`); face('sleepy'); }
    else { status(`Ready · ${models.lead} on ${n}`); if (!busy) face(''); }
    return;
  }
  ready = s.running && s.models.some((m) => m.name === models.lead);
  if (!s.running) { status('Asleep: Ollama isn’t running'); face('sleepy'); }
  else if (!ready) { status('Waiting for my AI model…'); face('sleepy'); }
  else { status(`Ready · ${models.lead} on this ${DEVICE}`); if (!busy) face(''); }
}
greet();
refreshStatus();
// Dev self-test (see main.swift): ask, print what the team does, quit.
window.__test = async (q, provider) => {
  const log = (t) => Native.call('log', { text: t });
  // STUPID_BUDDY_PROVIDER=local: the online (OpenAI-format) path, through Ollama's own OpenAI-style door.
  if (provider === 'local') { AI.PROVIDERS.local = { name: 'Local test', model: AI.DEFAULT_MODEL }; localStorage.setItem('provider', 'local'); }
  else localStorage.setItem('provider', 'ollama');
  window.__debugAI = (m) => log('   AI: ' + JSON.stringify({ calls: (m.tool_calls || []).map((c) => c.function && c.function.name + ' ' + JSON.stringify(c.function.arguments)), text: String(m.content || '').slice(0, 160) }));
  const t0 = Date.now();
  const area = { job(key, task) { log(`→ ${HELPERS[key].name}: ${task}`); return { step: (s, err) => log(`   ${err ? '⚠︎' : '·'} ${s}`), done: () => log(`   ✓ ${HELPERS[key].name} done`) }; } };
  try { const a = await Team.ask(q, area, { models, name: Look.name(), persona: Look.persona(), signal: new AbortController().signal }); log('ANSWER (' + Math.round((Date.now() - t0) / 1000) + 's): ' + a.replace(/\n+/g, ' ⏎ ')); }
  catch (e) { log('ERROR: ' + e.message); }
  Native.call('quit');
};
setInterval(() => { if (!busy) refreshStatus(); }, 15000);
