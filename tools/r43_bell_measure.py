#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R43-P1D 前置 · WCBell_1（钟）与钟楼构件精测
复用 tools/env_measure.py 的二进制 FBX 解析器（struct+zlib，纯标准库）。

产出：.qa/r43_castle/bell_measure.json + 控制台表
  ① bbox / tri / 体积（散度定理）
  ② **半径-高度曲线**：沿竖直轴分层，每层取 max/min 水平半径 ⇒ 收分曲线 + 壳厚
  ③ 三段收分拟合：把 r(y) 按高度三等分做最小二乘斜率 ⇒ 每段收分角
  ④ 唇缘外撇角：最下 8% 高度内的 dr/dy
  ⑤ 宽/高比、唇径/高比（与主理人已知 ≈0.77 对账）
"""
import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env_measure import parse_fbx, walk, split_name  # noqa: E402

U = 0.01  # FBX 顶点实为厘米 → 米


def load(fbx):
    version, root, _data = parse_fbx(fbx)
    geos, models, mats, conns = {}, {}, {}, []
    for n, _ in walk(root):
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
            tris = 0
            if idx:
                run = 0
                for v in idx:
                    if v < 0:
                        if run + 1 >= 3:
                            tris += run - 1
                        run = 0
                    else:
                        run += 1
            geos[gid] = {"name": gname, "verts": verts, "idx": idx, "tris": tris}
        elif nm == "Model":
            mid = n["props"][0]
            _cls, mname = split_name(n["props"])
            scale, trans = [1.0, 1.0, 1.0], [0.0, 0.0, 0.0]
            for c in n["children"]:
                if c["name"] == "Lcl Scaling" and c["props"]:
                    scale = list(c["props"][0])[:3]
                elif c["name"] == "Lcl Translation" and c["props"]:
                    trans = list(c["props"][0])[:3]
            models[mid] = {"name": mname, "scale": scale, "trans": trans}
        elif nm == "Material":
            mid = n["props"][0]
            _cls, mname = split_name(n["props"])
            mats[mid] = {"name": mname}
        elif nm == "Connections":
            for c in n["children"]:
                if c["name"] == "C" and len(c["props"]) >= 3:
                    conns.append((c["props"][0], c["props"][1], c["props"][2]))
    geo2model = {c: p for _k, c, p in conns if c in geos and p in models}
    model2mat = {c: p for _k, c, p in conns if c in models and p in mats}
    out = []
    for gid, g in geos.items():
        mid = geo2model.get(gid)
        m = models.get(mid) if mid else None
        if not g["verts"]:
            continue
        sx, sy, sz = (m["scale"] if m else (1, 1, 1))
        tx, ty, tz = (m["trans"] if m else (0, 0, 0))
        v = g["verts"]
        pts = []
        for i in range(0, len(v) - 2, 3):
            pts.append(((v[i] * sx + tx) * U, (v[i + 1] * sy + ty) * U, (v[i + 2] * sz + tz) * U))
        out.append({
            "geo": g["name"], "model": (m["name"] if m else "?"),
            "mat": mats.get(model2mat.get(mid, ""), {}).get("name", "-"),
            "tris": g["tris"], "pts": pts, "idx": g["idx"]
        })
    return out


def analyze(item, slices=40):
    P = item["pts"]
    xs = [p[0] for p in P]; ys = [p[1] for p in P]; zs = [p[2] for p in P]
    mn = (min(xs), min(ys), min(zs)); mx = (max(xs), max(ys), max(zs))
    dim = (mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2])
    cx = (mn[0] + mx[0]) / 2; cz = (mn[2] + mx[2]) / 2
    # 竖直轴：先用底部 25% 高度层（钟唇区）的 xz bbox 中心定轴（bbox 整体中心会被吊梁带偏）
    y0, y1 = mn[1], mx[1]
    lip = [p for p in P if p[1] < y0 + (y1 - y0) * 0.25]
    if lip:
        cx = (min(p[0] for p in lip) + max(p[0] for p in lip)) / 2
        cz = (min(p[2] for p in lip) + max(p[2] for p in lip)) / 2
    prof = []
    for k in range(slices):
        a = y0 + (y1 - y0) * k / slices
        b = y0 + (y1 - y0) * (k + 1) / slices
        sp = [p for p in P if a <= p[1] < b]
        if not sp:
            continue
        rs = [math.hypot(p[0] - cx, p[2] - cz) for p in sp]
        prof.append({"y": round((a + b) / 2, 3), "t": round((k + 0.5) / slices, 3),
                     "rmax": round(max(rs), 3), "rmin": round(min(rs), 3),
                     "dx": round(max(p[0] for p in sp) - min(p[0] for p in sp), 3),
                     "dz": round(max(p[2] for p in sp) - min(p[2] for p in sp), 3),
                     "n": len(sp)})
    # 体积（散度定理，仅对索引三角）
    vol = 0.0
    idx = item["idx"]
    if idx:
        run = []
        for v in idx:
            if v < 0:
                run.append(~v)
                if len(run) >= 3:
                    for i in range(1, len(run) - 1):
                        a, b, c = P[run[0]], P[run[i]], P[run[i + 1]]
                        vol += (a[0] * (b[1] * c[2] - b[2] * c[1])
                                - a[1] * (b[0] * c[2] - b[2] * c[0])
                                + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0
                run = []
            else:
                run.append(v)
    # 三段收分 + 唇缘角
    seg = []
    if prof:
        n = len(prof)
        for i in range(3):
            s = prof[int(n * i / 3):int(n * (i + 1) / 3)]
            if len(s) >= 2:
                dyy = s[-1]["y"] - s[0]["y"]
                drr = s[-1]["rmax"] - s[0]["rmax"]
                seg.append({"seg": i + 1, "y0": round(s[0]["y"], 3), "y1": round(s[-1]["y"], 3),
                            "r0": round(s[0]["rmax"], 3), "r1": round(s[-1]["rmax"], 3),
                            "dR_per_m": round(drr / dyy, 3) if dyy else None,
                            "angleDeg": round(math.degrees(math.atan2(abs(drr), abs(dyy))), 2) if dyy else None})
        bot = prof[:max(2, int(n * 0.08))]
        if len(bot) >= 2:
            dyy = bot[-1]["y"] - bot[0]["y"]; drr = bot[-1]["rmax"] - bot[0]["rmax"]
            flare = math.degrees(math.atan2(abs(drr), abs(dyy))) if dyy else None
        else:
            flare = None
    else:
        flare = None
    bellBody = None
    if prof:
        dzmax = max(s["dz"] for s in prof)
        body = [s for s in prof if s["dz"] > 0.5 * dzmax]
        if body:
            bellBody = {"y0": body[0]["y"], "y1": body[-1]["y"],
                        "h": round(body[-1]["y"] - body[0]["y"], 3),
                        "diaMax": round(max(s["dz"] for s in body), 3),
                        "diaOverH": round(max(s["dz"] for s in body) / (body[-1]["y"] - body[0]["y"]), 3)}
    return {
        "bellBody": bellBody,
        "geo": item["geo"], "model": item["model"], "mat": item["mat"], "tris": item["tris"],
        "nverts": len(P), "bboxMin": [round(v, 3) for v in mn], "bboxMax": [round(v, 3) for v in mx],
        "dim": [round(v, 3) for v in dim],
        "volume_m3": round(abs(vol), 3),
        "whRatio": round(dim[0] / dim[1], 3) if dim[1] else None,
        "dhRatio": round(dim[2] / dim[1], 3) if dim[1] else None,
        "lipDiaOverH": round(2 * prof[0]["rmax"] / dim[1], 3) if prof and dim[1] else None,
        "radiusProfile": [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in s.items()} for s in prof],
        "segments": seg, "lipFlareDeg": round(flare, 2) if flare is not None else None
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fbx", default="F:/Game/VaultCache/FabLibrary/White_castle-0ffccb05/"
                                    "fbx/whitecastle_fbx_extracted/WhiteCastle_FBX/SM_Det.fbx")
    ap.add_argument("--out", default=".qa/r43_castle")
    ap.add_argument("--match", default="bell,clock,dial,face,beam,yoke,pendulum")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    keys = [k.strip().lower() for k in args.match.split(",") if k.strip()]
    items = load(args.fbx)
    print(f"FBX {args.fbx}\n几何件 {len(items)}")
    hits = [it for it in items if any(k in it["model"].lower() or k in it["geo"].lower() for k in keys)]
    print(f"命中 {len(hits)} 件（匹配 {keys}）")
    res = []
    for it in hits:
        a = analyze(it)
        res.append(a)
        print(f"\n── {a['model']} / {a['geo']}  mat={a['mat']}  tri={a['tris']} verts={a['nverts']}")
        print(f"   bbox {a['dim']}  (W×H×D)  W/H={a['whRatio']}  D/H={a['dhRatio']}  唇径/高={a['lipDiaOverH']}")
        print(f"   体积 {a['volume_m3']} m³   唇缘外撇角 {a['lipFlareDeg']}°")
        for s in a["segments"]:
            print(f"   段{s['seg']}  y {s['y0']}→{s['y1']}  r {s['r0']}→{s['r1']}  收分 {s['dR_per_m']}/m  {s['angleDeg']}°")
    with open(os.path.join(args.out, "bell_measure.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print("\nJSON →", os.path.join(args.out, "bell_measure.json"))


if __name__ == "__main__":
    main()
