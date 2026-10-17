/**
 * a1 tweeter 镜像核验 · 逐件世界 AABB + 世界矩阵 + 锥轴端点（宽端/窄端）落位。
 * 用法：
 *   node -e "require('./node_modules/esbuild/lib/main.js').build({entryPoints:['.img2threejs/tools/a1_tweeter_mirror.ts'],bundle:true,format:'esm',platform:'node',outfile:'.img2threejs/tools/a1_tweeter_mirror_bundle.mjs',logLevel:'warning'})"
 *   node .img2threejs/tools/a1_tweeter_mirror_bundle.mjs
 */
import './a2_dom_shim.mjs';
import * as THREE from 'three';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';

const root = createZunjieV800LuxuryMPVModel({} as never);
root.updateMatrixWorld(true);

const f = (v: number) => (Object.is(v, -0) ? 0 : v).toFixed(4);

interface Row {
  id: string;
  prim: string;
  box: THREE.Box3;
  center: THREE.Vector3;
  wideEnd: THREE.Vector3;   // 锥体宽端（-Y 局部）世界坐标
  narrowEnd: THREE.Vector3; // 锥体窄端（+Y 局部）世界坐标
  matrix: THREE.Matrix4;
}

const rows = new Map<string, Row>();
let meshCount = 0;

root.traverse((o: any) => {
  if (!o.isMesh) return;
  meshCount += 1;
  const comp = o.userData?.sculptComponent ?? {};
  const id = String(comp.id ?? o.name ?? `?-${meshCount}`);
  const geo = o.geometry as THREE.BufferGeometry;
  geo.computeBoundingBox();
  const lb = geo.boundingBox!;
  // 端点沿几何局部 Y 轴（Attachment cylinder 的轴向）
  const half = Math.max(Math.abs(lb.max.y), Math.abs(lb.min.y));
  const meshRow: Row = {
    id,
    prim: String(comp.primitive ?? '?'),
    box: new THREE.Box3().setFromObject(o),
    center: new THREE.Vector3(),
    wideEnd: o.localToWorld(new THREE.Vector3(0, -half, 0)),
    narrowEnd: o.localToWorld(new THREE.Vector3(0, half, 0)),
    matrix: o.matrixWorld.clone(),
  };
  meshRow.center.copy(meshRow.box.getCenter(new THREE.Vector3()));
  rows.set(id, meshRow);
});

console.log(`meshes scanned: ${meshCount}, ids: ${rows.size}`);

const dump = (id: string) => {
  const r = rows.get(id);
  if (!r) return console.log(`${id}: MISSING`);
  console.log(
    `${id.padEnd(12)} prim=${r.prim}\n` +
      `   world bbox min [${f(r.box.min.x)}, ${f(r.box.min.y)}, ${f(r.box.min.z)}]  max [${f(r.box.max.x)}, ${f(r.box.max.y)}, ${f(r.box.max.z)}]\n` +
      `   center        [${f(r.center.x)}, ${f(r.center.y)}, ${f(r.center.z)}]\n` +
      `   wideEnd(-Y)   [${f(r.wideEnd.x)}, ${f(r.wideEnd.y)}, ${f(r.wideEnd.z)}]\n` +
      `   narrowEnd(+Y) [${f(r.narrowEnd.x)}, ${f(r.narrowEnd.y)}, ${f(r.narrowEnd.z)}]`,
  );
};

console.log('=== tweeter 落位 ===');
dump('tweeter-l');
dump('tweeter-r');

const l = rows.get('tweeter-l')!;
const r = rows.get('tweeter-r')!;
if (l && r) {
  const eps = 1e-4;
  const checks = [
    ['center.x 严格取反', Math.abs(l.center.x + r.center.x) < eps],
    ['center.y 相等', Math.abs(l.center.y - r.center.y) < eps],
    ['center.z 相等', Math.abs(l.center.z - r.center.z) < eps],
    ['bbox.x 严格镜像', Math.abs(l.box.min.x + r.box.max.x) < eps && Math.abs(l.box.max.x + r.box.min.x) < eps],
    ['bbox.y 同区间', Math.abs(l.box.min.y - r.box.min.y) < eps && Math.abs(l.box.max.y - r.box.max.y) < eps],
    ['bbox.z 同区间', Math.abs(l.box.min.z - r.box.min.z) < eps && Math.abs(l.box.max.z - r.box.max.z) < eps],
    ['宽端各贴外壁 (|x| 更大)', Math.abs(r.wideEnd.x) > Math.abs(r.narrowEnd.x) && Math.abs(l.wideEnd.x) > Math.abs(l.narrowEnd.x)],
    ['宽端居外、窄端朝舱内', Math.abs(r.wideEnd.x) > Math.abs(r.center.x) && Math.abs(l.wideEnd.x) > Math.abs(l.center.x)],
  ];
  console.log('=== 严格镜像判定 ===');
  for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

console.log('=== 全部尖锐值（导出用） ===');
const json = [...rows.values()].map((r) => ({
  id: r.id,
  prim: r.prim,
  min: [r.box.min.x, r.box.min.y, r.box.min.z],
  max: [r.box.max.x, r.box.max.y, r.box.max.z],
  center: [r.center.x, r.center.y, r.center.z],
  wide: [r.wideEnd.x, r.wideEnd.y, r.wideEnd.z],
  narrow: [r.narrowEnd.x, r.narrowEnd.y, r.narrowEnd.z],
  matrix: r.matrix.elements,
}));
console.log(JSON.stringify(json));
