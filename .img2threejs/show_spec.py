"""查看 spec 顶层 schema。"""
import json

d = json.load(open(r"C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs/object-sculpt-spec.json", encoding="utf-8"))
print("TOP KEYS:", list(d.keys()))
for k, v in d.items():
    if isinstance(v, list):
        sample = ""
        if v and isinstance(v[0], dict):
            sample = " keys:" + str(list(v[0].keys()))
        print(f"{k}: list x{len(v)}{sample}")
    elif isinstance(v, dict):
        print(f"{k}: dict keys:{list(v.keys())[:10]}")
    else:
        print(f"{k}: {type(v).__name__} = {str(v)[:60]}")
