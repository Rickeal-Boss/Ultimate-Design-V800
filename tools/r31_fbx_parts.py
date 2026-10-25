#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R31 · White Castle FBX **逐件**精测器（环境几何线 A · 耿键码 2026-10-24）

── 为什么再写一个（与 tools/env_measure.py 的分工）────────────────────────
env_measure.py 回答「这个包里有什么、多大」；本脚本回答「**这一件的形体参数
是多少、怎么程序化复刻**」——R30 的 rc128 Dev 复刻之所以停在"示意级"，根因是
只有 bbox 没有**形体参数**（飞扶壁的拱矢高/斜撑角、窗的棂数/花格分格、龛深、
檐口层数、柱径/柱头比……），复刻只能靠注释里的目视估计。

四大类实证量的提取方法（禁目视估，全部数字来自顶点）：
  ① **bbox / 体积 / 面密度**：体积用散度定理 Σ (v0·(v1×v2))/6（闭合网格真值，
     不闭合时会偏小 —— 输出里同时给 tri 与 area 供交叉校验）。
  ② **切片法（slice profile）**：沿主轴按 Δ 分层，每层统计截面**实心占比**与
     **截面宽度** ⇒ 抽出"收分曲线"（柱/塔/宝瓶柱的半径-高度函数）、
     「空腔出现高度」（凹龛的龛深/龛底高度）。
  ③ **外轮廓 sweatline（,x-y 投影）**：对 (x,y) 做 128×128 栅格占据图，
     逐列取 y 的 max/min ⇒ 上下两条包络线 ⇒ 读矢高 / 起拱高度 / 斜撑角。
  ④ **特征周期自相关**：对某轴的占据向量做自相关 ⇒ 主导周期
     （垛口齿距 / 龛列节距 / 卷叶节距 / 窗棂分格数）。

产出：`.qa/r31_fbx/parts_<family>.json`（逐件实证参数）+ 控制台摘要表。
⚠ 零资产纪律：本脚本只**读**参考包并**打印数字**，绝不把 FBX 顶点/贴图数据
  写进工程 —— 产出的是**参数表**，由 castleDetail.ts 程序化重画。

用法：
  C:/Users/16896/.workbuddy/binaries/python/versions/3.13.12/python.exe \
      tools/r31_fbx_parts.py --out .qa/r31_fbx
"""
import argparse
import json
import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env_measure import (  # noqa: E402  （复用已验证的 FBX 二进制解析器）
    Reader, read_node, parse_fbx, walk, split_name, mat_color
)

U = 0.01  # Fab FBX 顶点实为厘米 → 米（env_measure.py 同一口径）

# 关注族 → 正则关键字（按 model 名匹配，不分大小写）
FAMILIES = {
    "contrforce": ("contrforce",),          # ① 飞扶壁
    "window": ("window",),                  # ② 窗（含花格）
    "decor": ("decor",),                    # ③ 雕像凹龛 / 装饰龛
    "cornice": ("cornice",),                # ④ 檐口
    "collumn": ("collumn", "column"),       # ⑤ 柱身 / 柱头
    "baluster": ("baluster",),              # ⑥ 宝瓶柱
    "pinnacle": ("pinnacle",),              # ⑦ 小尖塔
    "crocket": ("crocket",),                # ⑧ 卷叶
    "bell": ("bell",),                      # ⑨ 钟（SM_Det WCBell → 城内钟楼）
    "contr_arch": ("contr_arch", "arch"),   # ⑩ 拱
    "wall": ("wall",),                      # ⑪ 墙（盲拱列依据）
    "beams": ("beam",),                     # ⑫ 梁（连廊楼面）
}


# ══════════════════════════════ 数据抽取 ══════════════════════════════

def load_parts(path):
    """读 FBX → [{model, tris, verts(Nx3), material, diffuse}]"""
    _ver, root, _data = parse_fbx(path)
    geos, models, mats, conns = {}, {}, {}, []
    for n, _p in walk(root):
        nm = n["name"]
        if nm == "Geometry":
            gid = n["props"][0]
            _cls, gname = split_name(n["props"])
            verts, idx = None, None
            for c in n["children"]:
                if c["name"] == "Vertices" and c["props"]:
                    verts = c["props"][0]
                elif c["name"] == "PolygonVertexIndex" and c["props"]:
                    idx = c["props"][0]
            geos[gid] = {"name": gname, "verts": verts, "idx": idx}
        elif nm == "Model":
            mid = n["props"][0]
            _cls, mname = split_name(n["props"])
            sc, tr = [1.0] * 3, [0.0] * 3
            for c in n["children"]:
                if c["name"] == "Lcl Scaling" and c["props"]:
                    sc = list(c["props"][0])[:3]
                elif c["name"] == "Lcl Translation" and c["props"]:
                    tr = list(c["props"][0])[:3]
            models[mid] = {"name": mname, "scale": sc, "trans": tr}
        elif nm == "Material":
            mid = n["props"][0]
            _cls, mname = split_name(n["props"])
            mats[mid] = {"name": mname, "diffuse": mat_color(n)}
        elif nm == "Connections":
            for c in n["children"]:
                if c["name"] == "C" and len(c["props"]) >= 3:
                    conns.append((c["props"][0], c["props"][1], c["props"][2]))

    geo2model = {c: p for _k, c, p in conns if c in geos and p in models}
    model2mat = {c: p for _k, c, p in conns if c in models and p in mats}

    parts = []
    for gid, g in geos.items():
        if not g["verts"] or not g["idx"]:
            continue
        # FBX 多边形索引：负数编码末顶点（~i = -i-1）；三角化只看三角形
        raw = [(-v - 1) if v < 0 else v for v in g["idx"]]
        tris = []
        run = []
        for v in g["idx"]:
            if v < 0:
                run.append(-v - 1)
                # 扇形三角化（n-gon → n-2 tri）
                for i in range(1, len(run) - 1):
                    tris.append((run[0], run[i], run[i + 1]))
                run = []
            else:
                run.append(v)
        if not tris:
            continue
        mid = geo2model.get(gid)
        sc = models[mid]["scale"] if mid else [1.0, 1.0, 1.0]
        tr = models[mid]["trans"] if mid else [0.0, 0.0, 0.0]
        vs = g["verts"]
        V = [(vs[i * 3] * sc[0] * U + tr[0] * U,
              vs[i * 3 + 1] * sc[1] * U + tr[1] * U,
              vs[i * 3 + 2] * sc[2] * U + tr[2] * U) for i in range(len(vs) // 3)]
        mat = mats.get(model2mat.get(mid)) if model2mat.get(mid) else None
        parts.append({
            "model": models[mid]["name"] if mid else "(unmounted)",
            "geo": g["name"],
            "tris": len(tris),
            "verts": V,
            "tri_idx": tris,
            "material": mat["name"] if mat else None,
            "diffuse": mat["diffuse"] if mat else None,
        })
    return parts, mats


# ══════════════════════════════ 实证量 ══════════════════════════════

def bbox(V):
    xs, ys, zs = [p[0] for p in V], [p[1] for p in V], [p[2] for p in V]
    lo = [min(xs), min(ys), min(zs)]
    hi = [max(xs), max(ys), max(zs)]
    return lo, hi, [hi[i] - lo[i] for i in range(3)]


def volume_and_area(V, T):
    """散度定理：体积累加；同时累计面积（nm²）"""
    vol = 0.0
    area = 0.0
    for (a, b, c) in T:
        v0, v1, v2 = V[a], V[b], V[c]
        ax, ay, az = v0
        bx, by, bz = v1
        cx, cy, cz = v2
        # 6·V = v0 · (v1 × v2)
        vol += (ax * (by * cz - bz * cy)
                - ay * (bx * cz - bz * cx)
                + az * (bx * cy - by * cx))
        e0 = (bx - ax, by - ay, bz - az)
        e1 = (cx - ax, cy - ay, cz - az)
        nx = e0[1] * e1[2] - e0[2] * e1[1]
        ny = e0[2] * e1[0] - e0[0] * e1[2]
        nz = e0[0] * e1[1] - e0[1] * e1[0]
        area += 0.5 * (nx * nx + ny * ny + nz * nz) ** 0.5
    return vol / 6.0, area


def slice_profile(V, T, axis, n=24):
    """沿 axis 轴切片：每层给出 [归一化位置, 截面占据面积?, 该层宽度(=max-min)²] 。

    用三角形与平面求交近似实心面积（沃伦？不 —— 用**投影包围**近似即可读趋势）：
    这里取「层内三角形包围盒面积」做 naive 上界，仅作**相对收分曲线**用，
    不用作绝对体积。真正的绝对量看 volume_and_area。
    """
    lo, hi, size = bbox(V)
    if size[axis] <= 1e-9:
        return []
    a0, a1 = lo[axis], hi[axis]
    layers = [[0.0] * n, [0.0] * n, [0.0] * n]  # min other1, max other1, min other2, max other2 取舍
    o1 = (axis + 1) % 3
    o2 = (axis + 2) % 3
    mins1 = [1e9] * n
    maxs1 = [-1e9] * n
    mins2 = [1e9] * n
    maxs2 = [-1e9] * n
    cnt = [0] * n
    for (a, b, c) in T:
        tri = (V[a], V[b], V[c])
        mid = sum(p[axis] for p in tri) / 3.0
        k = int((mid - a0) / (a1 - a0) * (n - 1e-9))
        k = max(0, min(n - 1, k))
        cnt[k] += 1
        for p in tri:
            mins1[k] = min(mins1[k], p[o1])
            maxs1[k] = max(maxs1[k], p[o1])
            mins2[k] = min(mins2[k], p[o2])
            maxs2[k] = max(maxs2[k], p[o2])
    out = []
    for k in range(n):
        t = k / (n - 1)
        if cnt[k] == 0:
            out.append({"t": round(t, 3), "w1": 0.0, "w2": 0.0, "tris": 0})
            continue
        out.append({
            "t": round(t, 3),
            "w1": round(maxs1[k] - mins1[k], 3),
            "w2": round(maxs2[k] - mins2[k], 3),
            "tris": cnt[k],
        })
    return out


def occupancy_grid(V, T, ax_a, ax_b, side=192):
    """栅格占据图（三角内部用重心坐标采样太慢 ⇒ 只栅格化**顶点 + 边**到 [0..side)²。
    边足够密时占据图与实心投影一致（FBX 构件多为 <5k tri，边长 <5cm）。"""
    lo, hi, size = bbox(V)
    a0, a1 = lo[ax_a], hi[ax_a]
    b0, b1 = lo[ax_b], hi[ax_b]
    span = max(a1 - a0, b1 - b0, 1e-6)
    sa = (side - 1) / span
    sb = (side - 1) / span
    grid = [[0] * side for _ in range(side)]

    def plot(px, py):
        if 0 <= px < side and 0 <= py < side:
            grid[py][px] = 1

    def line(p, q):
        x0 = int((p[ax_a] - a0) * sa)
        y0 = int((p[ax_b] - b0) * sb)
        x1 = int((q[ax_a] - a0) * sa)
        y1 = int((q[ax_b] - b0) * sb)
        steps = max(abs(x1 - x0), abs(y1 - y0), 1)
        for i in range(steps + 1):
            plot(int(x0 + (x1 - x0) * i / steps), int(y0 + (y1 - y0) * i / steps))

    for (a, b, c) in T:
        p, q, r = V[a], V[b], V[c]
        line(p, q)
        line(q, r)
        line(r, p)
    return grid, span, side


def envelopes(grid, side):
    """逐列 × 逐行包络：返回 colTop/colBot（side 长，单位格）、rowLeft/rowRight"""
    NEG = -(1 << 30)
    col_top = [NEG] * side
    col_bot = [-1] * side
    for x in range(side):
        for y in range(side):
            if grid[y][x]:
                if y > col_top[x]:
                    col_top[x] = y
                if col_bot[x] < 0:
                    col_bot[x] = y
                col_bot[x] = max(col_bot[x], y)
    row_l = [-1] * side
    row_r = [-1] * side
    for y in range(side):
        for x in range(side):
            if grid[y][x]:
                if row_l[y] < 0:
                    row_l[y] = x
                row_r[y] = max(row_r[y], x)
    return col_top, col_bot, row_l, row_r


def autocorr_period(vec, lo_lag=2, hi_lag=None):
    """一维 0/1 占据向量的自相关主导周期（格）"""
    n = len(vec)
    vals = [1.0 if v else 0.0 for v in vec]
    mean = sum(vals) / n
    dev = [v - mean for v in vals]
    denom = sum(d * d for d in dev)
    if denom < 1e-9:
        return None
    hi_lag = hi_lag or max(lo_lag + 1, n // 3)
    best = (None, -2.0)
    for lag in range(lo_lag, hi_lag):
        s = sum(dev[i] * dev[i + lag] for i in range(n - lag)) / denom
        if s > best[1]:
            best = (lag, s)
    return (best[0], round(best[1], 4)) if best[1] > 0 else None


def column_occupancy(grid, side):
    return [1 if any(grid[y][x] for y in range(side)) else 0 for x in range(side)]


def row_occupancy(grid, side):
    return [1 if any(grid[y][x] for x in range(side)) else 0 for y in range(side)]


def hexs(diffuse):
    if not diffuse:
        return None
    srgb = [round((1.055 * c ** (1 / 2.4) - 0.055) if c > 0.0031308 else c * 12.92, 3)
            for c in diffuse[:3]]
    return "#%02x%02x%02x" % tuple(max(0, min(255, int(round(c * 255)))) for c in srgb)


# ══════════════════════════════ 族特定形体参数 ══════════════════════════════

def measure_part(p):
    V, T = p["verts"], p["tri_idx"]
    lo, hi, size = bbox(V)
    vol, area = volume_and_area(V, T)
    d = {
        "model": p["model"],
        "geo": p["geo"],
        "tris": p["tris"],
        "verts_n": len(V),
        "size_m": [round(v, 3) for v in size],
        "lo_m": [round(v, 3) for v in lo],
        "volume_m3": round(vol, 4),
        "surface_m2": round(area, 3),
        "tri_per_m3": round(p["tris"] / vol, 1) if abs(vol) > 1e-6 else None,
        "material": p["material"],
        "diffuse_srgb": hexs(p["diffuse"]),
    }
    # ① 高度方向（y=1）切片 ⇒ 收分曲线（柱/塔/尖顶的半径-高度函数）
    d["profile_y"] = slice_profile(V, T, 1, 16)
    # ② 正面 x-y 投影 ⇒ 上包络（矢高 / 起拱 / 斜撑）
    grid, span, side = occupancy_grid(V, T, 0, 1, 192)
    col_top, _col_bot, _rl, _rr = envelopes(grid, side)
    cols = column_occupancy(grid, side)
    rows = row_occupancy(grid, side)
    px = span / (side - 1)  # 米/格
    # 上包络（注意：图像 y 越小越高 —— 这里直接取 grid 行 index，行 index 小 = b 轴小
    # ⇒ 需 invert：b 轴通常是 y（高度），所以 top = 最小 y ⇒ 用 colBot 语义）
    tops = []
    for x in range(side):
        ys = [y for y in range(side) if grid[y][x]]
        tops.append(ys[0] if ys else None)
    valid = [(x, tops[x]) for x in range(side) if tops[x] is not None]
    if valid:
        xs = [x for x, _y in valid]
        ys = [y for _x, y in valid]
        d["front"] = {
            "y_top_m": round((side - 1 - min(ys)) * px, 3),
            "y_bot_m": round((side - 1 - max(ys)) * px, 3),
            "x_span_m": round((max(xs) - min(xs)) * px, 3),
            "top_slope_deg": None,
            "period_M": None,
        }
        # 斜撑角：上包络左 1/4 与中间点的斜率 ⇒ atan(dy/dx)
        q = max(1, len(valid) // 4)
        x0, y0 = valid[0]
        x1, y1 = valid[q]
        if abs(valid[0][0] - valid[q][0]) > 2:
            d["front"]["top_slope_deg"] = round(
                __import__("math").degrees(__import__("math").atan2((y1 - y0), (x1 - x0))), 2)
        per = autocorr_period(cols)
        if per:
            d["front"]["period_M"] = round(per[0] * px, 3)
    # ③ z 轴节拍（龛列 / 棂数）
    per_z = autocorr_period(row_occupancy(occupancy_grid(V, T, 2, 1, 192)[0], 192))
    d["period_z_M"] = round(per_z[0] * (bbox(V)[2][2] / 191), 3) if per_z else None
    return d


# ══════════════════════════════ 主流程 ══════════════════════════════

SRC = {
    "sm_det": "F:/Game/VaultCache/FabLibrary/White_castle-0ffccb05/fbx/whitecastle_fbx_extracted/WhiteCastle_FBX/SM_Det.fbx",
    "sm_gat": "F:/Game/VaultCache/FabLibrary/White_castle-0ffccb05/fbx/whitecastle_fbx_extracted/WhiteCastle_FBX/SM_Gat.fbx",
    "sm_b": "F:/Game/VaultCache/FabLibrary/White_castle-0ffccb05/fbx/whitecastle_fbx_extracted/WhiteCastle_FBX/SM_B.fbx",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=".qa/r31_fbx")
    ap.add_argument("--family", default="all")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    all_rows = []
    for key, path in SRC.items():
        if not os.path.exists(path):
            print("[!] 缺失 %s" % path)
            continue
        parts, mats = load_parts(path)
        print("── %s: %d 件 / %d 材质" % (key, len(parts), len(mats)))
        rows = []
        for p in parts:
            try:
                rows.append(measure_part(p))
            except Exception as e:  # noqa: BLE001
                print("   [x] %s: %s" % (p["model"][:30], str(e)[:80]))
        rows.sort(key=lambda r: (r["model"].lower(), r["size_m"][1]))
        all_rows.extend(rows)
        with open(os.path.join(args.out, "parts_%s.json" % key), "w", encoding="utf-8") as f:
            json.dump({"file": key, "rows": rows}, f, ensure_ascii=False, indent=1)
        print("   → parts_%s.json (%d 件)" % (key, len(rows)))

    # 族分组摘要
    def fam_of(name):
        low = name.lower()
        for fam, keys in FAMILIES.items():
            if any(k in low for k in keys):
                return fam
        return "other"

    print("")
    print("%-34s%7s%8s%8s%8s%11s%11s%9s" % ("model", "tris", "w", "h", "d", "vol m3", "area m2", "period Y"))
    print("─" * 100)
    for r in sorted(all_rows, key=lambda r: (fam_of(r["model"]), -r["size_m"][1])):
        if args.family != "all" and fam_of(r["model"]) != args.family:
            continue
        s = r["size_m"]
        per = r["front"]["period_M"] if r.get("front") else None
        print("%-34s%7d%8.2f%8.2f%8.2f%11.3f%11.3f%9s" % (
            r["model"][:33], r["tris"], s[0], s[1], s[2],
            r["volume_m3"], r["surface_m2"], per if per else "-"))

    with open(os.path.join(args.out, "parts_all.json"), "w", encoding="utf-8") as f:
        json.dump({"rows": all_rows}, f, ensure_ascii=False, indent=1)
    print("\nJSON → %s/parts_*.json" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
