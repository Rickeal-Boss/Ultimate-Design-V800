import json, sys

BASE = r'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs'

def load(name):
    return json.load(open(f'{BASE}/{name}', encoding='utf-8'))

def show(spec_name, keyword):
    spec = load(spec_name)
    tree = spec['componentTree']
    print(f'== {spec_name}: {len(tree)} components, keyword={keyword!r}')
    for c in tree:
        cid = c['id']
        if keyword in cid.lower():
            t = c.get('transform', {})
            mat = c.get('material')
            matid = mat.get('id') if isinstance(mat, dict) else mat
            print(f'  {cid} | prim={c.get("primitive", c.get("type","?"))} | scale={t.get("scale")} | pos={t.get("position")} | mat={matid}')

if __name__ == '__main__':
    spec_name = sys.argv[1] if len(sys.argv) > 1 else 'object-sculpt-spec.json'
    keyword = sys.argv[2] if len(sys.argv) > 2 else ''
    if keyword:
        show(spec_name, keyword)
    else:
        spec = load(spec_name)
        print(f'== {spec_name}: {len(spec["componentTree"])} components')
        for c in spec['componentTree']:
            t = c.get('transform', {})
            mat = c.get('material')
            matid = mat.get('id') if isinstance(mat, dict) else mat
            print(f"  {c['id']} | {c.get('primitive', c.get('type','?'))} | scale={t.get('scale')} | pos={t.get('position')} | mat={matid}")
