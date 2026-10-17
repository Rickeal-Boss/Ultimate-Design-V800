/** R7 内饰落位验证：所有 cabin-interior 子件世界 bbox 必须在车体包络内 */
import './a2_dom_shim.mjs';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';
import * as THREE from 'three';

const model = createZunjieV800LuxuryMPVModel({ textureSize: 64 });
model.updateMatrixWorld(true);
const box = new THREE.Box3();
const bad: string[] = [];
let found = 0;
model.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
  const id = comp?.id;
  if (!id) return;
  if (!/^(seat-|dash-|tri-screen|gauge-screen|steering|tunnel-|crystal|charge-pad|cupholder|headliner|overhead|ambient-strip|speaker-|tweeter|curtain-|starlight|cabin-floor|trunk-floor|vents|rear-control|console-)/.test(id)) return;
  found++;
  box.setFromObject(m);
  const c = box.getCenter(new THREE.Vector3());
  const ok = c.z > -2.9 && c.z < 2.9 && c.y > 0 && c.y < 1.9 && Math.abs(c.x) < 1.05;
  if (!ok) bad.push(`${id} center=(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)})`);
});
console.log(`内饰 mesh 组件数: ${found}, 越界: ${bad.length}`);
for (const b of bad) console.log('  OUT', b);
