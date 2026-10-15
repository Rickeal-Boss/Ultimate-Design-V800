"""查看 seed 组件与 attachment 完整结构。"""
import json

d = json.load(open(r"<workspace>/.img2threejs/object-sculpt-spec.json", encoding="utf-8"))
print(json.dumps(d["componentTree"][0], ensure_ascii=False, indent=1))
print("---MATERIAL SEED---")
print(json.dumps(d["materials"][0], ensure_ascii=False, indent=1))
print("---REPETITION EMPTY, ANCHORS---")
print(json.dumps(d["animationAnchors"], ensure_ascii=False, indent=1))
