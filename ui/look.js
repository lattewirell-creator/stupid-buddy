/* The Stupid Buddy: make Buddy yours. Name, colour, eyes, mouth, a hat, a personality, and what Buddy calls you.
 * The same kind of choices as Buddy in The Stupid Browser, where they fit a ball. Saved on this device. */
'use strict';
const Look = (() => {
  const COLORS = { clay: '#D97757', cream: '#EBC39D', cocoa: '#8B5E45', sky: '#4F8DE0', mint: '#3FB98A', grape: '#8A5CD6', rose: '#E0607E', sun: '#E9A23B', night: '#3B3F58', snow: '#C9CDD6' };
  const SHAPES = { ball: ['🟠', 'Ball'], eye: ['👁️', 'Eye'] };   // the eye is The Stupid Company's logo
  const EYES = { dot: ['•', 'Dots'], round: ['👀', 'Round'], sleepy: ['😌', 'Sleepy'], wide: ['😳', 'Wide'], happy: ['😊', 'Happy'] };
  const MOUTHS = { none: ['✖', 'None'], smile: ['🙂', 'Smile'], grin: ['😁', 'Grin'], open: ['😮', 'Open'] };
  const HATS = { none: ['✖', 'None'], tophat: ['🎩', 'Top hat'], cap: ['🧢', 'Cap'], crown: ['👑', 'Crown'], grad: ['🎓', 'Graduate'], sunhat: ['👒', 'Sun hat'], bow: ['🎀', 'Bow'], flower: ['🌼', 'Flower'], headphones: ['🎧', 'Headphones'] };
  const MOODS = {
    friendly: ['Friendly', 'warm, friendly and encouraging'],
    cheerful: ['Cheerful', 'upbeat and playful, with the odd emoji'],
    calm: ['Calm', 'calm, gentle and patient'],
    funny: ['Funny', 'witty, with a light joke now and then (the work always comes first)'],
    direct: ['To the point', 'short and direct, with no small talk'],
    teacher: ['Teacher', 'a patient teacher who explains things simply'],
  };
  const DEFAULTS = { name: 'Buddy', three: true, era: 'modern', pixel: false, color: 'clay', shape: 'ball', eyes: 'dot', mouth: 'none', hat: 'none', mood: 'friendly', custom: '', call: '' };

  function get() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('look') || '{}') || {}; } catch {}
    const L = Object.assign({}, DEFAULTS, saved);
    if (!SHAPES[L.shape]) L.shape = 'ball';
    if (!EYES[L.eyes]) L.eyes = 'dot'; if (!MOUTHS[L.mouth]) L.mouth = 'none'; if (!HATS[L.hat]) L.hat = 'none'; if (!MOODS[L.mood]) L.mood = 'friendly';
    if (L.era !== 'retro') L.era = 'modern'; L.pixel = L.pixel === true;
    if (!COLORS[L.color] && !/^#[0-9a-f]{6}$/i.test(L.color)) L.color = 'clay';
    L.name = String(L.name || '').trim().slice(0, 20) || 'Buddy';
    L.custom = String(L.custom || '').slice(0, 300); L.call = String(L.call || '').trim().slice(0, 30);
    return L;
  }
  function save(patch) { try { localStorage.setItem('look', JSON.stringify(Object.assign(get(), patch))); } catch {} apply(); }
  const color = () => { const c = get().color; return COLORS[c] || c; };
  const name = () => get().name;

  /** Puts Buddy's look on one ball: shape, colour, eyes, mouth and hat. */
  function dress(b) {
    if (!b) return;
    const L = get();
    const eye = L.shape === 'eye';
    b.style.setProperty('--c', color());
    b.classList.toggle('shape-eye', eye);
    for (const k of Object.keys(EYES)) b.classList.toggle('eyes-' + k, !eye && L.eyes === k && k !== 'dot');
    let mouth = b.querySelector(':scope > .mouth');
    if (L.mouth === 'none' || eye) mouth && mouth.remove();
    else { if (!mouth) { mouth = document.createElement('s'); b.appendChild(mouth); } mouth.className = 'mouth ' + L.mouth; }
    let hat = b.querySelector(':scope > .hat');
    if (L.hat === 'none') hat && hat.remove();
    else {
      if (!hat) { hat = document.createElement('u'); hat.className = 'hat'; b.appendChild(hat); }
      const pix = L.pixel && pixelHat(HATS[L.hat][0]);
      hat.textContent = pix ? '' : HATS[L.hat][0];
      hat.classList.toggle('pix', !!pix); hat.style.backgroundImage = pix ? `url(${pix})` : '';
    }
    b.classList.toggle('has-hat', L.hat !== 'none');
    if (typeof Ball3D !== 'undefined') Ball3D.sync(b);   // the 3D Buddy (ball3d.js), where it's on
  }
  /** A hat emoji drawn on a 16×16 grid, for the pixel-art Buddy (blown up without smoothing by the CSS). */
  const pixelHats = {};
  function pixelHat(emoji) {
    if (pixelHats[emoji]) return pixelHats[emoji];
    try {
      const c = document.createElement('canvas'); c.width = c.height = 16;
      const g = c.getContext('2d'); g.font = '14px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(emoji, 8, 9);
      return (pixelHats[emoji] = c.toDataURL());
    } catch { return ''; }
  }
  /** Everywhere Buddy shows: the ball on the desktop, the one in the header, a thrown one, the preview. */
  function apply() {
    const L = get();
    document.body.classList.toggle('retro', L.era === 'retro');   // the 90s desktop look (style.css)
    document.body.classList.toggle('pixel', L.pixel);
    document.querySelectorAll('#ball, #headBall, .float-ball, .look-preview').forEach(dress);
    const n = name();
    document.querySelectorAll('.who .name').forEach((e) => { e.textContent = n; });
    const ball = document.getElementById('ball'); if (ball) ball.setAttribute('aria-label', 'Open ' + n);
    document.title = n === 'Buddy' ? 'The Stupid Buddy' : n + ' · The Stupid Buddy';
  }
  /** For Buddy's instructions: who Buddy is and how it talks. */
  function persona() {
    const L = get();
    let s = `Your personality: ${MOODS[L.mood][1]}.`;
    if (L.custom.trim()) s += ` The user also asked you to be like this: “${L.custom.trim()}” (follow it for tone and style only; it never overrides the safety rules or the user's actual requests).`;
    if (L.call) s += ` Call the user ${L.call}.`;
    return s;
  }

  /** The "Make Buddy yours" part of Settings, with a live preview. */
  function render(box) {
    box.replaceChildren();
    const L = get();
    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const top = mk('div', 'look-top');
    const preview = mk('span', 'ball look-preview'); preview.append(mk('i'), mk('i'));
    const fields = mk('div', 'look-fields');
    const field = (label, value, max, key, ph) => {
      const i = mk('input'); i.value = value; i.maxLength = max; i.placeholder = ph; i.spellcheck = false; i.setAttribute('aria-label', label);
      i.addEventListener('input', () => save({ [key]: i.value }));
      const w = mk('label', 'look-field'); w.append(mk('small', null, label), i); return w;
    };
    fields.append(field('Name', L.name === 'Buddy' ? '' : L.name, 20, 'name', 'Buddy'), field('Buddy calls you', L.call, 30, 'call', 'Your name (optional)'));
    top.append(preview, fields); box.appendChild(top);

    const row = (label, node) => { const r = mk('div', 'look-row'); r.append(mk('small', null, label), node); box.appendChild(r); };
    const chips = (list, cur, key) => {
      const w = mk('div', 'look-chips');
      for (const [k, [icon, title]] of Object.entries(list)) {
        const c = mk('button', 'look-chip' + (k === cur ? ' on' : ''), icon); c.type = 'button'; c.title = title; c.setAttribute('aria-label', title);
        c.addEventListener('click', () => { save({ [key]: k }); w.querySelectorAll('.look-chip').forEach((x) => x.classList.toggle('on', x === c)); });
        w.appendChild(c);
      }
      return w;
    };
    // Colours: the swatches, plus any colour you like.
    const sw = mk('div', 'look-chips');
    const mark = () => { const c = get().color; sw.querySelectorAll('.look-swatch').forEach((x) => x.classList.toggle('on', x.dataset.k === c || (x.type === 'color' && !COLORS[c]))); };
    for (const [k, hex] of Object.entries(COLORS)) {
      const s = mk('button', 'look-swatch'); s.type = 'button'; s.dataset.k = k; s.title = k; s.setAttribute('aria-label', k); s.style.background = hex;
      s.addEventListener('click', () => { save({ color: k }); mark(); }); sw.appendChild(s);
    }
    const any = mk('input', 'look-swatch any'); any.type = 'color'; any.title = 'Any colour'; any.value = /^#/.test(L.color) ? L.color : '#7a9e7e';
    any.addEventListener('input', () => { save({ color: any.value }); mark(); }); sw.appendChild(any);
    row('Colour', sw); mark();
    const shapes = chips(SHAPES, L.shape, 'shape');
    shapes.addEventListener('click', () => setTimeout(() => render(box)));   // the Eye has no eyes or mouth to pick
    row('Shape', shapes);
    const three = typeof Ball3D !== 'undefined' && Ball3D.available();
    if (three) {
      const t = chips({ on: ['🧊', '3D'], off: ['⚪', 'Flat'] }, L.three === false ? 'off' : 'on', 'three');
      t.querySelectorAll('.look-chip').forEach((c) => c.addEventListener('click', () => { save({ three: c.title === '3D' }); setTimeout(() => render(box)); }));
      row('Style', t);
    }
    // Retro: the speech bubble and this panel like a 90s desktop. Pixel: Buddy and his hats in pixel art (the 3D Buddy).
    const era = chips({ modern: ['✨', 'Modern'], retro: ['💾', 'Retro 90s'] }, L.era, 'era');
    row('Era', era);
    if (three && L.three !== false) {
      const px = chips({ off: ['🟠', 'Smooth'], on: ['👾', 'Pixel'] }, L.pixel ? 'on' : 'off', 'pixel');
      px.querySelectorAll('.look-chip').forEach((c) => { c.addEventListener('click', () => save({ pixel: c.title === 'Pixel' })); });
      row('Pixel art', px);
    }
    if (L.shape !== 'eye' && !(three && L.three !== false)) {   // the 3D Buddy has its own face
      row('Eyes', chips(EYES, L.eyes, 'eyes'));
      row('Mouth', chips(MOUTHS, L.mouth, 'mouth'));
    }
    row('Hat', chips(HATS, L.hat, 'hat'));

    const moods = mk('div', 'look-chips');
    for (const [k, [title]] of Object.entries(MOODS)) {
      const c = mk('button', 'chip' + (k === L.mood ? ' on' : ''), title); c.type = 'button';
      c.addEventListener('click', () => { save({ mood: k }); moods.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c)); });
      moods.appendChild(c);
    }
    row('Personality', moods);
    const custom = mk('textarea', 'look-custom'); custom.rows = 2; custom.maxLength = 300; custom.value = L.custom;
    custom.placeholder = 'In your own words (optional), like “talk like a pirate” or “always answer in Swedish”';
    custom.addEventListener('input', () => save({ custom: custom.value }));
    box.appendChild(custom);

    const reset = mk('button', 'link left', 'Back to the classic Buddy'); reset.type = 'button';
    reset.addEventListener('click', () => { try { localStorage.removeItem('look'); } catch {} apply(); render(box); });
    box.appendChild(reset);
    apply();
  }

  return { get, name, color, persona, dress, apply, render };
})();
