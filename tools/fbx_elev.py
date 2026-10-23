#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
参考包立面剖面 / 节拍提取器（不猜，只量）

三个输出，全部直接可写进 three.js 常量：
  1. ELEVATION：正交正视图的逐列上下边界（米），以及内部空洞（拱洞）的轮廓
  2. CADENCE：指定高度带内、按 x 分箱的顶点密度谱 + 自相关 → 重复构件的真实节拍
  3. BANDS：横向条带的实体/空洞分段（用来量城墙、栏墙、门窗排布）

用法：
  python tools/fbx_elev.py <fbx> --out DIR --view front
      [--only Mesh.152] [--band 8.4,9.8] [--json out.json] [--res 0.01]
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import env_measure as em  # noqa: E402


def load(fbx, only=None, unit=0.01):
    version, root, _ = em.parse_fbx(fbx)
    geos, models, conns = {}, {}, []
    for n, _ in em.walk(root):
        nm = n["name"]
        if nm == "Geometry":
            gid = n["props"][0]
            _c, gname = em.split_name(n["props"])
            v = i = None
            for c in n["children"]:
                if c["name"] == "Vertices" and c["props"]:
                    v = c["props"][0]
                elif c["name"] == "PolygonVertexIndex" and c["props"]:
                    i = c["props"][0]
            if v and i:
                geos[gid] = {"name": gname, "verts": v, "idx": i}
        elif nm == "Model":
            mid = n["props"][0]
            _c, mname = em.split_name(n["props"])
            sc, tr = [1, 1, 1], [0, 0, 0]
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
    g2m = {c: p for c, p in conns if c in geos and p in models}

    vs, ts, names = [], [], []
    off = 0
    for gid, g in geos.items():
        if only and g["name"] not in only:
            continue
        v = np.array(g["verts"], dtype=np.float64).reshape(-1, 3) * unit
        mid = g2m.get(gid)
        if mid:
            v = v * np.array(models[mid]["scale"]) + np.array(models[mid]["trans"]) * unit
        idx = g["idx"]
        tris, poly = [], []
        for k in idx:
            if k < 0:
                poly.append(~k)
                for j in range(1, len(poly) - 1):
                    tris.append((poly[0], poly[j], poly[j + 1]))
                poly = []
            else:
                poly.append(k)
        ts.append(np.array(tris, dtype=np.int64) + off)
        vs.append(v)
        names.append(g["name"])
        off += len(v)
    return np.vstack(vs), np.vstack(ts), names


def rasterize_front(v, t, res=0.01):
    """正交正视 (x→u, y→v)，返回 solid 掩膜与坐标映射"""
    u, w = v[:, 0], v[:, 1]
    u0, u1, w0, w1 = u.min(), u.max(), w.min(), w.max()
    W = max(8, int(round((u1 - u0) / res)))
    H = max(8, int(round((w1 - w0) / res)))
    mask = np.zeros((H, W), dtype=bool)
    px = (u - u0) / res
    py = (w1 - w) / res
    X0, Y0 = px[t[:, 0]], py[t[:, 0]]
    X1, Y1 = px[t[:, 1]], py[t[:, 1]]
    X2, Y2 = px[t[:, 2]], py[t[:, 2]]
    mnx = np.clip(np.floor(np.minimum(np.minimum(X0, X1), X2)).astype(int), 0, W - 1)
    mxx = np.clip(np.ceil(np.maximum(np.maximum(X0, X1), X2)).astype(int), 0, W - 1)
    mny = np.clip(np.floor(np.minimum(np.minimum(Y0, Y1), Y2)).astype(int), 0, H - 1)
    mxy = np.clip(np.ceil(np.maximum(np.maximum(Y0, Y1), Y2)).astype(int), 0, H - 1)
    for i in range(len(t)):
        x0, x1, x2, y0, y1, y2 = X0[i], X1[i], X2[i], Y0[i], Y1[i], Y2[i]
        if mxx[i] < mnx[i] or mxy[i] < mny[i]:
            continue
        den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(den) < 1e-12:
            continue
        xs = np.arange(mnx[i], mxx[i] + 1)
        ys = np.arange(mny[i], mxy[i] + 1)
        gx, gy = np.meshgrid(xs, ys)          # 绝对像素坐标网格
        a = ((y1 - y2) * (gx - x2) + (x2 - x1) * (gy - y2)) / den
        b = ((y2 - y0) * (gx - x2) + (x0 - x2) * (gy - y2)) / den
        c = 1 - a - b
        m = (a >= -1e-6) & (b >= -1e-6) & (c >= -1e-6)
        if m.any():
            mask[gy[m], gx[m]] = True
    return mask, (u0, u1, w0, w1), res


def analyse(mask, box, res):
    u0, u1, w0, w1 = box
    H, W = mask.shape
    cols = np.nonzero(mask.any(0))[0]
    rows = np.nonzero(mask.any(1))[0]
    x_lo = u0 + cols.min() * res
    x_hi = u0 + cols.max() * res
    y_lo = w1 - rows.max() * res
    y_hi = w1 - rows.min() * res

    # 逐列：顶/底 + 内部最大空洞（拱洞）
    top, bot, voids = [], [], []
    for ci in cols:
        col = np.nonzero(mask[:, ci])[0]
        if col.size == 0:
            continue
        xm = u0 + ci * res
        top.append((round(xm, 3), round(w1 - col.min() * res, 3)))
        bot.append((round(xm, 3), round(w1 - col.max() * res, 3)))
        gaps = np.nonzero(np.diff(col) > 1)[0]
        best = None
        for gidx in gaps:
            a, b = col[gidx], col[gidx + 1]
            if best is None or (b - a) > best[1]:
                best = (a, b)
        if best:
            voids.append((round(xm, 3),
                          round(w1 - best[1] * res, 3),   # 洞底 y
                          round(w1 - best[0] * res, 3)))  # 洞顶 y
    return {
        "bbox": {"x": [round(x_lo, 3), round(x_hi, 3)], "y": [round(y_lo, 3), round(y_hi, 3)],
                 "w": round(x_hi - x_lo, 3), "h": round(y_hi - y_lo, 3)},
        "top_profile": top[::max(1, len(top) // 240)],
        "bottom_profile": bot[::max(1, len(bot) // 240)],
        "voids": voids[::max(1, len(voids) // 240)],
        "pixels_per_meter": round(1 / res, 2),
    }


def cadence(v, band, res=0.02):
    """在 y∈band 内按 x 分箱统计顶点数，自相关求重复节拍"""
    y0, y1 = band
    sel = v[(v[:, 1] >= y0) & (v[:, 1] <= y1)]
    if len(sel) < 50:
        return None
    x = sel[:, 0]
    lo, hi = x.min(), x.max()
    nb = max(16, int((hi - lo) / res))
    hist, edges = np.histogram(x, bins=nb, range=(lo, hi))
    s = hist.astype(float) - hist.mean()
    ac = np.correlate(s, s, mode="full")[len(s) - 1:]
    ac /= ac[0] if ac[0] else 1
    # 第一个显著峰（跳过 lag=0）
    peaks = []
    for i in range(2, min(len(ac) - 1, len(ac))):
        if ac[i] > ac[i - 1] and ac[i] >= ac[i + 1] and ac[i] > 0.15:
            peaks.append((i * res, round(float(ac[i]), 3)))
    peaks.sort(key=lambda p: -p[1])
    return {"band": band, "x_range": [round(float(lo), 2), round(float(hi), 2)],
            "bins": nb, "top_peaks_m": peaks[:6]}


def bands(mask, box, res, n=14):
    """横向切 n 条，报每条内「实体列数 / 空洞列数 / 最大连续空洞宽」"""
    u0, u1, w0, w1 = box
    H, W = mask.shape
    out = []
    for i in range(n):
        r0 = int(H * i / n)
        r1 = int(H * (i + 1) / n)
        sl = mask[r0:r1].any(0)
        idx = np.nonzero(sl)[0]
        if idx.size == 0:
            continue
        # 最大连续空洞
        gap = run = 0
        for k in range(idx.min(), idx.max() + 1):
            if not sl[k]:
                run += 1
                gap = max(gap, run)
            else:
                run = 0
        out.append({
            "y_m": [round(w1 - r1 * res, 2), round(w1 - r0 * res, 2)],
            "solid_ratio": round(float(sl[idx.min():idx.max() + 1].mean()), 3),
            "max_void_w_m": round(gap * res, 2),
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fbx")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--band", default="")
    ap.add_argument("--json", default="")
    ap.add_argument("--res", type=float, default=0.012)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    only = set(s for s in args.only.split(",") if s) or None
    v, t, names = load(args.fbx, only)
    print("loaded %d verts / %d tris (%d parts)" % (len(v), len(t), len(names)))
    mask, box, res = rasterize_front(v, t, args.res)
    img = Image.fromarray((np.where(mask, 235, 18)).astype(np.uint8))
    p = os.path.join(args.out, "elev_%s.png" % (os.path.basename(args.fbx).replace(".fbx", "")))
    img.save(p)
    print("ELEV → %s  (%dx%d px, %.1f px/m)" % (p, mask.shape[1], mask.shape[0], 1 / res))

    res_el = analyse(mask, box, res)
    print("bbox  x %s  y %s  = %.2f × %.2f m" % (
        res_el["bbox"]["x"], res_el["bbox"]["y"], res_el["bbox"]["w"], res_el["bbox"]["h"]))
    print("横向条带（自下而上切 %d 条）:" % 14)
    bd = bands(mask, box, res)
    for b in bd:
        print("   y %6.2f..%6.2f  实体占比 %.2f  最大空洞宽 %5.2f m" % (
            b["y_m"][0], b["y_m"][1], b["solid_ratio"], b["max_void_w_m"]))
    cad = None
    if args.band:
        y0, y1 = [float(s) for s in args.band.split(",")]
        cad = cadence(v, (y0, y1))
        if cad:
            print("节拍带 y=%.2f..%.2f  x %s  峰值周期(m): %s" % (
                y0, y1, cad["x_range"], cad["top_peaks_m"]))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"file": args.fbx, "elevation": res_el, "bands": bd,
                       "cadence": cad, "parts": names}, f, ensure_ascii=False, indent=1)
        print("JSON → %s" % args.json)


if __name__ == "__main__":
    main()
