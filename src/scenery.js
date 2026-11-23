// Streamed real-world scenery from OpenStreetMap data: motorway / arterial ribbons with US lane markings,
// bridges (piers, barriers, the Golden Gate towers and cables), residential streets with sidewalks,
// procedurally placed houses / shops along those streets, street trees and street lights, plus the
// real high-rises (OSM heights) of San Francisco, Oakland and San Jose.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { heightAt, townAt, waterFrac, pavedAt, roadsInBox, roadNear, ROADS, TALL, STREET_TILE, streetTile, bldTile, forestAt, ll2w, w2ll, pointInPoly, inWorld } from './geo.js';
import { windowShader, gableGeometry, lightMaterial, makePoints } from './world.js';
import { extrudeFootprint, buildingMaterials, wallGeo, roofGeo } from './airport3d.js';
import { mulberry } from './noise.js';

const ROAD_TILE = 4000, CELL = 1000;
const TEXV = 24; // metres of road per texture repeat

// ---------------------------------------------------------------- road textures (canvas, US markings)
const texCache = new Map();
function roadTexture(kind, lanes, oneway, w, sidewalk = 0) {
  const key = [kind, lanes, oneway, Math.round(w * 2), sidewalk].join('|'); if (texCache.has(key)) return texCache.get(key);
  const W = 256, H = 512, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const total = w + sidewalk * 2, px = W / total; const X = (m) => (m + sidewalk) * px;
  // asphalt with grain
  g.fillStyle = kind === 'hwy' ? '#47484b' : '#4d4e50'; g.fillRect(0, 0, W, H);
  const img = g.getImageData(0, 0, W, H); const d = img.data; const r = mulberry(lanes * 31 + w * 7);
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 22; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  // tyre polish in each lane
  const lw = kind === 'street' ? w / 2 : Math.min(3.7, w / lanes);
  if (sidewalk) { // concrete sidewalks + kerbs
    g.fillStyle = '#b9b5ad'; g.fillRect(0, 0, X(0) - 1, H); g.fillRect(X(w) + 1, 0, W - X(w), H);
    g.fillStyle = '#8f8b84'; for (let y = 0; y < H; y += H / 16) { g.fillRect(0, y, X(0), 1); g.fillRect(X(w), y, W - X(w), 1); }
    g.fillStyle = '#d6d2ca'; g.fillRect(X(0) - 2, 0, 2, H); g.fillRect(X(w), 0, 2, H);
  }
  const solid = (m, col, wd = 0.15) => { g.fillStyle = col; g.fillRect(X(m) - wd * px / 2, 0, Math.max(1, wd * px), H); };
  const dash = (m, col, wd = 0.12) => { g.fillStyle = col; const dl = 3 / TEXV * H, gap = 12 / TEXV * H; for (let y = 0; y < H; y += gap) g.fillRect(X(m) - wd * px / 2, y, Math.max(1, wd * px), dl); };
  const Y = '#e2b53a', Wt = '#e8e8e4';
  if (kind === 'street') {
    if (lanes >= 2 && w >= 8.5) { solid(w / 2 - 0.12, Y, 0.12); solid(w / 2 + 0.12, Y, 0.12); }
  } else if (kind === 'link') {
    solid(0.4, Y); solid(w - 0.5, Wt);
  } else if (oneway) {
    const sh0 = kind === 'hwy' ? 1.2 : 0.4, used = lanes * lw; const sh1 = Math.max(0.4, w - used - sh0);
    solid(sh0, Y); solid(w - sh1, Wt);
    for (let k = 1; k < lanes; k++) dash(sh0 + k * lw, Wt);
  } else {
    const per = Math.max(1, Math.floor(lanes / 2)); const lwd = Math.min(3.6, (w - 1) / (per * 2));
    solid(w / 2 - 0.15, Y, 0.12); solid(w / 2 + 0.15, Y, 0.12);
    for (let k = 1; k < per; k++) { dash(w / 2 - k * lwd, Wt); dash(w / 2 + k * lwd, Wt); }
    solid(Math.max(0.3, w / 2 - per * lwd), Wt); solid(Math.min(w - 0.3, w / 2 + per * lwd), Wt);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  texCache.set(key, t); return t;
}
const matCache = new Map();
function roadMaterial(kind, lanes, oneway, w, sidewalk) {
  const t = roadTexture(kind, lanes, oneway, w, sidewalk); let m = matCache.get(t.uuid);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.92, metalness: 0 });
    // polygonOffset is ignored with the logarithmic depth buffer: pull the ribbon towards the camera along
    // the view ray instead (more at grazing angles and distance) so it never sinks into the terrain mesh
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
  { float dd = length(mvPosition.xyz); vec3 nV = normalize(normalMatrix * vec3(0.,1.,0.));
    float graze = 1.0 - abs(dot(nV, -mvPosition.xyz / dd));
    float bias = (0.12 + dd * 0.0022) * (0.15 + 0.85 * graze);
    mvPosition.xyz *= max(0.0, (dd - bias) / dd); gl_Position = projectionMatrix * mvPosition; }`);
    };
    m.customProgramCacheKey = () => 'roadbias';
    matCache.set(t.uuid, m);
  }
  return m;
}

// ---------------------------------------------------------------- ribbon builder
// pts: [[x,z,yDeck|null], ...]; returns arrays appended into out {P,U,I}
function ribbon(pts, half, out, lift, step = 20) {
  if (pts.length < 2) return;
  // subdivide
  const S = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) { const t = k / n; S.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] != null ? a[2] + (b[2] - a[2]) * t : null]); }
  }
  S.push(pts[pts.length - 1]);
  const base = out.P.length / 3; let v = out.v0 || 0;
  for (let i = 0; i < S.length; i++) {
    const p = S[i], a = S[Math.max(0, i - 1)], b = S[Math.min(S.length - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const nx = -dz, nz = dx;
    if (i) v += Math.hypot(p[0] - S[i - 1][0], p[1] - S[i - 1][1]);
    for (const s of [-1, 1]) {
      const x = p[0] + nx * half * s, z = p[1] + nz * half * s;
      const y = p[2] != null ? p[2] : Math.max(heightAt(x, z), 0.6) + lift;
      out.P.push(x, y, z); out.U.push(s < 0 ? 0 : 1, v / TEXV);
    }
    if (i) { const k = base + i * 2; out.I.push(k - 2, k - 1, k, k - 1, k + 1, k); }
  }
}
function ribbonGeo(o) {
  if (!o.P.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(o.P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(o.U, 2));
  g.setIndex(o.I); g.computeVertexNormals();
  // terrain roads face up; keep normals mostly vertical for consistent lighting
  const n = g.attributes.normal; for (let i = 0; i < n.count; i++) { const y = n.getY(i); if (y < 0) n.setXYZ(i, -n.getX(i), -y, -n.getZ(i)); }
  g.computeBoundingSphere(); return g;
}

// ---------------------------------------------------------------- shared meshes
function treeGeos() {
  const trunk = new THREE.CylinderGeometry(0.12, 0.18, 1, 6).translate(0, 0.5, 0);
  const crown = new THREE.IcosahedronGeometry(0.5, 1); crown.translate(0, 0.5, 0);
  const pos = crown.attributes.position; const r = mulberry(7);
  for (let i = 0; i < pos.count; i++) { const k = 0.85 + r() * 0.3; pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * (0.9 + r() * 0.15), pos.getZ(i) * k); }
  crown.computeVertexNormals();
  return { trunk, crown };
}
const HOUSE_COL = ['#efe6d6', '#e9dcc4', '#d8cdb8', '#f3efe8', '#cdbfa7', '#e6d3b3', '#c9b9a0', '#dfe2dc', '#d1c2a9', '#f0e2c8', '#bfae95', '#e8e3d9'];
const SF_COL = ['#f1e9d8', '#e8d6b5', '#d7e2e4', '#f2d9c8', '#e3e8d5', '#f4efe6', '#d9cbe0', '#cfdbe8', '#f0dfa8', '#e6c9b5', '#ffffff', '#d5d5cf'];
const ROOF_COL = ['#5b5450', '#6b5e55', '#4f4b49', '#7a5040', '#8a5a44', '#5f605e', '#704c3c', '#3f3f42'];
const SHOP_COL = ['#d9d4ca', '#c8c2b8', '#e6e1d8', '#bdb4a6', '#d1cbc0', '#a8a39b', '#ccc5b9', '#e0d8c8'];

export class Scenery {
  constructor(scene, opts = {}) {
    this.scene = scene; this.light = !!opts.light; this.ground = opts.ground || null; this.group = new THREE.Group(); this.group.name = 'scenery'; scene.add(this.group);
    this.roadR = this.light ? 6500 : 12000; this.cellR = this.light ? 1900 : 3200;
    this.roadTiles = new Map(); this.cells = new Map(); this.streetTiles = new Map(); this.bldTiles = new Map(); this.night = 0;
    this.quality = opts.quality ?? 1; this.busy = false;
  }
  async init() {
    this.M = await buildingMaterials().catch(() => null);
    const plain = (c, rough = 0.9) => new THREE.MeshStandardMaterial({ color: c, roughness: rough });
    this.houseMat = windowShader(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, map: this.M?.tex?.plaster?.diff || null }), 3.4);
    this.shopMat = windowShader(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0.05, map: this.M?.tex?.conc?.diff || null }), 4.2);
    this.roofMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, map: this.M?.roofTile?.map || null });
    this.flatRoofMat = plain(0x8e8b86, 0.95);
    this.trunkMat = plain(0x4a3a2c); this.crownMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
    this.concrete = plain(0xb3b0aa, 0.95); this.concrete.side = THREE.DoubleSide; this.orange = new THREE.MeshStandardMaterial({ color: 0xc0362c, roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide });
    this.boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0); this.gableGeo = gableGeometry(); this.tree = treeGeos();
    this.lightMat = lightMaterial();
    // TALL footprints index (for keeping procedural houses out of real buildings)
    this.tallBins = new Map();
    TALL.forEach((t, i) => { let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (const q of t.p) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); } t.bb = [x0, z0, x1, z1];
      for (let bx = Math.floor(x0 / 250); bx <= Math.floor(x1 / 250); bx++) for (let bz = Math.floor(z0 / 250); bz <= Math.floor(z1 / 250); bz++) { const k = bx * 10000 + bz; let l = this.tallBins.get(k); if (!l) this.tallBins.set(k, (l = [])); l.push(i); } });
    this.buildTall();
    this.buildGoldenGate();
  }
  inTall(x, z, pad = 6) {
    const l = this.tallBins.get(Math.floor(x / 250) * 10000 + Math.floor(z / 250)); if (!l) return false;
    for (const i of l) { const t = TALL[i], b = t.bb; if (x < b[0] - pad || x > b[2] + pad || z < b[1] - pad || z > b[3] + pad) continue; if (pointInPoly(x, z, t.p)) return true; if (pad && (pointInPoly(x + pad, z, t.p) || pointInPoly(x - pad, z, t.p) || pointInPoly(x, z + pad, t.p) || pointInPoly(x, z - pad, t.p))) return true; }
    return false;
  }
  // ---------------- real high-rises (OSM building heights) ----------------
  buildTall() {
    if (!TALL.length || !this.M) return;
    const sets = { glass: [{ P: [], N: [], F: [] }, { P: [], N: [], U: [] }], office: [{ P: [], N: [], F: [] }, { P: [], N: [], U: [] }], brick: [{ P: [], N: [], F: [] }, { P: [], N: [], U: [] }] };
    for (const t of TALL) {
      let y0 = 1e9; for (const q of t.p) y0 = Math.min(y0, heightAt(q[0], q[1]));
      if (!Number.isFinite(y0)) continue;
      const base = y0 - 1; const top = y0 + t.h, bot = t.mh ? y0 + t.mh : base;
      const style = t.h > 70 ? 'glass' : t.h > 30 ? 'office' : 'brick';
      const s = sets[style]; extrudeFootprint(t.p, bot, top, s[0], s[1]);
    }
    for (const k of Object.keys(sets)) {
      const wg = wallGeo(sets[k][0]), rg = roofGeo(sets[k][1]);
      if (wg) { const m = new THREE.Mesh(wg, this.M[k]); m.castShadow = m.receiveShadow = true; this.group.add(m); }
      if (rg) { const m = new THREE.Mesh(rg, this.M.concrete); m.receiveShadow = true; this.group.add(m); }
    }
    this.nightMats = [this.M.glass, this.M.office, this.M.brick];
  }
  // ---------------- Golden Gate Bridge: Art-Deco towers (227 m), main cables & suspenders, International Orange ----------------
  buildGoldenGate() {
    const S = ll2w(37.81605, -122.47807), N = ll2w(37.82735, -122.47901);
    if (!inWorld(S.x, S.z) || !inWorld(N.x, N.z)) return;
    const dx = N.x - S.x, dz = N.z - S.z, L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L, px = -uz, pz = ux;
    const deckAt = (x, z) => { const n = roadNear(x, z, 40); if (n && n.road.ys) return n.road.ys[n.i] + (n.road.ys[n.i + 1] - n.road.ys[n.i]) * n.t; return 67; };
    const G = [], geoAt = (g, x, y, z, yaw) => { const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z); G.push(g.clone().applyMatrix4(m)); };
    const yaw = Math.atan2(-pz, px); // local X across the bridge, Z along
    const TOP = 227, half = 14.5;
    const towers = [S, N];
    for (const T of towers) {
      for (const s of [-1, 1]) { // legs tapering, stepped like the real towers
        const steps = [[0, 10, 16], [60, 9, 14], [120, 8, 12.4], [170, 7.2, 11], [210, 6.6, 10]];
        steps.forEach(([y, wx, wz], i) => { const y1 = i < steps.length - 1 ? steps[i + 1][0] : TOP; const g = new THREE.BoxGeometry(wx, y1 - y, wz).translate(0, (y + y1) / 2, 0); geoAt(g, T.x + px * half * s, -5, T.z + pz * half * s, yaw); });
      }
      for (const y of [deckAtY(this, T) + 10, 120, 170, 212]) { const g = new THREE.BoxGeometry(half * 2, 8, 5).translate(0, y, 0); geoAt(g, T.x, -5, T.z, yaw); }
      const pier = new THREE.BoxGeometry(46, 25, 30).translate(0, -12, 0); geoAt(pier, T.x, 0, T.z, yaw);
    }
    function deckAtY(self, T) { return deckAt(T.x, T.z); }
    const towersMesh = new THREE.Mesh(mergeGeometries(G.map((g) => g.index ? g.toNonIndexed() : g)), this.orange); towersMesh.castShadow = towersMesh.receiveShadow = true; this.group.add(towersMesh);
    // cables: main span parabola + side spans to the anchorages
    const anchorS = { x: S.x - ux * 343, z: S.z - uz * 343 }, anchorN = { x: N.x + ux * 343, z: N.z + uz * 343 };
    const C = [], sus = [];
    for (const s of [-1, 1]) {
      const pts = [];
      const seg = (A, B, yA, yB, sag, n) => { for (let i = 0; i <= n; i++) { const t = i / n; const x = A.x + (B.x - A.x) * t, z = A.z + (B.z - A.z) * t; const y = yA + (yB - yA) * t - sag * 4 * t * (1 - t); pts.push(new THREE.Vector3(x + px * half * s, y - 5, z + pz * half * s)); } };
      const dS = deckAt(anchorS.x, anchorS.z), dN = deckAt(anchorN.x, anchorN.z);
      seg(anchorS, S, dS + 2, TOP, 20, 20); pts.pop(); seg(S, N, TOP, TOP, TOP - 5 - (deckAt((S.x + N.x) / 2, (S.z + N.z) / 2) + 2), 80); pts.pop(); seg(N, anchorN, TOP, dN + 2, 20, 20);
      C.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 240, 0.46, 6));
      for (let i = 1; i < pts.length - 1; i++) { const p = pts[i]; const d = deckAt(p.x - px * half * s, p.z - pz * half * s); if (p.y - d > 3) sus.push(p.x, p.y, p.z, p.x, d + 1, p.z); }
    }
    const cables = new THREE.Mesh(mergeGeometries(C), this.orange); cables.castShadow = true; this.group.add(cables);
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sus, 3));
    this.group.add(new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0xa8402e })));
    // aircraft warning lights on the tower tops
    this.ggLights = makePoints(towers.map((T) => ({ p: [T.x, TOP - 3, T.z], c: [1, 0.15, 0.1], s: 5 })), this.lightMat); this.group.add(this.ggLights);
  }

  // ---------------- streaming ----------------
  streetsNear(x, z, R) {
    const out = [];
    for (const c of this.cells.values()) { if (!c.ways || Math.abs(c.cx - x) > R + CELL || Math.abs(c.cz - z) > R + CELL) continue; for (const w of c.ways) out.push(w); }
    return out;
  }
  setNight(n) {
    this.night = n; this.lightMat.uniforms.uNight.value = n;
    for (const m of [this.houseMat, this.shopMat, ...(this.nightMats || [])]) if (m?.userData?.uNight) m.userData.uNight.value = n;
  }
  update(cam) {
    if (this.busy) return;
    // nothing to stream: skip the tile scans until the camera has moved (or once a second as a safety net)
    const mv = this._lu ? Math.hypot(cam.x - this._lu.x, cam.z - this._lu.z) : 1e9;
    if (mv < 40 && !this._dirty && (this._skip = (this._skip || 0) + 1) < 60) return;
    this._skip = 0; this._lu = { x: cam.x, z: cam.z };
    const t0 = performance.now();
    // major roads
    const RT = ROAD_TILE, rr = this.roadR;
    let best = null, bd = 1e18;
    for (let tx = Math.floor((cam.x - rr) / RT); tx <= Math.floor((cam.x + rr) / RT); tx++) for (let tz = Math.floor((cam.z - rr) / RT); tz <= Math.floor((cam.z + rr) / RT); tz++) {
      const k = tx + ',' + tz; if (this.roadTiles.has(k)) continue;
      const d = ((tx + 0.5) * RT - cam.x) ** 2 + ((tz + 0.5) * RT - cam.z) ** 2; if (d > (rr + RT * 0.7) ** 2) continue;
      if (d < bd) { bd = d; best = [tx, tz, k]; }
    }
    if (best) this.roadTiles.set(best[2], this.buildRoadTile(best[0], best[1]));
    for (const [k, t] of this.roadTiles) if ((t.cx - cam.x) ** 2 + (t.cz - cam.z) ** 2 > (rr + RT * 1.6) ** 2) { this.free(t.obj); this.roadTiles.delete(k); }
    // street cells (houses, trees, lights)
    const cr = this.cellR * (0.6 + 0.4 * this.quality);
    const want = [];
    for (let cx = Math.floor((cam.x - cr) / CELL); cx <= Math.floor((cam.x + cr) / CELL); cx++) for (let cz = Math.floor((cam.z - cr) / CELL); cz <= Math.floor((cam.z + cr) / CELL); cz++) {
      const k = cx + ',' + cz; if (this.cells.has(k)) continue;
      const d = ((cx + 0.5) * CELL - cam.x) ** 2 + ((cz + 0.5) * CELL - cam.z) ** 2; if (d > (cr + CELL * 0.7) ** 2) continue;
      want.push([d, cx, cz, k]);
    }
    want.sort((a, b) => a[0] - b[0]);
    const t1 = performance.now(); let built = 0;
    for (const [, cx, cz, k] of want) {
      if (built > 0 && performance.now() - t1 > 8) break;
      const tx = Math.floor(cx * CELL / STREET_TILE), tz = Math.floor(cz * CELL / STREET_TILE), tk = tx + '_' + tz;
      const st = this.streetTiles.get(tk);
      if (!st) { const e = { ways: null }; this.streetTiles.set(tk, e); streetTile(tx, tz).then((w) => { e.ways = w || []; }, () => { e.ways = []; }); continue; }
      let bt = this.bldTiles.get(k);
      if (!bt) { bt = { d: null }; this.bldTiles.set(k, bt); bldTile(cx, cz).then((d) => { bt.d = d; }); continue; }
      if (!st.ways || !bt.d) continue;
      this.cells.set(k, this.buildCell(cx, cz, st.ways, bt.d)); this.bldTiles.delete(k); built++;
    }
    for (const [k, c] of this.cells) if ((c.cx - cam.x) ** 2 + (c.cz - cam.z) ** 2 > (cr + CELL * 1.8) ** 2) { this.free(c.obj); this.cells.delete(k); }
    this._dirty = !!best || want.length > built;
  }
  free(obj) {
    if (!obj) return; this.group.remove(obj);
    obj.traverse((o) => { if (o.geometry && o.geometry !== this.boxGeo && o.geometry !== this.gableGeo && o.geometry !== this.tree.trunk && o.geometry !== this.tree.crown) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
  }

  // ---------------- major roads tile ----------------
  buildRoadTile(tx, tz) {
    const x0 = tx * ROAD_TILE, z0 = tz * ROAD_TILE, x1 = x0 + ROAD_TILE, z1 = z0 + ROAD_TILE;
    const obj = new THREE.Group(); const groups = new Map(); const deck = { P: [], N: [], I: [] }; const piers = []; const barrier = { P: [], U: [], I: [] }, barrierGG = { P: [], U: [], I: [] };
    const inT = (x, z) => x >= x0 && x < x1 && z >= z0 && z < z1;
    for (const ri of roadsInBox(x0, z0, x1, z1)) {
      const r = ROADS[ri]; const n = r.pts.length / 2;
      const kind = r.cls === 'hwy' ? 'hwy' : r.cls === 'link' ? 'link' : 'road';
      const lanes = Math.min(6, r.lanes), key = [kind, lanes, r.oneway, Math.round(r.w * 2)].join('|');
      let G = groups.get(key); if (!G) groups.set(key, (G = { kind, lanes, oneway: r.oneway, w: r.w, o: { P: [], U: [], I: [] } }));
      const gg = /Golden Gate Bridge/i.test(r.name);
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          ribbon(run, r.w / 2, G.o, kind === 'hwy' ? 0.38 : 0.33, 20);
          if (r.ys) this.bridgeParts(run, r.w / 2, deck, gg ? barrierGG : barrier, piers);
        }
        run = [];
      };
      for (let i = 0; i < n - 1; i++) {
        const mx = (r.pts[i * 2] + r.pts[i * 2 + 2]) / 2, mz = (r.pts[i * 2 + 1] + r.pts[i * 2 + 3]) / 2;
        if (inT(mx, mz)) {
          if (!run.length) run.push([r.pts[i * 2], r.pts[i * 2 + 1], r.ys ? r.ys[i] : null]);
          run.push([r.pts[i * 2 + 2], r.pts[i * 2 + 3], r.ys ? r.ys[i + 1] : null]);
        } else flush();
      }
      flush();
    }
    for (const G of groups.values()) { const g = ribbonGeo(G.o); if (!g) continue; const m = new THREE.Mesh(g, roadMaterial(G.kind, G.lanes, G.oneway, G.w, 0)); m.receiveShadow = true; obj.add(m); }
    if (deck.P.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(deck.P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(deck.N, 3)); g.setIndex(deck.I); const m = new THREE.Mesh(g, this.concrete); m.castShadow = m.receiveShadow = true; obj.add(m); }
    for (const [b, mat] of [[barrier, this.concrete], [barrierGG, this.orange]]) { const g = ribbonGeoWall(b); if (g) { const m = new THREE.Mesh(g, mat); m.castShadow = true; obj.add(m); } }
    if (piers.length) {
      const im = new THREE.InstancedMesh(this.boxGeo, this.concrete, piers.length); const M4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
      piers.forEach((pr, i) => { q.setFromAxisAngle(Y, pr.yaw); p.set(pr.x, pr.y0, pr.z); s.set(pr.w, pr.h, 2.4); M4.compose(p, q, s); im.setMatrixAt(i, M4); });
      im.castShadow = im.receiveShadow = true; obj.add(im);
    }
    this.group.add(obj);
    return { obj, cx: x0 + ROAD_TILE / 2, cz: z0 + ROAD_TILE / 2 };
  }
  // deck slab sides + underside, barriers and piers for elevated roads
  bridgeParts(run, half, deck, bar, piers) {
    const S = [];
    for (let i = 0; i < run.length - 1; i++) { const a = run[i], b = run[i + 1]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const n = Math.max(1, Math.ceil(L / 20)); for (let k = 0; k < n; k++) { const t = k / n; S.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); } }
    S.push(run[run.length - 1]);
    const T = 1.8; let acc = 0;
    for (let i = 0; i < S.length; i++) {
      const p = S[i], a = S[Math.max(0, i - 1)], b = S[Math.min(S.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L; const nx = -dz, nz = dx;
      const ground = Math.max(heightAt(p[0], p[1]), -14);
      const elevated = p[2] - ground > 3.5;
      // underside quad strip (4 verts per station: L-top, L-bottom, R-bottom, R-top)
      const base = deck.P.length / 3;
      const hw = half + 0.4;
      deck.P.push(p[0] - nx * hw, p[2] + 0.05, p[1] - nz * hw, p[0] - nx * hw, p[2] - T, p[1] - nz * hw, p[0] + nx * hw, p[2] - T, p[1] + nz * hw, p[0] + nx * hw, p[2] + 0.05, p[1] + nz * hw);
      deck.N.push(-nx, 0, -nz, -nx, -0.3, -nz, nx, -0.3, nz, nx, 0, nz);
      if (i) { const o = base - 4; deck.I.push(o, o + 1, base, base, o + 1, base + 1, o + 1, o + 2, base + 1, base + 1, o + 2, base + 2, o + 2, o + 3, base + 2, base + 2, o + 3, base + 3); }
      // barriers (1.1 m jersey walls)
      for (const s of [-1, 1]) { bar.P.push(p[0] + nx * hw * s, p[2], p[1] + nz * hw * s, p[0] + nx * hw * s, p[2] + 1.1, p[1] + nz * hw * s); }
      if (i) { const k = bar.P.length / 3 - 4; for (const o of [0, 2]) bar.I.push(k - 4 + o, k + o, k - 3 + o, k - 3 + o, k + o, k + 1 + o); }
      if (i) acc += Math.hypot(p[0] - S[i - 1][0], p[1] - S[i - 1][1]);
      if (elevated && acc > 45) { acc = 0; piers.push({ x: p[0], z: p[1], y0: ground - 2, h: p[2] - T - ground + 2, w: Math.max(3, half * 1.2), yaw: Math.atan2(-nz, nx) }); }
    }
  }

  // ---------------- 1 km street cell: streets, houses, shops, trees, street lights ----------------
  buildCell(cx, cz, tileWays, bld = { rects: [], polys: [], trees: [] }) {
    const x0 = cx * CELL, z0 = cz * CELL, x1 = x0 + CELL, z1 = z0 + CELL, M = 40;
    const obj = new THREE.Group(); const rnd = mulberry((cx * 73856093) ^ (cz * 19349663));
    // ways of this cell (segments by midpoint) and an occupancy raster (3 m) of all pavement nearby
    const R = 3, NX = Math.ceil((CELL + 2 * M) / R); const occ = new Uint8Array(NX * NX);
    const mark = (ax, az, bx, bz, half) => {
      const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 2));
      for (let k = 0; k <= n; k++) { const x = ax + (bx - ax) * k / n, z = az + (bz - az) * k / n; const ix0 = Math.floor((x - half - x0 + M) / R), ix1 = Math.floor((x + half - x0 + M) / R), iz0 = Math.floor((z - half - z0 + M) / R), iz1 = Math.floor((z + half - z0 + M) / R);
        for (let iz = Math.max(0, iz0); iz <= Math.min(NX - 1, iz1); iz++) for (let ix = Math.max(0, ix0); ix <= Math.min(NX - 1, ix1); ix++) occ[iz * NX + ix] = 1; }
    };
    const free = (x, z) => { const ix = Math.floor((x - x0 + M) / R), iz = Math.floor((z - z0 + M) / R); if (ix < 0 || iz < 0 || ix >= NX || iz >= NX) return false; return !occ[iz * NX + ix]; };
    const fill = (x, z, hw, hd, c, s) => { for (let u = -hw; u <= hw; u += R * 0.8) for (let v = -hd; v <= hd; v += R * 0.8) { const X = x + c * u - s * v, Z = z + s * u + c * v; const ix = Math.floor((X - x0 + M) / R), iz = Math.floor((Z - z0 + M) / R); if (ix >= 0 && iz >= 0 && ix < NX && iz < NX) occ[iz * NX + ix] = 1; } };
    const rectFree = (x, z, hw, hd, c, s) => { for (let u = -hw; u <= hw; u += Math.max(2, hw / 2)) for (let v = -hd; v <= hd; v += Math.max(2, hd / 2)) { const X = x + c * u - s * v, Z = z + s * u + c * v; if (!free(X, Z)) return false; } return true; };
    const near = (r, i) => { const ax = r.pts[i * 2], az = r.pts[i * 2 + 1]; return ax > x0 - M - 200 && ax < x1 + M + 200 && az > z0 - M - 200 && az < z1 + M + 200; };
    const cellWays = [];
    for (const r of tileWays) {
      const n = r.pts.length / 2; let any = false, run = [];
      for (let i = 0; i < n - 1; i++) {
        if (near(r, i)) mark(r.pts[i * 2], r.pts[i * 2 + 1], r.pts[i * 2 + 2], r.pts[i * 2 + 3], r.w / 2 + 2.6);
        const mx = (r.pts[i * 2] + r.pts[i * 2 + 2]) / 2, mz = (r.pts[i * 2 + 1] + r.pts[i * 2 + 3]) / 2;
        if (mx >= x0 && mx < x1 && mz >= z0 && mz < z1) { if (!run.length) run.push(i); run.push(i + 1); any = true; }
        else if (run.length) { cellWays.push({ r, idx: run }); run = []; }
      }
      if (run.length) cellWays.push({ r, idx: run });
    }
    for (const ri of roadsInBox(x0 - M, z0 - M, x1 + M, z1 + M)) { const r = ROADS[ri]; for (let i = 0; i < r.pts.length / 2 - 1; i++) if (near(r, i)) mark(r.pts[i * 2], r.pts[i * 2 + 1], r.pts[i * 2 + 2], r.pts[i * 2 + 3], r.w / 2 + 3); }
    // street ribbons
    const groups = new Map();
    const lights = []; const trees = []; const houses = []; const shops = [];
    const TOWNY = (x, z) => townAt(x, z);
    if (!this.ground) for (const { r, idx } of cellWays) {
      const sw = TOWNY(r.pts[idx[0] * 2], r.pts[idx[0] * 2 + 1]) > 0.25 ? 2.2 : 0;
      const key = [r.kind === 'tertiary' ? 2 : 1, r.w, sw].join('|');
      let G = groups.get(key); if (!G) groups.set(key, (G = { lanes: r.kind === 'tertiary' ? 2 : 1, w: r.w, sw, o: { P: [], U: [], I: [] } }));
      const run = idx.map((i) => [r.pts[i * 2], r.pts[i * 2 + 1], null]);
      ribbon(run, r.w / 2 + sw, G.o, 0.28, 25);
    }
    for (const G of groups.values()) { const g = ribbonGeo(G.o); if (!g) continue; const m = new THREE.Mesh(g, roadMaterial('street', G.lanes, false, G.w, G.sw)); m.receiveShadow = true; obj.add(m); }
    // street lights along the real streets (towns only)
    for (const { r, idx } of cellWays) {
      let acc = 0;
      for (let k = 0; k < idx.length - 1; k++) {
        const i = idx[k]; const ax = r.pts[i * 2], az = r.pts[i * 2 + 1], bx = r.pts[i * 2 + 2], bz = r.pts[i * 2 + 3];
        const L = Math.hypot(bx - ax, bz - az); if (L < 1) continue; const nx = -(bz - az) / L, nz = (bx - ax) / L;
        for (let t = (40 - acc) % 40; t < L; t += 40) { const x = ax + (bx - ax) * t / L + nx * (r.w / 2 + 0.6), z = az + (bz - az) * t / L + nz * (r.w / 2 + 0.6); if (TOWNY(x, z) > 0.25) lights.push({ p: [x, heightAt(x, z) + 8.5, z], c: [1, 0.78, 0.45], s: 1.6 }); }
        acc = (acc + L) % 40;
      }
    }
    // ---- real buildings from OpenStreetMap footprints (data/bld, baked by tools/bake_buildings.py)
    const inCell = (x, z) => x >= x0 && x < x1 && z >= z0 && z < z1;
    const ground = (pts) => { let lo = 1e9, hi = -1e9; for (const [x, z] of pts) { const h = heightAt(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); } return [lo, hi]; };
    for (const b of bld.rects) {
      if (!inCell(b.x, b.z) || this.inTall(b.x, b.z, 0)) continue;
      const c = Math.cos(b.yaw), sn = Math.sin(b.yaw), hw = b.w / 2, hd = b.d / 2;
      const [lo, hi] = ground([[b.x + c * hw - sn * hd, b.z + sn * hw + c * hd], [b.x - c * hw - sn * hd, b.z - sn * hw + c * hd], [b.x + c * hw + sn * hd, b.z + sn * hw - c * hd], [b.x - c * hw + sn * hd, b.z - sn * hw - c * hd], [b.x, b.z]]);
      fill(b.x, b.z, hw + 1, hd + 1, c, sn);
      const k = ((b.x * 7.31 + b.z * 3.17) % 1 + 1) % 1, H = b.h + (hi - lo) + 0.5, yaw = -b.yaw;
      const area = b.w * b.d, t = b.type === 7 ? (area > 400 ? 3 : 0) : b.type;
      if (t === 0 || t === 6) houses.push([b.x, lo - 0.5, b.z, b.w, b.d, H, yaw, k, false, b.roof > 0 && t === 0]);
      else if (t === 1 || t === 2) houses.push([b.x, lo - 0.5, b.z, b.w, b.d, H, yaw, k, true, false]);
      else shops.push([b.x, lo - 0.5, b.z, b.w, b.d, H, yaw, k, t]);
    }
    const PW = { house: { P: [], N: [], F: [] }, shop: { P: [], N: [], F: [] }, roof: { P: [], N: [], U: [] } };
    let polyN = 0;
    for (const b of bld.polys) {
      let mx = 0, mz = 0; for (const q of b.p) { mx += q[0]; mz += q[1]; } mx /= b.p.length; mz /= b.p.length;
      if (!inCell(mx, mz) || this.inTall(mx, mz, 0)) continue;
      const [lo, hi] = ground(b.p);
      const res = b.type <= 2 || b.type === 6;
      extrudeFootprint(b.p, lo - 0.5, lo + b.h + Math.min(hi - lo, 6), res ? PW.house : PW.shop, PW.roof);
      let bx0 = 1e9, bz0 = 1e9, bx1 = -1e9, bz1 = -1e9; for (const q of b.p) { bx0 = Math.min(bx0, q[0]); bx1 = Math.max(bx1, q[0]); bz0 = Math.min(bz0, q[1]); bz1 = Math.max(bz1, q[1]); }
      for (let z = bz0; z <= bz1; z += R) for (let x = bx0; x <= bx1; x += R) if (pointInPoly(x, z, b.p)) { const ix = Math.floor((x - x0 + M) / R), iz = Math.floor((z - z0 + M) / R); if (ix >= 0 && iz >= 0 && ix < NX && iz < NX) occ[iz * NX + ix] = 1; }
      polyN++;
    }
    if (this.M) {
      const wg = wallGeo(PW.house), sg = wallGeo(PW.shop), rg = roofGeo(PW.roof);
      if (wg) { const m = new THREE.Mesh(wg, this.M.house); m.castShadow = m.receiveShadow = true; obj.add(m); }
      if (sg) { const m = new THREE.Mesh(sg, this.M.office); m.castShadow = m.receiveShadow = true; obj.add(m); }
      if (rg) { const m = new THREE.Mesh(rg, this.flatRoofMat); m.receiveShadow = true; obj.add(m); }
    }
    // ---- trees: every OSM-mapped tree, plus canopy trees where ESA WorldCover maps tree cover inside town
    // the OSM ground overlay knows every driveway, pool, parking lot and sports field: keep trees off them
    const GR = this.ground, NOTREE = new Set([1, 4, 11, 12, 13, 14, 15, 22, 23, 26, 28]);
    const gfree = (x, z) => { if (!GR) return true; const g = GR.sample(x, z); return !g || (g.cov < 0.2 && !NOTREE.has(g.cls)); };
    for (const t of bld.trees) if (inCell(t.x, t.z) && free(t.x, t.z) && gfree(t.x, t.z)) trees.push([t.x, t.z, Math.max(5, t.h), ((t.x * 3.7 + t.z) % 1 + 1) % 1]);
    const STEP = 11;
    for (let z = z0 + STEP / 2; z < z1 && trees.length < 2600; z += STEP) for (let x = x0 + STEP / 2; x < x1; x += STEP) {
      const jx = x + (rnd() - 0.5) * STEP * 0.8, jz = z + (rnd() - 0.5) * STEP * 0.8, rr = rnd();
      if (TOWNY(jx, jz) < 0.2) continue;
      const f = forestAt(jx, jz, 0, 0); if (rr > f * 0.9) continue;
      if (!free(jx, jz) || pavedAt(jx, jz) || !gfree(jx, jz)) continue;
      trees.push([jx, jz, 6 + rnd() * 9, rnd()]);
    }
    // ---- instanced meshes
    const M4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    const mkInst = (geo, mat, list, fn, cast = true) => {
      if (!list.length) return null; const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((e, i) => { fn(e, i, im); im.setMatrixAt(i, M4); }); im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = cast; im.receiveShadow = true; im.computeBoundingSphere(); obj.add(im); return im;
    };
    mkInst(this.boxGeo, this.houseMat, houses, (h, i, im) => { q.setFromAxisAngle(Y, h[6]); p.set(h[0], h[1], h[2]); s.set(h[3], h[5], h[4]); M4.compose(p, q, s); im.setColorAt(i, col.set((h[8] ? SF_COL : HOUSE_COL)[Math.floor(h[7] * 12) % 12])); });
    const gable = houses.filter((h) => h[9]);
    mkInst(this.gableGeo, this.roofMat, gable, (h, i, im) => { q.setFromAxisAngle(Y, h[6] + (h[3] > h[4] ? Math.PI / 2 : 0)); p.set(h[0], h[1] + h[5], h[2]); const a = Math.min(h[3], h[4]), b = Math.max(h[3], h[4]); s.set(a * 1.02, Math.min(3.2, a * 0.3), b * 1.02); M4.compose(p, q, s); im.setColorAt(i, col.set(ROOF_COL[Math.floor(h[7] * 97) % ROOF_COL.length])); });
    const flat = [...houses.filter((h) => !h[9]), ...shops];
    mkInst(this.boxGeo, this.flatRoofMat, flat, (h, i) => { q.setFromAxisAngle(Y, h[6]); p.set(h[0], h[1] + h[5], h[2]); s.set(h[3] + 0.3, 0.5, h[4] + 0.3); M4.compose(p, q, s); }, false);
    mkInst(this.boxGeo, this.shopMat, shops, (h, i, im) => { q.setFromAxisAngle(Y, h[6]); p.set(h[0], h[1], h[2]); s.set(h[3], h[5], h[4]); M4.compose(p, q, s); im.setColorAt(i, col.set(h[8] === 4 ? '#c4c6c4' : SHOP_COL[Math.floor(h[7] * 8) % 8])); });
    // trees (trunk + crown)
    const tr = trees.map(([x, z, h, k]) => [x, heightAt(x, z) - 0.2, z, h, k]);
    mkInst(this.tree.trunk, this.trunkMat, tr, (t) => { p.set(t[0], t[1], t[2]); q.identity(); s.set(1 + t[3] * 0.04, t[3] * 0.45, 1 + t[3] * 0.04); M4.compose(p, q, s); }, false);
    mkInst(this.tree.crown, this.crownMat, tr, (t, i, im) => { p.set(t[0], t[1] + t[3] * 0.3, t[2]); q.setFromAxisAngle(Y, t[4] * 6.28); const w = t[3] * (0.55 + t[4] * 0.25); s.set(w, t[3] * 0.75, w); M4.compose(p, q, s); im.setColorAt(i, col.setRGB(0.22 + t[4] * 0.12, 0.34 + t[4] * 0.12, 0.16 + t[4] * 0.05)); });
    if (lights.length) obj.add(makePoints(lights, this.lightMat));
    this.group.add(obj);
    return { obj, cx: x0 + CELL / 2, cz: z0 + CELL / 2, ways: cellWays.map((c) => c.r).filter((v, i, a) => a.indexOf(v) === i), houses: houses.length, shops: shops.length + polyN, trees: trees.length };
  }
  stats() { let h = 0, s = 0, t = 0; for (const c of this.cells.values()) { h += c.houses; s += c.shops; t += c.trees; } return { roadTiles: this.roadTiles.size, cells: this.cells.size, houses: h, shops: s, trees: t }; }
}
function ribbonGeoWall(o) {
  if (!o.P.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(o.P, 3)); g.setIndex(o.I); g.computeVertexNormals(); return g;
}
