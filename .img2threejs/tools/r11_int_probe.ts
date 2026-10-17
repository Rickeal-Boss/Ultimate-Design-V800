/** R11 内饰探针：方向盘/屏/座椅世界 bbox */
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
  const id = comp?.id ?? '';
  if (!/^(steering|tri-screen|gauge-screen|dash-|seat-driver|seat-rear-l$|console-island|crystal-shifter)/.test(id)) return;
  box.setFromObject(m);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  console.log(`INT ${id} c=(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}) s=(${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)})`);
});
console.log('done');
