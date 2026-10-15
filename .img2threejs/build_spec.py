"""填充 object-sculpt-spec.json：完整组件树/材质/重复系统/审查目标/通道。
坐标系：+Z 车头、+Y 上、原点=轴距中点地面。单位米。左舵=+X？—— three 右手系 +Z 朝观察者；
车头 +Z 时左侧为 +X（驾驶员在 +X 侧）。集成层按需 rotateY(PI)。
"""
import json
from pathlib import Path

WRK = Path(r"<workspace>/.img2threejs")
SP = WRK / "object-sculpt-spec.json"
d = json.loads(SP.read_text(encoding="utf-8"))
pa = json.loads((WRK / "assessment.json").read_text(encoding="utf-8"))["preSpecAssessment"]

def C(cid, name, level, primitive, parent, pos, dims=None, rot=None, mat=None,
      imp=0.8, conf=0.9, desc=None, topo="assembled-solid", topoR=None,
      role="detail", feats=None, anim=None, evidence=None, det_refs=None, fid="hero",
      attachment=None):
    comp = {
        "id": cid, "name": name, "level": level, "role": role, "importance": imp,
        "confidence": conf, "primitive": primitive,
        "topologyClass": topo,
        "topologyRationale": topoR or f"{primitive} 适合该部件的可展拓扑",
        "geometryDescriptor": desc if desc is not None else {
            "topologyIntent": "hard-surface precise",
            "edgeTreatment": {"type": "bevel", "bevelRadius": 0.008, "segments": 2},
            "deformationStack": [], "uvStrategy": "generated procedural coordinates",
            "normalStrategy": "vertex normals from generated geometry",
        },
        "parent": parent,
        "attachment": attachment,
        "dimensions": {"width": dims[0], "height": dims[1], "depth": dims[2], "units": "meters", "confidence": conf} if dims else {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": conf},
        "transform": {"position": pos, "rotation": rot or [0, 0, 0], "scale": dims or [1, 1, 1]},
        "actionProfile": anim or {"animationRole": "static", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": conf}, "transformChannels": {"translate": False, "rotate": False, "scale": False, "bend": False, "twist": False, "detach": False, "visibility": True, "materialState": True}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": False, "notes": ""}, "constraints": [], "destruction": {"breakable": False, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}},
        "material": mat or "chrome",
        "materialLayers": [mat or "chrome"],
        "deformations": [], "joints": [], "seams": [],
        "localFeatures": feats or [],
        "surfaceDetail": {"macroRoughness": 0, "microRoughness": 0, "bumpAmplitude": 0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""},
        "evidenceRefs": evidence or ["img-design-black"],
        "details": det_refs or [],
        "fidelityTier": fid,
    }
    return comp

comps = []
# ---------- root ----------
comps.append(C("root", "Zunjie V800 整车", "macro", "group-root" if False else "box", None, [0, 0, 0], [2.006, 1.85, 5.495], role="body", imp=1.0, conf=1.0, mat="paint-upper", topo="assembled-solid", topoR="整车为组装体根节点"))

# ---------- 外观·车身壳体 ----------
SIDE_LOWER = {"points": [[2.30, 0.20], [2.30, 0.38], [2.58, 0.60], [2.665, 0.82], [2.60, 0.99], [2.25, 1.03], [1.28, 1.09], [1.05, 1.09], [-1.80, 1.09], [-2.50, 1.05], [-2.78, 0.98], [-2.83, 0.82], [-2.70, 0.55], [-2.48, 0.36], [-2.48, 0.20]], "depth": 2.006}
comps.append(C("body-lower", "车身下半壳体", "macro", "extrude", "root", [1.003, 0, 0], [1, 1, 1], rot=[0, -1.5708, 0], mat="paint-lower", imp=1.0, conf=0.95, desc={"profile2D": SIDE_LOWER, "topologyIntent": "lofted side-profile shell", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.02, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, topo="conforming-shell", topoR="连续车身侧面轮廓挤出体，单壳表达全部纵向型面", role="body", feats=[{"name": "腰线高直", "kind": "proportion", "note": "y≈1.05-1.09 贯穿"}, {"name": "尾部肩线外拱", "kind": "surface", "note": "后翼子板 z-1.9~-2.6 外拱"}], evidence=["img-design-black", "img-trunk"], det_refs=["d-chrome-belt", "d-rocker-step"]))
comps.append(C("hood-panel", "机盖面板", "meso", "box", "root", [0, 1.055, 1.92], [1.30, 0.035, 1.30], rot=[0.05, 0, 0], mat="paint-upper", imp=0.85, conf=0.9, role="body", feats=[{"name": "中央盖板缝线", "kind": "panel-line", "note": "中部纵向缝 + 前端楔形压板"}], evidence=["img-intelligence"]))
comps.append(C("hood-blister", "机盖前部压板", "micro", "box", "hood-panel", [0, 0.045, -0.42], [0.62, 0.03, 0.34], mat="paint-upper", imp=0.6, conf=0.85, evidence=["img-intelligence"]))
SIDE_GLASS = {"points": [[1.02, 1.10], [0.18, 1.60], [-0.30, 1.645], [-1.80, 1.645], [-2.30, 1.56], [-2.42, 1.14]], "depth": 1.83}
comps.append(C("greenhouse-glass", "玻璃舱环", "macro", "extrude", "root", [0.915, 0, 0], [1, 1, 1], rot=[0, -1.5708, 0], mat="glass-dark", imp=0.95, conf=0.9, desc={"profile2D": SIDE_GLASS, "topologyIntent": "glazed band extrusion", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.01, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, topo="conforming-shell", topoR="侧窗+后窗连续玻璃带，前挡独立", role="body", evidence=["img-design-black", "img-trunk"]))
ROOF_ARC = {"points": [[0.98, 1.56], [0.20, 1.715], [-0.20, 1.72], [-1.80, 1.72], [-2.32, 1.585], [-2.36, 1.50], [-2.30, 1.50], [-1.80, 1.645], [0.18, 1.645]], "depth": 1.60}
comps.append(C("roof-panel", "车顶板", "meso", "extrude", "root", [0.80, 0, 0], [1, 1, 1], rot=[0, -1.5708, 0], mat="paint-upper", imp=0.9, conf=0.9, desc={"profile2D": ROOF_ARC, "topologyIntent": "crown arc shell", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.015, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, topo="conforming-shell", topoR="顶冠弧面薄片", role="body", evidence=["img-intelligence"]))
comps.append(C("windshield", "前挡玻璃", "meso", "box", "root", [0, 1.345, 0.60], [1.50, 0.025, 1.06], rot=[0.5236, 0, 0], mat="glass-clear", imp=0.9, conf=0.9, role="body", feats=[{"name": "车内可透视", "kind": "visibility", "note": "cabin 驾驶员视角必须能看穿"}], evidence=["img-intelligence", "img-dash"]))
for s in (1, -1):
    comps.append(C(f"dpillar-{'l' if s>0 else 'r'}", f"D 柱银白宽包边{'左' if s>0 else '右'}", "meso", "box", "root", [s * 0.90, 1.38, -2.28], [0.20, 0.56, 0.34], rot=[0, 0, s * -0.12], mat="dpillar-silver", imp=0.85, conf=0.92, evidence=["img-trunk"], det_refs=["d-dpillar"]))
    comps.append(C(f"bpillar-{'l' if s>0 else 'r'}", f"B 柱{'左' if s>0 else '右'}", "micro", "box", "root", [s * 0.905, 1.30, 0.42], [0.035, 0.56, 0.05], mat="matte-black", imp=0.55, conf=0.8, evidence=["img-design-black"]))
    comps.append(C(f"cpillar-{'l' if s>0 else 'r'}", f"C 柱{'左' if s>0 else '右'}", "micro", "box", "root", [s * 0.905, 1.30, -1.32], [0.035, 0.56, 0.05], mat="matte-black", imp=0.55, conf=0.8, evidence=["img-design-black"]))

# ---------- 外观·前脸 ----------
FRONT = "front-end"
comps.append(C(FRONT, "前脸模块", "macro", "box", "root", [0, 0.9, 2.62], [1.86, 1.05, 0.08], mat="paint-upper", imp=0.95, conf=0.9, role="body", evidence=["img-intelligence"]))
comps.append(C("chrome-brow", "前脸镀铬上沿饰条", "meso", "box", FRONT, [0, 0.40, -0.03], [1.84, 0.09, 0.06], mat="chrome", imp=0.9, conf=0.95, evidence=["img-intelligence"], det_refs=["d-maextro-mark"]))
comps.append(C("maextro-mark", "MAEXTRO 发光字标", "micro", "plane-card", FRONT, [0, 0.40, 0.045], [0.80, 0.06, 0.005], mat="lamp-white", imp=0.9, conf=0.95, feats=[{"name": "MAEXTRO 宽间距发光字", "kind": "emissive-text", "note": "CanvasTexture 程序生成，字间距大"}], evidence=["img-intelligence"], det_refs=["d-maextro-mark"]))
comps.append(C("shield-logo", "盾形竖标", "micro", "box", FRONT, [0, 0.02, 0.05], [0.05, 0.17, 0.02], mat="chrome", imp=0.85, conf=0.9, feats=[{"name": "盾形轮廓+内部棱格", "kind": "mark", "note": "中央竖盾，微 emissive 边缘"}], evidence=["img-intelligence"], det_refs=["d-shield-logo"]))
LAMP_PROFILE = {"points": [[-0.085, -0.30], [0.0, -0.325], [0.085, -0.30], [0.10, -0.22], [0.10, 0.24], [0.07, 0.31], [-0.07, 0.31], [-0.10, 0.24], [-0.10, -0.22]], "depth": 0.07}
for s in (1, -1):
    side = "l" if s > 0 else "r"
    comps.append(C(f"headlamp-{side}", f"竖向大灯总成{'左' if s>0 else '右'}", "meso", "extrude", FRONT, [s * 0.80, 0.06, 0.03], [1, 1, 1], mat="housing-dark", imp=0.95, conf=0.95, desc={"profile2D": LAMP_PROFILE, "topologyIntent": "rounded vertical lamp housing", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, topo="conforming-shell", topoR="竖圆角矩形灯罩轮廓挤出", evidence=["img-intelligence", "img-design-black"], det_refs=["d-headlamp-star"]))
    comps.append(C(f"headlamp-led-{side}", f"大灯 LED 灯带{'左' if s>0 else '右'}", "micro", "box", f"headlamp-{side}", [s * 0.045, 0.0, 0.048], [0.022, 0.40, 0.02], mat="lamp-white", imp=0.9, conf=0.95, feats=[{"name": "纵向双灯带", "kind": "emissive", "note": "内外两条竖向白光带"}], evidence=["img-intelligence"]))
    comps.append(C(f"headlamp-star-{side}", f"大灯星点纹理{'左' if s>0 else '右'}", "micro", "plane-card", f"headlamp-{side}", [-s * 0.02, 0.0, 0.052], [0.13, 0.52, 0.004], mat="lamp-star", imp=0.85, conf=0.9, feats=[{"name": "星点点阵+钻石切割面", "kind": "emissive-pattern", "note": "Canvas 点阵贴图"}], evidence=["img-intelligence"]))
comps.append(C("bumper-lower", "前保险杠下体", "meso", "box", FRONT, [0, -0.44, 0.005], [1.92, 0.32, 0.10], mat="paint-lower", imp=0.8, conf=0.9, evidence=["img-intelligence"]))
comps.append(C("bumper-light-strip", "保险杠横向灯带", "micro", "box", "bumper-lower", [0, 0.10, 0.055], [1.45, 0.018, 0.015], mat="lamp-white", imp=0.8, conf=0.9, evidence=["img-intelligence"]))
comps.append(C("bumper-chrome-lip", "保险杠镀铬唇", "micro", "box", "bumper-lower", [0, -0.12, 0.05], [1.86, 0.04, 0.05], mat="chrome", imp=0.7, conf=0.9, evidence=["img-intelligence"]))
comps.append(C("front-plate", "车名牌「尊界V800」", "micro", "plane-card", FRONT, [-0.42, -0.10, 0.06], [0.42, 0.11, 0.004], mat="plate", imp=0.7, conf=0.9, feats=[{"name": "铭牌文字", "kind": "emissive-text", "note": "Canvas 贴图 尊界 V800"}], evidence=["img-design-black", "img-intelligence"]))

# ---------- 外观·尾部 ----------
TAIL = "tailgate"
comps.append(C(TAIL, "尾门模块", "macro", "box", "root", [0, 1.02, -2.80], [1.86, 1.05, 0.07], mat="paint-upper", imp=0.95, conf=0.9, role="body", evidence=["img-trunk"]))
LANTERN_PROFILE = {"points": [[-0.075, -0.335], [0.0, -0.355], [0.075, -0.335], [0.09, -0.26], [0.09, 0.26], [0.06, 0.335], [-0.06, 0.335], [-0.09, 0.26], [-0.09, -0.26]], "depth": 0.06}
for s in (1, -1):
    side = "l" if s > 0 else "r"
    comps.append(C(f"taillamp-{side}", f"宫灯尾灯{'左' if s>0 else '右'}", "meso", "extrude", TAIL, [s * 0.84, -0.12, -0.02], [1, 1, 1], mat="chrome", imp=0.95, conf=0.95, desc={"profile2D": LANTERN_PROFILE, "topologyIntent": "rounded vertical lantern frame", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.006, "segments": 2}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, topo="conforming-shell", topoR="竖圆角镀铬宫灯外框", evidence=["img-trunk"], det_refs=["d-tail-lantern"]))
    comps.append(C(f"lantern-core-{side}", f"尾灯红光核心{'左' if s>0 else '右'}", "micro", "plane-card", f"taillamp-{side}", [0, 0, 0.038], [0.135, 0.60, 0.004], mat="lamp-red", imp=0.95, conf=0.95, feats=[{"name": "红点阵+羽翼纹理", "kind": "emissive-pattern", "note": "Canvas 点阵+羽翼渐变；刹车联动增强"}], evidence=["img-trunk"]))
comps.append(C("high-mount-stop", "高位宽刹车灯", "micro", "box", TAIL, [0, 0.52, 0.02], [0.92, 0.025, 0.025], mat="lamp-red", imp=0.85, conf=0.9, evidence=["img-trunk"], det_refs=["d-third-brakelight"]))
comps.append(C("tail-window-trim", "尾窗银白包边", "meso", "box", TAIL, [0, 0.44, 0.015], [1.30, 0.10, 0.05], mat="dpillar-silver", imp=0.75, conf=0.85, evidence=["img-trunk"]))

# ---------- 外观·车侧细节 ----------
for s in (1, -1):
    side = "l" if s > 0 else "r"
    comps.append(C(f"chrome-belt-{side}", f"腰线镀铬亮条{'左' if s>0 else '右'}", "meso", "box", "root", [s * 1.006, 1.005, -0.15], [0.02, 0.03, 4.60], mat="chrome", imp=0.9, conf=0.95, evidence=["img-design-black", "img-trunk"], det_refs=["d-chrome-belt"]))
    comps.append(C(f"window-belt-{side}", f"窗线镀铬亮条{'左' if s>0 else '右'}", "meso", "box", "root", [s * 0.918, 1.105, -0.55], [0.015, 0.02, 3.30], mat="chrome", imp=0.75, conf=0.9, evidence=["img-trunk"]))
    comps.append(C(f"handle-front-{side}", f"前门通长把手{'左' if s>0 else '右'}", "micro", "box", "root", [s * 1.012, 0.97, 1.18], [0.035, 0.04, 0.62], mat="chrome", imp=0.9, conf=0.95, evidence=["img-design-black"], det_refs=["d-doorhandles"]))
    comps.append(C(f"handle-slider-{side}", f"滑门通长把手{'左' if s>0 else '右'}", "micro", "box", "root", [s * 1.012, 0.97, -0.28], [0.035, 0.04, 0.62], mat="chrome", imp=0.9, conf=0.95, evidence=["img-design-black"], det_refs=["d-doorhandles"]))
    comps.append(C(f"fender-badge-{side}", f"翼子板标识{'左' if s>0 else '右'}", "micro", "box", "root", [s * 1.008, 0.96, 1.62], [0.012, 0.045, 0.05], mat="chrome", imp=0.6, conf=0.8, evidence=["img-design-black"], det_refs=["d-fender-badge"]))
    comps.append(C(f"rocker-{side}", f"下裙护板{'左' if s>0 else '右'}", "meso", "box", "root", [s * 0.988, 0.28, -0.15], [0.05, 0.12, 3.40], mat="matte-black", imp=0.7, conf=0.9, evidence=["img-design-black"], det_refs=["d-rocker-step"]))
    comps.append(C(f"mirror-{'l' if s>0 else 'r'}", f"后视镜{'左' if s>0 else '右'}", "meso", "box", "root", [s * 1.10, 1.17, 1.02], [0.22, 0.13, 0.11], mat="paint-upper", imp=0.85, conf=0.92, feats=[{"name": "双色壳", "kind": "two-tone", "note": "上半镀铬盖+下车色"}], evidence=["img-design-black", "img-intelligence"]))
    comps.append(C(f"mirror-cap-{'l' if s>0 else 'r'}", f"后视镜镀铬盖{'左' if s>0 else '右'}", "micro", "box", f"mirror-{'l' if s>0 else 'r'}", [0, 0.045, 0], [0.225, 0.05, 0.115], mat="chrome", imp=0.7, conf=0.9, evidence=["img-design-black"]))
comps.append(C("fuel-door", "油箱盖片", "micro", "box", "root", [1.006, 0.98, -1.30], [0.012, 0.16, 0.09], mat="paint-lower", imp=0.5, conf=0.85, evidence=["img-trunk"], det_refs=["d-fuel-door"]))
ARCH_PROFILE = {"points": [[0.055, 0], [0.042, 0.032], [0.026, 0.05], [0, 0.056], [-0.026, 0.05], [-0.042, 0.032], [-0.055, 0]], "depth": 0.05}
for zx, tag in ((1.715, "fr"), (-1.715, "rr")):
    comps.append(C(f"arch-{tag}", f"{'前' if zx>0 else '后'}轮拱护缘", "micro", "torus", "root", [0, 0.40, zx], [1.04, 1.04, 0.05], rot=[0, 1.5708, 0], mat="matte-black", imp=0.6, conf=0.8, desc={"torusTubeRatio": 0.06}, evidence=["img-design-black"]))

# ---------- 车顶附件 ----------
comps.append(C("roof-rails", "车顶行李架纵轨×2", "meso", "tube", "root", [0, 1.895, -0.35], [1, 1, 1], mat="dpillar-silver", imp=0.8, conf=0.9, desc={"tubePath": {"points": [[0.62, 0, 1.20], [0.62, 0, -1.90], [-0.62, 0, -1.90], [-0.62, 0, 1.20]], "radius": 0.022, "closed": True}, "topologyIntent": "two parallel rails", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, topo="conforming-shell", topoR="双纵轨连续管", attachment={"parentSocket": "roof-panel.top", "localStart": [0.62, 0, 1.20], "localEnd": [-0.62, 0, 1.20], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.004}, evidence=["img-design-black"], det_refs=["d-roof-rail"]))
comps.append(C("lidar-wedge", "激光雷达楔形块", "meso", "box", "root", [0, 1.90, 1.28], [0.17, 0.05, 0.32], rot=[0.12, 0, 0], mat="matte-black", imp=0.85, conf=0.9, feats=[{"name": "前部楔形玻璃窗", "kind": "sensor-window", "note": "前倾斜面"}], evidence=["img-intelligence"], det_refs=["d-lidar-wedge"]))

# ---------- 车轮 ×4 ----------
WHEEL_POS = {"fl": [0.875, 0.382, 1.715], "fr": [-0.875, 0.382, 1.715], "rl": [0.875, 0.382, -1.715], "rr": [-0.875, 0.382, -1.715]}
for tag, wp in WHEEL_POS.items():
    comps.append(C(f"wheel-{tag}", f"车轮 {tag}", "macro", "box", "root", wp, [0.255, 0.764, 0.764], mat="tire", imp=0.95, conf=0.95, role="wheel", anim={"animationRole": "spin", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": False, "rotate": True, "scale": False, "bend": False, "twist": False, "detach": False, "visibility": True, "materialState": False}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [0.764, 0.255, 0.764], "isTrigger": False, "notes": "旋转轴 X"}, "constraints": [], "destruction": {"breakable": False, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, evidence=["img-design-black", "img-trunk"], det_refs=["d-wheel-disc"]))
    comps.append(C(f"tire-{tag}", f"轮胎 {tag}", "meso", "cylinder", f"wheel-{tag}", [0, 0, 0], [0.764, 0.255, 0.764], rot=[0, 0, 1.5708], mat="tire", imp=0.9, conf=0.95, attachment={"parentSocket": f"wheel-{tag}.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "socket", "embedDepth": 0.002, "gapTolerance": 0.002}, evidence=["img-design-black"]))
    comps.append(C(f"rim-{tag}", f"大饼轮圈 {tag}", "meso", "cylinder", f"wheel-{tag}", [0, 0, 0.012], [0.60, 0.235, 0.60], rot=[0, 0, 1.5708], mat="wheel-alloy", imp=0.95, conf=0.95, attachment={"parentSocket": f"wheel-{tag}.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.002}, evidence=["img-trunk"]))
    comps.append(C(f"cap-{tag}", f"悬浮中心标 {tag}", "micro", "cylinder", f"wheel-{tag}", [0, 0, 0.125], [0.11, 0.02, 0.11], rot=[0, 0, 1.5708], mat="chrome", imp=0.8, conf=0.9, anim={"animationRole": "counter-rotate-lock", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.9}, "transformChannels": {"translate": False, "rotate": True, "scale": False, "bend": False, "twist": False, "detach": False, "visibility": True, "materialState": False}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": False, "notes": "集成层令其世界朝向恒定（悬浮标）"}, "constraints": [], "destruction": {"breakable": False, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, attachment={"parentSocket": f"wheel-{tag}.hub-front", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.005, "gapTolerance": 0.002}, evidence=["img-trunk"], det_refs=["d-wheel-disc"]))

# ---------- 内饰舱 ----------
CAB = "cabin-interior"
comps.append(C(CAB, "四座豪华舱", "macro", "box", "root", [0, 0, 0], [1.72, 1.5, 4.2], mat="leather-warm", imp=0.95, conf=0.9, role="interior", feats=[{"name": "includeInterior 开关", "kind": "visibility-group", "note": "exterior 视角下可整体隐藏"}], evidence=["img-cabin", "img-cutaway"]))
comps.append(C("cabin-floor", "座舱地板+长绒地毯", "meso", "box", CAB, [0, 0.30, -0.45], [1.66, 0.035, 3.60], mat="carpet", imp=0.8, conf=0.9, evidence=["img-cabin", "img-rearseat"], det_refs=["d-quilted-seats"]))
comps.append(C("dash-upper", "仪表台上层（深棕皮革）", "meso", "box", CAB, [0, 1.00, 1.30], [1.78, 0.17, 0.46], rot=[-0.06, 0, 0], mat="leather-dark", imp=0.9, conf=0.92, evidence=["img-dash", "img-popup1"]))
comps.append(C("dash-lower", "仪表台下体（米白）", "meso", "box", CAB, [0, 0.80, 1.40], [1.78, 0.26, 0.30], mat="leather-ivory", imp=0.85, conf=0.9, evidence=["img-dash"]))
comps.append(C("dash-chrome-strip", "仪表台贯穿镀铬条", "micro", "box", CAB, [0, 0.905, 1.115], [1.80, 0.014, 0.016], mat="chrome", imp=0.85, conf=0.92, evidence=["img-dash", "img-popup1"]))
comps.append(C("tri-screen", "贯穿三联屏", "meso", "plane-card", CAB, [0, 1.12, 1.14], [1.46, 0.315, 0.006], rot=[-0.10, 0, 0], mat="screen-ui", imp=0.95, conf=0.95, feats=[{"name": "HarmonyOS 风 UI 贴图", "kind": "screen", "note": "大时钟+卡片应用；仪表段独立动态 Canvas"}], evidence=["img-dash", "img-popup1"], det_refs=["d-triscreen"]))
comps.append(C("gauge-screen", "悬浮仪表屏", "meso", "plane-card", CAB, [0.72, 1.14, 1.06], [0.38, 0.20, 0.005], rot=[-0.14, 0, 0], mat="gauge-ui", imp=0.95, conf=0.95, feats=[{"name": "动态仪表（速度/踏板力/G值）", "kind": "dynamic-canvas", "note": "集成层每帧刷新"}], evidence=["img-dash", "img-popup1"], det_refs=["d-triscreen"]))
comps.append(C("vents-strip", "横贯出风口", "meso", "box", CAB, [0, 0.86, 1.13], [1.62, 0.05, 0.035], mat="chrome", imp=0.75, conf=0.9, evidence=["img-dash"]))
comps.append(C("tweeter-l", "左高音单元罩", "micro", "capsule", CAB, [0.86, 1.10, 1.24], [0.05, 0.045, 0.05], rot=[0, 0, 1.5708], mat="lamp-gold", imp=0.7, conf=0.85, attachment={"parentSocket": "dash-upper.top", "localStart": [0.86, 0, 0], "localEnd": [0.86, 0.045, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.003}, feats=[{"name": "金色竖纹水晶柱", "kind": "emissive-accent", "note": "HUAWEI SOUND 造型"}], evidence=["img-dash", "img-popup1"]))
comps.append(C("tweeter-r", "右高音单元罩", "micro", "capsule", CAB, [-0.86, 1.10, 1.24], [0.05, 0.045, 0.05], rot=[0, 0, 1.5708], mat="lamp-gold", imp=0.7, conf=0.85, attachment={"parentSocket": "dash-upper.top", "localStart": [-0.86, 0, 0], "localEnd": [-0.86, 0.045, 0], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.003}, evidence=["img-dash", "img-popup1"]))
comps.append(C("steering", "三辐双色方向盘", "meso", "torus", CAB, [0.54, 0.96, 0.96], [0.40, 0.40, 0.05], rot=[1.15, 0, 0], mat="wood", imp=0.95, conf=0.95, anim={"animationRole": "steer", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 0, 1], "confidence": 0.95}, "transformChannels": {"translate": False, "rotate": True, "scale": False, "bend": False, "twist": False, "detach": False, "visibility": True, "materialState": False}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": False, "notes": "集成层随转向微转"}, "constraints": [], "destruction": {"breakable": False, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "base"}}, desc={"torusTubeRatio": 0.09}, feats=[{"name": "车削木外圈+米白内圈", "kind": "two-tone-rim", "note": "外圈红棕木纹高光泽，内圈米白真皮"}], evidence=["img-dash", "img-popup1"], det_refs=["d-steering-dualtone"]))
comps.append(C("steering-hub", "方向盘气囊盖+盾标", "micro", "cylinder", "steering", [0, 0, 0], [0.15, 0.035, 0.15], mat="leather-ivory", imp=0.85, conf=0.92, attachment={"parentSocket": "steering.hub", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.005, "gapTolerance": 0.002}, feats=[{"name": "中央银色盾标", "kind": "mark", "note": "小 plane 叠加"}], evidence=["img-dash"]))
comps.append(C("tunnel-front", "中控 T 区（木纹座）", "meso", "box", CAB, [0, 0.62, 1.02], [0.42, 0.34, 0.80], mat="wood", imp=0.9, conf=0.92, evidence=["img-dash", "img-popup1"], det_refs=["d-crystal-shift"]))
comps.append(C("crystal-shifter", "水晶换挡旋钮", "micro", "sphere", CAB, [0, 0.845, 1.12], [0.085, 0.085, 0.085], mat="crystal", imp=0.9, conf=0.92, attachment={"parentSocket": "tunnel-front.top", "localStart": [0, 0, 0], "localEnd": [0, 0.045, 0], "contactType": "socket", "embedDepth": 0.02, "gapTolerance": 0.002}, feats=[{"name": "高透水晶球+金属底环", "kind": "crystal", "note": "transmission 材质"}], evidence=["img-dash"], det_refs=["d-crystal-shift"]))
comps.append(C("charge-pad", "无线充电板", "micro", "plane-card", CAB, [0, 0.795, 0.86], [0.17, 0.004, 0.24], rot=[-0.25, 0, 0], mat="leather-warm", imp=0.7, conf=0.88, attachment={"parentSocket": "tunnel-front.top", "localStart": [0, 0, 0], "localEnd": [0, 0.001, 0], "contactType": "flush", "embedDepth": 0.002, "gapTolerance": 0.002}, evidence=["img-dash"]))
for s in (1, -1):
    comps.append(C(f"cupholder-{'l' if s>0 else 'r'}", f"镀铬圈杯架{'左' if s>0 else '右'}", "micro", "torus", CAB, [s * 0.115, 0.80, 0.80], [0.10, 0.10, 0.02], rot=[1.5708, 0, 0], mat="chrome", imp=0.7, conf=0.88, desc={"torusTubeRatio": 0.10}, attachment={"parentSocket": "tunnel-front.top", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.004, "gapTolerance": 0.002}, evidence=["img-dash"], det_refs=["d-crystal-shift"]))
comps.append(C("tunnel-rear", "L 型中岛延伸段", "meso", "box", CAB, [0, 0.62, -0.55], [0.44, 0.36, 1.30], mat="wood", imp=0.9, conf=0.92, feats=[{"name": "延伸至后排", "kind": "structure", "note": "贯穿前后排的中岛"}], evidence=["img-cabin", "img-cutaway"], det_refs=["d-crystal-shift"]))
comps.append(C("rear-control-screen", "后排控制屏", "micro", "plane-card", CAB, [0, 0.83, -0.95], [0.24, 0.15, 0.005], rot=[-0.35, 0, 0], mat="screen-ui", imp=0.8, conf=0.88, attachment={"parentSocket": "tunnel-rear.top", "localStart": [0, 0, 0], "localEnd": [0, 0.001, 0], "contactType": "flush", "embedDepth": 0.003, "gapTolerance": 0.002}, evidence=["img-cabin", "img-popup1"]))
SEATS = [("seat-driver", 0.52, 0.92, "驾驶位"), ("seat-passenger", -0.52, 0.92, "副驾位"), ("seat-rear-l", 0.50, -1.30, "后排航空座左"), ("seat-rear-r", -0.50, -1.30, "后排航空座右")]
for sid, sx, sz, nm in SEATS:
    rear = "rear" in sid
    comps.append(C(sid, nm, "meso", "box", CAB, [sx, 0.62, sz], [0.56 if rear else 0.52, 0.14, 0.52 if rear else 0.50], mat="leather-warm", imp=0.95, conf=0.92, role="interior", feats=[{"name": "菱格绗缝+打孔中央", "kind": "stitch-pattern", "note": "Canvas bump 菱格贴图"}], evidence=["img-dash", "img-rearseat", "img-cutaway"], det_refs=["d-quilted-seats"]))
    comps.append(C(f"{sid}-back", f"{nm}·靠背", "meso", "box", sid, [0, 0.36, rear and 0.24 or 0.22], [0.54 if rear else 0.50, 0.66, 0.14], rot=[-0.10, 0, 0], mat="leather-warm", imp=0.9, conf=0.92, attachment={"parentSocket": f"{sid}.seat-base", "localStart": [0, 0.06, -0.1], "localEnd": [0, 0.5, 0.2], "contactType": "butt", "embedDepth": 0.002, "gapTolerance": 0.003}, evidence=["img-rearseat"]))
    comps.append(C(f"{sid}-headrest", f"{nm}·头枕", "micro", "box", sid, [0, 0.74, rear and 0.30 or 0.26], [0.26, 0.15, 0.10], mat="leather-warm", imp=0.8, conf=0.9, attachment={"parentSocket": f"{sid}-back.top", "localStart": [0, 0, 0], "localEnd": [0, 0.08, 0], "contactType": "socket", "embedDepth": 0.02, "gapTolerance": 0.002}, feats=[{"name": "压印车标", "kind": "emboss", "note": "头枕中央"}], evidence=["img-rearseat"]))
    if rear:
        comps.append(C(f"{sid}-legrest", f"{nm}·腿托", "micro", "box", sid, [0, 0.56, 0.48], [0.34, 0.07, 0.38], rot=[0.15, 0, 0], mat="leather-warm", imp=0.85, conf=0.9, attachment={"parentSocket": f"{sid}.seat-front", "localStart": [0, 0, 0.2], "localEnd": [0, 0.0, 0.5], "contactType": "socket", "embedDepth": 0.02, "gapTolerance": 0.003}, evidence=["img-rearseat", "img-popup3"]))
        comps.append(C(f"{sid}-armrest", f"{nm}·侧扶手", "micro", "box", sid, [0, 0.28, 0.05], [0.60, 0.10, 0.34], mat="leather-warm", imp=0.75, conf=0.85, attachment={"parentSocket": f"{sid}-back.side", "localStart": [0, 0.1, 0], "localEnd": [0, 0.0, 0.1], "contactType": "flush", "embedDepth": 0.01, "gapTolerance": 0.003}, feats=[{"name": "镀铬前端亮条", "kind": "chrome-accent", "note": ""}], evidence=["img-rearseat", "img-popup3"]))
comps.append(C("headliner-front", "顶棚前段（麂皮星空顶）", "meso", "box", CAB, [0, 1.70, 0.45], [1.52, 0.02, 1.45], mat="headliner-suede", imp=0.9, conf=0.92, feats=[{"name": "穿孔麂皮", "kind": "perforated", "note": "细孔阵列 bump"}], evidence=["img-cabin", "img-popup1"], det_refs=["d-starlight-headliner"]))
comps.append(C("headliner-rear", "顶棚后段（浅色穿孔革）", "meso", "box", CAB, [0, 1.675, -1.35], [1.52, 0.02, 1.55], mat="leather-ivory", imp=0.8, conf=0.9, evidence=["img-cabin"]))
comps.append(C("overhead-console", "顶棚控制区", "micro", "box", CAB, [0, 1.72, -0.55], [1.10, 0.045, 0.28], mat="leather-ivory", imp=0.7, conf=0.85, evidence=["img-cabin"]))
comps.append(C("ambient-strip-l", "顶棚氛围灯带左", "meso", "tube", CAB, [0, 0, 0], [1, 1, 1], mat="lamp-amber", imp=0.85, conf=0.9, desc={"tubePath": {"points": [[-0.74, 1.665, 1.35], [-0.78, 1.655, 0.4], [-0.78, 1.655, -1.6], [-0.74, 1.645, -2.25]], "radius": 0.012, "closed": False}, "topologyIntent": "edge-following light strip", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, topo="conforming-shell", topoR="沿顶棚凹槽的连续灯管", attachment={"parentSocket": "headliner-front.edge", "localStart": [-0.74, 0, 0], "localEnd": [-0.74, 0, 0], "contactType": "embed", "embedDepth": 0.008, "gapTolerance": 0.002}, feats=[{"name": "暖橙发光贯穿", "kind": "emissive-strip", "note": "端头渐隐"}], evidence=["img-cabin", "img-popup1"], det_refs=["d-ambient-strip"]))
comps.append(C("ambient-strip-r", "顶棚氛围灯带右", "meso", "tube", CAB, [0, 0, 0], [1, 1, 1], mat="lamp-amber", imp=0.85, conf=0.9, desc={"tubePath": {"points": [[0.74, 1.665, 1.35], [0.78, 1.655, 0.4], [0.78, 1.655, -1.6], [0.74, 1.645, -2.25]], "radius": 0.012, "closed": False}, "topologyIntent": "edge-following light strip", "edgeTreatment": {"type": "none", "bevelRadius": 0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals"}, topo="conforming-shell", topoR="沿顶棚凹槽的连续灯管", attachment={"parentSocket": "headliner-front.edge", "localStart": [0.74, 0, 0], "localEnd": [0.74, 0, 0], "contactType": "embed", "embedDepth": 0.008, "gapTolerance": 0.002}, evidence=["img-cabin", "img-popup1"], det_refs=["d-ambient-strip"]))
for sx, sz, tag in ((0.94, 0.85, "fl"), (-0.94, 0.85, "fr"), (0.94, -0.95, "rl"), (-0.94, -0.95, "rr")):
    comps.append(C(f"door-panel-{tag}", f"门内饰板 {tag}", "meso", "box", CAB, [sx, 0.86, sz], [0.07, 0.62, 1.15], mat="leather-warm", imp=0.85, conf=0.9, feats=[{"name": "双层扶手+金属点阵音响罩", "kind": "panel-detail", "note": "上扶手米白、下层棕"}], evidence=["img-cabin", "img-popup1", "img-popup3"], det_refs=["d-ambient-strip"]))
    comps.append(C(f"speaker-{tag}", f"门板音响罩 {tag}", "micro", "cylinder", f"door-panel-{tag}", [-sx * 0.045, -0.12, -0.1], [0.075, 0.015, 0.075], rot=[0, 0, 1.5708], mat="lamp-gold", imp=0.65, conf=0.85, attachment={"parentSocket": f"door-panel-{tag}.inner", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.004, "gapTolerance": 0.002}, evidence=["img-popup1"]))
comps.append(C("curtain-l", "后窗帘左", "meso", "plane-card", CAB, [0.88, 1.32, -1.55], [0.02, 0.52, 0.85], mat="curtain", imp=0.85, conf=0.88, feats=[{"name": "米白竖褶", "kind": "pleated-fabric", "note": "竖褶 bump，可收拢视觉"}], evidence=["img-cabin"], det_refs=["d-curtain-pleats"]))
comps.append(C("curtain-r", "后窗帘右", "meso", "plane-card", CAB, [-0.88, 1.32, -1.55], [0.02, 0.52, 0.85], mat="curtain", imp=0.85, conf=0.88, evidence=["img-cabin"], det_refs=["d-curtain-pleats"]))

d["preSpecAssessment"] = pa

d["componentTree"] = comps

# ---------- 材质 ----------
PAINT_SEC = "#0E0E12"  # 黑版变体次级色
def M(mid, name, base, rough, metal, notes="", extra=None, others=None):
    m = {"id": mid, "name": name, "type": "standard" if metal is not None else "physical",
         "shaderModel": "MeshPhysicalMaterial" if extra else "MeshStandardMaterial",
         "baseColor": base, "color": base,
         "albedo": {"base": base, "secondary": PAINT_SEC if mid in ("paint-upper", "paint-lower") else base, "note": "reference-derived"},
         "colorVariation": {"type": "subtle-panel-variation", "intensity": 0.08},
         "textureResolution": 1024,
         "textureProjection": {"mode": "procedural-uv-box", "repeat": [1, 1], "anisotropy": 4},
         "surfaceFrequencyBands": [
             {"id": "macro", "frequency": 1.2, "amplitude": 0.02},
             {"id": "meso", "frequency": 8.0, "amplitude": 0.008},
             {"id": "micro", "frequency": 48.0, "amplitude": 0.003},
         ],
         "roughness": rough, "metalness": metal,
         "normal": None, "bump": None, "displacement": None,
         "ambientOcclusion": {"type": "baked-contact", "intensity": 0.5, "note": "contact AO at panel gaps/crevices"},
         "wear": {"type": "none", "intensity": 0}, "dirt": {"type": "none", "intensity": 0},
         "localOverrides": others or [],
         "shaderNotes": [notes] if notes else [], "notes": ""}
    if extra:
        m.update(extra)
    return m

d["materials"] = [
    M("paint-upper", "车漆·香槟金(上半/金版)", "#C9A86B", 0.32, 0.65, "MeshPhysicalMaterial clearcoat 1.0 / clearcoatRoughness 0.06；黑版变体 #0E0E12 由集成层切换（localOverrides）", extra={"clearcoat": 1.0, "clearcoatRoughness": 0.06, "envMapIntensity": 1.0}, others=[{"zone": "black-variant", "baseColor": "#0E0E12", "note": "黑版整车涂装切换"}]),
    M("paint-lower", "车漆·深黑棕(下半)", "#221A14", 0.32, 0.65, "同 paint-upper 工艺；黑版车与 upper 同色", extra={"clearcoat": 1.0, "clearcoatRoughness": 0.08, "envMapIntensity": 0.9}),
    M("chrome", "镀铬饰件", "#E8E9EC", 0.12, 1.0, "金属镀层，必须有 envMap 反射", extra={"envMapIntensity": 1.25}),
    M("dpillar-silver", "D柱/行李架银白", "#D8D9DC", 0.2, 0.9, "缎面银金属漆", extra={"envMapIntensity": 1.1}),
    M("glass-dark", "深色隐私玻璃", "#101418", 0.05, 0.0, "近乎不透明深灰；high 档 transmission 0.5 供 cabin 内视，medium/low opacity 0.55", extra={"transmission": 0.5, "thickness": 0.03, "ior": 1.5}),
    M("glass-clear", "前挡玻璃", "#88909A", 0.04, 0.0, "较透明：transmission 0.85（high 档），medium/low opacity 0.4；cabin 视角必须可透视", extra={"transmission": 0.85, "thickness": 0.02, "ior": 1.52}),
    M("tire", "轮胎橡胶", "#141414", 0.9, 0.0, "哑光橡胶；胎侧字略"),
    M("wheel-alloy", "轮圈抛光银", "#C8CACD", 0.2, 0.95, "密辐大饼式亮面", extra={"envMapIntensity": 1.15}),
    M("housing-dark", "灯罩暗银底", "#1A1A1C", 0.25, 0.8, "灯具外壳底色"),
    M("matte-black", "哑光黑（格栅/护板/轮拱）", "#121214", 0.75, 0.1, "哑光工程塑料"),
    M("screen-ui", "屏幕 UI 贴图材质", "#0A0C10", 0.12, 0.0, "Canvas HarmonyOS 风贴图作 emissiveMap+map，intensity 1.4", extra={"emissive": "#9FB6C8", "emissiveIntensity": 1.4}),
    M("gauge-ui", "动态仪表贴图材质", "#060A08", 0.12, 0.0, "集成层动态 Canvas（速度/踏板力/G 值）", extra={"emissive": "#7FD8A8", "emissiveIntensity": 1.6}),
    M("lamp-white", "白光 emissive（灯带/字标）", "#FFFFFF", 0.3, 0.0, "emissive #FFFFFF intensity 2.5；MAEXTRO 用 Canvas 文字贴图作 emissiveMap", extra={"emissive": "#FFFFFF", "emissiveIntensity": 2.5}),
    M("lamp-star", "大灯星点纹理", "#EAF0FF", 0.2, 0.1, "Canvas 星点点阵 emissiveMap，intensity 2.2", extra={"emissive": "#EAF0FF", "emissiveIntensity": 2.2}),
    M("lamp-red", "尾灯红光核心", "#FF1E14", 0.25, 0.0, "Canvas 红点阵+羽翼纹理 emissiveMap，intensity 2.0；刹车联动至 6.0", extra={"emissive": "#FF1E14", "emissiveIntensity": 2.0}),
    M("lamp-amber", "氛围灯带暖橙", "#FFB067", 0.3, 0.0, "emissive #FFB067 intensity 1.8", extra={"emissive": "#FFB067", "emissiveIntensity": 1.8}),
    M("lamp-gold", "金色高音罩/音响点阵", "#C9962E", 0.28, 0.85, "金色金属+竖纹 bump", extra={"envMapIntensity": 1.1}),
    M("plate", "车名牌", "#0C0C0E", 0.4, 0.0, "Canvas「尊界 V800」文字贴图"),
    M("leather-dark", "内饰深棕皮革(仪表台上层)", "#4A342A", 0.62, 0.0, "细粒面 bump"),
    M("leather-warm", "内饰暖棕橙皮革", "#A05A2C", 0.58, 0.0, "全粒面+缝线；座椅用菱格 bump localOverrides", others=[{"zone": "seat-quilt", "bump": "canvas diamond-quilt", "bumpScale": 0.02}]),
    M("leather-ivory", "米白真皮", "#E8E0D0", 0.5, 0.0, "方向盘内圈/仪表台下体/顶棚后段"),
    M("wood", "车削红棕木纹", "#6B3418", 0.25, 0.0, "Canvas 车削木纹贴图 + clearcoat 0.8", extra={"clearcoat": 0.8, "clearcoatRoughness": 0.15}),
    M("headliner-suede", "顶棚麂皮(星空顶段)", "#3A2A20", 0.88, 0.0, "穿孔麂皮 bump + 星点由 repetition 系统表达"),
    M("curtain", "后窗帘米白织物", "#D8CFC0", 0.85, 0.0, "竖褶 normal 贴图（Canvas 条纹 bump）"),
    M("carpet", "长绒地毯", "#8A5A30", 0.95, 0.0, "长绒噪点 bump"),
    M("crystal", "水晶换挡旋钮", "#F4EFE8", 0.05, 0.0, "transmission 0.9 / ior 1.45 / clearcoat 1.0（high 档），medium/low 降级高光泽", extra={"transmission": 0.9, "thickness": 0.08, "ior": 1.45, "clearcoat": 1.0}),
]

# ---------- 重复系统 ----------
d["repetitionSystems"] = [
    {"id": "starlight-points", "name": "星空顶星点阵", "kind": "instanced-cluster",
     "baseComponent": "starlight-field", "count": 160, "seed": 20261014,
     "distribution": {"type": "poisson-disc", "region": {"x": [-0.68, 0.68], "y": [1.715, 1.718], "z": [-0.28, 1.05]}, "avoidOverlapRadius": 0.022},
     "scaleRange": [0.004, 0.010], "material": "lamp-white", "notes": "大小不一星点，顶棚前段麂皮下缘；const 确定性种子"},
    {"id": "wheel-spokes", "name": "轮圈密辐×4", "kind": "instanced-cluster",
     "baseComponent": "wheel-spoke-proto", "count": 48, "seed": 77,
     "distribution": {"type": "radial-4x12", "note": "每轮 12 辐绕 X 轴均布，随轮组 pivot"},
     "scaleRange": [1, 1], "material": "wheel-alloy", "notes": "与 rim 同转"},
    {"id": "lantern-dot-matrix", "name": "宫灯红点阵×2", "kind": "instanced-cluster",
     "baseComponent": "lantern-dot-proto", "count": 160, "seed": 9,
     "distribution": {"type": "grid-2x(10x8)", "note": "每尾灯 10×8 网格微扰动，贴 lantern-core 前方 0.002"},
     "scaleRange": [0.008, 0.012], "material": "lamp-red", "notes": "替代贴图的几何点阵（小 4 段球）"},
]
# 星点/辐条/点阵的载体组件（instanced 基元）
comps.append(C("starlight-field", "星空顶星点域", "meso", "instanced-cluster", CAB, [0, 0, 0], [1, 1, 1], mat="lamp-white", imp=0.9, conf=0.92, desc={"instancedBase": "sphere", "instancedCount": 160}, evidence=["img-cabin", "img-popup1"], det_refs=["d-starlight-headliner"]))
comps.append(C("wheel-spoke-proto", "轮辐原型", "micro", "instanced-cluster", "root", [0, 0, 0], [1, 1, 1], mat="wheel-alloy", imp=0.6, conf=0.85, desc={"instancedBase": "box", "instancedCount": 48}, evidence=["img-trunk"]))
comps.append(C("lantern-dot-proto", "宫灯点阵原型", "micro", "instanced-cluster", "root", [0, 0, 0], [1, 1, 1], mat="lamp-red", imp=0.6, conf=0.85, desc={"instancedBase": "sphere", "instancedCount": 160}, evidence=["img-trunk"]))
comps.append(C("vent-slat-proto", "出风口栅叶原型", "micro", "instanced-cluster", "root", [0, 0, 0], [1, 1, 1], mat="chrome", imp=0.5, conf=0.8, desc={"instancedBase": "box", "instancedCount": 26}, evidence=["img-dash"]))
d["repetitionSystems"].append({"id": "vent-slats", "name": "出风口栅叶阵", "kind": "instanced-cluster", "baseComponent": "vent-slat-proto", "count": 26, "seed": 5, "distribution": {"type": "row-x2", "note": "横贯出风口双排 13 叶"}, "scaleRange": [1, 1], "material": "chrome", "notes": ""})

# ---------- 特征审查目标 ----------
d["featureReviewTargets"] = [
    {"id": "overall-silhouette", "name": "整车轮廓与比例（方正大圆角 MPV+悬浮顶）", "tier": "critical", "passIds": ["blockout", "form-refinement"], "minimumScore": 0.85, "mustPass": True, "componentRefs": ["body-lower", "greenhouse-glass", "roof-panel"], "evidenceRefs": ["img-design-black"]},
    {"id": "front-lamp-system", "name": "竖向大灯总成（圆角矩形+双 LED 带+星点纹理）", "tier": "critical", "passIds": ["structural-pass", "form-refinement", "material-pass"], "minimumScore": 0.85, "mustPass": True, "componentRefs": ["headlamp-l", "headlamp-r", "headlamp-led-l", "headlamp-star-l"], "evidenceRefs": ["img-intelligence"]},
    {"id": "tail-lantern-system", "name": "宫灯尾灯（镀铬框+红点阵+羽翼纹理）", "tier": "critical", "passIds": ["structural-pass", "material-pass"], "minimumScore": 0.85, "mustPass": True, "componentRefs": ["taillamp-l", "taillamp-r", "lantern-core-l"], "evidenceRefs": ["img-trunk"]},
    {"id": "dual-tone-paint", "name": "双拼涂装+镀铬带系统（腰线亮条/窗线/D柱银白）", "tier": "critical", "passIds": ["material-pass", "lighting-pass"], "minimumScore": 0.8, "mustPass": True, "componentRefs": ["body-lower", "roof-panel", "chrome-belt-l", "dpillar-l"], "evidenceRefs": ["img-trunk", "img-design-black"]},
    {"id": "cabin-luxury-kit", "name": "内饰身份包（星空顶+菱格航空座椅+三联屏+双色方向盘+L中岛）", "tier": "critical", "passIds": ["structural-pass", "material-pass"], "minimumScore": 0.8, "mustPass": True, "componentRefs": ["headliner-front", "seat-rear-l", "tri-screen", "steering", "tunnel-front"], "evidenceRefs": ["img-cabin", "img-dash", "img-popup1", "img-rearseat"]},
    {"id": "wheel-disc-design", "name": "大饼轮圈+悬浮中心标", "tier": "important", "passIds": ["form-refinement", "interaction-pass"], "minimumScore": 0.75, "mustPass": False, "componentRefs": ["rim-fl", "cap-fl", "wheel-spoke-proto"], "evidenceRefs": ["img-trunk"]},
    {"id": "door-handle-belt", "name": "通长横贯式镀铬门把手", "tier": "important", "passIds": ["structural-pass"], "minimumScore": 0.75, "mustPass": False, "componentRefs": ["handle-front-l", "handle-slider-l"], "evidenceRefs": ["img-design-black"]},
    {"id": "maextro-illumination", "name": "MAEXTRO 发光字标+盾标", "tier": "important", "passIds": ["material-pass", "lighting-pass"], "minimumScore": 0.75, "mustPass": False, "componentRefs": ["maextro-mark", "shield-logo"], "evidenceRefs": ["img-intelligence"]},
]

# ---------- buildPasses componentRefs 更新 ----------
PASS_REFS = {
    "blockout": ["body-lower", "greenhouse-glass", "roof-panel", "wheel-fl", "wheel-rl", "front-end", "tailgate"],
    "structural-pass": ["front-end", "tailgate", "cabin-interior", "handle-front-l", "dpillar-l", "roof-rails", "wheel-fl"],
    "form-refinement": ["body-lower", "roof-panel", "headlamp-l", "taillamp-l", "rim-fl", "hood-panel", "mirror-l"],
    "material-pass": ["body-lower", "roof-panel", "cabin-interior", "headlamp-l", "lantern-core-l", "maextro-mark", "seat-rear-l", "tri-screen"],
    "surface-pass": ["seat-rear-l", "headliner-front", "curtain-l", "body-lower", "wood"],
    "lighting-pass": ["lamp-white", "lamp-red", "lamp-amber", "maextro-mark", "ambient-strip-l"],
    "interaction-pass": ["wheel-fl", "steering", "cap-fl", "cabin-interior"],
    "optimization-pass": ["root", "starlight-field", "wheel-spoke-proto"],
}
for p in d["buildPasses"]:
    if p["id"] in PASS_REFS:
        p["componentRefs"] = PASS_REFS[p["id"]]

# ---------- 其余 section ----------
d["coordinateFrame"] = {"front": "+Z (vehicle nose)", "up": "+Y", "scaleReference": "wheelbase 3.430m; overall 5.495×2.006×1.850m; wheel radius 0.382m; ground y=0", "units": "meters", "note": "左舵驾驶位在 +X 侧（three 右手系 +Z 朝前时左为 +X）；集成层可整体 rotateY(PI) 适配游戏 -Z 前进方向"}
d["lightingFromPhoto"] = [
    {"role": "key", "direction": "warm low-angle from camera-left (-X, +Z front)", "color": "#FFD2A2", "intensity": 3.3, "note": "~4500K dusk sun, matches game DirectionalLight"},
    {"role": "fill", "direction": "cool opposite azimuth + elevated", "color": "#8FA9C9", "intensity": 0.4, "note": "anti-crush shadows, no shadow casting"},
    {"role": "environment", "type": "PMREM from procedural dusk sky sphere", "color": "#E0836A", "intensity": 1.0, "note": "drives chrome/clearcoat reflections"},
    {"role": "ambient", "type": "hemisphere", "sky": "#A9C2DD", "ground": "#4A3226", "intensity": 0.5},
    {"exposure": "ACESFilmic tone mapping, exposure 0.85; emissive lamps above 0.72 bloom threshold"},
    {"contactShadow": "ground contact shadow under tires via shadow map (PCF, 2048, texel-snapped ortho ±28)"},
]
d["silhouette"] = {
    "boundingShape": "rounded-cuboid lofted MPV: low flat hood → raked A-pillar → long flat crown → near-vertical D-pillar → rounded vertical tail cut",
    "aspectRatios": {"length/height": 2.97, "wheelbase/length": 0.624, "wheel-diameter/height": 0.41},
    "symmetry": "bilateral (X mirror)",
    "dominantCurves": ["crown arc y1.62→1.72 平缓", "前保杠圆角 R0.25", "尾部肩线外拱", "腰线高直贯穿"],
    "negativeSpaces": ["四轮拱", "前后保杠下缘", "侧窗带（深色）"],
    "landmarks": ["前脸镀铬眉+MAEXTRO", "竖向大灯", "宫灯尾灯", "D柱银白包边", "大饼轮圈"],
}
d["viewEvidence"] = [
    {"id": "img-design-black", "view": "side-left full", "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1}, "observations": ["正侧全景：腰线/把手/轮圈/D柱/行李架/激光雷达", "黑版涂装"], "confidence": 0.97},
    {"id": "img-trunk", "view": "rear-45 left", "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1}, "observations": ["金版双拼分界/宫灯尾灯细节/大饼轮圈/油箱盖/D柱包边"], "confidence": 0.95},
    {"id": "img-intelligence", "view": "front-45 high", "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1}, "observations": ["前脸镀铬眉/MAEXTRO/盾标/竖向大灯星点纹理/机盖压板/后视镜双色"], "confidence": 0.95},
    {"id": "img-cabin", "view": "cabin-rear (starlight)", "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1}, "observations": ["星空顶/氛围灯带/窗帘/后排座椅背/中岛延伸/顶棚控制区"], "confidence": 0.95},
    {"id": "img-dash", "view": "cabin-driver wide", "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1}, "observations": ["双层仪表台全景/出风口/副驾侧木纹/门板双层扶手"], "confidence": 0.95},
    {"id": "img-popup1", "view": "cabin-driver close", "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1}, "observations": ["方向盘双色木圈特写/三联屏 UI/水晶换挡/杯架/高音罩/仪表台镀铬条"], "confidence": 0.97},
    {"id": "img-cutaway", "view": "cutaway profile", "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1}, "observations": ["四座布局/中岛贯通/座椅排布/滑轨"], "confidence": 0.9},
    {"id": "img-rearseat", "view": "rear-seats close", "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1}, "observations": ["菱格绗缝/头枕压标/腿托/侧扶手/镀铬件/长绒地毯"], "confidence": 0.95},
    {"id": "img-popup3", "view": "rear-seat detail", "imageRegion": {"x": 0, "y": 0, "width": 1, "height": 1}, "observations": ["菱格/腿托展开/扶手镀铬/安全带扣红"], "confidence": 0.9},
]
d["assumptions"] = [
    "正脸/正尾正视角度由 45° 图反推，头部高度关系为推算值（speculative）",
    "门缝精确走向按 MPV 惯例（前门/滑门/尾门），面板分缝用窄暗缝表达",
    "轮拱无切口：用黑色护缘环覆盖，侧视轮廓完整性优先",
    "内饰绛红配色为另一官方版，本模型取金版暖棕橙",
    "胎壁品牌字、引擎舱、底盘件不在复刻范围",
    "沙发窗帘仅静态垂坠形态（不含收放动画）",
]
d["risks"] = [
    "extrude 侧轮廓方案正视圆角不足 → material/lighting pass 前在 form pass 用 bevel+分段轮廓修正",
    "instanced 星点 320+辐条 48+点阵 160 需要 mergeSafe 纪律（indexed 一致性）",
    "transmission 材质（玻璃/水晶）触发透射 pass，DC 预算紧张 → 全部挂 quality 档",
    "内饰 60+ 组件全部在 cabin 视角可见，near=0.05 需验证无裁剪",
]
d["performanceBudget"].update({"qualityPriority": "balanced-hero", "targetTriangles": 58000, "maxDrawCalls": 42, "textureSize": 1024, "fpsTarget": 60, "optimizationPolicy": "instanced repetition + shared materials + quality-tier gates for transmission"})
d["animationAnchors"] = [
    {"id": "wheel-spin", "componentRefs": ["wheel-fl", "wheel-fr", "wheel-rl", "wheel-rr"], "channel": "rotateX", "note": "滚动动画；cap 子件反向锁定"},
    {"id": "steering-tilt", "componentRefs": ["steering"], "channel": "rotateLocalZ", "note": "随前轮转角微转"},
    {"id": "exterior-interior-toggle", "componentRefs": ["cabin-interior", "greenhouse-glass"], "channel": "visibility", "note": "cabin 视角保证内视"},
    {"id": "lamp-states", "componentRefs": ["lantern-core-l", "lantern-core-r", "high-mount-stop", "headlamp-led-l", "headlamp-led-r"], "channel": "emissiveIntensity", "note": "刹车灯/头灯联动由集成层驱动"},
]
d.setdefault("lookDevTargets", {})["qualityPriority"] = "realtime-balanced"
d["qualityTargets"].update({
    "targetFidelity": 0.88,
    "mustMatch": ["整车轮廓比例", "竖向大灯总成", "宫灯尾灯", "双拼涂装+镀铬带", "内饰身份包（星空顶/菱格座椅/三联屏/方向盘/中岛）"],
    "niceToHave": ["门缝表达", "油箱盖片", "翼子板标", "出风口栅叶"],
    "fpsTarget": 60,
    "reviewViewpoints": ["side-left", "front-45-high", "rear-45", "cabin-driver", "cabin-rear-starlight", "rear-seat-close"],
})
d["sculptPipeline"]["currentPass"] = "blockout"
d["referenceCamera"].update({"solved": True, "fovDegrees": 30, "aspect": 2.78, "orientation": {"yaw": 90, "pitch": 8, "roll": 0}, "positionHint": [0, 0.9, 9.5], "note": "侧视图近似正交长焦；review 渲染用同 FOV 对齐"})

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
d["componentTree"] = comps
SP.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"SPEC FILLED: {len(comps)} components, {len(d['materials'])} materials, {len(d['repetitionSystems'])} repetition systems")
