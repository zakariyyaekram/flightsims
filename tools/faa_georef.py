"""Georeference the FAA airport diagrams (d-TPP) onto the world frame.

Each FAA Airport Diagram PDF (https://aeronav.faa.gov/d-tpp/) draws the runways as filled black quads and
labels taxiways, the tower and hot spots with vector text. The runway quads are matched to the runways in
data/airports.json (OurAirports ends) and a similarity transform (scale + rotation + shift) is solved by
least squares, so every label on the diagram gets a world position.

Output: refs/apd/<ID>.json  {resid_m, labels: [{t, x, z}], twr: [x, z] | null}
"""
import itertools, json, math, re, sys
import numpy as np
import pymupdf
from shapely.geometry import MultiPoint

APD = '/home/user/workspace/refs/apd/'
AIR = json.load(open('/home/user/workspace/flightsims/data/airports.json'))
SKIP = {'HS', 'XX', 'XXX', 'XXXX', 'GA', 'DME', 'VOR', 'PAPI', 'ILS', 'LOC', 'GS', 'OM', 'MM', 'NA', 'ATCT', 'AWOS', 'ASOS', 'TWY', 'APN', 'RAMP', 'CTAF', 'NE', 'SE', 'SW', 'NW', 'TWR', 'FBO', 'UP', 'X', 'ELEV', 'RWY', 'GND', 'CON', 'ATIS', 'TO', 'OF', 'BE', 'IS', 'ALL', 'VAR', 'NOT', 'FOR', 'USE', 'AND', 'NO', 'ON', 'IN', 'AT', 'ASR', 'LAHSO', 'CAT'}
TAXI_RE = re.compile(r'^[A-Z]{1,2}\d{0,2}$')


def quads(page):
    out = []
    for d in page.get_drawings():
        f = d.get('fill')
        if f is None or max(f) > 0.05: continue  # solid black fills only
        pts = []
        for it in d['items']:
            if it[0] == 'l': pts += [it[1], it[2]]
            elif it[0] == 're': r = it[1]; pts += [r.tl, r.tr, r.br, r.bl]
            elif it[0] == 'qu': q = it[1]; pts += [q.ul, q.ur, q.lr, q.ll]
        if len(pts) < 4: continue
        mrr = MultiPoint([(p.x, p.y) for p in pts]).minimum_rotated_rectangle
        if mrr.geom_type != 'Polygon': continue
        c = list(mrr.exterior.coords)[:4]
        e = [math.dist(c[i], c[(i + 1) % 4]) for i in range(4)]
        L, Wd = max(e), min(e)
        if Wd < 0.8 or L / Wd < 10 or L < 25: continue
        i = e.index(L)
        # ends = midpoints of the two short edges
        a = ((c[(i + 1) % 4][0] + c[(i + 2) % 4][0]) / 2, (c[(i + 1) % 4][1] + c[(i + 2) % 4][1]) / 2)
        b = ((c[(i + 3) % 4][0] + c[i][0]) / 2, (c[(i + 3) % 4][1] + c[i][1]) / 2)
        out.append((a, b, L, Wd))
    # merge duplicates (outline + fill drawn twice)
    uniq = []
    for q in sorted(out, key=lambda q: -q[2]):
        if any(math.dist(q[0], u[0]) + math.dist(q[1], u[1]) < 6 or math.dist(q[0], u[1]) + math.dist(q[1], u[0]) < 6 for u in uniq): continue
        uniq.append(q)
    return uniq


def similarity(P, Q):
    """least-squares 2-D similarity (no reflection) mapping P -> Q; returns (s, R, t, rms)"""
    P = np.asarray(P, float); Q = np.asarray(Q, float)
    mp, mq = P.mean(0), Q.mean(0); A, B = P - mp, Q - mq
    U, S, Vt = np.linalg.svd(A.T @ B)
    D = np.diag([1, np.sign(np.linalg.det(U @ Vt))])
    R = (U @ D @ Vt).T
    if np.linalg.det(R) < 0: return None
    s = (S * np.diag(D)).sum() / (A ** 2).sum()
    t = mq - s * (R @ mp)
    res = (s * (R @ P.T)).T + t - Q
    return s, R, t, float(np.sqrt((res ** 2).sum(1).mean()))


def solve(icao, pdf):
    a = next(x for x in AIR if x['icao'] == icao)
    page = pymupdf.open(pdf)[0]
    Q = quads(page)
    rw = a['runways']
    best = None
    words = page.get_text('words')
    # runway-end designators printed at each threshold: used to pick the right end/flip
    idw = {}
    for w in words:
        k = w[4].strip().lstrip('0')
        idw.setdefault(k, []).append(((w[0] + w[2]) / 2, (w[1] + w[3]) / 2))
    def id_pen(s_, R_, t_):
        pen, n = 0.0, 0
        for r in rw:
            for e, key in ((r['le'], r['id'][0]), (r['he'], r['id'][1])):
                c = idw.get(key.lstrip('0'))
                if not c: continue
                d = min(math.dist((s_ * (R_ @ np.array(q)) + t_).tolist(), e) for q in c)
                pen += min(d, 2000); n += 1
        return pen / max(n, 1)
    n = min(len(rw), len(Q))
    cand = sorted(Q, key=lambda q: -q[2])[:max(n + 3, 6)]
    for sub in itertools.permutations(range(len(cand)), len(rw)) if len(cand) >= len(rw) else []:
        # quick length-ratio gate
        ratios = [cand[j][2] / rw[i]['len'] for i, j in enumerate(sub)]
        if max(ratios) / min(ratios) > 1.25: continue
        for flips in itertools.product([0, 1], repeat=len(rw)):
            P, W = [], []
            for i, j in enumerate(sub):
                e0, e1 = cand[j][0], cand[j][1]
                if flips[i]: e0, e1 = e1, e0
                P += [e0, e1]; W += [rw[i]['le'], rw[i]['he']]
            r = similarity(P, W)
            if not r: continue
            sc = r[3] + 0.25 * id_pen(r[0], r[1], r[2])
            if best is None or sc < best[3]: best = (r, sub, flips, sc)
    if not best: print(icao, 'no runway match', len(Q)); return None
    (s, R, t, rms), sub, flips, sc = best
    idp = id_pen(s, R, t)
    f = lambda x, y: (s * (R @ np.array([x, y])) + t).tolist()
    labels, twr = [], None
    for w in words:
        txt = w[4].strip().rstrip('.')
        cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
        if txt == 'TWR' or txt == 'TOWER':
            q = f(cx, cy)
            if math.dist(q, (a['x'], a['z'])) < 2500 and (twr is None or math.dist(q, (a['x'], a['z'])) < math.dist(twr, (a['x'], a['z']))): twr = q
        if not TAXI_RE.match(txt) or txt in SKIP: continue
        if re.match(r'^\d', txt): continue
        x, z = f(cx, cy)
        labels.append({'t': txt, 'x': round(x, 1), 'z': round(z, 1), 'h': round((w[3] - w[1]) * s, 1)})
    # TWR arrow: the label points at the tower with an arrow; keep the label spot as an approximation
    out = {'icao': icao, 'resid_m': round(rms, 1), 'scale_m_per_pt': round(s, 2), 'labels': labels, 'twr': twr,
           'quads': [[f(*q[0]), f(*q[1])] for q in Q]}
    json.dump(out, open(APD + icao + '.json', 'w'))
    out['id_pen_m'] = round(idp, 1); json.dump(out, open(APD + icao + '.json', 'w'))
    print(icao, 'rms %.1f m' % rms, 'idpen %.0f m' % idp, 'scale %.2f m/pt' % s, 'labels', len(labels), 'twr', twr)
    return out


if __name__ == '__main__':
    ids = sys.argv[1:] or ['SFO', 'OAK', 'SJC', 'NUQ', 'HWD', 'SQL', 'PAO', 'LVK', 'CCR', 'APC', 'RHV']
    for i in ids: solve('K' + i, APD + i + '.pdf')
