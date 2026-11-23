"""Name every taxiway from the current FAA Airport Diagram.

refs/apd/<ICAO>.json (tools/faa_georef.py) holds the diagram's taxiway labels in world coordinates.
OSM taxiway ways are joined into continuous strokes (ways meeting end-to-end with < 35 deg of bend and no
conflicting OSM name). Every label votes for the nearest stroke; a stroke takes the winning label.
Strokes with no vote keep their OSM name. Writes t.ref (final), t.osm (original OSM ref) and t.src.
Airports without an FAA diagram (O69, HAF, DVO) keep the OSM names.
"""
import json, math, os, collections
AIR_P = '/home/user/workspace/flightsims/data/airports.json'
APD = '/home/user/workspace/refs/apd/'
air = json.load(open(AIR_P))


def seg_d(px, pz, a, b):
    dx, dz = b[0] - a[0], b[1] - a[1]; L2 = dx * dx + dz * dz or 1
    t = max(0, min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / L2))
    return math.hypot(a[0] + dx * t - px, a[1] + dz * t - pz)


def poly_d(px, pz, p): return min(seg_d(px, pz, p[i - 1], p[i]) for i in range(1, len(p)))


def ang(a, b): return math.atan2(b[1] - a[1], b[0] - a[0])


report = {}
for a in air:
    tw = [t for t in a['taxiways'] if not t.get('lane') and len(t['p']) >= 2]
    for t in a['taxiways']:
        if 'osm' not in t: t['osm'] = t.get('ref')
        t['ref'] = t['osm']; t['src'] = 'osm' if t['osm'] else None
    path = APD + a['icao'] + '.json'
    if not os.path.exists(path): report[a['icao']] = 'no FAA diagram - OSM names kept'; continue
    g = json.load(open(path))
    labels = [l for l in g['labels'] if poly_d(l['x'], l['z'], [[a['x'] - 1e5, a['z']], [a['x'] + 1e5, a['z']]]) < 1e9]
    # ---- strokes: union-find over way ends
    parent = list(range(len(tw)))
    def find(i):
        while parent[i] != i: parent[i] = parent[parent[i]]; i = parent[i]
        return i
    ends = []
    for i, t in enumerate(tw):
        p = t['p']
        ends.append((i, p[0], ang(p[1], p[0])))      # outward direction at start
        ends.append((i, p[-1], ang(p[-2], p[-1])))   # outward direction at end
    for x in range(len(ends)):
        for y in range(x + 1, len(ends)):
            i, P, A = ends[x]; j, Q, B = ends[y]
            if i == j or math.dist(P, Q) > 6: continue
            # continuing straight: outward directions are opposite
            d = abs(((A - B + math.pi) % (2 * math.pi)) - math.pi)
            if abs(d - math.pi) > math.radians(35): continue
            ri, rj = tw[i]['osm'], tw[j]['osm']
            if ri and rj and ri != rj: continue
            parent[find(i)] = find(j)
    strokes = collections.defaultdict(list)
    for i in range(len(tw)): strokes[find(i)].append(i)
    # ---- votes: each label -> nearest stroke within 75 m (scaled by label size)
    votes = collections.defaultdict(collections.Counter)
    for l in labels:
        best, bd = None, 1e9
        for k, ids in strokes.items():
            d = min(poly_d(l['x'], l['z'], tw[i]['p']) for i in ids)
            if d < bd: best, bd = k, d
        if best is not None and bd < 75: votes[best][l['t']] += 1.0 / (1 + bd / 25)
    changed, filled, kept = [], 0, 0
    faa_names = {l['t'] for l in labels}
    for k, ids in strokes.items():
        if not votes[k]: continue
        name, w = votes[k].most_common(1)[0]
        for i in ids:
            t = tw[i]
            if t['osm'] == name: t['src'] = 'faa+osm'; kept += 1
            elif t['osm'] and (t['osm'] in faa_names or w < 1.2):
                # OSM name is still on the current diagram: a neighbouring label is the likelier vote winner
                t['src'] = 'osm'
            else:
                if t['osm']: changed.append((t['osm'], name))
                else: filled += 1
                t['ref'] = name; t['src'] = 'faa'
    named = sum(1 for t in tw if t['ref'])
    report[a['icao']] = f"labels {len(labels)} strokes {len(strokes)} confirmed {kept} filled {filled} renamed {len(changed)} {collections.Counter(changed).most_common(12)}; named {named}/{len(tw)}"
json.dump(air, open(AIR_P, 'w'), separators=(',', ':'))
for k, v in report.items(): print(k, v)
