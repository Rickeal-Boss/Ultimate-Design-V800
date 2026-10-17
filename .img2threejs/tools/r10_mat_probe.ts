/** 适配层：机盖台面/腰带区域的 mesh 及其材质（找大理石纹载体） */
import './a2_dom_shim.mjs';
import { createV800CarAdapter } from '../../src/model/V800Adapter';
import * as THREE from 'three';

const car = createV800CarAdapter('high');
car.root.updateMatrixWorld(true);
const box = new THREE.Box3();
const seen = new Set<string>();
car.root.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh || m.visible === false) return;
  const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
  const id = comp?.id ?? m.name;
  if (seen.has(id)) return;
  box.setFromObject(m);
  const c = box.getCenter(new THREE.Vector3());
  // 腰带/机盖外部带区：y 0.95-1.35, |x|>0.6, z -2.5..2.7
  if (c.y > 0.95 && c.y < 1.4 && Math.abs(c.x) > 0.55) {
    seen.add(id);
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const mid = mats.map((mt) => (mt as THREE.MeshPhysicalMaterial)?.userData?.sculptMaterial?.id ?? (mt as THREE.MeshPhysicalMaterial)?.name ?? mt?.type).join('|');
    const hasMap = mats.some((mt) => (mt as THREE.MeshPhysicalMaterial)?.map);
    console.log(`${id.padEnd(24)} mat=${mid.padEnd(14)} map=${hasMap} center=(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)})`);
  }
});
console.log('done');
