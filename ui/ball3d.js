/* The Stupid Buddy in 3D (buddy3d.js, the same character as in The Stupid Browser and The Stupid Mail) on the
 * desktop ball and in the Settings preview. Buddy looks at your cursor anywhere on the screen, and when you circle
 * the cursor around Buddy it spins along. It only draws while something changes. Not on phones (battery), and
 * Settings can switch it back to the flat ball. */
'use strict';
const Ball3D = (() => {
  const HOSTS = '#ball, .look-preview';
  const HATS_3D = { tophat: 'tophat', cap: 'cap', crown: 'crown', headphones: 'headphones' };   // the rest stay emoji hats
  const views = new Map();   // element → its 3D Buddy
  // Buddy is drawn the same size as in the old 92 px window, inside a 120 px one: the margin is room for raised arms
  // and a squashed landing, so nothing gets cut off at the window's edge.
  const FIT = 92 / 120, Z = 2 * FIT;

  const on = () => !!window.Buddy3D && window.__platform !== 'android' && Look.get().three !== false && (window.__force3d || !matchMedia('(prefers-reduced-motion: reduce)').matches);   // __force3d: the Windows showcase test

  /** Called by Look.dress for every Buddy on the page. */
  function sync(el) {
    for (const [e, b] of views) if (!e.isConnected) { b.destroy(); views.delete(e); }   // a Settings preview that was rebuilt
    if (!el.matches || !el.matches(HOSTS)) return;
    let b3 = views.get(el);
    if (!on()) { if (b3) { b3.destroy(); views.delete(el); el.classList.remove('b3d', 'b3d-hat'); } return; }
    if (!b3) {
      b3 = window.Buddy3D.create(el, { interactive: false, zoom: el.id === 'ball' ? Z : 2, aimY: 0.1 });
      if (!b3) return;
      views.set(el, b3); el.classList.add('b3d');
      b3.setVisible(true);
    }
    const L = Look.get();
    const hat = HATS_3D[L.hat] || 'none';
    b3.setLook({ shape: L.shape, color: Look.color(), hat, glasses: 'none' });
    // Room for everything inside the window: a hat needs space above, and hard bumps squash Buddy wider.
    const fit = el.id === 'ball' ? FIT : 1;   // the Settings preview has no extra room around it
    // An emoji hat (sun hat, flower, bow…) sits on top as a picture: it needs the same room above as a 3D one.
    if (L.hat !== 'none') b3.setFraming(1.62 * fit, 0.5); else b3.setFraming(2 * fit, 0.1);
    el.classList.toggle('b3d-hat', hat !== 'none');   // the 3D Buddy wears it; hide the emoji one
  }
  /** Buddy's mood from app.js (happy, think, work, sleepy…). */
  function state(s) {
    for (const b3 of views.values()) {
      if (/happy/.test(s)) b3.setState({ happy: true });
      b3.setState({ busy: /think|work/.test(s), sleepy: /sleepy/.test(s) });
    }
  }
  /** Picked up (surprised eyes) or let go. */
  function held(yes) { const b3 = views.get(document.getElementById('ball')); if (b3) b3.setState({ held: yes }); }
  /** Thrown and rolling: turn along with the speed (the flat ball rotates as a picture instead). */
  function roll(vx) { const b3 = views.get(document.getElementById('ball')); if (b3 && Math.abs(vx) > 30) b3.spinBy(vx / 60 / 36 * 0.35); }
  function visible(el, yes) { const b3 = views.get(el); if (b3) b3.setVisible(yes); }
  function land(impact) { const b3 = views.get(document.getElementById('ball')); if (b3) b3.land(Math.min(1, impact / 2500)); }

  // The cursor, from the app (anywhere on the screen): dx, dy from Buddy's middle, in screen points (y down).
  let lastAngle = null, lastT = 0;
  function cursor(dx, dy) {
    const b3 = views.get(document.getElementById('ball'));
    if (!b3) return;
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    b3.lookAt(clamp(dx / 320), clamp(dy / 320));
    // Circle the cursor around Buddy and it spins along (only close by, and only for steady circling).
    const dist = Math.hypot(dx, dy), now = performance.now(), angle = Math.atan2(dy, dx);
    if (dist > 40 && dist < 300 && lastAngle !== null && now - lastT < 200) {
      let d = angle - lastAngle;
      if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) < 0.8) b3.spinBy(d);
    }
    lastAngle = dist > 40 && dist < 300 ? angle : null; lastT = now;
  }

  addEventListener('DOMContentLoaded', () => { Look.apply(); });   // buddy3d.js (a module) has loaded by now
  return { sync, state, visible, land, cursor, held, roll, available: () => !!window.Buddy3D && window.__platform !== 'android' };
})();
