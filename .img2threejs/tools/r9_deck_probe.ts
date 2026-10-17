/** 裸工厂：机盖台面区域（y1.0-1.35, z1.5-2.7）的网格与材质 */
import './a2_dom_shim.mjs';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';
import * as THREE from 'three';

const model = createZunjieV800LuxuryMPVModel({ textureSize: 64 });
model.updateMatrixWorld(true);
const box = new THREE.Box3();
const seen = new Set<string>();
model.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
  const id = comp?.id ?? '?';
  if (seen.has(id)) return;
  box.setFromObject(m);
  const c = box.getCenter(new THREE.Vector3());
  if (c.y > 1.0 && c.y < 1.4 && c.z > 1.4 && c.z < 2.75) {
    seen.add(id);
    const mat = m.material as THREE.MeshStandardMaterial;
    const s = box.getSize(new THREE.Vector3());
    console.log(`${id.padEnd(22)} mat=${(mat?.userData?.sculptMaterial?.id ?? mat?.type ?? '?') .toString().padEnd(12)} center=(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}) size=(${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)})`);
  }
});
console.log('done');
