#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R28 · Scene.fbx 装配关系精测（桥券 / 门楼 / 主楼分层 / 窗列节拍）

数据源：.qa/r27_cache/P_Mesh_486.npy、P_Cube_035.npy（R27 缓存，世界坐标米）。
方法：z 薄板顶点溅射 → 占位栅格（闭运算补洞）→ 复用 r28_kit 的
下缘空洞/内空洞分析（起拱线、矢高、跨度、墩位）。

用法：
  python tools/r28_scene.py --stage bridge --json .qa/r28_scene_bridge.json
  python tools/r28_scene.py --stage gate   --json .qa/r28_scene_gate.json
  python tools/r28_scene.py --stage stack  --json .qa/r28_scene_stack.json
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r28_kit as K  # noqa: E402

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".qa", "r27_cache")


def load(name):
    p = os.path.join(CACHE, "P_%s.npy" % name)
    P = np.load(p)
    return P.astype(np.float64)


def dilate(occ):
    out = occ.copy()
    out[1:, :] |= occ[:-1, :]
    out[:-1, :] |= occ[1:, :]
    out[:, 1:] |= occ[:, :-1]
    out[:, :-1] |= occ[:, 1:]
    return out


def erode(occ):
    out = occ.copy()
    out[1:, :] &= occ[:-1, :]
    out[:-1, :] &= occ[1:, :]
    out[:, 1:] &= occ[:, :-1]
    out[:, :-1] &= occ[:, 1:]
    return out


def close(occ, rounds=2):
    for _ in range(rounds):
        occ = erode(dilate(occ))
    return occ


def slab_occ(P, x_rng, y_rng, cell, z_rng=None, close_rounds=2, min_pts=1):
    """顶点溅射占位。返回 (occ, s, pad, lo, wh) —— 与 r28_kit 栅格接口一致。
    occ 行 0 = 图像顶（y 最大）。"""
    sel = P
    if z_rng is not None:
        m = (P[:, 2] >= z_rng[0]) & (P[:, 2] <= z_rng[1])
        sel = P[m]
    x0, x1 = x_rng
    y0, y1 = y_rng
    nx = int(round((x1 - x0) / cell)) + 1
    ny = int(round((y1 - y0) / cell)) + 1
    occ = np.zeros((ny, nx), dtype=bool)
    if sel.shape[0] == 0:
        s = 1.0 / cell
        return occ, s, 0, (x0, y0 - cell), (nx, ny)
    ix = np.round((sel[:, 0] - x0) / cell).astype(np.int64)
    iy = np.round((sel[:, 1] - y0) / cell).astype(np.int64)
    ok = (ix >= 0) & (ix < nx) & (iy >= 0) & (iy < ny)
    ix, iy = ix[ok], iy[ok]
    # 图像行 = (ny-1) - iy
    occ[(ny - 1) - iy, ix] = True
    if close_rounds:
        occ = close(occ, close_rounds)
    s = 1.0 / cell
    lo = (x0, y0 - cell)     # 见 r28_kit.column_profile 的 y 换算约定
    return occ, s, 0, lo, (nx, ny), int(sel.shape[0])


def x_peaks(P, y_rng, z_rng, x_rng, binw=1.0):
    """x 向顶点直方图 → 峰位（墩位/构件位）"""
    m = (P[:, 1] >= y_rng[0]) & (P[:, 1] <= y_rng[1])
    if z_rng is not None:
        m &= (P[:, 2] >= z_rng[0]) & (P[:, 2] <= z_rng[1])
    m &= (P[:, 0] >= x_rng[0]) & (P[:, 0] <= x_rng[1])
    xs = P[m, 0]
    if len(xs) < 10:
        return []
    bins = np.arange(x_rng[0], x_rng[1] + binw, binw)
    hist, edges = np.histogram(xs, bins=bins)
    # 局部峰
    peaks = []
    for i in range(1, len(hist) - 1):
        if hist[i] >= hist[i - 1] and hist[i] >= hist[i + 1] and hist[i] > 0.25 * hist.max():
            peaks.append(round(float(edges[i] + binw / 2), 2))
    # 合并邻近峰
    merged = []
    for p in peaks:
        if merged and p - merged[-1] < binw * 1.5:
            continue
        merged.append(p)
    return merged


def analyse_slab(P, x_rng, y_rng, cell, z_rng, label, min_void=1.0):
    r = slab_occ(P, x_rng, y_rng, cell, z_rng)
    occ, s, pad, lo, wh = r[0], r[1], r[2], r[3], r[4]
    npts = r[5] if len(r) > 5 else 0
    prof = K.column_profile(occ, s, pad, lo, wh)
    out = {"label": label, "z": z_rng, "x": x_rng, "y": y_rng,
           "cell": cell, "n_verts": npts,
           "occupancy_pct": round(float(occ.mean()) * 100, 2),
           "openings": [], "voids": []}
    mask = prof["void_h"] > min_void
    for (a, b) in K.runs_of(mask):
        if (b - a) < max(3, 0.015 * occ.shape[1]):
            continue
        op = K.analyse_opening((a, b), lo, s, pad, prof, min_void,
                               bbox=(x_rng[0], y_rng[0], x_rng[1], y_rng[1]))
        if op["void_width_at_bbox_bottom"] < 0.02 * (x_rng[1] - x_rng[0]):
            continue
        op["cols"] = [int(a), int(b)]
        out["openings"].append(op)
    out["voids"] = K.interior_voids(occ, s, pad, lo, wh, min_side_px=4)
    return out


# ─────────────────────────── 各 stage ───────────────────────────

def stage_bridge(P):
    """桥：主券 + 下层券廊。z 板取 R27 §02 的 6 条纵墙线。"""
    res = []
    # 拱区：y −45…+15；桥端 x −310…+25
    planes = [
        ("west_outer", (-52.5, -49.5)),
        ("west_inner", (-38.5, -35.5)),
        ("deck_west", (-18.5, -15.5)),
        ("deck_east", (33.5, 36.5)),
        ("east_inner", (53.5, 56.5)),
        ("east_outer", (65.5, 68.5)),
    ]
    for name, zr in planes:
        for yr, tag in (((-45.0, 12.0), "arch_zone"),):
            o = analyse_slab(P, (-315.0, 25.0), yr, 0.5, zr, "%s/%s" % (name, tag),
                             min_void=1.2)
            res.append(o)
    # 整体：墩位（拱脚带 y −36…−22 的顶点 x 峰）
    piers = x_peaks(P, (-36.0, -22.0), (-52.5, -49.5), (-315.0, 25.0), binw=1.0)
    # 下层券廊：y −60…−20 的 z 板（西外侧）
    lower = analyse_slab(P, (-315.0, 25.0), (-60.0, -18.0), 0.5, (-52.5, -49.5),
                         "west_outer/lower_zone", min_void=1.2)
    lower2 = analyse_slab(P, (-315.0, 25.0), (-60.0, -18.0), 0.5, (65.5, 68.5),
                          "east_outer/lower_zone", min_void=1.2)
    # 桥下立柱落底：y −230…−200 的顶点 x 峰（柱列）
    foot = x_peaks(P, (-228.0, -200.0), None, (-315.0, 25.0), binw=2.0)
    return {"planes": res, "pier_peaks_x": piers,
            "lower_west": lower, "lower_east": lower2,
            "pier_foot_peaks_x": foot}


def stage_gate(P486, Pcube):
    """门楼：Mesh.486 桥端/桥中门楼 + Cube.035 中央门洞"""
    res = []
    # 桥端门楼 x −320…−270（R27 §03）
    o = analyse_slab(P486, (-325.0, -265.0), (-5.0, 95.0), 0.4, None,
                     "mesh486/gate_end", min_void=1.5)
    res.append(o)
    # 桥中段门楼 x −240…−215
    o = analyse_slab(P486, (-245.0, -210.0), (-5.0, 70.0), 0.4, None,
                     "mesh486/gate_mid", min_void=1.5)
    res.append(o)
    # Cube.035 中央门洞（正立面 z 板）
    for zr, tag in (((-6.0, 6.0), "cube035/center_z0"),
                    ((-55.0, -40.0), "cube035/z_neg"),
                    ((40.0, 55.0), "cube035/z_pos")):
        o = analyse_slab(Pcube, (-40.0, 40.0), (-30.0, 140.0), 0.4, zr, tag, min_void=1.5)
        res.append(o)
    # 双塔墩间距：Cube.035 上部 y 60…120 的 x 峰
    towers = x_peaks(Pcube, (60.0, 120.0), None, (-97.0, 97.0), binw=1.0)
    towers2 = x_peaks(P486, (30.0, 85.0), None, (-325.0, -265.0), binw=1.0)
    return {"slabs": res, "cube035_tower_peaks_x": towers,
            "mesh486_gate_tower_peaks_x": towers2}


def stage_stack(P486, Pcube):
    """主楼/钟楼/铃塔的体量分段 + 塔尖/桥下分层"""
    def ybands(P, xr, zr, tag, band=2.0):
        m = (P[:, 0] >= xr[0]) & (P[:, 0] <= xr[1])
        if zr is not None:
            m &= (P[:, 2] >= zr[0]) & (P[:, 2] <= zr[1])
        Q = P[m]
        if len(Q) < 10:
            return {"label": tag, "bands": []}
        y0, y1 = float(Q[:, 1].min()), float(Q[:, 1].max())
        edges = np.arange(y0, y1 + band, band)
        bands = []
        for i in range(len(edges) - 1):
            s = (Q[:, 1] >= edges[i]) & (Q[:, 1] < edges[i + 1])
            if s.sum() < 5:
                bands.append((round(float(edges[i]), 1), round(float(edges[i + 1]), 1),
                              0, 0.0, 0.0))
                continue
            q = Q[s]
            bands.append((round(float(edges[i]), 1), round(float(edges[i + 1]), 1),
                          int(s.sum()),
                          round(float(q[:, 0].max() - q[:, 0].min()), 2),
                          round(float(q[:, 2].max() - q[:, 2].min()), 2)))
        return {"label": tag, "x": xr, "z": zr,
                "y_range": [round(y0, 2), round(y1, 2)],
                "bands": bands}

    out = {"mesh486_keep": [], "cube035": []}
    # Mesh.486 城堡群按 x 分段看体量（门楼/主楼/教堂）
    for xr, tag in (((-325, -265), "gatehouse"),
                    ((-265, -215), "gallery_colonnade"),
                    ((-215, -160), "keep_main"),
                    ((-160, -100), "cathedral"),
                    ((-100, 25), "bridge_head")):
        out["mesh486_keep"].append(ybands(P486, xr, None, tag, band=2.0))
    out["cube035"].append(ybands(Pcube, (-97, 97), None, "cube035_all", band=2.0))
    out["cube035"].append(ybands(Pcube, (-25, 25), None, "cube035_center", band=2.0))
    out["cube035"].append(ybands(Pcube, (25, 97), None, "cube035_right", band=2.0))
    return out


def stage_layers(P486):
    """y=+345 塔尖与 y=−224 桥下的全局分层"""
    y = P486[:, 1]
    edges = np.arange(-230, 350, 2.0)
    hist, _ = np.histogram(y, bins=edges)
    top = []
    for i in range(len(hist)):
        if hist[i] > 0:
            top.append((round(float(edges[i]), 1), round(float(edges[i + 1]), 1), int(hist[i])))
    # 塔尖区（y>200）顶点 x/z 分布
    m = y > 200
    hi = P486[m]
    m2 = y < -150
    lo = P486[m2]
    return {
        "y_hist": top,
        "spire_zone": {
            "n": int(m.sum()),
            "x": [round(float(hi[:, 0].min()), 2), round(float(hi[:, 0].max()), 2)] if m.sum() else None,
            "z": [round(float(hi[:, 2].min()), 2), round(float(hi[:, 2].max()), 2)] if m.sum() else None,
            "y": [round(float(hi[:, 1].min()), 2), round(float(hi[:, 1].max()), 2)] if m.sum() else None,
        },
        "under_bridge_zone": {
            "n": int(m2.sum()),
            "x": [round(float(lo[:, 0].min()), 2), round(float(lo[:, 0].max()), 2)] if m2.sum() else None,
            "z": [round(float(lo[:, 2].min()), 2), round(float(lo[:, 2].max()), 2)] if m2.sum() else None,
            "y": [round(float(lo[:, 1].min()), 2), round(float(lo[:, 1].max()), 2)] if m2.sum() else None,
        },
    }


def stage_curtain(P486, Pcube):
    """幕墙窗列节拍：正立面 z 板的内空洞 x 序列"""
    out = []
    # Mesh.486 主楼南/北立面 z 板（z≈±20 一带，先普查内空洞）
    for zr, tag in (((-30.0, -20.0), "keep_z-25"),
                    ((-10.0, 10.0), "keep_z0"),
                    ((15.0, 30.0), "keep_z+22")):
        o = analyse_slab(P486, (-265.0, -160.0), (0.0, 140.0), 0.4, zr, tag, min_void=1.5)
        out.append(o)
    o = analyse_slab(Pcube, (-97.0, 97.0), (20.0, 120.0), 0.4, (-8.0, 8.0),
                     "cube035_facade_z0", min_void=1.5)
    out.append(o)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True,
                    choices=["bridge", "gate", "stack", "layers", "curtain"])
    ap.add_argument("--json", default="")
    args = ap.parse_args()
    P486 = load("Mesh_486")
    print("P_Mesh_486", P486.shape)
    Pcube = load("Cube_035")
    print("P_Cube_035", Pcube.shape)
    fn = {
        "bridge": lambda: stage_bridge(P486),
        "gate": lambda: stage_gate(P486, Pcube),
        "stack": lambda: stage_stack(P486, Pcube),
        "layers": lambda: stage_layers(P486),
        "curtain": lambda: stage_curtain(P486, Pcube),
    }[args.stage]
    out = fn()

    def pr(o, ind=0):
        sp = "  " * ind
        if isinstance(o, dict):
            for k, v in o.items():
                if k in ("openings", "voids", "bands", "y_hist", "planes",
                         "slabs", "mesh486_keep", "cube035") and isinstance(v, list):
                    print("%s%s: [%d]" % (sp, k, len(v)))
                    for it in v:
                        pr(it, ind + 1)
                elif isinstance(v, (dict, list)):
                    print("%s%s:" % (sp, k))
                    pr(v, ind + 1)
                else:
                    print("%s%s = %s" % (sp, k, v))
        elif isinstance(o, list):
            for it in o:
                pr(it, ind)
        else:
            print("%s%s" % (sp, o))

    pr(out)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        print("\nJSON → %s" % args.json)


if __name__ == "__main__":
    sys.exit(main())
