// Ground overlay: real OSM land use (fields, vineyards, orchards, lawns, parks, golf, parking, pools...)
// and every road / street / driveway / path rasterised around the camera at two resolutions by a worker.
// The terrain, grass-blade and crop shaders sample the same textures so everything lines up.
import * as THREE from 'three';
import { AIRPORTS } from './geo.js';

export const GC = {
  farmland: 1, meadow: 2, orchard: 3, vineyard: 4, farmyard: 5, residential: 6, commercial: 7, industrial: 8, park: 9, golf: 10,
  fairway: 11, green: 12, sand: 13, pitch: 14, runtrack: 15, cemetery: 16, grounds: 17, wood: 18, scrub: 19, wetland: 20, bare: 21,
  parking: 22, pool: 23, nursery: 24, allotments: 25, rail: 26, playground: 27, water: 28, grass: 29,
};

// season dryness 0 (lush, wet winter / spring) .. 1 (golden dry late summer) for California hills
export function seasonDryness(d = new Date()) {
  const doy = (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 864e5;
  // green from ~Jan to Apr, browning May-June, fully golden Jul-Oct, greening after the first rains in Nov-Dec
  const k = [[0, 0.25], [30, 0.05], [100, 0.05], [140, 0.5], [175, 0.92], [290, 1.0], [325, 0.75], [366, 0.25]];
  for (let i = 1; i < k.length; i++) if (doy <= k[i][0]) { const t = (doy - k[i - 1][0]) / (k[i][0] - k[i - 1][0]); return k[i - 1][1] + (k[i][1] - k[i - 1][1]) * t; }
  return 0.3;
}

const LEVELS = [
  { N: 2048, res: 1, move: 256, maxAgl: 2600 },   // near: 1 m texels, ~2 km square
  { N: 2048, res: 8, move: 2048, maxAgl: Infinity }, // far: 8 m texels, ~16 km square
];

export const GROUND_GLSL = /* glsl */`
uniform sampler2D uGO0; uniform sampler2D uGO1; uniform vec4 uGOr0; uniform vec4 uGOr1; uniform float uGOon; uniform float uDry;
struct GS { int cls; int hsh; float ori; float cov; float mat; float w; };
vec4 goFetch(sampler2D t, vec4 r, vec2 p){ ivec2 ij = clamp(ivec2(floor((p - r.xy) / r.z)), ivec2(0), ivec2(int(r.w) - 1)); return texelFetch(t, ij, 0); }
// bilinear pavement coverage / material
vec2 goPave(sampler2D t, vec4 r, vec2 p){
  vec2 f = (p - r.xy) / r.z - 0.5; vec2 i0 = floor(f); vec2 fr = f - i0; ivec2 a = ivec2(i0); int M = int(r.w) - 1;
  vec4 s00 = texelFetch(t, clamp(a, ivec2(0), ivec2(M)), 0), s10 = texelFetch(t, clamp(a + ivec2(1,0), ivec2(0), ivec2(M)), 0);
  vec4 s01 = texelFetch(t, clamp(a + ivec2(0,1), ivec2(0), ivec2(M)), 0), s11 = texelFetch(t, clamp(a + ivec2(1,1), ivec2(0), ivec2(M)), 0);
  float w00 = (1.-fr.x)*(1.-fr.y), w10 = fr.x*(1.-fr.y), w01 = (1.-fr.x)*fr.y, w11 = fr.x*fr.y;
  float c = s00.b*w00 + s10.b*w10 + s01.b*w01 + s11.b*w11;
  // coverage-weighted material (0 asphalt .. 1 concrete .. 2 gravel .. 3 dirt) so borders blend smoothly
  float cw = s00.b*w00 + s10.b*w10 + s01.b*w01 + s11.b*w11 + 1e-4;
  float m = (s00.a*s00.b*w00 + s10.a*s10.b*w10 + s01.a*s01.b*w01 + s11.a*s11.b*w11) / cw;
  return vec2(c, m);
}
float goIn(vec4 r, vec2 p, float band){ vec2 u = (p - r.xy) / (r.z * r.w); vec2 e = min(u, 1.0 - u) * r.z * r.w; return clamp(min(e.x, e.y) / band, 0.0, 1.0); }
GS groundSample(vec2 p, float dith){
  GS g; g.cls = 0; g.hsh = 0; g.ori = 0.0; g.cov = 0.0; g.mat = 0.0; g.w = 0.0;
  if (uGOon < 0.5) return g;
  float w0 = uGOr0.w > 0.0 ? goIn(uGOr0, p, 120.0) : 0.0;
  float w1 = uGOr1.w > 0.0 ? goIn(uGOr1, p, 400.0) : 0.0;
  vec4 s; vec2 pv;
  if (w0 > dith) { s = goFetch(uGO0, uGOr0, p); pv = goPave(uGO0, uGOr0, p); g.w = 1.0; }
  else if (w1 > 0.0) { s = goFetch(uGO1, uGOr1, p); pv = goPave(uGO1, uGOr1, p); g.w = w1; }
  else return g;
  int v = int(s.r * 255.0 + 0.5);
  g.cls = v & 31; g.hsh = v >> 5; g.ori = s.g * 3.14159265; g.cov = pv.x; g.mat = pv.y * 3.0;
  return g;
}
`;

export class GroundOverlay {
  constructor() {
    this.uniforms = {
      uGO0: { value: null }, uGO1: { value: null },
      uGOr0: { value: new THREE.Vector4(0, 0, 1, 0) }, uGOr1: { value: new THREE.Vector4(0, 0, 1, 0) },
      uGOon: { value: 0 }, uDry: { value: seasonDryness() },
    };
    this.lv = LEVELS.map((L, i) => {
      const data = new Uint8Array(L.N * L.N * 4);
      const tex = new THREE.DataTexture(data, L.N, L.N, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.flipY = false;
      tex.needsUpdate = true;
      this.uniforms['uGO' + i].value = tex;
      return { ...L, tex, data: null, cx: NaN, cz: NaN, pending: false, reqId: 0 };
    });
    this.listeners = [];
  }

  async init(base = './data/') {
    const index = await fetch(base + 'ground/index.json?v=20261123d').then((r) => r.json()).catch(() => []);
    if (!index.length) return false;
    const airport = { rects: [], taxi: [], aprons: [] };
    for (const a of AIRPORTS) {
      for (const r of a.runways) {
        const ext = r.len / 2 + (r.len > 2000 ? 60 : 15), hw = r.wid / 2 + 1, q = [];
        for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) q.push([r.x + r.dir[0] * ext * su + r.perp[0] * hw * sv, r.z + r.dir[1] * ext * su + r.perp[1] * hw * sv]);
        airport.rects.push(q);
      }
      for (const t of a.taxiways) if (t.p.length > 1) airport.taxi.push({ p: t.p, w: t.w + 2 });
      for (const ap of a.aprons) airport.aprons.push({ p: ap.p, h: ap.h || [] });
    }
    const base2 = new URL(base, location.href).href;
    this.worker = new Worker(new URL('./groundWorker.js?v=20261123d', import.meta.url));
    this.worker.postMessage({ type: 'init', base: base2, index, airport });
    this.worker.onmessage = (e) => this._onData(e.data);
    this.uniforms.uGOon.value = 1;
    this.enabled = true;
    return true;
  }

  _onData(m) {
    const L = this.lv[m.level];
    L.pending = false;
    if (m.error) { console.warn('ground overlay', m.error); return; }
    if (m.id !== L.reqId) return;
    L.data = m.data; L.cx = m.cx; L.cz = m.cz;
    L.tex.image.data = m.data; L.tex.needsUpdate = true;
    this.uniforms['uGOr' + m.level].value.set(m.cx - L.N * L.res / 2, m.cz - L.N * L.res / 2, L.res, L.N);
    for (const f of this.listeners) f(m.level);
  }

  _request(i, x, z) {
    const L = this.lv[i];
    const s = L.res * 64, cx = Math.round(x / s) * s, cz = Math.round(z / s) * s;
    if (cx === L.tcx && cz === L.tcz) return;
    L.tcx = cx; L.tcz = cz; L.pending = true; L.reqId++;
    this.worker.postMessage({ type: 'render', id: L.reqId, level: i, cx, cz, N: L.N, res: L.res });
  }

  update(cam, agl) {
    if (!this.enabled) return;
    // look-ahead along the view direction so the detailed area sits in front of the camera
    for (let i = 0; i < this.lv.length; i++) {
      const L = this.lv[i];
      if (agl > L.maxAgl) { if (i === 0 && L.data) this.uniforms.uGOr0.value.w = 0; continue; }
      if (i === 0 && L.data && this.uniforms.uGOr0.value.w === 0) this.uniforms.uGOr0.value.w = L.N;
      if (L.pending) continue;
      const dx = cam.x - (L.tcx ?? NaN), dz = cam.z - (L.tcz ?? NaN);
      if (!(Math.abs(dx) < L.move && Math.abs(dz) < L.move)) this._request(i, cam.x, cam.z);
    }
  }

  // wait until both levels around (x,z) are ready (used at load)
  ready(x, z, timeout = 20000) {
    if (!this.enabled) return Promise.resolve();
    this._request(0, x, z); this._request(1, x, z);
    return new Promise((res) => {
      const t = setTimeout(res, timeout);
      const f = () => { if (this.lv[0].data && this.lv[1].data) { clearTimeout(t); this.listeners = this.listeners.filter((g) => g !== f); res(); } };
      this.listeners.push(f);
    });
  }

  // CPU query (near level first): { cls, hash, ori, cov, mat }
  sample(x, z) {
    for (let i = 0; i < this.lv.length; i++) {
      const L = this.lv[i]; if (!L.data) continue;
      const span = L.N * L.res, x0 = L.cx - span / 2, z0 = L.cz - span / 2;
      const ix = Math.floor((x - x0) / L.res), iz = Math.floor((z - z0) / L.res);
      if (ix < 0 || iz < 0 || ix >= L.N || iz >= L.N) continue;
      const q = (iz * L.N + ix) * 4, d = L.data;
      return { cls: d[q] & 31, hash: d[q] >> 5, ori: d[q + 1] / 255 * Math.PI, cov: d[q + 2] / 255, mat: Math.round(d[q + 3] / 85), level: i };
    }
    return null;
  }
}
