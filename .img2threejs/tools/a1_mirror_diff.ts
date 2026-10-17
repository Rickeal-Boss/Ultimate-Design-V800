/**
 * a1 tweeter 镜像落位 · before/after 同口径位移核验。
 * 三种判据，覆盖 AABB 看不到的「锥台倒向」变化：
 *   1) AABB 六角的最大值逐项比较（能否发现「平移」类位移）
 *   2) mesh 世界矩阵逐元素比较（能发现任何刚体位姿变化，含倒向）
 *   3) tweeter 端面半径取向（宽底 r=0.06 落在哪一端）—— 真正的镜像判据
 * 用法：
 *   node -e "require('./node_modules/esbuild/lib/main.js').build({entryPoints:['.img2threejs/tools/a1_mirror_diff.ts'],bundle:true,format:'esm',platform:'node',outfile:'.img2threejs/tools/a1_mirror_diff_bundle.mjs',logLevel:'warning'})"
 *   node .img2threejs/tools/a1_mirror_diff_bundle.mjs
 *
 * 依赖的 before 模型（.img2threejs/tmpbuild/，gitignored，需先造）重建命令：
 *   python - <<'PY'
 *   import json, copy
 *   s = json.load(open('.img2threejs/object-sculpt-spec.json', encoding='utf-8'))
 *   def find(ns, t):
 *       for n in ns:
 *           if n.get('id') == t: return n
 *           r = find(n.get('children') or [], t)
 *           if r: return r
 *   for tag, lsx in (('A', -0.8375), ('B', -0.86)):
 *       c = copy.deepcopy(s); n = find(c['componentTree'], 'tweeter-r')
 *       n['transform']['rotation'][2] = 1.5708
 *       n['attachment']['localStart'][0] = n['attachment']['localEnd'][0] = lsx
 *       json.dump(c, open(f'.img2threejs/tmpbuild/spec_before_{tag}.json', 'w', encoding='utf-8'), ensure_ascii=False)
 *   PY
 *   python forge/stage3_build/generate_threejs_factory.py .img2threejs/tmpbuild/spec_before_A.json \
 *     --out .img2threejs/tmpbuild/beforeModel_A.ts --pass-id lighting-pass --force
 */
import './a2_dom_shim.mjs';
import * as THREE from 'three';
import { createZunjieV800LuxuryMPVModel as buildAfter } from '../../src/model/createV800Model';
import { createZunjieV800LuxuryMPVModel as buildBeforeA } from '../tmpbuild/beforeModel_A';
import { createZunjieV800LuxuryMPVModel as buildBeforeB } from '../tmpbuild/beforeModel_B';

type Build = (o: any) => THREE.Object3D;

interface Row {
  id: string;
  min: [number, number, number];
  max: [number, number, number];
  mat: number[];
  wideX: number;   // 宽底（r≈0.06）端面在世界 X 上的落点
  narrowX: number; // 窄端（r≈0.033）端面在世界 X 上的落点
}

function measure(build: Build): Map<string, Row> {
  const root = build({});
  root.updateMatrixWorld(true);
  const rows = new Map<string, Row>();
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const mesh = o as THREE.Mesh;
    const comp = o.userData?.sculptComponent ?? {};
    const id = String(comp.id ?? o.name ?? '?');
    const box = new THREE.Box3().setFromObject(mesh);
    const geo = mesh.geometry as THREE.BufferGeometry;
    const hasCone =
      String(comp.id ?? '').startsWith('tweeter') && Math.abs(box.max.x - box.min.x) < 0.2;
    let wideX = NaN;
    let narrowX = NaN;
    if (hasCone) {
      // 端面环半径：取 X 两端各一小段环带内的最大径向距离
      const pos = geo.getAttribute('position');
      const v = new THREE.Vector3();
      const cy = (box.min.y + box.max.y) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      const tol = (box.max.x - box.min.x) * 0.06;
      let rMin = 0;
      let rMax = 0;
      for (let i = 0; i < pos.count; i += 1) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld);
        const r = Math.hypot(v.y - cy, v.z - cz);
        if (v.x <= box.min.x + tol) rMin = Math.max(rMin, r);
        if (v.x >= box.max.x - tol) rMax = Math.max(rMax, r);
      }
      [wideX, narrowX] = rMin > rMax ? [box.min.x, box.max.x] : [box.max.x, box.min.x];
    }
    rows.set(id, {
      id,
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
      mat: mesh.matrixWorld.elements.slice(),
      wideX,
      narrowX,
    });
  });
  return rows;
}

const after = measure(buildAfter as Build);
const variants: Array<[string, Map<string, Row>]> = [
  ['A: 主理人所述修正前态 rot=+1.5708 / ls.x=le.x=-0.8375', measure(buildBeforeA as Build)],
  ['B: 更早的 spec 快照 rot=+1.5708 / ls.x=le.x=-0.86', measure(buildBeforeB as Build)],
];

console.log(`after: ${after.size} meshes (factory root frame)`);

for (const [label, before] of variants) {
  const aabbMoved: string[] = [];
  const matMoved: string[] = [];
  let worstAabb = 0;
  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b) { aabbMoved.push(`${id}: MISSING BEFORE`); continue; }
    let d = 0;
    for (let i = 0; i < 3; i += 1) {
      d = Math.max(d, Math.abs(a.min[i] - b.min[i]), Math.abs(a.max[i] - b.max[i]));
    }
    if (d > worstAabb) worstAabb = d;
    if (d > 1e-4) aabbMoved.push(`${id} Δ=${d.toFixed(4)}m`);
    let dm = 0;
    for (let i = 0; i < 16; i += 1) dm = Math.max(dm, Math.abs(a.mat[i] - b.mat[i]));
    if (dm > 1e-6) matMoved.push(`${id} Δmat=${dm.toExponential(2)}`);
  }
  console.log(`\n===== before ${label} =====`);
  console.log(`  meshes: before ${before.size} -> after ${after.size}`);
  console.log(`  [判据1 AABB 角点] 位移件数 >0.1mm : ${aabbMoved.length}   worst=${worstAabb.toFixed(6)}m`);
  for (const m of aabbMoved.slice(0, 10)) console.log('     ' + m);
  console.log(`  [判据2 世界矩阵] 位姿变化件数     : ${matMoved.length}`);
  for (const m of matMoved.slice(0, 10)) console.log('     ' + m);
  for (const cid of ['tweeter-l', 'tweeter-r']) {
    const b = before.get(cid)!;
    const a = after.get(cid)!;
    console.log(
      `  [判据3 锥台宽底] ${cid.padEnd(10)} before wideX=${b.wideX.toFixed(4)} narrowX=${b.narrowX.toFixed(4)}` +
        ` -> after wideX=${a.wideX.toFixed(4)} narrowX=${a.narrowX.toFixed(4)}`,
    );
  }
}

console.log('\n===== after tweeter 最终落位 =====');
for (const cid of ['tweeter-l', 'tweeter-r']) {
  const a = after.get(cid)!;
  console.log(
    `  ${cid.padEnd(10)} min=[${a.min.map((v) => v.toFixed(4)).join(', ')}]  max=[${a.max.map((v) => v.toFixed(4)).join(', ')}]\n` +
      `              wideX=${a.wideX.toFixed(4)} (宽底贴壁侧)  narrowX=${a.narrowX.toFixed(4)} (窄端朝舱内)`,
  );
}
