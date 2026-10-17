/** 按世界 |z| 极值排序，揪出拉长整车 bbox 的组件 */
import './a2_dom_shim.mjs';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';
import * as THREE from 'three';

const model = createZunjieV800LuxuryMPVModel({ textureSize: 64 });
model.updateMatrixWorld(true);
const box = new THREE.Box3();
const rows: { id: string; maxz: number; minz: number }[] = [];
const seen = new Set<string>();
model.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
  const id = comp?.id;
  if (!id || seen.has(id)) return;
  seen.add(id);
  box.setFromObject(m);
  rows.push({ id, maxz: box.max.z, minz: box.min.z });
});
rows.sort((a, b) => Math.max(Math.abs(b.maxz), Math.abs(b.minz)) - Math.max(Math.abs(a.maxz), Math.abs(a.minz)));
for (const r of rows.slice(0, 8)) console.log(`${r.id.padEnd(26)} maxZ=${r.maxz.toFixed(3)} minZ=${r.minz.toFixed(3)}`);
