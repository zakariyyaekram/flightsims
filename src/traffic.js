// AI air traffic: airliners flying real arrival / departure flows at SFO, OAK and SJC, plus Cessnas
// flying left/right closed traffic at GA fields. Exposes a plain list for the moving map / TCAS-style display.
import * as THREE from 'three';
import { AIRPORTS, findRunway, runwayEnd, heightAt } from './geo.js';
import { buildAirliner, LIVERIES } from './airliner.js';
import { flattenStatic } from './world.js';

const D2R = Math.PI / 180, G = 9.81, FT = 0.3048, KT = 0.514444;
const rnd = Math.random;
const pick = (a) => a[Math.floor(rnd() * a.length)];

// polyline with per-vertex speed, resampled from a set of 3-D control points
class Route {
  constructor(pts, speeds, loop = false) {
    this.p = pts; this.v = speeds; this.loop = loop;
    this.cum = [0]; for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    this.len = this.cum[this.cum.length - 1];
    this._i = 0;
  }
  at(s, o) {
    if (this.loop) s = ((s % this.len) + this.len) % this.len; else s = Math.min(this.len, Math.max(0, s));
    let i = this._i; if (this.cum[i] > s) i = 0;
    while (i < this.p.length - 2 && this.cum[i + 1] < s) i++;
    this._i = i;
    const L = this.cum[i + 1] - this.cum[i] || 1, t = (s - this.cum[i]) / L;
    o.pos.lerpVectors(this.p[i], this.p[i + 1], t);
    o.dir.subVectors(this.p[i + 1], this.p[i]).normalize();
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

// ---------------------------------------------------------------- flows
// arrivals: 3 deg glide from ~12 nm, joining from the side, rollout then vacate
function arrivalRoute(icao, rwyId, side = 1, join = 26000) {
  const f = findRunway(icao, rwyId); if (!f) return null;
  const e = runwayEnd(f.r, f.e), d = e.dir, el = e.elev;
  const lx = d[1], lz = -d[0]; // left of landing direction
  const P = (along, off, y) => v3(e.x + d[0] * along + lx * off * side, y, e.z + d[1] * along + lz * off * side);
  const gs = Math.tan(3 * D2R);
  const tdz = 330;
  const air = curve([P(-join - 14000, 14000, el + 2300), P(-join - 4000, 7000, el + 1700), P(-join, 0, el + 15 + gs * (join + tdz)), P(-join + 6000, 0, el + 15 + gs * (join - 6000 + tdz))], 60);
  const fin = []; for (let a = -join + 6000; a <= tdz; a += 150) fin.push(P(a, 0, el + Math.max(0, gs * (tdz - a)) + (a < tdz ? 0 : 0)));
  const roll = []; for (let a = tdz + 100; a <= Math.min(tdz + 1900, f.r.len - 300); a += 100) roll.push(P(a, 0, el));
  const pts = [...air, ...fin.slice(1), ...roll];
  const sp = pts.map((p, i) => {
    const h = p.y - el;
    if (i >= air.length + fin.length - 1) { const a = (i - (air.length + fin.length - 1)) / Math.max(1, roll.length - 1); return 70 - a * 55; }
    return h > 900 ? 120 : h > 450 ? 95 : 72;
  });
  return { route: new Route(pts, sp), icao, rwy: e.id, kind: 'arr', elev: el };
}
// departures: takeoff roll, initial climb, turn to a real-ish departure heading, climb out and vanish
function departureRoute(icao, rwyId, turnHdg, turnAt = 4000) {
  const f = findRunway(icao, rwyId); if (!f) return null;
  const e = runwayEnd(f.r, f.e), d = e.dir, el = e.elev;
  const P = (along, y) => v3(e.x + d[0] * along, y, e.z + d[1] * along);
  const ground = []; for (let a = 0; a <= 1800; a += 100) ground.push(P(a, el));
  const lo = P(1900, el + 4);
  const th = turnHdg * D2R, td = [Math.sin(th), -Math.cos(th)];
  const tp = P(1900 + turnAt, el + 520);
  const q = (k, y) => v3(tp.x + td[0] * k, y, tp.z + td[1] * k);
  const air = curve([lo, P(1900 + turnAt * 0.5, el + 260), tp, q(4000, el + 1100), q(12000, el + 2200), q(30000, el + 4200)], 60);
  const pts = [...ground, ...air.slice(1)];
  const sp = pts.map((p, i) => (i < ground.length ? 6 + 75 * Math.sqrt(i / (ground.length - 1)) : Math.min(140, 82 + (p.y - el) * 0.03)));
  return { route: new Route(pts, sp), icao, rwy: e.id, kind: 'dep', elev: el };
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
  return { route: new Route(pts, sp, true), icao, rwy: e.id, kind: 'pattern', elev: el };
}

// ---------------------------------------------------------------- manager
const FLOWS = [
  // west plan: the normal (~80 %) SFO configuration – land 28L/28R, depart 1L/1R
  { make: () => arrivalRoute('KSFO', '28L', 1, 24000), every: 95, types: ['A320', 'B738', 'B39M', 'A321', 'B789', 'B77W', 'E175'] },
  { make: () => arrivalRoute('KSFO', '28R', -1, 24000), every: 95, offset: 40, types: ['A320', 'B738', 'B39M', 'A321', 'B789', 'B77W', 'E175'] },
  { make: () => departureRoute('KSFO', '1L', 75, 3800), every: 85, offset: 20, types: ['A320', 'B738', 'B39M', 'A321', 'E175'] },
  { make: () => departureRoute('KSFO', '1R', 300, 2600), every: 110, offset: 60, types: ['B77W', 'B789', 'A321', 'B738'] },
  { make: () => arrivalRoute('KOAK', '30', 1, 20000), every: 150, offset: 10, types: ['B738', 'B39M', 'A320'] },
  { make: () => departureRoute('KOAK', '30', 250, 3000), every: 160, offset: 80, types: ['B738', 'B39M', 'A321'] },
  { make: () => arrivalRoute('KSJC', '30L', -1, 20000), every: 160, offset: 30, types: ['B738', 'A320', 'E175', 'A321'] },
  { make: () => departureRoute('KSJC', '30R', 270, 4500), every: 170, offset: 100, types: ['B738', 'A320', 'B39M'] },
];
const PATTERNS = [['KPAO', '31', true], ['KHWD', '28L', false], ['KSQL', '30', true], ['KLVK', '25R', false], ['KRHV', '31R', true], ['KCCR', '32R', false], ['KHAF', '30', false]];
const AIRLINE_FOR = { E175: ['SKW', 'ASA'], B77W: ['UAL'], B789: ['UAL', 'HAL'], A321: ['UAL', 'AAL', 'JBU', 'DAL', 'HAL'], A320: ['UAL', 'JBU', 'ASA', 'DAL', 'AAL'], B738: ['UAL', 'SWA', 'ASA', 'DAL', 'AAL'], B39M: ['UAL', 'SWA', 'ASA', 'AAL'] };
const GA_REGS = ['N52418', 'N738HP', 'N12KD', 'N64220', 'N9312F', 'N172TX', 'N5284Q'];

export class Traffic {
  constructor(scene, opts = {}) {
    this.scene = scene; this.group = new THREE.Group(); this.group.name = 'ai-traffic'; scene.add(this.group);
    this.enabled = true; this.list = []; this.flights = []; this.t = 0; this.night = 0;
    this.light = !!opts.light;
    this.flows = FLOWS.map((f, i) => ({ ...f, k: i, timer: f.offset || 0, proto: null })).filter((f) => (f.proto = f.make()));
    this.tmp = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), v: 0 };
    this.models = new Map();
  }
  async init(buildAircraftFn) {
    // GA pattern traffic (Cessna 172s)
    let proto = null;
    if (buildAircraftFn) {
      try { proto = flattenStatic(await buildAircraftFn({ envMap: null, reg: 'N52418', scheme: 2, interior: false, lights: false })); } catch (e) { console.warn('GA proto failed', e); }
    }
    PATTERNS.forEach(([icao, rwy, right], i) => {
      const r = patternRoute(icao, rwy, right); if (!r || !proto) return;
      const inner = proto.clone(); inner.rotation.y = Math.PI / 2; inner.position.y = 1.19;
      const o = new THREE.Group(); o.add(inner); o.rotation.order = 'YXZ'; this.group.add(o);
      this.flights.push({ obj: o, r, s: rnd() * r.route.len, callsign: GA_REGS[i % GA_REGS.length], type: 'C172', ga: true, prevYaw: null, bank: 0 });
    });
    // pre-populate airliner flows so the sky is already busy
    for (const f of this.flows) {
      const L = f.proto.route.len;
      for (let k = 0; k < 2; k++) { const s = L * (0.15 + 0.4 * k + rnd() * 0.1); this.spawn(f, s); }
      f.timer = f.every * (0.4 + rnd() * 0.6);
    }
  }
  model(type, lv) {
    const key = type + lv; let list = this.models.get(key); if (!list) this.models.set(key, (list = []));
    const free = list.find((o) => !o.userData.busy);
    if (free) { free.userData.busy = true; free.visible = true; return free; }
    const o = buildAirliner(type, lv); o.rotation.order = 'YXZ'; o.userData.busy = true; this.group.add(o); list.push(o); return o;
  }
  spawn(f, s = 0) {
    if (this.flights.filter((x) => !x.ga).length >= (this.light ? 12 : 22)) return;
    const type = pick(f.types); const lv = pick(AIRLINE_FOR[type] || ['UAL']); const L = LIVERIES[lv];
    const obj = this.model(type, lv);
    const num = (100 + Math.floor(rnd() * 2400)).toString();
    this.flights.push({ obj, r: f.proto, s, callsign: `${L.call} ${num}`, ident: L.icao + num, type, lv, prevYaw: null, bank: 0 });
  }
  setEnabled(on) { this.enabled = on; this.group.visible = on; if (!on) this.list = []; }
  setNight(n) { this.night = n; }
  update(dt, cam) {
    if (!this.enabled) return;
    dt = Math.min(dt, 0.25); this.t += dt;
    for (const f of this.flows) { f.timer -= dt; if (f.timer <= 0) { f.timer = f.every * (0.75 + rnd() * 0.5); this.spawn(f, 0); } }
    const o = this.tmp, out = [];
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const fl = this.flights[i]; const R = fl.r.route;
      fl.r.route.at(fl.s, o); fl.s += o.v * dt;
      if (!R.loop && fl.s >= R.len) { fl.obj.visible = false; fl.obj.userData.busy = false; this.flights.splice(i, 1); continue; }
      const p = o.pos, d = o.dir;
      const yaw = Math.atan2(d.x, -d.z), climb = Math.asin(Math.max(-1, Math.min(1, d.y)));
      const agl = p.y - fl.r.elev;
      if (fl.prevYaw != null) {
        let dy = yaw - fl.prevYaw; dy = ((dy + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        const w = dy / Math.max(dt, 1e-3); const target = agl > 8 ? Math.max(-0.5, Math.min(0.5, Math.atan(o.v * w / G))) : 0;
        fl.bank += (target - fl.bank) * Math.min(1, dt * 1.5);
      }
      fl.prevYaw = yaw;
      const aoa = agl < 1 ? 0 : fl.ga ? 0.05 : (fl.r.kind === 'arr' ? 0.05 : 0.12);
      fl.obj.position.copy(p);
      fl.obj.rotation.set(climb + aoa, -yaw, -fl.bank);
      const vis = (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2 < (this.light ? 18000 : 30000) ** 2; // AI drawn only within this range
      fl.obj.visible = vis;
      if (fl.obj.userData.beacon) fl.obj.userData.beacon.visible = (this.t * 1.1 + i * 0.37) % 1 < 0.15;
      out.push({ callsign: fl.callsign, ident: fl.ident || fl.callsign, type: fl.type, x: p.x, y: p.y, z: p.z, hdg: (yaw / D2R + 360) % 360, alt: p.y / FT, gs: o.v / KT, ga: !!fl.ga, kind: fl.r.kind, icao: fl.r.icao, rwy: fl.r.rwy });
    }
    this.list = out;
  }
}
