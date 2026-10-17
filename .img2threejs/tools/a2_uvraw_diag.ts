/**
 * a2 UV 原始值探针 · 直读工厂（适配器 remap 之前）的基元类型与 UV 值域。
 * 用途：判定「线性 remapUV（假设 UV 恒 0..1）」对哪些件已经失效。
 * 用法：
 *   node -e "require('./node_modules/esbuild/lib/main.js').build({entryPoints:['.img2threejs/tools/a2_uvraw_diag.ts'],bundle:true,format:'esm',platform:'node',outfile:'.img2threejs/tools/a2_uvraw_bundle.mjs',logLevel:'warning'})"
 *   node .img2threejs/tools/a2_uvraw_bundle.mjs
 */
import './a2_dom_shim.mjs';
import { createZunjieV800LuxuryMPVModel } from '../../src/model/createV800Model';
import * as THREE from 'three';

const group = createZunjieV800LuxuryMPVModel({} as never);

interface Row {
  id: string;
  name: string;
  prim: string;
  geo: string;
  groups: number;
  verts: number;
  tris: number;
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
  unit: boolean;
}

const rows: Row[] = [];
group.traverse((o) => {
  const m = o as THREE.Mesh;
  if (!m.isMesh) return;
  const comp = (m.userData as { sculptComponent?: { id?: string; primitive?: string; name?: string } })
    .sculptComponent;
  const id = comp?.id ?? '?';
  const uv = m.geometry.getAttribute('uv');
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  if (uv) {
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
  }
  const idx = m.geometry.getIndex();
  rows.push({
    id,
    name: comp?.name ?? m.name,
    prim: comp?.primitive ?? '?',
    geo: m.geometry.type,
    groups: m.geometry.groups?.length ?? 0,
    verts: m.geometry.getAttribute('position')?.count ?? 0,
    tris: idx ? idx.count / 3 : (m.geometry.getAttribute('position')?.count ?? 0) / 3,
    uMin, uMax, vMin, vMax,
    unit: uMin >= -1e-6 && uMax <= 1 + 1e-6 && vMin >= -1e-6 && vMax <= 1 + 1e-6
  });
});

const WATCH = new Set([
  'lantern-emitter-l', 'lantern-emitter-r',
  'taillamp-l', 'taillamp-r', 'headlamp-l', 'headlamp-r',
  'shield-emblem-panel', 'front-light-bar', 'bumper-light-strip',
  'lantern-signature-l', 'lantern-signature-r',
  'speaker-fl', 'speaker-fr', 'speaker-rl', 'speaker-rr', 'tweeter-l', 'tweeter-r',
  'tri-screen', 'rear-control-screen', 'seat-rear-l-screen', 'seat-rear-r-screen',
  'rear-reflector-l', 'rear-reflector-r', 'rear-reflector-strip-l', 'rear-reflector-strip-r',
  'wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr',
  'tire-fl', 'tire-fr', 'tire-rl', 'tire-rr'
]);

console.log('== 图集 remap 涉及件：工厂原始 UV 值域（unit=UV 恒 0..1）==');
const watchRows = rows.filter((r) => WATCH.has(r.id));
for (const r of watchRows) {
  console.log(
    `${r.id.padEnd(24)} prim=${r.prim.padEnd(12)} geo=${r.geo.padEnd(18)} groups=${String(r.groups).padStart(2)} ` +
    `tris=${String(r.tris).padStart(6)} uv=[${r.uMin.toFixed(3)}..${r.uMax.toFixed(3)} , ${r.vMin.toFixed(3)}..${r.vMax.toFixed(3)}] unit=${r.unit ? 'Y' : 'N ✗线性remap失效'}`
  );
}

console.log('\n== 全模型：非 0..1 UV 的件（按件数排序，前 40）==');
const nonUnit = rows.filter((r) => !r.unit).sort((a, b) => b.tris - a.tris);
console.log(`非 0..1 件数 ${nonUnit.length} / 总 ${rows.length}`);
const primCount = new Map<string, number>();
for (const r of nonUnit) primCount.set(r.prim, (primCount.get(r.prim) ?? 0) + 1);
console.log('基元分布：' + [...primCount.entries()].map(([k, v]) => `${k}=${v}`).join(' '));
for (const r of nonUnit.slice(0, 40)) {
  console.log(
    `  ${r.id.padEnd(26)} prim=${r.prim.padEnd(12)} tris=${String(r.tris).padStart(6)} ` +
    `uv=[${r.uMin.toFixed(3)}..${r.uMax.toFixed(3)} , ${r.vMin.toFixed(3)}..${r.vMax.toFixed(3)}]`
  );
}
