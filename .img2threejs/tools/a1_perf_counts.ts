/**
 * a1 PERF.md 口径取数 · 直跑工厂（不经适配器），统计：
 *   1) 三角面总数（工厂口径）
 *   2) mesh 总数 / 有效可见数（自身 visible 且所有祖先 visible）
 *   3) 隐藏件清单（用于写在 PERF.md 口径注里）
 * 用法：
 *   node -e "require('./node_modules/esbuild/lib/main.js').build({entryPoints:['.img2threejs/tools/a1_perf_counts.ts'],bundle:true,format:'esm',platform:'node',outfile:'.img2threejs/tools/a1_perf_counts_bundle.mjs',logLevel:'warning'})"
 *   node .img2threejs/tools/a1_perf_counts_bundle.mjs
 */
import './a2_dom_shim.mjs';
import * as THREE from 'three';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';

const root = createZunjieV800LuxuryMPVModel({});
root.updateMatrixWorld(true);

let total = 0;
let visible = 0;
let tris = 0;
let trisVisible = 0;
const hidden: string[] = [];
const perPrim = new Map<string, { n: number; tris: number }>();

root.traverse((o: any) => {
  if (!o.isMesh) return;
  const mesh = o as THREE.Mesh;
  total += 1;
  const geo = mesh.geometry as THREE.BufferGeometry;
  const index = geo.getIndex();
  const t = (index ? index.count : geo.getAttribute('position').count) / 3;
  tris += t;

  let eff = mesh.visible;
  let p = mesh.parent;
  while (p) {
    if (!p.visible) { eff = false; break; }
    p = p.parent;
  }
  if (eff) {
    visible += 1;
    trisVisible += t;
  } else {
    hidden.push(`${String(o.userData?.sculptComponent?.id ?? o.name)} (selfVisible=${mesh.visible})`);
  }
  const prim = String(o.userData?.sculptComponent?.primitive ?? '?');
  const cur = perPrim.get(prim) ?? { n: 0, tris: 0 };
  cur.n += 1;
  cur.tris += t;
  perPrim.set(prim, cur);
});

console.log(`mesh total        = ${total}`);
console.log(`mesh visible      = ${visible}`);
console.log(`mesh hidden       = ${total - visible}`);
console.log(`tris total        = ${tris}`);
console.log(`tris visible      = ${trisVisible}`);
console.log('--- per primitive ---');
for (const [p, v] of [...perPrim.entries()].sort((a, b) => b[1].tris - a[1].tris)) {
  console.log(`  ${p.padEnd(12)} n=${String(v.n).padStart(3)}  tris=${String(Math.round(v.tris)).padStart(6)}`);
}
console.log('--- hidden components ---');
for (const h of hidden) console.log('  ' + h);
