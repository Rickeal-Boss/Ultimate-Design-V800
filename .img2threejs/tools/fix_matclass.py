# -*- coding: utf-8 -*-
import json
SPEC = r"<REPO_ROOT>/.img2threejs/object-sculpt-spec.json"
raw = open(SPEC, encoding='utf-8', newline='').read()
spec = json.loads(raw)
for c in spec['componentTree']:
    if c['id'] in ('apillar-l', 'apillar-r'):
        c['colorMaterialRecipe']['materialClass'] = 'metal'
out = json.dumps(spec, ensure_ascii=False, indent=1)
open(SPEC, 'w', encoding='utf-8', newline='').write(out.replace('\n', '\r\n'))
print('fixed')
