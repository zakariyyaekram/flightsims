// Airports (runways, markings, taxiways, lights, PAPI, buildings), vegetation, photoscanned rocks, town.
import * as THREE from 'three';
import { heightAt, normalAt, surfaceAt, forestAt, farmAt, AIRPORTS, TOWN, TOWNS, ROADS, WATER_LEVEL, toLocal, fromLocal, townWorld, townAt } from './geo.js';
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
function stripGeometry(a, u0, u1, v0, v1, du = 12, lift = 0.07) {
  const nu = Math.max(1, Math.ceil((u1 - u0) / du)), nv = Math.max(1, Math.ceil((v1 - v0) / 8));
  const pos = [], uv = [], uvm = [], idx = [];
  for (let j = 0; j <= nu; j++) for (let i = 0; i <= nv; i++) {
    const u = u0 + (u1 - u0) * j / nu, v = v0 + (v1 - v0) * i / nv;
    const { x, z } = fromLocal(a, u, v);
    pos.push(x, heightAt(x, z) + lift, z);
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

function pavementMaterial(asph, markTex, tint = 1) {
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
  return m;
}

// Runway markings canvas (R = white paint, G = yellow paint, B = rubber deposits)
function runwayMarkings(a) {
  const S = 2, W = 256; // px per meter along, px across
  const H = Math.min(8192, Math.round(a.len * S));
  const s = H / a.len, ax = W / a.wid;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const rnd = mulberry(a.x * 3 + a.z);
  // helper in threshold frame (end e, d along from threshold, w lateral right)
  const rect = (e, d0, d1, w0, w1, col) => {
    const u0 = e === 0 ? -a.len / 2 + d0 : a.len / 2 - d1, u1 = e === 0 ? -a.len / 2 + d1 : a.len / 2 - d0;
    const v0 = e === 0 ? w0 : -w1, v1 = e === 0 ? w1 : -w0;
    g.fillStyle = col; g.fillRect((v0 + a.wid / 2) * ax, (a.len / 2 - u1) * s, (v1 - v0) * ax, (u1 - u0) * s);
  };
  const W2 = a.wid / 2;
  const white = '#ff0000', rub = 'rgba(0,0,255,';
  // rubber deposits first (so paint covers? paint wears over rubber -> draw rubber after paint lightly)
  for (let e = 0; e < 2; e++) {
    // edge stripes
    rect(e, 0, a.len / 2, -W2 + 0.4, -W2 + 1.3, white); rect(e, 0, a.len / 2, W2 - 1.3, W2 - 0.4, white);
    // threshold bars
    const nb = a.wid >= 30 ? 6 : a.wid >= 23 ? 4 : 3;
    for (let i = 0; i < nb; i++) { const w0 = 1.8 + i * 3.6; rect(e, 6, 36, w0, w0 + 1.8, white); rect(e, 6, 36, -w0 - 1.8, -w0, white); }
    // designation numbers
    const num = a.rwy[e];
    g.save();
    const dC = 54; // centre of number from threshold
    const uC = e === 0 ? -a.len / 2 + dC : a.len / 2 - dC;
    g.translate(W / 2, (a.len / 2 - uC) * s);
    g.scale(ax, s);
    if (e === 1) g.rotate(Math.PI);
    g.fillStyle = white; g.font = `700 25px "Barlow Condensed", Arial Narrow, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.save(); g.scale(0.6 * Math.min(1, a.wid / 30), 1.0); g.fillText(num, 0, 0); g.restore();
    g.restore();
    // aiming point (1000 ft) and touchdown zone markings for precision runway end
    const precision = a.ils && a.ils.end === e;
    if (a.len >= 1100) { rect(e, 300, 345, 2.7, 2.7 + 6, white); rect(e, 300, 345, -2.7 - 6, -2.7, white); }
    if (precision) {
      const tdz = [[150, 3], [450, 2], [600, 2], [750, 1], [900, 1]];
      for (const [d, n] of tdz) for (let k = 0; k < n; k++) { const w0 = 2.7 + k * 1.8; rect(e, d, d + 22.5, w0, w0 + 0.9, white); rect(e, d, d + 22.5, -w0 - 0.9, -w0, white); }
    }
  }
  // centerline
  for (let d = 70; d < a.len - 70; d += 60) {
    const u0 = -a.len / 2 + d; g.fillStyle = white; g.fillRect((a.wid / 2 - 0.45) * ax, (a.len / 2 - (u0 + 36)) * s, 0.9 * ax, 36 * s);
  }
  // rubber deposits in touchdown zones (both ends) + general wear along centerline
  g.globalCompositeOperation = 'lighter';
  for (let e = 0; e < 2; e++) for (let i = 0; i < 2600; i++) {
    const d = 120 + Math.pow(rnd(), 1.6) * 520;
    const w = (rnd() - 0.5) * a.wid * 0.38 + (rnd() < 0.5 ? -1 : 1) * 1.3;
    const l = 4 + rnd() * 22;
    const u = e === 0 ? -a.len / 2 + d : a.len / 2 - d;
    g.fillStyle = rub + (0.05 + rnd() * 0.12).toFixed(3) + ')';
    g.fillRect((w + a.wid / 2) * ax, (a.len / 2 - u) * s, (0.25 + rnd() * 0.5) * ax, l * s);
  }
  // cracks / sealant lines (dark thin)
  g.strokeStyle = 'rgba(0,0,255,0.35)'; g.lineWidth = 1;
  for (let i = 0; i < 160; i++) { const y = rnd() * H; g.beginPath(); g.moveTo(0, y); let x = 0; while (x < W) { x += 10 + rnd() * 30; g.lineTo(x, y + (rnd() - 0.5) * 6); } g.stroke(); }
  for (let y = 0; y < H; y += 7.5 * s) { g.fillStyle = 'rgba(0,0,255,0.18)'; g.fillRect(0, y, W, 1); } // joints
  return canvasTex(c);
}
function canvasTex(c) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.anisotropy = 16; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t;
}
function taxiMarkings(len, wid, opts = {}) {
  const S = 2, W = 64, H = Math.min(4096, Math.round(len * S));
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const ax = W / wid;
  g.fillStyle = '#00ff00'; g.fillRect((wid / 2 - 0.08) * ax, 0, 0.16 * ax, H); // yellow centerline
  g.fillRect(0.2 * ax, 0, 0.15 * ax, H); g.fillRect((wid - 0.35) * ax, 0, 0.15 * ax, H); // edges (double yellow simplified)
  if (opts.holdAt != null) { // hold short line (two solid + two dashed) near runway end of connector
    const y = H - opts.holdAt * S;
    for (let k = 0; k < 2; k++) g.fillRect(0, y + k * 1.2 * S, W, 0.3 * S);
    for (let k = 0; k < 2; k++) for (let x = 0; x < W; x += 1.8 * ax) g.fillRect(x, y + (2.6 + k * 1.2) * S, 0.9 * ax, 0.3 * S);
  }
  const rnd = mulberry(len * 7); g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(0,0,255,${(0.03 + rnd() * 0.08).toFixed(3)})`; g.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 6, 6 + rnd() * 30); }
  return canvasTex(c);
}
function apronMarkings(w, h) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256; const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 512, 256);
  const ax = 512 / w, ay = 256 / h;
  // tie-down T markings in rows
  g.fillStyle = '#00ff00';
  for (let row = 0; row < 2; row++) for (let x = 16; x < w - 16; x += 14) {
    const y = h * (0.3 + row * 0.42);
    g.fillRect((x - 2) * ax, y * ay, 4 * ax, 0.25 * ay * 2); g.fillRect((x - 0.12) * ax, y * ay, 0.25 * ax * 2, 4 * ay);
  }
  // lead-in line
  g.fillRect(0, h * 0.92 * ay, 512, 0.3 * ay * 2);
  const rnd = mulberry(w * h); g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,255,${(0.04 + rnd() * 0.12).toFixed(3)})`; g.beginPath(); g.arc(rnd() * 512, rnd() * 256, 1 + rnd() * 7, 0, 7); g.fill(); }
  return canvasTex(c);
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

export async function buildAirports(scene, envMap, buildAircraftFn) {
  const [asph, concrete, corr, plaster, roofT] = await Promise.all([
    pbr('asphalt_02', 1), pbr('concrete_floor_02', 1), pbr('corrugated_iron_02', 1), pbr('painted_plaster_wall', 1), pbr('grey_roof_01', 1),
  ]);
  const group = new THREE.Group(); scene.add(group);
  const lightsList = [], papis = [], beacons = [];
  const metal = new THREE.MeshStandardMaterial({ map: corr.diff, normalMap: corr.nor, roughnessMap: corr.rough, metalness: 0.6, roughness: 1, color: 0xd8dde2 });
  const metalWhite = new THREE.MeshStandardMaterial({ map: corr.diff, normalMap: corr.nor, roughnessMap: corr.rough, metalness: 0.3, roughness: 1, color: 0xf2f2ee });
  const wallM = new THREE.MeshStandardMaterial({ map: plaster.diff, normalMap: plaster.nor, roughness: 0.95, color: 0xe9e2d6 });
  const roofM = new THREE.MeshStandardMaterial({ map: roofT.diff, normalMap: roofT.nor, roughness: 0.9, color: 0x8a8e92 });
  const darkGlass = new THREE.MeshPhysicalMaterial({ color: 0x223040, roughness: 0.05, metalness: 0.2, envMapIntensity: 1.5 });
  const doorM = new THREE.MeshStandardMaterial({ color: 0x24282c, roughness: 0.5, metalness: 0.6 });
  const concreteM = new THREE.MeshStandardMaterial({ map: concrete.diff, normalMap: concrete.nor, roughness: 0.95 });
  for (const a of AIRPORTS) {
    const ang = -a.hdg * D2R; // rotation about Y so local +u aligns with runway direction
    const placeLocal = (mesh, u, v, yOff = 0, rot = 0) => {
      const { x, z } = fromLocal(a, u, v); mesh.position.set(x, a.elev + yOff, z); mesh.rotation.y = ang + rot; group.add(mesh); return mesh;
    };
    // runway
    const rg = stripGeometry(a, -a.len / 2, a.len / 2, -a.wid / 2, a.wid / 2, 10, 0.08);
    const rm = new THREE.Mesh(rg, pavementMaterial(asph, runwayMarkings(a), 0.92));
    rm.receiveShadow = true; group.add(rm);
    // blast pads / overruns
    for (const e of [-1, 1]) {
      const g = stripGeometry(a, e < 0 ? -a.len / 2 - 45 : a.len / 2, e < 0 ? -a.len / 2 : a.len / 2 + 45, -a.wid / 2, a.wid / 2, 10, 0.07);
      const m = new THREE.Mesh(g, pavementMaterial(asph, taxiMarkings(45, a.wid), 0.78)); m.receiveShadow = true; group.add(m);
    }
    // parallel taxiway + connectors
    const tw = 12, tv = a.taxiV;
    const tg = stripGeometry(a, -a.len / 2 + 10, a.len / 2 - 10, tv - tw / 2, tv + tw / 2, 12, 0.075);
    group.add(Object.assign(new THREE.Mesh(tg, pavementMaterial(asph, taxiMarkings(a.len - 20, tw), 0.82)), { receiveShadow: true }));
    const conns = [-a.len / 2 + 16, 0, a.len / 2 - 16];
    for (const cu of conns) {
      const v0 = Math.min(tv, -a.wid / 2), v1 = Math.max(tv, -a.wid / 2);
      const g = stripGeometry(a, cu - tw / 2, cu + tw / 2, v0 + (tv < 0 ? -tw / 2 : 0), v1 + (tv < 0 ? 0 : tw / 2), 6, 0.076);
      // markings oriented along v for connectors (reuse generic marks)
      group.add(Object.assign(new THREE.Mesh(g, pavementMaterial(asph, taxiMarkings(30, tw), 0.82)), { receiveShadow: true }));
    }
    // apron
    const ap = a.apron;
    const apg = stripGeometry(a, ap.u - ap.w / 2, ap.u + ap.w / 2, ap.v - ap.h / 2, ap.v + ap.h / 2, 12, 0.074);
    group.add(Object.assign(new THREE.Mesh(apg, pavementMaterial(concrete, apronMarkings(ap.h, ap.w), 0.95)), { receiveShadow: true }));
    // apron <-> taxiway link
    {
      const g = stripGeometry(a, ap.u - 8, ap.u + 8, Math.min(tv, ap.v + ap.h / 2), Math.max(tv, ap.v + ap.h / 2), 6, 0.0745);
      group.add(Object.assign(new THREE.Mesh(g, pavementMaterial(asph, taxiMarkings(30, 16), 0.82)), { receiveShadow: true }));
    }
    // ---- buildings along far side of apron ----
    const bv = ap.v - ap.h / 2 - 14; // behind apron
    const nH = a.icao === 'KVLY' ? 4 : 2;
    for (let i = 0; i < nH; i++) {
      const hw = 30, hd = 26, hh = 10;
      const u = ap.u - ap.w / 2 + 25 + i * 42;
      const hang = new THREE.Group();
      const body = new THREE.Mesh(boxUV(hw, hh, hd, 3), i % 2 ? metal : metalWhite); body.position.y = hh / 2; body.castShadow = true; body.receiveShadow = true; hang.add(body);
      const roofG = new THREE.CylinderGeometry(hd * 0.75, hd * 0.75, hw + 0.6, 24, 1, false, -0.6, 1.2); roofG.rotateZ(Math.PI / 2); roofG.rotateY(0);
      const roof = new THREE.Mesh(roofG, metal); roof.position.y = hh - hd * 0.75 * Math.cos(0.6) + 0.1; roof.castShadow = true; hang.add(roof);
      roof.rotation.y = 0; roof.rotation.x = 0;
      const door = new THREE.Mesh(new THREE.PlaneGeometry(hw * 0.86, hh * 0.85), doorM); door.position.set(0, hh * 0.43, hd / 2 + 0.03); hang.add(door);
      for (let k = 1; k < 5; k++) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.12, hh * 0.85, 0.08), metal); l.position.set(-hw * 0.43 + k * hw * 0.86 / 5, hh * 0.43, hd / 2 + 0.06); hang.add(l); }
      // hangar faces runway: local +z of group toward +v (runway side)
      const { x, z } = fromLocal(a, u, bv - hd / 2);
      hang.position.set(x, a.elev, z); hang.rotation.y = ang + Math.PI; group.add(hang);
      // hangar ceiling light (night)
      lightsList.push({ p: [x + a.perp[0] * (hd / 2 + 0.5), a.elev + hh * 0.9, z + a.perp[1] * (hd / 2 + 0.5)], c: [1, 0.85, 0.6], s: 1.6 });
    }
    // FBO / terminal
    {
      const u = ap.u + ap.w / 2 - 34;
      const b = new THREE.Group();
      const wall = new THREE.Mesh(boxUV(34, 6.5, 16, 3), wallM); wall.position.y = 3.25; wall.castShadow = wall.receiveShadow = true; b.add(wall);
      const win = new THREE.Mesh(new THREE.PlaneGeometry(28, 3), darkGlass); win.position.set(0, 3.2, 8.02); b.add(win);
      const roof = new THREE.Mesh(boxUV(36, 0.6, 18, 4), roofM); roof.position.y = 6.8; roof.castShadow = true; b.add(roof);
      const sign = document.createElement('canvas'); sign.width = 512; sign.height = 64; const sg = sign.getContext('2d'); sg.fillStyle = '#1b3a5c'; sg.fillRect(0, 0, 512, 64); sg.fillStyle = '#fff'; sg.font = '700 38px Barlow, sans-serif'; sg.textAlign = 'center'; sg.fillText(a.name.toUpperCase(), 256, 46);
      const st = new THREE.CanvasTexture(sign); st.colorSpace = THREE.SRGBColorSpace;
      const sm = new THREE.Mesh(new THREE.PlaneGeometry(14, 1.75), new THREE.MeshStandardMaterial({ map: st, roughness: 0.6 })); sm.position.set(0, 5.6, 8.05); b.add(sm);
      const { x, z } = fromLocal(a, u, bv - 8); b.position.set(x, a.elev, z); b.rotation.y = ang + Math.PI; group.add(b);
      // fuel farm
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 7, 24).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xf0efe9, roughness: 0.4, metalness: 0.2 }));
      tank.castShadow = true; placeLocal(tank, u + 26, bv - 2, 2.1);
      const pad = new THREE.Mesh(boxUV(10, 0.4, 5, 3), concreteM); placeLocal(pad, u + 26, bv - 2, 0.2);
    }
    // control tower
    if (a.tower) {
      const t = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.0, 18, 24), concreteM); shaft.position.y = 9; shaft.castShadow = true; t.add(shaft);
      const cab = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.0, 4, 8), darkGlass); cab.position.y = 20; t.add(cab);
      const cabRoof = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.0, 0.7, 8), wallM); cabRoof.position.y = 22.3; cabRoof.castShadow = true; t.add(cabRoof);
      const deck = new THREE.Mesh(new THREE.CylinderGeometry(5.0, 5.0, 0.8, 8), wallM); deck.position.y = 17.6; t.add(deck);
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 5, 6), new THREE.MeshStandardMaterial({ color: 0xdddddd })); ant.position.y = 25; t.add(ant);
      const { x, z } = fromLocal(a, ap.u - ap.w / 2 - 40, ap.v - 10); t.position.set(x, a.elev, z); group.add(t);
      a.towerPos = new THREE.Vector3(x, a.elev + 20.5, z);
      lightsList.push({ p: [x, a.elev + 27.6, z], c: [1, 0.1, 0.05], s: 1.4 });
    }
    // rotating beacon pole
    {
      const { x, z } = fromLocal(a, ap.u - ap.w / 2 - 10, ap.v - ap.h / 2 - 30);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 16, 8), new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.7, roughness: 0.4 }));
      pole.position.set(x, a.elev + 8, z); pole.castShadow = true; group.add(pole);
      beacons.push({ p: new THREE.Vector3(x, a.elev + 16.5, z) });
    }
    // windsock
    {
      const { x, z } = fromLocal(a, -a.len / 2 + 250, a.wid / 2 + 60);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 6, 8), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.6, roughness: 0.4 }));
      pole.position.set(x, a.elev + 3, z); pole.castShadow = true; group.add(pole);
      const sockC = document.createElement('canvas'); sockC.width = 256; sockC.height = 32; const sg = sockC.getContext('2d');
      for (let i = 0; i < 5; i++) { sg.fillStyle = i % 2 ? '#f4f4f4' : '#ff5a12'; sg.fillRect(i * 51.2, 0, 51.2, 32); }
      const st = new THREE.CanvasTexture(sockC); st.colorSpace = THREE.SRGBColorSpace;
      const sg2 = new THREE.CylinderGeometry(0.22, 0.42, 2.8, 16, 6, true); sg2.rotateZ(-Math.PI / 2); sg2.translate(1.4, 0, 0);
      const uv = sg2.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i), uv.getX(i));
      const sock = new THREE.Mesh(sg2, new THREE.MeshStandardMaterial({ map: st, side: THREE.DoubleSide, roughness: 0.9 }));
      sock.castShadow = true;
      const piv = new THREE.Group(); piv.position.set(x, a.elev + 5.8, z); piv.add(sock); group.add(piv);
      a.windsock = piv;
      // segmented circle
      const ring = new THREE.Mesh(new THREE.TorusGeometry(10, 0.25, 4, 32).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xf1f1f1, roughness: 0.8 }));
      ring.position.set(x, a.elev + 0.05, z); group.add(ring);
    }
    // runway edge lights, threshold/end lights
    const instr = !!a.ils;
    for (let d = 0; d <= a.len + 0.1; d += 60) {
      for (const sgn of [-1, 1]) {
        const { x, z } = fromLocal(a, -a.len / 2 + d, sgn * (a.wid / 2 + 1.5));
        const nearEnd = instr && (a.len - d < 600 || d < 600);
        lightsList.push({ p: [x, a.elev + 0.45, z], c: nearEnd ? [1, 0.82, 0.35] : [1, 0.93, 0.8], s: 1 });
      }
    }
    for (const e of [-1, 1]) for (let w = -a.wid / 2; w <= a.wid / 2 + 0.1; w += 3) {
      const { x, z } = fromLocal(a, e * (a.len / 2 + 1), w);
      lightsList.push({ p: [x, a.elev + 0.35, z], c: [0.3, 1, 0.35], s: 0.9 }); // green threshold (seen from approach)
    }
    // taxiway edge lights (blue)
    for (let d = -a.len / 2 + 10; d <= a.len / 2 - 10; d += 45) for (const sgn of [-1, 1]) {
      const { x, z } = fromLocal(a, d, tv + sgn * (tw / 2 + 1)); lightsList.push({ p: [x, a.elev + 0.35, z], c: [0.15, 0.35, 1], s: 0.8 });
    }
    // approach lighting (MALSR-like) for ILS end
    if (a.ils) {
      const e = a.ils.end; const sgnU = e === 0 ? -1 : 1;
      for (let d = 60; d <= 720; d += 60) for (let w = -6; w <= 6; w += 1.5) {
        if (d > 200 && Math.abs(w) > 2) continue;
        const { x, z } = fromLocal(a, sgnU * (a.len / 2 + d), w);
        lightsList.push({ p: [x, heightAt(x, z) + 1.2, z], c: [1, 0.95, 0.85], s: 1.1 });
      }
    }
    // PAPI (left side of each runway end, 300 m from threshold)
    for (let e = 0; e < 2; e++) {
      const sgnU = e === 0 ? -1 : 1; // threshold side
      const units = [];
      for (let k = 0; k < 4; k++) {
        const w = -(a.wid / 2 + 15 + k * 9); // left of landing direction
        const { x, z } = fromLocal(a, sgnU * (a.len / 2 - 300), e === 0 ? w : -w);
        const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 1.2), new THREE.MeshStandardMaterial({ color: 0xe0a020, roughness: 0.6 }));
        box.position.set(x, a.elev + 0.4, z); box.rotation.y = ang; group.add(box);
        units.push({ p: [x, a.elev + 0.85, z], c: [1, 1, 1], s: 2.4, ang: [3.5, 3.17, 2.83, 2.5][k] });
      }
      papis.push({ a, e, units, thr: fromLocal(a, sgnU * (a.len / 2 - 300), 0) });
    }
  }
  const lm = lightMaterial();
  const rlights = makePoints(lightsList, lm); group.add(rlights);
  const papiList = papis.flatMap((p) => p.units);
  const pm = lightMaterial(); pm.uniforms.uNight.value = 1;
  const papiPts = makePoints(papiList, pm); group.add(papiPts);
  const beaconMat = lightMaterial(); beaconMat.uniforms.uNight.value = 1;
  const beaconPts = makePoints(beacons.map((b) => ({ p: b.p.toArray(), c: [0, 0, 0], s: 3.5 })), beaconMat); group.add(beaconPts);

  // parked aircraft on aprons (static: merged per material to keep draw calls low)
  const parked = [];
  if (buildAircraftFn) {
    const regs = [['N5284Q', 1], ['N738HP', 2], ['N12KD', 3], ['N64220', 1]];
    let i = 0;
    for (const a of AIRPORTS) {
      const n = a.icao === 'KVLY' ? 3 : 1;
      for (let k = 0; k < n; k++) {
        const [reg, sch] = regs[i++ % regs.length];
        const m = await buildAircraftFn({ envMap, reg, scheme: sch, interior: false, lights: false });
        const ap = a.apron; const u = ap.u - ap.w / 2 + 24 + k * 14 * 2, v = ap.v - ap.h * 0.2;
        const { x, z } = fromLocal(a, u, v);
        m.position.set(x, a.elev + 1.19, z);
        // nose toward runway (+v side) -> heading = hdg + 90
        const hdg = a.hdg + 90 + (k % 2 ? 6 : -4);
        m.rotation.set(0, (90 - hdg) * D2R, 0);
        const flat = flattenStatic(m);
        group.add(flat); parked.push(flat);
      }
    }
  }

  const updateLights = (camPos, night, t) => {
    lm.uniforms.uNight.value = night;
    // PAPI color by elevation angle from each unit
    const col = papiPts.geometry.attributes.color;
    let idx = 0;
    for (const p of papis) for (const u of p.units) {
      const dx = camPos.x - u.p[0], dz = camPos.z - u.p[2], dy = camPos.y - u.p[1];
      const ang = Math.atan2(dy, Math.hypot(dx, dz)) / D2R;
      // visible only from approach side
      const { u: lu } = toLocal(p.a, camPos.x, camPos.z);
      const fromApproach = p.e === 0 ? lu < -p.a.len / 2 + 300 : lu > p.a.len / 2 - 300;
      const vis = fromApproach ? 1 : 0;
      const white = ang > u.ang;
      col.setXYZ(idx++, (white ? 1 : 1) * vis, (white ? 1 : 0.08) * vis, (white ? 0.95 : 0.05) * vis);
    }
    col.needsUpdate = true;
    // rotating beacon: alternating green / white flashes
    const bc = beaconPts.geometry.attributes.color;
    for (let i = 0; i < bc.count; i++) {
      const ph = (t * 0.5 + i * 0.37) % 1; const on = night > 0.2 ? Math.max(0, 1 - Math.abs(((ph * 2) % 1) - 0.5) * 12) : 0;
      if (ph < 0.5) bc.setXYZ(i, 0.2 * on, 1 * on, 0.4 * on); else bc.setXYZ(i, on, on, on);
    }
    bc.needsUpdate = true;
  };
  return { group, updateLights, parked };
}

// ---------------- Rocks (photoscanned, instanced) ----------------
function b64(s, T) { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new T(u8.buffer); }

export class RockField {
  constructor(scene) { this.scene = scene; this.types = []; this.chunks = new Map(); this.lastCell = null; this.ready = false; }
  async init() {
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
      const max = n === 'namaqualand_boulder_04' ? 1200 : 5000;
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
      // sparse trees along field edges / hedgerows & isolated trees
      const fa = farmAt(wx, wz, h, slope);
      if (fa > 0.3) { const hx = Math.abs(((wx / 260) % 1 + 1) % 1 - 0.5), hz = Math.abs(((wz / 190) % 1 + 1) % 1 - 0.5); if (Math.min(hx, hz) < 0.03) f = Math.max(f, 0.55); }
      if (rnd() > f * 0.95 + 0.004) continue;
      if (surfaceAt(wx, wz, h) !== 'grass') continue;
      // avoid town
      if (townAt(wx, wz) > 0.5 && rnd() < 0.8) continue;
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
  async init() {
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
    this.im = new THREE.InstancedMesh(g, m, 42000);
    this.im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(42000 * 3), 3); this.im.count = 0; this.im.frustumCulled = false; this.im.receiveShadow = true;
    this.scene.add(this.im); this.ready = true;
  }
  // per-cell tuft lists are generated once (max density) and cached; rebuilds just copy
  cell(ix, iz) {
    const key = ix + ',' + iz; let c = this.cells.get(key); if (c) return c;
    const S = 16, rnd = mulberry((ix * 7919) ^ (iz * 104729));
    const x0 = ix * S, z0 = iz * S; c = { m: [], c: [] };
    const hc = heightAt(x0 + 8, z0 + 8);
    let downtown = false, tw = townAt(x0 + 8, z0 + 8);
    if (tw > 0) for (const T of TOWNS) if (Math.hypot(x0 + 8 - T.x, z0 + 8 - T.z) < T.core + T.grid * 0.6 + 20) downtown = true;
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
    const R = 6, MAX = 42000; let n = 0;
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

// All towns: houses, downtown blocks, churches, water towers, streets, streetlights + the highway network
export async function buildTown(scene) {
  const [wall1, wall2, roof1, roof2, brick, asphalt] = await Promise.all([
    pbr('painted_plaster_wall', 1), pbr('plastered_wall_02', 1), pbr('roof_tiles', 1), pbr('grey_roof_tiles', 1), pbr('brick_wall_02', 1), pbr('asphalt_02', 1),
  ]);
  const group = new THREE.Group(); scene.add(group);
  const houses = [], blocks = [], churches = [], towers = [], sl = [];
  const P = [], U = [], I = [];
  const addRoad = (W, u0, v0, u1, v1, w) => {
    const len = Math.hypot(u1 - u0, v1 - v0); const n = Math.ceil(len / 6);
    const du = (u1 - u0) / len, dv = (v1 - v0) / len; const pu = -dv * w / 2, pv = du * w / 2;
    const base = P.length / 3;
    for (let i = 0; i <= n; i++) {
      const t = i / n; const u = u0 + (u1 - u0) * t, v = v0 + (v1 - v0) * t;
      for (const s of [-1, 1]) { const p = W(u + pu * s, v + pv * s); const h = heightAt(p.x, p.z); P.push(p.x, Math.max(h, WATER_LEVEL + 0.5) + 0.22, p.z); U.push(s * 0.5 + 0.5, t * len / 8); }
    }
    for (let i = 0; i < n; i++) { const a = base + i * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  };
  for (const T of TOWNS) {
    const rnd = mulberry(T.seed);
    const grid = T.grid, rot = T.rot * D2R;
    const W = (u, v) => townWorld(T, u, v);
    for (let gu = -T.r; gu <= T.r; gu += grid) for (let gv = -T.r; gv <= T.r; gv += grid) {
      const dist = Math.hypot(gu + grid / 2, gv + grid / 2); if (dist > T.r * (0.82 + 0.15 * rnd())) continue;
      const downtown = dist < T.core;
      const lots = downtown ? 2 : 4;
      for (let i = 0; i < lots; i++) for (let j = 0; j < 2; j++) {
        if (!downtown && rnd() < 0.08 + 0.25 * (dist / T.r) ** 3) continue; // empty lots towards the edge
        const lu = gu + 12 + (i + 0.5) * ((grid - 24) / lots), lv = gv + 12 + (j + 0.5) * ((grid - 24) / 2);
        const p = W(lu, lv);
        const h = heightAt(p.x, p.z); if (h < WATER_LEVEL + 1) continue;
        if (surfaceAt(p.x, p.z, h) !== 'grass') continue;
        const slope = 1 - normalAt(p.x, p.z, 6)[1]; if (slope > 0.12) continue;
        if (downtown) blocks.push({ x: p.x, z: p.z, h, w: 16 + rnd() * 8, d: 14 + rnd() * 8, ht: 7 + rnd() * (T.core > 200 ? 26 : 10), rot });
        else houses.push({ x: p.x, z: p.z, h, w: 9 + rnd() * 4, d: 7 + rnd() * 3, ht: 3 + (rnd() < 0.35 ? 2.8 : 0), rot: rot + (rnd() < 0.5 ? 0 : Math.PI / 2) });
      }
    }
    // landmark: church + water tower
    { const p = W(T.core + grid * 0.5, -grid * 0.5 + 6); const h = heightAt(p.x, p.z); churches.push({ x: p.x, z: p.z, h, rot }); }
    { const p = W(-T.core - grid * 0.5, grid * 1.5); const h = heightAt(p.x, p.z); towers.push({ x: p.x, z: p.z, h, name: T.name }); }
    for (let g = -T.r; g <= T.r; g += grid) {
      const half = Math.sqrt(Math.max(0, T.r * T.r * 0.86 - g * g));
      if (half > 50) { addRoad(W, g, -half, g, half, 8); addRoad(W, -half, g, half, g, 8); }
      for (let k = -T.r; k <= T.r; k += 35) {
        if (g * g + k * k > T.r * T.r * 0.8) continue;
        const p = W(g + 5, k); const h = heightAt(p.x, p.z); sl.push({ p: [p.x, h + 7, p.z], c: [1, 0.72, 0.38], s: 1.3 });
      }
    }
  }
  // instanced house bodies + gable roofs
  const body = boxUV(1, 1, 1, 0.25); body.translate(0, 0.5, 0);
  const roofG = gableGeometry();
  const hm1 = windowShader(new THREE.MeshStandardMaterial({ map: wall1.diff, normalMap: wall1.nor, roughness: 0.95 }), 3.2);
  const hm2 = windowShader(new THREE.MeshStandardMaterial({ map: wall2.diff, normalMap: wall2.nor, roughness: 0.95, color: 0xe8dcc8 }), 3.2);
  const bm = windowShader(new THREE.MeshStandardMaterial({ map: brick.diff, normalMap: brick.nor, roughness: 0.9 }), 2.6);
  const rm1 = new THREE.MeshStandardMaterial({ map: roof1.diff, normalMap: roof1.nor, roughness: 0.85, side: THREE.DoubleSide });
  const rm2 = new THREE.MeshStandardMaterial({ map: roof2.diff, normalMap: roof2.nor, roughness: 0.85, side: THREE.DoubleSide });
  const mk = (geo, mat, list, f, colorF) => {
    const im = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length)); const tmp = new THREE.Object3D();
    list.forEach((o, i) => { f(o, tmp); tmp.updateMatrix(); im.setMatrixAt(i, tmp.matrix); if (colorF) im.setColorAt(i, colorF(o, i)); });
    im.count = list.length; im.castShadow = true; im.receiveShadow = true; group.add(im); return im;
  };
  const tint = (o, i) => new THREE.Color().setHSL((i * 0.137) % 1, 0.18, 0.78 + ((i * 0.31) % 1) * 0.18);
  const hA = houses.filter((_, i) => i % 2), hB = houses.filter((_, i) => !(i % 2));
  for (const [list, wm, rmm] of [[hA, hm1, rm1], [hB, hm2, rm2]]) {
    mk(body, wm, list, (o, t) => { t.position.set(o.x, o.h - 0.3, o.z); t.rotation.set(0, o.rot, 0); t.scale.set(o.w, o.ht + 0.3, o.d); }, tint);
    mk(roofG, rmm, list, (o, t) => { t.position.set(o.x, o.h + o.ht, o.z); t.rotation.set(0, o.rot + Math.PI / 2, 0); t.scale.set(o.d, 2.6, o.w); });
  }
  // chimneys on ~half the houses
  const chim = houses.filter((_, i) => i % 3 === 0);
  mk(boxUV(1, 1, 1, 0.5), new THREE.MeshStandardMaterial({ map: brick.diff, normalMap: brick.nor, roughness: 0.9 }), chim, (o, t) => { const c = Math.cos(o.rot), s2 = Math.sin(o.rot); t.position.set(o.x + c * o.w * 0.3, o.h + o.ht + 0.4, o.z - s2 * o.w * 0.3); t.rotation.set(0, o.rot, 0); t.scale.set(0.7, 3.2, 0.9); });
  mk(body, bm, blocks, (o, t) => { t.position.set(o.x, o.h - 0.3, o.z); t.rotation.set(0, o.rot, 0); t.scale.set(o.w, o.ht, o.d); });
  // rooftop HVAC units on blocks
  const hvacMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a4, roughness: 0.5, metalness: 0.6 });
  mk(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), hvacMat, blocks, (o, t) => { t.position.set(o.x + 2, o.h + o.ht - 0.3, o.z - 1); t.rotation.set(0, o.rot, 0); t.scale.set(3, 1.6, 2.2); });
  // churches: nave + steeple + spire
  const white = new THREE.MeshStandardMaterial({ color: 0xf1efe8, roughness: 0.8 });
  const darkRoof = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.7, side: THREE.DoubleSide });
  mk(body, white, churches, (o, t) => { t.position.set(o.x, o.h - 0.3, o.z); t.rotation.set(0, o.rot, 0); t.scale.set(24, 9, 12); });
  mk(roofG, darkRoof, churches, (o, t) => { t.position.set(o.x, o.h + 8.7, o.z); t.rotation.set(0, o.rot + Math.PI / 2, 0); t.scale.set(12, 6, 24); });
  mk(body, white, churches, (o, t) => { const c = Math.cos(o.rot), s2 = Math.sin(o.rot); t.position.set(o.x + c * 13, o.h - 0.3, o.z - s2 * 13); t.rotation.set(0, o.rot, 0); t.scale.set(5, 20, 5); });
  mk(new THREE.ConeGeometry(0.72, 1, 4).translate(0, 0.5, 0).rotateY(Math.PI / 4), darkRoof, churches, (o, t) => { const c = Math.cos(o.rot), s2 = Math.sin(o.rot); t.position.set(o.x + c * 13, o.h + 19.7, o.z - s2 * 13); t.rotation.set(0, o.rot, 0); t.scale.set(5, 13, 5); });
  // water towers: legs + tank (with town name painted on canvas)
  const steel = new THREE.MeshStandardMaterial({ color: 0xb9c2c8, roughness: 0.45, metalness: 0.7 });
  for (const o of towers) {
    const tw = new THREE.Group(); tw.position.set(o.x, o.h, o.z);
    for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 30, 6), steel); leg.position.set(Math.cos(a) * 5, 15, Math.sin(a) * 5); leg.rotation.set(Math.sin(a) * 0.08, 0, -Math.cos(a) * 0.08); tw.add(leg); }
    const riser = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 31, 10), steel); riser.position.y = 15.5; tw.add(riser);
    const c = document.createElement('canvas'); c.width = 1024; c.height = 256; const g = c.getContext('2d');
    g.fillStyle = '#c9d2d8'; g.fillRect(0, 0, 1024, 256); g.fillStyle = '#1f3d6b'; g.font = 'bold 120px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(o.name, 256, 128); g.fillText(o.name, 768, 128);
    const tt = new THREE.CanvasTexture(c); tt.colorSpace = THREE.SRGBColorSpace; tt.anisotropy = 8;
    const tank = new THREE.Mesh(new THREE.SphereGeometry(7.5, 32, 16), new THREE.MeshStandardMaterial({ map: tt, roughness: 0.4, metalness: 0.5 })); tank.scale.y = 0.7; tank.position.y = 34; tw.add(tank);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(2, 2.5, 12), steel); cap.position.y = 39.6; tw.add(cap);
    tw.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    group.add(flattenStatic(tw));
  }
  // town streets
  const roadMat = new THREE.MeshStandardMaterial({ map: asphalt.diff, normalMap: asphalt.nor, roughness: 0.95, color: 0x9a9a9a, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); rg.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); rg.setIndex(I); rg.computeVertexNormals();
  const roadsMesh = new THREE.Mesh(rg, roadMat); roadsMesh.receiveShadow = true; group.add(roadsMesh);
  // highways & county roads with painted markings
  const hw = buildHighways(asphalt); group.add(hw);
  const lm = lightMaterial(); const pts = makePoints(sl, lm); group.add(pts);
  const mats = [hm1, hm2, bm];
  return { group, houses, blocks, setNight: (n) => { lm.uniforms.uNight.value = n * 1.0; for (const m of mats) if (m.userData.uNight) m.userData.uNight.value = n; pts.visible = n > 0.15; } };
}

function buildHighways(asphalt) {
  const P = [], U = [], L = [], I = [];
  for (const r of ROADS) {
    const N = r.line.length; const base = P.length / 3; const kind = r.kind === 'hwy' ? 2 : r.kind === 'road' ? 1 : 0;
    for (let i = 0; i < N; i++) {
      const a = r.line[Math.max(0, i - 1)], b = r.line[Math.min(N - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const rx = -dz, rz = dx; // right of travel direction
      const y = r.prof[i] + 0.16;
      for (const s of [-1, 1]) { P.push(r.line[i][0] + rx * s * r.w / 2, y, r.line[i][1] + rz * s * r.w / 2); U.push(s * 0.5 + 0.5, i * 10 / 8); L.push(kind, r.w); }
    }
    for (let i = 0; i < N - 1; i++) { const a = base + i * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); g.setAttribute('aRoad', new THREE.Float32BufferAttribute(L, 2));
  g.setIndex(I); g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ map: asphalt.diff, normalMap: asphalt.nor, roughness: 0.92, color: 0x8c8c8c, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aRoad; varying vec2 vRoad; varying vec2 vRUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoad = aRoad; vRUv = uv;\n{ float dc = distance((modelMatrix*vec4(transformed,1.0)).xyz, cameraPosition); transformed.y += clamp((dc-300.0)*0.0016, 0.0, 9.0); }');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vRoad; varying vec2 vRUv;')
      .replace('#include <map_fragment>', `#include <map_fragment>
      {
        float w = vRoad.y; float x = (vRUv.x - 0.5) * w; float along = vRUv.y * 8.0;
        float aa = fwidth(x) * 0.8 + 0.01;
        float edge = smoothstep(0.08 + aa, 0.08 - aa, abs(abs(x) - (w * 0.5 - 0.45)));
        float dash = step(0.5, fract(along / 12.0));
        float yel = 0.0; float wht = edge;
        if (vRoad.x > 1.5) { // divided-style highway: double yellow centre, dashed white lane lines
          yel = smoothstep(0.07 + aa, 0.07 - aa, abs(abs(x) - 0.18));
          wht = max(wht, dash * smoothstep(0.07 + aa, 0.07 - aa, abs(abs(x) - w * 0.25)));
        } else if (vRoad.x > 0.5) {
          yel = dash * smoothstep(0.07 + aa, 0.07 - aa, abs(x));
        } else { wht = 0.0; diffuseColor.rgb *= 0.92; }
        float fade = 1.0 - smoothstep(600.0, 2500.0, length(vViewPosition));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.66, 0.12), yel * fade * 0.9);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88), wht * fade * 0.85);
      }`);
  };
  const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; mesh.frustumCulled = false;
  return mesh;
}

// Merge a static hierarchy into one mesh per material (in the root's local frame)
function flattenStatic(root) {
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
