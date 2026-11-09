# -*- coding: utf-8 -*-
"""R44: V800 焊接轮位检测（四角圆柱拟合）+ basecolor 缩略图"""
import json, struct, os, sys
import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), '..', 'r44_assets')

def parse_glb(path):
    with open(path, 'rb') as f:
        data = f.read()
    off = 12
    gltf, binc = None, None
    while off + 8 <= len(data):
        clen, ctype = struct.unpack('<II', data[off:off+8])
        body = data[off+8:off+8+clen]
        if ctype == 0x4E4F534A:
            gltf = json.loads(body.decode('utf-8'))
        elif ctype == 0x004E4942:
            binc = body
        off += 8 + clen + (clen & 3)
    return gltf, binc

def read_pos(gltf, binc, ai):
    acc = gltf['accessors'][ai]
    bv = gltf['bufferViews'][acc['bufferView']]
    off = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    return np.frombuffer(binc, dtype=np.float32, count=acc['count']*3, offset=off).reshape(-1,3).astype(np.float64)

def detect_v800_wheels():
    g, b = parse_glb(r'<DESKTOP>/R7/V800白.glb')
    prim = g['meshes'][0]['primitives'][0]
    pos = read_pos(g, b, prim['attributes']['POSITION'])
    # 用染色版同几何的 UV？不需要。轮子: y低 + 四角
    lo = pos.min(0); hi = pos.max(0)
    print("V800 bbox", lo, hi)
    # R7 轮心参考: x=±0.2056 y=0.0879 z=+0.3376/-0.3442; V800 按 R7 比例 + 长宽差缩放
    # 四角搜索: x>0.12, y<0.14, z in [0.15,0.5] / [-0.5,-0.15]
    quads = {'FL': (1, 1), 'FR': (-1, 1), 'RL': (1, -1), 'RR': (-1, -1)}
    for name, (sx, sz) in quads.items():
        m = (np.abs(pos[:, 0]) > 0.10) & (np.abs(pos[:, 0]*sx - np.abs(pos[:,0])) < 1e9) & \
            (pos[:, 1] < 0.16) & (pos[:, 2]*sz > 0.15)
        sel = pos[m]
        if len(sel) == 0:
            print(f"{name}: none"); continue
        # 只取该象限
        m2 = (sel[:,0]*sx > 0) & (sel[:,2]*sz > 0)
        sel = sel[m2]
        cy_guess = 0.088
        # 圆柱拟合: 迭代求 (cz, cy) 使到轴 (x=const, 轴向X) 的半径方差最小; x 用该侧轮胎外侧面中位
        xm = np.median(sel[:,0])
        # 只保留接近轮宽的 (|x - xm| < 0.05)
        sel = sel[np.abs(sel[:,0]-xm) < 0.05]
        # 迭代圆拟合 (z,y 平面)
        cz, cy = sel[:,2].mean(), sel[:,1].mean()
        for _ in range(8):
            r = np.sqrt((sel[:,2]-cz)**2 + (sel[:,1]-cy)**2)
            rm = np.median(r)
            keep = np.abs(r-rm) < 0.04  # 轮胎外环附近
            k = sel[keep]
            cz, cy = k[:,2].mean(), k[:,1].mean()
        r = np.sqrt((sel[:,2]-cz)**2 + (sel[:,1]-cy)**2)
        # 轮径 = 2*最大半径(胎面), 轮心y
        rmax = np.percentile(r, 98)
        rmin = np.percentile(r, 5)
        print(f"{name}: hub=({xm:.4f},{cy:.4f},{cz:.4f}) r_out={rmax:.4f} r_in~{rmin:.4f} vtx={len(sel)}")
        # 顶点密度按角度分布（判断是否完整圆环）
        ang = np.arctan2(sel[:,1]-cy, sel[:,2]-cz)
        hist, _ = np.histogram(ang, bins=12, range=(-np.pi, np.pi))
        print(f"    角度直方图: {hist.tolist()}")

def thumbnails():
    for f in os.listdir(OUT):
        if f.endswith('_basecolor.png'):
            im = Image.open(os.path.join(OUT, f))
            im.thumbnail((1400, 1400))
            im.save(os.path.join(OUT, 'thumb_' + f))
            print('thumb', f, im.size)

if __name__ == '__main__':
    detect_v800_wheels()
    thumbnails()
