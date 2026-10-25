#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R31 · FBX **形体参数**提取（第二阶段；第一阶段 = r31_fbx_parts.py 的 bbox/tri/体积）

为什么单独二阶：
  bbox 只能给"这东西多大"，给不出"的程序化复刻参数"。真正决定观感的是
  **剖面（elevation）的拓扑**：墩宽 / 起拱高度 / 矢高 / 斜撑角 / 竖棂数 /
  凹龛深 / 檐口层数 / 收分曲线。这些必须**从顶点量**，不许目视估（铁律 19）。

방법（全部来自顶点，禁目视）：
  ① **立面设定**：FBX 这些构件都是 Y-up 且薄片/细长 ⇒ 取
     `竖直轴 = y(1)`、`水平主軸 ua = argmax(size[x], size[z])`、
     `挤出/厚度轴 ta = 另一个`。立面 = (ua, y) 平面正交投影。
  ② **占据栅格**：三角形**内部**用重心坐标细采样（不是只画边 —— 只看边会把
     大三角面的内部误判成空腔），256×256，像素值 = 落到该像素的**平均深度**
     （ta 轴上排在最外的值）⇒ 同时得到「形」与「浮雕层」。
  ③ **逐行区间分割**：每行(u 方向)的占据像素做 run-length ⇒ 段数 nSeg。
     · 段数从 1 → 2 的高度 = **起拱线 springY**（构件开始"分叉"）
     · 底 15% 行的最宽段宽 = **墩宽 pierW**（底部只有墩）
     · 最高行所在 y = apex；apex − springY = **矢高 rise**
     · 半高处最大 u 跨度 = **跨距 reach**
  ④ **收分曲线**：每行的 u 跨度 → 归一化 → 16 点采样（塔/柱/瓶柱的半径—高度函数）
  ⑤ **竖棂数**：在直棂带（apex 之下、spring 之上）取一行，对该行的**深度剖面**
     做峰计数 ⇒ mullion 数（窗花格的枝数，不是画上去的凭一套uprofile 判断）
  ⑥ **浮雕层数**：ta 轴坐标的直方图峰值数 ⇒ tracery 有前台多层
  ⑦ **周期**：对「多段行」的 u 方向段起点做差分 ⇒ 主导节距（龛列/卷叶/垛口）

产出：`.qa/r31_fbx/shape_<key>.json` + 关键族立面 PNG（`.qa/r31_fbx/elev/*.png`）。
⚠ 零资产纪律：只读参考包、只小区 yaml 参数；PNG 仅供人眼交叉校验，不入仓破hotograph。

用法：
  python tools/r31_fbx_shape.py [--out .qa/r31_fbx] [--render]
"""
import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from r31_fbx_parts import load_parts, SRC, bbox  # noqa: E402

SIDE = 256

# 需要出立面 PNG 的关键件（按 model 名子串匹配）
RENDER_KEYS = [
    "Contrforce3_Full", "Contrforce3_Full_1", "Contrforce2_1", "Contrforce_1",
    "Window3_Full", "Window2_Full", "Window1_Full", "Window2_4",
    "Decor_1", "Decor_4", "Decor_6", "Decor_7", "Decor_9",
    "Cornice_2_Full", "Cornice_1",
    "Collumn8_Full", "Collumn1_Full",
    "Baluster_1",
    "WCBell_1",
    "ArchElemArch_3", "Wall_1", "Wall_3",
]


def u_axis_of(size):
    """水平主轴：x / z 中较大的那个（同时给出厚度轴）"""
    if size[0] >= size[2]:
        return 0, 2
    return 2, 0


def rasterize(V, T, ua, ta, side=SIDE):
    """正交投影到 (ua, y) 平面，**精确重心光栅化**（沿三角屏幕包围盒逐像素做
    barycentric 内测），返回 [row][col] = 该像素命中三角形的**最大深度**。

    ⚠ 必须填内部：只看顶点/边会把大三角面内部读成"空腔"，导致行段数虚高、
      通廊宽度读数退化成几像素（第一版实测 Window1_3 宽度 0.81m 读成 0.12m）。
    """
    lo, hi, size = bbox(V)
    u0, y0 = lo[ua], lo[1]
    span = max(hi[ua] - lo[ua], hi[1] - lo[1], 1e-6)
    su = (side - 1) / span
    sy = (side - 1) / span
    grid = [[None] * side for _ in range(side)]

    for (a, b, c) in T:
        pa, pb, pc = V[a], V[b], V[c]
        ax = (pa[ua] - u0) * su
        ay = (pa[1] - y0) * sy
        bx = (pb[ua] - u0) * su
        by = (pb[1] - y0) * sy
        cx = (pc[ua] - u0) * su
        cy = (pc[1] - y0) * sy
        da, db, dc = pa[ta], pb[ta], pc[ta]
        area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
        if abs(area) < 1e-12:
            continue
        inv = 1.0 / area
        x0 = int(max(0, math.floor(min(ax, bx, cx))))
        x1 = int(min(side - 1, math.ceil(max(ax, bx, cx))))
        y0i = int(max(0, math.floor(min(ay, by, cy))))
        y1i = int(min(side - 1, math.ceil(max(ay, by, cy))))
        for py in range(y0i, y1i + 1):
            wy = py + 0.5
            for px in range(x0, x1 + 1):
                wx = px + 0.5
                w0 = ((bx - wx) * (cy - wy) - (cx - wx) * (by - wy)) * inv
                w1 = ((cx - wx) * (ay - wy) - (ax - wx) * (cy - wy)) * inv
                w2 = 1.0 - w0 - w1
                if w0 < -1e-6 or w1 < -1e-6 or w2 < -1e-6:
                    continue
                dv = w0 * da + w1 * db + w2 * dc
                cur = grid[py][px]
                if cur is None or dv > cur:
                    grid[py][px] = dv
    return grid, span / (side - 1), side


def row_segments(grid, side):
    """每行 → 占据区间列表 [(u0,u1), ...]（像素单位）"""
    segs = []
    for y in range(side):
        runs = []
        start = None
        for x in range(side):
            on = grid[y][x] is not None
            if on and start is None:
                start = x
            elif not on and start is not None:
                runs.append((start, x - 1))
                start = None
        if start is not None:
            runs.append((start, side - 1))
        segs.append(runs)
    return segs


def shape_metrics(p):
    V, T = p["verts"], p["tri_idx"]
    lo, hi, size = bbox(V)
    ua, ta = u_axis_of(size)
    grid, mppx, side = rasterize(V, T, ua, ta, SIDE)
    segs = row_segments(grid, side)
    occupied_rows = [y for y in range(side) if segs[y]]
    if not occupied_rows:
        return None
    ybot, ytop = min(occupied_rows), max(occupied_rows)
    H = ytop - ybot
    if H < 2:
        return None

    # 总跨 = 占据列极值差；最大连续段 = 单体宽（花格窗立面本就是分立的竖棂 + 边框，
    # 逐行最大 run 是"棂宽"而不是"窗宽" ⇒ 两个量都必须输出，别混为一谈）。
    occupied_cols = [x for x in range(side) if any(grid[y][x] is not None for y in range(side))]
    span_total_m = (occupied_cols[-1] - occupied_cols[0] + 1) * mppx if occupied_cols else 0.0
    max_run_rows = [max((e - s + 1) for s, e in segs[y]) * mppx for y in range(side) if segs[y]]
    max_run_m = max(max_run_rows) if max_run_rows else 0.0
    span_u = span_total_m

    # 中段成员数中位数（窗 = 竖棂 + 框；栏杆 = 瓶柱列的根数）
    mid_rows = [y for y in range(ybot + int(H * 0.25), ytop - int(H * 0.15) + 1) if segs[y]]
    member_counts = sorted(len(segs[y]) for y in mid_rows)
    members_mid = member_counts[len(member_counts) // 2] if member_counts else 0

    # 各行总跨度（含段间空隙）= 外轮廓宽
    widths = []
    for y in range(side):
        if not segs[y]:
            widths.append(0.0)
            continue
        widths.append((segs[y][-1][1] - segs[y][0][0] + 1) * mppx)

    # 起拱线：最早出现多段的行（相对 0..1）
    spring_row = None
    for y in range(ybot, ytop + 1):
        if len(segs[y]) >= 2:
            spring_row = y
            break
    # ② 墩宽：底 15% 行的最宽段
    band = max(1, int(H * 0.15))
    pierW = 0.0
    for y in range(ybot, ybot + band):
        if segs[y]:
            pierW = max(pierW, max(e - s for s, e in segs[y]) * mppx)

    # ③ 收分曲线：16 点
    prof = []
    for k in range(16):
        y = ybot + int(H * k / 15)
        y = min(side - 1, y)
        prof.append(round(widths[y] / (span_u if span_u > 1e-6 else 1.0), 4))

    # ④ 顶宽（顶 5% 行）
    topband = [widths[y] for y in range(max(ybot, ytop - max(1, int(H * 0.05))), ytop + 1)]
    topW = max(topband) if topband else 0.0

    # ⑤ 浮雕层数：ta 深度直方图（bin = 2cm）的峰值数
    lo_t, hi_t = lo[ta], hi[ta]
    nb = max(4, int((hi_t - lo_t) / 0.02))
    hist = [0] * max(1, nb)
    for q in V:
        k = int((q[ta] - lo_t) / max(hi_t - lo_t, 1e-6) * (len(hist) - 1))
        hist[k] += 1
    # 峰值：> 15% 最大 bin 且比左右邻高
    hmax = max(hist) or 1
    peaks = 0
    for k in range(1, len(hist) - 1):
        if hist[k] >= hmax * 0.15 and hist[k] >= hist[k - 1] and hist[k] >= hist[k + 1]:
            peaks += 1

    # ⑥ 竖棂数：取 spring 之上 / apex 之下 30% 的那行，深度剖面的峰数。
    #    窗花格的棂是"浮雕里的峰"：沿 u 扫 sqlite? -> 这里用行的**深度值**做峰计数。
    mull = None
    if spring_row is not None and H > 12:
        yr = spring_row + int((ytop - spring_row) * 0.35)
        yr = min(side - 1, max(0, yr))
        vals = [grid[yr][x] for x in range(side)]
        xs = [x for x in range(side) if vals[x] is not None]
        if len(xs) > 8:
            arr = [vals[x] if vals[x] is not None else min(v for v in vals if v is not None)
                   for x in range(min(xs), max(xs) + 1)]
            base = min(arr)
            amp = max(arr) - base
            if amp > 0.015:  # >1.5cm 起伏才算浮雕
                thr = base + amp * 0.55
                cnt = 0
                inpk = False
                for v in arr:
                    if v >= thr and not inpk:
                        cnt += 1
                        inpk = True
                    elif v < thr:
                        inpk = False
                mull = cnt

    # ⑦ 主导节距：多段行的**段起点**差分中位数
    pitch = None
    starts = []
    for y in range(ybot, ytop + 1):
        if len(segs[y]) >= 2:
            starts.extend(s for s, _e in segs[y])
    if len(starts) >= 6:
        starts = sorted(set(starts))
        diffs = [b_ - a_ for a_, b_ in zip(starts, starts[1:]) if 1 <= b_ - a_ <= side / 2]
        if diffs:
            diffs.sort()
            pitch = round(diffs[len(diffs) // 2] * mppx, 3)

    return {
        "model": p["model"],
        "geo": p["geo"],
        "tris": p["tris"],
        "size_m": [round(v, 3) for v in size],
        "axes": {"u": "xyz"[ua], "thick": "xyz"[ta]},
        "reach_m": round(span_total_m, 3),
        "member_w_m": round(max_run_m, 3),
        "members_mid": members_mid,
        "height_m": round(H * mppx, 3),
        "spring_frac": round((spring_row - ybot) / H, 3) if spring_row is not None else None,
        "rise_m": round((ytop - spring_row) * mppx, 3) if spring_row is not None else None,
        "pier_w_m": round(pierW, 3),
        "top_w_m": round(topW, 3),
        "thick_m": round(size[ta], 3),
        "taper_u": prof,
        "relief_layers": peaks,
        "mullion_peaks": mull,
        "member_pitch_m": pitch,
        "fill_ratio": round(sum(1 for y in range(side) for v in grid[y] if v is not None) / (side * side), 4),
    }


def render_png(p, out):
    try:
        import numpy as np
        from PIL import Image
    except Exception:  # noqa: BLE001
        return None
    V, T = p["verts"], p["tri_idx"]
    lo, hi, size = bbox(V)
    ua, ta = u_axis_of(size)
    grid, _mppx, side = rasterize(V, T, ua, ta, SIDE)
    lo_t, hi_t = lo[ta], hi[ta]
    img = np.zeros((side, side, 3), dtype=np.uint8)
    dvmax = max((grid[y][x] for y in range(side) for x in range(side) if grid[y][x] is not None),
                default=1.0)
    for y in range(side):
        for x in range(side):
            v = grid[y][x]
            if v is None:
                continue
            t = (v - lo_t) / max(dvmax - lo_t, 1e-6)
            # 深度越大越亮（近RGB），? or 用冷暖区分层次
            img[side - 1 - y, x] = (40 + int(200 * t), 40 + int(120 * t), 60 + int(40 * (1 - t)))
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "%s_elev.png" % p["model"].replace("/", "_"))
    Image.fromarray(img).resize((384, 384), Image.NEAREST).save(path)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=".qa/r31_fbx")
    ap.add_argument("--render", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    summary = {}
    for key, path in SRC.items():
        if not os.path.exists(path):
            continue
        parts, _mats = load_parts(path)
        rows = []
        for p in parts:
            try:
                m = shape_metrics(p)
            except Exception as e:  # noqa: BLE001
                print("   [x] %s %s" % (p["model"][:24], str(e)[:60]))
                continue
            if m:
                rows.append(m)
                if args.render and any(k.lower() in p["model"].lower() for k in RENDER_KEYS):
                    pp = render_png(p, os.path.join(args.out, "elev"))
                    if pp:
                        m["elev_png"] = os.path.basename(pp)
        summary[key] = rows
        with open(os.path.join(args.out, "shape_%s.json" % key), "w", encoding="utf-8") as f:
            json.dump({"file": key, "rows": rows}, f, ensure_ascii=False, indent=1)

    print("%-30s%7s%7s%7s%7s%7s%7s%7s%7s%6s%6s" % (
        "model", "tris", "reach", "height", "spring", "rise", "maxRun", "topW", "thick", "relf", "nMem"))
    print("─" * 108)
    for key in summary:
        print("### %s" % key)
        for r in sorted(summary[key], key=lambda r: -r["height_m"]):
            print("  %-28s%7d%7.2f%7.2f%8s%7s%7.2f%7.2f%7.2f%6d%6d" % (
                r["model"][:27], r["tris"], r["reach_m"], r["height_m"],
                ("%.2f" % r["spring_frac"]) if r["spring_frac"] is not None else "-",
                ("%.2f" % r["rise_m"]) if r["rise_m"] is not None else "-",
                r["member_w_m"], r["top_w_m"], r["thick_m"],
                r["relief_layers"] or 0, r["members_mid"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
