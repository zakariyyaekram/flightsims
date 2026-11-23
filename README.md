# flightsims
A collection of flight simulators. Open [index.html](./index.html) to choose which simulator to use.

## Ground services (Skyhawk)
Press **J** (or click **GROUND SVC** in the top bar) to open the ground services panel. Services only work where they would in real life: stopped on an airport ramp or apron (not a runway, taxiway or grass), with the parking brake set and the engine shut down for fuel and boarding.

- **Refuel**: a 100LL truck drives up and the line tech climbs a ladder to fuel each wing (top off, to the tabs, or +10 gal). **R** is a shortcut.
- **Ground power**: a 28 V cart plugs in, so the battery charges and the avionics run with the engine off.
- **Board / deboard passengers**, **load baggage**, **catering** (FBO van).
- **Tow / pushback**: pick a GA tug (TowMaster) that cradles the nose wheel, or a line tech who walks out with a hand tow bar and clips it to the nose-wheel axle. Both can push you straight back, tail left or tail right, or tow you forward. The tow bar is slower and turns tighter. Release the brake to start, then set it again so the tug or tow bar can be disconnected.
- Airliner-only equipment (jet bridge, air stairs, apron bus) is listed but not offered for the Cessna.

Every airport has parked airliners at gates with jet bridges docked to the forward door. KSFO, KOAK and KSJC use their real terminals. The other fields have no airline terminal in OpenStreetMap, so each gets a small commuter terminal with 2 to 4 gates, a concrete apron and a paved connector to the nearest taxiway. The site is picked inside the airfield, clear of runways, taxiways, buildings, roads, water and the GA ramp. Regional jets park there (E175s, plus 737s and A320s where the runway is at least 1,500 m). Some of them also get turnaround traffic: catering trucks lifted up to the door, Jet A trucks with hoses run to the wing, belt loaders with baggage trains, GPUs, and apron buses with passengers walking to air stairs at remote stands. A few aircraft go through a full pushback: the bridge pulls back, a tug pushes the aircraft out, and it taxis away.

## Performance, controls and streaming (Skyhawk)

### FPS meter
The chip in the top bar shows the current frame rate, the target (your display's refresh rate, capped at 60) and a rating:
- GOOD: at least 90% of the target.
- MEDIUM: at least half the target and 24 FPS.
- POOR: below that.

Click it, or press `;`, for details: draw calls, triangles, render resolution and loaded tiles.

### Making Light and Heavy mode faster
- Auto resolution is on by default (Setup). When the frame rate stays low, render resolution drops in steps down to 50%. At the floor, shadows update every second frame. Resolution comes back up once there is headroom.
- Road traffic (Setup) defaults to "Parked cars only (no animation)". You can also pick "Off" or "Moving". Parked cars are only re-placed after the camera moves more than 60 m.
- Rocks use two LODs: full detail with shadows within about 100 m, then a 22% simplified mesh with no shadows, culled by size. Only trees within about 190 m cast shadows.
- The scenery scan is skipped while the camera is still. Shadows are rendered on demand. Panel redraws slow down when the frame rate is poor.
- AI airliners are only drawn within 18 km (Light) or 30 km (Heavy).

### Controls window
Press `/` or click "Controls" to open it. The sim pauses while it is open and resumes when you close it, unless you had already paused it.

The "Key bindings & mouse" tab:
- Click any key, then press the new one. If the key is already taken, the two bindings swap. Esc cancels. Bindings are saved in the browser, and "Reset to defaults" restores them.
- Mouse flight (`Y`): sensitivity, dead zone, response curve and invert pitch.
- Optional: the mouse wheel moves the throttle, and holding the right button turns mouse left/right into rudder and nose-wheel steering.

### Heavy Edition streaming
Heavy mode no longer builds the whole world at start-up. It now loads only what's near the aircraft, as other sims do:
- X-Plane builds terrain first, then 3D objects near the plane, and drops what's behind ([X-Plane 8.30 scenery loading](https://developer.x-plane.com/2005/12/sceney-loading-in-x-plane-830/)). Newer versions load and unload scenery tiles in the background ([X-Plane 10.40 DSF loader](https://developer.x-plane.com/2015/06/x-plane-10-40-the-new-dsf-loader/)).
- FlightGear uses distance bands: detailed objects about 1.5 km, rough 7.5 km, bare terrain about 21 km ([FlightGear LOD ranges](https://wiki.flightgear.org/Level_Of_Detail_(LOD)_Ranges)). Scenery is paged in and out as it enters and leaves range ([FlightGear Scenery LoD](https://wiki.flightgear.org/Scenery_LoD)).
- Streaming tools prefetch in the direction of travel ([XEarthLayer](https://xearthlayer.app/docs/how-it-works/)).

What this sim does:
- Terrain: a 30 km quadtree around the camera, with haze at the edge. Tiles fall away behind you, and tiles about 20 s ahead along your velocity are prefetched with spare build time.
- Airports: built one at a time, nearest first, within 16 km of you or of where you'll be in 45 s. They are freed beyond 22 km. With Cesium, real-world elevation is sampled only around the spawn point and around each airport as it streams in, instead of for every airport up front.
- Cesium tiles:
  - Fog culls distant tiles, and parent tiles load first so there are no holes.
  - Sibling tiles just outside the view are not preloaded.
  - Photorealistic and OSM building tilesets lower their detail with distance and load the centre of the view first.
  - They skip requests that would arrive too late while moving fast, and use a bounded cache.
  - Cesium's render resolution and tile detail follow the auto-resolution governor.
