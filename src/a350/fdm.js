// A350-1000 flight dynamics: rigid body, coefficient aerodynamics (incl. compressibility, high-lift,
// gear, spoilers, ground effect), 2 x Trent XWB-97 engine model with FADEC auto start, fly-by-wire
// control laws (ground / normal with protections / flare / alternate / direct) using dynamic inversion,
// 6-wheel bogie + nose gear contacts with steering, carbon brakes, autobrake and ground spoilers.
// Body frame: +x forward, +y up, +z right (origin = CG). World: +X east, +Y up, +Z south.
import { add, sub, scl, dot, cross, len, norm, addTo, clamp, lerp, smoothstep, DEG, qmul, qnorm, qrot, qinvrot, qFromHPR, hprFromQ } from '../math.js';
import { atmosphere } from '../fdm.js';
import { A350, AERO, CONFS, KT, FT, G, vs1g } from './data.js';

const R2D = 180 / Math.PI;
const wrap180 = (a) => ((a % 360) + 540) % 360 - 180;

function makeEngine(running) {
  return {
    running, starting: false, startPhase: '', startT: 0, n1: running ? 19.5 : 0, n2: running ? 48 : 0, n3: running ? 63 : 0,
    egt: running ? 470 : 15, ff: running ? 300 : 0, P: 0, thrust: 0, rev: 0, oilP: running ? 60 : 0, oilT: running ? 75 : 15,
    vib: 0.3, ign: false, starterValve: false, fuelOn: running, failed: false, fire: false, avail: running, thrFrac: 0, tlaCmd: 0,
  };
}

function aeroTable(slat, flap) {
  // blend CONF rows by actual surface positions
  const r0 = CONFS[0], r1 = CONFS[1];
  const sF = clamp(slat / 18, 0, 1.5);
  const base = (k) => lerp(r0[k], r1[k], Math.min(1, sF));
  const fl = [0, 10, 20, 26, 37.5], rows = [1, 2, 3, 4, 5];
  let i = 0; while (i < fl.length - 2 && flap > fl[i + 1]) i++;
  const t = clamp((flap - fl[i]) / (fl[i + 1] - fl[i]), 0, 1);
  const fv = (k) => lerp(CONFS[rows[i]][k], CONFS[rows[i + 1]][k], t) - r1[k];
  return { dCL0: base('dCL0') + fv('dCL0'), clmax: base('clmax') + fv('clmax'), dCD: base('dCD') + fv('dCD'), dCm: base('dCm') + fv('dCm') };
}

export class JetFDM {
  constructor() {
    this.aircraft = { name: A350.name, fuelCapGal: A350.fuelCap / 3.04, visualScale: 1, emptyMass: A350.oew };
    this.env = { ground: () => ({ h: 0, n: [0, 1, 0], surface: 'runway' }), wind: [0, 0, 0], turbulence: 0, isaDev: 0, qnh: 101325, gustFactor: 0 };
    this.payload = 40000;
    this.fuel = { L: 20000, R: 20000, C: 0 };
    this.cgMac = 30;
    this.reset({ pos: [0, 0, 0], hdg: 0, onGround: true });
  }

  get mass() { return A350.oew + this.payload + this.fuel.L + this.fuel.R + this.fuel.C; }
  get fob() { return this.fuel.L + this.fuel.R + this.fuel.C; }
  get attitude() { return hprFromQ(this.q); }
  // shared modules (traffic, atc, map) expect a piston-style eng object
  get eng() { const e = this.E; return { running: e[0].running || e[1].running, rpm: Math.max(e[0].n1, e[1].n1) * 30 }; }

  reset({ pos, hdg = 0, pitch = 0, roll = 0, speedKt = 0, onGround = true, running = false, gearDown = true, slat = 0, flap = 0 }) {
    this.pos = pos.slice();
    this.q = qFromHPR(hdg, onGround ? 0 : pitch, roll);
    this.vel = scl(qrot(this.q, [1, 0, 0]), speedKt * KT);
    this.omega = [0, 0, 0];
    this.time = 0; this.crashed = null; this.onGround = onGround;
    this.ctrl = {
      stickX: 0, stickY: 0, pedals: 0, tiller: 0, brakeL: 0, brakeR: 0, parkBrake: onGround, tla: [0, 0],
      spdbrk: 0, spdArm: false, rudTrim: 0, trimCmd: 0, takeover: false,
    };
    this.E = [makeEngine(running), makeEngine(running)];
    this.surf = { elev: 0, ailL: 0, ailR: 0, spl: 0, rollSpl: 0, gndSpl: 0, rud: 0, ths: 0, slat, flap, nws: 0 };
    this.cfgTarget = { slat, flap };
    this.gear = { pos: gearDown ? 1 : 0, door: 0, lever: gearDown ? 1 : 0 };
    this.law = 'NORMAL'; this.lawActive = onGround ? 'GROUND' : 'NORMAL'; this.lawBlend = onGround ? 0 : 1;
    this.prot = { alpha: false, hsp: false, aFloor: false, pitchLim: false, bankLim: false };
    this.fpHold = false; this.gHold = 0; this.phiHold = 0; this.qI = 0; this.flareMem = null;
    this.ap = { active: false, nz: null, bank: null, rud: null, nws: null, rollRate: 6 };
    this.athrPcmd = null; // A/THR power demand per engine (null = manual levers)
    this.abrk = { mode: 'OFF', active: false, decel: 0, brake: 0, i: 0, btvStop: null };
    this.gsplArmedLatch = false; this.rto = false;
    this.ind = { ias: speedKt, alt: 0, vsi: 0, mach: 0, tat: 15, sat: 15, gs: speedKt, palt: 0 };
    this.accel = [0, 0, 0]; this.nz = 1; this.alpha = 0; this.beta = 0; this.tas = speedKt * KT; this.mach = 0;
    this.touchdown = null; this.prevWow = onGround; this.wow = { n: onGround, l: onGround, r: onGround };
    this.gearComp = { n: 0, l: 0, r: 0 }; this.brakeTemp = [20, 20, 20, 20]; this.brakeEnergy = 0;
    this.turbState = [0, 0, 0, 0, 0, 0];
    this.agl = 0; this.ra = 0; this.surfaceType = 'runway'; this.tow = null; this.tailStrike = false;
    this.eff = {}; this.stall = false; this.buffet = 0; this.groundM = [0, 0, 0];
    this.wheelSpin = 0; this.fanSpin = [0, 0];
    this.sys = { extPower: false };
    if (onGround) this.settleOnGround();
  }

  inertia() { const k = this.mass / A350.refMass; return [A350.Ixx * k, A350.Izz * k, A350.Iyy * k]; } // about body x, y(yaw), z(pitch)

  settleOnGround() {
    const g = this.env.ground(this.pos[0], this.pos[2], this.pos[1]);
    this.pos[1] = g.h + A350.cgHeight + 0.02;
    this.vel = [0, 0, 0]; this.omega = [0, 0, 0];
    const hdg = this.attitude.hdg; this.q = qFromHPR(hdg, 0, 0);
  }

  // Trim for steady flight (FBW in normal law trims itself; this just removes the initial transient)
  trimAir(gammaDeg = 0) {
    const m = this.mass, V = len(this.vel); const atm = atmosphere(this.pos[1], this.env.isaDev, this.env.qnh);
    const qbar = 0.5 * atm.rho * V * V; const t = aeroTable(this.surf.slat, this.surf.flap);
    const CLreq = m * G * Math.cos(gammaDeg * DEG) / (qbar * A350.wingArea);
    const M = V / atm.a; const CLa = AERO.CLa / Math.sqrt(1 - Math.min(0.8, M) ** 2) * 0.82;
    const alpha = (CLreq - AERO.CL0 - t.dCL0) / CLa;
    const hdg = this.attitude.hdg;
    this.q = qFromHPR(hdg, gammaDeg + alpha * R2D, 0);
    const h = hdg * DEG, gm = gammaDeg * DEG;
    this.vel = [Math.sin(h) * Math.cos(gm) * V, Math.sin(gm) * V, -Math.cos(h) * Math.cos(gm) * V];
    // THS for Cm = 0 with zero elevator
    const Cm = AERO.Cm0 + AERO.Cma * alpha + t.dCm;
    this.surf.ths = clamp(-Cm / AERO.Cmths * R2D, -3, 13);
    this.surf.elev = 0; this.omega = [0, 0, 0]; this.gHold = gm; this.fpHold = true; this.phiHold = 0;
    this.lawActive = 'NORMAL'; this.lawBlend = 1; this.onGround = false;
    this.wow = { n: false, l: false, r: false }; this.prevWow = false;
    return alpha * R2D;
  }

  turbulence(dt) {
    const k = this.env.turbulence || 0, ts = this.turbState, tau = [2.5, 1.8, 2.5, 0.8, 0.8, 0.9];
    for (let i = 0; i < 6; i++) {
      const g = (Math.random() + Math.random() + Math.random() - 1.5) * 2;
      ts[i] += (-ts[i] / tau[i] + g * Math.sqrt(2 / tau[i]) / Math.sqrt(dt) * 0.3) * dt;
    }
    const mech = clamp(this.agl / 300, 0.3, 1);
    return [ts[0] * k * 2.2 * mech, ts[1] * k * 1.6 * mech, ts[2] * k * 2.2 * mech, ts[3] * k, ts[4] * k, ts[5] * k];
  }

  // ---------------- engines ----------------
  engines(dt, atm, M) {
    const S = this.S; // systems (may be undefined in unit tests)
    const sigma = atm.rho / 1.225;
    const lapse = Math.pow(sigma, 0.72) * (1 - 0.34 * M + 0.12 * M * M) * (1 - Math.max(0, this.env.isaDev - 15) * 0.006);
    let total = [0, 0];
    for (let i = 0; i < 2; i++) {
      const e = this.E[i];
      const master = S ? S.master[i] : true;
      const fuelAvail = S ? S.fuelFeed(i) : true;
      const mode = S ? S.engMode : 'NORM';
      const startAir = S ? S.startAir(i) : true;
      const firePushed = S ? S.firePushed[i] : false;
      const windmill = clamp(this.tas / 150, 0, 1) * 18;
      e.fuelOn = master && !firePushed && fuelAvail && !e.failed;
      if (e.running) {
        if (!e.fuelOn) { e.running = false; e.avail = false; e.starting = false; }
      } else if (master && !firePushed && !e.failed && (mode === 'IGN' || (this.onGround === false && e.n3 > 12))) {
        // FADEC automatic start sequence
        if (!e.starting && (startAir || e.n3 > 15)) { e.starting = true; e.startT = 0; e.startPhase = 'STARTER'; }
      } else if (!master && e.starting) { e.starting = false; e.startPhase = ''; }
      if (S && S.manStart?.[i] && mode === 'CRANK' && startAir && !e.running) { e.starterValve = true; e.n3 = Math.min(26, e.n3 + dt * 1.4); }
      let n3Tgt = windmill, Ptgt = 0;
      e.starterValve = false; e.ign = false;
      if (e.starting) {
        e.startT += dt;
        e.starterValve = e.n3 < 50 && startAir;
        if (e.starterValve) e.n3 += dt * (e.n3 < 26 ? 1.25 : 1.05);
        if (e.n3 > 22 && e.fuelOn) { e.ign = e.n3 < 50; if (e.startPhase === 'STARTER') { e.startPhase = 'IGN'; e.lightT = e.startT; } }
        if (e.startPhase === 'IGN' && e.startT - e.lightT > 3) e.startPhase = 'LIGHT';
        if (e.startPhase === 'LIGHT') e.n3 += dt * 0.55;
        if (e.n3 >= 62.5) { e.running = true; e.starting = false; e.startPhase = ''; e.avail = true; }
        if (!startAir && e.n3 < 40 && e.startPhase === 'STARTER') { e.n3 -= dt * 0.6; }
        n3Tgt = e.n3;
      }
      if (e.running) {
        // thrust demand: manual lever or A/THR
        const tla = this.ctrl.tla[i];
        let dem = this.leverToPower(tla, i);
        if (this.athrPcmd != null && tla >= 0) dem = Math.min(dem, this.athrPcmd);
        if (this.prot.aFloor) dem = 1.0;
        if (tla < -0.02) dem = clamp((-tla - 0.12) / 0.88, 0, 1) * 0.72; // reverse thrust demand
        e.tlaCmd = dem;
        const up = dem > e.P;
        const k = up ? (0.18 + 0.75 * e.P) : 0.9;
        e.P += clamp((dem - e.P) * k * dt * 2.2, -0.35 * dt, 0.22 * dt);
        e.P = clamp(e.P, 0, 1);
        n3Tgt = 63 + 34.5 * Math.sqrt(e.P);
        e.n3 = lerp(e.n3, n3Tgt, clamp(dt * 1.5, 0, 1));
      } else if (!e.starting) {
        e.n3 = Math.max(e.n3 + (windmill - e.n3) * dt * 0.08, 0);
        e.P = Math.max(0, e.P - dt * 0.5);
      }
      // derived spools / temperatures
      const runFrac = clamp((e.n3 - 20) / 43, 0, 1);
      const n1Tgt = e.running ? 19.5 + 77.5 * Math.pow(e.P, 0.62) : (e.starting ? 19.5 * runFrac ** 1.6 : windmill * 0.9);
      e.n1 = lerp(e.n1, n1Tgt, clamp(dt * (e.running ? 2.0 : 0.25), 0, 1));
      e.n2 = lerp(e.n2, e.running ? 48 + 44 * Math.sqrt(e.P) : e.n3 * 0.72, clamp(dt * 1.6, 0, 1));
      const oat = atm.T - 273.15;
      let egtT = e.running ? 470 + 430 * e.P + (oat - 15) * 1.6 : e.starting && (e.startPhase === 'LIGHT') ? 380 + 260 * smoothstep(0, 6, e.startT - e.lightT - 3) - 80 * runFrac : oat;
      if (e.fire) egtT = Math.max(egtT, 900);
      e.egt = lerp(e.egt, egtT, clamp(dt * (e.running ? 0.8 : 0.35), 0, 1));
      e.oilP = lerp(e.oilP, e.running ? 45 + 40 * e.P : e.n3 * 0.5, clamp(dt, 0, 1));
      e.oilT = lerp(e.oilT, e.running ? 75 + 45 * e.P : oat, clamp(dt * 0.01, 0, 1));
      e.vib = e.running ? 0.3 + e.P * 0.5 : e.n1 * 0.01;
      // reverser (electric ETRAS): deploy on ground only
      const revCmd = this.ctrl.tla[i] < -0.02 && (this.wow.l || this.wow.r || this.ra < 3);
      e.rev = clamp(e.rev + (revCmd ? dt / 1.8 : -dt / 2.2), 0, 1);
      // thrust
      const idleFrac = 0.042;
      let T = e.running ? A350.thrust * lapse * (idleFrac + (1 - idleFrac) * e.P) : A350.thrust * lapse * 0.002 * e.n1;
      e.thrFrac = e.running ? e.P : 0;
      if (e.rev > 0.05) T *= lerp(1, -0.32, e.rev);
      // ram drag of a windmilling engine
      if (!e.running) T -= 0.004 * this.tas * this.tas * sigma * 40;
      e.thrust = T;
      e.ff = e.running ? 260 + Math.max(0, T) * (0.0295 + 0.021 * M) * (0.6 + 0.4 * sigma) : (e.starting && e.fuelOn && e.n3 > 22 ? 400 : 0);
      total[i] = T;
      this.fanSpin[i] = (this.fanSpin[i] + e.n1 * dt * 0.75) % (Math.PI * 2);
    }
    return total;
  }

  // Thrust lever angle (−1..1, detents IDLE 0, CLB .62, FLX/MCT .82, TOGA 1) -> power demand
  leverToPower(tla, i) {
    const flex = this.flexDerate ?? 1;
    const clb = 0.86, mct = 0.93;
    if (tla <= 0) return 0;
    if (tla <= 0.62) return clb * (tla / 0.62);
    if (tla <= 0.82) { const atFlx = (this.onGround || this.flexActive) && this.flexTemp != null ? flex : mct; return lerp(clb, atFlx, (tla - 0.62) / 0.2); }
    return lerp(this.flexActive && this.flexTemp != null ? flex : mct, 1, (tla - 0.82) / 0.18);
  }

  // ---------------- fly-by-wire ----------------
  fbw(dt, ctx) {
    const c = this.ctrl, s = this.surf, att = ctx.att;
    const V = Math.max(this.tas, 30), qbar = ctx.qbar;
    const theta = att.pitch * DEG, phi = att.roll * DEG;
    const gamma = Math.asin(clamp(this.vel[1] / Math.max(len(this.vel), 1), -1, 1));
    const p = this.omega[0], r = -this.omega[1], q = this.omega[2];
    const [Ix, Iy, Iz] = this.inertia(); // Iy = yaw (about body y), Iz = pitch
    const cfg = ctx.cfg;
    const flapsOut = s.slat > 2;
    const nzMax = flapsOut ? 2.0 : 2.5, nzMin = flapsOut ? 0 : -1;
    const law = this.law; // NORMAL | ALTN | DIRECT
    // ground/flight law transitions
    const wowMain = this.wow.l || this.wow.r;
    if (wowMain && this.lawActive !== 'GROUND' && (this.ra < 1 && this.wowTime > 5)) this.lawActive = 'GROUND';
    if (!wowMain && !this.wow.n && this.lawActive === 'GROUND') this.lawActive = 'FLIGHT';
    this.lawBlend = clamp(this.lawBlend + (this.lawActive === 'GROUND' ? -dt / 2 : dt / 5), 0, 1);
    const stY = c.stickY, stX = c.stickX;
    const apOn = this.ap.active && law === 'NORMAL';
    const elevMax = 30 * DEG, elevMin = -25 * DEG;
    // aerodynamic pitch/roll/yaw moments without primary surface deflection (from ctx)
    const qSc = qbar * A350.wingArea * A350.mac, qSb = qbar * A350.wingArea * A350.span;
    let elevCmd = 0, rollU = 0, rudU = 0;
    const alphaProt = ctx.alphaProt, alphaMax = ctx.alphaMax;
    // ---- pitch ----
    if (law === 'DIRECT' || this.lawActive === 'GROUND' && this.tas < 50 * KT) {
      elevCmd = stY > 0 ? stY * elevMax : -stY * elevMin;
      if (law === 'DIRECT') elevCmd *= clamp(1.5 - this.ind.ias / 330, 0.45, 1);
      this.qI = 0;
    } else {
      let qCmd;
      const g_V = G / V;
      const nzN = Math.cos(gamma) / Math.cos(clamp(phi, -67 * DEG, 67 * DEG));
      if (this.lawActive === 'GROUND') {
        // takeoff rotation law: stick commands pitch rate, tail-strike pitch limit
        qCmd = Math.max(0, stY) * 4.2 * DEG - Math.max(0, -stY) * 2 * DEG;
        qCmd = Math.min(qCmd, 0.8 * (9.2 * DEG - theta));
        if (theta < 0.3 * DEG && stY <= 0.05) qCmd = Math.min(qCmd, 0);
      } else if (!apOn && this.ra < 50 * FT * 1 && gamma < 0 && law === 'NORMAL' && this.flareMem != null) {
        // flare law: attitude memorised at 50 ft, slowly lowered — pilot must pull to flare
        this.flareMem.t += dt;
        const tgt = this.flareMem.theta - Math.min(2 * DEG, this.flareMem.t * 0.25 * DEG) + stY * 14 * DEG;
        qCmd = 0.9 * (tgt - theta);
      } else {
        let nzc;
        if (apOn && this.ap.nz != null) { nzc = this.ap.nz; this.fpHold = false; }
        else if (Math.abs(stY) < 0.04) {
          if (!this.fpHold) { this.fpHold = true; this.gHold = gamma; }
          nzc = nzN + clamp(V / G * 0.35 * (this.gHold - gamma), -0.3, 0.3);
        } else {
          this.fpHold = false;
          nzc = nzN + (stY > 0 ? stY * (nzMax - 1) : stY * (1 - nzMin));
        }
        if (law === 'NORMAL') nzc = clamp(nzc, nzMin, nzMax); else nzc = clamp(nzc, -1, 2.5);
        qCmd = g_V * (nzc - Math.cos(gamma) * Math.cos(phi));
        this.qI = clamp(this.qI + (nzc - this.nz) * dt * 0.6, -0.4, 0.4);
        qCmd += g_V * (this.qI + 0.5 * (nzc - this.nz));
        if (law === 'NORMAL') {
          // pitch attitude protection
          const thMax = (s.flap > 30 ? 25 : 30) * DEG, thMin = -15 * DEG;
          if (theta > thMax - 5 * DEG) qCmd = Math.min(qCmd, 0.35 * (thMax - theta));
          if (theta < thMin + 5 * DEG) qCmd = Math.max(qCmd, 0.35 * (thMin - theta));
          this.prot.pitchLim = theta > thMax - 1 * DEG || theta < thMin + 1 * DEG;
          // high angle of attack protection (alpha law)
          if (this.alpha > alphaProt && !this.prot.alpha && this.ra > 30 * FT) this.prot.alpha = true;
          const vsNow = Math.sqrt(2 * this.mass * G / (1.225 * A350.wingArea * cfg.clmax)) / KT;
          if (this.prot.alpha && (stY < -0.05 || (this.alpha < alphaProt - 1 * DEG && stY < 0.05) || (Math.abs(stY) < 0.04 && this.ind.ias > vsNow * 1.3))) this.prot.alpha = false;
          const qG = g_V * (this.nz - Math.cos(gamma) * Math.cos(phi));
          const aCmd = alphaProt + Math.max(0, stY) * (alphaMax - alphaProt);
          const qA = 1.3 * (aCmd - this.alpha) + qG;
          if (this.prot.alpha) qCmd = apOn ? Math.min(qCmd, qA) : qA;
          else if (this.alpha > alphaProt - 2 * DEG) qCmd = Math.min(qCmd, qA + 0.5 * DEG);
          // high speed protection: nose-up demand above VMO+6 / MMO+0.015
          const over = Math.max(this.ind.ias - (A350.vmo + 6), (this.mach - (A350.mmo + 0.015)) * 600);
          this.prot.hsp = over > 0;
          if (over > 0) qCmd = Math.max(qCmd, 0.02 * over * DEG * 4 + (stY < 0 ? stY * 0.5 * DEG : 0));
        }
      }
      // dynamic inversion: required pitch acceleration -> elevator
      const qdot = 2.6 * (qCmd - q);
      const Mreq = Iz * qdot - ctx.Mz0 - this.groundM[2];
      const de = Mreq / Math.max(qSc * AERO.Cmde, 1e3);
      const blend = this.lawActive === 'GROUND' && this.tas < 70 * KT ? 0 : 1;
      const direct = stY > 0 ? stY * elevMax : -stY * elevMin;
      elevCmd = lerp(direct, de, blend);
      // auto-trim (THS) offloads the elevator
      const trimFrozen = law === 'DIRECT' || this.lawActive === 'GROUND' || this.prot.alpha || this.ra < 50 * FT || Math.abs(phi) > 33 * DEG || this.nz < 0.5 || this.prot.hsp;
      if (!trimFrozen && ctx.hydOk) {
        const dTh = clamp(s.elev * R2D * 0.6, -0.5, 0.5) * dt;
        s.ths = clamp(s.ths + dTh, -3, 13);
      }
    }
    // manual pitch trim (pedestal switch) — direct law, or on ground before takeoff
    if (c.trimCmd && ctx.hydOk && (law === 'DIRECT' || this.lawActive === 'GROUND')) s.ths = clamp(s.ths + c.trimCmd * 0.45 * dt, -3, 13);
    // ---- lateral ----
    if (law === 'NORMAL' && this.lawActive !== 'GROUND' && this.lawBlend > 0.5) {
      let pCmd;
      const phiMax = (this.prot.alpha || this.prot.hsp) ? 45 * DEG : 67 * DEG;
      if (apOn && this.ap.bank != null && Math.abs(stX) < 0.3) {
        const rr = (this.ap.rollRate || 6) * DEG;
        pCmd = clamp(0.6 * (this.ap.bank * DEG - phi), -rr, rr);
        this.phiHold = phi;
      } else if (Math.abs(stX) < 0.04) {
        if (Math.abs(this.phiHold) > 33 * DEG) this.phiHold = Math.sign(this.phiHold) * Math.max(33 * DEG, Math.abs(this.phiHold) - 5 * DEG * dt);
        pCmd = clamp(0.8 * (this.phiHold - phi), -6 * DEG, 6 * DEG);
      } else {
        pCmd = stX * 15 * DEG;
        this.phiHold = phi;
      }
      if (phi > phiMax - 2 * DEG) pCmd = Math.min(pCmd, 0.8 * (phiMax - phi));
      if (phi < -phiMax + 2 * DEG) pCmd = Math.max(pCmd, 0.8 * (-phiMax - phi));
      this.prot.bankLim = Math.abs(phi) > 33 * DEG;
      const pdot = 3.0 * (pCmd - p);
      const Lreq = Ix * pdot - ctx.Lx0;
      rollU = clamp(Lreq / Math.max(qSb * ctx.ClU, 1e3), -1, 1);
      // yaw: turn coordination + yaw damping + pedal sideslip demand
      const rCoord = G * Math.sin(phi) * Math.cos(theta) / V;
      const betaCmd = -c.pedals * clamp(14 - (this.ind.ias - 140) * 0.05, 2, 14) * DEG;
      const rCmd = rCoord + 1.6 * (this.beta - betaCmd);
      const rdot = 2.5 * (rCmd - r);
      const Nreq = Iy * rdot + ctx.Ny0;
      rudU = clamp(Nreq / Math.max(qSb * ctx.CnU, 1e3), -1, 1);
      if (apOn && this.ap.rud != null) rudU = clamp(rudU + this.ap.rud, -1, 1);
    } else {
      // ground / alternate / direct: roll direct, rudder direct (+ yaw damper in ALTN)
      rollU = stX * (this.lawActive === 'GROUND' ? 0.7 : 1);
      rudU = c.pedals + c.rudTrim / 30;
      if (law === 'ALTN' && this.tas > 60) rudU += clamp(1.2 * (r - G * Math.sin(phi) / V) * 4, -0.3, 0.3);
      if (this.ap.active && this.ap.rud != null) rudU = clamp(rudU + this.ap.rud, -1, 1);
    }
    rudU = clamp(rudU + (law === 'NORMAL' && this.lawActive !== 'GROUND' ? c.rudTrim / 30 : 0), -1, 1);
    // actuator dynamics / rate limits (electro-hydraulic, 2H/2E architecture)
    const auth = ctx.hydOk ? 1 : ctx.elecBackup ? 0.6 : 0;
    const rl = (cur, tgt, rate) => cur + clamp(tgt - cur, -rate * dt, rate * dt);
    s.elev = rl(s.elev, clamp(elevCmd, elevMin, elevMax) * auth + s.elev * (1 - auth), 45 * DEG);
    const ail = clamp(rollU, -1, 1) * 25 * DEG * auth;
    s.ailL = rl(s.ailL, -ail, 60 * DEG); s.ailR = rl(s.ailR, ail, 60 * DEG);
    s.rollSpl = clamp((Math.abs(rollU) - 0.25) / 0.75, 0, 1) * Math.sign(rollU) * 35 * DEG;
    const rudMax = clamp(30 - Math.max(0, this.ind.ias - 160) * 0.14, 4, 30) * DEG;
    s.rud = rl(s.rud, clamp(rudU, -1, 1) * rudMax * auth, 45 * DEG);
    this.rollU = rollU; this.rudMax = rudMax;
  }

  // ---------------- main step ----------------
  step(dt) {
    if (this.crashed) return;
    this.time += dt;
    const c = this.ctrl, s = this.surf, S = this.S;
    const atm = atmosphere(this.pos[1], this.env.isaDev, this.env.qnh); this.atm = atm;
    const g0 = this.env.ground(this.pos[0], this.pos[2], this.pos[1]);
    this.agl = this.pos[1] - A350.cgHeight - g0.h; this.surfaceType = g0.surface;
    const att = hprFromQ(this.q);
    const turb = this.turbulence(dt);
    const wShear = clamp(Math.log(Math.max(this.agl + 5, 0.5) / 0.05) / Math.log(300 / 0.05), 0.35, 1.0);
    const wind = scl(this.env.wind, wShear * (1 + (this.env.gustFactor || 0)));
    const vAirW = sub(this.vel, add(wind, [turb[0], turb[1], turb[2]]));
    const vB = qinvrot(this.q, vAirW);
    const omB = add(this.omega, [turb[3] * 0.01, turb[4] * 0.006, turb[5] * 0.008]);
    const V = len(vB); this.tas = V;
    const Vs = Math.max(V, 1);
    this.alpha = Math.atan2(-vB[1], Math.max(vB[0], 0.1));
    this.beta = V > 2 ? Math.asin(clamp(vB[2] / V, -1, 1)) : 0;
    const M = V / atm.a; this.mach = M;
    const qbar = 0.5 * atm.rho * V * V;
    // ---- slats/flaps & gear (hydraulic) ----
    const hydG = S ? S.hydP.G > 2500 : true, hydY = S ? S.hydP.Y > 2500 : true;
    const hydOk = hydG || hydY;
    const elecBackup = S ? S.acPowered : true;
    const fRate = (hydG && hydY ? 1 : 0.5) * (hydG || hydY ? 1 : 0);
    s.slat += clamp(this.cfgTarget.slat - s.slat, -1.6 * fRate * dt, 1.6 * fRate * dt);
    s.flap += clamp(this.cfgTarget.flap - s.flap, -1.5 * fRate * dt, 1.5 * fRate * dt);
    const gr = this.gear; const gearHyd = S ? (S.hydP.G > 2500 || S.gravityGear) : true;
    if (gearHyd || gr.lever && S?.gravityGear) {
      const tgt = gr.lever ? 1 : 0;
      if (gr.pos !== tgt) { gr.door = Math.min(1, gr.door + dt / 2.5); if (gr.door >= 1) gr.pos = clamp(gr.pos + (tgt > gr.pos ? 1 : -1) * dt / 8, 0, 1); }
      else gr.door = Math.max(0, gr.door - dt / 2.5);
      if (S?.gravityGear && gr.lever === 0) gr.lever = 1;
    }
    const gearDown = gr.pos > 0.98;
    // ---- aero coefficients ----
    const tab = aeroTable(s.slat, s.flap);
    const CLa = AERO.CLa / Math.sqrt(1 - Math.min(0.8, M) ** 2) * (M > 0.3 ? 0.82 : lerp(1, 0.82, M / 0.3));
    const aStall = (tab.clmax * (M > 0.4 ? 1 - (M - 0.4) * 0.6 : 1) - AERO.CL0 - tab.dCL0) / CLa + 1.0 * DEG;
    const geK = 1 + AERO.ge * clamp(1 - (this.agl + 3) / (A350.span * 0.6), 0, 1);
    const a = this.alpha;
    let CL = (AERO.CL0 + tab.dCL0 + CLa * a) * geK;
    const clmax = tab.clmax * geK * (M > 0.4 ? 1 - (M - 0.4) * 0.6 : 1);
    if (a > aStall) { const d = a - aStall; CL = Math.min(CL, clmax) - clmax * 0.35 * smoothstep(0, 6 * DEG, d); }
    this.stall = a > aStall; this.buffet = smoothstep(aStall - 2 * DEG, aStall + 2 * DEG, a) + smoothstep(A350.mmo, A350.mmo + 0.05, M);
    this.alphaStall = aStall;
    // spoilers
    const fl = S ? S.speedbrakeInhibit : false;
    const splFlight = (!fl ? c.spdbrk : 0) * (this.onGround ? 0 : 1);
    s.spl = clamp(s.spl + clamp(splFlight * 40 * DEG - s.spl, -40 * DEG * dt, 25 * DEG * dt), 0, 40 * DEG);
    const gs = s.gndSpl / (50 * DEG);
    CL -= 0.12 * (s.spl / (40 * DEG)) + 0.55 * gs;
    const CDw = M > AERO.Mcrit ? 22 * (M - AERO.Mcrit) ** 2.6 : 0;
    const CD = AERO.CD0 + AERO.k * (CL - 0.05) ** 2 * (1 + tab.dCD * 3) + tab.dCD + (gr.pos > 0.02 ? AERO.CDgear * gr.pos + gr.door * 0.004 : 0)
      + AERO.CDspoiler * s.spl / (40 * DEG) + AERO.CDgndSpoiler * gs + CDw + Math.abs(this.beta) * 0.3 + Math.abs(s.rud) * 0.02;
    const CY = AERO.CYb * this.beta + 0.25 * s.rud;
    const pH = omB[0] * A350.span / (2 * Vs), rH = -omB[1] * A350.span / (2 * Vs), qH = omB[2] * A350.mac / (2 * Vs);
    const Sw = A350.wingArea;
    // pitch moment (nose-up +)
    const thsR = s.ths * DEG;
    let Cm0 = AERO.Cm0 + AERO.Cma * a + AERO.Cmq * qH + tab.dCm + AERO.Cmths * thsR - 0.03 * gs + 0.01 * gr.pos;
    if (a > aStall) Cm0 -= 0.25 * smoothstep(0, 5 * DEG, a - aStall);
    if (M > 0.82) Cm0 -= (M - 0.82) * 0.6; // Mach tuck
    const ClU = AERO.Clda * 25 * DEG + AERO.Clsp * 0.6;
    const CnU = AERO.Cndr * (this.rudMax ?? 30 * DEG);
    let Cl0 = AERO.Clb * this.beta + AERO.Clp * pH + AERO.Clr * rH;
    let Cn0 = AERO.Cnb * this.beta + AERO.Cnr * rH + AERO.Cnp * pH;
    // ---- engines ----
    const T = this.engines(dt, atm, M);
    const eY = A350.engY, eZ = A350.engZ;
    const Fthr = [T[0] + T[1], 0, 0];
    const Mthr = [0, (T[1] - T[0]) * eZ, -eY * (T[0] + T[1])]; // body moments from r x F
    // moments (body axes) without primary surface terms
    const Lx0 = qbar * Sw * A350.span * Cl0;
    const Ny0 = -qbar * Sw * A350.span * Cn0 + Mthr[1];
    const Mz0 = qbar * Sw * A350.mac * Cm0 + Mthr[2];
    // alpha protection thresholds
    const alphaMax = aStall - 1.2 * DEG, alphaProt = aStall - 3.2 * DEG, alphaFloor = aStall - 2.2 * DEG;
    this.alphaProt = alphaProt; this.alphaMax = alphaMax; this.alphaFloorA = alphaFloor;
    if (this.law === 'NORMAL' && !this.onGround && this.ra > 100 * FT && a > alphaFloor) this.aFloorTrig = true;
    // ---- FBW ----
    this.fbw(dt, { att, qbar, cfg: tab, alphaProt, alphaMax, Mz0, Lx0, Ny0, ClU, CnU, hydOk, elecBackup });
    // ---- forces ----
    const vHat = V > 0.5 ? scl(vB, 1 / V) : [1, 0, 0];
    const liftDir = norm(cross([0, 0, 1], vHat));
    const qS = qbar * Sw;
    const F = [0, 0, 0];
    addTo(F, scl(liftDir, CL * qS));
    addTo(F, scl(vHat, -CD * qS));
    addTo(F, [0, 0, CY * qS]);
    addTo(F, Fthr);
    // specific force (load factor) along body y — what the FBW regulates
    this.nzAero = F[1] / (this.mass * G);
    // total moments
    const rollUeff = this.rollU || 0;
    const uAct = ClU * (s.ailR - s.ailL) / 2 / (25 * DEG);
    const Lx = Lx0 + qbar * Sw * A350.span * (uAct + AERO.Cldr * s.rud);
    const Ny = Ny0 - qbar * Sw * A350.span * (AERO.Cndr * s.rud + AERO.Cnda * rollUeff);
    const Mz = Mz0 + qbar * Sw * A350.mac * AERO.Cmde * s.elev;
    const Mb = [Lx, Ny, Mz];
    // ---- ground ----
    const gf = this.groundForces(dt, att);
    addTo(Mb, gf.M);
    this.groundM = gf.M;
    // ---- integrate ----
    const m = this.mass;
    const Fw = qrot(this.q, F);
    addTo(Fw, gf.F);
    Fw[1] -= m * G;
    const acc = scl(Fw, 1 / m);
    this.accel = acc;
    this.nz = qinvrot(this.q, add(acc, [0, G, 0]))[1] / G;
    if (this.tow) {
      // pushback / towing: tug drives the nose gear kinematically
      const fwd = qrot(this.q, [1, 0, 0]); const hv = norm([fwd[0], 0, fwd[2]]);
      const v = this.tow.v; this.vel[0] = hv[0] * v; this.vel[2] = hv[2] * v;
      this.vel[1] += acc[1] * dt;
      const yawRate = v * Math.tan(this.tow.steer || 0) / A350.wheelbase;
      this.omega = [this.omega[0] * 0.9, yawRate, this.omega[2] * 0.9];
      Mb[0] *= 0.2;
    } else {
      addTo(this.vel, scl(acc, dt));
    }
    addTo(this.pos, scl(this.vel, dt));
    const [Ix, Iy, Iz] = this.inertia();
    const w = this.omega, Iw = [Ix * w[0], Iy * w[1], Iz * w[2]];
    const gyro = cross(w, Iw);
    if (!this.tow) {
      w[0] += (Mb[0] - gyro[0]) / Ix * dt;
      w[1] += (Mb[1] - gyro[1]) / Iy * dt;
      w[2] += (Mb[2] - gyro[2]) / Iz * dt;
    } else { w[2] += (Mb[2] - gyro[2]) / Iz * dt; w[0] += Mb[0] / Ix * dt; }
    const wm = len(w);
    if (wm > 1e-9) {
      const ang = wm * dt, ax = scl(w, 1 / wm), sn = Math.sin(ang / 2);
      this.q = qnorm(qmul(this.q, [ax[0] * sn, ax[1] * sn, ax[2] * sn, Math.cos(ang / 2)]));
    }
    // ---- indications ----
    this.indications(dt, atm, M, wind);
    // structural limits
    if (!this.onGround && (this.nz > 3.9 || this.nz < -1.9)) this.crash('Structural failure — load factor ' + this.nz.toFixed(1) + ' g');
    if (this.ind.ias > A350.vmo + 45 || M > 0.97) this.crash('Structural failure — exceeded VD/MD');
  }

  indications(dt, atm, M, wind) {
    const p = atm.p, p0 = 101325, a0 = 340.294;
    const qc = p * (Math.pow(1 + 0.2 * M * M, 3.5) - 1);
    const cas = a0 * Math.sqrt(5 * (Math.pow(qc / p0 + 1, 2 / 7) - 1)) / KT;
    this.ind.ias = lerp(this.ind.ias, cas * Math.cos(Math.min(this.alpha, 0.4)) ** 0.5, clamp(dt * 8, 0, 1));
    this.ind.mach = M;
    const baroRef = this.baroRef ?? (this.env.qnh / 100); // hPa
    const pStd = 101325;
    this.ind.palt = (1 - Math.pow(p / pStd, 0.190263)) * 145366.45;
    this.ind.alt = (1 - Math.pow(p / (baroRef * 100), 0.190263)) * 145366.45;
    this.ind.vsi = lerp(this.ind.vsi, this.vel[1] / FT * 60, clamp(dt * 2.5, 0, 1));
    this.ind.sat = atm.T - 273.15; this.ind.tat = this.ind.sat + (this.tas * this.tas) / 2010;
    const gsv = Math.hypot(this.vel[0], this.vel[2]); this.ind.gs = gsv / KT;
    this.ind.windDir = (Math.atan2(-wind[0], wind[2]) / DEG + 360) % 360; this.ind.windKt = Math.hypot(wind[0], wind[2]) / KT;
    this.ra = Math.max(0, this.agl + 0.0);
  }

  groundForces(dt, att) {
    const F = [0, 0, 0], M = [0, 0, 0];
    const c = this.ctrl, s = this.surf, gr = this.gear;
    const S = this.S;
    const fwdW = qrot(this.q, [1, 0, 0]);
    const gearDown = gr.pos > 0.98;
    const y = -(A350.cgHeight + 0.26);
    const contacts = [];
    if (gearDown) {
      contacts.push({ name: 'n', pos: [A350.noseX, y, 0], k: 7.0e5, c: 6e4, steer: true });
      for (const side of [-1, 1]) for (const dx of [-0.95, 0.95])
        contacts.push({ name: side < 0 ? 'l' : 'r', pos: [A350.mainX + dx, y, side * A350.mainZ], k: 2.45e6, c: 1.9e5, brake: side });
    }
    // structural contact points: tail, nacelles, wingtips, belly
    contacts.push({ name: 'tail', pos: [-30.5, 0.05, 0], structural: true });
    contacts.push({ name: 'eng1', pos: [A350.engX + 1.5, A350.engY - 1.45, -A350.engZ], structural: true });
    contacts.push({ name: 'eng2', pos: [A350.engX + 1.5, A350.engY - 1.45, A350.engZ], structural: true });
    contacts.push({ name: 'tipL', pos: [-14, 0.8, -32.2], structural: true });
    contacts.push({ name: 'tipR', pos: [-14, 0.8, 32.2], structural: true });
    contacts.push({ name: 'belly', pos: [6, -3.3, 0], structural: true });
    contacts.push({ name: 'nosebelly', pos: [26, -2.9, 0], structural: true });
    const wow = { n: false, l: false, r: false };
    let comp = { n: 0, l: 0, r: 0 };
    const gsv = Math.hypot(this.vel[0], this.vel[2]);
    // nose wheel steering: tiller (±70°) and pedals (±6°), AP rollout
    const kt = gsv / KT;
    const nwsAvail = S ? S.nwsAvail : true;
    let nws = 0;
    if (nwsAvail) {
      nws = c.tiller * 70 * DEG * clamp((45 - kt) / 30, 0, 1) + (c.pedals + c.rudTrim / 30) * 6 * DEG * clamp((150 - kt) / 110, 0, 1);
      if (this.ap.active && this.ap.nws != null) nws += this.ap.nws * 6 * DEG;
      if (this.tow) nws = this.tow.steer || 0;
    }
    s.nws = lerp(s.nws, clamp(nws, -75 * DEG, 75 * DEG), clamp(dt * 3, 0, 1));
    // brakes
    const brk = this.brakeCommand(dt, gsv);
    let anyGear = false;
    for (const ct of contacts) {
      const rW = qrot(this.q, ct.pos);
      const p = add(this.pos, rW);
      const g = this.env.ground(p[0], p[2], p[1]);
      const pen = g.h - p[1];
      if (pen <= 0) continue;
      const n = g.n;
      const vP = add(this.vel, cross(qrot(this.q, this.omega), rW));
      const vn = dot(vP, n);
      if (g.surface === 'water' && pen > 0.3) { this.crash('Ditched in water'); return { F, M }; }
      if (ct.structural) {
        const vh = len(vP);
        if (ct.name === 'tail' && -vn < 1.8 && vh < 110) { this.tailStrike = true; }
        else if (ct.name === 'belly' && !gearDown) { this.crash('Gear-up landing — belly contact'); return { F, M }; }
        else { this.crash(ct.name === 'tail' ? 'Severe tail strike' : ct.name.startsWith('eng') ? 'Engine pod strike' : ct.name.startsWith('tip') ? 'Wingtip strike' : 'Fuselage impact'); return { F, M }; }
        const Fn = Math.max(0, 4e6 * pen - 2e5 * vn);
        const ft = add(scl(n, Fn), scl(norm(sub(vP, scl(n, vn))), -0.4 * Fn));
        addTo(F, ft); addTo(M, cross(ct.pos, qinvrot(this.q, ft)));
        continue;
      }
      if (-vn > 4.3 && ct.name !== 'n') { this.crash('Landing gear collapse — hard landing ' + Math.round(-vn / FT * 60) + ' fpm'); return { F, M }; }
      anyGear = true; wow[ct.name] = true; comp[ct.name] = Math.max(comp[ct.name], pen);
      let Fn = ct.k * pen * (1 + 1.5 * pen) - ct.c * vn;
      if (pen > 0.55) Fn += (pen - 0.55) * ct.k * 10;
      Fn = Math.max(0, Fn);
      let wheelFwd = fwdW;
      if (ct.steer) {
        const cs = Math.cos(s.nws), sn = Math.sin(s.nws);
        const rightW = qrot(this.q, [0, 0, 1]);
        wheelFwd = add(scl(fwdW, cs), scl(rightW, sn));
      }
      let f1 = norm(sub(wheelFwd, scl(n, dot(wheelFwd, n))));
      const s1 = norm(cross(n, f1));
      const vL = dot(vP, f1), vS = dot(vP, s1);
      const wet = this.env.wetRunway ? 0.6 : 1;
      const mu = (g.surface === 'runway' || g.surface === 'taxiway' || g.surface === 'apron' ? 0.8 : 0.5) * wet;
      const roll = g.surface === 'runway' || g.surface === 'taxiway' || g.surface === 'apron' ? 0.012 : 0.06;
      let b = 0;
      if (ct.brake) b = ct.brake < 0 ? brk.L : brk.R;
      const muB = b * 0.48 * wet;
      let fx = -(roll + muB) * Fn * Math.tanh(vL / (b > 0.9 && Math.abs(vL) < 0.3 ? 0.05 : 0.3));
      if (this.tow) fx = 0;
      const fz = -mu * Fn * Math.tanh(vS / 0.12);
      const ft = add(scl(n, Fn), add(scl(f1, fx), scl(s1, fz)));
      addTo(F, ft);
      addTo(M, cross(ct.pos, qinvrot(this.q, ft)));
      if (ct.brake && b > 0 && Math.abs(vL) > 0.5) this.brakeEnergy += Math.abs(fx * vL) * dt;
    }
    // touchdown detection
    const mainNow = wow.l || wow.r;
    if (mainNow && !this.prevWow && this.vel[1] < 0) {
      this.touchdown = { sink: -this.vel[1], t: this.time, v: this.ind.ias, pitch: att.pitch, roll: att.roll, x: this.pos[0], z: this.pos[2] };
    }
    this.wowTime = mainNow ? (this.wowTime || 0) + dt : 0;
    this.prevWow = mainNow;
    this.wow = wow; this.gearComp = comp;
    this.onGround = anyGear;
    if (!anyGear && !mainNow) this.wowTime = 0;
    // brake temperatures (WHEEL page): energy into carbon heat sinks, cooling with time
    const heat = this.brakeEnergy; this.brakeEnergy = 0;
    for (let i = 0; i < 4; i++) {
      const b = i < 2 ? brk.L : brk.R;
      this.brakeTemp[i] += heat / 4 / 4.2e6 * (0.9 + 0.1 * i) + (b > 0.1 ? 0 : 0) - (this.brakeTemp[i] - (this.ind.sat ?? 15)) * dt * (S?.brakeFans ? 0.004 : 0.0012);
    }
    // ground spoilers
    this.groundSpoilers(dt, mainNow, gsv);
    this.wheelSpin = (this.wheelSpin + gsv / 0.67 * dt) % (Math.PI * 2);
    return { F, M };
  }

  groundSpoilers(dt, mainNow, gsv) {
    const c = this.ctrl, s = this.surf;
    const idle = c.tla[0] < 0.06 && c.tla[1] < 0.06, rev = c.tla[0] < -0.02 || c.tla[1] < -0.02;
    let deploy = false;
    if (mainNow && (c.spdArm || rev) && (idle || rev) && gsv > 10 * KT) deploy = true;
    // rejected takeoff above 72 kt
    if (mainNow && this.ind.ias > 72 && idle && this.takeoffRoll) { deploy = true; this.rto = true; }
    if (this.gsDeployed && mainNow && !(c.tla[0] > 0.2 || c.tla[1] > 0.2) && (c.spdArm || rev || this.rto)) deploy = true;
    if (!mainNow && this.ra > 10) deploy = false;
    if (c.tla[0] > 0.2 || c.tla[1] > 0.2) deploy = false;
    this.gsDeployed = deploy;
    s.gndSpl = clamp(s.gndSpl + (deploy ? 60 : -25) * DEG * dt, 0, 50 * DEG);
    if (this.ind.ias > 40 && mainNow && (c.tla[0] > 0.55 || c.tla[1] > 0.55)) this.takeoffRoll = true;
    if (!mainNow && this.ra > 50) this.takeoffRoll = false;
  }

  brakeCommand(dt, gsv) {
    const c = this.ctrl, ab = this.abrk, S = this.S;
    const brakesOk = S ? (S.hydP.G > 2000 || S.hydP.Y > 2000 || S.brakeAccu > 0.1) : true;
    const pedal = Math.max(c.brakeL, c.brakeR);
    // autobrake engage / disengage
    const decelTbl = { LO: 1.7, '2': 2.0, '3': 3.0, HI: 3.7, RTO: 9, BTV: 2.4 };
    if (!ab.active && ab.mode !== 'OFF' && this.gsDeployed) {
      if (ab.mode === 'RTO' ? this.rto : (ab.mode !== 'RTO' && !this.takeoffRoll)) { ab.active = true; ab.i = 0; this.abrkActiveT = 0; }
    }
    if (ab.active && (pedal > 0.55 || c.tla[0] > 0.2 || c.tla[1] > 0.2 || ab.mode === 'OFF' || !this.onGround)) {
      ab.active = false; this.abrkDisc = true; if (pedal > 0.55 || c.tla[0] > 0.2) ab.mode = 'OFF';
    }
    let auto = 0;
    if (ab.active) {
      let tgt = decelTbl[ab.mode] || 2;
      if (ab.mode === 'BTV' && ab.btvStop) {
        const fwd = qrot(this.q, [1, 0, 0]);
        const dist = Math.max(50, (ab.btvStop.x - this.pos[0]) * fwd[0] + (ab.btvStop.z - this.pos[2]) * fwd[2]);
        const v = gsv, vExit = 12;
        tgt = clamp((v * v - vExit * vExit) / (2 * dist), 1.0, 3.5);
        if (v < vExit + 1) tgt = 0.5;
      }
      ab.decel = tgt;
      const fwd = qrot(this.q, [1, 0, 0]);
      const decel = -dot(this.accel, fwd);
      ab.i = clamp(ab.i + (tgt - decel) * dt * 0.4, 0, 1);
      auto = clamp(ab.i + (tgt - decel) * 0.15, 0, 1);
      if (ab.mode === 'RTO') auto = 1;
      if (gsv < 0.5) auto = 0.6;
      this.abrkActiveT += dt;
    }
    this.abrkBrake = auto;
    const park = c.parkBrake ? 1 : 0;
    if (!brakesOk && !c.parkBrake) return { L: 0, R: 0 };
    const L = Math.max(c.brakeL, auto, park), R = Math.max(c.brakeR, auto, park);
    return { L: S && S.hydP.G < 2000 && !S.antiSkid ? L * 0.8 : L, R };
  }

  crash(reason) {
    if (this.crashed) return;
    this.crashed = reason;
    for (const e of this.E) { e.running = false; e.P = 0; }
  }
}
