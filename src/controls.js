// Key bindings (user-customisable) and mouse-flight settings.
// Every action has a default physical key (KeyboardEvent.code). The simulator logic is written against the
// default codes; remap() translates the key the user actually pressed into the default code of the action it is
// bound to, so the rest of the sim does not need to know about custom bindings. Shift-variants follow their key.

export const ACTIONS = [
  // [id, default code, label, group]
  ['pitchDown', 'ArrowUp', 'Elevator — push (nose down)', 'Flight controls'],
  ['pitchUp', 'ArrowDown', 'Elevator — pull (nose up)', 'Flight controls'],
  ['rollLeft', 'ArrowLeft', 'Ailerons left · Shift: heading bug −5°', 'Flight controls'],
  ['rollRight', 'ArrowRight', 'Ailerons right · Shift: heading bug +5°', 'Flight controls'],
  ['rudLeft', 'KeyZ', 'Rudder left', 'Flight controls'],
  ['rudRight', 'KeyX', 'Rudder right', 'Flight controls'],
  ['rudLeft2', 'KeyQ', 'Rudder left (alternate)', 'Flight controls'],
  ['rudRight2', 'KeyE', 'Rudder right (alternate) · Shift: auto-start', 'Flight controls'],
  ['trimDown', 'Home', 'Elevator trim nose down', 'Flight controls'],
  ['trimUp', 'End', 'Elevator trim nose up', 'Flight controls'],
  ['thrUp', 'KeyW', 'Throttle up (walk forward in views 2 / 7)', 'Engine & systems'],
  ['thrDown', 'KeyS', 'Throttle down (walk back)', 'Engine & systems'],
  ['thrUp2', 'PageUp', 'Throttle up (alternate)', 'Engine & systems'],
  ['thrDown2', 'PageDown', 'Throttle down (alternate)', 'Engine & systems'],
  ['mixRich', 'BracketRight', 'Mixture richer', 'Engine & systems'],
  ['mixLean', 'BracketLeft', 'Mixture leaner', 'Engine & systems'],
  ['flapsDown', 'KeyF', 'Flaps down one notch · Shift: failure panel', 'Flight controls'],
  ['flapsUp', 'KeyV', 'Flaps up one notch · Shift: avionics', 'Flight controls'],
  ['brakes', 'KeyB', 'Toe brakes (hold)', 'Flight controls'],
  ['brakeL', 'Comma', 'Left brake (hold)', 'Flight controls'],
  ['brakeR', 'Period', 'Right brake (hold)', 'Flight controls'],
  ['parkBrake', 'KeyP', 'Parking brake', 'Flight controls'],
  ['ignition', 'KeyI', 'Ignition key → START · Shift: → OFF', 'Engine & systems'],
  ['map', 'KeyM', 'Map · Shift: master switch', 'Engine & systems'],
  ['landLight', 'KeyL', 'Landing light · Shift: taxi light', 'Engine & systems'],
  ['strobe', 'KeyO', 'Strobes · Shift: nav lights', 'Engine & systems'],
  ['altimeter', 'KeyK', 'Set altimeter to field QNH', 'Engine & systems'],
  ['hdgSync', 'KeyD', 'Align heading indicator (walk right)', 'Engine & systems'],
  ['autopilot', 'KeyA', 'Autopilot engage / disconnect (walk left)', 'Autopilot'],
  ['checklist', 'KeyH', 'Checklists · Shift: AP HDG', 'Autopilot'],
  ['miniMap', 'KeyN', 'Mini-map · Shift: AP NAV', 'Autopilot'],
  ['fuelTruck', 'KeyR', 'Call fuel truck · Shift: AP APR', 'Autopilot'],
  ['taxiLine', 'KeyT', 'Taxi line · Shift: AP ALT', 'Autopilot'],
  ['groundSvc', 'KeyJ', 'Ground services · Shift: cancel all', 'Sim & views'],
  ['mouseYoke', 'KeyY', 'Mouse yoke on / off', 'Sim & views'],
  ['atc', 'KeyG', 'ATC panel', 'Sim & views'],
  ['strip', 'KeyU', 'Data strip', 'Sim & views'],
  ['nextView', 'KeyC', 'Next view', 'Sim & views'],
  ['view1', 'Digit1', 'Cockpit view', 'Sim & views'],
  ['view2', 'Digit2', 'Cabin walk view', 'Sim & views'],
  ['view3', 'Digit3', 'Orbit view', 'Sim & views'],
  ['view4', 'Digit4', 'Chase view', 'Sim & views'],
  ['view5', 'Digit5', 'Tower view', 'Sim & views'],
  ['view6', 'Digit6', 'Fly-by view', 'Sim & views'],
  ['view7', 'Digit7', 'Walkaround view', 'Sim & views'],
  ['simRate', 'Digit9', 'Sim rate 1× / 2× / 4×', 'Sim & views'],
  ['recenter', 'Space', 'Recenter view', 'Sim & views'],
  ['help', 'Slash', 'This controls window (pauses the sim)', 'Sim & views'],
  ['perf', 'Semicolon', 'Detailed performance stats', 'Sim & views'],
].map(([id, def, label, group]) => ({ id, def, label, group }));

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));
const DEFAULT_CODES = new Set(ACTIONS.map((a) => a.def));
const LS_KEYS = 'skyhawk.keys.v1', LS_MOUSE = 'skyhawk.mouse.v1';

const load = (k, d) => { try { return { ...d, ...(JSON.parse(localStorage.getItem(k) || 'null') || {}) }; } catch { return { ...d }; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export const binds = load(LS_KEYS, {});            // action id -> code (only when changed)
export const mouseSettings = load(LS_MOUSE, { sens: 1, dead: 0.04, invert: false, wheelThrottle: true, rudderButton: true, expo: 0.35 });

let phys = new Map(); // physical code -> default code
function rebuild() { phys = new Map(); for (const a of ACTIONS) phys.set(binds[a.id] || a.def, a.def); }
rebuild();

export const codeOf = (id) => binds[BY_ID.get(id)?.id] || BY_ID.get(id)?.def;
export const changedCount = () => Object.keys(binds).filter((id) => BY_ID.has(id) && binds[id] !== BY_ID.get(id).def).length;

// physical key -> the default code the sim logic understands; null = key disabled (its action moved elsewhere)
export function remap(code) {
  if (phys.has(code)) return phys.get(code);
  if (DEFAULT_CODES.has(code)) return null;
  return code;
}

// bind an action to a key; if another action already uses that key, the two swap
export function bind(id, code) {
  const a = BY_ID.get(id); if (!a) return;
  const prev = codeOf(id);
  const other = ACTIONS.find((o) => o.id !== id && codeOf(o.id) === code);
  if (other) binds[other.id] = prev;
  binds[id] = code;
  for (const o of ACTIONS) if (binds[o.id] === o.def) delete binds[o.id];
  rebuild(); save(LS_KEYS, binds);
  return other;
}
export function resetBinds() { for (const k of Object.keys(binds)) delete binds[k]; rebuild(); save(LS_KEYS, binds); }
export function saveMouse() { save(LS_MOUSE, mouseSettings); }

// human-readable key name
export function keyName(code) {
  if (!code) return '—';
  const special = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/ ?', Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-', Equal: '=', Backslash: '\\', Space: 'Space', PageUp: 'PgUp', PageDown: 'PgDn' };
  if (special[code]) return special[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

// mouse yoke response: dead zone, then an expo curve so small movements are fine and full deflection is still there
export function mouseAxis(v) {
  const s = mouseSettings; const a = Math.abs(v);
  if (a < s.dead) return 0;
  let x = Math.min(1, (a - s.dead) / (1 - s.dead));
  x = (1 - s.expo) * x + s.expo * x * x * x;
  return Math.sign(v) * Math.min(1, x * s.sens);
}

// ---------- UI (inside the Controls window) ----------
export function buildControlsUI(root, { toast, onChange } = {}) {
  const el = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); Object.assign(e, attrs); if (html) e.innerHTML = html; return e; };
  root.replaceChildren();
  // mouse settings
  const ms = mouseSettings;
  const mouse = el('section', { className: 'ctlMouse' });
  mouse.innerHTML = `<h3>Mouse flight</h3>
    <p class="ctlNote">Press <kbd>${keyName(codeOf('mouseYoke'))}</kbd> to turn the mouse yoke on: the pointer position is the yoke (centre = neutral, a crosshair shows it).</p>
    <label>Sensitivity <output id="msSensO">${ms.sens.toFixed(2)}×</output><input id="msSens" type="range" min="0.4" max="2.5" step="0.05" value="${ms.sens}"></label>
    <label>Dead zone <output id="msDeadO">${Math.round(ms.dead * 100)}%</output><input id="msDead" type="range" min="0" max="0.25" step="0.01" value="${ms.dead}"></label>
    <label>Response curve <output id="msExpoO">${Math.round(ms.expo * 100)}%</output><input id="msExpo" type="range" min="0" max="0.9" step="0.05" value="${ms.expo}"></label>
    <label class="settingToggle"><input id="msInv" type="checkbox" ${ms.invert ? 'checked' : ''}> Invert pitch</label>
    <label class="settingToggle"><input id="msWheel" type="checkbox" ${ms.wheelThrottle ? 'checked' : ''}> Mouse wheel = throttle while the mouse yoke is on</label>
    <label class="settingToggle"><input id="msRud" type="checkbox" ${ms.rudderButton ? 'checked' : ''}> Hold the right button: mouse left / right = rudder &amp; nose-wheel steering</label>`;
  root.append(mouse);
  const hook = (id, key, fmt, num = true) => {
    const i = mouse.querySelector('#' + id); const o = mouse.querySelector('#' + id + 'O');
    i.addEventListener('input', () => { ms[key] = i.type === 'checkbox' ? i.checked : num ? +i.value : i.value; if (o && fmt) o.textContent = fmt(ms[key]); saveMouse(); onChange?.(); });
  };
  hook('msSens', 'sens', (v) => v.toFixed(2) + '×'); hook('msDead', 'dead', (v) => Math.round(v * 100) + '%'); hook('msExpo', 'expo', (v) => Math.round(v * 100) + '%');
  hook('msInv', 'invert'); hook('msWheel', 'wheelThrottle'); hook('msRud', 'rudderButton');

  // key bindings
  const keys = el('section', { className: 'ctlKeys' });
  const head = el('div', { className: 'ctlKeysHead' });
  head.append(el('h3', {}, 'Key bindings'), el('span', { className: 'ctlNote' }, 'Click a key, then press the new key (Esc cancels). Taken keys swap. Saved in this browser.'));
  const reset = el('button', { type: 'button', className: 'ctlReset' }, 'Reset to defaults');
  head.append(reset); keys.append(head);
  const grid = el('div', { className: 'ctlGrid' }); keys.append(grid);
  const groups = [...new Set(ACTIONS.map((a) => a.group))];
  const render = () => {
    grid.replaceChildren();
    for (const g of groups) {
      const col = el('div', { className: 'ctlGroup' }); col.append(el('h4', {}, g));
      for (const a of ACTIONS.filter((x) => x.group === g)) {
        const row = el('div', { className: 'ctlRow' });
        const b = el('button', { type: 'button', className: 'ctlKey' + (codeOf(a.id) !== a.def ? ' changed' : '') }, keyName(codeOf(a.id)));
        b.dataset.id = a.id; b.title = `Default: ${keyName(a.def)}`;
        row.append(b, el('span', {}, a.label)); col.append(row);
      }
      grid.append(col);
    }
  };
  let capturing = null;
  const stop = () => { if (!capturing) return; capturing.classList.remove('listening'); capturing = null; window.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    e.preventDefault(); e.stopImmediatePropagation();
    if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return;
    const id = capturing.dataset.id; stop();
    if (e.code === 'Escape') { render(); return; }
    const other = bind(id, e.code);
    toast?.(other ? `${BY_ID.get(id).label.split(' ·')[0]} → ${keyName(e.code)} (swapped with ${other.label.split(' ·')[0]})` : `${BY_ID.get(id).label.split(' ·')[0]} → ${keyName(e.code)}`, 2600);
    render(); onChange?.();
  };
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('.ctlKey'); if (!b) return;
    stop(); capturing = b; b.classList.add('listening'); b.textContent = 'press a key…';
    window.addEventListener('keydown', onKey, true);
  });
  reset.onclick = () => { stop(); resetBinds(); render(); toast?.('Key bindings reset to defaults', 1800); onChange?.(); };
  render();
  root.append(keys);
  return { stop, render };
}
