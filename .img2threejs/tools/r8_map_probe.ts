/** 找出轮拱区域附近、材质带 map 的所有 mesh（定位橙色大理石纹串味源） */
import './a2_dom_shim.mjs';
import { createV800CarAdapter } from '../../src/model/V800Adapter';
import * as THREE from 'three';

const car = createV800CarAdapter('high');
car.root.updateMatrixWorld(true);
const box = new THREE.Box3();
const seen = new Set<THREE.Material>();
car.root.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const mat = m.material as THREE.MeshStandardMaterial;
  if (!mat || Array.isArray(mat)) return;
  const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
  const id = comp?.id ?? m.name ?? '(merged)';
  box.setFromObject(m);
  const c = box.getCenter(new THREE.Vector3());
  // 轮拱区域：y 0.5-1.0，z |1.3-2.2|
  if (c.y > 0.4 && c.y < 1.1 && Math.abs(c.z) > 1.2 && Math.abs(c.z) < 2.4) {
    console.log(`${id.padEnd(24)} mat=${(mat.name || mat.type).padEnd(20)} hasMap=${!!mat.map} color=#${mat.color.getHexString()} center=(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)})`);
  }
});
