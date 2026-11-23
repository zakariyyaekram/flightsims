// Airport taxi diagram overlay, drawn in the style of an FAA airport diagram (north up):
// runways with designators, taxiways labelled with their published identifiers, aprons, buildings,
// hold-short lines, the control tower, your aircraft and the cleared taxi route.
import { AIRPORTS, toLocal, runwayEnd } from './geo.js';

const M2FT = 3.28084;
let wrap = null, cv = null, ctx = null, info = null, open = false, cur = null;
let view = { s: 1, cx: 0, cz: 0, follow: false }, drag = null, lastDraw = 0;
const cache = new Map();

function nearestAirport(x, z) {
  let best = null, bd = Infinity;
  for (const a of AIRPORTS) { const d = Math.hypot(x - a.arp[0], z - a.arp[1]); if (d < bd) { bd = d; best = a; } }
  return best;
}
function bounds(a) {
  let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
  const add = (x, z) => { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); };
  for (const r of a.runways) { add(r.le[0], r.le[1]); add(r.he[0], r.he[1]); }
  for (const ap of a.aprons) for (const q of ap.p) add(q[0], q[1]);
  for (const t of a.taxiways) if (!t.lane) for (const q of t.p) add(q[0], q[1]);
  return { x0, z0, x1, z1 };
}
// labels: one per taxiway identifier per connected stretch, placed on the longest straight piece
function prep(a) {
  if (cache.has(a.icao)) return cache.get(a.icao);
  const labels = [], holds = [];
  for (const t of a.taxiways) {
    if (t.lane || !t.ref || t.p.length < 2) continue;
    let best = -1, bl = 0;
    for (let k = 1; k < t.p.length; k++) { const L = Math.hypot(t.p[k][0] - t.p[k - 1][0], t.p[k][1] - t.p[k - 1][1]); if (L > bl) { bl = L; best = k; } }
    let tot = 0; for (let k = 1; k < t.p.length; k++) tot += Math.hypot(t.p[k][0] - t.p[k - 1][0], t.p[k][1] - t.p[k - 1][1]);
    if (tot < 25) continue;
    const A = t.p[best - 1], B = t.p[best];
    labels.push({ ref: t.ref, x: (A[0] + B[0]) / 2, z: (A[1] + B[1]) / 2, len: tot });
    // hold-short points (same rule the 3D airport uses for the painted hold bars)
    for (const r of a.runways) {
      const hd = r.wid / 2 + (r.len > 2400 ? 60 : r.wid >= 30 ? 45 : 25);
      for (let k = 0; k + 1 < t.p.length; k++) {
        const P = toLocal(r, t.p[k][0], t.p[k][1]), Q = toLocal(r, t.p[k + 1][0], t.p[k + 1][1]);
        for (const sd of [-1, 1]) {
          const fa = P.v * sd - hd, fb = Q.v * sd - hd; if (fa * fb >= 0) continue;
          const s = fa / (fa - fb); if (Math.abs(P.u + (Q.u - P.u) * s) > r.len / 2) continue;
          const dx = t.p[k + 1][0] - t.p[k][0], dz = t.p[k + 1][1] - t.p[k][1], L = Math.hypot(dx, dz) || 1;
          holds.push({ x: t.p[k][0] + dx * s, z: t.p[k][1] + dz * s, dx: dx / L, dz: dz / L, w: t.w });
        }
      }
    }
  }
  // keep the longer of duplicate labels that sit close together
  labels.sort((p, q) => q.len - p.len);
  const keep = [];
  for (const l of labels) if (!keep.some((k) => k.ref === l.ref && Math.hypot(k.x - l.x, k.z - l.z) < 260)) keep.push(l);
  const o = { labels: keep, holds, b: bounds(a) };
  cache.set(a.icao, o); return o;
}

function build() {
  wrap = document.createElement('div'); wrap.id = 'taxiMap'; wrap.className = 'hidden';
  wrap.innerHTML = `<div class="tmHead"><div><b id="tmTitle"></b><span id="tmSub"></span></div>
    <div class="tmBtns"><button id="tmFollow" type="button">FOLLOW AIRCRAFT</button><button id="tmFit" type="button">FIT</button><button id="tmClose" type="button">CLOSE · 8</button></div></div>
    <canvas id="tmCanvas"></canvas><div id="tmInfo"></div>
    <div class="tmLegend"><span><i class="lg rw"></i>Runway</span><span><i class="lg tw"></i>Taxiway</span><span><i class="lg ap"></i>Apron / ramp</span><span><i class="lg bd"></i>Building</span><span><i class="lg hs"></i>Hold-short</span><span><i class="lg rt"></i>Your taxi route</span><span>Drag to pan · wheel to zoom</span></div>`;
  document.body.appendChild(wrap);
  cv = wrap.querySelector('#tmCanvas'); ctx = cv.getContext('2d'); info = wrap.querySelector('#tmInfo');
  for (const e of ['mousedown', 'wheel', 'click', 'dblclick']) wrap.addEventListener(e, (ev) => ev.stopPropagation());
  wrap.querySelector('#tmClose').onclick = () => toggleTaxiMap(false);
  wrap.querySelector('#tmFit').onclick = () => { fit(); view.follow = false; syncBtns(); };
  wrap.querySelector('#tmFollow').onclick = () => { view.follow = !view.follow; syncBtns(); };
  cv.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, cx: view.cx, cz: view.cz }; view.follow = false; syncBtns(); });
  window.addEventListener('mousemove', (e) => { if (!drag) return; view.cx = drag.cx - (e.clientX - drag.x) / view.s; view.cz = drag.cz - (e.clientY - drag.y) / view.s; });
  window.addEventListener('mouseup', () => { drag = null; });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault(); const r = cv.getBoundingClientRect(), mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
    const k = Math.exp(-e.deltaY * 0.0015), wx = view.cx + mx / view.s, wz = view.cz + my / view.s;
    view.s = Math.min(8, Math.max(0.03, view.s * k)); view.cx = wx - mx / view.s; view.cz = wz - my / view.s;
  }, { passive: false });
}
function syncBtns() { wrap.querySelector('#tmFollow').classList.toggle('on', view.follow); }
function fit() {
  const { b } = prep(cur), r = cv.getBoundingClientRect();
  view.cx = (b.x0 + b.x1) / 2; view.cz = (b.z0 + b.z1) / 2;
  view.s = Math.min((r.width - 80) / Math.max(200, b.x1 - b.x0), (r.height - 60) / Math.max(200, b.z1 - b.z0));
}

export function taxiMapOpen() { return open; }
export function toggleTaxiMap(force, sim) {
  if (!wrap) build();
  open = force ?? !open; wrap.classList.toggle('hidden', !open);
  if (open && sim) {
    const F = sim.fdm, a = nearestAirport(F.pos[0], F.pos[2]);
    if (a !== cur) { cur = a; requestAnimationFrame(() => fit()); }
    const d = Math.hypot(F.pos[0] - a.arp[0], F.pos[2] - a.arp[1]);
    view.follow = d < a.radius && F.onGround; syncBtns();
    if (view.follow) requestAnimationFrame(() => { view.s = Math.max(view.s, 0.9); });
  }
  return open;
}

const rwyLabel = (r, e) => r.rwy[e];
export function updateTaxiMap(sim) {
  if (!open || !cur) return;
  const now = performance.now(); if (now - lastDraw < 66) return; lastDraw = now;
  const a = cur, P = prep(a), F = sim.fdm;
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  if (view.follow) { view.cx = F.pos[0]; view.cz = F.pos[2]; }
  const s = view.s, X = (x) => (x - view.cx) * s + W / 2, Y = (z) => (z - view.cz) * s + H / 2;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  const poly = (p) => { ctx.beginPath(); p.forEach((q, i) => (i ? ctx.lineTo(X(q[0]), Y(q[1])) : ctx.moveTo(X(q[0]), Y(q[1])))); ctx.closePath(); };
  // aprons (FAA diagrams: light grey fill)
  ctx.fillStyle = '#d9dadb'; ctx.strokeStyle = '#8d9092'; ctx.lineWidth = 0.8;
  for (const ap of a.aprons) { poly(ap.p); for (const h of ap.h || []) { h.forEach((q, i) => (i ? ctx.lineTo(X(q[0]), Y(q[1])) : ctx.moveTo(X(q[0]), Y(q[1])))); ctx.closePath(); } ctx.fill('evenodd'); ctx.stroke(); }
  // taxiways: outlined grey bands
  ctx.lineJoin = ctx.lineCap = 'round';
  for (const pass of [0, 1]) for (const t of a.taxiways) {
    if (t.lane || t.p.length < 2) continue;
    ctx.beginPath(); t.p.forEach((q, i) => (i ? ctx.lineTo(X(q[0]), Y(q[1])) : ctx.moveTo(X(q[0]), Y(q[1]))));
    ctx.strokeStyle = pass ? '#c4c6c8' : '#6d7073'; ctx.lineWidth = Math.max(pass ? 1.5 : 2.6, t.w * s + (pass ? 0 : 1.6)); ctx.stroke();
  }
  // buildings
  ctx.fillStyle = '#a6a8aa'; ctx.strokeStyle = '#5d6063'; ctx.lineWidth = 0.6;
  for (const b of a.buildings) { if (b.p.length < 3) continue; poly(b.p); ctx.fill(); if (s > 0.5) ctx.stroke(); }
  // runways: black with white centreline and threshold bars
  for (const r of a.runways) {
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [r.x + r.dir[0] * u * r.len / 2 + r.perp[0] * v * r.wid / 2, r.z + r.dir[1] * u * r.len / 2 + r.perp[1] * v * r.wid / 2]);
    ctx.fillStyle = '#111'; poly(c); ctx.fill();
    if (r.wid * s > 6) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(0.8, 0.9 * s); ctx.setLineDash([36 * s, 24 * s]);
      ctx.beginPath(); ctx.moveTo(X(r.le[0]), Y(r.le[1])); ctx.lineTo(X(r.he[0]), Y(r.he[1])); ctx.stroke(); ctx.setLineDash([]);
    }
    // displaced thresholds
    for (let e = 0; e < 2; e++) {
      const d = r.disp?.[e] || 0; if (!d) continue; const sg = e ? -1 : 1, u = sg * (-r.len / 2 + d);
      const p0 = [r.x + r.dir[0] * u + r.perp[0] * r.wid / 2, r.z + r.dir[1] * u + r.perp[1] * r.wid / 2], p1 = [r.x + r.dir[0] * u - r.perp[0] * r.wid / 2, r.z + r.dir[1] * u - r.perp[1] * r.wid / 2];
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1.5, 2 * s); ctx.beginPath(); ctx.moveTo(X(p0[0]), Y(p0[1])); ctx.lineTo(X(p1[0]), Y(p1[1])); ctx.stroke();
    }
  }
  // hold-short lines
  ctx.strokeStyle = '#d6a400'; ctx.lineWidth = Math.max(2, 2.2 * s);
  for (const h of P.holds) {
    const hw = h.w / 2 + 2; ctx.beginPath(); ctx.moveTo(X(h.x - h.dz * hw), Y(h.z + h.dx * hw)); ctx.lineTo(X(h.x + h.dz * hw), Y(h.z - h.dx * hw)); ctx.stroke();
  }
  // runway designators at both ends, rotated like the FAA diagram labels
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const r of a.runways) for (let e = 0; e < 2; e++) {
    const end = runwayEnd(r, e), off = Math.max(28 / s, 40) * 1;
    const ex = end.x - end.dir[0] * off, ez = end.z - end.dir[1] * off; // just beyond the threshold
    ctx.save(); ctx.translate(X(ex), Y(ez)); ctx.rotate((end.hdg) * Math.PI / 180);
    ctx.font = `700 ${Math.round(Math.min(22, Math.max(12, 18 * Math.sqrt(s))))}px ui-sans-serif, system-ui`;
    const txt = rwyLabel(r, e), w = ctx.measureText(txt).width + 8;
    ctx.fillStyle = '#fff'; ctx.fillRect(-w / 2, -10, w, 20); ctx.strokeStyle = '#111'; ctx.lineWidth = 1; ctx.strokeRect(-w / 2, -10, w, 20);
    ctx.fillStyle = '#111'; ctx.fillText(txt, 0, 1); ctx.restore();
  }
  // runway length / width captions along each runway
  ctx.font = `600 ${Math.round(Math.min(13, Math.max(10, 11 * Math.sqrt(s))))}px ui-sans-serif, system-ui`;
  for (const r of a.runways) {
    if (r.len * s < 200) continue;
    let ang = Math.atan2(r.dir[1], r.dir[0]); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
    ctx.save(); ctx.translate(X(r.x + r.perp[0] * (r.wid / 2 + 14 / s + 4)), Y(r.z + r.perp[1] * (r.wid / 2 + 14 / s + 4))); ctx.rotate(ang);
    ctx.fillStyle = '#111'; ctx.fillText(`${r.rwy[0]}-${r.rwy[1]}  ${Math.round(r.len * M2FT)} X ${Math.round(r.wid * M2FT)}`, 0, 0); ctx.restore();
  }
  // taxiway identifiers in boxed labels (black box, yellow text like the airport signs)
  const fs = Math.round(Math.min(15, Math.max(10, 12 * Math.sqrt(s)))); ctx.font = `700 ${fs}px ui-sans-serif, system-ui`;
  const placed = [];
  for (const l of P.labels) {
    const px = X(l.x), py = Y(l.z); if (px < -20 || py < -20 || px > W + 20 || py > H + 20) continue;
    const w = ctx.measureText(l.ref).width + 8, h = fs + 5;
    if (placed.some((q) => Math.abs(q[0] - px) < (q[2] + w) / 2 + 2 && Math.abs(q[1] - py) < h + 1)) continue;
    placed.push([px, py, w]);
    ctx.fillStyle = '#111'; ctx.fillRect(px - w / 2, py - h / 2, w, h); ctx.fillStyle = '#ffd21a'; ctx.fillText(l.ref, px, py + 1);
  }
  // tower
  if (a.towerInfo) {
    const tx = X(a.towerInfo.x), ty = Y(a.towerInfo.z); ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.moveTo(tx, ty - 8); ctx.lineTo(tx + 7, ty + 5); ctx.lineTo(tx - 7, ty + 5); ctx.closePath(); ctx.fill();
    ctx.font = '700 10px ui-sans-serif, system-ui'; ctx.fillText('TWR', tx, ty + 14);
  }
  // cleared taxi route
  const tr = sim.taxi && sim.taxi.icao === a.icao ? sim.taxi.route : null;
  if (tr) {
    ctx.strokeStyle = 'rgba(214,0,170,0.9)'; ctx.lineWidth = 4; ctx.setLineDash([]);
    ctx.beginPath(); tr.pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.z)) : ctx.moveTo(X(p.x), Y(p.z)))); ctx.stroke();
    const e = tr.pts[tr.pts.length - 1]; ctx.fillStyle = '#d600aa'; ctx.beginPath(); ctx.arc(X(e.x), Y(e.z), 5, 0, Math.PI * 2); ctx.fill();
  }
  // own aircraft
  {
    const ax = X(F.pos[0]), ay = Y(F.pos[2]), h = F.attitude.hdg * Math.PI / 180;
    ctx.save(); ctx.translate(ax, ay); ctx.rotate(h);
    ctx.fillStyle = '#0a7cff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -12); ctx.lineTo(3, -2); ctx.lineTo(11, 1); ctx.lineTo(11, 4); ctx.lineTo(3, 3); ctx.lineTo(2, 9); ctx.lineTo(5, 11); ctx.lineTo(-5, 11); ctx.lineTo(-2, 9); ctx.lineTo(-3, 3); ctx.lineTo(-11, 4); ctx.lineTo(-11, 1); ctx.lineTo(-3, -2); ctx.closePath();
    ctx.stroke(); ctx.fill(); ctx.restore();
  }
  // north arrow + scale bar
  ctx.fillStyle = '#111'; ctx.font = '700 12px ui-sans-serif, system-ui';
  ctx.beginPath(); ctx.moveTo(W - 30, 18); ctx.lineTo(W - 24, 36); ctx.lineTo(W - 36, 36); ctx.closePath(); ctx.fill(); ctx.fillText('N', W - 30, 46);
  const ft = [100, 200, 500, 1000, 2000, 5000].find((f) => f / M2FT * s > 70) || 5000, px = ft / M2FT * s;
  ctx.fillRect(20, H - 22, px, 3); ctx.textAlign = 'left'; ctx.font = '600 11px ui-sans-serif, system-ui'; ctx.fillText(`${ft} FT`, 20, H - 32);
  // header + status
  wrap.querySelector('#tmTitle').textContent = `${a.icao}  ${a.name.toUpperCase()}`;
  wrap.querySelector('#tmSub').textContent = `  ·  AIRPORT DIAGRAM  ·  ELEV ${Math.round(a.elev * M2FT)} FT${a.tower ? `  ·  TWR ${a.twrFreq || ''}  GND ${a.gndFreq || ''}` : '  ·  NON-TOWERED (CTAF)'}`;
  // which taxiway / runway the aircraft is on
  let on = '';
  { let bd = 1e9; for (const t of a.taxiways) { if (t.lane || !t.ref) continue; for (let k = 1; k < t.p.length; k++) { const d = segD(F.pos[0], F.pos[2], t.p[k - 1], t.p[k]); if (d < bd && d < t.w / 2 + 4) { bd = d; on = 'Taxiway ' + t.ref; } } }
    for (const r of a.runways) { const L = toLocal(r, F.pos[0], F.pos[2]); if (Math.abs(L.u) < r.len / 2 && Math.abs(L.v) < r.wid / 2) on = 'Runway ' + r.rwy.join('/'); } }
  info.textContent = (on ? `You are on ${on}` : 'You are on the ramp / off the taxiways') + (tr ? `  ·  Cleared: Rwy ${tr.rwy} via ${tr.viaText}` : '');
}
function segD(x, z, a, b) { const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1; let t = ((x - a[0]) * dx + (z - a[1]) * dz) / L2; t = Math.max(0, Math.min(1, t)); return Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z); }
