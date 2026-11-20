// Skyhawk — main loop, cameras, input, UI.
import * as THREE from 'three';
import { FDM, KT, FT, C172, C152 } from './fdm.js?v=20261121a';
import { qrot } from './math.js';
import { groundQuery, heightAt, AIRPORTS, NAVAIDS, fromLocal, toLocal, WATER_LEVEL } from './geo.js';
import { createTerrainMaterial, Terrain } from './terrain.js';
import { buildAircraft, animateAircraft } from './aircraft.js?v=20261121a';
import { Panel } from './panel.js?v=20261121a';
import { Avionics, ILS } from './avionics.js?v=20261121a';
import { Environment } from './env.js';
import { buildAirports, RockField, Forest, GrassField, buildTown } from './world.js';
import { buildLife } from './life.js';
import { MovingMap } from './map.js?v=20261121a';
import { Sound } from './audio.js';
import { setAniso } from './textures.js';
import { ATC } from './atc.js?v=20261121a';
import { initCesium, syncCesiumCamera, getCesiumElevationWorld, warmCesiumTerrain } from './cesium.js?v=20261120';

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
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  setAniso(Math.min(16, renderer.capabilities.getMaxAnisotropy()));
}
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.02, 90000);
scene.add(camera);

const sim = {
  fdm: new FDM(), av: new Avionics(), panel: null, keys: {}, view: 'cockpit', timeOfDay: 10, simRate: 1, paused: true, started: false,
  weather: { windDir: 250, windKt: 8, turb: 0.25, cover: 0.45, baseFt: 4500, visKm: 40, qnhInHg: 30.02, isa: 5 }, sound: new Sound(),
  groundServices: { active: false, airport: null },
};
window.sim = sim; sim.scene = scene; sim.renderer = renderer;
sim.atc = new ATC();
const f = () => sim.fdm;
sim.fdm.env.ground = groundQuery;
sim.ndb = NAVAIDS.find((n) => n.type === 'NDB');

function cesiumGroundQuery(x, z) {
  const local = groundQuery(x, z);
  const cesiumHeight = getCesiumElevationWorld(x, z);
  if (!Number.isFinite(cesiumHeight)) return local;
  const surface = cesiumHeight < WATER_LEVEL
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

// Streams airports (runways, buildings, lights, parked aircraft) in and out around the aircraft.
class LocalAirports {
  constructor(scene, buildAircraftFn) {
    this.scene = scene; this.buildAircraftFn = buildAircraftFn;
    this.loaded = new Map(); this.loading = new Map();
  }
  update(pos) {
    const jobs = [];
    for (const a of AIRPORTS) {
      const d = Math.hypot(a.x - pos.x, a.z - pos.z);
      if (d < LIGHT_AIRPORT_LOAD && !this.loaded.has(a.icao)) {
        if (!this.loading.has(a.icao)) {
          const job = buildAirports(this.scene, null, this.buildAircraftFn, null, [a])
            .then((r) => { this.loading.delete(a.icao); this.loaded.set(a.icao, r); })
            .catch((e) => { this.loading.delete(a.icao); console.warn('Airport load failed', a.icao, e); });
          this.loading.set(a.icao, job);
        }
        jobs.push(this.loading.get(a.icao));
      } else if (d > LIGHT_AIRPORT_UNLOAD && this.loaded.has(a.icao)) {
        this.loaded.get(a.icao).dispose();
        this.loaded.delete(a.icao);
      }
    }
    return Promise.all(jobs);
  }
  updateLights(camPos, night, t) { for (const r of this.loaded.values()) r.updateLights(camPos, night, t); }
}

let airportStreamTick = 0;
let env, terrain, terrainMat, aircraft, airports, rocks, forest, grass, town, life, mmap;
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
      progress(0.18, 'Sampling real-world airport elevations…');
      for (const a of AIRPORTS) {
        await warmCesiumTerrain(a.x, a.z, Math.max(a.len / 2 + 650, 1900), 300);
      }
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
    terrainMat = await createTerrainMaterial(
      (p) => progress(0.38 + p * 0.12, 'Loading terrain textures…'),
      loadMode === 'light' ? 512 : 1024,
    );
    terrain = loadMode === 'light'
      ? new Terrain(scene, terrainMat, { radius: LIGHT_RADIUS, maxTileSize: 4096, minTileSize: 256, lodScale: 1.0 })
      : new Terrain(scene, terrainMat);
    // haze reaches ~full opacity at the edge of the loaded area
    env.minFogDensity = loadMode === 'light' ? 2.0 / LIGHT_RADIUS : 0;
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
    progress(0.58, 'Building airports, runways and taxiways…');
    airports = await buildAirports(
      scene,
      null,
      buildAircraft,
      cesiumViewer ? getCesiumElevationWorld : null,
    );
    progress(0.66, 'Building airport terminals and hangars…');
    applySetup(readSetup(), true);
  }
  sim.ready = true;
  await new Promise((resolve) => requestAnimationFrame(resolve));

  if (!useLocalScenery) {
    progress(0.72, 'Using real-world terrain, roads and buildings…');
    progress(0.80, 'Loading real-world 3D scenery…');
    progress(0.86, 'Using live aerial road and city detail…');
  } else {
    if (loadMode === 'light') {
      progress(0.72, 'Loading lightweight airport surroundings…');
      progress(0.80, 'Using local terrain…');
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
      progress(0.86, 'Building towns and roads…');

      town = await buildTown(scene);
    }
  }
  progress(0.92, 'Adding vehicles and airport activity…');
  if (loadMode !== 'light') {
    life = await buildLife(scene);
    sim.life = life;
  }

  progress(0.95, 'World scene ready…');
  mmap = new MovingMap(); sim.mmap = mmap;
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
    cover: +$('clouds').value, baseFt: +$('cbase').value, visKm: +$('vis').value, qnhInHg: +$('qnh').value, isa: +$('isa').value, fuel: +$('fuel').value, quality: $('quality').value,
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
  sim.fdm.setAircraft(s.aircraftType === 'C152' ? C152 : C172);
  sim.atc.reset(s);
  sim.atc.enabled = s.atcEnabled !== false;
  sim.atc.trafficEnabled = s.aiTraffic !== false;
  sim.aiTrafficEnabled = s.aiTraffic !== false;
  if (life) life.setTrafficEnabled(sim.aiTrafficEnabled);
  sim.av.com1.active = sim.atc.frequency;
  const F = sim.fdm;
  sim.weather = { windDir: s.windDir, windKt: s.windKt, turb: s.turb, cover: s.cover, baseFt: s.baseFt, visKm: s.visKm, qnhInHg: s.qnhInHg, isa: s.isa };
  sim.timeOfDay = s.tod;
  const lightState = env.setTime(s.tod);
  sim.night = lightState.night;
  // quality
  const q = { high: [1.75, 4096, 1.0], balanced: [1.25, 2048, 0.65], perf: [0.75, 512, 0.18], lite: [0.6, 256, 0.08] }[s.quality] || [1.25, 2048, 0.65];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, q[0]));
  if (env.sun.shadow.mapSize.x !== q[1]) { env.sun.shadow.mapSize.set(q[1], q[1]); if (env.sun.shadow.map) { env.sun.shadow.map.dispose(); env.sun.shadow.map = null; } }
  if (forest) { forest.quality = q[2]; forest.lastKey = null; }
  if (rocks) { rocks.quality = q[2]; rocks.lastCell = null; }
  if (grass) { grass.quality = q[2]; grass.lastKey = null; }
  if (life) life.quality = q[2];
  sim.quality = s.quality;
  // spawn
  let pos, hdg, onGround = true, speed = 0, cold = false, pitch = 0, alt;
  const rwyStart = (a, end) => { const u = end === 0 ? -a.len / 2 + 35 : a.len / 2 - 35; const p = fromLocal(a, u, 0); return { p, hdg: end === 0 ? a.hdg : (a.hdg + 180) % 360 }; };
  let flapsInit = 0;
  switch (s.spawn) {
    case 'SFO28': { const r = rwyStart(airport('KSFO'), 0); pos = r.p; hdg = r.hdg; break; }
    case 'OAK12': { const r = rwyStart(airport('KOAK'), 1); pos = r.p; hdg = r.hdg; break; }
    case 'SJC30': { const r = rwyStart(airport('KSJC'), 0); pos = r.p; hdg = r.hdg; break; }
    case 'HWD28': { const r = rwyStart(airport('KHWD'), 0); pos = r.p; hdg = r.hdg; break; }
    case 'SQL30': { const r = rwyStart(airport('KSQL'), 0); pos = r.p; hdg = r.hdg; break; }
    case 'LVK25': { const r = rwyStart(airport('KLVK'), 0); pos = r.p; hdg = r.hdg; break; }
    case 'CCR32': { const r = rwyStart(airport('KCCR'), 0); pos = r.p; hdg = r.hdg; break; }
    case 'SFOramp': { const a = airport('KSFO'); const p = fromLocal(a, a.apron.u + 30, a.apron.v + 10); pos = p; hdg = (a.hdg + 90) % 360; cold = true; break; }
    case 'ILS28': { const i = ILS.find((x) => x.ident === 'ISFO') || ILS[0]; const d = 8 * 1852; const c = i.course * D2R; pos = { x: i.thr.x - Math.sin(c) * d, z: i.thr.z + Math.cos(c) * d }; hdg = i.course; onGround = false; speed = 95; alt = Math.max(3000 * FT + (s.qnhInHg - 29.92) * 1000 * FT, i.elev + Math.tan(3 * D2R) * d + 30); pitch = 2; break; }
    case 'cruise': { pos = { x: -6000, z: 9000 }; hdg = 75; onGround = false; speed = 108; alt = 5500 * FT; pitch = 1.5; break; }
    default: { const r = rwyStart(airport('KSFO'), 1); pos = r.p; hdg = r.hdg; }
  }
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
  if (s.spawn === 'ILS28' || s.spawn.startsWith('SFO')) { av.nav1.active = 111.55; av.nav1.obs = 284; av.nav1.standby = 115.8; }
  if (s.spawn === 'OAK12') { av.nav1.active = 109.30; av.nav1.obs = 120; }
  if (s.spawn === 'SJC30') { av.nav1.active = 110.30; av.nav1.obs = 300; }
  // weather
  const wr = s.windDir * D2R, ws = s.windKt * KT;
  sim.windVec = [-Math.sin(wr) * ws, 0, Math.cos(wr) * ws];
  env.setWeather({ cover: s.cover, base: s.baseFt * FT + 0, visKm: s.visKm, windDir: s.windDir, windKt: s.windKt });
  F.env.wind = sim.windVec.slice();
  if (town) town.setNight(sim.night);
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
  const k = e.key; const F = sim.fdm, S = F.sys, av = sim.av;
  sim.keys[e.code] = true; sim.keys.Shift = e.shiftKey;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space', 'Slash'].includes(e.code)) e.preventDefault();
  if (!sim.started) return;
  if (e.repeat && !['KeyI', 'BracketLeft', 'BracketRight'].includes(e.code)) { if (e.shiftKey && e.code.startsWith('Arrow')) {} else return; }
  const sh = e.shiftKey;
  switch (e.code) {
    case 'Escape': if (!$('help').classList.contains('hidden')) { $('help').classList.add('hidden'); break; } if (!$('mapWrap').classList.contains('hidden')) { toggleMap(false); break; } togglePause(); if (sim.paused) showMenu(true); break;
    case 'KeyF':
      if (sh) toggleFailurePanel();
      else if (!walkView()) { F.ctrl.flaps = Math.min(3, F.ctrl.flaps + 1); toast('Flaps ' + ['UP', '10°', '20°', 'FULL'][F.ctrl.flaps]); }
      break;
    case 'KeyV': if (sh) { S.avionics = !S.avionics; S.avionics2 = S.avionics; toast('Avionics ' + (S.avionics ? 'ON' : 'OFF')); } else { F.ctrl.flaps = Math.max(0, F.ctrl.flaps - 1); toast('Flaps ' + ['UP', '10°', '20°', 'FULL'][F.ctrl.flaps]); } break;
    case 'KeyP': F.ctrl.parkBrake = !F.ctrl.parkBrake; toast('Parking brake ' + (F.ctrl.parkBrake ? 'SET' : 'RELEASED')); break;
    case 'KeyJ':
      if (walkView()) break;
      {
        let nearest = null, nearestDistance = Infinity;
        for (const a of AIRPORTS) {
          const distance = Math.hypot(a.x - F.pos[0], a.z - F.pos[2]);
          if (distance < nearestDistance) { nearestDistance = distance; nearest = a; }
        }
        if (nearestDistance >= 300) {
          toast('No ground service stand nearby', 3000);
        } else if (!F.onGround || Math.hypot(F.vel[0], F.vel[2]) >= 1) {
          toast('Ground services require the aircraft stopped on the ground', 3000);
        } else if (sh) {
          sim.groundServices = { active: false, airport: null };
          F.ctrl.parkBrake = false;
          toast(`${nearest.icao} ground services disconnected`, 3000);
        } else {
          sim.groundServices = { active: true, airport: nearest.icao };
          F.ctrl.parkBrake = true;
          S.avionics = true;
          toast(`${nearest.icao} ground services: GPU, baggage, stairs, catering and tug ready`, 4000);
        }
      }
      break;
    case 'KeyI': if (sh) S.mags = Math.max(0, S.mags - 1); else { S.mags = Math.min(4, S.mags + 1); if (S.mags === 4) sim.startHeld = 0.25; } toast('Ignition ' + ['OFF', 'R', 'L', 'BOTH', 'START'][S.mags], 900); break;
    case 'KeyM': if (sh) { const on = !(S.master && S.alternator); S.master = on; S.alternator = on; toast('Master ' + (on ? 'ON' : 'OFF')); } else toggleMap(); break;
    case 'KeyE': if (sh) autoStart(); break;
    case 'KeyL': if (sh) { S.taxi = !S.taxi; toast('Taxi light ' + (S.taxi ? 'ON' : 'OFF')); } else { S.landing = !S.landing; toast('Landing light ' + (S.landing ? 'ON' : 'OFF')); } break;
    case 'KeyO': if (sh) { S.nav = !S.nav; toast('Nav lights ' + (S.nav ? 'ON' : 'OFF')); } else { S.strobe = !S.strobe; toast('Strobes ' + (S.strobe ? 'ON' : 'OFF')); } break;
    case 'KeyK': F.kollsman = Math.round(sim.weather.qnhInHg * 100) / 100; toast('Altimeter ' + F.kollsman.toFixed(2)); break;
    case 'KeyD': if (!walkView()) { F.gyro.hiDrift = ((F.attitude.hdg - F.gyro.compass + 540) % 360) - 180; toast('Heading indicator set to compass'); } break;
    case 'KeyA': if (!walkView() && !sh) { if (!F.eff?.ap) { toast(F.aircraft.carb ? 'The Cessna 152 has no autopilot' : 'Autopilot has no power (AVIONICS BUS 2 / AUTOPILOT breaker)'); break; } av.apButton('AP', F); toast(av.ap.on ? 'Autopilot ENGAGED (ROL/VS)' : 'Autopilot DISCONNECTED'); } else if (sh && !walkView()) { /* reserved */ } break;
    case 'KeyH': if (sh) { av.apButton('HDG', F); toast('AP ' + av.ap.lat); } break;
    case 'KeyN': if (sh) { av.apButton('NAV', F); toast('AP ' + av.ap.lat); } else { $('mini').classList.toggle('hidden'); } break;
    case 'KeyR':
      if (sh) { av.apButton('APR', F); toast('AP ' + av.ap.lat + (av.ap.gsArmed ? ' (GS armed)' : '')); }
      else if (walkView()) {}
      else {
        let nearest = null, nearestDistance = Infinity;
        for (const a of AIRPORTS) {
          const distance = Math.hypot(a.x - F.pos[0], a.z - F.pos[2]);
          if (distance < nearestDistance) { nearestDistance = distance; nearest = a; }
        }
        if (F.onGround && nearestDistance < 300 && Math.hypot(F.vel[0], F.vel[2]) < 1) {
          const capacity = F.aircraft.fuelCapGal;
          const before = S.fuelL + S.fuelR;
          S.fuelL = capacity; S.fuelR = capacity;
          const added = Math.max(0, capacity * 2 - before);
          toast(`Ground fuel service · ${nearest.icao} · +${added.toFixed(1)} gal (${(capacity * 2).toFixed(1)} gal total)`, 3000);
          sim.panelDirty = true;
        } else {
          toast(nearestDistance < 300 ? 'Refuel only while stopped on the ground' : 'No ground fuel service nearby', 3000);
        }
      }
      break;
    case 'KeyT': if (sh) { av.apButton('ALT', F); toast('AP ' + av.ap.vert); } break;
    case 'KeyY': mouse.yoke = !mouse.yoke; $('yokeChip').classList.toggle('hidden', !mouse.yoke); $('cross').classList.toggle('hidden', !mouse.yoke); toast(mouse.yoke ? 'Mouse yoke ON — mouse position = yoke' : 'Mouse yoke OFF'); break;
    case 'KeyG': toggleATC(); break;
    case 'KeyU': $('strip').classList.toggle('hidden'); break;
    case 'KeyC': setView(views[(views.indexOf(sim.view) + 1) % views.length]); break;
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6': case 'Digit7': setView(views[+e.code.slice(5) - 1]); break;
    case 'Digit9': sim.simRate = sim.simRate >= 4 ? 1 : sim.simRate * 2; toast('Sim rate ' + sim.simRate + '×'); break;
    case 'Space': look.yaw = 0; look.pitch = -10; camera.fov = 58; camera.updateProjectionMatrix(); break;
    case 'Slash': $('help').classList.toggle('hidden'); break;
    case 'ArrowLeft': case 'ArrowRight': if (sh) { av.hdgBug = (av.hdgBug + (e.code === 'ArrowLeft' ? -1 : 1) * 5 + 360) % 360; } break;
    case 'ArrowUp': case 'ArrowDown': if (sh) av.apButton(e.code === 'ArrowUp' ? 'UP' : 'DN', F); break;
  }
});
window.addEventListener('keyup', (e) => { sim.keys[e.code] = false; sim.keys.Shift = e.shiftKey; if (e.code === 'KeyI' && sim.fdm.sys.mags === 4) sim.startHeld = 0; });
window.addEventListener('blur', () => { sim.keys = {}; });

const walkView = () => sim.view === 'cabin' || sim.view === 'walk';

function autoStart() {
  const F = sim.fdm, S = F.sys;
  toast('Auto-start: Master ON, beacon ON, fuel BOTH, mixture RICH, throttle ¼", fuel pump prime, mags START…', 3500);
  S.master = true; S.alternator = true; S.beacon = true; S.fuelSel = 'BOTH'; S.fuelShutoff = true; S.carbHeat = false; if (F.aircraft.carb && F.eng.oilT < 110) S.primer = 3; F.ctrl.mixture = 1; F.ctrl.throttle = 0.1; S.fuelPump = true; F.ctrl.parkBrake = true;
  setTimeout(() => { S.fuelPump = false; S.mags = 4; sim.startHeld = 4; }, 1200);
  const chk = setInterval(() => { if (F.eng.running || sim.startHeld <= 0) { clearInterval(chk); S.mags = 3; sim.startHeld = 0; if (F.eng.running) { S.avionics = true; S.avionics2 = true; S.nav = true; F.ctrl.throttle = 0.13; toast('Engine running — avionics ON. Set altimeter (K), check oil pressure.', 3000); } } }, 100);
}

function setView(v) {
  sim.view = v; $('viewName').textContent = viewNames[v];
  if (v === 'walk') {
    const F = sim.fdm;
    if (!(F.onGround && Math.hypot(F.vel[0], F.vel[2]) < 1)) { toast('Walkaround only on the ground, stopped'); sim.view = 'cockpit'; $('viewName').textContent = viewNames.cockpit; return; }
    const side = qrot(F.q, [0, 0, -1]), fw = qrot(F.q, [1, 0, 0]);
    walker.pos = new THREE.Vector3(F.pos[0] + side[0] * 4 + fw[0] * 1.5, 0, F.pos[2] + side[2] * 4 + fw[2] * 1.5);
    walker.yaw = Math.atan2(-(F.pos[0] - walker.pos.x), -(F.pos[2] - walker.pos.z)) / D2R; walker.pitch = -5;
  }
  if (v === 'cabin') { cabinEye.set(-0.35, 0.58, 0.0); look.yaw = 0; }
  if (v === 'flyby') flyby.pos = null;
  if (v !== 'tower' && v !== 'flyby') { camera.fov = v === 'cockpit' || v === 'cabin' ? 58 : 60; camera.updateProjectionMatrix(); }
  if (v === 'orbit') { orbit.yaw = 210; orbit.pitch = 10; orbit.dist = 13; }
}
const cabinEye = new THREE.Vector3(-0.35, 0.58, 0);
const flyby = { pos: null };

// mouse
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  sim.sound.start();
  canvas.focus?.();
  look.dragging = true; look.lx = e.clientX; look.ly = e.clientY; look.moved = 0; look.button = e.button;
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
  look.dragging = false;
  if (look.hold) { look.hold.up?.(e.button); look.hold = null; sim.panelDirty = true; return; }
  if (look.moved < 4) panelClick(e.clientX, e.clientY, e.button);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const h = panelHit(e.clientX, e.clientY);
  if (h && h.wheel) { h.wheel(e.deltaY); sim.sound.click(); return; }
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
  if (mouse.yoke) { elev += clamp(mouse.ny * 1.1, -1, 1); ail += clamp(mouse.nx * 1.1, -1, 1); }
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
    if (Math.abs(elev) > 0.6 || Math.abs(ail) > 0.6) { sim.av.disconnect(true); toast('Autopilot DISCONNECTED (override)'); }
    else { elev = apCmd.elev + elev * 0.3; ail = apCmd.ail + ail * 0.3; }
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
  if (apCmd && sim.av.ap.on) c.trim = clamp(c.trim + clamp(apCmd.elev, -0.3, 0.3) * dt * 0.12, -1, 1);
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
  const g = groundQuery(F.pos[0], F.pos[2]);
  F.surfaceType = g.surface;
  F.agl = F.pos[1] - g.h;
  F.onGround = F.groundContact.left || F.groundContact.right || F.groundContact.nose;
  if (!F.crashed && g.surface === 'water' && F.agl < 1.0) F.crash('Ditched in the lake');
  if (!F.crashed && (Math.abs(F.pos[0]) > 31000 || Math.abs(F.pos[2]) > 31000) && !sim.edgeWarned) { sim.edgeWarned = 1; setTimeout(() => (sim.edgeWarned = 0), 8000); toast('Edge of the scenery — turn back', 2500); }
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
  for (const a of AIRPORTS) { const l = toLocal(a, F.pos[0], F.pos[2]); if (Math.abs(l.u) < a.len / 2 + 50 && Math.abs(l.v) < 60) { const d = Math.abs(l.v); if (d < best) { best = d; near = { a, l }; } } }
  let msg = `Touchdown  ${fpm} fpm  ·  ${Math.round(F.ind.ias)} KIAS`;
  if (near) {
    const hdgRel = ((F.attitude.hdg - near.a.hdg + 540) % 360) - 180; const fwd = Math.abs(hdgRel) < 90;
    const fromThr = fwd ? near.l.u + near.a.len / 2 : near.a.len / 2 - near.l.u;
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
    const gh = heightAt(camera.position.x, camera.position.z) + 0.6; if (camera.position.y < gh) camera.position.y = gh;
    camera.up.set(0, 1, 0); camera.lookAt(acPos.x, acPos.y + 0.4, acPos.z);
  } else if (v === 'tower') {
    camera.near = 0.5;
    let best = null, bd = 1e12;
    for (const a of AIRPORTS) { const tp = a.towerPos || new THREE.Vector3(a.x + a.perp[0] * (a.apron.v - 40), a.elev + 12, a.z + a.perp[1] * (a.apron.v - 40)); const d = tp.distanceToSquared(acPos); if (d < bd) { bd = d; best = tp; } }
    camera.position.copy(best); camera.up.set(0, 1, 0); camera.lookAt(acPos);
    const dist = Math.sqrt(bd); camera.fov = clamp(2 * Math.atan(30 / dist) / D2R, 2, 60);
  } else if (v === 'flyby') {
    camera.near = 0.3;
    const vel = new THREE.Vector3(F.vel[0], F.vel[1], F.vel[2]);
    if (!flyby.pos || flyby.pos.distanceTo(acPos) > 700 || (vel.length() > 3 && tmpV.copy(flyby.pos).sub(acPos).dot(vel) < -vel.length() * 40)) {
      const ahead = vel.length() > 5 ? vel.clone().normalize().multiplyScalar(Math.max(150, vel.length() * 6)) : new THREE.Vector3(30, 0, 0);
      const side = new THREE.Vector3(-ahead.z, 0, ahead.x).normalize().multiplyScalar(22);
      flyby.pos = acPos.clone().add(ahead).add(side); flyby.pos.y = Math.max(flyby.pos.y + 4, heightAt(flyby.pos.x, flyby.pos.z) + 1.7);
    }
    camera.position.copy(flyby.pos); camera.up.set(0, 1, 0); camera.lookAt(acPos);
    camera.fov = clamp(2 * Math.atan(14 / Math.max(1, flyby.pos.distanceTo(acPos))) / D2R, 8, 70);
  } else if (v === 'walk') {
    camera.near = 0.05;
    const K = sim.keys; const sp = (K.ShiftLeft ? 4 : 1.6) * dt; const yaw = walker.yaw * D2R;
    const fw = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), rt = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    if (K.KeyW) walker.pos.addScaledVector(fw, sp); if (K.KeyS) walker.pos.addScaledVector(fw, -sp);
    if (K.KeyD) walker.pos.addScaledVector(rt, sp); if (K.KeyA) walker.pos.addScaledVector(rt, -sp);
    walker.pos.y = heightAt(walker.pos.x, walker.pos.z) + 1.68 + Math.sin(t * 9) * 0.01 * ((K.KeyW || K.KeyS) ? 1 : 0);
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
  $('apChip').classList.toggle('hidden', !sim.av.ap.on); if (sim.av.ap.on) $('apChip').textContent = `AP ${sim.av.ap.lat} ${sim.av.ap.vert}${sim.av.ap.vert === 'VS' ? ' ' + sim.av.ap.vsSel : ''}`;
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
  if (on) updateATCPanel();
}

function updateATCPanel() {
  const atc = sim.atc;
  $('atcStatus').textContent = atc.status;
  $('atcSpeaker').textContent = atc.speaker;
  $('atcMessage').textContent = atc.transmission;
  const log = $('atcLog');
  log.innerHTML = atc.log.map((line) => `<div class="atcLine ${line.speaker === 'YOU' ? 'you' : ''}"><b>${line.speaker}</b><span>${line.text}</span></div>`).join('');
  log.scrollTop = log.scrollHeight;
  const options = $('atcOptions');
  options.replaceChildren();
  for (const option of atc.options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = option.label;
    button.onclick = () => { atc.act(option.action, sim); updateATCPanel(); sim.panelDirty = true; };
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
    $('mapInfo').textContent = `POS  ${(F.pos[0] / 1852).toFixed(1)}E ${(-F.pos[2] / 1852).toFixed(1)}N NM\nALT  ${Math.round(F.ind.alt)} ft   GS ${Math.round(Math.hypot(F.vel[0], F.vel[2]) / KT)} kt   TRK ${String(Math.round((Math.atan2(F.vel[0], -F.vel[2]) / D2R + 360) % 360)).padStart(3, '0')}°\n${near.icao}  ${String(Math.round(brg)).padStart(3, '0')}° / ${(bd / 1852).toFixed(1)} NM   elev ${Math.round(near.elev / FT)} ft\nNAV1 ${sim.av.nav1.active.toFixed(2)} ${r1.valid ? (r1.ident || '') + (r1.dme != null ? '  DME ' + r1.dme.toFixed(1) : '') : '— no signal'}`;
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
function togglePause(force) { sim.paused = force ?? !sim.paused; $('pauseChip').classList.toggle('hidden', !sim.paused); }
$('fly').onclick = () => {
  sim.sound.start();
  applySetup(readSetup());
  showMenu(false); $('hud').classList.remove('hidden'); $('crash').classList.add('hidden');
  sim.started = true; sim.panelDirty = true; togglePause(false);
  setView(sim.view === 'walk' ? 'cockpit' : sim.view);
  toast(readSetup().spawn === 'SFOramp' ? 'Cold & dark. Shift+E auto-start, or run the checklist on the panel. ? for help.' : 'Press ? for controls.  Mixture, trim and flaps are yours.', 4000);
  canvas.focus?.();
};
$('showHelp').onclick = () => $('help').classList.remove('hidden');
$('helpClose').onclick = () => $('help').classList.add('hidden');
$('retry').onclick = () => { applySetup(lastSetup); $('crash').classList.add('hidden'); togglePause(false); };
$('toMenu').onclick = () => { $('crash').classList.add('hidden'); showMenu(true); };

// ---------------- main loop ----------------
const MANUAL = new URLSearchParams(location.search).has('manual');
let last = performance.now(), simT = 0, panelT = 0, frames = 0, fpsT = 0, fpsVal = 0;
const camPos = new THREE.Vector3();
function frame(dtReal) {
  const F = sim.fdm;
  const dt = Math.min(0.05, dtReal);
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
    sim.atc.update(sim, dt * sim.simRate);
    simT += dt * sim.simRate;
    sim.timeOfDay = (lastSetup?.tod ?? 10) + simT / 3600;
    if (F.crashed && !sim.crashShown) { sim.crashShown = true; $('crashWhy').textContent = F.crashed; $('crash').classList.remove('hidden'); }
    mmap.addTrack(F.pos);
  }
  const t = performance.now() / 1000;
  syncAircraft(dt, t);
  updateCamera(dt, t);
  if (sim.camOverride) { const o = sim.camOverride; camera.position.set(o.p[0], o.p[1], o.p[2]); camera.lookAt(o.t[0], o.t[1], o.t[2]); }
  camPos.copy(camera.position);
  // world streaming
  const agl = camPos.y - heightAt(camPos.x, camPos.z);
  if (airports?.update && (airportStreamTick = (airportStreamTick + 1) % 30) === 0) airports.update(camPos);
  if (terrain) {
    terrain.update(camPos, agl, 6);
    if (terrainMat) terrainMat.userData.uniforms.uCam.value.copy(camPos);
  }
  if (forest && rocks) { forest.update(camPos, 3); rocks.update(camPos, 3); }
  if (grass) grass.update(camPos, agl);
  if (life) life.update(camPos, sim.paused ? 0 : dt * (sim.started ? sim.simRate : 1), t);
  env.update(camera, new THREE.Vector3(F.pos[0], F.pos[1], F.pos[2]), simT, dt);
  if (airports) airports.updateLights(camPos, sim.night, t);
  // windsocks
  const w = sim.windVec || [0, 0, 0]; const ws = Math.hypot(w[0], w[2]);
  for (const a of AIRPORTS) if (a.windsock) { const dir = Math.atan2(-w[2], w[0]); a.windsock.rotation.set(0, dir + Math.sin(t * 2.3) * 0.08 * Math.min(1, ws / 3), -(1 - Math.min(1, ws / 7.7)) * 1.2 + Math.sin(t * 3.1) * 0.03); }
  // panel texture
  const inside = sim.view === 'cockpit' || sim.view === 'cabin';
  panelT += dt;
  if (sim.panel && (inside || !sim.started) && (panelT > 1 / 30 || sim.panelDirty)) {
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
  if (!sim.noRender) renderer.render(scene, camera);
  frames++; fpsT += dtReal; if (fpsT > 0.5) { fpsVal = frames / fpsT; frames = 0; fpsT = 0; if (!$('fps').classList.contains('hidden')) $('fps').textContent = `${fpsVal.toFixed(0)} fps\n${renderer.info.render.calls} calls\n${(renderer.info.render.triangles / 1e6).toFixed(2)} M tris${terrain ? `\ntiles ${terrain.visibleCount}` : ''}`; }
}
function loop() {
  const now = performance.now(); const dt = (now - last) / 1000; last = now;
  if (sim.ready && !MANUAL) frame(dt);
  requestAnimationFrame(loop);
}
window.addEventListener('keydown', (e) => { if (e.code === 'Semicolon') $('fps').classList.toggle('hidden'); });
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
