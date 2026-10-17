/**
 * R5 轮位实测：工厂裸模型里 wheel 与 tire 与 rim 与 arch 系列 的世界包围盒。
 * 用法：esbuild bundle 后 node 直跑（复用 a2_dom_shim）。
 */
import './a2_dom_shim.mjs';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';
import * as THREE from 'three';

const model = createZunjieV800LuxuryMPVModel({ textureSize: 256 });
model.updateMatrixWorld(true);
const ids = ['body-lower','greenhouse-glass','roof-panel','front-end','tailgate','chrome-belt-l','chrome-belt-r','dpillar-l','dpillar-r','tire-fl','tire-rl','wheel-fl'];
const box = new THREE.Box3();
model.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
  const id = comp?.id;
  if (!id || !ids.includes(id)) return;
  box.setFromObject(m);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  console.log(`${id.padEnd(18)} center=(${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)}) size=(${s.x.toFixed(3)},${s.y.toFixed(3)},${s.z.toFixed(3)})`);
});
