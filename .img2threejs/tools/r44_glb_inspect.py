# -*- coding: utf-8 -*-
"""R44: GLB 资产结构检视器（纯标准库，解析 glTF JSON chunk，不触 BIN 几何数据）
输出: node tree / mesh primitives / materials / images(尺寸) / bbox / tri 总量
"""
import json, struct, sys, io, os

def png_size(b):
    if len(b) > 24 and b[:8] == b'\x89PNG\r\n\x1a\n':
        w, h = struct.unpack('>II', b[16:24])
        return w, h
    return None

def jpg_size(b):
    if len(b) < 4 or b[:2] != b'\xff\xd8':
        return None
    i = 2
    n = len(b)
    while i + 9 < n:
        if b[i] != 0xFF:
            i += 1
            continue
        marker = b[i+1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seg_len = struct.unpack('>H', b[i+2:i+4])[0]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h, w = struct.unpack('>HH', b[i+5:i+9])
            return w, h
        i += 2 + seg_len
    return None

def img_size(b):
    return png_size(b) or jpg_size(b)

def fmt(v):
    if isinstance(v, float):
        return f"{v:.4f}".rstrip('0').rstrip('.')
    return v

def inspect(path):
    with open(path, 'rb') as f:
        data = f.read()
    magic, ver, total = struct.unpack('<III', data[:12])
    assert magic == 0x46546C67, f"{path}: not GLB"
    off = 12
    gltf = None
    bin_chunk = None
    while off + 8 <= len(data):
        clen, ctype = struct.unpack('<II', data[off:off+8])
        body = data[off+8:off+8+clen]
        if ctype == 0x4E4F534A:
            gltf = json.loads(body.decode('utf-8'))
        elif ctype == 0x004E4942:
            bin_chunk = body
        off += 8 + clen + (clen & 3)
    out = io.StringIO()
    w = out.write
    w(f"=== {os.path.basename(path)} ===  glTF {ver}, file {len(data)/1e6:.1f}MB, BIN {len(bin_chunk)/1e6:.1f}MB\n" if bin_chunk else f"=== {os.path.basename(path)} ===  glTF {ver}, file {len(data)/1e6:.1f}MB\n")
    meshes = gltf.get('meshes', [])
    accs = gltf.get('accessors', [])
    mats = gltf.get('materials', [])
    imgs = gltf.get('images', [])
    texs = gltf.get('textures', [])
    nodes = gltf.get('nodes', [])
    w(f"nodes={len(nodes)} meshes={len(meshes)} materials={len(mats)} textures={len(texs)} images={len(imgs)}\n")

    # images
    bufs = gltf.get('bufferViews', [])
    w("-- images --\n")
    total_img_bytes = 0
    for i, im in enumerate(imgs):
        name = im.get('name', '')
        mime = im.get('mimeType', '?')
        size = ''
        if 'bufferView' in im:
            bv = bufs[im['bufferView']]
            b = bin_chunk[bv.get('byteOffset', 0): bv.get('byteOffset', 0) + bv['byteLength']]
            s = img_size(b)
            size = f" {s[0]}x{s[1]}" if s else ""
            total_img_bytes += bv['byteLength']
        w(f"  [{i}] {name} {mime}{size}\n")
    w(f"  total image bytes: {total_img_bytes/1e6:.1f}MB\n")

    w("-- materials --\n")
    for i, m in enumerate(mats):
        pbr = m.get('pbrMetallicRoughness', {})
        bcf = pbr.get('baseColorFactor')
        bct = 'T' if 'baseColorTexture' in pbr else '-'
        mrt = 'T' if 'metallicRoughnessTexture' in pbr else '-'
        nrt = 'T' if 'normalTexture' in m else '-'
        emt = 'T' if 'emissiveTexture' in m else '-'
        w(f"  [{i}] {m.get('name','?')} baseColor={tuple(fmt(x) for x in bcf) if bcf else '-'} tex(bColor{bct}/MR{mrt}/N{nrt}/E{emt}) metal={fmt(pbr.get('metallicFactor',1))} rough={fmt(pbr.get('roughnessFactor',1))} alphaMode={m.get('alphaMode','OPAQUE')}\n")

    w("-- meshes (primitive 级) --\n")
    total_tri = 0
    total_vtx = 0
    for i, mesh in enumerate(meshes):
        w(f"  mesh[{i}] {mesh.get('name','?')}\n")
        for j, prim in enumerate(mesh.get('primitives', [])):
            mat = prim.get('material', -1)
            pos = prim.get('attributes', {}).get('POSITION')
            mode = prim.get('mode', 4)
            idx = prim.get('indices')
            if pos is not None:
                nv = accs[pos]['count']
            else:
                nv = 0
            if idx is not None:
                ni = accs[idx]['count']
            else:
                ni = nv
            tri = ni // 3 if mode == 4 else 0
            total_tri += tri
            total_vtx += nv
            a_min = accs[pos].get('min') if pos is not None else None
            a_max = accs[pos].get('max') if pos is not None else None
            bbox = f" bbox[min={tuple(fmt(x) for x in a_min)},max={tuple(fmt(x) for x in a_max)}]" if a_min and a_max else ""
            w(f"    prim[{j}] mat={mats[mat].get('name','?') if mat >= 0 else '-'} vtx={nv} idx={ni} tri={tri}{bbox}\n")
    w(f"  TOTAL tris={total_tri} vtx={total_vtx}\n")

    w("-- node tree --\n")
    def node_line(n, indent):
        trs = ''
        if any(k in n for k in ('translation', 'rotation', 'scale')):
            t = n.get('translation'); r = n.get('rotation'); s = n.get('scale')
            trs = f" t={tuple(fmt(x) for x in t) if t else ''} r={tuple(fmt(x) for x in r) if r else ''} s={tuple(fmt(x) for x in s) if s else ''}"
        ch = n.get('children', [])
        mi = n.get('mesh')
        w(f"{'  '*indent}{n.get('name','?')} mesh={mi if mi is not None else '-'}{trs} children={len(ch)}\n")
        for c in ch:
            node_line(nodes[c], indent+1)
    for si, s in enumerate(gltf.get('scenes', [])):
        w(f"  scene[{si}] {s.get('name','')}\n")
        for rn in s.get('nodes', []):
            node_line(nodes[rn], 2)
    return out.getvalue()

if __name__ == '__main__':
    files = sys.argv[1:]
    for fp in files:
        try:
            print(inspect(fp))
        except Exception as e:
            import traceback
            print(f"!!! {fp}: {e}")
            traceback.print_exc()
