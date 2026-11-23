"""Patch orthophoto areas that changed after the NAIP flight.
KNUQ Hangar 3 (1943 wooden airship hangar) was dismantled 2024-25 down to its concrete pad (NASA Ames
historic-properties Section 106 records); OSM keeps the outline as demolished:building=hangar.
The pad and the hangar's shadow are repainted with apron concrete."""
import json, os, numpy as np
from PIL import Image, ImageDraw, ImageFilter
ROOT = os.path.join(os.path.dirname(__file__), '..')
PATCH = {'KNUQ': [[[29702.6, 22507.5], [29828.6, 22812.4], [29907.3, 22780.2], [29904.1, 22772.4], [29927.2, 22763.0], [29810.1, 22479.8], [29788.2, 22488.8], [29782.4, 22474.8], [29702.6, 22507.5]]]}
A = {a['icao']: a for a in json.load(open(os.path.join(ROOT, 'data/airports.json')))}
for ic, polys in PATCH.items():
    o = A[ic]['ortho']; path = os.path.join(ROOT, f'data/ortho/{ic}.jpg')
    im = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    P = lambda q: ((q[0] - o['x0']) / o['mpp'], (q[1] - o['z0']) / o['mpp'])
    m = Image.new('L', (im.shape[1], im.shape[0]), 0); d = ImageDraw.Draw(m)
    for poly in polys:
        d.polygon([P(q) for q in poly], fill=255)
        # the 52 m hangar cast a long shadow to the north-west in the late-morning flight
        d.polygon([P((q[0] - 34, q[1] - 22)) for q in poly], fill=255)
    m = m.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(3))
    M = np.asarray(m).astype(np.float32)[..., None] / 255
    # concrete: median colour of the ring just outside the patch, with slab joints and grain
    ring = (np.asarray(m.filter(ImageFilter.MaxFilter(41))) > 0) & (M[..., 0] < 0.01)
    base = np.median(im[ring], 0)
    h, w = im.shape[:2]; yy, xx = np.mgrid[0:h, 0:w]
    rng = np.random.default_rng(3); grain = rng.normal(0, 4, (h, w, 1))
    joints = ((np.mod(xx * o['mpp'], 7.5) < 0.5) | (np.mod(yy * o['mpp'], 7.5) < 0.5))[..., None] * -10
    fill = base[None, None] + grain + joints
    out = im * (1 - M) + fill * M
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(path, quality=84, optimize=True, progressive=True)
    print('patched', ic, base)
