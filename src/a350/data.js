// Airbus A350-1000 — published figures and operating limitations used by the simulation.
// Sources: Airbus A350-1000 product page and A350 Family Facts & Figures (Apr 2025), FCOM limitations
// (A350-1000 VFE table), BEA report on F-HTYO (CONF 1 / 1+F logic), Wikipedia A350 specification table.
export const KT = 0.514444;
export const FT = 0.3048;
export const NM = 1852;
export const G = 9.80665;

export const A350 = {
  name: 'Airbus A350-1000',
  reg: 'F-WMIL',
  // geometry (m)
  length: 73.78, span: 64.75, height: 17.08, fuselageWidth: 5.96, wheelbase: 32.48, track: 10.6,
  wingArea: 464.3, mac: 8.2, aspect: 9.03, sweep: 31.9,
  // masses (kg)
  oew: 155000, mtow: 322000, mlw: 236000, mzfw: 223000, maxPayload: 68000, fuelCap: 124800,
  // engines: 2 x Rolls-Royce Trent XWB-97, 97,000 lbf (431.5 kN) each
  engine: 'Trent XWB-97', thrust: 431500, engZ: 10.6, engX: 7.6, engY: -2.75,
  // speeds (kt) / Mach
  vmo: 340, mmo: 0.89, vle: 250, vlo: 250, mle: 0.55, vmcg: 118, vmca: 126,
  ceilingFt: 41450, cruiseMach: 0.85, maxFlapAltFt: 20000,
  rangeNm: 8900, seats: '350-410 (max 480)',
  // inertia (kg m^2) at 280 t, scaled with mass
  Ixx: 2.6e7, Iyy: 3.9e7, Izz: 6.2e7, refMass: 280000,
  // landing gear (body frame, CG origin): nose at +30.6 m, mains 1.9 m aft of CG, bogie track 10.6 m
  noseX: 30.6, mainX: -1.9, mainZ: 5.3, gearY: -4.75, cgHeight: 5.0,
  // cockpit eye (captain), body frame
  eyeCapt: [30.15, 1.47, -0.55], eyeFO: [30.15, 1.47, 0.55],
};

// Slat/flap configurations. lever: 0 1 2 3 4(FULL). CONF 1 is slats only; 1+F adds flaps (below 203 kt / on ground).
export const CONFS = [
  { id: '0', slat: 0, flap: 0, vfe: 340, dCL0: 0.0, clmax: 1.32, dCD: 0.0, dCm: 0.0 },
  { id: '1', slat: 18, flap: 0, vfe: 260, dCL0: 0.12, clmax: 1.62, dCD: 0.007, dCm: 0.0 },
  { id: '1+F', slat: 18, flap: 10, vfe: 231, dCL0: 0.38, clmax: 1.86, dCD: 0.016, dCm: -0.03 },
  { id: '2', slat: 18, flap: 20, vfe: 219, dCL0: 0.58, clmax: 2.02, dCD: 0.030, dCm: -0.05 },
  { id: '3', slat: 22, flap: 26, vfe: 206, dCL0: 0.74, clmax: 2.16, dCD: 0.046, dCm: -0.06 },
  { id: 'FULL', slat: 26, flap: 37.5, vfe: 192, dCL0: 0.98, clmax: 2.36, dCD: 0.080, dCm: -0.08 },
];
export const CONF_IDX = { '0': 0, '1': 1, '1+F': 2, '2': 3, '3': 4, 'FULL': 5 };

// Aerodynamic model (coefficients per rad unless noted)
export const AERO = {
  CLa: 5.6, CL0: 0.22, CD0: 0.0145, k: 0.0405, CDgear: 0.020, CDspoiler: 0.030, CDgndSpoiler: 0.080,
  Mcrit: 0.86, CYb: -0.95,
  Clb: -0.11, Clp: -0.48, Clr: 0.12, Clda: 0.075, Clsp: 0.06, Cldr: 0.012,
  Cm0: 0.02, Cma: -1.45, Cmq: -34, Cmde: 1.35, Cmths: 2.9, Cmadot: -6,
  Cnb: 0.16, Cnr: -0.32, Cnp: -0.03, Cndr: 0.105, Cnda: -0.006,
  ge: 0.18, // ground-effect lift bonus within a half span
};

// THS takeoff setting from CG (%MAC) — the "green band" on the pitch trim indicator
export const thsForCg = (cg) => Math.max(-2, Math.min(3, (34 - cg) * 0.28));

// Thrust lever detents
export const DETENT = { REV_MAX: -1, REV_IDLE: -0.12, IDLE: 0, CLB: 0.62, FLX: 0.82, TOGA: 1 };

// characteristic speeds (CAS, kt) from weight & config
const RHO0 = 1.225;
export function vs1g(mass, conf) { return Math.sqrt(2 * mass * G / (RHO0 * A350.wingArea * CONFS[conf].clmax)) / KT; }
export function speeds(mass, conf, takeoff = false) {
  const vs = vs1g(mass, conf);
  const vls = Math.max(vs * (takeoff ? 1.13 : 1.23), conf === 0 ? 0 : 0);
  const gd = Math.sqrt(2 * mass * G / (RHO0 * A350.wingArea * Math.sqrt(AERO.CD0 / AERO.k))) / KT;
  const S = vs1g(mass, 0) * 1.23 + 4;
  const F = vs1g(mass, 2) * 1.22;
  return { vs, vls, gd, S, F };
}

export const LIVERY = { top: '#f7f8fa', belly: '#eef0f3', tail: '#0d2a5c', accent: '#1b8fd6', title: 'AIRBUS', reg: 'F-WMIL' };

// Checklists (Airbus SOP flow, simplified for the sim)
export const CHECKLISTS = [
  { id: 'cockpit', title: 'Cockpit preparation', items: [
    ['EXT PWR', 'EXT 1 / EXT 2 ON (when AVAIL)', 'ovhd:EXT1'],
    ['BAT 1, EMER 1, EMER 2, BAT 2', 'ON (AUTO)', 'ovhd:BAT1'],
    ['RCDR GND CTL', 'ON', 'ovhd:RCDR'],
    ['CREW SUPPLY', 'ON', 'ovhd:CREWO2'],
    ['ADIRS 1, 2, 3', 'NAV', 'ovhd:IR1'],
    ['APU MASTER / START', 'ON / START', 'ovhd:APUMASTER'],
    ['FUEL PUMPS', 'ALL ON', 'ovhd:FPL1'],
    ['APU BLEED', 'ON (after APU AVAIL)', 'ovhd:APUBLEED'],
    ['EXT LT', 'NAV / LOGO ON', 'ovhd:NAV'],
    ['SIGNS', 'SEAT BELTS ON, NO MOBILE AUTO, EMER EXIT ARM', 'ovhd:SEATBELT'],
    ['MFD: INIT / F-PLN / FUEL&LOAD / PERF', 'COMPLETED', 'mfd'],
    ['OIS T.O PERF', 'COMPUTED, SENT', 'ois'],
    ['BARO REF', 'SET (QNH)', 'fcu:BARO'],
    ['FCU', 'ALT, HDG SET', 'fcu:ALT'],
  ] },
  { id: 'start', title: 'Before start / engine start', items: [
    ['BEACON', 'ON', 'ovhd:BEACON'],
    ['PARKING BRAKE', 'ON', 'ped:PARK'],
    ['THRUST LEVERS', 'IDLE', 'ped:THR'],
    ['ENG MODE SEL', 'IGN / START', 'ped:ENGMODE'],
    ['ENG 2 MASTER', 'ON — wait for AVAIL', 'ped:MASTER2'],
    ['ENG 1 MASTER', 'ON — wait for AVAIL', 'ped:MASTER1'],
    ['ENG MODE SEL', 'NORM', 'ped:ENGMODE'],
    ['APU BLEED / APU', 'OFF', 'ovhd:APUBLEED'],
    ['GND SPLRS', 'ARM', 'ped:SPDBRK'],
    ['FLAPS', '1 (1+F)', 'ped:FLAPS'],
    ['PITCH TRIM', 'SET (green band)', 'ped:TRIM'],
  ] },
  { id: 'taxi', title: 'Taxi / before takeoff', items: [
    ['NOSE LT', 'TAXI', 'ovhd:NOSE'],
    ['AUTO BRK', 'RTO', 'main:ABRK'],
    ['FLT CTL', 'CHECKED (sidestick / pedals)', 'stick'],
    ['T.O CONFIG', 'TEST — no warning', 'ped:TOCONFIG'],
    ['XPDR / TCAS', 'AUTO / TA/RA', 'ped:SURV'],
    ['STROBE', 'ON', 'ovhd:STROBE'],
    ['LAND LT / NOSE', 'ON / T.O', 'ovhd:LAND'],
  ] },
  { id: 'takeoff', title: 'Takeoff', items: [
    ['THRUST', '50% N1, then FLX/MCT (or TOGA)', 'ped:THR'],
    ['FMA', 'MAN FLX  SRS  RWY  A/THR (blue)', 'pfd'],
    ['V1 / ROTATE', 'Rotate at VR to SRS bars', 'stick'],
    ['POSITIVE CLIMB', 'GEAR UP', 'main:GEAR'],
    ['AP', 'AP1 above 100 ft', 'fcu:AP1'],
    ['THR RED (LVR CLB)', 'THRUST LEVERS CL', 'ped:THR'],
    ['F speed / S speed', 'FLAPS 1, FLAPS 0', 'ped:FLAPS'],
  ] },
  { id: 'approach', title: 'Approach / landing', items: [
    ['BARO / MINIMUMS', 'SET', 'fcu:BARO'],
    ['AUTO BRK', 'LO / 2 / BTV', 'main:ABRK'],
    ['LS pb', 'ON', 'fcu:LS'],
    ['APPR pb', 'ARMED (LOC, G/S blue)', 'fcu:APPR'],
    ['FLAPS', '1 at S, 2 at F, gear down, 3, FULL', 'ped:FLAPS'],
    ['GEAR', 'DOWN', 'main:GEAR'],
    ['GND SPLRS', 'ARM', 'ped:SPDBRK'],
    ['AP 2', 'ON for autoland (CAT 3 DUAL)', 'fcu:AP2'],
    ['RETARD', 'THRUST LEVERS IDLE', 'ped:THR'],
    ['REVERSERS', 'MAX REV, then IDLE REV at 70 kt', 'ped:THR'],
  ] },
  { id: 'parking', title: 'Parking / securing', items: [
    ['PARKING BRAKE', 'ON', 'ped:PARK'],
    ['ENG MASTERS', 'OFF', 'ped:MASTER1'],
    ['BEACON', 'OFF', 'ovhd:BEACON'],
    ['FUEL PUMPS', 'OFF', 'ovhd:FPL1'],
    ['ADIRS', 'OFF', 'ovhd:IR1'],
    ['APU', 'OFF', 'ovhd:APUMASTER'],
    ['BATTERIES', 'OFF', 'ovhd:BAT1'],
  ] },
];
