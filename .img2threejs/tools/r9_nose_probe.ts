import './a2_dom_shim.mjs';
import { createV800CarAdapter } from '../../src/model/V800Adapter';
import * as THREE from 'three';

const car = createV800CarAdapter('high');
car.root.updateMatrixWorld(true);
const box = new THREE.Box3();
car.root.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  if (m.visible === false) return;
  box.setFromObject(m);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  // 鼻端之外（z < -2.9）或高度异常（y>1.95）
  if (c.z < -2.9 || s.z > 2.9) {
    const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
    console.log(`NOSE-OUT ${comp?.id ?? m.name} center=(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}) size=(${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)}) vis=${m.visible}`);
  }
});
console.log('done');
