"""Bake the OSM road network -> data/roads.json (major roads, always loaded) + data/streets/<tx>_<tz>.json (local streets, streamed).
Bridge decks get a height profile; everything else follows the terrain at runtime."""
import json, math, sys, os, collections
import numpy as np
from shapely.geometry import shape, LineString
from scipy.ndimage import distance_transform_edt
sys.path.insert(0, '/home/user/workspace/flightsims/tools')
from proj import ll2w
RAW = '/home/user/workspace/raw/'; OUT = '/home/user/workspace/flightsims/data/'
g = json.load(open(OUT + 'grid.json')); C, X0, Z0, NX, NZ = g['cell'], g['x0'], g['z0'], g['nx'], g['nz']
H = np.load(RAW + 'H.npy'); Wt = np.load(RAW + 'W.npy')
shore = distance_transform_edt(Wt > 0.5) * C   # distance (m) from dry land, inside water
def samp(A, x, z):
    fx = np.clip((x - X0) / C, 0, NX - 1.001); fz = np.clip((z - Z0) / C, 0, NZ - 1.001)
    i, j = int(fz), int(fx); tx, tz = fx - j, fz - i
    return A[i, j] * (1 - tx) * (1 - tz) + A[i, j + 1] * tx * (1 - tz) + A[i + 1, j] * (1 - tx) * tz + A[i + 1, j + 1] * tx * tz
MAJOR = ['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link']
MINOR = ['tertiary', 'residential', 'unclassified', 'living_street', 'secondary_link', 'tertiary_link']
CAPS = [('Golden Gate', 67), ('Bay Bridge', 55), ('San Francisco-Oakland', 55), ('Richmond', 42), ('Carquinez', 45), ('Zampa', 45), ('Benicia', 40),
        ('San Mateo', 13), ('Hayward', 13), ('Dumbarton', 16), ('Antioch', 40), ('Napa River', 25)]
DEFW = {'motorway': 3.7, 'trunk': 3.6, 'primary': 3.5, 'secondary': 3.4, 'tertiary': 3.3, 'motorway_link': 4.5, 'trunk_link': 4.5, 'primary_link': 4.0}
EXT = (X0 + 500, X0 + (NX - 1) * C - 500, Z0 + 500, Z0 + (NZ - 1) * C - 500)
names = []; nidx = {}
def name_id(n):
    if not n: return -1
    if n not in nidx: nidx[n] = len(names); names.append(n)
    return nidx[n]
major = []; tiles = collections.defaultdict(list); TS = 4000
nb = 0
for l in open(RAW + 'roads.geojson'):
    f = json.loads(l.strip('\x1e')); p = f['properties']; hw = p.get('highway')
    if f['geometry']['type'] != 'LineString': continue
    if hw not in MAJOR: continue
    if p.get('tunnel') in ('yes', 'building_passage'): continue
    if p.get('access') in ('no', 'private') or p.get('area') == 'yes': continue
    c = np.array(f['geometry']['coordinates']); x, z = ll2w(c[:, 1], c[:, 0])
    if x.max() < EXT[0] or x.min() > EXT[1] or z.max() < EXT[2] or z.min() > EXT[3]: continue
    ls = LineString(list(zip(x, z))).simplify(2.5 if hw in ('motorway', 'trunk') else 3.0)
    pts = np.array(ls.coords)
    try: lanes = int(str(p.get('lanes', '')).split(';')[0])
    except: lanes = {'motorway': 3, 'trunk': 2, 'primary': 2, 'secondary': 2, 'tertiary': 2}.get(hw, 1)
    oneway = p.get('oneway') == 'yes' or hw in ('motorway', 'motorway_link') or p.get('junction') == 'roundabout'
    if not oneway and lanes == 1 and not hw.endswith('_link'): lanes = 2
    bridge = p.get('bridge') not in (None, 'no')
    rec = [MAJOR.index(hw), lanes, (1 if oneway else 0) | (2 if bridge else 0), name_id(p.get('ref') or p.get('name')),
           [int(round(v)) for xy in pts for v in xy]]
    if bridge:
        nb += 1
        # resample at <= 25 m so the deck can arch
        L = ls.length; n = max(2, int(math.ceil(L / 25)) + 1)
        rs = [ls.interpolate(i / (n - 1), normalized=True) for i in range(n)]
        rec[4] = [int(round(v)) for q in rs for v in (q.x, q.y)]
        nm = (p.get('name') or '') + ' ' + (p.get('bridge:name') or '')
        cap = next((cv for k, cv in CAPS if k in nm), 22)
        e0 = max(samp(H, rs[0].x, rs[0].y), 1.0); e1 = max(samp(H, rs[-1].x, rs[-1].y), 1.0)
        ys = []
        for i, q in enumerate(rs):
            s = i / (n - 1) * L; base = e0 + (e1 - e0) * s / L
            sd = samp(shore, q.x, q.y)
            if sd > 0: y = max(base, min(cap, 6 + sd * (0.09 if cap > 30 else 0.045)))
            else:
                hump = min(7.0, L * 0.07) * max(0.0, math.sin(math.pi * s / L)) ** 0.6 if L < 400 else 0
                y = max(base + hump, samp(H, q.x, q.y) + (hump if L < 400 else 2))
            ys.append(int(round(y * 10)))
        rec.append(ys)
    major.append(rec)
json.dump({'kinds': MAJOR, 'defw': DEFW, 'names': names, 'ways': major}, open(OUT + 'roads.json', 'w'), separators=(',', ':'))
print('major ways', len(major), 'bridges', nb, os.path.getsize(OUT + 'roads.json'))

# ---------- local streets, tiled ----------
for fn in ('roads.geojson', 'streets.geojson'):
    for l in open(RAW + fn):
        f = json.loads(l.strip('\x1e')); p = f['properties']; hw = p.get('highway')
        if f['geometry']['type'] != 'LineString' or hw not in MINOR: continue
        if fn == 'roads.geojson' and hw != 'tertiary': continue
        if fn == 'streets.geojson' and hw == 'tertiary': continue
        if p.get('tunnel') == 'yes' or p.get('area') == 'yes': continue
        c = np.array(f['geometry']['coordinates']); x, z = ll2w(c[:, 1], c[:, 0])
        if x.max() < EXT[0] or x.min() > EXT[1] or z.max() < EXT[2] or z.min() > EXT[3]: continue
        pts = np.array(LineString(list(zip(x, z))).simplify(2.0).coords)
        mx, mz = pts.mean(0); tx, tz = int(math.floor(mx / TS)), int(math.floor(mz / TS))
        try: lanes = int(str(p.get('lanes', '')).split(';')[0])
        except: lanes = 2 if hw == 'tertiary' else 1
        k = MINOR.index(hw)
        bridge = p.get('bridge') not in (None, 'no')
        tiles[(tx, tz)].append([k, lanes, (1 if p.get('oneway') == 'yes' else 0) | (2 if bridge else 0), [int(round(v)) for xy in pts for v in xy]])
os.makedirs(OUT + 'streets', exist_ok=True)
for f_ in os.listdir(OUT + 'streets'): os.remove(OUT + 'streets/' + f_)
tot = 0
for (tx, tz), ws in tiles.items():
    fn = OUT + f'streets/{tx}_{tz}.json'
    json.dump({'kinds': MINOR, 'ways': ws}, open(fn, 'w'), separators=(',', ':')); tot += os.path.getsize(fn)
json.dump(sorted([f'{a}_{b}' for a, b in tiles]), open(OUT + 'streets/index.json', 'w'))
print('street tiles', len(tiles), 'ways', sum(len(v) for v in tiles.values()), 'bytes', tot)
