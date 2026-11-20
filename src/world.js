// Airports (runways, markings, taxiways, lights, PAPI, buildings), vegetation, photoscanned rocks, town.
import * as THREE from 'three';
import { heightAt, normalAt, surfaceAt, forestAt, farmAt, WATER_LEVEL, fromLocal, townAt } from './geo.js';
import { PH, PHM, tex, loadImage } from './textures.js';
import { hash2, mulberry } from './noise.js';
import { ROCKS } from './rockdata.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const D2R = Math.PI / 180;

// ---------------- light points (runway lights, PAPI, beacons) ----------------
const LIGHT_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 color; attribute float size; attribute float dir;
uniform float uScale; uniform float uNight; uniform vec3 uCamFwd;
varying vec3 vC; varying float vA;
void main(){
  vec4 mv = modelViewMatrix * vec4(position,1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  float s = size * uScale / max(d, 1.0);
  gl_PointSize = clamp(s, 2.0, 48.0);
  vA = clamp(s / 2.0, 0.35, 1.0) * mix(0.25, 1.0, uNight);
  vC = color;
  #include <logdepthbuf_vertex>
}`;
const LIGHT_FS = `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vC; varying float vA;
void main(){
  #include <logdepthbuf_fragment>
  vec2 p = gl_PointCoord*2.0-1.0; float r = dot(p,p);
  if (r>1.0) discard;
  float core = exp(-r*9.0), halo = exp(-r*2.5)*0.45;
  gl_FragColor = vec4(vC*(core*3.0+halo), (core+halo)*vA);
}`;
export function lightMaterial() {
  return new THREE.ShaderMaterial({ vertexShader: LIGHT_VS, fragmentShader: LIGHT_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uScale: { value: 600 }, uNight: { value: 0 }, uCamFwd: { value: new THREE.Vector3() } } });
}
function makePoints(list, mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(list.flatMap((l) => l.p)), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(list.flatMap((l) => l.c)), 3));
  g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(list.map((l) => l.s || 1)), 1));
  const p = new THREE.Points(g, mat); p.frustumCulled = false; return p;
}

// ---------------- surface strips that follow terrain ----------------
export function stripGeometry(a, u0, u1, v0, v1, du = 12, lift = 0.07, groundHeight = null) {
  const nu = Math.max(1, Math.ceil((u1 - u0) / du)), nv = Math.max(1, Math.ceil((v1 - v0) / 8));
  const pos = [], uv = [], uvm = [], idx = [];
  for (let j = 0; j <= nu; j++) for (let i = 0; i <= nv; i++) {
    const u = u0 + (u1 - u0) * j / nu, v = v0 + (v1 - v0) * i / nv;
    const { x, z } = fromLocal(a, u, v);
    pos.push(x, (groundHeight?.(x, z) ?? heightAt(x, z)) + lift, z);
    uv.push(v / 9, u / 9); uvm.push(i / nv, j / nu);
  }
  for (let j = 0; j < nu; j++) for (let i = 0; i < nv; i++) {
    const p = j * (nv + 1) + i, q = p + nv + 1;
    idx.push(p, p + 1, q, p + 1, q + 1, q);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('uvm', new THREE.Float32BufferAttribute(uvm, 2));
  g.setIndex(idx); g.computeVertexNormals();
  // force normals up (flat surfaces)
  const n = g.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return g;
}

export function pavementMaterial(asph, markTex, tint = 1) {
  const m = new THREE.MeshStandardMaterial({ map: asph.diff, normalMap: asph.nor, roughnessMap: asph.rough, roughness: 1, color: new THREE.Color(tint, tint, tint), normalScale: new THREE.Vector2(0.8, 0.8) });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uMark = { value: markTex };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 uvm; varying vec2 vUvm; varying vec3 vWp;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvUvm = uvm;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWp = (modelMatrix*vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D uMark; varying vec2 vUvm; varying vec3 vWp;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec4 mk = texture2D(uMark, vUvm);
        float macro = texture2D(map, vWp.xz*0.0061).g;
        diffuseColor.rgb *= 0.78 + 0.45*macro;
        float wear = smoothstep(0.25,0.75, texture2D(map, vWp.xz*0.031+0.3).r);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86,0.86,0.84), mk.r*(0.80+0.15*wear));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78,0.58,0.08), mk.g*(0.85));
        diffuseColor.rgb *= 1.0 - mk.b*0.62;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.55, max(mk.r,mk.g)); roughnessFactor = mix(roughnessFactor, 0.6, mk.b);');
  };
  m.userData.markTex = markTex;
  return m;
}

export function canvasTex(c) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.anisotropy = 16; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t;
}
// generic textured PBR set
async function pbr(name, repeat = 1, model = false) {
  const P = model ? PHM : PH;
  const [diff, nor, rough] = await Promise.all([tex(P(name, 'diff'), { repeat }), tex(P(name, 'nor_gl'), { repeat, srgb: false }), tex(P(name, 'rough'), { repeat, srgb: false })]);
  return { diff, nor, rough };
}
function boxUV(w, h, d, scale = 4) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv, p = g.attributes.position, n = g.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i));
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (ny > 0.5) uv.setXY(i, x / scale, z / scale); else if (nx > 0.5) uv.setXY(i, z / scale, y / scale); else uv.setXY(i, x / scale, y / scale);
  }
  return g;
}

// ---------------- Rocks (photoscanned, instanced) ----------------
function b64(s, T) { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new T(u8.buffer); }

export class RockField {
  constructor(scene) { this.scene = scene; this.types = []; this.chunks = new Map(); this.lastCell = null; this.ready = false; }
  async init(quality = 1) {
    const names = Object.keys(ROCKS);
    for (const n of names) {
      const r = ROCKS[n];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(b64(r.pos, Float32Array), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(b64(r.nor, Float32Array), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(b64(r.uv, Float32Array), 2));
      g.setIndex(new THREE.BufferAttribute(b64(r.idx, Uint32Array), 1));
      g.translate(0, -r.minY, 0);
      g.computeBoundingSphere();
      const [diff, nor, arm] = await Promise.all([tex(PHM(n, 'diff'), { wrap: false }), tex(PHM(n, 'nor_gl'), { srgb: false, wrap: false }), tex(PHM(n, 'arm'), { srgb: false, wrap: false })]);
      for (const t of [diff, nor, arm]) t.flipY = false;
      const m = new THREE.MeshStandardMaterial({ map: diff, normalMap: nor, roughnessMap: arm, aoMap: arm, metalnessMap: arm, metalness: 1, roughness: 1 });
      const max = Math.round((n === 'namaqualand_boulder_04' ? 1200 : 5000) * quality);
      const im = new THREE.InstancedMesh(g, m, max);
      im.count = 0; im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
      this.scene.add(im);
      this.types.push({ name: n, r, im, max });
    }
    this.ready = true;
  }
  chunk(cx, cz) {
    const key = cx + ',' + cz; let c = this.chunks.get(key); if (c) return c;
    c = []; const S = 48; const rnd = mulberry(cx * 73856093 ^ cz * 19349663);
    const x0 = cx * S, z0 = cz * S;
    const hC = heightAt(x0 + S / 2, z0 + S / 2), nC = normalAt(x0 + S / 2, z0 + S / 2, 6);
    const slope = 1 - nC[1];
    const surf = surfaceAt(x0 + S / 2, z0 + S / 2, hC);
    if (surf === 'water' || hC < WATER_LEVEL + 0.5) { this.chunks.set(key, c); return c; }
    // rockiness: slopes, high terrain, dry patches
    const patch = hash2(Math.floor(cx / 3), Math.floor(cz / 3));
    let rocky = Math.min(1, slope * 3.2 + Math.max(0, (hC - 600) / 900) + (patch > 0.82 ? 0.5 : 0));
    const nearRunway = surf === 'runway';
    const nSmall = Math.floor((7 + rocky * 40) * (nearRunway ? 0.3 : 1));
    const nPebble = Math.floor((26 + rocky * 40) * (nearRunway ? 0.4 : 1));
    const nBoulder = rocky > 0.35 ? Math.floor(rocky * 3 * rnd() + (rnd() < 0.15 ? 1 : 0)) : rnd() < 0.05 ? 1 : 0;
    const tmp = new THREE.Object3D();
    const add = (type, scale, sink) => {
      const x = x0 + rnd() * S, z = z0 + rnd() * S;
      const h = heightAt(x, z); if (h < WATER_LEVEL + 0.2) return;
      if (surfaceAt(x, z, h) !== 'grass') return;
      tmp.position.set(x, h - sink * scale, z);
      tmp.rotation.set((rnd() - 0.5) * 0.5, rnd() * 6.28, (rnd() - 0.5) * 0.5);
      tmp.scale.set(scale * (0.8 + rnd() * 0.4), scale * (0.6 + rnd() * 0.5), scale * (0.8 + rnd() * 0.4));
      tmp.updateMatrix(); const o = { type, m: tmp.matrix.clone() }; c.push(o); return o;
    };
    for (let i = 0; i < nSmall; i++) { const t = Math.floor(rnd() * 3); add(t, (1 + rnd() * rnd() * 6) * (t === 0 ? 1.2 : 1.8), 0.15); }
    for (let i = 0; i < nBoulder; i++) add(3, 0.5 + rnd() * 1.3 * (0.5 + rocky), 0.25);
    // pebbles & gravel: only used for the inner rings (flagged)
    for (let i = 0; i < nPebble; i++) { const t = 1 + Math.floor(rnd() * 2); const o = add(t, 0.7 + rnd() * 1.6, 0.2); if (o) o.peb = 1; }
    this.chunks.set(key, c); return c;
  }
  update(cam, budget = 6) {
    if (!this.ready) return;
    const S = 48, R = 6;
    const cx = Math.floor(cam.x / S), cz = Math.floor(cam.z / S);
    const key = cx + ',' + cz + ',' + (cam.y > 1500 ? 1 : 0);
    if (key === this.lastCell && !this.pending) return;
    this.lastCell = key;
    let built = 0; this.pending = false;
    const counts = this.types.map(() => 0);
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dz * dz > R * R) continue;
      const k = (cx + dx) + ',' + (cz + dz);
      if (!this.chunks.has(k)) { if (built >= budget) { this.pending = true; continue; } built++; }
      const inner = dx * dx + dz * dz <= 2 * (this.quality ?? 0.65) * 3;
      for (const r of this.chunk(cx + dx, cz + dz)) {
        if (r.peb && !inner) continue;
        const T = this.types[r.type]; if (counts[r.type] >= T.max) continue;
        T.im.setMatrixAt(counts[r.type]++, r.m);
      }
    }
    this.types.forEach((T, i) => { T.im.count = counts[i]; T.im.instanceMatrix.needsUpdate = true; });
    if (this.chunks.size > 3000) this.chunks.clear();
  }
}

// ---------------- Trees: procedural firs with photographic twig cards, impostors far away ----------------
async function alphaTexture(diffUrl, alphaUrl, size = 1024) {
  const [d, a] = await Promise.all([loadImage(diffUrl), loadImage(alphaUrl)]);
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d', { willReadFrequently: true });
  if (!d || !a) { g.fillStyle = '#2f4a22'; g.fillRect(0, 0, size, size); return new THREE.CanvasTexture(c); }
  g.drawImage(a, 0, 0, size, size); const A = g.getImageData(0, 0, size, size);
  g.drawImage(d, 0, 0, size, size); const C = g.getImageData(0, 0, size, size);
  for (let i = 0; i < C.data.length; i += 4) C.data[i + 3] = A.data[i];
  g.putImageData(C, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function firGeometry(rnd, twigRects) {
  // trunk
  const parts = [];
  const H = 1; // normalized height (scaled per instance)
  const trunk = new THREE.CylinderGeometry(0.008, 0.022, H, 7, 1, true); trunk.translate(0, H / 2, 0);
  const pos = [], uv = [], nor = [], col = [];
  const pushGeo = (g, isBark) => {
    const p = g.attributes.position, u = g.attributes.uv, n = g.attributes.normal; const ix = g.index;
    const list = ix ? Array.from(ix.array) : [...Array(p.count).keys()];
    for (const i of list) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); uv.push(isBark ? u.getX(i) * 0.08 : u.getX(i), isBark ? u.getY(i) * 0.9 : u.getY(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); col.push(isBark ? 1 : 0); }
  };
  pushGeo(trunk, true);
  // whorls of twig cards: cone silhouette
  const whorls = 13;
  for (let w = 0; w < whorls; w++) {
    const t = w / whorls; const y = 0.12 + t * 0.86;
    const r = (1 - t) * 0.26 + 0.02;
    const n = Math.max(3, Math.round(7 - t * 3));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + w * 1.3 + rnd() * 0.4;
      const len = r * (1.1 + rnd() * 0.4), wid = len * 0.9;
      const rc = twigRects[Math.floor(rnd() * twigRects.length)];
      // card: from trunk outward, drooping
      const droop = -0.28 - rnd() * 0.25;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ox = ca, oz = sa; // outward
      const sx = -sa, sz = ca; // side
      const base = [0, y, 0];
      const tip = [ox * len, y + droop * len, oz * len];
      const p0 = [base[0] - sx * wid / 2, base[1] + 0.02, base[2] - sz * wid / 2], p1 = [base[0] + sx * wid / 2, base[1] + 0.02, base[2] + sz * wid / 2];
      const p2 = [tip[0] + sx * wid / 2, tip[1], tip[2] + sz * wid / 2], p3 = [tip[0] - sx * wid / 2, tip[1], tip[2] - sz * wid / 2];
      // normal roughly up/outward (gives soft canopy lighting)
      const nn = [ox * 0.5, 0.85, oz * 0.5];
      const quad = [[p0, [rc[0], rc[3]]], [p1, [rc[2], rc[3]]], [p2, [rc[2], rc[1]]], [p0, [rc[0], rc[3]]], [p2, [rc[2], rc[1]]], [p3, [rc[0], rc[1]]]];
      for (const [p, u] of quad) { pos.push(...p); uv.push(u[0], 1 - u[1]); nor.push(...nn); col.push(0); }
    }
  }
  // crown top card (vertical crossed)
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('bark', new THREE.Float32BufferAttribute(col, 1));
  void parts;
  return g;
}

export class Forest {
  constructor(scene, renderer) { this.scene = scene; this.renderer = renderer; this.chunks = new Map(); this.ready = false; this.lastKey = null; }
  async init(quality = 1) {
    this.quality = quality;
    const twig = await alphaTexture(PHM('fir_tree_01', 'twig_diff'), PHM('fir_tree_01', 'twig_alpha'));
    twig.flipY = true; twig.needsUpdate = true;
    const bark = await tex(PHM('fir_tree_01', 'bark_diff'), { repeat: 1 });
    // twig sub-rects in atlas (u0,v0,u1,v1 with v from top)
    const rects = [[0.16, 0.04, 0.39, 0.30], [0.61, 0.04, 0.86, 0.35], [0.28, 0.45, 0.60, 0.75], [0.60, 0.44, 0.91, 0.76]];
    const rnd = mulberry(1234);
    const g = firGeometry(rnd, rects);
    const mat = new THREE.MeshStandardMaterial({ map: twig, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.85, color: 0xffffff });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uBark = { value: bark };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float bark; varying float vBark; varying float vTint;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvBark = bark;\n#ifdef USE_INSTANCING\n vTint = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898,78.233)))*43758.5453);\n#else\n vTint=0.5;\n#endif');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D uBark; varying float vBark; varying float vTint;')
        .replace('#include <map_fragment>', `
          vec4 sampledDiffuseColor = vBark > 0.5 ? texture2D(uBark, vMapUv) : texture2D(map, vMapUv);
          if (vBark > 0.5) sampledDiffuseColor.a = 1.0;
          diffuseColor *= sampledDiffuseColor;
          diffuseColor.rgb *= mix(vec3(0.78,0.86,0.74), vec3(1.08,1.04,0.92), vTint);`);
    };
    this.mat = mat;
    const max = Math.round(14000 * quality);
    this.near = new THREE.InstancedMesh(g, mat, max); this.near.count = 0; this.near.castShadow = true; this.near.receiveShadow = true; this.near.frustumCulled = false; this.nearMax = max;
    // impostor: render one tree to texture
    const imp = this.makeImpostor(g, mat);
    const ig = new THREE.BufferGeometry();
    const P = [], U = [];
    for (const a of [0, Math.PI / 2]) {
      const c = Math.cos(a) * 0.3, s = Math.sin(a) * 0.3;
      P.push(-c, 0, -s, c, 0, s, c, 1, s, -c, 0, -s, c, 1, s, -c, 1, -s); U.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    }
    ig.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); ig.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    ig.setAttribute('normal', new THREE.Float32BufferAttribute(P.map((v, i) => (i % 3 === 1 ? 1 : 0)), 3));
    const im = new THREE.MeshStandardMaterial({ map: imp, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9 });
    const fmax = Math.round(60000 * quality);
    this.far = new THREE.InstancedMesh(ig, im, fmax); this.far.count = 0; this.far.frustumCulled = false; this.far.receiveShadow = false; this.farMax = fmax;
    this.scene.add(this.near); this.scene.add(this.far);
    this.ready = true;
  }
  makeImpostor(g, mat) {
    const rt = new THREE.WebGLRenderTarget(256, 512, { samples: 4 });
    const sc = new THREE.Scene();
    const m = new THREE.Mesh(g, mat); sc.add(m);
    sc.add(new THREE.HemisphereLight(0xdde8ff, 0x445533, 1.6)); const dl = new THREE.DirectionalLight(0xffffff, 2.2); dl.position.set(1, 2, 1.5); sc.add(dl);
    const cam = new THREE.OrthographicCamera(-0.3, 0.3, 1.0, 0, 0.1, 10); cam.position.set(0, 0, 3); cam.lookAt(0, 0, 0); cam.position.y = 0; 
    const r = this.renderer; const prev = r.getRenderTarget(); const pc = r.getClearAlpha(); const pcol = r.getClearColor(new THREE.Color());
    r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear(); r.render(sc, cam);
    r.setRenderTarget(prev); r.setClearColor(pcol, pc);
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    return rt.texture;
  }
  chunk(cx, cz) {
    const key = cx + ',' + cz; let c = this.chunks.get(key); if (c) return c;
    const S = 128, step = 11; c = [];
    const rnd = mulberry((cx * 92837111) ^ (cz * 689287499));
    const tmp = new THREE.Object3D();
    for (let z = 0; z < S; z += step) for (let x = 0; x < S; x += step) {
      const wx = cx * S + x + (rnd() - 0.5) * step, wz = cz * S + z + (rnd() - 0.5) * step;
      const h = heightAt(wx, wz);
      if (h < WATER_LEVEL + 1.5) { rnd(); continue; }
      const n = normalAt(wx, wz, 4); const slope = 1 - n[1];
      let f = forestAt(wx, wz, h, slope);
      // trees only where ESA WorldCover maps tree cover (towns get theirs from scenery.js: OSM trees + canopy)
      if (rnd() > f * 0.95) continue;
      if (surfaceAt(wx, wz, h) !== 'grass') continue;
      // avoid town
      if (townAt(wx, wz) > 0.35) continue;
      const ht = 9 + rnd() * 16 * (h > 900 ? 0.7 : 1);
      tmp.position.set(wx, h - 0.3, wz); tmp.rotation.set(0, rnd() * 6.28, 0); tmp.scale.set(ht * (0.9 + rnd() * 0.3), ht, ht * (0.9 + rnd() * 0.3)); tmp.updateMatrix();
      c.push(tmp.matrix.clone());
    }
    this.chunks.set(key, c); return c;
  }
  update(cam, budget = 5) {
    if (!this.ready) return;
    const S = 128; const cx = Math.floor(cam.x / S), cz = Math.floor(cam.z / S);
    const key = cx + ',' + cz;
    if (key === this.lastKey && !this.pending) return;
    this.lastKey = key; this.pending = false;
    const Rn = Math.ceil(600 / S), Rf = Math.ceil(3200 / S * Math.sqrt(this.quality));
    let built = 0, nn = 0, nf = 0;
    const order = [];
    for (let dz = -Rf; dz <= Rf; dz++) for (let dx = -Rf; dx <= Rf; dx++) { const d2 = dx * dx + dz * dz; if (d2 <= Rf * Rf) order.push([d2, dx, dz]); }
    order.sort((a, b) => a[0] - b[0]);
    for (const [d2, dx, dz] of order) {
      const k = (cx + dx) + ',' + (cz + dz);
      if (!this.chunks.has(k)) { if (built >= budget) { this.pending = true; continue; } built++; }
      const list = this.chunk(cx + dx, cz + dz);
      const near = d2 <= Rn * Rn;
      for (const m of list) {
        if (near) { if (nn < this.nearMax) this.near.setMatrixAt(nn++, m); }
        else if (nf < this.farMax) this.far.setMatrixAt(nf++, m);
      }
    }
    this.near.count = nn; this.far.count = nf;
    this.near.instanceMatrix.needsUpdate = true; this.far.instanceMatrix.needsUpdate = true;
    if (this.chunks.size > 6000) this.chunks.clear();
  }
}

// ---------------- Grass tufts near the camera ----------------
export class GrassField {
  constructor(scene) { this.scene = scene; this.ready = false; this.lastKey = null; }
  async init(quality = 1) {
    const t = await alphaTexture(PHM('grass_medium_01', 'diff'), PHM('grass_medium_01', 'alpha'));
    // tuft regions from atlas bottom (u0,v0,u1,v1 top-origin)
    const rects = [[0.17, 0.74, 0.45, 0.86], [0.53, 0.74, 0.76, 0.86], [0.04, 0.86, 0.23, 0.98], [0.24, 0.86, 0.50, 0.98], [0.53, 0.86, 0.76, 0.98]];
    const P = [], U = [], N = [];
    const r = rects[1];
    for (const a of [0, Math.PI / 3, 2 * Math.PI / 3]) {
      const c = Math.cos(a) * 0.5, s = Math.sin(a) * 0.5;
      const q = [[-c, 0, -s, r[0], r[3]], [c, 0, s, r[2], r[3]], [c, 0.45, s, r[2], r[1]], [-c, 0, -s, r[0], r[3]], [c, 0.45, s, r[2], r[1]], [-c, 0.45, -s, r[0], r[1]]];
      for (const v of q) { P.push(v[0], v[1], v[2]); U.push(v[3], 1 - v[4]); N.push(0, 1, 0); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    const m = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.95, color: 0xffffff });
    // grass blades scatter light like the ground they grow on: use the terrain's up-normal so back faces aren't black
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz); nonPerturbedNormal = normal;');
    };
    const max = Math.round(42000 * quality);
    this.im = new THREE.InstancedMesh(g, m, max);
    this.im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3); this.im.count = 0; this.im.frustumCulled = false; this.im.receiveShadow = true;
    this.scene.add(this.im); this.ready = true;
  }
  // per-cell tuft lists are generated once (max density) and cached; rebuilds just copy
  cell(ix, iz) {
    const key = ix + ',' + iz; let c = this.cells.get(key); if (c) return c;
    const S = 16, rnd = mulberry((ix * 7919) ^ (iz * 104729));
    const x0 = ix * S, z0 = iz * S; c = { m: [], c: [] };
    const hc = heightAt(x0 + 8, z0 + 8);
    const tw = townAt(x0 + 8, z0 + 8), downtown = tw > 0.7;
    if (!downtown && surfaceAt(x0 + 8, z0 + 8, hc) !== 'water' && hc < 1500) {
      const tmp = new THREE.Object3D();
      for (let i = 0; i < 260; i++) {
        const x = x0 + rnd() * S, z = z0 + rnd() * S;
        if (tw > 0.2 && rnd() < 0.75) continue; // mown lawns
        const h = heightAt(x, z);
        if (h < WATER_LEVEL + 0.4 || surfaceAt(x, z, h) !== 'grass') continue;
        const sc = 0.35 + rnd() * rnd() * 0.8;
        tmp.position.set(x, h - 0.03, z); tmp.rotation.set((rnd() - 0.5) * 0.25, rnd() * 6.28, (rnd() - 0.5) * 0.25); tmp.scale.set(sc * 1.1, sc * (0.8 + rnd() * 0.5), sc * 1.1); tmp.updateMatrix();
        const dry = rnd(), v = 0.85 + rnd() * 0.3; // dry straw <-> green, matched to the meadow photo
        c.m.push(tmp.matrix.clone()); c.c.push(new THREE.Color((0.80 + dry * 0.35) * v, (0.86 + dry * 0.12) * v, (0.62 - dry * 0.05) * v));
      }
    }
    if (this.cells.size > 4000) this.cells.clear();
    this.cells.set(key, c); return c;
  }
  update(cam, agl) {
    if (!this.ready) return;
    if (agl > 200) { this.im.visible = false; return; }
    this.im.visible = true;
    this.cells = this.cells || new Map();
    const S = 16; const cx = Math.floor(cam.x / S), cz = Math.floor(cam.z / S);
    const key = cx + ',' + cz; if (key === this.lastKey) return; this.lastKey = key;
    const R = 6, MAX = this.im.instanceMatrix.count; let n = 0;
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dz * dz; if (d2 > R * R) continue;
      const c = this.cell(cx + dx, cz + dz);
      const frac = (d2 <= 4 ? 1 : d2 <= 12 ? 0.46 : 0.17) * Math.min(1, (this.quality ?? 0.65) * 1.25);
      const k = Math.min(c.m.length, Math.round(c.m.length * frac));
      for (let i = 0; i < k && n < MAX; i++) { this.im.setMatrixAt(n, c.m[i]); this.im.setColorAt(n++, c.c[i]); }
    }
    this.im.count = n; this.im.instanceMatrix.needsUpdate = true; this.im.instanceColor.needsUpdate = true;
  }
}

// ---------------- Town ----------------
// windows + night lights for instanced building walls (uses instance scale to tile windows in metres)
export function windowShader(m, scaleU) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = m.userData.uNight = { value: 0 };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLoc; varying vec3 vSc; varying vec3 vNl;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvLoc = position; vNl = normal;\n#ifdef USE_INSTANCING\n vSc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));\n#else\n vSc = vec3(1.0);\n#endif`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uNight; varying vec3 vLoc; varying vec3 vSc; varying vec3 vNl;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float win = 0.0; float lit = 0.0;
        if (abs(vNl.y) < 0.5) {
          float along = abs(vNl.x) > 0.5 ? vLoc.z*vSc.z : vLoc.x*vSc.x;
          float up = vLoc.y*vSc.y;
          float fu = fract(along/${scaleU.toFixed(1)}); float fv = fract(up/3.0);
          win = step(0.3, fu)*step(fu, 0.7)*step(0.35, fv)*step(fv, 0.8)*step(1.0, up)*step(up, vSc.y-0.6);
          vec2 cell = floor(vec2(along/${scaleU.toFixed(1)}, up/3.0));
          lit = step(0.55, fract(sin(dot(cell, vec2(12.9,78.2)) + vSc.x*3.1)*43758.5));
          float frame = win * (1.0 - step(0.33, fu)*step(fu, 0.67)*step(0.38, fv)*step(fv, 0.77));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05,0.07,0.09), win);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92), frame);
        }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += vec3(1.0,0.75,0.42)*win*lit*uNight*1.6;');
  };
  return m;
}
export function gableGeometry() {
  const roofG = new THREE.BufferGeometry();
  const v = [-0.55, 0, -0.55, 0.55, 0, -0.55, 0, 1, -0.55, -0.55, 0, 0.55, 0.55, 0, 0.55, 0, 1, 0.55];
  const idx = [0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 4];
  const P = [], U = [];
  for (const i of idx) { P.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]); U.push(v[i * 3 + 2] * 2, (v[i * 3 + 1] + Math.abs(v[i * 3])) * 2); }
  roofG.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); roofG.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); roofG.computeVertexNormals();
  return roofG;
}
export { boxUV, pbr, makePoints };
export { buildAirports } from './airport3d.js';

// Merge a static hierarchy into one mesh per material (in the root's local frame)
export function flattenStatic(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const byMat = new Map();
  root.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material) || !o.visible) return;
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    const keep = ['position', 'normal', 'uv'];
    for (const k of Object.keys(g.attributes)) if (!keep.includes(k)) g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.morphAttributes = {};
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    const key = o.material.uuid + (o.renderOrder || 0);
    if (!byMat.has(key)) byMat.set(key, { mat: o.material, geos: [], ro: o.renderOrder, cast: o.castShadow });
    byMat.get(key).geos.push(g);
  });
  const out = new THREE.Group();
  out.position.copy(root.position); out.quaternion.copy(root.quaternion); out.scale.copy(root.scale);
  out.name = root.name + '_static';
  for (const { mat, geos, ro, cast } of byMat.values()) {
    const g = mergeGeometries(geos, false); if (!g) continue;
    const me = new THREE.Mesh(g, mat); me.renderOrder = ro; me.castShadow = cast && !mat.transparent; me.receiveShadow = true;
    out.add(me);
  }
  return out;
}
