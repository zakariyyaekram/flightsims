// Interactive POH checklists + guided engine start.
// Item wording follows the Cessna 172S Information Manual / POH Section 4 (Normal Procedures)
// and the Cessna 152 POH Section 4. Items the sim can sense tick themselves; the rest are click-to-check.
// Each item can "Show me" the control: the cockpit camera turns to it and a pulsing ring marks it.

const RPM = (F) => F.eng.rpm || 0;
const gs = (F) => Math.hypot(F.vel[0], F.vel[2]) / 0.514444;
const fuelOn = (F) => F.sys.fuelSel === 'BOTH' && F.sys.fuelShutoff !== false;
const cbIn = (F) => !Object.values(F.sys.cb || {}).some((v) => v === false);
const elecOff = (F) => !F.sys.beacon && !F.sys.landing && !F.sys.taxi && !F.sys.nav && !F.sys.strobe && !F.sys.pitotHeat && !F.sys.fuelPump;
const started = (F) => F.eng.running && RPM(F) > 500;

// ---------------------------------------------------------------- Cessna 172S (IO-360-L2A, fuel injected)
const C172 = [
  { id: 'preflight', title: 'Before starting engine', items: [
    { t: 'Preflight inspection', v: 'COMPLETE', how: 'Press 7 for the walkaround view to look the airplane over, then 1 to return to the cockpit.' },
    { t: 'Passenger briefing', v: 'COMPLETE' },
    { t: 'Seats & seat belts', v: 'ADJUST & LOCK' },
    { t: 'Brakes', v: 'TEST & SET', ok: (F) => F.ctrl.parkBrake, show: 'parkBrake', how: 'Parking brake handle, below the lower-left panel: pull aft and rotate 90° (P key).' },
    { t: 'Circuit breakers', v: 'CHECK IN', ok: cbIn, show: 'cbFLAP', how: 'All breakers along the bottom of the lower panel pushed in.' },
    { t: 'Electrical equipment', v: 'OFF', ok: (F) => elecOff(F) || started(F), show: 'rkbeacon', how: 'The row of switch/breakers on the lower panel — all down.' },
    { t: 'AVIONICS switch (BUS 1 & 2)', v: 'OFF', ok: (F) => (!F.sys.avionics && !F.sys.avionics2) || started(F), show: 'spavionics', how: 'Split black rocker labelled AVIONICS on the lower panel, right of the light switches.' },
    { t: 'Fuel selector valve', v: 'BOTH', ok: (F) => F.sys.fuelSel === 'BOTH', show: 'fuelSel', how: 'Floor selector between the seats — click to rotate to BOTH.' },
    { t: 'Fuel shutoff valve', v: 'ON (push full in)', ok: (F) => F.sys.fuelShutoff !== false, show: 'fuelShutoff', how: 'Red knob on the pedestal just above the fuel selector — pushed in.' },
  ] },
  { id: 'start', title: 'Starting engine (with battery)', guide: true, items: [
    { t: 'Throttle', v: 'OPEN 1/4 INCH', ok: (F) => (F.ctrl.throttle > 0.03 && F.ctrl.throttle < 0.25) || started(F), show: 'throttle', how: 'Black throttle knob, centre of the lower panel. Push in a little (W key, or drag/scroll the knob) to about 1/4 inch — 5–20 %.' },
    { t: 'Mixture', v: 'IDLE CUTOFF', ok: (F) => F.ctrl.mixture < 0.05 || started(F), show: 'mixture', how: 'Red ribbed knob right of the throttle — pull fully out ([ key).' },
    { t: 'Propeller area', v: 'CLEAR', how: 'Look outside, then call "Clear prop!"' },
    { t: 'STBY BATT / MASTER switch (ALT & BAT)', v: 'ON', ok: (F) => F.sys.master, show: 'spmaster', how: 'Red split rocker labelled MASTER: BAT on the right, ALT on the left (Shift+M turns both on).' },
    { t: 'BEACON light', v: 'ON', ok: (F) => F.sys.beacon || started(F), show: 'rkbeacon', how: 'BCN switch/breaker on the lower panel — flip it up.' },
    { t: 'FUEL PUMP switch', v: 'ON', ok: (F) => F.sys.fuelPump || (F.sys.primeT || 0) >= 1 || started(F), show: 'rkfuelPump', how: 'FUEL PUMP switch/breaker, first in the row — up = ON.' },
    { t: 'Mixture', v: 'FULL RICH 3–5 s, then IDLE CUTOFF', ok: (F) => ((F.sys.primeT || 0) >= 1 && F.ctrl.mixture < 0.05) || started(F), show: 'mixture', how: 'Push the mixture full in (] key) for 3–5 seconds to prime with the pump running, then pull it back to idle cutoff ([ key). Watch the fuel-flow needle rise while priming.' },
    { t: 'FUEL PUMP switch', v: 'OFF', ok: (F) => (!F.sys.fuelPump && (F.sys.primeT || 0) >= 1) || started(F), show: 'rkfuelPump', how: 'Flip the FUEL PUMP switch back down.' },
    { t: 'Ignition switch', v: 'START (release when engine starts)', ok: (F) => started(F), show: 'ignition', how: 'Key on the far left of the lower panel. Hold I (or press and hold on the key) to crank; release when it fires. Limit cranking to 10 s, then let the starter cool 20 s.' },
    { t: 'Mixture', v: 'ADVANCE smoothly to RICH', ok: (F) => started(F) && F.ctrl.mixture > 0.9, show: 'mixture', how: 'As soon as it fires, push the mixture in smoothly (] key) — the engine runs only a few seconds on the prime.' },
    { t: 'Oil pressure', v: 'CHECK (green within 30–60 s)', ok: (F) => started(F) && F.eng.oilP > 20, show: 'gauge:oil', how: 'Lower-left round gauge, right needle (OIL PSI). If no pressure in 30 s (60 s in cold weather), shut down.' },
    { t: 'NAV lights', v: 'ON as required', ok: (F) => F.sys.nav || !F.sys._night, show: 'rknav' },
    { t: 'AVIONICS switch (BUS 1 & 2)', v: 'ON', ok: (F) => F.sys.avionics && F.sys.avionics2, show: 'spavionics', how: 'Split black AVIONICS rocker (Shift+V).' },
    { t: 'Radios', v: 'ON', ok: (F) => F.sys.avionics, show: 'kmaPwr' },
    { t: 'Flaps', v: 'RETRACT', ok: (F) => F.ctrl.flaps < 0.02, show: 'flapLever', how: 'Flap switch right of the pedestal — UP (V key).' },
  ] },
  { id: 'taxi', title: 'Before taxi / taxiing', items: [
    { t: 'Altimeter', v: 'SET to field QNH', ok: (F, sim) => Math.abs((F.kollsman ?? 29.92) - (sim.weather?.qnhInHg ?? 29.92)) < 0.015, show: 'baro', how: 'Knob at lower-left of the altimeter — click to set the current QNH (K key).' },
    { t: 'Heading indicator', v: 'SET to compass', show: 'dgSet', how: 'Knob at lower-left of the heading indicator (D key aligns it with the compass).' },
    { t: 'Taxi clearance / route', v: 'OBTAIN', how: 'G opens the radio panel: request taxi. T shows the magenta taxi line to the runway.' },
    { t: 'TAXI light', v: 'ON', ok: (F) => F.sys.taxi, show: 'rktaxi' },
    { t: 'Parking brake', v: 'RELEASE', ok: (F) => !F.ctrl.parkBrake, show: 'parkBrake', how: 'P key. Then add power (W) to get rolling — about 1,000–1,200 RPM — and steer with the rudder pedals (Z / X).' },
    { t: 'Brakes', v: 'CHECK as you start rolling', ok: (F) => gs(F) > 3, how: 'Hold B briefly once moving to make sure the toe brakes work. Taxi at a brisk walk (under ~15 kt; GS on the data strip).' },
    { t: 'Flight instruments', v: 'CHECK in turns', how: 'Turning left: turn coordinator shows left turn, ball goes right, heading decreases. Opposite turning right.' },
  ] },
  { id: 'runup', title: 'Before takeoff (run-up at the hold-short line)', items: [
    { t: 'Parking brake', v: 'SET', ok: (F) => F.ctrl.parkBrake, show: 'parkBrake' },
    { t: 'Passenger seat backs', v: 'MOST UPRIGHT' },
    { t: 'Seats & seat belts', v: 'CHECK SECURE' },
    { t: 'Cabin doors', v: 'CLOSED & LOCKED' },
    { t: 'Flight controls', v: 'FREE & CORRECT', how: 'Move the yoke fully (arrow keys) and watch the ailerons / elevator from the cockpit.' },
    { t: 'Flight instruments', v: 'CHECK & SET' },
    { t: 'Fuel quantity', v: 'CHECK', ok: (F) => F.sys.fuelL > 3 && F.sys.fuelR > 3, show: 'gauge:fuel' },
    { t: 'Mixture', v: 'RICH', ok: (F) => F.ctrl.mixture > 0.9, show: 'mixture' },
    { t: 'Fuel selector valve', v: 'RECHECK BOTH', ok: (F) => F.sys.fuelSel === 'BOTH', show: 'fuelSel' },
    { t: 'Throttle', v: '1800 RPM', ok: (F) => RPM(F) > 1700 && RPM(F) < 1950, show: 'throttle', how: 'Brakes set, advance to 1,800 RPM on the tachometer (bottom row, under the VSI).' },
    { t: 'Magnetos', v: 'CHECK (≤150 drop each, ≤50 difference)', ok: (F, sim, st) => st.magR && st.magL, show: 'ignition', how: 'At 1,800 RPM turn the key to R, back to BOTH, then L, back to BOTH (Shift+I steps toward OFF, I toward START). Watch the RPM drop.' },
    { t: 'Vacuum gauge', v: 'CHECK (green 4.5–5.5)', ok: (F) => F.eng.vac > 4.4, show: 'gauge:vac' },
    { t: 'Engine instruments & ammeter', v: 'CHECK', ok: (F) => F.eng.oilP > 20 && F.sys.alternator, show: 'gauge:oil' },
    { t: 'Annunciators', v: 'CHECK — none lit', show: 'annTst', how: 'Hold the TST toggle to test all six lights first.' },
    { t: 'Throttle', v: 'CHECK IDLE, then 1000 RPM or less', ok: (F, sim, st) => st.idle && RPM(F) < 1100, show: 'throttle' },
    { t: 'Strobe lights', v: 'AS DESIRED', show: 'rkstrobe' },
    { t: 'Radios & avionics', v: 'SET', show: 'kmaPwr' },
    { t: 'NAV/GPS switch', v: 'SET', show: 'cdiSrc' },
    { t: 'Autopilot', v: 'OFF', ok: (F, sim) => !sim.av.ap.on, show: 'apIn' },
    { t: 'Elevator trim', v: 'SET FOR TAKEOFF', ok: (F) => Math.abs(F.ctrl.trim) < 0.12, show: 'trim', how: 'Trim wheel on the pedestal — takeoff mark (Home / End keys).' },
    { t: 'Wing flaps', v: 'UP – 10°', ok: (F) => F.ctrl.flaps < 0.36, show: 'flapLever' },
    { t: 'Brakes', v: 'RELEASE', ok: (F) => !F.ctrl.parkBrake, show: 'parkBrake' },
  ] },
  { id: 'takeoff', title: 'Takeoff & climb', items: [
    { t: 'Landing & strobe lights', v: 'ON', ok: (F) => F.sys.landing && F.sys.strobe, show: 'rklanding' },
    { t: 'Wing flaps', v: 'UP – 10°', ok: (F) => F.ctrl.flaps < 0.36, show: 'flapLever' },
    { t: 'Throttle', v: 'FULL OPEN', ok: (F) => F.ctrl.throttle > 0.97, show: 'throttle' },
    { t: 'Mixture', v: 'RICH (above 3,000 ft lean to max RPM)', ok: (F) => F.ctrl.mixture > 0.85, show: 'mixture' },
    { t: 'Elevator control', v: 'LIFT NOSE WHEEL at 55 KIAS', ok: (F) => !F.onGround },
    { t: 'Climb speed', v: '70–80 KIAS (Vy 74)', ok: (F) => !F.onGround && F.ind.ias > 68 && F.ind.ias < 85 },
    { t: 'Wing flaps', v: 'RETRACT (above 60 KIAS)', ok: (F) => !F.onGround && F.ctrl.flaps < 0.02, show: 'flapLever' },
  ] },
  { id: 'cruise', title: 'Cruise & descent', items: [
    { t: 'Power', v: '2100–2700 RPM (≤75 %)', ok: (F) => !F.onGround && RPM(F) > 2050 && RPM(F) < 2710, show: 'throttle' },
    { t: 'Elevator trim', v: 'ADJUST', show: 'trim' },
    { t: 'Mixture', v: 'LEAN (peak EGT then 50° rich)', show: 'mixture' },
    { t: 'Altimeter', v: 'SET', show: 'baro' },
    { t: 'NAV/GPS switch', v: 'SET', show: 'cdiSrc' },
    { t: 'Fuel selector valve', v: 'BOTH', ok: (F) => F.sys.fuelSel === 'BOTH', show: 'fuelSel' },
    { t: 'Wing flaps', v: 'AS DESIRED (0–10° <110 KIAS, 10–30° <85 KIAS)', show: 'flapLever' },
  ] },
  { id: 'landing', title: 'Before landing & landing', items: [
    { t: 'Seats, belts, harnesses', v: 'SECURE' },
    { t: 'Fuel selector valve', v: 'BOTH', ok: (F) => F.sys.fuelSel === 'BOTH', show: 'fuelSel' },
    { t: 'Mixture', v: 'RICH', ok: (F) => F.ctrl.mixture > 0.9, show: 'mixture' },
    { t: 'Landing / taxi lights', v: 'ON', ok: (F) => F.sys.landing, show: 'rklanding' },
    { t: 'Autopilot', v: 'OFF', ok: (F, sim) => !sim.av.ap.on, show: 'apIn' },
    { t: 'Airspeed', v: '65–75 KIAS flaps up, 60–70 flaps down', show: 'gauge:asi' },
    { t: 'Wing flaps', v: 'AS DESIRED (FULL below 85 KIAS)', show: 'flapLever' },
    { t: 'Touchdown', v: 'MAIN WHEELS FIRST', ok: (F, sim, st) => st.landed },
    { t: 'Braking', v: 'MINIMUM REQUIRED', how: 'B key (toe brakes).' },
  ] },
  { id: 'secure', title: 'After landing & securing', items: [
    { t: 'Wing flaps', v: 'UP', ok: (F) => F.ctrl.flaps < 0.02, show: 'flapLever' },
    { t: 'Parking brake', v: 'SET', ok: (F) => F.ctrl.parkBrake, show: 'parkBrake' },
    { t: 'Electrical equipment & autopilot', v: 'OFF', ok: (F, sim) => elecOff(F) && !sim.av.ap.on, show: 'rkbeacon' },
    { t: 'AVIONICS switch', v: 'OFF', ok: (F) => !F.sys.avionics && !F.sys.avionics2, show: 'spavionics' },
    { t: 'Mixture', v: 'IDLE CUTOFF (pulled full out)', ok: (F) => F.ctrl.mixture < 0.05, show: 'mixture' },
    { t: 'Ignition switch', v: 'OFF', ok: (F) => F.sys.mags === 0, show: 'ignition' },
    { t: 'MASTER switch (ALT & BAT)', v: 'OFF', ok: (F) => !F.sys.master, show: 'spmaster' },
    { t: 'Control lock', v: 'INSTALL' },
    { t: 'Fuel selector valve', v: 'LEFT or RIGHT', ok: (F) => F.sys.fuelSel === 'LEFT' || F.sys.fuelSel === 'RIGHT', show: 'fuelSel' },
  ] },
];

// ---------------------------------------------------------------- Cessna 152 (O-235, carburetted)
const C152 = [
  { id: 'preflight', title: 'Before starting engine', items: [
    { t: 'Preflight inspection', v: 'COMPLETE', how: 'Press 7 for the walkaround view, 1 to return.' },
    { t: 'Seats, belts, shoulder harnesses', v: 'ADJUST & LOCK' },
    { t: 'Fuel shutoff valve', v: 'ON', ok: (F) => F.sys.fuelShutoff !== false && F.sys.fuelSel !== 'OFF', show: 'fuelSel', how: 'Fuel shutoff valve on the floor in front of the seats — ON.' },
    { t: 'Radios, electrical equipment', v: 'OFF', ok: (F) => (elecOff(F) && !F.sys.avionics) || started(F), show: 'rkbeacon' },
    { t: 'Brakes', v: 'TEST & SET', ok: (F) => F.ctrl.parkBrake, show: 'parkBrake', how: 'P key.' },
    { t: 'Circuit breakers', v: 'CHECK IN', ok: cbIn, show: 'cbBCN' },
  ] },
  { id: 'start', title: 'Starting engine', guide: true, items: [
    { t: 'Mixture', v: 'RICH', ok: (F) => F.ctrl.mixture > 0.9, show: 'mixture', how: 'Red mixture knob — push full in (] key).' },
    { t: 'Carburetor heat', v: 'COLD (in)', ok: (F) => !F.sys.carbHeat, show: 'carbHeat', how: 'CARB HEAT knob left of the throttle — pushed in.' },
    { t: 'Prime', v: 'AS REQUIRED (2–6 strokes cold)', ok: (F) => (F.sys.primer || 0) >= 2 || started(F) || F.eng.oilT > 110, show: 'primer', how: 'PRIMER plunger at the lower left — click it 2–3 times (more when cold; too many floods the engine).' },
    { t: 'Throttle', v: 'OPEN 1/2 INCH', ok: (F) => (F.ctrl.throttle > 0.05 && F.ctrl.throttle < 0.3) || started(F), show: 'throttle', how: 'Push the throttle in about 1/2 inch (W key).' },
    { t: 'Propeller area', v: 'CLEAR' },
    { t: 'MASTER switch', v: 'ON', ok: (F) => F.sys.master, show: 'spmaster', how: 'Red split rocker labelled MASTER (Shift+M).' },
    { t: 'BEACON', v: 'ON', ok: (F) => F.sys.beacon || started(F), show: 'rkbeacon' },
    { t: 'Ignition switch', v: 'START (release when engine starts)', ok: started, show: 'ignition', how: 'Hold I (or hold the key) to crank; release when it fires.' },
    { t: 'Throttle', v: 'ADJUST to 1000 RPM or less', ok: (F) => started(F) && RPM(F) < 1150, show: 'throttle' },
    { t: 'Oil pressure', v: 'CHECK (green within 30 s)', ok: (F) => started(F) && F.eng.oilP > 20, show: 'gauge:oil' },
    { t: 'AVIONICS POWER switch', v: 'ON', ok: (F) => F.sys.avionics, show: 'rkavionics' },
    { t: 'Flaps', v: 'UP', ok: (F) => F.ctrl.flaps < 0.02, show: 'flapLever' },
  ] },
  { id: 'taxi', title: 'Before taxi / taxiing', items: C172[2].items },
  { id: 'runup', title: 'Before takeoff (run-up)', items: [
    { t: 'Parking brake', v: 'SET', ok: (F) => F.ctrl.parkBrake, show: 'parkBrake' },
    { t: 'Cabin doors', v: 'CLOSED & LATCHED' },
    { t: 'Flight controls', v: 'FREE & CORRECT' },
    { t: 'Flight instruments', v: 'SET' },
    { t: 'Fuel shutoff valve', v: 'ON', ok: (F) => F.sys.fuelShutoff !== false, show: 'fuelSel' },
    { t: 'Mixture', v: 'RICH (below 3,000 ft)', ok: (F) => F.ctrl.mixture > 0.9, show: 'mixture' },
    { t: 'Elevator trim', v: 'TAKEOFF', ok: (F) => Math.abs(F.ctrl.trim) < 0.12, show: 'trim' },
    { t: 'Throttle', v: '1700 RPM', ok: (F) => RPM(F) > 1600 && RPM(F) < 1850, show: 'throttle' },
    { t: 'Magnetos', v: 'CHECK (≤125 drop, ≤50 difference)', ok: (F, sim, st) => st.magR && st.magL, show: 'ignition', how: 'Key to R, BOTH, L, BOTH (Shift+I / I).' },
    { t: 'Carburetor heat', v: 'CHECK for RPM drop', ok: (F, sim, st) => st.carb, show: 'carbHeat', how: 'Pull carb heat on (RPM drops), then push it back in.' },
    { t: 'Engine instruments & ammeter', v: 'CHECK', ok: (F) => F.eng.oilP > 20, show: 'gauge:oil' },
    { t: 'Suction gauge', v: 'CHECK', ok: (F) => F.eng.vac > 4.4, show: 'gauge:vac' },
    { t: 'Throttle', v: '1000 RPM or less', ok: (F, sim, st) => st.idle && RPM(F) < 1100, show: 'throttle' },
    { t: 'Radios', v: 'SET' },
    { t: 'Strobe lights', v: 'AS DESIRED', show: 'rkstrobe' },
    { t: 'Brakes', v: 'RELEASE', ok: (F) => !F.ctrl.parkBrake, show: 'parkBrake' },
  ] },
  { id: 'takeoff', title: 'Takeoff & climb', items: [
    { t: 'Wing flaps', v: '0° – 10°', ok: (F) => F.ctrl.flaps < 0.36, show: 'flapLever' },
    { t: 'Carburetor heat', v: 'COLD', ok: (F) => !F.sys.carbHeat, show: 'carbHeat' },
    { t: 'Throttle', v: 'FULL OPEN', ok: (F) => F.ctrl.throttle > 0.97, show: 'throttle' },
    { t: 'Elevator control', v: 'LIFT NOSE WHEEL at 50 KIAS', ok: (F) => !F.onGround },
    { t: 'Climb speed', v: '65–75 KIAS', ok: (F) => !F.onGround && F.ind.ias > 63 && F.ind.ias < 80 },
    { t: 'Wing flaps', v: 'RETRACT', ok: (F) => !F.onGround && F.ctrl.flaps < 0.02, show: 'flapLever' },
  ] },
  { id: 'cruise', title: 'Cruise & descent', items: [
    { t: 'Power', v: '1900–2550 RPM (≤75 %)', ok: (F) => !F.onGround && RPM(F) > 1850 && RPM(F) < 2560, show: 'throttle' },
    { t: 'Elevator trim', v: 'ADJUST', show: 'trim' },
    { t: 'Mixture', v: 'LEAN', show: 'mixture' },
    { t: 'Carburetor heat', v: 'FULL HEAT before reducing power', show: 'carbHeat' },
  ] },
  { id: 'landing', title: 'Before landing & landing', items: [
    { t: 'Seats, belts, harnesses', v: 'ADJUST & LOCK' },
    { t: 'Mixture', v: 'RICH', ok: (F) => F.ctrl.mixture > 0.9, show: 'mixture' },
    { t: 'Carburetor heat', v: 'ON (before closing throttle)', ok: (F) => F.sys.carbHeat, show: 'carbHeat' },
    { t: 'Airspeed', v: '60–70 KIAS flaps up, 55–65 flaps down', show: 'gauge:asi' },
    { t: 'Wing flaps', v: 'AS DESIRED', show: 'flapLever' },
    { t: 'Touchdown', v: 'MAIN WHEELS FIRST', ok: (F, sim, st) => st.landed },
    { t: 'Braking', v: 'MINIMUM REQUIRED' },
  ] },
  { id: 'secure', title: 'After landing & securing', items: [
    { t: 'Wing flaps', v: 'UP', ok: (F) => F.ctrl.flaps < 0.02, show: 'flapLever' },
    { t: 'Carburetor heat', v: 'COLD', ok: (F) => !F.sys.carbHeat, show: 'carbHeat' },
    { t: 'Parking brake', v: 'SET', ok: (F) => F.ctrl.parkBrake, show: 'parkBrake' },
    { t: 'Radios, electrical equipment', v: 'OFF', ok: (F) => elecOff(F) && !F.sys.avionics, show: 'rkbeacon' },
    { t: 'Mixture', v: 'IDLE CUT-OFF', ok: (F) => F.ctrl.mixture < 0.05, show: 'mixture' },
    { t: 'Ignition switch', v: 'OFF', ok: (F) => F.sys.mags === 0, show: 'ignition' },
    { t: 'MASTER switch', v: 'OFF', ok: (F) => !F.sys.master, show: 'spmaster' },
    { t: 'Control lock', v: 'INSTALL' },
  ] },
];

export const CHECKLISTS = { C172, C152 };

export class Checklist {
  /** @param sim  global sim; @param showControl(id) turns the camera + highlights; returns false if unknown */
  constructor(sim, showControl) {
    this.sim = sim; this.showControl = showControl;
    this.open = false; this.guide = false; this.tab = 'start';
    this.el = document.getElementById('ckl');
    this.list = document.getElementById('cklList');
    this.tabs = document.getElementById('cklTabs');
    this.hint = document.getElementById('cklHint');
    this.reset('C172');
    document.getElementById('cklClose').onclick = () => this.toggle(false);
    document.getElementById('cklGuide').onclick = () => this.startGuide();
    document.getElementById('cklReset').onclick = () => { this.done = {}; this.st = {}; this.render(); };
    this.tabs.onchange = () => { this.tab = this.tabs.value; this.render(); };
    this.list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-show]'); if (b) { e.stopPropagation(); this.showControl(b.dataset.show); return; }
      const row = e.target.closest('[data-k]'); if (!row) return;
      const k = row.dataset.k, it = this.itemByKey(k); if (!it || it.ok) return; // sensed items tick themselves
      this.done[k] = !this.done[k]; this.render();
    });
  }
  reset(type) {
    this.type = type === 'C152' ? 'C152' : 'C172';
    this.lists = CHECKLISTS[this.type];
    this.done = {}; this.st = {}; this.guide = false; this.lastGuide = null;
    this.tabs.innerHTML = this.lists.map((l) => `<option value="${l.id}">${l.title}</option>`).join('');
    const F = this.sim.fdm;
    this.tab = F.eng.running ? (F.onGround ? 'runup' : 'cruise') : 'preflight';
    this.tabs.value = this.tab; this.render();
  }
  itemByKey(k) { const [li, ii] = k.split(':').map(Number); return this.lists[li]?.items[ii]; }
  toggle(on = !this.open) { this.open = on; this.el.classList.toggle('hidden', !on); if (on) this.render(); }
  startGuide() {
    this.guide = true; this.tab = 'start'; this.tabs.value = 'start';
    const li = this.lists.findIndex((l) => l.id === 'start');
    // POH "before starting" items that the sim can sense must be right first
    this.toggle(true); this.lastGuide = null; this.update(0, true);
    void li;
  }
  // sensed state + sticky completion for sequence items (e.g. prime then cutoff)
  update(dt, force = false) {
    const F = this.sim.fdm, st = this.st;
    // run-up / sequence detectors
    if (F.eng.running && F.onGround) {
      if (F.sys.mags === 1 && F.eng.rpm > 1500) st.magR = true;
      if (F.sys.mags === 2 && F.eng.rpm > 1500) st.magL = true;
      if (F.sys.carbHeat && F.eng.rpm > 1500) st.carb = true;
      if (F.ctrl.throttle < 0.03) st.idle = true;
    }
    if (!F.onGround) st.wasAir = true; else if (st.wasAir) st.landed = true;
    F.sys._night = (this.sim.night || 0) > 0.25;
    let changed = force;
    this.lists.forEach((l, li) => l.items.forEach((it, ii) => {
      if (!it.ok) return; const k = li + ':' + ii;
      let v = false; try { v = !!it.ok(F, this.sim, st); } catch { v = false; }
      // the start list is sequential: once done, items stay done (mixture goes rich after the cutoff step, etc.)
      if (l.guide && this.done[k] && !v) v = true;
      if (v !== !!this.done[k]) { this.done[k] = v; changed = true; }
    }));
    // a step of the start sequence can't be done before the one above it (keeps the guide honest)
    if (this.guide) {
      const li = this.lists.findIndex((l) => l.id === this.tab), l = this.lists[li];
      let next = null;
      if (l) for (let ii = 0; ii < l.items.length; ii++) { const k = li + ':' + ii; if (!this.done[k]) { next = k; break; } }
      if (next !== this.lastGuide) {
        this.lastGuide = next; changed = true;
        if (next) { const it = this.itemByKey(next); if (it.show && this.open) this.showControl(it.show, true); }
        else { this.guide = false; this.sim.toast?.('Engine started — run the "Before taxi" checklist next. T shows the taxi line.', 6000); this.tab = 'taxi'; this.tabs.value = 'taxi'; }
      }
    }
    if (changed && this.open) this.render();
  }
  render() {
    if (!this.open) return;
    const li = this.lists.findIndex((l) => l.id === this.tab), l = this.lists[li]; if (!l) return;
    let n = 0;
    const rows = l.items.map((it, ii) => {
      const k = li + ':' + ii, d = !!this.done[k]; if (d) n++;
      const cur = this.guide && this.lastGuide === k;
      return `<li data-k="${k}" class="${d ? 'done' : ''}${cur ? ' cur' : ''}${it.ok ? ' auto' : ' manual'}">
        <span class="box">${d ? '✓' : ''}</span>
        <span class="txt"><b>${it.t}</b><span class="dots"></span><em>${it.v}</em>${(cur || !d) && it.how ? `<small>${it.how}</small>` : ''}</span>
        ${it.show ? `<button type="button" data-show="${it.show}" title="Show this control in the cockpit">Show</button>` : ''}
      </li>`;
    }).join('');
    this.list.innerHTML = rows;
    this.hint.textContent = `${n} / ${l.items.length} complete · ${this.guide ? 'Guided start: follow the highlighted step' : 'Grey boxes tick themselves from the cockpit; click white boxes to check them off'}`;
    const cur = this.list.querySelector('.cur'); if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
}
