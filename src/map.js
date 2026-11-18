// Moving map: shaded relief + hypsometric tints, airports, navaids, ILS feathers, track, range rings.
import { heightAt, AIRPORTS, NAVAIDS, WATER_LEVEL, WORLD_HALF, TOWN, TOWNS, ROADS, forestAt, fromLocal } from './geo.js';
import { ILS } from './avionics.js';

const RES = 512; // relief raster
const EXT = 26000; // map shows +-EXT m

export class MovingMap {
  constructor() {
    this.relief = document.createElement('canvas'); this.relief.width = this.relief.height = RES;
    this.rg = this.relief.getContext('2d');
    this.img = this.rg.createImageData(RES, RES);
    this.row = 0; this.done = false;
    this.H = new Float32Array(RES * RES);
    this.track = [];
    this.zoom = 1; // px per... set in draw
    this.center = null; // null = follow aircraft
    this.northUp = true;
  }
  // incremental relief generation (rows per call)
  build(ms = 4) {
    if (this.done) return true;
    const t0 = performance.now();
    while (this.row < RES && performance.now() - t0 < ms) {
      const j = this.row;
      for (let i = 0; i < RES; i++) {
        const x = -EXT + (i + 0.5) / RES * EXT * 2, z = -EXT + (j + 0.5) / RES * EXT * 2;
        this.H[j * RES + i] = heightAt(x, z);
      }
      if (j > 0) this.shadeRow(j - 1);
      this.row++;
    }
    if (this.row >= RES) { this.shadeRow(RES - 1); this.rg.putImageData(this.img, 0, 0); this.done = true; }
    else if (this.row % 32 === 0) this.rg.putImageData(this.img, 0, 0);
    return this.done;
  }
  shadeRow(j) {
    const d = this.img.data, H = this.H, cell = EXT * 2 / RES;
    for (let i = 0; i < RES; i++) {
      const h = H[j * RES + i];
      const hx = H[j * RES + Math.min(RES - 1, i + 1)] - H[j * RES + Math.max(0, i - 1)];
      const hz = H[Math.min(RES - 1, j + 1) * RES + i] - H[Math.max(0, j - 1) * RES + i];
      // light from NW
      const nx = -hx / (2 * cell), nz = -hz / (2 * cell); const l = Math.hypot(nx, 1, nz);
      const shade = Math.max(0, (nx * -0.6 + 1 * 0.65 + nz * -0.45) / l);
      let r, g, b;
      if (h < WATER_LEVEL) { r = 150; g = 190; b = 222; }
      else {
        const t = (h - 200) / 1900;
        // sectional-chart-like hypsometric tints
        const stops = [[0, [196, 214, 170]], [0.12, [214, 222, 172]], [0.25, [232, 226, 178]], [0.4, [226, 204, 160]], [0.6, [208, 176, 138]], [0.8, [186, 150, 120]], [1, [244, 244, 246]]];
        let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
        const [t0, c0] = stops[k], [t1, c1] = stops[k + 1]; const f = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
        r = c0[0] + (c1[0] - c0[0]) * f; g = c0[1] + (c1[1] - c0[1]) * f; b = c0[2] + (c1[2] - c0[2]) * f;
        const s = 0.55 + shade * 0.55; r *= s; g *= s; b *= s;
        // forest tint
        if ((i + j) % 1 === 0) { const x = -EXT + (i + 0.5) / RES * EXT * 2, z = -EXT + (j + 0.5) / RES * EXT * 2; const fo = forestAt(x, z, h, 1 - 1 / l); r -= fo * 30; g -= fo * 10; b -= fo * 30; }
        // contour lines every 500 ft
        const ft = h / 0.3048; const c = ft % 500; if (c < 28) { r *= 0.82; g *= 0.8; b *= 0.78; }
      }
      const o = (j * RES + i) * 4; d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }

  addTrack(pos) {
    const last = this.track[this.track.length - 1];
    if (!last || Math.hypot(pos[0] - last[0], pos[2] - last[1]) > 60) { this.track.push([pos[0], pos[2]]); if (this.track.length > 4000) this.track.shift(); }
  }

  // draw on a 2d context; scale = meters per pixel
  draw(g, w, h, sim, { mpp = 40, center = null, mini = false, heading = 0 } = {}) {
    const f = sim.fdm;
    const cx = center ? center[0] : f.pos[0], cz = center ? center[1] : f.pos[2];
    const toS = (x, z) => [w / 2 + (x - cx) / mpp, h / 2 + (z - cz) / mpp];
    g.save();
    g.fillStyle = '#9ebfdc'; g.fillRect(0, 0, w, h);
    if (mini && !this.northUp) { g.translate(w / 2, h / 2); g.rotate(-heading * Math.PI / 180); g.translate(-w / 2, -h / 2); }
    // relief
    const [rx, ry] = toS(-EXT, -EXT); const rs = EXT * 2 / mpp;
    g.imageSmoothingEnabled = true; g.drawImage(this.relief, rx, ry, rs, rs);
    // town
    for (const T of TOWNS) { const [tx, ty] = toS(T.x, T.z); g.fillStyle = 'rgba(240,206,92,0.55)'; g.beginPath(); g.arc(tx, ty, T.r * 0.85 / mpp, 0, Math.PI * 2); g.fill(); }
    // roads
    const drawRoads = (kind, wOut, wIn, cOut, cIn) => { for (const r of ROADS) { if (r.kind !== kind) continue; const L = r.line; const st = Math.max(1, Math.round(mpp / 8));
      const path = () => { g.beginPath(); for (let i = 0; i < L.length; i += st) { const [x, y] = toS(L[i][0], L[i][1]); i ? g.lineTo(x, y) : g.moveTo(x, y); } const e = L[L.length - 1]; const [x, y] = toS(e[0], e[1]); g.lineTo(x, y); };
      g.lineJoin = 'round'; g.lineCap = 'round'; if (wOut) { path(); g.strokeStyle = cOut; g.lineWidth = wOut; g.stroke(); } path(); g.strokeStyle = cIn; g.lineWidth = wIn; g.stroke(); } };
    const zs = mini ? 0.7 : 1;
    drawRoads('rural', 0, 1.2 * zs, '', 'rgba(110,100,90,0.8)');
    drawRoads('road', 3 * zs, 1.8 * zs, 'rgba(90,70,40,0.6)', '#f6efd8');
    drawRoads('hwy', 4.5 * zs, 3 * zs, 'rgba(80,40,10,0.8)', '#f0a040');
    if (!mini) { for (const T of TOWNS) { const [tx, ty] = toS(T.x, T.z); lab(g, T.name, tx, ty + T.r / mpp * 0.2, 12, '#5b4a12'); }
      const [wx, wy] = toS(-12000, 15500); lab(g, 'WIND FARM', wx, wy, 10, '#3b4a5a'); }
    // ILS feathers
    for (const i of ILS) {
      const c = i.course * Math.PI / 180; const L = 18520;
      const [ax, ay] = toS(i.thr.x, i.thr.z);
      const bx = i.thr.x - Math.sin(c) * L, bz = i.thr.z + Math.cos(c) * L;
      const off = Math.tan(2.5 * Math.PI / 180) * L;
      const [b1x, b1y] = toS(bx + Math.cos(c) * off, bz + Math.sin(c) * off), [b2x, b2y] = toS(bx - Math.cos(c) * off, bz - Math.sin(c) * off);
      const [mx, my] = toS(bx, bz);
      g.fillStyle = 'rgba(160,40,120,0.16)'; g.beginPath(); g.moveTo(ax, ay); g.lineTo(b1x, b1y); g.lineTo(b2x, b2y); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(140,30,110,0.85)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(ax, ay); g.lineTo(mx, my); g.stroke();
      if (!mini) lab(g, `${i.ident} ${i.freq.toFixed(2)}  CRS ${String(Math.round(i.course)).padStart(3, '0')}°`, (ax + mx) / 2 + 10, (ay + my) / 2 - 12, 11, '#7a1a62');
    }
    // VOR compass roses
    for (const n of NAVAIDS) {
      const [x, y] = toS(n.x, n.z);
      if (n.type === 'VOR') {
        const R = mini ? 40 : 90;
        g.strokeStyle = 'rgba(30,80,150,0.9)'; g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.stroke();
        for (let d = 0; d < 360; d += 10) { const a = d * Math.PI / 180, l = d % 30 === 0 ? 10 : 5; g.beginPath(); g.moveTo(x + Math.sin(a) * R, y - Math.cos(a) * R); g.lineTo(x + Math.sin(a) * (R - l), y - Math.cos(a) * (R - l)); g.stroke(); }
        g.fillStyle = '#1e5096'; hexagon(g, x, y, 7);
        if (!mini) { box(g, `${n.name.toUpperCase()}  ${n.freq.toFixed(1)}  ${n.ident}`, x + 12, y - R - 10, '#1e5096'); }
      } else {
        g.fillStyle = 'rgba(130,30,110,0.9)'; for (let r = 4; r < 14; r += 3) { g.beginPath(); for (let a = 0; a < 6.28; a += 0.6) g.rect(x + Math.cos(a) * r - 0.8, y + Math.sin(a) * r - 0.8, 1.6, 1.6); g.fill(); }
        if (!mini) box(g, `${n.name.toUpperCase()}  ${Math.round(n.freq * 1000)}  ${n.ident}`, x + 14, y + 14, '#7a1a62');
      }
    }
    // airports
    for (const a of AIRPORTS) {
      const [x, y] = toS(a.x, a.z);
      const tow = a.tower; const col = tow ? '#1e5096' : '#7a1a62';
      g.strokeStyle = col; g.lineWidth = 3;
      const R = Math.max(10, a.len / 2 / mpp + 6);
      g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.stroke();
      const e1 = fromLocal(a, -a.len / 2, 0), e2 = fromLocal(a, a.len / 2, 0);
      const [x1, y1] = toS(e1.x, e1.z), [x2, y2] = toS(e2.x, e2.z);
      g.lineWidth = Math.max(3, a.wid / mpp); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      if (!mini) {
        box(g, `${a.name.toUpperCase()} (${a.icao})`, x + R + 6, y - 8, col);
        lab(g, `${tow ? 'CT 118.3  ' : 'CTAF 122.8  '}${Math.round(a.elev / 0.3048)}  L ${Math.round(a.len / 0.3048 / 100)}  ${a.ils ? 'ILS ' + a.ils.freq.toFixed(2) : ''}`, x + R + 6, y + 10, 11, col, 'left');
        lab(g, `RWY ${a.rwy[0]}/${a.rwy[1]}`, x + R + 6, y + 24, 11, col, 'left');
      }
    }
    // track
    if (this.track.length > 1) {
      g.strokeStyle = 'rgba(200,30,160,0.85)'; g.lineWidth = 2; g.setLineDash([6, 4]); g.beginPath();
      this.track.forEach((p, i) => { const [x, y] = toS(p[0], p[1]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      const [x, y] = toS(f.pos[0], f.pos[2]); g.lineTo(x, y); g.stroke(); g.setLineDash([]);
    }
    // range rings around aircraft
    const [ax, ay] = toS(f.pos[0], f.pos[2]);
    if (!mini) {
      g.strokeStyle = 'rgba(20,20,20,0.35)'; g.lineWidth = 1;
      for (const nm of [5, 10, 20]) { const r = nm * 1852 / mpp; g.beginPath(); g.arc(ax, ay, r, 0, Math.PI * 2); g.stroke(); lab(g, nm + ' NM', ax + r * 0.707 + 4, ay - r * 0.707, 10, '#333', 'left'); }
    }
    // aircraft symbol
    const hd = f.attitude.hdg * Math.PI / 180;
    // velocity vector (1 min)
    g.strokeStyle = '#111'; g.lineWidth = 2; g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + f.vel[0] * 60 / mpp, ay + f.vel[2] * 60 / mpp); g.stroke();
    g.save(); g.translate(ax, ay); g.rotate(hd);
    g.fillStyle = '#ffffff'; g.strokeStyle = '#111'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -13); g.lineTo(2.5, -4); g.lineTo(12, 0); g.lineTo(12, 3); g.lineTo(2.5, 2); g.lineTo(1.5, 9); g.lineTo(5, 12); g.lineTo(-5, 12); g.lineTo(-1.5, 9); g.lineTo(-2.5, 2); g.lineTo(-12, 3); g.lineTo(-12, 0); g.lineTo(-2.5, -4); g.closePath();
    g.fill(); g.stroke(); g.restore();
    g.restore();
    // scale bar (fixed)
    if (!mini) {
      const nmPx = 1852 / mpp; const n = nmPx > 120 ? 1 : nmPx > 30 ? 5 : 10;
      g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(16, h - 38, n * nmPx + 20, 26);
      g.fillStyle = '#111'; g.fillRect(26, h - 22, n * nmPx, 4); lab(g, n + ' NM', 26 + n * nmPx / 2, h - 30, 11, '#111');
    }
  }
}
function lab(g, t, x, y, s = 11, c = '#222', align = 'center') { g.font = `600 ${s}px Barlow, Arial, sans-serif`; g.textAlign = align; g.textBaseline = 'middle'; g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.75)'; g.strokeText(t, x, y); g.fillStyle = c; g.fillText(t, x, y); }
function box(g, t, x, y, c) { g.font = '700 12px Barlow, Arial, sans-serif'; const w = g.measureText(t).width + 10; g.fillStyle = 'rgba(255,255,255,0.88)'; g.fillRect(x, y - 9, w, 18); g.strokeStyle = c; g.lineWidth = 1.2; g.strokeRect(x, y - 9, w, 18); g.fillStyle = c; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(t, x + 5, y); }
function hexagon(g, x, y, r) { g.beginPath(); for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } g.closePath(); g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 2, 0, 7); g.fill(); }
export { EXT, WORLD_HALF };
