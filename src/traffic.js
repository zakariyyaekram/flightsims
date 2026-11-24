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
import { taxiRoute, taxiPath, runwayExit, runwayCrossings, setTaxiCost } from './taxi.js?v=20261124d';

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
  if (st.length) return st.map((s, i) => ({ x: s.cx + s.nx * (s.G.T.L / 2 + 32), z: s.cz + s.nz * (s.G.T.L / 2 + 32), label: s.label, key: a.icao + ':' + i }));
  return [{ x: a.ramp.x, z: a.ramp.z, label: 'ramp', key: a.icao + ':ramp' }];
}
// stands in use (one aircraft per stand: a departure until it has left the stand, an arrival until it is removed)
let TAKEN = new Set();
function pickStand(a) {
  const free = standPoints(a).filter((q) => !TAKEN.has(q.key));
  return free.length ? pick(free) : null;
}
// footprint radius (m) ~ half the larger of length / span, used for ground and air separation
export const SIZE = { B77W: 37, B789: 31, B744: 36, A359: 34, A35K: 37, A333: 32, A321: 23, A320: 19, B738: 20, B39M: 20, E175: 16, C172: 6 };
const sizeOf = (t) => SIZE[t] || 20;

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
  const st = pickStand(a);
  const side = st ? Math.sign(alongLat(e, st.x, st.z)) || 1 : 1;
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
  let ground = [], cross = [], via = '', exitK = -1, tp = null;
  if (ex) {
    const turn = [P2(rollEnd), P2(ex.jAlong - 15, ex.lat * f.r.wid * 0.25), P2((ex.jAlong + ex.along) / 2, ex.lat * (f.r.wid / 2 + 5)), { x: ex.x, z: ex.z }];
    tp = st ? taxiPath(proto.icao, ex.x, ex.z, st.x, st.z) : null;
    const raw = [...turn, ...(tp ? tp.pts.slice(1) : [])];
    const sm = chaikin(raw, 2); exitK = 3;
    const cr = runwayCrossings(proto.icao, sm, f.r);
    ground = cr.pts; cross = cr.cross; via = tp ? tp.viaText : '';
  }
  const gStart = pts.length;
  const gv = taxiSpeeds(ground, 9); if (gv.length) gv[0] = Math.min(gv[0], 14);
  ground.forEach((q, i) => { if (i === 0) return; pts.push(v3(q.x, el, q.z)); sp.push(gv[i]); });
  const route = new Route(pts, sp);
  const r = { route, icao: proto.icao, rwy: proto.rwy, kind: 'arr', elev: el, end: e, rw: f.r, a, via, stand: st && tp ? st.label : 'the ramp', standKey: st && tp ? st.key : null, exitSide: ex ? ex.lat : 0 };
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
  let tr = null, st = null;
  for (let k = 0; k < 4 && !tr; k++) { st = pickStand(a); if (!st) return null; tr = taxiRoute(icao, rwyId, st.x, st.z); if (tr && tr.len > 9000) tr = null; }
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
  const r = { route, icao, rwy: e.id, kind: 'dep', elev: el, end: e, rw: f.r, a, via: tr.viaText, viaList: tr.via, stand: st.label, standKey: st.key };
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
    { name: 'WEST PLAN', arr: [['28L', 1, 24000, 95, 0], ['28R', -1, 24000, 95, 40]], dep: [['1L', 300, 2600, 85, ['A320', 'B738', 'B39M', 'A321', 'E175']], ['1R', 75, 3800, 110, ['B77W', 'B789', 'A321', 'B738']]] },
    { name: 'SOUTHEAST PLAN', arr: [['19L', -1, 22000, 100, 0], ['19R', 1, 22000, 100, 45]], dep: [['10L', 40, 3000, 95, AIRLINER], ['10R', 140, 4000, 110, AIRLINER]] },
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
    this.pairs = new Map(); this.airPairs = new Map(); this.events = [];
    this.stats = { groundCollisions: 0, airCollisions: 0, nearMiss: 0, minGroundRatio: Infinity, minAirM: Infinity, safetyGA: 0, rto: 0, entryHolds: 0, deadlocks: 0, errors: 0, airConflicts: 0, groundYields: 0 };
    this.onGoAround = null; this.onRemove = null;
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
  /** choose each airport's runway configuration from the wind and (re)build its flows.
   *  At start-up the airport is populated fresh; later flow changes keep the flights already in the
   *  system on the old runways (the tower protects the transition) and start the new flow after a pause,
   *  like X-Plane holding a flow open until the traffic on it has cleared. */
  configure(weather) {
    const fresh = this.t < 5;
    for (const icao of Object.keys(CONFIGS)) {
      const c = pickConfig(icao, weather);
      if (this.cfg[icao] === c) continue;
      const had = !!this.cfg[icao];
      this.cfg[icao] = c;
      if (fresh || !had) for (let i = this.flights.length - 1; i >= 0; i--) { const f = this.flights[i]; if (!f.ga && f.r.icao === icao) this.remove(i); }
      this.flows = this.flows.filter((f) => f.icao !== icao);
      const a = AIRPORTS.find((q) => q.icao === icao); if (!a) continue;
      for (const [rwy, side, join, every, off] of c.arr) {
        const p = arrivalProto(icao, rwy, side, join); if (!p) continue;
        this.flows.push({ icao, kind: 'arr', rwy, p, a, every, timer: off, types: ARR_TYPES[icao] });
      }
      for (const [rwy, hdg, at, every, types] of c.dep) this.flows.push({ icao, kind: 'dep', rwy, hdg, at, a, every, timer: every * 0.3, types });
      const mine = this.flows.filter((q) => q.icao === icao);
      if (fresh || !had) {
        // pre-populate so the airport is already busy: arrivals spread along the approach, departures taxiing
        for (const f of mine) {
          if (f.kind === 'arr') { for (const k of [0.3, 0.68]) this.spawn(f, k); }
          else { this.spawn(f, 0.35 + rnd() * 0.3); this.spawn(f, -1); }
          f.timer = f.every * (0.4 + rnd() * 0.6);
        }
      } else for (const f of mine) f.timer = 150 + f.every * rnd(); // flow change: let the old flow drain first
    }
  }
  model(type, lv) {
    const key = type + lv; let list = this.models.get(key); if (!list) this.models.set(key, (list = []));
    const free = list.find((o) => !o.userData.busy);
    if (free) { free.userData.busy = true; free.visible = true; return free; }
    const o = buildAirliner(type, lv); o.rotation.order = 'YXZ'; o.userData.busy = true; this.group.add(o); list.push(o); return o;
  }
  newFlight(o) {
    const fl = { id: NEXT_ID++, v: 0, k: 1, prevYaw: null, bank: 0, wait: 0, cleared: {}, msg: {}, holdT: 0, lift: 0, altOff: 0, altOffT: 0, resT: -1, rad: sizeOf(o.type), limS: Infinity, ...o };
    this.flights.push(fl); return fl;
  }
  /** frac: arrivals = fraction along the approach (0 = entry); departures = fraction along the taxi (-1 = at the gate) */
  spawn(f, frac = 0) {
    if (this.flights.filter((x) => !x.ga).length >= (this.light ? 14 : 26)) return null;
    const type = pick(f.types); const lv = pick(AIRLINE_FOR[type] || ['UAL']); const L = LIVERIES[lv];
    let r;
    TAKEN = this.standsInUse(); setTaxiCost(this.taxiCostFor(f.icao));
    try { r = f.kind === 'arr' ? buildArrival(f.p, f.a) : buildDeparture(f.icao, f.rwy, f.hdg, f.at, f.a); } catch (e) { console.warn('AI route', e); r = null; }
    setTaxiCost(null);
    if (!r) return null;
    const heavy = HEAVY.has(type), o = this.tmp;
    let s0 = 0, st0 = 'gate';
    if (f.kind === 'arr') s0 = frac > 0 ? r.sThr * frac : 0;
    else if (frac > 0) { s0 = r.sHold * frac; st0 = 'taxi'; }
    // never spawn into someone else's airspace / onto another aircraft
    r.route.at(s0, o);
    const rad = sizeOf(type);
    for (const q of this.flights) {
      if (!q.pos) continue;
      const dh = Math.hypot(q.pos.x - o.pos.x, q.pos.z - o.pos.z), dv = Math.abs(q.pos.y - o.pos.y);
      if (f.kind === 'arr') {
        if (dh < 5500 && dv < 450) return null;
        if (q.r.kind === 'arr' && q.state === 'arrival' && q.r.rwy === r.rwy && Math.abs((q.r.sThr - q.s) - (r.sThr - s0)) < (q.heavy ? 5.5 : 3.5) * 1852) return null;
      } else if (q.agl < 5 && dh < rad + sizeOf(q.type) + 30) return null;
    }
    const P = this.player;
    if (P && Math.hypot(P.x - o.pos.x, P.z - o.pos.z) < (f.kind === 'arr' ? 4000 : rad + (P.rad || 6) + 40) && Math.abs((P.y ?? o.pos.y) - o.pos.y) < 450) return null;
    const num = (100 + Math.floor(rnd() * 2400)).toString();
    const fl = this.newFlight({ obj: this.model(type, lv), r, s: s0, callsign: `${L.call} ${num}${heavy ? ' heavy' : ''}`, ident: L.icao + num, type, lv, heavy, rad, altOff: 0, altOffT: 0, resT: -1 });
    if (f.kind === 'arr') { fl.state = 'arrival'; fl.v = 110; }
    else {
      fl.state = st0; fl.wait = 4 + rnd() * 6;
      if (st0 === 'taxi') { fl.msg.taxi = true; fl.msg.req = true; fl.cleared.taxi = true; fl.standFree = true; for (const st of r.stops) if (st.s < fl.s - 1) st.ok = true; }
    }
    return fl;
  }
  standsInUse() {
    const S = new Set();
    for (const f of this.flights) if (f.r.standKey && !(f.r.kind === 'dep' && f.standFree) && f.r.kind !== 'missed') S.add(f.r.standKey);
    return S;
  }
  /** edge-cost hook for the taxi router: avoid taxiing head-on against aircraft already on a taxiway */
  taxiCostFor(icao) {
    const cells = new Map(), o = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), v: 0 }, C = 60;
    const key = (x, z) => Math.floor(x / C) + ',' + Math.floor(z / C);
    for (const f of this.flights) {
      if (f.ga || f.r.icao !== icao || !f.r.route) continue;
      let s0, s1;
      if (f.r.kind === 'dep' && (f.state === 'gate' || f.state === 'taxi')) { s0 = f.s; s1 = f.r.sHold; }
      else if (f.r.kind === 'arr' && f.state !== 'gate') { s0 = Math.max(f.s, f.r.sVacate); s1 = f.r.route.len; }
      else continue;
      for (let s = s0; s < s1; s += 25) {
        f.r.route.at(s, o); const k = key(o.pos.x, o.pos.z);
        if (!cells.has(k)) cells.set(k, []); cells.get(k).push([o.pos.x, o.pos.z, o.dir.x, o.dir.z]);
      }
    }
    if (!cells.size) return null;
    return (A, B) => {
      const mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2, dx = B.x - A.x, dz = B.z - A.z, L = Math.hypot(dx, dz) || 1;
      const cx = Math.floor(mx / C), cz = Math.floor(mz / C);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const list = cells.get((cx + i) + ',' + (cz + j)); if (!list) continue;
        for (const q of list) if ((q[0] - mx) ** 2 + (q[1] - mz) ** 2 < 900 && (q[2] * dx + q[3] * dz) / L < -0.6) return 4;
      }
      return 1;
    };
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
    if (this.sim && this.sim.weather !== this._w) { this._w = this.sim.weather; try { this.configure(this._w); } catch (e) { console.warn('AI configure', e); } }
    dt = Math.min(dt, 0.25); this.t += dt;
    for (const f of this.flows) {
      f.timer -= dt;
      if (f.timer <= 0) { const fl = this.spawn(f, f.kind === 'dep' ? -1 : 0); f.timer = fl ? f.every * (0.75 + rnd() * 0.5) : 12 + rnd() * 10; }
    }
    this.ix = this.ix || new Map();
    try { this.planGround(dt); } catch (e) { this.stats.errors++; console.warn('AI ground plan', e); }
    try { this.planAir(dt); } catch (e) { this.stats.errors++; console.warn('AI air plan', e); }
    const out = [];
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const fl = this.flights[i];
      // one broken flight must never take the simulator down with it
      try { if (!this.step(fl, i, dt, cam, out)) continue; } catch (e) { this.stats.errors++; console.warn('AI flight', fl.callsign, e); this.remove(i); }
    }
    this.list = out;
    this.monitor();
  }

  // ---------------------------------------------------------------- one flight, one frame
  step(fl, i, dt, cam, out) {
    const R0 = fl.r.route, o = this.tmp;
    // ---- runway safety net (independent of the tower): never land onto an occupied runway
    if (fl.state === 'arrival' && fl.r.sTd - fl.s < 1500) {
      const why = this.landingBlocked(fl);
      if (why) { this.stats.safetyGA++; this.log('go-around', fl, why); this.goAround(fl, why); this.onGoAround?.(fl, why); }
    }
    if (fl.ga && fl.goT == null && fl.pos) {
      const L = R0.len, sm = ((fl.s % L) + L) % L;
      if ((sm > L - 1100 || sm < 60) && fl.cleared.land !== true && this.gaRunwayBlocked(fl)) { fl.goT = 0; fl.goY = null; this.stats.safetyGA++; this.log('go-around', fl, 'runway occupied'); this.onGoAround?.(fl, 'traffic on the runway'); }
    }
    const R = fl.r.route;
    R.at(fl.s, o);
    // ---- target speed: route profile x tower speed control, limited by stops and traffic
    let vt = o.v * (fl.state === 'arrival' ? fl.k : 1);
    if (fl.state === 'gate' || fl.state === 'parked') vt = 0;
    const stops = fl.r.stops || [];
    let stop = null;
    for (const st of stops) {
      if (st.s <= fl.s - 2) continue;
      if (!st.ok) { stop = st; break; }
      if (st.s - fl.s < 90 && !this.stopSafe(fl, st)) { stop = st; if (!st.held) { st.held = true; this.stats.entryHolds++; } break; }
    }
    if (stop) { const d = stop.s - fl.s; vt = Math.min(vt, d <= 0.6 ? 0 : Math.sqrt(2 * 0.7 * d)); fl.atStop = d < 4 && fl.v < 0.5 ? stop : null; } else fl.atStop = null;
    const onGround = (fl.pos ? fl.agl : 99) < 3 && !fl.ga;
    if (onGround && Number.isFinite(fl.limS)) { const d = fl.limS - fl.s; vt = Math.min(vt, d <= 0.3 ? 0 : Math.sqrt(2 * 1.0 * d)); }
    // rejected takeoff if the runway ahead is suddenly not clear (below ~70 kt)
    if (fl.state === 'roll' && fl.v < 36 && this.rollBlocked(fl)) { vt = 0; if (!fl.rto) { fl.rto = true; this.stats.rto++; this.log('reject', fl, 'runway ahead blocked'); } }
    else if (fl.state === 'roll') fl.rto = false;
    // a departure only appears at the stand once its spot is clear
    if (fl.state === 'gate' && fl.wait < 3.2 && this.standBlocked(fl)) fl.wait = 3.2;
    // ---- acceleration limits
    const acc = fl.state === 'roll' ? (fl.rto ? 3.5 : 2.3) : onGround ? (vt < fl.v ? (fl.v > 18 ? 2.6 : 1.4) : 0.7) : 2.5;
    fl.v += Math.max(-acc * dt, Math.min(acc * dt, vt - fl.v));
    if (!onGround && fl.state !== 'gate' && fl.state !== 'roll') fl.v = Math.max(fl.v, Math.min(o.v, 30));
    fl.s += fl.v * dt;
    if (fl.state === 'gate') fl.wait -= dt;
    if (fl.r.kind === 'dep' && fl.s > 150) fl.standFree = true;
    if (!R.loop && fl.s >= R.len) { this.remove(i); return false; }
    R.at(fl.s, o);
    const p = o.pos, d = o.dir;
    fl.yRoute = p.y;
    // GA go-around: climb away from the runway until the circuit profile is regained
    if (fl.ga && fl.goT != null) {
      fl.goT += dt; if (fl.goY == null) fl.goY = Math.max(p.y, fl.r.elev + 15);
      const y = fl.goY + 3.5 * fl.goT;
      if (p.y >= y || fl.goT > 120) { fl.goT = null; fl.goY = null; } else p.y = y;
    }
    // ---- vertical conflict resolution offset (TCAS-style level-off / climb), 1500 fpm max
    if (this.t > fl.resT) fl.altOffT = 0;
    const rate = (fl.ga ? 6 : 10) * dt; fl.altOff += Math.max(-rate, Math.min(rate, fl.altOffT - fl.altOff));
    if (Math.abs(fl.altOff) > 0.01) p.y = Math.max(fl.r.elev + (p.y - fl.r.elev > 150 ? 150 : p.y - fl.r.elev), p.y + fl.altOff);
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
    if (fl.state === 'taxiIn' && fl.s >= R.len - 3) { this.remove(i); return false; }
    out.push({ id: fl.id, callsign: fl.callsign, ident: fl.ident || fl.callsign, type: fl.type, x: p.x, y: p.y, z: p.z, hdg: (yaw / D2R + 360) % 360, alt: p.y / FT, gs: fl.v / KT, ga: !!fl.ga, kind: r.kind, icao: r.icao, rwy: r.rwy, state: STATE_LABEL[fl.state] || '', hold: !!fl.atStop || (fl.yieldTo && fl.v < 0.5) });
    return true;
  }

  log(kind, fl, why) { this.events.unshift({ t: Math.round(this.t), kind, who: fl.ident || fl.callsign, why }); if (this.events.length > 40) this.events.pop(); }

  // ---------------------------------------------------------------- everyone near a point (AI + the player)
  others(self) {
    const L = [];
    for (const q of this.flights) if (q !== self && q.pos && !(q.state === 'gate' && q.wait >= 3)) L.push({ fl: q, x: q.pos.x, z: q.pos.z, y: q.pos.y, agl: q.agl, v: q.v, state: q.state, kind: q.r.kind, rw: q.r.rw, r: q.r, rad: q.rad });
    const P = this.player;
    if (P) L.push({ player: true, x: P.x, z: P.z, y: P.y ?? 0, agl: P.agl ?? 0, v: P.v || 0, state: P.onGround ? 'ground' : 'air', rad: P.rad || 6 });
    return L;
  }
  ixOf(a) {
    let L = this.ix.get(a); if (L) return L;
    L = [];
    for (const r of a.runways) for (const s of a.runways) {
      if (r === s) continue;
      const px = r.le[0], pz = r.le[1], dx = r.he[0] - px, dz = r.he[1] - pz, qx = s.le[0], qz = s.le[1], ex = s.he[0] - qx, ez = s.he[1] - qz;
      const den = dx * ez - dz * ex; if (Math.abs(den) < 1e-6) continue;
      const t = ((qx - px) * ez - (qz - pz) * ex) / den, w = ((qx - px) * dz - (qz - pz) * dx) / den;
      if (t < -0.02 || t > 1.02 || w < -0.02 || w > 1.02) continue;
      L.push({ r, s, x: px + dx * t, z: pz + dz * t });
    }
    this.ix.set(a, L); return L;
  }
  /** seconds for an AI arrival (or the player on final) to reach the threshold of runway rw; Infinity if none */
  arrivalEta(rw, self, endId = null) {
    let best = Infinity;
    for (const q of this.flights) {
      if (q === self || q.r.kind !== 'arr' || q.r.rw !== rw || q.state !== 'arrival') continue;
      if (endId && q.r.end.id !== endId) continue;
      best = Math.min(best, (q.r.sThr - q.s) / Math.max(40, q.v));
    }
    const P = this.player;
    if (P && !P.onGround && (P.agl ?? 0) < 400) {
      for (const e of [0, 1]) {
        const end = runwayEnd(rw, e); if (endId && end.id !== endId) continue;
        const al = alongEnd(end, P.x, P.z), lat = Math.abs((P.x - end.x) * end.dir[1] - (P.z - end.z) * end.dir[0]);
        const gs = (P.vx ?? 0) * end.dir[0] + (P.vz ?? 0) * end.dir[1];
        if (al < 0 && al > -9000 && lat < 400 && gs > 15) best = Math.min(best, -al / gs);
      }
    }
    return best;
  }
  /** may a flight pass a stop it has been cleared through? (runway entry / crossing / start of the roll) */
  stopSafe(fl, st) {
    if (st._t === this.t) return st._ok;
    st._t = this.t; st._ok = true;
    const rw = st.kind === 'cross' ? st.rw : fl.r.rw; if (!rw) return true;
    const O = this.others(fl);
    if (st.kind === 'cross' || st.kind === 'hold') {
      for (const q of O) {
        if (q.agl > 30 || !onRunway(rw, q.x, q.z, 10)) continue;
        const moving = q.state === 'roll' || q.state === 'landing' || (q.player && q.v > 8);
        if (moving || st.kind === 'cross') {
          // a crossing needs the runway clear near the crossing point; a slow aircraft far down the runway is fine
          if (st.kind === 'cross' && !moving && Math.abs(rLocal(rw, q.x, q.z).u - rLocal(rw, fl.pos.x, fl.pos.z).u) > 700) continue;
          return (st._ok = false);
        }
      }
      if (this.arrivalEta(rw, fl) < (st.kind === 'cross' ? 30 : 22)) return (st._ok = false);
      return true;
    }
    if (st.kind === 'line') {
      if (!fl.cleared.takeoff) return true;
      const end = fl.r.end, me = alongEnd(end, fl.pos.x, fl.pos.z);
      for (const q of O) {
        if (q.agl > 25 || !onRunway(rw, q.x, q.z, 10)) continue;
        if (alongEnd(end, q.x, q.z) > me - 40) return (st._ok = false);
      }
      if (this.arrivalEta(rw, fl, runwayEnd(rw, end.id === rw.rwy[0] ? 1 : 0).id) < 120) return (st._ok = false);
      return (st._ok = !this.ixConflict(fl, me));
    }
    return true;
  }
  /** departure about to roll: anything at, or due at, an intersection with another runway when we get there? */
  ixConflict(fl, me) {
    const a = fl.r.a || AIRPORTS.find((q) => q.icao === fl.r.icao); if (!a) return false;
    for (const ix of this.ixOf(a)) {
      if (ix.r !== fl.r.rw) continue;
      const dIx = alongEnd(fl.r.end, ix.x, ix.z) - me; if (dIx < -30) continue;
      const tMe = Math.sqrt(2 * Math.max(0, dIx) / 2.0) + 4;
      for (const q of this.flights) {
        if (q === fl || !q.pos || q.r.rw !== ix.s) continue;
        const dq = Math.hypot(q.pos.x - ix.x, q.pos.z - ix.z);
        if (q.agl < 30 && q.v < 25 && dq < 120 && onRunway(ix.s, q.pos.x, q.pos.z, 10)) return true;
        if (q.r.kind === 'arr' && (q.state === 'arrival' || q.state === 'landing')) {
          const t = (Math.max(0, alongEnd(q.r.end, ix.x, ix.z) - alongEnd(q.r.end, q.pos.x, q.pos.z))) / Math.max(30, q.v);
          if (alongEnd(q.r.end, q.pos.x, q.pos.z) < alongEnd(q.r.end, ix.x, ix.z) + 40 && Math.abs(t - tMe) < 14) return true;
        }
        if (q.r.kind === 'dep' && q.state === 'roll' && alongEnd(q.r.end, q.pos.x, q.pos.z) < alongEnd(q.r.end, ix.x, ix.z) + 40) return true;
      }
    }
    return false;
  }
  rollBlocked(fl) {
    const end = fl.r.end, me = alongEnd(end, fl.pos.x, fl.pos.z), rw = fl.r.rw;
    for (const q of this.others(fl)) {
      if (q.agl > 25 || !onRunway(rw, q.x, q.z, 6)) continue;
      const al = alongEnd(end, q.x, q.z);
      if (al > me + 10 && al < me + 2400 && !(q.kind === 'dep' && q.state === 'roll' && q.v > fl.v + 5)) return true;
    }
    return false;
  }
  /** reason an arrival on short final must go around, or null */
  landingBlocked(fl) {
    const rw = fl.r.rw, end = fl.r.end;
    for (const q of this.others(fl)) {
      if (q.agl > 25 || !onRunway(rw, q.x, q.z, 10)) continue;
      const al = alongEnd(end, q.x, q.z);
      if (!q.player && q.r.rw === rw && ((q.state === 'landing' || q.state === 'vacating') && al > 1400 && q.v > 20)) continue;
      if (!q.player && q.r.rw === rw && q.state === 'roll' && q.r.end.id === end.id && al > 1000 && q.v > 30) continue;
      return q.player ? 'traffic on the runway' : 'traffic on the runway';
    }
    const a = fl.r.a || AIRPORTS.find((q) => q.icao === fl.r.icao);
    if (a) for (const ix of this.ixOf(a)) {
      if (ix.r !== rw) continue;
      const tMe = (fl.r.sThr - fl.s) / Math.max(40, fl.v) + Math.max(0, alongEnd(end, ix.x, ix.z)) / 55;
      for (const q of this.flights) {
        if (q === fl || !q.pos || q.r.rw !== ix.s || q.agl > 30) continue;
        if (q.v < 25 && Math.hypot(q.pos.x - ix.x, q.pos.z - ix.z) < 110 && onRunway(ix.s, q.pos.x, q.pos.z, 10)) return 'traffic crossing the runway';
        if (q.r.kind === 'dep' && q.state === 'roll' && alongEnd(q.r.end, q.pos.x, q.pos.z) < alongEnd(q.r.end, ix.x, ix.z) + 40) {
          const d = alongEnd(q.r.end, ix.x, ix.z) - alongEnd(q.r.end, q.pos.x, q.pos.z), tq = (Math.sqrt(q.v * q.v + 4.6 * Math.max(0, d)) - q.v) / 2.3;
          if (Math.abs(tq - tMe) < 12) return `traffic departing runway ${q.r.rwy}`;
        }
      }
    }
    // in trail on the same runway and far too close: the trailing (farther) aircraft goes around early
    const dMe = fl.r.sThr - fl.s;
    for (const q of this.flights) {
      if (q === fl || q.r.kind !== 'arr' || q.state !== 'arrival' || q.r.rw !== rw || q.r.end.id !== end.id) continue;
      const dq = q.r.sThr - q.s; if (dq < dMe && dMe - dq < 1700) return 'too close to traffic ahead';
    }
    return null;
  }
  gaRunwayBlocked(fl) {
    const rw = fl.r.rw;
    for (const q of this.others(fl)) if (q.agl < 20 && onRunway(rw, q.x, q.z, 10) && !(q.fl && q.fl.ga)) return true;
    return false;
  }
  standBlocked(fl) {
    const o = this.tmp; fl.r.route.at(0, o); const x = o.pos.x, z = o.pos.z;
    for (const q of this.others(fl)) if (q.agl < 5 && Math.hypot(q.x - x, q.z - z) < fl.rad + q.rad + 10) return true;
    return false;
  }

  // ---------------------------------------------------------------- ground conflict resolution
  // Each taxiing aircraft looks ahead along its own route (stopping distance + margin, clipped at its next
  // hold). A path that runs into another aircraft's position makes it stop behind it; two paths that cross
  // give way by arrival time at the conflict point (sticky so they don't swap), the way FlightGear's ground
  // controller and X-Plane's ATC hold taxiing traffic. Nothing ever drives through anything.
  planGround(dt) {
    const M = [], o = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), v: 0 }, STEP = 6;
    for (const fl of this.flights) {
      fl.limS = Infinity; fl.yieldTo = null; fl.yieldKind = null;
      if (!fl.pos || fl.ga || fl.agl > 3) continue;
      if (fl.state === 'gate' && fl.wait >= 3) continue;
      const fast = fl.state === 'roll' || fl.state === 'landing';
      const e = { fl, x: fl.pos.x, z: fl.pos.z, rad: fl.rad, v: fl.v, fast, S: [] };
      if (!fast) {
        const R = fl.r.route; let lim = R.len;
        for (const st of fl.r.stops || []) if (st.s > fl.s - 2 && !st.ok) { lim = Math.min(lim, st.s); break; }
        if (fl.state === 'gate') lim = Math.min(lim, fl.s + 40);
        const L = Math.min(170, fl.v * fl.v / 2 + 70 + fl.rad);
        for (let k = 1; k * STEP <= L && fl.s + k * STEP <= lim + 0.5; k++) { R.at(fl.s + k * STEP, o); e.S.push([o.pos.x, o.pos.z, k * STEP]); }
      }
      M.push(e);
    }
    const P = this.player;
    if (P && P.onGround) {
      const e = { player: true, x: P.x, z: P.z, rad: P.rad || 6, v: P.v || 0, fast: false, S: [] };
      if (e.v > 1) for (let k = 1; k <= 6; k++) e.S.push([P.x + (P.vx || 0) * k, P.z + (P.vz || 0) * k, e.v * k]);
      M.push(e);
    }
    const seen = new Set();
    const limit = (E, dist, other, kind) => {
      if (E.player || E.fast) return;
      const s = E.fl.s + Math.max(0, dist);
      if (s < E.fl.limS) { E.fl.limS = s; E.fl.yieldTo = other.player ? 'player' : other.fl; E.fl.yieldKind = kind; }
    };
    const firstStatic = (A, B, thr, dAB) => {
      for (const q of A.S) { const d = Math.hypot(q[0] - B.x, q[1] - B.z); if (d < thr && d < dAB - 0.5) return q[2]; }
      return -1;
    };
    const rank = (E) => E.player ? 9 : ({ lineup: 6, luaw: 6, vacating: 5, taxiIn: 4, taxi: 3, holding: 2, gate: 1 }[E.fl.state] || 3);
    for (let i = 0; i < M.length; i++) for (let j = i + 1; j < M.length; j++) {
      const A = M[i], B = M[j];
      const dAB = Math.hypot(A.x - B.x, A.z - B.z); if (dAB > 420) continue;
      const thr = A.rad + B.rad + 9;
      const sA = A.player || A.fast ? -1 : firstStatic(A, B, thr, dAB);
      const sB = B.player || B.fast ? -1 : firstStatic(B, A, thr, dAB);
      const key = (A.player ? 'P' : A.fl.id) + '|' + (B.player ? 'P' : B.fl.id);
      if (sA >= 0 && sB >= 0) {
        limit(A, sA - STEP, B, 'mutual'); limit(B, sB - STEP, A, 'mutual');
        if (!A.player && !B.player) {
          seen.add(key); const pr = this.pairs.get(key) || { dead: 0 }; pr.dead += dt; this.pairs.set(key, pr);
          if (pr.dead > 25) { // true deadlock (nose to nose): the lower-priority flight is withdrawn rather than driven through
            const loser = rank(A) < rank(B) || (rank(A) === rank(B) && A.fl.id > B.fl.id) ? A.fl : B.fl;
            const k = this.flights.indexOf(loser); if (k >= 0) { this.stats.deadlocks++; const w = loser === A.fl ? B.fl : A.fl; this.log('deadlock', loser, `withdrawn (${loser.state} ${loser.r.icao} vs ${w.ident} ${w.state}) @${Math.round(loser.pos.x)},${Math.round(loser.pos.z)}`); this.onRemove?.(loser, 'deadlock'); this.remove(k); }
            this.pairs.delete(key);
          }
        }
        continue;
      }
      if (sA >= 0) { limit(A, sA - STEP, B, 'follow'); continue; }
      if (sB >= 0) { limit(B, sB - STEP, A, 'follow'); continue; }
      if (!A.S.length || !B.S.length || A.fast || B.fast) continue;
      // crossing paths: who reaches the conflict point first goes; the other holds short of it
      let iA = -1, jB = -1;
      for (const a of A.S) { for (const b of B.S) if (Math.hypot(a[0] - b[0], a[1] - b[1]) < thr) { iA = a[2]; break; } if (iA >= 0) break; }
      if (iA < 0) continue;
      for (const b of B.S) { for (const a of A.S) if (Math.hypot(a[0] - b[0], a[1] - b[1]) < thr) { jB = b[2]; break; } if (jB >= 0) break; }
      seen.add(key);
      let pr = this.pairs.get(key);
      if (!pr || pr.win == null) {
        const tA = iA / Math.max(A.v, 1.5), tB = jB / Math.max(B.v, 1.5);
        let win;
        if (A.player) win = 'A'; else if (B.player) win = 'B';
        else if (tA + 2 < tB) win = 'A'; else if (tB + 2 < tA) win = 'B';
        else win = rank(A) > rank(B) || (rank(A) === rank(B) && A.fl.id < B.fl.id) ? 'A' : 'B';
        pr = { ...(pr || {}), win, dead: 0 }; this.pairs.set(key, pr); this.stats.groundYields++;
      }
      if (pr.win === 'A') limit(B, jB - STEP, A, 'cross'); else limit(A, iA - STEP, B, 'cross');
    }
    for (const k of this.pairs.keys()) if (!seen.has(k)) this.pairs.delete(k);
  }

  // ---------------------------------------------------------------- airborne conflict detection & resolution
  // Closest-point-of-approach prediction over 45 s; the lower-priority aircraft levels off below or climbs
  // above the other (TCAS-like vertical resolution), arrivals on final go around instead.
  planAir(dt) {
    const A = [];
    for (const fl of this.flights) {
      if (!fl.pos || !fl.dir || fl.agl < 25 || fl.state === 'gate') continue;
      A.push({ fl, x: fl.pos.x, y: fl.pos.y, z: fl.pos.z, vx: fl.dir.x * fl.v, vy: fl.dir.y * fl.v, vz: fl.dir.z * fl.v, elev: fl.r.elev });
    }
    const P = this.player;
    if (P && !P.onGround && (P.agl ?? 0) > 20) A.push({ player: true, x: P.x, y: P.y, z: P.z, vx: P.vx || 0, vy: P.vy || 0, vz: P.vz || 0 });
    const rank = (E) => E.player ? 9 : E.fl.state === 'arrival' ? 5 : E.fl.state === 'climb' ? 4 : E.fl.state === 'missed' ? 3 : 2;
    const seen = new Set();
    for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
      const a = A[i], b = A[j];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      if (dx * dx + dz * dz > 9000 * 9000) continue;
      if (!a.player && !b.player) {
        const fa = a.fl, fb = b.fl;
        // simultaneous parallel approaches / in-trail spacing are the tower's job (with its own backstops)
        // (only once both are established on their final approach courses; joining legs that cross are checked)
        if (fa.r.icao === fb.r.icao && this.established(fa) && this.established(fb)) continue;
      }
      const ux = b.vx - a.vx, uy = b.vy - a.vy, uz = b.vz - a.vz, uu = ux * ux + uy * uy + uz * uz;
      const t = uu > 1e-6 ? Math.max(0, Math.min(70, -(dx * ux + dy * uy + dz * uz) / uu)) : 0;
      const mx = dx + ux * t, my = dy + uy * t, mz = dz + uz * t, h = Math.hypot(mx, mz);
      const now = Math.hypot(dx, dz) < 1300 && Math.abs(dy) < 160;
      if (!(now || (h < 1500 && Math.abs(my) < 180))) continue;
      const key = (a.player ? 'P' : a.fl.id) + '|' + (b.player ? 'P' : b.fl.id); seen.add(key);
      if (!this.airPairs.has(key)) { this.airPairs.set(key, 1); this.stats.airConflicts++; }
      const L = rank(a) < rank(b) || (rank(a) === rank(b) && !a.player && !b.player && a.fl.id > b.fl.id) ? a : b, W = L === a ? b : a;
      if (L.player) continue;
      const fl = L.fl;
      if (b.player || a.player) fl.alertPlayer = this.t;
      if (fl.state === 'arrival' && fl.r.sThr - fl.s < 9000) { this.stats.safetyGA++; this.log('go-around', fl, 'traffic conflict'); this.goAround(fl, 'traffic'); this.onGoAround?.(fl, 'traffic'); continue; }
      const yR = fl.yRoute ?? fl.pos.y, floor = fl.r.elev + 180;
      let tgt;
      if (L.y <= W.y && W.y - 300 >= floor) tgt = Math.min(0, W.y - 300 - yR);
      else tgt = Math.max(0, W.y + 300 - yR);
      fl.altOffT = fl.resT > this.t ? (tgt < 0 ? Math.min(fl.altOffT, tgt) : Math.max(fl.altOffT, tgt)) : tgt;
      fl.resT = this.t + 20;
    }
    for (const k of this.airPairs.keys()) if (!seen.has(k)) this.airPairs.delete(k);
  }

  established(fl) {
    if (fl.r.kind === 'missed') return fl.s < 5000 && !!fl.r.end && Math.abs((fl.pos.x - fl.r.end.x) * fl.r.end.dir[1] - (fl.pos.z - fl.r.end.z) * fl.r.end.dir[0]) < 300;
    if (fl.r.kind !== 'arr' || fl.state !== 'arrival' || fl.r.sThr - fl.s > 17000) return false;
    const e = fl.r.end, lat = Math.abs((fl.pos.x - e.x) * e.dir[1] - (fl.pos.z - e.z) * e.dir[0]);
    return lat < 300 && fl.dir.x * e.dir[0] + fl.dir.z * e.dir[1] > 0.97;
  }

  // ---------------------------------------------------------------- separation monitor (stats for tests / debugging)
  monitor() {
    const F = this.flights.filter((f) => f.pos && !(f.state === 'gate' && f.wait >= 3));
    const P = this.player;
    const all = F.map((f) => ({ id: f.ident, x: f.pos.x, y: f.pos.y, z: f.pos.z, agl: f.agl, rad: f.rad, st: f.state, rw: f.r.rw, kind: f.r.kind, icao: f.r.icao, est: this.established(f) }));
    if (P) all.push({ id: 'PLAYER', x: P.x, y: P.y ?? 0, z: P.z, agl: P.agl ?? 0, rad: P.rad || 6, st: P.onGround ? 'ground' : 'air' });
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j], h = Math.hypot(a.x - b.x, a.z - b.z); if (h > 2000) continue;
      const v = Math.abs(a.y - b.y);
      if (a.agl < 3 && b.agl < 3) {
        const ratio = h / (a.rad + b.rad); this.stats.minGroundRatio = Math.min(this.stats.minGroundRatio, ratio);
        if (ratio < 0.75) this.bad('groundCollision', a, b, h);
      } else {
        const d = Math.hypot(h, v); if (a.agl > 10 && b.agl > 10) this.stats.minAirM = Math.min(this.stats.minAirM, d);
        if (d < Math.max(40, (a.rad + b.rad) * 1.2)) this.bad('airCollision', a, b, d);
        else if (h < 450 && v < 90 && a.agl > 30 && b.agl > 30 && !(a.est && b.est && a.rw !== b.rw)) this.bad('nearMiss', a, b, h);
      }
    }
  }
  bad(kind, a, b, d) {
    const k = kind + a.id + b.id; this._bad = this._bad || new Map();
    if (this.t - (this._bad.get(k) ?? -1e9) < 30) return; this._bad.set(k, this.t);
    if (kind === 'groundCollision') this.stats.groundCollisions++; else if (kind === 'airCollision') this.stats.airCollisions++; else this.stats.nearMiss++;
    this.events.unshift({ t: Math.round(this.t), kind, who: a.id + '/' + b.id, why: `${a.st}/${b.st} ${Math.round(d)} m` }); if (this.events.length > 40) this.events.pop();
  }
}
const STATE_LABEL = { gate: 'PUSHBACK', taxi: 'TAXI', holding: 'HOLD SHORT', luaw: 'LINE UP & WAIT', lineup: 'LINING UP', roll: 'TAKEOFF', landing: 'LANDING', vacating: 'VACATING', taxiIn: 'TAXI IN' };
