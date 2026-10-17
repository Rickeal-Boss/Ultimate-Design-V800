# -*- coding: utf-8 -*-
import json
SPEC = r"C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs/object-sculpt-spec.json"
spec = json.load(open(SPEC, encoding='utf-8'))
want = {'roof-panel','greenhouse-glass','body-lower','windshield','dpillar-l','headliner-rear','starlight-headliner','overhead-console','lidar-wedge','tailgate','tail-chrome-strip','rear-reflector-l','emblem-shield'}
def shoelace(pts):
    s = 0
    for i in range(len(pts)):
        x1,y1 = pts[i]; x2,y2 = pts[(i+1)%len(pts)]
        s += x1*y2 - x2*y1
    return s/2
for c in spec['componentTree']:
    if c.get('id') not in want: continue
    gd = c['geometryDescriptor']
    t = c['transform']
    print('=====', c['id'], '| parent:', c.get('parent'))
    print(' transform:', json.dumps(t))
    p = gd.get('profile2D')
    if p:
        pts = p['points']
        print(f" profile {len(pts)} pts, depth={p.get('depth')}, shoelace={shoelace(pts):+.4f}")
        # 压缩打印：每行 6 个点
        for i in range(0, len(pts), 6):
            print('  ', ', '.join(f'[{x},{y}]' for x,y in pts[i:i+6]))
    for k in ('latheProfile','tubePath'):
        if k in gd:
            print(f' {k}:', json.dumps(gd[k])[:300])
