// Frame-rate meter for the HUD + a governor that trades render resolution / shadow refresh for frame rate.
const RATES = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 240];

export class PerfMonitor {
  constructor({ renderer, chip, detail }) {
    this.renderer = renderer; this.chip = chip; this.detail = detail;
    this.samples = []; this.hz = 60; this.target = 60;
    this.frames = 0; this.acc = 0; this.fps = 0; this.ms = 0; this.worst = 0;
    this.base = 1; this.scale = 1; this.minScale = 0.5; this.auto = true;
    this.low = 0; this.high = 0; this.govT = 0; this.shadowSkip = false; this.frameNo = 0;
    this.rating = 'good';
  }
  setBase(pr) { this.base = pr; this.apply(); }
  setAuto(on) { this.auto = on; if (!on) { this.scale = 1; this.shadowSkip = false; this.apply(); } }
  apply() { const pr = Math.max(0.35, this.base * this.scale); if (Math.abs(this.renderer.getPixelRatio() - pr) > 1e-3) this.renderer.setPixelRatio(pr); }
  // estimate the display refresh rate from the fastest frame intervals seen
  refreshRate(dt) {
    if (this.samples.length >= 240 || dt <= 0 || dt > 0.2) return;
    this.samples.push(dt);
    if (this.samples.length % 60 === 0) {
      const s = [...this.samples].sort((a, b) => a - b); const fast = s[Math.floor(s.length * 0.1)];
      const hz = 1 / fast; let best = 60, bd = 1e9; for (const r of RATES) { const d = Math.abs(r - hz); if (d < bd) { bd = d; best = r; } }
      this.hz = best; this.target = Math.min(60, best);
    }
  }
  // called once per rendered frame with the real (wall-clock) frame time in seconds
  frame(dt, info = {}) {
    this.frameNo++;
    this.refreshRate(dt);
    this.frames++; this.acc += dt; this.worst = Math.max(this.worst, dt);
    if (this.acc >= 0.5) {
      this.fps = this.frames / this.acc; this.ms = (this.acc / this.frames) * 1000;
      const worstMs = this.worst * 1000;
      this.frames = 0; this.acc = 0; this.worst = 0;
      const t = this.target;
      this.rating = this.fps >= t * 0.9 ? 'good' : this.fps >= Math.max(24, t * 0.5) ? 'ok' : 'poor';
      if (this.chip) {
        const word = { good: 'GOOD', ok: 'MEDIUM', poor: 'POOR' }[this.rating];
        this.chip.textContent = `${this.fps < 10 ? this.fps.toFixed(1) : Math.round(this.fps)} / ${t} FPS · ${word}`;
        this.chip.className = 'chip perfChip ' + this.rating;
        this.chip.title = `Running at ${this.fps.toFixed(0)} frames per second (${this.ms.toFixed(1)} ms per frame, slowest ${worstMs.toFixed(0)} ms).\n` +
          `Target: ${t} FPS (display ${this.hz} Hz). Good ≥ ${Math.round(t * 0.9)}, medium ≥ ${Math.round(Math.max(24, t * 0.5))}, below that is poor.\n` +
          `Render resolution ${Math.round(this.scale * 100)}%${this.auto ? ' (auto)' : ''}${this.shadowSkip ? ' · shadows every 2nd frame' : ''}. Click for details (;).`;
      }
      if (this.detail && !this.detail.classList.contains('hidden')) {
        const r = this.renderer.info.render;
        this.detail.textContent = `${this.fps.toFixed(0)} fps · ${this.ms.toFixed(1)} ms\ntarget ${t} (${this.hz} Hz)\nres ${Math.round(this.scale * 100)}%${this.shadowSkip ? ' · shadow ½' : ''}\n${r.calls} draw calls\n${(r.triangles / 1e6).toFixed(2)} M tris${info.extra ? '\n' + info.extra : ''}`;
      }
    }
    // governor: once a second, step resolution down when slow, back up when there is headroom
    this.govT += dt;
    if (this.auto && this.govT >= 1 && this.fps > 0) {
      this.govT = 0;
      const t = this.target;
      if (this.fps < t * 0.82) { this.low++; this.high = 0; } else if (this.fps > t * 0.97) { this.high++; this.low = 0; } else { this.low = 0; this.high = 0; }
      if (this.low >= 2) {
        this.low = 0;
        if (this.scale > this.minScale + 1e-3) { this.scale = Math.max(this.minScale, this.scale * 0.85); this.apply(); }
        else this.shadowSkip = true;
      } else if (this.high >= 5) {
        this.high = 0;
        if (this.shadowSkip) this.shadowSkip = false;
        else if (this.scale < 1) { this.scale = Math.min(1, this.scale * 1.12); this.apply(); }
      }
    }
  }
  // shadow map refresh: every frame, or every other frame when the governor is struggling
  shadowThisFrame() { return !this.shadowSkip || (this.frameNo & 1) === 0; }
}
