"""R11-T1 前悬收缩手术（脚本可重复运行，幂等由 z 基准判断）
1. body-lower profile: 鼻面压缩 z>2.30 → 2.30+(z-2.30)*0.19（鼻顶 2.658→2.368，前悬 0.943→0.653）
2. front-end 容器: z 2.6→2.33, rotX -0.3→-0.12（贴合变陡鼻面）
其余（底唇/轮拱/后端/轮位）一律不动。
"""
import json

PATH = '.img2threejs/object-sculpt-spec.json'
Z0 = 2.30
K = 0.19

spec = json.load(open(PATH, encoding='utf-8'))

def find(node, out):
    if isinstance(node, dict):
        if 'id' in node:
            out[node['id']] = node
        for v in node.values():
            find(v, out)
    elif isinstance(node, list):
        for v in node:
            find(v, out)

comps = {}
find(spec['componentTree'], comps)

# --- 1. body-lower 鼻面压缩 ---
bl = comps['body-lower']
pts = bl['geometryDescriptor']['profile2D']['points']
moved = 0
for p in pts:
    if p[0] > Z0 + 1e-9:
        p[0] = round(Z0 + (p[0] - Z0) * K, 4)
        moved += 1
# shoelace 校验（CCW）
area = 0.0
n = len(pts)
for i in range(n):
    x1, y1 = pts[i]
    x2, y2 = pts[(i + 1) % n]
    area += x1 * y2 - x2 * y1
print(f'body-lower: moved {moved} nose pts, shoelace/2 = {area / 2:.4f} (must be >0)')
assert area > 0, 'profile 绕序不是 CCW！'
maxz = max(p[0] for p in pts)
minz = min(p[0] for p in pts)
print(f'body-lower profile z range: {minz} .. {maxz}')
# 同步 dimensions（长度真源记录）
dims = bl.get('dimensions')
if dims:
    old_l = dims.get('length')
    dims['length'] = round(maxz - minz, 3)
    print(f'dimensions.length {old_l} -> {dims["length"]}')

# --- 2. front-end 容器 ---
fe = comps['front-end']
t = fe['transform']
old_pos_z = t['position'][2]
old_rot = t['rotation'][0]
t['position'][2] = 2.33
t['rotation'][0] = -0.12
print(f"front-end: z {old_pos_z} -> 2.33, rotX {old_rot} -> -0.12")

json.dump(spec, open(PATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('SAVED')
