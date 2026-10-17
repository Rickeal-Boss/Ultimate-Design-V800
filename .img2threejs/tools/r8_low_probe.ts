import './a2_dom_shim.mjs';
import { createV800CarAdapter } from '../../src/model/V800Adapter';
import * as THREE from 'three';

const car = createV800CarAdapter('high');
car.root.updateMatrixWorld(true);
car.root.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const b = new THREE.Box3().setFromObject(m);
  if (b.min.y < -0.1) {
    const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
    const s = b.getSize(new THREE.Vector3());
    console.log('LOW', comp?.id ?? m.name, 'minY', b.min.y.toFixed(2), 'maxY', b.max.y.toFixed(2), 'size', s.toArray().map(v=>v.toFixed(2)).join(','));
  }
});
for (const w of car.wheels) {
  const wp = new THREE.Vector3(); w.spin.getWorldPosition(wp);
  const b = new THREE.Box3().setFromObject(w.spin);
  const c = b.getCenter(new THREE.Vector3());
  console.log('spin@', wp.z.toFixed(3), 'meshcenter@', c.z.toFixed(3));
}
