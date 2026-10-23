/* The Stupid Buddy: the team. Buddy (the lead) talks with you and hands work to helpers, each with its own
 * job, tools and colour. A helper works in small steps (look, read, move…) until its part is done, then Buddy
 * puts the results together. Anything risky is confirmed by you in a system alert (Tools.swift on Mac, windows/src/tools.rs on Windows). */
'use strict';

/* ---------------- the app side (Mac, Windows or Android) ---------------- */
const Native = (() => {
  let seq = 0; const waiting = new Map(), listeners = new Map();
  window.__native = {
    reply(id, ok, value) { const w = waiting.get(id); if (!w) return; waiting.delete(id); ok ? w.resolve(value) : w.reject(new Error(typeof value === 'string' ? value : 'failed')); },
    emit(name, value) { for (const fn of listeners.get(name) || []) fn(value); },
  };
  return {
    call(op, params = {}) { return new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); window.webkit.messageHandlers.buddy.postMessage(Object.assign({ id, op }, params)); }); },
    on(name, fn) { (listeners.get(name) || listeners.set(name, []).get(name)).push(fn); },
  };
})();

/* ---------------- the helpers ---------------- */
const fn = (name, description, props = {}, required = Object.keys(props)) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: props, required } } });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
let screen = { width: 1280, height: 800 };   // the last screenshot Hands Buddy looked at
const grid = (v, size) => Math.round(Math.max(0, Math.min(1000, Number(v) || 0)) / 1000 * size);
const handsAct = (op, a) => Native.call(op, { x: grid(a.x, screen.width), y: grid(a.y, screen.height), what: String(a.what || ''), amount: Math.round(Number(a.amount) || -5) });

const TOOLS = {
  list_folder: { def: fn('list_folder', 'List the files and folders inside a folder.', { path: str('Folder path, like ~/Downloads') }), run: (a) => Native.call('files.list', { path: a.path }), say: (a) => `Looking in ${a.path}` },
  search_files: { def: fn('search_files', 'Find files whose name contains some words, in the allowed folders.', { name: str('Words in the file name') }), run: (a) => Native.call('files.search', { query: a.name }), say: (a) => `Searching for “${a.name}”` },
  read_file: { def: fn('read_file', 'Read a text, PDF, Word, RTF or similar document.', { path: str('File path') }), run: (a) => Native.call('files.read', { path: a.path }), say: (a) => `Reading ${short(a.path)}` },
  make_folder: { def: fn('make_folder', 'Create a folder (and any missing parent folders).', { path: str('Folder path') }), run: (a) => Native.call('files.mkdir', { path: a.path }), say: (a) => `Making folder ${short(a.path)}` },
  move_file: { def: fn('move_file', 'Move or rename one file or folder. The user is asked first.', { from: str('Current path'), to: str('New path, or a folder to move it into') }), run: (a) => Native.call('files.move', { from: a.from, to: a.to }), say: (a) => `Moving ${short(a.from)}` },
  move_files: { def: fn('move_files', 'Move many files at once (asks the user once). Use this to tidy folders.', { moves: { type: 'array', description: 'List of moves', items: { type: 'object', properties: { from: str('Current path'), to: str('Folder or new path') }, required: ['from', 'to'] } } }),
    run: (a) => Native.call('files.moveMany', { moves: a.moves || [] }), say: (a) => `Moving ${(a.moves || []).length} files` },
  trash_file: { def: fn('trash_file', 'Move a file to the Trash (the user is asked first).', { path: str('File path') }), run: (a) => Native.call('files.trash', { path: a.path }), say: (a) => `Trashing ${short(a.path)}` },
  open_file: { def: fn('open_file', 'Open a file in its usual app so the user can see it.', { path: str('File path') }), run: (a) => Native.call('files.open', { path: a.path }), say: (a) => `Opening ${short(a.path)}` },
  save_text_file: { def: fn('save_text_file', 'Save text as a file (asks before replacing a file). Use .md or .txt.', { path: str('File path, like ~/Documents/Notes.md'), text: str('The full text') }), run: (a) => Native.call('files.write', { path: a.path, text: a.text }), say: (a) => `Saving ${short(a.path)}` },
  copy_to_clipboard: { def: fn('copy_to_clipboard', 'Copy text so the user can paste it anywhere.', { text: str('Text to copy') }), run: (a) => Native.call('clipboard.write', { text: a.text }), say: () => 'Copying to the clipboard' },
  web_search: { def: fn('web_search', 'Search the web. Returns titles, links and snippets.', { query: str('What to search for') }), run: (a) => Native.call('web.search', { query: a.query }), say: (a) => `Searching the web for “${a.query}”` },
  read_web_page: { def: fn('read_web_page', 'Read the text of a web page.', { url: str('Full https:// link') }), run: (a) => Native.call('web.fetch', { url: a.url }), say: (a) => `Reading ${host(a.url)}` },
  open_in_browser: { def: fn('open_in_browser', 'Open a page in The Stupid Browser for the user.', { url: str('Full https:// link') }), run: (a) => Native.call('web.open', { url: a.url }), say: (a) => `Opening ${host(a.url)} in the browser` },
  // Hands Buddy: x and y are on a 0–1000 grid over the screenshot (0,0 top-left, 1000,1000 bottom-right).
  look_at_screen: { def: fn('look_at_screen', 'Take a fresh look at the screen.'), run: () => 'ok', say: () => 'Looking at the screen' },
  click: { def: fn('click', 'Click a spot on the screen.', { x: num('0–1000, left to right'), y: num('0–1000, top to bottom'), what: str('What you are clicking, like “Send button” or “Search field”') }), run: (a) => handsAct('hands.click', a), say: (a) => `Clicking ${a.what || 'there'}` },
  double_click: { def: fn('double_click', 'Double-click a spot (to open an item).', { x: num('0–1000'), y: num('0–1000'), what: str('What you are double-clicking') }), run: (a) => handsAct('hands.doubleClick', a), say: (a) => `Double-clicking ${a.what || 'there'}` },
  right_click: { def: fn('right_click', 'Right-click a spot to open its menu.', { x: num('0–1000'), y: num('0–1000'), what: str('What you are right-clicking') }), run: (a) => handsAct('hands.rightClick', a), say: (a) => `Right-clicking ${a.what || 'there'}` },
  type_text: { def: fn('type_text', 'Type text where the cursor is (click the field first).', { text: str('The text to type') }), run: (a) => Native.call('hands.type', { text: String(a.text || '') }), say: (a) => `Typing “${String(a.text || '').slice(0, 40)}”` },
  press_keys: { def: fn('press_keys', 'Press a key or shortcut, like return, tab, esc, cmd+c, cmd+v, cmd+a, cmd+w, down.', { keys: str('The key or shortcut') }), run: (a) => Native.call('hands.key', { keys: String(a.keys || '') }), say: (a) => `Pressing ${a.keys}` },
  scroll: { def: fn('scroll', 'Scroll at a spot. Negative amount scrolls down, positive scrolls up.', { x: num('0–1000'), y: num('0–1000'), amount: num('Lines, like -5 (down) or 5 (up)') }, ['x', 'y', 'amount']), run: (a) => handsAct('hands.scroll', a), say: (a) => (a.amount > 0 ? 'Scrolling up' : 'Scrolling down') },
  open_app: { def: fn('open_app', 'Open (or switch to) an app by its name, like Notes, Safari, Calendar (Mac) or Notepad, Edge, Outlook (Windows).', { name: str('The app name') }), run: (a) => Native.call('hands.openApp', { name: String(a.name || '') }), say: (a) => `Opening ${a.name}` },
};
const short = (p) => String(p || '').split('/').slice(-2).join('/');
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

const HELPERS = {
  files: { name: 'File Buddy', color: '#6F9161', mustLook: true, job: 'finds, reads, sorts, renames and tidies files and folders',
    tools: ['list_folder', 'search_files', 'read_file', 'make_folder', 'move_file', 'move_files', 'trash_file', 'open_file'],
    rules: 'Look before you act: list a folder before moving things in it. To tidy a folder, plan folders by kind (Images, Documents, Installers, Archives, Music, Videos, Other) and use move_files once. Never trash anything unless the task clearly asks.' },
  writer: { name: 'Writer Buddy', color: '#9A6390', job: 'writes and rewrites: emails, summaries, notes, lists and documents',
    tools: ['read_file', 'save_text_file', 'copy_to_clipboard'],
    rules: 'Write clearly and warmly, in the user’s language. Put the finished text itself in your final answer so the user can read it. Only save a file when the user asks for a file or document (then save it as .md in ~/Documents unless told otherwise, and say where). Don’t copy to the clipboard unless asked.' },
  web: { name: 'Web Buddy', color: '#5B87B5', mustLook: true, job: 'looks things up on the web, compares options and gathers facts with sources',
    tools: ['web_search', 'read_web_page', 'open_in_browser'],
    rules: 'Search, then read the one to three best pages before answering. Give short facts with the source links. Never buy, sign in or fill in forms.' },
  hands: { name: 'Hands Buddy', color: '#C8606F', job: 'uses other apps on the computer by looking at the screen, clicking and typing (only for things the other helpers can’t do)',
    tools: ['look_at_screen', 'click', 'double_click', 'right_click', 'type_text', 'press_keys', 'scroll', 'open_app'],
    rules: 'You see a screenshot after each action. Spots are given as x and y on a 0–1000 grid over the screenshot (0,0 is the top-left corner, 1000,1000 the bottom-right). Do one or two actions at a time, then check the new screenshot. To start, open the app you need with open_app. Always say in “what” what you click. Never type passwords, card numbers or codes; if a password is needed, stop and ask the user to type it. Don’t send, buy, post or delete anything the user didn’t clearly ask for. If you are stuck after a few tries, stop and say what you saw.' },
};
if (window.__platform === 'android') delete HELPERS.hands;   // a phone can't lend Buddy its hands

/* ---------------- running a helper ---------------- */
async function context() {
  let roots = [];
  try { roots = await Native.call('files.roots'); } catch {}
  return `Today is ${new Date().toDateString()}. The user's home folder is ~. You may only use these folders: ${roots.join(', ') || '~/Desktop, ~/Documents, ~/Downloads'}.`;
}
const clip = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 7000 ? s.slice(0, 7000) + '…(cut)' : s; };

/** One helper does one task, step by step. ui: { step(text, isError) }. Returns its final answer. */
async function runHelper(key, task, ui, opts) {
  if (key !== 'hands') return runSteps(key, task, ui, opts);
  // Hands Buddy needs two Mac permissions and your OK, shows a red bar while it works, and Esc stops it.
  const p = await Native.call('hands.permissions').catch(() => ({}));
  if (!p.screen || !p.control) {
    Native.call('hands.askPermissions').catch(() => {});
    return 'I need two permissions first. In System Settings → Privacy & Security on your Mac, turn on The Stupid Buddy under both “Screen & System Audio Recording” and “Accessibility”, then quit and reopen Buddy and ask again.';
  }
  try { await Native.call('hands.start', { task }); }
  catch (e) { return e.message === 'permissions' ? 'I still need the Screen Recording and Accessibility permissions in System Settings.' : e.message; }
  try { return await runSteps(key, task, ui, opts); }
  finally { Native.call('hands.stop').catch(() => {}); }
}

/** Hands Buddy looks: a fresh screenshot replaces the older ones (they're big). */
async function look(messages) {
  const s = await Native.call('hands.shot');
  screen = { width: s.width, height: s.height };
  for (const m of messages) if (m.images) { delete m.images; m.content = '(an older screenshot)'; }
  messages.push({ role: 'user', content: 'This is the screen now.', images: [s.image] });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSteps(key, task, ui, { models, signal }) {
  const h = HELPERS[key];
  const messages = [
    { role: 'system', content: `You are ${h.name}, one of Buddy's helpers. Your job: you ${h.job}. ${h.rules}\n${await context()}\nWork in small steps with your tools. When the task is done, reply with a short, plain summary of what you did or found (no tool call).` },
    { role: 'user', content: task },
  ];
  // Writer Buddy only gets the save tool when the task is about a file (local AIs save everything otherwise).
  const wantsFile = /\b(save|file|document|doc|docx|pdf|\.md|\.txt|folder|desktop|documents)\b/i.test(task);
  const allowedTools = h.tools.filter((t) => !(key === 'writer' && t === 'save_text_file' && !wantsFile));
  const tools = allowedTools.map((t) => TOOLS[t].def);
  const hands = key === 'hands';
  let needLook = hands;
  for (let step = 0; step < (hands ? 25 : 12); step++) {
    if (signal.aborted) throw new Error('stopped');
    if (needLook) { await wait(600); await look(messages); needLook = false; }
    const r = await AI.chat({ model: models[key], messages, tools, signal });
    if (signal.aborted) throw new Error('stopped');   // stopped while the AI was answering
    if (!r.toolCalls.length) {
      // Small local AIs like to answer from memory; helpers that must look things up get sent to their tools once.
      if (step === 0 && h.mustLook) { messages.push({ role: 'assistant', content: r.content || '' }, { role: 'user', content: 'Don’t answer from memory. Do the task with your tools first (start now with a tool call), then summarize.' }); continue; }
      return r.content.trim() || 'Done.';
    }
    messages.push({ role: 'assistant', content: r.content || '', tool_calls: r.toolCalls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.args } })) });
    for (const c of r.toolCalls) {
      const tool = TOOLS[c.name];
      let result;
      if (!tool || !allowedTools.includes(c.name)) result = `Unknown tool ${c.name}.`;
      else {
        ui.step(tool.say(c.args || {}));
        try { result = await tool.run(c.args || {}); }
        catch (e) { result = 'Error: ' + e.message; ui.step(e.message, true); if (/isn’t allowed to act/.test(e.message)) throw new Error('stopped'); }
        if (hands) needLook = true;
      }
      messages.push({ role: 'tool', tool_call_id: c.id, tool_name: c.name, content: clip(result) });
    }
  }
  return 'I ran out of steps before finishing. Here is what I managed so far.';
}

/* ---------------- Buddy, the lead ---------------- */
const LEAD_TOOLS = Object.entries(HELPERS).map(([key, h]) =>
  fn('ask_' + key, `Give a task to ${h.name}, who ${h.job}. Write the task so it makes sense on its own (include file names, folders, links, wording).`, { task: str('The task, complete and specific') }));

const Team = {
  history: [],   // the conversation with you (Buddy's answers, not the helpers' steps)
  reset() { this.history = []; },
  /**
   * You ask; Buddy answers, handing parts to helpers when it helps.
   * ui: { job(key, task) → { step(text, err), done(summary) }, typing(text) }. Returns Buddy's reply.
   */
  async ask(text, ui, { models, name = 'Buddy', persona = '', signal }) {
    const sys = `You are ${name}, a helper who lives on the user's ${DEVICE === 'phone' ? 'phone' : DEVICE + ' desktop'}. ${persona}\nYou lead a small team:\n` +
      Object.values(HELPERS).map((h) => `- ${h.name}: ${h.job}`).join('\n') +
      `\nFor chat and quick questions, just answer. For real work, give it to the right helper with its ask_ tool. Give one helper the user's whole request about its area in ONE task, in the user's own words (never guess file names; the helper looks them up). Use several helpers only when the request really has different kinds of work (for example: find facts on the web, then write a document). Then tell the user in a few friendly sentences what was done, and include any text a helper wrote for them (like an email) in full. Don't invent results: only report what helpers told you. Answer in the user's language. Keep it short.\n${await context()}`;
    const messages = [{ role: 'system', content: sys }, ...this.history.slice(-12), { role: 'user', content: text }];
    for (let round = 0; round < 6; round++) {
      if (signal.aborted) throw new Error('stopped');
      const r = await AI.chat({ model: models.lead, messages, tools: LEAD_TOOLS, signal });
      if (signal.aborted) throw new Error('stopped');   // stopped while the AI was answering
      if (!r.toolCalls.length) {
        const answer = r.content.trim() || 'All done.';
        this.history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
        return answer;
      }
      messages.push({ role: 'assistant', content: r.content || '', tool_calls: r.toolCalls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.args } })) });
      for (const c of r.toolCalls) {
        const key = String(c.name || '').replace(/^ask_/, '');
        if (!HELPERS[key]) { messages.push({ role: 'tool', tool_call_id: c.id, tool_name: c.name, content: 'No such helper.' }); continue; }
        const task = String((c.args && c.args.task) || text);
        const job = ui.job(key, task);
        let result;
        try { result = await runHelper(key, task, job, { models, signal }); }
        catch (e) { if (e.message === 'stopped') throw e; result = 'The helper hit a problem: ' + e.message; }
        job.done(result);
        messages.push({ role: 'tool', tool_call_id: c.id, tool_name: c.name, content: clip(result) });
      }
    }
    return 'That took more rounds than I expected. Here’s where we got to above.';
  },
};
