// Cessna 172S Skyhawk SP — blade element flight dynamics model.
// Approach follows the method X-Plane describes: the wings, stabilizers, fin and propeller blades are
// broken into elements; the local velocity of each element is found from the aircraft's linear and
// angular velocity (plus downwash and prop-wash), coefficients come from airfoil curves with finite-wing
// corrections, and the forces are summed into total force and moment about the CG, then integrated.
//
// Body frame: +x forward, +y up, +z right (origin = CG). World: +X east, +Y up, +Z south.
import { v3, add, sub, scl, dot, cross, len, norm, addTo, clamp, lerp, smoothstep, DEG, qmul, qnorm, qrot, qinvrot, qFromHPR, hprFromQ } from './math.js';

const G = 9.80665;
const KT = 0.514444;
const FT = 0.3048;
const HP = 745.7;
const INHG = 3386.389;

// ---------- Atmosphere (ISA + deviation + QNH) ----------
export function atmosphere(alt, isaDev = 0, qnhPa = 101325) {
  const T0 = 288.15 + isaDev;
  const Tstd = 288.15 - 0.0065 * Math.min(alt, 11000);
  const T = T0 - 0.0065 * Math.min(alt, 11000);
  const p = qnhPa * Math.pow(Tstd / 288.15, 5.25588);
  const rho = p / (287.053 * T);
  return { T, p, rho, sigma: rho / 1.225, a: Math.sqrt(1.4 * 287.053 * T) };
}

// ---------- Airfoil curves ----------
// Lift coefficient with post-stall blend to flat plate (Viterna-like)
function clCurve(a, a0, slope, clmax, clmin) {
  const as = clmax / slope + a0;
  const an = clmin / slope + a0;
  const fp = 1.12 * Math.sin(2 * a);
  if (a >= an && a <= as) {
    // soften the last ~3 deg before stall (real section curves bend over)
    const lin = slope * (a - a0);
    const k = smoothstep(as - 0.06, as, a);
    return lin - k * 0.06 * slope * 0.25;
  }
  if (a > as) {
    const d = a - as;
    const peak = clmax * (1 - 0.06 * 0.25 * slope / clmax);
    const drop = peak * (1 - 0.28 * smoothstep(0, 0.08, d));
    return lerp(drop, fp, smoothstep(0.08, 0.5, d));
  }
  const d = an - a;
  const drop = clmin * (1 - 0.28 * smoothstep(0, 0.08, d));
  return lerp(drop, fp, smoothstep(0.08, 0.5, d));
}
function stallFrac(a, a0, slope, clmax) {
  const as = clmax / slope + a0;
  return smoothstep(as - 0.01, as + 0.08, a);
}

// ---------- Aircraft definition (C172S, POH data) ----------
export const C172 = {
  emptyMass: 767, // kg  (1,691 lb)
  wingArea: 16.2, span: 11.0, AR: 7.47,
  inertia: [1285, 2667, 1825], // roll(x), yaw(y), pitch(z) kg m^2 (JSBSim c172 values converted)
  propRadius: 0.965, propPitch: 1.524, // McCauley 1A170E/JHA7660: 76in dia, 60in pitch
  propAxis: [2.15, 0.0, 0],
  engineHP: 180, maxRPM: 2700,
  fuelCapGal: 26.5, // usable per tank
  vne: 163, vno: 129, vfe10: 110, vfe: 85,
};

export const C152 = {
  rollRig: 0.105, // aileron/wing rigging, set so cruise is hands-off neutral
  apRollOnly: true, // optional ARC Navomatic 200A single-axis wing leveler (roll only)
  emptyMass: 504, // kg (1,111 lb)
  wingArea: 14.9, span: 10.16, AR: 6.93,
  inertia: [700, 1200, 1000],
  propRadius: 0.91, propPitch: 1.37,
  propAxis: [2.05, 0.0, 0],
  engineHP: 110, maxRPM: 2550,
  fuelCapGal: 24,
  vne: 149, vno: 111, vfe10: 95, vfe: 85,
  visualScale: 0.92,
  carb: true, // O-235 carburetted engine: primer + carb heat
};

export const AIRCRAFT_PROFILES = { C172, C152 };

function buildElements(profile = C172) {
  const scale = profile.visualScale ?? 1;
  const els = [];
  // Wing: LE at x=+0.45, constant chord 1.63 inboard to 2.6 m, taper to 1.12 at 5.5 m. Dihedral 1.73 deg.
  const bounds = [0.30, 1.0, 1.75, 2.6, 3.3, 4.0, 4.75, 5.5];
  for (const side of [-1, 1]) {
    for (let i = 0; i < bounds.length - 1; i++) {
      const z0 = bounds[i], z1 = bounds[i + 1], zc = (z0 + z1) / 2;
      const chord = (z) => (z < 2.6 ? 1.63 : lerp(1.63, 1.12, (z - 2.6) / 2.9));
      const c = (chord(z0) + chord(z1)) / 2;
      const area = c * (z1 - z0);
      const dih = 1.73 * DEG;
      const y = (0.95 + zc * Math.tan(dih)) * scale;
      const inc = lerp(1.5, -1.5, (zc - 0.3) / 5.2) * DEG; // washout
      els.push({
        kind: 'wing', side, idx: i, area: area * scale * scale, chord: c * scale,
        pos: [(0.45 - 0.25 * c) * scale, y, side * zc * scale],
        span: [0, Math.sin(dih), side * Math.cos(dih)],
        inc, a0: -2.1 * DEG, slope: 5.05, clmax: 1.74, clmin: -1.15, cd0: 0.0085, cm0: -0.05,
        flap: zc < 2.9 ? Math.min(1, (2.9 - z0) / (z1 - z0)) : 0,
        ail: zc > 2.9 && zc < 5.1 ? 1 : 0,
        prop: zc < 1.15 ? 1 : 0,
        stall: 0, cl: 0, alpha: 0,
      });
    }
  }
  // Horizontal stabilizer + elevator: total 3.97 m^2, span 3.45 m
  const hb = [0.15, 0.68, 1.2, 1.72];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const z0 = hb[i], z1 = hb[i + 1], zc = (z0 + z1) / 2;
      const c = lerp(1.32, 0.95, zc / 1.72);
      els.push({
        kind: 'htail', side, idx: i, area: c * (z1 - z0) * 1.13 * scale * scale, chord: c * scale,
        pos: [(-4.62 - 0.12 * zc) * scale, 0.12 * scale, side * zc * scale], span: [0, 0, side],
        inc: -2.6 * DEG, a0: 0, slope: 3.9, clmax: 1.05, clmin: -1.05, cd0: 0.008, cm0: 0,
        prop: zc < 1.0 ? 1 : 0, stall: 0, cl: 0, alpha: 0,
      });
    }
  }
  // Vertical fin + rudder (swept). Lift direction lateral.
  const vb = [0.25, 0.65, 1.05, 1.42];
  for (let i = 0; i < 3; i++) {
    const y0 = vb[i], y1 = vb[i + 1], yc = (y0 + y1) / 2;
    const c = lerp(1.55, 0.95, (yc - 0.25) / 1.17);
    els.push({
      kind: 'vtail', idx: i, area: c * (y1 - y0) * 1.05 * scale * scale, chord: c * scale,
      pos: [(-4.75 - 0.45 * (yc - 0.25)) * scale, yc * scale, 0], span: [0, 1, 0],
      inc: 0, a0: 0, slope: 3.3, clmax: 1.0, clmin: -1.0, cd0: 0.008, cm0: 0,
      prop: yc < 0.9 ? 1 : 0, stall: 0, cl: 0, alpha: 0,
    });
  }
  return els;
}

// Landing gear & structural contact points (body frame)
function buildContacts(profile = C172) {
  const scale = profile.visualScale ?? 1;
  return [
    { name: 'nose', gear: true, pos: [1.36 * scale, -1.22 * scale, 0], k: 34000, c: 2600, travel: 0.20, mu: 0.75, steer: true },
    { name: 'left', gear: true, pos: [-0.30 * scale, -1.22 * scale, -1.27 * scale], k: 62000, c: 5200, travel: 0.13, mu: 0.8, brake: -1 },
    { name: 'right', gear: true, pos: [-0.30 * scale, -1.22 * scale, 1.27 * scale], k: 62000, c: 5200, travel: 0.13, mu: 0.8, brake: 1 },
    { name: 'tail', pos: [-5.55, -0.12, 0], k: 90000, c: 6000, mu: 0.5, structural: true },
    { name: 'lwing', pos: [-0.4, 1.05, -5.5], k: 90000, c: 6000, mu: 0.5, structural: true },
    { name: 'rwing', pos: [-0.4, 1.05, 5.5], k: 90000, c: 6000, mu: 0.5, structural: true },
    { name: 'prop', pos: [2.15, -0.965, 0], k: 90000, c: 6000, mu: 0.5, structural: true, prop: true },
    { name: 'belly', pos: [0.4, -0.65, 0], k: 120000, c: 9000, mu: 0.5, structural: true },
    { name: 'cowl', pos: [1.5, -0.55, 0], k: 120000, c: 9000, mu: 0.5, structural: true },
    { name: 'roof', pos: [0.0, 1.05, 0], k: 120000, c: 9000, mu: 0.5, structural: true },
    { name: 'fin', pos: [-5.4, 1.42, 0], k: 120000, c: 9000, mu: 0.5, structural: true },
  ];
}

// Propeller blade elements: radius stations
const PROP_R = [0.25, 0.42, 0.58, 0.73, 0.86, 0.94];
const PROP_DR = [0.18, 0.16, 0.16, 0.14, 0.12, 0.06];
const PROP_C = [0.150, 0.148, 0.138, 0.124, 0.104, 0.080];

export class FDM {
  constructor(profile = C172) {
    this.aircraft = profile;
    this.els = buildElements(profile);
    this.contacts = buildContacts(profile);
    this.env = {
      ground: () => ({ h: 0, n: [0, 1, 0], surface: 'runway' }),
      wind: [0, 0, 0], gust: 0, turbulence: 0, isaDev: 0, qnh: 101325,
    };
    this.reset({ pos: [0, 0, 0], hdg: 0, onGround: true });
  }

  setAircraft(profile = C172) {
    this.aircraft = profile;
    this.els = buildElements(profile);
    this.contacts = buildContacts(profile);
  }

  reset({ pos, hdg = 0, alt = null, speedKt = 0, onGround = true, coldDark = false, pitch = 0 }) {
    this.pos = pos.slice();
    this.q = qFromHPR(hdg, onGround ? 0 : pitch, 0);
    const fwd = qrot(this.q, [1, 0, 0]);
    this.vel = scl(fwd, speedKt * KT);
    this.omega = [0, 0, 0];
    this.time = 0;
    this.crashed = null;
    this.onGround = onGround;
    this.ctrl = { elev: 0, ail: 0, rud: 0, throttle: coldDark ? 0 : onGround ? 0.0 : 0.62, mixture: coldDark ? 0 : 1, flaps: 0, trim: 0.0, brakeL: 0, brakeR: 0, parkBrake: onGround, toeBrake: 0 };
    this.flapPos = 0; // degrees actual
    this.surf = { elev: 0, ail: 0, rud: 0 };
    const running = !coldDark;
    this.sys = {
      master: running, alternator: running, avionics: running, fuelPump: false, beacon: running, nav: running, strobe: !onGround && running,
      landing: false, taxi: onGround && running, pitotHeat: false, mags: running ? 3 : 0, // 0 OFF 1 R 2 L 3 BOTH 4 START
      fuelSel: 'BOTH', fuelL: 24, fuelR: 24, // gallons
      starter: false, cabinLights: false, panelLights: false,
      engineFailed: false, alternatorFailed: false, vacuumFailed: false,
      // added cockpit controls
      avionics2: running, fuelShutoff: true, carbHeat: false, primer: 0, primeT: 0, cabinHeat: 0, cabinAir: 0, altStatic: false,
      extPower: false, cb: {}, panelDim: 0.6, radioDim: 0.8, gsDim: 0, pedDim: 0, annDim: false,
    };
    this.eng = {
      running, rpm: running ? (onGround ? 750 : 2350) : 0, map: 0, egt: running ? 1200 : 70, cht: running ? 300 : 70,
      oilT: running ? 160 : 70, oilP: running ? 60 : 0, ff: 0, power: 0, torque: 0, vac: running ? 5 : 0, propOmega: 0,
      thrust: 0, propTorque: 0, vi: 0, ampsLoad: 0, busV: running ? 28 : 24.3, battery: 1,
    };
    this.eng.propOmega = this.eng.rpm * 2 * Math.PI / 60;
    this.gyro = { aiSpin: running ? 1 : 0, hiSpin: running ? 1 : 0, tcSpin: running ? 1 : 0, hiDrift: 0, compass: hdg, compassRate: 0, aiErrP: 0, aiErrR: 0 };
    this.ind = { vsi: 0, alt: 0, ias: 0 };
    this.downwash = 0;
    this.accel = [0, 0, 0]; this.nz = 1; this.sideForce = 0;
    this.stallWarn = false;
    this.ge = 0;
    this.groundContact = { nose: 0, left: 0, right: 0 };
    this.touchdown = null; this.lastSink = 0;
    this.gearComp = { nose: 0, left: 0, right: 0 };
    this.prevVy = 0;
    this.turbState = [0, 0, 0, 0, 0, 0];
    this.alpha = 0; this.beta = 0; this.tas = speedKt * KT;
    this.overstress = false;
    if (onGround) this.settleOnGround();
  }

  triggerFailure(type) {
    if (type === 'engine') {
      this.sys.engineFailed = true;
      this.eng.running = false;
      this.eng.ff = 0;
      this.eng.power = 0;
    } else if (type === 'alternator') {
      this.sys.alternatorFailed = true;
    } else if (type === 'vacuum') {
      this.sys.vacuumFailed = true;
    } else if (type === 'fuel') {
      this.sys.fuelSel = 'LEFT';
      this.sys.fuelL = 0;
    }
  }

  resetFailures() {
    const recoveringEngine = this.sys.engineFailed;
    this.sys.engineFailed = false;
    this.sys.alternatorFailed = false;
    this.sys.vacuumFailed = false;
    if (recoveringEngine) {
      this.eng.running = true;
      this.eng.rpm = Math.max(this.eng.rpm, 2300);
      this.eng.propOmega = this.eng.rpm * Math.PI / 30;
    }
  }

  // Solve for 1-g level (or gamma) flight at the current speed: adjust AoA & elevator trim until
  // vertical acceleration and pitching acceleration vanish. Used for in-air spawns/repositions.
  trimAir(gammaDeg = 0, iters = 500) {
    const hpr = { hdg: this.attitude?.hdg ?? 0 };
    const spd = len(this.vel);
    const turb = this.env.turbulence; this.env.turbulence = 0;
    const pos0 = this.pos.slice();
    let alpha = 4 * DEG, trim = this.ctrl.trim || 0;
    const g = gammaDeg * DEG;
    const h = hpr.hdg * DEG;
    const dir = [Math.sin(h) * Math.cos(g), Math.sin(g), -Math.cos(h) * Math.cos(g)];
    for (let i = 0; i < iters; i++) {
      this.pos = pos0.slice();
      this.q = qFromHPR(hpr.hdg, (g + alpha) / DEG, 0);
      this.vel = scl(dir, spd); this.omega = [0, 0, 0];
      this.ctrl.trim = trim; this.ctrl.elev = 0; this.surf.elev = 0;
      const vy0 = this.vel[1];
      this.step(1 / 240);
      const ay = (this.vel[1] - vy0) * 240, qd = this.omega[2] * 240;
      alpha = clamp(alpha - ay * 0.0009, -4 * DEG, 14 * DEG);
      trim = clamp(trim - qd * 0.004, -1, 1);
    }
    this.pos = pos0; this.q = qFromHPR(hpr.hdg, (g + alpha) / DEG, 0); this.vel = scl(dir, spd); this.omega = [0, 0, 0];
    this.ctrl.trim = trim; this.env.turbulence = turb;
    this.ind.ias = spd / KT; this.ind.alt = this.ind.alt || 0;
    return { alpha: alpha / DEG, trim };
  }

  settleOnGround() {
    // place aircraft so gear springs are near static compression
    const g = this.env.ground(this.pos[0], this.pos[2], this.pos[1]);
    this.pos[1] = g.h + 1.22 + 0.03;
    this.vel = [0, 0, 0];
  }

  get mass() {
    return this.aircraft.emptyMass + 77 + 14 /*oil*/ + (this.sys.fuelL + this.sys.fuelR) * 2.72 /*kg per gal avgas*/ + (this.payload ?? 80);
  }

  // ---- Engine: Lycoming IO-360-L2A, 180 hp @ 2700 rpm ----
  engineTorque(dt, atm, Vaxial) {
    const e = this.eng, s = this.sys, c = this.ctrl;
    const rpm = e.propOmega * 60 / (2 * Math.PI);
    const pAmb = atm.p / INHG; // inHg
    // manifold pressure: throttle butterfly; at low throttle, intake vacuum depends on rpm
    const thr = clamp(c.throttle, 0, 1);
    const open = 0.017 + 0.983 * Math.pow(thr, 1.35);
    const pump = clamp(rpm / this.aircraft.maxRPM, 0, 1.2);
    let map = pAmb * open / (open + 0.16 * pump * (1 - open) + 0.012 * pump) * 0.985;
    if (!e.running) map = lerp(pAmb, map, clamp(rpm / 600, 0, 1));
    e.map = lerp(e.map || pAmb, map, clamp(dt * 8, 0, 1));
    // fuel available?
    const fuelAvail = (s.fuelSel === 'BOTH' ? s.fuelL + s.fuelR : s.fuelSel === 'LEFT' ? s.fuelL : s.fuelSel === 'RIGHT' ? s.fuelR : 0) > 0.05 && s.fuelSel !== 'OFF' && s.fuelShutoff !== false;
    // fuel-air ratio from mixture lever (fuel injection meters fuel by rpm/throttle, density not compensated)
    const mix = clamp(c.mixture, 0, 1);
    const far = mix < 0.02 ? 0 : (0.032 + 0.062 * mix) / Math.pow(atm.sigma, 0.92);
    e.far = far;
    // combustion efficiency vs FAR
    let eff;
    if (far < 0.047 || far > 0.17) eff = 0;
    else if (far < 0.082) eff = 1 - Math.pow((0.082 - far) / 0.035, 2) * 0.9;
    else eff = 1 - Math.pow((far - 0.082) / 0.1, 2) * 0.9;
    eff = clamp(eff, 0, 1);
    const magOK = s.mags === 3 || s.mags === 4 ? 1 : s.mags === 1 || s.mags === 2 ? 0.965 : 0;
    const canRun = fuelAvail && magOK > 0 && eff > 0.15 && !s.engineFailed;
    // starter
    let starterTq = 0;
    const busOK = s.master && (e.battery > 0.05 || s.extPower);
    if (s.mags === 4 && busOK) { starterTq = 210 * clamp(1 - rpm / 320, 0, 1); e.ampsLoad += 120; e.battery -= dt * 0.0012; }
    if (!e.running && canRun && rpm > 140 && s.mags >= 1 && mix > 0.3) {
      // start catch rate depends on priming: carburetted 152 uses the plunger primer,
      // the fuel-injected 172S is primed by running the fuel pump with mixture rich
      let rate = 3.5;
      const cold = e.oilT < 110;
      if (this.aircraft.carb) { const p = s.primer || 0; if (cold) rate = p < 1 ? 0.25 : p > 6 ? 0.3 /* flooded */ : 3.0; }
      else if (cold && (s.primeT || 0) < 1) rate = 0.8;
      if (Math.random() < dt * rate) e.running = true;
    }
    if (e.running && (!canRun || rpm < 120 || s.engineFailed)) e.running = false;
    // indicated power: proportional to MAP and rpm (air mass flow)
    if (!this.aircraft.carb && s.fuelPump && mix > 0.5 && fuelAvail && s.master) s.primeT = (s.primeT || 0) + dt;
    if (e.running) { s.primer = 0; }
    let pInd = 0;
    if (e.running) {
      const mapEff = Math.max(0, e.map - 2.6) / (29.92 - 2.6);
      pInd = this.aircraft.engineHP * HP * 1.105 * mapEff * (rpm / this.aircraft.maxRPM) * eff * magOK * Math.sqrt(288.15 / atm.T);
      if (s.carbHeat) pInd *= 0.94; // warm intake air: ~75 rpm drop
    }
    // friction & pumping losses
    const fric = (6.5 + 0.0045 * rpm + 0.0000026 * rpm * rpm) * HP * 0.5 * clamp(rpm / 120, 0, 1);
    const omega = Math.max(e.propOmega, 1);
    const tq = (pInd - fric) / omega + starterTq;
    e.power = Math.max(0, pInd - fric);
    // fuel flow (gal/hr): bsfc ~0.45 lb/hp/hr at best power, richer => more fuel
    const airflow = (e.map / 29.92) * (rpm / this.aircraft.maxRPM) * atm.sigma * Math.sqrt(288.15 / atm.T); // fraction
    e.ff = e.running ? 14.6 * airflow * far / 0.095 * Math.pow(atm.sigma, 0.0) : 0;
    // EGT peaks near stoichiometric (0.067)
    const egtTarget = e.running ? 1050 + 400 * Math.exp(-Math.pow((far - 0.068) / 0.022, 2)) * (0.6 + 0.4 * (e.power / (180 * HP))) + 150 * (e.power / (180 * HP)) : atm.T * 1.8 - 459.67;
    e.egt = lerp(e.egt, egtTarget, clamp(dt * 0.4, 0, 1));
    const coolV = Math.max(Vaxial, 0) + 20 * (rpm / this.aircraft.maxRPM);
    const chtTarget = e.running ? 150 + 300 * (e.power / (180 * HP)) * Math.exp(-Math.pow((far - 0.072) / 0.05, 2)) * 1.1 - coolV * 0.35 + 120 : atm.T * 1.8 - 459.67;
    e.cht = lerp(e.cht, chtTarget, clamp(dt * 0.02, 0, 1));
    const oilTarget = e.running ? 150 + 60 * (e.power / (180 * HP)) - Math.max(0, coolV - 40) * 0.12 + (atm.T - 288) * 0.9 : atm.T * 1.8 - 459.67;
    e.oilT = lerp(e.oilT, oilTarget, clamp(dt * 0.006, 0, 1));
    const oilPTarget = clamp(rpm / this.aircraft.maxRPM, 0, 1) * 80 * (1 - (e.oilT - 160) * 0.002) + (rpm > 300 ? 10 : 0) * 0;
    e.oilP = lerp(e.oilP, rpm > 200 ? Math.max(oilPTarget, 25 * rpm / 700 > 25 ? 25 : 25 * rpm / 700) : 0, clamp(dt * 2, 0, 1));
    // vacuum pump (engine-driven), suction inHg
    e.vac = lerp(e.vac, s.vacuumFailed ? 0 : clamp(rpm / 1000, 0, 1) * 5.2, clamp(dt * 3, 0, 1));
    // fuel burn
    const burn = e.ff * dt / 3600;
    if (burn > 0) {
      if (s.fuelSel === 'BOTH') { const l = s.fuelL > 0 ? 0.5 : 0, r = s.fuelR > 0 ? 0.5 : 0; const t = l + r || 1; s.fuelL = Math.max(0, s.fuelL - burn * l / t); s.fuelR = Math.max(0, s.fuelR - burn * r / t); }
      else if (s.fuelSel === 'LEFT') s.fuelL = Math.max(0, s.fuelL - burn);
      else if (s.fuelSel === 'RIGHT') s.fuelR = Math.max(0, s.fuelR - burn);
    }
    return tq;
  }

  // ---- Propeller blade element (2 blades evaluated at 4 azimuths, half weight each) ----
  propForces(vBody, atm, out) {
    const e = this.eng;
    const R = this.aircraft.propRadius, A = Math.PI * R * R;
    const Om = e.propOmega;
    const Va = vBody[0];
    const vi = e.vi;
    let T = 0, Q = 0;
    const F = [0, 0, 0], M = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const psi = k * Math.PI / 2 + 0.3;
      const rhat = [0, Math.cos(psi), Math.sin(psi)];
      const that = cross([1, 0, 0], rhat); // blade motion direction (clockwise seen from cockpit)
      for (let i = 0; i < PROP_R.length; i++) {
        const r = PROP_R[i] * R, dr = PROP_DR[i] * R, c = PROP_C[i];
        const beta = Math.atan(this.aircraft.propPitch / (2 * Math.PI * r)) - 0.6 * DEG;
        const Vt = Om * r + dot(vBody, that) * 1.0;
        const Vax = Va + vi * (1 - Math.pow(PROP_R[i], 3) * 0.4);
        const phi = Math.atan2(Vax, Math.max(Vt, 0.1));
        const aoa = beta - phi;
        const W2 = Vt * Vt + Vax * Vax;
        const cl = clCurve(aoa, -4.5 * DEG, 5.6, 1.35, -0.9);
        const st = stallFrac(aoa, -4.5 * DEG, 5.6, 1.35);
        const cd = 0.010 + 0.018 * cl * cl + 0.06 * st + 2.2 * st * Math.sin(aoa) ** 2;
        const tipLoss = PROP_R[i] > 0.9 ? 0.82 : 1;
        const q = 0.5 * atm.rho * W2 * c * dr * 0.5 * tipLoss; // 0.5: 2 blades over 4 azimuths
        const dT = q * (cl * Math.cos(phi) - cd * Math.sin(phi));
        const dFt = q * (cl * Math.sin(phi) + cd * Math.cos(phi));
        T += dT; Q += dFt * r;
        const p = add(this.aircraft.propAxis, scl(rhat, r));
        const f = add([dT, 0, 0], scl(that, -dFt));
        addTo(F, f); addTo(M, cross(p, f));
      }
    }
    // shaft torque (-Q about x) is carried by the prop/engine and returned to the airframe as engine reaction in step();
    // keep only off-axis blade moments here (P-factor, gyroscopic asymmetry)
    M[0] += Q;
    // momentum theory induced velocity (relaxed)
    const Ts = Math.max(T, 0);
    const viTarget = 0.5 * (-Math.max(Va, 0) + Math.sqrt(Math.max(Va, 0) ** 2 + 2 * Ts / (atm.rho * A)));
    e.vi = lerp(e.vi, viTarget, 0.25);
    e.thrust = T; e.propTorque = Q;
    out.F = F; out.M = M; out.Q = Q;
  }

  turbulence(dt) {
    const k = this.env.turbulence || 0;
    const ts = this.turbState;
    const tau = [1.6, 1.2, 1.9, 0.6, 0.5, 0.7];
    for (let i = 0; i < 6; i++) {
      const g = (Math.random() + Math.random() + Math.random() - 1.5) * 2;
      ts[i] += (-ts[i] / tau[i] + g * Math.sqrt(2 / tau[i]) / Math.sqrt(dt) * 0.3) * dt;
    }
    const agl = Math.max(1, this.pos[1] - this.env.ground(this.pos[0], this.pos[2], this.pos[1]).h);
    const mech = clamp(agl / 300, 0.3, 1);
    return [ts[0] * k * 1.6 * mech, ts[1] * k * 1.3 * mech, ts[2] * k * 1.6 * mech, ts[3] * k * 0.6, ts[4] * k * 0.4, ts[5] * k * 0.6];
  }

  step(dt) {
    if (this.crashed) return;
    this.time += dt;
    const c = this.ctrl, s = this.sys, e = this.eng;
    const atm = atmosphere(this.pos[1], this.env.isaDev, this.env.qnh);
    this.atm = atm;
    e.ampsLoad = 0;

    // control surfaces follow inputs with actuator lag (cables)
    const rate = dt * 12;
    this.surf.elev = lerp(this.surf.elev, clamp(c.elev, -1, 1), clamp(rate, 0, 1));
    this.surf.ail = lerp(this.surf.ail, clamp(c.ail, -1, 1), clamp(rate, 0, 1));
    this.surf.rud = lerp(this.surf.rud, clamp(c.rud, -1, 1), clamp(rate, 0, 1));
    // electric flaps: ~ 3 deg/s, needs bus power
    const flapTarget = [0, 10, 20, 30][clamp(c.flaps | 0, 0, 3)];
    if (s.master && e.battery > 0.02 && s.cb?.FLAP !== false) {
      const d = flapTarget - this.flapPos;
      this.flapPos += clamp(d, -3.2 * dt, 3.2 * dt);
      if (Math.abs(d) > 0.01) e.ampsLoad += 8;
    }

    // wind + turbulence
    const turb = this.turbulence(dt);
    const g0 = this.env.ground(this.pos[0], this.pos[2], this.pos[1]);
    const agl = this.pos[1] - g0.h;
    const wShear = clamp(Math.log(Math.max(agl, 0.5) / 0.05) / Math.log(300 / 0.05), 0.35, 1.0);
    const wind = scl(this.env.wind, wShear * (1 + (this.env.gustFactor || 0)));
    const vAirW = sub(this.vel, add(wind, [turb[0], turb[1], turb[2]]));
    const vB = qinvrot(this.q, vAirW);
    const omB = this.omega;
    const omEff = add(omB, [turb[3] * 0.02, turb[4] * 0.02, turb[5] * 0.02]);
    const tas = len(vB);
    this.tas = tas;
    this.alpha = Math.atan2(-vB[1], Math.max(vB[0], 0.1));
    this.beta = Math.asin(clamp(tas > 0.5 ? vB[2] / tas : 0, -1, 1));

    // ground effect factor (wing height over ground relative to span)
    const hW = Math.max(0.3, agl + 0.0);
    const x = 16 * hW / this.aircraft.span;
    const phiGE = (x * x) / (1 + x * x); // induced drag multiplier
    this.ge = 1 - phiGE;

    const F = [0, 0, 0], M = [0, 0, 0];
    // propeller
    const pf = {};
    this.propForces(vB, atm, pf);
    addTo(F, pf.F); addTo(M, pf.M);
    // engine torque reaction on airframe
    const Qeng = this.engineTorque(dt, atm, vB[0]);
    // roughly half of the shaft torque is returned by the rotating slipstream acting on the wing roots and
    // fuselage (it raises the left wing's angle of attack), so the net torque roll is about 0.5 Q
    addTo(M, [-Qeng * 0.5, 0, 0]);
    // prop rpm dynamics
    const Iprop = 2.1;
    e.propOmega += (Qeng - pf.Q) / Iprop * dt;
    if (e.propOmega < 0) e.propOmega = 0;
    e.rpm = e.propOmega * 60 / (2 * Math.PI);
    if (e.rpm > 3300) e.overspeed = true;

    // propwash: final slipstream velocity increment (contracted), swirl
    const washV = 2 * e.vi;
    const swirl = e.rpm > 200 ? clamp(e.propTorque / (atm.rho * Math.PI * this.aircraft.propRadius ** 2 * Math.max(tas + washV, 5) ** 2 * 0.6), -0.4, 0.4) : 0;

    // wing/aileron rigging (wash-in on left wing) — trims out torque roll at cruise, like the real airframe
    addTo(M, [(this.aircraft.rollRig ?? 0.12) * 0.5 * atm.rho * tas * tas, 0, 0]);

    // aerodynamic surfaces
    let CLw = 0, wingLift = 0;
    const qinf = 0.5 * atm.rho * tas * tas;
    const flapRad = this.flapPos * DEG;
    const flapDCl = 1.2 * Math.sin(flapRad * 1.55) * (this.flapPos > 0 ? 1 : 0);
    let stallMax = 0;
    for (const el of this.els) {
      // local velocity of the air relative to element
      let vLoc = add(vB, cross(omEff, el.pos));
      if (el.prop && washV > 0) {
        vLoc = add(vLoc, [washV * (el.kind === 'wing' ? 0.55 : 0.85), 0, 0]);
      }
      if (el.kind === 'htail' || el.kind === 'vtail') {
        // downwash from wing (lagged one step - physically gives alpha-dot damping)
        const dwA = this.downwash;
        vLoc = add(vLoc, [0, Math.sin(dwA) * len(vLoc), 0]); // air moving down => relative flow from above
      }
      if (el.kind === 'vtail' && el.prop) vLoc = add(vLoc, [0, 0, -swirl * (tas + washV) * 0.15]); // slipstream swirl hits left side of fin
      // remove spanwise flow
      const sp = el.span;
      const vSpan = dot(vLoc, sp);
      const vC = sub(vLoc, scl(sp, vSpan));
      const V2 = dot(vC, vC);
      if (V2 < 0.01) continue;
      const V = Math.sqrt(V2);
      const qd = 0.5 * atm.rho * V2;
      // airflow direction (air moving relative to element) = -vC
      const flow = scl(vC, -1 / V);
      let alpha, liftDir;
      if (el.kind === 'vtail') {
        // "up" of a fin element is +z (right). AoA: flow from the left gives positive force to the right.
        alpha = Math.atan2(-vC[2], vC[0]) + el.inc;
        liftDir = norm(cross(flow, sp)); // perpendicular to flow and span
        if (dot(liftDir, [0, 0, 1]) * Math.sign(alpha || 1) < 0) liftDir = scl(liftDir, -1);
        liftDir = norm(cross(sp, flow));
        // ensure +z for positive alpha
        if (liftDir[2] < 0) liftDir = scl(liftDir, -1);
        // rudder: positive rud = right pedal = trailing edge right => force to left on tail (yaw nose right)
        const rudDefl = -(this.surf.rud + 0.04) * 16 * DEG; // + fixed ground-adjustable rudder trim tab (rigged for cruise)
        alpha += 0.52 * rudDefl;
      } else {
        alpha = Math.atan2(-vC[1], vC[0]) + el.inc;
        liftDir = norm(cross(sp, flow));
        if (liftDir[1] < 0) liftDir = scl(liftDir, -1);
        if (el.kind === 'wing') {
          if (el.flap) alpha += 0; // flaps handled via dCl
          if (el.ail) {
            // positive ail = roll right: right aileron up (less lift), left down
            const up = 20 * DEG, down = 14 * DEG;
            const d = this.surf.ail * (el.side > 0 ? -1 : 1);
            const defl = d > 0 ? d * down : d * up;
            alpha += 0.45 * defl;
          }
        } else if (el.kind === 'htail') {
          // positive elev = pull = trailing edge up = less tail lift
          const d = this.surf.elev;
          const defl = d > 0 ? -d * 28 * DEG : -d * 23 * DEG;
          alpha += 0.55 * defl - 0.52 * c.trim * 9 * DEG;
        }
      }
      el.alpha = alpha;
      let clmax = el.clmax, a0 = el.a0;
      let cl = 0, cdx = 0;
      if (el.kind === 'wing' && el.flap) {
        const f = el.flap;
        a0 = el.a0 - (flapDCl / el.slope) * f;
        clmax = el.clmax + flapDCl * 0.82 * f;
        cdx = 0.055 * Math.pow(this.flapPos / 30, 1.6) * f;
      }
      cl = clCurve(alpha, a0, el.slope, clmax, el.clmin);
      const st = stallFrac(alpha, a0, el.slope, clmax);
      el.stall = st; el.cl = cl;
      if (el.kind === 'wing') {
        // stall turbulence/buffet makes the stall break asymmetric
        if (st > 0.1) cl *= 1 - 0.12 * st * (0.5 + 0.5 * Math.sin(this.time * 9.1 + el.idx * 1.7 + el.side * 2.2));
        stallMax = Math.max(stallMax, st * (el.ail ? 1.0 : 1.25));
      }
      const AR = el.kind === 'wing' ? this.aircraft.AR : el.kind === 'htail' ? 3.0 : 1.6;
      const geF = el.kind === 'wing' ? phiGE : 1;
      const cdi = (cl * cl) / (Math.PI * 0.80 * AR) * geF * 0.85;
      const cd = el.cd0 + 0.006 * cl * cl + cdi + cdx + 1.25 * st * Math.pow(Math.sin(alpha), 2) + (el.ail ? 0.006 * Math.abs(this.surf.ail) : 0);
      const geLift = el.kind === 'wing' ? 1 + 0.08 * (1 - phiGE) : 1;
      const Lf = qd * el.area * cl * geLift, Df = qd * el.area * cd;
      const f = add(scl(liftDir, Lf), scl(flow, Df));
      addTo(F, f);
      addTo(M, cross(el.pos, f));
      // section pitching moment
      if (el.kind === 'wing') {
        const cm = el.cm0 - (el.flap ? 0.10 * (this.flapPos / 30) * el.flap : 0);
        addTo(M, [0, 0, qd * el.area * el.chord * cm * (el.side ? 1 : 1)]);
        CLw += cl * el.area; wingLift += Lf;
      }
    }
    CLw /= this.aircraft.wingArea;
    this.CL = CLw;
    // downwash at tail: eps = 2 CL / (pi AR) reduced in ground effect & by distance factor, lag
    const epsTarget = (2 * CLw / (Math.PI * this.aircraft.AR)) * 1.05 * (0.5 + 0.5 * phiGE);
    this.downwash = lerp(this.downwash, epsTarget, clamp(dt * (tas / 4.6), 0, 1));

    // fuselage, landing gear, struts: parasite drag & side force
    if (tas > 0.3) {
      const flowB = scl(vB, -1 / tas);
      const fpa = 0.46 + 0.02 * Math.abs(Math.sin(this.beta)) * 10 + 0.15 * Math.pow(Math.sin(this.alpha), 2) * 6; // m^2 equivalent flat plate
      const fD = scl(flowB, qinf * fpa);
      addTo(F, fD);
      addTo(M, cross([0.1, -0.15, 0], fD));
      // fuselage side force (side area ~6 m^2), center of pressure ahead of CG -> destabilizing
      const side = -qinf * 6.0 * 0.32 * Math.sin(this.beta) * Math.cos(this.beta);
      const fS = [0, 0, side];
      addTo(F, fS); addTo(M, cross([0.35, 0.1, 0], fS));
      // fuselage normal force (Munk moment)
      const fN = [0, qinf * 1.1 * Math.sin(this.alpha) * Math.cos(this.alpha) * 0.5, 0];
      addTo(F, fN); addTo(M, cross([0.9, 0, 0], fN));
    }
    // small structural/aero rotational damping not captured (fuselage)
    addTo(M, [-omB[0] * 12 * (tas + 5) * 0.02, -omB[1] * 120 * (tas + 5) * 0.02, -omB[2] * 150 * (tas + 5) * 0.02]);

    this.lastM = M.slice(); this.lastF = F.slice();
    // gravity
    const m = this.mass;
    const Fw = qrot(this.q, F);
    Fw[1] -= m * G;

    // ground contact
    const gF = this.groundForces(dt);
    addTo(Fw, gF.F);
    addTo(M, gF.M);

    // ---- integrate ----
    const acc = scl(Fw, 1 / m);
    this.vel = add(this.vel, scl(acc, dt));
    this.pos = add(this.pos, scl(this.vel, dt));
    const I = this.aircraft.inertia;
    // Euler equations: I w' = M - w x (I w)
    const Iw = [I[0] * omB[0], I[1] * omB[1], I[2] * omB[2]];
    const gyro = cross(omB, Iw);
    // propeller gyroscopic effect (prop angular momentum along +x)
    const Hp = [2.1 * e.propOmega, 0, 0];
    const gyroP = cross(omB, Hp);
    const dw = [(M[0] - gyro[0] - gyroP[0]) / I[0], (M[1] - gyro[1] - gyroP[1]) / I[1], (M[2] - gyro[2] - gyroP[2]) / I[2]];
    this.omega = add(omB, scl(dw, dt));
    const w = this.omega;
    const dq = qmul(this.q, [w[0] * 0.5 * dt, w[1] * 0.5 * dt, w[2] * 0.5 * dt, 0]);
    this.q = qnorm([this.q[0] + dq[0], this.q[1] + dq[1], this.q[2] + dq[2], this.q[3] + dq[3]]);

    // load factor & accelerations (body), for instruments / ball
    const specF = qinvrot(this.q, add(acc, [0, G, 0])); // specific force body
    this.accel = specF;
    this.nz = specF[1] / G;
    if (this.nz > 4.6 || this.nz < -2.2) this.overstress = true;
    if (this.nz > 6.5 || this.nz < -3.5) this.crash('Structural failure (overstress ' + this.nz.toFixed(1) + ' G)');
    const ias = Math.sqrt(Math.max(0, 2 * qinf / 1.225)) / KT;
    if (ias > this.aircraft.vne * 1.22) this.crash('Structural failure (exceeded Vne by 22%)');
    if (this.flapPos > 5 && ias > 125) this.flapOverspeed = true;

    // stall warning vane (left wing leading edge) triggers ~5-10 kts before stall
    const wingAlphaMax = this.els.filter((x) => x.kind === 'wing' && x.side < 0 && x.idx === 3)[0].alpha;
    this.stallWarn = s.master && tas > 8 && wingAlphaMax > (13.2 - this.flapPos * 0.06) * DEG;
    this.stallLevel = stallMax;

    this.updateSystems(dt, atm, qinf);
  }

  groundForces(dt) {
    const F = [0, 0, 0], M = [0, 0, 0];
    let any = false;
    const c = this.ctrl;
    const fwdW = qrot(this.q, [1, 0, 0]);
    for (const ct of this.contacts) {
      const rW = qrot(this.q, ct.pos);
      const p = add(this.pos, rW);
      const g = this.env.ground(p[0], p[2], p[1]);
      const pen = g.h - p[1];
      ct.comp = 0;
      if (pen <= 0) { if (ct.gear) this.groundContact[ct.name] = 0; continue; }
      if (g.surface === 'water') { this.crash('Ditched in water'); return { F, M }; }
      const n = g.n;
      const vP = add(this.vel, cross(qrot(this.q, this.omega), rW));
      const vn = dot(vP, n);
      if (ct.structural) {
        const impact = -vn;
        if (ct.prop && this.eng.rpm > 100) { this.crash('Propeller strike'); return { F, M }; }
        if (impact > 3.5 || (ct.name !== 'tail' && len(this.vel) > 25)) { this.crash(ct.name === 'tail' ? 'Tail strike — fuselage damaged' : 'Impact with terrain'); return { F, M }; }
        if (ct.name === 'tail' && impact > 1.5) this.tailStrike = true;
      }
      if (ct.gear && pen > ct.travel + 0.05 && -vn > 3.0) { this.crash('Landing gear collapse (hard landing ' + Math.round(-vn * 196.85) + ' fpm)'); return { F, M }; }
      any = true;
      if (ct.gear) {
        this.groundContact[ct.name] = 1;
        if (this.prevContact && !this.prevContact[ct.name] && -vn > 0.05) {
          this.touchdown = { sink: -vn, t: this.time, name: ct.name, v: len(this.vel) };
        }
      }
      ct.comp = pen;
      let Fn = ct.k * pen - ct.c * vn;
      if (pen > (ct.travel || 0.05)) Fn += (pen - (ct.travel || 0.05)) * ct.k * 8;
      Fn = Math.max(0, Fn);
      const fN = scl(n, Fn);
      // wheel frame on ground plane
      let wheelFwd = fwdW;
      if (ct.steer) {
        const steer = -c.rud * 10 * DEG * clamp(1.4 - len(this.vel) / 30, 0.3, 1);
        const upW = qrot(this.q, [0, 1, 0]);
        // rotate forward around body up
        const cs = Math.cos(steer), sn = Math.sin(steer);
        const rightW = qrot(this.q, [0, 0, 1]);
        wheelFwd = add(scl(fwdW, cs), scl(rightW, -sn));
        void upW;
      }
      let f1 = sub(wheelFwd, scl(n, dot(wheelFwd, n))); f1 = norm(f1);
      const s1 = norm(cross(n, f1)); // lateral (left/right)
      const vL = dot(vP, f1), vS = dot(vP, s1);
      let fx = 0, fz = 0;
      const mu = (g.surface === 'runway' ? 1 : g.surface === 'grass' ? 0.75 : 0.85) * (ct.mu || 0.8);
      if (ct.gear) {
        const roll = (g.surface === 'runway' ? 0.018 : g.surface === 'grass' ? 0.06 : 0.09);
        let brake = 0;
        if (ct.brake) {
          brake = Math.max(c.parkBrake ? 1 : 0, c.toeBrake, ct.brake < 0 ? c.brakeL : c.brakeR);
        }
        const muB = brake * 0.55 * (g.surface === 'runway' ? 1 : 0.7);
        fx = -(roll + muB) * Fn * Math.tanh(vL / 0.25);
        // lateral tire force: cornering stiffness saturating
        fz = -mu * Fn * Math.tanh(vS / 0.06);
      } else {
        const sp = Math.hypot(vL, vS) || 1;
        fx = -0.5 * Fn * vL / Math.max(sp, 0.3);
        fz = -0.5 * Fn * vS / Math.max(sp, 0.3);
      }
      const fT = add(scl(f1, fx), scl(s1, fz));
      const ft = add(fN, fT);
      addTo(F, ft);
      // moment in body frame
      const ftB = qinvrot(this.q, ft);
      addTo(M, cross(ct.pos, ftB));
      if (ct.gear) this.gearComp[ct.name] = pen;
    }
    this.prevContact = { ...this.groundContact };
    this.onGround = any;
    return { F, M };
  }

  updateSystems(dt, atm, qinf) {
    const s = this.sys, e = this.eng, gy = this.gyro;
    // electrical: 28V alternator when running and alt switch on; 24V battery
    // circuit breakers: a pulled breaker (cb[name] === false) removes that load
    const cb = (n) => s.cb?.[n] !== false;
    const altOn = s.master && s.alternator && !s.alternatorFailed && e.rpm > 900 && cb('ALT FLD');
    const two = !this.aircraft.carb; // 172S has two avionics buses
    const bus1 = s.avionics && cb('AVN BUS 1'), bus2 = two ? s.avionics2 && cb('AVN BUS 2') : bus1;
    const E = this.eff = {
      beacon: s.beacon && cb('BCN'), nav: s.nav && cb('NAV LT'), strobe: s.strobe && cb('STROBE'), landing: s.landing && cb('LAND LT'), taxi: s.taxi && cb('TAXI LT'),
      pitotHeat: s.pitotHeat && cb('PITOT HT'), fuelPump: s.fuelPump && cb('FUEL PUMP'), panelLights: s.panelLights && cb('INST LT'), cabinLights: s.cabinLights && cb('CABIN LT'),
      tc: cb('TURN COORD'), bus1, bus2,
    };
    let load = 0;
    if (s.master) {
      load += 3; if (bus1) load += 4; if (two && bus2) load += 3; if (E.beacon) load += 1.5; if (E.nav) load += 1.8; if (E.strobe) load += 2.5; if (E.landing) load += 8; if (E.taxi) load += 6; if (E.pitotHeat) load += 10; if (E.fuelPump) load += 4; if (E.panelLights) load += 1; if (E.cabinLights) load += 1;
      load += e.ampsLoad;
    }
    this.eng.amps = altOn ? (e.battery < 0.98 ? 8 : 1.5) : -load;
    if (s.extPower && !altOn) this.eng.amps = e.battery < 0.98 ? 10 : 1;
    if (s.master && !altOn && !s.extPower) e.battery = Math.max(0, e.battery - load * dt / (24 * 3600));
    if (altOn || s.extPower) e.battery = Math.min(1, e.battery + dt * 0.0006);
    e.busV = s.master ? (altOn ? 28.4 : s.extPower ? 28.0 : 22.5 + 1.8 * e.battery - (e.ampsLoad > 50 ? 4 : 0)) : 0;
    this.elec = s.master && e.busV > 16;
    for (const k of ['beacon', 'nav', 'strobe', 'landing', 'taxi', 'pitotHeat', 'fuelPump', 'panelLights', 'cabinLights', 'tc']) E[k] = E[k] && this.elec;
    // avionics: 172S bus 1 = NAV/COM 1, audio; bus 2 = NAV/COM 2, ADF, XPDR, autopilot (simplified)
    const b1 = this.elec && bus1, b2 = this.elec && bus2;
    E.audio = (b1 || b2) && cb('AUDIO'); E.com1 = b1 && cb('NAV/COM 1'); E.com2 = two && b2 && cb('NAV/COM 2');
    E.adf = (two ? b2 : b1) && cb('ADF'); E.xpdr = (two ? b2 : b1) && cb('XPDR'); E.ap = (two ? b2 : b1) && cb('AUTOPILOT'); E.gps = b1 && cb('GPS');
    this.avionicsOn = b1 || b2;
    // gyros: AI & HI vacuum-driven, TC electric
    const vacOK = e.vac > 3.8;
    gy.aiSpin = lerp(gy.aiSpin, vacOK ? 1 : 0, dt * (vacOK ? 0.25 : 0.015));
    gy.hiSpin = lerp(gy.hiSpin, vacOK ? 1 : 0, dt * (vacOK ? 0.25 : 0.015));
    gy.tcSpin = lerp(gy.tcSpin, E.tc ? 1 : 0, dt * (E.tc ? 0.4 : 0.03));
    gy.hiDrift += dt * (0.18 / 60) * (gy.hiSpin > 0.5 ? 1 : 25) * (1 + Math.abs(this.omega[1]) * 2); // deg
    // magnetic compass with lag & swing
    const att = hprFromQ(this.q);
    let dH = ((att.hdg - gy.compass + 540) % 360) - 180;
    // northerly turning error: in bank on N headings compass lags, S leads
    const bankErr = -att.roll * Math.cos(att.hdg * DEG) * 0.35 * clamp(Math.abs(att.roll) / 15, 0, 1);
    dH += bankErr;
    gy.compassRate += (dH * 2.2 - gy.compassRate * 1.4) * dt;
    gy.compass = (gy.compass + gy.compassRate * dt + 360) % 360;
    // pitot-static
    const pitotOK = !(this.icing && !E.pitotHeat);
    const iasRaw = pitotOK ? Math.sqrt(Math.max(0, 2 * qinf * Math.cos(this.alpha) ** 2 / 1.225)) / KT : this.ind.ias;
    // C172 ASI position error: reads low near stall
    let iasPE = iasRaw < 60 ? iasRaw - (60 - iasRaw) * 0.12 : iasRaw;
    if (s.altStatic) iasPE *= 1.04; // alternate static (cabin) reads slightly high
    this.ind.ias = lerp(this.ind.ias, Math.max(0, iasPE), clamp(dt * 6, 0, 1));
    const pStatic = atm.p;
    const kollsmanPa = (this.kollsman ?? 29.92) * INHG;
    const altInd = (1 - Math.pow(pStatic / kollsmanPa, 0.190263)) * 145366.45 + (s.altStatic ? 35 : 0);
    this.ind.alt = lerp(this.ind.alt || altInd, altInd, clamp(dt * 8, 0, 1));
    const vsTrue = this.vel[1] / FT * 60;
    this.ind.vsi = lerp(this.ind.vsi, vsTrue, clamp(dt / 1.8, 0, 1));
    this.ind.paltitude = (1 - Math.pow(pStatic / 101325, 0.190263)) * 145366.45;
    this.ind.oat = atm.T - 273.15;
  }

  crash(reason) {
    if (this.crashed) return;
    this.crashed = reason;
    this.eng.running = false;
  }

  // helpers for UI
  get attitude() { return hprFromQ(this.q); }
}

export { KT, FT, G, INHG, HP };
