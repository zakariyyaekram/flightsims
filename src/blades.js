// Close-range ground detail driven by the OSM ground overlay:
//  - GrassBlades: GPU instanced, wind-swayed blades in three level-of-detail rings around the camera,
//    only drawn when the camera is low. Lawns are short and green, wild hillsides tall and seasonally golden,
//    stubble in harvested fields, reeds in marshes; nothing on pavement, water, sand or rock.
//  - CropField: 3D vineyard rows and orchard trees on the real vineyards / orchards near the camera.
import * as THREE from 'three';
import { heightAt, WATER_LEVEL } from './geo.js';
import { GROUND_GLSL } from './ground.js?v=20261123d';

const RINGS = [
  { patch: 4, n: 10, density: 44, w: 0.04, rIn: 0, rOut: 17 },
  { patch: 8, n: 10, density: 8, w: 0.09, rIn: 15, rOut: 37 },
  { patch: 16, n: 10, density: 1.6, w: 0.2, rIn: 33, rOut: 76 },
];
const HM_N = 128, HM_RES = 2; // local heightmap for blade roots (256 m square)
const MAX_AGL = 70;

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function patchGeometry(ring, seed) {
  const nb = Math.round(ring.density * ring.patch * ring.patch);
  const r = mulberry(seed);
  const P = new Float32Array(nb * 5 * 3), B = new Float32Array(nb * 5 * 2), R = new Float32Array(nb * 5 * 4), I = new Uint32Array(nb * 9);
  const shape = [[-1, 0], [1, 0], [-0.75, 0.5], [0.75, 0.5], [0, 1]];
  for (let b = 0; b < nb; b++) {
    // jittered stratified placement
    const g = Math.ceil(Math.sqrt(nb)), gi = b % g, gj = Math.floor(b / g);
    const lx = ((gi + r()) / g) * ring.patch, lz = ((gj + r()) / g) * ring.patch;
    const rnd = r(), ang = r() * Math.PI;
    for (let v = 0; v < 5; v++) {
      const k = b * 5 + v;
      B[k * 2] = shape[v][0]; B[k * 2 + 1] = shape[v][1];
      R[k * 4] = Math.min(ring.patch - 0.01, lx); R[k * 4 + 1] = Math.min(ring.patch - 0.01, lz); R[k * 4 + 2] = rnd; R[k * 4 + 3] = ang;
    }
    const o = b * 5;
    I.set([o, o + 1, o + 2, o + 1, o + 3, o + 2, o + 2, o + 3, o + 4], b * 9);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('aBlade', new THREE.BufferAttribute(B, 2));
  geo.setAttribute('aRoot', new THREE.BufferAttribute(R, 4));
  geo.setIndex(new THREE.BufferAttribute(I, 1));
  const off = new Float32Array(ring.n * ring.n * 2);
  geo.setAttribute('iOff', new THREE.InstancedBufferAttribute(off, 2));
  geo.instanceCount = ring.n * ring.n;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return geo;
}

const NOISE_GLSL = /* glsl */`
float bh21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float bnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(bh21(i),bh21(i+vec2(1,0)),u.x), mix(bh21(i+vec2(0,1)),bh21(i+vec2(1,1)),u.x), u.y); }
float bfbm3(vec2 p){ return bnoise(p)*.5 + bnoise(p*2.03+7.1)*.25 + bnoise(p*4.1-3.3)*.125 + bnoise(p*8.3+1.7)*.0625; }
float bhh(float n){ return fract(sin(n*12.9898)*43758.5453); }
`;

export class GrassBlades {
  constructor(scene, ground) {
    this.ground = ground;
    this.hmData = new Float32Array(HM_N * HM_N);
    this.hmTex = new THREE.DataTexture(this.hmData, HM_N, HM_N, THREE.RedFormat, THREE.FloatType);
    this.hmTex.magFilter = this.hmTex.minFilter = THREE.NearestFilter; this.hmTex.generateMipmaps = false; this.hmTex.needsUpdate = true;
    this.hmC = [NaN, NaN];
    this.uniforms = {
      ...ground.uniforms,
      uHM: { value: this.hmTex }, uHMr: { value: new THREE.Vector4(0, 0, HM_RES, HM_N) },
      uCamB: { value: new THREE.Vector3() }, uTime: { value: 0 }, uWind: { value: new THREE.Vector3(1, 0, 0) },
      uWaterB: { value: WATER_LEVEL }, uFadeAgl: { value: 1 },
    };
    this.group = new THREE.Group(); this.group.name = 'grassBlades'; scene.add(this.group);
    this.meshes = RINGS.map((ring, i) => {
      const geo = patchGeometry(ring, 77 + i * 31);
      const mat = this.material(ring);
      const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.receiveShadow = true; m.renderOrder = 1;
      this.group.add(m);
      return { ring, geo, mat, mesh: m, cx: NaN, cz: NaN };
    });
  }

  material(ring) {
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    const U = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.uniforms.uRing = { value: new THREE.Vector3(ring.rIn, ring.rOut, ring.w) };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec2 aBlade; attribute vec4 aRoot; attribute vec2 iOff;
uniform sampler2D uHM; uniform vec4 uHMr; uniform vec3 uCamB; uniform float uTime; uniform vec3 uWind; uniform vec3 uRing; uniform float uWaterB; uniform float uFadeAgl;
varying vec3 vGC;
${GROUND_GLSL}
${NOISE_GLSL}
float hmAt(vec2 p){
  vec2 f = (p - uHMr.xy) / uHMr.z; vec2 i0 = floor(f); vec2 fr = f - i0; ivec2 a = ivec2(i0); int M = int(uHMr.w) - 1;
  float h00 = texelFetch(uHM, clamp(a, ivec2(0), ivec2(M)), 0).r, h10 = texelFetch(uHM, clamp(a+ivec2(1,0), ivec2(0), ivec2(M)), 0).r;
  float h01 = texelFetch(uHM, clamp(a+ivec2(0,1), ivec2(0), ivec2(M)), 0).r, h11 = texelFetch(uHM, clamp(a+ivec2(1,1), ivec2(0), ivec2(M)), 0).r;
  return mix(mix(h00,h10,fr.x), mix(h01,h11,fr.x), fr.y);
}
vec2 brot(vec2 p, float a){ float c = cos(a), s = sin(a); return vec2(c*p.x + s*p.y, -s*p.x + c*p.y); }
`)
        .replace('#include <begin_vertex>', '')
        .replace('#include <beginnormal_vertex>', `
  vec2 wp = iOff + aRoot.xy;
  float rnd = aRoot.z, ang = aRoot.w;
  float d = length(wp - uCamB.xz);
  float vis = (uRing.x > 0.0 ? smoothstep(uRing.x, uRing.x + 3.0, d) : 1.0) * (1.0 - smoothstep(uRing.y - 8.0, uRing.y, d));
  vis *= uFadeAgl;
  float H = 0.0, keep = 1.0, dry = 0.0, green = 0.0; // green: 1 = irrigated lawn
  GS g = groundSample(wp, 0.5);
  int c = g.w > 0.0 ? g.cls : 0;
  float hs = float(g.hsh);
  float m1 = bfbm3(wp/900.), m3 = bfbm3(wp/37.-5.);
  float dryN = clamp(uDry + (m1 - 0.5) * 0.6 + (bnoise(wp/9.)-.5)*.35, 0., 1.);
  vec2 q = brot(wp, g.ori);
  if (c == 29) { H = 0.1 + 0.05*bnoise(wp/3.); green = 0.6; dry = dryN*.6; }
  else if (c == 0 || c == 2) { H = mix(0.28, 0.62, bnoise(wp/6.)); dry = dryN; keep = 0.95; }
  else if (c == 6 || c == 9 || c == 17 || c == 16 || c == 27) { H = 0.075 + 0.04*bnoise(wp/3.); green = 1.0; dry = smoothstep(.62,.9,bfbm3(wp/23.+hs))*(.25+.5*uDry); keep = c == 27 ? 0.4 : 1.0; }
  else if (c == 10) { H = 0.11; green = 1.0; }
  else if (c == 11) { H = 0.035; green = 1.0; keep = 0.7; }
  else if (c == 14) { H = 0.05; green = 1.0; }
  else if (c == 1) {
    float t = bhh(hs + floor(m1*3.)*7.) * 4.;
    float rows = 0.5 + 0.5*sin(q.y * 6.2832 / (t < 2. ? 0.9 : 0.6));
    if (t < 1.) keep = 0.0;
    else if (t < 2.) { H = 0.09; green = 0.6; keep = step(0.55, rows); }
    else if (t < 3.) { H = 0.16; dry = 1.0; keep = 0.75; }
    else { H = 0.35; dry = dryN*.8; keep = 0.8; }
  }
  else if (c == 3) { vec2 f = (fract(q / vec2(6.5, 5.0)) - .5) * vec2(6.5, 5.0); H = 0.12; green = 0.5; dry = 0.3; keep = abs(f.x) < 1.4 ? 0.0 : 0.9; }
  else if (c == 4) { float r = abs(fract(q.y / 2.4) - .5) * 2.4; H = 0.14; green = 0.4; dry = 0.4; keep = (r < 0.6 || bhh(hs + 9.) <= .5) ? 0.0 : 0.85; }
  else if (c == 5) { H = 0.2; dry = 0.7; keep = 0.25; }
  else if (c == 7 || c == 8) { H = 0.15; dry = 0.6; keep = 0.06; }
  else if (c == 18) { H = 0.25; dry = dryN; keep = 0.3; }
  else if (c == 19) { H = 0.4; dry = max(dryN, 0.6); keep = 0.55; }
  else if (c == 20) { H = 0.9; dry = 0.35; green = 0.2; keep = 1.0; }
  else if (c == 25) { H = 0.3; green = 0.4; keep = 0.4; }
  else keep = 0.0;
  keep *= 1.0 - smoothstep(0.08, 0.3, g.cov);
  // terrain: no blades on water's edge, steep rock or snow
  float h0 = hmAt(wp);
  float sx = hmAt(wp + vec2(2.,0.)) - hmAt(wp - vec2(2.,0.)), sz = hmAt(wp + vec2(0.,2.)) - hmAt(wp - vec2(0.,2.));
  float slope = 1.0 - inversesqrt(1.0 + (sx*sx + sz*sz) / 16.0);
  keep *= 1.0 - smoothstep(0.24, 0.34, slope);
  keep *= smoothstep(uWaterB + 0.6, uWaterB + 1.8, h0);
  if (rnd > keep * vis * 1.02 - 0.02 || H <= 0.0) H = 0.0;
  H *= (0.65 + 0.7 * fract(rnd * 7.31)) * mix(0.6, 1.0, vis);
  // blade
  float t = aBlade.y;
  float wid = uRing.z * (green > 0.5 ? 0.8 : 1.0) * (c == 20 ? 1.6 : 1.0);
  vec2 ad = vec2(cos(ang), sin(ang));
  vec3 transformed = vec3(wp.x, h0 - 0.04, wp.y);
  transformed.xz += ad * aBlade.x * wid * 0.5 * (1.0 - t * 0.8);
  // wind sway: travelling gust waves along the wind + a little flutter, plus a random rest lean
  vec2 wd = length(uWind.xz) > 0.01 ? normalize(uWind.xz) : vec2(1.,0.);
  float ws = clamp(length(uWind.xz) / 9.0, 0.08, 1.6);
  float wave = 0.5 + 0.5 * sin(dot(wp, wd) * 0.32 - uTime * (1.3 + ws * 1.6) + bnoise(wp / 13.) * 3.0);
  float flutter = sin(uTime * (5.0 + rnd * 4.0) + rnd * 40.0) * 0.08;
  vec2 lean = vec2(fract(rnd * 13.7) - 0.5, fract(rnd * 29.3) - 0.5) * 0.5;
  vec2 bend = lean + wd * ws * (0.25 + 0.75 * wave) * (green > 0.5 ? 0.35 : 0.9) + vec2(-wd.y, wd.x) * flutter * ws;
  float bl = min(length(bend), 1.2);
  transformed.xz += bend * H * t * t;
  transformed.y += H * t * (1.0 - 0.35 * bl * bl * t);
  // colour: root shadowed, tip lighter; irrigated lawn green vs golden dry grass
  vec3 lawn = mix(vec3(.11,.19,.05), vec3(.18,.26,.09), m3);
  vec3 wildG = mix(vec3(.17,.25,.07), vec3(.25,.30,.10), m3);
  vec3 golden = mix(vec3(.52,.42,.23), vec3(.66,.56,.34), fract(rnd*3.7));
  vec3 base = mix(wildG, lawn, green);
  base = mix(base, golden, dry);
  if (c == 20) base = mix(vec3(.22,.26,.10), vec3(.45,.38,.22), fract(rnd*5.1)*.7);
  base *= 0.8 + 0.4 * fract(rnd * 17.3);
  vGC = base * mix(0.45, 1.15, t);
  vec3 objectNormal = normalize(vec3(-ad.y * 0.35 * (fract(rnd*5.3) - 0.5), 1.0, ad.x * 0.35 * (fract(rnd*5.3) - 0.5)) + vec3(bend.x, 0., bend.y) * 0.3);
`)
;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGC;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vGC;')
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal *= faceDirection;');
    };
    mat.customProgramCacheKey = () => 'blades' + ring.patch;
    return mat;
  }

  refreshHeight(x, z) {
    const s = HM_RES * 12;
    const cx = Math.round(x / s) * s, cz = Math.round(z / s) * s;
    if (cx === this.hmC[0] && cz === this.hmC[1]) return;
    this.hmC = [cx, cz];
    const x0 = cx - (HM_N / 2) * HM_RES, z0 = cz - (HM_N / 2) * HM_RES;
    for (let j = 0; j < HM_N; j++) for (let i = 0; i < HM_N; i++) this.hmData[j * HM_N + i] = heightAt(x0 + i * HM_RES, z0 + j * HM_RES);
    this.hmTex.needsUpdate = true;
    // texel (i,j) holds the height at (x0 + i*res, z0 + j*res)
    this.uniforms.uHMr.value.set(x0, z0, HM_RES, HM_N);
  }

  update(cam, agl, t, wind, camera) {
    const on = agl < MAX_AGL && this.ground.lv[0].data;
    this.group.visible = !!on;
    if (!on) return;
    this.uniforms.uFadeAgl.value = 1 - THREE.MathUtils.smoothstep(agl, MAX_AGL * 0.55, MAX_AGL);
    this.refreshHeight(cam.x, cam.z);
    this.uniforms.uCamB.value.copy(cam);
    this.uniforms.uTime.value = t;
    if (wind) this.uniforms.uWind.value.set(wind[0], wind[1], wind[2]);
    for (const M of this.meshes) {
      const { patch, n } = M.ring;
      const cx = Math.floor(cam.x / patch), cz = Math.floor(cam.z / patch);
      if (cx === M.cx && cz === M.cz) continue;
      M.cx = cx; M.cz = cz;
      const a = M.geo.attributes.iOff.array; let k = 0;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { a[k++] = (cx - n / 2 + i) * patch; a[k++] = (cz - n / 2 + j) * patch; }
      M.geo.attributes.iOff.needsUpdate = true;
    }
  }
}

// ---------------------------------------------------------------- vineyards & orchards in 3D
const CROP_R = 360, CROP_AGL = 520;
const rot = (x, z, a) => { const c = Math.cos(a), s = Math.sin(a); return [c * x + s * z, -s * x + c * z]; };
const unrot = (u, v, a) => { const c = Math.cos(a), s = Math.sin(a); return [c * u - s * v, s * u + c * v]; };

export class CropField {
  constructor(scene, ground) {
    this.ground = ground; this.scene = scene;
    this.group = new THREE.Group(); this.group.name = 'crops'; scene.add(this.group);
    this.last = null; this.dirty = true;
    ground.listeners.push((lv) => { if (lv === 0) this.dirty = true; });
  }
  async init() {
    // one 4 m trellis bay: leafy canopy from 0.75 m to the top, three gnarled trunks and the wire posts below
    const vineGeo = (() => {
      const r = mulberry(5), parts = [];
      const can = new THREE.BoxGeometry(1, 1, 1, 8, 3, 2).toNonIndexed();
      const p = can.attributes.position;
      // jitter by position so shared corners move together (no cracks)
      const jit = new Map();
      for (let i = 0; i < p.count; i++) {
        const key = p.getX(i).toFixed(3) + ',' + p.getY(i).toFixed(3) + ',' + p.getZ(i).toFixed(3);
        let j = jit.get(key); if (!j) jit.set(key, (j = [(r() - 0.5) * 0.05, (r() - 0.5) * 0.25, (r() - 0.5) * 0.45]));
        const y = p.getY(i) + 0.5;
        p.setXYZ(i, p.getX(i) + j[0], 0.55 + y * 0.45 + (y > 0.01 ? j[1] * 0.35 : 0), p.getZ(i) * (0.75 + 0.5 * y) + j[2] * 0.5 * y);
      }
      can.computeVertexNormals();
      can.setAttribute('color', new THREE.Float32BufferAttribute(new Array(p.count * 3).fill(1), 3));
      parts.push(can);
      for (const u of [-0.33, 0, 0.33]) {
        const t = new THREE.BoxGeometry(0.03, 0.6, 0.05).translate(u + (r() - 0.5) * 0.05, 0.3, 0).toNonIndexed();
        t.setAttribute('color', new THREE.Float32BufferAttribute(new Array(t.attributes.position.count * 3).fill(0.32), 3));
        delete t.attributes.uv; parts.push(t);
      }
      for (const g of parts) { delete g.attributes.uv; }
      // merge manually (positions / normals / colours)
      let n = 0; for (const g of parts) n += g.attributes.position.count;
      const P = new Float32Array(n * 3), N = new Float32Array(n * 3), C = new Float32Array(n * 3); let o = 0;
      for (const g of parts) { P.set(g.attributes.position.array, o * 3); N.set(g.attributes.normal.array, o * 3); C.set(g.attributes.color.array, o * 3); o += g.attributes.position.count; }
      const G = new THREE.BufferGeometry(); G.setAttribute('position', new THREE.BufferAttribute(P, 3)); G.setAttribute('normal', new THREE.BufferAttribute(N, 3)); G.setAttribute('color', new THREE.BufferAttribute(C, 3));
      return G;
    })();
    const crown = new THREE.IcosahedronGeometry(0.5, 1).translate(0, 0.5, 0);
    { const p = crown.attributes.position, r = mulberry(9); for (let i = 0; i < p.count; i++) { const k = 0.85 + r() * 0.3; p.setXYZ(i, p.getX(i) * k, p.getY(i) * (0.85 + r() * 0.2), p.getZ(i) * k); } crown.computeVertexNormals(); }
    const trunk = new THREE.CylinderGeometry(0.07, 0.11, 1, 5).translate(0, 0.5, 0);
    const leafMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.vines = new THREE.InstancedMesh(vineGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }), 42000);
    this.crowns = new THREE.InstancedMesh(crown, leafMat, 14000);
    this.trunks = new THREE.InstancedMesh(trunk, new THREE.MeshLambertMaterial({ color: 0x4a3a2c }), 14000);
    for (const m of [this.vines, this.crowns, this.trunks]) { m.count = 0; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; this.group.add(m); }
    // seed colours so instanceColor exists
    this.vines.setColorAt(0, new THREE.Color(1, 1, 1)); this.crowns.setColorAt(0, new THREE.Color(1, 1, 1));
  }
  update(cam, agl) {
    const on = agl < CROP_AGL;
    this.group.visible = on;
    if (!on) return;
    if (!this.dirty && this.last && Math.hypot(cam.x - this.last[0], cam.z - this.last[1]) < 90) return;
    if (!this.ground.lv[0].data) return;
    this.dirty = false; this.last = [cam.x, cam.z];
    this.build(cam.x, cam.z);
  }
  build(cx, cz) {
    const G = this.ground, STEP = 3;
    const vines = new Map(), trees = new Map();
    for (let z = cz - CROP_R; z <= cz + CROP_R; z += STEP) for (let x = cx - CROP_R; x <= cx + CROP_R; x += STEP) {
      if ((x - cx) ** 2 + (z - cz) ** 2 > CROP_R * CROP_R) continue;
      const g = G.sample(x, z); if (!g || g.level !== 0) continue;
      if (g.cls !== 4 && g.cls !== 3) continue;
      const [u, v] = rot(x, z, g.ori);
      if (g.cls === 4) {
        const SL = 4, RW = 2.4;
        for (let k = Math.floor((v - 1.6) / RW); k <= Math.floor((v + 1.6) / RW); k++) for (let s = Math.floor((u - 1.6) / SL); s <= Math.floor((u + 1.6) / SL); s++) {
          const key = g.ori.toFixed(3) + ':' + k + ':' + s; if (vines.has(key)) continue;
          const [wx, wz] = unrot((s + 0.5) * SL, (k + 0.5) * RW, g.ori);
          const g2 = G.sample(wx, wz); if (!g2 || g2.cls !== 4 || g2.cov > 0.15) { vines.set(key, null); continue; }
          vines.set(key, [wx, wz, g.ori, g.hash, k]);
        }
      } else {
        const CU = 6.5, CV = 5.0;
        for (let k = Math.floor((v - 1.6) / CV); k <= Math.floor((v + 1.6) / CV); k++) for (let s = Math.floor((u - 1.6) / CU); s <= Math.floor((u + 1.6) / CU); s++) {
          const key = g.ori.toFixed(3) + ':' + k + ':' + s; if (trees.has(key)) continue;
          const [wx, wz] = unrot((s + 0.5) * CU, (k + 0.5) * CV, g.ori);
          const g2 = G.sample(wx, wz); if (!g2 || g2.cls !== 3 || g2.cov > 0.15) { trees.set(key, null); continue; }
          trees.set(key, [wx, wz, g.hash, k * 31 + s]);
        }
      }
    }
    const M4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    let n = 0;
    for (const e of vines.values()) {
      if (!e || n >= this.vines.instanceMatrix.count) continue;
      const [x, z, ori, hsh, k] = e; const r = ((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1 + 1) % 1;
      // rows run along the rotated u axis: yaw so the box length (x) follows it
      q.setFromAxisAngle(Y, -ori); p.set(x, heightAt(x, z) - 0.05, z); sc.set(3.95, 1.5 + r * 0.35, 0.7 + r * 0.2);
      M4.compose(p, q, sc); this.vines.setMatrixAt(n, M4);
      // November: yellowing / red-turning leaves per block, some already bare-ish brown
      const b = ((hsh * 7 + Math.floor(k / 12)) % 5) / 5;
      if (b < 0.4) col.setRGB(0.44 + r * 0.08, 0.36 + r * 0.06, 0.09);
      else if (b < 0.7) col.setRGB(0.42, 0.13 + r * 0.06, 0.07);
      else col.setRGB(0.28 + r * 0.06, 0.30, 0.10);
      this.vines.setColorAt(n, col); n++;
    }
    this.vines.count = n; this.vines.instanceMatrix.needsUpdate = true; if (this.vines.instanceColor) this.vines.instanceColor.needsUpdate = true;
    let m = 0;
    for (const e of trees.values()) {
      if (!e || m >= this.crowns.instanceMatrix.count) continue;
      const [x, z, hsh, id] = e; const r = ((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1 + 1) % 1;
      const y = heightAt(x, z) - 0.1, h = 3.6 + r * 1.4, w = 3.6 + r * 1.0;
      q.identity(); p.set(x, y, z); sc.set(1, h * 0.4, 1); M4.compose(p, q, sc); this.trunks.setMatrixAt(m, M4);
      q.setFromAxisAngle(Y, r * 6.28); p.set(x, y + h * 0.32, z); sc.set(w, h * 0.72, w); M4.compose(p, q, sc); this.crowns.setMatrixAt(m, M4);
      const b = (hsh % 4) / 4;
      if (b < 0.25) col.setRGB(0.16 + r * 0.05, 0.22 + r * 0.05, 0.07);      // evergreen citrus / olive
      else if (b < 0.6) col.setRGB(0.40 + r * 0.08, 0.34 + r * 0.06, 0.10);  // walnut / almond turning yellow
      else col.setRGB(0.36 + r * 0.06, 0.20, 0.08);                          // stone fruit, orange-red
      this.crowns.setColorAt(m, col); m++;
    }
    this.crowns.count = this.trunks.count = m;
    for (const im of [this.crowns, this.trunks]) im.instanceMatrix.needsUpdate = true;
    if (this.crowns.instanceColor) this.crowns.instanceColor.needsUpdate = true;
  }
}
