"""R17 compact probe: show key geometry fields for matching components.
Usage: r17_compact.py <keyword> [--all]
"""
import json, sys

BASE = r'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs'
SPEC = f'{BASE}/object-sculpt-spec.json'

def fmt_pts(pts):
    return '[' + ', '.join(f'({p[0]:.4f},{p[1]:.4f})' for p in pts) + ']'

def main():
    kw = sys.argv[1] if len(sys.argv) > 1 else ''
    spec = json.load(open(SPEC, encoding='utf-8'))
    tree = spec['componentTree']
    for c in tree:
        cid = c['id']
        if kw and kw not in cid.lower():
            continue
        t = c.get('transform', {})
        mat = c.get('material')
        matid = mat.get('id') if isinstance(mat, dict) else mat
        gd = c.get('geometryDescriptor', {})
        prof = gd.get('profile2D', {})
        pts = prof.get('points')
        depth = prof.get('depth')
        dims = c.get('dimensions', {})
        print(f'== {cid} | prim={c.get("primitive")} | mat={matid}')
        print(f'   pos={t.get("position")} rot={t.get("rotation")} scale={t.get("scale")}')
        if pts:
            print(f'   profile({len(pts)}pts, depth={depth}): {fmt_pts(pts)}')
        if dims:
            print(f'   dims w={dims.get("width")} h={dims.get("height")} d={dims.get("depth")}')
        # other geometry fields
        for k in ('radius', 'height', 'width', 'depth', 'size', 'box', 'segments'):
            if k in gd and k not in ('profile2D',):
                print(f'   gd.{k}={gd[k]}')

if __name__ == '__main__':
    main()
