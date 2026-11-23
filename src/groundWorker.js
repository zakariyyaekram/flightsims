// Rasterises baked OSM ground tiles (data/ground/*.bin) into a land-use / pavement overlay texture.
// Output RGBA8 per texel: R = class | hash<<5, G = orientation (0..pi), B = pavement coverage, A = pavement material.
const GT = 2000;
let BASE = '../data/';
let INDEX = null;
let AIRPORT = null; // { rects: [[x,z]*4], taxi: [{p:[[x,z]..], w}], aprons: [{p, h}] }
const cache = new Map();

function parse(buf, tx, tz) {
  const dv = new DataView(buf), ox = tx * GT - 250, oz = tz * GT - 250;
  const nL = dv.getUint32(0, true), nP = dv.getUint32(4, true);
  let o = 8;
  const lines = [], polys = [];
  for (let i = 0; i < nL; i++) {
    const kind = dv.getUint8(o), mat = dv.getUint8(o + 1), w = dv.getUint8(o + 2) / 4, flags = dv.getUint8(o + 3), n = dv.getUint16(o + 4, true); o += 6;
    const pts = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) { pts[k * 2] = ox + dv.getUint16(o, true) / 20; pts[k * 2 + 1] = oz + dv.getUint16(o + 2, true) / 20; o += 4; }
    lines.push({ kind, mat, w, flags, pts });
  }
  for (let i = 0; i < nP; i++) {
    const cls = dv.getUint8(o), hash = dv.getUint8(o + 1), ori = dv.getUint8(o + 2), nr = dv.getUint8(o + 3); o += 4;
    const rings = [];
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (let r = 0; r < nr; r++) {
      const n = dv.getUint16(o, true); o += 2;
      const pts = new Float32Array(n * 2);
      for (let k = 0; k < n; k++) {
        const x = ox + dv.getUint16(o, true) / 20, z = oz + dv.getUint16(o + 2, true) / 20; o += 4;
        pts[k * 2] = x; pts[k * 2 + 1] = z;
        if (r === 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
      }
      rings.push(pts);
    }
    polys.push({ cls, hash, ori, rings, bb: [x0, z0, x1, z1] });
  }
  return { lines, polys };
}

function tile(tx, tz) {
  const key = tx + '_' + tz;
  if (!INDEX.has(key)) return Promise.resolve(null);
  let p = cache.get(key);
  if (!p) {
    p = fetch(BASE + 'ground/' + key + '.bin?v=20261123a').then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? parse(b, tx, tz) : null)).catch(() => null);
    cache.set(key, p);
    if (cache.size > 160) cache.delete(cache.keys().next().value);
  }
  return p;
}

// even-odd scanline fill of polygon rings into cls/ori byte buffers (texel centres)
function fillPoly(P, x0, z0, res, N, outR, outG, val, ori) {
  const [bx0, bz0, bx1, bz1] = P.bb;
  let j0 = Math.ceil((bz0 - z0) / res - 0.5), j1 = Math.floor((bz1 - z0) / res - 0.5);
  if (j1 < 0 || j0 >= N) return;
  const i0b = (bx0 - x0) / res - 0.5, i1b = (bx1 - x0) / res - 0.5;
  if (i1b < 0 || i0b >= N) return;
  j0 = Math.max(0, j0); j1 = Math.min(N - 1, j1);
  // edge list in texel space
  let ne = 0; for (const r of P.rings) ne += r.length / 2;
  const ey0 = new Float32Array(ne), ey1 = new Float32Array(ne), ex = new Float32Array(ne), es = new Float32Array(ne);
  let m = 0;
  for (const r of P.rings) {
    const n = r.length / 2;
    for (let k = 0, l = n - 1; k < n; l = k++) {
      let ax = (r[l * 2] - x0) / res - 0.5, az = (r[l * 2 + 1] - z0) / res - 0.5, bx = (r[k * 2] - x0) / res - 0.5, bz = (r[k * 2 + 1] - z0) / res - 0.5;
      if (az === bz) continue;
      if (az > bz) { let t = ax; ax = bx; bx = t; t = az; az = bz; bz = t; }
      ey0[m] = az; ey1[m] = bz; es[m] = (bx - ax) / (bz - az); ex[m] = ax; m++;
    }
  }
  // bucket edges by first scanline, sweep with an active edge list
  const head = new Int32Array(j1 - j0 + 2).fill(-1), next = new Int32Array(m);
  for (let e = 0; e < m; e++) {
    const r0 = Math.max(j0, Math.ceil(ey0[e])); if (r0 > j1 || r0 >= ey1[e]) continue;
    next[e] = head[r0 - j0]; head[r0 - j0] = e;
  }
  const act = new Int32Array(m), xs = new Float32Array(m);
  let na = 0;
  for (let j = j0; j <= j1; j++) {
    for (let e = head[j - j0]; e >= 0; e = next[e]) act[na++] = e;
    let c = 0, w = 0;
    for (let k = 0; k < na; k++) { const e = act[k]; if (j < ey1[e]) { act[w++] = e; xs[c++] = ex[e] + (j - ey0[e]) * es[e]; } }
    na = w;
    if (c < 2) continue;
    const s = xs.subarray(0, c).sort();
    const row = j * N;
    for (let k = 0; k + 1 < c; k += 2) {
      const a = Math.max(0, Math.ceil(s[k])), b = Math.min(N - 1, Math.floor(s[k + 1]));
      for (let i = a; i <= b; i++) { outR[row + i] = val; outG[row + i] = ori; }
    }
  }
}

let canvas = null, ctx = null;
async function render(req) {
  const { cx, cz, N, res, id, level } = req;
  const span = N * res, x0 = cx - span / 2, z0 = cz - span / 2;
  const t0x = Math.floor((x0 - 2) / GT), t1x = Math.floor((x0 + span + 2) / GT), t0z = Math.floor((z0 - 2) / GT), t1z = Math.floor((z0 + span + 2) / GT);
  const ps = [];
  for (let tz = t0z; tz <= t1z; tz++) for (let tx = t0x; tx <= t1x; tx++) ps.push(tile(tx, tz));
  const tiles = (await Promise.all(ps)).filter(Boolean);
  const R = new Uint8Array(N * N), G = new Uint8Array(N * N);
  // land use polygons, sorted by priority inside each tile; draw tiles' polygons interleaved by class priority
  const all = [];
  for (const T of tiles) for (const P of T.polys) all.push(P);
  // stable: baked per-tile order is priority then area; across tiles, keep relative order by a global priority
  for (const P of all) fillPoly(P, x0, z0, res, N, R, G, (P.cls & 31) | ((P.hash & 7) << 5), P.ori);
  // pavement strokes
  if (!canvas || canvas.width !== N) { canvas = new OffscreenCanvas(N, N); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, N, N);
  ctx.setTransform(1 / res, 0, 0, 1 / res, -x0 / res, -z0 / res);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const minW = res * 0.9;
  const stroke = (pts, w, mat) => {
    if (pts.length < 4) return;
    ctx.strokeStyle = `rgb(255,${mat * 85},0)`;
    ctx.lineWidth = Math.max(w, minW);
    ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
    for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
    ctx.stroke();
  };
  const L = [];
  for (const T of tiles) for (const l of T.lines) L.push(l);
  // airport pavement (asphalt) first
  if (AIRPORT && level !== undefined) {
    ctx.fillStyle = 'rgb(255,0,0)';
    for (const ap of AIRPORT.aprons) {
      ctx.beginPath();
      for (const ring of [ap.p, ...(ap.h || [])]) { if (ring.length < 3) continue; ctx.moveTo(ring[0][0], ring[0][1]); for (let k = 1; k < ring.length; k++) ctx.lineTo(ring[k][0], ring[k][1]); ctx.closePath(); }
      ctx.fill('evenodd');
    }
    for (const q of AIRPORT.rects) { ctx.beginPath(); ctx.moveTo(q[0][0], q[0][1]); for (let k = 1; k < 4; k++) ctx.lineTo(q[k][0], q[k][1]); ctx.closePath(); ctx.fill(); }
    ctx.strokeStyle = 'rgb(255,0,0)';
    for (const t of AIRPORT.taxi) { ctx.lineWidth = t.w; ctx.beginPath(); ctx.moveTo(t.p[0][0], t.p[0][1]); for (let k = 1; k < t.p.length; k++) ctx.lineTo(t.p[k][0], t.p[k][1]); ctx.stroke(); }
  }
  // the far level skips footpaths / driveways that would only alias
  const tiny = res > 3;
  const pass = (f) => { for (const l of L) if (f(l)) stroke(l.pts, l.w, l.mat); };
  if (!tiny) pass((l) => l.kind <= 3);                         // tracks, paths, footways, cycleways
  else pass((l) => l.kind === 0);
  if (!tiny) pass((l) => l.kind === 4 || l.kind === 5);       // driveways & front walks
  // sidewalks: concrete strip behind every town street
  if (!tiny) for (const l of L) if (l.flags & 1) stroke(l.pts, l.w + 4, 1);
  pass((l) => l.kind >= 6 && l.kind <= 9);                     // aisles, alleys, service, living streets
  pass((l) => l.kind >= 10 && l.kind <= 13);                   // streets
  pass((l) => l.kind >= 14 && !(l.flags & 2));                 // major roads (not bridges)
  const img = ctx.getImageData(0, 0, N, N).data;
  const out = new Uint8Array(N * N * 4);
  for (let i = 0, q = 0; i < N * N; i++, q += 4) {
    out[q] = R[i]; out[q + 1] = G[i]; out[q + 2] = img[q + 3]; out[q + 3] = img[q + 1];
  }
  postMessage({ id, level, cx, cz, N, res, data: out }, [out.buffer]);
}

let busy = Promise.resolve();
onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { BASE = m.base; INDEX = new Set(m.index); AIRPORT = m.airport; return; }
  if (m.type === 'render') busy = busy.then(() => render(m)).catch((err) => postMessage({ id: m.id, level: m.level, error: String(err) }));
};
