// A350-1000 flight deck geometry (body frame: x forward, y up, z right; origin = aircraft CG).
// Six display units + ISIS on the main panel, glareshield FCU/EFIS, overhead, pedestal with KCCUs/RMPs/ECP,
// thrust levers, flap lever, speed brake, landing-gear lever, sidesticks, tillers and rudder pedals.
import * as THREE from 'three';
import { clamp } from '../math.js';
import { DETENT } from './data.js';

const EYE_X = 30.15, EYE_Y = 1.47;
const qY = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
const qZ = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);

// a textured plane facing the pilot (−x) tilted back by `tilt` rad; or overhead (facing down) / pedestal (facing up)
function face(w, h, mat, pos, kind = 'front', tilt = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  const base = qY(-Math.PI / 2);
  const rot = kind === 'front' ? qZ(-tilt) : kind === 'down' ? qZ(Math.PI / 2 + tilt) : qZ(-Math.PI / 2 + tilt);
  m.quaternion.copy(rot.multiply(base));
  m.position.set(pos[0], pos[1], pos[2]);
  return m;
}
function canvasMat(canvas, self = false) {
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const mat = self ? new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
    : new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.05, emissiveMap: tex, emissive: new THREE.Color(0.32, 0.32, 0.32) });
  return { tex, mat };
}
const M = {
  shell: new THREE.MeshStandardMaterial({ color: 0x5d666e, roughness: 0.9 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2b3137, roughness: 0.8 }),
  black: new THREE.MeshStandardMaterial({ color: 0x0d0f11, roughness: 0.6 }),
  frame: new THREE.MeshStandardMaterial({ color: 0x15181b, roughness: 0.5 }),
  seat: new THREE.MeshStandardMaterial({ color: 0x2c3440, roughness: 0.95 }),
  sheep: new THREE.MeshStandardMaterial({ color: 0x8b8f93, roughness: 1 }),
  carpet: new THREE.MeshStandardMaterial({ color: 0x30353b, roughness: 1 }),
  metal: new THREE.MeshStandardMaterial({ color: 0xb8bfc6, roughness: 0.3, metalness: 0.8 }),
  lever: new THREE.MeshStandardMaterial({ color: 0x2f353a, roughness: 0.5, metalness: 0.4 }),
  white: new THREE.MeshStandardMaterial({ color: 0xe8ebee, roughness: 0.5 }),
  red: new THREE.MeshStandardMaterial({ color: 0xc02020, roughness: 0.5 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0xbfd8e8, transparent: true, opacity: 0.08, roughness: 0.05, metalness: 0, depthWrite: false }),
};
const box = (w, h, d, mat, p, parent) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(p[0], p[1], p[2]); parent.add(m); return m; };
const cyl = (r1, r2, h, mat, p, parent, seg = 16) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, seg), mat); m.position.set(p[0], p[1], p[2]); parent.add(m); return m; };

export function buildCockpit(sim, panels) {
  const g = new THREE.Group(); g.name = 'flightdeck';
  const faces = []; // { mesh, hit(u,v) }
  const D = sim.displays;
  // ---------------- shell ----------------
  box(1.9, 0.02, 2.2, M.carpet, [EYE_X - 0.4, 0.42, 0], g);                      // floor
  for (const s of [-1, 1]) {
    box(1.9, 0.85, 0.04, M.shell, [EYE_X - 0.5, 0.8, s * 1.18], g);              // side walls: below the side windows
    box(1.9, 0.2, 0.04, M.shell, [EYE_X - 0.5, 1.9, s * 1.18], g);                // above the side windows
    box(1.25, 0.6, 0.04, M.shell, [EYE_X - 0.83, 1.5, s * 1.18], g);              // aft of the sliding window
    box(1.2, 0.18, 0.32, M.dark, [EYE_X - 0.2, 0.86, s * 0.98], g);               // side consoles
    box(0.6, 0.1, 0.36, M.dark, [EYE_X + 0.4, 0.92, s * 0.98], g);                // fwd side console (tiller / OIS shelf)
  }
  box(0.06, 1.7, 2.4, M.shell, [EYE_X - 1.45, 1.2, 0], g);                        // aft bulkhead
  // ceiling sloping up toward the back
  { const c = box(1.8, 0.04, 2.36, M.shell, [EYE_X - 0.4, 2.02, 0], g); c.rotation.z = -0.08; }
  // main instrument panel body + kneebolster
  box(0.2, 0.52, 2.2, M.dark, [EYE_X + 0.9, 0.92, 0], g);
  box(0.35, 0.28, 2.2, M.black, [EYE_X + 0.95, 0.55, 0], g);
  // glareshield top
  { const gs = box(0.36, 0.05, 2.2, M.black, [EYE_X + 1.08, 1.3, 0], g); gs.rotation.z = -0.06; }
  // windshield: 4 front panes + side windows with black frames (A350 "mask")
  const wsX = EYE_X + 1.2;
  for (const [z0, z1] of [[-1.1, -0.55], [-0.55, 0], [0, 0.55], [0.55, 1.1]]) {
    const w = z1 - z0; const pane = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.62), M.glass); pane.position.set(wsX + 0.05, 1.6, (z0 + z1) / 2);
    pane.quaternion.copy(qZ(-0.62).multiply(qY(-Math.PI / 2))); const yaw = (z0 + z1) / 2 * 0.45; pane.quaternion.premultiply(qY(-yaw)); g.add(pane);
  }
  for (const z of [-1.1, -0.55, 0, 0.55, 1.1]) { const p = box(0.06, 0.66, 0.06, M.frame, [wsX + 0.05, 1.6, z], g); p.rotation.z = -0.62; }
  box(0.06, 0.06, 2.3, M.frame, [wsX + 0.24, 1.9, 0], g); box(0.06, 0.06, 2.3, M.frame, [wsX - 0.15, 1.32, 0], g);
  for (const s of [-1, 1]) { box(0.7, 0.05, 0.05, M.frame, [EYE_X + 0.5, 1.75, s * 1.15], g); box(0.7, 0.05, 0.05, M.frame, [EYE_X + 0.5, 1.25, s * 1.15], g); box(0.05, 0.5, 0.05, M.frame, [EYE_X + 0.15, 1.5, s * 1.15], g); }
  // ---------------- display units ----------------
  const panelX = EYE_X + 0.79, tilt = 0.2, duY = 0.96, duW = 0.245, duH = 0.3675;
  const duZ = { CO: -0.82, CI: -0.53, CU: 0, FI: 0.53, FO: 0.82 };
  for (const [id, z] of Object.entries(duZ)) {
    const du = D.du[id]; const { tex, mat } = canvasMat(du.canvas, true); du.tex = tex;
    box(0.03, duH + 0.03, duW + 0.03, M.black, [panelX + 0.02, duY, z], g).rotation.z = -tilt;
    const m = face(duW, duH, mat, [panelX + 0.002, duY, z], 'front', tilt); g.add(m);
    faces.push({ mesh: m, id, hit: (u, v) => D.hit(id, u, v) });
  }
  // ISIS (standby) left of centre and the gear/brake panel right of centre
  { const du = D.du.ISIS; const { tex, mat } = canvasMat(du.canvas, true); du.tex = tex; const m = face(0.1, 0.1, mat, [panelX + 0.002, 1.06, -0.25], 'front', tilt); g.add(m); faces.push({ mesh: m, id: 'ISIS', hit: (u, v) => D.hit('ISIS', u, v) }); }
  { const P = panels.gear; const { tex, mat } = canvasMat(P.canvas); P.tex = tex; const m = face(0.17, 0.17, mat, [panelX + 0.002, 0.88, 0.25], 'front', tilt); g.add(m); faces.push({ mesh: m, panel: P, hit: (u, v) => P.hit(u, v) }); }
  // ---------------- glareshield (EFIS CP + FCU) ----------------
  { const P = panels.glare; const { tex, mat } = canvasMat(P.canvas); P.tex = tex; const m = face(2.0, 0.25, mat, [EYE_X + 0.8, 1.2, 0], 'front', 0.75); g.add(m); faces.push({ mesh: m, panel: P, hit: (u, v) => P.hit(u, v) }); }
  // ---------------- overhead ----------------
  { const P = panels.ovhd; const { tex, mat } = canvasMat(P.canvas); P.tex = tex; const m = face(1.3, 0.81, mat, [EYE_X + 0.05, 1.98, 0], 'down', -0.42); g.add(m); faces.push({ mesh: m, panel: P, hit: (u, v) => P.hit(u, v) });
    const back = box(0.84, 0.06, 1.34, M.dark, [EYE_X + 0.05, 2.03, 0], g); back.rotation.z = -0.42; }
  // ---------------- pedestal ----------------
  const pedTop = 0.71;
  box(1.0, pedTop - 0.42, 0.56, M.dark, [EYE_X - 0.05, (pedTop + 0.42) / 2 - 0.01, 0], g);
  { const P = panels.ped; const { tex, mat } = canvasMat(P.canvas); P.tex = tex; const m = face(0.5, 0.75, mat, [EYE_X - 0.1, pedTop + 0.002, 0], 'up', 0); g.add(m); faces.push({ mesh: m, panel: P, hit: (u, v) => P.hit(u, v) }); }
  // sloped pedestal front with the lower-centre DU (MFDs)
  { const du = D.du.CL; const { tex, mat } = canvasMat(du.canvas, true); du.tex = tex;
    const slope = box(0.36, 0.06, 0.56, M.dark, [EYE_X + 0.43, 0.76, 0], g); slope.rotation.z = 0.62;
    const m = face(0.48, 0.32, mat, [EYE_X + 0.42, 0.8, 0], 'up', 0.62 - Math.PI / 2 + Math.PI / 2); m.quaternion.copy(qZ(-Math.PI / 2 + 0.95).multiply(qY(-Math.PI / 2))); m.position.set(EYE_X + 0.44, 0.795, 0); g.add(m);
    faces.push({ mesh: m, id: 'CL', hit: (u, v) => D.hit('CL', u, v) }); }
  // ---------------- levers ----------------
  const hot3d = [];
  const addHot = (obj, hot) => { obj.userData.hot = hot; hot3d.push(obj); return obj; };
  // thrust levers (pivot at pedestal front)
  const thr = [];
  for (let i = 0; i < 2; i++) {
    const piv = new THREE.Group(); piv.position.set(EYE_X + 0.22, pedTop + 0.01, i ? 0.045 : -0.045); g.add(piv);
    const arm = box(0.02, 0.2, 0.03, M.lever, [0, 0.1, 0], piv); const knob = box(0.05, 0.035, 0.07, M.black, [0, 0.2, 0], piv);
    box(0.012, 0.03, 0.03, M.red, [0.02, 0.2, i ? 0.03 : -0.03], piv); // A/THR instinctive disconnect pb
    const rev = box(0.03, 0.012, 0.05, M.metal, [-0.02, 0.17, 0], piv); // reverser latch
    for (const o of [arm, knob, rev]) addHot(o, { tip: () => `Thrust lever ${i + 1}: ${sim.tlaName(i)} — click: next detent, right-click: previous, wheel: fine, Shift+click: A/THR disconnect`, click: (b) => sim.leverStep(b === 2 ? -1 : 1, sim.keys?.ShiftLeft ? i : null), wheel: (d) => sim.leverFine(d > 0 ? -0.02 : 0.02) });
    thr.push(piv);
  }
  // detent gate marks
  { const gate = box(0.24, 0.004, 0.14, M.black, [EYE_X + 0.22, pedTop + 0.004, 0], g); void gate; }
  // speed brake lever (left) and flap lever (right)
  const sbPiv = new THREE.Group(); sbPiv.position.set(EYE_X + 0.15, pedTop + 0.01, -0.2); g.add(sbPiv);
  box(0.015, 0.11, 0.015, M.lever, [0, 0.055, 0], sbPiv); const sbK = box(0.04, 0.025, 0.06, M.white, [0, 0.115, 0], sbPiv);
  addHot(sbK, { tip: () => `SPEED BRAKE ${sim.fdm.ctrl.spdArm ? 'ARMED' : Math.round(sim.fdm.ctrl.spdbrk * 100) + '%'} — click: ARM/RET, wheel: extend, right-click: full/RET`, click: (b) => sim.speedbrakeClick(b), wheel: (d) => sim.speedbrakeWheel(d) });
  const flPiv = new THREE.Group(); flPiv.position.set(EYE_X + 0.15, pedTop + 0.01, 0.2); g.add(flPiv);
  box(0.015, 0.11, 0.015, M.lever, [0, 0.055, 0], flPiv); const flK = box(0.05, 0.03, 0.08, M.white, [0, 0.115, 0], flPiv);
  addHot(flK, { tip: () => 'FLAPS lever ' + ['0', '1', '2', '3', 'FULL'][sim.flapLever] + ' — click: down, right-click: up, wheel', click: (b) => sim.flapStep(b === 2 ? -1 : 1), wheel: (d) => sim.flapStep(d > 0 ? -1 : 1) });
  // landing gear lever beside the gear panel
  const gearPiv = new THREE.Group(); gearPiv.position.set(panelX - 0.02, 0.96, 0.37); g.add(gearPiv);
  box(0.012, 0.012, 0.09, M.metal, [-0.045, 0, 0], gearPiv).rotation.y = Math.PI / 2;
  const gearK = cyl(0.022, 0.022, 0.035, M.white, [-0.09, 0, 0], gearPiv, 20); gearK.rotation.z = Math.PI / 2;
  addHot(gearK, { tip: () => 'LANDING GEAR lever ' + (sim.fdm.gear.lever ? 'DOWN' : 'UP') + ' (click)', click: () => sim.gearToggle() });
  // sidesticks on the side consoles with takeover pb, and tillers
  const sticks = [];
  for (const s of [-1, 1]) {
    const piv = new THREE.Group(); piv.position.set(EYE_X + 0.05, 0.96, s * 0.93); g.add(piv);
    cyl(0.03, 0.045, 0.02, M.black, [0, 0, 0], piv); cyl(0.016, 0.02, 0.11, M.black, [0, 0.06, 0], piv); const grip = cyl(0.022, 0.018, 0.09, M.black, [0.005, 0.15, 0], piv);
    const tk = cyl(0.008, 0.008, 0.01, M.red, [0.012, 0.2, s * -0.008], piv);
    addHot(grip, { tip: 'Sidestick (arrow keys / mouse yoke Y / gamepad)' });
    addHot(tk, { tip: 'Sidestick takeover pb — AP disconnect (click), also key Q', click: () => sim.afs.instinctiveDisc() });
    sticks.push(piv);
    const till = new THREE.Group(); till.position.set(EYE_X + 0.42, 0.98, s * 0.95); g.add(till);
    cyl(0.05, 0.05, 0.012, M.black, [0, 0, 0], till, 24); box(0.07, 0.015, 0.015, M.black, [0.03, 0.01, 0], till);
    addHot(till.children[0], { tip: 'Steering tiller (Z / X keys while taxiing below 20 kt)' });
    sticks.push(till);
    // rudder pedals
    for (const k of [-1, 1]) { const ped = box(0.03, 0.18, 0.08, M.dark, [EYE_X + 0.68, 0.55, s * 0.55 + k * 0.1], g); ped.rotation.z = -0.5; sticks.push(ped); }
    // seats with sheepskin
    const seat = new THREE.Group(); seat.position.set(EYE_X - 0.25, 0.42, s * 0.55); g.add(seat);
    box(0.5, 0.1, 0.5, M.sheep, [0, 0.42, 0], seat); const back = box(0.1, 0.75, 0.5, M.sheep, [-0.25, 0.82, 0], seat); back.rotation.z = 0.12;
    box(0.3, 0.32, 0.3, M.seat, [0, 0.2, 0], seat); box(0.06, 0.18, 0.28, M.seat, [-0.29, 1.28, 0], seat);
    // armrest (outboard)
    box(0.35, 0.04, 0.06, M.seat, [0.02, 0.62, s * 0.26], seat);
  }
  // window sun visors and cup holders for character
  for (const s of [-1, 1]) { box(0.25, 0.004, 0.35, M.dark, [EYE_X + 0.75, 1.88, s * 0.6], g); cyl(0.035, 0.03, 0.08, M.black, [EYE_X + 0.3, 0.98, s * 1.08], g); }
  // ---------------- cockpit lights ----------------
  const dome = new THREE.PointLight(0xfff4e0, 0, 4, 1.6); dome.position.set(EYE_X - 0.1, 1.95, 0); g.add(dome);
  const flood = new THREE.PointLight(0xffe7c4, 0, 2.2, 2); flood.position.set(EYE_X + 0.5, 1.25, 0); g.add(flood);
  const storm = new THREE.PointLight(0xffffff, 0, 4, 1.4); storm.position.set(EYE_X + 0.2, 1.9, 0); g.add(storm);

  // ---------------- animation ----------------
  // fix stick array layout: [stickCapt, tillerCapt, pedal, pedal, stickFO, tillerFO, pedal, pedal]
  { const s = sticks.slice(); sticks.length = 0; sticks.push(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]); }
  const animate2 = () => {
    const f = sim.fdm, c = f.ctrl, S = sim.S;
    for (let i = 0; i < 2; i++) { const tla = c.tla[i]; thr[i].rotation.z = -(tla >= 0 ? -0.55 + tla * 1.05 : -0.55 + tla * 0.35); }
    sbPiv.rotation.z = c.spdArm ? -0.05 : 0.45 * c.spdbrk; sbPiv.position.y = pedTop + 0.01 + (c.spdArm ? 0.015 : 0);
    flPiv.rotation.z = 0.35 - sim.flapLever * 0.17;
    gearPiv.rotation.z = f.gear.lever ? -0.35 : 0.35;
    const ap = sim.afs.apOn; const sx = ap ? 0 : c.stickX, sy = ap ? 0 : c.stickY;
    for (const k of [0, 4]) sticks[k].rotation.set(sx * 0.3, 0, -sy * 0.3);
    for (const k of [1, 5]) sticks[k].rotation.y = -c.tiller * 1.3;
    for (const [k, sgn] of [[2, -1], [3, 1], [6, -1], [7, 1]]) sticks[k].position.x = EYE_X + 0.68 + sgn * c.pedals * 0.04;
    const pw = S.dcPowered;
    dome.intensity = pw ? S.lights.dome * 3 : 0; flood.intensity = pw ? S.lights.flood * 1.2 : 0; storm.intensity = pw && S.lights.storm ? 3 : 0;
  };
  void clamp; void DETENT;
  return { group: g, faces, hot3d, animate: animate2, eye: [EYE_X, EYE_Y, -0.55], eyeFO: [EYE_X, EYE_Y, 0.55] };
}
