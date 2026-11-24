// A350-1000 — main loop, cameras, input, flight deck interaction, ground services and UI.
import * as THREE from 'three';
import { qrot } from '../math.js';
import { groundQuery, heightAt, AIRPORTS, NAVAIDS, toLocal, WATER_LEVEL, findRunway, runwayEnd, inWorld, waterFrac, ll2w, gateSpots, pointInPoly } from '../geo.js';
import { createTerrainMaterial, Terrain } from '../terrain.js?v=20261123g';
import { OrthoManager } from '../ortho.js?v=20261123g';
import { GroundOverlay } from '../ground.js?v=20261123g';
import { GrassBlades, CropField } from '../blades.js?v=20261123g';
import { buildAircraft } from '../aircraft.js?v=20261123g';
import { Environment } from '../env.js';
import { buildAirports, RockField, Forest, GrassField } from '../world.js';
import { Scenery } from '../scenery.js?v=20261123g';
import { Traffic } from '../traffic.js?v=20261124e';
import { Tower } from '../tower.js?v=20261124e';
import { buildLife } from '../life.js?v=20261123g';
import { MovingMap } from '../map.js?v=20261123g';
import { departureRoute, routeProgress } from '../taxi.js?v=20261124e';
import { toggleTaxiMap, updateTaxiMap, taxiMapOpen, taxiChart } from '../taximap.js?v=20261124e';
import { setAniso } from '../textures.js';
import { ATC } from '../atc.js?v=20261124e';
import { resolveFlight, enRoutePoint } from '../flightplan.js?v=20261124e';
import { tickGSE, GSE } from '../gse.js';
import { remap, buildControlsUI, changedCount, mouseSettings, mouseAxis } from '../controls.js?v=20261123g';
import { PerfMonitor } from '../perf.js?v=20261123g';
import { initCesium, syncCesiumCamera, getCesiumElevationWorld, warmCesiumTerrain, setCesiumQuality } from '../cesium.js?v=20261123g';
import { KT, FT, NM, A350, CONFS, DETENT } from './data.js';
import { JetFDM } from './fdm.js';
import { Systems } from './systems.js';
import { FMS } from './fms.js';
import { AFS } from './afs.js';
import { Displays } from './displays.js';
import { buildOverhead, buildGlareshield, buildPedestal, buildGearPanel } from './panels.js';
import { buildCockpit } from './cockpit.js';
import { buildA350, animateA350 } from './model.js';
import { JetSound } from './audio.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const D2R = Math.PI / 180;
const HPA = 100;

// ---------------- renderer / scene ----------------
const canvas = $('gl');
let renderer = null;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' }); } catch (error) { console.error('Could not initialize WebGL.', error); }
if (renderer) {
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.5;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  setAniso(Math.min(16, renderer.capabilities.getMaxAnisotropy()));
}
const perf = renderer ? new PerfMonitor({ renderer, chip: $('perfChip'), detail: $('fps') }) : null;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.02, 90000);
scene.add(camera);

// ---------------- simulation state ----------------
const fdm = new JetFDM(); const S = new Systems(fdm); const fms = new FMS(); const afs = new AFS(fdm, S, fms);
S.fms = fms;
const sim = {
  fdm, S, fms, afs, keys: {}, view: 'cockpit', seat: 0, timeOfDay: 10, simRate: 1, paused: true, started: false,
  weather: { windDir: 280, windKt: 10, turb: 0.2, cover: 0.45, baseFt: 4500, visKm: 40, qnhHpa: 1016, isa: 5 }, sound: new JetSound(),
  efis: [0, 1].map(() => ({ fd: true, ls: false, vv: false, mode: 'ARC', range: 20, opt: 'CSTR', cstr: true, terr: false, wxr: false, std: false, baro: 1013, inHg: false, preStd: 1013, nav: ['VOR', 'VOR'] })),
  duBright: { CO: 1, CI: 1, CU: 1, CL: 1, FI: 1, FO: 1, ISIS: 1 },
  kccu: { buf: '', focus: null }, kccuDu: 0,
  mfd: [0, 1].map(() => ({ tab: 'FMS', page: 'F-PLN', perf: 'T.O', scroll: 0, sel: null })),
  ois: [0, 1].map(() => ({ app: 'T.O PERF' })),
  rmp: [0, 1, 2].map((i) => ({ sel: 'VHF1', active: { VHF1: 118.85, VHF2: 121.5, VHF3: 131.55, HF1: 8.891, HF2: 11.282 }, stby: { VHF1: 120.5, VHF2: 135.65, VHF3: 129.9, HF1: 5.598, HF2: 13.306 }, vol: [0.8, 0.8, 0.5] })),
  chrono: [{}, {}], stickPriority: null, atcMsg: false, atcLog: [], flapLever: 0, flapConf: 0, gpws: null, tcasRA: null, fcuMetric: false,
  groundSvc: { gpu: false, fuel: false, tug: false, stairs: false },
};
window.sim = sim; sim.scene = scene; sim.renderer = renderer; sim.perf = perf; sim.camera = camera;
sim.atc = new ATC();
// avionics shim so the shared ATC module can tune / read the A350 radios
sim.av = {
  com1: { get active() { return sim.rmp[0].active.VHF1; }, set active(v) { sim.rmp[0].active.VHF1 = v; } },
  micRadio() { return this.com1; },
  xpdr: { get code() { return S.ped.squawk; }, set code(v) { S.ped.squawk = String(v); } },
};
fdm.env.ground = groundQuery;
sim.utc = () => ((sim.timeOfDay + 8) % 24); // Pacific standard time -> UTC
sim.emit = (n, a) => S.emit(n, a);
sim.toast = toast;
sim.openAtc = () => toggleATC(true);
sim.kccuKey = (ch) => {
  const k = sim.kccu;
  if (!k.focus) { if (ch !== 'Escape') toast('Click an MFD field first, then type on the KCCU', 1600); return; }
  if (ch === 'Backspace') k.buf = k.buf.slice(0, -1);
  else if (ch === 'Escape') { k.focus = null; k.buf = ''; }
  else if (ch === 'Enter') { const f = k.focus; k.focus = null; try { f.commit?.(k.buf.trim()); } catch (e) { console.warn(e); } k.buf = ''; }
  else if (k.buf.length < 24) k.buf += ch === ' ' ? ' ' : String(ch).toUpperCase();
  sim.sound.click();
};
sim.onFplnBuilt = () => { rebuildTaxi(); toast('Flight plan built ' + fms.origin?.icao + ' → ' + fms.dest?.icao, 2200); };

function cesiumGroundQuery(x, z, y) {
  const local = groundQuery(x, z, y); const ch = getCesiumElevationWorld(x, z);
  if (!Number.isFinite(ch)) return local; if (local.road?.ys) return local;
  const surface = waterFrac(x, z) > 0.6 && ch < 3 ? 'water' : local.surface === 'runway' || local.surface === 'road' ? 'runway' : 'grass';
  return { h: surface === 'water' ? WATER_LEVEL : ch, n: local.n, surface };
}

// ---- world streaming (same scheme as the Skyhawk) ----
const LIGHT_RADIUS = 9000, LIGHT_AIRPORT_LOAD = LIGHT_RADIUS + 2500, LIGHT_AIRPORT_UNLOAD = LIGHT_AIRPORT_LOAD + 4000;
const HEAVY_RADIUS = 30000, HEAVY_AIRPORT_LOAD = 16000, HEAVY_AIRPORT_UNLOAD = 22000, PREFETCH_S = 45;
class LocalAirports {
  constructor(scene, buildAircraftFn, opts = {}) {
    this.scene = scene; this.buildAircraftFn = buildAircraftFn;
    this.loadR = opts.load ?? LIGHT_AIRPORT_LOAD; this.unloadR = opts.unload ?? LIGHT_AIRPORT_UNLOAD;
    this.elevFn = opts.elevFn || null; this.warm = opts.warm || null;
    this.loaded = new Map(); this.loading = new Map(); this.busy = null;
  }
  update(pos, ahead = null) {
    const want = [];
    for (const a of AIRPORTS) {
      const d = Math.hypot(a.arp[0] - pos.x, a.arp[1] - pos.z);
      const da = ahead ? Math.hypot(a.arp[0] - ahead.x, a.arp[1] - ahead.z) : d;
      const dm = Math.min(d, da);
      if (dm < this.loadR && !this.loaded.has(a.icao)) want.push([dm, a]);
      else if (d > this.unloadR && (!ahead || da > this.unloadR) && this.loaded.has(a.icao)) { this.loaded.get(a.icao).dispose(); this.loaded.delete(a.icao); }
    }
    want.sort((x, y) => x[0] - y[0]);
    if (!this.busy && want.length) {
      const a = want[0][1];
      this.busy = (async () => {
        try { if (this.warm) await this.warm(a); const r = await buildAirports(this.scene, null, this.buildAircraftFn, this.elevFn, [a]); this.loaded.set(a.icao, r); } catch (e) { console.warn('Airport load failed', a.icao, e); }
        this.busy = null;
      })();
    }
    this.pendingCount = want.length;
    return this.busy || Promise.resolve();
  }
  async fill(pos, max = 99) { for (let i = 0; i < max; i++) { await this.update(pos); if (!this.pendingCount && !this.busy) break; } }
  updateLights(camPos, night, t) { for (const r of this.loaded.values()) r.updateLights(camPos, night, t); }
  updateServices(dt, camPos, t) { for (const r of this.loaded.values()) r.updateServices?.(dt, camPos, t); }
  rebuild(icao) { const r = this.loaded.get(icao); if (r) { r.dispose(); this.loaded.delete(icao); } }
}

let airportStreamTick = 0;
let ground = null, blades = null, crops = null;
let env, terrain, terrainMat, aircraft, cockpit, airports, rocks, forest, grass, life, mmap, scenery, traffic;
const loadBar = $('loadBar'), loadText = $('loadText');
let loadMode = null;
const progress = (p, t) => { loadBar.style.width = Math.round(p * 100) + '%'; loadText.textContent = t; };

async function init() {
  if (!renderer) throw new Error('WebGL is unavailable in this browser or device.');
  progress(0.03, 'Sky, sun and atmosphere…');
  env = new Environment(renderer, scene); env.setTime(sim.timeOfDay); env.sky.visible = true;
  let cesiumViewer = null;
  if (loadMode === 'heavy') {
    progress(0.08, 'Connecting to Cesium ion…');
    cesiumViewer = await initCesium(); env.sky.visible = !cesiumViewer;
    if (cesiumViewer) fdm.env.ground = cesiumGroundQuery;
    progress(0.36, 'Loading World Terrain, aerial imagery and 3D buildings…');
  } else progress(0.36, 'Loading local terrain and flight systems…');
  const useLocalScenery = loadMode !== 'heavy' || !cesiumViewer;
  if (useLocalScenery) {
    if (loadMode === 'light') { ground = new GroundOverlay(); if (!(await ground.init('../data/'.replace('../', './')))) ground = null; sim.ground = ground; }
    terrainMat = await createTerrainMaterial((p) => progress(0.38 + p * 0.12, 'Loading terrain textures…'), loadMode === 'light' ? 512 : 1024, ground ? ground.uniforms : null);
    terrain = loadMode === 'light' ? new Terrain(scene, terrainMat, { radius: LIGHT_RADIUS, maxTileSize: 4096, minTileSize: 256, lodScale: 1.0 }) : new Terrain(scene, terrainMat, { radius: HEAVY_RADIUS, maxTileSize: 16384 });
    env.minFogDensity = loadMode === 'light' ? 2.0 / LIGHT_RADIUS : 1.6 / HEAVY_RADIUS;
  }
  progress(0.52, 'Building the A350-1000 — fuselage, wing, Trent XWB engines and the flight deck…');
  sim.displays = new Displays(sim);
  sim.panels = { ovhd: buildOverhead(sim), glare: buildGlareshield(sim), ped: buildPedestal(sim), gear: buildGearPanel(sim) };
  aircraft = buildA350({ reg: A350.reg });
  cockpit = buildCockpit(sim, sim.panels); aircraft.add(cockpit.group);
  aircraft.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  scene.add(aircraft);
  sim.aircraft = aircraft; sim.cockpit = cockpit;
  const s0 = readSetup();
  reserveGate(s0);
  if (loadMode === 'light') {
    airports = new LocalAirports(scene, buildAircraft);
    applySetup(s0, true);
    progress(0.58, 'Building the departure airport…');
    await airports.update({ x: fdm.pos[0], z: fdm.pos[2] });
  } else {
    airports = new LocalAirports(scene, buildAircraft, { load: HEAVY_AIRPORT_LOAD, unload: HEAVY_AIRPORT_UNLOAD, elevFn: cesiumViewer ? getCesiumElevationWorld : null, warm: cesiumViewer ? (a) => warmCesiumTerrain(a.arp[0], a.arp[1], Math.max(a.radius + 300, 1900), 300) : null });
    applySetup(s0, true);
    if (cesiumViewer) { progress(0.56, 'Sampling real-world elevation around the aircraft…'); await warmCesiumTerrain(fdm.pos[0], fdm.pos[2], 2500, 300); applySetup(s0, true); }
    progress(0.6, 'Building the departure airport…');
    await airports.update({ x: fdm.pos[0], z: fdm.pos[2] });
  }
  sim.ready = true;
  await new Promise((r) => requestAnimationFrame(r));
  if (useLocalScenery) {
    if (loadMode === 'light') {
      if (ground) { progress(0.70, 'Mapping fields, yards and streets…'); await ground.ready(fdm.pos[0], fdm.pos[2]); blades = new GrassBlades(scene, ground); crops = new CropField(scene, ground); await crops.init(); }
      progress(0.72, 'Growing trees…'); forest = new Forest(scene, renderer);
      if (ground) { const NOF = new Set([1, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15, 16, 22, 23, 24, 25, 26, 28]); forest.reject = (x, z) => { const g = ground.sample(x, z); return !!g && (g.cov > 0.15 || NOF.has(g.cls)); }; }
      await forest.init(0.45); rocks = new RockField(scene); await rocks.init(0.4);
      progress(0.80, 'Laying out roads, streets and buildings…'); scenery = new Scenery(scene, { light: true, quality: 0.6, ground }); await scenery.init();
    } else {
      rocks = new RockField(scene); await rocks.init(0.8); forest = new Forest(scene, renderer); await forest.init(0.8);
      grass = new GrassField(scene); await grass.init(0.8);
      progress(0.86, 'Building towns, roads and bridges…'); scenery = new Scenery(scene, { light: false, quality: 1 }); await scenery.init();
    }
  }
  progress(0.92, 'Adding vehicles and airport activity…');
  const realFarms = ground ? await fetch('./data/farms.json?v=20261123g').then((r) => r.json()).catch(() => null) : null;
  life = await buildLife(scene, { cars: loadMode === 'light' ? 160 : 380, streets: scenery ? (x, z, r) => scenery.streetsNear(x, z, r) : null, realFarms, flatStreets: !!ground });
  if (loadMode === 'light') life.quality = 0.55;
  sim.life = life; life.setRoadTraffic(readSetup().roadTraffic);
  progress(0.93, 'Air traffic…');
  traffic = new Traffic(scene, { light: loadMode === 'light' }); await traffic.init(buildAircraft); traffic.setEnabled(sim.aiTrafficEnabled !== false);
  traffic.sim = sim; sim.playerRad = 34; sim.tower = new Tower(traffic, sim.atc); sim.taxiChart = taxiChart; taxiChart('KSFO');
  sim.traffic = traffic; sim.scenery = scenery; sim.airports = airports; sim.terrain = terrain;
  if (scenery) for (let i = 0; i < 60; i++) scenery.update({ x: fdm.pos[0], z: fdm.pos[2] });
  progress(0.95, 'Charts…');
  mmap = new MovingMap(); sim.mmap = mmap; { const t0 = performance.now(); while (!mmap.build(40) && performance.now() - t0 < 4000); } mmap.traffic = () => (traffic && traffic.enabled ? traffic.list : []);
  progress(1, 'Ready');
  await new Promise((r) => requestAnimationFrame(r));
  $('loading').classList.add('hidden'); $('loadChoice').classList.add('hidden'); $('setup').classList.remove('hidden');
  $('fly').disabled = false;
  $('fly').click();
}

function chooseLoadMode(mode) {
  loadMode = mode;
  $('loadChoice').classList.add('hidden'); $('loading').classList.remove('hidden'); $('setup').classList.add('hidden'); $('fly').disabled = true;
  if (mode === 'light') $('quality').value = 'lite';
  init().catch((error) => {
    console.error(error);
    const message = error instanceof Error ? error.message : (typeof error === 'string' && error ? error : error?.message || 'Unknown loading error');
    loadText.textContent = 'Failed to load: ' + message;
    $('loading').classList.add('hidden'); $('setup').classList.add('hidden'); $('loadChoice').classList.remove('hidden');
  });
}
window.chooseLoadMode = chooseLoadMode; window.startEdition = chooseLoadMode;

// ---------------- setup / spawn ----------------
function readSetup() {
  return {
    fp: window.FlightSetup?.get() || null, tod: +$('tod').value, windDir: +$('wdir').value, windKt: +$('wspd').value, turb: +$('turb').value,
    cover: +$('clouds').value, baseFt: +$('cbase').value, visKm: +$('vis').value, qnh: +$('qnh').value, isa: +$('isa').value, fuelT: +$('fuel').value, paxT: +$('payload').value,
    quality: $('quality').value, autoRes: $('autoRes').checked, roadTraffic: $('roadTraffic').value, atcEnabled: $('atcEnabled').checked, aiTraffic: $('aiTraffic').checked,
  };
}
function bindOutputs() {
  const fmtT = (v) => { const h = Math.floor(v), m = Math.round((v - h) * 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
  const map = [['tod', 'todOut', fmtT], ['wdir', 'wdOut', (v) => String(v).padStart(3, '0') + '°'], ['wspd', 'wsOut', (v) => v + ' kt'],
    ['turb', 'tbOut', (v) => (v < 0.05 ? 'None' : v < 0.3 ? 'Light' : v < 0.6 ? 'Moderate' : 'Severe')], ['cbase', 'cbOut', (v) => (+v).toLocaleString() + ' ft'],
    ['vis', 'visOut', (v) => v + ' km'], ['qnh', 'qnhOut', (v) => v + ' hPa'], ['isa', 'isaOut', (v) => (v >= 0 ? '+' : '') + v + ' °C'], ['fuel', 'fuelOut', (v) => v + ' t'], ['payload', 'payloadOut', (v) => v + ' t']];
  for (const [i, o, fn] of map) { const el = $(i), out = $(o); if (!el || !out) continue; const up = () => (out.textContent = fn(+el.value)); el.addEventListener('input', up); up(); }
}
bindOutputs();
const airport = (icao) => AIRPORTS.find((a) => a.icao === icao);
const MIN_RWY = 7000 * 0.3048; // m
const flightOf = (s) => resolveFlight(s.fp || { dep: 'KSFO', dest: 'KSJC', crzFt: 12000, state: 'cold' }, { windDir: s.windDir, windKt: s.windKt }, MIN_RWY);
// pick a terminal stand deep enough for a 74 m aircraft and reserve it (and its neighbours) so no AI airliner parks there
function gateFor(icao) {
  const a = airport(icao); if (!a) return null; if (a._a350Gate) return a._a350Gate;
  const spots = gateSpots(a, icao === 'KSFO' ? 46 : 22);
  const onApron = (x, z) => a.aprons.some((ap) => pointInPoly(x, z, ap.p));
  let best = null;
  spots.forEach((s, i) => { if (best) return; if (onApron(s.wx + s.nx * 90, s.wz + s.nz * 90) && onApron(s.wx + s.nx * 60 + s.nz * 30, s.wz + s.nz * 60 - s.nx * 30) && onApron(s.wx + s.nx * 60 - s.nz * 30, s.wz + s.nz * 60 + s.nx * 30)) best = { ...s, i }; });
  if (!best && spots.length) best = { ...spots[Math.min(spots.length - 1, 3)], i: Math.min(spots.length - 1, 3) };
  if (!best) return null;
  a._reservedSpots = new Set([best.i - 1, best.i, best.i + 1]);
  a._a350Gate = best; return best;
}
function reserveGate(s) { const R = flightOf(s); if (R.stage === 'ramp' || R.stage === 'taxi') gateFor(R.dep); return R; }

let lastSetup = null;
function applySetup(s, warmOnly = false) {
  lastSetup = s;
  const F = fdm; const R = flightOf(s), stage = R.stage;
  // what the old spawn table described, now derived from the step-3 start state
  const sp = { icao: R.dep, rwy: R.depRwy, gate: stage === 'ramp', cold: R.state === 'cold', running: R.state === 'running', taxi: stage === 'taxi',
    air: stage === 'final' ? 'ils' : stage === 'climb' || stage === 'cruise' ? stage : null };
  sim.flight = R; s.flight = R;
  sim.atc.enabled = s.atcEnabled !== false; sim.aiTrafficEnabled = s.aiTraffic !== false; sim.atc.trafficEnabled = sim.aiTrafficEnabled;
  if (life) life.setTrafficEnabled?.(sim.aiTrafficEnabled); if (traffic) traffic.setEnabled(sim.aiTrafficEnabled);
  sim.weather = { windDir: s.windDir, windKt: s.windKt, turb: s.turb, cover: s.cover, baseFt: s.baseFt, visKm: s.visKm, qnhHpa: s.qnh, isa: s.isa };
  sim.timeOfDay = s.tod; const ls = env.setTime(s.tod); sim.night = ls.night;
  const q = { high: [1.75, 4096, 1.0], balanced: [1.25, 2048, 0.65], perf: [0.75, 512, 0.18], lite: [0.6, 256, 0.08] }[s.quality] || [1.25, 2048, 0.65];
  perf.setAuto(s.autoRes !== false); perf.setBase(Math.min(window.devicePixelRatio, q[0]));
  if (life) life.setRoadTraffic?.(s.roadTraffic);
  if (env.sun.shadow.mapSize.x !== q[1]) { env.sun.shadow.mapSize.set(q[1], q[1]); if (env.sun.shadow.map) { env.sun.shadow.map.dispose(); env.sun.shadow.map = null; } }
  if (forest) { forest.quality = q[2]; forest.lastKey = null; } if (rocks) { rocks.quality = q[2]; rocks.lastCell = null; } if (grass) { grass.quality = q[2]; grass.lastKey = null; } if (life) life.quality = q[2];
  // environment
  F.env.qnh = s.qnh * HPA; F.env.isaDev = s.isa; F.env.turbulence = s.turb;
  const wr = s.windDir * D2R, ws = s.windKt * KT; sim.windVec = [-Math.sin(wr) * ws, 0, Math.cos(wr) * ws]; F.env.wind = sim.windVec.slice();
  env.setWeather({ cover: s.cover, base: s.baseFt * FT, visKm: s.visKm, windDir: s.windDir, windKt: s.windKt });
  // flight plan (the FMS F-PLN: departure fix, pilot route or automatic VORs, approach)
  fms.reset();
  fms.build({ origin: R.dep, originRwy: R.depRwy, dest: R.dest, destRwy: R.arrRwy, crzFL: Math.round(R.crzFt / 100), via: R.wpts });
  // spawn
  let pos, hdg, onGround = true, speed = 0, alt = 0, cold = sp.cold, conf = 0, gearDown = true;
  sim.taxi = null; cancelServices(true);
  if (sp.gate || sp.taxi) {
    const g = gateFor(R.dep) || { wx: R.depA.ramp.x, wz: R.depA.ramp.z, nx: 0, nz: 1 };
    const d = 7 + (XNOSE); pos = { x: g.wx + g.nx * d, z: g.wz + g.nz * d };
    hdg = (Math.atan2(-g.nx, g.nz) / D2R + 360) % 360; // nose toward the terminal (forward = -n)
    let route = departureRoute(R.dep, R.depRwy, pos.x, pos.z);
    if (sp.taxi && route) {
      // already pushed back: on the taxi route clear of the stand, nose along the route
      const pts = route.pts; let k = pts.findIndex((p) => Math.hypot(p.x - pos.x, p.z - pos.z) > 110);
      if (k < 0) k = Math.max(0, pts.length - 2); const p = pts[k], n = pts[Math.min(pts.length - 1, k + 1)];
      const nn = n === p ? pts[k] : n;
      pos = { x: p.x, z: p.z }; if (nn !== p) hdg = (Math.atan2(nn.x - p.x, -(nn.z - p.z)) / D2R + 360) % 360;
      route = departureRoute(R.dep, R.depRwy, pos.x, pos.z) || route;
      conf = 2;
    }
    if (route) sim.taxi = { route, show: true, icao: R.dep };
    s.depRwy = route ? route.rwy : R.depRwy; s.taxiVia = route ? route.viaText : null;
  } else if (stage === 'final') {
    const e = fms.dest.end; const c = e.hdg * D2R; let d = (R.arrILS ? 11 : 7) * NM;
    // shorter final when the full one would start outside the scenery (e.g. SJC 30L from the south-east)
    while (d > 5 * NM && !inWorld(e.x - Math.sin(c) * d, e.z + Math.cos(c) * d, 4000)) d -= NM;
    pos = { x: e.x - Math.sin(c) * d, z: e.z + Math.cos(c) * d }; hdg = e.hdg; onGround = false; speed = 175; conf = 4;
    alt = R.arrILS ? 3000 * FT + e.elev + (s.qnh - 1013) * 27 * FT : e.elev + Math.tan(3 * D2R) * d + 15;
  } else if (stage === 'climb') {
    // climbing out on runway heading, 4 nm past the departure end, clean
    const e = fms.origin.end, c = e.hdg * D2R, L = R.depRunway.len + 4 * NM;
    pos = { x: e.x + Math.sin(c) * L, z: e.z - Math.cos(c) * L }; hdg = e.hdg; onGround = false; speed = 230; alt = e.elev + 3000 * FT; gearDown = false;
  } else if (stage === 'cruise') {
    const p = enRoutePoint(R); pos = { x: p.x, z: p.z }; hdg = p.hdg; onGround = false; gearDown = false;
    alt = Math.max(R.crzFt * FT, heightAt(p.x, p.z) + 2000 * FT); speed = alt > 28000 * FT ? 260 : 280; R.leg = p.leg;
    // continue the F-PLN from the waypoint the aircraft is flying toward
    const pts = [R.dep, ...R.wpts.map((w) => w.ident), R.dest], to = pts[p.leg];
    let i = to === R.dest ? fms.legs.findIndex((l) => l.appr) : fms.legs.findIndex((l, j) => j > 1 && l.ident === to);
    if (i < 1) i = fms.legs.findIndex((l) => l.appr); if (i > 0) fms.act = i;
  } else {
    const f0 = findRunway(R.dep, R.depRwy); const e = runwayEnd(f0.r, f0.e); const k = (f0.r.disp?.[f0.e] || 0) + 45;
    pos = { x: e.x + e.dir[0] * k, z: e.z + e.dir[1] * k }; hdg = e.hdg; conf = 2;
  }
  // masses: fuel split wing tanks first, payload
  const fuel = clamp(s.fuelT * 1000, 8000, A350.fuelCap);
  const wing = Math.min(fuel, 2 * 41000); F.fuel = { L: wing / 2, R: wing / 2, C: fuel - wing };
  F.payload = clamp(s.paxT * 1000, 0, A350.maxPayload);
  const cfg = CONFS[conf];
  const localGh = heightAt(pos.x, pos.z); const cgh = getCesiumElevationWorld(pos.x, pos.z); const gh = Number.isFinite(cgh) ? cgh : localGh;
  warmCesiumTerrain(pos.x, pos.z);
  F.reset({ pos: [pos.x, onGround ? gh + A350.cgHeight : alt, pos.z], hdg, onGround, running: !cold && (!sp.gate || sp.running), speedKt: speed, gearDown, slat: cfg.slat, flap: cfg.flap });
  if (onGround) F.settleOnGround?.();
  S.reset(cold, { gpu: sp.gate && !sp.running });
  if (!cold) for (const k of ['CO', 'CI', 'CU', 'CL', 'FI', 'FO', 'ISIS']) S.du[k] = { t: 30 }; // displays already booted
  if (sp.gate && !cold && !sp.running) { S.master = [false, false]; S.press('EXT1', true); S.press('EXT2', true); S.press('APUGEN', true); }
  afs.reset({ hdg: Math.round(hdg), alt: onGround ? 5000 : Math.round(alt / FT / 100) * 100 });
  F.cfgTarget = { slat: cfg.slat, flap: cfg.flap }; sim.flapConf = conf; sim.flapLever = [0, 1, 1, 2, 3, 4][conf];
  F.gear.lever = gearDown ? 1 : 0; F.ctrl.gearLever = F.gear.lever;
  F.ctrl.tla = [0, 0]; F.ctrl.spdbrk = 0; F.ctrl.spdArm = false; F.ctrl.parkBrake = onGround; F.ctrl.rudTrim = 0;
  F.baroRef = cold ? 1013 : s.qnh;
  for (const e of sim.efis) { e.baro = s.qnh; e.std = stage === 'cruise' && R.crzFt >= 18000; e.mode = sp.air === 'cruise' ? 'NAV' : 'ARC'; e.range = sp.air ? (stage === 'cruise' ? 40 : 20) : 10; e.ls = sp.air === 'ils' && R.arrILS; }
  sim.kccu.focus = null; sim.kccu.buf = ''; sim.mfdInit = null;
  if (onGround) {
    fms.perf.conf = 1; F.abrk.mode = 'RTO';
    if (!cold) { fms.computeTO(F, fms.perf.conf, false); if (!sp.gate) { afs.athr.armed = true; F.ctrl.parkBrake = true; } }
    if (sp.taxi) { S.ov.NOSE = 1; S.ov.BEACON = 1; S.ov.NAV = 1; }
    if (stage === 'runway') { S.ov.NOSE = 2; S.ov.LAND = 1; S.ov.STROBE = 2; S.ov.BEACON = 1; S.ov.NAV = 1; }
  }
  if (sp.air === 'ils') {
    F.ctrl.tla = [DETENT.CLB, DETENT.CLB]; F.ctrl.parkBrake = false; F.E.forEach((e) => (e.P = 0.45)); F.trimAir(-1);
    fms.phase = 'APPROACH'; fms.appr.conf = 5; fms.appr.qnh = s.qnh; fms.computeLDG(F, 5);
    afs.airT = 30; afs.fcu.alt = 3000; afs.athr.armed = true; afs.athr.active = true;
    afs.fcu.spdManaged = true; afs.hdgPull(); afs.apPb(0); if (R.arrILS) { afs.apprPb(); afs.apPb(1); }
    F.ctrl.spdArm = true; F.abrk.mode = 'LO';
  } else if (sp.air) {
    // climb / cruise: AP1, A/THR, managed NAV along the F-PLN, FCU altitude = cruise level
    F.ctrl.tla = [DETENT.CLB, DETENT.CLB]; F.ctrl.parkBrake = false; F.E.forEach((e) => (e.P = sp.air === 'climb' ? 0.8 : 0.6)); F.trimAir(0);
    fms.phase = sp.air === 'climb' ? 'CLIMB' : 'CRUISE'; afs.airT = 300;
    afs.fcu.alt = Math.round(R.crzFt / 100) * 100; afs.athr.armed = true; afs.athr.active = true; afs.fcu.spdManaged = false; afs.fcu.spd = sp.air === 'climb' ? 250 : Math.round(speed);
    afs.hdgPull(); afs.apPb(0); afs.hdgPush?.(); if (sp.air === 'climb') afs.altPush?.(); else afs.altPush();
    for (const k of ['NAV', 'BEACON']) S.ov[k] = 1; S.ov.STROBE = 2;
  }
  if (sp.air) { S.ov.NAV = 1; S.ov.BEACON = 1; S.ov.STROBE = 2; if (sp.air !== 'cruise') S.ov.LAND = 1; }
  F.ind.ias = speed;
  // ATC (shared module) — call sign from the FMS flight number
  sim.atc.reset({ callsign: 'Airbus ' + fms.flightNo.replace(/\D/g, ''), flight: R, depRwy: s.depRwy || R.depRwy, taxiVia: s.taxiVia, aiTraffic: s.aiTraffic });
  sim.atc.callsign = 'Airbus ' + fms.flightNo.replace(/\D/g, '');
  if (sim.tower) sim.tower.q.clear();
  sim.rmp[0].active.VHF1 = sim.atc.frequency;
  if (scenery) scenery.setNight(sim.night); if (life) life.setNight(sim.night);
  if (mmap) mmap.track = [];
  sim.crashShown = false; sim.lastTD = null; sim.airTime = 0; sim.auto = null;
  sim.view = sim.view === 'walk' ? 'cockpit' : sim.view; look.yaw = 0; look.pitch = -9; camera.fov = 60; walker.pos = null;
  const cam = new THREE.Vector3(F.pos[0], F.pos[1], F.pos[2]);
  if (terrain) terrain.warm(cam, F.pos[1] - gh);
  if (airports?.update) airports.update(cam);
  if (forest && rocks) for (let i = 0; i < 40; i++) { forest.update(cam, 200); rocks.update(cam, 200); }
  if (grass) grass.update(cam, F.pos[1] - gh);
  if (scenery) for (let i = 0; i < 40; i++) scenery.update(cam);
  buildTaxiLine(); syncAircraft(0);
  sim.displays?.update(0, 9, true);
  void warmOnly;
}
const XNOSE = 35.85; // nose tip ahead of the CG (m)
function rebuildTaxi() {
  if (!fdm.onGround || !fms.origin) return;
  const r = departureRoute(fms.origin.icao, fms.origin.rwy, fdm.pos[0], fdm.pos[2]);
  sim.taxi = r ? { route: r, show: true, icao: fms.origin.icao } : null; buildTaxiLine();
}

// ---------------- input ----------------
const look = { yaw: 0, pitch: -9, dragging: false, lx: 0, ly: 0, moved: 0 };
sim.look = look;
const orbit = { yaw: 200, pitch: 12, dist: 95 };
const walker = { pos: null, yaw: 0, pitch: 0 }; sim.walker = walker;
const mouse = { x: 0, y: 0, yoke: false, nx: 0, ny: 0 };
const ctrlState = { pitch: 0, roll: 0, rud: 0 };
const views = ['cockpit', 'cabin', 'orbit', 'chase', 'tower', 'flyby', 'walk'];
const viewNames = { cockpit: 'FLIGHT DECK', cabin: 'FLIGHT DECK — FREE HEAD (WASD)', orbit: 'EXTERNAL ORBIT', chase: 'CHASE', tower: 'TOWER', flyby: 'FLY-BY', walk: 'WALKAROUND (WASD)' };

function toast(msg, ms = 1800) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), ms); }

// thrust levers, flaps, speed brake, gear (shared by keyboard and the 3D levers)
const DET = [['REV MAX', DETENT.REV_MAX], ['REV IDLE', DETENT.REV_IDLE], ['IDLE', DETENT.IDLE], ['CL', DETENT.CLB], ['FLX/MCT', DETENT.FLX], ['TO/GA', DETENT.TOGA]];
sim.tlaName = (i) => { const v = fdm.ctrl.tla[i]; const d = DET.find(([, x]) => Math.abs(x - v) < 0.015); return d ? d[0] : Math.round(v * 100) + '%'; };
sim.leverStep = (dir, only = null) => {
  const c = fdm.ctrl; const rev = fdm.onGround || fdm.ra < 3;
  for (let i = 0; i < 2; i++) {
    if (only != null && only !== i) continue;
    const v = c.tla[i]; const list = DET.map(([, x]) => x).filter((x) => rev || x >= 0);
    let n = v; if (dir > 0) n = list.find((x) => x > v + 0.01) ?? v; else n = [...list].reverse().find((x) => x < v - 0.01) ?? v;
    c.tla[i] = n;
  }
  if (only == null) toast('Thrust levers ' + sim.tlaName(0), 900);
  sim.sound.clack();
};
sim.leverFine = (d) => { const c = fdm.ctrl; for (let i = 0; i < 2; i++) c.tla[i] = c.tla[i] < 0 ? clamp(c.tla[i] + d, -1, -0.12) : clamp(c.tla[i] + d, 0, 1); };
sim.speedbrakeClick = (b) => {
  const c = fdm.ctrl;
  if (b === 2) { c.spdArm = false; c.spdbrk = c.spdbrk > 0 ? 0 : 1; }
  else if (c.spdbrk > 0) c.spdbrk = 0; else c.spdArm = !c.spdArm;
  toast('Speed brake ' + (c.spdArm ? 'ARMED (ground spoilers)' : c.spdbrk > 0 ? Math.round(c.spdbrk * 100) + '%' : 'RETRACTED'), 1000);
};
sim.speedbrakeWheel = (d) => { const c = fdm.ctrl; c.spdArm = false; c.spdbrk = clamp(Math.round((c.spdbrk + (d > 0 ? -0.25 : 0.25)) * 4) / 4, 0, 1); toast('Speed brake ' + Math.round(c.spdbrk * 100) + '%', 700); };
const LEVER_NAMES = ['0', '1', '2', '3', 'FULL'];
sim.flapStep = (dir) => {
  const prev = sim.flapLever; const n = clamp(prev + dir, 0, 4); if (n === prev) return;
  sim.flapLever = n;
  let conf = [0, 1, 3, 4, 5][n];
  if (n === 1) conf = fdm.onGround || (prev === 2 && fdm.ind.ias < 215) ? 2 : 1; // CONF 1+F on ground / when retracting below 210 kt
  setConf(conf); toast('FLAPS ' + LEVER_NAMES[n] + ' → CONF ' + CONFS[conf].id, 1100); sim.sound.clack();
};
function setConf(conf) { sim.flapConf = conf; const c = CONFS[conf]; fdm.cfgTarget = { slat: c.slat, flap: c.flap }; }
sim.gearToggle = () => {
  const g = fdm.gear;
  if (g.lever === 1 && fdm.onGround) { toast('Gear lever locked down — weight on wheels', 1500); return; }
  g.lever = g.lever ? 0 : 1; fdm.ctrl.gearLever = g.lever; toast('Landing gear ' + (g.lever ? 'DOWN' : 'UP'), 1000); sim.sound.clack();
};

window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT')) return;
  sim.sound.start();
  // KCCU typing into a focused MFD field
  if (sim.kccu.focus && sim.started && !e.ctrlKey && !e.metaKey) {
    const k = e.key;
    if (k === 'Backspace' || k === 'Escape' || k === 'Enter') { sim.kccuKey(k); e.preventDefault(); return; }
    if (k.length === 1 && /[A-Za-z0-9/.\-+ ]/.test(k)) { sim.kccuKey(k === ' ' ? ' ' : k.toUpperCase()); e.preventDefault(); return; }
  }
  const code = remap(e.code); if (code == null) return;
  const F = fdm; sim.keys[code] = true; sim.keys.Shift = e.shiftKey;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space', 'Slash', 'Backquote'].includes(code)) e.preventDefault();
  if (!sim.started) return;
  if (e.repeat && !['Home', 'End'].includes(code)) { if (e.shiftKey && code.startsWith('Arrow')) { /* FCU knobs repeat */ } else return; }
  const sh = e.shiftKey; const walking = walkView();
  switch (code) {
    case 'Escape': if (taxiMapOpen()) { toggleTaxiMap(false); $('tmapBtn').classList.remove('on'); break; } if (!$('help').classList.contains('hidden')) { setHelp(false); break; } if (!$('mapWrap').classList.contains('hidden')) { toggleMap(false); break; } if (!$('gsPanel').classList.contains('hidden')) { toggleGS(false); break; } togglePause(); if (sim.paused) showMenu(true); break;
    case 'KeyF': if (!walking) sim.flapStep(1); break;
    case 'KeyV': if (!walking) sim.flapStep(-1); break;
    case 'KeyG': if (sh) toggleATC(); else sim.gearToggle(); break;
    case 'KeyP': F.ctrl.parkBrake = !F.ctrl.parkBrake; S.emit('park'); toast('Parking brake ' + (F.ctrl.parkBrake ? 'ON' : 'OFF')); break;
    case 'KeyK': if (sh) { F.ctrl.spdbrk = 0; F.ctrl.spdArm = false; toast('Speed brake RETRACTED', 900); } else sim.speedbrakeWheel(-1); break;
    case 'Backslash': sim.speedbrakeClick(0); break;
    case 'KeyR': if (!walking) { const c = F.ctrl; if (c.tla[0] < 0) { c.tla = [0, 0]; toast('Reversers stowed — IDLE', 900); } else if (F.onGround && c.tla[0] < 0.05 && c.tla[1] < 0.05) { c.tla = [DETENT.REV_MAX, DETENT.REV_MAX]; toast('MAX REVERSE', 900); } else toast('Reverse thrust: levers to IDLE, on the ground', 1500); } break;
    case 'KeyA': if (!walking) { afs.apPb(sh ? 1 : 0); toast('AP' + (sh ? 2 : 1) + ' ' + (afs.ap[sh ? 1 : 0] ? 'ON' : 'OFF')); } break;
    case 'KeyQ': if (!walking) { if (sh) { afs.athrInstinctive?.(); toast('A/THR disconnected'); } else { afs.instinctiveDisc(); toast('AP disconnected (sidestick pb)'); } } break;
    case 'KeyZ': case 'KeyX': break;
    case 'KeyE': if (sh) autoStart(); break;
    case 'KeyL': if (sh) { S.ov.NOSE = (S.ov.NOSE + 1) % 3; toast('NOSE light ' + ['OFF', 'TAXI', 'T.O'][S.ov.NOSE]); } else { S.ov.LAND = S.ov.LAND ? 0 : 1; toast('LAND lights ' + (S.ov.LAND ? 'ON' : 'OFF')); } break;
    case 'KeyO': if (sh) { S.ov.NAV = S.ov.NAV ? 0 : 1; toast('NAV lights ' + (S.ov.NAV ? 'ON' : 'OFF')); } else { S.ov.STROBE = (S.ov.STROBE + 1) % 3; toast('STROBE ' + ['OFF', 'AUTO', 'ON'][S.ov.STROBE]); } break;
    case 'KeyB': if (sh) { S.ov.BEACON = S.ov.BEACON ? 0 : 1; toast('BEACON ' + (S.ov.BEACON ? 'ON' : 'OFF')); } break;
    case 'KeyH': S.eclOpen = !S.eclOpen; toast(S.eclOpen ? 'Electronic checklist open on the EWD (click items, or C/L keys on the ECP)' : 'Checklist closed', 1600); break;
    case 'KeyJ': toggleGS(); break;
    case 'KeyM': toggleMap(); break;
    case 'KeyN': $('mini').classList.toggle('hidden'); break;
    case 'KeyT': toggleTaxiLine(); break;
    case 'KeyY': mouse.yoke = !mouse.yoke; $('yokeChip').classList.toggle('hidden', !mouse.yoke); $('cross').classList.toggle('hidden', !mouse.yoke); toast(mouse.yoke ? 'Mouse sidestick ON — mouse position = sidestick' : 'Mouse sidestick OFF'); break;
    case 'KeyU': $('strip').classList.toggle('hidden'); break;
    case 'KeyD': if (!walking) { sim.seat = 1 - sim.seat; toast(sim.seat ? 'First officer seat (right)' : 'Captain seat (left)'); } break;
    case 'KeyC': setView(views[(views.indexOf(sim.view) + 1) % views.length]); break;
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6': case 'Digit7': setView(views[+code.slice(5) - 1]); break;
    case 'Digit8': $('tmapBtn').classList.toggle('on', toggleTaxiMap(undefined, sim)); break;
    case 'Digit9': sim.simRate = sim.simRate >= 4 ? 1 : sim.simRate * 2; toast('Sim rate ' + sim.simRate + '×'); break;
    case 'Digit0': lookAtPreset(sh ? 'ped' : 'ovhd'); break;
    case 'Space': look.yaw = 0; look.pitch = -9; camera.fov = 60; camera.updateProjectionMatrix(); break;
    case 'Slash': setHelp($('help').classList.contains('hidden')); break;
    case 'Semicolon': $('fps').classList.toggle('hidden'); break;
    case 'Backquote': S.masterWarn = false; S.masterCaut = false; S.emit('silence'); break;
    case 'ArrowLeft': case 'ArrowRight': if (sh) afs.hdgTurn(code === 'ArrowLeft' ? -1 : 1); break;
    case 'ArrowUp': case 'ArrowDown': if (sh) afs.altTurn(code === 'ArrowUp' ? 1 : -1); break;
    case 'PageUp': case 'PageDown': if (sh) sim.leverStep(code === 'PageUp' ? 1 : -1); break;
    case 'KeyW': case 'KeyS': if (sh && !walking) sim.leverStep(code === 'KeyW' ? 1 : -1); break;
  }
});
window.addEventListener('keyup', (e) => { const code = remap(e.code); if (code == null) return; sim.keys[code] = false; sim.keys.Shift = e.shiftKey; });
window.addEventListener('blur', () => { sim.keys = {}; });
const walkView = () => sim.view === 'cabin' || sim.view === 'walk';
function lookAtPreset(p) { if (sim.view !== 'cockpit') setView('cockpit'); if (p === 'ovhd') { look.yaw = 0; look.pitch = 62; } else { look.yaw = sim.seat ? 38 : -38; look.pitch = -55; } }

// one-key cockpit preparation + engine start (Shift+E): runs the FCOM flow with realistic timing
function autoStart() {
  if (!fdm.onGround) { toast('Auto-start is for the ground'); return; }
  toast('Auto-start: batteries, external power / APU, ADIRS, fuel pumps, beacon, engine 2 then engine 1…', 4000);
  sim.auto = { step: 0, t: 0 };
}
function runAuto(dt) {
  const a = sim.auto; if (!a) return; a.t += dt; const P = (id, v) => S.press(id, v);
  switch (a.step) {
    case 0: for (const k of ['BAT1', 'BAT2', 'BATEMER1', 'BATEMER2']) P(k, true); if (S.gpu) { P('EXT1', true); P('EXT2', true); } a.step++; a.t = 0; break;
    case 1: if (a.t > 1.5) { for (const k of ['IR1', 'IR2', 'IR3']) P(k, 1); for (const k of ['ADR1', 'ADR2', 'ADR3']) P(k, true); P('APUMASTER', true); P('CREWO2', true); P('NAV', 1); P('LOGO', sim.night > 0.3 ? 1 : 0); a.step++; a.t = 0; } break;
    case 2: if (a.t > 3) { P('APUSTART', true); a.step++; a.t = 0; } break;
    case 3: if (S.apu.avail || a.t > 90) { P('APUBLEED', true); for (const k of ['FPL1', 'FPL2', 'FPC1', 'FPC2', 'FPR1', 'FPR2']) P(k, true); for (const k of Object.keys(S.doors)) S.doors[k] = false; cancelServices(); a.step++; a.t = 0; } break;
    case 4: if (a.t > 2) { P('BEACON', 1); fdm.ctrl.tla = [0, 0]; fdm.ctrl.parkBrake = true; S.engMode = 'IGN'; a.step++; a.t = 0; } break;
    case 5: if (a.t > 2) { S.master[1] = true; a.step++; a.t = 0; } break;
    case 6: if (fdm.E[1].avail || a.t > 120) { S.master[0] = true; a.step++; a.t = 0; } break;
    case 7: if (fdm.E[0].avail || a.t > 120) { S.engMode = 'NORM'; P('APUBLEED', false); P('EXT1', false); P('EXT2', false); a.step++; a.t = 0; } break;
    case 8: if (a.t > 4) { P('APUMASTER', false); fms.computeTO(fdm, fms.perf.conf, false); sim.flapStep(1 - sim.flapLever); fdm.ctrl.spdArm = true; afs.athr.armed = true; P('NOSE', 1); P('STROBE', 1); toast('Engines running. Flaps 1+F, ground spoilers armed, T.O data computed — check the MFD PERF page.', 6000); sim.auto = null; } break;
  }
}

function setView(v) {
  sim.view = v; $('viewName').textContent = viewNames[v];
  if (v === 'walk') {
    const F = fdm;
    if (!(F.onGround && Math.hypot(F.vel[0], F.vel[2]) < 1)) { toast('Walkaround only on the ground, stopped'); sim.view = 'cockpit'; $('viewName').textContent = viewNames.cockpit; return; }
    const side = qrot(F.q, [0, 0, -1]), fw = qrot(F.q, [1, 0, 0]);
    walker.pos = new THREE.Vector3(F.pos[0] + side[0] * 14 + fw[0] * 22, 0, F.pos[2] + side[2] * 14 + fw[2] * 22);
    walker.yaw = Math.atan2(-(F.pos[0] - walker.pos.x), -(F.pos[2] - walker.pos.z)) / D2R; walker.pitch = 4;
  }
  if (v === 'cabin') { freeEye.set(...(sim.seat ? A350.eyeFO : A350.eyeCapt)); }
  if (v === 'flyby') flyby.pos = null;
  if (v !== 'tower' && v !== 'flyby') { camera.fov = v === 'cockpit' || v === 'cabin' ? 60 : 55; camera.updateProjectionMatrix(); }
  if (v === 'orbit') { const h = fdm.attitude.hdg * D2R; orbit.yaw = Math.atan2(Math.cos(h), -Math.sin(h)) / D2R + 35; orbit.pitch = 12; orbit.dist = 95; } // rear three-quarter view
}
const freeEye = new THREE.Vector3(...A350.eyeCapt);
const flyby = { pos: null };

// mouse
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  sim.sound.start(); canvas.focus?.();
  look.dragging = true; look.lx = e.clientX; look.ly = e.clientY; look.moved = 0; look.button = e.button;
  if (mouse.yoke && e.button === 2 && mouseSettings.rudderButton) { mouse.rudder = true; look.dragging = false; }
  if (mouse.yoke && e.button === 0 && !panelHit(e.clientX, e.clientY)) look.dragging = false;
  canvas.setPointerCapture?.(e.pointerId);
  look.hold = null;
  const h = panelHit(e.clientX, e.clientY);
  if (h && h.down) { h.down(e.button); look.hold = h; look.dragging = false; sim.sound.click(); }
});
canvas.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY; mouse.nx = (e.clientX / window.innerWidth) * 2 - 1; mouse.ny = (e.clientY / window.innerHeight) * 2 - 1;
  if (mouse.yoke) { $('cross').style.left = e.clientX + 'px'; $('cross').style.top = e.clientY + 'px'; }
  if (!look.dragging) return;
  const dx = e.clientX - look.lx, dy = e.clientY - look.ly; look.lx = e.clientX; look.ly = e.clientY; look.moved += Math.abs(dx) + Math.abs(dy);
  if (look.moved < 4) return;
  const k = camera.fov / 600;
  if (sim.view === 'orbit' || sim.view === 'chase') { orbit.yaw -= dx * 0.3; orbit.pitch = clamp(orbit.pitch + dy * 0.25, -80, 85); }
  else if (sim.view === 'walk') { walker.yaw -= dx * k * 1.2; walker.pitch = clamp(walker.pitch - dy * k * 1.2, -85, 85); }
  else { look.yaw = clamp(look.yaw - dx * k * 1.2, -170, 170); look.pitch = clamp(look.pitch - dy * k * 1.2, -80, 80); }
});
canvas.addEventListener('pointerup', (e) => {
  look.dragging = false; if (e.button === 2) mouse.rudder = false;
  if (look.hold) { look.hold.up?.(e.button); look.hold = null; return; }
  if (look.moved < 4) panelClick(e.clientX, e.clientY, e.button);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const h = panelHit(e.clientX, e.clientY);
  if (h && h.wheel) { h.wheel(e.deltaY * (e.shiftKey ? 10 : 1)); sim.sound.click(); return; }
  if (mouse.yoke && mouseSettings.wheelThrottle && sim.started && !walkView()) { sim.leverFine(-Math.sign(e.deltaY) * 0.04); toast('Thrust levers ' + sim.tlaName(0), 700); return; }
  if (sim.view === 'orbit' || sim.view === 'chase') orbit.dist = clamp(orbit.dist * (1 + Math.sign(e.deltaY) * 0.1), 30, 900);
  else { camera.fov = clamp(camera.fov + Math.sign(e.deltaY) * 4, 15, 95); camera.updateProjectionMatrix(); }
}, { passive: false });

const ray = new THREE.Raycaster();
function panelHit(x, y) {
  if (!(sim.view === 'cockpit' || sim.view === 'cabin') || !cockpit) return null;
  ray.setFromCamera({ x: (x / window.innerWidth) * 2 - 1, y: -(y / window.innerHeight) * 2 + 1 }, camera);
  const faces = cockpit.faces; const meshes = faces.map((f) => f.mesh);
  const hits = ray.intersectObjects([...meshes, ...cockpit.hot3d], true);
  for (const hit of hits) {
    const fi = meshes.indexOf(hit.object);
    if (fi >= 0) { if (!hit.uv) return null; const h = faces[fi].hit(hit.uv.x, hit.uv.y); if (h) return h; return null; }
    let o = hit.object; while (o && !o.userData.hot) o = o.parent;
    if (o && o.visible !== false) return o.userData.hot;
  }
  return null;
}
sim.panelHit = panelHit;
function panelClick(x, y, button) { const h = panelHit(x, y); if (h && h.click) { h.click(button); sim.sound.click(); } }

// gamepad
function readGamepad() {
  const gps = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of gps) { if (!gp || !gp.connected) continue; const dz = (v) => (Math.abs(v) < 0.06 ? 0 : v); return { x: dz(gp.axes[0] || 0), y: dz(gp.axes[1] || 0), rud: dz(gp.axes[2] || 0), thr: dz(gp.axes[3] || 0), b: gp.buttons.map((b) => b.pressed) }; }
  return null;
}
let gpPrev = [];

function updateControls(dt) {
  const F = fdm, c = F.ctrl, K = sim.keys, sh = K.ShiftLeft || K.ShiftRight; const walking = walkView();
  const target = (pos, neg) => (K[pos] ? 1 : 0) - (K[neg] ? 1 : 0);
  const tp = sh || walking ? 0 : target('ArrowDown', 'ArrowUp'), tr = sh || walking ? 0 : target('ArrowRight', 'ArrowLeft');
  const tz = walking ? 0 : target('KeyX', 'KeyZ');
  const rate = (cur, tgt, up, down) => { const d = tgt - cur; const r = Math.abs(tgt) > Math.abs(cur) ? up : down; return cur + clamp(d, -r * dt, r * dt); };
  ctrlState.pitch = rate(ctrlState.pitch, tp * 0.7, 1.6, 3); ctrlState.roll = rate(ctrlState.roll, tr * 0.8, 2.2, 3.5); ctrlState.rud = rate(ctrlState.rud, tz, 1.6, 2.4);
  let sy = ctrlState.pitch, sx = ctrlState.roll, rud = ctrlState.rud;
  if (mouse.yoke) { sy += mouseAxis(mouse.ny) * (mouseSettings.invert ? -1 : 1); if (mouse.rudder) rud += mouseAxis(mouse.nx); else sx += mouseAxis(mouse.nx); }
  const gp = readGamepad();
  if (gp) {
    sx += gp.x; sy += gp.y; rud += gp.rud; if (gp.thr) sim.leverFine(-gp.thr * dt * 0.6);
    if (gp.b[4] && !gpPrev[4]) sim.flapStep(-1); if (gp.b[5] && !gpPrev[5]) sim.flapStep(1); if (gp.b[3] && !gpPrev[3]) sim.gearToggle(); if (gp.b[2] && !gpPrev[2]) afs.instinctiveDisc();
    gpPrev = gp.b;
  }
  c.stickX = clamp(sx, -1, 1); c.stickY = clamp(sy, -1, 1); c.pedals = clamp(rud, -1, 1);
  // tiller: rudder keys steer the nose wheel up to 70° when slow on the ground
  c.tiller = F.onGround && F.ind.gs < 30 ? clamp(rud, -1, 1) * clamp((30 - F.ind.gs) / 20, 0, 1) : 0;
  if (F.tow) { F.tow.steer = clamp(rud, -1, 1) * 60 * D2R; c.tiller = 0; }
  sim.stickPriority = Math.abs(sx) + Math.abs(sy) > 0.05 ? sim.seat : null;
  // thrust levers (continuous)
  if (!walking && !sh) { const d = ((K.KeyW || K.PageUp) ? 1 : 0) - ((K.KeyS || K.PageDown) ? 1 : 0); if (d) sim.leverFine(d * dt * 0.5); }
  // rudder trim
  if (K.Home) c.rudTrim = clamp(c.rudTrim - dt * 2, -20, 20); if (K.End) c.rudTrim = clamp(c.rudTrim + dt * 2, -20, 20);
  // brakes
  c.brakeL = 0; c.brakeR = 0;
  if (K.KeyB && !sh) { c.brakeL = 1; c.brakeR = 1; }
  if (K.Comma) c.brakeL = 1; if (K.Period) c.brakeR = 1;
  if (gp && gp.b[0]) c.brakeL = c.brakeR = 1;
  // flap auto-retraction 1+F -> 1 above 210 kt
  if (sim.flapLever === 1 && sim.flapConf === 2 && !F.onGround && F.ind.ias > 210) setConf(1);
}

// ---------------- physics ----------------
const PHYS_DT = 1 / 240;
let acc = 0;
function physics(dt) {
  const F = fdm; acc += dt * sim.simRate; let n = 0;
  const fieldElevFt = (fms.dest && F.ind.alt < 15000 && fms.phase !== 'PREFLIGHT' && fms.phase !== 'TAKEOFF' ? fms.dest.elev : fms.origin?.elev) ?? 0;
  const ctx = { oat: 15 + sim.weather.isa - F.pos[1] * 0.0065, inCloud: !!env.inCloud, fieldElevFt };
  while (acc >= PHYS_DT && n < 240) {
    S.update(PHYS_DT, ctx); fms.update(PHYS_DT, F, afs); afs.update(PHYS_DT); F.step(PHYS_DT);
    if (S.events.length) { for (const [name, arg] of S.events) handleEvent(name, arg); S.events.length = 0; }
    acc -= PHYS_DT; n++;
    if (F.crashed) break;
  }
  if (acc > PHYS_DT * 240) acc = 0;
  if (!F.crashed && !inWorld(F.pos[0], F.pos[2], 3000) && !sim.edgeWarned) { sim.edgeWarned = 1; setTimeout(() => (sim.edgeWarned = 0), 8000); toast('Edge of the scenery — turn back', 2500); }
  if (F.onGround) { if (sim.airTime > 4 && F.touchdown && F.touchdown !== sim.lastTD) touchdownReport(F); sim.airTime = 0; } else sim.airTime += dt * sim.simRate;
  if (F.touchdown) sim.lastTD = F.touchdown;
}
function handleEvent(name, arg) {
  sim.sound.event(name, arg);
  if (name === 'refuelDone') { toast('Refuelling complete — ' + (fdm.fob / 1000).toFixed(1) + ' t on board', 3000); sim.groundSvc.fuel = false; }
  if (name === 'callout' && arg) toast(String(arg), 2000);
}
function touchdownReport(F) {
  const td = F.touchdown; const fpm = Math.round(td.sink / FT * 60);
  let near = null, best = 1e9;
  for (const ap of AIRPORTS) for (const a of ap.runways) { const l = toLocal(a, F.pos[0], F.pos[2]); if (Math.abs(l.u) < a.len / 2 + 50 && Math.abs(l.v) < a.wid / 2 + 30) { const d = Math.abs(l.v); if (d < best) { best = d; near = { a, l }; } } }
  let msg = `Touchdown  ${fpm} fpm  ·  ${Math.round(td.v)} KIAS  ·  pitch ${td.pitch.toFixed(1)}°`;
  if (near) { const rel = ((F.attitude.hdg - near.a.hdg + 540) % 360) - 180; const fwd = Math.abs(rel) < 90; const fromThr = (fwd ? near.l.u + near.a.len / 2 : near.a.len / 2 - near.l.u) - (near.a.disp?.[fwd ? 0 : 1] || 0); msg += `\nRunway ${near.a.rwy[fwd ? 0 : 1]} · ${Math.round(fromThr / FT)} ft past threshold · ${Math.abs(near.l.v).toFixed(1)} m ${near.l.v * (fwd ? 1 : -1) > 0 ? 'right' : 'left'} of centreline`; }
  else msg += '\nOff-airport landing';
  msg += '\n' + (fpm < 120 ? 'Greaser' : fpm < 360 ? 'Good' : fpm < 600 ? 'Firm' : 'Hard landing — maintenance inspection required');
  toast(msg, 6000); sim.sound.chirp(Math.min(1, fpm / 600));
}

// ---------------- camera ----------------
const qBase = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
const tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion(), tmpV = new THREE.Vector3(), acQ = new THREE.Quaternion();
let headOff = new THREE.Vector3();
function updateCamera(dt, t) {
  const F = fdm; acQ.set(F.q[0], F.q[1], F.q[2], F.q[3]);
  const acPos = new THREE.Vector3(F.pos[0], F.pos[1], F.pos[2]); const v = sim.view;
  if (v === 'cockpit' || v === 'cabin') {
    camera.near = 0.02;
    let eye = new THREE.Vector3(...(sim.seat ? A350.eyeFO : A350.eyeCapt));
    if (v === 'cabin') {
      const K = sim.keys; const sp = 0.8 * dt; const yaw = look.yaw * D2R;
      const fw = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)), rt = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      if (K.KeyW) freeEye.addScaledVector(fw, sp); if (K.KeyS) freeEye.addScaledVector(fw, -sp); if (K.KeyD) freeEye.addScaledVector(rt, sp); if (K.KeyA) freeEye.addScaledVector(rt, -sp);
      if (K.KeyR) freeEye.y += sp * 0.6; if (K.KeyF) freeEye.y -= sp * 0.6;
      freeEye.x = clamp(freeEye.x, 28.9, 30.85); freeEye.z = clamp(freeEye.z, -0.95, 0.95); freeEye.y = clamp(freeEye.y, 0.9, 1.85);
      eye = freeEye.clone();
    }
    const nzB = F.accelB || [0, 9.81, 0];
    const target = new THREE.Vector3(-(nzB[0] || 0) * 0.0012, -((nzB[1] ?? 9.81) - 9.81) * 0.0015, -(nzB[2] || 0) * 0.0015);
    headOff.lerp(target, Math.min(1, dt * 5));
    const vib = F.onGround ? Math.min(0.004, F.ind.gs * 0.00003) : (F.E[0].n1 > 20 ? 0.00025 : 0);
    eye.add(headOff).add(new THREE.Vector3(Math.sin(t * 87) * vib, Math.sin(t * 71 + 1) * vib, Math.sin(t * 93 + 2) * vib));
    camera.position.copy(eye.applyQuaternion(acQ).add(acPos));
    tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), look.yaw * D2R); tmpQ2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), look.pitch * D2R);
    camera.quaternion.copy(acQ).multiply(tmpQ).multiply(qBase).multiply(tmpQ2);
  } else if (v === 'orbit' || v === 'chase') {
    camera.near = 0.3;
    let yaw = orbit.yaw * D2R; const pit = orbit.pitch * D2R;
    if (v === 'chase') { const hdg = F.attitude.hdg; sim.chaseHdg = sim.chaseHdg == null ? hdg : sim.chaseHdg + ((((hdg - sim.chaseHdg) % 360) + 540) % 360 - 180) * Math.min(1, dt * 2.5); yaw = (sim.chaseHdg + 180) * D2R + (orbit.yaw - 200) * D2R; }
    const d = orbit.dist;
    if (v === 'chase') camera.position.set(acPos.x + Math.sin(yaw) * Math.cos(pit) * d, acPos.y + Math.sin(pit) * d + 8, acPos.z - Math.cos(yaw) * Math.cos(pit) * d);
    else camera.position.set(acPos.x + Math.cos(yaw) * Math.cos(pit) * d, acPos.y + Math.sin(pit) * d, acPos.z + Math.sin(yaw) * Math.cos(pit) * d);
    const gh = heightAt(camera.position.x, camera.position.z) + 1.5; if (camera.position.y < gh) camera.position.y = gh;
    camera.up.set(0, 1, 0); camera.lookAt(acPos.x, acPos.y + 1, acPos.z);
  } else if (v === 'tower') {
    camera.near = 0.5; let best = null, bd = 1e12;
    for (const a of AIRPORTS) { const tp = a.towerPos || new THREE.Vector3(a.towerInfo ? a.towerInfo.x : a.ramp.x, (a.towerInfo ? a.towerInfo.h : 12) + heightAt(a.ramp.x, a.ramp.z), a.towerInfo ? a.towerInfo.z : a.ramp.z); const d = tp.distanceToSquared(acPos); if (d < bd) { bd = d; best = tp; } }
    camera.position.copy(best); camera.up.set(0, 1, 0); camera.lookAt(acPos); camera.fov = clamp(2 * Math.atan(90 / Math.sqrt(bd)) / D2R, 2, 60);
  } else if (v === 'flyby') {
    camera.near = 0.3; const vel = new THREE.Vector3(F.vel[0], F.vel[1], F.vel[2]);
    if (!flyby.pos || flyby.pos.distanceTo(acPos) > 2500 || (vel.length() > 3 && tmpV.copy(flyby.pos).sub(acPos).dot(vel) < -vel.length() * 120)) {
      const ahead = vel.length() > 5 ? vel.clone().normalize().multiplyScalar(Math.max(400, vel.length() * 7)) : new THREE.Vector3(120, 0, 0);
      const side = new THREE.Vector3(-ahead.z, 0, ahead.x).normalize().multiplyScalar(70);
      flyby.pos = acPos.clone().add(ahead).add(side); flyby.pos.y = Math.max(flyby.pos.y + 10, heightAt(flyby.pos.x, flyby.pos.z) + 1.7);
    }
    camera.position.copy(flyby.pos); camera.up.set(0, 1, 0); camera.lookAt(acPos); camera.fov = clamp(2 * Math.atan(45 / Math.max(1, flyby.pos.distanceTo(acPos))) / D2R, 6, 70);
  } else if (v === 'walk') {
    camera.near = 0.05; const K = sim.keys; const sp = (K.ShiftLeft ? 5 : 1.8) * dt; const yaw = walker.yaw * D2R;
    const fw = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), rt = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    if (K.KeyW) walker.pos.addScaledVector(fw, sp); if (K.KeyS) walker.pos.addScaledVector(fw, -sp); if (K.KeyD) walker.pos.addScaledVector(rt, sp); if (K.KeyA) walker.pos.addScaledVector(rt, -sp);
    walker.pos.y = groundQuery(walker.pos.x, walker.pos.z).h + 1.7; camera.position.copy(walker.pos);
    camera.quaternion.setFromEuler(new THREE.Euler(walker.pitch * D2R, walker.yaw * D2R, 0, 'YXZ'));
  }
  camera.updateProjectionMatrix();
}

function syncAircraft(dt, t = 0) {
  const F = fdm; aircraft.position.set(F.pos[0], F.pos[1], F.pos[2]); aircraft.quaternion.set(F.q[0], F.q[1], F.q[2], F.q[3]);
  const inside = sim.view === 'cockpit' || sim.view === 'cabin';
  cockpit.group.visible = inside || sim.view === 'walk';
  animateA350(aircraft, F, S, dt, t, inside);
  if (inside || cockpit.group.visible) cockpit.animate();
  updateGSE();
}

// ---------------- ground services (GPU, fuel, pushback, stairs, doors) ----------------
const gse = { gpu: null, fuel: null, tug: null, stairs: null };
const bodyToWorld = (b) => { const F = fdm; const r = qrot(F.q, b); return [F.pos[0] + r[0], F.pos[1] + r[1], F.pos[2] + r[2]]; };
function placeGse(o, body, yawOff = 0, onGroundY = true) {
  const p = bodyToWorld(body); o.position.set(p[0], onGroundY ? groundQuery(p[0], p[2]).h : p[1], p[2]);
  o.rotation.set(0, (-fdm.attitude.hdg + 90) * D2R + yawOff, 0);
}
function makeGse(kind) { try { const o = kind === 'stairs' ? GSE.stairs(4.75) : GSE[kind](); scene.add(o); return o; } catch (e) { console.warn('GSE', kind, e); return null; } }
function updateGSE() {
  const g = sim.groundSvc;
  for (const k of Object.keys(gse)) { const want = g[k]; if (want && !gse[k]) gse[k] = makeGse({ gpu: 'gpu', fuel: 'jet', tug: 'tug', stairs: 'stairs' }[k]); if (gse[k]) gse[k].visible = !!want; }
  if (gse.gpu?.visible) placeGse(gse.gpu, [26, 0, 4.5], Math.PI / 2);
  if (gse.fuel?.visible) placeGse(gse.fuel, [3, 0, 16], 0);
  if (gse.stairs?.visible) placeGse(gse.stairs, [21.0, 0, -4.6], -Math.PI / 2);
  if (gse.tug?.visible) { const st = fdm.tow?.steer || 0; placeGse(gse.tug, [A350.noseX + 6, 0, 0], Math.PI - st); }
}
function cancelServices(quiet = false) {
  const g = sim.groundSvc; g.gpu = g.fuel = g.tug = g.stairs = false; fdm.tow = null; S.ped.towing = false; S.refuel = null;
  if (!quiet) renderGS();
}
function toggleGS(force) { const p = $('gsPanel'); const on = force ?? p.classList.contains('hidden'); p.classList.toggle('hidden', !on); if (on) renderGS(); }
function renderGS() {
  const list = $('gsList'); if (!list) return; const g = sim.groundSvc; const F = fdm;
  const stopped = F.onGround && F.ind.gs < 1;
  const items = [
    ['Ground power unit (GPU)', g.gpu ? 'DISCONNECT' : 'CONNECT', () => { if (!stopped) return toast('Aircraft must be parked'); g.gpu = !g.gpu; S.gpu = g.gpu; if (!g.gpu) { S.ov.EXT1 = S.ov.EXT2 = false; } toast(g.gpu ? 'GPU connected — EXT 1/2 AVAIL on the overhead ELEC panel' : 'GPU disconnected'); }],
    ['Refuel to block fuel', g.fuel ? 'STOP' : 'START', () => { if (!stopped) return toast('Aircraft must be parked'); if (g.fuel) { g.fuel = false; S.refuel = null; return; } const tgt = Math.max(fdm.fob + 1000, (fms.block ?? (+$('fuel').value * 1000))); g.fuel = true; S.refuel = { target: clamp(tgt, 0, A350.fuelCap) }; toast('Fuel truck connected — refuelling to ' + (S.refuel.target / 1000).toFixed(1) + ' t'); }],
    ['Passenger stairs / L1 door', g.stairs ? 'REMOVE' : 'POSITION', () => { if (!stopped) return toast('Aircraft must be parked'); g.stairs = !g.stairs; S.doors.L1 = g.stairs; }],
    ['Cargo doors (FWD / AFT)', S.doors.FWDCARGO ? 'CLOSE' : 'OPEN', () => { if (!stopped) return; const o = !S.doors.FWDCARGO; S.doors.FWDCARGO = S.doors.AFTCARGO = o; }],
    ['Pushback tug', g.tug ? (F.tow ? 'STOP PUSH' : 'DISCONNECT') : 'CONNECT', () => {
      if (!F.onGround) return;
      if (!g.tug) { if (F.ind.gs > 1) return toast('Stop first'); g.tug = true; S.ped.towing = true; toast('Tug connected — NW STRG DISC. Release the parking brake, then START PUSH'); }
      else if (F.tow) { F.tow = null; toast('Pushback stopped — set parking brake'); }
      else { g.tug = false; S.ped.towing = false; toast('Tug disconnected'); }
    }],
    ['Push back (Z / X steer the tug)', F.tow ? 'PUSHING' : 'START PUSH', () => { if (!g.tug) return toast('Connect the tug first'); if (F.ctrl.parkBrake) return toast('Release the parking brake (P)'); if (S.doors.L1 || g.stairs) return toast('Remove stairs and close the doors first'); F.tow = { v: -1.6, steer: 0 }; g.gpu = false; S.gpu = false; toast('Pushing back… Z / X steer, STOP PUSH when clear'); }],
    ['Cancel all services', 'CANCEL', () => cancelServices()],
  ];
  list.replaceChildren(...items.map(([label, btn, fn]) => { const row = document.createElement('div'); row.className = 'gsRow'; const s = document.createElement('span'); s.textContent = label; const b = document.createElement('button'); b.type = 'button'; b.textContent = btn; b.onclick = () => { fn(); renderGS(); }; row.append(s, b); return row; }));
}
$('gsChip')?.addEventListener('click', () => toggleGS());
$('gsClose')?.addEventListener('click', () => toggleGS(false));

// ---------------- HUD ----------------
const hudEls = {}; for (const id of ['dIas', 'dGs', 'dAlt', 'dAgl', 'dVs', 'dHdg', 'dAoa', 'dG', 'dN1', 'dThr', 'dFma', 'dFlap', 'dTrim', 'dWind']) hudEls[id] = $(id);
function updateHUD() {
  const F = fdm, a = F.attitude; const set = (k, v) => { const el = hudEls[k]; if (el && el._v !== v) { el.textContent = v; el._v = v; } };
  set('dIas', Math.round(F.ind.ias)); set('dGs', Math.round(F.ind.gs)); set('dAlt', Math.round(F.ind.alt).toLocaleString()); set('dAgl', Math.round(F.ra / FT).toLocaleString());
  set('dVs', (F.ind.vsi > 0 ? '+' : '') + Math.round(F.ind.vsi / 10) * 10); set('dHdg', String(Math.round(a.hdg) % 360).padStart(3, '0'));
  set('dAoa', F.ind.ias > 40 ? ((F.alpha || 0) / D2R).toFixed(1) : '—'); set('dG', (F.nz || 1).toFixed(2));
  set('dN1', Math.round(F.E[0].n1) + ' / ' + Math.round(F.E[1].n1)); set('dThr', sim.tlaName(0));
  const m = afs.fma(); set('dFma', [m.athr, m.vert, m.lat].filter(Boolean).join(' · ') || '—');
  set('dFlap', CONFS[S.confIdx()].id); set('dTrim', (F.surf.ths >= 0 ? 'UP ' : 'DN ') + Math.abs(F.surf.ths).toFixed(1)); set('dWind', `${String(sim.weather.windDir).padStart(3, '0')}/${sim.weather.windKt}`);
  $('apChip').classList.toggle('hidden', !afs.apOn); if (afs.apOn) $('apChip').textContent = 'AP' + (afs.ap[0] ? '1' : '') + (afs.ap[0] && afs.ap[1] ? '+' : '') + (afs.ap[1] ? '2' : '') + ' ' + (m.lat || '') + ' ' + (m.vert || '');
  $('brakeChip').classList.toggle('hidden', !F.ctrl.parkBrake);
  $('simRate').textContent = sim.simRate + '×';
  $('imcChip').classList.toggle('hidden', !env.inCloud);
  $('warnChip').classList.toggle('hidden', !S.masterWarn && !S.masterCaut); if (S.masterWarn || S.masterCaut) { $('warnChip').textContent = (S.masterWarn ? 'MASTER WARN' : 'MASTER CAUT') + ' · ' + (S.activeAlerts?.[0]?.title || ''); $('warnChip').className = 'chip ' + (S.masterWarn ? 'warn' : 'caut'); }
}
function updateTip() {
  const tip = $('tip'); if (look.dragging) { tip.classList.add('hidden'); return; }
  const h = panelHit(mouse.x, mouse.y);
  if (h && h.tip) { tip.textContent = typeof h.tip === 'function' ? h.tip() : h.tip; tip.style.left = mouse.x + 'px'; tip.style.top = mouse.y + 'px'; tip.classList.remove('hidden'); canvas.style.cursor = 'pointer'; }
  else { tip.classList.add('hidden'); canvas.style.cursor = h ? 'pointer' : mouse.yoke ? 'crosshair' : 'default'; }
}

function toggleATC(force) {
  if (!sim.atc.enabled) { toast('ATC communications are disabled in setup'); return; }
  const panel = $('atcPanel'); const on = force ?? panel.classList.contains('hidden'); panel.classList.toggle('hidden', !on); if (on) updateATCPanel();
}
function updateATCPanel() {
  const atc = sim.atc; $('atcStatus').textContent = atc.status; $('atcSpeaker').textContent = atc.speaker; $('atcMessage').textContent = atc.transmission;
  const log = $('atcLog'); log.innerHTML = atc.log.map((l) => `<div class="atcLine ${l.speaker === 'YOU' ? 'you' : l.ai ? 'ai' : ''}"><b>${l.speaker}</b><span>${l.text}</span></div>`).join(''); log.scrollTop = 0;
  sim.atcLog = atc.log;
  const opts = $('atcOptions'); opts.replaceChildren();
  for (const o of atc.options) { const b = document.createElement('button'); b.type = 'button'; b.textContent = o.label; b.onclick = () => { atc.act(o.action, sim); updateATCPanel(); }; opts.appendChild(b); }
}
$('atcClose').onclick = () => toggleATC(false);
let atcSeen = 0;

// ---------------- map ----------------
const mapC = $('map'), miniC = $('mini');
const mapView = { mpp: 40, center: null, follow: true, drag: null };
function toggleMap(force) { const on = force ?? $('mapWrap').classList.contains('hidden'); $('mapWrap').classList.toggle('hidden', !on); if (on) { mapC.width = window.innerWidth * Math.min(2, devicePixelRatio); mapC.height = window.innerHeight * Math.min(2, devicePixelRatio); } }
mapC.addEventListener('pointerdown', (e) => { mapView.drag = [e.clientX, e.clientY]; mapC.style.cursor = 'grabbing'; });
window.addEventListener('pointerup', () => { mapView.drag = null; mapC.style.cursor = 'grab'; });
mapC.addEventListener('pointermove', (e) => { if (!mapView.drag) return; const dx = e.clientX - mapView.drag[0], dy = e.clientY - mapView.drag[1]; mapView.drag = [e.clientX, e.clientY]; if (!mapView.center) mapView.center = [fdm.pos[0], fdm.pos[2]]; mapView.follow = false; mapView.center[0] -= dx * mapView.mpp; mapView.center[1] -= dy * mapView.mpp; });
mapC.addEventListener('wheel', (e) => { e.preventDefault(); mapView.mpp = clamp(mapView.mpp * (1 + Math.sign(e.deltaY) * 0.15), 3, 200); }, { passive: false });
$('mapCenter').onclick = () => { mapView.follow = true; mapView.center = null; };
$('mapRot').onclick = () => { mmap.northUp = !mmap.northUp; $('mapRot').textContent = mmap.northUp ? 'Follow' : 'North up'; };
function drawMaps() {
  if (!mmap) return; mmap.build(3);
  if (!$('mapWrap').classList.contains('hidden')) {
    const g = mapC.getContext('2d'); const s = mapC.width / window.innerWidth; g.setTransform(s, 0, 0, s, 0, 0);
    mmap.draw(g, window.innerWidth, window.innerHeight, sim, { mpp: mapView.mpp, center: mapView.follow ? null : mapView.center });
    const F = fdm; let near = null, bd = 1e12; for (const a of AIRPORTS) { const d = Math.hypot(a.x - F.pos[0], a.z - F.pos[2]); if (d < bd) { bd = d; near = a; } }
    const brg = (Math.atan2(near.x - F.pos[0], -(near.z - F.pos[2])) / D2R + 360) % 360;
    $('mapInfo').textContent = `ALT ${Math.round(F.ind.alt)} ft   GS ${Math.round(F.ind.gs)} kt   HDG ${String(Math.round(F.attitude.hdg)).padStart(3, '0')}°\n${near.icao}  ${String(Math.round(brg)).padStart(3, '0')}° / ${(bd / NM).toFixed(1)} NM\nF-PLN ${fms.origin?.icao || '----'} → ${fms.dest?.icao || '----'}  · ${fms.phase}`;
  }
  if (!miniC.classList.contains('hidden')) { const g = miniC.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.save(); g.beginPath(); g.arc(220, 220, 220, 0, Math.PI * 2); g.clip(); mmap.draw(g, 440, 440, sim, { mpp: 60, mini: true, heading: fdm.attitude.hdg }); g.restore(); }
}

// ---------------- menu / pause / crash ----------------
function showMenu(on) {
  $('menu').classList.toggle('hidden', !on);
  if (on) { $('setup').classList.remove('hidden'); $('fly').textContent = sim.started ? 'Apply & restart' : 'Fly'; if (sim.started && !$('resume')) { const b = document.createElement('button'); b.id = 'resume'; b.type = 'button'; b.textContent = 'Resume'; b.onclick = () => { showMenu(false); togglePause(false); }; $('fly').after(b); } }
}
function togglePause(force) { sim.paused = force ?? !sim.paused; $('pauseChip').classList.toggle('hidden', !sim.paused); }
$('perfChip')?.addEventListener('click', () => $('fps').classList.toggle('hidden'));
$('fly').onclick = () => {
  sim.sound.start();
  const s = readSetup(); const R = reserveGate(s);
  const ramp = R.stage === 'ramp' || R.stage === 'taxi';
  if (ramp && airports?.loaded?.has(R.dep) && !airport(R.dep)._builtReserved) { airport(R.dep)._builtReserved = true; airports.rebuild(R.dep); }
  applySetup(s);
  showMenu(false); $('hud').classList.remove('hidden'); $('crash').classList.add('hidden');
  sim.started = true; togglePause(false); setView(sim.view === 'walk' ? 'cockpit' : sim.view);
  const rt = `${R.dep} ${R.depRwy} → ${R.dest} ${R.arrRwy}`;
  const msg = {
    cold: `${rt}. Parked at the gate, cold & dark. Overhead: BAT 1/2, EXT 1/2 — or Shift+E for auto-start. J = ground services, ? = help.`,
    running: `${rt}. At the gate with both engines running. J = pushback, then Shift+G to call Ground for taxi.`,
    taxi: `${rt}. Pushed back, CONF 1+F, taxi clearance received — read it back (Shift+G), release the brake (P) and follow the taxi line (T).`,
    runway: `${rt}. Lined up, engines running, CONF 1+F. Release the brake (P), thrust to FLX (Shift+W twice), rotate at VR.`,
    climb: `${rt}. Climbing out with AP1 and managed NAV to ${'FL' + String(Math.round(R.crzFt / 100)).padStart(3, '0')}. Shift+G for Departure.`,
    cruise: `${rt}. En route at ${R.crzFt >= 18000 ? 'FL' + Math.round(R.crzFt / 100) : R.crzFt + ' ft'}, AP1 on, managed NAV along the F-PLN.`,
    final: R.arrILS ? `${rt}. Established inbound, AP1+2 with APPR armed — autoland, or press Q to hand-fly.` : `${rt}. On a visual final, CONF FULL — hand-fly or use the FCU.`,
  }[R.state === 'running' ? 'running' : R.stage === 'ramp' ? 'cold' : R.stage];
  toast(msg, 8000); canvas.focus?.();
  if (R.stage === 'ramp' && R.state === 'cold') { sim.groundSvc.gpu = true; sim.groundSvc.stairs = true; S.doors.L1 = true; }
};
$('showHelp').onclick = () => setHelp(true);
$('helpClose').onclick = () => setHelp(false);
let helpPaused = false, ctlUI = null;
function setHelp(on) {
  const el = $('help');
  if (on) { if (!ctlUI) ctlUI = buildControlsUI($('ctlSettings'), { toast, onChange: updateKeyNote }); updateKeyNote(); el.classList.remove('hidden'); if (sim.started && !sim.paused) { togglePause(true); helpPaused = true; } sim.keys = {}; }
  else { ctlUI?.stop(); el.classList.add('hidden'); if (helpPaused) { helpPaused = false; if ($('menu').classList.contains('hidden')) togglePause(false); } canvas.focus?.(); }
}
function updateKeyNote() { const n = changedCount(); const note = $('keyNote'); if (note) note.textContent = n ? `${n} key${n > 1 ? 's' : ''} customised — the list shows the defaults.` : 'Simulation paused while this window is open.'; }
for (const b of document.querySelectorAll('#help .helpTab')) b.addEventListener('click', () => {
  for (const x of document.querySelectorAll('#help .helpTab')) x.classList.toggle('on', x === b);
  $('helpRef').classList.toggle('hidden', b.dataset.tab !== 'ref'); $('ctlSettings').classList.toggle('hidden', b.dataset.tab !== 'ctl');
  if (b.dataset.tab === 'ctl' && !ctlUI) ctlUI = buildControlsUI($('ctlSettings'), { toast, onChange: updateKeyNote });
});
$('retry').onclick = () => { applySetup(lastSetup); $('crash').classList.add('hidden'); togglePause(false); };
$('toMenu').onclick = () => { $('crash').classList.add('hidden'); showMenu(true); };
$('cklBtn').onclick = () => { S.eclOpen = !S.eclOpen; };

// ---------------- main loop ----------------
const MANUAL = new URLSearchParams(location.search).has('manual');
let last = performance.now(), simT = 0, panelT = 0, panelIdx = 0;
const camPos = new THREE.Vector3();
const PANEL_ORDER = ['glare', 'ped', 'ovhd', 'gear'];
function frame(dtReal) {
  const F = fdm; const dt = Math.min(0.05, dtReal);
  if (sim.started) updateTaxiMap(sim);
  if (sim.started && !sim.paused) {
    updateControls(dt); runAuto(dt * sim.simRate);
    const gust = sim.weather.turb * 0.25 * (Math.sin(simT * 0.7) * 0.5 + Math.sin(simT * 1.9 + 1) * 0.3 + Math.sin(simT * 0.23) * 0.2); F.env.gustFactor = gust;
    physics(dt);
    sim.atc.update(sim, dt * sim.simRate);
    sim.tower?.update(sim, dt * sim.simRate);
    { const l0 = sim.atc.log[0]; if (l0 && l0.id !== atcSeen) { atcSeen = l0.id; if (!l0.ai && $('atcPanel').classList.contains('hidden')) sim.atcMsg = true; } }
    updateTaxiGuide(dt);
    simT += dt * sim.simRate; sim.timeOfDay = (lastSetup?.tod ?? 10) + simT / 3600;
    if (F.crashed && !sim.crashShown) { sim.crashShown = true; $('crashWhy').textContent = F.crashed; $('crash').classList.remove('hidden'); }
    mmap?.addTrack(F.pos);
    if (F.tow && sim.groundSvc.tug && F.ind.gs < 0.05 && !F.tow) sim.groundSvc.tug = false;
  }
  const t = performance.now() / 1000;
  syncAircraft(dt, t);
  updateCamera(dt, t);
  if (sim.camOverride) { const o = sim.camOverride; camera.position.set(o.p[0], o.p[1], o.p[2]); camera.lookAt(o.t[0], o.t[1], o.t[2]); }
  camPos.copy(camera.position);
  const agl = camPos.y - heightAt(camPos.x, camPos.z); const vel = F.vel || [0, 0, 0];
  const ahead = { x: camPos.x + (vel[0] || 0) * PREFETCH_S, z: camPos.z + (vel[2] || 0) * PREFETCH_S };
  if (airports?.update && (airportStreamTick = (airportStreamTick + 1) % 30) === 0) airports.update(camPos, ahead);
  if (terrain) { terrain.update(camPos, agl, 6, false, { x: camPos.x + (vel[0] || 0) * 20, y: camPos.y + (vel[1] || 0) * 20, z: camPos.z + (vel[2] || 0) * 20 }); if (terrainMat) terrainMat.userData.uniforms.uCam.value.copy(camPos); }
  if (forest && rocks) { forest.update(camPos, 3); rocks.update(camPos, 3); }
  if (grass) grass.update(camPos, agl); if (ground) ground.update(camPos, agl);
  (orthoMgr ||= new OrthoManager(renderer)).update(camPos);
  if (blades) blades.update(camPos, agl, t, sim.windVec, camera); if (crops) crops.update(camPos, agl);
  const wdt = sim.paused ? 0 : dt * (sim.started ? sim.simRate : 1);
  if (life) life.update(camPos, wdt, t); if (scenery) scenery.update(camPos);
  if (traffic) { traffic.setNight(sim.night); traffic.update(wdt, camPos); }
  env.update(camera, new THREE.Vector3(F.pos[0], F.pos[1], F.pos[2]), simT, dt);
  if (airports) { airports.updateLights(camPos, sim.night, t); airports.updateServices?.(wdt, camPos, t); }
  tickGSE(t, sim.night);
  const w = sim.windVec || [0, 0, 0]; const ws = Math.hypot(w[0], w[2]);
  for (const a of AIRPORTS) for (const sock of a.windsocks || (a.windsock ? [a.windsock] : [])) { const dir = Math.atan2(-w[2], w[0]); sock.rotation.set(0, dir + Math.sin(t * 2.3) * 0.08 * Math.min(1, ws / 3), -(1 - Math.min(1, ws / 7.7)) * 1.2 + Math.sin(t * 3.1) * 0.03); }
  // flight deck textures: displays + panels, round robin
  const inside = sim.view === 'cockpit' || sim.view === 'cabin';
  panelT += dt;
  if (sim.displays && (inside || !sim.started)) {
    const rate = perf.rating === 'poor' ? 1 / 10 : perf.rating === 'ok' ? 1 / 16 : 1 / 24;
    if (panelT > rate) {
      panelT = 0;
      sim.displays.update(t, perf.rating === 'poor' ? 2 : 3);
      const P = sim.panels[PANEL_ORDER[panelIdx = (panelIdx + 1) % PANEL_ORDER.length]]; P.draw(t); if (P.tex) P.tex.needsUpdate = true;
      if (PANEL_ORDER[panelIdx] !== 'glare') { sim.panels.glare.draw(t); if (sim.panels.glare.tex) sim.panels.glare.tex.needsUpdate = true; }
    }
  }
  if (inside) updateTip(); else $('tip').classList.add('hidden');
  sim.sound.minimums = fms.appr.radio || null;
  sim.sound.update(F, S, sim.view, sim.simRate, dt);
  if (mmap && !mmap.done) mmap.build(2);
  if (sim.started) { updateHUD(); drawMaps(); if (!$('atcPanel').classList.contains('hidden')) updateATCPanel(); if (!$('gsPanel').classList.contains('hidden') && (sim._gsT = (sim._gsT || 0) + 1) % 20 === 0) renderGS(); }
  syncCesiumCamera(camera);
  if ((sim._cq = (sim._cq || 0) + 1) % 60 === 0) setCesiumQuality(perf.auto ? perf.scale : 1);
  renderer.shadowMap.needsUpdate = perf.shadowThisFrame();
  if (!sim.noRender) renderer.render(scene, camera);
  perf.frame(dtReal, { extra: terrain ? `tiles ${terrain.visibleCount}` : '' });
}
let orthoMgr = null;
sim.frame = frame;

// ---------------- taxi line (magenta guide on the real taxiways) ----------------
var taxiLine = null;
function buildTaxiLine() {
  if (taxiLine) { scene.remove(taxiLine); taxiLine.traverse((o) => o.geometry?.dispose()); taxiLine = null; }
  $('taxiBtn').classList.toggle('hidden', !sim.taxi); $('taxiChip').classList.add('hidden');
  if (!sim.taxi) return;
  const P = sim.taxi.route.pts, pts = [];
  for (let k = 1; k < P.length; k++) { const a = P[k - 1], b = P[k], L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L / 4)); for (let i = k === 1 ? 0 : 1; i <= n; i++) pts.push({ x: a.x + (b.x - a.x) * i / n, z: a.z + (b.z - a.z) * i / n }); }
  const yOf = (x, z) => groundQuery(x, z).h + 0.08; const pos = [], idx = [], W = 0.5;
  pts.forEach((p, i) => { const q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)]; let dx = q.x - o.x, dz = q.z - o.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; const y = yOf(p.x, p.z); pos.push(p.x - dz * W, y, p.z + dx * W, p.x + dz * W, y, p.z - dx * W); if (i) { const j = i * 2; idx.push(j - 2, j - 1, j, j - 1, j + 1, j); } });
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
  taxiLine = new THREE.Group(); taxiLine.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff2bd6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, depthWrite: false, transparent: true, opacity: 0.92 })));
  taxiLine.renderOrder = 2; taxiLine.traverse((o) => { o.renderOrder = 2; }); taxiLine.visible = sim.taxi.show; scene.add(taxiLine);
  $('taxiBtn').classList.toggle('on', sim.taxi.show);
}
function toggleTaxiLine() {
  if (!sim.taxi) { toast('No taxi route — taxi lines are drawn from the gate to the departure runway'); return; }
  sim.taxi.show = !sim.taxi.show; if (taxiLine) taxiLine.visible = sim.taxi.show; $('taxiBtn').classList.toggle('on', sim.taxi.show); $('taxiChip').classList.toggle('hidden', !sim.taxi.show);
  toast(sim.taxi.show ? `Taxi line ON — Rwy ${sim.taxi.route.rwy} via ${sim.taxi.route.viaText}` : 'Taxi line OFF');
}
$('taxiBtn').onclick = toggleTaxiLine;
$('tmapBtn').onclick = () => { $('tmapBtn').classList.toggle('on', toggleTaxiMap(undefined, sim)); };
var taxiT = 0;
function updateTaxiGuide(dt) {
  const tx = sim.taxi; if (!tx) return; taxiT += dt; if (taxiT < 0.4) return; taxiT = 0;
  const F = fdm, chip = $('taxiChip'); if (!F.onGround || tx.done) { chip.classList.add('hidden'); return; }
  const p = routeProgress(tx.route, F.pos[0], F.pos[2]);
  const brg = (Math.atan2(p.tgt.x - F.pos[0], -(p.tgt.z - F.pos[2])) / D2R + 360) % 360; const rel = ((brg - F.attitude.hdg + 540) % 360) - 180;
  const turn = Math.abs(rel) < 12 ? 'ahead' : rel < 0 ? `turn left ${Math.round(-rel)}°` : `turn right ${Math.round(rel)}°`;
  const distTxt = p.rem > 1000 ? (p.rem / NM).toFixed(1) + ' NM' : Math.round(p.rem / FT / 10) * 10 + ' ft';
  chip.textContent = p.rem < 60 ? `HOLD SHORT RWY ${tx.route.rwy}` : `TAXI RWY ${tx.route.rwy} · ${distTxt} · ${p.off > 25 ? 'off route — ' : ''}${turn}`;
  chip.classList.toggle('hidden', !tx.show);
  if (p.rem < 60 && F.ind.gs > 30) { tx.done = true; tx.show = false; if (taxiLine) taxiLine.visible = false; chip.classList.add('hidden'); $('taxiBtn').classList.remove('on'); }
}

function loop() { const now = performance.now(); const dt = (now - last) / 1000; last = now; if (sim.ready && !MANUAL) frame(dt); requestAnimationFrame(loop); }
window.addEventListener('resize', () => { renderer.setSize(window.innerWidth, window.innerHeight); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); if (!$('mapWrap').classList.contains('hidden')) toggleMap(true); });

// test hooks
window.advanceTime = (ms) => { const steps = Math.max(1, Math.round(ms / (1000 / 60))); for (let i = 0; i < steps; i++) frame(1 / 60); };
window.render_game_to_text = () => {
  const F = fdm, a = F.attitude; const m = afs.fma();
  return JSON.stringify({
    aircraft: 'A350-1000', coords: 'world x=east m, z=south m, y=up m (MSL)', ready: !!sim.ready, started: sim.started, paused: sim.paused, view: sim.view,
    pos: F.pos.map((v) => Math.round(v * 10) / 10), raFt: Math.round((F.ra || 0) / FT), ias: Math.round(F.ind.ias), altFt: Math.round(F.ind.alt), vsFpm: Math.round(F.ind.vsi),
    hdg: Math.round(a.hdg), pitch: +a.pitch.toFixed(1), roll: +a.roll.toFixed(1), n1: F.E.map((e) => Math.round(e.n1)), engines: F.E.map((e) => !!e.running), onGround: !!F.onGround,
    tla: F.ctrl.tla.map((v) => +v.toFixed(2)), conf: CONFS[S.confIdx()].id, gear: +F.gear.pos.toFixed(2), crashed: F.crashed, ap: afs.ap, fma: m, phase: fms.phase,
    power: { ac: S.acPowered, dc: S.dcPowered }, masterWarn: S.masterWarn, alerts: (S.activeAlerts || []).map((x) => x.title),
  });
};
requestAnimationFrame(loop);
