/**
 * R61 GLB 探针：直接解析 src/assets/cars/{car}/body.glb，取名为 'body' 的 mesh 顶点，
 * 按 z 分箱输出侧面 xMax 轮廓（与游戏中 bodyMesh.geometry 局部坐标一致）。
 * 绕开 headless 浏览器超时。输出 .qa/r61/side_probe.json
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '<REPO_ROOT>';
const OUT = path.join(ROOT, '.qa/r61');

function parseGLB(buf) {
  // magic
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not glb');
  const ver = buf.readUInt32LE(4);
  const total = buf.readUInt32LE(8);
  let off = 12;
  let json = null, bin = null;
  while (off < total) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json, bin };
}

function readAccessor(gltf, bin, idx) {
  const acc = gltf.accessors[idx];
  const bv = gltf.bufferViews[acc.bufferView];
  const compSize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType];
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
  const byteOffset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const arr = new Float32Array(bin.buffer, bin.byteOffset + byteOffset, acc.count * comps);
  return { arr, count: acc.count, comps };
}

const report = {};
for (const car of ['v800', 'r7']) {
  const file = path.join(ROOT, `src/assets/cars/${car}/body.glb`);
  const buf = fs.readFileSync(file);
  const { json, bin } = parseGLB(buf);
  // 找名为 'body' 的 node → mesh
  let bodyMeshIdx = -1;
  for (const n of json.nodes || []) {
    if (n.name === 'body' && n.mesh !== undefined) { bodyMeshIdx = n.mesh; break; }
  }
  if (bodyMeshIdx < 0) {
    // 兜底：取顶点最多的 mesh
    let best = -1, bestC = -1;
    (json.meshes || []).forEach((m, i) => {
      const prim = m.primitives[0];
      const c = json.accessors[prim.attributes.POSITION].count;
      if (c > bestC) { bestC = c; best = i; }
    });
    bodyMeshIdx = best;
  }
  const prim = json.meshes[bodyMeshIdx].primitives[0];
  const pos = readAccessor(json, bin, prim.attributes.POSITION);
  const n = pos.count;
  const ZB = 48;
  // 先求 z 范围
  let zmin = 1e9, zmax = -1e9, ymin = 1e9, ymax = -1e9;
  for (let i = 0; i < n; i++) {
    const z = pos.arr[i * 3 + 2];
    const y = pos.arr[i * 3 + 1];
    if (z < zmin) zmin = z; if (z > zmax) zmax = z;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  // 多 y 带采样侧面 x(z)：用条带实际中心高度，使 ribbon 紧贴车身侧面
  const YBANDS = [0.150, 0.235];
  const ybData = YBANDS.map((yc) => {
    const half = 0.025;
    const bins = Array.from({ length: ZB }, () => []);
    for (let i = 0; i < n; i++) {
      const x = pos.arr[i * 3], y = pos.arr[i * 3 + 1], z = pos.arr[i * 3 + 2];
      if (y < yc - half || y > yc + half) continue;
      const bi = Math.floor(((z - zmin) / (zmax - zmin)) * (ZB - 1) + 0.5);
      if (bi < 0 || bi >= ZB) continue;
      bins[bi].push(Math.abs(x));
    }
    return { yc, prof: bins.map((b, i) => {
      const z = zmin + ((i + 0.5) / ZB) * (zmax - zmin);
      if (!b.length) return { z: +z.toFixed(4), x: null };
      return { z: +z.toFixed(4), x: +Math.max(...b).toFixed(4) };
    }) };
  });
  report[car] = {
    bodyMeshIdx,
    bbox: { zmin: +zmin.toFixed(4), zmax: +zmax.toFixed(4), ymin: +ymin.toFixed(4), ymax: +ymax.toFixed(4) },
    count: n,
    yBands: ybData
  };
  console.log('PROBED', car, 'mesh', bodyMeshIdx, 'z', zmin.toFixed(3), zmax.toFixed(3), 'y', ymin.toFixed(3), ymax.toFixed(3));
}
fs.writeFileSync(path.join(OUT, 'side_probe.json'), JSON.stringify(report, null, 1));
console.log('REPORT ->', path.join(OUT, 'side_probe.json'));
