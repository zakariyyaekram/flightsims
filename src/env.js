// Sky (Preetham), sun/moon light, haze, cloud layers, water.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { WATER_LEVEL } from './geo.js';

const LAT = 41.8 * Math.PI / 180; // northern Illinois-like latitude
const DECL = 14 * Math.PI / 180; // late spring

export function sunDirection(hour) {
  const H = (hour - 12) * 15 * Math.PI / 180;
  const sinEl = Math.sin(LAT) * Math.sin(DECL) + Math.cos(LAT) * Math.cos(DECL) * Math.cos(H);
  const el = Math.asin(sinEl);
  const cosAz = (Math.sin(DECL) - Math.sin(el) * Math.sin(LAT)) / (Math.cos(el) * Math.cos(LAT));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
  if (H > 0) az = 2 * Math.PI - az; // azimuth from north, clockwise
  // world: +X east, -Z north
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

const CLOUD_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vW;
void main(){
  vec4 w = modelMatrix * vec4(position,1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;
const CLOUD_FS = `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uCover; uniform float uTime; uniform vec2 uWind; uniform vec3 uSun; uniform vec3 uCam;
uniform vec3 uFog; uniform float uFogD; uniform float uLayer; uniform float uDay; uniform vec3 uSunCol;
varying vec3 vW;
float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=0.5, s=0.0; mat2 m=mat2(1.6,1.2,-1.2,1.6); for(int i=0;i<6;i++){ s+=a*vn(p); p=m*p; a*=0.5;} return s; }
void main(){
  #include <logdepthbuf_fragment>
  vec2 p = (vW.xz + uWind*uTime) / 2600.0;
  float base = fbm(p + uLayer*0.13);
  float detail = fbm(p*4.3 - uLayer*0.31);
  float n = base*0.75 + detail*0.25;
  float thr = 1.0 - uCover*0.62 - 0.22 + uLayer*0.035;
  float d = smoothstep(thr, thr + 0.12, n);
  if (d < 0.01) discard;
  float dist = length(vW - uCam);
  // lighting: sunlit edges, darker cores/bases
  float thick = smoothstep(thr, thr + 0.35, n);
  bool below = uCam.y < vW.y;
  float lit = below ? mix(0.95, 0.42, thick) : mix(0.85, 1.12, 1.0 - thick*0.5);
  lit *= mix(0.55, 1.0, uLayer/2.0);
  vec3 col = uSunCol * lit * (0.25 + 0.75*clamp(uSun.y*3.0, 0.0, 1.0)) + vec3(0.12,0.14,0.18)*uDay*0.6;
  float fog = 1.0 - exp(-pow(dist*uFogD*0.6, 1.4));
  col = mix(col, uFog, clamp(fog,0.0,1.0));
  float a = d * (1.0 - smoothstep(30000.0, 42000.0, dist)) * 0.92;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Environment {
  constructor(renderer, scene) {
    this.renderer = renderer; this.scene = scene;
    this.sky = new Sky();
    this.sky.scale.setScalar(10000);
    this.sky.frustumCulled = false;
    this.sky.material.depthWrite = false;
    this.sky.renderOrder = -10;
    scene.add(this.sky);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 5.5; u.rayleigh.value = 1.6; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.82;

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera; sc.left = -36; sc.right = 36; sc.top = 36; sc.bottom = -36; sc.near = 1; sc.far = 600;
    this.sun.shadow.bias = -0.00025; this.sun.shadow.normalBias = 0.03;
    scene.add(this.sun); scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbcd3ee, 0x5b5040, 0.4);
    scene.add(this.hemi);
    scene.fog = new THREE.FogExp2(0xb8c6d4, 0.00008);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new Sky(); this.envSky.scale.setScalar(1000); this.envScene.add(this.envSky);
    const groundEnv = new THREE.Mesh(new THREE.CircleGeometry(900, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4a4a3a }));
    groundEnv.position.y = -2; this.envScene.add(groundEnv); this.envGround = groundEnv;
    this.envRT = null;

    // clouds: three stacked layers -> pseudo-volumetric
    this.cloudLayers = [];
    for (let i = 0; i < 3; i++) {
      const m = new THREE.ShaderMaterial({
        vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { uCover: { value: 0.4 }, uTime: { value: 0 }, uWind: { value: new THREE.Vector2(6, 2) }, uSun: { value: new THREE.Vector3() }, uCam: { value: new THREE.Vector3() }, uFog: { value: new THREE.Color() }, uFogD: { value: 0.0001 }, uLayer: { value: i }, uDay: { value: 1 }, uSunCol: { value: new THREE.Color(1, 1, 1) } },
      });
      const c = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000).rotateX(-Math.PI / 2), m);
      c.frustumCulled = false; c.renderOrder = 5 + i;
      scene.add(c); this.cloudLayers.push(c);
    }
    this.cloudBase = 1400; this.cover = 0.35;
    // water
    this.water = null;
    this.hour = 10;
  }

  async buildWater() {
    const loader = new THREE.TextureLoader(); loader.setCrossOrigin('anonymous');
    const nrm = await new Promise((res) => loader.load('https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/waternormals.jpg', res, undefined, () => res(null)));
    if (nrm) { nrm.wrapS = nrm.wrapT = THREE.RepeatWrapping; nrm.repeat.set(1400, 1400); }
    const m = new THREE.MeshStandardMaterial({ color: 0x0d2a33, roughness: 0.06, metalness: 0.0, normalMap: nrm, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 1.2 });
    this.waterT = { value: 0 };
    if (nrm) m.onBeforeCompile = (sh) => {
      sh.uniforms.uT = this.waterT = { value: 0 };
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uT;')
        .replace('#include <normal_fragment_maps>', `
          vec3 n1 = texture2D(normalMap, vNormalMapUv + vec2(uT*0.004, uT*0.003)).xyz*2.0-1.0;
          vec3 n2 = texture2D(normalMap, vNormalMapUv*0.37 - vec2(uT*0.002, -uT*0.0027)).xyz*2.0-1.0;
          vec3 mapN = normalize(vec3((n1.xy+n2.xy)*normalScale, n1.z*n2.z));
          normal = normalize( tbn * mapN );`);
    };
    const w = new THREE.Mesh(new THREE.PlaneGeometry(65536, 65536, 1, 1).rotateX(-Math.PI / 2), m);
    w.position.y = WATER_LEVEL; w.receiveShadow = true;
    this.scene.add(w); this.water = w;
  }

  setWeather({ cover, base, visKm, windDir, windKt }) {
    this.cover = cover; this.cloudBase = base; this.visKm = visKm;
    const wr = windDir * Math.PI / 180, ws = windKt * 0.5144;
    // wind FROM windDir -> moves toward windDir+180
    for (const c of this.cloudLayers) c.material.uniforms.uWind.value.set(-Math.sin(wr) * ws * 1.4, Math.cos(wr) * ws * 1.4);
    for (const c of this.cloudLayers) { c.material.uniforms.uCover.value = cover; c.visible = cover > 0.02; }
  }

  setTime(hour) {
    this.hour = hour;
    const d = sunDirection(hour);
    this.sunDir = d;
    const el = Math.asin(d.y);
    this.day = THREE.MathUtils.smoothstep(d.y, -0.12, 0.12);
    this.night = 1 - THREE.MathUtils.smoothstep(d.y, -0.18, 0.02);
    for (const s of [this.sky, this.envSky]) s.material.uniforms.sunPosition.value.copy(d);
    // sun color: warmer near horizon
    const warm = 1 - THREE.MathUtils.smoothstep(el, 0.02, 0.45);
    this.sunColor = new THREE.Color(1, 0.96 - warm * 0.32, 0.9 - warm * 0.55);
    this.sun.color.copy(this.sunColor);
    this.sun.intensity = 3.2 * THREE.MathUtils.smoothstep(d.y, -0.02, 0.15);
    this.hemi.intensity = 0.15 + 0.5 * this.day;
    this.hemi.color.setRGB(0.62 + warm * 0.2, 0.72, 0.85).multiplyScalar(0.25 + 0.75 * this.day);
    this.hemi.groundColor.setRGB(0.36, 0.32, 0.25).multiplyScalar(0.2 + 0.8 * this.day);
    // haze colour approximating Preetham horizon
    const dayFog = new THREE.Color(0.70, 0.78, 0.87), duskFog = new THREE.Color(0.86, 0.62, 0.44), nightFog = new THREE.Color(0.018, 0.024, 0.04);
    const fog = dayFog.clone().lerp(duskFog, warm * 0.75 * this.day);
    fog.lerp(nightFog, this.night);
    this.scene.fog.color.copy(fog);
    this.fogColor = fog;
    this.renderer.toneMappingExposure = 0.42 + 0.25 * (1 - this.day) * (1 - this.night) + this.night * 0.3;
    this.envGround.material.color.setRGB(0.25, 0.24, 0.18).multiplyScalar(0.1 + this.day * 0.9);
    // env map
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene, 0.02);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.3 + 0.7 * this.day + 0.0;
    for (const c of this.cloudLayers) {
      const u = c.material.uniforms; u.uSun.value.copy(d); u.uDay.value = this.day; u.uSunCol.value.copy(this.sunColor).multiplyScalar(0.15 + 0.85 * this.day);
    }
    return { day: this.day, night: this.night };
  }

  update(cam, focus, t, dt) {
    // shadow camera follows the focus (aircraft)
    const d = this.sunDir || new THREE.Vector3(0, 1, 0);
    this.sun.position.copy(focus).addScaledVector(d, 300);
    this.sun.target.position.copy(focus);
    // snap to texel grid to stop shimmering
    this.sky.position.copy(cam.position);
    const visM = (this.visKm || 40) * 1000;
    let dens = 3.0 / visM;
    // local-area (Light Edition) scenery: thicken haze so the edge of the loaded area is never visible
    if (this.minFogDensity) dens = Math.max(dens, this.minFogDensity);
    // inside cloud layer => IMC
    const inCloud = this.cover > 0.55 && cam.position.y > this.cloudBase - 20 && cam.position.y < this.cloudBase + 380;
    this.inCloud = inCloud;
    if (inCloud) dens = Math.max(dens, 0.012 * (this.cover - 0.45));
    this.scene.fog.density += (dens - this.scene.fog.density) * Math.min(1, dt * 2);
    this.cloudLayers.forEach((c, i) => {
      c.position.set(cam.position.x, this.cloudBase + i * 160, cam.position.z);
      const u = c.material.uniforms; u.uTime.value = t; u.uCam.value.copy(cam.position);
      u.uFog.value.copy(this.scene.fog.color); u.uFogD.value = this.scene.fog.density;
    });
    if (this.waterT) this.waterT.value = t;
  }
}
