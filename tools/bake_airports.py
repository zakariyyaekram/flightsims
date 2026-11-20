"""Bake real airport layouts -> data/airports.json
Runways: OurAirports (https://ourairports.com/data/) runway ends, true headings, lengths, widths, displaced thresholds, end elevations.
Taxiways / aprons / buildings / towers / windsocks: OpenStreetMap (Geofabrik California extract)."""
import csv, json, math, sys, collections
from shapely.geometry import shape, Point, LineString, Polygon
sys.path.insert(0, '/home/user/workspace/flightsims/tools')
from proj import ll2w
RAW = '/home/user/workspace/raw/'; OUT = '/home/user/workspace/flightsims/data/'
FT = 0.3048
LIST = [  # icao, osm key, size class, towered, ATIS/tower freq (MHz)
    ('KSFO', 'KSFO', 'L', True), ('KOAK', 'KOAK', 'L', True), ('KSJC', 'KSJC', 'L', True), ('KNUQ', 'KNUQ', 'M', True),
    ('KHWD', 'KHWD', 'S', True), ('KSQL', 'KSQL', 'S', True), ('KPAO', 'KPAO', 'S', True), ('KLVK', 'KLVK', 'S', True),
    ('KCCR', 'KCCR', 'S', True), ('KAPC', 'KAPC', 'S', True), ('KRHV', 'KRHV', 'S', True), ('KO69', 'O69', 'S', False),
    ('KHAF', 'KHAF', 'S', False), ('KDVO', 'KDVO', 'S', False)]
TOWER_H = {'KSFO': 67.4, 'KOAK': 72.0, 'KSJC': 29.8}  # OSM height tags / flysfo.com (221 ft) / Schuff (236 ft)
# Tower / ground / CTAF and ILS data: AirNav + flightplandatabase.com (FAA NASR)
FREQ = {'KSFO': (120.5, 121.8), 'KOAK': (118.3, 121.75), 'KSJC': (124.0, 121.7), 'KNUQ': (119.55, 121.85), 'KHWD': (120.2, 121.4), 'KSQL': (119.0, 121.6),
        'KPAO': (118.6, 125.0), 'KLVK': (118.1, 121.6), 'KCCR': (119.7, 121.9), 'KAPC': (118.7, 121.7), 'KRHV': (119.8, 121.65), 'KO69': (122.8, None), 'KHAF': (122.85, None), 'KDVO': (122.725, None)}
ILS = {('KSFO', '28L'): ('ISFO', 109.55, 2.85), ('KSFO', '28R'): ('IGWQ', 111.7, 3.0), ('KSFO', '19L'): ('ISIA', 108.9, 3.0),
       ('KOAK', '30'): ('IINB', 108.7, 3.0), ('KOAK', '12'): ('IAAZ', 111.9, 3.0), ('KOAK', '28R'): ('IOAK', 109.9, 3.0),
       ('KSJC', '30L'): ('ISJC', 110.9, 3.0), ('KSJC', '12R'): ('ISLV', 110.9, 3.0), ('KNUQ', '32R'): ('INUQ', 110.35, 3.0),
       ('KHWD', '28L'): ('IHWD', 111.5, None), ('KCCR', '19R'): ('ICCR', 108.5, 3.0), ('KAPC', '01L'): ('IAPC', 111.3, 3.0), ('KLVK', '25R'): ('ILVK', 110.5, 3.0)}
aps = {r['ident']: r for r in csv.DictReader(open(RAW + 'airports.csv'))}
rws = collections.defaultdict(list)
for r in csv.DictReader(open(RAW + 'runways.csv')): rws[r['airport_ident']].append(r)
feats = [json.loads(l.strip('\x1e')) for l in open(RAW + 'aero.geojson')]
aerodromes = {}
for f in feats:
    p = f['properties']
    if p.get('aeroway') == 'aerodrome' and f['geometry']['type'] == 'MultiPolygon':
        aerodromes[p.get('icao') or p.get('faa') or p.get('name')] = shape(f['geometry'])
blds = json.load(open(RAW + 'bld_sel.json'))
def W(lon, lat):
    x, z = ll2w(lat, lon); return [round(float(x), 1), round(float(z), 1)]
def fnum(s, d=0.0):
    try: return float(s)
    except: return d
out = []
for icao, key, size, towered in LIST:
    A = aps[icao]; poly = aerodromes[key]; area = poly.buffer(0.0012)
    elev = fnum(A['elevation_ft']) * FT
    runways = []
    for r in rws[icao]:
        if r['closed'] == '1' or r['le_ident'].startswith('H'): continue
        if not r['le_latitude_deg'] or not r['he_latitude_deg']: print('no ends', icao, r['le_ident']); continue
        le = W(float(r['le_longitude_deg']), float(r['le_latitude_deg'])); he = W(float(r['he_longitude_deg']), float(r['he_latitude_deg']))
        # Choose geometry: OurAirports ends if they agree with the published length; otherwise the OSM centreline
        # (traced from imagery) re-centred with the published length; otherwise the published true heading.
        lft0 = fnum(r['length_ft']) * FT
        Loa = math.hypot(he[0] - le[0], he[1] - le[1])
        osm = None
        for f in feats:
            p = f['properties']
            if p.get('aeroway') != 'runway' or f['geometry']['type'] != 'LineString' or not p.get('ref'): continue
            ids = [i.lstrip('0') for i in p['ref'].split('/')]
            if sorted(ids) != sorted([r['le_ident'].lstrip('0'), r['he_ident'].lstrip('0')]): continue
            c = f['geometry']['coordinates']
            if not area.contains(Point(c[0])): continue
            a, b = W(*c[0]), W(*c[-1])
            if math.hypot(a[0] - le[0], a[1] - le[1]) > math.hypot(b[0] - le[0], b[1] - le[1]): a, b = b, a
            osm = (a, b); break
        def hd(a, b): return (math.degrees(math.atan2(b[0] - a[0], -(b[1] - a[1]))) + 360) % 360
        ok_oa = abs(Loa - lft0) < 0.02 * lft0
        if ok_oa and (not osm or abs((hd(le, he) - hd(*osm) + 540) % 360 - 180) < 1.5): src = 'OurAirports'
        else:
            if osm:
                a, b = osm; src = 'OSM axis'
                mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2; th = math.radians(hd(a, b))
                if ok_oa: mx, mz = (le[0] + he[0]) / 2, (le[1] + he[1]) / 2
            else:
                src = 'published hdg'; mx, mz = (le[0] + he[0]) / 2, (le[1] + he[1]) / 2; th = math.radians(fnum(r['le_heading_degT']))
            dx, dz = math.sin(th), -math.cos(th)
            le = [round(mx - dx * lft0 / 2, 1), round(mz - dz * lft0 / 2, 1)]; he = [round(mx + dx * lft0 / 2, 1), round(mz + dz * lft0 / 2, 1)]
        print('   geometry from', src)
        dx, dz = he[0] - le[0], he[1] - le[1]; L = math.hypot(dx, dz)
        hdg = (math.degrees(math.atan2(dx, -dz)) + 360) % 360
        lft = fnum(r['length_ft']) * FT
        print(f"{icao} {r['le_ident']}/{r['he_ident']} ends {L:.0f} m vs published {lft:.0f} m, hdg {hdg:.1f}T (OA {r['le_heading_degT']})")
        runways.append({'id': [r['le_ident'], r['he_ident']], 'le': le, 'he': he, 'len': round(L, 1), 'wid': round(fnum(r['width_ft']) * FT, 1), 'hdg': round(hdg, 2),
                        'disp': [round(fnum(r['le_displaced_threshold_ft']) * FT, 1), round(fnum(r['he_displaced_threshold_ft']) * FT, 1)],
                        'elev': [round(fnum(r['le_elevation_ft'], elev / FT) * FT, 1), round(fnum(r['he_elevation_ft'], elev / FT) * FT, 1)],
                        'ils': [list(ILS[(icao, e)]) if (icao, e) in ILS else None for e in (r['le_ident'], r['he_ident'])],
                        'surf': 'concrete' if 'CON' in r['surface'].upper() or 'PEM' in r['surface'].upper() else 'asphalt', 'lit': r['lighted'] == '1'})
    big = size == 'L'
    taxi, aprons, socks, tower = [], [], [], None
    for f in feats:
        p = f['properties']; g = f['geometry']; aw = p.get('aeroway')
        if aw not in ('taxiway', 'taxilane', 'apron', 'windsock', 'tower'): continue
        s = shape(g)
        if not area.intersects(s.centroid if aw != 'taxiway' else s): continue
        if aw in ('taxiway', 'taxilane') and g['type'] == 'LineString':
            w = fnum(p.get('width'), 0) or ((23 if big else 15) if aw == 'taxiway' else (12 if big else 8))
            if size == 'S' and aw == 'taxiway': w = fnum(p.get('width'), 0) or 11
            ls = s.simplify(0.000004)
            taxi.append({'w': w, 'ref': p.get('ref'), 'lane': aw == 'taxilane', 'p': [W(*c) for c in ls.coords]})
        elif aw == 'apron' and g['type'] == 'MultiPolygon':
            for pg in s.geoms:
                pg = pg.simplify(0.000004)
                aprons.append({'p': [W(*c) for c in pg.exterior.coords][:-1], 'h': [[W(*c) for c in i.coords][:-1] for i in pg.interiors]})
        elif aw == 'windsock' and g['type'] == 'Point': socks.append(W(*g['coordinates']))
        elif aw == 'tower' and g['type'] == 'MultiPolygon' and tower is None:
            c = s.centroid; tower = {'p': W(c.x, c.y), 'h': TOWER_H.get(icao, fnum(p.get('height'), 0) or 25), 'r': round(math.sqrt(s.area) * 111000 * 0.45, 1)}
    B = []
    for b in blds:
        if b['ap'] != key or b['aw'] == 'tower': continue
        name = (b['name'] or '')
        if 'Tower' in name and tower is None:
            pts = b['p'][0]; cx = sum(q[0] for q in pts) / len(pts); cy = sum(q[1] for q in pts) / len(pts)
            tower = {'p': W(cx, cy), 'h': TOWER_H.get(icao, b['h'] or 24), 'r': 4}
        if 'Tower' in name and b['h'] and b['h'] < 20: pass
        t = b['b']
        kind = 'terminal' if (t in ('terminal', 'transportation') or b['aw'] == 'terminal' or 'Terminal' in name) else 'hangar' if (t == 'hangar' or b['aw'] == 'hangar' or 'Hangar' in name) else \
            'house' if t in ('house', 'detached', 'semidetached_house', 'residential', 'apartments') else 'shed' if t in ('shed', 'garage', 'roof') else 'gen'
        h = b['h'] or ((b['lv'] or 0) * 3.4) or {'terminal': 16, 'hangar': 10, 'house': 6.5, 'shed': 4, 'gen': 7}[kind]
        if kind == 'terminal' and big and not b['h']: h = 20
        for ring in b['p']:
            pts = [W(*c) for c in ring][:-1]
            if len(pts) < 3: continue
            B.append({'k': kind, 'h': round(h, 1), 'mh': b['mh'] or 0, 'roof': b['roof'], 'part': b['part'], 'n': name or None, 'p': pts})
    # airport reference point & elevation
    ax = sum((r['le'][0] + r['he'][0]) / 2 for r in runways) / len(runways); az = sum((r['le'][1] + r['he'][1]) / 2 for r in runways) / len(runways)
    print(icao, len(runways), 'rwys', len(taxi), 'taxi', len(aprons), 'aprons', len(B), 'bld', 'tower', tower, 'socks', len(socks))
    out.append({'icao': icao, 'name': A['name'], 'size': size, 'towered': towered, 'twr': FREQ[icao][0], 'gnd': FREQ[icao][1], 'elev': round(elev, 1), 'x': round(ax, 1), 'z': round(az, 1),
                'runways': runways, 'taxiways': taxi, 'aprons': aprons, 'buildings': B, 'tower': tower, 'socks': socks})
json.dump(out, open(OUT + 'airports.json', 'w'), separators=(',', ':'))
import os; print(os.path.getsize(OUT + 'airports.json'))

# navaids (OurAirports navaids.csv)
nav = []
for r in csv.DictReader(open(RAW + 'navaids.csv')):
    if r['iso_country'] != 'US' or r['type'] not in ('VOR', 'VOR-DME', 'VORTAC', 'NDB'): continue
    try: lat = float(r['latitude_deg']); lon = float(r['longitude_deg'])
    except: continue
    if not (37.2 < lat < 38.4 and -122.75 < lon < -121.6): continue
    x, z = W(lon, lat); f = float(r['frequency_khz'])
    nav.append({'type': 'NDB' if r['type'] == 'NDB' else 'VOR', 'ident': r['ident'], 'name': r['name'].title(), 'freq': round(f / 1000, 3) if r['type'] != 'NDB' else f / 1000, 'x': x[0] if isinstance(x, list) else x, 'z': z if not isinstance(z, list) else z[0], 'elev': round(fnum(r['elevation_ft']) * FT, 1)})
json.dump(nav, open(OUT + 'navaids.json', 'w'))
print(nav)
