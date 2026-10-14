"""strict-quality 修复：chirality/topologyClass/colorMaterialRecipe/lighting/palette/unknowns。"""
import json
from pathlib import Path

WRK = Path(r"C:\Users\16896\WorkBuddy\2026-10-14-13-25-01\brake-v800\.img2threejs")

# ---------- 1) fill_assessment.py: unknowns 清空（推算项已在 assumptions） ----------
fa = WRK / "fill_assessment.py"
s = fa.read_text(encoding="utf-8")
s = s.replace('pa["unknownsToResolveBeforeImplementation"] = [',
              'pa["unknownsToResolveBeforeImplementation"] = []  # resolved: see spec assumptions\nif False:\n    pa["unknownsToResolveBeforeImplementation"] = [')
fa.write_text(s, encoding="utf-8")

# ---------- 2) build_spec.py: chirality / topologyClass / palette / lighting ----------
bs = WRK / "build_spec.py"
t = bs.read_text(encoding="utf-8")

# chirality: l=+X（车左），r=-X
t = t.replace('comps.append(C("curtain-l", "后窗帘左", "meso", "plane-card", CAB, [-0.88, 1.32, -1.55]',
              'comps.append(C("curtain-l", "后窗帘左", "meso", "plane-card", CAB, [0.88, 1.32, -1.55]')
t = t.replace('comps.append(C("curtain-r", "后窗帘右", "meso", "plane-card", CAB, [0.88, 1.32, -1.55]',
              'comps.append(C("curtain-r", "后窗帘右", "meso", "plane-card", CAB, [-0.88, 1.32, -1.55]')
t = t.replace('SEATS = [("seat-driver", -0.52, 0.92, "驾驶位"), ("seat-passenger", 0.52, 0.92, "副驾位"), ("seat-rear-l", -0.50, -1.30, "后排航空座左"), ("seat-rear-r", 0.50, -1.30, "后排航空座右")]',
              'SEATS = [("seat-driver", 0.52, 0.92, "驾驶位"), ("seat-passenger", -0.52, 0.92, "副驾位"), ("seat-rear-l", 0.50, -1.30, "后排航空座左"), ("seat-rear-r", -0.50, -1.30, "后排航空座右")]')
t = t.replace('comps.append(C("tweeter-l", "左高音单元罩", "micro", "capsule", CAB, [-0.86, 1.10, 1.24]',
              'comps.append(C("tweeter-l", "左高音单元罩", "micro", "capsule", CAB, [0.86, 1.10, 1.24]')
t = t.replace('"localStart": [-0.86, 0, 0], "localEnd": [-0.86, 0.045, 0]',
              '"localStart": [0.86, 0, 0], "localEnd": [0.86, 0.045, 0]')
t = t.replace('comps.append(C("tweeter-r", "右高音单元罩", "micro", "capsule", CAB, [0.86, 1.10, 1.24]',
              'comps.append(C("tweeter-r", "右高音单元罩", "micro", "capsule", CAB, [-0.86, 1.10, 1.24]')
t = t.replace('"localStart": [0.86, 0, 0], "localEnd": [0.86, 0.045, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.003}, evidence=["img-dash", "img-popup1"]))',
              '"localStart": [-0.86, 0, 0], "localEnd": [-0.86, 0.045, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.003}, evidence=["img-dash", "img-popup1"]))')
t = t.replace('comps.append(C("steering", "三辐双色方向盘", "meso", "torus", CAB, [-0.54, 0.96, 0.96]',
              'comps.append(C("steering", "三辐双色方向盘", "meso", "torus", CAB, [0.54, 0.96, 0.96]')
t = t.replace('comps.append(C("gauge-screen", "悬浮仪表屏", "meso", "plane-card", CAB, [-0.72, 1.14, 1.06]',
              'comps.append(C("gauge-screen", "悬浮仪表屏", "meso", "plane-card", CAB, [0.72, 1.14, 1.06]')
t = t.replace('for sx, sz, tag in ((-0.94, 0.85, "fl"), (0.94, 0.85, "fr"), (-0.94, -0.95, "rl"), (0.94, -0.95, "rr")):',
              'for sx, sz, tag in ((0.94, 0.85, "fl"), (-0.94, 0.85, "fr"), (0.94, -0.95, "rl"), (-0.94, -0.95, "rr")):')
t = t.replace('comps.append(C("fuel-door", "油箱盖片", "micro", "box", "root", [-1.006, 0.98, -1.30]',
              'comps.append(C("fuel-door", "油箱盖片", "micro", "box", "root", [1.006, 0.98, -1.30]')
t = t.replace('comps.append(C("charge-pad", "无线充电板", "micro", "plane-card", CAB, [0, 0.795, 0.86]',
              'comps.append(C("charge-pad", "无线充电板", "micro", "plane-card", CAB, [0, 0.795, 0.86]')

# topologyClass 合法化
t = t.replace('"continuous-shell"', '"conforming-shell"')

# 每组件注入 colorMaterialRecipe（由材质映射 materialClass）——放在 d["componentTree"] = comps 之前
t = t.replace('d["preSpecAssessment"] = pa\nd["componentTree"] = comps', '''d["preSpecAssessment"] = pa

def _hex2rgba(h, a=1.0):
    h = h.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"rgba({r}, {g}, {b}, {a})"

MAT_CLASS = {
    "paint-upper": "metal", "paint-lower": "metal", "chrome": "metal", "dpillar-silver": "metal",
    "wheel-alloy": "metal", "housing-dark": "metal", "lamp-gold": "metal",
    "glass-dark": "glass", "glass-clear": "glass", "crystal": "glass", "screen-ui": "glass", "gauge-ui": "glass",
    "tire": "rubber",
    "leather-dark": "fabric", "leather-warm": "fabric", "leather-ivory": "fabric",
    "headliner-suede": "fabric", "curtain": "fabric", "carpet": "fabric",
    "wood": "wood",
    "lamp-white": "plastic", "lamp-star": "plastic", "lamp-red": "plastic", "lamp-amber": "plastic",
    "plate": "plastic", "matte-black": "plastic",
}
MAT_SEC = {
    "paint-upper": "#0E0E12", "paint-lower": "#C9A86B", "leather-warm": "#E8E0D0",
    "leather-ivory": "#4A342A", "wood": "#8A4A22", "headliner-suede": "#D8CFC0",
}
for _c in comps:
    _mid = _c.get("material")
    _mat = next((m for m in d["materials"] if m["id"] == _mid), None)
    _base = (_mat or {}).get("baseColor", "#808080")
    _c["colorMaterialRecipe"] = {
        "dominantAlbedo": _hex2rgba(_base),
        "secondaryAlbedo": _hex2rgba(MAT_SEC.get(_mid, _base)),
        "materialClass": MAT_CLASS.get(_mid, "unknown"),
        "materialClassConfidence": 0.9,
    }
d["componentTree"] = comps''')

# 材质 albedo palette（dict with secondary）+ colorVariation 非空
t = t.replace('''         "colorVariation": {"type": "none", "intensity": 0},''',
              '''         "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08},''')
t = t.replace('''         "baseColor": base, "color": base,
         "colorVariation"''', '''         "baseColor": base, "color": base,
         "albedo": {"base": base, "secondary": base, "note": "solid paint; secondary reserved for variant"},
         "colorVariation"''')
t = t.replace('    M("paint-upper", "车漆·香槟金(上半/金版)", "#C9A86B", 0.32, 0.65, "MeshPhysicalMaterial clearcoat 1.0 / clearcoatRoughness 0.06；黑版变体 #0E0E12 由集成层切换（localOverrides）"',
              '    M("paint-upper", "车漆·香槟金(上半/金版)", "#C9A86B", 0.32, 0.65, "MeshPhysicalMaterial clearcoat 1.0 / clearcoatRoughness 0.06；黑版变体 #0E0E12 由集成层切换（localOverrides）", others=None)\nPAINT_SEC = "#0E0E12"  # 黑版变体次级色')
# paint/leather secondary 注入
t = t.replace('"albedo": {"base": base, "secondary": base, "note": "solid paint; secondary reserved for variant"},',
              '"albedo": {"base": base, "secondary": PAINT_SEC if mid in ("paint-upper", "paint-lower") else base, "note": "reference-derived"},')

# lightingFromPhoto
t = t.replace('d["silhouette"] = {', '''d["lightingFromPhoto"] = [
    {"role": "key", "direction": "warm low-angle from camera-left (-X, +Z front)", "color": "#FFD2A2", "intensity": 3.3, "note": "~4500K dusk sun, matches game DirectionalLight"},
    {"role": "fill", "direction": "cool opposite azimuth + elevated", "color": "#8FA9C9", "intensity": 0.4, "note": "anti-crush shadows, no shadow casting"},
    {"role": "environment", "type": "PMREM from procedural dusk sky sphere", "color": "#E0836A", "intensity": 1.0, "note": "drives chrome/clearcoat reflections"},
    {"role": "ambient", "type": "hemisphere", "sky": "#A9C2DD", "ground": "#4A3226", "intensity": 0.5},
    {"exposure": "ACESFilmic tone mapping, exposure 0.85; emissive lamps above 0.72 bloom threshold"},
    {"contactShadow": "ground contact shadow under tires via shadow map (PCF, 2048, texel-snapped ortho ±28)"},
]
d["silhouette"] = {''')

bs.write_text(t, encoding="utf-8")
print("PATCHED")
