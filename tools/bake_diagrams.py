"""Bake the FAA Airport Diagrams (d-TPP) into georeferenced images for the in-sim taxi chart.

For each tower-controlled airport the official FAA Airport Diagram PDF is downloaded from
https://aeronav.faa.gov/d-tpp/<cycle>/<num>AD.PDF, the runway slabs (solid black filled quads) are
detected and matched to data/airports.json runway ends, and a complex similarity transform
    page_pt = a * (x + i*z) + b          (x east, z south, metres; page in PDF points)
is solved by least squares (rotation limited to +-135 deg, runway-designator labels break ties).
The page is rendered to a quantized PNG and data/diagrams/index.json records the transform,
render scale, chart cycle/effective dates, source URL and the FAA hot-spot list.

usage: python3 tools/bake_diagrams.py [cycle]   (needs pymupdf, numpy, opencv, pillow)
"""
import itertools, json, math, os, re, sys, urllib.request
import numpy as np, cv2, pymupdf
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'diagrams')
CYCLE = sys.argv[1] if len(sys.argv) > 1 else '2611'
EFFECTIVE = '29 OCT 2026 to 26 NOV 2026'
CACHE = '/tmp/apd'
# FAA d-TPP procedure numbers of the Airport Diagram (AD) for each airport
NUM = {'KSFO': '00375', 'KOAK': '00294', 'KSJC': '00693', 'KNUQ': '00410', 'KHWD': '05015', 'KSQL': '09219',
       'KPAO': '09216', 'KLVK': '06075', 'KCCR': '05320', 'KAPC': '00281', 'KRHV': '05591'}
HOTSPOT_PDF = f'https://aeronav.faa.gov/d-tpp/{CYCLE}/SW2HOTSPOT.PDF'
SCALE = 3.5  # render pixels per PDF point


def fetch(url, fn):
    if not os.path.exists(fn):
        os.makedirs(os.path.dirname(fn), exist_ok=True)
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        open(fn, 'wb').write(urllib.request.urlopen(req, timeout=60).read())
    return fn


def slabs(page):
    out = []
    for x in page.get_drawings():
        if x['type'] != 'f' or x.get('fill') != (0.0, 0.0, 0.0): continue
        pts = []
        for it in x['items']:
            for q in it[1:]:
                if isinstance(q, pymupdf.Point): pts.append((q.x, q.y))
                elif isinstance(q, pymupdf.Rect): pts += [(q.x0, q.y0), (q.x1, q.y1), (q.x0, q.y1), (q.x1, q.y0)]
                elif isinstance(q, pymupdf.Quad): pts += [(q.ul.x, q.ul.y), (q.ur.x, q.ur.y), (q.ll.x, q.ll.y), (q.lr.x, q.lr.y)]
        if len(pts) < 3: continue
        (cx, cy), (w, h), ang = cv2.minAreaRect(np.array(pts, np.float32))
        L, W = max(w, h), min(w, h)
        if L > 40 and W > 1.5 and L / W > 8:
            t = math.radians(ang if w >= h else ang + 90); d = complex(math.cos(t), math.sin(t)) * L / 2
            out.append((complex(cx, cy) - d, complex(cx, cy) + d, L))
    return out


def fit(a, page):
    P = sorted(slabs(page), key=lambda q: -q[2])[:len(a['runways']) + 2]
    W = [(complex(*r['le']), complex(*r['he'])) for r in a['runways']]
    words = page.get_text('words'); best = None
    for perm in itertools.permutations(range(len(P)), len(W)):
        for flips in itertools.product([0, 1], repeat=len(W)):
            zs, ws = [], []
            for k, (i, fl) in enumerate(zip(perm, flips)):
                e = P[i][:2] if not fl else P[i][1::-1]; zs += list(W[k]); ws += list(e)
            z = np.array(zs); w = np.array(ws); A = np.vstack([z, np.ones_like(z)]).T
            sol, *_ = np.linalg.lstsq(A, w, rcond=None)
            if abs(np.degrees(np.angle(sol[0]))) > 135: continue
            err = np.sqrt((np.abs(A @ sol - w) ** 2).mean()) / abs(sol[0])
            lp = 0
            for k, r in enumerate(a['runways']):
                for e, idd in enumerate(r['id']):
                    pt = sol[0] * W[k][e] + sol[1]
                    c = [complex((q[0] + q[2]) / 2, (q[1] + q[3]) / 2) for q in words if q[4].strip() == idd]
                    lp += min([abs(x - pt) for x in c] + [60 * abs(sol[0])]) / abs(sol[0])
            tot = err + 0.5 * lp / (2 * len(W))
            if best is None or tot < best[0]: best = (tot, sol, err)
    return best[1], best[2]


def hotspots():
    """FAA hot-spot list (Southwest vol. 2): {IATA: [{n, t}]}"""
    # hot.json is parsed from the table in the FAA PDF; if the cached parse is missing, keep the last baked list
    fetch(HOTSPOT_PDF, f'{CACHE}/hot.pdf')
    fn = f'{CACHE}/hot.json'; res = {}
    if os.path.exists(fn): res = json.load(open(fn))
    else:
        old = os.path.join(OUT, 'index.json')
        if os.path.exists(old): res = {k[1:]: v['hot'] for k, v in json.load(open(old)).items()}
    for k, v in res.items():
        for h in v:
            h['t'] = re.split(r'\s*\d{1,2} [A-Z]{3} \d{4} to', h['t'])[0].strip()
    return res


def main():
    os.makedirs(OUT, exist_ok=True)
    air = json.load(open(os.path.join(ROOT, 'data', 'airports.json')))
    hot = hotspots(); idx = {}
    for icao, num in NUM.items():
        a = next(x for x in air if x['icao'] == icao)
        url = f'https://aeronav.faa.gov/d-tpp/{CYCLE}/{num}AD.PDF'
        page = pymupdf.open(fetch(url, f'{CACHE}/{icao[1:]}.pdf'))[0]
        sol, rms = fit(a, page)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(SCALE, SCALE), alpha=False)
        im = Image.frombytes('RGB', (pix.width, pix.height), pix.samples).convert('L')
        im = im.quantize(16, dither=Image.Dither.NONE)
        name = f'{icao}.png'; im.save(os.path.join(OUT, name), optimize=True)
        idx[icao] = dict(img=name, w=pix.width, h=pix.height, S=SCALE,
                         a=[round(sol[0].real, 7), round(sol[0].imag, 7)], b=[round(sol[1].real, 3), round(sol[1].imag, 3)],
                         rms=round(float(rms), 1), cycle=CYCLE, eff=EFFECTIVE, src=url, hot=hot.get(icao[1:], []),
                         hotSrc=HOTSPOT_PDF)
        print(icao, 'rms', round(float(rms), 1), 'rot', round(float(np.degrees(np.angle(sol[0]))), 1), pix.width, pix.height)
    json.dump(idx, open(os.path.join(OUT, 'index.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
