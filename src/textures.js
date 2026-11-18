// Photographic PBR textures (Poly Haven, CC0) loaded straight from their CDN (CORS enabled).
import * as THREE from 'three';

export const PH = (name, map, res = '1k') => `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/${res}/${name}/${name}_${map}_${res}.jpg`;
export const PHM = (name, map, res = '1k') => `https://dl.polyhaven.org/file/ph-assets/Models/jpg/${res}/${name}/${name}_${map}_${res}.jpg`;

let maxAniso = 8;
export function setAniso(n) { maxAniso = n; }

const cache = new Map();
export function loadImage(url) {
  if (cache.has(url)) return cache.get(url);
  const p = new Promise((res) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => { console.warn('texture failed', url); res(null); };
    img.src = url;
  });
  cache.set(url, p);
  return p;
}

export async function tex(url, { repeat = 1, srgb = true, wrap = true } = {}) {
  const img = await loadImage(url);
  const t = new THREE.Texture(img || fallbackCanvas());
  t.needsUpdate = true;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (wrap) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); }
  t.anisotropy = maxAniso;
  return t;
}

function fallbackCanvas() {
  const c = document.createElement('canvas'); c.width = c.height = 4;
  const g = c.getContext('2d'); g.fillStyle = '#777'; g.fillRect(0, 0, 4, 4); return c;
}

// Build a 2D texture array from several images (all resized to `size`). Returns texture + average colors.
export async function texArray(urls, size = 1024, srgb = true) {
  const imgs = await Promise.all(urls.map(loadImage));
  const data = new Uint8Array(size * size * 4 * urls.length);
  const avg = [];
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  imgs.forEach((img, i) => {
    if (img) g.drawImage(img, 0, 0, size, size); else { g.fillStyle = '#808080'; g.fillRect(0, 0, size, size); }
    let d;
    try { d = g.getImageData(0, 0, size, size).data; } catch (e) { d = new Uint8ClampedArray(size * size * 4).fill(128); }
    data.set(d, i * size * size * 4);
    let r = 0, gg = 0, b = 0;
    for (let k = 0; k < d.length; k += 64) { r += d[k]; gg += d[k + 1]; b += d[k + 2]; }
    const n = d.length / 64;
    avg.push([r / n / 255, gg / n / 255, b / n / 255]);
  });
  const t = new THREE.DataArrayTexture(data, size, size, urls.length);
  t.format = THREE.RGBAFormat;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = maxAniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return { texture: t, avg };
}
