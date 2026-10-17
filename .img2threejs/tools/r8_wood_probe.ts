import './a2_dom_shim.mjs';
import { createV800CarAdapter } from '../../src/model/V800Adapter';
import * as THREE from 'three';

const car = createV800CarAdapter('high');
car.root.updateMatrixWorld(true);
const box = new THREE.Box3();
car.root.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const mat = m.material as THREE.MeshStandardMaterial;
  if (!mat || Array.isArray(mat)) return;
  if ((mat.name || '').includes('wood') || (m.name || '').includes('wood')) {
    box.setFromObject(m);
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    console.log(`name=${m.name} mat=${mat.name} center=(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}) size=(${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)})`);
    const ud = m.userData as Record<string, unknown>;
    console.log('  userData keys:', Object.keys(ud).join(','), ud.sculptBatchSources ? JSON.stringify(ud.sculptBatchSources).slice(0, 300) : '');
  }
});
