"""R15-1：三联屏下移 9.1cm + 减薄 1/3，让出正前方路面。

依据（r15_cabin 探针 + 几何反算）：
- 旧 tri-screen 世界 bbox y 0.9733~1.2867，眼点 1.33 → 屏幕顶只低 4.3cm，
  俯角仅 2.9°（距离 0.84m）；而 30m 处路面俯角 2.5° ⇒ **只有 63m 以外**的路面可见。
- 新：y 1.09 / 高 0.212 → 世界顶 1.196，俯角 9.1° → 8.3m 以外路面全可见。
- 底沿 0.984 与 dash-upper 顶面 1.0124 轻微互嵌 2.8cm = 屏幕嵌入台面的真实观感，
  UI 画布按整块平面映射，被遮的是下边框而非内容。

写回纪律：indent=1 + LF + ensure_ascii=False（默认 indent=2/CRLF 会造 9 万行 diff 噪声）。
"""
import json
from pathlib import Path

SP = Path('.img2threejs/object-sculpt-spec.json')
d = json.loads(SP.read_text(encoding='utf-8'))
d['componentTree'] = list(d['componentTree'])

WANT = {
    'tri-screen': {'pos': [0, 1.09, 1.42], 'scale': [1.52, 0.212, 0.006]},
    'gauge-screen': {'pos': [0.72, 1.093, 1.426], 'scale': [0.36, 0.15, 0.005]},
}

changed = []
for c in d['componentTree']:
    cid = c.get('id')
    if cid in WANT:
        w = WANT[cid]
        old = (list(c['transform']['position']), list(c['transform']['scale']))
        c['transform']['position'] = w['pos']
        c['transform']['scale'] = w['scale']
        c['dimensions']['width'] = w['scale'][0]
        c['dimensions']['height'] = w['scale'][1]
        c['dimensions']['depth'] = w['scale'][2]
        changed.append((cid, old, (w['pos'], w['scale'])))

text = json.dumps(d, indent=1, ensure_ascii=False)
with open(SP, 'w', encoding='utf-8', newline='\n') as f:
    f.write(text + '\n')

for cid, old, new in changed:
    print(f'{cid}: pos {old[0]} -> {new[0]} | scale {old[1]} -> {new[1]}')
print('written', SP, len(text), 'chars')
