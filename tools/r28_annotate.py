#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R28 · 关键件正交立面线框 + 尺寸标注 PNG → .qa/r28_ref/

对每件：三角边采样正交投影（front XY）→ 叠加 W/H 尺寸线与数值、
拱件另叠加 起拱线/拱顶/矢高/跨度 标注（取 .qa/r28_kit.json 实测值）。
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import r27_scene_dump as R  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

FBX_DIR = "F:/Game/VaultCache/FabLibrary/White_castle-0ffccb05/fbx/whitecastle_fbx_extracted/WhiteCastle_FBX"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".qa", "r28_ref")

WANT = [
    ("SM_B.fbx", "Mesh.693", "SM_B_1_3_002_高塔"),
    ("SM_B.fbx", "Mesh.713", "SM_B_12_00_003_主殿"),
    ("SM_B.fbx", "Mesh.723", "SM_B_12_00_001_配楼"),
    ("SM_B.fbx", "Mesh.725", "SM_B_4_3_001_细尖塔"),
    ("SM_Gat.fbx", "Mesh.722", "Gat_Arch_2_Full_主拱"),
    ("SM_Gat.fbx", "Mesh.677", "Gat_Arch_1_Full_小拱"),
    ("SM_Gat.fbx", "Mesh.152", "Gat_Arch_3_001_高拱墙"),
    ("SM_Gat.fbx", "Mesh.710", "Gat_12_00_004_城门"),
    ("SM_Gat.fbx", "Mesh.662", "Gat_Window1_Full_窗"),
    ("SM_Gat.fbx", "Mesh.064", "Gat_Collumn1_柱"),
    ("SM_Gat.fbx", "Mesh.683", "Gat_Cornice_2_Full_栏板18格"),
    ("SM_Gat.fbx", "Mesh.704", "Gat_16_013_墙台"),
    ("SM_Det.fbx", "Details.003", "Det_Braizer_火盆"),
    ("SM_Det.fbx", "Details.011", "Det_Bell_1_钟"),
    ("SM_Det.fbx", "Mesh.069", "Det_Flat_1_圆浮雕"),
    ("SM_Det.fbx", "Mesh.072", "Det_Baluster_1_宝瓶柱"),
]


def font(sz=22):
    for p in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc",
              "C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/arial.ttf"):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, sz)
            except Exception:  # noqa: BLE001
                pass
    return ImageFont.load_default()


def edge_points(P, T, n=4):
    v0, v1, v2 = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    ts = np.linspace(0.0, 1.0, n)[:, None]
    out = []
    for a, b in ((v0, v1), (v1, v2), (v2, v0)):
        d = (b - a)[:, None, :]
        out.append((a[:, None, :] + ts[None, :, :] * d).reshape(-1, 3))
    return np.concatenate(out, 0)


def render_annotated(P, T, tag, kit_row):
    size = 1100
    pad = 130
    lo, hi = P.min(0), P.max(0)
    spanx, spany = float(hi[0] - lo[0]), float(hi[1] - lo[1])
    s = (size - 2 * pad) / max(spanx, spany, 1e-6)
    W = int(spanx * s) + 2 * pad
    H = int(spany * s) + 2 * pad

    def to_px(q):
        q = np.atleast_2d(q)
        return np.stack([(q[:, 0] - lo[0]) * s + pad,
                         (H - pad) - (q[:, 1] - lo[1]) * s], 1)

    img = Image.new("RGB", (W, H), (14, 15, 19))
    dr = ImageDraw.Draw(img)
    Q = edge_points(P, T, 4)
    px = to_px(Q[:, :2])
    ok = (px[:, 0] >= 0) & (px[:, 0] < W) & (px[:, 1] >= 0) & (px[:, 1] < H)
    for x, y in px[ok].astype(int).tolist():
        img.putpixel((x, y), (225, 222, 214))
    f = font(20)
    f2 = font(16)
    yel = (240, 200, 90)
    cya = (110, 210, 235)
    # 底部 W 标注
    y0 = H - 26
    dr.line([(pad, y0), (W - pad, y0)], fill=yel, width=2)
    dr.text((W / 2 - 60, y0 + 3), "W = %.2f m" % spanx, fill=yel, font=f)
    # 左侧 H 标注
    x0 = 26
    dr.line([(x0, pad), (x0, H - pad)], fill=yel, width=2)
    dr.text((x0 + 4, H / 2 - 40), "H = %.2f m" % spany, fill=yel, font=f)
    dr.text((10, 8), tag, fill=(255, 255, 255), font=f)
    if kit_row:
        dr.text((10, 34), "D = %.2f m   tris=%d" % (
            kit_row["size_m"][2], kit_row.get("tris", 0)), fill=(200, 200, 200), font=f2)
    # 拱标注
    if kit_row:
        ops = kit_row.get("openings") or []
        if ops:
            o = ops[0]
            ys = to_px([[lo[0], o["spring_y"]]])[0][1]
            yc = to_px([[lo[0], o["crown_y"]]])[0][1]
            xa = to_px([[o["spring_x_l"], lo[1]]])[0][0]
            xb = to_px([[o["spring_x_r"], lo[1]]])[0][0]
            dr.line([(xa, ys), (xb, ys)], fill=cya, width=2)
            dr.text((xa + 4, ys - 24), "spring y=%.2f" % o["spring_y"], fill=cya, font=f2)
            dr.line([(xb + 6, yc), (xb + 6, ys)], fill=cya, width=2)
            dr.text((xb + 12, (yc + ys) / 2 - 10), "rise=%.2f" % o["rise"], fill=cya, font=f2)
            dr.line([(xa, yc - 26), (xb, yc - 26)], fill=cya, width=1)
            dr.text(((xa + xb) / 2 - 50, yc - 48),
                    "span=%.2f  r/s=%.2f  %s" % (
                        o["span_at_spring"], o["rise_span_ratio"] or -1,
                        o.get("arch_kind", "")), fill=cya, font=f2)
            dr.line([(xa, yc), (xb, yc)], fill=(255, 120, 120), width=1)
            dr.text(((xa + xb) / 2 - 30, yc - 18), "crown y=%.2f" % o["crown_y"],
                    fill=(255, 150, 150), font=f2)
        vs = kit_row.get("voids") or []
        if vs:
            v = vs[0]
            dr.text((10, H - 52), "void w=%.2f h=%.2f  %s" % (v["w_max"], v["h"], v["shape"]),
                    fill=(170, 255, 170), font=f2)
    out = os.path.join(OUT, "dim_%s.png" % tag)
    img.save(out)
    print("→", out)


def main():
    os.makedirs(OUT, exist_ok=True)
    kit = {}
    kp = os.path.join(OUT, "..", "r28_kit.json")
    if os.path.exists(kp):
        kd = json.load(open(kp, encoding="utf-8"))
        for key in ("gat", "det", "b"):
            for r in kd.get(key, []):
                kit[(r["geo"], r["model"])] = r
    cache = {}
    for fbx, geo, tag in WANT:
        if fbx not in cache:
            cache[fbx] = R.Scene(os.path.join(FBX_DIR, fbx), 0.01)
        sc = cache[fbx]
        gid = next((g for g, v in sc.geos.items() if v["name"] == geo), None)
        if gid is None:
            print("[!] 找不到", geo)
            continue
        g = sc.geos[gid]
        mid = sc.geo_parent.get(gid)
        P = g["verts"].reshape(-1, 3) * 0.01
        Wm = sc.world.get(mid, np.eye(4)) if mid else np.eye(4)
        if mid:
            Wm = Wm @ sc.geometric_matrix(mid)
        P = P @ Wm[:3, :3].T + Wm[:3, 3]
        T = R.triangulate(g["idx"])
        T = T[T.max(1) < P.shape[0]]
        if T.shape[0] > 30000:
            T = T[:: T.shape[0] // 30000 + 1]
        mname = sc.models[mid]["name"] if mid else geo
        row = kit.get((geo, mname))
        render_annotated(P, T, tag, row)


if __name__ == "__main__":
    sys.exit(main())
