// MFD (FMS / ATCCOM / SURV / FCU BKUP) and OIS (onboard information system: T.O PERF, LDG PERF, W&B).
import { clamp } from '../math.js';
import { FT, NM, CONFS } from './data.js';
import { C, txt, box, line } from './displays.js';

const MW = 450, MH = 600;

// editable field: amber box when empty/mandatory, cyan when entered. Click focuses; KCCU keyboard types into sim.kccu.buf.
function field(D, g, reg, side, key, x, y, w, val, commit, opts = {}) {
  const k = D.sim.kccu; const focused = k.focus && k.focus.key === key && k.focus.side === side;
  const empty = val == null || val === '';
  g.fillStyle = focused ? '#1b2533' : '#0b0f14'; g.fillRect(x, y - 13, w, 26);
  box(g, x, y - 13, w, 26, focused ? C.c : empty && opts.mand ? C.a : '#6a7480', focused ? 2 : 1.2);
  const s = focused ? k.buf + (Math.floor(performance.now() / 500) % 2 ? '_' : '') : empty ? (opts.mand ? '\u25af\u25af\u25af' : '---') : String(val);
  txt(g, s, x + w - 6, y, focused ? C.w : empty ? (opts.mand ? C.a : '#7a8490') : opts.col || C.c, 16, 'right');
  reg(x, y - 13, w, 26, { click: () => { k.focus = { side, key, commit }; k.buf = ''; }, tip: opts.tip || 'Click, type on the KCCU keyboard, ENTER' });
}
function btn(g, reg, x, y, w, h, label, onClick, opts = {}) {
  g.fillStyle = opts.on ? '#24384f' : '#1a2027'; g.fillRect(x, y, w, h); box(g, x, y, w, h, opts.on ? C.c : '#7b8794', 1.4);
  txt(g, label, x + w / 2, y + h / 2, opts.col || (opts.on ? C.c : C.w), opts.px || 14, 'center');
  reg(x, y, w, h, { click: onClick, tip: opts.tip || label });
}
const num = (s) => { const v = parseFloat(String(s).replace(',', '.')); return isFinite(v) ? v : null; };

export function drawMFD(D, g, side, t, reg) {
  const sim = D.sim; const st = sim.mfd[side];
  // top tabs
  const tabs = ['FMS', 'ATCCOM', 'SURV', 'FCU BKUP'];
  tabs.forEach((n, i) => btn(g, reg, 4 + i * 111, 4, 107, 28, n, () => { st.tab = n; sim.kccu.focus = null; }, { on: st.tab === n }));
  if (st.tab === 'FMS') {
    const pages = ['F-PLN', 'PERF', 'FUEL&LOAD', 'INIT', 'NAVAIDS'];
    pages.forEach((n, i) => btn(g, reg, 4 + i * 89, 38, 85, 24, n, () => { st.page = n; sim.kccu.focus = null; }, { on: st.page === n, px: 12 }));
    g.save(); g.translate(0, 70);
    const r2 = (x, y, w, h, hot) => reg(x, y + 70, w, h, hot);
    ({ 'F-PLN': pgFpln, PERF: pgPerf, 'FUEL&LOAD': pgFuel, INIT: pgInit, NAVAIDS: pgNavaids }[st.page] || pgFpln)(D, g, r2, side, st, t);
    g.restore();
  } else if (st.tab === 'ATCCOM') pgAtc(D, g, reg, side, st);
  else if (st.tab === 'SURV') pgSurv(D, g, reg, side, st);
  else pgFcuBkup(D, g, reg, side, st);
  // scratchpad / message line
  const k = sim.kccu, msg = sim.fms.msg?.[0];
  g.fillStyle = '#0b0f14'; g.fillRect(4, MH - 34, MW - 8, 30); box(g, 4, MH - 34, MW - 8, 30, '#555', 1);
  if (k.focus && k.focus.side === side) txt(g, k.buf || ' ', 12, MH - 19, C.w, 16);
  else if (msg) { txt(g, msg, 12, MH - 19, C.a, 14); reg(4, MH - 34, MW - 8, 30, { click: () => sim.fms.msg.shift(), tip: 'Clear message (CLR)' }); }
}

function pgFpln(D, g, reg, side, st) {
  const fms = D.sim.fms, f = D.sim.fdm; const legs = fms.legs;
  txt(g, 'ACTIVE/F-PLN', 10, 10, C.w, 14); txt(g, fms.flightNo, MW - 10, 10, C.w, 14, 'right');
  const hdr = ['FROM', 'TIME', 'SPD/ALT', 'TRK/DIST']; [10, 160, 240, 360].forEach((x, i) => txt(g, hdr[i], x, 32, '#9aa', 11));
  if (!legs.length) { txt(g, 'NO F-PLN — USE INIT PAGE', MW / 2, 140, C.a, 16, 'center'); return; }
  st.scroll = clamp(st.scroll ?? Math.max(0, fms.act - 1), 0, Math.max(0, legs.length - 12));
  let y = 52; const gsK = Math.max(250, f.ind.gs || 0);
  const now = D.sim.utc(); let cum = 0;
  for (let i = st.scroll; i < Math.min(legs.length, st.scroll + 13); i++) {
    const l = legs[i], p = legs[i - 1];
    const dist = p ? Math.hypot(l.x - p.x, l.z - p.z) / NM : 0; if (i >= fms.act) cum += i === fms.act ? (fms.nav?.distTo ?? dist) : dist;
    const trk = p ? ((Math.atan2(l.x - p.x, -(l.z - p.z)) * 180 / Math.PI + 360) % 360) : null;
    const act = i === fms.act, col = l.missed ? C.c : act ? C.w : C.g;
    if (fms.destI === i + 1 && false) {}
    if (i === st.sel) { g.fillStyle = '#1f2a38'; g.fillRect(4, y - 12, MW - 8, 24); }
    txt(g, l.ident, 10, y, col, 16); if (act) txt(g, '\u25c0', 120, y, C.w, 12);
    if (i >= fms.act) { const hr = now + cum / gsK; txt(g, `${String(Math.floor(hr) % 24).padStart(2, '0')}${String(Math.floor((hr % 1) * 60)).padStart(2, '0')}`, 160, y, C.g, 14); }
    const alt = l.alt ? (l.alt.c === 'AB' ? '+' : l.alt.c === 'BL' ? '-' : '') + (l.alt.ft >= 18000 ? 'FL' + Math.round(l.alt.ft / 100) : l.alt.ft) : '-----';
    txt(g, (l.spd ? l.spd : '---') + '/' + alt, 240, y, l.alt ? '#d27cd2' : C.g, 13);
    if (trk != null) txt(g, String(Math.round(trk)).padStart(3, '0') + '° ' + Math.round(dist), MW - 10, y, C.g, 13, 'right');
    reg(4, y - 12, MW - 8, 24, { click: () => { st.sel = st.sel === i ? null : i; }, tip: 'Select waypoint (revisions)' });
    y += 26;
    if (l.dest) { line(g, 10, y - 12, MW - 10, y - 12, '#888', 1); txt(g, '- - - - END OF F-PLN - - - -', MW / 2, y, '#888', 12, 'center'); y += 22; }
  }
  // destination summary
  const yb = MH - 70 - 120; line(g, 4, yb, MW - 4, yb, '#555', 1);
  txt(g, 'DEST', 10, yb + 16, C.w, 12); txt(g, fms.dest ? fms.dest.icao + fms.dest.rwy : '----', 10, yb + 34, C.g, 16);
  txt(g, 'DIST', 200, yb + 16, C.w, 12); txt(g, fms.dDest != null ? Math.round(fms.dDest) + ' NM' : '---', 200, yb + 34, C.g, 16);
  txt(g, 'EFOB', 330, yb + 16, C.w, 12); txt(g, ((f.fob - fms.tripFuel(f)) / 1000).toFixed(1), 330, yb + 34, C.g, 16);
  // revision buttons
  btn(g, reg, 4, yb + 50, 70, 26, '\u25b2', () => { st.scroll = (st.scroll || 0) - 3; }); btn(g, reg, 78, yb + 50, 70, 26, '\u25bc', () => { st.scroll = (st.scroll || 0) + 3; });
  const sel = st.sel != null ? legs[st.sel] : null;
  btn(g, reg, 152, yb + 50, 96, 26, 'DIR TO', () => { if (sel) { fms.directTo(sel.ident, f.pos); st.sel = null; } else D.sim.kccu.focus = { side, key: 'dirto', commit: (v) => fms.directTo(v, f.pos) || fms.msg.push('NOT IN DATABASE') }; }, { px: 12, tip: 'Direct to selected / typed waypoint' });
  btn(g, reg, 252, yb + 50, 96, 26, 'INSERT', () => { D.sim.kccu.focus = { side, key: 'ins', commit: (v) => fms.insert(v, (st.sel ?? fms.act)) || fms.msg.push('NOT IN DATABASE') }; D.sim.kccu.buf = ''; }, { px: 12, tip: 'Insert waypoint before selection' });
  btn(g, reg, 352, yb + 50, 94, 26, 'DELETE', () => { if (sel) { fms.remove(st.sel); st.sel = null; } }, { px: 12, tip: 'Delete selected waypoint' });
  btn(g, reg, 4, yb + 82, 140, 26, 'ACTIVATE APPR', () => fms.activateApproach(), { px: 11, tip: 'Activate approach phase' });
  btn(g, reg, 148, yb + 82, 150, 26, fms.missedActive ? 'MISSED ACTIVE' : 'MISSED APPR', () => fms.goAround(), { px: 11 });
  btn(g, reg, 302, yb + 82, 144, 26, 'VERT REV', () => { st.page = 'PERF'; st.perf = 'CRZ'; }, { px: 11 });
}

function pgPerf(D, g, reg, side, st) {
  const fms = D.sim.fms, f = D.sim.fdm, p = fms.perf, ap = fms.appr;
  const tabs = ['T.O', 'CLB', 'CRZ', 'DES', 'APPR', 'GA']; st.perf ||= 'T.O';
  tabs.forEach((n, i) => btn(g, reg, 4 + i * 74, 2, 70, 24, n, () => { st.perf = n; }, { on: st.perf === n, px: 12, col: fms.phase.startsWith(n === 'T.O' ? 'TAKE' : n === 'CLB' ? 'CLI' : n === 'CRZ' ? 'CRU' : n === 'DES' ? 'DESC' : n === 'APPR' ? 'APPR' : 'GO') ? C.g : undefined }));
  let y = 50;
  const row = (label, key, val, commit, mand, unit) => { txt(g, label, 14, y, C.w, 14); field(D, g, reg, side, key, 200, y, 110, val, commit, { mand }); if (unit) txt(g, unit, 318, y, C.c, 12); y += 36; };
  if (st.perf === 'T.O') {
    txt(g, 'RWY ' + (fms.origin ? fms.origin.icao + ' ' + fms.origin.rwy : '---'), 14, y, C.g, 15); txt(g, 'TORA ' + (fms.origin?.end?.len ? Math.round(fms.origin.end.len) + ' M' : '---'), MW - 14, y, C.g, 14, 'right'); y += 34;
    row('V1', 'v1', p.v1, (v) => { p.v1 = num(v); }, true, 'KT');
    row('VR', 'vr', p.vr, (v) => { p.vr = num(v); }, true, 'KT');
    row('V2', 'v2', p.v2, (v) => { p.v2 = num(v); }, true, 'KT');
    row('FLEX TO TEMP', 'flex', p.flex, (v) => { p.flex = num(v); f.flexTemp = p.flex; f.flexDerate = p.flex == null ? 1 : clamp(1 - (p.flex - (p.oat ?? 15)) * 0.0045, 0.75, 1); }, false, '°C');
    row('T.O SHIFT', 'shift', p.shift, (v) => { p.shift = num(v); }, false, 'M');
    txt(g, 'FLAPS / THS', 14, y, C.w, 14); txt(g, `${['', '1+F', '2', '3'][p.conf] || p.conf} / ${p.ths != null ? (p.ths >= 0 ? 'UP' : 'DN') + Math.abs(p.ths).toFixed(1) : '---'}`, 310, y, C.c, 16, 'right'); y += 36;
    row('THR RED', 'thrRed', p.thrRed, (v) => { p.thrRed = num(v) ?? p.thrRed; }, false, 'FT');
    row('ACCEL', 'acc', p.acc, (v) => { p.acc = num(v) ?? p.acc; }, false, 'FT');
    txt(g, 'Compute V-speeds in the OIS T.O PERF app (lower DU).', 14, y + 6, '#9aa', 12);
  } else if (st.perf === 'CLB' || st.perf === 'CRZ' || st.perf === 'DES') {
    txt(g, st.perf === 'CLB' ? 'CLIMB' : st.perf === 'CRZ' ? 'CRUISE' : 'DESCENT', 14, y, C.w, 16, 'left', true); y += 36;
    row('CRZ FL', 'crz', 'FL' + fms.crzFL, (v) => { const n = num(String(v).replace(/FL/i, '')); if (n) { fms.crzFL = n; fms.computeProfile(); } }, true);
    row('COST INDEX', 'ci', fms.ci, (v) => { fms.ci = num(v) ?? fms.ci; });
    const ms = fms.managedSpeed(f, D.sim.afs); txt(g, 'MANAGED', 14, y, C.w, 14); txt(g, (ms.mach ? '.' + Math.round(ms.mach * 100) : ms.spd) + ' KT', 310, y, '#d27cd2', 16, 'right'); y += 36;
    txt(g, 'TOD', 14, y, C.w, 14); txt(g, fms.tod != null ? Math.round(fms.tod) + ' NM TO DEST' : '---', 310, y, C.g, 15, 'right'); y += 36;
    txt(g, 'PHASE', 14, y, C.w, 14); txt(g, fms.phase, 310, y, C.g, 15, 'right'); y += 36;
    if (st.perf === 'DES') btn(g, reg, 14, y, 180, 28, 'ACTIVATE APPR', () => fms.activateApproach(), { px: 12 });
  } else if (st.perf === 'APPR') {
    txt(g, 'APPR ' + (fms.dest ? fms.dest.icao + ' ILS' + fms.dest.rwy : '---'), 14, y, C.g, 15); y += 36;
    row('QNH', 'qnh', ap.qnh, (v) => { ap.qnh = num(v) ?? ap.qnh; }, false, 'HPA');
    row('TEMP', 'atemp', ap.temp, (v) => { ap.temp = num(v) ?? ap.temp; }, false, '°C');
    row('WIND MAG', 'awdir', ap.windDir, (v) => { ap.windDir = num(v) ?? 0; }, false, '°');
    row('WIND KT', 'awkt', ap.windKt, (v) => { ap.windKt = num(v) ?? 0; }, false, 'KT');
    row('BARO MINIMUM', 'baro', ap.baro, (v) => { ap.baro = num(v); if (ap.baro != null) ap.radio = null; }, false, 'FT');
    row('RADIO MINIMUM', 'radio', ap.radio, (v) => { ap.radio = num(v); if (ap.radio != null) ap.baro = null; }, false, 'FT');
    row('VAPP', 'vapp', ap.vapp, (v) => { ap.vapp = num(v); }, true, 'KT');
    txt(g, 'VLS ' + (ap.vls ?? '---') + '   LDG CONF ' + (ap.conf === 4 ? '3' : 'FULL'), 14, y, C.g, 14);
    btn(g, reg, 300, y - 14, 140, 28, 'CONF 3 / FULL', () => { ap.conf = ap.conf === 4 ? 5 : 4; fms.computeLDG(f, ap.conf); }, { px: 11 });
  } else {
    txt(g, 'GO AROUND', 14, y, C.w, 16, 'left', true); y += 36;
    txt(g, 'THR RED', 14, y, C.w, 14); txt(g, String(p.thrRed), 310, y, C.c, 16, 'right'); y += 36;
    txt(g, 'ACCEL', 14, y, C.w, 14); txt(g, String(p.acc), 310, y, C.c, 16, 'right'); y += 36;
    txt(g, 'MISSED APPR', 14, y, C.w, 14); txt(g, fms.missedActive ? 'ACTIVE' : 'STANDBY', 310, y, fms.missedActive ? C.g : C.c, 16, 'right');
  }
}

function pgFuel(D, g, reg, side) {
  const fms = D.sim.fms, f = D.sim.fdm; let y = 30;
  txt(g, 'FUEL & LOAD', 14, y, C.w, 16, 'left', true); y += 40;
  const zfw = (f.mass - f.fob) / 1000;
  txt(g, 'GW', 14, y, C.w, 14); txt(g, (f.mass / 1000).toFixed(1) + ' T', 300, y, C.g, 16, 'right'); y += 34;
  txt(g, 'ZFW', 14, y, C.w, 14); field(D, g, reg, side, 'zfw', 200, y, 110, fms.zfw ?? zfw.toFixed(1), (v) => { const n = num(v); if (n) { fms.zfw = n; f.payload = clamp(n * 1000 - (f.mass - f.fob - f.payload), 0, 68000); } }, { mand: fms.zfw == null }); y += 34;
  txt(g, 'ZFWCG', 14, y, C.w, 14); field(D, g, reg, side, 'zfwcg', 200, y, 110, f.cgMac.toFixed(1), (v) => { const n = num(v); if (n) f.cgMac = clamp(n, 18, 42); }); txt(g, '%', 318, y, C.c, 12); y += 34;
  txt(g, 'BLOCK', 14, y, C.w, 14); txt(g, (f.fob / 1000).toFixed(1) + ' T', 300, y, C.g, 16, 'right'); y += 34;
  txt(g, 'TAXI', 14, y, C.w, 14); txt(g, (fms.taxiFuel / 1000).toFixed(1), 300, y, C.c, 16, 'right'); y += 34;
  txt(g, 'TRIP', 14, y, C.w, 14); txt(g, (fms.tripFuel(f) / 1000).toFixed(1), 300, y, C.g, 16, 'right'); y += 34;
  txt(g, 'FINAL/RSV', 14, y, C.w, 14); field(D, g, reg, side, 'rsv', 200, y, 110, (fms.reserve / 1000).toFixed(1), (v) => { const n = num(v); if (n != null) fms.reserve = n * 1000; }); y += 34;
  const efob = f.fob - fms.tripFuel(f) - fms.taxiFuel;
  txt(g, 'EFOB AT DEST', 14, y, C.w, 14); txt(g, (efob / 1000).toFixed(1), 300, y, efob < fms.reserve ? C.a : C.g, 16, 'right'); y += 34;
  txt(g, 'TOW', 14, y, C.w, 14); txt(g, ((f.mass - fms.taxiFuel) / 1000).toFixed(1), 300, y, C.g, 16, 'right'); y += 34;
  txt(g, 'MTOW 322.0 T   MLW 236.0 T   MZFW 223.0 T', 14, y + 10, '#9aa', 12);
}

function pgInit(D, g, reg, side) {
  const sim = D.sim, fms = sim.fms; let y = 30;
  txt(g, 'INIT', 14, y, C.w, 16, 'left', true); y += 40;
  txt(g, 'FLT NBR', 14, y, C.w, 14); field(D, g, reg, side, 'fltnbr', 200, y, 150, fms.flightNo, (v) => { fms.flightNo = String(v).toUpperCase().slice(0, 8); if (sim.atc) sim.atc.callsign = fms.flightNo; }); y += 36;
  const o = sim.mfdInit || (sim.mfdInit = { origin: fms.origin?.icao || '', orwy: fms.origin?.rwy || '', dest: fms.dest?.icao || '', drwy: fms.dest?.rwy || '' });
  txt(g, 'FROM', 14, y, C.w, 14); field(D, g, reg, side, 'from', 200, y, 90, o.origin, (v) => { o.origin = String(v).toUpperCase(); }, { mand: !o.origin }); field(D, g, reg, side, 'orwy', 300, y, 60, o.orwy, (v) => { o.orwy = String(v).toUpperCase(); }, { mand: !o.orwy, tip: 'Departure runway' }); y += 36;
  txt(g, 'TO', 14, y, C.w, 14); field(D, g, reg, side, 'to', 200, y, 90, o.dest, (v) => { o.dest = String(v).toUpperCase(); }, { mand: !o.dest }); field(D, g, reg, side, 'drwy', 300, y, 60, o.drwy, (v) => { o.drwy = String(v).toUpperCase(); }, { mand: !o.drwy, tip: 'Arrival runway' }); y += 36;
  txt(g, 'CRZ FL', 14, y, C.w, 14); field(D, g, reg, side, 'icrz', 200, y, 90, fms.crzFL, (v) => { const n = num(String(v).replace(/FL/i, '')); if (n) fms.crzFL = n; }); y += 36;
  txt(g, 'CI', 14, y, C.w, 14); field(D, g, reg, side, 'ici', 200, y, 90, fms.ci, (v) => { fms.ci = num(v) ?? fms.ci; }); y += 36;
  txt(g, 'TROPO', 14, y, C.w, 14); txt(g, String(fms.tropo), 290, y, C.c, 16, 'right'); y += 40;
  btn(g, reg, 14, y, 200, 30, 'BUILD F-PLN', () => { const ok = fms.build({ origin: o.origin, originRwy: o.orwy, dest: o.dest, destRwy: o.drwy, crzFL: fms.crzFL }); if (!ok) fms.msg.push('NOT IN DATABASE'); else { sim.mfd[side].page = 'F-PLN'; sim.onFplnBuilt?.(); } }, { tip: 'Build route origin runway → ILS approach at destination' });
  btn(g, reg, 224, y, 210, 30, 'IRS ALIGN: ' + (sim.S.fastAlign ? 'FAST' : 'REAL'), () => { sim.S.fastAlign = !sim.S.fastAlign; }, { px: 12 }); y += 44;
  const ir = sim.S.ir.map((r, i) => `IR${i + 1} ${r.state}${r.state === 'NAV' && r.align < 1 ? ' ' + Math.round(r.align * 100) + '%' : ''}`).join('   ');
  txt(g, ir, 14, y, C.g, 13);
  txt(g, 'Airports: KSFO KOAK KSJC KHAF KPAO KSQL KHWD KLVK KCCR', 14, y + 30, '#9aa', 11);
}

function pgNavaids(D, g, reg, side) {
  const fms = D.sim.fms, f = D.sim.fdm; let y = 30;
  txt(g, 'NAVAIDS', 14, y, C.w, 16, 'left', true); y += 40;
  for (let i = 0; i < 2; i++) {
    const v = fms.vor[i]; txt(g, 'VOR' + (i + 1), 14, y, C.w, 14);
    field(D, g, reg, side, 'vor' + i, 120, y, 90, v.freq.toFixed(2), (s) => { const n = num(s); if (n) { v.freq = n; v.auto = false; } });
    txt(g, v.ident || '', 230, y, C.g, 15); field(D, g, reg, side, 'crs' + i, 300, y, 70, v.crs, (s) => { const n = num(s); if (n != null) v.crs = (Math.round(n) + 360) % 360; }, { tip: 'VOR course' });
    txt(g, v.auto ? 'AUTO' : 'MAN', MW - 10, y, v.auto ? C.g : C.c, 12, 'right'); y += 36;
  }
  const ils = fms.ils(f);
  txt(g, 'LS', 14, y, C.w, 14); field(D, g, reg, side, 'ils', 120, y, 90, fms.tunedIls ? fms.tunedIls.freq.toFixed(2) : null, (s) => { fms.setIlsFreq?.(num(s)); fms.lsAuto = false; });
  txt(g, ils?.ident || '', 230, y, C.g, 15); txt(g, ils ? String(Math.round(ils.course)).padStart(3, '0') + '°' : '', 340, y, C.g, 15); txt(g, fms.lsAuto ? 'AUTO' : 'MAN', MW - 10, y, fms.lsAuto ? C.g : C.c, 12, 'right'); y += 40;
  btn(g, reg, 14, y, 200, 28, 'RESET AUTO TUNE', () => { fms.vor.forEach((v) => { v.auto = true; }); fms.lsAuto = true; }, { px: 12 }); y += 48;
  txt(g, 'GPS PRIMARY', 14, y, C.g, 15); y += 24; txt(g, 'ACCURACY HIGH   RNP 1.00 / EPU 0.05', 14, y, C.g, 13);
}

function pgAtc(D, g, reg, side, st) {
  const sim = D.sim; let y = 60;
  txt(g, 'ATC COM — CPDLC', 14, y, C.w, 16, 'left', true); y += 30;
  txt(g, sim.atc?.enabled === false ? 'ATC DISABLED' : 'CONNECTED: NORCAL', 14, y, sim.atc?.enabled === false ? C.a : C.g, 14); y += 30;
  const msgs = sim.atcLog || []; for (const m of msgs.slice(-12)) { txt(g, m.slice(0, 54), 14, y, C.c, 12); y += 18; }
  btn(g, reg, 14, MH - 80, 200, 30, 'OPEN ATC PANEL', () => sim.openAtc?.(), { px: 12, tip: 'Open the ATC radio panel (also key T)' });
  void st;
}

function pgSurv(D, g, reg, side) {
  const p = D.sim.S.ped; let y = 60;
  txt(g, 'SURV CONTROLS', 14, y, C.w, 16, 'left', true); y += 44;
  txt(g, 'XPDR', 14, y, C.w, 14); field(D, g, reg, side, 'sqk', 160, y, 90, p.squawk, (v) => { if (/^[0-7]{4}$/.test(v)) p.squawk = v; else D.sim.fms.msg.push('FORMAT ERROR'); }); y += 38;
  const tog = (label, cur, opts, set) => { txt(g, label, 14, y, C.w, 14); opts.forEach((o, i) => btn(g, reg, 160 + i * 94, y - 14, 90, 28, o, () => set(i), { on: cur === i, px: 12 })); y += 40; };
  tog('XPDR MODE', p.xpdr, ['STBY', 'AUTO', 'ON'], (i) => { p.xpdr = i; });
  tog('TCAS', p.tcas, ['STBY', 'TA ONLY', 'TA/RA'], (i) => { p.tcas = i; });
  tog('WXR', p.wxr ? 1 : 0, ['OFF', 'AUTO'], (i) => { p.wxr = !!i; });
  tog('TERR SYS', p.terr ? 1 : 0, ['OFF', 'ON'], (i) => { p.terr = !!i; });
  tog('GPWS', p.gpws ? 1 : 0, ['OFF', 'ON'], (i) => { p.gpws = !!i; });
  tog('G/S MODE', p.gsMode ? 1 : 0, ['OFF', 'ON'], (i) => { p.gsMode = !!i; });
  tog('FLAP MODE', p.flapMode ? 1 : 0, ['OFF', 'ON'], (i) => { p.flapMode = !!i; });
  btn(g, reg, 14, y, 200, 30, 'ALT RPTG ' + (p.altRptg === false ? 'OFF' : 'ON'), () => { p.altRptg = p.altRptg === false; }, { px: 12 });
}

function pgFcuBkup(D, g, reg, side) {
  const a = D.sim.afs; let y = 70;
  txt(g, 'FCU BACKUP', 14, y, C.w, 16, 'left', true); y += 44;
  const rowK = (label, val, dec, inc, push, pull) => {
    txt(g, label, 14, y, C.w, 14); txt(g, val, 200, y, C.c, 18, 'right');
    btn(g, reg, 210, y - 14, 50, 28, '\u2212', dec); btn(g, reg, 264, y - 14, 50, 28, '+', inc);
    btn(g, reg, 318, y - 14, 60, 28, 'PUSH', push, { px: 11 }); btn(g, reg, 382, y - 14, 60, 28, 'PULL', pull, { px: 11 }); y += 44;
  };
  rowK('SPD', a.fcu.spdManaged ? '---\u2022' : a.fcu.machMode ? '.' + Math.round(a.fcu.mach * 100) : String(a.fcu.spd), () => a.spdTurn(-1), () => a.spdTurn(1), () => a.spdPush(), () => a.spdPull());
  rowK(a.fcu.trkFpa ? 'TRK' : 'HDG', a.fcu.hdgManaged ? '---\u2022' : String(a.fcu.hdg).padStart(3, '0'), () => a.hdgTurn(-1), () => a.hdgTurn(1), () => a.hdgPush(), () => a.hdgPull());
  rowK('ALT', String(a.fcu.alt), () => a.altTurn(-1), () => a.altTurn(1), () => a.altPush(), () => a.altPull());
  rowK(a.fcu.trkFpa ? 'FPA' : 'V/S', a.fcu.trkFpa ? a.fcu.fpa.toFixed(1) : String(a.fcu.vs), () => a.vsTurn(-1), () => a.vsTurn(1), () => a.vsPush(), () => a.vsPull());
  btn(g, reg, 14, y, 100, 30, 'AP1', () => a.apPb(0), { on: a.ap?.[0] }); btn(g, reg, 118, y, 100, 30, 'AP2', () => a.apPb(1), { on: a.ap?.[1] });
  btn(g, reg, 222, y, 100, 30, 'A/THR', () => a.athrPb(), { on: a.athr.armed || a.athr.active }); btn(g, reg, 326, y, 116, 30, 'LOC', () => a.locPb()); y += 40;
  btn(g, reg, 14, y, 100, 30, 'APPR', () => a.apprPb()); btn(g, reg, 118, y, 100, 30, 'EXPED', () => a.expedPb()); btn(g, reg, 222, y, 120, 30, 'TRK-FPA', () => a.trkFpaPb());
}

// ============== OIS ==============
export function drawOIS(D, g, side, t, reg) {
  const sim = D.sim, fms = sim.fms, f = sim.fdm; const st = sim.ois[side]; const OW = 600;
  const apps = ['T.O PERF', 'LDG PERF', 'W&B', 'FLT OPS'];
  apps.forEach((n, i) => btn(g, reg, 4 + i * 149, 4, 145, 28, n, () => { st.app = n; }, { on: st.app === n, px: 13 }));
  let y = 60;
  if (st.app === 'T.O PERF') {
    const p = fms.perf;
    txt(g, 'RWY', 14, y, C.w, 14); txt(g, fms.origin ? fms.origin.icao + ' ' + fms.origin.rwy + '  ' + Math.round(fms.origin.end.len) + ' M' : 'NO F-PLN', 100, y, C.g, 15); y += 32;
    txt(g, 'CONF', 14, y, C.w, 14); ['1+F', '2', '3'].forEach((c, i) => btn(g, reg, 100 + i * 70, y - 14, 64, 28, c, () => { p.conf = i + 1; }, { on: p.conf === i + 1, px: 12 }));
    txt(g, 'THRUST', 330, y, C.w, 14); btn(g, reg, 400, y - 14, 80, 28, 'FLEX', () => { p.toga = false; }, { on: !p.toga, px: 12 }); btn(g, reg, 484, y - 14, 80, 28, 'TOGA', () => { p.toga = true; }, { on: p.toga, px: 12 }); y += 36;
    txt(g, 'TOW ' + (f.mass / 1000).toFixed(1) + ' T   CG ' + f.cgMac.toFixed(1) + '%   OAT ' + Math.round(f.ind.sat) + '°C', 14, y, C.g, 14); y += 32;
    btn(g, reg, 14, y, 160, 32, 'COMPUTE', () => { fms.computeTO(f, p.conf, p.toga); st.computed = true; sim.emit?.('click'); }, { tip: 'Compute takeoff performance' });
    btn(g, reg, 184, y, 220, 32, 'SEND TO FMS', () => { if (!st.computed) fms.computeTO(f, p.conf, p.toga); st.sent = true; sim.toast?.('T.O data sent to FMS'); }, { tip: 'Transfer V-speeds, FLEX and THS to the FMS' }); y += 52;
    if (st.computed || p.v1) {
      const cells = [['V1', p.v1], ['VR', p.vr], ['V2', p.v2], ['FLEX', p.flex != null ? p.flex + '°C' : 'TOGA'], ['THS', p.ths != null ? (p.ths >= 0 ? 'UP' : 'DN') + Math.abs(p.ths).toFixed(1) : '--'], ['CONF', ['', '1+F', '2', '3'][p.conf]]];
      cells.forEach(([k, v], i) => { const x = 14 + (i % 3) * 190, yy = y + Math.floor(i / 3) * 56; box(g, x, yy, 180, 48, '#555', 1); txt(g, k, x + 10, yy + 14, C.w, 13); txt(g, String(v ?? '--'), x + 170, yy + 32, C.g, 22, 'right'); });
    }
  } else if (st.app === 'LDG PERF') {
    const a = fms.appr;
    txt(g, 'RWY', 14, y, C.w, 14); txt(g, fms.dest ? fms.dest.icao + ' ' + fms.dest.rwy + '  ' + Math.round(fms.dest.end.len) + ' M' : 'NO F-PLN', 100, y, C.g, 15); y += 32;
    txt(g, 'CONF', 14, y, C.w, 14); [['3', 4], ['FULL', 5]].forEach(([c, v], i) => btn(g, reg, 100 + i * 80, y - 14, 74, 28, c, () => { a.conf = v; }, { on: a.conf === v, px: 12 })); y += 36;
    btn(g, reg, 14, y, 160, 32, 'COMPUTE', () => { fms.computeLDG(f, a.conf); st.ldg = fms.ldgDistances(f); }); y += 52;
    if (a.vapp) {
      txt(g, 'LW ' + ((a.ldgMass || f.mass) / 1000).toFixed(1) + ' T   VLS ' + a.vls + '   VAPP ' + a.vapp, 14, y, C.g, 16); y += 32;
      const d = st.ldg || fms.ldgDistances(f); const L = fms.dest?.end?.len || 3000;
      txt(g, 'AUTOBRAKE  ACTUAL LDG DIST', 14, y, C.w, 13); y += 22;
      for (const [k, v] of Object.entries(d)) { const w = clamp(v / L, 0, 1) * 300; g.fillStyle = v > L ? C.a : C.g; g.fillRect(150, y - 8, w, 14); txt(g, k, 14, y, C.w, 14); txt(g, v + ' M', 560, y, v > L ? C.a : C.g, 14, 'right'); y += 22; }
      txt(g, 'BTV: arm via AUTO BRK BTV, select exit on OANS', 14, y + 10, '#9aa', 12);
    }
  } else if (st.app === 'W&B') {
    const rows = [['DOW', (f.mass - f.fob - f.payload) / 1000], ['PAYLOAD', f.payload / 1000], ['ZFW', (f.mass - f.fob) / 1000], ['FOB', f.fob / 1000], ['GW', f.mass / 1000]];
    for (const [k, v] of rows) { txt(g, k, 14, y, C.w, 15); txt(g, v.toFixed(1) + ' T', 300, y, C.g, 16, 'right'); y += 30; }
    txt(g, 'CG', 14, y, C.w, 15); txt(g, f.cgMac.toFixed(1) + ' %MAC', 300, y, C.g, 16, 'right'); y += 40;
    btn(g, reg, 14, y, 120, 30, 'PAX \u2212', () => { f.payload = clamp(f.payload - 5000, 0, 68000); }); btn(g, reg, 140, y, 120, 30, 'PAX +', () => { f.payload = clamp(f.payload + 5000, 0, 68000); });
    btn(g, reg, 280, y, 140, 30, 'CG FWD', () => { f.cgMac = clamp(f.cgMac - 1, 18, 42); }); btn(g, reg, 426, y, 140, 30, 'CG AFT', () => { f.cgMac = clamp(f.cgMac + 1, 18, 42); });
    // envelope sketch
    const ex = 380, ey = 60; box(g, ex, ey, 200, 150, '#555', 1); txt(g, 'CG ENVELOPE', ex + 100, ey + 10, C.w, 11, 'center');
    const px = ex + (f.cgMac - 18) / 24 * 200, py = ey + 150 - clamp((f.mass - 150000) / 172000, 0, 1) * 140; g.fillStyle = C.g; g.beginPath(); g.arc(px, py, 5, 0, Math.PI * 2); g.fill();
  } else {
    const a = sim.fdm; txt(g, 'FLIGHT OPS / DOCS', 14, y, C.w, 16, 'left', true); y += 34;
    for (const s of ['A350-1000  Trent XWB-97  97,000 lbf', 'MTOW 322 t   MLW 236 t   MMO 0.89   VMO 340', 'VLE 250   VFE 1 255  1+F 220  2 212  3 195  FULL 186', 'Length 73.78 m   Span 64.75 m   Wing 464.3 m²', 'Normal ops: C/L on ECP opens the ECL', 'Abnormal: follow ECAM actions, CLR to clear', 'Brake temp limit for takeoff: 300 °C']) { txt(g, s, 14, y, C.g, 13); y += 22; }
    void a;
  }
  void OW; void CONFS; void FT;
}
