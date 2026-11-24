// AI air traffic that is actually controlled.
// Airliners at SFO / OAK / SJC push back from real gate stands, taxi the OSM taxiway network to the
// hold-short line, wait for the tower, line up, take off and climb out; arrivals fly the real final,
// land, vacate at a taxiway, cross other runways only when cleared, and taxi to a stand. GA Cessnas fly
// closed traffic at the towered GA fields. Each flight is a state machine whose movement is gated by
// clearances issued by the Tower (tower.js): hold-short / line-up stops, landing clearance, speed
// control for spacing on final, and go-arounds. Aircraft on the ground also stop for traffic ahead
// (AI or the player), the way FlightGear's ground network holds conflicting taxi routes.
// The runway configuration (west / south-east plan etc.) follows the surface wind.
import * as THREE from 'three';
import { AIRPORTS, findRunway, runwayEnd } from './geo.js';
import { buildAirliner, LIVERIES } from './airliner.js';
import { flattenStatic } from './world.js';
import { taxiRoute, taxiPath, runwayExit, runwayCrossings } from './taxi.js?v=20261124c';

const D2R = Math.PI / 180, G = 9.81, FT = 0.3048, KT = 0.514444;
const rnd = Math.random;
const pick = (a) => a[Math.floor(rnd() * a.length)];
export const HEAVY = new Set(['B77W', 'B789', 'B744', 'A359', 'A333']);
export const TYPE_NAME = { A320: 'Airbus A320', A321: 'Airbus A321', B738: 'Boeing 737', B39M: 'Boeing 737 MAX', B789: 'Boeing 787', B77W: 'Boeing 777', E175: 'Embraer 175', C172: 'Cessna 172' };

// polyline with per-vertex speed, resampled from a set of 3-D control points
export class Route {
  constructor(pts, speeds, loop = false) {
    this.p = pts; this.v = speeds; this.loop = loop;
    this.cum = [0]; for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    this.len = this.cum[this.cum.length - 1];
  }
  idx(s) { // binary search
    let lo = 0, hi = this.p.length - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.cum[m] <= s) lo = m; else hi = m - 1; }
    return lo;
  }
  at(s, o) {
    if (this.loop) s = ((s % this.len) + this.len) % this.len; else s = Math.min(this.len, Math.max(0, s));
    const i = this.idx(s);
    const L = this.cum[i + 1] - this.cum[i] || 1, t = Math.min(1, (s - this.cum[i]) / L);
    o.pos.lerpVectors(this.p[i], this.p[i + 1], t);
    o.dir.subVectors(this.p[i + 1], this.p[i]); if (o.dir.lengthSq() < 1e-9) o.dir.set(0, 0, -1); o.dir.normalize();
    o.v = this.v[i] + (this.v[i + 1] - this.v[i]) * t;
    return o;
  }
}
function curve(ctrl, step = 40) {
  const c = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal');
  const n = Math.max(2, Math.ceil(c.getLength() / step));
  return c.getSpacedPoints(n);
}
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

// runway-local coordinates and occupancy tests (shared with the tower)
export const rLocal = (r, x, z) => { const dx = x - r.x, dz = z - r.z; return { u: dx * r.dir[0] + dz * r.dir[1], v: dx * r.perp[0] + dz * r.perp[1] }; };
export const onRunway = (r, x, z, m = 6) => { const l = rLocal(r, x, z); return Math.abs(l.u) < r.len / 2 + 40 && Math.abs(l.v) < r.wid / 2 + m; };
/** distance past the threshold of runway end `e` (positive = down the runway) */
export const alongEnd = (end, x, z) => (x - end.x) * end.dir[0] + (z - end.z) * end.dir[1];

// ---------------------------------------------------------------- ground path helpers
function chaikin(P, it = 2) {
  P = P.filter((p, i) => !i || Math.hypot(p.x - P[i - 1].x, p.z - P[i - 1].z) > 0.8);
  for (let k = 0; k < it; k++) {
    if (P.length < 3) return P;
    const Q = [P[0]];
    for (let i = 0; i < P.length - 1; i++) { const a = P[i], b = P[i + 1]; Q.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25, h: a.h }, { x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75, h: b.h }); }
    Q.push(P[P.length - 1]); P = Q;
  }
  return P;
}
// taxi speed from path curvature: ~17 kt on straights, slowing for turns, decelerating ahead of them
function taxiSpeeds(P, vmax) {
  const n = P.length, v = new Array(n).fill(vmax);
  for (let i = 1; i < n - 1; i++) {
    const ax = P[i].x - P[i - 1].x, az = P[i].z - P[i - 1].z, bx = P[i + 1].x - P[i].x, bz = P[i + 1].z - P[i].z;
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    const th = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb)))), k = th / ((la + lb) / 2);
    v[i] = Math.max(2.5, Math.min(vmax, Math.sqrt(0.9 / Math.max(k, 1e-4))));
  }
  for (let i = n - 2; i >= 0; i--) { const d = Math.hypot(P[i + 1].x - P[i].x, P[i + 1].z - P[i].z); v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * 0.5 * d)); }
  return v;
}

// stands: the taxilane point just behind the tail of a gate stand (where a pushback ends)
function standPoints(a) {
  const st = a._gateStands || [];
  if (st.length) return st.map((s) => ({ x: s.cx + s.nx * (s.G.T.L / 2 + 32), z: s.cz + s.nz * (s.G.T.L / 2 + 32), label: s.label }));
  return [{ x: a.ramp.x, z: a.ramp.z, label: 'ramp' }];
}

// ---------------------------------------------------------------- flight builders
// arrival: 3 deg glide from ~12 nm joining from the side, landing, rollout, vacate, taxi to a stand
function arrivalProto(icao, rwyId, side = 1, join = 26000) {
  const f = findRunway(icao, rwyId); if (!f) return null;
  const e = runwayEnd(f.r, f.e), d = e.dir, el = e.elev;
  const lx = d[1], lz = -d[0];
  const P = (along, off, y) => v3(e.x + d[0] * along + lx * off * side, y, e.z + d[1] * along + lz * off * side);
  const gs = Math.tan(3 * D2R), tdz = 330;
  const air = curve([P(-join - 14000, 14000, el + 2300), P(-join - 4000, 7000, el + 1700), P(-join, 0, el + 15 + gs * (join + tdz)), P(-join + 6000, 0, el + 15 + gs * (join - 6000 + tdz))], 60);
  const fin = []; for (let a = -join + 6000; a <= tdz; a += 150) fin.push(P(a, 0, el + Math.max(0, gs * (tdz - a))));
  if (fin[fin.length - 1].distanceTo(P(tdz, 0, el)) > 1) fin.push(P(tdz, 0, el));
  return { f, e, el, pts: [...air, ...fin.slice(1)], icao, rwy: e.id, tdz };
}
function buildArrival(proto, a) {
  const { f, e, el, tdz } = proto, d = e.dir, lx = d[1], lz = -d[0];
  const P2 = (al, lat = 0) => ({ x: e.x + d[0] * al + lx * lat, z: e.z + d[1] * al + lz * lat });
  const stands = standPoints(a), st = pick(stands);
  const side = Math.sign(alongLat(e, st.x, st.z)) || 1;
  // the exit: first taxiway that leaves the runway beyond a comfortable stopping point
  const minAl = Math.min(tdz + 1250, f.r.len - 500);
  const ex = runwayExit(proto.icao, proto.rwy, minAl, side) || runwayExit(proto.icao, proto.rwy, minAl * 0.7, 0);
  const pts = proto.pts.map((p) => p.clone()), sp = [];
  const nAir = pts.length;
  for (let i = 0; i < nAir; i++) { const h = pts[i].y - el; sp.push(h > 900 ? 120 : h > 450 ? 95 : 72); }
  const rollEnd = ex ? Math.max(tdz + 400, ex.jAlong - 60) : Math.min(tdz + 1900, f.r.len - 300);
  const roll = []; for (let al = tdz + 60; al <= rollEnd; al += 60) roll.push(al);
  roll.forEach((al, i) => { const q = P2(al); pts.push(v3(q.x, el, q.z)); sp.push(Math.max(14, 68 - (al - tdz) * (55 / Math.max(400, rollEnd - tdz)))); });
  const sRollIdx = pts.length - 1;
  let ground = [], cross = [], via = '', exitK = -1;
  if (ex) {
    const turn = [P2(rollEnd), P2(ex.jAlong - 15, ex.lat * f.r.wid * 0.25), P2((ex.jAlong + ex.along) / 2, ex.lat * (f.r.wid / 2 + 5)), { x: ex.x, z: ex.z }];
    const tp = taxiPath(proto.icao, ex.x, ex.z, st.x, st.z);
    const raw = [...turn, ...(tp ? tp.pts.slice(1) : [])];
    const sm = chaikin(raw, 2); exitK = 3;
    const cr = runwayCrossings(proto.icao, sm, f.r);
    ground = cr.pts; cross = cr.cross; via = tp ? tp.viaText : '';
  }
  const gStart = pts.length;
  const gv = taxiSpeeds(ground, 9); if (gv.length) gv[0] = Math.min(gv[0], 14);
  ground.forEach((q, i) => { if (i === 0) return; pts.push(v3(q.x, el, q.z)); sp.push(gv[i]); });
  const route = new Route(pts, sp);
  const r = { route, icao: proto.icao, rwy: proto.rwy, kind: 'arr', elev: el, end: e, rw: f.r, a, via, stand: st.label, exitSide: ex ? ex.lat : 0 };
  // markers
  r.sThr = sAtAlong(route, e, 0, 0, nAir); r.sTd = route.cum[nAir - 1];
  r.sRollEnd = route.cum[sRollIdx];
  r.sVacate = route.len; r.sClear = route.len;
  for (let i = sRollIdx; i < pts.length; i++) if (!onRunway(f.r, pts[i].x, pts[i].z, 30)) { r.sVacate = route.cum[i]; break; }
  r.stops = cross.map((c) => ({ s: route.cum[gStart + c.k - 1] || route.cum[gStart], kind: 'cross', rw: c.r }));
  return r;
}
const alongLat = (e, x, z) => (x - e.x) * e.dir[1] + (z - e.z) * -e.dir[0];
function sAtAlong(route, e, al, i0 = 0, i1 = route.p.length) {
  for (let i = Math.max(1, i0); i < i1; i++) {
    const a0 = alongEnd(e, route.p[i - 1].x, route.p[i - 1].z), a1 = alongEnd(e, route.p[i].x, route.p[i].z);
    if (a0 < al && a1 >= al) return route.cum[i - 1] + (route.cum[i] - route.cum[i - 1]) * (al - a0) / (a1 - a0 || 1);
  }
  return route.cum[i1 - 1];
}

// departure: gate -> taxi -> hold short -> line up -> takeoff roll from the line-up point -> climb-out
function buildDeparture(icao, rwyId, turnHdg, turnAt, a) {
  const f = findRunway(icao, rwyId); if (!f) return null;
  const e = runwayEnd(f.r, f.e), d = e.dir, el = e.elev;
  const P = (along, y) => v3(e.x + d[0] * along, y, e.z + d[1] * along);
  const stands = standPoints(a);
  let tr = null, st = null;
  for (let k = 0; k < 4 && !tr; k++) { st = pick(stands); tr = taxiRoute(icao, rwyId, st.x, st.z); if (tr && tr.len > 9000) tr = null; }
  if (!tr) return null;
  const sm = chaikin(tr.pts, 2), cr = runwayCrossings(icao, sm, f.r);
  const g = cr.pts, gv = taxiSpeeds(g, 9);
  const pts = [], sp = [];
  g.forEach((q, i) => { pts.push(v3(q.x, el, q.z)); sp.push(i === 0 ? 2 : gv[i]); });
  sp[sp.length - 1] = 2;
  const holdIdx = pts.length - 1;
  // line-up: curve from the hold line onto the centreline, takeoff roll starts where it lines up
  const h = g[g.length - 1], a0 = Math.max(0, Math.min(f.r.len * 0.3, alongEnd(e, h.x, h.z)));
  const L1 = P(a0, el), L2 = P(a0 + 45, el), mid = v3((h.x + L1.x) / 2, el, (h.z + L1.z) / 2);
  const lu = curve([pts[holdIdx], mid, L1.clone().lerp(L2, 0.3), L2], 6).slice(1);
  for (const q of lu) { pts.push(q); sp.push(3); }
  const lineIdx = pts.length - 1; sp[lineIdx] = 1;
  const rollLen = Math.min(1850, f.r.len - a0 - 200);
  const ground = []; for (let al = a0 + 100; al <= a0 + 45 + rollLen; al += 100) ground.push(P(al, el));
  ground.forEach((q, i) => { pts.push(q); sp.push(8 + 72 * Math.sqrt((i + 1) / ground.length)); });
  const liftIdx = pts.length - 1;
  const th = turnHdg * D2R, td = [Math.sin(th), -Math.cos(th)];
  const lo = P(a0 + rollLen + 145, el + 5), tp = P(a0 + rollLen + 145 + turnAt, el + 520);
  const q = (k, y) => v3(tp.x + td[0] * k, y, tp.z + td[1] * k);
  const air = curve([lo, P(a0 + rollLen + 145 + turnAt * 0.5, el + 260), tp, q(4000, el + 1100), q(12000, el + 2200), q(30000, el + 4200)], 60);
  for (const p of air) { pts.push(p); sp.push(Math.min(140, 82 + (p.y - el) * 0.03)); }
  const route = new Route(pts, sp);
  const r = { route, icao, rwy: e.id, kind: 'dep', elev: el, end: e, rw: f.r, a, via: tr.viaText, viaList: tr.via, stand: st.label };
  r.a0 = a0 + 45; r.sHold = route.cum[holdIdx]; r.sLine = route.cum[lineIdx]; r.sLift = route.cum[liftIdx];
  r.stops = [...cr.cross.map((c) => ({ s: route.cum[c.k], kind: 'cross', rw: c.r })), { s: r.sHold, kind: 'hold' }, { s: r.sLine, kind: 'line' }];
  return r;
}
// closed traffic for GA (touch and go); right = right-hand traffic
function patternRoute(icao, rwyId, right = false) {
  const f = findRunway(icao, rwyId); if (!f) return null;
  const e = runwayEnd(f.r, f.e), d = e.dir, el = e.elev, len = f.r.len;
  const s = right ? -1 : 1, lx = d[1] * s, lz = -d[0] * s;
  const P = (along, off, h) => v3(e.x + d[0] * along + lx * off, el + h, e.z + d[1] * along + lz * off);
  const tpa = 1000 * FT, w = 1100;
  const c = new THREE.CatmullRomCurve3([
    P(80, 0, 0), P(Math.min(len * 0.45, 380), 0, 1), P(len + 300, 0, 120), P(len + 1300, 250, tpa * 0.75), P(len + 900, w, tpa), P(len * 0.5, w, tpa),
    P(-1000, w, tpa), P(-1700, w * 0.6, tpa * 0.7), P(-1500, 0, tpa * 0.4), P(-700, 0, tpa * 0.2), P(-150, 0, 12),
  ], true, 'centripetal');
  const pts = c.getSpacedPoints(Math.ceil(c.getLength() / 30));
  for (const p of pts) p.y = Math.max(p.y, el);
  const sp = pts.map((p) => (p.y - el < 3 ? 30 : 36));
  const route = new Route(pts, sp, true);
  return { route, icao, rwy: e.id, kind: 'pattern', elev: el, end: e, rw: f.r, a: f.a, right };
}
// go-around / missed approach: climb on runway heading, then turn out and leave
function goAroundRoute(fl, pos, el) {
  const e = fl.r.end, d = e.dir, side = fl.goSide || 1, lx = d[1] * side, lz = -d[0] * side;
  const al = alongEnd(e, pos.x, pos.z);
  const P = (a, off, y) => v3(e.x + d[0] * a + lx * off, y, e.z + d[1] * a + lz * off);
  const pts = curve([pos.clone(), P(al + 1500, 0, Math.max(pos.y + 60, el + 150)), P(al + 6000, 0, el + 600), P(al + 9500, 2500, el + 900), P(al + 9000, 12000, el + 1400), P(al + 6000, 30000, el + 2200)], 50);
  return new Route(pts, pts.map((p, i) => (i < 3 ? 75 : 95 + Math.min(40, (p.y - el) * 0.02))));
}

// ---------------------------------------------------------------- runway configurations
// Real-world flows: SFO west plan (land 28L/28R, depart 1L/1R) or south-east plan (land 19L/19R, depart 10L/10R);
// OAK 30 / 12; SJC 30L-30R / 12R-12L. The first plan is used unless the tailwind on it exceeds 5 kt.
const AIRLINER = ['A320', 'B738', 'B39M', 'A321', 'B789', 'B77W', 'E175'];
const CONFIGS = {
  KSFO: [
    { name: 'WEST PLAN', arr: [['28L', 1, 24000, 95, 0], ['28R', -1, 24000, 95, 40]], dep: [['1L', 75, 3800, 85, ['A320', 'B738', 'B39M', 'A321', 'E175']], ['1R', 300, 2600, 110, ['B77W', 'B789', 'A321', 'B738']]] },
    { name: 'SOUTHEAST PLAN', arr: [['19L', -1, 22000, 100, 0], ['19R', 1, 22000, 100, 45]], dep: [['10L', 60, 4000, 95, AIRLINER], ['10R', 40, 4000, 110, AIRLINER]] },
  ],
  KOAK: [
    { name: 'WEST FLOW', arr: [['30', 1, 20000, 150, 10]], dep: [['30', 250, 3000, 160, ['B738', 'B39M', 'A321']]] },
    { name: 'EAST FLOW', arr: [['12', -1, 20000, 150, 10]], dep: [['12', 160, 3000, 160, ['B738', 'B39M', 'A321']]] },
  ],
  KSJC: [
    { name: 'NORTH FLOW', arr: [['30L', -1, 20000, 160, 30]], dep: [['30R', 270, 4500, 170, ['B738', 'A320', 'B39M']]] },
    { name: 'SOUTH FLOW', arr: [['12R', 1, 20000, 160, 30]], dep: [['12L', 160, 4500, 170, ['B738', 'A320', 'B39M']]] },
  ],
};
const ARR_TYPES = { KSFO: AIRLINER, KOAK: ['B738', 'B39M', 'A320'], KSJC: ['B738', 'A320', 'E175', 'A321'] };
const PATTERNS = [['KPAO', '31', true], ['KHWD', '28L', false], ['KSQL', '30', true], ['KLVK', '25R', false], ['KRHV', '31R', true], ['KCCR', '32R', false], ['KHAF', '30', false]];
const AIRLINE_FOR = { E175: ['SKW', 'ASA'], B77W: ['UAL'], B789: ['UAL', 'HAL'], A321: ['UAL', 'AAL', 'JBU', 'DAL', 'HAL'], A320: ['UAL', 'JBU', 'ASA', 'DAL', 'AAL'], B738: ['UAL', 'SWA', 'ASA', 'DAL', 'AAL'], B39M: ['UAL', 'SWA', 'ASA', 'AAL'] };
const GA_REGS = ['N52418', 'N738HP', 'N12KD', 'N64220', 'N9312F', 'N172TX', 'N5284Q'];

export function pickConfig(icao, weather) {
  const list = CONFIGS[icao]; if (!list) return null;
  const w = weather || { windDir: 280, windKt: 0 };
  const head = (rwy) => { const f = findRunway(icao, rwy); const h = runwayEnd(f.r, f.e).hdg; return w.windKt * Math.cos((w.windDir - h) * D2R); };
  if (head(list[0].arr[0][0]) >= -5) return list[0];
  return list.slice().sort((p, q) => head(q.arr[0][0]) - head(p.arr[0][0]))[0];
}
export const flowInfo = (icao, weather) => { const c = pickConfig(icao, weather); return c ? { name: c.name, arr: c.arr.map((x) => x[0]), dep: c.dep.map((x) => x[0]) } : null; };

// ---------------------------------------------------------------- manager
let NEXT_ID = 1;
export class Traffic {
  constructor(scene, opts = {}) {
    this.scene = scene; this.group = new THREE.Group(); this.group.name = 'ai-traffic'; scene.add(this.group);
    this.enabled = true; this.list = []; this.flights = []; this.t = 0; this.night = 0;
    this.light = !!opts.light;
    this.tmp = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), v: 0 };
    this.models = new Map(); this.cfg = {}; this.flows = []; this.protos = new Map();
    this.sim = null; this.player = null;
  }
  async init(buildAircraftFn) {
    let proto = null;
    if (buildAircraftFn) {
      try { proto = flattenStatic(await buildAircraftFn({ envMap: null, reg: 'N52418', scheme: 2, interior: false, lights: false })); } catch (e) { console.warn('GA proto failed', e); }
    }
    this.gaProto = proto;
    PATTERNS.forEach(([icao, rwy, right], i) => {
      const r = patternRoute(icao, rwy, right); if (!r || !proto) return;
      const inner = proto.clone(); inner.rotation.y = Math.PI / 2; inner.position.y = 1.19;
      const o = new THREE.Group(); o.add(inner); o.rotation.order = 'YXZ'; this.group.add(o);
      const fl = this.newFlight({ obj: o, r, s: rnd() * r.route.len, callsign: GA_REGS[i % GA_REGS.length], ident: GA_REGS[i % GA_REGS.length], type: 'C172', ga: true, state: 'pattern' });
      fl.spoken = 'Cessna ' + fl.callsign.slice(1);
    });
    this.configure(null);
  }
  /** choose each airport's runway configuration from the wind and (re)build its flows */
  configure(weather) {
    for (const icao of Object.keys(CONFIGS)) {
      const c = pickConfig(icao, weather);
      if (this.cfg[icao] === c) continue;
      this.cfg[icao] = c;
      // drop this airport's airliners and flows, then start fresh in the new configuration
      for (let i = this.flights.length - 1; i >= 0; i--) { const f = this.flights[i]; if (!f.ga && f.r.icao === icao) this.remove(i); }
      this.flows = this.flows.filter((f) => f.icao !== icao);
      const a = AIRPORTS.find((q) => q.icao === icao); if (!a) continue;
      for (const [rwy, side, join, every, off] of c.arr) {
        const p = arrivalProto(icao, rwy, side, join); if (!p) continue;
        this.flows.push({ icao, kind: 'arr', rwy, p, a, every, timer: off, types: ARR_TYPES[icao] });
      }
      for (const [rwy, hdg, at, every, types] of c.dep) this.flows.push({ icao, kind: 'dep', rwy, hdg, at, a, every, timer: every * 0.3, types });
      // pre-populate so the airport is already busy: arrivals spread along the approach, departures taxiing
      for (const f of this.flows.filter((q) => q.icao === icao)) {
        if (f.kind === 'arr') { for (const k of [0.3, 0.68]) this.spawn(f, k); }
        else { this.spawn(f, 0.35 + rnd() * 0.3); this.spawn(f, -1); }
        f.timer = f.every * (0.4 + rnd() * 0.6);
      }
    }
  }
  model(type, lv) {
    const key = type + lv; let list = this.models.get(key); if (!list) this.models.set(key, (list = []));
    const free = list.find((o) => !o.userData.busy);
    if (free) { free.userData.busy = true; free.visible = true; return free; }
    const o = buildAirliner(type, lv); o.rotation.order = 'YXZ'; o.userData.busy = true; this.group.add(o); list.push(o); return o;
  }
  newFlight(o) {
    const fl = { id: NEXT_ID++, v: 0, k: 1, prevYaw: null, bank: 0, wait: 0, cleared: {}, msg: {}, holdT: 0, lift: 0, ...o };
    this.flights.push(fl); return fl;
  }
  /** frac: arrivals = fraction along the approach (0 = entry); departures = fraction along the taxi (-1 = at the gate) */
  spawn(f, frac = 0) {
    if (this.flights.filter((x) => !x.ga).length >= (this.light ? 14 : 26)) return null;
    const type = pick(f.types); const lv = pick(AIRLINE_FOR[type] || ['UAL']); const L = LIVERIES[lv];
    let r;
    try { r = f.kind === 'arr' ? buildArrival(f.p, f.a) : buildDeparture(f.icao, f.rwy, f.hdg, f.at, f.a); } catch (e) { console.warn('AI route', e); r = null; }
    if (!r) return null;
    const num = (100 + Math.floor(rnd() * 2400)).toString(), heavy = HEAVY.has(type);
    const fl = this.newFlight({ obj: this.model(type, lv), r, s: 0, callsign: `${L.call} ${num}${heavy ? ' heavy' : ''}`, ident: L.icao + num, type, lv, heavy });
    if (f.kind === 'arr') {
      fl.state = 'arrival'; fl.s = frac > 0 ? r.sThr * frac : 0; fl.v = 110;
    } else {
      fl.state = 'gate'; fl.wait = 4 + rnd() * 6;
      if (frac > 0) { fl.s = r.sHold * frac; fl.state = 'taxi'; fl.msg.taxi = true; fl.cleared.taxi = true; for (const st of r.stops) if (st.s < fl.s - 1) st.ok = true; }
    }
    return fl;
  }
  remove(i) { const fl = this.flights[i]; fl.obj.visible = false; fl.obj.userData.busy = false; this.flights.splice(i, 1); }
  setEnabled(on) { this.enabled = on; this.group.visible = on; if (!on) this.list = []; }
  setNight(n) { this.night = n; }

  /** called by the tower */
  goAround(fl, why = '') {
    if (fl.ga) { fl.goT = 0; fl.goY = null; fl.cleared.land = false; fl.state = 'pattern'; return; }
    const o = this.tmp; fl.r.route.at(fl.s, o);
    fl.r = { ...fl.r, route: goAroundRoute(fl, o.pos.clone(), fl.r.elev), kind: 'missed', stops: [] };
    fl.s = 0; fl.state = 'missed'; fl.k = 1; fl.why = why;
  }

  update(dt, cam) {
    if (!this.enabled) return;
    if (this.sim && this.sim.weather !== this._w) { this._w = this.sim.weather; this.configure(this._w); }
    dt = Math.min(dt, 0.25); this.t += dt;
    for (const f of this.flows) { f.timer -= dt; if (f.timer <= 0) { f.timer = f.every * (0.75 + rnd() * 0.5); this.spawn(f, f.kind === 'dep' ? -1 : 0); } }
    const o = this.tmp, out = [];
    const P = this.player; // {x, z, agl, onGround}
    // ground movers for conflict checks
    const gnd = [];
    for (const fl of this.flights) if (fl.pos && fl.agl < 3 && fl.state !== 'roll' && fl.state !== 'landing') gnd.push(fl);
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const fl = this.flights[i], R = fl.r.route;
      R.at(fl.s, o);
      // ---- target speed: route profile x tower speed control, limited by stops and traffic ahead
      let vt = o.v * (fl.state === 'arrival' ? fl.k : 1);
      if (fl.state === 'gate') vt = 0;
      if (fl.state === 'parked') vt = 0;
      const stop = (fl.r.stops || []).find((st) => !st.ok && st.s > fl.s - 2);
      if (stop) { const d = stop.s - fl.s; vt = Math.min(vt, d <= 0.6 ? 0 : Math.sqrt(2 * 0.7 * d)); fl.atStop = d < 4 && fl.v < 0.5 ? stop : null; } else fl.atStop = null;
      const onGround = (fl.pos ? fl.agl : 99) < 3 && !fl.ga;
      fl.blocked = null;
      if (onGround && fl.state !== 'roll' && fl.state !== 'landing') {
        let dmin = Infinity;
        const fx = o.dir.x, fz = o.dir.z, fn = Math.hypot(fx, fz) || 1;
        const test = (x, z, who) => { const rx = x - o.pos.x, rz = z - o.pos.z, ah = (rx * fx + rz * fz) / fn, lat = Math.abs((rx * fz - rz * fx) / fn); if (ah > 0 && ah < 95 && lat < 24 && ah < dmin) { dmin = ah; fl.blocked = who; } };
        for (const q of gnd) if (q !== fl && !(q.blocked === fl && q.id > fl.id)) test(q.pos.x, q.pos.z, q);
        if (P && P.onGround) test(P.x, P.z, 'player');
        if (dmin < Infinity) {
          fl.blockT = (fl.blockT || 0) + dt;
          if (fl.blockT < 40) vt = Math.min(vt, Math.sqrt(2 * 1.2 * Math.max(0, dmin - 62)));
        } else fl.blockT = 0;
      }
      // ---- acceleration limits
      const acc = fl.state === 'roll' ? 2.3 : onGround ? (vt < fl.v ? (fl.v > 18 ? 2.6 : 1.2) : 0.7) : 2.5;
      fl.v += Math.max(-acc * dt, Math.min(acc * dt, vt - fl.v));
      if (!onGround && fl.state !== 'gate') fl.v = Math.max(fl.v, Math.min(o.v, 30));
      fl.s += fl.v * dt;
      if (fl.state === 'gate') { fl.wait -= dt; }
      if (!R.loop && fl.s >= R.len) { this.remove(i); continue; }
      R.at(fl.s, o);
      const p = o.pos, d = o.dir;
      // GA go-around: climb away from the runway until the circuit profile is regained
      if (fl.ga && fl.goT != null) {
        fl.goT += dt; if (fl.goY == null) fl.goY = Math.max(p.y, fl.r.elev + 15);
        const y = fl.goY + 3.5 * fl.goT;
        if (p.y >= y || fl.goT > 120) { fl.goT = null; fl.goY = null; } else p.y = y;
      }
      fl.pos = fl.pos || new THREE.Vector3(); fl.pos.copy(p); fl.dir = fl.dir || new THREE.Vector3(); fl.dir.copy(d);
      const yaw = Math.atan2(d.x, -d.z), climb = Math.asin(Math.max(-1, Math.min(1, d.y)));
      const agl = p.y - fl.r.elev; fl.agl = agl;
      if (fl.prevYaw != null) {
        let dy = yaw - fl.prevYaw; dy = ((dy + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        const w = dy / Math.max(dt, 1e-3); const target = agl > 8 ? Math.max(-0.5, Math.min(0.5, Math.atan(fl.v * w / G))) : 0;
        fl.bank += (target - fl.bank) * Math.min(1, dt * 1.5);
      }
      fl.prevYaw = yaw;
      const aoa = agl < 1 ? 0 : fl.ga ? 0.05 : (fl.r.kind === 'arr' ? 0.05 : 0.12);
      fl.obj.position.copy(p);
      fl.obj.rotation.set(climb + aoa, -yaw, -fl.bank);
      const vis = fl.state !== 'gate' || fl.wait < 3;
      fl.obj.visible = vis && (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2 < (this.light ? 18000 : 30000) ** 2;
      if (fl.obj.userData.beacon) fl.obj.userData.beacon.visible = (this.t * 1.1 + i * 0.37) % 1 < 0.15;
      // ---- state progression (clearances themselves come from the tower)
      const r = fl.r;
      if (fl.state === 'taxi' && fl.s >= r.sHold - 3 && fl.v < 0.5) fl.state = 'holding';
      if ((fl.state === 'luaw' || fl.state === 'holding') && fl.s > r.sHold + 2) fl.state = fl.cleared.takeoff ? 'lineup' : 'luaw';
      if ((fl.state === 'lineup' || fl.state === 'luaw') && fl.s >= r.sLine - 1 && fl.cleared.takeoff) fl.state = 'roll';
      if (fl.state === 'roll' && agl > 15) { fl.state = 'climb'; fl.tOff = this.t; }
      if (fl.state === 'arrival' && fl.s >= r.sTd - 5) fl.state = 'landing';
      if (fl.state === 'landing' && fl.s >= r.sRollEnd) fl.state = 'vacating';
      if (fl.state === 'vacating' && fl.s >= r.sVacate) fl.state = 'taxiIn';
      if (fl.state === 'taxiIn' && fl.s >= R.len - 3) { this.remove(i); continue; }
      out.push({ id: fl.id, callsign: fl.callsign, ident: fl.ident || fl.callsign, type: fl.type, x: p.x, y: p.y, z: p.z, hdg: (yaw / D2R + 360) % 360, alt: p.y / FT, gs: fl.v / KT, ga: !!fl.ga, kind: r.kind, icao: r.icao, rwy: r.rwy, state: STATE_LABEL[fl.state] || '', hold: !!fl.atStop || (fl.blocked && fl.v < 0.5) });
    }
    this.list = out;
  }
}
const STATE_LABEL = { gate: 'PUSHBACK', taxi: 'TAXI', holding: 'HOLD SHORT', luaw: 'LINE UP & WAIT', lineup: 'LINING UP', roll: 'TAKEOFF', landing: 'LANDING', vacating: 'VACATING', taxiIn: 'TAXI IN' };
