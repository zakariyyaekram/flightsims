"""Bake real terrain + land cover for the Bay Area world.
Inputs: AWS Terrain Tiles (terrarium z12, raw/dem), ESA WorldCover 2021 10 m (raw/wc.npy)
Outputs: data/dem.png  (R,G = (h+100)*10 big-endian uint16, B = water fraction*255)
         data/cover.png (R = tree, G = built-up, B = cropland fraction*255)
Grid: cell CELL m, origin (X0,Z0) = north-west corner; row = z, col = x."""
import numpy as np, sys, json
from PIL import Image
sys.path.insert(0, '/home/user/workspace/flightsims/tools')
from proj import w2ll
RAW = '/home/user/workspace/raw/'; OUT = '/home/user/workspace/flightsims/data/'
CELL = 50; X0, X1, Z0, Z1 = -26000, 58000, -80000, 40000
NX, NZ = (X1 - X0) // CELL + 1, (Z1 - Z0) // CELL + 1
# --- DEM mosaic (web mercator z12)
Z = 12; tx0, tx1, ty0, ty1 = 651, 663, 1574, 1591
mos = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.float32)
for x in range(tx0, tx1 + 1):
    for y in range(ty0, ty1 + 1):
        a = np.asarray(Image.open(f'{RAW}dem/{Z}_{x}_{y}.png').convert('RGB')).astype(np.float32)
        mos[(y - ty0) * 256:(y - ty0 + 1) * 256, (x - tx0) * 256:(x - tx0 + 1) * 256] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
wc = np.load(RAW + 'wc.npy', mmap_mode='r')
WLON0, WLAT0, WD = -122.7, 38.36, 8.333333333333333e-05
def bil(img, fx, fy):
    x0 = np.clip(np.floor(fx).astype(int), 0, img.shape[1] - 2); y0 = np.clip(np.floor(fy).astype(int), 0, img.shape[0] - 2)
    tx = np.clip(fx - x0, 0, 1); ty = np.clip(fy - y0, 0, 1)
    return (img[y0, x0] * (1 - tx) * (1 - ty) + img[y0, x0 + 1] * tx * (1 - ty) + img[y0 + 1, x0] * (1 - tx) * ty + img[y0 + 1, x0 + 1] * tx * ty)
H = np.zeros((NZ, NX), np.float32); W = np.zeros((NZ, NX), np.float32)
T = np.zeros((NZ, NX), np.float32); B = np.zeros((NZ, NX), np.float32); C = np.zeros((NZ, NX), np.float32)
xs = X0 + np.arange(NX) * CELL
offs = [(-20, -20), (0, -20), (20, -20), (-20, 0), (0, 0), (20, 0), (-20, 20), (0, 20), (20, 20), (-10, -10), (10, 10), (-10, 10), (10, -10)]
for r in range(NZ):
    z = Z0 + r * CELL
    lat, lon = w2ll(xs, np.full(NX, float(z)))
    n = 2 ** Z
    fx = (lon + 180) / 360 * n * 256 - tx0 * 256 - 0.5
    lr = np.radians(lat); fy = (1 - np.log(np.tan(lr) + 1 / np.cos(lr)) / np.pi) / 2 * n * 256 - ty0 * 256 - 0.5
    H[r] = bil(mos, fx, fy)
    acc = {k: np.zeros(NX, np.float32) for k in (80, 10, 50, 40, 90)}
    for ox, oz in offs:
        la, lo = w2ll(xs + ox, np.full(NX, float(z + oz)))
        c = np.clip(((lo - WLON0) / WD).astype(int), 0, wc.shape[1] - 1); rr = np.clip(((WLAT0 - la) / WD).astype(int), 0, wc.shape[0] - 1)
        v = wc[rr, c]
        for k in acc: acc[k] += (v == k)
    W[r] = acc[80] / len(offs); T[r] = acc[10] / len(offs); B[r] = acc[50] / len(offs); C[r] = acc[40] / len(offs)
    if r % 400 == 0: print(r, NZ, flush=True)
# shoreline conditioning: open water sits below 0, dry land above it
H = np.where(W > 0.5, np.minimum(H, -1.5 - 6 * (W - 0.5)), H)
H = np.where(W < 0.35, np.maximum(H, 0.6), H)
H = np.clip(H, -60, 1500)
q = np.round((H + 100) * 10).astype(np.uint16)
dem = np.stack([(q >> 8).astype(np.uint8), (q & 255).astype(np.uint8), np.round(W * 255).astype(np.uint8)], -1)
Image.fromarray(dem, 'RGB').save(OUT + 'dem.png', optimize=True)
cov = np.stack([np.round(T * 255), np.round(B * 255), np.round(C * 255)], -1).astype(np.uint8)
Image.fromarray(cov, 'RGB').save(OUT + 'cover.png', optimize=True)
json.dump({'cell': CELL, 'x0': X0, 'z0': Z0, 'nx': NX, 'nz': NZ}, open(OUT + 'grid.json', 'w'))
np.save(RAW + 'H.npy', H); np.save(RAW + 'W.npy', W)
print('done', NX, NZ, H.min(), H.max())
