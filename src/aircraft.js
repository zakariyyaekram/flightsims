// Procedural Cessna 172S Skyhawk SP model built from POH three-view dimensions.
// Body frame = FDM frame: +x forward, +y up, +z right, origin at CG. 1 unit = 1 m.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { tex, PH } from './textures.js';

const lerp = (a, b, t) => a + (b - a) * t;
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------------- Shared GLSL: rivets, panel lines, screws ----------------
const RIVET_GLSL = `
float rivetDot(vec2 uv, float pitch, float r){ vec2 c = vec2(fract(uv.x/pitch)-.5, uv.y); float d = length(vec2(c.x*pitch, c.y)); return 1.-smoothstep(r*.55, r, d); }
// height field: rivet heads along lines
float rivetRow(float along, float across, float pitch, float r){ vec2 c = vec2((fract(along/pitch)-.5)*pitch, across); float d = length(c); return (1.-smoothstep(r*.5, r, d)); }
vec3 bumpN(vec3 n, vec3 vpos, float h, float k){
  vec3 dpx = dFdx(vpos), dpy = dFdy(vpos); float hx = dFdx(h), hy = dFdy(h);
  vec3 r1 = cross(dpy, n), r2 = cross(n, dpx); float det = dot(dpx, r1);
  vec3 g = sign(det) * (hx * r1 + hy * r2);
  return normalize(abs(det) * n - g * k);
}
`;

// ---------------- Geometry helpers ----------------
// Superellipse section (half-width w, top, bottom, exponent n) -> point at angle t (0 = top, PI/2 = right)
function sectionPoint(s, t) {
  const n = s.n;
  const st = Math.sin(t), ct = Math.cos(t);
  const z = s.w * Math.sign(st) * Math.pow(Math.abs(st), 2 / n);
  const yc = (s.top + s.bot) / 2, hh = (s.top - s.bot) / 2;
  const y = yc + hh * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / n);
  return [y, z];
}
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
function interpStations(st, x) {
  // st sorted descending x
  let i = 0;
  while (i < st.length - 2 && x < st[i + 1].x) i++;
  const a = st[Math.max(0, i - 1)], b = st[i], c = st[i + 1], d = st[Math.min(st.length - 1, i + 2)];
  const t = (b.x - x) / (b.x - c.x);
  const o = {};
  for (const k of ['w', 'top', 'bot', 'n']) o[k] = catmull(a[k], b[k], c[k], d[k], Math.min(1, Math.max(0, t)));
  return o;
}

// NACA 4-digit airfoil
function naca(m, p, tt, xc) {
  const yt = 5 * tt * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
  let yc = 0, dy = 0;
  if (m > 0) {
    if (xc < p) { yc = (m / (p * p)) * (2 * p * xc - xc * xc); dy = (2 * m / (p * p)) * (p - xc); }
    else { yc = (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * xc - xc * xc); dy = (2 * m / ((1 - p) ** 2)) * (p - xc); }
  }
  const th = Math.atan(dy);
  return { xu: xc - yt * Math.sin(th), yu: yc + yt * Math.cos(th), xl: xc + yt * Math.sin(th), yl: yc - yt * Math.cos(th) };
}
// closed profile of airfoil between chord fractions c0..c1 (counter-clockwise: upper TE->LE, lower LE->TE)
function airfoilLoop(m, p, t, c0, c1, n = 28) {
  const pts = [];
  const xs = [];
  for (let i = 0; i <= n; i++) { const b = (i / n) * Math.PI; xs.push(c0 + (c1 - c0) * (1 - Math.cos(b)) / 2); }
  // upper from c1 to c0
  for (let i = xs.length - 1; i >= 0; i--) { const a = naca(m, p, t, xs[i]); pts.push([a.xu, a.yu]); }
  // lower from c0 to c1
  for (let i = 1; i < xs.length; i++) { const a = naca(m, p, t, xs[i]); pts.push([a.xl, a.yl]); }
  return pts;
}
// Loft a closed profile along span stations. stations: [{z, le:[x,y], chord, twist(rad), dihedral handled by y}]
// Profile coords (u along chord 0..1 fwd->aft, v up). Output UV: (span m, chord m).
function loftProfile(stations, profileFn, { capStart = true, capEnd = true, axis = 'z' } = {}) {
  const pos = [], uv = [], idx = [];
  const prof0 = profileFn(stations[0]);
  const P = prof0.length;
  stations.forEach((s, si) => {
    const prof = profileFn(s);
    for (let k = 0; k < P; k++) {
      const [u, v] = prof[k];
      // chord runs toward -x from LE
      let lx = -u * s.chord, ly = v * s.chord * (s.thick ?? 1);
      // twist about quarter chord
      const qc = -0.25 * s.chord;
      const ct = Math.cos(s.twist || 0), st = Math.sin(s.twist || 0);
      const dx = lx - qc;
      const rx = qc + dx * ct - ly * st, ry = dx * st + ly * ct;
      if (axis === 'z') pos.push(s.le[0] + rx, s.le[1] + ry, s.z);
      else pos.push(s.le[0] + rx, s.z, s.le[1] + ry); // vertical surfaces: span along y, thickness along z
      uv.push(s.z, u * s.chord + (v > 0 ? 0 : 3));
    }
    if (si > 0) {
      const a0 = (si - 1) * P, b0 = si * P;
      for (let k = 0; k < P - 1; k++) idx.push(a0 + k, b0 + k, a0 + k + 1, a0 + k + 1, b0 + k, b0 + k + 1);
      idx.push(a0 + P - 1, b0 + P - 1, a0, a0, b0 + P - 1, b0);
    }
  });
  const S = stations.length;
  const addCap = (si, flip) => {
    const base = pos.length / 3;
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < P; k++) { cx += pos[(si * P + k) * 3]; cy += pos[(si * P + k) * 3 + 1]; cz += pos[(si * P + k) * 3 + 2]; }
    pos.push(cx / P, cy / P, cz / P); uv.push(0, 0);
    for (let k = 0; k < P; k++) {
      const a = si * P + k, b = si * P + ((k + 1) % P);
      if (flip) idx.push(base, b, a); else idx.push(base, a, b);
    }
  };
  if (capStart) addCap(0, false);
  if (capEnd) addCap(S - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
function flipIfNeeded(g, flip) { if (!flip) return g; const idx = g.index.array; for (let i = 0; i < idx.length; i += 3) { const t = idx[i]; idx[i] = idx[i + 2]; idx[i + 2] = t; } g.computeVertexNormals(); return g; }

function lathe(profile, seg = 32) { return new THREE.LatheGeometry(profile.map((p) => new THREE.Vector2(p[0], p[1])), seg); }
function tube(points, r, seg = 24, radial = 10) {
  const c = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return new THREE.TubeGeometry(c, seg, r, radial, false);
}
// Streamlined strut between two points: elliptical section
function strut(a, b, chord, thick, seg = 1) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const L = A.distanceTo(B);
  const shape = new THREE.Shape();
  const n = 20;
  for (let i = 0; i <= n; i++) { const t = (i / n) * Math.PI * 2; const x = Math.cos(t) * chord / 2, y = Math.sin(t) * thick / 2 * (Math.cos(t) < 0 ? 1 : 0.75 + 0.25 * (1 - Math.cos(t))); if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y); }
  const g = new THREE.ExtrudeGeometry(shape, { depth: L, bevelEnabled: false, steps: seg });
  // extrude along +z; orient z->AB, x (chord) -> body +x roughly
  const dir = B.clone().sub(A).normalize();
  const m = new THREE.Matrix4();
  const zAxis = dir; let xAxis = new THREE.Vector3(1, 0, 0); xAxis.sub(zAxis.clone().multiplyScalar(xAxis.dot(zAxis))).normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
  m.makeBasis(xAxis, yAxis, zAxis); m.setPosition(A);
  g.applyMatrix4(m);
  return g;
}
function place(g, { p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1] } = {}) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r, 'XYZ')), new THREE.Vector3(...s));
  g.applyMatrix4(m); return g;
}

// ---------------- Fuselage definition ----------------
// stations descending x. w: half width, top/bot: y, n: superellipse exponent
const FUSE = [
  { x: 2.08, w: 0.27, top: 0.20, bot: -0.27, n: 2.0 },
  { x: 1.95, w: 0.40, top: 0.27, bot: -0.40, n: 2.2 },
  { x: 1.70, w: 0.50, top: 0.34, bot: -0.52, n: 2.5 },
  { x: 1.35, w: 0.54, top: 0.40, bot: -0.58, n: 2.7 },
  { x: 1.05, w: 0.555, top: 0.43, bot: -0.61, n: 2.9 },
  { x: 0.82, w: 0.565, top: 0.47, bot: -0.63, n: 3.0 },
  { x: 0.62, w: 0.57, top: 0.74, bot: -0.635, n: 3.1 },
  { x: 0.45, w: 0.575, top: 0.92, bot: -0.635, n: 3.2 },
  { x: 0.00, w: 0.575, top: 0.945, bot: -0.62, n: 3.3 },
  { x: -0.55, w: 0.56, top: 0.945, bot: -0.57, n: 3.2 },
  { x: -1.00, w: 0.53, top: 0.90, bot: -0.48, n: 3.0 },
  { x: -1.45, w: 0.47, top: 0.66, bot: -0.38, n: 2.8 },
  { x: -1.90, w: 0.40, top: 0.50, bot: -0.29, n: 2.6 },
  { x: -2.60, w: 0.31, top: 0.39, bot: -0.17, n: 2.4 },
  { x: -3.40, w: 0.23, top: 0.31, bot: -0.05, n: 2.3 },
  { x: -4.20, w: 0.16, top: 0.26, bot: 0.03, n: 2.2 },
  { x: -4.95, w: 0.10, top: 0.23, bot: 0.09, n: 2.1 },
  { x: -5.55, w: 0.055, top: 0.20, bot: 0.13, n: 2.0 },
  { x: -5.85, w: 0.02, top: 0.175, bot: 0.155, n: 2.0 },
];
export function fuselageTop(x) { return interpStations(FUSE, Math.max(-5.84, Math.min(2.07, x))).top; }

function buildFuselageGeometry(inset = 0) {
  const xs = [];
  for (let x = 2.08; x >= -5.85; x -= x > -1.8 && x < 1.2 ? 0.04 : 0.08) xs.push(x);
  xs.push(-5.85);
  const R = 72;
  const pos = [], uv = [], idx = [];
  xs.forEach((x, i) => {
    const s = interpStations(FUSE, x);
    const sec = { w: s.w - inset, top: s.top - inset, bot: s.bot + inset, n: s.n };
    let arc = 0, prev = null;
    for (let j = 0; j <= R; j++) {
      const t = (j / R) * Math.PI * 2;
      const [y, z] = sectionPoint(sec, t);
      if (prev) arc += Math.hypot(y - prev[0], z - prev[1]);
      prev = [y, z];
      pos.push(x, y, z);
      uv.push(x, arc);
    }
    if (i > 0) {
      const a0 = (i - 1) * (R + 1), b0 = i * (R + 1);
      for (let j = 0; j < R; j++) idx.push(a0 + j, b0 + j, a0 + j + 1, a0 + j + 1, b0 + j, b0 + j + 1);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// window masks in body coords (GLSL) — returns 1 inside glass
const WINDOW_GLSL = `
float rbox(vec2 p, vec2 c, vec2 h, float r){ vec2 d = abs(p-c) - h + r; return length(max(d,0.)) + min(max(d.x,d.y),0.) - r; }
float glassMask(vec3 P, vec3 N){
  float side = abs(P.z);
  // one-piece windshield (wraps from A-pillar to A-pillar)
  float ws = -1e3;
  if (P.x > 0.505 && P.x < 0.80 && P.y > 0.455) ws = 1.0;
  // door windows
  float dw = rbox(vec2(P.x, P.y), vec2(-0.02, 0.655), vec2(0.43, 0.215), 0.06);
  dw = max(dw, (P.x - 0.47) + (P.y-0.45)*0.18);
  float isSide = step(0.25, abs(N.z));
  // rear side windows
  float rw = rbox(vec2(P.x, P.y), vec2(-0.99, 0.62), vec2(0.40, 0.19), 0.07);
  float topAt = 0.93 - smoothstep(-0.9, -1.55, P.x)*0.34;
  rw = max(rw, P.y - (topAt - 0.065));
  // Omni-Vision rear window (wraps over top)
  float ov = (P.x < -1.07 && P.x > -1.78 && P.y > 0.47 && N.y > 0.25 && side < 0.40) ? 1.0 : 0.0;
  float g = 0.;
  if (ws > 0.) g = 1.;
  if (dw < 0. && isSide > 0.) g = 1.;
  if (rw < 0. && isSide > 0.) g = 1.;
  if (ov > 0.) g = 1.;
  return g;
}
float frameDist(vec3 P, vec3 N){
  // distance to nearest window edge (for seals) approx
  float dw = abs(rbox(vec2(P.x, P.y), vec2(-0.02, 0.655), vec2(0.43, 0.215), 0.06));
  float rw = abs(rbox(vec2(P.x, P.y), vec2(-0.99, 0.62), vec2(0.40, 0.19), 0.07));
  float wsx = min(abs(P.x - 0.505), abs(P.x-0.80));
  return min(min(dw, rw), wsx);
}
`;

function makeLiveryTexture(reg = 'N172SP', scheme = 0) {
  const c = document.createElement('canvas'); c.width = 4096; c.height = 1024;
  const g = c.getContext('2d');
  const schemes = [
    { base: '#f4f4f1', a: '#1c2b52', b: '#b0212b' },
    { base: '#f2f0ea', a: '#7b1d1d', b: '#c9a24a' },
    { base: '#eef1f4', a: '#0f5c4d', b: '#2b2b2b' },
    { base: '#f5f5f5', a: '#24477a', b: '#e0a22c' },
  ];
  const S = schemes[scheme % schemes.length];
  g.fillStyle = S.base; g.fillRect(0, 0, 4096, 1024);
  // each half: u = 0..1 along x from nose(2.08) to tail(-5.85); v = 0..1 maps y from -0.7 to 1.0
  const drawSide = (y0, mirror) => {
    g.save();
    g.translate(0, y0);
    if (mirror) { g.translate(4096, 0); g.scale(-1, 1); }
    const X = (x) => ((2.08 - x) / 7.93) * 4096; // x body -> px (left side reads nose->tail)
    const Y = (y) => (1 - (y + 0.7) / 1.7) * 512;
    // swoosh stripes
    g.fillStyle = S.a;
    g.beginPath(); g.moveTo(X(2.1), Y(-0.05)); g.bezierCurveTo(X(0.6), Y(-0.12), X(-1.6), Y(0.02), X(-5.9), Y(0.22));
    g.lineTo(X(-5.9), Y(0.17)); g.bezierCurveTo(X(-1.6), Y(-0.06), X(0.6), Y(-0.22), X(2.1), Y(-0.16)); g.fill();
    g.fillStyle = S.b;
    g.beginPath(); g.moveTo(X(2.1), Y(-0.20)); g.bezierCurveTo(X(0.6), Y(-0.26), X(-1.6), Y(-0.10), X(-5.9), Y(0.15));
    g.lineTo(X(-5.9), Y(0.13)); g.bezierCurveTo(X(-1.6), Y(-0.15), X(0.6), Y(-0.31), X(2.1), Y(-0.26)); g.fill();
    // belly accent
    g.fillStyle = S.a; g.fillRect(X(2.1), Y(-0.57), X(-5.9) - X(2.1), Y(-0.75) - Y(-0.57));
    g.restore();
  };
  drawSide(0, false);
  drawSide(512, true);
  // registration letters: drawn unmirrored on both halves (right side text must also read normally)
  const X = (x) => ((2.08 - x) / 7.93) * 4096;
  const Y = (y) => (1 - (y + 0.7) / 1.7) * 512;
  g.fillStyle = S.a; g.font = '700 118px "Barlow Condensed", "Arial Narrow", sans-serif'; g.textBaseline = 'middle';
  g.fillText(reg, X(-2.15), Y(0.13));
  // right side: mirrored half -> text placed at mirrored x, reading normally
  g.save(); g.translate(0, 512);
  const w = g.measureText(reg).width;
  g.fillText(reg, 4096 - X(-2.15) - w, Y(0.13));
  g.restore();
  // tail stripes on fin handled in fin material
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.flipY = false; // shader samples with v=0 at canvas top
  return t;
}

function paintMaterial(envMap, livery, { fuselage = false, glass = false, interior = false } = {}) {
  const m = glass
    ? new THREE.MeshPhysicalMaterial({ color: 0x8fa3ad, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.16, envMapIntensity: 1.6, side: THREE.DoubleSide, depthWrite: false })
    : interior
      ? new THREE.MeshStandardMaterial({ color: 0x8c8780, roughness: 0.92, metalness: 0, side: THREE.BackSide })
      : new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.0, roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.12, envMapIntensity: 1.0, side: THREE.DoubleSide });
  if (fuselage && livery && !glass && !interior) m.userData.livery = livery;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLivery = { value: livery };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vP; varying vec3 vNo; varying vec2 vUv2;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvP = position; vNo = normal; vUv2 = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vP; varying vec3 vNo; varying vec2 vUv2; uniform sampler2D uLivery;\n' + WINDOW_GLSL + RIVET_GLSL)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  float gm = glassMask(vP, normalize(vNo));
  ${glass ? 'if (gm < 0.5) discard;' : 'if (gm > 0.5) discard;'}
`);
    if (!glass && !interior) {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <map_fragment>', `
  vec3 Nn = normalize(vNo);
  // livery (side projection)
  float lu = (2.08 - vP.x) / 7.93;
  float lv = 1.0 - (vP.y + 0.7) / 1.7;
  vec2 luv = vP.z < 0. ? vec2(lu, lv*0.5) : vec2(1.0-lu, 0.5 + lv*0.5);
  vec3 liv = texture2D(uLivery, luv).rgb;
  liv = mix(vec3(0.955), liv, smoothstep(0.15, 0.5, abs(Nn.z)) );
  diffuseColor.rgb *= liv;
  // panel lines: frames, door outlines, cowl split, stringers
  float u = vUv2.x, v = vUv2.y;
  float pl = 0.;
  float aw = 0.0018;
  // circumferential skin joints
  float frames[9] = float[9](1.08, 0.505, -0.47, -1.47, -2.25, -3.05, -3.85, -4.62, 1.66);
  for (int i=0;i<9;i++){ pl = max(pl, 1.-smoothstep(aw*.4, aw, abs(u - frames[i]))); }
  // door outline (both sides)
  float dEdge = abs(rbox(vec2(vP.x, vP.y), vec2(-0.02, 0.17), vec2(0.49, 0.72), 0.08));
  if (abs(Nn.z) > 0.3) pl = max(pl, 1.-smoothstep(aw*.4, aw, dEdge));
  // baggage door left side
  float bEdge = abs(rbox(vec2(vP.x, vP.y), vec2(-1.62, 0.05), vec2(0.26, 0.2), 0.04));
  if (vP.z < -0.2) pl = max(pl, 1.-smoothstep(aw*.4, aw, bEdge));
  // cowl split line & oil door
  if (vP.x > 1.06) { pl = max(pl, 1.-smoothstep(aw*.4, aw, abs(vP.y - 0.02))); }
  float oil = abs(rbox(vec2(vP.x, vP.z), vec2(1.45, 0.0), vec2(0.17, 0.12), 0.03));
  if (vP.y > 0.25 && vP.x > 1.1) pl = max(pl, 1.-smoothstep(aw*.4, aw, oil));
  // longitudinal lap joints on tail cone
  if (vP.x < -1.5) { pl = max(pl, 1.-smoothstep(aw*.4, aw, abs(fract(v/0.44)-.5)*0.44 - 0.0)); }
  // window seals (black rubber)
  float fd = frameDist(vP, Nn);
  float seal = (1.-smoothstep(0.006, 0.014, fd)) * step(0.25, abs(Nn.z) + step(0.5, vP.x));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03), seal*0.9);
  diffuseColor.rgb *= 1. - pl*0.55;
  // rivets: rows along frames and stringers (fade when too small on screen)
  float rv = 0.;
  float fw = fwidth(u)*1.5;
  float fade = 1. - smoothstep(0.004, 0.012, fw);
  if (fade > 0.) {
    for (int i=0;i<8;i++){ rv = max(rv, rivetRow(v, u - frames[i] - 0.011, 0.028, 0.0028)); rv = max(rv, rivetRow(v, u - frames[i] + 0.011, 0.028, 0.0028)); }
    if (vP.x < -1.5 || vP.x > 1.06) rv = max(rv, rivetRow(u, (fract(v/0.44)-.5)*0.44 + 0.01, 0.03, 0.0026));
    if (vP.x > 1.06) { float cl = rivetRow(u, vP.y - 0.02 - 0.015, 0.085, 0.006); rv = max(rv, cl); } // camlock fasteners
    rv *= fade;
  }
  gRiv = rv; gPL = pl;
`)
        .replace('#include <common>', '#include <common>\nfloat gRiv = 0.; float gPL = 0.;')
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  normal = bumpN(normal, -vViewPosition, gRiv*0.0007 - gPL*0.0004, 1.0);
`);
    }
  };
  return m;
}

function wingMaterial(base = 0xf2f2ef) {
  const m = new THREE.MeshPhysicalMaterial({ color: base, roughness: 0.34, clearcoat: 0.6, clearcoatRoughness: 0.15, metalness: 0, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vUv2; varying vec3 vP2; varying vec3 vN2;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvUv2 = uv; vP2 = position; vN2 = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vUv2; varying vec3 vP2; varying vec3 vN2; float gRiv=0., gPL=0.;\n' + RIVET_GLSL)
      .replace('#include <map_fragment>', `
  float span = abs(vUv2.x); float ch = mod(vUv2.y, 3.0);
  float fw = fwidth(span)*1.5; float fade = 1.-smoothstep(0.004, 0.012, fw);
  float rv = 0.;
  // ribs every ~0.29 m: two rivet rows each
  float rib = (fract(span/0.29)-.5)*0.29;
  rv = max(rv, rivetRow(ch, rib, 0.03, 0.0026));
  // spars at 25% & 72% chord (chord in metres along u*c)
  rv = max(rv, rivetRow(span, ch - 0.38, 0.03, 0.0026));
  rv = max(rv, rivetRow(span, ch - 1.12, 0.03, 0.0026));
  rv = max(rv, rivetRow(span, ch - 0.12, 0.035, 0.0024));
  float pl = 1.-smoothstep(0.0008, 0.0018, abs(rib));
  pl = max(pl, 1.-smoothstep(0.0008,0.0018, abs(ch-0.20)));
  // inspection plates (underside), with 8 screws each
  if (vN2.y < -0.2) {
    for (int i=0;i<5;i++){
      float sp = float[5](1.05, 1.85, 2.75, 3.6, 4.45)[i];
      vec2 d = vec2(span - sp, ch - 0.62);
      float r = length(d);
      pl = max(pl, 1.-smoothstep(0.0012, 0.0024, abs(r-0.065)));
      float a = atan(d.y, d.x); float sc = (fract(a/6.2832*8.)-.5)*6.2832/8.*0.052;
      rv = max(rv, (1.-smoothstep(0.002,0.0035, length(vec2(sc, r-0.052)))));
    }
  }
  gRiv = rv*fade; gPL = pl;
  diffuseColor.rgb *= 1. - pl*0.45;
`)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = bumpN(normal, -vViewPosition, gRiv*0.0007 - gPL*0.0003, 1.0);');
  };
  return m;
}

// ---------------- Instrument panel canvas ----------------
export function makePanelSurface(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// ---------------- Build aircraft ----------------
export async function buildAircraft({ envMap, panelCanvas, reg = 'N172SP', scheme = 0, interior = true, lights = true, aircraftType = 'C172' }) {
  const root = new THREE.Group();
  root.name = aircraftType;
  if (aircraftType === 'C152') root.scale.setScalar(0.92);
  const parts = {};
  const livery = makeLiveryTexture(reg, scheme);
  const skin = paintMaterial(envMap, livery, { fuselage: true });
  const glassM = paintMaterial(envMap, null, { glass: true });
  const wingM = wingMaterial();
  const black = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.12, metalness: 1 });
  const alu = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.35, metalness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.4, metalness: 0.85 });
  const darkGray = new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.7 });
  const exhaustM = new THREE.MeshStandardMaterial({ color: 0x5a4a3c, roughness: 0.55, metalness: 0.7 });
  const accentM = new THREE.MeshPhysicalMaterial({ color: scheme % 2 ? 0x7b1d1d : 0x1c2b52, roughness: 0.3, clearcoat: 0.7 });
  const redM = new THREE.MeshPhysicalMaterial({ color: 0xb0212b, roughness: 0.3, clearcoat: 0.7 });
  const white = new THREE.MeshPhysicalMaterial({ color: 0xf2f2ef, roughness: 0.32, clearcoat: 0.7 });

  const add = (g, m, name, parent = root, cast = true) => { const me = new THREE.Mesh(g, m); me.castShadow = cast; me.receiveShadow = true; if (name) me.name = name; parent.add(me); return me; };
  const pivot = (p, parent = root, name) => { const g = new THREE.Group(); g.position.set(...p); if (name) g.name = name; parent.add(g); return g; };

  // ---- fuselage ----
  const fg = buildFuselageGeometry();
  const fus = add(fg, skin, 'fuselage');
  // shadow caster with the same window cut-outs so sunlight streams into the cabin
  const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  dm.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vP; varying vec3 vNo;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvP = position; vNo = normal;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vP; varying vec3 vNo;\n' + WINDOW_GLSL).replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n if (glassMask(vP, normalize(vNo)) > 0.5) discard;');
  };
  fus.customDepthMaterial = dm;
  const glass = add(fg, glassM, 'glass', root, false); glass.renderOrder = 10;
  parts.glass = glass;

  // ---- wings ----
  const chordAt = (z) => (z < 2.6 ? 1.63 : lerp(1.63, 1.12, (z - 2.6) / 2.9));
  const leAt = (z) => [0.45 - Math.max(0, z - 2.6) * 0.035, 0.975 + z * Math.tan(1.73 * Math.PI / 180)];
  const twistAt = (z) => lerp(1.5, -1.5, z / 5.5) * Math.PI / 180;
  const wingSt = (z0, z1, n) => { const a = []; for (let i = 0; i <= n; i++) { const z = n ? lerp(z0, z1, i / n) : z0; a.push({ z, le: leAt(z), chord: chordAt(z), twist: twistAt(z) }); } return a; };
  const wingProf = (c0, c1) => () => airfoilLoop(0.02, 0.4, 0.12, c0, c1, 30);
  for (const side of [-1, 1]) {
    const geos = [];
    geos.push(loftProfile(wingSt(0.0, 0.62, 2), wingProf(0, 1), { capStart: true, capEnd: false }));
    geos.push(loftProfile(wingSt(0.62, 2.9, 6), wingProf(0, 0.735), { capStart: true, capEnd: true }));
    geos.push(loftProfile(wingSt(2.9, 2.96, 1), wingProf(0, 1), { capStart: true, capEnd: true }));
    geos.push(loftProfile(wingSt(2.96, 5.06, 6), wingProf(0, 0.745), { capStart: true, capEnd: true }));
    // tip: conical camber, slight droop
    const tipSt = [];
    for (let i = 0; i <= 5; i++) { const t = i / 5; const z = lerp(5.06, 5.52, t); const s = wingSt(z, z, 0)[0]; s.chord *= 1 - 0.55 * t * t; s.le = [s.le[0] - 0.3 * t * t * 0.8, s.le[1] - 0.025 * t]; s.thick = 1 - 0.65 * t; tipSt.push(s); }
    geos.push(loftProfile(tipSt, wingProf(0, 1), { capStart: true, capEnd: true }));
    let wg = mergeGeometries(geos.map((g) => g.toNonIndexed()));
    if (side < 0) { wg.scale(1, 1, -1); wg = flipIfNeeded(wg.index ? wg : wg, false); }
    wg.computeVertexNormals();
    const wm = add(wg, wingM, side < 0 ? 'leftWing' : 'rightWing');
    if (side < 0) wm.material = wingM; // DoubleSide handles flipped winding

    // flap (Fowler): pivot group at hinge, moves aft & rotates
    const flapPiv = pivot([0, 0, 0]);
    const flapSt = wingSt(0.64, 2.88, 6);
    let flg = loftProfile(flapSt, wingProf(0.745, 1.0), { capStart: true, capEnd: true });
    if (side < 0) flg.scale(1, 1, -1);
    const hinge = new THREE.Vector3(leAt(1.7)[0] - 0.745 * 1.63, leAt(1.7)[1] - 0.02, 0);
    flg.translate(-hinge.x, -hinge.y, 0);
    flapPiv.position.copy(hinge);
    add(flg, wingM, 'flap', flapPiv);
    parts[side < 0 ? 'flapL' : 'flapR'] = flapPiv;
    flapPiv.userData.base = hinge.clone();

    // aileron with hinge axis along its span
    const aSt = wingSt(2.98, 5.04, 6);
    let ag = loftProfile(aSt, wingProf(0.76, 1.0), { capStart: true, capEnd: true });
    const h0 = new THREE.Vector3(leAt(2.98)[0] - 0.755 * chordAt(2.98), leAt(2.98)[1] + 0.005, 2.98);
    const h1 = new THREE.Vector3(leAt(5.04)[0] - 0.755 * chordAt(5.04), leAt(5.04)[1] + 0.005, 5.04);
    if (side < 0) { ag.scale(1, 1, -1); h0.z *= -1; h1.z *= -1; }
    const axis = h1.clone().sub(h0).normalize();
    const aPiv = pivot([h0.x, h0.y, h0.z]);
    // orient pivot so local z = hinge axis
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, side), axis);
    aPiv.quaternion.copy(q);
    ag.translate(-h0.x, -h0.y, -h0.z);
    ag.applyQuaternion(q.clone().invert());
    add(ag, wingM, 'aileron', aPiv);
    parts[side < 0 ? 'ailL' : 'ailR'] = aPiv;

    // wing strut
    const sTop = [leAt(2.65)[0] - 0.36 * 1.63, leAt(2.65)[1] - 0.04, side * 2.65];
    const sBot = [-0.08, -0.42, side * 0.56];
    add(strut(sBot, sTop, 0.115, 0.035), wingM, 'strut');
    // strut fittings
    add(place(new THREE.BoxGeometry(0.12, 0.05, 0.08), { p: [sBot[0], sBot[1] + 0.01, sBot[2]] }), alu);
    add(place(new THREE.BoxGeometry(0.14, 0.03, 0.08), { p: [sTop[0], sTop[1] + 0.005, sTop[2]] }), alu);
    // step on strut
    add(place(new THREE.BoxGeometry(0.12, 0.012, 0.09), { p: [-0.10, -0.12, side * 0.95], r: [side * 0.35, 0, 0] }), black);
    // fuel cap & vent
    add(place(new THREE.CylinderGeometry(0.045, 0.045, 0.012, 24), { p: [0.05, leAt(1.6)[1] + 0.12, side * 1.6] }), alu, 'fuelCap');
    add(place(new THREE.CylinderGeometry(0.03, 0.03, 0.016, 16), { p: [0.05, leAt(1.6)[1] + 0.127, side * 1.6] }), steel);
    // fuel sump drain
    add(place(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 8), { p: [0.0, leAt(1.0)[1] - 0.06, side * 1.0] }), alu);
    // tie-down ring
    add(place(new THREE.TorusGeometry(0.025, 0.006, 6, 16), { p: [sTop[0] + 0.05, sTop[1] - 0.04, sTop[2] + side * 0.05], r: [0, Math.PI / 2, 0] }), steel);
    // wingtip lights
    const tipLE = leAt(5.45);
    const navColor = side < 0 ? 0xff1a1a : 0x19ff4a;
    const navLens = new THREE.MeshPhysicalMaterial({ color: navColor, emissive: navColor, emissiveIntensity: 0.3, roughness: 0.1, transmission: 0, transparent: true, opacity: 0.85 });
    const nl = add(place(new THREE.SphereGeometry(0.035, 16, 12), { p: [tipLE[0] - 0.12, tipLE[1] - 0.02, side * 5.5], s: [1.6, 0.8, 0.8] }), navLens, 'navlight', root, false);
    parts[side < 0 ? 'navL' : 'navR'] = nl;
    const strobeM = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0, transparent: true, opacity: 0.9 });
    const sl = add(place(new THREE.CylinderGeometry(0.015, 0.015, 0.05, 12), { p: [tipLE[0] - 0.22, tipLE[1] + 0.02, side * 5.5], r: [0, 0, 0] }), strobeM, 'strobe', root, false);
    parts[side < 0 ? 'strobeL' : 'strobeR'] = sl;
  }
  // stall warning slot on left wing LE, pitot tube under left wing
  add(place(new THREE.BoxGeometry(0.01, 0.012, 0.05), { p: [0.452, 0.97, -1.7] }), black);
  const pitot = tube([[0.0, 0.9, -2.2], [0.0, 0.8, -2.2], [0.25, 0.79, -2.2], [0.35, 0.79, -2.2]], 0.008, 12, 8);
  add(pitot, steel, 'pitot');
  add(place(new THREE.BoxGeometry(0.1, 0.1, 0.012), { p: [0.02, 0.86, -2.2] }), steel);
  // landing / taxi lights in left wing LE
  const llm = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4dd, emissiveIntensity: 0, roughness: 0.05, metalness: 0.4 });
  const ll = add(place(new THREE.CircleGeometry(0.06, 24), { p: [0.455, 0.965, -2.55], r: [0, Math.PI / 2, 0] }), llm, 'landingLight', root, false);
  const tl = add(place(new THREE.CircleGeometry(0.05, 24), { p: [0.455, 0.965, -2.72], r: [0, Math.PI / 2, 0] }), llm.clone(), 'taxiLight', root, false);
  parts.landingLens = ll; parts.taxiLens = tl;
  // wing root fairings & wing-to-roof
  add(place(new THREE.BoxGeometry(1.5, 0.05, 1.12), { p: [-0.32, 0.955, 0] }), white);
  // roof air vents (small scoops in wing root)
  for (const s of [-1, 1]) add(place(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 12), { p: [0.452, 0.98, s * 0.75], r: [0, 0, Math.PI / 2] }), black);

  // ---- horizontal tail + elevators ----
  const hSt = (z0, z1, n, c0, c1) => { const a = []; for (let i = 0; i <= n; i++) { const z = lerp(z0, z1, i / n); const ch = lerp(1.33, 0.86, z / 1.73); a.push({ z, le: [-4.37 - 0.14 * z, 0.13], chord: ch, twist: -2.6 * Math.PI / 180 }); } return a; };
  const symProf = (c0, c1) => () => airfoilLoop(0, 0.3, 0.09, c0, c1, 22);
  for (const side of [-1, 1]) {
    let sg = loftProfile(hSt(0.08, 1.73, 6), symProf(0, 0.6), { capStart: true, capEnd: true });
    if (side < 0) sg.scale(1, 1, -1);
    add(sg, wingM, 'stab');
    // tip
    const tipS = []; for (let i = 0; i <= 3; i++) { const t = i / 3; const z = 1.73 + 0.06 * t; tipS.push({ z, le: [-4.37 - 0.14 * z - 0.12 * t * t, 0.13], chord: 0.86 * (1 - 0.6 * t * t), twist: -2.6 * Math.PI / 180, thick: 1 - 0.6 * t }); }
    let tg = loftProfile(tipS, symProf(0, 1), {}); if (side < 0) tg.scale(1, 1, -1); add(tg, wingM);
    // elevator
    let eg = loftProfile(hSt(0.08, 1.73, 6), symProf(0.61, 1.0), { capStart: true, capEnd: true });
    const hx = -4.37 - 0.14 * 0.9 - 0.61 * lerp(1.33, 0.86, 0.9 / 1.73);
    if (side < 0) eg.scale(1, 1, -1);
    eg.translate(-hx, -0.13, 0);
    const ep = pivot([hx, 0.13, 0]);
    add(eg, wingM, 'elevator', ep);
    parts[side < 0 ? 'elevL' : 'elevR'] = ep;
    if (side > 0) {
      // trim tab on right elevator
      const tabG = place(new THREE.BoxGeometry(0.11, 0.008, 0.48), { p: [0, 0, 0] });
      tabG.translate(-0.055, 0, 0);
      const tp = pivot([-0.36, 0, 0.62], ep);
      add(tabG, wingM, 'trimTab', tp);
      parts.trimTab = tp;
      // tab actuator horn
      add(place(new THREE.BoxGeometry(0.04, 0.035, 0.006), { p: [-0.33, 0.025, 0.62] }), steel, null, ep);
    }
  }
  // ---- vertical fin + rudder ----
  const vSt = (y0, y1, n) => { const a = []; for (let i = 0; i <= n; i++) { const y = lerp(y0, y1, i / n); const t = (y - 0.2) / 1.25; a.push({ z: y, le: [-4.25 - 0.95 * t, 0], chord: lerp(1.62, 0.92, t), twist: 0 }); } return a; };
  add(loftProfile(vSt(0.18, 1.45, 6), symProf(0, 0.62), { axis: 'y' }), skin.clone(), 'fin');
  // fin tip cap
  const ftip = []; for (let i = 0; i <= 3; i++) { const t = i / 3; ftip.push({ z: 1.45 + 0.05 * t, le: [-5.2 - 0.06 * t, 0], chord: 0.92 * (1 - 0.5 * t * t), thick: 1 - 0.7 * t }); }
  add(loftProfile(ftip, symProf(0, 1), { axis: 'y' }), wingM);
  // dorsal fin
  const dShape = new THREE.Shape(); dShape.moveTo(-2.9, 0.33); dShape.lineTo(-4.3, 0.33); dShape.lineTo(-4.3, 0.62); dShape.quadraticCurveTo(-3.6, 0.42, -2.9, 0.33);
  const dg = new THREE.ExtrudeGeometry(dShape, { depth: 0.04, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.01, bevelSegments: 3 }); dg.translate(0, 0, -0.02);
  add(dg, white);
  // rudder: hinge line (swept)
  const rTop = [-5.20 + 0.92 * 0.0, 1.45], rBot = [-4.25 - 0.62 * 1.62 + 0.0, 0.18];
  const rh0 = new THREE.Vector3(-4.25 - 0.62 * 1.62, 0.18, 0), rh1 = new THREE.Vector3(-5.20 - 0.62 * 0.92, 1.45, 0);
  void rTop; void rBot;
  let rg = loftProfile(vSt(0.05, 1.45, 6), symProf(0.63, 1.0), { axis: 'y' });
  const rAxis = rh1.clone().sub(rh0).normalize();
  const rp = pivot([rh0.x, rh0.y, 0]);
  const rq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), rAxis);
  rp.quaternion.copy(rq);
  rg.translate(-rh0.x, -rh0.y, 0); rg.applyQuaternion(rq.clone().invert());
  const rIn = pivot([0, 0, 0], rp);
  const rudMesh = add(rg, skin.clone(), 'rudder', rIn);
  parts.rudder = rIn;
  // rudder stripes
  void rudMesh;
  // beacon on fin top, tail light at rudder trailing edge, VOR antenna
  const beaconM = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff0000, emissiveIntensity: 0, transparent: true, opacity: 0.9, roughness: 0.15 });
  parts.beacon = add(place(new THREE.SphereGeometry(0.035, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), { p: [-5.28, 1.505, 0], s: [1.3, 1.3, 1] }), beaconM, 'beacon', root, false);
  add(place(new THREE.CylinderGeometry(0.03, 0.035, 0.03, 16), { p: [-5.28, 1.49, 0] }), black);
  parts.tailLight = add(place(new THREE.SphereGeometry(0.02, 12, 8), { p: [-6.0, 0.30, 0] }), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0 }), 'tailLight', root, false);
  for (const s of [-1, 1]) add(tube([[-5.05, 1.38, 0], [-5.18, 1.40, s * 0.18], [-5.35, 1.41, s * 0.5]], 0.004, 8, 5), black);

  // ---- cowling details ----
  // air inlets
  for (const s of [-1, 1]) {
    const inlet = place(new THREE.CylinderGeometry(0.085, 0.085, 0.06, 24, 1, true), { p: [2.05, 0.02, s * 0.2], r: [0, 0, Math.PI / 2], s: [1, 1, 0.75] });
    add(inlet, black);
    add(place(new THREE.CircleGeometry(0.083, 24), { p: [2.03, 0.02, s * 0.2], r: [0, Math.PI / 2, 0], s: [1, 0.75, 1] }), new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1 }));
  }
  // cowl lower air exit
  add(place(new THREE.BoxGeometry(0.25, 0.04, 0.5), { p: [1.12, -0.6, 0] }), darkGray);
  // exhaust pipe (right lower)
  add(tube([[1.25, -0.52, 0.18], [1.18, -0.62, 0.2], [1.02, -0.66, 0.22]], 0.028, 12, 12), exhaustM, 'exhaust');
  // oil dipstick door is a panel line; propeller spinner
  const spinner = lathe([[0, 0.0], [0.135, 0.0], [0.135, 0.02], [0.12, 0.12], [0.085, 0.21], [0.04, 0.27], [0.0, 0.295]], 40);
  spinner.rotateZ(-Math.PI / 2);
  const propHub = pivot([2.08, 0.0, 0], root, 'propHub');
  add(spinner, new THREE.MeshPhysicalMaterial({ color: 0xf0f0ee, roughness: 0.25, clearcoat: 0.8, metalness: 0.0 }), 'spinner', propHub);
  // spinner screws
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; add(place(new THREE.CylinderGeometry(0.006, 0.006, 0.004, 8), { p: [0.03, Math.cos(a) * 0.131, Math.sin(a) * 0.131], r: [a, 0, Math.PI / 2] }), steel, null, propHub); }
  // propeller blades: McCauley 76" two-blade fixed pitch
  const bladeGeos = [];
  for (const sgn of [1, -1]) {
    const st = [];
    for (let i = 0; i <= 12; i++) {
      const rr = lerp(0.12, 0.965, i / 12);
      const beta = Math.atan(1.524 / (2 * Math.PI * Math.max(rr, 0.2)));
      const c = rr < 0.2 ? 0.07 : lerp(0.155, 0.08, Math.pow((rr - 0.2) / 0.765, 1.6)) * (rr > 0.93 ? 1 - (rr - 0.93) * 8 : 1);
      st.push({ z: rr, le: [c * 0.35, 0], chord: c, twist: 0, beta, thick: rr < 0.2 ? 2.5 : 1 });
    }
    // blade profile in plane (chord along rotation direction), rotated by beta
    const pos = [], idx = [];
    const P = 30;
    st.forEach((s, si) => {
      const prof = airfoilLoop(0.03, 0.35, 0.09 * s.thick, 0, 1, 14);
      for (let k = 0; k < prof.length; k++) {
        const [u, v] = prof[k];
        const cx = (0.35 - u) * s.chord, cy = v * s.chord;
        // blade lies along +y (sgn), rotation direction is +z at top for clockwise (from cockpit)... chord along z, thickness along x
        const b = s.beta;
        const tz = cx * Math.cos(b) - cy * Math.sin(b) * 0;
        const tx = cx * Math.sin(b) + cy * Math.cos(b);
        // forward = +x, rotation direction tangent for blade at +y is +z (omega along +x: x × y = z)
        pos.push(tx * 1.0, sgn * s.z, sgn * tz);
      }
      if (si > 0) { const a0 = (si - 1) * prof.length, b0 = si * prof.length, Pp = prof.length; for (let k = 0; k < Pp - 1; k++) idx.push(a0 + k, b0 + k, a0 + k + 1, a0 + k + 1, b0 + k, b0 + k + 1); }
      void P;
    });
    const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); bg.setIndex(idx); bg.computeVertexNormals();
    bladeGeos.push(bg);
  }
  const propM = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.45, metalness: 0.3, side: THREE.DoubleSide });
  propM.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vR;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvR = abs(position.y);');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vR;').replace('#include <map_fragment>', `
      vec3 pc = vec3(0.1);
      if (vR > 0.83) pc = vec3(0.85,0.85,0.83);
      if (vR > 0.875 && vR < 0.915) pc = vec3(0.65,0.05,0.05);
      diffuseColor.rgb = pc;`);
  };
  const propBlades = pivot([0.04, 0, 0], propHub, 'propBlades');
  for (const bg of bladeGeos) add(bg, propM, 'blade', propBlades);
  parts.propHub = propHub; parts.propBlades = propBlades;
  // prop disc (motion blur) visible at high rpm
  const discC = document.createElement('canvas'); discC.width = discC.height = 256;
  { const g = discC.getContext('2d'); const grd = g.createRadialGradient(128, 128, 20, 128, 128, 128); grd.addColorStop(0, 'rgba(20,20,20,0.0)'); grd.addColorStop(0.2, 'rgba(20,20,20,0.35)'); grd.addColorStop(0.84, 'rgba(25,25,25,0.22)'); grd.addColorStop(0.87, 'rgba(220,220,220,0.3)'); grd.addColorStop(0.9, 'rgba(160,20,20,0.3)'); grd.addColorStop(0.95, 'rgba(220,220,220,0.25)'); grd.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = grd; g.fillRect(0, 0, 256, 256); }
  const discT = new THREE.CanvasTexture(discC); discT.colorSpace = THREE.SRGBColorSpace;
  const disc = add(place(new THREE.CircleGeometry(0.965, 48), { p: [0.05, 0, 0], r: [0, Math.PI / 2, 0] }), new THREE.MeshBasicMaterial({ map: discT, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 }), 'propDisc', propHub, false);
  parts.propDisc = disc;

  // ---- landing gear ----
  // main gear: tubular spring steel legs (172S), wheels, brakes, wheel fairings
  const wheelGeo = () => {
    const tire = lathe([[0.085, -0.075], [0.15, -0.078], [0.18, -0.06], [0.19, -0.02], [0.19, 0.02], [0.18, 0.06], [0.15, 0.078], [0.085, 0.075]], 40);
    tire.rotateX(Math.PI / 2);
    return tire;
  };
  const hubGeo = () => { const h = lathe([[0.0, -0.06], [0.09, -0.06], [0.09, 0.06], [0.0, 0.06]], 24); h.rotateX(Math.PI / 2); return h; };
  const fairing = (len, wid, hgt) => { const g = new THREE.SphereGeometry(1, 32, 16); g.scale(len / 2, hgt / 2, wid / 2); return g; };
  for (const side of [-1, 1]) {
    const axle = [-0.30, -1.03, side * 1.27];
    const leg = tube([[-0.22, -0.58, side * 0.48], [-0.25, -0.75, side * 0.85], [-0.29, -0.98, side * 1.20]], 0.03, 16, 10);
    add(leg, white, 'gearLeg');
    const wheelPiv = pivot(axle, root, side < 0 ? 'wheelL' : 'wheelR');
    add(wheelGeo(), rubber, 'tire', wheelPiv);
    add(hubGeo(), alu, 'hub', wheelPiv);
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; add(place(new THREE.CylinderGeometry(0.007, 0.007, 0.13, 8), { p: [Math.cos(a) * 0.06, Math.sin(a) * 0.06, 0], r: [Math.PI / 2, 0, 0] }), steel, null, wheelPiv); }
    parts[side < 0 ? 'wheelL' : 'wheelR'] = wheelPiv;
    // brake disc & caliper
    add(place(new THREE.CylinderGeometry(0.1, 0.1, 0.008, 32), { p: [axle[0], axle[1], axle[2] - side * 0.085], r: [Math.PI / 2, 0, 0] }), steel);
    add(place(new THREE.BoxGeometry(0.06, 0.07, 0.04), { p: [axle[0] - 0.08, axle[1] + 0.03, axle[2] - side * 0.09] }), new THREE.MeshStandardMaterial({ color: 0x3a3a3a, metalness: 0.6, roughness: 0.4 }));
    // wheel fairing (speed pant)
    const fm = add(fairing(0.92, 0.27, 0.44), white, 'wheelFairing');
    fm.position.set(axle[0] + 0.05, axle[1] + 0.06, axle[2]);
    // brake line
    add(tube([[-0.22, -0.6, side * 0.5], [-0.26, -0.8, side * 0.9], [-0.33, -0.95, side * 1.17]], 0.004, 12, 5), black);
    // step
    add(place(new THREE.BoxGeometry(0.1, 0.012, 0.13), { p: [-0.18, -0.68, side * 0.72] }), black);
  }
  // nose gear: oleo strut, torque links, fork, wheel, fairing — steers with rudder
  const nosePiv = pivot([1.36, -0.55, 0], root, 'noseSteer');
  const oleo = pivot([0, 0, 0], nosePiv, 'oleo');
  add(place(new THREE.CylinderGeometry(0.04, 0.04, 0.28, 16), { p: [0, -0.06, 0] }), white, null, nosePiv);
  add(place(new THREE.CylinderGeometry(0.028, 0.028, 0.3, 16), { p: [0, -0.28, 0] }), chrome, 'oleoChrome', oleo);
  add(place(new THREE.BoxGeometry(0.03, 0.12, 0.02), { p: [0.05, -0.27, 0], r: [0, 0, 0.3] }), steel, null, oleo);
  add(place(new THREE.BoxGeometry(0.03, 0.12, 0.02), { p: [0.05, -0.37, 0], r: [0, 0, -0.3] }), steel, null, oleo);
  add(place(new THREE.BoxGeometry(0.06, 0.2, 0.17), { p: [0, -0.42, 0] }), white, null, oleo);
  const nw = pivot([0, -0.48, 0], oleo, 'noseWheel');
  const nwt = lathe([[0.07, -0.06], [0.13, -0.062], [0.165, -0.045], [0.17, 0], [0.165, 0.045], [0.13, 0.062], [0.07, 0.06]], 36); nwt.rotateX(Math.PI / 2);
  add(nwt, rubber, null, nw); const nh = hubGeo(); nh.scale(0.8, 0.8, 0.85); add(nh, alu, null, nw);
  const nf = add(fairing(0.7, 0.2, 0.36), white, 'noseFairing', oleo); nf.position.set(0.0, -0.44, 0);
  parts.noseSteer = nosePiv; parts.oleo = oleo; parts.noseWheel = nw;
  // shimmy damper
  add(place(new THREE.CylinderGeometry(0.014, 0.014, 0.22, 10), { p: [1.36, -0.5, 0.07], r: [0, 0, Math.PI / 2] }), steel);

  // ---- antennas & misc ----
  add(tube([[0.05, 0.945, 0], [0.0, 1.18, 0], [-0.12, 1.35, 0]], 0.005, 8, 6), black, 'comAntenna'); // COM whip
  add(place(new THREE.BoxGeometry(0.16, 0.08, 0.012), { p: [-0.9, 0.97, 0], r: [0, 0, 0.35] }), white, 'com2'); // blade
  add(place(new THREE.BoxGeometry(0.05, 0.08, 0.008), { p: [-1.0, -0.52, 0], r: [0, 0, -0.2] }), black, 'xpdr');
  add(place(new THREE.CylinderGeometry(0.045, 0.05, 0.02, 20), { p: [-0.35, 0.955, 0.2] }), white, 'gps');
  add(place(new THREE.BoxGeometry(0.1, 0.012, 0.006), { p: [-3.2, 0.33, 0] }), black, 'elt');
  // static port (left side)
  add(place(new THREE.CylinderGeometry(0.012, 0.012, 0.004, 12), { p: [-0.7, 0.3, -0.562], r: [Math.PI / 2, 0, 0] }), alu);
  // door handles
  for (const s of [-1, 1]) add(place(new RoundedBoxGeometry(0.12, 0.022, 0.018, 2, 0.008), { p: [-0.28, 0.33, s * 0.585] }), chrome, 'doorHandle');
  // tail tie-down & tail skid
  add(place(new THREE.TorusGeometry(0.03, 0.007, 6, 16), { p: [-5.55, 0.07, 0] }), steel);
  add(place(new THREE.BoxGeometry(0.12, 0.03, 0.04), { p: [-5.5, 0.11, 0] }), steel);
  // fuel vent tube under left wing
  add(tube([[0.1, 0.88, -2.9], [0.15, 0.8, -2.9], [0.25, 0.79, -2.9]], 0.006, 8, 6), alu);
  // horizontal stab fairing
  add(place(new THREE.BoxGeometry(1.0, 0.04, 0.2), { p: [-4.85, 0.16, 0] }), white);

  // ---- interior ----
  if (interior) await buildInterior(root, parts, panelCanvas, envMap);

  // ---- light sources ----
  if (lights) {
    const land = new THREE.SpotLight(0xfff1dc, 0, 600, 0.28, 0.5, 1.4);
    land.position.set(0.5, 0.96, -2.6); land.target.position.set(40, -6, -1.5);
    root.add(land); root.add(land.target);
    parts.landingSpot = land;
    const taxi = new THREE.SpotLight(0xfff1dc, 0, 200, 0.55, 0.6, 1.4);
    taxi.position.set(0.5, 0.96, -2.7); taxi.target.position.set(25, -8, -1);
    root.add(taxi); root.add(taxi.target);
    parts.taxiSpot = taxi;
    const cabin = new THREE.PointLight(0xffd9a0, 0, 2.2, 2); cabin.position.set(0.1, 0.8, 0); root.add(cabin); parts.cabinLight = cabin;
    const panelL = new THREE.PointLight(0xff9a5a, 0, 1.0, 2); panelL.position.set(0.55, 0.38, 0); root.add(panelL); parts.panelLight = panelL;
  }
  root.userData.parts = parts;
  return root;
}

async function buildInterior(root, parts, panelCanvas, envMap) {
  void envMap;
  const [carpetT, leatherT, leatherN, fabricT] = await Promise.all([
    tex(PH('dirty_carpet', 'diff'), { repeat: 3 }),
    tex(PH('fabric_leather_02', 'diff'), { repeat: 2 }),
    tex(PH('fabric_leather_02', 'nor_gl'), { repeat: 2, srgb: false }),
    tex(PH('denim_fabric', 'diff'), { repeat: 4 }),
  ]);
  const carpet = new THREE.MeshStandardMaterial({ map: carpetT, color: 0x6b6762, roughness: 1 });
  const leather = new THREE.MeshStandardMaterial({ map: leatherT, normalMap: leatherN, color: 0x7d7368, roughness: 0.62 });
  const fabric = new THREE.MeshStandardMaterial({ map: fabricT, color: 0x77726c, roughness: 0.95 });
  const plastic = new THREE.MeshStandardMaterial({ color: 0x3a3b3d, roughness: 0.72 });
  const plasticLight = new THREE.MeshStandardMaterial({ color: 0xb9b4aa, roughness: 0.8 });
  const blackSoft = new THREE.MeshStandardMaterial({ color: 0x151617, roughness: 0.85 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.15, metalness: 1 });
  const add = (g, m, name, parent = root) => { const me = new THREE.Mesh(g, m); me.receiveShadow = true; me.castShadow = false; if (name) me.name = name; parent.add(me); return me; };

  // interior lining (headliner + sidewalls) = inset fuselage, rendered from inside, windows cut out
  const lining = buildFuselageGeometry(0.03);
  const linM = paintMaterial(null, null, { interior: true });
  linM.map = fabricT;
  const lm = add(lining, linM, 'lining');
  lm.material.side = THREE.BackSide;
  // cut the lining to the cabin only (firewall to baggage)
  linM.onBeforeCompile = ((orig) => (sh) => { orig(sh); sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n if (vP.x > 0.86 || vP.x < -1.95) discard;'); })(linM.onBeforeCompile);

  // floor & firewall
  add(place(new THREE.BoxGeometry(2.6, 0.02, 1.08), { p: [-0.45, -0.52, 0] }), carpet, 'floor');
  add(place(new THREE.BoxGeometry(0.02, 0.6, 1.08), { p: [0.86, -0.25, 0] }), carpet);
  // rear bulkhead / baggage
  add(place(new THREE.BoxGeometry(0.02, 0.9, 0.9), { p: [-1.95, 0.05, 0] }), fabric);
  add(place(new THREE.BoxGeometry(0.75, 0.02, 0.85), { p: [-1.55, -0.35, 0] }), carpet);

  // ---- instrument panel ----
  const panelW = 1.08, panelH = 0.54, panelY = 0.132; // canvas 2048x1024 (see panel.js PANEL_W/H)
  const panelTex = makePanelSurface(panelCanvas);
  const panelMat = new THREE.MeshStandardMaterial({ map: panelTex, roughness: 0.55, metalness: 0.05, emissive: 0xffffff, emissiveMap: panelTex, emissiveIntensity: 0.0 });
  const panelGeo = new THREE.PlaneGeometry(panelW, panelH);
  const panel = add(panelGeo, panelMat, 'panel');
  panel.position.set(0.73, panelY, 0);
  panel.rotation.set(0, -Math.PI / 2, 0);
  panel.rotateX(-0.08);
  parts.panel = panel; parts.panelTex = panelTex; parts.panelMat = panelMat;
  panel.userData.size = [panelW, panelH];
  // panel bezel/back
  add(place(new THREE.BoxGeometry(0.06, panelH + 0.04, panelW + 0.04), { p: [0.805, panelY, 0] }), plastic); // behind the tilted panel (top leans to x 0.752)
  // glareshield
  const gs = new RoundedBoxGeometry(0.17, 0.05, 1.1, 3, 0.02);
  add(place(gs, { p: [0.72, 0.425, 0] }), blackSoft, 'glareshield');
  // lower panel/kneeboard area & center pedestal
  // centre pedestal below the panel (trim wheel, fuel shutoff) & lower firewall trim
  add(place(new RoundedBoxGeometry(0.16, 0.38, 0.2, 2, 0.015), { p: [0.70, -0.33, 0.0] }), plastic, 'pedestal');
  add(place(new THREE.BoxGeometry(0.08, 0.36, 1.08), { p: [0.79, -0.32, 0] }), plastic);
  // fuel shutoff valve knob (red, push-pull) on the pedestal face
  { const fsk = new THREE.Group(); fsk.position.set(0.612, -0.46, 0.0); root.add(fsk);
    add(place(new THREE.CylinderGeometry(0.004, 0.004, 0.04, 10), { p: [0.02, 0, 0], r: [0, 0, Math.PI / 2] }), chrome, null, fsk);
    add(place(new THREE.CylinderGeometry(0.016, 0.014, 0.018, 24), { p: [-0.004, 0, 0], r: [0, 0, Math.PI / 2] }), new THREE.MeshStandardMaterial({ color: 0xb3171a, roughness: 0.45 }), 'fuelShutoffKnob', fsk);
    fsk.userData.baseX = 0.612; parts.fuelShutoff = fsk; }

  // magnetic compass on glareshield
  const cmp = new THREE.Group(); cmp.position.set(0.66, 0.5, 0); root.add(cmp);
  add(place(new RoundedBoxGeometry(0.07, 0.06, 0.07, 2, 0.01), { p: [0, 0, 0] }), blackSoft, null, cmp);
  const cardC = document.createElement('canvas'); cardC.width = 512; cardC.height = 64;
  { const g = cardC.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, 512, 64); g.fillStyle = '#eee'; g.font = '600 22px Barlow, sans-serif'; g.textAlign = 'center';
    for (let d = 0; d < 360; d += 5) { const x = d / 360 * 512; g.fillRect(x, 0, 1.5, d % 30 === 0 ? 18 : 9); if (d % 30 === 0) { const lab = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] ?? String(d / 10); g.fillText(lab, x, 46); } } }
  const cardT = new THREE.CanvasTexture(cardC); cardT.wrapS = THREE.RepeatWrapping; cardT.colorSpace = THREE.SRGBColorSpace;
  const card = add(new THREE.CylinderGeometry(0.028, 0.028, 0.02, 32, 1, true), new THREE.MeshBasicMaterial({ map: cardT, side: THREE.DoubleSide }), 'compassCard', cmp);
  card.position.set(0, -0.002, 0);
  parts.compassCard = card; parts.compassTex = cardT;
  add(place(new THREE.PlaneGeometry(0.05, 0.035), { p: [-0.036, 0, 0], r: [0, -Math.PI / 2, 0] }), new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.15, roughness: 0.05 }), null, cmp);
  add(place(new THREE.BoxGeometry(0.002, 0.03, 0.002), { p: [-0.031, 0, 0] }), new THREE.MeshBasicMaterial({ color: 0xff6a00 }), null, cmp);

  // ---- yokes ----
  for (const s of [-1, 1]) {
    const yz = s * 0.28;
    const yoke = new THREE.Group(); yoke.name = s < 0 ? 'yokeL' : 'yokeR';
    yoke.position.set(0.48, 0.08, yz); root.add(yoke);
    // shaft through panel
    add(place(new THREE.CylinderGeometry(0.016, 0.016, 0.42, 16), { p: [0.2, 0, 0], r: [0, 0, Math.PI / 2] }), chrome, null, yoke);
    const wheel = new THREE.Group(); yoke.add(wheel);
    // hub & ram-horn arms
    add(place(new THREE.CylinderGeometry(0.035, 0.03, 0.06, 16), { p: [-0.01, 0, 0], r: [0, 0, Math.PI / 2] }), plastic, null, wheel);
    const arm = tube([[0, 0, 0], [-0.02, 0.0, 0.07], [-0.03, 0.04, 0.13], [-0.03, 0.09, 0.15]], 0.016, 16, 8);
    const armL = arm.clone(); armL.scale(1, 1, -1);
    add(arm, blackSoft, null, wheel); add(armL, blackSoft, null, wheel);
    // grips
    for (const g of [-1, 1]) add(place(new THREE.CapsuleGeometry(0.021, 0.08, 4, 12), { p: [-0.03, 0.1, g * 0.15] }), blackSoft, null, wheel);
    // center plate with Cessna logo plate & PTT
    add(place(new THREE.BoxGeometry(0.012, 0.05, 0.13), { p: [-0.035, 0.015, 0] }), plastic, null, wheel);
    add(place(new THREE.CylinderGeometry(0.006, 0.006, 0.01, 10), { p: [-0.03, 0.14, s * -0.15 * -1], r: [0, 0, Math.PI / 2] }), new THREE.MeshStandardMaterial({ color: 0xb02020 }), null, wheel);
    yoke.userData.wheel = wheel;
    parts[s < 0 ? 'yokeL' : 'yokeR'] = yoke;
  }
  // engine controls (throttle, mixture, carb heat, ...) are built by Panel.attach() as panel-mounted 3D knobs
  // elevator trim wheel (pedestal) & indicator
  const trimW = new THREE.Group(); trimW.position.set(0.625, -0.27, 0.0); root.add(trimW);
  const tw = new THREE.CylinderGeometry(0.075, 0.075, 0.025, 32); tw.rotateX(Math.PI / 2);
  add(tw, blackSoft, 'trimWheel', trimW);
  for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; add(place(new THREE.BoxGeometry(0.008, 0.012, 0.03), { p: [Math.cos(a) * 0.077, Math.sin(a) * 0.077, 0], r: [0, 0, a] }), plastic, null, trimW); }
  parts.trimWheel = trimW;
  // fuel selector on floor
  const fs = new THREE.Group(); fs.position.set(0.5, -0.5, 0); root.add(fs);
  add(new THREE.CylinderGeometry(0.06, 0.06, 0.01, 24), plasticLight, null, fs);
  add(place(new THREE.BoxGeometry(0.11, 0.025, 0.025), { p: [0, 0.015, 0] }), new THREE.MeshStandardMaterial({ color: 0xc23a1a }), 'fuelSelector', fs);
  parts.fuelSel = fs;
  // rudder pedals
  for (const s of [-1, 1]) for (const p of [-1, 1]) {
    const ped = new THREE.Group(); ped.position.set(0.78, -0.43, s * 0.28 + p * 0.09); root.add(ped);
    add(place(new RoundedBoxGeometry(0.03, 0.14, 0.075, 2, 0.008), { r: [0, 0, 0.45] }), blackSoft, null, ped);
    add(place(new THREE.CylinderGeometry(0.008, 0.008, 0.2, 8), { p: [0.04, 0.08, 0], r: [0, 0, 0.45] }), chrome, null, ped);
    parts[`ped${s}${p}`] = ped;
  }
  // ---- seats ----
  const seat = (x, z, w, rear = false) => {
    const g = new THREE.Group(); g.position.set(x, -0.42, z); root.add(g);
    add(place(new RoundedBoxGeometry(0.5, 0.12, w, 4, 0.04), { p: [0, 0.06, 0] }), leather, null, g);
    add(place(new RoundedBoxGeometry(0.12, 0.62, w, 4, 0.04), { p: [-0.28, 0.4, 0], r: [0, 0, 0.2] }), leather, null, g);
    if (!rear) add(place(new RoundedBoxGeometry(0.08, 0.16, w * 0.6, 3, 0.03), { p: [-0.36, 0.78, 0], r: [0, 0, 0.2] }), leather, null, g);
    // seat rails
    add(place(new THREE.BoxGeometry(0.6, 0.06, 0.03), { p: [0, -0.05, w * 0.35] }), chrome, null, g);
    add(place(new THREE.BoxGeometry(0.6, 0.06, 0.03), { p: [0, -0.05, -w * 0.35] }), chrome, null, g);
    // seat belt
    add(place(new THREE.BoxGeometry(0.01, 0.6, 0.045), { p: [-0.22, 0.38, w * 0.38], r: [0.5, 0, 0.2] }), new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.9 }), null, g);
    return g;
  };
  seat(-0.12, -0.28, 0.46); seat(-0.12, 0.28, 0.46);
  seat(-0.98, 0, 0.98, true);
  // door interior panels with armrests & handles
  for (const s of [-1, 1]) {
    add(place(new RoundedBoxGeometry(0.4, 0.05, 0.06, 2, 0.015), { p: [-0.1, 0.12, s * 0.52] }), plastic);
    add(place(new THREE.BoxGeometry(0.1, 0.02, 0.02), { p: [0.15, 0.25, s * 0.53] }), chrome);
    // window crank-free vent windows / door post trims
    add(place(new THREE.BoxGeometry(0.04, 0.5, 0.04), { p: [0.49, 0.67, s * 0.54], r: [0, 0, -0.15] }), plasticLight);
    add(place(new THREE.BoxGeometry(0.05, 0.48, 0.04), { p: [-0.48, 0.66, s * 0.54] }), plasticLight);
  }
  // overhead console (fresh air vents, cabin light)
  add(place(new RoundedBoxGeometry(0.45, 0.04, 0.2, 2, 0.015), { p: [0.15, 0.88, 0] }), plasticLight);
  for (const s of [-1, 1]) add(place(new THREE.CylinderGeometry(0.025, 0.03, 0.04, 16), { p: [0.4, 0.87, s * 0.45] }), plastic);
  // sun visors
  for (const s of [-1, 1]) add(place(new THREE.BoxGeometry(0.16, 0.008, 0.3), { p: [0.42, 0.86, s * 0.27], r: [0, 0, -0.25] }), plastic);
  // headset hooks & headsets (on the seat backs)
  for (const s of [-1, 1]) {
    const hs = new THREE.Group(); hs.position.set(-0.42, 0.42, s * 0.28); root.add(hs);
    add(new THREE.TorusGeometry(0.09, 0.012, 8, 24, Math.PI), blackSoft, null, hs);
    for (const e of [-1, 1]) add(place(new THREE.CylinderGeometry(0.045, 0.045, 0.035, 20), { p: [e * 0.09, -0.01, 0], r: [0, 0, Math.PI / 2] }), plastic, null, hs);
    hs.rotation.y = Math.PI / 2;
  }
  // ELT / circuit breaker panel strip below panel
  add(place(new THREE.BoxGeometry(0.02, 0.05, 0.4), { p: [0.73, -0.06, -0.3] }), plastic);
}

// Animate control surfaces & cockpit controls from FDM state
export function animateAircraft(model, f, dt, t) {
  const p = model.userData.parts;
  const s = f.surf, c = f.ctrl;
  const D = Math.PI / 180;
  // ailerons: +ail = roll right -> right up, left down
  const ail = s.ail;
  if (p.ailR) p.ailR.rotation.z = -(ail > 0 ? ail * 20 : ail * 14) * D;
  if (p.ailL) p.ailL.rotation.z = -(ail > 0 ? ail * 14 : ail * 20) * D; // pivot axis points outboard (-z)
  // elevator: pull (+) -> TE up (negative z rotation)
  const er = s.elev > 0 ? -s.elev * 28 * D : -s.elev * 23 * D;
  if (p.elevL) p.elevL.rotation.z = er;
  if (p.elevR) p.elevR.rotation.z = er;
  if (p.trimTab) p.trimTab.rotation.z = c.trim * 18 * D;
  if (p.rudder) p.rudder.rotation.y = s.rud * 16 * D;
  // flaps (Fowler): rotate + translate aft/down
  const fl = f.flapPos / 30;
  for (const k of ['flapL', 'flapR']) {
    const fp = p[k]; if (!fp) continue;
    fp.rotation.z = (k === 'flapL' ? 1 : 1) * f.flapPos * D * (k === 'flapL' ? 1 : 1);
    fp.position.set(fp.userData.base.x - 0.16 * fl, fp.userData.base.y - 0.07 * fl, 0);
  }
  // propeller
  const om = f.eng.propOmega;
  if (p.propHub) {
    p.propHub.userData.ang = ((p.propHub.userData.ang || 0) + om * dt) % (Math.PI * 2);
    // visual: real rotation at low rpm; at high rpm use stroboscopic slow rotation + disc
    const rpm = f.eng.rpm;
    const blur = Math.min(1, Math.max(0, (rpm - 350) / 700));
    p.propHub.rotation.x = rpm > 1100 ? p.propHub.userData.ang * 0.03 + t * 2.1 : p.propHub.userData.ang;
    p.propBlades.visible = blur < 0.98;
    p.propBlades.children.forEach((b) => { b.material.transparent = blur > 0.05; b.material.opacity = 1 - blur * 0.85; });
    p.propDisc.material.opacity = blur * 0.85;
  }
  // wheels roll
  const gs = Math.hypot(f.vel[0], f.vel[2]);
  for (const k of ['wheelL', 'wheelR']) if (p[k]) { if (f.groundContact[k === 'wheelL' ? 'left' : 'right']) p[k].rotation.z -= gs / 0.19 * dt; }
  if (p.noseWheel && f.groundContact.nose) p.noseWheel.rotation.z -= gs / 0.17 * dt;
  if (p.noseSteer) p.noseSteer.rotation.y = f.groundContact.nose ? -c.rud * 10 * D : 0;
  if (p.oleo) p.oleo.position.y = Math.min(0.16, f.gearComp.nose || 0) * (f.groundContact.nose ? 1 : 0);
  // cockpit controls
  for (const k of ['yokeL', 'yokeR']) {
    const y = p[k]; if (!y) continue;
    y.position.x = 0.48 - s.elev * 0.075;
    y.userData.wheel.rotation.x = s.ail * 0.8 * (1);
  }
  if (p.trimWheel) p.trimWheel.rotation.z = c.trim * 6;
  if (p.fuelSel) p.fuelSel.rotation.y = { BOTH: 0, LEFT: -Math.PI / 2, RIGHT: Math.PI / 2, OFF: Math.PI }[f.sys.fuelSel] || 0;
  for (const s1 of [-1, 1]) for (const pp of [-1, 1]) { const ped = p[`ped${s1}${pp}`]; if (ped) ped.position.x = 0.78 + pp * c.rud * 0.05; }
  if (p.compassCard) p.compassTex.offset.x = (f.gyro.compass / 360);
  // lights
  const sys = f.eff ? { ...f.sys, ...f.eff } : f.sys, on = f.elec;
  const night = model.userData.night || 0;
  if (p.navL) { p.navL.material.emissiveIntensity = on && sys.nav ? 3 : 0; p.navR.material.emissiveIntensity = on && sys.nav ? 3 : 0; }
  if (p.tailLight) p.tailLight.material.emissiveIntensity = on && sys.nav ? 3 : 0;
  const bcn = on && sys.beacon && (t % 1.2) < 0.12;
  if (p.beacon) p.beacon.material.emissiveIntensity = bcn ? 12 : 0;
  const strobe = on && sys.strobe && ((t % 1.1) < 0.05 || ((t % 1.1) > 0.13 && (t % 1.1) < 0.17));
  if (p.strobeL) { p.strobeL.material.emissiveIntensity = strobe ? 20 : 0; p.strobeR.material.emissiveIntensity = strobe ? 20 : 0; }
  if (p.landingSpot) { p.landingSpot.intensity = on && sys.landing ? 60 + night * 40 : 0; p.landingLens.material.emissiveIntensity = on && sys.landing ? 6 : 0; }
  if (p.taxiSpot) { p.taxiSpot.intensity = on && sys.taxi ? 40 + night * 20 : 0; p.taxiLens.material.emissiveIntensity = on && sys.taxi ? 5 : 0; }
  if (p.cabinLight) p.cabinLight.intensity = on && sys.cabinLights ? 0.6 : 0;
  if (p.panelLight) p.panelLight.intensity = on && sys.panelLights ? 0.06 + 0.3 * (sys.gsDim ?? 0.5) : 0;
  if (p.panelMat) p.panelMat.emissiveIntensity = (1 - night) * 0.1 + (on && sys.panelLights ? (0.35 * night + 0.05) * (0.3 + 0.7 * (sys.panelDim ?? 1)) : 0.0);
}
