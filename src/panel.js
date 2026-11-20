// Cessna 172S Skyhawk SP (1998+ steam-gauge) and Cessna 152 instrument panels.
// Layouts follow the Cessna Information Manual panel figures (172S fig. 7-2, 152 fig. 7-2).
// Instruments, radios, switches and breakers are drawn to a canvas used as the panel texture;
// push-pull controls, levers and the ignition key are real 3D meshes mounted on the panel.
// Every control is interactive: left click / right click / mouse wheel (see tooltips).
import * as THREE from 'three';
import { hprFromQ } from './math.js';

export const PW = 2048, PH_ = 1024;
export const PANEL_W = 1.08, PANEL_H = 0.54; // metres; ~1900 px per metre
const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const FONT = 'Barlow Condensed, Barlow, Arial Narrow, sans-serif';
const LCD = '"Share Tech Mono", "JetBrains Mono", monospace';
const now = () => performance.now();

function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

// ---------------------------------------------------------------- drawing primitives
function noiseFill(g, x, y, w, h, base, amt, seed = 1) {
  g.fillStyle = base; g.fillRect(x, y, w, h);
  const id = g.getImageData(x, y, w, h); const d = id.data;
  let s = seed * 9301 + 49297;
  for (let i = 0; i < d.length; i += 4) {
    s = (s * 9301 + 49297) % 233280; const n = (s / 233280 - 0.5) * amt;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(id, x, y);
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function screw(g, x, y, r = 5) {
  const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.35, 0.5, x, y, r);
  gr.addColorStop(0, '#c9ccce'); gr.addColorStop(0.6, '#7b7f82'); gr.addColorStop(1, '#2a2c2e');
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.75)'; g.lineWidth = Math.max(1, r * 0.28);
  const a = ((x * 7 + y * 13) % 314) / 100;
  g.beginPath(); g.moveTo(x - Math.cos(a) * r * 0.75, y - Math.sin(a) * r * 0.75); g.lineTo(x + Math.cos(a) * r * 0.75, y + Math.sin(a) * r * 0.75); g.stroke();
  g.beginPath(); g.moveTo(x - Math.sin(a) * r * 0.75, y + Math.cos(a) * r * 0.75); g.lineTo(x + Math.sin(a) * r * 0.75, y - Math.cos(a) * r * 0.75); g.stroke();
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
// engraved / silk-screened panel lettering
function engrave(g, txt, x, y, size = 13, col = '#ecebe6', align = 'center', weight = 600) {
  g.save(); g.fillStyle = 'rgba(0,0,0,0.55)'; g.font = `${weight} ${size}px ${FONT}`; g.textAlign = align; g.textBaseline = 'middle';
  g.fillText(txt, x + 0.8, y + 0.9); g.fillStyle = col; g.fillText(txt, x, y); g.restore();
}
function needle(g, x, y, a, len, w = 6, col = '#f4f4f4', tail = 14) {
  g.save(); g.translate(x, y); g.rotate(a * DEG);
  g.shadowColor = 'rgba(0,0,0,0.75)'; g.shadowBlur = 5; g.shadowOffsetX = 2.5; g.shadowOffsetY = 3.5;
  g.fillStyle = col; g.beginPath();
  g.moveTo(-w / 2, tail); g.lineTo(-w / 2, -len + w * 1.6); g.lineTo(0, -len); g.lineTo(w / 2, -len + w * 1.6); g.lineTo(w / 2, tail); g.closePath(); g.fill();
  g.restore();
}
function hub(g, x, y, r = 9) {
  const gr = g.createRadialGradient(x - 2, y - 2, 1, x, y, r); gr.addColorStop(0, '#6a6a6a'); gr.addColorStop(1, '#0d0d0d');
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
}
function glass(g, x, y, R) {
  const gr = g.createLinearGradient(x - R, y - R, x + R * 0.5, y + R * 0.5);
  gr.addColorStop(0, 'rgba(255,255,255,0.13)'); gr.addColorStop(0.42, 'rgba(255,255,255,0.025)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fill();
  // curved specular streak
  g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = R * 0.08; g.beginPath(); g.arc(x, y, R * 0.86, 200 * DEG, 250 * DEG); g.stroke();
}
function face(g, x, y, R, c0 = '#1d1e20', c1 = '#0a0a0b') {
  const gr = g.createRadialGradient(x, y - R * 0.3, R * 0.1, x, y, R);
  gr.addColorStop(0, c0); gr.addColorStop(1, c1);
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fill();
}
// knurled round knob (canvas)
function knob(g, x, y, r = 16, col = ['#575859', '#0b0b0c'], ridges = 28) {
  g.save();
  g.fillStyle = 'rgba(0,0,0,0.55)'; g.beginPath(); g.arc(x + r * 0.18, y + r * 0.22, r * 1.05, 0, Math.PI * 2); g.fill();
  const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.4, 1, x, y, r);
  gr.addColorStop(0, col[0]); gr.addColorStop(1, col[1]);
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.8)'; g.lineWidth = Math.max(1, r * 0.06);
  for (let i = 0; i < ridges; i++) { const a = i / ridges * Math.PI * 2; g.beginPath(); g.moveTo(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8); g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); g.stroke(); }
  const top = g.createRadialGradient(x - r * 0.25, y - r * 0.3, 0.5, x, y, r * 0.72);
  top.addColorStop(0, 'rgba(255,255,255,0.22)'); top.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = top; g.beginPath(); g.arc(x, y, r * 0.72, 0, Math.PI * 2); g.fill();
  g.restore();
}
function dualKnob(g, x, y, ro, ri) {
  knob(g, x, y, ro, ['#4b4c4e', '#0a0a0b'], 32);
  g.fillStyle = 'rgba(0,0,0,0.6)'; g.beginPath(); g.arc(x, y, ri + 2.5, 0, Math.PI * 2); g.fill();
  knob(g, x, y, ri, ['#6a6b6d', '#121213'], 22);
}
// pointer line on a knob (shows rotary position)
function knobPointer(g, x, y, r, a, col = '#f2f2f2') {
  g.strokeStyle = col; g.lineWidth = Math.max(2, r * 0.14); g.lineCap = 'round';
  g.beginPath(); g.moveTo(px(x, r * 0.25, a), py(y, r * 0.25, a)); g.lineTo(px(x, r * 0.85, a), py(y, r * 0.85, a)); g.stroke(); g.lineCap = 'butt';
}
// Bendix/King style rectangular push button
function pushBtn(g, x, y, w, h, lab, down = false, opts = {}) {
  g.save();
  g.fillStyle = '#050505'; roundRect(g, x - 1.5, y - 1.5, w + 3, h + 3, 3); g.fill();
  const gr = g.createLinearGradient(x, y, x, y + h);
  const c = opts.dark ? ['#3a3b3d', '#18191a'] : ['#e9e9e6', '#b5b5b1'];
  gr.addColorStop(0, down ? c[1] : c[0]); gr.addColorStop(1, down ? c[0] : c[1]);
  g.fillStyle = gr; roundRect(g, x + (down ? 0.8 : 0), y + (down ? 1.2 : 0), w, h, 2.5); g.fill();
  if (!down) { g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(x + 2, y + 1, w - 4, 1.2); }
  text(g, lab, x + w / 2 + (down ? 0.8 : 0), y + h / 2 + (down ? 1.2 : 0), opts.size || Math.min(11, h * 0.62), opts.dark ? '#e6e6e6' : '#151515', 'center', 700);
  if (opts.led != null) { g.fillStyle = opts.led ? '#5dff7a' : '#14301a'; if (opts.led) { g.shadowColor = '#5dff7a'; g.shadowBlur = 6; } g.fillRect(x + w / 2 - 5, y - 6, 10, 3); }
  g.restore();
}
// rocker switch (Cessna "white rocker" or red master). up = ON.
function rockerFace(g, x, y, w, h, on, col = 'white', down = false) {
  g.save();
  // bezel
  g.fillStyle = '#060606'; roundRect(g, x - w / 2 - 4, y - h / 2 - 4, w + 8, h + 8, 4); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1; roundRect(g, x - w / 2 - 4, y - h / 2 - 4, w + 8, h + 8, 4); g.stroke();
  const base = col === 'red' ? ['#e23a2c', '#9a1a12', '#5a0d08'] : col === 'black' ? ['#4a4b4d', '#2a2b2d', '#101112'] : ['#fbfbf6', '#d7d6cf', '#8f8e88'];
  // the pressed-in half is darker / shadowed, the raised half catches light
  const topIn = on, gTop = g.createLinearGradient(x, y - h / 2, x, y);
  gTop.addColorStop(0, topIn ? base[2] : base[0]); gTop.addColorStop(1, topIn ? base[1] : base[1]);
  const gBot = g.createLinearGradient(x, y, x, y + h / 2);
  gBot.addColorStop(0, topIn ? base[1] : base[1]); gBot.addColorStop(1, topIn ? base[0] : base[2]);
  g.fillStyle = gTop; roundRect(g, x - w / 2, y - h / 2, w, h / 2 + 1, 3); g.fill();
  g.fillStyle = gBot; roundRect(g, x - w / 2, y, w, h / 2, 3); g.fill();
  // ridge line + ribs on raised half
  g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(x - w / 2, y - 0.8, w, 1.6);
  g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 1;
  const r0 = topIn ? y + 5 : y - h / 2 + 5, r1 = topIn ? y + h / 2 - 4 : y - 5;
  for (let yy = r0; yy < r1; yy += 3.2) { g.beginPath(); g.moveTo(x - w / 2 + 3, yy); g.lineTo(x + w / 2 - 3, yy); g.stroke(); }
  // shadow cast by raised half onto the housing
  g.fillStyle = 'rgba(0,0,0,0.35)'; if (topIn) g.fillRect(x - w / 2, y + h / 2 - 3, w, 3); else g.fillRect(x - w / 2, y - h / 2, w, 3);
  if (down) { g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x - w / 2, y - h / 2, w, h); }
  g.restore();
}
// push-to-reset circuit breaker
function breakerFace(g, x, y, amps, pulled, down = false) {
  g.save();
  // hex nut / bezel
  g.fillStyle = '#0a0a0a'; g.beginPath(); for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + Math.PI / 6; g.lineTo(x + Math.cos(a) * 13, y + Math.sin(a) * 13); } g.closePath(); g.fill();
  const ng = g.createRadialGradient(x - 4, y - 4, 1, x, y, 13); ng.addColorStop(0, '#5a5c5f'); ng.addColorStop(1, '#151617');
  g.fillStyle = ng; g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fill();
  if (pulled) {
    // white collar visible when popped / pulled
    g.fillStyle = '#f4f4ef'; g.beginPath(); g.arc(x + 1.5, y + 2, 9.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.arc(x + 3.5, y + 5, 8, 0, Math.PI * 2); g.fill();
  }
  const ox = pulled ? -2.5 : down ? 0.8 : 0, oy = pulled ? -3.5 : down ? 1 : 0;
  const cg = g.createRadialGradient(x + ox - 2.5, y + oy - 3, 0.5, x + ox, y + oy, 8.5); cg.addColorStop(0, '#3e3f41'); cg.addColorStop(1, '#050505');
  g.fillStyle = cg; g.beginPath(); g.arc(x + ox, y + oy, 8.5, 0, Math.PI * 2); g.fill();
  text(g, String(amps), x + ox, y + oy + 0.5, 9.5, '#f1f1f1', 'center', 700);
  g.restore();
}
// 7-segment display (gas-discharge / LED look). y is the top of the digits.
const SEGS = {
  0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
  '-': 'g', '_': 'd', ' ': '', A: 'abcefg', b: 'cdefg', C: 'adef', c: 'deg', d: 'bcdeg', E: 'adefg', F: 'aefg', G: 'acdef', H: 'bcefg', h: 'cefg',
  I: 'bc', J: 'bcde', L: 'def', n: 'ceg', N: 'abcef', o: 'cdeg', O: 'abcdef', P: 'abefg', r: 'eg', S: 'acdfg', t: 'defg', T: 'defg', U: 'bcdef', u: 'cde', y: 'bcdfg', '°': 'abfg',
};
const SEGP = { a: [[0, 0], [1, 0]], b: [[1, 0], [1, 0.5]], c: [[1, 0.5], [1, 1]], d: [[0, 1], [1, 1]], e: [[0, 0.5], [0, 1]], f: [[0, 0], [0, 0.5]], g: [[0, 0.5], [1, 0.5]] };
function seg7(g, str, x, y, h, col, o = {}) {
  const w = o.w ?? h * 0.5, sp = o.sp ?? h * 0.24, th = o.th ?? Math.max(1.4, h * 0.12), sk = o.skew ?? 0.09;
  const cells = [];
  for (const ch of String(str)) { if ((ch === '.' || ch === ':') && cells.length) cells[cells.length - 1].dot = ch; else cells.push({ ch }); }
  const cw = w + sp, total = cells.length * cw - sp;
  const x0 = o.align === 'right' ? x - total : o.align === 'center' ? x - total / 2 : x;
  g.save(); g.lineCap = 'round'; g.lineWidth = th;
  const seg = (cx, s) => {
    const [[ax, ay], [bx, by]] = SEGP[s]; const ins = th * 0.8;
    let X1 = cx + ax * w - ay * h * sk, Y1 = y + ay * h, X2 = cx + bx * w - by * h * sk, Y2 = y + by * h;
    const dx = X2 - X1, dy = Y2 - Y1, L = Math.hypot(dx, dy) || 1;
    X1 += dx / L * ins; Y1 += dy / L * ins; X2 -= dx / L * ins; Y2 -= dy / L * ins;
    g.beginPath(); g.moveTo(X1, Y1); g.lineTo(X2, Y2); g.stroke();
  };
  cells.forEach((c, i) => {
    const cx = x0 + i * cw + h * sk;
    if (o.ghost !== false) { g.shadowBlur = 0; g.strokeStyle = o.ghostCol || 'rgba(255,80,40,0.06)'; for (const s of 'abcdefg') seg(cx, s); }
    if (o.off) return;
    const lit = SEGS[c.ch] ?? '';
    g.strokeStyle = col; if (o.glow !== false) { g.shadowColor = col; g.shadowBlur = h * 0.3; }
    for (const s of lit) seg(cx, s);
    if (c.dot === '.') { g.fillStyle = col; g.beginPath(); g.arc(cx + w + sp * 0.5 - h * sk, y + h - th * 0.2, th * 0.62, 0, 7); g.fill(); }
    if (c.dot === ':') { g.fillStyle = col; for (const yy of [0.3, 0.72]) { g.beginPath(); g.arc(cx + w + sp * 0.5 - h * sk * yy, y + h * yy, th * 0.55, 0, 7); g.fill(); } }
  });
  g.restore();
}
function woodgrain(g, x, y, w, h) {
  noiseFill(g, x, y, w, h, '#5d3d24', 14, 11);
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  let s = 7; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let i = 0; i < 140; i++) {
    const yy = y + rnd() * h, amp = 2 + rnd() * 6, fr = 0.004 + rnd() * 0.01, ph = rnd() * 6;
    g.strokeStyle = `rgba(${rnd() < 0.5 ? '25,12,4' : '120,80,45'},${(0.08 + rnd() * 0.18).toFixed(2)})`; g.lineWidth = 0.6 + rnd() * 2.2;
    g.beginPath(); for (let xx = x; xx <= x + w; xx += 12) g.lineTo(xx, yy + Math.sin(xx * fr + ph) * amp + Math.sin(xx * fr * 3.1) * amp * 0.3); g.stroke();
  }
  const sh = g.createLinearGradient(0, y, 0, y + h); sh.addColorStop(0, 'rgba(255,230,190,0.10)'); sh.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = sh; g.fillRect(x, y, w, h); g.restore();
}
// round instrument recess in the molded panel overlay
function well(g, x, y, R, opts = {}) {
  g.save();
  const o = R + (opts.lip ?? 9);
  const sh = g.createRadialGradient(x + 2, y + 3, R * 0.95, x + 2, y + 3, o + 8);
  sh.addColorStop(0, 'rgba(0,0,0,0.75)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = sh; g.beginPath(); g.arc(x + 2, y + 3, o + 8, 0, Math.PI * 2); g.fill();
  // chamfered lip: light from upper-left
  const lip = g.createLinearGradient(x - o, y - o, x + o, y + o);
  lip.addColorStop(0, opts.lipHi || 'rgba(255,255,255,0.20)'); lip.addColorStop(0.5, 'rgba(0,0,0,0.05)'); lip.addColorStop(1, 'rgba(0,0,0,0.55)');
  g.fillStyle = lip; g.beginPath(); g.arc(x, y, o, 0, Math.PI * 2); g.fill();
  // instrument case bezel (black ring)
  g.fillStyle = '#070707'; g.beginPath(); g.arc(x, y, R + 4, 0, Math.PI * 2); g.fill();
  const ring = g.createLinearGradient(x, y - R, x, y + R); ring.addColorStop(0, '#2c2d2f'); ring.addColorStop(1, '#0c0c0d');
  g.strokeStyle = ring; g.lineWidth = 3; g.beginPath(); g.arc(x, y, R + 2.5, 0, Math.PI * 2); g.stroke();
  if (opts.screws !== false) for (const a of [45, 135, 225, 315]) screw(g, px(x, R + o * 0.12 + 8, a), py(y, R + o * 0.12 + 8, a), 4.2);
  g.restore();
}
function rectWell(g, x, y, w, h, r = 8) {
  g.save();
  g.fillStyle = 'rgba(0,0,0,0.5)'; roundRect(g, x - 4, y - 3, w + 10, h + 10, r + 3); g.fill();
  const lip = g.createLinearGradient(x, y, x + w, y + h); lip.addColorStop(0, 'rgba(255,255,255,0.16)'); lip.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = lip; roundRect(g, x - 5, y - 5, w + 10, h + 10, r + 3); g.fill();
  g.fillStyle = '#080808'; roundRect(g, x - 1, y - 1, w + 2, h + 2, r); g.fill();
  g.restore();
}

// ---------------------------------------------------------------- instrument faces (local: centre 0,0  R = 88)
const asiAng = (v) => v <= 40 ? v * 0.75 : v <= 160 ? 30 + (v - 40) * 2.05 : 276 + (v - 160) * 1.5;
const ASI = {
  C172: { white: [40, 85], green: [48, 129], yellow: [129, 163], red: 163, max: 200 },
  C152: { white: [35, 85], green: [40, 111], yellow: [111, 149], red: 149, max: 160 },
};
function asiFace(g, type) {
  const R = 88, A = ASI[type];
  face(g, 0, 0, R);
  arc(g, 0, 0, R - 12, asiAng(A.white[0]), asiAng(A.white[1]), 7, '#f5f5f5');
  arc(g, 0, 0, R - 5, asiAng(A.green[0]), asiAng(A.green[1]), 7, '#1fa83c');
  arc(g, 0, 0, R - 5, asiAng(A.yellow[0]), asiAng(A.yellow[1]), 7, '#e8c21a');
  tick(g, 0, 0, R - 15, R, asiAng(A.red), 4.5, '#e0241c');
  for (let v = 40; v <= A.max; v += 5) tick(g, 0, 0, R - (v % 10 === 0 ? 15 : 8), R - 1, asiAng(v), v % 10 === 0 ? 2.4 : 1.4);
  for (let v = 40; v <= A.max; v += 20) label(g, 0, 0, R - 31, asiAng(v), String(v), 21);
  for (let m = 60; m <= A.max * 1.15; m += 20) { const kt = m / 1.15078; if (kt > A.max) break; label(g, 0, 0, R - 52, asiAng(kt), String(m), 11, '#a8a8a8', 500); }
  text(g, 'AIRSPEED', 0, 16, 11, '#ddd'); text(g, 'KNOTS', 0, 28, 10, '#bbb'); text(g, 'MPH', 0, -22, 9, '#999');
}
function altFace(g) {
  const R = 88; face(g, 0, 0, R);
  for (let i = 0; i < 50; i++) tick(g, 0, 0, R - (i % 5 === 0 ? 15 : 8), R - 1, i * 7.2, i % 5 === 0 ? 2.6 : 1.4);
  for (let i = 0; i < 10; i++) label(g, 0, 0, R - 30, i * 36, String(i), 26);
  text(g, 'ALT', 0, -30, 13, '#ddd'); text(g, '100 FEET', -2, 44, 10, '#bbb');
  text(g, 'CALIBRATED TO', -30, 22, 6.5, '#999'); text(g, '20,000 FEET', -30, 30, 6.5, '#999');
}
const vsiAng = (fpm) => -90 + clamp(fpm, -2050, 2050) / 2000 * 172 * (Math.abs(fpm) < 500 ? 1.15 : 1) - (Math.abs(fpm) < 500 ? 0 : Math.sign(fpm) * 500 / 2000 * 172 * 0.15);
function vsiFace(g) {
  const R = 88; face(g, 0, 0, R);
  for (let f = -2000; f <= 2000; f += 100) tick(g, 0, 0, R - (f % 500 === 0 ? 15 : 8), R - 1, vsiAng(f), f % 500 === 0 ? 2.6 : 1.4);
  for (const f of [0, 5, 10, 15, 20]) { label(g, 0, 0, R - 30, vsiAng(f * 100), String(f), 22); if (f) label(g, 0, 0, R - 30, vsiAng(-f * 100), String(f), 22); }
  text(g, 'UP', -34, -22, 11); text(g, 'DOWN', -34, 24, 11);
  text(g, 'VERTICAL SPEED', 8, -36, 9, '#bbb'); text(g, '100 FEET PER MIN', 8, 38, 8.5, '#bbb');
}
const tachAng = (r) => -135 + clamp(r, 0, 3500) / 3500 * 270;
const TACH = { C172: { green: [2100, 2700], red: 2700 }, C152: { green: [1900, 2550], red: 2550 } };
function tachFace(g, type) {
  const R = 88, T = TACH[type]; face(g, 0, 0, R);
  arc(g, 0, 0, R - 6, tachAng(T.green[0]), tachAng(T.green[1]), 8, '#1fa83c');
  tick(g, 0, 0, R - 17, R, tachAng(T.red), 4.5, '#e0241c');
  for (let r = 0; r <= 3500; r += 100) tick(g, 0, 0, R - (r % 500 === 0 ? 15 : 8), R - 1, tachAng(r), r % 500 === 0 ? 2.4 : 1.2);
  for (let r = 0; r <= 35; r += 5) label(g, 0, 0, R - 30, tachAng(r * 100), String(r), 21);
  text(g, 'RPM', 0, -28, 13); text(g, 'X100', 0, -14, 10, '#aaa'); text(g, 'HOURS', 0, 54, 8, '#999');
}
function tcFace(g) {
  const R = 88; face(g, 0, 0, R);
  for (const s of [-1, 1]) { tick(g, 0, 0, R - 16, R - 2, s * 70, 4); tick(g, 0, 0, R - 16, R - 2, s * 90, 4); }
  text(g, 'L', -R + 24, 22, 18); text(g, 'R', R - 24, 22, 18);
  text(g, 'TURN COORDINATOR', 0, -44, 11, '#ccc'); text(g, '2 MIN', 0, 60, 11, '#bbb'); text(g, 'NO PITCH', 0, 72, 7.5, '#888'); text(g, 'INFORMATION', 0, 80, 7.5, '#888');
  g.fillStyle = '#d7d3c4'; roundRect(g, -46, 26, 92, 20, 10); g.fill();
  g.strokeStyle = '#111'; g.lineWidth = 2; g.beginPath(); g.moveTo(-11, 26); g.lineTo(-11, 46); g.moveTo(11, 26); g.lineTo(11, 46); g.stroke();
}
function cdiFace(g, gs) {
  const R = 88; face(g, 0, 0, R);
  for (let i = -5; i <= 5; i++) if (i) { g.fillStyle = '#eee'; g.beginPath(); g.arc(i * 11, 6, 2.6, 0, Math.PI * 2); g.fill(); }
  if (gs) for (let i = -5; i <= 5; i++) if (i) { g.fillStyle = '#eee'; g.beginPath(); g.arc(6, i * 10, 2.4, 0, Math.PI * 2); g.fill(); }
  g.strokeStyle = '#eee'; g.lineWidth = 2; g.beginPath(); g.arc(0, 6, 11, 0, Math.PI * 2); g.stroke();
  text(g, gs ? 'VOR / LOC / GS' : 'VOR / LOC', 0, R - 20, 9, '#999');
}
function smallRoundFace(g, title, lo, hi, ranges, labels, sub = '') {
  const R = 88; face(g, 0, 0, R);
  const A = (v) => -120 + (clamp(v, lo, hi) - lo) / (hi - lo) * 240;
  for (const [a, b, c] of ranges) arc(g, 0, 0, R - 10, A(a), A(b), 12, c);
  for (let i = 0; i <= 10; i++) tick(g, 0, 0, R - (i % 5 === 0 ? 24 : 16), R - 2, -120 + i * 24, i % 5 === 0 ? 4 : 2.5);
  labels.forEach(([v, s]) => label(g, 0, 0, R - 42, A(v), s, 24));
  text(g, title, 0, 34, 20, '#ddd'); if (sub) text(g, sub, 0, 56, 15, '#aaa');
}

// ---------------------------------------------------------------- panel
const CB_172_MAIN = [['FLAP', 10], ['INST', 5], ['TURN COORD', 5], ['ALT FLD', 5], ['WARN', 5], ['CABIN LT', 5], ['INST LT', 5], ['FUEL PUMP', 5], ['BCN', 5], ['LAND LT', 15], ['TAXI LT', 10], ['NAV LT', 5], ['STROBE', 5], ['PITOT HT', 10]];
const CB_172_AVN = [['AVN BUS 1', 15], ['AVN BUS 2', 15], ['AUDIO', 5], ['NAV/COM 1', 5], ['NAV/COM 2', 5], ['ADF', 3], ['XPDR', 2], ['AUTOPILOT', 5], ['GPS', 5], ['AVN FAN', 3]];
const CB_152 = [['ALT FLD', 5], ['INST', 5], ['TURN COORD', 5], ['FLAP', 15], ['BCN', 5], ['LAND LT', 15], ['TAXI LT', 10], ['NAV LT', 5], ['STROBE', 5], ['PITOT HT', 10], ['CABIN LT', 5], ['AVN BUS 1', 15], ['AUDIO', 5], ['NAV/COM 1', 5], ['ADF', 3], ['XPDR', 2], ['GPS', 5]];

export class Panel {
  constructor(type = 'C172') {
    this.type = type === 'C152' ? 'C152' : 'C172';
    this.canvas = mk(PW, PH_);
    this.g = this.canvas.getContext('2d');
    this.static = mk(PW, PH_);
    this.hot = []; this.hot3d = []; this.comps = []; this.anims = [];
    this.pressed = {}; this.held = {};
    this.st = { glove: false, clockTop: 0, clockMode: 1, et: 0, etRun: false, apMsg: 0, apMsgTxt: '', annTest: 0, elt: 'ARM' };
    this.layout();
    this.buildStatic();
    if (document.fonts) document.fonts.ready.then(() => this.buildStatic());
  }

  // ---------------- helpers for components
  isDown(id, ms = 170) { return !!this.held[id] || now() - (this.pressed[id] || -1e9) < ms; }
  inst(key) { return this.I[key]; }
  // run fn with origin at an instrument centre scaled so the face radius is 88 local units
  at(g, key, fn) { const [x, y, R] = this.I[key]; g.save(); g.translate(x, y); g.scale(R / 88, R / 88); fn(); g.restore(); }
  ip(key, lx, ly) { const [x, y, R] = this.I[key]; const s = R / 88; return [x + lx * s, y + ly * s, s]; }

  layout() {
    const C172 = this.type === 'C172';
    // instrument centres [x, y, faceRadius] in canvas px (3-1/8" instruments ~ 74 px radius)
    this.I = C172 ? {
      asi: [330, 175, 74], ai: [505, 175, 74], alt: [680, 175, 74], cdi1: [868, 175, 72],
      tc: [330, 355, 74], dg: [505, 355, 74], vsi: [680, 355, 74], cdi2: [868, 355, 72],
      tach: [330, 532, 72], adf: [868, 532, 70],
    } : {
      asi: [215, 165, 70], ai: [385, 165, 70], alt: [640, 165, 70], cdi1: [810, 165, 68],
      tc: [215, 345, 70], dg: [385, 345, 70], vsi: [640, 345, 70], adf: [810, 345, 66],
      tach: [1355, 175, 70],
    };
    this.stack = C172 ? { x: 1000, y: 38, w: 310 } : { x: 940, y: 40, w: 310 };
  }

  // ---------------------------------------------------------------- static artwork
  buildStatic() {
    const g = this.static.getContext('2d');
    g.clearRect(0, 0, PW, PH_);
    if (this.type === 'C172') this.static172(g); else this.static152(g);
    // instruments (shared)
    for (const k of Object.keys(this.I)) { const [x, y, R] = this.I[k]; well(g, x, y, R, this.type === 'C152' ? { lipHi: 'rgba(255,255,255,0.09)' } : {}); }
    this.at(g, 'asi', () => asiFace(g, this.type));
    this.at(g, 'alt', () => altFace(g));
    this.at(g, 'vsi', () => vsiFace(g));
    this.at(g, 'tach', () => tachFace(g, this.type));
    this.at(g, 'tc', () => tcFace(g));
    this.at(g, 'cdi1', () => cdiFace(g, true));
    if (this.I.cdi2) this.at(g, 'cdi2', () => cdiFace(g, false));
    // instrument knobs
    const kb = (key, lx, ly, r = 15, lab = '') => { const [x, y, s] = this.ip(key, lx, ly); knob(g, x, y, r * s * 1.05); if (lab) engrave(g, lab, x, y + r * s + 9, 9, '#cfcfcf'); };
    kb('alt', -76, 76, 15, 'BARO'); kb('dg', -76, 76, 15, 'PUSH'); kb('dg', 76, 76, 15, 'HDG');
    { const [x, y] = this.ip('dg', 76, 76); g.fillStyle = '#e8721c'; g.fillRect(x - 3, y - 3, 6, 6); }
    kb('ai', 0, 82, 12); kb('cdi1', -72, 72, 15, 'OBS'); if (this.I.cdi2) kb('cdi2', -72, 72, 15, 'OBS'); kb('adf', -72, 72, 14, 'HDG');
    if (this.type === 'C172') this.radioStatic(g, 'C172'); else this.radioStatic(g, 'C152');
    for (const c of this.comps) c.st?.(g);
  }

  static172(g) {
    // textured grey panel and moulded overlays (1998+ Skyhawk SP)
    noiseFill(g, 0, 0, PW, PH_, '#3e4144', 13, 3);
    const overlay = (x, y, w, h, r, shade = 0) => {
      g.save(); g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 14; g.shadowOffsetY = 5;
      g.fillStyle = shade ? '#383b3e' : '#474a4e'; roundRect(g, x, y, w, h, r); g.fill(); g.restore();
      const hl = g.createLinearGradient(0, y, 0, y + h); hl.addColorStop(0, 'rgba(255,255,255,0.07)'); hl.addColorStop(1, 'rgba(0,0,0,0.12)');
      g.fillStyle = hl; roundRect(g, x, y, w, h, r); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.09)'; g.lineWidth = 1.5; roundRect(g, x + 1, y + 1, w - 2, h - 2, r); g.stroke();
    };
    overlay(14, 14, 968, 628, 30);           // pilot instrument panel
    overlay(14, 654, 968, 360, 18, 1);       // lower switch / breaker panel
    overlay(1336, 14, 698, 1000, 26);        // copilot side
    // crinkle texture on overlays
    { const id = g.getImageData(0, 0, PW, PH_); const d = id.data; let s = 5; for (let i = 0; i < d.length; i += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; const n = ((s >> 16) & 255) / 255 - 0.5; d[i] += n * 9; d[i + 1] += n * 9; d[i + 2] += n * 9; } g.putImageData(id, 0, 0); }
    // radio stack bay
    g.fillStyle = '#0b0c0d'; roundRect(g, this.stack.x - 10, this.stack.y - 12, this.stack.w + 20, 660, 6); g.fill();
    for (let i = 0; i < 11; i++) screw(g, this.stack.x - 4, this.stack.y + 20 + i * 62, 3.4), screw(g, this.stack.x + this.stack.w + 4, this.stack.y + 20 + i * 62, 3.4);
    // lower centre (below stack) engine control area
    g.fillStyle = '#2f3134'; roundRect(g, 992, 694, 330, 320, 10); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 1.5; roundRect(g, 993, 695, 328, 318, 10); g.stroke();
    // placards
    g.fillStyle = '#0d0d0d'; roundRect(g, 74, 30, 140, 24, 3); g.fill(); engrave(g, 'N172SP', 144, 42, 15, '#e8e8e8', 'center', 700);
    engrave(g, 'MANEUVERING SPEED  105 KIAS', 610, 30, 10.5, '#d8d8d2');
    engrave(g, 'THIS AIRPLANE IS APPROVED FOR DAY-NIGHT VFR / IFR', 1690, 40, 10.5, '#d8d8d2');
    // annunciator bezel area
    g.fillStyle = '#070707'; roundRect(g, 410, 52, 380, 34, 4); g.fill();
    // yoke shaft bushing (pilot side) & copilot
    for (const xx of [493, 1555]) { const gr = g.createRadialGradient(xx, 610, 6, xx, 610, 40); gr.addColorStop(0, '#000'); gr.addColorStop(0.6, '#0b0b0b'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.beginPath(); g.arc(xx, 610, 40, 0, Math.PI * 2); g.fill(); }
    // copilot side: data plate, fuel placard
    g.fillStyle = '#b9b6ad'; roundRect(g, 1660, 150, 260, 56, 4); g.fill(); text(g, 'CESSNA  172S  SKYHAWK SP', 1790, 166, 13, '#1a1a1a', 'center', 700); text(g, 'FUEL: 100LL / 100 MIN GRADE AVIATION GASOLINE', 1790, 186, 9.5, '#222', 'center', 600);
    text(g, 'TOTAL CAPACITY 56.0 U.S. GAL   USABLE 53.0', 1790, 199, 9.5, '#222', 'center', 600);
    g.fillStyle = '#d7d4cb'; roundRect(g, 1690, 250, 200, 44, 3); g.fill(); text(g, 'NO SMOKING', 1790, 263, 14, '#b11', 'center', 800); text(g, 'FASTEN SEAT BELTS', 1790, 282, 11, '#222', 'center', 700);
  }

  static152(g) {
    // black upper panel + woodgrain lower subpanel (Cessna 152)
    noiseFill(g, 0, 0, PW, 482, '#17181a', 9, 4);
    { const sh = g.createLinearGradient(0, 0, 0, 482); sh.addColorStop(0, 'rgba(255,255,255,0.05)'); sh.addColorStop(1, 'rgba(0,0,0,0.25)'); g.fillStyle = sh; g.fillRect(0, 0, PW, 482); }
    woodgrain(g, 0, 490, PW, PH_ - 490);
    // chrome trim between panels
    const tr = g.createLinearGradient(0, 480, 0, 492); tr.addColorStop(0, '#aaa'); tr.addColorStop(0.5, '#eee'); tr.addColorStop(1, '#555');
    g.fillStyle = tr; g.fillRect(0, 480, PW, 10);
    g.fillStyle = '#0c0c0c'; roundRect(g, this.stack.x - 10, this.stack.y - 12, this.stack.w + 20, 450, 6); g.fill();
    engrave(g, 'N152AB', 520, 40, 16, '#eee', 'center', 700);
    engrave(g, 'MANEUVERING SPEED  104 KIAS', 270, 34, 10.5, '#ddd');
    g.fillStyle = '#c8c4b8'; roundRect(g, 1660, 330, 260, 52, 3); g.fill(); text(g, 'CESSNA  152', 1790, 346, 14, '#222', 'center', 800); text(g, 'NO INTENTIONAL SPINS — UTILITY CATEGORY', 1790, 366, 9.5, '#222', 'center', 600);
    for (const xx of [493, 1555]) { const gr = g.createRadialGradient(xx, 610, 6, xx, 610, 36); gr.addColorStop(0, '#000'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.beginPath(); g.arc(xx, 610, 36, 0, Math.PI * 2); g.fill(); }
  }

  // ---------------------------------------------------------------- radios: static faces
  radioStatic(g, type) {
    const { x: sx, w: sw } = this.stack;
    const unit = (y, h, brand, model) => {
      const gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, '#2c2d30'); gr.addColorStop(1, '#151618');
      g.fillStyle = gr; roundRect(g, sx, y, sw, h, 3); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 1; roundRect(g, sx + 0.5, y + 0.5, sw - 1, h - 1, 3); g.stroke();
      g.strokeStyle = '#000'; g.lineWidth = 1.5; roundRect(g, sx, y, sw, h, 3); g.stroke();
      screw(g, sx + 6, y + h / 2, 2.8); screw(g, sx + sw - 6, y + h / 2, 2.8);
      text(g, brand, sx + sw - 14, y + h - 7, 7.5, '#9aa0a6', 'right', 700); text(g, model, sx + sw - 14, y + 7, 8, '#c4c8cc', 'right', 700);
    };
    const disp = (x, y, w, h) => { g.fillStyle = '#030303'; roundRect(g, x, y, w, h, 3); g.fill(); const gl = g.createLinearGradient(0, y, 0, y + h); gl.addColorStop(0, 'rgba(120,40,30,0.18)'); gl.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gl; roundRect(g, x, y, w, h, 3); g.fill(); };
    const R = this.R = {};
    let y = this.stack.y;
    // KMA 26 audio panel
    R.kma = y; unit(y, 62, '', ''); text(g, 'KMA 26', sx + 236, y + 55, 7.5, '#c4c8cc', 'right', 700); y += 70;
    R.gps = y; y += 102; if (type === 'C172') { R.nc1 = y; y += 128; R.nc2 = y; y += 128; } else { R.nc1 = y; y += 128; }
    const pitch = type === 'C172' ? 72 : 68; R.adf = y; y += pitch; R.xpdr = y; y += pitch; if (type === 'C172') { R.ap = y; y += 72; }
    for (const k of type === 'C172' ? ['nc1', 'nc2'] : ['nc1']) {
      const yy = R[k]; unit(yy, 120, 'BENDIX/KING', 'KX 155A  NAV/COMM');
      disp(sx + 14, yy + 10, 136, 50); disp(sx + 160, yy + 10, 136, 50);
      text(g, 'COMM', sx + 20, yy + 66, 8, '#c7c7c7', 'left', 700); text(g, 'NAV', sx + 166, yy + 66, 8, '#c7c7c7', 'left', 700);
      text(g, 'PULL TEST', sx + 26, yy + 113, 6.5, '#9a9a9a'); text(g, 'PULL IDENT', sx + 178, yy + 113, 6.5, '#9a9a9a');
      text(g, 'PULL 25K', sx + 118, yy + 113, 6.5, '#9a9a9a');
    }
    if (R.gps != null) { // KLN 94 colour GPS
      const y = R.gps; unit(y, 96, '', '');
      text(g, 'BENDIX/KING', sx + 283, y + 6, 6, '#9aa0a6', 'center', 700); text(g, 'KLN 94', sx + 22, y + 90, 7.5, '#c4c8cc', 'center', 700);
      g.fillStyle = '#020305'; roundRect(g, sx + 42, y + 4, 218, 66, 3); g.fill();
      text(g, 'BRT', sx + 22, y + 27, 6, '#bbb'); text(g, 'RANGE', sx + 22, y + 52, 6, '#bbb'); text(g, 'PAGE', sx + 284, y + 90, 6, '#bbb');
    }
    unit(R.adf, 64, 'BENDIX/KING', 'KR 87  ADF'); disp(sx + 14, R.adf + 8, 200, 30);
    unit(R.xpdr, 64, 'BENDIX/KING', 'KT 76C'); disp(sx + 62, R.xpdr + 8, 150, 30);
    { // transponder mode knob legend
      const kx = sx + 30, ky = R.xpdr + 34;
      ['OFF', 'SBY', 'TST', 'ON', 'ALT'].forEach((m, i) => label(g, kx, ky, 24, -80 + i * 40, m, 7, '#cfcfcf', 700));
    }
    if (R.ap != null) { unit(R.ap, 64, 'BENDIX/KING', 'KAP 140'); g.fillStyle = '#16180f'; roundRect(g, sx + 14, R.ap + 6, 214, 28, 3); g.fill(); }
    // KMA 26 static bits
    { const yy = R.kma; for (const [i, c, l] of [[0, '#2a64ff', 'O'], [1, '#ffb400', 'M'], [2, '#f4f4f4', 'A']]) { g.fillStyle = '#060606'; g.beginPath(); g.arc(sx + 22 + i * 22, yy + 22, 9, 0, 7); g.fill(); text(g, l, sx + 22 + i * 22, yy + 40, 7.5, '#bbb'); void c; }
      text(g, 'TEST  HI  LO', sx + 44, yy + 52, 6.5, '#9a9a9a'); text(g, 'MIC', sx + 284, yy + 54, 7, '#bbb');
      ['1', '2', '3', 'TEL'].forEach((m, i) => label(g, sx + 284, yy + 28, 20, -60 + i * 40, m, 7, '#cfcfcf', 700));
    }
  }

  // ---------------------------------------------------------------- hotspots
  buildHotspots(sim) {
    this.sim = sim;
    const H = this.hot = [];
    const f = () => sim.fdm, av = () => sim.av;
    // add(shape, id, {click, wheel, down, up, tip})
    const add = (shape, id, h) => {
      const click = h.click; const self = this;
      H.push({ ...shape, id, ...h, click: click ? (b) => { self.pressed[id] = now(); click(b); } : null });
    };
    this.add = add;
    const rect = (x, y, w, h) => ({ x, y, w, h });
    const circ = (cx, cy, r, r0 = 0) => ({ cx, cy, r, r0 });
    const step = (b) => (b === 2 ? -1 : 1);
    const S = () => f().sys;

    // ---- instrument knobs
    { const [x, y, s] = this.ip('alt', -76, 76); add(circ(x, y, 18 * s + 4), 'baro', { click: (b) => { f().kollsman = b === 2 ? 29.92 : Math.round(sim.weather.qnhInHg * 100) / 100; }, wheel: (d) => { f().kollsman = Math.round(((f().kollsman ?? 29.92) - Math.sign(d) * 0.01) * 100) / 100; }, tip: () => `Altimeter setting ${(f().kollsman ?? 29.92).toFixed(2)} inHg — scroll to set, click = current QNH, right-click = 29.92` }); }
    { const [x, y, s] = this.ip('dg', -76, 76); add(circ(x, y, 18 * s + 4), 'dgSet', { click: () => { f().gyro.hiDrift = ((f().attitude.hdg - f().gyro.compass + 540) % 360) - 180; }, wheel: (d) => { f().gyro.hiDrift += Math.sign(d); }, tip: 'Heading indicator set knob — scroll to turn the card, click = align with magnetic compass' }); }
    { const [x, y, s] = this.ip('dg', 76, 76); add(circ(x, y, 18 * s + 4), 'hdgBug', { click: () => { av().hdgBug = Math.round(((f().attitude.hdg - f().gyro.hiDrift) + 360) % 360); }, wheel: (d) => { av().hdgBug = (av().hdgBug - Math.sign(d) * (sim.keys.Shift ? 10 : 1) + 360) % 360; }, tip: () => `Heading bug ${String(Math.round(av().hdgBug)).padStart(3, '0')}° — scroll to set, click = sync to current heading` }); }
    { const [x, y, s] = this.ip('ai', 0, 82); add(circ(x, y, 15 * s + 4), 'aiAdj', { click: (b) => { av().aiBias = b === 2 ? 0 : clamp((av().aiBias || 0) + 1, -6, 6); }, wheel: (d) => { av().aiBias = clamp((av().aiBias || 0) - Math.sign(d) * 0.5, -6, 6); }, tip: () => `Attitude indicator miniature airplane adjust (${(av().aiBias || 0).toFixed(1)}°) — scroll, right-click = reset` }); }
    for (const [k, rx] of [['cdi1', 'nav1'], ['cdi2', 'nav2']]) {
      if (!this.I[k]) continue;
      const [x, y, s] = this.ip(k, -72, 72);
      add(circ(x, y, 18 * s + 4), 'obs' + k, { click: () => { const r = av()[k === 'cdi1' ? 'r1' : 'r2']; if (r.valid && r.radial != null) av()[rx].obs = Math.round((r.radial + 180) % 360); }, wheel: (d) => { av()[rx].obs = (av()[rx].obs - Math.sign(d) * (sim.keys.Shift ? 10 : 1) + 360) % 360; }, tip: () => `${k === 'cdi1' ? 'NAV 1' : 'NAV 2'} OBS ${String(av()[rx].obs).padStart(3, '0')}° — scroll to set, click = centre needle (TO)` });
    }
    { const [x, y, s] = this.ip('adf', -72, 72); add(circ(x, y, 17 * s + 4), 'adfCard', { click: () => { av().adfCard = Math.round(((f().attitude.hdg) + 360) % 360); }, wheel: (d) => { av().adfCard = ((av().adfCard || 0) - Math.sign(d) * 5 + 360) % 360; }, tip: () => `ADF compass card ${String(Math.round(av().adfCard || 0)).padStart(3, '0')} — scroll to rotate, click = set to heading` }); }

    // ---- radios
    this.radioHot(add, rect, circ, sim, step);
    // ---- components (switches, breakers, clock, etc.)
    for (const c of this.comps) c.hot?.(add, sim);
  }

  hit(u, v) {
    const x = u * PW, y = (1 - v) * PH_;
    for (const h of this.hot) {
      if (h.r != null) { const d = Math.hypot(x - h.cx, y - h.cy); if (d <= h.r && d >= (h.r0 || 0)) return h; }
      else if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
    }
    return null;
  }

  // ---------------------------------------------------------------- radios: hotspots
  radioHot(add, rect, circ, sim, step) {
    const av = () => sim.av, f = () => sim.fdm, R = this.R, { x: sx } = this.stack;
    const wrapF = (v, d, lo, hi) => { const mhz = Math.floor(v + 1e-6), k = v - mhz; let m = mhz + d; const span = hi - lo + 1; m = ((m - lo) % span + span) % span + lo; return Math.round((m + k) * 1000) / 1000; };
    const wrapK = (v, dk, top) => { const mhz = Math.floor(v + 1e-6); let k = Math.round((v - mhz) * 1000) + dk; if (k >= 1000) k -= 1000; if (k < 0) k += 1000; if (k > top) k = dk > 0 ? 0 : top; return Math.round((mhz + k / 1000) * 1000) / 1000; };
    if (R.gps != null) { // KLN 94
      const y = R.gps, G = () => av().gps, F = () => f();
      const PAGES = ['NAV', 'MAP', 'FPL', 'NRST', 'ALT'];
      const go = (pg) => { const g = G(); if (g.page !== pg) g.prev = g.page; g.page = pg; };
      add(circ(sx + 22, y + 14, 10), 'gpsPwr', { click: () => { const g = G(); g.on = !g.on; if (g.on) g.test = 3; }, wheel: (d) => { const g = G(); g.bright = clamp(g.bright - Math.sign(d) * 0.1, 0.2, 1); }, tip: () => `GPS power / brightness — ${G().on ? 'ON' : 'OFF'} (click = power, scroll = brightness)` });
      add(rect(sx + 6, y + 34, 32, 11), 'gpsCrsrL', { click: () => { const g = G(); g.declutter = !g.declutter; }, tip: () => `Left CRSR — map declutter (${G().declutter ? 'VORs hidden' : 'all waypoints'})` });
      add(circ(sx + 22, y + 71, 13), 'gpsRange', { click: (b) => { const g = G(), r = [2, 5, 10, 20, 40, 80]; g.range = r[clamp(r.indexOf(g.range) + step(b), 0, 5)]; }, wheel: (d) => { const g = G(), r = [2, 5, 10, 20, 40, 80]; g.range = r[clamp(r.indexOf(g.range) + Math.sign(d), 0, 5)]; }, tip: () => `Map range ${G().range} NM — click = zoom out, right-click = zoom in, scroll` });
      const btn = (i, n, fn, tip) => add(rect(sx + 44 + i * 31, y + 74, 28, 15), 'gps' + n, { click: fn, tip });
      btn(0, 'MSG', () => { const g = G(); if (g.page === 'MSG') { g.page = g.prev || 'NAV'; g.msgs = []; } else { go('MSG'); g.msgNew = false; } }, () => `MSG — ${G().msgs.length ? G().msgs.length + ' message(s)' : 'no messages'}`);
      btn(1, 'OBS', () => { const g = G(); g.mode = g.mode === 'OBS' ? 'LEG' : 'OBS'; }, () => `OBS — ${G().mode} mode (OBS: course set with the NAV 1 OBS knob)`);
      btn(2, 'ALT', () => { const g = G(); if (g.page === 'ALT') g.page = g.prev || 'NAV'; else go('ALT'); }, 'ALT — altitude / baro page');
      btn(3, 'NRST', () => { const g = G(); go('NRST'); g.sel = 0; g.cursor = true; }, 'NRST — nearest airports');
      btn(4, 'D→', () => { const g = G(); const list = g.list || []; const fw = g.page === 'FPL' && g.fpl.length ? g.fpl[g.fplActive ? g.leg : 0] : null; let w = fw ? list.find((x) => x.ident === fw.ident) : g.page === 'NRST' && g.nrst?.[g.sel] ? g.nrst[g.sel] : g.wpt ? list.find((x) => x.ident === g.wpt.ident) : list.find((x) => x.type === 'APT'); go('DTO'); g.dtoSel = Math.max(0, list.indexOf(w)); }, 'Direct-To — pick a waypoint, then ENT');
      btn(5, 'CLR', () => { const g = G(); if (g.page === 'FPL' && g.cursor) { g.fpl.pop(); if (!g.fpl.length) g.fplActive = false; else if (g.fplActive && g.leg >= g.fpl.length) { g.leg = g.fpl.length - 1; g.wpt = { ...g.fpl[g.leg] }; } return; } if (g.page === 'DTO') g.page = g.prev || 'NAV'; else { g.page = 'NAV'; } g.cursor = false; }, () => (G().page === 'FPL' && G().cursor ? 'CLR — delete last flight plan waypoint' : 'CLR — cancel / back to NAV page'));
      btn(6, 'ENT', () => { const g = G(); if (g.page === 'FPL') { const c = g.list?.[g.fplSel]; if (g.cursor && c) { if (g.fpl.length < 9 && g.fpl[g.fpl.length - 1]?.ident !== c.ident) g.fpl.push({ ident: c.ident, name: c.name, x: c.x, z: c.z, type: c.type }); } else av().gpsActivate(F()); return; } if (g.page === 'DTO') av().gpsDirect(g.list?.[g.dtoSel], F()); else if (g.page === 'NRST' && g.cursor && g.nrst?.[g.sel]) { const w = g.nrst[g.sel]; go('DTO'); g.dtoSel = Math.max(0, (g.list || []).indexOf(w)); } }, 'ENT — confirm (activates Direct-To)');
      add(rect(sx + 266, y + 13, 34, 13), 'gpsCrsrR', { click: () => { const g = G(); g.cursor = !g.cursor; }, tip: () => `Right CRSR — cursor ${G().cursor ? 'ON' : 'OFF'}` });
      const inner = (dir) => { const g = G(); if (g.page === 'FPL') { if (g.cursor) g.fplSel = clamp(g.fplSel + dir, 0, Math.max(0, (g.list?.length || 1) - 1)); return; } if (g.page === 'DTO') g.dtoSel = clamp(g.dtoSel + dir, 0, Math.max(0, (g.list?.length || 1) - 1)); else if (g.page === 'NRST') g.sel = clamp(g.sel + dir, 0, Math.max(0, (g.nrst?.length || 1) - 1)); else if (g.page === 'MAP') { const r = [2, 5, 10, 20, 40, 80]; g.range = r[clamp(r.indexOf(g.range) + dir, 0, 5)]; } else if (g.page === 'ALT') g.baro = Math.round((g.baro + dir * 0.01) * 100) / 100; else if (g.page === 'NAV') g.navSub = !g.navSub; };
      const outer = (dir) => { const g = G(); const i = PAGES.indexOf(g.page); go(PAGES[((i < 0 ? 0 : i) + dir + PAGES.length) % PAGES.length]); };
      add(circ(sx + 284, y + 58, 10), 'gpsInner', { click: (b) => inner(step(b)), wheel: (d) => inner(Math.sign(d)), tip: 'Right inner knob — select (waypoint / list / range / baro)' });
      add(circ(sx + 284, y + 58, 19, 10), 'gpsOuter', { click: (b) => outer(step(b)), wheel: (d) => outer(Math.sign(d)), tip: () => `Right outer knob — page (${G().page})` });
    }
    // KMA 26
    {
      const y = R.kma, a = () => av().audio;
      const rx = ['COM1', 'COM2', 'COM3', 'NAV1', 'NAV2', 'DME', 'ADF', 'MKR', 'SPKR'];
      this.kmaBtns = rx.map((n, i) => ({ n, x: sx + 84 + i * 21.5, y: y + 10 }));
      for (const b of this.kmaBtns) add(rect(b.x, b.y, 19, 16), 'kma' + b.n, { click: () => { a().rx[b.n] = !a().rx[b.n]; }, tip: () => `Audio panel ${b.n} receive — ${a().rx[b.n] ? 'ON' : 'OFF'}` });
      add(circ(sx + 22 + 22, y + 22, 34), 'kmaMkr', { click: (b) => { const m = ['HI', 'LO', 'TEST']; const i = m.indexOf(a().mkrSens); a().mkrSens = m[(i + step(b) + 3) % 3]; }, tip: () => `Marker beacon sensitivity ${a().mkrSens} (TEST lights all three)` });
      add(circ(sx + 284, y + 28, 14), 'kmaMic', { click: (b) => { a().mic = ((a().mic - 1 + step(b) + 4) % 4) + 1; }, wheel: (d) => { a().mic = ((a().mic - 1 - Math.sign(d) + 4) % 4) + 1; }, tip: () => `Mic selector: ${['COM 1', 'COM 2', 'COM 3', 'TEL'][a().mic - 1]} — you transmit on this radio` });
      add(circ(sx + 84 + 9 * 21.5 + 14, y + 44, 11), 'kmaPwr', { click: () => { a().on = !a().on; }, wheel: (d) => { a().vol = clamp((a().vol ?? 0.8) - Math.sign(d) * 0.05, 0, 1); }, tip: () => `Audio panel power / ICS volume — ${a().on ? 'ON' : 'OFF'}` });
    }
    // KX 155A nav/coms
    for (const [k, ck, nk, n] of [['nc1', 'com1', 'nav1', 1], ['nc2', 'com2', 'nav2', 2]]) {
      const y = R[k]; if (y == null) continue;
      add(rect(sx + 104, y + 70, 30, 16), 'cflip' + n, { click: () => { const c = av()[ck]; [c.active, c.standby] = [c.standby, c.active]; }, tip: `COM ${n} transfer (flip-flop)` });
      add(rect(sx + 250, y + 70, 30, 16), 'nflip' + n, { click: () => { const c = av()[nk]; [c.active, c.standby] = [c.standby, c.active]; }, tip: `NAV ${n} transfer (flip-flop)` });
      add(circ(sx + 26, y + 96, 12), 'cvol' + n, { click: (b) => { const c = av()[ck]; if (b === 2) c.sq = !c.sq; else c.on = !c.on; }, wheel: (d) => { const c = av()[ck]; c.vol = clamp((c.vol ?? 0.8) - Math.sign(d) * 0.05, 0, 1); }, tip: () => `COM ${n} power/volume — ${av()[ck].on ? 'ON' : 'OFF'} (click = power, right-click = pull test squelch, scroll = volume)` });
      add(circ(sx + 118, y + 96, 13), 'ckhz' + n, { click: (b) => { const c = av()[ck]; c.standby = wrapK(c.standby, step(b) * 25, 975); }, wheel: (d) => { const c = av()[ck]; c.standby = wrapK(c.standby, -Math.sign(d) * 25, 975); }, tip: `COM ${n} kHz (inner knob) — scroll / click / right-click` });
      add(circ(sx + 118, y + 96, 22, 13), 'cmhz' + n, { click: (b) => { const c = av()[ck]; c.standby = wrapF(c.standby, step(b), 118, 136); }, wheel: (d) => { const c = av()[ck]; c.standby = wrapF(c.standby, -Math.sign(d), 118, 136); }, tip: `COM ${n} MHz (outer knob) — scroll / click / right-click` });
      add(circ(sx + 178, y + 96, 12), 'nvol' + n, { click: (b) => { const c = av()[nk]; if (b === 2 || true) c.ident = !c.ident; }, wheel: (d) => { const c = av()[nk]; c.vol = clamp((c.vol ?? 0.8) - Math.sign(d) * 0.05, 0, 1); }, tip: () => `NAV ${n} volume — click = pull IDENT (${av()[nk].ident ? 'IDENT shown' : 'off'})` });
      add(circ(sx + 264, y + 96, 13), 'nkhz' + n, { click: (b) => { const c = av()[nk]; c.standby = wrapK(c.standby, step(b) * 50, 950); }, wheel: (d) => { const c = av()[nk]; c.standby = wrapK(c.standby, -Math.sign(d) * 50, 950); }, tip: `NAV ${n} kHz (inner knob)` });
      add(circ(sx + 264, y + 96, 22, 13), 'nmhz' + n, { click: (b) => { const c = av()[nk]; c.standby = wrapF(c.standby, step(b), 108, 117); }, wheel: (d) => { const c = av()[nk]; c.standby = wrapF(c.standby, -Math.sign(d), 108, 117); }, tip: `NAV ${n} MHz (outer knob)` });
    }
    // KR 87 ADF
    {
      const y = R.adf, A = () => av().adf;
      this.krBtns = ['ADF', 'BFO', 'FRQ', 'FLT/ET', 'SET/RST'].map((n, i) => ({ n, x: sx + 14 + i * 40, y: y + 44 }));
      for (const b of this.krBtns) add(rect(b.x, b.y, 36, 14), 'kr' + b.n, {
        click: () => {
          const a = A();
          if (b.n === 'ADF') a.mode = a.mode === 'ADF' ? 'ANT' : 'ADF';
          if (b.n === 'BFO') a.bfo = !a.bfo;
          if (b.n === 'FRQ') { if (a.timer === 'FRQ') [a.freq, a.standby] = [a.standby, a.freq]; else a.timer = 'FRQ'; }
          if (b.n === 'FLT/ET') a.timer = a.timer === 'FLT' ? 'ET' : 'FLT';
          if (b.n === 'SET/RST') { if (a.timer === 'ET') a.et = 0; }
        }, tip: `KR 87 ${b.n}`,
      });
      add(circ(sx + 236, y + 52, 10), 'krPwr', { click: () => { A().on = !A().on; }, wheel: (d) => { A().vol = clamp((A().vol ?? 0.7) - Math.sign(d) * 0.05, 0, 1); }, tip: () => `ADF power/volume — ${A().on ? 'ON' : 'OFF'}` });
      add(circ(sx + 276, y + 34, 11), 'krIn', { click: (b) => { A().standby = clamp(A().standby + step(b) * (sim.keys.Shift ? 10 : 1), 200, 1799); }, wheel: (d) => { A().standby = clamp(A().standby - Math.sign(d) * (sim.keys.Shift ? 10 : 1), 200, 1799); }, tip: 'ADF standby kHz (inner knob: 1 kHz, Shift = 10)' });
      add(circ(sx + 276, y + 34, 21, 11), 'krOut', { click: (b) => { A().standby = clamp(A().standby + step(b) * 100, 200, 1799); }, wheel: (d) => { A().standby = clamp(A().standby - Math.sign(d) * 100, 200, 1799); }, tip: 'ADF standby 100 kHz (outer knob)' });
    }
    // KT 76C transponder
    {
      const y = R.xpdr, X = () => av().xpdr;
      const modes = ['OFF', 'SBY', 'TST', 'ON', 'ALT'];
      add(circ(sx + 30, y + 34, 18), 'xMode', { click: (b) => { const i = modes.indexOf(X().mode); X().mode = modes[clamp(i + step(b), 0, 4)]; }, wheel: (d) => { const i = modes.indexOf(X().mode); X().mode = modes[clamp(i - Math.sign(d), 0, 4)]; }, tip: () => `Transponder mode ${X().mode} — click/right-click/scroll` });
      this.xBtns = [];
      for (let i = 0; i < 8; i++) this.xBtns.push({ n: String(i), x: sx + 62 + i * 19, y: y + 44, w: 16 });
      this.xBtns.push({ n: 'IDT', x: sx + 222, y: y + 9, w: 28 }, { n: 'VFR', x: sx + 222, y: y + 27, w: 28 }, { n: 'CLR', x: sx + 222, y: y + 45, w: 28 });
      for (const b of this.xBtns) add(rect(b.x, b.y, b.w, 14), 'x' + b.n, {
        click: () => {
          const x = X();
          if (b.n === 'IDT') { if (x.mode === 'ON' || x.mode === 'ALT') x.ident = 18; return; }
          if (b.n === 'VFR') { if (x.code === '1200') x.code = x.prev || '1200'; else { x.prev = x.code; x.code = '1200'; } x.entry = ''; return; }
          if (b.n === 'CLR') { x.entry = x.entry.slice(0, -1); return; }
          x.entry = (x.entry || '') + b.n; x.entryT = 4;
          if (x.entry.length === 4) { x.prev = x.code; x.code = x.entry; x.entry = ''; }
        }, tip: b.n.length === 1 ? `Squawk digit ${b.n}` : `Transponder ${b.n}`,
      });
    }
    // KAP 140 autopilot
    if (R.ap != null) {
      const y = R.ap;
      this.apBtns = ['AP', 'HDG', 'NAV', 'APR', 'REV', 'ALT', 'DN', 'UP'].map((n, i) => ({ n, x: sx + 14 + i * 27, y: y + 42 }));
      for (const b of this.apBtns) add(rect(b.x, b.y, 24, 15), 'ap' + b.n, { click: () => { if (!f().eff?.ap) return; av().apButton(b.n, f()); if (b.n === 'UP' || b.n === 'DN') { this.st.apMsg = 3; } }, tip: `KAP 140 ${b.n}` });
      add(rect(sx + 236, y + 6, 26, 13), 'apARM', { click: () => { if (f().eff?.ap) av().apButton('ARM', f()); }, tip: 'KAP 140 ARM (altitude preselect arm)' });
      add(rect(sx + 236, y + 22, 26, 13), 'apBARO', { click: () => { this.st.apBaro = 3; }, tip: 'KAP 140 BARO (show baro setting)' });
      add(circ(sx + 285, y + 38, 11), 'apIn', { wheel: (d) => { av().ap.altSel = clamp(av().ap.altSel - Math.sign(d) * 100, 0, 20000); }, click: (b) => { av().ap.altSel = clamp(av().ap.altSel + step(b) * 100, 0, 20000); }, tip: () => `Altitude select ${av().ap.altSel} ft (inner: 100 ft)` });
      add(circ(sx + 285, y + 38, 21, 11), 'apOut', { wheel: (d) => { av().ap.altSel = clamp(av().ap.altSel - Math.sign(d) * 1000, 0, 20000); }, click: (b) => { av().ap.altSel = clamp(av().ap.altSel + step(b) * 1000, 0, 20000); }, tip: () => `Altitude select ${av().ap.altSel} ft (outer: 1000 ft)` });
    }
  }

  // ---------------------------------------------------------------- 3D controls
  // Builds push-pull knobs, levers and the ignition key as children of the panel mesh.
  attach(aircraft, sim) {
    this.sim = sim;
    const parts = aircraft.userData.parts; const panel = parts.panel; if (!panel) return;
    this.hot3d = []; this.anims = [];
    const P = (x, y, z = 0) => new THREE.Vector3((x / PW - 0.5) * PANEL_W, (0.5 - y / PH_) * PANEL_H, z);
    const std = (color, rough = 0.5, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    const chrome = std(0xd8d8d8, 0.18, 1), blackKnob = std(0x101010, 0.42), satin = std(0x1b1b1b, 0.7);
    const hotMesh = (obj, def) => { obj.userData.hot = def; this.hot3d.push(obj); return obj; };
    const lathe = (pts, seg = 28) => { const g = new THREE.LatheGeometry(pts.map(([r, z]) => new THREE.Vector2(r, z)), seg); g.rotateX(Math.PI / 2); return g; }; // axis -> +z
    const f = () => sim.fdm;
    // generic push-pull control: knob pulled out by `out()` (0..1) * travel
    const pushPull = ({ x, y, knobGeo, mat, shaftR = 0.004, travel = 0.07, out, hot, extra }) => {
      const grp = new THREE.Group(); grp.position.copy(P(x, y, 0)); panel.add(grp);
      // panel bushing
      const bush = new THREE.Mesh(lathe([[0, 0], [shaftR * 2.6, 0], [shaftR * 2.6, 0.004], [shaftR * 1.3, 0.006], [0, 0.006]], 20), chrome); grp.add(bush);
      const mov = new THREE.Group(); grp.add(mov);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, travel + 0.01, 12).rotateX(Math.PI / 2), chrome);
      shaft.position.z = -(travel + 0.01) / 2 + 0.004; mov.add(shaft);
      const k = new THREE.Mesh(knobGeo, mat); k.position.z = 0.006; mov.add(k); k.castShadow = false;
      if (extra) extra(mov);
      hotMesh(mov, hot);
      this.anims.push((dt) => { const z = clamp(out(), 0, 1) * travel; mov.position.z += (z - mov.position.z) * Math.min(1, dt * 14); });
      return mov;
    };
    const ribbed = (r, len, ribs = 18) => { // ribbed cylinder knob (mixture / carb heat style)
      const pts = []; pts.push([0, 0]); pts.push([r * 0.72, 0]); pts.push([r, len * 0.12]); pts.push([r, len * 0.85]); pts.push([r * 0.86, len]); pts.push([0, len]);
      const g = lathe(pts, 40);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) { const X = pos.getX(i), Y = pos.getY(i); const rr = Math.hypot(X, Y); if (rr > r * 0.95) { const a = Math.atan2(Y, X); const k = 1 + 0.06 * Math.cos(a * ribs); pos.setXY(i, X * k, Y * k); } }
      g.computeVertexNormals(); return g;
    };
    const smooth = (r, len) => lathe([[0, 0], [r * 0.55, 0], [r * 0.95, len * 0.2], [r, len * 0.55], [r * 0.9, len * 0.92], [r * 0.6, len], [0, len]], 36);
    const tee = (w, r) => { const g = new THREE.CylinderGeometry(r, r, w, 16); g.rotateZ(Math.PI / 2); g.translate(0, 0, r * 1.5); return g; };
    const C172 = this.type === 'C172';
    const ctl = (k) => f().ctrl[k], sys = (k) => f().sys[k];
    const step = (b) => (b === 2 ? -1 : 1);

    // throttle (black, large) & mixture (red, ribbed, with lock button)
    const thrPos = C172 ? [1100, 874] : [1110, 800], mixPos = C172 ? [1232, 874] : [1232, 800];
    pushPull({
      x: thrPos[0], y: thrPos[1], knobGeo: smooth(C172 ? 0.0195 : 0.016, 0.03), mat: blackKnob, shaftR: 0.0045, travel: 0.085,
      out: () => 1 - ctl('throttle'),
      hot: { id: 'throttle', click: (b) => { f().ctrl.throttle = clamp(ctl('throttle') + step(b) * 0.1, 0, 1); }, wheel: (d) => { f().ctrl.throttle = clamp(ctl('throttle') - Math.sign(d) * 0.02, 0, 1); }, tip: () => `THROTTLE ${Math.round(ctl('throttle') * 100)}% — click = push in, right-click = pull out, scroll = fine` },
      extra: C172 ? null : null,
    });
    // throttle friction lock collar
    { const fr = new THREE.Mesh(ribbed(0.009, 0.008, 22), satin); fr.position.copy(P(thrPos[0], thrPos[1], 0.004)); panel.add(fr); }
    pushPull({
      x: mixPos[0], y: mixPos[1], knobGeo: ribbed(0.016, 0.026, 20), mat: std(0xb3171a, 0.45), shaftR: 0.004, travel: 0.08,
      out: () => 1 - ctl('mixture'),
      hot: { id: 'mixture', click: (b) => { f().ctrl.mixture = clamp(ctl('mixture') + step(b) * 0.1, 0, 1); }, wheel: (d) => { f().ctrl.mixture = clamp(ctl('mixture') - Math.sign(d) * 0.02, 0, 1); }, tip: () => `MIXTURE ${ctl('mixture') < 0.02 ? 'IDLE CUTOFF' : ctl('mixture') > 0.98 ? 'FULL RICH' : Math.round(ctl('mixture') * 100) + '%'} — click = richen, right-click = lean, scroll = vernier` },
      extra: (m) => { const lk = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.006, 16).rotateX(Math.PI / 2), std(0x1a1a1a, 0.4)); lk.position.z = 0.0335; m.add(lk); },
    });
    if (C172) {
      // alternate static air (small black knob)
      pushPull({ x: 1166, y: 746, knobGeo: smooth(0.008, 0.012), mat: blackKnob, shaftR: 0.0025, travel: 0.025, out: () => (sys('altStatic') ? 1 : 0), hot: { id: 'altStatic', click: () => { f().sys.altStatic = !sys('altStatic'); }, tip: () => `ALTERNATE STATIC AIR — ${sys('altStatic') ? 'OPEN (pulled)' : 'CLOSED'}` } });
      // cabin heat / cabin air
      pushPull({ x: 1720, y: 800, knobGeo: smooth(0.011, 0.016), mat: std(0x8a1d14, 0.5), shaftR: 0.003, travel: 0.05, out: () => sys('cabinHeat') || 0, hot: { id: 'cabinHeat', click: (b) => { f().sys.cabinHeat = clamp((sys('cabinHeat') || 0) + step(b) * 0.25, 0, 1); }, wheel: (d) => { f().sys.cabinHeat = clamp((sys('cabinHeat') || 0) - Math.sign(d) * 0.1, 0, 1); }, tip: () => `CABIN HEAT ${Math.round((sys('cabinHeat') || 0) * 100)}% — pull for heat` } });
      pushPull({ x: 1850, y: 800, knobGeo: smooth(0.011, 0.016), mat: std(0x1f3f86, 0.5), shaftR: 0.003, travel: 0.05, out: () => sys('cabinAir') || 0, hot: { id: 'cabinAir', click: (b) => { f().sys.cabinAir = clamp((sys('cabinAir') || 0) + step(b) * 0.25, 0, 1); }, wheel: (d) => { f().sys.cabinAir = clamp((sys('cabinAir') || 0) - Math.sign(d) * 0.1, 0, 1); }, tip: () => `CABIN AIR ${Math.round((sys('cabinAir') || 0) * 100)}% — pull for fresh air` } });
    } else {
      // carburettor heat, primer, cabin heat / air
      pushPull({ x: 1000, y: 800, knobGeo: ribbed(0.013, 0.02, 16), mat: std(0x2b2b2b, 0.5), shaftR: 0.0035, travel: 0.045, out: () => (sys('carbHeat') ? 1 : 0), hot: { id: 'carbHeat', click: () => { f().sys.carbHeat = !sys('carbHeat'); }, tip: () => `CARB HEAT — ${sys('carbHeat') ? 'ON (pulled, expect ~75 rpm drop)' : 'OFF (in)'}` } });
      const pr = pushPull({ x: 70, y: 760, knobGeo: smooth(0.011, 0.016), mat: chrome, shaftR: 0.003, travel: 0.04, out: () => this.st.primerOut || 0, hot: { id: 'primer', click: (b) => { if (b === 2) { f().sys.primer = 0; return; } f().sys.primer = (sys('primer') || 0) + 1; this.st.primerT = 0.5; }, tip: () => `PRIMER — ${sys('primer') || 0} stroke(s). Click = one prime stroke (2–6 for a cold start); right-click = reset count` } });
      void pr;
      this.anims.push((dt) => { if (this.st.primerT > 0) { this.st.primerT -= dt; this.st.primerOut = this.st.primerT > 0.25 ? 1 : 0; } else this.st.primerOut = 0; });
      pushPull({ x: 1720, y: 800, knobGeo: smooth(0.011, 0.016), mat: std(0x7a1a12, 0.5), shaftR: 0.003, travel: 0.05, out: () => sys('cabinHeat') || 0, hot: { id: 'cabinHeat', click: (b) => { f().sys.cabinHeat = clamp((sys('cabinHeat') || 0) + step(b) * 0.25, 0, 1); }, tip: () => `CABIN HT ${Math.round((sys('cabinHeat') || 0) * 100)}%` } });
      pushPull({ x: 1850, y: 800, knobGeo: smooth(0.011, 0.016), mat: std(0x2a2a2a, 0.5), shaftR: 0.003, travel: 0.05, out: () => sys('cabinAir') || 0, hot: { id: 'cabinAir', click: (b) => { f().sys.cabinAir = clamp((sys('cabinAir') || 0) + step(b) * 0.25, 0, 1); }, tip: () => `CABIN AIR ${Math.round((sys('cabinAir') || 0) * 100)}%` } });
    }
    // parking brake T-handle (below the panel, pilot side)
    {
      const pb = pushPull({ x: 250, y: 1002, knobGeo: tee(0.07, 0.007), mat: std(0x161616, 0.45), shaftR: 0.0045, travel: 0.06, out: () => (ctl('parkBrake') ? 1 : 0), hot: { id: 'parkBrake', click: () => { f().ctrl.parkBrake = !ctl('parkBrake'); }, tip: () => `PARKING BRAKE — ${ctl('parkBrake') ? 'SET (pulled & rotated)' : 'RELEASED'}` } });
      this.anims.push(() => { pb.rotation.z += ((ctl('parkBrake') ? Math.PI / 2 : 0) - pb.rotation.z) * 0.2; });
    }
    // ignition key
    {
      const [kx, ky] = C172 ? [85, 852] : [215, 790];
      const grp = new THREE.Group(); grp.position.copy(P(kx, ky, 0)); panel.add(grp);
      const cyl = new THREE.Mesh(lathe([[0, 0], [0.013, 0], [0.013, 0.004], [0.011, 0.007], [0, 0.007]], 32), chrome); grp.add(cyl);
      const slot = new THREE.Mesh(new THREE.BoxGeometry(0.0025, 0.012, 0.002), std(0x050505, 0.9)); slot.position.z = 0.0072; grp.add(slot);
      const key = new THREE.Group(); grp.add(key);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.010, 0.016), chrome); blade.position.z = 0.012; key.add(blade);
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.0125, 0.0125, 0.004, 24).rotateX(Math.PI / 2), std(0x111111, 0.4)); head.scale.set(0.7, 1.15, 1); head.position.set(0, 0.0, 0.024); key.add(head);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.009, 0.0012, 8, 24), chrome); ring.position.set(0, 0.024, 0.024); key.add(ring);
      const ang = [-75, -40, -10, 25, 60];
      this.anims.push(() => { const a = -ang[clamp(sys('mags') | 0, 0, 4)] * DEG; key.rotation.z += (a - key.rotation.z) * 0.3; });
      const def = {
        id: 'ignition',
        down: (b) => { const s = f().sys; if (b === 2) { s.mags = clamp((s.mags === 4 ? 3 : s.mags) - 1, 0, 3); return; } if (s.mags < 3) s.mags++; else { s.mags = 4; sim.startHeld = 99; } },
        up: () => { if (f().sys.mags === 4) sim.startHeld = 0; },
        tip: () => `IGNITION ${['OFF', 'R', 'L', 'BOTH', 'START'][f().sys.mags]} — click to turn right; at BOTH press & HOLD for START; right-click turns left`,
      };
      hotMesh(key, def); hotMesh(cyl, def);
    }
    // flap selector lever (white) in its slot
    {
      const [fx, fy0] = C172 ? [1384, 640] : [1330, 690];
      const lev = new THREE.Group(); lev.position.copy(P(fx, fy0, 0)); panel.add(lev);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.006, 0.03), chrome); arm.position.z = 0.015; lev.add(arm);
      const hnd = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.014, 0.012), std(0xf2f2ec, 0.45)); hnd.position.z = 0.032; lev.add(hnd);
      const det = C172 ? [640, 685, 730, 775] : [690, 735, 780, 825];
      this.anims.push(() => { const y = P(fx, det[clamp(ctl('flaps') | 0, 0, 3)]).y; lev.position.y += (y - lev.position.y) * 0.25; });
      hotMesh(lev, { id: 'flapLever', click: (b) => { const uv = sim.panelUV, h = uv && this.hit(uv.x, uv.y); if (b !== 2 && h && /^flapDet\d$/.test(h.id)) { h.click(0); return; } f().ctrl.flaps = clamp((ctl('flaps') | 0) + step(b), 0, 3); }, wheel: (d) => { f().ctrl.flaps = clamp((ctl('flaps') | 0) + Math.sign(d), 0, 3); }, tip: () => `WING FLAPS lever ${['UP', '10°', '20°', 'FULL 30°'][ctl('flaps') | 0]} (actual ${Math.round(f().flapPos)}°) — click = next notch down, right-click = up` });
    }
    // fuel shutoff (172S: red knob on the pedestal) — handled with the pedestal parts
    if (parts.fuelShutoff && !C172) { parts.fuelShutoff.visible = false; parts.fuelShutoff = null; }
    if (parts.fuelShutoff) hotMesh(parts.fuelShutoff, { id: 'fuelShutoff', click: () => { f().sys.fuelShutoff = !(sys('fuelShutoff') !== false); }, tip: () => `FUEL SHUTOFF — ${sys('fuelShutoff') !== false ? 'ON (pushed in)' : 'OFF (pulled)'}` });
    if (parts.fuelShutoff) this.anims.push(() => { const z = sys('fuelShutoff') !== false ? 0 : 0.028; const m = parts.fuelShutoff; m.position.x += ((m.userData.baseX - z) - m.position.x) * 0.25; });
    // fuel selector valve & trim wheel (built with the cabin)
    if (parts.fuelSel) hotMesh(parts.fuelSel, C172 ? {
      id: 'fuelSel', click: (b) => { const o = ['LEFT', 'BOTH', 'RIGHT']; const i = Math.max(0, o.indexOf(sys('fuelSel'))); f().sys.fuelSel = o[clamp(i + step(b), 0, 2)]; }, tip: () => `FUEL SELECTOR ${sys('fuelSel')} — click = turn right, right-click = turn left`,
    } : {
      id: 'fuelSel', click: () => { f().sys.fuelSel = sys('fuelSel') === 'OFF' ? 'BOTH' : 'OFF'; }, tip: () => `FUEL SHUTOFF VALVE ${sys('fuelSel') === 'OFF' ? 'OFF' : 'ON'} — click to toggle`,
    });
    if (parts.trimWheel) hotMesh(parts.trimWheel, { id: 'trim', click: (b) => { f().ctrl.trim = clamp(ctl('trim') + (b === 2 ? -0.05 : 0.05), -1, 1); }, wheel: (d) => { f().ctrl.trim = clamp(ctl('trim') - Math.sign(d) * 0.02, -1, 1); }, tip: () => `ELEVATOR TRIM ${ctl('trim') > 0.02 ? 'NOSE UP' : ctl('trim') < -0.02 ? 'NOSE DOWN' : 'TAKEOFF'} (${Math.round(ctl('trim') * 100)}) — scroll / click = nose up, right-click = nose down` });
  }

  animate(dt) { for (const a of this.anims) a(dt); }

  // ---------------------------------------------------------------- per-frame draw
  draw(sim, t) {
    const g = this.g, f = sim.fdm, av = sim.av;
    const E = f.eff || {};
    g.drawImage(this.static, 0, 0);
    const att = hprFromQ(f.q);
    const dt = Math.min(0.2, Math.max(0, t - (this.lastT ?? t))); this.lastT = t;
    const ctx = { sim, f, av, E, t, dt, att };
    this.drawInstruments(g, ctx);
    this.drawRadios(g, ctx);
    for (const c of this.comps) c.dyn?.(g, ctx);
  }

  drawInstruments(g, { f, av, t, att, E, sim }) {
    const T = this.type;
    // ASI
    this.at(g, 'asi', () => { needle(g, 0, 0, asiAng(clamp(f.ind.ias, 0, ASI[T].max + 5)), 74, 6); hub(g, 0, 0); glass(g, 0, 0, 88); });
    // AI
    this.at(g, 'ai', () => this.drawAI(g, f, att, av.aiBias || 0));
    // ALT
    this.at(g, 'alt', () => {
      const R = 88, a = f.ind.alt;
      g.fillStyle = '#050505'; g.fillRect(14, -9, 40, 19);
      text(g, (f.kollsman ?? 29.92).toFixed(2), 34, 1, 13, '#eee', 'center', 600, LCD);
      if (a < 10000) { g.save(); g.beginPath(); g.rect(-14, -54, 28, 10); g.clip(); for (let i = -4; i < 8; i++) { g.fillStyle = i % 2 ? '#eee' : '#d22'; g.beginPath(); g.moveTo(-14 + i * 6, -44); g.lineTo(-8 + i * 6, -54); g.lineTo(-2 + i * 6, -54); g.lineTo(-8 + i * 6, -44); g.fill(); } g.restore(); }
      needle(g, 0, 0, (a / 100000) * 360, 80, 3, '#e8e8e8', 6);
      g.save(); g.rotate((a / 100000) * 360 * DEG); g.fillStyle = '#eee'; g.beginPath(); g.moveTo(-6, -R + 8); g.lineTo(6, -R + 8); g.lineTo(0, -R + 20); g.fill(); g.restore();
      needle(g, 0, 0, (a / 10000) * 360, 48, 10, '#e8e8e8', 8);
      needle(g, 0, 0, (a / 1000) * 360, 76, 6, '#f4f4f4', 14);
      hub(g, 0, 0); glass(g, 0, 0, R);
    });
    // TC
    this.at(g, 'tc', () => {
      const spin = f.gyro.tcSpin;
      const yawRate = -(f.omega[1] * Math.cos(att.roll * DEG) - f.omega[2] * Math.sin(att.roll * DEG)) / DEG;
      this.tcRate = (this.tcRate || 0) + ((yawRate + f.omega[0] / DEG * 0.35) * spin - (this.tcRate || 0)) * 0.25;
      const tilt = clamp(this.tcRate / 3 * 20, -40, 40);
      g.save(); g.rotate(tilt * DEG);
      g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 6; g.shadowOffsetY = 4;
      g.fillStyle = '#f2f2f2'; g.fillRect(-66, -3, 132, 6); g.beginPath(); g.arc(0, 0, 10, 0, Math.PI * 2); g.fill(); g.fillRect(-3, -18, 6, 14); g.fillRect(-16, -16, 32, 4);
      g.restore();
      const ay = f.accel[2] / Math.max(1, f.accel[1]);
      this.ball = (this.ball || 0) + (clamp(-ay * 220, -38, 38) - (this.ball || 0)) * 0.18;
      const bg = g.createRadialGradient(this.ball - 3, 33, 1, this.ball, 36, 9); bg.addColorStop(0, '#555'); bg.addColorStop(1, '#050505');
      g.fillStyle = bg; g.beginPath(); g.arc(this.ball, 36, 9, 0, Math.PI * 2); g.fill();
      if (spin < 0.6) { g.fillStyle = '#d33'; g.fillRect(30, -36, 30, 14); text(g, 'OFF', 45, -29, 10, '#fff'); }
      glass(g, 0, 0, 88);
    });
    // DG
    this.at(g, 'dg', () => {
      const R = 88, hd = (att.hdg - f.gyro.hiDrift + 360) % 360;
      g.save(); g.rotate(-hd * DEG);
      g.fillStyle = '#111'; g.beginPath(); g.arc(0, 0, R - 2, 0, Math.PI * 2); g.fill();
      for (let d = 0; d < 360; d += 5) { const r0 = d % 10 === 0 ? R - 16 : R - 9; g.strokeStyle = '#eee'; g.lineWidth = d % 10 ? 1.3 : 2.2; g.beginPath(); g.moveTo(Math.sin(d * DEG) * r0, -Math.cos(d * DEG) * r0); g.lineTo(Math.sin(d * DEG) * (R - 3), -Math.cos(d * DEG) * (R - 3)); g.stroke(); }
      for (let d = 0; d < 360; d += 30) { g.save(); g.rotate(d * DEG); text(g, { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] ?? String(d / 10), 0, -R + 30, d % 90 ? 20 : 24, '#f4f4f4'); g.restore(); }
      g.save(); g.rotate(av.hdgBug * DEG); g.fillStyle = '#e8721c'; g.fillRect(-9, -R + 1, 6, 9); g.fillRect(3, -R + 1, 6, 9); g.restore();
      g.restore();
      g.fillStyle = '#e8721c'; g.beginPath(); g.moveTo(0, -R + 2); g.lineTo(-6, -R - 6); g.lineTo(6, -R - 6); g.fill();
      g.strokeStyle = '#e8721c'; g.lineWidth = 3; g.beginPath(); g.moveTo(0, -32); g.lineTo(0, 26); g.moveTo(-26, -4); g.lineTo(26, -4); g.moveTo(-10, 22); g.lineTo(10, 22); g.stroke();
      for (let k = 45; k < 360; k += 45) tick(g, 0, 0, R + 1, R + 6, k, 3, '#e8721c');
      glass(g, 0, 0, R);
    });
    // VSI
    this.at(g, 'vsi', () => { needle(g, 0, 0, vsiAng(f.ind.vsi), 74, 6); hub(g, 0, 0); glass(g, 0, 0, 88); });
    // TACH + recording hour meter
    this.at(g, 'tach', () => {
      g.fillStyle = '#050505'; g.fillRect(-30, 24, 60, 18);
      const hrs = 1234.5 + f.time / 3600 * (f.eng.rpm / 2400);
      text(g, hrs.toFixed(1).padStart(6, '0'), 0, 33, 14, '#eee', 'center', 500, LCD);
      needle(g, 0, 0, tachAng(f.eng.rpm), 66, 6); hub(g, 0, 0); glass(g, 0, 0, 88);
    });
    // CDIs
    { const gpsSrc = this.R.gps != null && av.gps.src === 'GPS'; this.at(g, 'cdi1', () => this.drawCDI(g, av.nav1.obs, gpsSrc ? av.gpsR : av.r1, !gpsSrc, gpsSrc ? !!E.gps && av.gps.on : !!E.com1 && av.com1.on !== false, 'n1', gpsSrc)); }
    if (this.I.cdi2) this.at(g, 'cdi2', () => this.drawCDI(g, av.nav2.obs, av.r2, false, !!E.com2 && av.com2.on !== false, 'n2'));
    // ADF with rotatable card
    this.at(g, 'adf', () => {
      const R = 88, card = av.adfCard || 0; face(g, 0, 0, R);
      g.save(); g.rotate(-card * DEG);
      for (let i = 0; i < 72; i++) tick(g, 0, 0, R - (i % 6 === 0 ? 13 : i % 2 === 0 ? 8 : 5), R - 1, i * 5, i % 6 === 0 ? 2.2 : 1.1);
      for (let i = 0; i < 12; i++) { g.save(); g.rotate(i * 30 * DEG); text(g, ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'][i], 0, -R + 26, i % 3 === 0 ? 18 : 15, '#f2f2f2'); g.restore(); }
      g.restore();
      g.fillStyle = '#f2f2f2'; g.beginPath(); g.moveTo(0, -R + 36); g.lineTo(-6, -R + 46); g.lineTo(6, -R + 46); g.fill();
      text(g, 'ADF', 0, 30, 11, '#bbb');
      const ndb = sim.ndb, A = av.adf;
      let rel = 90 + Math.sin(t * 0.3) * 3;
      const ok = E.adf && A.on !== false && A.mode === 'ADF' && ndb && Math.abs(A.freq - ndb.freq * 1000) < 1;
      if (ok) { const brg = (Math.atan2(ndb.x - f.pos[0], -(ndb.z - f.pos[2])) / DEG + 360) % 360; rel = brg - att.hdg; }
      this.adfN = (this.adfN ?? 90) + ((((rel - (this.adfN ?? 90)) % 360 + 540) % 360) - 180) * 0.06;
      needle(g, 0, 0, this.adfN, 62, 6, '#f2c230', 44); hub(g, 0, 0, 7); glass(g, 0, 0, R);
    });
  }

  drawAI(g, f, att, bias) {
    const R = 88; const gy = f.gyro, sp = gy.aiSpin;
    let pitch = att.pitch + (gy.aiErrP || 0) - bias, roll = att.roll + (gy.aiErrR || 0);
    if (sp < 0.7) { const k = (0.7 - sp) / 0.7; pitch = pitch * (1 - k) - 12 * k; roll = roll * (1 - k) + 25 * k; }
    const ppd = 2.6;
    g.save(); g.beginPath(); g.arc(0, 0, R - 1, 0, Math.PI * 2); g.clip();
    g.rotate(-roll * DEG);
    const off = clamp(pitch, -35, 35) * ppd;
    const sky = g.createLinearGradient(0, -R * 2, 0, off); sky.addColorStop(0, '#1d5c9e'); sky.addColorStop(1, '#4a92d8');
    g.fillStyle = sky; g.fillRect(-R * 2, -R * 3, R * 4, R * 3 + off);
    const gnd = g.createLinearGradient(0, off, 0, R * 2); gnd.addColorStop(0, '#7b4f26'); gnd.addColorStop(1, '#3d2610');
    g.fillStyle = gnd; g.fillRect(-R * 2, off, R * 4, R * 3);
    g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(-R * 2, off); g.lineTo(R * 2, off); g.stroke();
    g.lineWidth = 1.8;
    for (const p of [5, 10, 15, 20]) { const w = p % 10 ? 12 : 24; g.beginPath(); g.moveTo(-w, off - p * ppd); g.lineTo(w, off - p * ppd); g.stroke(); g.beginPath(); g.moveTo(-w, off + p * ppd); g.lineTo(w, off + p * ppd); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,0.7)';
    for (const a of [-50, -25, 25, 50]) { g.beginPath(); g.moveTo(0, off); g.lineTo(Math.tan(a * DEG) * 120, off + 120); g.stroke(); }
    for (const b of [-60, -30, -20, -10, 10, 20, 30, 60, -45, 45]) tick(g, 0, 0, R - (Math.abs(b) % 30 === 0 ? 16 : 10), R - 1, b, 3, '#fff');
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -R + 2); g.lineTo(-7, -R + 14); g.lineTo(7, -R + 14); g.fill();
    for (const b of [-90, 90]) tick(g, 0, 0, R - 16, R - 1, b, 4, '#fff');
    g.restore();
    g.strokeStyle = '#111'; g.lineWidth = 10; g.beginPath(); g.arc(0, 0, R - 4, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#e8721c'; g.beginPath(); g.moveTo(0, -R + 18); g.lineTo(-7, -R + 30); g.lineTo(7, -R + 30); g.fill();
    g.save(); g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 5; g.shadowOffsetY = 3;
    g.fillStyle = '#e8721c'; g.fillRect(-54, -3, 34, 6); g.fillRect(20, -3, 34, 6);
    g.beginPath(); g.moveTo(-20, 0); g.lineTo(0, 12); g.lineTo(20, 0); g.lineTo(14, 0); g.lineTo(0, 6); g.lineTo(-14, 0); g.fill();
    g.beginPath(); g.arc(0, 0, 3.5, 0, Math.PI * 2); g.fill();
    g.restore();
    glass(g, 0, 0, R);
  }

  drawCDI(g, obs, r, gs, powered, key, gpsSrc = false) {
    const R = 88;
    g.save(); g.rotate(-obs * DEG);
    for (let d = 0; d < 360; d += 5) { g.strokeStyle = '#ddd'; g.lineWidth = d % 10 ? 1 : 2; const r0 = d % 10 ? R - 7 : R - 12; g.beginPath(); g.moveTo(Math.sin(d * DEG) * r0, -Math.cos(d * DEG) * r0); g.lineTo(Math.sin(d * DEG) * (R - 1), -Math.cos(d * DEG) * (R - 1)); g.stroke(); }
    for (let d = 0; d < 360; d += 30) { g.save(); g.rotate(d * DEG); text(g, { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] ?? String(d / 10), 0, -R + 22, 16, '#f2f2f2'); g.restore(); }
    g.restore();
    g.fillStyle = '#f2f2f2'; g.beginPath(); g.moveTo(0, -R + 28); g.lineTo(-6, -R + 36); g.lineTo(6, -R + 36); g.fill();
    const v = powered && r && r.valid;
    if (!v) { g.fillStyle = '#d42'; g.fillRect(-46, -26, 26, 14); text(g, gpsSrc ? 'GPS' : 'NAV', -33, -19, 10, '#fff', 'center', 700); }
    else text(g, r.toFrom > 0 ? 'TO' : 'FR', 36, -16, 13, '#fff', 'center', 700);
    if (gs && !(powered && r && r.gsValid)) { g.fillStyle = '#d42'; g.fillRect(22, 18, 26, 14); text(g, 'GS', 35, 25, 10, '#fff', 'center', 700); }
    this[key] = this[key] || { d: 0, g: 0 };
    const tgt = v ? r.dev : 0; this[key].d += (tgt - this[key].d) * 0.12;
    g.save(); g.beginPath(); g.arc(0, 0, R - 14, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#f4f4f4'; g.shadowColor = 'rgba(0,0,0,0.7)'; g.shadowBlur = 4; g.shadowOffsetX = 2;
    g.fillRect(this[key].d * 55 - 2.5, -56, 5, 116);
    if (gs) { const gt = powered && r && r.gsValid ? -r.gsDev : 0; this[key].g += (gt - this[key].g) * 0.12; g.fillRect(-56, 6 + this[key].g * 50 - 2.5, 116, 5); }
    g.restore();
    glass(g, 0, 0, R);
  }

  // ---------------------------------------------------------------- KLN 94 GPS screen
  drawGPS(g, sim, f, av, E, t) {
    const sx = this.stack.x, y = this.R.gps, G = av.gps, on = !!E.gps && G.on;
    const X = sx + 42, Y = y + 4, W = 218, H = 66;
    knob(g, sx + 22, y + 14, 8); knobPointer(g, sx + 22, y + 14, 8, G.on ? -120 + G.bright * 240 : -150);
    pushBtn(g, sx + 6, y + 34, 32, 11, 'CRSR', this.isDown('gpsCrsrL'), { size: 6.5, dark: true });
    knob(g, sx + 22, y + 71, 11); knobPointer(g, sx + 22, y + 71, 11, [2, 5, 10, 20, 40, 80].indexOf(G.range) * 50 - 125);
    pushBtn(g, sx + 266, y + 13, 34, 13, 'CRSR', this.isDown('gpsCrsrR'), { size: 6.5, dark: true });
    dualKnob(g, sx + 284, y + 58, 19, 10);
    ['MSG', 'OBS', 'ALT', 'NRST', 'D→', 'CLR', 'ENT'].forEach((n, i) => pushBtn(g, sx + 44 + i * 31, y + 74, 28, 15, n, this.isDown('gps' + n), { size: 7, dark: true }));
    g.fillStyle = '#020305'; roundRect(g, X, Y, W, H, 3); g.fill();
    if (!on) return;
    g.save(); roundRect(g, X, Y, W, H, 3); g.clip(); g.globalAlpha = 0.45 + 0.55 * G.bright;
    const C = { cy: '#3fd8ff', gr: '#5dff7a', wh: '#f2f2f2', mg: '#ff4fe0', yl: '#ffd84a', am: '#ffb000' };
    const T = (s, x, yy, sz = 9, c = C.wh, al = 'left', w = 700) => text(g, s, x, yy, sz, c, al, w, 'monospace');
    const p3 = (v) => String(Math.round(((v % 360) + 360) % 360) || 360).padStart(3, '0');
    const fmtT = (sec) => (sec == null ? '--:--' : sec < 3600 ? `${Math.floor(sec / 60)}:${String(Math.floor(sec) % 60).padStart(2, '0')}` : `${Math.floor(sec / 3600)}h${String(Math.floor(sec / 60) % 60).padStart(2, '0')}`);
    if (G.test > 0) {
      T('KLN 94', X + W / 2, Y + 14, 12, C.cy, 'center'); T('SELF TEST IN PROGRESS', X + W / 2, Y + 32, 8, C.wh, 'center');
      T('DATABASE: NORCAL  ' + new Date().getFullYear(), X + W / 2, Y + 44, 7.5, C.gr, 'center');
      g.fillStyle = C.cy; g.fillRect(X + 30, Y + 54, (W - 60) * (1 - G.test / 3), 4); g.restore(); return;
    }
    const n = G.nav, page = G.page;
    // status bar
    g.fillStyle = '#0d2140'; g.fillRect(X, Y + H - 12, W, 12);
    T(n ? n.scale : 'ENR', X + 4, Y + H - 6, 7.5, C.cy); T(G.mode, X + 36, Y + H - 6, 7.5, C.cy);
    if (G.msgs.length) T('MSG', X + 64, Y + H - 6, 7.5, Math.floor(t * 2) % 2 || page === 'MSG' ? C.am : '#553300');
    T(page === 'DTO' ? 'D→' : page, X + W - 4, Y + H - 6, 7.5, C.wh, 'right');
    if (page === 'NAV') {
      if (!n) { T('NO ACTV WPT', X + W / 2, Y + 16, 10, C.yl, 'center'); T('PRESS D→ OR NRST', X + W / 2, Y + 32, 8, C.wh, 'center'); T(`GS ${Math.round(G.gs || 0)}KT  TK ${G.trk == null ? '---' : p3(G.trk)}°`, X + W / 2, Y + 45, 8, C.gr, 'center'); }
      else if (!G.navSub) {
        T('→ ' + n.ident, X + 6, Y + 10, 11, C.mg);
        T('DIS', X + 6, Y + 25, 7.5, C.cy); T(n.dist.toFixed(n.dist < 10 ? 1 : 0) + 'NM', X + 34, Y + 25, 10);
        T('DTK', X + 6, Y + 38, 7.5, C.cy); T(p3(n.dtk) + '°', X + 34, Y + 38, 10);
        T('GS', X + 6, Y + 50, 7.5, C.cy); T(Math.round(G.gs || 0) + 'KT', X + 34, Y + 50, 10);
        T('TK', X + 110, Y + 38, 7.5, C.cy); T(G.trk == null ? '---' : p3(G.trk) + '°', X + 132, Y + 38, 10);
        T('ETE', X + 110, Y + 50, 7.5, C.cy); T(fmtT(n.ete), X + 132, Y + 50, 10);
        T(n.toFrom > 0 ? 'TO' : 'FR', X + 200, Y + 10, 8, C.wh, 'right');
        // mini CDI: 5 dots each side, full scale = fs NM
        const cx = X + 164, cy = Y + 21; g.fillStyle = C.wh; for (let i = -5; i <= 5; i++) { g.beginPath(); g.arc(cx + i * 8, cy, i ? 1.4 : 2.4, 0, 7); g.fill(); }
        const d = clamp(-n.xtk / n.fs, -1, 1) * 40; g.fillStyle = C.mg; g.fillRect(cx + d - 1.5, cy - 5, 3, 10);
        T(`XTK ${Math.abs(n.xtk).toFixed(2)}${n.xtk > 0 ? 'R' : 'L'}`, cx, cy + 9, 6.5, C.cy, 'center');
        if (G.wptAlert && Math.floor(t * 3) % 2) T('WPT', X + 108, Y + 10, 8, C.am);
      } else {
        T('→ ' + n.ident, X + 6, Y + 10, 11, C.mg); T('BRG', X + 6, Y + 25, 7.5, C.cy); T(p3(n.brg) + '°', X + 34, Y + 25, 10);
        T('XTK', X + 6, Y + 38, 7.5, C.cy); T(Math.abs(n.xtk).toFixed(2) + (n.xtk > 0 ? 'R' : 'L'), X + 34, Y + 38, 10);
        T('POS', X + 110, Y + 25, 7.5, C.cy); T(`${(f.pos[0] / 1852).toFixed(1)}E ${(-f.pos[2] / 1852).toFixed(1)}N`, X + 132, Y + 25, 8);
        T('ALT', X + 110, Y + 38, 7.5, C.cy); T(Math.round(f.pos[1] / 0.3048) + 'FT', X + 132, Y + 38, 9);
      }
    } else if (page === 'MAP') {
      const cx = X + W / 2, cy = Y + 44, pxNM = 40 / G.range, up = G.trk ?? f.attitude.hdg, ua = up * DEG;
      const toScr = (wx, wz) => { const ex = (wx - f.pos[0]) / 1852, nn = -(wz - f.pos[2]) / 1852; return [cx + (ex * Math.cos(ua) - nn * Math.sin(ua)) * pxNM, cy - (ex * Math.sin(ua) + nn * Math.cos(ua)) * pxNM]; };
      g.strokeStyle = 'rgba(63,216,255,0.35)'; g.lineWidth = 1; g.beginPath(); g.arc(cx, cy, 40, Math.PI, 2 * Math.PI); g.stroke();
      T(G.range + 'NM', X + W - 4, Y + 8, 7, C.cy, 'right'); T('TK ' + (G.trk == null ? '---' : p3(G.trk)), X + 4, Y + 8, 7, C.cy);
      g.save(); g.beginPath(); g.rect(X, Y, W, H - 12); g.clip(); // keep map symbols out of the status bar
      if (G.fpl.length > 1) { g.strokeStyle = C.wh; g.lineWidth = 1; g.beginPath(); G.fpl.forEach((w, i) => { const q = toScr(w.x, w.z); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }); g.stroke(); }
      if (G.wpt) { const a = G.origin ? toScr(G.origin.x, G.origin.z) : [cx, cy], b = toScr(G.wpt.x, G.wpt.z); g.strokeStyle = C.mg; g.lineWidth = 2; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); }
      for (const w of G.list || []) {
        if (w.dist > G.range * 1.6 || (G.declutter && w.type === 'VOR')) continue;
        const [px, py] = toScr(w.x, w.z); const act = G.wpt && G.wpt.ident === w.ident;
        g.strokeStyle = act ? C.mg : w.type === 'APT' ? C.cy : C.gr; g.lineWidth = 1.4; g.beginPath();
        if (w.type === 'APT') g.arc(px, py, 3, 0, 7); else { g.moveTo(px - 3, py); g.lineTo(px, py - 3); g.lineTo(px + 3, py); g.lineTo(px, py + 3); g.closePath(); }
        g.stroke(); T(w.ident, px + 5, py - 4, 6.5, act ? C.mg : C.wh);
      }
      g.restore();
      g.fillStyle = C.wh; g.beginPath(); g.moveTo(cx, cy - 5); g.lineTo(cx - 4, cy + 4); g.lineTo(cx + 4, cy + 4); g.fill();
    } else if (page === 'FPL') {
      T('FPL 0', X + 6, Y + 8, 7.5, C.cy); T(G.cursor ? 'EDIT' : G.fplActive ? 'ACTIVE' : G.fpl.length ? 'ENT=ACTIVATE' : 'EMPTY', X + W - 6, Y + 8, 7.5, G.fplActive && !G.cursor ? C.gr : C.yl, 'right');
      const rows = G.fpl.map((w, i) => ({ w, i })); if (G.cursor) rows.push({ add: true });
      const focus = G.cursor ? rows.length - 1 : G.fplActive ? G.leg : 0, top = clamp(focus - 1, 0, Math.max(0, rows.length - 3));
      for (let k = 0; k < 3 && top + k < rows.length; k++) {
        const r = rows[top + k], yy = Y + 20 + k * 12;
        if (r.add) { const c = G.list?.[G.fplSel]; g.fillStyle = '#1d4f9a'; g.fillRect(X + 2, yy - 6, W - 4, 12); T(`${G.fpl.length + 1} ${c ? c.ident : '----'}`, X + 6, yy, 8.5, C.wh); T(c ? `${c.type} ${c.dist.toFixed(1)}NM  ENT=ADD` : '', X + W - 6, yy, 7.5, C.yl, 'right'); continue; }
        const act = G.fplActive && r.i === G.leg, prev = r.i > 0 ? G.fpl[r.i - 1] : null;
        const legD = prev ? Math.hypot(r.w.x - prev.x, r.w.z - prev.z) / 1852 : null, legC = prev ? (Math.atan2(r.w.x - prev.x, -(r.w.z - prev.z)) / DEG + 360) % 360 : null;
        if (act) T('→', X + 4, yy, 9, C.mg);
        T(`${r.i + 1} ${r.w.ident}`, X + 14, yy, 8.5, act ? C.mg : C.wh); T(legD == null ? '' : `${p3(legC)}° ${legD.toFixed(1)}NM`, X + W - 6, yy, 8, C.gr, 'right');
      }
      if (!rows.length) T('CRSR, INNER KNOB, ENT TO ADD', X + W / 2, Y + 30, 7.5, C.wh, 'center');
    } else if (page === 'NRST') {
      T('NEAREST APT', X + 6, Y + 8, 7.5, C.cy); T('BRG  DIS', X + W - 6, Y + 8, 7.5, C.cy, 'right');
      const L = G.nrst || [], top = clamp(G.sel - 1, 0, Math.max(0, L.length - 3));
      for (let i = 0; i < 3 && top + i < L.length; i++) {
        const w = L[top + i], yy = Y + 20 + i * 12, selI = top + i === G.sel;
        if (selI && G.cursor) { g.fillStyle = '#1d4f9a'; g.fillRect(X + 2, yy - 6, W - 4, 12); }
        T(`${top + i + 1} ${w.ident}`, X + 6, yy, 8.5, selI ? C.wh : C.gr); T(`${p3(w.brg)}° ${w.dist.toFixed(1)}`, X + W - 6, yy, 8.5, C.wh, 'right');
      }
    } else if (page === 'ALT') {
      T('ALTITUDE', X + 6, Y + 9, 7.5, C.cy); T('IND', X + 6, Y + 24, 7.5, C.cy); T(Math.round(f.ind.alt) + 'FT', X + 40, Y + 24, 10);
      T('BARO', X + 6, Y + 38, 7.5, C.cy); T(G.baro.toFixed(2) + '"', X + 40, Y + 38, 10, G.cursor ? C.yl : C.wh);
      T('GPS', X + 120, Y + 24, 7.5, C.cy); T(Math.round(f.pos[1] / 0.3048) + 'FT', X + 146, Y + 24, 10);
      T('MSA', X + 120, Y + 38, 7.5, C.cy); T('4300FT', X + 146, Y + 38, 10);
    } else if (page === 'DTO') {
      const L = G.list || [], w = L[G.dtoSel];
      T('DIRECT TO:', X + 6, Y + 9, 8, C.cy); if (w) { T(w.ident, X + W / 2, Y + 25, 15, C.mg, 'center'); T((w.name || '').toUpperCase().slice(0, 30), X + W / 2, Y + 40, 7, C.wh, 'center'); T(`${w.type}  ${p3(w.brg)}°  ${w.dist.toFixed(1)}NM`, X + W / 2, Y + 50, 7.5, C.gr, 'center'); }
      T('ENT', X + W - 6, Y + 9, 7.5, Math.floor(t * 2) % 2 ? C.yl : C.wh, 'right');
    } else if (page === 'MSG') {
      T('MESSAGES', X + 6, Y + 8, 7.5, C.cy);
      if (!G.msgs.length) T('NO MESSAGES', X + W / 2, Y + 28, 9, C.wh, 'center');
      G.msgs.slice(-3).forEach((m, i) => T(m.slice(0, 34), X + 6, Y + 21 + i * 12, 7.5, C.yl));
    }
    g.restore();
  }

  // ---------------------------------------------------------------- radio displays & buttons
  drawRadios(g, { sim, f, av, E, t, dt }) {
    const R = this.R, { x: sx } = this.stack, RED = '#ff5a2c';
    const dim = (sim.night > 0.3 ? 0.55 + 0.45 * (f.sys.radioDim ?? 0.8) : 1);
    const col = (c) => (dim < 1 ? `rgba(${c},${dim.toFixed(2)})` : `rgb(${c})`);
    const red = col('255,90,44');
    // KMA 26
    {
      const y = R.kma, a = av.audio, on = !!E.audio && a.on !== false;
      for (const b of this.kmaBtns) pushBtn(g, b.x, b.y, 19, 16, b.n.replace('COM', 'C').replace('NAV', 'N'), this.isDown('kma' + b.n), { dark: false, size: 7.5, led: on ? !!a.rx[b.n] : false });
      const test = on && a.mkrSens === 'TEST';
      [['#2a64ff', 0], ['#ffb400', 1], ['#f4f4f4', 2]].forEach(([c, i]) => { if (test) { g.save(); g.fillStyle = c; g.shadowColor = c; g.shadowBlur = 10; g.beginPath(); g.arc(sx + 22 + i * 22, y + 22, 7, 0, 7); g.fill(); g.restore(); } else { g.fillStyle = 'rgba(80,80,80,0.5)'; g.beginPath(); g.arc(sx + 22 + i * 22, y + 22, 7, 0, 7); g.fill(); } });
      // MKR sens toggle
      { const p = { HI: 0, LO: 1, TEST: -1 }[a.mkrSens] ?? 0; g.fillStyle = '#bdbdbd'; g.fillRect(sx + 40 + p * 14, y + 44, 6, 6); }
      knob(g, sx + 284, y + 28, 12); knobPointer(g, sx + 284, y + 28, 12, -60 + (a.mic - 1) * 40);
      knob(g, sx + 84 + 9 * 21.5 + 14, y + 44, 9); knobPointer(g, sx + 84 + 9 * 21.5 + 14, y + 44, 9, -120 + (a.vol ?? 0.8) * 240);
    }
    // KX 155A
    for (const [k, ck, nk, n, pw] of [['nc1', 'com1', 'nav1', 1, E.com1], ['nc2', 'com2', 'nav2', 2, E.com2]]) {
      const y = R[k]; if (y == null) continue;
      const c = av[ck], nv = av[nk], on = !!pw && c.on !== false;
      const o = { off: !on, glow: on };
      seg7(g, c.active.toFixed(3).slice(0, 6), sx + 20, y + 18, 22, red, o);
      seg7(g, c.standby.toFixed(3).slice(0, 6), sx + 20, y + 44, 11, red, { ...o, w: 6, sp: 3 });
      seg7(g, nv.active.toFixed(2), sx + 166, y + 18, 22, red, o);
      seg7(g, nv.standby.toFixed(2), sx + 166, y + 44, 11, red, { ...o, w: 6, sp: 3 });
      if (on) {
        text(g, 'USE', sx + 140, y + 22, 7, red, 'right', 700); text(g, 'STBY', sx + 140, y + 50, 7, red, 'right', 700);
        if (c.sq) text(g, 'T', sx + 140, y + 36, 8, red, 'right', 700);
        const r = n === 1 ? av.r1 : av.r2;
        if (nv.ident && r?.ident) text(g, r.ident, sx + 290, y + 50, 9, red, 'right', 700);
        else if (r?.dme != null && r.valid) text(g, r.dme.toFixed(1) + 'NM', sx + 290, y + 50, 8, red, 'right', 700);
        const transmitting = sim.atc?.txT > 0 && av.audio.mic === n; if (transmitting) text(g, 'TX', sx + 140, y + 36, 8, red, 'right', 800);
      }
      pushBtn(g, sx + 104, y + 70, 30, 16, '⇄', this.isDown('cflip' + n), { size: 12 });
      pushBtn(g, sx + 250, y + 70, 30, 16, '⇄', this.isDown('nflip' + n), { size: 12 });
      knob(g, sx + 26, y + 96, 11); knobPointer(g, sx + 26, y + 96, 11, c.on === false ? -150 : -120 + (c.vol ?? 0.8) * 240);
      dualKnob(g, sx + 118, y + 96, 21, 12); knobPointer(g, sx + 118, y + 96, 12, (c.standby * 1000 % 1000) * 0.36);
      knob(g, sx + 178, y + 96, 11); knobPointer(g, sx + 178, y + 96, 11, -120 + (nv.vol ?? 0.8) * 240);
      dualKnob(g, sx + 264, y + 96, 21, 12); knobPointer(g, sx + 264, y + 96, 12, (nv.standby * 100 % 100) * 3.6);
    }
    if (R.gps != null) this.drawGPS(g, sim, f, av, E, t);
    // KR 87
    {
      const y = R.adf, A = av.adf, on = !!E.adf && A.on !== false;
      const o = { off: !on, glow: on };
      seg7(g, String(Math.round(A.freq)).padStart(4, ' '), sx + 70, y + 14, 18, red, o);
      if (on) {
        text(g, A.mode, sx + 22, y + 18, 9, red, 'left', 800); if (A.bfo) text(g, 'BFO', sx + 22, y + 31, 8, red, 'left', 800);
        text(g, A.timer === 'FRQ' ? 'FRQ' : A.timer, sx + 152, y + 16, 8, red, 'left', 800);
        if (A.timer === 'FRQ') seg7(g, String(Math.round(A.standby)).padStart(4, ' '), sx + 150, y + 22, 12, red, { w: 6.5, sp: 3 });
        else { const s = Math.floor(A.timer === 'FLT' ? A.flt : A.et); seg7(g, `${Math.floor(s / 60) % 100}:${String(s % 60).padStart(2, '0')}`.padStart(5, ' '), sx + 150, y + 22, 12, red, { w: 6.5, sp: 3 }); }
      } else seg7(g, '8888', sx + 150, y + 22, 12, red, { off: true, w: 6.5, sp: 3 });
      for (const b of this.krBtns) pushBtn(g, b.x, b.y, 36, 14, b.n, this.isDown('kr' + b.n), { size: 7.5 });
      knob(g, sx + 236, y + 52, 9); knobPointer(g, sx + 236, y + 52, 9, A.on === false ? -150 : -120 + (A.vol ?? 0.7) * 240);
      dualKnob(g, sx + 276, y + 34, 20, 11);
    }
    // KT 76C
    {
      const y = R.xpdr, X = av.xpdr, on = !!E.xpdr && X.mode !== 'OFF';
      if (X.entryT > 0) { X.entryT -= dt; if (X.entryT <= 0) X.entry = ''; }
      if (X.ident > 0) X.ident = Math.max(0, X.ident - dt);
      const code = X.entry ? (X.entry + '----').slice(0, 4) : X.code;
      const testAll = on && X.mode === 'TST';
      seg7(g, testAll ? '8888' : code, sx + 128, y + 13, 20, red, { off: !on || X.mode === 'SBY' && false, glow: on });
      if (on) {
        text(g, testAll ? 'FL888' : X.mode === 'ALT' ? 'FL' + String(Math.max(0, Math.round(f.ind.paltitude / 100))).padStart(3, '0') : X.mode, sx + 70, y + 24, 9, red, 'left', 800);
        const reply = X.ident > 0 || testAll || ((X.mode === 'ON' || X.mode === 'ALT') && Math.floor(t * 1.3) % 3 === 0);
        if (reply) { g.save(); g.fillStyle = red; g.shadowColor = red; g.shadowBlur = 6; text(g, 'R', sx + 200, y + 16, 9, red, 'center', 800); g.restore(); }
      }
      knob(g, sx + 30, y + 34, 13); knobPointer(g, sx + 30, y + 34, 13, -80 + ['OFF', 'SBY', 'TST', 'ON', 'ALT'].indexOf(X.mode) * 40);
      for (const b of this.xBtns) pushBtn(g, b.x, b.y, b.w, 14, b.n, this.isDown('x' + b.n), { size: b.n.length > 1 ? 7.5 : 9 });
    }
    // KAP 140
    if (R.ap != null) {
      const y = R.ap, ap = av.ap, on = !!E.ap;
      const LC = '#23271b', LCbg = on ? (sim.night > 0.3 ? '#9a7a28' : '#9fa48a') : '#16180f';
      g.fillStyle = LCbg; roundRect(g, sx + 14, y + 6, 214, 28, 3); g.fill();
      if (on) {
        const o = { glow: false, ghost: false, th: 2 };
        if (ap.on) text(g, 'AP', sx + 22, y + 20, 10, LC, 'left', 800);
        text(g, ap.on ? ap.lat : '', sx + 44, y + 20, 12, LC, 'left', 800);
        text(g, ap.on ? ap.vert : '', sx + 90, y + 20, 12, LC, 'left', 800);
        if (ap.gsArmed) text(g, 'GS', sx + 90, y + 30, 7, LC, 'left', 800);
        if (ap.altArm) text(g, 'ARM', sx + 122, y + 30, 7, LC, 'left', 800);
        if (this.st.apBaro > 0) { this.st.apBaro -= dt; text(g, 'BARO', sx + 124, y + 14, 7, LC, 'left', 800); seg7(g, (f.kollsman ?? 29.92).toFixed(2), sx + 150, y + 11, 15, LC, o); }
        else if (this.st.apMsg > 0 && ap.on && ap.vert === 'VS') { this.st.apMsg -= dt; text(g, 'VS', sx + 124, y + 14, 7, LC, 'left', 800); seg7(g, `${ap.vsSel >= 0 ? ' ' : '-'}${String(Math.abs(ap.vsSel)).padStart(4, ' ')}`, sx + 140, y + 11, 15, LC, o); text(g, 'FPM', sx + 222, y + 28, 7, LC, 'right', 800); }
        else { seg7(g, String(ap.altSel).padStart(5, ' '), sx + 140, y + 11, 15, LC, o); text(g, 'FT', sx + 222, y + 28, 7, LC, 'right', 800); }
        if (ap.discAlert > 0 && Math.floor(t * 4) % 2) text(g, 'AP', sx + 22, y + 20, 10, '#6b1a10', 'left', 800);
      }
      for (const b of this.apBtns) pushBtn(g, b.x, b.y, 24, 15, b.n, this.isDown('ap' + b.n), { size: 7.5, dark: true });
      pushBtn(g, sx + 236, y + 6, 26, 13, 'ARM', this.isDown('apARM'), { size: 7, dark: true });
      pushBtn(g, sx + 236, y + 22, 26, 13, 'BARO', this.isDown('apBARO'), { size: 7, dark: true });
      dualKnob(g, sx + 285, y + 38, 20, 11);
    }
  }
}

// ---------------------------------------------------------------- components (switches, breakers, gauges, ...)
// Each component may define st(g) (static art), dyn(g, ctx) (per-frame), hot(add, sim) (interaction).
const proto = Panel.prototype;
const origLayout = proto.layout;
proto.layout = function () {
  origLayout.call(this);
  const C = this.comps, C172 = this.type === 'C172', self = this;
  const rect = (x, y, w, h) => ({ x, y, w, h });
  const circ = (cx, cy, r, r0 = 0) => ({ cx, cy, r, r0 });

  // ---- rocker switches (single) ---------------------------------------------
  const rocker = (x, y, key, lab, opts = {}) => C.push({
    st: (g) => { engrave(g, lab, x, y + 42, 10.5, '#eeeeea'); if (opts.sub) engrave(g, opts.sub, x, y + 54, 8.5, '#cfcfca'); },
    dyn: (g, { f }) => rockerFace(g, x, y, 24, 46, !!f.sys[key], opts.color || 'white', self.isDown('rk' + key)),
    hot: (add, sim) => add(rect(x - 16, y - 28, 32, 56), 'rk' + key, { click: () => { const s = sim.fdm.sys; s[key] = !s[key]; }, tip: () => `${lab} ${opts.sub || ''} — ${sim.fdm.sys[key] ? 'ON' : 'OFF'}` }),
  });
  // split rocker (master BAT/ALT, avionics BUS 1/BUS 2)
  const split = (x, y, keys, labs, title, color, interlock) => C.push({
    st: (g) => { engrave(g, title, x, y - 38, 10.5, '#eeeeea', 'center', 700); engrave(g, labs[0], x - 14, y + 40, 9.5); engrave(g, labs[1], x + 14, y + 40, 9.5); },
    dyn: (g, { f }) => { rockerFace(g, x - 14, y, 24, 50, !!f.sys[keys[0]], color, self.isDown('sp' + keys[0])); rockerFace(g, x + 14, y, 24, 50, !!f.sys[keys[1]], color, self.isDown('sp' + keys[1])); },
    hot: (add, sim) => keys.forEach((k, i) => add(rect(x - 28 + i * 28, y - 30, 28, 60), 'sp' + k, {
      click: () => { const s = sim.fdm.sys; s[k] = !s[k]; if (interlock) interlock(s, k); },
      tip: () => `${title} ${labs[i]} — ${sim.fdm.sys[k] ? 'ON' : 'OFF'}`,
    })),
  });
  // circuit breaker row
  const dynSrc = (g, { f, av, E }) => {
        const pw = !!E.gps && f.elec, gps = av.gps.src === 'GPS', down = this.isDown('cdiSrc');
        const lamp = (x, w, lab, lit, col) => { g.save(); g.fillStyle = lit ? col : '#151515'; if (lit) { g.shadowColor = col; g.shadowBlur = 8; } roundRect(g, x + (down ? 0.6 : 0), 24 + (down ? 0.8 : 0), w, 18, 2); g.fill(); g.restore(); text(g, lab, x + w / 2, 33, 9, lit ? '#061006' : '#555', 'center', 800); };
        lamp(822, 44, 'NAV', pw && !gps, '#5dff7a'); lamp(870, 44, 'GPS', pw && gps, '#5dff7a');
        const msg = pw && av.gps.ok && av.gps.msgs.length > 0, wpt = pw && av.gps.ok && av.gps.wptAlert;
        g.save(); for (const [x, lab, lit] of [[822, 'MSG', msg], [870, 'WPT', wpt]]) { g.fillStyle = lit ? '#ffb000' : '#1a1408'; roundRect(g, x, 45, 44, 15, 2); g.fill(); text(g, lab, x + 22, 52.5, 8, lit ? '#1a0e00' : '#4a3a1a', 'center', 800); } g.restore();
      };
  // NAV/GPS source switch-annunciator above CDI 1 (KLN 94 installation)
  const cdiSrcSwitch = (X0, Y0) => { const dx = X0 - 818, dy = Y0 - 20; C.push({
      st: (g) => { g.save(); g.translate(dx, dy); g.fillStyle = '#070707'; roundRect(g, 818, 20, 100, 44, 4); g.fill(); engrave(g, 'CDI 1 SOURCE', 868, 70, 7, '#cfcfca'); g.restore(); },
      dyn: (g, c) => { g.save(); g.translate(dx, dy); dynSrc(g, c); g.restore(); },
      hot: (add, sim) => add(rect(X0, Y0, 100, 44), 'cdiSrc', { click: () => { const G = sim.av.gps; G.src = G.src === 'GPS' ? 'NAV' : 'GPS'; }, tip: () => `NAV/GPS switch — CDI 1 and autopilot NAV follow ${sim.av.gps.src === 'GPS' ? 'the GPS' : 'NAV 1'} (click to swap)` }),
    }); };
  const breakers = (list, x0, y0, dx, perRow = 99, dy = 62) => list.forEach(([name, amps], i) => {
    const x = x0 + (i % perRow) * dx, y = y0 + Math.floor(i / perRow) * dy;
    C.push({
      st: (g) => { engrave(g, name, x, y + 22, 7.5, '#e8e8e4'); },
      dyn: (g, { f }) => breakerFace(g, x, y, amps, f.sys.cb?.[name] === false, self.isDown('cb' + name)),
      hot: (add, sim) => add(circ(x, y, 15), 'cb' + name, { click: () => { const s = sim.fdm.sys; s.cb = s.cb || {}; s.cb[name] = s.cb[name] === false; }, tip: () => `${name} circuit breaker (${amps} A) — ${sim.fdm.sys.cb?.[name] === false ? 'PULLED: click to reset' : 'IN: click to pull'}` }),
    });
  });
  // dual-pointer engine gauge (172S style rectangular, 152 lower-panel)
  const dual = (x, y, w, h, L, Rt, title) => C.push({
    st: (g) => {
      rectWell(g, x, y, w, h, 7);
      const fc = g.createLinearGradient(0, y, 0, y + h); fc.addColorStop(0, '#1b1c1e'); fc.addColorStop(1, '#0a0a0b'); g.fillStyle = fc; roundRect(g, x + 2, y + 2, w - 4, h - 4, 6); g.fill();
      for (const [S, cx] of [[L, x + w * 0.27], [Rt, x + w * 0.73]]) {
        const cy = y + h - 12, r = h * 0.62;
        const A = (v) => -55 + (clamp(v, S.lo, S.hi) - S.lo) / (S.hi - S.lo) * 110;
        for (const [a, b, c] of S.ranges || []) arc(g, cx, cy, r, A(a), A(b), 5, c);
        for (let i = 0; i <= (S.ticks || 4); i++) tick(g, cx, cy, r - 7, r + 3, -55 + i * 110 / (S.ticks || 4), 1.6, '#e8e8e8');
        if (S.labs) S.labs.forEach(([v, s]) => label(g, cx, cy, r - 15, A(v), s, 9, '#ddd'));
        text(g, S.name, cx, y + h - 13, 8, '#cfcfcf', 'center', 700);
      }
      if (title) text(g, title, x + w / 2, y + 9, 7.5, '#9a9a9a', 'center', 700);
      g.strokeStyle = 'rgba(255,255,255,0.08)'; g.beginPath(); g.moveTo(x + w / 2, y + 6); g.lineTo(x + w / 2, y + h - 6); g.stroke();
    },
    dyn: (g, ctx) => {
      for (const [S, cx] of [[L, x + w * 0.27], [Rt, x + w * 0.73]]) {
        const cy = y + h - 12, r = h * 0.62;
        const v = S.val(ctx); const a = -55 + (clamp(v, S.lo, S.hi) - S.lo) / (S.hi - S.lo) * 110;
        S._n = (S._n ?? a) + (a - (S._n ?? a)) * 0.2;
        needle(g, cx, cy, S._n, r + 1, 3, '#f4f4f4', 4); hub(g, cx, cy, 4);
      }
      const gl = g.createLinearGradient(x, y, x + w * 0.5, y + h); gl.addColorStop(0, 'rgba(255,255,255,0.10)'); gl.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gl; roundRect(g, x + 2, y + 2, w - 4, h - 4, 6); g.fill();
    },
  });
  const elecOK = ({ f }) => f.elec && f.sys.cb?.['INST'] !== false;
  const fuelCap = C172 ? 26 : 24;
  const fuelL = { name: 'L', lo: 0, hi: fuelCap, ranges: [[0, fuelCap * 0.12, '#d8241c']], labs: [[0, 'E'], [fuelCap, 'F']], val: (c) => (elecOK(c) ? c.f.sys.fuelL : 0) };
  const fuelR = { ...fuelL, name: 'R', val: (c) => (elecOK(c) ? c.f.sys.fuelR : 0) };
  const oilT = { name: 'OIL °F', lo: 75, hi: 250, ranges: [[100, 245, '#1fa83c'], [245, 250, '#d8241c']], val: (c) => (elecOK(c) ? c.f.eng.oilT : 75) };
  const oilP = { name: 'OIL PSI', lo: 0, hi: 115, ranges: [[0, 20, '#d8241c'], [50, 90, '#1fa83c'], [100, 115, '#d8241c']], val: (c) => c.f.eng.oilP };

  if (C172) {
    // ---- left engine-instrument column (items 1-5)
    dual(36, 238, 170, 78, fuelL, fuelR, 'FUEL QTY  U.S. GAL');
    dual(36, 328, 170, 78, oilT, oilP);
    dual(36, 418, 170, 78, { name: 'EGT', lo: 1000, hi: 1700, ticks: 7, val: (c) => (elecOK(c) ? c.f.eng.egt : 1000) }, { name: 'FUEL GPH', lo: 0, hi: 19, ranges: [[0, 12, '#1fa83c']], labs: [[0, '0'], [19, '19']], val: (c) => (elecOK(c) ? c.f.eng.ff || 0 : 0) });
    dual(36, 508, 170, 78, { name: 'VAC', lo: 3, hi: 7, ranges: [[4.5, 5.5, '#1fa83c']], labs: [[3, '3'], [7, '7']], val: (c) => c.f.eng.vac }, { name: 'AMPS', lo: -60, hi: 60, labs: [[-60, '-'], [60, '+']], val: (c) => (c.f.elec ? c.f.eng.amps || 0 : 0) });
    // Davtron digital clock / OAT / voltmeter (item 5)
    this.clockComp(C, 121, 134, rect, circ);
    // annunciator panel (item 13) + TST/DIM switch
    this.annunciator172(C, 410, 52, rect);
    // ---- lower panel: ignition, master, avionics master, switches, breakers
    C.push({ st: (g) => { // ignition switch plate
      const x = 85, y = 852; const gr = g.createRadialGradient(x, y, 10, x, y, 44); gr.addColorStop(0, '#1b1c1e'); gr.addColorStop(1, '#0a0a0b'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, 42, 0, 7); g.fill();
      ['OFF', 'R', 'L', 'BOTH', 'START'].forEach((m, i) => label(g, x, y, 32, [-75, -40, -10, 25, 60][i], m, 9, '#eee', 700));
      engrave(g, 'IGNITION', x, y + 54, 10, '#eee', 'center', 700);
    } });
    split(178, 852, ['alternator', 'master'], ['ALT', 'BAT'], 'MASTER', 'red', (s, k) => { if (k === 'alternator' && s.alternator) s.master = true; if (k === 'master' && !s.master) s.alternator = false; });
    split(258, 852, ['avionics', 'avionics2'], ['BUS 1', 'BUS 2'], 'AVIONICS', 'black');
    const sw = [['fuelPump', 'FUEL', 'PUMP'], ['beacon', 'BCN'], ['landing', 'LAND'], ['taxi', 'TAXI'], ['nav', 'NAV'], ['strobe', 'STROBE'], ['pitotHeat', 'PITOT', 'HEAT']];
    sw.forEach(([k, l, sub], i) => rocker(352 + i * 54, 846, k, l, { sub }));
    breakers(CB_172_MAIN, 342, 936, 46);
    breakers(CB_172_AVN, 48, 702, 52, 5, 56);
    C.push({ st: (g) => { engrave(g, 'AVIONICS', 152, 664, 10, '#eee', 'center', 700); engrave(g, 'PULL OFF', 152, 676, 7.5, '#cfcfca'); engrave(g, 'BREAKERS — PUSH TO RESET', 660, 1004, 9, '#cfcfca'); } });
    // ---- below stack: dimmers, engine control placards, flap selector
    this.dimmer(C, 1052, 742, 'panelDim', 'radioDim', 'PANEL', 'RADIO', circ);
    this.dimmer(C, 1270, 742, 'gsDim', 'pedDim', 'GLARESHIELD', 'PEDESTAL', circ);
    C.push({ st: (g) => {
      engrave(g, 'THROTTLE', 1100, 828, 10, '#eee', 'center', 700); engrave(g, 'PUSH  OPEN', 1100, 920, 8.5, '#cfcfca');
      engrave(g, 'MIXTURE', 1232, 828, 10, '#eee', 'center', 700); engrave(g, 'RICH', 1232, 920, 8.5, '#cfcfca'); engrave(g, 'PUSH LOCK BUTTON', 1232, 932, 7.5, '#cfcfca');
      engrave(g, 'ALT STATIC AIR', 1166, 722, 8, '#eee', 'center', 700); engrave(g, 'PULL ON', 1166, 770, 7.5, '#cfcfca');
      engrave(g, '12 VDC', 1166, 958, 8.5, '#eee'); g.fillStyle = '#060606'; g.beginPath(); g.arc(1166, 984, 12, 0, 7); g.fill(); g.strokeStyle = '#555'; g.lineWidth = 2; g.stroke();
      // cabin heat / air placards
      engrave(g, 'CABIN HT', 1720, 760, 10, '#eee', 'center', 700); engrave(g, 'PULL ON', 1720, 846, 8, '#cfcfca');
      engrave(g, 'CABIN AIR', 1850, 760, 10, '#eee', 'center', 700); engrave(g, 'PULL ON', 1850, 846, 8, '#cfcfca');
    } });
    this.flapPanel(C, 1384, 640, [640, 685, 730, 775]);
    cdiSrcSwitch(818, 20);
    this.hourMeter(C, 1440, 130);
    this.eltSwitch(C, 1440, 60);
    this.glovebox(C, 1640, 430, 370, 220, rect);
  } else {
    // ---------------- Cessna 152
    // small round gauges: suction (left of six-pack), ammeter, EGT, low-voltage light, clock
    this.roundGauge(C, 'suction', 88, 300, 40, 'SUCTION', 3, 7, [[4.5, 5.4, '#1fa83c']], [[3, '3'], [7, '7']], (c) => c.f.eng.vac, 'IN. HG');
    this.roundGauge(C, 'amm', 1350, 360, 38, 'AMPERES', -60, 60, [], [[-60, '-'], [0, '0'], [60, '+']], (c) => (c.f.elec ? c.f.eng.amps || 0 : 0));
    this.roundGauge(C, 'egt', 1470, 360, 38, 'EGT', 1000, 1700, [], [], (c) => (elecOK(c) ? c.f.eng.egt : 1000));
    this.analogClock(C, 512, 118, 38);
    this.lowVolt152(C, 1470, 250);
    this.hourMeter(C, 1560, 120);
    dual(560, 520, 170, 76, fuelL, fuelR, 'FUEL QTY  U.S. GAL');
    dual(748, 520, 170, 76, oilT, oilP);
    C.push({ st: (g) => {
      const x = 215, y = 790; const gr = g.createRadialGradient(x, y, 10, x, y, 44); gr.addColorStop(0, '#1b1c1e'); gr.addColorStop(1, '#0a0a0b'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, 42, 0, 7); g.fill();
      ['OFF', 'R', 'L', 'BOTH', 'START'].forEach((m, i) => label(g, x, y, 32, [-75, -40, -10, 25, 60][i], m, 9, '#eee', 700));
      engrave(g, 'IGNITION', x, y + 54, 10, '#fff', 'center', 700);
      engrave(g, 'PRIMER', 70, 712, 10, '#fff', 'center', 700);
      engrave(g, 'CARB HEAT', 1000, 750, 10, '#fff', 'center', 700); engrave(g, 'PULL ON', 1000, 850, 8, '#eee');
      engrave(g, 'THROTTLE', 1110, 750, 10, '#fff', 'center', 700); engrave(g, 'MIXTURE', 1232, 750, 10, '#fff', 'center', 700); engrave(g, 'RICH', 1232, 850, 8, '#eee');
      engrave(g, 'CABIN HT', 1720, 750, 10, '#fff', 'center', 700); engrave(g, 'CABIN AIR', 1850, 750, 10, '#fff', 'center', 700);
    } });
    split(130, 790, ['alternator', 'master'], ['ALT', 'BAT'], 'MASTER', 'red', (s, k) => { if (k === 'alternator' && s.alternator) s.master = true; if (k === 'master' && !s.master) s.alternator = false; });
    const sw = [['avionics', 'AVN', 'POWER'], ['beacon', 'BCN'], ['landing', 'LAND'], ['taxi', 'TAXI'], ['nav', 'NAV'], ['strobe', 'STROBE'], ['pitotHeat', 'PITOT', 'HEAT']];
    sw.forEach(([k, l, sub], i) => rocker(312 + i * 50, 790, k, l, { sub, color: 'white' }));
    breakers(CB_152, 244, 948, 56);
    cdiSrcSwitch(760, 22);
    C.push({ st: (g) => engrave(g, 'CIRCUIT BREAKERS — PUSH TO RESET', 692, 1008, 9, '#eee') });
    this.dimmer(C, 1440, 860, 'panelDim', 'radioDim', 'PANEL LT', 'RADIO LT', circ);
    this.flapPanel(C, 1330, 690, [690, 735, 780, 825]);
    this.glovebox(C, 1640, 560, 370, 200, rect);
  }
};

// ---- 172S Davtron M803 clock / OAT / voltmeter
proto.clockComp = function (C, x, y, rect, circ) {
  const self = this, st = this.st;
  C.push({
    st: (g) => { well(g, x, y, 54); face(g, x, y, 54, '#202124', '#0b0b0c'); g.fillStyle = '#040404'; roundRect(g, x - 40, y - 34, 80, 28, 3); g.fill(); roundRect(g, x - 40, y + 0, 80, 28, 3); g.fill(); text(g, 'M803', x, y - 44, 7, '#999', 'center', 700); },
    dyn: (g, { f, sim, dt }) => {
      const on = f.elec;
      if (st.etRun) st.et += dt;
      const o = { off: !on, glow: on, w: 7.5, sp: 3.5 };
      const RED = '#ff5a2c';
      const oat = f.ind.oat ?? 15;
      const top = [f.eng.busV.toFixed(1), Math.round(oat * 9 / 5 + 32) + '', Math.round(oat) + ''][st.clockTop];
      seg7(g, top.padStart(4, ' '), x - 34, y - 30, 18, RED, o);
      if (on) text(g, ['E', '°F', '°C'][st.clockTop], x + 36, y - 20, 8, RED, 'right', 800);
      const h = sim.timeOfDay % 24;
      const utc = (h + 8) % 24;
      let tt;
      if (st.clockMode === 0) tt = `${String(Math.floor(utc)).padStart(2, '0')}:${String(Math.floor(utc * 60 % 60)).padStart(2, '0')}`;
      else if (st.clockMode === 1) tt = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor(h * 60 % 60)).padStart(2, '0')}`;
      else if (st.clockMode === 2) { const s = sim.av.adf.flt || 0; tt = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`; }
      else { const s = st.et; tt = `${String(Math.floor(s / 60) % 100).padStart(2, '0')}:${String(Math.floor(s) % 60).padStart(2, '0')}`; }
      seg7(g, tt, x - 34, y + 4, 18, RED, o);
      if (on) ['UT', 'LT', 'FT', 'ET'].forEach((m, i) => text(g, m, x - 36 + i * 22, y + 34, 6.5, i === st.clockMode ? RED : '#3a1a10', 'left', 800));
      pushBtn(g, x - 46, y + 40, 26, 11, 'OAT/V', self.isDown('clkTop'), { size: 6, dark: true });
      pushBtn(g, x - 13, y + 40, 26, 11, 'SELECT', self.isDown('clkSel'), { size: 6, dark: true });
      pushBtn(g, x + 20, y + 40, 26, 11, 'CONTROL', self.isDown('clkCtl'), { size: 6, dark: true });
    },
    hot: (add) => {
      add(rect(x - 46, y + 38, 26, 15), 'clkTop', { click: () => { st.clockTop = (st.clockTop + 1) % 3; }, tip: 'Clock upper display: volts / OAT °F / OAT °C' });
      add(rect(x - 13, y + 38, 26, 15), 'clkSel', { click: () => { st.clockMode = (st.clockMode + 1) % 4; }, tip: () => `Clock SELECT — ${['UTC', 'local time', 'flight time', 'elapsed timer'][st.clockMode]}` });
      add(rect(x + 20, y + 38, 26, 15), 'clkCtl', { click: (b) => { if (st.clockMode !== 3) { st.clockMode = 3; return; } if (b === 2) { st.et = 0; st.etRun = false; } else st.etRun = !st.etRun; }, tip: () => `Clock CONTROL — elapsed timer ${st.etRun ? 'running' : 'stopped'} (click start/stop, right-click reset)` });
    },
  });
};

// ---- 172S annunciator panel
proto.annunciator172 = function (C, x, y, rect) {
  const self = this;
  const cells = [['L LOW FUEL', 'amber'], ['OIL PRESS', 'red'], ['LOW VAC', 'amber'], ['VOLTS', 'red'], ['LOW FUEL R', 'amber']];
  C.push({
    dyn: (g, { f, t }) => {
      const on = f.elec && f.sys.cb?.['WARN'] !== false;
      const st = [f.sys.fuelL < 5, f.eng.oilP < 20, f.eng.vac < 3.5, f.elec && f.eng.busV < 24.5, f.sys.fuelR < 5];
      const test = self.held.annTst;
      const dimF = f.sys.annDim ? 0.55 : 1;
      cells.forEach(([n, c], i) => {
        const lit = on && (st[i] || test) && !(st[i] && !test && f.time < 10 && Math.floor(t * 3) % 2);
        const bx = x + 6 + i * 62;
        g.fillStyle = lit ? (c === 'red' ? `rgba(255,59,47,${dimF})` : `rgba(255,190,26,${dimF})`) : '#1c1712';
        roundRect(g, bx, y + 5, 58, 24, 2); g.fill();
        text(g, n, bx + 29, y + 17, 8.5, lit ? '#2a0800' : '#3e352b', 'center', 800);
      });
      // TST / DIM rocker
      rockerFace(g, x + 330 + 18, y + 17, 18, 30, !!self.held.annTst, 'black', false);
    },
    st: (g) => { engrave(g, 'TST', x + 348, y - 4, 7.5); engrave(g, 'DIM', x + 348, y + 40, 7.5); },
    hot: (add, sim) => {
      add(rect(x + 336, y + 1, 26, 16), 'annTst', { down: () => { self.held.annTst = true; }, up: () => { self.held.annTst = false; }, tip: 'Annunciator TEST (press and hold)' });
      add(rect(x + 336, y + 17, 26, 16), 'annDim', { click: () => { sim.fdm.sys.annDim = !sim.fdm.sys.annDim; }, tip: () => `Annunciator DIM — ${sim.fdm.sys.annDim ? 'DIM' : 'BRIGHT'}` });
    },
  });
};

// ---- dimmer rheostats (concentric)
proto.dimmer = function (C, x, y, outerKey, innerKey, outerLab, innerLab, circ) {
  C.push({
    st: (g) => { engrave(g, outerLab, x, y - 34, 8.5, '#eee', 'center', 700); engrave(g, innerLab, x, y + 36, 8, '#cfcfca'); for (let i = 0; i <= 6; i++) tick(g, x, y, 26, 30, -135 + i * 45, 1.5, '#cfcfca'); engrave(g, 'OFF', x - 28, y + 22, 7); engrave(g, 'BRT', x + 28, y + 22, 7); },
    dyn: (g, { f }) => { dualKnob(g, x, y, 21, 12); knobPointer(g, x, y, 21, -135 + (f.sys[outerKey] ?? 0) * 270, '#ddd'); knobPointer(g, x, y, 12, -135 + (f.sys[innerKey] ?? 0) * 270, '#fff'); },
    hot: (add, sim) => {
      const set = (k, v) => { const s = sim.fdm.sys; s[k] = clamp(v, 0, 1); s.panelLights = (s.panelDim ?? 0) > 0.02; };
      add(circ(x, y, 12), 'dimIn' + innerKey, { click: (b) => set(innerKey, (sim.fdm.sys[innerKey] ?? 0) + (b === 2 ? -0.25 : 0.25)), wheel: (d) => set(innerKey, (sim.fdm.sys[innerKey] ?? 0) - Math.sign(d) * 0.08), tip: () => `${innerLab} dimmer ${Math.round((sim.fdm.sys[innerKey] ?? 0) * 100)}% (inner knob)` });
      add(circ(x, y, 23, 12), 'dimOut' + outerKey, { click: (b) => set(outerKey, (sim.fdm.sys[outerKey] ?? 0) + (b === 2 ? -0.25 : 0.25)), wheel: (d) => set(outerKey, (sim.fdm.sys[outerKey] ?? 0) - Math.sign(d) * 0.08), tip: () => `${outerLab} dimmer ${Math.round((sim.fdm.sys[outerKey] ?? 0) * 100)}% (outer knob)` });
    },
  });
};

// ---- flap selector slot with position indicator
proto.flapPanel = function (C, x, y0, det) {
  const self = this;
  C.push({
    st: (g) => {
      engrave(g, 'WING FLAPS', x, y0 - 30, 10, '#eee', 'center', 700);
      g.fillStyle = '#050505'; roundRect(g, x - 6, y0 - 8, 12, det[3] - det[0] + 16, 6); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1; roundRect(g, x - 6, y0 - 8, 12, det[3] - det[0] + 16, 6); g.stroke();
      ['UP', '10°', '20°', 'FULL'].forEach((l, i) => { engrave(g, l, x + 34, det[i], 9.5, '#eee', 'left', 700); g.fillStyle = '#ddd'; g.fillRect(x + 12, det[i] - 1, 16, 2); });
      // position indicator scale (left of slot)
      g.fillStyle = '#070707'; roundRect(g, x - 52, y0 - 10, 26, det[3] - det[0] + 20, 4); g.fill();
      ['0', '10', '20', '30'].forEach((l, i) => text(g, l, x - 60, det[i], 8, '#cfcfca', 'right', 600));
      engrave(g, 'POSITION', x - 39, det[3] + 24, 7, '#cfcfca');
    },
    dyn: (g, { f }) => {
      const p = clamp((f.flapPos || 0) / 30, 0, 1); const yy = det[0] + p * (det[3] - det[0]);
      g.fillStyle = f.elec ? '#f4f4f0' : '#bdbdb8'; g.beginPath(); g.moveTo(x - 30, yy); g.lineTo(x - 44, yy - 5); g.lineTo(x - 44, yy + 5); g.fill();
    },
    hot: (add, sim) => {
      det.forEach((yy, i) => add(rect(x + 8, yy - 10, 52, 20), 'flapDet' + i, { click: () => { sim.fdm.ctrl.flaps = i; }, tip: `Set flaps ${['UP', '10°', '20°', 'FULL'][i]}` }));
    },
  });
  void self;
};
const rect = (x, y, w, h) => ({ x, y, w, h });

// ---- Hobbs / hour meter
proto.hourMeter = function (C, x, y) {
  C.push({
    st: (g) => { g.fillStyle = '#060606'; roundRect(g, x - 48, y - 16, 96, 32, 4); g.fill(); g.strokeStyle = '#555'; g.lineWidth = 1.5; roundRect(g, x - 48, y - 16, 96, 32, 4); g.stroke(); engrave(g, 'HOURS', x, y + 26, 8.5, '#ddd', 'center', 700); },
    dyn: (g, { f }) => {
      const hrs = 2861.4 + (f.eng.oilP > 5 ? f.time / 3600 : 0);
      const s = hrs.toFixed(1).replace('.', '').padStart(6, '0');
      for (let i = 0; i < 6; i++) {
        const bx = x - 44 + i * 14.5; const last = i === 5;
        g.fillStyle = last ? '#eee' : '#141414'; g.fillRect(bx, y - 12, 13, 24);
        text(g, s[i], bx + 6.5, y + 0.5, 15, last ? '#111' : '#f2f2f2', 'center', 600, LCD);
      }
      const gr = g.createLinearGradient(0, y - 12, 0, y + 12); gr.addColorStop(0, 'rgba(0,0,0,0.6)'); gr.addColorStop(0.3, 'rgba(0,0,0,0)'); gr.addColorStop(0.7, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.6)');
      g.fillStyle = gr; g.fillRect(x - 44, y - 12, 88, 24);
    },
  });
};

// ---- ELT remote switch (ON / ARM / TEST-RESET) with red light
proto.eltSwitch = function (C, x, y) {
  const self = this, st = this.st;
  C.push({
    st: (g) => { engrave(g, 'ELT', x - 40, y - 10, 10, '#eee', 'center', 700); engrave(g, 'ON', x + 18, y - 22, 7.5); engrave(g, 'ARM', x + 18, y + 22, 7.5); },
    dyn: (g, { t }) => {
      rockerFace(g, x + 18, y, 16, 28, st.elt === 'ON', 'black', self.isDown('elt'));
      const lit = st.elt === 'ON' ? Math.floor(t * 2) % 2 === 0 : st.eltTest > 0;
      if (st.eltTest > 0) st.eltTest -= 1 / 30;
      g.save(); g.fillStyle = lit ? '#ff2a1a' : '#3a0d08'; if (lit) { g.shadowColor = '#ff2a1a'; g.shadowBlur = 10; } g.beginPath(); g.arc(x - 12, y + 2, 7, 0, 7); g.fill(); g.restore();
    },
    hot: (add) => {
      add(rect(x + 8, y - 16, 20, 32), 'elt', { click: (b) => { if (b === 2) { st.eltTest = 1.2; st.elt = 'ARM'; } else st.elt = st.elt === 'ON' ? 'ARM' : 'ON'; }, tip: () => `ELT remote switch — ${st.elt} (click = ON/ARM, right-click = test/reset)` });
    },
  });
};

// ---- glovebox with latch
proto.glovebox = function (C, x, y, w, h) {
  const st = this.st;
  C.push({
    dyn: (g) => {
      if (st.glove) {
        g.fillStyle = '#050505'; roundRect(g, x, y, w, h, 14); g.fill();
        g.fillStyle = '#1a1a1a'; roundRect(g, x + 10, y + 10, w - 20, h - 20, 10); g.fill();
        g.fillStyle = '#e8e2cf'; g.save(); g.translate(x + 60, y + 40); g.rotate(-0.06); g.fillRect(0, 0, 150, 110); text(g, 'PILOT\'S OPERATING', 75, 30, 11, '#222', 'center', 700); text(g, 'HANDBOOK', 75, 46, 13, '#222', 'center', 800); text(g, this.type === 'C152' ? 'CESSNA 152' : 'CESSNA 172S', 75, 70, 11, '#7a1a12', 'center', 800); g.restore();
        g.fillStyle = '#c33'; g.fillRect(x + 240, y + 60, 60, 26); text(g, 'FLASHLIGHT', x + 270, y + 73, 7, '#fff', 'center', 700);
        g.fillStyle = '#2a2a2a'; roundRect(g, x + 320, y + 50, 70, 60, 6); g.fill(); text(g, 'SECTIONAL', x + 355, y + 80, 8, '#ccc', 'center', 700);
        return;
      }
      g.save(); g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 10; g.shadowOffsetY = 4;
      const gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, this.type === 'C152' ? '#1e1f21' : '#4a4d51'); gr.addColorStop(1, this.type === 'C152' ? '#111' : '#35383b');
      g.fillStyle = gr; roundRect(g, x, y, w, h, 14); g.fill(); g.restore();
      g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1.5; roundRect(g, x + 1, y + 1, w - 2, h - 2, 14); g.stroke();
      // latch
      g.fillStyle = '#0a0a0a'; roundRect(g, x + w / 2 - 34, y + 14, 68, 22, 6); g.fill();
      const lg = g.createLinearGradient(0, y + 16, 0, y + 34); lg.addColorStop(0, '#888'); lg.addColorStop(1, '#2a2a2a');
      g.fillStyle = lg; roundRect(g, x + w / 2 - 28, y + 18, 56, 14, 5); g.fill();
      text(g, 'PULL', x + w / 2, y + 48, 8, '#bbb', 'center', 700);
    },
    hot: (add) => add(rect(x, y, w, h), 'glove', { click: () => { st.glove = !st.glove; }, tip: () => (st.glove ? 'Close glovebox' : 'Open glovebox (pull latch)') }),
  });
};

// ---- small round gauge (152 suction / ammeter / EGT)
proto.roundGauge = function (C, id, x, y, R, title, lo, hi, ranges, labs, val, sub = '') {
  C.push({
    st: (g) => {
      well(g, x, y, R, { lip: 6, screws: false }); g.save(); g.translate(x, y); g.scale(R / 88, R / 88);
      const RR = 88; face(g, 0, 0, RR);
      const A = (v) => -120 + (clamp(v, lo, hi) - lo) / (hi - lo) * 240;
      for (const [a, b, c] of ranges) arc(g, 0, 0, RR - 10, A(a), A(b), 12, c);
      for (let i = 0; i <= 10; i++) tick(g, 0, 0, RR - (i % 5 === 0 ? 24 : 16), RR - 2, -120 + i * 24, i % 5 === 0 ? 4 : 2.5);
      labs.forEach(([v, s]) => label(g, 0, 0, RR - 42, A(v), s, 26));
      text(g, title, 0, 36, 20, '#ddd'); if (sub) text(g, sub, 0, 58, 15, '#aaa');
      g.restore();
    },
    dyn: (g, ctx) => {
      const a = -120 + (clamp(val(ctx), lo, hi) - lo) / (hi - lo) * 240;
      this['_rg' + id] = (this['_rg' + id] ?? a) + (a - (this['_rg' + id] ?? a)) * 0.2;
      g.save(); g.translate(x, y); g.scale(R / 88, R / 88); needle(g, 0, 0, this['_rg' + id], 72, 7); hub(g, 0, 0, 10); glass(g, 0, 0, 88); g.restore();
    },
  });
};

// ---- 152 analog clock (wind-up style, second hand)
proto.analogClock = function (C, x, y, R) {
  C.push({
    st: (g) => {
      well(g, x, y, R, { lip: 6, screws: false }); face(g, x, y, R, '#222', '#0b0b0b');
      for (let i = 0; i < 60; i++) tick(g, x, y, R - (i % 5 ? 4 : 8), R - 1, i * 6, i % 5 ? 0.8 : 1.8);
      for (let i = 1; i <= 12; i++) label(g, x, y, R - 15, i * 30, String(i), 9.5);
      text(g, 'CLOCK', x, y + 14, 6, '#999');
    },
    dyn: (g, { sim }) => {
      const h = (sim.timeOfDay ?? 12) % 12, m = (h * 60) % 60, s = (performance.now() / 1000) % 60;
      needle(g, x, y, h * 30, R * 0.5, 3.5, '#eee', 4); needle(g, x, y, m * 6, R * 0.78, 2.5, '#eee', 5); needle(g, x, y, s * 6, R * 0.84, 1, '#e33', 8); hub(g, x, y, 3); glass(g, x, y, R);
    },
  });
};

// ---- 152 low-voltage warning light (press to test)
proto.lowVolt152 = function (C, x, y) {
  const self = this;
  C.push({
    st: (g) => { engrave(g, 'LOW', x, y - 26, 8, '#eee', 'center', 700); engrave(g, 'VOLTAGE', x, y + 26, 8, '#eee', 'center', 700); },
    dyn: (g, { f }) => {
      const lit = f.sys.master && (self.held.lvTest || (f.elec && f.eng.busV < 24.5) || (f.sys.master && !f.sys.alternator));
      g.fillStyle = '#0a0a0a'; g.beginPath(); g.arc(x, y, 15, 0, 7); g.fill();
      g.save(); const c = lit ? '#ff3a26' : '#4a0f09'; const gr = g.createRadialGradient(x - 4, y - 4, 1, x, y, 11); gr.addColorStop(0, lit ? '#ffb6a0' : '#7a2318'); gr.addColorStop(1, c);
      if (lit) { g.shadowColor = '#ff3a26'; g.shadowBlur = 14; } g.fillStyle = gr; g.beginPath(); g.arc(x, y + (self.held.lvTest ? 1 : 0), 11, 0, 7); g.fill(); g.restore();
    },
    hot: (add) => add({ cx: x, cy: y, r: 16, r0: 0 }, 'lvTest', { down: () => { self.held.lvTest = true; }, up: () => { self.held.lvTest = false; }, tip: 'LOW VOLTAGE light — press and hold to test' }),
  });
};
