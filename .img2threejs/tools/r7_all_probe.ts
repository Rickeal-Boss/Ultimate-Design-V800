/** 全组件 bbox 扫描：找出任何越出车体包络的件（车长 ±2.9、宽 ±1.1、高 0~1.95） */
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
  const id = comp?.id;
  if (!id || seen.has(id)) return;
  seen.add(id);
  box.setFromObject(m);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  if (c.z < -2.95 || c.z > 2.95 || Math.abs(c.x) > 1.15 || c.y < -0.05 || c.y > 2.0) {
    console.log(`OUT ${id.padEnd(26)} center=(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}) size=(${s.x.toFixed(2)},${s.y.toFixed(2)},${s.z.toFixed(2)})`);
  }
});
console.log('scan done');
