# -*- coding: utf-8 -*-
"""第二轮：按 docs/reference-checklist.md（82 张参考图，83 条特征）对齐 spec。

覆盖：修正 1（取消虚构的高位刹车灯）、修正 2（轮圈盘缘开窗 20）、
对齐项 A–F，以及 ref-analyst 指出的 14 处指向已删图的死引用。
"""
import copy
import json
from pathlib import Path

SPEC = Path(__file__).with_name("object-sculpt-spec.json")
spec = json.loads(SPEC.read_text(encoding="utf-8"))
by_id = {c["id"]: c for c in spec["componentTree"]}

# ------------------------------------------------------------------ 修正 1：取消高位刹车灯
spec["componentTree"] = [c for c in spec["componentTree"] if c["id"] != "high-mount-stop"]


def strip_refs(o):
    if isinstance(o, list):
        return [x for x in o if x != "high-mount-stop"]
    return o


for key in ("animationAnchors", "featureReviewTargets"):
    for e in spec.get(key, []):
        if isinstance(e.get("componentRefs"), list):
            e["componentRefs"] = strip_refs(e["componentRefs"])
for p in spec.get("buildPasses", []):
    if isinstance(p.get("componentRefs"), list):
        p["componentRefs"] = strip_refs(p["componentRefs"])

# ------------------------------------------------------------------ 修正 2：盘缘开窗 20
for sysd in spec["repetitionSystems"]:
    sysd["count"] = 20
    sysd["name"] = sysd["name"].replace("12 辐", "盘缘 20 开窗")
    sysd["placement"] = {"mode": "radial", "axis": [1, 0, 0], "radius": 0.30, "startAngleDeg": 0}
    sysd["instanceScale"] = [0.16, 0.028, 0.020]
    sysd["notes"] = ("参考图 EX-32 / 第七章：真车为封闭式大饼盘 + 盘缘均布矩形开窗（目测 18–20），"
                     "不是放射辐条。此处 20 个 radial 实例读作盘缘开窗；几何仍被实心轮胎包住，见 risks。")

# ------------------------------------------------------------------ 新材质
def add_material(tpl_id, mid, name, base, emissive, ei, rough, metal, notes, textureless=True):
    m = copy.deepcopy(next(x for x in spec["materials"] if x["id"] == tpl_id))
    m["id"] = mid
    m["name"] = name
    m["baseColor"] = base
    m["color"] = base
    m["albedo"] = {"base": base, "secondary": base, "note": "reference-derived"}
    m["emissive"] = emissive
    m["emissiveIntensity"] = ei
    m["roughness"] = rough
    m["metalness"] = metal
    m["shaderNotes"] = [notes]
    if textureless:
        m["textureless"] = {"declared": True, "evidence": [notes]}
        for f in ("normal", "bump", "displacement", "surfaceFrequencyBands",
                  "textureProjection", "textureResolution", "referencePbr"):
            m[f] = None
    return m


spec["materials"].append(add_material(
    "lamp-gold", "bronze-dark", "暗铜边框（车标外圈）", "#6A5240", "#000000", 0.0, 0.35, 0.85,
    "参考图 G2 采样：车标外圈暗铜 #6A5240；金属无表面细节，不发光的哑铜边框。"))

# 色板按清单第五章校正
def retune(mid, base, emissive=None, ei=None, notes=None):
    m = next(x for x in spec["materials"] if x["id"] == mid)
    m["baseColor"] = base
    m["color"] = base
    m["albedo"] = {"base": base, "secondary": base, "note": "reference-derived"}
    if emissive is not None:
        m["emissive"] = emissive
    if ei is not None:
        m["emissiveIntensity"] = ei
    if notes:
        m["shaderNotes"] = [notes]


retune("lamp-red", "#B51F2C", "#E03040", 2.0,
       "清单第五章 C2 采样 (181,31,44)=#B51F2C；原 #FF1E14 过亮过橙，改绯红系。"
       "上/下各 3 条红横带（上 1 长 2 短、下部镜像 EX-28）由集成层 Canvas emissiveMap 绘制，"
       "本 spec 只提供红色发光面。")
retune("lamp-gold", "#C2A263", "#E8CC8A", 1.8,
       "清单第五章 C2 采样 (194,162,99)=#C2A263；尾灯中部金色点阵屏显示展翅鹰形/羽翼（EX-29），"
       "图案由集成层 Canvas emissiveMap 绘制。")
retune("lamp-mark", "#E8E4DC", "#FFF6E8", 2.2,
       "清单第五章 G2：车标发光白核心 #E8E4DC。曜日放射纹 + 上下对称三角线稿 + MAEXTRO 字带"
       "（EX-07）由集成层 Canvas 贴图绘制，本 spec 只提供自发光面板。")
retune("leather-warm", "#C08A5E", None, None,
       "清单第五章：驼色内饰皮革目测 #C08A5E，原 #A05A2C 偏橙偏深。")
spec.setdefault("materials", [])

# 顶棚星点（对齐项 E）
star = next(x for x in spec["materials"] if x["id"] == "starlight")
star["shaderNotes"] = [
    "集成层应生成 800+ 星点的 Canvas 贴图作 emissiveMap：含大小分级（至少 3 档半径）、"
    "少量斜向流星轨迹点串、整体密度按顶棚面积均布（参考图 IN-16 / 第八章：全顶估计 800–1500+ 枚）。"
    "几何只用 1 块 starlight-headliner 薄板，1 个 draw call，不要回到 InstancedMesh 星点阵。"
]
star["textureless"]["evidence"] = [star["shaderNotes"][0]]


# ------------------------------------------------------------------ 对齐项 A：尾灯重做
def new_component(cid, name, parent, primitive, material, position, scale,
                  rgba, notes, mclass="fabric", rotation=None, tpl="vents-strip", gd=None):
    c = copy.deepcopy(by_id[tpl])
    c["id"] = cid
    c["name"] = name
    c["level"] = "meso"
    c["role"] = "detail"
    c["importance"] = 0.9
    c["confidence"] = 0.86
    c["primitive"] = primitive
    c["topologyClass"] = "assembled-solid"
    c["topologyRationale"] = "薄板/回转体，硬表面可展拓扑"
    c["parent"] = parent
    c["material"] = material
    c["materialLayers"] = [material]
    c["transform"] = {"position": list(position), "rotation": list(rotation or [0, 0, 0]),
                      "scale": list(scale)}
    c["dimensions"] = {"width": scale[0], "height": scale[1], "depth": scale[2],
                       "units": "meters", "confidence": 0.86}
    if gd:
        c["geometryDescriptor"].update(gd)
    c["localFeatures"] = [{"name": name, "kind": "emissive-face", "note": notes}]
    c["notes"] = notes
    c["colorMaterialRecipe"] = {"dominantAlbedo": rgba, "secondaryAlbedo": rgba,
                                "materialClass": mclass, "materialClassConfidence": 0.86}
    return c


SILVER = "rgba(232, 233, 236, 1.0)"
RED = "rgba(181, 31, 44, 1.0)"
GOLD = "rgba(194, 162, 99, 1.0)"

added = []
for side, lamp in (("l", "taillamp-l"), ("r", "taillamp-r")):
    # 外圈拉丝银框：比灯体各向外扩 ~10mm，贴在灯体后脸外侧
    added.append(new_component(
        f"lantern-bezel-{side}", f"宫灯尾灯拉丝银框 {side.upper()}", lamp, "box", "chrome",
        [0, 0, -0.004], [0.20, 0.72, 0.008], SILVER, mclass="metal",
        notes="EX-27 拉丝银/铬外框：0.20×0.72 薄板贴在灯体后脸（灯体 0.18×0.69），"
              "四周留 10mm 银边；世界 z[-2.868,-2.860]。"))
    # 红色横带场：上/下各 3 条由集成层 Canvas 绘制
    added.append(new_component(
        f"lantern-emitter-{side}", f"尾灯红色灯带场 {side.upper()}", lamp, "box", "lamp-red",
        [0, 0, -0.012], [0.16, 0.64, 0.006], RED,
        notes="EX-28 上/下各 3 条红色横带（上 1 长 2 短、下部镜像）由集成层 Canvas emissiveMap 绘制；"
              "世界 z[-2.875,-2.869]，在银框外 1mm。"))
    # 中部金色点阵屏（展翅鹰形/羽翼）
    added.append(new_component(
        f"lantern-signature-{side}", f"尾灯中部金色点阵屏 {side.upper()}", lamp, "box", "lamp-gold",
        [0, 0, -0.020], [0.10, 0.30, 0.004], GOLD,
        notes="EX-29 最高视觉权重的身份特征：中部金色点阵屏显示展翅鹰形/羽翼图案，"
              "由集成层 Canvas emissiveMap 绘制；世界 z[-2.882,-2.878]，在红带场外 3mm。"))

# ------------------------------------------------------------------ 对齐项 B：曜日纹车标
SHIELD = {"profile2D": {"points": [[-0.55, 0.03], [-0.42, 0.12], [0.42, 0.12],
                                   [0.55, 0.03], [0.42, -0.12], [-0.42, -0.12]],
                        "depth": 0.010},
          "topologyIntent": "flat hexagonal shield shell"}
added.append(new_component(
    "emblem-shield", "曜日纹车标六边盾形底座", "front-end", "extrude", "bronze-dark",
    [0, 0.4, 0.036], [1, 1, 1], "rgba(106, 82, 64, 1.0)", mclass="metal", tpl="headlamp-l", gd=SHIELD,
    notes="EX-07：细长六边盾形底座 + 暗铜色边框（G2 采样 #6A5240），世界 z[2.656,2.666]；"
          "放射曜日纹与上下三角线稿由集成层 Canvas 贴图绘制。"))
ma = next(c for c in spec["componentTree"] if c["id"] == "maextro-mark")
ma["transform"]["position"][2] = 0.048
ma["notes"] = (ma.get("notes", "") + " [前移到盾座前 2mm 世界 z=2.668] 作为盾标中部 MAEXTRO 字带（EX-07）。").strip()

# ------------------------------------------------------------------ 对齐项 C：水晶壁灯
for side, x in (("l", 0.875), ("r", -0.875)):
    added.append(new_component(
        f"crystal-sconce-{side}", f"B柱水晶壁灯柱 {side.upper()}", "cabin-interior", "cylinder", "crystal",
        [x, 1.28, 0.42], [0.05, 0.34, 0.05], "rgba(244, 239, 232, 1.0)", mclass="glass", tpl="cap-fl",
        notes="IN-37/L1/L2：B柱/侧壁垂直多面晶体柱，暖光内透；x=±0.875（门内饰板内表面 0.905 以内）、"
              "y 1.11–1.45、z=0.42（B柱位）。"))
    added.append(new_component(
        f"crystal-sconce-band-{side}", f"水晶壁灯镀铬环带 {side.upper()}", "cabin-interior", "cylinder", "chrome",
        [x, 1.28, 0.42], [0.062, 0.035, 0.062], SILVER, mclass="metal", tpl="cap-fl",
        notes="IN-37：晶体柱中部镀铬环带，半径 0.031 略大于柱体 0.025，绕在柱高中点 y=1.28。"))

# ------------------------------------------------------------------ 对齐项 D：门把手星辰发光
for cid, x, z in (("handle-star-fl", 1.032, 1.18), ("handle-star-fr", -1.032, 1.18),
                  ("handle-star-rl", 1.032, -0.28), ("handle-star-rr", -1.032, -0.28)):
    added.append(new_component(
        cid, f"门把手星辰发光条 {cid[-2:].upper()}", "root", "box", "lamp-star",
        [x, 0.97, z], [0.006, 0.030, 0.560], "rgba(234, 240, 255, 1.0)",
        notes="EX-22/F1/F2/F4：门把手凹槽内星辰/星尘发光纹理；薄板贴在把手外侧面"
              "（把手外表面 x=±1.0295，本板 x=±1.029~1.035）。"))
for cid in ("handle-front-l", "handle-slider-l", "handle-front-r", "handle-slider-r"):
    h = next(c for c in spec["componentTree"] if c["id"] == cid)
    h["level"] = "meso"
    h["notes"] = (h.get("notes", "") + " [level→meso] EX-21 通长镀铬把手，此前被 structural-pass 过滤。").strip()

spec["componentTree"].extend(added)

# ------------------------------------------------------------------ 动画锚点
for a in spec["animationAnchors"]:
    if a["id"] == "lamp-states":
        a["componentRefs"] = ["taillamp-l", "taillamp-r", "lantern-emitter-l", "lantern-emitter-r",
                              "headlamp-led-l", "headlamp-led-r", "maextro-mark"]

# ------------------------------------------------------------------ 对齐项 F：尺寸口径统一
spec["coordinateFrame"]["scaleReference"] = (
    "wheelbase 3.430m; overall 5.44×2.006×1.78m（游戏侧 carLayout/World 碰撞盒口径，"
    "清单第四章判定为需统一项）; wheel radius 0.382m; ground y=0")
spec["silhouette"]["aspectRatios"]["length/height"] = round(5.44 / 1.78, 3)
root = next(c for c in spec["componentTree"] if c["id"] == "root")
root["transform"]["scale"] = [2.006, 1.78, 5.44]
root["dimensions"].update({"height": 1.78, "depth": 5.44})
spec["assumptions"].append(
    "整车外形尺寸口径统一为 5.44×2.006×1.78 m（游戏侧碰撞盒口径）；"
    "各分件几何坐标仍按建型时的 5.495/1.850 绝对坐标书写，未做等比缩放——"
    "如需严格贴合需整体系数重算（长度 ×0.990 / 高度 ×0.962）。")

# ------------------------------------------------------------------ 死引用清理（details/ 已删）
DEAD = "<local-reference>/huawei-zunjie-v800-design-black-2x.jpg"
n_dead = 0


def repoint(o):
    global n_dead
    if isinstance(o, dict):
        for k, v in list(o.items()):
            if isinstance(v, str) and "<local-evidence>/details/" in v:
                o[k] = DEAD
                n_dead += 1
            else:
                repoint(v)
    elif isinstance(o, list):
        for v in o:
            repoint(v)


repoint(spec)

# ------------------------------------------------------------------ 风险登记
spec["risks"] = [r for r in spec["risks"] if "轮圈辐条 4×12" not in r] + [
    "座舱布局待改三排：参考图证据 I5/I6/J1-J4/K4/第八章判定真车为「前排 2 + 二排 2 航空座 + 三排长椅」，"
    "本 spec 的「四座豪华舱」是结构性错误；本轮不改动内饰布局，留待下一轮（IN-01/IN-11）。",
    "轮圈盘缘开窗 20×4=80 实例（192 面/实例 = 15,360 面）当前被实心 cylinder 轮胎/轮圈包在内部不可见；"
    "需把 tire-fl..rr 改 torus（或删除这 4 个系统）才既可见又省面（EX-32）。",
    "高位刹车灯：82 张参考图均未出现（清单第十章不确定项），本轮已删除该组件，不虚构。",
]

SPEC.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("components:", len(spec["componentTree"]), "materials:", len(spec["materials"]))
print("added:", [c["id"] for c in added])
print("repointed dead refs:", n_dead)
