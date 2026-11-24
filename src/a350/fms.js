// A350 FMS: navigation database (Bay Area VORs/NDBs, airports, runways, ILS), flight plan with
// departure / en-route / approach / missed approach legs, lateral guidance, descent path (VNAV),
// performance (T.O PERF, approach speeds), fuel predictions, MMR (ILS) receiver, radio navigation.
import { AIRPORTS, NAVAIDS, runwayEnd, findRunway } from '../geo.js';
import { ILS } from '../avionics.js';
import { A350, KT, FT, NM, G, speeds, vs1g, thsForCg, CONFS } from './data.js';

const D2R = Math.PI / 180;
export const angDiff = (a, b) => ((a - b + 540) % 360) - 180;
export const brg = (x0, z0, x1, z1) => (Math.atan2(x1 - x0, -(z1 - z0)) / D2R + 360) % 360;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export function navDB() {
  const out = [];
  for (const n of NAVAIDS) out.push({ ident: n.ident, name: n.name, x: n.x, z: n.z, type: n.type, freq: n.freq });
  for (const a of AIRPORTS) out.push({ ident: a.icao, name: a.name || a.icao, x: a.arp[0], z: a.arp[1], type: 'APT', elev: a.elev });
  return out;
}

export class FMS {
  constructor() {
    this.db = navDB();
    this.reset();
  }
  reset() {
    this.flightNo = 'AIB1000'; this.ci = 35; this.crzFL = 120; this.tropo = 36090;
    this.origin = null; this.dest = null; this.legs = []; this.act = 1; this.phase = 'PREFLIGHT';
    this.perf = { v1: null, vr: null, v2: null, flex: null, conf: 2, ths: null, thrRed: 1500, acc: 1500, engOut: 1500, toga: false, oat: 15 };
    this.appr = { vapp: null, vls: null, conf: 5, baro: null, radio: 100, qnh: 1013, temp: 15, windDir: 0, windKt: 0 };
    this.zfw = null; this.zfwcg = 30; this.block = null; this.reserve = 3500; this.taxiFuel = 600;
    this.tunedIls = null; this.lsAuto = true; this.vor = [{ freq: 115.8, crs: 0, ident: 'SFO', auto: true }, { freq: 116.8, crs: 0, ident: 'OAK', auto: true }];
    this.dirTo = null; this.msg = []; this.btvExit = null; this.tod = null; this.decel = null; this.predictions = [];
    this.selectedLeg = 0; this.missedActive = false;
  }

  find(ident) {
    ident = String(ident).toUpperCase().trim();
    const w = this.legs.find((l) => l.ident === ident); if (w) return { ...w };
    return this.db.find((d) => d.ident === ident) || null;
  }

  rwyEnd(icao, rwy) { const f = findRunway(icao, rwy); if (!f) return null; const e = runwayEnd(f.r, f.e); return { ...e, len: f.r.len, a: f.a, r: f.r, idx: f.e }; }

  // Build a complete flight plan (origin runway -> destination runway ILS approach + missed approach)
  build({ origin, originRwy, dest, destRwy, crzFL, flightNo, via }) {
    if (flightNo) this.flightNo = flightNo;
    if (crzFL) this.crzFL = crzFL;
    const o = this.rwyEnd(origin, originRwy), d = this.rwyEnd(dest, destRwy);
    if (!o || !d) return false;
    this.origin = { icao: origin, rwy: originRwy, elev: o.elev / FT, end: o };
    this.dest = { icao: dest, rwy: destRwy, elev: d.elev / FT, end: d };
    const legs = [];
    const rwyO = { ident: 'RW' + originRwy, x: o.x, z: o.z, kind: 'RWY', alt: { c: 'AT', ft: Math.round(o.elev / FT) } };
    legs.push(rwyO);
    // runway heading climb to a departure fix 7 nm beyond the threshold
    const oh = o.hdg * D2R, depLen = o.len + 7 * NM;
    legs.push({ ident: 'D' + originRwy.padStart(3, '0').slice(-3) + 'G', x: o.x + Math.sin(oh) * depLen, z: o.z - Math.cos(oh) * depLen, kind: 'FIX', alt: { c: 'AB', ft: 3000 }, spd: 250 });
    // approach fixes on the extended centreline
    const dh = d.hdg * D2R, back = (nm) => ({ x: d.x - Math.sin(dh) * nm * NM, z: d.z + Math.cos(dh) * nm * NM });
    const ifx = back(10), faf = back(5);
    const elev = Math.round(d.elev / FT);
    // en-route VORs roughly along the way from departure fix to the intermediate fix
    const p0 = legs[1];
    const dxL = ifx.x - p0.x, dzL = ifx.z - p0.z, L = Math.hypot(dxL, dzL) || 1;
    const cand = [];
    for (const n of this.db) {
      if (n.type !== 'VOR') continue;
      const t = ((n.x - p0.x) * dxL + (n.z - p0.z) * dzL) / (L * L); if (t < 0.15 || t > 0.85) continue;
      const off = Math.abs((n.x - p0.x) * dzL - (n.z - p0.z) * dxL) / L; if (off > 9 * NM) continue;
      cand.push({ t, n });
    }
    cand.sort((a, b) => a.t - b.t);
    // a pilot-entered route (step-3 flight plan) replaces the automatic VOR pick
    const viaPts = (via || []).map((w) => (w && w.x != null ? w : this.db.find((n) => n.ident === w))).filter(Boolean);
    if (viaPts.length) for (const n of viaPts) legs.push({ ident: n.ident, x: n.x, z: n.z, kind: n.type === 'VOR' ? 'VOR' : 'FIX', freq: n.freq });
    else for (const c of cand.slice(0, 2)) legs.push({ ident: c.n.ident, x: c.n.x, z: c.n.z, kind: 'VOR', freq: c.n.freq });
    // if the intermediate fix is behind the last en-route point (e.g. SFO 28R -> SFO 28L), add a downwind-ish point
    const pl = legs[legs.length - 1];
    const ang = Math.abs(angDiff(brg(pl.x, pl.z, ifx.x, ifx.z), d.hdg));
    if (ang > 100) {
      const side = 1; const dw = { x: ifx.x + Math.cos(dh) * 6 * NM * side, z: ifx.z + Math.sin(dh) * 6 * NM * side };
      const fwd = { x: dw.x - Math.sin(dh) * 4 * NM, z: dw.z + Math.cos(dh) * 4 * NM };
      legs.push({ ident: 'DWND' + (destRwy.length > 2 ? destRwy : destRwy), x: dw.x + Math.sin(dh) * 10 * NM, z: dw.z - Math.cos(dh) * 10 * NM, kind: 'FIX', alt: { c: 'AB', ft: 4000 } });
      legs.push({ ident: 'BASE' + destRwy, x: fwd.x, z: fwd.z, kind: 'FIX', alt: { c: 'AT', ft: 3000 }, spd: 210 });
    }
    legs.push({ ident: 'CI' + destRwy, x: ifx.x, z: ifx.z, kind: 'FIX', alt: { c: 'AT', ft: 3000 + (elev > 100 ? Math.round(elev / 100) * 100 : 0) }, spd: 190, appr: true });
    legs.push({ ident: 'FF' + destRwy, x: faf.x, z: faf.z, kind: 'FAF', alt: { c: 'AT', ft: 1600 + (elev > 100 ? Math.round(elev / 100) * 100 : 0) }, appr: true });
    legs.push({ ident: 'RW' + destRwy, x: d.x, z: d.z, kind: 'RWY', alt: { c: 'AT', ft: elev + 50 }, appr: true, dest: true });
    // missed approach: climb straight ahead to 4000 ft, then a holding fix
    const ma1 = { x: d.x + Math.sin(dh) * (d.len + 2 * NM), z: d.z - Math.cos(dh) * (d.len + 2 * NM) };
    legs.push({ ident: '(1500)', x: ma1.x, z: ma1.z, kind: 'FIX', alt: { c: 'AB', ft: 1500 }, missed: true });
    legs.push({ ident: 'MA' + destRwy, x: d.x + Math.sin(dh) * 10 * NM, z: d.z - Math.cos(dh) * 10 * NM, kind: 'FIX', alt: { c: 'AT', ft: 4000 }, missed: true });
    this.legs = legs; this.act = 1; this.missedActive = false;
    // auto-tune ILS for destination
    this.tunedIls = ILS.find((i) => i.airport.icao === dest && i.rwy === destRwy) || null;
    this.appr.qnh = 1013;
    this.computeProfile();
    this.btvExit = null;
    return true;
  }

  // distance from destination runway along the plan (nm) for every leg; descent path profile
  computeProfile() {
    const L = this.legs; if (!L.length) return;
    const destI = L.findIndex((l) => l.dest);
    if (destI < 0) return;
    const cum = new Array(L.length).fill(0);
    for (let i = destI - 1; i >= 0; i--) cum[i] = cum[i + 1] + Math.hypot(L[i + 1].x - L[i].x, L[i + 1].z - L[i].z) / NM;
    for (let i = destI + 1; i < L.length; i++) cum[i] = cum[i - 1] - Math.hypot(L[i].x - L[i - 1].x, L[i].z - L[i - 1].z) / NM;
    this.cumToDest = cum; this.destI = destI;
    // descent constraint list (distance from dest, max altitude)
    this.desCons = [];
    for (let i = 0; i <= destI; i++) { const a = L[i].alt; if (a && (a.c === 'AT' || a.c === 'BL') && i > 1) this.desCons.push({ d: cum[i], ft: a.ft }); }
    const crz = this.crzFL * 100;
    // T/D: distance where the path reaches cruise altitude
    let tod = 0; for (let d = 0; d < 400; d += 0.25) { if (this.pathAlt(d) >= crz) { tod = d; break; } tod = d; }
    this.todDist = tod;
    this.decelDist = (cum[L.findIndex((l) => l.appr)] ?? 10) + 6;
  }
  pathAlt(dNm) {
    let alt = 1e9;
    for (const c of this.desCons || []) if (c.d <= dNm + 0.01) alt = Math.min(alt, c.ft + Math.max(0, dNm - c.d) * 318 * (c.d > 1 ? 1.05 : 1));
    return Math.min(alt, this.crzFL * 100);
  }

  // distance-to-destination from present position along the remaining legs (nm)
  distToDest(pos) {
    const L = this.legs; if (!L.length || this.destI == null) return null;
    const a = Math.min(this.act, L.length - 1);
    if (a > this.destI) return 0;
    const w = L[a];
    return Math.hypot(w.x - pos[0], w.z - pos[2]) / NM + (this.cumToDest?.[a] ?? 0);
  }

  activeLeg() {
    const L = this.legs; if (!L.length || this.act >= L.length) return null;
    const to = L[this.act], from = this.dirTo && this.dirTo.idx === this.act ? this.dirTo.from : L[this.act - 1] || to;
    return { from, to };
  }

  // lateral guidance + waypoint sequencing
  update(dt, f, afs) {
    const L = this.legs; if (!L.length) { this.nav = null; return; }
    const pos = f.pos, gs = Math.max(f.ind.gs * KT, 60);
    const leg = this.activeLeg(); if (!leg) { this.nav = null; return; }
    const { from, to } = leg;
    const dtk = brg(from.x, from.z, to.x, to.z);
    const dx = to.x - from.x, dz = to.z - from.z, len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const rx = pos[0] - from.x, rz = pos[2] - from.z;
    const along = rx * ux + rz * uz;
    const xtk = rx * (-uz) - rz * (-ux); // + = right of track
    const distTo = Math.hypot(to.x - pos[0], to.z - pos[2]);
    // next leg turn anticipation
    const nxt = L[this.act + 1];
    let turn = 0, antic = 0;
    if (nxt && !(to.dest && !this.missedActive)) {
      const ntk = brg(to.x, to.z, nxt.x, nxt.z); turn = angDiff(ntk, dtk);
      const R = gs * gs / (G * Math.tan(25 * D2R));
      antic = Math.min(R * Math.tan(Math.abs(turn) * D2R / 2), 6 * NM);
    }
    const remAlong = len - along;
    const seqDue = (remAlong < Math.max(antic, 150) && !to.dest) || (to.dest && f.onGround && f.ind.gs < 40) || (remAlong < -100);
    if (seqDue && this.act < L.length - 1 && !(to.dest && !this.missedActive && !f.onGround)) {
      if (!(to.dest && !this.missedActive)) { this.act++; this.dirTo = null; this.seqT = 0; }
    }
    if (to.dest && this.missedActive && this.act <= this.destI) this.act = this.destI + 1;
    this.nav = { dtk, xtk, distTo: distTo / NM, to, from, along, len, turn, eteMin: distTo / gs / 60 };
    // predictions
    const dDest = this.distToDest(pos);
    this.dDest = dDest;
    const crz = this.crzFL * 100;
    this.tod = dDest != null && this.phase !== 'DESCENT' && this.phase !== 'APPROACH' ? dDest - this.todDist : null;
    this.updatePhase(f, afs, dDest);
  }

  updatePhase(f, afs, dDest) {
    const altFt = f.ind.alt, ph = this.phase;
    const agl = altFt - (this.origin?.elev || 0);
    if (ph === 'PREFLIGHT' && f.onGround && (f.ctrl.tla[0] > 0.8 || f.ctrl.tla[1] > 0.8) && f.ind.ias > 30) this.phase = 'TAKEOFF';
    if (ph === 'PREFLIGHT' && !f.onGround) this.phase = 'CLIMB';
    if (this.phase === 'TAKEOFF' && !f.onGround && agl > this.perf.acc) this.phase = 'CLIMB';
    if (this.phase === 'CLIMB' && Math.abs(altFt - this.crzFL * 100) < 200) this.phase = 'CRUISE';
    if ((this.phase === 'CRUISE' || this.phase === 'CLIMB') && afs.vert?.startsWith('DES') && afs.fcu.alt < altFt - 300 && afs.vert !== 'OP CLB') this.phase = 'DESCENT';
    if ((this.phase === 'CRUISE') && dDest != null && dDest < this.todDist - 0.5 && afs.fcu.alt < altFt - 300) this.phase = 'DESCENT';
    if ((this.phase === 'DESCENT' || this.phase === 'CRUISE' || this.phase === 'CLIMB') && dDest != null && dDest < this.decelDist && altFt < 10500 && !f.onGround && this.phase !== 'TAKEOFF') this.phase = 'APPROACH';
    if (this.phase === 'GO AROUND' && agl > this.perf.acc + 500 && afs.vert !== 'SRS') { /* stays until re-activation */ }
    if ((this.phase === 'APPROACH' || this.phase === 'GO AROUND') && f.onGround && f.ind.gs < 30) this.phase = 'DONE';
  }

  activateApproach() { if (this.phase !== 'PREFLIGHT' && this.phase !== 'TAKEOFF') { this.phase = 'APPROACH'; if (this.missedActive) { this.missedActive = false; const i = this.legs.findIndex((l) => l.appr); if (i > 0) this.act = i; } } }
  goAround() {
    this.phase = 'GO AROUND'; this.missedActive = true;
    if (this.destI != null) this.act = Math.max(this.act, this.destI + 1);
  }

  directTo(ident, pos) {
    const w = this.find(ident); if (!w) return false;
    let idx = this.legs.findIndex((l) => l.ident === w.ident);
    if (idx < 0) { idx = this.act; this.legs.splice(idx, 0, { ident: w.ident, x: w.x, z: w.z, kind: w.type || 'FIX', freq: w.freq }); }
    this.act = Math.max(1, idx);
    this.dirTo = { idx: this.act, from: { ident: 'T-P', x: pos[0], z: pos[2] } };
    this.computeProfile();
    return true;
  }
  insert(ident, beforeIdx) {
    const w = this.db.find((d) => d.ident === String(ident).toUpperCase()); if (!w) return false;
    const i = clamp(beforeIdx, 1, this.legs.length);
    this.legs.splice(i, 0, { ident: w.ident, x: w.x, z: w.z, kind: w.type, freq: w.freq });
    if (i <= this.act) this.act++;
    this.computeProfile(); return true;
  }
  remove(idx) {
    if (idx <= 0 || idx >= this.legs.length || this.legs[idx].dest || this.legs[idx].kind === 'RWY') return false;
    this.legs.splice(idx, 1); if (idx < this.act) this.act--; this.act = clamp(this.act, 1, this.legs.length - 1);
    this.computeProfile(); return true;
  }

  // ---- performance ----
  computeTO(f, conf = this.perf.conf, toga = this.perf.toga) {
    const m = f.mass, ci = [0, 2, 3, 4][conf] ?? 3; // CONF 1 -> 1+F
    const vs = vs1g(m, ci);
    const v2 = Math.max(Math.round(vs * 1.13 + 2), Math.round(A350.vmca * 1.1));
    const vr = Math.max(v2 - 5, A350.vmca + 3), v1 = Math.max(Math.min(vr - 2, vr), A350.vmcg + 2);
    const oat = f.ind.sat ?? 15;
    // flex temperature from runway length margin & weight (assumed temperature method, simplified)
    const tora = this.origin?.end?.len || 3000;
    const reqTOGA = 1500 + (m - 200000) / 1000 * 12 + (conf === 1 ? 200 : conf === 3 ? -150 : 0);
    const margin = tora / reqTOGA;
    const flex = toga ? null : clamp(Math.round(oat + (margin - 1) * 60), oat + 1, 72);
    const cg = f.cgMac;
    this.perf = { ...this.perf, v1: Math.round(v1), vr: Math.round(vr), v2, flex, conf, ths: +thsForCg(cg).toFixed(1), oat: Math.round(oat), toga };
    f.flexTemp = flex; f.flexDerate = flex == null ? 1 : clamp(1 - (flex - oat) * 0.0045, 0.75, 1);
    return this.perf;
  }
  computeLDG(f, conf = this.appr.conf) {
    const ldgMass = f.mass - this.tripFuel(f);
    const ci = conf === 4 ? 4 : 5;
    const vls = Math.round(vs1g(ldgMass, ci) * 1.23);
    const hw = this.appr.windKt ? Math.max(0, this.appr.windKt * Math.cos((this.appr.windDir - (this.dest?.end?.hdg ?? 0)) * D2R)) : 0;
    const vapp = Math.round(vls + clamp(Math.max(5, hw / 3), 5, 15));
    this.appr = { ...this.appr, vls, vapp, conf: ci, ldgMass: Math.round(ldgMass) };
    return this.appr;
  }
  ldgDistances(f) {
    const v = (this.appr.vapp || 145) * KT;
    const out = {};
    for (const [k, a] of Object.entries({ LO: 1.7, '2': 2.0, '3': 3.0, HI: 3.7, MAX: 4.5 })) out[k] = Math.round((v * 3 + v * v / (2 * a)) * 1.0 + 300);
    return out;
  }
  tripFuel(f) {
    const d = this.dDest ?? 50; return Math.round(d * 14 + 1200);
  }

  // managed speed target (kt CAS) / mach
  managedSpeed(f, afs) {
    const m = f.mass, sp = speeds(m, 0), altFt = f.ind.alt, ci = afs.S.confIdx();
    const v2 = this.perf.v2 || Math.round(vs1g(m, 2) * 1.13);
    const ph = this.phase;
    let spd, mach = null;
    if (ph === 'PREFLIGHT' || ph === 'TAKEOFF') spd = v2 + 10;
    else if (ph === 'CLIMB') { spd = altFt < 10000 ? 250 : 300; if (altFt > 26000) mach = 0.84; spd = Math.max(spd, Math.round(sp.gd)); if (ci > 0) spd = Math.min(spd, CONFS[ci].vfe - 5); }
    else if (ph === 'CRUISE') { spd = altFt < 10000 ? 250 : 300; if (altFt > 26000) mach = 0.85; }
    else if (ph === 'DESCENT') { spd = altFt < 11000 ? 250 : 300; if (altFt > 28000) mach = 0.84; }
    else if (ph === 'APPROACH') {
      const s = speeds(f.mass, ci);
      const vapp = this.appr.vapp || Math.round(vs1g(m, 5) * 1.23 + 5);
      spd = ci === 0 ? Math.round(s.gd) : ci === 1 ? Math.round(s.S) : ci === 2 || ci === 3 ? Math.round(s.F) : ci === 4 && this.appr.conf !== 4 ? Math.round(Math.max(vapp, s.F * 0.94)) : vapp;
      // speed constraints at approach fixes
      const to = this.nav?.to; if (to?.spd && to.appr && ci <= 1) spd = Math.min(spd + 10, Math.max(spd, to.spd));
    } else if (ph === 'GO AROUND') { spd = Math.max(this.appr.vapp || v2, Math.round(speeds(m, ci).vls + 5)); if (altFt - (this.dest?.elev || 0) > this.perf.acc) spd = ci === 0 ? Math.round(sp.gd) : Math.round(speeds(m, ci).F); }
    else spd = 250;
    return { spd: Math.round(spd), mach };
  }

  // ---- MMR: ILS receiver (deviation in dots, 2 dots = full scale) ----
  ils(f) {
    const st = this.tunedIls; if (!st) return { valid: false };
    const pos = f.pos; const altFt = pos[1] / FT;
    const dx = st.loc.x - pos[0], dz = st.loc.z - pos[2];
    const dist = Math.hypot(dx, dz);
    const b = brg(pos[0], pos[2], st.loc.x, st.loc.z);
    const off = angDiff(b, st.course); // + = aircraft left of centreline (course to the right)
    const out = { valid: false, ident: st.ident, freq: st.freq, course: st.course, gsValid: false, name: st.airport.icao + st.rwy, rwy: st.rwy, icao: st.airport.icao, elev: st.elev };
    if (dist < 25 * NM && Math.abs(off) < 35) { out.valid = true; out.locDeg = off; out.loc = clamp(off / 1.25, -2.5, 2.5); }
    const gx = st.gs.x - pos[0], gz = st.gs.z - pos[2]; const gd = Math.hypot(gx, gz);
    const elevAng = Math.atan2(altFt * FT - st.elev - 0.0, gd) / D2R;
    if (gd < 18 * NM && Math.abs(off) < 10 && gd > 30) { out.gsValid = true; out.gsDeg = elevAng - (st.gsAngle || 3); out.gs = clamp(out.gsDeg / 0.35, -2.5, 2.5); out.gsDist = gd; }
    out.dme = Math.hypot(dist, altFt * FT - st.elev) / NM;
    // xtk in metres from the extended centreline (+ = right of centreline)
    const thr = st.thr, ch = st.course * D2R; const ux = Math.sin(ch), uz = -Math.cos(ch);
    const rx = pos[0] - thr.x, rz = pos[2] - thr.z; out.xtk = rx * (-uz) + rz * ux; out.along = rx * ux + rz * uz;
    out.pathAlt = (st.elev + Math.max(0, gd) * Math.tan((st.gsAngle || 3) * D2R)) / FT;
    return out;
  }
  vorRx(i, f) {
    const v = this.vor[i]; const n = NAVAIDS.find((q) => q.type === 'VOR' && Math.abs(q.freq - v.freq) < 0.01);
    if (!n) return { valid: false, freq: v.freq };
    const d = Math.hypot(n.x - f.pos[0], n.z - f.pos[2]);
    if (d > 130 * NM) return { valid: false, freq: v.freq, ident: n.ident };
    return { valid: true, ident: n.ident, freq: v.freq, brgTo: brg(f.pos[0], f.pos[2], n.x, n.z), dme: Math.hypot(d, f.pos[1] - 10) / NM, x: n.x, z: n.z, crs: v.crs };
  }
  autoTuneVor(f) {
    // nearest VORs for each receiver when in auto
    const list = NAVAIDS.filter((n) => n.type === 'VOR').map((n) => ({ n, d: Math.hypot(n.x - f.pos[0], n.z - f.pos[2]) })).sort((a, b) => a.d - b.d);
    if (this.vor[0].auto && list[0]) { this.vor[0].freq = list[0].n.freq; this.vor[0].ident = list[0].n.ident; }
    if (this.vor[1].auto && list[1]) { this.vor[1].freq = list[1].n.freq; this.vor[1].ident = list[1].n.ident; }
  }
}
