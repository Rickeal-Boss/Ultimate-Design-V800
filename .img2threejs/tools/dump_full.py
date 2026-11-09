# -*- coding: utf-8 -*-
import json
SPEC = r"<REPO_ROOT>/.img2threejs/object-sculpt-spec.json"
spec = json.load(open(SPEC, encoding='utf-8'))
for c in spec['componentTree']:
    if c.get('id') == 'rear-reflector-l':
        print(json.dumps(c, ensure_ascii=False, indent=1))
        break
