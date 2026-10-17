/** R12b 前线部件包围盒 dump（鼻部窗口定位用） */
import './a2_dom_shim.mjs';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';
import * as THREE from 'three';

const model = createZunjieV800LuxuryMPVModel({ textureSize: 64 });
model.updateMatrixWorld(true);
const bbox = new Map<string, THREE.Box3>();
model.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const cid = (m.userData as { sculptComponent?: { id?: string } }).sculptComponent?.id;
  if (!cid) return;
  const b = new THREE.Box3().setFromObject(m);
  const prev = bbox.get(cid);
  if (prev) { prev.min.min(b.min); prev.max.max(b.max); } else bbox.set(cid, b.clone());
});
const re = /emblem|maextro|shield|front-light|brow|headlamp|lamp|front-end|hood|bumper|vent|fender|grille|plate|mirror/;
for (const [id, b] of [...bbox].sort()) {
  if (!re.test(id)) continue;
  console.log(id.padEnd(26), `x[${b.min.x.toFixed(3)}..${b.max.x.toFixed(3)}] y[${b.min.y.toFixed(3)}..${b.max.y.toFixed(3)}] z[${b.min.z.toFixed(3)}..${b.max.z.toFixed(3)}]`);
}
