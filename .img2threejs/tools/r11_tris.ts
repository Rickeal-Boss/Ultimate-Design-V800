/** R11 三角数统计（裸工厂，node 侧精确计数） */
import './a2_dom_shim.mjs';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';
import * as THREE from 'three';

const model = createZunjieV800LuxuryMPVModel({ textureSize: 64 });
let tris = 0;
let meshes = 0;
const perComp = new Map<string, number>();
model.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const g = m.geometry as THREE.BufferGeometry;
  const c = g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
  tris += c;
  meshes++;
  const comp = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent;
  const key = comp?.id ?? m.name ?? '(unnamed)';
  perComp.set(key, (perComp.get(key) ?? 0) + c);
});
console.log(`MESHES=${meshes} TRIS=${Math.round(tris)}`);
const top = [...perComp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
for (const [k, v] of top) console.log(`TRI ${k} ${Math.round(v)}`);
