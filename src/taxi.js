// Taxi routing over the real OSM taxiway network: ramp -> hold-short of the departure runway.
// Graph nodes are taxiway polyline vertices (OSM ways share nodes at junctions); a few extra
// links join vertices that sit on, or very near, another taxiway so T-junctions connect.
import { findRunway, runwayEnd } from './geo.js';

const key = (p) => Math.round(p[0] * 2) + ',' + Math.round(p[1] * 2);

function buildGraph(a) {
  if (a._taxiGraph) return a._taxiGraph;
  const nodes = [], idx = new Map(), adj = [];
  const node = (p) => { const k = key(p); let i = idx.get(k); if (i === undefined) { i = nodes.length; idx.set(k, i); nodes.push({ x: p[0], z: p[1] }); adj.push([]); } return i; };
  const link = (i, j, ref, lane) => { if (i === j) return; const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].z - nodes[j].z); adj[i].push({ j, d, ref, lane }); adj[j].push({ j: i, d, ref, lane }); };
  const segs = [];
  for (const t of a.taxiways) {
    let prev = -1;
    // densify long segments so runway-crossing checks and joins have vertices to work with
    for (let k = 0; k < t.p.length; k++) {
      if (k) {
        const p0 = t.p[k - 1], p1 = t.p[k], L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), n = Math.max(1, Math.ceil(L / 60));
        for (let s = 1; s <= n; s++) { const q = [p0[0] + (p1[0] - p0[0]) * s / n, p0[1] + (p1[1] - p0[1]) * s / n]; const i = node(q); link(prev, i, t.ref || '', t.lane); segs.push([prev, i, t]); prev = i; }
      } else prev = node(t.p[0]);
    }
  }
  // join dangling / near-coincident vertices to the nearest other segment (within 8 m)
  for (let i = 0; i < nodes.length; i++) {
    if (adj[i].length > 2) continue;
    const n = nodes[i]; let best = null, bd = 8;
    for (const [p, q, t] of segs) {
      if (p === i || q === i) continue;
      const A = nodes[p], B = nodes[q], dx = B.x - A.x, dz = B.z - A.z, L2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((n.x - A.x) * dx + (n.z - A.z) * dz) / L2));
      const d = Math.hypot(A.x + dx * u - n.x, A.z + dz * u - n.z);
      if (d < bd) { bd = d; best = u < 0.5 ? p : q; best = { j: best, t }; }
    }
    if (best && !adj[i].some((e) => e.j === best.j)) link(i, best.j, best.t.ref || '', best.t.lane);
  }
  a._taxiGraph = { nodes, adj };
  return a._taxiGraph;
}

// runway-local coordinates (u along the runway from its centre, v lateral)
const rLocal = (r, x, z) => { const dx = x - r.x, dz = z - r.z; return { u: dx * r.dir[0] + dz * r.dir[1], v: dx * r.perp[0] + dz * r.perp[1] }; };
const onRunway = (a, x, z, m = 0) => a.runways.some((r) => { const l = rLocal(r, x, z); return Math.abs(l.u) < r.len / 2 + 10 && Math.abs(l.v) < r.wid / 2 + m; });

function nameOf(ref) {
  const ph = { A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel', J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu' };
  return ref.replace(/^([A-Z])(\d*)$/, (m, l, d) => (ph[l] || l) + (d ? ' ' + d : ''));
}

/** Route from (x, z) to the hold-short line of runway `rwyId` at airport `icao`.
 *  Returns { pts:[{x,z}], via:[ref], viaText, hold:{x,z}, rwy, len } or null. */
export function taxiRoute(icao, rwyId, x, z) {
  const f = findRunway(icao, rwyId); if (!f) return null;
  const a = f.a, r = f.r, end = runwayEnd(r, f.e);
  const G = buildGraph(a); const { nodes, adj } = G; if (!nodes.length) return null;
  // Dijkstra; crossing / using any runway surface is heavily penalised, apron lanes slightly
  const N = nodes.length, dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const rw = new Uint8Array(N); for (let i = 0; i < N; i++) rw[i] = onRunway(a, nodes[i].x, nodes[i].z, 3) ? 1 : 0;
  const heap = [];
  const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, rr = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  // start: every off-runway node within 200 m of the aircraft (straight-line taxi across the apron to reach it)
  let seeded = 0, nearest = -1, nd = Infinity;
  for (let i = 0; i < N; i++) {
    if (rw[i]) continue; const d = Math.hypot(nodes[i].x - x, nodes[i].z - z);
    if (d < nd) { nd = d; nearest = i; }
    if (d < 200) { dist[i] = d * 1.6; push(dist[i], i); seeded++; }
  }
  if (!seeded && nearest >= 0) { dist[nearest] = nd * 1.6; push(dist[nearest], nearest); }
  if (nearest < 0) return null;
  while (heap.length) {
    const [d, i] = pop(); if (done[i]) continue; done[i] = 1;
    for (const e of adj[i]) {
      const w = e.d * (rw[e.j] || rw[i] ? 6 : 1) * (e.lane ? 1.15 : 1);
      if (d + w < dist[e.j]) { dist[e.j] = d + w; prev[e.j] = i; push(d + w, e.j); }
    }
  }
  // goal: a reachable node beside the departure runway near its threshold, clear of the runway
  const thrU = rLocal(r, end.x, end.z).u, sgn = f.e === 0 ? 1 : -1; // +sgn = down the runway
  const holdLat = (r.wid >= 45 ? 80 : 42) - r.wid / 2; // hold line distance from the centreline (AC 150/5300-13)
  let g = -1;
  for (const [latMax, aMin, aMax] of [[110, -120, 450], [260, -250, 700]]) {
    let gs = Infinity;
    for (let i = 0; i < N; i++) {
      if (!isFinite(dist[i]) || rw[i]) continue;
      const l = rLocal(r, nodes[i].x, nodes[i].z), along = (l.u - thrU) * sgn, lat = Math.abs(l.v) - r.wid / 2;
      if (lat < 18 || lat > latMax || along < aMin || along > aMax) continue;
      const near = adj[i].some((e) => rw[e.j]) || adj[i].some((e) => adj[e.j].some((q) => rw[q.j])); // on a stub that leads onto the runway
      const sc = dist[i] * 0.25 + Math.abs(along) * 2 + Math.abs(lat - holdLat) * 3 - (near ? 120 : 0);
      if (sc < gs) { gs = sc; g = i; }
    }
    if (g >= 0) break;
  }
  if (g < 0) return null;
  const path = []; for (let i = g; i >= 0; i = prev[i]) path.push(i); path.reverse();
  if (path.length < 2) return null;
  const pts = [{ x, z }, ...path.map((i) => ({ x: nodes[i].x, z: nodes[i].z }))];
  // taxiway names along the route (collapse repeats, drop unnamed)
  const via = [];
  for (let k = 1; k < path.length; k++) { const e = adj[path[k - 1]].find((q) => q.j === path[k]); const ref = e?.ref || ''; if (ref && via[via.length - 1] !== ref && ref.length <= 4) via.push(ref); }
  let len = 0; for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
  // hold line point: step back from the runway edge along the last leg if needed
  const hold = pts[pts.length - 1];
  const viaText = via.length ? via.map(nameOf).join(', ') : 'the parallel taxiway';
  return { pts, via, viaText, hold, rwy: end.id, rwyHdg: end.hdg, len, icao };
}

/** progress along a route: index of the next point to head for, distance remaining, cross-track error */
export function routeProgress(route, x, z) {
  const P = route.pts; let best = 0, bd = Infinity, bt = 0;
  for (let k = 1; k < P.length; k++) {
    const A = P[k - 1], B = P[k], dx = B.x - A.x, dz = B.z - A.z, L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - A.x) * dx + (z - A.z) * dz) / L2));
    const d = Math.hypot(A.x + dx * t - x, A.z + dz * t - z);
    if (d < bd) { bd = d; best = k; bt = t; }
  }
  let rem = Math.hypot(P[best].x - x, P[best].z - z);
  for (let k = best + 1; k < P.length; k++) rem += Math.hypot(P[k].x - P[k - 1].x, P[k].z - P[k - 1].z);
  // look-ahead target ~25 m down the route
  let tgt = P[best], acc = 0;
  for (let k = best; k < P.length; k++) { acc += k === best ? Math.hypot(P[k].x - x, P[k].z - z) : Math.hypot(P[k].x - P[k - 1].x, P[k].z - P[k - 1].z); tgt = P[k]; if (acc > 25) break; }
  return { seg: best, t: bt, off: bd, rem, tgt };
}

/** Preferred runway first; if it can't be reached on taxiways, the reachable runway end
 *  with the closest heading (e.g. Oakland North Field GA ramp -> 28R instead of 30). */
export function departureRoute(icao, prefRwy, x, z) {
  const f = findRunway(icao, prefRwy); if (!f) return null;
  const r0 = taxiRoute(icao, prefRwy, x, z); if (r0 && r0.len < 4000) return r0;
  const want = runwayEnd(f.r, f.e).hdg, ends = [];
  for (const r of f.a.runways) for (let e = 0; e < 2; e++) { const id = r.rwy[e]; if (id === prefRwy) continue; const d = Math.abs(((runwayEnd(r, e).hdg - want + 540) % 360) - 180); ends.push([d, id]); }
  ends.sort((p, q) => p[0] - q[0]);
  let best = r0;
  for (const [d, id] of ends) { if (d > 100) break; const rr = taxiRoute(icao, id, x, z); if (rr && (!best || rr.len < best.len * 0.5)) best = rr; if (best && best.len < 4000) break; }
  return best;
}
