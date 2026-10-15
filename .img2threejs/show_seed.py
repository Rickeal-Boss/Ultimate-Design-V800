"""查看 seed 的关键 section。"""
import json

d = json.load(open(r"<workspace>/.img2threejs/object-sculpt-spec.json", encoding="utf-8"))
out = {
    "buildPasses": d["buildPasses"],
    "featureReviewTargets": d["featureReviewTargets"],
    "coordinateFrame": d["coordinateFrame"],
    "silhouette": d["silhouette"],
    "performanceBudget": d["performanceBudget"],
    "actionReadiness": {k: v for k, v in d["actionReadiness"].items() if k in ("contract", "requiredComponentFields", "transformChannels")},
    "qualityTargets": d["qualityTargets"],
    "proceduralStrategy": d["proceduralStrategy"],
    "componentTree_seed": d["componentTree"][0],
    "materials_seed": d["materials"][0],
}
print(json.dumps(out, ensure_ascii=False, indent=1)[:6000])
