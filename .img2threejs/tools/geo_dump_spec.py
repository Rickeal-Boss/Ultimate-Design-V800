# -*- coding: utf-8 -*-
"""Dump key components from spec: geometry profile summaries, transforms, materials."""
import json, sys

SPEC = r"C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs/object-sculpt-spec.json"
spec = json.load(open(SPEC, encoding='utf-8'))

print("=== top-level keys ===")
print(list(spec.keys()))
print("\n=== materials ids ===")
for m in spec['materials']:
    print(m.get('id'), '|', m.get('name',''), '|', {k:v for k,v in m.items() if k not in ('id','name','evidence','notes','shaderNotes')})
print("\n=== component count ===", len(spec['componentTree']))

ids = sys.argv[1:] if len(sys.argv)>1 else ['roof-panel','greenhouse-glass','windshield','hood-panel','hood-blister','body-lower','wheel-fl','wheel-fr','wheel-rl','wheel-rr','arch-fr','arch-rr','emblem-shield','tailgate','tail-chrome-strip','rear-reflector-l','rear-reflector-r','rear-reflector-strip-l','rear-reflector-strip-r','dpillar-l','dpillar-r','headliner-rear','roof-rails','fuel-door','fender-badge-l','fender-badge-r','speaker-fr']
for c in spec['componentTree']:
    cid = c.get('id')
    if cid not in ids: continue
    print("\n----", cid, "|", c.get('name',''), "| parent:", c.get('parent'))
    print("  transform:", json.dumps(c.get('transform'), ensure_ascii=False))
    print("  material:", c.get('material'))
    gd = c.get('geometryDescriptor') or c.get('geometry') or {}
    print("  geo keys:", json.dumps(gd, ensure_ascii=False)[:400])
    for k in ('profile','profiles'):
        if k in gd:
            p = gd[k]
            if isinstance(p, list) and p and isinstance(p[0], list):
                print(f"  {k}: {len(p)} pts, first5={p[:5]}, last3={p[-3:]}")
