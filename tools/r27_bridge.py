#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R27 · Scene.fbx 大网格的结构测量（桥 / 门 / 塔），基于顶点云统计而非逐三角面

背景：Scene.fbx 只有 5 个 Mesh 节点，整座城堡 + 桥被合并进 Mesh.486（293 万三角面）。
逐三角面连通体分解在纯 Python 里跑不动（union-find 210 万次），改用**顶点云投影统计**：
  1) 平面占据图（top / front）→ 定轴向、定带、定高程
  2) 高程直方图 → 找桥面平台 / 栏板顶 / 拱底
  3) 沿轴向的一维直方图 → 找栏板柱节拍（自相关的强周期）
这些都能向量化，秒级完成。

用法：
  python tools/r27_bridge.py --fbx <Scene.fbx> --cache .qa/r27_cache --stage map
  python tools/r27_bridge.py --cache .qa/r27_cache --stage bridge
"""
import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r27_scene_dump as R  # noqa: E402


def load_mesh(fbx, cache, mesh_name, unit=0.01):
    """顶点/三角面缓存（.npy），避免反复解析 143MB FBX"""
    os.makedirs(cache, exist_ok=True)
    tag = mesh_name.replace(".", "_")
    pP = os.path.join(cache, "P_%s.npy" % tag)
    pT = os.path.join(cache, "T_%s.npy" % tag)
    if os.path.exists(pP) and os.path.exists(pT):
        return np.load(pP), np.load(pT)
    sc = R.Scene(fbx, unit)
    gid = next(g for g, v in sc.geos.items() if v["name"] == mesh_name)
    g = sc.geos[gid]
    mid = sc.geo_parent.get(gid)
    W = sc.world.get(mid, np.eye(4)) if mid else np.eye(4)
    if mid:
        W = W @ sc.geometric_matrix(mid)
    P = (g["verts"].reshape(-1, 3) @ W[:3, :3].T + W[:3, 3]) * unit
    T = R.triangulate(g["idx"])
    T = T[T.max(1) < P.shape[0]].astype(np.int32)
    np.save(pP, P.astype(np.float32))
    np.save(pT, T)
    return P, T


def ascii_map(P, ax, ay, cols=96, rows=40, xr=None, yr=None, flipy=True):
    ax_, ay_ = P[:, ax], P[:, ay]
    if xr is None:
        xr = (ax_.min(), ax_.max())
    if yr is None:
        yr = (ay_.min(), ay_.max())
    H, xe, ye = np.histogram2d(ax_, ay_, bins=[cols, rows], range=[xr, yr])
    nz = H[H > 0]
    ref = np.percentile(nz, 99.0) if nz.size else 1.0
    L = np.clip(H / max(ref, 1e-9), 0, 1) ** 0.4 if nz.size else H
    chars = " .:-=+*#%@"
    lines = []
    order = range(rows - 1, -1, -1) if flipy else range(rows)
    for r in order:
        lines.append("".join(chars[min(9, int(v * 9.999))] for v in L[r]))
    return lines, xe, ye


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fbx", default="")
    ap.add_argument("--cache", default=".qa/r27_cache")
    ap.add_argument("--mesh", default="Mesh.486")
    ap.add_argument("--stage", default="map")
    ap.add_argument("--zband", default="", help="z 轴带过滤 min,max")
    ap.add_argument("--xband", default="", help="x 轴带过滤 min,max")
    ap.add_argument("--cols", type=int, default=96)
    ap.add_argument("--rows", type=int, default=40)
    args = ap.parse_args()

    P, T = load_mesh(args.fbx, args.cache, args.mesh)
    print("P=%s  T=%s  bbox lo=%s hi=%s" % (
        P.shape, T.shape, np.round(P.min(0), 2), np.round(P.max(0), 2)))
    if args.zband:
        z0, z1 = [float(s) for s in args.zband.split(",")]
        P = P[(P[:, 2] >= z0) & (P[:, 2] <= z1)]
        print("z 带过滤 → %d 顶点" % len(P))
    if args.xband:
        x0, x1 = [float(s) for s in args.xband.split(",")]
        P = P[(P[:, 0] >= x0) & (P[:, 0] <= x1)]
        print("x 带过滤 → %d 顶点" % len(P))
    if args.stage == "map":
        for title, (ax_, ay_), (an, bn) in [
            ("TOP   (x→ right, z→ up)", (0, 2), ("x", "z")),
            ("FRONT (x→ right, y→ up)", (0, 1), ("x", "y")),
            ("SIDE  (z→ right, y→ up)", (2, 1), ("z", "y")),
        ]:
            lines, xe, ye = ascii_map(P, ax_, ay_, args.cols, args.rows)
            print("\n%s   %s∈[%.1f,%.1f]  %s∈[%.1f,%.1f]  cell=%.2f×%.2f m" % (
                title, an, xe[0], xe[-1], bn, ye[0], ye[-1],
                xe[1] - xe[0], ye[1] - ye[0]))
            for ln in lines:
                print("  |" + ln + "|")
    return 0


if __name__ == "__main__":
    sys.exit(main())
