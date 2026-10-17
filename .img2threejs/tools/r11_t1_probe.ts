/** R11-T1 探针：整车 bbox + 轮组件世界中心 + z 极值组件清单 */
import './a2_dom_shim.mjs';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';
import * as THREE from 'three';

const model = createZunjieV800LuxuryMPVModel({ textureSize: 64 });
model.updateMatrixWorld(true);
const whole = new THREE.Box3().setFromObject(model);
const wc = whole.getCenter(new THREE.Vector3());
const ws = whole.getSize(new THREE.Vector3());
console.log(`WHOLE bbox min=(${whole.min.x.toFixed(3)},${whole.min.y.toFixed(3)},${whole.min.z.toFixed(3)}) max=(${whole.max.x.toFixed(3)},${whole.max.y.toFixed(3)},${whole.max.z.toFixed(3)})`);
console.log(`WHOLE size=(${ws.x.toFixed(3)},${ws.y.toFixed(3)},${ws.z.toFixed(3)}) center=(${wc.x.toFixed(3)},${wc.y.toFixed(3)},${wc.z.toFixed(3)})`);

const box = new THREE.Box3();
const rows: { id: string; c: THREE.Vector3; s: THREE.Vector3 }[] = [];
model.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
  box.setFromObject(m);
  rows.push({ id: comp?.id ?? m.name ?? '(unnamed)', c: box.getCenter(new THREE.Vector3()), s: box.getSize(new THREE.Vector3()) });
});

// 轮组件
for (const r of rows) {
  if (/wheel|tire|rim|cap|brake/i.test(r.id)) {
    console.log(`WHEELPART ${r.id} center=(${r.c.x.toFixed(3)},${r.c.y.toFixed(3)},${r.c.z.toFixed(3)}) size=(${r.s.x.toFixed(3)},${r.s.y.toFixed(3)},${r.s.z.toFixed(3)})`);
  }
}

// z 极值：车头最前（max z 前 8 件）、车尾最后（min z 前 5 件）
const byMaxZ = [...rows].sort((a, b) => (b.c.z + b.s.z / 2) - (a.c.z + a.s.z / 2));
console.log('--- FRONT-MOST (mesh maxZ) ---');
for (const r of byMaxZ.slice(0, 10)) console.log(`FRONT ${r.id} minZ=${(r.c.z - r.s.z / 2).toFixed(3)} maxZ=${(r.c.z + r.s.z / 2).toFixed(3)} y=${r.c.y.toFixed(3)}`);
const byMinZ = [...rows].sort((a, b) => (a.c.z - a.s.z / 2) - (b.c.z - b.s.z / 2));
console.log('--- REAR-MOST (mesh minZ) ---');
for (const r of byMinZ.slice(0, 6)) console.log(`REAR ${r.id} minZ=${(r.c.z - r.s.z / 2).toFixed(3)} maxZ=${(r.c.z + r.s.z / 2).toFixed(3)} y=${r.c.y.toFixed(3)}`);

// 轮拱相关
for (const r of rows) {
  if (/arch|fender|body-lower|side/i.test(r.id)) {
    console.log(`ARCH? ${r.id} center=(${r.c.x.toFixed(3)},${r.c.y.toFixed(3)},${r.c.z.toFixed(3)}) size=(${r.s.x.toFixed(3)},${r.s.y.toFixed(3)},${r.s.z.toFixed(3)})`);
  }
}
console.log(`COMP_COUNT(rows)=${rows.length}`);
console.log('done');
