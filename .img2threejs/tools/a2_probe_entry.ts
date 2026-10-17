/**
 * a2 探针入口 · 无浏览器直跑真实工厂/适配器（用法同 MEMORY.md「Node shim 实测法」）。
 * 用法：
 *   npx esbuild .img2threejs/tools/a2_probe_entry.ts --bundle --format=esm \
 *     --outfile=.img2threejs/tools/a2_probe_bundle.mjs --platform=node --log-level=warning
 *   node .img2threejs/tools/a2_probe_bundle.mjs [tier]
 * 输出：材质参数表 / 指定材质用户清单（UV 包围盒 + 三角形数）。
 */
import './a2_dom_shim.mjs';
(globalThis as { window: { location: { hash: string } } }).window.location.hash = '#uvassert+lightassert+batchmerge';
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

// ---- 4) 几何诊断：指定组件（第 5 参数，逗号分隔）的 groups / parameters / UV 分段 ----
const diagIds = (process.argv[4] ?? '').split(',').filter(Boolean);
if (diagIds.length > 0) {
  console.log('\n== geometry diagnostics ==');
  const diagNode = (id: string): THREE.Object3D | null => {
    let found: THREE.Object3D | null = null;
    car.root.traverse((o) => {
      const cid = (o.userData.sculptComponent as { id?: string } | undefined)?.id;
      if (!found && cid === id) found = o;
    });
    return found;
  };
  for (const id of diagIds) {
    const node = diagNode(id);
    if (!node) { console.log(`-- ${id} -- (未找到)`); continue; }
    console.log(`-- ${id} --`);
    node.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const geo = m.geometry;
      const params = (geo as unknown as { parameters?: Record<string, number> }).parameters;
      const uv = geo.getAttribute('uv');
      const pos = geo.getAttribute('position');
      const box = new THREE.Box3().setFromObject(m);
      console.log(
        `  mesh name=${m.name} groups=${JSON.stringify(geo.groups)} ` +
        `params=${params ? JSON.stringify(params) : 'NONE'} verts=${pos?.count ?? 0} tris=${geo.index ? geo.index.count / 3 : (pos?.count ?? 0) / 3}`
      );
      console.log(
        `  world bbox min=(${box.min.x.toFixed(3)},${box.min.y.toFixed(3)},${box.min.z.toFixed(3)}) ` +
        `max=(${box.max.x.toFixed(3)},${box.max.y.toFixed(3)},${box.max.z.toFixed(3)})`
      );
      if (uv && geo.groups && geo.groups.length === 3) {
        // 逐 group 抽样 UV：验证 cylinder 分组顺序（side/top/bottom）与帽面 UV 约定
        const idx = geo.getIndex();
        for (let gi = 0; gi < geo.groups.length; gi++) {
          const g = geo.groups[gi];
          let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
          let yAtVmin = 0, yAtVmax = 0;
          let maxDiscR2 = 0;
          for (let t = g.start; t < g.start + g.count; t++) {
            const vi = idx ? idx.getX(t) : t;
            const u = uv.getX(vi), v = uv.getY(vi);
            const y = pos ? pos.getY(vi) : 0;
            if (u < uMin) uMin = u; if (u > uMax) uMax = u;
            if (v < vMin) { vMin = v; yAtVmin = y; }
            if (v > vMax) { vMax = v; yAtVmax = y; }
            const r2 = (u - 0.5) * (u - 0.5) + (v - 0.5) * (v - 0.5);
            if (r2 > maxDiscR2) maxDiscR2 = r2;
          }
          console.log(
            `  group${gi}(mat${g.materialIndex}) tris=${g.count / 3} uv=[${uMin.toFixed(3)}..${uMax.toFixed(3)},${vMin.toFixed(3)}..${vMax.toFixed(3)}]` +
            ` localY@vMin=${yAtVmin.toFixed(3)} localY@vMax=${yAtVmax.toFixed(3)}` +
            ` discR2max=${maxDiscR2.toFixed(4)}${gi > 0 ? (maxDiscR2 <= 0.2501 ? ' (≤0.25 帽面内切圆 ✓)' : ' (非内切圆 ✗)') : ''}`
          );
        }
      }
    });
  }
}

// ---- 5) 运行时朝向核验：轮标 billboard + 迎宾光毯（相机在侧视 QA 机位）----
console.log('\n== runtime orientation ==');
const cam = new THREE.PerspectiveCamera(30, 2.78, 0.1, 100);
cam.position.set(6.5, 1.6, 0); // 侧视 + 略俯（QA 复拍机位量级）
cam.lookAt(0, 0.6, 0);
car.update(cam, 1 / 60);
const capNode = (() => {
  let found: THREE.Object3D | null = null;
  car.root.traverse((o) => {
    const cid = (o.userData.sculptComponent as { id?: string } | undefined)?.id;
    if (!found && (cid === 'wheel-cap-fl' || cid === 'wheel-cap-fr')) found = o;
  });
  return found;
})();
if (capNode) {
  const box = new THREE.Box3().setFromObject(capNode);
  const wq = capNode.getWorldQuaternion(new THREE.Quaternion());
  const n = new THREE.Vector3(0, 1, 0).applyQuaternion(wq); // 盘面法线（局部 +Y）
  const up = new THREE.Vector3(1, 0, 0).applyQuaternion(wq); // 徽标上沿（局部 +X）
  const toCam = cam.position.clone().sub(box.getCenter(new THREE.Vector3())).normalize();
  console.log(
    `wheel-cap(${capNode.userData.sculptComponent.id}) bbox ` +
    `x[${box.min.x.toFixed(3)},${box.max.x.toFixed(3)}] y[${box.min.y.toFixed(3)},${box.max.y.toFixed(3)}] z[${box.min.z.toFixed(3)},${box.max.z.toFixed(3)}] ` +
    `normal=(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}) badgeUp=(${up.x.toFixed(2)},${up.y.toFixed(2)},${up.z.toFixed(2)}) ` +
    `facingCam=${n.dot(toCam).toFixed(3)}`
  );
}
const tireNode = (() => {
  let found: THREE.Object3D | null = null;
  car.root.traverse((o) => {
    const cid = (o.userData.sculptComponent as { id?: string } | undefined)?.id;
    if (!found && cid === 'tire-fl') found = o;
  });
  return found;
})();
if (tireNode) {
  // 胎侧字环"上"= 轮胎网格局部 +X（帽面 UV 约定：v=1 在 θ=π/2 = 局部 +X）
  const mesh = (() => {
    let f: THREE.Mesh | null = null;
    tireNode.traverse((o) => { if (!f && (o as THREE.Mesh).isMesh) f = o as THREE.Mesh; });
    return f;
  })();
  if (mesh) {
    const wq = mesh.getWorldQuaternion(new THREE.Quaternion());
    const up = new THREE.Vector3(1, 0, 0).applyQuaternion(wq);
    console.log(`tire-fl letterUp=(${up.x.toFixed(2)},${up.y.toFixed(2)},${up.z.toFixed(2)}) (1,0,0)=世界正上 ✓)`);
  }
}
const carpet = car.root.getObjectByName('welcome-carpet');
if (carpet) {
  const box = new THREE.Box3().setFromObject(carpet);
  const mat = (carpet as THREE.Mesh).material as THREE.MeshBasicMaterial;
  console.log(
    `welcome-carpet bbox x[${box.min.x.toFixed(2)},${box.max.x.toFixed(2)}] y[${box.min.y.toFixed(3)},${box.max.y.toFixed(3)}] z[${box.min.z.toFixed(2)},${box.max.z.toFixed(2)}] ` +
    `opacity=${mat.opacity.toFixed(3)} visible=${carpet.visible}`
  );
}

// ---- 6) PERF.md #19 修订判据的多机位实测（task #18）：三项点积 ----
// 盘面法线 = 节点局部 +Y；徽标上沿 = 局部 +X；读向 = 局部 +Z。
// 新判据：① 法线水平指向相机 normal·toCamH > 0.99；② 上沿对齐世界上 up·(0,1,0) > 0.99；
//         ③ 读向水平 |read·(0,1,0)| < 0.05 且与视线垂直 |read·viewDir| < 0.1。
// 对照：旧判据（世界四元数 == 相机四元数）下 ① ≈ 0.01（盘面朝上平躺、侧对相机）。
console.log('\n== billboard criterion sweep (PERF.md #19 revision) ==');
const capFl = (() => {
  let found: THREE.Object3D | null = null;
  car.root.traverse((o) => {
    const cid = (o.userData.sculptComponent as { id?: string } | undefined)?.id;
    if (!found && cid === 'wheel-cap-fl') found = o;
  });
  return found;
})();
if (capFl) {
  const MODES: Array<[string, number, number, number]> = [
    ['side(QA)', 4.6, 1.5, 0.6],
    ['chase', 1.6, 2.2, 8.2],
    ['orbit-0', 7.8, 1.5, 0],
    ['orbit-90', 0, 1.5, 7.8],
    ['orbit-180', -7.8, 1.5, 0],
    ['orbit-270', 0, 1.5, -7.8],
    ['hood', 0, 1.45, 1.45],
    ['cabin', 0.55, 1.16, 0.45],
    ['crash', 9, 4.5, 13],
    ['low-side', 4.6, 0.5, 0.6]
  ];
  const wq = new THREE.Quaternion();
  const nV = new THREE.Vector3();
  const upV = new THREE.Vector3();
  const rdV = new THREE.Vector3();
  const ctr = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  const toCamH = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  capFl.getWorldPosition(ctr);
  for (const [name, cx2, cy2, cz2] of MODES) {
    cam.position.set(cx2, cy2, cz2);
    cam.lookAt(ctr.x, ctr.y, ctr.z);
    car.update(cam, 1 / 60);
    capFl.getWorldQuaternion(wq);
    nV.set(0, 1, 0).applyQuaternion(wq);
    upV.set(1, 0, 0).applyQuaternion(wq);
    rdV.set(0, 0, 1).applyQuaternion(wq);
    toCam.subVectors(cam.position, ctr).normalize();
    toCamH.set(toCam.x, 0, toCam.z).normalize();
    console.log(
      `  ${name.padEnd(10)} normal·toCamH=${nV.dot(toCamH).toFixed(3)} ` +
      `normal·toCam=${nV.dot(toCam).toFixed(3)} ` +
      `up·worldUp=${upV.dot(WORLD_UP).toFixed(3)} ` +
      `|read·worldUp|=${Math.abs(rdV.dot(WORLD_UP)).toFixed(3)} ` +
      `|read·viewDir|=${Math.abs(rdV.dot(toCam)).toFixed(3)}`
    );
  }
  // 车体扰动（crash 翻滚量级）：billboard 按父链局部折算，判据应仍然成立
  const body0 = car.body.rotation.clone();
  for (const [tag, rx, rz] of [['pitch+0.3', 0.3, 0], ['roll+0.5', 0, 0.5], ['yaw+pitch+roll', 0.4, 0.25]] as Array<[string, number, number]>) {
    car.body.rotation.set(Math.PI + rx * 0.2, Math.PI, rz);
    for (const [cn, cx2, cy2, cz2] of [['side', 4.6, 1.5, 0.6], ['chase', 1.6, 2.2, 8.2]] as Array<[string, number, number, number]>) {
      cam.position.set(cx2, cy2, cz2);
      car.update(cam, 1 / 60);
      capFl.getWorldQuaternion(wq);
      capFl.getWorldPosition(ctr);
      nV.set(0, 1, 0).applyQuaternion(wq);
      upV.set(1, 0, 0).applyQuaternion(wq);
      rdV.set(0, 0, 1).applyQuaternion(wq);
      toCam.subVectors(cam.position, ctr).normalize();
      toCamH.set(toCam.x, 0, toCam.z).normalize();
      console.log(
        `  ${tag.padEnd(14)}${cn.padEnd(7)} normal·toCamH=${nV.dot(toCamH).toFixed(3)} ` +
        `up·worldUp=${upV.dot(WORLD_UP).toFixed(3)} ` +
        `|read·worldUp|=${Math.abs(rdV.dot(WORLD_UP)).toFixed(3)} ` +
        `|read·viewDir|=${Math.abs(rdV.dot(toCam)).toFixed(3)}`
      );
    }
  }
  car.body.rotation.copy(body0);
  car.update(cam, 1 / 60);
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
