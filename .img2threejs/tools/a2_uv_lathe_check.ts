/**
 * a2 探针 · R4 lathe 帽面 UV 复核（EX-34 胎侧字环 / EX-33 轮心盾徽）。
 * 判据（与 CylinderGeometry.generateCap 约定同口径，见 three r186 源码）：
 *   ① 帽面 UV 必须是**平面内切圆**：分区局部坐标 (su,sv) 的圆心 = (0.5,0.5)，
 *      max((su-0.5)²+(sv-0.5)²) ≤ 0.25（半径 0.5 的内切圆，超了就采到分区外）；
 *   ② 帽面三角形数与母线首/末带一致（轮胎 48 段 → 2 带 ×48×2 = 192/胎）；
 *   ③ 帽面 v 增大方向 = 网格局部 +X（旧 cylinder 帽面约定：v=1 在 θ=π/2
 *      = 局部 +X），适配器实测该方向应指向世界正上方 (0,1,0)。
 * 用法：esbuild 打包后 `node <bundle>.mjs`
 */
import './a2_dom_shim.mjs';
import { createV800CarAdapter } from '../../src/model/V800Adapter';
import * as THREE from 'three';

const car = createV800CarAdapter('high');
car.root.updateMatrixWorld(true);

const findNode = (id: string): THREE.Object3D | null => {
  let f: THREE.Object3D | null = null;
  car.root.traverse((o) => {
    const c = o.userData.sculptComponent as { id?: string } | undefined;
    if (!f && c?.id === id) f = o;
  });
  return f;
};

interface Case {
  id: string;
  region: [number, number, number, number]; // [u0,u1,v0,v1]
  expectCapTris: number;
}
const CASES: Case[] = [
  { id: 'tire-fl', region: [0.5, 1, 0, 1], expectCapTris: 192 },
  { id: 'wheel-cap-fl', region: [0, 1, 0, 1], expectCapTris: 144 }
];

console.log('== R4 lathe 帽面 UV 复核 ==');
for (const c of CASES) {
  const node = findNode(c.id);
  if (!node) {
    console.log(`${c.id}: 未找到 ✗`);
    continue;
  }
  let mesh: THREE.Mesh | null = null;
  node.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!mesh && m.isMesh && m.userData.sculptComponent?.id === c.id) mesh = m;
  });
  if (!mesh) {
    console.log(`${c.id}: 无自有 mesh ✗`);
    continue;
  }
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position');
  const uvA = geo.getAttribute('uv');
  const idx = geo.getIndex();
  // 帽面副本识别：**不能用 |y|** —— R4 复制了交界环，交界处两份副本的 |y| 相同
  // （都在平帽面所在的母线端平面上），只有 UV 不同。改用「UV 是否满足平面内切圆
  // 公式 su=0.5+0.5·(z/rMax)、sv=0.5+0.5·(x/rMax)」判定，顺带直接验证公式本身。
  let rMax = 0;
  for (let i = 0; i < pos.count; i++) {
    rMax = Math.max(rMax, Math.hypot(pos.getX(i), pos.getZ(i)));
  }
  const [pu0, pu1, pv0, pv1] = c.region;
  const isCap = (vi: number): boolean => {
    const su = (uvA.getX(vi) - pu0) / (pu1 - pu0);
    const sv = (uvA.getY(vi) - pv0) / (pv1 - pv0);
    return (
      Math.abs(su - (0.5 + 0.5 * (pos.getZ(vi) / rMax))) < 2e-3 &&
      Math.abs(sv - (0.5 + 0.5 * (pos.getX(vi) / rMax))) < 2e-3
    );
  };
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const vid = (t: number, k: number): number => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
  let capTris = 0;
  let bandTris = 0;
  let mixed = 0;
  let cx = 0;
  let cy = 0;
  let n = 0;
  let maxR2 = 0;
  let outOfRegion = 0;
  const [u0, u1, v0, v1] = c.region;
  for (let t = 0; t < triCount; t++) {
    const a = vid(t, 0);
    const b = vid(t, 1);
    const d = vid(t, 2);
    const capCount = (isCap(a) ? 1 : 0) + (isCap(b) ? 1 : 0) + (isCap(d) ? 1 : 0);
    if (capCount === 3) {
      capTris++;
      for (const vi of [a, b, d]) {
        const su = (uvA.getX(vi) - u0) / (u1 - u0);
        const sv = (uvA.getY(vi) - v0) / (v1 - v0);
        cx += su;
        cy += sv;
        n++;
        maxR2 = Math.max(maxR2, (su - 0.5) * (su - 0.5) + (sv - 0.5) * (sv - 0.5));
        if (su < -1e-6 || su > 1 + 1e-6 || sv < -1e-6 || sv > 1 + 1e-6) outOfRegion++;
      }
    } else if (capCount === 0) {
      bandTris++;
    } else {
      mixed++;
    }
  }
  // ③ 朝向：帽面 v 增大方向应为网格局部 +X（= 世界正上方）
  const wq = mesh.getWorldQuaternion(new THREE.Quaternion());
  const localX = new THREE.Vector3(1, 0, 0).applyQuaternion(wq);
  console.log(
    `${c.id.padEnd(14)} geo=${geo.type.padEnd(15)} tris=${String(triCount).padStart(5)} ` +
    `帽面三角=${String(capTris).padStart(4)}/${c.expectCapTris} 筒身三角=${String(bandTris).padStart(4)} ` +
    `跨区三角=${mixed}${mixed === 0 ? ' ✓' : ' ✗'}`
  );
  console.log(
    `${''.padEnd(14)} 内切圆圆心=(${cx / n === cx / n ? (cx / n).toFixed(3) : '?'},${(cy / n).toFixed(3)}) ` +
    `期望(0.500,0.500) maxR²=${maxR2.toFixed(4)} 期望≤0.25 ${maxR2 <= 0.2501 ? '✓' : '✗'} ` +
    `越界顶点=${outOfRegion}${outOfRegion === 0 ? ' ✓' : ' ✗'}`
  );
  console.log(
    `${''.padEnd(14)} 帽面 v 增大方向(局部+X→世界)=(${localX.x.toFixed(2)},${localX.y.toFixed(2)},${localX.z.toFixed(2)}) ` +
    `期望(0.00,1.00,0.00) ${Math.abs(localX.y - 1) < 0.02 ? '✓ 字环正立' : '✗'}`
  );
}
car.dispose();
