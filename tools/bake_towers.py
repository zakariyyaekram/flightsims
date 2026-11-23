"""Control-tower positions, heights and FAA design types.
Positions: OSM man_made=tower + service=aircraft_control (cross-checked with the TWR symbol on the FAA airport diagrams).
Design types / cab-floor heights: FAA "BIL ATCT Draft Programmatic EA" (June 2023), Appendix B tower-type tables;
1961 towers (HWD, CCR) are pre-standard airport-sponsored designs.
t: design key used by src/airport3d.js buildTower(); h: overall height (m); cf: cab floor height (m)."""
import json, os
ROOT = os.path.join(os.path.dirname(__file__), '..')
T = {
    'KSFO': dict(t='sfo'),                                   # 2016 "torch", 221 ft
    'KOAK': dict(t='oak'),                                   # 2013, 218'-9" to cab floor
    'KSJC': dict(t='ial', h=31.0, cf=23.9),                  # Leo Daly/HNTB IAL 1994, 78'-4" cab floor, chamfered-square cab
    'KNUQ': dict(t='navy', h=22.0, cf=16.0),                 # Navy tower on the operations building
    'KHWD': dict(t='1961', p=[22736.0, -4618.0], h=19.0, cf=13.5, r=4),   # 1961 pre-standard
    'KCCR': dict(t='1961', h=18.6, cf=13.0),                 # 1961 Concord tower (pre-standard)
    'KAPC': dict(t='O', p=[8746.0, -65085.0], h=20.5, cf=14.9, r=4),      # Type O 1965, 48'-10"
    'KLVK': dict(t='avco', p=[49507.0, -8424.0], h=15.5, cf=10.4, r=4),   # Hunt/AVCO 1974, 34'-1", hexagonal cab
    'KPAO': dict(t='L', p=[23413.0, 18040.0], h=13.0, cf=8.5, r=4),       # Type L 1968, 28'-0"
    'KRHV': dict(t='L', h=13.0, cf=8.5),                     # Type L 1967
    'KSQL': dict(t='L', h=13.0, cf=8.5),                     # Type L 1969
}
if __name__ == '__main__':
    path = os.path.join(ROOT, 'data/airports.json'); A = json.load(open(path))
    for a in A:
        s = T.get(a['icao'])
        if not s: continue
        tw = a.get('tower') or {}
        if 'p' in s: tw['p'] = s['p']
        if 'r' in s: tw.setdefault('r', s['r'])
        for k in ('t', 'h', 'cf'):
            if k in s: tw[k] = s[k]
        a['tower'] = tw; print(a['icao'], tw)
    json.dump(A, open(path, 'w'), separators=(',', ':'))
