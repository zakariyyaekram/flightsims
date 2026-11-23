// Airport orthophotos (USGS NAIP, public domain) draped over the terrain and blended into apron/taxiway pavement.
// Two texture slots are bound to the nearest airports that have a baked ortho (data/ortho/<ICAO>.jpg, rect in airports.json).
import * as THREE from 'three';
import { AIRPORTS } from './geo.js';

const blank = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); blank.needsUpdate = true;
export const ORTHO_UNIFORMS = {
  uOrT0: { value: blank }, uOrT1: { value: blank },
  uOrR0: { value: new THREE.Vector4(0, 0, 1, 1) }, uOrR1: { value: new THREE.Vector4(0, 0, 1, 1) },
  uOrOn: { value: new THREE.Vector2(0, 0) },
};
// GLSL: returns ortho colour (linear) in rgb and blend weight in a
export const ORTHO_GLSL = `
uniform sampler2D uOrT0; uniform sampler2D uOrT1; uniform vec4 uOrR0; uniform vec4 uOrR1; uniform vec2 uOrOn;
vec4 orthoSlot(sampler2D t, vec4 r, float on, vec2 p, float bias, float feather) {
  if (on < 0.5) return vec4(0.0);
  vec2 uv = (p - r.xy) / (r.zw - r.xy);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  vec2 e = min(p - r.xy, r.zw - p);
  float w = smoothstep(0.0, feather, min(e.x, e.y));
  return vec4(texture(t, uv, bias).rgb, w);
}
vec4 orthoAt(vec2 p, float bias, float feather) {
  vec4 a = orthoSlot(uOrT0, uOrR0, uOrOn.x, p, bias, feather);
  if (a.a > 0.0) return a;
  return orthoSlot(uOrT1, uOrR1, uOrOn.y, p, bias, feather);
}
`;

const loader = new THREE.TextureLoader();
export class OrthoManager {
  constructor(renderer, base = './data/ortho/') {
    this.base = base; this.cache = new Map(); this.slots = [null, null]; this.tick = 0;
    this.maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() || 8;
    this.list = AIRPORTS.filter((a) => a.ortho);
  }
  load(a) {
    if (this.cache.has(a.icao)) return this.cache.get(a.icao);
    const e = { tex: null, used: 0 };
    loader.load(`${this.base}${a.icao}.jpg?v=20261123g`, (t) => {
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = this.maxAniso; t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.flipY = false;
      e.tex = t; this.tick = 0;
    });
    this.cache.set(a.icao, e); return e;
  }
  update(cam) {
    if ((this.tick = (this.tick + 1) % 45) !== 1) return;
    const near = this.list.map((a) => {
      const o = a.ortho; const dx = Math.max(o.x0 - cam.x, 0, cam.x - o.x1), dz = Math.max(o.z0 - cam.z, 0, cam.z - o.z1);
      return { a, d: Math.hypot(dx, dz) };
    }).filter((q) => q.d < 14000).sort((p, q) => p.d - q.d).slice(0, 2);
    const U = ORTHO_UNIFORMS;
    for (let i = 0; i < 2; i++) {
      const q = near[i]; const T = i ? U.uOrT1 : U.uOrT0, R = i ? U.uOrR1 : U.uOrR0;
      const e = q && this.load(q.a);
      if (e?.tex) { const o = q.a.ortho; T.value = e.tex; R.value.set(o.x0, o.z0, o.x1, o.z1); U.uOrOn.value.setComponent(i, 1); e.used = performance.now(); }
      else { T.value = blank; U.uOrOn.value.setComponent(i, 0); }
    }
    // free textures that have been unused for a while
    if (this.cache.size > 4) for (const [k, e] of this.cache) if (e.tex && performance.now() - e.used > 60000 && !near.some((q) => q.a.icao === k)) { e.tex.dispose(); this.cache.delete(k); }
  }
}
