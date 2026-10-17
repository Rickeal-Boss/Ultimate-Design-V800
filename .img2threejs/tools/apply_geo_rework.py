# -*- coding: utf-8 -*-
"""V800 spec 几何改造：六项改造一次落地。只改 object-sculpt-spec.json。"""
import json, math, shutil

SPEC = r"C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs/object-sculpt-spec.json"
BACKUP = SPEC + ".bak-geo"
shutil.copyfile(SPEC, BACKUP)

with open(SPEC, encoding='utf-8', newline='') as f:
    raw = f.read()
spec = json.loads(raw)

by_id = {c['id']: c for c in spec['componentTree']}
PI = math.pi

def shoelace(pts):
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]; x2, y2 = pts[(i + 1) % len(pts)]
        s += x1 * y2 - x2 * y1
    return s / 2.0

# 通用 20 点 rounded-rect profile（4 段弧，22.5°/段，单位空间）——取自 rear-reflector-l
REF20 = None
for c in spec['componentTree']:
    if c['id'] == 'rear-reflector-l':
        REF20 = [list(p) for p in c['geometryDescriptor']['profile2D']['points']]
        break
assert REF20 and len(REF20) == 20

# ---------- 0) 砍除 3 个低价值件（adapter 无引用、特征清单无 EX-/IN- 编号）----------
CUTS = ['hood-blister', 'tail-window-trim', 'front-plate']
before = len(spec['componentTree'])
spec['componentTree'] = [c for c in spec['componentTree'] if c['id'] not in CUTS]
assert len(spec['componentTree']) == before - 3

# ---------- 1a) roof-panel：抬高 +0.115、前缘重落位 ----------
ROOF33 = [
    [1.14, 1.832], [0.7, 1.834], [0.36, 1.8353], [0.3582, 1.8355], [0.3566, 1.8357], [0.355, 1.8359],
    [0.2, 1.833], [-0.2, 1.835], [-1.55, 1.835], [-1.8, 1.835], [-1.9468, 1.835], [-1.9489, 1.8351],
    [-1.951, 1.8354], [-1.9531, 1.8358], [-1.9969, 1.8472], [-1.999, 1.8476], [-2.0011, 1.8479],
    [-2.0032, 1.848], [-2.26, 1.848], [-2.3379, 1.7185], [-2.3392, 1.7161], [-2.3404, 1.7137],
    [-2.3415, 1.7113], [-2.38, 1.615], [-2.3043, 1.615], [-2.3014, 1.6151], [-2.2987, 1.6155],
    [-2.2959, 1.6162], [-1.8041, 1.7588], [-1.8013, 1.7595], [-1.7986, 1.7599], [-1.7957, 1.76],
    [0.4, 1.76],
]
assert len(ROOF33) == 33 and shoelace(ROOF33) > 0
by_id['roof-panel']['geometryDescriptor']['profile2D']['points'] = ROOF33
by_id['roof-panel']['notes'] = (
    by_id['roof-panel'].get('notes', '') +
    ' | 2026-10-17 第四轮几何改造：整车顶线 +0.115（主顶 1.835、EX-15 后段台阶 1.848 保留）；'
    '前缘自 z0.98 重落位至 z1.14，落在新风挡上沿正上方（cowl z1.62 + 55° 风挡 → 玻璃顶 z≈1.127），消除悬空外伸。')

# ---------- 1b) greenhouse-glass：A 柱线跟随 + 顶线跟随 ----------
GH15 = [
    [1.6, 1.1006], [1.6116, 1.1059], [1.615, 1.1181], [1.6079, 1.1285], [1.18, 1.7565],
    [1.1758, 1.7585], [1.1716, 1.7599], [1.1673, 1.7606], [-0.3, 1.76], [-1.8, 1.76],
    [-2.3, 1.675], [-2.4092, 1.1778], [-2.4087, 1.1597], [-2.3979, 1.1452], [-2.3807, 1.1395],
]
assert len(GH15) == 15 and shoelace(GH15) > 0
by_id['greenhouse-glass']['geometryDescriptor']['profile2D']['points'] = GH15
by_id['greenhouse-glass']['notes'] = (
    by_id['greenhouse-glass'].get('notes', '') +
    ' | 2026-10-17 第四轮几何改造：DLO 前缘随新 A 柱线前移至 cowl（z1.615@腰带 → z1.167@顶），顶线 1.645→1.76。')

# ---------- 1c) windshield：55° 近垂直重落位 ----------
w = by_id['windshield']
w['transform'] = {"position": [0.0, 1.8195, 1.127], "rotation": [0.9599, 0.0, 0.0], "scale": [1.5, 0.025, 0.86]}
if isinstance(w.get('dimensions'), dict):
    w['dimensions']['depth'] = 0.86
w['notes'] = (w.get('notes', '') +
    ' | 2026-10-17 第四轮几何改造：rotX 0.5236→0.9599（与水平面 55°），底边落 cowl（z1.620, y1.115），'
    '顶边(1.127,1.8195)塞入新车顶前缘(1.14,1.832)之下，消除 0.36m 豁口与穿顶。')

# ---------- 1d) hood-panel：缩短至 0.95、后缘落 cowl、双端贴腰线 ----------
h = by_id['hood-panel']
h['transform'] = {"position": [0.0, 1.079, 1.62], "rotation": [0.083, 0.0, 0.0], "scale": [1.3, 0.035, 0.95]}
if isinstance(h.get('dimensions'), dict):
    h['dimensions']['depth'] = 0.95
h['notes'] = (h.get('notes', '') +
    ' | 2026-10-17 第四轮几何改造：长度 1.3→0.95（前缘保持实测格栅顶 2.57，后缘落到 cowl z1.62），'
    'rotX 0.083 使前后缘均贴合 body-lower 腰线（1.079→1.0）。hood-blister 已砍除。')

# ---------- 2) 新增 A 柱 ×2 与 cowl 饰板 ----------
def make_component(cid, name, importance, material, transform, dims, recipe, note, feature, evidence):
    return {
        "id": cid, "name": name, "level": "meso", "role": "body", "importance": importance,
        "confidence": 0.86, "primitive": "extrude", "topologyClass": "assembled-solid",
        "topologyRationale": "薄板/回转体，硬表面可展拓扑",
        "geometryDescriptor": {
            "topologyIntent": "rounded-rectangle extrusion: perimeter corners radiused with 4-facet arcs (22.5deg per facet) instead of hard 90deg box edges",
            "edgeTreatment": {"type": "rounded", "bevelRadius": 0.004, "segments": 4},
            "deformationStack": [],
            "uvStrategy": "generated procedural coordinates",
            "normalStrategy": "vertex normals from generated geometry",
            "profile2D": {"points": [list(p) for p in REF20], "depth": 1.0},
        },
        "parent": "root", "attachment": None,
        "dimensions": {"width": dims[0], "height": dims[1], "depth": dims[2], "units": "meters", "confidence": 0.84},
        "transform": transform,
        "actionProfile": {
            "animationRole": "static",
            "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9},
            "transformChannels": {"translate": False, "rotate": False, "scale": False, "bend": False,
                                   "twist": False, "detach": False, "visibility": True, "materialState": True},
            "sockets": [],
            "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": False, "notes": ""},
            "constraints": [],
            "destruction": {"breakable": False, "fractureGroup": "root", "seamRefs": [],
                             "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"},
        },
        "material": material, "materialLayers": [material], "deformations": [], "joints": [], "seams": [],
        "localFeatures": [{"name": feature, "kind": "trim-panel", "note": note}],
        "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "",
                           "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""},
        "evidenceRefs": [evidence], "details": [], "fidelityTier": "hero",
        "colorMaterialRecipe": recipe, "notes": note,
    }

paint_recipe = {"dominantAlbedo": "rgba(201, 168, 107, 1.0)", "secondaryAlbedo": "rgba(201, 168, 107, 1.0)",
                "materialClass": "paint", "materialClassConfidence": 0.86}
black_recipe = {"dominantAlbedo": "rgba(18, 18, 20, 1.0)", "secondaryAlbedo": "rgba(18, 18, 20, 1.0)",
                "materialClass": "plastic", "materialClassConfidence": 0.86}

apillar_note = ("EX-14/2026-10-17 第四轮几何改造：新增 A 柱（左），从 cowl 角(±0.93,1.123,1.621)到车顶前缘角(±0.93,1.80,1.14)，"
                "与 55° 风挡平行（rotX 0.953），截面 0.075×0.065 车身漆面，填合风挡与顶棚前缘之间的三角区。")
cowl_note = ("2026-10-17 第四轮几何改造：新增前围 cowl 黑色饰板，位于机盖后缘(z1.62)与风挡底(z1.6203)交接处，"
             "宽1.45×深0.16×厚0.03，rotX 0.09 随腰线微倾，上缘 y1.12 衔接风挡底 y1.115。")

spec['componentTree'].append(make_component(
    'apillar-l', 'A 柱左', 0.85, 'paint-upper',
    {"position": [0.93, 1.8, 1.14], "rotation": [0.953, 0.0, 0.0], "scale": [0.075, 0.065, 0.83]},
    (0.075, 0.065, 0.83), paint_recipe, apillar_note, 'A 柱漆面饰条（左）', 'img-headlamp-front'))
spec['componentTree'].append(make_component(
    'apillar-r', 'A 柱右', 0.85, 'paint-upper',
    {"position": [-0.93, 1.8, 1.14], "rotation": [0.953, 0.0, 0.0], "scale": [0.075, 0.065, 0.83]},
    (0.075, 0.065, 0.83), paint_recipe, apillar_note.replace('（左）', '（右）'), 'A 柱漆面饰条（右）', 'img-headlamp-front'))
spec['componentTree'].append(make_component(
    'cowl-panel', '前围饰板', 0.8, 'matte-black',
    {"position": [0.0, 1.105, 1.54], "rotation": [0.09, 0.0, 0.0], "scale": [1.45, 0.03, 0.16]},
    (1.45, 0.03, 0.16), black_recipe, cowl_note, '风挡下沿黑色前围饰板', 'img-headlamp-front'))

# ---------- 3a) body-lower：轮拱真开口（实测轮心 z=±1.715，胎半径 0.382）----------
bl = by_id['body-lower']
pts = [list(p) for p in bl['geometryDescriptor']['profile2D']['points']]
R = 0.452          # 胎 0.382 + 0.07
CY = 0.382         # 轮心高
YB = 0.2           # profile 底边
ZC = [1.715, -1.715]
hw = math.sqrt(R * R - (CY - YB) ** 2)   # 拱口半宽 0.4138
def arch_points(zc):
    a1 = math.atan2(YB - CY, -hw)        # 起点角（后侧，y=0.2）
    a2 = math.atan2(YB - CY, hw)         # 终点角（前侧，y=0.2）
    # 沿遍历方向（x 递增）从 a1 经 π/2（拱顶）到 a2-2π（顺时针走拱顶）
    if a1 < a2:
        a1 += 2 * math.pi
    n = 13
    out = []
    for k in range(n):
        a = a1 + (a2 - 2 * math.pi - a1) * k / (n - 1) if k < n - 1 else a2 - 2 * math.pi
        # 保证角度单调递减且终点= a2-2π
        a = a1 + ((a2 - 2 * math.pi) - a1) * k / (n - 1)
        out.append([round(zc + R * math.cos(a), 4), round(CY + R * math.sin(a), 4)])
    return out
# 底边闭合段是 idx last=[-2.408,0.2] → idx0=[2.219,0.2]（x 递增）；先插后拱再插前拱
assert abs(pts[-1][0] + 2.408) < 1e-6 and abs(pts[0][0] - 2.219) < 1e-6
new_pts = pts[:] 
new_pts = new_pts + arch_points(-1.715) + arch_points(1.715)
assert shoelace(new_pts) > 0, shoelace(new_pts)
bl['geometryDescriptor']['profile2D']['points'] = new_pts
bl['notes'] = (bl.get('notes', '') +
    ' | 2026-10-17 第四轮几何改造：侧视 profile 在实测轮心 z=±1.715 处开挖轮拱真开口（拱半径 0.452=胎0.382+0.07，拱顶 y0.834，'
    '拱脚落底边 y0.2），CCW 绕序保持；配合 wheel 节点 x ±0.875→±0.855 轮芯内收。')

# ---------- 3b) 四轮轮芯内收 ----------
for wid in ('wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr'):
    t = by_id[wid]['transform']
    t['position'][0] = round(0.855 if t['position'][0] > 0 else -0.855, 4)

# ---------- 4) emblem-shield 绕序反转（唯一 CW）----------
es = by_id['emblem-shield']
ep = es['geometryDescriptor']['profile2D']['points']
assert shoelace(ep) < 0
es['geometryDescriptor']['profile2D']['points'] = [ep[0]] + [list(p) for p in ep[1:][::-1]]
assert shoelace(es['geometryDescriptor']['profile2D']['points']) > 0

# ---------- 5) 车尾件朝向翻转 ----------
# tailgate 保持不转：其挤出基面翻转会将 12 个灯组子孙件挤出体镜像埋入车体，无法满足 ≤2mm 验收；
# 改为翻转 taillamp-l/r（rotY π + 基面补偿），子孙件位置按 p'_z = -p_z + L_parent - L_self 补偿、
# x 分量镜像（实测全部 p_x=0，无副作用）；另翻转 4 个 root 级外露件。
for wid in ('taillamp-l', 'taillamp-r'):
    t = by_id[wid]
    t['transform']['rotation'] = [0.0, PI, 0.0]
    t['transform']['position'][2] = round(t['transform']['position'][2] + 0.03, 6)   # 自身挤出厚 0.03
TAIL_CHILDREN = {
    'lantern-bezel-l': 0.006, 'lantern-bezel-r': 0.006,
    'lantern-core-l': 0.002, 'lantern-core-r': 0.002,
    'lantern-emitter-l': 0.0025, 'lantern-emitter-r': 0.0025,
    'lantern-signature-l': 0.002, 'lantern-signature-r': 0.002,
    'taillamp-bar-top-l': 0.003, 'taillamp-bar-top-r': 0.003,
    'taillamp-bar-bottom-l': 0.003, 'taillamp-bar-bottom-r': 0.003,
}
L_PARENT = 0.03  # taillamp 世界挤出厚度
for cid, lself in TAIL_CHILDREN.items():
    if cid not in by_id:
        continue
    t = by_id[cid]['transform']
    p = t['position']
    p[0] = round(-p[0], 6)
    p[2] = round(-p[2] + L_PARENT - lself, 6)
for cid in ('tail-chrome-strip', 'rear-reflector-l', 'rear-reflector-r',
            'rear-reflector-strip-l', 'rear-reflector-strip-r'):
    t = by_id[cid]
    t['transform']['rotation'] = [0.0, PI, 0.0]
    t['transform']['position'][2] = round(t['transform']['position'][2] + 0.02, 6)

# ---------- 1e) 顶棚跟随件 ----------
def stretch_keep_bottom(cid, dy=0.115):
    c = by_id[cid]; t = c['transform']
    t['scale'][1] = round(t['scale'][1] + dy, 6)
    t['position'][1] = round(t['position'][1] + dy / 2.0, 6)

def shift_y(cid, dy=0.115):
    c = by_id[cid]; t = c['transform']
    t['position'][1] = round(t['position'][1] + dy, 6)

for cid in ('dpillar-l', 'dpillar-r', 'bpillar-l', 'bpillar-r', 'cpillar-l', 'cpillar-r'):
    stretch_keep_bottom(cid)          # 顶随新顶线 +0.115，底（腰带/门内）不动
for cid in ('curtain-l', 'curtain-r'):
    stretch_keep_bottom(cid)          # 窗帘顶随 DLO 上移，底保持
for cid in ('headliner-rear', 'starlight-headliner', 'overhead-console', 'ambient-strip-l', 'ambient-strip-r'):
    shift_y(cid)                       # 顶棚下挂件整体 +0.115
by_id['roof-rails']['transform']['position'][1] = 1.847   # 1.732 → 1.847
lw = by_id['lidar-wedge']['transform']
lw['position'][1] = round(lw['position'][1] + 0.115, 6)   # 1.769 → 1.884
lw['position'][2] = 0.98                                   # 0.641 → 0.98（新车顶前缘中线）

# ---------- 6) glass-dark 材质回写 ----------
for m in spec['materials']:
    if m['id'] != 'glass-dark':
        continue
    m['baseColor'] = '#10151b'
    m['color'] = '#10151b'
    m['albedo']['base'] = '#10151b'
    m['albedo']['note'] = 'reference-derived #101418 family; 2026-10-17 第四轮审查 S1 决议：外部近不透明隐私玻璃'
    m['roughness'] = 0.06
    # 保序插入 envMapIntensity / transparent（重建 dict）
    newm = {}
    for k, v in m.items():
        newm[k] = v
        if k == 'roughness':
            newm['envMapIntensity'] = 1.35
        if k == 'transmission':
            newm['transparent'] = False
    if 'envMapIntensity' not in newm:
        newm['envMapIntensity'] = 1.35
    if 'transparent' not in newm:
        newm['transparent'] = False
    newm['transmission'] = 0.18
    newm['shaderNotes'] = list(newm.get('shaderNotes') or []) + [
        '隐私玻璃：外部近不透明；车内向前视野由 windshield(glass-clear) 承担；2026-10-17 第四轮审查 S1 决议']
    newm['notes'] = (newm.get('notes') or '') + '隐私玻璃：外部近不透明；车内向前视野由 windshield(glass-clear) 承担；2026-10-17 第四轮审查 S1 决议'
    spec['materials'][spec['materials'].index(m)] = newm

# ---------- 全量绕序自检 ----------
cw = []
for c in spec['componentTree']:
    p = (c.get('geometryDescriptor') or {}).get('profile2D')
    if p and shoelace(p['points']) < 0:
        cw.append(c['id'])
assert not cw, f'CW profiles remain: {cw}'

# ---------- 写回（1 空格缩进 + CRLF，保持键序）----------
out = json.dumps(spec, ensure_ascii=False, indent=1)
with open(SPEC, 'w', encoding='utf-8', newline='') as f:
    f.write(out.replace('\n', '\r\n'))

print('components:', len(spec['componentTree']), '(cuts:', CUTS, ')')
print('body-lower pts:', len(new_pts), 'arch hw:', round(hw, 4))
print('ALL EDITS DONE')
