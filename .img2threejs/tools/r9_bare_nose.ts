/** 裸工厂：找 z 中心 > 2.7 或 < -2.9 的组件（悬板定位） */
import './a2_dom_shim.mjs';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';
import * as THREE from 'three';

const model = createZunjieV800LuxuryMPVModel({ textureSize: 64 });
model.updateMatrixWorld(true);
const box = new THREE.Box3();
model.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
  box.setFromObject(m);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  if (c.z > 2.7 || c.z < -2.9) {
    console.log(`OUT ${comp?.id ?? m.name} center=(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}) size=(${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)})`);
  }
});
console.log('done');
