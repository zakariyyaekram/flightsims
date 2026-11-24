// A350 Auto Flight System: FCU (AFS CP), AP1/AP2, FD, A/THR; lateral (RWY, RWY TRK, NAV, HDG, TRK,
// LOC*, LOC, LAND, ROLL OUT, GA TRK) and vertical modes (SRS, CLB, OP CLB, DES, OP DES, ALT*, ALT,
// ALT CST, ALT CRZ, V/S, FPA, G/S*, G/S, LAND, FLARE, EXPED), A/THR modes (SPEED, MACH, THR CLB,
// THR IDLE, MAN TOGA/FLX/MCT, THR LVR, A.FLOOR, TOGA LK, THR LK) with FMA strings and FD commands.
import { clamp, lerp, DEG } from '../math.js';
import { A350, KT, FT, NM, G, speeds, vs1g, CONFS } from './data.js';
import { angDiff } from './fms.js';

const R2D = 180 / Math.PI;

export class AFS {
  constructor(fdm, S, fms) {
    this.fdm = fdm; this.S = S; this.fms = fms; S.afs = this; S.fms = fms;
    this.reset();
  }
  reset(init = {}) {
    this.fcu = { spd: 250, mach: 0.80, machMode: false, spdManaged: true, hdg: init.hdg ?? 280, hdgManaged: true, hdgPreset: null, alt: init.alt ?? 5000, altInc: 100,
      vs: 0, fpa: 0, trkFpa: false, metric: false, exped: false, spdPreset: null };
    this.ap = [false, false]; this.fd = [true, true]; this.athr = { armed: false, active: false, mode: '', lock: false };
    this.lat = ''; this.latArmed = ''; this.vert = ''; this.vertArmed = []; this.trkHold = null;
    this.apEngagedT = 0; this.airT = 0; this.Pcmd = 0; this.capK = 3; this.msg = ''; this.retard = false;
    this.fdPitch = 0; this.fdRoll = 0; this.gCmd = 0; this.bankCmd = 0; this.aFlTimer = 0; this.lvrClb = false; this.lvrMsg = '';
    this.prevAp = false; this.accF = 0; this.landState = '';
  }
  get apOn() { return this.ap[0] || this.ap[1]; }
  get fdOn() { return this.fd[0] || this.fd[1]; }
  get targetSpd() {
    if (this.fcu.spdManaged) { const m = this.fms.managedSpeed(this.fdm, this); if (m.mach && this.fdm.ind.mach > 0.1) { const kt = this.fdm.ind.ias * m.mach / this.fdm.ind.mach; return Math.min(kt, m.spd); } return m.spd; }
    if (this.fcu.machMode && this.fdm.ind.mach > 0.1) return this.fdm.ind.ias * this.fcu.mach / this.fdm.ind.mach;
    return this.fcu.spd;
  }
  get managedMach() { const m = this.fms.managedSpeed(this.fdm, this); return m.mach && this.fdm.ind.ias * m.mach / Math.max(0.1, this.fdm.ind.mach) < m.spd ? m.mach : null; }

  // ---------------- FCU actions ----------------
  spdPush() { this.fcu.spdManaged = true; }
  spdPull() { if (this.fcu.spdManaged) { this.fcu.spd = Math.round(this.targetSpd); if (this.fdm.ind.mach > 0.1) this.fcu.mach = +(this.fcu.mach).toFixed(2); } this.fcu.spdManaged = false; }
  spdTurn(d) {
    if (this.fcu.spdManaged) { this.fcu.spd = Math.round(this.targetSpd); this.fcu.spdManaged = false; }
    if (this.fcu.machMode) this.fcu.mach = clamp(+(this.fcu.mach + d * 0.01).toFixed(2), 0.1, 0.99);
    else this.fcu.spd = clamp(this.fcu.spd + d, 100, 399);
  }
  spdMach() {
    const f = this.fdm; this.fcu.machMode = !this.fcu.machMode;
    if (f.ind.mach > 0.1 && f.ind.ias > 50) { if (this.fcu.machMode) this.fcu.mach = +(this.fcu.spd * f.ind.mach / f.ind.ias).toFixed(2); else this.fcu.spd = Math.round(this.fcu.mach * f.ind.ias / f.ind.mach); }
  }
  hdgTurn(d) { this.fcu.hdg = (this.fcu.hdg + d + 360) % 360; if (this.lat === 'NAV' || this.latArmed === 'NAV' || this.lat === '' ) this.fcu.hdgPreset = true; }
  hdgPull() {
    if (this.fdm.onGround && !this.lat) { this.fcu.hdgPreset = true; return; }
    if (!this.fcu.hdgPreset) this.fcu.hdg = Math.round(this.fcu.trkFpa ? this.track() : this.fdm.attitude.hdg);
    this.setLat(this.fcu.trkFpa ? 'TRK' : 'HDG'); if (this.latArmed !== 'LOC') this.latArmed = ''; this.fcu.hdgManaged = false; this.fcu.hdgPreset = null;
    if (this.vert === 'LAND' || this.vert === 'G/S' || this.vert === 'G/S*') this.setVert('V/S', this.fdm.ind.vsi);
  }
  hdgPush() {
    if (!this.fms.legs.length) return;
    this.fcu.hdgManaged = true; this.fcu.hdgPreset = null;
    const n = this.fms.nav;
    if (this.fdm.onGround) { this.latArmed = 'NAV'; return; }
    if (n && Math.abs(n.xtk) < 2 * NM) this.setLat('NAV'); else this.latArmed = 'NAV';
  }
  altTurn(d) { this.fcu.alt = clamp(Math.round((this.fcu.alt + d * this.fcu.altInc) / this.fcu.altInc) * this.fcu.altInc, 100, 43000); }
  altPull() { if (this.fdm.onGround) return; const up = this.fcu.alt > this.fdm.ind.alt; if (Math.abs(this.fcu.alt - this.fdm.ind.alt) < 50) return; this.setVert(up ? 'OP CLB' : 'OP DES'); this.fcu.exped = false; }
  altPush() {
    if (this.fdm.onGround) { this.vertArmed = ['CLB']; return; }
    const up = this.fcu.alt > this.fdm.ind.alt; if (Math.abs(this.fcu.alt - this.fdm.ind.alt) < 50) return;
    if (!this.fms.legs.length || !this.fcu.hdgManaged) { this.setVert(up ? 'OP CLB' : 'OP DES'); return; }
    this.setVert(up ? 'CLB' : 'DES');
    if (!up && (this.fms.phase === 'CRUISE' || this.fms.phase === 'CLIMB')) this.fms.phase = 'DESCENT';
  }
  vsTurn(d) {
    if (this.fcu.trkFpa) { if (this.vert !== 'FPA') this.fcu.fpa = this.gamma() * R2D; this.fcu.fpa = clamp(+(this.fcu.fpa + d * 0.1).toFixed(1), -9.9, 9.9); this.setVert('FPA'); }
    else { if (this.vert !== 'V/S') this.fcu.vs = Math.round(this.fdm.ind.vsi / 100) * 100; this.fcu.vs = clamp(this.fcu.vs + d * 100, -6000, 6000); this.setVert('V/S'); }
  }
  vsPull() { if (this.fdm.onGround) return; if (this.fcu.trkFpa) { this.fcu.fpa = +(this.gamma() * R2D).toFixed(1); this.setVert('FPA'); } else { this.fcu.vs = Math.round(this.fdm.ind.vsi / 100) * 100; this.setVert('V/S'); } }
  vsPush() { if (this.fdm.onGround) return; this.fcu.vs = 0; this.fcu.fpa = 0; this.setVert(this.fcu.trkFpa ? 'FPA' : 'V/S'); }
  trkFpaPb() {
    this.fcu.trkFpa = !this.fcu.trkFpa;
    if (this.lat === 'HDG') this.setLat('TRK'); else if (this.lat === 'TRK') this.setLat('HDG');
    if (this.vert === 'V/S') { this.fcu.fpa = +(this.gamma() * R2D).toFixed(1); this.setVert('FPA'); } else if (this.vert === 'FPA') { this.fcu.vs = Math.round(this.fdm.ind.vsi / 100) * 100; this.setVert('V/S'); }
  }
  locPb() {
    if (this.latArmed === 'LOC' && !this.vertArmed.includes('G/S')) { this.latArmed = this.fcu.hdgManaged ? 'NAV' : ''; return; }
    if (this.lat === 'LOC' || this.lat === 'LOC*') { if (!this.vert.startsWith('G/S') && this.vert !== 'LAND') { this.setLat('HDG'); } return; }
    if (!this.fms.tunedIls) { this.msg = 'NO LS TUNED'; return; }
    this.latArmed = 'LOC'; this.vertArmed = this.vertArmed.filter((v) => v !== 'G/S');
  }
  apprPb() {
    if (this.vertArmed.includes('G/S') || this.vert === 'G/S' || this.vert === 'G/S*') {
      if (this.vert === 'LAND' || this.vert === 'FLARE') return;
      this.vertArmed = this.vertArmed.filter((v) => v !== 'G/S'); if (this.latArmed === 'LOC') this.latArmed = this.fcu.hdgManaged ? 'NAV' : '';
      if (this.vert.startsWith('G/S')) this.setVert('V/S', this.fdm.ind.vsi);
      if (this.ap[0] && this.ap[1]) this.ap[1] = false;
      return;
    }
    if (!this.fms.tunedIls) { this.msg = 'NO LS TUNED'; return; }
    if (this.lat !== 'LOC' && this.lat !== 'LOC*') this.latArmed = 'LOC';
    if (!this.vertArmed.includes('G/S')) this.vertArmed.push('G/S');
    if (this.fms.phase === 'DESCENT' || this.fms.phase === 'CRUISE') this.fms.activateApproach();
  }
  expedPb() {
    const f = this.fdm; if (f.onGround) return;
    if (this.fcu.exped) { this.fcu.exped = false; this.setVert(this.fcu.alt > f.ind.alt ? 'OP CLB' : 'OP DES'); return; }
    if (Math.abs(this.fcu.alt - f.ind.alt) < 100) return;
    this.fcu.exped = true; this.setVert(this.fcu.alt > f.ind.alt ? 'EXPED CLB' : 'EXPED DES');
  }
  apPb(i) {
    const f = this.fdm;
    if (this.ap[i]) { this.disconnectAp(false); return; }
    if (f.onGround || f.ra < 100 * FT || this.airT < 5) { this.msg = 'AP NOT AVAIL ON GND'; this.S.emit('single'); return; }
    if (f.law !== 'NORMAL') { this.msg = 'AP INOP'; return; }
    const both = this.vertArmed.includes('G/S') || this.vert.startsWith('G/S') || this.vert === 'LAND' || this.lat === 'LOC' || this.latArmed === 'LOC';
    if (!both) this.ap = [false, false];
    this.ap[i] = true;
    if (!this.lat) this.setLat(this.fcu.trkFpa ? 'TRK' : 'HDG', true);
    if (!this.vert) this.setVert(this.fcu.trkFpa ? 'FPA' : 'V/S', f.ind.vsi);
    this.S.apOffWarn = 0;
  }
  disconnectAp(involuntary) {
    if (!this.apOn) return;
    this.ap = [false, false];
    this.S.apOffWarn = involuntary ? 6 : 1.6; this.S.apOffInvol = involuntary; this.S.emit('cavalry', involuntary ? 3 : 1.4);
  }
  instinctiveDisc() { // sidestick takeover pb
    if (this.apOn) this.disconnectAp(false);
    else if (this.S.apOffWarn > 0) { this.S.apOffWarn = 0; this.S.emit('silence'); }
  }
  athrPb() {
    if (this.athr.active || this.athr.armed) {
      const wasActive = this.athr.active; this.athr.armed = false; this.athr.active = false; this.fdm.athrPcmd = null;
      if (wasActive) { this.athr.lock = this.fdm.ctrl.tla[0] > 0.55 && this.fdm.ctrl.tla[0] < 0.7; this.lockP = this.fdm.E[0].P; this.S.athrOffWarn = 3; this.S.emit('single'); }
      this.athr.mode = '';
    } else { this.athr.armed = true; }
  }
  athrInstinctive() { if (this.athr.active || this.athr.armed) { this.athr.armed = false; this.athr.active = false; this.athr.mode = ''; this.fdm.athrPcmd = null; this.S.emit('click3'); this.athr.lock = false; this.fdm.prot.aFloor = false; } }
  fdPb(i) { this.fd[i] = !this.fd[i]; if (!this.fdOn && !this.apOn) { this.lat = ''; this.vert = ''; this.latArmed = ''; this.vertArmed = []; } }

  setLat(m, silent) { if (this.lat !== m) { this.lat = m; this.latT = 0; if (m === 'RWY TRK' || m === 'GA TRK') this.trkHold = this.track(); } }
  setVert(m, vs) {
    if (this.vert === m) return;
    this.vert = m; this.vertT = 0;
    if (m === 'V/S' && vs != null) this.fcu.vs = Math.round(vs / 100) * 100;
    if (m === 'FPA' && vs != null) this.fcu.fpa = +(this.gamma() * R2D).toFixed(1);
    if (m === 'ALT*' || m === 'ALT CST*') { const dh = this.altTarget() - this.fdm.ind.alt; this.capK = clamp(Math.abs(this.fdm.ind.vsi) / Math.max(Math.abs(dh), 50), 1.0, 6); }
    if (m !== 'ALT' && m !== 'ALT*' && m !== 'ALT CRZ' && m !== 'ALT CST' && m !== 'ALT CST*' && (m === 'OP CLB' || m === 'CLB' || m === 'OP DES' || m === 'DES' || m.startsWith('EXPED'))) { /* armed ALT shown */ }
  }
  track() { const v = this.fdm.vel; return (Math.atan2(v[0], -v[2]) * R2D + 360) % 360; }
  gamma() { const v = this.fdm.vel; const s = Math.hypot(v[0], v[1], v[2]); return s > 5 ? Math.asin(clamp(v[1] / s, -1, 1)) : 0; }

  // FCU or constraint altitude for climb / descent
  altTarget() {
    const fcuAlt = this.fcu.alt;
    if (this.vert === 'CLB' || this.vert === 'ALT CST*' && this.cstUp) { const c = this.nextConstraint(true); if (c != null && c < fcuAlt) { this.cstAlt = c; return c; } }
    if (this.vert === 'DES' || this.vert === 'ALT CST*' && !this.cstUp) { const c = this.nextConstraint(false); if (c != null && c > fcuAlt) { this.cstAlt = c; return c; } }
    if (this.vert === 'ALT CST' || this.vert === 'ALT CST*') return this.cstAlt ?? fcuAlt;
    return fcuAlt;
  }
  nextConstraint(up) {
    const L = this.fms.legs; if (!L.length) return null;
    for (let i = this.fms.act; i < L.length; i++) {
      const a = L[i].alt; if (!a || L[i].missed && !this.fms.missedActive) continue;
      if (up && (a.c === 'BL' || a.c === 'AT') && a.ft > this.fdm.ind.alt + 50) return a.ft;
      if (!up && (a.c === 'AB' || a.c === 'AT') && a.ft < this.fdm.ind.alt - 50) return a.ft;
      if (!up && a.ft < this.fdm.ind.alt - 50) return null;
    }
    return null;
  }

  // ---------------- main update ----------------
  update(dt) {
    const f = this.fdm, S = this.S, fms = this.fms, fcu = this.fcu;
    const onG = f.onGround, ias = f.ind.ias, altFt = f.ind.alt, raFt = f.ra / FT, vs = f.ind.vsi;
    const att = f.attitude;
    this.airT = onG ? 0 : this.airT + dt;
    const ils = this.ils = fms.ils(f);
    const tla = f.ctrl.tla, lvrMax = Math.max(tla[0], tla[1]);
    const aflrOk = f.law === 'NORMAL' && !onG && raFt > 100;
    if (this.msg) { this.msgT = (this.msgT || 0) + dt; if (this.msgT > 4) { this.msg = ''; this.msgT = 0; } }
    // --- AP safety disconnects
    if (this.apOn) {
      if (f.law !== 'NORMAL') this.disconnectAp(true);
      else if (Math.abs(f.ctrl.stickX) > 0.55 || Math.abs(f.ctrl.stickY) > 0.55 || Math.abs(f.ctrl.pedals) > 0.6) this.disconnectAp(true);
      else if (onG && this.lat !== 'ROLL OUT' && !(this.vert === 'FLARE' || this.vert === 'LAND' || this.lat === 'LAND')) this.disconnectAp(true);
    }
    // --- takeoff mode engagement
    const toThrust = lvrMax > 0.78;
    if (onG && toThrust && (this.fdOn || this.apOn) && fms.perf.v2 && this.vert !== 'SRS' && ias < 100 && fms.phase !== 'DONE') {
      this.setVert('SRS'); this.setLat(ils.valid && Math.abs(ils.locDeg) < 3 && fms.origin && ils.rwy === fms.origin.rwy ? 'RWY' : ''); this.latArmed = fms.legs.length && fcu.hdgManaged ? 'NAV' : ''; this.vertArmed = ['CLB'];
      if (!this.lat) this.setLat('RWY');
    }
    if (onG && !this.vert && fms.perf.v2 && this.fdOn) { this.vertArmed = ['CLB']; if (fms.legs.length && fcu.hdgManaged) this.latArmed = 'NAV'; }
    // --- A/THR arming with T.O thrust
    if (onG && toThrust && !this.athr.armed && !this.athr.active && fms.perf.v2 !== undefined) this.athr.armed = true;
    // --- go-around (TOGA with flaps out in flight)
    if (!onG && lvrMax > 0.97 && S.confIdx() >= 1 && (fms.phase === 'APPROACH' || this.vert === 'G/S' || this.vert === 'LAND' || this.vert === 'FLARE' || this.vert === 'G/S*') && this.vert !== 'SRS') {
      fms.goAround(); this.setVert('SRS'); this.setLat('GA TRK'); this.latArmed = 'NAV'; this.vertArmed = ['CLB']; this.athr.armed = true; this.retard = false;
      if (this.ap[0] && this.ap[1]) { /* both APs stay */ }
    }
    // ---------------- lateral transitions ----------------
    if (this.lat === 'RWY' && !onG && raFt > 30) { if (this.latArmed === 'NAV' && fms.nav) { this.setLat('NAV'); this.latArmed = ''; } else this.setLat('RWY TRK'); }
    if (this.lat === 'GA TRK' && raFt > 100 && this.latArmed === 'NAV' && fms.nav && this.vert !== 'SRS') { this.setLat('NAV'); this.latArmed = ''; }
    if (this.latArmed === 'NAV' && !onG && raFt > 30 && fms.nav && this.lat !== 'RWY' && this.lat !== 'GA TRK' && Math.abs(fms.nav.xtk) < 3 * NM && this.lat !== 'LOC' && this.lat !== 'LOC*') { this.setLat('NAV'); this.latArmed = ''; }
    if (this.latArmed === 'LOC' && ils.valid && !onG) {
      const dots = ils.loc, closing = Math.abs(angDiff(this.track(), ils.course)) < 100;
      if (Math.abs(dots) < 1.8 && closing) { this.setLat('LOC*'); this.latArmed = ''; }
    }
    if (this.lat === 'LOC*' && ils.valid && Math.abs(ils.loc) < 0.15 && Math.abs(angDiff(this.track(), ils.course)) < 8) this.setLat('LOC');
    // ---------------- vertical transitions ----------------
    const tgtAlt = this.altTarget();
    const dh = tgtAlt - altFt;
    if (this.vert === 'SRS' && !onG) {
      const agl = altFt - (fms.phase === 'GO AROUND' ? fms.dest?.elev ?? 0 : fms.origin?.elev ?? 0);
      if (agl > fms.perf.acc && fms.phase !== 'GO AROUND' || (fms.phase === 'GO AROUND' && agl > fms.perf.acc && this.vertT > 10)) {
        if (fms.phase === 'GO AROUND') this.setVert('OP CLB'); else if (this.vertArmed.includes('CLB') && fcu.hdgManaged !== false && fms.legs.length) this.setVert('CLB'); else this.setVert('OP CLB');
        this.vertArmed = [];
      }
    }
    const climbing = ['CLB', 'OP CLB', 'EXPED CLB', 'SRS'].includes(this.vert), desc = ['DES', 'OP DES', 'EXPED DES'].includes(this.vert);
    const vsm = this.vert === 'V/S' || this.vert === 'FPA';
    if ((climbing || desc || vsm) && !onG && this.vert !== 'SRS' || (this.vert === 'SRS' && !onG && raFt > 400)) {
      const toward = (dh > 0 && vs > 50) || (dh < 0 && vs < -50);
      const capZone = Math.max(120, Math.abs(vs) / 60 * 9);
      if (toward && Math.abs(dh) < capZone) { const cst = tgtAlt !== fcu.alt; this.cstUp = dh > 0; this.setVert(cst ? 'ALT CST*' : 'ALT*'); this.fcu.exped = false; }
    }
    if ((this.vert === 'ALT*' || this.vert === 'ALT CST*') && Math.abs(dh) < 30 && Math.abs(vs) < 250) this.setVert(this.vert === 'ALT CST*' ? 'ALT CST' : Math.abs(fcu.alt - fms.crzFL * 100) < 60 && fms.phase !== 'APPROACH' ? 'ALT CRZ' : 'ALT');
    if (this.vert === 'ALT CST' && (this.vertArmed.includes('CLB') || this.vertArmed.includes('DES'))) { /* continue after passing constraint */ }
    if ((this.vert === 'ALT CST') && fms.nav && fms.legs.length) {
      // resume managed climb/descent after the constraint waypoint is sequenced
      const nextUp = this.nextConstraint(true), nextDn = this.nextConstraint(false);
      if (fcu.alt > altFt + 100 && (nextUp == null || nextUp > altFt + 100)) this.setVert('CLB');
      else if (fcu.alt < altFt - 100 && fms.phase !== 'CLIMB' && (nextDn == null || nextDn < altFt - 100)) this.setVert('DES');
    }
    if (this.vert === 'ALT' || this.vert === 'ALT CRZ') { if (Math.abs(fcu.alt - altFt) > 250 && this.vertT > 2 && Math.abs(dh) > 250) { /* FCU alt changed: wait for pilot push/pull */ } }
    // armed ALT (shown in blue when climbing/descending towards the FCU altitude)
    this.altArmed = (climbing || desc || vsm) ? (tgtAlt !== fcu.alt ? 'ALT CST' : 'ALT') : '';
    // G/S capture
    if (this.vertArmed.includes('G/S') && ils.gsValid && (this.lat === 'LOC' || this.lat === 'LOC*') && Math.abs(ils.gs) < 0.6 && !onG) { this.setVert('G/S*'); this.vertArmed = this.vertArmed.filter((v) => v !== 'G/S'); }
    if (this.vert === 'G/S*' && Math.abs(ils.gs) < 0.12 && this.vertT > 3) this.setVert('G/S');
    if ((this.vert === 'G/S' || this.vert === 'G/S*') && this.lat === 'LOC' && raFt < 400 && raFt > 5) { this.setVert('LAND'); this.setLat('LAND'); }
    if (this.vert === 'LAND' && raFt < Math.max(35, Math.min(55, -vs * 0.06))) { this.setVert('FLARE'); this.S.emit('flare'); }
    if ((this.vert === 'FLARE' || this.vert === 'LAND') && (f.wow.l || f.wow.r)) { this.setVert('ROLL OUT'); this.setLat('ROLL OUT'); }
    if (this.lat === 'ROLL OUT' && f.ind.gs < 25 && this.apOn) { /* AP stays until pilot disconnects */ }
    // after landing: clear modes when stopped
    if (onG && fms.phase === 'DONE' && f.ind.gs < 5 && !this.apOn) { this.lat = ''; this.vert = ''; this.latArmed = ''; this.vertArmed = []; }
    // ---------------- A/THR ----------------
    const at = this.athr;
    if (f.aFloorTrig && aflrOk) { at.mode = 'A.FLOOR'; at.active = true; at.armed = true; f.prot.aFloor = true; this.aFlTimer = 0; }
    f.aFloorTrig = false;
    if (at.mode === 'A.FLOOR') { this.aFlTimer += dt; if (f.alpha < f.alphaFloorA - 2 * DEG && this.aFlTimer > 3) { at.mode = 'TOGA LK'; } }
    if (at.mode === 'TOGA LK') { f.prot.aFloor = true; if (lvrMax > 0.97 || lvrMax < 0.05) { at.mode = ''; f.prot.aFloor = false; } }
    else if (at.mode !== 'A.FLOOR') f.prot.aFloor = false;
    const inClbRange = lvrMax > 0.02 && lvrMax <= 0.68;
    if (at.armed && !onG && inClbRange && !f.prot.aFloor) at.active = true;
    if (at.active && (lvrMax > 0.7 || onG && !this.retard && this.vert !== 'ROLL OUT' && this.lat !== 'ROLL OUT')) { at.active = lvrMax <= 0.7 ? at.active : false; }
    if (onG && f.ind.gs < 30 && (this.vert === 'ROLL OUT' || fms.phase === 'DONE')) { if (at.active || at.armed) { at.active = false; at.armed = false; } }
    if (at.active && lvrMax < 0.02 && this.vert !== 'FLARE' && this.vert !== 'ROLL OUT' && !this.retard) { /* levers at idle: A/THR limited to idle */ }
    if (this.athr.lock && (Math.abs(lvrMax - 0.62) > 0.05)) this.athr.lock = false;
    // thrust reduction altitude: LVR CLB
    const aglO = altFt - (fms.phase === 'GO AROUND' ? fms.dest?.elev ?? 0 : fms.origin?.elev ?? 0);
    this.lvrClb = !onG && at.armed && !at.active && lvrMax > 0.7 && aglO > fms.perf.thrRed && (fms.phase === 'CLIMB' || fms.phase === 'TAKEOFF' || fms.phase === 'GO AROUND' || this.vert === 'OP CLB' || this.vert === 'CLB');
    // mode strings
    let athrMode = '';
    if (f.prot.aFloor) athrMode = at.mode;
    else if (at.active) {
      if (this.retard || (this.vert === 'FLARE' && raFt < 30)) athrMode = 'THR IDLE';
      else if (['CLB', 'OP CLB', 'EXPED CLB'].includes(this.vert)) athrMode = lvrMax < 0.58 ? 'THR LVR' : 'THR CLB';
      else if (['OP DES', 'EXPED DES'].includes(this.vert) || (this.vert === 'DES' && this.desIdle)) athrMode = 'THR IDLE';
      else if (this.vert === 'SRS') athrMode = 'SPEED';
      else athrMode = (fcu.spdManaged ? this.managedMach : fcu.machMode) ? 'MACH' : 'SPEED';
    } else if (lvrMax > 0.7 && (at.armed || onG)) {
      athrMode = lvrMax > 0.97 ? 'MAN TOGA' : (f.flexTemp != null && (onG || this.flexActive) && fms.phase !== 'GO AROUND' ? 'MAN FLX ' + (f.flexTemp > 0 ? '+' : '') + f.flexTemp : 'MAN MCT');
      if (lvrMax > 0.7 && lvrMax < 0.8 || (lvrMax > 0.85 && lvrMax < 0.97)) athrMode = 'MAN THR';
    } else if (this.athr.lock) athrMode = 'THR LK';
    if (onG && lvrMax > 0.78 && lvrMax < 0.86 && f.flexTemp != null) this.flexActive = true;
    if (lvrMax > 0.97 || lvrMax < 0.55 || fms.phase === 'GO AROUND') this.flexActive = false;
    S.flexActive = this.flexActive;
    at.mode = f.prot.aFloor ? at.mode : athrMode;
    // RETARD callout logic (manual landing or autoland)
    if (!onG && raFt < 20 && raFt > 2 && vs < 0 && (at.active || this.vert === 'FLARE') && lvrMax > 0.02) { if (!this.retard) { this.retard = true; S.emit('retard'); } }
    if (!onG && raFt < 20 && raFt > 2 && vs < 0 && !at.active && lvrMax > 0.02 && !this.retardMan) { this.retardMan = true; S.emit('retard'); }
    if (onG && lvrMax < 0.02) { this.retard = false; this.retardMan = false; }
    if (!onG && raFt > 100) { this.retard = false; this.retardMan = false; }
    // ---------------- guidance commands ----------------
    const V = Math.max(f.tas, 30);
    const g = this.gamma();
    const velHat = f.vel.map((x) => x / Math.max(1, Math.hypot(...f.vel)));
    const aAlong = f.accel[0] * velHat[0] + f.accel[1] * velHat[1] + f.accel[2] * velHat[2] + G * Math.sin(g) * 0; // m/s^2 (kinematic)
    this.accF = lerp(this.accF, aAlong, clamp(dt * 2, 0, 1));
    const Vt = this.targetSpd;
    const spdErr = (ias - Vt) * KT; // m/s, + = fast
    let gCmd = null, nzLim = [0.75, 1.25];
    const sinG = (fpm) => Math.asin(clamp(fpm * FT / 60 / V, -0.5, 0.5));
    const speedOnElev = (vt, gMin, gMax) => clamp(g + (this.accF + 0.11 * ((ias - vt) * KT)) / G, gMin, gMax);
    switch (this.vert) {
      case 'SRS': {
        const v2 = fms.perf.v2 || 160; const tgt = fms.phase === 'GO AROUND' ? Math.max(fms.appr.vapp || v2, ias > (fms.appr.vapp || v2) + 15 ? (fms.appr.vapp || v2) + 15 : ias) : Math.min(Math.max(v2 + 10, Math.min(ias, v2 + 15)), v2 + 15);
        this.srsTgt = tgt;
        gCmd = speedOnElev(tgt, 120 / 60 * FT / V, (18 - f.alpha * R2D) * DEG);
        if (onG) gCmd = null; nzLim = [0.6, 1.4]; break;
      }
      case 'CLB': case 'OP CLB': case 'EXPED CLB': {
        const vt = this.vert === 'EXPED CLB' ? speeds(f.mass, S.confIdx()).gd : Vt;
        gCmd = speedOnElev(vt, sinG(300), 20 * DEG); break;
      }
      case 'OP DES': case 'EXPED DES': {
        const vt = this.vert === 'EXPED DES' ? Math.min(340, S.vmax() - 10) : Vt;
        gCmd = speedOnElev(vt, sinG(-6000), sinG(-300)); break;
      }
      case 'DES': {
        // managed descent on the FMS path (geometric, 3°), idle thrust when above the path
        const dDest = fms.dDest; const pAlt = dDest != null ? fms.pathAlt(dDest) : altFt;
        this.pathDev = altFt - pAlt;
        const pathFpm = -f.ind.gs * KT * Math.tan(3 * DEG) / FT * 60;
        if (this.pathDev > 200) this.desIdle = true; else if (this.pathDev < 50) this.desIdle = false;
        if (this.desIdle) gCmd = speedOnElev(Math.min(Vt + 10, S.vmax() - 5), sinG(-5000), sinG(-400));
        else gCmd = sinG(clamp(pathFpm - this.pathDev * 4, -4000, 0));
        break;
      }
      case 'ALT*': case 'ALT CST*': gCmd = sinG(clamp(dh * this.capK, -Math.abs(vs) - 200, Math.abs(vs) + 200)); break;
      case 'ALT': case 'ALT CRZ': case 'ALT CST': gCmd = sinG(clamp(dh * 3, -1200, 1200)); break;
      case 'V/S': {
        let tv = fcu.vs; if ((tv > 0 && dh < 0) || (tv < 0 && dh > 0)) tv = 0;
        gCmd = sinG(tv); break;
      }
      case 'FPA': gCmd = fcu.fpa * DEG; break;
      case 'G/S*': case 'G/S': case 'LAND': {
        const d = ils.gsDist || 1000; const pathFt = ils.pathAlt ?? altFt;
        const hErr = (f.pos[1] / FT) - pathFt; // + above path (uses true height above sea)
        const pathFpm = -f.ind.gs * KT * Math.tan(3 * DEG) / FT * 60;
        let vsT = clamp(pathFpm - hErr * (this.vert === 'LAND' ? 3 : 4), -2500, 600);
        if (this.vert === 'LAND') { if (this.landVs == null && raFt < 150) this.landVs = vsT; if (this.landVs != null) vsT = clamp(vsT, this.landVs - 150, this.landVs + 150); } else this.landVs = null;
        gCmd = sinG(vsT);
        void d; break;
      }
      case 'FLARE': {
        const h = Math.max(0, raFt - 3.5);
        if (this.flareTau == null) this.flareTau = clamp(Math.max(h, 10) / Math.max(1, -vs / 60), 2.5, 5);
        gCmd = sinG(clamp(-(h / this.flareTau + 1.5) * 60, -1200, 0)); nzLim = [0.9, 1.3]; break;
      }
      case 'ROLL OUT': gCmd = null; break;
      default: gCmd = null;
    }
    this.gCmd = gCmd;
    // lateral
    let bank = null, trkCmd = null; const trk = this.track();
    const hdgNow = att.hdg;
    let maxBank = 25;
    switch (this.lat) {
      case 'HDG': bank = clamp(angDiff(fcu.hdg, hdgNow) * 1.6, -25, 25); maxBank = 25; break;
      case 'TRK': bank = clamp(angDiff(fcu.hdg, trk) * 1.6, -25, 25); break;
      case 'RWY TRK': case 'GA TRK': bank = clamp(angDiff(this.trkHold ?? trk, trk) * 1.6, -15, 15); break;
      case 'NAV': {
        const n = fms.nav; if (!n) { bank = 0; break; }
        const inter = clamp(-n.xtk * 0.012, -45, 45);
        trkCmd = (n.dtk + inter + 360) % 360;
        bank = clamp(angDiff(trkCmd, trk) * 1.8, -25, 25); break;
      }
      case 'LOC*': case 'LOC': case 'LAND': {
        if (!ils.valid) { bank = 0; break; }
        const inter = clamp(-ils.xtk * (this.lat === 'LOC*' ? 0.02 : 0.03), -30, 30);
        trkCmd = (ils.course + inter + 360) % 360;
        bank = clamp(angDiff(trkCmd, trk) * 2.0, this.lat === 'LAND' ? -10 : -25, this.lat === 'LAND' ? 10 : 25);
        if (this.lat === 'LAND' && raFt < 40) bank = clamp(bank, -3, 3);
        break;
      }
      case 'ROLL OUT': case 'RWY': bank = 0; break;
      default: bank = null;
    }
    this.bankCmd = bank;
    // rollout: rudder/NWS on the localizer centreline; decrab in flare
    let rud = null, nws = null;
    if (this.lat === 'ROLL OUT' && ils.valid) {
      const he = angDiff(ils.course, hdgNow);
      const c = clamp(he * 0.08 - ils.xtk * 0.025, -1, 1);
      rud = c; nws = c;
    } else if (this.vert === 'FLARE' && ils.valid && raFt < 40) {
      const he = angDiff(ils.course, hdgNow); rud = clamp(he * 0.06, -0.8, 0.8);
    }
    // outputs to FBW
    const apActive = this.apOn;
    f.ap.active = apActive;
    if (apActive && gCmd != null) {
      const kg = this.vert === 'FLARE' ? 1.4 : 0.75; if (this.vert !== 'FLARE') this.flareTau = null;
      const nz = Math.cos(g) / Math.cos(clamp(att.roll, -60, 60) * DEG) + (V / G) * kg * (gCmd - g);
      f.ap.nz = clamp(nz, nzLim[0], nzLim[1]);
    } else f.ap.nz = apActive ? Math.cos(g) / Math.cos(att.roll * DEG) : null;
    f.ap.bank = apActive ? (bank ?? att.roll) : null;
    f.ap.rud = apActive ? rud : null; f.ap.nws = apActive ? nws : null;
    f.ap.rollRate = this.lat === 'LAND' ? 3 : 6;
    // flight directors (bars, degrees)
    this.fdPitch = gCmd != null ? clamp((gCmd - g) * R2D * 1.6, -10, 10) : null;
    this.fdRoll = bank != null ? clamp((bank - att.roll) * 0.5, -12, 12) : null;
    if (onG && this.vert === 'SRS') { const v2 = fms.perf.v2 || 160; this.fdPitch = ias > (fms.perf.vr || v2 - 5) - 5 ? clamp((Math.min(15, 12.5) - att.pitch) * 0.8, -10, 10) : clamp(-att.pitch, -10, 10); }
    // A/THR thrust command
    if (at.active && !f.prot.aFloor) {
      if (!this.prevAthr) this.Pcmd = (f.E[0].P + f.E[1].P) / 2;
      const mode = at.mode;
      if (mode === 'THR CLB') this.Pcmd = 0.86;
      else if (mode === 'THR IDLE') this.Pcmd = Math.max(0, this.Pcmd - dt * 0.5);
      else if (mode === 'THR LVR') this.Pcmd = 1;
      else {
        const desAcc = clamp(-0.12 * spdErr / KT, -1.5, 1.5); // kt/s
        const acc = this.accF / KT;
        this.Pcmd = clamp(this.Pcmd + (0.012 * (Vt - ias) - 0.07 * acc) * dt * 1.0 + 0 * desAcc, 0, 1);
      }
      if (this.vert === 'FLARE' && raFt < 30 || this.retard) this.Pcmd = 0;
      f.athrPcmd = this.Pcmd;
    } else if (!f.prot.aFloor) {
      f.athrPcmd = this.athr.lock ? this.lockP : null;
    }
    this.prevAthr = at.active;
    // timers
    this.vertT = (this.vertT || 0) + dt; this.latT = (this.latT || 0) + dt;
    // approach capability
    this.cap = (this.vertArmed.includes('G/S') || this.vert.startsWith('G/S') || this.vert === 'LAND' || this.vert === 'FLARE') ? (this.ap[0] && this.ap[1] && at.active ? 'CAT3 DUAL' : this.apOn ? 'CAT3 SINGLE' : 'CAT1') : '';
    this.autoland = this.cap === 'CAT3 DUAL' || this.cap === 'CAT3 SINGLE';
    // autoland warning light: below 200 ft in LAND with loss of capability
    S.autolandWarn = (this.vert === 'LAND' || this.vert === 'FLARE') && raFt < 200 && (!this.apOn || !ils.valid || Math.abs(ils.loc) > 0.5 || Math.abs(ils.gs ?? 0) > 1);
    this.prevAp = apActive;
  }

  // FMA rows for the PFD
  fma() {
    const lvrFlash = this.lvrClb;
    const vertArm = [...this.vertArmed.filter((v) => v !== 'CLB' || !this.fdm.onGround || true)];
    if (this.altArmed && !vertArm.includes('G/S')) vertArm.unshift(this.altArmed);
    return {
      athr: this.athr.mode, athrBox: this.athr.mode === 'A.FLOOR' || this.athr.mode === 'TOGA LK' || this.athr.mode === 'THR LK',
      lvr: lvrFlash ? 'LVR CLB' : this.retard ? 'RETARD' : '',
      vert: this.vert === 'LAND' || this.vert === 'FLARE' || this.vert === 'ROLL OUT' ? '' : this.vert === 'V/S' ? `V/S ${this.fcu.vs >= 0 ? '+' : ''}${this.fcu.vs}` : this.vert === 'FPA' ? `FPA ${this.fcu.fpa >= 0 ? '+' : ''}${this.fcu.fpa.toFixed(1)}°` : this.vert,
      vertArm: vertArm.join(' '),
      lat: this.lat === 'LAND' || this.lat === 'ROLL OUT' ? '' : this.lat,
      common: this.vert === 'LAND' ? 'LAND' : this.vert === 'FLARE' ? 'FLARE' : this.vert === 'ROLL OUT' ? 'ROLL OUT' : '',
      latArm: this.latArmed,
      cap: this.cap, mins: this.fms.appr.baro ? 'BARO ' + this.fms.appr.baro : this.cap ? 'DH ' + (this.fms.appr.radio ?? 100) : '',
      ap: this.ap[0] && this.ap[1] ? 'AP1+2' : this.ap[0] ? 'AP1' : this.ap[1] ? 'AP2' : '',
      fd: this.fd[0] && this.fd[1] ? '1 FD 2' : this.fd[0] ? '1 FD -' : this.fd[1] ? '- FD 2' : '',
      athrSt: this.athr.active ? 'A/THR' : this.athr.armed ? 'A/THR*' : '',
      msg: this.msg,
    };
  }
}
