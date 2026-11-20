"""Real tall buildings (OSM height >= 35 m or >= 10 levels) -> data/tall.json"""
import json, sys, os
sys.path.insert(0, '/home/user/workspace/flightsims/tools')
from proj import ll2w
import numpy as np
RAW = '/home/user/workspace/raw/'; OUT = '/home/user/workspace/flightsims/data/'
out = []
for b in json.load(open(RAW + 'bld_sel.json')):
    if b['ap']: continue
    h = b['h'] or (b['lv'] or 0) * 3.5
    if h < 30: continue
    for ring in b['p']:
        r = np.array(ring[:-1]);
        if len(r) < 3: continue
        x, z = ll2w(r[:, 1], r[:, 0])
        out.append([round(h, 1), round(b['mh'] or 0, 1), 1 if b['part'] else 0, [int(round(v)) for xy in zip(x, z) for v in xy], b['col'] or '', (b['name'] or '')[:40]])
json.dump(out, open(OUT + 'tall.json', 'w'), separators=(',', ':'))
print(len(out), os.path.getsize(OUT + 'tall.json'), max(o[0] for o in out))
