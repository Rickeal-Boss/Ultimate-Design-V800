# -*- coding: utf-8 -*-
"""a1_surface_pass_edits.py — surface-pass 整饰波 spec 回写（结构工程师/搭景）

改动清单（全部决策可溯源到 .refcache 参考图）：
  P1-1 中岛 console-island 组：镀铬充电托盘 + 双无线充电板（matte-black）+ 水晶旋钮底座/滚花环
  P1-2 零重力座椅精修：扶手前端上表面控制屏 ×2 + 头枕铭牌 ×2
  P1-3 第三排长凳：座面 + 靠背 + 头枕
  P2-1 后备箱：纯平地板（carpet）+ 门槛护板（matte-black）
  P2-2 门板水晶装饰件 ×4
  P2-3 尾灯上下横杠分区 ×4（几何；轮毂开窗不加几何——已由集成层 Canvas 贴图承担，
       见 V800Adapter.ts createWheelFaceTexture 注释，spec 几何再添会被实心胎/圈遮挡且重复）
  材质：leather-dark/leather-warm/leather-ivory/wood/headliner-suede/curtain/carpet
        七个材质声明 textureless（纹理由集成层程序化 Canvas 贴图提供）
  viewEvidence：追加 7 条参考图条目

组件预算：149 + 21 = 170（≤170）；新增均为低面数基元。
用法：python .img2threejs/tools/a1_surface_pass_edits.py
"""
import copy
import json
import os
import sys

SPEC_PATH = os.path.join(os.path.dirname(__file__), "..", "object-sculpt-spec.json")


def load_spec():
    with open(SPEC_PATH, encoding="utf-8") as f:
        spec = json.load(f)
    return spec


def save_spec(spec):
    with open(SPEC_PATH, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False, indent=1)
        f.write("\n")


def hex_to_rgba(h):
    h = h.lstrip("#")
    r, g, b = (int(h[i : i + 2], 16) for i in (0, 2, 4))
    return f"rgba({r}, {g}, {b}, 1.0)"


# ---------------------------------------------------------------- donors
# 每个新组件按 primitive 深拷贝一个既有合格组件作模板，保证 schema 字段齐全。
DONOR_BY_PRIMITIVE = {
    "box": "tail-chrome-strip",          # meso box, attachment null
    "plane-card": "rear-control-screen", # micro plane-card
    "cylinder": "crystal-sconce-l",      # meso cylinder
    "torus": "cupholder-l",              # micro torus (torusTubeRatio)
}


def build_component(spec, donor_id, comp_id, name, level, parent, primitive,
                    material, dims, pos, scale, rot=None, evidence=(),
                    local_features=(), details=(), notes=""):
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
        "materialClass": mat.get("shaderModel", "MeshStandardMaterial").replace("Mesh", "").replace("Material", "").lower(),
        "materialClassConfidence": 0.9,
        "note": notes,
    }
    sd = c["surfaceDetail"]
    sd.update({"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0,
               "normalPattern": "", "displacementPattern": "", "occlusionPattern": "",
               "edgeWearPattern": "", "notes": notes})
    return c


# ---------------------------------------------------------------- edits
def add_components(spec):
    comps = spec["componentTree"]
    ids = {c["id"] for c in comps}
    E_CONSOLE = "img-console-island"
    E_ZEROG = "img-zero-gravity"
    E_THIRD = "img-third-row"
    E_TRUNK = "img-trunk-flat"
    E_DOORCR = "img-door-crystal"
    E_TAIL = "img-taillamp-eagle"
    E_CUT = "img-cutaway"

    new = []

    def mk(comp_id, name, level, parent, primitive, material, dims, pos, scale,
           rot=None, evidence=(), lf=(), details=(), notes=""):
        new.append(build_component(
            spec, DONOR_BY_PRIMITIVE[primitive], comp_id, name, level, parent,
            primitive, material, dims, pos, scale, rot, evidence, lf, details, notes))

    # ---- P1-1 中岛 console-island（U1 半剖：中岛贯通前排两座；P1/P2 特写）----
    mk("console-island-charge-tray", "中岛无线充电托盘（镀铬包边）", "meso", "cabin-interior",
       "box", "chrome", [0.38, 0.008, 0.26], [0, 0.79, 0.86], [0.38, 0.008, 0.26],
       evidence=[E_CONSOLE, E_CUT],
       lf=[{"name": "镀铬浅盘包边", "kind": "trim",
            "note": "P2_中岛-双无线充电+水晶旋钮.jpg：双充电板共托于一件镀铬包边浅盘内，盘沿宽约 12mm"}],
       details=["d-console-island"], notes="双无线充电板共享镀铬包边托盘")
    mk("charge-pad-r", "无线充电板（右）", "micro", "cabin-interior",
       "plane-card", "matte-black", [0.16, 0.004, 0.22], [-0.095, 0.795, 0.86],
       [0.16, 0.004, 0.22], rot=[-0.25, 0, 0],
       evidence=[E_CONSOLE],
       lf=[{"name": "哑黑充电板面", "kind": "surface",
            "note": "P2_中岛-双无线充电+水晶旋钮.jpg：充电板面为哑黑皮革质感、带镀铬滑动压条，与左板对称成对"}],
       details=["d-console-island"], notes="与 charge-pad（改哑黑、左位）成对")
    mk("console-island-knob-base", "水晶旋钮底座", "micro", "cabin-interior",
       "cylinder", "crystal", [0.095, 0.035, 0.095], [0, 0.806, 1.12], [0.095, 0.035, 0.095],
       evidence=[E_CONSOLE, E_CUT],
       lf=[{"name": "圆柱水晶底座", "kind": "crystal",
            "note": "P1_中岛-中控旋钮.webp：旋钮下为短圆柱水晶底座（transmission 材质），承托球体旋钮"}],
       details=["d-crystal-shift"], notes="补齐 crystal-shifter 球体下方底座，消除悬浮")
    mk("console-island-knob-ring", "水晶旋钮滚花环", "micro", "cabin-interior",
       "torus", "crystal", [0.0945, 0.0945, 0.043], [0, 0.818, 1.12],
       [0.105, 0.105, 0.12], rot=[1.5708, 0, 0],
       evidence=[E_CONSOLE],
       lf=[{"name": "外圈滚花环", "kind": "crystal",
            "note": "P1_中岛-中控旋钮.webp：旋钮外圈为滚花水晶环（knurled ring），环径略大于底座"}],
       details=["d-crystal-shift"], notes="torus 外圈，环抱旋钮底座上部")

    # ---- P1-2 零重力座椅精修（I5/I6/I7/U7：扶手前端上表面控制屏 + 头枕铭牌）----
    for side, seat, sgn in (("l", "seat-rear-l", 1), ("r", "seat-rear-r", -1)):
        mk(f"seat-rear-{side}-screen", f"零重力座椅扶手控制屏（{side}）", "micro", seat,
           "plane-card", "screen-ui", [0.07, 0.05, 0.004], [0, 0.338, 0.17],
           [0.07, 0.05, 0.004], rot=[-1.75, 0, 0],
           evidence=[E_ZEROG],
           lf=[{"name": "扶手前端上表面控制屏", "kind": "screen",
                "note": "I5_座椅-二排零重力.jpg / I7_座椅-后排.jpg：小尺寸控制屏嵌于扶手前端上表面，朝向后排乘员"}],
           details=["d-rear-seat"], notes="屏幕法线上仰、略朝车尾")
        mk(f"seat-rear-{side}-plate", f"头枕铭牌（{side}）", "micro", seat,
           "box", "bronze-dark", [0.05, 0.022, 0.003], [0, 0.76, 0.352],
           [0.05, 0.022, 0.003],
           evidence=[E_ZEROG],
           lf=[{"name": "头枕铭牌", "kind": "badge",
                "note": "I5/I6：头枕正面小金属铭牌（曜日盾标压印位），暗铜色小片"}],
           details=["d-rear-seat"], notes="贴附头枕前面")

    # ---- P1-3 第三排长凳（U1 最后排）----
    mk("seat-third-row", "第三排长凳座面", "meso", "cabin-interior",
       "box", "leather-warm", [1.34, 0.12, 0.5], [0, 0.60, -1.98], [1.34, 0.12, 0.5],
       evidence=[E_THIRD, E_CUT],
       lf=[{"name": "第三排长凳座面", "kind": "seat",
            "note": "U1_用户原图-半剖内饰酒红.png：最后排为通长凳座，位于零重力座椅之后"}],
       details=["d-third-row"], notes="长凳宽约 1.34m")
    mk("seat-third-row-back", "第三排长凳靠背", "meso", "cabin-interior",
       "box", "leather-warm", [1.34, 0.52, 0.12], [0, 0.86, -2.19], [1.34, 0.52, 0.12],
       rot=[-0.15, 0, 0],
       evidence=[E_THIRD, E_CUT],
       lf=[{"name": "第三排长凳靠背", "kind": "seat",
            "note": "U1/K4_后备箱-三排放倒.jpg：靠背微后倾约 8.6°"}],
       details=["d-third-row"], notes="靠背与座面同宽")
    mk("seat-third-row-headrest", "第三排长凳头枕", "micro", "cabin-interior",
       "box", "leather-warm", [1.0, 0.15, 0.1], [0, 1.23, -2.26], [1.0, 0.15, 0.1],
       rot=[-0.15, 0, 0],
       evidence=[E_THIRD, E_CUT],
       lf=[{"name": "第三排通长头枕", "kind": "headrest",
            "note": "U1：最后排头枕；K4 可见双头枕轮廓，几何以一件通长头枕表达（组件预算内）"}],
       details=["d-third-row"], notes="通长头枕，随靠背同角度")

    # ---- P2-1 后备箱纯平地板 + 门槛护板（K1/K2/K4）----
    mk("trunk-floor", "后备箱纯平地板", "meso", "cabin-interior",
       "box", "carpet", [1.55, 0.03, 0.55], [0, 0.30, -2.55], [1.55, 0.03, 0.55],
       evidence=[E_TRUNK],
       lf=[{"name": "纯平载物地板", "kind": "floor",
            "note": "K1_后备箱-纯平储物.jpg：三排之后地板纯平、与座舱地毯面齐平（顶面 0.315 对座舱地板 0.3175）"}],
       details=["d-trunk"], notes=" carpet，顶面与 cabin-floor 齐平")
    mk("trunk-sill", "后备箱门槛护板", "meso", "cabin-interior",
       "box", "matte-black", [1.42, 0.05, 0.06], [0, 0.345, -2.80], [1.42, 0.05, 0.06],
       evidence=[E_TRUNK],
       lf=[{"name": "门槛护板", "kind": "trim",
            "note": "K1：尾门开口下缘门槛护板（主理人指定 matte-black；K1 实车为亮面饰条，材质按主理人口径）"}],
       details=["d-trunk"], notes="尾门开口下缘")

    # ---- P2-2 门板水晶装饰件 ×4（L1/L3：竖向水晶柱 + 中央金属带）----
    for d in ("fl", "fr", "rl", "rr"):
        sgn = -1 if d in ("fr", "rr") else 1  # 左门内面朝 -x，右门内面朝 +x
        mk(f"door-panel-{d}-crystal", f"门板水晶装饰件（{d}）", "micro", f"door-panel-{d}",
           "cylinder", "crystal", [0.03, 0.13, 0.03],
           [0.0423 * sgn, 0.10, -0.38], [0.03, 0.13, 0.03],
           evidence=[E_DOORCR],
           lf=[{"name": "门板水晶竖饰", "kind": "crystal",
                "note": "L1_门板-水晶装饰件.jpg / L3_门板-水晶饰件.jpg：竖向切工水晶柱（transmission），中段有金属箍带（箍带由既有 crystal-sconce 材质口径覆盖，此件为单晶柱小件）"}],
           details=["d-door-crystal"], notes="贴门板内面、后上部")

    # ---- P2-3 尾灯上下横杠分区 ×4（C1）----
    for side, lamp in (("l", "taillamp-l"), ("r", "taillamp-r")):
        for vert, y in (("top", 0.185), ("bottom", -0.185)):
            mk(f"taillamp-bar-{vert}-{side}", f"尾灯{'上' if vert == 'top' else '下'}横杠（{side}）",
               "micro", lamp, "box", "lamp-red", [0.12, 0.03, 0.003],
               [0, y, -0.0095], [0.12, 0.03, 0.003],
               evidence=[E_TAIL],
               lf=[{"name": "尾灯上下横杠分区", "kind": "lamp",
                    "note": "C1_尾部-鹰形LED尾灯.jpg：竖向灯罩上、下缘各有红色横杠分区；几何横杠与既有 3+3 红带 Canvas 图集（lantern-emitter）叠合表达"}],
               details=["d-taillamp"], notes="竖向灯罩为既有 housing-dark extrude，此处补横杠几何")

    for c in new:
        if c["id"] in ids:
            raise SystemExit(f"component id collision: {c['id']}")
        comps.append(c)
    return len(new)


def modify_charge_pad(spec):
    comps = {c["id"]: c for c in spec["componentTree"]}
    cp = comps["charge-pad"]
    mats = {m["id"]: m for m in spec["materials"]}
    mb = mats["matte-black"]
    cp["name"] = "无线充电板（左）"
    cp["transform"]["position"] = [0.095, 0.795, 0.86]
    cp["transform"]["scale"] = [0.16, 0.004, 0.22]
    cp["dimensions"] = {"width": 0.16, "height": 0.004, "depth": 0.22,
                        "units": "meters", "confidence": 0.9}
    cp["material"] = "matte-black"
    cp["materialLayers"] = ["matte-black"]
    cp["colorMaterialRecipe"] = {
        "dominantAlbedo": hex_to_rgba(mb["baseColor"]),
        "secondaryAlbedo": hex_to_rgba(mb["baseColor"]),
        "materialClass": "standard", "materialClassConfidence": 0.9,
        "note": "P2_中岛-双无线充电+水晶旋钮.jpg：充电板面为哑黑",
    }
    refs = cp.get("evidenceRefs", [])
    if "img-console-island" not in refs:
        refs.append("img-console-island")
    cp["localFeatures"] = [{
        "name": "哑黑充电板面", "kind": "surface",
        "note": "P2_中岛-双无线充电+水晶旋钮.jpg：双充电板左右成对，本件为左板；原 leather-warm 改哑黑（matte-black）",
    }]


def declare_textureless(spec):
    """7 个材质声明 textureless：纹理由集成层程序化 Canvas 贴图提供。
    evidence 必须是字符串数组；normal/bump/displacement/surfaceFrequencyBands/
    textureProjection/textureResolution/referencePbr 置 null。"""
    decl = {
        "leather-dark": [
            "菱格绗缝与细粒面纹理由集成层程序化 Canvas 贴图提供（不含照片像素），本材质声明 textureless。",
            "参考图：U1_用户原图-半剖内饰酒红.png、I5_座椅-二排零重力.jpg、I6_座椅-豪华座椅.jpg（酒红菱格座椅面）。",
        ],
        "leather-warm": [
            "菱格绗缝与粒面纹理由集成层程序化 Canvas 贴图提供，本材质声明 textureless。",
            "参考图：U1_用户原图-半剖内饰酒红.png、I5_座椅-二排零重力.jpg、I7_座椅-后排.jpg、K1_后备箱-纯平储物.jpg（座椅/长凳/门板暖色皮革）。",
        ],
        "leather-ivory": [
            "浅色皮革粒面纹理由集成层程序化 Canvas 贴图提供，本材质声明 textureless。",
            "参考图：U1_用户原图-半剖内饰酒红.png、I6_座椅-豪华座椅.jpg（仪表台下部/顶棚后段的浅色皮革区）。",
        ],
        "wood": [
            "木纹纹理由集成层程序化 Canvas 贴图提供，本材质声明 textureless。",
            "参考图：P1_中岛-中控旋钮.webp、P2_中岛-双无线充电+水晶旋钮.jpg、U1_用户原图-半剖内饰酒红.png（中岛/内饰木纹面板）。",
        ],
        "headliner-suede": [
            "麂皮顶棚微绒纹理由集成层程序化 Canvas 贴图提供，本材质声明 textureless。",
            "参考图：J1_星空顶.jpg、U1_用户原图-半剖内饰酒红.png（顶棚浅色绒面）。",
        ],
        "curtain": [
            "遮阳帘织物纹理由集成层程序化 Canvas 贴图提供，本材质声明 textureless。",
            "参考图：M1_遮阳帘-电动隐私.jpg、U6_用户原图-后排星空顶隔断.jpg（后排电动隐私帘）。",
        ],
        "carpet": [
            "长绒地毯纹理由集成层程序化 Canvas 贴图提供，本材质声明 textureless。",
            "参考图：I5_座椅-二排零重力.jpg（座舱长绒地毯）、K1_后备箱-纯平储物.jpg（后备箱地毯地板）。",
        ],
    }
    nulled = ("normal", "bump", "displacement", "surfaceFrequencyBands",
              "textureProjection", "textureResolution", "referencePbr")
    for mid, ev in decl.items():
        mat = next(m for m in spec["materials"] if m["id"] == mid)
        mat["textureless"] = {"declared": True, "evidence": list(ev)}
        for k in nulled:
            mat[k] = None
        sn = mat.get("shaderNotes")
        note = "纹理由集成层程序化 Canvas 贴图提供（textureless 声明）"
        if isinstance(sn, list):
            if note not in sn:
                sn.append(note)
        else:
            mat["shaderNotes"] = [note]


def add_view_evidence(spec):
    existing = {v["id"] for v in spec["viewEvidence"]}
    add = [
        {"id": "img-console-island", "view": "console island close",
         "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1},
         "observations": ["木纹中岛面板/双无线充电板（哑黑+镀铬包边托盘）/水晶旋钮（圆柱底座+滚花环）/双镀铬杯架圆环"],
         "confidence": 0.92,
         "sourceImages": ["P1_中岛-中控旋钮.jpg", "P2_中岛-双无线充电+水晶旋钮.jpg"]},
        {"id": "img-zero-gravity", "view": "zero-gravity seats close",
         "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1},
         "observations": ["扶手前端上表面小控制屏/头枕铭牌/菱格绗缝/腿托/镀铬饰件"],
         "confidence": 0.93,
         "sourceImages": ["I5_座椅-二排零重力.jpg", "I6_座椅-豪华座椅.jpg", "I7_座椅-后排.jpg", "U7_用户原图-后排座椅.jpg"]},
        {"id": "img-third-row", "view": "third-row bench",
         "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1},
         "observations": ["最后排通长凳座+靠背+头枕，位于零重力座椅之后"],
         "confidence": 0.85,
         "sourceImages": ["U1_用户原图-半剖内饰酒红.png", "K4_后备箱-三排放倒.jpg"]},
        {"id": "img-trunk-flat", "view": "trunk flat floor",
         "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1},
         "observations": ["三排后纯平载物地板/尾门开口下缘门槛护板"],
         "confidence": 0.9,
         "sourceImages": ["K1_后备箱-纯平储物.jpg", "K2_后备箱-三排放倒.webp", "K4_后备箱-三排放倒.jpg"]},
        {"id": "img-door-crystal", "view": "door crystal ornament",
         "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1},
         "observations": ["门板竖向切工水晶柱、中段金属箍带、暖光漫射"],
         "confidence": 0.9,
         "sourceImages": ["L1_门板-水晶装饰件.jpg", "L3_门板-水晶饰件.jpg"]},
        {"id": "img-taillamp-eagle", "view": "taillamp eagle LED close",
         "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1},
         "observations": ["竖向灯罩/上缘多道红横杠/中部鹰形 LED 点阵（金签名区）/下缘红横杠/镀铬包边"],
         "confidence": 0.9,
         "sourceImages": ["C1_尾部-鹰形LED尾灯.jpg"]},
        {"id": "img-wheel-turbine", "view": "turbine wheel close",
         "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1},
         "observations": ["封闭大饼盘面/盘缘约 15–20 个圆角矩形开窗/中央曜日盾标+滚花环——开窗形态已由集成层 createWheelFaceTexture Canvas 贴图承担，spec 几何不再添加（会被实心胎/圈遮挡）"],
         "confidence": 0.9,
         "sourceImages": ["D1_轮毂-特写.jpg", "D3_轮毂-特写.jpg", "D4_轮毂-特写.jpg"]},
    ]
    for v in add:
        if v["id"] not in existing:
            spec["viewEvidence"].append(v)


def main():
    spec = load_spec()
    before = len(spec["componentTree"])
    n = add_components(spec)
    modify_charge_pad(spec)
    declare_textureless(spec)
    add_view_evidence(spec)
    after = len(spec["componentTree"])
    if after > 170:
        raise SystemExit(f"component count {after} exceeds budget 170")
    save_spec(spec)
    print(f"components: {before} -> {after} (+{n})")
    print("materials textureless declared: leather-dark/leather-warm/leather-ivory/wood/headliner-suede/curtain/carpet")
    print("viewEvidence:", len(spec["viewEvidence"]))
    print("OK saved", os.path.abspath(SPEC_PATH))


if __name__ == "__main__":
    sys.exit(main())
