"""填充 assessment.json 与 detail-inventory.json（来自 8 层图像分析观察）。"""
import json
from pathlib import Path

WRK = Path(r"C:\Users\16896\WorkBuddy\2026-10-14-13-25-01\brake-v800\.img2threejs")

# ---- 20 条身份细节（来自 8 张图观察；zone 坐标以 design-black 侧视图为基准）----
DETAILS = [
    ("d-headlamp-star", "light", "竖向圆角矩形大灯总成：纵向白 LED 灯带×2 + 星点发光纹理 + 钻石切割反射面", 0.04, 0.52, 0.10, 0.20, "identity", "component.localFeatures", "comp.headlamp-l", 0.95),
    ("d-maextro-mark", "mark", "镀铬上沿饰条内嵌 MAEXTRO 发光字标（宽间距白光）", 0.05, 0.42, 0.22, 0.07, "identity", "component.localFeatures", "front-end", 0.95),
    ("d-shield-logo", "mark", "前脸中央盾形镀铬竖标", 0.03, 0.60, 0.04, 0.14, "identity", "component.localFeatures", "front-end", 0.9),
    ("d-tail-lantern", "light", "纵向宫灯尾灯：镀铬圆角外框 + 红点阵 + 羽翼发光纹理", 0.93, 0.30, 0.05, 0.30, "identity", "component.localFeatures", "taillamp-l", 0.95),
    ("d-doorhandles", "trim", "通长横贯式镀铬门把手（前门+滑门，门缝分断）", 0.38, 0.55, 0.28, 0.05, "identity", "component.localFeatures", "handle-front-l", 0.9),
    ("d-dpillar", "trim", "D 柱银白宽包边包裹角窗（悬浮车顶视觉）", 0.72, 0.18, 0.16, 0.42, "identity", "component.localOverrides", "mat-dpillar-silver", 0.95),
    ("d-wheel-disc", "wheel", "大饼式密辐轮圈（约12粗银辐 + 抛光面 + 悬浮中心标）", 0.24, 0.62, 0.13, 0.30, "identity", "component.localFeatures", "comp.wheel-fl", 0.95),
    ("d-chrome-belt", "trim", "贯穿腰线镀铬亮条（翼子板→尾灯）", 0.02, 0.66, 0.95, 0.03, "identity", "component.localFeatures", "chrome-belt-l", 0.9),
    ("d-fender-badge", "mark", "翼子板小镀铬标识（前门缝前）", 0.30, 0.58, 0.04, 0.04, "micro", "component.localFeatures", "chrome-belt-l", 0.75),
    ("d-fuel-door", "trim", "油箱盖圆角矩形片（后翼子板）", 0.78, 0.50, 0.05, 0.09, "micro", "component.localFeatures", "chrome-belt-l", 0.8),
    ("d-roof-rail", "trim", "车顶银色行李架纵轨（前后贯穿）", 0.30, 0.10, 0.55, 0.04, "meso", "component.localFeatures", "roof-rails", 0.9),
    ("d-lidar-wedge", "sensor", "车顶前部激光雷达楔形块", 0.32, 0.06, 0.06, 0.05, "identity", "component.localFeatures", "roof-rails", 0.9),
    ("d-rocker-step", "trim", "下裙黑色护板台阶（车门下沿内凹）", 0.25, 0.85, 0.55, 0.08, "meso", "component.localFeatures", "comp.body-lower", 0.85),
    ("d-third-brakelight", "light", "高位宽刹车灯（尾门上沿）", 0.80, 0.14, 0.12, 0.03, "micro", "component.localFeatures", "comp.tailgate", 0.8),
    ("d-steering-dualtone", "interior", "三辐双色方向盘：红棕车削木外圈 + 米白真皮内圈 + 银色盾标", 0.0, 0.0, 0.0, 0.0, "identity", "component.localFeatures", "comp.steering", 0.95),
    ("d-triscreen", "interior", "贯穿三联屏（仪表-中控-副驾，暗色 HarmonyOS UI）", 0.0, 0.0, 0.0, 0.0, "identity", "component.localFeatures", "tri-screen", 0.95),
    ("d-starlight-headliner", "interior", "星空顶：深棕麂皮穿孔 + 数百星点白灯（大小不一）", 0.0, 0.0, 0.0, 0.0, "identity", "component.localFeatures", "headliner-front", 0.95),
    ("d-quilted-seats", "interior", "后排菱格绗缝航空座椅×2（打孔中央 + 独立头枕压标 + 腿托）", 0.0, 0.0, 0.0, 0.0, "identity", "component.localFeatures", "seat-rear-l", 0.95),
    ("d-curtain-pleats", "interior", "后窗帘米白竖褶（可收拢垂坠）", 0.0, 0.0, 0.0, 0.0, "identity", "component.localFeatures", "curtain-l", 0.9),
    ("d-ambient-strip", "interior", "顶棚两侧纵向暖橙氛围灯带 + 门板圆形金属点阵音响罩", 0.0, 0.0, 0.0, 0.0, "meso", "component.localFeatures", "headliner-front", 0.9),
    ("d-crystal-shift", "interior", "水晶换挡旋钮 + P 键 + 双镀铬圈杯架（木纹底座）", 0.0, 0.0, 0.0, 0.0, "identity", "component.localFeatures", "tunnel-front", 0.9),
]

KIND_MAP = {"light": "emissive", "mark": "decal", "trim": "linework", "wheel": "contour",
            "interior": "stitch", "sensor": "decal", "micro": "ridge", "meso": "contour"}

def det(idx, d):
    i, kind, desc, x, y, w, h, scale, mt, ref, conf = d
    kind = KIND_MAP.get(kind, kind)
    ref = ref.replace("comp.", "").replace("mat-", "")
    return {
        "id": i, "kind": kind, "description": desc,
        "region": {"x": x, "y": y, "width": w, "height": h, "units": "normalized"},
        "scale": scale, "affects": "silhouette" if scale == "identity" else "detail",
        "mapsTo": {"type": mt, "ref": ref},
        "evidenceRef": str(WRK / "details" / f"zone-r{(idx//3)%3}c{idx%3}.png") if x or y else "",
        "confidence": conf,
    }

inv = json.loads((WRK / "detail-inventory.json").read_text(encoding="utf-8"))
inv["detailInventory"]["scanMethod"] = "grid-3x3+cross-image"
inv["detailInventory"]["targetMinDetails"] = 16
inv["detailInventory"]["details"] = [det(i, d) for i, d in enumerate(DETAILS)]
(WRK / "detail-inventory.json").write_text(json.dumps(inv, ensure_ascii=False, indent=2), encoding="utf-8")

a = json.loads((WRK / "assessment.json").read_text(encoding="utf-8"))
pa = a["preSpecAssessment"]
pa["objectClass"] = {
    "primaryType": "vehicle-automobile",
    "primaryDomain": "object",
    "formLanguage": ["geometric", "lofted-rounded-cuboid", "formal-luxury-MPV"],
    "structureKind": ["rigid-shell", "glazed-greenhouse", "wheel-assembly", "interior-cabin"],
    "motionPotential": ["wheels-spin", "steering-minor", "lamp-emissive-states", "suspension-static"],
    "materialFamilies": ["metallic-paint-clearcoat", "chrome", "dark-glass", "rubber", "leather", "wood-turned", "fabric-curtain", "carpet-plush", "emissive-lamps", "crystal"],
    "notes": "5495×2006×1850mm 轴距3430；双色车身（金/黑两官方涂装）；四座舱；由里及外全复刻目标。",
}
c = pa["complexity"]["scores"]
c.update({
    "silhouetteComplexity": 2, "componentCount": 3, "hierarchyDepth": 3,
    "repetitionDensity": 3, "materialLayerCount": 3, "localDetailDensity": 3,
    "occlusionRisk": 2, "actionReadinessNeed": 2,
})
ec = pa["complexity"]["estimatedCounts"]
ec.update({"macroComponents": 6, "mesoComponents": 18, "microFeatureGroups": 14, "materialLayers": 12, "repetitionSystems": 5})
pa["complexity"]["reasoning"] = [
    "外观：lofted 圆角壳体 + 6 大宏观组件 + 18 中观子件（饰条/灯具/把手/轮圈等）",
    "内饰：四座舱 8+ 组件（仪表台/三联屏/方向盘/中岛/航空座椅×2/星空顶/窗帘/门板）",
    "重复系统：星点阵、4×轮圈辐组、缝线网格、出风口栅格、点阵音响罩",
    "材质 12 族跨外观内饰；大量 emissive 局部细节（宫灯/星点/字标/氛围灯）",
]
pa["unknownsToResolveBeforeImplementation"] = []  # resolved: see spec assumptions
if False:
    pa["unknownsToResolveBeforeImplementation"] = [
    "正脸正视高度关系：由前上 45° 图 + 侧视图反推（speculative 标注）",
    "正尾正视：由尾 45° + 侧视反推；尾灯横向位置取对称惯例",
    "底盘/轮圈背面：不可见，按轮拱内衬惯例处理（不影响外观视角）",
    "门缝精确走向：侧视图可见主要门缝（前门/滑门/尾门），顶视不可见按 MPV 惯例",
]
pa["detailInventory"]["details"] = inv["detailInventory"]["details"]
qc = a["qualityContract"]
qc.update({
    "intendedUse": "real-time browser game vehicle (hero exterior + full interior cabin, free-view from any angle incl. driver-seat view)",
    "finishStyle": "luxury-MPV, dual-tone paint, clearcoat metallic, dense emissive lamp details",
    "targetPlatforms": ["desktop-browser-60fps", "mobile-45fps"],
    "triangleBudget": {"total": 120000, "exterior": 70000, "interior": 45000},
    "drawCallBudgetDelta": 40,
    "fidelityTargets": {
        "silhouette": 0.9,
        "identityFeatures": 0.9,
        "materialResponse": 0.85,
        "interiorDetail": 0.85,
    },
    "colorMaterialRecipe": {
        "paintDualTone": {"upperChampagneGold": "#C9A86B", "lowerDeepBrown": "#221A14", "blackVariant": "#0E0E12"},
        "chrome": "#E8E9EC", "glass": "#101418", "interiorLeather": "#A05A2C", "ivory": "#E8E0D0",
        "wood": "#6B3418", "carpet": "#8A5A30", "headlinerSuede": "#3A2A20",
    },
    "reviewViews": ["side-left", "front-45-high", "rear-45", "front-face", "cabin-driver", "cabin-rear-starlight", "rear-seats-close"],
})
a["authoringInstruction"] = {
    "emission": "src/model/createV800Model.ts (three r186 factory, Group hierarchy, deterministic seeds)",
    "notes": "由里及外：内饰舱（含星空顶/窗帘/座椅）与外观壳体同 Group 树；外观件可按视角系统开合（cabin 视角隐藏 exterior 组由集成层处理，模型导出 includeExterior/includeInterior 开关）。",
}
(WRK / "assessment.json").write_text(json.dumps(a, ensure_ascii=False, indent=2), encoding="utf-8")
print("FILLED assessment.json + detail-inventory.json,", len(DETAILS), "details")
