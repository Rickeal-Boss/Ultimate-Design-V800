#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R28 · SM_B 4 座建筑单体的「体量分段」测量（基座/塔身/檐口/尖顶）

方法：水平切片带（默认 0.25 m）逐带求顶点云的 (x,z) 包围盒宽度/深度 + 顶点密度；
带间宽度突变（>8% 或 <2%）→ 分段边界；输出每段 y 区间 / 平均宽 / 平均深 / 高度占比。
再对每段做「收分斜率」（宽随高的线性拟合）→ 基座外扩/塔身收分/尖顶锥度。

用法：
  python tools/r28_bseg.py --fbx <SM_B.fbx> --json .qa/r28_bseg.json
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r27_scene_dump as R  # noqa: E402


def segments(P, band=0.25, rel_jump=0.08, min_seg_bands=2):
    lo, hi = P.min(0), P.max(0)
    y0, y1 = float(lo[1]), float(hi[1])
    edges = np.arange(y0, y1 + band, band)
    rows = []
    for i in range(len(edges) - 1):
        m = (P[:, 1] >= edges[i]) & (P[:, 1] < edges[i + 1])
        n = int(m.sum())
        if n == 0:
            rows.append((float(edges[i]), float(edges[i + 1]), 0, 0.0, 0.0))
            continue
        q = P[m]
        rows.append((float(edges[i]), float(edges[i + 1]), n,
                     float(q[:, 0].max() - q[:, 0].min()),
                     float(q[:, 2].max() - q[:, 2].min())))
    # 以带宽序列找跳变边界
    widths = np.array([r[3] for r in rows])
    depths = np.array([r[4] for r in rows])
    valid = widths > 0
    segs = []
    cur = [0]
    for i in range(1, len(rows)):
        if not valid[i]:
            if len(cur) >= min_seg_bands:
                segs.append(cur)
            cur = []
            continue
        if not cur:
            cur = [i]
            continue
        w_prev = widths[cur[-1]] if widths[cur[-1]] > 0 else widths[i]
        jump = abs(widths[i] - w_prev) / max(w_prev, 1e-6)
        d_jump = abs(depths[i] - depths[cur[-1]]) / max(depths[cur[-1]], 1e-6)
        if jump > rel_jump or d_jump > rel_jump:
            if len(cur) >= min_seg_bands:
                segs.append(cur)
            cur = [i]
        else:
            cur.append(i)
    if len(cur) >= min_seg_bands:
        segs.append(cur)

    out = []
    total_h = y1 - y0
    for s in segs:
        ya, yb = rows[s[0]][0], rows[s[-1]][1]
        w = float(np.mean(widths[s]))
        d = float(np.mean(depths[s]))
        # 收分：宽 vs 高线性拟合斜率
        yy = np.array([(rows[i][0] + rows[i][1]) / 2 for i in s])
        ww = widths[s]
        if len(s) >= 3 and ww.std() > 1e-6:
            k = float(np.polyfit(yy, ww, 1)[0])
        else:
            k = 0.0
        out.append({
            "y0": round(ya, 3), "y1": round(yb, 3),
            "h": round(yb - ya, 3),
            "h_frac": round((yb - ya) / total_h, 4) if total_h > 0 else None,
            "w_mean": round(w, 3), "d_mean": round(d, 3),
            "w_min": round(float(ww.min()), 3), "w_max": round(float(ww.max()), 3),
            "taper_per_m": round(k, 4),
            "bands": len(s),
        })
    return out, (round(float(lo[0]), 3), round(float(y0), 3), round(float(lo[2]), 3),
                 round(float(hi[0]), 3), round(float(y1), 3), round(float(hi[2]), 3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fbx", required=True)
    ap.add_argument("--json", default=".qa/r28_bseg.json")
    ap.add_argument("--band", type=float, default=0.25)
    args = ap.parse_args()
    sc = R.Scene(args.fbx, 0.01)
    out = {"tool": "r28_bseg.py", "file": args.fbx, "band": args.band, "items": []}
    for gid, g in sc.geos.items():
        if g["verts"] is None or not len(g["verts"]):
            continue
        mid = sc.geo_parent.get(gid)
        mname = sc.models[mid]["name"] if mid else "(none)"
        P = g["verts"].reshape(-1, 3) * 0.01
        W = sc.world.get(mid, np.eye(4)) if mid else np.eye(4)
        if mid:
            W = W @ sc.geometric_matrix(mid)
        P = P @ W[:3, :3].T + W[:3, 3]
        segs, bbox = segments(P, args.band)
        rec = {"model": mname, "geo": g["name"],
               "tris": int(g["idx"].size and R.triangulate(g["idx"]).shape[0]),
               "verts": int(P.shape[0]),
               "bbox": bbox,
               "size": [round(bbox[3] - bbox[0], 3), round(bbox[4] - bbox[1], 3),
                        round(bbox[5] - bbox[2], 3)],
               "segments": segs}
        out["items"].append(rec)
        print("== %s (%s)  %d tri  size %s" % (mname, g["name"], rec["tris"], rec["size"]))
        for s in segs:
            print("   y[%8.3f..%8.3f] h=%6.2f (%4.1f%%)  W %6.2f (min %.2f max %.2f)  D %6.2f  taper %+.4f/m" % (
                s["y0"], s["y1"], s["h"], 100 * (s["h_frac"] or 0),
                s["w_mean"], s["w_min"], s["w_max"], s["d_mean"], s["taper_per_m"]))
    with open(args.json, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("\nJSON → %s" % args.json)


if __name__ == "__main__":
    sys.exit(main())
