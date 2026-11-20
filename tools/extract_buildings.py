"""Pull airport-area buildings and tall buildings out of the OSM building extract -> raw/bld_sel.json"""
import osmium, json, sys
from shapely.geometry import shape, Point
from shapely import wkb
sys.path.insert(0, '/home/user/workspace/flightsims/tools')
RAW = '/home/user/workspace/raw/'
aeros = []
for l in open(RAW + 'aero.geojson'):
    f = json.loads(l.strip('\x1e'))
    if f['properties'].get('aeroway') == 'aerodrome' and f['geometry']['type'] == 'MultiPolygon':
        g = shape(f['geometry']); aeros.append((f['properties'].get('icao') or f['properties'].get('faa') or f['properties'].get('name'), g.buffer(0.002)))
print([a[0] for a in aeros])
def num(v):
    if not v: return None
    try: return float(v.split()[0].replace('m', '').replace(',', '.').replace("'", ''))
    except: return None
wf = osmium.geom.WKBFactory()
out = []
class H(osmium.SimpleHandler):
    def area(self, a):
        t = a.tags
        if 'building' not in t and 'building:part' not in t: return
        h = num(t.get('height')); lv = num(t.get('building:levels'))
        try: g = wkb.loads(wf.create_multipolygon(a), hex=True)
        except Exception: return
        c = g.representative_point()
        ap = None
        for n, ag in aeros:
            if ag.contains(c): ap = n; break
        tall = (h is not None and h >= 35) or (lv is not None and lv >= 10)
        if not ap and not tall: return
        g = g.simplify(0.000005)
        polys = [list(p.exterior.coords) for p in getattr(g, 'geoms', [g])]
        out.append({'ap': ap, 'h': h, 'lv': lv, 'mh': num(t.get('min_height')), 'b': t.get('building') or t.get('building:part'), 'part': 'building:part' in t,
                    'aw': t.get('aeroway'), 'name': t.get('name'), 'roof': t.get('roof:shape'), 'col': t.get('building:colour'), 'mat': t.get('building:material'), 'p': polys})
H().apply_file(RAW + 'bld.osm.pbf', locations=True, idx='flex_mem')
json.dump(out, open(RAW + 'bld_sel.json', 'w'))
print(len(out), sum(1 for o in out if o['ap']))
