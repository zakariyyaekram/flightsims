"""Flatten the DEM under every airport (plane through the published runway-end elevations), remove water/trees/
built-up cover inside aerodromes, then write data/dem.png + data/cover.png. Run after bake_terrain.py and bake_airports.py."""
import numpy as np, json, math, sys
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt
sys.path.insert(0, '/home/user/workspace/flightsims/tools')
from proj import ll2w
from shapely.geometry import shape
RAW = '/home/user/workspace/raw/'; OUT = '/home/user/workspace/flightsims/data/'
g = json.load(open(OUT + 'grid.json')); C, X0, Z0, NX, NZ = g['cell'], g['x0'], g['z0'], g['nx'], g['nz']
H = np.load(RAW + 'H.npy'); Wt = np.load(RAW + 'W.npy')
cov = np.asarray(Image.open(OUT + 'cover.png')).copy()
aps = json.load(open(OUT + 'airports.json'))
def gp(p): return ((p[0] - X0) / C, (p[1] - Z0) / C)
# aerodrome polygons (no procedural trees / houses inside the fence)
fence = Image.new('L', (NX, NZ), 0); fd = ImageDraw.Draw(fence)
for l in open(RAW + 'aero.geojson'):
    f = json.loads(l.strip('\x1e'))
    if f['properties'].get('aeroway') == 'aerodrome' and f['geometry']['type'] == 'MultiPolygon':
        for pg in shape(f['geometry']).geoms:
            xs, ys = pg.exterior.coords.xy; x, z = ll2w(np.array(ys), np.array(xs))
            fd.polygon([gp(q) for q in zip(x, z)], fill=255)
fence = np.asarray(fence) > 0
for a in aps:
    m = Image.new('L', (NX, NZ), 0); d = ImageDraw.Draw(m)
    E = []
    for r in a['runways']:
        (lx, lz), (hx, hz) = r['le'], r['he']; L = r['len']; dx, dz = (hx - lx) / L, (hz - lz) / L; px, pz = -dz, dx
        ex, hw = 90, r['wid'] / 2 + 70
        pts = [(lx - dx * ex + px * s * hw, lz - dz * ex + pz * s * hw) for s in (-1, 1)] + [(hx + dx * ex + px * s * hw, hz + dz * ex + pz * s * hw) for s in (1, -1)]
        d.polygon([gp(q) for q in pts], fill=255)
        E += [(lx, lz, r['elev'][0]), (hx, hz, r['elev'][1])]
    for ap in a['aprons']: d.polygon([gp(q) for q in ap['p']], fill=255)
    for t in a['taxiways']: d.line([gp(q) for q in t['p']], fill=255, width=max(1, int(round((t['w'] + 30) / C))))
    m = np.asarray(m) > 0
    # least-squares plane z = c0 + c1 x + c2 z, slope clamped to 1 %
    A = np.array([[1, e[0] - a['x'], e[1] - a['z']] for e in E]); y = np.array([e[2] for e in E])
    A = np.vstack([A, [[0, 200, 0], [0, 0, 200]]]); y = np.concatenate([y, [0, 0]])  # prefer level when under-determined
    c = np.linalg.lstsq(A, y, rcond=None)[0]; s = math.hypot(c[1], c[2])
    if s > 0.01: c[1:] *= 0.01 / s
    rows, cols = np.mgrid[0:NZ, 0:NX]
    bb = np.argwhere(m); r0, c0 = bb.min(0) - 12; r1, c1 = bb.max(0) + 12
    r0, c0 = max(r0, 0), max(c0, 0)
    sub = m[r0:r1, c0:c1]
    dist = distance_transform_edt(~sub) * C
    X = X0 + cols[r0:r1, c0:c1] * C; Z = Z0 + rows[r0:r1, c0:c1] * C
    P = c[0] + c[1] * (X - a['x']) + c[2] * (Z - a['z'])
    t = np.clip(dist / 450, 0, 1); t = t * t * (3 - 2 * t)
    H[r0:r1, c0:c1] = P * (1 - t) + H[r0:r1, c0:c1] * t
    Wt[r0:r1, c0:c1] = np.where(dist < 60, 0, Wt[r0:r1, c0:c1])
    a['plane'] = [round(float(v), 6) for v in c]
    print(a['icao'], 'plane', a['plane'], 'dem before', 'cells', int(sub.sum()))
cov[fence] = 0
H = np.clip(H, -60, 1500)
q = np.round((H + 100) * 10).astype(np.uint16)
dem = np.stack([(q >> 8).astype(np.uint8), (q & 255).astype(np.uint8), np.round(Wt * 255).astype(np.uint8)], -1)
Image.fromarray(dem, 'RGB').save(OUT + 'dem.png', optimize=True)
Image.fromarray(cov, 'RGB').save(OUT + 'cover.png', optimize=True)
json.dump(aps, open(OUT + 'airports.json', 'w'), separators=(',', ':'))
