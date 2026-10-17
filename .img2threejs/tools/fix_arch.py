# -*- coding: utf-8 -*-
"""修复 body-lower 拱口：正确 227.5° 弧段（a1=203.76° 递减到 a2=-23.76°）。"""
import json, math
SPEC = r"C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs/object-sculpt-spec.json"
raw = open(SPEC, encoding='utf-8', newline='').read()
spec = json.loads(raw)
bl = next(c for c in spec['componentTree'] if c['id'] == 'body-lower')
pts = [list(p) for p in bl['geometryDescriptor']['profile2D']['points']]
# 当前 93 点：前 67 原始 + 26 蜗线错误点 → 截回 67，再插正确拱
base = pts[:67]
assert abs(base[-1][0] + 2.408) < 1e-6 and abs(base[0][0] - 2.219) < 1e-6, (base[0], base[-1])
R, CY, YB = 0.452, 0.382, 0.2
hw = math.sqrt(R*R - (CY-YB)**2)
def arch_points(zc):
    a2 = math.atan2(YB - CY, hw)          # -23.74deg（前侧拱脚）
    a1 = math.atan2(YB - CY, -hw) + 2*math.pi  # 203.74deg（后侧拱脚）
    n = 13
    out = []
    for k in range(n):
        a = a1 + (a2 - a1) * k / (n - 1)   # 单调递减 227.5°，经拱顶 90°
        out.append([round(zc + R*math.cos(a), 4), round(CY + R*math.sin(a), 4)])
    return out
new_pts = base + arch_points(-1.715) + arch_points(1.715)
def shoelace(p):
    s = 0.0
    for i in range(len(p)):
        x1,y1 = p[i]; x2,y2 = p[(i+1)%len(p)]
        s += x1*y2 - x2*y1
    return s/2
assert shoelace(new_pts) > 0, shoelace(new_pts)
ys = [p[1] for p in new_pts]
assert min(ys) >= 0.2 - 1e-9, min(ys)
bl['geometryDescriptor']['profile2D']['points'] = new_pts
out = json.dumps(spec, ensure_ascii=False, indent=1)
open(SPEC, 'w', encoding='utf-8', newline='').write(out.replace('\n','\r\n'))
print('arch fixed: pts', len(new_pts), 'minY', min(ys), 'shoelace', round(shoelace(new_pts),4))
print('rear arch pts:', arch_points(-1.715)[:3], '...', arch_points(-1.715)[-2:])
