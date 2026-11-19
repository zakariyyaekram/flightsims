// Quadtree LOD terrain with photographic texture splatting, procedural farmland and forest canopy.
import * as THREE from 'three';
import { heightAt, forestAt, farmAt, WORLD_HALF, WATER_LEVEL, AIRPORTS, toLocal, townAt, TOWNS } from './geo.js';
import { texArray, PH } from './textures.js';

const N = 32; // segments per tile
const MIN_SIZE = 128;

export const TERRAIN_LAYERS = [
  'leafy_grass', 'forest_ground_04', 'rock_face_03', 'dry_ground_rocks', 'coast_sand_01', 'snow_02', 'aerial_grass_rock', 'aerial_rocks_02', 'brown_mud_leaves_01',
];

export async function createTerrainMaterial(onProgress, size = 1024) {
  const diff = await texArray(TERRAIN_LAYERS.map((n) => PH(n, 'diff')), size, true);
  onProgress?.(0.5);
  const nor = await texArray(TERRAIN_LAYERS.slice(0, 6).map((n) => PH(n, 'nor_gl')), size, false);
  onProgress?.(1);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  const uniforms = {
    uDiff: { value: diff.texture }, uNor: { value: nor.texture },
    uAvg: { value: diff.avg.map((a) => new THREE.Vector3(...a)) },
    uCam: { value: new THREE.Vector3() }, uSnow: { value: 1750 }, uWater: { value: WATER_LEVEL },
    uSeason: { value: 0.0 },
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 cover;\nvarying vec3 vW;\nvarying vec3 vNW;\nvarying vec2 vCover;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvW = (modelMatrix * vec4(transformed,1.0)).xyz;\nvNW = normalize(mat3(modelMatrix) * objectNormal);\nvCover = cover;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray uDiff; uniform sampler2DArray uNor; uniform vec3 uAvg[9];
uniform vec3 uCam; uniform float uSnow; uniform float uWater; uniform float uSeason;
varying vec3 vW; varying vec3 vNW; varying vec2 vCover;
float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }
float fbm3(vec2 p){ return vnoise(p)*.5 + vnoise(p*2.03+7.1)*.25 + vnoise(p*4.1-3.3)*.125 + vnoise(p*8.3+1.7)*.0625; }
vec3 T(int l, vec2 uv){ return texture(uDiff, vec3(uv, float(l))).rgb; }
// two-scale sample to kill tiling, rotated second layer
vec3 T2(int l, vec2 p, float s){ vec2 q = mat2(.8,-.6,.6,.8)*p; return mix(T(l,p/s), T(l,q/(s*3.7)), .35); }
vec3 NT(int l, vec2 uv){ return texture(uNor, vec3(uv, float(l))).xyz*2.-1.; }
vec3 gTerrainN; float gRough;
`)
      .replace('#include <map_fragment>', `
  vec3 Nw = normalize(vNW);
  float slope = 1.0 - Nw.y;
  float dist = length(vW - uCam);
  vec2 p = vW.xz;
  float m1 = fbm3(p/900.), m2 = fbm3(p/140.+3.), m3 = fbm3(p/37.-5.);
  float near = 1.0 - smoothstep(220.0, 1100.0, dist);
  float mid = 1.0 - smoothstep(2500.0, 9000.0, dist);
  // ---- photo detail layers ----
  vec3 grassD = T2(0, p, 3.2);
  vec3 dirtD = T2(3, p, 4.0);
  vec3 forestD = T2(1, p, 4.5);
  vec3 sandD = T2(4, p, 5.0);
  vec3 snowD = T2(5, p, 6.0);
  // triplanar rock
  vec3 bw = pow(abs(Nw), vec3(4.)); bw /= (bw.x+bw.y+bw.z);
  vec3 rockD = T(2, vW.zy/9.)*bw.x + T(2, p/9.)*bw.y + T(2, vW.xy/9.)*bw.z;
  // ---- aerial (far) layers: photographed from above ----
  vec3 grassA = mix(T(6, p/260.), T(6, mat2(.8,-.6,.6,.8)*p/911.), .4);
  vec3 rockA = T(7, p/300.)*bw.y + T(7, vW.zy/300.)*bw.x + T(7, vW.xy/300.)*bw.z;
  vec3 grassC = mix(grassA * (uAvg[0]/max(uAvg[6],vec3(.01))) * 0.95, grassD, near);
  // meadow hue variation: lush / dry patches
  vec3 dry = vec3(0.78,0.70,0.45);
  grassC *= mix(vec3(1.0), dry*1.25, smoothstep(.45,.8,m1)*.35);
  grassC *= mix(.82, 1.12, m2);
  vec3 col = grassC;
  // worn dirt patches
  float wDirt = smoothstep(.62,.78, m2*.7+m3*.4) * (1.-near*.2) + smoothstep(.22,.38,slope)*.6;
  col = mix(col, mix(dirtD*.9, grassA*0.75, 1.-near), clamp(wDirt,0.,1.));
  // ---- town lawns: mown, watered grass with garden/hedge variation ----
  float lawn = smoothstep(0., .5, -vCover.y);
  if (lawn > 0.01) {
    vec3 lawnC = vec3(.20,.31,.10) * mix(vec3(1.), grassD / max(uAvg[0], vec3(.05)), near*.6) * (0.85 + 0.3*m3);
    float stripe = 0.5 + 0.5*sin(dot(p, vec2(.7,.7)) * 0.9);
    lawnC *= 0.94 + 0.1*stripe*(1.0 - smoothstep(60., 300., dist));
    lawnC = mix(lawnC, vec3(.30,.27,.20), smoothstep(.72,.9,m1)*.5); // bare garden beds / dry yards
    col = mix(col, lawnC, lawn);
    // downtown: concrete plazas, sidewalks and parking
    float pave = clamp(-vCover.y - 1.0, 0., 1.);
    if (pave > 0.01) {
      vec3 conc = vec3(.25,.24,.215) * mix(vec3(1.), dirtD / max(uAvg[3], vec3(.05)), near*.25) * (0.88 + 0.2*m3);
      vec2 sl = abs(fract(p / 3.0) - 0.5); float joint = smoothstep(.47, .5, max(sl.x, sl.y)) * (1.0 - smoothstep(30., 120., dist));
      conc *= 1.0 - joint * 0.25;
      conc = mix(conc, vec3(.22,.215,.2), smoothstep(.6,.85,m2)*.35); // stains / older slabs
      col = mix(col, conc, pave);
    }
  }
  // ---- farmland: rotated field grid with crops & plough rows ----
  float farm = smoothstep(.25,.6,vCover.y);
  if (farm > 0.01) {
    float ang = floor(m1*4.)*0.37 + 0.2;
    mat2 R = mat2(cos(ang),-sin(ang),sin(ang),cos(ang));
    vec2 q = R*p;
    vec2 cs = vec2(230., 170.);
    vec2 cid = floor(q/cs); vec2 cf = fract(q/cs);
    float hsh = h21(cid+floor(m1*8.)), hsh2 = h21(cid*1.7+3.1);
    // sub-split some fields
    if (hsh2 > .55) { cid.x += step(.5, cf.x)*31.; hsh = h21(cid); cf.x = fract(cf.x*2.); }
    vec3 crop;
    float t = hsh*6.;
    if (t < 1.) crop = vec3(.24,.33,.11);          // young corn / green
    else if (t < 2.) crop = vec3(.52,.47,.26);      // wheat / straw
    else if (t < 3.) crop = vec3(.33,.25,.17);      // ploughed soil
    else if (t < 4.) crop = vec3(.30,.37,.15);      // pasture
    else if (t < 5.) crop = vec3(.40,.40,.20);      // hay
    else crop = vec3(.19,.27,.10);                  // soy dark green
    float rows = 0.5+0.5*sin((t<3.&&t>=2. ? q.y : q.x)*(6.2832/2.6) );
    float rowsFade = 1.0 - smoothstep(150., 900., dist);
    vec3 det = (t>=2.&&t<3.) ? dirtD : grassD;
    vec3 detN = det / max(t>=2.&&t<3. ? uAvg[3] : uAvg[0], vec3(.05));
    vec3 fcol = crop * mix(vec3(1.), detN, near*.7) * (0.85 + 0.25*rows*rowsFade) * (0.9+0.2*m3);
    fcol *= mix(1., 0.75 + 0.5*h21(cid*3.3), .4);
    // hedgerows & tracks along field borders
    vec2 e = min(cf, 1.-cf) * cs;
    float edge = min(e.x, e.y);
    float hedge = 1. - smoothstep(1.5, 3.5, edge);
    vec3 hedgeC = (hsh2 > .3) ? vec3(.09,.13,.05) : vec3(.36,.32,.24);
    fcol = mix(fcol, hedgeC, hedge * (0.6 + 0.4*(1.-near)));
    col = mix(col, fcol, farm);
  }
  // ---- forest canopy ----
  float fo = clamp(vCover.x + (m3-.5)*.5 + (m2-.5)*.3, 0., 1.);
  fo = smoothstep(.35, .55, fo);
  vec3 canopy = mix(vec3(.06,.10,.045), vec3(.11,.15,.06), m3) * (0.55 + 0.9*T(6, p/45.).g);
  canopy = mix(canopy, canopy*vec3(1.1,1.0,.8), smoothstep(800.,1500.,vW.y));
  vec3 forestC = mix(canopy, forestD*.55, near*.65);
  col = mix(col, forestC, fo);
  // ---- rock on steep slopes ----
  float wRock = smoothstep(.28, .48, slope + (m2-.5)*.18) + smoothstep(1350., 1900., vW.y + (m1-.5)*300.)*smoothstep(.1,.3,slope);
  wRock = clamp(wRock, 0., 1.);
  vec3 rockC = mix(rockA * 1.05, rockD, near);
  col = mix(col, rockC, wRock);
  // ---- shoreline sand ----
  float wSand = 1.0 - smoothstep(uWater+0.5, uWater+5.0 + m3*3., vW.y);
  col = mix(col, mix(sandD*.95, vec3(.55,.5,.4), 1.-near), wSand);
  // ---- snow ----
  float wSnow = smoothstep(uSnow - 60., uSnow + 80., vW.y + (m1-.5)*260. + (m3-.5)*60.) * (1. - smoothstep(.45, .7, slope));
  col = mix(col, mix(vec3(.86,.88,.92), snowD, near), wSnow);
  // far haze desaturation (Rayleigh is handled by fog)
  col = mix(col, vec3(dot(col, vec3(.3,.59,.11))), (1.-mid)*.25);
  diffuseColor.rgb *= col;
  gRough = mix(0.97, 0.88, wRock); gRough = mix(gRough, 0.55, wSnow);
  // detail normal blend
  vec3 tn = vec3(0.,0.,1.);
  if (near > 0.0) {
    vec3 ng = NT(0, p/3.2), nr = NT(2, p/9.), nd = NT(3, p/4.), ns = NT(5, p/6.);
    tn = normalize(mix(mix(mix(ng, nd, clamp(wDirt,0.,1.)), nr, wRock), ns, wSnow));
    tn.xy *= near * 1.2;
  }
  gTerrainN = tn;
`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = gRough;`)
      .replace('#include <normal_fragment_maps>', `
  {
    // world-space tangent frame from terrain normal (UV = world xz)
    vec3 Nw2 = normalize(vNW);
    vec3 Tw = normalize(vec3(1.,0.,0.) - Nw2*Nw2.x);
    vec3 Bw = normalize(cross(Nw2, Tw));
    vec3 nW = normalize(Tw*gTerrainN.x - Bw*gTerrainN.y + Nw2*gTerrainN.z);
    normal = normalize((viewMatrix * vec4(nW, 0.)).xyz);
  }
`);
  };
  return mat;
}

class Tile {
  constructor(x, z, size, level) { this.x = x; this.z = z; this.size = size; this.level = level; this.mesh = null; this.children = null; this.lastUsed = 0; }
}

export class Terrain {
  constructor(scene, material) {
    this.scene = scene; this.material = material;
    this.root = new Tile(0, 0, WORLD_HALF * 2, 0);
    this.queue = new Set();
    this.group = new THREE.Group();
    scene.add(this.group);
    this.frame = 0;
    this.built = 0;
  }

  buildGeometry(t) {
    const S = t.size, step = S / N, x0 = t.x - S / 2, z0 = t.z - S / 2;
    const G = N + 3; // grid with 1-cell border for normals
    const H = new Float32Array(G * G);
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) H[j * G + i] = heightAt(x0 + (i - 1) * step, z0 + (j - 1) * step);
    const vN = (N + 1) * (N + 1);
    const skirtN = 4 * (N + 1);
    const pos = new Float32Array((vN + skirtN) * 3), nor = new Float32Array((vN + skirtN) * 3), cov = new Float32Array((vN + skirtN) * 2);
    let k = 0;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const gi = i + 1, gj = j + 1;
      const h = H[gj * G + gi];
      const hx = H[gj * G + gi + 1] - H[gj * G + gi - 1], hz = H[(gj + 1) * G + gi] - H[(gj - 1) * G + gi];
      let nx = -hx / (2 * step), nz = -hz / (2 * step); const l = Math.hypot(nx, 1, nz);
      const wx = x0 + i * step, wz = z0 + j * step;
      pos[k * 3] = wx - t.x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = wz - t.z;
      nor[k * 3] = nx / l; nor[k * 3 + 1] = 1 / l; nor[k * 3 + 2] = nz / l;
      const slope = 1 - 1 / l;
      cov[k * 2] = forestAt(wx, wz, h, slope); cov[k * 2 + 1] = farmAt(wx, wz, h, slope); { const tw = townAt(wx, wz); if (tw > 0) { let pv = 0; for (const T of TOWNS) { const d = Math.hypot(wx - T.x, wz - T.z); const R = T.core + T.grid * 0.6; if (d < R + 40) pv = Math.max(pv, Math.min(1, (R + 40 - d) / 50)); } cov[k * 2 + 1] = -tw - pv; } }
      k++;
    }
    // skirts
    const edges = [];
    for (let i = 0; i <= N; i++) edges.push(i); // top row j=0
    for (let i = 0; i <= N; i++) edges.push(N * (N + 1) + i); // bottom row
    for (let j = 0; j <= N; j++) edges.push(j * (N + 1)); // left col
    for (let j = 0; j <= N; j++) edges.push(j * (N + 1) + N); // right col
    const drop = step * 1.5 + 4;
    for (const e of edges) {
      pos[k * 3] = pos[e * 3]; pos[k * 3 + 1] = pos[e * 3 + 1] - drop; pos[k * 3 + 2] = pos[e * 3 + 2];
      nor[k * 3] = nor[e * 3]; nor[k * 3 + 1] = nor[e * 3 + 1]; nor[k * 3 + 2] = nor[e * 3 + 2];
      cov[k * 2] = cov[e * 2]; cov[k * 2 + 1] = cov[e * 2 + 1];
      k++;
    }
    const idx = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
      // alternate diagonal for better shape
      if ((i + j) & 1) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b);
    }
    const sk = (ofs, n, flip) => {
      for (let i = 0; i < n - 1; i++) {
        const a = edges[ofs + i], b = edges[ofs + i + 1], sa = vN + ofs + i, sb = vN + ofs + i + 1;
        if (flip) idx.push(a, sa, b, b, sa, sb); else idx.push(a, b, sa, b, sb, sa);
      }
    };
    sk(0, N + 1, false); sk(N + 1, N + 1, true); sk(2 * (N + 1), N + 1, true); sk(3 * (N + 1), N + 1, false);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('cover', new THREE.BufferAttribute(cov, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(t.x, 0, t.z);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    t.mesh = mesh;
    t.minH = geo.boundingBox.min.y; t.maxH = geo.boundingBox.max.y;
    this.built++;
  }

  shouldSplit(t, cam, agl) {
    if (t.size <= MIN_SIZE) return false;
    if (t.size <= 256 && agl > 900) return false;
    const dx = Math.max(Math.abs(cam.x - t.x) - t.size / 2, 0), dz = Math.max(Math.abs(cam.z - t.z) - t.size / 2, 0);
    const dy = Math.max(0, cam.y - (t.maxH ?? 300));
    const d = Math.hypot(dx, dz, dy * 0.7);
    return d < t.size * 1.35;
  }

  ensureChildren(t) {
    if (!t.children) {
      const h = t.size / 4, s = t.size / 2;
      t.children = [new Tile(t.x - h, t.z - h, s, t.level + 1), new Tile(t.x + h, t.z - h, s, t.level + 1), new Tile(t.x - h, t.z + h, s, t.level + 1), new Tile(t.x + h, t.z + h, s, t.level + 1)];
    }
    return t.children;
  }

  select(t, cam, agl, out) {
    t.lastUsed = this.frame;
    if (this.shouldSplit(t, cam, agl)) {
      const ch = this.ensureChildren(t);
      // descend only if every child (or its replacement) can draw
      const ready = ch.every((c) => c.mesh);
      if (ready) { for (const c of ch) this.select(c, cam, agl, out); return; }
      for (const c of ch) if (!c.mesh) this.queue.add(c);
    }
    if (!t.mesh) { this.queue.add(t); return; }
    out.push(t);
  }

  update(cam, agl, budgetMs = 7, force = false) {
    this.frame++;
    const out = [];
    this.queue.clear();
    this.select(this.root, cam, agl, out);
    // build queued tiles closest first within budget
    const q = [...this.queue].sort((a, b) => (a.size - b.size) * 0 + (Math.hypot(a.x - cam.x, a.z - cam.z) / a.size - Math.hypot(b.x - cam.x, b.z - cam.z) / b.size));
    const t0 = performance.now();
    for (const t of q) {
      if (!force && performance.now() - t0 > budgetMs) break;
      this.buildGeometry(t);
    }
    // visibility
    for (const c of this.group.children.slice()) c.visible = false;
    for (const t of out) { if (t.mesh.parent !== this.group) this.group.add(t.mesh); t.mesh.visible = true; }
    if (this.frame % 300 === 0) this.evict(this.root);
    this.pending = q.length;
    this.visibleCount = out.length;
    return q.length;
  }

  evict(t) {
    if (!t.children) return;
    for (const c of t.children) this.evict(c);
    if (t.children.every((c) => this.frame - c.lastUsed > 600 && !c.children)) {
      for (const c of t.children) if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null; }
      t.children = null;
    }
  }

  // warm-up: build everything needed at a location synchronously
  warm(cam, agl) { let guard = 0; while (this.update(cam, agl, 1e9, true) > 0 && guard++ < 30); this.update(cam, agl, 0); }
}
