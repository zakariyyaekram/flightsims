// Ground support equipment (GSE): physically-based models of the vehicles, jet bridges and ramp crew used by the
// ground-service system. Everything is procedural but built to real dimensions with PBR materials (clear-coated paint,
// polished aluminium, rubber with tread normals, reflective glass), weathering/grime maps and canvas decals
// (operator liveries, hazmat placards, fuel grade bands, conspicuity tape).
// Vehicle frame: +X forward, +Y up, +Z right, origin on the ground at the centre of the footprint.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------ textures
function cnv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function tex(c, { srgb = true, repeat = true } = {}) {
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8; if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// weathering: near-white with soft speckle, rain streaks and road grime toward the bottom (v = 0)
function grimeCanvas(strength = 1, seed = 7) {
  const [c, g] = cnv(512, 512); const r = rng(seed);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2600; i++) { const a = (0.015 + r() * 0.045) * strength; g.fillStyle = `rgba(70,62,52,${a})`; g.beginPath(); g.arc(r() * 512, r() * 512, 0.6 + r() * 2.6, 0, TAU); g.fill(); }
  for (let i = 0; i < 140; i++) { const x = r() * 512, y = r() * 300, l = 40 + r() * 200; const gr = g.createLinearGradient(x, y, x, y + l); gr.addColorStop(0, 'rgba(60,55,48,0)'); gr.addColorStop(1, `rgba(60,55,48,${0.06 * strength})`); g.fillStyle = gr; g.fillRect(x, y, 1 + r() * 2.5, l); }
  const gr = g.createLinearGradient(0, 512, 0, 330); gr.addColorStop(0, `rgba(58,50,40,${0.38 * strength})`); gr.addColorStop(1, 'rgba(58,50,40,0)'); g.fillStyle = gr; g.fillRect(0, 330, 512, 182);
  return c;
}
function treadCanvas() {
  const [c, g] = cnv(256, 64); g.fillStyle = 'rgb(128,128,255)'; g.fillRect(0, 0, 256, 64);
  for (let x = 0; x < 256; x += 16) { g.fillStyle = 'rgb(40,128,220)'; g.fillRect(x, 0, 3, 64); g.fillStyle = 'rgb(216,128,220)'; g.fillRect(x + 5, 0, 3, 64); }
  for (const y of [18, 44]) { g.fillStyle = 'rgb(128,50,220)'; g.fillRect(0, y, 256, 2); g.fillStyle = 'rgb(128,206,220)'; g.fillRect(0, y + 3, 256, 2); }
  return c;
}
function hazardCanvas() {
  const [c, g] = cnv(128, 128); g.fillStyle = '#f2b705'; g.fillRect(0, 0, 128, 128); g.fillStyle = '#151515';
  for (let k = -128; k < 256; k += 48) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k + 24, 0); g.lineTo(k + 24 + 128, 128); g.lineTo(k + 128, 128); g.fill(); }
  return c;
}
function checkerPlateCanvas() {
  const [c, g] = cnv(128, 128); g.fillStyle = '#9ea3a7'; g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 16) for (let x = 0; x < 128; x += 16) { const o = ((y / 16) % 2) * 8; g.fillStyle = '#c9cdd0'; g.save(); g.translate(x + o + 4, y + 4); g.rotate(((x + y) / 16) % 2 ? 0.8 : -0.8); g.fillRect(-4, -1, 8, 2.4); g.restore(); }
  return c;
}
function beltCanvas() {
  const [c, g] = cnv(64, 256); g.fillStyle = '#1b1b1b'; g.fillRect(0, 0, 64, 256);
  for (let y = 0; y < 256; y += 32) { g.fillStyle = '#2f2f2f'; g.fillRect(0, y, 64, 6); g.fillStyle = '#0c0c0c'; g.fillRect(0, y + 6, 64, 2); }
  return c;
}
// jet-bridge tunnel side: ribbed steel cladding with a strip of tinted windows
function tunnelCanvas() {
  const [c, g] = cnv(512, 256);
  g.fillStyle = '#c7cacd'; g.fillRect(0, 0, 512, 256);
  for (let x = 0; x < 512; x += 16) { g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(x, 0, 3, 256); g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(x + 9, 0, 3, 256); }
  g.fillStyle = '#7d8287'; g.fillRect(0, 70, 512, 6); g.fillRect(0, 170, 512, 5);
  for (let x = 12; x < 512; x += 128) {
    g.fillStyle = '#3d4247'; g.fillRect(x - 3, 83, 110, 74);
    const gr = g.createLinearGradient(0, 86, 0, 154); gr.addColorStop(0, '#2c3d4a'); gr.addColorStop(0.5, '#16212a'); gr.addColorStop(1, '#0d1419'); g.fillStyle = gr; g.fillRect(x, 86, 104, 68);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.moveTo(x + 10, 86); g.lineTo(x + 40, 86); g.lineTo(x + 18, 154); g.lineTo(x, 154); g.fill();
  }
  const gr = g.createLinearGradient(0, 256, 0, 200); gr.addColorStop(0, 'rgba(60,52,40,0.35)'); gr.addColorStop(1, 'rgba(60,52,40,0)'); g.fillStyle = gr; g.fillRect(0, 200, 512, 56);
  return c;
}

// ------------------------------------------------------------------ materials (shared, built lazily)
let M = null;
function mats() {
  if (M) return M;
  const grime = tex(grimeCanvas(1, 11)), grimeLight = tex(grimeCanvas(0.45, 23));
  const tread = tex(treadCanvas(), { srgb: false }); tread.repeat.set(10, 1);
  const hazard = tex(hazardCanvas()); const plate = tex(checkerPlateCanvas()); plate.repeat.set(4, 4);
  const belt = tex(beltCanvas()); belt.repeat.set(1, 6);
  const tunnel = tex(tunnelCanvas());
  const paintCache = new Map();
  M = {
    grime, tread, belt,
    paint(hex, { rough = 0.36, clear = 0.55 } = {}) {
      const k = hex + ':' + rough + ':' + clear; if (paintCache.has(k)) return paintCache.get(k);
      const m = new THREE.MeshPhysicalMaterial({ color: hex, map: grime, roughness: rough, metalness: 0.04, clearcoat: clear, clearcoatRoughness: 0.22 });
      paintCache.set(k, m); return m;
    },
    alu: new THREE.MeshStandardMaterial({ color: 0xdfe3e7, map: grimeLight, metalness: 1, roughness: 0.17 }),
    brushed: new THREE.MeshStandardMaterial({ color: 0xc4c8cc, map: grimeLight, metalness: 0.92, roughness: 0.4 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xf0f0f0, metalness: 1, roughness: 0.07 }),
    chassis: new THREE.MeshStandardMaterial({ color: 0x1d1f22, map: grime, metalness: 0.55, roughness: 0.62 }),
    plastic: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.72, metalness: 0.0 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.93, normalMap: tread, normalScale: new THREE.Vector2(0.9, 0.9) }),
    hose: new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.6 }),
    rimSilver: new THREE.MeshStandardMaterial({ color: 0xb9bdc1, metalness: 0.95, roughness: 0.3 }),
    rimWhite: new THREE.MeshPhysicalMaterial({ color: 0xe9e9e6, metalness: 0.1, roughness: 0.4, clearcoat: 0.4 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0b1217, roughness: 0.04, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 }),
    head: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d8, emissiveIntensity: 0.25, roughness: 0.1 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x6a0a06, emissive: 0xff1a08, emissiveIntensity: 0.25, roughness: 0.3 }),
    amber: new THREE.MeshStandardMaterial({ color: 0xa05a00, emissive: 0xff8a00, emissiveIntensity: 0.3, roughness: 0.3 }),
    beacon: new THREE.MeshStandardMaterial({ color: 0xb36200, emissive: 0xff9a10, emissiveIntensity: 1, roughness: 0.2, transparent: true, opacity: 0.92 }),
    hazard: new THREE.MeshStandardMaterial({ map: hazard, roughness: 0.55 }),
    plate: new THREE.MeshStandardMaterial({ map: plate, metalness: 0.85, roughness: 0.42 }),
    beltM: new THREE.MeshStandardMaterial({ map: belt, roughness: 0.85 }),
    tunnel: new THREE.MeshStandardMaterial({ map: tunnel, metalness: 0.35, roughness: 0.48 }),
    tunnelRoof: new THREE.MeshStandardMaterial({ color: 0xaeb2b5, map: grime, metalness: 0.4, roughness: 0.6 }),
    bellows: new THREE.MeshStandardMaterial({ color: 0x202224, roughness: 0.88 }),
    concrete: new THREE.MeshStandardMaterial({ color: 0xc9c6bf, map: grime, roughness: 0.92 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.8 }),
    reflect: new THREE.MeshStandardMaterial({ color: 0xe8e8e8, emissive: 0x222222, roughness: 0.25, metalness: 0.2 }),
    cone: new THREE.MeshStandardMaterial({ color: 0xff4a0a, roughness: 0.55 }),
    person: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 }),
    bag: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 }),
  };
  M.beaconMats = [M.beacon];
  return M;
}
// beacons / headlights follow time of day and flash
export function tickGSE(t, night = 0) {
  if (!M) return;
  const f = Math.max(0, Math.sin(t * 7.5)); M.beacon.emissiveIntensity = 0.15 + f * f * (2.5 + night * 4);
  M.head.emissiveIntensity = 0.2 + night * 3.2; M.tail.emissiveIntensity = 0.2 + night * 1.6; M.amber.emissiveIntensity = 0.25 + night * 1.2;
}

// ------------------------------------------------------------------ decal atlas (one texture per model family)
class Atlas {
  constructor(W = 1024, H = 1024) { [this.c, this.g] = cnv(W, H); this.W = W; this.H = H; this.x = 0; this.y = 0; this.row = 0; this.mat = null; }
  add(pw, ph, draw) {
    if (this.x + pw > this.W) { this.x = 0; this.y += this.row; this.row = 0; }
    const r = { u0: this.x / this.W, u1: (this.x + pw) / this.W, v0: 1 - (this.y + ph) / this.H, v1: 1 - this.y / this.H };
    const g = this.g; g.save(); g.translate(this.x, this.y); g.beginPath(); g.rect(0, 0, pw, ph); g.clip(); draw(g, pw, ph); g.restore();
    this.x += pw; this.row = Math.max(this.row, ph); return r;
  }
  material() {
    if (this.mat) return this.mat;
    const t = tex(this.c, { repeat: false }); t.anisotropy = 8;
    this.mat = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.4, roughness: 0.42, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide });
    return this.mat;
  }
}
function decalGeo(w, h, r) {
  const g = new THREE.PlaneGeometry(w, h); const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, r.u0 + (r.u1 - r.u0) * uv.getX(i), r.v0 + (r.v1 - r.v0) * uv.getY(i));
  return g;
}
const font = (w, px, fam = 'Barlow, Arial, sans-serif') => `${w} ${px}px ${fam}`;
function textDecal(text, { color = '#fff', bg = null, weight = 800, italic = false, pad = 8, px = 90, fam } = {}) {
  return (g, w, h) => {
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
    g.fillStyle = color; g.font = (italic ? 'italic ' : '') + font(weight, px, fam); g.textBaseline = 'middle'; g.textAlign = 'center';
    const m = g.measureText(text).width; const s = Math.min(1, (w - pad * 2) / m); g.save(); g.translate(w / 2, h / 2 + 2); g.scale(s, 1); g.fillText(text, 0, 0); g.restore();
  };
}
function hazmatDiamond(num, cls = '3') {
  return (g, w, h) => {
    g.save(); g.translate(w / 2, h / 2); g.rotate(Math.PI / 4); const s = w * 0.68; g.fillStyle = '#fff'; g.fillRect(-s / 2 - 4, -s / 2 - 4, s + 8, s + 8); g.fillStyle = '#d7261e'; g.fillRect(-s / 2, -s / 2, s, s); g.restore();
    g.fillStyle = '#fff'; g.fillRect(w * 0.2, h * 0.4, w * 0.6, h * 0.2); g.fillStyle = '#000'; g.font = font(800, h * 0.17, 'Arial'); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(num, w / 2, h / 2 + 1);
    g.fillStyle = '#fff'; g.font = font(800, h * 0.12, 'Arial'); g.fillText(cls, w / 2, h * 0.82);
    g.beginPath(); g.moveTo(w / 2, h * 0.12); g.lineTo(w * 0.42, h * 0.3); g.lineTo(w * 0.58, h * 0.3); g.closePath(); g.fill();
  };
}
function conspicuity() { return (g, w, h) => { for (let x = 0; x < w; x += 40) { g.fillStyle = (x / 40) % 2 ? '#c8102e' : '#f4f4f4'; g.fillRect(x, 0, 40, h); } }; }

// ------------------------------------------------------------------ merge builder
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
export class MB {
  constructor() { this.lists = new Map(); }
  add(geo, mat, p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) {
    _m4.compose(V3(p[0], p[1], p[2]), _q.setFromEuler(_e.set(r[0], r[1], r[2])), V3(s[0], s[1], s[2]));
    return this.addM(geo, mat, _m4);
  }
  addM(geo, mat, m) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.morphAttributes = {}; g.clearGroups();
    g.applyMatrix4(m);
    if (!this.lists.has(mat)) this.lists.set(mat, []);
    this.lists.get(mat).push(g); return this;
  }
  // bake every mesh of an Object3D (with its world transform) into the builder
  bake(obj, pre = null) {
    obj.updateMatrixWorld(true);
    obj.traverse((o) => { if (o.isMesh && o.visible !== false) { const m = o.matrixWorld.clone(); if (pre) m.premultiply(pre); this.addM(o.geometry, o.material, m); } });
    return this;
  }
  build(group = new THREE.Group(), { cast = true, receive = true } = {}) {
    for (const [mat, list] of this.lists) {
      if (!list.length) continue;
      const g = mergeGeometries(list, false); if (!g) continue; g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat); mesh.castShadow = cast; mesh.receiveShadow = receive; group.add(mesh);
    }
    this.lists.clear(); return group;
  }
}

// ------------------------------------------------------------------ primitives
const rbox = (w, h, d, r = 0.06, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001));
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cylX = (r, len, n = 16, r2 = r) => new THREE.CylinderGeometry(r2, r, len, n).rotateZ(Math.PI / 2); // axis X; r2 at +X
const cylY = (r, len, n = 16, r2 = r) => new THREE.CylinderGeometry(r2, r, len, n);
const cylZ = (r, len, n = 16) => new THREE.CylinderGeometry(r, r, len, n).rotateX(Math.PI / 2);
// a box whose UVs run in metres along its long faces (texture tiles every T metres), keeping v = 0..1 vertically
function metricBox(w, h, d, T = 4) {
  const g = new THREE.BoxGeometry(w, h, d); const uv = g.attributes.uv;
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
    const i = f * 4 + k; let u = uv.getX(i), v = uv.getY(i);
    if (f < 2) u *= d / T; else if (f < 4) { u *= w / T; v *= d / T; } else u *= w / T;
    uv.setXY(i, u, v);
  }
  return g;
}
function tireGeo(r, w) {
  const ri = r * 0.6, sh = Math.min(w * 0.32, r * 0.16), pts = [];
  pts.push(new THREE.Vector2(ri, -w / 2 + 0.01));
  for (let i = 0; i <= 5; i++) { const a = -Math.PI / 2 + (i / 5) * Math.PI / 2; pts.push(new THREE.Vector2(r - sh + Math.cos(a) * sh, -w / 2 + sh + Math.sin(a) * sh)); }
  for (let i = 0; i <= 5; i++) { const a = (i / 5) * Math.PI / 2; pts.push(new THREE.Vector2(r - sh + Math.cos(a) * sh, w / 2 - sh + Math.sin(a) * sh)); }
  pts.push(new THREE.Vector2(ri, w / 2 - 0.01));
  if (LOD) return new THREE.LatheGeometry([pts[0], pts[1], pts[3], pts[6], pts[8], pts[11], pts[13]], 12).rotateX(Math.PI / 2);
  return new THREE.LatheGeometry(pts, 28).rotateX(Math.PI / 2);
}
// LOD 1: lighter wheels for the many baked vehicles parked around the gates
let LOD = 0;
export function gseLowDetail(fn) { const o = LOD; LOD = 1; try { return fn(); } finally { LOD = o; } }
// wheel with tyre, rim, hub and lug nuts; outer face toward sign(z)
function wheel(mb, x, z, r, w, { rim = null, dual = false, y = null } = {}) {
  const m = mats(); const yy = y ?? r; const side = Math.sign(z) || 1;
  const set = dual ? [z - side * w * 0.55, z + side * w * 0.55] : [z];
  for (const zz of set) mb.add(tireGeo(r, w), m.rubber, [x, yy, zz]);
  const zo = set[set.length - 1] + side * (w / 2 - 0.035);
  mb.add(cylZ(r * 0.58, 0.06, LOD ? 10 : 20), rim || m.rimSilver, [x, yy, zo]);
  mb.add(cylZ(r * 0.2, 0.1, LOD ? 6 : 12), m.chrome, [x, yy, zo + side * 0.04]);
  if (LOD) return;
  for (let k = 0; k < 6; k++) { const a = (k / 6) * TAU; mb.add(cylZ(r * 0.035, 0.05, 6), m.chrome, [x + Math.cos(a) * r * 0.32, yy + Math.sin(a) * r * 0.32, zo + side * 0.035]); }
  mb.add(cylZ(r * 0.62, 0.02, 20), m.plastic, [x, yy, z - side * (w / 2 + (dual ? w * 0.6 : 0))]);
}
// half-round mudguard over a wheel
function fender(mb, x, z, r, w, mat) { mb.add(new THREE.CylinderGeometry(r, r, w, 18, 1, true, Math.PI / 2, Math.PI).rotateX(Math.PI / 2), mat, [x, r * 0.92, z]); }
function decal(mb, atlas, rect, w, h, x, y, z, side) { // side: +1 right (+z), -1 left, 'f' front (+x), 'b' back
  const g = decalGeo(w, h, rect); const mat = atlas.material();
  if (side === 1) mb.add(g, mat, [x, y, z + 0.006]);
  else if (side === -1) mb.add(g, mat, [x, y, z - 0.006], [0, Math.PI, 0]);
  else if (side === 'f') mb.add(g, mat, [x + 0.006, y, z], [0, Math.PI / 2, 0]);
  else if (side === 'b') mb.add(g, mat, [x - 0.006, y, z], [0, -Math.PI / 2, 0]);
  else if (side === 'top') mb.add(g, mat, [x, y + 0.006, z], [-Math.PI / 2, 0, 0]);
}
function mirrors(mb, x, y, w) {
  const m = mats();
  for (const s of [-1, 1]) {
    mb.add(cylY(0.018, 0.5, 6).rotateX(Math.PI / 2), m.chassis, [x, y + 0.2, s * (w / 2 + 0.25)]);
    mb.add(rbox(0.06, 0.42, 0.22, 0.03), m.plastic, [x, y + 0.1, s * (w / 2 + 0.5)]);
    mb.add(box(0.005, 0.36, 0.17), m.chrome, [x - 0.032, y + 0.1, s * (w / 2 + 0.5)]);
  }
}
function beaconLight(mb, x, y, z, r = 0.09) {
  const m = mats();
  mb.add(cylY(r * 1.1, 0.05, 14), m.plastic, [x, y + 0.025, z]);
  mb.add(new THREE.SphereGeometry(r, 16, 8, 0, TAU, 0, Math.PI / 2).scale(1, 1.5, 1), m.beacon, [x, y + 0.05, z]);
}
// cab-over-engine truck cab (front at x1)
function cabOver(mb, { x0, x1, w, y0, y1, paint, glassH = 0.5, rake = 0.08 }) {
  const m = mats(); const L = x1 - x0, H = y1 - y0, cy = (y0 + y1) / 2;
  mb.add(rbox(L, H, w, 0.16, 3), paint, [x0 + L / 2, cy, 0]);
  const gh = H * glassH;
  mb.add(rbox(0.06, gh, w - 0.24, 0.05), m.glass, [x1 + 0.005, y1 - gh / 2 - 0.12, 0], [0, 0, rake]);
  for (const s of [-1, 1]) {
    mb.add(rbox(L * 0.5, gh * 0.85, 0.04, 0.03), m.glass, [x1 - L * 0.32, y1 - gh / 2 - 0.14, s * (w / 2 + 0.004)]);
    mb.add(box(0.012, H * 0.86, 0.012), m.plastic, [x1 - L * 0.62, cy + 0.02, s * (w / 2 + 0.005)]);
    mb.add(box(0.2, 0.05, 0.03), m.chrome, [x1 - L * 0.5, cy - 0.05, s * (w / 2 + 0.012)]);
    mb.add(rbox(L * 0.32, 0.08, 0.3, 0.02), m.chassis, [x1 - L * 0.4, y0 - 0.25, s * (w / 2 - 0.12)]);
    mb.add(rbox(L * 0.32, 0.08, 0.3, 0.02), m.chassis, [x1 - L * 0.4, y0 + 0.1, s * (w / 2 - 0.12)]);
    mb.add(rbox(0.06, 0.18, 0.32, 0.03), m.head, [x1 + 0.01, y0 + 0.32, s * (w / 2 - 0.3)]);
    mb.add(rbox(0.06, 0.1, 0.14, 0.02), m.amber, [x1 + 0.01, y0 + 0.32, s * (w / 2 - 0.08)]);
    mb.add(box(0.012, 0.012, w * 0.38), m.plastic, [x1 + 0.03, y1 - gh - 0.06, s * w * 0.2], [0.0, 0, 0.9]);
  }
  mb.add(rbox(0.06, 0.34, w * 0.56, 0.03), m.plastic, [x1 + 0.006, y0 + 0.36, 0]);
  for (let k = 0; k < 4; k++) mb.add(box(0.02, 0.025, w * 0.54), m.chrome, [x1 + 0.04, y0 + 0.24 + k * 0.08, 0]);
  mb.add(rbox(0.22, 0.32, w + 0.04, 0.06), m.plastic, [x1 + 0.06, y0 - 0.02, 0]);
  mirrors(mb, x1 - 0.1, y1 - 0.75, w);
}
// conventional bonneted cab (hood in front of the cab; front at x1)
function cabHood(mb, { x0, xc, x1, w, y0, y1, yh, paint, wheelR }) {
  const m = mats(); const L = xc - x0, H = y1 - y0;
  mb.add(rbox(L, H, w, 0.14, 3), paint, [x0 + L / 2, y0 + H / 2, 0]);
  const hl = x1 - xc; mb.add(rbox(hl + 0.1, yh - y0, w * 0.82, 0.14, 3), paint, [xc + hl / 2 - 0.05, (y0 + yh) / 2, 0]);
  const gh = H * 0.42;
  mb.add(rbox(0.06, gh, w - 0.22, 0.05), m.glass, [xc + 0.02, y1 - gh / 2 - 0.1, 0], [0, 0, 0.22]);
  for (const s of [-1, 1]) {
    mb.add(rbox(L * 0.56, gh * 0.9, 0.04, 0.03), m.glass, [xc - L * 0.38, y1 - gh / 2 - 0.12, s * (w / 2 + 0.004)]);
    mb.add(box(0.012, H * 0.86, 0.012), m.plastic, [x0 + 0.08, y0 + H / 2, s * (w / 2 + 0.005)]);
    mb.add(box(0.2, 0.05, 0.03), m.chrome, [x0 + L * 0.35, y0 + H * 0.48, s * (w / 2 + 0.012)]);
    mb.add(rbox(0.06, 0.2, 0.3, 0.03), m.head, [x1 + 0.0, yh - 0.32, s * (w * 0.41 - 0.2)]);
    mb.add(rbox(0.06, 0.1, 0.12, 0.02), m.amber, [x1 - 0.02, yh - 0.52, s * (w * 0.41 - 0.2)]);
    fender(mb, x1 - hl * 0.42, s * (w / 2 - 0.12), wheelR + 0.1, 0.42, m.plastic);
    mb.add(rbox(0.5, 0.07, 0.32, 0.02), m.chassis, [x0 + L * 0.4, y0 - 0.2, s * (w / 2 - 0.1)]);
  }
  mb.add(rbox(0.06, (yh - y0) * 0.6, w * 0.5, 0.03), m.plastic, [x1 + 0.006, (y0 + yh) / 2 + 0.05, 0]);
  for (let k = 0; k < 6; k++) mb.add(box(0.02, 0.02, w * 0.48), m.chrome, [x1 + 0.03, y0 + 0.2 + k * 0.1, 0]);
  mb.add(rbox(0.22, 0.28, w + 0.06, 0.06), m.chrome, [x1 + 0.08, y0 - 0.12, 0]);
  mirrors(mb, xc - 0.15, y1 - 0.7, w);
}
function chassisRails(mb, x0, x1, y, w) { const m = mats(); for (const s of [-1, 1]) mb.add(box(x1 - x0, 0.26, 0.09), m.chassis, [(x0 + x1) / 2, y, s * w / 2]); for (let x = x0 + 0.3; x < x1; x += 1.3) mb.add(box(0.08, 0.2, w), m.chassis, [x, y, 0]); }
// elliptical tank along X with dished heads and bulkhead bands
function tank(mb, x0, x1, cy, ry, rz, mat) {
  const m = mats(); const L = x1 - x0, cx = (x0 + x1) / 2, cap = Math.min(ry, rz) * 0.42;
  mb.add(new THREE.CylinderGeometry(1, 1, L - cap * 2, 40, 1, true).rotateZ(Math.PI / 2), mat, [cx, cy, 0], [0, 0, 0], [1, ry, rz]);
  const hemi = () => new THREE.SphereGeometry(1, 40, 12, 0, TAU, 0, Math.PI / 2);
  mb.add(hemi().rotateZ(-Math.PI / 2), mat, [x1 - cap, cy, 0], [0, 0, 0], [cap, ry, rz]);
  mb.add(hemi().rotateZ(Math.PI / 2), mat, [x0 + cap, cy, 0], [0, 0, 0], [cap, ry, rz]);
  for (let x = x0 + cap; x <= x1 - cap + 0.01; x += (L - cap * 2) / 3) mb.add(new THREE.CylinderGeometry(1, 1, 0.05, 40, 1, true).rotateZ(Math.PI / 2), m.brushed, [x, cy, 0], [0, 0, 0], [1, ry + 0.012, rz + 0.012]);
  return { top: cy + ry };
}
function handrails(mb, x0, x1, y, z, mat) { const m = mats(); mb.add(cylX(0.022, x1 - x0, 8), mat || m.paint(0xf2b705), [(x0 + x1) / 2, y, z]); for (let x = x0; x <= x1 + 0.01; x += (x1 - x0) / Math.max(1, Math.round((x1 - x0) / 1.2))) mb.add(cylY(0.02, 0.5, 6), mat || m.paint(0xf2b705), [x, y - 0.25, z]); }

// ------------------------------------------------------------------ vehicles
const PROTO = new Map();
function proto(key, fn) { key = LOD + key; if (!PROTO.has(key)) PROTO.set(key, fn()); const p = PROTO.get(key); const o = p.clone(); o.userData = { ...p.userData }; return o; }

// GA refueler: 1,200 gal 100LL truck on a medium-duty chassis (Garsite / Rampmaster style)
function avgasTruckProto() {
  const m = mats(), mb = new MB(), A = new Atlas(1024, 512);
  const white = m.paint(0xf1f2ef), red = m.paint(0xb51f24);
  chassisRails(mb, -3.7, 3.1, 0.72, 0.86);
  cabHood(mb, { x0: 1.05, xc: 2.65, x1: 3.75, w: 2.3, y0: 0.95, y1: 2.62, yh: 1.82, paint: white, wheelR: 0.5 });
  mb.add(box(1.4, 0.06, 2.32), red, [1.8, 1.5, 0]);
  const t = tank(mb, -3.45, 0.85, 1.86, 0.78, 1.04, m.alu);
  mb.add(box(4.0, 0.12, 1.9), m.chassis, [-1.3, 1.05, 0]);
  for (let x = -3.0; x < 0.8; x += 1.05) mb.add(box(0.12, 0.2, 2.05), m.chassis, [x, 1.0, 0]);
  // top: manholes, vents, fold-down rail
  for (const x of [-2.4, -0.6]) { mb.add(cylY(0.27, 0.1, 20), m.brushed, [x, t.top + 0.03, 0]); mb.add(cylY(0.05, 0.25, 8), m.chrome, [x + 0.35, t.top + 0.1, 0.1]); }
  mb.add(box(3.6, 0.04, 0.55), m.plate, [-1.4, t.top - 0.02, 0]);
  handrails(mb, -3.2, 0.4, t.top + 0.55, 0.42);
  // rear cabinet: hose reel, meter, nozzle
  mb.add(rbox(0.7, 1.35, 2.3, 0.04), white, [-3.95, 1.55, 0]);
  mb.add(cylZ(0.42, 0.62, 24), red, [-4.0, 1.55, -0.35]); mb.add(cylZ(0.36, 0.5, 24), m.hose, [-4.0, 1.55, -0.35]);
  mb.add(rbox(0.06, 0.4, 0.5, 0.02), m.plastic, [-4.31, 1.7, 0.55]); mb.add(box(0.01, 0.28, 0.4), m.glass, [-4.345, 1.72, 0.55]);
  mb.add(cylX(0.045, 0.32, 8), m.brushed, [-4.45, 1.25, 0.25]);
  mb.add(cylZ(0.22, 0.12, 16), red, [-4.0, 0.85, 0.9]); // static ground reel
  // fenders and dual rears
  for (const s of [-1, 1]) { mb.add(rbox(1.7, 0.08, 0.5, 0.03), m.plastic, [-1.85, 1.12, s * 1.0]); mb.add(box(4.3, 0.12, 0.08), m.reflect, [-1.3, 1.15, s * 1.1]); }
  wheel(mb, 3.2, 0.98, 0.5, 0.3, { rim: m.rimWhite }); wheel(mb, 3.2, -0.98, 0.5, 0.3, { rim: m.rimWhite });
  wheel(mb, -1.85, 0.82, 0.5, 0.28, { dual: true, rim: m.rimWhite }); wheel(mb, -1.85, -0.82, 0.5, 0.28, { dual: true, rim: m.rimWhite });
  for (const s of [-1, 1]) { mb.add(rbox(0.06, 0.12, 0.2, 0.02), m.tail, [-4.32, 0.9, s * 0.95]); }
  beaconLight(mb, 2.0, 2.62, 0);
  // decals: grade band, name, hazmat, no-smoking, conspicuity tape
  const band = A.add(512, 80, textDecal('AVGAS 100LL', { bg: '#c8102e', color: '#fff', px: 62 }));
  const name = A.add(512, 96, textDecal('BAY AVIATION FUEL', { color: '#0d3a73', px: 64, italic: true }));
  const haz = A.add(160, 160, hazmatDiamond('1203'));
  const nos = A.add(320, 64, textDecal('NO SMOKING WITHIN 50 FT', { color: '#c8102e', bg: '#fff', px: 34 }));
  const flam = A.add(256, 64, textDecal('FLAMMABLE', { color: '#fff', bg: '#c8102e', px: 44 }));
  const door = A.add(256, 96, textDecal('FUEL 7', { color: '#0d3a73', px: 70 }));
  const tape = A.add(512, 24, conspicuity());
  for (const s of [-1, 1]) {
    const z = s * 1.045;
    decal(mb, A, band, 2.4, 0.38, -1.3, 1.95, z, s); decal(mb, A, name, 2.6, 0.46, -1.3, 2.38, z * 0.985, s);
    decal(mb, A, haz, 0.4, 0.4, -3.05, 1.6, z * 0.94, s); decal(mb, A, nos, 1.6, 0.22, -1.3, 1.45, z * 0.94, s);
    decal(mb, A, door, 0.9, 0.33, 1.85, 1.95, s * 1.152, s); decal(mb, A, tape, 4.2, 0.08, -1.3, 1.2, s * 1.115, s);
  }
  decal(mb, A, flam, 1.1, 0.27, -4.31, 2.05, 0, 'b'); decal(mb, A, haz, 0.4, 0.4, -4.31, 1.0, -0.6, 'b');
  const g = mb.build(); g.userData = { kind: 'avgas', len: 8.2, wid: 2.4, hoseAt: V3(-4.05, 1.55, -0.65) }; return g;
}
// airport Jet A refueler (10,000 gal, tandem axle)
function jetTruckProto() {
  const m = mats(), mb = new MB(), A = new Atlas(1024, 512);
  const white = m.paint(0xf3f3f0), blue = m.paint(0x123f7a);
  chassisRails(mb, -5.6, 4.4, 0.8, 0.9);
  cabOver(mb, { x0: 3.4, x1: 5.25, w: 2.5, y0: 1.05, y1: 3.15, paint: white });
  mb.add(box(1.86, 0.1, 2.52), blue, [4.32, 1.8, 0]);
  const t = tank(mb, -5.5, 3.1, 2.2, 1.12, 1.24, m.alu);
  for (let x = -5.0; x < 3.0; x += 1.2) mb.add(box(0.14, 0.24, 2.3), m.chassis, [x, 1.05, 0]);
  for (const x of [-3.8, -1.1, 1.6]) mb.add(cylY(0.3, 0.12, 20), m.brushed, [x, t.top + 0.03, 0]);
  mb.add(box(7.6, 0.04, 0.6), m.plate, [-1.2, t.top - 0.02, 0]); handrails(mb, -5.0, 2.6, t.top + 0.6, 0.45); handrails(mb, -5.0, 2.6, t.top + 0.6, -0.45);
  // mid cabinet with hose reels (deck hose & underwing hose)
  mb.add(rbox(1.3, 1.6, 2.5, 0.05), white, [3.0 - 0.1, 1.95, 0]);
  for (const s of [-1, 1]) { mb.add(cylZ(0.5, 0.5, 24), blue, [2.85, 1.95, s * 0.6]); mb.add(cylZ(0.44, 0.42, 24), m.hose, [2.85, 1.95, s * 0.6]); }
  for (const s of [-1, 1]) { mb.add(box(9.6, 0.12, 0.08), m.reflect, [-0.5, 1.2, s * 1.27]); mb.add(rbox(3.0, 0.08, 0.55, 0.03), m.plastic, [-3.75, 1.3, s * 1.1]); }
  wheel(mb, 4.25, 1.06, 0.55, 0.34); wheel(mb, 4.25, -1.06, 0.55, 0.34);
  for (const x of [-3.15, -4.35]) { wheel(mb, x, 0.9, 0.55, 0.3, { dual: true }); wheel(mb, x, -0.9, 0.55, 0.3, { dual: true }); }
  for (const s of [-1, 1]) mb.add(rbox(0.06, 0.12, 0.22, 0.02), m.tail, [-5.72, 1.0, s * 1.05]);
  beaconLight(mb, 4.4, 3.15, 0);
  const band = A.add(512, 80, textDecal('JET A', { bg: '#111', color: '#fff', px: 64 }));
  const name = A.add(640, 110, textDecal('BAY AVIATION FUEL', { color: '#123f7a', px: 76, italic: true }));
  const haz = A.add(160, 160, hazmatDiamond('1863'));
  const nos = A.add(360, 64, textDecal('NO SMOKING WITHIN 50 FT', { color: '#c8102e', bg: '#fff', px: 36 }));
  const flam = A.add(256, 64, textDecal('FLAMMABLE', { color: '#fff', bg: '#c8102e', px: 44 }));
  const num = A.add(256, 96, textDecal('F-14', { color: '#123f7a', px: 74 }));
  const tape = A.add(512, 24, conspicuity());
  for (const s of [-1, 1]) {
    const z = s * 1.245;
    decal(mb, A, band, 2.2, 0.4, -1.2, 2.05, z, s); decal(mb, A, name, 4.0, 0.7, -1.2, 2.75, z * 0.97, s);
    decal(mb, A, haz, 0.5, 0.5, -4.6, 1.85, z * 0.92, s); decal(mb, A, nos, 2.2, 0.26, -1.2, 1.62, z * 0.95, s);
    decal(mb, A, num, 0.8, 0.3, 4.3, 2.55, s * 1.252, s); decal(mb, A, tape, 9.0, 0.09, -0.5, 1.33, s * 1.315, s);
  }
  decal(mb, A, flam, 1.2, 0.3, -5.61, 2.6, 0, 'b'); decal(mb, A, haz, 0.5, 0.5, -5.61, 1.5, 0, 'b');
  const g = mb.build(); g.userData = { kind: 'jet', len: 11.2, wid: 2.6, hoseAt: V3(2.85, 1.95, 1.0) }; return g;
}
// high-lift catering truck: cab, scissor lift, insulated box with front bridge platform (animated: setLift)
function cateringTruckProto() {
  const m = mats(), mb = new MB(), A = new Atlas(1024, 512);
  const white = m.paint(0xf4f4f2), navy = m.paint(0x13284a), yel = m.paint(0xf2b705);
  chassisRails(mb, -4.6, 3.0, 0.8, 0.9);
  cabOver(mb, { x0: 2.85, x1: 4.45, w: 2.45, y0: 1.0, y1: 2.85, paint: white });
  mb.add(box(4.6, 0.3, 2.35), m.chassis, [-1.6, 1.12, 0]);
  for (const s of [-1, 1]) for (const x of [-4.2, 2.3]) mb.add(box(0.18, 0.9, 0.18), yel, [x, 0.75, s * 1.15]); // stabiliser legs
  wheel(mb, 3.55, 1.02, 0.5, 0.32); wheel(mb, 3.55, -1.02, 0.5, 0.32); wheel(mb, -2.9, 0.86, 0.5, 0.28, { dual: true }); wheel(mb, -2.9, -0.86, 0.5, 0.28, { dual: true });
  for (const s of [-1, 1]) mb.add(rbox(1.5, 0.08, 0.5, 0.03), m.plastic, [-2.9, 1.1, s * 1.05]);
  beaconLight(mb, 3.65, 2.85, 0.7);
  const base = mb.build();
  // lift box (local y = 0 at the box floor)
  const bx = new MB();
  bx.add(rbox(6.6, 2.45, 2.5, 0.05), white, [-1.2, 1.28, 0]);
  bx.add(box(6.64, 0.16, 2.54), navy, [-1.2, 0.1, 0]);
  for (let x = -4.3; x < 1.9; x += 0.155) for (const s of [-1, 1]) bx.add(box(0.02, 1.9, 0.004), m.paint(0xdfe0de), [x, 1.3, s * 1.252]); // roll-shutter ribs
  bx.add(box(3.7, 0.06, 2.4), m.plate, [3.95, 0.03, 0]);
  for (const s of [-1, 1]) { bx.add(cylX(0.03, 3.6, 8), yel, [3.95, 1.05, s * 1.15]); for (let x = 2.3; x <= 5.7; x += 0.85) bx.add(cylY(0.028, 1.05, 6), yel, [x, 0.53, s * 1.15]); }
  bx.add(box(0.16, 0.18, 2.6), m.plastic, [5.85, 0.1, 0]);
  bx.add(rbox(0.1, 2.1, 1.1, 0.03), m.brushed, [2.1, 1.1, 0]);
  bx.add(box(0.12, 0.2, 2.5), m.hazard, [5.8, 0.25, 0]);
  const brand = A.add(640, 128, (g, w, h) => { g.fillStyle = '#13284a'; g.font = font(800, 78); g.textBaseline = 'middle'; g.fillText('BAY', 18, h / 2); g.fillStyle = '#d4a017'; g.font = 'italic ' + font(700, 72); g.fillText('SkyChef', 200, h / 2 + 2); });
  const tag = A.add(512, 64, textDecal('IN-FLIGHT CATERING · SFO · OAK · SJC', { color: '#13284a', px: 34, weight: 600 }));
  const hl = A.add(256, 64, textDecal('HIGH LOADER', { color: '#fff', bg: '#13284a', px: 38 }));
  for (const s of [-1, 1]) { decal(bx, A, brand, 3.8, 0.76, -1.2, 1.75, s * 1.252, s); decal(bx, A, tag, 3.6, 0.36, -1.2, 0.95, s * 1.256, s); }
  decal(bx, A, hl, 1.4, 0.35, -4.51, 2.2, 0, 'b');
  const boxG = bx.build();
  // scissor: two crossed beams per side (rotated about Z by setLift)
  const sc = new THREE.Group(); const beams = [];
  for (const s of [-1, 1]) for (const d of [1, -1]) { const b = new THREE.Mesh(rbox(6.0, 0.18, 0.12, 0.03), yel); b.castShadow = true; b.position.set(-1.0, 0, s * 0.95); b.userData.dir = d; sc.add(b); beams.push(b); }
  const g = new THREE.Group(); g.add(base, sc, boxG);
  const lowY = 1.32;
  g.userData = { kind: 'catering', len: 10.3, wid: 2.6, lift: 0, platformX: 5.9 };
  g.userData.setLift = (o, h) => { // h = box floor height above ground
    const box_ = o.children[2], sc_ = o.children[1]; const lift = Math.max(0, h - lowY); box_.position.y = lowY + lift;
    const ang = Math.asin(Math.min(0.95, (lift + 0.2) / 6.0)); sc_.position.y = 1.28 + lift / 2 + 0.04;
    for (const b of sc_.children) b.rotation.z = b.userData.dir * ang;
    o.userData.lift = h;
  };
  g.userData.setLift(g, lowY);
  return g;
}
// small catering / FBO service van (Transit-style high roof)
function vanProto(label = 'FBO CATERING', color = 0xf4f4f2, accent = '#0e5c8f') {
  const m = mats(), mb = new MB(), A = new Atlas(1024, 256);
  const paint = m.paint(color); const W = 2.05;
  const prof = [[-2.75, 0.42], [2.55, 0.42], [2.72, 0.62], [2.72, 0.98], [2.25, 1.25], [1.45, 2.05], [1.15, 2.52], [-2.72, 2.55], [-2.78, 2.35], [-2.78, 0.6]];
  const sh = new THREE.Shape(prof.map(([x, y]) => new THREE.Vector2(x, y)));
  mb.add(new THREE.ExtrudeGeometry(sh, { depth: W - 0.12, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 3, curveSegments: 4 }).translate(0, 0, -(W - 0.12) / 2), paint);
  const gl = [[2.2, 1.3], [1.47, 2.0], [1.22, 2.42], [1.12, 2.42], [1.12, 1.33]];
  const gs = new THREE.Shape(gl.map(([x, y]) => new THREE.Vector2(x, y)));
  mb.add(new THREE.ExtrudeGeometry(gs, { depth: W + 0.02, bevelEnabled: false }).translate(0, 0, -(W + 0.02) / 2), m.glass);
  mb.add(rbox(0.05, 0.62, W - 0.36, 0.03), m.glass, [1.78, 1.66, 0], [0, 0, 0.92]);
  for (const s of [-1, 1]) {
    mb.add(box(0.012, 1.9, 0.01), m.plastic, [1.05, 1.45, s * (W / 2 + 0.005)]); mb.add(box(0.012, 1.9, 0.01), m.plastic, [-0.45, 1.45, s * (W / 2 + 0.005)]);
    mb.add(rbox(0.06, 0.18, 0.28, 0.03), m.head, [2.73, 0.92, s * 0.7]); mb.add(rbox(0.06, 0.32, 0.12, 0.02), m.tail, [-2.8, 1.2, s * 0.92]);
    fender(mb, 1.7, s * (W / 2 - 0.08), 0.46, 0.3, m.plastic); fender(mb, -1.75, s * (W / 2 - 0.08), 0.46, 0.3, m.plastic);
  }
  mb.add(rbox(0.2, 0.26, W + 0.06, 0.06), m.plastic, [2.72, 0.5, 0]); mb.add(rbox(0.2, 0.26, W + 0.06, 0.06), m.plastic, [-2.8, 0.52, 0]);
  mb.add(rbox(0.05, 0.3, 1.0, 0.03), m.plastic, [2.75, 0.8, 0]);
  mirrors(mb, 1.25, 1.7, W);
  wheel(mb, 1.7, 0.86, 0.36, 0.24); wheel(mb, 1.7, -0.86, 0.36, 0.24); wheel(mb, -1.75, 0.86, 0.36, 0.24); wheel(mb, -1.75, -0.86, 0.36, 0.24);
  beaconLight(mb, 0.4, 2.58, 0, 0.08);
  const t = A.add(768, 110, textDecal(label, { color: accent, px: 80, italic: true }));
  const s2 = A.add(512, 64, textDecal('RAMP SERVICES', { color: '#555', px: 40, weight: 600 }));
  const stripe = A.add(1000, 40, (g, w, h) => { g.fillStyle = accent; g.fillRect(0, 0, w, h); });
  for (const s of [-1, 1]) { decal(mb, A, t, 2.9, 0.42, -0.7, 1.85, s * (W / 2 + 0.06), s); decal(mb, A, s2, 1.6, 0.2, -0.7, 1.5, s * (W / 2 + 0.06), s); decal(mb, A, stripe, 5.3, 0.12, 0, 1.05, s * (W / 2 + 0.065), s); }
  const g = mb.build(); g.userData = { kind: 'van', len: 5.6, wid: 2.2 }; return g;
}
// conventional airliner tug (TLD / Goldhofer style) with towbar
function tugProto() {
  const m = mats(), mb = new MB(), A = new Atlas(512, 256);
  const body = m.paint(0xe8a317, { rough: 0.45 });
  mb.add(rbox(6.4, 1.05, 2.7, 0.14, 3), body, [0, 0.95, 0]);
  mb.add(rbox(6.5, 0.18, 2.8, 0.06), m.plastic, [0, 0.42, 0]);
  for (const x of [3.22, -3.22]) mb.add(box(0.12, 0.3, 2.5), m.hazard, [x * 1.003, 0.95, 0]);
  // raised cab front-left
  mb.add(rbox(1.7, 0.18, 1.6, 0.04), m.chassis, [1.4, 1.56, -0.45]);
  for (const sx of [0.62, 2.18]) for (const sz of [-1.2, 0.3]) mb.add(box(0.07, 1.05, 0.07), m.chassis, [sx, 2.1, sz]);
  mb.add(rbox(1.7, 0.1, 1.6, 0.04), m.chassis, [1.4, 2.65, -0.45]);
  mb.add(box(0.02, 0.98, 1.44), m.glass, [2.2, 2.1, -0.45]); mb.add(box(0.02, 0.98, 1.44), m.glass, [0.6, 2.1, -0.45]);
  mb.add(box(1.5, 0.98, 0.02), m.glass, [1.4, 2.1, -1.24]); mb.add(box(1.5, 0.98, 0.02), m.glass, [1.4, 2.1, 0.34]);
  mb.add(rbox(0.5, 0.5, 0.55, 0.06), m.seat, [1.2, 1.85, -0.45]); mb.add(cylY(0.17, 0.03, 16), m.plastic, [1.75, 2.05, -0.45], [0, 0, 0.6]);
  beaconLight(mb, 1.4, 2.7, -0.45, 0.1);
  for (const s of [-1, 1]) { mb.add(rbox(0.05, 0.16, 0.36, 0.03), m.head, [3.24, 1.15, s * 1.05]); mb.add(rbox(0.05, 0.14, 0.2, 0.02), m.tail, [-3.24, 1.15, s * 1.1]); }
  mb.add(box(0.5, 0.25, 0.4), m.chassis, [3.35, 0.7, 0]); mb.add(box(0.5, 0.25, 0.4), m.chassis, [-3.35, 0.7, 0]);
  for (const x of [2.1, -2.1]) for (const s of [-1, 1]) { wheel(mb, x, s * 1.12, 0.58, 0.46); }
  for (const x of [2.1, -2.1]) for (const s of [-1, 1]) mb.add(new THREE.CylinderGeometry(0.66, 0.66, 0.5, 18, 1, true, Math.PI / 2, Math.PI).rotateX(Math.PI / 2), m.plastic, [x, 0.6, s * 1.12]);
  const t = A.add(512, 96, textDecal('PUSHBACK · TOWING', { color: '#151515', px: 54 }));
  for (const s of [-1, 1]) decal(mb, A, t, 2.6, 0.4, -1.4, 1.05, s * 1.352, s);
  const base = mb.build();
  const bar = new MB();
  bar.add(cylX(0.08, 5.0, 12), m.paint(0xf2b705), [5.95, 0.62, 0]); bar.add(box(0.5, 0.12, 0.7), m.chassis, [8.35, 0.55, 0]);
  for (const s of [-1, 1]) wheel(bar, 4.4, s * 0.35, 0.18, 0.12);
  const towbar = bar.build(); towbar.visible = false;
  const g = new THREE.Group(); g.add(base, towbar);
  g.userData = { kind: 'tug', len: 6.5, wid: 2.8, towbarLen: 5.0 + 3.2 + 0.25 };
  g.userData.setTowbar = (o, on) => { o.children[1].visible = on; };
  return g;
}
// compact GA tug (ride-on electric tug with a nose-wheel cradle at the front)
function gaTugProto() {
  const m = mats(), mb = new MB(), A = new Atlas(256, 128);
  const red = m.paint(0xc21f1f, { rough: 0.4 });
  mb.add(rbox(1.55, 0.55, 1.05, 0.08, 3), red, [-0.1, 0.5, 0]);
  mb.add(rbox(0.6, 0.45, 0.9, 0.06), m.chassis, [-0.45, 0.95, 0]);
  mb.add(rbox(0.42, 0.12, 0.46, 0.04), m.seat, [-0.5, 1.22, 0]); mb.add(rbox(0.1, 0.42, 0.46, 0.04), m.seat, [-0.75, 1.45, 0]);
  mb.add(cylY(0.03, 0.6, 8), m.chassis, [0.3, 1.05, 0], [0, 0, -0.45]); mb.add(new THREE.TorusGeometry(0.17, 0.02, 8, 20).rotateX(Math.PI / 2), m.plastic, [0.42, 1.33, 0], [0, 0, -0.45]);
  // cradle forks
  for (const s of [-1, 1]) mb.add(rbox(0.8, 0.1, 0.12, 0.03), m.chassis, [1.05, 0.2, s * 0.2]);
  mb.add(box(0.12, 0.35, 0.55), m.chassis, [0.68, 0.38, 0]); mb.add(box(0.05, 0.3, 0.45), m.hazard, [0.62, 0.42, 0]);
  mb.add(cylY(0.022, 1.2, 6), m.chassis, [-0.82, 1.3, 0.38]); beaconLight(mb, -0.82, 1.9, 0.38, 0.06);
  for (const s of [-1, 1]) { wheel(mb, 0.35, s * 0.5, 0.22, 0.16); wheel(mb, -0.55, s * 0.5, 0.25, 0.2); mb.add(rbox(0.04, 0.08, 0.16, 0.02), m.head, [0.67, 0.62, s * 0.34]); }
  const t = A.add(256, 64, textDecal('TOWMASTER', { color: '#fff', px: 40 }));
  for (const s of [-1, 1]) decal(mb, A, t, 0.8, 0.2, -0.1, 0.58, s * 0.528, s);
  const g = mb.build(); g.userData = { kind: 'gatug', len: 1.9, wid: 1.1, cradleX: 1.15 }; return g;
}
// apron passenger bus (low-floor, wide doors, Cobus-style)
function busProto() {
  const m = mats(), mb = new MB(), A = new Atlas(1024, 512);
  const W = 2.9, white = m.paint(0xf3f4f4), blue = m.paint(0x0f4c8a);
  const L = 13.6, x0 = -L / 2, x1 = L / 2;
  const prof = [[x0 + 0.2, 0.32], [x1 - 0.2, 0.32], [x1, 0.6], [x1 + 0.05, 2.2], [x1 - 0.25, 2.95], [x0 + 0.25, 2.95], [x0 - 0.05, 2.2], [x0, 0.6]];
  const sh = new THREE.Shape(prof.map(([x, y]) => new THREE.Vector2(x, y)));
  mb.add(new THREE.ExtrudeGeometry(sh, { depth: W - 0.16, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.08, bevelSegments: 3, curveSegments: 3 }).translate(0, 0, -(W - 0.16) / 2), white);
  // glazing band and doors
  for (const s of [-1, 1]) {
    mb.add(box(L - 0.6, 1.35, 0.02), m.glass, [0, 2.02, s * (W / 2 + 0.085)]);
    for (let x = x0 + 0.5; x < x1 - 0.3; x += 1.35) mb.add(box(0.07, 1.38, 0.03), m.plastic, [x, 2.02, s * (W / 2 + 0.09)]);
    for (const dx of [-4.3, 0, 4.3]) { mb.add(box(1.9, 2.2, 0.03), m.glass, [dx, 1.5, s * (W / 2 + 0.095)]); mb.add(box(0.05, 2.2, 0.04), m.plastic, [dx, 1.5, s * (W / 2 + 0.1)]); mb.add(box(1.95, 0.06, 0.04), m.brushed, [dx, 2.62, s * (W / 2 + 0.1)]); }
    mb.add(box(L - 0.4, 0.38, 0.02), blue, [0, 0.55, s * (W / 2 + 0.085)]);
  }
  for (const sx of [1, -1]) { mb.add(box(0.02, 1.5, W - 0.5), m.glass, [sx * (x1 + 0.12), 2.0, 0]); mb.add(rbox(0.15, 0.3, W + 0.1, 0.06), m.plastic, [sx * (x1 + 0.05), 0.5, 0]); }
  for (const s of [-1, 1]) { mb.add(rbox(0.05, 0.14, 0.34, 0.03), m.head, [x1 + 0.1, 0.95, s * 1.05]); mb.add(rbox(0.05, 0.16, 0.24, 0.03), m.tail, [x0 - 0.1, 0.95, s * 1.05]); }
  mb.add(rbox(2.4, 0.3, 1.7, 0.08), m.paint(0xdfe0e0), [-3.6, 3.05, 0]); mb.add(rbox(1.4, 0.2, 1.2, 0.06), m.paint(0xdfe0e0), [3.5, 3.0, 0]);
  for (const x of [5.15, -5.15]) for (const s of [-1, 1]) wheel(mb, x, s * 1.22, 0.44, 0.3, { rim: m.rimSilver });
  for (const sx of [1, -1]) { mb.add(cylY(0.02, 0.4, 6), m.chassis, [sx * (x1 - 0.1), 2.55, 0], [0, 0, 0]); }
  mirrors(mb, x1 + 0.02, 2.4, W + 0.1);
  const name = A.add(768, 110, textDecal('APRON BUS', { color: '#0f4c8a', px: 84 }));
  const sub = A.add(640, 80, textDecal('Passenger transfer · Please hold the handrails', { color: '#465a6e', px: 36, weight: 600 }));
  const num = A.add(256, 128, textDecal('B 23', { color: '#fff', bg: '#0f4c8a', px: 80 }));
  const dest = A.add(512, 96, (g, w, h) => { g.fillStyle = '#0a0a0a'; g.fillRect(0, 0, w, h); g.fillStyle = '#ffb000'; g.font = font(700, 60, 'Share Tech Mono, monospace'); g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillText('REMOTE STAND', w / 2, h / 2); });
  for (const s of [-1, 1]) { decal(mb, A, name, 3.6, 0.52, -2.15, 1.0, s * (W / 2 + 0.1), s); decal(mb, A, sub, 3.2, 0.3, 2.15, 1.0, s * (W / 2 + 0.1), s); }
  decal(mb, A, num, 0.9, 0.45, x1 + 0.135, 1.2, 0, 'f'); decal(mb, A, dest, 1.8, 0.32, x1 + 0.13, 2.65, 0, 'f'); decal(mb, A, num, 0.9, 0.45, x0 - 0.135, 1.2, 0, 'b');
  const g = mb.build(); g.userData = { kind: 'bus', len: L + 0.3, wid: W + 0.2, doors: [-4.3, 0, 4.3] }; return g;
}
// belt loader (conveyor ramp to a cargo door; setBelt sets the top height)
function beltLoaderProto() {
  const m = mats(), mb = new MB();
  const body = m.paint(0xf2f2ef), yel = m.paint(0xf2b705);
  mb.add(rbox(6.6, 0.5, 1.9, 0.08), body, [0, 0.62, 0]); mb.add(box(6.7, 0.12, 2.0), m.plastic, [0, 0.36, 0]);
  mb.add(rbox(1.2, 0.8, 0.9, 0.06), body, [-2.4, 1.2, -0.45]); mb.add(rbox(0.5, 0.5, 0.5, 0.06), m.seat, [-2.5, 1.4, -0.45]);
  mb.add(cylY(0.17, 0.03, 16), m.plastic, [-1.95, 1.65, -0.45], [0, 0, 0.6]);
  for (const s of [-1, 1]) { wheel(mb, 2.2, s * 0.92, 0.36, 0.25); wheel(mb, -2.2, s * 0.92, 0.36, 0.25); }
  beaconLight(mb, -2.9, 1.65, -0.7, 0.07);
  const base = mb.build();
  const bm = new MB();
  bm.add(box(7.8, 0.22, 0.8), m.chassis, [0, 0, 0]); bm.add(box(7.8, 0.02, 0.68), m.beltM, [0, 0.12, 0]);
  for (const s of [-1, 1]) { bm.add(box(7.8, 0.18, 0.05), yel, [0, 0.2, s * 0.42]); bm.add(cylX(0.025, 6.8, 8), yel, [0.3, 0.75, s * 0.42]); for (let x = -3.1; x <= 3.7; x += 1.7) bm.add(cylY(0.02, 0.55, 6), yel, [x, 0.48, s * 0.42]); }
  bm.add(cylZ(0.12, 0.84, 14), m.plastic, [3.9, 0, 0]); bm.add(cylZ(0.12, 0.84, 14), m.plastic, [-3.9, 0, 0]);
  bm.add(box(0.2, 0.12, 0.9), m.hazard, [3.95, 0.12, 0]);
  const boom = bm.build();
  const g = new THREE.Group(); g.add(base, boom);
  g.userData = { kind: 'belt', len: 7.8, wid: 2.0 };
  g.userData.setBelt = (o, h) => { const lo = 0.95, ang = Math.asin(Math.min(0.6, Math.max(0, h - lo) / 7.8)); const b = o.children[1]; b.rotation.z = ang; b.position.set(0.0, lo + Math.sin(ang) * 3.9, 0); };
  g.userData.setBelt(g, 2.0);
  return g;
}
function baggageTractorProto() {
  const m = mats(), mb = new MB();
  const body = m.paint(0xf2b705, { rough: 0.45 });
  mb.add(rbox(2.7, 0.7, 1.4, 0.1), body, [0, 0.72, 0]); mb.add(rbox(1.0, 0.5, 1.3, 0.08), body, [0.75, 1.25, 0]);
  mb.add(rbox(0.5, 0.15, 0.5, 0.04), m.seat, [-0.4, 1.2, 0]); mb.add(rbox(0.12, 0.5, 0.5, 0.04), m.seat, [-0.65, 1.45, 0]);
  for (const sx of [0.25, -0.95]) for (const s of [-1, 1]) mb.add(cylY(0.03, 1.2, 6), m.chassis, [sx, 1.7, s * 0.62]);
  mb.add(rbox(1.35, 0.06, 1.4, 0.03), m.chassis, [-0.35, 2.3, 0]);
  mb.add(cylY(0.17, 0.03, 16), m.plastic, [0.2, 1.55, 0], [0, 0, 0.7]);
  for (const s of [-1, 1]) { wheel(mb, 0.85, s * 0.6, 0.32, 0.22); wheel(mb, -0.85, s * 0.6, 0.32, 0.22); mb.add(rbox(0.04, 0.12, 0.2, 0.02), m.head, [1.36, 1.25, s * 0.45]); }
  mb.add(box(0.3, 0.12, 0.12), m.chassis, [-1.45, 0.45, 0]); beaconLight(mb, -0.35, 2.33, 0, 0.07);
  const g = mb.build(); g.userData = { kind: 'bagtractor', len: 2.9, wid: 1.5 }; return g;
}
function baggageCartProto(seed = 1) {
  const m = mats(), mb = new MB(); const r = rng(seed);
  const frame = m.paint(0x3a3f45, { rough: 0.6 }), curtain = m.paint(0x1d4f8c, { rough: 0.85, clear: 0 });
  mb.add(box(3.0, 0.12, 1.45), frame, [0, 0.55, 0]); mb.add(box(3.0, 0.06, 1.45), m.plate, [0, 0.63, 0]);
  for (const x of [-1.45, 1.45]) for (const s of [-1, 1]) mb.add(box(0.07, 1.4, 0.07), frame, [x, 1.3, s * 0.68]);
  mb.add(rbox(3.08, 0.08, 1.5, 0.03), curtain, [0, 2.02, 0]);
  for (const s of [-1, 1]) { mb.add(box(3.0, 0.4, 0.02), curtain, [0, 1.78, s * 0.72]); mb.add(cylX(0.11, 3.0, 12), curtain, [0, 1.48, s * 0.72]); }
  // suitcases
  const bag = new THREE.BoxGeometry(1, 1, 1); const cols = [0x1b1d21, 0x2b3a55, 0x7a1f22, 0x4a4f55, 0x6b5a3a, 0x203d2e, 0x9a9da3];
  for (let i = 0; i < 9; i++) {
    const w = 0.45 + r() * 0.3, h = 0.25 + r() * 0.2, d = 0.65 + r() * 0.15;
    mb.add(bag, m.paint(cols[Math.floor(r() * cols.length)], { rough: 0.5, clear: 0.2 }), [-1.1 + (i % 4) * 0.72 + r() * 0.05, 0.66 + h / 2 + Math.floor(i / 4) * 0.35, (r() - 0.5) * 0.4], [0, (r() - 0.5) * 0.3, 0], [w, h, d]);
  }
  mb.add(cylX(0.04, 1.2, 8), frame, [2.05, 0.45, 0]);
  for (const s of [-1, 1]) { wheel(mb, 1.05, s * 0.6, 0.2, 0.14); wheel(mb, -1.05, s * 0.6, 0.2, 0.14); }
  const g = mb.build(); g.userData = { kind: 'cart', len: 3.6, wid: 1.5 }; return g;
}
function gpuProto() {
  const m = mats(), mb = new MB(), A = new Atlas(256, 128);
  const body = m.paint(0x2f6f9f, { rough: 0.5 });
  mb.add(rbox(2.2, 1.15, 1.3, 0.08), body, [0, 1.0, 0]);
  for (let k = 0; k < 7; k++) mb.add(box(0.9, 0.03, 0.01), m.chassis, [-0.4, 0.75 + k * 0.08, 0.655]);
  mb.add(box(0.4, 0.3, 0.02), m.plastic, [0.6, 1.25, 0.655]);
  mb.add(cylZ(0.25, 0.3, 18), m.chassis, [0.6, 1.0, -0.8]); mb.add(cylZ(0.2, 0.28, 18), m.hose, [0.6, 1.0, -0.8]);
  mb.add(cylX(0.035, 1.2, 8), m.chassis, [1.55, 0.42, 0]);
  for (const s of [-1, 1]) { wheel(mb, 0.65, s * 0.62, 0.25, 0.16); wheel(mb, -0.65, s * 0.62, 0.25, 0.16); }
  const t = A.add(256, 64, textDecal('GPU 400 Hz', { color: '#fff', px: 40 }));
  for (const s of [-1, 1]) decal(mb, A, t, 0.9, 0.22, 0, 1.4, s * 0.656, s);
  const g = mb.build(); g.userData = { kind: 'gpu', len: 2.6, wid: 1.4 }; return g;
}
// small 28 V GA ground-power cart that a line tech wheels to the cowling
function gaGpuProto() {
  const m = mats(), mb = new MB(), A = new Atlas(256, 64);
  const red = m.paint(0xb51f24);
  mb.add(rbox(0.9, 0.62, 0.6, 0.05), red, [0, 0.62, 0]); mb.add(box(0.6, 0.04, 0.5), m.chassis, [0, 0.95, 0]);
  mb.add(cylY(0.02, 0.6, 6), m.chassis, [-0.55, 1.0, 0.22], [0, 0, 0.35]); mb.add(cylY(0.02, 0.6, 6), m.chassis, [-0.55, 1.0, -0.22], [0, 0, 0.35]); mb.add(cylZ(0.025, 0.5, 6), m.chassis, [-0.65, 1.27, 0]);
  for (const s of [-1, 1]) { wheel(mb, 0.25, s * 0.34, 0.14, 0.08); wheel(mb, -0.25, s * 0.34, 0.14, 0.08); }
  const t = A.add(256, 64, textDecal('28 V DC', { color: '#fff', px: 40 }));
  for (const s of [-1, 1]) decal(mb, A, t, 0.5, 0.13, 0, 0.7, s * 0.302, s);
  const g = mb.build(); g.userData = { kind: 'gagpu', len: 1.0, wid: 0.7 }; return g;
}
// self-propelled passenger stairs; top platform at height h above the ground, front at +X
function stairsProto(h) {
  const m = mats(), mb = new MB();
  const white = m.paint(0xf2f2ef), yel = m.paint(0xf2b705);
  chassisRails(mb, -3.6, 2.6, 0.62, 0.8);
  cabOver(mb, { x0: -3.95, x1: -2.6, w: 2.0, y0: 0.75, y1: 2.2, paint: white, glassH: 0.55 });
  for (const s of [-1, 1]) { wheel(mb, 1.9, s * 0.92, 0.4, 0.26); wheel(mb, -3.0, s * 0.92, 0.4, 0.26); }
  const run = Math.max(3.6, h * 1.25), x0 = 2.6 - run, steps = Math.max(10, Math.round(h / 0.19));
  for (let i = 0; i < steps; i++) { const t = (i + 0.5) / steps; mb.add(box(run / steps + 0.03, 0.04, 1.2), m.plate, [x0 + t * run - 0.3, 1.0 + (h - 1.0) * t, 0]); }
  for (const s of [-1, 1]) {
    const len = Math.hypot(run, h - 1.0), ang = Math.atan2(h - 1.0, run);
    mb.add(box(len, 0.28, 0.06), white, [x0 + run / 2 - 0.3, 1.0 + (h - 1.0) / 2 - 0.1, s * 0.63], [0, 0, ang]);
    mb.add(cylX(0.025, len, 8), yel, [x0 + run / 2 - 0.3, 1.0 + (h - 1.0) / 2 + 0.95, s * 0.66], [0, 0, ang]);
    for (let k = 0; k <= 4; k++) { const t = k / 4; mb.add(cylY(0.02, 0.95, 6), yel, [x0 + t * run - 0.3, 1.0 + (h - 1.0) * t + 0.48, s * 0.66]); }
    mb.add(box(0.12, h - 0.6, 0.12), m.chassis, [2.2, (h - 0.6) / 2 + 0.6, s * 0.55]);
  }
  mb.add(box(1.2, 0.08, 1.4), m.plate, [2.75, h, 0]); mb.add(box(0.2, 0.25, 1.5), m.plastic, [3.36, h - 0.05, 0]);
  mb.add(rbox(1.3, 0.06, 1.5, 0.02), white, [2.6, h + 2.15, 0]); for (const s of [-1, 1]) mb.add(box(0.06, 2.1, 0.06), white, [2.05, h + 1.07, s * 0.72]);
  for (const s of [-1, 1]) mb.add(box(1.2, 0.9, 0.02), m.glass, [2.6, h + 1.4, s * 0.72]);
  beaconLight(mb, -3.3, 2.2, 0, 0.07);
  const g = mb.build(); g.userData = { kind: 'stairs', len: 7.6, wid: 2.2, h, bottomX: x0 - 0.5 }; return g;
}
function coneGeo(mb, x, z) { const m = mats(); mb.add(cylY(0.03, 0.7, 12, 0.18), m.cone, [x, 0.37, z]); mb.add(box(0.4, 0.04, 0.4), m.cone, [x, 0.02, z]); mb.add(cylY(0.105, 0.1, 12, 0.13), m.reflect, [x, 0.45, z]); }
function ladderProto() {
  const m = mats(), mb = new MB();
  for (const s of [-1, 1]) { mb.add(box(0.05, 1.6, 0.04), m.brushed, [0.35, 0.78, s * 0.24], [0, 0, 0.21]); mb.add(box(0.05, 1.6, 0.04), m.brushed, [-0.35, 0.78, s * 0.24], [0, 0, -0.21]); }
  for (let k = 1; k <= 4; k++) mb.add(box(0.12, 0.025, 0.5), m.plate, [0.35 - k * 0.07, k * 0.3, 0]);
  mb.add(box(0.3, 0.04, 0.55), m.plate, [0, 1.55, 0]);
  const g = mb.build(); g.userData = { kind: 'ladder' }; return g;
}
function handCartProto() {
  const m = mats(), mb = new MB(); const r = rng(5);
  mb.add(box(1.0, 0.05, 0.6), m.plate, [0, 0.3, 0]); for (const s of [-1, 1]) mb.add(cylY(0.018, 0.75, 6), m.chassis, [-0.48, 0.66, s * 0.26]); mb.add(cylZ(0.02, 0.55, 6), m.chassis, [-0.48, 1.02, 0]);
  for (const s of [-1, 1]) { wheel(mb, 0.35, s * 0.3, 0.1, 0.05); wheel(mb, -0.35, s * 0.3, 0.1, 0.05); }
  const cols = [0x1b1d21, 0x7a1f22, 0x2b3a55, 0x4a4f55];
  for (let i = 0; i < 3; i++) mb.add(new THREE.BoxGeometry(1, 1, 1), m.paint(cols[i], { rough: 0.5, clear: 0.2 }), [-0.2 + i * 0.3, 0.48 + (i === 2 ? 0.2 : 0), 0], [0, 0, 0], [0.26, 0.34 + r() * 0.1, 0.5]);
  const g = mb.build(); g.userData = { kind: 'handcart', len: 1.1, wid: 0.65 }; return g;
}
function coolerProto() { const m = mats(), mb = new MB(); mb.add(rbox(0.55, 0.38, 0.36, 0.04), m.paint(0x1f5fa8), [0, 0, 0]); mb.add(rbox(0.57, 0.06, 0.38, 0.02), m.paint(0xf2f2f2), [0, 0.2, 0]); return mb.build(); }
function rollerBagProto(col) { const m = mats(), mb = new MB(); mb.add(rbox(0.36, 0.55, 0.22, 0.04), m.paint(col, { rough: 0.45, clear: 0.3 }), [0, 0.36, 0]); mb.add(cylY(0.01, 0.4, 6), m.chrome, [0, 0.83, 0.07]); mb.add(cylY(0.01, 0.4, 6), m.chrome, [0, 0.83, -0.07]); mb.add(box(0.02, 0.03, 0.17), m.plastic, [0, 1.03, 0]); for (const s of [-1, 1]) mb.add(cylZ(0.03, 0.03, 8), m.plastic, [-0.12, 0.04, s * 0.09]); return mb.build(); }

export const GSE = {
  avgas: () => proto('avgas', avgasTruckProto), jet: () => proto('jet', jetTruckProto), catering: () => proto('catering', cateringTruckProto),
  van: () => proto('van', () => vanProto()), tug: () => proto('tug', tugProto), gatug: () => proto('gatug', gaTugProto), bus: () => proto('bus', busProto),
  belt: () => proto('belt', beltLoaderProto), bagtractor: () => proto('bagtractor', baggageTractorProto), cart: (s = 1) => proto('cart' + (s % 3), () => baggageCartProto(s % 3 + 1)),
  gpu: () => proto('gpu', gpuProto), gagpu: () => proto('gagpu', gaGpuProto), ladder: () => proto('ladder', ladderProto), handcart: () => proto('handcart', handCartProto),
  cooler: () => proto('cooler', coolerProto), rollerBag: (c = 0x2b3a55) => proto('bag' + c, () => rollerBagProto(c)),
  stairs: (h) => { const k = Math.round(h * 4) / 4; return proto('stairs' + k, () => stairsProto(k)); },
  cones(list) { const mb = new MB(); for (const [x, z] of list) coneGeo(mb, x, z); return mb.build(); },
};
// clone a vehicle prototype but keep the animation helpers callable on the clone
export function setLift(o, h) { o.userData.setLift?.(o, h); }
export function setBelt(o, h) { o.userData.setBelt?.(o, h); }
export function setTowbar(o, on) { o.userData.setTowbar?.(o, on); }

// ------------------------------------------------------------------ hoses / cables
export function hoseMesh(points, r = 0.045, mat = null) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => p.clone()));
  const m = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(16, points.length * 10), r, 8, false), mat || mats().hose); m.castShadow = true; return m;
}
// a sagging cable between two points
export function sagPoints(a, b, sag = 0.6, n = 8) {
  const out = []; for (let i = 0; i <= n; i++) { const t = i / n; const p = a.clone().lerp(b, t); p.y -= Math.sin(t * Math.PI) * sag; out.push(p); } return out;
}

// ------------------------------------------------------------------ people
const SKIN = [0xf1c8a6, 0xd9a47e, 0xb57d58, 0x8d5a3b, 0x5e3b26, 0xe8b893];
const HAIR = [0x1d1510, 0x3b2617, 0x6b4a2b, 0xb08a58, 0x2a2a2a, 0x888888];
const SHIRT = [0x2e4a7a, 0x7a2e2e, 0xe7e2d5, 0x2f5d3a, 0x444a52, 0xb08d57, 0x5a3f6e, 0x1d1d1f, 0xd0d4d9];
const PANTS = [0x1f2a3d, 0x2b2b2e, 0x5a4b3a, 0x3c4f6b, 0x6a6458];
function colored(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo; const c = new THREE.Color(hex); const n = g.attributes.position.count; const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3)); for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k); return g;
}
function cm(list) { return mergeGeometries(list, false); }
const PERSON_CACHE = new Map();
// kind: 'crew' (hi-vis, ear defenders), 'fuel' (coveralls + vest), 'pax', 'chef'
export function makePerson(kind = 'crew', seed = 1) {
  const r = rng(seed * 977 + kind.length);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const skin = pick(SKIN), hair = pick(HAIR);
  const shirt = kind === 'pax' ? pick(SHIRT) : kind === 'chef' ? 0xf2f2f2 : kind === 'fuel' ? 0x23324a : 0x1d2b45;
  const pants = kind === 'pax' ? pick(PANTS) : kind === 'chef' ? 0x222428 : 0x1e2533;
  const vest = kind === 'crew' ? (r() < 0.5 ? 0xd8ff1e : 0xff7a12) : kind === 'fuel' ? 0xd8ff1e : null;
  const h = kind === 'pax' ? 0.92 + r() * 0.16 : 0.97 + r() * 0.1;
  const key = [kind, skin, hair, shirt, pants, vest, Math.round(h * 50)].join(':');
  let parts = PERSON_CACHE.get(key);
  if (!parts) {
    const torso = [
      colored(new THREE.CapsuleGeometry(0.17, 0.36, 4, 10).scale(1, 1, 0.66).translate(0, 1.22, 0), shirt),
      colored(new THREE.CylinderGeometry(0.16, 0.15, 0.2, 10).scale(1, 1, 0.7).translate(0, 0.94, 0), pants),
      colored(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 8).translate(0, 1.52, 0), skin),
      colored(new THREE.SphereGeometry(0.105, 14, 10).scale(0.95, 1.12, 0.92).translate(0.01, 1.66, 0), skin),
      colored(new THREE.SphereGeometry(0.112, 14, 8, 0, TAU, 0, Math.PI * 0.5).scale(0.98, 1.1, 0.96).translate(-0.01, 1.68, 0), hair),
      colored(new THREE.BoxGeometry(0.02, 0.025, 0.08).translate(0.1, 1.68, 0), 0x1a1a1a),
    ];
    if (vest) {
      torso.push(colored(new THREE.CapsuleGeometry(0.182, 0.3, 4, 10).scale(1, 1, 0.68).translate(0, 1.2, 0), vest));
      for (const y of [1.08, 1.2]) torso.push(colored(new THREE.CylinderGeometry(0.186, 0.186, 0.035, 12, 1, true).scale(1, 1, 0.69).translate(0, y, 0), 0xdadada));
    }
    if (kind === 'crew') for (const s of [-1, 1]) torso.push(colored(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 10).rotateX(Math.PI / 2).translate(0, 1.66, s * 0.11), 0xc21f1f));
    if (kind === 'chef') torso.push(colored(new THREE.CylinderGeometry(0.1, 0.09, 0.12, 12).translate(0, 1.82, 0), 0xf6f6f6));
    if (kind === 'crew' || kind === 'fuel') torso.push(colored(new THREE.SphereGeometry(0.118, 14, 6, 0, TAU, 0, Math.PI * 0.42).translate(0, 1.7, 0), kind === 'fuel' ? 0x23324a : 0x1d2b45));
    const leg = cm([colored(new THREE.CapsuleGeometry(0.068, 0.7, 4, 8).translate(0, -0.42, 0), pants), colored(new THREE.BoxGeometry(0.26, 0.08, 0.11).translate(0.05, -0.87, 0), 0x141414)]);
    const arm = cm([colored(new THREE.CapsuleGeometry(0.05, 0.5, 4, 8).translate(0, -0.3, 0), vest && kind !== 'crew' ? shirt : shirt), colored(new THREE.SphereGeometry(0.048, 8, 6).translate(0, -0.62, 0), skin)]);
    parts = { torso: cm(torso), leg, arm };
    PERSON_CACHE.set(key, parts);
  }
  const m = mats();
  const root = new THREE.Group(); const body = new THREE.Group(); body.scale.setScalar(h); root.add(body);
  const t = new THREE.Mesh(parts.torso, m.person); t.castShadow = true; body.add(t);
  const limbs = [];
  for (const s of [-1, 1]) {
    const lp = new THREE.Group(); lp.position.set(0, 0.92, s * 0.09); const l = new THREE.Mesh(parts.leg, m.person); l.castShadow = true; lp.add(l); body.add(lp);
    const ap = new THREE.Group(); ap.position.set(0, 1.43, s * 0.22); const a = new THREE.Mesh(parts.arm, m.person); a.castShadow = true; ap.add(a); body.add(ap);
    limbs.push({ lp, ap, s });
  }
  root.userData = { kind, limbs, phase: r() * TAU, carry: null, body };
  return root;
}
// walk-cycle pose; speed in m/s (0 = standing); carry = true holds both arms forward
export function posePerson(p, dt, speed, { carry = false, work = 0 } = {}) {
  const u = p.userData; u.phase += dt * (speed > 0.05 ? 2.0 + speed * 2.6 : 0);
  const sw = speed > 0.05 ? Math.min(0.55, 0.25 + speed * 0.22) : 0;
  for (const { lp, ap, s } of u.limbs) {
    lp.rotation.z = Math.sin(u.phase + (s > 0 ? Math.PI : 0)) * sw;
    if (carry) { ap.rotation.z = 1.0; ap.rotation.x = s * 0.12; }
    else if (work) { ap.rotation.z = 0.6 + Math.sin(u.phase * 0.7 + work + s) * 0.35; ap.rotation.x = s * 0.1; u.phase += dt * 1.5; }
    else { ap.rotation.z = -Math.sin(u.phase + (s > 0 ? Math.PI : 0)) * sw * 0.8; ap.rotation.x = s * 0.06; }
  }
  u.body.position.y = speed > 0.05 ? Math.abs(Math.sin(u.phase)) * 0.025 : 0;
}

// ------------------------------------------------------------------ jet bridge (apron-drive passenger boarding bridge)
// Built in world space. rot: rotunda centre {x,z}, ground gr, floor yR; wall normal n (unit, pointing onto the apron).
export class JetBridge {
  constructor({ rot, gr, yR, n, label = '', atlas = null, labelRect = null }) {
    const m = mats();
    this.rot = rot; this.gr = gr; this.yR = yR; this.n = n;
    this.group = new THREE.Group();
    // rotunda: column + drum + fixed link to the terminal wall
    const st = new MB();
    st.add(cylY(0.55, yR - gr - 0.3, 16), m.concrete, [rot.x, gr + (yR - gr - 0.3) / 2, rot.z]);
    st.add(cylY(2.1, 3.1, 28), m.tunnelRoof, [rot.x, yR + 1.25, rot.z]);
    st.add(cylY(2.25, 0.22, 28), m.chassis, [rot.x, yR + 2.9, rot.z]);
    st.add(cylY(2.13, 1.1, 28, 2.13), m.glass, [rot.x, yR + 1.6, rot.z]);
    const back = 4.2, wall = { x: rot.x - n.x * back, z: rot.z - n.z * back };
    const yaw = Math.atan2(-n.z, n.x); // +X local along n
    const link = new THREE.Mesh(metricBox(back, 3.0, 2.8, 4), m.tunnel); link.position.set((rot.x + wall.x) / 2, yR + 1.25, (rot.z + wall.z) / 2); link.rotation.y = yaw; link.updateMatrixWorld(); st.addM(link.geometry, m.tunnel, link.matrixWorld);
    const lroof = new THREE.Mesh(box(back, 0.15, 3.0), m.tunnelRoof); lroof.position.set((rot.x + wall.x) / 2, yR + 2.82, (rot.z + wall.z) / 2); lroof.rotation.y = yaw; lroof.updateMatrixWorld(); st.addM(lroof.geometry, m.tunnelRoof, lroof.matrixWorld);
    if (atlas && labelRect) { // gate number sign on the drum
      const s = new THREE.Mesh(decalGeo(1.6, 0.8, labelRect), atlas.material()); s.position.set(rot.x + n.x * 2.2, yR + 2.3, rot.z + n.z * 2.2); s.rotation.y = Math.atan2(n.x, n.z); s.updateMatrixWorld(); st.addM(s.geometry, s.material, s.matrixWorld);
    }
    this.static = st.build(); this.group.add(this.static);
    // tunnel sections (local +X along the tunnel, origin at the start)
    this.outer = new THREE.Group(); this.inner = new THREE.Group(); this.cab = new THREE.Group(); this.drive = new THREE.Group();
    this.group.add(this.outer, this.inner, this.cab, this.drive);
    this.label = label;
  }
  _tunnel(grp, L, w, h) {
    const m = mats(); while (grp.children.length) grp.remove(grp.children[0]);
    const mb = new MB();
    mb.add(metricBox(L, h, w, 4), m.tunnel, [L / 2, h / 2, 0]);
    mb.add(box(L + 0.05, 0.14, w + 0.16), m.tunnelRoof, [L / 2, h + 0.05, 0]);
    mb.add(box(L, 0.2, w + 0.04), m.chassis, [L / 2, -0.02, 0]);
    for (const s of [-1, 1]) mb.add(box(L, 0.06, 0.08), m.brushed, [L / 2, h * 0.27, s * (w / 2 + 0.03)]);
    for (let x = 0.4; x < L; x += 4) for (const s of [-1, 1]) mb.add(box(0.12, h, 0.05), m.tunnelRoof, [x, h / 2, s * (w / 2 + 0.02)]);
    mb.build(grp);
  }
  // pose the bridge so the cab sill sits at door point D (Vector3, world) facing back along nOut (unit vector out of the fuselage)
  pose(D, nOut, { gap = 0.25 } = {}) {
    const m = mats();
    const cabD = 3.0, cabW = 3.6, cabH = 3.0;
    const J = V3(D.x + nOut.x * (gap + cabD), D.y, D.z + nOut.z * (gap + cabD));
    const P0 = V3(this.rot.x, this.yR, this.rot.z);
    const dir = J.clone().sub(P0); const flat = Math.hypot(dir.x, dir.z); const L = Math.max(4, flat - 2.0);
    const yaw = Math.atan2(-dir.z, dir.x), pitch = Math.atan2(J.y - this.yR, flat);
    const start = V3(this.rot.x + dir.x / flat * 2.0, this.yR, this.rot.z + dir.z / flat * 2.0);
    if (!this._built) {
      this._built = true; this.L0 = L; this.Lo = L * 0.58; this.Li = L * 0.5;
      this._tunnel(this.outer, this.Lo, 2.9, 2.85); this._tunnel(this.inner, this.Li, 2.6, 2.6);
      // cab
      while (this.cab.children.length) this.cab.remove(this.cab.children[0]);
      const cb = new MB();
      cb.add(metricBox(cabD, cabH, cabW, 3), m.tunnel, [-cabD / 2, cabH / 2, 0]);
      cb.add(box(cabD + 0.1, 0.16, cabW + 0.14), m.tunnelRoof, [-cabD / 2, cabH + 0.06, 0]);
      cb.add(box(cabD, 0.22, cabW), m.chassis, [-cabD / 2, -0.02, 0]);
      for (const s of [-1, 1]) cb.add(box(1.6, 1.2, 0.03), m.glass, [-cabD * 0.45, cabH * 0.62, s * (cabW / 2 + 0.02)]);
      // accordion canopy closing onto the fuselage
      for (let k = 0; k < 5; k++) cb.add(box(0.08, cabH * 0.95, cabW * 0.94), m.bellows, [0.04 + k * 0.05, cabH * 0.5, 0]);
      cb.add(box(0.12, 0.12, cabW * 0.9), m.hazard, [0.3, 0.05, 0]);
      cb.add(box(0.4, 0.16, 1.0), m.plastic, [0.2, cabH * 0.5, cabW / 2 - 0.55]);
      // service stair down to the apron
      for (let k = 0; k < 10; k++) cb.add(box(0.3, 0.04, 0.9), m.plate, [-cabD - 0.25 - k * 0.27, -0.25 - k * ((D.y - this.gr - 0.3) / 10), cabW / 2 - 0.5]);
      cb.build(this.cab);
      // drive column + bogie (built in local space, y relative to the ground)
      while (this.drive.children.length) this.drive.remove(this.drive.children[0]);
      const dv = new MB(); const colH = D.y - this.gr - 0.4;
      for (const s of [-1, 1]) { dv.add(box(0.34, colH, 0.34), m.tunnelRoof, [0, 0.55 + colH / 2, s * 0.9]); dv.add(cylY(0.09, colH * 0.8, 10), m.chrome, [0.25, 0.55 + colH * 0.45, s * 0.9]); }
      dv.add(box(0.5, 0.35, 2.4), m.chassis, [0, D.y - this.gr - 0.25, 0]);
      dv.add(rbox(1.5, 0.45, 2.4, 0.06), m.chassis, [0, 0.62, 0]);
      for (const s of [-1, 1]) dv.add(tireGeo(0.5, 0.36), m.rubber, [0, 0.5, s * 1.0]);
      dv.add(box(0.2, 0.2, 2.2), m.hazard, [0.76, 0.62, 0]);
      dv.build(this.drive);
    }
    this.outer.position.copy(start); this.outer.rotation.set(0, yaw, pitch, 'YZX');
    const innerStart = J.clone().sub(V3(Math.cos(yaw) * Math.cos(pitch) * this.Li, Math.sin(pitch) * this.Li, -Math.sin(yaw) * Math.cos(pitch) * this.Li));
    this.inner.position.set(innerStart.x, innerStart.y + 0.12, innerStart.z); this.inner.rotation.set(0, yaw, pitch, 'YZX');
    this.cab.position.set(D.x + nOut.x * gap, D.y, D.z + nOut.z * gap); this.cab.rotation.set(0, Math.atan2(nOut.z, -nOut.x), 0);
    const dp = J.clone().sub(V3(Math.cos(yaw) * 1.6, 0, -Math.sin(yaw) * 1.6));
    this.drive.position.set(dp.x, this.gr, dp.z); this.drive.rotation.set(0, yaw, 0);
    this.D = D.clone(); this.nOut = nOut.clone();
  }
}
// gate number sign atlas for one airport
export function gateSignAtlas(labels) {
  const A = new Atlas(1024, 1024); const rects = {};
  for (const l of labels) rects[l] = A.add(128, 64, (g, w, h) => { g.fillStyle = '#0d1b2a'; g.fillRect(0, 0, w, h); g.fillStyle = '#ffcc00'; g.font = font(800, 44); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(l, w / 2, h / 2 + 2); });
  return { atlas: A, rects };
}
export { mats as gseMaterials };
