// A350 procedural audio: Trent XWB fan whine + core roar, APU, airflow, rumble, gear/flap motors,
// Airbus aural alerts (continuous repetitive chime, single chime, cavalry charge, cabin ding, C-chord)
// and synthetic voice callouts (radio altimeter, RETARD, auto-callouts) via speechSynthesis.
import { FT } from './data.js';

const RA_CALLS = [2500, 1000, 500, 400, 300, 200, 100, 50, 40, 30, 20, 10];
const RA_WORDS = { 2500: 'twenty five hundred', 1000: 'one thousand', 500: 'five hundred', 400: 'four hundred', 300: 'three hundred', 200: 'two hundred', 100: 'one hundred', 50: 'fifty', 40: 'forty', 30: 'thirty', 20: 'twenty', 10: 'ten' };

export class JetSound {
  constructor() { this.ctx = null; this.vol = 0.7; this.lastRa = 99999; this.crcT = 0; this.voiceQ = []; this.speaking = false; }
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = this.vol; this.master.connect(c.destination);
    this.cabin = c.createBiquadFilter(); this.cabin.type = 'lowpass'; this.cabin.frequency.value = 2000; this.cabin.connect(this.master);
    const nb = c.createBuffer(1, c.sampleRate * 2, c.sampleRate); const d = nb.getChannelData(0); let b = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b = 0.98 * b + 0.02 * w; d[i] = w * 0.35 + b * 3.2; }
    const noise = () => { const s = c.createBufferSource(); s.buffer = nb; s.loop = true; s.start(); return s; };
    const chain = (src, type, f, q, dest) => { const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = c.createGain(); g.gain.value = 0; src.connect(fl); fl.connect(g); g.connect(dest); return { f: fl, g }; };
    // per engine: fan tone (blade-pass) + roar
    this.eng = [0, 1].map(() => {
      const o = c.createOscillator(); o.type = 'sawtooth'; const tone = chain(o, 'bandpass', 1200, 6, this.cabin); o.start();
      const o2 = c.createOscillator(); o2.type = 'triangle'; const buzz = chain(o2, 'lowpass', 600, 1, this.cabin); o2.start();
      const roar = chain(noise(), 'lowpass', 300, 0.6, this.cabin);
      return { o, o2, tone, buzz, roar };
    });
    this.apu = (() => { const o = c.createOscillator(); o.type = 'sawtooth'; const t = chain(o, 'bandpass', 4200, 8, this.cabin); o.start(); const n = chain(noise(), 'bandpass', 900, 0.8, this.cabin); return { o, t, n }; })();
    this.wind = chain(noise(), 'bandpass', 500, 0.5, this.master);
    this.rumble = chain(noise(), 'lowpass', 110, 1, this.master);
    this.hyd = chain(noise(), 'bandpass', 380, 3, this.cabin);
    this.fans = chain(noise(), 'bandpass', 1500, 0.4, this.master); // avionics / cockpit ventilation
    // continuous repetitive chime oscillator (gated)
    this.crcO = c.createOscillator(); this.crcO.type = 'sine'; this.crcO.frequency.value = 1350; this.crcG = c.createGain(); this.crcG.gain.value = 0; this.crcO.connect(this.crcG); this.crcG.connect(this.master); this.crcO.start();
    // stall / overspeed cricket
    this.crkO = c.createOscillator(); this.crkO.type = 'square'; this.crkO.frequency.value = 2800; this.crkG = c.createGain(); this.crkG.gain.value = 0; this.crkO.connect(this.crkG); this.crkG.connect(this.master); this.crkO.start();
  }
  tone(freq, dur, vol = 0.18, type = 'sine', delay = 0) {
    if (!this.ctx) return; const c = this.ctx, t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  click() { this.tone(2600, 0.025, 0.08, 'square'); }
  clack() { this.tone(900, 0.05, 0.12, 'square'); this.tone(180, 0.08, 0.15, 'triangle'); }
  single() { this.tone(1100, 0.55, 0.16); this.tone(2200, 0.4, 0.05); }
  ding() { this.tone(1318, 0.9, 0.12); this.tone(1046, 1.2, 0.1, 'sine', 0.45); }
  cchord() { for (const f of [523, 659, 784]) this.tone(f, 1.2, 0.06); }
  cavalry() { const n = [523, 659, 784, 1046, 784, 1046]; n.forEach((f, i) => this.tone(f, 0.18, 0.14, 'square', i * 0.13)); }
  squib() { this.tone(80, 0.25, 0.25, 'square'); }
  chirp(k) { this.tone(140, 0.25, Math.min(0.5, 0.15 + k * 0.4), 'triangle'); this.tone(70, 0.3, 0.3, 'sine'); }
  say(text, rate = 1.05) {
    if (!('speechSynthesis' in window)) return;
    try { const u = new SpeechSynthesisUtterance(text); u.rate = rate; u.pitch = 0.85; u.volume = 0.9; const v = speechSynthesis.getVoices().find((x) => /en-(US|GB)/.test(x.lang) && /male|David|Daniel|Alex|Fred/i.test(x.name)); if (v) u.voice = v; speechSynthesis.speak(u); } catch (e) { /* ignore */ }
  }
  event(name, arg) {
    switch (name) {
      case 'ding': this.ding(); break;
      case 'single': this.single(); break;
      case 'cavalry': this.cavalry(); break;
      case 'crc1': this.tone(1350, 0.25, 0.15); this.tone(1350, 0.25, 0.15, 'sine', 0.35); this.tone(1350, 0.25, 0.15, 'sine', 0.7); break;
      case 'squib': this.squib(); break;
      case 'cvr': this.tone(600, 1.0, 0.06); break;
      case 'apuavail': this.tone(880, 0.12, 0.05); break;
      case 'refuelDone': this.ding(); break;
      case 'click3': this.cchord(); break;
      case 'silence': this.crcSilenced = 4; if ('speechSynthesis' in window) speechSynthesis.cancel(); break;
      case 'park': this.clack(); break;
      case 'retard': this.say('retard, retard', 1.25); break;
      case 'flare': break;
      case 'callout': if (arg) this.say(String(arg)); break;
      default: break;
    }
  }
  update(f, S, view, simRate, dt = 1 / 60) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime + 0.03; const inside = view === 'cockpit' || view === 'cabin';
    this.cabin.frequency.setTargetAtTime(inside ? 1600 : 7000, t, 0.15);
    const muteK = simRate > 4 ? 0.3 : 1;
    for (let i = 0; i < 2; i++) {
      const E = f.E[i], e = this.eng[i]; const n1 = E.n1 / 100, n2 = (E.n3 ?? E.n2 ?? 0) / 100;
      e.o.frequency.setTargetAtTime(40 + n1 * 2650 / 60 * 22, t, 0.08); // 22 fan blades
      e.tone.f.frequency.setTargetAtTime(200 + n1 * 2650 / 60 * 22, t, 0.08);
      e.tone.g.gain.setTargetAtTime((0.025 + n1 * 0.05) * (n1 > 0.03 ? 1 : 0) * (inside ? 0.6 : 1.3) * muteK, t, 0.12);
      e.o2.frequency.setTargetAtTime(30 + n2 * 230, t, 0.1); e.buzz.g.gain.setTargetAtTime(n2 * 0.04 * muteK, t, 0.15);
      e.roar.f.frequency.setTargetAtTime(150 + n1 * 1200 + E.rev * 400, t, 0.15);
      e.roar.g.gain.setTargetAtTime((n1 * n1 * 0.45 + E.rev * 0.2) * (inside ? 0.45 : 1.2) * muteK, t, 0.15);
    }
    const apuN = (S?.apu?.n || 0) / 100;
    this.apu.o.frequency.setTargetAtTime(100 + apuN * 4000, t, 0.2); this.apu.t.g.gain.setTargetAtTime(apuN * 0.012 * (inside ? 0.4 : 1.5), t, 0.3); this.apu.n.g.gain.setTargetAtTime(apuN * 0.03 * (inside ? 0.3 : 1.4), t, 0.3);
    const ias = f.ind.ias || 0;
    this.wind.f.frequency.setTargetAtTime(300 + ias * 6, t, 0.2); this.wind.g.gain.setTargetAtTime(Math.min(0.35, (ias / 300) ** 2 * 0.3) * (inside ? 0.7 : 1), t, 0.2);
    this.rumble.g.gain.setTargetAtTime(f.onGround ? Math.min(0.5, f.ind.gs / 140 * 0.5) : (f.gear.pos > 0.9 ? Math.min(0.08, ias / 250 * 0.08) : 0), t, 0.06);
    const moving = Math.abs(f.gear.pos - (this.gp ?? f.gear.pos)) > 1e-5 || Math.abs((f.surf.flap + f.surf.slat) - (this.fl ?? 0)) > 1e-4; this.gp = f.gear.pos; this.fl = f.surf.flap + f.surf.slat;
    this.hyd.g.gain.setTargetAtTime(moving ? 0.05 : 0, t, 0.2);
    this.fans.g.gain.setTargetAtTime(S?.dcPowered ? (inside ? 0.012 : 0.002) : 0, t, 0.5);
    // aural warnings
    if (this.crcSilenced > 0) this.crcSilenced -= dt;
    const crc = !!S?.crcOn && !(this.crcSilenced > 0);
    if (crc) { this.crcT += dt; const ph = this.crcT % 0.5; this.crcG.gain.setTargetAtTime(ph < 0.28 ? 0.13 : 0, t, 0.01); } else { this.crcT = 0; this.crcG.gain.setTargetAtTime(0, t, 0.02); }
    const crk = f.stallWarn || f.ind.ias > 345 && !f.onGround;
    this.crkG.gain.setTargetAtTime(crk && (c.currentTime * 7) % 1 < 0.4 ? 0.06 : 0, t, 0.005);
    if (f.stallWarn && !this.stallSaid) { this.stallSaid = true; this.say('stall, stall'); setTimeout(() => (this.stallSaid = false), 3000); }
    // radio altimeter auto-callouts (descending, airborne)
    const raFt = (f.ra || 0) / FT;
    if (!f.onGround && f.ind.vsi < -100 && S?.acPowered) {
      for (const h of RA_CALLS) if (this.lastRa > h && raFt <= h) { this.say(RA_WORDS[h], h <= 50 ? 1.35 : 1.1); break; }
      if (this.minimums && this.lastRa > this.minimums + 100 && raFt <= this.minimums + 100) this.say('hundred above');
      if (this.minimums && this.lastRa > this.minimums && raFt <= this.minimums) this.say('minimum');
    }
    this.lastRa = raFt;
  }
  mute(m) { if (this.master) this.master.gain.value = m ? 0 : this.vol; }
}
