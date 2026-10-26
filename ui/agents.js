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
  let running = null;   // { agent id, controller, settled: a promise for when it has really stopped }
  let teaching = false; // Buddy is watching you (or learning from it): agents wait
  async function run(agent, why, message = '') {
    if (running || busy || teaching) return false;
    let settle; const settled = new Promise((r) => (settle = r));
    const controller = new AbortController(); running = { id: agent.id, controller, settled };
    document.body.classList.add('agent-busy');
    const skill = skills.find((s) => s.id === agent.skill);
    const text = (message || agent.task) + (skill && !message ? `\n\nThis is how I do it myself; follow these steps:\n${skill.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '');
    const rec = { id: uid(), agent: agent.id, at: Date.now(), why, status: 'running', helpers: [], answer: '', steps: [], asked: message ? message.slice(0, 500) : '' };
    runs.push(rec); save(); refresh();
    // What it's doing, step by step, for the live view (the last 30 steps are kept with the run).
    const ui = { job(key) {
      const who = HELPERS[key] ? HELPERS[key].name : 'Buddy';
      if (HELPERS[key] && !rec.helpers.includes(who)) rec.helpers.push(who);
      rec.steps.push({ who, text: 'Started', at: Date.now() }); live();
      return {
        step(text, err) { rec.steps.push({ who, text: String(text || '').slice(0, 200), err: !!err, at: Date.now() }); rec.steps = rec.steps.slice(-30); live(); },
        done() {},
      };
    } };
    // Its own memory: the last things you told it and what it answered (not your chat with Buddy).
    const team = Object.create(Team); team.history = (agent.thread || []).slice(-12);
    try {
      rec.answer = await team.ask(text, ui, { models, name: agent.name, color: agent.color, persona: `You are one of the user's own agents, working on your own while they do other things. Your job: ${agent.job}`, signal: controller.signal,
        // Using the mouse and keyboard needs you there to say yes: on its own, only an agent following something you
        // taught it may (Run now is you being there).
        without: skill || why === 'now' ? [] : ['hands'] });
      rec.status = 'done';
      agent.thread = [...team.history].slice(-20);
    } catch (e) {
      rec.status = e.message === 'stopped' ? 'stopped' : 'failed';
      rec.answer = e.message === 'stopped' ? 'Stopped.' : (ERRORS[e.message] || 'Something went wrong: ' + e.message);
    } finally {
      running = null; document.body.classList.remove('agent-busy');
      agent.last = Date.now();
      if (rec.status === 'stopped' && why === 'schedule') agent.next = Date.now() + 10 * 60e3;   // you needed Buddy; try again soon
      else agent.next = nextRun(agent);
      rec.unread = rec.status !== 'stopped'; save(); refresh(); badge();
      // Buddy tells you, in his speech bubble (or the chat), when one of your agents has finished.
      if (rec.status !== 'stopped' && why === 'schedule' && typeof Speech !== 'undefined' && !shown()) {
        const first = String(rec.answer || '').replace(/[#*_`>]/g, '').split(/\n+/).find((l) => l.trim()) || '';
        const line = rec.status === 'done' ? `${agent.name} is done ✓ ${first.length > 70 ? first.slice(0, 68) + '…' : first}` : `${agent.name} couldn’t finish. Want a look?`;
        Speech.say(line.trim(), { ms: 20000, actions: [{ label: 'Show me', primary: true, fn: async () => { await Speech.hush(); if (document.body.classList.contains('closed')) await open(); open_ = agent.id; show(); } }] });
      }
      settle();
    }
    return true;
  }
  /** You asked Buddy something: a running agent steps aside (it tries again in 10 minutes). Resolves once it has
   *  really stopped (its current step can't always be cut short), so it can't touch anything you start after. */
  function yield_() { if (!running) return Promise.resolve(); running.controller.abort(); return running.settled; }
  // The clock: anything due runs, one at a time, whenever Buddy isn't busy with you.
  setInterval(() => {
    if (running || busy || teaching) return;
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
  function hide() { view().classList.add('hidden'); for (const id of ['log', 'ask', 'chips']) $(id).classList.remove('hidden'); editing = skillEdit = null; open_ = null; }
  const shown = () => !view().classList.contains('hidden');
  // From the background (a run starting or finishing): don't wipe a form you're filling in.
  const refresh = () => { if (editing || skillEdit || teaching) return; const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('.agent-say'); if (typing && typing.querySelector('input').value) return; render(); };
  function badge() { document.body.classList.toggle('unread', runs.some((r) => r.unread)); }

  // Ready-made agents: one tap fills in the form, you change what you like.
  const TEMPLATES = [
    { icon: '☀️', name: 'Morning Buddy', job: 'Starts my day', task: 'Write me a short, friendly morning brief: today\'s date, one thing worth knowing from the news, and a tip to get going. Keep it under 100 words.', when: 'weekdays', time: '08:00' },
    { icon: '🧹', name: 'Tidy Buddy', job: 'Keeps my Downloads folder clean', task: 'Look in my Downloads folder and put files in folders by kind: Images, Documents, Installers, Archives and Other. Tell me what you moved.', when: 'daily', time: '17:00' },
    { icon: '🔎', name: 'Research Buddy', job: 'Looks things up for me', task: 'Find the three most useful, recent articles about a topic I care about and sum each up in two sentences with its link. Topic: AI tools for small businesses.', when: 'weekdays', time: '12:00' },
    { icon: '✍️', name: 'Writer Buddy', job: 'Drafts things for me', task: 'Draft a short, warm LinkedIn post about something I learned this week. Ask me nothing; make a good first draft I can edit.', when: 'off', time: '08:00' },
    { icon: '📊', name: 'Week Buddy', job: 'Sums up my week', task: 'Look at what I changed in Documents and Desktop this week and write a short summary of what I worked on, as bullet points.', when: 'daily', time: '16:00' },
  ];
  let open_ = null;
  /** An agent's picture: a little screen-faced bot in its colour, with its emoji on a badge. */
  const ICONS = ['☀️', '🧹', '🔎', '✍️', '📊', '📬', '🛒', '📅', '💡', '🎵', '🏃', '🧠'];
  function avatar(a, size = 36) {
    const b = el('span', 'bot-av'); b.style.setProperty('--c', a.color || COLORS[0]); b.style.setProperty('--s', size + 'px');
    const face = el('span', 'bot-face'); face.append(el('i'), el('i')); b.appendChild(face);
    if (a.icon) b.appendChild(el('span', 'bot-badge', a.icon));
    return b;
  }   // the agent whose page is open (its talk, what it's doing, what it did)

  function render() {
    if (!shown()) return;
    const box = view(); box.replaceChildren();
    if (skillEdit) { box.appendChild(el('h2', 'serif', 'Your agents')); return renderSkill(box); }
    if (editing) { box.appendChild(el('h2', 'serif', editing.id ? 'Change ' + (editing.name || 'agent') : 'New agent')); return renderForm(box); }
    const a = open_ && agents.find((x) => x.id === open_);
    if (a) return renderAgent(box, a);
    box.appendChild(el('h2', 'large', 'Agents'));
    box.appendChild(el('p', 'intro', 'Little Buddies with one job each. They work on this ' + DEVICE + ' while you do other things. Tap one to talk to it or see what it’s doing.'));
    // Always on: Buddy starts with the computer, so a 08:00 agent runs at 08:00 even if you never opened him.
    const always = el('label', 'always hidden'); const box2 = el('input'); box2.type = 'checkbox'; box2.className = 'switch';
    const at = el('span', 'always-text'); at.append(el('b', null, 'Always on'), el('small', null, 'Start Buddy when I log in, so agents run on time'));
    always.append(at, box2);
    box.appendChild(always);
    Native.call('autostart').then((on) => {
      if (typeof on !== 'boolean') return;   // not on this computer
      box2.checked = on; always.classList.remove('hidden');
      always.classList.toggle('warn', !on && agents.some((a) => a.on && a.when !== 'off'));
    }).catch(() => {});
    box2.addEventListener('change', () => {
      Native.call('autostart', { on: box2.checked }).then((on) => { box2.checked = on; always.classList.remove('warn'); })
        .catch((e) => { box2.checked = !box2.checked; note2(e.message); });
    });
    // The board: every agent with how it's doing right now.
    const board = el('div', 'board');
    for (const x of agents) board.appendChild(tile(x));
    const add = el('button', 'tile add'); add.type = 'button';
    add.append(el('span', 'add-plus', '+'), el('div', 'tile-name', 'New agent'), el('div', 'tile-job', 'Give it a name and a job'));
    add.addEventListener('click', () => { editing = { id: null, name: '', job: '', task: '', when: 'daily', time: '08:00', color: COLORS[agents.length % COLORS.length], skill: '', on: true, icon: '' }; render(); });
    board.appendChild(add);
    box.appendChild(board);
    // Start from a ready-made one.
    const g0 = el('div', 'group'); g0.appendChild(el('div', 'label', agents.length ? 'Or start from one of these' : 'Start from one of these'));
    const tpl = el('div', 'templates');
    for (const t of TEMPLATES) {
      const b = el('button', 'template'); b.type = 'button';
      b.append(el('span', 'template-icon', t.icon), Object.assign(el('span', 'template-text'), {}));
      b.lastChild.append(el('b', null, t.name), el('small', null, t.job)); b.appendChild(el('span', 'chev', '›'));
      b.addEventListener('click', () => { editing = Object.assign({ id: null, color: COLORS[agents.length % COLORS.length], skill: '', on: true }, t); render(); });
      tpl.appendChild(b);
    }
    g0.appendChild(tpl); box.appendChild(g0);
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

  /** How an agent is doing, in a few words. */
  function status(a) {
    if (running && running.id === a.id) return ['working', 'Working…'];
    if (!a.on) return ['paused', 'Paused'];
    const last = runs.filter((r) => r.agent === a.id).slice(-1)[0];
    if (last && last.status === 'failed') return ['failed', 'Needs a look'];
    if (a.when === 'off' || !a.next) return ['idle', 'Waits for you'];
    return ['waiting', 'Next ' + new Date(a.next).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })];
  }
  /** One agent on the board. */
  function tile(a) {
    const [kind, text] = status(a);
    const t = el('button', 'tile ' + kind); t.type = 'button';
    const ball = avatar(a, 40); if (kind === 'working') ball.classList.add('thinking');
    const unread = runs.some((r) => r.agent === a.id && r.unread);
    const name = el('div', 'tile-name', a.name); if (unread) name.appendChild(el('i', 'tile-dot'));
    t.append(ball, name, el('div', 'tile-job', a.job), el('div', 'tile-status', text));
    t.addEventListener('click', () => { open_ = a.id; for (const r of runs) if (r.agent === a.id) r.unread = false; save(); badge(); render(); });
    return t;
  }

  /** An agent's own page: talk to it, see what it's doing right now, and what it did before. */
  function renderAgent(box, a) {
    const isRunning = running && running.id === a.id;
    const top = el('div', 'agent-top');
    const back = el('button', 'chip back', '‹ All agents'); back.addEventListener('click', () => { open_ = null; render(); });
    top.appendChild(back); box.appendChild(top);
    const head = el('div', 'agent-head big'); head.appendChild(avatar(a, 52));
    const t = el('div', 'grow'); t.append(el('div', 'title', a.name), el('small', null, a.job)); head.appendChild(t);
    const [kind, text] = status(a); head.appendChild(el('span', 'pill-status ' + kind, text));
    box.appendChild(head);
    const acts = el('div', 'agent-acts');
    const btn = (label, fn, cls = 'chip') => { const b = el('button', cls, label); b.addEventListener('click', fn); acts.appendChild(b); return b; };
    if (isRunning) btn('Stop', () => running && running.controller.abort());
    else { const r = btn('Run now', () => { if (running || busy || teaching) note2('Buddy is busy right now. Try again in a moment.'); else run(a, 'now'); }); r.disabled = !!running || !!busy; }
    btn(a.on ? 'Pause' : 'Resume', () => { a.on = !a.on; a.next = nextRun(a); save(); render(); });
    btn('Edit', () => { editing = Object.assign({}, a); render(); });
    box.appendChild(acts);
    box.appendChild(el('div', 'agent-meta', whenText(a) + (a.skill ? ' · follows something you taught it' : '')));
    // Live: what it's doing right now, step by step.
    const now = isRunning && runs.filter((r) => r.agent === a.id).slice(-1)[0];
    if (now) {
      const lv = el('div', 'live'); lv.id = 'agentLive';
      lv.appendChild(el('div', 'live-head', 'Working now'));
      const list = el('div', 'live-steps');
      for (const st of now.steps.slice(-8)) { const r = el('div', 'live-step' + (st.err ? ' err' : '')); r.append(el('b', null, st.who), document.createTextNode(' ' + st.text)); list.appendChild(r); }
      if (!now.steps.length) list.appendChild(el('div', 'live-step', 'Getting started…'));
      lv.appendChild(list); box.appendChild(lv);
    }
    // The conversation: what you asked it and what it did, oldest first.
    const talk = el('div', 'agent-talk');
    const mine = runs.filter((r) => r.agent === a.id).slice(-12);
    if (!mine.length) talk.appendChild(el('div', 'empty', `${a.name} hasn’t done anything yet. Tap Run now, or tell it something below.`));
    for (const r of mine) {
      if (r.asked) talk.appendChild(el('div', 'msg me', r.asked));
      if (r.status === 'running') continue;
      const b = el('div', 'msg bot' + (r.status === 'failed' ? ' failed' : ''));
      b.appendChild(el('div', 'msg-when', (r.why === 'schedule' ? 'On schedule · ' : '') + ago(r.at) + (r.helpers.length ? ' · with ' + r.helpers.join(', ') : '')));
      const body = el('div'); body.innerHTML = md(r.answer || ''); b.appendChild(body);
      talk.appendChild(b);
    }
    box.appendChild(talk);
    // Tell it something: it works on that now, and remembers it next time.
    const f = el('form', 'agent-say');
    const i = el('input'); i.placeholder = `Tell ${a.name} something…`; i.maxLength = 500;
    const go = el('button', 'chip say-send', 'Send'); go.type = 'submit';
    f.append(i, go);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const msg = i.value.trim(); if (!msg) return;
      if (running || busy || teaching) { note2('Buddy is busy right now. Try again in a moment.'); return; }
      i.value = ''; run(a, 'now', msg);
    });
    box.appendChild(f);
    setTimeout(() => { talk.scrollIntoView({ block: 'end' }); }, 0);
  }
  // While an agent works, its page shows each step as it happens (without redrawing a form you're typing in).
  function live() {
    if (!shown() || editing || skillEdit || teaching) return;
    const r = running && runs.find((x) => x.agent === running.id && x.status === 'running');
    const lv = $('agentLive');
    if (!r || !lv || open_ !== running.id) { refresh(); return; }
    const list = lv.querySelector('.live-steps'); list.replaceChildren();
    for (const st of r.steps.slice(-8)) { const d = el('div', 'live-step' + (st.err ? ' err' : '')); d.append(el('b', null, st.who), document.createTextNode(' ' + st.text)); list.appendChild(d); }
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
    const ic = el('div', 'swatches icons'); let icon = a.icon || '';
    for (const e of ['', ...ICONS]) { const b = el('button', 'icon-pick' + (e === icon ? ' on' : ''), e || '–'); b.type = 'button'; b.title = e ? 'Use ' + e : 'No badge'; b.addEventListener('click', () => { icon = e; ic.querySelectorAll('.icon-pick').forEach((x) => x.classList.toggle('on', x === b)); }); ic.appendChild(b); }
    field('Badge', ic);
    const err = el('div', 'note left'); f.appendChild(err);
    const save1 = el('button', 'primary', a.id ? 'Save' : 'Make the agent'); save1.type = 'submit'; f.appendChild(save1);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!name.value.trim() || !task.value.trim()) { err.textContent = 'Give it a name and something to do.'; return; }
      const v = { name: name.value.trim().slice(0, 40), job: job.value.trim().slice(0, 160) || task.value.trim().slice(0, 160), task: task.value.trim().slice(0, 2000), when: when.value, time: time.value || '08:00', color, icon, skill: skill.value || '' };
      let target = agents.find((x) => x.id === a.id);
      if (!target) { target = { id: uid(), on: true, last: null }; agents.push(target); }
      Object.assign(target, v); target.next = nextRun(target);
      editing = null; save(); render();
    });
    const row = el('div', 'agent-acts');
    const cancel = el('button', 'chip', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => { editing = null; render(); }); row.appendChild(cancel);
    if (a.id) { const del = el('button', 'chip danger', 'Delete agent'); del.type = 'button'; del.addEventListener('click', () => { if (running && running.id === a.id) running.controller.abort(); agents = agents.filter((x) => x.id !== a.id); runs = runs.filter((r) => r.agent !== a.id); editing = null; save(); render(); }); row.appendChild(del); }
    f.appendChild(row);
    box.appendChild(f);
    name.focus();
  }

  /* ---------------- teaching ---------------- */
  async function startTeach() {
    if (busy || running) { note2('Buddy is busy right now. Try again in a moment.'); return; }
    teaching = true; hide(); close();
    await new Promise((r) => setTimeout(r, 400));
    try { await Native.call('teach.start'); } catch (e) { teaching = false; await open(); show(); note2(e.message); }
  }
  Native.on('teach:done', async (steps) => {
    await open(); show();
    const useful = (steps || []).filter((s) => s.kind === 'click' || s.kind === 'typed');
    if (useful.length < 2) { teaching = false; render(); note2('Buddy didn’t see enough to learn from. Try again, and do the whole task before pressing Esc.'); return; }
    const box = view(); box.replaceChildren(el('h2', 'serif', 'Your agents'));
    const wait = el('div', 'msg bot typing', 'Learning what you did'); box.appendChild(wait);
    document.body.classList.add('agent-busy');
    try { skillEdit = Object.assign({ id: null, at: Date.now() }, await learn(useful)); }
    catch (e) { skillEdit = { id: null, at: Date.now(), name: 'New skill', steps: useful.map(describe) }; }
    finally { document.body.classList.remove('agent-busy'); teaching = false; }
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
  return { show, hide, refresh, yield: yield_, running: () => !!running, teaching: () => teaching, nextRun, _state: () => ({ agents, skills, runs }) };
})();
