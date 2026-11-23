const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6InhyXzVTa2NJbVFuYzhhR28iLCJqdGkiOiIyMmIyMDJjOS02MWVmLTQxMTAtYmUyMC05ZDUxM2QyODA0OGYiLCJpZCI6NTUzMDAzLCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3OTUxMTMxMzV9.yilqEPp5oCkU3ja_qDd7A2-d-50RA';

export const CESIUM_ORIGIN = {
  longitude: -122.3790,
  latitude: 37.6213,
};

let viewer = null;
let enuFrame = null;
let originECEF = null;
let photorealisticTiles = null;
// Cesium heights are WGS84-ellipsoidal; the simulator world uses metres above mean sea level.
// The EGM96 geoid sits ~32 m below the ellipsoid around San Francisco Bay, so MSL = ellipsoid + 32.
const WORLD_ELEVATION_OFFSET = 32;
const elevationCache = new Map();
const elevationPending = new Set();

function worldToCartographic(x, z) {
  if (!viewer || !enuFrame || !window.Cesium) return null;
  const Cesium = window.Cesium;
  const local = new Cesium.Cartesian3(x, -z, 0);
  const ecef = Cesium.Matrix4.multiplyByPoint(enuFrame, local, new Cesium.Cartesian3());
  return Cesium.Ellipsoid.WGS84.cartesianToCartographic(ecef);
}

function elevationKey(cartographic) {
  return `${cartographic.longitude.toFixed(3)},${cartographic.latitude.toFixed(3)}`;
}

function getCachedElevation(cartographic) {
  const lon = Number(cartographic.longitude.toFixed(3));
  const lat = Number(cartographic.latitude.toFixed(3));
  let nearest = null;
  for (let latStep = -1; latStep <= 1; latStep++) {
    for (let lonStep = -1; lonStep <= 1; lonStep++) {
      const key = `${(lon + lonStep * 0.001).toFixed(3)},${(lat + latStep * 0.001).toFixed(3)}`;
      if (elevationCache.has(key) && (!nearest || elevationCache.get(key) !== null)) {
        nearest = elevationCache.get(key);
      }
    }
  }
  return nearest;
}

async function sampleElevations(cartographics) {
  if (!viewer || !cartographics.length) return;
  const Cesium = window.Cesium;
  const pending = cartographics.filter((position) => {
    const key = elevationKey(position);
    if (elevationCache.has(key) || elevationPending.has(key)) return false;
    elevationPending.add(key);
    return true;
  });
  if (!pending.length) return;

  try {
    await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, pending);
    for (const position of pending) {
      const key = elevationKey(position);
      elevationPending.delete(key);
      if (Number.isFinite(position.height)) {
        elevationCache.set(key, position.height + WORLD_ELEVATION_OFFSET);
      }
    }
  } catch (error) {
    for (const position of pending) elevationPending.delete(elevationKey(position));
    console.warn('Cesium elevation sample failed.', error);
  }

  if (elevationCache.size > 25000) {
    const excess = elevationCache.size - 20000;
    const keys = elevationCache.keys();
    for (let i = 0; i < excess; i++) elevationCache.delete(keys.next().value);
  }
}

// Streaming: only request what the camera needs, nearest/central first, and stop chasing detail while moving fast.
const tilesets = [];
function tuneTileset(ts, sse = 16) {
  if (!ts) return;
  ts.userData_baseSSE = sse;
  const set = (k, v) => { if (k in ts) ts[k] = v; };
  set('maximumScreenSpaceError', sse);
  set('dynamicScreenSpaceError', true);         // coarser tiles toward the horizon
  set('foveatedScreenSpaceError', true);        // load the centre of the view first
  set('cullRequestsWhileMoving', true);         // skip tiles that will be stale before they arrive
  set('cullRequestsWhileMovingMultiplier', 60);
  set('preloadWhenHidden', false);
  set('cacheBytes', 384 * 1024 * 1024);
  set('maximumCacheOverflowBytes', 256 * 1024 * 1024);
  tilesets.push(ts);
}
function tuneGlobe(scene) {
  const g = scene.globe;
  g.tileCacheSize = 250;            // terrain/imagery tiles kept around after leaving the view
  g.preloadAncestors = true;        // coarse parents first so there are never holes
  g.preloadSiblings = false;        // don't fetch tiles just outside the view
  g.loadingDescendantLimit = 12;
  g.maximumScreenSpaceError = 2;
  scene.fog.enabled = true;         // fog also culls / coarsens distant tiles
  scene.fog.density = 1.6e-4;
  scene.fog.screenSpaceErrorFactor = 4;
}
// called by the frame-rate governor: lower render resolution and tile detail together
export function setCesiumQuality(scale) {
  if (!viewer) return;
  const base = Math.min(window.devicePixelRatio, 1.5);
  const rs = Math.max(0.4, base * scale);
  if (Math.abs(viewer.resolutionScale - rs) > 0.01) viewer.resolutionScale = rs;
  for (const ts of tilesets) ts.maximumScreenSpaceError = (ts.userData_baseSSE || 16) / Math.max(0.4, scale);
}

async function addDetailedWorldContent(Cesium) {
  if (typeof Cesium.createGooglePhotorealistic3DTileset === 'function') {
    try {
      photorealisticTiles = await Cesium.createGooglePhotorealistic3DTileset();
      tuneTileset(photorealisticTiles);
      viewer.scene.primitives.add(photorealisticTiles);
      console.info('Loaded photorealistic Google 3D world tiles.');
      return;
    } catch (error) {
      console.warn('Photorealistic 3D tiles unavailable; trying OSM buildings.', error);
    }
  }

  if (typeof Cesium.createOsmBuildingsAsync === 'function') {
    try {
      const osmBuildings = await Cesium.createOsmBuildingsAsync();
      osmBuildings.maximumScreenSpaceError = 8;
      tuneTileset(osmBuildings, 8);
      viewer.scene.primitives.add(osmBuildings);
      console.info('Loaded Cesium OSM buildings.');
    } catch (error) {
      console.warn('Detailed building tiles unavailable.', error);
    }
  } else if (typeof Cesium.createOsmBuildings === 'function') {
    const osmBuildings = Cesium.createOsmBuildings();
    osmBuildings.maximumScreenSpaceError = 8;
    viewer.scene.primitives.add(osmBuildings);
  }
}

export async function initCesium() {
  if (!window.Cesium) {
    console.warn('CesiumJS 1.123 could not be loaded; continuing without online terrain.');
    return null;
  }

  try {
    const Cesium = window.Cesium;
    Cesium.Ion.defaultAccessToken = ACCESS_TOKEN;

    const terrainProvider = await Cesium.createWorldTerrainAsync({
      requestWaterMask: true,
      requestVertexNormals: true,
    });

    viewer = new Cesium.Viewer('cesiumContainer', {
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      navigationHelpButton: false,
      terrainProvider,
    });

    const worldImagery = await Cesium.createWorldImageryAsync({
      style: Cesium.IonWorldImageryStyle.AERIAL,
    });
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(worldImagery);
    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.showGroundAtmosphere = true;
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.highDynamicRange = true;
    viewer.scene.globe.depthTestAgainstTerrain = true;
    viewer.resolutionScale = Math.min(window.devicePixelRatio, 1.5);
    tuneGlobe(viewer.scene);

    await addDetailedWorldContent(Cesium);

    originECEF = Cesium.Cartesian3.fromDegrees(
      CESIUM_ORIGIN.longitude,
      CESIUM_ORIGIN.latitude,
      0,
    );
    enuFrame = Cesium.Transforms.eastNorthUpToFixedFrame(originECEF);

    return viewer;
  } catch (error) {
    const detail = error instanceof Error
      ? error.message
      : (typeof error === 'string' && error ? error : 'online terrain request failed');
    console.warn(`Cesium could not initialize: ${detail}. Continuing without online terrain.`);
    viewer = null;
    enuFrame = null;
    originECEF = null;
    return null;
  }
}

export function syncCesiumCamera(camera) {
  if (!viewer || !enuFrame) return;

  const Cesium = window.Cesium;
  const position = camera.position;
  const forward = new Cesium.Cartesian3();
  camera.getWorldDirection(forward);

  // Three.js Skyhawk world: +X east, +Y up, -Z north.
  const east = forward.x;
  const north = -forward.z;
  const up = forward.y;
  const length = Math.hypot(east, north, up) || 1;
  const heading = Math.atan2(east / length, north / length);
  const pitch = Math.asin(up / length);

  // map the flat simulator (x, z) to lat/lon, then place the camera at its MSL height above the
  // curved ellipsoid (a flat ENU offset would put distant views ~200 m too high at 50 km).
  const carto = worldToCartographic(position.x, position.z);
  const destination = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, position.y - WORLD_ELEVATION_OFFSET);

  viewer.camera.setView({
    destination,
    orientation: { heading, pitch, roll: 0 },
  });
  viewer.scene.requestRender();
}

export function getCesiumElevationWorld(x, z) {
  const cartographic = worldToCartographic(x, z);
  if (!cartographic) return null;
  const cached = getCachedElevation(cartographic);
  if (cached !== null) return cached;
  void sampleElevations([cartographic]);
  return null;
}

export async function warmCesiumTerrain(x, z, radius = 1800, spacing = 450) {
  if (!viewer || !enuFrame) return;
  const positions = [];
  for (let dz = -radius; dz <= radius; dz += spacing) {
    for (let dx = -radius; dx <= radius; dx += spacing) {
      const cartographic = worldToCartographic(x + dx, z + dz);
      if (cartographic) positions.push(cartographic);
    }
  }
  await sampleElevations(positions);
}
