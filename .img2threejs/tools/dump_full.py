# -*- coding: utf-8 -*-
import json
SPEC = r"C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs/object-sculpt-spec.json"
spec = json.load(open(SPEC, encoding='utf-8'))
for c in spec['componentTree']:
    if c.get('id') == 'rear-reflector-l':
        print(json.dumps(c, ensure_ascii=False, indent=1))
        break
