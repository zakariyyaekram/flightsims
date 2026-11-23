// Quadtree LOD terrain with photographic texture splatting, procedural farmland and forest canopy.
import * as THREE from 'three';
import { heightAt, forestAt, farmAt, WORLD_HALF, WORLD_CX, WORLD_CZ, WATER_LEVEL, townAt, pavedAt } from './geo.js';
import { texArray, PH } from './textures.js';
import { GROUND_GLSL } from './ground.js?v=20261123g';
import { ORTHO_UNIFORMS, ORTHO_GLSL } from './ortho.js?v=20261123g';

const N = 32; // segments per tile
const MIN_SIZE = 128;

export const TERRAIN_LAYERS = [
  'leafy_grass', 'forest_ground_04', 'rock_face_03', 'dry_ground_rocks', 'coast_sand_01', 'snow_02', 'aerial_grass_rock', 'aerial_rocks_02', 'brown_mud_leaves_01',
];

export async function createTerrainMaterial(onProgress, size = 1024, groundUniforms = null) {
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
    ...ORTHO_UNIFORMS,
    ...(groundUniforms || { uGO0: { value: null }, uGO1: { value: null }, uGOr0: { value: new THREE.Vector4() }, uGOr1: { value: new THREE.Vector4() }, uGOon: { value: 0 }, uDry: { value: 0 } }),
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
${GROUND_GLSL}
${ORTHO_GLSL}
vec2 rot2(vec2 p, float a){ float c = cos(a), s = sin(a); return vec2(c*p.x + s*p.y, -s*p.x + c*p.y); }
float hh(float n){ return fract(sin(n*12.9898)*43758.5453); }
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
  GS g = groundSample(p, h21(floor(p * 0.7)) * 0.98 + 0.01);
  float og = g.w; // 1 where real OSM ground data is available
  if (uGOon > 0.5) {
    // season: California hills turn golden in summer / autumn; north-facing slopes and valley floors stay greener
    float dryA = clamp(uDry + (m1 - 0.5) * 0.6 + Nw.z * 0.6 - smoothstep(0., 60., uWater + 40. - vW.y) * 0.2, 0., 1.);
    vec3 gl = grassD / max(uAvg[0], vec3(.05));
    float lum = dot(mix(vec3(1.), gl, near*.8), vec3(.3,.59,.11));
    vec3 golden = mix(vec3(.36,.28,.15), vec3(.45,.37,.22), m3) * lum;
    golden = mix(golden, vec3(.27,.26,.15)*lum, smoothstep(.45,.8,m2)*.55); // olive patches
    // dark coyote-brush / coastal scrub clumps and first-rain green flush in hollows
    float bush = smoothstep(.58, .72, fbm3(p/16. + 11.3)) * (1. - near*.3);
    golden = mix(golden, vec3(.10,.12,.06)*(0.8+0.4*m3), bush*.75);
    golden = mix(golden, vec3(.20,.26,.10)*lum, smoothstep(.6,.85,fbm3(p/60.-4.))*(1.-uDry)*.8);
    grassC = mix(grassC, golden, smoothstep(.2, .7, dryA));
  }
  vec3 col = grassC;
  // worn dirt patches
  float wDirt = smoothstep(.62,.78, m2*.7+m3*.4) * (1.-near*.2) + smoothstep(.22,.38,slope)*.6;
  col = mix(col, mix(dirtD*.9, grassA*0.75, 1.-near), clamp(wDirt,0.,1.));
  // ---- town lawns: mown, watered grass with garden/hedge variation ----
  float lawn = smoothstep(0., .5, -vCover.y) * (g.cls == 0 ? 1. : 0.);
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
  float farm = smoothstep(.25,.6,vCover.y) * (g.cls == 0 ? 1. : 0.);
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

  // ---- real land use from OpenStreetMap ----
  float treeOK = 1.0; float gWater = 0.0;
  if (g.cls > 0) {
    float hs = float(g.hsh);
    vec2 q = rot2(p, g.ori);
    vec3 gl = mix(vec3(1.), grassD / max(uAvg[0], vec3(.05)), near*.7);
    vec3 sl = mix(vec3(1.), dirtD / max(uAvg[3], vec3(.05)), near*.7);
    float fineFade = 1.0 - smoothstep(120., 700., dist);
    vec3 lawnC = mix(vec3(.14,.21,.07), vec3(.19,.25,.10), m3) * gl * (0.86 + 0.28*m3);
    lawnC = mix(lawnC, vec3(.36,.32,.19)*gl, smoothstep(.5,.85,fbm3(p/23.+hs))*(.3+.45*uDry)); // dry / unwatered yards
    vec3 cc = col; float cw = 1.0;
    int c = g.cls;
    if (c == 1) { // farmland: November - ploughed, stubble, winter cover crop, fallow
      float t = hh(hs + floor(m1*3.)*7.) * 4.;
      float rowsp = t < 2. ? 0.9 : 0.6;
      float rows = 0.5 + 0.5*sin(q.y * 6.2832 / rowsp);
      if (t < 1.) cc = vec3(.30,.23,.16) * sl * (0.8 + 0.35*rows*fineFade);         // ploughed soil
      else if (t < 2.) cc = mix(vec3(.30,.24,.16)*sl, vec3(.20,.30,.10)*gl, 0.35 + 0.55*rows*fineFade + 0.2*m3); // sprouting rows
      else if (t < 3.) cc = vec3(.52,.45,.28) * gl * (0.85 + 0.2*rows*fineFade);    // stubble / straw
      else cc = mix(vec3(.42,.36,.22), vec3(.22,.30,.12), m2) * gl;                 // fallow / pasture
      // tractor turn-row at the border handled by the land-use edges; wheel tracks
      cc *= 1.0 - 0.12 * smoothstep(.96, 1., abs(sin(q.x * 6.2832 / 24.))) * fineFade;
      treeOK = 0.0;
    } else if (c == 29) { cc = mix(lawnC, col, .45); // urban grass, verges
    } else if (c == 2) { // meadow / pasture
      cc = mix(col, mix(vec3(.24,.31,.12)*gl, col, uDry*.7), .5 + .1*hs/7.);
    } else if (c == 3) { // orchard: tree rows with mown grass alleys
      vec2 cell = vec2(6.5, 5.0); vec2 f = (fract(q / cell) - .5) * cell;
      float tr = 1.0 - smoothstep(1.6, 2.4, length(f));
      vec3 alley = mix(vec3(.24,.30,.12)*gl, vec3(.36,.30,.20)*sl, abs(f.x) < 1.2 ? .7 : .15);
      vec3 canopyO = mix(vec3(.10,.15,.05), vec3(.32,.24,.08), hh(hs)*0.7 + 0.2) * (0.8 + 0.4*m3); // autumn orchard leaves
      cc = mix(alley, canopyO, tr * (0.5 + 0.5*fineFade) + (1.-fineFade)*.35);
      treeOK = 0.0;
    } else if (c == 4) { // vineyard: trellis rows, autumn foliage, cover crop between
      float rw = 2.4; float r = abs(fract(q.y / rw) - .5) * rw;
      float vine = 1.0 - smoothstep(0.45, 0.9, r);
      vec3 leaf = mix(vec3(.46,.36,.10), vec3(.42,.14,.07), hh(hs*3.1 + floor(q.x/80.)));
      leaf = mix(leaf, vec3(.30,.25,.12), .3*m3);
      vec3 inter = mix(vec3(.30,.25,.17)*sl, vec3(.22,.30,.11)*gl, hh(hs + 9.) > .5 ? .7 : .1);
      cc = mix(inter, leaf, vine * fineFade + (1.-fineFade)*.45);
      treeOK = 0.0;
    } else if (c == 5) { // farmyard
      cc = mix(vec3(.37,.32,.24)*sl, vec3(.30,.30,.18)*gl, smoothstep(.4,.7,m3));
    } else if (c == 6) { // residential: lawns, gardens
      cc = lawnC;
      cc = mix(cc, vec3(.27,.22,.16)*sl, smoothstep(.7,.85,fbm3(p/7.+3.))*.6); // beds / mulch
    } else if (c == 7 || c == 8) { // commercial / industrial lots
      vec3 conc = vec3(.30,.29,.27) * sl * (0.85 + 0.25*m3);
      cc = mix(conc, vec3(.33,.30,.25)*sl, smoothstep(.55,.8,m2)*.6);
      cc = mix(cc, lawnC, smoothstep(.72,.85,fbm3(p/15.))*.5);
      treeOK = 0.4;
    } else if (c == 9 || c == 17 || c == 27 || c == 16) { // park, grounds, playground, cemetery
      cc = lawnC * (0.94 + 0.1*step(.5, fract(q.x/5.))*fineFade);
      if (c == 16) { vec2 f = fract(q / vec2(2.2, 3.0)) - .5; cc = mix(cc, vec3(.55,.54,.5), (1.-smoothstep(.06,.12,length(f*vec2(1.,2.))))*fineFade*.8); }
      if (c == 27) cc = mix(cc, vec3(.40,.33,.24), .6);
    } else if (c == 10) { cc = vec3(.15,.27,.07) * gl * (0.9+0.2*m3); }                         // golf rough
    else if (c == 11) { cc = vec3(.16,.33,.07) * gl * (0.93 + 0.1*step(.5, fract(q.x/12.)) * fineFade); treeOK = 0.; }
    else if (c == 12) { cc = vec3(.17,.37,.08) * mix(vec3(1.), gl, .3); treeOK = 0.; }          // putting green
    else if (c == 13) { cc = mix(sandD, vec3(.68,.62,.48), .4) * 1.05; treeOK = 0.; }           // bunker
    else if (c == 14) { cc = vec3(.15,.31,.07) * (0.92 + 0.1*step(.5, fract(q.x/8.))*fineFade); treeOK = 0.; } // sports pitch
    else if (c == 15) { cc = vec3(.42,.17,.11) * (0.9+0.15*m3); treeOK = 0.; }                  // running track
    else if (c == 18) { treeOK = 2.0; cc = mix(col, forestD*.6, .5); }                          // wood
    else if (c == 19) { // scrub / chaparral
      float bush = smoothstep(.45, .6, fbm3(p/3.5 + hs));
      cc = mix(mix(col, vec3(.30,.27,.17)*sl, .3), vec3(.10,.13,.06)*(0.7+0.6*m3), bush*.85);
    } else if (c == 20) { // wetland / marsh
      cc = mix(vec3(.25,.27,.13)*gl, vec3(.33,.29,.18), m3);
      float ch = smoothstep(.48, .5, fbm3(p/18.)) * (1.-smoothstep(.5,.53, fbm3(p/18.)));
      cc = mix(cc, vec3(.05,.08,.08), ch*.8); treeOK = 0.;
    } else if (c == 21) { cc = mix(dirtD, rockD, .5) * .9; treeOK = 0.; }                      // bare rock / sand
    else if (c == 22) { // parking lot with stall stripes
      vec3 asph = vec3(.075) * (0.85 + 0.3*vnoise(p*.7)) * mix(vec3(1.), sl, near*.3);
      vec2 f = q / vec2(2.7, 5.4); float st = (1.-smoothstep(.02,.05,abs(fract(f.x)-.5)-.45)) * step(abs(fract(f.y*.5)-.5), .45);
      cc = mix(asph, vec3(.6,.6,.56), st*fineFade*.8); treeOK = 0.;
    } else if (c == 23 || c == 28) { // pools & ponds
      cc = c == 23 ? vec3(.10,.42,.52) : mix(vec3(.04,.08,.09), vec3(.06,.10,.08), m2); gWater = 1.0; treeOK = 0.;
    } else if (c == 24) { float r = abs(fract(q.y/1.6)-.5); cc = mix(vec3(.32,.30,.27), vec3(.10,.20,.06)*gl, step(r,.3)); treeOK = 0.; }
    else if (c == 25) { vec2 id = floor(q/vec2(9.,14.)); cc = mix(vec3(.30,.24,.16)*sl, vec3(.18,.30,.09)*gl, hh(dot(id,vec2(1.3,7.1)))); }
    else if (c == 26) { cc = vec3(.30,.28,.25) * sl * (0.8 + 0.3*vnoise(p*2.)); treeOK = 0.; }  // rail ballast
    col = mix(col, cc, og * cw);
  }
  // ---- forest canopy ----
  float fo = clamp(vCover.x + (m3-.5)*.5 + (m2-.5)*.3, 0., 1.);
  fo = smoothstep(.35, .55, fo);
  if (og > 0.0) fo = treeOK > 1.5 ? max(fo, .85) : fo * mix(1.0, treeOK, og);
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
  float wSand = (1.0 - smoothstep(uWater+0.3, uWater+1.6 + m3*1.2, vW.y)) * (1.0 - smoothstep(0., .3, -vCover.y)) * ((og > 0.0 && g.cls != 0 && g.cls != 21 && g.cls != 13) ? 1.0 - og : 1.0);
  col = mix(col, mix(sandD*.95, vec3(.55,.5,.4), 1.-near), wSand);
  // ---- snow ----
  float wSnow = smoothstep(uSnow - 60., uSnow + 80., vW.y + (m1-.5)*260. + (m3-.5)*60.) * (1. - smoothstep(.45, .7, slope));
  col = mix(col, mix(vec3(.86,.88,.92), snowD, near), wSnow);

  // ---- pavement from OSM: streets, sidewalks, driveways, paths, tracks ----
  float pcov = og > 0.0 ? g.cov : 0.0;
  if (pcov > 0.003) {
    float pm = g.mat;
    float gn = vnoise(p*2.3)*.5 + vnoise(p*9.1)*.3 + h21(floor(p*12.))*.2;
    float closeF = 1.-smoothstep(15., 60., dist);
    // asphalt with patches, oil streaks and fine cracks
    vec3 cA = vec3(.068) * (0.82 + 0.3*gn) * mix(vec3(1.), dirtD / max(uAvg[3], vec3(.05)), near*.18);
    cA *= 0.9 + 0.2*smoothstep(.55,.8,m2);
    float cn = fbm3(p*vec2(.35,1.1) + 3.7); float ck = smoothstep(.49, .5, cn) * (1.-smoothstep(.5,.51, cn));
    cA *= 1.0 - ck * .18 * closeF;
    // concrete with expansion joints
    vec3 cC = vec3(.34,.33,.31) * (0.86 + 0.2*gn);
    vec2 sl2 = abs(fract(p / 1.6) - 0.5); cC *= 1.0 - smoothstep(.46, .5, max(sl2.x, sl2.y)) * (1.0 - smoothstep(20., 70., dist)) * .3;
    vec3 cG = mix(vec3(.40,.37,.32), vec3(.30,.28,.24), h21(floor(p*20.))) * (0.85+0.25*gn);
    vec3 cD = vec3(.37,.29,.20) * (0.8 + 0.35*gn) * mix(vec3(1.), dirtD / max(uAvg[3], vec3(.05)), near*.5);
    vec3 pc = pm < 1.0 ? mix(cA, cC, smoothstep(0.25, 0.75, pm)) : pm < 2.0 ? mix(cC, cG, smoothstep(1.25, 1.75, pm)) : mix(cG, cD, smoothstep(2.25, 2.75, pm));
    // grass growing over the edges of tracks / paths, darker kerb line at paved edges
    float edgeK = 1.0 - abs(pcov*2.0 - 1.0);
    pc *= pm < 1.5 ? 1.0 - edgeK*.25 : 1.0;
    float a = pm > 1.5 ? smoothstep(.15, .9, pcov + (gn - .5)*.4) : smoothstep(.05, .6, pcov);
    col = mix(col, pc, a);
    gWater *= 1.0 - a;
  }
  // ---- airport orthophoto (USGS NAIP): real ground colours around each airfield ----
  {
    vec4 oa = orthoAt(p, 0.0, 160.0);
    if (oa.a > 0.0) {
      // keep some close-range texture from the splat so the 0.6-1 m/px photo doesn't look smeared underfoot
      float detail = 1.0 + ((vnoise(p*1.9)-.5)*.16 + (vnoise(p*7.3)-.5)*.1) * near;
      vec3 oc = oa.rgb * 0.92 * detail;
      col = mix(col, oc, oa.a);
      float olum = dot(oa.rgb, vec3(.3,.59,.11));
      // the photo's water (dark, blue-grey) keeps the reflective water shading; dry land does not
      gWater *= mix(1.0, smoothstep(0.16, 0.06, olum) * step(oa.r, oa.b + 0.02), oa.a);
      wSnow *= 1.0 - oa.a;
    }
  }
  // far haze desaturation (Rayleigh is handled by fog)
  col = mix(col, vec3(dot(col, vec3(.3,.59,.11))), (1.-mid)*.25);
  diffuseColor.rgb *= col;
  gRough = mix(0.97, 0.88, wRock); gRough = mix(gRough, 0.55, wSnow); gRough = mix(gRough, 0.08, gWater);
  // detail normal blend
  vec3 tn = vec3(0.,0.,1.);
  if (near > 0.0) {
    vec3 ng = NT(0, p/3.2), nr = NT(2, p/9.), nd = NT(3, p/4.), ns = NT(5, p/6.);
    tn = normalize(mix(mix(mix(ng, nd, clamp(wDirt,0.,1.)), nr, wRock), ns, wSnow));
    tn.xy *= near * 1.2 * (1.0 - (og > 0.0 ? smoothstep(.1,.7,g.cov) * .8 + gWater : 0.0));
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
  // opts.radius: only build/draw tiles within this horizontal distance of the camera (local-area mode).
  // opts.maxTileSize: never draw tiles larger than this (avoids building huge region-wide tiles).
  constructor(scene, material, opts = {}) {
    this.scene = scene; this.material = material;
    this.radius = opts.radius ?? Infinity;
    this.maxTileSize = opts.maxTileSize ?? Infinity;
    this.minTileSize = opts.minTileSize ?? MIN_SIZE; // finest tile size
    this.lodScale = opts.lodScale ?? 1.35;           // lower = coarser detail falls off sooner
    this.root = new Tile(WORLD_CX, WORLD_CZ, WORLD_HALF * 2, 0);
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
      cov[k * 2] = forestAt(wx, wz, h, slope); { const tw = townAt(wx, wz); cov[k * 2 + 1] = tw > 0.12 ? -(tw + (tw > 0.7 ? (tw - 0.7) * 2.6 : 0)) : farmAt(wx, wz) * (1 - tw * 4); }
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

  outside(t, cam) {
    if (!Number.isFinite(this.radius)) return false;
    const dx = Math.max(Math.abs(cam.x - t.x) - t.size / 2, 0), dz = Math.max(Math.abs(cam.z - t.z) - t.size / 2, 0);
    return Math.hypot(dx, dz) > this.radius;
  }

  shouldSplit(t, cam, agl) {
    if (t.size > this.maxTileSize) return true;
    if (t.size <= this.minTileSize) return false;
    if (t.size <= 256 && agl > 900) return false;
    const dx = Math.max(Math.abs(cam.x - t.x) - t.size / 2, 0), dz = Math.max(Math.abs(cam.z - t.z) - t.size / 2, 0);
    const dy = Math.max(0, cam.y - (t.maxH ?? 300));
    const d = Math.hypot(dx, dz, dy * 0.7);
    return d < t.size * this.lodScale;
  }

  ensureChildren(t) {
    if (!t.children) {
      const h = t.size / 4, s = t.size / 2;
      t.children = [new Tile(t.x - h, t.z - h, s, t.level + 1), new Tile(t.x + h, t.z - h, s, t.level + 1), new Tile(t.x - h, t.z + h, s, t.level + 1), new Tile(t.x + h, t.z + h, s, t.level + 1)];
    }
    return t.children;
  }

  select(t, cam, agl, out) {
    if (this.outside(t, cam)) return; // beyond the local area: never built, never drawn
    t.lastUsed = this.frame;
    if (t.size > this.maxTileSize) {
      // too large to ever draw in local-area mode: always descend
      for (const c of this.ensureChildren(t)) this.select(c, cam, agl, out);
      return;
    }
    if (this.shouldSplit(t, cam, agl)) {
      const ch = this.ensureChildren(t);
      // descend only if every child (or its replacement) can draw
      const ready = ch.every((c) => c.mesh || this.outside(c, cam));
      if (ready) { for (const c of ch) this.select(c, cam, agl, out); return; }
      for (const c of ch) if (!c.mesh && !this.outside(c, cam)) this.queue.add(c);
    }
    if (!t.mesh) { this.queue.add(t); return; }
    out.push(t);
  }

  // ahead: optional predicted camera position (direction of travel). Tiles needed there are queued after the
  // ones needed now, so by the time the aircraft arrives they are already built.
  update(cam, agl, budgetMs = 7, force = false, ahead = null) {
    this.frame++;
    const out = [];
    this.queue.clear();
    this.select(this.root, cam, agl, out);
    // build queued tiles closest first within budget
    const key = (t, c) => Math.hypot(t.x - c.x, t.z - c.z) / t.size;
    const q = [...this.queue].sort((a, b) => key(a, cam) - key(b, cam));
    let pre = [];
    if (ahead && !force && q.length < 4) {
      this.queue.clear();
      this.select(this.root, ahead, agl, []);
      pre = [...this.queue].filter((t) => !t.mesh).sort((a, b) => key(a, ahead) - key(b, ahead));
      this.prefetching = pre.length;
    }
    const t0 = performance.now();
    for (const t of q) {
      if (!force && performance.now() - t0 > budgetMs) break;
      this.buildGeometry(t);
    }
    // prefetch gets at most half the budget
    for (const t of pre) {
      if (performance.now() - t0 > budgetMs * 0.5) break;
      if (!t.mesh) this.buildGeometry(t);
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
    const stale = (c) => this.frame - c.lastUsed > 600;
    // local-area mode: free leaf tiles that have fallen behind the aircraft right away
    if (Number.isFinite(this.radius)) {
      for (const c of t.children) if (!c.children && c.mesh && stale(c)) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null; }
    }
    if (t.children.every((c) => stale(c) && !c.children)) {
      for (const c of t.children) if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null; }
      t.children = null;
    }
  }

  // warm-up: build everything needed at a location synchronously
  warm(cam, agl) { let guard = 0; while (this.update(cam, agl, 1e9, true) > 0 && guard++ < 30); this.update(cam, agl, 0); }
}
