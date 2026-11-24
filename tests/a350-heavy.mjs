// A350-1000 Heavy Edition load check.
// Serve the repo (python3 -m http.server 8765), then: node tests/a350-heavy.mjs [baseUrl]
// Picks Heavy Edition -> Airbus A350-1000 on the start screen, waits for the sim to start and
// checks that Cesium World Terrain is live, the aircraft sits on real terrain at SFO, the flight deck
// displays are powered and no page errors were thrown. Saves a screenshot to /tmp/a350-heavy.jpg.
import { chromium } from 'playwright';
import fs from 'fs';

const base = process.argv[2] || 'http://localhost:8765/';
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
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
let ionRejected = false;
page.on('response', (r) => { if (/api\.cesium\.com/.test(r.url()) && r.status() === 401) ionRejected = true; });
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404|401|net::ERR/.test(m.text())) errors.push(m.text().slice(0, 200)); });

const t0 = Date.now();
await page.goto(base + 'a350.html?manual'); // manual stepping: the test drives frames itself
await page.click('#loadHeavy');
await page.click('#aircraftList [data-aircraft="A350"]');
await flightSetup(page, { dep: 'KSFO', depRwy: '28L', dest: 'KSJC', state: 'runway' }); // lined up: engines and displays on
let state = null;
for (let i = 0; i < 300; i++) {
  await page.waitForTimeout(1000);
  state = await page.evaluate(() => (window.sim?.started ? JSON.parse(window.render_game_to_text()) : null)).catch(() => null);
  if (state) break;
}
const loadSec = ((Date.now() - t0) / 1000).toFixed(0);
const checks = [];
const ok = (name, pass, info = '') => checks.push({ name, pass: !!pass, info });
ok('sim started', state, `${loadSec} s`);
if (state) {
  ok('Heavy Edition selected', state.edition?.mode === 'heavy');
  ok('Cesium World Terrain active', state.edition?.cesium, state.edition?.fallback ? (ionRejected ? 'Cesium ion rejected the access token (401) - set a new one with ?ionToken=...; fell back to local scenery' : 'fell back to local scenery') : '');
  const g = await page.evaluate(() => {
    const v = window.Cesium && document.querySelector('#cesiumContainer canvas');
    return { canvas: !!v, onGround: sim.fdm.onGround, alt: Math.round(sim.fdm.ind.alt), crashed: sim.fdm.crashed };
  });
  if (state.edition?.cesium) ok('Cesium canvas present', g.canvas);
  ok('aircraft on the ground at SFO', g.onGround && !g.crashed && Math.abs(g.alt) < 200, `alt ${g.alt} ft`);
  ok('engines running', state.engines?.every(Boolean), `N1 ${state.n1}`);
  ok('AC and DC power', state.power?.ac && state.power?.dc);
  // let terrain tiles stream for a few seconds, then grab the three.js layer for a visual check
  await page.evaluate(() => { sim.noRender = true; window.advanceTime(8000); sim.noRender = false; }); // 8 s of sim time
  const shot = await page.evaluate(() => { sim.noRender = true; window.advanceTime(300); sim.noRender = false; sim.frame(1 / 60); return sim.renderer.domElement.toDataURL('image/jpeg', 0.85); });
  fs.writeFileSync('/tmp/a350-heavy.jpg', Buffer.from(shot.split(',')[1], 'base64'));
}
ok('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.info ? '  (' + c.info + ')' : ''}`);
await browser.close();
process.exit(checks.every((c) => c.pass) ? 0 : 1);
