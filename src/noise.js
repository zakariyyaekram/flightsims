// Seeded 2D simplex noise + fractal helpers (deterministic: same terrain every session)
const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
const perm = new Uint8Array(512), grad = new Float32Array(512 * 2);
(function seed(s = 1337) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let r = s;
  const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    const a = (perm[i] / 256) * Math.PI * 2;
    grad[i * 2] = Math.cos(a); grad[i * 2 + 1] = Math.sin(a);
  }
})();

export function simplex(x, y) {
  const s = (x + y) * F2;
  const i = Math.floor(x + s), j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t), y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  const ii = i & 255, jj = j & 255;
  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) { const g = perm[ii + perm[jj]] * 2; t0 *= t0; n += t0 * t0 * (grad[g] * x0 + grad[g + 1] * y0); }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) { const g = perm[ii + i1 + perm[jj + j1]] * 2; t1 *= t1; n += t1 * t1 * (grad[g] * x1 + grad[g + 1] * y1); }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) { const g = perm[ii + 1 + perm[jj + 1]] * 2; t2 *= t2; n += t2 * t2 * (grad[g] * x2 + grad[g + 1] * y2); }
  return 70 * n; // ~[-1,1]
}

export function fbm(x, y, oct = 5, lac = 2.03, gain = 0.5) {
  let a = 1, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * simplex(x * f + i * 17.3, y * f - i * 9.1); n += a; a *= gain; f *= lac; }
  return s / n;
}
export function ridged(x, y, oct = 6) {
  let a = 1, f = 1, s = 0, n = 0, w = 1;
  for (let i = 0; i < oct; i++) {
    let v = 1 - Math.abs(simplex(x * f + i * 31.7, y * f + i * 11.3));
    v *= v; v *= w; w = Math.min(1, Math.max(0, v * 1.6));
    s += v * a; n += a; a *= 0.5; f *= 2.05;
  }
  return s / n;
}
export function hash2(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
