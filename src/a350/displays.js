// A350 display units: six 15" LCDs (portrait outboard/inboard/centre, landscape lower centre) + ISIS.
//   CO  Capt outboard : PFD (top)  / OIS (bottom)        FO  F/O outboard : PFD / OIS
//   CI  Capt inboard  : ND  (top)  / VD  (bottom)        FI  F/O inboard  : ND  / VD
//   CU  centre        : EWD (top)  / SD  (bottom)        CL  lower centre : MFD capt | MFD F/O
// Every format registers click/wheel hot areas while drawing (KCCU-style cursor = mouse).
import { clamp, DEG } from '../math.js';
import { KT, FT, NM, A350, CONFS, speeds } from './data.js';
import { heightAt, AIRPORTS, NAVAIDS } from '../geo.js';
import { angDiff } from './fms.js';
import { drawEWD, drawSD } from './ecam.js';
import { drawMFD, drawOIS } from './mfd.js';

export const C = { g: '#27e43a', c: '#2fd6ff', m: '#ff4bf5', a: '#ffad1f', w: '#f2f2f2', r: '#ff2a2a', y: '#ffe600', gr: '#8d97a3', bg: '#050608', sky: '#1d6ad9', gnd: '#8a5a28', dk: '#101820' };
export const FONT = (px, b = false) => `${b ? 700 : 400} ${px}px "B612 Mono", "Share Tech Mono", monospace`;
export const W = 600, H = 900, TOP = 520;

export function txt(g, s, x, y, col = C.w, px = 18, al = 'left', b = false) { g.fillStyle = col; g.font = FONT(px, b); g.textAlign = al; g.textBaseline = 'middle'; g.fillText(s, x, y); }
export function box(g, x, y, w, h, col = C.w, lw = 2) { g.strokeStyle = col; g.lineWidth = lw; g.strokeRect(x, y, w, h); }
export function line(g, x1, y1, x2, y2, col = C.w, lw = 2) { g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
const pad = (n, l = 3) => String(Math.round(n)).padStart(l, '0');
const wrap360 = (a) => ((a % 360) + 360) % 360;

class DU {
  constructor(id, w, h) { this.id = id; this.w = w; this.h = h; this.canvas = document.createElement('canvas'); this.canvas.width = w; this.canvas.height = h; this.g = this.canvas.getContext('2d'); this.hot = []; this.tex = null; }
}

export class Displays {
  constructor(sim) {
    this.sim = sim;
    this.du = { CO: new DU('CO', W, H), CI: new DU('CI', W, H), CU: new DU('CU', W, H), FI: new DU('FI', W, H), FO: new DU('FO', W, H), CL: new DU('CL', 900, 600), ISIS: new DU('ISIS', 300, 300) };
    this.order = ['CO', 'CI', 'CU', 'FI', 'FO', 'CL', 'ISIS']; this.rr = 0;
    this.terr = { img: null, t: -99, key: '' }; this.vdTerr = { t: -99, prof: [] };
    this.trend = [0, 0]; this.lastIas = 0;
  }
  // -------- frame scheduler: redraw a couple of DUs per call --------
  update(t, n = 3, force = false) {
    for (let k = 0; k < (force ? this.order.length : n); k++) {
      const id = this.order[this.rr = (this.rr + 1) % this.order.length];
      this.draw(id, t); if (this.du[id].tex) this.du[id].tex.needsUpdate = true;
    }
  }
  hit(id, u, v) {
    const d = this.du[id]; if (!d) return null; const x = u * d.w, y = (1 - v) * d.h;
    for (let i = d.hot.length - 1; i >= 0; i--) { const h = d.hot[i]; if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h; }
    return null;
  }
  draw(id, t) {
    const d = this.du[id], g = d.g, S = this.sim.S; d.hot = [];
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, d.w, d.h);
    const on = id === 'ISIS' ? S.duOn('ISIS') : S.duOn(id === 'CL' ? 'CL' : id);
    const bright = this.sim.duBright?.[id] ?? 1;
    if (!on || bright <= 0.02) { d.dark = true; return; }
    d.dark = false;
    if (S.duBooting(id)) { this.boot(d, t); return; }
    const reg = (x, y, w, h, o) => d.hot.push({ x, y, w, h, ...o });
    d.reg = reg;
    const side = id === 'FO' || id === 'FI' ? 1 : 0;
    try {
      switch (id) {
        case 'CO': case 'FO': this.pfd(g, side, t, reg); g.save(); g.translate(0, TOP); this.clipRect(g, W, H - TOP); drawOIS(this, g, side, t, (x, y, w, h, o) => reg(x, y + TOP, w, h, o)); g.restore(); break;
        case 'CI': case 'FI': this.nd(g, side, t, reg); g.save(); g.translate(0, TOP); this.clipRect(g, W, H - TOP); this.vd(g, side, t); g.restore(); break;
        case 'CU': drawEWD(this, g, t, reg); g.save(); g.translate(0, TOP); this.clipRect(g, W, H - TOP); drawSD(this, g, t, (x, y, w, h, o) => reg(x, y + TOP, w, h, o)); g.restore(); break;
        case 'CL': for (let s = 0; s < 2; s++) { g.save(); g.translate(s * 450, 0); this.clipRect(g, 450, 600); drawMFD(this, g, s, t, (x, y, w, h, o) => reg(x + s * 450, y, w, h, o)); g.restore(); } line(g, 450, 0, 450, 600, '#333', 3); break;
        case 'ISIS': this.isis(g, t); break;
      }
    } catch (e) { g.setTransform(1, 0, 0, 1, 0, 0); txt(g, 'DU FAULT', 20, 30, C.a, 18); console.warn(id, e); }
    if (bright < 1) { g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = `rgba(0,0,0,${1 - bright})`; g.fillRect(0, 0, d.w, d.h); }
    if (id !== 'CL' && id !== 'ISIS') { line(g, 0, TOP, W, TOP, '#222', 2); }
  }
  clipRect(g, w, h) { g.beginPath(); g.rect(0, 0, w, h); g.clip(); }
  boot(d, t) {
    const g = d.g; const k = this.sim.S.du[d.id === 'CL' ? 'CL' : d.id]?.t ?? 0;
    txt(g, 'AIRBUS', d.w / 2, d.h / 2 - 30, C.w, 30, 'center', true); txt(g, 'SELF TEST IN PROGRESS', d.w / 2, d.h / 2 + 10, C.g, 16, 'center');
    txt(g, `(MAX ${Math.max(0, Math.ceil(8 - k))} SECONDS)`, d.w / 2, d.h / 2 + 36, C.g, 14, 'center');
  }
  get efisAll() { return this.sim.efis; }

  // ===================== PFD =====================
  pfd(g, side, t, reg) {
    const sim = this.sim, f = sim.fdm, S = sim.S, afs = sim.afs, fms = sim.fms, ef = sim.efis[side];
    const att = f.attitude; const ias = f.ind.ias;
    const attOk = S.attValid(), adrOk = S.adrValid(), hdgOk = S.hdgValid();
    const cx = 290, cy = 270;
    // ---- attitude
    g.save(); g.beginPath(); g.rect(cx - 140, cy - 150, 280, 300); g.clip();
    if (attOk) {
      g.translate(cx, cy); g.rotate(-att.roll * DEG); const pp = 7.2; g.translate(0, att.pitch * pp);
      g.fillStyle = C.sky; g.fillRect(-400, -900, 800, 900); g.fillStyle = C.gnd; g.fillRect(-400, 0, 800, 900);
      line(g, -400, 0, 400, 0, C.w, 2);
      for (let p = -30; p <= 30; p += 2.5) {
        if (p === 0) continue; const y = -p * pp; const big = p % 10 === 0, mid = p % 5 === 0;
        if (Math.abs(p - att.pitch) > 22) continue;
        const w = big ? 50 : mid ? 28 : 12; line(g, -w, y, w, y, C.w, 2);
        if (big) { txt(g, String(Math.abs(p)), -w - 18, y, C.w, 14, 'center'); txt(g, String(Math.abs(p)), w + 18, y, C.w, 14, 'center'); }
      }
      // heading marks on horizon
      for (let h = 0; h < 360; h += 10) { const d = angDiff(h, att.hdg); if (Math.abs(d) > 30) continue; line(g, d * 7.2, 0, d * 7.2, 6, C.w, 1.5); }
      g.restore(); g.save();
      // bank scale
      g.translate(cx, cy);
      g.strokeStyle = C.w; g.lineWidth = 2;
      for (const b of [-45, -30, -20, -10, 0, 10, 20, 30, 45]) { const r = 128, a = (b - 90) * DEG, l = b % 30 === 0 || b === 0 ? 14 : 8; line(g, Math.cos(a) * r, Math.sin(a) * r, Math.cos(a) * (r + l), Math.sin(a) * (r + l), b === 0 ? C.y : C.w, 2); }
      for (const b of [-67, 67]) { const a = (b - 90) * DEG; txt(g, '=', Math.cos(a) * 136, Math.sin(a) * 136, C.g, 14, 'center'); }
      g.save(); g.rotate(-att.roll * DEG); g.fillStyle = C.y; g.beginPath(); g.moveTo(0, -126); g.lineTo(-9, -112); g.lineTo(9, -112); g.closePath(); g.fill();
      // sideslip index (beta target in engine-out = blue)
      const beta = clamp((f.beta || 0) / DEG * 4, -20, 20); g.fillRect(-10 + beta, -108, 20, 5); g.restore();
      g.restore();
      // FD bars / FPV
      g.save(); g.translate(cx, cy);
      if (ef.fd && afs.fd[side] && !f.onGround || (ef.fd && afs.fd[side] && afs.vert === 'SRS')) {
        if (!afs.fcu.trkFpa) {
          if (afs.fdPitch != null) line(g, -90, afs.fdPitch * 7.2, 90, afs.fdPitch * 7.2, C.g, 3);
          if (afs.fdRoll != null) line(g, afs.fdRoll * 7, -90, afs.fdRoll * 7, 90, C.g, 3);
        }
      }
      if (afs.fcu.trkFpa && f.tas > 30) {
        const v = f.vel, gam = Math.atan2(v[1], Math.hypot(v[0], v[2])) / DEG; const trk = wrap360(Math.atan2(v[0], -v[2]) / DEG);
        const dx = angDiff(trk, att.hdg) * 7.2, dy = -(gam - att.pitch) * 7.2;
        g.save(); g.translate(dx, dy); g.rotate(-att.roll * DEG); g.strokeStyle = C.g; g.lineWidth = 2.5; g.beginPath(); g.arc(0, 0, 9, 0, Math.PI * 2); g.stroke(); line(g, -26, 0, -9, 0, C.g, 2.5); line(g, 9, 0, 26, 0, C.g, 2.5); line(g, 0, -9, 0, -18, C.g, 2.5);
        if (ef.fd && afs.fd[side] && afs.fdPitch != null) { g.strokeStyle = C.g; g.beginPath(); g.arc(afs.fdRoll * 3, -afs.fdPitch * 7.2, 6, 0, Math.PI * 2); g.stroke(); }
        g.restore();
      }
      // aircraft symbol
      g.fillStyle = '#000'; g.strokeStyle = C.y; g.lineWidth = 3;
      for (const s of [-1, 1]) { g.fillRect(s * 95 - (s > 0 ? 0 : 0) - 0, -3, s * -55, 7); g.strokeRect(s > 0 ? 40 : -95, -3, 55, 7); g.strokeRect(s > 0 ? 40 : -48, -3, 8, 22); }
      g.fillRect(-4, -4, 8, 8); g.strokeRect(-4, -4, 8, 8);
      // stick position index on ground
      if (f.onGround && f.E.some((e) => e.running)) { const sx = f.ctrl.stickX * 70, sy = -f.ctrl.stickY * 70; g.strokeStyle = C.w; g.lineWidth = 2; for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { line(g, a * 70, b * 70, a * 60, b * 70); line(g, a * 70, b * 70, a * 70, b * 60); } g.strokeStyle = C.w; g.strokeRect(sx - 7, sy - 7, 14, 14); }
      g.restore();
      // radio altitude
      if (f.ra < 2500 * FT && S.essPowered) { const ra = Math.round(f.ra / FT - 4); const mda = fms.appr.radio; txt(g, ra < 50 ? String(Math.max(0, ra)) : String(Math.round(ra / 10) * 10), cx, cy + 128, mda != null && ra < mda + 100 && !f.onGround ? C.a : C.g, 22, 'center', true); }
    } else {
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.restore(); g.save(); txt(g, 'ATT', cx, cy, C.r, 30, 'center', true);
    }
    g.restore();
    // ---- speed tape
    const sx = 18, sw = 76, syc = cy;
    g.fillStyle = '#3a414a'; g.fillRect(sx, syc - 160, sw, 320);
    if (adrOk) {
      const ppk = 4.1; const iasD = Math.max(30, ias);
      g.save(); g.beginPath(); g.rect(sx, syc - 160, sw + 30, 320); g.clip();
      for (let v = Math.floor((iasD - 40) / 10) * 10; v <= iasD + 40; v += 10) {
        if (v < 30) continue; const y = syc - (v - iasD) * ppk; line(g, sx + sw - 14, y, sx + sw, y, C.w, 2);
        if (v % 20 === 0) txt(g, pad(v, 3), sx + sw - 18, y, C.w, 18, 'right');
      }
      // VMAX barber pole (red/black) and VLS / alpha prot / alpha max
      const vmax = S.vmax(); const yv = (v) => syc - (v - iasD) * ppk;
      for (let y = yv(vmax); y > syc - 170; y -= 12) { g.fillStyle = C.r; g.fillRect(sx + sw - 8, y - 12, 8, 6); g.fillStyle = '#000'; g.fillRect(sx + sw - 8, y - 6, 8, 6); }
      if (!f.onGround || f.ind.ias > 80) {
        const sp = speeds(f.mass, S.confIdx());
        const nzK = Math.sqrt(Math.max(0.5, f.nz || 1));
        const vls = sp.vls * nzK, vaprot = sp.vs * 1.13 * nzK, vamax = sp.vs * 1.06 * nzK;
        g.fillStyle = C.a; g.fillRect(sx + sw - 4, yv(vls), 4, Math.max(0, yv(vaprot) - yv(vls)));
        for (let y = yv(vaprot); y < yv(vamax); y += 10) { g.fillStyle = C.a; g.fillRect(sx + sw - 8, y, 8, 5); g.fillStyle = '#000'; g.fillRect(sx + sw - 8, y + 5, 8, 5); }
        g.fillStyle = C.r; g.fillRect(sx + sw - 8, yv(vamax), 8, 400);
        // F, S, green dot
        const ci = S.confIdx();
        if (ci === 0) { g.strokeStyle = C.g; g.lineWidth = 2; g.beginPath(); g.arc(sx + sw + 8, yv(sp.gd), 5, 0, Math.PI * 2); g.stroke(); }
        if (ci === 1 || ci === 2) txt(g, 'S', sx + sw + 10, yv(sp.S), C.g, 16, 'center', true);
        if (ci >= 3) txt(g, 'F', sx + sw + 10, yv(sp.F), C.g, 16, 'center', true);
        // next VFE (amber =)
        if (ci < 5 && !f.onGround) txt(g, '=', sx + sw - 4, yv(CONFS[Math.min(5, ci + 1)].vfe), C.a, 16, 'center', true);
      }
      // V1 / VR / V2
      if (f.onGround || f.ra < 400 * FT && fms.phase === 'TAKEOFF') {
        if (fms.perf.v1) { const y = yv(fms.perf.v1); if (y > syc - 160) { line(g, sx + sw - 20, y, sx + sw, y, C.c, 3); txt(g, '1', sx + sw + 6, y, C.c, 15); } else txt(g, String(fms.perf.v1), sx + 18, syc - 172, C.c, 16); }
        if (fms.perf.vr) { const y = yv(fms.perf.vr); g.strokeStyle = C.c; g.lineWidth = 2; g.beginPath(); g.arc(sx + sw + 6, y, 5, 0, Math.PI * 2); g.stroke(); }
      }
      g.restore();
      // speed trend arrow
      const acc = afs.accF / KT * 10; this.trend[side] += (acc - this.trend[side]) * 0.2;
      if (Math.abs(this.trend[side]) > 2) { const y2 = syc - this.trend[side] * ppk; line(g, sx + sw + 2, syc, sx + sw + 2, y2, C.y, 2.5); g.fillStyle = C.y; g.beginPath(); const s = Math.sign(this.trend[side]); g.moveTo(sx + sw - 4, y2 + s * 8); g.lineTo(sx + sw + 8, y2 + s * 8); g.lineTo(sx + sw + 2, y2); g.fill(); }
      // target speed
      const tgt = afs.targetSpd; const yt = syc - (tgt - iasD) * ppk; const col = afs.fcu.spdManaged ? C.m : C.c;
      if (yt < syc - 160) txt(g, String(Math.round(tgt)), sx + sw / 2, syc - 172, col, 18, 'center');
      else if (yt > syc + 160) txt(g, String(Math.round(tgt)), sx + sw / 2, syc + 172, col, 18, 'center');
      else { g.fillStyle = col; g.beginPath(); g.moveTo(sx + sw, yt); g.lineTo(sx + sw + 14, yt - 9); g.lineTo(sx + sw + 14, yt + 9); g.closePath(); g.fill(); }
      // ias reference line + mach
      g.fillStyle = C.y; g.fillRect(sx - 8, syc - 2, sw + 16, 4); g.beginPath(); g.moveTo(sx + sw + 6, syc); g.lineTo(sx + sw + 18, syc - 7); g.lineTo(sx + sw + 18, syc + 7); g.fill();
      if (f.ind.mach > 0.5) txt(g, '.' + String(Math.round(f.ind.mach * 1000)).padStart(3, '0').slice(0, 3), sx + 10, syc + 190, C.g, 20);
      if (afs.fcu.machMode && !afs.fcu.spdManaged) txt(g, afs.fcu.mach.toFixed(2).slice(1), sx + sw / 2, syc - 192, C.c, 16, 'center');
    } else { txt(g, 'SPD', sx + sw / 2, syc, C.r, 24, 'center', true); }
    box(g, sx, syc - 160, sw, 320, C.w, 2);
    // ---- altitude tape
    const ax = 460, aw = 70; const alt = f.ind.alt;
    g.fillStyle = '#3a414a'; g.fillRect(ax, cy - 160, aw, 320);
    if (adrOk) {
      const ppf = 0.32;
      g.save(); g.beginPath(); g.rect(ax, cy - 160, aw, 320); g.clip();
      for (let a = Math.floor((alt - 600) / 100) * 100; a <= alt + 600; a += 100) {
        const y = cy - (a - alt) * ppf; line(g, ax, y, ax + 10, y, C.w, 2);
        if (a % 500 === 0) txt(g, String(Math.round(a / 100)).padStart(3, '0'), ax + 14, y, C.w, 18);
      }
      // ground reference (ra)
      if (f.ra < 600 * FT) { const gy = cy + (f.ra / FT) * ppf; g.fillStyle = C.r; g.fillRect(ax + aw - 10, gy, 10, 400); }
      g.restore();
      // target altitude
      const ta = afs.fcu.alt; const ya = cy - (ta - alt) * ppf; const acol = afs.vert === 'ALT CST' || afs.vert === 'ALT CST*' ? C.m : C.c;
      if (Math.abs(ta - alt) < 520) { g.strokeStyle = acol; g.lineWidth = 2; g.strokeRect(ax + 2, ya - 14, 28, 28); }
      else txt(g, String(ta >= 10000 || afs.fcu.std ? 'FL' + Math.round(ta / 100) : ta), ax + aw / 2, ta > alt ? cy - 172 : cy + 172, acol, 17, 'center');
      // drum
      g.fillStyle = '#000'; g.fillRect(ax - 4, cy - 20, aw + 8, 40); g.strokeStyle = C.y; g.lineWidth = 2; g.strokeRect(ax - 4, cy - 20, aw + 8, 40);
      const hund = Math.floor(alt / 100); txt(g, String(hund).padStart(3, ' '), ax + 38, cy, C.g, 24, 'right', true);
      const tens = ((alt % 100) + 100) % 100; g.save(); g.beginPath(); g.rect(ax + 40, cy - 20, 32, 40); g.clip();
      for (let k = -1; k <= 1; k++) { const v = (Math.floor(tens / 20) + k) * 20; txt(g, String(((v % 100) + 100) % 100).padStart(2, '0'), ax + 42, cy + (tens - v) * 1.0 * 1.2 , C.g, 18); }
      g.restore();
      // metric
      if (sim.fcuMetric) txt(g, Math.round(alt * FT) + ' M', ax + aw, cy - 186, C.c, 15, 'right');
      // V/S
      const vs = f.ind.vsi; const vx = ax + aw + 10;
      g.fillStyle = '#3a414a'; g.beginPath(); g.moveTo(vx, cy - 130); g.lineTo(vx + 30, cy - 100); g.lineTo(vx + 30, cy + 100); g.lineTo(vx, cy + 130); g.fill();
      for (const v of [-6, -2, -1, 1, 2, 6]) { const y = cy - Math.sign(v) * (Math.abs(v) <= 1 ? 40 : Math.abs(v) <= 2 ? 70 : 110) * (Math.abs(v) <= 1 ? Math.abs(v) : 1); line(g, vx + 2, y, vx + 10, y, C.w, 2); txt(g, String(Math.abs(v)), vx + 16, y, C.w, 12); }
      const vsy = (v) => { const a = Math.abs(v) / 1000; const p = a <= 1 ? a * 40 : a <= 2 ? 40 + (a - 1) * 30 : 70 + Math.min(4, a - 2) * 10; return cy - Math.sign(v) * p; };
      const vcol = Math.abs(vs) > 6000 || (f.ra < 1000 * FT && vs < -1200) || (f.ra < 2500 * FT && vs < -2000) ? C.a : C.g;
      line(g, vx + 50, cy, vx + 6, vsy(vs), vcol, 3);
      if (Math.abs(vs) > 200) { g.fillStyle = '#000'; g.fillRect(vx + 2, vsy(vs) - (vs > 0 ? 22 : -4), 30, 18); txt(g, String(Math.round(Math.abs(vs) / 100)).padStart(2, '0'), vx + 4, vsy(vs) + (vs > 0 ? -13 : 13), vcol, 16); }
    } else txt(g, 'ALT', ax + aw / 2, cy, C.r, 24, 'center', true);
    box(g, ax, cy - 160, aw, 320, C.w, 2);
    // baro
    const std = ef.std; const qnh = ef.baro;
    if (std) { g.strokeStyle = C.y; g.lineWidth = 2; g.strokeRect(ax - 4, cy + 182, 66, 28); txt(g, 'STD', ax + 29, cy + 196, C.c, 20, 'center'); }
    else { txt(g, 'QNH', ax - 6, cy + 196, C.w, 16); txt(g, ef.inHg ? (qnh / 33.8639).toFixed(2) : String(Math.round(qnh)), ax + 36, cy + 196, C.c, 20); }
    // ---- heading tape
    const hy = cy + 162;
    g.fillStyle = '#3a414a'; g.fillRect(cx - 140, hy, 280, 40);
    if (hdgOk) {
      g.save(); g.beginPath(); g.rect(cx - 140, hy, 280, 40); g.clip();
      for (let h = Math.floor(att.hdg - 25); h <= att.hdg + 25; h++) {
        if (h % 5) continue; const x = cx + angDiff(h, att.hdg) * 5.6; line(g, x, hy, x, hy + (h % 10 ? 7 : 12), C.w, 2);
        if (h % 10 === 0) txt(g, String(wrap360(h) / 10).padStart(2, '0'), x, hy + 26, C.w, h % 30 === 0 ? 17 : 14, 'center');
      }
      // selected heading / track symbol
      if (afs.lat === 'HDG' || afs.lat === 'TRK' || afs.fcu.hdgPreset) { const x = cx + angDiff(afs.fcu.hdg, att.hdg) * 5.6; g.fillStyle = C.c; g.beginPath(); g.moveTo(x, hy + 2); g.lineTo(x - 7, hy - 10); g.lineTo(x + 7, hy - 10); g.fill(); }
      if (f.tas > 20) { const trk = wrap360(Math.atan2(f.vel[0], -f.vel[2]) / DEG); const x = cx + angDiff(trk, att.hdg) * 5.6; g.strokeStyle = C.g; g.lineWidth = 2; g.beginPath(); g.moveTo(x, hy + 2); g.lineTo(x - 6, hy + 10); g.lineTo(x, hy + 18); g.lineTo(x + 6, hy + 10); g.closePath(); g.stroke(); }
      // ILS course
      if (ef.ls && sim.afs.ils?.valid) { const x = cx + angDiff(sim.afs.ils.course, att.hdg) * 5.6; line(g, x, hy, x, hy + 20, C.m, 3); }
      g.restore();
      line(g, cx, hy - 6, cx, hy + 12, C.y, 3);
    } else txt(g, 'HDG', cx, hy + 20, C.r, 20, 'center', true);
    // ---- LS deviation
    const ils = sim.afs.ils || {};
    if (ef.ls) {
      txt(g, ils.ident || '', 30, 470, C.m, 17); if (ils.valid) txt(g, (ils.dme ?? 0).toFixed(1) + 'NM', 30, 492, C.m, 16);
      if (sim.fms.tunedIls) txt(g, sim.fms.tunedIls.freq.toFixed(2), 120, 470, C.m, 16);
      // loc scale (bottom) and gs scale (right of attitude)
      for (const d of [-2, -1, 1, 2]) { g.strokeStyle = C.w; g.lineWidth = 2; g.beginPath(); g.arc(cx + d * 40, cy + 148, 4, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(cx + 150, cy + d * 40, 4, 0, Math.PI * 2); g.stroke(); }
      if (ils.valid) { const x = cx + clamp(-ils.loc, -2.3, 2.3) * 40; g.fillStyle = C.m; g.beginPath(); g.moveTo(x - 10, cy + 148); g.lineTo(x, cy + 141); g.lineTo(x + 10, cy + 148); g.lineTo(x, cy + 155); g.fill(); }
      if (ils.gsValid) { const y = cy + clamp(ils.gs, -2.3, 2.3) * 40; g.fillStyle = C.m; g.beginPath(); g.moveTo(cx + 150, y - 10); g.lineTo(cx + 157, y); g.lineTo(cx + 150, y + 10); g.lineTo(cx + 143, y); g.fill(); }
    }
    // ---- minimums
    const mins = fms.appr.baro ? 'BARO ' + fms.appr.baro : fms.appr.radio != null ? 'RADIO ' + fms.appr.radio : '';
    if (fms.phase === 'APPROACH' && mins) {
      const atMin = fms.appr.baro ? f.ind.alt < fms.appr.baro : f.ra / FT < fms.appr.radio;
      txt(g, 'MINIMUM', 380, 470, atMin && !f.onGround ? C.a : C.w, 14); txt(g, mins, 380, 490, atMin && !f.onGround ? C.a : C.c, 15);
    }
    // ---- FMA
    this.fma(g, side, t);
    // ---- messages under FMA / flags
    if (f.law !== 'NORMAL' && S.essPowered) txt(g, f.law === 'DIRECT' ? 'USE MAN PITCH TRIM' : '', cx, 112, C.a, 16, 'center');
    if (f.law !== 'NORMAL' && attOk) { for (const s of [-1, 1]) txt(g, 'X', cx + s * 104, cy - 132, C.a, 18, 'center', true); }
    if (afs.S.stallAural) txt(g, 'STALL', cx, cy - 60, C.r, 26, 'center', true);
    if (S.autolandWarn) { g.fillStyle = C.r; txt(g, 'AUTO LAND', cx, cy + 90, C.r, 20, 'center', true); }
    if (f.ra < 2500 * FT && sim.gpws?.msg) txt(g, sim.gpws.msg, cx, cy + 100, sim.gpws.red ? C.r : C.a, 22, 'center', true);
    if (sim.tcasRA) txt(g, sim.tcasRA, cx, cy - 90, C.r, 20, 'center', true);
    if (f.prot.hsp) txt(g, '', 0, 0);
    // V1 flag text when off scale
    if (f.onGround && fms.perf.v1 == null && f.E.some((e) => e.running)) txt(g, 'V1 INOP', sx, 70 + 0, C.a, 0);
  }

  fma(g, side, t) {
    const afs = this.sim.afs; const m = afs.fma(); const y0 = 6, rh = 22;
    const cols = [0, 116, 236, 352, 462, 600];
    for (let i = 1; i < 5; i++) line(g, cols[i], y0, cols[i], y0 + rh * 3, '#777', 2);
    const cxm = (i) => (cols[i] + cols[i + 1]) / 2;
    const chg = (k) => { const key = side + k; this._fmaPrev = this._fmaPrev || {}; const p = this._fmaPrev[key]; if (p !== m[k]) { this._fmaPrev[key] = m[k]; this._fmaT = this._fmaT || {}; this._fmaT[key] = t; } return t - (this._fmaT?.[key] ?? -99) < 10; };
    const put = (s, col, i, row, k, boxCol) => {
      if (!s) return; const x = i === 1.5 ? (cols[1] + cols[3]) / 2 : cxm(i), y = y0 + rh * row + rh / 2;
      txt(g, s, x, y, col, 17, 'center');
      if (k && chg(k)) { g.strokeStyle = boxCol || C.w; g.lineWidth = 2; const w = g.measureText(s).width + 10; g.strokeRect(x - w / 2, y - 11, w, 22); }
    };
    // col 1 A/THR
    const athrCol = m.athr.startsWith('MAN') ? C.w : m.athr === 'A.FLOOR' || m.athr === 'TOGA LK' ? C.g : m.athr === 'THR LK' ? C.a : C.g;
    if (m.athr.startsWith('MAN ')) { const [a, ...b] = m.athr.split(' '); put('MAN', C.w, 0, 0); put(b.join(' '), C.w, 0, 1); if (chg('athr')) box(g, cols[0] + 6, y0 + 1, 104, rh * 2 - 2, C.w, 2); }
    else put(m.athr, athrCol, 0, 0, 'athr', m.athrBox ? C.a : C.w);
    if (m.lvr) { if (Math.floor(t * 2) % 2 === 0 || m.lvr === 'RETARD') put(m.lvr, C.w, 0, 2); }
    // col 2-3
    if (m.common) { put(m.common, C.g, 1.5, 0, 'common'); }
    else { put(m.vert, C.g, 1, 0, 'vert'); put(m.lat, C.g, 2, 0, 'lat'); }
    put(m.vertArm, C.c, 1, 1); put(m.latArm, C.c, 2, 1);
    if (afs.fcu.spdManaged && this.sim.fms.phase === 'DESCENT' && afs.vert === 'DES' && afs.pathDev > 300) put('MORE DRAG', C.w, 1.5, 2);
    if (m.msg) put(m.msg, C.w, 1.5, 2);
    // col 4 approach capability / minimums
    put(m.cap ? m.cap.split(' ')[0] : '', C.w, 3, 0, 'cap'); put(m.cap ? m.cap.split(' ')[1] : '', C.w, 3, 1); put(m.cap ? m.mins : '', C.c, 3, 2);
    // col 5
    put(m.ap, C.w, 4, 0, 'ap'); put(m.fd, C.w, 4, 1); put(m.athrSt.replace('*', ''), m.athrSt.endsWith('*') ? C.c : C.w, 4, 2);
  }

  // ===================== ND =====================
  nd(g, side, t, reg) {
    const sim = this.sim, f = sim.fdm, S = sim.S, fms = sim.fms, ef = sim.efis[side];
    if (!S.hdgValid()) { txt(g, 'HDG', W / 2, 240, C.r, 26, 'center', true); txt(g, S.ir.some((r) => r.state === 'NAV' && r.align < 1) ? 'ALIGN IN PROGRESS ' + Math.ceil((1 - Math.max(...S.ir.map((r) => r.align))) * (S.fastAlign ? 75 : 420) / 60) + ' MN' : '', W / 2, 280, C.g, 16, 'center'); return; }
    const att = f.attitude; const hdg = att.hdg; const trk = f.tas > 25 || f.ind.gs > 30 ? wrap360(Math.atan2(f.vel[0], -f.vel[2]) / DEG) : hdg;
    const mode = ef.mode; const range = ef.range;
    const plan = mode === 'PLAN', arc = mode === 'ARC';
    const cx = W / 2, cy = arc ? 455 : 280, R = arc ? 400 : 200;
    const up = plan ? 0 : hdg;
    const ppm = R / (range * NM) * (arc ? 1 : 1);
    const planC = plan ? (fms.legs[fms.selectedLeg || fms.act] || fms.legs[fms.act]) : null;
    const ox = plan && planC ? planC.x : f.pos[0], oz = plan && planC ? planC.z : f.pos[2];
    const toScr = (x, z) => { const dx = x - ox, dz = z - oz; const a = -up * DEG; const e = dx * Math.cos(a) - (-dz) * Math.sin(a), n = dx * Math.sin(a) + (-dz) * Math.cos(a); return [cx + e * ppm, cy - n * ppm]; };
    // terrain
    if (ef.terr && !plan) this.ndTerrain(g, f, toScr, ppm, cx, cy, R, range, up, t, arc);
    // compass
    g.save();
    if (!plan) {
      g.strokeStyle = C.w; g.lineWidth = 2; g.beginPath(); if (arc) g.arc(cx, cy, R, Math.PI * 1.17, Math.PI * 1.83); else g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
      for (let h = 0; h < 360; h += 5) {
        const a = (h - up - 90) * DEG; if (arc && Math.abs(angDiff(h, up)) > 62) continue;
        const l = h % 10 ? 8 : 15; line(g, cx + Math.cos(a) * R, cy + Math.sin(a) * R, cx + Math.cos(a) * (R + l), cy + Math.sin(a) * (R + l), C.w, 2);
        if (h % 30 === 0) { g.save(); g.translate(cx + Math.cos(a) * (R + 30), cy + Math.sin(a) * (R + 30)); g.rotate((h - up) * DEG); txt(g, String(h / 10), 0, 0, C.w, 18, 'center'); g.restore(); }
      }
      // inner range ring
      g.setLineDash([8, 10]); g.strokeStyle = '#ddd'; g.lineWidth = 1.5; g.beginPath(); if (arc) g.arc(cx, cy, R / 2, Math.PI * 1.17, Math.PI * 1.83); else g.arc(cx, cy, R / 2, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
      txt(g, String(range / 2), cx - R / 2 * 0.62 - 10, cy - R / 2 * 0.78, C.c, 14, 'center');
      // lubber + selected heading + track
      g.fillStyle = C.y; g.fillRect(cx - 2, cy - R - 22, 4, 22);
      if (sim.afs.lat === 'HDG' || sim.afs.lat === 'TRK' || sim.afs.fcu.hdgPreset) { const a = (sim.afs.fcu.hdg - up - 90) * DEG; g.save(); g.translate(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.rotate(a + Math.PI / 2); g.fillStyle = C.c; g.beginPath(); g.moveTo(0, 0); g.lineTo(-8, -14); g.lineTo(8, -14); g.fill(); g.restore(); }
      { const a = (trk - up - 90) * DEG; g.save(); g.translate(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.rotate(a + Math.PI / 2); g.strokeStyle = C.g; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 2); g.lineTo(-6, 10); g.lineTo(0, 18); g.lineTo(6, 10); g.closePath(); g.stroke(); g.restore(); }
    } else {
      g.strokeStyle = C.w; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke(); g.setLineDash([8, 10]); g.beginPath(); g.arc(cx, cy, R / 2, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
      for (const [l, a] of [['N', -90], ['E', 0], ['S', 90], ['W', 180]]) { txt(g, l, cx + Math.cos(a * DEG) * (R + 18), cy + Math.sin(a * DEG) * (R + 18), C.w, 18, 'center'); }
    }
    g.restore();
    g.save(); g.beginPath(); if (arc) { g.rect(0, 40, W, cy - 40 + 30); } else g.rect(0, 40, W, TOP - 40); g.clip();
    // navaids / airports / waypoints
    const maxD = range * NM * 1.6;
    if (ef.opt === 'ARPT' || true) for (const a of AIRPORTS) {
      const d = Math.hypot(a.arp[0] - f.pos[0], a.arp[1] - f.pos[2]); if (d > maxD) continue;
      if (ef.opt !== 'ARPT' && !(a.icao === fms.origin?.icao || a.icao === fms.dest?.icao)) continue;
      const [x, y] = toScr(a.arp[0], a.arp[1]); g.strokeStyle = ef.opt === 'ARPT' ? C.m : C.w; g.lineWidth = 2;
      if (range <= 20) for (const r of a.runways) { const e0 = { x: r.x - r.dir[0] * r.len / 2, z: r.z - r.dir[1] * r.len / 2 }, e1 = { x: r.x + r.dir[0] * r.len / 2, z: r.z + r.dir[1] * r.len / 2 }; const p0 = toScr(e0.x, e0.z), p1 = toScr(e1.x, e1.z); line(g, p0[0], p0[1], p1[0], p1[1], C.w, 3); }
      else { g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.stroke(); }
      txt(g, a.icao, x + 10, y + 14, ef.opt === 'ARPT' ? C.m : C.w, 14);
    }
    if (ef.opt === 'VORD' || ef.opt === 'NDB') for (const n of NAVAIDS) {
      if ((ef.opt === 'VORD') !== (n.type === 'VOR')) continue; const d = Math.hypot(n.x - f.pos[0], n.z - f.pos[2]); if (d > maxD) continue;
      const [x, y] = toScr(n.x, n.z); g.strokeStyle = C.m; g.lineWidth = 2;
      if (n.type === 'VOR') { line(g, x - 8, y, x + 8, y, C.m); line(g, x, y - 8, x, y + 8, C.m); g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.stroke(); } else { g.beginPath(); g.moveTo(x, y - 8); g.lineTo(x + 7, y + 6); g.lineTo(x - 7, y + 6); g.closePath(); g.stroke(); }
      txt(g, n.ident, x + 10, y + 12, C.m, 14);
    }
    if (ef.opt === 'WPT') for (const w of [...fms.db, ...fms.legs.filter((l) => l.kind === 'FIX')]) { if (w.type === 'APT' || w.type === 'VOR' || w.type === 'NDB') continue; const d = Math.hypot(w.x - f.pos[0], w.z - f.pos[2]); if (d > maxD) continue; const [x, y] = toScr(w.x, w.z); g.strokeStyle = C.m; g.lineWidth = 1.5; g.strokeRect(x - 5, y - 5, 10, 10); txt(g, w.ident, x + 8, y + 10, C.m, 12); }
    // flight plan
    const L = fms.legs;
    if (L.length && mode !== 'ROSE LS' && mode !== 'ROSE VOR') {
      for (let i = 1; i < L.length; i++) {
        const a = L[i - 1], b = L[i]; if (b.missed && !fms.missedActive && !(i > fms.destI)) {}
        const p0 = i === fms.act && fms.dirTo?.from ? toScr(fms.dirTo.from.x, fms.dirTo.from.z) : toScr(a.x, a.z), p1 = toScr(b.x, b.z);
        const missed = i > fms.destI;
        if (i < fms.act) continue;
        g.setLineDash(missed && !fms.missedActive ? [10, 8] : []);
        line(g, p0[0], p0[1], p1[0], p1[1], missed ? C.c : i === fms.act ? C.w : C.g, 2.5);
        g.setLineDash([]);
      }
      for (let i = Math.max(0, fms.act - 1); i < L.length; i++) {
        const w = L[i]; const [x, y] = toScr(w.x, w.z); const col = i === fms.act ? C.w : i > fms.destI ? C.c : C.g;
        if (w.kind === 'RWY') { g.strokeStyle = col; g.lineWidth = 2; g.strokeRect(x - 6, y - 6, 12, 12); }
        else { g.save(); g.translate(x, y); g.rotate(Math.PI / 4); g.strokeStyle = col; g.lineWidth = 2; g.strokeRect(-5, -5, 10, 10); g.restore(); }
        txt(g, w.ident, x + 10, y - 10, col, 15);
        if (ef.cstr && w.alt && i >= fms.act) txt(g, (w.alt.c === 'AB' ? '+' : w.alt.c === 'BL' ? '-' : '') + w.alt.ft, x + 10, y + 8, C.m, 12);
      }
      // TOD / decel pseudo waypoints
      if (fms.tod != null && fms.tod > 0) { const p = fms.posAlong?.(fms.tod); if (p) { const [x, y] = toScr(p.x, p.z); txt(g, '\u2198', x, y, C.w, 20, 'center', true); } }
    }
    // selected VOR course / LS course on ROSE modes
    const ils = sim.afs.ils || {};
    if (mode === 'ROSE LS' && ils.course != null) {
      const a = (ils.course - up) * DEG; g.save(); g.translate(cx, cy); g.rotate(a);
      line(g, 0, -R + 10, 0, -60, C.m, 3); line(g, 0, R - 10, 0, 60, C.m, 3);
      for (const d of [-2, -1, 1, 2]) { g.strokeStyle = C.w; g.lineWidth = 2; g.beginPath(); g.arc(d * 40, 0, 4, 0, Math.PI * 2); g.stroke(); }
      if (ils.valid) line(g, clamp(-ils.loc, -2.4, 2.4) * 40, -55, clamp(-ils.loc, -2.4, 2.4) * 40, 55, C.m, 3);
      g.restore();
      txt(g, 'ILS ' + (fms.tunedIls?.freq.toFixed(2) || ''), W - 20, 52, C.w, 16, 'right'); txt(g, 'CRS ' + pad(ils.course) + '°', W - 20, 72, C.w, 16, 'right'); txt(g, ils.ident || '', W - 20, 92, C.m, 16, 'right');
      if (ils.gsValid) { for (const d of [-2, -1, 1, 2]) { g.strokeStyle = C.w; g.beginPath(); g.arc(W - 30, cy + d * 40, 4, 0, Math.PI * 2); g.stroke(); } g.fillStyle = C.m; const y = cy + clamp(ils.gs, -2.4, 2.4) * 40; g.beginPath(); g.moveTo(W - 30, y - 9); g.lineTo(W - 23, y); g.lineTo(W - 30, y + 9); g.lineTo(W - 37, y); g.fill(); }
    }
    if (mode === 'ROSE VOR') {
      const v = sim.fms.vorRx(0, f); const crs = sim.fms.vor[0].crs || 0;
      const a = (crs - up) * DEG; g.save(); g.translate(cx, cy); g.rotate(a); line(g, 0, -R + 10, 0, -60, C.c, 3); line(g, 0, R - 10, 0, 60, C.c, 3);
      if (v.valid) { const dev = clamp(angDiff(v.brgTo, crs) / 5, -2.4, 2.4); line(g, -dev * 40, -55, -dev * 40, 55, C.c, 3); }
      g.restore();
      txt(g, 'VOR1 ' + sim.fms.vor[0].freq.toFixed(2), W - 20, 52, C.w, 16, 'right'); txt(g, 'CRS ' + pad(crs) + '°', W - 20, 72, C.w, 16, 'right'); txt(g, v.ident || '', W - 20, 92, C.c, 16, 'right');
    }
    // traffic (TCAS)
    if (sim.traffic?.enabled && sim.S.ped.tcas > 0 && !plan) {
      for (const a of sim.traffic.list || []) {
        const p = a.pos || a.position; if (!p) continue; const px = p.x ?? p[0], py = p.y ?? p[1], pz = p.z ?? p[2];
        const d = Math.hypot(px - f.pos[0], pz - f.pos[2]); if (d > Math.min(range, 40) * NM) continue;
        const rel = Math.round((py - f.pos[1]) / FT / 100); if (Math.abs(rel) > 27) continue;
        const [x, y] = toScr(px, pz); const ta = d < 3 * NM && Math.abs(rel) < 9;
        g.fillStyle = ta ? C.a : C.w; g.strokeStyle = C.w; g.lineWidth = 2;
        g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 7, y); g.lineTo(x, y + 7); g.lineTo(x - 7, y); g.closePath(); if (ta || d < 6 * NM && Math.abs(rel) < 12) g.fill(); else g.stroke();
        txt(g, (rel >= 0 ? '+' : '-') + String(Math.abs(rel)).padStart(2, '0'), x, rel >= 0 ? y - 16 : y + 16, ta ? C.a : C.w, 13, 'center');
      }
    }
    g.restore();
    // aircraft symbol
    if (plan) { const [x, y] = toScr(f.pos[0], f.pos[2]); g.save(); g.translate(x, y); g.rotate(hdg * DEG); this.acSym(g); g.restore(); }
    else { g.save(); g.translate(cx, cy); this.acSym(g); g.restore(); }
    // top-left: GS / TAS / wind
    txt(g, 'GS', 12, 18, C.w, 15); txt(g, String(Math.round(f.ind.gs)), 44, 18, C.g, 18);
    txt(g, 'TAS', 96, 18, C.w, 15); txt(g, f.tas > 50 * KT ? String(Math.round(f.tas / KT)) : '---', 136, 18, C.g, 18);
    if (f.tas > 100 * KT) { txt(g, pad(f.ind.windDir) + '°/' + Math.round(f.ind.windKt), 12, 40, C.g, 16); const a = (f.ind.windDir + 180 - up) * DEG; g.save(); g.translate(30, 76); g.rotate(a); line(g, 0, -16, 0, 16, C.g, 3); g.fillStyle = C.g; g.beginPath(); g.moveTo(0, 18); g.lineTo(-6, 6); g.lineTo(6, 6); g.fill(); g.restore(); }
    // top-right: active waypoint
    if (fms.nav && fms.legs.length && mode !== 'ROSE LS' && mode !== 'ROSE VOR') {
      const n = fms.nav; txt(g, n.to.ident, W - 190, 18, C.w, 18); const brg = wrap360(Math.atan2(n.to.x - f.pos[0], -(n.to.z - f.pos[2])) / DEG);
      txt(g, pad(brg) + '°', W - 80, 18, C.g, 18); txt(g, n.distTo.toFixed(n.distTo < 20 ? 1 : 0), W - 60, 40, C.g, 18, 'right'); txt(g, 'NM', W - 56, 40, C.c, 14);
      const now = sim.utc(); const eta = now + n.eteMin / 60; txt(g, `${String(Math.floor(eta) % 24).padStart(2, '0')}:${String(Math.floor((eta % 1) * 60)).padStart(2, '0')}`, W - 20, 62, C.g, 16, 'right');
    }
    // bottom: VOR/ADF pointers info
    for (let i = 0; i < 2; i++) {
      const selv = ef.nav[i]; if (!selv) continue; const v = sim.fms.vorRx(i, f);
      const x = i ? W - 20 : 14, al = i ? 'right' : 'left', col = selv === 'VOR' ? C.w : C.g;
      txt(g, selv + (i + 1), x, TOP - 46, col, 15, al); txt(g, v.ident || sim.fms.vor[i].freq.toFixed(2), x, TOP - 28, col, 15, al); if (v.valid) txt(g, v.dme.toFixed(1) + ' NM', x, TOP - 10, C.g, 15, al);
      if (v.valid && !plan) { const a = (v.brgTo - up - 90) * DEG; g.save(); g.translate(cx, cy); g.rotate(a + Math.PI / 2); g.strokeStyle = col; g.lineWidth = 3; if (i === 0) { line(g, 0, -R + 6, 0, -R + 50, col, 3); line(g, 0, R - 6, 0, R - 50, col, 3); } else { line(g, -4, -R + 30, -4, -R + 60, col, 3); line(g, 4, -R + 30, 4, -R + 60, col, 3); line(g, -4, R - 30, -4, R - 60, col, 3); line(g, 4, R - 30, 4, R - 60, col, 3); } g.restore(); }
    }
    // mode annunciations
    if (ef.terr) txt(g, 'TERR', W - 70, TOP - 70, C.c, 15); if (S.ped.wxr && !ef.terr) txt(g, 'WXR', W - 70, TOP - 70, C.c, 15);
    if (S.ped.tcas === 0) txt(g, 'TCAS STBY', W / 2, TOP - 20, C.w, 15, 'center');
    if (mode === 'PLAN') { txt(g, 'PLAN', 12, TOP - 20, C.w, 14); }
    if (fms.msgNd) txt(g, fms.msgNd, W / 2, TOP - 30, C.w, 16, 'center');
    if (!fms.legs.length && mode !== 'ROSE LS') txt(g, 'NO F-PLN', W / 2, 140, C.w, 18, 'center');
    if (S.ir.some((r) => r.state === 'NAV' && r.align < 1)) txt(g, 'ALIGN', W / 2, 160, C.g, 16, 'center');
    // range click areas: tap left/right of ND to change range (redundant with EFIS CP)
  }
  acSym(g) { g.strokeStyle = C.y; g.lineWidth = 4; line(g, 0, -12, 0, 30, C.y, 4); line(g, -24, 2, 24, 2, C.y, 4); line(g, -9, 24, 9, 24, C.y, 4); }

  ndTerrain(g, f, toScr, ppm, cx, cy, R, range, up, t, arc) {
    const N = 48; const key = Math.round(range) + ':' + Math.round(up / 3) + ':' + Math.round(f.pos[0] / (range * 40)) + ':' + Math.round(f.pos[2] / (range * 40)) + ':' + (arc ? 1 : 0);
    if (key !== this.terr.key || t - this.terr.t > 3) {
      this.terr.key = key; this.terr.t = t;
      const c = this.terr.c || (this.terr.c = document.createElement('canvas')); c.width = N; c.height = N; const gg = c.getContext('2d'); const img = gg.createImageData(N, N);
      const altFt = f.pos[1] / FT; const span = R * 2 / ppm;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const sx = (i + 0.5) / N * 2 - 1, sy = (j + 0.5) / N * 2 - 1;
        const e = sx * span / 2, n = -sy * span / 2 + (arc ? R * 0.9 / ppm - span / 2 * 0 : 0);
        const a = up * DEG; const dx = e * Math.cos(a) + n * Math.sin(a), dz = -(-e * Math.sin(a) + n * Math.cos(a));
        const h = heightAt(f.pos[0] + dx, f.pos[2] + dz) / FT; const d = h - altFt; const k = (j * N + i) * 4;
        let col = null; if (d > 2000) col = [255, 40, 40]; else if (d > -500) col = [255, 200, 0]; else if (d > -1000) col = [0, 160, 0]; else if (h > 500 && d > -2000) col = [0, 90, 0];
        if (col) { const dots = ((i + j) & 1) === 0 || d > -500; img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = dots ? 150 : 70; }
      }
      gg.putImageData(img, 0, 0); this.terr.arcOff = arc;
    }
    const span = R * 2; g.save(); g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip(); g.imageSmoothingEnabled = false;
    g.drawImage(this.terr.c, cx - span / 2, cy - span / 2 - (arc ? 0 : 0), span, span); g.restore();
  }

  // ===================== Vertical Display =====================
  vd(g, side, t) {
    const sim = this.sim, f = sim.fdm, fms = sim.fms, ef = sim.efis[side], afs = sim.afs; const h = H - TOP;
    g.fillStyle = '#000'; g.fillRect(0, 0, W, h);
    if (!sim.S.hdgValid() || ef.mode === 'PLAN' || ef.mode.startsWith('ROSE')) { txt(g, ef.mode === 'PLAN' || ef.mode.startsWith('ROSE') ? 'VD NOT AVAIL IN ' + ef.mode : 'VD', W / 2, h / 2, C.w, 15, 'center'); return; }
    const range = Math.min(ef.range, 160); const x0 = 70, x1 = W - 20, y0 = 30, y1 = h - 50;
    const alt = f.ind.alt; const altSpan = Math.max(4000, Math.min(40000, range * 400));
    const aMin = Math.max(-500, alt - altSpan * 0.4), aMax = aMin + altSpan;
    const X = (nm) => x0 + nm / range * (x1 - x0), Y = (a) => y1 - (a - aMin) / (aMax - aMin) * (y1 - y0);
    // grid
    for (let k = 0; k <= 4; k++) { const a = Math.round((aMin + k * altSpan / 4) / 500) * 500; const y = Y(a); line(g, x0, y, x0 + 8, y, C.w, 1.5); txt(g, String(a), x0 - 6, y, C.w, 13, 'right'); }
    for (let k = 1; k <= 4; k++) { const x = X(range * k / 4); line(g, x, y1, x, y1 + 6, C.w, 1.5); txt(g, String(range * k / 4), x, y1 + 16, C.c, 12, 'center'); }
    // terrain profile along track
    if (t - this.vdTerr.t > 1 || this.vdTerr.range !== range) {
      this.vdTerr.t = t; this.vdTerr.range = range; const trk = Math.atan2(f.vel[0], -f.vel[2]); const sp = f.ind.gs > 30 ? trk : f.attitude.hdg * DEG;
      const prof = []; for (let i = 0; i <= 60; i++) { const d = i / 60 * range * NM; prof.push(heightAt(f.pos[0] + Math.sin(sp) * d, f.pos[2] - Math.cos(sp) * d) / FT); } this.vdTerr.prof = prof;
    }
    g.fillStyle = '#6b4a1e'; g.beginPath(); g.moveTo(X(0), y1); this.vdTerr.prof.forEach((hh, i) => g.lineTo(X(i / 60 * range), Y(Math.max(aMin, hh)))); g.lineTo(X(range), y1); g.closePath(); g.fill();
    // FMS vertical profile
    if (fms.legs.length && fms.dDest != null) {
      g.setLineDash([]); g.strokeStyle = C.g; g.lineWidth = 2; g.beginPath();
      for (let i = 0; i <= 40; i++) { const d = i / 40 * range; const a = fms.phase === 'CLIMB' || fms.phase === 'TAKEOFF' ? Math.min(fms.crzFL * 100, alt + d * 330) : fms.pathAlt(Math.max(0, fms.dDest - d)); const y = Y(a); if (i) g.lineTo(X(d), y); else g.moveTo(X(d), y); }
      g.stroke();
    }
    // FCU altitude
    const ya = Y(afs.fcu.alt); g.setLineDash([10, 8]); line(g, x0, ya, x1, ya, C.c, 2); g.setLineDash([]);
    // flight path
    const gsNm = Math.max(60, f.ind.gs) / 60; const vs = f.ind.vsi; const dEnd = range; const aEnd = alt + vs * (dEnd / gsNm);
    line(g, X(0), Y(alt), X(dEnd), Y(aEnd), C.g, 2.5);
    // aircraft symbol
    g.fillStyle = C.y; g.beginPath(); g.moveTo(X(0) + 14, Y(alt)); g.lineTo(X(0) - 10, Y(alt) - 8); g.lineTo(X(0) - 10, Y(alt) + 8); g.closePath(); g.fill();
    txt(g, 'VD', 10, 14, C.w, 13);
  }

  // ===================== ISIS (standby) =====================
  isis(g, t) {
    const f = this.sim.fdm, att = f.attitude; const s = 300, cx = 150, cy = 160;
    g.save(); g.beginPath(); g.rect(60, 40, 180, 220); g.clip(); g.translate(cx, cy); g.rotate(-att.roll * DEG); g.translate(0, att.pitch * 4);
    g.fillStyle = C.sky; g.fillRect(-300, -600, 600, 600); g.fillStyle = C.gnd; g.fillRect(-300, 0, 600, 600); line(g, -300, 0, 300, 0, C.w, 2);
    for (let p = -20; p <= 20; p += 5) if (p) { line(g, -(p % 10 ? 10 : 22), -p * 4, (p % 10 ? 10 : 22), -p * 4, C.w, 1.5); }
    g.restore();
    g.strokeStyle = C.y; g.lineWidth = 4; line(g, cx - 50, cy, cx - 18, cy, C.y, 4); line(g, cx + 18, cy, cx + 50, cy, C.y, 4); g.fillStyle = C.y; g.fillRect(cx - 3, cy - 3, 6, 6);
    // speed / alt columns
    g.fillStyle = '#333'; g.fillRect(0, 40, 58, 220); g.fillRect(242, 40, 58, 220);
    txt(g, String(Math.round(f.ind.ias)), 29, cy, C.w, 20, 'center', true); txt(g, String(Math.round(f.ind.alt / 10) * 10), 271, cy, C.w, 17, 'center', true);
    for (let k = -2; k <= 2; k++) if (k) { const v = Math.round(f.ind.ias / 10) * 10 + k * 10; txt(g, String(v), 29, cy - (v - f.ind.ias) * 3.4, C.w, 13, 'center'); const a = Math.round(f.ind.alt / 100) * 100 + k * 100; txt(g, String(a), 271, cy - (a - f.ind.alt) * 0.4, C.w, 12, 'center'); }
    txt(g, 'M .' + String(Math.round(f.ind.mach * 100)).padStart(2, '0'), 8, 280, C.w, 14); txt(g, (this.sim.efis[0].std ? 'STD' : Math.round(this.sim.efis[0].baro) + 'HPA'), 292, 280, C.c, 14, 'right');
    txt(g, String(Math.round(att.hdg)).padStart(3, '0'), cx, 22, C.w, 16, 'center'); box(g, cx - 26, 10, 52, 24, C.y, 2);
    if (this.sim.S.ir.every((r) => r.state === 'OFF') && false) txt(g, 'ATT', cx, cy, C.r, 20, 'center');
  }
}
