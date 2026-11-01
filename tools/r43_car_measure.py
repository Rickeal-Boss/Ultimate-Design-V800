#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R43 车模精测器 —— 从"高精度 FBX"提取**纯参数表**（零资产入库）

复用 env_measure.py 的二进制 FBX 解析原语（Reader / read_node / parse_fbx / walk），
只把 read_array 换成 numpy 版本（提速 + 直接得 ndarray）。

产出全部是数字：bbox、剖面点列、半径、角度、间距；不含顶点/贴图/材质。

用法：
  python r43_car_measure.py probe   <fbx> [--ascii]
  python r43_car_measure.py measure <fbx> --json out.json --declared L,W,H,WB [--bins 72]
"""
import argparse
import json
import os
import sys
import zlib

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import env_measure as em  # noqa: E402

_DT = {"f": "<f4", "d": "<f8", "i": "<i4", "l": "<i8", "q": "<i8"}


# ─────────────────────── FBX → ndarray 装配 ───────────────────────

def _np_read_array(r, fmt_char, item_size):
    length = r.u4()
    encoding = r.u4()
    comp_len = r.u4()
    blob = r.raw(comp_len)
    if encoding == 1:
        blob = zlib.decompress(blob)
    return np.frombuffer(blob[:length * item_size], dtype=_DT[fmt_char])[:length]


def load_assembly(fbx):
    orig = em.read_array
    em.read_array = _np_read_array
    try:
        version, root, _data = em.parse_fbx(fbx)
    finally:
        em.read_array = orig

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
            if verts is not None and idx is not None:
                geos[gid] = {"name": gname, "verts": verts, "idx": idx}
        elif nm == "Model":
            mid = n["props"][0]
            _cls, mname = em.split_name(n["props"])
            sc, tr, rt = [1.0, 1.0, 1.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
            for c in n["children"]:
                if c["name"] == "Lcl Scaling" and c["props"]:
                    sc = list(c["props"][0])[:3]
                elif c["name"] == "Lcl Translation" and c["props"]:
                    tr = list(c["props"][0])[:3]
                elif c["name"] == "Lcl Rotation" and c["props"]:
                    rt = list(c["props"][0])[:3]
            models[mid] = {"name": mname, "scale": sc, "trans": tr, "rot": rt}
        elif nm == "Connections":
            for c in n["children"]:
                if c["name"] == "C" and len(c["props"]) >= 3:
                    conns.append((c["props"][1], c["props"][2]))
    geo2model = {c: p for c, p in conns if c in geos and p in models}

    all_v, all_t, parts = [], [], []
    off = 0
    for gid, g in geos.items():
        v = np.asarray(g["verts"], dtype=np.float64).reshape(-1, 3)
        mid = geo2model.get(gid)
        if mid:
            v = v * np.asarray(models[mid]["scale"]) + np.asarray(models[mid]["trans"])
        idx = np.asarray(g["idx"], dtype=np.int64)
        ends = np.nonzero(idx < 0)[0]
        if ends.size == 0:
            continue
        starts = np.concatenate(([0], ends[:-1] + 1))
        rlen = ends - starts + 1
        flat = idx.copy()
        flat[ends] = ~flat[ends]
        tri = rlen == 3
        tp = [np.stack([flat[starts[tri]], flat[starts[tri] + 1], flat[ends[tri]]], axis=1)]
        for s, e in zip(starts[~tri], ends[~tri]):
            ring = flat[s:e + 1]
            if len(ring) < 3:
                continue
            tp.append(np.stack([np.full(len(ring) - 2, ring[0]), ring[1:-1], ring[2:]], axis=1))
        if not tp:
            continue
        t = np.vstack(tp).astype(np.int32) + off
        all_v.append(v)
        all_t.append(t)
        parts.append({"geo": g["name"], "model": models[mid]["name"] if mid else "-",
                      "tris": int(t.shape[0]), "verts": len(v)})
        off += len(v)
    if not all_v:
        raise SystemExit("没有可解析的网格")
    return version, np.vstack(all_v), np.vstack(all_t), {"models": models, "parts": parts}


def vertex_normals(v, t):
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    n = np.cross(b - a, c - a)
    vn = np.zeros_like(v)
    for k in range(3):
        np.add.at(vn, t[:, k], n)
    ln = np.linalg.norm(vn, axis=1)
    ln[ln == 0] = 1.0
    return vn / ln[:, None]


# ─────────────────────── 通用归约 ───────────────────────

def rmax(idx, val, nb):
    out = np.full(nb, -np.inf)
    ok = (idx >= 0) & (idx < nb)
    np.maximum.at(out, idx[ok], val[ok])
    out[np.isinf(out)] = np.nan
    return out


def rmin(idx, val, nb):
    out = np.full(nb, np.inf)
    ok = (idx >= 0) & (idx < nb)
    np.minimum.at(out, idx[ok], val[ok])
    out[np.isinf(out)] = np.nan
    return out


def zidx(z, edges):
    return np.digitize(z, edges) - 1


# ─────────────────────── 轮组 / 轮拱 ───────────────────────

def find_wheels(v, ground):
    """接地区 z 簇 → 每轮：轴心(y,z)、胎半径、胎宽、轮距、辋半径、拱唇半径、外翻量"""
    H = v[:, 1].max() - ground
    R0 = 0.21 * H
    low = v[v[:, 1] < ground + 0.12 * R0]
    zl = np.sort(low[:, 2])
    cut = np.nonzero(np.diff(zl) > 4 * R0)[0]
    groups = [g for g in np.split(zl, cut + 1) if g.size > 40]
    out = []
    for g in groups:
        zc0 = float(g.mean())
        # 接地区（仅轮胎）→ 胎 x 带
        sel = (np.abs(low[:, 2] - zc0) < 1.2 * R0)
        ax_ = np.abs(low[sel, 0])
        xin, xout = (float(np.percentile(ax_, 2)), float(np.percentile(ax_, 98)))
        xc = 0.5 * (xin + xout)
        tirew = xout - xin
        # 圆拟合：约束 yc=R（落地），扫 (R, zc)
        band = (np.abs(v[:, 0]) > xin - 0.004) & (np.abs(v[:, 0]) < xout + 0.004) & \
               (np.abs(v[:, 2] - zc0) < 1.6 * R0) & (v[:, 1] < 2.2 * R0)
        y = v[band, 1]
        z = v[band, 2]
        best = (R0, zc0, -1)
        for R in np.arange(R0 * 0.90, R0 * 1.10, 0.0003):
            for dz in np.arange(-0.010, 0.0101, 0.0012):
                d = np.hypot(y - R, z - (zc0 + dz))
                cnt = int(np.count_nonzero(np.abs(d - R) < 0.0009))
                if cnt > best[2]:
                    best = (float(R), float(zc0 + dz), cnt)
        R, zc, _ = best
        yc = R
        # 轮辋半径：胎内部径向直方图的最大谷（胎侧-轮辋交界）
        d = np.hypot(v[band, 1] - yc, v[band, 2] - zc)
        inner = d[d < R * 0.92]
        rim_r = float(np.percentile(inner, 55)) if inner.size else None
        # 轮拱唇：|x| 在胎外侧的车体，绕轴心的最小半径（拱顶 -30..200°）
        ab = (np.abs(v[:, 2] - zc) < 1.5 * R) & (v[:, 1] < 2.4 * R) & \
             (npm_abs(v[:, 0]) > xout + 0.006)
        Q = v[ab]
        rq = np.hypot(Q[:, 1] - yc, Q[:, 2] - zc)
        aq = np.degrees(np.arctan2(Q[:, 1] - yc, Q[:, 2] - zc))
        prof = []
        for a0 in range(-30, 201, 15):
            m = (aq >= a0) & (aq < a0 + 15)
            if np.count_nonzero(m) < 6:
                continue
            prof.append([a0 + 7.5, round(float(np.percentile(rq[m], 3)), 5)])
        arch = float(np.median([p[1] for p in prof if 30 <= p[0] <= 150])) if prof else None
        # 外翻量：拱区 max|x| − 同 z 但更高处（窗下肩部）max|x|
        zb = (np.abs(v[:, 2] - zc) < 0.75 * R) & (v[:, 1] > yc) & (v[:, 1] < 1.9 * R)
        flare = float(np.max(np.abs(v[zb, 0])) - np.max(np.abs(v[ab, 0]))) if np.count_nonzero(ab) else None
        out.append({"axleZ": zc, "axleY": yc, "R": R, "tireWidth": tirew, "track": 2 * xc,
                    "xInner": xin, "xOuter": xout, "rimR": rim_r, "archLipR": arch,
                    "archProfile": prof, "flareX": flare, "fitHits": int(_)})
    out.sort(key=lambda w: -w["axleZ"])
    return out


def npm_abs(a):
    return np.abs(a)


def tire_mask(v, wheels):
    m = np.zeros(len(v), dtype=bool)
    ax = np.abs(v[:, 0])
    for w in wheels:
        r = np.hypot(v[:, 1] - w["axleY"], v[:, 2] - w["axleZ"])
        m |= (r < 1.04 * w["R"]) & (ax > w["xInner"] - 0.006) & (ax < w["xOuter"] + 0.006)
    return m


# ─────────────────────── 包络 / 剖面 ───────────────────────

def circ_radius(p1, p2, p3):
    (x1, y1), (x2, y2), (x3, y3) = p1, p2, p3
    a = np.hypot(x2 - x1, y2 - y1)
    b = np.hypot(x3 - x2, y3 - y2)
    c = np.hypot(x1 - x3, y1 - y3)
    s = (a + b + c) / 2
    area = max(s * (s - a) * (s - b) * (s - c), 1e-18) ** 0.5
    return a * b * c / (4 * area)


def station_profiles(v, edges):
    """沿 z 分箱的侧/俯包络（v 为车身顶点，已剔除轮胎）"""
    nb = len(edges) - 1
    z = v[:, 2]
    y = v[:, 1]
    ax = np.abs(v[:, 0])
    halfW = float(ax.max())
    eb = zidx(z, edges)
    res = {
        "top": rmax(eb, y, nb),
        "bot": rmin(eb, y, nb),
        "half": rmax(eb, ax, nb),
    }
    c = ax < 0.10 * halfW
    res["topCtr"] = rmax(eb[c], y[c], nb)
    res["botCtr"] = rmin(eb[c], y[c], nb)
    s = (ax > 0.52 * halfW)
    res["botSide"] = rmin(eb[s], y[s], nb)
    # 腰线高度 = 该站位 max|x| 所处的 y
    y0, H = y.min(), y.max() - y.min()
    ny = 48
    yi = np.clip(((y - y0) / H * ny).astype(int), 0, ny - 1)
    belt = np.full(nb, np.nan)
    for i in range(nb):
        m = eb == i
        if np.count_nonzero(m) < 30:
            continue
        p = rmax(yi[m], ax[m], ny)
        if np.all(np.isnan(p)):
            continue
        belt[i] = y0 + (np.nanargmax(p) + 0.5) / ny * H
    res["belt"] = belt
    return res


def section(v, zc, hz, ny=60):
    m = np.abs(v[:, 2] - zc) < hz
    if np.count_nonzero(m) < 30:
        return []
    P = v[m]
    y0, y1 = float(P[:, 1].min()), float(P[:, 1].max())
    if y1 - y0 < 1e-9:
        return []
    yi = np.clip(((P[:, 1] - y0) / (y1 - y0) * ny).astype(int), 0, ny - 1)
    p = rmax(yi, np.abs(P[:, 0]), ny)
    third = rmin(yi, np.abs(P[:, 0]), ny)
    return [[round(y0 + (j + 0.5) / ny * (y1 - y0), 5),
             None if np.isnan(p[j]) else round(float(p[j]), 5),
             None if np.isnan(third[j]) else round(float(third[j]), 5)] for j in range(ny)]


def section_metrics(prof, halfW):
    rows = [r for r in prof if r[1] is not None]
    if len(rows) < 8:
        return {}
    y = np.array([r[0] for r in rows])
    w = np.array([r[1] for r in rows])
    i = int(np.argmax(w))
    wmax, ymax = float(w[i]), float(y[i])
    j = i
    while j + 1 < len(w) and w[j + 1] > wmax * 0.88:
        j += 1
    r_sh = None
    if j - i >= 2:
        k0, k1, k2 = i, (i + j) // 2, j
        r_sh = float(circ_radius((w[k0], y[k0]), (w[k1], y[k1]), (w[k2], y[k2])))
    ytop, wtop = float(y[-1]), float(w[-1])
    ymid = ymax + 0.5 * (ytop - ymax)
    k = int(np.argmin(np.abs(y - ymid)))
    th = float(np.degrees(np.arctan2(wmax - w[k], max(y[k] - ymax, 1e-6)))) if y[k] > ymax else None
    # 车顶弧高：最上层 y 与 max|x| 处的高差
    return {
        "maxHalfW": round(wmax, 5), "maxHalfW_y": round(ymax, 5),
        "shoulderR": None if r_sh is None else round(r_sh, 5),
        "topY": round(ytop, 5), "topHalfW": round(wtop, 5),
        "tumblehomeDeg": None if th is None else round(th, 2),
        "waistPct": round((1 - wmax / halfW) * 100, 2),
    }


# ─────────────────────── ascii 目视 ───────────────────────

CH = " .:-=+*#%@"


def ascii_map(v, ax, ay, cols=118, rows=32):
    a, b = v[:, ax], v[:, ay]
    a0, a1, b0, b1 = a.min(), a.max(), b.min(), b.max()
    ia = np.clip(((a - a0) / max(a1 - a0, 1e-9) * (cols - 1)).astype(int), 0, cols - 1)
    ib = np.clip(((b - b0) / max(b1 - b0, 1e-9) * (rows - 1)).astype(int), 0, rows - 1)
    cnt = np.zeros((rows, cols), dtype=np.int64)
    np.add.at(cnt, (ib, ia), 1)
    c = np.log1p(cnt)
    c /= max(c.max(), 1e-9)
    lines = []
    for r in range(rows - 1, -1, -1):
        lines.append("".join(CH[int(min(c[r, k] * 9 + 0.5, 9))] if cnt[r, k] else " " for k in range(cols)))
    return lines, (a0, a1, b0, b1)


# ─────────────────────── 主流程 ───────────────────────

def cmd_probe(a):
    version, v, t, meta = load_assembly(a.fbx)
    lo, hi = v.min(0), v.max(0)
    print("FBX v%d verts=%d tris=%d" % (version, len(v), len(t)))
    print("bbox lo=%s hi=%s size=%s" % (np.round(lo, 5).tolist(), np.round(hi, 5).tolist(),
                                        np.round(hi - lo, 5).tolist()))
    print("models:", [(m["name"], m["scale"], m["trans"], m["rot"]) for m in meta["models"].values()])
    w = find_wheels(v, float(lo[1]))
    for i, x in enumerate(w):
        print("  wheel%d axleZ=%.5f axleY=%.5f R=%.5f tireW=%.5f track=%.5f rimR=%.5f archR=%s flare=%s hits=%d"
              % (i, x["axleZ"], x["axleY"], x["R"], x["tireWidth"], x["track"],
                 x["rimR"] or -1, x["archLipR"], x["flareX"], x["fitHits"]))
        print("     archProfile:", x["archProfile"])
    if a.ascii:
        tm = tire_mask(v, w)
        for name, (i0, i1) in {"SIDE(z,y)": (2, 1), "TOP(z,x)": (2, 0), "FRONT(x,y)": (0, 1)}.items():
            lines, rng = ascii_map(v[~tm], i0, i1)
            print("\n== %s  [%s]∈[%.4f,%.4f] [%s]∈[%.4f,%.4f]" % (name, "zyx"[i0], rng[0], rng[1],
                                                                  "zyx"[i1], rng[2], rng[3]))
            for ln in lines:
                print("  |" + ln + "|")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["probe", "measure"])
    ap.add_argument("fbx")
    ap.add_argument("--json", default="")
    ap.add_argument("--ascii", action="store_true")
    ap.add_argument("--declared", default="", help="L,W,H,WB mm")
    ap.add_argument("--front-sign", type=float, default=0.0)
    ap.add_argument("--bins", type=int, default=72)
    ap.add_argument("--tag", default="")
    args = ap.parse_args()
    if args.cmd == "probe":
        return cmd_probe(args)

    version, v, t, meta = load_assembly(args.fbx)
    lo, hi = v.min(0), v.max(0)
    size = hi - lo
    ground = float(lo[1])

    wheels = find_wheels(v, ground)
    tm = tire_mask(v, wheels)

    # 车头方向：外后视镜簇（|x| 接近最大且高度在腰线上方）更靠近车头
    ax = np.abs(v[:, 0])
    halfW = float(ax.max())
    mir = (ax > 0.93 * halfW) & (v[:, 1] > ground + 0.45 * size[1]) & (v[:, 1] < ground + 0.88 * size[1])
    mirror_z = float(np.median(v[mir, 2])) if np.count_nonzero(mir) else None
    sign = args.front_sign
    if sign == 0.0:
        sign = 1.0 if (mirror_z is not None and mirror_z > 0.5 * (lo[2] + hi[2])) else -1.0
    if sign < 0:                       # 统一成 车头 = +Z
        v = v * np.array([1.0, 1.0, -1.0])
        lo, hi = v.min(0), v.max(0)
        for w in wheels:
            w["axleZ"] = -w["axleZ"]
        wheels.sort(key=lambda w: -w["axleZ"])
        if mirror_z is not None:
            mirror_z = -mirror_z
        tm = tire_mask(v, wheels)

    Lraw = float(hi[2] - lo[2])
    dec = None
    if args.declared:
        p = [float(x) for x in args.declared.split(",")]
        dec = {"L": p[0], "W": p[1], "H": p[2], "WB": p[3] if len(p) > 3 else None}
    sL = (dec["L"] / Lraw) if dec else 1.0
    sH = (dec["H"] / size[1]) if dec else 1.0
    sW = (dec["W"] / (2 * halfW)) if dec else 1.0

    def mm(x):
        return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x) * sL, 1)

    def zn(z):                         # 距前保杠的距离（mm，向后为正）
        return round(float(hi[2] - z) * sL, 1)

    def zc_(z):                        # 相对整车中心（车头为 +）
        return round(float(z - 0.5 * (lo[2] + hi[2])) * sL, 1)

    body = ~tm
    vb = v[body]
    edges = np.linspace(lo[2], hi[2], args.bins + 1)
    zmid = 0.5 * (edges[:-1] + edges[1:])
    sp = station_profiles(vb, edges)

    # 不含外后视镜的俯视半宽（镜区掩码：|x|>0.93halfW 且 y 在 0.45~0.88H）
    mini = body & ~mir if sign > 0 else body & ~mir
    halfNoMir = rmax(zidx(v[mini, 2], edges), np.abs(v[mini, 0]), args.bins)
    mroof = body & (v[:, 1] > ground + 0.88 * size[1])
    halfRoof = rmax(zidx(v[mroof, 2], edges), np.abs(v[mroof, 0]), args.bins)

    side_rows, plan_rows = [], []
    for i in range(args.bins):
        if np.isnan(sp["top"][i]):
            continue
        side_rows.append({
            "zNose": zn(zmid[i]), "zMid": zc_(zmid[i]),
            "roof": mm(sp["top"][i]), "roofCtr": mm(sp["topCtr"][i]),
            "belt": mm(sp["belt"][i]), "sill": mm(sp["botSide"][i]),
            "bottom": mm(sp["bot"][i]), "bottomCtr": mm(sp["botCtr"][i]),
        })
        plan_rows.append({
            "zNose": zn(zmid[i]), "zMid": zc_(zmid[i]),
            "half": mm(sp["half"][i]), "halfNoMirror": mm(halfNoMir[i]), "halfRoof": mm(halfRoof[i]),
        })

    # 断面（t=0 车头 → t=1 车尾）
    fw, rw = wheels[0], wheels[-1]
    secs = [("front-face", 0.010), ("front-bumper", 0.045), ("front-arch", None),
            ("front-row", 0.28), ("b-pillar", 0.44), ("rear-row", 0.60),
            ("rear-arch", None), ("tail", 0.975)]
    out_secs = []
    hz = Lraw / args.bins * 0.62
    for name, f in secs:
        zc = fw["axleZ"] if name == "front-arch" else (rw["axleZ"] if name == "rear-arch" else hi[2] - f * Lraw)
        prof = section(vb, zc, hz)
        out_secs.append({"name": name, "zNose": zn(zc), "zMid": zc_(zc), "profile": prof,
                         "metrics": section_metrics(prof, halfW)})

    # DLO：温室侧面板（法线 ±X）→ 每站位的窗下缘 / 窗上缘 / 玻璃内缩量
    vn = vertex_normals(v, t)
    sf = (np.abs(vn[:, 0]) > 0.80) & body
    dlo = {"stations": [], "ridges": []}
    cab = np.zeros(len(v), dtype=bool)
    for x in wheels:
        cab |= np.abs(v[:, 2] - x["axleZ"]) < 0.10 * Lraw
    gh = sf & (v[:, 1] > ground + 0.52 * size[1]) & (v[:, 2] > lo[2] + 0.10 * Lraw) & \
         (v[:, 2] < hi[2] - 0.06 * Lraw)
    if np.count_nonzero(gh) > 500:
        gy, gz, gx = v[gh, 1], v[gh, 2], np.abs(v[gh, 0])
        dlo["zRangeNose"] = [zn(gz.max()), zn(gz.min())]
        dlo["yRange"] = [mm(gy.min()), mm(gy.max())]
        nb = 24
        e = np.linspace(gz.min(), gz.max(), nb + 1)
        ridge = []
        for i in range(nb):
            m = (gz >= e[i]) & (gz < e[i + 1])
            if np.count_nonzero(m) < 40:
                continue
            ridge.append([zn(0.5 * (e[i] + e[i + 1])), mm(np.percentile(gx[m], 97)),
                          mm(np.percentile(gx[m], 50)), mm(gy[m].max())])
        dlo["ridges"] = ridge
        # 详细站位：最外(柱/框) vs 中位(玻璃) 的 |x| 差 → 内缩量；上缘 = 侧面板最高
        for t_ in [0.18, 0.24, 0.30, 0.36, 0.42, 0.48, 0.54, 0.60, 0.66, 0.72, 0.78, 0.84]:
            zc = hi[2] - t_ * Lraw
            m = (np.abs(v[:, 2] - zc) < 0.006) & sf
            if np.count_nonzero(m) < 40:
                continue
            yy, xx = v[m, 1], np.abs(v[m, 0])
            yTop = float(yy.max())
            xB = float(np.percentile(xx, 99))
            # 窗下缘：从腰线往上，|x| 首次低于 xB-14mm 的 y
            yBelt = None
            for cand in np.arange(0.50, 0.80, 0.01):
                yv = ground + cand * size[1]
                mm_ = np.abs(yy - yv) < 0.004
                if np.count_nonzero(mm_) and np.percentile(xx[mm_], 99) < xB - 0.014:
                    yBelt = yv
                    break
            dlo["stations"].append({"t": t_, "zNose": zn(zc), "yTop": mm(yTop),
                                    "xDloBottom": mm(yBelt), "xBelt": mm(xB)})

    # 车顶激光雷达：车顶区 (z,x) 的 max y 上凸包
    roof = {}
    rsel = body & (v[:, 1] > ground + 0.90 * size[1])
    if np.count_nonzero(rsel) > 100:
        P = v[rsel]
        ymax = float(P[:, 1].max())
        hi_m = P[P[:, 1] > ymax - 0.004]
        if len(hi_m) > 20:
            roof = {"topY": mm(ymax),
                    "patch": {"x": [mm(hi_m[:, 0].min()), mm(hi_m[:, 0].max())],
                              "zNose": [zn(hi_m[:, 2].max()), zn(hi_m[:, 2].min())],
                              "area": int(len(hi_m))}}
        # 车顶高度场：x,z 网格上的 max y（找凸包/拱形）
        nx, nzc = 21, 40
        xe = np.linspace(-halfW, halfW, nx + 1)
        ze = np.linspace(lo[2], hi[2], nzc + 1)
        ix = np.clip(np.digitize(P[:, 0], xe) - 1, 0, nx - 1)
        iz = np.clip(np.digitize(P[:, 2], ze) - 1, 0, nzc - 1)
        grid = np.full(nx * nzc, np.nan)
        np.maximum.at(grid, iz * nx + ix, np.where(np.isnan(grid[iz * nx + ix]), -1e9, grid[iz * nx + ix]))
        g = rmax(iz * nx + ix, P[:, 1], nx * nzc).reshape(nzc, nx)
        g = g[::-1]
        roof["heightFieldRows"] = [[None if np.isnan(x) else mm(x) for x in row] for row in g[::4]]
        roof["heightFieldX"] = [mm(x) for x in xe[::1]]
        roof["heightFieldZNose"] = [zn(z) for z in ze[::-4]]

    out = {
        "file": os.path.basename(args.fbx), "fbxVersion": version, "tag": args.tag,
        "raw": {"lo": lo.tolist(), "hi": hi.tolist(), "size": size.tolist(), "halfWHalf": halfW},
        "declared": dec,
        "scale": {"fromLength": round(sL, 5), "fromHeight": round(sH, 5), "fromWidth": round(sW, 5),
                  "spreadPct": round((max(sL, sH, sW) / min(sL, sH, sW) - 1) * 100, 2)},
        "frontSign": int(sign), "mirrorZNose": None if mirror_z is None else zn(mirror_z),
        "wheels": [], "side": side_rows, "plan": plan_rows, "sections": out_secs,
        "dlo": dlo, "roof": roof,
    }
    for i, w in enumerate(wheels):
        out["wheels"].append({
            "which": "front" if i == 0 else "rear",
            "axleZNose": zn(w["axleZ"]), "axleZMid": zc_(w["axleZ"]), "axleY": mm(w["axleY"]),
            "R": mm(w["R"]), "tireWidth": mm(w["tireWidth"]), "track": mm(w["track"]),
            "xInner": mm(w["xInner"]), "xOuter": mm(w["xOuter"]), "rimR": mm(w["rimR"]),
            "archLipR": mm(w["archLipR"]), "archProfile": [[a_, mm(r_)] for a_, r_ in w["archProfile"]],
            "flareX": mm(w["flareX"]),
        })
    if len(wheels) >= 2:
        out["wheelbase"] = mm(wheels[0]["axleZ"] - wheels[1]["axleZ"])
        out["frontOverhang"] = mm(hi[2] - wheels[0]["axleZ"])
        out["rearOverhang"] = mm(wheels[1]["axleZ"] - lo[2])
        if dec and dec.get("WB"):
            out["wheelbaseDeclared"] = dec["WB"]
            out["wheelbaseErrPct"] = round((out["wheelbase"] - dec["WB"]) / dec["WB"] * 100, 2)

    txt = json.dumps(out, ensure_ascii=False, indent=1)
    if args.json:
        d = os.path.dirname(args.json)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(args.json, "w", encoding="utf-8", newline="\n") as f:
            f.write(txt)

    print("%s  L=%.0f H=%.0f halfW=%.0f  sL=%.3f sH=%.3f sW=%.3f (spread %.2f%%)"
          % (out["file"], Lraw * sL, size[1] * sL, halfW * sL, sL, sH, sW, out["scale"]["spreadPct"]))
    print("frontSign=%+d  mirrorZNose=%s" % (sign, out["mirrorZNose"]))
    for w in out["wheels"]:
        print("  %-5s axleZNose=%7.1f R=%6.1f 胎宽=%6.1f 轮距=%7.1f 辋R=%6.1f 拱唇R=%6.1f 外翻=%6.1f"
              % (w["which"], w["axleZNose"], w["R"], w["tireWidth"], w["track"], w["rimR"] or -1,
                 w["archLipR"] or -1, w["flareX"] or 0))
    if "wheelbase" in out:
        print("  轴距=%.0f 前悬=%.0f 后悬=%.0f  (申报 WB=%s)"
              % (out["wheelbase"], out["frontOverhang"], out["rearOverhang"], dec and dec.get("WB")))
    print("  侧视点列 zNose:roof/roofCtr/belt/sill/bottom")
    step = max(1, len(side_rows) // 14)
    for r in side_rows[::step]:
        print("   %7.1f : %7s %7s %7s %7s %7s" % (r["zNose"], r["roof"], r["roofCtr"], r["belt"],
                                                  r["sill"], r["bottom"]))
    print("  俯视点列 zNose:half/halfNoMirror/halfRoof")
    for r in plan_rows[::step]:
        print("   %7.1f : %7s %7s %7s" % (r["zNose"], r["half"], r["halfNoMirror"], r["halfRoof"]))
    print("  断面：")
    for s_ in out_secs:
        m = s_["metrics"]
        print("   %-13s zNose=%7.1f maxHalfW=%7s@y=%7s shoulderR=%7s tumble=%5s°"
              % (s_["name"], s_["zNose"], m.get("maxHalfW"), m.get("maxHalfW_y"),
                 m.get("shoulderR"), m.get("tumblehomeDeg")))
    if args.json:
        print("JSON → %s" % args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
