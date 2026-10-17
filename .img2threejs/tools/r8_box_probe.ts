import './a2_dom_shim.mjs';
import { createV800CarAdapter } from '../../src/model/V800Adapter';
import * as THREE from 'three';

const car = createV800CarAdapter('high');
car.root.updateMatrixWorld(true);
const box = new THREE.Box3();
let total = 0;
car.root.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const g = m.geometry as THREE.BufferGeometry;
  total += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  box.union(new THREE.Box3().setFromObject(m));
});
console.log('TOTAL tri', Math.round(total), 'box', box.getSize(new THREE.Vector3()));
const box2 = new THREE.Box3();
car.root.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const b = new THREE.Box3().setFromObject(m);
  if (b.max.y > 2.1 || Math.abs(b.max.x) > 1.15 || Math.abs(b.min.x) > 1.15) {
    const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
    console.log('TALL/WIDE', comp?.id ?? m.name, 'maxY', b.max.y.toFixed(2), 'x[', b.min.x.toFixed(2), b.max.x.toFixed(2), ']');
  }
});
// 轮子实际位置与旋转中心
for (const w of car.wheels) {
  const wp = new THREE.Vector3();
  w.spin.getWorldPosition(wp);
  const b = new THREE.Box3().setFromObject(w.spin);
  const c = b.getCenter(new THREE.Vector3());
  console.log('spin world pos', wp.toArray().map(v=>v.toFixed(3)).join(','), 'meshcenter', c.toArray().map(v=>v.toFixed(3)).join(','), 'size', b.getSize(new THREE.Vector3()).toArray().map(v=>v.toFixed(3)).join(','));
}
