import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

function shim() {
  const REAL_DOC = (globalThis as { document?: unknown }).document;
  const REAL_WIN = (globalThis as { window?: unknown }).window;
  (globalThis as { document: unknown }).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') return {};
      return {
        width: 0, height: 0,
        getContext: () => {
          const grad = { addColorStop: () => {} };
          const ctx: Record<string, unknown> = {
            fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '', globalAlpha: 1,
            createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            getImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            putImageData: () => {}, fillRect: () => {}, strokeRect: () => {}, clearRect: () => {},
            drawImage: () => {}, fillText: () => {}, strokeText: () => {},
            translate: () => {}, rotate: () => {}, scale: () => {}, transform: () => {},
            save: () => {}, restore: () => {}, beginPath: () => {}, closePath: () => {},
            moveTo: () => {}, lineTo: () => {}, arc: () => {}, rect: () => {}, clip: () => {},
            bezierCurveTo: () => {}, quadraticCurveTo: () => {}, ellipse: () => {},
            createLinearGradient: () => grad, createRadialGradient: () => grad, createPattern: () => null,
            measureText: () => ({ width: 0 }),
          };
          return new Proxy(ctx, { get: (t, p) => (p in t ? t[p as string] : () => {}) });
        },
      };
    },
  };
  (globalThis as { window: unknown }).window = {
    devicePixelRatio: 2, location: { hash: '', href: '' },
    addEventListener: () => {}, removeEventListener: () => {},
    innerWidth: 1280, innerHeight: 720,
  };
  return () => {
    (globalThis as { document: unknown }).document = REAL_DOC;
    (globalThis as { window: unknown }).window = REAL_WIN;
  };
}

function applyCabinState(car: any) {
  const root = car.root as THREE.Object3D;
  root.updateMatrixWorld(true);
  // 隐藏前挡
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const arr = Array.isArray(o.material) ? o.material : [o.material];
    for (const mt of arr) {
      const id = (mt as any)?.userData?.sculptMaterial?.id;
      if (id === 'glass-clear') { o.visible = false; break; }
    }
  });
  for (const om of car.cabinOccluderMaterials) (om as THREE.Material).visible = false;
  car.setPaintShadow?.(true);
}

function visibleMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    let vis = true, n: any = o; while (n) { vis = vis && n.visible; n = n.parent; }
    if (!vis) return;
    const arr = Array.isArray(o.material) ? o.material : [o.material];
    if (arr.some((m: any) => m && m.visible === false)) return;
    out.push(o);
  });
  return out;
}

describe('cabin probe', () => {
  // 诊断探针（零业务断言，仅 console.log 输出 winding/see-through 证据）；
  // 全量套件争用下需 >5s ⇒ 显式放宽超时防随机红。座舱回归真判据在
  // tests/r31_cabin.test.ts（snap 契约 + 变异验证）。
  it('winding + see-through diagnosis', async () => {
    const restore = shim();
    const { createV800CarAdapter } = await import('../src/model/V800Adapter');
    const car: any = createV800CarAdapter('high');
    applyCabinState(car);
    const root = car.root;
    const eye = new THREE.Vector3(-0.40, 1.34, -0.72);
    const target = new THREE.Vector3(-0.30, 0.98, -9);
    const cam = new THREE.PerspectiveCamera(68, 16 / 9, 0.05, 200);
    cam.position.copy(eye); cam.lookAt(target); cam.updateMatrixWorld(true);

    const meshes = visibleMeshes(root);
    console.log(`[probe] 可见 mesh 数 = ${meshes.length}`);

    // frontPct：可见三角中「几何法线朝相机」占比（FrontSide 下这些才可见）
    const rows: any[] = [];
    for (const o of meshes) {
      const geo = o.geometry as THREE.BufferGeometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const idx = geo.getIndex();
      const m0: any = (Array.isArray(o.material) ? o.material[0] : o.material);
      const side = m0?.side;
      const triCount = idx ? idx.count / 3 : pos.count / 3;
      const step = Math.max(1, Math.floor(triCount / 300));
      let total = 0, front = 0;
      const getV = (i: number): [number, number, number] => [pos.array[i*3], pos.array[i*3+1], pos.array[i*3+2]];
      for (let t = 0; t < triCount; t += step) {
        let a: number, b: number, c: number;
        if (idx) { a = idx.array[t*3]; b = idx.array[t*3+1]; c = idx.array[t*3+2]; }
        else { a = t*3; b = t*3+1; c = t*3+2; }
        const pa = getV(a), pb = getV(b), pc = getV(c);
        const e1 = [pb[0]-pa[0], pb[1]-pa[1], pb[2]-pa[2]];
        const e2 = [pc[0]-pa[0], pc[1]-pa[1], pc[2]-pa[2]];
        let nx = e1[1]*e2[2]-e1[2]*e2[1], ny = e1[2]*e2[0]-e1[0]*e2[2], nz = e1[0]*e2[1]-e1[1]*e2[0];
        const nl = Math.hypot(nx,ny,nz) || 1; nx/=nl; ny/=nl; nz/=nl;
        const wa = new THREE.Vector3(pa[0],pa[1],pa[2]).applyMatrix4(o.matrixWorld);
        const view = [eye.x-wa.x, eye.y-wa.y, eye.z-wa.z];
        const vl = Math.hypot(view[0],view[1],view[2]) || 1;
        const dot = (nx*view[0]+ny*view[1]+nz*view[2])/vl;
        total++; if (dot > 0) front++;
      }
      const mid = (m0?.userData?.sculptMaterial?.id as string) ?? m0?.name ?? '';
      rows.push({ id: o.userData?.sculptComponent?.id ?? '(merged)', mid, side, frontPct: total ? Math.round(100*front/total) : -1, tris: Math.round(triCount) });
    }
    rows.sort((x, y) => x.frontPct - y.frontPct);
    console.log('[probe] 最低 frontPct 的 30 个可见 mesh（FrontSide 下被背面剔除的内表面）：');
    for (const r of rows.slice(0, 30))
      console.log(`  ${r.id.padEnd(20)}|${r.mid.padEnd(16)}|side ${r.side}|front ${String(r.frontPct).padStart(4)}%|tris ${r.tris}`);
    const shell = rows.filter(r => ['paint-upper','paint-lower','body-lower','root'].includes(r.mid) || ['body-lower','root'].includes(r.id));
    console.log('[probe] 车身外壳相关 mesh 的 frontPct：');
    for (const r of shell) console.log(`  ${r.id.padEnd(20)}|${r.mid.padEnd(16)}|side ${r.side}|front ${String(r.frontPct).padStart(4)}%|tris ${r.tris}`);

    // 射线网格：可见+受 side 影响，统计「被剔除看不到（命中远处/空）」比例
    function seeThrough(forceDouble: boolean) {
      if (forceDouble) for (const o of meshes) { const arr = Array.isArray(o.material)?o.material:[o.material]; for (const m of arr) (m as any).side = THREE.DoubleSide; }
      const rays: THREE.Raycaster[] = [];
      const N = 11;
      for (let iy=0; iy<N; iy++) for (let ix=0; ix<N; ix++) {
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2((ix/(N-1))*2-1, (iy/(N-1))*2-1), cam);
        rays.push(rc);
      }
      let near = 0, far = 0;
      for (const rc of rays) {
        const hits = rc.intersectObjects(meshes, true);
        if (hits.length === 0) { far++; continue; }
        if (hits[0].distance < 4) near++; else far++;
      }
      if (forceDouble) for (const o of meshes) { const arr = Array.isArray(o.material)?o.material:[o.material]; for (const m of arr) (m as any).side = THREE.FrontSide; }
      return { near, far, total: rays.length };
    }
    const before = seeThrough(false);
    const after = seeThrough(true);
    console.log(`[probe] 现状 FrontSide：近景命中 ${before.near}/${before.total}，看穿/远处 ${before.far}`);
    console.log(`[probe] 对照 DoubleSide：近景命中 ${after.near}/${after.total}，看穿/远处 ${after.far}`);
    restore();
    // 最小防回归：适配器能建、座舱态下仍有可见 mesh（全藏 = 座舱黑屏复燃）
    expect(meshes.length).toBeGreaterThan(20);
  }, 60000);
});
