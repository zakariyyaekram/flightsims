// A350-1000 exterior: 73.78 m fuselage with the dark "mask" cockpit windows, 64.75 m swept wing with curved
// sharklet-style tips, Trent XWB-97 nacelles with spinning fans and translating reversers, 6-wheel main bogies,
// twin nose wheels, animated slats/flaps/ailerons/spoilers/THS/elevators/rudder, doors and exterior lighting.
// Body frame: x forward, y up, z right; origin = CG.
import * as THREE from 'three';
import { A350, LIVERY } from './data.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const DEG = Math.PI / 180;

// ---------- fuselage ----------
const XN = 35.85, XT = -37.93; // nose tip / tail cone (length 73.78 m)
function section(x) {
  let ry = 3.05, rz = 2.98, yc = 0;
  if (x > 23.5) { const s = Math.min(1, (x - 23.5) / (XN - 23.5)); const f = Math.sqrt(Math.max(0, 1 - Math.pow(s, 2.1))); ry *= f; rz *= f; yc = -0.95 * Math.pow(s, 1.5); }
  else if (x < -19) { const s = Math.min(1, (-19 - x) / (-19 - XT)); ry *= 1 - 0.86 * Math.pow(s, 1.25); rz *= 1 - 0.89 * Math.pow(s, 1.15); yc = 1.95 * Math.pow(s, 1.35); }
  return { ry: Math.max(ry, 0.02), rz: Math.max(rz, 0.02), yc };
}
function fuselageGeo(N = 120, M = 48) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N; const x = XT + (XN - XT) * (1 - Math.pow(1 - t, 1)) ; const s = section(x);
    for (let j = 0; j <= M; j++) { const th = j / M * Math.PI * 2; pos.push(x, s.yc + s.ry * Math.cos(th), s.rz * Math.sin(th)); uv.push(t, 1 - j / M); }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) { const a = i * (M + 1) + j, b = a + M + 1; idx.push(a, a + 1, b, b, a + 1, b + 1); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
// livery: canvas x = body x (tail left -> nose right), canvas y = angle from top (right side 0.25, left side 0.75)
function liveryTexture(reg) {
  const W = 4096, H = 1024, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const X = (x) => (x - XT) / (XN - XT) * W;
  const Yof = (x, y, side) => { const s = section(x); const ct = Math.max(-1, Math.min(1, (y - s.yc) / s.ry)); let th = Math.acos(ct); if (side < 0) th = Math.PI * 2 - th; return th / (Math.PI * 2) * H; };
  g.fillStyle = '#f4f6f8'; g.fillRect(0, 0, W, H);
  // belly grey
  g.fillStyle = '#c9cfd6'; g.fillRect(0, H * 0.4, W, H * 0.2);
  for (const side of [1, -1]) {
    // cheat line in Airbus house colours
    g.fillStyle = LIVERY?.accent || '#1b3f8f';
    for (let x = -30; x < 30; x += 0.25) { const y0 = Yof(x, -0.6, side), y1 = Yof(x, -0.85, side); g.fillRect(X(x), Math.min(y0, y1), X(x + 0.26) - X(x), Math.abs(y1 - y0)); }
    // cabin windows (A350: large windows, ~0.55 m pitch)
    g.fillStyle = '#1a2229';
    for (let x = -22; x < 24.5; x += 0.56) { if ([20.6, 13.0, -8.0, -19.0].some((d) => Math.abs(x - d) < 1.0)) continue; const y = Yof(x, 0.75, side); g.beginPath(); g.ellipse(X(x), y, 6, 9, 0, 0, Math.PI * 2); g.fill(); }
    // doors L/R 1-4
    g.strokeStyle = '#9aa3ab'; g.lineWidth = 2;
    for (const d of [20.6, 13.0, -8.0, -19.0]) { const y0 = Yof(d, 1.6, side), y1 = Yof(d, -0.4, side); g.strokeRect(X(d - 0.55), Math.min(y0, y1), X(d + 0.55) - X(d - 0.55), Math.abs(y1 - y0)); }
    // cockpit "raccoon mask"
    g.fillStyle = '#101317'; g.beginPath();
    for (let x = 29.0; x <= 32.6; x += 0.1) { const y = Yof(x, 1.45 + (x - 29) * 0.06 + (x > 31.2 ? (31.2 - x) * 0.35 : 0), side); x === 29 ? g.moveTo(X(x), y) : g.lineTo(X(x), y); }
    for (let x = 32.6; x >= 29.0; x -= 0.1) { const y = Yof(x, 0.75 + (x - 29) * 0.02 + (x > 31.5 ? (31.5 - x) * 0.25 : 0), side); g.lineTo(X(x), y); }
    g.closePath(); g.fill();
    // titles & registration
    const drawText = (txt, x, y, px, col) => { g.save(); g.translate(X(x), Yof(x, y, side)); if (side < 0) g.rotate(Math.PI); g.font = `700 ${px}px "B612", Arial, sans-serif`; g.fillStyle = col; g.textAlign = 'center'; g.textBaseline = 'middle'; g.scale(1, 1.6); g.fillText(txt, 0, 0); g.restore(); };
    drawText(LIVERY?.title || 'AIRBUS', 4, 1.7, 46, LIVERY?.accent || '#1b3f8f');
    drawText('A350-1000', 23, 1.45, 18, '#6b7680');
    drawText(reg, -24.5, -0.2, 22, '#20252a');
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

// ---------- lifting surfaces ----------
const afT = (s) => 5 * (0.2969 * Math.sqrt(s) - 0.126 * s - 0.3516 * s * s + 0.2843 * s ** 3 - 0.1036 * s ** 4);
// sections: { le:[x,y,z], c, t, n:[x,y,z] thickness normal }; chord runs toward -x
function loft(sections, mat, nChord = 16) {
  const pos = [], idx = []; const ring = nChord * 2;
  for (const S of sections) {
    const le = V3(...S.le), n = V3(...(S.n || [0, 1, 0])), cd = V3(-1, 0, 0);
    for (let k = 0; k < ring; k++) {
      const up = k < nChord; const j = up ? k : ring - 1 - k; const s = (1 - Math.cos(j / (nChord - 1) * Math.PI)) / 2;
      const yt = afT(s) * S.t * S.c * (up ? 1 : -0.72) + (S.camber || 0.02) * S.c * 4 * s * (1 - s) * 0.5;
      const p = le.clone().addScaledVector(cd, s * S.c).addScaledVector(n, yt); pos.push(p.x, p.y, p.z);
    }
  }
  for (let i = 0; i < sections.length - 1; i++) for (let k = 0; k < ring; k++) { const a = i * ring + k, b = i * ring + (k + 1) % ring, c = a + ring, d = b + ring; idx.push(a, b, c, b, d, c); }
  // tip cap
  const last = (sections.length - 1) * ring; for (let k = 1; k < nChord - 1; k++) idx.push(last + k, last + ring - 1 - k, last + k + 1);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat); m.castShadow = true; return m;
}
const WING = [
  { le: [8.6, -1.95, 1.6], c: 14.6, t: 0.14 }, { le: [8.4, -1.92, 2.9], c: 14.0, t: 0.135 },
  { le: [4.0, -1.38, 10.5], c: 8.6, t: 0.11 }, { le: [-8.4, 0.5, 30.2], c: 2.7, t: 0.095 },
];
const WINGLET = [
  { le: [-8.4, 0.5, 30.2], c: 2.7, t: 0.095, n: [0, 1, 0] }, { le: [-9.2, 0.75, 31.2], c: 2.35, t: 0.09, n: [0, 0.92, -0.39] },
  { le: [-9.9, 1.45, 31.95], c: 1.9, t: 0.09, n: [0, 0.6, -0.8] }, { le: [-10.6, 2.6, 32.3], c: 1.4, t: 0.085, n: [0, 0.2, -0.98] },
  { le: [-11.4, 3.9, 32.375], c: 0.85, t: 0.08, n: [0, 0.05, -1] },
];
// spanwise interpolation of the main wing planform
function wingAt(z) { z = Math.abs(z); const W = WING; let i = 1; while (i < W.length - 2 && z > W[i + 1].le[2]) i++; const a = W[i], b = W[i + 1]; const t = Math.max(0, Math.min(1, (z - a.le[2]) / (b.le[2] - a.le[2]))); const L = (k) => a.le[k] + (b.le[k] - a.le[k]) * t; return { x: L(0), y: L(1), c: a.c + (b.c - a.c) * t, t: a.t + (b.t - a.t) * t }; }
const mirror = (sec, s) => sec.map((q) => ({ ...q, le: [q.le[0], q.le[1], q.le[2] * s], n: q.n ? [q.n[0], q.n[1], q.n[2] * s] : undefined }));
// hinged control surface: hinge line A->B (body), chords cA/cB toward -x (or +x if fwd), thickness th
function hinged(A, B, cA, cB, th, mat, fwd = false) {
  const g0 = new THREE.Group(); g0.position.copy(A); const axis = B.clone().sub(A).normalize();
  const d = fwd ? 1 : -1; const pts = [V3(0, 0, 0), B.clone().sub(A), B.clone().sub(A).add(V3(d * cB, -th * 0.3, 0)), V3(d * cA, -th * 0.3, 0)];
  const pos = []; for (const p of pts) pos.push(p.x, p.y + th / 2, p.z); for (const p of pts) pos.push(p.x, p.y - th / 2, p.z);
  const idx = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0];
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat); m.castShadow = true; g0.add(m); g0.userData.axis = axis;
  g0.set = (ang) => g0.quaternion.setFromAxisAngle(axis, ang); return g0;
}
function teSurface(z0, z1, frac, mat, th = 0.12, side = 1) {
  const a = wingAt(z0), b = wingAt(z1);
  const A = V3(a.x - a.c * (1 - frac), a.y + 0.05, z0 * side), B = V3(b.x - b.c * (1 - frac), b.y + 0.05, z1 * side);
  const h = hinged(side > 0 ? A : B, side > 0 ? B : A, (side > 0 ? a : b).c * frac, (side > 0 ? b : a).c * frac, th, mat);
  return h;
}

// ---------- engine ----------
function nacelle(mats) {
  const g = new THREE.Group();
  const prof = [[1.52, 3.4], [1.66, 3.25], [1.72, 2.9], [1.74, 2.2], [1.7, 1.0], [1.55, -0.6], [1.32, -1.9], [1.2, -2.35]];
  const outer = new THREE.LatheGeometry(prof.map(([r, h]) => new THREE.Vector2(r, h)), 48).rotateZ(-Math.PI / 2);
  const cowl = new THREE.Mesh(outer, mats.cowl); cowl.castShadow = true; g.add(cowl);
  const inner = new THREE.LatheGeometry([[1.5, 3.38], [1.46, 2.6], [1.45, 1.6]].map(([r, h]) => new THREE.Vector2(r, h)), 48).rotateZ(-Math.PI / 2);
  g.add(new THREE.Mesh(inner, mats.inlet));
  // translating reverser sleeve
  const sleeve = new THREE.Mesh(new THREE.LatheGeometry([[1.62, 0.2], [1.55, -0.6], [1.32, -1.9]].map(([r, h]) => new THREE.Vector2(r + 0.02, h)), 48).rotateZ(-Math.PI / 2), mats.cowl);
  g.add(sleeve); g.userData.sleeve = sleeve;
  const cascade = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.6, 32, 1, true).rotateZ(Math.PI / 2), mats.dark); cascade.position.x = 0.0; g.add(cascade); cascade.visible = false; g.userData.cascade = cascade;
  // core + exhaust plug
  g.add(new THREE.Mesh(new THREE.LatheGeometry([[1.05, -1.5], [0.95, -2.9], [0.82, -3.5]].map(([r, h]) => new THREE.Vector2(r, h)), 40).rotateZ(-Math.PI / 2), mats.metal));
  g.add(new THREE.Mesh(new THREE.LatheGeometry([[0.62, -3.0], [0.5, -4.0], [0.08, -4.9]].map(([r, h]) => new THREE.Vector2(r, h)), 32).rotateZ(-Math.PI / 2), mats.dark));
  // fan: 22 swept carbon-titanium blades + spinner with the white swirl
  const fan = new THREE.Group(); fan.position.x = 2.7;
  const blade = new THREE.BoxGeometry(0.05, 1.28, 0.22).translate(0, 0.78, 0);
  for (let i = 0; i < 22; i++) { const b = new THREE.Mesh(blade, mats.fan); b.rotation.x = i / 22 * Math.PI * 2; b.rotation.y = 0.55; const p = new THREE.Group(); p.rotation.x = i / 22 * Math.PI * 2; const bb = new THREE.Mesh(blade, mats.fan); bb.rotation.y = 0.55; p.add(bb); fan.add(p); void b; }
  const sp = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 24).rotateZ(-Math.PI / 2), mats.spinner); sp.position.x = 0.35; fan.add(sp);
  const swirl = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.5, 0.04).translate(0, 0.22, 0), mats.white); swirl.position.x = 0.45; swirl.rotation.y = 0.4; fan.add(swirl);
  g.add(fan); g.userData.fan = fan;
  return g;
}

// ---------- landing gear ----------
function wheel(r, w, mats) { const g = new THREE.Group(); const t = new THREE.Mesh(new THREE.TorusGeometry(r - w * 0.28, w * 0.42, 12, 28), mats.tyre); t.scale.z = 1.1; g.add(t); const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w * 0.8, 20).rotateX(Math.PI / 2), mats.metal); g.add(hub); return g; }
function mainGear(mats, s) {
  const piv = new THREE.Group(); piv.position.set(A350.mainX + 0.3, -1.75, s * (A350.mainZ - 0.1));
  const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.17, 2.4, 14), mats.gear); strut.position.y = -1.2; piv.add(strut);
  const side = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 8), mats.gear); side.position.set(0, -1.1, -s * 0.8); side.rotation.x = s * 0.45; piv.add(side);
  const bogie = new THREE.Group(); bogie.position.set(-0.3, -2.55, 0); piv.add(bogie);
  bogie.add(Object.assign(new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.22, 0.24), mats.gear)));
  const wheels = [];
  for (const ax of [-1.65, 0, 1.65]) { const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.7, 8).rotateX(Math.PI / 2), mats.gear); axle.position.x = ax; bogie.add(axle); for (const k of [-0.72, 0.72]) { const w = wheel(0.7, 0.5, mats); w.position.set(ax, 0, k); bogie.add(w); wheels.push(w); } }
  const door = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.8, 0.05), mats.body); door.position.set(0, -1.3, s * 0.3); piv.add(door);
  piv.userData = { bogie, wheels, s };
  return piv;
}
function noseGear(mats) {
  const piv = new THREE.Group(); piv.position.set(A350.noseX + 0.25, -2.55, 0);
  const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.12, 1.9, 12), mats.gear); strut.position.y = -0.95; piv.add(strut);
  const steer = new THREE.Group(); steer.position.y = -1.9; piv.add(steer);
  const wheels = [];
  for (const k of [-0.36, 0.36]) { const w = wheel(0.53, 0.38, mats); w.position.set(-0.25, 0, k); steer.add(w); wheels.push(w); }
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.75, 8).rotateX(Math.PI / 2), mats.gear); axle.position.x = -0.25; steer.add(axle);
  const taxiL = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), mats.lamp); taxiL.position.set(0.2, 0.9, 0); steer.add(taxiL);
  piv.userData = { steer, wheels, taxiL };
  return piv;
}

function glowSprite(color, size) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, color); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  s.scale.set(size, size, size); s.visible = false; return s;
}

export function buildA350(opts = {}) {
  const root = new THREE.Group(); root.name = 'A350-1000';
  const tex = liveryTexture(opts.reg || A350.reg);
  const mats = {
    body: new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0.15 }),
    wing: new THREE.MeshStandardMaterial({ color: 0xd9dee3, roughness: 0.45, metalness: 0.25 }),
    surf: new THREE.MeshStandardMaterial({ color: 0xcfd4d9, roughness: 0.5, metalness: 0.2 }),
    cowl: new THREE.MeshStandardMaterial({ color: 0xf1f3f5, roughness: 0.3, metalness: 0.2, side: THREE.DoubleSide }),
    inlet: new THREE.MeshStandardMaterial({ color: 0x8c949c, roughness: 0.35, metalness: 0.7, side: THREE.DoubleSide }),
    metal: new THREE.MeshStandardMaterial({ color: 0x9aa2aa, roughness: 0.35, metalness: 0.8, side: THREE.DoubleSide }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.6, metalness: 0.5, side: THREE.DoubleSide }),
    fan: new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.3, metalness: 0.8 }),
    spinner: new THREE.MeshStandardMaterial({ color: 0x24282d, roughness: 0.3, metalness: 0.6 }),
    white: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    gear: new THREE.MeshStandardMaterial({ color: 0xbfc5ca, roughness: 0.4, metalness: 0.6 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.95 }),
    tail: new THREE.MeshStandardMaterial({ color: new THREE.Color(LIVERY?.tail || '#1b3f8f'), roughness: 0.35, metalness: 0.15 }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xfff6dd }),
  };
  const fus = new THREE.Mesh(fuselageGeo(), mats.body); fus.castShadow = true; fus.receiveShadow = true; root.add(fus);
  // belly fairing
  { const bf = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mats.wing); bf.scale.set(13, 1.6, 3.2); bf.position.set(1.5, -2.25, 0); root.add(bf); }
  // wings + winglets
  const wings = new THREE.Group(); root.add(wings);
  for (const s of [1, -1]) { wings.add(loft(mirror(WING, s), mats.wing)); wings.add(loft(mirror(WINGLET, s), mats.wing)); }
  // control surfaces
  const surf = { slat: [], flap: [], ail: [], spl: [] };
  for (const s of [1, -1]) {
    for (const [z0, z1] of [[3.4, 9.2], [12.2, 18.0], [18.0, 29.4]]) { const a = wingAt(z0), b = wingAt(z1); const A = V3(a.x - a.c * 0.12, a.y + 0.1, z0 * s), B = V3(b.x - b.c * 0.12, b.y + 0.1, z1 * s); const h = hinged(s > 0 ? A : B, s > 0 ? B : A, (s > 0 ? a : b).c * 0.13, (s > 0 ? b : a).c * 0.13, 0.12, mats.surf, true); h.userData.s = s; wings.add(h); surf.slat.push(h); }
    for (const [z0, z1] of [[3.2, 10.0], [11.2, 21.4]]) { const h = teSurface(z0, z1, 0.27, mats.surf, 0.16, s); h.userData.s = s; wings.add(h); surf.flap.push(h); }
    { const h = teSurface(21.6, 29.0, 0.24, mats.surf, 0.1, s); h.userData.s = s; wings.add(h); surf.ail.push(h); }
    for (let k = 0; k < 7; k++) { const z0 = 4 + k * 2.45, z1 = z0 + 2.35; if (z1 > 21.3) break; const a = wingAt(z0), b = wingAt(z1); const fr = 0.27 + 0.15; const A = V3(a.x - a.c * (1 - fr), a.y + a.c * a.t * 0.42, z0 * s), B = V3(b.x - b.c * (1 - fr), b.y + b.c * b.t * 0.42, z1 * s); const h = hinged(s > 0 ? A : B, s > 0 ? B : A, (s > 0 ? a : b).c * 0.14, (s > 0 ? b : a).c * 0.14, 0.05, mats.surf); h.userData.s = s; h.userData.k = k; wings.add(h); surf.spl.push(h); }
  }
  // horizontal stabiliser (trimmable) with elevators
  const ths = new THREE.Group(); ths.position.set(-31.2, 1.75, 0); root.add(ths);
  const HT = [{ le: [-27.4, 1.55, 0.6], c: 7.0, t: 0.1 }, { le: [-28.0, 1.6, 1.6], c: 6.4, t: 0.1 }, { le: [-34.0, 2.35, 9.45], c: 2.3, t: 0.09 }];
  const elev = [];
  for (const s of [1, -1]) {
    const m = loft(mirror(HT, s), mats.wing); m.position.set(31.2, -1.75, 0); ths.add(m);
    const A = V3(-28.0 - 6.4 * 0.72 + 31.2, 1.62 - 1.75, 1.6 * s), B = V3(-34.0 - 2.3 * 0.72 + 31.2, 2.37 - 1.75, 9.3 * s);
    const h = hinged(s > 0 ? A : B, s > 0 ? B : A, s > 0 ? 6.4 * 0.28 : 2.3 * 0.28, s > 0 ? 2.3 * 0.28 : 6.4 * 0.28, 0.1, mats.surf); h.userData.s = s; ths.add(h); elev.push(h);
  }
  // fin + rudder (tail colour)
  const VT = [{ le: [-24.8, 2.4, 0], c: 11.2, t: 0.11, n: [0, 0, 1], camber: 0 }, { le: [-26.8, 3.4, 0], c: 9.6, t: 0.11, n: [0, 0, 1], camber: 0 }, { le: [-34.4, 12.0, 0], c: 3.5, t: 0.1, n: [0, 0, 1], camber: 0 }];
  root.add(loft(VT, mats.tail));
  const rud = hinged(V3(-26.8 - 9.6 * 0.68, 3.4, 0), V3(-34.4 - 3.5 * 0.68, 12.0, 0), 9.6 * 0.32, 3.5 * 0.32, 0.18, mats.tail);
  // the generic hinge builds chord along -x with thickness in y: rotate geometry thickness into z
  rud.children[0].geometry = (() => { const A = V3(-26.8 - 9.6 * 0.68, 3.4, 0), B = V3(-34.4 - 3.5 * 0.68, 12.0, 0); const d = B.clone().sub(A); const pts = [V3(0, 0, 0), d, d.clone().add(V3(-3.5 * 0.32, 0, 0)), V3(-9.6 * 0.32, 0, 0)]; const pos = []; for (const p of pts) pos.push(p.x, p.y, 0.12); for (const p of pts) pos.push(p.x, p.y, -0.12); const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]); geo.computeVertexNormals(); return geo; })();
  root.add(rud);
  // engines + pylons
  const engines = [];
  for (const s of [-1, 1]) {
    const e = nacelle(mats); e.position.set(A350.engX, A350.engY, s * A350.engZ); root.add(e); engines.push(e);
    const py = new THREE.Mesh(new THREE.BoxGeometry(6.8, 1.3, 0.5), mats.wing); py.position.set(A350.engX - 2.3, A350.engY + 1.55, s * A350.engZ); py.rotation.z = -0.06; root.add(py);
  }
  // APU exhaust
  { const apu = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.6, 16).rotateZ(Math.PI / 2), mats.dark); apu.position.set(XT + 0.2, 1.95 * 1 + 0.02, 0); root.add(apu); }
  // landing gear
  const mains = [mainGear(mats, 1), mainGear(mats, -1)]; mains.forEach((m) => root.add(m));
  const nose = noseGear(mats); root.add(nose);
  // L1 door (opens outward, pivot forward edge)
  const door = new THREE.Group(); door.position.set(21.15, 0.6, -2.96); root.add(door);
  { const d = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.95, 0.08), mats.cowl); d.position.set(-0.55, 0, 0); door.add(d); }
  // exterior lights
  const L = {
    navL: glowSprite('rgba(255,30,30,1)', 1.2), navR: glowSprite('rgba(30,255,80,1)', 1.2), navT: glowSprite('rgba(255,255,255,1)', 1.0),
    strL: glowSprite('rgba(255,255,255,1)', 3.5), strR: glowSprite('rgba(255,255,255,1)', 3.5), strT: glowSprite('rgba(255,255,255,1)', 2.5),
    bcnT: glowSprite('rgba(255,40,20,1)', 1.8), bcnB: glowSprite('rgba(255,40,20,1)', 1.8), land: glowSprite('rgba(255,250,230,1)', 2.6), landR: glowSprite('rgba(255,250,230,1)', 2.6),
    taxi: glowSprite('rgba(255,250,230,1)', 1.6), logoL: glowSprite('rgba(255,255,240,1)', 1.2), logoR: glowSprite('rgba(255,255,240,1)', 1.2), wing: glowSprite('rgba(255,255,240,1)', 1.0),
  };
  L.navL.position.set(-11.2, 4.0, -32.4); L.navR.position.set(-11.2, 4.0, 32.4); L.navT.position.set(XT + 0.1, 2.0, 0);
  L.strL.position.copy(L.navL.position); L.strR.position.copy(L.navR.position); L.strT.position.copy(L.navT.position);
  L.bcnT.position.set(-2, 3.15, 0); L.bcnB.position.set(4, -3.2, 0); L.land.position.set(6.5, -2.0, 2.8); L.landR.position.set(6.5, -2.0, -2.8);
  L.taxi.position.set(A350.noseX + 0.4, -2.9, 0); L.logoL.position.set(-24, 3.3, -6); L.logoR.position.set(-24, 3.3, 6); L.wing.position.set(23, 1.8, -2.8);
  for (const s of Object.values(L)) root.add(s);
  const landSpot = new THREE.SpotLight(0xfff4dd, 0, 900, 0.32, 0.5, 1.2); landSpot.position.set(8, -2.2, 0); landSpot.target.position.set(160, -12, 0); root.add(landSpot, landSpot.target);
  const taxiSpot = new THREE.SpotLight(0xfff4dd, 0, 220, 0.55, 0.6, 1.4); taxiSpot.position.set(A350.noseX + 0.4, -2.9, 0); taxiSpot.target.position.set(A350.noseX + 40, -5, 0); root.add(taxiSpot, taxiSpot.target);

  root.userData.parts = { fus, wings, surf, ths, elev, rud, engines, mains, nose, door, L, landSpot, taxiSpot };
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  return root;
}

// animate surfaces, gear, engines and lights from the FDM + systems state
export function animateA350(root, f, S, dt, t, inside = false) {
  const P = root.userData.parts; const s = f.surf;
  for (const h of P.surf.slat) h.set(-h.userData.s * s.slat * DEG * 0.9);
  for (const h of P.surf.flap) h.set(h.userData.s * s.flap * DEG * 0.85);
  for (const h of P.surf.ail) { const a = h.userData.s > 0 ? s.ailR : s.ailL; h.set(-h.userData.s * a); }
  for (const h of P.surf.spl) { const roll = h.userData.s > 0 ? Math.max(0, s.rollSpl) : Math.max(0, -s.rollSpl); const k = h.userData.k; const ang = Math.max(s.spl, s.gndSpl, k > 1 ? roll : 0); h.set(-h.userData.s * ang); }
  P.ths.rotation.z = (s.ths || 0) * DEG;
  for (const h of P.elev) h.set(-h.userData.s * s.elev);
  P.rud.set(-s.rud);
  // engines
  for (let i = 0; i < 2; i++) {
    const e = P.engines[i], E = f.E[i]; const fan = e.userData.fan; fan.rotation.x += (E.n1 / 100) * 2650 / 60 * Math.PI * 2 * dt * (E.n1 > 30 ? 0.08 : 1);
    e.userData.sleeve.position.x = -E.rev * 0.75; e.userData.cascade.visible = E.rev > 0.05;
  }
  // gear: 0 up .. 1 down
  const gp = f.gear.pos;
  for (const m of P.mains) { m.rotation.x = m.userData.s * (1 - gp) * 88 * DEG; m.visible = gp > 0.01; m.userData.bogie.rotation.z = (f.onGround ? 0 : -6 * DEG) * gp; }
  P.nose.rotation.z = (1 - gp) * 92 * DEG; P.nose.visible = gp > 0.01;
  P.nose.userData.steer.rotation.y = -(s.nws || 0);
  const roll = (f.onGround ? f.ind.gs * 0.5144 : 0) * dt;
  for (const m of P.mains) for (const w of m.userData.wheels) w.rotation.z -= roll / 0.7;
  for (const w of P.nose.userData.wheels) w.rotation.z -= roll / 0.53;
  // door L1
  P.door.rotation.y = (S?.doors?.L1 ? 1 : 0) * -1.4 * 1 + 0;
  // lights
  const ov = S?.ov || {}; const pw = S ? S.acPowered || S.dcPowered : true; const L = P.L; const air = !f.onGround;
  const nav = pw && ov.NAV > 0; L.navL.visible = L.navR.visible = L.navT.visible = nav;
  const strobeOn = pw && (ov.STROBE === 2 || (ov.STROBE === 1 && air)); const ph = t % 1.1;
  L.strL.visible = L.strR.visible = strobeOn && (ph < 0.06 || (ph > 0.15 && ph < 0.21)); L.strT.visible = strobeOn && ph > 0.5 && ph < 0.56;
  const bcn = pw && ov.BEACON === 1; L.bcnT.visible = bcn && (t % 1.0) < 0.12; L.bcnB.visible = bcn && ((t + 0.5) % 1.0) < 0.12;
  const land = pw && ov.LAND === 1; L.land.visible = L.landR.visible = land; P.landSpot.intensity = land ? 60 : 0;
  const taxi = pw && ov.NOSE >= 1 && gp > 0.95; L.taxi.visible = taxi; P.taxiSpot.intensity = taxi ? (ov.NOSE === 2 ? 40 : 22) : 0;
  L.logoL.visible = L.logoR.visible = pw && ov.LOGO === 1; L.wing.visible = pw && ov.WING === 1;
  // hide the nose shell when the camera sits in the flight deck
  P.fus.visible = !inside;
}
