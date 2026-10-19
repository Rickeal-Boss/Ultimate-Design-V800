"""R17 spec modifications: P0-1 tail lamp, P0-2 rear profile, P0-3 sunroof, P0-4 headlamp alignment.
Usage: r17_apply.py
"""
import json, copy, sys

BASE = r'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/.img2threejs'
SPEC = f'{BASE}/object-sculpt-spec.json'

spec = json.load(open(SPEC, encoding='utf-8'))
tree = spec['componentTree']
cmap = {c['id']: c for c in tree}

changes = []

def log(msg):
    changes.append(msg)
    print(msg)

# ─── Deletions (free budget for new components) ───
for fid in ['seat-rear-l-plate', 'seat-rear-r-plate']:
    if fid in cmap:
        tree.remove(cmap[fid])
        del cmap[fid]
        log(f'DELETE {fid} (bronze-dark 0.05x0.022, no visual value)')

# ─── P0-1: Tail lamp fixes ───

# 1. lantern-signature: restore lamp-gold eagle pattern (was lamp-amber white blob)
for fid in ['lantern-signature-l', 'lantern-signature-r']:
    c = cmap[fid]
    old_mat = c['material']
    old_pos = c['transform']['position']
    old_scale = c['transform']['scale']
    old_dims = c['dimensions']
    c['material'] = 'lamp-gold'
    c['transform']['position'] = [0, 0, 0.0375]
    c['transform']['scale'] = [0.09, 0.135, 0.002]
    c['dimensions']['width'] = 0.09
    c['dimensions']['height'] = 0.135
    c['dimensions']['depth'] = 0.002
    log(f'P0-1 {fid}: mat {old_mat}->lamp-gold | pos {old_pos}->[0,0,0.0375] | scale {old_scale}->[0.09,0.135,0.002] | dims {old_dims["width"]}x{old_dims["height"]}->0.09x0.135')

# 2. lantern-bezel: tighten fit to housing (scale profile 0.96 from housing)
housing_pts = cmap['taillamp-l']['geometryDescriptor']['profile2D']['points']
for fid in ['lantern-bezel-l', 'lantern-bezel-r']:
    c = cmap[fid]
    old_pts = c['geometryDescriptor']['profile2D']['points']
    old_dims = c['dimensions']
    # Scale housing profile by 0.96 for tighter fit
    new_pts = [[round(p[0] * 0.96, 4), round(p[1] * 0.96, 4)] for p in housing_pts]
    c['geometryDescriptor']['profile2D']['points'] = new_pts
    c['dimensions']['width'] = round(0.17 * 0.96, 4)
    c['dimensions']['height'] = round(0.46 * 0.96, 4)
    log(f'P0-1 {fid}: profile scaled 0.96 from housing | dims {old_dims["width"]}x{old_dims["height"]}->{c["dimensions"]["width"]}x{c["dimensions"]["height"]}')

# ─── P0-2: Rear profile — add rear bumper chrome strip ───
# Template: use tail-chrome-strip as base (same primitive/material/profile style)
tail_chrome = cmap['tail-chrome-strip']
rear_chrome = copy.deepcopy(tail_chrome)
rear_chrome['id'] = 'rear-chrome-strip'
rear_chrome['name'] = '后保底部镀铬条'
rear_chrome['parent'] = 'root'
rear_chrome['transform']['position'] = [0, 0.32, -2.828]
rear_chrome['transform']['rotation'] = [0, 3.141592653589793, 0]
rear_chrome['transform']['scale'] = [1.6, 0.025, 0.015]
rear_chrome['dimensions']['width'] = 1.6
rear_chrome['dimensions']['height'] = 0.025
rear_chrome['dimensions']['depth'] = 0.015
tree.append(rear_chrome)
cmap['rear-chrome-strip'] = rear_chrome
log(f'P0-2 ADD rear-chrome-strip: chrome, pos [0,0.32,-2.828], scale [1.6,0.025,0.015]')

# ─── P0-3: Sunroof glass ───
# Template: use windshield as base (extrude + rounded-rect profile)
windshield = cmap['windshield']
sunroof = copy.deepcopy(windshield)
sunroof['id'] = 'sunroof-glass'
sunroof['name'] = '车顶玻璃天窗'
sunroof['material'] = 'glass-dark'
sunroof['parent'] = 'root'
sunroof['transform']['position'] = [0, 1.836, -0.5]
sunroof['transform']['rotation'] = [-1.5707963267948966, 0, 0]  # rotX(-pi/2), face up
sunroof['transform']['scale'] = [1.7, 2.0, 0.004]
sunroof['dimensions']['width'] = 1.7
sunroof['dimensions']['height'] = 2.0
sunroof['dimensions']['depth'] = 0.004
# Clear notes/evidence that are windshield-specific
sunroof['notes'] = 'R17: 车顶前中段玻璃天窗（风挡后缘到尾门前缘之间），glass-dark 隐私玻璃'
sunroof['evidenceRefs'] = ['img-roof-sunroof']
sunroof['localFeatures'] = [{'name': '车顶玻璃面板', 'kind': 'surface', 'note': 'R17 新增：车顶前中段改玻璃，与侧窗 greenhouse-glass 同材质'}]
tree.append(sunroof)
cmap['sunroof-glass'] = sunroof
log(f'P0-3 ADD sunroof-glass: glass-dark, pos [0,1.836,-0.5], rot [-pi/2,0,0], scale [1.7,2.0,0.004]')

# ─── P0-4: Headlamp alignment — center star and LED strip at x=0 ───
for fid in ['headlamp-star-l', 'headlamp-star-r', 'headlamp-led-l', 'headlamp-led-r']:
    c = cmap[fid]
    old_x = c['transform']['position'][0]
    c['transform']['position'][0] = 0.0
    log(f'P0-4 {fid}: pos.x {old_x}->0.0 (center alignment)')

# ─── Save ───
with open(SPEC, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(spec, f, indent=1, ensure_ascii=False)
    f.write('\n')

print(f'\n=== Done: {len(tree)} components (was 185) ===')
print(f'=== {len(changes)} changes applied ===')
