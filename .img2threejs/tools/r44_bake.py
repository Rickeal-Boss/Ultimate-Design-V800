# -*- coding: utf-8 -*-
"""R44: 车模外观 GLB 资产化烘焙管线（一次性，产物进仓库 src/assets/cars/{r7|v800}/）

输入（只读）：<DESKTOP>/R7/*.glb（染色版：POSITION+NORMAL+TEXCOORD_0+indices，1 prim 1 材质）
输出：
  body.glb                       仅 POSITION/NORMAL/TEXCOORD_0+indices（已烘 node rotX90°，+Z 车头，轮底 y=0）
  wheel-l.glb / wheel-r.glb      顶点平移到轮毂原点（每文件 2 个 mesh：fl+rl / fr+rr）
  basecolor-<variant>.webp 2048²（UV 岛膨胀 + 乱码文字 inpaint）
  normal.png / mr.png 1024²（每车共享一份）
  manifest.json                  hub×4 / wheelRadius / scale / bodyBBox / 变体表 / tri 计数

关键判据（.qa/r44/BRIEF.md §一）：
  - R7 按 5 连通域拆车身+4 轮；V800 按圆柱切割（桥三角>3000 放弃切割退化静态轮）
  - 贴图必须 UV 岛膨胀（dilate）防 mip 渗色 + 乱码文字 inpaint 抹除（周边漆色填充）
  - 白色变体 = 染色版 baseColor 保亮度去色重漆合成；QA 不过则砍
用法：
  python r44_bake.py probe          # 只验证几何/hub/连通域，不写产物
  python r44_bake.py bake           # 全量烘焙
"""
import json
import struct
import sys
import os
import io
import numpy as np
from PIL import Image, ImageFilter

SRC = '<DESKTOP>/R7'
OUT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'assets', 'cars'))

# ── 车辆定义（hub 坐标 = 模型单位·rotX90 后世界系：y 上 / z 前（车头 +Z），来源 BRIEF §一 ──
CARS = {
    'v800': {
        'scale': 4.75,           # 工信部车长 5.495m / 模型长 1.1569
        'geo_glb': 'V黑浅.glb',   # 几何与 UV 真源（染色版）
        # hub：实测修正（BRIEF §一 的 hub y≈0.078 源自 r44_v800_wheels.py 圆柱拟合缺陷；
        # 真值 = 被圆柱捕获的轮胎 bbox 中心，轮底 y=0 与轮顶 y≈0.172 的中点，自转轴必须取它）
        'hub_from_brief': {
            'fl': (0.1789, 0.0860, 0.3655),
            'fr': (-0.1833, 0.0870, 0.3650),
            'rl': (0.1821, 0.0867, -0.3351),
            'rr': (-0.1869, 0.0875, -0.3352),
        },
        'tire_half_width': 0.067 / 2,
        'r_cut': 0.095,
        'variants': {  # id -> (源 glb, 白化?)
            'white': ('V浅.glb', True),
            'black': ('V黑浅.glb', False),
            'gold': ('V浅.glb', False),
        },
        # 乱码文字矩形（4096 坐标，Vision 定位 + 全分辨率 crop 复核，紧贴字形口径）
        'inpaint_4096': [
            # (x0,y0,x1,y1,mode) 紧贴字形口径；mode 'h'=左右环带 / 'v'=上下环带
            (2204, 264, 2241, 446, 'h'),   # 顶部车牌竖排乱码 '820.-S-S3'（白牌面，左右白边距）
            (1836, 3658, 2033, 3710, 'h'), # 底部车牌 '823.NMO8'（右端字形外溢，扩到 2033）
            (2203, 2078, 2242, 2247, 'v'), # B 柱竖排小字 'MAEXTRO'（柱面深色，上下干净）
            (2953, 3413, 3017, 3432, 'h'), # 尾灯区小字
            (1600, 1443, 1684, 1526, 'h'), # 盾徽圆环小字
        ],
    },
    'r7': {
        'scale': 4.323,          # 轮半径=0.38m 定标
        'geo_glb': '紫.glb',
        # hub：R7白.glb 5 连通域 bbox 中心拟合（x=(xmin+xmax)/2, y=半径, z=(zmin+zmax)/2），与 BRIEF §一 一致
        'hub_from_brief': {
            'fl': (0.2055, 0.0879, 0.3376),
            'fr': (-0.2055, 0.0879, 0.3376),
            'rl': (0.2055, 0.0879, -0.3442),
            'rr': (-0.2055, 0.0879, -0.3442),
        },
        'tire_half_width': 0.0335,
        'r_cut': 0.096,
        'variants': {
            'white': ('绿.glb', True),
            'purple': ('紫.glb', False),
            'green': ('绿.glb', False),
        },
        # R7：右侧竖排数字 '3200886360' + 左下小牌 + 圆徽内小字
        'inpaint_4096': [
            (3108, 852, 3172, 1058, 'h'),  # 右侧竖排数字 '3200886360'
            (42, 3858, 228, 3922, 'h'),    # 左下小牌
            (2604, 0, 2676, 92, 'h'),      # 圆徽内小字（上缘外溢，扩到 y0=0）
        ],
    },
}

# ─────────────────────────── GLB 解析 ───────────────────────────
def parse_glb(path):
    with open(path, 'rb') as f:
        data = f.read()
    assert data[:4] == b'glTF', path
    off = 12
    gltf, binc = None, None
    while off + 8 <= len(data):
        clen, ctype = struct.unpack('<II', data[off:off + 8])
        body = data[off + 8:off + 8 + clen]
        if ctype == 0x4E4F534A:
            gltf = json.loads(body.decode('utf-8'))
        elif ctype == 0x004E4942:
            binc = body
        off += 8 + clen + (clen & 3)
    return gltf, binc


COMP_TYPE = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_accessor(gltf, binc, idx):
    acc = gltf['accessors'][idx]
    bv = gltf['bufferViews'][acc['bufferView']]
    off = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    fmt, sz = COMP_TYPE[acc['componentType']]
    n = NCOMP[acc['type']]
    out = np.frombuffer(binc, dtype=np.dtype(fmt), count=acc['count'] * n, offset=off)
    return out.reshape(acc['count'], n)


def load_car_glb(path):
    """返回 (pos_world, normal_world, uv, indices)，已烘 node rotX(90°)。"""
    gltf, binc = parse_glb(path)
    node = gltf['nodes'][gltf['scenes'][0]['nodes'][0]]
    q = node.get('rotation', [0, 0, 0, 1])
    ident = all(abs(v) < 1e-6 for v in q[:3]) and abs(q[3] - 1) < 1e-6
    sign = 0
    if not ident:
        # 只处理本资产的 rotX(±90°)（q=(±0.7071,0,0,±0.7071)），其余报错人工确认
        assert abs(abs(q[0]) - 0.7071) < 1e-3 and abs(q[1]) < 1e-6 and abs(q[2]) < 1e-6, f'未预期的 node 旋转 {q}'
        sign = 1.0 if q[0] * q[3] > 0 else -1.0  # +90°: (x,y,z)->(x,-z,y)   -90°: (x,z,-y)
    prim = gltf['meshes'][0]['primitives'][0]
    pos = read_accessor(gltf, binc, prim['attributes']['POSITION']).astype(np.float64)
    nrm = (read_accessor(gltf, binc, prim['attributes']['NORMAL']).astype(np.float64)
           if 'NORMAL' in prim['attributes'] else None)
    uv = (read_accessor(gltf, binc, prim["attributes"]["TEXCOORD_0"]).astype(np.float64)
           if "TEXCOORD_0" in prim["attributes"] else None)
    idxacc = gltf['accessors'][prim['indices']]
    indices = read_accessor(gltf, binc, prim['indices']).reshape(-1, 3).astype(np.int64)
    # 绕序修正：源资产三角形绕序不一致（V800 整体 CW、R7 混合；顶点法线 97% 外向
    # = 法线本身正确）。glTF/three FrontSide=CCW ⇒ 绕序错的三角形从外面看被背面
    # 剔除（实测外观壳「隐形只剩内饰」）。修法：逐三角用「绕序面法线 × 平均顶点
    # 法线」判向，<0 者交换两端点 ⇒ 全部面绕序与法线（外向）一致 = CCW 外向。
    if nrm is not None:
        fn = np.cross(pos[indices[:, 1]] - pos[indices[:, 0]], pos[indices[:, 2]] - pos[indices[:, 0]])
        nn = nrm[indices].mean(1)
        flip = np.einsum('ij,ij->i', fn, nn) < 0
        indices[flip] = indices[flip][:, ::-1]
        n_flipped = int(flip.sum())
        print(f'  绕序修正: {n_flipped}/{len(indices)} 三角翻转（与外向法线对齐）')
    x, y, z = pos[:, 0], pos[:, 1], pos[:, 2]
    if sign > 0:
        pos = np.stack([x, -z, y], 1)
        if nrm is not None:
            nx, ny, nz = nrm[:, 0], nrm[:, 1], nrm[:, 2]
            nrm = np.stack([nx, -nz, ny], 1)
    elif sign < 0:
        pos = np.stack([x, z, -y], 1)
        if nrm is not None:
            nx, ny, nz = nrm[:, 0], nrm[:, 1], nrm[:, 2]
            nrm = np.stack([nx, nz, -ny], 1)
    return pos, nrm, uv, indices


# ─────────────────────────── 连通域（R7 拆轮）───────────────────────────
def connected_components(nv, indices):
    """Shiloach-Vishkin 风格指针跳跃，返回 label[nv]（每个顶点的分量根）。"""
    label = np.arange(nv, dtype=np.int64)
    eu = np.concatenate([indices[:, 0], indices[:, 1], indices[:, 2]])
    ev = np.concatenate([indices[:, 1], indices[:, 2], indices[:, 0]])
    while True:
        lu = label[eu]
        lv = label[ev]
        lo = np.minimum(lu, lv)
        np.minimum.at(label, lu, lo)
        np.minimum.at(label, lv, lo)
        while True:
            nl = label[label]
            if np.array_equal(nl, label):
                break
            label = nl
        if np.array_equal(label[eu], label[ev]):
            break
    return label


def fit_hub(pos):
    """轮壳连通域 → (hub, r_out)。hub=(cx, cy, cz)，cy/cz 圆拟合、cx 中位。"""
    xm = np.median(pos[:, 0])
    sel = pos[np.abs(pos[:, 0] - xm) < 0.05]
    cz, cy = sel[:, 2].mean(), sel[:, 1].mean()
    for _ in range(8):
        r = np.sqrt((sel[:, 2] - cz) ** 2 + (sel[:, 1] - cy) ** 2)
        keep = np.abs(r - np.median(r)) < 0.04
        k = sel[keep]
        cz, cy = k[:, 2].mean(), k[:, 1].mean()
    r = np.sqrt((sel[:, 2] - cz) ** 2 + (sel[:, 1] - cy) ** 2)
    return (float(xm), float(cy), float(cz)), float(np.percentile(r, 98))


# ──────────────────── R44 第五轮：UV 岛语义重定向 + 漆面去噪 ────────────────────
def texel_island_labels(mask):
    """4-连通 texel 连通域标签（指针跳跃），背景(-1)。"""
    H, W = mask.shape
    flat = mask.reshape(-1)
    lab = np.where(flat, np.arange(H * W), -1)
    # 4-邻接边（右、下）
    idx = np.arange(H * W)
    right = idx % W < W - 1
    down = idx < H * W - W
    eu = np.concatenate([idx[right], idx[down]])
    ev = np.concatenate([idx[right] + 1, idx[down] + W])
    keep = flat[eu] & flat[ev]
    eu, ev = eu[keep], ev[keep]
    for _ in range(64):
        lu, lv = lab[eu], lab[ev]
        lo = np.minimum(lu, lv)
        np.minimum.at(lab, eu, lo)
        np.minimum.at(lab, ev, lo)
        nl = lab[lab]
        if np.array_equal(nl, lab):
            break
        lab = nl
        lu, lv = lab[eu], lab[ev]
        lo = np.minimum(lu, lv)
        np.minimum.at(lab, eu, lo)
        np.minimum.at(lab, ev, lo)
    return lab.reshape(H, W)


def redirect_copper_islands(car, body, hubs, cfg, baked_ref):
    """R44 第五轮 P0：红铜色串味岛重定向。
    源图集语义错位的侧裙/轮拱衬里岛（平均色落铜/橙色相、且位于车身中前部
    非尾灯区）整体 UV 重定向到深色区。尾灯岛（世界 z 在车尾）白名单保留。"""
    from PIL import Image as _Image
    pos_b, nrm_b, uv_b, idx_b, used_b = body
    mask2048 = build_uv_mask(uv_b, idx_b, 2048)
    lab = texel_island_labels(mask2048)
    baked = np.asarray(_Image.open(baked_ref).convert('RGB')).astype(np.float64)
    S = baked.shape[0]
    # 岛统计：面积 + 平均色
    flat_lab = lab.reshape(-1)
    valid = flat_lab >= 0
    ids = flat_lab[valid]
    cols = baked.reshape(-1, 3)[valid]
    order = np.argsort(ids)
    ids_s, cols_s = ids[order], cols[order]
    bounds = np.where(np.diff(ids_s) != 0)[0] + 1
    starts = np.concatenate([[0], bounds])
    ends = np.concatenate([bounds, [len(ids_s)]])
    n_island = len(starts)
    # 顶点 → texel → 岛
    vi = np.clip((uv_b * S).astype(int), 0, S - 1)
    vert_island = lab[vi[:, 1], vi[:, 0]]
    # 每岛的世界 z 中位（尾灯白名单用）
    island_z = {}
    island_area = np.zeros(n_island)
    island_col = np.zeros((n_island, 3))
    for k in range(n_island):
        lid = ids_s[starts[k]]
        island_area[k] = ends[k] - starts[k]
        seg = cols_s[starts[k]:ends[k]]
        # p80 分位数（铜色编织纹理暗底亮纹，均值会被暗纹稀释）
        island_col[k] = np.percentile(seg, 80, axis=0)
        sel = vert_island == lid
        if sel.any():
            island_z[lid] = float(np.median(pos_b[sel, 2]))
    # 铜色判据：均值 R>85、R−B>25；面积 ≥64 texel；排除车尾（z < -0.42，尾灯区）
    scale = cfg['scale']
    redirect_verts = []
    n_isl = 0
    for k in range(n_island):
        if island_area[k] < 64:
            continue
        r, g, b = island_col[k]
        if not (r > 100 and r - b > 35):
            continue
        lid = ids_s[starts[k]]
        z = island_z.get(lid)
        if z is not None and z * scale < -1.9:  # 车尾 z(m) — 尾灯语义区保留
            continue
        sel = (vert_island == lid) & used_b
        redirect_verts.append(np.where(sel)[0])
        n_isl += 1
    if redirect_verts:
        allv = np.unique(np.concatenate(redirect_verts))
        # 深色目标：override npz 的 tgt（涂黑 rect 中心）或黑漆区固定点
        ov_path = os.path.join(OUT_ROOT, '..', '..', '..', '..', '.qa', 'r44_car', 'masks', f'{car}_uv_override.npz')
        if os.path.exists(ov_path):
            tgt = np.load(ov_path)['uv'][0]
        else:
            tgt = np.array([0.439, 0.542])
        uv_b[allv] = tgt
        print(f'[{car}] 铜色串味岛重定向：{n_isl} 岛 / {len(allv)} 顶点 → 深色区 ({tgt[0]:.3f},{tgt[1]:.3f})')
    else:
        print(f'[{car}] 铜色串味岛未检出')


def denoise_paint(img_f32, ksize=5):
    """R44 第五轮 P0：漆面 weathering 噪点抑制 —— 低饱和 texel（漆/黑塑料）做
    ksize 中值滤波去白锈斑，饱和区（尾灯/徽标/彩条）保持原样。"""
    from scipy import ndimage as _nd  # noqa: 不可用则退化为 PIL
    raise RuntimeError('use pil path')


def denoise_paint_pil(img_f32, ksize=9):
    from PIL import ImageFilter
    im = Image.fromarray(np.clip(img_f32, 0, 255).astype(np.uint8))
    med = np.asarray(im.filter(ImageFilter.MedianFilter(ksize)), np.float64)
    mx = img_f32.max(2)
    mn = img_f32.min(2)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0)
    m = sat < 0.22
    n = int(m.sum())
    img_f32[m] = med[m]
    return n


# ─────────────────────────── GLB 写出 ───────────────────────────
def pad4(n):
    return (n + 3) & ~3


def build_glb(meshes):
    """meshes: [(name, pos_f32(N,3), nrm_f32(N,3), uv_f32(N,2), idx_u32(M,3))] → GLB bytes。
    单节点扁平树；无材质无图片。"""
    blob = bytearray()
    accessors, buffer_views, meshes_json, nodes_json = [], [], [], []
    off = 0

    def add_view(arr, target=None):
        nonlocal off
        b = arr.tobytes()
        pad = pad4(len(b)) - len(b)
        if pad:
            b += b'\0' * pad
        buffer_views.append({'buffer': 0, 'byteOffset': off, 'byteLength': len(b)})
        blob.extend(b)
        off += len(b)
        return len(buffer_views) - 1

    for name, pos, nrm, uv, idx in meshes:
        pv = add_view(pos)
        nv = add_view(nrm)
        tv = add_view(uv)
        iv = add_view(idx)
        n = len(pos)
        accessors.append({'bufferView': pv, 'componentType': 5126, 'count': n, 'type': 'VEC3',
                          'min': pos.min(0).astype(float).tolist(), 'max': pos.max(0).astype(float).tolist()})
        accessors.append({'bufferView': nv, 'componentType': 5126, 'count': n, 'type': 'VEC3'})
        accessors.append({'bufferView': tv, 'componentType': 5126, 'count': n, 'type': 'VEC2'})
        accessors.append({'bufferView': iv, 'componentType': 5125, 'count': int(idx.size), 'type': 'SCALAR'})
        ni = len(accessors) - 1
        meshes_json.append({'name': name, 'primitives': [{'attributes': {'POSITION': ni - 3, 'NORMAL': ni - 2, 'TEXCOORD_0': ni - 1}, 'indices': ni, 'mode': 4}]})
        nodes_json.append({'name': name, 'mesh': len(meshes_json) - 1})
    while off % 4:
        blob.append(0)
        off += 1
    gltf = {
        'asset': {'version': '2.0', 'generator': 'r44_bake'},
        'scene': 0,
        'scenes': [{'nodes': list(range(len(nodes_json)))}],
        'nodes': nodes_json,
        'meshes': meshes_json,
        'accessors': accessors,
        'bufferViews': buffer_views,
        'buffers': [{'byteLength': len(blob)}],
    }
    js = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    while len(js) % 4:
        js += b' '
    out = b'glTF' + struct.pack('<II', 2, 12 + 8 + len(js) + 8 + len(blob))
    out += struct.pack('<II', len(js), 0x4E4F534A) + js
    out += struct.pack('<II', len(blob), 0x004E4942) + bytes(blob)
    return out


# ─────────────────────────── 贴图处理 ───────────────────────────
def build_uv_mask(uv, indices, size, verts_extra=None):
    """UV 三角形光栅出「已用 texel」掩码（偏欠采样：欠采的岛内洞由膨胀用同岛色回填，安全；
    过采会把 padding 噪点留成渗色源，故宁欠勿过）。"""
    H = W = size
    mask = np.zeros((H, W), bool)
    u = uv[:, 0] * W
    v = uv[:, 1] * H  # glTF: v 向下（图像行号）→ PIL 数组行号一致
    # 1) 顶点 splat（±1px）
    xi = np.clip(np.round(u).astype(np.int64), 0, W - 1)
    yi = np.clip(np.round(v).astype(np.int64), 0, H - 1)
    mask[yi, xi] = True
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            mask[np.clip(yi + dy, 0, H - 1), np.clip(xi + dx, 0, W - 1)] = True
    # 2) 每三角形：质心 + 3 边中点；大三角形按 4px 步长加密
    p0 = np.stack([u[indices[:, 0]], v[indices[:, 0]]], 1)
    p1 = np.stack([u[indices[:, 1]], v[indices[:, 1]]], 1)
    p2 = np.stack([u[indices[:, 2]], v[indices[:, 2]]], 1)
    cen = (p0 + p1 + p2) / 3
    mids = [(p0 + p1) / 2, (p1 + p2) / 2, (p2 + p0) / 2]
    base_pts = [cen, *mids]
    maxedge = np.max(np.stack([np.linalg.norm(p1 - p0, axis=1),
                               np.linalg.norm(p2 - p1, axis=1),
                               np.linalg.norm(p0 - p2, axis=1)]), 0)
    big = maxedge > 6.0
    big_idx = np.where(big)[0]

    def splat(pts):
        xi = np.clip(np.round(pts[:, 0]).astype(np.int64), 0, W - 1)
        yi = np.clip(np.round(pts[:, 1]).astype(np.int64), 0, H - 1)
        mask[yi, xi] = True

    for pts in base_pts:
        splat(pts)
    # 大三角形按 6px 步长网格加密（分块即时 splat，控内存）
    n = np.clip(np.ceil(maxedge[big_idx] / 6.0).astype(np.int64), 1, 8)
    bp0, bp1, bp2 = p0[big_idx], p1[big_idx], p2[big_idx]
    for nval in np.unique(n):
        sel = np.where(n == nval)[0]
        k = int(nval)
        i, j = np.meshgrid(np.arange(k + 1), np.arange(k + 1), indexing='ij')
        keep = (i + j) <= k
        bi = i[keep].astype(np.float64) / k
        bj = j[keep].astype(np.float64) / k
        chunk = max(1, int(2e6 // len(bi)))
        for s in range(0, len(sel), chunk):
            ss = sel[s:s + chunk]
            aa, bb, cc = bp0[ss][:, None, :], bp1[ss][:, None, :], bp2[ss][:, None, :]
            P = aa + bi[None, :, None] * (bb - aa) + bj[None, :, None] * (cc - aa)
            splat(P.reshape(-1, 2))
    return mask


def dilate_masked(img_f32, used, max_iters=28):
    """把 ~used texel 用邻近 used texel 均色回填（UV 岛膨胀）。img/used 就地修改。
    内部用 float32（2048²×3 float64 逐次分配太慢）。"""
    img = img_f32.astype(np.float32) if img_f32.dtype != np.float32 else img_f32
    H, W = used.shape
    shifts = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if (dy, dx) != (0, 0)]
    for it in range(max_iters):
        acc = np.zeros_like(img)
        cnt = np.zeros((H, W), np.int32)
        for dy, dx in shifts:
            sy = slice(max(dy, 0), H + min(dy, 0))
            sy2 = slice(max(-dy, 0), H + min(-dy, 0))
            sx = slice(max(dx, 0), W + min(dx, 0))
            sx2 = slice(max(-dx, 0), W + min(-dx, 0))
            u2 = np.zeros((H, W), bool)
            u2[sy, sx] = used[sy2, sx2]
            i2 = np.zeros_like(img)
            i2[sy, sx] = img[sy2, sx2]
            cnt += u2
            acc += i2 * u2[:, :, None]
        fill = (cnt > 0) & ~used
        if not fill.any():
            break
        img[fill] = acc[fill] / cnt[fill][:, None].astype(np.float32)
        used |= fill
    if img is not img_f32:
        img_f32[:] = img
    # 残余 texel（距任何岛 > max_iters 像素）：用**已用像素的全局中位色**填平。
    # 无限膨胀会把邻近橙/红灯岛的色相一路拖进轮拱内衬岛（QA 打回项 2 橙色串色
    # 根因）；封顶 + 中位色既保留 mip 渗色防护，又切断跨岛色相拖带。
    remain = ~used
    n_remain = int(remain.sum())
    if n_remain > 0:
        med = np.median(img[used].reshape(-1, 3), 0)
        img[remain] = med[None, :]
    return it + 1, n_remain


def inpaint_rects(img_f32, rects, neutral=None):
    """矩形区域用环带(6px)中位色填充（乱码文字抹除）。
    矩形取「紧贴字形」口径；mode 'h' 按行取左右环带（横排字/竖窄条牌面），
    'v' 按列取上下环带（竖排字在横向干净的面上）。
    neutral: 非 None 时（normal 图）用常量色填充。rects 元素支持 4 元或 5 元。"""
    H, W, _ = img_f32.shape
    rng = np.random.default_rng(7)
    for r in rects:
        x0, y0, x1, y1 = (int(r[0]), int(r[1]), int(r[2]), int(r[3]))
        mode = r[4] if len(r) > 4 else 'h'
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(W - 1, x1), min(H - 1, y1)
        if x1 <= x0 or y1 <= y0:
            continue
        if neutral is not None:
            img_f32[y0:y1 + 1, x0:x1 + 1] = neutral
            continue
        if mode == 'v':
            last = None
            for x in range(x0, x1 + 1):
                ring = np.concatenate([
                    img_f32[max(0, y0 - 6):y0, x].reshape(-1, 3),
                    img_f32[y1 + 1:min(H, y1 + 7), x].reshape(-1, 3)
                ], 0)
                if len(ring) == 0:
                    if last is not None:
                        img_f32[y0:y1 + 1, x] = last
                    continue
                c = np.median(ring, 0)
                img_f32[y0:y1 + 1, x] = c + rng.normal(0, 1.5, (y1 - y0 + 1, 3))
                last = c
        else:
            last = None
            for y in range(y0, y1 + 1):
                ring = np.concatenate([
                    img_f32[y, max(0, x0 - 6):x0].reshape(-1, 3),
                    img_f32[y, x1 + 1:min(W, x1 + 7)].reshape(-1, 3)
                ], 0)
                if len(ring) == 0:
                    if last is not None:
                        img_f32[y, x0:x1 + 1] = last
                    continue
                c = np.median(ring, 0)
                img_f32[y, x0:x1 + 1] = c + rng.normal(0, 1.5, (x1 - x0 + 1, 3))
                last = c
    return img_f32


def whiten_paint(img_f32, sat_keep=0.06):
    """漆色像素簇 → 保亮度转白。HSV 色相主簇 ±0.12、sat>0.15 判漆色。"""
    import colorsys
    arr = img_f32 / 255.0
    mx = arr.max(2)
    mn = arr.min(2)
    delta = mx - mn
    sat = np.where(mx > 1e-6, delta / np.maximum(mx, 1e-6), 0)
    # 色相（向量化）
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    hue = np.zeros_like(mx)
    m = (mx == r) & (delta > 0)
    hue[m] = ((g - b)[m] / delta[m]) % 6
    m = (mx == g) & (delta > 0)
    hue[m] = ((b - r)[m] / delta[m]) + 2
    m = (mx == b) & (delta > 0)
    hue[m] = ((r - g)[m] / delta[m]) + 4
    hue = hue / 6.0
    cand = (sat > 0.15) & (mx > 0.05) & (mx < 0.98)
    if cand.sum() < 1000:
        print('  [white] 可判漆色像素过少，放弃白化')
        return img_f32
    hh = hue[cand]
    hist, edges = np.histogram(hh, bins=72, range=(0, 1))
    h0 = (edges[np.argmax(hist)] + edges[np.argmax(hist) + 1]) / 2
    dh = np.abs(hue - h0)
    dh = np.minimum(dh, 1 - dh)
    paint = cand & (dh < 0.12)
    out = img_f32.copy()
    v = mx
    w = paint[:, :, None]
    white = (np.stack([v, v, v], 2) * (1 - sat_keep)
             + sat_keep * np.array([1.0, 0.98, 0.94])[None, None, :] * v[:, :, None])
    out[:] = out * (1 - w) + np.clip(white * 255, 0, 255) * w
    n = int(paint.sum())
    print(f'  [white] 主色相 h={h0:.3f} 漆色像素 {n} ({100.0 * n / paint.size:.1f}%) → 保亮度转白')
    return out


def process_variant(src_glb, out_dir, car, vid, whiten, mask2048, rects, size=2048, fill_rects=None, geo=None):
    gltf, binc = parse_glb(os.path.join(SRC, src_glb))
    imgs = {}
    for im in gltf['images']:
        bv = gltf['bufferViews'][im['bufferView']]
        b = binc[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
        name = im.get('name', '')
        slot = 'normal' if 'normal' in name else ('mr' if 'metallic' in name else 'basecolor')
        imgs[slot] = Image.open(io.BytesIO(b))
    base = imgs['basecolor'].convert('RGB')
    # 主尺寸管线：4096 → size（先缩，后一切；掩码/膨胀/抹字都在目标分辨率做）
    base_s = base.resize((size, size), Image.LANCZOS)
    arr = np.asarray(base_s, np.float64)
    if whiten:
        arr = whiten_paint(arr)
    used = mask2048.copy()
    # 岛缘先腐蚀 1px（LANCZOS 混入的 padding 噪声带）再膨胀回填
    er = used.copy()
    for _ in range(1):
        er[1:-1, 1:-1] = (used[1:-1, 1:-1] & used[:-2, 1:-1] & used[2:, 1:-1]
                          & used[1:-1, :-2] & used[1:-1, 2:])
    used = er
    iters, left = dilate_masked(arr, used)
    print(f'  [{car}/{vid}] basecolor 膨胀 {iters} 轮，未填 texel {left}')
    n_dn = denoise_paint_pil(arr, ksize=15)
    print(f'  [{car}/{vid}] 漆面去噪：{n_dn} 低饱和 texel 中值滤波')
    inpaint_rects(arr, [(r[0] * size / 4096, r[1] * size / 4096, r[2] * size / 4096, r[3] * size / 4096) for r in rects])
    # R44 二次打回项 2 终解：橙色内衬/织物 texel 区域直接涂黑（各变体统一深色，
    # UV 覆盖的顶点也采样到这里 —— 白变体的金色织物区不会被白化漏掉）
    if fill_rects:
        for (fx0, fy0, fx1, fy1) in fill_rects:
            sx0 = max(0, int(fx0 * size / 2048))
            sy0 = max(0, int(fy0 * size / 2048))
            sx1 = min(size - 1, int(fx1 * size / 2048))
            sy1 = min(size - 1, int(fy1 * size / 2048))
            if sx1 > sx0 and sy1 > sy0:
                region = arr[sy0:sy1 + 1, sx0:sx1 + 1]
                m = (region[:, :, 0] > 110) & (region[:, :, 0].astype(int) - region[:, :, 2] > 35)
                region[m] = (45.0, 42.0, 40.0)
        print(f'  [{car}/{vid}] 橙色区涂黑 {len(fill_rects)} rect')
    # R44 第五轮终解（烘焙内自洽）：对成品 arr 按全部 mesh 三角密集采样，凡触橙
    # texel 的三角，其 UV bbox 内橙色 texel 直接涂深色 —— 无需外部 npz，单次烘焙
    # 自洽收敛（src 资产内衬/车门岛的铜色编织纹理在白化/膨胀后仍会残留橙铜色）。
    if geo is not None:
        uv_all, tris_all = geo
        v0, v1, v2 = uv_all[tris_all[:, 0]], uv_all[tris_all[:, 1]], uv_all[tris_all[:, 2]]
        b0 = np.minimum(np.minimum(v0, v1), v2)
        b1 = np.maximum(np.maximum(v0, v1), v2)
        gx, gy = np.meshgrid(np.linspace(0, 1, 6), np.linspace(0, 1, 6), indexing='ij')
        gx, gy = gx.reshape(-1), gy.reshape(-1)
        n_orange = 0
        for s0 in range(0, len(tris_all), 60000):
            sl = slice(s0, s0 + 60000)
            P = b0[sl][:, None, :] + (b1[sl][:, None, :] - b0[sl][:, None, :]) * np.stack([gx, gy], 1)[None, :, :]
            px = np.clip((P.reshape(-1, 2) * size).astype(int), 0, size - 1)
            c = arr[px[:, 1], px[:, 0]].astype(int)
            om = (c[:, 0] > 110) & (c[:, 0] - c[:, 2] > 35)
            ot = np.where(om.reshape(-1, 36).any(1))[0]
            for t in ot:
                ti = sl.start + t
                x0 = max(0, int(b0[ti, 0] * size) - 3)
                y0 = max(0, int(b0[ti, 1] * size) - 3)
                x1 = min(size - 1, int(b1[ti, 0] * size) + 3)
                y1 = min(size - 1, int(b1[ti, 1] * size) + 3)
                region = arr[y0:y1 + 1, x0:x1 + 1]
                m = (region[:, :, 0] > 110) & (region[:, :, 0].astype(int) - region[:, :, 2] > 35)
                region[m] = (45.0, 42.0, 40.0)
            n_orange += len(ot)
        print(f'  [{car}/{vid}] 橙铜三角条件涂深：{n_orange} / {len(tris_all)}')
    out = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    fp = os.path.join(out_dir, f'basecolor-{vid}.webp')
    out.save(fp, 'WEBP', quality=85)
    print(f'  [{car}/{vid}] -> {fp} {os.path.getsize(fp) / 1e6:.2f}MB')
    return fp


def process_shared(imgs, out_dir, car, mask1024, rects):
    """normal + MR（每车共享一份，1024² PNG）：膨胀 + normal 用中性色抹字。"""
    outs = {}
    for slot, fname, neutral in (('normal', 'normal.png', (128.0, 128.0, 255.0)),
                                 ('mr', 'mr.png', None)):
        im = imgs[slot].convert('RGB').resize((1024, 1024), Image.LANCZOS)
        arr = np.asarray(im, np.float64)
        used = mask1024.copy()
        er = used.copy()
        er[1:-1, 1:-1] = (used[1:-1, 1:-1] & used[:-2, 1:-1] & used[2:, 1:-1]
                          & used[1:-1, :-2] & used[1:-1, 2:])
        iters, left = dilate_masked(arr, er)
        rects_s = [(r[0] / 4, r[1] / 4, r[2] / 4, r[3] / 4) for r in rects]
        inpaint_rects(arr, rects_s, neutral=np.array(neutral, np.float64) if neutral else None)
        fp = os.path.join(out_dir, fname)
        Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(fp, 'PNG', optimize=True)
        print(f'  [{car}/{slot}] 膨胀 {iters} 轮 -> {fp} {os.path.getsize(fp) / 1e6:.2f}MB')
        outs[slot] = fp
    return outs


# ─────────────────────────── 主流程 ───────────────────────────
def split_geometry(car, cfg):
    """圆柱切割拆轮（两车同法：染色版顶点未焊接，连通域不可用；
    R7 圆柱参数取自 R7白.glb 5 连通域拟合，见 CARS 注）。"""
    pos, nrm, uv, indices = load_car_glb(os.path.join(SRC, cfg['geo_glb']))
    nv = len(pos)
    tri_total = len(indices)
    print(f'[{car}] 几何: {nv} vtx / {tri_total} tri, bbox {pos.min(0).round(4).tolist()} .. {pos.max(0).round(4).tolist()}')
    hubs = dict(cfg['hub_from_brief'])
    hw = cfg['tire_half_width']
    rc = cfg['r_cut']
    inside = {}  # tag -> 顶点在**本**圆柱内
    for tag, (hx, hy, hz) in hubs.items():
        d = np.sqrt((pos[:, 1] - hy) ** 2 + (pos[:, 2] - hz) ** 2)
        inside[tag] = (np.abs(pos[:, 0] - hx) <= hw) & (d <= rc)
        if inside[tag].sum() == 0:
            print(f'[{car}] !! 圆柱 {tag} 命中 0 顶点 — hub/r_cut 参数错')
            return None, None, hubs, 0, tri_total
    inwheel = np.zeros(nv, bool)
    for tag in hubs:
        inwheel |= inside[tag]
    # R44 三修（二次打回项 1 根因）：纯圆柱切割把**与轮胎同 x 同径向的车门下段/
    # 门槛/轮拱内壁**一起切走挂轮 —— 车身上留下洞，透洞看到程序化内饰 = 橙色块。
    # 判别器：轮胎是 x 向厚度恰为胎宽的回转面 —— **三角 x 范围 ⊆ 胎宽板** 才是轮；
    # 跨出胎宽板的（车门板从 x0.19 延到 x0.1）一律归车身。两车同法。
    tri_x = pos[indices][:, :, 0]
    x_min = tri_x.min(1)
    x_max = tri_x.max(1)
    tri_in = np.zeros(len(indices), bool)
    for tag, (hx, hy, hz) in hubs.items():
        m = inside[tag]
        slab_ok = (x_min >= hx - hw - 0.012) & (x_max <= hx + hw + 0.012)
        tri_in |= m[indices].all(1) & slab_ok
    if car == 'v800':
        # 切割退化（BRIEF「放弃切割退化静态轮」条款）：V800白 是 1 连通域整体焊接
        # （车门下段与轮圈共享顶点），x-板判别仍有窄条车门件漏切 → 壳体洞 → 透见
        # 程序化内饰（QA 橙色块根因链的终点）。V800 采用**静态轮**：整车单 mesh，
        # 不拆轮、轮不转；R7 拆分干净（5 连通域）保留转轮。
        n_bridge = 0
        bridge_to_body = 0
        print(f'[{car}] 切割退化：整车单 mesh 静态轮（V800白 整体焊接无法干净拆分）')
        body_tris = indices
        tri_in = np.zeros(len(indices), bool)
    else:
        n_bridge = 0
        bridge_to_body = 0
        print(f'[{car}] x-板判别拆分：轮 {int(tri_in.sum())} tri / 车身 {int((~tri_in).sum())} tri')
        body_tris = indices[~tri_in]
    used_v = np.zeros(nv, bool)
    used_v[body_tris.reshape(-1)] = True
    remap = -np.ones(nv, np.int64)
    remap[used_v] = np.arange(used_v.sum())
    body = (pos, nrm, uv, remap[body_tris], used_v)
    wheels = {}
    for ti, tag in enumerate(hubs if car != 'v800' else []):
        hx, hy, hz = hubs[tag]
        own = inside[tag][indices].all(1)
        tis = indices[own]
        vsel = np.zeros(nv, bool)
        vsel[tis.reshape(-1)] = True
        wremap = -np.ones(nv, np.int64)
        wremap[vsel] = np.arange(vsel.sum())
        wheels[tag] = (pos[vsel] - np.array(hubs[tag]), nrm[vsel], uv[vsel], wremap[tis])
        # 拟合校验：轮顶点到轴 (y=hub.y,z=hub.z) 的最大距离应 ≈ 轮胎半径
        d = np.sqrt((pos[vsel, 1] - hy) ** 2 + (pos[vsel, 2] - hz) ** 2)
        print(f'[{car}] 轮 {tag}: {int(vsel.sum())} vtx / {len(tis)} tri, r_max={d.max():.4f} r_p99={np.percentile(d, 99):.4f}（hub 平移到原点）')
    return body, wheels, hubs, n_bridge, tri_total


def write_products(car, cfg, body, wheels, hubs):
    out_dir = os.path.join(OUT_ROOT, car)
    os.makedirs(out_dir, exist_ok=True)
    pos, nrm, uv, body_idx, used_v = body
    # ⚠ body_idx 是**压缩后**顶点空间（remap[used_v]=0..n-1）⇒ 顶点缓冲必须同样
    # 压缩切片（曾经把全量缓冲 + 压缩索引直接拼对 = 索引指错顶点 = 法线/UV 全乱
    # 的「crumpled foil」渲染病根）。
    pos_c, nrm_c, uv_c = pos[used_v], nrm[used_v], uv[used_v]
    body_glb = build_glb([('body', pos_c.astype(np.float32), nrm_c.astype(np.float32), uv_c.astype(np.float32), body_idx.astype(np.uint32))])
    with open(os.path.join(out_dir, 'body.glb'), 'wb') as f:
        f.write(body_glb)
    print(f'[{car}] body.glb {len(body_glb) / 1e6:.1f}MB, {len(body_idx)} tri')
    side_of = {'fl': 'l', 'rl': 'l', 'fr': 'r', 'rr': 'r'}
    order = {'fl': 0, 'fr': 1, 'rl': 2, 'rr': 3}
    tri_w = {}
    for side in ('l', 'r'):
        meshes = []
        for tag in sorted([t for t in wheels if side_of[t] == side], key=lambda t: order[t]):
            wp, wn, wu, wi = wheels[tag]
            meshes.append((f'wheel-{tag}', wp.astype(np.float32), wn.astype(np.float32), wu.astype(np.float32), wi.astype(np.uint32)))
            tri_w[tag] = len(wi)
        glb = build_glb(meshes)
        with open(os.path.join(out_dir, f'wheel-{side}.glb'), 'wb') as f:
            f.write(glb)
        print(f'[{car}] wheel-{side}.glb {len(glb) / 1e6:.1f}MB ({[m[0] for m in meshes]})')
    return tri_w


def bake_car(car, do_textures=True):
    cfg = CARS[car]
    body, wheels, hubs, bridge, tri_total = split_geometry(car, cfg)
    if body is None:
        print(f'[{car}] !! 桥三角 {bridge} > 3000，放弃切割（退化静态轮），跳过资产产出')
        return None
    # R44 二次打回项 2（成品级修正）：应用 r44_uv_fix.py 在**烘焙成品**上检测出的
    # 橙色三角顶点 UV 覆盖（膨胀拖带橙只在成品上可见，源图上没有 ⇒ 必须成品检测）。
    _ov_path = os.path.join(OUT_ROOT, '..', '..', '..', '..', '.qa', 'r44_car', 'masks', f'{car}_uv_override.npz')
    if os.path.exists(_ov_path):
        _ov = np.load(_ov_path)
        body[2][_ov['verts']] = _ov['uv']
        print(f'[{car}] 应用 UV 覆盖：{len(_ov["verts"])} 顶点（{_ov["n_tri"]} 橙色三角）→ 黑漆区')
    else:
        print(f'[{car}] 无 UV 覆盖文件（{_ov_path}），跳过成品级橙色修正')
    if 'tris' in _ov:
        # 拱内壁三角翻绕序：这些面在源资产里朝舱内（FrontSide 从外看被剔除 =
        # 视穿程序化内饰）。翻面后朝外，配合已黑化的 UV 渲染成黑色内壁。
        # 顶点法线不动（避免破坏共享邻面着色；黑色内壁着色偏差不可见）。
        _tris = _ov['tris']
        idx_b2 = body[3]
        idx_b2[_tris] = idx_b2[_tris][:, ::-1]
        print(f'[{car}] 拱内壁翻面：{_ov["n_tri"]} 三角（绕序翻转，朝外渲染黑内壁）')
    # R44 第五轮 P0：红铜串味岛重定向（基于基色变体烘焙成品做岛平均色分类）
    _ref_base = {v: os.path.join(OUT_ROOT, car, f'basecolor-{v}.webp')
                 for v in (('black', 'purple') if car == 'v800' else ('purple',)) if os.path.exists(os.path.join(OUT_ROOT, car, f'basecolor-{v}.webp'))}
    if _ref_base:
        redirect_copper_islands(car, body, hubs, cfg, list(_ref_base.values())[0])
    else:
        print(f'[{car}] 无基色烘焙成品，跳过铜色岛重定向')
    # R44 二次打回项 2（终版定罪）：轮拱橙色块 = 源资产**内衬/地板几何**（V800 实测
    # 59,747 个三角：四轮拱内衬 + 下裙/地板）的 UV 岛落在图集橙棕织物区。
    # 处置：UV 重定向到下段黑漆区采样点 —— 衬里变「黑色塑料轮拱内衬」（真车同款观感），
    # 保留几何遮蔽舱内，且各变体通用（黑漆区在白/黑/金/紫/绿下都是深色）。
    if True:  # 橙色内衬 UV 重定向块
        pos_b, nrm_b, uv_b, idx_b, used_b = body
        tri_c = (pos_b[idx_b[:, 0]] + pos_b[idx_b[:, 1]] + pos_b[idx_b[:, 2]]) / 3
        tri_uv = (uv_b[idx_b[:, 0]] + uv_b[idx_b[:, 1]] + uv_b[idx_b[:, 2]]) / 3
        from PIL import Image as _Image
        _ref_path = {v: f'.img2threejs/r44_assets/{car}_{v}_basecolor.png'
                     for v in ('black', 'purple') if os.path.exists(f'.img2threejs/r44_assets/{car}_{v}_basecolor.png')}
        if _ref_path:
            ref = np.asarray(_Image.open(list(_ref_path.values())[0]).convert('RGB'))
            px = np.clip((tri_uv * 4096).astype(int), 0, 4095)
            col = ref[px[:, 1], px[:, 0]]
            orange = (col[:, 0] > 120) & (col[:, 0].astype(int) - col[:, 2] > 50)
            # 目标：下段黑漆（世界 y<0.12 且采样亮度低）
            lum = col.astype(int).mean(1)
            dark = (tri_c[:, 1] < 0.12) & (lum < 70) & (~orange)
            if orange.sum() > 0 and dark.sum() > 50:
                tgt = np.median(tri_uv[dark], 0)
                for t in np.where(orange)[0]:
                    uv_b[idx_b[t]] = tgt
                print(f'[{car}] 橙色内衬 UV 重定向：{int(orange.sum())} 三角 → 黑漆区 UV ({tgt[0]:.3f},{tgt[1]:.3f})')
            else:
                print(f'[{car}] 橙色内衬未检出（{int(orange.sum())}）或无黑漆目标，跳过')
    # R44 二次打回项 4：R7 后视镜帽红棕色斑 = 镜帽 UV 岛落在源图集红棕内饰区。
    # 重定向：镜帽三角 UV → 车顶车漆区采样点（各变体下都是车身同色，视觉自然）。
    if car == 'r7':
        pos_b, nrm_b, uv_b, idx_b, used_b = body
        tri_c = (pos_b[idx_b[:, 0]] + pos_b[idx_b[:, 1]] + pos_b[idx_b[:, 2]]) / 3
        tri_uv = (uv_b[idx_b[:, 0]] + uv_b[idx_b[:, 1]] + uv_b[idx_b[:, 2]]) / 3
        from PIL import Image as _Image
        ref = np.asarray(_Image.open('.img2threejs/r44_assets/R7_purple_basecolor.png').convert('RGB'))
        px = np.clip((tri_uv * 4096).astype(int), 0, 4095)
        col = ref[px[:, 1], px[:, 0]]
        reddish = (col[:, 0] > 110) & (col[:, 0] - col[:, 1] > 25) & (col[:, 0] - col[:, 2] > 25)
        # 镜帽位置：前部高位（|x|>0.55, y>1.0, z<0.2）
        mir = reddish & (np.abs(tri_c[:, 0]) > 0.55) & (tri_c[:, 1] > 1.0) & (tri_c[:, 2] < 0.2)
        n_fix = int(mir.sum())
        if n_fix > 0:
            # 目标点：车顶最高处车漆三角的 UV 质心
            roof_i = int(np.argmax(tri_c[:, 1]))
            tgt = tri_uv[roof_i]
            for t in np.where(mir)[0]:
                uv_b[idx_b[t]] = tgt
            print(f'[{car}] 镜帽 UV 重定向：{n_fix} 三角 → 车顶车漆 UV ({tgt[0]:.3f},{tgt[1]:.3f})')
        else:
            print(f'[{car}] 镜帽红棕三角未检出，跳过重定向')
    # R44 终极兜底（主理人授权删除口径）：应用覆盖后**仍**采样橙色 texel 的三角
    # 直接删除（内衬/地板类非外观件；留下的孔洞藏在轮拱/车底不可见）。
    # 依赖上一轮 bake 的 basecolor-<base>.webp 存在（首次全量烘焙先跑 do_textures）。
    try:
        from PIL import Image as _Img2
        base_variant0 = next(iter(cfg['variants']))
        _bk_path = os.path.join(OUT_ROOT, car, f'basecolor-{base_variant0}.webp')
        if os.path.exists(_bk_path):
            _baked = np.asarray(_Img2.open(_bk_path).convert('RGB'))
            _S = _baked.shape[0]

            def _drop_orange(name, tri_idx, uv_arr):
                if len(tri_idx) == 0:
                    return tri_idx, 0
                v0 = uv_arr[tri_idx[:, 0]]
                v1 = uv_arr[tri_idx[:, 1]]
                v2 = uv_arr[tri_idx[:, 2]]
                b0 = np.minimum(np.minimum(v0, v1), v2)
                b1 = np.maximum(np.maximum(v0, v1), v2)
                gx, gy = np.meshgrid(np.linspace(0, 1, 6), np.linspace(0, 1, 6), indexing='ij')
                gx, gy = gx.reshape(-1), gy.reshape(-1)
                keep = np.ones(len(tri_idx), bool)
                for s0 in range(0, len(tri_idx), 60000):
                    sl = slice(s0, s0 + 60000)
                    P = b0[sl][:, None, :] + (b1[sl][:, None, :] - b0[sl][:, None, :]) * np.stack([gx, gy], 1)[None, :, :]
                    px = np.clip((P.reshape(-1, 2) * _S).astype(int), 0, _S - 1)
                    c = _baked[px[:, 1], px[:, 0]].astype(int)
                    om = (c[:, 0] > 110) & (c[:, 0] - c[:, 2] > 35)
                    keep[sl] &= ~om.reshape(-1, 36).any(1)
                n_drop = int((~keep).sum())
                print(f'[{car}] {name} 橙色三角删除：{n_drop} / {len(tri_idx)}')
                return tri_idx[keep], n_drop

            pos_b, nrm_b, uv_b, idx_b, used_b = body
            idx_b, n1 = _drop_orange('body', idx_b, uv_b)
            body = (pos_b, nrm_b, uv_b, idx_b, used_b)
            wheels2 = {}
            n2 = 0
            for tag, (wp, wn, wu, wi) in wheels.items():
                wi, n = _drop_orange(f'wheel-{tag}', wi, wu)
                n2 += n
                wheels2[tag] = (wp, wn, wu, wi)
            wheels = wheels2
    except Exception as e:
        print(f'[{car}] 橙色三角删除跳过：{e}')
    tri_w = write_products(car, cfg, body, wheels, hubs)
    wheel_radius = round(sum(h[1] for h in hubs.values()) / len(hubs) * cfg['scale'], 4)
    manifest = {
        'car': car,
        'scale': cfg['scale'],
        'wheelRadius': wheel_radius,
        'hubs': {k: list(v) for k, v in hubs.items()},
        'bodyBBox': {'min': body[0][body[4]].min(0).astype(float).tolist(),
                     'max': body[0][body[4]].max(0).astype(float).tolist()},
        'variants': [{'id': v, 'file': f'basecolor-{v}.webp'} for v in cfg['variants']],
        'textures': {'normal': 'normal.png', 'mr': 'mr.png'},
        'tri': {'body': len(body[3]), **{f'wheel-{k}': v for k, v in tri_w.items()}, 'totalSource': tri_total},
        'bridgeTriangles': bridge,
        'generator': 'r44_bake.py',
    }
    with open(os.path.join(OUT_ROOT, car, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    print(f'[{car}] manifest.json 写出')
    if do_textures:
        out_dir = os.path.join(OUT_ROOT, car)
        pos, nrm, uv, body_idx, body_sel = body
        # 掩码：车身 + 全部轮的三角一起（轮也吃同一张图集）；带缓存（重跑贴图省 1-2 分钟）
        # 掩码缓存不进仓库（src/ 下只放交付产物）：放 .qa/r44_car/masks/
        mask_dir = os.path.join(os.path.dirname(__file__), '..', '..', '.qa', 'r44_car', 'masks', car)
        os.makedirs(mask_dir, exist_ok=True)
        cache2048 = os.path.join(mask_dir, 'mask2048.npy')
        cache1024 = os.path.join(mask_dir, 'mask1024.npy')
        if os.path.exists(cache2048) and os.path.exists(cache1024):
            mask2048 = np.load(cache2048)
            mask1024 = np.load(cache1024)
            print(f'[{car}] UV 掩码缓存命中')
        else:
            all_tris = [body_idx] + [w[3] for w in wheels.values()]
            mask2048 = build_uv_mask(uv, np.concatenate(all_tris, 0), 2048)
            mask1024 = build_uv_mask(uv, np.concatenate(all_tris, 0), 1024)
            np.save(cache2048, mask2048)
            np.save(cache1024, mask1024)
        print(f'[{car}] UV 掩码 2048 覆盖 {mask2048.mean() * 100:.1f}% / 1024 覆盖 {mask1024.mean() * 100:.1f}%')
        _fill_rects = None
        _ov_path2 = os.path.join(OUT_ROOT, '..', '..', '..', '..', '.qa', 'r44_car', 'masks', f'{car}_uv_override.npz')
        if os.path.exists(_ov_path2):
            _ov2 = np.load(_ov_path2)
            if 'rects' in _ov2:
                _fill_rects = [tuple(r) for r in _ov2['rects']]
        _geo = (uv, np.concatenate([body_idx] + [w[3] for w in wheels.values()], 0) if wheels else body_idx)
        for vid, (src_glb, whiten) in cfg['variants'].items():
            process_variant(src_glb, out_dir, car, vid, whiten, mask2048, cfg['inpaint_4096'], fill_rects=_fill_rects, geo=_geo)
        gltf, binc = parse_glb(os.path.join(SRC, cfg['geo_glb']))
        imgs = {}
        for im in gltf['images']:
            bv = gltf['bufferViews'][im['bufferView']]
            b = binc[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
            name = im.get('name', '')
            slot = 'normal' if 'normal' in name else ('mr' if 'metallic' in name else 'basecolor')
            imgs[slot] = Image.open(io.BytesIO(b))
        process_shared(imgs, out_dir, car, mask1024, cfg['inpaint_4096'])
        # 白色变体复检口：存一张小样
    return manifest


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'bake'
    if mode == 'probe':
        for car in ('r7', 'v800'):
            split_geometry(car, CARS[car])
        return
    for car in sys.argv[2:] or ('v800', 'r7'):
        bake_car(car, do_textures=(mode != 'geom'))


if __name__ == '__main__':
    main()
