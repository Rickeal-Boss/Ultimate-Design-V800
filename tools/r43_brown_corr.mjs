/**
 * R43-P0B · 「深棕墙」逐像素定罪（真实 GPU 实拍图 × 探针首命中 对账）
 *
 * 输入：`verify/r41/d1_parapet_along_ALL.png`（R41 线上实拍，同机位已知）
 * 输出：仰角桶 × 「是否有几何」→ 该处实拍平均色；以及 #382c24 族像素的首命中分布
 *
 * 判据（为什么这就够了）：
 *   若某块像素「视线在地平线以下」且「场景里没有任何几何」而实拍色恒为同一个值，
 *   那这块像素只能来自**天空球**（唯一一个永远画满全屏的件），且它的着色器在该区间
 *   是纯 `uGround`（Environment.ts:101）⇒ 它不是材质、不是光照暗面、不是任何 mesh。
 *   等价于洋红 MeshBasic 测试，且更强：连「有没有件在前面」都一并排除。
 */
import fs from 'node:fs';
import { THREE, env, visibleMeshes, makeCam, raster, decodePNG } from './r43_occlusion_lib.mjs';

const REF = 'verify/r41/d1_parapet_along_ALL.png';
const POSE = { eye: [12.24, 1.6, 40], tgt: [6, 1, -300], fov: 62 };
const W = 640, H = 380;

const { width: RW, height: RH, rgba } = decodePNG(fs.readFileSync(REF));
const E = env();
const ms = visibleMeshes(E.scene);
const cam = makeCam(POSE.eye, POSE.tgt, POSE.fov, W, H);
const r = raster(ms, cam, W, H);

const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
const tanY = Math.tan((POSE.fov * Math.PI) / 360), tanX = tanY * (W / H);
const d = new THREE.Vector3();

const bins = {};
const add = (k, c) => { (bins[k] ||= { n: 0, s: [0, 0, 0] }); bins[k].n += 1; bins[k].s[0] += c[0]; bins[k].s[1] += c[1]; bins[k].s[2] += c[2]; };
let darkN = 0, darkNoGeom = 0;
const tally = {};
for (let py = 0; py < H; py += 2) {
  for (let px = 0; px < W; px += 2) {
    const nx = ((px + 0.5) / W) * 2 - 1, ny = 1 - ((py + 0.5) / H) * 2;
    d.copy(fwd).addScaledVector(right, nx * tanX).addScaledVector(up, ny * tanY).normalize();
    const deg = (Math.asin(Math.max(-1, Math.min(1, d.y))) * 180) / Math.PI;
    const mi = r.label[py * W + px];
    const rx = Math.min(RW - 1, Math.round((px / W) * RW));
    const ry = Math.min(RH - 1, Math.round((py / H) * RH));
    const o = (ry * RW + rx) * 4;
    const c = [rgba[o], rgba[o + 1], rgba[o + 2]];
    let b = deg > 5 ? 'elev>+5' : deg > 0 ? '0..+5' : deg > -2 ? '-2..0' : deg > -5 ? '-5..-2' : deg > -15 ? '-15..-5' : '<-15';
    add(b + (mi >= 0 ? '/几何' : '/空'), c);
    // #382c24 族 + 首命中分布
    if (Math.abs(c[0] - 0x38) < 6 && Math.abs(c[1] - 0x2c) < 6 && Math.abs(c[2] - 0x24) < 6) {
      darkN += 1;
      if (mi < 0) darkNoGeom += 1;
      const k = mi < 0 ? '(空)' : r.names[mi];
      tally[k] = (tally[k] || 0) + 1;
    }
  }
}
console.log(`参考图 ${REF}  探针机位 eye${JSON.stringify(POSE.eye)} tgt${JSON.stringify(POSE.tgt)} fov${POSE.fov}`);
console.log('仰角桶 × 是否有几何 → 实拍平均色');
for (const [k, v] of Object.entries(bins).sort()) {
  const c = v.s.map((x) => Math.round(x / v.n));
  console.log('  ' + k.padEnd(14) + String(v.n).padStart(6) + '  px  avg #' + c.map((x) => x.toString(16).padStart(2, '0')).join(''));
}
console.log(`\n#382c24 族像素 ${darkN} 个，其中探针无首命中 ${darkNoGeom} 个 = ${(100 * darkNoGeom / darkN).toFixed(1)}%`);
console.log('其余首命中分布：', Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));
