# -*- coding: utf-8 -*-
"""R44-6 语义拆分正式版（主理人亲自）：
分件 GLB part 顶点哈希 → 染色版三角分组（glass / lamp_front / lamp_rear）
→ body 剔除三组重建 + glass/lamp 各自写 glb（保留染色版 UV，图集零改动）
复用 r44_bake: parse_glb / load_car_glb / build_glb / CARS / split_geometry 轮切割判据
"""
import os, sys, json, struct
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r44_bake as B

PART_SRC = {
    'v800': ('C:/Users/WB/Desktop/R7/拆/V8.glb', {
        'glass': [9, 5, 10],
        'lamp_rear': [6],
        'lamp_front': [14],
    }),
    'r7': ('C:/Users/WB/Desktop/R7/拆/R7.glb', {
        'glass': [3, 4, 6],
        'lamp_rear': [18],
        'lamp_front': [14],
    }),
}

def load_part_verts(path):
    gltf, binc = B.parse_glb(path)
    out = {}
    for mi, mesh in enumerate(gltf['meshes']):
        prim = mesh['primitives'][0]
        pos = B.read_accessor(gltf, binc, prim['attributes']['POSITION']).astype(np.float64)
        idx = B.read_accessor(gltf, binc, prim['indices']).reshape(-1, 3).astype(np.int64)
        out[mi] = (pos, idx)
    return out

def hkey(p):
    """量化 1e-4 → int64 key（坐标 ±6000 << 2^21 安全）"""
    q = np.round(p * 1e4).astype(np.int64)
    return (q[:, 0] << 42) | ((q[:, 1] + (1 << 20)) << 21) | (q[:, 2] + (1 << 20))

def rebuild(idx_mask, pos, nrm, uv, indices, name):
    """按三角掩码重建压缩顶点网格"""
    tris = indices[idx_mask]
    used = np.zeros(len(pos), bool)
    used[tris.reshape(-1)] = True
    remap = -np.ones(len(pos), np.int64)
    remap[used] = np.arange(used.sum())
    g = (pos[used].astype(np.float32), nrm[used].astype(np.float32),
         uv[used].astype(np.float32), remap[tris].astype(np.uint32))
    print(f"  {name}: {int(idx_mask.sum())} tri / {int(used.sum())} vtx")
    return g, used

def main():
    for car, (ppath, sem) in PART_SRC.items():
        cfg = B.CARS[car]
        print(f"\n=== {car} ===")
        pos, nrm, uv, indices = B.load_car_glb(os.path.join(B.SRC, cfg['geo_glb']))
        nv, nt = len(pos), len(indices)
        # 1) 轮切割判据（复刻 split_geometry，得到 body_tris 掩码）
        hubs = dict(cfg['hub_from_brief'])
        hw = cfg['tire_half_width']
        inside = {}
        for tag, (hx, hy, hz) in hubs.items():
            d = np.sqrt((pos[:, 1] - hy) ** 2 + (pos[:, 2] - hz) ** 2)
            inside[tag] = (np.abs(pos[:, 0] - hx) <= hw) & (d <= cfg['r_cut'])
        tri_x = pos[indices][:, :, 0]
        x_min, x_max = tri_x.min(1), tri_x.max(1)
        tri_inwheel = np.zeros(nt, bool)
        if car != 'v800':  # V800 切割退化=静态轮整车单 mesh（与现产一致）
            for tag, (hx, hy, hz) in hubs.items():
                slab = (x_min >= hx - hw - 0.012) & (x_max <= hx + hw + 0.012)
                tri_inwheel |= inside[tag][indices].all(1) & slab
        # 2) 语义匹配
        parts = load_part_verts(ppath)
        vh = hkey(pos)  # 染色版顶点 key
        tri_keys = np.stack([vh[indices[:, 0]], vh[indices[:, 1]], vh[indices[:, 2]]], 1)
        group_mask = {}
        for group, mis in sem.items():
            keys = set()
            for mi in mis:
                keys.update(hkey(parts[mi][0]).tolist())
            hit = np.zeros(nt, np.int8)
            for k in range(3):
                hit += np.fromiter((int(x) in keys for x in tri_keys[:, k]), bool, nt)
            group_mask[group] = hit >= 2
        # 3) 冲突消解：glass > lamp > body（理论上 part 不重叠）
        taken = np.zeros(nt, bool)
        for group in ('glass', 'lamp_front', 'lamp_rear'):
            group_mask[group] &= ~taken
            taken |= group_mask[group]
        body_mask = ~tri_inwheel & ~taken
        # 4) 重建写盘
        out_dir = os.path.join(B.OUT_ROOT, car)
        os.makedirs(out_dir, exist_ok=True)
        products = {}
        g, used = rebuild(body_mask, pos, nrm, uv, indices, 'body')
        products['body'] = g
        for group in ('glass', 'lamp_front', 'lamp_rear'):
            if group_mask[group].any():
                g, _ = rebuild(group_mask[group], pos, nrm, uv, indices, group)
                products[group] = g
        for name, (p, n, u, i) in products.items():
            glb = B.build_glb([(name, p, n, u, i)])
            with open(os.path.join(out_dir, f'{name}.glb'), 'wb') as f:
                f.write(glb)
            print(f"  -> {name}.glb {len(glb)/1e6:.1f}MB")
        # 5) manifest 更新
        mfp = os.path.join(out_dir, 'manifest.json')
        man = json.load(open(mfp, encoding='utf-8')) if os.path.exists(mfp) else {}
        man['semantic'] = {
            gname: {'tri': int(group_mask[gname].sum()), 'parts': sem[gname]}
            for gname in sem if group_mask[gname].any()
        }
        man['bodyTri'] = int(body_mask.sum())
        json.dump(man, open(mfp, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
        print(f"  manifest.semantic = {json.dumps(man['semantic'])}")

if __name__ == '__main__':
    main()
