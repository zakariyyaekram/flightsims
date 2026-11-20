// Procedural airliners (parked at gates and flown by AI traffic). Low-poly, painted with canvas liveries.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// dimensions (m) roughly matching the real types
export const TYPES = {
  A320: { L: 37.6, D: 3.95, span: 34.1, sweep: 25, tailH: 11.8, eng: 1.0, engY: -1.6, wide: false, name: 'A320' },
  B738: { L: 39.5, D: 3.76, span: 35.8, sweep: 25, tailH: 12.5, eng: 0.95, engY: -1.5, wide: false, name: 'B738' },
  B39M: { L: 42.2, D: 3.76, span: 35.9, sweep: 25, tailH: 12.3, eng: 1.05, engY: -1.5, wide: false, name: 'B39M' },
  E175: { L: 31.7, D: 3.0, span: 26.0, sweep: 23, tailH: 9.9, eng: 0.75, engY: -1.2, wide: false, name: 'E175' },
  B77W: { L: 73.9, D: 6.2, span: 64.8, sweep: 31, tailH: 18.5, eng: 1.75, engY: -2.6, wide: true, name: 'B77W' },
  B789: { L: 62.8, D: 5.77, span: 60.1, sweep: 32, tailH: 17.0, eng: 1.6, engY: -2.4, wide: true, name: 'B789' },
  A321: { L: 44.5, D: 3.95, span: 35.8, sweep: 25, tailH: 11.8, eng: 1.0, engY: -1.6, wide: false, name: 'A321' },
};
// liveries: top, belly, tail, engine, stripe, title, text colour
export const LIVERIES = {
  UAL: { name: 'UNITED', top: '#f4f5f7', belly: '#1b3c8c', tail: '#1b3c8c', eng: '#1b3c8c', stripe: null, text: '#1b3c8c', call: 'United', icao: 'UAL' },
  SWA: { name: 'SOUTHWEST', top: '#2d4bb8', belly: '#c8102e', tail: '#2d4bb8', eng: '#2d4bb8', stripe: '#ffbf27', text: '#ffffff', call: 'Southwest', icao: 'SWA' },
  ASA: { name: 'ALASKA', top: '#f4f5f7', belly: '#f4f5f7', tail: '#01426a', eng: '#01426a', stripe: '#48b5a8', text: '#01426a', call: 'Alaska', icao: 'ASA' },
  DAL: { name: 'DELTA', top: '#f4f5f7', belly: '#0c2850', tail: '#c01933', eng: '#0c2850', stripe: null, text: '#0c2850', call: 'Delta', icao: 'DAL' },
  AAL: { name: 'AMERICAN', top: '#c3c9cf', belly: '#9aa3ab', tail: '#0078d2', eng: '#9aa3ab', stripe: '#c30019', text: '#36495a', call: 'American', icao: 'AAL' },
  JBU: { name: 'jetBlue', top: '#f4f5f7', belly: '#003876', tail: '#0033a0', eng: '#003876', stripe: null, text: '#003876', call: 'JetBlue', icao: 'JBU' },
  FDX: { name: 'FedEx', top: '#f4f5f7', belly: '#c7c9cc', tail: '#4d148c', eng: '#4d148c', stripe: null, text: '#4d148c', call: 'FedEx', icao: 'FDX' },
  HAL: { name: 'HAWAIIAN', top: '#f4f5f7', belly: '#f4f5f7', tail: '#5a2b81', eng: '#5a2b81', stripe: '#c8102e', text: '#5a2b81', call: 'Hawaiian', icao: 'HAL' },
  SKW: { name: 'SKYWEST', top: '#f4f5f7', belly: '#f4f5f7', tail: '#1b3c8c', eng: '#c7c9cc', stripe: '#1b3c8c', text: '#1b3c8c', call: 'SkyWest', icao: 'SKW' },
  UPS: { name: 'UPS', top: '#4f3426', belly: '#4f3426', tail: '#4f3426', eng: '#c7c9cc', stripe: '#ffb500', text: '#ffb500', call: 'UPS', icao: 'UPS' },
};

function liveryTex(lv) {
  const W = 1024, H = 256; const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  // x = along fuselage (0 nose .. W tail), y = around (0 top, H/2 bottom, H top again)
  g.fillStyle = lv.top; g.fillRect(0, 0, W, H);
  const band = (y0, y1, col) => { g.fillStyle = col; g.fillRect(0, y0 * H, W, (y1 - y0) * H); };
  band(0.36, 0.64, lv.belly);
  if (lv.stripe) { band(0.33, 0.36, lv.stripe); band(0.64, 0.67, lv.stripe); }
  // windows (both sides) and doors
  g.fillStyle = '#20262e';
  for (const y of [0.205, 0.795]) {
    for (let x = 0.13; x < 0.82; x += 0.0105) g.fillRect(x * W, y * H - 3, 5, 7);
    for (const dx of [0.1, 0.8]) g.fillRect(dx * W, y * H - 14, 9, 24);
  }
  // cockpit windows
  g.fillStyle = '#11161c'; for (const y of [0.17, 0.83]) g.fillRect(0.035 * W, y * H - 6, 26, 10);
  // title
  g.fillStyle = lv.text; g.font = '700 30px Arial, sans-serif'; g.textBaseline = 'middle';
  g.save(); g.translate(0.2 * W, 0.135 * H); g.fillText(lv.name, 0, 0); g.restore();
  g.save(); g.translate(0.2 * W, 0.865 * H); g.scale(1, -1); g.fillText(lv.name, 0, 0); g.restore();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

function colorGeo(g, col) {
  if (col === 'tail' || col === 'eng') { // slot resolved per livery in airlinerRest (NaN marker, y = slot)
    const n = g.attributes.position.count; const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = NaN; a[i * 3 + 1] = col === 'tail' ? 1 : 2; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3)); if (g.attributes.uv) g.deleteAttribute('uv'); return g;
  }
  const c = new THREE.Color(col); const n = g.attributes.position.count; const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3)); if (g.attributes.uv) g.deleteAttribute('uv'); return g;
}
// thin swept surface between two chord lines (root at y,z; tip offset) as a closed slab
function wing(root, tip, rootChord, tipChord, sweepX, thick, mirror = 1, vertical = false) {
  // local frame: x = forward (+ = nose), span along +z (horizontal) or +y (vertical)
  const P = [];
  const sec = (s, chord, off, t) => [[off + chord * 0.5, 0, t], [off - chord * 0.5, 0, t * 0.3], [off - chord * 0.5, 0, -t * 0.3], [off + chord * 0.5, 0, -t]];
  const r = sec(0, rootChord, root[0], thick), q = sec(1, tipChord, root[0] - sweepX, thick * 0.5);
  const map = (p, s) => vertical ? [p[0], root[1] + s * tip, root[2] + p[2]] : [p[0], root[1] + p[2] + s * tip * 0.06, root[2] + mirror * s * tip];
  const R = r.map((p) => map(p, 0)), T = q.map((p) => map(p, 1));
  const quad = (a, b, c, d) => P.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; quad(R[i], R[j], T[j], T[i]); }
  quad(T[0], T[1], T[2], T[3]);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.computeVertexNormals(); return g;
}

const cache = new Map();
// returns { fus: geometry(uv), rest: geometry(vertex colours) }, x = forward, y up, z = right; origin at main gear on ground
export function airlinerGeometry(typeName) {
  if (cache.has(typeName)) return cache.get(typeName);
  const T = TYPES[typeName] || TYPES.A320; const L = T.L, R = T.D / 2;
  const gearH = R + (T.wide ? 2.1 : 1.35); // fuselage centre height
  const noseL = L * 0.1, tailL = L * 0.27;
  const rings = 34, seg = 20; const P = [], UV = [], I = [];
  for (let i = 0; i <= rings; i++) {
    const s = i / rings, x = L / 2 - s * L; let r = R, cy = 0;
    const dn = s * L; const dt = (1 - s) * L;
    if (dn < noseL) { const k = dn / noseL; r = R * Math.sqrt(Math.max(0.02, 1 - (1 - k) * (1 - k))); cy = -R * 0.18 * (1 - k); }
    if (dt < tailL) { const k = 1 - dt / tailL; r = R * (1 - 0.82 * k * k * 0.9 - 0.1 * k); cy = R * 0.55 * k; }
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2; // 0 = top
      P.push(x, gearH + cy + Math.cos(a) * r, Math.sin(a) * r * 1.0); UV.push(s, 1 - j / seg);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) { const a = i * (seg + 1) + j, b = a + seg + 1; I.push(a, b, a + 1, a + 1, b, b + 1); }
  const fus = new THREE.BufferGeometry(); fus.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); fus.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2)); fus.setIndex(I); fus.computeVertexNormals();
  const parts = [];
  const wingRootX = L * 0.06, sw = Math.tan(T.sweep * Math.PI / 180) * T.span / 2;
  const rc = L * (T.wide ? 0.17 : 0.19);
  for (const m of [1, -1]) parts.push(colorGeo(wing([wingRootX, gearH - R * 0.55, 0], T.span / 2, rc, rc * 0.25, sw, rc * 0.06, m), '#d8dbe0'));
  // winglets
  for (const m of [1, -1]) parts.push(colorGeo(wing([wingRootX - sw, gearH - R * 0.55 + T.span * 0.03, m * T.span / 2], 1.8 * (T.wide ? 1.6 : 1), rc * 0.25, rc * 0.12, 0.6, 0.06, m, true), 'tail'));
  // horizontal stabiliser
  const hs = T.span * 0.36, hx = -L / 2 + L * 0.1;
  for (const m of [1, -1]) parts.push(colorGeo(wing([hx, gearH + R * 0.35, 0], hs / 2, L * 0.09, L * 0.035, L * 0.07, L * 0.006, m), '#d8dbe0'));
  // fin
  parts.push(colorGeo(wing([-L / 2 + L * 0.14, gearH + R * 0.5, 0], T.tailH - gearH - R * 0.5, L * 0.16, L * 0.065, L * 0.11, L * 0.008, 1, true), 'tail'));
  // engines under wing
  for (const m of [1, -1]) {
    const ez = m * T.span * (T.wide ? 0.17 : 0.17), ex = wingRootX + rc * 0.6 - Math.tan(T.sweep * Math.PI / 180) * Math.abs(ez) + rc * 0.25;
    const er = T.eng, el = T.eng * 3.4;
    const e = new THREE.CylinderGeometry(er, er * 0.82, el, 18, 1, false); e.rotateZ(Math.PI / 2); e.translate(ex, gearH - R + T.engY * 0.15 - er * 0.2, ez);
    parts.push(colorGeo(e, 'eng'));
    const inlet = new THREE.CircleGeometry(er * 0.92, 18); inlet.rotateY(Math.PI / 2); inlet.translate(ex + el / 2 + 0.02, gearH - R + T.engY * 0.15 - er * 0.2, ez); parts.push(colorGeo(inlet, '#1c1f24'));
    const py = new THREE.BoxGeometry(el * 0.7, 0.9, 0.35); py.translate(ex - el * 0.1, gearH - R * 0.65 - er * 0.1 + 0.3, ez); parts.push(colorGeo(py, '#d8dbe0'));
  }
  // landing gear (nose + mains)
  const gm = '#3a3d42';
  const ng = new THREE.CylinderGeometry(0.12, 0.12, gearH - R, 8); ng.translate(L / 2 - L * 0.12, (gearH - R) / 2 + 0.3, 0); parts.push(colorGeo(ng, '#cfd2d6'));
  const nw = new THREE.CylinderGeometry(0.42, 0.42, 0.5, 14); nw.rotateX(Math.PI / 2); nw.translate(L / 2 - L * 0.12, 0.42, 0); parts.push(colorGeo(nw, '#141414'));
  for (const m of [1, -1]) {
    const lg = new THREE.CylinderGeometry(0.2, 0.2, gearH - R * 0.6, 8); lg.translate(0, (gearH - R * 0.6) / 2, m * T.D * (T.wide ? 0.95 : 0.75)); parts.push(colorGeo(lg, '#cfd2d6'));
    for (const dx of T.wide ? [-1.4, 0, 1.4] : [0]) for (const dz of [-0.35, 0.35]) {
      const w = new THREE.CylinderGeometry(0.58 * (T.wide ? 1.1 : 1), 0.58 * (T.wide ? 1.1 : 1), 0.45, 14); w.rotateX(Math.PI / 2); w.translate(dx, 0.6, m * T.D * (T.wide ? 0.95 : 0.75) + dz); parts.push(colorGeo(w, gm));
    }
  }
  const rest = mergeGeometries(parts.map((g) => { g = g.index ? g.toNonIndexed() : g; return g; }), false);
  const out = { fus, rest, T, gearH };
  cache.set(typeName, out); return out;
}
const matCache = new Map();
export function airlinerMaterials(liveryKey) {
  if (matCache.has(liveryKey)) return matCache.get(liveryKey);
  const lv = LIVERIES[liveryKey] || LIVERIES.UAL;
  const fus = new THREE.MeshStandardMaterial({ map: liveryTex(lv), roughness: 0.35, metalness: 0.15 });
  const rest = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 });
  // tail / engine colour slots are encoded in vertex colours via a remap below
  const out = { fus, rest, lv }; matCache.set(liveryKey, out); return out;
}
// geometry 'rest' colours named 'tail'/'eng' are resolved per livery (colour attribute is per-livery copy)
const restCache = new Map();
export function airlinerRest(typeName, liveryKey) {
  const k = typeName + liveryKey; if (restCache.has(k)) return restCache.get(k);
  const G = airlinerGeometry(typeName); const lv = LIVERIES[liveryKey] || LIVERIES.UAL;
  const g = G.rest.clone(); const c = g.attributes.color; const tail = new THREE.Color(lv.tail), eng = new THREE.Color(lv.eng);
  for (let i = 0; i < c.count; i++) { const r = c.getX(i); if (Number.isNaN(r)) { const which = c.getY(i); const col = which === 1 ? tail : eng; c.setXYZ(i, col.r, col.g, col.b); } }
  restCache.set(k, g); return g;
}
// a complete airliner Object3D (for AI traffic). Local frame: three.js object facing -Z like the Cessna? We use +X forward, so wrap.
export function buildAirliner(typeName = 'A320', liveryKey = 'UAL') {
  const G = airlinerGeometry(typeName); const M = airlinerMaterials(liveryKey);
  const inner = new THREE.Group();
  const f = new THREE.Mesh(G.fus, M.fus), r = new THREE.Mesh(airlinerRest(typeName, liveryKey), M.rest);
  f.castShadow = r.castShadow = true; f.receiveShadow = r.receiveShadow = true;
  inner.add(f, r);
  inner.rotation.y = Math.PI / 2; // +X forward -> -Z forward (heading 0 = north when parent yaw = 0)
  const o = new THREE.Group(); o.add(inner); o.userData.gearH = G.gearH; o.userData.type = G.T;
  // nav / beacon / strobe lights as tiny emissive spheres
  const lm = (c) => new THREE.MeshBasicMaterial({ color: c });
  const s = new THREE.SphereGeometry(0.25, 6, 4);
  const add = (x, y, z, c) => { const m = new THREE.Mesh(s, lm(c)); m.position.set(z, y, -x); o.add(m); return m; };
  const T = G.T, wy = G.gearH - T.D * 0.28;
  o.userData.lights = [add(T.L * 0.06 - Math.tan(T.sweep * Math.PI / 180) * T.span / 2, wy + T.span * 0.03, -T.span / 2, 0xff2020), add(T.L * 0.06 - Math.tan(T.sweep * Math.PI / 180) * T.span / 2, wy + T.span * 0.03, T.span / 2, 0x20ff40)];
  o.userData.beacon = add(0, G.gearH + T.D / 2 + 0.1, 0, 0xff1010);
  return o;
}
