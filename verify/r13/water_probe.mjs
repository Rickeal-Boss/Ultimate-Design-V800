/**
 * r13 水带/高架桥探针 · esbuild bundle + node 直跑（无浏览器、无 GL）。
 * 验证目标：模块无运行时依赖错误、mesh/材质/三角量符合预算（DC≈5、tri≤3000）、
 * update() 贴图 offset 动画推进、dispose() 后场景清空。
 * 手法参考 .img2threejs/tools/a2_dom_shim.mjs（canvas 2D 全 noop，纹理内容由实机截图核验）。
 * 用法：node verify/r13/water_probe.mjs（在 brake-v800 根目录执行）
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '../..');

// ---- 最小 DOM/Canvas shim（纹理创建需要 document.createElement('canvas')）----
function make2DContext(canvas) {
  const noop = () => {};
  return {
    canvas,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    ellipse: noop,
    rect: noop,
    clip: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    clearRect: noop,
    fillText: noop,
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    setTransform: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    measureText: (t) => ({ width: t.length * 8 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop
  };
}
globalThis.document = {
  createElement: (tag) => {
    if (tag === 'canvas') {
      const canvas = { width: 300, height: 150, style: {}, getContext: (k) => (k === '2d' ? make2DContext(canvas) : null) };
      return canvas;
    }
    return { style: {} };
  },
  createElementNS: (_ns, tag) => globalThis.document.createElement(tag),
  getElementById: () => null,
  addEventListener: noop0,
  removeEventListener: noop0,
  body: { appendChild: () => {} }
};
function noop0() {}

// ---- 探针入口（TS，stdin 打包，resolveDir 指向 src/render/scene 以解析相对导入与 three）----
const entry = `
import * as THREE from 'three';
import { Waterway } from './Waterway';

const scene = new THREE.Scene();
const waterway = new Waterway(scene);

let meshes = 0, tris = 0;
const materials = new Set();
scene.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) {
    meshes++;
    const g = (o as THREE.Mesh).geometry;
    const pos = g.getAttribute('position');
    tris += (g.index ? g.index.count : pos.count) / 3;
    const m = (o as THREE.Mesh).material;
    (Array.isArray(m) ? m : [m]).forEach((mm) => materials.add(mm.uuid));
  }
});

// 动画推进两个时间点：offset 必须变化（且被 %1 卷绕）
waterway.update(1.234);
const offA = [waterway['colorTex'].offset.x, waterway['colorTex'].offset.y];
waterway.update(11.234);
const offB = [waterway['colorTex'].offset.x, waterway['colorTex'].offset.y];

waterway.dispose();
const objectsAfter = scene.children.length;

console.log('PROBE ' + JSON.stringify({
  meshes, materials: materials.size, tris: Math.round(tris), offA, offB, objectsAfter
}));
`;

const outfile = path.join(root, 'verify/r13/.water_probe.bundle.mjs');

await build({
  stdin: { contents: entry, loader: 'ts', resolveDir: path.join(root, 'src/render/scene') },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'warning'
});

// 拦截 bundle 的 PROBE 输出（同进程动态 import，console.log 直达本进程 stdout）
const lines = [];
const origLog = console.log;
console.log = (...args) => {
  const s = args.join(' ');
  if (s.startsWith('PROBE ')) lines.push(s.slice(6));
};
try {
  await import(pathToFileURL(outfile).href);
} finally {
  console.log = origLog;
}
fs.rmSync(outfile, { force: true });

if (lines.length === 0) throw new Error('probe 未输出 PROBE 行');
const stats = JSON.parse(lines[0]);
console.log('统计:', JSON.stringify(stats));

// ---- 断言（预算：DC≈5、tri≤3000；dispose 后场景清空；offset 推进且卷绕）----
const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};
if (stats.meshes !== 5) fail(`mesh 数应为 5（桥3+水1+护坡1），实际 ${stats.meshes}`);
if (stats.materials !== 4) fail(`材质数应为 4（混凝土/栏杆/水/土），实际 ${stats.materials}`);
if (stats.tris > 3000) fail(`三角量 ${stats.tris} 超预算 3000`);
if (stats.tris < 500) fail(`三角量 ${stats.tris} 异常偏少`);
if (stats.offA[1] === stats.offB[1]) fail('update 后颜色贴图 offset.y 未推进');
if (Math.abs(stats.offB[1]) >= 1) fail('offset.y 未做 %1 卷绕');
if (stats.objectsAfter !== 0) fail(`dispose 后场景应清空，剩余 ${stats.objectsAfter} 个对象`);
console.log('PASS: 模块加载/构建/动画/dispose 全部符合预期');
