# 逐组件 world box 核验：spec 尺寸/位置 vs 运行时实测
# 用法: python3 check_parts.py <spec> <parts.json> <out.json>
import json, sys, math

spec_path, parts_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
spec = json.load(open(spec_path, encoding='utf-8'))
parts = json.load(open(parts_path, encoding='utf-8'))

comp_by_id = {c['id']: c for c in spec['componentTree']}
part_by_id = {p['id']: p for p in parts}

rows = []
for cid, c in comp_by_id.items():
    p = part_by_id.get(cid)
    if p is None:
        rows.append({'id': cid, 'level': c.get('level'), 'status': 'MISSING_IN_RUNTIME'})
        continue
    dims = c.get('dimensions') or {}
    w = dims.get('width'); h = dims.get('height'); d = dims.get('depth') or dims.get('length')
    size = p.get('size')  # [x,y,z] world box size
    notes = []
    ok = True
    # 尺寸比对（容差 8% 或 0.02m，取大者）——注意 world box 会含子组件，只对叶子严格
    if w and h and d and size:
        exp = [w, h, d]
        got = size
        rel = [abs(g - e) / max(e, 1e-6) for g, e in zip(got, exp)]
        # 允许 world box 比声明尺寸大（含子件），不允许明显小于声明
        shrink = [e - g for g, e in zip(got, exp)]
        max_shrink = max(shrink)
        if max_shrink > max(0.02, 0.05 * max(exp)):
            ok = False
            notes.append(f'shrink: exp={exp} got={got}')
    # 悬浮检测：与父组件 world box 的垂直/水平包含关系
    pid = c.get('parent')
    if pid and pid in part_by_id:
        pp = part_by_id[pid]
        pmin = pp.get('worldMin'); cmin = p.get('worldMin')
        if pmin and cmin:
            # 组件中心相对父盒中心，检查是否在父盒半径 3 倍以内
            pcx = pmin[0] + size[0]/2; pcy = pmin[1] + size[1]/2; pcz = pmin[2] + size[2]/2
            fcx = pp['worldMin'][0] + pp['size'][0]/2
            fcy = pp['worldMin'][1] + pp['size'][1]/2
            fcz = pp['worldMin'][2] + pp['size'][2]/2
            dist = math.dist([pcx, pcy, pcz], [fcx, fcy, fcz])
            pr = max(pp['size']) 
            if dist > max(1.5, pr * 1.6):
                ok = False
                notes.append(f'far-from-parent: dist={round(dist,3)} parentHalf={round(pr/2,3)}')
    rows.append({
        'id': cid, 'level': c.get('level'), 'parent': c.get('parent'),
        'status': 'OK' if ok else 'CHECK',
        'size': size, 'worldMin': p.get('worldMin'),
        'declared': [dims.get('width'), dims.get('height'), dims.get('depth') or dims.get('length')],
        'notes': notes,
    })

n_ok = sum(1 for r in rows if r['status'] == 'OK')
n_check = sum(1 for r in rows if r['status'] == 'CHECK')
n_missing = sum(1 for r in rows if r['status'] == 'MISSING_IN_RUNTIME')
summary = {'total': len(rows), 'ok': n_ok, 'check': n_check, 'missing': n_missing,
           'runtimePartCount': len(parts), 'specComponentCount': len(comp_by_id)}
json.dump({'summary': summary, 'rows': rows}, open(out_path, 'w', encoding='utf-8'),
          ensure_ascii=False, indent=1)
print(json.dumps(summary, ensure_ascii=False))
for r in rows:
    if r['status'] != 'OK':
        print(r['status'], r['id'], r.get('notes', ''), r.get('size'), 'declared=', r.get('declared'))
