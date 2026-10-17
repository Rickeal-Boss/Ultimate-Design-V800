import './a2_dom_shim.mjs';
import { createV800CarAdapter } from '../../src/model/V800Adapter';
import * as THREE from 'three';

const car = createV800CarAdapter('high');
car.root.updateMatrixWorld(true);
car.root.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  const mid = mats.map((mt) => (mt as THREE.MeshPhysicalMaterial)?.userData?.sculptMaterial?.id).join('|');
  if (mid !== 'wood') return;
  const b = new THREE.Box3().setFromObject(m);
  const c = b.getCenter(new THREE.Vector3());
  const s = b.getSize(new THREE.Vector3());
  console.log(`name=${m.name} center=(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}) size=(${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)})`);
  console.log('  sources:', JSON.stringify((m.userData as Record<string, unknown>).sculptBatchSources ?? []).slice(0, 400));
});
