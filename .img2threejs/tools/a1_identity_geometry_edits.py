# -*- coding: utf-8 -*-
"""a1_identity_geometry_edits.py — lighting-pass 身份特征几何波（结构工程师/搭景，第二轮）

改动清单（全部决策可溯源到 .refcache 参考图；组件预算 170+14=184 ≤185）：
  EX-08 大灯 3-LED 点阵（A1/A8/E1/E2）：
    - headlamp-led-l/r 外移 x ±0.045→±0.082（外缘竖向细白 LED 线，参考图灯导位于灯罩外缘）
    - 新增 headlamp-led-dot-{1,2,3}-{l,r} ×6：extrude 16 边形圆盘（lamp-head），等边三角布局
      （贴图 UV 串味风险已通告调光：lamp-head 的 emissiveMap 是 3 圆点纹理，extrude UV 为坐标值，
       需集成层对 6 个新 id 做 remapUVToRegion 到白色圆区，否则点阵呈暗蓝灰）
  EX-15 车顶后段台阶（BC/B2）：核对通过——roof-panel 轮廓 z-2.0~-2.26 已抬高 12.2mm，不改
  EX-16 尾翼（B2/BD）：核对通过——roof-spoiler 顶盖后缘小尾翼形态吻合，不改
  EX-31 后保反光条（B5 右上格）：每侧两条横条
    - rear-reflector-l/r 改为上条（0.05→0.018 高，y 0.30→0.3095，落在后保垂直面 y0.272~0.3234 内）
    - 新增 rear-reflector-strip-{l,r} ×2（下条，y 0.2875）
    - 缺陷修复：trunk-floor / trunk-sill 上波放置过深（z-2.825/-2.83 伸出后保表面 -2.48 达 34cm，
      P5-tail-wide-trueRear.png 实拍可见地毯板+护板外露且部分遮挡反光条）——拉回后保内壁 -2.44 内
  IN-09 扶手屏支臂（N1/N3）：新增 seat-rear-{l,r}-screen-arm ×2（chrome，屏前沿下缘支臂+边框沿，
    从扶手端升起的关系；独立屏框因组件预算 184/185 未单列，以加宽支臂两端出沿表达）
  EX-33 轮心滚花齿环（D1/D3/D4）：cap-fl/fr/rl/rr 原位改造（0 新增组件）
    - 修复旧缺陷：原 cylinder 位置错在轮局部 z=+0.125（世界 z+1.84，埋在轮胎内不可见）
    - 改 extrude 20 齿锯齿环（内径 ovalHole r0.095 / 齿谷 r0.125 / 齿尖 r0.148，厚 8mm），
      落位轮辋外表面 x=±1.010（局部 ±0.131，rotY ±90° 使挤出方向朝外），chrome 材质
      （黑底盾徽贴图归调光；wheel-alloy 带盘面贴图故不选用）
  IN-06 扶手端盖（I1/I5/I6/U7）：新增 seat-rear-{l,r}-armrest-cap ×2（chrome，扶手前端端盖）
  IN-07 座垫/靠背侧缘竖向镀铬饰条（I1/I5/I6/U7）：新增 seat-rear-{l,r}-side-trim ×2（chrome）
  viewEvidence：追加 6 条参考图条目

用法：python .img2threejs/tools/a1_identity_geometry_edits.py
"""
import copy
import json
import math
import os

SPEC_PATH = os.path.join(os.path.dirname(__file__), "..", "object-sculpt-spec.json")


def load_spec():
    with open(SPEC_PATH, encoding="utf-8") as f:
        return json.load(f)


def save_spec(spec):
    with open(SPEC_PATH, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=1)
        f.write("\n")


def hex_to_rgba(h):
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return f"rgba({r}, {g}, {b}, 1.0)"


# ---------------------------------------------------------------- donors
DONOR_BY_PRIMITIVE = {
    "box": "tail-chrome-strip",   # meso box, attachment null
    "extrude": "headlamp-l",      # meso extrude (profile2D)
}

# 参考图证据 id（本轮追加进 viewEvidence）
E_HEAD = "img-headlamp-front"    # A1/A8/E1/E2 前脸竖向大灯
E_ROOF = "img-side-roof"         # BC/B2 侧视车顶
E_REAR = "img-rear-bumper"       # B5 尾部后保
E_WHEEL = "img-wheel-center"     # D1/D3/D4 轮毂特写
E_SCREEN = "img-seat-screen"     # N1/N3 扶手屏
E_SEAT = "img-seat-trim"         # I1/I5/I6/U7 座椅镀铬


def circle_profile(r, n):
    return [[round(math.cos(2 * math.pi * i / n) * r, 5),
             round(math.sin(2 * math.pi * i / n) * r, 5)] for i in range(n)]


def knurl_profile(teeth=20, r_tip=0.148, r_valley=0.125):
    """锯齿滚花环外轮廓：齿尖/齿谷交替（径向齿）。"""
    pts = []
    for i in range(teeth):
        a_tip = 2 * math.pi * i / teeth
        a_val = 2 * math.pi * (i + 0.5) / teeth
        pts.append([round(math.cos(a_tip) * r_tip, 5), round(math.sin(a_tip) * r_tip, 5)])
        pts.append([round(math.cos(a_val) * r_valley, 5), round(math.sin(a_val) * r_valley, 5)])
    return pts


# materialClass 必须是枚举值（physical 不在枚举内——校验器 warning）
MATERIAL_CLASS_MAP = {
    "chrome": "metal",
    "lamp-head": "plastic",
    "lamp-red": "plastic",
    "lamp-white": "plastic",
    "lamp-star": "plastic",
    "lamp-mark": "plastic",
    "crystal": "glass",
    "carpet": "fabric",
    "matte-black": "plastic",
    "wood": "wood",
    "bronze-dark": "metal",
    "housing-dark": "metal",
    "wheel-alloy": "metal",
}


def material_class_of(material_id, shader_model):
    if material_id in MATERIAL_CLASS_MAP:
        return MATERIAL_CLASS_MAP[material_id]
    derived = shader_model.replace("Mesh", "").replace("Material", "").lower()
    return derived if derived in (
        "ceramic", "fabric", "glass", "metal", "plastic", "rubber", "skin",
        "stone", "unknown", "wood") else "unknown"


def build_component(spec, donor_id, comp_id, name, level, parent, primitive,
                    material, dims, pos, scale, rot=None, evidence=(),
                    local_features=(), details=(), notes="", profile2d=None):
    comps = {c["id"]: c for c in spec["componentTree"]}
    donor = comps[donor_id]
    if donor["primitive"] != primitive:
        raise SystemExit(f"donor {donor_id} primitive {donor['primitive']} != {primitive}")
    c = copy.deepcopy(donor)
    mats = {m["id"]: m for m in spec["materials"]}
    mat = mats[material]
    c["id"] = comp_id
    c["name"] = name
    c["level"] = level
    c["parent"] = parent
    c["attachment"] = None
    c["dimensions"] = {
        "width": dims[0], "height": dims[1], "depth": dims[2],
        "units": "meters", "confidence": 0.9,
    }
    c["transform"] = {
        "position": list(pos),
        "rotation": list(rot or [0, 0, 0]),
        "scale": list(scale),
    }
    c["material"] = material
    c["materialLayers"] = [material]
    c["localFeatures"] = list(local_features)
    c["evidenceRefs"] = list(evidence)
    c["details"] = list(details)
    c["fidelityTier"] = "hero"
    c["colorMaterialRecipe"] = {
        "dominantAlbedo": hex_to_rgba(mat["baseColor"]),
        "secondaryAlbedo": hex_to_rgba(mat.get("albedo", {}).get("secondary", mat["baseColor"])),
        "materialClass": material_class_of(material, mat.get("shaderModel", "MeshStandardMaterial")),
        "materialClassConfidence": 0.9,
        "note": notes,
    }
    sd = c["surfaceDetail"]
    sd.update({"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0,
               "normalPattern": "", "displacementPattern": "", "occlusionPattern": "",
               "edgeWearPattern": "", "notes": notes})
    if profile2d is not None:
        gd = c["geometryDescriptor"]
        gd["profile2D"] = profile2d
        gd["topologyIntent"] = "rounded disc with radial knurl contour"
        gd["edgeTreatment"] = {"type": "none", "bevelRadius": 0.0, "segments": 0}
    return c


# ---------------------------------------------------------------- edits
def append_view_evidence(spec):
    ve = spec.setdefault("viewEvidence", [])
    have = {e.get("id") for e in ve}
    entries = [
        {"id": E_HEAD, "view": "front face close (headlamp)",
         "imageRegion": {"x": 0.18, "y": 0.30, "width": 0.16, "height": 0.32},
         "observations": ["竖向大灯总成：外缘一条竖向细白 LED 光导",
                          "灯罩内侧 3 枚圆形灯珠（上二下一）三角点阵",
                          "内表面星点/钻石切割纹理"],
         "confidence": 0.94},
        {"id": E_ROOF, "view": "side profile full",
         "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
         "observations": ["车顶后段（三排头顶）微微抬高的台阶",
                          "顶盖后缘延伸小尾翼，后缘上翘"],
         "confidence": 0.93},
        {"id": E_REAR, "view": "rear face (bumper lower)",
         "imageRegion": {"x": 0.62, "y": 0.10, "width": 0.26, "height": 0.30},
         "observations": ["后保下部每侧两条横向红色反光条",
                          "反光条位于后保垂直面上、下方镀铬饰条之上"],
         "confidence": 0.9},
        {"id": E_WHEEL, "view": "wheel center close-up",
         "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
         "observations": ["封闭大饼轮圈盘面", "中央徽标外围一圈放射滚花齿环",
                          "盘缘 20 开窗"],
         "confidence": 0.94},
        {"id": E_SCREEN, "view": "rear armrest screen close",
         "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
         "observations": ["4 英寸翻转屏自扶手前端升起", "屏下沿镀铬支臂/铰链",
                          "屏框为亮黑（本轮按主理人口径用 chrome 表达硬件件）"],
         "confidence": 0.92},
        {"id": E_SEAT, "view": "rear seats close",
         "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
         "observations": ["扶手前端端盖镀铬", "座垫/靠背侧缘竖向镀铬饰条",
                          "菱格绗缝靠背"],
         "confidence": 0.93},
    ]
    for e in entries:
        if e["id"] not in have:
            ve.append(e)


def edit_headlamp_led_strip(spec):
    """EX-08：LED 灯带外移至灯罩外缘（竖向细白 LED 线）。"""
    for c in spec["componentTree"]:
        if c["id"] in ("headlamp-led-l", "headlamp-led-r"):
            side = "l" if c["id"].endswith("-l") else "r"
            sgn = 1 if side == "l" else -1
            c["transform"]["position"][0] = round(0.082 * sgn, 4)
            c["localFeatures"] = [{
                "name": "外缘竖向 LED 光导",
                "kind": "emissive",
                "note": ("EX-08：A1/A8/E1/E2 前脸参考图——竖向细白 LED 线位于灯罩外缘；"
                         "3 枚圆形 LED 点阵由同父节点下 headlamp-led-dot-* 几何件承担（等边三角布局）。"),
            }]
            c["evidenceRefs"] = [E_HEAD]
            c["notes"] = (f"EX-08 大灯 LED 灯带（{side}）：外缘竖向光导，x={0.082 * sgn:+.3f}"
                          f"（灯罩半宽 0.1 的外缘侧）；点阵贴图（集成层 createHeadlampLedTexture）"
                          f"叠加于灯带表面。")


def add_led_dots(spec):
    """EX-08：每灯 3 枚圆形 LED 点阵（extrude 圆盘，等边三角布局）。"""
    new = []
    # 等边三角：上二下一，边长 0.06；局部坐标相对 headlamp-l/r（灯罩 x∈[-0.1,0.1]）
    tri = {
        "l": [(0.005, 0.056), (-0.055, 0.056), (-0.025, -0.026)],
        "r": [(-0.005, 0.056), (0.055, 0.056), (0.025, -0.026)],
    }
    for side, pts in tri.items():
        for i, (cx, cy) in enumerate(pts, start=1):
            comp_id = f"headlamp-led-dot-{i}-{side}"
            name = f"大灯 LED 点阵 {i}（{side}）"
            profile = {"points": circle_profile(0.017, 16), "depth": 0.012}
            new.append(build_component(
                spec, "headlamp-l", comp_id, name, "micro", f"headlamp-{side}",
                "extrude", "lamp-head", [0.034, 0.034, 0.012], [cx, cy, 0.064],
                [1, 1, 1], evidence=[E_HEAD],
                local_features=[{
                    "name": "圆形 LED 灯珠",
                    "kind": "emissive",
                    "note": ("EX-08：A1/A8 前脸——大灯内侧 3 枚圆形灯珠，上二下一三角点阵；"
                             "lamp-head 自发光内芯。注意：lamp-head 的 emissiveMap 为 3 圆点贴图，"
                             "extrude UV 为坐标值（u/v≈±0.02），需集成层 remapUVToRegion 到白色圆区，"
                             "否则点阵呈暗蓝灰（已通告调光）。"),
                }],
                details=["d-headlamp-star"],
                notes=f"EX-08 大灯 LED 点阵 {i}（{side}）：16 边形圆盘 r0.017×厚0.012，"
                      f"位于灯罩前表面外 6mm（局部 z0.064~0.076），等边三角布局之一",
                profile2d=profile))
    spec["componentTree"].extend(new)


def edit_reflectors(spec):
    """EX-31：后保反光条改双条（上条改窄上移 + 新增下条）。"""
    for c in spec["componentTree"]:
        if c["id"] in ("rear-reflector-l", "rear-reflector-r"):
            side = "l" if c["id"].endswith("-l") else "r"
            sgn = 1 if side == "l" else -1
            c["dimensions"].update({"width": 0.34, "height": 0.018, "depth": 0.02})
            c["transform"]["position"][1] = 0.3095
            c["transform"]["scale"] = [0.34, 0.018, 0.02]
            c["localFeatures"] = [{
                "name": "后保红色反光条（上条）",
                "kind": "emissive-face",
                "note": ("EX-31/B5 右上格：后保下部每侧两条横向红色反光条，本条为上条；"
                         "下条为 rear-reflector-strip-" + side + "；两贴均落在后保垂直面"
                         "（y0.272~0.3234，z=-2.48）外 2cm。"),
            }]
            c["evidenceRefs"] = [E_REAR]
            c["notes"] = (f"EX-31 后保红色反光条上条（{side}）：世界 [{0.72 * sgn:.2f},0.3095,-2.49]，"
                          f"0.34×0.018×0.02；与下条相距 4mm，lamp-red 与尾灯合批 +0 DC。")
    new = []
    for side, sgn in (("l", 1), ("r", -1)):
        comp_id = f"rear-reflector-strip-{side}"
        new.append(build_component(
            spec, "tail-chrome-strip", comp_id, f"后保红色反光条下条（{side}）",
            "micro", "root", "box", "lamp-red", [0.34, 0.018, 0.02],
            [0.72 * sgn, 0.2875, -2.49], [0.34, 0.018, 0.02],
            evidence=[E_REAR],
            local_features=[{
                "name": "后保红色反光条（下条）",
                "kind": "emissive-face",
                "note": ("EX-31/B5 右上格：后保下部每侧两条横向红色反光条，本条为下条；"
                         "与上条 rear-reflector-" + side + " 平行相距 4mm。"),
            }],
            details=["d-taillamp"],
            notes=f"EX-31 后保红色反光条下条（{side}）：世界 [{0.72 * sgn:.2f},0.2875,-2.49]，"
                  f"0.34×0.018×0.02；lamp-red 与尾灯合批 +0 DC。"))
    spec["componentTree"].extend(new)


def fix_trunk_plates(spec):
    """缺陷修复：trunk-floor/trunk-sill 上波伸出后保表面 34cm（P5-tail-wide-trueRear.png 实拍），
    拉回后保内壁（z=-2.48 表面 / -2.44 内壁）以内。"""
    for c in spec["componentTree"]:
        if c["id"] == "trunk-floor":
            # 原 z-2.825..-2.275（伸出 -2.48 表面 34cm）→ -2.44..-2.25（与 cabin-floor 后缘相接）
            c["transform"]["position"][2] = -2.345
            c["transform"]["scale"] = [1.55, 0.03, 0.19]
            c["dimensions"].update({"width": 1.55, "height": 0.03, "depth": 0.19})
            c["localFeatures"] = [{
                "name": "纯平载物地板（三排后段）",
                "kind": "floor",
                "note": ("K1_后备箱-纯平储物.jpg：三排之后地板纯平、与座舱地毯面齐平；"
                         "缺陷修复：上波 z-2.825 伸出后保表面（-2.48）34cm（P5-tail-wide-trueRear.png "
                         "实拍外露且遮挡反光条），本轮拉回后保内壁 -2.44 内，与 cabin-floor 后缘 -2.25 相接。"),
            }]
            c["notes"] = ("EX-25/K1：尾部横向贯穿镀铬饰条 1.50×0.035，贴在尾门后脸；chrome 合批 +0 DC。"
                          " [缺陷修复] z-2.44..-2.25（原 -2.825..-2.275 外露 34cm，已拉回后保内壁）。")
        elif c["id"] == "trunk-sill":
            c["transform"]["position"][2] = -2.42
            c["transform"]["scale"] = [1.42, 0.05, 0.04]
            c["dimensions"].update({"width": 1.42, "height": 0.05, "depth": 0.04})
            c["localFeatures"] = [{
                "name": "后备箱门槛护板（内移修复）",
                "kind": "trim",
                "note": ("K1：尾门开口下缘门槛护板；缺陷修复：原 z-2.80 伸出后保表面，"
                         "本轮拉回后保内壁 -2.44..-2.40（座舱内可见、外部不露出）。"),
            }]
            c["notes"] = ("EX-25/K1：尾门开口下缘门槛护板。 [缺陷修复] z-2.44..-2.40"
                          "（原 -2.83..-2.77 外露，已拉回后保内壁）。")


def add_screen_arms(spec):
    """IN-09：扶手屏镀铬支臂（屏前沿下缘，兼作屏框下沿出沿）。"""
    new = []
    for side in ("l", "r"):
        seat = f"seat-rear-{side}"
        comp_id = f"{seat}-screen-arm"
        new.append(build_component(
            spec, "tail-chrome-strip", comp_id, f"扶手屏镀铬支臂（{side}）",
            "micro", seat, "box", "chrome", [0.078, 0.022, 0.02],
            [0, 0.3405, 0.1935], [0.078, 0.022, 0.02], rot=[-1.75, 0, 0],
            evidence=[E_SCREEN],
            local_features=[{
                "name": "屏前沿镀铬支臂",
                "kind": "hardware",
                "note": ("N1_扶手屏-4英寸翻转.jpg / N3_扶手屏.png：屏自扶手前端升起，"
                         "屏前沿下沿为镀铬支臂/铰链；本件宽出屏幕 8mm（两端出沿兼作屏框下沿），"
                         "下端嵌入扶手端盖附近（扶手顶面 y0.95），与 armrest-cap 成对。"
                         "独立亮黑屏框因组件预算（184/185）未单列。"),
            }],
            details=["d-rear-seat"],
            notes=f"IN-09 扶手屏支臂（{side}）：chrome 0.078×0.022×0.02，rotX-1.75 与屏同向，"
                  f"屏前沿下缘、嵌入扶手顶面"))
    spec["componentTree"].extend(new)


def convert_caps_to_knurl_rings(spec):
    """EX-33：cap-* 原位改造为轮心滚花齿环（cylinder→extrude 锯齿环），并修复旧位置缺陷。"""
    for c in spec["componentTree"]:
        if c["id"] not in ("cap-fl", "cap-fr", "cap-rl", "cap-rr"):
            continue
        corner = c["id"].split("-")[1]
        left = corner in ("fl", "rl")
        sgn = 1 if left else -1
        c["name"] = f"轮心滚花齿环 {corner}"
        c["primitive"] = "extrude"
        c["topologyClass"] = "conforming-shell"
        c["topologyRationale"] = "锯齿环轮廓挤出（滚花齿环，内径让位悬浮轮标）"
        gd = c["geometryDescriptor"]
        gd["profile2D"] = {
            "points": knurl_profile(20, 0.148, 0.125),
            "depth": 0.008,
            "ovalHoles": [{"cx": 0.0, "cy": 0.0, "rx": 0.095, "ry": 0.095}],
        }
        gd["topologyIntent"] = "knurled ring around wheel center badge"
        gd["edgeTreatment"] = {"type": "none", "bevelRadius": 0.0, "segments": 0}
        c["dimensions"].update({"width": 0.296, "height": 0.296, "depth": 0.008})
        # 落位：轮辋外表面 x=±1.010（轮心 ±0.875 → 局部 ±0.135），环厚 8mm 跨表面
        c["transform"]["position"] = [round(0.131 * sgn, 4), 0.0, 0.0]
        c["transform"]["rotation"] = [0, 1.5708 if left else -1.5708, 0]
        c["transform"]["scale"] = [1, 1, 1]
        # 齿环随轮旋转（回转对称），取消悬浮标的朝向锁定语义
        ap = c["actionProfile"]
        ap["animationRole"] = "static"
        ap["transformChannels"]["rotate"] = False
        ap["pivot"]["axis"] = [1, 0, 0]
        ap["collider"]["notes"] = ""
        c["localFeatures"] = [{
            "name": "轮心滚花齿环",
            "kind": "wheel-trim",
            "note": ("EX-33/D1_轮毂-特写.jpg（D3/D4 同）：中央徽标外围一圈放射滚花齿环；"
                     "本件 20 齿锯齿环（内径 0.19 让位悬浮轮标 r0.07、齿尖外径 0.296、厚 8mm），"
                     "落位轮辋外表面 x=±1.010，随轮旋转。缺陷修复：原 cylinder 位置错在轮局部 "
                     "z=+0.125（世界 z 1.84，埋在轮胎内不可见）；黑底盾徽贴图归调光（wheel-alloy "
                     "盘面贴图），本件用 chrome 避免采样盘面贴图。"),
        }]
        c["evidenceRefs"] = [E_WHEEL]
        c["notes"] = (f"EX-33 轮心滚花齿环 {corner}：extrude 20 齿环（ID r0.095/谷 r0.125/尖 r0.148，"
                      f"厚 8mm），轮局部 x={0.131 * sgn:+.3f}（世界 ±1.006~1.014，跨轮辋外表面 "
                      f"±1.010）；chrome。 [缺陷修复] 原位置 z=+0.125 埋在胎内。")


def add_seat_trims(spec):
    """IN-06 扶手端盖 + IN-07 座垫/靠背侧缘竖向镀铬饰条。"""
    new = []
    for side, sgn in (("l", 1), ("r", -1)):
        seat = f"seat-rear-{side}"
        # IN-06：扶手前端端盖（chrome），front face z=-1.08 外凸 5mm；宽出扶手侧沿 1cm 包前角
        new.append(build_component(
            spec, "tail-chrome-strip", f"{seat}-armrest-cap", f"扶手端盖镀铬（{side}）",
            "micro", seat, "box", "chrome", [0.62, 0.095, 0.02],
            [0, 0.28, 0.215], [0.62, 0.095, 0.02],
            evidence=[E_SEAT],
            local_features=[{
                "name": "扶手前端镀铬端盖",
                "kind": "hardware",
                "note": ("I1_座椅-二排.jpg / I5 / I6 / U7：侧扶手前端端盖为镀铬亮面；"
                         "本件覆盖扶手前端端面并宽出侧沿 1cm 包前角（座局部 z0.205~0.225，"
                         "世界 -1.095~-1.075，较扶手端面外凸 5mm），与扶手屏支臂成对。"),
            }],
            details=["d-rear-seat"],
            notes=f"IN-06 扶手端盖（{side}）：chrome 0.62×0.095×0.02，扶手前端端面外凸 5mm、"
                  f"侧沿包角 1cm"))
        # IN-07：座垫/靠背侧缘竖向镀铬饰条（chrome），内缘侧（面向中岛）
        local_x = round(-0.278 * sgn, 4)
        new.append(build_component(
            spec, "tail-chrome-strip", f"{seat}-side-trim", f"座椅侧缘镀铬饰条（{side}）",
            "micro", seat, "box", "chrome", [0.018, 0.52, 0.46],
            [local_x, 0.22, 0.01], [0.018, 0.52, 0.46],
            evidence=[E_SEAT],
            local_features=[{
                "name": "座垫/靠背侧缘竖向镀铬饰条",
                "kind": "trim",
                "note": ("I1/I5/I6/U7：座垫与靠背侧缘（面向中岛一侧）有竖向镀铬饰条；"
                         "本件沿座侧内缘（座局部 x±0.278，世界 0.213~0.231，嵌入座侧 7mm）"
                         "纵贯座垫至靠背下部（世界 y0.58~1.10）。"),
            }],
            details=["d-rear-seat"],
            notes=f"IN-07 座椅侧缘镀铬饰条（{side}）：chrome 0.018×0.52×0.46，"
                  f"座侧内缘、纵贯座垫至靠背下部"))
    spec["componentTree"].extend(new)


def main():
    spec = load_spec()
    before = len(spec["componentTree"])
    append_view_evidence(spec)
    edit_headlamp_led_strip(spec)
    add_led_dots(spec)
    edit_reflectors(spec)
    fix_trunk_plates(spec)
    add_screen_arms(spec)
    convert_caps_to_knurl_rings(spec)
    add_seat_trims(spec)
    after = len(spec["componentTree"])
    save_spec(spec)
    print(f"components: {before} -> {after} (limit 185)")
    ids = [c["id"] for c in spec["componentTree"]]
    assert len(ids) == len(set(ids)), "duplicate component id!"
    for must in ("headlamp-led-dot-1-l", "headlamp-led-dot-3-r",
                 "rear-reflector-strip-l", "rear-reflector-strip-r",
                 "seat-rear-l-screen-arm", "seat-rear-r-screen-arm",
                 "seat-rear-l-armrest-cap", "seat-rear-r-armrest-cap",
                 "seat-rear-l-side-trim", "seat-rear-r-side-trim"):
        assert must in ids, f"missing {must}"
    print("OK: all planned components present; spec saved.")


if __name__ == "__main__":
    main()
