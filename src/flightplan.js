// Turns the start-screen flight setup (window.FlightSetup.get()) into concrete runways, positions and
// waypoints. "Auto" runways follow the airport's active flow (the same plan the tower and AI traffic use),
// otherwise the best headwind runway that is long enough for the aircraft.
import { AIRPORTS, NAVAIDS, findRunway, runwayEnd } from './geo.js';
import { ILS } from './avionics.js?v=20261123g';
import { flowInfo } from './traffic.js?v=20261124e';

const D2R = Math.PI / 180, NM = 1852;
export const airportOf = (icao) => AIRPORTS.find((a) => a.icao === icao) || null;
export const hasILS = (icao, rwy) => ILS.some((i) => i.airport.icao === icao && i.rwy === rwy);

function runwayLen(icao, id) { const f = findRunway(icao, id); return f && f.r.rwy.includes(id) ? f.r.len : 0; }

export function autoRunway(icao, kind, weather, minLen = 0) {
  const a = airportOf(icao); if (!a) return null;
  const fl = flowInfo(icao, weather);
  if (fl) for (const id of kind === 'dep' ? fl.dep : fl.arr) if (runwayLen(icao, id) >= minLen) return id;
  const w = weather || { windDir: 280, windKt: 0 };
  let best = null, bs = -Infinity;
  for (const r of a.runways) for (const e of [0, 1]) {
    if (r.len < minLen) continue;
    const end = runwayEnd(r, e), head = w.windKt * Math.cos((w.windDir - end.hdg) * D2R);
    const s = head * 10 + r.len / 100 + (kind === 'arr' && hasILS(icao, end.id) ? 4 : 0);
    if (s > bs) { bs = s; best = end.id; }
  }
  return best || a.runways[0].rwy[0];
}

export function waypoint(ident) {
  const n = NAVAIDS.find((q) => q.type === 'VOR' && q.ident === ident);
  if (n) return { ident: n.ident, name: n.name, x: n.x, z: n.z, type: 'VOR', freq: n.freq };
  const a = airportOf(ident);
  if (a) return { ident: a.icao, name: a.name, x: a.x, z: a.z, type: 'APT', elev: a.elev };
  return null;
}

const DEFAULT = { dep: 'KSFO', depRwy: '', dest: 'KHAF', arrRwy: '', route: [], crzFt: 4500, state: 'cold', air: 'climb' };

/** fp: the step-3 choice; returns everything the simulator needs to place the aircraft and load the plan */
export function resolveFlight(fp, weather, minLen = 0) {
  const f = { ...DEFAULT, ...(fp || {}) };
  if (!airportOf(f.dep)) f.dep = DEFAULT.dep;
  if (!airportOf(f.dest)) f.dest = f.dep;
  const ok = (icao, id) => id && runwayLen(icao, id) >= minLen;
  const depRwy = ok(f.dep, f.depRwy) ? f.depRwy : autoRunway(f.dep, 'dep', weather, minLen);
  const arrRwy = ok(f.dest, f.arrRwy) ? f.arrRwy : autoRunway(f.dest, 'arr', weather, minLen);
  const dF = findRunway(f.dep, depRwy), aF = findRunway(f.dest, arrRwy);
  const depEnd = runwayEnd(dF.r, dF.e), arrEnd = runwayEnd(aF.r, aF.e);
  const wpts = (f.route || []).map(waypoint).filter(Boolean).filter((w) => w.ident !== f.dep && w.ident !== f.dest);
  const destW = waypoint(f.dest), depA = airportOf(f.dep);
  return { ...f, depRwy, arrRwy, arrILS: hasILS(f.dest, arrRwy), depEnd, arrEnd, depRunway: dF.r, arrRunway: aF.r, wpts, destW, depA, destA: airportOf(f.dest), stage: stageOf(f) };
}

export function stageOf(f) {
  if (f.state === 'air') return f.air === 'final' ? 'final' : f.air === 'cruise' ? 'cruise' : 'climb';
  return f.state === 'runway' ? 'runway' : f.state === 'taxi' ? 'taxi' : 'ramp';
}

/** a point part-way along the planned route (for "en route" starts): position, heading and the leg it is on */
export function enRoutePoint(R) {
  const pts = [{ x: R.depA.x, z: R.depA.z, ident: R.dep }, ...R.wpts, { x: R.destA.x, z: R.destA.z, ident: R.dest }];
  let i = 0, t = 0.4;
  // the first leg long enough to be "en route" (>= 8 NM); otherwise the longest one
  let best = 0, bl = -1;
  for (let k = 0; k < pts.length - 1; k++) {
    const L = Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z);
    if (L >= 8 * NM) { best = k; bl = L; break; }
    if (L > bl) { bl = L; best = k; }
  }
  i = best;
  const a = pts[i], b = pts[i + 1];
  if (bl < 3 * NM) {
    // local flight (same airport, no waypoints): 8 NM out along the departure runway heading, turning back
    const h = R.depEnd.hdg * D2R;
    const p = { x: R.depA.x + Math.sin(h) * 8 * NM, z: R.depA.z - Math.cos(h) * 8 * NM };
    return { x: p.x, z: p.z, hdg: (R.depEnd.hdg + 180) % 360, leg: pts.length - 1 };
  }
  const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
  return { x, z, hdg: (Math.atan2(b.x - a.x, -(b.z - a.z)) / D2R + 360) % 360, leg: i + 1 };
}
