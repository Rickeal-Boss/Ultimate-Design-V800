# -*- coding: utf-8 -*-
"""R44: 提取染色版 PBR 贴图 + 像素级跨变体比对 + 白模几何多机位光栅出图"""
import json, struct, os, sys, hashlib
import numpy as np
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), '..', 'r44_assets')
os.makedirs(OUT, exist_ok=True)

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

COMP_TYPE = {5120:('b',1),5121:('B',1),5122:('h',2),5123:('H',2),5125:('I',4),5126:('f',4)}
NCOMP = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}

def read_accessor(gltf, binc, idx):
    acc = gltf['accessors'][idx]
    bv = gltf['bufferViews'][acc['bufferView']]
    off = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    fmt, sz = COMP_TYPE[acc['componentType']]
    n = NCOMP[acc['type']]
    cnt = acc['count']
    out = np.frombuffer(binc, dtype=fmt, count=cnt*n, offset=off)
    return out.reshape(cnt, n).astype(np.float64 if fmt=='f' else fmt)

def get_images(gltf, binc):
    imgs = []
    for im in gltf['images']:
        bv = gltf['bufferViews'][im['bufferView']]
        b = binc[bv.get('byteOffset',0): bv.get('byteOffset',0)+bv['byteLength']]
        imgs.append((im.get('name',''), Image.open(__import__('io').BytesIO(b))))
    return imgs

def pixel_hash(img):
    a = np.asarray(img.convert('RGBA'))
    return hashlib.md5(a.tobytes()).hexdigest()[:12], a.shape

def raster_views(pos, indices, views, w=1100):
    """numpy z-buffer 平影光栅. views: (name, azim_deg, elev_deg, target, dist, ortho_h)"""
    lo = pos.min(0); hi = pos.max(0)
    results = {}
    for name, az, el, use_center, dist, ortho in views:
        c = (lo+hi)/2 if use_center == 'c' else np.array(use_center)
        a = np.radians(az); e = np.radians(el)
        fwd = np.array([np.cos(e)*np.sin(a), np.sin(e), np.cos(e)*np.cos(a)])
        right = np.cross(np.array([0,1,0]), fwd); right /= np.linalg.norm(right)
        up = np.cross(fwd, right)
        eye = c - fwd*dist
        # 正交投影
        rel = pos - eye
        x = rel@right; y = rel@up; z = rel@fwd  # z 越大越远
        scale = w/2/ortho
        px = (x*scale + w/2)
        py = (h_ - (y*scale + w/2)) if (h_:=w) else 0
        H = W = w
        py = H - (y*scale + H/2)
        img = np.full((H, W, 3), 235, np.uint8)
        zbuf = np.full((H, W), 1e18)
        # 面法线平影
        v0 = pos[indices[:,0]]; v1 = pos[indices[:,1]]; v2 = pos[indices[:,2]]
        n = np.cross(v1-v0, v2-v0)
        nn = n/ (np.linalg.norm(n, axis=1, keepdims=True)+1e-12)
        light = np.array([0.35, 0.8, 0.48]); light/=np.linalg.norm(light)
        lam = np.abs(nn@light)*0.85 + 0.15
        base = np.stack([lam*0.82, lam*0.85, lam*0.9], 1)  # 冷灰
        P = np.stack([px, py], 1)
        Z = z
        for i in range(len(indices)):
            ia, ib, ic = indices[i]
            p0, p1, p2 = P[ia], P[ib], P[ic]
            z0, z1, z2 = Z[ia], Z[ib], Z[ic]
            if z0<=0 or z1<=0 or z2<=0: continue
            minx = max(int(min(p0[0],p1[0],p2[0])), 0); maxx = min(int(max(p0[0],p1[0],p2[0]))+1, W)
            miny = max(int(min(p0[1],p1[1],p2[1])), 0); maxy = min(int(max(p0[1],p1[1],p2[1]))+1, H)
            if minx>=maxx or miny>=maxy: continue
            d = (p1[1]-p2[1])*(p0[0]-p2[0]) + (p2[0]-p1[0])*(p0[1]-p2[1])
            if abs(d) < 1e-9: continue
            xs = np.arange(minx, maxx); ys = np.arange(miny, maxy)
            gx, gy = np.meshgrid(xs, ys)
            w0 = ((p1[1]-p2[1])*(gx-p2[0]) + (p2[0]-p1[0])*(gy-p2[1]))/d
            w1 = ((p2[1]-p0[1])*(gx-p2[0]) + (p0[0]-p2[0])*(gy-p2[1]))/d
            w2 = 1-w0-w1
            m = (w0>=-1e-6)&(w1>=-1e-6)&(w2>=-1e-6)
            if not m.any(): continue
            zi = w0*z0 + w1*z1 + w2*z2
            sub_z = zbuf[miny:maxy, minx:maxx]
            upd = m & (zi < sub_z)
            sub_z[upd] = zi[upd]
            col = (base[i]*255).astype(np.uint8)
            img[miny:maxy, minx:maxx][upd] = col
        results[name] = Image.fromarray(img)
    return results

def main():
    # ---- 1. 提取染色版贴图 + 像素比对 ----
    cars = {
        'R7': [('white', None), ('purple', r'C:/Users/WB/Desktop/R7/紫.glb'), ('green', r'C:/Users/WB/Desktop/R7/绿.glb')],
        'V800': [('white', None), ('black', r'C:/Users/WB/Desktop/R7/V黑浅.glb'), ('gold', r'C:/Users/WB/Desktop/R7/V浅.glb')],
    }
    pixhash = {}
    for car, variants in cars.items():
        for vname, path in variants:
            if path is None:
                continue
            g, b = parse_glb(path)
            imgs = get_images(g, b)
            slots = []
            for imname, im in imgs:
                n = (imname + '_normal') if 'normal' in imname else ('_mr' if 'metallic' in imname else '_basecolor')
                slots.append(n)
            for (imname, im), slot in zip(imgs, slots):
                fp = os.path.join(OUT, f'{car}_{vname}{slot}.png')
                im.save(fp)
                ph, shape = pixel_hash(im)
                pixhash.setdefault((car, slot), {})[vname] = ph
                print(f"{car} {vname}{slot}: {im.size} -> {os.path.basename(fp)} hash={ph}")
    print("\n== 跨变体像素哈希比对（同槽位）==")
    for (car, slot), m in pixhash.items():
        vals = set(m.values())
        print(f"  {car} {slot}: {len(vals)} 种像素 ({m})")

    # ---- 2. 白模光栅 ----
    for car, wp in [('R7', r'C:/Users/WB/Desktop/R7/R7白.glb'), ('V800', r'C:/Users/WB/Desktop/R7/V800白.glb')]:
        g, b = parse_glb(wp)
        prim = g['meshes'][0]['primitives'][0]
        pos = read_accessor(g, b, prim['attributes']['POSITION'])
        idxacc = g['accessors'][prim['indices']]
        fmti, _ = COMP_TYPE[idxacc['componentType']]
        indices = np.frombuffer(b, dtype=fmti, count=idxacc['count'],
                                offset=g['bufferViews'][idxacc['bufferView']].get('byteOffset',0)).reshape(-1,3).astype(np.int64)
        lo = pos.min(0); hi = pos.max(0); c=(lo+hi)/2; span=(hi-lo)
        # 抽样 1/3 三角加速预览
        step = 3
        idx_s = indices[::step]
        L = span[2]
        views = [
            ('side',   90, 4,  'c', L*1.6, span[0]*1.35),
            ('front34',-35, 12, 'c', L*1.7, span[0]*1.4),
            ('rear34', 145, 12, 'c', L*1.7, span[0]*1.4),
            ('top',    90, 88, 'c', L*1.4, span[0]*1.25),
            ('front',   0,  6, 'c', L*1.6, span[0]*1.35),
            ('wheelFL', 90, 8, (0.2055, 0.0879, 0.3376), 0.16, 0.13),
        ]
        rs = raster_views(pos, idx_s, views)
        for name, im in rs.items():
            im.save(os.path.join(OUT, f'raster_{car}_{name}.png'))
            print(f"raster {car} {name} saved")

if __name__ == '__main__':
    main()
