// Living world: road traffic, pedestrians, farms with livestock, deer, bird flocks, boats and wind turbines.
// Everything is GPU-instanced; limbs/wings/heads are animated in the vertex shader from per-instance phase data.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { heightAt, normalAt, surfaceAt, forestAt, farmAt, TOWNS, ROADS, townAt, roadNear, roadsInBox, WATER_LEVEL, AIRPORTS, airportAt, pavedAt, pointInPoly, waterFrac, WORLD, ll2w } from './geo.js';
import { mulberry } from './noise.js';
import { lightMaterial, makePoints } from './world.js';

const TAU = Math.PI * 2;
const U_TIME = { value: 0 }, U_NIGHT = { value: 0 };

// ------------------------------------------------------------------ geometry helpers
// limb = [type, pivotY, pivotX(or Z for wings), amplitude]; part: 0 vertex colour, 1 col1, 2 col2, 3 col3*vertex, 4 glass, 5 chrome, 6 headlight, 7 taillight
function P(g, { limb = [0, 0, 0, 0], part = 0, color = [1, 1, 1], s, r, p } = {}) {
  g = g.index ? g.toNonIndexed() : g.clone();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  const m = new THREE.Matrix4().compose(new THREE.Vector3(...(p || [0, 0, 0])), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(r || [0, 0, 0]))), new THREE.Vector3(...(s || [1, 1, 1])));
  g.applyMatrix4(m);
  const L = new Float32Array(n * 4), A = new Float32Array(n), C = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { L.set(limb, i * 4); A[i] = part; C.set(color, i * 3); }
  g.setAttribute('aLimb', new THREE.BufferAttribute(L, 4)); g.setAttribute('aPart', new THREE.BufferAttribute(A, 1)); g.setAttribute('color', new THREE.BufferAttribute(C, 3));
  g.morphAttributes = {};
  return g;
}
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, n = 8) => new THREE.CylinderGeometry(rt, rb, h, n);
const sph = (r, w = 10, h = 7) => new THREE.SphereGeometry(r, w, h);
function extrude(pts, depth, opts = {}) {
  const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, ...opts });
  g.translate(0, 0, -depth / 2);
  return g;
}
// grow a closed polygon outward by d (for glass that must sit just proud of the body)
function grow(pts, d) {
  const n = pts.length; let area = 0;
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const sgn = area > 0 ? 1 : -1;
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const n1 = norm2([(p[1] - a[1]) * sgn, -(p[0] - a[0]) * sgn]), n2 = norm2([(b[1] - p[1]) * sgn, -(b[0] - p[0]) * sgn]);
    const m = norm2([n1[0] + n2[0], n1[1] + n2[1]]);
    return [p[0] + m[0] * d, p[1] + m[1] * d];
  });
}
function norm2(v) { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }
const merge = (list) => mergeGeometries(list, false);

// ------------------------------------------------------------------ material
function lifeMaterial({ glossy = false, spots = false, double = false, rough = 0.85, plank = false } = {}) {
  const m = new THREE.MeshStandardMaterial({ roughness: rough, metalness: 0.0, vertexColors: true, side: double ? THREE.DoubleSide : THREE.FrontSide });
  const key = `life-${glossy}-${spots}-${plank}`;
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U_TIME; sh.uniforms.uNight = U_NIGHT;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aLimb; attribute float aPart; attribute vec4 aAnim; attribute vec3 aCol1; attribute vec3 aCol2; attribute vec3 aCol3;
        uniform float uTime; varying float vPart; varying vec3 vObj; varying float vSpot; varying float vSeed;
        vec2 rot2(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c*v.x - s*v.y, s*v.x + c*v.y); }
        float limbAngle() {
          float t = aLimb.x;
          if (t < 0.5) return 0.0;
          if (t < 1.5) return sin(aAnim.y) * aLimb.w * aAnim.z;                 // gait swing (phase integrated on CPU)
          if (t < 2.5) return aAnim.w * aLimb.w;                                // head down (grazing)
          if (t < 3.5) return sin(aAnim.y) * aLimb.w * mix(1.0, 0.12, aAnim.w);  // wing flap / glide
          return sin(uTime * 2.1 + aAnim.x * 7.0) * aLimb.w;                    // tail swish
        }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        float la = limbAngle();
        if (aLimb.x > 0.5) { if (aLimb.x < 2.5) objectNormal.xy = rot2(objectNormal.xy, la); else if (aLimb.x < 3.5) objectNormal.yz = rot2(objectNormal.yz, la); else objectNormal.xz = rot2(objectNormal.xz, la); }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        if (aLimb.x > 0.5) {
          if (aLimb.x < 2.5) { vec2 pv = vec2(aLimb.z, aLimb.y); transformed.xy = pv + rot2(transformed.xy - pv, la); }
          else if (aLimb.x < 3.5) { vec2 pv = vec2(aLimb.y, aLimb.z); transformed.yz = pv + rot2(transformed.yz - pv, la); }
          else { vec2 pv = vec2(aLimb.z, 0.0); transformed.xz = pv + rot2(transformed.xz - pv, la); }
        }
        vPart = aPart; vObj = position; vSpot = aCol2.g; vSeed = aAnim.x;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        vColor.rgb = aPart < 0.5 ? color.rgb : aPart < 1.5 ? aCol1 : aPart < 2.5 ? aCol2 : aPart < 3.5 ? aCol3 * color.rgb : color.rgb;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight; varying float vPart; varying vec3 vObj; varying float vSpot; varying float vSeed;
        float h3(vec3 p) { return fract(sin(dot(p, vec3(17.1, 113.7, 41.3))) * 43758.5453); }
        float vn(vec3 p) { vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(mix(h3(i), h3(i+vec3(1,0,0)), f.x), mix(h3(i+vec3(0,1,0)), h3(i+vec3(1,1,0)), f.x), f.y),
                     mix(mix(h3(i+vec3(0,0,1)), h3(i+vec3(1,0,1)), f.x), mix(h3(i+vec3(0,1,1)), h3(i+vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        ${spots ? `if (vSpot > 0.5 && vPart > 0.5 && vPart < 1.5) { float n = vn(vObj * 2.6 + vSeed * 13.0) * 0.7 + vn(vObj * 6.0 + vSeed) * 0.3; diffuseColor.rgb = mix(vec3(0.035), vec3(0.93, 0.92, 0.88), smoothstep(0.47, 0.53, n)); }` : ''}
        ${plank ? `if (vPart < 0.5 && diffuseColor.r > diffuseColor.g * 1.6) { float b = abs(fract((vObj.x + vObj.z) * 4.0) - 0.5); diffuseColor.rgb *= 0.82 + 0.18 * smoothstep(0.0, 0.06, b); }` : ''}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        ${glossy ? 'if (vPart > 0.5 && vPart < 1.5) roughnessFactor = 0.32;' : ''}
        if (vPart > 3.5 && vPart < 4.5) roughnessFactor = 0.06;
        if (vPart > 4.5 && vPart < 5.5) roughnessFactor = 0.25;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        ${glossy ? 'if (vPart > 0.5 && vPart < 1.5) metalnessFactor = 0.45;' : ''}
        if (vPart > 4.5 && vPart < 5.5) metalnessFactor = 0.9;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vPart > 5.5 && vPart < 6.5) totalEmissiveRadiance += vec3(1.0, 0.94, 0.8) * (0.15 + uNight * 3.0);
        if (vPart > 6.5 && vPart < 7.5) totalEmissiveRadiance += vec3(1.0, 0.04, 0.02) * (0.35 + uNight * 1.6);`);
  };
  return m;
}

// ------------------------------------------------------------------ instance pool
class Pool {
  constructor(geo, mat, max, { cast = false } = {}) {
    this.max = max; this.n = 0;
    const g = geo;
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4); this.anim.setUsage(THREE.DynamicDrawUsage);
    this.c1 = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3); this.c1.setUsage(THREE.DynamicDrawUsage);
    this.c2 = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3); this.c2.setUsage(THREE.DynamicDrawUsage);
    this.c3 = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3); this.c3.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aAnim', this.anim); g.setAttribute('aCol1', this.c1); g.setAttribute('aCol2', this.c2); g.setAttribute('aCol3', this.c3);
    this.mesh = new THREE.InstancedMesh(g, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; this.mesh.castShadow = cast; this.mesh.receiveShadow = true; this.mesh.count = 0;
    this.M = this.mesh.instanceMatrix.array;
  }
  begin() { this.n = 0; }
  // yaw: rotation about +Y so that model +X points along travel; pitch about model Z
  push(x, y, z, yaw, pitch = 0, sc = 1, a0 = 0, a1 = 0, a2 = 0, a3 = 0, c1 = null, c2 = null, c3 = null, roll = 0) {
    if (this.n >= this.max) return false;
    const i = this.n++, M = this.M, o = i * 16;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    if (roll === 0) {
      M[o] = cp * cy * sc; M[o + 1] = sp * sc; M[o + 2] = -cp * sy * sc; M[o + 3] = 0;
      M[o + 4] = -sp * cy * sc; M[o + 5] = cp * sc; M[o + 6] = sp * sy * sc; M[o + 7] = 0;
      M[o + 8] = sy * sc; M[o + 9] = 0; M[o + 10] = cy * sc; M[o + 11] = 0;
    } else {
      // R = Ry(yaw) * Rz(pitch) * Rx(roll)
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const c0 = [cp * cy, sp, -cp * sy], c1v = [-sp * cy, cp, sp * sy], c2v = [sy, 0, cy];
      const r1 = [c1v[0] * cr + c2v[0] * sr, c1v[1] * cr + c2v[1] * sr, c1v[2] * cr + c2v[2] * sr];
      const r2 = [-c1v[0] * sr + c2v[0] * cr, -c1v[1] * sr + c2v[1] * cr, -c1v[2] * sr + c2v[2] * cr];
      M[o] = c0[0] * sc; M[o + 1] = c0[1] * sc; M[o + 2] = c0[2] * sc; M[o + 3] = 0;
      M[o + 4] = r1[0] * sc; M[o + 5] = r1[1] * sc; M[o + 6] = r1[2] * sc; M[o + 7] = 0;
      M[o + 8] = r2[0] * sc; M[o + 9] = r2[1] * sc; M[o + 10] = r2[2] * sc; M[o + 11] = 0;
    }
    M[o + 12] = x; M[o + 13] = y; M[o + 14] = z; M[o + 15] = 1;
    const A = this.anim.array; A[i * 4] = a0; A[i * 4 + 1] = a1; A[i * 4 + 2] = a2; A[i * 4 + 3] = a3;
    if (c1) { this.c1.array[i * 3] = c1[0]; this.c1.array[i * 3 + 1] = c1[1]; this.c1.array[i * 3 + 2] = c1[2]; }
    if (c2) { this.c2.array[i * 3] = c2[0]; this.c2.array[i * 3 + 1] = c2[1]; this.c2.array[i * 3 + 2] = c2[2]; }
    if (c3) { this.c3.array[i * 3] = c3[0]; this.c3.array[i * 3 + 1] = c3[1]; this.c3.array[i * 3 + 2] = c3[2]; }
    return true;
  }
  end() {
    this.mesh.count = this.n;
    if (this.n) {
      for (const a of [this.mesh.instanceMatrix, this.anim, this.c1, this.c2, this.c3]) { a.clearUpdateRanges?.(); a.needsUpdate = true; }
    }
  }
}

// ------------------------------------------------------------------ vehicle models (forward = +X)
const DARK = [0.035, 0.035, 0.04], TIRE = [0.03, 0.03, 0.03], CHROME = [0.75, 0.76, 0.78], GLASS = [0.06, 0.08, 0.1], PLATE = [0.9, 0.9, 0.85];
function wheels(xs, r, zw, w = 0.22) {
  const out = [];
  for (const x of xs) for (const s of [-1, 1]) {
    out.push(P(cyl(r, r, w, 14), { color: TIRE, r: [Math.PI / 2, 0, 0], p: [x, r, s * zw] }));
    out.push(P(cyl(r * 0.6, r * 0.6, 0.02, 12), { part: 5, color: CHROME, r: [Math.PI / 2, 0, 0], p: [x, r, s * (zw + w / 2 + 0.005)] }));
  }
  return out;
}
function carBody(profile, glassPts, width, extras) {
  const parts = [P(extrude(profile, width), { part: 1 })];
  parts.push(P(extrude(grow(glassPts, 0.018), width + 0.03), { part: 4, color: GLASS }));
  return parts.concat(extras);
}
function sedanGeo() {
  const W = 1.76;
  const prof = [[-2.3, 0.3], [2.22, 0.3], [2.32, 0.5], [2.3, 0.7], [1.25, 0.88], [0.35, 1.38], [-0.95, 1.41], [-1.85, 0.99], [-2.32, 0.93], [-2.37, 0.58]];
  const glass = [[1.18, 0.9], [0.38, 1.33], [-0.92, 1.36], [-1.76, 0.99]];
  return merge(carBody(prof, glass, W, [
    P(box(0.12, 0.46, W + 0.05), { part: 1, p: [-0.28, 1.13, 0], r: [0, 0, 0.12] }),
    P(box(0.05, 0.12, 0.34), { part: 6, color: [1, 1, 1], p: [2.29, 0.66, 0.6] }), P(box(0.05, 0.12, 0.34), { part: 6, color: [1, 1, 1], p: [2.29, 0.66, -0.6] }),
    P(box(0.05, 0.13, 0.32), { part: 7, color: [0.6, 0.05, 0.03], p: [-2.36, 0.82, 0.62] }), P(box(0.05, 0.13, 0.32), { part: 7, color: [0.6, 0.05, 0.03], p: [-2.36, 0.82, -0.62] }),
    P(box(0.04, 0.14, 0.7), { color: DARK, p: [2.31, 0.55, 0] }),
    P(box(0.08, 0.16, W + 0.04), { color: [0.12, 0.12, 0.13], p: [2.3, 0.38, 0] }), P(box(0.08, 0.16, W + 0.04), { color: [0.12, 0.12, 0.13], p: [-2.36, 0.4, 0] }),
    P(box(0.02, 0.12, 0.34), { color: PLATE, p: [-2.41, 0.56, 0] }),
    P(box(0.12, 0.1, 0.18), { part: 1, p: [0.95, 1.02, 0.95] }), P(box(0.12, 0.1, 0.18), { part: 1, p: [0.95, 1.02, -0.95] }),
    ...wheels([1.38, -1.38], 0.33, 0.78),
  ]));
}
function suvGeo() {
  const W = 1.9;
  const prof = [[-2.35, 0.42], [2.28, 0.42], [2.38, 0.62], [2.36, 0.95], [1.4, 1.08], [0.72, 1.72], [-2.18, 1.77], [-2.4, 1.22], [-2.42, 0.66]];
  const glass = [[1.33, 1.1], [0.74, 1.67], [-2.12, 1.72], [-2.3, 1.18]];
  return merge(carBody(prof, glass, W, [
    P(box(0.14, 0.62, W + 0.05), { part: 1, p: [-0.2, 1.42, 0] }), P(box(0.14, 0.62, W + 0.05), { part: 1, p: [-1.3, 1.44, 0] }),
    P(box(0.05, 0.14, 0.36), { part: 6, color: [1, 1, 1], p: [2.36, 0.86, 0.64] }), P(box(0.05, 0.14, 0.36), { part: 6, color: [1, 1, 1], p: [2.36, 0.86, -0.64] }),
    P(box(0.05, 0.2, 0.22), { part: 7, color: [0.6, 0.05, 0.03], p: [-2.42, 1.08, 0.78] }), P(box(0.05, 0.2, 0.22), { part: 7, color: [0.6, 0.05, 0.03], p: [-2.42, 1.08, -0.78] }),
    P(box(0.05, 0.22, 0.95), { color: DARK, p: [2.39, 0.72, 0] }),
    P(box(0.1, 0.22, W + 0.06), { color: [0.1, 0.1, 0.11], p: [2.35, 0.5, 0] }), P(box(0.1, 0.22, W + 0.06), { color: [0.1, 0.1, 0.11], p: [-2.42, 0.52, 0] }),
    P(box(1.9, 0.05, 0.06), { color: DARK, p: [-0.75, 1.8, 0.75] }), P(box(1.9, 0.05, 0.06), { color: DARK, p: [-0.75, 1.8, -0.75] }),
    P(box(0.02, 0.12, 0.34), { color: PLATE, p: [-2.44, 0.75, 0] }),
    ...wheels([1.45, -1.45], 0.38, 0.84, 0.25),
  ]));
}
function pickupGeo() {
  const W = 1.98;
  const prof = [[-2.75, 0.48], [2.6, 0.48], [2.72, 0.72], [2.68, 1.08], [1.55, 1.18], [0.95, 1.86], [-0.42, 1.89], [-0.55, 1.16], [-2.75, 1.13]];
  const glass = [[1.48, 1.2], [0.97, 1.81], [-0.38, 1.84], [-0.48, 1.22]];
  return merge(carBody(prof, glass, W, [
    P(box(2.05, 0.06, W - 0.18), { color: [0.05, 0.05, 0.05], p: [-1.62, 1.14, 0] }),
    P(box(0.05, 0.16, 0.42), { part: 6, color: [1, 1, 1], p: [2.69, 0.94, 0.66] }), P(box(0.05, 0.16, 0.42), { part: 6, color: [1, 1, 1], p: [2.69, 0.94, -0.66] }),
    P(box(0.05, 0.28, 0.16), { part: 7, color: [0.6, 0.05, 0.03], p: [-2.77, 0.92, 0.88] }), P(box(0.05, 0.28, 0.16), { part: 7, color: [0.6, 0.05, 0.03], p: [-2.77, 0.92, -0.88] }),
    P(box(0.06, 0.32, 1.0), { part: 5, color: CHROME, p: [2.71, 0.82, 0] }),
    P(box(0.12, 0.2, W + 0.08), { part: 5, color: CHROME, p: [2.66, 0.55, 0] }), P(box(0.1, 0.18, W + 0.06), { part: 5, color: CHROME, p: [-2.78, 0.56, 0] }),
    P(box(0.02, 0.12, 0.34), { color: PLATE, p: [-2.8, 0.78, 0] }),
    ...wheels([1.72, -1.78], 0.4, 0.86, 0.27),
  ]));
}
function truckGeo() {
  const W = 2.4;
  const cab = [[0.5, 0.55], [3.2, 0.55], [3.28, 1.05], [3.22, 1.6], [2.75, 2.65], [0.5, 2.75]];
  const glass = [[3.15, 1.65], [2.7, 2.55], [1.7, 2.58], [1.7, 1.66]];
  return merge([
    P(extrude(cab, W), { part: 1 }), P(extrude(grow(glass, 0.02), W + 0.03), { part: 4, color: GLASS }),
    P(box(5.0, 3.1, W + 0.08), { part: 2, p: [-2.1, 2.2, 0] }),
    P(box(5.0, 0.18, W + 0.1), { part: 1, p: [-2.1, 1.0, 0] }),
    P(box(7.4, 0.35, 1.2), { color: DARK, p: [-0.9, 0.62, 0] }),
    P(box(0.05, 0.2, 0.36), { part: 6, color: [1, 1, 1], p: [3.27, 0.92, 0.85] }), P(box(0.05, 0.2, 0.36), { part: 6, color: [1, 1, 1], p: [3.27, 0.92, -0.85] }),
    P(box(0.05, 0.2, 0.2), { part: 7, color: [0.6, 0.05, 0.03], p: [-4.62, 0.95, 1.0] }), P(box(0.05, 0.2, 0.2), { part: 7, color: [0.6, 0.05, 0.03], p: [-4.62, 0.95, -1.0] }),
    P(box(0.12, 0.3, W + 0.1), { color: [0.15, 0.15, 0.15], p: [3.26, 0.65, 0] }),
    P(box(0.25, 0.08, 0.4), { color: DARK, p: [1.9, 2.45, 1.32] }), P(box(0.25, 0.08, 0.4), { color: DARK, p: [1.9, 2.45, -1.32] }),
    ...wheels([2.45, -2.5, -3.55], 0.5, 1.0, 0.32),
  ]);
}
function busGeo() {
  const W = 2.45; const Y = [0.98, 0.72, 0.05];
  return merge([
    P(box(9.2, 2.35, W), { color: Y, p: [-0.6, 1.75, 0] }),
    P(extrude([[4.0, 0.55], [5.6, 0.55], [5.65, 1.4], [5.1, 1.62], [4.0, 1.7]], W - 0.2), { color: Y }),
    P(box(8.2, 0.75, W + 0.03), { part: 4, color: GLASS, p: [-0.9, 2.3, 0] }),
    P(box(0.05, 0.9, W - 0.4), { part: 4, color: GLASS, p: [4.0, 2.25, 0] }),
    P(box(9.25, 0.1, W + 0.05), { color: DARK, p: [-0.6, 1.5, 0] }), P(box(9.25, 0.1, W + 0.05), { color: DARK, p: [-0.6, 1.25, 0] }),
    P(box(9.2, 0.2, W + 0.05), { color: DARK, p: [-0.6, 0.6, 0] }),
    P(box(0.06, 0.15, 0.3), { part: 6, color: [1, 1, 1], p: [5.63, 1.1, 0.85] }), P(box(0.06, 0.15, 0.3), { part: 6, color: [1, 1, 1], p: [5.63, 1.1, -0.85] }),
    P(box(0.06, 0.2, 0.2), { part: 7, color: [0.6, 0.05, 0.03], p: [-5.22, 1.0, 1.0] }), P(box(0.06, 0.2, 0.2), { part: 7, color: [0.6, 0.05, 0.03], p: [-5.22, 1.0, -1.0] }),
    P(box(0.06, 0.25, 1.4), { color: [0.1, 0.1, 0.1], p: [5.65, 0.7, 0] }),
    ...wheels([3.9, -3.2], 0.5, 1.0, 0.3),
  ]);
}

function serviceCartGeo(kind) {
  const W = 1.55;
  const yellow = [0.95, 0.62, 0.08];
  const white = [0.82, 0.84, 0.82];
  const blue = [0.12, 0.35, 0.58];
  let bodyColor = yellow, bodyHeight = 1.25;
  let extras = [];
  if (kind === 'baggage') {
    bodyColor = yellow;
    extras = [P(box(2.8, 0.7, W), { color: blue, p: [-0.6, 1.15, 0] })];
  } else if (kind === 'catering') {
    bodyColor = white; bodyHeight = 2.2;
    extras = [
      P(box(2.7, 1.85, W), { color: white, p: [-0.55, 2.05, 0] }),
      P(box(2.82, 0.08, W + 0.05), { color: blue, p: [-0.55, 1.15, 0] }),
    ];
  } else if (kind === 'stairs') {
    bodyColor = yellow;
    extras = [
      P(box(1.8, 0.12, 1.25), { color: yellow, p: [-0.3, 0.85, 0], r: [0, 0, -0.28] }),
      P(box(0.12, 1.15, 0.12), { color: [0.22, 0.24, 0.24], p: [0.75, 0.65, 0.52] }),
      P(box(0.12, 1.15, 0.12), { color: [0.22, 0.24, 0.24], p: [0.75, 0.65, -0.52] }),
    ];
  } else if (kind === 'gpu') {
    bodyColor = blue; bodyHeight = 1.35;
    extras = [
      P(box(0.12, 1.8, 0.08), { color: blue, p: [1.25, 1.35, 0] }),
      P(cyl(0.09, 0.09, 2.4, 8), { part: 5, color: CHROME, p: [1.25, 2.15, 0], r: [0, 0, Math.PI / 2] }),
    ];
  } else if (kind === 'tug') {
    bodyColor = yellow; bodyHeight = 0.95;
    extras = [
      P(box(1.8, 0.12, 0.12), { color: yellow, p: [1.9, 0.7, 0] }),
      P(cyl(0.12, 0.12, 1.2, 8), { color: blue, p: [-0.2, 1.25, 0], r: [0, 0, Math.PI / 2] }),
    ];
  }
  return merge([
    P(box(3.1, bodyHeight, W), { color: bodyColor, p: [-0.3, bodyHeight / 2 + 0.25, 0] }),
    P(box(0.05, 0.18, 0.32), { part: 6, color: [1, 1, 1], p: [1.27, 0.78, 0.48] }),
    P(box(0.05, 0.18, 0.32), { part: 6, color: [1, 1, 1], p: [1.27, 0.78, -0.48] }),
    ...extras,
    ...wheels([0.95, -1.2], 0.32, 0.68, 0.18),
  ]);
}

// ------------------------------------------------------------------ people (forward +X, feet at y=0, 1.75 m)
function personGeo() {
  const parts = [];
  for (const s of [-1, 1]) {
    const leg = [1, 0.92, 0, 0.5 * s];
    parts.push(P(cyl(0.075, 0.06, 0.86, 7), { limb: leg, part: 2, p: [0, 0.49, 0.1 * s] }));
    parts.push(P(box(0.26, 0.08, 0.11), { limb: leg, color: [0.08, 0.07, 0.07], p: [0.04, 0.04, 0.1 * s] }));
    const arm = [1, 1.43, 0, -0.55 * s];
    parts.push(P(cyl(0.05, 0.045, 0.32, 6), { limb: arm, part: 1, p: [0, 1.28, 0.235 * s] }));
    parts.push(P(cyl(0.042, 0.038, 0.3, 6), { limb: arm, part: 3, color: [1, 1, 1], p: [0, 0.98, 0.235 * s] }));
    parts.push(P(sph(0.048, 6, 5), { limb: arm, part: 3, color: [1, 1, 1], p: [0, 0.81, 0.235 * s] }));
  }
  parts.push(P(cyl(0.2, 0.17, 0.62, 10), { part: 1, s: [0.62, 1, 1], p: [0, 1.2, 0] }));
  parts.push(P(cyl(0.17, 0.17, 0.16, 10), { part: 2, s: [0.62, 1, 1], p: [0, 0.88, 0] }));
  parts.push(P(cyl(0.05, 0.055, 0.1, 6), { part: 3, color: [1, 1, 1], p: [0, 1.54, 0] }));
  parts.push(P(sph(0.11, 10, 8), { part: 3, color: [1, 1, 1], s: [1, 1.15, 0.92], p: [0.01, 1.66, 0] }));
  parts.push(P(new THREE.SphereGeometry(0.116, 10, 6, 0, TAU, 0, Math.PI * 0.55), { color: [0.12, 0.08, 0.05], s: [1.04, 1.12, 0.98], p: [-0.008, 1.675, 0] }));
  return merge(parts);
}

// ------------------------------------------------------------------ animals (forward +X)
function quadruped({ L = 2.2, H = 1.4, bodyR = 0.36, legR = 0.07, neck = 0.5, headL = 0.5, headR = 0.14, ears = true, horns = false, tail = 0.8, hoof = [0.08, 0.07, 0.06], face = null, udder = false, mane = null, legPart = 1, maxH } = {}) {
  const parts = []; const legH = H - bodyR * 1.15; const bx = L * 0.36;
  parts.push(P(new THREE.CapsuleGeometry(bodyR, L * 0.62, 6, 12), { part: 1, r: [0, 0, Math.PI / 2], s: [1, 1, 0.92], p: [0, legH + bodyR * 0.9, 0] }));
  for (const [x, z, sgn] of [[bx, 1, 1], [bx, -1, -1], [-bx, 1, -1], [-bx, -1, 1]]) {
    const limb = [1, legH + 0.1, x, 0.42 * sgn];
    parts.push(P(cyl(legR * 1.25, legR, legH * 0.6, 7), { limb, part: legPart, p: [x, legH * 0.7 + 0.05, z * bodyR * 0.55] }));
    parts.push(P(cyl(legR * 0.85, legR * 0.8, legH * 0.42, 6), { limb, part: legPart, p: [x, legH * 0.25, z * bodyR * 0.55] }));
    parts.push(P(cyl(legR * 0.95, legR * 1.05, 0.08, 6), { limb, color: hoof, p: [x, 0.04, z * bodyR * 0.55] }));
  }
  const nx = L * 0.5, ny = legH + bodyR * 1.25;
  const headLimb = [2, ny - 0.05, nx - 0.15, -1];
  const ang = mane ? 0.95 : 0.55;
  parts.push(P(cyl(headR * 1.05, bodyR * 0.75, neck, 8), { limb: headLimb, part: 1, r: [0, 0, -ang], p: [nx + Math.sin(ang) * neck * 0.4, ny + Math.cos(ang) * neck * 0.35, 0] }));
  const hx = nx + Math.sin(ang) * neck * 0.85 + headL * 0.32, hy = ny + Math.cos(ang) * neck * 0.75;
  parts.push(P(box(headL, headR * 2, headR * 1.7), { limb: headLimb, part: face ? 0 : 1, color: face || [1, 1, 1], r: [0, 0, -0.5], p: [hx, hy, 0] }));
  parts.push(P(box(headL * 0.35, headR * 1.3, headR * 1.5), { limb: headLimb, color: [0.25, 0.2, 0.2], r: [0, 0, -0.5], p: [hx + headL * 0.42, hy - headL * 0.24, 0] }));
  if (ears) for (const s of [-1, 1]) parts.push(P(box(0.05, 0.06, headR * 1.3), { limb: headLimb, part: 1, r: [0.5 * s, 0, 0], p: [hx - headL * 0.32, hy + headR * 0.8, s * headR * 1.1] }));
  if (horns) for (const s of [-1, 1]) parts.push(P(cyl(0.015, 0.03, 0.16, 5), { limb: headLimb, color: [0.85, 0.8, 0.7], r: [0.9 * s, 0, 0], p: [hx - headL * 0.35, hy + headR * 1.1, s * headR * 0.9] }));
  if (mane) parts.push(P(box(neck * 0.95, 0.08, 0.06), { limb: headLimb, color: mane, r: [0, 0, -ang + Math.PI / 2], p: [nx + Math.sin(ang) * neck * 0.3, ny + Math.cos(ang) * neck * 0.5 + 0.06, 0] }));
  if (tail > 0) {
    const tl = [4, 0, -L * 0.5, 0.25];
    parts.push(P(cyl(0.02, 0.03, tail, 5), { limb: tl, part: mane ? 0 : 1, color: mane || [1, 1, 1], r: [0, 0, -0.18], p: [-L * 0.52, legH + bodyR * 1.1 - tail * 0.45, 0] }));
    parts.push(P(sph(0.05, 6, 4), { limb: tl, color: mane || [0.1, 0.1, 0.1], s: [1, 2.4, 1], p: [-L * 0.55, legH + bodyR * 1.1 - tail * 0.92, 0] }));
  }
  if (udder) parts.push(P(sph(0.16, 8, 6), { color: [0.92, 0.7, 0.68], s: [1.2, 0.8, 1], p: [-L * 0.2, legH + 0.08, 0] }));
  return merge(parts);
}
function sheepGeo() {
  const parts = [];
  const wool = new THREE.IcosahedronGeometry(0.5, 2); const pa = wool.attributes.position;
  for (let i = 0; i < pa.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(pa, i); const k = 1 + 0.09 * Math.sin(v.x * 23) * Math.sin(v.y * 19 + v.z * 17); v.multiplyScalar(k); pa.setXYZ(i, v.x, v.y, v.z); }
  wool.computeVertexNormals();
  parts.push(P(wool, { part: 1, s: [1.35, 0.85, 0.9], p: [0, 0.72, 0] }));
  for (const [x, z, sgn] of [[0.38, 1, 1], [0.38, -1, -1], [-0.38, 1, -1], [-0.38, -1, 1]]) parts.push(P(cyl(0.04, 0.035, 0.5, 6), { limb: [1, 0.55, x, 0.4 * sgn], color: [0.1, 0.09, 0.08], p: [x, 0.25, z * 0.2] }));
  const hl = [2, 0.82, 0.55, -1];
  parts.push(P(box(0.28, 0.17, 0.15), { limb: hl, color: [0.12, 0.1, 0.09], r: [0, 0, -0.6], p: [0.78, 0.86, 0] }));
  for (const s of [-1, 1]) parts.push(P(box(0.05, 0.04, 0.13), { limb: hl, color: [0.12, 0.1, 0.09], p: [0.7, 0.94, s * 0.11] }));
  parts.push(P(sph(0.1, 6, 5), { part: 1, p: [-0.68, 0.78, 0] }));
  return merge(parts);
}
function birdGeo() {
  const parts = [];
  parts.push(P(sph(0.07, 8, 6), { part: 1, s: [2.6, 0.9, 1], p: [0, 0, 0] }));
  parts.push(P(sph(0.045, 6, 5), { part: 1, p: [0.19, 0.02, 0] }));
  parts.push(P(new THREE.ConeGeometry(0.018, 0.06, 5), { color: [0.9, 0.6, 0.1], r: [0, 0, -Math.PI / 2], p: [0.25, 0.015, 0] }));
  parts.push(P(box(0.14, 0.012, 0.1), { part: 2, p: [-0.2, 0, 0] }));
  for (const s of [-1, 1]) {
    const wl = [3, 0.0, 0.0, 0.7 * s];
    parts.push(P(box(0.15, 0.012, 0.25), { limb: wl, part: 2, p: [0.0, 0, s * 0.15] }));
    parts.push(P(box(0.1, 0.01, 0.22), { limb: wl, part: 2, r: [0, s * 0.35, 0], p: [-0.03, 0, s * 0.37] }));
  }
  return merge(parts);
}
function boatGeo(sail) {
  const L = sail ? 8.5 : 6.5, Wd = sail ? 2.6 : 2.3;
  const hullShape = [[-L / 2, -Wd / 2], [L * 0.18, -Wd / 2], [L / 2, 0], [L * 0.18, Wd / 2], [-L / 2, Wd / 2]];
  const hull = extrude(hullShape, 1.0); hull.rotateX(-Math.PI / 2); hull.translate(0, -0.45, 0);
  const parts = [P(hull, { part: 1 })];
  parts.push(P(box(L * 0.92, 0.06, Wd * 0.9), { color: [0.8, 0.72, 0.58], p: [-L * 0.03, 0.56, 0] }));
  parts.push(P(box(L, 0.12, Wd + 0.04), { part: 2, s: [0.98, 1, 1], p: [-L * 0.04, 0.1, 0] }));
  if (sail) {
    parts.push(P(cyl(0.06, 0.07, 11, 6), { part: 5, color: CHROME, p: [L * 0.1, 6.0, 0] }));
    parts.push(P(cyl(0.04, 0.04, 3.6, 5), { part: 5, color: CHROME, r: [0, 0, Math.PI / 2], p: [L * 0.1 - 1.8, 1.6, 0] }));
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute([L * 0.1, 11.2, 0, L * 0.1, 1.65, 0, L * 0.1 - 3.5, 1.65, 0, L * 0.1 + 0.05, 9.5, 0, L / 2 - 0.1, 0.7, 0, L * 0.1 + 0.05, 1.8, 0], 3)); sg.computeVertexNormals();
    parts.push(P(sg, { color: [0.95, 0.95, 0.92] }));
    parts.push(P(box(1.8, 0.5, 1.4), { color: [0.92, 0.92, 0.9], p: [-0.6, 0.8, 0] }));
  } else {
    parts.push(P(box(1.8, 0.7, 1.7), { color: [0.95, 0.95, 0.95], p: [0, 0.9, 0] }));
    parts.push(P(box(0.05, 0.5, 1.6), { part: 4, color: GLASS, r: [0, 0, 0.45], p: [0.95, 1.05, 0] }));
    parts.push(P(box(0.5, 0.6, 0.5), { color: [0.15, 0.15, 0.15], p: [-L / 2 - 0.1, 0.4, 0] }));
  }
  return merge(parts);
}
function wakeGeo() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, -26, 0, -7, -26, 0, 7], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0.5, 1, 0, 0, 1, 0], 2));
  g.computeVertexNormals(); return g;
}

// ------------------------------------------------------------------ farm buildings (instanced, static)
function barnGeo() {
  const w = 12, d = 18, h1 = 5.2, h2 = 4.2; const RED = [0.55, 0.12, 0.08], WHITE = [0.93, 0.92, 0.88], ROOF = [0.32, 0.33, 0.35];
  const prof = [[-w / 2, 0], [w / 2, 0], [w / 2, h1], [w * 0.3, h1 + h2 * 0.62], [0, h1 + h2], [-w * 0.3, h1 + h2 * 0.62], [-w / 2, h1]];
  const parts = [P(extrude(prof, d), { color: RED, r: [0, Math.PI / 2, 0] })];
  // roof planes
  const segs = [[[w / 2 + 0.3, h1 - 0.2], [w * 0.3, h1 + h2 * 0.62]], [[w * 0.3, h1 + h2 * 0.62], [0, h1 + h2 + 0.05]], [[0, h1 + h2 + 0.05], [-w * 0.3, h1 + h2 * 0.62]], [[-w * 0.3, h1 + h2 * 0.62], [-w / 2 - 0.3, h1 - 0.2]]];
  for (const [a, b] of segs) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]); const dz = -(b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
    const th = Math.atan2(-dy, dz);
    parts.push(P(box(d + 0.8, 0.12, len), { color: ROOF, r: [th, 0, 0], p: [0, (a[1] + b[1]) / 2 + Math.cos(th) * 0.07, -(a[0] + b[0]) / 2 + Math.sin(th) * 0.07] }));
  }
  // big doors and trim on both gable ends
  for (const s of [-1, 1]) {
    const x = s * (d / 2 + 0.03);
    parts.push(P(box(0.06, 3.8, 4.2), { color: [0.42, 0.09, 0.06], p: [x, 1.9, 0] }));
    parts.push(P(box(0.08, 0.18, 4.4), { color: WHITE, p: [x, 3.8, 0] })); parts.push(P(box(0.08, 3.9, 0.18), { color: WHITE, p: [x, 1.95, 2.2] })); parts.push(P(box(0.08, 3.9, 0.18), { color: WHITE, p: [x, 1.95, -2.2] }));
    parts.push(P(box(0.08, 0.16, 5.6), { color: WHITE, r: [0.73, 0, 0], p: [x, 1.9, 0] })); parts.push(P(box(0.08, 0.16, 5.6), { color: WHITE, r: [-0.73, 0, 0], p: [x, 1.9, 0] }));
    parts.push(P(box(0.08, 1.2, 1.4), { color: [0.42, 0.09, 0.06], p: [x, h1 + 1.4, 0] })); parts.push(P(box(0.09, 1.3, 1.5), { color: WHITE, s: [1, 1, 1], p: [x - s * 0.005, h1 + 1.4, 0] }));
  }
  for (const s of [-1, 1]) for (const t of [-1, 1]) parts.push(P(box(0.2, h1, 0.2), { color: WHITE, p: [t * d / 2, h1 / 2, s * w / 2] }));
  return merge(parts);
}
function farmhouseGeo() {
  const WH = [0.93, 0.92, 0.88], ROOF = [0.22, 0.23, 0.26], TRIM = [0.95, 0.95, 0.95];
  const w = 10, d = 8, h = 6;
  const parts = [P(box(w, h, d), { color: WH, p: [0, h / 2, 0] })];
  const prof = [[-d / 2 - 0.5, 0], [d / 2 + 0.5, 0], [0, 3.4]];
  parts.push(P(extrude(prof, w + 0.8), { color: ROOF, r: [0, Math.PI / 2, 0], p: [0, h - 0.05, 0] }));
  parts.push(P(extrude([[-d / 2 + 0.02, 0], [d / 2 - 0.02, 0], [0, 3.0]], w + 0.02), { color: WH, r: [0, Math.PI / 2, 0], p: [0, h - 0.06, 0] }));
  parts.push(P(box(w + 0.4, 0.15, 2.6), { color: ROOF, r: [0.18, 0, 0], p: [0, 3.1, d / 2 + 1.25] }));
  for (const x of [-w / 2, -w / 6, w / 6, w / 2]) parts.push(P(box(0.15, 3.0, 0.15), { color: TRIM, p: [x * 0.96, 1.5, d / 2 + 2.4] }));
  parts.push(P(box(w + 0.2, 0.25, 2.6), { color: [0.6, 0.6, 0.6], p: [0, 0.12, d / 2 + 1.3] }));
  parts.push(P(box(1.0, 1.0, 1.0), { color: [0.45, 0.2, 0.15], s: [0.8, 3, 0.8], p: [w * 0.3, h + 2.6, 0] }));
  // windows (two floors, front & back) and door
  for (const z of [d / 2 + 0.02, -d / 2 - 0.02]) for (const y of [1.6, 4.4]) for (const x of [-3.4, -1.1, 1.1, 3.4]) {
    if (z > 0 && y < 2 && Math.abs(x) < 1.5) continue;
    parts.push(P(box(1.0, 1.35, 0.04), { color: TRIM, p: [x, y, z] })); parts.push(P(box(0.82, 1.17, 0.05), { part: 4, color: GLASS, p: [x, y, z] }));
  }
  parts.push(P(box(1.0, 2.1, 0.05), { color: [0.25, 0.12, 0.08], p: [0, 1.05, d / 2 + 0.03] }));
  return merge(parts);
}
function siloGeo() {
  return merge([
    P(cyl(2.8, 2.8, 17, 18), { part: 1, p: [0, 8.5, 0] }),
    P(new THREE.SphereGeometry(2.85, 18, 8, 0, TAU, 0, Math.PI / 2), { part: 5, color: [0.78, 0.8, 0.82], p: [0, 17, 0] }),
    P(box(0.5, 17, 0.5), { color: [0.5, 0.5, 0.5], p: [2.85, 8.5, 0] }),
    ...[3, 6, 9, 12, 15].map((y) => P(cyl(2.83, 2.83, 0.12, 18), { color: [0.45, 0.45, 0.45], p: [0, y, 0] })),
  ]);
}
function shedGeo() {
  const M = [0.62, 0.64, 0.66];
  return merge([
    P(box(20, 5, 12), { color: M, p: [0, 2.5, 0] }),
    P(extrude([[-6.5, 0], [6.5, 0], [0, 1.8]], 20.6), { color: [0.5, 0.52, 0.55], r: [0, Math.PI / 2, 0], p: [0, 4.98, 0] }),
    P(box(0.05, 4.2, 9), { color: [0.25, 0.26, 0.28], p: [10.02, 2.1, 0] }),
  ]);
}
function fenceGeo() { // one 3 m span: post at x=0, two rails to x=3
  const WOOD = [0.46, 0.38, 0.28];
  return merge([P(box(0.12, 1.3, 0.12), { color: WOOD, p: [0, 0.55, 0] }), P(box(3.0, 0.1, 0.04), { color: [0.55, 0.47, 0.36], p: [1.5, 0.95, 0] }), P(box(3.0, 0.1, 0.04), { color: [0.55, 0.47, 0.36], p: [1.5, 0.5, 0] })]);
}
function baleGeo() { return merge([P(cyl(0.75, 0.75, 1.25, 14), { color: [0.78, 0.66, 0.38], r: [Math.PI / 2, 0, 0], p: [0, 0.72, 0] })]); }
function turbineGeo() {
  return merge([
    P(cyl(1.4, 2.4, 80, 14), { color: [0.93, 0.94, 0.95], p: [0, 40, 0] }),
    P(box(9, 3.4, 3.4), { color: [0.93, 0.94, 0.95], p: [1.5, 81.5, 0] }),
  ]);
}
function rotorGeo() {
  const parts = [P(sph(1.6, 12, 8), { color: [0.93, 0.94, 0.95], s: [1.6, 1, 1], p: [0, 0, 0] })];
  for (let k = 0; k < 3; k++) {
    const a = k / 3 * TAU;
    const blade = new THREE.BoxGeometry(0.35, 44, 2.6); const pa = blade.attributes.position;
    for (let i = 0; i < pa.count; i++) { const y = pa.getY(i) + 22; const t = y / 44; pa.setZ(i, pa.getZ(i) * (1 - 0.75 * t) + (pa.getZ(i) > 0 ? 0.6 * (1 - t) : 0)); pa.setY(i, y + 1.2); }
    blade.computeVertexNormals();
    parts.push(P(blade, { color: [0.95, 0.95, 0.96], r: [a, 0, 0] }));
  }
  return merge(parts);
}

// ------------------------------------------------------------------ paths
class Path {
  constructor(xs, zs, ys, closed = true) { this.x = xs; this.z = zs; this.y = ys; this.n = xs.length; this.closed = closed; this.seg = new Float32Array(this.n); let L = 0; for (let i = 0; i < this.n - (closed ? 0 : 1); i++) { const j = (i + 1) % this.n; this.seg[i] = L; L += Math.hypot(xs[j] - xs[i], zs[j] - zs[i]); } this.len = L; this.step = L / (this.n - (closed ? 0 : 1)); }
  // uniform-ish sampling (paths are resampled uniformly so i ~ s/step)
  sample(s, o) {
    s = ((s % this.len) + this.len) % this.len;
    let i = Math.min(this.n - 1, Math.floor(s / this.step));
    while (i > 0 && this.seg[i] > s) i--;
    while (i < this.n - 1 && this.seg[i + 1] <= s && this.seg[i + 1] > 0) i++;
    const j = (i + 1) % this.n; const segL = (j === 0 ? this.len : this.seg[j]) - this.seg[i];
    const t = segL > 0 ? (s - this.seg[i]) / segL : 0;
    const dx = this.x[j] - this.x[i], dz = this.z[j] - this.z[i], dy = this.y[j] - this.y[i];
    o.x = this.x[i] + dx * t; o.z = this.z[i] + dz * t; o.y = this.y[i] + dy * t;
    o.yaw = Math.atan2(-dz, dx); o.pitch = Math.atan2(dy, Math.hypot(dx, dz) || 1);
    return o;
  }
}
function resample(pts, step, closed) {
  const out = []; const n = pts.length; const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % n]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); const k = Math.max(1, Math.round(L / step));
    for (let j = 0; j < k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}
function smoothLoop(pts, it = 3) {
  let p = pts;
  for (let k = 0; k < it; k++) p = p.map((v, i) => { const a = p[(i - 1 + p.length) % p.length], b = p[(i + 1) % p.length]; return [(a[0] + 2 * v[0] + b[0]) / 4, (a[1] + 2 * v[1] + b[1]) / 4]; });
  return p;
}
function offsetLoop(pts, off) {
  const n = pts.length;
  return pts.map((p, i) => { const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n]; const d = norm2([b[0] - a[0], b[1] - a[1]]); return [p[0] - d[1] * off, p[1] + d[0] * off]; });
}

// ------------------------------------------------------------------ palettes
const PAINT = [[0.9, 0.9, 0.91], [0.9, 0.9, 0.91], [0.92, 0.92, 0.9], [0.9, 0.9, 0.91], [0.03, 0.03, 0.035], [0.03, 0.03, 0.035], [0.04, 0.04, 0.05], [0.55, 0.57, 0.6], [0.6, 0.62, 0.64], [0.5, 0.52, 0.55], [0.28, 0.3, 0.32], [0.25, 0.26, 0.28], [0.05, 0.1, 0.28], [0.08, 0.14, 0.32], [0.45, 0.03, 0.03], [0.55, 0.06, 0.04], [0.1, 0.22, 0.13], [0.5, 0.42, 0.3], [0.7, 0.45, 0.08], [0.25, 0.42, 0.62]];
const SHIRT = [[0.85, 0.85, 0.85], [0.1, 0.12, 0.2], [0.55, 0.08, 0.08], [0.15, 0.3, 0.55], [0.2, 0.35, 0.2], [0.75, 0.6, 0.2], [0.05, 0.05, 0.05], [0.6, 0.6, 0.62], [0.82, 0.45, 0.5], [0.95, 0.75, 0.3], [0.35, 0.2, 0.4], [0.9, 0.9, 0.86]];
const PANTS = [[0.12, 0.17, 0.3], [0.1, 0.13, 0.24], [0.06, 0.06, 0.07], [0.3, 0.27, 0.22], [0.5, 0.45, 0.35], [0.18, 0.18, 0.2], [0.2, 0.25, 0.4]];
const SKIN = [[0.95, 0.76, 0.62], [0.87, 0.66, 0.5], [0.72, 0.52, 0.38], [0.55, 0.37, 0.25], [0.38, 0.25, 0.17], [0.98, 0.82, 0.7]];
const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];

// ------------------------------------------------------------------ main builder
export async function buildLife(scene, opts = {}) {
  const group = new THREE.Group(); group.name = 'life'; scene.add(group);
  const rnd = mulberry(90210);
  const tmp = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  const stats = {};
  let trafficEnabled = true;

  // ---------- vehicles
  const carMat = lifeMaterial({ glossy: true, rough: 0.6 });
  const VT = {
    sedan: sedanGeo(), suv: suvGeo(), pickup: pickupGeo(), truck: truckGeo(), bus: busGeo(),
    baggage: serviceCartGeo('baggage'), catering: serviceCartGeo('catering'),
    stairs: serviceCartGeo('stairs'), gpu: serviceCartGeo('gpu'), tug: serviceCartGeo('tug'),
  };
  const VMAX = { sedan: 1400, suv: 1000, pickup: 700, truck: 400, bus: 40, baggage: 80, catering: 50, stairs: 50, gpu: 50, tug: 50 };
  const vpools = {}; for (const k in VT) { vpools[k] = new Pool(VT[k], carMat, VMAX[k], { cast: true }); group.add(vpools[k].mesh); }
  const cars = []; const parked = [];
  const pickType = (kind) => {
    const r = rnd();
    if (kind === 'hwy') return r < 0.4 ? 'sedan' : r < 0.68 ? 'suv' : r < 0.83 ? 'pickup' : 'truck';
    if (kind === 'rural') return r < 0.45 ? 'pickup' : r < 0.7 ? 'suv' : r < 0.95 ? 'sedan' : 'truck';
    if (kind === 'town') return r < 0.47 ? 'sedan' : r < 0.78 ? 'suv' : r < 0.94 ? 'pickup' : r < 0.97 ? 'truck' : 'bus';
    return r < 0.45 ? 'sedan' : r < 0.75 ? 'suv' : r < 0.93 ? 'pickup' : 'truck';
  };
  const truckBox = () => pick(rnd, [[0.92, 0.92, 0.92], [0.92, 0.92, 0.92], [0.85, 0.85, 0.82], [0.75, 0.1, 0.08], [0.1, 0.25, 0.55]]);
  // road traffic is streamed around the camera on the real OSM network (right-hand traffic)
  const streetsNear = opts.streets || (() => []);
  let candMajor = [], candStreet = [], candAt = null;
  const refreshCandidates = (cam) => {
    candAt = { x: cam.x, z: cam.z };
    const R = 3500; candMajor = roadsInBox(cam.x - R, cam.z - R, cam.x + R, cam.z + R);
    candStreet = streetsNear(cam.x, cam.z, 1600);
  };
  const LANE = 3.5;
  const buildCarPath = (r, cam, maxR) => {
    const n = r.pts.length / 2; if (n < 2) return null;
    // start at a vertex near the camera
    let best = -1, tries = 0;
    while (tries++ < 6) { const i = Math.floor(rnd() * (n - 1)); const dx = r.pts[i * 2] - cam.x, dz = r.pts[i * 2 + 1] - cam.z; if (dx * dx + dz * dz < maxR * maxR) { best = i; break; } }
    if (best < 0) return null;
    const dir = r.oneway ? 1 : rnd() < 0.5 ? 1 : -1;
    const lanesDir = r.oneway ? r.lanes : Math.max(1, Math.floor(r.lanes / 2));
    const lane = Math.floor(rnd() * lanesDir);
    const off = r.oneway ? (lane + 0.5) * Math.min(LANE, r.w / r.lanes) - (r.lanes * Math.min(LANE, r.w / r.lanes)) / 2 : (lane + 0.5) * Math.min(LANE, r.w / Math.max(2, r.lanes));
    const raw = []; let L = 0;
    for (let k = best; k >= 0 && k < n && L < 2500; k += dir) { raw.push([r.pts[k * 2], r.pts[k * 2 + 1], r.ys ? r.ys[k] : null]); if (raw.length > 1) { const a = raw[raw.length - 2], b = raw[raw.length - 1]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); } }
    if (raw.length < 2 || L < 40) return null;
    const xs = [], zs = [], ys = [];
    const lift = r.cls === 'street' && opts.flatStreets ? 0.06 : 0.32;
    for (let i = 0; i < raw.length - 1; i++) {
      const a = raw[i], b = raw[i + 1]; const d = norm2([b[0] - a[0], b[1] - a[1]]); const SL = Math.hypot(b[0] - a[0], b[1] - a[1]); const m = Math.max(1, Math.ceil(SL / 14));
      for (let j = 0; j < m; j++) {
        const t = j / m; const x = a[0] + (b[0] - a[0]) * t - d[1] * off, z = a[1] + (b[1] - a[1]) * t + d[0] * off;
        xs.push(x); zs.push(z); ys.push(a[2] != null ? a[2] + (b[2] - a[2]) * t + 0.2 : Math.max(heightAt(x, z), 0.8) + lift);
      }
    }
    const e = raw[raw.length - 1], p = raw[raw.length - 2], d = norm2([e[0] - p[0], e[1] - p[1]]);
    xs.push(e[0] - d[1] * off); zs.push(e[1] + d[0] * off); ys.push(e[2] != null ? e[2] + 0.2 : Math.max(heightAt(e[0], e[1]), 0.8) + lift);
    return new Path(Float32Array.from(xs), Float32Array.from(zs), Float32Array.from(ys), false);
  };
  const kindOf = (r) => (r.cls === 'hwy' ? 'hwy' : r.cls === 'street' ? 'town' : townAt(r.pts[0], r.pts[1]) > 0.3 ? 'town' : 'rural');
  const spawnCar = (c, cam) => {
    if (!candAt) refreshCandidates(cam);
    for (let k = 0; k < 4; k++) {
      const useStreet = candStreet.length && (rnd() < 0.4 || !candMajor.length);
      const list = useStreet ? candStreet : candMajor; if (!list.length) break;
      const r = useStreet ? list[Math.floor(rnd() * list.length)] : ROADS[list[Math.floor(rnd() * list.length)]];
      const path = buildCarPath(r, cam, useStreet ? 1500 : 3200); if (!path) continue;
      const kind = kindOf(r);
      c.path = path; c.s = rnd() * Math.min(200, path.len * 0.5); c.v = r.speed * (0.85 + rnd() * 0.25);
      c.type = (kind === 'hwy' && rnd() < 0.18) ? 'truck' : pickType(kind); c.c1 = pick(rnd, PAINT); c.c2 = truckBox();
      if (c.type === 'bus') c.c1 = [0.98, 0.72, 0.05];
      return true;
    }
    c.path = null; return false;
  };
  const NCARS = opts.cars || 360;
  for (let i = 0; i < NCARS; i++) cars.push({ path: null, s: 0, v: 0, type: 'sedan', c1: PAINT[0], c2: [1, 1, 1], lift: true });
  // airport ramp people and ground-service trucks (on the real aprons near the GA ramp / terminals)
  const rampPeople = [];
  for (const a of AIRPORTS) {
    const tr = mulberry(31337 + a.icao.charCodeAt(1) * 100 + a.icao.charCodeAt(2) * 10 + a.icao.charCodeAt(3));
    const onApron = (x, z) => a.aprons.some((ap) => pointInPoly(x, z, ap.p));
    const R = a.ramp; const fx = Math.sin(R.hdg * Math.PI / 180), fz = -Math.cos(R.hdg * Math.PI / 180);
    const at = (u, v) => ({ x: R.x - fz * u + fx * v, z: R.z + fx * u + fz * v });
    const isMajor = ['KSFO', 'KOAK', 'KSJC'].includes(a.icao);
    const yaw = Math.atan2(-fz, fx);
    const types = isMajor ? ['baggage', 'catering', 'stairs', 'gpu', 'tug', 'baggage', 'tug'] : ['gpu', 'tug', 'pickup'];
    const COL = { baggage: [[0.95, 0.62, 0.08], [0.12, 0.35, 0.58]], catering: [[0.82, 0.84, 0.82], [0.12, 0.35, 0.58]], stairs: [[0.95, 0.62, 0.08], [0.82, 0.84, 0.82]], gpu: [[0.12, 0.35, 0.58], [0.82, 0.84, 0.82]], tug: [[0.95, 0.62, 0.08], [0.12, 0.35, 0.58]], pickup: [[0.95, 0.95, 0.92], [0.92, 0.92, 0.9]] };
    types.forEach((type, i) => {
      for (let k = 0; k < 6; k++) {
        const p = at(-40 + i * 11 + (tr() - 0.5) * 6, -30 - tr() * 25);
        if (!onApron(p.x, p.z)) continue;
        parked.push({ x: p.x, y: heightAt(p.x, p.z) + 0.05, z: p.z, yaw: yaw + (tr() - 0.5) * 0.6, type, c1: COL[type][0], c2: COL[type][1] }); break;
      }
    });
    const f = at(55, -35); if (onApron(f.x, f.z)) parked.push({ x: f.x, y: heightAt(f.x, f.z) + 0.05, z: f.z, yaw, type: 'truck', c1: [0.85, 0.1, 0.08], c2: [0.92, 0.92, 0.9] });
    const nP = isMajor ? 8 : 3;
    for (let i = 0; i < nP; i++) {
      const A = at((tr() - 0.5) * 80, -10 - tr() * 40), B = at((tr() - 0.5) * 80, -10 - tr() * 40);
      if (!onApron(A.x, A.z) || !onApron(B.x, B.z)) continue;
      const pts = resample([[A.x, A.z], [B.x, B.z]], 2, false); const all = pts.concat(pts.slice().reverse());
      const path = new Path(Float32Array.from(all.map((p) => p[0])), Float32Array.from(all.map((p) => p[1])), Float32Array.from(all.map((p) => heightAt(p[0], p[1]) + 0.02)));
      rampPeople.push({ path, s: tr() * path.len, v: i < 1 ? 0 : 1.1 + tr() * 0.4, ph: tr() * TAU, sc: 0.95 + tr() * 0.1, c1: i % 2 === 0 ? [0.95, 0.55, 0.05] : pick(tr, SHIRT), c2: pick(tr, PANTS), c3: pick(tr, SKIN), turn: tr() * TAU });
    }
  }
  if (opts.houses) for (const h of opts.houses) { // driveway cars
    if (rnd() < 0.55) continue;
    const c = Math.cos(h.rot), s = Math.sin(h.rot);
    const ox = h.w / 2 + 2.2;
    parked.push({ x: h.x + c * ox, y: h.h + 0.05, z: h.z - s * ox, yaw: h.rot + Math.PI / 2 * (rnd() < 0.5 ? 1 : -1), type: rnd() < 0.5 ? 'sedan' : rnd() < 0.6 ? 'suv' : 'pickup', c1: pick(rnd, PAINT), c2: [1, 1, 1] });
  }
  stats.cars = cars.length; stats.parked = parked.length;
  for (const c of cars) if (c.type === 'bus') c.c1 = [0.98, 0.72, 0.05];

  // ---------- people
  const personMat = lifeMaterial({ rough: 0.9 });
  const ppl = new Pool(personGeo(), personMat, 2600, { cast: true }); group.add(ppl.mesh);

  // ---------- farms, livestock
  // paddock must be dry, gentle and roughly planar
  const padOK = (p) => { for (let i = -1; i <= 1; i += 0.5) for (let j = -1; j <= 1; j += 0.5) { const X = p.cx + p.fx * p.hd * i + p.lx * p.hw * j, Z = p.cz + p.fz * p.hd * i + p.lz * p.hw * j; const hh = heightAt(X, Z); if (hh < WATER_LEVEL + 2 || Math.abs(hh - p.h(X, Z)) > 5 || roadNear(X, Z, 8)) return false; } return true; };
  const farmMat = lifeMaterial({ rough: 0.85, plank: true });
  const farms = [];
  const tooClose = (x, z, d) => farms.some((f) => Math.abs(f.x - x) < d && Math.abs(f.z - z) < d && Math.hypot(f.x - x, f.z - z) < d);
  if (opts.realFarms) {
    // real farmsteads (OSM farmyards) with their nearest real pasture: buildings come from the OSM footprints,
    // here we only add the livestock, fences and hay bales
    const fr = mulberry(4242);
    for (const [px, pz, ang, meadow, yx, yz] of opts.realFarms) {
      if (farms.length > 400) break;
      const fx = Math.cos(ang), fz = Math.sin(ang), lx = -fz, lz = fx;
      const pw = 60 + fr() * 40, pd = 45 + fr() * 35;
      const pad = { cx: px, cz: pz, fx, fz, lx, lz, hw: pw / 2, hd: pd / 2 };
      const hC = heightAt(px, pz); const gx = (heightAt(px + 10, pz) - heightAt(px - 10, pz)) / 20, gz = (heightAt(px, pz + 10) - heightAt(px, pz - 10)) / 20;
      pad.h = (X, Z) => hC + gx * (X - px) + gz * (Z - pz);
      const farm = { x: yx, z: yz, items: [], pad, animals: [], bales: [], drive: null };
      const kind = fr();
      farm.species = !padOK(pad) ? null : kind < (meadow ? 0.6 : 0.4) ? 'cow' : kind < 0.75 ? 'sheep' : kind < 0.9 ? 'horse' : null;
      if (farm.species) {
        const n = farm.species === 'cow' ? 8 + Math.floor(fr() * 16) : farm.species === 'sheep' ? 12 + Math.floor(fr() * 20) : 3 + Math.floor(fr() * 5);
        const breed = fr();
        for (let k = 0; k < n; k++) farm.animals.push(newAnimal(fr, farm.species, pad, breed));
      }
      if (fr() < 0.5) { const cx = yx + (px - yx) * 0.4, cz = yz + (pz - yz) * 0.4; for (let k = 0; k < 5 + fr() * 8; k++) { const bx = cx + (fr() - 0.5) * 30, bz = cz + (fr() - 0.5) * 30; if (roadNear(bx, bz, 6)) continue; farm.bales.push([bx, heightAt(bx, bz), bz, fr() * TAU]); } }
      farms.push(farm);
    }
  } else for (const r of ROADS) {
    if (r.cls !== 'road' || r.len < 1200 || farms.length > 320) continue;
    if (townAt(r.pts[0], r.pts[1]) > 0.1) continue;
    const fr = mulberry(r.pts.length * 9973 + (r.pts[0] | 0));
    const N = r.pts.length / 2;
    for (let s = 300 + fr() * 600; s < r.len - 200; s += 700 + fr() * 900) {
      let i = 0; while (i < N - 2 && r.cum[i + 1] < s) i++;
      const a = [r.pts[i * 2], r.pts[i * 2 + 1]], b = [r.pts[i * 2 + 2], r.pts[i * 2 + 3]];
      const d = norm2([b[0] - a[0], b[1] - a[1]]); const side = fr() < 0.5 ? -1 : 1;
      const off = r.w / 2 + 55 + fr() * 50;
      const x = a[0] - d[1] * off * side, z = a[1] + d[0] * off * side;
      const h = heightAt(x, z); if (h < WATER_LEVEL + 3 || waterFrac(x, z) > 0.1) continue;
      const slope = 1 - normalAt(x, z, 25)[1]; if (slope > 0.06) continue;
      if (farmAt(x, z) < 0.35) continue;
      if (townAt(x, z) > 0.05) continue;
      if (airportAt(x, z)) continue;
      const rn = roadNear(x, z, 45); if (rn) continue;
      if (tooClose(x, z, 420)) continue;
      // local frame: f points from farm toward road
      const fx = d[1] * side, fz = -d[0] * side; const lx = -fz, lz = fx;
      const L = (u, v) => ({ x: x + fx * u + lx * v, z: z + fz * u + lz * v });
      const yawF = Math.atan2(-fz, fx);
      const ground = (p) => Math.min(heightAt(p.x, p.z), heightAt(p.x + 4, p.z + 4), heightAt(p.x - 4, p.z - 4)) - 0.25;
      const farm = { x, z, yaw: yawF, L, ground, items: [] };
      const hp = L(0, 0); farm.items.push(['house', hp.x, ground(hp), hp.z, Math.atan2(fx, fz)]);
      const bp = L(-42, 8 * (fr() < 0.5 ? -1 : 1)); farm.items.push(['barn', bp.x, ground(bp), bp.z, yawF]);
      const nS = 1 + Math.floor(fr() * 3); for (let k = 0; k < nS; k++) { const sp = L(-38 - k * 6.5, -18); farm.items.push(['silo', sp.x, ground(sp), sp.z, 0, fr() < 0.3 ? [0.12, 0.22, 0.45] : [0.78, 0.77, 0.74]]); }
      if (fr() < 0.7) { const sp = L(-20, 30); farm.items.push(['shed', sp.x, ground(sp), sp.z, yawF + Math.PI / 2]); }
      // paddock
      const kind = fr(); const pc = L(-115, 0); const pw = 70 + fr() * 50, pd = 55 + fr() * 40;
      farm.pad = { cx: pc.x, cz: pc.z, fx, fz, lx, lz, hw: pw / 2, hd: pd / 2 };
      const hC = heightAt(pc.x, pc.z); const gx = (heightAt(pc.x + 10, pc.z) - heightAt(pc.x - 10, pc.z)) / 20, gz = (heightAt(pc.x, pc.z + 10) - heightAt(pc.x, pc.z - 10)) / 20;
      farm.pad.h = (X, Z) => hC + gx * (X - pc.x) + gz * (Z - pc.z);
      farm.species = !padOK(farm.pad) ? null : kind < 0.45 ? 'cow' : kind < 0.65 ? 'sheep' : kind < 0.8 ? 'horse' : null;
      farm.animals = [];
      if (farm.species) {
        const n = farm.species === 'cow' ? 8 + Math.floor(fr() * 16) : farm.species === 'sheep' ? 12 + Math.floor(fr() * 20) : 3 + Math.floor(fr() * 5);
        const breed = fr();
        for (let k = 0; k < n; k++) farm.animals.push(newAnimal(fr, farm.species, farm.pad, breed));
      }
      // driveway (gravel) from road edge to house
      const e = { x: a[0] - d[1] * (r.w / 2) * side, z: a[1] + d[0] * (r.w / 2) * side };
      farm.drive = [e, L(4, 0)];
      // bales
      farm.bales = []; if (fr() < 0.6) { const c = L(40 + fr() * 60, 60 + fr() * 80); for (let k = 0; k < 6 + fr() * 8; k++) { const bx = c.x + (fr() - 0.5) * 70, bz = c.z + (fr() - 0.5) * 70; farm.bales.push([bx, heightAt(bx, bz), bz, fr() * TAU]); } }
      farms.push(farm);
    }
  }
  // free-range herds in open farmland (no buildings)
  const herds = [];
  const rx = () => WORLD.x0 + 2000 + rnd() * (WORLD.x1 - WORLD.x0 - 4000), rz = () => WORLD.z0 + 2000 + rnd() * (WORLD.z1 - WORLD.z0 - 4000);
  for (let i = 0; i < 2500 && herds.length < 160; i++) {
    // cattle graze the open grassland hills all around the bay
    const x = rx(), z = rz(); const h = heightAt(x, z);
    if (h < WATER_LEVEL + 8 || waterFrac(x, z) > 0.05) continue; const sl = 1 - normalAt(x, z, 20)[1]; if (sl > 0.1) continue;
    if (forestAt(x, z, h, sl) > 0.15 || townAt(x, z) > 0.02 || farmAt(x, z) > 0.5 || roadNear(x, z, 60)) continue;
    if (airportAt(x, z)) continue;
    const a = rnd() * TAU; const fx = Math.cos(a), fz = Math.sin(a);
    const pad = { cx: x, cz: z, fx, fz, lx: -fz, lz: fx, hw: 60 + rnd() * 50, hd: 40 + rnd() * 40 };
    const gx = (heightAt(x + 10, z) - heightAt(x - 10, z)) / 20, gz = (heightAt(x, z + 10) - heightAt(x, z - 10)) / 20; pad.h = (X, Z) => h + gx * (X - x) + gz * (Z - z);
    if (!padOK(pad)) continue;
    const sp = rnd() < 0.85 ? 'cow' : 'sheep'; const breed = rnd();
    const animals = []; for (let k = 0, n = sp === 'cow' ? 6 + rnd() * 14 : 10 + rnd() * 20; k < n; k++) animals.push(newAnimal(rnd, sp, pad, breed));
    herds.push({ x, z, pad, species: sp, animals });
  }
  // deer at forest edges
  for (let i = 0; i < 3000 && herds.filter((h) => h.species === 'deer').length < 60; i++) {
    const x = rx(), z = rz(); const h = heightAt(x, z);
    if (h < WATER_LEVEL + 3 || h > 1300) continue; const sl = 1 - normalAt(x, z, 15)[1]; if (sl > 0.15) continue;
    const f = forestAt(x, z, h, sl); if (f < 0.2 || f > 0.6) continue;
    if (townAt(x, z) > 0.05 || roadNear(x, z, 50)) continue;
    const pad = { cx: x, cz: z, fx: 1, fz: 0, lx: 0, lz: 1, hw: 45, hd: 45 };
    const gx = (heightAt(x + 10, z) - heightAt(x - 10, z)) / 20, gz = (heightAt(x, z + 10) - heightAt(x, z - 10)) / 20; pad.h = (X, Z) => h + gx * (X - x) + gz * (Z - z);
    if (!padOK(pad)) continue;
    const animals = []; for (let k = 0, n = 2 + rnd() * 5; k < n; k++) animals.push(newAnimal(rnd, 'deer', pad, 0));
    herds.push({ x, z, pad, species: 'deer', animals });
  }
  for (const f of farms) if (f.species) herds.push({ x: f.pad.cx, z: f.pad.cz, pad: f.pad, species: f.species, animals: f.animals });
  stats.farms = farms.length; stats.herds = herds.length; stats.animals = herds.reduce((a, h) => a + h.animals.length, 0);

  const animalMat = lifeMaterial({ spots: true, rough: 0.95 });
  const apools = {
    cow: new Pool(quadruped({ L: 2.3, H: 1.42, bodyR: 0.4, legR: 0.075, neck: 0.5, headL: 0.52, headR: 0.15, horns: false, tail: 0.85, udder: true }), animalMat, 2600),
    horse: new Pool(quadruped({ L: 2.1, H: 1.6, bodyR: 0.33, legR: 0.055, neck: 0.85, headL: 0.6, headR: 0.12, tail: 0.75, mane: [0.08, 0.06, 0.05], hoof: [0.15, 0.13, 0.12] }), animalMat, 500),
    deer: new Pool(quadruped({ L: 1.45, H: 1.05, bodyR: 0.24, legR: 0.035, neck: 0.5, headL: 0.36, headR: 0.09, tail: 0.15, hoof: [0.1, 0.08, 0.07] }), animalMat, 400),
    sheep: new Pool(sheepGeo(), animalMat, 2400),
  };
  for (const k in apools) group.add(apools[k].mesh);
  const fpools = {
    house: new Pool(farmhouseGeo(), farmMat, 400, { cast: true }), barn: new Pool(barnGeo(), farmMat, 400, { cast: true }), silo: new Pool(siloGeo(), farmMat, 1200, { cast: true }), shed: new Pool(shedGeo(), farmMat, 400, { cast: true }),
    fence: new Pool(fenceGeo(), farmMat, 30000), bale: new Pool(baleGeo(), farmMat, 3000, { cast: true }),
  };
  for (const k in fpools) group.add(fpools[k].mesh);
  // static farm buildings once
  for (const k of ['house', 'barn', 'silo', 'shed']) fpools[k].begin();
  for (const f of farms) for (const it of f.items) fpools[it[0]].push(it[1], it[2], it[3], it[4], 0, 1, 0, 0, 0, 0, it[5] || [0.78, 0.77, 0.74], [1, 1, 1], [1, 1, 1]);
  for (const k of ['house', 'barn', 'silo', 'shed']) fpools[k].end();
  stats.farmBuildings = farms.reduce((a, f) => a + f.items.length, 0);
  // gravel driveways
  {
    const Pp = [], I = [];
    for (const f of farms) {
      if (!f.drive) continue;
      const [A, B] = f.drive; const L = Math.hypot(B.x - A.x, B.z - A.z); const n = Math.max(2, Math.ceil(L / 6));
      const dx = (B.x - A.x) / L, dz = (B.z - A.z) / L; const base = Pp.length / 3;
      for (let i = 0; i <= n; i++) { const x = A.x + (B.x - A.x) * i / n, z = A.z + (B.z - A.z) * i / n; for (const s of [-1, 1]) { const px = x - dz * 2.2 * s, pz = z + dx * 2.2 * s; Pp.push(px, heightAt(px, pz) + 0.1, pz); } }
      for (let i = 0; i < n; i++) { const a = base + i * 2; I.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(Pp, 3)); g.setIndex(I); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x8d8170, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })); m.receiveShadow = true; group.add(m);
  }

  // ---------- birds
  const birdMat = lifeMaterial({ rough: 0.9 });
  const bpool = new Pool(birdGeo(), birdMat, 900); group.add(bpool.mesh);
  const flocks = [];
  const shore = () => { for (let k = 0; k < 200; k++) { const x = rx(), z = rz(); const w = waterFrac(x, z); if (w > 0.2 && w < 0.8) return [x, z]; } return [0, 0]; };
  for (let i = 0; i < 70; i++) {
    let x, z, kind;
    if (i < 22) { [x, z] = shore(); kind = 'gull'; }
    else if (i < 36) { x = rx(); z = rz(); kind = 'hawk'; }
    else { const T = pick(rnd, TOWNS); x = T.x + (rnd() - 0.5) * 4000; z = T.z + (rnd() - 0.5) * 4000; kind = 'small'; }
    const n = kind === 'hawk' ? 1 + Math.floor(rnd() * 2) : kind === 'gull' ? 6 + Math.floor(rnd() * 10) : 10 + Math.floor(rnd() * 24);
    const R = kind === 'hawk' ? 90 + rnd() * 120 : 120 + rnd() * 260;
    const birds = []; for (let k = 0; k < n; k++) birds.push({ da: (rnd() - 0.5) * (kind === 'small' ? 0.35 : 0.6), dr: (rnd() - 0.5) * 30, dy: (rnd() - 0.5) * 14, ph: rnd() * TAU, glide: 0, gt: rnd() * 3 });
    flocks.push({ x, z, R, kind, n, a: rnd() * TAU, w: (kind === 'hawk' ? 7 : 12) / R * (rnd() < 0.5 ? 1 : -1), agl: kind === 'hawk' ? 250 + rnd() * 400 : kind === 'gull' ? 25 + rnd() * 80 : 30 + rnd() * 160, birds, drift: [(rnd() - 0.5) * 3, (rnd() - 0.5) * 3] });
  }
  const BIRDC = { small: [[0.18, 0.16, 0.14], [0.12, 0.11, 0.1]], gull: [[0.95, 0.95, 0.95], [0.75, 0.77, 0.8]], hawk: [[0.42, 0.3, 0.2], [0.3, 0.22, 0.15]] };

  // ---------- boats
  const boatMat = lifeMaterial({ glossy: true, rough: 0.5, double: true });
  const sailPool = new Pool(boatGeo(true), boatMat, 70), motorPool = new Pool(boatGeo(false), boatMat, 70);
  group.add(sailPool.mesh); group.add(motorPool.mesh);
  const wakeTex = (() => { const c = document.createElement('canvas'); c.width = 64; c.height = 256; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, 'rgba(255,255,255,0.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 256); const t = new THREE.CanvasTexture(c); return t; })();
  const wakeMesh = new THREE.InstancedMesh(wakeGeo(), new THREE.MeshBasicMaterial({ map: wakeTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -4 }), 70);
  wakeMesh.frustumCulled = false; wakeMesh.count = 0; group.add(wakeMesh);
  const boats = [];
  // sailing / motor boats around the bay (Sausalito, Berkeley, Alameda, SF waterfront are busiest)
  const marinas = [[37.86, -122.47], [37.81, -122.44], [37.86, -122.33], [37.78, -122.27], [37.70, -122.37], [37.58, -122.25], [38.05, -122.40], [37.88, -122.40]].map(([la, lo]) => ll2w(la, lo));
  for (let i = 0; i < 1500 && boats.length < 60; i++) {
    const m = marinas[i % marinas.length];
    const cx = m.x + (rnd() - 0.5) * 6000, cz = m.z + (rnd() - 0.5) * 6000; const rx = 150 + rnd() * 900, rz = 100 + rnd() * 600; const rot = rnd() * TAU;
    let ok = true; const pts = [];
    for (let k = 0; k < 64; k++) { const a = k / 64 * TAU; const ex = Math.cos(a) * rx, ez = Math.sin(a) * rz; const x = cx + ex * Math.cos(rot) - ez * Math.sin(rot), z = cz + ex * Math.sin(rot) + ez * Math.cos(rot); if (heightAt(x, z) > WATER_LEVEL - 1.5 || waterFrac(x, z) < 0.95 || waterFrac(x + 40, z) < 0.9 || waterFrac(x, z + 40) < 0.9) { ok = false; break; } pts.push([x, z]); }
    if (!ok) continue;
    const rp = resample(pts, 6, true); const sail = rnd() < 0.55;
    const path = new Path(Float32Array.from(rp.map((p) => p[0])), Float32Array.from(rp.map((p) => p[1])), new Float32Array(rp.length).fill(WATER_LEVEL));
    boats.push({ path, s: rnd() * path.len, v: (sail ? 2.5 + rnd() * 2 : 7 + rnd() * 6) * (rnd() < 0.5 ? 1 : -1), sail, c1: sail ? pick(rnd, [[0.95, 0.95, 0.95], [0.95, 0.95, 0.95], [0.1, 0.15, 0.35]]) : pick(rnd, [[0.95, 0.95, 0.95], [0.6, 0.08, 0.06], [0.1, 0.2, 0.45]]), c2: pick(rnd, [[0.1, 0.2, 0.5], [0.6, 0.08, 0.06], [0.08, 0.08, 0.08]]), ph: rnd() * TAU });
  }
  stats.boats = boats.length;

  // ---------- wind farm
  const turbines = [];
  { // Shiloh / Montezuma Hills wind farms, Solano County (38.10-38.16 N, 121.78-121.88 W)
    const c = ll2w(38.125, -121.83);
    for (let row = 0; row < 9; row++) for (let k = 0; k < 14; k++) {
      const x = c.x - 3600 + k * 520 + (row % 2) * 260 + (rnd() - 0.5) * 80, z = c.z - 3000 + row * 700 + (rnd() - 0.5) * 80; const h = heightAt(x, z);
      if (x > WORLD.x1 - 50 || h < WATER_LEVEL + 5 || waterFrac(x, z) > 0.05 || 1 - normalAt(x, z, 30)[1] > 0.12 || roadNear(x, z, 60) || townAt(x, z) > 0.05) continue;
      turbines.push({ x, y: h - 0.5, z, yaw: -Math.PI * 0.42 + (rnd() - 0.5) * 0.1, a: rnd() * TAU, w: 1.45 + rnd() * 0.25 });
    }
  }
  const turbMat = lifeMaterial({ rough: 0.5 });
  const towerPool = new Pool(turbineGeo(), turbMat, Math.max(1, turbines.length), { cast: true }), rotorMesh = new THREE.InstancedMesh(rotorGeo(), turbMat, Math.max(1, turbines.length));
  rotorMesh.geometry.setAttribute('aAnim', new THREE.InstancedBufferAttribute(new Float32Array(turbines.length * 4 + 4), 4));
  for (const k of ['aCol1', 'aCol2', 'aCol3']) rotorMesh.geometry.setAttribute(k, new THREE.InstancedBufferAttribute(new Float32Array(turbines.length * 3 + 3).fill(1), 3));
  rotorMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); rotorMesh.frustumCulled = false; rotorMesh.castShadow = true;
  group.add(towerPool.mesh); group.add(rotorMesh);
  towerPool.begin(); for (const t of turbines) towerPool.push(t.x, t.y, t.z, t.yaw, 0, 1, 0, 0, 0, 0, [1, 1, 1], [1, 1, 1], [1, 1, 1]); towerPool.end();
  const blink = lightMaterial(); blink.uniforms.uScale.value = 900;
  const blinkPts = makePoints(turbines.map((t) => ({ p: [t.x + Math.cos(t.yaw) * 1.5, t.y + 83.4, t.z - Math.sin(t.yaw) * 1.5], c: [1, 0.05, 0.02], s: 2.2 })), blink); group.add(blinkPts);
  stats.turbines = turbines.length;

  // ---------- vehicle lights (night)
  const VL = 6000; const vlPos = new Float32Array(VL * 3), vlCol = new Float32Array(VL * 3), vlSize = new Float32Array(VL);
  const vlGeo = new THREE.BufferGeometry(); vlGeo.setAttribute('position', new THREE.BufferAttribute(vlPos, 3).setUsage(THREE.DynamicDrawUsage)); vlGeo.setAttribute('color', new THREE.BufferAttribute(vlCol, 3).setUsage(THREE.DynamicDrawUsage)); vlGeo.setAttribute('size', new THREE.BufferAttribute(vlSize, 1).setUsage(THREE.DynamicDrawUsage));
  const vlMat = lightMaterial(); vlMat.uniforms.uScale.value = 420; const vlPts = new THREE.Points(vlGeo, vlMat); vlPts.frustumCulled = false; group.add(vlPts);
  const HL = { sedan: [2.3, 0.66, 0.6, -2.37, 0.82, 0.62], suv: [2.38, 0.86, 0.64, -2.44, 1.08, 0.78], pickup: [2.72, 0.94, 0.66, -2.79, 0.92, 0.88], truck: [3.3, 0.92, 0.85, -4.65, 0.95, 1.0], bus: [5.66, 1.1, 0.85, -5.25, 1.0, 1.0] };

  // ---------- per-frame update
  let night = 0, quality = 1, lastFence = null;
  // road traffic: 'moving' = animated cars, 'parked' = only parked cars (static, rebuilt when the camera moves), 'off' = none
  let roadMode = 'parked', lastPark = null;
  const pushFences = (cam) => {
    const fp = fpools.fence, bp = fpools.bale; fp.begin(); bp.begin();
    const R2 = (2600 * Math.max(0.5, quality)) ** 2;
    for (const f of farms) {
      const dx = f.x - cam.x, dz = f.z - cam.z; if (dx * dx + dz * dz > R2) continue;
      if (f.species) {
        const p = f.pad; const corners = [[-p.hd, -p.hw], [p.hd, -p.hw], [p.hd, p.hw], [-p.hd, p.hw]];
        for (let e = 0; e < 4; e++) {
          const [u0, v0] = corners[e], [u1, v1] = corners[(e + 1) % 4];
          const L = Math.hypot(u1 - u0, v1 - v0); const n = Math.floor(L / 3);
          for (let k = 0; k < n; k++) {
            const t = k / n; const u = u0 + (u1 - u0) * t, v = v0 + (v1 - v0) * t;
            const x = p.cx + p.fx * u + p.lx * v, z = p.cz + p.fz * u + p.lz * v;
            const dxw = p.fx * (u1 - u0) + p.lx * (v1 - v0), dzw = p.fz * (u1 - u0) + p.lz * (v1 - v0);
            fp.push(x, heightAt(x, z) - 0.05, z, Math.atan2(-dzw, dxw), 0, 1, 0, 0, 0, 0, [1, 1, 1], [1, 1, 1], [1, 1, 1]);
          }
        }
      }
      for (const b of f.bales) bp.push(b[0], b[1] - 0.1, b[2], b[3], 0, 1, 0, 0, 0, 0, [1, 1, 1], [1, 1, 1], [1, 1, 1]);
    }
    fp.end(); bp.end();
  };

  function update(cam, dt, t) {
    U_TIME.value = t; U_NIGHT.value = night;
    const camAgl = cam.y - heightAt(cam.x, cam.z);
    // vehicles
    const vR = (2600 + Math.min(1500, camAgl * 1.5)) * (0.55 + 0.45 * quality); const vR2 = vR * vR;
    let nl = 0; const lightsOn = night > 0.12; const lR2 = Math.min(vR2, 9000 * 9000);
    const addLights = (c, x, y, z, yaw) => {
      if (!lightsOn || nl > VL - 4) return;
      const L = HL[c.type]; const cy = Math.cos(yaw), sy = Math.sin(yaw);
      for (const s of [-1, 1]) {
        let lx = L[0], lz = L[2] * s; vlPos[nl * 3] = x + cy * lx + sy * lz; vlPos[nl * 3 + 1] = y + L[1]; vlPos[nl * 3 + 2] = z - sy * lx + cy * lz; vlCol[nl * 3] = 1; vlCol[nl * 3 + 1] = 0.92; vlCol[nl * 3 + 2] = 0.75; vlSize[nl] = 1.3; nl++;
        lx = L[3]; lz = L[5] * s; vlPos[nl * 3] = x + cy * lx + sy * lz; vlPos[nl * 3 + 1] = y + L[4]; vlPos[nl * 3 + 2] = z - sy * lx + cy * lz; vlCol[nl * 3] = 1; vlCol[nl * 3 + 1] = 0.05; vlCol[nl * 3 + 2] = 0.02; vlSize[nl] = 0.8; nl++;
      }
    };
    if (roadMode !== 'moving') {
      // no animation: vehicle instances only change when the camera has moved a fair distance
      if (!lastPark || lastPark.mode !== roadMode || Math.hypot(cam.x - lastPark.x, cam.z - lastPark.z) > 60) {
        lastPark = { x: cam.x, z: cam.z, mode: roadMode };
        for (const k in vpools) vpools[k].begin();
        if (roadMode === 'parked') {
          const pR2 = Math.min(vR2, 2500 * 2500);
          for (const c of parked) { const dx = c.x - cam.x, dz = c.z - cam.z; if (dx * dx + dz * dz > pR2) continue; vpools[c.type].push(c.x, c.y, c.z, c.yaw, 0, 1, 0, 0, 0, 0, c.c1, c.c2, null); }
        }
        for (const k in vpools) vpools[k].end();
        stats.visibleCars = Object.values(vpools).reduce((a, p) => a + p.n, 0);
      }
      vlGeo.setDrawRange(0, 0); vlPts.visible = false;
    } else {
    lastPark = null;
    for (const k in vpools) vpools[k].begin();
    if (!candAt || Math.hypot(cam.x - candAt.x, cam.z - candAt.z) > 600) refreshCandidates(cam);
    let spawns = 0;
    for (const c of cars) {
      if (!c.path) { if (spawns++ < 25) spawnCar(c, cam); if (!c.path) continue; }
      c.s += c.v * dt;
      if (c.s > c.path.len - 1) { c.path = null; continue; }
      const o = c.path.sample(c.s, tmp);
      const dx = o.x - cam.x, dz = o.z - cam.z, d2 = dx * dx + dz * dz; if (d2 > vR2 * 1.2) { c.path = null; continue; } if (d2 > vR2) continue;
      const lift = c.lift && d2 > 90000 ? Math.min(9, (Math.sqrt(d2) - 300) * 0.0016) : 0;
      vpools[c.type].push(o.x, o.y + lift, o.z, o.yaw, o.pitch, 1, 0, 0, 0, 0, c.c1, c.c2, null);
      if (d2 < lR2) addLights(c, o.x, o.y + lift, o.z, o.yaw);
    }
    const pR2 = Math.min(vR2, 2500 * 2500);
    for (const c of parked) { const dx = c.x - cam.x, dz = c.z - cam.z; if (dx * dx + dz * dz > pR2) continue; vpools[c.type].push(c.x, c.y, c.z, c.yaw, 0, 1, 0, 0, 0, 0, c.c1, c.c2, null); }
    for (const k in vpools) vpools[k].end();
    vlGeo.setDrawRange(0, nl); if (nl) { vlGeo.attributes.position.needsUpdate = true; vlGeo.attributes.color.needsUpdate = true; vlGeo.attributes.size.needsUpdate = true; }
    vlMat.uniforms.uNight.value = night; vlPts.visible = lightsOn;
    stats.visibleCars = Object.values(vpools).reduce((a, p) => a + p.n, 0);
    }

    // people
    ppl.begin();
    const hR = 1100 * (0.6 + 0.4 * quality), hR2 = hR * hR;
    const walkers = (list) => {
      for (const p of list) {
        if (p.v !== 0) { p.s += p.v * dt; p.ph += Math.abs(p.v) * dt * 4.3; }
        const o = p.path.sample(p.s, tmp);
        const dx = o.x - cam.x, dz = o.z - cam.z; if (dx * dx + dz * dz > hR2) continue;
        const yaw = p.v === 0 ? p.turn : o.yaw + (p.v < 0 ? Math.PI : 0);
        ppl.push(o.x, o.y, o.z, yaw, 0, p.sc, 0, p.ph, p.v === 0 ? 0.05 : 1, 0, p.c1, p.c2, p.c3);
      }
    };
    walkers(rampPeople);
    ppl.end(); stats.visiblePeople = ppl.n;

    // animals
    for (const k in apools) apools[k].begin();
    const aR = 1500 * (0.6 + 0.4 * quality), aR2 = aR * aR;
    for (const h of herds) {
      const dx = h.x - cam.x, dz = h.z - cam.z; if (dx * dx + dz * dz > (aR + 150) ** 2) continue;
      const pool = apools[h.species]; const p = h.pad;
      for (const an of h.animals) {
        stepAnimal(an, dt, p, rnd);
        const x = p.cx + p.fx * an.u + p.lx * an.v, z = p.cz + p.fz * an.u + p.lz * an.v;
        const ddx = x - cam.x, ddz = z - cam.z; if (ddx * ddx + ddz * ddz > aR2) continue;
        const yaw = an.yaw + Math.atan2(-p.fz, p.fx);
        if (an.hy === undefined || Math.abs(x - an.hx) + Math.abs(z - an.hz) > 1.2) { an.hy = heightAt(x, z); an.hx = x; an.hz = z; }
        pool.push(x, an.hy - 0.02, z, yaw, 0, an.sc, an.seed, an.gp, an.walk, an.graze, an.c1, an.c2, an.c3);
      }
    }
    for (const k in apools) apools[k].end();
    stats.visibleAnimals = Object.values(apools).reduce((a, p) => a + p.n, 0);

    // fences & bales re-gathered when the camera moves
    if (!lastFence || Math.hypot(cam.x - lastFence.x, cam.z - lastFence.z) > 300) { lastFence = { x: cam.x, z: cam.z }; pushFences(cam); }

    // birds
    bpool.begin();
    const bR = 1800, bR2 = bR * bR;
    for (const f of flocks) {
      f.a += f.w * dt; f.x += f.drift[0] * dt; f.z += f.drift[1] * dt;
      const dx = f.x - cam.x, dz = f.z - cam.z; if (dx * dx + dz * dz > (bR + f.R) ** 2) continue;
      const gh = Math.max(heightAt(f.x, f.z), WATER_LEVEL);
      const C = BIRDC[f.kind]; const sc = f.kind === 'hawk' ? 1.6 : f.kind === 'gull' ? 1.25 : 0.7;
      for (const b of f.birds) {
        b.gt -= dt; if (b.gt < 0) { b.glide = b.glide > 0.5 ? 0 : 1; b.gt = b.glide ? 1 + Math.random() * 2.5 : 1.5 + Math.random() * 3; }
        const flapF = f.kind === 'small' ? 48 : f.kind === 'gull' ? 20 : 12;
        const glide = f.kind === 'hawk' ? 1 : b.glide;
        if (glide < 0.5) b.ph += dt * flapF;
        const a = f.a + b.da, R = f.R + b.dr;
        const x = f.x + Math.cos(a) * R, z = f.z + Math.sin(a) * R;
        const y = gh + f.agl + b.dy + Math.sin(t * 0.7 + b.ph * 0.05) * 3;
        const tx = -Math.sin(a) * Math.sign(f.w), tz = Math.cos(a) * Math.sign(f.w);
        const bank = -Math.sign(f.w) * Math.min(0.6, Math.abs(f.w) * 2 * 12 / 9.81);
        bpool.push(x, y, z, Math.atan2(-tz, tx), 0, sc, 0, b.ph, 0, glide, C[0], C[1], [1, 1, 1], bank);
      }
    }
    bpool.end(); stats.visibleBirds = bpool.n;

    // boats
    sailPool.begin(); motorPool.begin(); let nw = 0;
    const wm = new THREE.Matrix4(), wq = new THREE.Quaternion(), wv = new THREE.Vector3(), ws = new THREE.Vector3(1, 1, 1);
    for (const b of boats) {
      b.s += b.v * dt; const o = b.path.sample(b.s, tmp);
      const dx = o.x - cam.x, dz = o.z - cam.z; if (dx * dx + dz * dz > 6000 * 6000) continue;
      const yaw = o.yaw + (b.v < 0 ? Math.PI : 0);
      const bob = Math.sin(t * 1.3 + b.ph) * 0.06;
      if (b.sail) sailPool.push(o.x, WATER_LEVEL + bob, o.z, yaw, Math.sin(t * 0.9 + b.ph) * 0.02, 1, 0, 0, 0, 0, b.c1, b.c2, null, (b.v > 0 ? 1 : -1) * 0.16);
      else {
        motorPool.push(o.x, WATER_LEVEL + bob, o.z, yaw, 0.05, 1, 0, 0, 0, 0, b.c1, b.c2, null);
        wq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw); wv.set(o.x - Math.cos(yaw) * 3, WATER_LEVEL + 0.05, o.z + Math.sin(yaw) * 3); wm.compose(wv, wq, ws); wakeMesh.setMatrixAt(nw++, wm);
      }
    }
    sailPool.end(); motorPool.end(); wakeMesh.count = nw; if (nw) wakeMesh.instanceMatrix.needsUpdate = true;

    // wind turbines
    const rm = new THREE.Matrix4(), rq = new THREE.Quaternion(), rq2 = new THREE.Quaternion(), rv = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    turbines.forEach((tb, i) => {
      tb.a += tb.w * dt;
      rq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), tb.yaw); rq2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), tb.a); rq.multiply(rq2);
      rv.set(tb.x + Math.cos(tb.yaw) * 6.6, tb.y + 81.5, tb.z - Math.sin(tb.yaw) * 6.6); rm.compose(rv, rq, one); rotorMesh.setMatrixAt(i, rm);
    });
    rotorMesh.count = turbines.length; rotorMesh.instanceMatrix.needsUpdate = true;
    blink.uniforms.uNight.value = 1; blinkPts.visible = (t % 2.0) < 0.9 && night > 0.05 || (t % 2.0) < 0.12;
  }

  return {
    group, stats, update,
    setNight(n) { night = n; },
    setTrafficEnabled(enabled) { trafficEnabled = enabled; },
    setRoadTraffic(mode) { roadMode = mode === 'off' || mode === 'moving' ? mode : 'parked'; lastPark = null; },
    get roadTraffic() { return roadMode; },
    set quality(q) { quality = q; lastFence = null; },
    get quality() { return quality; },
    farms, roads: ROADS, turbines, boats, herds,
  };
}

// ------------------------------------------------------------------ animal behaviour
function newAnimal(rnd, species, pad, breed) {
  const an = { species, u: (rnd() - 0.5) * pad.hd * 1.6, v: (rnd() - 0.5) * pad.hw * 1.6, yaw: rnd() * TAU, tu: 0, tv: 0, mode: 0, timer: rnd() * 8, gp: rnd() * TAU, walk: 0, graze: rnd() * 0.8, seed: rnd() * 10, sc: 0.9 + rnd() * 0.2 };
  const c3 = [1, 1, 1];
  if (species === 'cow') {
    if (breed < 0.45) { an.c1 = [0.93, 0.92, 0.88]; an.c2 = [0, 1, 0]; } // holstein: spots
    else if (breed < 0.75) { an.c1 = [0.05, 0.045, 0.04]; an.c2 = [0, 0, 0]; } // angus
    else { an.c1 = [0.42, 0.16, 0.07]; an.c2 = [0, 0, 0]; } // hereford / brown
    if (rnd() < 0.15) an.c1 = [0.55, 0.38, 0.22];
  } else if (species === 'sheep') { an.c1 = rnd() < 0.08 ? [0.15, 0.13, 0.12] : [0.86, 0.83, 0.74]; an.c2 = [0, 0, 0]; an.sc = 0.85 + rnd() * 0.25; }
  else if (species === 'horse') { an.c1 = pick(rnd, [[0.35, 0.18, 0.08], [0.22, 0.12, 0.06], [0.05, 0.04, 0.04], [0.55, 0.4, 0.25], [0.8, 0.78, 0.74], [0.45, 0.28, 0.14]]); an.c2 = [0, 0, 0]; }
  else { an.c1 = [0.5, 0.36, 0.22]; an.c2 = [0, 0, 0]; an.sc = 0.85 + rnd() * 0.3; }
  an.c3 = c3;
  return an;
}
function stepAnimal(an, dt, pad, rnd) {
  an.timer -= dt;
  const sp = an.species;
  if (an.timer <= 0) {
    if (an.mode === 0 && Math.random() < 0.55) { // start walking to a new spot
      an.mode = 1; const r = sp === 'deer' ? 30 : 18;
      an.tu = Math.max(-pad.hd + 3, Math.min(pad.hd - 3, an.u + (Math.random() - 0.5) * 2 * r));
      an.tv = Math.max(-pad.hw + 3, Math.min(pad.hw - 3, an.v + (Math.random() - 0.5) * 2 * r));
      an.speed = sp === 'horse' && Math.random() < 0.15 ? 4.5 : sp === 'deer' ? 1.4 + Math.random() * 1.5 : 0.7 + Math.random() * 0.5;
      an.timer = 30;
    } else { an.mode = 0; an.timer = 4 + Math.random() * (sp === 'deer' ? 8 : 18); }
  }
  let targetGraze = 0, walk = 0;
  if (an.mode === 1) {
    const du = an.tu - an.u, dv = an.tv - an.v; const d = Math.hypot(du, dv);
    if (d < 0.5) { an.mode = 0; an.timer = 4 + Math.random() * 14; }
    else {
      const want = Math.atan2(-dv, du); let dy = want - an.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      an.yaw += Math.max(-1.2 * dt, Math.min(1.2 * dt, dy));
      const fwd = Math.max(0, Math.cos(dy));
      const step = an.speed * fwd * dt; an.u += Math.cos(an.yaw) * step; an.v -= Math.sin(an.yaw) * step;
      walk = fwd; const stride = sp === 'sheep' ? 0.7 : sp === 'deer' ? 1.1 : 1.5;
      an.gp += an.speed * fwd * dt * TAU / stride;
    }
  } else { targetGraze = sp === 'deer' ? (Math.sin(an.seed + an.timer) > 0 ? 0.9 : 0.1) : 0.85; }
  an.walk += (walk - an.walk) * Math.min(1, dt * 4);
  an.graze += (targetGraze - an.graze) * Math.min(1, dt * 1.5);
}
