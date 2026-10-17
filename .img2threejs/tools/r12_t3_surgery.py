# -*- coding: utf-8 -*-
"""R12 T3 spec 手术：刹车踏板新增 + 方向盘成形 + 座椅截面精化。基线读 bak-r12（叠加 T1/T2 已在 spec 内）。"""
import json, math

SPEC = r"C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs/object-sculpt-spec.json"
spec = json.load(open(SPEC, encoding="utf-8"))
tree = spec["componentTree"]
ct = {c["id"]: c for c in tree}
log = []


def superellipse(hx, hy, n, count):
    """n=2 椭圆；n 越大越接近矩形（圆角矩形观感）。顶点数固定 count，CCW。"""
    pts = []
    for i in range(count):
        t = 2 * math.pi * i / count
        c, s = math.cos(t), math.sin(t)
        x = hx * math.copysign(abs(c) ** (2.0 / n), c)
        y = hy * math.copysign(abs(s) ** (2.0 / n), s)
        pts.append([round(x, 6), round(y, 6)])
    return pts


def shoelace(pts):
    a = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        a += x1 * y2 - x2 * y1
    return a / 2.0


# ============================================================ 0) 腾位：删 2 件重复反光条
# rear-reflector-strip-l/r 与 rear-reflector-l/r 同 x/z、仅 y 差 22mm，是重复装饰微件
DROP = ["rear-reflector-strip-l", "rear-reflector-strip-r"]
for cid in DROP:
    assert cid in ct, cid
    tree.remove(ct[cid])
    del ct[cid]
log.append(f"删除重复装饰件 {DROP}（与 rear-reflector-l/r 同位重复）→ 组件数 {len(tree)}")

# ============================================================ 1) 新增刹车踏板（2 件）
PAD_PROFILE = {
    "points": superellipse(0.5, 0.5, 5.0, 24),
    "depth": 1.0,
}
ARM_PROFILE = {
    "points": superellipse(0.5, 0.5, 4.2, 16),
    "depth": 1.0,
}


def make_pedal(cid, name, prof, pos, rot, scale, material, notes):
    comp = {
        "id": cid,
        "name": name,
        "level": "meso",
        "role": "detail",
        "importance": 0.55,
        "confidence": 0.9,
        "primitive": "extrude",
        "topologyClass": "assembled-solid",
        "topologyRationale": "踏板总成：臂 + 胶垫两件，舱内驾驶位脚坑",
        "geometryDescriptor": {
            "topologyIntent": "rounded-rectangle extrusion (superellipse section)",
            "edgeTreatment": {"type": "rounded", "bevelRadius": 0.006, "segments": 3},
            "deformationStack": [],
            "uvStrategy": "generated procedural coordinates",
            "normalStrategy": "vertex normals from generated geometry",
            "profile2D": prof,
        },
        "parent": "cabin-interior",
        "attachment": None,
        "dimensions": {
            "width": round(scale[0] * 1.0, 4),
            "height": round(scale[1] * 1.0, 4),
            "depth": round(scale[2] * 1.0, 4),
            "units": "meters",
            "confidence": 0.9,
        },
        "transform": {"position": pos, "rotation": rot, "scale": scale},
        "material": material,
        "materialLayers": [material],
        "deformations": [],
        "joints": [],
        "seams": [],
        "localFeatures": [],
        "surfaceDetail": {
            "macroRoughness": 0,
            "microRoughness": 0,
            "bumpAmplitude": 0,
            "normalPattern": "",
            "displacementPattern": "",
            "occlusionPattern": "",
            "edgeWearPattern": "",
            "notes": "",
        },
        "evidenceRefs": ["img-design-black"],
        "details": [],
        "fidelityTier": "micro",
        "notes": notes,
    }
    return comp


# 胶垫：10.5cm 宽 × 7.5cm 高 × 1.8cm 厚，后仰 17°（上沿朝驾驶员）
pad = make_pedal(
    "pedal-brake-pad", "刹车踏板胶垫", PAD_PROFILE,
    [0.52, 0.400, 1.692], [-0.30, 0.0, 0.0], [0.105, 0.075, 0.018], "matte-black",
    "驾驶位刹车踏板橡胶垫：世界 x0.52 / y0.363~0.438 / z1.68~1.70，仰角 17° 贴脚掌",
)
# 臂：2.6cm 见方 × 24cm，上探至仪表台下沿（y0.665）
arm = make_pedal(
    "pedal-brake-arm", "刹车踏板臂", ARM_PROFILE,
    [0.52, 0.545, 1.668], [-0.10, 0.0, 0.0], [0.026, 0.240, 0.026], "plate",
    "刹车踏板支撑臂：上端 y0.665 接 dash-lower 下沿(y0.67)，下端 y0.425 接胶垫",
)
# 插到 cabin-interior 之后（保持 tree 语义次序）
idx = next(i for i, c in enumerate(tree) if c["id"] == "cabin-interior") + 1
tree.insert(idx, pad)
tree.insert(idx + 1, arm)
ct["pedal-brake-pad"] = pad
ct["pedal-brake-arm"] = arm
log.append(f"新增 pedal-brake-pad({pad['material']}) tri≈92 + pedal-brake-arm({arm['material']}) tri≈60 → 组件数 {len(tree)}")

# ============================================================ 2) 方向盘：轮缘加粗 + 双辐归位
st = ct["steering"]
old_ratio = st["geometryDescriptor"]["torusTubeRatio"]
st["geometryDescriptor"]["torusTubeRatio"] = 0.115
log.append(f"steering.torusTubeRatio {old_ratio} -> 0.115（轮缘管径 0.0405→0.0518，世界外径 0.412 不变、截面 +28%）")

hub = ct["steering-hub"]
old = list(hub["transform"]["scale"])
hub["transform"]["scale"] = [0.175, 0.052, 0.175]
log.append(f"steering-hub scale {old} -> {hub['transform']['scale']}（中央圆盘 Ø0.19→0.175）")

for rs in spec["repetitionSystems"]:
    if rs.get("id") != "steering-spokes":
        continue
    old = dict(rs)
    rs["instanceScale"] = [0.165, 0.055, 0.022]
    rs["placement"] = {"mode": "radial", "axis": [0, 0, 1], "radius": 0.21, "startAngleDeg": 90}
    rs["notes"] = ("R12: 双辐横条（3/9 点位）：半径 0.21→实例中心距 0.105，长 0.165 → 内端 0.0225（埋入轮毂 Ø0.175）、"
                   "外端 0.1875（咬进轮缘内缘 0.167）——原 radius0.29/len0.11 时两辐落在 12/6 点且内端悬空 6cm")
    log.append(f"steering-spokes instanceScale {old.get('instanceScale')} -> {rs['instanceScale']}; placement {old.get('placement')} -> {rs['placement']}")

# ============================================================ 3) 座椅截面精化（不改 primitive）
# 3a 坐垫：y 半高 0.0725→0.0870（厚 0.145→0.174），截面改 5 次超椭圆（角部更圆润，仍是圆角矩形观感）
CUSHION = ["seat-driver", "seat-passenger", "seat-rear-l", "seat-rear-r"]
for cid in CUSHION:
    c = ct[cid]
    p = c["geometryDescriptor"]["profile2D"]
    old = list(p["points"])
    hx = max(abs(pt[0]) for pt in old)
    hy = max(abs(pt[1]) for pt in old)
    new = superellipse(hx, round(hy * 1.20, 6), 5.0, 20)
    p["points"] = new
    log.append(f"{cid} cushion section (±{hy:.4f}→±{hy*1.2:.4f} 高, n=5 超椭圆 20 点) shoelace {shoelace(old):.5f}->{shoelace(new):.5f}")

# 3b 靠背：curve-sweep 截面 z 半厚 0.05→0.061（10→12.2cm），截面改 5 次超椭圆
BACKS = ["seat-driver-back", "seat-passenger-back", "seat-rear-l-back", "seat-rear-r-back"]
for cid in BACKS:
    c = ct[cid]
    cs = c["geometryDescriptor"]["curveSweep"]["crossSection"]
    old = list(cs["points"])
    hx = max(abs(pt[0]) for pt in old)
    hz = max(abs(pt[1]) for pt in old)
    new = superellipse(hx, round(hz * 1.22, 6), 5.0, 20)
    cs["points"] = new
    log.append(f"{cid} back section (±{hz:.4f}→±{hz*1.22:.4f} 厚, n=5 超椭圆) shoelace {shoelace(old):.5f}->{shoelace(new):.5f}")

# ============================================================ 写回
json.dump(spec, open(SPEC, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("OK wrote", SPEC, "components =", len(tree))
for l in log:
    print(" *", l)
