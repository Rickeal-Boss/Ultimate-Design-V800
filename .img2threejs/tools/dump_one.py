# -*- coding: utf-8 -*-
import json, sys
SPEC = r"C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs/object-sculpt-spec.json"
spec = json.load(open(SPEC, encoding='utf-8'))
want = sys.argv[1:]
for c in spec['componentTree']:
    if c.get('id') in want:
        s = json.dumps(c, ensure_ascii=False, indent=1)
        # 只打前 1200 字符避免刷屏
        print(s[:1500]); print('   ...len:', len(s)); print('======')
