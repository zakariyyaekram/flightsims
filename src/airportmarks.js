// Taxiway surface markings and signs to FAA AC 150/5340-1M (markings) and AIM 2-3 (signs):
//  - taxiway centerline: continuous yellow, 6-12 in (15-30 cm), black border on light pavement, carried
//    onto the runway only as lead-on / lead-off lines (crossing taxiways stop at the runway edge)
//  - taxiway edge: continuous double yellow, 6 in lines 6 in apart, only where the pavement edge meets
//    unpaved ground (not across junctions, aprons or runways); paved shoulders beyond at large airports
//  - runway holding position (Pattern A): two solid + two dashed yellow 12 in lines, black border
//  - enhanced taxiway centerline: 9 ft dashes / 3 ft gaps either side for 150 ft before the hold line
//  - surface painted holding position sign (red, white inscription) on the holding side, left of centerline
//  - elevated runway holding position sign (red / white) and taxiway location sign (black / yellow)
import * as THREE from 'three';
import { toLocal, pointInPoly } from './geo.js';

const FT = 0.3048;

/** round the polyline's corners with fillets (control point at the corner); radius r in metres */
export function smoothLine(p, r) {
  if (p.length < 3) return p.map((q) => [q[0], q[1]]);
  const out = [[p[0][0], p[0][1]]];
  for (let i = 1; i < p.length - 1; i++) {
    const A = p[i - 1], B = p[i], C = p[i + 1];
    const ax = B[0] - A[0], az = B[1] - A[1], bx = C[0] - B[0], bz = C[1] - B[1];
    const la = Math.hypot(ax, az) || 1e-6, lb = Math.hypot(bx, bz) || 1e-6;
    const th = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb))));
    if (th < 0.035 || la < 0.5 || lb < 0.5) { out.push([B[0], B[1]]); continue; }
    const c = Math.min(r * Math.tan(Math.min(th, 2.6) / 2), 0.45 * la, 0.45 * lb);
    const P0 = [B[0] - ax / la * c, B[1] - az / la * c], P2 = [B[0] + bx / lb * c, B[1] + bz / lb * c];
    const n = Math.max(2, Math.ceil(th / 0.1));
    for (let k = 0; k <= n; k++) { const t = k / n, u = 1 - t; out.push([u * u * P0[0] + 2 * u * t * B[0] + t * t * P2[0], u * u * P0[1] + 2 * u * t * B[1] + t * t * P2[1]]); }
  }
  out.push([p[p.length - 1][0], p[p.length - 1][1]]);
  return out;
}

/** evenly spaced samples with unit tangent / left normal and arc length */
export function resampleLine(p, step) {
  const S = []; let acc = 0;
  for (let i = 0; i + 1 < p.length; i++) {
    const [ax, az] = p[i], [bx, bz] = p[i + 1], L = Math.hypot(bx - ax, bz - az); if (L < 1e-3) continue;
    const tx = (bx - ax) / L, tz = (bz - az) / L, n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) S.push({ x: ax + (bx - ax) * k / n, z: az + (bz - az) * k / n, tx, tz, s: acc + L * k / n });
    acc += L;
  }
  const l = p[p.length - 1], q = S[S.length - 1]; if (q) S.push({ x: l[0], z: l[1], tx: q.tx, tz: q.tz, s: acc });
  // smooth tangents at sample points
  for (let i = 0; i < S.length; i++) {
    const a = S[Math.max(0, i - 1)], b = S[Math.min(S.length - 1, i + 1)]; let tx = b.x - a.x, tz = b.z - a.z; const L = Math.hypot(tx, tz) || 1;
    S[i].tx = tx / L; S[i].tz = tz / L; S[i].nx = -S[i].tz; S[i].nz = S[i].tx;
  }
  return S;
}

// flat strip (line of paint) along a list of centre points [x, z] with width w; returns position-only geometry data
function strip(pts, w, lift, gh, out) {
  if (pts.length < 2) return;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const p0 = norm(pts, i), p1 = norm(pts, i + 1);
    const A0 = [a[0] + p0[0] * w / 2, a[1] + p0[1] * w / 2], A1 = [a[0] - p0[0] * w / 2, a[1] - p0[1] * w / 2];
    const B0 = [b[0] + p1[0] * w / 2, b[1] + p1[1] * w / 2], B1 = [b[0] - p1[0] * w / 2, b[1] - p1[1] * w / 2];
    for (const q of [A0, B0, B1, A0, B1, A1]) out.push(q[0], gh(q[0], q[1]) + lift, q[1]);
  }
}
function norm(pts, i) {
  const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]; const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
  return [-dz / L, dx / L];
}
// oriented quad: centre c, along unit (ux,uz), half sizes; optional uv rect
function quad(cx, cz, ux, uz, ha, hw, lift, gh, out, uvOut, uv) {
  const px = -uz, pz = ux;
  const C = [[-ha, -hw], [ha, -hw], [ha, hw], [-ha, hw]].map(([a, w]) => [cx + ux * a + px * w, cz + uz * a + pz * w]);
  for (const k of [0, 1, 2, 0, 2, 3]) { const q = C[k]; out.push(q[0], gh(q[0], q[1]) + lift, q[1]); }
  if (uvOut) for (const k of [0, 1, 2, 0, 2, 3]) uvOut.push(...uv[k]);
}

// spatial hash of taxiway centre segments (pavement coverage tests)
class SegGrid {
  constructor(cell = 40) { this.c = cell; this.m = new Map(); }
  key(i, j) { return i * 100003 + j; }
  add(a, b, hw, id) {
    const c = this.c, x0 = Math.floor((Math.min(a[0], b[0]) - hw) / c), x1 = Math.floor((Math.max(a[0], b[0]) + hw) / c);
    const z0 = Math.floor((Math.min(a[1], b[1]) - hw) / c), z1 = Math.floor((Math.max(a[1], b[1]) + hw) / c);
    const s = { a, b, hw, id };
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) { const k = this.key(i, j); let l = this.m.get(k); if (!l) this.m.set(k, (l = [])); l.push(s); }
  }
  near(x, z) { return this.m.get(this.key(Math.floor(x / this.c), Math.floor(z / this.c))) || []; }
}
function segDist(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1; let t = ((x - a[0]) * dx + (z - a[1]) * dz) / L2; t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
}

/** text atlas for signs: slots of 512 x 128 px; style 'hold' (red / white) or 'loc' (black / yellow) */
class SignAtlas {
  constructor() { this.slots = new Map(); this.list = []; }
  slot(style, text) { const k = style + '|' + text; if (!this.slots.has(k)) { this.slots.set(k, this.list.length); this.list.push({ style, text }); } return this.slots.get(k); }
  build() {
    const n = Math.max(1, this.list.length), W = 512, H = 128;
    const c = document.createElement('canvas'); c.width = W; c.height = H * n; const g = c.getContext('2d');
    this.list.forEach((s, i) => {
      const y = i * H, hold = s.style === 'hold';
      g.fillStyle = hold ? '#c4161c' : '#111111'; g.fillRect(0, y, W, H);
      if (!hold) { g.strokeStyle = '#f2c200'; g.lineWidth = 8; g.strokeRect(10, y + 10, W - 20, H - 20); }
      g.fillStyle = hold ? '#ffffff' : '#f2c200'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `700 92px "Barlow Condensed", "Arial Narrow", sans-serif`;
      const tw = g.measureText(s.text).width, k = Math.min(1, (W - 60) / tw);
      g.save(); g.translate(W / 2, y + H / 2 + 4); g.scale(k, 1); g.fillText(s.text, 0, 0); g.restore();
    });
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    this.tex = t; this.n = n; return t;
  }
  // uv corners (bottom-left, bottom-right, top-right, top-left) in canvas-row units; fixUV() maps them once the atlas size is known
  uv(i) { return [[0, i + 1], [1, i + 1], [1, i], [0, i]]; }
  fixUV(arr) { for (let k = 1; k < arr.length; k += 2) arr[k] = 1 - arr[k] / this.n; }
}

/**
 * Build all taxiway paint + signs for one airport.
 * paths: [{ t, pts (smoothed polyline), S (samples) }] for non-lane taxiways
 * returns { yellow: Float32 positions, black: positions, shoulder: [polylines with width], paint/sign meshes }
 */
export function buildTaxiMarkings(a, paths, gh, opts = {}) {
  const outline = opts.outline !== false, major = !!opts.major;
  const Y = [], K = [], shoulders = [];
  const grid = new SegGrid(40);
  paths.forEach((P, id) => { for (let i = 0; i + 1 < P.pts.length; i++) grid.add(P.pts[i], P.pts[i + 1], P.t.w / 2, id); });
  const aprons = a.aprons.map((ap) => { let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const q of ap.p) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); } return { p: ap.p, h: ap.h, x0, x1, z0, z1 }; });
  const onRunway = (x, z, m = 0) => a.runways.some((r) => { const L = toLocal(r, x, z); return Math.abs(L.u) < r.len / 2 + m && Math.abs(L.v) < r.wid / 2 + m; });
  const paved = (x, z, self) => {
    for (const s of grid.near(x, z)) if (s.id !== self && segDist(x, z, s.a, s.b) < s.hw - 0.3) return true;
    for (const ap of aprons) if (x > ap.x0 && x < ap.x1 && z > ap.z0 && z < ap.z1 && pointInPoly(x, z, ap.p) && !(ap.h || []).some((h) => h.length > 2 && pointInPoly(x, z, h))) return true;
    return onRunway(x, z, 3);
  };

  const atlas = new SignAtlas();
  const paint = [], paintUV = [], faces = [], faceUV = [], posts = [];

  paths.forEach((P, id) => {
    const { t, S } = P; const w = t.w, hw = w / 2;
    const cw = major || w >= 15 ? 0.3 : 0.2;
    // ---- centerline (lead-on/off lines only inside runways) ----
    let run = [];
    const flush = () => { if (run.length >= 2) { strip(run, cw, 0.125, gh, Y); if (outline) strip(run, cw + 0.3, 0.118, gh, K); } run = []; };
    for (const q of S) {
      let ok = true;
      for (const r of a.runways) {
        const L = toLocal(r, q.x, q.z); if (Math.abs(L.u) > r.len / 2 || Math.abs(L.v) > r.wid / 2 - 0.5) continue;
        const c = Math.abs(q.tx * r.dir[0] + q.tz * r.dir[1]); if (c < 0.9) ok = false; // crossing: runway markings take precedence
      }
      if (ok) run.push([q.x, q.z]); else flush();
    }
    flush();
    // ---- edge lines where the pavement meets unpaved ground ----
    if (w >= 8) for (const sd of [-1, 1]) {
      const flags = S.map((q) => !paved(q.x + q.nx * sd * (hw + 1.5), q.z + q.nz * sd * (hw + 1.5), id) && !paved(q.x + q.nx * sd * (hw - 0.5), q.z + q.nz * sd * (hw - 0.5), id) && !onRunway(q.x, q.z, 8));
      let i = 0;
      while (i < S.length) {
        if (!flags[i]) { i++; continue; }
        let j = i; while (j + 1 < S.length && flags[j + 1]) j++;
        if (j - i >= 4) {
          const seg = S.slice(i + 1, j);
          const off = (o) => seg.map((q) => [q.x + q.nx * sd * o, q.z + q.nz * sd * o]);
          strip(off(hw - 0.075), 0.15, 0.125, gh, Y); strip(off(hw - 0.375), 0.15, 0.125, gh, Y);
          if (outline) strip(off(hw - 0.225), 0.75, 0.118, gh, K);
          if (major && w >= 18) shoulders.push({ pts: off(hw + 3.75), w: 7.5 });
          else if (w >= 14) shoulders.push({ pts: off(hw + 1.5), w: 3 });
        }
        i = j + 1;
      }
    }
    // ---- runway holding positions ----
    for (const r of a.runways) {
      const hd = r.wid / 2 + (r.len > 2400 ? 60 : r.wid >= 30 ? 45 : 25);
      for (let k = 0; k + 1 < S.length; k++) {
        const A = toLocal(r, S[k].x, S[k].z), B = toLocal(r, S[k + 1].x, S[k + 1].z);
        for (const sd of [-1, 1]) {
          const fa = A.v * sd - hd, fb = B.v * sd - hd; if (fa * fb >= 0) continue;
          const s = fa / (fa - fb); const u = A.u + (B.u - A.u) * s; if (Math.abs(u) > r.len / 2) continue;
          const x = S[k].x + (S[k + 1].x - S[k].x) * s, z = S[k].z + (S[k + 1].z - S[k].z) * s;
          // holding side: away from the runway along the taxiway
          const dirOut = fa < 0 ? 1 : -1; // +1: increasing sample index leads away from the runway
          let dx = (S[k + 1].x - S[k].x) * dirOut, dz = (S[k + 1].z - S[k].z) * dirOut; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L; // pointing to the holding side
          const px = -dz, pz = dx; // left of a pilot facing the runway is -p... (facing = -d): left = (dz, -dx) = -p
          // Pattern A (12 in lines, 12 in apart): solid pair on the holding side, dashed pair toward the runway
          const across = hw + 0.2;
          if (outline) quad(x + dx * 0.15, z + dz * 0.15, dx, dz, 1.35, across + 0.15, 0.119, gh, K);
          quad(x + dx * 1.35, z + dz * 1.35, dx, dz, 0.15, across, 0.126, gh, Y);
          quad(x + dx * 0.75, z + dz * 0.75, dx, dz, 0.15, across, 0.126, gh, Y);
          for (let o = -across; o < across - 0.2; o += 1.8) {
            const m = Math.min(0.45, (across - o) / 2), c = o + m;
            quad(x + dx * 0.15 + px * c, z + dz * 0.15 + pz * c, dx, dz, 0.15, m, 0.126, gh, Y);
            quad(x - dx * 0.45 + px * c, z - dz * 0.45 + pz * c, dx, dz, 0.15, m, 0.126, gh, Y);
          }
          // walk the centerline away from the runway: enhanced centerline dashes + painted hold sign
          const path = [{ x, z }]; let acc = 0;
          for (let m = dirOut > 0 ? k + 1 : k; m >= 0 && m < S.length && acc < 60; m += dirOut) { const q = S[m]; const l = path[path.length - 1]; acc += Math.hypot(q.x - l.x, q.z - l.z); path.push({ x: q.x, z: q.z, d: acc }); }
          path[0].d = 0;
          const at = (d) => { for (let m = 1; m < path.length; m++) if (path[m].d >= d) { const p0 = path[m - 1], p1 = path[m], f = (d - p0.d) / Math.max(1e-6, p1.d - p0.d); const tx = p1.x - p0.x, tz = p1.z - p0.z, l = Math.hypot(tx, tz) || 1; return { x: p0.x + tx * f, z: p0.z + tz * f, tx: tx / l, tz: tz / l }; } return null; };
          const seg = (d0, d1, o) => { const pts = []; for (let d = d0; d <= d1 + 1e-6; d += Math.max(0.5, (d1 - d0) / 4)) { const q = at(Math.min(d, d1)); if (!q) break; pts.push([q.x - q.tz * o, q.z + q.tx * o]); } return pts; };
          const eo = cw / 2 + 0.15 + 0.075;
          let d = 1.5 + 0.25;
          for (let n = 0; n < 13; n++) {
            const len = n < 12 ? 9 * FT : 6 * FT, d1 = d + len; if (!at(d1)) break;
            for (const o of [-eo, eo]) { const pts = seg(d, d1, o); strip(pts, 0.15, 0.126, gh, Y); if (outline) strip(pts, 0.3, 0.119, gh, K); }
            d = d1 + 3 * FT;
          }
          // runway designations as seen by a pilot facing the runway: threshold to the left first
          const lex = r.x - r.dir[0] * r.len / 2, lez = r.z - r.dir[1] * r.len / 2;
          const leftIsLE = ((lex - x) * px + (lez - z) * pz) > 0; // +p is the pilot's left
          const label = leftIsLE ? `${r.rwy[0]}-${r.rwy[1]}` : `${r.rwy[1]}-${r.rwy[0]}`;
          const slotH = atlas.slot('hold', label);
          // surface painted holding position sign: 2-4 ft before the hold line, 3 ft left of centerline, 12 ft inscription
          const q0 = at(1.5 + 0.9 + 1.85);
          if (q0) {
            const across1 = Math.min(label.length * 1.05 + 0.6, hw - 1.4);
            if (across1 > 2.5) {
              const sides = w > 35 * FT ? [1, -1] : [0];
              for (const sg of sides) {
                const off = sg === 0 ? 0 : sg * (1 + across1 / 2); // +p = pilot's left
                const cx = q0.x + px * off, cz = q0.z + pz * off;
                // text top toward the runway: along = -d (toward runway)
                const uv = atlas.uv(slotH);
                // corners order in quad(): [-ha,-hw],[ha,-hw],[ha,hw],[-ha,hw] with along u=(-dx,-dz), across p'=(dz,-dx) = pilot's right
                quad(cx, cz, -dx, -dz, 1.85, across1 / 2, 0.127, gh, paint, paintUV, [uv[0], uv[3], uv[2], uv[1]]); // corners: near-left, far-left, far-right, near-right as seen by the pilot
              }
            }
          }
          // elevated signs on the pilot's left at the hold line: runway holding position + taxiway location
          const ref = (t.ref || '').toUpperCase().slice(0, 4);
          const signs = [['hold', label]]; if (ref) signs.push(['loc', ref]);
          let lat = hw + 4;
          for (const [style, txt] of signs) {
            const sw = Math.max(1.2, txt.length * 0.42 + 0.5), sh = 0.76, y0 = 0.3;
            const cx = x + dx * 0.5 + px * (lat + sw / 2), cz = z + dz * 0.5 + pz * (lat + sw / 2);
            if (onRunway(cx, cz, 15)) break;
            const g = gh(cx, cz);
            // face toward the pilot (normal = +d), pilot's left = +p, so the face's left edge is at +p
            const L0 = [cx + px * sw / 2, cz + pz * sw / 2], R0 = [cx - px * sw / 2, cz - pz * sw / 2], fo = 0.13;
            const uv = atlas.uv(atlas.slot(style, txt));
            const v = [[R0[0] + dx * fo, g + y0, R0[1] + dz * fo], [L0[0] + dx * fo, g + y0, L0[1] + dz * fo], [L0[0] + dx * fo, g + y0 + sh, L0[1] + dz * fo], [R0[0] + dx * fo, g + y0 + sh, R0[1] + dz * fo]];
            // corner order: BL(left) BR(right) TR TL as seen by the pilot: left is L0
            const ord = [[v[1], uv[0]], [v[0], uv[1]], [v[3], uv[2]], [v[1], uv[0]], [v[3], uv[2]], [v[2], uv[3]]];
            for (const [p, t2] of ord) { faces.push(...p); faceUV.push(...t2); }
            posts.push({ x: cx, z: cz, y: g, w: sw, h: sh, y0, hdg: Math.atan2(dx, dz) });
            lat += sw + 0.3;
          }
        }
      }
    }
  });

  return { yellow: Y, black: K, shoulders, atlas, paint, paintUV, faces, faceUV, posts };
}

/** sign bodies (frames + legs) as one merged geometry */
export function signBodies(posts) {
  const geos = [];
  for (const p of posts) {
    const box = new THREE.BoxGeometry(p.w + 0.08, p.h + 0.08, 0.22); box.translate(0, p.y0 + p.h / 2, 0);
    const m = new THREE.Matrix4().makeRotationY(p.hdg).setPosition(p.x, p.y, p.z); box.applyMatrix4(m); geos.push(box.toNonIndexed());
    for (const s of [-1, 1]) { const leg = new THREE.BoxGeometry(0.06, p.y0, 0.06); leg.translate(s * (p.w / 2 - 0.15), p.y0 / 2, 0); leg.applyMatrix4(m); geos.push(leg.toNonIndexed()); }
  }
  for (const g of geos) { g.deleteAttribute('uv'); }
  return geos;
}
