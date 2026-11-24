// ECAM: Engine & Warning Display (EWD) and System Display (SD) pages.
import { clamp, DEG } from '../math.js';
import { FT, KT, A350, CONFS } from './data.js';
import { C, txt, box, line, FONT, W, H, TOP } from './displays.js';

const n1OfP = (P) => 19.5 + 77.5 * Math.pow(clamp(P, 0, 1), 0.62);
const kg = (v) => String(Math.round(v / 10) * 10);

function dial(g, x, y, r, val, min, max, redFrom, label, digits, col, extra) {
  const a0 = 200 * DEG, a1 = 380 * DEG; // left to upper-right sweep (Airbus style ~210°)
  const ang = (v) => a0 + (clamp(v, min, max * 1.1) - min) / (max - min) * (a1 - a0) * 0.9;
  g.strokeStyle = C.w; g.lineWidth = 3; g.beginPath(); g.arc(x, y, r, a0, ang(redFrom)); g.stroke();
  g.strokeStyle = C.r; g.lineWidth = 5; g.beginPath(); g.arc(x, y, r, ang(redFrom), ang(max)); g.stroke();
  for (let k = 0; k <= 5; k++) { const v = min + (max - min) * k / 5 * 0.9 / 0.9; const a = ang(min + (redFrom - min) * k / 5); line(g, x + Math.cos(a) * r, y + Math.sin(a) * r, x + Math.cos(a) * (r - 10), y + Math.sin(a) * (r - 10), C.w, 2); void v; }
  if (val != null) { const a = ang(val); line(g, x, y, x + Math.cos(a) * (r + 6), y + Math.sin(a) * (r + 6), col || C.g, 4); }
  if (extra) extra(ang);
  g.fillStyle = '#000'; g.fillRect(x - 6, y + 6, r + 8, 30); box(g, x - 6, y + 6, r + 8, 30, '#666', 1.5);
  txt(g, digits, x + r, y + 22, col || C.g, 22, 'right', true);
}

export function drawEWD(D, g, t, reg) {
  const sim = D.sim, f = sim.fdm, S = sim.S, E = f.E, afs = sim.afs;
  // thrust limit mode
  const lv = Math.max(f.ctrl.tla[0], f.ctrl.tla[1]);
  let mode = lv > 0.97 ? 'TOGA' : lv > 0.86 ? 'MCT' : lv > 0.7 && f.flexTemp != null && f.onGround ? 'FLX' : lv > 0.7 && afs.flexActive ? 'FLX' : lv > 0.7 ? 'MCT' : 'CLB';
  if (f.onGround && lv < 0.7 && f.flexTemp != null && sim.fms.phase !== 'DONE') mode = 'FLX';
  const P = mode === 'TOGA' ? 1 : mode === 'MCT' ? 0.93 : mode === 'FLX' ? 0.93 * (f.flexDerate ?? 1) : 0.86;
  const lim = n1OfP(P);
  txt(g, mode, 380, 22, C.c, 20, 'left'); txt(g, lim.toFixed(1) + '%', 590, 22, C.g, 20, 'right'); if (mode === 'FLX' && f.flexTemp != null) txt(g, (f.flexTemp > 0 ? '+' : '') + f.flexTemp + '°C', 590, 44, C.c, 16, 'right');
  // N1 dials
  for (let i = 0; i < 2; i++) {
    const e = E[i], x = i ? 400 : 170, y = 120; const avail = e.running || e.n1 > 2;
    const col = e.fire ? C.r : C.g;
    dial(g, x, y, 76, avail ? e.n1 : null, 0, 110, 101, 'N1', avail ? e.n1.toFixed(1) : 'XX', avail ? col : C.a, (ang) => {
      // thrust lever position (blue circle) and max N1 (amber tick)
      const tla = f.ctrl.tla[i]; const tp = tla >= 0 ? n1OfP(f.leverToPower(tla, i)) : 20; const a = ang(tp); g.strokeStyle = C.c; g.lineWidth = 2; g.beginPath(); g.arc(x + Math.cos(a) * 84, y + Math.sin(a) * 84, 6, 0, Math.PI * 2); g.stroke();
      const am = ang(lim); line(g, x + Math.cos(am) * 70, y + Math.sin(am) * 70, x + Math.cos(am) * 90, y + Math.sin(am) * 90, C.a, 4);
      if (afs.athr.active && f.athrPcmd != null) { const ac = ang(n1OfP(f.athrPcmd)); g.fillStyle = C.g; g.beginPath(); g.arc(x + Math.cos(ac) * 70, y + Math.sin(ac) * 70, 4, 0, Math.PI * 2); g.fill(); }
    });
    if (e.rev > 0.05) { box(g, x - 30, y - 50, 60, 26, e.rev > 0.95 ? C.g : C.a, 2); txt(g, 'REV', x, y - 37, e.rev > 0.95 ? C.g : C.a, 18, 'center', true); }
    if (e.starting) txt(g, e.startPhase === 'LIGHT' || e.startPhase === 'IGN' ? (e.ign ? 'A' : '') : '', x - 40, y + 60, C.g, 16);
    if (!e.running && !e.starting && e.n3 < 5 && S.master[i] === false && f.onGround) {}
    if (e.avail && t - (e.availT ?? -99) < 10) {}
    // EGT
    const ex = x, ey = 260;
    dial(g, ex, ey, 52, avail ? e.egt : null, 0, 1100, 1060, 'EGT', avail ? String(Math.round(e.egt)) : 'XX', e.egt > 1060 ? C.r : e.egt > 1000 ? C.a : C.g);
    // N2 / N3 / FF
    txt(g, String(Math.round(e.n2 * 10) / 10), x, 330, C.g, 18, 'center');
    txt(g, e.n3.toFixed(1), x, 354, e.starting ? C.w : C.g, 18, 'center'); if (e.starting) g.fillStyle = '#555';
    txt(g, kg(e.ff), x, 378, C.g, 18, 'center');
    if (e.starting) { box(g, x - 40, 342, 80, 24, C.w, 1.5); }
  }
  txt(g, 'N1', 285, 110, C.w, 15, 'center'); txt(g, '%', 285, 130, C.c, 14, 'center');
  txt(g, 'EGT', 285, 252, C.w, 15, 'center'); txt(g, '°C', 285, 272, C.c, 14, 'center');
  txt(g, 'N2', 285, 330, C.w, 15, 'center'); txt(g, 'N3', 285, 354, C.w, 15, 'center'); txt(g, 'FF', 285, 378, C.w, 15, 'center'); txt(g, 'KG/H', 285, 396, C.c, 11, 'center');
  // FOB
  txt(g, 'FOB :', 10, 64, C.w, 16); txt(g, kg(f.fob), 140, 64, C.g, 20, 'right'); txt(g, 'KG', 146, 64, C.c, 14);
  // S / F indicator
  { const sx = 490, sy = 90; const s = f.surf; const ci = S.confIdx();
    txt(g, 'S', sx - 40, sy, C.w, 16, 'center'); txt(g, 'F', sx + 80, sy, C.w, 16, 'center');
    g.fillStyle = C.g; const ss = s.slat / 26, ff = s.flap / 37.5;
    g.beginPath(); g.moveTo(sx - 4, sy); g.lineTo(sx - 4 - ss * 34, sy + ss * 18); g.lineTo(sx - 10 - ss * 34, sy + ss * 18 - 6); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(sx + 26, sy); g.lineTo(sx + 26 + ff * 44, sy + ff * 24); g.lineTo(sx + 32 + ff * 44, sy + ff * 24 - 7); g.closePath(); g.fill();
    g.fillStyle = C.w; g.fillRect(sx - 2, sy - 4, 26, 8);
    const moving = Math.abs(s.slat - f.cfgTarget.slat) > 0.3 || Math.abs(s.flap - f.cfgTarget.flap) > 0.3;
    const tc = D.sim.flapConf ?? ci; txt(g, tc === 0 && !moving ? '' : CONFS[tc].id, sx + 12, sy + 34, moving ? C.c : C.g, 18, 'center');
  }
  // alerts / memos area
  const y0 = 410; line(g, 10, y0 - 6, W - 10, y0 - 6, '#555', 1.5); line(g, 360, y0, 360, TOP - 8, '#555', 1.5);
  const al = S.activeAlerts || [];
  let y = y0 + 12;
  if (al.length) {
    for (const a of al.slice(0, 4)) {
      const col = a.lvl === 3 ? C.r : a.lvl === 2 ? C.a : C.a; txt(g, a.title, 16, y, col, 16, 'left', a.lvl >= 2); y += 20;
      if (a === al[0]) for (const ln of a.lines) { if (ln[2]) continue; if (y > TOP - 14) break; txt(g, '-' + ln[0] + ' '.repeat(1) + '.'.repeat(Math.max(1, 24 - ln[0].length - ln[1].length)) + ln[1], 26, y, C.c, 14); y += 18; break; }
      if (y > TOP - 14) break;
    }
    if (al.length > 4) txt(g, '\u2193', 345, TOP - 14, C.g, 16);
  } else if (S.toMemo) {
    txt(g, 'T.O', 16, y, C.w, 16, 'left', true);
    S.toMemo.forEach((m, i) => { const yy = y + i * 18; txt(g, m[0], 60, yy, C.g, 15); txt(g, m[2] ? m[1] : '.'.repeat(Math.max(2, 14 - m[0].length)) + m[1], 340, yy, m[2] ? C.g : C.c, 15, 'right'); });
  } else if (S.ldgMemo) {
    txt(g, 'LDG', 16, y, C.w, 16, 'left', true);
    S.ldgMemo.forEach((m, i) => { const yy = y + i * 18; txt(g, m[0], 60, yy, C.g, 15); txt(g, m[2] ? m[1] : '.'.repeat(Math.max(2, 14 - m[0].length)) + m[1], 340, yy, m[2] ? C.g : C.c, 15, 'right'); });
  }
  // memos on the right
  let ym = y0 + 12; for (const m of S.memos.slice(0, 6)) { txt(g, m[0], 370, ym, m[1] === 'a' ? C.a : C.g, 15); ym += 18; }
  if (S.toConfigTest > 0 && S.toCfgFaults?.length) { txt(g, 'T.O CONFIG', 16, TOP - 34, C.r, 15, 'left', true); txt(g, S.toCfgFaults[0], 16, TOP - 16, C.r, 13); }
  if (S.recall > 0) txt(g, al.length ? '' : 'NORMAL', 180, y0 + 50, C.g, 18, 'center');
  // ECL on EWD (checklist overlay, opened with C/L on ECP)
  if (S.eclOpen) drawECL(D, g, reg);
}

function drawECL(D, g, reg) {
  const S = D.sim.S; const c = S.ecl[S.eclIdx]; if (!c) return;
  g.fillStyle = 'rgba(0,0,0,.96)'; g.fillRect(0, 400, W, TOP - 400);
  txt(g, c.title, W / 2, 414, C.w, 16, 'center', true); box(g, 6, 404, W - 12, TOP - 408, C.w, 1.5);
  const done = S.eclDone[S.eclIdx]; let y = 436;
  c.items.forEach((it, i) => {
    if (y > TOP - 12) return; const ok = it[2] ? it[2](S) : done[i]; const col = ok ? C.g : C.w;
    txt(g, (ok ? '\u2713 ' : '\u25a1 ') + it[0], 14, y, col, 14); txt(g, it[1], W - 14, y, col, 14, 'right');
    reg(6, y - 9, W - 12, 18, { click: () => { if (!it[2]) done[i] = !done[i]; }, tip: 'Tick item' }); y += 18;
  });
}

// ============== SD ==============
const PAGES = ['ENG', 'APU', 'BLEED', 'COND', 'PRESS', 'ELEC', 'FUEL', 'HYD', 'WHEEL', 'F/CTL', 'DOOR', 'CRUISE', 'STS'];
export function drawSD(D, g, t, reg) {
  const sim = D.sim, S = sim.S, f = sim.fdm; const h = H - TOP;
  const page = S.sdShown;
  txt(g, page === 'ELEC' ? 'ELEC ' + S.sdElec : page, 12, 16, C.w, 18, 'left', true); line(g, 12, 28, 12 + (page.length + (page === 'ELEC' ? 3 : 0)) * 11.5, 28, C.w, 1.5);
  // page tab strip (KCCU-style direct selection on the SD)
  PAGES.forEach((p, i) => { const x = 140 + (i % 7) * 66, y = i < 7 ? 2 : 22; reg(x, y, 62, 18, { click: () => { if (p === 'ELEC' && S.sdPage === 'ELEC') S.sdElec = S.sdElec === 'AC' ? 'DC' : 'AC'; S.sdPage = S.sdPage === p && p !== 'ELEC' ? 'AUTO' : p; }, tip: 'SD page ' + p }); txt(g, p, x + 31, y + 9, p === page ? C.c : '#556070', 11, 'center'); });
  g.save(); g.translate(0, 40);
  const fn = { ENG: sdEng, APU: sdApu, BLEED: sdBleed, COND: sdCond, PRESS: sdPress, ELEC: sdElec, FUEL: sdFuel, HYD: sdHyd, WHEEL: sdWheel, 'F/CTL': sdFctl, DOOR: sdDoor, CRUISE: sdCruise, STS: sdSts }[page];
  if (fn) fn(D, g, t);
  g.restore();
  // permanent data
  const y = h - 22; line(g, 0, y - 16, W, y - 16, '#555', 1.5);
  txt(g, 'TAT', 10, y, C.w, 14); txt(g, (f.ind.tat >= 0 ? '+' : '') + Math.round(f.ind.tat) + '°C', 50, y, C.g, 15);
  txt(g, 'SAT', 10, y + 16, C.w, 14); txt(g, (f.ind.sat >= 0 ? '+' : '') + Math.round(f.ind.sat) + '°C', 50, y + 16, C.g, 15);
  const isa = Math.round(f.ind.sat - (15 - 1.98 * Math.min(36089, f.ind.palt) / 1000)); txt(g, 'ISA', 140, y, C.w, 14); txt(g, (isa >= 0 ? '+' : '') + isa + '°C', 176, y, C.g, 15);
  const u = sim.utc(); txt(g, `${String(Math.floor(u) % 24).padStart(2, '0')} H ${String(Math.floor((u % 1) * 60)).padStart(2, '0')}`, W / 2 + 20, y + 6, C.g, 18, 'center');
  txt(g, 'GW', 420, y, C.w, 14); txt(g, kg(f.mass), 560, y, C.g, 15, 'right'); txt(g, 'KG', 566, y, C.c, 12);
  txt(g, 'GWCG', 420, y + 16, C.w, 14); txt(g, f.cgMac.toFixed(1), 560, y + 16, C.g, 15, 'right'); txt(g, '%', 566, y + 16, C.c, 12);
}

function valve(g, x, y, open, ok = true, vertical = false) { g.strokeStyle = ok ? C.g : C.a; g.lineWidth = 2.5; g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.stroke(); if (open !== vertical) line(g, x, y - 11, x, y + 11, ok ? C.g : C.a, 2.5); else line(g, x - 11, y, x + 11, y, ok ? C.g : C.a, 2.5); }
function lab(g, s, x, y, col = C.w, px = 15, al = 'center') { txt(g, s, x, y, col, px, al); }

function sdEng(D, g) {
  const f = D.sim.fdm; const E = f.E;
  for (let i = 0; i < 2; i++) {
    const e = E[i], x = i ? 430 : 170;
    lab(g, 'F.USED', 300, 20); lab(g, 'KG', 300, 38, C.c, 12); lab(g, kg(e.fused || 0), x, 28, C.g, 18);
    lab(g, 'OIL', 300, 70); lab(g, 'QT', 300, 86, C.c, 12); lab(g, (e.oilQ ?? 21).toFixed(1), x, 78, C.g, 18);
    lab(g, 'PSI', 300, 120, C.c, 12); lab(g, String(Math.round(e.oilP || 0)), x, 120, (e.oilP || 0) < 13 && e.running ? C.r : C.g, 18);
    lab(g, '°C', 300, 150, C.c, 12); lab(g, String(Math.round(e.oilT || 15)), x, 150, C.g, 18);
    lab(g, 'VIB N1', 300, 182, C.w, 13); lab(g, (e.vib || 0).toFixed(1), x, 182, C.g, 17); lab(g, 'N2', 300, 202, C.w, 13); lab(g, ((e.vib || 0) * 0.8).toFixed(1), x, 202, C.g, 17); lab(g, 'N3', 300, 222, C.w, 13); lab(g, ((e.vib || 0) * 0.6).toFixed(1), x, 222, C.g, 17);
    lab(g, e.ign ? (i ? 'B' : 'A') : '', x - 60, 250, C.g, 16);
    lab(g, 'START', x, 270, C.w, 13); valve(g, x + 50, 270, !!e.starterValve, true);
    lab(g, 'NAC', 300, 270, C.w, 13); lab(g, String(Math.round(40 + e.n1 * 0.8)), x - 60, 270, C.g, 15);
  }
}
function sdApu(D, g) {
  const S = D.sim.S, a = S.apu;
  lab(g, 'APU', 300, 18, C.w, 18); if (a.avail) lab(g, 'AVAIL', 300, 40, C.g, 18);
  lab(g, 'N', 120, 80); lab(g, '%', 120, 98, C.c, 12); lab(g, String(Math.round(a.n)), 200, 88, C.g, 22);
  lab(g, 'EGT', 120, 140); lab(g, '°C', 120, 158, C.c, 12); lab(g, String(Math.round(a.egt)), 200, 148, a.egt > 900 ? C.r : C.g, 22);
  lab(g, 'FLAP', 420, 90); lab(g, a.flap >= 1 ? 'OPEN' : a.flap > 0 ? 'MOVING' : 'CLOSED', 420, 110, a.flap > 0 ? C.g : C.w, 16);
  lab(g, 'BLEED', 420, 150); lab(g, S.ov.APUBLEED && a.avail ? String(Math.round(S.bleed?.pL || 0)) + ' PSI' : 'XX', 420, 170, C.g, 16); valve(g, 480, 150, S.ov.APUBLEED && a.avail);
  lab(g, 'GEN', 120, 200); lab(g, S.ov.APUGEN && a.avail ? '115 V  400 HZ' : 'OFF', 220, 200, S.ov.APUGEN && a.avail ? C.g : C.w, 15);
  lab(g, 'FUEL PRESS', 420, 210); lab(g, a.running ? 'NORM' : 'LO', 420, 228, a.running ? C.g : C.w, 15);
  if (S.fire.apu) lab(g, 'APU FIRE', 300, 260, C.r, 20);
}
function sdBleed(D, g) {
  const S = D.sim.S, b = S.bleed || {}, f = D.sim.fdm;
  const y = 170; line(g, 60, y, 540, y, b.ductL || b.ductR ? C.g : C.a, 3);
  for (let i = 0; i < 2; i++) {
    const x = i ? 470 : 130; const on = i ? b.b2 : b.b1; valve(g, x, y + 50, on, true, true); line(g, x, y + 61, x, 260, f.E[i].running ? C.g : C.w, 2.5);
    lab(g, 'ENG ' + (i + 1), x, 280, C.w, 15); lab(g, String(Math.round(i ? b.pR || 0 : b.pL || 0)), x + 50, y + 30, C.g, 16); lab(g, 'PSI', x + 50, y + 46, C.c, 11);
    // packs
    const px = i ? 400 : 200; valve(g, px, y - 40, S.packs?.[i], true, true); lab(g, 'PACK ' + (i + 1), px, y - 70, S.packs?.[i] ? C.w : C.a, 15);
    lab(g, (S.packs?.[i] ? Math.round(S.cab.temp - 8) : '--') + '°C', px, y - 98, C.g, 15);
    // anti ice
    lab(g, 'ANTI ICE', i ? 520 : 70, y + 30, S.ai?.wai ? C.g : '#555', 12);
  }
  valve(g, 300, y, b.xb); lab(g, 'X BLEED', 300, y + 26, C.w, 12);
  valve(g, 300, y + 60, b.apu, true, true); line(g, 300, y + 71, 300, 260, S.apu.avail ? C.g : C.w, 2.5); lab(g, 'APU', 300, 280, C.w, 15);
  lab(g, 'GND', 230, 280, D.sim.S.gndAirCart ? C.g : '#555', 13);
  lab(g, 'CABIN', 300, 20, C.w, 15); lab(g, 'CKPT ' + Math.round(S.cab.ckptTemp) + '°C', 180, 44, C.g, 14); lab(g, 'CAB ' + Math.round(S.cab.temp) + '°C', 420, 44, C.g, 14);
}
function sdCond(D, g) {
  const S = D.sim.S;
  lab(g, 'TEMP °C', 520, 14, C.c, 13);
  // fuselage outline
  g.strokeStyle = C.w; g.lineWidth = 2; g.beginPath(); g.moveTo(40, 120); g.quadraticCurveTo(40, 60, 110, 60); g.lineTo(560, 60); g.lineTo(560, 180); g.lineTo(110, 180); g.quadraticCurveTo(40, 180, 40, 120); g.stroke();
  const zones = [['CKPT', 80, S.cab.ckptTemp], ['FWD', 200, S.cab.temp - 0.5], ['MID FWD', 300, S.cab.temp], ['MID AFT', 400, S.cab.temp + 0.3], ['AFT', 500, S.cab.temp + 0.6]];
  for (const [n, x, tt] of zones) { lab(g, n, x, 90, C.w, 13); lab(g, String(Math.round(tt)), x, 120, C.g, 20); lab(g, String(Math.round(18 + S.ov.CABTEMP * 12)), x, 150, C.c, 13); }
  lab(g, 'FWD CARGO', 180, 220, C.w, 13); lab(g, String(Math.round(S.cab.temp - 6)), 180, 242, C.g, 16); lab(g, 'AFT CARGO', 420, 220, C.w, 13); lab(g, String(Math.round(S.cab.temp - 5)), 420, 242, C.g, 16);
  lab(g, 'HOT AIR', 300, 270, S.ov.HOTAIR1 && S.ov.HOTAIR2 ? C.g : C.a, 13);
}
function sdPress(D, g) {
  const S = D.sim.S, c = S.cab;
  lab(g, S.ov.PRESSMODE ? 'MAN' : 'AUTO', 80, 16, C.g, 15); lab(g, 'LDG ELEVN', 220, 16, C.w, 13); lab(g, String(Math.round(S.ldgElevFt ?? 0)) + ' FT', 330, 16, C.g, 15);
  const g1 = (x, val, mn, mx, title, unit, fmt) => { const r = 60, y = 130; g.strokeStyle = C.w; g.lineWidth = 2.5; g.beginPath(); g.arc(x, y, r, Math.PI * 0.8, Math.PI * 2.2); g.stroke(); const a = Math.PI * 0.8 + clamp((val - mn) / (mx - mn), 0, 1) * Math.PI * 1.4; line(g, x, y, x + Math.cos(a) * (r + 4), y + Math.sin(a) * (r + 4), C.g, 3.5); lab(g, title, x, y + 74, C.w, 14); lab(g, fmt(val), x, y + 30, C.g, 20); lab(g, unit, x, y + 92, C.c, 11); };
  g1(110, c.deltaP, -1, 9, 'ΔP', 'PSI', (v) => v.toFixed(1)); g1(300, c.vs, -2000, 2000, 'V/S', 'FT/MIN', (v) => String(Math.round(v / 50) * 50)); g1(490, c.alt, -1000, 10000, 'CAB ALT', 'FT', (v) => String(Math.round(v / 50) * 50));
  lab(g, 'OUTFLOW', 300, 268, C.w, 13); lab(g, 'SAFETY', 480, 268, c.deltaP > 9 ? C.a : C.g, 13);
}
function sdElec(D, g) {
  const S = D.sim.S, e = S.elec || {}, ov = S.ov; const ac = S.sdElec !== 'DC';
  const gen = (x, y, name, on, avail) => { box(g, x - 40, y - 26, 80, 58, avail ? C.w : '#666', 2); lab(g, name, x, y - 12, avail ? C.w : '#777', 14); lab(g, on ? '115 V' : '', x, y + 6, C.g, 13); lab(g, on ? '400 HZ' : avail ? 'OFF' : '', x, y + 22, on ? C.g : C.w, 13); };
  if (ac) {
    const busCol = (b) => b ? C.g : C.a;
    const ab = S.acBus || {};
    [['AC 1A', 70, ab['1A']], ['AC 1B', 200, ab['1B']], ['AC ESS', 300, ab.ESS], ['AC 2B', 400, ab['2B']], ['AC 2A', 530, ab['2A']]].forEach(([n, x, on]) => { g.fillStyle = '#111'; g.fillRect(x - 46, 60, 92, 28); box(g, x - 46, 60, 92, 28, busCol(on), 2); lab(g, n, x, 74, busCol(on), 15); });
    gen(70, 190, 'GEN 1A', e.gens?.[0], D.sim.fdm.E[0].running); gen(170, 190, 'GEN 1B', e.gens?.[1], D.sim.fdm.E[0].running);
    gen(430, 190, 'GEN 2B', e.gens?.[3], D.sim.fdm.E[1].running); gen(530, 190, 'GEN 2A', e.gens?.[2], D.sim.fdm.E[1].running);
    gen(300, 190, 'APU GEN', e.apuGen, S.apu.avail);
    lab(g, 'EXT 1', 120, 268, e.extAvail ? (ov.EXT1 ? C.g : C.w) : '#555', 14); lab(g, 'EXT 2', 480, 268, e.extAvail ? (ov.EXT2 ? C.g : C.w) : '#555', 14);
    lab(g, e.extAvail ? 'AVAIL' : '', 120, 286, C.g, 12); lab(g, e.extAvail ? 'AVAIL' : '', 480, 286, C.g, 12);
    if (S.ratOut) lab(g, e.ratGen ? 'EMER GEN  RAT' : 'RAT', 300, 268, C.g, 14);
    for (const x of [70, 200, 400, 530]) line(g, x, 88, x, 160, C.g, 2);
  } else {
    const bv = e.batV || [0, 0, 0, 0];
    [['BAT 1', 80], ['BAT EMER 1', 220], ['BAT EMER 2', 380], ['BAT 2', 520]].forEach(([n, x], i) => { box(g, x - 56, 150, 112, 58, C.w, 2); lab(g, n, x, 164, C.w, 13); lab(g, bv[i] ? bv[i].toFixed(1) + ' V' : 'OFF', x, 184, bv[i] > 25 ? C.g : bv[i] ? C.a : C.w, 15); lab(g, S.acPowered && bv[i] ? 'CHARGE' : bv[i] ? 'DISCH' : '', x, 200, C.g, 12); });
    [['DC 1', 80, S.dcPowered], ['DC ESS', 300, S.essPowered], ['DC 2', 520, S.dcPowered]].forEach(([n, x, on]) => { box(g, x - 50, 60, 100, 28, on ? C.g : C.a, 2); lab(g, n, x, 74, on ? C.g : C.a, 15); });
    lab(g, 'TR 1', 140, 120, S.acPowered ? C.g : C.w, 13); lab(g, 'TR ESS', 300, 120, S.acBus?.ESS ? C.g : C.w, 13); lab(g, 'TR 2', 460, 120, S.acPowered ? C.g : C.w, 13);
  }
}
function sdFuel(D, g) {
  const f = D.sim.fdm, S = D.sim.S, ov = S.ov;
  lab(g, 'FOB', 300, 14, C.w, 14); lab(g, kg(f.fob) + ' KG', 300, 34, C.g, 20);
  g.strokeStyle = C.w; g.lineWidth = 2; g.beginPath(); g.moveTo(20, 180); g.lineTo(240, 120); g.lineTo(360, 120); g.lineTo(580, 180); g.lineTo(580, 200); g.lineTo(360, 160); g.lineTo(240, 160); g.lineTo(20, 200); g.closePath(); g.stroke();
  const tank = (x, y, n, v) => { lab(g, n, x, y - 18, C.w, 13); lab(g, kg(v), x, y, C.g, 18); };
  tank(110, 175, 'L WING', f.fuel.L); tank(300, 145, 'CTR', f.fuel.C); tank(490, 175, 'R WING', f.fuel.R);
  const pump = (x, y, on, n) => { box(g, x - 12, y - 12, 24, 24, on ? C.g : C.w, 2); if (on) line(g, x, y - 12, x, y + 12, C.g, 2); lab(g, n, x, y + 22, C.w, 10); };
  pump(160, 225, ov.FPL1, 'L1'); pump(200, 225, ov.FPL2, 'L2'); pump(280, 225, ov.FPC1, 'C1'); pump(320, 225, ov.FPC2, 'C2'); pump(400, 225, ov.FPR1, 'R1'); pump(440, 225, ov.FPR2, 'R2');
  valve(g, 300, 270, ov.XFEED1 || ov.XFEED2); lab(g, 'X FEED', 300, 294, C.w, 12);
  lab(g, 'ENG 1', 70, 260, C.w, 13); lab(g, kg(f.E[0].ff) + ' KG/H', 70, 278, C.g, 13); lab(g, 'ENG 2', 530, 260, C.w, 13); lab(g, kg(f.E[1].ff) + ' KG/H', 530, 278, C.g, 13);
  if (S.refuel) lab(g, 'REFUEL IN PROGRESS', 300, 80, C.g, 15); if (S.jettisoning) lab(g, 'JETTISON', 300, 80, C.a, 16);
  lab(g, 'FU ' + kg((f.fuelUsed || 0)), 520, 30, C.g, 13);
}
function sdHyd(D, g) {
  const S = D.sim.S, f = D.sim.fdm, ov = S.ov;
  for (const [sys, x] of [['G', 190], ['Y', 410]]) {
    const p = S.hydP[sys]; const ok = p > 2900;
    lab(g, sys === 'G' ? 'GREEN' : 'YELLOW', x, 18, ok ? C.w : C.a, 18); lab(g, String(Math.round(p / 50) * 50), x, 44, ok ? C.g : C.a, 22); lab(g, 'PSI', x + 60, 44, C.c, 12);
    line(g, x, 58, x, 200, ok ? C.g : C.a, 3);
    for (const [i, xo] of [[0, -50], [1, 50]]) { const on = ov[`${sys}ENG${i + 1}`] && f.E[i].n3 > 50; box(g, x + xo - 18, 200, 36, 30, on ? C.g : C.a, 2); lab(g, on ? '' : 'LO', x + xo, 215, C.a, 13); if (on) line(g, x + xo, 200, x + xo, 230, C.g, 2); lab(g, 'ENG ' + (i + 1), x + xo, 246, C.w, 12); line(g, x + xo, 200, x + xo, 180, C.g, 2); line(g, x + xo, 180, x, 180, C.g, 2); }
    const ep = sys === 'G' ? ov.GELEC : ov.YELEC; lab(g, 'ELEC', x, 120, C.w, 13); lab(g, ep ? 'ON' : 'OFF', x, 138, ep ? C.g : C.w, 13);
    lab(g, 'QTY', x - 60, 90, C.w, 12); lab(g, '\u25ae', x - 60, 110, C.g, 18);
  }
  lab(g, 'BRK ACCU', 300, 280, C.w, 13); lab(g, Math.round(S.brakeAccu * 100) + ' %', 300, 296, S.brakeAccu > 0.3 ? C.g : C.a, 13);
  lab(g, S.ratOut ? 'RAT' : '', 300, 120, C.g, 14);
}
function sdWheel(D, g) {
  const f = D.sim.fdm, S = D.sim.S;
  const gearCol = (p) => p > 0.98 ? C.g : p < 0.02 ? '#555' : C.r;
  const gs = (x, y, p, n) => { g.fillStyle = gearCol(p); g.beginPath(); g.moveTo(x - 14, y); g.lineTo(x + 14, y); g.lineTo(x, y + 18); g.closePath(); if (p > 0.02) g.fill(); else { g.strokeStyle = '#555'; g.stroke(); } lab(g, n, x, y - 12, C.w, 11); };
  gs(300, 40, f.gear.pos, 'NOSE'); gs(180, 140, f.gear.pos, 'LH'); gs(420, 140, f.gear.pos, 'RH');
  lab(g, f.gear.door > 0.05 ? 'DOORS' : '', 300, 90, C.a, 12);
  lab(g, 'NWS', 300, 110, S.nwsAvail ? C.g : C.a, 13); if (S.ped.towing) lab(g, 'TOWING', 300, 126, C.g, 12);
  lab(g, 'BRAKES', 300, 190, C.w, 14); lab(g, '°C', 300, 230, C.c, 12);
  const bt = f.brakeTemp || [15, 15, 15, 15];
  [[100, 0], [180, 1], [420, 2], [500, 3]].forEach(([x, i]) => { box(g, x - 26, 196, 52, 26, '#777', 1.5); lab(g, String(Math.round(bt[i] / 5) * 5), x, 209, bt[i] > 300 ? C.a : C.g, 16); lab(g, String(i + 1), x, 234, C.w, 12); });
  lab(g, S.antiSkid ? 'A/SKID' : 'A/SKID OFF', 120, 270, S.antiSkid ? C.g : C.a, 13); lab(g, f.ctrl.parkBrake ? 'PARK BRK' : '', 300, 270, C.g, 14); lab(g, S.brakeFans ? 'BRK FAN ON' : '', 480, 270, C.g, 13);
  lab(g, 'AUTO BRK ' + f.abrk.mode, 300, 290, f.abrk.mode !== 'OFF' ? C.g : '#666', 13);
  lab(g, 'TIRE PRESS PSI ' + (f.onGround ? '236' : '230'), 300, 166, C.g, 12);
}
function sdFctl(D, g) {
  const f = D.sim.fdm, S = D.sim.S, s = f.surf; const ok = S.hydP.G > 2000 || S.hydP.Y > 2000;
  const bar = (x, y, val, max, lbl) => { box(g, x - 8, y - 50, 16, 100, '#777', 1.5); const v = clamp(val / max, -1, 1); g.fillStyle = ok ? C.g : C.a; g.fillRect(x - 6, y - 2 + (v < 0 ? 0 : -v * 48), 12, Math.abs(v) * 48 + 4); lab(g, lbl, x, y + 64, C.w, 12); };
  bar(60, 110, -s.ailL / DEG, 25, 'L AIL'); bar(540, 110, -s.ailR / DEG, 25, 'R AIL');
  for (let i = 0; i < 7; i++) { const v = Math.max(s.spl, s.gndSpl, (i % 2 ? Math.max(0, s.rollSpl) : Math.max(0, -s.rollSpl))); const xL = 120 + i * 22, xR = 480 - i * 22; for (const x of [xL, xR]) { g.fillStyle = v > 0.03 ? C.g : '#333'; g.fillRect(x - 7, 60 - v * 30, 14, 6 + v * 30); g.strokeStyle = C.g; g.strokeRect(x - 7, 54, 14, 12); } }
  lab(g, 'SPLRS', 300, 40, C.w, 12);
  bar(240, 230, s.elev / DEG, 25, 'ELEV'); bar(360, 230, s.elev / DEG, 25, 'ELEV');
  lab(g, 'PITCH TRIM', 300, 150, C.w, 13); lab(g, (s.ths >= 0 ? 'UP ' : 'DN ') + Math.abs(s.ths).toFixed(1) + '°', 300, 170, C.g, 16);
  lab(g, 'RUD', 300, 210, C.w, 13); g.fillStyle = C.g; g.fillRect(300 - 3 + clamp(s.rud / DEG, -30, 30) * 2, 220, 6, 26); box(g, 240, 220, 120, 26, '#777', 1.5);
  lab(g, 'RUD TRIM ' + f.ctrl.rudTrim.toFixed(1), 300, 262, C.g, 13);
  lab(g, 'PRIM', 70, 260, C.w, 12); lab(g, [1, 2, 3].map((i) => S.ov['PRIM' + i] ? String(i) : 'X').join(' '), 70, 278, C.g, 14);
  lab(g, 'SEC', 530, 260, C.w, 12); lab(g, [1, 2, 3].map((i) => S.ov['SEC' + i] ? String(i) : 'X').join(' '), 530, 278, C.g, 14);
  lab(g, f.law + ' LAW', 300, 290, f.law === 'NORMAL' ? C.g : C.a, 13);
}
function sdDoor(D, g) {
  const S = D.sim.S;
  g.strokeStyle = C.w; g.lineWidth = 2; g.beginPath(); g.moveTo(300, 10); g.quadraticCurveTo(350, 20, 350, 70); g.lineTo(350, 260); g.quadraticCurveTo(340, 290, 300, 292); g.quadraticCurveTo(260, 290, 250, 260); g.lineTo(250, 70); g.quadraticCurveTo(250, 20, 300, 10); g.stroke();
  const d = (n, x, y, w = 14, h = 26) => { const open = S.doors[n]; g.fillStyle = open ? C.a : C.g; g.fillRect(x, y, w, h); lab(g, open ? n + (n.length > 2 ? '' : ' ') : '', x < 300 ? x - 34 : x + 50, y + h / 2, C.a, 12); };
  d('L1', 244, 50); d('R1', 342, 50); d('L2', 244, 110); d('R2', 342, 110); d('L3', 244, 170); d('R3', 342, 170); d('L4', 244, 230); d('R4', 342, 230);
  d('FWDCARGO', 330, 85, 14, 18); d('AFTCARGO', 330, 205, 14, 18); d('BULK', 330, 248, 12, 12); d('AVNCS', 293, 40, 14, 10);
  lab(g, 'CABIN', 140, 30, C.w, 13); lab(g, 'OXY ' + (S.ov.CREWO2 ? '1850' : '----') + ' PSI', 140, 270, S.ov.CREWO2 ? C.g : C.a, 13);
  lab(g, S.ped.ckptDoor ? 'CKPT DOOR LOCKED' : 'CKPT DOOR OPEN', 470, 270, S.ped.ckptDoor ? C.g : C.a, 13);
  lab(g, 'SLIDE', 140, 60, C.w, 12); lab(g, S.ov.EMEREXIT ? 'ARMED' : 'DISARMED', 140, 76, C.g, 12);
}
function sdCruise(D, g) {
  const f = D.sim.fdm, S = D.sim.S;
  lab(g, 'ENG', 60, 16, C.w, 15); lab(g, 'F.USED', 300, 40, C.w, 13); lab(g, kg(f.E[0].fused || 0), 180, 40, C.g, 16); lab(g, kg(f.E[1].fused || 0), 420, 40, C.g, 16);
  lab(g, 'OIL QT', 300, 70, C.w, 13); lab(g, '21.0', 180, 70, C.g, 16); lab(g, '21.0', 420, 70, C.g, 16);
  lab(g, 'VIB', 300, 100, C.w, 13); lab(g, (f.E[0].vib || 0).toFixed(1), 180, 100, C.g, 16); lab(g, (f.E[1].vib || 0).toFixed(1), 420, 100, C.g, 16);
  lab(g, 'AIR', 60, 140, C.w, 15); lab(g, 'CKPT', 120, 170, C.w, 13); lab(g, Math.round(S.cab.ckptTemp) + '°C', 120, 190, C.g, 15); lab(g, 'CABIN', 260, 170, C.w, 13); lab(g, Math.round(S.cab.temp) + '°C', 260, 190, C.g, 15);
  lab(g, 'ΔP', 420, 170, C.w, 13); lab(g, S.cab.deltaP.toFixed(1) + ' PSI', 420, 190, C.g, 15);
  lab(g, 'CAB V/S', 420, 220, C.w, 13); lab(g, Math.round(S.cab.vs) + ' FT/MIN', 420, 240, C.g, 15); lab(g, 'CAB ALT', 420, 260, C.w, 13); lab(g, Math.round(S.cab.alt) + ' FT', 420, 280, C.g, 15);
}
function sdSts(D, g) {
  const S = D.sim.S, f = D.sim.fdm; const st = [];
  if (f.law !== 'NORMAL') st.push(['F/CTL ' + f.law + ' LAW', C.a], ['MAX SPEED 305 KT', C.c]);
  if (!S.ov.PACK1 || !S.ov.PACK2) st.push(['PACK ' + (!S.ov.PACK1 ? '1' : '2') + ' OFF', C.a]);
  if (S.ratOut) st.push(['RAT OUT', C.g]);
  if (!S.antiSkid) st.push(['ANTI SKID OFF', C.a], ['LDG DIST AFFECTED', C.c]);
  for (const a of S.alerts || []) if (a.lvl === 1) st.push([a.title, C.a]);
  lab(g, 'STATUS', 300, 12, C.w, 16);
  if (!st.length) lab(g, 'NORMAL', 300, 120, C.g, 22);
  st.slice(0, 12).forEach(([s, col], i) => lab(g, s, 30, 40 + i * 20, col, 15, 'left'));
}
