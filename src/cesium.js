const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6InhyXzVTa2NJbVFuYzhhR28iLCJqdGkiOiIyMmIyMDJjOS02MWVmLTQxMTAtYmUyMC05ZDUxM2QyODA0OGYiLCJpZCI6NTUzMDAzLCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3OTUxMTMxMzV9.yilqEPp5oCkU3ja_qDd7A2-d-50RA';

export const CESIUM_ORIGIN = {
  longitude: -122.3790,
  latitude: 37.6213,
};

let viewer = null;
let enuFrame = null;
let originECEF = null;
let photorealisticTiles = null;
const WORLD_ELEVATION_OFFSET = 178;
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

async function addDetailedWorldContent(Cesium) {
  if (typeof Cesium.createGooglePhotorealistic3DTileset === 'function') {
    try {
      photorealisticTiles = await Cesium.createGooglePhotorealistic3DTileset();
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

  const localDestination = new Cesium.Cartesian3(
    position.x,
    -position.z,
    position.y - 178,
  );
  const destination = Cesium.Matrix4.multiplyByPoint(
    enuFrame,
    localDestination,
    new Cesium.Cartesian3(),
  );

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
