// Cessna 172S steam-gauge instrument panel, drawn to a canvas (texture on the 3D panel).
// Static parts (panel paint, bezels, dial faces) are cached; needles/displays are redrawn each update.
import { hprFromQ } from './math.js';

export const PW = 2048, PH_ = 816;
const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const FONT = 'Barlow Condensed, Barlow, Arial Narrow, sans-serif';
const LCD = '"Share Tech Mono", "JetBrains Mono", monospace';

// instrument layout (canvas px)
export const L = {
  asi: [300, 228, 88], ai: [492, 228, 88], alt: [684, 228, 88],
  tc: [300, 428, 88], hi: [492, 428, 88], vsi: [684, 428, 88],
  clock: [108, 120, 62], cdi1: [874, 228, 80], cdi2: [874, 428, 80], tach: [492, 618, 76], adf: [874, 618, 70],
  stack: [1000, 52, 430],
};

function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function noiseFill(g, w, h, base, amt, seed = 1) {
  g.fillStyle = base; g.fillRect(0, 0, w, h);
  const id = g.getImageData(0, 0, w, h); const d = id.data;
  let s = seed * 9301 + 49297;
  for (let i = 0; i < d.length; i += 4) {
    s = (s * 9301 + 49297) % 233280; const n = (s / 233280 - 0.5) * amt;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(id, 0, 0);
}

function screw(g, x, y, r = 6) {
  const gr = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
  gr.addColorStop(0, '#9a9da0'); gr.addColorStop(1, '#2e3032');
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#141516'; g.lineWidth = 1.6; const a = (x * 7 + y * 3) % 3;
  g.beginPath(); g.moveTo(x - Math.cos(a) * r * 0.7, y - Math.sin(a) * r * 0.7); g.lineTo(x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.7); g.stroke();
}

function bezel(g, x, y, R) {
  // square-ish bezel with 4 mounting screws (3-1/8" instrument)
  const s = R + 16;
  const gr = g.createLinearGradient(x - s, y - s, x + s, y + s);
  gr.addColorStop(0, '#2b2c2e'); gr.addColorStop(1, '#0d0e0f');
  g.fillStyle = gr; roundRect(g, x - s, y - s, s * 2, s * 2, 14); g.fill();
  g.strokeStyle = '#3c3e41'; g.lineWidth = 1.5; g.stroke();
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) screw(g, x + dx * (s - 10), y + dy * (s - 10), 5);
  // inner shadow ring
  const ring = g.createRadialGradient(x, y, R * 0.9, x, y, R + 6);
  ring.addColorStop(0, 'rgba(0,0,0,0)'); ring.addColorStop(1, 'rgba(0,0,0,0.9)');
  g.fillStyle = '#060606'; g.beginPath(); g.arc(x, y, R + 5, 0, Math.PI * 2); g.fill();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function face(g, x, y, R) {
  const gr = g.createRadialGradient(x, y - R * 0.3, R * 0.1, x, y, R);
  gr.addColorStop(0, '#1b1c1e'); gr.addColorStop(1, '#0b0b0c');
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fill();
}

// polar helpers: angle measured clockwise from 12 o'clock
const px = (x, R, a) => x + Math.sin(a * DEG) * R;
const py = (y, R, a) => y - Math.cos(a * DEG) * R;

function tick(g, x, y, r0, r1, a, w = 2, col = '#eee') {
  g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(px(x, r0, a), py(y, r0, a)); g.lineTo(px(x, r1, a), py(y, r1, a)); g.stroke();
}
function arc(g, x, y, r, a0, a1, w, col) {
  g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.arc(x, y, r, (a0 - 90) * DEG, (a1 - 90) * DEG); g.stroke();
}
function label(g, x, y, r, a, txt, size = 22, col = '#f2f2f2', weight = 600) {
  g.fillStyle = col; g.font = `${weight} ${size}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(txt, px(x, r, a), py(y, r, a));
}
function text(g, txt, x, y, size = 18, col = '#ddd', align = 'center', weight = 600, font = FONT) {
  g.fillStyle = col; g.font = `${weight} ${size}px ${font}`; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(txt, x, y);
}

function needle(g, x, y, a, len, w = 6, col = '#f4f4f4', tail = 14) {
  g.save(); g.translate(x, y); g.rotate(a * DEG);
  g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 6; g.shadowOffsetX = 3; g.shadowOffsetY = 4;
  g.fillStyle = col; g.beginPath();
  g.moveTo(-w / 2, tail); g.lineTo(-w / 2, -len + w * 1.6); g.lineTo(0, -len); g.lineTo(w / 2, -len + w * 1.6); g.lineTo(w / 2, tail); g.closePath(); g.fill();
  g.restore();
}
function hub(g, x, y, r = 9) {
  const gr = g.createRadialGradient(x - 2, y - 2, 1, x, y, r); gr.addColorStop(0, '#666'); gr.addColorStop(1, '#111');
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
}
function glass(g, x, y, R) {
  const gr = g.createLinearGradient(x - R, y - R, x + R * 0.4, y + R * 0.4);
  gr.addColorStop(0, 'rgba(255,255,255,0.10)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.02)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fill();
}
function knob(g, x, y, r = 16) {
  const gr = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 2, x, y, r);
  gr.addColorStop(0, '#4a4b4d'); gr.addColorStop(1, '#0b0b0c');
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#000'; g.lineWidth = 1;
  for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2; g.beginPath(); g.moveTo(x + Math.cos(a) * r * 0.82, y + Math.sin(a) * r * 0.82); g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); g.stroke(); }
}

// ---------- ASI ----------
const asiAng = (v) => v <= 40 ? v * 0.75 : v <= 160 ? 30 + (v - 40) * 2.05 : 276 + (v - 160) * 1.5;

function asiFace(g, [x, y, R]) {
  face(g, x, y, R);
  arc(g, x, y, R - 10, asiAng(40), asiAng(85), 7, '#f5f5f5'); // white arc (flap operating)
  arc(g, x, y, R - 4, asiAng(48), asiAng(129), 7, '#1fa83c'); // green (normal)
  arc(g, x, y, R - 4, asiAng(129), asiAng(163), 7, '#e8c21a'); // yellow (caution)
  tick(g, x, y, R - 14, R, asiAng(163), 4, '#e0241c'); // Vne
  for (let v = 40; v <= 200; v += 5) tick(g, x, y, R - (v % 10 === 0 ? 15 : 8), R - 1, asiAng(v), v % 10 === 0 ? 2.4 : 1.4);
  for (let v = 40; v <= 200; v += 20) label(g, x, y, R - 30, asiAng(v), String(v), 21);
  // inner MPH scale
  for (let m = 60; m <= 220; m += 20) { const kt = m / 1.15078; if (kt > 200) break; label(g, x, y, R - 50, asiAng(kt), String(m), 11, '#a8a8a8', 500); }
  text(g, 'AIRSPEED', x, y + 14, 11, '#ddd'); text(g, 'KNOTS', x, y + 26, 10, '#bbb'); text(g, 'MPH', x, y - 22, 9, '#999');
}

// ---------- ALT ----------
function altFace(g, [x, y, R]) {
  face(g, x, y, R);
  for (let i = 0; i < 50; i++) tick(g, x, y, R - (i % 5 === 0 ? 15 : 8), R - 1, i * 7.2, i % 5 === 0 ? 2.6 : 1.4);
  for (let i = 0; i < 10; i++) label(g, x, y, R - 30, i * 36, String(i), 26);
  text(g, 'ALT', x, y - 30, 13, '#ddd'); text(g, '100 FEET', x - 2, y + 42, 10, '#bbb');
}

// ---------- VSI ----------
const vsiAng = (fpm) => -90 + clamp(fpm, -2050, 2050) / 2000 * 172 * (Math.abs(fpm) < 500 ? 1.15 : 1) - (Math.abs(fpm) < 500 ? 0 : Math.sign(fpm) * 500 / 2000 * 172 * 0.15);
function vsiFace(g, [x, y, R]) {
  face(g, x, y, R);
  for (let f = -2000; f <= 2000; f += 100) tick(g, x, y, R - (f % 500 === 0 ? 15 : 8), R - 1, vsiAng(f), f % 500 === 0 ? 2.6 : 1.4);
  for (const f of [0, 5, 10, 15, 20]) { label(g, x, y, R - 30, vsiAng(f * 100), String(f), 22); if (f) label(g, x, y, R - 30, vsiAng(-f * 100), String(f), 22); }
  text(g, 'UP', x - 40, y - 30, 12); text(g, 'DOWN', x - 40, y + 30, 12);
  text(g, 'VERTICAL SPEED', x + 14, y - 14, 10, '#bbb'); text(g, '100 FEET PER MIN', x + 14, y + 16, 10, '#bbb');
}

// ---------- TACH ----------
const tachAng = (r) => -135 + clamp(r, 0, 3500) / 3500 * 270;
function tachFace(g, [x, y, R]) {
  face(g, x, y, R);
  arc(g, x, y, R - 5, tachAng(2100), tachAng(2700), 7, '#1fa83c');
  tick(g, x, y, R - 16, R, tachAng(2700), 4, '#e0241c');
  for (let r = 0; r <= 3500; r += 100) tick(g, x, y, R - (r % 500 === 0 ? 14 : 7), R - 1, tachAng(r), r % 500 === 0 ? 2.4 : 1.2);
  for (let r = 0; r <= 35; r += 5) label(g, x, y, R - 28, tachAng(r * 100), String(r), 20);
  text(g, 'RPM', x, y - 26, 13); text(g, 'X100', x, y - 12, 10, '#aaa');
}

// ---------- engine cluster bar gauge ----------
function barFace(g, x, y, w, title, ranges, lo, hi, labels) {
  g.fillStyle = '#0c0c0d'; roundRect(g, x, y, w, 48, 6); g.fill();
  g.strokeStyle = '#2b2c2e'; g.lineWidth = 2; g.stroke();
  const X = (v) => x + 10 + (v - lo) / (hi - lo) * (w - 20);
  for (const [a, b, c] of ranges) { g.fillStyle = c; g.fillRect(X(a), y + 26, X(b) - X(a), 6); }
  g.strokeStyle = '#ddd'; g.lineWidth = 1.2;
  for (let i = 0; i <= 8; i++) { const xx = x + 10 + i / 8 * (w - 20); g.beginPath(); g.moveTo(xx, y + 24); g.lineTo(xx, y + 34); g.stroke(); }
  text(g, title, x + w / 2, y + 12, 12, '#ddd');
  if (labels) { text(g, labels[0], x + 12, y + 42, 10, '#bbb', 'left'); text(g, labels[1], x + w - 12, y + 42, 10, '#bbb', 'right'); }
}
function barNeedle(g, x, y, w, v, lo, hi) {
  const xx = x + 10 + (clamp(v, lo, hi) - lo) / (hi - lo) * (w - 20);
  g.fillStyle = '#f4f4f4'; g.beginPath(); g.moveTo(xx, y + 22); g.lineTo(xx - 5, y + 14 + 26); g.lineTo(xx + 5, y + 14 + 26); g.closePath(); g.fill();
}

// rocker switch
function rocker(g, x, y, on, lab, red = false) {
  g.fillStyle = '#060606'; roundRect(g, x - 15, y - 26, 30, 52, 4); g.fill();
  const top = on;
  const gr = g.createLinearGradient(x, y - 24, x, y + 24);
  const base = red ? ['#c3261d', '#5a0f0b'] : ['#3a3b3d', '#121314'];
  gr.addColorStop(top ? 0 : 1, base[0]); gr.addColorStop(top ? 1 : 0, base[1]);
  g.fillStyle = gr; roundRect(g, x - 12, y - 23, 24, 46, 3); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(x - 10, top ? y - 21 : y + 2, 20, 18);
  text(g, lab, x, y + 40, 11, '#e8e8e8');
}

export class Panel {
  constructor() {
    this.canvas = mk(PW, PH_);
    this.g = this.canvas.getContext('2d');
    this.static = mk(PW, PH_);
    this.hot = [];
    this.flash = 0;
    this.fontsReady = false;
    this.buildStatic();
    if (document.fonts) document.fonts.ready.then(() => { this.buildStatic(); this.fontsReady = true; });
  }

  buildStatic() {
    const g = this.static.getContext('2d');
    noiseFill(g, PW, PH_, '#2d2f31', 10, 3);
    // subtle panel shading
    const sh = g.createLinearGradient(0, 0, 0, PH_); sh.addColorStop(0, 'rgba(0,0,0,0.45)'); sh.addColorStop(0.15, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.25)');
    g.fillStyle = sh; g.fillRect(0, 0, PW, PH_);
    // left subpanel (pilot) border lines
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 3; roundRect(g, 12, 12, 975, PH_ - 24, 18); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 1; roundRect(g, 14, 14, 971, PH_ - 28, 16); g.stroke();
    for (const [x, y] of [[30, 30], [960, 30], [30, 786], [960, 786], [1440, 30], [1440, 786], [2018, 30], [2018, 786]]) screw(g, x, y, 6);
    // instruments
    for (const k of ['asi', 'ai', 'alt', 'tc', 'hi', 'vsi', 'cdi1', 'cdi2', 'tach', 'adf', 'clock']) bezel(g, ...L[k]);
    asiFace(g, L.asi); altFace(g, L.alt); vsiFace(g, L.vsi); tachFace(g, L.tach);
    this.clockFace(g); this.tcFace(g); this.cdiFace(g, L.cdi1, true); this.cdiFace(g, L.cdi2, false); this.adfFace(g);
    // knobs
    knob(g, L.alt[0] - 78, L.alt[1] + 80, 15); text(g, 'BARO', L.alt[0] - 78, L.alt[1] + 104, 10, '#aaa');
    knob(g, L.hi[0] - 78, L.hi[1] + 80, 15); text(g, 'PUSH', L.hi[0] - 78, L.hi[1] + 104, 10, '#aaa');
    knob(g, L.hi[0] + 78, L.hi[1] + 80, 15); g.fillStyle = '#e8721c'; g.fillRect(L.hi[0] + 74, L.hi[1] + 66, 8, 8); text(g, 'HDG', L.hi[0] + 78, L.hi[1] + 104, 10, '#aaa');
    knob(g, L.ai[0], L.ai[1] + 82, 12);
    for (const k of ['cdi1', 'cdi2']) { knob(g, L[k][0] - 70, L[k][1] + 72, 15); text(g, 'OBS', L[k][0] - 70, L[k][1] + 96, 10, '#aaa'); }
    knob(g, L.adf[0] - 64, L.adf[1] + 62, 13); text(g, 'HDG', L.adf[0] - 64, L.adf[1] + 84, 10, '#aaa');
    // engine cluster (left column)
    const ex = 22, ew = 172;
    this.eg = [
      ['FUEL QTY L', [[0, 1.5, '#e8c21a'], [1.5, 24, '#1fa83c']], 0, 26, ['0', '26 GAL'], (f) => f.sys.fuelL],
      ['FUEL QTY R', [[0, 1.5, '#e8c21a'], [1.5, 24, '#1fa83c']], 0, 26, ['0', '26 GAL'], (f) => f.sys.fuelR],
      ['FUEL FLOW GPH', [[0, 11.5, '#1fa83c']], 0, 20, ['0', '20'], (f) => (f.eng.ff || 0)],
      ['EGT', [], 900, 1700, ['', ''], (f) => f.eng.egt],
      ['OIL TEMP °F', [[100, 245, '#1fa83c'], [245, 250, '#e0241c']], 50, 250, ['', ''], (f) => f.eng.oilT],
      ['OIL PRESS PSI', [[0, 20, '#e0241c'], [50, 90, '#1fa83c'], [90, 115, '#e0241c']], 0, 115, ['', ''], (f) => f.eng.oilP],
      ['VAC  IN HG', [[4.5, 5.5, '#1fa83c']], 3, 7, ['3', '7'], (f) => f.eng.vac],
      ['AMMETER', [], -60, 60, ['−', '+'], (f) => f.eng.amps || 0],
    ];
    this.eg.forEach((e, i) => barFace(g, ex, 196 + i * 54, ew, e[0], e[1], e[2], e[3], e[4]));
    // annunciator strip
    g.fillStyle = '#080808'; roundRect(g, 220, 76, 560, 30, 4); g.fill();
    this.ann = ['OIL PRESS', 'LOW FUEL L', 'LOW FUEL R', 'LOW VAC', 'VOLTS', 'STALL'];
    // switch row
    g.fillStyle = 'rgba(0,0,0,0.25)'; roundRect(g, 18, 650, 960, 150, 10); g.fill();
    text(g, 'OFF', 92, 768, 11, '#bbb'); text(g, 'R', 66, 700, 11, '#bbb'); text(g, 'L', 82, 684, 11, '#bbb'); text(g, 'BOTH', 112, 682, 11, '#bbb'); text(g, 'START', 138, 700, 11, '#bbb');
    text(g, 'IGNITION', 100, 790, 11, '#999');
    // radio stack bay
    const [sx, sy, sw] = L.stack;
    g.fillStyle = '#121314'; roundRect(g, sx - 8, sy - 8, sw + 16, 560, 8); g.fill();
    this.radioStatic(g);
    // right side: hobbs, OAT, circuit breakers, glovebox, placards
    g.fillStyle = '#0a0a0a'; roundRect(g, 1478, 64, 120, 46, 4); g.fill(); text(g, 'HOBBS', 1538, 122, 11, '#aaa');
    // circuit breakers
    text(g, 'CIRCUIT BREAKERS', 1750, 560, 12, '#bbb');
    const cbs = ['ALT FLD', 'WARN', 'FLAP', 'INST', 'AVN FAN', 'GPS', 'NAV1', 'COM1', 'NAV2', 'COM2', 'XPDR', 'AP', 'ADF', 'AUDIO', 'PITOT', 'LAND LT', 'TAXI LT', 'NAV LT', 'STROBE', 'BCN', 'FUEL PMP', 'CABIN', 'PNL LT', 'ELT'];
    cbs.forEach((n, i) => { const cx = 1540 + (i % 8) * 56, cy = 600 + Math.floor(i / 8) * 64; g.fillStyle = '#0b0b0b'; g.beginPath(); g.arc(cx, cy, 13, 0, Math.PI * 2); g.fill(); g.fillStyle = '#d9d9d9'; g.beginPath(); g.arc(cx, cy, 8, 0, Math.PI * 2); g.fill(); text(g, n, cx, cy + 24, 9, '#bbb'); });
    // glovebox
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 3; roundRect(g, 1600, 170, 380, 300, 18); g.stroke();
    g.fillStyle = '#1e1f21'; roundRect(g, 1765, 192, 50, 18, 6); g.fill();
    text(g, 'THIS AIRPLANE MUST BE OPERATED AS A NORMAL OR UTILITY', 1790, 300, 13, '#c8c8c8', 'center', 500);
    text(g, 'CATEGORY AIRPLANE IN COMPLIANCE WITH THE OPERATING', 1790, 318, 13, '#c8c8c8', 'center', 500);
    text(g, 'LIMITATIONS STATED IN THE FORM OF PLACARDS, MARKINGS', 1790, 336, 13, '#c8c8c8', 'center', 500);
    text(g, 'AND MANUALS.  NO ACROBATIC MANEUVERS INCLUDING SPINS.', 1790, 354, 13, '#c8c8c8', 'center', 500);
    text(g, 'MANEUVERING SPEED: 105 KIAS @ 2550 LB   Vfe 10°: 110  Vfe 30°: 85', 1790, 390, 13, '#e6e6e6', 'center', 600);
    text(g, 'CESSNA', 1790, 440, 26, '#9da2a8', 'center', 700);
    // flap lever slot
    g.fillStyle = '#060606'; roundRect(g, 1484, 160, 26, 250, 10); g.fill();
    for (const [i, s] of ['UP', '10°', '20°', 'FULL'].entries()) text(g, s, 1540, 180 + i * 70, 13, '#ddd', 'left');
    text(g, 'FLAPS', 1497, 430, 12, '#bbb');
    // parking brake & trim label
    text(g, 'PARK BRAKE', 1050, 790, 11, '#bbb');
    text(g, 'PANEL LT', 1210, 790, 11, '#bbb'); text(g, 'CABIN LT', 1310, 790, 11, '#bbb');
    text(g, 'AVIONICS', 785, 790, 10, '#999');
    text(g, 'ELECTRICAL', 360, 790, 10, '#999');
  }

  clockFace(g) {
    const [x, y, R] = L.clock; face(g, x, y, R);
    for (let i = 0; i < 60; i++) tick(g, x, y, R - (i % 5 === 0 ? 10 : 5), R - 1, i * 6, i % 5 === 0 ? 2 : 1);
    for (let i = 1; i <= 12; i++) label(g, x, y, R - 20, i * 30, String(i), 15);
  }
  tcFace(g) {
    const [x, y, R] = L.tc; face(g, x, y, R);
    for (const s of [-1, 1]) { tick(g, x, y, R - 16, R - 2, s * 70, 4); tick(g, x, y, R - 16, R - 2, s * 90, 4); }
    text(g, 'L', x - R + 24, y + 22, 18); text(g, 'R', x + R - 24, y + 22, 18);
    text(g, 'TURN COORDINATOR', x, y - 44, 11, '#ccc'); text(g, '2 MIN', x, y + 60, 11, '#bbb'); text(g, 'NO PITCH INFORMATION', x, y + 74, 8, '#888');
    // ball tube
    g.fillStyle = '#d7d3c4'; roundRect(g, x - 46, y + 26, 92, 20, 10); g.fill();
    g.strokeStyle = '#111'; g.lineWidth = 2; g.beginPath(); g.moveTo(x - 11, y + 26); g.lineTo(x - 11, y + 46); g.moveTo(x + 11, y + 26); g.lineTo(x + 11, y + 46); g.stroke();
  }
  cdiFace(g, [x, y, R], gs) {
    face(g, x, y, R);
    // dots
    for (let i = -5; i <= 5; i++) if (i) { g.fillStyle = '#eee'; g.beginPath(); g.arc(x + i * 11, y + 6, 2.6, 0, Math.PI * 2); g.fill(); }
    if (gs) for (let i = -5; i <= 5; i++) if (i) { g.fillStyle = '#eee'; g.beginPath(); g.arc(x + 6, y + i * 10, 2.4, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = '#eee'; g.lineWidth = 2; g.beginPath(); g.arc(x, y + 6, 11, 0, Math.PI * 2); g.stroke();
    text(g, gs ? 'VOR / LOC / GS' : 'VOR', x, y + R - 18, 9, '#999');
  }
  adfFace(g) {
    const [x, y, R] = L.adf; face(g, x, y, R);
    for (let i = 0; i < 36; i++) tick(g, x, y, R - (i % 3 === 0 ? 12 : 6), R - 1, i * 10, i % 3 === 0 ? 2 : 1);
    for (let i = 0; i < 12; i++) label(g, x, y, R - 24, i * 30, ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'][i], 15);
    text(g, 'ADF', x, y + 26, 11, '#bbb');
  }

  radioStatic(g) {
    const [sx, sy, sw] = L.stack;
    const unit = (y, h, name) => {
      const gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, '#2b2c2e'); gr.addColorStop(1, '#18191a');
      g.fillStyle = gr; roundRect(g, sx, y, sw, h, 4); g.fill();
      g.strokeStyle = '#0a0a0a'; g.lineWidth = 2; g.stroke();
      if (name.includes('KAP')) text(g, name, sx + sw - 12, y + 9, 9, '#a9a9a9', 'right', 700);
      else text(g, name, sx + 14, y + h - 9, 10, '#a9a9a9', 'left', 700);
    };
    this.ry = { audio: sy, nc1: sy + 58, nc2: sy + 158, adf: sy + 258, ap: sy + 330, xpdr: sy + 402 };
    unit(this.ry.audio, 50, 'BENDIX/KING  KMA 26');
    const lab = ['MKR', 'COM1', 'COM2', 'NAV1', 'NAV2', 'ADF', 'DME', 'SPKR'];
    lab.forEach((l, i) => { g.fillStyle = '#0d0d0d'; roundRect(g, sx + 140 + i * 35, sy + 10, 30, 22, 3); g.fill(); text(g, l, sx + 155 + i * 35, sy + 21, 9, '#ddd'); });
    for (const [k, n] of [['nc1', 'KX 155A'], ['nc2', 'KX 155A']]) {
      const y = this.ry[k]; unit(y, 92, 'BENDIX/KING  ' + n);
      g.fillStyle = '#050505'; roundRect(g, sx + 14, y + 10, 400, 54, 4); g.fill();
      knob(g, sx + 196, y + 74, 12); knob(g, sx + 410, y + 74, 12);
      g.fillStyle = '#ccc'; roundRect(g, sx + 92, y + 66, 28, 14, 3); g.fill(); roundRect(g, sx + 308, y + 66, 28, 14, 3); g.fill();
      text(g, '⇆', sx + 106, y + 73, 12, '#111'); text(g, '⇆', sx + 322, y + 73, 12, '#111');
    }
    unit(this.ry.adf, 64, 'BENDIX/KING  KR 87');
    g.fillStyle = '#050505'; roundRect(g, sx + 14, this.ry.adf + 8, 260, 36, 4); g.fill(); knob(g, sx + 400, this.ry.adf + 28, 14);
    unit(this.ry.ap, 64, 'BENDIX/KING  KAP 140');
    g.fillStyle = '#050505'; roundRect(g, sx + 14, this.ry.ap + 8, 400, 28, 4); g.fill();
    this.apBtns = ['AP', 'HDG', 'NAV', 'APR', 'REV', 'ALT', 'DN', 'UP', 'ARM'];
    this.apBtns.forEach((b, i) => { g.fillStyle = '#cfcfcf'; roundRect(g, sx + 14 + i * 40, this.ry.ap + 40, 34, 14, 3); g.fill(); text(g, b, sx + 31 + i * 40, this.ry.ap + 47, 10, '#111', 'center', 700); });
    knob(g, sx + 400, this.ry.ap + 48, 11);
    unit(this.ry.xpdr, 64, 'BENDIX/KING  KT 76C');
    g.fillStyle = '#050505'; roundRect(g, sx + 14, this.ry.xpdr + 8, 260, 36, 4); g.fill();
    ['IDT', 'VFR', 'ALT', 'ON', 'STBY'].forEach((b, i) => { g.fillStyle = '#cfcfcf'; roundRect(g, sx + 286 + (i % 3) * 46, this.ry.xpdr + 8 + Math.floor(i / 3) * 24, 40, 18, 3); g.fill(); text(g, b, sx + 306 + (i % 3) * 46, this.ry.xpdr + 17 + Math.floor(i / 3) * 24, 10, '#111', 'center', 700); });
  }

  // ---------- hotspots for mouse interaction ----------
  buildHotspots(sim) {
    const f = () => sim.fdm, av = () => sim.av;
    const H = []; const hs = (x, y, w, h, id, click, wheel, tip) => H.push({ x, y, w, h, id, click, wheel, tip });
    // ignition key
    hs(50, 660, 100, 100, 'mags', (b) => { const s = f().sys; s.mags = clamp(s.mags + (b === 2 ? -1 : 1), 0, 4); if (s.mags === 4) sim.startHeld = 1.2; }, (d) => { const s = f().sys; s.mags = clamp(s.mags - Math.sign(d), 0, 3); }, 'Ignition (R-click/scroll down: toward OFF)');
    const sw = [
      ['bat', 'master', 'BAT'], ['alt', 'alternator', 'ALT'], ['fuelPump', 'fuelPump', 'FUEL PUMP'], ['beacon', 'beacon', 'BCN'], ['landing', 'landing', 'LAND'],
      ['taxi', 'taxi', 'TAXI'], ['nav', 'nav', 'NAV'], ['strobe', 'strobe', 'STROBE'], ['pitot', 'pitotHeat', 'PITOT HT'],
    ];
    this.switches = sw.map(([id, key, lab], i) => ({ id, key, lab, x: 200 + i * 54 + (i > 1 ? 20 : 0), y: 712, red: i < 2 }));
    this.switches.push({ id: 'avn1', key: 'avionics', lab: 'BUS 1/2', x: 785, y: 712, red: false });
    for (const s of this.switches) hs(s.x - 18, s.y - 30, 36, 60, s.id, () => { const S = f().sys; S[s.key] = !S[s.key]; sim.sound?.click(); }, null, s.lab);
    hs(1020, 700, 70, 80, 'park', () => { f().ctrl.parkBrake = !f().ctrl.parkBrake; sim.sound?.click(); }, null, 'Parking brake');
    hs(1180, 700, 60, 80, 'panelLt', () => { f().sys.panelLights = !f().sys.panelLights; }, null, 'Panel lights');
    hs(1280, 700, 60, 80, 'cabinLt', () => { f().sys.cabinLights = !f().sys.cabinLights; }, null, 'Cabin lights');
    // flap lever
    for (let i = 0; i < 4; i++) hs(1470, 150 + i * 70, 110, 60, 'flap' + i, () => { f().ctrl.flaps = i; sim.sound?.click(); }, null, 'Flaps ' + ['UP', '10°', '20°', 'FULL'][i]);
    // instruments knobs
    const [ax, ay] = L.alt;
    hs(ax - 100, ay + 58, 44, 44, 'baro', () => { f().kollsman = Math.round(sim.weather.qnhInHg * 100) / 100; }, (d) => { f().kollsman = Math.round(((f().kollsman ?? 29.92) - Math.sign(d) * 0.01) * 100) / 100; }, 'Kollsman (scroll; click = ATIS QNH)');
    const [hx, hy] = L.hi;
    hs(hx - 100, hy + 58, 44, 44, 'hiSet', () => { f().gyro.hiDrift = 0; }, (d) => { f().gyro.hiDrift += Math.sign(d); }, 'HI set (click = align to compass)');
    hs(hx + 56, hy + 58, 44, 44, 'hdgBug', () => { av().hdgBug = Math.round(((f().attitude.hdg - f().gyro.hiDrift) + 360) % 360); }, (d) => { av().hdgBug = (av().hdgBug - Math.sign(d) * (sim.keys.Shift ? 10 : 1) + 360) % 360; }, 'Heading bug (click = sync)');
    for (const k of ['cdi1', 'cdi2']) {
      const [cx, cy] = L[k]; const rx = k === 'cdi1' ? 'nav1' : 'nav2';
      hs(cx - 92, cy + 50, 44, 44, 'obs' + k, () => { const r = av()[k === 'cdi1' ? 'r1' : 'r2']; if (r.valid && r.radial != null) av()[rx].obs = Math.round((r.radial + 180) % 360); }, (d) => { av()[rx].obs = (av()[rx].obs - Math.sign(d) * (sim.keys.Shift ? 10 : 1) + 360) % 360; }, 'OBS (click = center needle TO)');
    }
    // radios
    const [sx] = L.stack;
    for (const [k, rk, ck] of [['nc1', 'nav1', 'com1'], ['nc2', 'nav2', 'com2']]) {
      const y = this.ry[k];
      if (!sim.av[ck]) sim.av[ck] = { active: 121.9, standby: 118.0 };
      hs(sx + 86, y + 62, 40, 24, 'cswap' + k, () => { const c = av()[ck]; [c.active, c.standby] = [c.standby, c.active]; }, null, 'COM flip-flop');
      hs(sx + 302, y + 62, 40, 24, 'nswap' + k, () => { const c = av()[rk]; [c.active, c.standby] = [c.standby, c.active]; }, null, 'NAV flip-flop');
      hs(sx + 160, y + 58, 36, 34, 'comMHz' + k, null, (d) => { const c = av()[ck]; c.standby = wrapF(c.standby - Math.sign(d), 118, 136.975); }, 'COM MHz');
      hs(sx + 196, y + 58, 36, 34, 'comKHz' + k, null, (d) => { const c = av()[ck]; c.standby = wrapK(c.standby, -Math.sign(d) * 0.025, 118, 137); }, 'COM kHz');
      hs(sx + 374, y + 58, 36, 34, 'navMHz' + k, null, (d) => { const c = av()[rk]; c.standby = wrapF(c.standby - Math.sign(d), 108, 117.95); }, 'NAV MHz');
      hs(sx + 410, y + 58, 36, 34, 'navKHz' + k, null, (d) => { const c = av()[rk]; c.standby = wrapK(c.standby, -Math.sign(d) * 0.05, 108, 118); }, 'NAV kHz');
    }
    hs(sx + 380, this.ry.adf + 8, 44, 44, 'adf', null, (d) => { av().adf.freq = clamp(av().adf.freq - Math.sign(d) * (sim.keys.Shift ? 10 : 1), 190, 1799); }, 'ADF frequency');
    this.apBtns.forEach((b, i) => hs(sx + 14 + i * 40, this.ry.ap + 38, 34, 18, 'ap' + b, () => av().apButton(b, f()), null, 'KAP 140 ' + b));
    hs(sx + 384, this.ry.ap + 34, 34, 30, 'apAlt', null, (d) => { av().ap.altSel = clamp(av().ap.altSel - Math.sign(d) * (sim.keys.Shift ? 1000 : 100), 0, 20000); }, 'Altitude preselect');
    for (let i = 0; i < 4; i++) hs(sx + 110 + i * 34, this.ry.xpdr + 8, 32, 36, 'sq' + i, () => { const c = av().xpdr.code.split(''); c[i] = String((+c[i] + 1) % 8); av().xpdr.code = c.join(''); }, (d) => { const c = av().xpdr.code.split(''); c[i] = String((+c[i] - Math.sign(d) + 8) % 8); av().xpdr.code = c.join(''); }, 'Squawk digit');
    ['IDT', 'VFR', 'ALT', 'ON', 'STBY'].forEach((b, i) => hs(sx + 286 + (i % 3) * 46, this.ry.xpdr + 8 + Math.floor(i / 3) * 24, 40, 18, 'x' + b, () => { const x = av().xpdr; if (b === 'IDT') x.ident = 18; else if (b === 'VFR') x.code = '1200'; else x.mode = b; }, null, 'XPDR ' + b));
    this.hot = H;
  }

  hit(u, v) {
    const x = u * PW, y = (1 - v) * PH_;
    for (const h of this.hot) if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
    return null;
  }

  // ---------------- per-frame draw ----------------
  draw(sim, t) {
    const g = this.g, f = sim.fdm, av = sim.av;
    g.drawImage(this.static, 0, 0);
    const att = hprFromQ(f.q);
    const pwr = f.elec, avn = f.avionicsOn;

    // ASI
    { const [x, y] = L.asi; needle(g, x, y, asiAng(clamp(f.ind.ias, 0, 205)), 74, 6); hub(g, x, y); glass(g, x, y, 88); }
    // AI
    this.drawAI(g, f, att);
    // ALT
    {
      const [x, y, R] = L.alt; const a = f.ind.alt;
      // Kollsman window
      g.fillStyle = '#050505'; g.fillRect(x + 30, y - 9, 44, 20);
      text(g, (f.kollsman ?? 29.92).toFixed(2), x + 52, y + 1, 15, '#eee', 'center', 600, LCD);
      // 10k striped flag
      if (a < 10000) { g.save(); g.beginPath(); g.rect(x - 14, y - 52, 28, 10); g.clip(); for (let i = -4; i < 8; i++) { g.fillStyle = i % 2 ? '#eee' : '#d22'; g.beginPath(); g.moveTo(x - 14 + i * 6, y - 42); g.lineTo(x - 8 + i * 6, y - 52); g.lineTo(x - 2 + i * 6, y - 52); g.lineTo(x - 8 + i * 6, y - 42); g.fill(); } g.restore(); }
      needle(g, x, y, (a / 100000) * 360, 80, 3, '#e8e8e8', 6); // 10000s (thin long with triangle)
      g.save(); g.translate(x, y); g.rotate((a / 100000) * 360 * DEG); g.fillStyle = '#eee'; g.beginPath(); g.moveTo(-6, -R + 8); g.lineTo(6, -R + 8); g.lineTo(0, -R + 20); g.fill(); g.restore();
      needle(g, x, y, (a / 10000) * 360, 48, 10, '#e8e8e8', 8);
      needle(g, x, y, (a / 1000) * 360, 76, 6, '#f4f4f4', 14);
      hub(g, x, y); glass(g, x, y, R);
    }
    // TC
    {
      const [x, y, R] = L.tc;
      const spin = f.gyro.tcSpin;
      // turn rate (deg/s) from body yaw + roll rate (canted gyro)
      const yawRate = -(f.omega[1] * Math.cos(att.roll * DEG) - f.omega[2] * Math.sin(att.roll * DEG)) / DEG;
      this.tcRate = (this.tcRate || 0) + ((yawRate + f.omega[0] / DEG * 0.35) * spin - (this.tcRate || 0)) * 0.25;
      const tilt = clamp(this.tcRate / 3 * 20, -40, 40);
      g.save(); g.translate(x, y); g.rotate(tilt * DEG);
      g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 6; g.shadowOffsetY = 4;
      g.fillStyle = '#f2f2f2'; g.fillRect(-66, -3, 132, 6); g.beginPath(); g.arc(0, 0, 10, 0, Math.PI * 2); g.fill(); g.fillRect(-3, -18, 6, 14); g.fillRect(-16, -16, 32, 4);
      g.restore();
      // ball: apparent gravity lateral
      const ay = f.accel[2] / Math.max(1, f.accel[1]);
      this.ball = (this.ball || 0) + (clamp(-ay * 220, -38, 38) - (this.ball || 0)) * 0.18;
      const bg = g.createRadialGradient(x + this.ball - 3, y + 33, 1, x + this.ball, y + 36, 9);
      bg.addColorStop(0, '#555'); bg.addColorStop(1, '#050505');
      g.fillStyle = bg; g.beginPath(); g.arc(x + this.ball, y + 36, 9, 0, Math.PI * 2); g.fill();
      if (spin < 0.6) { g.fillStyle = '#d33'; g.fillRect(x + 30, y - 36, 30, 14); text(g, 'OFF', x + 45, y - 29, 10, '#fff'); }
      glass(g, x, y, R);
    }
    // HI
    {
      const [x, y, R] = L.hi; const hd = (att.hdg - f.gyro.hiDrift + 360) % 360;
      g.save(); g.translate(x, y); g.rotate(-hd * DEG);
      g.fillStyle = '#111'; g.beginPath(); g.arc(0, 0, R - 2, 0, Math.PI * 2); g.fill();
      for (let d = 0; d < 360; d += 5) { const r0 = d % 10 === 0 ? R - 16 : R - 9; g.strokeStyle = '#eee'; g.lineWidth = d % 10 ? 1.3 : 2.2; g.beginPath(); g.moveTo(Math.sin(d * DEG) * r0, -Math.cos(d * DEG) * r0); g.lineTo(Math.sin(d * DEG) * (R - 3), -Math.cos(d * DEG) * (R - 3)); g.stroke(); }
      for (let d = 0; d < 360; d += 30) {
        g.save(); g.rotate(d * DEG);
        text(g, { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] ?? String(d / 10), 0, -R + 30, d % 90 ? 20 : 24, '#f4f4f4');
        g.restore();
      }
      // heading bug
      g.save(); g.rotate(av.hdgBug * DEG); g.fillStyle = '#e8721c'; g.fillRect(-9, -R + 1, 6, 9); g.fillRect(3, -R + 1, 6, 9); g.restore();
      g.restore();
      // fixed aircraft symbol & lubber line
      g.fillStyle = '#e8721c'; g.beginPath(); g.moveTo(x, y - R + 2); g.lineTo(x - 6, y - R - 8 + 2); g.lineTo(x + 6, y - R - 8 + 2); g.fill();
      g.strokeStyle = '#e8721c'; g.lineWidth = 3; g.beginPath(); g.moveTo(x, y - 32); g.lineTo(x, y + 26); g.moveTo(x - 26, y - 4); g.lineTo(x + 26, y - 4); g.moveTo(x - 10, y + 22); g.lineTo(x + 10, y + 22); g.stroke();
      for (let k = 45; k < 360; k += 45) tick(g, x, y, R + 1, R + 6, k, 3, '#e8721c');
      glass(g, x, y, R);
    }
    // VSI
    { const [x, y] = L.vsi; needle(g, x, y, vsiAng(f.ind.vsi), 74, 6); hub(g, x, y); glass(g, x, y, 88); }
    // TACH + hour meter
    {
      const [x, y] = L.tach;
      g.fillStyle = '#050505'; g.fillRect(x - 28, y + 22, 56, 18);
      const hrs = 1234.5 + f.time / 3600 * (f.eng.rpm / 2400);
      text(g, hrs.toFixed(1).padStart(6, '0'), x, y + 31, 14, '#eee', 'center', 500, LCD);
      needle(g, x, y, tachAng(f.eng.rpm), 64, 6); hub(g, x, y); glass(g, x, y, 76);
    }
    // clock
    {
      const [x, y, R] = L.clock; const h = sim.timeOfDay;
      needle(g, x, y, (h % 12) * 30, 34, 5, '#eee', 6); needle(g, x, y, (h * 60 % 60) * 6, 50, 4, '#eee', 6);
      needle(g, x, y, (h * 3600 % 60) * 6, 54, 1.6, '#e33', 10); hub(g, x, y, 5); glass(g, x, y, R);
    }
    // CDIs
    this.drawCDI(g, L.cdi1, av.nav1.obs, av.r1, true, avn);
    this.drawCDI(g, L.cdi2, av.nav2.obs, av.r2, false, avn);
    // ADF
    {
      const [x, y, R] = L.adf; const ndb = sim.ndb;
      let rel = 90;
      if (avn && ndb && Math.abs(av.adf.freq - ndb.freq * 1000) < 1) {
        const brg = (Math.atan2(ndb.x - f.pos[0], -(ndb.z - f.pos[2])) / DEG + 360) % 360;
        rel = brg - att.hdg;
      } else rel = 90 + Math.sin(t * 0.3) * 3;
      this.adfN = (this.adfN ?? 90) + ((((rel - (this.adfN ?? 90)) % 360 + 540) % 360) - 180) * 0.06;
      needle(g, x, y, this.adfN, 58, 6, '#f2c230', 40); hub(g, x, y, 7); glass(g, x, y, R);
    }
    // engine cluster needles
    this.eg.forEach((e, i) => barNeedle(g, 22, 196 + i * 54, 172, f.elec || i >= 4 ? e[5](f) : e[2], e[2], e[3]));
    // annunciators
    {
      const st = [f.eng.oilP < 20, f.sys.fuelL < 5, f.sys.fuelR < 5, f.eng.vac < 3.5, f.elec && f.eng.busV < 25, false];
      const test = this.annTest;
      this.ann.forEach((n, i) => {
        const on = pwr && (st[i] || test);
        g.fillStyle = on ? (i < 3 ? '#ff3b2f' : '#ffc21a') : '#1a1410';
        g.fillRect(226 + i * 92, 80, 86, 22);
        text(g, n, 269 + i * 92, 91, 12, on ? '#200' : '#3a332b', 'center', 700);
      });
    }
    // switches
    for (const s of this.switches) rocker(g, s.x, s.y, !!f.sys[s.key], s.lab, s.red);
    // mag key
    {
      const x = 100, y = 728; g.fillStyle = '#0a0a0a'; g.beginPath(); g.arc(x, y, 26, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#b9b9b9'; g.beginPath(); g.arc(x, y, 19, 0, Math.PI * 2); g.fill();
      const a = [-70, -35, 0, 25, 55][f.sys.mags];
      g.save(); g.translate(x, y); g.rotate(a * DEG); g.fillStyle = '#3e3e3e'; roundRect(g, -6, -26, 12, 52, 4); g.fill(); g.restore();
    }
    // parking brake & lights knobs
    rocker(g, 1050, 732, f.ctrl.parkBrake, f.ctrl.parkBrake ? 'SET' : 'OFF', true);
    rocker(g, 1210, 732, f.sys.panelLights, ''); rocker(g, 1310, 732, f.sys.cabinLights, '');
    // flap lever
    {
      const target = f.ctrl.flaps; const ly = 172 + target * 70;
      g.fillStyle = '#e6e6e6'; roundRect(g, 1478, ly - 10, 38, 20, 4); g.fill();
      // flap position indicator (actual)
      g.fillStyle = '#ffd400'; g.fillRect(1468, 172 + f.flapPos / 30 * 210 - 2, 10, 4);
    }
    // hobbs
    text(g, (812.3 + f.time / 3600).toFixed(1), 1538, 87, 20, '#ddd', 'center', 500, LCD);
    // radios
    this.drawRadios(g, sim, avn, t);
    // OAT digital
    text(g, `OAT ${Math.round(f.ind.oat ?? 15)}°C   ${f.elec ? (f.eng.busV).toFixed(1) + 'V' : ''}`, 1538, 150, 15, '#d3d3d3', 'center', 600, LCD);
    // dim panel when lights off at night (handled by material); flash when AP disconnects
    if (av.ap.discAlert > 0 && Math.floor(t * 4) % 2) { g.fillStyle = 'rgba(255,190,0,0.9)'; g.fillRect(L.stack[0] + 330, this.ry.ap + 8, 80, 28); text(g, 'AP DISC', L.stack[0] + 370, this.ry.ap + 22, 14, '#000', 'center', 700); }
  }

  drawAI(g, f, att) {
    const [x, y, R] = L.ai; const gy = f.gyro;
    const sp = gy.aiSpin;
    let pitch = att.pitch + (gy.aiErrP || 0), roll = att.roll + (gy.aiErrR || 0);
    if (sp < 0.7) { const k = (0.7 - sp) / 0.7; pitch = pitch * (1 - k) - 12 * k; roll = roll * (1 - k) + 25 * k; }
    const ppd = 2.6;
    g.save(); g.beginPath(); g.arc(x, y, R - 1, 0, Math.PI * 2); g.clip();
    g.translate(x, y); g.rotate(-roll * DEG);
    const off = clamp(pitch, -35, 35) * ppd;
    const sky = g.createLinearGradient(0, -R * 2, 0, off); sky.addColorStop(0, '#1d5c9e'); sky.addColorStop(1, '#4a92d8');
    g.fillStyle = sky; g.fillRect(-R * 2, -R * 3, R * 4, R * 3 + off);
    const gnd = g.createLinearGradient(0, off, 0, R * 2); gnd.addColorStop(0, '#7b4f26'); gnd.addColorStop(1, '#3d2610');
    g.fillStyle = gnd; g.fillRect(-R * 2, off, R * 4, R * 3);
    g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(-R * 2, off); g.lineTo(R * 2, off); g.stroke();
    g.lineWidth = 1.8;
    for (const p of [5, 10, 15, 20]) { const w = p % 10 ? 12 : 24; g.beginPath(); g.moveTo(-w, off - p * ppd); g.lineTo(w, off - p * ppd); g.stroke(); g.beginPath(); g.moveTo(-w, off + p * ppd); g.lineTo(w, off + p * ppd); g.stroke(); }
    // ground perspective lines
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    for (const a of [-50, -25, 25, 50]) { g.beginPath(); g.moveTo(0, off); g.lineTo(Math.tan(a * DEG) * 120, off + 120); g.stroke(); }
    // bank scale ring (moves with roll)
    for (const b of [-60, -30, -20, -10, 10, 20, 30, 60, -45, 45]) tick(g, 0, 0, R - (Math.abs(b) % 30 === 0 ? 16 : 10), R - 1, b, 3, '#fff');
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -R + 2); g.lineTo(-7, -R + 14); g.lineTo(7, -R + 14); g.fill();
    for (const b of [-90, 90]) tick(g, 0, 0, R - 16, R - 1, b, 4, '#fff');
    g.restore();
    // fixed bezel shading ring & sky pointer
    g.strokeStyle = '#111'; g.lineWidth = 10; g.beginPath(); g.arc(x, y, R - 4, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#e8721c'; g.beginPath(); g.moveTo(x, y - R + 18); g.lineTo(x - 7, y - R + 30); g.lineTo(x + 7, y - R + 30); g.fill();
    // miniature airplane
    g.save(); g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 5; g.shadowOffsetY = 3;
    g.fillStyle = '#e8721c'; g.fillRect(x - 54, y - 3, 34, 6); g.fillRect(x + 20, y - 3, 34, 6);
    g.beginPath(); g.moveTo(x - 20, y); g.lineTo(x, y + 12); g.lineTo(x + 20, y); g.lineTo(x + 14, y); g.lineTo(x, y + 6); g.lineTo(x - 14, y); g.fill();
    g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill();
    g.restore();
    glass(g, x, y, R);
  }

  drawCDI(g, [x, y, R], obs, r, gs, powered) {
    // rotating OBS card
    g.save(); g.translate(x, y); g.rotate(-obs * DEG);
    for (let d = 0; d < 360; d += 5) { g.strokeStyle = '#ddd'; g.lineWidth = d % 10 ? 1 : 2; const r0 = d % 10 ? R - 7 : R - 12; g.beginPath(); g.moveTo(Math.sin(d * DEG) * r0, -Math.cos(d * DEG) * r0); g.lineTo(Math.sin(d * DEG) * (R - 1), -Math.cos(d * DEG) * (R - 1)); g.stroke(); }
    for (let d = 0; d < 360; d += 30) { g.save(); g.rotate(d * DEG); text(g, { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] ?? String(d / 10), 0, -R + 22, 16, '#f2f2f2'); g.restore(); }
    g.restore();
    g.fillStyle = '#f2f2f2'; g.beginPath(); g.moveTo(x, y - R + 28); g.lineTo(x - 6, y - R + 36); g.lineTo(x + 6, y - R + 36); g.fill();
    // flags
    const v = powered && r && r.valid;
    if (!v) { g.fillStyle = '#d42'; g.fillRect(x - 46, y - 26, 26, 14); text(g, 'NAV', x - 33, y - 19, 10, '#fff', 'center', 700); }
    else { text(g, r.toFrom > 0 ? 'TO' : 'FR', x + 36, y - 16, 13, '#fff', 'center', 700); }
    if (gs && !(powered && r && r.gsValid)) { g.fillStyle = '#d42'; g.fillRect(x + 22, y + 18, 26, 14); text(g, 'GS', x + 35, y + 25, 10, '#fff', 'center', 700); }
    // needles (smoothed)
    const key = gs ? 'n1' : 'n2';
    this[key] = this[key] || { d: 0, g: 0 };
    const tgt = v ? r.dev : 0; this[key].d += (tgt - this[key].d) * 0.12;
    g.save(); g.beginPath(); g.arc(x, y, R - 14, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#f4f4f4'; g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 4; g.shadowOffsetX = 2;
    g.fillRect(x + this[key].d * 55 - 2.5, y - 56, 5, 116);
    if (gs) { const gt = powered && r && r.gsValid ? -r.gsDev : 0; this[key].g += (gt - this[key].g) * 0.12; g.fillRect(x - 56, y + 6 + this[key].g * 50 - 2.5, 116, 5); }
    g.restore();
    glass(g, x, y, R);
  }

  drawRadios(g, sim, avn, t) {
    const [sx] = L.stack, av = sim.av;
    const on = avn;
    const lcd = (s, x, y, size = 30, col = '#ffb233') => { if (on) { g.save(); g.shadowColor = col; g.shadowBlur = 8; text(g, s, x, y, size, col, 'left', 400, LCD); g.restore(); } };
    for (const [k, rk, ck] of [['nc1', 'nav1', 'com1'], ['nc2', 'nav2', 'com2']]) {
      const y = this.ry[k];
      const c = av[ck], n = av[rk];
      lcd(c.active.toFixed(3), sx + 18, y + 34, 25); lcd(c.standby.toFixed(3), sx + 124, y + 35, 18);
      lcd(n.active.toFixed(2), sx + 222, y + 34, 25); lcd(n.standby.toFixed(2), sx + 318, y + 35, 18);
      if (on) { text(g, 'COMM', sx + 22, y + 56, 10, '#d99c2d', 'left'); text(g, 'STBY', sx + 124, y + 56, 10, '#d99c2d', 'left'); text(g, 'NAV', sx + 226, y + 56, 10, '#d99c2d', 'left'); text(g, 'STBY', sx + 318, y + 56, 10, '#d99c2d', 'left'); }
      const r = k === 'nc1' ? av.r1 : av.r2;
      if (on && r?.dme != null && r.valid) lcd(r.dme.toFixed(1) + 'NM', sx + 372, y + 56, 12);
    }
    // ADF
    lcd('ANT  ' + av.adf.freq.toFixed(0).padStart(4, ' '), sx + 24, this.ry.adf + 27, 24);
    // AP display
    if (on) {
      const ap = av.ap; const y = this.ry.ap + 22;
      if (ap.on) {
        lcd('AP', sx + 22, y, 16, '#7dffb0');
        lcd(ap.lat, sx + 60, y, 18, '#7dffb0');
        lcd(ap.vert, sx + 120, y, 18, '#7dffb0');
        if (ap.gsArmed) lcd('GS', sx + 170, y + 1, 12, '#7dffb0');
        if (ap.vert === 'VS') lcd(`VS ${ap.vsSel >= 0 ? '+' : ''}${ap.vsSel}`, sx + 206, y, 16, '#7dffb0');
      }
      lcd(`${ap.altArm ? 'ARM ' : ''}${String(ap.altSel).padStart(5, ' ')}FT`, sx + 300, y, 15, '#7dffb0');
    }
    // XPDR
    {
      const x = av.xpdr; const y = this.ry.xpdr + 27;
      if (x.ident > 0) x.ident -= 0.03;
      lcd(x.mode, sx + 22, y, 16);
      lcd(x.code, sx + 112, y, 26);
      if (x.mode === 'ALT') lcd('FL' + String(Math.max(0, Math.round(sim.fdm.ind.paltitude / 100))).padStart(3, '0'), sx + 186, y, 16);
      if (x.ident > 0 || (x.mode !== 'STBY' && Math.floor(t * 1.3) % 3 === 0)) lcd('R', sx + 250, y - 6, 12);
    }
  }
}

function wrapF(v, lo, hi) { const span = Math.floor(hi) - lo + 1; let mhz = Math.floor(v + 1e-6), khz = v - mhz; mhz = ((mhz - lo) % span + span) % span + lo; return Math.round((mhz + khz) * 1000) / 1000; }
function wrapK(v, dk, lo, hi) { const mhz = Math.floor(v + 1e-6); let k = v - mhz + dk; if (k >= 0.999) k = 0; if (k < -1e-6) k = dk < -0.03 ? 0.95 : 0.975; void lo; void hi; return Math.round((mhz + k) * 1000) / 1000; }
