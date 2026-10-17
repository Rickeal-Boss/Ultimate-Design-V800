/** R12b 复检：座椅朝向/重排干涉 + 门板外移 + 轮罩板 + 包络 + tri/件数 */
import './a2_dom_shim.mjs';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';
import * as THREE from 'three';

const model = createZunjieV800LuxuryMPVModel({ textureSize: 64 });
model.updateMatrixWorld(true);

const box = new THREE.Box3();
const ids = new Set<string>();
const bboxOf = new Map<string, THREE.Box3>();
let triBase = 0;
let tris = 0;
model.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const cid = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent?.id;
  const key = cid ?? m.name ?? '?';
  if (cid) ids.add(cid);
  const g = m.geometry as THREE.BufferGeometry;
  const idx = g.getIndex();
  const inst = (m as unknown as { isInstancedMesh?: boolean; count?: number }).isInstancedMesh;
  const base = idx ? idx.count / 3 : g.getAttribute('position').count / 3;
  triBase += base;
  tris += base * (inst ? (m as unknown as { count: number }).count : 1);
  box.setFromObject(m);
  const prev = bboxOf.get(key);
  if (prev) { prev.min.min(box.min); prev.max.max(box.max); } else bboxOf.set(key, box.clone());
});

const whole = new THREE.Box3().setFromObject(model);
const ws = whole.getSize(new THREE.Vector3());
console.log(`WHOLE min=(${whole.min.x.toFixed(3)},${whole.min.y.toFixed(3)},${whole.min.z.toFixed(3)}) max=(${whole.max.x.toFixed(3)},${whole.max.y.toFixed(3)},${whole.max.z.toFixed(3)}) size=(${ws.x.toFixed(3)},${ws.y.toFixed(3)},${ws.z.toFixed(3)})`);
console.log(`COMPONENTS=${ids.size} TRIS(几何和)=${Math.round(triBase)} TRIS(含实例)=${Math.round(tris)}`);

const ENV = { x: 1.22, yMin: -0.11, yMax: 1.98, z: 2.96 };
const CONTAINERS = new Set(['root', 'cabin-interior']);
let out = 0;
for (const [id, b] of bboxOf) {
  if (CONTAINERS.has(id)) continue;
  const bad: string[] = [];
  if (Math.abs(b.min.x) > ENV.x || Math.abs(b.max.x) > ENV.x) bad.push('x');
  if (b.min.y < ENV.yMin) bad.push('yMin');
  if (b.max.y > ENV.yMax) bad.push('yMax');
  if (Math.abs(b.min.z) > ENV.z || Math.abs(b.max.z) > ENV.z) bad.push('z');
  if (bad.length) { out++; console.log(`ENVOUT ${id} [${bad.join(',')}] x[${b.min.x.toFixed(2)}..${b.max.x.toFixed(2)}] y[${b.min.y.toFixed(2)}..${b.max.y.toFixed(2)}] z[${b.min.z.toFixed(2)}..${b.max.z.toFixed(2)}]`); }
}
console.log(`ENVOUT_TOTAL=${out}`);

const show = (id: string) => {
  const b = bboxOf.get(id);
  if (!b) return console.log(`${id} MISSING`);
  console.log(`${id.padEnd(26)} x[${b.min.x.toFixed(3)}..${b.max.x.toFixed(3)}] y[${b.min.y.toFixed(3)}..${b.max.y.toFixed(3)}] z[${b.min.z.toFixed(3)}..${b.max.z.toFixed(3)}]`);
};
// 座椅族 + 关键内饰
const seatIds = [...bboxOf.keys()].filter((k) => /^seat-|^steering|^pedal|^dash-lower|^cabin-floor|^footwell/.test(k)).sort();
seatIds.forEach(show);

// 干涉检查（AABB）：座椅 vs 转向柱 / 座椅排间
const inter = (a?: THREE.Box3, b?: THREE.Box3) => !!(a && b && a.intersectsBox(b));
const pairs: Array<[string, string]> = [
  ['seat-driver-back', 'steering'],
  ['seat-driver', 'steering'],
  ['seat-driver', 'seat-rear-l'],
  ['seat-driver-back', 'seat-rear-l-back'],
  ['seat-rear-l', 'seat-third-row'],
  ['seat-rear-l-back', 'seat-third-row'],
  ['seat-third-row', 'tailgate'],
  ['pedal-brake-pad', 'seat-driver'],
];
for (const [a, b] of pairs) {
  const A = bboxOf.get(a);
  const B = bboxOf.get(b);
  if (!A || !B) { console.log(`INTER ${a} x ${b}: MISSING (${!!A}/${!!B})`); continue; }
  console.log(`INTER ${a} x ${b}: ${inter(A, B) ? 'OVERLAP' : 'clear'} (gapZ ${(A.min.z > B.max.z ? A.min.z - B.max.z : B.min.z - A.max.z).toFixed(3)})`);
}

// 门板外移验证
['door-panel-fl', 'door-panel-fr', 'door-panel-rl', 'door-panel-rr', 'body-lower'].forEach(show);
['footwell-arch-cover-l', 'footwell-arch-cover-r', 'arch-fr', 'arch-rr'].forEach(show);
