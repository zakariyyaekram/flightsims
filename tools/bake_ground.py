"""Bake the ground layer: every OSM road / street / service road / driveway / track / path, plus land-use
polygons (fields, vineyards, orchards, pastures, lawns, parks, golf, parking, ponds, pools ...) and
synthesised driveways + front walks for every building that OSM does not already connect to the road
network -> data/ground/<tx>_<tz>.bin (2 km tiles, streamed into the terrain overlay at runtime).

Also re-bakes data/streets/<tx>_<tz>.json (4 km tiles used for car traffic and street lights) with the
ways clipped to each tile, so long streets no longer stop at tile borders.

Run: python3 tools/bake_ground.py   (needs raw/bayf.osm.pbf = osmium tags-filter of the Bay Area extract)

Binary tile layout (little endian). Coordinates are u16 (world - tileOrigin + 250) * 20  (5 cm steps).
  header : u32 nLines, u32 nPolys
  line   : u8 kind, u8 mat, u8 width*4, u8 flags, u16 n, n*(u16 x, u16 z)
  poly   : u8 cls, u8 hash, u8 orient (0..pi -> 0..255), u8 nRings, nRings*(u16 n, n*(u16 x, u16 z))
line kind : see LK below (draw passes are ordered by kind)
mat       : 0 asphalt, 1 concrete, 2 gravel, 3 dirt
flags     : 1 sidewalks, 2 bridge deck drawn in 3D (skip on the ground), 4 synthesised
"""
import osmium, json, sys, os, struct, math, collections, glob, zlib
import numpy as np, shapely, shapely.ops
from shapely.geometry import LineString, Polygon, MultiPolygon, box, Point
from shapely import wkb
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from proj import ll2w

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = '/home/user/workspace/raw/'; OUT = ROOT + '/data/'
g = json.load(open(OUT + 'grid.json')); C, X0, Z0, NX, NZ = g['cell'], g['x0'], g['z0'], g['nx'], g['nz']
EXT = (X0 + 200, X0 + (NX - 1) * C - 200, Z0 + 200, Z0 + (NZ - 1) * C - 200)
GT = 2000  # ground tile size
ST = 4000  # street tile size

# ESA WorldCover built-up fraction (data/cover.png, G channel) for "is this in town"
COV = np.asarray(Image.open(OUT + 'cover.png').convert('RGBA'))
def built(x, z):
    i = np.clip(np.round((np.asarray(z) - Z0) / C).astype(int), 0, NZ - 1); j = np.clip(np.round((np.asarray(x) - X0) / C).astype(int), 0, NX - 1)
    return COV[i, j, 1] / 255.0

# ---------------------------------------------------------------- line kinds
LK = {  # kind id, default width, default material
    'track': (0, 3.0, 3), 'path': (1, 1.4, 3), 'footway': (2, 1.8, 1), 'cycleway': (3, 2.2, 0), 'bridleway': (1, 1.6, 3),
    'drive': (4, 3.2, 1), 'walk': (5, 1.3, 1), 'parking_aisle': (6, 6.0, 0), 'alley': (7, 4.0, 0), 'service': (8, 4.5, 0),
    'living_street': (9, 5.0, 0), 'unclassified': (10, 6.0, 0), 'residential': (11, 7.5, 0), 'tertiary': (12, 9.0, 0), 'tertiary_link': (12, 5.0, 0),
    'secondary': (13, 0, 0), 'secondary_link': (13, 5.0, 0), 'primary': (14, 0, 0), 'primary_link': (14, 4.5, 0),
    'trunk': (15, 0, 0), 'trunk_link': (15, 4.5, 0), 'motorway': (16, 0, 0), 'motorway_link': (16, 4.5, 0), 'raceway': (12, 10, 0),
    'pedestrian': (6, 6.0, 1),
}
LANEW = {'motorway': 3.7, 'trunk': 3.6, 'primary': 3.5, 'secondary': 3.4}
MAJOR3D = {'motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link'}  # bridges of these are 3D decks (roads.json)
SURF = {'asphalt': 0, 'paved': 0, 'chipseal': 0, 'concrete': 1, 'concrete:plates': 1, 'paving_stones': 1, 'sett': 1, 'concrete:lanes': 1, 'bricks': 1,
        'gravel': 2, 'fine_gravel': 2, 'compacted': 2, 'pebblestone': 2, 'unpaved': 2, 'dirt': 3, 'ground': 3, 'earth': 3, 'grass': 3, 'sand': 3, 'mud': 3, 'woodchips': 3, 'wood': 1}

# ---------------------------------------------------------------- polygon classes (value = (id, draw priority))
PC = {}
def pc(name, i, pr): PC[name] = (i, pr)
pc('farmland', 1, 10); pc('meadow', 2, 10); pc('orchard', 3, 30); pc('vineyard', 4, 30); pc('farmyard', 5, 32)
pc('residential', 6, 5); pc('commercial', 7, 6); pc('industrial', 8, 6); pc('park', 9, 20); pc('golf', 10, 21)
pc('fairway', 11, 40); pc('green', 12, 42); pc('sand', 13, 44); pc('pitch', 14, 46); pc('runtrack', 15, 47)
pc('cemetery', 16, 22); pc('grounds', 17, 15); pc('wood', 18, 12); pc('scrub', 19, 11); pc('wetland', 20, 13)
pc('bare', 21, 14); pc('parking', 22, 60); pc('pool', 23, 70); pc('nursery', 24, 31); pc('allotments', 25, 31)
pc('rail', 26, 16); pc('playground', 27, 48); pc('water', 28, 65); pc('grass', 29, 25)

def poly_class(t):
    lu = t.get('landuse'); le = t.get('leisure'); na = t.get('natural'); am = t.get('amenity'); go = t.get('golf')
    if le == 'swimming_pool' or am == 'swimming_pool': return 'pool'
    if am == 'parking' and t.get('parking') not in ('underground', 'multi-storey', 'rooftop'): return 'parking'
    if na == 'water' or lu in ('reservoir', 'basin'):
        return 'water' if t.get('water') not in ('wastewater',) else 'water'
    if go == 'green': return 'green'
    if go == 'fairway' or go == 'tee': return 'fairway'
    if go == 'bunker' or na in ('beach', 'sand'): return 'sand'
    if go == 'rough': return 'golf'
    if le == 'golf_course': return 'golf'
    if le == 'pitch': return 'pitch'
    if le == 'track': return 'runtrack'
    if le == 'playground': return 'playground'
    if le in ('park', 'garden', 'recreation_ground', 'common', 'dog_park') or lu in ('recreation_ground', 'village_green'): return 'park'
    if lu == 'grass': return 'grass'
    if lu == 'farmland': return 'farmland'
    if lu in ('meadow', 'pasture') or na == 'grassland': return 'meadow'
    if lu == 'orchard': return 'orchard'
    if lu == 'vineyard': return 'vineyard'
    if lu == 'farmyard': return 'farmyard'
    if lu in ('plant_nursery', 'greenhouse_horticulture'): return 'nursery'
    if lu == 'allotments': return 'allotments'
    if lu == 'residential': return 'residential'
    if lu in ('commercial', 'retail'): return 'commercial'
    if lu in ('industrial', 'port', 'garages'): return 'industrial'
    if lu == 'cemetery' or am == 'grave_yard': return 'cemetery'
    if am in ('school', 'university', 'college', 'hospital', 'kindergarten') or lu in ('education', 'religious', 'institutional'): return 'grounds'
    if lu == 'forest' or na == 'wood': return 'wood'
    if na in ('scrub', 'heath'): return 'scrub'
    if na == 'wetland': return 'wetland'
    if lu in ('quarry', 'landfill', 'construction', 'brownfield') or na in ('bare_rock', 'scree', 'shingle'): return 'bare'
    if lu == 'railway': return 'rail'
    return None

def num(v):
    if not v: return None
    try: return float(str(v).split(';')[0].split()[0].replace('m', '').replace(',', '.'))
    except Exception: return None

wf = osmium.geom.WKBFactory()
lines = []   # (kind, mat, width, flags, xs, zs, hw_name, connectable)
polys = []   # (cls, hash, shapely polygon in world coords)
drives_osm = []  # osm driveway / service geometries for "already connected" checks
def to_world(coords):
    a = np.asarray(coords, float); x, z = ll2w(a[:, 1], a[:, 0]); return x, z

class H(osmium.SimpleHandler):
    def way(self, w):
        t = w.tags; hw = t.get('highway')
        if not hw: return
        if t.get('area') == 'yes': return
        if hw in ('steps', 'corridor', 'elevator', 'proposed', 'construction', 'abandoned', 'platform', 'bus_stop', 'razed', 'via_ferrata', 'escape'): return
        if t.get('tunnel') in ('yes', 'building_passage', 'culvert') or t.get('covered') == 'yes' or t.get('indoor') == 'yes': return
        if hw in ('footway', 'path', 'cycleway', 'bridleway') and t.get('footway') in ('sidewalk', 'crossing') : return
        if hw == 'footway' and t.get('footway') == 'access_aisle': return
        if hw == 'service':
            sv = t.get('service')
            key = 'drive' if sv == 'driveway' else 'parking_aisle' if sv == 'parking_aisle' else 'alley' if sv == 'alley' else 'service'
        elif hw in ('road', 'busway'): key = 'unclassified'
        else: key = hw
        if key not in LK: return
        try: coords = [(n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError: return
        if len(coords) < 2: return
        kid, dw, dm = LK[key]
        lanes = num(t.get('lanes'))
        width = num(t.get('width'))
        if hw in LANEW or hw in ('motorway_link', 'trunk_link', 'primary_link'):
            if lanes is None: lanes = {'motorway': 3, 'trunk': 2, 'primary': 2, 'secondary': 2}.get(hw, 1)
            oneway = t.get('oneway') == 'yes' or hw in ('motorway', 'motorway_link') or t.get('junction') == 'roundabout'
            if not oneway and lanes == 1 and not hw.endswith('_link'): lanes = 2
            lw = LANEW.get(hw, 4.5 if hw.endswith('_link') else 3.5)
            width = max(1, lanes) * lw + (3 if hw in ('motorway', 'trunk') else 1)
        else:
            if width is None or width < 1 or width > 30:
                width = dw
                if lanes and kid >= 10: width = max(width, min(lanes, 6) * 3.3)
        mat = SURF.get(t.get('surface'), dm)
        if key == 'track':
            mat = SURF.get(t.get('surface'), 2 if t.get('tracktype') in ('grade1', 'grade2') else 3)
            if t.get('tracktype') == 'grade1' and t.get('surface') in (None, 'paved', 'asphalt'): mat = 0 if t.get('surface') else 2
        if key == 'path' and t.get('surface') is None: mat = 3
        if key == 'drive' and t.get('surface') is None: mat = 1
        bridge = t.get('bridge') not in (None, 'no')
        flags = 0
        if bridge and hw in MAJOR3D: flags |= 2
        x, z = to_world(coords)
        if x.max() < EXT[0] or x.min() > EXT[1] or z.max() < EXT[2] or z.min() > EXT[3]: return
        lines.append([kid, mat, width, flags, x, z, hw, key])

    def area(self, a):
        t = a.tags; cls = poly_class(t)
        if not cls: return
        try: gg = wkb.loads(wf.create_multipolygon(a), hex=True)
        except Exception: return
        if gg.is_empty: return
        polys.append((cls, (a.orig_id() * 2654435761) & 0xffffffff, gg))

import pickle
CACHE = RAW + 'ground_cache.pkl'
if os.path.exists(CACHE) and '--fresh' not in sys.argv:
    lines, polys = pickle.load(open(CACHE, 'rb'))
else:
    print('reading OSM ...', flush=True)
    H().apply_file(RAW + 'bayf.osm.pbf', locations=True, idx='flex_mem')
    pickle.dump((lines, polys), open(CACHE, 'wb'))
print('lines', len(lines), 'polys', len(polys), flush=True)

# ---------------------------------------------------------------- project polygons to world, simplify
wpolys = []
def proj_poly(gg):
    out = []
    for p in getattr(gg, 'geoms', [gg]):
        ex = np.asarray(p.exterior.coords); x, z = ll2w(ex[:, 1], ex[:, 0])
        holes = []
        for r in p.interiors:
            ri = np.asarray(r.coords); hx, hz = ll2w(ri[:, 1], ri[:, 0]); holes.append(np.stack([hx, hz], 1))
        q = Polygon(np.stack([x, z], 1), holes)
        if not q.is_valid: q = q.buffer(0)
        if not q.is_empty: out.append(q)
    return out
for cls, hsh, gg in polys:
    for q in proj_poly(gg):
        b = q.bounds
        if b[2] < EXT[0] or b[0] > EXT[1] or b[3] < EXT[2] or b[1] > EXT[3]: continue
        if q.area < 12: continue
        tol = 0.4 if cls in ('pool',) else 1.0 if q.area < 20000 else 2.0
        q = q.simplify(tol, preserve_topology=True)
        if q.is_empty: continue
        # field orientation: long axis of the minimum rotated rectangle
        try:
            mr = np.asarray(q.minimum_rotated_rectangle.exterior.coords)
            e1 = mr[1] - mr[0]; e2 = mr[2] - mr[1]; e = e1 if np.hypot(*e1) > np.hypot(*e2) else e2
            ang = math.atan2(e[1], e[0]) % math.pi
        except Exception: ang = 0.0
        wpolys.append((cls, hsh, ang, q))
print('world polys', len(wpolys), flush=True)

# ---------------------------------------------------------------- buildings (from the baked data/bld tiles)
def read_bld():
    out = []  # (type, Polygon)
    for fn in glob.glob(OUT + 'bld/*.bin'):
        k = os.path.basename(fn)[:-4]; cx, cz = map(int, k.split('_')); ox, oz = cx * 1000 - 500, cz * 1000 - 500
        b = open(fn, 'rb').read(); nR, nP, nT = struct.unpack_from('<HHH', b, 0); o = 8
        for i in range(nR):
            x, z, w, d, yaw, h, typ, roof = struct.unpack_from('<HHBBBBBB', b, o); o += 10
            x = ox + x / 20; z = oz + z / 20; w /= 2; d /= 2; yaw = yaw / 256 * math.pi
            c, s = math.cos(yaw), math.sin(yaw); hw, hd = w / 2, d / 2
            pts = [(x + c * u - s * v, z + s * u + c * v) for u, v in ((-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd))]
            out.append((typ, Polygon(pts)))
        for i in range(nP):
            n, h, typ = struct.unpack_from('<HBB', b, o); o += 4
            pts = [(ox + struct.unpack_from('<H', b, o + 4 * k)[0] / 20, oz + struct.unpack_from('<H', b, o + 4 * k + 2)[0] / 20) for k in range(n)]; o += 4 * n
            if n >= 3: out.append((typ, Polygon(pts)))
    return out
blds = read_bld()
print('buildings', len(blds), flush=True)
BG = np.array([b[1] for b in blds], dtype=object); BT = np.array([b[0] for b in blds])
def _fix(gm):
    if gm.geom_type == 'Polygon' and gm.is_valid: return gm
    gm = shapely.make_valid(gm)
    if gm.geom_type == 'Polygon': return gm
    ps = [q for q in getattr(gm, 'geoms', []) if q.geom_type == 'Polygon']
    return max(ps, key=lambda q: q.area) if ps else Polygon()
BG = np.array([_fix(gm) for gm in BG], dtype=object)
btree = shapely.STRtree(BG)

# ---------------------------------------------------------------- road network geometry
LG = np.array([LineString(np.stack([l[4], l[5]], 1)) for l in lines], dtype=object)
LKIND = np.array([l[0] for l in lines]); LKEY = [l[7] for l in lines]
# roads a house can be connected to (not freeways / their ramps, not foot paths)
conn_ok = np.array([(4 <= k <= 14 and LKEY[i] not in ('primary_link',)) or k == 0 for i, k in enumerate(LKIND)])
conn_idx = np.nonzero(conn_ok)[0]
ctree = shapely.STRtree(LG[conn_idx])
drv_idx = np.array([i for i, k in enumerate(LKEY) if k in ('drive', 'service', 'parking_aisle', 'alley', 'track')])
dtree = shapely.STRtree(LG[drv_idx]) if len(drv_idx) else None

# residential + farm land use (where houses belong)
res_polys = [q for cls, h, a, q in wpolys if cls in ('residential', 'farmyard')]
park_polys = [q for cls, h, a, q in wpolys if cls in ('parking',)]
ptree = shapely.STRtree(np.array(park_polys, dtype=object)) if park_polys else None

# ---------------------------------------------------------------- synthesised driveways
print('driveways ...', flush=True)
area = shapely.area(BG)
cand = np.nonzero(((BT == 0) | (BT == 1) | (BT == 7) | (BT == 4) | (BT == 5) | (BT == 3) | (BT == 2)) & (area >= 35) & (area < 6000))[0]
cent = shapely.centroid(BG[cand])
# nearest connectable road for every candidate building
ni, nd = ctree.query_nearest(BG[cand], max_distance=1500, return_distance=True, all_matches=False)
near_road = np.full(len(cand), -1); near_d = np.full(len(cand), 1e9)
near_road[ni[0]] = conn_idx[ni[1]]; near_d[ni[0]] = nd
# already connected by an OSM driveway / service road / parking lot touching the footprint?
connected = np.zeros(len(cand), bool)
if dtree is not None:
    q = dtree.query(shapely.buffer(BG[cand], 5.0), predicate='intersects')
    connected[np.unique(q[0])] = True
if ptree is not None:
    q = ptree.query(shapely.buffer(BG[cand], 8.0), predicate='intersects')
    connected[np.unique(q[0])] = True
synth = []  # (kind, mat, width, xs, zs)
rural_lines = []
order = np.argsort(near_d)
bx_built = built(shapely.get_x(cent), shapely.get_y(cent))
made = skipped_cross = 0
for oi in order:
    bi = cand[oi]; d = near_d[oi]; ri = near_road[oi]
    if ri < 0 or connected[oi]: continue
    typ = BT[bi]; P = BG[bi]
    if d < 3.5: continue                        # building fronts the road / sidewalk directly
    town = bx_built[oi] > 0.2 or d < 45
    if typ in (2, 3, 5) and d < 80: continue    # apartments / shops / civic: reached via their lots and aisles
    if typ == 4 and town: continue              # industrial in town: yards are paved lots
    R = LG[ri]
    q_on = shapely.ops.nearest_points(P, R)
    p, qr = q_on[0], q_on[1]
    dx, dz = qr.x - p.x, qr.y - p.y; L = math.hypot(dx, dz)
    if L < 1: continue
    ux, uz = dx / L, dz / L
    # start a little inside the footprint (the garage door), end on the road centreline
    a = (p.x - ux * 1.0, p.y - uz * 1.0); b = (qr.x, qr.y)
    road_hw = lines[ri][2] / 2
    line = LineString([a, b])
    # must not cut through other buildings
    hits = btree.query(line.buffer(1.3), predicate='intersects')
    hits = [h for h in hits if h != bi]
    if hits:
        # try connecting from the other footprint corners / edge midpoints towards the same road
        ok = False
        ring = np.asarray(P.exterior.coords)[:-1]
        cands = list(ring) + [(ring[i] + ring[(i + 1) % len(ring)]) / 2 for i in range(len(ring))]
        best = None
        for c0 in cands:
            pp = Point(c0); qq = R.interpolate(R.project(pp))
            ln = LineString([c0, (qq.x, qq.y)])
            if ln.length > d + 60: continue
            if ln.crosses(P) and P.intersection(ln).length > 1.5: continue
            h2 = [h for h in btree.query(ln.buffer(1.3), predicate='intersects') if h != bi]
            if not h2 and (best is None or ln.length < best.length): best = ln
        if best is None:
            # rural: connect to a previously built driveway instead (farm clusters)
            skipped_cross += 1
            continue
        line = best; L = line.length
    if town:
        w = 5.4 if (area[bi] > 160 and typ == 0 and d < 40) else 3.2
        mat = 1
    else:
        w = 3.6; mat = 2 if lines[ri][1] in (0, 1) else 3
    xs, zs = np.asarray(line.coords).T
    synth.append((4, mat, w, xs, zs))
    made += 1
    # a front walk to the sidewalk for town houses set back from the street
    if town and typ in (0, 1) and 7 < L < 45:
        ring = np.asarray(P.exterior.coords)
        # facade edge facing the road
        best_e, bs = None, -1e9
        for i in range(len(ring) - 1):
            e0, e1 = ring[i], ring[i + 1]; ex, ez = e1 - e0; el = math.hypot(ex, ez)
            if el < 4: continue
            nx, nz = ez / el, -ex / el
            m = (e0 + e1) / 2
            if (m[0] + nx - P.centroid.x) ** 2 + (m[1] + nz - P.centroid.y) ** 2 < (m[0] - P.centroid.x) ** 2 + (m[1] - P.centroid.y) ** 2: nx, nz = -nx, -nz
            sc = nx * ux + nz * uz
            if sc > bs: bs, best_e = sc, (e0, e1, el, nx, nz)
        if best_e and bs > 0.6:
            e0, e1, el, nx, nz = best_e
            # door ~ 35% along the facade on the side away from the driveway
            m1 = e0 + (e1 - e0) * 0.3; m2 = e0 + (e1 - e0) * 0.7
            dd = lambda m: (m[0] - a[0]) ** 2 + (m[1] - a[1]) ** 2
            door = m1 if dd(m1) > dd(m2) else m2
            pp = Point(door); qq = R.interpolate(R.project(pp))
            wl = LineString([door, (qq.x, qq.y)])
            if wl.length < L + 12 and not [h for h in btree.query(wl.buffer(0.7), predicate='intersects') if h != bi]:
                xs, zs = np.asarray(wl.coords).T
                synth.append((5, 1, 1.3, xs, zs))
print('synth driveways', made, 'skipped (blocked)', skipped_cross, 'connected by OSM', int(connected.sum()), flush=True)

# ---------------------------------------------------------------- write ground tiles
tiles = collections.defaultdict(lambda: {'L': [], 'P': []})
def qa(c, ox, oz):
    c = np.asarray(c, float); q = np.empty((len(c), 2)); q[:, 0] = (c[:, 0] - ox + 250) * 20; q[:, 1] = (c[:, 1] - oz + 250) * 20
    return np.clip(np.round(q), 0, 65535).astype('<u2').tobytes()
def qv(v, o): return int(min(65535, max(0, round((v - o + 250) * 20))))
def clip_line_to_tiles(xs, zs, rec):
    ls = LineString(np.stack([xs, zs], 1))
    x0, z0, x1, z1 = ls.bounds
    for tx in range(int(math.floor(x0 / GT)), int(math.floor(x1 / GT)) + 1):
        for tz in range(int(math.floor(z0 / GT)), int(math.floor(z1 / GT)) + 1):
            bb = box(tx * GT, tz * GT, (tx + 1) * GT, (tz + 1) * GT)
            part = ls.intersection(bb) if not (x0 >= tx * GT and x1 <= (tx + 1) * GT and z0 >= tz * GT and z1 <= (tz + 1) * GT) else ls
            if part.is_empty: continue
            for seg in getattr(part, 'geoms', [part]):
                if seg.geom_type != 'LineString' or seg.length < 0.5: continue
                tiles[(tx, tz)]['L'].append((rec, np.asarray(seg.coords)))
for kid, mat, width, flags, xs, zs, hw, key in lines:
    tol = 0.5 if kid <= 9 else 1.0
    ls = LineString(np.stack([xs, zs], 1)).simplify(tol)
    c = np.asarray(ls.coords); xs, zs = c[:, 0], c[:, 1]
    if 9 <= kid <= 14 and built(xs.mean(), zs.mean()) > 0.25 and key not in ('tertiary_link', 'secondary_link', 'primary_link'): flags |= 1
    clip_line_to_tiles(xs, zs, (kid, mat, width, flags))
for kid, mat, width, xs, zs in synth: clip_line_to_tiles(xs, zs, (kid, mat, width, 4))
order_p = sorted(range(len(wpolys)), key=lambda i: (PC[wpolys[i][0]][1], -wpolys[i][3].area))
for i in order_p:
    cls, hsh, ang, q = wpolys[i]
    x0, z0, x1, z1 = q.bounds
    for tx in range(int(math.floor(x0 / GT)), int(math.floor(x1 / GT)) + 1):
        for tz in range(int(math.floor(z0 / GT)), int(math.floor(z1 / GT)) + 1):
            bb = box(tx * GT - 2, tz * GT - 2, (tx + 1) * GT + 2, (tz + 1) * GT + 2)
            part = q if (x0 >= tx * GT and x1 <= (tx + 1) * GT and z0 >= tz * GT and z1 <= (tz + 1) * GT) else q.intersection(bb)
            if part.is_empty: continue
            for pg in getattr(part, 'geoms', [part]):
                if pg.geom_type != 'Polygon' or pg.area < 4: continue
                tiles[(tx, tz)]['P'].append((PC[cls][0], hsh & 7, int(round(ang / math.pi * 255)) % 256, pg))
os.makedirs(OUT + 'ground', exist_ok=True)
for f_ in os.listdir(OUT + 'ground'): os.remove(OUT + 'ground/' + f_)
tot = 0
for (tx, tz), T in tiles.items():
    ox, oz = tx * GT, tz * GT
    buf = bytearray(struct.pack('<II', len(T['L']), 0))
    T['L'].sort(key=lambda r: r[0][0])
    for (kid, mat, width, flags), c in T['L']:
        if len(c) > 65535: c = c[:65535]
        buf += struct.pack('<BBBBH', kid, mat, min(255, int(round(width * 4))), flags, len(c))
        buf += qa(c, ox, oz)
    npoly = 0
    for cls, hsh, ori, pg in T['P']:
        rings = [np.asarray(pg.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in pg.interiors]
        rings = [r for r in rings if len(r) >= 3][:255]
        if not rings: continue
        buf += struct.pack('<BBBB', cls, hsh, ori, len(rings))
        for r in rings:
            r = r[:65535]
            buf += struct.pack('<H', len(r)); buf += qa(r, ox, oz)
        npoly += 1
    struct.pack_into('<II', buf, 0, len(T['L']), npoly)
    fn = OUT + f'ground/{tx}_{tz}.bin'; open(fn, 'wb').write(bytes(buf)); tot += len(buf)
json.dump(sorted([f'{a}_{b}' for a, b in tiles]), open(OUT + 'ground/index.json', 'w'))
print('ground tiles', len(tiles), 'bytes', tot, flush=True)

# ---------------------------------------------------------------- re-bake street tiles (clipped per tile) for traffic & street lights
MINOR = ['tertiary', 'residential', 'unclassified', 'living_street', 'secondary_link', 'tertiary_link']
stiles = collections.defaultdict(list)
for kid, mat, width, flags, xs, zs, hw, key in lines:
    if key not in MINOR: continue
    ls = LineString(np.stack([xs, zs], 1)).simplify(2.0)
    k = MINOR.index(key)
    x0, z0, x1, z1 = ls.bounds
    for tx in range(int(math.floor(x0 / ST)), int(math.floor(x1 / ST)) + 1):
        for tz in range(int(math.floor(z0 / ST)), int(math.floor(z1 / ST)) + 1):
            bb = box(tx * ST, tz * ST, (tx + 1) * ST, (tz + 1) * ST)
            part = ls.intersection(bb)
            for seg in getattr(part, 'geoms', [part]):
                if seg.is_empty or seg.geom_type != 'LineString' or seg.length < 1: continue
                c = np.asarray(seg.coords)
                stiles[(tx, tz)].append([k, 2 if key == 'tertiary' else 1, 2 if flags & 2 else 0, [int(round(v)) for xy in c for v in xy]])
os.makedirs(OUT + 'streets', exist_ok=True)
for f_ in os.listdir(OUT + 'streets'): os.remove(OUT + 'streets/' + f_)
for (tx, tz), ws in stiles.items():
    json.dump({'kinds': MINOR, 'ways': ws}, open(OUT + f'streets/{tx}_{tz}.json', 'w'), separators=(',', ':'))
json.dump(sorted([f'{a}_{b}' for a, b in stiles]), open(OUT + 'streets/index.json', 'w'))
print('street tiles', len(stiles), flush=True)

# ---------------------------------------------------------------- real farmsteads + pastures for livestock (life.js)
farms = []
yards = [q for cls, h, a, q in wpolys if cls == 'farmyard' and q.area > 800]
past = [(cls, a, q) for cls, h, a, q in wpolys if cls in ('meadow', 'farmland') and q.area > 15000]
if past:
    pt = shapely.STRtree(np.array([q for _, _, q in past], dtype=object))
    for y in yards:
        c = y.centroid
        if not (EXT[0] < c.x < EXT[1] and EXT[2] < c.y < EXT[3]): continue
        j = pt.query_nearest(c, max_distance=400)
        if len(j) == 0: continue
        cls, ang, q = past[int(j[0])]
        # paddock inside the pasture, nearest to the yard
        inner = q.buffer(-25)
        if inner.is_empty: continue
        pp = shapely.ops.nearest_points(inner, c)[0]
        farms.append([round(pp.x, 1), round(pp.y, 1), round(ang, 3), 1 if cls == 'meadow' else 0, round(c.x, 1), round(c.y, 1)])
json.dump(farms, open(OUT + 'farms.json', 'w'), separators=(',', ':'))
print('farms', len(farms))
