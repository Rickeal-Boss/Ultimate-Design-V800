# -*- coding: utf-8 -*-
"""R12 T1+T2 spec 手术：尾部直立化 + 矩阵大灯归位。幂等：以 bak-r12 为基线读取。"""
import json, shutil, sys

SPEC = r"C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs/object-sculpt-spec.json"
BASE = SPEC + ".bak-r12"

spec = json.load(open(BASE, encoding="utf-8"))
ct = {c["id"]: c for c in spec["componentTree"]}


def shoelace(pts):
    a = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        a += x1 * y2 - x2 * y1
    return a / 2.0


log = []

# ---------------------------------------------------------------- T1 尾部直立化
# 1) tailgate：rotX 0.10 → 0（竖直尾门）；z -2.835 → -2.848 让面板世界 z 落进 [-2.865,-2.780]
tg = ct["tailgate"]
old = (list(tg["transform"]["rotation"]), list(tg["transform"]["position"]))
tg["transform"]["rotation"] = [0.0, 0.0, 0.0]
tg["transform"]["position"] = [0.0, 1.02, -2.848]
tg["geometryDescriptor"]["profile2D"]["shaping"]["nodeOffset"] = [0, 1.02, -2.848]
tg["geometryDescriptor"]["topologyIntent"] = "flat vertical tailgate panel with rounded corners (MPV straight tail)"
log.append(f"tailgate rot {old[0]} -> [0,0,0]; pos {old[1]} -> [0,1.02,-2.848]")

# 2) roof-panel 后缘：由近垂直但前收 45cm 的台阶改回后缘 z≈-2.778（与尾门前表面相接），小圆角过渡
rp = ct["roof-panel"]
pts = rp["geometryDescriptor"]["profile2D"]["points"]
assert len(pts) == 33, len(pts)
old_pts = [list(p) for p in pts]
# 保留 0..17（顶面前缘至 EX-15 抬高段末端），重建 18..27（后缘台阶），28..32 原样
new_rear = [
    [-2.700, 1.848],      # 顶面平台延伸到后缘
    [-2.7342, 1.8402],    # 后上圆角 4 段
    [-2.7587, 1.8235],
    [-2.7725, 1.7998],
    [-2.778, 1.7725],
    [-2.778, 1.640],      # 后立面（近垂直，仅在 1.77→1.64 段竖直）
    [-2.7705, 1.6245],    # 后下圆角
    [-2.7500, 1.6155],
    [-2.7000, 1.6110],
    [-2.4450, 1.6095],    # 下表皮向前过渡
]
pts[18:28] = [[float(a), float(b)] for a, b in new_rear]
assert len(pts) == 33, len(pts)
log.append(f"roof-panel rear edge: z[-2.26..-2.38] -> z[-2.700..-2.778] (10 profile pts rebuilt), shoelace {shoelace(old_pts):.5f} -> {shoelace(pts):.5f}")
rp["geometryDescriptor"]["topologyIntent"] = (
    "roof shell with raised rear tier (EX-15); rear edge now runs back to z=-2.778 (flush with tailgate) "
    "with a 4-facet r0.038 corner instead of the 0.45m forward-stepped shelf")

# 3) greenhouse-glass 后缘：后风挡由后掠 40° 改为近垂直（z≈-2.770），消掉玻璃与尾门之间的空腔
gg = ct["greenhouse-glass"]
gp = gg["geometryDescriptor"]["profile2D"]["points"]
assert len(gp) == 17, len(gp)
old_g = [list(p) for p in gp]
new_glass_tail = [
    [-1.450, 1.7620],
    [-1.800, 1.7620],
    [-2.600, 1.7580],
    [-2.7150, 1.7500],
    [-2.7620, 1.7330],
    [-2.770, 1.7100],
    [-2.770, 1.2050],
    [-2.7620, 1.1830],
    [-2.730, 1.1650],
    [-2.600, 1.1520],
    [-2.3980, 1.1450],
    [-2.3810, 1.1390],
]
# 原 8..16 = 8 个点之前的 [-0.3,1.76] 保留在 index 8
assert gp[8] == [-0.3, 1.76], gp[8]
gp[9:] = [[float(a), float(b)] for a, b in new_glass_tail]
log.append(f"greenhouse-glass rear: z[-2.30/-2.719] -> z[-2.770] vertical; pts {len(old_g)} -> {len(gp)}, shoelace {shoelace(old_g):.5f} -> {shoelace(gp):.5f}")

# 4) roof-spoiler：原是悬在车顶后缘前方 30cm 的「搁板」，改为顶盖后缘的窄唇（贴顶、随后缘同 z）
rs = ct["roof-spoiler"]
old = (list(rs["transform"]["position"]), list(rs["transform"]["rotation"]), list(rs["transform"]["scale"]))
rs["transform"]["position"] = [0.0, 1.848, -2.800]
rs["transform"]["rotation"] = [0.0, 0.0, 0.0]
rs["transform"]["scale"] = [1.40, 0.018, 0.14]
rs["material"] = rs.get("material", "paint-upper")
log.append(f"roof-spoiler pos {old[0]} rot {old[1]} scl {old[2]} -> [0,1.848,-2.800]/[0,0,0]/[1.4,0.018,0.14] (roof-edge lip)")

# ---------------------------------------------------------------- T2 矩阵大灯归位
# 实测(baseline): front-end 鼻面 maxZ=2.4383；headlamp front maxZ=2.4114（被埋）
# 目标：灯组竖向矩形灯簇，世界 y≈0.62~1.06（前脸中段，让开 brow 1.045..1.142），前面外凸 ~2.3cm
SQ = 0.68
for side, sx in (("l", 1.0), ("r", -1.0)):
    hl = ct[f"headlamp-{side}"]
    old = (list(hl["transform"]["position"]), list(hl["transform"]["scale"]))
    hl["transform"]["position"] = [0.8 * sx, -0.017, 0.030]
    hl["transform"]["scale"] = [1.0, SQ, 1.0]
    log.append(f"headlamp-{side} pos {old[0]} -> {hl['transform']['position']}; scale {old[1]} -> {hl['transform']['scale']}")

    led = ct[f"headlamp-led-{side}"]
    led["transform"]["scale"] = [0.022, 0.4 * SQ, 0.02]
    led["transform"]["position"] = [0.082 * sx, 0.0, -0.03]
    star = ct[f"headlamp-star-{side}"]
    star["transform"]["scale"] = [0.13, 0.52 * SQ, 0.004]
    star["transform"]["position"] = [-0.02 * sx, 0.0, 0.071]
    for i, y in ((1, 0.056), (2, 0.056), (3, -0.026)):
        d = ct[f"headlamp-led-dot-{i}-{side}"]
        d["transform"]["position"] = [d["transform"]["position"][0], y * SQ, 0.064]
    log.append(f"  children: led scaleY 0.4->{0.4*SQ}, star scaleY 0.52->{0.52*SQ}, dot y x{SQ}")

# 5) front-light-bar：原前面 z=2.4712 会横切灯簇中段；后退 16mm 让灯簇成为最外层
flb = ct["front-light-bar"]
old = list(flb["transform"]["position"])
flb["transform"]["position"] = [0.0, 0.055, 0.112]
log.append(f"front-light-bar pos {old} -> [0,0.055,0.112] (behind headlamp front face)")

# ---------------------------------------------------------------- 写回
json.dump(spec, open(SPEC, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("OK wrote", SPEC)
for l in log:
    print(" *", l)
