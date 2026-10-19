// 3D AI buddy (three.js, in ui/vendor). Shared with The Stupid Browser and The Stupid Mail; this copy adds
// zoom (framing for a small window) and spin() (The Stupid Buddy spins along when you circle the cursor around it).
// An original glossy toy robot: head (several shapes),
// a little floating body and hands, glowing eyes, hats and glasses. Interactive: follows the pointer,
// drag to spin, click to poke. Only renders while visible, and at ~30 fps when nothing is happening.
import * as THREE from './vendor/three.module.min.js';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';

const COLORS = { cream: '#EBC39D', clay: '#D97757', sky: '#4F8DE0', mint: '#3FB98A', grape: '#8A5CD6', rose: '#E0607E', sun: '#E9A23B', night: '#3B3F58', snow: '#D9DCE3', cocoa: '#8B5E45', olive: '#6E7B4E' };
// The browser's eye logo, drawn once as a jacket patch.
function logoPatch() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  g.fillStyle = '#F5F1E8'; g.beginPath(); g.arc(64, 64, 62, 0, 7); g.fill();
  g.fillStyle = '#D97757'; g.beginPath(); g.arc(64, 64, 48, 0, 7); g.fill();
  g.fillStyle = '#F5F1E8'; g.beginPath(); g.arc(64, 64, 36, 0, 7); g.fill();
  g.fillStyle = '#D97757'; g.beginPath(); g.arc(64, 64, 24, 0, 7); g.fill();
  g.fillStyle = '#3D3929'; g.beginPath(); g.arc(70, 56, 7, 0, 7); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const GLOWS = { cyan: '#7CF5FF', green: '#7CFF9E', pink: '#FF8AD8', amber: '#FFC86B', white: '#FFFFFF', violet: '#B79CFF' };
const hex = (v, map, d) => map[v] || (/^#[0-9a-f]{6}$/i.test(v || '') ? v : map[d]);

function radialTexture(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, inner); gr.addColorStop(1, outer); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function starShape(r1, r2, n) {
  const s = new THREE.Shape();
  for (let i = 0; i <= n * 2; i++) { const r = i % 2 ? r2 : r1, a = (i / (n * 2)) * Math.PI * 2 + Math.PI / 2; const x = Math.cos(a) * r, y = Math.sin(a) * r; if (i) s.lineTo(x, y); else s.moveTo(x, y); }
  return s;
}
function heartShape(r) {
  const s = new THREE.Shape(); const k = r / 1.2;
  s.moveTo(0, -0.9 * k); s.bezierCurveTo(-1.4 * k, 0.1 * k, -0.6 * k, 1.05 * k, 0, 0.45 * k); s.bezierCurveTo(0.6 * k, 1.05 * k, 1.4 * k, 0.1 * k, 0, -0.9 * k);
  return s;
}

export function createBuddy(container, { interactive = true, onClick = null, zoom = 1, aimY = 0.28 } = {}) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' }); } catch { return null; }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);
  const canvas = renderer.domElement; canvas.className = 'b3d-canvas';

  const scene = new THREE.Scene();
  // Its own reflection map: a texture belongs to one WebGL context, so a shared one left every Buddy after the first unlit.
  const pm = new THREE.PMREMGenerator(renderer); const envTexture = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose();
  scene.environment = envTexture;
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(2, 3, 4); scene.add(key);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.6));
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50); camera.position.set(0, 0.5 / zoom, 8.4 / zoom); camera.lookAt(0, aimY, 0);

  // ---- materials (recolored by setLook)
  const bodyMat = new THREE.MeshPhysicalMaterial({ color: 0xd97757, roughness: 0.32, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.15 });
  const darkMat = new THREE.MeshPhysicalMaterial({ color: 0x0c1018, roughness: 0.12, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 });
  const glowMat = new THREE.MeshBasicMaterial({ color: 0x7cf5ff, toneMapped: false });
  const accentMat = new THREE.MeshPhysicalMaterial({ color: 0x222222, roughness: 0.4, clearcoat: 0.6 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, metalness: 1, roughness: 0.25 });
  const lensMat = new THREE.MeshPhysicalMaterial({ color: 0x111111, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.85, clearcoat: 1 });
  const photoMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  // hiker (cute climber) materials
  const outfitMat = new THREE.MeshStandardMaterial({ color: 0xe0603a, roughness: 0.85 });
  const packMat = new THREE.MeshStandardMaterial({ color: 0x6b5a3e, roughness: 0.9 });
  const faceMat = new THREE.MeshBasicMaterial({ color: 0x2a221c });
  const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const eyeDotMat = new THREE.MeshPhysicalMaterial({ color: 0x3b3426, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.2 });
  const blushMat = new THREE.MeshBasicMaterial({ color: 0xff8a8a, transparent: true, opacity: 0.45, depthWrite: false });
  const pantsMat = new THREE.MeshStandardMaterial({ color: 0x3d3929, roughness: 0.85 });
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x6b4630, roughness: 0.7 });
  const soleMat = new THREE.MeshStandardMaterial({ color: 0x2a221c, roughness: 0.9 });
  const scarfColor = 0xc9963f;

  // ---- rig: root (spin) > floater (bob) > head + body + hands
  const root = new THREE.Group(); scene.add(root);
  const floater = new THREE.Group(); root.add(floater);
  const head = new THREE.Group(); head.position.y = 0.55; floater.add(head);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.28, 8, 24), bodyMat); torso.position.y = -0.75; floater.add(torso);
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 14), glowMat); belly.scale.set(1, 1, 0.35); belly.position.set(0, -0.7, 0.43); floater.add(belly);
  const handGeo = new THREE.SphereGeometry(0.17, 20, 14);
  const handL = new THREE.Mesh(handGeo, bodyMat), handR = new THREE.Mesh(handGeo, bodyMat);
  handL.position.set(-0.72, -0.72, 0.1); handR.position.set(0.72, -0.72, 0.1); floater.add(handL, handR);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.6), new THREE.MeshBasicMaterial({ map: radialTexture('rgba(0,0,0,0.55)', 'rgba(0,0,0,0)'), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = -1.45; scene.add(shadow);

  let shell = null, parts = null, hatObj = null, glassesObj = null, face = null;
  const look = { shape: 'ball', hat: 'none', glasses: 'none', color: 'clay', glow: 'cyan', image: '', eyes: 'dot', mouth: 'smile', outfit: 'clay', backpack: true, scarf: true };

  // Head shapes: each returns the head mesh and where its face is.
  function buildShell(shape) {
    if (shell) { head.remove(shell); shell.traverse((o) => o.geometry && o.geometry.dispose()); }
    let geo, front = 0.95, w = 1, top = 0.92;
    if (shape === 'cube') { geo = new RoundedBoxGeometry(1.95, 1.65, 1.6, 6, 0.42); front = 0.8; top = 0.83; w = 0.97; }
    else if (shape === 'capsule') { geo = new THREE.CapsuleGeometry(0.72, 0.62, 12, 32); geo.rotateZ(Math.PI / 2); front = 0.72; top = 0.72; w = 1.05; }
    else if (shape === 'egg') { geo = new THREE.SphereGeometry(1, 48, 32); geo.scale(0.88, 1.08, 0.88); front = 0.88; top = 1.08; w = 0.9; }
    else if (shape === 'tv') { geo = new RoundedBoxGeometry(2.15, 1.5, 1.25, 4, 0.2); front = 0.63; top = 0.75; w = 1.05; }
    else if (shape === 'ball') {   // the little ball from the welcome screen: just a round body with two eyes
      geo = new THREE.SphereGeometry(0.95, 48, 32);
      shell = new THREE.Mesh(geo, bodyMat); head.add(shell);
      return { front: 0.95, w: 0.95, top: 0.95, eyeY: 0.1, kind: 'ball' };
    }
    else if (shape === 'eye') {   // The Stupid Company's eye logo: a ring in Buddy's colour, a pupil (see eyeFace) and a little dark dot
      shell = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.15, 24, 72), bodyMat); head.add(shell);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16), eyeDotMat); dot.position.set(0.57, 0.57, 0.06); shell.add(dot);
      return { front: 0.15, w: 0.72, top: 0.87, eyeY: 0, kind: 'eye' };
    }
    else if (shape === 'hiker') {   // one chubby bean: head and body together
      geo = new THREE.CapsuleGeometry(0.8, 0.8, 16, 40); geo.scale(1, 1, 0.92);
      shell = new THREE.Mesh(geo, bodyMat); head.add(shell);
      return { front: 0.74, w: 0.82, top: 1.2, eyeY: 0.4, kind: 'hiker' };
    }
    else { geo = new THREE.SphereGeometry(1, 48, 32); geo.scale(1.02, 0.92, 0.95); }
    shell = new THREE.Mesh(geo, bodyMat); head.add(shell);
    return { front, w, top, eyeY: 0.04 };
  }
  // Hiker face: simple dark dot eyes and a little mouth, in several styles (like a character creator).
  function hikerFace(dim) {
    const g = new THREE.Group(); g.position.set(0, dim.eyeY, dim.front);
    const E = look.eyes || 'dot', M = look.mouth || 'smile';
    const eyes = [-0.24, 0.24].map((x) => {
      const e = new THREE.Group(); e.position.set(x, 0, 0.02);
      if (E === 'wide') { const w = new THREE.Mesh(new THREE.CircleGeometry(0.13, 28), whiteMat); const p = new THREE.Mesh(new THREE.CircleGeometry(0.07, 24), faceMat); p.position.z = 0.002; e.add(w, p); }
      else if (E === 'sleepy') { const l = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.14, 4, 8), faceMat); l.rotation.z = Math.PI / 2; e.add(l); }
      else {
        const r = E === 'round' ? 0.1 : 0.072;
        const d = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), faceMat); d.scale.z = 0.4; e.add(d);
        if (E === 'round') { const hi = new THREE.Mesh(new THREE.CircleGeometry(0.03, 12), whiteMat); hi.position.set(0.03, 0.035, r * 0.45); e.add(hi); }
        if (E === 'lash') { const lash = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.08, 3, 6), faceMat); lash.rotation.z = Math.sign(x) * 0.9; lash.position.set(Math.sign(x) * 0.085, 0.055, 0.01); e.add(lash); }
      }
      g.add(e); return e;
    });
    const happyGeo = new THREE.TorusGeometry(0.075, 0.022, 8, 20, Math.PI);
    const happy = [-0.24, 0.24].map((x) => { const h = new THREE.Mesh(happyGeo, faceMat); h.position.set(x, -0.02, 0.03); h.visible = false; g.add(h); return h; });
    let mouth;
    if (M === 'grin') { mouth = new THREE.Group(); const m1 = new THREE.Mesh(new THREE.CircleGeometry(0.11, 24, Math.PI, Math.PI), faceMat); const t = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.03), whiteMat); t.position.set(0, -0.015, 0.002); mouth.add(m1, t); }
    else if (M === 'flat') { mouth = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.1, 4, 8), faceMat); mouth.rotation.z = Math.PI / 2; }
    else if (M === 'open') { mouth = new THREE.Mesh(new THREE.CircleGeometry(0.06, 24), faceMat); mouth.scale.y = 1.2; }
    else if (M === 'cat') { mouth = new THREE.Group(); for (const sx of [-1, 1]) { const a = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.016, 6, 14, Math.PI), faceMat); a.rotation.z = Math.PI; a.position.x = sx * 0.045; mouth.add(a); } }
    else { mouth = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.02, 8, 20, Math.PI), faceMat); mouth.rotation.z = Math.PI; }
    mouth.position.set(0, -0.2, 0.03); g.add(mouth);
    for (const sx of [-1, 1]) { const b = new THREE.Mesh(new THREE.CircleGeometry(0.09, 20), blushMat); b.scale.y = 0.6; b.position.set(sx * 0.4, -0.12, 0.0); g.add(b); }
    const photo = new THREE.Mesh(new THREE.CircleGeometry(0.42, 40), photoMat); photo.position.z = 0.05; photo.visible = false; g.add(photo);
    // The face sits on a curved body: tilt each feature to follow the surface.
    g.children.forEach((c) => { c.position.z += -Math.abs(c.position.x) * 0.35; c.rotation.y = c.position.x * 0.6; });
    g.scale.setScalar(1.35);   // bigger, friendlier face
    head.add(g);
    face = { group: g, eyes, happy, mouth, photo, eyeBase: eyes.map((e) => e.position.clone()), hiker: true };
  }
  function buildFace(dim) {
    if (face) { head.remove(face.group); face.group.traverse((o) => o.geometry && o.geometry.dispose()); }
    if (dim.kind === 'hiker') return hikerFace(dim);
    if (dim.kind === 'ball') return ballFace(dim);
    if (dim.kind === 'eye') return eyeFace();
    const g = new THREE.Group(); g.position.z = dim.front - 0.18;
    const visor = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), darkMat); visor.scale.set(0.74 * dim.w, 0.46, 0.3); g.add(visor);
    const photo = new THREE.Mesh(new THREE.CircleGeometry(0.42, 40), photoMat); photo.position.z = 0.31; photo.visible = false; g.add(photo);
    const eyeGeo = new THREE.CapsuleGeometry(0.085, 0.13, 6, 16);
    const eyes = [-0.27, 0.27].map((x) => { const e = new THREE.Mesh(eyeGeo, glowMat); e.position.set(x, 0.04, 0.29); g.add(e); return e; });
    const happyGeo = new THREE.TorusGeometry(0.11, 0.035, 8, 20, Math.PI);
    const happy = [-0.27, 0.27].map((x) => { const e = new THREE.Mesh(happyGeo, glowMat); e.position.set(x, 0.02, 0.3); e.visible = false; g.add(e); return e; });
    const mouth = new THREE.Mesh(new THREE.CapsuleGeometry(0.025, 0.12, 4, 8), glowMat); mouth.rotation.z = Math.PI / 2; mouth.position.set(0, -0.2, 0.28); g.add(mouth);
    head.add(g);
    face = { group: g, eyes, happy, mouth, photo, eyeBase: eyes.map((e) => e.position.clone()) };
  }
  // Ball face: two tall white eyes, like the welcome screen's Buddy (no mouth; happy eyes curve up).
  function ballFace(dim) {
    // Two tall eyes like the welcome screen's Buddy: clean pills lying on the ball (facing out along its surface, so
    // the ball never cuts into them), pure white that the lighting can't grey out, shaded a touch cooler toward the
    // bottom so they read as rounded, with a soft shadow just under each. Happy eyes are smooth arcs.
    const g = new THREE.Group();
    const R = dim.front, Y = dim.eyeY;
    const eyeGeo = new THREE.CapsuleGeometry(0.112, 0.2, 12, 32);
    const pos = eyeGeo.attributes.position, colors = [];
    for (let i = 0; i < pos.count; i++) { const k = Math.min(1, Math.max(0, (0.21 - pos.getY(i)) / 0.42)); colors.push(1 - k * 0.07, 1 - k * 0.06, 1 - k * 0.02); }
    eyeGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const eyeMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    const shadeMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.17, depthWrite: false });
    const onBall = (m, x, y, lift) => {   // on the surface at (x, y), facing out
      const n = new THREE.Vector3(x, y, Math.sqrt(Math.max(0, R * R - x * x - y * y))).normalize();
      m.position.copy(n.clone().multiplyScalar(R + lift)); m.lookAt(n.clone().multiplyScalar(R * 3)); return m;
    };
    const eyes = [-0.27, 0.27].map((x) => {
      const e = onBall(new THREE.Mesh(eyeGeo, eyeMat), x, Y, 0.012); e.scale.z = 0.3;
      const shade = new THREE.Mesh(eyeGeo, shadeMat); shade.position.set(0, -0.022, -0.03); shade.scale.set(1.14, 1.06, 0.6); e.add(shade);
      g.add(e); return e;
    });
    const happyGeo = new THREE.TorusGeometry(0.11, 0.04, 12, 32, Math.PI);
    const happyMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const happy = [-0.27, 0.27].map((x) => { const e = onBall(new THREE.Mesh(happyGeo, happyMat), x, Y - 0.03, 0.03); e.visible = false; g.add(e); return e; });
    const mouth = new THREE.Group(); mouth.position.set(0, Y - 0.35, Math.sqrt(R * R - (Y - 0.35) ** 2)); g.add(mouth);   // keeps the talking animation happy
    const photo = new THREE.Mesh(new THREE.CircleGeometry(0.42, 40), photoMat); photo.position.z = R + 0.01; photo.visible = false; g.add(photo);
    head.add(g);
    face = { group: g, eyes, happy, mouth, photo, eyeBase: eyes.map((e) => e.position.clone()) };
  }
  // Eye face: the logo's pupil, which follows the mouse and blinks; a smiling arc when happy.
  function eyeFace() {
    const g = new THREE.Group();
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.25, 32, 20), bodyMat); pupil.scale.z = 0.6; pupil.position.z = 0.04; g.add(pupil);
    const happy = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.07, 8, 20, Math.PI), bodyMat); happy.position.z = 0.04; happy.visible = false; g.add(happy);
    const mouth = new THREE.Group(); g.add(mouth);   // keeps the talking animation happy
    const photo = new THREE.Mesh(new THREE.CircleGeometry(0.55, 40), photoMat); photo.position.z = 0.2; photo.visible = false; g.add(photo);
    head.add(g);
    face = { group: g, eyes: [pupil], happy: [happy], mouth, photo, eyeBase: [pupil.position.clone()] };
  }
  // Hiker gear: jacket, sleeves with mitten hands, scarf and backpack (each optional).
  function hikerParts() {
    const P = new THREE.Group();
    const jacket = new THREE.Mesh(new THREE.CylinderGeometry(0.815, 0.82, 0.62, 40, 1, true), outfitMat); jacket.position.y = -0.62; jacket.scale.z = 0.93; P.add(jacket);
    const hem = new THREE.Mesh(new THREE.SphereGeometry(0.82, 40, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), outfitMat); hem.position.y = -0.4; hem.scale.z = 0.93; P.add(hem);
    const zip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.6, 0.02), packMat); zip.position.set(0, -0.6, 0.77); P.add(zip);
    const arms = [-1, 1].map((sx) => {
      const pivot = new THREE.Group(); pivot.position.set(sx * 0.72, -0.25, 0);
      const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.38, 6, 14), outfitMat); sleeve.position.set(sx * 0.12, -0.25, 0); sleeve.rotation.z = sx * 0.35;
      const mitt = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), bodyMat); mitt.position.set(sx * 0.24, -0.55, 0.02);
      pivot.add(sleeve, mitt); P.add(pivot); return pivot;
    });
    P.userData.armR = arms[1]; P.userData.armL = arms[0];
    // short legs with hiking boots
    const legs = [-1, 1].map((sx) => {
      const pivot = new THREE.Group(); pivot.position.set(sx * 0.32, -1.0, 0);
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.22, 6, 14), pantsMat); leg.position.y = -0.22;
      const boot = new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.22, 0.5, 3, 0.09), bootMat); boot.position.set(0, -0.5, 0.08);
      const sole = new THREE.Mesh(new RoundedBoxGeometry(0.38, 0.07, 0.52, 2, 0.03), soleMat); sole.position.set(0, -0.6, 0.08);
      const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.045, 8, 20), new THREE.MeshStandardMaterial({ color: 0xf5f1e8, roughness: 0.9 })); cuff.rotation.x = Math.PI / 2; cuff.position.y = -0.4;
      pivot.add(leg, boot, sole, cuff); P.add(pivot); return pivot;
    });
    P.userData.legL = legs[0]; P.userData.legR = legs[1];
    // the browser's logo as a patch on the jacket
    const patch = new THREE.Mesh(new THREE.CircleGeometry(0.15, 32), new THREE.MeshBasicMaterial({ map: logoPatch() }));
    patch.position.set(-0.32, -0.5, 0.71); patch.rotation.y = -0.42; P.add(patch);
    // a silly hair curl (hidden under hats)
    const curl = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.035, 8, 24, Math.PI * 1.5), new THREE.MeshStandardMaterial({ color: 0x8b5e45, roughness: 0.6 }));
    curl.position.set(0.05, 1.27, 0.1); curl.rotation.set(0.2, 0.4, 0.6); P.add(curl); P.userData.curl = curl;
    if (look.scarf !== false) {
      const scarfMat = new THREE.MeshStandardMaterial({ color: scarfColor, roughness: 0.9 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.13, 12, 40), scarfMat); ring.rotation.x = Math.PI / 2; ring.position.y = -0.08; ring.scale.set(1, 0.93, 1); P.add(ring);
      const tail = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.5, 0.08, 2, 0.04), scarfMat); tail.position.set(0.32, -0.38, 0.74); tail.rotation.z = 0.15; P.add(tail);
      P.userData.scarfMat = scarfMat;
    }
    if (look.backpack !== false) {
      const pack = new THREE.Mesh(new RoundedBoxGeometry(1.0, 1.05, 0.5, 4, 0.16), packMat); pack.position.set(0, -0.35, -0.86); P.add(pack);
      const flap = new THREE.Mesh(new RoundedBoxGeometry(1.02, 0.35, 0.54, 3, 0.12), outfitMat); flap.position.set(0, 0.08, -0.86); P.add(flap);
      const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.9, 16), new THREE.MeshStandardMaterial({ color: 0x4f7a5a, roughness: 0.9 })); roll.rotation.z = Math.PI / 2; roll.position.set(0, -0.9, -0.9); P.add(roll);
      for (const sx of [-1, 1]) { const strap = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.04, 6, 20, Math.PI * 0.9), packMat); strap.rotation.y = Math.PI / 2; strap.position.set(sx * 0.42, -0.3, -0.05); P.add(strap); }
    }
    head.add(P); parts = P;
  }
  function buildParts(dim, shape) {
    if (parts) { head.remove(parts); parts.traverse((o) => o.geometry && o.geometry.dispose()); }
    if (shape === 'hiker') return hikerParts();
    if (shape === 'ball' || shape === 'eye') { parts = new THREE.Group(); head.add(parts); return; }   // no antenna, ears or body
    parts = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.38, 10), accentMat); stem.position.y = dim.top + 0.17; parts.add(stem);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), glowMat); bulb.position.y = dim.top + 0.4; parts.add(bulb); parts.userData.bulb = bulb; parts.userData.stem = stem;
    if (shape !== 'tv') {
      const earGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.18, 24); earGeo.rotateZ(Math.PI / 2);
      for (const sx of [-1, 1]) { const ear = new THREE.Mesh(earGeo, bodyMat); ear.position.set(sx * (dim.w * 1.0 + 0.02), 0, -0.05); parts.add(ear); }
    } else {
      for (const sx of [-1, 1]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 8), accentMat); leg.position.set(sx * 0.35, dim.top + 0.18, -0.2); leg.rotation.z = -sx * 0.5; parts.add(leg); }
      stem.visible = false; bulb.visible = false;
    }
    head.add(parts);
  }
  function buildHat(kind, dim) {
    if (hatObj) { head.remove(hatObj); hatObj.traverse((o) => o.geometry && o.geometry.dispose()); hatObj = null; }
    if (parts && parts.userData.curl) parts.userData.curl.visible = true;
    if (!kind || kind === 'none') return;
    const g = new THREE.Group(); const y = dim.top;
    const m = (geo, mat, x = 0, yy = 0, z = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, yy, z); g.add(o); return o; };
    if (kind === 'tophat') { m(new THREE.CylinderGeometry(0.85, 0.85, 0.06, 40), accentMat, 0, y - 0.02); m(new THREE.CylinderGeometry(0.5, 0.52, 0.75, 40), accentMat, 0, y + 0.36); m(new THREE.CylinderGeometry(0.525, 0.525, 0.14, 40), new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.5 }), 0, y + 0.08); }
    else if (kind === 'cap') { const dome = m(new THREE.SphereGeometry(0.72, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshPhysicalMaterial({ color: 0x2f6fde, roughness: 0.6 }), 0, y - 0.18); dome.scale.set(1.05, 0.85, 1.05); const brim = m(new THREE.CylinderGeometry(0.55, 0.55, 0.05, 32, 1, false, -Math.PI / 2, Math.PI), dome.material, 0, y - 0.16, 0.55); brim.rotation.x = 0.12; }
    else if (kind === 'beanie') { const wool = new THREE.MeshStandardMaterial({ color: 0xe0607e, roughness: 0.9 }); const d = m(new THREE.SphereGeometry(0.78, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), wool, 0, y - 0.25); d.scale.set(1.05, 0.95, 1.05); const cuff = m(new THREE.TorusGeometry(0.8, 0.12, 12, 40), wool, 0, y - 0.22); cuff.rotation.x = Math.PI / 2; m(new THREE.SphereGeometry(0.17, 16, 12), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }), 0, y + 0.55); }
    else if (kind === 'crown') { m(new THREE.CylinderGeometry(0.55, 0.55, 0.22, 32, 1, true), goldMat, 0, y + 0.06); for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; m(new THREE.ConeGeometry(0.1, 0.28, 12), goldMat, Math.cos(a) * 0.52, y + 0.3, Math.sin(a) * 0.52); m(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshStandardMaterial({ color: [0xe74c3c, 0x3498db, 0x2ecc71][i % 3], roughness: 0.2 }), Math.cos(a) * 0.56, y + 0.06, Math.sin(a) * 0.56); } }
    else if (kind === 'party') { const c = m(new THREE.ConeGeometry(0.42, 0.95, 32), new THREE.MeshStandardMaterial({ color: 0x9b59b6, roughness: 0.5 }), 0.15, y + 0.4); c.rotation.z = -0.25; m(new THREE.SphereGeometry(0.11, 12, 10), goldMat, 0.27, y + 0.88); }
    else if (kind === 'cowboy') { const leather = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.8 }); const brim = m(new THREE.TorusGeometry(0.7, 0.18, 12, 40), leather, 0, y + 0.02); brim.rotation.x = Math.PI / 2; brim.scale.set(1.15, 1, 0.5); m(new THREE.CylinderGeometry(0.42, 0.52, 0.5, 32), leather, 0, y + 0.25); }
    else if (kind === 'headphones') { const band = m(new THREE.TorusGeometry(dim.w * 1.05, 0.06, 10, 40, Math.PI), accentMat, 0, 0.05); band.position.y = 0.05; for (const sx of [-1, 1]) { const cup = m(new THREE.CylinderGeometry(0.3, 0.3, 0.22, 28), accentMat, sx * (dim.w * 1.05 + 0.05), 0, 0); cup.rotation.z = Math.PI / 2; m(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 24), glowMat, sx * (dim.w * 1.05 + 0.17), 0, 0).rotation.z = Math.PI / 2; } }
    else if (kind === 'halo') { const h = m(new THREE.TorusGeometry(0.55, 0.05, 12, 48), new THREE.MeshBasicMaterial({ color: 0xfff2a8, toneMapped: false }), 0, y + 0.55); h.rotation.x = Math.PI / 2 - 0.25; g.userData.halo = h; }
    head.add(g); hatObj = g;
    if (parts && parts.userData.curl) parts.userData.curl.visible = !kind || kind === 'none' || kind === 'halo' || kind === 'headphones';
    if (parts && parts.userData.stem) { const hidesAntenna = !['headphones', 'halo', 'none'].includes(kind); parts.userData.stem.visible = parts.userData.bulb.visible = !hidesAntenna && look.shape !== 'tv'; }
  }
  function buildGlasses(kind, dim) {
    if (glassesObj) { head.remove(glassesObj); glassesObj.traverse((o) => o.geometry && o.geometry.dispose()); glassesObj = null; }
    if (!kind || kind === 'none') return;
    const g = new THREE.Group(); g.position.set(0, dim.eyeY != null ? dim.eyeY : 0.04, dim.front + (dim.kind === 'hiker' ? 0.04 : 0.06));
    const frame = new THREE.MeshStandardMaterial({ color: kind === 'star' ? 0xffd23f : kind === 'heart' ? 0xff4f8b : kind === 'round' ? 0xd4af37 : 0xf4f4f4, roughness: 0.3, metalness: kind === 'round' ? 0.9 : 0.1 });
    for (const sx of [-1, 1]) {
      let rim, lens;
      if (kind === 'round') { rim = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 10, 32), frame); lens = new THREE.Mesh(new THREE.CircleGeometry(0.2, 32), new THREE.MeshPhysicalMaterial({ color: 0xaaddff, transparent: true, opacity: 0.18, roughness: 0 })); }
      else if (kind === 'square') { const s = new THREE.Shape(); s.moveTo(-0.22, -0.16); s.lineTo(0.22, -0.16); s.lineTo(0.22, 0.16); s.lineTo(-0.22, 0.16); s.lineTo(-0.22, -0.16); const hole = new THREE.Path(); hole.moveTo(-0.18, -0.12); hole.lineTo(0.18, -0.12); hole.lineTo(0.18, 0.12); hole.lineTo(-0.18, 0.12); hole.lineTo(-0.18, -0.12); s.holes.push(hole); rim = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.05, bevelEnabled: false }), frame); }
      else if (kind === 'shades') { rim = new THREE.Mesh(new THREE.ExtrudeGeometry((() => { const s = new THREE.Shape(); s.moveTo(-0.25, 0.12); s.lineTo(0.25, 0.12); s.quadraticCurveTo(0.24, -0.18, 0, -0.17); s.quadraticCurveTo(-0.24, -0.18, -0.25, 0.12); return s; })(), { depth: 0.05, bevelEnabled: false }), lensMat); }
      else if (kind === 'star') { rim = new THREE.Mesh(new THREE.ExtrudeGeometry(starShape(0.26, 0.12, 5), { depth: 0.05, bevelEnabled: false }), frame); }
      else if (kind === 'heart') { rim = new THREE.Mesh(new THREE.ExtrudeGeometry(heartShape(0.26), { depth: 0.05, bevelEnabled: false }), frame); rim.position.y = -0.02; }
      if (!rim) continue;
      rim.position.x += sx * 0.29; g.add(rim);
      if (lens) { lens.position.set(sx * 0.29, 0, 0.005); g.add(lens); }
    }
    const bridge = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 8), frame); bridge.rotation.z = Math.PI / 2; bridge.position.set(0, 0.04, 0.02); g.add(bridge);
    head.add(g); glassesObj = g;
  }

  function setLook(l) {
    const next = Object.assign({}, look, l || {});
    const shapeChanged = !shell || next.shape !== look.shape;
    const faceChanged = next.shape === 'hiker' && ['eyes', 'mouth', 'backpack', 'scarf'].some((k) => next[k] !== look[k]);
    Object.assign(look, next);
    const hiker = look.shape === 'hiker', ball = look.shape === 'ball' || look.shape === 'eye';
    head.position.y = hiker ? 0.22 : ball ? 0.05 : 0.55;
    torso.visible = belly.visible = handL.visible = handR.visible = !hiker && !ball;
    outfitMat.color.set(hex(look.outfit, COLORS, 'clay'));
    bodyMat.color.set(hex(look.color, COLORS, 'clay'));
    // The studio light (scene.environment) is made for the hiker; on a round ball or the Eye it washes out the colour and the white eyes.
    scene.environmentIntensity = ball ? 0.3 : 1; bodyMat.clearcoat = ball ? 0.5 : 1;
    glowMat.color.set(hex(look.glow, GLOWS, 'cyan'));
    let dim = head.userData.dim;
    if (shapeChanged) { dim = buildShell(look.shape); head.userData.dim = dim; }
    if (shapeChanged || faceChanged) { buildFace(dim); buildParts(dim, look.shape); }
    buildHat(look.hat, dim); buildGlasses(look.glasses, dim);
    const img = /^data:image\/(png|jpeg|webp);base64,/.test(look.image || '') ? look.image : '';
    face.photo.visible = !!img; face.eyes.concat(face.happy, [face.mouth]).forEach((e) => { e.userData.hideForPhoto = !!img; });
    if (img) new THREE.TextureLoader().load(img, (t) => { t.colorSpace = THREE.SRGBColorSpace; photoMat.map = t; photoMat.needsUpdate = true; kick(); });
    kick();
  }

  // ---- behaviour state
  const st = { busy: false, talking: false, happyUntil: 0, sleepy: false, held: false, walking: false, dizzyUntil: 0 };
  let squash = 0;
  // dizzy: stars circling the head
  const stars = new THREE.Group(); stars.visible = false; head.add(stars);
  for (let i = 0; i < 3; i++) { const sm = new THREE.Mesh(new THREE.ExtrudeGeometry(starShape(0.22, 0.09, 5), { depth: 0.05, bevelEnabled: false }), new THREE.MeshBasicMaterial({ color: 0xffd23f, toneMapped: false })); stars.add(sm); }
  function land(impact) { squash = Math.min(1, impact); if (impact > 0.75) st.dizzyUntil = performance.now() + 1800; kick(); }
  let target = { x: 0, y: 0 }, lastPointer = 0, spin = 0, spinVel = 0, hop = 0, hopVel = 0, wave = 0, nextBlink = 1.5, blinkT = -1, glance = { x: 0, y: 0, until: 0 };
  function lookAt(nx, ny) { target = { x: Math.max(-1, Math.min(1, nx)), y: Math.max(-1, Math.min(1, ny)) }; lastPointer = performance.now(); kick(); }
  /** Turn by this many radians (it keeps some speed and eases back to facing you). */
  function spinBy(rad) { spinVel += rad * 14; kick(); }
  function poke() { hopVel = 3.2; wave = 1; st.happyUntil = performance.now() + 1400; kick(); }
  function setState(s) { Object.assign(st, s || {}); if (s && s.happy) st.happyUntil = performance.now() + 1800; kick(); }

  // ---- drag to spin, click to poke
  if (interactive) {
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; drag = { x: e.clientX, last: e.clientX, t: performance.now(), moved: false }; try { canvas.setPointerCapture(e.pointerId); } catch {} e.stopPropagation(); kick(); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.last; drag.last = e.clientX;
      if (Math.abs(e.clientX - drag.x) > 4) drag.moved = true;
      if (drag.moved) { spin += dx * 0.03; spinVel = dx * 0.03 * 60; }
      kick();
    });
    const end = (e) => {
      if (!drag) return;
      const moved = drag.moved; drag = null;
      if (moved) { e.stopPropagation(); e.preventDefault(); canvas.dataset.dragged = '1'; setTimeout(() => delete canvas.dataset.dragged, 0); }
      else { poke(); if (onClick) onClick(); }
    };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', () => { drag = null; });
    canvas.addEventListener('dblclick', (e) => { e.stopPropagation(); spinVel = 14; kick(); });
  }

  // ---- render loop (paused when hidden)
  let raf = 0, visible = true, lastT = performance.now(), frame = 0, activeUntil = performance.now() + 2000, lastBusy = performance.now(), paused = false;
  function kick() { activeUntil = performance.now() + 2500; if (!raf && visible && !document.hidden && !paused) raf = requestAnimationFrame(tick); }
  // The browser can pause Buddy for a moment (e.g. while you scroll a page on a phone) so the page gets every frame.
  addEventListener('stupid-buddy-pause', (e) => { paused = !!e.detail; if (!paused) { lastBusy = performance.now(); kick(); } });
  function resize() {
    const w = container.clientWidth || 110, h = container.clientHeight || 120;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(() => { resize(); kick(); }); ro.observe(container);
  function tick(now) {
    raf = 0;
    if (!visible || document.hidden || paused) return;
    const busy = st.busy || st.talking || st.held || st.walking || squash > 0 || now < st.dizzyUntil || now < activeUntil || hopVel !== 0 || Math.abs(spinVel) > 0.01;
    raf = requestAnimationFrame(tick);
    if (busy) lastBusy = now;
    // idle: ~30 fps, then a calm ~12 fps after a while (the gentle float looks the same, the computer works far less)
    if (!busy && (++frame % (now - lastBusy > 6000 ? 5 : 2))) return;
    const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now; const t = now / 1000;
    // float + hop (with squash & stretch)
    if (hopVel || hop > 0) { hopVel -= 14 * dt; hop += hopVel * dt; if (hop <= 0) { hop = 0; hopVel = hopVel < -2.5 ? -hopVel * 0.35 : 0; } }
    const bob = Math.sin(t * 1.7) * 0.06;
    floater.position.y = bob + hop * 0.5;
    const stretch = 1 + Math.max(-0.08, Math.min(0.1, hopVel * 0.03));
    floater.scale.set(1 / Math.sqrt(stretch), stretch, 1 / Math.sqrt(stretch));
    shadow.scale.setScalar(1 - (bob + hop * 0.5) * 0.6); shadow.material.opacity = 0.9 - hop * 0.5;
    // spin with inertia, easing back to facing forward
    spin += spinVel * dt; spinVel *= Math.pow(0.04, dt);
    if (Math.abs(spinVel) < 0.3) spin += (Math.round(spin / (Math.PI * 2)) * Math.PI * 2 - spin) * Math.min(1, dt * 3);
    root.rotation.y = spin;
    // head follows pointer, or glances around when idle
    let gx = target.x, gy = target.y;
    if (now - lastPointer > 3000) { if (now > glance.until) glance = { x: (Math.random() * 2 - 1) * 0.7, y: (Math.random() * 2 - 1) * 0.35, until: now + 1500 + Math.random() * 2500 }; gx = glance.x; gy = glance.y; }
    if (st.busy) { gx = Math.sin(t * 3) * 0.6; gy = 0.35; }
    head.rotation.y += (gx * 0.55 - head.rotation.y) * Math.min(1, dt * 6);
    head.rotation.x += (-gy * 0.35 - head.rotation.x) * Math.min(1, dt * 6);
    head.rotation.z = Math.sin(t * 0.9) * 0.03;
    // eyes: look, blink, happy, sleepy
    const happyNow = now < st.happyUntil && !st.held;
    const dizzy = now < st.dizzyUntil;
    // landing squash, held dangle, walking legs
    if (squash > 0) { squash = Math.max(0, squash - dt * 3.2); const k = Math.sin(squash * Math.PI) * 0.28; floater.scale.set(1 + k * 0.6, 1 - k, 1 + k * 0.6); }
    if (parts && parts.userData.legL) {
      const L = parts.userData.legL, R = parts.userData.legR;
      if (st.held) { L.rotation.x = Math.sin(t * 13) * 0.7; R.rotation.x = -Math.sin(t * 13) * 0.7; }
      else if (st.walking) { L.rotation.x = Math.sin(t * 11) * 0.55; R.rotation.x = -Math.sin(t * 11) * 0.55; }
      else { L.rotation.x *= 0.8; R.rotation.x *= 0.8; }
      if (st.held && parts.userData.armR) { parts.userData.armR.rotation.z = 2.5 + Math.sin(t * 15) * 0.3; parts.userData.armL.rotation.z = -2.5 - Math.sin(t * 15 + 1) * 0.3; }
    }
    stars.visible = dizzy;
    if (dizzy) { const top = (head.userData.dim && head.userData.dim.top) || 1; stars.children.forEach((sm, i) => { const a = t * 4 + i * 2.1; sm.position.set(Math.cos(a) * 0.6, top + 0.25 + Math.sin(t * 6 + i) * 0.05, Math.sin(a) * 0.6); sm.rotation.y = a; }); }
    nextBlink -= dt; if (nextBlink <= 0 && blinkT < 0) { blinkT = 0; nextBlink = 2 + Math.random() * 3.5; }
    let lid = 1; if (blinkT >= 0) { blinkT += dt; lid = Math.abs(Math.cos(Math.min(1, blinkT / 0.16) * Math.PI)); if (blinkT > 0.16) blinkT = -1; }
    if (st.sleepy) lid = face.hiker ? 0.6 : 0.25;
    if (st.held) lid = 1.25;              // surprised!
    if (dizzy) lid = 0.15;
    face.eyes.forEach((e, i) => {
      e.visible = !happyNow && !e.userData.hideForPhoto;
      e.scale.y = Math.max(0.12, lid);
      e.position.x = face.eyeBase[i].x + gx * 0.08; e.position.y = face.eyeBase[i].y + gy * 0.05;
    });
    face.happy.forEach((e) => { e.visible = happyNow && !e.userData.hideForPhoto; });
    face.mouth.visible = !face.mouth.userData.hideForPhoto;
    face.mouth.scale.set(1, st.talking ? 1 + Math.abs(Math.sin(t * 18)) * 2.2 : happyNow ? 1.6 : 1, 1);
    // antenna pulse while thinking; belly breathes
    const bulb = parts && parts.userData.bulb; if (bulb) bulb.scale.setScalar(st.busy ? 1 + Math.abs(Math.sin(t * 6)) * 0.5 : 1);
    belly.scale.set(1 + Math.sin(t * 2) * 0.05, 1 + Math.sin(t * 2) * 0.05, 0.35);
    if (hatObj && hatObj.userData.halo) hatObj.userData.halo.rotation.z = t;
    // hands float, and wave when poked
    handL.position.y = -0.72 + Math.sin(t * 1.7 + 1) * 0.05; handR.position.y = -0.72 + Math.sin(t * 1.7 + 2) * 0.05;
    if (wave > 0) { wave -= dt * 0.8; handR.position.y = -0.3 + Math.sin(t * 16) * 0.12; handR.position.x = 0.8; } else handR.position.x = 0.72;
    if (parts && parts.userData.armR && !st.held) {   // hiker: wave the right arm, swing gently otherwise
      parts.userData.armR.rotation.z = wave > 0 ? 2.3 + Math.sin(t * 14) * 0.35 : Math.sin(t * 1.7) * 0.06;
      parts.userData.armL.rotation.z = -Math.sin(t * 1.7 + 1) * 0.06;
    }
    renderer.render(scene, camera);
  }
  function setVisible(v) { visible = !!v; if (visible) { resize(); kick(); } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  function destroy() {
    envTexture.dispose();
    cancelAnimationFrame(raf); raf = 0; visible = false; ro.disconnect();
    scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    renderer.dispose(); canvas.remove();
  }
  // A still picture of the character as it looks right now (used for the little face in the chat header).
  function snapshot() { if (!canvas.width || !canvas.height) return ''; renderer.render(scene, camera); return canvas.toDataURL('image/png'); }
  resize(); setLook({}); kick();
  return { setLook, setState, lookAt, poke, setVisible, destroy, canvas, land, snapshot, spinBy };
}
window.Buddy3D = { create: createBuddy };
window.dispatchEvent(new Event('buddy3d-ready'));
