// A350-1000 aircraft systems: ELEC, APU, FIRE, HYD, FUEL, F/CTL computers, ADIRS, AIR / bleed / packs,
// pressurisation, anti-ice, lights, signs, oxygen, recorders, doors — plus the Flight Warning System
// (ECAM warnings/cautions with procedures, memos, sensed normal checklists) and T.O CONFIG test.
import { clamp, lerp } from '../math.js';
import { A350, KT, FT, CONFS, thsForCg } from './data.js';

// ---- overhead control catalog: id -> { t: type, d: default (running aircraft), cd: cold & dark default, pos: selector positions }
export const OV = {
  // ELEC
  BAT1: { t: 'pb', d: true, cd: false }, BATEMER1: { t: 'pb', d: true, cd: false }, BATEMER2: { t: 'pb', d: true, cd: false }, BAT2: { t: 'pb', d: true, cd: false },
  EXT1: { t: 'pb', d: false, cd: false }, EXT2: { t: 'pb', d: false, cd: false }, APUGEN: { t: 'pb', d: true, cd: true },
  GEN1A: { t: 'pb', d: true, cd: true }, GEN1B: { t: 'pb', d: true, cd: true }, GEN2A: { t: 'pb', d: true, cd: true }, GEN2B: { t: 'pb', d: true, cd: true },
  DRIVE1: { t: 'guard', d: false, cd: false }, DRIVE2: { t: 'guard', d: false, cd: false }, BUSTIE: { t: 'pb', d: true, cd: true },
  GALLEY: { t: 'pb', d: true, cd: true }, COMMERCIAL: { t: 'pb', d: true, cd: true }, RATMAN: { t: 'guardm', d: false, cd: false }, EMERGENTEST: { t: 'pbm', d: false, cd: false },
  // APU
  APUMASTER: { t: 'pb', d: false, cd: false }, APUSTART: { t: 'pb', d: false, cd: false },
  // FIRE
  ENGFIRE1: { t: 'guard', d: false, cd: false }, ENGFIRE2: { t: 'guard', d: false, cd: false }, APUFIRE: { t: 'guard', d: false, cd: false },
  AGENT1_1: { t: 'pbm' }, AGENT1_2: { t: 'pbm' }, AGENT2_1: { t: 'pbm' }, AGENT2_2: { t: 'pbm' }, APUAGENT: { t: 'pbm' },
  FIRETEST1: { t: 'pbm' }, FIRETEST2: { t: 'pbm' }, APUFIRETEST: { t: 'pbm' },
  // HYD
  GENG1: { t: 'pb', d: true, cd: true }, GENG2: { t: 'pb', d: true, cd: true }, YENG1: { t: 'pb', d: true, cd: true }, YENG2: { t: 'pb', d: true, cd: true },
  GELEC: { t: 'pb', d: false, cd: false }, YELEC: { t: 'pb', d: false, cd: false },
  // FUEL
  FPL1: { t: 'pb', d: true, cd: false }, FPL2: { t: 'pb', d: true, cd: false }, FPC1: { t: 'pb', d: true, cd: false }, FPC2: { t: 'pb', d: true, cd: false },
  FPR1: { t: 'pb', d: true, cd: false }, FPR2: { t: 'pb', d: true, cd: false }, XFEED1: { t: 'pb', d: false, cd: false }, XFEED2: { t: 'pb', d: false, cd: false },
  TKXFR: { t: 'pb', d: false, cd: false }, JETTARM: { t: 'guard', d: false, cd: false }, JETTACTIVE: { t: 'pb', d: false, cd: false },
  // F/CTL
  PRIM1: { t: 'pb', d: true, cd: true }, PRIM2: { t: 'pb', d: true, cd: true }, PRIM3: { t: 'pb', d: true, cd: true },
  SEC1: { t: 'pb', d: true, cd: true }, SEC2: { t: 'pb', d: true, cd: true }, SEC3: { t: 'pb', d: true, cd: true },
  // ADIRS
  IR1: { t: 'sel', pos: ['OFF', 'NAV', 'ATT'], d: 1, cd: 0 }, IR2: { t: 'sel', pos: ['OFF', 'NAV', 'ATT'], d: 1, cd: 0 }, IR3: { t: 'sel', pos: ['OFF', 'NAV', 'ATT'], d: 1, cd: 0 },
  ADR1: { t: 'pb', d: true, cd: true }, ADR2: { t: 'pb', d: true, cd: true }, ADR3: { t: 'pb', d: true, cd: true },
  // AIR
  PACK1: { t: 'pb', d: true, cd: true }, PACK2: { t: 'pb', d: true, cd: true }, PACKFLOW: { t: 'sel', pos: ['LO', 'NORM', 'HI'], d: 1, cd: 1 },
  HOTAIR1: { t: 'pb', d: true, cd: true }, HOTAIR2: { t: 'pb', d: true, cd: true },
  CKPTTEMP: { t: 'knob', d: 0.5, cd: 0.5 }, CABTEMP: { t: 'knob', d: 0.5, cd: 0.5 },
  ENGBLEED1: { t: 'pb', d: true, cd: true }, ENGBLEED2: { t: 'pb', d: true, cd: true }, APUBLEED: { t: 'pb', d: false, cd: false },
  XBLEED: { t: 'sel', pos: ['SHUT', 'AUTO', 'OPEN'], d: 1, cd: 1 }, RAMAIR: { t: 'guard', d: false, cd: false }, CARGOAIR: { t: 'pb', d: true, cd: true },
  // ANTI ICE
  WINGAI: { t: 'pb', d: false, cd: false }, ENGAI1: { t: 'pb', d: false, cd: false }, ENGAI2: { t: 'pb', d: false, cd: false }, PROBEHEAT: { t: 'pb', d: false, cd: false },
  // CABIN PRESS
  PRESSMODE: { t: 'pb', d: false, cd: false }, CABALT: { t: 'knob', d: 0.3, cd: 0.3 }, DITCHING: { t: 'guard', d: false, cd: false },
  // EXT LT
  STROBE: { t: 'sel', pos: ['OFF', 'AUTO', 'ON'], d: 1, cd: 0 }, BEACON: { t: 'tog', pos: ['OFF', 'ON'], d: 1, cd: 0 }, WING: { t: 'tog', pos: ['OFF', 'ON'], d: 0, cd: 0 },
  NAV: { t: 'sel', pos: ['OFF', '1', '2'], d: 1, cd: 0 }, LOGO: { t: 'tog', pos: ['OFF', 'ON'], d: 1, cd: 0 }, RWYTURN: { t: 'tog', pos: ['OFF', 'ON'], d: 0, cd: 0 },
  LAND: { t: 'tog', pos: ['OFF', 'ON'], d: 0, cd: 0 }, NOSE: { t: 'sel', pos: ['OFF', 'TAXI', 'T.O'], d: 0, cd: 0 },
  // SIGNS
  SEATBELT: { t: 'sel', pos: ['OFF', 'AUTO', 'ON'], d: 2, cd: 0 }, NOSMOKING: { t: 'sel', pos: ['OFF', 'AUTO', 'ON'], d: 1, cd: 1 }, NOMOBILE: { t: 'sel', pos: ['OFF', 'AUTO', 'ON'], d: 1, cd: 0 },
  EMEREXIT: { t: 'sel', pos: ['OFF', 'ARM', 'ON'], d: 1, cd: 0 },
  // INT LT
  OVHDLT: { t: 'knob', d: 0.7, cd: 0.7 }, ANNLT: { t: 'sel', pos: ['TEST', 'BRT', 'DIM'], d: 1, cd: 1 }, DOME: { t: 'sel', pos: ['OFF', 'DIM', 'BRT'], d: 0, cd: 1 },
  // WIPERS
  WIPERC: { t: 'sel', pos: ['OFF', 'INT', 'LO', 'HI'], d: 0, cd: 0 }, WIPERF: { t: 'sel', pos: ['OFF', 'INT', 'LO', 'HI'], d: 0, cd: 0 },
  RAINC: { t: 'pbm' }, RAINF: { t: 'pbm' },
  // OXYGEN / CALLS / EVAC / RCDR / ENG MAN START / CARGO
  CREWO2: { t: 'pb', d: true, cd: false }, MASKMAN: { t: 'guardm' }, PAXO2: { t: 'guardm' },
  CALLMECH: { t: 'pbm' }, CALLALL: { t: 'pbm' }, CALLEMER: { t: 'pbm' },
  EVACCMD: { t: 'guard', d: false, cd: false }, EVACHORN: { t: 'pbm' }, EVACSEL: { t: 'tog', pos: ['CAPT', 'CAPT&PURS'], d: 0, cd: 0 },
  RCDR: { t: 'pb', d: true, cd: false }, CVRTEST: { t: 'pbm' }, CVRERASE: { t: 'pbm' },
  MANSTART1: { t: 'pb', d: false, cd: false }, MANSTART2: { t: 'pb', d: false, cd: false },
  CARGOSMOKE: { t: 'pbm' }, AVNCSVENT: { t: 'pb', d: false, cd: false },
};

const ECL_NORMAL = [
  { title: 'BEFORE START', items: [
    ['COCKPIT PREP', 'COMPLETED (BOTH)', null], ['GEAR PINS & COVERS', 'REMOVED', null],
    ['SIGNS', 'ON / AUTO', (S) => S.ov.SEATBELT >= 1], ['ADIRS', 'NAV', (S) => S.ov.IR1 === 1 && S.ov.IR2 === 1 && S.ov.IR3 === 1],
    ['FUEL QUANTITY', '___KG', null], ['T.O DATA', 'SET', (S) => !!S.fms?.perf?.v1], ['BARO REF', '___ (BOTH)', null],
    ['WINDOWS / DOORS', 'CLOSED (BOTH)', (S) => S.doorsClosed()], ['BEACON', 'ON', (S) => S.ov.BEACON === 1],
    ['THR LEVERS', 'IDLE', (S) => S.fdm.ctrl.tla[0] <= 0.02 && S.fdm.ctrl.tla[1] <= 0.02], ['PARKING BRAKE', 'AS RQRD', null],
  ] },
  { title: 'AFTER START', items: [
    ['ANTI ICE', 'AS RQRD', null], ['ECAM STATUS', 'CHECKED', null], ['PITCH TRIM', '___ IN T.O RANGE', (S) => S.trimInRange()],
    ['RUDDER TRIM', 'NEUTRAL', (S) => Math.abs(S.fdm.ctrl.rudTrim) < 0.3],
  ] },
  { title: 'BEFORE TAKEOFF', items: [
    ['FLIGHT CONTROLS', 'CHECKED (BOTH)', null], ['FLT INST', 'CHECKED (BOTH)', null], ['BRIEFING', 'CONFIRMED', null],
    ['FLAP SETTING', 'CONF ___ (BOTH)', (S) => S.confIdx() >= 1 && S.confIdx() <= 4], ['V1, VR, V2 / FLX TEMP', '___ (BOTH)', (S) => !!S.fms?.perf?.v1],
    ['ATC', 'SET', null], ['ECAM MEMO', 'T.O NO BLUE', (S) => S.toMemoGreen()], ['CABIN', 'READY', null], ['ENG MODE SEL', 'AS RQRD', null],
    ['PACKS', 'AS RQRD', null],
  ] },
  { title: 'AFTER TAKEOFF / CLIMB', items: [
    ['LDG GEAR', 'UP', (S) => S.fdm.gear.lever === 0 && S.fdm.gear.pos < 0.02], ['FLAPS', 'RETRACTED', (S) => S.confIdx() === 0],
    ['PACKS', 'ON', (S) => S.ov.PACK1 && S.ov.PACK2], ['BARO REF', '___ (BOTH)', null],
  ] },
  { title: 'APPROACH', items: [
    ['BRIEFING', 'CONFIRMED', null], ['ECAM STATUS', 'CHECKED', null], ['SEAT BELTS', 'ON', (S) => S.ov.SEATBELT === 2],
    ['BARO REF', '___ (BOTH)', null], ['MINIMUM', '___ (BOTH)', null], ['AUTO BRAKE', '___', (S) => S.fdm.abrk.mode !== 'OFF'],
    ['ENG MODE SEL', 'AS RQRD', null],
  ] },
  { title: 'LANDING', items: [
    ['ECAM MEMO', 'LDG NO BLUE', (S) => S.ldgMemoGreen()], ['CABIN', 'READY', null],
  ] },
  { title: 'AFTER LANDING', items: [
    ['RADAR & PWS', 'OFF', null], ['SPOILERS', 'DISARMED', (S) => !S.fdm.ctrl.spdArm], ['FLAPS', 'RETRACTED', (S) => S.confIdx() === 0],
    ['APU', 'START', (S) => S.ov.APUMASTER],
  ] },
  { title: 'PARKING', items: [
    ['APU BLEED', 'ON', (S) => S.ov.APUBLEED], ['ENGINES', 'OFF', (S) => !S.master[0] && !S.master[1]], ['SEAT BELTS', 'OFF', (S) => S.ov.SEATBELT === 0],
    ['EXT LT', 'AS RQRD', null], ['FUEL PUMPS', 'OFF', (S) => !S.ov.FPL1 && !S.ov.FPR1 && !S.ov.FPL2 && !S.ov.FPR2], ['PARK BRK & CHOCKS', 'AS RQRD', null],
  ] },
  { title: 'SECURING THE AIRCRAFT', items: [
    ['OXYGEN', 'OFF', (S) => !S.ov.CREWO2], ['EMER EXIT LT', 'OFF', (S) => S.ov.EMEREXIT === 0], ['EFB', 'OFF', null], ['BAT', 'OFF', (S) => !S.ov.BAT1 && !S.ov.BAT2],
  ] },
];

export class Systems {
  constructor(fdm) {
    this.fdm = fdm; fdm.S = this;
    this.events = [];
    this.reset(true);
  }

  emit(name, arg) { this.events.push([name, arg]); }

  reset(coldDark, opts = {}) {
    this.ov = {};
    for (const [k, v] of Object.entries(OV)) this.ov[k] = v.t === 'pbm' || v.t === 'guardm' ? false : (coldDark ? v.cd : v.d) ?? false;
    this.mom = {}; // momentary pb press timers
    this.guardOpen = {};
    this.master = [!coldDark, !coldDark];
    this.engMode = 'NORM';
    this.manStart = [false, false];
    this.firePushed = [false, false]; this.apuFirePushed = false;
    this.agent = { e1: [1, 1], e2: [1, 1], apu: 1 };
    this.fire = { e1: false, e2: false, apu: false };
    this.gpu = !!opts.gpu; this.extOn = [false, false];
    this.bat = [1, 1, 1, 1];
    this.apu = { n: coldDark ? 0 : 0, egt: 15, avail: false, starting: false, flap: 0, cool: 0, bleedUsed: false, running: false };
    this.hydP = { G: coldDark ? 0 : 5000, Y: coldDark ? 0 : 5000 };
    this.brakeAccu = coldDark ? 0.9 : 1;
    this.antiSkid = true; this.brakeFans = false; this.gravityGear = false;
    this.ir = [0, 1, 2].map(() => ({ state: coldDark ? 'OFF' : 'NAV', t: 0, align: coldDark ? 0 : 1, onBat: 0 }));
    this.fastAlign = opts.fastAlign !== false;
    this.cab = { alt: (this.fdm.pos?.[1] || 0) / FT, vs: 0, temp: 22, ckptTemp: 22, ldgElev: null, deltaP: 0 };
    this.du = {}; // display units: power-on boot timers
    this.doors = { L1: !!coldDark, L2: false, L3: false, L4: false, R1: false, R2: false, R3: false, R4: false, FWDCARGO: !!coldDark, AFTCARGO: !!coldDark, BULK: false, AVNCS: false };
    this.alerts = []; this.alertState = {}; this.cleared = new Set(); this.recall = false;
    this.masterWarn = false; this.masterCaut = false; this.emerCanc = new Set();
    this.memos = [];
    this.toConfigTest = 0; this.toConfigOk = false;
    this.sdPage = 'AUTO'; this.sdAuto = 'DOOR'; this.sdElec = 'AC';
    this.eclOpen = false; this.eclIdx = 0; this.eclDone = ECL_NORMAL.map((c) => c.items.map(() => false)); this.ecl = ECL_NORMAL;
    this.ewdMode = 'ALERTS';
    this.ped = { ckptDoor: 1, xpdr: 1, tcas: 2, squawk: '2000', terr: true, gpws: true, wxr: false, gsMode: true, flapMode: true };
    this.lights = { panel: 0.8, flood: 0.3, dome: 0, storm: false };
    this.time = 0; this.phase = 1;
    this.acPowered = !coldDark; this.dcPowered = !coldDark; this.essPowered = !coldDark;
    this.wiper = [0, 0];
    this.ice = 0;
    this.eff = {};
    this.callsCabin = 0;
    this.chimeLock = {};
    this.prevAp = false;
  }

  // ---- helpers used by FDM ----
  fuelFeed(i) {
    const f = this.fdm.fuel; const side = i === 0 ? f.L : f.R; const other = i === 0 ? f.R : f.L;
    const xf = this.ov.XFEED1 || this.ov.XFEED2;
    const pumps = i === 0 ? (this.ov.FPL1 || this.ov.FPL2) : (this.ov.FPR1 || this.ov.FPR2);
    const powered = this.acPowered || this.essPowered;
    const suction = this.fdm.ind.palt < 30000;
    const ok = (side > 5 || (xf && other > 5) || (f.C > 5 && (this.ov.FPC1 || this.ov.FPC2) && powered));
    return ok && ((pumps && powered) || suction);
  }
  startAir(i) {
    const apuBleed = this.ov.APUBLEED && this.apu.avail;
    const other = this.fdm.E[1 - i];
    const crossBleed = this.ov.ENGBLEED1 && this.ov.ENGBLEED2 && other.running && other.n3 > 60 && this.ov.XBLEED !== 0 && (this.ov[`ENGBLEED${2 - i}`]);
    const ownSide = this.ov[`ENGBLEED${i + 1}`] !== undefined;
    return (apuBleed && (this.ov.XBLEED !== 0 || i === 0) && ownSide) || crossBleed || !!this.gndAirCart;
  }
  get nwsAvail() { return this.hydP.Y > 2000 && !(this.ped.towing) || this.hydP.G > 2000; }
  get speedbrakeInhibit() { return this.confIdx() === 5 || this.fdm.prot.alpha || this.fdm.prot.aFloor; }
  confIdx() {
    const s = this.fdm.surf; if (s.slat < 2 && s.flap < 2) return 0;
    if (s.flap < 4) return 1; if (s.flap < 15) return 2; if (s.flap < 23) return 3; if (s.flap < 31) return 4; return 5;
  }
  trimInRange() { const t = thsForCg(this.fdm.cgMac); return Math.abs(this.fdm.surf.ths - t) < 1.2; }
  doorsClosed() { return Object.values(this.doors).every((d) => !d); }
  irAligned(n = 2) { return this.ir.filter((r) => r.state === 'NAV' && r.align >= 1).length >= n; }
  attValid() { return this.ir.some((r) => (r.state === 'NAV' && r.align >= 1) || (r.state === 'ATT' && r.t > 30)); }
  hdgValid() { return this.ir.some((r) => r.state === 'NAV' && r.align >= 1); }
  adrValid() { return [this.ov.ADR1, this.ov.ADR2, this.ov.ADR3].some(Boolean) && (this.essPowered || this.acPowered); }
  duOn(id) { return (this.du[id]?.t ?? 0) > 0; }
  duBooting(id) { const d = this.du[id]; return d && d.t > 0 && d.t < 8; }

  // ---- user actions ----
  press(id, val) {
    const def = OV[id]; if (!def) return false;
    if (def.t === 'pb') { this.ov[id] = val ?? !this.ov[id]; }
    else if (def.t === 'guard') { this.ov[id] = val ?? !this.ov[id]; }
    else if (def.t === 'pbm' || def.t === 'guardm') { this.mom[id] = 0.4; this.momentary(id); }
    else if (def.t === 'sel' || def.t === 'tog') { const n = def.pos.length; this.ov[id] = val != null ? clamp(val, 0, n - 1) : (this.ov[id] + 1) % n; }
    else if (def.t === 'knob') { this.ov[id] = clamp(val ?? this.ov[id] + 0.1, 0, 1); }
    this.onChange(id);
    return true;
  }
  step(id, dir) {
    const def = OV[id]; if (!def) return;
    if (def.t === 'sel' || def.t === 'tog') this.ov[id] = clamp(this.ov[id] + dir, 0, def.pos.length - 1);
    else if (def.t === 'knob') this.ov[id] = clamp(this.ov[id] + dir * 0.05, 0, 1);
    else this.ov[id] = dir > 0;
    this.onChange(id);
  }
  onChange(id) {
    if (id === 'APUSTART' && this.ov.APUSTART) { if (this.ov.APUMASTER && this.dcPowered && !this.apu.avail) { this.apu.starting = true; } else this.ov.APUSTART = false; }
    if (id === 'APUMASTER' && !this.ov.APUMASTER) { this.ov.APUSTART = false; this.apu.starting = false; this.apu.cool = this.apu.bleedUsed && this.apu.avail ? 60 : 0.1; }
    if (id === 'ENGFIRE1') this.firePushed[0] = this.ov.ENGFIRE1;
    if (id === 'ENGFIRE2') this.firePushed[1] = this.ov.ENGFIRE2;
    if (id === 'APUFIRE') { this.apuFirePushed = this.ov.APUFIRE; if (this.apuFirePushed) { this.ov.APUMASTER = false; this.apu.starting = false; } }
    if (id === 'EXT1' && !this.gpu) this.ov.EXT1 = false;
    if (id === 'EXT2' && !this.gpu) this.ov.EXT2 = false;
    if (id === 'SEATBELT' || id === 'NOSMOKING') this.emit('ding');
    if (id === 'JETTACTIVE' && !this.ov.JETTARM) this.ov.JETTACTIVE = false;
    if (id.startsWith('IR')) { const i = +id[2] - 1; const r = this.ir[i]; const pos = OV[id].pos[this.ov[id]]; if (pos === 'OFF') { r.state = 'OFF'; r.align = 0; r.t = 0; } else if (pos === 'NAV' && r.state !== 'NAV') { r.state = 'NAV'; r.t = 0; if (r.align < 1) r.align = 0.0001; } else if (pos === 'ATT') { r.state = 'ATT'; r.t = 0; } }
  }
  momentary(id) {
    const f = this.fdm;
    if (id === 'AGENT1_1' || id === 'AGENT1_2') { const k = +id[7] - 1; if (this.firePushed[0] && this.agent.e1[k] > 0) { this.agent.e1[k] = 0; this.fireAgent('e1'); } }
    if (id === 'AGENT2_1' || id === 'AGENT2_2') { const k = +id[7] - 1; if (this.firePushed[1] && this.agent.e2[k] > 0) { this.agent.e2[k] = 0; this.fireAgent('e2'); } }
    if (id === 'APUAGENT' && this.apuFirePushed && this.agent.apu > 0) { this.agent.apu = 0; this.fireAgent('apu'); }
    if (id === 'RATMAN') this.ratOut = true;
    if (id === 'EVACHORN') this.evacHorn = false;
    if (id === 'CALLMECH' || id === 'CALLALL' || id === 'CALLEMER') this.emit('ding');
    if (id === 'CVRTEST') this.emit('cvr');
    if (id === 'RAINC' || id === 'RAINF') this.rainRepellent = 30;
    if (id === 'MASKMAN') this.paxMasks = true;
    if (id === 'PAXO2') this.paxMasks = true;
    void f;
  }
  fireAgent(k) {
    this.emit('squib');
    if (k === 'e1' && this.fire.e1 && Math.random() < 0.8 || (k === 'e1' && this.agent.e1[0] + this.agent.e1[1] === 0)) this.fire.e1 = false, this.fdm.E[0].fire = false;
    if (k === 'e2' && this.fire.e2 && Math.random() < 0.8 || (k === 'e2' && this.agent.e2[0] + this.agent.e2[1] === 0)) this.fire.e2 = false, this.fdm.E[1].fire = false;
    if (k === 'apu') this.fire.apu = false;
  }

  // ---- main update ----
  update(dt, ctx) {
    const f = this.fdm, ov = this.ov; this.time += dt;
    for (const k of Object.keys(this.mom)) { this.mom[k] -= dt; if (this.mom[k] <= 0) delete this.mom[k]; }
    const air = !f.onGround;
    const E = f.E;
    // ---------- ELEC ----------
    const extAvail = this.gpu && f.onGround;
    if (!extAvail) { ov.EXT1 = false; ov.EXT2 = false; }
    const batOn = [ov.BAT1, ov.BATEMER1, ov.BATEMER2, ov.BAT2];
    const apuGen = ov.APUGEN && this.apu.avail;
    const gens = [E[0].running && E[0].n3 > 55 && ov.GEN1A && !ov.DRIVE1, E[0].running && E[0].n3 > 55 && ov.GEN1B && !ov.DRIVE1,
      E[1].running && E[1].n3 > 55 && ov.GEN2A && !ov.DRIVE2, E[1].running && E[1].n3 > 55 && ov.GEN2B && !ov.DRIVE2];
    const ext = [ov.EXT1 && extAvail, ov.EXT2 && extAvail];
    const side1 = gens[0] || gens[1] || ext[0], side2 = gens[2] || gens[3] || ext[1];
    const any = side1 || side2 || apuGen;
    // RAT / emergency generator
    if (!any && air && f.ind.ias > 100) this.ratOut = true;
    const ratGen = this.ratOut && f.ind.ias > 110 && air;
    this.ratGen = ratGen;
    const ac1 = side1 || (ov.BUSTIE && any), ac2 = side2 || (ov.BUSTIE && any);
    this.acBus = { '1A': ac1, '1B': ac1, '2A': ac2, '2B': ac2, ESS: ac1 || ac2 || ratGen };
    this.acPowered = ac1 && ac2 || (any && ov.BUSTIE);
    const anyAc = ac1 || ac2;
    const batAvail = batOn.some((b, i) => b && this.bat[i] > 0.02);
    this.dcPowered = anyAc || batAvail;
    this.essPowered = anyAc || ratGen || batAvail;
    this.emerElec = !anyAc && (ratGen || batAvail) && air;
    // batteries charge / drain
    for (let i = 0; i < 4; i++) {
      if (!batOn[i]) continue;
      if (anyAc) this.bat[i] = Math.min(1, this.bat[i] + dt / 1800);
      else if (!ratGen) this.bat[i] = Math.max(0, this.bat[i] - dt / (45 * 60) * (this.apu.starting ? 3 : 1));
    }
    this.elec = { gens, ext, apuGen, ratGen, side1, side2, extAvail, batV: this.bat.map((b, i) => batOn[i] ? 24 + b * 4 + (anyAc ? 0.6 : 0) : 0), load: [gens[0] || ext[0] ? 0.32 : 0, gens[1] ? 0.28 : 0, gens[2] || ext[1] ? 0.3 : 0, gens[3] ? 0.27 : 0, apuGen && !side1 && !side2 ? 0.55 : 0] };
    // display units boot when powered
    const duPower = { CO: this.acPowered || this.acBus['1A'], CI: this.essPowered, CU: this.essPowered, FI: this.acBus['2A'] || this.acPowered, FO: this.acBus['2B'] || this.acPowered, CL: this.acBus['1B'] || this.acPowered, ISIS: this.essPowered };
    for (const [k, p] of Object.entries(duPower)) { const d = this.du[k] || (this.du[k] = { t: 0 }); d.t = p ? d.t + dt : 0; }
    // ---------- APU ----------
    const apu = this.apu;
    if (ov.APUMASTER && this.dcPowered && !this.apuFirePushed) apu.flap = Math.min(1, apu.flap + dt / 8); else if (!apu.running) apu.flap = Math.max(0, apu.flap - dt / 8);
    if (apu.starting && apu.flap >= 1) { apu.running = true; }
    if (apu.running && ov.APUMASTER && !this.apuFirePushed && f.fuel.L + f.fuel.C > 10) {
      apu.n = Math.min(100, apu.n + dt * (apu.n < 50 ? 2.2 : 3.0));
      apu.egt = lerp(apu.egt, apu.n < 60 ? 300 + apu.n * 8 : 520 + (ov.APUBLEED ? 80 : 0), dt * 0.6);
      if (apu.n >= 95 && !apu.avail) { apu.avail = true; apu.starting = false; ov.APUSTART = false; this.emit('apuavail'); }
      if (ov.APUBLEED && apu.avail) apu.bleedUsed = true;
    } else if (apu.running && !ov.APUMASTER) {
      apu.cool -= dt; if (apu.cool <= 0 || this.apuFirePushed) { apu.running = false; apu.avail = false; apu.bleedUsed = false; }
    }
    if (!apu.running) { apu.n = Math.max(0, apu.n - dt * 6); apu.egt = lerp(apu.egt, ctx.oat, dt * 0.05); apu.avail = false; }
    if (!this.dcPowered && apu.running) { apu.running = false; apu.avail = false; }
    // ---------- FIRE ----------
    if (this.fire.e1) E[0].fire = true; if (this.fire.e2) E[1].fire = true;
    if (this.fire.apu && f.onGround && !this.apuAutoExt) { this.apuAutoExt = 3; }
    if (this.apuAutoExt > 0) { this.apuAutoExt -= dt; if (this.apuAutoExt <= 0) { this.ov.APUMASTER = false; this.apu.running = false; this.agent.apu = 0; this.fire.apu = false; } }
    // ---------- HYD (5000 psi) ----------
    const pump = (eng, pb) => pb && E[eng].n3 > 50;
    const gSrc = pump(0, ov.GENG1) || pump(1, ov.GENG2) || (ov.GELEC && this.acPowered) || (!air && this.acPowered && this.fdm.E.some((e) => e.running) && false);
    const ySrc = pump(0, ov.YENG1) || pump(1, ov.YENG2) || (ov.YELEC && this.acPowered) || (!air && this.acPowered && this.ped.towing);
    this.hydP.G = clamp(this.hydP.G + (gSrc ? 2500 : -900) * dt, 0, 5000);
    this.hydP.Y = clamp(this.hydP.Y + (ySrc ? 2500 : -900) * dt, 0, 5000);
    if (this.hydP.Y > 3000) this.brakeAccu = Math.min(1, this.brakeAccu + dt * 0.2);
    else if (f.ctrl.parkBrake && f.ind.gs > 1) this.brakeAccu = Math.max(0, this.brakeAccu - dt * 0.002);
    // ---------- FUEL ----------
    const fu = f.fuel;
    const ffKgS = [E[0].ff / 3600, E[1].ff / 3600];
    const apuFF = apu.running ? (apu.avail ? 140 : 90) / 3600 : 0;
    const ctrPumps = (ov.FPC1 || ov.FPC2) && this.acPowered;
    const burn = (side, kg) => {
      if (ctrPumps && fu.C > 0) { const t = Math.min(fu.C, kg); fu.C -= t; kg -= t; }
      if (kg <= 0) return;
      const xf = ov.XFEED1 || ov.XFEED2;
      if (xf) { const big = fu.L > fu.R ? 'L' : 'R'; const t = Math.min(fu[big], kg); fu[big] -= t; kg -= t; }
      const t = Math.min(fu[side], kg); fu[side] -= t; kg -= t;
      if (kg > 0) { const o = side === 'L' ? 'R' : 'L'; if (xf) fu[o] = Math.max(0, fu[o] - kg); }
    };
    burn('L', (ffKgS[0] + apuFF) * dt); burn('R', ffKgS[1] * dt);
    if (ov.JETTARM && ov.JETTACTIVE && this.acPowered) {
      const rate = 2000 / 60 * dt; const tgt = this.jettTarget ?? 30000;
      if (f.fob > tgt) { const c = Math.min(fu.C, rate); fu.C -= c; const r = rate - c; fu.L = Math.max(0, fu.L - r / 2); fu.R = Math.max(0, fu.R - r / 2); this.jettisoning = true; }
      else { ov.JETTACTIVE = false; this.jettisoning = false; }
    } else this.jettisoning = false;
    if (this.refuel) {
      const r = this.refuel; const rate = 1400 / 60 * dt;
      if (f.fob < r.target - 1) { const need = r.target - f.fob; const add = Math.min(rate, need); const wingCap = A350.fuelCap * 0.36; for (const s of ['L', 'R']) { const a = Math.min(add / 2, wingCap - fu[s]); fu[s] += Math.max(0, a); } const left = r.target - f.fob; if (left > 0 && fu.L >= wingCap - 1) fu.C += Math.min(add, left); r.active = true; }
      else { this.refuel = null; this.emit('refuelDone'); }
    }
    f.fuelFlowTotal = E[0].ff + E[1].ff;
    // ---------- F/CTL computers & laws ----------
    const prims = [ov.PRIM1, ov.PRIM2, ov.PRIM3].filter(Boolean).length, secs = [ov.SEC1, ov.SEC2, ov.SEC3].filter(Boolean).length;
    const adrs = [ov.ADR1, ov.ADR2, ov.ADR3].filter(Boolean).length;
    const irs = this.ir.filter((r) => r.state !== 'OFF' && (r.align >= 1 || r.state === 'ATT')).length;
    let law = 'NORMAL';
    if (!this.essPowered) law = 'DIRECT';
    else if (prims === 0) law = 'DIRECT';
    else if (adrs < 2 || irs < 2 || (this.hydP.G < 1500 && this.hydP.Y < 1500)) law = 'ALTN';
    if (prims + secs === 0) law = 'DIRECT';
    if (f.onGround && irs < 2 && law !== 'DIRECT') law = 'ALTN';
    if (law !== f.law && air) this.emit(law === 'NORMAL' ? '' : 'single');
    f.law = law;
    // ---------- ADIRS ----------
    const alignTime = this.fastAlign ? 75 : 420;
    for (let i = 0; i < 3; i++) {
      const r = this.ir[i]; if (r.state === 'OFF') continue;
      r.t += dt;
      r.onBat = (!this.acPowered && this.essPowered) || r.t < 5 ? 1 : 0;
      if (!this.dcPowered && !this.essPowered) { r.state = 'OFF'; r.align = 0; continue; }
      if (r.state === 'NAV' && r.align < 1) { if (f.ind.gs > 2) r.alignMoved = true; else r.align = Math.min(1, r.align + dt / alignTime); }
    }
    // ---------- AIR: bleed / packs ----------
    const bleed1 = ov.ENGBLEED1 && E[0].running && !this.firePushed[0];
    const bleed2 = ov.ENGBLEED2 && E[1].running && !this.firePushed[1];
    const apuB = ov.APUBLEED && apu.avail;
    const xbOpen = ov.XBLEED === 2 || (ov.XBLEED === 1 && apuB);
    const ductL = bleed1 || (apuB) || (xbOpen && bleed2), ductR = bleed2 || (xbOpen && (bleed1 || apuB));
    this.bleed = { b1: bleed1, b2: bleed2, apu: apuB, xb: xbOpen, ductL, ductR, pL: ductL ? (bleed1 ? 38 + E[0].P * 10 : 42) : 0, pR: ductR ? (bleed2 ? 38 + E[1].P * 10 : 42) : 0 };
    const pack1 = ov.PACK1 && ductL && this.acPowered && !ov.DITCHING, pack2 = ov.PACK2 && ductR && this.acPowered && !ov.DITCHING;
    this.packs = [pack1, pack2];
    // cabin temperature
    const tgtC = 18 + ov.CABTEMP * 12, tgtK = 18 + ov.CKPTTEMP * 12;
    const packs = (pack1 ? 1 : 0) + (pack2 ? 1 : 0) + (ov.RAMAIR && air ? 0.3 : 0);
    this.cab.temp = lerp(this.cab.temp, packs ? tgtC : ctx.oat + (f.onGround ? 6 : 0), dt * (packs ? 0.01 : 0.002));
    this.cab.ckptTemp = lerp(this.cab.ckptTemp, packs ? tgtK : ctx.oat + 6, dt * (packs ? 0.012 : 0.002));
    // pressurisation: AUTO schedule toward 6000 ft max cabin altitude; MAN via target knob
    const altFt = f.pos[1] / FT;
    const field = this.ldgElevFt ?? ctx.fieldElevFt ?? 0;
    let tgt;
    if (ov.PRESSMODE) tgt = ov.CABALT * 14000 - 1000;
    else tgt = f.onGround ? altFt - 10 : Math.max(field, Math.min(6000, altFt * 0.155 + (altFt < 10000 ? field * (1 - altFt / 10000) : 0)));
    const sealed = this.doorsClosed() && (packs > 0 || ov.DITCHING);
    let cvs;
    if (sealed) cvs = clamp((tgt - this.cab.alt) * 0.1, -750, 1000) * (f.onGround && !ov.PRESSMODE ? 1 : 1);
    else cvs = clamp((altFt - this.cab.alt) * 0.08, -3000, 3000);
    if (!sealed && this.cab.alt < altFt) cvs = Math.max(cvs, 0);
    this.cab.vs = lerp(this.cab.vs, cvs, dt * 0.5);
    this.cab.alt += this.cab.vs / 60 * dt;
    if (this.cab.alt < altFt - 9000) this.cab.alt = altFt - 9000; // max delta P
    this.cab.deltaP = clamp((altFt - this.cab.alt) / 2200, -0.5, 9.4);
    if (this.cab.alt > 14000 && !this.paxMasks) { this.paxMasks = true; this.emit('callout', 'Oxygen masks deployed'); }
    // ---------- anti-ice / probe heat / icing ----------
    const inCloud = ctx.inCloud, sat = f.ind.sat;
    const icing = inCloud && sat < 6 && sat > -40 && air;
    const wai = ov.WINGAI && (ductL || ductR) && air;
    const eai = [ov.ENGAI1 && E[0].running, ov.ENGAI2 && E[1].running];
    this.ice = clamp(this.ice + (icing ? (wai ? -0.02 : 0.004) : -0.003) * dt, 0, 1);
    this.iceDetected = icing && this.ice > 0.05;
    f.iceDrag = this.ice * 0.004;
    this.probeHeat = ov.PROBEHEAT || E.some((e) => e.running) || air;
    this.ai = { wai, eai };
    // ---------- lights / signs ----------
    const ess = this.essPowered, acp = this.acPowered || this.acBus.ESS;
    const strobe = ov.STROBE === 2 || (ov.STROBE === 1 && !f.wow.l && !f.wow.r);
    this.eff = {
      beacon: ov.BEACON === 1 && ess, nav: ov.NAV > 0 && ess, logo: ov.LOGO === 1 && acp, wing: ov.WING === 1 && acp, strobe: strobe && ess,
      landing: ov.LAND === 1 && acp, taxi: ov.NOSE >= 1 && acp, noseTO: ov.NOSE === 2 && acp, rwyTurn: ov.RWYTURN === 1 && acp,
      seatBelt: ov.SEATBELT === 2 || (ov.SEATBELT === 1 && (f.gear.pos > 0.5 || f.surf.slat > 2)), cabin: this.acPowered,
    };
    f.eff = this.eff; f.sys.extPower = extAvail;
    this.lights.dome = ov.DOME / 2;
    // ---------- wipers ----------
    for (let i = 0; i < 2; i++) { const m = i === 0 ? ov.WIPERC : ov.WIPERF; const spd = [0, 0.4, 1.1, 1.8][m]; this.wiper[i] = m ? (this.wiper[i] + dt * spd) % 2 : (this.wiper[i] > 0 && this.wiper[i] < 2 ? Math.min(2, this.wiper[i] + dt * 1.1) % 2 : 0); }
    if (this.rainRepellent > 0) this.rainRepellent -= dt;
    // ---------- flight phase (FWS) ----------
    const gs = f.ind.gs, enginesRunning = E.some((e) => e.running);
    const toPower = f.ctrl.tla[0] > 0.55 || f.ctrl.tla[1] > 0.55;
    let ph;
    if (f.onGround) {
      if (!enginesRunning) ph = this.phase >= 8 ? 10 : 1;
      else if (toPower && gs < 80) ph = 3; else if (toPower || (this.phase >= 3 && this.phase <= 4 && gs > 80)) ph = 4;
      else if (this.phase >= 6 && this.phase <= 8) ph = gs > 80 ? 8 : 9;
      else if (this.phase === 9 || this.phase === 10) ph = 9;
      else ph = 2;
      if (ph === 9 && !enginesRunning) ph = 10;
    } else {
      if (f.ra < 1500 * FT && (this.phase <= 5)) ph = f.ra < 1500 * FT && f.ind.vsi > -200 && this.phase <= 5 ? 5 : 6;
      else if (f.ra < 800 * FT && this.phase >= 6 && f.gear.pos > 0.9) ph = 7;
      else ph = 6;
    }
    this.phase = ph;
    // ---------- misc ----------
    this.brakeFans = !!this.ped.brkFan;
    this.antiSkid = this.ped.antiSkid !== false;
    f.flexActive = this.flexActive;
    // ---------- FWS ----------
    this.fws(dt, ctx);
    this.memo(ctx);
    this.autoSD();
  }

  // ---- T.O CONFIG checks (also triggered by setting T.O thrust) ----
  toConfigFaults() {
    const f = this.fdm, out = [];
    const ci = this.confIdx();
    if (ci < 1 || ci > 4) out.push('FLAPS NOT IN T.O CONFIG');
    if (!this.trimInRange()) out.push('PITCH TRIM NOT IN T.O RANGE');
    if (Math.abs(f.ctrl.rudTrim) > 3) out.push('RUD TRIM NOT IN T.O RANGE');
    if (f.ctrl.spdbrk > 0.05) out.push('SPD BRK NOT RETRACTED');
    if (f.ctrl.parkBrake) out.push('PARK BRK ON');
    if (!this.doorsClosed()) out.push('DOORS NOT CLOSED');
    if (!this.fms?.perf?.v1) out.push('T.O SPEEDS NOT INSERTED');
    return out;
  }
  testTOConfig() { this.toConfigTest = 3; const faults = this.toConfigFaults(); this.toConfigOk = faults.length === 0; this.toCfgFaults = faults; if (faults.length) this.emit('crc1'); }

  fws(dt, ctx) {
    const f = this.fdm, ov = this.ov, E = f.E, air = !f.onGround, ph = this.phase;
    const alerts = [];
    const A = (id, lvl, title, lines = [], opts = {}) => alerts.push({ id, lvl, title, lines, ...opts });
    const done = (c) => !!c;
    // engines
    for (let i = 0; i < 2; i++) {
      const n = i + 1, e = E[i];
      if (e.fire) A(`ENG${n}FIRE`, 3, `ENG ${n} FIRE`, [
        ['THR LEVER ' + n, 'IDLE', done(f.ctrl.tla[i] <= 0.02)], ['ENG MASTER ' + n, 'OFF', done(!this.master[i])],
        ['ENG ' + n + ' FIRE P/B', 'PUSH', done(this.firePushed[i])], ['AGENT 1', 'DISCH', done(this.agent['e' + n][0] === 0)],
        ['ATC', 'NOTIFY', false], ['IF FIRE AFTER 30 S: AGENT 2', 'DISCH', done(this.agent['e' + n][1] === 0)],
      ], { page: 'ENG', aural: 'crc' });
      else if (!e.running && this.master[i] && !e.starting && (air || this.wasRunning?.[i]) && !this.firePushed[i]) A(`ENG${n}FAIL`, 2, `ENG ${n} FAIL`, [
        ['ENG MODE SEL', 'IGN', done(this.engMode === 'IGN')], ['THR LEVER ' + n, 'IDLE', done(f.ctrl.tla[i] <= 0.02)],
        ['IF NO RELIGHT AFTER 30 S:', '', false], ['ENG MASTER ' + n, 'OFF', done(!this.master[i])],
      ], { page: 'ENG' });
      else if (!e.running && !this.master[i] && air) A(`ENG${n}SHUT`, 2, `ENG ${n} SHUT DOWN`, [['ATC', 'NOTIFY', false], ['XBLEED', 'OPEN', done(ov.XBLEED === 2)]], { page: 'ENG' });
      if (e.running && e.egt > 900) A(`ENG${n}EGT`, 2, `ENG ${n} EGT OVER LIMIT`, [['THR LEVER ' + n, 'BELOW LIMIT', done(e.egt < 900)]], { page: 'ENG' });
    }
    this.wasRunning = E.map((e, i) => e.running || (this.wasRunning?.[i] && this.master[i]));
    if (this.fire.apu) A('APUFIRE', 3, 'APU FIRE', [['APU FIRE P/B', 'PUSH', done(this.apuFirePushed)], ['APU AGENT', 'DISCH', done(this.agent.apu === 0)], ['APU MASTER SW', 'OFF', done(!ov.APUMASTER)]], { page: 'APU', aural: 'crc' });
    // config warnings when T.O thrust set on ground or by test
    if (f.onGround && (ph === 3 || this.toConfigTest > 0)) {
      for (const msg of this.toConfigFaults()) A('CFG' + msg, msg.includes('DOORS') || msg.includes('SPEEDS') ? 2 : 3, 'CONFIG ' + msg, [], { aural: msg.includes('DOORS') || msg.includes('SPEEDS') ? 'single' : 'crc' });
    }
    if (this.toConfigTest > 0) this.toConfigTest -= dt;
    // overspeed
    const vmax = this.vmax();
    if (f.ind.ias > vmax + 4 && air) A('OVSPD', 3, 'OVERSPEED', [[vmax === A350.vmo ? 'VMO/MMO' : 'VFE/VLE', vmax + ' KT', false], ['SPD', 'REDUCE', false]], { aural: 'crc' });
    // stall (ALTN/DIRECT only — normal law protects)
    if (air && f.law !== 'NORMAL' && f.alpha > f.alphaStall - 1.5 * Math.PI / 180) A('STALL', 3, 'STALL', [['PITCH', 'NOSE DOWN', false], ['THRUST', 'TOGA', false]], { aural: 'stall' });
    // landing gear
    if (air && f.gear.pos < 0.98 && f.ra < 750 * FT && (this.confIdx() >= 4 || (f.ctrl.tla[0] < 0.05 && f.ctrl.tla[1] < 0.05 && f.ra < 750 * FT && f.ind.vsi < -300)) && ph >= 6) A('LGNOTDN', 3, 'L/G GEAR NOT DOWN', [['L/G LEVER', 'DOWN', done(f.gear.lever === 1)]], { aural: 'crc', page: 'WHEEL' });
    // FBW
    if (f.law === 'ALTN') A('ALTN', 2, 'F/CTL ALTN LAW', [['MAX SPEED', '305 KT', false], ['SPD BRK', 'DO NOT USE', false]], { page: 'F/CTL', prot: 'LOST' });
    if (f.law === 'DIRECT') A('DIRECT', 2, 'F/CTL DIRECT LAW', [['MAN PITCH TRIM', 'USE', false], ['MAX SPEED', '305 KT', false]], { page: 'F/CTL' });
    for (const k of ['PRIM1', 'PRIM2', 'PRIM3', 'SEC1', 'SEC2', 'SEC3']) if (!ov[k] && this.essPowered) A(k, 1, `F/CTL ${k.slice(0, -1)} ${k.slice(-1)} FAULT`, [[k.slice(0, -1) + ' ' + k.slice(-1), 'OFF THEN ON', done(ov[k])]], { page: 'F/CTL' });
    // ELEC
    if (air && !this.acPowered && !this.acBus['1A'] && !this.acBus['2A']) A('EMERCFG', 3, 'ELEC EMER CONFIG', [['RAT MAN ON', 'PRESS', done(this.ratOut)], ['ENG MODE SEL', 'IGN', done(this.engMode === 'IGN')], ['APU', 'START', done(ov.APUMASTER)]], { page: 'ELEC', aural: 'crc' });
    for (let i = 0; i < 2; i++) for (const g of ['A', 'B']) { const id = `GEN${i + 1}${g}`; if (E[i].running && !ov[id]) A(id, 1, `ELEC ${id.slice(0, 3)} ${id.slice(3)} OFF`, [[id.slice(0, 3) + ' ' + id.slice(3), 'ON', done(ov[id])]], { page: 'ELEC' }); }
    if ((ov.BAT1 === false || ov.BAT2 === false) && this.acPowered && E.some((e) => e.running)) A('BATOFF', 1, 'ELEC BAT OFF', [['BAT', 'AUTO', done(ov.BAT1 && ov.BAT2)]], { page: 'ELEC' });
    // HYD
    const anyEng = E.some((e) => e.running);
    if (anyEng && this.hydP.G < 1500 && this.hydP.Y < 1500) A('HYDGY', 3, 'HYD G+Y SYS LO PR', [['G ELEC PMP', 'ON', done(ov.GELEC)], ['Y ELEC PMP', 'ON', done(ov.YELEC)]], { page: 'HYD', aural: 'crc' });
    else {
      if (anyEng && this.hydP.G < 1500) A('HYDG', 2, 'HYD G SYS LO PR', [['G ENG PMPS', 'OFF', done(!ov.GENG1 && !ov.GENG2)], ['G ELEC PMP', 'ON', done(ov.GELEC)]], { page: 'HYD' });
      if (anyEng && this.hydP.Y < 1500) A('HYDY', 2, 'HYD Y SYS LO PR', [['Y ENG PMPS', 'OFF', done(!ov.YENG1 && !ov.YENG2)], ['Y ELEC PMP', 'ON', done(ov.YELEC)]], { page: 'HYD' });
    }
    // FUEL
    if (anyEng && !(ov.FPL1 || ov.FPL2)) A('FUELLP', 2, 'FUEL L TK PUMPS OFF', [['L TK PUMPS', 'ON', done(ov.FPL1 || ov.FPL2)]], { page: 'FUEL' });
    if (anyEng && !(ov.FPR1 || ov.FPR2)) A('FUELRP', 2, 'FUEL R TK PUMPS OFF', [['R TK PUMPS', 'ON', done(ov.FPR1 || ov.FPR2)]], { page: 'FUEL' });
    if (Math.abs(f.fuel.L - f.fuel.R) > 3000) A('FUELIMB', 2, 'FUEL IMBALANCE', [['FUEL X FEED', 'OPEN', done(ov.XFEED1 || ov.XFEED2)]], { page: 'FUEL' });
    if (f.fob < 4000 && anyEng) A('FUELLO', 2, 'FUEL LO LEVEL', [['FUEL X FEED', 'AS RQRD', false], ['LAND ASAP', '', false]], { page: 'FUEL' });
    if (this.jettisoning) A('JETT', 1, 'FUEL JETTISON IN PROGRESS', [['JETTISON', 'STOP AT TARGET', false]], { page: 'FUEL', memo: true });
    // AIR / PRESS
    if (air && this.cab.alt > 9550) A('EXCAB', 3, 'CAB PRESS EXCESS CAB ALT', [['CREW OXY MASKS', 'USE', false], ['SIGNS', 'ON', done(ov.SEATBELT === 2)], ['EMER DESCENT', 'INITIATE', done(f.ind.vsi < -3000)], ['PAX OXY MASKS', 'MAN ON', done(this.paxMasks)]], { page: 'PRESS', aural: 'crc' });
    if (air && !this.packs[0] && !this.packs[1] && f.pos[1] / FT > 10000) A('PACKS', 2, 'AIR PACK 1+2 FAULT', [['PACK 1', 'ON', done(ov.PACK1)], ['PACK 2', 'ON', done(ov.PACK2)], ['DESCENT TO FL100', 'INITIATE', false]], { page: 'BLEED' });
    if (anyEng && air && !this.bleed.b1 && E[0].running && ph === 6) A('BLEED1', 1, 'AIR ENG 1 BLEED OFF', [['ENG 1 BLEED', 'ON', done(ov.ENGBLEED1)]], { page: 'BLEED' });
    if (anyEng && air && !this.bleed.b2 && E[1].running && ph === 6) A('BLEED2', 1, 'AIR ENG 2 BLEED OFF', [['ENG 2 BLEED', 'ON', done(ov.ENGBLEED2)]], { page: 'BLEED' });
    // NAV / ADIRS
    const irsOk = this.ir.filter((r) => r.state === 'NAV' && r.align >= 1).length;
    if (this.essPowered && this.ir.some((r) => r.state === 'NAV' && r.alignMoved && r.align < 1)) A('IRALIGN', 2, 'NAV IR NOT ALIGNED', [['A/C', 'DO NOT MOVE', false]]);
    if (anyEng && irsOk < 3 && this.ir.every((r) => r.state !== 'OFF') && false) A('IR', 1, 'NAV IR FAULT');
    if (anyEng && this.ir.some((r) => r.state === 'OFF')) A('IROFF', 2, 'NAV IR OFF', [['ADIRS SELECTORS', 'NAV', done(this.ir.every((r) => r.state !== 'OFF'))]]);
    if (this.essPowered && [ov.ADR1, ov.ADR2, ov.ADR3].filter((x) => !x).length >= 2) A('ADR', 2, 'NAV ADR 1+2 FAULT', [['ADR 1', 'ON', done(ov.ADR1)], ['ADR 2', 'ON', done(ov.ADR2)]]);
    // brakes
    if (Math.max(...f.brakeTemp) > 300) A('BRKHOT', 2, 'BRAKES HOT', [['BRK FAN', 'ON', done(this.brakeFans)], ['PARK BRK', 'PREFER CHOCKS', false]], { page: 'WHEEL' });
    // doors
    if (anyEng && !this.doorsClosed() && (ph >= 2)) A('DOORS', 2, 'DOOR CABIN / CARGO NOT CLOSED', [['DOORS', 'CLOSE', done(this.doorsClosed())]], { page: 'DOOR' });
    // AUTO FLT
    if (this.apOffWarn > 0) { this.apOffWarn -= dt; A('APOFF', 3, 'AUTO FLT AP OFF', [], { aural: this.apOffInvol ? 'cavalry' : null }); }
    if (this.athrOffWarn > 0) { this.athrOffWarn -= dt; A('ATHROFF', 2, 'AUTO FLT A/THR OFF', [['THR LEVERS', 'MOVE', false]]); }
    // ANTI ICE
    if (this.iceDetected && !this.ai.wai) A('ICE', 2, 'ANTI ICE ICE DETECTED', [['WING ANTI ICE', 'ON', done(ov.WINGAI)], ['ENG ANTI ICE', 'ON', done(ov.ENGAI1 && ov.ENGAI2)]]);
    // oxygen
    if (!ov.CREWO2 && anyEng) A('CREWO2', 1, 'OXY CREW SUPPLY OFF', [['CREW SUPPLY', 'ON', done(ov.CREWO2)]]);
    // recorders
    if (!ov.RCDR && f.onGround && this.acPowered && !anyEng) { /* advisory only */ }
    // cabin press MAN memo
    // ---- inhibition (T.O: 80 kt..1500 ft, LDG: 800 ft..80 kt) for cautions
    const inhibit = (ph === 4 && f.ind.ias > 80) || ph === 5 || ph === 7 || ph === 8;
    let list = alerts.filter((a) => a.lvl === 3 || !inhibit);
    list.sort((a, b) => b.lvl - a.lvl);
    // new alert → master warning/caution + aural
    const now = new Set(list.map((a) => a.id));
    for (const a of list) {
      if (!this.alertState[a.id]) {
        this.alertState[a.id] = this.time; this.cleared.delete(a.id);
        if (a.lvl === 3) { this.masterWarn = true; this.emerCanc.delete(a.id); }
        else if (a.lvl === 2) { this.masterCaut = true; this.emit('single'); }
        if (a.aural === 'cavalry') this.emit('cavalry');
      }
    }
    for (const id of Object.keys(this.alertState)) if (!now.has(id)) { delete this.alertState[id]; }
    if (!list.some((a) => a.lvl === 3)) this.masterWarn = false;
    this.alerts = list;
    this.activeAlerts = list.filter((a) => !this.cleared.has(a.id));
    // continuous aural for red warnings while master warning lit
    this.crcOn = this.masterWarn && list.some((a) => a.lvl === 3 && a.aural === 'crc' && !this.emerCanc.has(a.id));
    this.stallAural = list.some((a) => a.id === 'STALL');
  }

  vmax() {
    const f = this.fdm, ci = this.confIdx();
    let v = A350.vmo;
    const mmoKt = f.ind.mach > 0.1 ? f.ind.ias * A350.mmo / f.ind.mach : 999;
    v = Math.min(v, mmoKt);
    if (ci > 0) v = Math.min(v, CONFS[ci].vfe);
    if (f.gear.pos > 0.02) v = Math.min(v, A350.vle);
    return Math.round(v);
  }

  memo(ctx) {
    const f = this.fdm, ov = this.ov, m = [], E = f.E;
    const anyEng = E.some((e) => e.running);
    const toMemo = f.onGround && anyEng && this.phase <= 2;
    const ldgMemo = !f.onGround && f.ra < 2000 * FT && f.gear.pos > 0.9 && this.phase >= 6;
    this.toMemo = toMemo ? [
      ['AUTO BRK', 'RTO', f.abrk.mode === 'RTO'], ['SIGNS', 'ON', ov.SEATBELT >= 1 && ov.NOMOBILE >= 1],
      ['SPLRS', 'ARM', f.ctrl.spdArm], ['FLAPS', 'T.O', this.confIdx() >= 1 && this.confIdx() <= 4], ['T.O CONFIG', 'TEST', this.toConfigOk],
    ] : null;
    this.ldgMemo = ldgMemo ? [
      ['LDG GEAR', 'DN', f.gear.pos > 0.98], ['SIGNS', 'ON', ov.SEATBELT >= 1], ['SPLRS', 'ARM', f.ctrl.spdArm], ['FLAPS', this.ped.ldgConf3 ? 'CONF 3' : 'FULL', this.confIdx() === (this.ped.ldgConf3 ? 4 : 5)],
    ] : null;
    if (f.ctrl.parkBrake && f.onGround) m.push(['PARK BRK', 'g']);
    if (this.apu.avail) m.push(['APU AVAIL', 'g']);
    if (this.apu.avail && ov.APUBLEED) m.push(['APU BLEED', 'g']);
    if (f.ctrl.spdArm && !toMemo && !ldgMemo) m.push(['GND SPLRS ARMED', 'g']);
    if (ov.SEATBELT === 2 && !toMemo && !ldgMemo) m.push(['SEAT BELTS', 'g']);
    if (ov.NOMOBILE >= 1 && !toMemo && !ldgMemo) m.push(['NO MOBILE', 'g']);
    if (this.engMode === 'IGN' && anyEng) m.push(['IGNITION', 'g']);
    if (ov.LAND && !f.onGround && f.pos[1] / FT > 18000) m.push(['LDG LT', 'g']);
    if (ov.STROBE === 0 && !f.onGround) m.push(['STROBE LT OFF', 'g']);
    if (ov.ENGAI1 || ov.ENGAI2) m.push(['ENG A.ICE', 'g']);
    if (ov.WINGAI) m.push(['WING A.ICE', 'g']);
    if (ov.PRESSMODE) m.push(['CAB PRESS MAN', 'g']);
    if (this.ratOut) m.push(['RAT OUT', 'g']);
    if (f.abrk.mode !== 'OFF' && !toMemo) m.push(['AUTO BRK ' + f.abrk.mode, 'g']);
    if (f.abrk.mode === 'BTV' && !f.onGround) m.push(['BTV ' + (this.fms?.btvExit || 'ROWAY'), 'g']);
    if (this.gpu && f.onGround) m.push(['GPU CONNECTED', 'g']);
    if (this.refuel) m.push(['REFUELG', 'g']);
    if (this.toConfigTest > 0 && this.toConfigOk) m.push(['T.O CONFIG NORMAL', 'g']);
    if (f.ctrl.spdbrk > 0.05 && !f.onGround) m.push(['SPEED BRK', f.ctrl.tla[0] > 0.1 ? 'a' : 'g']);
    if (ov.CREWO2 === false) m.push(['CREW OXY OFF', 'a']);
    if (this.paxMasks) m.push(['PAX OXY MASKS', 'a']);
    if (f.ctrl.rudTrim && Math.abs(f.ctrl.rudTrim) > 0.2) m.push(['RUD TRIM ' + (f.ctrl.rudTrim > 0 ? 'R ' : 'L ') + Math.abs(f.ctrl.rudTrim).toFixed(1), 'g']);
    if (this.fuelX()) m.push(['FUEL X FEED', 'g']);
    if (this.hydP.Y > 3000 && ov.YELEC) m.push(['HYD Y ELEC PMP', 'g']);
    this.memos = m;
  }
  fuelX() { return this.ov.XFEED1 || this.ov.XFEED2; }
  toMemoGreen() { return !!this.toMemo && this.toMemo.every((x) => x[2]); }
  ldgMemoGreen() { return !!this.ldgMemo && this.ldgMemo.every((x) => x[2]); }

  autoSD() {
    const f = this.fdm, ph = this.phase;
    const top = this.activeAlerts?.find((a) => a.page);
    let p;
    if (top) p = top.page;
    else if (this.apu.starting || (this.ov.APUMASTER && !this.apu.avail)) p = 'APU';
    else if (f.E.some((e) => e.starting) || this.engMode === 'IGN' && ph <= 2) p = 'ENG';
    else if (ph === 1 || ph === 10) p = 'DOOR';
    else if (ph === 2 || ph === 9) p = Math.abs(f.ctrl.stickX) > 0.3 || Math.abs(f.ctrl.stickY) > 0.3 ? 'F/CTL' : 'WHEEL';
    else if (ph >= 3 && ph <= 5) p = 'ENG';
    else if (ph === 6) p = f.gear.lever === 1 && f.pos[1] / FT < 16000 ? 'WHEEL' : 'CRUISE';
    else p = 'WHEEL';
    this.sdAuto = p;
  }
  get sdShown() { return this.sdPage === 'AUTO' ? this.sdAuto : this.sdPage; }
  clearTop() {
    const a = this.activeAlerts?.[0]; if (!a) { this.sdPage = 'AUTO'; return; }
    this.cleared.add(a.id); if (a.lvl === 3) this.emerCanc.add(a.id);
    if (!this.activeAlerts.some((x) => !this.cleared.has(x.id) && x.lvl === 3)) this.masterWarn = false;
    this.masterCaut = this.activeAlerts.some((x) => !this.cleared.has(x.id) && x.lvl === 2) && this.masterCaut;
    this.sdPage = 'AUTO';
  }
  emergencyCancel() {
    for (const a of this.alerts) if (a.lvl === 3) this.emerCanc.add(a.id);
    this.crcOn = false; this.masterCaut = false; this.emit('silence');
  }
  recallAll() { this.cleared.clear(); this.recall = 3; }
}
