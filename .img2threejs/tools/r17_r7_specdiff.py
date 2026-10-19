import json, subprocess, sys

REPO = r'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800'
old_raw = subprocess.run(
    ['git', '-C', REPO, 'show', 'HEAD:.img2threejs/r7-sculpt-spec.json'],
    capture_output=True, text=True, encoding='utf-8'
).stdout
if not old_raw.strip():
    print('GIT SHOW FAILED')
    sys.exit(1)
old = json.loads(old_raw)
new = json.load(open(f'{REPO}/.img2threejs/r7-sculpt-spec.json', encoding='utf-8'))
o = {c['id']: c for c in old['componentTree']}
n = {c['id']: c for c in new['componentTree']}
print('old:', len(o), 'new:', len(n))
print('removed:', sorted(set(o) - set(n)))
print('added:', sorted(set(n) - set(o)))
changed = [k for k in sorted(set(o) & set(n)) if json.dumps(o[k], sort_keys=True) != json.dumps(n[k], sort_keys=True)]
print(f'changed ({len(changed)}):', changed)
for k in set(old) | set(new):
    if k == 'componentTree':
        continue
    if json.dumps(old.get(k), sort_keys=True) != json.dumps(new.get(k), sort_keys=True):
        print('top-level changed:', k)
