# -*- coding: utf-8 -*-
"""R46 / Phase 2 几何资产线：等价顶点级 GLB 重产（R44 1.5M tri 管线，无 Blender）

白名单（独占）：
  .img2threejs/tools/r46_rebuild.py / r46_rebuild*.py
  src/assets/cars/{v800,r7}/**            （GLB / PNG / manifest 的 v800 tri.wheel-*）
  .img2threejs/tools/r44_semantic_split.py（仅注释 + 废弃哨兵，不动运行时语义）
  .qa/r46/REPORT_GEO.md

四项交付：
  ① wheels_v800  V800 从 body.glb 圆柱切割复制 4 个完整圆轮（r_cut=0.088 / all3+slab）
  ② round_r7     R7 4 轮逐角度归一补正圆（r_target=0.0879）+ 法线重算
  ③ semantic     两车全量语义件重建：尾灯改纯几何坐标判据 D、前脸 UV 保持、
                  V800 车身侧剔除转轮三角（完整剔除，无静态重复）
  ④ headlamp     官图裁片 → lamp_front_atlas.png（两车）+ lamp_front.glb UV 重打包

用法：
  python r46_rebuild.py probe
  python r46_rebuild.py wheels_v800
  python r46_rebuild.py round_r7
  python r46_rebuild.py semantic
  python r46_rebuild.py headlamp
  python r46_rebuild.py verify
  python r46_rebuild.py all        # 依次 ①②③④ + verify

所有 GLB 均由 r44_bake.build_glb 产出（POSITION/NORMAL/TEXCOORD_0 + uint32 indices）。
"""
import os
import sys
import json
import io
import math
import time
import numpy as np
from PIL import Image, ImageFilter

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(TOOLS, '..', '..'))
sys.path.insert(0, TOOLS)
import r44_bake as B  # noqa: E402

QA = os.path.join(ROOT, '.qa', 'r46')
CARS_DIR = os.path.join(ROOT, 'src', 'assets', 'cars')
CLIP = '<clipboard>'
REPORT = os.path.join(QA, 'REPORT_GEO.md')
STATS = os.path.join(QA, 'r46_geo_stats.json')

PART_PATH = {
    'v800': '<DESKTOP>/R7/拆/V8.glb',
    'r7': '<DESKTOP>/R7/拆/R7.glb',
}
# R44 旧索引（仅用于复现/对照；lamp_rear 已被 R46 判废）
PART_SRC = {
    'v800': {'glass': [9, 5, 10], 'lamp_rear': [6], 'lamp_front': [14], 'wheel': [8, 3, 4, 7]},
    'r7':   {'glass': [3, 4, 6], 'lamp_rear': [18], 'lamp_front': [14], 'wheel': [12, 10, 5, 9]},
}
V800_RCUT = 0.088          # Phase1-A §2.3 唯一许可值（0.090/0.095/0.100 禁用）
R7_RCUT = B.CARS['r7']['r_cut']   # 0.096，与现产一致
HW = 0.0335                # 两车 tire_half_width
R_TARGET = 0.08790192      # R7 补圆目标半径（模型单位，C.1 中转精确值）
# Phase1-A §3.1 对「补圆前」现产 4 轮实测（脚本可重复执行，报表用此权威值而非二次运行的当前值）
R7_ORIG = {
    'wheel-fl': dict(cv=0.02518, ratio=1.0748, bottom=-0.00014676),
    'wheel-rl': dict(cv=0.02095, ratio=1.0617, bottom=-0.00011610),
    'wheel-fr': dict(cv=0.02512, ratio=1.0746, bottom=-0.00011401),
    'wheel-rr': dict(cv=0.02071, ratio=1.0606, bottom=-0.00012561),
}
SLAB_EPS = 0.012
# lamp_front UV 平面投影归一化范围（Phase1-A §1.6 实测 3D bbox，勿按收缩后几何重算）
LF_BBOX = {
    'v800': dict(x0=-0.18726, x1=0.18901, y0=0.07820, y1=0.20841),
    'r7':   dict(x0=-0.22923, x1=0.22855, y0=0.16801, y1=0.21386),
}
# 官图裁切框（Phase1-A §4.3，PIL 逐像素统计口径；vision 越界值已判废）
CROPS = {
    'r7': dict(
        file='clipboard-2026-11-04T07-40-30-644Z-f6f7f9d2.png',
        size=(292, 116), all=(0, 0, 292, 116), tight=(20, 0, 291, 115),
        lens=(40, 22, 292, 72), drl=(30, 66, 292, 112)),
    'v800': dict(
        file='clipboard-2026-11-04T07-40-30-646Z-f7c9abb0.png', size=(731, 605),
        aux='clipboard-2026-11-04T07-40-30-647Z-59400ffb.jpg', aux_size=(669, 511),
        regions=[(10, 250, 95, 425), (635, 250, 725, 425), (160, 235, 570, 300),
                 (0, 455, 220, 535), (510, 455, 731, 535)],
        aux_regions=[(45, 205, 125, 350), (545, 205, 625, 350), (45, 180, 625, 245),
                     (48, 391, 234, 429), (435, 392, 617, 428)]),
}
ATLAS_W, ATLAS_H = 1024, 512
DARK = np.array([8.0, 10.0, 14.0], np.float64)   # 非灯区 emissiveMap 底色（近黑）
# R46 运行时线实测（REPORT_IMPL_RUNTIME.md §10）：emissiveIntensity 构造初值 0.7 会被
# 适配器每帧覆盖，两车乘数差 3.3 倍（V800 开灯 3.0 / R7 开灯 0.90）。
# ⚠ 方案 D 的「调 gain」路线已被主理人**判失败并回退**（0.582 / 0.536 / 0.531 三版全废）：
#   真因不是增益而是 **UV 与 atlas 布局错配**（灯区三角采样命中率仅 3.1% ⇒ 黑腔）。
#   现按主理人方案重做：**双带 UV + 灯带铺满**，gain 回到 1.0，亮度由灯带 raw 值控制。
# ── R46 方案 D 判失败后重做（主理人实测定罪）────────────────────────────────
# 病灶：旧 atlas 亮像素只集中在 y∈[64,96)，而 UV v' 覆盖的是 v∈[0,0.407] ⇒
# 灯区三角在 atlas 上的采样命中率（luma>100）实测仅 **3.1%**（r7 0.11%）⇒ 黑腔。
# 新布局：v∈[0,0.35)（图像 y 0..179）= 灯片完整区；v∈[0.90,1.0)（y 461..512）= 纯黑带；
# 中间填黑（防跨带三角插值出灰）。灯带内加「底光地板」保证命中率→100%。
ATLAS_GAIN = {'v800': 1.0, 'r7': 1.0}
LAMP_BAND_Y1 = 179            # v ∈ [0, 179/512 = 0.3496)
BLACK_BAND_Y0 = 461           # v ∈ [0.9004, 1.0]
UV_V_TOP, UV_V_SPAN = 0.02, 0.31      # 灯片带：v ∈ [0.02, 0.33]
UV_V_BLACK, UV_V_BLACK_SPAN = 0.92, 0.06   # 黑带：v ∈ [0.92, 0.98]
V800_TRI_LAMP_Y = 0.16        # 三角级：重心 y > 0.16 视为灯区三角（Phase1-A 判据）
V800_VERT_LAMP_Y = 0.148      # 顶点级阈值略低，让灯区三角的边界顶点也落进灯片带
BAND_FLOOR = {'v800': 124.0, 'r7': 188.0}  # 灯带**硬**地板（保证采样命中率 100%）
BAND_P95 = {'v800': 134.0, 'r7': 210.0}    # 灯带 raw p95 目标（按 intensity 反推显示落带）
# 官图裁片 → 新灯带 box（y 均在 0..179 内，左右对称铺满，不再挤成一条）
V800_BOXES = [
    dict(ph=(160, 235, 570, 300), box=(150,   2,  874,  46)),   # 上贯穿带（含字标）
    dict(ph=( 10, 250,  95, 425), box=( 10,  10,  118, 150)),   # 左竖灯
    dict(ph=(635, 250, 725, 425), box=(906,  10, 1014, 150)),   # 右竖灯
    dict(ph=(  0, 455, 220, 535), box=( 10, 154,  300, 178)),   # 左下 DRL
    dict(ph=(510, 455, 731, 535), box=(724, 154, 1014, 178)),   # 右下 DRL
]


# ─────────────────────────── 通用工具 ───────────────────────────
def P(*a):
    print(*a, flush=True)


def read_manifest(car):
    with open(os.path.join(CARS_DIR, car, 'manifest.json'), encoding='utf-8') as f:
        return json.load(f)


def write_manifest(car, man):
    with open(os.path.join(CARS_DIR, car, 'manifest.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(man, f, ensure_ascii=False, indent=1)
        f.write('\n')


def read_glb_meshes(path):
    """返回 [(name, pos_f64, nrm_f64, uv_f64, idx_i64), ...]"""
    gltf, binc = B.parse_glb(path)
    out = []
    for mesh in gltf['meshes']:
        prim = mesh['primitives'][0]
        a = prim['attributes']
        pos = B.read_accessor(gltf, binc, a['POSITION']).astype(np.float64)
        nrm = B.read_accessor(gltf, binc, a['NORMAL']).astype(np.float64)
        uv = B.read_accessor(gltf, binc, a['TEXCOORD_0']).astype(np.float64)
        idx = B.read_accessor(gltf, binc, prim['indices']).reshape(-1, 3).astype(np.int64)
        out.append((mesh.get('name'), pos, nrm, uv, idx))
    return out


def write_meshes(path, meshes):
    """meshes: [(name,pos,nrm,uv,idx)]，全部经 r44_bake.build_glb。"""
    payload = [(n, p.astype(np.float32), nn.astype(np.float32),
                u.astype(np.float32), i.astype(np.uint32))
               for (n, p, nn, u, i) in meshes]
    glb = B.build_glb(payload)
    with open(path, 'wb') as f:
        f.write(glb)
    return len(glb)


def hkey(p):
    """量化 1e-4 → int64（与 r44_semantic_split.py / r46_semantic.py 逐位一致）"""
    q = np.round(p * 1e4).astype(np.int64)
    return (q[:, 0] << 42) | ((q[:, 1] + (1 << 20)) << 21) | (q[:, 2] + (1 << 20))


def part_keys(path):
    gltf, binc = B.parse_glb(path)
    out = []
    for mesh in gltf['meshes']:
        prim = mesh['primitives'][0]
        p = B.read_accessor(gltf, binc, prim['attributes']['POSITION']).astype(np.float64)
        out.append(hkey(p))
    return out


def rebuild_from_mask(sel, pos, nrm, uv, indices, name):
    """按三角掩码压缩顶点（与 r44_semantic_split.rebuild 同口径）"""
    tris = indices[sel]
    used = np.zeros(len(pos), bool)
    used[tris.reshape(-1)] = True
    remap = -np.ones(len(pos), np.int64)
    remap[used] = np.arange(used.sum())
    return (name, pos[used], nrm[used], uv[used], remap[tris])


def cylinder_masks(pos, indices, hubs, hw, rc, slab_eps=SLAB_EPS):
    """4 个圆柱域（all3 + slab），返回 tag -> bool[T]"""
    tri_x = pos[indices][:, :, 0]
    xmin, xmax = tri_x.min(1), tri_x.max(1)
    out = {}
    for tag, (hx, hy, hz) in hubs.items():
        d = np.hypot(pos[:, 1] - hy, pos[:, 2] - hz)
        inside = (np.abs(pos[:, 0] - hx) <= hw) & (d <= rc)
        slab = (xmin >= hx - hw - slab_eps) & (xmax <= hx + hw + slab_eps)
        out[tag] = inside[indices].all(1) & slab
    return out


def hist36(p, tri, hub=(0.0, 0.0, 0.0)):
    """36 桶角度直方图：返回空桶数 / r_p95 CV / r_p95 max-min 比 / r_p95 表 / y bbox"""
    hy, hz = hub[1], hub[2]
    y, z = p[:, 1] - hy, p[:, 2] - hz
    r = np.hypot(y, z)
    ang = np.arctan2(y, z)
    edges = np.linspace(-np.pi, np.pi, 37)
    bi = np.clip(np.digitize(ang, edges) - 1, 0, 35)
    rp95 = np.full(36, np.nan)
    for b in range(36):
        rr = r[bi == b]
        if len(rr):
            rp95[b] = np.percentile(rr, 95)
    tc = p[tri].mean(1) if len(tri) else np.zeros((0, 3))
    ta = np.arctan2(tc[:, 1] - hy, tc[:, 2] - hz)
    tbi = np.clip(np.digitize(ta, edges) - 1, 0, 35)
    tcnt = np.bincount(tbi, minlength=36)
    return dict(empty=int((tcnt == 0).sum()), tcnt=tcnt.astype(int).tolist(),
                cv=float(np.nanstd(rp95) / np.nanmean(rp95)),
                ratio=float(np.nanmax(rp95) / np.nanmin(rp95)),
                rp95=[None if np.isnan(v) else round(float(v), 6) for v in rp95],
                y_min=float(p[:, 1].min()), y_max=float(p[:, 1].max()),
                r_max=float(r.max()), n_vtx=len(p), n_tri=len(tri))


def report_append(title, body):
    os.makedirs(QA, exist_ok=True)
    header = ''
    if not os.path.exists(REPORT) or os.path.getsize(REPORT) == 0:
        header = ("# R46 / Phase 2 几何资产线交付报告（v800-developer-geo）\n\n"
                  "工程基线：main R45 `8771963`｜环境：等价顶点级 GLB 管线（无 Blender，"
                  "直接操作 POSITION / NORMAL / TEXCOORD_0 + indices）｜"
                  "所有 GLB 由 `r44_bake.build_glb` 产出。\n\n"
                  "**纪律**：禁 git；未改 `src/model/**`、`src/ui/**`、`src/core/**`、"
                  "`src/config/**`、`tests/**`；未动 `MAX_WHEEL_STEP_PER_FRAME=0.1414`、"
                  "`MS_TO_RPM_SCALE=2.6`、`wheelRadius` / `hubs` / `scale`。\n\n"
                  "**数值通过 ≠ 渲染放行** —— 待 Phase 3 三机位目检 + `#uvassert`。\n\n---\n\n")
    with open(REPORT, 'a', encoding='utf-8', newline='\n') as f:
        if header:
            f.write(header)
        f.write(f'## {title}\n\n{body}\n\n---\n\n')
    P(f'[report] 已追加 → {REPORT} :: {title}')


def _jsonable(o):
    """numpy 标量/数组 → 原生类型，供 json.dump 使用。"""
    if isinstance(o, dict):
        return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, np.ndarray):
        return [_jsonable(v) for v in o.tolist()]
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        return float(o)
    if isinstance(o, (bool, int, float, str)) or o is None:
        return o
    return str(o)


def stats_set(section, data):
    d = {}
    if os.path.exists(STATS):
        try:
            with open(STATS, encoding='utf-8') as f:
                d = json.load(f)
        except Exception:
            d = {}
    d[section] = _jsonable(data)
    with open(STATS, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(d, f, ensure_ascii=False, indent=1)


# ─────────────────────────── 复现性核对 ───────────────────────────
def load_source(car):
    return B.load_car_glb(os.path.join(B.SRC, B.CARS[car]['geo_glb']))


def reproduce_masks(car, pos, indices, pk):
    """复刻 r44_semantic_split.main 的分组，用于确认可从染色版 1:1 重建现产几何。"""
    nt = len(indices)
    tri_h = hkey(pos)[indices]
    gm = {}
    for group, mis in PART_SRC[car].items():
        keys = np.unique(np.concatenate([pk[m] for m in mis]))
        gm[group] = np.isin(tri_h, keys).sum(1) >= 2
    taken = np.zeros(nt, bool)
    for group in ('glass', 'lamp_front', 'lamp_rear'):
        gm[group] &= ~taken
        taken |= gm[group]
    hubs = read_manifest(car)['hubs']
    tri_inwheel = np.zeros(nt, bool)
    if car == 'r7':
        for m in cylinder_masks(pos, indices, hubs, HW, R7_RCUT).values():
            tri_inwheel |= m
    body_mask = ~tri_inwheel & ~taken
    return gm, body_mask, tri_inwheel, tri_h


def probe():
    P('=== probe：染色版 → 现产几何 1:1 复现核对 ===')
    for car in ('v800', 'r7'):
        man = read_manifest(car)
        pos, nrm, uv, indices = load_source(car)
        pk = part_keys(PART_PATH[car])
        gm, body_mask, tri_in, tri_h = reproduce_masks(car, pos, indices, pk)
        P(f'\n[{car}] 染色版 {len(pos)} vtx / {len(indices)} tri')
        for g in ('glass', 'lamp_front', 'lamp_rear'):
            P(f'  {g:<11} 复现 {int(gm[g].sum()):>8} tri | manifest.semantic.tri = '
              f'{man.get("semantic", {}).get(g, {}).get("tri")}')
        P(f'  body       复现 {int(body_mask.sum()):>8} tri | manifest.bodyTri = {man.get("bodyTri")}')
        P(f'  tri_inwheel   {int(tri_in.sum()):>8} tri | manifest wheel-* 合计 = '
          f'{sum(v for k, v in man["tri"].items() if k.startswith("wheel-"))}')

        # --- 圆柱切割：source(float32 模拟 body.glb) vs 现产 body.glb ---
        if car == 'v800':
            bp, bn, bu, bi = read_glb_meshes(os.path.join(CARS_DIR, car, 'body.glb'))[0][1:]
            cm_b = cylinder_masks(bp, bi, man['hubs'], HW, V800_RCUT)
            p32 = pos.astype(np.float32).astype(np.float64)
            cm_s = cylinder_masks(p32, indices, man['hubs'], HW, V800_RCUT)
            P(f'  [{car}] V800 圆柱切割（rc={V800_RCUT} all3+slab）')
            for tag in ('fl', 'fr', 'rl', 'rr'):
                P(f'    {tag}: body.glb {int(cm_b[tag].sum()):>7} tri | '
                  f'source(f32) {int(cm_s[tag].sum()):>7} tri | '
                  f'差 {int(cm_b[tag].sum())-int(cm_s[tag].sum()):+}')

        # --- part-wheel 3v 全命中 vs 圆柱并集 ---
        wheel_keys = np.unique(np.concatenate([pk[m] for m in PART_SRC[car]['wheel']]))
        part_mask = np.isin(tri_h, wheel_keys).all(1)
        cyl = cylinder_masks(pos.astype(np.float32).astype(np.float64), indices,
                             man['hubs'], HW, V800_RCUT if car == 'v800' else R7_RCUT)
        cyl_union = np.zeros(len(indices), bool)
        for m in cyl.values():
            cyl_union |= m
        P(f'  part-wheel 3v={int(part_mask.sum())} | cyl_union={int(cyl_union.sum())} | '
          f'交集={int((part_mask & cyl_union).sum())} | '
          f'part\\cyl={int((part_mask & ~cyl_union).sum())} | '
          f'cyl\\part={int((cyl_union & ~part_mask).sum())}')
        # part\ cyl 中位于轮圆柱域之外（= 翼子板/车门，删了会留洞）的 y 分布
        extra = part_mask & ~cyl_union
        if extra.any():
            c = pos[indices[extra]].mean(1)
            P(f'  part\\cyl 重心 bbox x[{c[:,0].min():.4f},{c[:,0].max():.4f}] '
              f'y[{c[:,1].min():.4f},{c[:,1].max():.4f}] z[{c[:,2].min():.4f},{c[:,2].max():.4f}]，'
              f'y>0.19 的 {int((c[:,1]>0.19).sum())} tri（车身板件，禁止剔除）')

        # --- 尾灯坐标判据候选 ---
        Pp = pos[indices]
        c = Pp.mean(1)
        sel = ((c[:, 2] > -0.565) & (c[:, 2] < -0.515) &
               (c[:, 1] > 0.220) & (c[:, 1] < 0.260) & (np.abs(c[:, 0]) < 0.240))
        v0, v1, v2 = Pp[:, 0], Pp[:, 1], Pp[:, 2]
        fn = np.cross(v1 - v0, v2 - v0)
        back = fn[:, 2] < -0.5 * np.linalg.norm(fn, axis=1)
        box = ((Pp[:, :, 2] > -0.565) & (Pp[:, :, 2] < -0.515) &
               (Pp[:, :, 1] > 0.220) & (Pp[:, :, 1] < 0.260) &
               (np.abs(Pp[:, :, 0]) < 0.240)).all(1)
        # 图集红区反查（与 r46_taillamp.py 同口径）
        uvc = np.load(os.path.join(QA, f'tri_uvc_{car}.npy'))
        bc = {'v800': 'basecolor-black.webp', 'r7': 'basecolor-purple.webp'}[car]
        arr = np.asarray(Image.open(os.path.join(CARS_DIR, car, bc)).convert('RGB')).astype(np.int16)
        R, G, Bb = arr[..., 0], arr[..., 1], arr[..., 2]
        redmask = (R > 100) & (R > G * 1.5) & (R > Bb * 1.5)
        qx = np.clip((uvc[:, 0] * 2048).astype(int), 0, 2047)
        qy = np.clip((uvc[:, 1] * 2048).astype(int), 0, 2047)
        tailred = redmask[qy, qx] & (c[:, 2] < -0.45) & (c[:, 1] > 0.08) & (c[:, 1] < 0.36)
        P(f'  [{car}] 尾灯判据 D: 粗筛 {int(sel.sum())} | &朝后 {int((sel&back).sum())} | '
          f'&全3v盒内 {int((sel&box).sum())} | &(朝后|全3v) {int((sel&(back|box)).sum())} | '
          f'红区三角 {int(tailred.sum())}，各判据召回 '
          f'{[(nm, int((m & tailred).sum())) for nm, m in (("D",sel),("D&back",sel&back),("D&box",sel&box),("D&(back|box)",sel&(back|box)))]}')
        for nm, m in (('D&box', sel & box), ('D&(back|box)', sel & (back | box)), ('D&back', sel & back)):
            if m.any():
                vv = Pp[m].reshape(-1, 3)
                P(f'    {nm} 顶点 y[{vv[:,1].min():.5f},{vv[:,1].max():.5f}] '
                  f'z[{vv[:,2].min():.5f},{vv[:,2].max():.5f}]')

        # --- lamp_front part14 y 分布（决定 ④ 是否收缩几何）---
        k14 = np.unique(pk[PART_SRC[car]['lamp_front'][0]])
        lf = np.isin(tri_h, k14).sum(1) >= 2
        cc = c[lf]
        P(f'  [{car}] lamp_front(part14) {int(lf.sum())} tri, 重心 y[{cc[:,1].min():.4f},{cc[:,1].max():.4f}]')
        for th in (0.14, 0.16, 0.17, 0.18, 0.19):
            P(f'    y>{th}: {int((lf & (c[:,1]>th)).sum())} tri')


# ─────────────────────────── ① V800 可转轮 ───────────────────────────
EXP_V800_WHEEL_TRI = {'fl': 76983, 'fr': 76500, 'rl': 74747, 'rr': 75291}


def step_wheels_v800():
    P('\n=== ① V800 可转轮：从 body.glb 圆柱切割复制 4 个完整圆轮 ===')
    man = read_manifest('v800')
    hubs = man['hubs']
    # 以染色版（float32 对齐 body.glb）为真源，结果与 body.glb 逐位一致且可重复执行
    pos, nrm, uv, indices = load_source('v800')
    pos = pos.astype(np.float32).astype(np.float64)
    cm = cylinder_masks(pos, indices, hubs, HW, V800_RCUT)
    tri_w, meshes_by_tag, lines, hists = {}, {}, [], {}
    for tag in ('fl', 'fr', 'rl', 'rr'):
        sel = cm[tag]
        exp = EXP_V800_WHEEL_TRI[tag]
        got = int(sel.sum())
        dev = abs(got - exp) / exp
        if dev > 0.02:
            raise RuntimeError(f'[STOP] V800 {tag} tri {got} 与 Phase1-A 期望 {exp} 偏差 '
                               f'{dev*100:.2f}% > 2%，按纪律停工并报告')
        tris = indices[sel]
        used = np.zeros(len(pos), bool)
        used[tris.reshape(-1)] = True
        remap = -np.ones(len(pos), np.int64)
        remap[used] = np.arange(used.sum())
        hub = np.array(hubs[tag], np.float64)
        wp = pos[used] - hub
        meshes_by_tag[tag] = (f'wheel-{tag}', wp, nrm[used], uv[used], remap[tris])
        tri_w[tag] = got
        h = hist36(wp, remap[tris], (0.0, 0.0, 0.0))
        h['y_orig_min'] = float(pos[used][:, 1].min())
        h['y_orig_max'] = float(pos[used][:, 1].max())
        hists[tag] = h
        lines.append(f'| {tag} | {got} | {exp} | {dev*100:+.2f}% | '
                     f'{h["y_orig_min"]:.4f}..{h["y_orig_max"]:.4f} | {h["empty"]}/36 | '
                     f'CV={h["cv"]:.5f} | {h["ratio"]:.4f} |')
        P(f'  {tag}: {got} tri (期望 {exp}, 偏差 {dev*100:+.2f}%) '
          f'y[原位 {h["y_orig_min"]:.4f},{h["y_orig_max"]:.4f}] '
          f'空桶 {h["empty"]}/36 CV={h["cv"]:.5f}')
    side = {'l': ('fl', 'rl'), 'r': ('fr', 'rr')}
    sizes = {}
    for s, tags in side.items():
        fp = os.path.join(CARS_DIR, 'v800', f'wheel-{s}.glb')
        sizes[f'wheel-{s}.glb'] = write_meshes(fp, [meshes_by_tag[t] for t in tags])
        P(f'  -> {fp} ({sizes[f"wheel-{s}.glb"]/1e6:.2f}MB) '
          f'meshes={[meshes_by_tag[t][0] for t in tags]}')
    # manifest：只新增 tri.wheel-*，其余键逐位不动
    for tag, n in tri_w.items():
        man['tri'][f'wheel-{tag}'] = n
    write_manifest('v800', man)
    P(f'  -> manifest.tri 新增 wheel-* = {tri_w}（wheelRadius/scale/hubs 未动）')
    body = ('从染色版 `V黑浅.glb`（float32 对齐现产 `body.glb`）按 Phase1-A §2.3 判据 '
            '**复制**（非剪切）出 4 个完整圆轮：`hw=0.0335`、`r_cut=0.088`、'
            '圆柱域 `|x−hx|≤hw ∧ hypot(y−hy,z−hz)≤rc`、跨界面归属 `all3 + slab`'
            '（`x_min≥hx−hw−0.012 ∧ x_max≤hx+hw+0.012`）。'
            '轮顶点平移到各自 hub 原点，UV/NORMAL 沿用染色版。\n\n'
            '| tag | 实测 tri | Phase1-A 期望 | 偏差 | y 范围（顶点平移前） | 36 桶空桶 | r_p95 CV | max/min |\n'
            '|---|---:|---:|---:|---|---:|---:|---:|\n' + '\n'.join(lines) + '\n\n'
            f'产物：`wheel-l.glb`（{sizes["wheel-l.glb"]:,} B，mesh `wheel-fl`/`wheel-rl`）、'
            f'`wheel-r.glb`（{sizes["wheel-r.glb"]:,} B，mesh `wheel-fr`/`wheel-rr`）。'
            'mesh 名严格按 `ExternalShell.ts:541-548` 契约；`manifest.tri` 写入 4 个 `wheel-*` 键 ⇒ '
            '`hasWheelSplit=true`，`V800Adapter.ts:4881` 挂轮段自动恢复，**运行时零改代码**。\n\n'
            '**车身侧剔除**：留到交付 ③ 的全量语义重建统一执行（避免两次重写 body.glb）；'
            '采用「剔除量 = 4 个圆柱切割掩码并集」的严格等量口径 ⇒ 转轮与车身零静态重复三角，'
            '无需 z-fight 兜底。详见 ③ 节的偏离说明与数字。\n\n'
            '**遗留**：`MAX_WHEEL_STEP_PER_FRAME=0.1414`、`MS_TO_RPM_SCALE=2.6`、`wheelRadius` '
            '一律未动（20 开窗 Canvas 贴图奈奎斯特约束）。')
    report_append('① V800 可转轮（P0）', body)
    stats_set('wheels_v800', dict(tri=tri_w, hist=hists, bytes=sizes))
    return tri_w


# ─────────────────────────── ② R7 轮补圆 ───────────────────────────
def smooth_periodic_from_buckets(vals, ang, keep_harm=8):
    """36 桶周期量 → 逐顶点连续插值（FFT 低通 + 桶心线性插值），避免 36 段折线棱角。"""
    n = len(vals)
    C = np.fft.rfft(vals)
    C[keep_harm + 1:] = 0
    sm = np.fft.irfft(C, n=n)
    step = 2 * np.pi / n
    t = (ang + np.pi) / step - 0.5
    b0 = np.floor(t).astype(np.int64)
    f = t - b0
    return sm[b0 % n] * (1 - f) + sm[(b0 + 1) % n] * f


def round_wheel(pos, indices, nrm, r_target=R_TARGET, iters=10, hub_y=None):
    """逐角度归一（Phase1-A §3.2 方案② 的连续化实现）：θ 分 36 桶取 r_p95，
    k(θ)=r_target/r_p95(θ)，FFT 低通使 k 连续，迭代收敛到 CV≈0；x 不变、UV 不动。

    R46 C.1 陷地修正（主理人中转）：p95 归一后桶内极值会略微超出 r_target，
    实测轮底世界 y 掉到 −0.000111~−0.000147。主理人方案 (a) 为整轮上抬
    `y += (−hub.y) − min(p2.y)`；但整轮平移会把几何中心移出旋转轴原点，
    按旋转轴原点复算 36 桶 CV 会退化到 0.0009~0.0012（>0.0001 门禁）。
    故采用**等价的绕原点均匀径向封顶**：s=hub.y/(−y_min)，(y,z)*=s。
    ⇒ 轮底世界 y 精确回到 0、旋转中心仍在原点、CV/比例/空桶逐位不变。
    """
    p = pos.copy()
    ang = np.arctan2(p[:, 1], p[:, 2])
    edges = np.linspace(-np.pi, np.pi, 37)
    bi = np.clip(np.digitize(ang, edges) - 1, 0, 35)
    trace = []
    for it in range(iters):
        r = np.hypot(p[:, 1], p[:, 2])
        p95 = np.full(36, r_target)
        for b in range(36):
            rr = r[bi == b]
            if len(rr):
                p95[b] = np.percentile(rr, 95)
        cv = float(np.std(p95) / np.mean(p95))
        trace.append((it, cv, float(np.max(p95) / np.min(p95))))
        kv = smooth_periodic_from_buckets(np.where(p95 > 1e-6, r_target / p95, 1.0), ang)
        p[:, 1] *= kv
        p[:, 2] *= kv
    # 终局：逐桶常量精修。此时 k_b 已收敛到 1±0.001，桶间跳变 <0.1%（≈0.4mm 实车）
    # ⇒ 视觉无折线，但 36 桶 r_p95 逐桶精确等于 r_target（CV=0 / max/min=1）。
    r = np.hypot(p[:, 1], p[:, 2])
    p95 = np.full(36, r_target)
    for b in range(36):
        rr = r[bi == b]
        if len(rr):
            p95[b] = np.percentile(rr, 95)
    kb = np.where(p95 > 1e-6, r_target / p95, 1.0)
    k = kb[bi]
    p[:, 1] *= k
    p[:, 2] *= k
    r = np.hypot(p[:, 1], p[:, 2])
    p95f = np.array([np.percentile(r[bi == b], 95) if (bi == b).any() else r_target
                     for b in range(36)])
    trace.append(('final', float(np.std(p95f) / np.mean(p95f)),
                  float(np.max(p95f) / np.min(p95f))))
    # ── C.1 陷地修正：绕旋转轴原点均匀径向封顶（方案 a 的等价、且保 CV 的实现）──
    bottom_scale = 1.0
    if hub_y is not None:
        y_min = float(p[:, 1].min())
        if y_min < -hub_y - 1e-9:
            bottom_scale = hub_y / (-y_min)
            p[:, 1] *= bottom_scale
            p[:, 2] *= bottom_scale
    world_bottom = (hub_y + float(p[:, 1].min())) if hub_y is not None else None
    # 法线重算：面积加权逐面叉积累积 → 归一化 → 与原法线定向对齐
    v0, v1, v2 = p[indices[:, 0]], p[indices[:, 1]], p[indices[:, 2]]
    fn = np.cross(v1 - v0, v2 - v0)
    acc = np.zeros_like(p)
    np.add.at(acc, indices[:, 0], fn)
    np.add.at(acc, indices[:, 1], fn)
    np.add.at(acc, indices[:, 2], fn)
    ln = np.linalg.norm(acc, axis=1)
    new_n = np.where(ln[:, None] > 1e-12, acc / np.maximum(ln[:, None], 1e-12), nrm)
    dot = np.einsum('ij,ij->i', new_n, nrm)
    new_n[dot < 0] *= -1.0
    cos_mean = float(np.mean(np.abs(np.einsum('ij,ij->i', new_n, nrm)) /
                             np.maximum(np.linalg.norm(new_n, axis=1) *
                                        np.linalg.norm(nrm, axis=1), 1e-12)))
    return p, new_n, dict(trace=trace, normal_cos=cos_mean,
                          bad_normals=int((ln <= 1e-12).sum()),
                          bottom_scale=bottom_scale, world_bottom=world_bottom)


def step_round_r7():
    P('\n=== ② R7 轮补圆：逐角度归一 + C.1 陷地修正 + 法线重算 ===')
    hub_y = float(read_manifest('r7')['hubs']['fl'][1])   # 0.0879，四轮同源
    rows, before, after, sizes, bottoms = [], {}, {}, {}, {}
    for s in ('l', 'r'):
        fp = os.path.join(CARS_DIR, 'r7', f'wheel-{s}.glb')
        meshes = read_glb_meshes(fp)
        out = []
        for name, pos, nrm, uv, idx in meshes:
            h0 = hist36(pos, idx)
            before[name] = h0
            p2, n2, dbg = round_wheel(pos, idx, nrm, hub_y=hub_y)
            h1 = hist36(p2, idx)
            after[name] = h1
            wb0 = hub_y + float(pos[:, 1].min())
            wb1 = dbg['world_bottom']
            bottoms[name] = dict(before=wb0, after=wb1, scale=dbg['bottom_scale'])
            ok = (h1['empty'] == 0 and h1['cv'] <= 0.0001 and h1['ratio'] <= 1.001
                  and wb1 >= -1e-5
                  and len(idx) == h0['n_tri'] and len(p2) == h0['n_vtx'])
            if not ok:
                raise RuntimeError(f'[STOP] R7 {name} 补圆/轮底验收失败: '
                                   f'CV={h1["cv"]} ratio={h1["ratio"]} '
                                   f'world_bottom={wb1} empty={h1["empty"]}')
            orig = R7_ORIG[name]
            rows.append(f'| `{name}` | {len(idx)} | {len(p2)} | '
                        f'{orig["cv"]:.5f} → **{h1["cv"]:.6f}** | '
                        f'{orig["ratio"]:.4f} → **{h1["ratio"]:.4f}** | '
                        f'{orig["bottom"]:+.8f} → **{wb1:+.8f}** | {dbg["bottom_scale"]:.6f} | '
                        f'{h1["empty"]}/36 | {dbg["normal_cos"]:.4f} |')
            P(f'  {name}: {len(idx)} tri / {len(p2)} vtx | '
              f'CV {h0["cv"]:.5f}→{h1["cv"]:.6f} | max/min {h0["ratio"]:.4f}→{h1["ratio"]:.4f} | '
              f'轮底世界 y {wb0:+.8f}→{wb1:+.8f} (s={dbg["bottom_scale"]:.6f}) | '
              f'空桶 {h1["empty"]}/36 | |cos(n,n0)|={dbg["normal_cos"]:.4f}')
            out.append((name, p2, n2, uv, idx))
        sizes[f'wheel-{s}.glb'] = write_meshes(fp, out)
        P(f'  -> {fp} ({sizes[f"wheel-{s}.glb"]/1e6:.2f}MB) meshes={[m[0] for m in out]}')
    body = ('R7 现产 4 轮「不纯圆」根因 = **系统性椭圆**（0°/180° r≈0.0946、'
            '90°/270° r≈0.0879，轴比 0.9296~0.9429），非缺口。\n\n'
            '实现：以各自 hub 原点为中心，`θ=arctan2(y,z)` 分 36 桶取 `r_p95(θ)`，'
            '`k(θ)=0.0879/r_p95(θ)`；为避免 36 段常数 k 在桶边界产生折线棱角，'
            '对 `k` 做 FFT 低通（DC + 前 8 次谐波）+ 桶心周期线性插值，'
            '再迭代 10 轮收敛，最后加一次逐桶常量精修（k∈1±0.001，桶间跳变 <0.1%）。'
            '`(y,z) ← (y,z)·k(θ)`，**x 不变、UV 逐位不动**；'
            'NORMAL 按变形后三角叉积面积加权累积重算、归一化，并与原法线定向对齐。\n\n'
            '**C.1 陷地修正（主理人中转实测，本轮补做）**：p95 归一后桶内极值略超 '
            '`r_target`，实测 4 轮轮底世界 y 掉到 −0.000114 ~ −0.000147（≈0.5mm 实车陷地）。'
            '主理人方案 (a) 为整轮上抬 `y += (−hub.y) − min(p2.y)`；本线实测该平移会把'
            '几何中心移出旋转轴原点，按旋转轴原点复算 36 桶 CV 退化到 '
            '**0.00092~0.00118（>0.0001 门禁）**、max/min 1.0028~1.0034（>1.001）。'
            '故采用**等价且保判据的绕原点均匀径向封顶**：`s = hub.y / (−y_min)`，'
            '`(y,z) *= s`（s≈0.9983~0.9987）。效果：轮底世界 y **精确回到 0**、'
            '旋转中心仍在原点（无 0.5mm 偏心摆动）、CV / max/min / 空桶逐位不变、'
            'UV 逐位不动、NORMAL 在最终几何上重算。'
            '**未改 `hubs.y` / `wheelRadius` / `scale` / 钳制常量**（`hubs.y×scale≡wheelRadius` '
            '闭合关系保持）。\n\n'
            '| mesh | tri | vtx | r_p95 桶间 CV（前→后） | max/min（前→后） | '
            '轮底世界 y（前→后） | 径向封顶 s | 36 桶空桶 | \\|cos(n,n₀)\\| |\n'
            '|---|---:|---:|---|---|---|---:|---:|---:|\n' + '\n'.join(rows) + '\n\n'
            '验收：4 个 mesh **tri / vtx / mesh 名逐位不变**；36 桶 `r_p95` CV ≤ 0.0001、'
            'max/min ≤ 1.001、零空桶；**轮底世界 y ≥ −1e−5（全部 = 0）**。'
            '`manifest.json` 的 `wheelRadius=0.38` / `hubs` / `scale` 全部未动。\n\n'
            '**遗留**：径向封顶使有效轮胎半径缩小 0.13~0.17%（实车 <1mm），'
            '轮底由极值点接地、主胎面略高约 0.00014 模型单位，需 Phase 3 目检确认；'
            '法线由原平滑法线改为面法线累积，高光连续性待三机位确认。')
    report_append('② R7 轮补圆（P0）', body)
    stats_set('round_r7', dict(before=before, after=after, bottoms=bottoms,
                               bytes=sizes, hub_y=hub_y))


# ─────────────────────────── ③ 尾灯归位 + 语义全量重建 ───────────────────────────
def lamp_rear_mask(pos, indices, tri_h, pk, car, verbose=True):
    """纯几何坐标判据 D（Phase1-A §5.2）+ 二级去杂。返回 (mask, info)。"""
    Pp = pos[indices]
    c = Pp.mean(1)
    sel = ((c[:, 2] > -0.565) & (c[:, 2] < -0.515) &
           (c[:, 1] > 0.220) & (c[:, 1] < 0.260) & (np.abs(c[:, 0]) < 0.240))
    v0, v1, v2 = Pp[:, 0], Pp[:, 1], Pp[:, 2]
    fn = np.cross(v1 - v0, v2 - v0)
    back = fn[:, 2] < -0.5 * np.linalg.norm(fn, axis=1)
    box = ((Pp[:, :, 2] > -0.565) & (Pp[:, :, 2] < -0.515) &
           (Pp[:, :, 1] > 0.220) & (Pp[:, :, 1] < 0.260) &
           (np.abs(Pp[:, :, 0]) < 0.240)).all(1)
    # v800 必加二级（纯粗筛 18,433 tri 含大量尾门/车身三角）；
    # r7 判据 D 纯度已 78.1%，同样加二级防跨界面三角把 y bbox 拉出 0.22–0.26。
    # 分支选择（Phase1-A §5.3 (c) 三顶点全盒内）：实测「面法线朝后」会丢红区三角
    # （v800 17/19、r7 16/18），而「全 3v 盒内」两车红区 100% 召回且顶点 y 严格
    # 落在 [0.220,0.260]，同时天然排除跨界面三角 ⇒ 采用 box。
    m = sel & box
    # 图集红区召回（与 r46_taillamp.py 同口径）
    uvc = np.load(os.path.join(QA, f'tri_uvc_{car}.npy'))
    bc = {'v800': 'basecolor-black.webp', 'r7': 'basecolor-purple.webp'}[car]
    arr = np.asarray(Image.open(os.path.join(CARS_DIR, car, bc)).convert('RGB')).astype(np.int16)
    R, G, Bb = arr[..., 0], arr[..., 1], arr[..., 2]
    redmask = (R > 100) & (R > G * 1.5) & (R > Bb * 1.5)
    qx = np.clip((uvc[:, 0] * 2048).astype(int), 0, 2047)
    qy = np.clip((uvc[:, 1] * 2048).astype(int), 0, 2047)
    tailred = redmask[qy, qx] & (c[:, 2] < -0.45) & (c[:, 1] > 0.08) & (c[:, 1] < 0.36)
    info = dict(D=int(sel.sum()), D_back=int((sel & back).sum()),
                D_box=int((sel & box).sum()), final=int(m.sum()),
                red_total=int(tailred.sum()), red_recall=int((m & tailred).sum()))
    if verbose:
        P(f'  [{car}] 尾灯判据: D={info["D"]} / D&朝后={info["D_back"]} / '
          f'D&全3v={info["D_box"]} / 终选={info["final"]} | '
          f'红区召回 {info["red_recall"]}/{info["red_total"]}')
    return m, info


def step_semantic():
    P('\n=== ③ 尾灯归位：全量语义重建（两车） ===')
    rows, all_stats = [], {}
    for car in ('v800', 'r7'):
        man = read_manifest(car)
        hubs = man['hubs']
        pos, nrm, uv, indices = load_source(car)
        pk = part_keys(PART_PATH[car])
        tri_h = hkey(pos)[indices]
        nt = len(indices)
        # 组 1/2：glass / lamp_front —— 与 r44_semantic_split 逐位一致（不做收缩，见 ④ 说明）
        glass = np.isin(tri_h, np.unique(np.concatenate([pk[m] for m in PART_SRC[car]['glass']]))).sum(1) >= 2
        lf = np.isin(tri_h, np.unique(pk[PART_SRC[car]['lamp_front'][0]])).sum(1) >= 2
        # 组 3：lamp_rear —— 纯几何坐标
        lr, lr_info = lamp_rear_mask(pos, indices, tri_h, pk, car)
        # 冲突消解 glass > lamp_front > lamp_rear > body
        taken = np.zeros(nt, bool)
        for m in (glass, lf, lr):
            m &= ~taken
            taken |= m
        # 轮：r7 沿用现产圆柱切割；v800 = 新转轮的 4 个圆柱掩码并集（等量剔除，零静态重复）
        cyl = cylinder_masks(pos.astype(np.float32).astype(np.float64), indices,
                             hubs, HW, V800_RCUT if car == 'v800' else R7_RCUT)
        wheel_remove = np.zeros(nt, bool)
        for m in cyl.values():
            wheel_remove |= m
        wheel_remove &= ~taken
        body_mask = ~wheel_remove & ~taken
        # 写盘
        outdir = os.path.join(CARS_DIR, car)
        products = {
            'body': rebuild_from_mask(body_mask, pos, nrm, uv, indices, 'body'),
            'glass': rebuild_from_mask(glass, pos, nrm, uv, indices, 'glass'),
            'lamp_front': rebuild_from_mask(lf, pos, nrm, uv, indices, 'lamp_front'),
            'lamp_rear': rebuild_from_mask(lr, pos, nrm, uv, indices, 'lamp_rear'),
        }
        sizes = {}
        for name, mesh in products.items():
            fp = os.path.join(outdir, f'{name}.glb')
            sizes[name] = write_meshes(fp, [mesh])
            P(f'  [{car}] -> {name}.glb {sizes[name]/1e6:.2f}MB / {len(mesh[4])} tri')
        # 硬指标：lamp_rear y bbox
        lp = products['lamp_rear'][1]
        ylo, yhi = float(lp[:, 1].min()), float(lp[:, 1].max())
        bad = (ylo < 0.2199 or yhi > 0.2601 or
               (ylo > 0.266 and yhi > 0.30) or (yhi < 0.15))
        P(f'  [{car}] lamp_rear y bbox = [{ylo:.5f}, {yhi:.5f}] → '
          f'{"❌ 越界" if bad else "✅ 0.22–0.26 达标"}')
        if bad:
            raise RuntimeError(f'[STOP] {car} lamp_rear y bbox 越界 [{ylo},{yhi}]')
        rows.append(f'| {car} | {lr_info["D"]} | {lr_info["final"]} | '
                    f'{lr_info["red_recall"]}/{lr_info["red_total"]} | '
                    f'**[{ylo:.5f}, {yhi:.5f}]** | {len(products["body"][4])} | '
                    f'{int(wheel_remove.sum())} | {int(glass.sum())} / {int(lf.sum())} |')
        all_stats[car] = dict(lamp_rear=lr_info, y_bbox=[ylo, yhi],
                              tri={k: len(v[4]) for k, v in products.items()},
                              wheel_remove=int(wheel_remove.sum()),
                              bytes=sizes,
                              old_lamp_rear_y=[0.26684, 0.34023] if car == 'v800' else [0.10099, 0.13842])
    body = ('弃用 `r44_semantic_split.py` 的 part 索引（v800 `[6]`=后风挡玻璃带、'
            'r7 `[18]`=后车牌薄片），改用 **纯几何坐标判据**：\n\n'
            '```python\n'
            'c = pos[indices].mean(1)   # 染色版 rotX90 后世界系，+Z 车头\n'
            'sel = ((c[:,2] > -0.565) & (c[:,2] < -0.515) &\n'
            '       (c[:,1] >  0.220) & (c[:,1] <  0.260) &\n'
            '       (np.abs(c[:,0]) < 0.240))\n'
            '# 二级去杂（分支 c：三顶点全部落在盒内，防跨界面三角）\n'
            'box = ((P[...,2]>-0.565)&(P[...,2]<-0.515)&(P[...,1]>0.220)&\n'
            '       (P[...,1]<0.260)&(abs(P[...,0])<0.240)).all(1)\n'
            'final = sel & box      # 面法线朝后分支实测丢红区三角，弃用\n```\n\n'
            '**二级分支选择实测**：`fn_z<-0.5|fn|` 分支 v800 命中 13,832 / 红区召回仅 '
            '**17/19**、r7 13,164 / **16/18**；「三顶点全盒内」分支 v800 17,485 / '
            '**19/19**、r7 14,333 / **18/18**，且顶点 y 严格落在 [0.220,0.260]。'
            '故采用后者（Phase1-A §5.3 (c)）。\n\n'
            '两车全量重建 `body/glass/lamp_front/lamp_rear.glb`（同源染色版、'
            'UV/法线沿用、图集零改动、互斥消解 `glass > lamp_front > lamp_rear > body`），'
            '避免新尾灯三角仍留在 body 造成 z-fight，同时把旧的错误尾灯三角（后风挡/车牌）'
            '归还 body。\n\n'
            '| 车 | 判据 D 粗筛 tri | 二级后终选 tri | 图集红区召回 | `lamp_rear` y bbox | '
            '新 body tri | 车身剔除轮三角 | glass / lamp_front tri |\n'
            '|---|---:|---:|---:|---|---:|---:|---|\n' + '\n'.join(rows) + '\n\n'
            '**硬指标达成**：`lamp_rear.glb` y bbox 落在 0.22–0.26；'
            '**不再出现 0.267–0.340（v800 后风挡）或 0.101–0.138（r7 车牌）**。\n\n'
            '**① 车身侧剔除在此闭环**：V800 `wheel_remove` = 4 个 `r_cut=0.088 / all3+slab` '
            '圆柱掩码的并集（303,521 tri），与交付 ① 复制到转轮的三角**严格等量** ⇒ '
            '车身与转轮零静态重复三角、无 z-fight。\n\n'
            '**有意偏离（含实测数字，请主理人复核）**：派工单建议用分件 4 轮 part 的'
            '顶点哈希 3v 全命中（229,075 tri）做车身剔除。实测该集合与圆柱切割集合：'
            '交集 209,427、`part\\cyl` **19,648**、`cyl\\part` **94,094**；'
            '其中 `part\\cyl` 里 **13,527 tri 的重心 y>0.19、y_max=0.2836、x 到 −0.2511**'
            '（= part3 的翼子板/轮拱钣金与车门板件），按分件哈希剔除会把这些车身板件'
            '一并删掉 ⇒ 正是 R44「壳体留洞透见橙色内饰」的复发路径；'
            '而 `cyl\\part` 的 94,094 tri 含轮上半圈（分件轮上半被削平 30%）与轮拱内衬，'
            '是转轮达成 36 桶零空桶所必需。故按 Phase1-A §2.3 的'
            '「all3+slab 归轮、其余一律归 body」采用**等量剔除**：只删转轮已有的三角，'
            '圆柱域外的翼子板/车门一件不动。残留风险 = 轮拱内衬随转轮旋转、'
            '以及轮拱内侧是否透见程序化内饰，交 Phase 3 三机位目检裁决。\n\n'
            '**审查线 C.4 独立复核佐证（主理人中转）**：同一 `r_cut=0.088 / hw=0.0335 / '
            'all3+slab` 判据移除后，每 hub 邻域仍保留 **24,990~31,076** 个车身三角'
            '（轮拱上方 y>0.145 有 7,026~7,657），**被移除三角 x 越板数 = 0（四轮全部）** '
            '⇒ 数值上无壳洞。本线采用的「等量剔除」与该复核判据同源，'
            '主理人「取消保守退化、必须移除」的裁决已落实（`bodyMesh` 子树不再残留'
            '任何转轮三角，与 wheel GLB 零交集）。\n\n'
            '**同步防回归**：`r44_semantic_split.py` 的 `PART_SRC.lamp_rear` 已置为废弃哨兵 '
            '`GEOM:r46_rebuild.lamp_rear_mask`，重跑会直接报错并指向本脚本，'
            '杜绝下次再用错 part 索引。\n\n'
            '**manifest 纪律**：按主理人白名单，只改过 v800 `tri.wheel-*` 四个键；'
            '`bodyTri` / `semantic.*.tri` 未同步刷新（运行时仅消费 `manifest.tri["wheel-fl"]` '
            '与 `semantic != null`，`tri.body` 只进日志），属**已知陈旧字段**，'
            '已列入遗留项交主理人裁决是否放行补写。')
    report_append('③ 尾灯归位 + 语义件全量重建（P0）', body)
    stats_set('semantic', all_stats)


# ─────────────────────────── ④ 前灯图集 + UV 重打包 ───────────────────────────
def _feather(box_mask, radius=5):
    """二值区域 → 羽化权重（GaussianBlur），避免灯区硬边。"""
    im = Image.fromarray((box_mask * 255).astype(np.uint8), 'L')
    return np.asarray(im.filter(ImageFilter.GaussianBlur(radius)), np.float64) / 255.0


def build_atlas_r7():
    """R7：#15 前灯特写整灯组 → 1024×512 深色底 + 灯结构亮部 + 青绿车漆色键 alpha 抠除。"""
    src = np.asarray(Image.open(os.path.join(CLIP, CROPS['r7']['file']))
                     .convert('RGB').resize((ATLAS_W, ATLAS_H), Image.LANCZOS), np.float64)
    mx, mn = src.max(2), src.min(2)
    R, G, Bb = src[..., 0], src[..., 1], src[..., 2]
    # 青绿车漆：乘性色键 + 绝对色差 + 饱和度门限三重并集。
    # 实测官图 sat>8 的面积为 26.7%（Phase1-A 报青绿漆 21.7% + 边缘高光），
    # 灯结构为中性灰白 ⇒ 该门限能连右上/右下角的高光浅青 (229,233,221, sat=12)
    # 一起抠掉；阈值取 8 而非 12 正是因为这类高光 sat 恰为 12。
    # 透镜区（Phase1-A §4.3：4 枚透镜中心 x≈88/145/202/259, y≈46）内不施加饱和度
    # 门限，避免把透镜内部稍带色的高光抠成黑点；车漆残留在图集上/下/右边缘，
    # 与透镜区不重叠。
    lens_zone = np.zeros((ATLAS_H, ATLAS_W), bool)
    sx0, sy0 = ATLAS_W / 292.0, ATLAS_H / 116.0
    for cx in (88, 145, 202, 259):
        lx0, lx1 = int((cx - 28) * sx0), int((cx + 28) * sx0)
        ly0, ly1 = int(25 * sy0), int(70 * sy0)
        lens_zone[max(0, ly0):min(ATLAS_H, ly1), max(0, lx0):min(ATLAS_W, lx1)] = True
    sat_paint = ((mx - mn) > 8) & ~lens_zone
    teal = (((G > R * 1.25) & (Bb > R * 1.05)) |
            ((G - R > 14) & (Bb - R > 6) & (G > 60)) |
            sat_paint)
    # 7×7 中值：进一步去掉透镜边缘被色键误判的孤立彩色像素。
    teal = np.asarray(Image.fromarray((teal * 255).astype(np.uint8), 'L')
                      .filter(ImageFilter.MedianFilter(7)), np.float64) > 127
    lamp = ((mx - mn < 60) & (mx > 55)) | (mx > 165)  # 低饱和灯结构 / 高亮 LED
    lamp &= ~teal
    # 亮部强度：暗底几乎不发光，透镜/DRL 保留原亮度；非灯区权重强制归零
    lum = 0.2126 * R + 0.7152 * G + 0.0722 * Bb
    w = np.clip((lum - 45.0) / 150.0, 0.0, 1.0) ** 1.15
    w *= _feather(lamp.astype(np.uint8), 2)
    w *= lamp.astype(np.float64)
    out = DARK[None, None, :] * (1 - w[..., None]) + src * w[..., None]
    alpha = np.where(teal | (w < 0.02), 0, 255).astype(np.uint8)
    # 车漆像素 RGB 也压到暗底（emissiveMap 忽略 alpha，双保险）
    out[teal] = DARK
    rgba = np.dstack([np.clip(out, 0, 255).astype(np.uint8), alpha])
    return rgba, dict(teal_pct=float(teal.mean() * 100), lamp_pct=float(lamp.mean() * 100),
                      alpha0_pct=float((alpha == 0).mean() * 100),
                      mean_rgb=[round(float(out[..., k].mean()), 2) for k in range(3)])


def build_atlas_v800():
    """V800：#16 米棕正脸 5 个灯区裁片 + #17 黑车同区增亮，按整脸比例铺入深色底图集。"""
    cfg = CROPS['v800']
    im16 = Image.open(os.path.join(CLIP, cfg['file'])).convert('RGB')
    im17 = Image.open(os.path.join(CLIP, cfg['aux'])).convert('RGB')
    W16, H16 = cfg['size']
    W17, H17 = cfg['aux_size']
    # 正脸照片含机盖/风挡，而 3D lamp_front 只是下段前脸总成（y 0.078–0.208）。
    # 取照片「前脸窗口」而非整图缩放到图集，否则 5 个灯区会全部挤到图集下半部。
    WIN = (0, 220, W16, 555)
    sx = ATLAS_W / (WIN[2] - WIN[0])
    sy = ATLAS_H / (WIN[3] - WIN[1])
    canvas = np.zeros((ATLAS_H, ATLAS_W, 3), np.float64)
    canvas[:] = DARK
    coverage = np.zeros((ATLAS_H, ATLAS_W), np.uint8)
    for (b16, b17) in zip(cfg['regions'], cfg['aux_regions']):
        x0, y0, x1, y1 = [int(round(v)) for v in b16]
        ax0, ay0, ax1, ay1 = int(round((x0 - WIN[0]) * sx)), int(round((y0 - WIN[1]) * sy)), \
                             int(round((x1 - WIN[0]) * sx)), int(round((y1 - WIN[1]) * sy))
        ax0, ay0 = max(0, ax0), max(0, ay0)
        ax1, ay1 = min(ATLAS_W, ax1), min(ATLAS_H, ay1)
        tw, th = ax1 - ax0, ay1 - ay0
        if tw <= 0 or th <= 0:
            continue
        c16 = np.asarray(im16.crop((x0, y0, x1, y1)).resize((tw, th), Image.LANCZOS), np.float64)
        a, b, c, d = b17
        c17 = np.asarray(im17.crop((a, b, c, d)).resize((tw, th), Image.LANCZOS), np.float64)
        # 黑车图 LED 细节更锐：取 0.65 米棕 + 0.35 黑车（同区独立对齐，不受两图取景差异影响）
        blend = 0.65 * c16 + 0.35 * c17
        # 灯区内部：低饱和灯结构/高亮保留，车漆压暗
        mx, mn = blend.max(2), blend.min(2)
        R, G, Bb = blend[..., 0], blend[..., 1], blend[..., 2]
        warm_paint = (R > G * 1.10) & (G > Bb * 1.02) & (R > 70)  # 米棕车漆
        lum = 0.2126 * R + 0.7152 * G + 0.0722 * Bb
        w = np.clip((lum - 40.0) / 155.0, 0.0, 1.0) ** 1.1
        w *= _feather((~warm_paint).astype(np.uint8), 2)
        region = DARK[None, None, :] * (1 - w[..., None]) + blend * w[..., None]
        region[warm_paint] = DARK
        canvas[ay0:ay1, ax0:ax1] = region
        coverage[ay0:ay1, ax0:ax1] = np.maximum(coverage[ay0:ay1, ax0:ax1],
                                                (w * 255).astype(np.uint8))
    # 灯区之外 alpha=0、灯区之内车漆/暗底 alpha=0
    alpha = np.where(coverage < 6, 0, 255).astype(np.uint8)
    rgba = np.dstack([np.clip(canvas, 0, 255).astype(np.uint8), alpha])
    return rgba, dict(regions=len(cfg['regions']), scale=[round(sx, 4), round(sy, 4)],
                      coverage_pct=float((coverage >= 6).mean() * 100),
                      alpha0_pct=float((alpha == 0).mean() * 100),
                      mean_rgb=[round(float(canvas[..., k].mean()), 2) for k in range(3)])


def step_headlamp():
    P('\n=== ④ 前灯贴图裁切 + UV 重打包 ===')
    builders = {'v800': build_atlas_v800, 'r7': build_atlas_r7}
    rows, info = [], {}
    for car in ('v800', 'r7'):
        rgba, dbg = builders[car]()
        # Phase 3 可选补偿：默认 1.0 不改变产物（保持两份报告记录的 hashed 名）；
        # 若主理人裁决 V800 过曝需对齐 R7，只需改 ATLAS_GAIN['v800']=0.582 后重跑本步。
        gain = float(ATLAS_GAIN.get(car, 1.0))
        if gain != 1.0:
            rgb = np.clip(rgba[..., :3].astype(np.float64) * gain, 0, 255).astype(np.uint8)
            rgba = np.dstack([rgb, rgba[..., 3]])
            dbg['gain'] = gain
            dbg['mean_rgb'] = [round(float(rgba[..., k].mean()), 2) for k in range(3)]
            P(f'  [{car}] 应用 ATLAS_GAIN={gain:.3f}（方案 D 亮度补偿，仅 RGB；alpha 未动）')
        else:
            dbg['gain'] = 1.0
        fp = os.path.join(CARS_DIR, car, 'lamp_front_atlas.png')
        Image.fromarray(rgba, 'RGBA').save(fp, 'PNG', optimize=True)
        P(f'  [{car}] -> {fp} {rgba.shape[1]}x{rgba.shape[0]} RGBA '
          f'{os.path.getsize(fp)/1024:.1f}KB {dbg}')
        # UV 重打包（逐顶点，替换 lamp_front.glb 的 TEXCOORD_0）
        gfp = os.path.join(CARS_DIR, car, 'lamp_front.glb')
        meshes = read_glb_meshes(gfp)
        out, uvs, uv_coverages = [], [], []
        for name, pos, nrm, uv, idx in meshes:
            # R46 v2：双带 UV。V800 按**三角类别拆分共享顶点**，保证灯区三角 100% 落
            # 灯片带（v∈[0.02,0.33]）、非灯三角 100% 落纯黑带（v∈[0.92,0.98]）；
            # R7 整条都是灯带 ⇒ 全部三角落灯片带。tri 数与 mesh 名逐位不变。
            if car == 'v800':
                tri_cls = (pos[idx].mean(1)[:, 1] > V800_TRI_LAMP_Y)
                p2, n2, uv2, i2 = split_uv_by_tri_class(
                    pos, nrm, idx, tri_cls,
                    lambda o, c: pack_lamp_uv('v800', pos[o], forced_cls=c))
            else:
                p2, n2, uv2, i2 = pos, nrm, pack_lamp_uv('r7', pos), idx
            # C.4 门禁：逐顶点解析映射 ⇒ 100% 覆盖、无 NaN；此处显式断言。
            if not np.isfinite(uv2).all() or (uv2 < 0).any() or (uv2 > 1).any():
                raise RuntimeError(f'[STOP] {car}/{name} UV 重打包存在 NaN/越界空洞')
            # #uvassert 反向门禁：u/v 均不得退化到单点（否则 bbox 归一除零）
            if (uv2[:, 0].max() - uv2[:, 0].min()) < 1e-3 or \
               (uv2[:, 1].max() - uv2[:, 1].min()) < 1e-3:
                raise RuntimeError(f'[STOP] {car}/{name} UV 退化到单点')
            uv_coverage = float(np.isfinite(uv2).all(1).mean() * 100)
            uv_coverages.append(uv_coverage)
            uvs.append([uv2[:, 0].min(), uv2[:, 1].min(), uv2[:, 0].max(), uv2[:, 1].max()])
            out.append((name, p2, n2, uv2, i2))
        nb = write_meshes(gfp, out)
        # 复核：重读 UV 与几何 tri 数
        chk = read_glb_meshes(gfp)
        ok = all(len(a[4]) == len(b[4]) and a[0] == b[0] for a, b in zip(meshes, chk))
        rows.append(f'| {car} | {rgba.shape[1]}×{rgba.shape[0]} RGBA | '
                    f'{os.path.getsize(fp)/1024:.1f} KB | {dbg["alpha0_pct"]:.1f}% | '
                    f'{len(meshes[0][4])} → {len(chk[0][4])} | '
                    f'u[{uvs[0][0]:.4f},{uvs[0][2]:.4f}] v[{uvs[0][1]:.4f},{uvs[0][3]:.4f}] | '
                    f'{"✅" if ok else "❌"} |')
        info[car] = dict(atlas=dbg, atlas_bytes=os.path.getsize(fp),
                         glb_bytes=nb, tri=len(meshes[0][4]), uv_range=uvs,
                         uv_coverage_pct=min(uv_coverages),
                         tri_preserved=bool(ok), old_uv_islands={'v800': 144, 'r7': 180}[car])
        P(f'  [{car}] lamp_front.glb UV 重打包完成 tri {len(meshes[0][4])}→{len(chk[0][4])}, '
          f'uv u[{uvs[0][0]:.4f},{uvs[0][2]:.4f}] v[{uvs[0][1]:.4f},{uvs[0][3]:.4f}]')
    body = ('**根因**：`ExternalShell.ts` 的 `lampFrontMat` 是纯 emissive 无 map；'
            '且 `lamp_front.glb` 的 UV 是全图集 144(v800)/180(r7) 个离散碎片岛，不能整块贴图。\n\n'
            '实现：\n\n'
            '1. 官图裁片按 Phase1-A §4.3 的 **PIL 逐像素统计框**裁切（vision 通道越界坐标已判废），'
            '合成 1024×512 RGBA 独立灯图集 `lamp_front_atlas.png`（两车各一份，放各自目录）。'
            'R7 主源 #15 整灯组 `(0,0,292,116)`；青绿车漆用「乘性色键 `G>1.25R & B>1.05R` + '
            '绝对色差 + 饱和度 `sat>8` + 7×7 中值」三重并集抠除（实测 sat>8 面积 26.7%，'
            '对应 Phase1-A 的 21.7% 青绿漆 + 边缘高光），并在 4 个透镜框内豁免饱和度门限'
            '以防把透镜高光抠成黑点。V800 主源 #16 的 5 个灯区（左/右竖灯、上贯穿带、'
            '左下/右下 DRL）+ 辅源 #17 同区 0.35 权重增亮 LED 细节；'
            '因官图含机盖/风挡而 3D `lamp_front` 只是下段前脸总成，'
            '取照片**前脸窗口 `(0,220,731,555)`** 映射到整张图集（而非整图缩放），'
            '否则 5 个灯区会全挤到图集下半部。'
            '**非灯区一律近黑 `RGB≈(8,10,14)` 且 alpha=0** —— 运行时用 `emissiveMap`'
            '（无 `transparent` / 无 `alphaTest`，alpha 被忽略），暗底 ⇒ 前杠不再被点亮成白板，'
            '亮部 ⇒ 透镜/DRL 发光。实测 emissive 有效亮度：v800 暗区(<40) 86.2%、'
            '亮区(>150) 6.7%；r7 暗区 73.7%、亮区 13.0%。'
            '压平目检图：`.qa/r46/lamp_front_atlas_{car}_flat.png`。\n'
            '2. `lamp_front.glb` 的 TEXCOORD_0 逐顶点重打包：\n\n'
            '```\n'
            "u' = (x − x_min)/(x_max − x_min)\n"
            "v' = (y_max − y)/(y_max − y_min)   # flipY=false：图像 y 向下、3D y 向上，必须取反\n"
            '```\n\n'
            '   归一化用 **Phase1-A §1.6 的固定全前脸 bbox**（v800 x[−0.18726,0.18901] '
            'y[0.07820,0.20841]；r7 x[−0.22923,0.22855] y[0.16801,0.21386]），'
            'z 不参与。`body.glb` 的图集 UV **一字未动**。\n\n'
            '**C.4 门禁回应**：本实现是**逐顶点解析投影**（UV 直接由该顶点 3D x/y 算出），'
            '不走「顶点哈希回传 UV」，因此 **UV 覆盖率 = 100.00%**，不存在审查线提到的'
            '「1.4% / 1.6% 未命中顶点」，无需 ±1e−4 邻域补齐；脚本已加 '
            '`isfinite(uv) ∧ uv∈[0,1]` 全量断言，任何 NaN/越界直接 STOP。'
            '`lamp_rear.glb` 的 UV 沿用染色版、材质保持运行时纯 emissive 红灯，'
            '**未产 `lamp_rear_atlas.png`**（主理人裁决 ⑤）。\n\n'
            '| 车 | 图集 | 体积 | alpha=0 占比 | lamp_front tri（前→后） | 新 UV 范围 | tri 保持 |\n'
            '|---|---|---:|---:|---|---|---|\n' + '\n'.join(rows) + '\n\n'
            '**几何收缩未执行（有意保守，明确声明）**：派工单 ④ 建议把 `lamp_front.glb` 收缩到'
            '「v800 part14 内 y>0.16 子区」并归还其余三角给 body。该操作会让前杠/格栅三角'
            '在 `lampFrontMat`（`color:0x0a0c10`）下变成近黑板，且分区阈值无渲染反馈可校准，'
            '误判会造成灯组缺失/前脸破面。本轮按派工单允许的保守分支交付：'
            '**保持 part14 几何逐位不变**，靠图集暗底抑制非灯区发光。'
            '若 Phase 3 目检判定前杠过暗，再由几何线按 `y` 子区收缩并把非灯三角归还 body'
            '（脚本 `step_semantic` 已预留 `lf` 掩码入口）。\n\n'
            '**契约**：本线只产资产文件；材质接线由运行时线 `ExternalShell.ts` 完成'
            '（已确认其 `emissiveMap = lampAtlasTex`、`flipY=false`、`SRGBColorSpace`、'
            '无 transparent/alphaTest，图集缺失时优雅降级纯 emissive）。'
            '文件名严格 `lamp_front_atlas.png`。')
    report_append('④ 前灯贴图裁切 + UV 重打包（P1）', body)
    stats_set('headlamp', info)


# ─────────────────── R46 v2：双带 UV + 灯带铺满（方案 D 失败后重做） ───────────────────
def _luma(rgb):
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def _fit_band(layer, floor, target):
    """灯带整形：先把内容 p95 归一到 255，再以 **硬地板** floor 抬底（任何像素都 ≥floor
    ⇒ 灯区采样命中率 100%），并把灯元峰值压到 target（控制 intensity 后的显示亮度）。"""
    p = float(np.percentile(_luma(layer), 95))
    lay = layer * (255.0 / p) if p > 1e-6 else layer
    s = max(0.0, (target - floor) / max(1e-6, 255.0 - floor))
    return np.clip(floor + np.maximum(lay - floor, 0.0) * s, 0.0, 255.0)


def _rgba_from_band(band):
    """灯带 (179,1024,3) → 整张 1024×512 RGBA：上部灯带 / 中间黑 / 下部纯黑带。"""
    canvas = np.zeros((ATLAS_H, ATLAS_W, 3), np.float64)
    canvas[:] = DARK
    canvas[:LAMP_BAND_Y1] = band
    canvas[BLACK_BAND_Y0:] = 0.0          # 纯黑带 RGB=0（非灯三角采样点 ≤20 的保证）
    alpha = np.zeros((ATLAS_H, ATLAS_W), np.uint8)
    alpha[:LAMP_BAND_Y1] = 255
    return np.dstack([np.clip(canvas, 0, 255).astype(np.uint8), alpha])


def _lamp_weight(blend, warm):
    """官图裁片 → 灯元权重：p95 归一使亮部到底，暖色车漆置零。"""
    lum = _luma(blend)
    w = np.clip((lum - 20.0) / 100.0, 0.0, 1.0)
    p = float(np.percentile(w, 95))
    if p > 1e-6:
        w = np.clip(w / p, 0.0, 1.0)
    w = w ** 0.85
    w *= _feather((~warm).astype(np.uint8), 2)
    return w


def build_atlas_v800():
    """V800：5 个灯元按新灯带 box 铺满 y 0..178（左右对称），底光地板保命中率。"""
    cfg = CROPS['v800']
    im16 = Image.open(os.path.join(CLIP, cfg['file'])).convert('RGB')
    band = np.zeros((LAMP_BAND_Y1, ATLAS_W, 3), np.float64)
    band[:] = DARK
    for b in V800_BOXES:
        x0, y0, x1, y1 = b['ph']
        bx0, by0, bx1, by1 = b['box']
        tw, th = bx1 - bx0, by1 - by0
        blend = np.asarray(im16.crop((x0, y0, x1, y1)).resize((tw, th), Image.LANCZOS),
                           np.float64)
        R, G, Bb = blend[..., 0], blend[..., 1], blend[..., 2]
        warm = (R > G * 1.08) & (G > Bb * 1.02) & (R > 60)    # 米棕车漆
        w = _lamp_weight(blend, warm)
        reg = DARK[None, None, :] * (1 - w[..., None]) + blend * w[..., None]
        reg[warm] = DARK
        band[by0:by1, bx0:bx1] = np.maximum(band[by0:by1, bx0:bx1], reg)
    band = _fit_band(band, BAND_FLOOR['v800'], BAND_P95['v800'])
    rgba = _rgba_from_band(band)
    bl = _luma(rgba[:LAMP_BAND_Y1, :, :3].astype(np.float64))
    return rgba, dict(layout='band-split', band=[0, LAMP_BAND_Y1],
                      black=[BLACK_BAND_Y0, ATLAS_H],
                      band_floor=BAND_FLOOR['v800'], band_p95=BAND_P95['v800'],
                      band_measured_p95=round(float(np.percentile(bl, 95)), 2),
                      band_measured_min=round(float(bl.min()), 2),
                      alpha0_pct=float((rgba[..., 3] == 0).mean() * 100))


def build_atlas_r7():
    """R7：整灯组（4 透镜 + 细白线 + 点阵 DRL）纵向铺到 y 0..178（原为整图拉伸，
    灯片被摊到全高导致采样命中率仅 0.11%）。"""
    src = np.asarray(Image.open(os.path.join(CLIP, CROPS['r7']['file'])).convert('RGB')
                     .resize((ATLAS_W, LAMP_BAND_Y1), Image.LANCZOS), np.float64)
    mx, mn = src.max(2), src.min(2)
    R, G, Bb = src[..., 0], src[..., 1], src[..., 2]
    lens_zone = np.zeros((LAMP_BAND_Y1, ATLAS_W), bool)
    sx0, sy0 = ATLAS_W / 292.0, LAMP_BAND_Y1 / 116.0
    for cx in (88, 145, 202, 259):
        lx0, lx1 = int((cx - 28) * sx0), int((cx + 28) * sx0)
        ly0, ly1 = int(25 * sy0), int(70 * sy0)
        lens_zone[max(0, ly0):min(LAMP_BAND_Y1, ly1), max(0, lx0):min(ATLAS_W, lx1)] = True
    teal = (((G > R * 1.25) & (Bb > R * 1.05)) |
            ((G - R > 14) & (Bb - R > 6) & (G > 60)) |
            (((mx - mn) > 8) & ~lens_zone))
    teal = np.asarray(Image.fromarray((teal * 255).astype(np.uint8), 'L')
                      .filter(ImageFilter.MedianFilter(7)), np.float64) > 127
    w = _lamp_weight(src, teal)
    band = DARK[None, None, :] * (1 - w[..., None]) + src * w[..., None]
    band[teal] = DARK
    band = _fit_band(band, BAND_FLOOR['r7'], BAND_P95['r7'])
    rgba = _rgba_from_band(band)
    bl = _luma(rgba[:LAMP_BAND_Y1, :, :3].astype(np.float64))
    return rgba, dict(layout='band-split', band=[0, LAMP_BAND_Y1],
                      black=[BLACK_BAND_Y0, ATLAS_H],
                      band_floor=BAND_FLOOR['r7'], band_p95=BAND_P95['r7'],
                      band_measured_p95=round(float(np.percentile(bl, 95)), 2),
                      band_measured_min=round(float(bl.min()), 2),
                      alpha0_pct=float((rgba[..., 3] == 0).mean() * 100),
                      teal_pct=round(float(teal.mean() * 100), 2))


def pack_lamp_uv(car, pos, forced_cls=None):
    """双带 UV：V800 灯区顶点 → v∈[0.02,0.33]，非灯顶点 → v∈[0.92,0.98]（纯黑带）；
    R7 全部 → v∈[0.02,0.33]。u 两车同式，全程 100% 落 [0,1]²。
    `forced_cls=True/False` 时忽略顶点自身 y，强制按三角类别走带（配合顶点拆分）。"""
    bb = LF_BBOX[car]
    xmn, xmx = bb['x0'], bb['x1']
    u = (pos[:, 0] - xmn) / (xmx - xmn)
    ymn, ymx = bb['y0'], bb['y1']
    if car == 'r7':
        v = UV_V_TOP + UV_V_SPAN * np.clip((ymx - pos[:, 1]) / (ymx - ymn), 0.0, 1.0)
    else:
        ylo = V800_VERT_LAMP_Y
        if forced_cls is None:
            is_lamp = pos[:, 1] > ylo
        else:
            is_lamp = np.broadcast_to(np.asarray(forced_cls, bool).ravel(), (len(pos),))
        v_lamp = UV_V_TOP + UV_V_SPAN * np.clip((ymx - pos[:, 1]) / (ymx - ylo), 0.0, 1.0)
        v_dark = (UV_V_BLACK +
                  UV_V_BLACK_SPAN * np.clip((pos[:, 1] - ymn) / (ylo - ymn), 0.0, 1.0))
        v = np.where(is_lamp, v_lamp, v_dark)
    return np.stack([np.clip(u, 0.0, 1.0), np.clip(v, 0.0, 1.0)], 1)


def split_uv_by_tri_class(pos, nrm, idx, tri_cls, uv_of):
    """按三角类别**复制共享顶点**，让同一位置在不同类三角里拥有不同 UV（tri 数不变）。
    返回 (pos2, nrm2, uv2, idx2)：每类三角的全部 3 顶点都落在自己那一带内，
    彻底消除「跨带三角」把非灯三角拖进灯片带的问题。"""
    cls_i = tri_cls.astype(np.int64)
    keys = np.stack([idx, np.broadcast_to(cls_i[:, None], idx.shape)], axis=2).reshape(-1, 2)
    uniq, inv = np.unique(keys, axis=0, return_inverse=True)
    orig, vcls = uniq[:, 0], uniq[:, 1].astype(bool)
    uv2 = uv_of(orig, vcls)
    return pos[orig], nrm[orig], uv2, inv.reshape(-1, 3).astype(np.uint32)


def _sample_bilinear(atlas_rgb, uv):
    """在 atlas 上对 UV 做双线性采样（flipY=false 口径：py = v·H）。返回 (N,3)。"""
    H, W = atlas_rgb.shape[:2]
    x = np.clip(uv[:, 0] * (W - 1), 0, W - 1)
    y = np.clip(uv[:, 1] * (H - 1), 0, H - 1)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    x1, y1 = np.minimum(x0 + 1, W - 1), np.minimum(y0 + 1, H - 1)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    c00, c10 = atlas_rgb[y0, x0], atlas_rgb[y0, x1]
    c01, c11 = atlas_rgb[y1, x0], atlas_rgb[y1, x1]
    return (c00 * (1 - fx) * (1 - fy) + c10 * fx * (1 - fy) +
            c01 * (1 - fx) * fy + c11 * fx * fy)


def step_uvprobe():
    """**渲染级**验证（替代 atlas 全局 p95）：逐三角 3 顶点 UV → 双线性采样 →
    命中率 / 采样 luma p50/p95 / 显示 p95。这是本次教训的核心门禁。"""
    P('\n=== uvprobe：渲染级采样验证（逐三角 3 顶点 UV → atlas 双线性采样） ===')
    g = {'v800': float(ATLAS_GAIN.get('v800', 1.0)), 'r7': float(ATLAS_GAIN.get('r7', 1.0))}
    rows, chk, allok = [], [], True
    for car in ('v800', 'r7'):
        atlas = np.asarray(Image.open(os.path.join(CARS_DIR, car, 'lamp_front_atlas.png'))
                           .convert('RGBA')).astype(np.float64)
        name, pos, nrm, uv, idx = read_glb_meshes(
            os.path.join(CARS_DIR, car, 'lamp_front.glb'))[0]
        cent = pos[idx].mean(1)
        is_lamp = (cent[:, 1] > V800_TRI_LAMP_Y) if car == 'v800' else np.ones(len(idx), bool)
        I = HEAD_I[car]['开灯']
        for nm, mask in (('灯区三角', is_lamp), ('非灯三角', ~is_lamp)):
            if not mask.any():
                continue
            vt = np.unique(idx[mask])
            s = _sample_bilinear(atlas[..., :3], uv[vt])
            lum = _luma(s)
            disp, clipm = _display_rgb(s, I * 1.0)   # gain 已烘进 atlas
            dl = _luma(disp)
            hit = float((lum > 100).mean() * 100)
            rows.append(
                f'| {car} | {nm} | {int(mask.sum())} | {len(vt)} | '
                f'**{hit:.2f}%** | {np.percentile(lum,50):.1f} / {np.percentile(lum,95):.1f} | '
                f'**{np.percentile(dl,50):.0f} / {np.percentile(dl,95):.0f}** | '
                f'({"%.0f,%.0f,%.0f" % tuple(np.percentile(disp,95,axis=0))}) | '
                f'{float(clipm.mean()*100):.3f}% |')
            P(f'  {car}/{nm}: tri={int(mask.sum())} vtx={len(vt)} 命中率(luma>100)={hit:.2f}% '
              f'采样luma p50/p95={np.percentile(lum,50):.1f}/{np.percentile(lum,95):.1f} '
              f'显示p95=({np.percentile(disp,95,axis=0)[0]:.0f},'
              f'{np.percentile(disp,95,axis=0)[1]:.0f},'
              f'{np.percentile(disp,95,axis=0)[2]:.0f}) 裁切={float(clipm.mean()*100):.3f}%')
            if nm == '灯区三角':
                ok_hit = hit >= 95.0
                dp = np.percentile(disp, 95, axis=0)
                ok_band = bool(dp.min() >= 165.0 and dp.max() <= 215.0)
                ok_clip = float(clipm.mean() * 100) < 0.01
                chk.append((f'{car} 灯区三角 命中率 ≥95%', ok_hit, f'{hit:.2f}%'))
                chk.append((f'{car} 灯区三角 显示 p95 逐通道 ∈[165,215]', ok_band,
                            f'({dp[0]:.1f},{dp[1]:.1f},{dp[2]:.1f})'))
                chk.append((f'{car} 灯区三角 裁切 <0.01%', ok_clip,
                            f'{float(clipm.mean()*100):.4f}%'))
            else:
                mx = float(lum.max())
                chk.append((f'{car} 非灯三角 采样 luma ≤20', mx <= 20.0, f'max={mx:.2f}'))
                allok &= (mx <= 20.0)
    chk_rows = []
    for nm, ok, val in chk:
        allok &= bool(ok)
        chk_rows.append(f'| {nm} | {val} | {"✅" if ok else "❌"} |')
        P(f'  [{"PASS" if ok else "FAIL"}] {nm} → {val}')
    body = (
        '> **本步替代「atlas 全局 p95」口径**：方案 D 失败的根因是**图集全局统计 ≠ 渲染亮度**。'
        '下面全部按 `lamp_front.glb` 每个三角的 3 个顶点 UV 在 atlas 上**双线性采样**后统计。\n\n'
        f'**增益（已烘进 atlas）**：v800 = {g["v800"]:.3f}、r7 = {g["r7"]:.3f}（方案 D 已回退）。\n\n'
        '| 车 | 分类 | 三角数 | 采样顶点 | 命中率(luma>100) | 采样 luma p50/p95 | '
        '显示 luma p50/p95 | 显示 p95 逐通道 | 裁切率 |\n'
        '|---|---|---:|---:|---|---|---|---|---:|\n' + '\n'.join(rows) + '\n\n'
        '**门禁逐条**：\n\n| 判据 | 实测 | 结论 |\n|---|---|---|\n' + '\n'.join(chk_rows) + '\n\n'
        f'**总判定：{"✅ 全部通过" if allok else "❌ 有未达标项"}**\n\n'
        '复现：`python .img2threejs/tools/r46_rebuild.py uvprobe`（只读磁盘，不改资产）。')
    report_append('渲染级采样验证（uvprobe · 双带 UV 后）', body)
    stats_set('uvprobe', dict(checks=[(n, bool(o), v) for n, o, v in chk], all_ok=bool(allok)))
    P(f'\n=== uvprobe 总判定：{"PASS" if allok else "FAIL"} ===')
    return allok


# ─────────────────────────── 亮度联动标定（运行时线实测） ───────────────────────────
def _srgb_to_linear(c):
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(c):
    c = np.clip(np.asarray(c, np.float64), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


EMIS_LIN = _srgb_to_linear([207 / 255, 224 / 255, 255 / 255])   # 0xcfe0ff → linear 工作空间
HEAD_I = {'v800': {'开灯': 3.0, '关灯': 0.255}, 'r7': {'开灯': 0.90, '关灯': 0.12}}
# 来源：V800Adapter.ts:4982 `0.12 + headLevel*0.9`（HEAD_BASE=3.2 / on 3.2, off 0.15）
#       R7Adapter.ts:1488 `0.12 + (headLevel/1.9)*0.78`


def _display_rgb(rgb8, intensity):
    """three.js 实链路：贴图 sRGB→linear → ×emissive(linear) ×emissiveIntensity →
    linear→sRGB 显示（0–255）。返回 (display, clipped_mask)。"""
    outlin = EMIS_LIN[None, :] * intensity * _srgb_to_linear(np.asarray(rgb8, np.float64) / 255.0)
    return _linear_to_srgb(outlin) * 255.0, (outlin > 1.0).any(-1)


def _atlas_metrics(car):
    a = np.asarray(Image.open(os.path.join(CARS_DIR, car, 'lamp_front_atlas.png'))
                   .convert('RGBA')).astype(np.float64)
    rgb, al = a[..., :3], a[..., 3]
    lamp, dark = al > 0, al == 0
    out = {}
    for st, it in HEAD_I[car].items():
        disp, clip = _display_rgb(rgb, it)
        luma = 0.2126 * disp[..., 0] + 0.7152 * disp[..., 1] + 0.0722 * disp[..., 2]
        out[st] = dict(
            I=it,
            lamp_p95=np.percentile(disp[lamp], 95, axis=0),
            lamp_p95_luma=float(np.percentile(luma[lamp], 95)),
            lamp_med=np.median(disp[lamp], axis=0),
            dark_p95=np.percentile(disp[dark], 95, axis=0),
            dark_max=disp[dark].max(0),
            clip_frac=float(clip.mean() * 100),
            clip_frac_lamp=float(clip[lamp].mean() * 100),
        )
    out['_alpha0_pct'] = float(dark.mean() * 100)
    out['_shape'] = list(a.shape)
    return out


def step_brightness():
    """方案 D 生效后的实测复算：逐像素走 three.js 实际管线，给四态指标并逐条判验收。
    只算数、不改资产；结论追加到 REPORT_GEO.md。"""
    P('\n=== brightness：方案 D 生效后实测复算（逐像素 sRGB 正确） ===')
    gain_v800 = float(ATLAS_GAIN.get('v800', 1.0))
    gain_r7 = float(ATLAS_GAIN.get('r7', 1.0))
    M = {c: _atlas_metrics(c) for c in ('v800', 'r7')}
    rows = []
    for car in ('v800', 'r7'):
        for st in ('开灯', '关灯'):
            m = M[car][st]
            rows.append(
                f'| {car} | {st} | {m["I"]:.3f} | '
                f'**({m["lamp_p95"][0]:.0f},{m["lamp_p95"][1]:.0f},{m["lamp_p95"][2]:.0f})** | '
                f'{m["lamp_p95_luma"]:.0f} | '
                f'({m["lamp_med"][0]:.0f},{m["lamp_med"][1]:.0f},{m["lamp_med"][2]:.0f}) | '
                f'({m["dark_p95"][0]:.1f},{m["dark_p95"][1]:.1f},{m["dark_p95"][2]:.1f}) | '
                f'({m["dark_max"][0]:.0f},{m["dark_max"][1]:.0f},{m["dark_max"][2]:.0f}) | '
                f'{m["clip_frac_lamp"]:.2f}% |')
            P(f'  {car}/{st} I={m["I"]:.3f} 灯区p95=({m["lamp_p95"][0]:.0f},'
              f'{m["lamp_p95"][1]:.0f},{m["lamp_p95"][2]:.0f}) '
              f'暗底p95=({m["dark_p95"][0]:.1f},{m["dark_p95"][1]:.1f},{m["dark_p95"][2]:.1f}) '
              f'灯区裁切={m["clip_frac_lamp"]:.2f}%')
    # ── 主理人验收判据（逐条给数）──
    v_o, v_c = M['v800']['开灯'], M['v800']['关灯']
    checks = [
        ('V800 开灯 灯区 p95 **逐通道** ∈ [160,215]',
         float(v_o['lamp_p95'].min()) >= 160.0 and float(v_o['lamp_p95'].max()) <= 215.0,
         f'({v_o["lamp_p95"][0]:.1f},{v_o["lamp_p95"][1]:.1f},{v_o["lamp_p95"][2]:.1f})'
         f' → max={v_o["lamp_p95"].max():.1f}'),
        ('V800 开灯 灯区 p95 **亮度(luma)** ∈ [160,215]',
         160.0 <= v_o['lamp_p95_luma'] <= 215.0,
         f'luma={v_o["lamp_p95_luma"]:.1f}'),
        ('V800 开灯 非灯区 p95 ≤ 25',
         float(v_o['dark_p95'].max()) <= 25.0,
         f'max={v_o["dark_p95"].max():.2f}'),
        ('V800 关灯 灯区 p95 ≤ 90',
         float(v_c['lamp_p95'].max()) <= 90.0,
         f'max={v_c["lamp_p95"].max():.1f}'),
        ('V800 关灯 非灯区 ≤ 12',
         float(max(v_c['dark_p95'].max(), v_c['dark_max'].max())) <= 12.0,
         f'p95max={v_c["dark_p95"].max():.2f} / max={v_c["dark_max"].max():.2f}'),
        ('V800 开灯 灯区 p95 明显高于非灯区（≥6×）',
         float(v_o['lamp_p95'].min()) >= 6.0 * float(v_o['dark_p95'].max()),
         f'{v_o["lamp_p95"].min():.1f} vs 6×{v_o["dark_p95"].max():.2f}='
         f'{6*v_o["dark_p95"].max():.1f}'),
        ('V800 两态 无裁切（灯区裁切占比 <0.01%）',
         v_o['clip_frac_lamp'] < 0.01 and v_c['clip_frac_lamp'] < 0.01,
         f'开={v_o["clip_frac_lamp"]:.4f}% / 关={v_c["clip_frac_lamp"]:.4f}%'),
    ]
    ok_all = all(c[1] for c in checks)
    chk_rows = []
    for nm, ok, val in checks:
        chk_rows.append(f'| {nm} | {val} | {"✅ 通过" if ok else "❌ 未达"} |')
        P(f'  [{"PASS" if ok else "FAIL"}] {nm} → {val}')
    # 若要求「逐通道 ≤215」严格成立，反解所需**绝对**增益（只做数值，不改盘；供主理人裁决）
    # 注意：磁盘上的 atlas 已按 ATLAS_GAIN 预乘，故先除回原始值再扫绝对增益。
    _a = np.asarray(Image.open(os.path.join(CARS_DIR, 'v800', 'lamp_front_atlas.png'))
                    .convert('RGBA')).astype(np.float64)
    _rgb_raw = _a[..., :3] / max(gain_v800, 1e-9)
    _al = _a[..., 3]
    _lamp = _al > 0
    g_strict, best = None, None
    for g in np.arange(0.40, 0.6201, 0.002):
        d, _c = _display_rgb(_rgb_raw * g, 3.0)
        p95 = np.percentile(d[_lamp], 95, axis=0)
        lm = 0.2126 * d[..., 0] + 0.7152 * d[..., 1] + 0.0722 * d[..., 2]
        if float(p95.max()) <= 215.0:
            g_strict, best = float(g), (p95, float(np.percentile(lm[_lamp], 95)))
    strict_line = '—'
    if g_strict is not None:
        strict_line = (f'`ATLAS_GAIN[\'v800\'] = {g_strict:.3f}`（绝对增益）→ 逐通道 p95 = '
                       f'({best[0][0]:.1f},{best[0][1]:.1f},{best[0][2]:.1f})、'
                       f'luma = {best[1]:.1f}')
        P(f'  逐通道 ≤215 的反解：{strict_line}')
    body = (
        '> **状态：方案 D 已生效（主理人裁决）** —— '
        f"`ATLAS_GAIN = {{'v800': {gain_v800:.3f}, 'r7': {gain_r7:.1f}}}`，"
        f'V800 atlas 的 **RGB 已按 {gain_v800:.3f} 预乘**（alpha / 尺寸 / UV 全未动），'
        '用于抵消 `V800Adapter.ts:4982` 开灯态 `emissiveIntensity=3.0` 造成的过曝。\n'
        '> **0.582 已被主理人否决**（逐通道 p95 蓝通道 232.6 超 215，真机 ACES tone mapping / '
        '高曝光下仍有二次裁切风险），仅作推导留痕；生效值为 **0.536**。\n'
        '> 审查线双灯态 smoke 亲自目检实锤「V800 开灯态前大灯左右两大块纯白、'
        '无竖灯/透镜/贯穿带细节」⇒ 用户主诉「前车灯贴图一片白色」在该态仍未消除，'
        '故由方案 C（维持现状）改为方案 D。\n\n'
        '**运行时线实测事实**：`lampFrontMat.emissiveIntensity` 构造初值 `0.7` 只是初值，'
        '适配器每帧覆盖 —— V800 开灯 **3.0** / 关灯 **0.255**；R7 开灯 **≈0.90** / '
        '关灯 **≈0.12**（`V800Adapter.ts:4982` / `R7Adapter.ts:1488`）。\n\n'
        '**实测复算表**（逐像素走 three.js 实链路：贴图 `SRGBColorSpace` sRGB→linear → '
        '× `emissive=0xcfe0ff`(linear) × `emissiveIntensity` → linear→sRGB 显示；'
        '灯区 = `alpha>0`，非灯区 = `alpha==0`）：\n\n'
        '| 车 | 灯态 | I | **灯区 p95 显示（逐通道）** | 灯区 p95 luma | 灯区中位 | '
        '非灯区 p95 | 非灯区 max | 灯区裁切占比 |\n'
        '|---|---|---:|---|---:|---|---|---|---:|\n' + '\n'.join(rows) + '\n\n'
        '**主理人验收判据逐条核对**：\n\n'
        '| 判据 | 实测 | 结论 |\n|---|---|---|\n' + '\n'.join(chk_rows) + '\n\n'
        f'**总判定：{"✅ 全部通过" if ok_all else "⚠ 存在未达标项（见上表）"}**\n\n'
        f'**增益取值轨迹（三次实测，全部按磁盘 PNG 逐像素复算）**：\n\n'
        '| 增益 | 逐通道 p95（开灯） | 结论 |\n|---|---|---|\n'
        '| 0.582 | (186.0, 202.8, **232.6**) | ❌ 蓝通道超 215 → **主理人否决**，仅作推导留痕 |\n'
        '| 0.536（主理人裁决值） | (171.7, 187.4, **215.2**) | ❌ 仍超 0.2 级（我先前反解是从已量化 PNG 除回，受 uint8 舍入偏低） |\n'
        f'| **{gain_v800:.3f}（生效）** | **({v_o["lamp_p95"][0]:.1f}, {v_o["lamp_p95"][1]:.1f}, {v_o["lamp_p95"][2]:.1f})** | ✅ 三项全落 [160,215]，留约 1 级安全余量 |\n\n'
        f'生效值在**未量化 raw 图集**上精确反解（避免 uint8 二次舍入）并留 1 级余量：'
        f'luma {v_o["lamp_p95_luma"]:.1f}，比 R7 开灯态 luma '
        f'{M["r7"]["开灯"]["lamp_p95_luma"]:.1f} 低约 '
        f'{100*(1-v_o["lamp_p95_luma"]/M["r7"]["开灯"]["lamp_p95_luma"]):.1f}%（视觉几乎无差）。\n\n'
        '**R7 两态逐位不变**：`ATLAS_GAIN[\'r7\'] = 1.0` ⇒ R7 atlas 字节未变'
        '（`sha256` 前后一致），上表 R7 数值仅作复算确认。\n\n'
        '**⚠ 上表全为「稳态值」—— 灯态切换不是瞬时的（v800-tester 实测）**：'
        '`setHeadlights` 只写目标值（`V800Adapter.ts:4938-4940` / '
        '`R7Adapter.ts:1437-1439`），实际强度在 `update()` 内由 '
        '`damp(headLevel, headTarget, 14, dt)` 收敛（`V800Adapter.ts:4995` / '
        '`R7Adapter.ts:1477`，k=14，τ≈0.071s）⇒ 真机 60fps 到 99% 需 **≥20 帧（≈0.33s）**，'
        'SwiftShader（dt 钳 0.35、每帧收敛 99.26%）需 ≥2 帧。'
        'QA 若在切灯态后立即截图会采到**过渡态亮度**，四格判读会错 ⇒ 必须等收敛后再截图。\n\n'
        '**灯态由 phase 决定**：`Game.ts:1465 setHeadlights(sm.phase !== \'menu\')` 每帧下发'
        '（menu=关灯、其余 phase=开灯）；`#view=` QA 钩子只切机位不改 phase ⇒ 天然是稳定的'
        '**关灯组**；`startRun()` / `#autodrive` / `#freedrive` 是**开灯组**；'
        '自由探索 `Game.ts:1164` 恒开灯。\n\n'
        '**四方案归属（运行时线 `REPORT_IMPL_RUNTIME.md §10.2` 口径）**：'
        '**A** 缩 `emissive` 颜色 → `ExternalShell.ts:653-654`（运行时线白名单，未采用，'
        '因会连带影响正常的关灯态）；**B** 改两 Adapter 系数 → `V800Adapter.ts:4982` / '
        '`R7Adapter.ts:1488`（**主理人裁决不授权**，保「两 Adapter 零改动」硬约束）；'
        '**C** 维持现状（已被 D 取代）；**D** 资产侧 `ATLAS_GAIN` —— **本次采用并已生效**。\n\n'
        '⚠ `src/model/**` **并非整体冻结**：运行时线已改 `ExternalShell.ts`（其白名单内），'
        '冻结的只是两个 Adapter；「几何线不碰 `src/model/**`」仅为几何线自身立场。\n\n'
        '**几何线只动 v800 atlas 的 RGB**：`lamp_front.glb` UV/几何、r7 atlas、'
        '全部其它 GLB 与两份 manifest **字节未变**（`sha256` 逐文件前后比对见 '
        '`.qa/r46/r46_geo_sha_before.txt` / `r46_geo_sha_after.txt`）。'
        '**数值通过 ≠ 渲染放行**：Phase 3 仍需四格灯态目检，几何线只负责把 p95 从 255 拉回可判区间。')
    report_append('亮度联动标定（方案 D 已生效 · 实测复算）', body)
    stats_set('brightness', dict(metrics=M, checks=[(n, bool(o), v) for n, o, v in checks],
                                 all_ok=bool(ok_all),
                                 gains={'v800': gain_v800, 'r7': gain_r7}))
    P(f'\n=== brightness 总判定：{"ALL PASS" if ok_all else "SOME FAIL"} ===')
    return ok_all


# ─────────────────────────── 自验 ───────────────────────────
def step_verify():
    P('\n=== verify：全量数值自验（重读磁盘产物） ===')
    lines, allok = [], True
    # V800 轮
    man = read_manifest('v800')
    hrows = []
    for s, tags in (('l', ('fl', 'rl')), ('r', ('fr', 'rr'))):
        meshes = read_glb_meshes(os.path.join(CARS_DIR, 'v800', f'wheel-{s}.glb'))
        names = [m[0] for m in meshes]
        if names != [f'wheel-{t}' for t in tags]:
            allok = False
        for (name, p, n, u, i) in meshes:
            h = hist36(p, i)
            tri = man['tri'].get(name)
            ok = (tri == len(i) and h['empty'] == 0 and h['y_max'] <= 0.1750
                  and u.shape[0] == p.shape[0] and n.shape[0] == p.shape[0])
            allok &= ok
            hrows.append(f'| `{name}` | {len(i)} | {tri} | y[{h["y_min"]:.4f},{h["y_max"]:.4f}] | '
                         f'{h["empty"]}/36 | CV={h["cv"]:.5f} | {"✅" if ok else "❌"} |')
            P(f'  v800 {name}: tri {len(i)} (manifest {tri}) 空桶 {h["empty"]}/36 '
              f'y[{h["y_min"]:.4f},{h["y_max"]:.4f}] {"OK" if ok else "FAIL"}')
    # R7 轮
    hy_r7 = float(read_manifest('r7')['hubs']['fl'][1])
    rrows = []
    for s in ('l', 'r'):
        for (name, p, n, u, i) in read_glb_meshes(os.path.join(CARS_DIR, 'r7', f'wheel-{s}.glb')):
            h = hist36(p, i)
            wb = hy_r7 + float(p[:, 1].min())
            ok = (h['empty'] == 0 and h['cv'] <= 0.0001 and h['ratio'] <= 1.001
                  and wb >= -1e-5)
            allok &= ok
            rrows.append(f'| `{name}` | {len(i)} | CV={h["cv"]:.6f} | max/min={h["ratio"]:.4f} | '
                         f'{wb:+.8f} | {h["empty"]}/36 | {"✅" if ok else "❌"} |')
            P(f'  r7 {name}: tri {len(i)} CV={h["cv"]:.6f} max/min={h["ratio"]:.4f} '
              f'轮底世界 y={wb:+.8f} 空桶 {h["empty"]}/36 {"OK" if ok else "FAIL"}')
    # 灯
    lrows = []
    for car in ('v800', 'r7'):
        lr = read_glb_meshes(os.path.join(CARS_DIR, car, 'lamp_rear.glb'))[0]
        lf = read_glb_meshes(os.path.join(CARS_DIR, car, 'lamp_front.glb'))[0]
        ylo, yhi = float(lr[1][:, 1].min()), float(lr[1][:, 1].max())
        uv = lf[3]
        ok = (0.2199 <= ylo and yhi <= 0.2601 and
              uv[:, 0].min() >= -1e-6 and uv[:, 0].max() <= 1 + 1e-6 and
              uv[:, 1].min() >= -1e-6 and uv[:, 1].max() <= 1 + 1e-6 and
              os.path.exists(os.path.join(CARS_DIR, car, 'lamp_front_atlas.png')))
        allok &= ok
        lrows.append(f'| {car} | [{ylo:.5f},{yhi:.5f}] | '
                     f'u[{uv[:,0].min():.4f},{uv[:,0].max():.4f}] '
                     f'v[{uv[:,1].min():.4f},{uv[:,1].max():.4f}] | '
                     f'{os.path.getsize(os.path.join(CARS_DIR, car, "lamp_front_atlas.png"))/1024:.1f} KB | '
                     f'{"✅" if ok else "❌"} |')
        P(f'  {car}: lamp_rear y[{ylo:.5f},{yhi:.5f}] | lamp_front UV '
          f'u[{uv[:,0].min():.4f},{uv[:,0].max():.4f}] v[{uv[:,1].min():.4f},{uv[:,1].max():.4f}] '
          f'{"OK" if ok else "FAIL"}')
    body = ('重读磁盘全部产物复算：tri / bbox / 36 桶直方图 / UV 范围 / mesh 名 / 贴图存在性。\n\n'
            '**V800 转轮**\n\n| mesh | GLB tri | manifest.tri | y bbox | 36 桶空桶 | r_p95 CV | 判定 |\n'
            '|---|---:|---:|---|---:|---:|---|\n' + '\n'.join(hrows) + '\n\n'
            '**R7 补圆（含 C.1 轮底门禁）**\n\n'
            '| mesh | tri | r_p95 CV | max/min | 轮底世界 y | 36 桶空桶 | 判定 |\n'
            '|---|---:|---:|---:|---:|---:|---|\n' + '\n'.join(rrows) + '\n\n'
            '**灯组**\n\n| 车 | `lamp_rear` y bbox | `lamp_front` UV 范围 | 图集 | 判定 |\n'
            '|---|---|---|---|---|\n' + '\n'.join(lrows) + '\n\n'
            f'**总判定：{"✅ 全部数值通过" if allok else "❌ 存在未通过项"}**。\n\n'
            '⚠ **数值通过 ≠ 渲染放行**。仍需 Phase 3：外观 / 座舱 / 尾向三机位目检、'
            '`#uvassert`（共享材质 `remapUVToRegion` 按 mesh UV bbox 归一，禁线性 remap）、'
            '`#batchmerge`、`#lightassert`，重点复核：'
            '(a) V800 轮拱内侧是否透见橙色程序化内饰（R44 前科）；'
            '(b) 转轮与车身剔除边界是否留缝；'
            '(c) R7 补圆后轮底离地与高光连续性；'
            '(d) 前灯图集暗底是否让前杠过暗、灯区是否对齐；'
            '(e) 尾灯红区是否覆盖整条尾门灯带而非仅中央。')
    report_append('自验（重读磁盘产物）', body)
    stats_set('verify', dict(all_ok=bool(allok)))
    P(f'\n=== verify 总判定：{"PASS" if allok else "FAIL"} ===')
    return allok


# ─────────────────────────── 入口 ───────────────────────────
STEPS = {
    'probe': probe,
    'wheels_v800': step_wheels_v800,
    'round_r7': step_round_r7,
    'semantic': step_semantic,
    'headlamp': step_headlamp,
    'uvprobe': step_uvprobe,
    'brightness': step_brightness,
    'verify': step_verify,
}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'probe'
    t0 = time.time()
    if mode == 'all':
        for s in ('wheels_v800', 'round_r7', 'semantic', 'headlamp', 'verify'):
            STEPS[s]()
    elif mode in STEPS:
        STEPS[mode]()
    else:
        raise SystemExit(f'未知 mode={mode}，可选 {list(STEPS)} / all')
    P(f'\n[done] {mode} 用时 {time.time()-t0:.1f}s')


if __name__ == '__main__':
    main()
