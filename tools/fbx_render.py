#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
参考包几何 → 软件光栅渲染（无 Blender 的替代通路）

原理：二进制 FBX 读出 Vertices / PolygonVertexIndex，按 Model 的 Lcl
Scaling/Translation 变换到装配空间，用 numpy 三角形光栅 + z-buffer +
Lambert 着色输出 PNG。着色只用几何法线，**不采样参考贴图**（吸色在
tools/ref_palette.py 里单独做统计），因此产物是"形体参考"而非资产复制。

用法：
  python tools/fbx_render.py <fbx> --out DIR [--views iso,front,side,top]
                              [--size 1200] [--merge] [--json out.json]
"""
import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import env_measure as em  # noqa: E402


def build_mesh(fbx, unit, only_geo=None):
    """返回 (verts[N,3] 装配空间, tris[M,3], parts[{name,tris}])"""
    version, root, _ = em.parse_fbx(fbx)
    geos, models, conns = {}, {}, []
    for n, _ in em.walk(root):
        nm = n["name"]
        if nm == "Geometry":
            gid = n["props"][0]
            _cls, gname = em.split_name(n["props"])
            verts = idx = None
            for c in n["children"]:
                if c["name"] == "Vertices" and c["props"]:
                    verts = c["props"][0]
                elif c["name"] == "PolygonVertexIndex" and c["props"]:
                    idx = c["props"][0]
            if verts and idx:
                geos[gid] = {"name": gname, "verts": verts, "idx": idx}
        elif nm == "Model":
            mid = n["props"][0]
            _cls, mname = em.split_name(n["props"])
            sc, tr = [1.0, 1.0, 1.0], [0.0, 0.0, 0.0]
            for c in n["children"]:
                if c["name"] == "Lcl Scaling" and c["props"]:
                    sc = list(c["props"][0])[:3]
                elif c["name"] == "Lcl Translation" and c["props"]:
                    tr = list(c["props"][0])[:3]
            models[mid] = {"name": mname, "scale": sc, "trans": tr}
        elif nm == "Connections":
            for c in n["children"]:
                if c["name"] == "C" and len(c["props"]) >= 3:
                    conns.append((c["props"][1], c["props"][2]))
    geo2model = {c: p for c, p in conns if c in geos and p in models}

    all_v, all_t, parts = [], [], []
    off = 0
    for gid, g in geos.items():
        if only_geo and g["name"] not in only_geo:
            continue
        v = np.array(g["verts"], dtype=np.float32).reshape(-1, 3) * unit
        mid = geo2model.get(gid)
        if mid:
            v = v * np.array(models[mid]["scale"], dtype=np.float32) + np.array(
                models[mid]["trans"], dtype=np.float32) * unit
        idx = g["idx"]
        tris = []
        poly = []
        for k in idx:
            if k < 0:
                poly.append(~k)
                for j in range(1, len(poly) - 1):
                    tris.append((poly[0], poly[j], poly[j + 1]))
                poly = []
            else:
                poly.append(k)
        if not tris:
            continue
        t = np.array(tris, dtype=np.int64) + off
        all_v.append(v)
        all_t.append(t)
        parts.append({"name": g["name"], "model": models[mid]["name"] if mid else "-",
                      "tris": len(tris), "verts": len(v)})
        off += len(v)
    if not all_v:
        raise SystemExit("没有可渲染网格")
    return np.vstack(all_v), np.vstack(all_t), parts


def look_basis(eye_dir):
    """视线方向 → (right, up, forward) 正交基"""
    f = -np.array(eye_dir, dtype=np.float64)
    f /= np.linalg.norm(f)
    up0 = np.array([0.0, 1.0, 0.0])
    if abs(np.dot(f, up0)) > 0.98:
        up0 = np.array([0.0, 0.0, 1.0])
    r = np.cross(up0, f)
    r /= np.linalg.norm(r)
    u = np.cross(f, r)
    return r, u, f


def render(verts, tris, eye_dir, size, fov_pad=1.06, bg=(0.055, 0.062, 0.078),
           light_dir=(0.4, 0.85, 0.35), ao_floor=True):
    r, u, f = look_basis(eye_dir)
    P = verts.astype(np.float64)
    x = P @ r
    y = P @ u
    z = P @ f
    span = max(x.max() - x.min(), y.max() - y.min()) * fov_pad
    cx, cy = (x.min() + x.max()) / 2, (y.min() + y.max()) / 2
    sx = (x - cx) / span * size + size / 2
    sy = size / 2 - (y - cy) / span * size

    zb = np.full((size, size), np.inf, dtype=np.float64)
    img = np.zeros((size, size, 3), dtype=np.float64)
    img[:] = bg

    L = np.array(light_dir, dtype=np.float64)
    L /= np.linalg.norm(L)
    base = np.array([0.88, 0.86, 0.82])

    t0 = tris
    v0, v1, v2 = t0[:, 0], t0[:, 1], t0[:, 2]
    X0, Y0, Z0 = sx[v0], sy[v0], z[v0]
    X1, Y1 = sx[v1], sy[v1]
    X2, Y2 = sx[v2], sy[v2]
    # 面法线（对象空间，用于着色）
    A, B, C = P[v0], P[v1], P[v2]
    N = np.cross(B - A, C - A)
    nl = np.linalg.norm(N, axis=1)
    nl[nl == 0] = 1
    N = N / nl[:, None]
    lam = np.abs(N @ L) * 0.72 + 0.28           # 双面 Lambert + 环境项
    shade = np.clip(lam, 0, 1.35)

    minx = np.floor(np.minimum(np.minimum(X0, X1), X2)).astype(np.int64)
    maxx = np.ceil(np.maximum(np.maximum(X0, X1), X2)).astype(np.int64)
    miny = np.floor(np.minimum(np.minimum(Y0, Y1), Y2)).astype(np.int64)
    maxy = np.ceil(np.maximum(np.maximum(Y0, Y1), Y2)).astype(np.int64)
    np.clip(minx, 0, size - 1, out=minx)
    np.clip(maxx, 0, size - 1, out=maxx)
    np.clip(miny, 0, size - 1, out=miny)
    np.clip(maxy, 0, size - 1, out=maxy)

    den = (Y1 - Y2) * (X0 - X2) + (X2 - X1) * (Y0 - Y2)
    ok = np.abs(den) > 1e-9
    for i in np.nonzero(ok)[0]:
        x0, x1, x2 = X0[i], X1[i], X2[i]
        y0, y1, y2 = Y0[i], Y1[i], Y2[i]
        if not (np.isfinite(x0) and np.isfinite(y0)):
            continue
        xs = np.arange(minx[i], maxx[i] + 1)
        ys = np.arange(miny[i], maxy[i] + 1)
        if xs.size == 0 or ys.size == 0:
            continue
        gx, gy = np.meshgrid(xs, ys)
        w0 = ((y1 - y2) * (gx - x2) + (x2 - x1) * (gy - y2)) / den[i]
        w1 = ((y2 - y0) * (gx - x2) + (x0 - x2) * (gy - y2)) / den[i]
        w2 = 1.0 - w0 - w1
        m = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not m.any():
            continue
        zz = w0 * Z0[i] + w1 * z[v1[i]] + w2 * z[v2[i]]
        sub = zb[ys[:, None], xs[None, :]]
        upd = m & (zz < sub)
        if not upd.any():
            continue
        zb[ys[:, None], xs[None, :]] = np.where(upd, zz, sub)
        col = base * shade[i]
        flat = img[ys[:, None], xs[None, :]]
        flat[upd] = col
        img[ys[:, None], xs[None, :]] = flat

    img = np.clip(img, 0, 1)
    return Image.fromarray((img ** (1 / 2.2) * 255).astype(np.uint8))


VIEWS = {
    "iso": (1.0, -0.62, 1.0),
    "iso2": (-1.0, -0.55, 0.85),
    "front": (0, 0, -1),
    "back": (0, 0, 1),
    "side": (-1, 0, 0),
    "top": (0, -1, 0.001),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fbx")
    ap.add_argument("--out", required=True)
    ap.add_argument("--views", default="iso,front,side,top")
    ap.add_argument("--size", type=int, default=1100)
    ap.add_argument("--unit", type=float, default=0.01)
    ap.add_argument("--json", default="")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    verts, tris, parts = build_mesh(args.fbx, args.unit)
    print("装配 %d 顶点 / %d 三角 / %d 件" % (len(verts), len(tris), len(parts)))
    lo, hi = verts.min(0), verts.max(0)
    print("bbo x %s  size %s" % (np.round(lo, 2), np.round(hi - lo, 2)))

    for v in [s for s in args.views.split(",") if s]:
        d = VIEWS[v]
        img = render(verts, tris, d, args.size)
        p = os.path.join(args.out, "%s_%s.png" % (os.path.splitext(os.path.basename(args.fbx))[0], v))
        img.save(p)
        print("RENDER → %s (%s)" % (p, v))

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({"file": args.fbx, "verts": int(len(verts)), "tris": int(len(tris)),
                       "bbox_lo": lo.tolist(), "bbox_hi": hi.tolist(), "parts": parts},
                      fh, ensure_ascii=False, indent=1)
        print("JSON → %s" % args.json)


if __name__ == "__main__":
    main()
