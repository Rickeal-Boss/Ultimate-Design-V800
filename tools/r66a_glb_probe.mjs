/**
 * r66a_glb_probe.mjs — 解析高精度轮毂 GLB，提取几何参数（供重雕程序化 wheelHub 参考）。
 * 用法: node tools/r66a_glb_probe.mjs <glb_path>
 * 输出: nodes/meshes 名单、总 tri、包围盒、按 mesh 的 tri 数 + bbox。
 * dev-only（读外部 GLB 作测量参考，绝不交付/公开原始文件 —— 铁律：全程序化资产）。
 */
import fs from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node r66a_glb_probe.mjs <glb>');
  process.exit(1);
}

const buf = fs.readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

// GLB accessor min/max = 归一化前的局部包围盒（position accessor）
function accessorCenter(acc) {
  if (!acc.min || !acc.max) return null;
  return {
    min: acc.min.map((v) => +v.toFixed(4)),
    max: acc.max.map((v) => +v.toFixed(4)),
  };
}

console.log('=== nodes (name, mesh, translation, scale, rotation) ===');
for (const n of json.nodes ?? []) {
  console.log(
    `node "${n.name ?? '(noname)'}" mesh=${n.mesh ?? '-'} children=${(n.children ?? []).length} ` +
      `t=[${(n.translation ?? []).map((v) => +v.toFixed(3)).join(',')}]:[1] ` +
      `s=[${(n.scale ?? []).map((v) => +v.toFixed(3)).join(',')}]:[1] ` +
      `r=[${(n.rotation ?? []).map((v) => +v.toFixed(3)).join(',')}]:[1]`
  );
}

console.log('\n=== meshes (name, prims, totalTri, posBBox) ===');
let totalTri = 0;
for (const m of json.meshes ?? []) {
  let mTri = 0;
  let bbox = null;
  for (const p of m.primitives ?? []) {
    const accIdx = p.attributes?.POSITION;
    if (accIdx !== undefined) {
      const acc = json.accessors[accIdx];
      const tri = ((p.indices != null ? json.accessors[p.indices].count : acc.count) / 3) | 0;
      mTri += tri;
      if (!bbox) bbox = accessorCenter(acc);
    }
  }
  totalTri += mTri;
  const bb = bbox
    ? `X[${bbox.min[0]},${bbox.max[0]}] Y[${bbox.min[1]},${bbox.max[1]}] Z[${bbox.min[2]},${bbox.max[2]}]`
    : '-';
  console.log(`mesh "${m.name ?? '(noname)'}" prims=${(m.primitives ?? []).length} tri=${mTri} bbox=${bb}`);
}
console.log(`\nTOTAL tri across meshes: ${totalTri}`);

console.log('\n=== materials (name) ===');
for (const mat of json.materials ?? []) {
  console.log(`mat "${mat.name ?? '(noname)'}"`);
}

console.log('\n=== images / textures count ===');
console.log(`images=${(json.images ?? []).length} textures=${(json.textures ?? []).length}`);
