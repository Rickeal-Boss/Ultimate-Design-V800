#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
White Castle 参考包 · 环境程序化用的精确测量器（纯标准库 + 可选 numpy/PIL）

为什么不用 Blender：本机未安装 Blender（Program Files / 便携目录均无）。
二进制 FBX 是公开的自描述节点树，struct + zlib 即可读出全部顶点与材质，
测量精度高于人工在视口里拉标尺（逐顶点精确到浮点位，不受透视影响）。

产出：
  1. 每网格 bbox（已按 Model 的 Lcl Scaling 换算到米）/ 三角面数
  2. 材质基色（FBX Material → Properties70 → DiffuseColor）
  3. 选定网格的轴测点云图 + 三视图正交剪影（numpy 光栅化）
  4. 剪影上包络的方波周期分析 → 垛口节奏（垛宽 / 间隙 / 齿距）

用法：
  python env_measure.py <fbx> --json out.json [--only-tris 5000] [--silhouette]

单位：fab 导出的 FBX 元数据写 UnitScaleFactor=1.0，但顶点实为厘米（实测门塔 1025"米"），
故一律 ×0.01。--unit 可覆盖。
"""
import argparse
import json
import struct
import sys
import zlib


# ─────────────────────────── 二进制 FBX 读取 ───────────────────────────

class Reader:
    def __init__(self, data):
        self.d = data
        self.p = 0

    def u1(self):
        v = self.d[self.p]; self.p += 1; return v

    def u4(self):
        v = struct.unpack_from("<I", self.d, self.p)[0]; self.p += 4; return v

    def u8(self):
        v = struct.unpack_from("<Q", self.d, self.p)[0]; self.p += 8; return v

    def i4(self):
        v = struct.unpack_from("<i", self.d, self.p)[0]; self.p += 4; return v

    def i8(self):
        v = struct.unpack_from("<q", self.d, self.p)[0]; self.p += 8; return v

    def f4(self):
        v = struct.unpack_from("<f", self.d, self.p)[0]; self.p += 4; return v

    def f8(self):
        v = struct.unpack_from("<d", self.d, self.p)[0]; self.p += 8; return v

    def raw(self, n):
        v = self.d[self.p:self.p + n]; self.p += n; return v


def read_array(r, fmt_char, item_size):
    length = r.u4()
    encoding = r.u4()
    comp_len = r.u4()
    blob = r.raw(comp_len)
    if encoding == 1:
        blob = zlib.decompress(blob)
    return list(struct.unpack("<%d%s" % (length, fmt_char), blob[:length * item_size]))


def read_property(r):
    code = chr(r.u1())
    if code == "Y": return r.i4()
    if code == "C": return bool(r.u1())
    if code == "I": return r.i4()
    if code == "F": return r.f4()
    if code == "D": return r.f8()
    if code == "L": return r.i8()
    if code == "R":
        n = r.u4(); return r.raw(n)
    if code == "S":
        n = r.u4(); return r.raw(n).decode("utf-8", "replace")
    if code == "f": return read_array(r, "f", 4)
    if code == "d": return read_array(r, "d", 8)
    if code == "l": return read_array(r, "q", 8)
    if code == "i": return read_array(r, "i", 4)
    if code == "b":
        n = r.u4(); enc = r.u4(); c = r.u4()
        blob = r.raw(c)
        if enc == 1: blob = zlib.decompress(blob)
        return list(blob[:n])
    raise ValueError("未知属性类型: %r @ %d" % (code, r.p))


def read_node(r, version):
    u64 = version >= 7500
    if u64:
        end = r.u8(); nprops = r.u8(); plen = r.u8()
    else:
        end = r.u4(); nprops = r.u4(); plen = r.u4()
    if end == 0:
        return None
    name_len = r.u1()
    name = r.raw(name_len).decode("utf-8", "replace")
    props = [read_property(r) for _ in range(nprops)]
    children = []
    while r.p < end:
        child = read_node(r, version)
        if child is None:
            break
        children.append(child)
    r.p = end
    return {"name": name, "props": props, "children": children}


def parse_fbx(path):
    with open(path, "rb") as f:
        data = f.read()
    if not data.startswith(b"Kaydara FBX Binary"):
        raise ValueError("不是 FBX 二进制文件")
    version = struct.unpack_from("<I", data, 23)[0]
    r = Reader(data)
    r.p = 27
    root = {"name": "Root", "props": [], "children": []}
    while r.p < len(data) - 64:
        node = read_node(r, version)
        if node is None:
            break
        root["children"].append(node)
    return version, root, data


def walk(node, path=""):
    yield node, path
    for c in node["children"]:
        yield from walk(c, path + "/" + node["name"])


def split_name(props):
    """FBX 7.x 物体名编码：'Name\\x00\\x01Class'（名在前、类在后）→ (class, name)"""
    for p in props:
        if not isinstance(p, str):
            continue
        if "\x00\x01" in p:
            parts = [s for s in p.split("\x00\x01") if s]
            if len(parts) >= 2:
                return parts[1], parts[0]
            if parts:
                return parts[0], parts[0]
        if "::" in p:
            head, _, tail = p.partition("::")
            return head, tail
    return "", "?"


def mat_color(node):
    """Material → Properties70 → P 'DiffuseColor' 的 RGB"""
    for n, _ in walk(node):
        if n["name"] != "Properties70":
            continue
        for p in n["children"]:
            if p["name"] != "P" or not p["props"]:
                continue
            if p["props"][0] == "DiffuseColor" and len(p["props"]) >= 7:
                return [round(float(v), 5) for v in p["props"][4:7]]
    return None


# ─────────────────────────── 主流程 ───────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fbx")
    ap.add_argument("--json", default="")
    ap.add_argument("--only-tris", type=int, default=0)
    ap.add_argument("--top", type=int, default=30)
    ap.add_argument("--unit", type=float, default=0.01, help="顶点单位 → 米 的系数")
    ap.add_argument("--silhouette", default="", help="输出剪影 PNG 目录（需 numpy+PIL）")
    ap.add_argument("--sil-side", type=int, default=1024)
    args = ap.parse_args()

    version, root, _data = parse_fbx(args.fbx)
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
            scale, trans, rot = [1.0, 1.0, 1.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
            for c in n["children"]:
                if c["name"] == "Lcl Scaling" and c["props"]:
                    scale = list(c["props"][0])[:3]
                elif c["name"] == "Lcl Translation" and c["props"]:
                    trans = list(c["props"][0])[:3]
                elif c["name"] == "Lcl Rotation" and c["props"]:
                    rot = list(c["props"][0])[:3]
            models[mid] = {"name": mname, "scale": scale, "trans": trans, "rot": rot}
        elif nm == "Material":
            mid = n["props"][0]
            _cls, mname = split_name(n["props"])
            mats[mid] = {"id": mid, "name": mname, "diffuse": mat_color(n)}
        elif nm == "Connections":
            for c in n["children"]:
                if c["name"] == "C" and len(c["props"]) >= 3:
                    conns.append((c["props"][0], c["props"][1], c["props"][2]))

    geo2model = {c: p for kind, c, p in conns if c in geos and p in models}
    model2mat = {c: p for kind, c, p in conns if c in models and p in mats}
    if not model2mat:
        mat2model = {c: p for kind, c, p in conns if c in mats and p in models}

    U = args.unit
    rows = []
    for gid, g in geos.items():
        if not g["verts"]:
            continue
        vs = g["verts"]
        xs, ys, zs = vs[0::3], vs[1::3], vs[2::3]
        mid = geo2model.get(gid)
        sc = models[mid]["scale"] if mid else [1, 1, 1]
        tr = models[mid]["trans"] if mid else [0, 0, 0]
        lo = [min(xs) * sc[0] * U + tr[0] * U, min(ys) * sc[1] * U + tr[1] * U, min(zs) * sc[2] * U + tr[2] * U]
        hi = [max(xs) * sc[0] * U + tr[0] * U, max(ys) * sc[1] * U + tr[1] * U, max(zs) * sc[2] * U + tr[2] * U]
        size = [hi[i] - lo[i] for i in range(3)]
        mat = mats.get(model2mat.get(mid)) if model2mat.get(mid) else None
        rows.append({
            "model": models[mid]["name"] if mid else "(unmounted)",
            "geo": g["name"],
            "tris": g["tris"],
            "verts": len(vs) // 3,
            "size_m": [round(v, 3) for v in size],
            "lo_m": [round(v, 3) for v in lo],
            "hi_m": [round(v, 3) for v in hi],
            "material": mat["name"] if mat else None,
            "diffuse": mat["diffuse"] if mat else None,
            "model_rot": models[mid]["rot"] if mid else None,
        })
    rows.sort(key=lambda r: -r["tris"])
    shown = [r for r in rows if r["tris"] >= args.only_tris][: args.top]

    print("FBX v%d  unit×%.3f  geos=%d models=%d materials=%d" % (version, U, len(geos), len(models), len(mats)))
    print("%-30s%-28s%8s%8s%9s%9s%9s  %s" % ("model", "geometry", "tris", "verts", "w", "h", "d", "material"))
    print("─" * 118)
    for r in shown:
        print("%-30s%-28s%8d%8d%9.2f%9.2f%9.2f  %s" % (
            r["model"][:29], r["geo"][:27], r["tris"], r["verts"],
            r["size_m"][0], r["size_m"][1], r["size_m"][2], r["material"] or "-"))

    # 整体包围盒
    if rows:
        lo = [min(r["lo_m"][i] for r in rows) for i in range(3)]
        hi = [max(r["hi_m"][i] for r in rows) for i in range(3)]
        print("─" * 118)
        print("UNION  lo=%s  hi=%s  size=%s m" % (lo, hi, [round(hi[i] - lo[i], 2) for i in range(3)]))

    print("\n材质基色（FBX DiffuseColor 线性值）：")
    for m in mats.values():
        if m["diffuse"]:
            d = m["diffuse"]
            srgb = [round((1.055 * c ** (1 / 2.4) - 0.055) if c > 0.0031308 else c * 12.92, 3) for c in d]
            hexs = "#%02x%02x%02x" % tuple(max(0, min(255, int(round(c * 255)))) for c in srgb)
            print("  %-34s linear=%s  sRGB≈%s" % (m["name"][:33], d, hexs))

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"file": args.fbx, "unit": U, "rows": rows,
                       "materials": list(mats.values())}, f, ensure_ascii=False, indent=1)
        print("\nJSON → %s" % args.json)

    if args.silhouette:
        render_silhouettes(args, rows, geos, geo2model, models)
    return 0


def render_silhouettes(args, rows, geos, geo2model, models):
    """点云正交投影（三视图 + 轴测），保存 PNG 并对上包络做方波周期分析。"""
    try:
        import numpy as np
        from PIL import Image, ImageDraw
    except Exception as e:  # noqa: BLE001
        print("[!] 无 numpy/PIL，跳过剪影：%s" % e)
        return

    import os
    os.makedirs(args.silhouette, exist_ok=True)
    U = args.unit
    for ri, r in enumerate(rows[:4]):
        gid = next((k for k, g in geos.items() if g["name"] == r["geo"]), None)
        if gid is None:
            continue
        vs = np.array(geos[gid]["verts"], dtype=np.float64).reshape(-1, 3) * U
        mid = geo2model.get(gid)
        if mid and models[mid]["scale"]:
            vs = vs * np.array(models[mid]["scale"])
        views = {
            "front_xy": (0, 1), "side_zy": (2, 1), "top_xz": (0, 2)
        }
        for vname, (ax, ay) in views.items():
            a, b = vs[:, ax], vs[:, ay]
            span = max(b.max() - b.min(), a.max() - a.min(), 1e-6)   # 两轴取大者，避免越界
            scale = (args.sil_side - 8) / span
            px = ((a - a.min()) * scale + 4).astype(int)
            py = (args.sil_side - 4 - (b - b.min()) * scale).astype(int)
            img = Image.new("RGB", (args.sil_side, args.sil_side), (12, 12, 14))
            dr = ImageDraw.Draw(img)
            # 点云密度：同像素重复越多越亮（近似法线朝向强度）
            for x, y in zip(px.tolist(), py.tolist()):
                dr.point((x, y), fill=(235, 232, 226))
            out = os.path.join(args.silhouette, "%02d_%s_%s.png" % (ri, r["geo"], vname))
            img.save(out)
            print("  SIL → %s  (%.1f m × %.1f m, %.2f px/m)" % (
                out, a.max() - a.min(), b.max() - b.min(), scale))
            if vname == "front_xy":
                analyse_crenel(px, py, args.sil_side, scale)
        # 轴测（等距）
        ax_, ay_ = 0.7071 * (vs[:, 0] - vs[:, 2]), vs[:, 1] - 0.5 * (vs[:, 0] + vs[:, 2])
        span = max(ay_.max() - ay_.min(), ax_.max() - ax_.min(), 1e-6)
        scale = (args.sil_side - 8) / span
        px = ((ax_ - ax_.min()) * scale + 4).astype(int)
        py = (args.sil_side - 4 - (ay_ - ay_.min()) * scale).astype(int)
        img = Image.new("RGB", (args.sil_side, args.sil_side), (12, 12, 14))
        dr = ImageDraw.Draw(img)
        for x, y in zip(px.tolist(), py.tolist()):
            dr.point((x, y), fill=(235, 232, 226))
        out = os.path.join(args.silhouette, "%02d_%s_iso.png" % (ri, r["geo"]))
        img.save(out)
        print("  SIL → %s" % out)


def analyse_crenel(px, py, side, px_per_m):
    """正视图：每列取最大 y（上包络），统计方波 → 垛口宽/间隙/齿距（米）。"""
    import numpy as np
    NEG = -(10 ** 9)
    top = np.full(side, NEG, dtype=np.int64)
    m = (px >= 0) & (px < side)
    np.maximum.at(top, px[m], -py[m])          # 图像 y 向下，取负后大者更高
    valid = top > NEG // 2
    if valid.sum() < 10:
        return
    cols = np.where(valid)[0]
    env = -top[cols].astype(float)
    # 中值滤波去噪
    k = 7
    pad = np.pad(env, k // 2, mode="edge")
    sm = np.array([np.median(pad[i:i + k]) for i in range(len(env))])
    lo, hi = sm.min(), sm.max()
    if hi - lo < 2:
        print("  [crenel] 上包络无方波（高度落差 < 2px）")
        return
    thr = (lo + hi) / 2
    on = sm > thr
    runs = []
    start = 0
    for i in range(1, len(on)):
        if on[i] != on[i - 1]:
            runs.append((bool(on[i - 1]), i - start))
            start = i
    runs.append((bool(on[-1]), len(on) - start))
    hs = [n for f, n in runs if f]
    gs = [n for f, n in runs if not f]
    if not hs:
        return
    period = np.mean([n for _, n in runs]) / px_per_m
    print("  [crenel] 包络落差 %.2f m | 凸起段 %d 个 均值 %.2f m | 凹槽段 %d 个 均值 %.2f m | 齿距≈%.2f m" % (
        (hi - lo) / px_per_m, len(hs), np.mean(hs) / px_per_m if hs else 0,
        len(gs), np.mean(gs) / px_per_m if gs else 0, period))


if __name__ == "__main__":
    sys.exit(main())
