// Procedural WebAudio: Lycoming exhaust & prop, wind, stall horn, gear rumble, starter, touchdown chirps, clicks.
export class Sound {
  constructor() { this.ctx = null; this.enabled = true; this.vol = 0.7; }
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = this.vol; this.master.connect(c.destination);
    // cabin filter (headset attenuates highs)
    this.cabin = c.createBiquadFilter(); this.cabin.type = 'lowpass'; this.cabin.frequency.value = 2400; this.cabin.connect(this.master);
    const noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate); const d = noiseBuf.getChannelData(0);
    let b0 = 0; for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b0 = 0.97 * b0 + 0.03 * w; d[i] = w * 0.4 + b0 * 3; }
    const noise = () => { const s = c.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.start(); return s; };
    // engine: firing pulses = 4 cyl -> 2 pulses per rev. Use pulse oscillator + harmonics through formant filters
    this.engOsc = c.createOscillator(); this.engOsc.type = 'sawtooth';
    this.engOsc2 = c.createOscillator(); this.engOsc2.type = 'square';
    this.engF = c.createBiquadFilter(); this.engF.type = 'lowpass'; this.engF.Q.value = 3;
    this.engG = c.createGain(); this.engG.gain.value = 0;
    const g2 = c.createGain(); g2.gain.value = 0.35;
    this.engOsc.connect(this.engF); this.engOsc2.connect(g2); g2.connect(this.engF);
    // exhaust roughness: noise amplitude-modulated
    this.exN = noise(); this.exF = c.createBiquadFilter(); this.exF.type = 'bandpass'; this.exF.frequency.value = 300; this.exF.Q.value = 0.7;
    this.exG = c.createGain(); this.exG.gain.value = 0; this.exN.connect(this.exF); this.exF.connect(this.exG); this.exG.connect(this.cabin);
    this.engF.connect(this.engG); this.engG.connect(this.cabin);
    this.engOsc.start(); this.engOsc2.start();
    // prop blade-pass tone
    this.prop = c.createOscillator(); this.prop.type = 'triangle'; this.propG = c.createGain(); this.propG.gain.value = 0; this.prop.connect(this.propG); this.propG.connect(this.cabin); this.prop.start();
    // wind
    this.wN = noise(); this.wF = c.createBiquadFilter(); this.wF.type = 'bandpass'; this.wF.Q.value = 0.5; this.wG = c.createGain(); this.wG.gain.value = 0;
    this.wN.connect(this.wF); this.wF.connect(this.wG); this.wG.connect(this.master);
    // rumble (gear on ground)
    this.rN = noise(); this.rF = c.createBiquadFilter(); this.rF.type = 'lowpass'; this.rF.frequency.value = 120; this.rG = c.createGain(); this.rG.gain.value = 0;
    this.rN.connect(this.rF); this.rF.connect(this.rG); this.rG.connect(this.master);
    // stall horn (pneumatic reed ~ 1.6 kHz with warble)
    this.horn = c.createOscillator(); this.horn.type = 'sawtooth'; this.horn.frequency.value = 1650;
    this.hornF = c.createBiquadFilter(); this.hornF.type = 'bandpass'; this.hornF.frequency.value = 1700; this.hornF.Q.value = 4;
    this.hornG = c.createGain(); this.hornG.gain.value = 0; this.horn.connect(this.hornF); this.hornF.connect(this.hornG); this.hornG.connect(this.master); this.horn.start();
    // starter whine / gyro
    this.st = c.createOscillator(); this.st.type = 'sawtooth'; this.stG = c.createGain(); this.stG.gain.value = 0; const stF = c.createBiquadFilter(); stF.type = 'lowpass'; stF.frequency.value = 900;
    this.st.connect(stF); stF.connect(this.stG); this.stG.connect(this.master); this.st.start();
    this.gyro = c.createOscillator(); this.gyro.type = 'sine'; this.gyro.frequency.value = 3200; this.gyG = c.createGain(); this.gyG.gain.value = 0; this.gyro.connect(this.gyG); this.gyG.connect(this.master); this.gyro.start();
  }
  click() {
    if (!this.ctx) return; const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = 'square'; o.frequency.value = 2400; g.gain.setValueAtTime(0.12, c.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.03);
    o.connect(g); g.connect(this.master); o.start(); o.stop(c.currentTime + 0.04);
  }
  chirp(intensity) {
    if (!this.ctx) return; const c = this.ctx; const n = c.createBufferSource();
    const b = c.createBuffer(1, c.sampleRate * 0.25, c.sampleRate); const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * 0.05));
    n.buffer = b; const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600 + intensity * 1500; const g = c.createGain(); g.gain.value = Math.min(1, 0.25 + intensity);
    n.connect(f); f.connect(g); g.connect(this.master); n.start();
  }
  update(f, view, simRate) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime + 0.03, e = f.eng;
    const inside = view === 'cockpit' || view === 'cabin';
    this.cabin.frequency.setTargetAtTime(inside ? 1900 : 6000, t, 0.1);
    const rpm = e.rpm || 0;
    const fire = rpm / 60 * 2; // 4-cyl 4-stroke: 2 firing pulses per revolution
    const pwr = Math.min(1, (e.power || 0) / 134000);
    const run = e.running ? 1 : 0;
    this.engOsc.frequency.setTargetAtTime(Math.max(5, fire), t, 0.05);
    this.engOsc2.frequency.setTargetAtTime(Math.max(5, fire * 0.5), t, 0.05);
    this.engF.frequency.setTargetAtTime(180 + rpm * 0.25 + pwr * 500, t, 0.05);
    const eg = (run * (0.10 + pwr * 0.22) + (rpm > 40 && !run ? 0.04 : 0)) * (inside ? 1 : 0.8) * (simRate > 4 ? 0.3 : 1);
    this.engG.gain.setTargetAtTime(eg, t, 0.08);
    this.exF.frequency.setTargetAtTime(150 + rpm * 0.18, t, 0.05);
    this.exG.gain.setTargetAtTime(run * (0.05 + pwr * 0.25) + (rpm > 30 ? 0.02 : 0), t, 0.08);
    this.prop.frequency.setTargetAtTime(Math.max(5, rpm / 60 * 2), t, 0.05);
    this.propG.gain.setTargetAtTime(Math.min(0.1, rpm / 2700 * 0.06) * (inside ? 0.7 : 1.4), t, 0.1);
    const ias = f.tas / 0.5144;
    this.wF.frequency.setTargetAtTime(300 + ias * 12, t, 0.1);
    this.wG.gain.setTargetAtTime(Math.min(0.5, (ias / 140) ** 2 * 0.35) * (inside ? 0.6 : 1), t, 0.15);
    const onG = f.groundContact.left || f.groundContact.right || f.groundContact.nose;
    const gs = Math.hypot(f.vel[0], f.vel[2]);
    this.rG.gain.setTargetAtTime(onG ? Math.min(0.5, gs / 25 * 0.5) * (f.surfaceType === 'grass' ? 1.6 : 1) : 0, t, 0.05);
    this.hornG.gain.setTargetAtTime(f.stallWarn ? 0.16 : 0, t, 0.03);
    this.horn.frequency.setTargetAtTime(1600 + Math.sin(c.currentTime * 9) * 40, t, 0.01);
    const starting = f.sys.mags === 4 && f.elec;
    this.st.frequency.setTargetAtTime(60 + rpm * 0.4, t, 0.05);
    this.stG.gain.setTargetAtTime(starting ? 0.08 : 0, t, 0.05);
    this.gyG.gain.setTargetAtTime(inside ? 0.004 * f.gyro.aiSpin : 0, t, 0.5);
  }
  mute(m) { if (this.master) this.master.gain.value = m ? 0 : this.vol; }
}
