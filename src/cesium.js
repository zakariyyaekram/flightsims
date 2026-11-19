const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6InhyXzVTa2NJbVFuYzhhR28iLCJqdGkiOiIyMmIyMDJjOS02MWVmLTQxMTAtYmUyMC05ZDUxM2QyODA0OGYiLCJpZCI6NTUzMDAzLCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3OTUxMTMxMzV9.yilqEPp5oCkU3ja_qDd7A2-d-50RA';

export const CESIUM_ORIGIN = {
  longitude: -122.3790,
  latitude: 37.6213,
};

let viewer = null;
let enuFrame = null;
let originECEF = null;

export async function initCesium() {
  if (!window.Cesium) throw new Error('CesiumJS 1.123 could not be loaded');

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
  viewer.resolutionScale = Math.min(window.devicePixelRatio, 1.5);

  originECEF = Cesium.Cartesian3.fromDegrees(
    CESIUM_ORIGIN.longitude,
    CESIUM_ORIGIN.latitude,
    0,
  );
  enuFrame = Cesium.Transforms.eastNorthUpToFixedFrame(originECEF);

  return viewer;
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
