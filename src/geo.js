// World definition: real San Francisco Bay Area. Pure JS (shared by renderer, physics, map).
// World coords: local ENU tangent plane at SFO (37.6213 N, 122.3790 W). +X east, +Y up (m above MSL), +Z south.
// Data baked by tools/*.py from public sources:
//   terrain  - AWS Terrain Tiles (USGS 3DEP / SRTM), 50 m grid, airports flattened to published runway-end elevations
//   cover    - ESA WorldCover 2021 10 m (tree / built-up / cropland / water)
//   airports - OurAirports runway ends + OpenStreetMap aeroway geometry (taxiways, aprons, buildings, towers, windsocks)
//   roads    - OpenStreetMap (Geofabrik California extract) incl. bridge decks; tall buildings - OSM height tags
import { fbm, simplex } from './noise.js';

const DATA = new URL('../data/', import.meta.url);
const DV = '?v=20261123a';
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

async function json(name) { const r = await fetch(new URL(name + DV, DATA)); if (!r.ok) throw new Error('missing ' + name); return r.json(); }
async function pixels(name) {
  const r = await fetch(new URL(name + DV, DATA)); const b = await r.blob();
  const bmp = await createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height).data;
}

// ---------------- projection (same as tools/proj.py) ----------------
export const LON0 = -122.3790, LAT0 = 37.6213;
const A_ = 6378137, E2 = 6.69437999014e-3, D2R = Math.PI / 180;
function ecef(lat, lon, h = 0) {
  const sl = Math.sin(lat * D2R), cl = Math.cos(lat * D2R), N = A_ / Math.sqrt(1 - E2 * sl * sl);
  return [(N + h) * cl * Math.cos(lon * D2R), (N + h) * cl * Math.sin(lon * D2R), (N * (1 - E2) + h) * sl];
}
const O = ecef(LAT0, LON0), sla = Math.sin(LAT0 * D2R), cla = Math.cos(LAT0 * D2R), slo = Math.sin(LON0 * D2R), clo = Math.cos(LON0 * D2R);
export function ll2w(lat, lon) {
  const p = ecef(lat, lon), dx = p[0] - O[0], dy = p[1] - O[1], dz = p[2] - O[2];
  const e = -slo * dx + clo * dy, n = -sla * clo * dx - sla * slo * dy + cla * dz;
  return { x: e, z: -n };
}
export function w2ll(x, z) { // good to < 1 m over the area (iterative)
  let lat = LAT0 - z / 111000, lon = LON0 + x / (111320 * cla);
  for (let i = 0; i < 4; i++) { const w = ll2w(lat, lon); lat -= (w.z - z) / -111000; lon += (x - w.x) / (111320 * Math.cos(lat * D2R)); }
  return { lat, lon };
}

// ---------------- load baked data (top-level await: importers wait for it) ----------------
const [GRID, APDATA, NAVDATA, ROADDATA, TALLDATA, STREETIDX, DEMPX, COVPX] = await Promise.all([
  json('grid.json'), json('airports.json'), json('navaids.json'), json('roads.json'), json('tall.json'), json('streets/index.json'), pixels('dem.png'), pixels('cover.png'),
]);
const CELL = GRID.cell, X0 = GRID.x0, Z0 = GRID.z0, NX = GRID.nx, NZ = GRID.nz;
export const WORLD = { x0: X0, z0: Z0, x1: X0 + (NX - 1) * CELL, z1: Z0 + (NZ - 1) * CELL, cell: CELL, nx: NX, nz: NZ };
export const WORLD_CX = (WORLD.x0 + WORLD.x1) / 2, WORLD_CZ = (WORLD.z0 + WORLD.z1) / 2;
export const WORLD_HALF = 65536; // quadtree root half-size (covers the whole extent)
export const WATER_LEVEL = 0;
export function inWorld(x, z, m = 0) { return x > WORLD.x0 + m && x < WORLD.x1 - m && z > WORLD.z0 + m && z < WORLD.z1 - m; }

const H = new Float32Array(NX * NZ), WF = new Uint8Array(NX * NZ), TREE = new Uint8Array(NX * NZ), BUILT = new Uint8Array(NX * NZ), CROP = new Uint8Array(NX * NZ);
for (let i = 0, j = 0; i < NX * NZ; i++, j += 4) {
  H[i] = (DEMPX[j] * 256 + DEMPX[j + 1]) / 10 - 100; WF[i] = DEMPX[j + 2];
  TREE[i] = COVPX[j]; BUILT[i] = COVPX[j + 1]; CROP[i] = COVPX[j + 2];
}
export const RASTER = { H, WF, TREE, BUILT, CROP };

function bil(arr, x, z, scale = 1) {
  let fx = (x - X0) / CELL, fz = (z - Z0) / CELL;
  fx = fx < 0 ? 0 : fx > NX - 1.001 ? NX - 1.001 : fx; fz = fz < 0 ? 0 : fz > NZ - 1.001 ? NZ - 1.001 : fz;
  const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz, i = iz * NX + ix;
  const a = arr[i] + (arr[i + 1] - arr[i]) * tx, b = arr[i + NX] + (arr[i + NX + 1] - arr[i + NX]) * tx;
  return (a + (b - a) * tz) * scale;
}
export function waterFrac(x, z) { return bil(WF, x, z, 1 / 255); }

// ---------------- airports ----------------
function seg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
  let t = ((px - ax) * dx + (pz - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qz = az + dz * t - pz; return { d: Math.sqrt(qx * qx + qz * qz), t };
}
export function pointInPoly(x, z, p) {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i][0], zi = p[i][1], xj = p[j][0], zj = p[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function polyArea(p) { let s = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]); return Math.abs(s / 2); }
function polyCentroid(p) { let x = 0, z = 0; for (const q of p) { x += q[0]; z += q[1]; } return [x / p.length, z / p.length]; }
function dirOf(hdg) { const r = hdg * D2R; return [[Math.sin(r), -Math.cos(r)], [Math.cos(r), Math.sin(r)]]; }

export const AIRPORTS = APDATA.map((d) => {
  const a = { icao: d.icao, name: d.name, size: d.size, tower: d.towered, twrFreq: d.twr, gndFreq: d.gnd, arp: [d.x, d.z], plane: d.plane };
  a.planeY = (x, z) => d.plane[0] + d.plane[1] * (x - d.x) + d.plane[2] * (z - d.z);
  a.runways = d.runways.map((r) => {
    const [dir, perp] = dirOf(r.hdg);
    const R = { id: r.id, rwy: r.id, le: r.le, he: r.he, x: (r.le[0] + r.he[0]) / 2, z: (r.le[1] + r.he[1]) / 2, hdg: r.hdg, len: r.len, wid: r.wid, dir, perp, disp: r.disp, surf: r.surf, lit: r.lit, endElev: r.elev };
    R.elev = a.planeY(R.x, R.z);
    R.ilsList = r.ils.map((s, e) => (s ? { end: e, ident: s[0], freq: s[1], gs: s[2] } : null)).filter(Boolean);
    R.ils = R.ilsList[0] || null;
    return R;
  });
  a.runways.sort((p, q) => q.len - p.len);
  const P = a.runways[0];
  Object.assign(a, { x: P.x, z: P.z, hdg: P.hdg, len: P.len, wid: P.wid, rwy: P.rwy, dir: P.dir, perp: P.perp, elev: P.elev, ils: P.ils });
  a.taxiways = d.taxiways; a.aprons = d.aprons.filter((p) => p.p.length >= 3); a.buildings = d.buildings; a.socks = d.socks;
  a.towerInfo = d.tower ? { x: d.tower.p[0], z: d.tower.p[1], h: d.tower.h, r: d.tower.r } : null;
  // extent radius
  let R = 0; for (const r of a.runways) R = Math.max(R, Math.hypot(r.le[0] - d.x, r.le[1] - d.z), Math.hypot(r.he[0] - d.x, r.he[1] - d.z));
  for (const ap of a.aprons) for (const q of ap.p) R = Math.max(R, Math.hypot(q[0] - d.x, q[1] - d.z));
  a.radius = R + 150;
  // ramp: the general-aviation tie-down apron (smaller apron near the runway with buildings) or the largest one
  let best = null, bs = -1;
  for (const ap of a.aprons) {
    const area = polyArea(ap.p); if (area < 1500) continue;
    const c = polyCentroid(ap.p); const inside = pointInPoly(c[0], c[1], ap.p);
    const s = (inside ? 2 : 1) * Math.sqrt(area) * (a.size === 'L' ? 1 : 1) / (1 + Math.hypot(c[0] - P.x, c[1] - P.z) / 1500);
    if (s > bs) { bs = s; best = { ap, c, area }; }
  }
  if (best) {
    let [cx, cz] = best.c;
    { // interior point closest to the centroid with clearance from the edges
      let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (const q of best.ap.p) { x0 = Math.min(x0, q[0]); z0 = Math.min(z0, q[1]); x1 = Math.max(x1, q[0]); z1 = Math.max(z1, q[1]); }
      let bd = 1e18, bx = cx, bz = cz;
      for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) {
        const x = x0 + (x1 - x0) * i / 24, z = z0 + (z1 - z0) * j / 24;
        if (!pointInPoly(x, z, best.ap.p)) continue;
        let edge = 1e9; for (let k = 0, l = best.ap.p.length - 1; k < best.ap.p.length; l = k++) edge = Math.min(edge, seg(x, z, best.ap.p[l][0], best.ap.p[l][1], best.ap.p[k][0], best.ap.p[k][1]).d);
        const sc = Math.hypot(x - cx, z - cz) - Math.min(edge, 40) * 6; if (sc < bd) { bd = sc; bx = x; bz = z; }
      }
      cx = bx; cz = bz;
    }
    // face the nearest runway
    const u = (cx - P.x) * P.dir[0] + (cz - P.z) * P.dir[1], v = (cx - P.x) * P.perp[0] + (cz - P.z) * P.perp[1];
    const hdgToRwy = (Math.atan2(-P.perp[0] * Math.sign(v), P.perp[1] * Math.sign(v)) / D2R + 360) % 360;
    a.ramp = { x: cx, z: cz, hdg: hdgToRwy, toRwy: hdgToRwy };
    const s = Math.sqrt(best.area) * 0.6;
    a.apron = { u, v, w: s, h: s * 0.6 };
  } else {
    const v = -P.wid * 3; const p = { x: P.x + P.perp[0] * v, z: P.z + P.perp[1] * v };
    a.ramp = { x: p.x, z: p.z, hdg: P.hdg, toRwy: P.hdg }; a.apron = { u: 0, v, w: 60, h: 40 };
  }
  a.taxiV = a.apron.v > 0 ? Math.min(a.apron.v, 120) : Math.max(a.apron.v, -120);
  a.towerPos = a.towerInfo ? { x: a.towerInfo.x, z: a.towerInfo.z, h: a.towerInfo.h } : { x: a.ramp.x, z: a.ramp.z, h: 12 };
  // spatial grid of paved items
  const G = 64, items = new Map();
  const put = (x0, z0, x1, z1, it) => {
    for (let gz = Math.floor(z0 / G); gz <= Math.floor(z1 / G); gz++) for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); gx++) {
      const k = gx * 65536 + gz; let l = items.get(k); if (!l) items.set(k, (l = [])); l.push(it);
    }
  };
  for (const r of a.runways) {
    const ext = r.len / 2 + (r.len > 2000 ? 60 : 15), hw = r.wid / 2 + 1;
    const xs = [], zs = [];
    for (const su of [-1, 1]) for (const sv of [-1, 1]) { xs.push(r.x + r.dir[0] * ext * su + r.perp[0] * hw * sv); zs.push(r.z + r.dir[1] * ext * su + r.perp[1] * hw * sv); }
    put(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), { t: 0, r, ext, hw });
  }
  for (const t of a.taxiways) for (let i = 0; i + 1 < t.p.length; i++) {
    const [ax, az] = t.p[i], [bx, bz] = t.p[i + 1], w = t.w / 2 + 1;
    put(Math.min(ax, bx) - w, Math.min(az, bz) - w, Math.max(ax, bx) + w, Math.max(az, bz) + w, { t: 1, a: t.p[i], b: t.p[i + 1], hw: w });
  }
  for (const ap of a.aprons) {
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (const q of ap.p) { x0 = Math.min(x0, q[0]); z0 = Math.min(z0, q[1]); x1 = Math.max(x1, q[0]); z1 = Math.max(z1, q[1]); }
    put(x0, z0, x1, z1, { t: 2, p: ap.p, holes: ap.h || [] });
  }
  a._grid = items; a._G = G;
  return a;
});
for (const a of AIRPORTS) a.freq = a.twrFreq;

export function pavedAt(x, z) {
  for (const a of AIRPORTS) {
    const dx = x - a.arp[0], dz = z - a.arp[1]; if (dx * dx + dz * dz > a.radius * a.radius) continue;
    const l = a._grid.get(Math.floor(x / a._G) * 65536 + Math.floor(z / a._G)); if (!l) continue;
    for (const it of l) {
      if (it.t === 0) { const r = it.r, ex = x - r.x, ez = z - r.z; if (Math.abs(ex * r.dir[0] + ez * r.dir[1]) < it.ext && Math.abs(ex * r.perp[0] + ez * r.perp[1]) < it.hw) return a; }
      else if (it.t === 1) { if (seg(x, z, it.a[0], it.a[1], it.b[0], it.b[1]).d < it.hw) return a; }
      else if (pointInPoly(x, z, it.p)) { let hole = false; for (const h of it.holes) if (h.length > 2 && pointInPoly(x, z, h)) hole = true; if (!hole) return a; }
    }
  }
  return null;
}
export function airportAt(x, z) { for (const a of AIRPORTS) { const dx = x - a.arp[0], dz = z - a.arp[1]; if (dx * dx + dz * dz < (a.radius + 300) ** 2) return a; } return null; }

export const NAVAIDS = NAVDATA;

export function toLocal(a, x, z) { const dx = x - a.x, dz = z - a.z; return { u: dx * a.dir[0] + dz * a.dir[1], v: dx * a.perp[0] + dz * a.perp[1] }; }
export function fromLocal(a, u, v) { return { x: a.x + a.dir[0] * u + a.perp[0] * v, z: a.z + a.dir[1] * u + a.perp[1] * v }; }
// runway end helpers (end 0 = first designator, landing towards dir; end 1 = reciprocal)
export function runwayEnd(r, e) {
  const s = e === 0 ? -1 : 1; const thr = s * (r.len / 2 - (r.disp[e] || 0));
  const p = fromLocal(r, thr, 0);
  return { id: r.rwy[e], x: p.x, z: p.z, hdg: e === 0 ? r.hdg : (r.hdg + 180) % 360, dir: e === 0 ? r.dir : [-r.dir[0], -r.dir[1]], elev: r.elev, ext: s * r.len / 2 };
}
export function findRunway(icao, id) {
  const a = AIRPORTS.find((q) => q.icao === icao); if (!a) return null;
  for (const r of a.runways) { const e = r.rwy.indexOf(id); if (e >= 0) return { a, r, e }; }
  return { a, r: a.runways[0], e: 0 };
}

// ---------------- detail + airport flattening of terrain ----------------
const FG = 200, FNX = Math.ceil((NX * CELL) / FG) + 1, FNZ = Math.ceil((NZ * CELL) / FG) + 1;
const FLAT = new Float32Array(FNX * FNZ).fill(1);
for (const a of AIRPORTS) {
  const r0 = a.radius + 800;
  for (let iz = Math.max(0, Math.floor((a.arp[1] - r0 - Z0) / FG)); iz <= Math.min(FNZ - 1, Math.ceil((a.arp[1] + r0 - Z0) / FG)); iz++)
    for (let ix = Math.max(0, Math.floor((a.arp[0] - r0 - X0) / FG)); ix <= Math.min(FNX - 1, Math.ceil((a.arp[0] + r0 - X0) / FG)); ix++) {
      const x = X0 + ix * FG, z = Z0 + iz * FG; let d = 1e9;
      for (const r of a.runways) d = Math.min(d, seg(x, z, r.le[0], r.le[1], r.he[0], r.he[1]).d - r.wid / 2);
      for (const ap of a.aprons) { const c = polyCentroid(ap.p); d = Math.min(d, Math.hypot(x - c[0], z - c[1]) - Math.sqrt(polyArea(ap.p)) * 0.7); }
      const i = iz * FNX + ix; FLAT[i] = Math.min(FLAT[i], ss(350, 900, d));
    }
}
function flatAt(x, z) {
  let fx = (x - X0) / FG, fz = (z - Z0) / FG;
  fx = fx < 0 ? 0 : fx > FNX - 1.001 ? FNX - 1.001 : fx; fz = fz < 0 ? 0 : fz > FNZ - 1.001 ? FNZ - 1.001 : fz;
  const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz, i = iz * FNX + ix;
  const a = FLAT[i] + (FLAT[i + 1] - FLAT[i]) * tx, b = FLAT[i + FNX] + (FLAT[i + FNX + 1] - FLAT[i + FNX]) * tx;
  return a + (b - a) * tz;
}

export function heightBase(x, z) { return bil(H, x, z); }
export function heightAt(x, z) {
  const h = bil(H, x, z);
  if (h < 0.5) return h;
  const f = flatAt(x, z); if (f <= 0) return h;
  // sub-grid detail the 50 m DEM can't show (amplitude grows with height so beaches/levees stay clean)
  const amp = f * Math.min(1, h / 8) * (1.2 + Math.min(4, h / 120));
  return h + amp * (fbm(x / 380, z / 380, 3) * 0.9 + 0.25 * simplex(x / 70, z / 70));
}
export function normalAt(x, z, e = 2) {
  const hx = heightAt(x + e, z) - heightAt(x - e, z), hz = heightAt(x, z + e) - heightAt(x, z - e);
  const nx = -hx / (2 * e), nz = -hz / (2 * e), l = Math.hypot(nx, 1, nz); return [nx / l, 1 / l, nz / l];
}

// ---------------- roads (major network: motorway..secondary, incl. bridges) ----------------
const RK = ROADDATA.kinds;
const KMAP = { motorway: 'hwy', trunk: 'hwy', primary: 'road', secondary: 'road', motorway_link: 'link', trunk_link: 'link', primary_link: 'link' };
const SPEED = { motorway: 29, trunk: 25, primary: 17, secondary: 15, motorway_link: 15, trunk_link: 14, primary_link: 12 };
export const ROADS = ROADDATA.ways.map((w) => {
  const kind = RK[w[0]], lanes = Math.max(1, w[1]), oneway = !!(w[2] & 1), bridge = !!(w[2] & 2);
  const pts = Float32Array.from(w[4]); const ys = w[5] ? Float32Array.from(w[5], (v) => v / 10) : null;
  const lw = ROADDATA.defw[kind] || 3.5;
  const width = lanes * lw + (kind === 'motorway' || kind === 'trunk' ? 3 : 1);
  let len = 0; const cum = new Float32Array(pts.length / 2);
  for (let i = 1; i < pts.length / 2; i++) { len += Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]); cum[i] = len; }
  return { kind, cls: KMAP[kind] || 'road', lanes, oneway, bridge, name: ROADDATA.names[w[3]] || '', pts, ys, w: width, len, cum, speed: SPEED[kind] || 14 };
});
const RC = 128, roadGrid = new Map();
ROADS.forEach((r, ri) => {
  const n = r.pts.length / 2;
  for (let i = 0; i + 1 < n; i++) {
    const ax = r.pts[i * 2], az = r.pts[i * 2 + 1], bx = r.pts[i * 2 + 2], bz = r.pts[i * 2 + 3], m = r.w / 2 + 2;
    const L = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.ceil(L / (RC / 2)));
    let last = -1;
    for (let s = 0; s <= steps; s++) {
      const x = ax + (bx - ax) * (s / steps), z = az + (bz - az) * (s / steps);
      for (const ox of [-m, m]) for (const oz of [-m, m]) {
        const k = Math.floor((x + ox) / RC) * 100003 + Math.floor((z + oz) / RC);
        if (k === last) continue; let l = roadGrid.get(k); if (!l) roadGrid.set(k, (l = [])); if (l[l.length - 2] !== ri || l[l.length - 1] !== i) l.push(ri, i); last = k;
      }
    }
  }
});
// coarse 2 km index of whole roads (for streaming traffic / scenery)
const RB = 2000, roadBins = new Map();
ROADS.forEach((r, ri) => {
  const seen = new Set();
  for (let i = 0; i < r.pts.length / 2; i++) { const k = Math.floor(r.pts[i * 2] / RB) * 1000 + Math.floor(r.pts[i * 2 + 1] / RB); if (seen.has(k)) continue; seen.add(k); let l = roadBins.get(k); if (!l) roadBins.set(k, (l = [])); l.push(ri); }
});
export function roadsInBox(x0, z0, x1, z1) {
  const out = new Set();
  for (let bx = Math.floor(x0 / RB); bx <= Math.floor(x1 / RB); bx++) for (let bz = Math.floor(z0 / RB); bz <= Math.floor(z1 / RB); bz++) { const l = roadBins.get(bx * 1000 + bz); if (l) for (const ri of l) out.add(ri); }
  return [...out];
}
export function roadY(r, i, t) { // deck / road-surface height at segment i, parameter t
  const x = r.pts[i * 2] + (r.pts[i * 2 + 2] - r.pts[i * 2]) * t, z = r.pts[i * 2 + 1] + (r.pts[i * 2 + 3] - r.pts[i * 2 + 1]) * t;
  if (r.ys) return r.ys[i] + (r.ys[i + 1] - r.ys[i]) * t;
  return Math.max(heightAt(x, z), 0.8) + 0.12;
}
export function roadNear(x, z, maxD = 60) {
  const l = roadGrid.get(Math.floor(x / RC) * 100003 + Math.floor(z / RC)); if (!l) return null;
  let best = null;
  for (let k = 0; k < l.length; k += 2) {
    const r = ROADS[l[k]], i = l[k + 1];
    const q = seg(x, z, r.pts[i * 2], r.pts[i * 2 + 1], r.pts[i * 2 + 2], r.pts[i * 2 + 3]);
    if (q.d < maxD && (!best || q.d < best.d)) best = { d: q.d, road: r, i, t: q.t };
  }
  return best;
}
export function onRoad(x, z) { const n = roadNear(x, z, 30); return n && n.d < n.road.w / 2 + 0.3 ? n : null; }

// ---------------- real OSM buildings + mapped trees (1 km binary tiles, fetched only when the camera is near) ----------------
export const BLD_TILE = 1000;
let bldIndex = null;
const bldCache = new Map();
/** -> { rects: [{x,z,w,d,yaw,h,type,roof}], polys: [{h,type,p:[[x,z]...]}], trees: [{x,z,h,kind}] } in world metres */
export function bldTile(cx, cz) {
  const key = cx + '_' + cz;
  let p = bldCache.get(key); if (p) return p;
  if (!bldIndex) bldIndex = json('bld/index.json').then((a) => new Set(a)).catch(() => new Set());
  p = bldIndex.then((set) => {
    if (!set.has(key)) return { rects: [], polys: [], trees: [] };
    return fetch(new URL('bld/' + key + '.bin' + DV, DATA)).then((r) => (r.ok ? r.arrayBuffer() : null)).then((buf) => {
      if (!buf) return { rects: [], polys: [], trees: [] };
      const v = new DataView(buf); const ox = cx * BLD_TILE - 500, oz = cz * BLD_TILE - 500; let o = 8;
      const nR = v.getUint16(0, true), nP = v.getUint16(2, true), nT = v.getUint16(4, true);
      const rects = new Array(nR), polys = new Array(nP), trees = new Array(nT);
      for (let i = 0; i < nR; i++, o += 10) rects[i] = { x: ox + v.getUint16(o, true) / 20, z: oz + v.getUint16(o + 2, true) / 20, w: v.getUint8(o + 4) / 2, d: v.getUint8(o + 5) / 2, yaw: v.getUint8(o + 6) / 256 * Math.PI, h: v.getUint8(o + 7) / 2, type: v.getUint8(o + 8), roof: v.getUint8(o + 9) };
      for (let i = 0; i < nP; i++) { const n = v.getUint16(o, true), h = v.getUint8(o + 2) / 2, type = v.getUint8(o + 3); o += 4; const pts = new Array(n); for (let k = 0; k < n; k++, o += 4) pts[k] = [ox + v.getUint16(o, true) / 20, oz + v.getUint16(o + 2, true) / 20]; polys[i] = { h, type, p: pts }; }
      for (let i = 0; i < nT; i++, o += 6) trees[i] = { x: ox + v.getUint16(o, true) / 20, z: oz + v.getUint16(o + 2, true) / 20, h: v.getUint8(o + 4), kind: v.getUint8(o + 5) };
      return { rects, polys, trees };
    });
  }).catch(() => ({ rects: [], polys: [], trees: [] }));
  bldCache.set(key, p);
  if (bldCache.size > 120) { const k0 = bldCache.keys().next().value; bldCache.delete(k0); }
  return p;
}

// ---------------- streets (streamed tiles) ----------------
export const STREET_TILE = 4000;
const STREET_SET = new Set(STREETIDX);
const streetCache = new Map();
const SK_SPEED = { tertiary: 13, residential: 10, unclassified: 11, living_street: 5, secondary_link: 11, tertiary_link: 10 };
export function streetTile(tx, tz) {
  const key = tx + '_' + tz;
  if (!STREET_SET.has(key)) return Promise.resolve([]);
  let p = streetCache.get(key);
  if (!p) {
    p = json('streets/' + key + '.json').then((d) => d.ways.map((w) => {
      const kind = d.kinds[w[0]], pts = Float32Array.from(w[3]);
      let len = 0; const cum = new Float32Array(pts.length / 2);
      for (let i = 1; i < pts.length / 2; i++) { len += Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]); cum[i] = len; }
      return { kind, cls: 'street', lanes: Math.max(1, w[1]), oneway: !!(w[2] & 1), pts, ys: null, w: kind === 'tertiary' ? 9 : kind === 'living_street' ? 5 : 7.5, len, cum, speed: SK_SPEED[kind] || 10 };
    })).catch(() => []);
    streetCache.set(key, p);
  }
  return p;
}

// ---------------- tall buildings (OSM height tags) ----------------
export const TALL = TALLDATA.map((t) => ({ h: t[0], mh: t[1], part: !!t[2], p: (() => { const a = []; for (let i = 0; i < t[3].length; i += 2) a.push([t[3][i], t[3][i + 1]]); return a; })(), col: t[4], name: t[5] }));

// ---------------- surface & ground ----------------
// 'runway' (any pavement on an aerodrome), 'road', 'water', 'grass'
export function surfaceAt(x, z, h) {
  if (pavedAt(x, z)) return 'runway';
  const rn = onRoad(x, z);
  if (rn) return 'road';
  if (waterFrac(x, z) > 0.5) return 'water';
  return 'grass';
}
export function groundQuery(x, z, y = 1e9) {
  if (pavedAt(x, z)) { const a = airportAt(x, z); return { h: heightAt(x, z), n: [0, 1, 0], surface: 'runway', airport: a }; }
  const rn = onRoad(x, z);
  if (rn && !(rn.road.ys && y < roadY(rn.road, rn.i, rn.t) - 4)) return { h: roadY(rn.road, rn.i, rn.t), n: rn.road.ys ? [0, 1, 0] : normalAt(x, z, 4), surface: 'runway', road: rn.road };
  const h = heightAt(x, z);
  if (waterFrac(x, z) > 0.5) return { h: WATER_LEVEL, n: [0, 1, 0], surface: 'water' };
  return { h, n: normalAt(x, z, 1.5), surface: 'grass' };
}

// ---------------- land cover (ESA WorldCover fractions at 50 m) ----------------
export function forestAt(x, z, h, slope = 0) {
  if (waterFrac(x, z) > 0.4) return 0;
  return bil(TREE, x, z, 1 / 255) * (1 - ss(0.6, 0.85, slope));
}
export function townAt(x, z) { return bil(BUILT, x, z, 1 / 255); }
export function farmAt(x, z) { return bil(CROP, x, z, 1 / 255); }

// ---------------- cities (labels, map, ATC phraseology) ----------------
const CITY_LL = [
  ['San Francisco', 37.7793, -122.4193, 3], ['Oakland', 37.8044, -122.2712, 3], ['San Jose', 37.3382, -121.8863, 3],
  ['Berkeley', 37.8716, -122.2727, 2], ['Fremont', 37.5485, -121.9886, 2], ['Hayward', 37.6688, -122.0808, 2], ['Palo Alto', 37.4419, -122.1430, 2],
  ['San Mateo', 37.5630, -122.3255, 2], ['Daly City', 37.6879, -122.4702, 2], ['Concord', 37.9780, -122.0311, 2], ['Walnut Creek', 37.9101, -122.0652, 2],
  ['Livermore', 37.6819, -121.7680, 2], ['Richmond', 37.9358, -122.3477, 2], ['Vallejo', 38.1041, -122.2566, 2], ['Napa', 38.2975, -122.2869, 2],
  ['Sunnyvale', 37.3688, -122.0363, 2], ['Mountain View', 37.3861, -122.0839, 2], ['Santa Clara', 37.3541, -121.9552, 2], ['Redwood City', 37.4852, -122.2364, 2],
  ['San Rafael', 37.9735, -122.5311, 2], ['Novato', 38.1074, -122.5697, 2], ['Petaluma', 38.2324, -122.6367, 2], ['Pleasanton', 37.6624, -121.8747, 2],
  ['San Leandro', 37.7249, -122.1561, 1], ['Alameda', 37.7652, -122.2416, 1], ['Milpitas', 37.4323, -121.8996, 1], ['Union City', 37.5934, -122.0438, 1],
  ['Dublin', 37.7022, -121.9358, 1], ['San Ramon', 37.7799, -121.9780, 1], ['Danville', 37.8216, -121.9999, 1], ['Lafayette', 37.8858, -122.1180, 1],
  ['Martinez', 38.0194, -122.1341, 1], ['Pittsburg', 38.0280, -121.8847, 1], ['Antioch', 38.0049, -121.8058, 1], ['Benicia', 38.0494, -122.1586, 1],
  ['Sausalito', 37.8591, -122.4853, 1], ['Mill Valley', 37.9060, -122.5450, 1], ['South San Francisco', 37.6547, -122.4077, 1], ['Burlingame', 37.5841, -122.3661, 1],
  ['Half Moon Bay', 37.4636, -122.4286, 1], ['Pacifica', 37.6138, -122.4869, 1], ['Menlo Park', 37.4530, -122.1817, 1], ['Cupertino', 37.3230, -122.0322, 1],
  ['Los Gatos', 37.2358, -121.9624, 1], ['Newark', 37.5297, -122.0402, 1], ['Castro Valley', 37.6941, -122.0864, 1], ['Orinda', 37.8771, -122.1797, 1],
  ['El Cerrito', 37.9161, -122.3108, 1], ['San Pablo', 37.9621, -122.3455, 1], ['Hercules', 38.0171, -122.2886, 1], ['American Canyon', 38.1749, -122.2608, 1],
  ['Sonoma', 38.2919, -122.4580, 1], ['San Bruno', 37.6305, -122.4111, 1], ['Millbrae', 37.5985, -122.3872, 1], ['Foster City', 37.5585, -122.2711, 1],
  ['Belmont', 37.5202, -122.2758, 1], ['San Carlos', 37.5072, -122.2605, 1], ['Tiburon', 37.8735, -122.4566, 1], ['Moraga', 37.8349, -122.1297, 1],
];
export const TOWNS = CITY_LL.map(([name, lat, lon, rank]) => { const p = ll2w(lat, lon); return { name: name.toUpperCase(), label: name, x: p.x, z: p.z, rank, r: rank === 3 ? 6000 : rank === 2 ? 3000 : 1500 }; })
  .filter((t) => inWorld(t.x, t.z));
export const TOWN = TOWNS[0];
export const WATER_NAMES = [
  ['San Francisco Bay', 37.62, -122.22], ['San Pablo Bay', 38.06, -122.40], ['Pacific Ocean', 37.65, -122.62], ['Suisun Bay', 38.07, -122.03], ['Richardson Bay', 37.875, -122.49],
].map(([n, la, lo]) => ({ name: n, ...ll2w(la, lo) }));
export const PLACES = [
  ['Mount Diablo', 37.8816, -121.9142], ['Mount Tamalpais', 37.9235, -122.5965], ['Golden Gate Bridge', 37.8199, -122.4783], ['Bay Bridge', 37.7983, -122.3778],
  ['San Mateo Bridge', 37.5847, -122.2010], ['Dumbarton Bridge', 37.5050, -122.1170], ['Alcatraz', 37.8267, -122.4230], ['Angel Island', 37.8609, -122.4326],
].map(([n, la, lo]) => ({ name: n, ...ll2w(la, lo) }));

export function nm(m) { return m / 1852; }
