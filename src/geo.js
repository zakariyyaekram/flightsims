// World definition: terrain height field, airports, navaids, land cover. Pure JS (shared by renderer, physics, map).
// World coords: +X east, +Y up, +Z south (north = -Z). Units: meters.
import { fbm, ridged, simplex } from './noise.js';

export const WORLD_HALF = 32768;
export const WATER_LEVEL = 196;

const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export const AIRPORTS = [
  {
    icao: 'KVLY', name: 'Cedar Valley Regional', x: 0, z: 0, hdg: 90, len: 1650, wid: 30, rwy: ['09', '27'],
    tower: true, ils: { end: 1, freq: 110.30, ident: 'IVLY' }, apron: { u: 300, v: -175, w: 260, h: 110 }, taxiV: -115,
  },
  {
    icao: 'KLKS', name: 'Lakeshore Municipal', x: 9800, z: 7600, hdg: 0, len: 1250, wid: 23, rwy: ['36', '18'],
    apron: { u: -250, v: 110, w: 160, h: 80 }, taxiV: 75,
  },
  {
    icao: 'KRDG', name: 'Granite Ridge Field', x: -7400, z: -12400, hdg: 40, len: 980, wid: 18, rwy: ['04', '22'],
    apron: { u: 150, v: -80, w: 110, h: 60 }, taxiV: -45,
  },
];
// navaids
export const NAVAIDS = [
  { type: 'VOR', ident: 'VLY', name: 'Cedar Valley', freq: 113.4, x: 650, z: -520 },
  { type: 'VOR', ident: 'RDG', name: 'Granite', freq: 116.8, x: -6900, z: -13200 },
  { type: 'NDB', ident: 'LK', name: 'Lakeshore', freq: 0.344, x: 9900, z: 5200 },
];

// precompute natural elevation for airports
for (const a of AIRPORTS) {
  const r = (a.hdg * Math.PI) / 180;
  a.dir = [Math.sin(r), -Math.cos(r)]; // runway direction (x,z) for heading
  a.perp = [Math.cos(r), Math.sin(r)]; // right of runway direction
}

function natural(x, z) {
  let h = 250 + 70 * fbm(x / 16000, z / 16000, 4);
  h += 48 * fbm(x / 3800 + 3.1, z / 3800 - 1.7, 5);
  // northern mountain range
  const mN = ss(2500, 16000, -z + 3000 * simplex(x / 9000, 5.5)) * (0.65 + 0.35 * simplex(x / 12000, z / 12000 + 2));
  const r = ridged(x / 7600 + 1.3, z / 7600 - 2.2, 7);
  h += mN * 2700 * Math.pow(r, 1.5);
  // southwest bluffs
  const mS = ss(6000, 22000, Math.hypot(x + 20000, z - 18000) * -1 + 26000) * 0.9;
  h += mS * 520 * Math.pow(ridged(x / 5200, z / 5200, 5), 2);
  // lake basin east of Lakeshore
  const ld = Math.hypot((x - 15200) / 1.25, z - 6600) / 3200 + 0.22 * simplex(x / 2500, z / 2500);
  const lake = ss(1.0, 0.55, ld);
  h = h * (1 - lake) + (WATER_LEVEL - 22) * lake;
  // river valley meandering from mountains into the lake
  const rvx = 9000 + 2400 * Math.sin(z / 4200) + 900 * simplex(z / 3000, 3);
  const riv = ss(420, 60, Math.abs(x - rvx)) * ss(-9000, -2000, z) * ss(9000, 4000, z);
  h = h - riv * Math.max(0, h - (WATER_LEVEL - 6)) * 0.97;
  // fine detail
  h += 4.0 * fbm(x / 260, z / 260, 3) + 0.7 * simplex(x / 31, z / 31) + 0.25 * simplex(x / 9, z / 9);
  return h;
}

for (const a of AIRPORTS) {
  // elevation = average around runway
  let s = 0, n = 0;
  for (let u = -a.len / 2; u <= a.len / 2; u += a.len / 8) { s += natural(a.x + a.dir[0] * u, a.z + a.dir[1] * u); n++; }
  a.elev = Math.max(WATER_LEVEL + 12, s / n);
  if (a.icao === 'KVLY') a.elev = Math.max(a.elev, 238);
}
export function toLocal(a, x, z) {
  const dx = x - a.x, dz = z - a.z;
  return { u: dx * a.dir[0] + dz * a.dir[1], v: dx * a.perp[0] + dz * a.perp[1] };
}
export function fromLocal(a, u, v) {
  return { x: a.x + a.dir[0] * u + a.perp[0] * v, z: a.z + a.dir[1] * u + a.perp[1] * v };
}

function heightBase(x, z) {
  let h = natural(x, z);
  for (const a of AIRPORTS) {
    const { u, v } = toLocal(a, x, z);
    const hl = a.len / 2 + 220, hw = 300;
    const dx = Math.max(Math.abs(u) - hl, 0), dz = Math.max(Math.abs(v) - hw, 0);
    const d = Math.hypot(dx, dz);
    if (d < 700) {
      const t = 1 - ss(0, 700, d);
      // runway has a tiny crown and gentle longitudinal slope
      const crown = Math.abs(v) < a.wid / 2 ? -Math.abs(v) * 0.008 : -a.wid / 2 * 0.008;
      h = h * (1 - t) + (a.elev + crown * t + u * 0.0015 * 0) * t;
    }
  }
  return h;
}

// terrain height including road beds (cut & fill along every road)
export function heightAt(x, z) {
  const h = heightBase(x, z);
  if (!roadGrid.has(Math.floor(x / RCELL) * 100003 + Math.floor(z / RCELL))) return h;
  const n = roadBed(x, z);
  if (!n) return h;
  const half = n.road.w / 2 + 2.5;
  const t = n.d < half ? 1 : ss(half + n.road.bank, half, n.d);
  return h + (n.y - h) * t;
}

export function normalAt(x, z, e = 2) {
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  const nx = -hx / (2 * e), nz = -hz / (2 * e);
  const l = Math.hypot(nx, 1, nz);
  return [nx / l, 1 / l, nz / l];
}

// What is under a point? 'runway' (paved), 'grass', 'dirt', 'water'
export function surfaceAt(x, z, h) {
  for (const a of AIRPORTS) {
    const { u, v } = toLocal(a, x, z);
    if (Math.abs(u) < a.len / 2 + 8 && Math.abs(v) < a.wid / 2 + 0.5) return 'runway';
    if (Math.abs(u) < a.len / 2 + 30 && Math.abs(v - a.taxiV) < 6) return 'runway';
    // connector taxiways at ends and middle
    for (const cu of [-a.len / 2 + 40, 0, a.len / 2 - 40]) {
      if (Math.abs(u - cu) < 7 && v * Math.sign(a.taxiV) > 0 && Math.abs(v) < Math.abs(a.taxiV)) return 'runway';
    }
    const ap = a.apron;
    if (Math.abs(u - ap.u) < ap.w / 2 && Math.abs(v - ap.v) < ap.h / 2) return 'runway';
  }
  if (onRoad(x, z)) return 'road';
  if (h < WATER_LEVEL) return 'water';
  if (onTownStreet(x, z)) return 'road';
  return 'grass';
}

export function groundQuery(x, z) {
  const h = heightAt(x, z);
  const s = surfaceAt(x, z, h);
  if (s === 'water') return { h: WATER_LEVEL, n: [0, 1, 0], surface: 'water' };
  if (s === 'road') return { h: Math.max(h, WATER_LEVEL + 2.5) + 0.2, n: normalAt(x, z, 4), surface: 'runway' }; // paved
  return { h, n: s === 'runway' ? [0, 1, 0] : normalAt(x, z, 1.5), surface: s };
}

// Land cover: forest density (0..1), farmland (0..1)
export function forestAt(x, z, h, slope) {
  if (h < WATER_LEVEL + 2) return 0;
  let f = ss(0.02, 0.32, fbm(x / 2600 + 7, z / 2600 - 3, 5) + 0.12 * simplex(x / 300, z / 300));
  f *= 1 - ss(1650, 1900, h + 120 * simplex(x / 900, z / 900));
  f *= 1 - ss(0.55, 0.8, slope);
  // mountain foothills more forested
  if (h > 500) f = Math.min(1, f * 1.25 + 0.15);
  f *= 1 - 0.8 * townAt(x, z);
  if (f > 0.01) { const rn = roadNear(x, z, 40); if (rn) f *= ss(rn.road.w / 2 + 4, rn.road.w / 2 + 22, rn.d); }
  for (const a of AIRPORTS) {
    const { u, v } = toLocal(a, x, z);
    const dx = Math.max(Math.abs(u) - a.len / 2 - 450, 0), dz = Math.max(Math.abs(v) - 380, 0);
    f *= ss(0, 350, Math.hypot(dx, dz));
  }
  return f;
}
export function farmAt(x, z, h, slope) {
  if (h < WATER_LEVEL + 1) return 0;
  return ss(560, 430, h) * ss(0.16, 0.06, slope) * ss(-0.35, 0.05, fbm(x / 7000 - 4, z / 7000 + 9, 3)) * (1 - townAt(x, z));
}

// ---------------- settlements ----------------
// rot = street grid rotation (deg), grid = block size (m), core = downtown radius (m)
export const TOWNS = [
  { name: 'CEDAR FALLS', x: 2600, z: 2300, r: 1100, rot: 18, grid: 70, core: 260, seed: 4242 },
  { name: 'LAKESHORE', x: 11500, z: 11200, r: 800, rot: -8, grid: 66, core: 180, seed: 77 },
  { name: 'MILLBROOK', x: -9300, z: 6600, r: 620, rot: 5, grid: 64, core: 120, seed: 913 },
  { name: 'SOUTHGATE', x: 3900, z: 15200, r: 680, rot: 31, grid: 68, core: 140, seed: 5150 },
  { name: 'WESTFIELD', x: -17200, z: -1800, r: 460, rot: -22, grid: 62, core: 90, seed: 2718 },
  { name: 'GRANITE', x: -4350, z: -10150, r: 380, rot: 40, grid: 58, core: 70, seed: 1618 },
];
export const TOWN = TOWNS[0];
for (const t of TOWNS) { const r = t.rot * Math.PI / 180; t.cr = Math.cos(r); t.sr = Math.sin(r); }
export function townLocal(t, x, z) { const dx = x - t.x, dz = z - t.z; return { u: dx * t.cr + dz * t.sr, v: -dx * t.sr + dz * t.cr }; }
export function townWorld(t, u, v) { return { x: t.x + u * t.cr - v * t.sr, z: t.z + u * t.sr + v * t.cr }; }
// 0..1 how "inside town" a point is
export function townAt(x, z) {
  let m = 0;
  for (const t of TOWNS) { const d = Math.hypot(x - t.x, z - t.z); if (d < t.r * 1.1) m = Math.max(m, ss(t.r * 1.05, t.r * 0.7, d)); }
  return m;
}
// is the point on a town street? (streets: grid lines inside 0.92 r, 8 m wide)
export function onTownStreet(x, z) {
  for (const t of TOWNS) {
    const dx = x - t.x, dz = z - t.z; if (dx * dx + dz * dz > t.r * t.r * 0.86) continue;
    const { u, v } = townLocal(t, x, z);
    const fu = ((u % t.grid) + t.grid) % t.grid, fv = ((v % t.grid) + t.grid) % t.grid;
    if (Math.min(fu, t.grid - fu) < 4 || Math.min(fv, t.grid - fv) < 4) return true;
  }
  return false;
}

// ---------------- road network ----------------
// control points (x,z); smoothed with Catmull-Rom and resampled every 10 m
export const ROADS = [
  { name: 'I-40', kind: 'hwy', w: 13, lanes: 2, speed: 31, pts: [[-20700, 3050], [-17000, 3000], [-12500, 3900], [-9300, 4300], [-5000, 4700], [-1000, 4900], [3900, 4800], [7300, 5600], [8200, 8200], [8600, 11000], [10200, 13000], [13500, 13600], [18000, 13300], [24000, 12600], [31000, 12400]] },
  { name: 'SR-9', kind: 'road', w: 8, lanes: 1, speed: 22, pts: [[3100, 1150], [1900, 700], [1350, 250], [1250, -380], [700, -560], [300, -700], [-1600, -2400], [-3700, -3400], [-4250, -5800], [-4300, -8300], [-4200, -9500], [-4350, -10100], [-4300, -11700], [-5500, -12300], [-6300, -12900], [-7060, -12960], [-7460, -12640]] },
  { name: 'SR-12', kind: 'road', w: 8, lanes: 1, speed: 24, pts: [[2900, 3300], [3300, 4800], [3500, 9000], [3900, 15200], [4300, 21000], [5200, 31000]] },
  { name: 'SR-5', kind: 'road', w: 8, lanes: 1, speed: 23, pts: [[-9300, -1000], [-9400, 1500], [-9300, 4300], [-9300, 6600], [-9800, 9300]] },
  { name: 'LAKE RD', kind: 'road', w: 8, lanes: 1, speed: 20, pts: [[10100, 7900], [10600, 9000], [11300, 10200], [11500, 11200], [11400, 12400], [10900, 13200]] },
  { name: 'WEST RD', kind: 'road', w: 7, lanes: 1, speed: 21, pts: [[-17200, 3000], [-17200, -1800], [-17600, -5200]] },
  { name: 'CO-3', kind: 'rural', w: 6, lanes: 1, speed: 18, pts: [[-9800, 9300], [-3000, 9600], [3450, 9000], [8600, 9800]] },
  { name: 'CO-7', kind: 'rural', w: 6, lanes: 1, speed: 18, pts: [[-7000, -5300], [-4250, -5600], [1500, -5000], [6500, -5400], [12500, -4800]] },
  { name: 'CO-11', kind: 'rural', w: 6, lanes: 1, speed: 18, pts: [[-3800, 4800], [-4100, 9600], [-3600, 15000], [-4200, 22000]] },
  { name: 'CO-14', kind: 'rural', w: 6, lanes: 1, speed: 18, pts: [[-8000, 19600], [-4000, 19800], [4100, 19500], [12000, 19900], [22000, 19200]] },
  { name: 'CO-2', kind: 'rural', w: 6, lanes: 1, speed: 18, pts: [[17500, 13400], [17800, 17000], [17400, 24000]] },
];
function catmull(pts, step) {
  const P = [pts[0], ...pts, pts[pts.length - 1]]; const out = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 4));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  // resample uniformly
  const res = [out[0]]; let acc = 0;
  for (let i = 1; i < out.length; i++) {
    let [ax, az] = out[i - 1]; const [bx, bz] = out[i]; let seg = Math.hypot(bx - ax, bz - az);
    while (acc + seg >= step) { const t = (step - acc) / seg; ax += (bx - ax) * t; az += (bz - az) * t; res.push([ax, az]); seg = Math.hypot(bx - ax, bz - az); acc = 0; }
    acc += seg;
  }
  res.push(out[out.length - 1]);
  return res;
}
const RCELL = 100; const roadGrid = new Map();
for (const r of ROADS) {
  r.line = catmull(r.pts, 10);
  r.len = (r.line.length - 1) * 10;
  for (let i = 0; i < r.line.length - 1; i++) {
    const [ax, az] = r.line[i], [bx, bz] = r.line[i + 1];
    const pad = r.w / 2 + 40;
    for (let cx = Math.floor((Math.min(ax, bx) - pad) / RCELL); cx <= Math.floor((Math.max(ax, bx) + pad) / RCELL); cx++)
      for (let cz = Math.floor((Math.min(az, bz) - pad) / RCELL); cz <= Math.floor((Math.max(az, bz) + pad) / RCELL); cz++) {
        const k = cx * 100003 + cz; let l = roadGrid.get(k); if (!l) roadGrid.set(k, l = []); l.push(r, i);
      }
  }
}
// grade-limited vertical profile (cut & fill) so roads never climb cliffs
for (const r of ROADS) {
  const N = r.line.length; const raw = r.line.map(([x, z]) => Math.max(heightBase(x, z), WATER_LEVEL + 3.2));
  let p = raw.map((_, i) => { let a = 0, c = 0; for (let k = -4; k <= 4; k++) { const j = i + k; if (j >= 0 && j < N) { a += raw[j]; c++; } } return a / c; });
  const gd = (r.kind === 'hwy' ? 0.055 : r.kind === 'road' ? 0.085 : 0.11) * 10;
  for (let it = 0; it < 60; it++) {
    for (let i = 1; i < N; i++) p[i] = Math.min(Math.max(p[i], p[i - 1] - gd), p[i - 1] + gd);
    for (let i = N - 2; i >= 0; i--) p[i] = Math.min(Math.max(p[i], p[i + 1] - gd), p[i + 1] + gd);
  }
  for (let pass = 0; pass < 3; pass++) p = p.map((_, i) => { let a = 0, c = 0; for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < N) { a += p[j]; c++; } } return a / c; });
  r.prof = p.map((v) => Math.max(v, WATER_LEVEL + 3.2));
  r.bank = r.kind === 'hwy' ? 34 : 26; // embankment / cut blend width
  r.maxCut = Math.max(...r.prof.map((v, i) => Math.abs(v - raw[i])));
}
function roadBed(x, z) {
  const maxD = 52; let best = null, bd = maxD;
  const cx0 = Math.floor((x - maxD) / RCELL), cx1 = Math.floor((x + maxD) / RCELL), cz0 = Math.floor((z - maxD) / RCELL), cz1 = Math.floor((z + maxD) / RCELL);
  for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
    const l = roadGrid.get(cx * 100003 + cz); if (!l) continue;
    for (let j = 0; j < l.length; j += 2) {
      const r = l[j], i = l[j + 1]; const [ax, az] = r.line[i], [bx, bz] = r.line[i + 1];
      const ex = bx - ax, ez = bz - az; const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
      const d = Math.hypot(x - ax - ex * t, z - az - ez * t);
      if (d < bd && d < r.w / 2 + 2.5 + r.bank) { bd = d; best = { d, road: r, y: r.prof[i] + (r.prof[i + 1] - r.prof[i]) * t }; }
    }
  }
  return best;
}
// road surface height at a distance s along the road (metres)
export function roadY(r, s) { const f = Math.max(0, Math.min(r.line.length - 1.001, s / 10)); const i = Math.floor(f); return r.prof[i] + (r.prof[i + 1] - r.prof[i]) * (f - i); }

// distance to nearest road centreline (returns { d, road } or null if > 60 m away)
export function roadNear(x, z, maxD = 60) {
  let best = null, bd = maxD;
  const cx0 = Math.floor((x - maxD) / RCELL), cx1 = Math.floor((x + maxD) / RCELL), cz0 = Math.floor((z - maxD) / RCELL), cz1 = Math.floor((z + maxD) / RCELL);
  for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
    const l = roadGrid.get(cx * 100003 + cz); if (!l) continue;
    for (let j = 0; j < l.length; j += 2) {
      const r = l[j], i = l[j + 1]; const [ax, az] = r.line[i], [bx, bz] = r.line[i + 1];
      const ex = bx - ax, ez = bz - az; const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
      const d = Math.hypot(x - ax - ex * t, z - az - ez * t);
      if (d < bd) { bd = d; best = { d, road: r }; }
    }
  }
  return best;
}
export function onRoad(x, z) { const n = roadNear(x, z, 10); return !!(n && n.d < n.road.w / 2 + 0.5); }

export function nm(m) { return m / 1852; }

export { heightBase };
