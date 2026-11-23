// Ground services.
//  * PlayerGroundServices: the ground-services panel for the player's Cessna (fuel truck, 28 V ground power, passenger
//    boarding/deboarding, baggage, FBO catering and a GA tug for towing/pushback). Services are only offered where they
//    would be in reality: stopped on an airport ramp/apron (not a runway, taxiway or grass), engine off, parking brake set.
//    Airliner-only equipment (jet bridge, air stairs, apron bus, high-loader) is listed as unavailable for the Cessna.
//  * buildGateServices: activity around the AI airliners parked at terminal gates — articulated jet bridges docked to the
//    L1 door, fuel trucks, catering high-loaders, belt loaders with baggage trains, GPUs, apron buses with passengers at
//    remote stands, and full pushback cycles (bridge retracts, tug pushes the aircraft back, it taxis away, a new one arrives).
import * as THREE from 'three';
import { AIRPORTS, pointInPoly, toLocal } from './geo.js';
import { qFromHPR } from './math.js';
import { GSE, gseLowDetail, MB, JetBridge, makePerson, posePerson, setLift, setBelt, setTowbar, hoseMesh, sagPoints, gateSignAtlas } from './gse.js';
import { buildAirliner } from './airliner.js';

const D2R = Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const yawOf = (dx, dz) => -Math.atan2(dz, dx); // rotation.y that points local +X along (dx, dz)

// ------------------------------------------------------------------ path following
function bezier(p0, p1, p2, p3, n = 24) {
  const out = []; for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; out.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]); } return out;
}
// smooth vehicle route from pose A (x,z,dir) to pose B (x,z,dir)
function route(a, b, k = 0.38) {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]) * k;
  return bezier([a[0], a[1]], [a[0] + a[2][0] * d, a[1] + a[2][1] * d], [b[0] - b[2][0] * d, b[1] - b[2][1] * d], [b[0], b[1]], Math.max(8, Math.round(d)));
}
class Actor {
  constructor(obj, groundH, { person = false, parent }) {
    this.o = obj; this.gh = groundH; this.person = person; this.path = null; this.speed = 0; this.v = 0; this.yOff = 0; this.reverse = false; this.carry = false; this.work = 0;
    parent.add(obj);
  }
  at(x, z, dirx, dirz) { this.o.position.set(x, this.gh(x, z) + this.yOff, z); if (dirx !== undefined) this.o.rotation.set(0, yawOf(dirx, dirz), 0); return this; }
  go(pts, speed, { reverse = false } = {}) {
    const P = [[this.o.position.x, this.o.position.z], ...pts]; const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    this.path = { P, cum, L: cum[cum.length - 1], s: 0 }; this.speed = speed; this.reverse = reverse; return this;
  }
  get moving() { return !!this.path; }
  update(dt) {
    const o = this.o;
    if (this.path) {
      const p = this.path; const rem = p.L - p.s;
      const target = Math.min(this.speed, Math.sqrt(2 * (this.person ? 3 : 1.1) * Math.max(0, rem)) + 0.15);
      this.v += clamp(target - this.v, -2.5 * dt, (this.person ? 3 : 1.4) * dt); p.s = Math.min(p.L, p.s + this.v * dt);
      let i = 1; while (i < p.cum.length - 1 && p.cum[i] < p.s) i++;
      const a = p.P[i - 1], b = p.P[i], seg = p.cum[i] - p.cum[i - 1] || 1, t = (p.s - p.cum[i - 1]) / seg;
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      let dx = b[0] - a[0], dz = b[1] - a[1]; if (this.reverse) { dx = -dx; dz = -dz; }
      if (Math.hypot(dx, dz) > 1e-4) { const want = yawOf(dx, dz); let d = want - o.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); o.rotation.y += d * Math.min(1, dt * (this.person ? 8 : 5)); }
      o.position.set(x, this.gh(x, z) + this.yOff, z);
      if (p.s >= p.L - 1e-3) { this.path = null; this.v = 0; }
    } else o.position.y = this.gh(o.position.x, o.position.z) + this.yOff;
    if (this.person) posePerson(o, dt, this.path ? this.v : 0, { carry: this.carry, work: this.work });
  }
}

// ------------------------------------------------------------------ service catalogue (Cessna)
const ICON = {
  fuel: '<path d="M5 3h7v15H5z M12 7h2l2 2v7a1.5 1.5 0 0 0 3 0V8l-3-3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.5 5h4v4h-4z" fill="currentColor"/>',
  gpu: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0z M12 17v5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  board: '<circle cx="9" cy="5" r="2.2" fill="currentColor"/><path d="M9 8v6l-2 7M9 14l3 7M6 11h6M16 4v16h4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  deboard: '<circle cx="15" cy="5" r="2.2" fill="currentColor"/><path d="M15 8v6l2 7M15 14l-3 7M12 11h6M8 4v16H4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  bags: '<rect x="5" y="7" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 7V4h6v3M9 11v5M15 11v5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  catering: '<path d="M4 13h16M6 13a6 6 0 0 1 12 0M12 5v2M3 17h18" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  tug: '<path d="M3 16h11v-5H8l-2 3H3z M14 13h7" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="6" cy="17.5" r="1.8" fill="currentColor"/><circle cx="12" cy="17.5" r="1.8" fill="currentColor"/>',
  bridge: '<path d="M3 20V9h5v11M8 11h13v5H8" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  stairs: '<path d="M4 20h4v-4h4v-4h4V8h4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  bus: '<rect x="3" y="5" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 11h18M7 17v2M17 17v2" fill="none" stroke="currentColor" stroke-width="1.6"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">${ICON[k]}</svg>`;

export class PlayerGroundServices {
  constructor({ scene, sim, toast, groundH }) {
    this.sim = sim; this.toast = toast; this.gh = (x, z) => groundH(x, z) + 0.06;
    this.root = new THREE.Group(); this.root.name = 'groundServices'; scene.add(this.root);
    this.jobs = new Map(); this.pax = 0; this.bags = 0; this.panelT = 0; this.open = false;
    this.opts = { fuel: 'full', pax: 1, push: 'straight' };
    this.buildPanel();
  }
  reset() {
    for (const j of this.jobs.values()) this.disposeJob(j);
    this.jobs.clear(); this.pax = 0; this.bags = 0;
    if (this.sim.fdm) this.sim.fdm.sys.extPower = false;
    this.render(true);
  }
  // ---------------- aircraft frame
  frame() {
    const F = this.sim.fdm; const h = F.attitude.hdg; const k = F.aircraft.visualScale ?? 1;
    const f = [Math.sin(h * D2R), -Math.cos(h * D2R)], r = [Math.cos(h * D2R), Math.sin(h * D2R)];
    const x = F.pos[0], z = F.pos[2];
    return { x, z, hdg: h, f, r, k, w: (lx, lz) => [x + f[0] * lx + r[0] * lz, z + f[1] * lx + r[1] * lz], dir: (rel) => { const a = (h + rel) * D2R; return [Math.sin(a), -Math.cos(a)]; } };
  }
  // ---------------- where are we? (appropriate place checks)
  context() {
    const F = this.sim.fdm; const x = F.pos[0], z = F.pos[2];
    let ap = null, bd = 1e12; for (const a of AIRPORTS) { const d = Math.hypot(a.arp[0] - x, a.arp[1] - z) - a.radius; if (d < bd) { bd = d; ap = a; } }
    const out = { airport: ap, ok: false, zone: null, reason: '', label: '' };
    if (!ap || bd > 0) { out.reason = 'Not at an airport'; out.label = 'No airport nearby'; return out; }
    out.label = ap.icao;
    if (!F.onGround) { out.reason = 'Land and park on a ramp first'; return out; }
    for (const r of ap.runways) { const l = toLocal(r, x, z); if (Math.abs(l.u) < r.len / 2 + 30 && Math.abs(l.v) < r.wid / 2 + 8) { out.reason = 'On a runway — vacate and taxi to the ramp'; out.zone = 'runway'; return out; } }
    const onApron = ap.aprons.some((p) => pointInPoly(x, z, p.p));
    let taxi = false;
    for (const t of ap.taxiways) { if (t.lane) continue; for (let i = 1; i < t.p.length; i++) { const a = t.p[i - 1], b = t.p[i]; const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1; const s = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / L2, 0, 1); if (Math.hypot(a[0] + dx * s - x, a[1] + dz * s - z) < t.w / 2 + 1.5) { taxi = true; break; } } if (taxi) break; }
    if (taxi && !onApron) { out.reason = 'On a taxiway — park on the ramp to call ground services'; out.zone = 'taxiway'; return out; }
    const nearRamp = Math.hypot(ap.ramp.x - x, ap.ramp.z - z) < 90;
    if (!onApron && !nearRamp) { out.reason = 'Not on a paved ramp or apron'; out.zone = 'grass'; return out; }
    const term = ap.buildings.some((b) => b.k === 'terminal' && b.p.some((q) => Math.hypot(q[0] - x, q[1] - z) < 110));
    out.zone = term ? 'terminal' : 'ramp'; out.label = `${ap.icao} · ${term ? 'terminal apron' : 'GA ramp'}`; out.ok = true; return out;
  }
  stopped() { const F = this.sim.fdm; return F.onGround && Math.hypot(F.vel[0], F.vel[2]) < 0.35; }
  engineOff() { const F = this.sim.fdm; return !F.eng.running && F.eng.rpm < 20; }
  // service definitions: availability returns '' when OK, else the reason
  services() {
    const F = this.sim.fdm, S = F.sys; const c152 = F.aircraft === undefined ? false : (F.aircraft.visualScale ?? 1) < 1;
    const seats = c152 ? 1 : 3; const name = c152 ? 'Cessna 152' : 'Cessna 172S';
    const busy = (ids) => ids.find((i) => this.jobs.has(i) && i !== 'gpu');
    const need = (...checks) => { for (const [ok, msg] of checks) if (!ok) return msg; return ''; };
    const base = [[this.ctx.ok, this.ctx.reason], [this.stopped(), 'Bring the aircraft to a full stop']];
    const off = [this.engineOff(), 'Shut down the engine (prop must be stopped)'];
    const brake = [F.ctrl.parkBrake, 'Set the parking brake (P)'];
    const cap = F.aircraft.fuelCapGal;
    return [
      { id: 'fuel', icon: 'fuel', name: 'Refuel · 100LL truck', desc: `Line service fuels both wings from the top. ${(S.fuelL + S.fuelR).toFixed(1)} / ${(cap * 2).toFixed(0)} gal on board.`, why: need(...base, off, brake, [!this.jobs.has('push'), 'Wait for the tow to finish'], [S.fuelL + S.fuelR < cap * 2 - 0.3, 'Tanks are full']), opt: 'fuel' },
      { id: 'gpu', icon: 'gpu', name: 'Ground power · 28 V cart', desc: 'External power for avionics and a strong battery on engine start.', why: need(...base, [!this.jobs.has('push'), 'Wait for the tow to finish']), toggle: S.extPower },
      { id: 'board', icon: 'board', name: 'Board passengers', desc: `${this.pax} of ${seats} passenger seat${seats > 1 ? 's' : ''} occupied. Passengers walk out from the FBO.`, why: need(...base, off, brake, [this.pax < seats, 'All seats are taken'], [!busy(['deboard', 'push']), 'Another service is using the doors']), opt: 'pax' },
      { id: 'deboard', icon: 'deboard', name: 'Deboard passengers', desc: 'Passengers are escorted back to the FBO.', why: need(...base, off, brake, [this.pax > 0, 'No passengers on board'], [!busy(['board', 'push']), 'Another service is using the doors']) },
      { id: 'bags', icon: 'bags', name: 'Load baggage', desc: `Baggage compartment behind the rear seats (max 120 lb). ${this.bags} item${this.bags === 1 ? '' : 's'} loaded.`, why: need(...base, off, brake, [this.bags < 3, 'Baggage area is full'], [!this.jobs.has('push'), 'Wait for the tow to finish']) },
      { id: 'catering', icon: 'catering', name: 'Catering · FBO van', desc: 'Snacks, water and coffee delivered to the cabin door.', why: need(...base, off, brake, [!this.jobs.has('push'), 'Wait for the tow to finish']) },
      { id: 'push', icon: 'tug', name: 'Tow / pushback · GA tug', desc: 'A tug cradles the nose wheel and pushes you clear of the parking spot. Release the brake when it is connected.', why: need(...base, off, [!['fuel', 'board', 'deboard', 'bags', 'catering'].some((i) => this.jobs.has(i)), 'Finish the other services first'], [!S.extPower && !this.jobs.has('gpu'), 'Disconnect ground power first']), opt: 'push' },
      { id: 'bridge', icon: 'bridge', name: 'Jet bridge', na: `Not available — the ${name} has no airliner door; jet bridges dock to airliners at terminal gates.` },
      { id: 'stairs', icon: 'stairs', name: 'Passenger air stairs', na: `Not needed — the ${name} cabin door is at ground level.` },
      { id: 'bus', icon: 'bus', name: 'Apron bus', na: 'Airliners only — buses carry passengers to remote stands.' },
    ];
  }
  // ---------------- panel
  buildPanel() {
    const el = document.createElement('aside'); el.id = 'gsPanel'; el.className = 'hidden'; el.setAttribute('aria-label', 'Ground services');
    el.innerHTML = `<header><div><span class="gsEyebrow">GROUND SERVICES</span><strong id="gsWhere">—</strong></div><button id="gsClose" type="button" aria-label="Close ground services">×</button></header>
      <div id="gsChecks"></div><div id="gsList"></div><div class="gsFoot"><button id="gsCancelAll" type="button">Cancel all</button><span>J open/close · Shift+J cancel all</span></div>`;
    (document.getElementById('hud') || document.body).appendChild(el);
    this.el = el; el.querySelector('#gsClose').onclick = () => this.toggle(false); el.querySelector('#gsCancelAll').onclick = () => this.cancelAll();
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const id = b.dataset.id; if (b.dataset.act === 'req') this.request(id); else if (b.dataset.act === 'cancel') this.cancel(id); else if (b.dataset.act === 'stop') this.stopPush();
      this.render(true);
    });
    el.addEventListener('change', (e) => { const s = e.target.closest('select[data-opt]'); if (s) this.opts[s.dataset.opt] = s.value; });
    el.addEventListener('keydown', (e) => e.stopPropagation());
  }
  toggle(force) { this.open = force ?? !this.open; this.el.classList.toggle('hidden', !this.open); if (this.open) this.render(true); }
  statusOf(id) { const j = this.jobs.get(id); return j ? j.status : ''; }
  render(force = false) {
    if (!this.open && !force) return; this.ctx = this.context();
    const F = this.sim.fdm; const el = this.el; if (!el) return;
    el.querySelector('#gsWhere').textContent = this.ctx.label || '—';
    const chip = (ok, txt) => `<span class="gsChk ${ok ? 'ok' : 'no'}">${ok ? '✓' : '•'} ${txt}</span>`;
    const chk = (this.ctx.ok ? chip(true, 'Parked on the ramp') : chip(false, this.ctx.reason)) + chip(this.stopped(), 'Stopped') + chip(F.ctrl.parkBrake, 'Parking brake') + chip(this.engineOff(), 'Engine off');
    if (chk !== this._chk) { this._chk = chk; el.querySelector('#gsChecks').innerHTML = chk; }
    const opt = (o) => {
      if (o === 'fuel') { const cap = F.aircraft.fuelCapGal, tabs = (F.aircraft.visualScale ?? 1) < 1 ? 13 : 17.5; return `<select data-opt="fuel" aria-label="Fuel amount"><option value="full"${this.opts.fuel === 'full' ? ' selected' : ''}>Top off (${(cap * 2).toFixed(0)} gal)</option><option value="tabs"${this.opts.fuel === 'tabs' ? ' selected' : ''}>To the tabs (${(tabs * 2).toFixed(0)} gal)</option><option value="plus10"${this.opts.fuel === 'plus10' ? ' selected' : ''}>+10 gal</option></select>`; }
      if (o === 'pax') { const seats = (F.aircraft.visualScale ?? 1) < 1 ? 1 : 3; let s = '<select data-opt="pax" aria-label="Passengers">'; for (let i = 1; i <= Math.max(1, seats - this.pax); i++) s += `<option value="${i}"${+this.opts.pax === i ? ' selected' : ''}>${i} passenger${i > 1 ? 's' : ''}</option>`; return s + '</select>'; }
      if (o === 'push') return `<select data-opt="push" aria-label="Pushback direction"><option value="straight"${this.opts.push === 'straight' ? ' selected' : ''}>Straight back</option><option value="left"${this.opts.push === 'left' ? ' selected' : ''}>Tail left (nose right)</option><option value="right"${this.opts.push === 'right' ? ' selected' : ''}>Tail right (nose left)</option></select>`;
      return '';
    };
    const rows = this.services().map((s) => {
      if (s.na) return `<div class="gsRow na"><i>${svg(s.icon)}</i><div><b>${s.name}</b><small>${s.na}</small></div><span class="gsPill na">N/A</span></div>`;
      const j = this.jobs.get(s.id); const st = j ? j.status : '';
      let pill = st ? `<span class="gsPill ${j.phase === 'active' ? 'on' : 'wait'}">${st}</span>` : s.why ? '<span class="gsPill no">Unavailable</span>' : '<span class="gsPill ok">Available</span>';
      let act = '';
      if (j) act = s.id === 'push' && j.phase === 'active' ? `<button data-act="stop" data-id="push" type="button">Stop</button>` : `<button data-act="cancel" data-id="${s.id}" type="button">${s.id === 'gpu' && j.phase === 'active' ? 'Disconnect' : 'Cancel'}</button>`;
      else if (s.id === 'gpu' && s.toggle) act = `<button data-act="cancel" data-id="gpu" type="button">Disconnect</button>`;
      else act = `<button data-act="req" data-id="${s.id}" type="button" class="primary"${s.why ? ' disabled' : ''}>Request</button>`;
      return `<div class="gsRow"><i>${svg(s.icon)}</i><div><b>${s.name}</b><small>${j?.note || (s.why && !j ? s.why : s.desc)}</small>${!j && s.opt && !s.why ? opt(s.opt) : ''}</div><span class="gsSide">${pill}${act}</span></div>`;
    });
    const avail = rows.filter((r) => !r.includes('gsRow na')), na = rows.filter((r) => r.includes('gsRow na'));
    const html = avail.join('') + `<div class="gsSub">Airliner equipment</div>` + na.join('');
    // only touch the DOM when something changed (keeps open dropdowns usable)
    if (html !== this._html && !(el.contains(document.activeElement) && document.activeElement.tagName === 'SELECT' && !force)) { this._html = html; el.querySelector('#gsList').innerHTML = html; }
  }
  // ---------------- requests
  request(id) {
    this.ctx = this.context(); const s = this.services().find((q) => q.id === id);
    if (!s || s.na) { if (s) this.toast(s.na, 3500); return; }
    if (this.jobs.has(id)) return;
    if (s.why) { this.toast(s.why, 3000); return; }
    const make = { fuel: () => this.jobFuel(), gpu: () => this.jobGpu(), board: () => this.jobBoard(), deboard: () => this.jobDeboard(), bags: () => this.jobBags(), catering: () => this.jobCatering(), push: () => this.jobPush() }[id];
    const j = make(); j.id = id; this.jobs.set(id, j); this.render(true);
  }
  cancel(id) {
    const j = this.jobs.get(id);
    if (id === 'gpu' && !j && this.sim.fdm.sys.extPower) { const g = this.jobGpu(true); g.id = 'gpu'; this.jobs.set('gpu', g); return; }
    if (!j) return;
    if (id === 'gpu' && j.phase === 'active') { j.release = true; return; }
    if (id === 'push' && j.phase === 'active') { this.stopPush(); return; }
    j.cancelled = true; this.toast(`${j.title} cancelled`, 2000); this.dismissJob(j);
  }
  cancelAll() { for (const id of [...this.jobs.keys()]) this.cancel(id); if (this.sim.fdm.sys.extPower && !this.jobs.has('gpu')) this.cancel('gpu'); }
  // ---------------- job plumbing
  newJob(title) { return { title, actors: [], extra: [], steps: [], i: 0, t: 0, status: 'Requested', phase: 'enroute', note: '' }; }
  vehicle(j, obj) { const a = new Actor(obj, this.gh, { parent: this.root }); j.actors.push(a); return a; }
  person(j, kind, seed) { const a = new Actor(makePerson(kind, seed), this.gh, { person: true, parent: this.root }); j.actors.push(a); return a; }
  addExtra(j, obj) { this.root.add(obj); j.extra.push(obj); return obj; }
  removeExtra(j, obj) { if (!obj) return; this.root.remove(obj); obj.traverse?.((o) => { if (o.isMesh && o.geometry?.type === 'TubeGeometry') o.geometry.dispose(); }); j.extra = j.extra.filter((e) => e !== obj); }
  disposeJob(j) { for (const a of j.actors) this.root.remove(a.o); for (const e of j.extra) this.removeExtra(j, e); j.actors = []; }
  // send every actor of a job away, then delete it
  dismissJob(j) {
    for (const e of [...j.extra]) this.removeExtra(j, e);
    const fr = this.frame();
    j.steps = [() => { for (const a of j.actors) { a.work = 0; a.carry = false; a.yOff = 0; const o = a.o.position; const dx = o.x - fr.x, dz = o.z - fr.z, d = Math.hypot(dx, dz) || 1; const q = [o.x + dx / d * 40, o.z + dz / d * 40]; a.go([q], a.person ? 1.5 : 6); } return true; },
      () => j.actors.every((a) => !a.moving), () => { this.disposeJob(j); return true; }];
    j.i = 0; j.status = 'Leaving'; j.phase = 'leaving'; j.done = true;
  }
  update(dt, t) {
    if (!this.sim.fdm) return;
    const F = this.sim.fdm;
    // safety: if the aircraft rolls away (other than under tow) everything is aborted
    if (this.jobs.size && !this.jobs.has('push') && Math.hypot(F.vel[0], F.vel[2]) > 0.8) {
      if (F.sys.extPower) { F.sys.extPower = false; this.toast('Ground power cable pulled — aircraft moved', 3000); }
      for (const j of this.jobs.values()) if (!j.done) { this.toast('Ground services aborted — the aircraft moved', 3000); this.dismissJob(j); }
    }
    for (const [id, j] of this.jobs) {
      j.t += dt;
      while (j.i < j.steps.length) { if (j.steps[j.i](dt)) { j.i++; j.t = 0; } else break; }
      for (const a of j.actors) a.update(dt);
      if (j.i >= j.steps.length) { this.disposeJob(j); this.jobs.delete(id); this.render(true); }
    }
    this.panelT += dt; if (this.open && this.panelT > 0.3) { this.panelT = 0; this.render(); }
  }
  // step helpers
  S = {
    wait: (sec) => (() => { let t = 0; return (dt) => (t += dt) >= sec; })(),
    once: (fn) => () => { fn(); return true; },
    until: (fn) => () => !!fn(),
    arrive: (...actors) => () => actors.every((a) => !a.moving),
  };
  fboPoint(fr) {
    const ap = this.ctx?.airport; let best = null, bd = 130;
    if (ap) for (const b of ap.buildings) { if (b.k === 'house') continue; for (let i = 0; i < b.p.length; i++) { const a = b.p[i], c = b.p[(i + 1) % b.p.length]; const dx = c[0] - a[0], dz = c[1] - a[1], L2 = dx * dx + dz * dz || 1; const s = clamp(((fr.x - a[0]) * dx + (fr.z - a[1]) * dz) / L2, 0, 1); const px = a[0] + dx * s, pz = a[1] + dz * s; const d = Math.hypot(px - fr.x, pz - fr.z); if (d < bd && d > 15) { bd = d; best = [px + (fr.x - px) / d * 2.5, pz + (fr.z - pz) / d * 2.5]; } } }
    return best || fr.w(-28, -16);
  }
  // walking route from p to a target beside the aircraft that avoids the prop arc and wing struts
  walkAround(fr, from, toLocal) {
    const k = fr.k; const lf = (() => { const dx = from[0] - fr.x, dz = from[1] - fr.z; return [dx * fr.f[0] + dz * fr.f[1], dx * fr.r[0] + dz * fr.r[1]]; })();
    const side = Math.sign(toLocal[1]) || 1, fromSide = Math.sign(lf[1]) || 1; const pts = [];
    if (lf[0] > 1.5 * k && Math.abs(lf[1]) < 6) pts.push(fr.w(lf[0], fromSide * 6.5 * k)); // never walk through the propeller
    if (fromSide !== side) { pts.push(fr.w(-8.6 * k, fromSide * 3.2 * k)); pts.push(fr.w(-8.6 * k, side * 3.2 * k)); }
    pts.push(fr.w(toLocal[0] - 1.6 * k, side * Math.max(Math.abs(toLocal[1]) + 1.4 * k, 2.2 * k)));
    pts.push(fr.w(toLocal[0], toLocal[1]));
    return pts;
  }
  // ---------------- fuel truck (100LL)
  jobFuel() {
    const j = this.newJob('Fuel truck'); const fr = this.frame(); const k = fr.k; const F = this.sim.fdm, S = F.sys; const cap = F.aircraft.fuelCapGal;
    const tabs = k < 1 ? 13 : 17.5; const per = this.opts.fuel === 'tabs' ? tabs : this.opts.fuel === 'plus10' ? null : cap;
    const target = { L: per != null ? Math.max(S.fuelL, per) : Math.min(cap, S.fuelL + 5), R: per != null ? Math.max(S.fuelR, per) : Math.min(cap, S.fuelR + 5) };
    const truck = this.vehicle(j, GSE.avgas()); const park = fr.w(-0.5, -9.0 * k - 0.4); const fd = fr.dir(0);
    const start = fr.w(-55, -14); truck.at(start[0], start[1], fd[0], fd[1]);
    const tech = this.person(j, 'fuel', 3); tech.o.visible = false;
    const ladder = GSE.ladder(); let hose = null;
    const toW = (o, lx, ly, lz) => { o.updateMatrixWorld(); return V3(lx, ly, lz).applyMatrix4(o.matrixWorld); };
    const cap_ = (s) => fr.w(-0.1 * k, s * 2.05 * k);
    const capY = () => this.gh(fr.x, fr.z) + 2.5 * k;
    const doTank = (side) => {
      const lad = fr.w(0.55 * k, side * 2.15 * k), stand = fr.w(0.95 * k, side * 2.15 * k);
      return [
        () => { tech.carry = true; tech.go(this.walkAround(fr, [tech.o.position.x, tech.o.position.z], [0.95 * k, side * 2.15 * k]), 1.3); return true; },
        this.S.arrive(tech),
        this.S.once(() => { this.addExtra(j, ladder); ladder.position.set(lad[0], this.gh(lad[0], lad[1]), lad[1]); ladder.rotation.y = yawOf(fr.f[0], fr.f[1]); tech.carry = false; tech.go([lad], 0.8); }),
        this.S.arrive(tech),
        this.S.once(() => {
          tech.yOff = 0.9; tech.o.rotation.y = yawOf(-fr.r[0] * side, -fr.r[1] * side); tech.work = 1;
          const reel = toW(truck.o, -4.05, 1.55, 0.2), c = cap_(side), cy = capY();
          const pts = [reel, V3(reel.x + fd[0] * -0.3, this.gh(reel.x, reel.z) + 0.05, reel.z + fd[1] * -0.3)];
          if (side > 0) { const n1 = fr.w(3.4 * k, -1.8 * k), n2 = fr.w(3.4 * k, 1.8 * k); pts.push(V3(n1[0], this.gh(n1[0], n1[1]) + 0.05, n1[1]), V3(n2[0], this.gh(n2[0], n2[1]) + 0.05, n2[1])); }
          const g = fr.w(0.5 * k, side * 2.6 * k); pts.push(V3(g[0], this.gh(g[0], g[1]) + 0.05, g[1]), V3(stand[0], cy - 0.6, stand[1]), V3(c[0], cy, c[1]));
          hose = this.addExtra(j, hoseMesh(pts, 0.03));
          j.status = 'Fueling'; j.phase = 'active';
        }),
        (dt) => { const key = side < 0 ? 'fuelL' : 'fuelR', tgt = side < 0 ? target.L : target.R; S[key] = Math.min(tgt, S[key] + dt * 0.4); this.sim.panelDirty = true; j.note = `Fueling ${side < 0 ? 'left' : 'right'} wing · ${(S.fuelL + S.fuelR).toFixed(1)} gal`; return S[key] >= tgt - 1e-3; },
        this.S.once(() => { this.removeExtra(j, hose); hose = null; tech.work = 0; tech.yOff = 0; }),
        this.S.wait(1.2),
        this.S.once(() => { this.removeExtra(j, ladder); tech.carry = true; }),
      ];
    };
    j.steps = [
      this.S.once(() => { j.status = 'En route'; truck.go(route([start[0], start[1], fd], [park[0], park[1], fd]), 7); this.toast('Fuel truck on the way · 100LL', 2500); }),
      this.S.arrive(truck),
      this.S.once(() => { j.status = 'Setting up'; const d = toW(truck.o, 1.9, 0, 1.4); tech.at(d.x, d.z, fr.r[0], fr.r[1]); tech.o.visible = true; tech.go([[toW(truck.o, -4.6, 0, 0.9).x, toW(truck.o, -4.6, 0, 0.9).z]], 1.2); }),
      this.S.arrive(tech), this.S.wait(1.5),
      ...(target.L > S.fuelL + 0.05 ? doTank(-1) : []),
      ...(target.R > S.fuelR + 0.05 ? doTank(1) : []),
      this.S.once(() => { j.status = 'Finishing'; j.note = `Fueled · ${(S.fuelL + S.fuelR).toFixed(1)} gal on board`; const b = toW(truck.o, 1.9, 0, 1.4); tech.go([...this.walkAround(fr, [tech.o.position.x, tech.o.position.z], [0, -6 * k]).slice(0, -1), [b.x, b.z]], 1.3); }),
      this.S.arrive(tech),
      this.S.once(() => { tech.o.visible = false; j.status = 'Leaving'; j.phase = 'leaving'; this.toast(`Fuel complete · ${(S.fuelL + S.fuelR).toFixed(1)} gal on board`, 3000); const end = fr.w(40, -26); truck.go(route([park[0], park[1], fd], [end[0], end[1], fr.dir(-50)]), 7); }),
      this.S.arrive(truck),
    ];
    return j;
  }
  // ---------------- 28 V ground power cart (connect / disconnect)
  jobGpu(disconnectOnly = false) {
    const j = this.newJob('Ground power'); const fr = this.frame(); const k = fr.k; const S = this.sim.fdm.sys;
    const cart = this.vehicle(j, GSE.gagpu()); const tech = this.person(j, 'crew', 11);
    const spot = fr.w(1.7 * k, -2.3 * k), from = this.fboPoint(fr);
    let cable = null;
    const plug = () => { const p = fr.w(1.05 * k, -0.52 * k); return V3(p[0], this.gh(p[0], p[1]) + 0.75 * k, p[1]); };
    const sync = () => { const o = tech.o; const fx = Math.cos(-o.rotation.y), fz = Math.sin(-o.rotation.y); cart.o.position.set(o.position.x + fx * 0.95, this.gh(o.position.x, o.position.z), o.position.z + fz * 0.95); cart.o.rotation.y = o.rotation.y + Math.PI; return false; };
    const pushTo = (pts, speed) => [this.S.once(() => { tech.carry = true; tech.go(pts, speed); }), (dt) => { sync(); return !tech.moving; }];
    if (disconnectOnly) {
      tech.at(spot[0] - fr.f[0] * 1.0, spot[1] - fr.f[1] * 1.0, fr.f[0], fr.f[1]); sync(); cable = this.addExtra(j, hoseMesh(sagPoints(V3(cart.o.position.x, cart.o.position.y + 0.65, cart.o.position.z), plug(), 0.35), 0.02)); j.phase = 'active'; j.release = true;
    } else {
      tech.at(from[0], from[1], fr.f[0], fr.f[1]); sync();
    }
    const approach = [fr.w(-3.5 * k, -7.5 * k), fr.w(1.7 * k - 1.0, -6.5 * k), [spot[0] - fr.f[0] * 1.0, spot[1] - fr.f[1] * 1.0]];
    j.steps = [
      ...(disconnectOnly ? [] : [
        this.S.once(() => { j.status = 'En route'; this.toast('Ground power cart on the way', 2200); }),
        ...pushTo(approach, 1.25),
        this.S.once(() => { tech.carry = false; tech.work = 1; j.status = 'Connecting'; }), this.S.wait(2.5),
        this.S.once(() => { cable = this.addExtra(j, hoseMesh(sagPoints(V3(cart.o.position.x, cart.o.position.y + 0.65, cart.o.position.z), plug(), 0.35), 0.02)); S.extPower = true; tech.work = 0; j.status = 'Connected'; j.phase = 'active'; j.note = '28 V DC connected · external power available'; this.toast('Ground power connected · 28 V DC', 2500); this.sim.panelDirty = true; }),
      ]),
      this.S.until(() => j.release || this.sim.fdm.eng.running),
      this.S.once(() => { j.phase = 'leaving'; j.status = 'Disconnecting'; tech.work = 1; if (this.sim.fdm.eng.running) this.toast('Engine running — line tech pulls the ground power plug', 2500); }), this.S.wait(2.0),
      this.S.once(() => { this.removeExtra(j, cable); S.extPower = false; tech.work = 0; this.sim.panelDirty = true; this.toast('Ground power disconnected', 2000); }),
      ...pushTo([fr.w(-3.5 * k, -8 * k), from], 1.3),
    ];
    return j;
  }
  // ---------------- passengers
  jobBoard() {
    const j = this.newJob('Boarding'); const fr = this.frame(); const k = fr.k; const n = clamp(+this.opts.pax || 1, 1, (k < 1 ? 1 : 3) - this.pax);
    const from = this.fboPoint(fr); const door = [0.15 * k, 1.05 * k]; const pax = [];
    const guide = this.person(j, 'crew', 21); guide.at(from[0], from[1], fr.f[0], fr.f[1]);
    for (let i = 0; i < n; i++) { const p = this.person(j, 'pax', 40 + this.pax * 7 + i * 3); p.at(from[0] - fr.f[0] * (i + 1) * 1.4, from[1] - fr.f[1] * (i + 1) * 1.4, fr.f[0], fr.f[1]); if (i === 0) { const bag = GSE.rollerBag(0x2b3a55); bag.position.set(-0.55, 0, 0.25); p.o.add(bag); } pax.push(p); }
    const path = this.walkAround(fr, from, door); let boarded = 0;
    j.steps = [
      this.S.once(() => { j.status = 'Walking out'; this.toast(`${n} passenger${n > 1 ? 's' : ''} walking out from the FBO`, 2500); guide.go(path.slice(0, -1), 1.3); pax.forEach((p) => p.go(path, 1.2)); }),
      (dt) => { j.phase = 'active'; for (const p of pax) if (p.o.visible && !p.moving) { p.o.visible = false; boarded++; this.pax++; this.sim.fdm.payload = (this.sim.fdm.payload ?? 80) + 80; j.note = `${boarded} of ${n} on board`; } return boarded >= n; },
      this.S.once(() => { j.status = 'Doors closing'; this.toast(`Boarding complete · ${this.pax} passenger${this.pax > 1 ? 's' : ''} on board`, 2500); }), this.S.wait(1.5),
      this.S.once(() => { j.phase = 'leaving'; guide.go([from], 1.3); }), this.S.arrive(guide),
    ];
    return j;
  }
  jobDeboard() {
    const j = this.newJob('Deboarding'); const fr = this.frame(); const k = fr.k; const n = this.pax; const from = this.fboPoint(fr); const door = fr.w(0.15 * k, 1.05 * k); const pax = [];
    for (let i = 0; i < n; i++) { const p = this.person(j, 'pax', 40 + i * 3); p.at(door[0], door[1], fr.r[0], fr.r[1]); p.o.visible = false; pax.push(p); }
    const back = this.walkAround(fr, from, [0.15 * k, 1.05 * k]).slice(0, -1).reverse().concat([from]);
    j.steps = [
      ...pax.flatMap((p, i) => [this.S.once(() => { j.status = 'Deboarding'; j.phase = 'active'; p.o.visible = true; p.go(back, 1.25); this.pax--; this.sim.fdm.payload = Math.max(0, (this.sim.fdm.payload ?? 80) - 80); j.note = `${i + 1} of ${n} off the aircraft`; }), this.S.wait(2.2)]),
      this.S.once(() => { j.phase = 'leaving'; j.status = 'Walking in'; }), this.S.arrive(...pax),
    ];
    return j;
  }
  // ---------------- baggage hand cart
  jobBags() {
    const j = this.newJob('Baggage'); const fr = this.frame(); const k = fr.k; const from = this.fboPoint(fr);
    const tech = this.person(j, 'crew', 31); tech.at(from[0], from[1], fr.f[0], fr.f[1]);
    const cart = this.vehicle(j, GSE.handcart()); const doorL = [-1.15 * k, -1.25 * k];
    const sync = () => { const o = tech.o; const fx = Math.cos(-o.rotation.y), fz = Math.sin(-o.rotation.y); cart.o.position.set(o.position.x + fx * 0.85, this.gh(o.position.x, o.position.z), o.position.z + fz * 0.85); cart.o.rotation.y = o.rotation.y; return !tech.moving; };
    const path = this.walkAround(fr, from, [doorL[0] - 0.9, doorL[1] - 0.4]);
    j.steps = [
      this.S.once(() => { j.status = 'En route'; tech.carry = true; tech.go(path, 1.2); }), () => sync(),
      this.S.once(() => { j.status = 'Loading'; j.phase = 'active'; tech.carry = false; tech.work = 1; tech.o.rotation.y = yawOf(fr.r[0], fr.r[1]); }),
      this.S.wait(7),
      this.S.once(() => { tech.work = 0; this.bags = Math.min(3, this.bags + 2); this.sim.fdm.payload = (this.sim.fdm.payload ?? 80) + 25; j.note = 'Bags stowed and strapped'; this.toast('Baggage loaded · +55 lb', 2200); j.phase = 'leaving'; tech.carry = true; tech.go(path.slice(0, -1).reverse().concat([from]), 1.3); }),
      () => sync(),
    ];
    return j;
  }
  // ---------------- FBO catering van
  jobCatering() {
    const j = this.newJob('Catering'); const fr = this.frame(); const k = fr.k; const fd = fr.dir(0);
    const van = this.vehicle(j, GSE.van()); const park = fr.w(-1.5, 9.5 * k + 0.5), start = fr.w(-55, 16); van.at(start[0], start[1], fd[0], fd[1]);
    const chef = this.person(j, 'chef', 51); chef.o.visible = false; const cooler = GSE.cooler(); cooler.position.set(0.42, 1.02, 0); cooler.visible = false; chef.o.add(cooler);
    const toW = (lx, lz) => { van.o.updateMatrixWorld(); const p = V3(lx, 0, lz).applyMatrix4(van.o.matrixWorld); return [p.x, p.z]; };
    j.steps = [
      this.S.once(() => { j.status = 'En route'; van.go(route([start[0], start[1], fd], [park[0], park[1], fd]), 7); this.toast('Catering van on the way', 2200); }),
      this.S.arrive(van),
      this.S.once(() => { const r = toW(-3.2, 0.3); chef.at(...toW(1.0, -1.2), -fr.r[0], -fr.r[1]); chef.o.visible = true; chef.go([r], 1.1); }), this.S.arrive(chef),
      this.S.once(() => { j.status = 'Delivering'; j.phase = 'active'; cooler.visible = true; chef.carry = true; chef.go(this.walkAround(fr, [chef.o.position.x, chef.o.position.z], [0.15 * k, 1.15 * k]), 1.1); }), this.S.arrive(chef),
      this.S.once(() => { chef.carry = false; chef.work = 1; }), this.S.wait(3),
      this.S.once(() => { cooler.visible = false; chef.work = 0; j.note = 'Cooler with snacks, water and coffee placed on the rear seat'; this.toast('Catering delivered', 2200); chef.go([toW(1.0, -1.2)], 1.25); }), this.S.arrive(chef),
      this.S.once(() => { chef.o.visible = false; j.phase = 'leaving'; j.status = 'Leaving'; const end = fr.w(45, 22); van.go(route([park[0], park[1], fd], [end[0], end[1], fr.dir(40)]), 7); }), this.S.arrive(van),
    ];
    return j;
  }
  // ---------------- GA tug: tow / pushback
  jobPush() {
    const j = this.newJob('Pushback'); const F = this.sim.fdm; const fr = this.frame(); const k = fr.k;
    const tug = this.vehicle(j, GSE.gatug()); const drv = makePerson('crew', 61); drv.position.set(-0.55, 0.3, 0); drv.rotation.y = 0;
    for (const l of drv.userData.limbs) { l.lp.rotation.z = 1.45; l.ap.rotation.z = 0.9; } tug.o.add(drv);
    const nose = () => { const f = this.frame(); return f.w(1.36 * k, 0); };
    const cradle = tug.o.userData.cradleX ?? 1.15;
    const n0 = nose(); const tgt = [n0[0] + fr.f[0] * cradle, n0[1] + fr.f[1] * cradle]; const back = [-fr.f[0], -fr.f[1]];
    const start = fr.w(28, 7); tug.at(start[0], start[1], back[0], back[1]);
    const plan = this.opts.push === 'straight' ? { s1: 14, turn: 0, s2: 0 } : { s1: 3, turn: (this.opts.push === 'left' ? 1 : -1) * 90, s2: 2.5 };
    const R = 6.5; const st = { M: null, hdg: fr.hdg, s: 0, v: 0, turned: 0, phase: 0, dir: [fr.f[0], fr.f[1]] };
    this.pushState = st; this.pushJob = j;
    const attach = () => { // keep the tug on the nose wheel, aligned with the nose wheel's direction of travel
      const f = this.frame(); const nw = f.w(1.36 * k, 0); const d = st.dir; tug.o.position.set(nw[0] + d[0] * cradle, this.gh(nw[0], nw[1]), nw[1] + d[1] * cradle); tug.o.rotation.y = yawOf(-d[0], -d[1]);
    };
    j.steps = [
      this.S.once(() => { j.status = 'Tug en route'; this.toast('Tug on the way', 2000); tug.go(route([start[0], start[1], fr.dir(-160)], [tgt[0], tgt[1], back]), 4); }),
      this.S.arrive(tug),
      this.S.once(() => { j.status = 'Connected'; j.note = 'Tug connected — release the parking brake (P) to start the push'; this.toast('Tug connected · release the parking brake to begin', 3500); }),
      this.S.until(() => !F.ctrl.parkBrake),
      this.S.once(() => { j.status = 'Pushing back'; j.phase = 'active'; j.note = plan.turn ? `Pushing back, tail ${plan.turn > 0 ? 'left' : 'right'}` : 'Pushing straight back'; st.M = fr.w(-0.3 * k, 0); this.toast('Pushback started', 1800); }),
      (dt) => {
        if (F.eng.running || F.ctrl.throttle > 0.25 && F.eng.running) { j.note = 'Stopped — engine running'; this.stopPush(); }
        const total = plan.s1 + Math.abs(plan.turn) * D2R * R + plan.s2;
        const stopping = st.stop || st.s >= total - 0.01;
        const vt = stopping ? 0 : Math.min(0.9, Math.sqrt(2 * 0.25 * Math.max(0, total - st.s)) + 0.05);
        st.v += clamp(vt - st.v, -0.6 * dt, 0.35 * dt); const ds = st.v * dt; st.s += ds;
        let w = 0; if (plan.turn && st.s > plan.s1 && st.turned < Math.abs(plan.turn)) { w = Math.sign(plan.turn) * (ds / R) / D2R; st.turned += Math.abs(w); }
        const h = st.hdg * D2R, f = [Math.sin(h), -Math.cos(h)];
        st.M = [st.M[0] - f[0] * ds, st.M[1] - f[1] * ds]; st.hdg = (st.hdg + w + 360) % 360;
        // nose-wheel velocity -> tug direction
        if (ds > 1e-5) { const h2 = st.hdg * D2R, f2 = [Math.sin(h2), -Math.cos(h2)], r2 = [Math.cos(h2), Math.sin(h2)]; const om = (w * D2R) / ds; const vx = -f2[0] + r2[0] * om * 1.66 * k, vz = -f2[1] + r2[1] * om * 1.66 * k; const l = Math.hypot(vx, vz); const want = [-vx / l, -vz / l]; st.dir = [st.dir[0] + (want[0] - st.dir[0]) * Math.min(1, dt * 3), st.dir[1] + (want[1] - st.dir[1]) * Math.min(1, dt * 3)]; const dl = Math.hypot(st.dir[0], st.dir[1]); st.dir = [st.dir[0] / dl, st.dir[1] / dl]; }
        this.applyPush(); attach();
        j.note = `${j.note.split(' ·')[0]} · ${st.s.toFixed(1)} m`;
        return stopping && st.v < 0.02;
      },
      this.S.once(() => { j.status = 'Set brake'; j.phase = 'leaving'; j.note = 'Push complete — set the parking brake (P) so the tug can disconnect'; this.toast('Push complete · set parking brake', 3000); this.pushState = null; }),
      this.S.until(() => F.ctrl.parkBrake),
      this.S.once(() => { j.status = 'Disconnecting'; }), this.S.wait(2),
      this.S.once(() => { const p = tug.o.position; const d = st.dir; tug.go([[p.x + d[0] * 3.5, p.z + d[1] * 3.5]], 1.0, { reverse: true }); }), this.S.arrive(tug),
      this.S.once(() => { j.status = 'Leaving'; this.toast('Tug disconnected · clear to start and taxi', 2800); const p = tug.o.position, d = st.dir, s2 = [-d[1], d[0]]; const end = [p.x + d[0] * 25 + s2[0] * 25, p.z + d[1] * 25 + s2[1] * 25]; tug.go(route([p.x, p.z, d], [end[0], end[1], s2]), 4); }),
      this.S.arrive(tug),
    ];
    return j;
  }
  stopPush() { if (this.pushState) { this.pushState.stop = true; this.toast('Stopping pushback', 1500); } }
  // kinematic tow: the aircraft pivots about the main gear while the tug steers the nose
  applyPush() {
    const st = this.pushState; if (!st || !st.M) return; const F = this.sim.fdm; const k = F.aircraft.visualScale ?? 1;
    const h = st.hdg * D2R, f = [Math.sin(h), -Math.cos(h)];
    const att = F.attitude; F.pos[0] = st.M[0] + f[0] * 0.3 * k; F.pos[2] = st.M[1] + f[1] * 0.3 * k;
    F.q = qFromHPR(st.hdg, att.pitch, att.roll); F.vel = [0, 0, 0]; F.omega = [0, 0, 0];
  }
}

// ------------------------------------------------------------------ AI gate activity
// stands: [{ cx, cz, wx, wz, nx, nz, ty, lv, G (airliner geometry info), label }]; returns { static meshes added to group, update }
export function buildGateServices(a, stands, opts) { return gseLowDetail(() => buildGateServices_(a, stands, opts)); }
function buildGateServices_(a, stands, { group, gh, rnd, major }) {
  const sv = new MB(); const live = []; const peopleSets = [];
  const labels = stands.map((s) => s.label); const signs = gateSignAtlas(labels);
  const ground = (x, z) => gh(x, z) + 0.06;
  const onApron = (x, z) => a.aprons.some((ap) => pointInPoly(x, z, ap.p));
  // choose pushback stands (narrow-bodies whose push and taxi-out path stays on the apron)
  let pushLeft = major ? (a.icao === 'KSFO' ? 2 : 1) : 0, remoteLeft = major ? (a.icao === 'KSFO' ? 3 : 1) : 0;
  const cargo = (lv) => lv === 'FDX' || lv === 'UPS';
  const order = stands.map((s, i) => i).sort(() => rnd() - 0.5);
  for (const i of order) {
    const s = stands[i]; const T = s.G.T;
    if (pushLeft > 0 && !T.wide && !cargo(s.lv)) {
      const L = T.L, f = [-s.nx, -s.nz]; let ok = null;
      for (const sign of [1, -1]) {
        const r = [-f[1] * sign, f[0] * sign]; // side the tail swings to
        const back = 0.35 * L + 0.75 * L; const mx = s.cx - f[0] * back + r[0] * 0.75 * L, mz = s.cz - f[1] * back + r[1] * 0.75 * L;
        const ex = mx - r[0] * 0, ez = mz; const fwd2 = [-r[0], -r[1]];
        const pts = [[s.cx - f[0] * 0.35 * L, s.cz - f[1] * 0.35 * L], [mx, mz], [mx + fwd2[0] * 60, mz + fwd2[1] * 60]];
        if (pts.every((p) => onApron(p[0], p[1]))) { ok = sign; void ex; void ez; break; }
      }
      if (ok) { s.mode = 'push'; s.turnSign = ok; pushLeft--; continue; }
    }
    if (cargo(s.lv)) { s.mode = 'cargo'; continue; }
    if (remoteLeft > 0 && rnd() < 0.5) { s.mode = 'remote'; remoteLeft--; continue; }
    s.mode = 'gate';
  }
  for (const s of stands) {
    const T = s.G.T, L = T.L, R = T.D / 2, gearH = s.G.gearH; const g0 = gh(s.cx, s.cz);
    const f = [-s.nx, -s.nz], rt = [s.nz, -s.nx], lf = [-s.nz, s.nx];
    const P = (lx, lz) => [s.cx + f[0] * lx + rt[0] * lz, s.cz + f[1] * lx + rt[1] * lz];
    const sill = gearH - 0.3 * R; const yaw = (rel) => { const c = Math.cos(rel), sn = Math.sin(rel); return [f[0] * c - f[1] * sn, f[1] * c + f[0] * sn]; };
    const put = (obj, p, dir, y = null) => { obj.position.set(p[0], y ?? ground(p[0], p[1]), p[1]); obj.rotation.set(0, yawOf(dir[0], dir[1]), 0); return obj; };
    // ---- jet bridge to L1
    const door = P(0.4 * L, -R * 0.98); const D = V3(door[0], g0 + sill, door[1]);
    const rotP = [s.wx + s.nx * 4.6 + lf[0] * (R + 11 + 0.1 * L), s.wz + s.nz * 4.6 + lf[1] * (R + 11 + 0.1 * L)];
    const jb = new JetBridge({ rot: { x: rotP[0], z: rotP[1] }, gr: gh(rotP[0], rotP[1]), yR: g0 + sill + 0.25, n: { x: s.nx, z: s.nz }, label: s.label, atlas: signs.atlas, labelRect: signs.rects[s.label] });
    const nOut = V3(lf[0], 0, lf[1]);
    jb.pose(D, nOut);
    const Jd = V3(D.x - jb.rot.x, 0, D.z - jb.rot.z).normalize();
    const Dstow = D.clone().addScaledVector(Jd, -0.36 * (jb.L0 || 10));
    if (s.mode === 'remote' || s.mode === 'cargo') jb.pose(Dstow, nOut);
    if (s.mode !== 'push') { sv.bake(jb.group); } else group.add(jb.group);
    // ---- cones at the nose and wingtips
    const tipX = 0.06 * L - Math.tan(T.sweep * D2R) * T.span / 2;
    const cones = [P(L / 2 + 1.5, 0), P(tipX, T.span / 2 + 1.2), P(tipX, -T.span / 2 - 1.2), P(-L / 2 - 1.5, 0)];
    if (s.mode !== 'push') { const cg = GSE.cones(cones); cg.position.set(0, g0 + 0.04, 0); sv.bake(cg); }
    const crewHere = [];
    // ---- GPU at the nose
    if (s.mode !== 'push' && (s.mode === 'cargo' || rnd() < 0.55)) {
      const p = P(0.33 * L, 4.2); const gpu = put(GSE.gpu(), p, f); sv.bake(gpu);
      const plugP = P(0.36 * L, 0.6); const a0 = V3(p[0], ground(p[0], p[1]) + 1.0, p[1]); const b0 = V3(plugP[0], g0 + gearH - R * 0.85, plugP[1]);
      sv.bake(hoseMesh([a0, V3((a0.x + b0.x) / 2, g0 + 0.12, (a0.z + b0.z) / 2), b0], 0.04));
    }
    // ---- baggage: belt loader at the forward hold, tractor and carts alongside
    if (s.mode !== 'push' && (s.mode === 'cargo' || s.mode === 'remote' || rnd() < 0.6)) {
      const dp = P(0.25 * L, R); const hs = gearH - 0.85 * R;
      const belt = GSE.belt(); setBelt(belt, hs); const ld = yaw(-Math.PI / 2 + 0.12); // facing the fuselage
      put(belt, [dp[0] - ld[0] * 4.05, dp[1] - ld[1] * 4.05], ld); sv.bake(belt);
      const tr = put(GSE.bagtractor(), P(0.25 * L + 2.5, R + 9.5), f); sv.bake(tr);
      for (let c = 0; c < 3; c++) sv.bake(put(GSE.cart(c + s.cx), P(0.25 * L - 1.4 - c * 3.9, R + 9.5), f));
      crewHere.push({ kind: 'crew', loop: [P(0.25 * L - 2, R + 8.3), P(0.25 * L - 0.5, R + 4.6)], speed: 1.1 });
      crewHere.push({ kind: 'crew', stand: P(0.25 * L - 0.9, R + 3.3), face: [-rt[0], -rt[1]], work: true });
    }
    // ---- catering high-loader at R2 (raised to the door)
    if (s.mode === 'gate' && rnd() < 0.4) {
      const dp = P(-0.3 * L, R); const dir = [-rt[0], -rt[1]]; const cat = GSE.catering();
      put(cat, [dp[0] + rt[0] * (5.9 + 0.25), dp[1] + rt[1] * (5.9 + 0.25)], dir); setLift(cat, sill); sv.bake(cat);
    }
    // ---- Jet A truck ahead of the right wing with the hose to the underwing coupling
    if ((s.mode === 'gate' || s.mode === 'remote') && rnd() < 0.45) {
      const z = 0.3 * T.span, le = 0.06 * L + L * (T.wide ? 0.17 : 0.19) * 0.5 - Math.tan(T.sweep * D2R) * z;
      const tp = P(le + 7.4, z + 0.5); const truck = put(GSE.jet(), tp, f); sv.bake(truck);
      truck.updateMatrixWorld(); const reel = V3(2.85, 1.95, 1.3).applyMatrix4(truck.matrixWorld);
      const cp = P(le - 1.4, z); const c = V3(cp[0], g0 + gearH - 0.55 * R - 0.1, cp[1]);
      sv.bake(hoseMesh([reel, V3(reel.x, g0 + 0.1, reel.z), V3((reel.x + c.x) / 2, g0 + 0.1, (reel.z + c.z) / 2), V3(c.x, g0 + 0.15, c.z).lerp(V3(reel.x, g0, reel.z), 0.1), c], 0.05));
      crewHere.push({ kind: 'fuel', stand: P(le - 0.6, z - 1.2), face: rt, work: true });
    }
    // ---- remote stand: air stairs at L1 + L2, apron bus with passengers walking to the stairs
    if (s.mode === 'remote') {
      const stairsAt = (lx) => { const dp = P(lx, -R); const st = GSE.stairs(sill); const dir = rt; put(st, [dp[0] - dir[0] * (3.36 + 0.2), dp[1] - dir[1] * (3.36 + 0.2)], dir); sv.bake(st); st.updateMatrixWorld(); return { st, bottom: V3(st.userData.bottomX - 0.6, 0, 0).applyMatrix4(st.matrixWorld), top: V3(2.9, sill, 0).applyMatrix4(st.matrixWorld) }; };
      const s1 = stairsAt(0.4 * L), s2 = stairsAt(-0.3 * L);
      const bp = P(0.05 * L, -R - 14.5); const bus = put(GSE.bus(), bp, f); sv.bake(bus); bus.updateMatrixWorld();
      for (const [st, doorX] of [[s1, 4.3], [s2, -4.3]]) {
        const bd = V3(doorX, 0, 1.75).applyMatrix4(bus.matrixWorld);
        peopleSets.push({ type: 'pax', from: [bd.x, bd.z], to: [st.bottom.x, st.bottom.z], top: [st.top.x, st.top.z], topY: g0 + sill, count: 5, people: [] });
      }
      crewHere.push({ kind: 'crew', stand: [s1.bottom.x + lf[0] * 1.2, s1.bottom.z + lf[1] * 1.2], face: rt, work: false });
    }
    for (const c of crewHere) peopleSets.push({ type: 'crew', ...c, people: [] });
    // ---- pushback stand: separate aircraft, animated bridge and tug
    if (s.mode === 'push') {
      const ac = buildAirliner(s.ty, s.lv); ac.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); group.add(ac);
      const tug = GSE.tug(); setTowbar(tug, true); group.add(tug);
      const st = { s, ac, tug, jb, D, Dstow, nOut, L, R, f, mode: 'docked', t: 20 + rnd() * 90, x: s.cx, z: s.cz, hdg: Math.atan2(f[0], -f[1]) / D2R, v: 0, dist: 0, turned: 0, sign: s.turnSign, g0, ground, tugDir: [f[0], f[1]], fade: 1 };
      live.push(st); placePush(st);
    }
  }
  const svG = sv.build(new THREE.Group()); svG.name = 'gateServices'; group.add(svG);
  // people actors (only animated near the camera)
  const actors = new THREE.Group(); actors.name = 'gateActors'; group.add(actors);
  const seeds = rng2(a.icao.charCodeAt(1) * 31 + a.icao.charCodeAt(3));
  for (const set of peopleSets) {
    if (set.type === 'pax') {
      for (let i = 0; i < set.count; i++) { const p = makePerson('pax', Math.floor(seeds() * 1e6)); if (seeds() < 0.5) { const b = GSE.rollerBag([0x2b3a55, 0x1b1d21, 0x7a1f22, 0x9a9da3][i % 4]); b.position.set(-0.5, 0, 0.25); p.add(b); } actors.add(p); set.people.push({ o: p, s: -i * 4.5 }); }
    } else { const p = makePerson(set.kind, Math.floor(seeds() * 1e6)); actors.add(p); set.people.push({ o: p, s: seeds() * 10 }); }
  }
  let near = false;
  return {
    update(dt, camPos, t) {
      if (!camPos) return;
      const d = Math.hypot(camPos.x - a.arp[0], camPos.z - a.arp[1]); near = d < a.radius + 1500;
      for (const st of live) stepPush(st, near ? dt : dt, camPos);
      svG.visible = d < a.radius + 2500; actors.visible = d < a.radius + 600; if (!actors.visible) return;
      for (const set of peopleSets) {
        if (set.type === 'pax') {
          const L1 = Math.hypot(set.to[0] - set.from[0], set.to[1] - set.from[1]), L2 = 3.5; const cyc = L1 + L2 + 6;
          for (const q of set.people) {
            q.s += dt * 1.15; const s = ((q.s % cyc) + cyc) % cyc; const o = q.o;
            if (q.s < 0 || s > L1 + L2) { o.visible = false; continue; } o.visible = true;
            let x, z, y, dir;
            if (s < L1) { const k = s / L1; x = set.from[0] + (set.to[0] - set.from[0]) * k; z = set.from[1] + (set.to[1] - set.from[1]) * k; y = ground(x, z); dir = [set.to[0] - set.from[0], set.to[1] - set.from[1]]; }
            else { const k = (s - L1) / L2; x = set.to[0] + (set.top[0] - set.to[0]) * k; z = set.to[1] + (set.top[1] - set.to[1]) * k; y = ground(set.to[0], set.to[1]) + 1.0 + (set.topY - ground(set.to[0], set.to[1]) - 1.0) * k; dir = [set.top[0] - set.to[0], set.top[1] - set.to[1]]; }
            o.position.set(x, y, z); o.rotation.y = yawOf(dir[0], dir[1]); posePerson(o, dt, 1.15);
          }
        } else {
          const q = set.people[0], o = q.o;
          if (set.loop) {
            const A = set.loop[0], B = set.loop[1], Ld = Math.hypot(B[0] - A[0], B[1] - A[1]); q.s += dt * set.speed; const cyc = Ld * 2 + 6; const s = q.s % cyc;
            let k, moving = true, dir; if (s < Ld) { k = s / Ld; dir = [B[0] - A[0], B[1] - A[1]]; } else if (s < Ld + 3) { k = 1; moving = false; dir = [B[0] - A[0], B[1] - A[1]]; } else if (s < Ld * 2 + 3) { k = 1 - (s - Ld - 3) / Ld; dir = [A[0] - B[0], A[1] - B[1]]; } else { k = 0; moving = false; dir = [B[0] - A[0], B[1] - A[1]]; }
            const x = A[0] + (B[0] - A[0]) * k, z = A[1] + (B[1] - A[1]) * k; o.position.set(x, ground(x, z), z); o.rotation.y = yawOf(dir[0], dir[1]); posePerson(o, dt, moving ? set.speed : 0, { carry: !moving || k > 0.5 });
          } else { o.position.set(set.stand[0], ground(set.stand[0], set.stand[1]), set.stand[1]); o.rotation.y = yawOf(set.face[0], set.face[1]); posePerson(o, dt, 0, { work: set.work ? 1 : 0 }); }
        }
      }
    },
  };
}
function rng2(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---- AI pushback cycle: docked -> bridge retracts -> push with tail swing -> engine start -> taxi out -> (away) -> new arrival
function placePush(st) {
  const h = st.hdg * D2R, f = [Math.sin(h), -Math.cos(h)];
  st.ac.position.set(st.x, st.ground(st.x, st.z) - 0.06, st.z); st.ac.rotation.set(0, Math.atan2(-f[0], -f[1]), 0);
  const ng = 0.38 * st.L; const nw = [st.x + f[0] * ng, st.z + f[1] * ng]; const d = st.tugDir; const bar = st.tug.userData.towbarLen ?? 8.4;
  st.tug.position.set(nw[0] + d[0] * bar, st.ground(nw[0], nw[1]), nw[1] + d[1] * bar); st.tug.rotation.y = yawOf(-d[0], -d[1]);
}
function stepPush(st, dt, cam) {
  st.t -= dt;
  const beacon = st.ac.userData.beacon; if (beacon) beacon.visible = (st.mode === 'push' || st.mode === 'start' || st.mode === 'taxi') && (performance.now() % 1000 < 120);
  switch (st.mode) {
    case 'docked': if (st.t <= 0) { st.mode = 'retract'; st.t = 10; } break;
    case 'retract': { const k = Math.min(1, 1 - st.t / 10); const e = k * k * (3 - 2 * k); st.jb.pose(st.D.clone().lerp(st.Dstow, e), st.nOut); if (st.t <= 0) { st.mode = 'push'; st.v = 0; st.dist = 0; st.turned = 0; } break; }
    case 'push': {
      const s1 = 0.35 * st.L, Rt = 0.75 * st.L, total = s1 + Rt * Math.PI / 2 + 4;
      const vt = Math.min(1.4, Math.sqrt(2 * 0.12 * Math.max(0, total - st.dist)) + 0.05); st.v += clamp(vt - st.v, -0.4 * dt, 0.18 * dt); const ds = st.v * dt; st.dist += ds;
      let w = 0; if (st.dist > s1 && st.turned < 90) { w = st.sign * (ds / Rt) / D2R; st.turned += Math.abs(w); }
      const h = st.hdg * D2R, f = [Math.sin(h), -Math.cos(h)]; st.x -= f[0] * ds; st.z -= f[1] * ds; st.hdg += w;
      if (ds > 1e-6) { const h2 = st.hdg * D2R, f2 = [Math.sin(h2), -Math.cos(h2)], r2 = [Math.cos(h2), Math.sin(h2)]; const om = (w * D2R) / ds; const vx = -f2[0] + r2[0] * om * 0.38 * st.L, vz = -f2[1] + r2[1] * om * 0.38 * st.L; const l = Math.hypot(vx, vz); const want = [-vx / l, -vz / l]; st.tugDir = [st.tugDir[0] + (want[0] - st.tugDir[0]) * Math.min(1, dt * 2), st.tugDir[1] + (want[1] - st.tugDir[1]) * Math.min(1, dt * 2)]; const dl = Math.hypot(...st.tugDir); st.tugDir = [st.tugDir[0] / dl, st.tugDir[1] / dl]; }
      placePush(st);
      if (st.dist >= total - 0.05 && st.v < 0.03) { st.mode = 'unhook'; st.t = 6; }
      break;
    }
    case 'unhook': if (st.t <= 0) { setTowbar(st.tug, false); st.mode = 'start'; st.t = 18; st.tugGo = { s: 0 }; } break;
    case 'start': {
      // tug pulls forward and away to the side
      const g = st.tugGo; g.s += dt; const d = st.tugDir; const side = [-d[1] * st.sign, d[0] * st.sign]; const sp = Math.min(3, g.s * 0.6);
      st.tug.position.x += (d[0] * 0.4 + side[0] * 0.9) * sp * dt; st.tug.position.z += (d[1] * 0.4 + side[1] * 0.9) * sp * dt; st.tug.rotation.y = yawOf(d[0] * 0.4 + side[0] * 0.9, d[1] * 0.4 + side[1] * 0.9);
      if (st.t <= 0) { st.mode = 'taxi'; st.v = 0; st.dist = 0; st.tug.visible = false; }
      break;
    }
    case 'taxi': {
      st.v = Math.min(5, st.v + dt * 0.5); const h = st.hdg * D2R, f = [Math.sin(h), -Math.cos(h)]; st.x += f[0] * st.v * dt; st.z += f[1] * st.v * dt; st.dist += st.v * dt;
      st.ac.position.set(st.x, st.ground(st.x, st.z) - 0.06, st.z); st.ac.rotation.set(0, Math.atan2(-f[0], -f[1]), 0);
      if (st.dist > 110) { st.mode = 'away'; st.ac.visible = false; st.t = 60 + Math.random() * 120; }
      break;
    }
    case 'away':
      if (st.t <= 0 && Math.hypot(cam.x - st.s.cx, cam.z - st.s.cz) > 350) { // a new aircraft has arrived at the gate
        st.x = st.s.cx; st.z = st.s.cz; st.hdg = Math.atan2(st.f[0], -st.f[1]) / D2R; st.tugDir = [st.f[0], st.f[1]];
        st.ac.visible = true; st.tug.visible = true; setTowbar(st.tug, true); st.jb.pose(st.D, st.nOut); placePush(st); st.mode = 'docked'; st.t = 60 + Math.random() * 100;
      }
      break;
  }
}
