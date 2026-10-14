"""strict 修复第二波：detail kind/ref 映射、embedDepth、proto 注入顺序。"""
import json
from pathlib import Path

WRK = Path(r"C:\Users\16896\WorkBuddy\2026-10-14-13-25-01\brake-v800\.img2threejs")

# ---------- fill_assessment.py: kind 映射 + ref 清洗 ----------
fa = WRK / "fill_assessment.py"
s = fa.read_text(encoding="utf-8")
s = s.replace('''def det(idx, d):
    i, kind, desc, x, y, w, h, scale, mt, ref, conf = d
    return {''', '''KIND_MAP = {"light": "emissive", "mark": "decal", "trim": "linework", "wheel": "contour",
            "interior": "stitch", "sensor": "decal", "micro": "ridge", "meso": "contour"}

def det(idx, d):
    i, kind, desc, x, y, w, h, scale, mt, ref, conf = d
    kind = KIND_MAP.get(kind, kind)
    ref = ref.replace("comp.", "").replace("mat-", "")
    return {''')
fa.write_text(s, encoding="utf-8")

# ---------- build_spec.py ----------
bs = WRK / "build_spec.py"
t = bs.read_text(encoding="utf-8")

# 1) embedDepth=0 -> 0.002（attachment_is_complete 要求 >0）
t = t.replace('"contactType": "butt", "embedDepth": 0, "gapTolerance": 0.003}',
              '"contactType": "butt", "embedDepth": 0.002, "gapTolerance": 0.003}')
t = t.replace('"contactType": "socket", "embedDepth": 0, "gapTolerance": 0.002}',
              '"contactType": "socket", "embedDepth": 0.002, "gapTolerance": 0.002}')

# 2) 把注入循环从 componentTree 赋值处搬到文件尾
INJ_START = 'def _hex2rgba(h, a=1.0):'
INJ_END = 'd["componentTree"] = comps'
i0 = t.index(INJ_START)
i1 = t.index(INJ_END) + len(INJ_END)
inj = t[i0:i1]
t = t[:i0] + 'd["componentTree"] = comps' + t[i1:]
# 在写盘前重新执行注入（覆盖 proto 组件）并重赋 componentTree
t = t.replace('SP.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")',
              inj.replace('d["preSpecAssessment"] = pa\n', '') + '\nSP.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")')
bs.write_text(t, encoding="utf-8")
print("PATCHED-2")
