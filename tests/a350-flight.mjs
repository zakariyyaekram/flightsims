// A350-1000 scripted flight checks (Light Edition, simulated time, no rendering while flying).
// Serve the repo (python3 -m http.server 8765), then:
//   node tests/a350-flight.mjs takeoff   [baseUrl]   SFO 28L FLX takeoff, AP1 at 200 ft, climb to the FCU altitude
//   node tests/a350-flight.mjs autoland  [baseUrl]   ILS 28L CAT 3 DUAL autoland to a full stop
// TRACE=1 also prints a state line every 2 s of flight.
// Prints the flight mode changes, any ECAM alerts / master warning, and PASS/FAIL checks.
import { chromium } from 'playwright';

const which = process.argv[2] || 'takeoff';
const base = process.argv[3] || 'http://localhost:8765/';
const setup = which === 'autoland'
  ? { dep: 'KSJC', dest: 'KSFO', arrRwy: '28L', state: 'air', air: 'final' }
  : { dep: 'KSFO', depRwy: '28L', dest: 'KSJC', state: 'runway' };
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
// step 3 of the start screen: flight plan and start state
async function flightSetup(page, o) {
  await page.waitForSelector('#fpGo', { state: 'visible', timeout: 30000 });
  await page.evaluate((o) => {
    const set = (id, v) => { const e = document.getElementById(id); if (v == null || !e) return; e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('fpDep', o.dep); set('fpDepRwy', o.depRwy); set('fpDest', o.dest); set('fpArrRwy', o.arrRwy);
    document.querySelector(`.fpState[data-state="${o.state}"]`)?.click();
    set('fpAir', o.air);
  }, o);
  await page.click('#fpGo');
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base + 'a350.html?manual');
await page.click('#loadLight');
await page.click('#aircraftList [data-aircraft="A350"]');
await flightSetup(page, setup);
for (let i = 0; i < 180 && !(await page.evaluate(() => window.sim?.started).catch(() => false)); i++) await page.waitForTimeout(1000);

// in-page pilot: one call flies `secs` of simulated time in 50 ms steps and returns the new log lines
await page.evaluate(([which, trace]) => {
  window.__T = { which, trace, t: 0, log: [], last: '', seen: new Set(), p: { phase: 'start' } };
  window.__fly = (secs) => {
    const T = __T, P = T.p, F = sim.fdm, K = sim.keys, afs = sim.afs, perf = sim.fms.perf; sim.noRender = true;
    const rw = which === 'autoland' ? sim.fms.dest.end : sim.fms.origin.end; const c = rw.hdg * Math.PI / 180, ux = Math.sin(c), uz = -Math.cos(c);
    for (let i = 0; i < secs * 20 && !T.done; i++) {
      const s = JSON.parse(render_game_to_text());
      const dx = F.pos[0] - rw.x, dz = F.pos[2] - rw.z, along = dx * ux + dz * uz, xt = dx * uz - dz * ux;
      const tag = `t+${T.t.toFixed(1)}s RA ${s.raFt} ft, ${s.ias} kt, ${s.vsFpm} fpm, pitch ${s.pitch}`;
      const m = `${afs.lat || '-'}${afs.latArmed ? '/' + afs.latArmed : ''} | ${afs.vert || '-'}${afs.vertArmed.length ? '/' + afs.vertArmed.join(',') : ''} | ${s.fma.athr || '-'} | AP ${afs.ap.map((a) => (a ? 1 : 0)).join('')}`;
      if (T.trace && i % 40 === 0) T.log.push(`  .. ${tag}, alt ${s.altFt} ft, N1 ${s.n1}, conf ${s.conf}, ${afs.vert} -> ${Math.round(afs.targetSpd)} kt`);
      if (m !== T.last) { T.last = m; T.log.push(`MODE  ${m}   @ ${tag}`); }
      for (const a of s.alerts) if (!T.seen.has(a)) { T.seen.add(a); T.log.push(`ALERT ${a} @ ${tag}`); }
      if (s.masterWarn && !T.mw) { T.mw = true; T.log.push(`MASTER WARNING @ ${tag}`); }
      if (s.crashed) { T.crashed = s.crashed; T.log.push(`CRASH ${s.crashed} @ ${tag}`); T.done = true; break; }
      if (which === 'takeoff') {
        if (P.phase === 'start') { F.ctrl.parkBrake = false; F.ctrl.tla = [0.82, 0.82]; P.phase = 'roll'; P.x0 = along; T.log.push(`brake release, levers FLX (V1 ${perf.v1} / VR ${perf.vr} / V2 ${perf.v2}, FLEX ${perf.flex})`); }
        if (P.phase === 'roll' && s.ias >= perf.vr) { P.phase = 'rotate'; T.log.push(`rotate @ ${tag}, ${Math.round(along - P.x0)} m`); }
        if (P.phase === 'rotate' || P.phase === 'air') { K.ArrowDown = s.pitch < 12.5; K.ArrowUp = s.pitch > 14.5; }
        if (P.phase === 'rotate' && !s.onGround && s.raFt > 5) { P.phase = 'air'; T.liftoff = Math.round(along - P.x0); T.log.push(`liftoff @ ${tag}, ${T.liftoff} m from brake release`); }
        if (P.phase === 'air' && !P.gear && s.vsFpm > 300 && s.raFt > 35) { P.gear = 1; sim.gearToggle(); }
        if (P.phase === 'air' && s.raFt > 120) { K.ArrowDown = K.ArrowUp = false; P.phase = 'hands'; P.th = T.t; } // hands off the sidestick first
        if (P.phase === 'hands' && T.t - P.th > 2) { afs.apPb(0); P.phase = 'ap'; T.apOn = afs.ap[0]; T.log.push(`AP1 pushed -> ${afs.ap[0] ? 'engaged' : 'NOT engaged'} @ ${tag}`); }
        if (P.phase === 'ap' && s.fma.lvr === 'LVR CLB' && !P.clb) { P.clb = 1; F.ctrl.tla = [0.62, 0.62]; T.log.push(`LVR CLB -> levers CL @ ${tag}`); }
        if (P.clb && !P.f1 && s.ias > perf.v2 + 25) { P.f1 = 1; sim.flapStep(-1); }
        if (P.f1 && !P.f0 && s.ias > perf.v2 + 55) { P.f0 = 1; sim.flapStep(-1); }
        if (P.phase === 'ap' && Math.abs(s.altFt - afs.fcu.alt) < 60 && /^ALT/.test(afs.vert) && T.t - (P.lvlT ?? (P.lvlT = T.t)) > 20) { T.level = { alt: s.altFt, ias: s.ias, vert: afs.vert }; T.done = true; }
      } else {
        if (afs.retard && !P.ret) { P.ret = 1; F.ctrl.tla = [0, 0]; T.log.push(`RETARD -> levers idle @ ${tag}`); }
        if (s.onGround && !T.td) { T.td = { along: Math.round(along), xt: +xt.toFixed(1), sink: P.vs, pitch: s.pitch, ias: s.ias }; P.tdT = T.t; T.log.push(`TOUCHDOWN @ ${tag}, ${Math.round(along)} m past threshold, ${xt.toFixed(1)} m off centreline, sink ${P.vs} fpm`); }
        if (T.td && !P.rev && T.t - P.tdT > 1.5) { P.rev = 1; F.ctrl.tla = [-1, -1]; }
        if (P.rev === 1 && s.ias < 70) { P.rev = 2; F.ctrl.tla = [0, 0]; }
        if (T.td && F.ind.gs < 3) { T.stop = { roll: Math.round(along - T.td.along), xt: +xt.toFixed(1) }; T.log.push(`STOPPED ${T.stop.roll} m after touchdown, ${T.stop.xt} m off centreline`); T.done = true; }
        if (!s.onGround) P.vs = s.vsFpm;
      }
      advanceTime(50); T.t += 0.05;
    }
    sim.noRender = false; return { log: T.log.splice(0), done: !!T.done };
  };
}, [which, !!process.env.TRACE]);
for (let k = 0; k < 60; k++) {
  const r = await page.evaluate(() => __fly(10));
  for (const l of r.log) console.log(l);
  if (r.done) break;
}
const T = await page.evaluate(() => ({ ...__T, seen: [...__T.seen], p: null, log: null }));
const checks = [];
const ok = (name, pass, info = '') => checks.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
ok('no crash', !T.crashed, T.crashed || '');
ok('no ECAM alerts', T.seen.length === 0, T.seen.join(', '));
ok('no master warning', !T.mw);
if (which === 'takeoff') {
  ok('liftoff within the runway', T.liftoff > 0 && T.liftoff < 3000, `${T.liftoff} m`);
  ok('AP1 engaged after takeoff', T.apOn);
  ok('levelled at the FCU altitude', !!T.level, T.level ? `${T.level.alt} ft, ${T.level.ias} kt, ${T.level.vert}` : 'did not level off');
} else {
  ok('touchdown in the touchdown zone', T.td && T.td.along > 150 && T.td.along < 900, T.td ? `${T.td.along} m` : 'no touchdown');
  ok('on the centreline', T.td && Math.abs(T.td.xt) < 5, T.td ? `${T.td.xt} m` : '');
  ok('sink rate under 600 fpm', T.td && T.td.sink > -600, T.td ? `${T.td.sink} fpm` : '');
  ok('stopped on the runway', !!T.stop, T.stop ? `${T.stop.roll} m roll` : '');
}
ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(checks.join('\n'));
await browser.close();
process.exit(checks.every((c) => c.startsWith('PASS')) ? 0 : 1);
