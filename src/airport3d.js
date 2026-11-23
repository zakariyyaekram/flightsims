// Real airports: every runway with FAA-pattern markings and lighting, OSM taxiways / aprons / buildings,
// control towers at their real positions and heights, windsocks, parked airliners at terminal gates and GA aircraft on ramps.
import * as THREE from 'three';
import { heightAt, AIRPORTS, toLocal, fromLocal, pointInPoly } from './geo.js';
import { mulberry } from './noise.js';
import { lightMaterial, makePoints, pbr, flattenStatic, pavementMaterial, canvasTex } from './world.js';
import { airlinerGeometry, airlinerMaterials, airlinerRest } from './airliner.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const D2R = Math.PI / 180;

// ---------------- runway markings (R = white, G = yellow, B = rubber) ----------------
function barCount(w) { return w < 20 ? 4 : w < 26 ? 6 : w < 35 ? 8 : w < 50 ? 12 : 16; }
function runwayMarkings(r) {
  const S = r.len > 2600 ? 1.6 : 2, W = r.wid > 40 ? 192 : 128;
  const H = Math.min(8192, Math.round(r.len * S)); const s = H / r.len, ax = W / r.wid;
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const rnd = mulberry(Math.round(r.x * 3 + r.z));
  const W2 = r.wid / 2, white = '#ff0000';
  // rect in end frame: d from runway END (0..len), w lateral (right of landing direction)
  const rect = (e, d0, d1, w0, w1, col = white) => {
    const u0 = e === 0 ? -r.len / 2 + d0 : r.len / 2 - d1, u1 = e === 0 ? -r.len / 2 + d1 : r.len / 2 - d0;
    const v0 = e === 0 ? w0 : -w1, v1 = e === 0 ? w1 : -w0;
    g.fillStyle = col; g.fillRect((v0 + W2) * ax, (r.len / 2 - u1) * s, (v1 - v0) * ax, (u1 - u0) * s);
  };
  const text = (e, d, str, hgt) => {
    const uC = e === 0 ? -r.len / 2 + d : r.len / 2 - d;
    g.save(); g.translate(W / 2, (r.len / 2 - uC) * s); g.scale(ax, s); if (e === 1) g.rotate(Math.PI);
    g.fillStyle = white; g.font = `700 ${hgt * 1.38}px "Barlow Condensed", "Arial Narrow", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const k = Math.min(1, r.wid / 30); g.scale(0.5 * k, 1); g.fillText(str, 0, 0); g.restore();
  };
  // side stripes
  if (r.wid >= 23) { rect(0, 0, r.len, -W2 + 0.3, -W2 + 1.2); rect(0, 0, r.len, W2 - 1.2, W2 - 0.3); }
  const thrD = [r.disp[0] || 0, r.disp[1] || 0];
  for (let e = 0; e < 2; e++) {
    const T = thrD[e];
    // displaced threshold: arrows + threshold bar
    if (T > 20) {
      for (let d = 15; d < T - 25; d += 60) { rect(e, d, d + 36, -0.45, 0.45); }
      for (const w of [-W2 * 0.55, 0, W2 * 0.55]) for (let k = 0; k < 6; k++) { const d = T - 24 + k * 2.4, ww = (6 - k) * 0.55; rect(e, d, d + 2.4, w - ww - 0.3, w - ww + 0.6); rect(e, d, d + 2.4, w + ww - 0.6, w + ww + 0.3); }
      rect(e, T - 3, T, -W2 + 0.6, W2 - 0.6);
    }
    // threshold bars (FAA: count by runway width, 150 ft long)
    const nb = barCount(r.wid) / 2;
    for (let i = 0; i < nb; i++) { const w0 = 1.75 + i * 3.5; rect(e, T + 6, T + 51, w0, w0 + 1.75); rect(e, T + 6, T + 51, -w0 - 1.75, -w0); }
    // designation: letter nearer the threshold, number beyond
    const id = r.rwy[e]; const num = id.replace(/[LRC]$/, ''), let_ = id.slice(num.length);
    const hgt = Math.min(18, r.wid * 0.6);
    if (let_) { text(e, T + 63 + hgt / 2, let_, hgt); text(e, T + 63 + hgt * 1.5 + 6, num, hgt); } else text(e, T + 63 + hgt / 2, num, hgt);
    const desigEnd = T + 63 + hgt * (let_ ? 2 : 1) + 12;
    // aiming point (1020 ft) and touchdown zone (instrument runways)
    const inner = r.wid >= 45 ? 9 : r.wid * 0.2, aw = r.wid >= 45 ? 9 : Math.max(1.8, r.wid * 0.2);
    const precise = !!(r.ilsList && r.ilsList.find((q) => q.end === e));
    if (r.len >= 1200 || precise) { const L = r.len >= 2400 ? 45 : 30; rect(e, T + 311, T + 311 + L, inner, inner + aw); rect(e, T + 311, T + 311 + L, -inner - aw, -inner); }
    if (precise || r.len >= 2400) {
      for (const [d, n] of [[152, 3], [457, 2], [610, 2], [762, 1], [914, 1]]) {
        if (T + d + 25 > r.len / 2) continue;
        for (let k = 0; k < n; k++) { const w0 = inner + k * 3.3; rect(e, T + d, T + d + 22.5, w0, w0 + 1.8); rect(e, T + d, T + d + 22.5, -w0 - 1.8, -w0); }
      }
    }
    r._desig = r._desig || []; r._desig[e] = desigEnd;
  }
  // centreline 120 ft stripe / 80 ft gap
  const c0 = (r._desig[0]), c1 = r.len - r._desig[1];
  const cw = r.ilsList?.length ? 0.9 : 0.45;
  for (let d = c0; d < c1 - 36; d += 61) rect(0, d, d + 36.5, -cw / 2, cw / 2);
  // rubber in touchdown zones + general wear
  g.globalCompositeOperation = 'lighter';
  for (let e = 0; e < 2; e++) for (let i = 0; i < 2200; i++) {
    const d = thrD[e] + 120 + Math.pow(rnd(), 1.6) * 560;
    const w = (rnd() - 0.5) * r.wid * 0.36 + (rnd() < 0.5 ? -1 : 1) * Math.min(6, r.wid * 0.12) * rnd();
    const l = 4 + rnd() * 22, u = e === 0 ? -r.len / 2 + d : r.len / 2 - d;
    g.fillStyle = `rgba(0,0,255,${(0.05 + rnd() * 0.12).toFixed(3)})`;
    g.fillRect((w + W2) * ax, (r.len / 2 - u) * s, (0.25 + rnd() * 0.5) * ax, l * s);
  }
  g.strokeStyle = 'rgba(0,0,255,0.3)'; g.lineWidth = 1;
  for (let i = 0; i < r.len / 25; i++) { const y = rnd() * H; g.beginPath(); g.moveTo(0, y); let x = 0; while (x < W) { x += 8 + rnd() * 26; g.lineTo(x, y + (rnd() - 0.5) * 5); } g.stroke(); }
  for (let y = 0; y < H; y += 7.5 * s) { g.fillStyle = 'rgba(0,0,255,0.16)'; g.fillRect(0, y, W, 1); }
  return canvasTex(c);
}
function stripGeometry(fr, u0, u1, v0, v1, du, lift, gh) {
  const nu = Math.max(1, Math.ceil((u1 - u0) / du)), nv = Math.max(1, Math.ceil((v1 - v0) / 10));
  const pos = [], uv = [], uvm = [], idx = [];
  for (let j = 0; j <= nu; j++) for (let i = 0; i <= nv; i++) {
    const u = u0 + (u1 - u0) * j / nu, v = v0 + (v1 - v0) * i / nv; const { x, z } = fromLocal(fr, u, v);
    pos.push(x, gh(x, z) + lift, z); uv.push(v / 9, u / 9); uvm.push(i / nv, j / nu);
  }
  for (let j = 0; j < nu; j++) for (let i = 0; i < nv; i++) { const p = j * (nv + 1) + i, q = p + nv + 1; idx.push(p, p + 1, q, p + 1, q + 1, q); }
  return finishFlat(pos, uv, uvm, idx);
}
function finishFlat(pos, uv, uvm, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('uvm', new THREE.Float32BufferAttribute(uvm, 2));
  if (idx) g.setIndex(idx); return g;
}
// ribbon along a polyline (taxiways); uvm.x across 0..1, uvm.y = metres / 8
function ribbon(p, w, lift, gh, cap = true) {
  const pts = [];
  for (let i = 0; i + 1 < p.length; i++) {
    const [ax, az] = p[i], [bx, bz] = p[i + 1], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 25));
    for (let k = 0; k < n; k++) pts.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
  }
  pts.push(p[p.length - 1]);
  if (pts.length < 2) return null;
  if (cap) { // extend the ends so junctions are covered
    const e = w * 0.5;
    const [a, b] = [pts[0], pts[1]], l0 = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; pts[0] = [a[0] - (b[0] - a[0]) / l0 * e, a[1] - (b[1] - a[1]) / l0 * e];
    const [c, d] = [pts[pts.length - 2], pts[pts.length - 1]], l1 = Math.hypot(d[0] - c[0], d[1] - c[1]) || 1; pts[pts.length - 1] = [d[0] + (d[0] - c[0]) / l1 * e, d[1] + (d[1] - c[1]) / l1 * e];
  }
  const pos = [], uv = [], uvm = [], idx = []; let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    let px = -dz, pz = dx, m = 1;
    if (i > 0 && i < pts.length - 1) { // miter
      const d0x = pts[i][0] - pts[i - 1][0], d0z = pts[i][1] - pts[i - 1][1], l0 = Math.hypot(d0x, d0z) || 1;
      const cosA = (-d0z / l0) * px + (d0x / l0) * pz; m = 1 / Math.max(0.5, cosA);
    }
    if (i > 0) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    for (const sd of [-1, 1]) {
      const x = pts[i][0] + px * sd * w / 2 * m, z = pts[i][1] + pz * sd * w / 2 * m;
      pos.push(x, gh(x, z) + lift, z); uv.push(x / 9, z / 9); uvm.push(sd < 0 ? 0 : 1, acc / 8);
    }
    if (i > 0) { const q = (i - 1) * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
  }
  return finishFlat(pos, uv, uvm, idx);
}
function disc(x, z, r, lift, gh) {
  const pos = [x, gh(x, z) + lift, z], uv = [x / 9, z / 9], uvm = [0, 0], idx = [];
  for (let i = 0; i <= 16; i++) { const a = i / 16 * Math.PI * 2, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r; pos.push(px, gh(px, pz) + lift, pz); uv.push(px / 9, pz / 9); uvm.push(0, 0); if (i) idx.push(0, i + 1, i); }
  return finishFlat(pos, uv, uvm, idx);
}
function polyGeometry(outer, holes, lift, gh) {
  const ov = outer.map((q) => new THREE.Vector2(q[0], q[1])); const hv = (holes || []).filter((h) => h.length > 2).map((h) => h.map((q) => new THREE.Vector2(q[0], q[1])));
  if (THREE.ShapeUtils.isClockWise(ov)) ov.reverse(); for (const h of hv) if (!THREE.ShapeUtils.isClockWise(h)) h.reverse();
  let tris; try { tris = THREE.ShapeUtils.triangulateShape(ov, hv); } catch { return null; }
  const all = ov.concat(...hv); const pos = [], uv = [], uvm = [], idx = [];
  for (const v of all) { pos.push(v.x, gh(v.x, v.y) + lift, v.y); uv.push(v.x / 9, v.y / 9); uvm.push(v.x / 40, v.y / 40); }
  for (const t of tris) idx.push(t[0], t[2], t[1]);
  return finishFlat(pos, uv, uvm, idx);
}
function taxiTex() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#00ff00'; g.fillRect(31, 0, 2, 64);
  const t = canvasTex(c); t.wrapT = THREE.RepeatWrapping; return t;
}
function apronTex() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256);
  const rnd = mulberry(77); g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(0,0,255,${(0.04 + rnd() * 0.12).toFixed(3)})`; g.beginPath(); g.arc(rnd() * 256, rnd() * 256, 1 + rnd() * 9, 0, 7); g.fill(); }
  g.fillStyle = 'rgba(0,0,255,0.22)'; for (let k = 0; k < 256; k += 32) { g.fillRect(k, 0, 1, 256); g.fillRect(0, k, 256, 1); } // slab joints (~6 m)
  const t = canvasTex(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}

// ---------------- buildings ----------------
// facade shader: uv in metres (x along the wall, y above base); attribute 'bh' = wall height; style uniforms
function facadeMaterial(base, style) {
  const m = new THREE.MeshStandardMaterial(base);
  m.userData.uNight = { value: 0 };
  m.customProgramCacheKey = () => 'facade-' + style;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = m.userData.uNight;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 fac; varying vec3 vFac; varying vec3 vNl;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFac = fac; vNl = normal;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight; varying vec3 vFac; varying vec3 vNl;')
      .replace('#include <map_fragment>', `#include <map_fragment>
      float win = 0.0, lit = 0.0;
      if (abs(vNl.y) < 0.5) {
        float along = vFac.x, up = vFac.y, top = vFac.z;
        ${style === 'glass' ? `
          float fu = fract(along / 1.6), fv = fract(up / 4.2);
          float mull = step(0.06, fu) * step(fv, 0.86);
          win = mull * step(1.0, up) * step(up, top - 0.6);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16,0.22,0.27) + 0.06*fract(sin(floor(along/1.6)*7.1)*43.7), win);
          lit = step(0.4, fract(sin(dot(floor(vec2(along/6.4, up/4.2)), vec2(12.9,78.2)))*43758.5));`
        : style === 'hangar' ? `
          float door = step(up, min(top*0.85, 14.0)) * step(fract(along/36.0), 0.82) * step(0.06, fract(along/36.0)) * step(10.0, top);
          diffuseColor.rgb *= mix(1.0, 0.82, door);
          float fu = fract(along/4.0), fv = fract(up/top);
          win = step(top-2.2, up)*step(up, top-1.2)*step(0.2,fu)*step(fu,0.8)*(1.0-door);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2,0.25,0.3), win*0.8); lit = 0.4;`
        : style === 'thangar' ? `
          // T-hangar row: a bi-fold / sliding door per bay (~12 m), seams every 1.2 m, thin posts between bays
          float bay = fract(along / 12.2), post = step(bay, 0.035) + step(0.965, bay);
          float door = step(up, top - 0.45) * (1.0 - post);
          float seam = step(0.93, fract(along / 1.22)) * door;
          diffuseColor.rgb *= mix(1.0, 0.9, door) * (1.0 - seam * 0.25) * (1.0 - post * 0.35);
          diffuseColor.rgb *= 1.0 - 0.3 * step(up, 0.25) * door;  // dirty bottom rail
          win = 0.0; lit = 0.0;`
        : style === 'hdoor' ? `
          // hangar door wall: fac.z packs edge length (x100) + wall height
          float L = floor(top / 100.0), T = top - L * 100.0; float hw = L * 0.5 - max(1.5, L * 0.05);
          float dh = clamp(T * 0.82, 4.0, T - 1.2);
          float door = step(abs(along), hw) * step(up, dh);
          float nl = max(1.0, floor(L / 14.0)); float leaf = fract((along + hw) / (2.0 * hw) * nl);
          float track = (step(leaf, 0.012) + step(0.988, leaf)) * door;
          float rib = step(0.9, fract(along / 0.9)) * door;
          diffuseColor.rgb *= mix(1.0, 0.86, door) * (1.0 - 0.45 * track) * (1.0 - 0.12 * rib);
          diffuseColor.rgb *= 1.0 - 0.25 * step(up, 0.3) * door;
          // clerestory windows above the door
          float fu = fract(along / 4.0);
          win = step(dh + 0.6, up) * step(up, T - 0.5) * step(0.2, fu) * step(fu, 0.8) * step(abs(along), hw) * step(2.2, T - dh);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2,0.25,0.3), win * 0.8); lit = 0.3;`
        : style === 'house' ? `
          float fu = fract(along/5.5), fv = fract(up/2.9);
          win = step(0.35,fu)*step(fu,0.65)*step(0.32,fv)*step(fv,0.78)*step(up, top-0.4);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.08,0.09,0.1), win);
          lit = step(0.6, fract(sin(dot(floor(vec2(along/5.5, up/2.9)), vec2(12.9,78.2)) + top)*43758.5));`
        : `
          float fu = fract(along/3.4), fv = fract(up/3.6);
          win = step(0.18,fu)*step(fu,0.82)*step(0.28,fv)*step(fv,0.82)*step(1.0,up)*step(up, top-0.8);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1,0.13,0.16), win);
          lit = step(0.55, fract(sin(dot(floor(vec2(along/3.4, up/3.6)), vec2(12.9,78.2)) + top)*43758.5));`}
      }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += vec3(1.0,0.78,0.45)*win*lit*uNight*1.4;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.12, win);');
  };
  return m;
}
// extrude a footprint: walls (uv/fac in metres) + flat roof or gable
export function extrudeFootprint(p, y0, y1, out, roofOut, opts = {}) {
  let ring = p.slice(); if (ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
  if (ring.length < 3) return;
  const v2 = ring.map((q) => new THREE.Vector2(q[0], q[1]));
  if (THREE.ShapeUtils.isClockWise(v2)) { ring.reverse(); v2.reverse(); }
  const H = y1 - y0; let acc = 0;
  const wc = opts.col || null, rc = opts.rcol || null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.05) continue;
    // CCW in (x, z) with +z south... outward normal for CCW (x,y-up-z) ring: (dz, -dx)
    const nx = (b[1] - a[1]) / L, nz = -(b[0] - a[0]) / L;
    const eo = opts.edgeOut && opts.edgeOut(a, b, L, nx, nz);
    const o = eo ? (eo.P ? eo : eo.o || out) : out, ec = (eo && eo.col) || wc;
    const P = o.P, N = o.N, F = o.F;
    // door walls (o.door) get edge-local coordinates and the edge length packed into fac.z
    const s0 = o.door ? -L / 2 : acc, s1 = o.door ? L / 2 : acc + L, fz = o.door ? H + 100 * Math.floor(L) : H;
    const q = [[a[0], y0, a[1], s0, 0], [b[0], y0, b[1], s1, 0], [b[0], y1, b[1], s1, H], [a[0], y1, a[1], s0, H]];
    for (const k of [0, 2, 1, 0, 3, 2]) { P.push(q[k][0], q[k][1], q[k][2]); N.push(nx, 0, nz); F.push(q[k][3], q[k][4], fz); if (o.C) o.C.push(...(ec || [1, 1, 1])); }
    acc += L;
  }
  // roof
  const R = roofOut;
  const rpush = (V, n, u, v) => { R.P.push(...V); R.N.push(...n); R.U.push(u, v); if (R.C) R.C.push(...(rc || [1, 1, 1])); };
  if ((opts.gable || opts.arch) && ring.length === 4) {
    // gable / barrel along the long axis
    const d01 = Math.hypot(ring[1][0] - ring[0][0], ring[1][1] - ring[0][1]), d12 = Math.hypot(ring[2][0] - ring[1][0], ring[2][1] - ring[1][1]);
    const r = d01 >= d12 ? ring : [ring[1], ring[2], ring[3], ring[0]];
    const wdt = Math.min(d01, d12), rh = opts.rh ?? Math.min(4.5, wdt * 0.32);
    const tri = (A, B, C, toWall) => {
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2]; let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
      if (toWall) { // vertical end-wall piece (gable triangle / arch fill), outward normal given
        const [ox, oz] = toWall; if (nx * ox + nz * oz < 0) { [B, C] = [C, B]; }
        for (const V of [A, B, C]) { out.P.push(...V); out.N.push(ox, 0, oz); out.F.push((V[0] * -oz + V[2] * ox), V[1] - y0, H + (opts.rh || 0)); if (out.C) out.C.push(...(wc || [1, 1, 1])); }
        return;
      }
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; [B, C] = [C, B]; } for (const V of [A, B, C]) rpush(V, [nx / l, ny / l, nz / l], V[0] / 3, V[2] / 3);
    };
    const c = r.map((q) => [q[0], y1, q[1]]);
    // long axis u (r0->r1), across axis v (r0->r3)
    const ex = [r[1][0] - r[0][0], r[1][1] - r[0][1]], eL = Math.hypot(...ex); const endN0 = [-ex[0] / eL, -ex[1] / eL], endN1 = [ex[0] / eL, ex[1] / eL];
    const prof = opts.arch ? Array.from({ length: 13 }, (_, k) => { const t = k / 12, x = 2 * t - 1; return [t, rh * (1 - x * x) ** (opts.archExp || 0.6)]; }) : [[0, 0], [0.5, rh], [1, 0]];
    const at = (e0, e1, t, y) => [e0[0] + (e1[0] - e0[0]) * t, y1 + y, e0[1] + (e1[1] - e0[1]) * t];
    for (let k = 0; k + 1 < prof.length; k++) {
      const [t0, h0] = prof[k], [t1, h1] = prof[k + 1];
      const A0 = at(r[0], r[3], t0, h0), A1 = at(r[0], r[3], t1, h1), B0 = at(r[1], r[2], t0, h0), B1 = at(r[1], r[2], t1, h1);
      tri(A0, B0, B1); tri(A0, B1, A1);
      // end walls
      const M0 = at(r[0], r[3], 0.5, 0), M1 = at(r[1], r[2], 0.5, 0);
      tri([A0[0], y1, A0[2]], A0, A1, endN0); tri([A0[0], y1, A0[2]], A1, [A1[0], y1, A1[2]], endN0);
      tri([B0[0], y1, B0[2]], B0, B1, endN1); tri([B0[0], y1, B0[2]], B1, [B1[0], y1, B1[2]], endN1);
      void M0; void M1;
    }
    return;
  }
  let tris; try { tris = THREE.ShapeUtils.triangulateShape(v2, []); } catch { return; }
  for (const t of tris) for (const k of [t[0], t[2], t[1]]) rpush([ring[k][0], y1, ring[k][1]], [0, 1, 0], ring[k][0] / 6, ring[k][1] / 6);
}
export function wallGeo(o) {
  if (!o.P.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(o.P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(o.N, 3));
  g.setAttribute('fac', new THREE.Float32BufferAttribute(o.F, 3));
  const uv = new Float32Array(o.F.length / 3 * 2); for (let i = 0, j = 0; i < o.F.length; i += 3, j += 2) { uv[j] = o.F[i] / 3; uv[j + 1] = o.F[i + 1] / 3; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (o.C && o.C.length === o.P.length) g.setAttribute('color', new THREE.Float32BufferAttribute(o.C, 3));
  g.computeBoundingSphere(); return g;
}
export function roofGeo(o) {
  if (!o.P.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(o.P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(o.N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(o.U, 2));
  if (o.C && o.C.length === o.P.length) g.setAttribute('color', new THREE.Float32BufferAttribute(o.C, 3));
  g.computeBoundingSphere(); return g;
}
// corrugated_iron_02's albedo averages ~0.1 linear (dark, weathered); airport buildings get their paint colour from
// vertex colours, so the map is used as detail and its mean is normalised out with a colour gain
const CG = new THREE.Color(5.5, 5.5, 5.5);
export async function buildingMaterials(vc = false) {
  const [corr, plaster, roofT, conc, brick, tiles] = await Promise.all([pbr('corrugated_iron_02', 1), pbr('painted_plaster_wall', 1), pbr('grey_roof_01', 1), pbr('concrete_floor_02', 1), pbr('brick_wall_02', 1), pbr('roof_tiles', 1)]);
  return {
    glass: facadeMaterial({ color: 0xc9ced2, roughness: 0.35, metalness: 0.55, map: conc.diff }, 'glass'),
    office: facadeMaterial({ map: plaster.diff, normalMap: plaster.nor, color: 0xe4ded2, roughness: 0.9 }, 'office'),
    brick: facadeMaterial({ map: brick.diff, normalMap: brick.nor, color: 0xffffff, roughness: 0.9 }, 'office'),
    hangar: facadeMaterial({ map: corr.diff, normalMap: corr.nor, roughnessMap: corr.rough, color: 0xe6e9ec, roughness: 1, metalness: 0.45 }, 'hangar'),
    house: facadeMaterial({ map: plaster.diff, normalMap: plaster.nor, color: 0xf0e6d6, roughness: 0.92 }, 'house'),
    roof: new THREE.MeshStandardMaterial({ map: roofT.diff, normalMap: roofT.nor, color: 0xa9abaa, roughness: 0.92 }),
    roofTile: new THREE.MeshStandardMaterial({ map: tiles.diff, normalMap: tiles.nor, color: 0xc8b8a8, roughness: 0.85, side: THREE.DoubleSide }),
    concrete: new THREE.MeshStandardMaterial({ map: conc.diff, normalMap: conc.nor, color: 0xd9d6cf, roughness: 0.95 }),
    tex: { conc, corr, plaster },
    ...(vc ? {
      // vertex-coloured variants for airports: per-building wall paint, roof colour sampled from the orthophoto
      glass: facadeMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.55, map: conc.diff, vertexColors: true }, 'glass'),
      office: facadeMaterial({ map: plaster.diff, normalMap: plaster.nor, color: 0xffffff, roughness: 0.9, vertexColors: true }, 'office'),
      brick: facadeMaterial({ map: brick.diff, normalMap: brick.nor, color: 0xffffff, roughness: 0.9, vertexColors: true }, 'office'),
      hangar: facadeMaterial({ map: corr.diff, normalMap: corr.nor, roughnessMap: corr.rough, color: CG, roughness: 0.9, metalness: 0.2, vertexColors: true }, 'hangar'),
      thangar: facadeMaterial({ map: corr.diff, normalMap: corr.nor, roughnessMap: corr.rough, color: CG, roughness: 0.85, metalness: 0.18, vertexColors: true }, 'thangar'),
      hdoor: facadeMaterial({ map: corr.diff, normalMap: corr.nor, roughnessMap: corr.rough, color: CG, roughness: 0.8, metalness: 0.2, vertexColors: true }, 'hdoor'),
      house: facadeMaterial({ map: plaster.diff, normalMap: plaster.nor, color: 0xffffff, roughness: 0.92, vertexColors: true }, 'house'),
      roof: new THREE.MeshStandardMaterial({ map: roofT.diff, normalMap: roofT.nor, color: 0xffffff, roughness: 0.9, vertexColors: true }),
      roofTile: new THREE.MeshStandardMaterial({ map: tiles.diff, normalMap: tiles.nor, color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide, vertexColors: true }),
      metalRoof: new THREE.MeshStandardMaterial({ map: corr.diff, normalMap: corr.nor, color: CG, roughness: 0.6, metalness: 0.15, side: THREE.DoubleSide, vertexColors: true }),
      hvac: new THREE.MeshStandardMaterial({ color: 0xb9bcbc, roughness: 0.55, metalness: 0.5 }),
      // large curved shells (Moffett airship hangars): mostly diffuse so the shaded flanks still read under sky light
      shell: new THREE.MeshStandardMaterial({ map: corr.diff, color: CG, roughness: 0.75, metalness: 0.12, vertexColors: true }),
    } : {}),
  };
}


// ---------------- airport buildings ----------------
const WALL_PAL = {
  hangar: ['#e9e9e5', '#dedad0', '#cfc9ba', '#bfc4c8', '#d9d2c2', '#aeb8c0', '#e5dfcf', '#c8ccc4', '#b4b9ae'],
  thangar: ['#dcd7ca', '#d0d3d5', '#bdb5a2', '#e4e2dc', '#9aa5ad', '#c9c1ae', '#a9a294'],
  office: ['#e6e0d4', '#d9d0c0', '#cbbea8', '#ebe8e1', '#c2b9a8', '#d5cab7', '#b9b3a9', '#e0d6c6'],
  brick: ['#ffffff', '#f0e8e0', '#e8ddd0'],
  glass: ['#d6dadd', '#c9ced2', '#e0e2e2'],
  house: ['#f0e6d6', '#e8dcc5', '#dfe3e0', '#f4efe6', '#d9cbb3'],
};
const DOOR_PAL = ['#c9ced3', '#b4bcc4', '#e3e3df', '#8e9aa5', '#d2c8b4', '#a7b3a0', '#9fa7a0'];
function linCol(hex, k = 1) { const c = new THREE.Color(hex); return [c.r * k, c.g * k, c.b * k]; }
function ringArea(r) { let A = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) A += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(A) / 2; }
// minimum-area oriented bounding box
function obb(p) {
  let ring = p.slice(); if (ring.length > 3 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.5) continue;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const q of ring) { const u = q[0] * ux + q[1] * uz, v = -q[0] * uz + q[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const A = (u1 - u0) * (v1 - v0); if (!best || A < best.A) best = { A, ux, uz, u0, u1, v0, v1 };
  }
  if (!best) return null;
  let { ux, uz, u0, u1, v0, v1 } = best;
  if (v1 - v0 > u1 - u0) { [ux, uz] = [-uz, ux]; [u0, u1, v0, v1] = [v0, v1, -u1, -u0]; } // u = long axis
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const cx = cu * ux - cv * uz, cz = cu * uz + cv * ux;
  const L = u1 - u0, W = v1 - v0;
  const rect = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => [cx + ux * su * L / 2 - uz * sv * W / 2, cz + uz * su * L / 2 + ux * sv * W / 2]);
  return { cx, cz, ux, uz, L, W, fill: ringArea(ring) / Math.max(1, best.A), rect, n: ring.length };
}
function newSet(withC = true) { return { P: [], N: [], F: [], C: withC ? [] : undefined }; }
function newRoof() { return { P: [], N: [], U: [], C: [] }; }
function buildAirportBuildings(a, gh, B, group) {
  const W = { glass: newSet(), office: newSet(), brick: newSet(), hangar: newSet(), thangar: newSet(), hdoor: Object.assign(newSet(), { door: true }), house: newSet() };
  const Rf = { roof: newRoof(), roofTile: newRoof(), metalRoof: newRoof() };
  const hv = [];
  const rnd = mulberry((a.arp[0] * 7 + a.arp[1]) | 0);
  const pick = (arr) => arr[(rnd() * arr.length) | 0];
  const onPave = (x, z) => a.aprons.some((ap) => pointInPoly(x, z, ap.p)) || a.taxiways.some((t) => !t.lane && t.p.some((q, i) => i && segD(x, z, t.p[i - 1], q) < t.w / 2 + 6));
  for (const b of a.buildings) {
    if (b.p.length < 3) continue;
    let gmin = 1e9; for (const q of b.p) gmin = Math.min(gmin, gh(q[0], q[1]));
    const ob = obb(b.p); const rectish = ob && ob.fill > 0.86;
    const name = (b.n || '').toLowerCase();
    // landmarks with bespoke geometry
    if (a.icao === 'KNUQ' && name === 'hangar 1' && ob) { hangarOne(ob, gmin, group, B); continue; }
    if (a.icao === 'KNUQ' && name === 'hangar 2' && ob) { blimpHangar(ob, gmin, group, B); continue; }
    const roofC = b.rc ? linCol(b.rc, 1.9) : null;
    const isHangarish = b.k === 'hangar' || b.k === 'shed' || /hangar|hanger|row \d/.test(name);
    let style, h = b.h, opts = { rcol: roofC }, roofSet = Rf.roof, foot = b.p;
    const defaultH = !b.h || b.h === 10 || b.h === 7 || b.h === 4 || (isHangarish && b.h < 3.6);
    if (isHangarish && rectish && ob.W >= 7 && ob.W <= 17 && ob.L > 2.4 * ob.W) {
      // T-hangar / row hangar: low walls, shallow gable, a door per bay on both long sides
      style = 'hangar'; h = defaultH ? 3.6 + rnd() * 0.8 : Math.min(b.h, 6);
      foot = ob.rect; roofSet = Rf.metalRoof;
      const wc = linCol(pick(WALL_PAL.thangar)), dc = linCol(pick(DOOR_PAL));
      opts = { ...opts, gable: true, rh: Math.min(1.4, ob.W * 0.11), col: wc,
        edgeOut: (p0, p1, L) => (L > ob.W * 1.5 ? { o: W.thangar, col: dc } : null) };
    } else if (isHangarish && rectish && ob.W > 17) {
      // box / clear-span hangar: big door on the side facing the apron, low gable or arched roof
      style = 'hangar';
      h = defaultH ? Math.min(18, Math.max(7, 4.5 + ob.W * 0.16)) : b.h;
      foot = ob.rect; roofSet = Rf.metalRoof;
      const wc = linCol(pick(WALL_PAL.hangar)), dc = linCol(pick(DOOR_PAL));
      // pick the door side: edge whose outside is pavement (prefer long sides on large hangars)
      const r = ob.rect; let doorEdge = -1, bestS = 0;
      for (let i = 0; i < 4; i++) {
        const p0 = r[i], p1 = r[(i + 1) % 4], mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2, L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        const nx = (mx - ob.cx), nz = (mz - ob.cz), nl = Math.hypot(nx, nz) || 1;
        let sc = 0; for (const d of [8, 18, 30]) for (const f of [-0.3, 0, 0.3]) { const x = mx + nx / nl * d + (p1[0] - p0[0]) * f, z = mz + nz / nl * d + (p1[1] - p0[1]) * f; if (onPave(x, z)) sc++; }
        sc *= 1 + L / 200; if (sc > bestS) { bestS = sc; doorEdge = i; }
      }
      const de = doorEdge >= 0 ? [(r[doorEdge][0] + r[(doorEdge + 1) % 4][0]) / 2, (r[doorEdge][1] + r[(doorEdge + 1) % 4][1]) / 2] : null;
      const arch = ob.W > 26 && rnd() < 0.3;
      opts = { ...opts, gable: !arch, arch, archExp: 0.45, rh: arch ? Math.min(9, ob.W * 0.14) : Math.min(3.5, ob.W * 0.07), col: wc,
        edgeOut: (p0, p1) => (de && Math.hypot((p0[0] + p1[0]) / 2 - de[0], (p0[1] + p1[1]) / 2 - de[1]) < 0.5 ? { o: W.hdoor, col: dc } : null) };
    } else if (b.k === 'terminal') {
      style = 'glass'; h = b.h || 14; opts.col = linCol(pick(WALL_PAL.glass));
    } else if (b.k === 'house') {
      style = 'house'; h = b.h || 6; opts.col = linCol(pick(WALL_PAL.house));
      if (b.p.length <= 6 && ob) { opts.gable = true; foot = rectish ? ob.rect : b.p; roofSet = Rf.roofTile; }
    } else if (isHangarish) {
      style = 'hangar'; h = defaultH ? 6 + rnd() * 3 : b.h; opts.col = linCol(pick(WALL_PAL.hangar)); roofSet = Rf.metalRoof;
    } else {
      style = rnd() < 0.22 ? 'brick' : 'office'; h = b.h || 7; opts.col = linCol(pick(WALL_PAL[style]));
    }
    const y0 = gmin - 0.3 + (b.mh || 0), y1 = gmin + h - (b.k === 'house' ? 2.2 : 0);
    extrudeFootprint(foot, y0, Math.max(y0 + 2.5, y1), W[style], roofSet, opts);
    // rooftop HVAC units on flat-roofed offices / terminals
    if (!opts.gable && !opts.arch && (style === 'office' || style === 'brick' || style === 'glass') && ob) {
      const area = ringArea(b.p), n = Math.min(10, Math.floor(area / 320));
      for (let k = 0; k < n; k++) {
        const su = (rnd() - 0.5) * ob.L * 0.7, sv = (rnd() - 0.5) * ob.W * 0.7;
        const x = ob.cx + ob.ux * su - ob.uz * sv, z = ob.cz + ob.uz * su + ob.ux * sv; if (!pointInPoly(x, z, b.p)) continue;
        const w = 1.4 + rnd() * 2, d = 1.2 + rnd() * 1.4, hh = 0.9 + rnd() * 0.8;
        const g = new THREE.BoxGeometry(w, hh, d); g.rotateY(Math.atan2(-ob.uz, ob.ux)); g.translate(x, Math.max(y0 + 2.5, y1) + hh / 2, z); hv.push(g);
      }
    }
  }
  for (const k of Object.keys(W)) { const g = wallGeo(W[k]); if (g) { const m = new THREE.Mesh(g, B[k]); m.castShadow = m.receiveShadow = true; group.add(m); } }
  for (const k of Object.keys(Rf)) { const g = roofGeo(Rf[k]); if (g) { const m = new THREE.Mesh(g, B[k]); m.castShadow = m.receiveShadow = true; group.add(m); } }
  if (hv.length) { const g = mergeGeometries(hv, false); if (g) { const m = new THREE.Mesh(g, B.hvac); m.castShadow = m.receiveShadow = true; group.add(m); } }
}
// shell surface on the OBB frame: f(s,t) -> [u, v, y] in metres
function shellMesh(ob, y0, nu, nv, f, mat, col = [1, 1, 1], outDir = null) {
  const P = [], idx = [], UV = [];
  for (let i = 0; i <= nu; i++) {
    let arc = 0, prev = null;
    for (let j = 0; j <= nv; j++) {
      const [u, v, y] = f(i / nu * 2 - 1, j / nv * 2 - 1);
      if (prev) arc += Math.hypot(v - prev[0], y - prev[1]); prev = [v, y];
      P.push(ob.cx + ob.ux * u - ob.uz * v, y0 + y, ob.cz + ob.uz * u + ob.ux * v); UV.push(arc / 3, u / 3);
    }
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const a = i * (nv + 1) + j, b = a + nv + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(idx);
  g.computeVertexNormals();
  // make normals point outward (up / away from the centre line)
  const n = g.attributes.normal, p = g.attributes.position; let flip = 0;
  for (let k = 0; k < n.count; k += 7) flip += (outDir ? n.getX(k) * outDir[0] + n.getZ(k) * outDir[1] : n.getY(k)) < 0 ? 1 : -1;
  if (flip > 0) { for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]]; g.setIndex(idx); g.computeVertexNormals(); }
  void p; g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setAttribute('fac', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).map((_, i) => col[i % 3]), 3));
  const m = new THREE.Mesh(g, mat); m.castShadow = m.receiveShadow = true; return m;
}
// Moffett Hangar One (1933): 1,133 x 308 ft, 198 ft tall, streamlined plan with rounded "orange-peel" door ends;
// reclad in silver corrugated siding (restoration completed Dec 2025)
function hangarOne(ob, y0, group, B) {
  const L = 345, Wd = 94, H = 60.4;
  group.add(shellMesh(ob, y0 - 0.3, 64, 28, (s, t) => {
    const e = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(s), 5)), 1 / 5); // superellipse plan / profile
    const hw = Wd / 2 * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(s), 3.2)), 1 / 3.2);
    const y = H * e * Math.pow(Math.max(0, 1 - t * t), 0.62);
    return [s * L / 2, t * hw, y];
  }, B.shell, linCol('#bfc4c7')));
  // ridge catwalk
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(L * 0.86, 1.2, 2.2), B.hvac);
  ridge.rotation.y = Math.atan2(-ob.uz, ob.ux); ridge.position.set(ob.cx, y0 + H - 0.1, ob.cz); group.add(ridge);
}
// Moffett Hangar 2 (1943 wooden airship hangar): ~1,075 x 297 ft, 171 ft tall parabolic barrel; Hangar 3 was dismantled 2024-25
function blimpHangar(ob, y0, group, B) {
  const L = Math.min(ob.L, 328), Wd = Math.min(ob.W, 91), H = 52, prof = (t) => H * Math.pow(Math.max(0, 1 - t * t), 0.85);
  const col = linCol('#9aa298');
  group.add(shellMesh(ob, y0 - 0.3, 6, 32, (s, t) => [s * L / 2, t * Wd / 2, prof(t)], B.shell, col));
  // end walls (door leaves), slightly inset, as thin shells so they share the lit facade material
  for (const sg of [-1, 1]) {
    const u = sg * (L / 2 - 1.5);
    group.add(shellMesh(ob, y0 - 0.3, 1, 32, (s, t) => [u + s * 0.5 * sg, t * Wd / 2, (s + 1) / 2 * prof(t)], B.shell, linCol('#8f978d'), [ob.ux * sg, ob.uz * sg]));
  }
}

// ---------------- control towers ----------------
function lathe(profile, seg = 24) { return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg); }
function buildTower(a, info, M, glass) {
  const t = new THREE.Group(); const H = info.h; let cab;
  if (a.icao === 'KSFO') {
    // SFO's 221 ft "torch": tapering shaft that flares into the cab (2016)
    const shaft = lathe([[0, 0], [6.2, 0], [5.2, 12], [4.2, 30], [3.9, 42], [5.6, 50], [8.6, 55.5], [8.8, 56]], 32);
    t.add(new THREE.Mesh(shaft, M.concrete));
    const g = lathe([[8.8, 56], [9.4, 61.5], [9.0, 62]], 32); t.add(new THREE.Mesh(g, glass));
    t.add(new THREE.Mesh(lathe([[0, 62], [9.0, 62], [9.4, 63.2], [6, 64.6], [0, 64.8]], 32), M.concrete));
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 2.6, 6), M.concrete); ant.position.y = 66.1; t.add(ant);
    cab = 59;
  } else if (a.icao === 'KOAK') {
    // Oakland's 236 ft tower (2013): slender concrete shaft, faceted cab
    t.add(new THREE.Mesh(new THREE.CylinderGeometry(3.6, 4.6, 58, 24).translate(0, 29, 0), M.concrete));
    t.add(new THREE.Mesh(lathe([[3.6, 58], [6.5, 61], [7.2, 63]], 8), M.concrete));
    t.add(new THREE.Mesh(lathe([[7.2, 63], [7.9, 68.2]], 8), glass));
    t.add(new THREE.Mesh(lathe([[0, 68.2], [8.4, 68.2], [8.2, 69.2], [0, 69.4]], 8), M.concrete));
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 2.6, 6), M.concrete); ant.position.y = 70.7; t.add(ant);
    cab = 65.5;
  } else if (info.t) {
    // FAA standard tower designs (FAA BIL ATCT PEA 2023, App. B): shaft + cab shapes per design type
    const flat = (g) => { const n = g.toNonIndexed(); n.computeVertexNormals(); return n; };
    const poly = (prof, sides, rot = 0) => flat(lathe(prof, sides).rotateY(rot));
    const cf = info.cf || H * 0.68;
    const spec = {
      L: { sides: 5, cab: 3.7, shaft: [[3.2, 0], [3.2, cf]], shaftSides: 4, cabH: 3.0 },        // square occupied shaft, 5-sided cab
      O: { sides: 5, cab: 4.0, shaft: [[6.0, 0], [4.0, cf]], shaftSides: 5, cabH: 3.2 },        // sloping pentagonal shaft, 5-sided cab
      avco: { sides: 6, cab: 3.6, shaft: [[2.4, 0], [2.4, cf]], shaftSides: 4, cabH: 3.0 },     // slim square steel shaft, hexagonal cab
      ial: { sides: 8, cab: 5.0, shaft: [[4.6, 0], [4.6, cf]], shaftSides: 4, cabH: 3.6 },      // square shaft, chamfered-square cab
      1961: { sides: 4, cab: 4.0, shaft: [[3.6, 0], [3.4, cf]], shaftSides: 4, cabH: 3.0 },     // 1961 pre-standard: square shaft, square cab
      navy: { sides: 4, cab: 3.6, shaft: [[3.4, 0], [3.4, cf]], shaftSides: 4, cabH: 3.0 },
    }[info.t] || { sides: 8, cab: 4, shaft: [[2.5, 0], [2.5, cf]], shaftSides: 16, cabH: 3 };
    const ro = spec.sides === 4 ? Math.PI / 4 : 0, rs = spec.shaftSides === 4 ? Math.PI / 4 : 0;
    t.add(new THREE.Mesh(poly([[0, 0], ...spec.shaft, [0, cf]], spec.shaftSides, rs), M.concrete));
    const R0 = spec.cab, cH = spec.cabH;
    t.add(new THREE.Mesh(poly([[0, cf - 0.6], [R0 * 1.02, cf - 0.6], [R0 * 1.02, cf]], spec.sides, ro), M.concrete)); // cab floor slab
    t.add(new THREE.Mesh(poly([[R0 * 0.96, cf], [R0 * 1.1, cf + cH]], spec.sides, ro), glass));              // outward-leaning glazing
    t.add(new THREE.Mesh(poly([[0, cf + cH], [R0 * 1.22, cf + cH], [R0 * 1.18, cf + cH + 0.7], [0, cf + cH + 0.8]], spec.sides, ro), M.concrete)); // roof with overhang
    // catwalk railing ring under the cab
    t.add(new THREE.Mesh(poly([[R0 * 1.25, cf - 0.55], [R0 * 1.25, cf + 0.5], [R0 * 1.22, cf + 0.5], [R0 * 1.22, cf - 0.55]], spec.sides, ro), M.concrete));
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 3.2, 6), M.concrete); ant.position.set(R0 * 0.5, cf + cH + 2.4, 0); t.add(ant);
    if (info.t === 'L' || info.t === 'ial' || info.t === 'O' || info.t === '1961') {
      // single-storey base / equipment building
      const bw = info.t === 'ial' ? 22 : 10, bd = info.t === 'ial' ? 14 : 8;
      const base = new THREE.Mesh(new THREE.BoxGeometry(bw, 3.6, bd).translate(bw / 2 - 2, 1.8, 0), M.office); t.add(base);
    }
    cab = cf + cH / 2;
    t.userData.top = cf + cH + 0.8;
  } else {
    const cabTop = Math.max(10, H - 1.5), cabH = Math.min(4.5, H * 0.18), cabR = H > 25 ? 5.2 : 3.6;
    t.add(new THREE.Mesh(new THREE.CylinderGeometry(cabR * 0.48, cabR * 0.6, cabTop - cabH, 16).translate(0, (cabTop - cabH) / 2, 0), M.concrete));
    t.add(new THREE.Mesh(lathe([[cabR * 0.9, cabTop - cabH], [cabR, cabTop]], 8), glass));
    t.add(new THREE.Mesh(lathe([[0, cabTop], [cabR * 1.08, cabTop], [cabR * 1.05, cabTop + 0.7], [0, cabTop + 0.8]], 8), M.concrete));
    if (H > 20) { const base = new THREE.Mesh(new THREE.BoxGeometry(14, 4, 10).translate(0, 2, 0), M.office); base.geometry.setAttribute('fac', new THREE.Float32BufferAttribute(new Float32Array(base.geometry.attributes.position.count * 3), 3)); t.add(base); }
    cab = cabTop - cabH / 2;
  }
  t.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; if (!o.geometry.attributes.fac) o.geometry.setAttribute('fac', new THREE.Float32BufferAttribute(new Float32Array(o.geometry.attributes.position.count * 3), 3)); } });
  return { t, cab, top: a.icao === 'KSFO' ? 67.4 : a.icao === 'KOAK' ? 72 : t.userData.top || H };
}

// ---------------- parked airliners at terminal gates ----------------
const GATE_MIX = {
  KSFO: [['UAL', 'B39M'], ['UAL', 'A320'], ['UAL', 'B789'], ['UAL', 'B77W'], ['ASA', 'B39M'], ['DAL', 'A321'], ['AAL', 'A321'], ['JBU', 'A320'], ['SKW', 'E175'], ['SWA', 'B738'], ['HAL', 'A321'], ['UAL', 'B738']],
  KOAK: [['SWA', 'B738'], ['SWA', 'B39M'], ['SWA', 'B738'], ['ASA', 'B39M'], ['DAL', 'A320'], ['HAL', 'A321'], ['FDX', 'B77W']],
  KSJC: [['SWA', 'B738'], ['ASA', 'B39M'], ['SWA', 'B39M'], ['DAL', 'A321'], ['AAL', 'A321'], ['UAL', 'A320'], ['SKW', 'E175']],
};
function gateSpots(a, max) {
  const spots = []; const terms = a.buildings.filter((b) => b.k === 'terminal');
  const onApron = (x, z) => a.aprons.some((ap) => pointInPoly(x, z, ap.p));
  const nearTaxi = (x, z, d) => a.taxiways.some((t) => !t.lane && t.p.some((q, i) => i && segD(x, z, t.p[i - 1], q) < d));
  for (const b of terms) {
    const p = b.p; let acc = 0;
    for (let i = 0; i < p.length - 1 && spots.length < max; i++) {
      const A = p[i], B = p[i + 1], L = Math.hypot(B[0] - A[0], B[1] - A[1]); if (L < 30) { acc += L; continue; }
      const dx = (B[0] - A[0]) / L, dz = (B[1] - A[1]) / L;
      for (let s = 20; s < L - 15 && spots.length < max; s += 52) {
        const x0 = A[0] + dx * s, z0 = A[1] + dz * s;
        for (const sg of [1, -1]) {
          const nx = dz * sg, nz = -dx * sg; // try both sides
          if (pointInPoly(x0 + nx * 4, z0 + nz * 4, p)) continue; // inside the building
          const cx = x0 + nx * 28, cz = z0 + nz * 28;
          if (!onApron(cx, cz) || !onApron(x0 + nx * 48, z0 + nz * 48) || nearTaxi(cx, cz, 30)) continue;
          if (spots.some((q) => Math.hypot(q.x - cx, q.z - cz) < 44)) continue;
          if (terms.some((tb) => pointInPoly(cx, cz, tb.p) || pointInPoly(x0 + nx * 50, z0 + nz * 50, tb.p))) continue;
          spots.push({ x: cx, z: cz, wx: x0, wz: z0, nx, nz }); break;
        }
      }
    }
  }
  return spots;
}
function segD(x, z, a, b) { const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1; let t = ((x - a[0]) * dx + (z - a[1]) * dz) / L2; t = Math.max(0, Math.min(1, t)); return Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z); }

// ---------------- main builder ----------------
let MATS = null;
export async function buildAirports(scene, envMap, buildAircraftFn, elevationProvider = null, airportList = AIRPORTS) {
  if (!MATS) {
    const [asph, conc, B] = await Promise.all([pbr('asphalt_02', 1), pbr('concrete_floor_02', 1), buildingMaterials(true)]);
    MATS = { asph, conc, B, taxi: taxiTex(), apron: apronTex() };
    MATS.taxiM = pavementMaterial(asph, MATS.taxi, 0.82, 0.5);
    MATS.apronM = pavementMaterial(conc, MATS.apron, 0.9, 0.6);
    MATS.lineM = new THREE.MeshStandardMaterial({ color: 0xc89a18, roughness: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    MATS.glass = new THREE.MeshPhysicalMaterial({ color: 0x1c3646, roughness: 0.05, metalness: 0.3, envMapIntensity: 1.5, transparent: true, opacity: 0.8 });
    MATS.taxiM.polygonOffset = true; MATS.taxiM.polygonOffsetFactor = -1; MATS.taxiM.polygonOffsetUnits = -1;
    MATS.apronM.polygonOffset = true; MATS.apronM.polygonOffsetFactor = 0; MATS.apronM.polygonOffsetUnits = 0;
  }
  const { asph, conc, B } = MATS;
  const group = new THREE.Group(); scene.add(group);
  const lightsList = [], papis = [], beacons = [], strobes = [], nightMats = [B.glass, B.office, B.brick, B.hangar, B.house, B.thangar, B.hdoor];
  const ownMats = [];
  for (const a of airportList) {
    const gh = (x, z) => { const c = elevationProvider?.(x, z); return Number.isFinite(c) ? c : heightAt(x, z); };
    // ---- runways ----
    for (const r of a.runways) {
      const conc_ = r.surf === 'concrete';
      const mat = pavementMaterial(conc_ ? conc : asph, runwayMarkings(r), conc_ ? 0.95 : 0.9); ownMats.push(mat);
      mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2;
      const m = new THREE.Mesh(stripGeometry(r, -r.len / 2, r.len / 2, -r.wid / 2, r.wid / 2, 12, 0.1, gh), mat); m.receiveShadow = true; group.add(m);
    }
    // ---- taxiways, aprons ----
    const tg = [], ag = [], lg = [];
    a.taxiways.forEach((t, i) => {
      if (t.p.length < 2) return;
      if (t.lane) { const g = ribbon(t.p, 0.3, 0.1, gh, false); if (g) lg.push(g); return; }
      const g = ribbon(t.p, t.w, 0.08 + (i % 5) * 0.002, gh); if (g) tg.push(g);
      for (let k = 1; k < t.p.length - 1; k++) {
        const ax = t.p[k][0] - t.p[k - 1][0], az = t.p[k][1] - t.p[k - 1][1], bx = t.p[k + 1][0] - t.p[k][0], bz = t.p[k + 1][1] - t.p[k][1];
        const c = (ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz) || 1); if (c < 0.92) tg.push(disc(t.p[k][0], t.p[k][1], t.w * 0.62, 0.078, gh));
      }
      // edge lights (blue)
      for (let k = 0; k + 1 < t.p.length; k++) {
        const [x0, z0] = t.p[k], [x1, z1] = t.p[k + 1]; const L = Math.hypot(x1 - x0, z1 - z0); const px = -(z1 - z0) / (L || 1), pz = (x1 - x0) / (L || 1);
        for (let d = 15; d < L; d += 60) for (const sd of [-1, 1]) { const x = x0 + (x1 - x0) * d / L + px * sd * (t.w / 2 + 1), z = z0 + (z1 - z0) * d / L + pz * sd * (t.w / 2 + 1); lightsList.push({ p: [x, gh(x, z) + 0.35, z], c: [0.12, 0.3, 1], s: 0.75 }); }
      }
      // hold-short markings where the taxiway enters a runway's protected area
      for (const r of a.runways) {
        const hd = r.wid / 2 + (r.len > 2400 ? 60 : r.wid >= 30 ? 45 : 25);
        for (let k = 0; k + 1 < t.p.length; k++) {
          const A = toLocal(r, t.p[k][0], t.p[k][1]), Bq = toLocal(r, t.p[k + 1][0], t.p[k + 1][1]);
          for (const sd of [-1, 1]) {
            const fa = A.v * sd - hd, fb = Bq.v * sd - hd; if (fa * fb >= 0) continue;
            const s = fa / (fa - fb); const u = A.u + (Bq.u - A.u) * s; if (Math.abs(u) > r.len / 2) continue;
            const x = t.p[k][0] + (t.p[k + 1][0] - t.p[k][0]) * s, z = t.p[k][1] + (t.p[k + 1][1] - t.p[k][1]) * s;
            // direction toward runway along the taxiway
            let dx = t.p[k + 1][0] - t.p[k][0], dz = t.p[k + 1][1] - t.p[k][1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L; if (fa < 0) { dx = -dx; dz = -dz; }
            const px = -dz, pz = dx, hw = t.w / 2;
            const quad = (o0, o1, w0, w1) => {
              const P = []; for (const [o, w] of [[o0, w0], [o1, w0], [o1, w1], [o0, w0], [o1, w1], [o0, w1]]) { const X = x + dx * o + px * w, Z = z + dz * o + pz * w; P.push(X, gh(X, Z) + 0.12, Z); }
              const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3)); lg.push(g);
            };
            // two solid lines (taxiway side) + two dashed (runway side)
            quad(-1.5, -1.2, -hw, hw); quad(-0.9, -0.6, -hw, hw);
            for (let w = -hw; w < hw; w += 1.8) { quad(-0.3, 0, w, Math.min(hw, w + 0.9)); quad(0.3, 0.6, w, Math.min(hw, w + 0.9)); }
            // runway guard lights (wig-wag, yellow) at both sides
            for (const sg of [-1, 1]) strobes.push({ p: [x + px * sg * (hw + 2), gh(x, z) + 0.6, z + pz * sg * (hw + 2)], c: [1, 0.75, 0.1], s: 1.3, ph: sg > 0 ? 0 : 0.5, kind: 'wig' });
          }
        }
      }
    });
    for (const ap of a.aprons) { const g = polyGeometry(ap.p, ap.h, 0.06, gh); if (g) ag.push(g); }
    const mergeAdd = (list, mat) => {
      if (!list.length) return; const lst = list.map((g) => (g.index ? g.toNonIndexed() : g));
      for (const g of lst) for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'uvm'].includes(k)) g.deleteAttribute(k);
      const has = (k) => lst.every((g) => g.attributes[k]); for (const g of lst) for (const k of ['uv', 'uvm']) if (!has(k) && g.attributes[k]) g.deleteAttribute(k);
      const g = mergeGeometries(lst, false); if (!g) return; g.computeBoundingSphere(); const m = new THREE.Mesh(g, mat); m.receiveShadow = true; m.userData.pave = true; group.add(m);
    };
    mergeAdd(ag, MATS.apronM); mergeAdd(tg, MATS.taxiM); mergeAdd(lg, MATS.lineM);
    // ---- buildings: typology from footprint shape + OSM tags, roof colours sampled from the orthophoto ----
    buildAirportBuildings(a, gh, B, group);
    // ---- control tower ----
    if (a.towerInfo || a.tower) {
      const info = a.towerInfo || { x: a.ramp.x + 60, z: a.ramp.z + 60, h: 20 };
      const { t, cab, top } = buildTower(a, info, B, MATS.glass);
      const base = gh(info.x, info.z); t.position.set(info.x, base, info.z); group.add(t);
      a.towerPos = new THREE.Vector3(info.x, base + cab, info.z);
      lightsList.push({ p: [info.x, base + top + 0.3, info.z], c: [1, 0.08, 0.05], s: 1.6 });
      beacons.push({ p: new THREE.Vector3(info.x, base + top + 1.2, info.z) });
    } else {
      // rotating beacon on a pole by the ramp
      const x = a.ramp.x + a.perp[0] * -60, z = a.ramp.z + a.perp[1] * -60;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 16, 8), new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.7, roughness: 0.4 }));
      pole.position.set(x, gh(x, z) + 8, z); pole.castShadow = true; group.add(pole);
      beacons.push({ p: new THREE.Vector3(x, gh(x, z) + 16.5, z) });
    }
    // ---- windsocks at their OSM positions ----
    a.windsocks = [];
    const socks = a.socks.length ? a.socks : [[a.x + a.perp[0] * (a.wid / 2 + 60), a.z + a.perp[1] * (a.wid / 2 + 60)]];
    for (const [x, z] of socks) {
      const base = gh(x, z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 6, 8), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.6, roughness: 0.4 }));
      pole.position.set(x, base + 3, z); pole.castShadow = true; group.add(pole);
      const sc = document.createElement('canvas'); sc.width = 256; sc.height = 32; const sg = sc.getContext('2d');
      for (let i = 0; i < 5; i++) { sg.fillStyle = i % 2 ? '#f4f4f4' : '#ff5a12'; sg.fillRect(i * 51.2, 0, 51.2, 32); }
      const st = new THREE.CanvasTexture(sc); st.colorSpace = THREE.SRGBColorSpace;
      const g2 = new THREE.CylinderGeometry(0.22, 0.42, 2.8, 16, 6, true); g2.rotateZ(-Math.PI / 2); g2.translate(1.4, 0, 0);
      const uv = g2.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i), uv.getX(i));
      const sock = new THREE.Mesh(g2, new THREE.MeshStandardMaterial({ map: st, side: THREE.DoubleSide, roughness: 0.9 })); sock.castShadow = true;
      const piv = new THREE.Group(); piv.position.set(x, base + 5.8, z); piv.add(sock); group.add(piv); a.windsocks.push(piv);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(10, 0.25, 4, 32).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xf1f1f1, roughness: 0.8 }));
      if (!a.tower) { ring.position.set(x, base + 0.05, z); group.add(ring); }
      lightsList.push({ p: [x, base + 6.3, z], c: [1, 0.1, 0.05], s: 1 });
    }
    a.windsock = a.windsocks[0];
    // ---- runway lighting ----
    for (const r of a.runways) {
      if (r.lit === false) continue;
      const instr = r.ilsList.length > 0;
      for (let d = 0; d <= r.len + 0.1; d += 60) for (const sgn of [-1, 1]) {
        const { x, z } = fromLocal(r, -r.len / 2 + d, sgn * (r.wid / 2 + 1.5));
        lightsList.push({ p: [x, gh(x, z) + 0.45, z], c: instr && (d < 600 || r.len - d < 600) ? [1, 0.82, 0.35] : [1, 0.93, 0.8], s: 1 });
      }
      if (r.len > 2400) for (let d = 30; d < r.len - 30; d += 15) { const { x, z } = fromLocal(r, -r.len / 2 + d, 0); const tail = r.len - d < 900 || d < 900; lightsList.push({ p: [x, gh(x, z) + 0.12, z], c: tail && ((d / 15) | 0) % 2 ? [1, 0.12, 0.08] : [1, 0.95, 0.85], s: 0.6 }); }
      for (let e = 0; e < 2; e++) {
        const sU = e === 0 ? -1 : 1, thr = sU * (r.len / 2 - (r.disp[e] || 0));
        for (let w = -r.wid / 2; w <= r.wid / 2 + 0.1; w += 3) {
          const p = fromLocal(r, thr - sU * 0.5, w); lightsList.push({ p: [p.x, gh(p.x, p.z) + 0.35, p.z], c: [0.3, 1, 0.35], s: 0.9 });
          const q = fromLocal(r, sU * (r.len / 2 + 0.6), w); lightsList.push({ p: [q.x, gh(q.x, q.z) + 0.35, q.z], c: [1, 0.1, 0.05], s: 0.7 });
        }
        // approach lights (ALSF-2 / MALSR style) on the ILS ends, with sequenced flashers
        const ils = r.ilsList.find((q) => q.end === e);
        if (ils) {
          const len = r.len > 2500 ? 730 : 430, step = r.len > 2500 ? 30 : 61;
          for (let d = step; d <= len; d += step) {
            for (let w = -2; w <= 2; w += 1) { const p = fromLocal(r, thr - sU * d, w * 1.0); lightsList.push({ p: [p.x, Math.max(gh(p.x, p.z), 0) + 1.5, p.z], c: [1, 0.95, 0.85], s: 1.1 }); }
            if (Math.abs(d - 300) < step / 2) for (let w = -15; w <= 15; w += 1.5) { const p = fromLocal(r, thr - sU * d, w); lightsList.push({ p: [p.x, Math.max(gh(p.x, p.z), 0) + 1.5, p.z], c: [1, 0.95, 0.85], s: 1.1 }); }
            if (d > len * 0.45) { const p = fromLocal(r, thr - sU * d, 0); strobes.push({ p: [p.x, Math.max(gh(p.x, p.z), 0) + 1.8, p.z], c: [1, 1, 1], s: 3, ph: 1 - d / len, kind: 'rabbit' }); }
          }
        }
        // PAPI: left side abeam the aiming point
        const gs = (ils && ils.gs) || 3.0; const units = [];
        for (let k = 0; k < 4; k++) {
          const w = -(r.wid / 2 + 15 + k * 9);
          const p = fromLocal(r, thr - sU * 330, e === 0 ? w : -w);
          const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 1.2), new THREE.MeshStandardMaterial({ color: 0xe0a020, roughness: 0.6 }));
          const ph = gh(p.x, p.z); box.position.set(p.x, ph + 0.4, p.z); box.rotation.y = -r.hdg * D2R; group.add(box);
          units.push({ p: [p.x, ph + 0.85, p.z], c: [1, 1, 1], s: 2.4, ang: gs + [0.5, 0.17, -0.17, -0.5][k] });
        }
        papis.push({ r, e, units });
      }
    }
    // ---- parked aircraft ----
    if (GATE_MIX[a.icao]) {
      const spots = gateSpots(a, a.icao === 'KSFO' ? 46 : 22); const mix = GATE_MIX[a.icao]; const rnd = mulberry(a.icao.charCodeAt(1) * 99);
      const byKey = new Map();
      spots.forEach((s, i) => {
        if (rnd() < 0.22) return; // some gates empty
        let [lv, ty] = mix[Math.floor(rnd() * mix.length)];
        const G = airlinerGeometry(ty); if (G.T.L / 2 + 6 > 40 && rnd() < 0.5) [lv, ty] = mix[0];
        const key = lv + ty; if (!byKey.has(key)) byKey.set(key, { lv, ty, m: [] });
        // nose ~7 m from the terminal wall
        const L = airlinerGeometry(ty).T.L; const cx = s.wx + s.nx * (L / 2 + 7), cz = s.wz + s.nz * (L / 2 + 7);
        const mtx = new THREE.Matrix4().compose(new THREE.Vector3(cx, gh(cx, cz), cz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(s.nx, s.nz)), new THREE.Vector3(1, 1, 1));
        byKey.get(key).m.push(mtx);
        // jet bridge from the wall to the forward left door
        const jl = 9 + L * 0.06; const jb = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3, jl), B.concrete);
        const side = 1; const lx = -s.nz * side, lz = s.nx * side;
        const bx = s.wx + s.nx * (jl / 2 + 1) + lx * 3, bz = s.wz + s.nz * (jl / 2 + 1) + lz * 3;
        jb.position.set(bx, gh(bx, bz) + 4.6, bz); jb.rotation.y = Math.atan2(s.nx, s.nz); jb.castShadow = true; group.add(jb);
      });
      for (const { lv, ty, m } of byKey.values()) {
        const G = airlinerGeometry(ty), M = airlinerMaterials(lv);
        for (const [geo, mat] of [[G.fus, M.fus], [airlinerRest(ty, lv), M.rest]]) {
          const im = new THREE.InstancedMesh(geo, mat, m.length);
          // airliner geometry is +X forward; rotate so it faces object -Z like our matrices assume
          const pre = new THREE.Matrix4().makeRotationY(Math.PI / 2);
          m.forEach((mm, i) => im.setMatrixAt(i, mm.clone().multiply(pre)));
          im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); group.add(im);
        }
      }
    }
    if (buildAircraftFn) {
      // GA aircraft tied down on the ramp
      const n = a.size === 'L' ? 2 : 6; let placed = 0;
      for (let row = 0; row < 3 && placed < n; row++) for (let k = -4; k <= 4 && placed < n; k++) {
        const u = k * 13, v = 22 + row * 16;
        const fx = Math.sin(a.ramp.hdg * D2R), fz = -Math.cos(a.ramp.hdg * D2R);
        const x = a.ramp.x + fz * -u - fx * v, z = a.ramp.z + fx * u - fz * v;
        if (!a.aprons.some((ap) => pointInPoly(x, z, ap.p))) continue;
        if (a.taxiways.some((t) => !t.lane && t.p.some((q, i) => i && segD(x, z, t.p[i - 1], q) < t.w / 2 + 9))) continue;
        a._gaSpots = a._gaSpots || []; a._gaSpots.push({ x, z, hdg: a.ramp.hdg }); placed++;
      }
    }
  }
  // GA models: build each scheme once and clone (shared geometry)
  const parked = [];
  if (buildAircraftFn) {
    const regs = [['N5284Q', 1], ['N738HP', 2], ['N12KD', 3], ['N64220', 1]]; const proto = [];
    let i = 0;
    for (const a of airportList) for (const s of a._gaSpots || []) {
      const k = i++ % regs.length;
      if (!proto[k]) { const m = await buildAircraftFn({ envMap, reg: regs[k][0], scheme: regs[k][1], interior: false, lights: false }); proto[k] = flattenStatic(m); }
      const m = proto[k].clone(); const h = s.hdg + (i % 2 ? 4 : -5);
      m.position.set(s.x, (elevationProvider?.(s.x, s.z) ?? heightAt(s.x, s.z)) + 1.19, s.z); m.rotation.set(0, (90 - h) * D2R, 0);
      group.add(m); parked.push(m);
    }
    for (const a of airportList) delete a._gaSpots;
  }

  const lm = lightMaterial();
  const rlights = makePoints(lightsList, lm); group.add(rlights);
  const pm = lightMaterial(); pm.uniforms.uNight.value = 1;
  const papiPts = makePoints(papis.flatMap((p) => p.units), pm); group.add(papiPts);
  const bm = lightMaterial(); bm.uniforms.uNight.value = 1;
  const beaconPts = makePoints(beacons.map((b) => ({ p: b.p.toArray(), c: [0, 0, 0], s: 3.5 })), bm); group.add(beaconPts);
  const sm = lightMaterial(); sm.uniforms.uNight.value = 1;
  const strobePts = strobes.length ? makePoints(strobes.map((s) => ({ ...s, c: [0, 0, 0] })), sm) : null; if (strobePts) group.add(strobePts);

  const updateLights = (camPos, night, t) => {
    lm.uniforms.uNight.value = night;
    for (const m of nightMats) if (m.userData.uNight) m.userData.uNight.value = night;
    const col = papiPts.geometry.attributes.color; let idx = 0;
    for (const p of papis) {
      const { u: lu } = toLocal(p.r, camPos.x, camPos.z); const vis = (p.e === 0 ? lu < -p.r.len / 2 + 300 : lu > p.r.len / 2 - 300) ? 1 : 0;
      for (const u of p.units) {
        const ang = Math.atan2(camPos.y - u.p[1], Math.hypot(camPos.x - u.p[0], camPos.z - u.p[2])) / D2R; const white = ang > u.ang;
        col.setXYZ(idx++, vis, (white ? 1 : 0.08) * vis, (white ? 0.95 : 0.05) * vis);
      }
    }
    col.needsUpdate = true;
    const bc = beaconPts.geometry.attributes.color;
    for (let i = 0; i < bc.count; i++) {
      const ph = (t * 0.5 + i * 0.37) % 1; const on = night > 0.2 ? Math.max(0, 1 - Math.abs(((ph * 2) % 1) - 0.5) * 12) : 0;
      if (ph < 0.5) bc.setXYZ(i, 0.2 * on, on, 0.4 * on); else bc.setXYZ(i, on, on, on);
    }
    bc.needsUpdate = true;
    if (strobePts) {
      const sc = strobePts.geometry.attributes.color; const vis = night > 0.15 ? 1 : 0.35;
      strobes.forEach((s, i) => {
        let on;
        if (s.kind === 'rabbit') { const ph = (t * 2 + s.ph) % 1; on = ph < 0.06 ? vis : 0; }
        else { on = ((t + s.ph) % 1) < 0.5 ? vis * 0.9 : 0; }
        sc.setXYZ(i, s.c[0] * on, s.c[1] * on, s.c[2] * on);
      });
      sc.needsUpdate = true;
    }
  };
  const dispose = () => {
    scene.remove(group);
    group.traverse((o) => {
      if (o.isInstancedMesh) { o.dispose(); return; }
      if (o.geometry && !o.userData.shared) o.geometry.dispose();
    });
    for (const m of ownMats) { m.userData.markTex?.dispose(); m.dispose(); }
    for (const a of airportList) { delete a.windsock; delete a.windsocks; delete a.towerPos; }
  };
  return { group, updateLights, parked, dispose };
}
