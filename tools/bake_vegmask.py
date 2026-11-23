"""Tree-cover mask per airport ortho rect from NAIP colour-infrared (NDVI + darkness + texture).
Writes data/ortho/<ICAO>_veg.png (8-bit, ~4 m/px, world-aligned like the ortho). The game uses it so procedural
trees only grow where the photo actually shows trees.
Usage: python3 tools/bake_vegmask.py [ICAO ...]  (run after bake_imagery.py)"""
import json, sys, io, os, time, urllib.request
import numpy as np
from PIL import Image, ImageFilter
sys.path.insert(0, os.path.dirname(__file__))
from proj import w2ll
ROOT = os.path.join(os.path.dirname(__file__), '..')
SVC = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage'
MPP = 4.0

def fetch(l0, t0, l1, t1, w, h, bands):
    url = f'{SVC}?bbox={l0},{t0},{l1},{t1}&bboxSR=4326&imageSR=4326&size={w},{h}&format=png&bandIds={bands}&f=image'
    for k in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as r: return np.asarray(Image.open(io.BytesIO(r.read())).convert('RGB')).astype(np.float32) / 255
        except Exception as e: print('  retry', k, e); time.sleep(3)
    raise RuntimeError('fetch failed')

def bake(a):
    o = a['ortho']; x0, z0, x1, z1 = o['x0'], o['z0'], o['x1'], o['z1']
    nx, nz = int(np.ceil((x1 - x0) / MPP)), int(np.ceil((z1 - z0) / MPP))
    la, lo = w2ll(np.array([x0, x1, x0, x1]), np.array([z0, z0, z1, z1]))
    lat0, lat1, lon0, lon1 = la.min() - 1e-4, la.max() + 1e-4, lo.min() - 1e-4, lo.max() + 1e-4
    sh = int(nz * 1.05) + 4; dd = (lat1 - lat0) / sh; sw = int(np.ceil((lon1 - lon0) / dd)); lon1 = lon0 + sw * dd
    cir = fetch(lon0, lat0, lon1, lat1, sw, sh, '3,0,1')   # NIR, R, G
    gx = x0 + (np.arange(nx) + 0.5) * MPP; gz = z0 + (np.arange(nz) + 0.5) * MPP
    GX, GZ = np.meshgrid(gx, gz); LA, LO = w2ll(GX, GZ)
    u = np.clip(((LO - lon0) / (lon1 - lon0) * sw).astype(int), 0, sw - 1); v = np.clip(((lat1 - LA) / (lat1 - lat0) * sh).astype(int), 0, sh - 1)
    c = cir[v, u]; nir, r, g = c[..., 0], c[..., 1], c[..., 2]
    ndvi = (nir - r) / (nir + r + 1e-3); vis = (r + g) / 2
    # texture: local std-dev of NIR (tree crowns are lumpy; lawns and crops are smooth)
    im = Image.fromarray((nir * 255).astype(np.uint8))
    m1 = np.asarray(im.filter(ImageFilter.BoxBlur(2))).astype(np.float32) / 255
    m2 = np.asarray(Image.fromarray((nir * nir * 255).astype(np.uint8)).filter(ImageFilter.BoxBlur(2))).astype(np.float32) / 255
    sd = np.sqrt(np.maximum(m2 - m1 * m1, 0))
    # darkness from the true-colour ortho (tree crowns are darker than lawns, crops and marsh)
    rgb = np.asarray(Image.open(os.path.join(ROOT, f"data/ortho/{a['icao']}.jpg")).resize((nx, nz), Image.BOX)).astype(np.float32) / 255
    lum = rgb @ np.array([0.3, 0.59, 0.11], np.float32)
    tree = np.clip((ndvi - 0.06) / 0.14, 0, 1) * np.clip((np.percentile(lum, 35) - lum) / 0.08 + 0.3, 0, 1) * np.clip((sd - 0.02) / 0.05, 0.3, 1)
    out = Image.fromarray((tree * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1))
    out.save(os.path.join(ROOT, f"data/ortho/{a['icao']}_veg.png"), optimize=True)
    print(a['icao'], nx, nz, 'tree cover %.1f%%' % (100 * (tree > 0.5).mean()), flush=True)

if __name__ == '__main__':
    A = json.load(open(os.path.join(ROOT, 'data/airports.json'))); want = set(sys.argv[1:])
    for a in A:
        if a.get('ortho') and (not want or a['icao'] in want): bake(a)
