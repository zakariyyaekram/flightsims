# flightsims
A collection of flight simulators. Open [index.html](./index.html) to choose which simulator to use. Every simulator page starts the same way: first pick **Light** or **Heavy** edition, then pick the aircraft (Cessna 172S, Cessna 152 or Airbus A350-1000). Picking an aircraft that lives on another page opens that page and starts loading with the edition you chose.

## Airbus A350-1000 ([a350.html](./a350.html))
A Trent XWB-97 powered A350-1000 (73.78 m long, 64.75 m span, MTOW 322 t, MLW 236 t, VMO 340 kt / MMO 0.89) with a clickable flight deck based on the real one:

- **Displays:** six 15-inch screens per Airbus layout: PFD, ND, EWD, SD (ECAM system pages and the electronic checklist), and the two MFDs (FMS pages: INIT, F-PLN, PERF, FUEL&LOAD, DATA) driven by the KCCU keyboard and trackball keys.
- **Glareshield:** EFIS control panels (baro hPa/inHg, FD, LS, VV, ND mode and range, CSTR/WPT/VORD/NDB/ARPT, terrain/WX), FCU (SPD/MACH, HDG/TRK, ALT, V/S/FPA, AP1, AP2, A/THR, LOC, APPR, EXPED), master warning and master caution.
- **Overhead:** ADIRS, ELEC (BAT 1/2, BAT EMER 1/2, EXT 1/2, APU GEN, engine gens, bus ties), APU MASTER/START, AIR/bleed and packs, FUEL pumps, hydraulics, ENG MODE/IGN, anti-ice, lights (beacon, nav, strobe, landing, nose, taxi), signs, wipers, calls and cargo/doors.
- **Pedestal:** thrust levers with CL/FLX-MCT/TOGA detents and reverse, ENG MASTER 1/2 and ENG MODE selector, speed brake, flap lever (0/1/1+F/2/3/FULL), parking brake, RMPs, ECP, the transponder panel and KCCUs.
- **Front panel:** landing gear lever, autobrake (LO/2/3/HI/BTV/RTO) and brake/accumulator indicators.
- **Systems:** electrical buses, APU start, engine start sequence, normal law fly-by-wire with flight envelope protection, A/THR with FLX takeoff, autopilot modes (SPD, HDG/NAV, ALT, V/S, OP CLB/DES, LOC/G/S, LAND), ECAM alerts and checklist, and ground services (GPU, refuel, stairs, cargo doors, tug and pushback).
- **Spawns:** SFO/OAK gates (cold & dark or ready-to-taxi), runways SFO 28L/1R, SJC 30L, OAK 30, ILS approaches (28L / 30L) and cruise.

Main keys: `Shift+E` automatic engine start, `W/S` thrust lever detents, `F/V` flaps, `G` gear, `P` parking brake, `A`/`Shift+A` AP1/AP2, `Q` AP disconnect, `H` checklist, `J` ground services, `M` map, `C`/`1-7` views, `0`/`Shift+0` overhead and pedestal look. Click any switch, knob or key in the cockpit to use it.

Research sources: [Airbus A350-1000](https://www.aircraft.airbus.com/en/aircraft/a350/a350-1000), [Airbus A350 Facts & Figures](https://www.airbus.com/sites/default/files/2025-04/Airbus-A350-Family-Facts-and-Figures-April-2025.pdf), [Wikipedia](https://en.wikipedia.org/wiki/Airbus_A350), [DMI Aviation](https://dmiaviation.com/airbus-a350-xwb-specs-history-and-tires/), [A350 FCOM](https://pdfcoffee.com/flight-crew-operating-manual-reference-vir-a350-fleet-fcom-issue-date-15-mar-20-pdf-free.html), [BEA F-HTYO report](https://bea.aero/fileadmin/user_upload/F-HTYO_EN.pdf), [Avioscope ELEC panel](https://www.avioscope.com/articles/airbus-a350-electrical-power-control), [Aerofly A350 flight deck](https://www.aerofly.com/aircraft-tutorials/a350_flightdeck/), [FlightGlobal](https://www.flightglobal.com/a350-flightdeck-an-evolution-of-a380-concept/88047.article).

### A350 checks
Browser checks for the A350 live in [tests/](./tests). Serve the repo (`python3 -m http.server 8765`), install Playwright (`npm i -D playwright && npx playwright install chromium`), then run:

- `node tests/a350-flight.mjs takeoff`: an FLX takeoff from SFO 28L. It rotates at VR, retracts the gear, engages AP1 above 100 ft, sets the levers to CL at thrust reduction, retracts the flaps and levels off at the FCU altitude. It reports every flight mode change, ECAM alert and master warning.
- `node tests/a350-flight.mjs autoland`: a CAT 3 DUAL autoland on the ILS 28L, through LAND, FLARE, RETARD and ROLL OUT to a full stop. It checks the touchdown point, centreline, sink rate and stopping distance.
- `node tests/a350-heavy.mjs`: loads Heavy Edition with the A350 and checks Cesium World Terrain, power, engines and page errors. It saves a screenshot to `/tmp/a350-heavy.jpg`.

### Cesium ion token
Heavy Edition streams Cesium World Terrain with the token in `src/cesium.js`. If Cesium rejects it, Heavy Edition falls back to the local Bay Area scenery and shows a notice. To use your own token without editing code, open a page once with `?ionToken=<your token>`. It is remembered in `localStorage.cesiumIonToken`.

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
