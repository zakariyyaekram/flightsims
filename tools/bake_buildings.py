"""Every OSM building outline + mapped tree in the Bay Area -> data/bld/<cx>_<cz>.bin (1 km tiles, streamed at runtime).

Binary tile layout (little endian), coordinates are (world - tileOrigin + 500 m) * 20  (5 cm steps, uint16):
  header : u16 nRect, u16 nPoly, u16 nTree, u16 0
  rect   : u16 x, u16 z, u8 w*2, u8 d*2, u8 yaw (0..pi -> 0..255), u8 h*2, u8 type, u8 roof      (10 bytes)
  poly   : u16 nv, u8 h*2, u8 type, nv * (u16 x, u16 z)
  tree   : u16 x, u16 z, u8 h, u8 kind
type: 0 house, 1 rowhouse/flat residential, 2 apartments, 3 commercial/office, 4 industrial, 5 civic, 6 garage/shed, 7 other
roof: 0 flat, 1 gabled, 2 hipped
Airport-area buildings (modelled by airport3d) and high-rises (data/tall.json) are left out here."""
import osmium, json, sys, os, struct, math, collections
import numpy as np, shapely
from shapely.geometry import shape, Polygon
sys.path.insert(0, os.path.dirname(__file__))
from proj import ll2w
RAW = '/home/user/workspace/raw/'; OUT = '/home/user/workspace/flightsims/data/bld/'
os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT): os.remove(OUT + f)

def num(v):
    if not v: return None
    try: return float(v.split(';')[0].split()[0].replace('m', '').replace(',', '.').replace("'", ''))
    except Exception: return None

aeros = []
for l in open(RAW + 'aero.geojson'):
    f = json.loads(l.strip('\x1e'))
    if f['properties'].get('aeroway') == 'aerodrome' and f['geometry']['type'] in ('Polygon', 'MultiPolygon'):
        aeros.append(shape(f['geometry']).buffer(0.0015))
AERO = shapely.union_all(aeros); shapely.prepare(AERO)

TYPE = {'house': 0, 'detached': 0, 'semidetached_house': 0, 'bungalow': 0, 'cabin': 0, 'farm': 0, 'residential': 0,
        'terrace': 1, 'townhouse': 1, 'apartments': 2, 'dormitory': 2, 'hotel': 2,
        'commercial': 3, 'retail': 3, 'office': 3, 'supermarket': 3, 'kiosk': 3,
        'industrial': 4, 'warehouse': 4, 'manufacture': 4, 'hangar': 4, 'service': 4, 'storage_tank': 4, 'barn': 4, 'greenhouse': 4,
        'school': 5, 'university': 5, 'college': 5, 'church': 5, 'hospital': 5, 'public': 5, 'civic': 5, 'government': 5, 'fire_station': 5, 'train_station': 5, 'stadium': 5, 'sports_hall': 5,
        'garage': 6, 'garages': 6, 'shed': 6, 'carport': 6, 'roof': 6, 'hut': 6}
ROOF = {'flat': 0, 'gabled': 1, 'hipped': 2, 'pyramidal': 2, 'gambrel': 1, 'saltbox': 1, 'skillion': 0}

rings, meta = [], []  # rings: (n,2) lon/lat arrays
class H(osmium.SimpleHandler):
    def area(self, a):
        t = a.tags
        if 'building' not in t: return
        b = t.get('building')
        if b in ('no', 'construction', 'ruins', 'demolished', 'collapsed'): return
        h = num(t.get('height')); lv = num(t.get('building:levels'))
        if (h is not None and h >= 35) or (lv is not None and lv >= 10):
            if (h or (lv or 0) * 3.5) >= 30: return  # in tall.json
        try:
            outer = next(iter(a.outer_rings()))
            pts = np.array([(n.lon, n.lat) for n in outer], float)
        except Exception: return
        if len(pts) < 4: return
        meta.append((TYPE.get(b, 7), h, lv, ROOF.get(t.get('roof:shape'), -1), num(t.get('min_height')) or 0))
        rings.append(pts)
H().apply_file(RAW + 'bld.osm.pbf', locations=True, idx='flex_mem')
print('buildings read', len(rings), flush=True)

# airport exclusion on centroid
cx = np.array([r[:, 0].mean() for r in rings]); cy = np.array([r[:, 1].mean() for r in rings])
inAp = shapely.contains_xy(AERO, cx, cy)
print('airport', int(inAp.sum()), flush=True)
SF = lambda lat, lon: (lat > 37.705 and lon < -122.385 and lat < 37.812)

allpts = np.concatenate(rings); X, Z = ll2w(allpts[:, 1], allpts[:, 0])
off = np.cumsum([0] + [len(r) for r in rings])
tiles = collections.defaultdict(lambda: {'R': [], 'P': [], 'T': []})
def q(v, o): return int(min(65535, max(0, round((v - o + 500) * 20))))
nr = npo = 0
for i in range(len(rings)):
    if inAp[i]: continue
    xs, zs = X[off[i]:off[i + 1]], Z[off[i]:off[i + 1]]
    poly = Polygon(np.stack([xs, zs], 1))
    if not poly.is_valid: poly = poly.buffer(0)
    if poly.is_empty or poly.area < 6: continue
    if poly.geom_type == 'MultiPolygon': poly = max(poly.geoms, key=lambda g: g.area)
    typ, h, lv, roof, mh = meta[i]
    A = poly.area; lat, lon = cy[i], cx[i]
    sf = SF(lat, lon)
    if typ == 7 and sf: typ = 1
    if typ == 7 and A < 30: typ = 6
    if typ == 0 and sf: typ = 1
    if h is None:
        if lv: h = lv * 3.2 + (0.6 if typ else 0)
        else:
            k = (i * 2654435761) % 1000 / 1000
            h = {0: 3.4 if A < 170 or k < 0.45 else 6.2, 1: 9.5 + 3 * k, 2: 12 + 4 * k, 3: 5 + 4 * k if A < 2500 else 8, 4: 8 + 4 * k, 5: 8 + 4 * k, 6: 2.8}.get(typ)
            if h is None:  # building=yes: guess from footprint size
                h = 3.6 + 2.6 * (k > 0.6) if A < 220 else 7 + 2 * k if A < 1500 else 9 + 3 * k
                if A < 260: typ = 0
    if roof < 0: roof = 1 if typ == 0 and A < 400 else 0
    h = min(127, max(2.5, h))
    c = poly.centroid; ox, oz = math.floor(c.x / 1000) * 1000, math.floor(c.y / 1000) * 1000
    T = tiles[(int(ox // 1000), int(oz // 1000))]
    mrr = poly.minimum_rotated_rectangle
    mc = np.array(mrr.exterior.coords)[:4]
    e1, e2 = mc[1] - mc[0], mc[2] - mc[1]; w, d = np.hypot(*e1), np.hypot(*e2)
    if A / max(mrr.area, 1e-6) > 0.82 and w < 120 and d < 120:
        yaw = math.atan2(e1[1], e1[0]) % math.pi
        m = mrr.centroid
        T['R'].append(struct.pack('<HHBBBBBB', q(m.x, ox), q(m.y, oz), min(255, round(w * 2)), min(255, round(d * 2)), min(255, round(yaw / math.pi * 256)) % 256, round(h * 2), typ, roof)); nr += 1
    else:
        s = poly.simplify(0.5)
        if s.geom_type != 'Polygon': s = poly
        co = np.array(s.exterior.coords)[:-1]
        if len(co) < 3: continue
        if shapely.is_ccw(s.exterior): co = co[::-1]
        T['P'].append(struct.pack('<HBB', len(co), round(h * 2), typ) + b''.join(struct.pack('<HH', q(x, ox), q(z, oz)) for x, z in co)); npo += 1
print('rects', nr, 'polys', npo, flush=True)

# mapped trees (natural=tree nodes, tree_row ways sampled every 8 m)
tp = []
class TH(osmium.SimpleHandler):
    def node(self, n):
        if n.tags.get('natural') == 'tree': tp.append((n.location.lon, n.location.lat, num(n.tags.get('height')) or 0))
    def way(self, w):
        if w.tags.get('natural') != 'tree_row': return
        try: c = [(n.lon, n.lat) for n in w.nodes]
        except Exception: return
        for (a, b), (e, f) in zip(c, c[1:]):
            L = math.hypot((e - a) * 88000, (f - b) * 111000); k = max(1, int(L / 8))
            for j in range(k): tp.append((a + (e - a) * (j + 0.5) / k, b + (f - b) * (j + 0.5) / k, 0))
TH().apply_file('/tmp/trees.osm.pbf', locations=True)
tp = np.array(tp); TX, TZ = ll2w(tp[:, 1], tp[:, 0])
for (x, z, hh) in zip(TX, TZ, tp[:, 2]):
    ox, oz = math.floor(x / 1000) * 1000, math.floor(z / 1000) * 1000
    k = int(abs(x * 7 + z * 13)) % 100
    tiles[(int(ox // 1000), int(oz // 1000))]['T'].append(struct.pack('<HHBB', q(x, ox), q(z, oz), int(min(40, hh or 6 + k % 8)), k % 4))
print('trees', len(tp), flush=True)

idx = []
for (tx, tz), T in tiles.items():
    R, P, Tr = T['R'][:65535], T['P'][:65535], T['T'][:65535]
    open(OUT + f'{tx}_{tz}.bin', 'wb').write(struct.pack('<HHHH', len(R), len(P), len(Tr), 0) + b''.join(R) + b''.join(P) + b''.join(Tr))
    idx.append(f'{tx}_{tz}')
json.dump(sorted(idx), open(OUT + 'index.json', 'w'))
tot = sum(os.path.getsize(OUT + f) for f in os.listdir(OUT))
print('tiles', len(idx), 'bytes', tot, 'max/tile', max(len(T['R']) for T in tiles.values()))
