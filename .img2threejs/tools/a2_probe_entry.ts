/**
 * a2 探针入口 · 无浏览器直跑真实工厂/适配器（用法同 MEMORY.md「Node shim 实测法」）。
 * 用法：
 *   npx esbuild .img2threejs/tools/a2_probe_entry.ts --bundle --format=esm \
 *     --outfile=.img2threejs/tools/a2_probe_bundle.mjs --platform=node --log-level=warning
 *   node .img2threejs/tools/a2_probe_bundle.mjs [tier]
 * 输出：材质参数表 / 指定材质用户清单（UV 包围盒 + 三角形数）。
 */
import './a2_dom_shim.mjs';
(globalThis as { window: { location: { hash: string } } }).window.location.hash = '#uvassert';
import { createV800CarAdapter } from '../../src/model/V800Adapter';
import * as THREE from 'three';

type QualityTier = 'high' | 'medium' | 'low';
const tier = ((process.argv[2] ?? 'high') as QualityTier);

const car = createV800CarAdapter(tier);

// ---- 1) 材质参数表（按材质 ID 去重）----
const matById = new Map<string, THREE.MeshPhysicalMaterial>();
car.root.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const arr = Array.isArray(m.material) ? m.material : [m.material];
  for (const mt of arr) {
    const id = (mt as THREE.MeshPhysicalMaterial).userData?.sculptMaterial?.id as string | undefined;
    if (id && !matById.has(id)) matById.set(id, mt as THREE.MeshPhysicalMaterial);
  }
});
console.log('== material table (tier=' + tier + ') ==');
for (const [id, mat] of [...matById.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(
    `${id.padEnd(16)} trans=${mat.transmission.toFixed(2)} transparent=${mat.transparent} op=${mat.opacity.toFixed(2)}` +
    ` color=#${mat.color.getHexString()} metal=${mat.metalness.toFixed(2)} rough=${mat.roughness.toFixed(2)}` +
    ` map=${mat.map ? 'Y' : '-'} nmap=${mat.normalMap ? 'Y' : '-'} emap=${mat.emissiveMap ? 'Y' : '-'}`
  );
}

// ---- 2) 指定材质的用户清单（组件 ID / UV 包围盒 / 三角形 / primitive）----
const targets = process.argv[3] ? process.argv[3].split(',') : ['lamp-gold', 'leather-warm'];
console.log('\n== material users ==');
for (const target of targets) {
  console.log(`-- ${target} --`);
  car.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const hit = mats.some(
      (mt) => (mt as THREE.MeshPhysicalMaterial).userData?.sculptMaterial?.id === target
    );
    if (!hit) return;
    const cid =
      (m.userData.sculptComponent as { id?: string } | undefined)?.id ??
      (m.userData.component as { id?: string } | undefined)?.id ??
      m.name;
    const prim = (m.userData.sculptComponent as { primitive?: string } | undefined)?.primitive ?? '?';
    const uv = m.geometry.getAttribute('uv');
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    if (uv) {
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i), v = uv.getY(i);
        if (u < uMin) uMin = u; if (u > uMax) uMax = u;
        if (v < vMin) vMin = v; if (v > vMax) vMax = v;
      }
    }
    const tris = m.geometry.index ? m.geometry.index.count / 3 : (m.geometry.getAttribute('position')?.count ?? 0) / 3;
    console.log(
      `  ${cid.padEnd(28)} prim=${prim.padEnd(12)} tris=${String(tris).padStart(6)} ` +
      `uv=[${uv ? uMin.toFixed(3) + '..' + uMax.toFixed(3) + ' , ' + vMin.toFixed(3) + '..' + vMax.toFixed(3) : 'NONE'}]`
    );
  });
}

// ---- 3) 总量 ----
let meshes = 0, tris = 0;
car.root.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  meshes++;
  tris += m.geometry.index ? m.geometry.index.count / 3 : (m.geometry.getAttribute('position')?.count ?? 0) / 3;
});
console.log(`\ntotal: ${meshes} meshes, ${tris} triangles`);
car.dispose();
