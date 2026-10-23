#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R27 · 参考包网格「线框采样」正交渲染（形体对照证据）

为什么不用 tools/fbx_render.py：那是逐三角形 Python 循环的光栅器，Scene.fbx 的
Mesh.486 有 293 万三角面，跑不动；而且 Scene 里小件顶点稀疏，点云只有星星点点
（Cube.035 是 31960 顶点铺 194×230 m）。这里改成**三角形边采样 + 单次 numpy
散点写入**：每边取 n 个采样点，线框密度够看清塔型/拱券/收分，且一次向量化完成。

用法：
  python tools/r27_render.py --fbx Scene.fbx --meshes Mesh.486 \
      --out .qa/r27_ref --views front_z,side_x,iso --size 1200 --tris-cap 400000
"""
import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r27_scene_dump as R  # noqa: E402


def edge_points(P, tris, n):
    """三角形三条边各取 n 个插值点 → (N*3n, 3)"""
    v0, v1, v2 = P[tris[:, 0]], P[tris[:, 1]], P[tris[:, 2]]
    ts = np.linspace(0.0, 1.0, n, dtype=np.float64)[:, None]   # (n,1)
    chunks = []
    for a, b in ((v0, v1), (v1, v2), (v2, v0)):
        d = (b - a)[:, None, :]                                  # (M,1,3)
        chunks.append(a[:, None, :] + ts[None, :, :] * d)        # (M,n,3)
    return np.concatenate([c.reshape(-1, 3) for c in chunks], 0)


def splat_img(Q, size, bg=(0.055, 0.062, 0.078), color=(0.90, 0.88, 0.84), pad=1.03):
    x, y, z = Q[:, 0], Q[:, 1], Q[:, 2]
    span = max(x.max() - x.min(), y.max() - y.min()) * pad
    cx, cy = (x.min() + x.max()) / 2, (y.min() + y.max()) / 2
    sx = ((x - cx) / span * size + size / 2).astype(np.int64)
    sy = (size / 2 - (y - cy) / span * size).astype(np.int64)
    m = (sx >= 0) & (sx < size) & (sy >= 0) & (sy < size)
    sx, sy, zm = sx[m], sy[m], z[m]
    img = np.zeros((size, size, 3))
    img[:] = bg
    order = np.argsort(-zm)
    img[sy[order], sx[order]] = np.array(color)
    from PIL import Image
    return Image.fromarray((np.clip(img, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8)), span


VIEWS = {
    "front_z": lambda p: (p[:, 0], p[:, 1], p[:, 2]),
    "back_z": lambda p: (-p[:, 0], p[:, 1], -p[:, 2]),
    "side_x": lambda p: (-p[:, 2], p[:, 1], p[:, 0]),
    "side_x2": lambda p: (p[:, 2], p[:, 1], -p[:, 0]),
    "top_y": lambda p: (p[:, 0], -p[:, 2], p[:, 1]),
    "iso": lambda p: (0.7071 * (p[:, 0] - p[:, 2]),
                      p[:, 1] - 0.35355 * (p[:, 0] + p[:, 2]),
                      0.7071 * (p[:, 0] + p[:, 2])),
    "iso2": lambda p: (-0.7071 * (p[:, 0] + p[:, 2]),
                       p[:, 1] - 0.35355 * (p[:, 0] - p[:, 2]),
                       0.7071 * (p[:, 0] - p[:, 2])),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fbx", required=True)
    ap.add_argument("--out", default=".qa/r27_ref")
    ap.add_argument("--meshes", default="")
    ap.add_argument("--views", default="front_z,side_x,iso")
    ap.add_argument("--size", type=int, default=1200)
    ap.add_argument("--edge-n", type=int, default=5)
    ap.add_argument("--tris-cap", type=int, default=400000)
    ap.add_argument("--unit", type=float, default=0.01)
    ap.add_argument("--xband", default="", help="只渲染 x∈[min,max] 的三角面（按质心）")
    ap.add_argument("--yband", default="")
    ap.add_argument("--zband", default="")
    ap.add_argument("--tag", default="")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    sc = R.Scene(args.fbx, args.unit)
    wanted = [s for s in args.meshes.split(",") if s]
    U = args.unit
    for gid, g in sc.geos.items():
        if g["verts"] is None or g["idx"] is None:
            continue
        mid = sc.geo_parent.get(gid)
        mname = sc.models[mid]["name"] if mid else "-"
        tag = "%s__%s" % (mname.replace(".", "_"), g["name"].replace(".", "_"))
        if wanted and g["name"] not in wanted and mname not in wanted:
            continue
        tris = R.triangulate(g["idx"])
        nv = g["verts"].size // 3
        tris = tris[tris.max(1) < nv]
        if tris.shape[0] > args.tris_cap:
            step = int(np.ceil(tris.shape[0] / args.tris_cap))
            tris = tris[::step]
            print("  [%s] 三角面降采样 step=%d → %d" % (g["name"], step, tris.shape[0]))
        v = g["verts"].reshape(-1, 3)
        W = sc.world.get(mid, np.eye(4)) if mid else np.eye(4)
        if mid:
            W = W @ sc.geometric_matrix(mid)
        P = (v @ W[:3, :3].T + W[:3, 3]) * U
        P0 = P
        if args.xband or args.yband or args.zband:
            cen = P[tris].mean(1)
            keep = np.ones(tris.shape[0], dtype=bool)
            for ax, spec in ((0, args.xband), (1, args.yband), (2, args.zband)):
                if spec:
                    a, b = [float(t) for t in spec.split(",")]
                    keep &= (cen[:, ax] >= a) & (cen[:, ax] <= b)
            tris = tris[keep]
            print("  [band] 三角面过滤 → %d" % tris.shape[0])
            used = np.unique(tris)
            P = P0
        tag = args.tag or tag
        Q = edge_points(P, tris, args.edge_n)
        lo, hi = P.min(0), P.max(0)
        print("\n[%s] model=%s  verts=%d tris=%d  size=%s m" % (
            g["name"], mname, nv, g["idx"].size,
            [round(float(x), 2) for x in (hi - lo)]))
        for vname in [s for s in args.views.split(",") if s]:
            a, b, z = VIEWS[vname](Q)
            img, span = splat_img(np.stack([a, b, z], 1), args.size)
            p = os.path.join(args.out, "%s_%s.png" % (tag, vname))
            img.save(p)
            print("  → %s  (%.3f m/px)" % (p, span / args.size))
    return 0


if __name__ == "__main__":
    sys.exit(main())
