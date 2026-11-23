"""Bake per-airport orthophotos from USGS NAIP (public domain) into data/ortho/<ICAO>.jpg.
The image is resampled onto a world-aligned grid (x east, z south) so the shader maps it with a simple rect.
Also samples roof colours per building ('rc') and stores the ortho rect in airports.json ('ortho').
Usage: python3 tools/bake_imagery.py [ICAO ...]"""
import json, sys, io, os, time, urllib.request
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
sys.path.insert(0, os.path.dirname(__file__))
from proj import w2ll, ll2w

ROOT = os.path.join(os.path.dirname(__file__), '..')
SVC = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage'
MARGIN = 220

def fetch(lon0, lat0, lon1, lat1, w, h):
    url = f'{SVC}?bbox={lon0},{lat0},{lon1},{lat1}&bboxSR=4326&imageSR=4326&size={w},{h}&format=jpg&f=image&interpolation=RSP_BilinearInterpolation'
    for k in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as r: return np.asarray(Image.open(io.BytesIO(r.read())).convert('RGB'))
        except Exception as e:
            print('  retry', k, e); time.sleep(3)
    raise RuntimeError('NAIP fetch failed')

def grade_lut(img):
    """NAIP mosaics carry a strong haze lift (blacks ~70-90/255). Per-channel levels + slight gamma give
    ground albedo closer to what the eye sees on a clear day. Returns a (3,256) lookup table."""
    s = img[::4, ::4].reshape(-1, 3).astype(np.float32); lut = np.zeros((3, 256), np.uint8)
    for k in range(3):
        lo, hi = np.percentile(s[:, k], 0.5) * 0.9, np.percentile(s[:, k], 99.7)
        x = np.clip((np.arange(256) - lo) / max(hi - lo, 1), 0, 1) ** 1.15
        lut[k] = np.clip(8 + x * 227, 0, 255).astype(np.uint8)
    return lut

def bounds(a):
    xs, zs = [], []
    for r in a['runways']:
        for e in (r['le'], r['he']): xs.append(e[0]); zs.append(e[1])
    for coll in ('taxiways', 'aprons'):
        for t in a[coll]:
            for q in t['p']: xs.append(q[0]); zs.append(q[1])
    # buildings only near the airfield core (exclude far suburban houses)
    cx, cz = np.median(xs), np.median(zs); R = max(np.ptp(xs), np.ptp(zs)) * 0.75 + 150
    for b in a['buildings']:
        for q in b['p']:
            if abs(q[0] - cx) < R and abs(q[1] - cz) < R: xs.append(q[0]); zs.append(q[1])
    return min(xs) - MARGIN, min(zs) - MARGIN, max(xs) + MARGIN, max(zs) + MARGIN

def bake(a):
    x0, z0, x1, z1 = bounds(a)
    W, H = x1 - x0, z1 - z0
    mpp = max(0.6 if a['size'] == 'S' else 1.0, max(W, H) / 4096)
    nx, nz = int(np.ceil(W / mpp)), int(np.ceil(H / mpp))
    # source lat/lon image covering the rect (tile it if large; service max ~4000 px)
    la, lo = w2ll(np.array([x0, x1, x0, x1]), np.array([z0, z0, z1, z1]))
    lat0, lat1, lon0, lon1 = la.min() - 1e-4, la.max() + 1e-4, lo.min() - 1e-4, lo.max() + 1e-4
    sh = int(nz * 1.08) + 8; dd = (lat1 - lat0) / sh   # square pixels in degree space (the service enforces it)
    sw = int(np.ceil((lon1 - lon0) / dd)); lon1 = lon0 + sw * dd
    T = 3000; tiles_x = int(np.ceil(sw / T)); tiles_y = int(np.ceil(sh / T))
    src = np.zeros((sh, sw, 3), np.uint8)
    for ty in range(tiles_y):
        for tx in range(tiles_x):
            px0, px1 = tx * sw // tiles_x, (tx + 1) * sw // tiles_x
            py0, py1 = ty * sh // tiles_y, (ty + 1) * sh // tiles_y
            l0 = lon0 + (lon1 - lon0) * px0 / sw; l1 = lon0 + (lon1 - lon0) * px1 / sw
            t0 = lat1 - (lat1 - lat0) * py0 / sh; t1 = lat1 - (lat1 - lat0) * py1 / sh
            img = fetch(l0, t1, l1, t0, px1 - px0, py1 - py0)
            hh, ww = min(img.shape[0], py1 - py0), min(img.shape[1], px1 - px0)
            src[py0:py0 + hh, px0:px0 + ww] = img[:hh, :ww]
    # resample to the world grid
    gx = x0 + (np.arange(nx) + 0.5) * mpp; gz = z0 + (np.arange(nz) + 0.5) * mpp
    GX, GZ = np.meshgrid(gx, gz)
    LA, LO = w2ll(GX, GZ)
    u = (LO - lon0) / (lon1 - lon0) * sw - 0.5; v = (lat1 - LA) / (lat1 - lat0) * sh - 0.5
    u0 = np.clip(np.floor(u).astype(int), 0, sw - 2); v0 = np.clip(np.floor(v).astype(int), 0, sh - 2)
    fu = np.clip(u - u0, 0, 1)[..., None]; fv = np.clip(v - v0, 0, 1)[..., None]
    s = src.astype(np.float32)
    out = (s[v0, u0] * (1 - fu) * (1 - fv) + s[v0, u0 + 1] * fu * (1 - fv) + s[v0 + 1, u0] * (1 - fu) * fv + s[v0 + 1, u0 + 1] * fu * fv)
    out = np.clip(out, 0, 255).astype(np.uint8)
    lut = grade_lut(out); out = np.stack([lut[k][out[..., k]] for k in range(3)], -1)
    os.makedirs(os.path.join(ROOT, 'data/ortho'), exist_ok=True)
    Image.fromarray(out).save(os.path.join(ROOT, f"data/ortho/{a['icao']}.jpg"), quality=84, optimize=True, progressive=True)
    # roof / pavement colour sampling
    def px(q): return (q[0] - x0) / mpp, (q[1] - z0) / mpp
    lab = Image.new('I', (nx, nz), 0); d = ImageDraw.Draw(lab)
    for i, b in enumerate(a['buildings']):
        pts = [px(q) for q in b['p']]
        if len(pts) >= 3: d.polygon(pts, fill=i + 1)
    L = np.asarray(lab)
    # shrink building masks 1 m to avoid wall/shadow edges: erode via min filter on 'inside' check
    idx = L.ravel(); cols = out.reshape(-1, 3)
    order = np.argsort(idx, kind='stable'); si = idx[order]
    starts = np.searchsorted(si, np.arange(1, len(a['buildings']) + 2))
    nrc = 0
    for i, b in enumerate(a['buildings']):
        s0, s1 = starts[i], starts[i + 1]
        if s1 - s0 < 6: b.pop('rc', None); continue
        c = cols[order[s0:s1]].astype(float)
        lum = c.mean(1); keep = c[(lum > np.percentile(lum, 20)) & (lum < np.percentile(lum, 95))]
        if len(keep) < 3: keep = c
        m = np.median(keep, 0); b['rc'] = '#%02x%02x%02x' % tuple(int(v) for v in m); nrc += 1
    a['ortho'] = {'x0': round(x0, 1), 'z0': round(z0, 1), 'x1': round(x0 + nx * mpp, 1), 'z1': round(z0 + nz * mpp, 1), 'mpp': round(mpp, 3), 'w': nx, 'h': nz, 'graded': 1}
    print(a['icao'], f'{nx}x{nz} @ {mpp:.2f} m/px, roof colours {nrc}/{len(a["buildings"])}', flush=True)

if __name__ == '__main__':
    path = os.path.join(ROOT, 'data/airports.json'); A = json.load(open(path))
    want = set(sys.argv[1:])
    for a in A:
        if want and a['icao'] not in want: continue
        bake(a)
        json.dump(A, open(path, 'w'), separators=(',', ':'))
