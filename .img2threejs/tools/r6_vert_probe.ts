/** R6 tumblehome 顶点级验证：glass 顶部 |x| 收窄、底部全宽 */
import './a2_dom_shim.mjs';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';
import * as THREE from 'three';

const model = createZunjieV800LuxuryMPVModel({ textureSize: 128 });
model.updateMatrixWorld(true);
model.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
  if (comp?.id !== 'greenhouse-glass') return;
  const pos = m.geometry.getAttribute('position');
  const v = new THREE.Vector3();
  let bottomMax = 0, topMax = 0;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(m.matrixWorld);
    if (v.y > 1.75) topMax = Math.max(topMax, Math.abs(v.x));
    else if (v.y < 1.15) bottomMax = Math.max(bottomMax, Math.abs(v.x));
  }
  console.log(`glass bottom |x|max=${bottomMax.toFixed(4)} (期望≈1.003)`);
  console.log(`glass top    |x|max=${topMax.toFixed(4)} (期望≈0.923, topScale 0.92)`);
});
