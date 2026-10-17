/** R11 车头悬浮件排查：列出 y>0.95 且 z>0.6 区域所有 mesh 的世界 bbox */
import './a2_dom_shim.mjs';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';
import * as THREE from 'three';

const model = createZunjieV800LuxuryMPVModel({ textureSize: 64 });
model.updateMatrixWorld(true);
const box = new THREE.Box3();
const rows: { id: string; min: THREE.Vector3; max: THREE.Vector3; c: THREE.Vector3 }[] = [];
model.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
  box.setFromObject(m);
  const c = box.getCenter(new THREE.Vector3());
  // 车头上部区域：可能挡住/悬浮在挡风与机盖之间的件
  if (c.y > 1.72) {
    rows.push({ id: comp?.id ?? m.name ?? '?', min: box.min.clone(), max: box.max.clone(), c });
  }
});
rows.sort((a, b) => b.c.z - a.c.z);
for (const r of rows) {
  console.log(`NOSE ${r.id} y[${r.min.y.toFixed(2)}..${r.max.y.toFixed(2)}] z[${r.min.z.toFixed(2)}..${r.max.z.toFixed(2)}] x[${r.min.x.toFixed(2)}..${r.max.x.toFixed(2)}]`);
}
console.log('done');
