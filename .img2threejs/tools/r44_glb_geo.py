# -*- coding: utf-8 -*-
"""R44: GLB 几何深度分析 — 连通域(找独立轮壳)、轮心/轮径提取、属性/UV检查、组装空间换算
纯标准库 + struct, union-find 用迭代式
"""
import json, struct, sys, io, os
import array

def parse_glb(path):
    with open(path, 'rb') as f:
        data = f.read()
    off = 12
    gltf, bin_chunk = None, None
    while off + 8 <= len(data):
        clen, ctype = struct.unpack('<II', data[off:off+8])
        body = data[off+8:off+8+clen]
        if ctype == 0x4E4F534A:
            gltf = json.loads(body.decode('utf-8'))
        elif ctype == 0x004E4942:
            bin_chunk = body
        off += 8 + clen + (clen & 3)
    return gltf, bin_chunk

COMP_TYPE = {5120:('b',1),5121:('B',1),5122:('h',2),5123:('H',2),5125:('I',4),5126:('f',4)}
NCOMP = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}

def read_accessor(gltf, bins, idx):
    acc = gltf['accessors'][idx]
    bv = gltf['bufferViews'][acc['bufferView']]
    off = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    fmt, sz = COMP_TYPE[acc['componentType']]
    n = NCOMP[acc['type']]
    cnt = acc['count']
    out = array.array(fmt)
    for b in bins:
        end = off + cnt*n*sz
        if off < len(b):
            out.frombytes(b[off:min(end, len(b))])
            got = (min(end,len(b))-off)//(n*sz)
            off = 0
            if got >= cnt:
                break
            cnt -= got
        else:
            off -= len(b)
    return out, acc

def analyze(path):
    gltf, bin_chunk = parse_glb(path)
    bins = [bin_chunk]
    out = io.StringIO()
    w = out.write
    prim = gltf['meshes'][0]['primitives'][0]
    attrs = prim['attributes']
    w(f"=== {os.path.basename(path)} ===\nattributes: {list(attrs.keys())}\n")
    for k, ai in attrs.items():
        acc = gltf['accessors'][ai]
        w(f"  {k}: type={acc['type']} compType={acc['componentType']} count={acc['count']}\n")
    idx_acc = gltf['accessors'][prim['indices']]
    w(f"  indices: compType={idx_acc['componentType']} count={idx_acc['count']}\n")

    pos, _ = read_accessor(gltf, bins, attrs['POSITION'])
    npos = len(pos)//3
    indices, _ = read_accessor(gltf, bins, prim['indices'])
    nidx = len(indices)
    w(f"verts={npos} idx={nidx} tris={nidx//3}\n")

    # ---- union-find 连通域 ----
    parent = array.array('i', range(npos))
    def find(x):
        r = x
        while parent[r] != r:
            r = parent[r]
        while parent[x] != r:
            parent[x], x = r, parent[x]
        return r
    for i in range(0, nidx, 3):
        a, b, c = indices[i], indices[i+1], indices[i+2]
        ra, rb, rc = find(a), find(b), find(c)
        if ra != rb: parent[rb] = ra
        if ra != rc: parent[rc] = ra

    roots = {}
    for v in range(npos):
        r = find(v)
        roots[r] = roots.get(r, 0) + 1
    w(f"connected components: {len(roots)}\n")
    # 大组件 (>=100 verts)
    big = sorted(((r, c) for r, c in roots.items() if c >= 100), key=lambda t: -t[1])
    w(f"big components (>=100v): {len(big)}\n")
    # 每个组件 bbox + 质心
    INF = float('inf')
    comp_bbox = {}
    for i in range(0, nidx, 3):
        r = find(indices[i])
        bb = comp_bbox.get(r)
        if bb is None:
            bb = comp_bbox[r] = [INF, INF, INF, -INF, -INF, -INF, 0]
        bb[6] += 1
        for j in range(3):
            v = pos[indices[i+j]*3+j]
            if v < bb[j]: bb[j] = v
            if v > bb[j+3]: bb[j+3] = v
    def show(bb):
        cx, cy, cz = (bb[0]+bb[3])/2, (bb[1]+bb[4])/2, (bb[2]+bb[5])/2
        return f"tris={bb[6]} bbox=x[{bb[0]:.4f},{bb[3]:.4f}] y[{bb[1]:.4f},{bb[4]:.4f}] z[{bb[2]:.5f},{bb[5]:.4f}] c=({cx:.4f},{cy:.4f},{cz:.4f}) size=({bb[3]-bb[0]:.4f},{bb[4]-bb[1]:.4f},{bb[5]-bb[2]:.4f})"
    for r, c in big[:40]:
        w(f"  comp root={r} {show(comp_bbox[r])}\n")
    small_count = len(roots) - len(big)
    small_tris = sum(bb[6] for bb in comp_bbox.values()) - sum(comp_bbox[r][6] for r, _ in big)
    w(f"  ... 小组件 {small_count} 个 / 共 {small_tris} tris\n")

    # ---- 轮子候选: 底部四角附近的大组件 ----
    w("-- wheel candidates (cy<0.16 && size_y 0.1..0.25) --\n")
    wheels = []
    for r, c in big:
        bb = comp_bbox[r]
        cy = (bb[1]+bb[4])/2
        sy = bb[4]-bb[1]
        sx = bb[3]-bb[0]
        sz = bb[5]-bb[2]
        if cy < 0.16 and 0.08 < sy < 0.30 and sz < 0.30 and sx < 0.30:
            wheels.append((r, bb))
            w(f"  root={r} {show(bb)}\n")
    return out.getvalue()

if __name__ == '__main__':
    for fp in sys.argv[1:]:
        try:
            print(analyze(fp))
        except Exception as e:
            import traceback
            print(f"!!! {fp}: {e}")
            traceback.print_exc()
