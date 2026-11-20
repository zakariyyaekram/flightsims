// Nav receivers (VOR / LOC / GS / DME), KAP 140-style two-axis autopilot.
import { AIRPORTS, NAVAIDS, fromLocal, runwayEnd } from './geo.js';

const angDiff = (a, b) => ((a - b + 540) % 360) - 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const NM = 1852;

// Build ILS stations from airport definitions
export const ILS = [];
for (const a of AIRPORTS) for (const r of a.runways || []) for (const il of r.ilsList || []) {
  const e = runwayEnd(r, il.end), sgn = il.end === 0 ? 1 : -1; // sgn: landing direction along +u
  const loc = fromLocal(r, sgn * (r.len / 2 + 300), 0);
  const tu = e.ext + sgn * (r.disp[il.end] || 0);
  const gs = fromLocal(r, tu + sgn * 300, sgn * 120);
  ILS.push({ type: 'ILS', ident: il.ident, freq: il.freq, gsAngle: il.gs || 3, course: e.hdg, loc, gs, thr: { x: e.x, z: e.z }, elev: e.elev, airport: a, runway: r, rwy: e.id });
}

export function findStation(freq) {
  const f = Math.round(freq * 100);
  for (const n of NAVAIDS) if (n.type === 'VOR' && Math.round(n.freq * 100) === f) return { ...n, kind: 'VOR' };
  for (const i of ILS) if (Math.round(i.freq * 100) === f) return { ...i, kind: 'ILS' };
  return null;
}

export class Avionics {
  constructor() {
    this.nav1 = { active: 110.3, standby: 113.4, obs: 270 };
    this.nav2 = { active: 113.4, standby: 116.8, obs: 90 };
    this.com1 = { active: 122.8, standby: 121.5, on: true, vol: 0.8, sq: false };
    this.com2 = { active: 121.9, standby: 118.0, on: true, vol: 0.8, sq: false };
    this.nav1.on = this.nav2.on = true;
    this.xpdr = { code: '1200', mode: 'ALT', ident: 0, entry: '', prev: '1200', entryT: 0 };
    // KMA 26 audio panel: mic selector 1..4 (COM1, COM2, COM3, TEL) and receive selections
    this.audio = { on: true, vol: 0.8, mic: 1, mkrSens: 'HI', rx: { COM1: true, COM2: false, COM3: false, NAV1: false, NAV2: false, DME: false, ADF: false, MKR: true, SPKR: true } };
    this.aiBias = 0; this.adfCard = 0;
    this.hdgBug = 270;
    this.ap = { on: false, lat: 'ROL', vert: 'VS', vsSel: 0, altSel: 3000, gsArmed: false, locArmed: false, iBank: 0, iPitch: 0, trimTimer: 0 };
    this.r1 = {}; this.r2 = {};
    // Bendix/King KLN 94 GPS (172S only). src = CDI 1 source selected by the NAV/GPS switch.
    this.gps = { on: true, bright: 0.8, test: 3, page: 'NAV', prev: 'NAV', mode: 'LEG', range: 10, declutter: false, cursor: false, sel: 0, dtoSel: 0,
      wpt: null, origin: null, src: 'NAV', baro: 29.92, msgs: [], arrived: false, fpl: [], fplActive: false, leg: 0, fplSel: 0 };
    this.gpsR = { valid: false }; this.cdi1 = {};
    this.adf = { freq: 344, standby: 362, on: true, vol: 0.7, mode: 'ADF', bfo: false, timer: 'FLT', flt: 0, et: 0 };
  }

  receive(rx, pos, altFt) {
    const st = findStation(rx.active);
    const out = { valid: false, toFrom: 0, dev: 0, gsValid: false, gsDev: 0, dme: null, ident: '', kind: st?.kind };
    if (!st) return out;
    if (st.kind === 'VOR') {
      const dx = st.x - pos[0], dz = st.z - pos[2];
      const dist = Math.hypot(dx, dz);
      if (dist > 70 * NM) return out;
      const brgTo = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
      const radial = (brgTo + 180) % 360;
      const to = Math.abs(angDiff(rx.obs, brgTo)) < 90;
      let dev = to ? angDiff(brgTo, rx.obs) : angDiff(rx.obs, radial);
      dev = -dev; // positive deviation = course to the right... normalized below
      out.valid = dist > 150; out.toFrom = to ? 1 : -1;
      out.dev = clamp(-dev / 10, -1, 1); // full scale 10 deg
      out.dme = Math.hypot(dist, (altFt * 0.3048 - 300)) / NM;
      out.radial = radial; out.ident = st.ident; out.name = st.name;
      return out;
    }
    // localizer
    const dx = st.loc.x - pos[0], dz = st.loc.z - pos[2];
    const dist = Math.hypot(dx, dz);
    const brgTo = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
    const off = angDiff(brgTo, st.course);
    if (dist < 20 * NM && Math.abs(off) < 35) {
      out.valid = true;
      out.dev = clamp(off / 2.5, -1, 1);
      out.toFrom = 1;
    }
    // glideslope
    const gx = st.gs.x - pos[0], gz = st.gs.z - pos[2];
    const gd = Math.hypot(gx, gz);
    const elevAng = Math.atan2(altFt * 0.3048 - st.elev, gd) * 180 / Math.PI;
    if (gd < 12 * NM && Math.abs(off) < 10 && gd > 50) {
      out.gsValid = true;
      out.gsDev = clamp((elevAng - (st.gsAngle || 3)) / 0.7, -1, 1); // + = above glidepath
    }
    out.dme = Math.hypot(dist, altFt * 0.3048 - st.elev) / NM;
    out.ident = st.ident; out.course = st.course; out.name = `${st.airport.icao} ILS ${st.rwy}`;
    return out;
  }

  // radio the pilot transmits on (audio panel MIC selector)
  micRadio() { return this.audio.mic === 2 ? this.com2 : this.com1; }
  // is COM n receiving/transmitting? (needs bus power, breaker and the radio's own power knob)
  comPowered(f, n) { const E = f.eff || {}; const c = n === 2 ? this.com2 : this.com1; return !!(n === 2 ? E.com2 : E.com1) && c.on !== false && (E.audio === undefined || (E.audio && this.audio.on !== false)); }

  update(f, dt, powered) {
    const pos = f.pos;
    const altFt = pos[1] / 0.3048;
    const P = typeof powered === 'object' ? powered : { nav1: powered, nav2: powered, ap: powered, adf: powered };
    this.r1 = P.nav1 ? this.receive(this.nav1, pos, altFt) : { valid: false };
    this.r2 = P.nav2 ? this.receive(this.nav2, pos, altFt) : { valid: false };
    this.gpsUpdate(f, dt, !!P.gps);
    this.cdi1 = this.gps.src === 'GPS' && P.gps !== undefined ? this.gpsR : this.r1;
    if (!P.ap && this.ap.on) this.disconnect(true);
    // KR 87 flight timer runs while powered; elapsed timer always counts up when powered
    if (P.adf && this.adf.on !== false) { this.adf.flt += dt; this.adf.et += dt; }
    return this.autopilot(f, dt);
  }

  // ---- KLN 94 GPS
  // waypoint database: airports and VORs, sorted by distance from pos
  gpsWaypoints(pos) {
    const all = [...AIRPORTS.map((a) => ({ ident: a.icao, name: a.name, x: a.x, z: a.z, type: 'APT', elev: a.elev })), ...NAVAIDS.filter((n) => n.type === 'VOR').map((n) => ({ ident: n.ident, name: n.name, x: n.x, z: n.z, type: 'VOR', freq: n.freq }))];
    for (const w of all) { const dx = w.x - pos[0], dz = w.z - pos[2]; w.dist = Math.hypot(dx, dz) / NM; w.brg = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360; }
    return all.sort((a, b) => a.dist - b.dist);
  }
  gpsMsg(m) { const g = this.gps; if (!g.msgs.includes(m)) g.msgs.push(m); g.msgNew = true; }
  gpsUpdate(f, dt, powered) {
    const g = this.gps;
    if (!powered || !g.on) { this.gpsR = { valid: false, kind: 'GPS' }; g.test = 3; g.ok = false; return; }
    g.ok = true;
    if (g.test > 0) { g.test -= dt; if (g.test <= 0 && !g.wpt) g.page = 'NAV'; }
    const pos = f.pos;
    g.gs = Math.hypot(f.vel[0], f.vel[2]) / 0.5144;
    g.trk = g.gs > 2 ? (Math.atan2(f.vel[0], -f.vel[2]) * 180 / Math.PI + 360) % 360 : null;
    g.list = this.gpsWaypoints(pos);
    g.nrst = g.list.filter((w) => w.type === 'APT').slice(0, 9);
    const w = g.wpt;
    if (!w || g.test > 0) { this.gpsR = { valid: false, kind: 'GPS' }; g.nav = null; return; }
    const dx = w.x - pos[0], dz = w.z - pos[2], dist = Math.hypot(dx, dz) / NM, brg = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
    // course line: LEG = origin -> waypoint, OBS = selected OBS course through the waypoint
    const o = g.origin || { x: pos[0], z: pos[2] };
    const dtk = g.mode === 'OBS' ? this.nav1.obs : (Math.atan2(w.x - o.x, -(w.z - o.z)) * 180 / Math.PI + 360) % 360;
    const c = dtk * Math.PI / 180, ux = Math.sin(c), uz = -Math.cos(c);
    const xtk = ((pos[0] - w.x) * -uz + (pos[2] - w.z) * ux) / NM; // + = right of course
    const toFrom = Math.abs(angDiff(dtk, brg)) < 90 ? 1 : -1;
    const fs = dist < 30 && w.type === 'APT' ? 1 : 5; // TERM (1 NM) / ENR (5 NM) CDI scaling
    const ete = g.gs > 20 ? dist / g.gs * 3600 : null;
    g.nav = { ident: w.ident, dist, brg, dtk, xtk, toFrom, fs, ete, scale: fs === 1 ? 'TERM' : 'ENR' };
    // flight plan: sequence to the next leg when the waypoint is passed (or within 0.3 NM)
    if (g.fplActive && g.leg < g.fpl.length - 1 && g.mode === 'LEG' && (dist < 0.3 || (toFrom < 0 && dist < 2))) {
      g.leg++; g.origin = { x: w.x, z: w.z }; g.wpt = { ...g.fpl[g.leg] }; g.arrived = false; return this.gpsUpdate(f, 0, powered);
    }
    const last = !g.fplActive || g.leg >= g.fpl.length - 1;
    if (last && ete != null && ete < 36 && toFrom > 0 && !g.arrived) { g.arrived = true; this.gpsMsg('ARRIVAL AT ' + w.ident); }
    g.wptAlert = ete != null && ete < 36 && toFrom > 0;
    this.gpsR = { valid: true, kind: 'GPS', dev: clamp(-xtk / fs, -1, 1), toFrom, course: dtk, ident: w.ident, dme: dist, gsValid: false };
  }
  // activate flight plan from present position to its first waypoint
  gpsActivate(f) {
    const g = this.gps; if (!g.fpl.length) return;
    g.fplActive = true; g.leg = 0; g.wpt = { ...g.fpl[0] }; g.origin = { x: f.pos[0], z: f.pos[2] }; g.arrived = false; g.mode = 'LEG'; g.page = 'NAV'; g.cursor = false;
    this.gpsMsg('FPL ACTIVATED ' + g.fpl.map((w) => w.ident).join('-'));
  }
  gpsDirect(w, f) {
    const g = this.gps; if (!w) return;
    // direct-to a waypoint in the active flight plan continues the plan from there
    const i = g.fpl.findIndex((x) => x.ident === w.ident);
    if (i >= 0 && g.fpl.length) { g.fplActive = true; g.leg = i; } else g.fplActive = false;
    g.wpt = { ident: w.ident, name: w.name, x: w.x, z: w.z, type: w.type };
    g.origin = { x: f.pos[0], z: f.pos[2] }; g.arrived = false; g.mode = 'LEG'; g.page = 'NAV'; g.cursor = false;
    this.gpsMsg('DIRECT TO ' + w.ident + ' — SET OBS ' + String(Math.round(g.wpt && (Math.atan2(w.x - f.pos[0], -(w.z - f.pos[2])) * 180 / Math.PI + 360) % 360)).padStart(3, '0'));
  }

  disconnect(alert = false) {
    this.ap.on = false; this.ap.locArmed = false; this.ap.gsArmed = false;
    if (alert) this.ap.discAlert = 2.5;
  }

  engage() {
    this.ap.on = true; this.ap.lat = 'ROL'; this.ap.vert = 'VS';
    this.ap.vsSel = Math.round(this.lastVs / 100) * 100 || 0;
    this.ap.iBank = 0; this.ap.iPitch = 0;
  }

  // returns {ail, elev, trimRate} servo commands or null
  autopilot(f, dt) {
    const ap = this.ap;
    const att = f.attitude;
    this.lastVs = f.ind.vsi;
    if (ap.discAlert) ap.discAlert = Math.max(0, ap.discAlert - dt);
    if (!ap.on) return null;
    // --- lateral ---
    const hdgGyro = (att.hdg - f.gyro.hiDrift + 360) % 360;
    let bankCmd = 0;
    let r = this.cdi1 || this.r1;
    if (ap.lat === 'HDG') bankCmd = clamp(angDiff(this.hdgBug, hdgGyro) * 1.4, -20, 20);
    else if (ap.lat === 'NAV' || ap.lat === 'APR' || ap.lat === 'REV') {
      if (r.valid) {
        const rev = ap.lat === 'REV';
        const course = rev && r.kind === 'ILS' ? (r.course + 180) % 360 : (r.kind === 'ILS' || r.kind === 'GPS') ? r.course : this.nav1.obs;
        if (rev) r = { ...r, dev: -r.dev };
        const fs = r.kind === 'ILS' ? 1.0 : 1.0;
        const intercept = clamp(r.dev * 60 * fs, -45, 45);
        ap.iBank = clamp(ap.iBank + r.dev * dt * 2.0, -15, 15);
        const want = course + intercept + ap.iBank;
        bankCmd = clamp(angDiff(want, hdgGyro) * 1.2, -20, 20);
        if (ap.lat === 'APR' && ap.gsArmed && r.gsValid && Math.abs(r.gsDev) < 0.15 && ap.vert !== 'GS') { ap.vert = 'GS'; ap.gsArmed = false; }
      } else bankCmd = clamp(angDiff(this.hdgBug, hdgGyro) * 1.4, -20, 20);
    } else bankCmd = 0;
    const bankErr = bankCmd - att.roll;
    const ail = clamp(bankErr * 0.035 - f.omega[0] * 0.6, -0.6, 0.6);
    // --- vertical ---
    let vsCmd = ap.vsSel;
    if (ap.vert === 'ALT') vsCmd = clamp((ap.altHold - f.ind.alt) * 4, -700, 700);
    if (ap.vert === 'VS' && ap.altArm && Math.abs(ap.altSel - f.ind.alt) < Math.abs(ap.vsSel) * 0.2 + 50) { ap.vert = 'ALT'; ap.altHold = ap.altSel; ap.altArm = false; }
    if (ap.vert === 'GS' && r.gsValid) {
      const gsKt = Math.hypot(f.vel[0], f.vel[2]) / 0.5144;
      vsCmd = -gsKt * 101.27 * Math.tan(3 * Math.PI / 180) - r.gsDev * 600;
    }
    const vsErr = vsCmd - f.ind.vsi;
    ap.iPitch = clamp(ap.iPitch + vsErr * dt * 0.0012, -8, 8);
    const pitchCmd = clamp(vsErr * 0.006 + ap.iPitch + 2, -12, 14);
    const elev = clamp((pitchCmd - att.pitch) * 0.06 - f.omega[2] * 0.9 + (ap.elevI || 0), -0.7, 0.7);
    ap.elevI = clamp((ap.elevI || 0) + (pitchCmd - att.pitch) * dt * 0.01, -0.4, 0.4);
    // stall protection: KAP 140 has none; disconnect if extreme
    if (Math.abs(att.roll) > 60 || Math.abs(att.pitch) > 30) this.disconnect(true);
    return { ail, elev };
  }

  apButton(name, f) {
    const ap = this.ap;
    if (name === 'AP') { if (ap.on) this.disconnect(true); else this.engage(); return; }
    if (!ap.on) { if (name !== 'AP') { this.engage(); } }
    if (name === 'HDG') ap.lat = ap.lat === 'HDG' ? 'ROL' : 'HDG';
    if (name === 'NAV') ap.lat = ap.lat === 'NAV' ? 'ROL' : 'NAV';
    if (name === 'APR') { ap.lat = ap.lat === 'APR' ? 'ROL' : 'APR'; ap.gsArmed = ap.lat === 'APR'; }
    if (name === 'REV') { ap.lat = ap.lat === 'REV' ? 'ROL' : 'REV'; ap.gsArmed = false; }
    if (name === 'ALT') { if (ap.vert === 'ALT') { ap.vert = 'VS'; ap.vsSel = 0; } else { ap.vert = 'ALT'; ap.altHold = Math.round(f.ind.alt / 20) * 20; } }
    if (name === 'UP') { if (ap.vert === 'ALT') ap.altHold += 20; else ap.vsSel = Math.min(1600, ap.vsSel + 100); }
    if (name === 'DN') { if (ap.vert === 'ALT') ap.altHold -= 20; else ap.vsSel = Math.max(-1600, ap.vsSel - 100); }
    if (name === 'ARM') ap.altArm = !ap.altArm;
  }
}

export { angDiff };
