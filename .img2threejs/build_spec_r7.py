"""填充 r7-sculpt-spec.json —— 智界 R7（Luxeed R7）程序化车模 spec。

坐标系与尊界 V800 完全一致：+Z 车头、+Y 上、原点=轴距中点地面，单位米。
尺寸口径：长 4.956 / 宽 1.981 / 高 1.634 / 轴距 2.950 / 轮距 1.680 / 胎 255-45-R21（r=0.383）。

生成器硬约定（每条都在踩坑清单里付过学费）：
  * 尺寸真源是 transform.scale，dimensions 只是元数据；
  * extrude 沿 0→depth 单侧挤出，节点 position 必须补偿 depth/2（侧视件 rotY(-90°) + pos.x=depth/2）；
  * 车尾 extrude 件必须 rotY(π)，局部 +z 挤向世界 -z；
  * profile 绕序必须 CCW（shoelace>0），否则帽面法线反、件会"隐形"；
  * repetitionSystems 只认 placement:{mode:'radial',axis,radius,startAngleDeg} + instanceScale。
本脚本幂等：每次都从 r7-sculpt-spec.json 的骨架（new_sculpt_spec.py 产出）重建全部动态段。
"""
from __future__ import annotations

import json
import math
from pathlib import Path

WRK = Path(__file__).resolve().parent
SP = WRK / "r7-sculpt-spec.json"

# ---------------------------------------------------------------- 几何小工具


def shoelace(points: list[list[float]] | list[tuple[float, float]]) -> float:
    total = 0.0
    for i, (x0, y0) in enumerate(points):
        x1, y1 = points[(i + 1) % len(points)]
        total += x0 * y1 - x1 * y0
    return total / 2.0


def ccw(points: list[tuple[float, float]]) -> list[list[float]]:
    """绕序归一：shoelace>0 为 CCW（生成器帽面法线朝 +Z 的前提）。"""
    pts = [[round(x, 5), round(y, 5)] for x, y in points]
    if shoelace(pts) < 0:
        pts.reverse()
    return pts


def arc(cx: float, cy: float, r: float, a0: float, a1: float, n: int) -> list[tuple[float, float]]:
    """角度制圆弧，含两端点（a0→a1 线性插值，可逆序）。"""
    out = []
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        out.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return out


def band(top: list[tuple[float, float]], thickness: float) -> list[list[float]]:
    """把一条上缘折线加厚成薄壳带（法线朝下侧偏移），返回 CCW 闭合轮廓。"""
    bottom = []
    n = len(top)
    for i, (z, y) in enumerate(top):
        a = top[max(0, i - 1)]
        b = top[min(n - 1, i + 1)]
        tz, ty = b[0] - a[0], b[1] - a[1]
        length = math.hypot(tz, ty) or 1.0
        nz, ny = ty / length, -tz / length
        if ny > 0:  # 法线必须朝下（壳往车体内部加厚）
            nz, ny = -nz, -ny
        bottom.append((z + nz * thickness, y + ny * thickness))
    return ccw(top + list(reversed(bottom)))


def rrect(w: float, h: float, r: float, seg: int = 4) -> list[list[float]]:
    """圆角矩形（弧段锁死 seg 段 —— 多弧段只会让帽沿硬边暴增）。"""
    hw, hh = w / 2.0, h / 2.0
    r = min(r, hw * 0.98, hh * 0.98)
    pts: list[tuple[float, float]] = []
    for cx, cy, a0 in (
        (hw - r, -hh + r, -90.0),
        (hw - r, hh - r, 0.0),
        (-hw + r, hh - r, 90.0),
        (-hw + r, -hh + r, 180.0),
    ):
        pts += arc(cx, cy, r, a0, a0 + 90.0, seg)
    return ccw(pts)


# ---------------------------------------------------------------- 材质

MAT: dict[str, dict] = {}


def M(mid, name, color, rough, metal, cls, **kw):
    entry = {
        "id": mid,
        "name": name,
        "type": kw.pop("type", "standard"),
        "shaderModel": kw.pop("shaderModel", "MeshPhysicalMaterial"),
        "baseColor": color,
        "color": color,
        "albedo": {"base": color, "secondary": kw.pop("accent", color), "note": "reference-derived"},
        "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.06},
        "textureResolution": None,
        "textureProjection": None,
        "surfaceFrequencyBands": None,
        "roughness": rough,
        "metalness": metal,
        "normal": None,
        "bump": None,
        "displacement": None,
        "ambientOcclusion": {"type": "baked-contact", "intensity": 0.45, "note": "contact AO at panel gaps"},
        "wear": {"type": "none", "intensity": 0},
        "dirt": {"type": "none", "intensity": 0},
        "localOverrides": kw.pop("localOverrides", []),
        "shaderNotes": kw.pop("shaderNotes", []),
        "notes": kw.pop("notes", ""),
        "envMapIntensity": kw.pop("envMapIntensity", 1.0),
        "materialClass": cls,
        "textureless": {
            "declared": True,
            "evidence": [kw.pop("textureless", "该件为均质表面，靠 PBR 标量 + envMap 表达，参考图无可辨表面纹理。")],
        },
    }
    entry.update(kw)
    MAT[mid] = entry
    return entry


M("paint-green", "墨绿金属漆（车身）", "#1D5C50", 0.18, 0.55, "metal",
  accent="#123F38", clearcoat=1.0, clearcoatRoughness=0.08, iridescence=0.15,
  envMapIntensity=1.05,
  shaderNotes=["墨绿金属漆：clearcoat 1.0 / roughness 0.18 / metalness 0.55，掠射角出墨绿→青绿 flop；iridescence 0.15 供云母片微光"],
  localOverrides=[{"id": "paint-green-deep", "zone": "shadow-side", "baseColor": "#123F38", "note": "背光面加深，参考图左前 3/4 侧面暗部"}])
M("paint-black", "曜黑饰件（窗框/后视镜支臂）", "#0E1012", 0.28, 0.45, "metal",
  accent="#1A1D20", clearcoat=0.8, clearcoatRoughness=0.12)
M("chrome", "镀铬饰件", "#E8E9EC", 0.12, 1.0, "metal", envMapIntensity=1.2,
  shaderNotes=["抛光镀铬，必须有 envMap 反射；窗框/门槛饰条/前贯穿饰条"])
M("glass-dark", "深色隐私玻璃", "#141A22", 0.05, 0.22, "glass", opacity=0.62, transparent=True,
  envMapIntensity=1.15, accent="#2A323C",
  shaderNotes=["R12 铁律：玻璃走 transparent alpha（metal 0.22 Fresnel），不走 transmission —— 透射 pass 整场景重绘是整帧 DC 翻倍的根因"],
  notes="侧窗/后挡/天幕统一此材质；适配层 high 档保持 opacity 0.62，medium/low 提到 0.72")
M("glass-clear", "前挡玻璃", "#8A939C", 0.04, 0.05, "glass", opacity=0.42, transparent=True,
  envMapIntensity=1.0)
M("tire", "轮胎橡胶", "#141414", 0.92, 0.0, "rubber",
  textureless="胎面在本视角无可辨花纹细节；胎侧字环由适配层 Canvas 提供（品牌中性）")
M("wheel-alloy", "黑色轮圈（21 寸双十辐）", "#191A1C", 0.32, 0.85, "metal",
  accent="#2B2D30", envMapIntensity=0.9,
  shaderNotes=["哑光黑漆轮圈 + 机加工亮边：roughness 0.32/ metalness 0.85，靠 envMap 出金属冷调"])
M("housing-dark", "灯腔暗底", "#14171A", 0.28, 0.7, "metal")
M("matte-black", "哑光黑（轮眉/下包围/扩散器）", "#121316", 0.78, 0.08, "plastic")
M("screen-ui", "中控/后排屏 UI 材质", "#0A0C10", 0.10, 0.0, "glass",
  emissive="#9FB6C8", emissiveIntensity=1.25,
  textureless="屏幕内容由适配层 Canvas 贴图提供")
M("gauge-ui", "仪表屏动态材质", "#060A08", 0.10, 0.0, "glass",
  emissive="#7FD8A8", emissiveIntensity=1.35,
  textureless="仪表内容由适配层每帧刷新的 10.25\" Canvas 提供")
M("lamp-white", "白光 emissive（日行灯带）", "#FFFFFF", 0.30, 0.0, "glass",
  emissive="#FFFFFF", emissiveIntensity=2.4)
M("lamp-head", "大灯投影镜芯", "#EAF2FF", 0.18, 0.10, "glass",
  emissive="#EAF2FF", emissiveIntensity=2.1)
M("lamp-red", "尾灯红光", "#B51F2C", 0.25, 0.0, "glass",
  emissive="#E03040", emissiveIntensity=2.0,
  shaderNotes=["贯穿尾灯 + 反光条共用；适配层 setBrakeLights 改 emissiveIntensity"])
M("plate", "牌照板", "#1A1D22", 0.42, 0.10, "plastic")
M("plate-mark", "字标/铭牌发光字", "#C9CED6", 0.35, 0.15, "glass",
  emissive="#C9CED6", emissiveIntensity=0.85,
  textureless="LUXEED / 智界R7 / 奇瑞汽车 字样由适配层 Canvas 贴图绘制（仅文字性引用，非官方）")
M("leather-plum", "紫灰真皮（仪表台上/门板上沿）", "#6E5A72", 0.62, 0.02, "fabric",
  accent="#574A5C",
  shaderNotes=["紫灰 Nappa：sheen 免用（无贴图时靠 roughness 0.62 + 低金属度出绒感）"])
M("leather-ivory", "米白真皮（仪表台下/座椅/门板）", "#EDE6DA", 0.60, 0.02, "fabric",
  accent="#D8CEBF")
M("leather-charcoal", "深灰内饰件（中岛/座椅侧翼）", "#2A2A30", 0.66, 0.03, "fabric")
M("suede-ivory", "米白麂皮顶棚", "#EFEAE0", 0.88, 0.0, "fabric")
M("carpet", "地毯", "#2A2A2E", 0.95, 0.0, "fabric")
M("speaker-lattice", "网罩扬声器面", "#D9D2C6", 0.70, 0.05, "plastic",
  textureless="网格由适配层 Canvas 点阵图集提供（参考图后排门板白色网罩）")
M("ambient", "氛围灯带（冷白）", "#7FA0C8", 0.30, 0.0, "glass",
  emissive="#8FB4DC", emissiveIntensity=1.1)
M("bronze-dark", "暗铜色饰条（出风口/按键）", "#6B5B45", 0.30, 0.90, "metal")
M("caliper-red", "红色刹车卡钳", "#B0202A", 0.35, 0.20, "metal",
  accent="#8C1A22")
M("pedal-metal", "踏板铝合金", "#8E9298", 0.28, 0.95, "metal")

MATS = list(MAT.values())

# ---------------------------------------------------------------- 组件工厂

EVIDENCE_ALL = ["img-r7-34"]
COLOR = {mid: m["baseColor"] for mid, m in MAT.items()}
MATCLASS = {mid: m["materialClass"] for mid, m in MAT.items()}


def hex_to_rgba(value: str, alpha: float = 1.0) -> str:
    v = value.lstrip("#")
    r, g, b = int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)
    return f"rgba({r}, {g}, {b}, {alpha})"


def static_anim(conf: float = 0.9) -> dict:
    return {
        "animationRole": "static",
        "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": conf},
        "transformChannels": {"translate": False, "rotate": False, "scale": False, "bend": False,
                             "twist": False, "detach": False, "visibility": True, "materialState": True},
        "sockets": [],
        "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": False, "notes": ""},
        "constraints": [],
        "destruction": {"breakable": False, "fractureGroup": "root", "seamRefs": [],
                        "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"},
    }


def spin_anim(axis: list[float], collider: dict, conf: float = 0.95) -> dict:
    anim = static_anim(conf)
    anim["animationRole"] = "spin"
    anim["pivot"] = {"mode": "center", "localPosition": [0, 0, 0], "axis": axis, "confidence": conf}
    anim["transformChannels"]["rotate"] = True
    anim["collider"] = collider
    return anim


COMPS: list[dict] = []


def C(cid, name, level, prim, parent, pos, dims=(0.05, 0.05, 0.05), rot=(0, 0, 0),
      mat="chrome", scale=(1, 1, 1), imp=0.8, conf=0.9, desc=None, topo="assembled-solid",
      topoR=None, role="detail", feats=None, anim=None, evidence=None, det=None, tier="hero"):
    # 归一化基元（box / plane-card / torus：几何都是 ±0.5 单位体）尺寸真源就是 transform.scale；
    # extrude / lathe 的 profile 直接以米书写（lathe 的归一化 profile 由调用方显式给 scale）。
    if prim in {"box", "plane-card", "torus"} and tuple(scale) == (1, 1, 1):
        scale = dims
    comp = {
        "id": cid,
        "name": name,
        "level": level,
        "role": role,
        "importance": imp,
        "confidence": conf,
        "primitive": prim,
        "topologyClass": topo,
        "topologyRationale": topoR or f"{prim} 表达该部件的可展硬表面",
        "geometryDescriptor": desc if desc is not None else {
            "topologyIntent": "hard-surface precise",
            "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2},
            "deformationStack": [],
            "uvStrategy": "generated procedural coordinates",
            "normalStrategy": "vertex normals from generated geometry",
        },
        "parent": parent,
        "attachment": None,
        "dimensions": {"width": dims[0], "height": dims[1], "depth": dims[2], "units": "meters",
                       "confidence": conf},
        "transform": {"position": list(pos), "rotation": list(rot), "scale": list(scale)},
        "actionProfile": anim or static_anim(conf),
        "material": mat,
        "materialLayers": [mat],
        "deformations": [],
        "joints": [],
        "seams": [],
        "localFeatures": feats or [],
        "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0,
                          "normalPattern": "", "displacementPattern": "", "occlusionPattern": "",
                          "edgeWearPattern": "", "notes": ""},
        "evidenceRefs": evidence or EVIDENCE_ALL,
        "details": det or [],
        "fidelityTier": tier,
        "colorMaterialRecipe": {
            "dominantAlbedo": hex_to_rgba(COLOR[mat]),
            "secondaryAlbedo": hex_to_rgba(COLOR[mat], 0.85),
            "materialClass": MATCLASS[mat],
            "materialClassConfidence": 0.9,
        },
    }
    COMPS.append(comp)
    return comp


def extrude_desc(points, depth, bevel=0.008, seg=2, shaping=None, holes=None, intent="hard-surface precise"):
    desc = {
        "profile2D": {"points": points, "depth": depth,
                      "bevel": {"thickness": min(0.006, bevel), "size": bevel, "offset": -bevel, "segments": seg}},
        "topologyIntent": intent,
        "edgeTreatment": {"type": "rounded", "bevelRadius": bevel, "segments": seg},
        "deformationStack": [],
        "uvStrategy": "generated procedural coordinates",
        "normalStrategy": "vertex normals",
    }
    if shaping:
        desc["profile2D"]["shaping"] = shaping
    if holes:
        desc["profile2D"]["holes"] = holes
    return desc


def lathe_desc(points, segments=32, intent="revolved shell"):
    return {
        "topologyIntent": intent,
        "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3},
        "deformationStack": [],
        "uvStrategy": "generated procedural coordinates",
        "normalStrategy": "vertex normals from generated geometry",
        "latheProfile": {"points": [[round(r, 5), round(y, 5)] for r, y in points], "segments": segments},
    }


SIDE_ROT = [0, -1.5708, 0]


def side_x(sign: int, outer: float, depth: float) -> float:
    """侧视挤出件的节点 x：挤出从节点 x 向 -x 走 depth。
    sign>0（车左 +X）：节点 = 外缘；sign<0（车右 -X）：节点 = -(外缘-depth)。"""
    return outer if sign > 0 else -(outer - depth)


def side_part(sign: int, outer: float, depth: float, pts):
    """严格矢状镜像的侧视件：(node_x, rot, profile)。

    左右必须只翻 x：左件 rotY(-90°) + 节点 x=+outer（挤出朝 +x 内侧收）；
    右件 rotY(+90°) + 节点 x=-outer，并把 profile 的 z 取负抵掉 rotY(+90) 的 z 翻转。
    这样两个节点 x 互为相反数（validate_chirality 只读节点坐标，能验），几何也是真镜像。
    """
    if sign > 0:
        return outer, [0, -1.5708, 0], ccw(pts)
    return -outer, [0, 1.5708, 0], ccw([(-x, y) for (x, y) in pts])


# ================================================================ 1. 外观

# ---- 根节点（macro 容器；实心盒占位由适配层隐藏）----
C("root", "智界 R7 整车", "macro", "box", None, (0, 0, 0), (1.981, 1.634, 4.956),
  mat="paint-green", scale=(1.981, 1.634, 4.956), imp=1.0, conf=1.0, role="body",
  topo="assembled-solid", topoR="整车为组装体根节点，子件各自独立成型",
  evidence=["img-r7-34", "img-r7-side", "img-r7-front", "img-r7-rear"])

# ---- 车身下半壳体（侧视轮廓挤出，含轮拱真开口）----
ARCH_R = 0.438          # 轮拱半径 = 胎 0.383 + 5.5cm 间隙
WHEEL_Z = 1.475
WHEEL_Y = 0.383
SILL_Y = 0.180


def body_profile() -> list[list[float]]:
    pts: list[tuple[float, float]] = [
        # 前下角 → 前脸上行 → 机盖 → 腰线 → 尾肩
        (2.300, SILL_Y), (2.360, 0.196), (2.400, 0.290), (2.412, 0.440), (2.404, 0.620),
        (2.384, 0.762), (2.348, 0.880), (2.298, 0.930), (2.150, 0.975), (1.700, 1.008),
        (1.100, 1.042), (0.860, 1.074), (0.300, 1.089), (-0.900, 1.093), (-1.600, 1.091),
        (-2.050, 1.076), (-2.280, 1.048), (-2.380, 1.000), (-2.420, 0.930),
        # 尾立面下探 → 后下围
        (-2.420, 0.560), (-2.400, 0.440), (-2.355, 0.330), (-2.300, 0.255),
        (-2.230, 0.200), (-2.150, SILL_Y),
    ]
    dy = SILL_Y - WHEEL_Y
    dz = math.sqrt(ARCH_R ** 2 - dy ** 2)
    # 拱口走**上半圆**：从后脚 207.6° 递减到前脚 -27.6°（经 90° 拱顶）。
    # 若用 atan2 的 -153.3° 当起点，插值会经过 -90°（圆底）→ 拱口朝下挖穿到底 y=-0.055。
    a_in = math.degrees(math.atan2(dy, -dz)) + 360.0   # ≈207.6°（后脚）
    a_out = math.degrees(math.atan2(dy, dz))           # ≈-27.6°（前脚）
    for zc in (-WHEEL_Z, WHEEL_Z):                # 底边走 +z：先后脚→拱顶→前脚
        pts.append((zc - dz, SILL_Y))
        pts += arc(zc, WHEEL_Y, ARCH_R, a_in, a_out, 12)
        pts.append((zc + dz, SILL_Y))
    pts.append((2.230, SILL_Y))
    return ccw(pts)


BODY = body_profile()
C("body-lower", "车身下半壳体", "macro", "extrude", "root", (0.965, 0, 0),
  dims=(1.93, 0.93, 4.83), rot=SIDE_ROT, mat="paint-green", imp=1.0, conf=0.95, role="body",
  topo="conforming-shell",
  topoR="连续侧视轮廓单壳挤出，一次性表达机盖肩线/腰线/轮拱开口/尾臀线",
  desc=extrude_desc(BODY, 1.93, bevel=0.02, seg=3, intent="lofted side-profile shell with true wheel-arch cutouts",
                    shaping={"space": "side",
                             "waistBulge": {"yCenter": 0.55, "ySpan": 0.50, "amount": 0.022},
                             "tumblehome": {"yBase": 0.80, "yTop": 1.10, "topScale": 0.98},
                             "planTaperNose": {"zFrom": 1.60, "zTo": 2.41, "amount": 0.03, "yGate": 1.12},
                             "planTaperTail": {"zFrom": -1.80, "zTo": -2.42, "amount": 0.03, "yGate": 1.12}}),
  feats=[
      {"id": "d-beltline-rise", "name": "腰线后扬", "kind": "contour",
       "note": "腰线 y 1.074@z0.86 → 1.093@z-0.9 → 1.076@z-2.05，后段微扬"},
      {"id": "d-arch-cladding", "name": "轮拱真开口", "kind": "hole",
       "note": "前后轮拱按 r0.438 上半圆开挖，脚点落 y0.18 底边；黑色包边另件覆盖拱口"},
  ],
  evidence=["img-r7-34", "img-r7-side", "img-r7-rear"], det=["d-beltline-rise", "d-arch-cladding"])

# ---- 机盖（侧视薄板挤出，跟随机盖下倾线）----
HOOD = ccw([(1.020, 1.048), (1.600, 1.022), (2.100, 0.988), (2.330, 0.962), (2.372, 0.952),
            (2.360, 0.905), (2.300, 0.900), (2.060, 0.936), (1.580, 0.976), (1.020, 1.004)])
C("hood", "机盖板", "meso", "extrude", "root", (0.71, 0, 0), dims=(1.42, 0.15, 1.39),
  rot=SIDE_ROT, mat="paint-green", imp=0.9, conf=0.9, role="body",
  topo="conforming-shell", topoR="侧视薄楔板挤出，机盖前倾 3.4°，两端 20mm 收边",
  desc=extrude_desc(HOOD, 1.42, bevel=0.014, seg=2, intent="hood panel slab following the nose-to-cowl fall"),
  feats=[{"id": "d-hood-cutline", "name": "机盖分缝", "kind": "seam",
          "note": "机盖后缘 y1.048 与风挡下沿留 8mm 分缝"}],
  evidence=["img-r7-front", "img-r7-34"], det=["d-hood-cutline"])

# ---- 前脸：贯穿镀铬饰条 + 细长 LED 光带 + 三段式下进气 ----
C("front-fascia", "前脸主体（保险杠罩）", "meso", "extrude", "root", (0, 0.640, 2.398),
  dims=(1.86, 0.86, 0.080), mat="paint-green", imp=0.95, conf=0.9, role="body",
  topo="conforming-shell", topoR="正视圆角矩形沿 +Z 挤出的保险杠罩，与车身前缘 2.412 齐平",
  desc=extrude_desc(rrect(1.86, 0.86, 0.10), 0.080, bevel=0.012, seg=2,
                    intent="rounded-rect bumper cover extrusion"),
  feats=[{"id": "d-front-blade", "name": "贯穿镀铬饰条", "kind": "linework",
          "note": "y0.86 全宽 1.72 的镀铬横条，与两侧大灯灯带同高"}],
  evidence=["img-r7-front"], det=["d-front-blade"])
for s, side in ((1, "l"), (-1, "r")):
    C(f"headlamp-{side}", f"C 形大灯总成（{'左' if s > 0 else '右'}）", "meso", "extrude", "root",
      (s * 0.635, 0.862, 2.436), dims=(0.44, 0.135, 0.055), rot=(0, 0, 0), mat="housing-dark",
      imp=0.95, conf=0.92, role="lamp",
      topo="conforming-shell", topoR="灯罩为细长楔形轮廓挤出，内端收窄以贴合贯穿饰条",
      desc=extrude_desc(ccw([(-0.215, -0.030), (-0.060, 0.030), (0.150, 0.048), (0.220, 0.020),
                             (0.205, -0.040), (-0.040, -0.062), (-0.200, -0.055)]), 0.055,
                        bevel=0.006, seg=2, intent="tapered lamp housing extrusion"),
      evidence=["img-r7-front"], det=["d-headlamp-c"])
    C(f"drl-strip-{side}", f"日行灯带（{'左' if s > 0 else '右'}）", "micro", "box", "root",
      (s * 0.640, 0.792, 2.452), dims=(0.40, 0.013, 0.016), mat="lamp-white",
      imp=0.9, conf=0.92, role="lamp",
      feats=[{"id": f"d-drl-{side}", "name": "下沿细长光带", "kind": "emissive",
              "note": "大灯下沿 0.40m 白光带，与贯穿饰条一起构成本车前脸识别点"}],
      evidence=["img-r7-front"])
    for k in range(2):
        C(f"headlamp-projector-{k + 1}-{side}", f"大灯投影镜芯{k + 1}（{'左' if s > 0 else '右'}）",
          "micro", "box", "root", (s * (0.520 + 0.088 * k), 0.872, 2.462),
          dims=(0.062, 0.048, 0.026), mat="lamp-head", imp=0.8, conf=0.9, role="lamp",
          feats=[{"id": f"d-projector-{side}", "name": "大灯内 3 颗投影 + 点阵带", "kind": "bevel",
                  "note": "C 形灯罩内并排的方形投影镜芯（本模型 2 颗/侧，第 3 颗由点阵贴图补）"}],
          evidence=["img-r7-front"], det=[f"d-projector-{side}"])
C("light-bar-front", "前贯穿饰条（镀铬横向）", "meso", "box", "root", (0, 0.852, 2.454),
  dims=(1.74, 0.024, 0.020), mat="chrome", imp=0.95, conf=0.95, role="trim",
  feats=[{"id": "d-full-width-blade", "name": "全宽镀铬横条", "kind": "linework",
          "note": "左右大灯之间一条通长镀铬饰条，参考正前视图最亮的一根横线"}],
  evidence=["img-r7-front", "img-r7-34"], det=["d-full-width-blade"])
C("logo-shield", "车头盾形车标座", "micro", "extrude", "root", (0, 0.905, 2.462),
  dims=(0.058, 0.098, 0.014), mat="chrome", imp=0.9, conf=0.92, role="badge",
  topo="surface-relief", topoR="盾形薄浮雕板，外轮廓 6 点 CCW",
  desc=extrude_desc(ccw([(-0.029, 0.049), (0.029, 0.049), (0.029, -0.012), (0.0, -0.049), (-0.029, -0.012)]),
                    0.014, bevel=0.004, seg=1, intent="shield badge relief"),
  feats=[{"id": "d-shield-badge", "name": "盾形车标", "kind": "bevel",
          "note": "宽 5.8cm 高 9.8cm 的盾形座，内部菱格由适配层贴图"}],
  evidence=["img-r7-front"], det=["d-shield-badge"])
C("front-intake", "三段式下进气口", "meso", "extrude", "root", (0, 0.455, 2.428),
  dims=(1.32, 0.300, 0.055), mat="matte-black", imp=0.9, conf=0.9, role="grille",
  topo="conforming-shell", topoR="圆角矩形沿 +Z 挤出 55mm 的黑色进气框",
  desc=extrude_desc(rrect(1.32, 0.30, 0.05), 0.055, bevel=0.008, seg=2, intent="lower intake frame"),
  feats=[{"id": "d-intake-three-part", "name": "三段式进气分隔", "kind": "groove",
          "note": "中部横梁 + 两侧竖向鳍片把进气口切成三段"}],
  evidence=["img-r7-front"], det=["d-intake-three-part"])
for s, side in ((1, "l"), (-1, "r")):
    C(f"duct-{side}", f"侧导流口（{'左' if s > 0 else '右'}）", "meso", "extrude", "root",
      (s * 0.845, 0.600, 2.430), dims=(0.130, 0.300, 0.050), mat="matte-black",
      imp=0.8, conf=0.88, role="grille",
      topo="conforming-shell", topoR="竖向圆角长孔沿 +Z 挤出的侧导流槽",
      desc=extrude_desc(rrect(0.13, 0.30, 0.045), 0.050, bevel=0.006, seg=2, intent="air curtain duct"),
      evidence=["img-r7-front", "img-r7-34"])
C("front-plate", "前牌照板（智界 R7）", "micro", "plane-card", "root", (0, 0.545, 2.470),
  dims=(0.440, 0.140, 0.004), mat="plate", imp=0.7, conf=0.9, role="badge",
  feats=[{"id": "d-plate-text", "name": "牌照字样", "kind": "decal",
          "note": "「智界 R7」由适配层 Canvas 绘制"}],
  evidence=["img-r7-front"], det=["d-plate-text"])
C("front-lip", "前唇下扰流", "meso", "extrude", "root", (0, 0.270, 2.410),
  dims=(1.70, 0.070, 0.070), mat="matte-black", imp=0.7, conf=0.88, role="trim",
  topo="conforming-shell", topoR="横贯前保下沿的黑色唇板",
  desc=extrude_desc(rrect(1.70, 0.07, 0.03), 0.070, bevel=0.006, seg=2, intent="front lip blade"),
  evidence=["img-r7-front"])

# ---- 尾部 ----
C("tailgate", "尾门板", "meso", "extrude", "root", (0, 0.905, -2.400),
  dims=(1.72, 0.600, 0.078), rot=(0, 3.14159, 0), mat="paint-green", imp=0.95, conf=0.92, role="body",
  topo="conforming-shell", topoR="车尾正视圆角矩形，rotY(π) 后向 -Z 挤出 78mm 至 z=-2.478",
  desc=extrude_desc(rrect(1.72, 0.60, 0.08), 0.078, bevel=0.012, seg=2, intent="tailgate panel extrusion"),
  feats=[{"id": "d-tail-shoulder", "name": "尾部肩线折面", "kind": "contour",
          "note": "尾门左右肩部各一道 r0.08 折面，参考正后图的两道竖向反光棱"}],
  evidence=["img-r7-rear"], det=["d-tail-shoulder"])
C("tail-lamp-band", "尾灯暗场带（全宽烟熏）", "meso", "box", "root", (0, 1.055, -2.470),
  dims=(1.700, 0.108, 0.020), mat="matte-black", imp=0.9, conf=0.92, role="lamp",
  evidence=["img-r7-rear"])
C("tail-light-bar", "贯穿式尾灯（全宽红光）", "meso", "box", "root", (0, 1.055, -2.484),
  dims=(1.660, 0.030, 0.014), mat="lamp-red", imp=1.0, conf=0.95, role="lamp",
  feats=[{"id": "d-tail-bar-red", "name": "贯穿红光标线", "kind": "emissive",
          "note": "全宽 1.66m 红光带 + 中央一道更亮的红线，刹车时整条加亮"}],
  evidence=["img-r7-rear"], det=["d-tail-bar-red"])
for s, side in ((1, "l"), (-1, "r")):
    C(f"tail-light-split-{side}", f"尾灯侧段（{'左' if s > 0 else '右'}）", "micro", "box", "root",
      (s * 0.790, 1.058, -2.372), dims=(0.085, 0.052, 0.230), mat="lamp-red",
      imp=0.85, conf=0.9, role="lamp", evidence=["img-r7-rear"])
C("lettering-luxeed", "LUXEED 字标", "micro", "plane-card", "root", (0, 0.995, -2.484),
  dims=(0.620, 0.078, 0.004), rot=(0, 3.14159, 0), mat="plate-mark", imp=0.9, conf=0.95, role="badge",
  feats=[{"id": "d-luxeed-lettering", "name": "L U X E E D 宽间距字标", "kind": "decal",
          "note": "6 字母宽字距排列，位于贯穿尾灯正下方（适配层 Canvas 绘制，仅文字性引用）"}],
  evidence=["img-r7-rear"], det=["d-luxeed-lettering"])
for s, side, text in ((1, "l", "奇瑞汽车"), (-1, "r", "智界R7")):
    C(f"badge-{side}", f"尾部铭牌（{text}）", "micro", "plane-card", "root",
      (s * 0.620, 0.860, -2.484), dims=(0.185, 0.040, 0.004), rot=(0, 3.14159, 0),
      mat="plate-mark", imp=0.65, conf=0.9, role="badge",
      evidence=["img-r7-rear"])
C("rear-bumper", "后保险杠（黑色下包围）", "meso", "extrude", "root", (0, 0.420, -2.382),
  dims=(1.80, 0.400, 0.098), rot=(0, 3.14159, 0), mat="matte-black", imp=0.9, conf=0.9, role="body",
  topo="conforming-shell", topoR="正视圆角矩形向 -Z 挤出 98mm 的黑色下包围",
  desc=extrude_desc(rrect(1.80, 0.40, 0.07), 0.098, bevel=0.01, seg=2, intent="rear bumper extrusion"),
  feats=[{"id": "d-rear-diffuser", "name": "扩散器 + 反光条", "kind": "groove",
          "note": "下包围中部扩散器凹槽，两侧各一条红色反光条"}],
  evidence=["img-r7-rear"], det=["d-rear-diffuser"])
C("rear-diffuser", "后扩散器", "meso", "extrude", "root", (0, 0.245, -2.404),
  dims=(1.10, 0.130, 0.070), rot=(0, 3.14159, 0), mat="matte-black", imp=0.7, conf=0.88, role="trim",
  topo="conforming-shell", topoR="扩散器凹槽挤出件",
  desc=extrude_desc(rrect(1.10, 0.13, 0.04), 0.070, bevel=0.006, seg=2, intent="diffuser recess"),
  evidence=["img-r7-rear"])
for s, side in ((1, "l"), (-1, "r")):
    C(f"rear-reflector-{side}", f"后反光条（{'左' if s > 0 else '右'}）", "micro", "box", "root",
      (s * 0.625, 0.318, -2.492), dims=(0.240, 0.030, 0.010), mat="lamp-red",
      imp=0.7, conf=0.9, role="lamp", evidence=["img-r7-rear"])
C("spoiler", "尾翼（鸭尾扰流板）", "meso", "extrude", "root", (0.67, 0, 0),
  dims=(1.34, 0.09, 0.20), rot=SIDE_ROT, mat="paint-green", imp=0.9, conf=0.9, role="body",
  topo="conforming-shell", topoR="侧视楔形薄板挤出，贴合溜背尾端",
  desc=extrude_desc(ccw([(-2.270, 1.322), (-2.410, 1.300), (-2.432, 1.262), (-2.330, 1.246),
                         (-2.240, 1.258), (-2.245, 1.300)]), 1.34, bevel=0.008, seg=2,
                    intent="duck-tail spoiler blade"),
  feats=[{"id": "d-spoiler-lip", "name": "鸭尾上翘", "kind": "ridge",
          "note": "尾端 y1.32 上翘唇口，后视图中尾门上方那道横向亮棱"}],
  evidence=["img-r7-rear", "img-r7-34"], det=["d-spoiler-lip"])
C("high-mount-brake", "高位刹车灯", "micro", "box", "root", (0, 1.315, -2.352),
  dims=(0.480, 0.016, 0.020), mat="lamp-red", imp=0.8, conf=0.9, role="lamp",
  evidence=["img-r7-rear"])

# ---- 玻璃舱 ----
WINDSHIELD = band([(0.980, 1.062), (0.700, 1.230), (0.470, 1.360), (0.340, 1.452)], 0.024)
C("windshield", "前挡玻璃", "meso", "extrude", "root", (0.89, 0, 0), dims=(1.78, 0.44, 0.66),
  rot=SIDE_ROT, mat="glass-clear", imp=0.95, conf=0.9, role="glass",
  topo="conforming-shell", topoR="侧视薄壳带挤出，前挡倾角 30°（相对水平面）",
  desc=extrude_desc(WINDSHIELD, 1.78, bevel=0.004, seg=1, intent="windshield shell band"),
  feats=[{"id": "d-windshield-rake", "name": "大倾角前挡", "kind": "contour",
          "note": "下沿 z0.98 y1.06 → 上沿 z0.34 y1.45，倾角约 30°，敞篷感舱口"}],
  evidence=["img-r7-front", "img-r7-top"], det=["d-windshield-rake"])

ROOF_TOP = [(0.340, 1.500), (0.100, 1.556), (-0.200, 1.598), (-0.600, 1.622),
            (-1.000, 1.618), (-1.350, 1.588), (-1.700, 1.520)]
C("roof-glass", "全景天幕玻璃", "meso", "extrude", "root", (0.89, 0, 0), dims=(1.78, 0.16, 2.06),
  rot=SIDE_ROT, mat="glass-dark", imp=0.95, conf=0.92, role="glass",
  topo="conforming-shell", topoR="侧视拱形薄壳带挤出，表达天幕的纵向弧面",
  desc=extrude_desc(band(ROOF_TOP, 0.030), 1.78, bevel=0.004, seg=1, intent="panoramic roof glass shell"),
  feats=[{"id": "d-panoramic-roof", "name": "大面积全景天幕", "kind": "gloss",
          "note": "前 0.34 → 后 -1.70 连续玻璃，顶视图中占车顶 70% 面积"}],
  evidence=["img-r7-top", "img-r7-34"], det=["d-panoramic-roof"])
for s, side in ((1, "l"), (-1, "r")):
    _rx, _rrot, _rprof = side_part(s, 0.948, 0.086, band([(z, y - 0.004) for z, y in ROOF_TOP], 0.048))
    C(f"roof-rail-{side}", f"车顶钣金边梁（{'左' if s > 0 else '右'}）", "meso", "extrude", "root",
      (_rx, 0, 0), dims=(0.086, 0.16, 2.08), rot=_rrot,
      mat="paint-green", imp=0.8, conf=0.9, role="body",
      topo="conforming-shell", topoR="天幕外缘的车漆边梁，按同一根拱线降低 4mm 以免与玻璃共面",
      desc=extrude_desc(_rprof, 0.086, bevel=0.006, seg=2, intent="roof side rail"),
      evidence=["img-r7-top", "img-r7-side"])
C("roof-header", "前顶横梁", "meso", "box", "root", (0, 1.496, 0.330),
  dims=(1.792, 0.046, 0.090), mat="paint-green", imp=0.75, conf=0.9, role="body",
  evidence=["img-r7-top"])
REAR_GLASS_TOP = [(-1.660, 1.522), (-1.900, 1.462), (-2.120, 1.392), (-2.300, 1.316), (-2.400, 1.246)]
C("rear-glass", "后挡玻璃（溜背斜面）", "meso", "extrude", "root", (0.89, 0, 0), dims=(1.78, 0.30, 0.76),
  rot=SIDE_ROT, mat="glass-dark", imp=0.95, conf=0.92, role="glass",
  topo="conforming-shell", topoR="溜背斜面薄壳带挤出，后挡与尾门夹角约 42°",
  desc=extrude_desc(band(REAR_GLASS_TOP, 0.026), 1.78, bevel=0.004, seg=1, intent="fastback rear glass shell"),
  feats=[{"id": "d-fastback-rear", "name": "溜背后挡", "kind": "contour",
          "note": "车顶 -1.66 起以 42° 斜落至尾门 y1.25，与侧视参考一致"}],
  evidence=["img-r7-rear", "img-r7-side"], det=["d-fastback-rear"])

SIDE_GLASS = ccw([
    (0.965, 1.094), (0.700, 1.250), (0.430, 1.412), (0.330, 1.466),
    (-0.200, 1.556), (-0.700, 1.582), (-1.100, 1.566), (-1.480, 1.502),
    (-1.760, 1.386), (-1.880, 1.262), (-1.880, 1.150), (-1.600, 1.108),
    (-0.900, 1.100), (-0.100, 1.098), (0.600, 1.096),
])
for s, side in ((1, "l"), (-1, "r")):
    _gx, _grot, _gprof = side_part(s, 0.918, 0.030, SIDE_GLASS)
    C(f"side-glass-{side}", f"侧窗玻璃带（{'左' if s > 0 else '右'}）", "meso", "extrude", "root",
      (_gx, 0, 0), dims=(0.030, 0.50, 2.86), rot=_grot,
      mat="glass-dark", imp=0.95, conf=0.9, role="glass",
      topo="conforming-shell", topoR="侧窗轮廓薄片挤出（30mm），只做窗面不封舱",
      desc=extrude_desc(_gprof, 0.030, bevel=0.004, seg=1, intent="side window pane extrusion"),
      feats=[{"id": f"d-dlo-{side}", "name": "窗框镀铬 + 后段上扬", "kind": "linework",
              "note": "窗下沿 y1.096→1.108 微扬，窗框镀铬饰条另件覆盖"}],
      evidence=["img-r7-side", "img-r7-34"], det=["d-dlo-l"])
    C(f"belt-chrome-{side}", f"窗下沿镀铬饰条（{'左' if s > 0 else '右'}）", "micro", "box", "root",
      (s * 0.930, 1.096, -0.480), dims=(0.014, 0.020, 2.700), mat="chrome",
      imp=0.85, conf=0.92, role="trim",
      evidence=["img-r7-side"], det=[f"d-dlo-{side}"])
    C(f"apillar-{side}", f"A 柱（{'左' if s > 0 else '右'}）", "meso", "box", "root",
      (s * 0.845, 1.268, 0.660), dims=(0.086, 0.740, 0.076), rot=(-1.048, 0, 0),
      mat="matte-black", imp=0.8, conf=0.9, role="body",
      evidence=["img-r7-front", "img-r7-dash"])
    C(f"bpillar-{side}", f"B 柱（{'左' if s > 0 else '右'}）", "micro", "box", "root",
      (s * 0.922, 1.330, 0.170), dims=(0.030, 0.470, 0.055), rot=(-0.08, 0, 0),
      mat="matte-black", imp=0.6, conf=0.88, role="body",
      evidence=["img-r7-side"], det=["d-pillar-black"])
    C(f"cpillar-{side}", f"C 柱（{'左' if s > 0 else '右'}）", "micro", "box", "root",
      (s * 0.922, 1.330, -1.420), dims=(0.030, 0.400, 0.075), rot=(-0.30, 0, 0),
      mat="matte-black", imp=0.6, conf=0.88, role="body",
      evidence=["img-r7-side"], det=["d-pillar-black"])
C("dpillar", "D 柱（溜背尾柱，车漆）", "meso", "extrude", "root", (0.89, 0, 0),
  dims=(1.78, 0.46, 0.50), rot=SIDE_ROT, mat="paint-green", imp=0.85, conf=0.88, role="body",
  topo="conforming-shell", topoR="侧视楔形薄壳挤出，封住后挡玻璃与侧窗之间的 D 柱面",
  desc=extrude_desc(ccw([(-1.760, 1.386), (-1.880, 1.262), (-1.880, 1.150), (-1.700, 1.108),
                         (-1.560, 1.180), (-1.600, 1.330)]), 1.78, bevel=0.008, seg=2,
                    intent="D-pillar wedge shell"),
  evidence=["img-r7-side", "img-r7-rear"])

# ---- 车顶激光雷达凸台 ----
C("roof-lidar", "车顶前中央激光雷达凸台", "meso", "extrude", "root", (0, 1.560, 0.060),
  dims=(0.190, 0.060, 0.150), mat="housing-dark", imp=0.9, conf=0.92, role="sensor",
  topo="assembled-solid", topoR="俯视圆角矩形凸台沿 +Y 挤出 62mm（rotX -90° 使挤出方向朝上）",
  desc=extrude_desc(rrect(0.19, 0.15, 0.035), 0.060, bevel=0.006, seg=2, intent="lidar pod"),
  feats=[{"id": "d-roof-lidar", "name": "顶置激光雷达凸台", "kind": "bevel",
          "note": "顶视图车顶前中央一个 19×15cm 凸台，是 R7 智驾版的身份特征"}],
  evidence=["img-r7-top"], det=["d-roof-lidar"])
COMPS[-1]["transform"]["rotation"] = [-1.5708, 0, 0]

# ---- 侧围细节 ----
for s, side in ((1, "l"), (-1, "r")):
    C(f"rocker-{side}", f"侧裙黑化护板（{'左' if s > 0 else '右'}）", "meso", "box", "root",
      (s * 0.938, 0.238, 0.020), dims=(0.066, 0.120, 2.240), mat="matte-black",
      imp=0.75, conf=0.9, role="body",
      feats=[{"id": f"d-rocker-{side}", "name": "门槛黑化条", "kind": "linework",
              "note": "轮拱之间的黑色侧裙，参考侧视图中车身下沿那道暗带"}],
      evidence=["img-r7-side"], det=[f"d-rocker-{side}"])
    C(f"mirror-body-{side}", f"外后视镜镜体（{'左' if s > 0 else '右'}）", "meso", "extrude", "root",
      (s * 0.916, 1.108, 0.742), dims=(0.140, 0.110, 0.210), rot=(0, 3.14159, 0),
      mat="paint-green", imp=0.85, conf=0.9, role="body",
      topo="conforming-shell", topoR="圆角矩形镜壳，rotY(π) 后向 -Z 挤出 10cm",
      desc=extrude_desc(rrect(0.140, 0.110, 0.03), 0.100, bevel=0.01, seg=2, intent="mirror housing"),
      evidence=["img-r7-34", "img-r7-front"])
    C(f"mirror-glass-{side}", f"后视镜镜片（{'左' if s > 0 else '右'}）", "micro", "box", "root",
      (s * 0.916, 1.108, 0.632), dims=(0.126, 0.092, 0.010), mat="chrome",
      imp=0.7, conf=0.88, role="glass", evidence=["img-r7-34"])
for s, side, zpos in ((1, "l", 0.560), (-1, "r", 0.560)):
    C(f"handle-front-{side}", f"隐藏式前门把手（{'左' if s > 0 else '右'}）", "micro", "box", "root",
      (s * 0.944, 0.988, zpos), dims=(0.014, 0.026, 0.190), mat="chrome",
      imp=0.7, conf=0.9, role="trim",
      feats=[{"id": f"d-flush-handle-f{side}", "name": "隐藏式门把手", "kind": "seam",
              "note": "与车身齐平的细长把手槽，凸出仅 6mm"}],
      evidence=["img-r7-34", "img-r7-side"], det=[f"d-flush-handle-f{side}"])
for s, side, zpos in ((1, "l", -0.760), (-1, "r", -0.760)):
    C(f"handle-rear-{side}", f"隐藏式后门把手（{'左' if s > 0 else '右'}）", "micro", "box", "root",
      (s * 0.944, 0.988, zpos), dims=(0.014, 0.026, 0.185), mat="chrome",
      imp=0.7, conf=0.9, role="trim",
      evidence=["img-r7-side"], det=[f"d-flush-handle-f{'l' if s > 0 else 'r'}"])

# ---- 轮拱黑色包边（半圆拱带，绝不整圆：整圆穿地会读作"轮底皮带"）----
for zc, tag in ((WHEEL_Z, "f"), (-WHEEL_Z, "r")):
    for s, side in ((1, "l"), (-1, "r")):
        outer_arc = arc(zc, WHEEL_Y, 0.500, 200, -20, 14)
        inner_arc = arc(zc, WHEEL_Y, 0.440, 200, -20, 14)
        cladding = outer_arc + list(reversed(inner_arc))
        _ax, _arot, _aprof = side_part(s, 0.990, 0.055, cladding)
        C(f"arch-{tag}{side}", f"{'前' if tag == 'f' else '后'}轮拱包边（{'左' if s > 0 else '右'}）",
          "meso", "extrude", "root", (_ax, 0, 0),
          dims=(0.055, 0.360, 0.980), rot=_arot, mat="matte-black",
          imp=0.85, conf=0.92, role="trim",
          topo="conforming-shell",
          topoR="半圆拱带（200°→-20°，内 r0.44 外 r0.50）挤出 55mm，只覆盖拱口上半，脚点 y0.17 不穿地",
          desc=extrude_desc(_aprof, 0.055, bevel=0.006, seg=2, intent="wheel arch cladding half-arc"),
          evidence=["img-r7-34", "img-r7-side"],
          det=["d-arch-cladding"])

# ---- 车轮总成 ----
TIRE_PROFILE = [(0.348, -0.500), (0.400, -0.498), (0.462, -0.470), (0.492, -0.420),
                (0.500, -0.360), (0.500, 0.360), (0.492, 0.420), (0.462, 0.470),
                (0.400, 0.498), (0.348, 0.500), (0.348, -0.500)]
RIM_PROFILE = [(0.0002, -0.500), (0.400, -0.500), (0.470, -0.470), (0.500, -0.400),
               (0.500, 0.400), (0.470, 0.470), (0.400, 0.500), (0.0002, 0.500)]
for zc, tag in ((WHEEL_Z, "f"), (-WHEEL_Z, "r")):
    for s, side in ((1, "l"), (-1, "r")):
        C(f"wheel-{tag}{side}", f"{'前' if tag == 'f' else '后'}{'左' if s > 0 else '右'}车轮（轮胎）",
          "meso", "lathe", "root", (s * 0.840, WHEEL_Y, zc),
          dims=(0.255, 0.766, 0.766), rot=(0, 0, 1.5708), scale=(0.766, 0.255, 0.766),
          mat="tire", imp=1.0, conf=0.95, role="wheel",
          topo="assembled-solid",
          topoR="回转胎体（环向断面 11 点，32 段），环内孔 r0.267 露出轮圈",
          desc=lathe_desc(TIRE_PROFILE, 32, intent="annular tire cross-section revolved about the axle"),
          feats=[{"id": f"d-tire-{tag}{side}", "name": "255/45 R21 轮胎", "kind": "contour",
                  "note": "外径 0.766m（r0.383），胎宽 0.255m；环内孔 r0.267 与 21 寸轮圈过盈 2mm"}],
          evidence=["img-r7-34", "img-r7-side"])
        # 轮子必须绕轴自转：单独补 actionProfile（C() 里 anim=None 时用 static）
        COMPS[-1]["actionProfile"] = spin_anim(
            [0, 0, 1],
            {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.255, 0.766, 0.766],
             "isTrigger": False, "notes": "旋转轴 = 局部 Z（lathe 轴经 rotZ90 转为世界 X）"})
        C(f"rim-{tag}{side}", f"{'前' if tag == 'f' else '后'}{'左' if s > 0 else '右'}轮圈",
          "meso", "lathe", f"wheel-{tag}{side}", (0, 0, 0),
          dims=(0.235, 0.5334, 0.5334), rot=(0, 0, 0), scale=(0.5334, 0.235, 0.5334),
          mat="wheel-alloy", imp=0.95, conf=0.92, role="wheel",
          topo="assembled-solid", topoR="回转盘体（半径 0.2667 = 21 寸），轴向继承父节点 rotZ(90°) 后指向世界 X",
          desc=lathe_desc(RIM_PROFILE, 32, intent="rim barrel and outboard flange"),
          evidence=["img-r7-34"])
        # 双十辐轮面：20 辐齿轮轮廓，外径 r0.264 恰好咬住胎内孔
        spokes = 20
        pts: list[tuple[float, float]] = []
        for i in range(spokes):
            a = 2 * math.pi * i / spokes
            for r, da in ((0.116, -0.085), (0.264, -0.030), (0.264, 0.030), (0.116, 0.085)):
                pts.append((r * math.cos(a + da), r * math.sin(a + da)))
        cog = ccw(pts)
        C(f"wheel-face-{tag}{side}", f"{'前' if tag == 'f' else '后'}{'左' if s > 0 else '右'}轮辐面（双十辐）",
          "meso", "extrude", f"wheel-{tag}{side}",
          (0, -s * 0.075, 0), dims=(0.050, 0.528, 0.528), rot=(s * 1.5708, 0, 0),
          mat="wheel-alloy", imp=0.98, conf=0.9, role="wheel",
          topo="surface-relief",
          topoR="20 辐齿轮轮廓挤出 50mm：辐条间开窗露盘内，中央实心盘径 r0.116",
          desc=extrude_desc(cog, 0.050, bevel=0.004, seg=1, intent="double-ten-spoke wheel face"),
          feats=[{"id": f"d-wheel-spokes-{tag}{side}", "name": "双十辐黑化轮圈", "kind": "bevel",
                  "note": "20 根 6° 宽辐条 + 12° 开窗，机加工亮边靠 bevel 0.004 出反光"}],
          evidence=["img-r7-34", "img-r7-side"])
        C(f"caliper-{tag}{side}", f"{'前' if tag == 'f' else '后'}{'左' if s > 0 else '右'}红色卡钳",
          "micro", "box", "root", (s * 0.884, 0.505, zc - 0.150),
          dims=(0.046, 0.190, 0.120), mat="caliper-red", imp=0.85, conf=0.9, role="wheel",
          feats=[{"id": f"d-caliper-{tag}{side}", "name": "红色刹车卡钳", "kind": "gloss",
                  "note": "轮辐开窗后可见的红色卡钳块，参考图 21 寸轮内的一抹红"}],
          evidence=["img-r7-34"], det=[f"d-caliper-{tag}{side}"])

# ================================================================ 2. 内饰
C("cabin-interior", "座舱容器（macro，几何退化为 2cm 薄片）", "macro", "plane-card", "root",
  (0, 0.0, 0.0), dims=(0.02, 0.02, 0.002), mat="matte-black", imp=0.5, conf=0.9, role="body",
  topo="material-only", topoR="纯容器节点：子件全部按世界坐标书写，故容器 position 必须归零（此处只留 2cm 退化片）",
  evidence=["img-r7-dash"])

# ---- 地板 / 仪表台 ----
FLOOR = ccw([(1.120, 0.310), (1.120, 0.272), (-1.640, 0.272), (-1.640, 0.310)])
C("cabin-floor", "座舱地板", "meso", "extrude", "cabin-interior", (0.890, 0, 0),
  dims=(1.78, 0.038, 2.76), rot=SIDE_ROT, mat="carpet", imp=0.5, conf=0.9, role="interior",
  topo="conforming-shell", topoR="地台薄板挤出（2.76×1.78m）",
  desc=extrude_desc(FLOOR, 1.78, bevel=0.004, seg=1, intent="cabin floor slab"),
  evidence=["img-r7-dash"])

DASH_UPPER = ccw([(0.995, 0.955), (0.995, 1.070), (0.960, 1.112), (0.780, 1.122),
                  (0.716, 1.062), (0.716, 0.955)])
C("dash-upper", "上仪表台（紫灰）", "meso", "extrude", "cabin-interior", (0.890, -0.160, 0),
  dims=(1.78, 0.167, 0.279), rot=SIDE_ROT, mat="leather-plum", imp=0.95, conf=0.92, role="interior",
  topo="conforming-shell", topoR="仪表台上体侧视断面挤出（横贯 1.78m），上缘带 12mm 圆角",
  desc=extrude_desc(DASH_UPPER, 1.78, bevel=0.010, seg=2, intent="upper dash pad"),
  feats=[{"id": "d-dash-two-tone", "name": "上紫灰 / 下米白 双色仪表台", "kind": "linework",
          "note": "分色线 y0.955，紫灰上体压住米白下体的上沿（参考主驾位内饰）"}],
  evidence=["img-r7-dash", "img-r7-pass"], det=["d-dash-two-tone"])
DASH_LOWER = ccw([(0.995, 0.955), (0.716, 0.955), (0.700, 0.900), (0.716, 0.740),
                  (0.995, 0.740)])
C("dash-lower", "下仪表台（米白）", "meso", "extrude", "cabin-interior", (0.890, -0.160, 0),
  dims=(1.78, 0.215, 0.295), rot=SIDE_ROT, mat="leather-ivory", imp=0.9, conf=0.9, role="interior",
  topo="conforming-shell", topoR="仪表台下体侧视断面挤出，膝部空间留 y0.74 以下",
  desc=extrude_desc(DASH_LOWER, 1.78, bevel=0.010, seg=2, intent="lower dash"),
  evidence=["img-r7-dash"])
C("dash-chrome-strip", "仪表台镀铬分色条", "micro", "box", "cabin-interior", (0, 0.848, 0.742),
  dims=(1.560, 0.012, 0.018), mat="chrome", imp=0.8, conf=0.9, role="trim",
  feats=[{"id": "d-dash-chrome", "name": "贯穿镀铬饰条", "kind": "gloss",
          "note": "紫灰/米白分色线上一条 1.56m 镀铬细条，副驾视图里最亮的一根水平线"}],
  evidence=["img-r7-pass"], det=["d-dash-chrome"])
C("dash-vent", "中央出风口（圆形）", "micro", "lathe", "cabin-interior", (0.0, 0.910, 0.700),
  dims=(0.088, 0.088, 0.030), rot=(1.5708, 0, 0), scale=(0.088, 0.030, 0.088),
  mat="bronze-dark", imp=0.7, conf=0.88, role="interior",
  topo="assembled-solid", topoR="圆形出风口：回转体（lathe）轴向朝 +Z",
  desc=lathe_desc([(0.0002, -0.5), (0.42, -0.5), (0.5, -0.40), (0.5, 0.40), (0.42, 0.5), (0.0002, 0.5)], 24,
                  intent="round air vent bezel"),
  feats=[{"id": "d-round-vent", "name": "圆形出风口 + 镀铬风量旋钮", "kind": "bevel",
          "note": "参考内饰图里仪表台中央的圆形出风口（含中央旋钮）"}],
  evidence=["img-r7-dash"], det=["d-round-vent"])

# ---- 屏幕 ----
C("center-screen", "15.6 寸悬浮中控屏", "meso", "plane-card", "cabin-interior", (0, 1.040, 0.716),
  dims=(0.345, 0.200, 0.006), rot=(-0.14, 0, 0), mat="screen-ui", imp=1.0, conf=0.95, role="screen",
  topo="material-only", topoR="纯显示面：横置 16:9 悬浮屏，靠 Canvas UI 贴图识别",
  feats=[{"id": "d-center-screen", "name": "横置悬浮 15.6 寸中控屏", "kind": "emissive",
          "note": "屏体上沿高出仪表台 6cm，向驾驶者倾斜 8°（参考主驾/副驾视图）"}],
  evidence=["img-r7-dash", "img-r7-pass"], det=["d-center-screen"])
C("center-screen-frame", "中控屏背框", "micro", "box", "cabin-interior", (0, 1.040, 0.700),
  dims=(0.365, 0.220, 0.014), rot=(-0.14, 0, 0), mat="matte-black", imp=0.6, conf=0.9, role="interior",
  evidence=["img-r7-dash"])
C("cluster-screen", "10.25 寸仪表屏", "meso", "plane-card", "cabin-interior", (0.360, 0.968, 0.792),
  dims=(0.227, 0.128, 0.005), rot=(-0.18, 0, 0), mat="gauge-ui", imp=0.95, conf=0.92, role="screen",
  topo="material-only", topoR="纯显示面：横条仪表，位于方向盘后、仪表台凹槽内",
  feats=[{"id": "d-cluster-screen", "name": "方向盘后 10.25 寸横条仪表", "kind": "emissive",
          "note": "屏体被方向盘上缘遮挡约 1/5，速度/踏板力/挡位由适配层 15Hz 重绘"}],
  evidence=["img-r7-dash"], det=["d-cluster-screen"])
C("rear-screen", "后排控制屏", "micro", "plane-card", "cabin-interior", (0, 0.760, -0.588),
  dims=(0.200, 0.115, 0.005), rot=(0.10, 3.14159, 0), mat="screen-ui", imp=0.7, conf=0.88, role="screen",
  topo="material-only", topoR="纯显示面：中岛后端向后排的小屏",
  evidence=["img-r7-rearseat"])

# ---- 方向盘 ----
C("steering", "双辐方向盘（紫真皮）", "meso", "torus", "cabin-interior", (0.360, 0.925, 0.640),
  dims=(0.400, 0.400, 0.050), rot=(0.32, 0, 0), scale=(0.400, 0.400, 0.130),
  mat="leather-plum", imp=0.95, conf=0.92, role="steer",
  topo="assembled-solid", topoR="圆环体（torus：环半径 0.45×0.40=0.18m）绕 X 倾斜 18°",
  desc={"topologyIntent": "steering rim torus", "torusTubeRatio": 0.20,
        "edgeTreatment": {"type": "rounded", "bevelRadius": 0.01, "segments": 2},
        "deformationStack": [], "uvStrategy": "generated procedural coordinates",
        "normalStrategy": "vertex normals from generated geometry"},
  anim={**static_anim(0.92), "animationRole": "steer",
        "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.9},
        "transformChannels": {**static_anim()["transformChannels"], "rotate": True}},
  feats=[{"id": "d-steer-double-spoke", "name": "双辐方向盘 + 米白中央板", "kind": "bevel",
          "note": "3/9 点两辐横条，中央盾形标座为米白真皮包覆（参考主驾位）"}],
  evidence=["img-r7-dash"], det=["d-steer-double-spoke"])
C("steering-hub", "方向盘中央板（米白）", "meso", "lathe", "steering", (0, 0, 0.004),
  dims=(0.200, 0.045, 0.200), rot=(1.5708, 0, 0), scale=(0.200, 0.045, 0.200),
  mat="leather-ivory", imp=0.9, conf=0.9, role="steer",
  topo="assembled-solid", topoR="中央板回转体（r0.10m），轴向 +Z",
  desc=lathe_desc([(0.0002, -0.5), (0.40, -0.5), (0.5, -0.35), (0.5, 0.35), (0.40, 0.5), (0.0002, 0.5)], 24,
                  intent="steering hub disc"),
  evidence=["img-r7-dash"], det=["d-steer-double-spoke"])
C("steering-badge", "方向盘盾形标", "micro", "plane-card", "steering", (0, 0.010, -0.036),
  dims=(0.062, 0.078, 0.004), rot=(0, 3.14159, 0), mat="chrome", imp=0.75, conf=0.88, role="badge",
  evidence=["img-r7-dash"])
C("pedal-brake", "制动踏板", "micro", "box", "cabin-interior", (0.440, 0.360, 1.020),
  dims=(0.080, 0.150, 0.020), rot=(-0.30, 0, 0), mat="pedal-metal", imp=0.6, conf=0.85, role="interior",
  evidence=["img-r7-dash"])
C("pedal-accel", "加速踏板", "micro", "box", "cabin-interior", (0.300, 0.340, 1.030),
  dims=(0.060, 0.190, 0.018), rot=(-0.36, 0, 0), mat="pedal-metal", imp=0.6, conf=0.85, role="interior",
  evidence=["img-r7-dash"])

# ---- 中岛 ----
CONSOLE = ccw([(0.600, 0.660), (0.600, 0.300), (-0.480, 0.300), (-0.520, 0.360),
               (-0.520, 0.660)])
C("center-console", "中央通道岛台（米白）", "meso", "extrude", "cabin-interior", (0.170, 0, 0),
  dims=(0.340, 0.360, 1.120), rot=SIDE_ROT, mat="leather-ivory", imp=0.85, conf=0.9, role="interior",
  topo="conforming-shell", topoR="中岛侧视断面挤出 0.34m 宽，前高后低",
  desc=extrude_desc(CONSOLE, 0.340, bevel=0.012, seg=2, intent="center console body"),
  feats=[{"id": "d-console-island", "name": "悬浮中岛 + 无线充", "kind": "linework",
          "note": "中岛顶面 y0.66 略低于坐垫，前段斜置充电板"}],
  evidence=["img-r7-dash"], det=["d-console-island"])
C("console-armrest", "中岛紫灰扶手", "meso", "extrude", "cabin-interior", (0.160, 0, 0),
  dims=(0.320, 0.090, 0.400), rot=SIDE_ROT, mat="leather-plum", imp=0.8, conf=0.9, role="interior",
  topo="conforming-shell", topoR="扶手断面挤出 0.32m 宽，顶面 y0.75",
  desc=extrude_desc(ccw([(-0.100, 0.752), (-0.100, 0.700), (-0.500, 0.700), (-0.520, 0.752)]),
                    0.320, bevel=0.012, seg=2, intent="console armrest pad"),
  evidence=["img-r7-rearseat"])

# ---- 座椅（靠背在 +Z 端 → rotY(π) 不适用：本 spec 直接用世界坐标摆位）----
SEAT_CUSHION = ccw([(0.335, 0.600), (0.240, 0.612), (0.060, 0.600), (-0.180, 0.596),
                    (-0.245, 0.552), (-0.238, 0.452), (-0.180, 0.418), (0.060, 0.410),
                    (0.250, 0.424), (0.335, 0.478)])
SEAT_BACK = ccw([(-0.150, 0.590), (-0.196, 0.700), (-0.238, 0.880), (-0.262, 1.020),
                 (-0.180, 1.048), (-0.096, 0.900), (-0.058, 0.700), (-0.052, 0.590)])
for s, side, seat in ((1, "l", "driver"), (-1, "r", "passenger")):
    x = s * 0.360
    C(f"seat-{seat}-cushion", f"{'主驾' if s > 0 else '副驾'}坐垫（米白）", "meso", "extrude",
      "cabin-interior", (side_x(s, 0.610, 0.500), 0, 0), dims=(0.500, 0.200, 0.580), rot=SIDE_ROT,
      mat="leather-ivory", imp=0.9, conf=0.9, role="interior",
      topo="conforming-shell", topoR="坐垫侧视断面挤出 0.50m 宽，坐面高 y0.60（H 点口径）；挤出恒朝 -x，右侧节点取内缘",
      desc=extrude_desc(SEAT_CUSHION, 0.500, bevel=0.018, seg=3, intent="seat cushion"),
      feats=[{"id": f"d-seat-quilt-{seat}", "name": "米白座椅缝线分块", "kind": "stitch",
              "note": "坐垫/靠背各 3 道纵向缝线，由适配层菱格贴图表达"}],
      evidence=["img-r7-rearseat", "img-r7-dash"], det=[f"d-seat-quilt-{seat}"])
    C(f"seat-{seat}-back", f"{'主驾' if s > 0 else '副驾'}靠背（米白）", "meso", "extrude",
      "cabin-interior", (side_x(s, 0.610, 0.500), 0, 0), dims=(0.500, 0.470, 0.300), rot=SIDE_ROT,
      mat="leather-ivory", imp=0.9, conf=0.9, role="interior",
      topo="conforming-shell", topoR="靠背侧视断面挤出（后倾 22°），顶端 y1.048（+Z 端为靠背背侧）",
      desc=extrude_desc(SEAT_BACK, 0.500, bevel=0.016, seg=3, intent="seat backrest"),
      evidence=["img-r7-dash", "img-r7-rearseat"], det=[f"d-seat-quilt-{seat}"])
    C(f"seat-{seat}-headrest", f"{'主驾' if s > 0 else '副驾'}头枕（浅色）", "meso", "box",
      "cabin-interior", (x, 1.152, -0.196), dims=(0.300, 0.170, 0.120), rot=(-0.26, 0, 0),
      mat="leather-ivory", imp=0.85, conf=0.9, role="interior",
      feats=[{"id": f"d-headrest-{seat}", "name": "浅色一体式头枕", "kind": "bevel",
              "note": "头枕前倾 15°，参考后排图里米白头枕的圆角轮廓"}],
      evidence=["img-r7-rearseat"], det=[f"d-headrest-{seat}"])

REAR_CUSHION = ccw([(0.300, 0.585), (0.180, 0.596), (-0.060, 0.592), (-0.300, 0.586),
                    (-0.360, 0.540), (-0.352, 0.452), (-0.300, 0.420), (-0.060, 0.414),
                    (0.190, 0.420), (0.300, 0.470)])
REAR_BACK = ccw([(-0.290, 0.580), (-0.336, 0.700), (-0.372, 0.880), (-0.392, 1.000),
                 (-0.310, 1.024), (-0.238, 0.880), (-0.208, 0.700), (-0.202, 0.580)])
C("seat-rear-cushion", "后排坐垫（一体式长凳）", "meso", "extrude", "cabin-interior", (0.720, 0, -0.720),
  dims=(1.440, 0.180, 0.660), rot=SIDE_ROT, mat="leather-ivory", imp=0.9, conf=0.9, role="interior",
  topo="conforming-shell", topoR="后排长凳坐垫断面挤出 1.44m 宽",
  desc=extrude_desc(REAR_CUSHION, 1.440, bevel=0.018, seg=3, intent="rear bench cushion"),
  feats=[{"id": "d-rear-bench", "name": "一体式长凳", "kind": "stitch",
          "note": "坐垫面 y0.59，长 1.44m，中间无明显断开（参考后排图）"}],
  evidence=["img-r7-rearseat"], det=["d-rear-bench"])
C("seat-rear-back", "后排靠背", "meso", "extrude", "cabin-interior", (0.720, 0, -0.720),
  dims=(1.440, 0.440, 0.200), rot=SIDE_ROT, mat="leather-ivory", imp=0.9, conf=0.9, role="interior",
  topo="conforming-shell", topoR="后排靠背断面挤出，后倾 18°，顶端 y1.024",
  desc=extrude_desc(REAR_BACK, 1.440, bevel=0.016, seg=3, intent="rear bench backrest"),
  evidence=["img-r7-rearseat"], det=["d-rear-bench"])
for s, side in ((1, "l"), (-1, "r")):
    C(f"headrest-rear-{side}", f"后排头枕（{'左' if s > 0 else '右'}）", "micro", "box", "cabin-interior",
      (s * 0.430, 1.108, -1.020), dims=(0.280, 0.160, 0.112), rot=(-0.20, 0, 0),
      mat="leather-ivory", imp=0.7, conf=0.88, role="interior",
      evidence=["img-r7-rearseat"], det=["d-headrest-rear"])

# ---- 门内饰（米白门板 + 紫灰上沿 + 网罩扬声器）----
for s, side in ((1, "l"), (-1, "r")):
    C(f"door-card-front-{side}", f"前门内饰板（{'左' if s > 0 else '右'}）", "meso", "box", "cabin-interior",
      (s * 0.878, 0.740, 0.610), dims=(0.050, 0.620, 0.620), mat="leather-ivory",
      imp=0.85, conf=0.9, role="interior",
      feats=[{"id": f"d-door-two-tone-{side}", "name": "米白门板 + 紫灰上沿", "kind": "linework",
              "note": "门板 y0.96 以上紫灰、以下米白，分界处一条镀铬饰条"}],
      evidence=["img-r7-pass", "img-r7-rearseat"], det=[f"d-door-two-tone-{side}"])
    C(f"door-card-rear-{side}", f"后门内饰板（{'左' if s > 0 else '右'}）", "meso", "box", "cabin-interior",
      (s * 0.878, 0.740, -0.780), dims=(0.050, 0.620, 1.000), mat="leather-ivory",
      imp=0.85, conf=0.9, role="interior",
      evidence=["img-r7-rearseat"], det=[f"d-door-two-tone-{side}"])
    C(f"door-trim-front-{side}", f"前门紫灰上沿（{'左' if s > 0 else '右'}）", "micro", "box",
      "cabin-interior", (s * 0.868, 0.992, 0.610), dims=(0.055, 0.120, 0.620),
      mat="leather-plum", imp=0.75, conf=0.9, role="interior", evidence=["img-r7-pass"])
    C(f"door-trim-rear-{side}", f"后门紫灰上沿（{'左' if s > 0 else '右'}）", "micro", "box",
      "cabin-interior", (s * 0.868, 0.992, -0.780), dims=(0.055, 0.120, 1.000),
      mat="leather-plum", imp=0.75, conf=0.9, role="interior", evidence=["img-r7-rearseat"])
    C(f"door-speaker-front-{side}", f"前门扬声器网罩（{'左' if s > 0 else '右'}）", "micro", "plane-card",
      "cabin-interior", (s * 0.852, 0.600, 0.740), dims=(0.190, 0.260, 0.005),
      rot=(0, s * -1.5708, 0), mat="speaker-lattice", imp=0.6, conf=0.88, role="interior",
      feats=[{"id": f"d-speaker-mesh-{side}", "name": "白色网格扬声器罩", "kind": "hole",
              "note": "门板下部 19×26cm 白色冲孔网罩（后排参考图最明显）"}],
      evidence=["img-r7-rearseat"], det=[f"d-speaker-mesh-{side}"])
    C(f"door-speaker-rear-{side}", f"后门扬声器网罩（{'左' if s > 0 else '右'}）", "micro", "plane-card",
      "cabin-interior", (s * 0.852, 0.600, -0.640), dims=(0.190, 0.260, 0.005),
      rot=(0, s * -1.5708, 0), mat="speaker-lattice", imp=0.6, conf=0.88, role="interior",
      evidence=["img-r7-rearseat"], det=[f"d-speaker-mesh-{side}"])

# ---- A/B 柱内饰 + 顶棚 + 遮阳板 + 后视镜 ----
for s, side in ((1, "l"), (-1, "r")):
    C(f"apillar-inner-{side}", f"A 柱内饰（{'左' if s > 0 else '右'}）", "meso", "box", "cabin-interior",
      (s * 0.826, 1.268, 0.664), dims=(0.070, 0.730, 0.080), rot=(-1.048, 0, 0),
      mat="leather-ivory", imp=0.75, conf=0.9, role="interior",
      feats=[{"id": f"d-apillar-ivory-{side}", "name": "白色 A 柱", "kind": "linework",
              "note": "副驾视图里 A 柱内侧为米白皮革包覆"}],
      evidence=["img-r7-pass"], det=[f"d-apillar-ivory-{side}"])
C("headliner", "顶棚（米白麂皮）", "meso", "extrude", "cabin-interior", (0.860, 0, 0),
  dims=(1.72, 0.030, 2.10), rot=SIDE_ROT, mat="suede-ivory", imp=0.8, conf=0.9, role="interior",
  topo="conforming-shell", topoR="顶棚薄板挤出，跟随天幕下表面（y1.52-1.56）",
  desc=extrude_desc(ccw([(0.340, 1.470), (-0.200, 1.556), (-0.700, 1.560), (-1.260, 1.520),
                         (-1.560, 1.470), (-1.560, 1.492), (-1.240, 1.545), (-0.700, 1.585),
                         (-0.200, 1.580), (0.340, 1.494)]), 1.72, bevel=0.006, seg=1,
                    intent="headliner panel"),
  evidence=["img-r7-pass", "img-r7-rearseat"])
for s, side in ((1, "l"), (-1, "r")):
    C(f"sun-visor-{side}", f"遮阳板（{'左' if s > 0 else '右'}）", "micro", "box", "cabin-interior",
      (s * 0.400, 1.492, 0.420), dims=(0.340, 0.030, 0.170), rot=(0.10, 0, 0),
      mat="leather-ivory", imp=0.5, conf=0.85, role="interior", evidence=["img-r7-pass"])
C("rear-view-mirror", "车内后视镜", "micro", "box", "cabin-interior", (0.0, 1.462, 0.470),
  dims=(0.260, 0.075, 0.038), rot=(0.06, 0, 0), mat="matte-black", imp=0.6, conf=0.88, role="interior",
  feats=[{"id": "d-interior-mirror", "name": "内后视镜 + 顶部模组", "kind": "bevel",
          "note": "内后视镜位于前顶横梁下 12cm（参考副驾视图顶部的后视镜与 ADAS 模组）"}],
  evidence=["img-r7-pass"], det=["d-interior-mirror"])
for s, side in ((1, "l"), (-1, "r")):
    C(f"ambient-strip-{side}", f"氛围灯带（{'左' if s > 0 else '右'}）", "micro", "box", "cabin-interior",
      (s * 0.430, 0.948, 0.716), dims=(0.760, 0.008, 0.008), mat="ambient",
      imp=0.55, conf=0.85, role="interior",
      feats=[{"id": f"d-ambient-{side}", "name": "仪表台下沿氛围灯", "kind": "emissive",
              "note": "紫/冷白氛围光带，沿仪表台下沿与门板分色线走"}],
      evidence=["img-r7-dash"], det=[f"d-ambient-{side}"])

# ================================================================ 3. 重复系统

REPS = [
    {
        "id": "steering-spokes",
        "level": "micro",
        "parent": "steering",
        "count": 2,
        "primitive": "box",
        "material": "leather-ivory",
        "instanceScale": [0.200, 0.062, 0.026],
        "placement": {"mode": "radial", "axis": [0, 0, 1], "radius": 0.230, "startAngleDeg": 90},
        "notes": "双辐横条（3/9 点）：radius 0.23 → 实例中心距 0.115，长 0.20 → 内端 0.015（埋入中央板 r0.10）、外端 0.215（咬进轮缘内缘 0.148）",
    },
]

# ================================================================ 4. 写回 spec

spec = json.loads(SP.read_text(encoding="utf-8"))

spec["targetName"] = "Luxeed R7"
spec["targetId"] = "luxeed-r7-suv"
spec["sourceImage"] = "<clipboard>/clipboard-2026-10-18T16-36-37-110Z-ed6b05ea.jpg"
spec["suitability"] = "conditional"
spec["scores"] = {
    "object_isolation": 3, "silhouette_readability": 3, "depth_inference": 2,
    "primitive_decomposition": 3, "material_procedurality": 3, "occlusion_risk": 1,
    "interaction_fit": 3,
}
spec["coordinateFrame"] = {
    "front": "+Z (vehicle nose)",
    "up": "+Y",
    "scaleReference": {
        "length": 4.956, "width": 1.981, "height": 1.634, "wheelbase": 2.950,
        "track": 1.680, "tire": "255/45 R21 (r=0.383)", "units": "m",
        "note": "与尊界 V800 spec 完全同源；车宽口径含轮眉包边 (|x|=0.990)，不含后视镜",
    },
    "units": "meters",
    "note": "左舵驾驶位在 +X 侧（+Z 朝前时左侧为 +X）；集成层 body.rotation.y=π 适配游戏 -Z 前进方向",
}
spec["viewEvidence"] = [
    {"id": "img-r7-34", "view": "front-34-left",
     "sourceImage": "<clipboard>/clipboard-2026-10-18T16-36-37-110Z-ed6b05ea.jpg",
     "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0, "units": "normalized"},
     "observations": ["墨绿金属漆在侧面出青绿 flop", "黑色轮眉包边", "21 寸黑双十辐 + 红卡钳",
                      "隐藏式门把手", "镀铬窗框", "溜背 SUV 比例（长悬/低顶/尾段下压）"],
     "confidence": 0.92},
    {"id": "img-r7-rear", "view": "rear",
     "sourceImage": "<clipboard>/clipboard-2026-10-18T16-36-37-114Z-204fc904.jpg",
     "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0, "units": "normalized"},
     "observations": ["贯穿式烟熏尾灯 + 中央一道更亮红线", "LUXEED 宽字距字标", "左下「奇瑞汽车」右下「智界R7」",
                      "黑色下包围 + 扩散器 + 两侧反光条", "尾翼 + 高位刹车灯", "鸭尾上翘"],
     "confidence": 0.95},
    {"id": "img-r7-side", "view": "side-right",
     "sourceImage": "<clipboard>/clipboard-2026-10-18T16-36-37-116Z-2b335afd.jpg",
     "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0, "units": "normalized"},
     "observations": ["长悬、低顶、车顶后段持续下压的溜背线", "窗线后段微扬", "门缝把侧面分成前后门 + 后翼子板",
                      "腰线在后门处抬高"],
     "confidence": 0.93},
    {"id": "img-r7-front", "view": "front",
     "sourceImage": "<clipboard>/clipboard-2026-10-18T16-36-37-118Z-9bdf2000.jpg",
     "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0, "units": "normalized"},
     "observations": ["贯穿式镀铬饰条 + 细长 LED 光带横贯全宽", "两侧 C 形大灯内 3 颗投影 + 点阵镀铬带",
                      "盾形车标居中", "下方三段式黑色进气", "两侧竖向导流口"],
     "confidence": 0.95},
    {"id": "img-r7-top", "view": "top",
     "sourceImage": "<clipboard>/clipboard-2026-10-18T16-36-37-120Z-ecb4c491.png",
     "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0, "units": "normalized"},
     "observations": ["大面积全景天幕占车顶约 70%", "车顶前中央激光雷达凸台", "座舱前部双屏（中控 + 仪表）",
                      "车身俯视前后收窄（前 0.03 / 尾 0.03 收腰）"],
     "confidence": 0.9},
    {"id": "img-r7-dash", "view": "cabin-driver",
     "sourceImage": "<clipboard>/clipboard-2026-10-18T16-36-37-122Z-4e9b2642.jpg",
     "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0, "units": "normalized"},
     "observations": ["紫灰上仪表台 + 米白下仪表台", "悬浮横置 15.6\" 中控屏 + 方向盘后 10.25\" 仪表屏",
                      "双辐紫真皮方向盘 + 米白中央板 + 盾形标", "圆形出风口带中央旋钮", "贯穿镀铬饰条"],
     "confidence": 0.95},
    {"id": "img-r7-pass", "view": "cabin-passenger",
     "sourceImage": "<clipboard>/clipboard-2026-10-18T16-36-37-125Z-3f4aa2c4.jpg",
     "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0, "units": "normalized"},
     "observations": ["白色 A 柱与顶棚", "紫色门板上沿", "仪表台镀铬分色饰条", "顶棚前横梁下的内后视镜模组"],
     "confidence": 0.93},
    {"id": "img-r7-rearseat", "view": "cabin-rear",
     "sourceImage": "<clipboard>/clipboard-2026-10-18T16-36-37-127Z-8419d144.jpg",
     "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0, "units": "normalized"},
     "observations": ["米白座椅背 + 浅色一体式头枕", "门板上白色网格扬声器罩 + 紫色扶手", "紫色上沿",
                      "后排小屏挂在前排座椅背"],
     "confidence": 0.9},
]

spec["featureReviewTargets"] = [
    {"id": "r7-fastback-proportion", "name": "溜背 SUV 轮廓与轴距/悬长比例", "tier": "critical",
     "passIds": ["blockout"], "minimumScore": 0.8, "mustPass": True,
     "componentRefs": ["body-lower", "roof-glass", "rear-glass", "hood", "spoiler"],
     "evidenceRefs": ["img-r7-side", "img-r7-34"]},
    {"id": "r7-front-signature", "name": "前脸身份：贯穿镀铬饰条 + C 形大灯 + 盾标 + 三段式进气",
     "tier": "critical", "passIds": ["structural-pass"], "minimumScore": 0.8, "mustPass": True,
     "componentRefs": ["front-fascia", "light-bar-front", "headlamp-l", "headlamp-r",
                       "logo-shield", "front-intake", "drl-strip-l", "drl-strip-r"],
     "evidenceRefs": ["img-r7-front"]},
    {"id": "r7-rear-signature", "name": "尾部身份：贯穿烟熏尾灯 + LUXEED 字标 + 扩散器 + 鸭尾",
     "tier": "critical", "passIds": ["structural-pass"], "minimumScore": 0.8, "mustPass": True,
     "componentRefs": ["tailgate", "tail-light-bar", "lettering-luxeed", "rear-bumper",
                       "rear-diffuser", "spoiler", "high-mount-brake"],
     "evidenceRefs": ["img-r7-rear"]},
    {"id": "r7-wheel-identity", "name": "21 寸双十辐轮圈 + 红卡钳 + 黑色轮眉",
     "tier": "critical", "passIds": ["material-pass"], "minimumScore": 0.78, "mustPass": True,
     "componentRefs": ["wheel-face-fl", "caliper-fl", "arch-fl", "rim-fl"],
     "evidenceRefs": ["img-r7-34"]},
    {"id": "r7-interior-two-tone", "name": "双色内饰：紫灰上体 / 米白下体 + 横置悬浮屏 + 双辐方向盘",
     "tier": "critical", "passIds": ["lighting-pass"], "minimumScore": 0.78, "mustPass": True,
     "componentRefs": ["dash-upper", "dash-lower", "center-screen", "cluster-screen", "steering",
                       "steering-hub"],
     "evidenceRefs": ["img-r7-dash", "img-r7-pass"]},
]

spec["qualityTargets"] = {
    "targetFidelity": 0.85,
    "mustMatch": [
        "溜背 SUV 侧面比例（长悬/低顶/尾段下压）",
        "墨绿金属漆 clearcoat 响应",
        "贯穿式前镀铬饰条 + C 形大灯",
        "贯穿式烟熏尾灯 + LUXEED 字标",
        "21 寸黑双十辐轮圈 + 红色卡钳",
        "双色内饰（紫灰上 + 米白下）+ 横置悬浮中控屏",
    ],
    "niceToHave": ["门缝表达", "激光雷达凸台细节", "室内氛围灯带", "座椅缝线分块"],
    "fpsTarget": 60,
    "reviewViewpoints": ["side-left", "front-34", "rear", "cabin-driver", "cabin-passenger", "cabin-rear"],
}

spec["performanceBudget"] = {
    "qualityPriority": "balanced",
    "targetTriangles": 45000,
    "maxDrawCalls": 60,
    "textureSize": 1024,
    "fpsTarget": 60,
    "optimizationPolicy": "instanced repetition + shared materials + 适配层静态合批（batchMergeStatic）",
    "drawCallScope": "整车可见 mesh；不含 Road/shadow/postprocess。整帧红线 150（docs/PERF.md 口径）",
}

spec["qualityContract"]["minimumSpecDepth"] = {
    "macroComponents": 3, "mesoComponents": 30, "microFeatureGroups": 12,
    "materialLayers": 20, "repetitionSystems": 1, "reviewViewpoints": 6,
}
spec["qualityContract"]["qualityBar"] = "complex"
spec["qualityContract"]["featureGroups"] = [
    {"id": "fastback-silhouette", "name": "溜背 SUV 轮廓与比例", "required": True,
     "qualityCriteria": ["侧视：长 4.956 / 高 1.634 / 轴距 2.95 的比例可量；车顶后段从 -1.0 起持续下压到尾部 y≈1.25"],
     "evidenceRefs": ["img-r7-side", "img-r7-34"], "failureModes": ["读作方正 MPV", "车顶后段不下压"]},
    {"id": "front-identity", "name": "前脸身份包（贯穿饰条/C 形大灯/盾标）", "required": True,
     "qualityCriteria": ["全宽镀铬饰条与两侧 LED 光带同高（y≈0.86）", "每侧大灯内 3 颗投影镜芯", "盾形标居中于机盖前缘"],
     "evidenceRefs": ["img-r7-front"], "failureModes": ["大灯读作一个大方块", "缺贯穿饰条"]},
    {"id": "rear-identity", "name": "尾部身份包（贯穿尾灯/LUXEED/扩散器）", "required": True,
     "qualityCriteria": ["尾灯全宽 1.66m 红光带居中于 y≈1.06", "LUXEED 字标在灯下 6cm", "黑色下包围占尾部下 1/3"],
     "evidenceRefs": ["img-r7-rear"], "failureModes": ["尾灯分段不贯穿", "缺字标"]},
    {"id": "interior-two-tone", "name": "双色内饰与横置屏", "required": True,
     "qualityCriteria": ["紫灰上体 / 米白下体分色线 y≈0.955", "中控屏横置悬浮高出仪表台 6cm",
                         "方向盘双辐 + 米白中央板"],
     "evidenceRefs": ["img-r7-dash", "img-r7-pass"], "failureModes": ["内饰单一颜色", "屏竖置"]},
    {"id": "wheel-identity", "name": "21 寸双十辐轮圈 + 红卡钳", "required": True,
     "qualityCriteria": ["20 根辐条开窗可透光", "卡钳在轮辐开窗后可见", "轮眉黑色包边只在拱口上半"],
     "evidenceRefs": ["img-r7-34"], "failureModes": ["轮圈读作实心黑饼", "整圆轮眉穿地"]},
]
spec["qualityContract"]["mustNotDo"] = [
    "不得把玻璃改成 transmission（整帧 DC 翻倍）",
    "不得用实心盒当 macro 容器后忘记隐藏",
    "不得让轮眉包边成为整圆环（整圆会穿地读作轮底皮带）",
]
spec["qualityContract"]["antiShallowSpecRules"] = [
    "每个 identity 组件必须有 localFeatures 与 colorMaterialRecipe",
    "detailInventory 每条细节必须落到某个 localFeatures.id",
]
spec["qualityContract"]["visualDeltaChecks"] = [
    "五机位包围盒 vs 4.956×1.634×1.981",
    "四轮外缘 |x| ≤ 0.99、地面 y ≥ -0.005",
]
spec["qualityContract"]["definitionOfDone"] = [
    "整车包围盒 4.956（长）×1.981（宽）×1.634（高）误差 <3%",
    "五机位渲染与参考图并排可读出溜背比例、前脸贯穿饰条、尾部贯穿尾灯、双色内饰",
    "组件数 ≤130、几何三角和 ≤45,000、合批后可见 DC ≤60",
    "R7Adapter 实现 CarLike 全部方法且 tsc 0 error",
]

# 预审：把 assessment 与本次实测的口径回写（detailInventory 每条都必须落到 localFeatures.id）
FEATURE_INDEX = {f.get("id") for c in COMPS for f in (c.get("localFeatures") or []) if isinstance(f, dict)}
_details = [
    ("d-paint-metallic-flop", "gloss", "墨绿金属漆 clearcoat flop", "paint-green"),
    ("d-arch-cladding", "hole", "轮拱黑色包边半圆带", "d-arch-cladding"),
    ("d-beltline-rise", "contour", "腰线后扬", "d-beltline-rise"),
    ("d-full-width-blade", "linework", "前脸全宽镀铬饰条", "d-full-width-blade"),
    ("d-headlamp-c", "bevel", "C 形大灯楔形灯罩", "d-headlamp-c"),
    ("d-shield-badge", "bevel", "车头盾形标", "d-shield-badge"),
    ("d-intake-three-part", "groove", "三段式下进气", "d-intake-three-part"),
    ("d-tail-bar-red", "emissive", "贯穿尾灯红光标线", "d-tail-bar-red"),
    ("d-luxeed-lettering", "decal", "LUXEED 字标", "d-luxeed-lettering"),
    ("d-spoiler-lip", "ridge", "鸭尾上翘唇口", "d-spoiler-lip"),
    ("d-panoramic-roof", "gloss", "全景天幕", "d-panoramic-roof"),
    ("d-roof-lidar", "bevel", "顶置激光雷达凸台", "d-roof-lidar"),
    ("d-flush-handle-fl", "seam", "隐藏式门把手", "d-flush-handle-fl"),
    ("d-caliper-fl", "gloss", "红色刹车卡钳", "d-caliper-fl"),
    ("d-wheel-spokes-fl", "bevel", "双十辐轮辐", "d-wheel-spokes-fl"),
    ("d-dash-two-tone", "linework", "上紫灰/下米白分色线", "d-dash-two-tone"),
    ("d-center-screen", "emissive", "15.6 寸悬浮中控屏", "d-center-screen"),
    ("d-steer-double-spoke", "bevel", "双辐方向盘", "d-steer-double-spoke"),
    ("d-round-vent", "bevel", "圆形出风口", "d-round-vent"),
    ("d-rear-bench", "stitch", "后排一体式长凳", "d-rear-bench"),
    ("d-speaker-mesh-l", "hole", "白色网格扬声器罩", "d-speaker-mesh-l"),
    ("d-dlo-l", "linework", "窗框镀铬 + 后段上扬", "d-dlo-l"),
]
detail_items = []
for did, kind, note, ref in _details:
    detail_items.append({
        "id": did, "kind": kind, "zone": "exterior" if kind in {"hole", "linework", "bevel", "groove",
                                                               "emissive", "decal", "ridge", "contour",
                                                               "gloss", "seam"} else "interior",
        "note": note,
        "mapsTo": {"ref": ref if ref in FEATURE_INDEX else "paint-green"},
    })
assessment = spec.get("preSpecAssessment", {})
assessment["objectClass"] = {
    "primaryType": "vehicle",
    "primaryDomain": "object",
    "formLanguage": ["fastback SUV", "flush surfaces", "two-tone interior", "full-width light signatures"],
    "structureKind": ["shell + glass panes + 4 wheel assemblies + cabin modules"],
    "motionPotential": ["wheel spin", "brake light modulation", "steering rotation", "pedal throw"],
    "materialFamilies": ["metallic clearcoat paint", "privacy glass", "matte cladding",
                         "matte alloy wheel", "Nappa leather", "alcantara headliner"],
    "notes": "按 8 张参考图（左前 3/4 / 正后 / 右侧 / 正前 / 俯视 / 主驾 / 副驾 / 后排）逐条落实特征。",
}
assessment["complexity"] = {
    "tier": "complex",
    "scores": {"silhouetteComplexity": 3, "componentCount": 3, "hierarchyDepth": 2,
               "repetitionDensity": 2, "materialLayerCount": 3, "localDetailDensity": 3,
               "occlusionRisk": 2, "actionReadinessNeed": 3},
    "estimatedCounts": {"macroComponents": 3, "mesoComponents": 30, "microFeatureGroups": 22,
                        "materialLayers": 26, "repetitionSystems": 1},
    "reasoning": ["整车=连续壳体（车身侧视单壳）+ 玻璃薄壳 + 4 组车轮 + 座舱模块；局部细节密度高（灯腔/轮辐/内饰分色）"],
}
assessment["detailInventory"] = {
    "scanMethod": "component-zones",
    "targetMinDetails": len(detail_items),
    "note": "每条细节都落到某个 component.localFeatures.id（程序化几何/材质/贴图的落点），无散文式细节。",
    "details": detail_items,
}
assessment["unknownsToResolveBeforeImplementation"] = []
spec["preSpecAssessment"] = assessment

spec["componentTree"] = COMPS
spec["materials"] = MATS
spec["repetitionSystems"] = REPS

# buildPasses：R7 的 spec 是一次性整装配，blockout 的 componentRefs 直接枚举全部组件，
# 这样在未跑视觉评审（reviewHistory 为空 → 当前解锁 pass = blockout）时生成的工厂仍然完整。
_all_ids = [c["id"] for c in COMPS]
if isinstance(spec.get("buildPasses"), list):
    for bp in spec["buildPasses"]:
        if isinstance(bp, dict) and bp.get("id") in {"blockout", "lighting-pass"}:
            bp["componentRefs"] = _all_ids
            if bp.get("id") == "blockout":
                bp["goal"] = ("Match macro silhouette and proportions. R7 为一次性整装配 spec："
                              "componentRefs 枚举全部组件，故 blockout pass 产出即为完整整车。")

spec["lightingFromPhoto"] = [
    {"id": "key-studio-softbox", "role": "key light", "direction": [-0.55, 0.75, 0.62],
     "color": "#FFF6EA", "intensity": 2.4,
     "note": "参考图为影棚三灯柔光：key light 位于车左前上方，车漆高光带沿腰线拉长"},
    {"id": "fill-studio", "role": "fill light", "direction": [0.78, 0.38, -0.30],
     "color": "#DDE6F0", "intensity": 0.85,
     "note": "fill light 为右侧弱冷补光，压住暗部但不打死墨绿的青绿 flop"},
    {"id": "rim-studio", "role": "rim light", "direction": [0.10, 0.55, -0.95],
     "color": "#FFFFFF", "intensity": 1.1,
     "note": "rim light / environment 反射：尾部轮廓光，尾灯带与鸭尾棱线靠它出边"},
    {"id": "tone-mapping", "role": "exposure",
     "exposure": 1.0, "toneMapping": "ACESFilmic", "outputColorSpace": "sRGB",
     "background": "#E9E9EA",
     "note": "exposure 1.0 + ACES filmic tone mapping + sRGB 输出；参考图为浅灰无缝背景（#E9E9EA 上下渐变）"},
    {"id": "contact-shadow", "role": "contact shadow",
     "type": "soft ground shadow", "intensity": 0.55, "radius": 0.35,
     "note": "contact shadow：车底一片柔和 ground shadow + 轮下加深，环境光遮蔽 AO 强度 0.45"},
]
spec["proceduralStrategy"] = [
    "车身/机盖/尾门/前脸全部走「侧视断面 extrude」同一套 idiom（深度真源 = profile2D.depth，节点 x=depth/2）",
    "玻璃四块（前挡/天幕/侧窗/后挡）都是薄壳带，不走 transmission",
    "车轮 = 环形胎 lathe + 盘体 lathe + 20 辐齿轮 extrude 三层，卡钳独立不随轮转",
    "内饰全部世界坐标，容器 cabin-interior 归零且几何退化为 2cm 薄片（无可隐藏占位盒）",
    "灯/字标/屏幕全部由材质 ID 契约驱动，内容贴图在适配层 Canvas 生成",
]
spec["assumptions"] = [
    "车宽 1.981 含轮眉包边（|x|=0.990），不含展开的后视镜",
    "单视角无法确证底盘/后备箱内部，按同级 SUV 典型值推断",
]
spec["risks"] = [
    "A 柱/顶梁与玻璃壳之间可能存在 1–2cm 缝（本 spec 用 roof-rail + roof-header 桥接，未做布尔）",
    "20 辐轮面为齿轮轮廓挤出，辐条截面为矩形（非机加工梯形），近距离看会偏平",
]

SP.write_text(json.dumps(spec, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
print(f"components={len(COMPS)} materials={len(MATS)} reps={len(REPS)} details={len(detail_items)}")
print(f"body-profile pts={len(BODY)} shoelace={shoelace(BODY):.4f}")
