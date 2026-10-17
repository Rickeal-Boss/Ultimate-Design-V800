# -*- coding: utf-8 -*-
"""R12b 手术：轮拱退化件删除 + 前两排座椅朝向翻正/三排重排 + 门板外移 + 前轮罩内饰板。

依据（2026-10-18 主理人接管波）：
- geo-r12 实测：seat-driver 靠背在坐垫 +Z 端 → 乘员面朝车尾；方向盘/仪表台在 +Z。
- mat-r12 消去法：arch-fr/arch-rr 是 x≈0 中剖面 3mm 薄环，下弧穿地 → 用户所见"轮底皮带"。
- 外部审查：door-panel-* 外表面 0.975 < 车身 1.003 → 门板整体嵌进壳体不可见。
- 用户：车内方向盘/刹车/座椅同步改善 —— 前轮辐从脚坑可见，补轮罩内饰板遮挡。

改完必须重跑 validate/strict/generate + #uvassert + bbox 包络。
"""
import json
import math
import copy
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = ROOT / '.img2threejs' / 'object-sculpt-spec.json'

spec = json.loads(SPEC.read_text(encoding='utf-8'))
nodes = spec['componentTree']
by_id = {n['id']: n for n in nodes}

changed = []

# ---------- T1 删除退化轮拱环（x≈0 中剖面薄环，穿地且被壳体包裹） ----------
for arch_id in ('arch-fr', 'arch-rr'):
    if arch_id in by_id:
        nodes.remove(by_id[arch_id])
        changed.append(f'del {arch_id}')

# ---------- T2 前两排座椅朝向翻正（rotY π） + 纵向重排 ----------
# 旋转 π 后：坐垫由 +Z 端改到 -Z 端（靠背落到乘员背后），乘员面朝 +Z（仪表台）。
seat_rows = [
    ('seat-driver', 0.92),
    ('seat-passenger', 0.92),
    ('seat-rear-l', 0.30),
    ('seat-rear-r', 0.30),
]
for sid, z in seat_rows:
    n = by_id[sid]
    n['transform']['rotation'] = [0.0, math.pi, 0.0]
    n['transform']['position'][2] = z
    # 翻面后原「靠背侧」的附件偏移需保持相对一致：attachment 是点接触（退化），由 transform 驱动
    changed.append(f'{sid} rotY=pi z={z}')

# 三排：整排后移 1.17m（原 z -0.13 与二排翻面后冲突）
for tid, dz in (('seat-third-row', -1.17), ('seat-third-row-back', -1.17), ('seat-third-row-headrest', -1.17)):
    n = by_id[tid]
    n['transform']['position'][2] += dz
    changed.append(f'{tid} z{delta if (delta:=dz) else 0}')

# ---------- T3 门板外移 30mm（外表面 0.975 → 1.005，与车身 1.003 齐平微凸） ----------
for pid, sign in (('door-panel-fl', 1), ('door-panel-fr', -1), ('door-panel-rl', 1), ('door-panel-rr', -1)):
    n = by_id[pid]
    n['transform']['position'][0] = round(sign * 0.97, 4)
    changed.append(f'{pid} x={sign*0.97}')

# ---------- T4 前轮罩内饰板 ×2（遮挡脚坑里可见的轮辐，matte-black） ----------
template = copy.deepcopy(by_id['rear-control-screen'])
for side, sx in (('l', 1.0), ('r', -1.0)):
    node = copy.deepcopy(template)
    node['id'] = f'footwell-arch-cover-{side}'
    node['name'] = f'前轮罩内饰板({side})'
    node['level'] = 'micro'
    node['role'] = 'detail'
    node['importance'] = 0.35
    node['parent'] = 'root'
    node['attachment'] = None
    node['primitive'] = 'plane-card'
    node['geometryDescriptor']['topologyIntent'] = 'hard-surface precise'
    node['geometryDescriptor']['edgeTreatment'] = {'type': 'bevel', 'bevelRadius': 0.004, 'segments': 2}
    node['transform'] = {
        'position': [round(sx * 0.735, 4), 0.58, 1.62],
        'rotation': [0.0, round(-sx * math.pi / 2, 4), 0.0],
        'scale': [0.74, 0.60, 0.006],
    }
    node['dimensions'] = {'width': 0.74, 'height': 0.60, 'depth': 0.006, 'units': 'meters', 'confidence': 0.6}
    node['material'] = 'matte-black'
    node['materialLayers'] = ['matte-black']
    node['colorMaterialRecipe'] = {
        'dominantAlbedo': 'rgba(18, 18, 20, 1.0)',
        'secondaryAlbedo': 'rgba(18, 18, 20, 1.0)',
        'materialClass': 'plastic',
        'materialClassConfidence': 0.9,
    }
    node['evidenceRefs'] = ['img-design-black']
    node['localFeatures'] = []
    node['details'] = []
    node['notes'] = 'R12b：前脚坑内侧轮罩内饰板，遮挡经脚坑可见的轮辐/轮辋几何（用户实锤）。'
    nodes.append(node)
    changed.append(f'add footwell-arch-cover-{side}')

SPEC.write_text(json.dumps(spec, ensure_ascii=False, indent=1), encoding='utf-8')
print('components', len(nodes))
for c in changed:
    print(' -', c)
