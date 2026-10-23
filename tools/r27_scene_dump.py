#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
R27 · 白城堡参考包全节点精确测量器（FBX 二进制直读，无 Blender）

与 R26 的 env_measure.py 的关系：
  * 复用其「二进制节点树解析 / 'Name\\x00\\x01Class' 名称解码 / ×0.01 单位」已验证通路；
  * 补上它缺的三件事：
      1) 完整层级世界变换（Lcl Translation/Rotation/Scaling 沿父链累乘，
         另含 PreRotation / PostRotation / RotationOrder / Geometric* / Pivot）
         —— env_measure 只用了单层 scale+trans，遇到嵌套会错；
      2) 数组属性直接落成 numpy（Scene.fbx 230 万顶点，Python list 会爆内存）；
      3) 连通体分解（union-find）：Scene.fbx 只有 5 个 Mesh 节点，重复模块
         （灯柱 / 栏板 / 饰件）全部被合并进单个 Mesh，必须按连通体拆开才能量到节拍。

产出：
  --json   全节点世界变换 + 世界 AABB + 连通体 + 聚类（重复模块表）
  --md     人读汇总表
  --render 点云着色的正交三视图（形体对照证据，非资产复制）

用法：
  python tools/r27_scene_dump.py --fbx-dir <WhiteCastle_FBX> \
      --json .qa/r27_scene_dump.json --md .qa/r27_measure.md \
      --render .qa/r27_ref --components --max-comp-verts 200000
"""
import argparse
import json
import os
import struct
import sys
import zlib
from datetime import datetime

import numpy as np

# ───────────────────────── 二进制 FBX 读取（numpy 化） ─────────────────────────

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

    def raw(self, n):
        v = self.d[self.p:self.p + n]; self.p += n; return v


def _array_raw(r):
    length = r.u4()
    encoding = r.u4()
    comp_len = r.u4()
    blob = r.raw(comp_len)
    if encoding == 1:
        blob = zlib.decompress(blob)
    return length, blob


_DTYPES = {"f": ("<f4", 4), "d": ("<f8", 8), "i": ("<i4", 4), "l": ("<i8", 8)}


def read_property(r):
    """标量返回 Python 值；数组返回 numpy（省内存）。"""
    code = chr(r.u1())
    if code == "Y": return struct.unpack_from("<h", r.raw(2))[0]   # FBX 'Y' = int16
    if code == "C": return bool(r.u1())
    if code == "I": return struct.unpack_from("<i", r.raw(4))[0]
    if code == "F": return struct.unpack_from("<f", r.raw(4))[0]
    if code == "D": return struct.unpack_from("<d", r.raw(8))[0]
    if code == "L": return struct.unpack_from("<q", r.raw(8))[0]
    if code == "R":
        n = r.u4(); return r.raw(n)
    if code == "S":
        n = r.u4(); return r.raw(n).decode("utf-8", "replace")
    if code in _DTYPES:
        dt, sz = _DTYPES[code]
        length, blob = _array_raw(r)
        return np.frombuffer(blob, dtype=dt, count=length).copy()
    if code == "b":
        length, blob = _array_raw(r)
        return np.frombuffer(blob, dtype=np.uint8, count=length).copy()
    raise ValueError("未知属性类型 %r @ %d" % (code, r.p))


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
        raise ValueError("不是 FBX 二进制文件: %s" % path)
    version = struct.unpack_from("<I", data, 23)[0]
    r = Reader(data)
    r.p = 27
    root = {"name": "Root", "props": [], "children": []}
    while r.p < len(data) - 64:
        node = read_node(r, version)
        if node is None:
            break
        root["children"].append(node)
    return version, root


def walk(node):
    yield node
    for c in node["children"]:
        yield from walk(c)


def split_name(props):
    """'Name\\x00\\x01Class' → (class, name)"""
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


def v3(props_node, default):
    if props_node is None or not props_node["props"]:
        return list(default)
    v = props_node["props"][0]
    if isinstance(v, np.ndarray):
        return [float(x) for x in v[:3]]
    return [float(x) for x in v]


# ───────────────────────── 变换 ─────────────────────────

ORDERS = {0: "XYZ", 1: "XZY", 2: "YXZ", 3: "YZX", 4: "ZXY", 5: "ZYX"}


def rot_mat(axis, deg):
    a = np.deg2rad(deg)
    c, s = np.cos(a), np.sin(a)
    if axis == "x": return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    if axis == "y": return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def euler_mat(order, degs):
    """FBX Euler：order 'XYZ' → R = Rx·Ry·Rz（与 Blender FBX importer 同约定）"""
    M = np.eye(3)
    for ax, d in zip(order, degs):
        M = M @ rot_mat(ax.lower(), d)
    return M


def local_matrix(t, r_deg, s, order="XYZ", pre=None, post=None, piv=None):
    T = np.eye(4)
    T[:3, 3] = t
    R = np.eye(4)
    R[:3, :3] = euler_mat(order, r_deg)
    if pre and np.any(np.abs(pre) > 1e-9):
        R[:3, :3] = euler_mat(order, pre) @ R[:3, :3]
    if post and np.any(np.abs(post) > 1e-9):
        R[:3, :3] = R[:3, :3] @ np.linalg.inv(euler_mat(order, post))
    S = np.eye(4)
    S[0, 0], S[1, 1], S[2, 2] = s
    M = T @ R @ S
    if piv is not None and np.any(np.abs(piv) > 1e-9):
        P = np.eye(4); P[:3, 3] = piv
        Pi = np.eye(4); Pi[:3, 3] = -np.asarray(piv, dtype=float)
        M = P @ M @ Pi
    return M


# ───────────────────────── 场景装配 ─────────────────────────

class Scene:
    def __init__(self, path, unit=0.01):
        self.path = path
        self.unit = unit
        self.version, self.root = parse_fbx(path)
        self.geos = {}
        self.models = {}
        self.mats = {}
        self.conns = []
        self._collect()
        self._link()
        self._world_matrices()

    def _collect(self):
        for n in walk(self.root):
            nm = n["name"]
            if nm == "Geometry":
                gid = int(n["props"][0])
                _cls, gname = split_name(n["props"])
                verts = idx = None
                for c in n["children"]:
                    if c["name"] == "Vertices" and c["props"]:
                        verts = np.asarray(c["props"][0], dtype=np.float64)
                    elif c["name"] == "PolygonVertexIndex" and c["props"]:
                        idx = np.asarray(c["props"][0], dtype=np.int64)
                self.geos[gid] = {"id": gid, "name": gname, "verts": verts, "idx": idx}
            elif nm == "Model":
                mid = int(n["props"][0])
                _cls, mname = split_name(n["props"])
                tr = [0.0, 0.0, 0.0]; ro = [0.0, 0.0, 0.0]; sc = [1.0, 1.0, 1.0]
                pre = post = piv = None
                gtr = [0.0, 0.0, 0.0]; gro = [0.0, 0.0, 0.0]; gsc = [1.0, 1.0, 1.0]
                order = "XYZ"
                for c in n["children"]:
                    cnm = c["name"]
                    if cnm == "Lcl Translation": tr = v3(c, tr)
                    elif cnm == "Lcl Rotation": ro = v3(c, ro)
                    elif cnm == "Lcl Scaling": sc = v3(c, sc)
                    elif cnm == "PreRotation": pre = v3(c, [0, 0, 0])
                    elif cnm == "PostRotation": post = v3(c, [0, 0, 0])
                    elif cnm == "RotationPivot": piv = v3(c, [0, 0, 0])
                    elif cnm == "GeometricTranslation": gtr = v3(c, gtr)
                    elif cnm == "GeometricRotation": gro = v3(c, gro)
                    elif cnm == "GeometricScaling": gsc = v3(c, gsc)
                    elif cnm == "Properties70":
                        for p in c["children"]:
                            if p["name"] == "P" and p["props"] and p["props"][0] == "RotationOrder":
                                try:
                                    order = ORDERS.get(int(p["props"][4]), "XYZ")
                                except Exception:
                                    order = "XYZ"
                self.models[mid] = {"id": mid, "name": mname, "t": tr, "r": ro, "s": sc,
                                    "order": order, "pre": pre, "post": post, "piv": piv,
                                    "gt": gtr, "gr": gro, "gs": gsc}
            elif nm == "Material":
                mid = int(n["props"][0])
                _cls, mname = split_name(n["props"])
                diffuse = None
                for sub in walk(n):
                    if sub["name"] == "Properties70":
                        for p in sub["children"]:
                            if p["name"] == "P" and p["props"] and p["props"][0] == "DiffuseColor" \
                                    and len(p["props"]) >= 7:
                                diffuse = [round(float(v), 5) for v in p["props"][4:7]]
                self.mats[mid] = {"id": mid, "name": mname, "diffuse": diffuse}
            elif nm == "Connections":
                for c in n["children"]:
                    if c["name"] == "C" and len(c["props"]) >= 3:
                        self.conns.append((c["props"][0], int(c["props"][1]), int(c["props"][2])))

    def _link(self):
        self.geo_parent = {}    # geo_id -> model_id
        self.parent = {}        # model_id -> model_id | 0(root)
        self.model_mat = {}     # model_id -> material_id
        for kind, child, parent in self.conns:
            if child in self.geos and parent in self.models:
                self.geo_parent[child] = parent
            elif child in self.models and parent in self.models:
                self.parent[child] = parent
            elif child in self.models and parent == 0:
                self.parent[child] = 0
            elif child in self.mats and parent in self.models:
                self.model_mat[parent] = child
            elif child in self.models and parent in self.mats:
                self.model_mat[child] = parent

    def _world_matrices(self):
        self.world = {}
        cache = {}

        def get(mid):
            if mid in cache:
                return cache[mid]
            m = self.models[mid]
            L = local_matrix(m["t"], m["r"], m["s"], m["order"], m["pre"], m["post"], m["piv"])
            p = self.parent.get(mid, 0)
            if p and p in self.models:
                W = cache[p] @ L if p in cache else get(p) @ L
            else:
                W = L
            cache[mid] = W
            return W

        for mid in list(self.models):
            try:
                self.world[mid] = get(mid)
            except RecursionError:
                self.world[mid] = np.eye(4)

    def geometric_matrix(self, mid):
        m = self.models[mid]
        G = np.eye(4)
        G[:3, :3] = euler_mat(m["order"], m["gr"])
        Gs = np.eye(4); Gs[0, 0], Gs[1, 1], Gs[2, 2] = m["gs"]
        Gt = np.eye(4); Gt[:3, 3] = m["gt"]
        return Gt @ G @ Gs

    def nodes(self):
        """逐 Mesh 节点产出世界 AABB（真顶点变换，非 8 角近似）。"""
        out = []
        U = self.unit
        for gid, g in self.geos.items():
            if g["verts"] is None:
                continue
            v = g["verts"].reshape(-1, 3)
            mid = self.geo_parent.get(gid)
            W = self.world.get(mid, np.eye(4)) if mid else np.eye(4)
            if mid:
                W = W @ self.geometric_matrix(mid)
            P = (v @ W[:3, :3].T + W[:3, 3]) * U
            lo = P.min(0); hi = P.max(0)
            tris = 0
            if g["idx"] is not None and g["idx"].size:
                idx = g["idx"]
                poly = (idx < 0).astype(np.int64)
                # 每多边形三角数 = n-2；先算多边形数
                npoly = int(poly.sum())
                n_idx = int(idx.size)
                tris = n_idx - 2 * npoly
            matname = None
            if mid:
                matid = self.model_mat.get(mid)
                if matid in self.mats:
                    matname = self.mats[matid]["name"]
            mdl = self.models.get(mid, {})
            out.append({
                "file": os.path.basename(self.path),
                "geo": g["name"], "geo_id": gid,
                "model": mdl.get("name", "(unmounted)"), "model_id": mid,
                "material": matname,
                "verts": int(v.shape[0]), "tris": int(tris),
                "lcl_t": [round(x, 3) for x in mdl.get("t", [0, 0, 0])],
                "lcl_r_deg": [round(x, 3) for x in mdl.get("r", [0, 0, 0])],
                "lcl_s": [round(x, 4) for x in mdl.get("s", [1, 1, 1])],
                "world_pos": [round(float(x), 3) for x in W[:3, 3] * U],
                "world_lo": [round(float(x), 3) for x in lo],
                "world_hi": [round(float(x), 3) for x in hi],
                "world_size": [round(float(x), 3) for x in (hi - lo)],
                "world_center": [round(float(x), 3) for x in (lo + hi) / 2],
            })
        out.sort(key=lambda r: -r["verts"])
        return out


# ───────────────────────── 连通体分解 ─────────────────────────

def triangulate(idx):
    """PolygonVertexIndex(-1 结尾) → (tris[M,3], npoly)"""
    out = []
    poly = []
    for k in idx.tolist():
        if k < 0:
            poly.append(~k)
            for j in range(1, len(poly) - 1):
                out.append((poly[0], poly[j], poly[j + 1]))
            poly = []
        else:
            poly.append(k)
    if not out:
        return np.zeros((0, 3), dtype=np.int64)
    return np.array(out, dtype=np.int64)


def connected_components(tris, n):
    """union-find（路径压缩 + 按秩），返回 label[n]"""
    parent = list(range(n))
    rank = [0] * n

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra == rb:
            return
        if rank[ra] < rank[rb]:
            ra, rb = rb, ra
        parent[rb] = ra
        if rank[ra] == rank[rb]:
            rank[ra] += 1

    for a, b, c in tris.tolist():
        union(a, b)
        union(a, c)
    lab = np.empty(n, dtype=np.int64)
    roots = {}
    for i in range(n):
        r = find(i)
        lab[i] = roots.setdefault(r, len(roots))
    return lab, len(roots)


# ───────────────────────── 聚类（重复模块识别） ─────────────────────────

def cluster_parts(parts, tol=0.35):
    """按 bbox 尺寸签名聚类（容差 tol 米），输出模块表。"""
    buckets = {}
    for p in parts:
        sig = tuple(round(s / tol) for s in p["size"])
        buckets.setdefault(sig, []).append(p)
    clusters = []
    for sig, items in buckets.items():
        if len(items) < 2:
            continue
        S = np.array([it["size"] for it in items])
        C = np.array([it["center"] for it in items])
        # 主延展轴：中心坐标标准差最大的轴
        spread = C.std(0)
        axis = int(np.argmax(spread))
        v = np.sort(C[:, axis])
        steps = np.diff(v)
        steps = steps[steps > 1e-6]
        clusters.append({
            "sig": list(sig),
            "count": len(items),
            "size_median": [round(float(x), 3) for x in np.median(S, 0)],
            "size_min": [round(float(x), 3) for x in S.min(0)],
            "size_max": [round(float(x), 3) for x in S.max(0)],
            "size_std": [round(float(x), 3) for x in S.std(0)],
            "axis": "xyz"[axis],
            "span_m": round(float(v[-1] - v[0]), 3),
            "spacing_median": round(float(np.median(steps)), 3) if steps.size else None,
            "spacing_p10": round(float(np.percentile(steps, 10)), 3) if steps.size else None,
            "spacing_p90": round(float(np.percentile(steps, 90)), 3) if steps.size else None,
            "center_mean": [round(float(x), 2) for x in C.mean(0)],
            "bbox_lo": [round(float(x), 2) for x in C.min(0)],
            "bbox_hi": [round(float(x), 2) for x in C.max(0)],
            "sample_models": [it.get("model") or it.get("geo") for it in items[:4]],
        })
    clusters.sort(key=lambda c: -c["count"])
    return clusters


# ───────────────────────── 点云正交渲染 ─────────────────────────

def splat(P, N, size, bg=(0.055, 0.062, 0.078), light=(0.45, 0.8, 0.4), pad=1.04):
    """正交投影 + z-buffer 点云着色（Lambert，双面）"""
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    span = max(x.max() - x.min(), y.max() - y.min()) * pad
    cx, cy = (x.min() + x.max()) / 2, (y.min() + y.max()) / 2
    sx = ((x - cx) / span * size + size / 2).astype(np.int64)
    sy = (size / 2 - (y - cy) / span * size).astype(np.int64)
    m = (sx >= 0) & (sx < size) & (sy >= 0) & (sy < size)
    sx, sy, zm = sx[m], sy[m], z[m]
    if N is not None:
        L = np.array(light, dtype=np.float64); L /= np.linalg.norm(L)
        lam = np.abs(N[m] @ L) * 0.7 + 0.3
        col = np.clip(lam, 0, 1.3)[:, None] * np.array([0.90, 0.88, 0.84])
    else:
        col = np.tile(np.array([0.88, 0.86, 0.82]), (zm.size, 1))
    img = np.zeros((size, size, 3))
    img[:] = bg
    # z-buffer 等价：按深度降序（远→近）逐个覆盖，近点最后写入
    order = np.argsort(-zm)
    img[sy[order], sx[order]] = col[order]
    img = np.clip(img, 0, 1)
    try:
        from PIL import Image
        return Image.fromarray((img ** (1 / 2.2) * 255).astype(np.uint8)), (span / size)
    except Exception:
        return None, (span / size)


def vertex_normals(P, tris):
    A, B, C = P[tris[:, 0]], P[tris[:, 1]], P[tris[:, 2]]
    Nt = np.cross(B - A, C - A)
    N = np.zeros_like(P)
    np.add.at(N, tris[:, 0], Nt); np.add.at(N, tris[:, 1], Nt); np.add.at(N, tris[:, 2], Nt)
    l = np.linalg.norm(N, axis=1); l[l == 0] = 1
    return N / l[:, None]


def render_views(P, N, outdir, tag, size=1400, step=1):
    os.makedirs(outdir, exist_ok=True)
    Q = P[::step]
    Qn = N[::step] if N is not None else None
    views = {
        "front_z": lambda p: (p[:, 0], p[:, 1], p[:, 2]),
        "side_x": lambda p: (-p[:, 2], p[:, 1], p[:, 0]),
        "top_y": lambda p: (p[:, 0], -p[:, 2], p[:, 1]),
        "iso": lambda p: (0.7071 * (p[:, 0] - p[:, 2]),
                          p[:, 1] - 0.5 * (p[:, 0] + p[:, 2]) * 0.7071,
                          0.7071 * (p[:, 0] + p[:, 2])),
    }
    outs = {}
    for name, f in views.items():
        a, b, z = f(Q)
        Pp = np.stack([a, b, z], 1)
        img, mpp = splat(Pp, Qn, size)
        if img is None:
            continue
        p = os.path.join(outdir, "%s_%s.png" % (tag, name))
        img.save(p)
        outs[name] = {"png": p, "m_per_px": round(float(mpp), 4)}
        print("  RENDER → %s  (%.3f m/px)" % (p, mpp))
    return outs


# ───────────────────────── 主流程 ─────────────────────────

def process(fbx, args, report):
    print("\n" + "=" * 100)
    print("FBX → %s" % fbx)
    sc = Scene(fbx, args.unit)
    nodes = sc.nodes()
    print("  v%d  models=%d geometries=%d materials=%d" % (
        sc.version, len(sc.models), len(sc.geos), len(sc.mats)))
    print("  %-22s %10s %10s   %-26s %-24s %s" % ("node", "verts", "tris", "world_size(w,h,d) m", "world_center", "material"))
    print("  " + "-" * 96)
    for n in nodes[:40]:
        print("  %-22s %10d %10d   %-26s %-24s %s" % (
            n["geo"][:21], n["verts"], n["tris"],
            str(n["world_size"]), str(n["world_center"]), n["material"] or "-"))
    if nodes:
        lo = np.min([n["world_lo"] for n in nodes], 0)
        hi = np.max([n["world_hi"] for n in nodes], 0)
        print("  UNION lo=%s hi=%s size=%s m" % (
            [round(float(v), 2) for v in lo], [round(float(v), 2) for v in hi],
            [round(float(v), 2) for v in (hi - lo)]))
    entry = {"file": os.path.basename(fbx), "version": sc.version,
             "counts": {"models": len(sc.models), "geometries": len(sc.geos),
                        "materials": len(sc.mats)},
             "nodes": nodes,
             "materials": [{"name": m["name"], "diffuse": m["diffuse"]} for m in sc.mats.values()]}

    # 连通体分解
    comps_all = {}
    if args.components:
        U = args.unit
        for gid, g in sc.geos.items():
            if g["verts"] is None or g["idx"] is None:
                continue
            nv = g["verts"].size // 3
            if nv > args.max_comp_verts:
                print("  [comp] 跳过 %s（%d 顶点 > 上限 %d）" % (g["name"], nv, args.max_comp_verts))
                continue
            tris = triangulate(g["idx"])
            if tris.size == 0:
                continue
            tris = tris[tris.max(1) < nv]
            t0 = os.times()
            lab, nc = connected_components(tris, nv)
            v = g["verts"].reshape(-1, 3)
            mid = sc.geo_parent.get(gid)
            W = sc.world.get(mid, np.eye(4)) if mid else np.eye(4)
            if mid:
                W = W @ sc.geometric_matrix(mid)
            P = (v @ W[:3, :3].T + W[:3, 3]) * U
            parts = []
            counts = np.bincount(lab, minlength=nc)
            for c in range(nc):
                if counts[c] < args.min_comp_verts:
                    continue
                sel = np.nonzero(lab == c)[0]
                if sel.size > 60000:
                    sel = sel[:: max(1, sel.size // 60000)]
                Q = P[sel]
                lo_, hi_ = Q.min(0), Q.max(0)
                parts.append({"comp": int(c), "verts": int(counts[c]),
                              "lo": [round(float(x), 3) for x in lo_],
                              "hi": [round(float(x), 3) for x in hi_],
                              "size": [round(float(x), 3) for x in (hi_ - lo_)],
                              "center": [round(float(x), 3) for x in (lo_ + hi_) / 2]})
            print("  [comp] %-16s 连通体 %d（≥%d 顶点的 %d 个）" % (
                g["name"], nc, args.min_comp_verts, len(parts)))
            comps_all[g["name"]] = {
                "mesh_verts": int(nv), "n_components": int(nc),
                "parts": sorted(parts, key=lambda p: -p["verts"]),
                "clusters": cluster_parts(parts, args.cluster_tol),
            }
            for cl in comps_all[g["name"]]["clusters"][:12]:
                print("     ×%-4d size=%s  axis=%s spacing_med=%.2f m  span=%.1f m" % (
                    cl["count"], cl["size_median"], cl["axis"],
                    cl["spacing_median"] if cl["spacing_median"] else -1, cl["span_m"]))
    entry["components"] = comps_all

    # 渲染
    if args.render:
        U = args.unit
        for gid, g in sc.geos.items():
            if g["verts"] is None or g["idx"] is None:
                continue
            nv = g["verts"].size // 3
            if nv < 200:
                continue
            if nv > args.max_render_verts:
                continue
            tris = triangulate(g["idx"])
            tris = tris[tris.max(1) < nv]
            v = g["verts"].reshape(-1, 3)
            mid = sc.geo_parent.get(gid)
            W = sc.world.get(mid, np.eye(4)) if mid else np.eye(4)
            if mid:
                W = W @ sc.geometric_matrix(mid)
            P = (v @ W[:3, :3].T + W[:3, 3]) * U
            N = vertex_normals(P, tris)
            tag = "%s_%s" % (os.path.splitext(os.path.basename(fbx))[0], g["name"])
            entry.setdefault("renders", {})[g["name"]] = render_views(
                P, N, args.render, tag, args.render_size)
    report.append(entry)
    return entry


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    proj = os.path.dirname(here)
    ap = argparse.ArgumentParser()
    ap.add_argument("--fbx-dir", default=r"F:/Game/VaultCache/FabLibrary/White_castle-0ffccb05/"
                    "fbx/whitecastle_fbx_extracted/WhiteCastle_FBX")
    ap.add_argument("--files", default="Scene.fbx,SM_B.fbx,SM_Gat.fbx,SM_Det.fbx")
    ap.add_argument("--unit", type=float, default=0.01)
    ap.add_argument("--json", default=os.path.join(proj, ".qa", "r27_scene_dump.json"))
    ap.add_argument("--md", default="")
    ap.add_argument("--render", default="")
    ap.add_argument("--render-size", type=int, default=1400)
    ap.add_argument("--max-render-verts", type=int, default=1200000)
    ap.add_argument("--components", action="store_true")
    ap.add_argument("--max-comp-verts", type=int, default=200000)
    ap.add_argument("--min-comp-verts", type=int, default=24)
    ap.add_argument("--cluster-tol", type=float, default=0.35)
    args = ap.parse_args()

    report = []
    for fn in [s for s in args.files.split(",") if s]:
        p = os.path.join(args.fbx_dir, fn)
        if not os.path.exists(p):
            print("[!] 缺失 %s" % p)
            continue
        process(p, args, report)

    payload = {"generated": datetime.now().isoformat(timespec="seconds"),
               "unit_cm_to_m": args.unit, "fbx_dir": args.fbx_dir, "files": report}
    os.makedirs(os.path.dirname(args.json), exist_ok=True)
    with open(args.json, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print("\nJSON → %s" % args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
