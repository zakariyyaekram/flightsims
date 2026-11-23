// Moving map: a simple flat road-map style chart (not satellite). Land / water / parks / urban areas
// are painted from the baked land-cover raster, roads and runways are drawn as vectors on top,
// with airports, navaids, ILS feathers, place labels, your aircraft and live AI traffic.
import { AIRPORTS, NAVAIDS, WORLD, RASTER, ROADS, TOWNS, WATER_NAMES, PLACES, TALL, WORLD_HALF } from './geo.js';
import { ILS } from './avionics.js?v=20261123d';

const FT = 0.3048;
const EXT = Math.max(WORLD.x1 - WORLD.x0, WORLD.z1 - WORLD.z0) / 2;
const COL = {
  water: [170, 211, 230], land: [244, 241, 234], urban: [229, 226, 222], park: [205, 228, 190], crop: [238, 240, 214],
  hwy: '#f4a640', hwyCase: '#c77a1e', road: '#ffffff', roadCase: '#b9b3a8', link: '#f7c97a',
  apron: '#d9d7e2', runway: '#5f6066', taxi: '#c3c1cc',
};
const TILE = 8000;

export class MovingMap {
  constructor() {
    const { nx, nz } = WORLD;
    this.base = document.createElement('canvas'); this.base.width = nx; this.base.height = nz;
    this.bg = this.base.getContext('2d');
    this.img = this.bg.createImageData(nx, nz);
    this.row = 0; this.done = false;
    this.track = [];
    this.center = null;
    this.northUp = true;
    this.traffic = null; // set by main: () => list of {callsign,x,z,y,hdg,gs,type}
    // road vectors binned in tiles (world units) for fast culling
    this.tiles = new Map();
    for (const r of ROADS) {
      const n = r.pts.length / 2; const cls = r.cls; if (n < 2) continue;
      const tx = Math.floor(r.pts[0] / TILE), tz = Math.floor(r.pts[1] / TILE);
      const key = tx + ',' + tz; let t = this.tiles.get(key);
      if (!t) this.tiles.set(key, (t = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity, hwy: new Path2D(), road: new Path2D(), link: new Path2D(), hwyLo: new Path2D(), roadLo: new Path2D(), nroad: 0 }));
      const p = t[cls] || t.road, lo = cls === 'hwy' ? t.hwyLo : cls === 'road' ? t.roadLo : null;
      p.moveTo(r.pts[0], r.pts[1]); if (lo) lo.moveTo(r.pts[0], r.pts[1]);
      let lx = r.pts[0], lz = r.pts[1];
      for (let i = 1; i < n; i++) {
        const x = r.pts[i * 2], z = r.pts[i * 2 + 1]; p.lineTo(x, z);
        if (lo && (i === n - 1 || Math.hypot(x - lx, z - lz) > 250)) { lo.lineTo(x, z); lx = x; lz = z; }
        if (x < t.x0) t.x0 = x; if (x > t.x1) t.x1 = x; if (z < t.z0) t.z0 = z; if (z > t.z1) t.z1 = z;
      }
      if (r.pts[0] < t.x0) t.x0 = r.pts[0]; if (r.pts[1] < t.z0) t.z0 = r.pts[1];
    }
    // airports: apron / taxiway / runway vectors in world units
    this.apts = AIRPORTS.map((a) => {
      const apron = new Path2D(); for (const ap of a.aprons) { ap.p.forEach((q, i) => (i ? apron.lineTo(q[0], q[1]) : apron.moveTo(q[0], q[1]))); apron.closePath(); }
      const taxi = new Path2D(); for (const t of a.taxiways) { t.p.forEach((q, i) => (i ? taxi.lineTo(q[0], q[1]) : taxi.moveTo(q[0], q[1]))); }
      const bld = new Path2D(); for (const b of a.buildings) { b.p.forEach((q, i) => (i ? bld.lineTo(q[0], q[1]) : bld.moveTo(q[0], q[1]))); bld.closePath(); }
      return { a, apron, taxi, bld };
    });
    this.tall = new Path2D(); for (const t of TALL) { t.p.forEach((q, i) => (i ? this.tall.lineTo(q[0], q[1]) : this.tall.moveTo(q[0], q[1]))); this.tall.closePath(); }
  }
  // incremental base-map generation (rows per call)
  build(ms = 4) {
    if (this.done) return true;
    const { nx, nz, cell } = WORLD; const { H, WF, TREE, BUILT, CROP } = RASTER; const d = this.img.data;
    const t0 = performance.now();
    while (this.row < nz && performance.now() - t0 < ms) {
      const j = this.row;
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i; const w = WF[k] / 255;
        let c;
        const hx = H[j * nx + Math.min(nx - 1, i + 1)] - H[j * nx + Math.max(0, i - 1)];
        const hz = H[Math.min(nz - 1, j + 1) * nx + i] - H[Math.max(0, j - 1) * nx + i];
        // very soft hillshade (light from NW) so hills read without looking like imagery
        const sh = Math.max(-1, Math.min(1, (hx * 0.7 + hz * 0.7) / (2 * cell) * 1.4));
        const s = 1 + sh * 0.08;
        const b = BUILT[k] / 255, tr = TREE[k] / 255, cr = CROP[k] / 255;
        let r = COL.land[0], g = COL.land[1], bl = COL.land[2];
        const mix = (C, f) => { r += (C[0] - r) * f; g += (C[1] - g) * f; bl += (C[2] - bl) * f; };
        mix(COL.crop, Math.min(1, cr * 1.2)); mix(COL.park, Math.min(1, tr * 1.3)); mix(COL.urban, Math.min(1, b * 1.4));
        r *= s; g *= s; bl *= s;
        c = [r, g, bl];
        if (w > 0) { const f = Math.min(1, w * 1.15); c = [c[0] + (COL.water[0] - c[0]) * f, c[1] + (COL.water[1] - c[1]) * f, c[2] + (COL.water[2] - c[2]) * f]; }
        const o = k * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
      this.row++;
    }
    if (this.row >= nz) { this.bg.putImageData(this.img, 0, 0); this.done = true; }
    else if (this.row % 200 === 0) this.bg.putImageData(this.img, 0, 0);
    return this.done;
  }

  addTrack(pos) {
    const last = this.track[this.track.length - 1];
    if (!last || Math.hypot(pos[0] - last[0], pos[2] - last[1]) > 60) { this.track.push([pos[0], pos[2]]); if (this.track.length > 4000) this.track.shift(); }
  }

  // draw on a 2d context; mpp = meters per pixel
  draw(g, w, h, sim, { mpp = 40, center = null, mini = false, heading = 0 } = {}) {
    const f = sim.fdm;
    const cx = center ? center[0] : f.pos[0], cz = center ? center[1] : f.pos[2];
    const rot = mini && !this.northUp ? -heading * Math.PI / 180 : 0;
    const toS = (x, z) => { const dx = (x - cx) / mpp, dz = (z - cz) / mpp; return rot ? [w / 2 + dx * Math.cos(rot) - dz * Math.sin(rot), h / 2 + dx * Math.sin(rot) + dz * Math.cos(rot)] : [w / 2 + dx, h / 2 + dz]; };
    const R = Math.hypot(w, h) / 2 * mpp; // visible radius (m)
    const vis = (x0, z0, x1, z1) => x1 > cx - R && x0 < cx + R && z1 > cz - R && z0 < cz + R;
    g.save();
    g.fillStyle = `rgb(${COL.water})`; g.fillRect(0, 0, w, h);
    // world-space transform
    const world = () => { g.save(); g.translate(w / 2, h / 2); if (rot) g.rotate(rot); g.scale(1 / mpp, 1 / mpp); g.translate(-cx, -cz); };
    world();
    g.imageSmoothingEnabled = true; g.drawImage(this.base, WORLD.x0 - WORLD.cell / 2, WORLD.z0 - WORLD.cell / 2, WORLD.nx * WORLD.cell, WORLD.nz * WORLD.cell);
    g.lineJoin = 'round'; g.lineCap = 'round';
    // tall buildings (downtown SF / Oakland / San Jose) when zoomed in
    if (mpp < 12) { g.fillStyle = '#d2cdc6'; g.strokeStyle = '#bdb6ad'; g.lineWidth = mpp; g.fill(this.tall); g.stroke(this.tall); }
    // airports: aprons & taxiways under the roads
    for (const A of this.apts) {
      const a = A.a; if (!vis(a.arp[0] - a.radius, a.arp[1] - a.radius, a.arp[0] + a.radius, a.arp[1] + a.radius)) continue;
      g.fillStyle = COL.apron; g.fill(A.apron);
      if (mpp < 25) { g.strokeStyle = COL.taxi; g.lineWidth = Math.max(18, mpp * 1.2); g.stroke(A.taxi); }
      if (mpp < 10) { g.fillStyle = '#c9c4cf'; g.strokeStyle = '#a9a3b0'; g.lineWidth = mpp * 0.8; g.fill(A.bld); g.stroke(A.bld); }
    }
    // roads
    const tiles = []; for (const t of this.tiles.values()) if (vis(t.x0, t.z0, t.x1, t.z1)) tiles.push(t);
    const showRoads = mpp < 70, lo = mpp > 25;
    const zs = mini ? 0.8 : 1;
    if (showRoads) {
      if (mpp < 30) { g.strokeStyle = COL.link; g.lineWidth = 1.6 * zs * mpp; for (const t of tiles) g.stroke(t.link); }
      g.strokeStyle = COL.roadCase; g.lineWidth = (mpp < 15 ? 4.2 : 2.6) * zs * mpp; for (const t of tiles) g.stroke(lo ? t.roadLo : t.road);
      g.strokeStyle = COL.road; g.lineWidth = (mpp < 15 ? 3 : 1.6) * zs * mpp; for (const t of tiles) g.stroke(lo ? t.roadLo : t.road);
    }
    const hw = mpp < 40 ? 4.5 : 3; g.strokeStyle = COL.hwyCase; g.lineWidth = (hw + 1.6) * zs * mpp; for (const t of tiles) g.stroke(lo ? t.hwyLo : t.hwy);
    g.strokeStyle = COL.hwy; g.lineWidth = hw * zs * mpp; for (const t of tiles) g.stroke(lo ? t.hwyLo : t.hwy);
    // runways
    for (const A of this.apts) for (const r of A.a.runways) {
      g.strokeStyle = COL.runway; g.lineCap = 'butt'; g.lineWidth = Math.max(r.wid, 3.5 * mpp);
      g.beginPath(); g.moveTo(r.le[0], r.le[1]); g.lineTo(r.he[0], r.he[1]); g.stroke();
      if (mpp < 15) { g.strokeStyle = '#fff'; g.lineWidth = Math.max(1, mpp * 0.8); g.setLineDash([30, 25]); g.beginPath(); g.moveTo(r.le[0], r.le[1]); g.lineTo(r.he[0], r.he[1]); g.stroke(); g.setLineDash([]); }
      g.lineCap = 'round';
    }
    // ILS feathers
    for (const i of ILS) {
      const c = i.course * Math.PI / 180, L = 18520, off = Math.tan(2.5 * Math.PI / 180) * L;
      const bx = i.thr.x - Math.sin(c) * L, bz = i.thr.z + Math.cos(c) * L;
      g.fillStyle = 'rgba(150,40,120,0.12)'; g.beginPath(); g.moveTo(i.thr.x, i.thr.z); g.lineTo(bx + Math.cos(c) * off, bz + Math.sin(c) * off); g.lineTo(bx - Math.cos(c) * off, bz - Math.sin(c) * off); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(140,30,110,0.75)'; g.lineWidth = 1.3 * mpp; g.beginPath(); g.moveTo(i.thr.x, i.thr.z); g.lineTo(bx, bz); g.stroke();
    }
    // taxi route (ramp -> hold short)
    const tx = sim.taxi;
    if (tx && tx.show && tx.route) {
      const P = tx.route.pts;
      g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = Math.max(9, 5.5 * mpp); g.beginPath(); P.forEach((p, i) => (i ? g.lineTo(p.x, p.z) : g.moveTo(p.x, p.z))); g.stroke();
      g.strokeStyle = '#ff2bd6'; g.lineWidth = Math.max(5, 3.2 * mpp); g.beginPath(); P.forEach((p, i) => (i ? g.lineTo(p.x, p.z) : g.moveTo(p.x, p.z))); g.stroke();
      const hp = P[P.length - 1]; g.fillStyle = '#ffd400'; g.strokeStyle = '#000'; g.lineWidth = Math.max(2, mpp); g.beginPath(); g.arc(hp.x, hp.z, Math.max(14, 6 * mpp), 0, Math.PI * 2); g.fill(); g.stroke();
    }
    // track
    if (this.track.length > 1) {
      g.strokeStyle = 'rgba(200,30,160,0.85)'; g.lineWidth = 2 * mpp; g.setLineDash([6 * mpp, 4 * mpp]); g.beginPath();
      this.track.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.lineTo(f.pos[0], f.pos[2]); g.stroke(); g.setLineDash([]);
    }
    g.restore();

    // ---------- screen-space overlay: labels, symbols
    const used = [];
    const place = (x, y, wpx, hpx) => { const b = [x - wpx / 2, y - hpx / 2, x + wpx / 2, y + hpx / 2]; for (const u of used) if (b[0] < u[2] && b[2] > u[0] && b[1] < u[3] && b[3] > u[1]) return false; used.push(b); return true; };
    const inView = (x, y, m = 40) => x > -m && y > -m && x < w + m && y < h + m;
    // own aircraft first (reserve its space)
    const [ax, ay] = toS(f.pos[0], f.pos[2]); used.push([ax - 16, ay - 16, ax + 16, ay + 16]);
    // airports
    for (const A of this.apts) {
      const a = A.a; const [x, y] = toS(a.arp[0], a.arp[1]); if (!inView(x, y, 200)) continue;
      const col = a.tower ? '#1e5096' : '#7a1a62';
      if (mpp > 30) { // chart-style symbol when zoomed out
        g.strokeStyle = col; g.lineWidth = 2.5; g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.stroke();
      }
      if (mini && mpp > 40) continue;
      const t1 = `${a.icao}${mini ? '' : '  ' + a.name.replace(/ Airport.*| International.*| Municipal.*| Executive.*| County.*| Federal.*/, '')}`;
      const lx = x + (mpp > 30 ? 14 : a.radius / mpp * 0.6 + 8), ly = y - 10;
      if (!place(lx + 70, ly + 10, 150, 34) && mini) continue;
      box(g, t1, lx, ly, col);
      if (!mini) {
        const fr = a.tower ? `CT ${a.twrFreq?.toFixed?.(2) ?? ''}` : `CTAF ${(a.freq || 122.8).toFixed?.(2) ?? a.freq}`;
        lab(g, `${fr}   ${Math.round(a.runways[0].elev / FT)} ft   ${a.runways.map((r) => r.rwy.join('/')).join('  ')}`, lx, ly + 16, 11, col, 'left');
      }
    }
    // navaids
    for (const n of NAVAIDS) {
      const [x, y] = toS(n.x, n.z); if (!inView(x, y)) continue;
      if (n.type === 'VOR') {
        const Rr = mini ? 34 : 70;
        g.strokeStyle = 'rgba(30,80,150,0.7)'; g.lineWidth = 1; g.beginPath(); g.arc(x, y, Rr, 0, Math.PI * 2); g.stroke();
        for (let d = 0; d < 360; d += 10) { const aa = d * Math.PI / 180 + rot, l = d % 30 === 0 ? 8 : 4; g.beginPath(); g.moveTo(x + Math.sin(aa) * Rr, y - Math.cos(aa) * Rr); g.lineTo(x + Math.sin(aa) * (Rr - l), y - Math.cos(aa) * (Rr - l)); g.stroke(); }
        g.fillStyle = '#1e5096'; hexagon(g, x, y, 6);
        if (!mini && place(x + 60, y - Rr - 10, 130, 18)) box(g, `${n.name.toUpperCase()} ${n.freq.toFixed(1)} ${n.ident}`, x + 10, y - Rr - 10, '#1e5096');
      } else {
        g.fillStyle = 'rgba(130,30,110,0.9)'; for (let r = 4; r < 12; r += 3) for (let aa = 0; aa < 6.28; aa += 0.6) g.fillRect(x + Math.cos(aa) * r - 0.8, y + Math.sin(aa) * r - 0.8, 1.6, 1.6);
        if (!mini && place(x + 60, y + 14, 120, 18)) box(g, `${n.name.toUpperCase()} ${Math.round(n.freq * 1000)} ${n.ident}`, x + 12, y + 14, '#7a1a62');
      }
    }
    // water bodies, landmarks, towns
    for (const W of WATER_NAMES) { const [x, y] = toS(W.x, W.z); if (inView(x, y) && place(x, y, W.name.length * 8, 18)) lab(g, W.name, x, y, mini ? 10 : 13, '#3d6f96', 'center', 'italic 600'); }
    if (!mini && mpp < 40) for (const P of PLACES) { const [x, y] = toS(P.x, P.z); if (inView(x, y) && place(x, y + 12, P.name.length * 6.5, 14)) { g.fillStyle = '#6b5a43'; g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 5, y + 4); g.lineTo(x - 5, y + 4); g.fill(); lab(g, P.name, x, y + 14, 10.5, '#6b5a43'); } }
    const towns = TOWNS.slice().sort((p, q) => q.rank - p.rank);
    for (const T of towns) {
      if (T.rank === 1 && mpp > 35) continue; if (T.rank === 2 && mpp > 90) continue; if (mini && T.rank < 2 && mpp > 20) continue;
      const [x, y] = toS(T.x, T.z); if (!inView(x, y)) continue;
      const s = T.rank === 3 ? 15 : T.rank === 2 ? 12.5 : 11;
      if (place(x, y, T.label.length * s * 0.62, s + 4)) lab(g, T.rank === 3 ? T.label.toUpperCase() : T.label, x, y, mini ? s * 0.85 : s, '#333', 'center', T.rank === 3 ? '700' : '600');
    }
    // range rings
    if (!mini) {
      g.strokeStyle = 'rgba(20,20,20,0.3)'; g.lineWidth = 1;
      for (const nm of [5, 10, 20]) { const r = nm * 1852 / mpp; g.beginPath(); g.arc(ax, ay, r, 0, Math.PI * 2); g.stroke(); lab(g, nm + ' NM', ax + r * 0.707 + 4, ay - r * 0.707, 10, '#333', 'left'); }
    }
    // other aircraft
    const list = this.traffic ? this.traffic() : [];
    const myAlt = f.pos[1];
    for (const p of list) {
      const [x, y] = toS(p.x, p.z); if (!inView(x, y)) continue;
      const rel = Math.round((p.y - myAlt) / FT / 100); const close = Math.hypot(p.x - f.pos[0], p.z - f.pos[2]) < 6 * 1852 && Math.abs(rel) < 12;
      const col = p.ga ? '#0b7a3e' : close ? '#d9480f' : '#0b5cad';
      g.save(); g.translate(x, y); g.rotate(p.hdg * Math.PI / 180 + rot);
      g.fillStyle = col; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      planeShape(g, p.ga ? 0.65 : 0.85); g.fill(); g.stroke(); g.restore();
      if (mini && mpp > 30) continue;
      const tag = `${p.ident || p.callsign}  ${rel >= 0 ? '+' : ''}${String(rel).padStart(2, '0')}`;
      if (place(x + 50, y - 12, 100, 26)) { lab(g, tag, x + 12, y - 14, 10.5, col, 'left'); if (!mini) lab(g, `${p.type}  ${Math.round(p.alt / 100) * 100} ft  ${Math.round(p.gs)} kt`, x + 12, y - 1, 9.5, col, 'left'); }
    }
    // own aircraft symbol + 1-minute velocity vector
    g.strokeStyle = '#111'; g.lineWidth = 2; g.beginPath(); g.moveTo(ax, ay);
    { const [vx, vy] = toS(f.pos[0] + f.vel[0] * 60, f.pos[2] + f.vel[2] * 60); g.lineTo(vx, vy); } g.stroke();
    g.save(); g.translate(ax, ay); g.rotate(f.attitude.hdg * Math.PI / 180 + rot);
    g.fillStyle = '#ffd400'; g.strokeStyle = '#111'; g.lineWidth = 2; planeShape(g, 1.1); g.fill(); g.stroke(); g.restore();
    g.restore();
    // scale bar + legend (fixed)
    if (!mini) {
      const nmPx = 1852 / mpp; const n = nmPx > 120 ? 1 : nmPx > 30 ? 5 : 10;
      g.fillStyle = 'rgba(255,255,255,0.88)'; g.fillRect(16, 56, n * nmPx + 20, 26);
      g.fillStyle = '#111'; g.fillRect(26, 72, n * nmPx, 4); lab(g, n + ' NM', 26 + n * nmPx / 2, 64, 11, '#111');
      legend(g, w, h);
    }
  }
}
function planeShape(g, s) {
  g.beginPath(); const P = [[0, -13], [2.5, -4], [12, 0], [12, 3], [2.5, 2], [1.5, 9], [5, 12], [-5, 12], [-1.5, 9], [-2.5, 2], [-12, 3], [-12, 0], [-2.5, -4]];
  P.forEach(([x, y], i) => (i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s))); g.closePath();
}
function legend(g, w, h) {
  const items = [['#ffd400', 'You'], ['#0b5cad', 'Airliner'], ['#0b7a3e', 'GA traffic'], ['#d9480f', 'Nearby traffic']];
  const x = w - 150, y = h - 76 - items.length * 18;
  g.fillStyle = 'rgba(255,255,255,0.88)'; g.fillRect(x - 10, y - 14, 140, items.length * 18 + 12);
  items.forEach(([c, t], i) => { g.save(); g.translate(x + 6, y + i * 18); g.fillStyle = c; g.strokeStyle = '#fff'; g.lineWidth = 1; planeShape(g, 0.5); g.fill(); g.stroke(); g.restore(); lab(g, t, x + 20, y + i * 18, 11, '#222', 'left'); });
}
function lab(g, t, x, y, s = 11, c = '#222', align = 'center', weight = '600') { g.font = `${weight} ${s}px Barlow, Arial, sans-serif`; g.textAlign = align; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.85)'; g.strokeText(t, x, y); g.fillStyle = c; g.fillText(t, x, y); }
function box(g, t, x, y, c) { g.font = '700 12px Barlow, Arial, sans-serif'; const w = g.measureText(t).width + 10; g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(x, y - 9, w, 18); g.strokeStyle = c; g.lineWidth = 1.2; g.strokeRect(x, y - 9, w, 18); g.fillStyle = c; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(t, x + 5, y); }
function hexagon(g, x, y, r) { g.beginPath(); for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } g.closePath(); g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 2, 0, 7); g.fill(); }
export { EXT, WORLD_HALF };
