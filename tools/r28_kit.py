#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R28 · SM_Gat / SM_Det 构件库逐件精测（拱券起拱线/矢高/跨度 + 空洞分析 + 节拍）

方法（比 R27 的包围盒口径更进一步）：
  1. 每件三角形正交投影到 XY 立面（y=上、x=水平、z=进深），栅格化占位图
  2. 逐列求「下缘空洞」→ 拱洞/窗洞的内弧线（intrados）逐列采样
  3. 起拱线 = 空洞范围内两端内弧平台高；跨度 = 空洞水平宽度；
     矢高 = 内弧顶 − 起拱线；拱顶/拱腹环厚 = 该列占位段厚度
  4. 尖拱 vs 圆拱裁决：半跨分别拟合圆弧（两心圆），
     R=(r²+w²)/(2w)、圆心偏距 a=(r²−w²)/(2w)（a=0 即正圆/半圆），
     与实测内弧点残差比对；尖拱顶为折点（左右切线不共线）
  5. 栏杆/柱阵列件另做沿轴游程节拍（baluster pitch）

用法：
  python tools/r28_kit.py --fbx-dir <WhiteCastle_FBX> --json .qa/r28_kit.json
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r27_scene_dump as R  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402


# ─────────────────────────── 投影栅格 + 空洞分析 ───────────────────────────

def raster_xy(P, T, res=1000):
    """三角形投影到 XY 栅格化。返回 (occ, scale px/m, pad px, lo_m)"""
    lo = P.min(0)
    hi = P.max(0)
    span = np.maximum(hi - lo, 1e-6)
    pad = 8
    s = (res - 2 * pad) / max(span[0], span[1])
    W = int(np.ceil(span[0] * s)) + 2 * pad
    H = int(np.ceil(span[1] * s)) + 2 * pad

    def to_px(pts):
        q = np.atleast_2d(pts)
        px = (q[:, 0] - lo[0]) * s + pad
        py = (H - pad) - (q[:, 1] - lo[1]) * s
        return np.stack([px, py], 1)

    img = Image.new("1", (W, H), 0)
    dr = ImageDraw.Draw(img)
    tri_px = to_px(P[T.reshape(-1)]).reshape(-1, 3, 2)
    for t in tri_px:
        dr.polygon([tuple(t[0]), tuple(t[1]), tuple(t[2])], fill=1)
    return np.array(img, dtype=bool), s, pad, lo, (W, H)


def column_profile(occ, s, pad, lo, wh):
    """逐列：占位最低/最高 y（米）、下缘空洞高（米）"""
    H, W = occ.shape
    void_h = np.zeros(W)
    y_low = np.full(W, np.nan)
    y_top = np.full(W, np.nan)
    y_bot_geom = np.full(W, np.nan)   # 该列占位段的下缘（多段时取最上段下缘供拱腹用）
    runs_top = np.full(W, np.nan)     # 最上占位段的上缘（外弧）
    runs_thick = np.full(W, np.nan)   # 最上占位段厚度
    py_bot = H - pad                  # bbox y_min 对应像素行
    for j in range(W):
        col = occ[:, j]
        idx = np.where(col)[0]
        if len(idx) == 0:
            continue
        bot, top = idx.max(), idx.min()
        y_low[j] = lo[1] + (py_bot - bot) / s
        y_top[j] = lo[1] + (py_bot - top) / s
        void_h[j] = (py_bot - bot) / s
        # 占位段游程
        d = np.diff(idx)
        splits = np.where(d > 1)[0]
        starts = np.concatenate([[0], splits + 1])
        ends = np.concatenate([splits, [len(idx) - 1]])
        # 最上段 = start 最小的段
        top_seg_rows = (idx[starts[0]], idx[ends[0]])
        runs_top[j] = lo[1] + (py_bot - top_seg_rows[0]) / s
        runs_thick[j] = (top_seg_rows[1] - top_seg_rows[0] + 1) / s
        # 拱腹 = 最上段的下缘（若其下还有空洞）；否则 = 最下段的上缘？
        y_bot_geom[j] = lo[1] + (py_bot - top_seg_rows[1]) / s
    return dict(void_h=void_h, y_low=y_low, y_top=y_top,
                y_bot_geom=y_bot_geom, runs_top=runs_top, runs_thick=runs_thick)


def runs_of(mask):
    cols = np.where(mask)[0]
    if len(cols) == 0:
        return []
    out, st, prev = [], cols[0], cols[0]
    for c in cols[1:]:
        if c != prev + 1:
            out.append((st, prev))
            st = c
        prev = c
    out.append((st, prev))
    return out


def interior_voids(occ, s, pad, lo, wh, min_side_px=6):
    """封闭内空洞（不与图像边界连通的空像素）→ 逐个空洞的度量。

    返回列表：bbox（米）、最大宽及其高程（=起拱线参考）、顶（拱顶）、
    rise（顶 − 最宽行）、形状提示。
    """
    H, W = occ.shape
    empty = ~occ
    # 外部洪泛（PIL C 实现）
    img = Image.fromarray(np.where(empty, 255, 0).astype(np.uint8))
    from PIL import ImageDraw as _ID
    seeds = []
    for x in range(W):
        seeds += [(x, 0), (x, H - 1)]
    for y in range(H):
        seeds += [(0, y), (W - 1, y)]
    for (x, y) in seeds:
        if img.getpixel((x, y)) == 255:
            _ID.floodfill(img, (x, y), 128, thresh=0)
    arr = np.array(img)
    interior = arr == 255
    if not interior.any():
        return []
    # 连通域（对 interior 像素做 BFS 标号，种子取 argwhere）
    lab = np.zeros((H, W), dtype=np.int32)
    cur = 0
    out = []
    ys_all, xs_all = np.nonzero(interior)
    py_bot = H - pad
    for y0, x0 in zip(ys_all.tolist(), xs_all.tolist()):
        if lab[y0, x0]:
            continue
        cur += 1
        stack = [(y0, x0)]
        lab[y0, x0] = cur
        pts = []
        while stack:
            y, x = stack.pop()
            pts.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and interior[ny, nx] and not lab[ny, nx]:
                    lab[ny, nx] = cur
                    stack.append((ny, nx))
        if len(pts) < 30:
            continue
        ys = np.array([p[0] for p in pts])
        xs = np.array([p[1] for p in pts])
        w_cols = xs.max() - xs.min() + 1
        h_rows = ys.max() - ys.min() + 1
        if w_cols < min_side_px or h_rows < min_side_px:
            continue
        # 逐行宽度 → 最宽行
        row_lo = np.full(H, -1)
        row_hi = np.full(H, -1)
        for y, x in pts:
            if row_lo[y] < 0 or x < row_lo[y]:
                row_lo[y] = x
            if x > row_hi[y]:
                row_hi[y] = x
        widths = np.where(row_hi >= row_lo, row_hi - row_lo + 1, 0)
        best = int(np.argmax(widths))
        max_w = float(widths[best]) / s
        y_widest = lo[1] + (py_bot - best) / s
        y_top = lo[1] + (py_bot - ys.min()) / s
        y_bot = lo[1] + (py_bot - ys.max()) / s
        x0m = lo[0] + (xs.min() - pad) / s
        x1m = lo[0] + (xs.max() - pad) / s
        h = y_top - y_bot
        rel = (best - ys.min()) / max(h_rows - 1, 1)   # 0=顶 1=底
        if h / max(max_w, 1e-9) > 4:
            shape = "slot(竖槽)"
        elif rel > 0.66:
            shape = "arch_head(拱形洞)"
        elif rel < 0.34:
            shape = "inverted/diamond(倒拱/菱)"
        else:
            shape = "diamond/mid(菱形/中宽)"
        out.append({
            "x0": round(float(x0m), 3), "x1": round(float(x1m), 3),
            "y0": round(float(y_bot), 3), "y1": round(float(y_top), 3),
            "w_max": round(max_w, 3), "h": round(float(h), 3),
            "y_at_widest": round(float(y_widest), 3),
            "rise_from_widest": round(float(y_top - y_widest), 3),
            "rise_over_w": round(float((y_top - y_widest) / max(max_w, 1e-9)), 4),
            "shape": shape,
            "px": len(pts),
        })
    out.sort(key=lambda r: -r["px"])
    return out


def fit_circle(pts):
    """代数圆拟合，返回 (cx, cy, r, rms)；退化返回 None"""
    if len(pts) < 5:
        return None
    x, y = pts[:, 0], pts[:, 1]
    A = np.stack([x, y, np.ones_like(x)], 1)
    b = x ** 2 + y ** 2
    try:
        sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    except np.linalg.LinAlgError:
        return None
    cx, cy = sol[0] / 2, sol[1] / 2
    r2 = sol[2] + cx ** 2 + cy ** 2
    if r2 <= 0:
        return None
    r = float(np.sqrt(r2))
    rms = float(np.sqrt(np.mean((np.hypot(x - cx, y - cy) - r) ** 2)))
    return float(cx), float(cy), r, rms


def analyse_opening(cols_idx, lo, s, pad, prof, min_void=0.25, bbox=None):
    """对一段空洞列做拱券精测。

    起拱线判定：开洞两端内缘若有近竖直墩身（jamb，|dy/dx|>3），
    起拱线 = 墩身顶（竖直段上沿）；跨度 = 墩身间距。
    若内缘一路弯到 bbox 底（无竖直段）→ 记为 cut_arch（被截断的拱段），
    起拱线取 bbox 底，跨度取底部开口宽。
    """
    a, b = cols_idx
    x_of = lambda j: lo[0] + (j - pad) / s
    x0, x1 = x_of(a), x_of(b)
    span_open = x1 - x0
    intr = prof["y_bot_geom"][a:b + 1]          # 内弧（拱腹）
    voidh = prof["void_h"][a:b + 1]
    n = len(intr)
    xs = np.array([x_of(j) for j in range(a, b + 1)])

    # ── 起拱线：从游程边缘向内找「陡段→弧线」拐点（墩身竖直段的上沿）──
    def jamb_edge(side):
        lim = max(5, n // 3)
        idxs = list(range(0, lim)) if side == "L" else list(range(n - 1, n - 1 - lim, -1))
        seen_steep = False
        for j in idxs:
            j2 = j + 1 if side == "L" else j - 1
            if j2 < 0 or j2 >= n:
                break
            y1, y2 = intr[j], intr[j2]
            if not (np.isfinite(y1) and np.isfinite(y2)):
                break
            dx = abs(xs[j2] - xs[j])
            slope = abs(y2 - y1) / max(dx, 1e-9)
            if slope > 3.0:
                seen_steep = True
            elif seen_steep and slope < 2.0:
                # 拐点：取陡段末端（y 更高的一侧）
                return (j, float(y1)) if side == "L" else (j, float(y1)), True
        if seen_steep:
            j = idxs[0]
            return (j, float(intr[j])), True
        j = 0 if side == "L" else n - 1
        return (j, float(intr[j]) if np.isfinite(intr[j]) else float("nan")), False

    (jl, yl), vL = jamb_edge("L")
    (jr, yr), vR = jamb_edge("R")
    cut = not (vL and vR)
    # 跨度取底部开洞宽（墩身竖直 → 起拱线处同宽）；墩身外扩时用起拱点 x
    span_bottom = abs(x_of(b) - x_of(a))
    xL, xR = xs[jl], xs[jr]
    span = span_bottom
    ys = float(np.nanmedian([yl, yr])) if np.isfinite(yl) and np.isfinite(yr) else float("nan")
    crown_i = int(np.nanargmax(intr))
    crown = float(intr[crown_i])
    apex_x = float(xs[crown_i])
    rise = crown - ys
    out = {
        "x0": round(float(x0), 3), "x1": round(float(x1), 3),
        "void_width_at_bbox_bottom": round(float(span_open), 3),
        "span_at_spring": round(float(span), 3),
        "spring_y": round(ys, 3),
        "spring_y_l": round(float(yl), 3), "spring_y_r": round(float(yr), 3),
        "spring_x_l": round(float(xL), 3), "spring_x_r": round(float(xR), 3),
        "crown_y": round(crown, 3),
        "apex_x": round(apex_x, 3),
        "rise": round(float(rise), 3),
        "rise_span_ratio": round(float(rise) / span, 4) if span > 0 else None,
        "max_void_h": round(float(np.nanmax(voidh)), 3),
        "cut_arch": bool(cut),
        "has_jamb": bool(vL or vR),
    }
    if bbox is not None:
        out["spring_above_bbox_bottom"] = round(ys - bbox[1], 3)
        out["crown_below_bbox_top"] = round(bbox[3] - crown, 3)
    # 环厚：拱顶处占位段厚度（extrados−intrados at apex）
    out["ring_thickness_at_apex"] = round(float(prof["runs_thick"][a + crown_i]), 3) \
        if np.isfinite(prof["runs_thick"][a + crown_i]) else None
    out["extrados_crown_y"] = round(float(prof["runs_top"][a + crown_i]), 3) \
        if np.isfinite(prof["runs_top"][a + crown_i]) else None
    # 两心圆理论值（由 span/rise 推）；a<0→圆心在跨内偏中（尖拱），a=0→半圆，a>0→跨外（扁/平拱）
    w = span / 2.0
    if w > 0 and rise > 0:
        a_off = (rise ** 2 - w ** 2) / (2 * w)
        Rc = (rise ** 2 + w ** 2) / (2 * w)
        out["twocenter_R"] = round(Rc, 3)
        out["twocenter_center_offset"] = round(a_off, 3)
        out["R_over_span"] = round(Rc / span, 4)
        out["rise_over_halfspan"] = round(rise / w, 4)
    # 半跨数值圆拟合（剔除墩身过渡区：局部斜率 >2.5 的点不参与）
    cxm = (float(xL) + float(xR)) / 2 if np.isfinite(xL) and np.isfinite(xR) else (float(x0) + float(x1)) / 2
    m_ok = np.isfinite(intr)
    if n >= 3:
        dy = np.abs(np.diff(intr, prepend=intr[0]))
        dxs = np.abs(np.diff(xs, prepend=xs[0] - 1e-6))
        with np.errstate(divide="ignore", invalid="ignore"):
            slope_arr = np.where(dxs > 1e-9, dy / dxs, 0.0)
        m_ok = m_ok & (slope_arr < 2.5)
    left = m_ok & (xs < cxm - 0.02 * span)
    right = m_ok & (xs > cxm + 0.02 * span)
    fits = {}
    for side, m in (("L", left), ("R", right)):
        fits[side] = fit_circle(np.stack([xs[m], intr[m]], 1)) if m.sum() >= 5 else None
    out["circle_fit"] = {
        k: ({"cx": round(v[0], 3), "cy": round(v[1], 3), "r": round(v[2], 3),
             "rms": round(v[3], 4)} if v else None)
        for k, v in fits.items()
    }
    # 判型：数值拟合圆心间距 + 顶点折角
    kind = "undetermined"
    if fits.get("L") and fits.get("R") and span > 0:
        fL, fR = fits["L"], fits["R"]
        sep = abs(fL[0] - fR[0])
        out["half_center_sep"] = round(float(sep), 3)
        out["fit_r_mean"] = round(float((fL[2] + fR[2]) / 2), 3)

        def slope(m_side, near_left):
            idxs = np.where(m_side)[0]
            if len(idxs) < 3:
                return None
            take = idxs[-6:] if near_left else idxs[:6]
            return float(np.polyfit(xs[take], intr[take], 1)[0])

        kL, kR = slope(left, True), slope(right, False)
        if kL is not None and kR is not None:
            ang = abs(np.degrees(np.arctan(kL) - np.arctan(kR)))
            out["apex_cusp_deg"] = round(float(ang), 2)
        else:
            out["apex_cusp_deg"] = None
        rms_max = max(fL[3], fR[3])
        if rms_max > 0.02 * max(span, 1e-6):
            kind = "irregular(不规则/复合线脚)"
        elif sep > 0.02 * span or (out.get("apex_cusp_deg") or 0) > 4:
            kind = "pointed(尖拱)"
        else:
            kind = "round(圆拱)"
    out["arch_kind"] = kind
    return out


def analyse_mesh(gname, mname, P, T, res=1000):
    lo, hi = P.min(0), P.max(0)
    size = hi - lo
    rec = {
        "model": mname, "geo": gname,
        "tris": int(T.shape[0]), "verts": int(P.shape[0]),
        "size_m": [round(float(v), 3) for v in size],
        "lo_m": [round(float(v), 3) for v in lo],
        "hi_m": [round(float(v), 3) for v in hi],
        "openings": [],
    }
    occ, s, pad, lo2, wh = raster_xy(P, T, res)
    prof = column_profile(occ, s, pad, lo2, wh)
    min_void = max(0.25, 0.02 * float(size[1]))
    mask = prof["void_h"] > min_void
    bbox = (float(lo[0]), float(lo[1]), float(hi[0]), float(hi[1]))
    for (a, b) in runs_of(mask):
        if (b - a) < max(4, 0.01 * occ.shape[1]):
            continue
        op = analyse_opening((a, b), lo2, s, pad, prof, min_void, bbox=bbox)
        # 过滤噪声：开洞跨度 < 6% 件宽 的丢弃（线脚缝隙/柱身装饰槽）
        if op["void_width_at_bbox_bottom"] < 0.06 * float(size[0]):
            continue
        op["cols"] = [int(a), int(b)]
        rec["openings"].append(op)
    # 半件识别：任一开洞触到 bbox 左右边缘 → half_piece
    rec["half_piece"] = any(
        (o["cols"][0] <= 2) or (o["cols"][1] >= occ.shape[1] - 3) for o in rec["openings"])
    # 封闭内空洞（拱形门洞/窗花/菱窗）
    rec["voids"] = interior_voids(occ, s, pad, lo2, wh)
    # 采样内弧曲线（每 2% 跨度一个点，供报告/绘图）
    for op in rec["openings"]:
        a, b = op["cols"]
        xs = lo2[0] + (np.arange(a, b + 1) - pad) / s
        intr = prof["y_bot_geom"][a:b + 1]
        step = max(1, (b - a) // 40)
        pts = [[round(float(xs[i]), 3), round(float(intr[i]), 3)]
               for i in range(0, len(xs), step) if np.isfinite(intr[i])]
        op["intrados_samples"] = pts
    return rec


# ─────────────────────────── 节拍（栏杆/柱阵） ───────────────────────────

def cadence_top(P, T, res=1600):
    """上包络方波游程 → 齿距/凸宽/凹宽（米）。"""
    occ, s, pad, lo, wh = raster_xy(P, T, res)
    H, W = occ.shape
    top = np.full(W, np.nan)
    py_bot = H - pad
    for j in range(W):
        idx = np.where(occ[:, j])[0]
        if len(idx):
            top[j] = lo[1] + (py_bot - idx.min()) / s
    valid = np.isfinite(top)
    if valid.sum() < 20:
        return None
    env = top[valid]
    k = 5
    padk = np.pad(env, k // 2, mode="edge")
    sm = np.array([np.median(padk[i:i + k]) for i in range(len(env))])
    lo_e, hi_e = sm.min(), sm.max()
    if hi_e - lo_e < 0.02:
        return None
    thr = (lo_e + hi_e) / 2
    on = sm > thr
    runs, st = [], 0
    for i in range(1, len(on)):
        if on[i] != on[i - 1]:
            runs.append((bool(on[i - 1]), i - st))
            st = i
    runs.append((bool(on[-1]), len(on) - st))
    hs = [n for f, n in runs if f]
    gs = [n for f, n in runs if not f]
    if not hs:
        return None
    return {
        "envelope_drop": round(float(hi_e - lo_e), 3),
        "n_bumps": len(hs),
        "bump_w": round(float(np.mean(hs)) / s, 3),
        "gap_w": round(float(np.mean(gs)) / s, 3) if gs else None,
        "pitch": round(float(np.mean([n for _, n in runs])) / s, 3),
    }


# ─────────────────────────── 语义分类 ───────────────────────────

def classify(name):
    n = name.lower().replace("wcarchelem", "").replace("wca", "")
    if "arch" in n:
        return "拱券"
    if "collumn" in n or "column" in n:
        return "柱"
    if "window" in n:
        return "窗"
    if "cornice" in n:
        return "檐口/栏板"
    if "contrforce" in n:
        return "扶壁"
    if "beam" in n:
        return "梁/竖杆"
    if "stair" in n:
        return "楼梯"
    if "wall" in n:
        return "墙"
    if "braizer" in n:
        return "火盆"
    if "bell" in n:
        return "钟"
    if "flat" in n:
        return "圆浮雕/玫瑰窗"
    if "baluster" in n:
        return "宝瓶柱"
    if "decor" in n:
        return "装饰条"
    return "其他"


# ─────────────────────────── 主流程 ───────────────────────────

def load_scene(fbx):
    sc = R.Scene(fbx, 0.01)
    items = []
    for gid, g in sc.geos.items():
        if g["verts"] is None or not len(g["verts"]):
            continue
        mid = sc.geo_parent.get(gid)
        mname = sc.models[mid]["name"] if mid else "(none)"
        P = g["verts"].reshape(-1, 3) * 0.01
        W = sc.world.get(mid, np.eye(4)) if mid else np.eye(4)
        if mid:
            W = W @ sc.geometric_matrix(mid)
        Pw = P @ W[:3, :3].T + W[:3, 3]
        T = R.triangulate(g["idx"])
        T = T[T.max(1) < P.shape[0]]
        items.append({"gid": gid, "geo": g["name"], "model": mname,
                      "P": Pw, "T": T,
                      "trans": [round(float(v), 3) for v in sc.models[mid]["t"]] if mid else [0, 0, 0]})
    return sc, items


def process(fbx, label, do_cadence=True):
    print("## %s  (%s)" % (label, fbx))
    sc, items = load_scene(fbx)
    rows = []
    for it in sorted(items, key=lambda r: -r["T"].shape[0]):
        rec = analyse_mesh(it["geo"], it["model"], it["P"], it["T"])
        rec["semantic"] = classify(it["model"])
        rec["lcl_t"] = it["trans"]
        if do_cadence and rec["size_m"][0] > 3.0 and rec["tris"] > 500:
            c = cadence_top(it["P"], it["T"])
            if c:
                rec["cadence"] = c
        rows.append(rec)
        ops = rec["openings"]
        opstr = "; ".join(
            "span %.2f rise %.2f r/s %.2f %s R=%.2f%s" % (
                o["span_at_spring"], o["rise"], o["rise_span_ratio"] or -1,
                o.get("arch_kind", "?"), o.get("twocenter_R") or -1,
                " CUT" if o.get("cut_arch") else "")
            for o in ops[:2]) or "无下缘空洞"
        vs = rec.get("voids") or []
        vstr = (" | VOID " + "; ".join(
            "w%.2f h%.2f rise/w %.2f %s" % (v["w_max"], v["h"], v["rise_over_w"], v["shape"])
            for v in vs[:3])) if vs else ""
        print("  %-30s %-12s %6d tri  %6.2f×%6.2f×%6.2f  %s | %s%s" % (
            rec["model"][:29], rec["geo"][:11], rec["tris"],
            rec["size_m"][0], rec["size_m"][1], rec["size_m"][2],
            rec["semantic"], opstr, vstr))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fbx-dir", required=True)
    ap.add_argument("--json", default=".qa/r28_kit.json")
    ap.add_argument("--only", default="", help="gat|det|b，逗号分隔")
    args = ap.parse_args()
    D = args.fbx_dir
    want = set(s.strip() for s in args.only.split(",") if s.strip()) or {"gat", "det", "b"}
    out = {"tool": "r28_kit.py", "unit": 0.01}
    if "gat" in want:
        out["gat"] = process(os.path.join(D, "SM_Gat.fbx"), "SM_Gat 28 件构件库")
    if "det" in want:
        out["det"] = process(os.path.join(D, "SM_Det.fbx"), "SM_Det 79 件装饰件")
    if "b" in want:
        out["b"] = process(os.path.join(D, "SM_B.fbx"), "SM_B 4 座建筑单体", do_cadence=True)
    with open(args.json, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("\nJSON → %s" % args.json)


if __name__ == "__main__":
    sys.exit(main())
