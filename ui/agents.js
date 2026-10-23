/* The Stupid Buddy: your own agents. Each one is a Buddy with a name, a job and something to do (now, every hour, or
 * every day at a time). It runs in the background on this computer through the same team (team.js), with its own
 * conversation, and leaves what it did in a list. You come first: when you ask Buddy something, a running agent
 * steps aside and tries again a little later. Skills are tasks you've shown Buddy once (Teach, windows/src/teach.rs):
 * the AI turns the recording into steps, and an agent can follow them. Everything is kept in this app (localStorage). */
'use strict';
const Agents = (() => {
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
  let agents = load('agents', []), skills = load('skills', []), runs = load('runs', []);
  const save = () => {
    runs = runs.slice(-60);
    try { localStorage.setItem('agents', JSON.stringify(agents)); localStorage.setItem('skills', JSON.stringify(skills)); localStorage.setItem('runs', JSON.stringify(runs)); } catch {}
  };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const COLORS = ['#D97757', '#6F9161', '#5B87B5', '#9A6390', '#C8606F', '#E9A23B', '#3FB98A', '#8B5E45'];
  const WHEN = { off: 'Only when I tap Run', hourly: 'Every hour', daily: 'Every day at', weekdays: 'Weekdays at' };
  const canTeach = window.__platform === 'windows';

  /* ---------------- when it runs ---------------- */
  function nextRun(a, from = Date.now()) {
    if (!a.on || a.when === 'off') return null;
    if (a.when === 'hourly') return from + 3600e3;
    const [h, m] = String(a.time || '08:00').split(':').map(Number);
    const d = new Date(from); d.setSeconds(0, 0); d.setHours(h || 0, m || 0);
    for (let i = 0; i < 8; i++) {
      const day = d.getDay();
      if (d.getTime() > from && (a.when === 'daily' || (day > 0 && day < 6))) return d.getTime();
      d.setDate(d.getDate() + 1); d.setHours(h || 0, m || 0);
    }
    return null;
  }
  const whenText = (a) => (a.when === 'daily' || a.when === 'weekdays' ? `${WHEN[a.when]} ${a.time || '08:00'}` : WHEN[a.when] || WHEN.off);
  const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(t).toLocaleDateString(); };

  /* ---------------- running one ---------------- */
  let running = null;   // { agent id, controller }
  async function run(agent, why) {
    if (running || busy) return false;
    const controller = new AbortController(); running = { id: agent.id, controller };
    document.body.classList.add('agent-busy');
    const skill = skills.find((s) => s.id === agent.skill);
    const text = agent.task + (skill ? `\n\nThis is how I do it myself; follow these steps:\n${skill.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '');
    const rec = { id: uid(), agent: agent.id, at: Date.now(), why, status: 'running', helpers: [], answer: '' };
    runs.push(rec); save(); render();
    const ui = { job(key) { if (HELPERS[key] && !rec.helpers.includes(HELPERS[key].name)) rec.helpers.push(HELPERS[key].name); render(); return { step() {}, done() {} }; } };
    const team = Object.create(Team); team.history = [];   // its own conversation, not yours
    try {
      rec.answer = await team.ask(text, ui, { models, name: agent.name, persona: `You are one of the user's own agents, working on your own while they do other things. Your job: ${agent.job}`, signal: controller.signal });
      rec.status = 'done';
    } catch (e) {
      rec.status = e.message === 'stopped' ? 'stopped' : 'failed';
      rec.answer = e.message === 'stopped' ? 'Stopped.' : (ERRORS[e.message] || 'Something went wrong: ' + e.message);
    } finally {
      running = null; document.body.classList.remove('agent-busy');
      agent.last = Date.now();
      if (rec.status === 'stopped' && why === 'schedule') agent.next = Date.now() + 10 * 60e3;   // you needed Buddy; try again soon
      else agent.next = nextRun(agent);
      rec.unread = rec.status !== 'stopped'; save(); render(); badge();
    }
    return true;
  }
  /** You asked Buddy something: a running agent steps aside (it tries again in 10 minutes). */
  function yield_() { if (running) running.controller.abort(); }
  // The clock: anything due runs, one at a time, whenever Buddy isn't busy with you.
  setInterval(() => {
    if (running || busy) return;
    const due = agents.filter((a) => a.on && a.next && a.next <= Date.now()).sort((a, b) => a.next - b.next)[0];
    if (due) run(due, 'schedule');
  }, 20e3);

  /* ---------------- the view ---------------- */
  const view = () => $('agents');
  let editing = null;   // an agent being made or changed
  let skillEdit = null; // a skill being reviewed

  function show() {
    for (const id of ['log', 'ask', 'chips', 'settings']) $(id).classList.add('hidden');
    view().classList.remove('hidden');
    for (const r of runs) r.unread = false; save(); badge(); render();
  }
  function hide() { view().classList.add('hidden'); for (const id of ['log', 'ask', 'chips']) $(id).classList.remove('hidden'); editing = skillEdit = null; }
  const shown = () => !view().classList.contains('hidden');
  function badge() { document.body.classList.toggle('unread', runs.some((r) => r.unread)); }

  function render() {
    if (!shown()) return;
    const box = view(); box.replaceChildren();
    box.appendChild(el('h2', 'serif', 'Your agents'));
    if (skillEdit) return renderSkill(box);
    if (editing) return renderForm(box);
    box.appendChild(el('p', 'intro', 'Little Buddies with one job each. They work on this ' + DEVICE + ' while you do other things, and leave what they did here.'));
    if (!agents.length) box.appendChild(el('div', 'empty', 'No agents yet. Make one: a name, a job, and when it should run.'));
    for (const a of agents) box.appendChild(card(a));
    const add = el('button', 'primary', '+ New agent'); add.addEventListener('click', () => { editing = { id: null, name: '', job: '', task: '', when: 'daily', time: '08:00', color: COLORS[agents.length % COLORS.length], skill: '', on: true }; render(); });
    box.appendChild(add);
    // Skills
    const g = el('div', 'group'); g.appendChild(el('div', 'label', 'Things you’ve taught Buddy'));
    if (!skills.length) g.appendChild(el('div', 'note left', canTeach ? 'Show Buddy a task once (like filing an invoice or posting a weekly update) and an agent can do it for you after that.' : 'Teaching Buddy by showing it works on Windows for now.'));
    for (const s of skills) {
      const r = el('div', 'row'); const t = el('div', 'grow'); t.append(el('div', null, s.name), el('small', null, `${s.steps.length} steps · learned ${ago(s.at)}`));
      const open = el('button', 'chip', 'Open'); open.addEventListener('click', () => { skillEdit = Object.assign({}, s, { steps: [...s.steps] }); render(); });
      r.append(t, open); g.appendChild(r);
    }
    if (canTeach) { const teach = el('button', 'chip teach', 'Teach Buddy a task…'); teach.addEventListener('click', startTeach); g.appendChild(teach); }
    box.appendChild(g);
    const done = el('button', 'link', 'Back to the chat'); done.addEventListener('click', hide); box.appendChild(done);
  }

  function card(a) {
    const c = el('div', 'agent' + (a.on ? '' : ' off'));
    const head = el('div', 'agent-head'); head.appendChild(ballEl(a.color));
    const t = el('div', 'grow'); t.append(el('div', 'title', a.name), el('small', null, a.job));
    head.appendChild(t); c.appendChild(head);
    const isRunning = running && running.id === a.id;
    const meta = el('div', 'agent-meta', isRunning ? 'Working now…' : `${whenText(a)}${a.on && a.next ? ' · next ' + new Date(a.next).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ''}${a.on ? '' : ' · paused'}`);
    c.appendChild(meta);
    const last = runs.filter((r) => r.agent === a.id).slice(-1)[0];
    if (last) {
      const r = el('div', 'agent-run ' + last.status);
      r.appendChild(el('div', 'agent-run-head', `${last.status === 'running' ? 'Working' : last.status === 'done' ? 'Done' : last.status === 'stopped' ? 'Stopped' : 'Didn’t work'} · ${ago(last.at)}${last.helpers.length ? ' · with ' + last.helpers.join(', ') : ''}`));
      if (last.answer) { const body = el('div', 'agent-answer'); body.innerHTML = md(last.answer); r.appendChild(body); }
      c.appendChild(r);
    }
    const acts = el('div', 'agent-acts');
    const btn = (label, fn, cls = 'chip') => { const b = el('button', cls, label); b.addEventListener('click', fn); acts.appendChild(b); return b; };
    if (isRunning) btn('Stop', () => running && running.controller.abort());
    else { const r = btn('Run now', () => { if (running || busy) note2('Buddy is busy right now. Try again in a moment.'); else run(a, 'now'); }); r.disabled = !!running || !!busy; }
    btn(a.on ? 'Pause' : 'Resume', () => { a.on = !a.on; a.next = nextRun(a); save(); render(); });
    btn('Edit', () => { editing = Object.assign({}, a); render(); });
    c.appendChild(acts);
    return c;
  }
  function note2(text) { const n = el('div', 'note', text); view().prepend(n); setTimeout(() => n.remove(), 3000); }

  function renderForm(box) {
    const a = editing;
    const f = el('form', 'agent-form');
    const field = (label, input) => { const l = el('label', 'field'); l.append(el('span', 'label', label), input); f.appendChild(l); return input; };
    const inp = (v, ph) => { const i = el('input'); i.value = v || ''; i.placeholder = ph; return i; };
    const area = (v, ph) => { const i = el('textarea'); i.rows = 3; i.value = v || ''; i.placeholder = ph; return i; };
    const name = field('Name', inp(a.name, 'Inbox Buddy'));
    const job = field('Its job', inp(a.job, 'Keeps an eye on my Downloads folder'));
    const task = field('What it does each time', area(a.task, 'Tidy my Downloads folder: put images, documents and installers in their own folders.'));
    const whenRow = el('div', 'when'); const when = el('select'); for (const [k, v] of Object.entries(WHEN)) { const o = el('option', null, v); o.value = k; o.selected = a.when === k; when.appendChild(o); }
    const time = el('input'); time.type = 'time'; time.value = a.time || '08:00';
    const syncTime = () => time.classList.toggle('hidden', !['daily', 'weekdays'].includes(when.value)); when.addEventListener('change', syncTime); syncTime();
    whenRow.append(when, time); field('When', whenRow);
    const skill = el('select'); { const o = el('option', null, 'Nothing extra'); o.value = ''; skill.appendChild(o); }
    for (const s of skills) { const o = el('option', null, s.name); o.value = s.id; o.selected = a.skill === s.id; skill.appendChild(o); }
    if (skills.length) field('Follow something you taught it', skill);
    const sw = el('div', 'swatches'); let color = a.color;
    for (const c of COLORS) { const b = el('button', 'swatch' + (c === color ? ' on' : '')); b.type = 'button'; b.style.background = c; b.addEventListener('click', () => { color = c; sw.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b)); }); sw.appendChild(b); }
    field('Colour', sw);
    const err = el('div', 'note left'); f.appendChild(err);
    const save1 = el('button', 'primary', a.id ? 'Save' : 'Make the agent'); save1.type = 'submit'; f.appendChild(save1);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!name.value.trim() || !task.value.trim()) { err.textContent = 'Give it a name and something to do.'; return; }
      const v = { name: name.value.trim().slice(0, 40), job: job.value.trim().slice(0, 160) || task.value.trim().slice(0, 160), task: task.value.trim().slice(0, 2000), when: when.value, time: time.value || '08:00', color, skill: skill.value || '' };
      let target = agents.find((x) => x.id === a.id);
      if (!target) { target = { id: uid(), on: true, last: null }; agents.push(target); }
      Object.assign(target, v); target.next = nextRun(target);
      editing = null; save(); render();
    });
    const row = el('div', 'agent-acts');
    const cancel = el('button', 'chip', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => { editing = null; render(); }); row.appendChild(cancel);
    if (a.id) { const del = el('button', 'chip danger', 'Delete agent'); del.type = 'button'; del.addEventListener('click', () => { agents = agents.filter((x) => x.id !== a.id); runs = runs.filter((r) => r.agent !== a.id); editing = null; save(); render(); }); row.appendChild(del); }
    f.appendChild(row);
    box.appendChild(f);
    name.focus();
  }

  /* ---------------- teaching ---------------- */
  async function startTeach() {
    if (busy || running) { note2('Buddy is busy right now. Try again in a moment.'); return; }
    hide(); close();
    await new Promise((r) => setTimeout(r, 400));
    try { await Native.call('teach.start'); } catch (e) { await open(); show(); note2(e.message); }
  }
  Native.on('teach:done', async (steps) => {
    await open(); show();
    const useful = (steps || []).filter((s) => s.kind === 'click' || s.kind === 'typed');
    if (useful.length < 2) { note2('Buddy didn’t see enough to learn from. Try again, and do the whole task before pressing Esc.'); return; }
    const box = view(); box.replaceChildren(el('h2', 'serif', 'Your agents'));
    const wait = el('div', 'msg bot typing', 'Learning what you did'); box.appendChild(wait);
    document.body.classList.add('agent-busy');
    try { skillEdit = Object.assign({ id: null, at: Date.now() }, await learn(useful)); }
    catch (e) { skillEdit = { id: null, at: Date.now(), name: 'New skill', steps: useful.map(describe) }; }
    finally { document.body.classList.remove('agent-busy'); }
    render();
  });
  const describe = (s) => s.kind === 'click' ? `${s.button === 'right' ? 'Right-click' : 'Click'} ${s.what || 'there'}${s.window ? ' in ' + s.window : ''}` : `Type ${s.password ? 'the password (you type it yourself)' : 'into ' + (s.what || 'the field')}${s.window ? ' in ' + s.window : ''}`;
  /** The AI looks at the recording (the steps and up to 8 screenshots) and writes it down as a reusable skill. */
  async function learn(steps) {
    const withImg = steps.map((s, i) => [s, i]).filter(([s]) => s.image);
    const pick = new Set(withImg.length <= 8 ? withImg.map(([, i]) => i) : Array.from({ length: 8 }, (_, k) => withImg[Math.round(k * (withImg.length - 1) / 7)][1]));
    const lines = steps.map((s, i) => `${i + 1}. ${describe(s)}${pick.has(i) ? ` [screenshot ${[...pick].indexOf(i) + 1}]` : ''}`).join('\n');
    const messages = [
      { role: 'system', content: 'The user showed you how they do a task on their computer, once. Write it down so a helper can do the same task later on its own. Use the screenshots (a red ring marks each click) to understand what each step is for. Keep the steps general enough to work again another day (no one-off details like today\'s date), never include passwords, and merge tiny steps. Reply with JSON only: {"name": "a short name for the task", "steps": ["step 1", "step 2", …]}' },
      { role: 'user', content: `What I did:\n${lines}`, images: [...pick].map((i) => steps[i].image) },
    ];
    const r = await AI.chat({ model: models.hands, messages, signal: new AbortController().signal });
    const m = /\{[\s\S]*\}/.exec(r.content || '');
    const j = m ? JSON.parse(m[0]) : null;
    if (!j || !Array.isArray(j.steps) || !j.steps.length) throw new Error('no skill');
    return { name: String(j.name || 'New skill').slice(0, 60), steps: j.steps.map((s) => String(s).slice(0, 300)).slice(0, 30) };
  }
  function renderSkill(box) {
    const s = skillEdit;
    box.appendChild(el('p', 'intro', s.id ? 'What Buddy learned. Change anything that isn’t quite right.' : 'Here’s what Buddy learned from watching you. Change anything that isn’t quite right, then save it.'));
    const f = el('form', 'agent-form');
    const l1 = el('label', 'field'); const name = el('input'); name.value = s.name; l1.append(el('span', 'label', 'Name'), name); f.appendChild(l1);
    const l2 = el('label', 'field'); const steps = el('textarea'); steps.rows = Math.min(14, s.steps.length + 2); steps.value = s.steps.map((x, i) => `${i + 1}. ${x}`).join('\n'); l2.append(el('span', 'label', 'Steps (one per line)'), steps); f.appendChild(l2);
    const ok = el('button', 'primary', s.id ? 'Save' : 'Save, and make an agent for it'); ok.type = 'submit'; f.appendChild(ok);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const list = steps.value.split('\n').map((x) => x.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
      if (!name.value.trim() || !list.length) return;
      let target = skills.find((x) => x.id === s.id);
      const isNew = !target;
      if (!target) { target = { id: uid(), at: s.at || Date.now() }; skills.push(target); }
      Object.assign(target, { name: name.value.trim().slice(0, 60), steps: list.slice(0, 30) });
      skillEdit = null;
      if (isNew) editing = { id: null, name: target.name.split(' ').slice(0, 3).join(' ') + ' Buddy', job: target.name, task: target.name, when: 'off', time: '08:00', color: COLORS[agents.length % COLORS.length], skill: target.id, on: true };
      save(); render();
    });
    const row = el('div', 'agent-acts');
    const cancel = el('button', 'chip', s.id ? 'Back' : 'Throw it away'); cancel.type = 'button'; cancel.addEventListener('click', () => { skillEdit = null; render(); }); row.appendChild(cancel);
    if (s.id) { const del = el('button', 'chip danger', 'Forget this'); del.type = 'button'; del.addEventListener('click', () => { skills = skills.filter((x) => x.id !== s.id); for (const a of agents) if (a.skill === s.id) a.skill = ''; skillEdit = null; save(); render(); }); row.appendChild(del); }
    f.appendChild(row);
    box.appendChild(f);
  }

  // Runs that were cut short when Buddy quit show as stopped; due times are worked out again.
  for (const r of runs) if (r.status === 'running') r.status = 'stopped';
  for (const a of agents) if (a.on && !a.next) a.next = nextRun(a);
  save(); badge();
  $('agentsBtn').addEventListener('click', () => (shown() ? hide() : show()));
  return { show, hide, yield: yield_, running: () => !!running, nextRun, _state: () => ({ agents, skills, runs }) };
})();
