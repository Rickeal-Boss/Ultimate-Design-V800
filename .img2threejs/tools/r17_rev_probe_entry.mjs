// R17a 落地审查探针入口：shim + 双工厂，输出全部 mesh 世界包围盒。
// 由 r17_rev_build.mjs 用 esbuild 打包成单文件后 node 直跑（无浏览器）。
import './a2_dom_shim.mjs';
import * as THREE from 'three';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';
import { createLuxeedR7Model } from '../../src/model/createR7Model';
import fs from 'node:fs';

const OUT = 'C:/Users/16896/WorkBuddy/2026-10-14-13-25-01/brake-v800/verify/r17a';
const which = process.env.WHICH || 'both';

function probe(name, root) {
  root.updateMatrixWorld(true);
  const out = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const cid = String(o.userData?.sculptComponent?.id ?? o.name);
    const isInst = !!o.isInstancedMesh;
    const bb = new THREE.Box3().setFromObject(o);
    out.push({
      id: cid,
      inst: isInst,
      min: [bb.min.x, bb.min.y, bb.min.z].map((v) => Math.round(v * 1e4) / 1e4),
      max: [bb.max.x, bb.max.y, bb.max.z].map((v) => Math.round(v * 1e4) / 1e4),
      size: [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z].map((v) => Math.round(v * 1e4) / 1e4),
    });
  });
  fs.writeFileSync(`${OUT}/probe_${name}.json`, JSON.stringify(out));
  console.log(`[${name}] meshes=${out.length} -> ${OUT}/probe_${name}.json`);
  return out;
}

if (which === 'v800' || which === 'both') {
  const m = createZunjieV800LuxuryMPVModel({});
  probe('v800', m);
}
if (which === 'r7' || which === 'both') {
  const m = createLuxeedR7Model({});
  probe('r7', m);
}
console.log('PROBE DONE');
process.exit(0);
