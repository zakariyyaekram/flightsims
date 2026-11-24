// A350-1000 cockpit control panels drawn on canvases (overhead, glareshield FCU + EFIS CPs, pedestal, main-panel
// landing gear / brake section). Every control is a clickable hotspot that drives Systems / AFS / FDM state.
import { clamp } from '../math.js';
import { OV } from './systems.js';
import { CONFS } from './data.js';

const PANEL_GREY = '#56616b', PANEL_DARK = '#3b444c', LBL = '#f2f4f6';
const AMB = '#ffb000', BLUE = '#33c8ff', GRN = '#3dff6e', WHT = '#ffffff', RED = '#ff2d2d';

export class CanvasPanel {
  constructor(name, w, h) {
    this.name = name; this.w = w; this.h = h;
    this.canvas = document.createElement('canvas'); this.canvas.width = w; this.canvas.height = h;
    this.g = this.canvas.getContext('2d'); this.hot = []; this.tex = null; this.ids = new Map(); this.hl = null;
  }
  reg(x, y, w, h, o) { this.hot.push({ x, y, w, h, ...o }); if (o.id) this.ids.set(o.id, [x + w / 2, y + h / 2, Math.max(w, h) / 2]); }
  hit(u, v) { const x = u * this.w, y = (1 - v) * this.h; for (let i = this.hot.length - 1; i >= 0; i--) { const r = this.hot[i]; if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r; } return null; }
  locate(id) { const p = this.ids.get(id); return p ? { u: p[0] / this.w, v: 1 - p[1] / this.h, r: p[2] } : null; }
}

// ---------- drawing helpers ----------
function T(g, s, x, y, col = LBL, px = 13, al = 'center', bold = true) { g.font = `${bold ? '700 ' : ''}${px}px "B612", "Arial Narrow", Arial, sans-serif`; g.fillStyle = col; g.textAlign = al; g.textBaseline = 'middle'; g.fillText(s, x, y); }
function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function screw(g, x, y) { g.fillStyle = '#2a3036'; g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#7a858f'; g.lineWidth = 1; g.beginPath(); g.moveTo(x - 3, y); g.lineTo(x + 3, y); g.stroke(); }
function section(g, x, y, w, h, title) {
  g.fillStyle = PANEL_GREY; rr(g, x, y, w, h, 6); g.fill(); g.strokeStyle = '#2b3238'; g.lineWidth = 2; g.stroke();
  if (title) { T(g, title, x + w / 2, y + 12, LBL, 12); g.strokeStyle = LBL; g.lineWidth = 1.2; const tw = title.length * 4.6 + 8; g.beginPath(); g.moveTo(x + 10, y + 12); g.lineTo(x + w / 2 - tw, y + 12); g.moveTo(x + w / 2 + tw, y + 12); g.lineTo(x + w - 10, y + 12); g.stroke(); }
  screw(g, x + 7, y + h - 7); screw(g, x + w - 7, y + h - 7);
}
// Airbus square push-button with up to two legends (top = fault/annunciation, bottom = state)
function pbBox(g, x, y, w, h, top, bot, pressedIn) {
  g.fillStyle = '#15191d'; rr(g, x - 3, y - 3, w + 6, h + 6, 4); g.fill();
  const grd = g.createLinearGradient(x, y, x, y + h); grd.addColorStop(0, pressedIn ? '#1b2026' : '#2c333a'); grd.addColorStop(1, pressedIn ? '#22282e' : '#1a1f24');
  g.fillStyle = grd; rr(g, x, y, w, h, 3); g.fill();
  g.strokeStyle = '#0c0f12'; g.lineWidth = 1; g.beginPath(); g.moveTo(x + 4, y + h / 2); g.lineTo(x + w - 4, y + h / 2); g.stroke();
  const leg = (L, yy) => { if (!L) return; const [s, c, lit] = L; if (lit) { g.shadowColor = c; g.shadowBlur = 8; } T(g, s, x + w / 2, yy, lit ? c : '#3a4148', s.length > 6 ? 10 : 12); g.shadowBlur = 0; if (lit && (s === 'ON' || s === 'OFF' || s === 'ALTN' || s === 'MAN') && false) {} };
  leg(top, y + h * 0.27); leg(bot, y + h * 0.74);
}
function guardCover(g, x, y, w, h, open, red = true) {
  if (open) { g.fillStyle = red ? 'rgba(200,30,30,.55)' : 'rgba(120,130,140,.55)'; g.fillRect(x - 5, y - 22, w + 10, 16); g.strokeStyle = '#111'; g.strokeRect(x - 5, y - 22, w + 10, 16); return; }
  g.fillStyle = red ? 'rgba(210,30,30,.42)' : 'rgba(150,160,170,.38)'; rr(g, x - 5, y - 5, w + 10, h + 10, 5); g.fill();
  g.strokeStyle = red ? '#ff6a6a' : '#cfd6dc'; g.lineWidth = 1.5; g.stroke();
  if (red) { g.save(); rr(g, x - 5, y - 5, w + 10, h + 10, 5); g.clip(); g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 4; for (let k = -h; k < w + h; k += 12) { g.beginPath(); g.moveTo(x + k, y - 6); g.lineTo(x + k - h - 10, y + h + 6); g.stroke(); } g.restore(); }
}
function knobDraw(g, x, y, r, ang, col = '#2b3137') {
  g.fillStyle = '#0d1013'; g.beginPath(); g.arc(x, y + 2, r + 2, 0, Math.PI * 2); g.fill();
  const grd = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r); grd.addColorStop(0, '#5b646d'); grd.addColorStop(1, col);
  g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = WHT; g.lineWidth = 3; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.sin(ang) * r * 0.9, y - Math.cos(ang) * r * 0.9); g.stroke();
}
function toggleDraw(g, x, y, up) { // lever toggle switch (bat-handle)
  g.fillStyle = '#1b1f23'; g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#d9dde1'; g.beginPath(); g.ellipse(x, y + up * 14, 7, 9, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#9aa2aa'; g.lineWidth = 5; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + up * 12); g.stroke();
}

// ================= generic overhead control renderer =================
// legend rules for an overhead pb id → [topLegend, bottomLegend]
function pbLegends(S, id, test) {
  const ov = S.ov, f = S.fdm, on = !!ov[id]; const lit = (c) => c || test;
  const normOn = OV[id]?.d === true;
  let bot = normOn ? ['OFF', WHT, lit(!on)] : ['ON', BLUE, lit(on)], top = ['FAULT', AMB, lit(false)];
  const E = f.E;
  switch (id) {
    case 'BAT1': case 'BAT2': case 'BATEMER1': case 'BATEMER2': { const i = ['BAT1', 'BATEMER1', 'BATEMER2', 'BAT2'].indexOf(id); top = ['FAULT', AMB, lit(on && S.bat[i] < 0.2)]; break; }
    case 'EXT1': case 'EXT2': { const avail = S.elec?.extAvail; top = ['AVAIL', GRN, lit(avail && !on)]; bot = ['ON', BLUE, lit(on)]; break; }
    case 'APUGEN': top = ['FAULT', AMB, lit(on && S.apu.running && !S.apu.avail && S.apu.n > 95)]; break;
    case 'GEN1A': case 'GEN1B': case 'GEN2A': case 'GEN2B': { const e = E[id[3] === '1' ? 0 : 1]; top = ['FAULT', AMB, lit(on && !e.running && S.dcPowered)]; break; }
    case 'DRIVE1': case 'DRIVE2': top = ['FAULT', AMB, lit(false)]; bot = ['DISC', WHT, lit(on)]; break;
    case 'APUMASTER': top = ['FAULT', AMB, lit(S.fire.apu)]; break;
    case 'APUSTART': top = ['', GRN, false]; bot = S.apu.avail ? ['AVAIL', GRN, true] : ['ON', BLUE, lit(on || S.apu.starting)]; break;
    case 'APUBLEED': top = ['FAULT', AMB, lit(false)]; break;
    case 'GENG1': case 'GENG2': case 'YENG1': case 'YENG2': { const e = E[id[4] === '1' ? 0 : 1]; top = ['FAULT', AMB, lit(on && e.n3 < 50 && S.dcPowered)]; break; }
    case 'GELEC': case 'YELEC': top = ['FAULT', AMB, lit(false)]; break;
    case 'FPL1': case 'FPL2': case 'FPR1': case 'FPR2': case 'FPC1': case 'FPC2': { const t = id[2] === 'L' ? f.fuel.L : id[2] === 'R' ? f.fuel.R : f.fuel.C; top = ['FAULT', AMB, lit(on && !S.acPowered && S.dcPowered) || (id[2] === 'C' && on && t < 1 && false)]; break; }
    case 'XFEED1': case 'XFEED2': top = ['OPEN', GRN, lit(on)]; bot = ['ON', BLUE, lit(on)]; break;
    case 'JETTACTIVE': top = ['', AMB, false]; bot = ['ACTIVE', BLUE, lit(on)]; break;
    case 'PRIM1': case 'PRIM2': case 'PRIM3': case 'SEC1': case 'SEC2': case 'SEC3': top = ['FAULT', AMB, lit(on && !S.essPowered)]; break;
    case 'ADR1': case 'ADR2': case 'ADR3': top = ['FAULT', AMB, lit(false)]; break;
    case 'PACK1': case 'PACK2': { const i = id === 'PACK1' ? 0 : 1; top = ['FAULT', AMB, lit(on && !S.packs?.[i] && (S.bleed?.ductL || S.bleed?.ductR))]; break; }
    case 'ENGBLEED1': case 'ENGBLEED2': { const i = id === 'ENGBLEED1' ? 0 : 1; top = ['FAULT', AMB, lit(on && E[i].running && !S.bleed?.[`b${i + 1}`])]; break; }
    case 'HOTAIR1': case 'HOTAIR2': case 'CARGOAIR': break;
    case 'WINGAI': case 'ENGAI1': case 'ENGAI2': top = ['FAULT', AMB, lit(false)]; break;
    case 'PROBEHEAT': top = ['', AMB, false]; bot = ['ON', BLUE, lit(on)]; break;
    case 'PRESSMODE': top = ['FAULT', AMB, lit(false)]; bot = ['MAN', WHT, lit(on)]; break;
    case 'CREWO2': top = ['', AMB, false]; break;
    case 'RCDR': top = ['', AMB, false]; bot = ['OFF', WHT, lit(!on)]; break;
    case 'MANSTART1': case 'MANSTART2': top = ['', AMB, false]; bot = ['ON', BLUE, lit(on)]; break;
    case 'AVNCSVENT': top = ['FAULT', AMB, lit(false)]; bot = ['OVRD', WHT, lit(on)]; break;
    case 'GALLEY': case 'COMMERCIAL': top = ['FAULT', AMB, lit(false)]; break;
    case 'BUSTIE': top = ['', AMB, false]; break;
    case 'TKXFR': top = ['', AMB, false]; bot = ['ON', BLUE, lit(on)]; break;
    case 'RAMAIR': top = ['', AMB, false]; bot = ['ON', BLUE, lit(on)]; break;
    case 'DITCHING': top = ['', AMB, false]; bot = ['ON', BLUE, lit(on)]; break;
    case 'EVACCMD': top = ['EVAC', RED, lit(on)]; bot = ['ON', WHT, lit(on)]; break;
    case 'JETTARM': top = ['', AMB, false]; bot = ['ARM', BLUE, lit(on)]; break;
    case 'ENGFIRE1': case 'ENGFIRE2': case 'APUFIRE': break;
  }
  return [top, bot];
}

const MOM_LEG = {
  RATMAN: [null, ['RAT MAN ON', WHT]], EMERGENTEST: [null, ['TEST', WHT]], FIRETEST1: [null, ['TEST', WHT]], FIRETEST2: [null, ['TEST', WHT]], APUFIRETEST: [null, ['TEST', WHT]],
  RAINC: [null, ['RAIN RPLNT', WHT]], RAINF: [null, ['RAIN RPLNT', WHT]], MASKMAN: [null, ['MAN ON', WHT]], PAXO2: [null, ['PAX OXY', WHT]],
  CALLMECH: [null, ['MECH', WHT]], CALLALL: [null, ['ALL', WHT]], CALLEMER: [['CALL', AMB], ['EMER', WHT]], EVACHORN: [null, ['HORN OFF', WHT]],
  CVRTEST: [null, ['CVR TEST', WHT]], CVRERASE: [null, ['ERASE', WHT]], CARGOSMOKE: [['SMOKE', RED], ['DISCH', WHT]],
};

function drawCtl(P, S, sim, c, test) {
  const g = P.g, [kind, id, label] = c; const x = c.x, y = c.y; const ov = S.ov;
  const W = 62, H = 44;
  if (label) T(g, label, x + W / 2, y - 12, LBL, label.length > 10 ? 10 : 11);
  if (kind === 'pb' || kind === 'guard') {
    const [top, bot] = pbLegends(S, id, test);
    pbBox(g, x, y, W, H, top, bot, !!ov[id]);
    if (kind === 'guard') guardCover(g, x, y, W, H, !!S.guardOpen[id], id !== 'JETTARM');
    P.reg(x - 6, y - 6, W + 12, H + 12, { id, tip: () => `${label || id}: ${kind === 'guard' && !S.guardOpen[id] ? 'guarded (click to lift guard)' : ov[id] ? 'ON/IN' : 'OFF/OUT'}`, click: (b) => {
      if (kind === 'guard' && !S.guardOpen[id]) { S.guardOpen[id] = true; return; }
      if (kind === 'guard' && b === 2) { S.guardOpen[id] = false; return; }
      S.press(id);
    } });
  } else if (kind === 'pbm' || kind === 'guardm') {
    const L = MOM_LEG[id] || [null, [label || id, WHT]]; const lit = !!S.mom[id] || test;
    pbBox(g, x, y, W, H, L[0] ? [L[0][0], L[0][1], lit && id === 'CARGOSMOKE' ? false : test] : null, [L[1][0], L[1][1], lit || (id === 'RATMAN' && S.ratOut)], !!S.mom[id]);
    if (kind === 'guardm') guardCover(g, x, y, W, H, !!S.guardOpen[id], true);
    P.reg(x - 6, y - 6, W + 12, H + 12, { id, tip: label || id, click: (b) => { if (kind === 'guardm' && !S.guardOpen[id]) { S.guardOpen[id] = true; return; } if (kind === 'guardm' && b === 2) { S.guardOpen[id] = false; return; } S.press(id); } });
  } else if (kind === 'sel' || kind === 'tog') {
    const def = OV[id], n = def.pos.length, v = ov[id];
    const cx = x + W / 2, cy = y + 24;
    if (kind === 'sel') {
      const spread = n === 2 ? 1.2 : n === 3 ? 1.4 : 1.8;
      def.pos.forEach((p, i) => { const a = -spread / 2 * 1 + spread * i / (n - 1); T(g, p, cx + Math.sin(a) * 30, cy - Math.cos(a) * 30 + 2, LBL, p.length > 4 ? 8 : 9); });
      const a = -spread / 2 + spread * v / (n - 1);
      g.fillStyle = '#111'; g.beginPath(); g.arc(cx, cy, 15, 0, Math.PI * 2); g.fill();
      g.save(); g.translate(cx, cy); g.rotate(a); g.fillStyle = '#e8ecef'; rr(g, -5, -17, 10, 30, 4); g.fill(); g.fillStyle = '#222'; g.fillRect(-1.5, -15, 3, 10); g.restore();
    } else {
      def.pos.forEach((p, i) => T(g, p, cx + 26, cy + (i === 0 ? 14 : -14) * (n === 2 ? 1 : 1), LBL, 9, 'left'));
      toggleDraw(g, cx, cy, v ? -1 : 1);
    }
    P.reg(x - 4, y - 4, W + 8, H + 14, { id, tip: () => `${label || id}: ${def.pos[ov[id]]} (click +, right-click −, wheel)`, click: (b) => S.step(id, b === 2 ? -1 : 1), wheel: (d) => S.step(id, d > 0 ? -1 : 1) });
  } else if (kind === 'knob') {
    const v = ov[id]; const cx = x + W / 2, cy = y + 24;
    for (let k = 0; k <= 10; k++) { const a = -2.3 + 4.6 * k / 10; g.strokeStyle = LBL; g.lineWidth = 1.2; g.beginPath(); g.moveTo(cx + Math.sin(a) * 22, cy - Math.cos(a) * 22); g.lineTo(cx + Math.sin(a) * 26, cy - Math.cos(a) * 26); g.stroke(); }
    if (id === 'CKPTTEMP' || id === 'CABTEMP') { T(g, 'C', cx - 26, cy + 20, BLUE, 9); T(g, 'H', cx + 26, cy + 20, '#ff7a7a', 9); }
    knobDraw(g, cx, cy, 16, -2.3 + 4.6 * v);
    P.reg(x - 4, y - 4, W + 8, H + 14, { id, tip: () => `${label}: ${Math.round(v * 100)}% (wheel / click ±)`, click: (b) => S.step(id, b === 2 ? -1 : 1), wheel: (d) => S.step(id, d > 0 ? -1 : 1) });
  } else if (kind === 'fire') {
    // ENG/APU fire push-button (guarded, lights red FIRE)
    const fire = id === 'APUFIRE' ? S.fire.apu : S.fire['e' + id.slice(-1)];
    const pushed = !!ov[id];
    const FW = 92, FH = 50;
    g.fillStyle = '#15191d'; rr(g, x - 4, y - 4, FW + 8, FH + 8, 5); g.fill();
    g.fillStyle = fire || test ? '#d41010' : '#3a0d0d'; if (fire || test) { g.shadowColor = '#ff2020'; g.shadowBlur = 16; } rr(g, x, y, FW, FH, 4); g.fill(); g.shadowBlur = 0;
    T(g, id === 'APUFIRE' ? 'APU' : 'ENG ' + id.slice(-1), x + FW / 2, y + 14, fire || test ? WHT : '#6b3a3a', 12); T(g, 'FIRE', x + FW / 2, y + 32, fire || test ? WHT : '#6b3a3a', 16);
    if (pushed) T(g, 'PUSHED', x + FW / 2, y + FH + 12, AMB, 10);
    guardCover(g, x, y, FW, FH, !!S.guardOpen[id], false);
    P.reg(x - 6, y - 6, FW + 12, FH + 12, { id, tip: () => `${label} fire pb — ${S.guardOpen[id] ? 'push to arm extinguishers / shut off' : 'click to lift guard'}`, click: (b) => { if (!S.guardOpen[id]) { S.guardOpen[id] = true; return; } if (b === 2) { S.guardOpen[id] = false; return; } S.press(id); } });
  } else if (kind === 'agent') {
    const [eng, k] = c.agent; // 'e1' 0
    const armed = eng === 'apu' ? S.apuFirePushed : S.firePushed[eng === 'e1' ? 0 : 1];
    const left = eng === 'apu' ? S.agent.apu : S.agent[eng][k];
    pbBox(g, x, y, W, H, ['SQUIB', WHT, (armed && left > 0) || test], ['DISCH', AMB, left === 0 || test], false);
    P.reg(x - 6, y - 6, W + 12, H + 12, { id, tip: `${label}: discharge fire extinguisher bottle`, click: () => S.press(id) });
  } else if (kind === 'lamp') {
    const st = c.fn(S, sim); pbBox(g, x, y, W, H, st[0], st[1], false);
    P.reg(x - 6, y - 6, W + 12, H + 12, { id, tip: label, click: c.click ? (b) => c.click(b, S, sim) : undefined });
  }
}

// ================= OVERHEAD =================
const OVH = [
  // [title, x, y, w, h, controls: [kind, id, label, col, row]]
  ['ADIRS', 20, 30, 320, 250, [['sel', 'IR1', 'IR 1', 0, 0], ['sel', 'IR2', 'IR 2', 1, 0], ['sel', 'IR3', 'IR 3', 2, 0], ['pb', 'ADR1', 'ADR 1', 0, 1], ['pb', 'ADR2', 'ADR 2', 1, 1], ['pb', 'ADR3', 'ADR 3', 2, 1],
    ['lamp', 'ONBAT', 'ON BAT', 3, 0]]],
  ['F/CTL', 20, 300, 320, 190, [['pb', 'PRIM1', 'PRIM 1', 0, 0], ['pb', 'PRIM2', 'PRIM 2', 1, 0], ['pb', 'PRIM3', 'PRIM 3', 2, 0], ['pb', 'SEC1', 'SEC 1', 0, 1], ['pb', 'SEC2', 'SEC 2', 1, 1], ['pb', 'SEC3', 'SEC 3', 2, 1]]],
  ['EVAC', 20, 510, 320, 110, [['guard', 'EVACCMD', 'COMMAND', 0, 0], ['pbm', 'EVACHORN', 'HORN SHUT OFF', 1, 0], ['tog', 'EVACSEL', 'CAPT & PURS', 2, 0]]],
  ['EMER ELEC PWR', 20, 640, 320, 110, [['guardm', 'RATMAN', 'RAT', 0, 0], ['pbm', 'EMERGENTEST', 'GEN TEST', 1, 0]]],
  ['RCDR', 20, 770, 320, 110, [['pb', 'RCDR', 'GND CTL', 0, 0], ['pbm', 'CVRTEST', 'CVR TEST', 1, 0], ['pbm', 'CVRERASE', 'CVR ERASE', 2, 0]]],
  ['OXYGEN', 20, 900, 320, 110, [['guardm', 'MASKMAN', 'MASK MAN ON', 0, 0], ['guardm', 'PAXO2', 'PAX SYS ON', 1, 0], ['pb', 'CREWO2', 'CREW SUPPLY', 2, 0]]],
  // centre column
  ['FIRE', 360, 30, 780, 170, [['fire', 'ENGFIRE1', 'ENG 1', 0, 0], ['agent', 'AGENT1_1', 'AGENT 1', 1.5, 0, ['e1', 0]], ['agent', 'AGENT1_2', 'AGENT 2', 2.5, 0, ['e1', 1]], ['pbm', 'FIRETEST1', 'TEST', 3.5, 0],
    ['fire', 'APUFIRE', 'APU', 4.6, 0], ['agent', 'APUAGENT', 'AGENT', 6, 0, ['apu', 0]], ['pbm', 'APUFIRETEST', 'TEST', 7, 0],
    ['fire', 'ENGFIRE2', 'ENG 2', 8.2, 0], ['agent', 'AGENT2_1', 'AGENT 1', 9.6, 0, ['e2', 0]], ['agent', 'AGENT2_2', 'AGENT 2', 10.6, 0, ['e2', 1]], ['pbm', 'FIRETEST2', 'TEST', 0, 1, null, 60]]],
  ['ELEC', 360, 220, 780, 260, [['pb', 'BAT1', 'BAT 1', 0, 0], ['pb', 'BATEMER1', 'BAT EMER 1', 1, 0], ['pb', 'BATEMER2', 'BAT EMER 2', 2, 0], ['pb', 'BAT2', 'BAT 2', 3, 0], ['lamp', 'BATV', 'BAT V', 4.4, 0],
    ['pb', 'EXT1', 'EXT 1', 6, 0], ['pb', 'EXT2', 'EXT 2', 7, 0], ['pb', 'APUGEN', 'APU GEN', 8.5, 0], ['pb', 'BUSTIE', 'AC BUS TIE', 9.8, 0],
    ['pb', 'GEN1A', 'GEN 1A', 0, 1], ['pb', 'GEN1B', 'GEN 1B', 1, 1], ['guard', 'DRIVE1', 'DRIVE 1', 2, 1], ['pb', 'GALLEY', 'GALLEY', 3.5, 1], ['pb', 'COMMERCIAL', 'COMMERCIAL', 4.5, 1],
    ['guard', 'DRIVE2', 'DRIVE 2', 7, 1], ['pb', 'GEN2B', 'GEN 2B', 8.5, 1], ['pb', 'GEN2A', 'GEN 2A', 9.8, 1]]],
  ['HYD', 360, 500, 380, 200, [['pb', 'GENG1', 'G ENG 1', 0, 0], ['pb', 'GENG2', 'G ENG 2', 1, 0], ['pb', 'YENG1', 'Y ENG 1', 3, 0], ['pb', 'YENG2', 'Y ENG 2', 4, 0],
    ['pb', 'GELEC', 'G ELEC PMP', 0.5, 1], ['pb', 'YELEC', 'Y ELEC PMP', 3.5, 1]]],
  ['APU', 760, 500, 380, 200, [['pb', 'APUMASTER', 'MASTER SW', 0.5, 0], ['pb', 'APUSTART', 'START', 2, 0], ['pb', 'APUBLEED', 'APU BLEED', 3.5, 0], ['lamp', 'APUSTAT', 'N / EGT', 2, 1]]],
  ['FUEL', 360, 720, 780, 200, [['pb', 'FPL1', 'L 1', 0, 0], ['pb', 'FPL2', 'L 2', 1, 0], ['pb', 'XFEED1', 'X FEED', 2.3, 0], ['pb', 'FPC1', 'CTR L', 3.6, 0], ['pb', 'FPC2', 'CTR R', 4.6, 0], ['pb', 'XFEED2', 'X FEED', 5.9, 0],
    ['pb', 'FPR1', 'R 1', 7.2, 0], ['pb', 'FPR2', 'R 2', 8.2, 0], ['pb', 'TKXFR', 'TK XFR', 9.6, 0],
    ['guard', 'JETTARM', 'JETTISON ARM', 3.6, 1], ['pb', 'JETTACTIVE', 'ACTIVE', 4.6, 1], ['lamp', 'FOB', 'FOB', 7.2, 1]]],
  ['ENG MAN START', 360, 940, 380, 110, [['pb', 'MANSTART1', 'ENG 1', 0.5, 0], ['pb', 'MANSTART2', 'ENG 2', 3.5, 0]]],
  ['CALLS', 760, 940, 380, 110, [['pbm', 'CALLMECH', 'MECH', 0, 0], ['pbm', 'CALLALL', 'ALL', 1.2, 0], ['pbm', 'CALLEMER', 'EMER', 2.4, 0], ['pb', 'AVNCSVENT', 'AVNCS VENT', 3.8, 0]]],
  // right column
  ['AIR', 1160, 30, 560, 290, [['pb', 'PACK1', 'PACK 1', 0, 0], ['sel', 'PACKFLOW', 'PACK FLOW', 1.6, 0], ['pb', 'PACK2', 'PACK 2', 3.2, 0], ['pb', 'CARGOAIR', 'CARGO AIR', 5, 0],
    ['knob', 'CKPTTEMP', 'CKPT', 0, 1], ['knob', 'CABTEMP', 'CABIN', 1.3, 1], ['pb', 'HOTAIR1', 'HOT AIR 1', 2.7, 1], ['pb', 'HOTAIR2', 'HOT AIR 2', 3.9, 1], ['guard', 'RAMAIR', 'RAM AIR', 5.2, 1],
    ['pb', 'ENGBLEED1', 'ENG 1 BLEED', 0, 2], ['sel', 'XBLEED', 'X BLEED', 1.6, 2], ['pb', 'ENGBLEED2', 'ENG 2 BLEED', 3.2, 2]]],
  ['ANTI ICE', 1160, 340, 270, 110, [['pb', 'WINGAI', 'WING', 0, 0], ['pb', 'ENGAI1', 'ENG 1', 1.05, 0], ['pb', 'ENGAI2', 'ENG 2', 2.1, 0]]],
  ['CAB PRESS', 1450, 340, 270, 110, [['pb', 'PRESSMODE', 'MODE SEL', 0, 0], ['knob', 'CABALT', 'MAN ALT', 1.05, 0], ['guard', 'DITCHING', 'DITCHING', 2.1, 0]]],
  ['PROBE / WINDOW HEAT', 1160, 470, 270, 110, [['pb', 'PROBEHEAT', 'PROBE & WINDOW', 1, 0]]],
  ['WIPER', 1450, 470, 270, 110, [['sel', 'WIPERC', 'CAPT', 0, 0], ['pbm', 'RAINC', 'RPLNT', 1.05, 0], ['sel', 'WIPERF', 'F/O', 2.1, 0]]],
  ['EXT LT', 1160, 600, 560, 200, [['sel', 'STROBE', 'STROBE', 0, 0], ['tog', 'BEACON', 'BEACON', 1.15, 0], ['tog', 'WING', 'WING', 2.3, 0], ['sel', 'NAV', 'NAV & LOGO', 3.45, 0], ['tog', 'LOGO', 'LOGO', 4.6, 0],
    ['tog', 'RWYTURN', 'RWY TURN OFF', 0, 1], ['tog', 'LAND', 'LAND', 1.6, 1], ['sel', 'NOSE', 'NOSE', 3, 1]]],
  ['SIGNS', 1160, 820, 560, 110, [['sel', 'SEATBELT', 'SEAT BELTS', 0, 0], ['sel', 'NOSMOKING', 'NO SMOKING', 1.3, 0], ['sel', 'NOMOBILE', 'NO MOBILE', 2.6, 0], ['sel', 'EMEREXIT', 'EMER EXIT LT', 3.9, 0]]],
  ['INT LT', 1160, 950, 560, 110, [['knob', 'OVHDLT', 'OVHD INTEG', 0, 0], ['sel', 'ANNLT', 'ANN LT', 1.3, 0], ['sel', 'DOME', 'DOME', 2.6, 0], ['pbm', 'CARGOSMOKE', 'CARGO SMOKE', 3.9, 0]]],
];

export function buildOverhead(sim) {
  const P = new CanvasPanel('overhead', 1740, 1080);
  P.draw = (t) => drawOverhead(P, sim, t);
  return P;
}
function drawOverhead(P, sim) {
  const g = P.g, S = sim.S; P.hot = []; P.ids.clear();
  g.fillStyle = PANEL_DARK; g.fillRect(0, 0, P.w, P.h);
  const test = S.ov.ANNLT === 0 && S.dcPowered;
  const ovl = S.ov.OVHDLT * (S.dcPowered ? 1 : 0);
  for (const [title, sx, sy, sw, sh, ctls] of OVH) {
    section(g, sx, sy, sw, sh, title);
    for (const c of ctls) {
      const [kind, id, label, col, row, agent, dx] = c;
      const o = [kind, id, label]; o.x = sx + 18 + col * 70 + (dx || 0); o.y = sy + 46 + row * 92;
      if (kind === 'agent') o.agent = agent;
      if (kind === 'lamp') {
        o.fn = {
          ONBAT: (S) => [['ON BAT', AMB, S.ir.some((r) => r.onBat > 0) || test], ['ALIGN', WHT, S.ir.some((r) => r.state === 'NAV' && r.align < 1)]],
          BATV: (S) => [[(S.elec?.batV?.[0] || 0).toFixed(1) + 'V', GRN, S.dcPowered], [(S.elec?.batV?.[3] || 0).toFixed(1) + 'V', GRN, S.dcPowered]],
          APUSTAT: (S) => [['N ' + Math.round(S.apu.n), GRN, S.dcPowered], ['EGT ' + Math.round(S.apu.egt), GRN, S.dcPowered]],
          FOB: (S) => [[Math.round(S.fdm.fob / 100) / 10 + ' T', GRN, S.dcPowered], ['', GRN, false]],
        }[id];
      }
      if (kind === 'fire') { o.x = sx + 18 + col * 70; }
      drawCtl(P, S, sim, o, test);
    }
  }
  // integral lighting tint
  if (ovl < 0.5) { g.fillStyle = `rgba(0,0,0,${(0.5 - ovl) * 0.5})`; g.fillRect(0, 0, P.w, P.h); }
  T(g, 'A350-1000 OVERHEAD PANEL', 1730, 1066, '#9aa4ad', 11, 'right');
}

// ================= GLARESHIELD: EFIS CP (×2) + FCU + warning lights =================
export function buildGlareshield(sim) {
  const P = new CanvasPanel('glareshield', 2400, 300);
  P.draw = (t) => drawGlare(P, sim, t);
  return P;
}
function window7(g, x, y, w, h, s, col = '#ff9d2e') { g.fillStyle = '#050607'; rr(g, x, y, w, h, 3); g.fill(); g.strokeStyle = '#222'; g.stroke(); g.font = `${Math.round(h * 0.62)}px "B612 Mono", monospace`; g.fillStyle = col; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(s, x + w - 8, y + h / 2 + 2); }
function smallPb(P, g, x, y, w, h, label, lit, click, tip, id, litCol = GRN) {
  g.fillStyle = '#15191d'; rr(g, x - 2, y - 2, w + 4, h + 4, 3); g.fill(); g.fillStyle = '#2a3036'; rr(g, x, y, w, h, 3); g.fill();
  T(g, label, x + w / 2, y + h * 0.38, LBL, label.length > 5 ? 10 : 12);
  g.fillStyle = lit ? litCol : '#1c2125'; if (lit) { g.shadowColor = litCol; g.shadowBlur = 8; } g.fillRect(x + w * 0.25, y + h - 10, w * 0.5, 4); g.shadowBlur = 0;
  P.reg(x, y, w, h, { id, tip: tip || label, click });
}
function rotKnob(P, g, x, y, r, ang, opts) {
  knobDraw(g, x, y, r, ang);
  P.reg(x - r - 4, y - r - 4, 2 * r + 8, 2 * r + 8, { id: opts.id, tip: opts.tip, click: opts.click, wheel: opts.wheel });
}
function drawGlare(P, sim) {
  const g = P.g, S = sim.S, a = sim.afs, fcu = a.fcu, f = sim.fdm; P.hot = []; P.ids.clear();
  g.fillStyle = '#2d3338'; g.fillRect(0, 0, P.w, P.h);
  const pw = S.dcPowered; const test = S.ov.ANNLT === 0 && pw;
  // ---- warning lights + autoland + priority (each side) ----
  for (let s = 0; s < 2; s++) {
    const bx = s ? 2120 : 10;
    section(g, bx, 10, 270, 280, '');
    const mw = S.masterWarn && (Math.floor(performance.now() / 500) % 2 === 0 || true);
    g.fillStyle = (S.masterWarn || test) ? '#e01818' : '#3a1010'; if (S.masterWarn) { g.shadowColor = '#f00'; g.shadowBlur = 16; } rr(g, bx + 20, 30, 110, 70, 5); g.fill(); g.shadowBlur = 0; T(g, 'MASTER', bx + 75, 52, S.masterWarn || test ? WHT : '#703030', 14); T(g, 'WARN', bx + 75, 76, S.masterWarn || test ? WHT : '#703030', 14);
    P.reg(bx + 20, 30, 110, 70, { id: 'MW' + s, tip: 'MASTER WARN — press to silence', click: () => { S.masterWarn = false; S.emit('silence'); } }); void mw;
    g.fillStyle = (S.masterCaut || test) ? '#e09a00' : '#3a2a08'; rr(g, bx + 140, 30, 110, 70, 5); g.fill(); T(g, 'MASTER', bx + 195, 52, S.masterCaut || test ? '#111' : '#705a20', 14); T(g, 'CAUT', bx + 195, 76, S.masterCaut || test ? '#111' : '#705a20', 14);
    P.reg(bx + 140, 30, 110, 70, { id: 'MC' + s, tip: 'MASTER CAUT — press to cancel', click: () => { S.masterCaut = false; } });
    const al = S.autolandWarn || test; g.fillStyle = al ? '#e01818' : '#3a1010'; rr(g, bx + 20, 116, 110, 44, 4); g.fill(); T(g, 'AUTO LAND', bx + 75, 138, al ? WHT : '#703030', 12);
    P.reg(bx + 20, 116, 110, 44, { tip: 'AUTOLAND warning light' });
    const prio = sim.stickPriority === s; g.fillStyle = '#20262b'; rr(g, bx + 140, 116, 110, 44, 4); g.fill(); T(g, 'SIDE STICK', bx + 195, 128, LBL, 10); T(g, prio ? '\u25c0 PRIORITY' : 'PRIORITY', bx + 195, 148, prio || test ? GRN : '#3a4a3a', 12);
    smallPb(P, g, bx + 20, 180, 110, 50, 'CHRONO', !!sim.chrono?.[s]?.run, () => { const c = (sim.chrono ||= [{}, {}])[s]; if (!c.run && !c.t) { c.run = true; c.t0 = performance.now(); } else if (c.run) { c.run = false; c.t = (performance.now() - c.t0) / 1000; } else { c.t = 0; } }, 'Chronometer start / stop / reset', 'CHRONO' + s);
    smallPb(P, g, bx + 140, 180, 110, 50, 'ATC MSG', !!sim.atcMsg, () => { sim.atcMsg = false; sim.openAtc?.(); }, 'ATC message pb', 'ATCMSG' + s);
    T(g, s ? 'F/O' : 'CAPT', bx + 135, 262, '#9aa4ad', 12);
  }
  // ---- EFIS control panels ----
  for (let s = 0; s < 2; s++) {
    const ef = sim.efis[s]; const bx = s ? 1700 : 290; section(g, bx, 10, 410, 280, s ? 'EFIS CP F/O' : 'EFIS CP CAPT');
    // baro: STD push/pull, wheel to set, inHg/hPa toggle
    const bxx = bx + 70, by = 92;
    window7(g, bx + 20, 34, 120, 32, ef.std ? 'Std' : ef.inHg ? (ef.baro / 33.8639).toFixed(2) : String(Math.round(ef.baro)), ef.std ? '#ff9d2e' : '#ff9d2e');
    rotKnob(P, g, bxx, by, 24, ef.std ? 0 : 0.6, { id: 'BARO' + s, tip: 'BARO — wheel: set QNH, click: STD ⇄ QNH (push/pull)', click: () => { ef.std = !ef.std; if (!ef.std && ef.preStd) ef.baro = ef.preStd; if (ef.std) ef.preStd = ef.baro; }, wheel: (d) => { if (ef.std) return; ef.baro = clamp(ef.baro + (d > 0 ? -1 : 1) * (ef.inHg ? 0.33864 : 1), 900, 1100); } });
    T(g, 'inHg', bxx - 38, by + 38, LBL, 10); T(g, 'hPa', bxx + 38, by + 38, LBL, 10);
    P.reg(bxx - 58, by + 30, 116, 18, { tip: 'Baro unit inHg / hPa', click: () => { ef.inHg = !ef.inHg; } });
    smallPb(P, g, bx + 20, 160, 56, 42, 'FD', ef.fd, () => { ef.fd = !ef.fd; sim.afs.fdPb(s); }, 'Flight director', 'FD' + s);
    smallPb(P, g, bx + 84, 160, 56, 42, 'LS', ef.ls, () => { ef.ls = !ef.ls; }, 'Landing system scales on PFD', 'LS' + s);
    smallPb(P, g, bx + 20, 210, 120, 34, 'VV', !!ef.vv, () => { ef.vv = !ef.vv; }, 'Velocity vector (FPV) on PFD', 'VV' + s);
    // ND mode / range
    const MODES = ['ROSE LS', 'ROSE VOR', 'ROSE NAV', 'ARC', 'PLAN'], RANGES = [10, 20, 40, 80, 160, 320, 640];
    const mi = Math.max(0, MODES.indexOf(ef.mode)), ri = Math.max(0, RANGES.indexOf(ef.range));
    const mx = bx + 205, my = 92;
    MODES.forEach((m, i) => { const an = -1.4 + 2.8 * i / 4; T(g, m.replace('ROSE ', ''), mx + Math.sin(an) * 42, my - Math.cos(an) * 38, i === mi ? WHT : '#c7ced4', 9); });
    T(g, 'ROSE', mx - 46, my + 26, '#c7ced4', 9);
    rotKnob(P, g, mx, my, 22, -1.4 + 2.8 * mi / 4, { id: 'NDMODE' + s, tip: () => 'ND mode: ' + ef.mode, click: (b) => { ef.mode = MODES[clamp(mi + (b === 2 ? -1 : 1), 0, 4)]; }, wheel: (d) => { ef.mode = MODES[clamp(mi + (d > 0 ? -1 : 1), 0, 4)]; } });
    const rx = bx + 330, ry = 92;
    RANGES.forEach((r, i) => { const an = -1.5 + 3 * i / 6; T(g, String(r), rx + Math.sin(an) * 42, ry - Math.cos(an) * 38, i === ri ? WHT : '#c7ced4', 9); });
    rotKnob(P, g, rx, ry, 22, -1.5 + 3 * ri / 6, { id: 'NDRANGE' + s, tip: () => 'ND range: ' + ef.range + ' NM', click: (b) => { ef.range = RANGES[clamp(ri + (b === 2 ? -1 : 1), 0, 6)]; }, wheel: (d) => { ef.range = RANGES[clamp(ri + (d > 0 ? -1 : 1), 0, 6)]; } });
    // ND option pbs
    ['CSTR', 'WPT', 'VORD', 'NDB', 'ARPT'].forEach((o, i) => smallPb(P, g, bx + 160 + i * 48, 150, 44, 36, o, ef.opt === o || (o === 'CSTR' && ef.cstr), () => { if (o === 'CSTR') ef.cstr = !ef.cstr; else ef.opt = ef.opt === o ? null : o; }, 'ND option ' + o, o + s));
    smallPb(P, g, bx + 160, 196, 92, 36, 'TERR ON ND', ef.terr, () => { ef.terr = !ef.terr; }, 'Terrain display on ND', 'TERR' + s);
    smallPb(P, g, bx + 258, 196, 92, 36, 'WXR', !!ef.wxr, () => { ef.wxr = !ef.wxr; }, 'Weather radar on ND', 'WXR' + s);
    // VOR / ADF selectors
    for (let k = 0; k < 2; k++) { const tx = bx + 180 + k * 160, ty = 260; const v = ef.nav[k]; T(g, k ? 'VOR 2' : 'VOR 1', tx - 40, ty - 12, LBL, 9); T(g, 'OFF', tx, ty - 12, LBL, 9); T(g, k ? 'ADF 2' : 'ADF 1', tx + 40, ty - 12, LBL, 9);
      toggleDraw(g, tx + (v === 'VOR' ? -14 : v === 'ADF' ? 14 : 0), ty + 8, 0);
      P.reg(tx - 60, ty - 22, 120, 40, { id: `NAV${k}${s}`, tip: () => `ND bearing pointer ${k + 1}: ${v || 'OFF'}`, click: (b) => { const L = ['VOR', null, 'ADF']; const i = L.indexOf(ef.nav[k]); ef.nav[k] = L[clamp(i + (b === 2 ? -1 : 1), 0, 2)]; } }); }
  }
  // ---- FCU ----
  const fx = 710; section(g, fx, 10, 980, 280, 'FCU');
  const mFont = (s) => s;
  // SPD/MACH
  window7(g, fx + 30, 40, 150, 46, a.fcu.spdManaged ? (a.fcu.machMode ? '.--' : '---') : a.fcu.machMode ? '.' + String(Math.round(a.fcu.mach * 100)).padStart(2, '0') : String(a.fcu.spd));
  if (a.fcu.spdManaged) { g.fillStyle = '#ff9d2e'; g.beginPath(); g.arc(fx + 170, 63, 6, 0, Math.PI * 2); g.fill(); }
  T(g, a.fcu.machMode ? 'MACH' : 'SPD', fx + 60, 30, '#ff9d2e', 11);
  rotKnob(P, g, fx + 105, 150, 34, 0, { id: 'SPDKNOB', tip: 'SPD knob — wheel: turn, click: push (managed), right-click: pull (selected)', click: (b) => (b === 2 ? a.spdPull() : a.spdPush()), wheel: (d) => a.spdTurn(d > 0 ? -1 : 1) });
  smallPb(P, g, fx + 40, 210, 130, 40, 'SPD/MACH', false, () => a.spdMach(), 'Toggle speed / Mach', 'SPDMACH');
  // HDG/TRK
  window7(g, fx + 220, 40, 150, 46, a.fcu.hdgManaged && !a.fcu.hdgPreset ? '---' : String(a.fcu.hdg).padStart(3, '0'));
  if (a.fcu.hdgManaged) { g.fillStyle = '#ff9d2e'; g.beginPath(); g.arc(fx + 360, 63, 6, 0, Math.PI * 2); g.fill(); }
  T(g, a.fcu.trkFpa ? 'TRK' : 'HDG', fx + 250, 30, '#ff9d2e', 11); T(g, 'LAT', fx + 330, 30, '#ff9d2e', 11);
  rotKnob(P, g, fx + 295, 150, 34, a.fcu.hdg * Math.PI / 180, { id: 'HDGKNOB', tip: 'HDG knob — wheel: turn, click: push (NAV), right-click: pull (HDG)', click: (b) => (b === 2 ? a.hdgPull() : a.hdgPush()), wheel: (d) => a.hdgTurn((d > 0 ? -1 : 1) * (sim.keys?.ShiftLeft ? 10 : 1)) });
  smallPb(P, g, fx + 230, 210, 130, 40, 'LOC', a.latArmed === 'LOC' || a.lat === 'LOC' || a.lat === 'LOC*', () => a.locPb(), 'LOC', 'LOC');
  // AP / ATHR
  smallPb(P, g, fx + 400, 40, 80, 50, 'AP1', a.ap[0], () => a.apPb(0), 'Autopilot 1', 'AP1');
  smallPb(P, g, fx + 490, 40, 80, 50, 'AP2', a.ap[1], () => a.apPb(1), 'Autopilot 2', 'AP2');
  smallPb(P, g, fx + 400, 104, 170, 46, 'A/THR', a.athr.armed || a.athr.active, () => a.athrPb(), 'Autothrust arm / disconnect', 'ATHR');
  smallPb(P, g, fx + 400, 164, 80, 40, 'EXPED', a.fcu.exped, () => a.expedPb(), 'Expedite climb / descent', 'EXPED');
  smallPb(P, g, fx + 490, 164, 80, 40, 'APPR', a.vertArmed.includes('G/S') || a.vert.startsWith('G/S') || a.vert === 'LAND' || a.vert === 'FLARE', () => a.apprPb(), 'Approach mode (LOC + G/S)', 'APPR');
  smallPb(P, g, fx + 400, 214, 170, 36, 'TRK-FPA', a.fcu.trkFpa, () => a.trkFpaPb(), 'HDG-V/S ⇄ TRK-FPA reference', 'TRKFPA');
  // ALT
  window7(g, fx + 600, 40, 170, 46, String(a.fcu.alt).padStart(5, '0'));
  T(g, 'ALT', fx + 640, 30, '#ff9d2e', 11); T(g, 'LVL/CH', fx + 730, 30, '#ff9d2e', 11);
  rotKnob(P, g, fx + 670, 150, 34, a.fcu.alt / 5000, { id: 'ALTKNOB', tip: 'ALT knob — wheel: turn, click: push (managed climb/descent), right-click: pull (OP CLB/DES)', click: (b) => (b === 2 ? a.altPull() : a.altPush()), wheel: (d) => a.altTurn(d > 0 ? -1 : 1) });
  T(g, '100', fx + 620, 214, LBL, 10); T(g, '1000', fx + 720, 214, LBL, 10); toggleDraw(g, fx + 670, 222, 0);
  g.fillStyle = WHT; g.beginPath(); g.arc(fx + 670 + (a.fcu.altInc === 1000 ? 14 : -14), 222, 6, 0, Math.PI * 2); g.fill();
  P.reg(fx + 600, 200, 140, 40, { id: 'ALTINC', tip: () => 'ALT increment ' + a.fcu.altInc + ' ft', click: () => { a.fcu.altInc = a.fcu.altInc === 100 ? 1000 : 100; } });
  smallPb(P, g, fx + 600, 246, 140, 30, 'METRIC ALT', !!sim.fcuMetric, () => { sim.fcuMetric = !sim.fcuMetric; }, 'Display metric altitude on PFD', 'METRIC');
  // V/S FPA
  window7(g, fx + 790, 40, 170, 46, a.vert === 'V/S' || a.vert === 'FPA' ? (a.fcu.trkFpa ? (a.fcu.fpa >= 0 ? '+' : '') + a.fcu.fpa.toFixed(1) : (a.fcu.vs >= 0 ? '+' : '-') + String(Math.abs(Math.round(a.fcu.vs / 100))).padStart(2, '0') + 'oo') : '-----');
  T(g, a.fcu.trkFpa ? 'FPA' : 'V/S', fx + 830, 30, '#ff9d2e', 11);
  rotKnob(P, g, fx + 875, 150, 34, a.fcu.vs / 3000, { id: 'VSKNOB', tip: 'V/S knob — wheel: turn, click: push (level off), right-click: pull (V/S engage)', click: (b) => (b === 2 ? a.vsPull() : a.vsPush()), wheel: (d) => a.vsTurn(d > 0 ? -1 : 1) });
  void mFont; void f;
}

// ================= PEDESTAL =================
export function buildPedestal(sim) {
  const P = new CanvasPanel('pedestal', 1000, 1500);
  P.draw = (t) => drawPedestal(P, sim, t);
  return P;
}
const ECP_KEYS = [['ENG', 'ENG'], ['APU', 'APU'], ['BLEED', 'BLEED'], ['COND', 'COND'], ['PRESS', 'PRESS'], ['DOOR', 'DOOR'], ['ELEC', 'ELEC'], ['FUEL', 'FUEL'], ['WHEEL', 'WHEEL'], ['HYD', 'HYD'], ['F/CTL', 'F/CTL'], ['ALL', 'ALL'], ['STS', 'STS'], ['CRUISE', 'CRUISE']];
function drawPedestal(P, sim) {
  const g = P.g, S = sim.S, f = sim.fdm; P.hot = []; P.ids.clear();
  g.fillStyle = PANEL_DARK; g.fillRect(0, 0, P.w, P.h);
  const pw = S.dcPowered;
  // ---- RMP 1 / 2 (top left / right) and RMP 3 ----
  for (let i = 0; i < 3; i++) {
    const r = sim.rmp[i]; const bx = i === 0 ? 10 : i === 1 ? 680 : 345; const by = i === 2 ? 1310 : 10;
    section(g, bx, by, 310, 180, 'RMP ' + (i + 1));
    const ch = r.sel; const fa = r.active[ch], fs = r.stby[ch];
    window7(g, bx + 16, by + 30, 128, 36, pw ? fa.toFixed(3) : '', '#3dff6e'); window7(g, bx + 166, by + 30, 128, 36, pw ? fs.toFixed(3) : '', '#3dff6e');
    smallPb(P, g, bx + 146, by + 32, 18, 32, '\u21c4', false, () => { const a = r.active[ch]; r.active[ch] = r.stby[ch]; r.stby[ch] = a; if (i === 0 && ch === 'VHF1') { sim.atc.frequency = r.active[ch]; } }, 'Transfer active ⇄ standby', 'RMPX' + i);
    ['VHF1', 'VHF2', 'VHF3', 'HF1', 'HF2'].forEach((c, k) => smallPb(P, g, bx + 16 + k * 57, by + 76, 52, 34, c, ch === c, () => { r.sel = c; }, 'Select ' + c, `RMP${i}${c}`));
    rotKnob(P, g, bx + 245, by + 140, 22, ((fs * 1000) % 1000) / 160, { id: 'RMPK' + i, tip: 'Frequency knob — wheel: kHz, right-click/shift-wheel: MHz', click: (b) => { r.stby[ch] = clamp(+(r.stby[ch] + (b === 2 ? -1 : 1)).toFixed(3), 118, 136.975); }, wheel: (d) => { r.stby[ch] = clamp(+(r.stby[ch] + (d > 0 ? -0.025 : 0.025)).toFixed(3), 118, 136.975); } });
    for (let k = 0; k < 3; k++) { const v = r.vol[k]; knobDraw(g, bx + 40 + k * 60, by + 140, 15, -2 + 4 * v); T(g, ['VHF1', 'VHF2', 'INT'][k], bx + 40 + k * 60, by + 166, LBL, 9); P.reg(bx + 22 + k * 60, by + 122, 36, 36, { tip: 'Audio volume', wheel: (d) => { r.vol[k] = clamp(v + (d > 0 ? -0.1 : 0.1), 0, 1); }, click: (b) => { r.vol[k] = clamp(v + (b === 2 ? -0.1 : 0.1), 0, 1); } }); }
  }
  // ---- KCCU (keyboard cursor control unit) — two units, left and right ----
  for (let s = 0; s < 2; s++) {
    const bx = s ? 680 : 10, by = 210; section(g, bx, by, 310, 470, s ? 'KCCU F/O' : 'KCCU CAPT');
    const keys = ['ABCDEF', 'GHIJKL', 'MNOPQR', 'STUVWX', 'YZ/.-+'];
    keys.forEach((row, ry) => [...row].forEach((ch, cx) => { const kx = bx + 14 + cx * 34, ky = by + 30 + ry * 36; g.fillStyle = '#20262b'; rr(g, kx, ky, 30, 30, 3); g.fill(); T(g, ch, kx + 15, ky + 15, LBL, 13); P.reg(kx, ky, 30, 30, { tip: 'KCCU key ' + ch, click: () => sim.kccuKey(ch) }); }));
    for (let n = 0; n < 10; n++) { const kx = bx + 222 + (n === 0 ? 1 : (n - 1) % 3) * 28, ky = by + 30 + (n === 0 ? 3 : Math.floor((n - 1) / 3)) * 36; g.fillStyle = '#20262b'; rr(g, kx, ky, 26, 30, 3); g.fill(); T(g, String(n), kx + 13, ky + 15, LBL, 13); P.reg(kx, ky, 26, 30, { tip: 'KCCU key ' + n, click: () => sim.kccuKey(String(n)) }); }
    const fk = [['CLR', 'Backspace'], ['ESC', 'Escape'], ['ENT', 'Enter'], ['SP', ' ']];
    fk.forEach(([l, k], i) => smallPb(P, g, bx + 14 + i * 72, by + 216, 66, 34, l, false, () => sim.kccuKey(k), 'KCCU ' + l, `KC${l}${s}`));
    // page direct-access keys (MFD)
    [['F-PLN', 'F-PLN'], ['PERF', 'PERF'], ['FUEL', 'FUEL&LOAD'], ['INIT', 'INIT'], ['NAV', 'NAVAIDS'], ['SURV', 'SURV'], ['ATC', 'ATCCOM'], ['FCU', 'FCU BKUP']].forEach(([l, pg], i) => smallPb(P, g, bx + 14 + (i % 4) * 72, by + 262 + Math.floor(i / 4) * 42, 66, 36, l, sim.mfd[s].tab === 'FMS' ? sim.mfd[s].page === pg : sim.mfd[s].tab === pg, () => { if (['SURV', 'ATCCOM', 'FCU BKUP'].includes(pg)) sim.mfd[s].tab = pg; else { sim.mfd[s].tab = 'FMS'; sim.mfd[s].page = pg; } }, 'MFD page ' + pg, `KP${l}${s}`));
    T(g, 'Typing on the keyboard goes to the focused MFD field', bx + 155, by + 360, '#c3ccd3', 10);
    // trackball
    g.fillStyle = '#111'; g.beginPath(); g.arc(bx + 155, by + 410, 34, 0, Math.PI * 2); g.fill(); const grd = g.createRadialGradient(bx + 145, by + 400, 2, bx + 155, by + 410, 30); grd.addColorStop(0, '#7d8790'); grd.addColorStop(1, '#2a3036'); g.fillStyle = grd; g.beginPath(); g.arc(bx + 155, by + 410, 28, 0, Math.PI * 2); g.fill();
    smallPb(P, g, bx + 20, by + 390, 70, 40, 'DU SEL', false, () => { sim.kccuDu = (sim.kccuDu + 1) % 3; }, 'Select display unit for the cursor', 'DUSEL' + s);
    smallPb(P, g, bx + 220, by + 390, 70, 40, 'BRT +', false, () => { for (const k of Object.keys(sim.duBright)) sim.duBright[k] = clamp(sim.duBright[k] + 0.1, 0.2, 1); }, 'Display brightness', 'BRT' + s);
  }
  // ---- ECP (ECAM control panel) ----
  { const bx = 330, by = 10; section(g, bx, by, 340, 330, 'ECP');
    ECP_KEYS.forEach(([l, pg], i) => smallPb(P, g, bx + 14 + (i % 4) * 80, by + 30 + Math.floor(i / 4) * 44, 74, 38, l, S.sdPage === pg, () => { if (pg === 'ALL') { S.sdAllT = 0; S.sdAll = !S.sdAll; return; } if (pg === 'ELEC' && S.sdPage === 'ELEC') { S.sdElec = S.sdElec === 'AC' ? 'DC' : 'AC'; return; } S.sdPage = S.sdPage === pg ? 'AUTO' : pg; }, 'SD page ' + l, 'ECP' + pg));
    smallPb(P, g, bx + 14, by + 210, 100, 44, 'CLR', S.activeAlerts?.length > 0, () => S.clearTop(), 'ECAM CLR — clear the top alert', 'ECPCLR', WHT);
    smallPb(P, g, bx + 120, by + 210, 100, 44, 'RCL', false, () => S.recallAll(), 'Recall cleared alerts', 'ECPRCL');
    smallPb(P, g, bx + 226, by + 210, 100, 44, 'EMER CANC', false, () => S.emergencyCancel(), 'Emergency cancel (aural / caution)', 'ECPEMER', AMB);
    smallPb(P, g, bx + 14, by + 262, 100, 44, 'T.O CONFIG', S.toConfigTest > 0, () => S.testTOConfig(), 'Takeoff configuration test', 'TOCONFIG');
    smallPb(P, g, bx + 120, by + 262, 100, 44, 'C/L', S.eclOpen, () => { S.eclOpen = !S.eclOpen; }, 'Electronic checklist on EWD', 'ECPCL');
    smallPb(P, g, bx + 226, by + 262, 100, 44, 'C/L \u25b6', false, () => { S.eclIdx = (S.eclIdx + 1) % S.ecl.length; S.eclOpen = true; }, 'Next normal checklist', 'ECPNEXT'); }
  // ---- SURV panel ----
  { const bx = 330, by = 350; section(g, bx, by, 340, 330, 'SURV'); const p = S.ped;
    window7(g, bx + 20, by + 30, 140, 40, pw ? p.squawk : '', '#3dff6e');
    T(g, 'XPDR', bx + 220, by + 34, LBL, 10); ['STBY', 'AUTO', 'ON'].forEach((m, i) => smallPb(P, g, bx + 172 + i * 54, by + 44, 50, 30, m, p.xpdr === i, () => { p.xpdr = i; }, 'Transponder ' + m, 'XPDR' + m));
    for (let d = 0; d < 8; d++) smallPb(P, g, bx + 20 + (d % 4) * 36, by + 82 + Math.floor(d / 4) * 36, 32, 32, String(d), false, () => { p.sqBuf = ((p.sqBuf || '') + d).slice(-4); if (p.sqBuf.length === 4) { p.squawk = p.sqBuf; p.sqBuf = ''; } }, 'Squawk digit', 'SQK' + d);
    smallPb(P, g, bx + 172, by + 82, 76, 32, 'IDENT', !!p.ident, () => { p.ident = 18; }, 'Transponder IDENT', 'IDENT');
    smallPb(P, g, bx + 252, by + 82, 76, 32, 'CLR', false, () => { p.sqBuf = ''; }, 'Clear squawk entry', 'SQCLR');
    T(g, 'TCAS', bx + 60, by + 170, LBL, 11); ['STBY', 'TA', 'TA/RA'].forEach((m, i) => smallPb(P, g, bx + 20 + i * 54, by + 182, 50, 30, m, p.tcas === i, () => { p.tcas = i; }, 'TCAS ' + m, 'TCAS' + i));
    smallPb(P, g, bx + 190, by + 160, 66, 34, 'WXR', p.wxr, () => { p.wxr = !p.wxr; }, 'Weather radar', 'WXRSYS');
    smallPb(P, g, bx + 260, by + 160, 66, 34, 'PWS', !!p.pws, () => { p.pws = !p.pws; }, 'Predictive windshear', 'PWS');
    smallPb(P, g, bx + 190, by + 200, 66, 34, 'TERR', p.terr, () => { p.terr = !p.terr; }, 'TAWS terrain functions', 'TERRSYS');
    smallPb(P, g, bx + 260, by + 200, 66, 34, 'GPWS', p.gpws, () => { p.gpws = !p.gpws; }, 'GPWS basic modes', 'GPWSSYS');
    smallPb(P, g, bx + 20, by + 240, 96, 34, 'G/S MODE', p.gsMode, () => { p.gsMode = !p.gsMode; }, 'GPWS glideslope mode', 'GSMODE');
    smallPb(P, g, bx + 122, by + 240, 96, 34, 'FLAP MODE', p.flapMode, () => { p.flapMode = !p.flapMode; }, 'GPWS flap mode', 'FLAPMODE');
    smallPb(P, g, bx + 224, by + 240, 102, 34, 'ALT RPTG', p.altRptg !== false, () => { p.altRptg = p.altRptg === false; }, 'Altitude reporting', 'ALTRPTG'); }
  // ---- ENG master switches + ENG MODE selector ----
  { const bx = 10, by = 700; section(g, bx, by, 980, 230, 'ENG');
    for (let i = 0; i < 2; i++) {
      const x = bx + 300 + i * 220, y = by + 110; const on = S.master[i];
      T(g, 'MASTER ' + (i + 1), x, by + 32, LBL, 12); T(g, 'ON', x + 46, y - 34, LBL, 11); T(g, 'OFF', x + 46, y + 34, LBL, 11);
      g.fillStyle = '#15191d'; rr(g, x - 26, y - 50, 52, 100, 6); g.fill();
      g.fillStyle = '#cdd3d8'; rr(g, x - 16, on ? y - 46 : y + 4, 32, 42, 6); g.fill(); g.fillStyle = '#7d868e'; g.fillRect(x - 12, on ? y - 30 : y + 20, 24, 6);
      const fault = f.E[i].starting && f.E[i].startT > 60 || f.E[i].fire; const fire = f.E[i].fire;
      g.fillStyle = fire ? '#e01818' : '#3a1010'; rr(g, x - 90, y - 46, 50, 36, 4); g.fill(); T(g, 'FIRE', x - 65, y - 28, fire ? WHT : '#703030', 11);
      g.fillStyle = fault && !fire ? AMB : '#3a2a08'; rr(g, x - 90, y + 4, 50, 36, 4); g.fill(); T(g, 'FAULT', x - 65, y + 22, fault && !fire ? '#111' : '#705a20', 11);
      P.reg(x - 30, y - 54, 60, 108, { id: 'MASTER' + (i + 1), tip: () => `ENG ${i + 1} MASTER ${S.master[i] ? 'ON' : 'OFF'} (lift & move)`, click: () => { S.master[i] = !S.master[i]; S.emit('click3'); } });
    }
    // ENG MODE selector CRANK / NORM / IGN-START
    const mx = bx + 140, my = by + 110; const MODES = ['CRANK', 'NORM', 'IGN'];
    const mi = MODES.indexOf(S.engMode);
    T(g, 'ENG MODE', mx, by + 32, LBL, 12); MODES.forEach((m, i) => { const an = -1 + i; T(g, m === 'IGN' ? 'IGN/START' : m, mx + Math.sin(an) * 62, my - Math.cos(an) * 50, LBL, 11); });
    g.fillStyle = '#111'; g.beginPath(); g.arc(mx, my, 30, 0, Math.PI * 2); g.fill(); g.save(); g.translate(mx, my); g.rotate(-1 + mi); g.fillStyle = '#e5e9ec'; rr(g, -9, -34, 18, 60, 6); g.fill(); g.restore();
    P.reg(mx - 60, my - 60, 120, 110, { id: 'ENGMODE', tip: () => 'ENG MODE ' + S.engMode + ' (click +, right-click −)', click: (b) => { S.engMode = MODES[clamp(mi + (b === 2 ? -1 : 1), 0, 2)]; }, wheel: (d) => { S.engMode = MODES[clamp(mi + (d > 0 ? -1 : 1), 0, 2)]; } });
    // rudder trim
    const rx = bx + 820, ry = by + 110;
    T(g, 'RUD TRIM', rx, by + 32, LBL, 12); window7(g, rx - 60, by + 46, 120, 30, (f.ctrl.rudTrim >= 0 ? 'R ' : 'L ') + Math.abs(f.ctrl.rudTrim).toFixed(1), '#3dff6e');
    rotKnob(P, g, rx, ry + 20, 26, f.ctrl.rudTrim / 10, { id: 'RUDTRIM', tip: 'Rudder trim — wheel / click (left/right)', click: (b) => { f.ctrl.rudTrim = clamp(f.ctrl.rudTrim + (b === 2 ? -0.5 : 0.5), -25, 25); }, wheel: (d) => { f.ctrl.rudTrim = clamp(f.ctrl.rudTrim + (d > 0 ? -0.2 : 0.2), -25, 25); } });
    smallPb(P, g, rx - 40, ry + 60, 80, 30, 'RESET', false, () => { f.ctrl.rudTrim = 0; }, 'Rudder trim reset', 'RUDRESET');
  }
  // ---- park brake, cockpit door, gravity gear, flood lights ----
  { const bx = 10, by = 950; section(g, bx, by, 980, 340, 'PEDESTAL AFT');
    const px = bx + 120, py = by + 130; const park = f.ctrl.parkBrake;
    T(g, 'PARK BRK', px, by + 32, LBL, 12); T(g, 'ON', px + 70, py - 40, LBL, 11); T(g, 'OFF', px - 70, py - 40, LBL, 11);
    g.fillStyle = '#111'; g.beginPath(); g.arc(px, py, 44, 0, Math.PI * 2); g.fill(); g.save(); g.translate(px, py); g.rotate(park ? 0.9 : -0.9); g.fillStyle = '#c62a2a'; rr(g, -12, -58, 24, 80, 8); g.fill(); g.restore();
    T(g, park ? 'PARK BRK ON' : '', px, py + 70, AMB, 12);
    P.reg(px - 60, py - 70, 120, 150, { id: 'PARKBRK', tip: () => 'Parking brake ' + (park ? 'ON' : 'OFF') + ' (click)', click: () => { f.ctrl.parkBrake = !f.ctrl.parkBrake; S.emit('park'); } });
    // cockpit door
    const dx = bx + 330, dy = by + 120; T(g, 'COCKPIT DOOR', dx, by + 32, LBL, 12); const DM = ['UNLOCK', 'NORM', 'LOCK'];
    DM.forEach((m, i) => T(g, m, dx + (i - 1) * 60, dy - 40, LBL, 10)); toggleDraw(g, dx + (S.ped.ckptDoor - 1) * 30, dy, 0);
    P.reg(dx - 90, dy - 50, 180, 80, { id: 'CKPTDOOR', tip: () => 'Cockpit door ' + DM[S.ped.ckptDoor], click: (b) => { S.ped.ckptDoor = clamp(S.ped.ckptDoor + (b === 2 ? -1 : 1), 0, 2); } });
    // floodlights & dome
    const lx = bx + 560; T(g, 'FLOOD LT', lx, by + 32, LBL, 12);
    rotKnob(P, g, lx - 40, by + 110, 22, -2 + 4 * S.lights.flood, { id: 'FLOOD', tip: 'Pedestal flood light', wheel: (d) => { S.lights.flood = clamp(S.lights.flood + (d > 0 ? -0.1 : 0.1), 0, 1); }, click: (b) => { S.lights.flood = clamp(S.lights.flood + (b === 2 ? -0.1 : 0.1), 0, 1); } });
    rotKnob(P, g, lx + 40, by + 110, 22, -2 + 4 * S.lights.panel, { id: 'PANELLT', tip: 'Main panel integral lighting', wheel: (d) => { S.lights.panel = clamp(S.lights.panel + (d > 0 ? -0.1 : 0.1), 0, 1); }, click: (b) => { S.lights.panel = clamp(S.lights.panel + (b === 2 ? -0.1 : 0.1), 0, 1); } });
    smallPb(P, g, lx - 60, by + 160, 120, 34, 'STORM', S.lights.storm, () => { S.lights.storm = !S.lights.storm; }, 'Storm light', 'STORM');
    // gravity gear extension
    const gx = bx + 800; T(g, 'GRAVITY GEAR EXTN', gx, by + 32, LBL, 11);
    rotKnob(P, g, gx, by + 110, 32, S.gravityGear ? 2.5 : 0, { id: 'GRAVGEAR', tip: 'Gravity gear extension crank (click)', click: () => { S.gravityGear = !S.gravityGear; if (S.gravityGear) f.gear.lever = 1; } });
    // DU reconfiguration / brightness
    T(g, 'DU BRIGHTNESS', bx + 490, by + 230, LBL, 11);
    for (const [k, i] of [['CO', 0], ['CI', 1], ['CU', 2], ['CL', 3], ['FI', 4], ['FO', 5]]) {
      const kx = bx + 160 + i * 130; rotKnob(P, g, kx, by + 286, 20, -2 + 4 * (sim.duBright[k] ?? 1), { id: 'DUBRT' + k, tip: `${k} display brightness (wheel; fully left = OFF)`, wheel: (d) => { sim.duBright[k] = clamp((sim.duBright[k] ?? 1) + (d > 0 ? -0.1 : 0.1), 0, 1); }, click: (b) => { sim.duBright[k] = clamp((sim.duBright[k] ?? 1) + (b === 2 ? -0.25 : 0.25), 0, 1); } });
      T(g, { CO: 'CAPT PFD', CI: 'CAPT ND', CU: 'EWD/SD', CL: 'MFD', FI: 'F/O ND', FO: 'F/O PFD' }[k], kx, by + 320, LBL, 9);
    }
  }
  // flap / speedbrake / thrust lever labels (the levers themselves are 3D)
  T(g, 'Thrust levers, flap lever and speed brake are 3D (drag or click)', 500, 1490, '#9aa4ad', 11);
}

// ================= MAIN PANEL lower (gear / brakes / clock) =================
export function buildGearPanel(sim) {
  const P = new CanvasPanel('gear', 520, 520);
  P.draw = (t) => drawGear(P, sim, t);
  return P;
}
const ABRK = ['OFF', 'BTV', 'LO', '2', '3', 'HI'];
function drawGear(P, sim) {
  const g = P.g, S = sim.S, f = sim.fdm; P.hot = []; P.ids.clear();
  g.fillStyle = PANEL_DARK; g.fillRect(0, 0, P.w, P.h); section(g, 6, 6, P.w - 12, P.h - 12, 'L/G  BRAKES');
  const pw = S.dcPowered; const test = S.ov.ANNLT === 0 && pw;
  // gear position indicators (green triangles / red UNLK)
  const gi = (x, y) => { const down = f.gear.pos > 0.99, moving = f.gear.pos > 0.01 && !down; g.fillStyle = '#111'; rr(g, x - 28, y - 22, 56, 44, 4); g.fill();
    if (pw && (down || test)) { g.fillStyle = GRN; g.beginPath(); g.moveTo(x - 14, y - 10); g.lineTo(x + 14, y - 10); g.lineTo(x, y + 8); g.closePath(); g.fill(); }
    if (pw && (moving || test)) T(g, 'UNLK', x, y + 14, RED, 10); };
  gi(260, 70); gi(190, 120); gi(330, 120);
  T(g, 'LDG GEAR', 260, 160, LBL, 11); T(g, 'Lever is 3D — click it (G)', 260, 176, '#c3ccd3', 9);
  // autobrake selector
  const ax = 130, ay = 270; const ai = Math.max(0, ABRK.indexOf(f.abrk.mode));
  T(g, 'AUTO BRK', ax, 206, LBL, 12);
  ABRK.forEach((m, i) => { const an = -2 + 4 * i / 5; T(g, m === 'OFF' ? 'DISARM' : m, ax + Math.sin(an) * 62, ay - Math.cos(an) * 54, i === ai ? WHT : '#c3ccd3', 10); });
  rotKnob(P, g, ax, ay, 28, -2 + 4 * ai / 5, { id: 'AUTOBRK', tip: () => 'AUTO BRK ' + f.abrk.mode + ' (click +, right-click −)', click: (b) => { f.abrk.mode = ABRK[clamp(ai + (b === 2 ? -1 : 1), 0, 5)]; S.emit('click3'); }, wheel: (d) => { f.abrk.mode = ABRK[clamp(ai + (d > 0 ? -1 : 1), 0, 5)]; } });
  smallPb(P, g, ax - 60, 340, 120, 40, 'RTO', f.abrk.mode === 'RTO', () => { f.abrk.mode = f.abrk.mode === 'RTO' ? 'OFF' : 'RTO'; }, 'Rejected-takeoff autobrake arm', 'RTO');
  T(g, f.abrk.active ? 'DECEL' : '', ax, 400, GRN, 13);
  // A/SKID & BRK FAN & brake pressure
  const p = S.ped; const ask = p.antiSkid !== false;
  T(g, 'A/SKID', 390, 206, LBL, 12); toggleDraw(g, 390, 244, ask ? -1 : 1); T(g, 'ON', 420, 230, LBL, 10, 'left'); T(g, 'OFF', 420, 260, LBL, 10, 'left');
  P.reg(360, 216, 70, 60, { id: 'ASKID', tip: () => 'Anti-skid ' + (ask ? 'ON' : 'OFF'), click: () => { p.antiSkid = !ask; } });
  pbBox(g, 360, 300, 66, 46, ['HOT', AMB, Math.max(...f.brakeTemp) > 300 || test], ['ON', BLUE, !!p.brkFan || test], !!p.brkFan); T(g, 'BRK FAN', 393, 290, LBL, 10);
  P.reg(354, 294, 78, 58, { id: 'BRKFAN', tip: 'Brake fans', click: () => { p.brkFan = !p.brkFan; } });
  // triple brake indicator
  g.fillStyle = '#111'; rr(g, 330, 380, 130, 110, 6); g.fill(); T(g, 'ACCU', 395, 392, LBL, 9); T(g, 'BRAKES', 395, 472, LBL, 9);
  const bar = (x, v, max) => { g.fillStyle = '#333'; g.fillRect(x - 6, 400, 12, 60); g.fillStyle = GRN; const h = clamp(v / max, 0, 1) * 60; g.fillRect(x - 6, 460 - h, 12, h); };
  bar(395, S.brakeAccu * 3000, 3000); bar(360, f.ctrl.parkBrake ? 2000 : Math.max(f.ctrl.brakeL, f.abrkBrake || 0) * 3000, 3000); bar(430, f.ctrl.parkBrake ? 2000 : Math.max(f.ctrl.brakeR, f.abrkBrake || 0) * 3000, 3000);
  // clock
  const u = sim.utc(); window7(g, 30, 440, 150, 40, `${String(Math.floor(u) % 24).padStart(2, '0')}:${String(Math.floor((u % 1) * 60)).padStart(2, '0')}`, '#3dff6e'); T(g, 'UTC', 105, 492, LBL, 10);
  P.reg(30, 440, 150, 40, { tip: 'Clock (UTC)' });
}

export const FLAP_LABELS = CONFS.map((c) => c.id);
