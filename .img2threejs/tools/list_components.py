# -*- coding: utf-8 -*-
import json
SPEC = r"<REPO_ROOT>/.img2threejs/object-sculpt-spec.json"
spec = json.load(open(SPEC, encoding='utf-8'))
def tri_est(c):
    gd = c.get('geometryDescriptor') or {}
    n = 0
    if 'profile2D' in gd:
        n = max(len(gd['profile2D'].get('points', [])) - 1, 0) * 2 * 2  # rough: sides+caps
    return n
rows = []
for i, c in enumerate(spec['componentTree']):
    rows.append((i, c.get('id'), c.get('parent'), c.get('importance', c.get('priority','?')), tri_est(c)))
for r in rows:
    print(r[0], r[1], '| parent:', r[2], '| imp:', r[3], '| ~tri:', r[4])
