import json, sys

BASE = r'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs'

spec = json.load(open(f'{BASE}/object-sculpt-spec.json', encoding='utf-8'))
ids = sys.argv[1].split(',')
for c in spec['componentTree']:
    if c['id'] in ids:
        print(json.dumps(c, ensure_ascii=False, indent=1))
        print('-----')
