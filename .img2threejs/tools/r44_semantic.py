# -*- coding: utf-8 -*-
"""R44-6 语义拆分（主理人亲自）：分件 GLB(part) → 染色版几何三角分组的匹配率统计
判据：染色版三角 3 顶点量化哈希(1e-4) 命中分件 part 顶点集 ≥2 → 归组
"""
import os, sys, json
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib
B = importlib.import_module('r44_bake')

PART_SRC = {
    'v800': ('C:/Users/WB/Desktop/R7/拆/V8.glb', {
        'glass': [9, 5, 10],
        'lamp_rear': [6],
        'lamp_front': [14],
        'wheel': [3, 4, 7, 8],
    }),
    'r7': ('C:/Users/WB/Desktop/R7/拆/R7.glb', {
        'glass': [3, 4, 6],
        'lamp_rear': [18],
        'lamp_front': [14],
        'wheel': [5, 9, 10, 12],
    }),
}

def load_parts(path):
    """分件 GLB：无 node 旋转（bbox 已世界系）。返回 [(part_i, pos(f64 Nx3), tri, tri_count)]"""
    gltf, binc = B.parse_glb(path)
    parts = []
    for mi, mesh in enumerate(gltf['meshes']):
        prim = mesh['primitives'][0]
        pos = B.read_accessor(gltf, binc, prim['attributes']['POSITION']).astype(np.float64)
        idx = B.read_accessor(gltf, binc, prim['indices']).reshape(-1, 3).astype(np.int64)
        parts.append((mi, pos, idx, len(idx)))
    return parts

def qhash(p):
    return (p * 10000).astype(np.int64)

def main():
    for car, (ppath, sem) in PART_SRC.items():
        cfg = B.CARS[car]
        pos, nrm, uv, indices = B.load_car_glb(os.path.join(B.SRC, cfg['geo_glb']))
        tri_cnt = len(indices)
        parts = load_parts(ppath)
        print(f"\n=== {car}: 染色版 {len(pos)} vtx / {tri_cnt} tri ===")
        # 分件顶点量化哈希 → 每 part 集合
        part_sets = {}
        for mi, ppos, pidx, _ in parts:
            h = set(map(tuple, qhash(ppos).tolist()))
            part_sets[mi] = h
        # 染色版顶点哈希 → 三角命中
        vh = qhash(pos)
        tri_vh = vh[indices]  # (T,3,3)
        tri_tuples = [[(t[0][0],t[0][1],t[0][2]), (t[1][0],t[1][1],t[1][2]), (t[2][0],t[2][1],t[2][2])] for t in tri_vh]
        for group, mis in sem.items():
            union = set()
            part_tri_ref = 0
            for mi in mis:
                union |= part_sets[mi]
                part_tri_ref += parts[mi][3]
            hit = np.zeros(tri_cnt, np.int8)
            for k in range(3):
                col = tri_vh[:, k, :]
                m = np.fromiter((tuple(c) in union for c in col), bool, tri_cnt)
                hit += m
            n2 = int((hit >= 2).sum())
            n1 = int((hit >= 1).sum())
            print(f"  {group}: parts={mis} 分件tri={part_tri_ref} | 染色版命中 ≥2v={n2} ({100*n2/tri_cnt:.1f}%) ≥1v={n1} ({100*n1/tri_cnt:.1f}%)")
        # 轮匹配详情（若切换分件轮）
        if 'wheel' in sem:
            for mi in sem['wheel']:
                ppos, pidx = parts[mi][1], parts[mi][2]
                if len(ppos) == 0: continue
                ymin, ymax = ppos[:,1].min(), ppos[:,1].max()
                print(f"  wheel part{mi}: bbox y[{ymin:.4f},{ymax:.4f}] x[{ppos[:,0].min():.4f},{ppos[:,0].max():.4f}] z[{ppos[:,2].min():.4f},{ppos[:,2].max():.4f}] tri={len(pidx)}")

if __name__ == '__main__':
    main()
