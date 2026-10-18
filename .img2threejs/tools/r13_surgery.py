# R13 尾部改直 + chrome-brow 缩放修复
# 白名单: object-sculpt-spec.json
import json, math, sys

P = '.img2threejs/object-sculpt-spec.json'
spec = json.load(open(P, encoding='utf-8'))
comps = {c['id']: c for c in spec['componentTree']}

def shoelace(pts):
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i][0], pts[i][1]
        x2, y2 = pts[(i + 1) % len(pts)][0], pts[(i + 1) % len(pts)][1]
        s += x1 * y2 - x2 * y1
    return s / 2

def arc(cx, cy, r, a0, a1, n=4):
    """a0→a1 度，n 段折线（含两端）"""
    out = []
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        out.append([round(cx + r * math.cos(a), 4), round(cy + r * math.sin(a), 4)])
    return out

changes = []

# ---------- 1. chrome-brow: scale.y 0.82 → 0.09（白板根因） ----------
cb = comps['chrome-brow']
assert cb['transform']['scale'] == [1.84, 0.82, 0.06], cb['transform']['scale']
cb['transform']['scale'] = [1.84, 0.09, 0.06]
cb['notes'] = (cb.get('notes', '') + ' | R13：scale.y 0.82→0.09（dims.height=0.09 为真值；0.82 系历史误写，'
               '导致 1.84×0.82m 铬板盖满前脸并吞掉 maextro-mark/shield-logo 下半）。').strip()
changes.append('chrome-brow scale [1.84,0.82,0.06]→[1.84,0.09,0.06]')

# ---------- 2. body-lower：尾部轮廓改垂直平面 z=-2.82，角 r0.05/r0.04 ----------
bl = comps['body-lower']
pts = bl['geometryDescriptor']['profile2D']['points']
# 定位旧尾部段（从 -2.4906 到 -2.7072）
i1 = next(i for i, p in enumerate(pts) if p[0] < -2.49 and p[1] > 1.0)
i2 = next(i for i, p in enumerate(pts) if p[0] < -2.70 and p[1] < 0.6)
old = pts[i1:i2 + 1]
new = (
    arc(-2.77, 0.985, 0.05, 90, 180) +      # 顶角 r0.05（腰线→尾立面，首点=(-2.77,1.035) 接腰线）
    [[-2.82, 0.625]] +
    arc(-2.78, 0.625, 0.04, 180, 270) +     # 底角 r0.04（尾立面→保险杠内收）
    [[-2.7072, 0.565]] +                    # 回接原底部内收起点
    []
)
pts[i1:i2 + 1] = new
assert shoelace(pts) > 0, f'body-lower winding {shoelace(pts)}'
bl['geometryDescriptor']['topologyIntent'] = '连续车身侧面轮廓挤出体；R13 尾部立直：后脸 z=-2.82 垂直平面（y0.625–0.985），顶角 r0.05、底角 r0.04，尾缘侧视接近铅垂线'
changes.append(f'body-lower 尾段 {len(old)}点→{len(new)}点 (z=-2.82 立直)')

# ---------- 3. greenhouse-glass：后缘立直 z=-2.82，上下角 r0.05 ----------
gg = comps['greenhouse-glass']
pts = gg['geometryDescriptor']['profile2D']['points']
i1 = next(i for i, p in enumerate(pts) if p[0] < -2.5 and p[1] > 1.7)   # [-2.6,1.758] 后第一个
# 旧段: [-2.715,1.75]...[-2.6,1.152]
i2 = next(i for i, p in enumerate(pts) if p[0] < -2.5 and 1.1 < p[1] < 1.2)
old = pts[i1:i2 + 1]
new = (
    arc(-2.77, 1.708, 0.05, 90, 180) +      # 顶角 r0.05（顶边 y1.758→立面）
    [[-2.82, 1.21]] +
    arc(-2.77, 1.21, 0.05, 180, 270) +      # 底角 r0.05（立面→玻璃带下沿）
    [[-2.6, 1.152]] +                       # 回接原玻璃带下沿
    []
)
pts[i1:i2 + 1] = new
assert shoelace(pts) > 0, f'greenhouse winding {shoelace(pts)}'
gg['geometryDescriptor']['topologyIntent'] = 'continuous dark DLO band；R13 后缘立直：玻璃带后缘 z=-2.82 垂直（与 body-lower 尾面齐平），顶/底角 r0.05'
changes.append(f'greenhouse-glass 后段 {len(old)}点→{len(new)}点 (z=-2.82 立直)')

# ---------- 4. roof-panel：后缘外扩至 z=-2.825（压住玻璃后缘 5mm），顶角 r0.04 ----------
rp = comps['roof-panel']
pts = rp['geometryDescriptor']['profile2D']['points']
i1 = next(i for i, p in enumerate(pts) if p[0] < -2.7 and p[1] > 1.83)   # [-2.7342,1.8402]
i2 = next(i for i, p in enumerate(pts) if p[0] < -2.77 and 1.5 < p[1] < 1.7)  # [-2.778,1.64]
old = pts[i1:i2 + 1]
new = (
    arc(-2.785, 1.808, 0.04, 90, 180) +
    [[-2.825, 1.64]]
)
pts[i1:i2 + 1] = new
assert shoelace(pts) > 0, f'roof winding {shoelace(pts)}'
rp['geometryDescriptor']['topologyIntent'] = 'roof shell；R13 后缘外扩至 z=-2.825（覆盖玻璃后缘上沿），顶角 r0.04'
changes.append(f'roof-panel 后段 {len(old)}点→{len(new)}点 (z=-2.825)')

# ---------- 5. tailgate：面位 -2.883→-2.825（body 面 +5mm），角改 r0.05 ----------
tg = comps['tailgate']
tg['transform']['position'][2] = -2.79
sh = tg['geometryDescriptor']['profile2D'].get('shaping')
if sh and 'nodeOffset' in sh:
    sh['nodeOffset'][2] = -2.79
pr = tg['geometryDescriptor']['profile2D']['points']
assert pr[0] == [-0.93, -0.42], pr[0]
new_pr = [[-0.93, -0.475], [-0.88, -0.525], [0.88, -0.525], [0.93, -0.475],
          [0.93, 0.475], [0.88, 0.525], [-0.88, 0.525], [-0.93, 0.475]]
tg['geometryDescriptor']['profile2D']['points'] = new_pr
assert shoelace(new_pr) > 0, f'tailgate winding {shoelace(new_pr)}'
tg['geometryDescriptor']['edgeTreatment']['bevelRadius'] = 0.05
for d in tg['geometryDescriptor'].get('deformationStack', []):
    if d.get('type') == 'fillet':
        d['radius'] = 0.05
        d['notes'] = 'R13 尾门四角 r0.05（原 r0.14 弧角与「后角≤5cm」要求冲突）'
tg['geometryDescriptor']['topologyIntent'] = 'flat vertical tailgate panel (MPV straight tail); R13 尾门面 -2.883→-2.825（body 尾面 +5mm），四角 r0.05'
tg['dimensions']['depth'] = 0.07
changes.append('tailgate 面位→-2.825、角 r0.14→r0.05')

# ---------- 6. tail-chrome-strip：z=-2.835→-2.83（尾门面外 5mm，原半埋） ----------
tcs = comps['tail-chrome-strip']
tcs['transform']['position'][2] = -2.83
changes.append('tail-chrome-strip z→-2.83')

# ---------- 7. dpillar-l/r：后缘跟随玻璃面外移（z -2.45→-2.55, 深 0.34→0.46） ----------
for sid in ('dpillar-l', 'dpillar-r'):
    d = comps[sid]
    d['transform']['position'][2] = -2.55
    d['transform']['scale'][2] = 0.46
    d['dimensions']['depth'] = 0.46
    d['notes'] = (d.get('notes', '') + ' | R13：z -2.45→-2.55、深 0.34→0.46，银白包边后缘跟随立直后的玻璃尾面（z=-2.82）').strip()
    changes.append(f'{sid} z→-2.55 depth→0.46')

json.dump(spec, open(P, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('OK — changes:')
for c in changes:
    print(' -', c)
print('shoelace all >0; components:', len(spec['componentTree']))
