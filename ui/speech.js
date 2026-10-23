/* The Stupid Buddy: Buddy says things. A speech bubble next to the ball (the window grows to make room, then shrinks
 * back), or a message in the chat when it's open. Used for "a new Buddy is here" (Update now / In 3 days), a hello
 * when Buddy starts, and now and then a little joke while Buddy just sits there (Settings can turn that off). */
'use strict';
const Speech = (() => {
  const bubble = $('bubble');
  let speaking = false, hideT = null, token = 0;
  // What Buddy is saying now, and a question that's still unanswered (the update prompt): if the bubble goes away
  // before you answer, it waits in the chat for the next time you open it.
  let current = null, unanswered = null, waiting = null;
  const closed = () => document.body.classList.contains('closed');
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Flying after a fling: the app sends "roll" every frame until "landed". The bubble waits for him to land.
  let lastRoll = 0;
  Native.on('roll', () => { lastRoll = Date.now(); });
  Native.on('landed', () => { lastRoll = 0; });
  const flying = () => Date.now() - lastRoll < 500;
  const held = () => $('ball').classList.contains('held');   // you're dragging him

  /** Says text. actions: [{ label, fn, primary }] become buttons; ms: how long it stays (0: until answered). */
  async function say(text, { actions = [], ms = 8000 } = {}) {
    if (!closed()) { inChat(text, actions); return; }
    // Busy opening, closing or flying: say it in a moment instead (only the latest thing waits).
    if (moving || flying() || held()) { waiting = { text, actions, ms }; return; }
    const my = ++token;
    clearTimeout(hideT);
    current = { text, actions };
    if (actions.length) unanswered = current;
    if (!speaking) {
      speaking = true;
      document.body.classList.add('speaking', 'switching');   // the ball hides for the frame the window changes size
      let at = null;
      try { at = await Native.call('window', { mode: 'bubble' }); } catch {}
      if (my !== token) return;
      place(at);
      document.body.classList.remove('switching');
    }
    const words = el('div', 'bubble-text');
    const row = el('div', 'bubble-acts');
    for (const a of actions) {
      const b = el('button', 'chip' + (a.primary ? ' primary-chip' : ''), a.label);
      b.addEventListener('click', (e) => { e.stopPropagation(); unanswered = null; a.fn(); });
      row.appendChild(b);
    }
    bubble.replaceChildren(words, ...(actions.length ? [row] : []));
    bubble.classList.remove('pop'); void bubble.offsetWidth; bubble.classList.add('pop');
    // Typed out like he's saying it (all at once when you've asked for less motion).
    if (calm()) words.textContent = text;
    else for (let i = 1; i <= text.length && my === token; i++) { words.textContent = text.slice(0, i); await new Promise((r) => setTimeout(r, 16)); }
    if (my === token && ms) hideT = setTimeout(hush, ms);
  }
  setInterval(() => { if (waiting && !moving && !flying() && !held()) { const w = waiting; waiting = null; say(w.text, w); } }, 700);

  /** Where the ball sits in the bigger window (from the app), and the bubble on the side with room. */
  function place(at) {
    const W = innerWidth, H = innerHeight;
    const x = at && typeof at.x === 'number' ? at.x : W - 60, y = at && typeof at.y === 'number' ? at.y : H - 60;
    document.body.style.setProperty('--bx', (x - 60) + 'px');
    document.body.style.setProperty('--by', (y - 60) + 'px');
    const right = x > W / 2;
    bubble.classList.toggle('tail-right', right); bubble.classList.toggle('tail-left', !right);
    const width = Math.min(240, (right ? x - 52 : W - x - 52) - 8);
    bubble.style.width = width + 'px';
    bubble.style.left = (right ? x - 52 - width : x + 52) + 'px';
    // Buddy in the top half: the bubble hangs from his height; in the bottom half it grows upwards from it, so the
    // tail always meets him whatever the length of the text.
    const low = y > H / 2;
    bubble.classList.toggle('low', low);
    if (low) { bubble.style.top = 'auto'; bubble.style.bottom = Math.max(8, H - y - 29) + 'px'; }
    else {
      const top = Math.max(8, y - 28);
      bubble.style.bottom = 'auto'; bubble.style.top = top + 'px';
      bubble.style.setProperty('--ty', Math.max(10, y - top - 7) + 'px');
    }
  }
  /** The bubble goes away and the window becomes the ball again. */
  async function hush() {
    if (!speaking) return;
    const my = ++token; clearTimeout(hideT); speaking = false; current = null;
    bubble.replaceChildren();
    document.body.classList.add('switching');
    if (closed()) { try { await Native.call('window', { mode: 'ball' }); } catch {} }
    if (my !== token) return;   // he started saying something else meanwhile; that one sets things up
    document.body.classList.remove('speaking', 'switching');
    document.body.style.removeProperty('--bx'); document.body.style.removeProperty('--by');
  }
  /** The chat is about to open: the bubble goes, and a question you haven't answered moves into the chat. */
  async function handoff() {
    if (waiting && waiting.actions.length) unanswered = waiting;
    waiting = null;
    await hush();
    if (unanswered) { const u = unanswered; unanswered = null; return u; }
    return null;
  }
  function inChat(text, actions) {
    const b = el('div', 'msg bot'); b.innerHTML = md(text); log.appendChild(b);
    if (actions.length) {
      unanswered = null;
      const row = el('div', 'note');
      for (const a of actions) { const btn = el('button', null, a.label); btn.addEventListener('click', () => { row.remove(); a.fn(); }); row.appendChild(btn); }
      log.appendChild(row);
    }
    scroll();
  }

  /* ---------------- a new Buddy ---------------- */
  Native.on('update:available', (version) => say(`Psst! A new Buddy (${version}) is here 🎉`, { ms: 60000, actions: [
    { label: 'Update now', primary: true, fn: async () => {
      say('Updating… see you in a few seconds!', { ms: 8000 });
      const m = await Native.call('update.install').catch((e) => e.message);
      if (m && !/^Installing/.test(m)) say(m, { ms: 9000 });
    } },
    { label: 'In 3 days', fn: () => { Native.call('update.later').catch(() => {}); say('No problem! I’ll ask again in 3 days.', { ms: 4000 }); } },
  ] }));

  /* ---------------- hello, and a little chatter ---------------- */
  const LINES = [
    'I’m not lazy, I’m in energy-saving mode.',
    'It’s not a bug, it’s a surprise feature.',
    'Hydration check! 💧 Go drink some water, human.',
    'One does not simply close 47 tabs.',
    'Ctrl+Z is my love language.',
    'Task failed successfully.',
    'I tried to touch grass once. Couldn’t find any on the desktop.',
    'Have you tried turning it off and on again? Works on me too.',
    '*stares at your Downloads folder* We need to talk.',
    'Fun fact: I bounce. Go on, throw me.',
    'Achievement unlocked: turned on the computer today. 🏆',
    'POV: you have 3 unfinished side projects and you’re planning a fourth.',
    'Stretch break? Your back will thank you.',
    'I’m just a little guy. 🫧',
    'This desktop is clean. Suspiciously clean.',
    '404: motivation not found. Want me to do something for you instead?',
    'Brb, buffering my next thought…',
    'Me, waiting for you to need something: 👀',
    'If you need me, I’ll be here. Being round.',
    'Plot twist: the real assistant was the friends we made along the way.',
    'Loading witty comment… 87%… 88%… never mind.',
    'Remember to save your work. I say this with love.',
  ];
  const chatterOn = () => { try { return localStorage.getItem('chatter') !== 'off'; } catch { return true; } };
  const quiet = () => busy || speaking || waiting || flying() || held() || !closed() || !ready
    || (typeof Agents !== 'undefined' && (Agents.running() || Agents.teaching()))
    || document.body.classList.contains('hands');
  let recent = [];
  function pick() {
    const left = LINES.filter((l) => !recent.includes(l));
    const line = left[Math.floor(Math.random() * left.length)];
    recent = [...recent, line].slice(-8);
    return line;
  }
  const minutes = (a, b) => (a + Math.random() * (b - a)) * 60e3;
  let next = Date.now() + minutes(8, 15);
  setInterval(() => {
    if (Date.now() < next) return;
    if (!chatterOn() || quiet()) { next = Date.now() + minutes(3, 6); return; }
    next = Date.now() + minutes(25, 50);
    hop(); say(pick(), { ms: 7000 });
  }, 30e3);

  /** A little hop and a happy face: Buddy noticing you. */
  function hop() {
    if (calm()) return;
    const ball = $('ball');
    if (ball.classList.contains('b3d')) Ball3D.land(0.55);
    else { ball.classList.remove('squash'); void ball.offsetWidth; ball.classList.add('squash'); setTimeout(() => ball.classList.remove('squash'), 260); }
    face('happy'); setTimeout(() => face(''), 1400);
  }
  /** When Buddy starts: pops up, hops and says hi. */
  function hello() {
    if (!closed()) return;
    const h = new Date().getHours(), L = Look.get();
    const who = L.call ? ' ' + L.call : '';
    const greet = h < 5 ? `Up late${who}? I’m here. 🌙` : h < 11 ? `Good morning${who}! ☀️` : h < 17 ? `Hi${who}! I’m back 👋` : `Good evening${who}! 🌆`;
    document.body.classList.add('hello');
    setTimeout(() => { document.body.classList.remove('hello'); hop(); if (chatterOn()) say(greet, { ms: 4500 }); }, calm() ? 0 : 700);
  }

  /** You checked for updates yourself (Settings): the old question is answered. */
  const forget = () => { unanswered = null; if (waiting && waiting.actions.length) waiting = null; };

  return { say, hush, handoff, forget, inChat, hello, active: () => speaking, LINES };
})();
