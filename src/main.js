// Skyhawk — main loop, cameras, input, UI.
import * as THREE from 'three';
import { FDM, KT, FT, C172, C152 } from './fdm.js?v=20261123g';
import { qrot } from './math.js';
import { groundQuery, heightAt, AIRPORTS, NAVAIDS, fromLocal, toLocal, WATER_LEVEL, findRunway, runwayEnd, inWorld, waterFrac, ll2w } from './geo.js';
import { createTerrainMaterial, Terrain } from './terrain.js?v=20261123g';
import { OrthoManager } from './ortho.js?v=20261123g';
let orthoMgr = null;
import { GroundOverlay } from './ground.js?v=20261123g';
import { GrassBlades, CropField } from './blades.js?v=20261123g';
import { buildAircraft, animateAircraft } from './aircraft.js?v=20261123g';
import { Panel } from './panel.js?v=20261123g';
import { Avionics, ILS } from './avionics.js?v=20261123g';
import { Environment } from './env.js';
import { buildAirports, RockField, Forest, GrassField } from './world.js';
import { Scenery } from './scenery.js?v=20261123g';
import { Traffic } from './traffic.js?v=20261124d';
import { Tower } from './tower.js?v=20261124d';
import { buildLife } from './life.js?v=20261123g';
import { MovingMap } from './map.js?v=20261123g';
import { departureRoute, routeProgress } from './taxi.js?v=20261124d';
import { toggleTaxiMap, updateTaxiMap, taxiMapOpen, taxiChart } from './taximap.js?v=20261124d';
import { Checklist } from './checklist.js?v=20261123g';
import { Sound } from './audio.js';
import { setAniso } from './textures.js';
import { ATC } from './atc.js?v=20261124d';
import { PlayerGroundServices } from './groundservices.js?v=20261124b';
import { tickGSE } from './gse.js?v=20261124b';
import { remap, buildControlsUI, changedCount, mouseSettings, mouseAxis } from './controls.js?v=20261123g';
import { PerfMonitor } from './perf.js?v=20261123g';
import { initCesium, syncCesiumCamera, getCesiumElevationWorld, warmCesiumTerrain, setCesiumQuality } from './cesium.js?v=20261123g';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const D2R = Math.PI / 180;
const INHG = 3386.389;

// ---------------- renderer / scene ----------------
const canvas = $('gl');
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
} catch (error) {
  console.error('Could not initialize WebGL.', error);
}
if (renderer) {
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.5;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; // refreshed explicitly each frame (or every other frame when the perf governor asks)
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  setAniso(Math.min(16, renderer.capabilities.getMaxAnisotropy()));
}
const perf = renderer ? new PerfMonitor({ renderer, chip: document.getElementById('perfChip'), detail: document.getElementById('fps') }) : null;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.02, 90000);
scene.add(camera);

const sim = {
  fdm: new FDM(), av: new Avionics(), panel: null, keys: {}, view: 'cockpit', timeOfDay: 10, simRate: 1, paused: true, started: false,
  weather: { windDir: 250, windKt: 8, turb: 0.25, cover: 0.45, baseFt: 4500, visKm: 40, qnhInHg: 30.02, isa: 5 }, sound: new Sound(),
  groundServices: { active: false, airport: null },
};
window.sim = sim; sim.scene = scene; sim.renderer = renderer; sim.perf = perf;
sim.atc = new ATC();
const f = () => sim.fdm;
sim.fdm.env.ground = groundQuery;
sim.ndb = NAVAIDS.find((n) => n.type === 'NDB');

function cesiumGroundQuery(x, z, y) {
  const local = groundQuery(x, z, y);
  const cesiumHeight = getCesiumElevationWorld(x, z);
  if (!Number.isFinite(cesiumHeight)) return local;
  if (local.road?.ys) return local; // bridge decks come from the local road data
  const surface = waterFrac(x, z) > 0.6 && cesiumHeight < 3
    ? 'water'
    : local.surface === 'runway'
      ? 'runway'
      : local.surface === 'road'
        ? 'runway'
        : 'grass';
  return {
    h: surface === 'water' ? WATER_LEVEL : cesiumHeight,
    n: local.n,
    surface,
  };
}

// ---- Light Edition: only load the area around the aircraft ----
const LIGHT_RADIUS = 8000;            // m of terrain built/drawn around the camera
const LIGHT_AIRPORT_LOAD = LIGHT_RADIUS + 2500;   // airports whose center is within this get built
const LIGHT_AIRPORT_UNLOAD = LIGHT_AIRPORT_LOAD + 4000; // ...and freed once beyond this (hysteresis)

// Heavy Edition streaming ranges, modelled on FlightGear's LOD bands (detailed objects ~1.5 km, rough ~7.5 km,
// bare terrain ~30 km) and X-Plane's "build the clutter near you, drop it behind you" loader.
const HEAVY_RADIUS = 30000;
const HEAVY_AIRPORT_LOAD = 16000, HEAVY_AIRPORT_UNLOAD = 22000;
const PREFETCH_S = 45; // look this many seconds ahead along the flight path when deciding what to load

// Streams airports (runways, buildings, lights, parked aircraft) in and out around the aircraft.
// One airport is built at a time, nearest first (also counting where the aircraft will be in PREFETCH_S seconds),
// so loading never stalls the frame for long; airports far behind are disposed.
class LocalAirports {
  constructor(scene, buildAircraftFn, opts = {}) {
    this.scene = scene; this.buildAircraftFn = buildAircraftFn;
    this.loadR = opts.load ?? LIGHT_AIRPORT_LOAD; this.unloadR = opts.unload ?? LIGHT_AIRPORT_UNLOAD;
    this.elevFn = opts.elevFn || null; this.warm = opts.warm || null;
    this.loaded = new Map(); this.loading = new Map(); this.busy = null;
  }
  // pos: camera position; returns the job for the nearest airport that is (being) loaded, if any
  update(pos, ahead = null) {
    const want = [];
    for (const a of AIRPORTS) {
      const d = Math.hypot(a.arp[0] - pos.x, a.arp[1] - pos.z);
      const da = ahead ? Math.hypot(a.arp[0] - ahead.x, a.arp[1] - ahead.z) : d;
      const dm = Math.min(d, da);
      if (dm < this.loadR && !this.loaded.has(a.icao)) want.push([dm, a]);
      else if (d > this.unloadR && (!ahead || da > this.unloadR) && this.loaded.has(a.icao)) {
        this.loaded.get(a.icao).dispose();
        this.loaded.delete(a.icao);
      }
    }
    want.sort((x, y) => x[0] - y[0]);
    if (!this.busy && want.length) {
      const a = want[0][1];
      this.busy = (async () => {
        try {
          if (this.warm) await this.warm(a);
          const r = await buildAirports(this.scene, null, this.buildAircraftFn, this.elevFn, [a]);
          this.loaded.set(a.icao, r);
        } catch (e) { console.warn('Airport load failed', a.icao, e); }
        this.busy = null;
      })();
    }
    this.pendingCount = want.length;
    return this.busy || Promise.resolve();
  }
  // load everything currently wanted (used during the loading screen)
  async fill(pos, max = 99) { for (let i = 0; i < max; i++) { await this.update(pos); if (!this.pendingCount && !this.busy) break; } }
  updateLights(camPos, night, t) { for (const r of this.loaded.values()) r.updateLights(camPos, night, t); }
  updateServices(dt, camPos, t) { for (const r of this.loaded.values()) r.updateServices?.(dt, camPos, t); }
}

let airportStreamTick = 0;
let ground = null, blades = null, crops = null;
let env, terrain, terrainMat, aircraft, airports, rocks, forest, grass, town, life, mmap, scenery, traffic;
const loadBar = $('loadBar'), loadText = $('loadText');
let loadMode = null;
const progress = (p, t) => { loadBar.style.width = Math.round(p * 100) + '%'; loadText.textContent = t; };

async function init() {
  if (!renderer) throw new Error('WebGL is unavailable in this browser or device.');
  progress(0.03, 'Sky, sun and atmosphere…');
  env = new Environment(renderer, scene);
  env.setTime(sim.timeOfDay);
  env.sky.visible = true;
  let cesiumViewer = null;
  if (loadMode === 'heavy') {
    progress(0.08, 'Connecting to Cesium ion…');
    cesiumViewer = await initCesium();
    env.sky.visible = !cesiumViewer;
    if (cesiumViewer) {
      sim.fdm.env.ground = cesiumGroundQuery;
      // elevations are now sampled per airport as it streams in (not all up front)
    }
    progress(0.36, 'Loading World Terrain, aerial imagery and 3D buildings…');
  } else {
    progress(0.36, 'Loading local terrain and flight systems…');
  }
  progress(0.38, 'Loading terrain textures…');
  const useLocalScenery = loadMode !== 'heavy' || !cesiumViewer;
  if (!useLocalScenery) {
    terrainMat = null;
    terrain = null;
  } else {
    if (loadMode === 'light') {
      ground = new GroundOverlay();
      if (!(await ground.init('./data/'))) ground = null;
      sim.ground = ground;
    }
    terrainMat = await createTerrainMaterial(
      (p) => progress(0.38 + p * 0.12, 'Loading terrain textures…'),
      loadMode === 'light' ? 512 : 1024,
      ground ? ground.uniforms : null,
    );
    terrain = loadMode === 'light'
      ? new Terrain(scene, terrainMat, { radius: LIGHT_RADIUS, maxTileSize: 4096, minTileSize: 256, lodScale: 1.0 })
      : new Terrain(scene, terrainMat, { radius: HEAVY_RADIUS, maxTileSize: 16384 });
    // haze reaches ~full opacity at the edge of the loaded area
    env.minFogDensity = loadMode === 'light' ? 2.0 / LIGHT_RADIUS : 1.6 / HEAVY_RADIUS;
  }
  airports = null;
  rocks = null;
  forest = null;
  grass = null;
  town = null;
  life = null;
  const aircraftType = readSetup().aircraftType;
  sim.fdm.setAircraft(aircraftType === 'C152' ? C152 : C172);
  progress(0.52, `Building the ${aircraftType === 'C152' ? 'Cessna 152' : 'Skyhawk'} — skin, rivets, fasteners, cabin…`);
  sim.panel = new Panel(aircraftType);
  aircraft = await buildAircraft({ envMap: null, panelCanvas: sim.panel.canvas, reg: aircraftType === 'C152' ? 'N152AB' : 'N172SP', scheme: aircraftType === 'C152' ? 1 : 0, interior: true, lights: true, aircraftType });
  aircraft.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  scene.add(aircraft);
  sim.panel.buildHotspots(sim);
  sim.panel.attach(aircraft, sim);
  if (loadMode === 'light') {
    // spawn first, then build only the airports near the aircraft
    airports = new LocalAirports(scene, buildAircraft);
    applySetup(readSetup(), true);
    progress(0.58, 'Building nearby airport…');
    await airports.update({ x: sim.fdm.pos[0], z: sim.fdm.pos[2] });
    progress(0.66, 'Local area ready…');
  } else {
    // Heavy Edition streams too: spawn, sample real elevation around the aircraft only, then build the
    // nearest airport and let the others load in the background as they come into range.
    airports = new LocalAirports(scene, buildAircraft, {
      load: HEAVY_AIRPORT_LOAD, unload: HEAVY_AIRPORT_UNLOAD,
      elevFn: cesiumViewer ? getCesiumElevationWorld : null,
      warm: cesiumViewer ? (a) => warmCesiumTerrain(a.arp[0], a.arp[1], Math.max(a.radius + 300, 1900), 300) : null,
    });
    applySetup(readSetup(), true);
    if (cesiumViewer) {
      progress(0.56, 'Sampling real-world elevation around the aircraft…');
      await warmCesiumTerrain(sim.fdm.pos[0], sim.fdm.pos[2], 2500, 300);
      applySetup(readSetup(), true);
    }
    progress(0.6, 'Building the departure airport…');
    await airports.update({ x: sim.fdm.pos[0], z: sim.fdm.pos[2] });
    progress(0.66, 'Other airports stream in as you fly…');
  }
  sim.ready = true;
  await new Promise((resolve) => requestAnimationFrame(resolve));

  if (!useLocalScenery) {
    progress(0.72, 'Using real-world terrain, roads and buildings…');
    progress(0.80, 'Loading real-world 3D scenery…');
    progress(0.86, 'Using live aerial road and city detail…');
  } else {
    if (loadMode === 'light') {
      if (ground) {
        progress(0.70, 'Mapping fields, yards, streets and driveways…');
        await ground.ready(sim.fdm.pos[0], sim.fdm.pos[2]);
        blades = new GrassBlades(scene, ground);
        crops = new CropField(scene, ground);
        await crops.init();
      }
      progress(0.72, 'Growing trees…');
      forest = new Forest(scene, renderer);
      if (ground) {
        // no wild forest on real fields, vineyards, orchards, lawns, golf courses, parking lots or driveways
        const NOF = new Set([1, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15, 16, 22, 23, 24, 25, 26, 28]);
        forest.reject = (x, z) => { const g = ground.sample(x, z); return !!g && (g.cov > 0.15 || NOF.has(g.cls)); };
      }
      await forest.init(0.45);
      rocks = new RockField(scene);
      await rocks.init(0.4);
      progress(0.80, 'Laying out roads, streets and buildings…');
      scenery = new Scenery(scene, { light: true, quality: 0.6, ground });
      await scenery.init();
      progress(0.86, 'Using reduced scenery detail…');
    } else {
      const worldQuality = 0.8;
      rocks = new RockField(scene);
      await rocks.init(worldQuality);
      progress(0.72, 'Loading rocks and airport surroundings…');

      forest = new Forest(scene, renderer);
      await forest.init(worldQuality);
      progress(0.80, 'Growing scenery…');

      grass = new GrassField(scene);
      await grass.init(worldQuality);
      progress(0.86, 'Building towns, roads and bridges…');
      scenery = new Scenery(scene, { light: false, quality: 1 });
      await scenery.init();
    }
  }
  progress(0.92, 'Adding vehicles and airport activity…');
  const realFarms = ground ? await fetch('./data/farms.json?v=20261123g').then((r) => r.json()).catch(() => null) : null;
  life = await buildLife(scene, { cars: loadMode === 'light' ? 160 : 380, streets: scenery ? (x, z, r) => scenery.streetsNear(x, z, r) : null, realFarms, flatStreets: !!ground });
  if (loadMode === 'light') life.quality = 0.55;
  sim.life = life;
  life.setRoadTraffic(readSetup().roadTraffic);
  if (!sim.gs) { $('gsChip')?.addEventListener('click', () => sim.gs?.toggle()); }
  if (!sim.gs) sim.gs = new PlayerGroundServices({ scene, sim, toast, groundH: (x, z) => groundQuery(x, z).h });
  progress(0.93, 'Air traffic…');
  traffic = new Traffic(scene, { light: loadMode === 'light' });
  await traffic.init(buildAircraft);
  traffic.setEnabled(sim.aiTrafficEnabled !== false);
  sim.tower = new Tower(traffic, sim.atc); traffic.sim = sim; sim.taxiChart = taxiChart; taxiChart('KSFO');
  sim.traffic = traffic; sim.scenery = scenery; sim.airports = airports; sim.terrain = terrain;
  if (scenery) for (let i = 0; i < 60; i++) scenery.update({ x: sim.fdm.pos[0], z: sim.fdm.pos[2] });

  progress(0.95, 'World scene ready…');
  mmap = new MovingMap(); sim.mmap = mmap; { const t0 = performance.now(); while (!mmap.build(40) && performance.now() - t0 < 4000); } mmap.traffic = () => (traffic && traffic.enabled ? traffic.list : []);
  progress(0.95, 'Charts…');
  progress(1, 'Ready');
  await new Promise((resolve) => requestAnimationFrame(resolve));
  $('loading').classList.add('hidden');
  $('loadChoice').classList.add('hidden');
  $('setup').classList.add('hidden');
  $('fly').disabled = false;
  $('fly').click();
}

function chooseLoadMode(mode) {
  loadMode = mode;
  $('loadChoice').classList.add('hidden');
  $('loading').classList.remove('hidden');
  $('setup').classList.add('hidden');
  $('fly').disabled = true;
  if (mode === 'light') $('quality').value = 'lite';
  init().catch((error) => {
    console.error(error);
    const message = error instanceof Error
      ? error.message
      : (typeof error === 'string' && error
        ? error
        : error?.message || error?.reason?.message || 'Unknown loading error');
    loadText.textContent = 'Failed to load: ' + message;
    $('loading').classList.add('hidden');
    $('setup').classList.add('hidden');
    $('loadChoice').classList.remove('hidden');
  });
}
window.chooseLoadMode = chooseLoadMode;
window.startEdition = chooseLoadMode;
const aircraftTypeSelect = $('aircraftType');
aircraftTypeSelect.addEventListener('change', () => {
  const c152 = aircraftTypeSelect.value === 'C152';
  $('aircraftTitle').textContent = c152 ? 'AEROBAT' : 'SKYHAWK';
  $('aircraftSubtitle').textContent = c152
    ? 'Cessna 152 · 110 hp trainer · San Francisco Bay Area'
    : 'Cessna 172S · 180 hp trainer · San Francisco Bay Area';
});

// ---------------- setup / spawn ----------------
function readSetup() {
  return {
    aircraftType: $('aircraftType').value, spawn: $('spawn').value, tod: +$('tod').value, windDir: +$('wdir').value, windKt: +$('wspd').value, turb: +$('turb').value,
    cover: +$('clouds').value, baseFt: +$('cbase').value, visKm: +$('vis').value, qnhInHg: +$('qnh').value, isa: +$('isa').value, fuel: +$('fuel').value, quality: $('quality').value, autoRes: $('autoRes').checked, roadTraffic: $('roadTraffic').value,
    atcEnabled: $('atcEnabled').checked, aiTraffic: $('aiTraffic').checked,
    failureScenario: $('failureScenario').value, triggerFailureAtStart: $('triggerFailureAtStart').checked,
  };
}
function bindOutputs() {
  const fmtT = (v) => { const h = Math.floor(v), m = Math.round((v - h) * 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };
  const map = [['tod', 'todOut', fmtT], ['wdir', 'wdOut', (v) => String(v).padStart(3, '0') + '°'], ['wspd', 'wsOut', (v) => v + ' kt'],
    ['turb', 'tbOut', (v) => (v < 0.05 ? 'None' : v < 0.3 ? 'Light' : v < 0.6 ? 'Moderate' : 'Severe')], ['cbase', 'cbOut', (v) => (+v).toLocaleString() + ' ft'],
    ['vis', 'visOut', (v) => v + ' km'], ['qnh', 'qnhOut', (v) => (+v).toFixed(2) + ' inHg'], ['isa', 'isaOut', (v) => (v >= 0 ? '+' : '') + v + ' °C'], ['fuel', 'fuelOut', (v) => v + ' gal']];
  for (const [i, o, fn] of map) { const el = $(i), out = $(o); const up = () => (out.textContent = fn(+el.value)); el.addEventListener('input', up); up(); }
}
bindOutputs();

function syncFuelControl() {
  const fuel = $('fuel');
  const profile = $('aircraftType').value === 'C152' ? C152 : C172;
  const maxPerTank = Math.floor(profile.fuelCapGal);
  fuel.max = String(maxPerTank);
  if (+fuel.value > maxPerTank) fuel.value = String(maxPerTank);
  $('fuelOut').textContent = fuel.value + ' gal';
}
$('aircraftType').addEventListener('change', syncFuelControl);
syncFuelControl();

function airport(icao) { return AIRPORTS.find((a) => a.icao === icao); }
let lastSetup = null;

function applySetup(s, warmOnly = false) {
  lastSetup = s;
  sim.groundServices = { active: false, airport: null };
  sim.gs?.reset();
  sim.fdm.setAircraft(s.aircraftType === 'C152' ? C152 : C172);
  sim.atc.enabled = s.atcEnabled !== false;
  sim.atc.trafficEnabled = s.aiTraffic !== false;
  sim.aiTrafficEnabled = s.aiTraffic !== false;
  if (life) life.setTrafficEnabled(sim.aiTrafficEnabled);
  if (traffic) traffic.setEnabled(sim.aiTrafficEnabled !== false);
  const F = sim.fdm;
  sim.weather = { windDir: s.windDir, windKt: s.windKt, turb: s.turb, cover: s.cover, baseFt: s.baseFt, visKm: s.visKm, qnhInHg: s.qnhInHg, isa: s.isa };
  sim.timeOfDay = s.tod;
  const lightState = env.setTime(s.tod);
  sim.night = lightState.night;
  // quality
  const q = { high: [1.75, 4096, 1.0], balanced: [1.25, 2048, 0.65], perf: [0.75, 512, 0.18], lite: [0.6, 256, 0.08] }[s.quality] || [1.25, 2048, 0.65];
  perf.setAuto(s.autoRes !== false); perf.setBase(Math.min(window.devicePixelRatio, q[0]));
  if (life) life.setRoadTraffic?.(s.roadTraffic);
  if (env.sun.shadow.mapSize.x !== q[1]) { env.sun.shadow.mapSize.set(q[1], q[1]); if (env.sun.shadow.map) { env.sun.shadow.map.dispose(); env.sun.shadow.map = null; } }
  if (forest) { forest.quality = q[2]; forest.lastKey = null; }
  if (rocks) { rocks.quality = q[2]; rocks.lastCell = null; }
  if (grass) { grass.quality = q[2]; grass.lastKey = null; }
  if (life) life.quality = q[2];
  sim.quality = s.quality;
  // spawn
  let pos, hdg, onGround = true, speed = 0, cold = false, pitch = 0, alt;
  // line up just past the (displaced) threshold of a real runway end
  const rwyStart = (icao, id) => { const f = findRunway(icao, id); const e = runwayEnd(f.r, f.e); const k = (f.r.disp[f.e] || 0) - 35; return { p: { x: e.x - e.dir[0] * k, z: e.z - e.dir[1] * k }, hdg: e.hdg }; };
  let flapsInit = 0;
  const SP = { SFO28: ['KSFO', '28L'], SFO28L: ['KSFO', '28L'], SFO1R: ['KSFO', '1R'], OAK30: ['KOAK', '30'], OAK12: ['KOAK', '12'], OAK28R: ['KOAK', '28R'], SJC30: ['KSJC', '30L'], HWD28: ['KHWD', '28L'], SQL30: ['KSQL', '30'], PAO31: ['KPAO', '31'], LVK25: ['KLVK', '25R'], CCR32: ['KCCR', '32R'], RHV31: ['KRHV', '31R'], APC36: ['KAPC', '19R'], HAF30: ['KHAF', '30'], NUQ32: ['KNUQ', '32R'], DVO31: ['KDVO', '31'], O69: ['KO69', '29'] };
  if (s.spawn === 'SFOramp') s.spawn = 'SFO28'; // older saved menu value
  sim.taxi = null;
  if (SP[s.spawn]) {
    // parked on the general-aviation ramp, cold & dark; taxi route to the departure runway over the real taxiways
    const [icao, rw] = SP[s.spawn], a = airport(icao);
    pos = { x: a.ramp.x, z: a.ramp.z }; hdg = a.ramp.hdg; cold = true;
    const route = departureRoute(icao, rw, pos.x, pos.z);
    if (route) {
      sim.taxi = { route, show: true, icao };
      // nose toward the first leg of the route so the taxi starts straight ahead
      const t = route.pts.find((p) => Math.hypot(p.x - pos.x, p.z - pos.z) > 30) || route.pts[route.pts.length - 1];
      hdg = (Math.atan2(t.x - pos.x, -(t.z - pos.z)) / D2R + 360) % 360;
    }
    s.depRwy = route ? route.rwy : rw; s.taxiVia = route ? route.viaText : null; s.ramp = true;
  }
  else switch (s.spawn) {
    case 'SFO28rwy': { const r = rwyStart('KSFO', '28L'); pos = r.p; hdg = r.hdg; break; }
    case 'ILS28': { const i = ILS.find((x) => x.ident === 'ISFO') || ILS[0]; const d = 8 * 1852; const c = i.course * D2R; pos = { x: i.thr.x - Math.sin(c) * d, z: i.thr.z + Math.cos(c) * d }; hdg = i.course; onGround = false; speed = 95; alt = Math.max(3000 * FT + (s.qnhInHg - 29.92) * 1000 * FT, i.elev + Math.tan(3 * D2R) * d + 30); pitch = 2; break; }
    case 'cruise': { pos = ll2w(37.70, -122.30); hdg = 320; onGround = false; speed = 108; alt = 4500 * FT; pitch = 1.5; break; }
    case 'GG': { pos = ll2w(37.79, -122.40); hdg = 300; onGround = false; speed = 100; alt = 1500 * FT; pitch = 1; break; }
    default: { const r = rwyStart('KSFO', '28L'); pos = r.p; hdg = r.hdg; }
  }
  sim.atc.reset(s);
  if (sim.tower) sim.tower.q.clear();
  sim.av.com1.active = sim.atc.frequency;
  const localGh = heightAt(pos.x, pos.z);
  const cesiumGh = getCesiumElevationWorld(pos.x, pos.z);
  const gh = Number.isFinite(cesiumGh) ? cesiumGh : localGh;
  warmCesiumTerrain(pos.x, pos.z);
  F.env.qnh = s.qnhInHg * INHG; F.env.isaDev = s.isa; F.env.turbulence = s.turb;
  F.reset({ pos: [pos.x, onGround ? gh + 1.25 : alt, pos.z], hdg, speedKt: speed, onGround, coldDark: cold, pitch });
  F.resetFailures();
  showFailure(null);
  sim.activeFailure = null;
  sim.failurePending = !warmOnly && s.triggerFailureAtStart && s.failureScenario !== 'none' ? s.failureScenario : null;
  sim.failureDelay = 3;
  F.ctrl.flaps = flapsInit;
  const requestedFuel = Math.max(0, Math.min(Number(s.fuel) || 0, F.aircraft.fuelCapGal));
  F.sys.fuelL = F.sys.fuelR = requestedFuel;
  if (!cold && sim.night > 0.25) { F.sys.panelLights = true; F.sys.nav = true; }
  F.kollsman = cold ? 29.92 : Math.round(s.qnhInHg * 100) / 100;
  if (!onGround) { F.ctrl.throttle = s.spawn === 'ILS28' ? 0.5 : 0.72; F.ctrl.trim = s.spawn === 'ILS28' ? 0.2 : 0.05; F.ctrl.parkBrake = false; F.eng.rpm = 2300; F.eng.propOmega = 2300 * Math.PI / 30; }
  if (onGround && !cold) { F.ctrl.throttle = 0.08; F.ctrl.parkBrake = false; F.ctrl.toeBrake = 0; }
  if (!onGround) F.trimAir(0); // solve AoA + elevator trim for 1 g at the spawn speed
  F.ind.ias = speed; F.ind.alt = 0;
  // avionics
  const av = sim.av;
  av.ap.on = false; av.ap.discAlert = 0;
  av.hdgBug = Math.round(hdg);
  { // tune NAV1 to the ILS of the departure / approach runway when it has one, else the nearest VOR
    const code = SP[s.spawn] ? [SP[s.spawn][0], s.depRwy || SP[s.spawn][1]] : (s.spawn === 'ILS28' || s.spawn === 'SFO28rwy' ? ['KSFO', '28L'] : null);
    const il = code ? ILS.find((i) => i.airport.icao === code[0] && i.rwy === code[1]) || ILS.find((i) => i.airport.icao === code[0]) : null;
    let vor = null, bd = 1e12; for (const n of NAVAIDS) if (n.type === 'VOR') { const d = Math.hypot(n.x - pos.x, n.z - pos.z); if (d < bd) { bd = d; vor = n; } }
    if (il) { av.nav1.active = il.freq; av.nav1.obs = Math.round(il.course); if (vor) av.nav1.standby = vor.freq; }
    else if (vor) { av.nav1.active = vor.freq; av.nav1.obs = Math.round(hdg); }
  }
  // weather
  const wr = s.windDir * D2R, ws = s.windKt * KT;
  sim.windVec = [-Math.sin(wr) * ws, 0, Math.cos(wr) * ws];
  env.setWeather({ cover: s.cover, base: s.baseFt * FT + 0, visKm: s.visKm, windDir: s.windDir, windKt: s.windKt });
  F.env.wind = sim.windVec.slice();
  if (scenery) scenery.setNight(sim.night);
  if (life) life.setNight(sim.night);
  aircraft.userData.night = sim.night;
  if (mmap) mmap.track = [];
  sim.crashShown = false; sim.lastTD = null; sim.airTime = 0;
  sim.view = sim.view === 'walk' ? 'cockpit' : sim.view;
  look.yaw = 0; look.pitch = -10; camera.fov = 58;
  walker.pos = null;
  // warm terrain & instanced objects around the aircraft
  const cam = new THREE.Vector3(F.pos[0], F.pos[1], F.pos[2]);
  if (terrain) {
    terrain.warm(cam, F.pos[1] - gh);
  }
  if (airports?.update) airports.update(cam);
  if (forest && rocks) {
    for (let i = 0; i < 40; i++) { forest.update(cam, 200); rocks.update(cam, 200); }
  }
  if (grass) grass.update(cam, F.pos[1] - gh);
  if (scenery) for (let i = 0; i < 40; i++) scenery.update(cam);
  sim.checklist?.reset(s.aircraftType);
  buildTaxiLine();
  syncAircraft(0);
  void warmOnly;
}

// ---------------- input ----------------
const look = { yaw: 0, pitch: -8, dragging: false, lx: 0, ly: 0, moved: 0 };
sim.look = look;
const orbit = { yaw: 200, pitch: 12, dist: 14 };
const walker = { pos: null, yaw: 0, pitch: 0 }; sim.walker = walker;
const mouse = { x: 0, y: 0, yoke: false, nx: 0, ny: 0 };
const ctrlState = { elev: 0, ail: 0, rud: 0 };
// A movement key held while switching between walking and flying views must not leak into the throttle / walker.
const suppressedKeys = new Set();
const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF'];
const views = ['cockpit', 'cabin', 'orbit', 'chase', 'tower', 'flyby', 'walk'];
const viewNames = { cockpit: 'COCKPIT', cabin: 'CABIN — WALK (WASD)', orbit: 'EXTERNAL ORBIT', chase: 'CHASE', tower: 'TOWER', flyby: 'FLY-BY', walk: 'WALKAROUND (WASD)' };

const FAILURE_SCENARIOS = {
  engine: {
    title: 'Engine failure',
    steps: ['Airspeed — establish best glide: 68 kt', 'Best field — plan for landing', 'Fuel selector — BOTH', 'Fuel pump — ON', 'Mixture — RICH', 'Ignition — BOTH, then START if needed', 'Electrical load — reduce', 'Declare mayday / contact ATC', 'Proceed to landing field'],
  },
  alternator: {
    title: 'Alternator failure',
    steps: ['Verify alternator indication and low-voltage annunciator', 'Reduce electrical load', 'Check and reset the alternator field circuit breaker once', 'If voltage remains low, alternator switch — OFF', 'Conserve battery for essential instruments and communications', 'Terminate flight and land as soon as practical'],
  },
  vacuum: {
    title: 'Vacuum system failure',
    steps: ['Confirm attitude and heading indicators are unreliable', 'Cross-check magnetic compass and turn coordinator', 'Avoid instrument turns until a reliable attitude reference is available', 'Reduce pilot workload and use outside visual cues', 'If in instrument conditions, declare a problem and request assistance', 'Land as soon as practical'],
  },
  fuel: {
    title: 'Fuel starvation',
    steps: ['Airspeed — establish best glide: 68 kt', 'Fuel selector — switch to the fullest tank / BOTH', 'Electric fuel pump — ON', 'Mixture — RICH', 'Ignition — BOTH', 'Attempt engine restart; if unsuccessful, secure mixture and ignition', 'Plan a forced landing'],
  },
};

function toggleFailurePanel(force) {
  const panel = $('failurePanel');
  panel.classList.toggle('hidden', !(force ?? panel.classList.contains('hidden')));
}

function showFailure(type) {
  sim.activeFailure = type;
  const scenario = FAILURE_SCENARIOS[type];
  $('failureChip').classList.toggle('hidden', !scenario);
  $('failureChip').textContent = scenario ? `FAILURE: ${scenario.title.toUpperCase()}` : 'FAILURE: NONE';
  $('failureTitle').textContent = scenario?.title || 'No failure active';
  $('failureSteps').replaceChildren(...(scenario?.steps || ['No active failure.']).map((step) => {
    const li = document.createElement('li');
    li.textContent = step;
    return li;
  }));
}

function triggerFailure(type) {
  if (!type || type === 'none') return;
  sim.fdm.triggerFailure(type);
  showFailure(type);
  toggleFailurePanel(true);
  const title = FAILURE_SCENARIOS[type]?.title || 'Failure';
  toast(`${title} simulated`, 3500);
  sim.panelDirty = true;
}

function clearFailure() {
  sim.fdm.resetFailures();
  if (sim.activeFailure === 'fuel') {
    sim.fdm.sys.fuelSel = 'BOTH';
    sim.fdm.sys.fuelL = sim.fdm.aircraft.fuelCapGal;
    sim.fdm.sys.fuelR = sim.fdm.aircraft.fuelCapGal;
  }
  showFailure(null);
  toggleFailurePanel(false);
  toast('Failure state reset', 1800);
  sim.panelDirty = true;
}

function toast(msg, ms = 1800) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), ms); }

window.addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT')) return;
  sim.sound.start();
  const code = remap(e.code); if (code == null) return;
  if (suppressedKeys.has(code)) { if (e.repeat) return; suppressedKeys.delete(code); }
  const k = e.key; const F = sim.fdm, S = F.sys, av = sim.av;
  sim.keys[code] = true; sim.keys.Shift = e.shiftKey;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space', 'Slash'].includes(code)) e.preventDefault();
  if (!sim.started) return;
  if (e.repeat && !['KeyI', 'BracketLeft', 'BracketRight'].includes(code)) { if (e.shiftKey && code.startsWith('Arrow')) {} else return; }
  const sh = e.shiftKey;
  switch (code) {
    case 'Escape': if (taxiMapOpen()) { toggleTaxiMap(false); $('tmapBtn').classList.remove('on'); break; } if (!$('help').classList.contains('hidden')) { setHelp(false); break; } if (!$('mapWrap').classList.contains('hidden')) { toggleMap(false); break; } togglePause(); if (sim.paused) showMenu(true); break;
    case 'KeyF':
      if (sh) toggleFailurePanel();
      else if (!walkView()) { F.ctrl.flaps = Math.min(3, F.ctrl.flaps + 1); toast('Flaps ' + ['UP', '10°', '20°', 'FULL'][F.ctrl.flaps]); }
      break;
    case 'KeyV': if (sh) { S.avionics = !S.avionics; S.avionics2 = S.avionics; toast('Avionics ' + (S.avionics ? 'ON' : 'OFF')); } else { F.ctrl.flaps = Math.max(0, F.ctrl.flaps - 1); toast('Flaps ' + ['UP', '10°', '20°', 'FULL'][F.ctrl.flaps]); } break;
    case 'KeyP': F.ctrl.parkBrake = !F.ctrl.parkBrake; toast('Parking brake ' + (F.ctrl.parkBrake ? 'SET' : 'RELEASED')); break;
    case 'KeyJ':
      if (sh) { sim.gs?.cancelAll(); toast('Ground services: all cancelled', 2000); }
      else sim.gs?.toggle();
      break;
    case 'KeyI': if (sh) S.mags = Math.max(0, S.mags - 1); else { S.mags = Math.min(4, S.mags + 1); if (S.mags === 4) sim.startHeld = 0.25; } toast('Ignition ' + ['OFF', 'R', 'L', 'BOTH', 'START'][S.mags], 900); break;
    case 'KeyM': if (sh) { const on = !(S.master && S.alternator); S.master = on; S.alternator = on; toast('Master ' + (on ? 'ON' : 'OFF')); } else toggleMap(); break;
    case 'KeyE': if (sh) autoStart(); break;
    case 'KeyL': if (sh) { S.taxi = !S.taxi; toast('Taxi light ' + (S.taxi ? 'ON' : 'OFF')); } else { S.landing = !S.landing; toast('Landing light ' + (S.landing ? 'ON' : 'OFF')); } break;
    case 'KeyO': if (sh) { S.nav = !S.nav; toast('Nav lights ' + (S.nav ? 'ON' : 'OFF')); } else { S.strobe = !S.strobe; toast('Strobes ' + (S.strobe ? 'ON' : 'OFF')); } break;
    case 'KeyK': F.kollsman = Math.round(sim.weather.qnhInHg * 100) / 100; toast('Altimeter ' + F.kollsman.toFixed(2)); break;
    case 'KeyD': if (!walkView()) { F.gyro.hiDrift = ((F.attitude.hdg - F.gyro.compass + 540) % 360) - 180; toast('Heading indicator set to compass'); } break;
    case 'KeyA': if (!walkView() && !sh) { const wl = !!F.aircraft.apRollOnly; if (!F.eff?.ap) { toast(wl ? 'Wing leveler has no power (AVIONICS switch / AUTOPILOT breaker)' : 'Autopilot has no power (AVIONICS BUS 2 / AUTOPILOT breaker)'); break; } av.apButton('AP', F); toast(av.ap.on ? (wl ? 'Wing leveler ENGAGED (LVL) — you still fly pitch' : 'Autopilot ENGAGED (ROL/VS)') : (wl ? 'Wing leveler' : 'Autopilot') + ' DISCONNECTED'); } else if (sh && !walkView()) { /* reserved */ } break;
    case 'KeyH': if (sh) { av.apButton('HDG', F); toast('AP ' + av.ap.lat); } else sim.checklist?.toggle(); break;
    case 'KeyN': if (sh) { av.apButton('NAV', F); toast('AP ' + av.ap.lat); } else { $('mini').classList.toggle('hidden'); } break;
    case 'KeyR':
      if (sh) { av.apButton('APR', F); toast('AP ' + av.ap.lat + (av.ap.gsArmed ? ' (GS armed)' : '')); }
      else if (walkView()) {}
      else { sim.gs?.toggle(true); sim.gs?.request('fuel'); }
      break;
    case 'KeyT': if (sh) { av.apButton('ALT', F); toast('AP ' + av.ap.vert); } else toggleTaxiLine(); break;
    case 'KeyY': mouse.yoke = !mouse.yoke; $('yokeChip').classList.toggle('hidden', !mouse.yoke); $('cross').classList.toggle('hidden', !mouse.yoke); toast(mouse.yoke ? 'Mouse yoke ON — mouse position = yoke' : 'Mouse yoke OFF'); break;
    case 'KeyG': toggleATC(); break;
    case 'KeyU': $('strip').classList.toggle('hidden'); break;
    case 'KeyC': { let i = views.indexOf(sim.view); for (let n = 0; n < views.length; n++) { i = (i + 1) % views.length; if (setView(views[i], true)) break; } break; }
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6': case 'Digit7': setView(views[+code.slice(5) - 1]); break;
    case 'Numpad1': case 'Numpad2': case 'Numpad3': case 'Numpad4': case 'Numpad5': case 'Numpad6': case 'Numpad7': setView(views[+code.slice(6) - 1]); break;
    case 'Digit8': $('tmapBtn').classList.toggle('on', toggleTaxiMap(undefined, sim)); break;
    case 'Digit9': sim.simRate = sim.simRate >= 4 ? 1 : sim.simRate * 2; toast('Sim rate ' + sim.simRate + '×'); break;
    case 'Space': look.yaw = 0; look.pitch = -10; camera.fov = 58; camera.updateProjectionMatrix(); break;
    case 'Slash': setHelp($('help').classList.contains('hidden')); break;
    case 'Semicolon': togglePerfDetail(); break;
    case 'ArrowLeft': case 'ArrowRight': if (sh) { av.hdgBug = (av.hdgBug + (code === 'ArrowLeft' ? -1 : 1) * 5 + 360) % 360; } break;
    case 'ArrowUp': case 'ArrowDown': if (sh) av.apButton(code === 'ArrowUp' ? 'UP' : 'DN', F); break;
  }
});
window.addEventListener('keyup', (e) => { const code = remap(e.code); if (code == null) return; suppressedKeys.delete(code); sim.keys[code] = false; sim.keys.Shift = e.shiftKey; if (code === 'KeyI' && sim.fdm.sys.mags === 4) sim.startHeld = 0; });
window.addEventListener('blur', () => { sim.keys = {}; suppressedKeys.clear(); });

const walkView = () => sim.view === 'cabin' || sim.view === 'walk';

function autoStart() {
  const F = sim.fdm, S = F.sys;
  toast('Auto-start: Master ON, beacon ON, fuel BOTH, mixture RICH, throttle ¼", fuel pump prime, mags START…', 3500);
  S.master = true; S.alternator = true; S.beacon = true; S.fuelSel = 'BOTH'; S.fuelShutoff = true; S.carbHeat = false; if (F.aircraft.carb && F.eng.oilT < 110) S.primer = 3; F.ctrl.mixture = 1; F.ctrl.throttle = 0.1; S.fuelPump = true; F.ctrl.parkBrake = true;
  setTimeout(() => { S.fuelPump = false; S.mags = 4; sim.startHeld = 4; }, 1200);
  const chk = setInterval(() => { if (F.eng.running || sim.startHeld <= 0) { clearInterval(chk); S.mags = 3; sim.startHeld = 0; if (F.eng.running) { S.avionics = true; S.avionics2 = true; S.nav = true; F.ctrl.throttle = 0.13; toast('Engine running — avionics ON. Set altimeter (K), check oil pressure.', 3000); } } }, 100);
}

const canWalkaround = () => { const F = sim.fdm; return !!F.onGround && !F.crashed && Math.hypot(F.vel[0], F.vel[2]) < 1; };
// Ground height under (x, z) from the active ground model (Cesium terrain in Heavy mode, the local DEM otherwise).
function groundH(x, z, y = 1e9) {
  const g = sim.fdm.env.ground?.(x, z, y);
  return Number.isFinite(g?.h) ? g.h : heightAt(x, z);
}
// Returns false (and keeps the current view) when the requested view can't be used right now.
function setView(v, quiet = false) {
  if (!views.includes(v)) return false;
  if (v === 'walk' && !canWalkaround()) { if (!quiet) toast('Walkaround only on the ground, stopped'); return false; }
  const walkish = (x) => x === 'walk' || x === 'cabin';
  if (sim.view !== v && (walkish(sim.view) || walkish(v))) {
    for (const code of MOVE_KEYS) { if (sim.keys[code]) suppressedKeys.add(code); sim.keys[code] = false; }
  }
  sim.view = v; $('viewName').textContent = viewNames[v];
  if (v === 'walk') {
    const F = sim.fdm;
    const side = qrot(F.q, [0, 0, -1]), fw = qrot(F.q, [1, 0, 0]);
    walker.pos = new THREE.Vector3(F.pos[0] + side[0] * 4 + fw[0] * 1.5, 0, F.pos[2] + side[2] * 4 + fw[2] * 1.5);
    walker.pos.y = groundH(walker.pos.x, walker.pos.z, F.pos[1] + 2) + 1.68;
    walker.yaw = Math.atan2(-(F.pos[0] - walker.pos.x), -(F.pos[2] - walker.pos.z)) / D2R; walker.pitch = -5;
  }
  if (v === 'cabin') { cabinEye.set(-0.35, 0.58, 0.0); look.yaw = 0; }
  if (v === 'flyby') flyby.pos = null;
  if (v === 'chase') sim.chaseHdg = null;
  if (v !== 'tower' && v !== 'flyby') { camera.fov = v === 'cockpit' || v === 'cabin' ? 58 : 60; camera.updateProjectionMatrix(); }
  if (v === 'orbit') { orbit.yaw = 210; orbit.pitch = 10; orbit.dist = 13; }
  return true;
}
const cabinEye = new THREE.Vector3(-0.35, 0.58, 0);
const flyby = { pos: null };

// mouse
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  sim.sound.start();
  canvas.focus?.();
  look.dragging = true; look.lx = e.clientX; look.ly = e.clientY; look.moved = 0; look.button = e.button;
  if (mouse.yoke && e.button === 2 && mouseSettings.rudderButton) { mouse.rudder = true; look.dragging = false; }
  if (mouse.yoke && e.button === 0 && !panelHit(e.clientX, e.clientY)) look.dragging = false; // left button flies, it does not drag the view
  canvas.setPointerCapture?.(e.pointerId);
  // press-and-hold controls (ignition START, annunciator TEST, ...)
  look.hold = null;
  const h = panelHit(e.clientX, e.clientY);
  if (h && h.down) { h.down(e.button); look.hold = h; look.dragging = false; sim.sound.click(); sim.panelDirty = true; }
});
canvas.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  mouse.nx = (e.clientX / window.innerWidth) * 2 - 1; mouse.ny = (e.clientY / window.innerHeight) * 2 - 1;
  if (mouse.yoke) { $('cross').style.left = e.clientX + 'px'; $('cross').style.top = e.clientY + 'px'; }
  if (!look.dragging) return;
  const dx = e.clientX - look.lx, dy = e.clientY - look.ly; look.lx = e.clientX; look.ly = e.clientY; look.moved += Math.abs(dx) + Math.abs(dy);
  if (look.moved < 4) return;
  const k = camera.fov / 600;
  if (sim.view === 'orbit' || sim.view === 'chase') { orbit.yaw -= dx * 0.3; orbit.pitch = clamp(orbit.pitch + dy * 0.25, -80, 85); }
  else if (sim.view === 'walk') { walker.yaw -= dx * k * 1.2; walker.pitch = clamp(walker.pitch - dy * k * 1.2, -85, 85); }
  else { look.yaw = clamp(look.yaw - dx * k * 1.2, -170, 170); look.pitch = clamp(look.pitch - dy * k * 1.2, -80, 70); }
});
canvas.addEventListener('pointerup', (e) => {
  look.dragging = false; if (e.button === 2) mouse.rudder = false;
  if (look.hold) { look.hold.up?.(e.button); look.hold = null; sim.panelDirty = true; return; }
  if (look.moved < 4) panelClick(e.clientX, e.clientY, e.button);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const h = panelHit(e.clientX, e.clientY);
  if (h && h.wheel) { h.wheel(e.deltaY); sim.sound.click(); return; }
  if (mouse.yoke && mouseSettings.wheelThrottle && sim.started && !walkView()) { const c = sim.fdm.ctrl; c.throttle = clamp(c.throttle - Math.sign(e.deltaY) * 0.04, 0, 1); toast('Throttle ' + Math.round(c.throttle * 100) + '%', 700); return; }
  if (sim.view === 'orbit' || sim.view === 'chase') orbit.dist = clamp(orbit.dist * (1 + Math.sign(e.deltaY) * 0.1), 6, 400);
  else { camera.fov = clamp(camera.fov + Math.sign(e.deltaY) * 4, 18, 95); camera.updateProjectionMatrix(); }
}, { passive: false });

const ray = new THREE.Raycaster();
function panelHit(x, y) {
  if (!(sim.view === 'cockpit' || sim.view === 'cabin') || !sim.panel) return null;
  const p = aircraft.userData.parts.panel; if (!p) return null;
  ray.setFromCamera({ x: (x / window.innerWidth) * 2 - 1, y: -(y / window.innerHeight) * 2 + 1 }, camera);
  // 3D controls (knobs, levers, key, trim wheel) take priority if they are nearer than the panel face
  const hits = ray.intersectObjects([p, ...(sim.panel.hot3d || [])], true);
  sim.panelUV = null; for (const hit of hits) if (hit.object === p && hit.uv) { sim.panelUV = hit.uv; break; }
  for (const hit of hits) {
    if (hit.object === p) { if (!hit.uv) return null; const h = sim.panel.hit(hit.uv.x, hit.uv.y); if (h) return h; continue; }
    let o = hit.object; while (o && !o.userData.hot) o = o.parent;
    if (o && o.visible !== false) return o.userData.hot;
  }
  return null;
}
function panelClick(x, y, button) {
  const h = panelHit(x, y);
  if (h && h.click) { h.click(button); sim.sound.click(); sim.panelDirty = true; }
}

// gamepad
function readGamepad() {
  const gps = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of gps) {
    if (!gp || !gp.connected) continue;
    const dz = (v) => (Math.abs(v) < 0.06 ? 0 : v);
    return { ail: dz(gp.axes[0] || 0), elev: -dz(gp.axes[1] || 0) * -1, rud: dz(gp.axes[2] || 0), thr: dz(gp.axes[3] || 0), b: gp.buttons.map((b) => b.pressed), name: gp.id };
  }
  return null;
}
let gpPrev = [];

// ---------------- controls integration ----------------
function updateControls(dt) {
  const F = sim.fdm, c = F.ctrl, K = sim.keys, sh = K.ShiftLeft || K.ShiftRight;
  const walking = walkView();
  // keyboard yoke: deflect while held, spring back
  const target = (pos, neg) => (K[pos] ? 1 : 0) - (K[neg] ? 1 : 0);
  let te = sh ? 0 : target('ArrowDown', 'ArrowUp');
  let ta = sh ? 0 : target('ArrowRight', 'ArrowLeft');
  let tr = target('KeyX', 'KeyZ') + (walking ? 0 : target('KeyE', 'KeyQ') * (sh ? 0 : 1));
  const rate = (cur, tgt, up, down) => { const d = tgt - cur; const r = Math.abs(tgt) > Math.abs(cur) && Math.sign(tgt) === Math.sign(cur || tgt) ? up : down; return cur + clamp(d, -r * dt, r * dt); };
  ctrlState.elev = rate(ctrlState.elev, te * 0.75, 1.3, 2.2);
  ctrlState.ail = rate(ctrlState.ail, ta * 0.85, 2.0, 3.0);
  ctrlState.rud = rate(ctrlState.rud, tr, 1.6, 2.2);
  let elev = ctrlState.elev, ail = ctrlState.ail, rud = ctrlState.rud;
  if (mouse.yoke) {
    elev += mouseAxis(mouse.ny) * (mouseSettings.invert ? -1 : 1);
    // right button held: mouse X steers the rudder / nose wheel instead of the ailerons
    if (mouse.rudder) rud += mouseAxis(mouse.nx); else ail += mouseAxis(mouse.nx);
  }
  const gp = readGamepad();
  if (gp) {
    ail += gp.ail; elev += gp.elev; rud += gp.rud;
    c.throttle = clamp(c.throttle - gp.thr * dt * 0.6, 0, 1);
    if (gp.b[4] && !gpPrev[4]) c.flaps = Math.max(0, c.flaps - 1);
    if (gp.b[5] && !gpPrev[5]) c.flaps = Math.min(3, c.flaps + 1);
    c.toeBrake = gp.b[0] ? 1 : c.toeBrake;
    gpPrev = gp.b;
  }
  // autopilot servo
  const apCmd = sim.apCmd;
  if (apCmd) {
    // pilot override: strong input disconnects
    const rollOnly = apCmd.elev == null; // wing leveler: pilot keeps full pitch control
    if ((!rollOnly && Math.abs(elev) > 0.6) || Math.abs(ail) > 0.6) { sim.av.disconnect(true); toast((rollOnly ? 'Wing leveler' : 'Autopilot') + ' DISCONNECTED (override)'); }
    else { if (!rollOnly) elev = apCmd.elev + elev * 0.3; ail = apCmd.ail + ail * 0.3; }
  }
  c.elev = clamp(elev, -1, 1); c.ail = clamp(ail, -1, 1); c.rud = clamp(rud, -1, 1);
  // throttle / mixture / trim
  if (!walking) { if (K.KeyW) c.throttle = clamp(c.throttle + dt * 0.45, 0, 1); if (K.KeyS) c.throttle = clamp(c.throttle - dt * 0.45, 0, 1); }
  if (K.PageUp && !sh) c.throttle = clamp(c.throttle + dt * 0.45, 0, 1);
  if (K.PageDown && !sh) c.throttle = clamp(c.throttle - dt * 0.45, 0, 1);
  if (K.BracketRight) c.mixture = clamp(c.mixture + dt * 0.25, 0, 1);
  if (K.BracketLeft) c.mixture = clamp(c.mixture - dt * 0.25, 0, 1);
  if (K.Home) c.trim = clamp(c.trim - dt * 0.25, -1, 1);
  if (K.End) c.trim = clamp(c.trim + dt * 0.25, -1, 1);
  // AP electric trim follows elevator servo load
  if (apCmd && apCmd.elev != null && sim.av.ap.on) c.trim = clamp(c.trim + clamp(apCmd.elev, -0.3, 0.3) * dt * 0.12, -1, 1);
  // brakes
  c.toeBrake = 0; c.brakeL = 0; c.brakeR = 0;
  if (K.KeyB && !sh) { c.brakeL = 1; c.brakeR = 1; }
  if (K.Comma) c.brakeL = 1; if (K.Period) c.brakeR = 1;
  if (gp && gp.b[0]) { c.brakeL = c.brakeR = 1; }
  // ignition spring-loaded START
  if (F.sys.mags === 4) { if (!(K.KeyI || sim.startHeld > 0)) F.sys.mags = 3; }
  if (sim.startHeld > 0) sim.startHeld -= dt;
}

// ---------------- physics step ----------------
const PHYS_DT = 1 / 240;
let acc = 0;
function physics(dt) {
  const F = sim.fdm;
  acc += dt * sim.simRate;
  let n = 0;
  while (acc >= PHYS_DT && n < 120) {
    F.step(PHYS_DT); acc -= PHYS_DT; n++;
  }
  // derived
  const g = groundQuery(F.pos[0], F.pos[2], F.pos[1]);
  F.surfaceType = g.surface;
  F.agl = F.pos[1] - g.h;
  F.onGround = F.groundContact.left || F.groundContact.right || F.groundContact.nose;
  if (!F.crashed && g.surface === 'water' && F.agl < 1.0) F.crash('Ditched in the lake');
  if (!F.crashed && !inWorld(F.pos[0], F.pos[2], 3000) && !sim.edgeWarned) { sim.edgeWarned = 1; setTimeout(() => (sim.edgeWarned = 0), 8000); toast('Edge of the scenery — turn back', 2500); }
  // forest collision (descending into trees below 18 m in dense forest)
  // touchdown report
  if (F.onGround) { if (sim.airTime > 4 && F.touchdown && F.touchdown !== sim.lastTD) touchdownReport(F); sim.airTime = 0; }
  else sim.airTime += dt * sim.simRate;
  if (F.touchdown) sim.lastTD = F.touchdown;
}
function touchdownReport(F) {
  const td = F.touchdown;
  const fpm = Math.round(td.sink / FT * 60);
  let near = null, best = 1e9;
  for (const ap of AIRPORTS) for (const a of ap.runways) { const l = toLocal(a, F.pos[0], F.pos[2]); if (Math.abs(l.u) < a.len / 2 + 50 && Math.abs(l.v) < a.wid / 2 + 30) { const d = Math.abs(l.v); if (d < best) { best = d; near = { a, l }; } } }
  let msg = `Touchdown  ${fpm} fpm  ·  ${Math.round(F.ind.ias)} KIAS`;
  if (near) {
    const hdgRel = ((F.attitude.hdg - near.a.hdg + 540) % 360) - 180; const fwd = Math.abs(hdgRel) < 90;
    const fromThr = (fwd ? near.l.u + near.a.len / 2 : near.a.len / 2 - near.l.u) - (near.a.disp?.[fwd ? 0 : 1] || 0);
    msg += `\nRunway ${near.a.rwy[fwd ? 0 : 1]}`;
    msg += `\n${Math.round(fromThr / FT)} ft past threshold · ${Math.abs(near.l.v).toFixed(1)} m ${near.l.v * (fwd ? 1 : -1) > 0 ? 'right' : 'left'} of centerline`;
  } else msg += '\nOff-airport landing';
  const grade = fpm < 120 ? 'Butter' : fpm < 300 ? 'Good' : fpm < 600 ? 'Firm' : 'Hard — inspect the gear';
  toast(msg + '\n' + grade, 5000);
  sim.sound.chirp(Math.min(1, fpm / 600));
}

// ---------------- camera ----------------
const qBase = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
const tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion(), tmpV = new THREE.Vector3();
const acQ = new THREE.Quaternion();
const EYE = new THREE.Vector3(-0.08, 0.6, -0.27);
let headOff = new THREE.Vector3();
// Tower cab eye point. airport3d stores a THREE.Vector3 once the airport is built; before that (or after it is
// streamed out) geo.js only has a plain {x, z, h} record, so build the eye point from the ground height.
const towerCache = new WeakMap();
function towerEye(a) {
  const tp = a.towerPos;
  if (tp && typeof tp.distanceToSquared === 'function') return tp;
  const x = tp?.x ?? a.towerInfo?.x ?? a.ramp?.x, z = tp?.z ?? a.towerInfo?.z ?? a.ramp?.z;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const h = tp?.h ?? a.towerInfo?.h ?? 12;
  let c = towerCache.get(a);
  const now = performance.now();
  // re-sample now and then: Heavy mode's Cesium elevation arrives after start-up
  if (!c || c.x !== x || c.z !== z || now - c.t > 5000) { c = new THREE.Vector3(x, groundH(x, z) + Math.max(6, h - 2), z); c.t = now; towerCache.set(a, c); }
  return c;
}
function updateCamera(dt, t) {
  const F = sim.fdm;
  acQ.set(F.q[0], F.q[1], F.q[2], F.q[3]);
  const acPos = new THREE.Vector3(F.pos[0], F.pos[1], F.pos[2]);
  const v = sim.view;
  if (v === 'cockpit' || v === 'cabin') {
    camera.near = 0.02;
    let eye = v === 'cockpit' ? EYE.clone() : cabinEye.clone();
    if (v === 'cabin') {
      const K = sim.keys; const sp = 0.9 * dt; const yaw = look.yaw * D2R;
      const fw = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)), rt = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      if (K.KeyW) cabinEye.addScaledVector(fw, sp); if (K.KeyS) cabinEye.addScaledVector(fw, -sp);
      if (K.KeyD) cabinEye.addScaledVector(rt, sp); if (K.KeyA) cabinEye.addScaledVector(rt, -sp);
      if (K.KeyR) cabinEye.y += sp * 0.6; if (K.KeyF) cabinEye.y -= sp * 0.6;
      cabinEye.x = clamp(cabinEye.x, -1.75, 0.25); cabinEye.z = clamp(cabinEye.z, -0.42, 0.42); cabinEye.y = clamp(cabinEye.y, 0.2, 0.78);
      eye = cabinEye.clone();
    }
    // head physics: g-load & vibration
    const nzB = F.accel || [0, 9.81, 0];
    const target = new THREE.Vector3(-(nzB[0]) * 0.0015, -(nzB[1] - 9.81) * 0.0018, -(nzB[2]) * 0.002);
    headOff.lerp(target, Math.min(1, dt * 6));
    const vib = (F.eng.running ? 0.0006 + (F.eng.rpm < 900 ? 0.0012 : 0) : 0) + (F.onGround ? Math.min(0.003, Math.hypot(F.vel[0], F.vel[2]) * 0.00012) * (F.surfaceType === 'grass' ? 3 : 1) : 0);
    eye.add(headOff).add(new THREE.Vector3(Math.sin(t * 87) * vib, Math.sin(t * 71 + 1) * vib, Math.sin(t * 93 + 2) * vib));
    camera.position.copy(eye.applyQuaternion(acQ).add(acPos));
    tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), look.yaw * D2R);
    tmpQ2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), look.pitch * D2R);
    camera.quaternion.copy(acQ).multiply(tmpQ).multiply(qBase).multiply(tmpQ2);
  } else if (v === 'orbit' || v === 'chase') {
    camera.near = 0.1;
    let yaw = orbit.yaw * D2R, pit = orbit.pitch * D2R;
    let base;
    if (v === 'chase') {
      // follow flight path heading smoothly
      const hdg = F.attitude.hdg;
      sim.chaseHdg = sim.chaseHdg == null ? hdg : sim.chaseHdg + ((((hdg - sim.chaseHdg) % 360) + 540) % 360 - 180) * Math.min(1, dt * 2.5);
      base = (sim.chaseHdg + 180) * D2R + (orbit.yaw - 200) * D2R;
      yaw = base;
    }
    const d = orbit.dist;
    if (v === 'chase') {
      camera.position.set(acPos.x + Math.sin(yaw) * Math.cos(pit) * d, acPos.y + Math.sin(pit) * d + 1.5, acPos.z - Math.cos(yaw) * Math.cos(pit) * d);
    } else {
      camera.position.set(acPos.x + Math.cos(yaw) * Math.cos(pit) * d, acPos.y + Math.sin(pit) * d, acPos.z + Math.sin(yaw) * Math.cos(pit) * d);
    }
    const gh = groundH(camera.position.x, camera.position.z) + 0.6; if (camera.position.y < gh) camera.position.y = gh;
    camera.up.set(0, 1, 0); camera.lookAt(acPos.x, acPos.y + 0.4, acPos.z);
  } else if (v === 'tower') {
    camera.near = 0.5;
    let best = null, bd = 1e12;
    for (const a of AIRPORTS) { const tp = towerEye(a); if (!tp) continue; const d = tp.distanceToSquared(acPos); if (d < bd) { bd = d; best = tp; } }
    if (!best) best = tmpV.set(acPos.x + 60, groundH(acPos.x + 60, acPos.z + 60) + 15, acPos.z + 60);
    camera.position.copy(best); camera.up.set(0, 1, 0); camera.lookAt(acPos);
    const dist = Math.sqrt(bd); camera.fov = clamp(2 * Math.atan(30 / dist) / D2R, 2, 60);
  } else if (v === 'flyby') {
    camera.near = 0.3;
    const vel = new THREE.Vector3(F.vel[0], F.vel[1], F.vel[2]);
    if (!flyby.pos || flyby.pos.distanceTo(acPos) > 700 || (vel.length() > 3 && tmpV.copy(flyby.pos).sub(acPos).dot(vel) < -vel.length() * 40)) {
      const ahead = vel.length() > 5 ? vel.clone().normalize().multiplyScalar(Math.max(150, vel.length() * 6)) : new THREE.Vector3(30, 0, 0);
      const side = new THREE.Vector3(-ahead.z, 0, ahead.x).normalize().multiplyScalar(22);
      flyby.pos = acPos.clone().add(ahead).add(side); flyby.pos.y = Math.max(flyby.pos.y + 4, groundH(flyby.pos.x, flyby.pos.z) + 1.7);
    }
    camera.position.copy(flyby.pos); camera.up.set(0, 1, 0); camera.lookAt(acPos);
    camera.fov = clamp(2 * Math.atan(14 / Math.max(1, flyby.pos.distanceTo(acPos))) / D2R, 8, 70);
  } else if (v === 'walk') {
    if (!walker.pos) { setView('cockpit', true); return updateCamera(dt, t); }
    camera.near = 0.05;
    const K = sim.keys; const sp = (K.ShiftLeft || K.ShiftRight ? 4 : 1.6) * dt; const yaw = walker.yaw * D2R;
    const fw = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), rt = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    if (K.KeyW) walker.pos.addScaledVector(fw, sp); if (K.KeyS) walker.pos.addScaledVector(fw, -sp);
    if (K.KeyD) walker.pos.addScaledVector(rt, sp); if (K.KeyA) walker.pos.addScaledVector(rt, -sp);
    walker.pos.y = groundH(walker.pos.x, walker.pos.z, F.pos[1] + 2) + 1.68 + Math.sin(t * 9) * 0.01 * ((K.KeyW || K.KeyS) ? 1 : 0);
    camera.position.copy(walker.pos);
    camera.quaternion.setFromEuler(new THREE.Euler(walker.pitch * D2R, walker.yaw * D2R, 0, 'YXZ'));
  }
  if (v !== 'tower' && v !== 'flyby') { /* keep user fov */ }
  camera.updateProjectionMatrix();
}

// ---------------- sync visuals ----------------
function syncAircraft(dt, t = 0) {
  const F = sim.fdm;
  aircraft.position.set(F.pos[0], F.pos[1], F.pos[2]);
  aircraft.quaternion.set(F.q[0], F.q[1], F.q[2], F.q[3]);
  animateAircraft(aircraft, F, dt, t);
}

// ---------------- HUD ----------------
const hudEls = {}; for (const id of ['dIas', 'dGs', 'dAlt', 'dAgl', 'dVs', 'dHdg', 'dAoa', 'dG', 'dRpm', 'dThr', 'dMix', 'dFlap', 'dTrim', 'dWind']) hudEls[id] = $(id);
function updateHUD() {
  const F = sim.fdm, att = F.attitude;
  const gs = Math.hypot(F.vel[0], F.vel[2]) / KT;
  const set = (k, v) => { if (hudEls[k]._v !== v) { hudEls[k].textContent = v; hudEls[k]._v = v; } };
  set('dIas', Math.round(F.ind.ias)); set('dGs', Math.round(gs)); set('dAlt', Math.round(F.ind.alt).toLocaleString()); set('dAgl', Math.round(F.agl / FT - 4).toLocaleString());
  set('dVs', (F.ind.vsi > 0 ? '+' : '') + Math.round(F.ind.vsi / 10) * 10); set('dHdg', String(Math.round(att.hdg) % 360).padStart(3, '0'));
  set('dAoa', F.tas > 15 ? ((F.alpha || 0) / D2R).toFixed(1) : '—'); set('dG', (F.nz || 1).toFixed(2)); set('dRpm', Math.round(F.eng.rpm)); set('dThr', Math.round(F.ctrl.throttle * 100));
  set('dMix', Math.round(F.ctrl.mixture * 100)); set('dFlap', Math.round(F.flapPos)); set('dTrim', (F.ctrl.trim > 0 ? '+' : '') + Math.round(F.ctrl.trim * 100));
  const w = sim.weather; set('dWind', `${String(w.windDir).padStart(3, '0')}/${w.windKt}`);
  $('apChip').classList.toggle('hidden', !sim.av.ap.on); if (sim.av.ap.on) $('apChip').textContent = sim.fdm.aircraft.apRollOnly ? `WING LVL ${sim.av.ap.lat === 'ROL' ? (sim.av.ap.rollSel ? 'TURN ' + (sim.av.ap.rollSel > 0 ? 'R' : 'L') + Math.abs(sim.av.ap.rollSel) : 'LVL') : sim.av.ap.lat}${sim.av.ap.lat === 'NAV' ? ' ' + sim.av.gps.src : ''}` : `AP ${sim.av.ap.lat} ${sim.av.ap.vert}${sim.av.ap.vert === 'VS' ? ' ' + sim.av.ap.vsSel : ''}`;
  $('brakeChip').classList.toggle('hidden', !F.ctrl.parkBrake);
  $('simRate').textContent = sim.simRate + '×';
  $('imcChip').classList.toggle('hidden', !env.inCloud);
}
function updateTip() {
  const tip = $('tip');
  if (look.dragging) { tip.classList.add('hidden'); return; }
  const h = panelHit(mouse.x, mouse.y);
  if (h && h.tip) { tip.textContent = typeof h.tip === 'function' ? h.tip() : h.tip; tip.style.left = mouse.x + 'px'; tip.style.top = mouse.y + 'px'; tip.classList.remove('hidden'); canvas.style.cursor = 'pointer'; }
  else { tip.classList.add('hidden'); canvas.style.cursor = mouse.yoke ? 'crosshair' : 'default'; }
}

function toggleATC(force) {
  if (!sim.atc.enabled) {
    toast('ATC communications are disabled in setup');
    return;
  }
  const panel = $('atcPanel');
  const on = force ?? panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !on);
  if (on) updateATCPanel(true);
}

let atcSig = '';
function updateATCPanel(force) {
  const atc = sim.atc;
  const opts = [...atc.options, ...atc.extraOptions];
  const sig = atc.status + '|' + atc.transmission + '|' + (atc.log[0]?.id || 0) + '|' + opts.map((o) => o.label).join(',');
  if (!force && sig === atcSig) return;
  atcSig = sig;
  $('atcStatus').textContent = atc.status;
  $('atcSpeaker').textContent = atc.speaker;
  $('atcMessage').textContent = atc.transmission;
  const log = $('atcLog');
  log.innerHTML = atc.log.map((line) => `<div class="atcLine ${line.speaker === 'YOU' ? 'you' : line.ai ? 'ai' : ''}"><b>${line.speaker}</b><span>${line.text}</span></div>`).join('');
  log.scrollTop = 0; // newest first
  const options = $('atcOptions');
  options.replaceChildren();
  for (const option of opts) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = option.label;
    button.onclick = () => { atc.act(option.action, sim); updateATCPanel(true); sim.panelDirty = true; };
    options.appendChild(button);
  }
}

$('atcClose').onclick = () => toggleATC(false);
$('failureChip').onclick = () => toggleFailurePanel();
$('failureClose').onclick = () => toggleFailurePanel(false);
$('triggerFailure').onclick = () => triggerFailure(sim.activeFailure || readSetup().failureScenario);
$('clearFailure').onclick = clearFailure;

// ---------------- map UI ----------------
const mapC = $('map'), miniC = $('mini');
const mapView = { mpp: 30, center: null, follow: true, drag: null };
function toggleMap(force) {
  const on = force ?? $('mapWrap').classList.contains('hidden');
  $('mapWrap').classList.toggle('hidden', !on);
  if (on) { mapC.width = window.innerWidth * Math.min(2, devicePixelRatio); mapC.height = window.innerHeight * Math.min(2, devicePixelRatio); }
}
mapC.addEventListener('pointerdown', (e) => { mapView.drag = [e.clientX, e.clientY]; mapC.style.cursor = 'grabbing'; });
window.addEventListener('pointerup', () => { mapView.drag = null; mapC.style.cursor = 'grab'; });
mapC.addEventListener('pointermove', (e) => {
  if (!mapView.drag) return; const dx = e.clientX - mapView.drag[0], dy = e.clientY - mapView.drag[1]; mapView.drag = [e.clientX, e.clientY];
  if (!mapView.center) mapView.center = [sim.fdm.pos[0], sim.fdm.pos[2]];
  mapView.follow = false; mapView.center[0] -= dx * mapView.mpp; mapView.center[1] -= dy * mapView.mpp;
});
mapC.addEventListener('wheel', (e) => { e.preventDefault(); mapView.mpp = clamp(mapView.mpp * (1 + Math.sign(e.deltaY) * 0.15), 3, 160); }, { passive: false });
mapC.addEventListener('dblclick', (e) => {
  const c = mapView.follow || !mapView.center ? [sim.fdm.pos[0], sim.fdm.pos[2]] : mapView.center;
  const x = c[0] + (e.clientX - window.innerWidth / 2) * mapView.mpp, z = c[1] + (e.clientY - window.innerHeight / 2) * mapView.mpp;
  const F = sim.fdm; const gh = heightAt(x, z);
  const air = !F.onGround || F.agl > 5;
  const alt = air ? Math.max(F.pos[1], gh + 450) : gh + 1.25;
  const spd = air ? Math.max(90, F.tas / KT) : 0;
  const hdg = F.attitude.hdg;
  const keep = { thr: F.ctrl.throttle, mix: F.ctrl.mixture, sys: { ...F.sys }, eng: { ...F.eng }, trim: F.ctrl.trim };
  F.reset({ pos: [x, alt, z], hdg, speedKt: spd, onGround: !air, pitch: 2 });
  Object.assign(F.sys, keep.sys); Object.assign(F.eng, keep.eng); F.ctrl.throttle = keep.thr; F.ctrl.mixture = keep.mix; F.ctrl.trim = keep.trim; F.ctrl.parkBrake = false;
  if (air) F.trimAir(0);
  F.kollsman = Math.round(sim.weather.qnhInHg * 100) / 100;
  if (terrain) terrain.warm(new THREE.Vector3(x, alt, z), alt - gh);
  if (airports?.update) airports.update({ x, z });
  mmap.track = []; mapView.follow = true; mapView.center = null;
  toast('Repositioned');
});
$('mapCenter').onclick = () => { mapView.follow = true; mapView.center = null; };
$('mapRot').onclick = () => { mmap.northUp = !mmap.northUp; $('mapRot').textContent = mmap.northUp ? 'Follow' : 'North up'; };
function drawMaps() {
  if (!mmap) return;
  mmap.build(3);
  if (!$('mapWrap').classList.contains('hidden')) {
    const g = mapC.getContext('2d'); const s = mapC.width / window.innerWidth;
    g.setTransform(s, 0, 0, s, 0, 0);
    mmap.draw(g, window.innerWidth, window.innerHeight, sim, { mpp: mapView.mpp, center: mapView.follow ? null : mapView.center });
    const F = sim.fdm; const r1 = sim.av.r1;
    let near = null, bd = 1e12; for (const a of AIRPORTS) { const d = Math.hypot(a.x - F.pos[0], a.z - F.pos[2]); if (d < bd) { bd = d; near = a; } }
    const brg = (Math.atan2(near.x - F.pos[0], -(near.z - F.pos[2])) / D2R + 360) % 360;
    $('mapInfo').textContent = `POS  ${(F.pos[0] / 1852).toFixed(1)}E ${(-F.pos[2] / 1852).toFixed(1)}N NM\nALT  ${Math.round(F.ind.alt)} ft   GS ${Math.round(Math.hypot(F.vel[0], F.vel[2]) / KT)} kt   TRK ${String(Math.round((Math.atan2(F.vel[0], -F.vel[2]) / D2R + 360) % 360)).padStart(3, '0')}°\n${near.icao}  ${String(Math.round(brg)).padStart(3, '0')}° / ${(bd / 1852).toFixed(1)} NM   elev ${Math.round(near.runways[0].elev / FT)} ft\nNAV1 ${sim.av.nav1.active.toFixed(2)} ${r1.valid ? (r1.ident || '') + (r1.dme != null ? '  DME ' + r1.dme.toFixed(1) : '') : '— no signal'}`;
  }
  if (!miniC.classList.contains('hidden')) {
    const g = miniC.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0);
    g.save(); g.beginPath(); g.arc(220, 220, 220, 0, Math.PI * 2); g.clip();
    mmap.draw(g, 440, 440, sim, { mpp: 28, mini: true, heading: sim.fdm.attitude.hdg });
    g.restore();
  }
}

// ---------------- menu / pause / crash ----------------
function showMenu(on) {
  $('menu').classList.toggle('hidden', !on);
  if (on) { $('fly').textContent = sim.started ? 'Apply & restart' : 'Fly'; if (sim.started && !$('resume')) { const b = document.createElement('button'); b.id = 'resume'; b.type = 'button'; b.textContent = 'Resume'; b.onclick = () => { showMenu(false); togglePause(false); }; $('fly').after(b); } }
}
function togglePerfDetail() { $('fps').classList.toggle('hidden'); }
$('perfChip')?.addEventListener('click', togglePerfDetail);
function togglePause(force) { sim.paused = force ?? !sim.paused; $('pauseChip').classList.toggle('hidden', !sim.paused); }
$('fly').onclick = () => {
  sim.sound.start();
  applySetup(readSetup());
  showMenu(false); $('hud').classList.remove('hidden'); $('crash').classList.add('hidden');
  sim.started = true; sim.panelDirty = true; togglePause(false);
  setView(sim.view === 'walk' ? 'cockpit' : sim.view);
  toast(sim.fdm.eng.running ? 'Press ? for controls.  Mixture, trim and flaps are yours.' : `Parked cold & dark${sim.taxi ? ' — taxi to Rwy ' + sim.taxi.route.rwy + ' via ' + sim.taxi.route.viaText : ''}. Press H for the checklist and engine-start guide, T for the taxi line.`, 7000);
  canvas.focus?.();
};
$('showHelp').onclick = () => setHelp(true);
$('helpClose').onclick = () => setHelp(false);
// the controls window pauses the simulation while it is open (and resumes only if it did the pausing)
let helpPaused = false, ctlUI = null;
function setHelp(on) {
  const el = $('help');
  if (on) {
    if (!ctlUI) ctlUI = buildControlsUI($('ctlSettings'), { toast, onChange: updateKeyNote });
    updateKeyNote();
    el.classList.remove('hidden');
    if (sim.started && !sim.paused) { togglePause(true); helpPaused = true; }
    sim.keys = {};
  } else {
    ctlUI?.stop();
    el.classList.add('hidden');
    if (helpPaused) { helpPaused = false; if ($('menu').classList.contains('hidden')) togglePause(false); }
    canvas.focus?.();
  }
}
function updateKeyNote() {
  const n = changedCount(); const note = $('keyNote');
  if (note) note.textContent = n ? `${n} key${n > 1 ? 's' : ''} customised — the list below shows the defaults; see Key bindings for yours.` : 'Simulation paused while this window is open.';
}
for (const b of document.querySelectorAll('#help .helpTab')) b.addEventListener('click', () => {
  for (const x of document.querySelectorAll('#help .helpTab')) x.classList.toggle('on', x === b);
  $('helpRef').classList.toggle('hidden', b.dataset.tab !== 'ref'); $('ctlSettings').classList.toggle('hidden', b.dataset.tab !== 'ctl');
  if (b.dataset.tab === 'ctl' && !ctlUI) ctlUI = buildControlsUI($('ctlSettings'), { toast, onChange: updateKeyNote });
});
$('retry').onclick = () => { applySetup(lastSetup); $('crash').classList.add('hidden'); togglePause(false); };
$('toMenu').onclick = () => { $('crash').classList.add('hidden'); showMenu(true); };

// ---------------- main loop ----------------
const MANUAL = new URLSearchParams(location.search).has('manual');
let last = performance.now(), simT = 0, panelT = 0, frames = 0, fpsT = 0, fpsVal = 0;
const camPos = new THREE.Vector3();
function frame(dtReal) {
  const F = sim.fdm;
  const dt = Math.min(0.05, dtReal);
  if (sim.started) updateTaxiMap(sim);
  if (sim.started && !sim.paused) {
    updateControls(dt);
    if (sim.failurePending) {
      sim.failureDelay -= dt * sim.simRate;
      if (sim.failureDelay <= 0) {
        const type = sim.failurePending;
        sim.failurePending = null;
        triggerFailure(type);
      }
    }
    // wind with gusts
    const gust = sim.weather.turb * 0.25 * (Math.sin(simT * 0.7) * 0.5 + Math.sin(simT * 1.9 + 1) * 0.3 + Math.sin(simT * 0.23) * 0.2);
    F.env.gustFactor = gust;
    const E = F.eff || {}, av = sim.av;
    const powered = { nav1: !!E.com1 && av.com1.on !== false, nav2: !!E.com2 && av.com2.on !== false, ap: !!E.ap, adf: !!E.adf, gps: !!E.gps };
    if (sim.panel) sim.panel.animate(dt);
    sim.apCmd = sim.av.update(F, dt * sim.simRate, powered);
    physics(dt);
    if (sim.gs) { sim.gs.update(dt * sim.simRate, simT); sim.gs.applyPush(); }
    sim.atc.update(sim, dt * sim.simRate);
    sim.tower?.update(sim, dt * sim.simRate);
    sim.checklist?.update(dt);
    updateTaxiGuide(dt);
    simT += dt * sim.simRate;
    sim.timeOfDay = (lastSetup?.tod ?? 10) + simT / 3600;
    if (F.crashed && !sim.crashShown) { sim.crashShown = true; $('crashWhy').textContent = F.crashed; $('crash').classList.remove('hidden'); }
    mmap.addTrack(F.pos);
  }
  const t = performance.now() / 1000;
  syncAircraft(dt, t);
  animateLookTo(dt);
  updateCamera(dt, t);
  updateHighlight(t);
  if (sim.camOverride) { const o = sim.camOverride; camera.position.set(o.p[0], o.p[1], o.p[2]); camera.lookAt(o.t[0], o.t[1], o.t[2]); }
  camPos.copy(camera.position);
  // world streaming
  const agl = camPos.y - heightAt(camPos.x, camPos.z);
  // predictive prefetch: also load what lies ahead along the flight path
  const vel = sim.fdm.vel || [0, 0, 0];
  const ahead = { x: camPos.x + (vel[0] || 0) * PREFETCH_S, z: camPos.z + (vel[2] || 0) * PREFETCH_S };
  if (airports?.update && (airportStreamTick = (airportStreamTick + 1) % 30) === 0) airports.update(camPos, ahead);
  if (terrain) {
    terrain.update(camPos, agl, 6, false, { x: camPos.x + (vel[0] || 0) * 20, y: camPos.y + (vel[1] || 0) * 20, z: camPos.z + (vel[2] || 0) * 20 });
    if (terrainMat) terrainMat.userData.uniforms.uCam.value.copy(camPos);
  }
  if (forest && rocks) { forest.update(camPos, 3); rocks.update(camPos, 3); }
  if (grass) grass.update(camPos, agl);
  if (ground) ground.update(camPos, agl);
  (orthoMgr ||= new OrthoManager(renderer)).update(camPos);
  if (blades) blades.update(camPos, agl, t, sim.windVec, camera);
  if (crops) crops.update(camPos, agl);
  if (life) life.update(camPos, sim.paused ? 0 : dt * (sim.started ? sim.simRate : 1), t);
  if (scenery) scenery.update(camPos);
  if (traffic) { traffic.setNight(sim.night); traffic.update(sim.paused ? 0 : dt * (sim.started ? sim.simRate : 1), camPos); }
  env.update(camera, new THREE.Vector3(F.pos[0], F.pos[1], F.pos[2]), simT, dt);
  if (airports) airports.updateLights(camPos, sim.night, t);
  if (airports?.updateServices) airports.updateServices(sim.paused ? 0 : dt * (sim.started ? sim.simRate : 1), camPos, t);
  tickGSE(t, sim.night);
  // windsocks
  const w = sim.windVec || [0, 0, 0]; const ws = Math.hypot(w[0], w[2]);
  for (const a of AIRPORTS) for (const sock of a.windsocks || (a.windsock ? [a.windsock] : [])) { const dir = Math.atan2(-w[2], w[0]); sock.rotation.set(0, dir + Math.sin(t * 2.3) * 0.08 * Math.min(1, ws / 3), -(1 - Math.min(1, ws / 7.7)) * 1.2 + Math.sin(t * 3.1) * 0.03); }
  // panel texture
  const inside = sim.view === 'cockpit' || sim.view === 'cabin';
  panelT += dt;
  if (sim.panel && (inside || !sim.started) && (panelT > (perf.rating === 'poor' ? 1 / 12 : perf.rating === 'ok' ? 1 / 20 : 1 / 30) || sim.panelDirty)) {
    panelT = 0; sim.panelDirty = false;
    sim.panel.draw(sim, t);
    aircraft.userData.parts.panelTex.needsUpdate = true;
  }
  if (inside) updateTip(); else $('tip').classList.add('hidden');
  sim.sound.update(F, sim.view, sim.simRate);
  if (mmap && !mmap.done) mmap.build(2);
  if (sim.started) {
    updateHUD();
    drawMaps();
    if (!$('atcPanel').classList.contains('hidden')) updateATCPanel();
  }
  syncCesiumCamera(camera);
  if ((sim._cq = (sim._cq || 0) + 1) % 60 === 0) setCesiumQuality(perf.auto ? perf.scale : 1);
  renderer.shadowMap.needsUpdate = perf.shadowThisFrame();
  if (!sim.noRender) renderer.render(scene, camera);
  perf.frame(dtReal, { extra: terrain ? `tiles ${terrain.visibleCount}${terrain.pending ? ' (+' + terrain.pending + ' queued)' : ''}` : '' });
}
sim.frame = frame;

// ---------------- help: checklists, "show me", taxi line ----------------
sim.toast = toast;
// pulsing marker that shows where a control is (works for panel switches and 3D knobs/levers)
const hlSprite = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  g.strokeStyle = '#ffd600'; g.lineWidth = 10; g.shadowColor = '#ffd600'; g.shadowBlur = 16; g.beginPath(); g.arc(64, 64, 46, 0, Math.PI * 2); g.stroke();
  const m = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, depthWrite: false, transparent: true });
  const sp = new THREE.Sprite(m); sp.renderOrder = 999; sp.visible = false; return sp;
})();
var hlUntil = 0, hlSize = 0.05, lookTo = null;
function showControl(id, fromGuide = false) {
  if (!sim.panel || !aircraft) return false;
  if (sim.view !== 'cockpit' && sim.view !== 'cabin') setView('cockpit');
  syncAircraft(0); aircraft.updateMatrixWorld(true);
  const L = sim.panel.locate(id); if (!L) { if (!fromGuide) toast('That control is not on this panel'); return false; }
  const F = sim.fdm, q = new THREE.Quaternion(F.q[0], F.q[1], F.q[2], F.q[3]);
  const d = L.world.clone().sub(new THREE.Vector3(F.pos[0], F.pos[1], F.pos[2])).applyQuaternion(q.clone().invert()).sub(EYE);
  const len = d.length() || 1;
  lookTo = { yaw: clamp(Math.atan2(-d.z, d.x) / D2R, -170, 170), pitch: clamp(Math.asin(d.y / len) / D2R, -80, 70) };
  if (!hlSprite.parent) scene.add(hlSprite);
  hlSprite.position.copy(L.world); hlSize = L.canvas ? Math.max(0.03, L.canvas[2] / 1900 * 2.4) : Math.max(0.035, L.size || 0.05);
  hlUntil = performance.now() + 6000; hlSprite.visible = true;
  if (L.canvas) sim.panel.hl = { x: L.canvas[0], y: L.canvas[1], r: L.canvas[2], until: performance.now() + 6000 };
  sim.panelDirty = true;
  return true;
}
sim.showControl = showControl;
function animateLookTo(dt) {
  if (!lookTo) return;
  const k = Math.min(1, dt * 5);
  look.yaw += (lookTo.yaw - look.yaw) * k; look.pitch += (lookTo.pitch - look.pitch) * k;
  if (Math.abs(lookTo.yaw - look.yaw) < 0.2 && Math.abs(lookTo.pitch - look.pitch) < 0.2) lookTo = null;
}
function updateHighlight(t) {
  if (!hlSprite.visible) return;
  if (performance.now() > hlUntil || !(sim.view === 'cockpit' || sim.view === 'cabin')) { hlSprite.visible = false; return; }
  const s = hlSize * (1 + 0.18 * Math.sin(t * 7)); hlSprite.scale.set(s, s, s);
}
const checklist = new Checklist(sim, showControl); sim.checklist = checklist;
$('cklBtn').onclick = () => checklist.toggle();
// stop the look-around drag from starting when using the checklist / buttons
for (const id of ['ckl', 'cklBtn', 'taxiBtn', 'tmapBtn']) $(id).addEventListener('mousedown', (e) => e.stopPropagation());

// magenta taxi line painted on the real taxiways from the ramp to the hold-short point
var taxiLine = null; // var: applySetup may run before this line during load
function buildTaxiLine() {
  if (taxiLine) { scene.remove(taxiLine); taxiLine.traverse((o) => { o.geometry?.dispose(); }); taxiLine = null; }
  $('taxiBtn').classList.toggle('hidden', !sim.taxi); $('taxiChip').classList.add('hidden');
  if (!sim.taxi) return;
  const P = sim.taxi.route.pts, pts = [];
  for (let k = 1; k < P.length; k++) { const a = P[k - 1], b = P[k], L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L / 4)); for (let i = k === 1 ? 0 : 1; i <= n; i++) pts.push({ x: a.x + (b.x - a.x) * i / n, z: a.z + (b.z - a.z) * i / n }); }
  const yOf = (x, z) => groundQuery(x, z).h + 0.07;
  const pos = [], idx = [], W = 0.45;
  pts.forEach((p, i) => {
    const q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)]; let dx = q.x - o.x, dz = q.z - o.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const y = yOf(p.x, p.z); pos.push(p.x - dz * W, y, p.z + dx * W, p.x + dz * W, y, p.z - dx * W);
    if (i) { const j = i * 2; idx.push(j - 2, j - 1, j, j - 1, j + 1, j); }
  });
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff2bd6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, depthWrite: false, transparent: true, opacity: 0.92 });
  taxiLine = new THREE.Group(); taxiLine.add(new THREE.Mesh(geo, mat));
  // direction chevrons every ~16 m
  const cpos = [];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]; acc += Math.hypot(b.x - a.x, b.z - a.z); if (acc < 16) continue; acc = 0;
    let dx = b.x - a.x, dz = b.z - a.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; const y = yOf(b.x, b.z) + 0.01;
    const tip = [b.x + dx * 1.6, y, b.z + dz * 1.6], l0 = [b.x - dz * 1.3 - dx * 0.6, y, b.z + dx * 1.3 - dz * 0.6], r0 = [b.x + dz * 1.3 - dx * 0.6, y, b.z - dx * 1.3 - dz * 0.6];
    cpos.push(...tip, ...l0, ...r0);
  }
  if (cpos.length) { const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3)); taxiLine.add(new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, depthWrite: false }))); }
  // hold-short marker: yellow bar across the route at the end
  { const e = pts[pts.length - 1], o = pts[Math.max(0, pts.length - 3)]; let dx = e.x - o.x, dz = e.z - o.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; const y = yOf(e.x, e.z) + 0.02;
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(14, 1.2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd400, polygonOffset: true, polygonOffsetFactor: -6, depthWrite: false }));
    bar.position.set(e.x, y, e.z); bar.rotation.y = -Math.atan2(dz, dx) + Math.PI / 2; taxiLine.add(bar); }
  taxiLine.renderOrder = 2; taxiLine.traverse((o) => { o.renderOrder = 2; }); taxiLine.visible = sim.taxi.show;
  taxiLine.userData.snapped = false;
  scene.add(taxiLine); snapTaxiLine();
  $('taxiBtn').classList.toggle('on', sim.taxi.show);
}
// The OSM apron / taxiway meshes are triangulated polygons, so their surface is not exactly the terrain height
// under every point. Once those meshes exist, drop every vertex of the guide line onto the real pavement surface.
var snapRay = null;
function snapTaxiLine() {
  if (!taxiLine || taxiLine.userData.snapped) return;
  const pave = []; scene.traverse((o) => { if (o.isMesh && o.userData.pave) pave.push(o); });
  if (!pave.length) return;
  snapRay = snapRay || new THREE.Raycaster(); const down = new THREE.Vector3(0, -1, 0), org = new THREE.Vector3();
  let hits = 0;
  // the pavement hit closest to the terrain-based height (ignores bridges / stacked polygons)
  const nearHit = (y0) => { let best = null; for (const h of snapRay.intersectObjects(pave, false)) if (Math.abs(h.point.y - y0) < 2.5 && (!best || Math.abs(h.point.y - y0) < Math.abs(best.point.y - y0))) best = h; return best; };
  taxiLine.traverse((o) => {
    if (!o.isMesh) return; const pa = o.geometry.attributes.position;
    if (!pa) return;
    if (o.geometry.type === 'PlaneGeometry') {
      org.set(o.position.x, o.position.y + 30, o.position.z); snapRay.set(org, down); snapRay.far = 60;
      const h = nearHit(o.position.y - 0.09); if (h) { o.position.y = Math.max(o.position.y, h.point.y + 0.09); hits++; }
      return;
    }
    for (let i = 0; i < pa.count; i++) {
      org.set(pa.getX(i), pa.getY(i) + 30, pa.getZ(i)); snapRay.set(org, down); snapRay.far = 60;
      const h = nearHit(pa.getY(i) - 0.08); if (h) { pa.setY(i, Math.max(pa.getY(i), h.point.y + 0.08)); hits++; }
    }
    pa.needsUpdate = true; o.geometry.computeBoundingSphere();
  });
  if (hits) taxiLine.userData.snapped = true;
}
function toggleTaxiLine() {
  if (!sim.taxi) { toast('No taxi route here — taxi lines are drawn from the GA ramp to the departure runway'); return; }
  sim.taxi.show = !sim.taxi.show; if (taxiLine) taxiLine.visible = sim.taxi.show;
  $('taxiBtn').classList.toggle('on', sim.taxi.show); $('taxiChip').classList.toggle('hidden', !sim.taxi.show);
  toast(sim.taxi.show ? `Taxi line ON — Rwy ${sim.taxi.route.rwy} via ${sim.taxi.route.viaText}` : 'Taxi line OFF');
}
$('taxiBtn').onclick = toggleTaxiLine;
$('tmapBtn').onclick = () => { $('tmapBtn').classList.toggle('on', toggleTaxiMap(undefined, sim)); };
var taxiT = 0;
function updateTaxiGuide(dt) {
  const tx = sim.taxi; if (!tx) return;
  taxiT += dt; if (taxiT < 0.4) return; taxiT = 0;
  snapTaxiLine();
  const F = sim.fdm, chip = $('taxiChip');
  if (!F.onGround || tx.done) { chip.classList.add('hidden'); return; }
  const p = routeProgress(tx.route, F.pos[0], F.pos[2]);
  const brg = (Math.atan2(p.tgt.x - F.pos[0], -(p.tgt.z - F.pos[2])) / D2R + 360) % 360;
  const rel = ((brg - F.attitude.hdg + 540) % 360) - 180;
  const turn = Math.abs(rel) < 12 ? 'ahead' : rel < 0 ? `turn left ${Math.round(-rel)}°` : `turn right ${Math.round(rel)}°`;
  const distTxt = p.rem > 1000 ? (p.rem / 1852).toFixed(1) + ' NM' : Math.round(p.rem / 0.3048 / 10) * 10 + ' ft';
  if (p.rem < 35) {
    chip.textContent = `HOLD SHORT RWY ${tx.route.rwy}`;
    if (!tx.holdToast) { tx.holdToast = true; toast(`Hold short of runway ${tx.route.rwy}. Set the parking brake and run the "Before takeoff" checklist (H), then call the tower (G).`, 8000); }
  } else chip.textContent = `TAXI RWY ${tx.route.rwy} · ${distTxt} · ${p.off > 25 ? 'off route — ' : ''}${turn}`;
  chip.classList.toggle('hidden', !tx.show);
  // once lined up on the runway, the route is finished
  if (p.rem < 35 && Math.hypot(F.vel[0], F.vel[2]) > 15) { tx.done = true; tx.show = false; if (taxiLine) taxiLine.visible = false; chip.classList.add('hidden'); $('taxiBtn').classList.remove('on'); }
}
function loop() {
  const now = performance.now(); const dt = (now - last) / 1000; last = now;
  if (sim.ready && !MANUAL) frame(dt);
  requestAnimationFrame(loop);
}
window.addEventListener('resize', () => { renderer.setSize(window.innerWidth, window.innerHeight); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); if (!$('mapWrap').classList.contains('hidden')) toggleMap(true); });

// test hooks
window.advanceTime = (ms) => { const steps = Math.max(1, Math.round(ms / (1000 / 60))); for (let i = 0; i < steps; i++) frame(1 / 60); };
window.render_game_to_text = () => {
  const F = sim.fdm, a = F.attitude;
  return JSON.stringify({
    coords: 'world x=east m, z=south m, y=up m (MSL)', ready: !!sim.ready, started: sim.started, paused: sim.paused, view: sim.view,
    pos: F.pos.map((v) => Math.round(v * 10) / 10), aglFt: Math.round((F.agl || 0) / FT), ias: Math.round(F.ind.ias), altFt: Math.round(F.ind.alt), vsFpm: Math.round(F.ind.vsi),
    hdg: Math.round(a.hdg), pitch: +a.pitch.toFixed(1), roll: +a.roll.toFixed(1), rpm: Math.round(F.eng.rpm), engine: F.eng.running, onGround: !!F.onGround,
    throttle: +F.ctrl.throttle.toFixed(2), flaps: F.flapPos.toFixed(0), crashed: F.crashed, ap: sim.av.ap.on ? sim.av.ap.lat + '/' + sim.av.ap.vert : 'off', stallWarn: F.stallWarn,
  });
};

requestAnimationFrame(loop);
