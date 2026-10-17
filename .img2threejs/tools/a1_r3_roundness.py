# -*- coding: utf-8 -*-
"""R3 细粒度波：圆润化与密化（原位精化，不新增组件）。

机制前提（实测确认，非猜测）：
1. geometryDescriptor.edgeTreatment 只是散文字段 —— validate_sculpt_spec.py 校验它的
   类型，但 generate_threejs_factory.py 从头到尾不读它。写 bevelRadius 不会改变一个顶点。
   真正能改几何的只有：primitive 本身、primitive 对应的 descriptor（profile2D /
   latheProfile / tubePath / curveSweep）、以及 geometryDescriptor.subdivide.iterations。
2. box 没有倒角参数：geometry_for() 只发 BoxGeometry(1,1,1,BOX_SEGMENTS) —— 加 segment
   只是把平面切碎，不会圆角。box 想圆角只有两条路：subdivide(Catmull-Clark) 或换 primitive。
3. Catmull-Clark 在 box 上不可用：实测单位立方体 CC-1 后 8 个角从 0.5 收到 0.278（收掉
   44% 半边长），面心仍是 0.5 —— 那是"枕头化"不是"倒角"；CC-2 更是连 bbox 都缩到 0.439
   （−12%）。所以 box 走 primitive 换成 extrude + 圆角 profile2D。
4. ExtrudeGeometry 是单侧挤出（local z ∈ [0, depth]），要保住原来的中心必须把
   transform.position 沿自身 local z 回退 depth*scale.z/2。若该组件是父节点，子节点会被
   带着走，必须反向补偿（node scale 恒为 1，scale 被烘进 geometry，所以补偿量是干净的
   T_child' = T_child - R_parent^{-1} * Δ）。
5. cylinder -> lathe 是零位移替换：CylinderGeometry(0.5,0.5,1) 与 lathe(y∈[-0.5,0.5],
   r=0.5) 同轴同尺寸同居中，latheProfile 自带 segments 字段，可以既加密又给端面倒圆角
   （cylinder 的 48 条硬折边全部来自 cap 与侧壁的 90° 交界）。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEC = os.path.join(ROOT, ".img2threejs", "object-sculpt-spec.json")
BACKUP = os.path.join(os.path.dirname(ROOT), "a1_spec_backup_r3.json")

ARC_STEPS = 4  # 每个圆角 4 段 -> 22.5°/段（< 30° 判据阈值）


# --- three.js Euler 'XYZ' 的 local z 轴在世界（父）空间的方向 -------------------
def rot_local_z(rot):
    x = float(rot[0]) if len(rot) > 0 else 0.0
    y = float(rot[1]) if len(rot) > 1 else 0.0
    z = float(rot[2]) if len(rot) > 2 else 0.0
    a, b = math.cos(x), math.sin(x)
    c, d = math.cos(y), math.sin(y)
    return (d, -b * c, a * c)


def rot_apply(rot, v):
    """把 local 空间向量 v 转到父空间（three.js Euler 'XYZ'）。"""
    x = float(rot[0]) if len(rot) > 0 else 0.0
    y = float(rot[1]) if len(rot) > 1 else 0.0
    z = float(rot[2]) if len(rot) > 2 else 0.0
    a, b = math.cos(x), math.sin(x)
    c, d = math.cos(y), math.sin(y)
    e, f = math.cos(z), math.sin(z)
    af, ae, bf, be = a * f, a * e, b * f, b * e
    col0 = (c * e, af + be * d, bf - ae * d)
    col1 = (-c * f, ae - bf * d, be + af * d)
    col2 = (d, -b * c, a * c)
    return tuple(col0[i] * v[0] + col1[i] * v[1] + col2[i] * v[2] for i in range(3))


def rot_inv_apply(rot, v):
    """把父空间向量 v 转回组件 local 空间：R^T * v（正交矩阵的逆 = 转置）。

    three.js Matrix4 XYZ 按列主序存：col0=(te0,te1,te2), col1=(te4,te5,te6),
    col2=(te8,te9,te10)。R^T*v 的第 i 个分量 = col_i 与 v 的点积。
    """
    x = float(rot[0]) if len(rot) > 0 else 0.0
    y = float(rot[1]) if len(rot) > 1 else 0.0
    z = float(rot[2]) if len(rot) > 2 else 0.0
    a, b = math.cos(x), math.sin(x)
    c, d = math.cos(y), math.sin(y)
    e, f = math.cos(z), math.sin(z)
    af, ae, bf, be = a * f, a * e, b * f, b * e
    col0 = (c * e, af + be * d, bf - ae * d)
    col1 = (-c * f, ae - bf * d, be + af * d)
    col2 = (d, -b * c, a * c)
    cols = (col0, col1, col2)
    return tuple(sum(cols[i][j] * v[j] for j in range(3)) for i in range(3))


def rounded_rect_profile(rx, ry, steps=ARC_STEPS):
    """归一化圆角矩形（x,y ∈ [-0.5,0.5]），CCW。rx/ry 是归一化圆角半径。"""
    rx = max(1e-4, min(0.35, rx))
    ry = max(1e-4, min(0.35, ry))
    pts = []
    corners = [
        (0.5 - rx, -0.5 + ry, -90.0),  # BR
        (0.5 - rx, 0.5 - ry, 0.0),  # TR
        (-0.5 + rx, 0.5 - ry, 90.0),  # TL
        (-0.5 + rx, -0.5 + ry, 180.0),  # BL
    ]
    for cx, cy, a0 in corners:
        for i in range(steps + 1):
            ang = math.radians(a0 + 90.0 * i / steps)
            pts.append([round(cx + rx * math.cos(ang), 6), round(cy + ry * math.sin(ang), 6)])
    return pts


def lathe_profile(rx, ry, steps=ARC_STEPS):
    """带端面倒圆角的圆柱 lathe 剖面：r=0.5、高 1、轴 Y、居中。

    rx/ry 分开给，是因为几何的 scale 是烘进 geometry 的、且通常非均匀（轮胎轴向 0.256、
    径向 0.764）。倒圆角若用同一个归一化半径，缩放后会被压成椭圆，实测弧段转角从
    22.5° 被拉到 32.7°（越过硬折边判据）。按 rx=rw/S_radial、ry=rw/S_axial 分别给，
    世界空间里才是真正的圆弧，每段仍 22.5°。
    """
    p = [[0.0002, -0.5], [0.5 - rx, -0.5]]
    cx, cy = 0.5 - rx, -0.5 + ry
    for i in range(1, steps + 1):
        ang = math.radians(-90.0 + 90.0 * i / steps)
        p.append([round(cx + rx * math.cos(ang), 6), round(cy + ry * math.sin(ang), 6)])
    p.append([0.5, 0.5 - ry])
    cx, cy = 0.5 - rx, 0.5 - ry
    for i in range(1, steps + 1):
        ang = math.radians(90.0 * i / steps)
        p.append([round(cx + rx * math.cos(ang), 6), round(cy + ry * math.sin(ang), 6)])
    p.append([0.0002, 0.5])
    return p


def round_polygon_corners(pts, min_turn_deg):
    """把闭合多边形的每个折角（转角 > min_turn_deg）替换成圆弧，弧段 <=22.5°。

    返回 (新点表, 是否改动)。圆角半径取相邻两边较短边的 40%，保证不会吃掉整条边。
    """
    n = len(pts)
    out = []
    changed = False
    for i in range(n):
        p0 = pts[(i - 1) % n]
        p1 = pts[i]
        p2 = pts[(i + 1) % n]
        v1 = (p1[0] - p0[0], p1[1] - p0[1])
        v2 = (p2[0] - p1[0], p2[1] - p1[1])
        l1 = math.hypot(*v1)
        l2 = math.hypot(*v2)
        if l1 < 1e-9 or l2 < 1e-9:
            out.append([round(p1[0], 6), round(p1[1], 6)])
            continue
        u1 = (v1[0] / l1, v1[1] / l1)
        u2 = (v2[0] / l2, v2[1] / l2)
        cross = u1[0] * u2[1] - u1[1] * u2[0]
        dot = max(-1.0, min(1.0, u1[0] * u2[0] + u1[1] * u2[1]))
        turn = math.degrees(math.acos(dot))
        if turn <= min_turn_deg:
            out.append([round(p1[0], 6), round(p1[1], 6)])
            continue
        changed = True
        # 圆角几何：切线长 t = r*tan(turn/2)，顶点到圆心 d = r/cos(turn/2)。
        # （d 写成 t/sin(turn/2) 是错的 —— 会让切点与圆心不自洽，弧段转角不再均匀，
        #   实测残留 32° 的硬折角。）
        half = math.radians(turn / 2.0)
        r = 0.4 * min(l1, l2)
        t = r * math.tan(half)
        t = min(t, 0.45 * l1, 0.45 * l2)
        r = t / math.tan(half)
        a = (p1[0] - u1[0] * t, p1[1] - u1[1] * t)  # 入边上的切点
        b = (p1[0] + u2[0] * t, p1[1] + u2[1] * t)  # 出边上的切点
        bis = (-(u1[0] - u2[0]), -(u1[1] - u2[1]))
        bl = math.hypot(*bis)
        if bl < 1e-9:
            out.append([round(p1[0], 6), round(p1[1], 6)])
            continue
        bis = (bis[0] / bl, bis[1] / bl)
        cen = (p1[0] + bis[0] * r / math.cos(half), p1[1] + bis[1] * r / math.cos(half))
        rr = r
        a0 = math.atan2(a[1] - cen[1], a[0] - cen[0])
        a1 = math.atan2(b[1] - cen[1], b[0] - cen[0])
        # 沿短弧走：叉积符号决定方向
        sweep = a1 - a0
        while sweep > math.pi:
            sweep -= 2 * math.pi
        while sweep < -math.pi:
            sweep += 2 * math.pi
        if (cross > 0) != (sweep > 0):
            sweep = sweep - 2 * math.pi if sweep > 0 else sweep + 2 * math.pi
        steps = max(2, int(math.ceil(abs(math.degrees(sweep)) / 22.5)))
        out.append([round(a[0], 6), round(a[1], 6)])
        for k in range(1, steps):
            ang = a0 + sweep * k / steps
            out.append([round(cen[0] + rr * math.cos(ang), 6), round(cen[1] + rr * math.sin(ang), 6)])
        # b 点由下一个顶点的处理（或 a 点）覆盖，这里不重复添加
    return out, changed


def flatten(tree):
    out = []

    def walk(nodes):
        for n in nodes:
            if isinstance(n, dict):
                out.append(n)
                for k in ("children", "components", "parts"):
                    v = n.get(k)
                    if isinstance(v, list):
                        walk(v)

    walk(tree)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--only", default="")
    args = ap.parse_args()

    with open(SPEC, encoding="utf-8") as fh:
        spec = json.load(fh)  # 先 json.load 校验可解析
    comps = flatten(spec["componentTree"])
    by_id = {c["id"]: c for c in comps}
    children = {}
    for c in comps:
        p = c.get("parent")
        if p:
            children.setdefault(p, []).append(c["id"])

    log = []

    def shift_node(comp, delta_parent_frame):
        """移动组件节点，并反向补偿它的直接子节点。delta 在父空间。

        坑：子节点的实际落位不一定来自 transform.position。primitive 属于
        ATTACHMENT_PRIMITIVES 且 attachment 非零长时，工厂用
        `node.position.copy(endpoint.start)`（= attachment.localStart）覆盖
        transform.position —— 只改 transform.position 对这类子节点无效
        （本 spec 里命中 tweeter-l / tweeter-r 两个 capsule）。
        """
        tr = comp.setdefault("transform", {})
        rot = tr.get("rotation") or [0, 0, 0]
        pos = list(tr.get("position") or [0, 0, 0])
        tr["position"] = [round(pos[i] + delta_parent_frame[i], 6) for i in range(3)]
        local_delta = rot_inv_apply(rot, delta_parent_frame)
        for cid in children.get(comp["id"], []):
            child = by_id[cid]
            ctr = child.setdefault("transform", {})
            cpos = list(ctr.get("position") or [0, 0, 0])
            ctr["position"] = [round(cpos[i] - local_delta[i], 6) for i in range(3)]
            att = child.get("attachment")
            if isinstance(att, dict):
                ls = att.get("localStart")
                le = att.get("localEnd")
                if isinstance(ls, list) and isinstance(le, list):
                    att["localStart"] = [round(ls[i] - local_delta[i], 6) for i in range(3)]
                    att["localEnd"] = [round(le[i] - local_delta[i], 6) for i in range(3)]

    # --- 1) cylinder -> lathe（端面倒圆 + 可选加密）-------------------------------
    HI_SEG = {"tire-fl", "tire-fr", "tire-rl", "tire-rr", "rim-fl", "rim-fr", "rim-rl", "rim-rr"}
    HI_SEG_N, LO_SEG_N = 48, 36
    n_cyl = 0
    for c in comps:
        if c.get("primitive") != "cylinder":
            continue
        seg = HI_SEG_N if c["id"] in HI_SEG else LO_SEG_N
        sc = (c.get("transform") or {}).get("scale") or [1, 1, 1]
        s_radial = math.sqrt(abs(float(sc[0])) * abs(float(sc[2])))  # lathe 半径用 local X/Z
        s_axial = abs(float(sc[1]))  # lathe 轴是 local Y
        s_radial = max(s_radial, 1e-6)
        s_axial = max(s_axial, 1e-6)
        rw = min(0.18 * min(s_radial, s_axial), 0.03)
        rw = max(rw, 0.001)
        rx = min(0.35, rw / s_radial)
        ry = min(0.35, rw / s_axial)
        gd = c.setdefault("geometryDescriptor", {})
        gd["latheProfile"] = {"points": lathe_profile(rx, ry), "segments": seg}
        gd["topologyIntent"] = (
            "lathe cylinder with filleted end rims; sidewall-to-face transition radiused "
            "so no hard 90deg shoulder remains"
        )
        if isinstance(gd.get("edgeTreatment"), dict):
            gd["edgeTreatment"] = {"type": "rounded", "bevelRadius": round(rw, 5), "segments": ARC_STEPS}
        c["primitive"] = "lathe"
        n_cyl += 1
        log.append(f"cylinder->lathe seg={seg}: {c['id']}")
    log.append(f"[1] cylinders converted: {n_cyl}")

    # --- 2) tube 提高 radialSegments ---------------------------------------------
    TUBE_RADIAL = {"roof-rails": 28, "ambient-strip-l": 28, "ambient-strip-r": 28}
    n_tube = 0
    for cid, rad in TUBE_RADIAL.items():
        c = by_id.get(cid)
        if not c or c.get("primitive") != "tube":
            continue
        tp = c["geometryDescriptor"].setdefault("tubePath", {})
        tp["radialSegments"] = rad
        n_tube += 1
        log.append(f"tube radialSegments={rad}: {cid}")
    log.append(f"[2] tubes densified: {n_tube}")

    # --- 3) box -> 圆角 extrude（叶子节点，父节点带子节点补偿）--------------------
    SKIP_BOX = {"root"}  # root 是整车包围盒，圆角无收益且子节点 53 个，不动
    n_box = 0
    for c in comps:
        if c.get("primitive") != "box" or c["id"] in SKIP_BOX:
            continue
        tr = c.get("transform") or {}
        sc = tr.get("scale") or [1, 1, 1]
        sx, sy, sz = abs(float(sc[0])), abs(float(sc[1])), abs(float(sc[2]))
        if sx < 1e-6 or sy < 1e-6:
            continue
        rw = min(0.2 * min(sx, sy), 0.035)
        rw = max(rw, 0.0015)
        # 弧段数固定在 4（22.5°/段）：实测再加密是负收益 —— 圆角本身在 4 段时已经
        # 不再产生 >30° 的硬折边，而每多一个 profile 点就多出 2 条"端面-侧壁"90°
        # 棱（挤出的帽沿），帽沿才是挤出体硬折边的主要来源。7 段实测把硬折边从
        # 6678 抬回 7638、面数 +1920，两头都变差。
        steps = ARC_STEPS
        profile = rounded_rect_profile(rw / sx, rw / sy, steps)
        gd = c.setdefault("geometryDescriptor", {})
        gd["profile2D"] = {"points": profile, "depth": 1.0}
        gd["topologyIntent"] = (
            "rounded-rectangle extrusion: perimeter corners radiused with "
            f"{steps}-facet arcs ({round(90 / steps, 1)}deg per facet) instead of hard 90deg box edges"
        )
        if isinstance(gd.get("edgeTreatment"), dict):
            gd["edgeTreatment"] = {"type": "rounded", "bevelRadius": round(rw, 5), "segments": steps}
        c["primitive"] = "extrude"
        # 单侧挤出：沿自身 local z 回退 depth*scale.z/2
        axis = rot_local_z(tr.get("rotation") or [0, 0, 0])
        delta = tuple(-0.5 * sz * axis[i] for i in range(3))
        shift_node(c, delta)
        n_box += 1
        log.append(f"box->extrude rw={rw:.4f} kids={len(children.get(c['id'], []))}: {c['id']}")
    log.append(f"[3] boxes converted: {n_box}")

    # --- 4) 座椅 curve-sweep -> 圆角 extrude --------------------------------------
    n_seat = 0
    for c in comps:
        if c.get("primitive") != "curve-sweep":
            continue
        tr = c.get("transform") or {}
        rot = tr.get("rotation") or [0, 0, 0]
        cs = (c.get("geometryDescriptor") or {}).get("curveSweep") or {}
        pts = (cs.get("crossSection") or {}).get("points") or []
        spine = cs.get("spine") or []
        if len(pts) < 4 or len(spine) < 2:
            log.append(f"[4] SKIP (no data) {c['id']}")
            continue
        # 只有当扫掠主轴是 local z 时，才能无损换成 extrude（extrude 恒沿 local z）。
        # 座椅靠背的 spine 沿 y —— 换 extrude 要改节点朝向，会带走子节点，改走 [5] 截面倒圆角。
        span = [max(float(s[i]) for s in spine) - min(float(s[i]) for s in spine) for i in range(3)]
        if span[2] < max(span[0], span[1]):
            log.append(f"[4] SKIP (spine axis != z) {c['id']}")
            continue
        hx = max(abs(float(p[0])) for p in pts)
        ys = [float(p[1]) for p in pts]
        spine_y = [float(s[1]) for s in spine]
        lo = min(ys) + min(spine_y)
        hi = max(ys) + max(spine_y)
        depth = max(
            (max(float(s[2]) for s in spine) - min(float(s[2]) for s in spine))
            + 0.0,
            1e-4,
        )
        # 实测：扫掠体在 spine 端点处会多出 crossSection 半宽，这里用 bbox 实测口径补回
        depth = depth * 1.016
        hy = (hi - lo) / 2.0
        rw = min(0.18 * min(2 * hx, 2 * hy), 0.03)
        rw = max(rw, 0.0015)
        prof = [
            [round(x * 2 * hx, 6), round(y * 2 * hy, 6)]
            for x, y in rounded_rect_profile(rw / (2 * hx), rw / (2 * hy))
        ]
        gd = c.setdefault("geometryDescriptor", {})
        gd["profile2D"] = {"points": prof, "depth": round(depth, 6)}
        gd["topologyIntent"] = (
            "rounded-rectangle cushion extrusion: 45deg single chamfers replaced by "
            f"{ARC_STEPS}-facet corner arcs"
        )
        if isinstance(gd.get("edgeTreatment"), dict):
            gd["edgeTreatment"] = {"type": "rounded", "bevelRadius": round(rw, 5), "segments": ARC_STEPS}
        gd.pop("curveSweep", None)
        c["primitive"] = "extrude"
        pos = list(tr.get("position") or [0, 0, 0])
        local_shift = (0.0, (hi + lo) / 2.0, -depth / 2.0)
        delta = rot_apply(rot, local_shift)
        shift_node(c, delta)
        n_seat += 1
        log.append(f"seat->extrude depth={depth:.3f} hx={hx:.3f} hy={hy:.3f} kids={len(children.get(c['id'], []))}: {c['id']}")
    log.append(f"[4] seats converted: {n_seat}")

    # --- 5) 剩余 curve-sweep：把截面的硬折角换成圆弧（零位移）---------------------
    n_cs = 0
    for c in comps:
        if c.get("primitive") != "curve-sweep":
            continue
        cs = (c.get("geometryDescriptor") or {}).get("curveSweep") or {}
        pts = (cs.get("crossSection") or {}).get("points") or []
        if len(pts) < 4:
            continue
        new_pts, rounded = round_polygon_corners(pts, 25.0)
        if not rounded:
            continue
        cs["crossSection"] = {"points": new_pts}
        gd = c["geometryDescriptor"]
        gd["topologyIntent"] = (
            f"cross-section corners replaced by {ARC_STEPS}-facet arcs (<=22.5deg per facet); "
            "swept corners no longer break the specular sweep"
        )
        n_cs += 1
        log.append(f"curve-sweep cross-section {len(pts)}->{len(new_pts)} pts: {c['id']}")
    log.append(f"[5] curve-sweep cross-sections rounded: {n_cs}")

    print("\n".join(log))
    print(f"\nTOTAL changed: {n_cyl} cylinder + {n_tube} tube + {n_box} box + {n_seat} seat + {n_cs} sweep")

    if not args.apply:
        print("\n[dry-run] 未写盘")
        return 0
    shutil.copyfile(SPEC, BACKUP)
    with open(SPEC, "w", encoding="utf-8") as fh:
        json.dump(spec, fh, ensure_ascii=False, indent=1)
    print(f"\n[applied] 备份 -> {BACKUP}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
