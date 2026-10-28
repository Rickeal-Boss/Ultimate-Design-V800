/**
 * R32 D 线 · 车模材质实例治理回归（D-1）。
 *
 * 背景（外部审查 P0「材质实例复用 77 → 40 以内」的适配层落地 R30-C4 的续作）：
 * 合批按**材质实例**分桶（batchMerge 不复制材质）⇒ 多一个同参实例就多一个 batch
 * 桶、多一份 uniform 提交。本测试锁四条契约：
 *
 *  1. 装配后材质实例总数 ≤ `V800_MATERIAL_INSTANCE_BUDGET`。
 *     ⚠ **R37 账实校正（旧注「当前 78」已作废）**：实测 **80，预算 80 ⇒ 余量 0**
 *     （探针口径：装配后遍历 root 按 material.uuid 去重计数，与下面 `records.length` 同源）。
 *     历史：R32-D1 前后绿牌共用 1 个实例 ⇒ 79 → 78；此后 R33~R36 的车模细化
 *     （轮毂开口 / 徽标内芯 / 尾门折线等）逐步把余额吃满到 80。
 *     ⇒ **R37 起余量为 0：新增任何材质实例立刻红**。要加实例必须先合并掉一个
 *     （例如找一组「同 sculptMaterial.id + 同全量参数签名」的非行为旗标件共用，
 *     判据见本文件 isBehavioural）。
 *     R37-C 多色车漆**没有**加重这一点：换色是改既有实例的 color/参数，
 *     0 新实例（tests/r37_paint.test.ts 已逐色断言实例数不变）。
 *     ⚠ 上限常量**只**定义在 `src/model/V800Adapter.ts`（`V800_MATERIAL_INSTANCE_BUDGET`
 *     / `V800_ASSEMBLED_TRI_BUDGET` / `V800_VISIBLE_TRI_BUDGET` / `v800MaterialSignature`），
 *     本文件一律 import 消费，**不得再抄写数字或自造签名表** —— 手写数与实现漂移
 *     会让红线形同虚设（这是 R32-D1 对本测试做的首要加固）。提高上限 = 明确的预算
 *     决策，须改那一处常量并写明理由（注释就在常量旁边，改漏的概率最低）；

 *  2. 去重后置条件：任一「同 sculptMaterial.id + 同全量参数签名」实例组里，
 *     不带行为旗标的成员 ≤ 1。行为旗标 = cabinHidable（座舱遮挡整批显隐）/
 *     cabinPaintShadow（内舱暗面切换）/ refTexture（参考图克隆，UV 已按目标件
 *     重写在几何侧）—— 这三类必须保持独立实例，合并即毁功能；
 *  3. 前后绿牌确实共用同一材质实例（D-1 唯一可落地的合并：createGreenPlateTexture
 *     自 R18 起忽略 text，两块牌贴图逐位一致）；
 *  4. 座舱遮挡克隆与同 id 的可见材质是不同实例（隐藏遮挡不连带隐藏可见件）；
 *  5. tri 双口径红线（所含隐藏占位几何 ~19.9k 的说明见
 *     .qa/r32_tmp_car/D1_material_merge.md）。
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
// ⚠ 不能静态 import '../src/model/V800Adapter'：适配器 → src/config/quality.ts 在
// **模块求值期**就读 `window.devicePixelRatio`（TIERS 表），而 DOM shim 是在 test 体内
// 才装上的 ⇒ 静态导入会在 collect 阶段抛 `window is not defined`（已实证）。
// 故统一走 **动态 import**：在 shim 装好之后取模块命名空间，预算常量与签名函数都从
// 命名空间上读 —— 依然是「单一真源在适配器」，只是取得时机推迟到运行期。

/** 与 tests/_probe_cabin.test.ts 同款 Node DOM shim（无 GL、无网络） */
function shim(): () => void {
  const REAL_DOC = (globalThis as { document?: unknown }).document;
  const REAL_WIN = (globalThis as { window?: unknown }).window;
  (globalThis as { document: unknown }).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext: () => {
          const grad = { addColorStop: () => {} };
          const ctx: Record<string, unknown> = {
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 0,
            font: '',
            textAlign: '',
            globalAlpha: 1,
            createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            getImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            putImageData: () => {},
            fillRect: () => {},
            strokeRect: () => {},
            clearRect: () => {},
            drawImage: () => {},
            fillText: () => {},
            strokeText: () => {},
            translate: () => {},
            rotate: () => {},
            scale: () => {},
            transform: () => {},
            save: () => {},
            restore: () => {},
            beginPath: () => {},
            closePath: () => {},
            moveTo: () => {},
            lineTo: () => {},
            arc: () => {},
            rect: () => {},
            clip: () => {},
            bezierCurveTo: () => {},
            quadraticCurveTo: () => {},
            ellipse: () => {},
            createLinearGradient: () => grad,
            createRadialGradient: () => grad,
            createConicGradient: () => grad,
            createPattern: () => null,
            measureText: () => ({ width: 0 })
          };
          return new Proxy(ctx, { get: (t, p) => (p in t ? t[p as string] : () => {}) });
        }
      };
    }
  };
  (globalThis as { window: unknown }).window = {
    devicePixelRatio: 2,
    location: { hash: '', href: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1280,
    innerHeight: 720
  };
  return () => {
    (globalThis as { document: unknown }).document = REAL_DOC;
    (globalThis as { window: unknown }).window = REAL_WIN;
  };
}

interface MatRecord {
  mat: THREE.Material;
  id: string | null;
  skip: boolean;
  signature: string;
  meshes: THREE.Mesh[];
}

/**
 * 行为旗标判定：与 V800Adapter R30-C4/R32-D1 去重器的跳过名单同语。
 * 这三类材质在**实例级**承载运行时语义，合并即毁功能 ⇒ 去重器必须跳过它们，
 * 测试也必须允许「同 id + 同签名」的它们并存。
 */
function isBehavioural(mat: THREE.Material): boolean {
  const ud = mat.userData as {
    cabinHidable?: boolean;
    cabinPaintShadow?: boolean;
    refTexture?: unknown;
  };
  return ud.cabinHidable === true || ud.cabinPaintShadow === true || ud.refTexture !== undefined;
}

/**
 * 适配器的签名函数**延迟注入**（避免静态 import，理由见文件头）。
 * 这里刻意留一个会炸的默认实现：万一有人改回静态导入路径 / 忘了注入，测试会明确报
 * 「签名函数未注入」，而不是拿到空签名把「同 id 不同参」误判成可并、让红线失效。
 */
let materialSignature: (m: THREE.Material) => string = () => {
  throw new Error('v800MaterialSignature 未注入：请在 shim 装好后从适配器模块命名空间取');
};

function collectMaterials(root: THREE.Object3D): MatRecord[] {
  const byUuid = new Map<string, MatRecord>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const arr = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mt of arr) {
      if (!mt) continue;
      let rec = byUuid.get(mt.uuid);
      if (!rec) {
        rec = {
          mat: mt,
          id: ((mt.userData as { sculptMaterial?: { id?: string } }).sculptMaterial?.id) ?? null,
          // 行为旗标：实例级运行时语义，合并即毁功能 ⇒ 去重器必须跳过
          skip: isBehavioural(mt),
          signature: materialSignature(mt),
          meshes: []
        };
        byUuid.set(mt.uuid, rec);
      }
      rec.meshes.push(mesh);
    }
  });
  return [...byUuid.values()];
}

describe('R32 D-1 车模材质实例治理', () => {
  it(
    '材质实例 ≤ 预算常量 / 去重后置条件 / 绿牌共实例 / 遮挡隔离 / tri 双口径 ≤ 预算常量',
    async () => {
      const restore = shim();
      try {
        // 预算常量 + 签名函数统一从模块命名空间取（单一真源在 V800Adapter.ts）
        const mod = await import('../src/model/V800Adapter');
        const {
          createV800CarAdapter,
          V800_MATERIAL_INSTANCE_BUDGET,
          V800_ASSEMBLED_TRI_BUDGET,
          V800_VISIBLE_TRI_BUDGET,
          v800MaterialSignature
        } = mod;
        materialSignature = v800MaterialSignature;
        const car = createV800CarAdapter('high');
        const root = car.root;

        const records = collectMaterials(root);
        const instances = records.length;

        // ── 1. 实例总数上限 ──
        // 消费的是「上限常量」而不是巧合的字面量 ⇒ 顺带断言常量本身可用
        // （有人把 budget 改成 undefined/0 时，`<= undefined` 恒 false、报的是
        //  看不懂的错；这条把病灶钉在常量上）。
        expect(instances).toBeLessThanOrEqual(V800_MATERIAL_INSTANCE_BUDGET);
        expect(Number.isFinite(V800_MATERIAL_INSTANCE_BUDGET)).toBe(true);
        expect(V800_MATERIAL_INSTANCE_BUDGET).toBeGreaterThan(0);

        // ── 2. 去重后置条件：同 id + 同签名组里无行为旗标成员 ≤ 1 ──
        const groups = new Map<string, MatRecord[]>();
        for (const r of records) {
          if (!r.id) continue; // 无 id 材质（贴花/地毯）不走同 id 合并通道
          const key = `${r.id}|${r.signature}`;
          const g = groups.get(key);
          if (g) g.push(r);
          else groups.set(key, [r]);
        }
        for (const [key, g] of groups) {
          const mergeable = g.filter((r) => !r.skip);
          expect(mergeable.length, `同签名的可合并实例超过 1 个：${key.slice(0, 90)}`).toBeLessThanOrEqual(1);
        }

        // ── 3. 前后绿牌共用同一材质实例 ──
        const plates: THREE.Mesh[] = [];
        root.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          if (mesh.name === 'license-plate-front' || mesh.name === 'license-plate-rear') plates.push(mesh);
        });
        expect(plates.length).toBe(2);
        const plateMats = new Set(plates.map((m) => (m.material as THREE.Material).uuid));
        expect(plateMats.size, '前后绿牌应共用 1 个材质实例（R32-D1）').toBe(1);

        // ── 4. 座舱遮挡克隆与同 id 可见材质互为独立实例 ──
        const occluders = (car.cabinOccluderMaterials ?? []) as THREE.Material[];
        expect(occluders.length).toBeGreaterThanOrEqual(2);
        expect(new Set(occluders.map((m) => m.uuid)).size).toBe(occluders.length); // 互不相同
        for (const m of occluders) {
          expect((m.userData as { cabinHidable?: boolean }).cabinHidable).toBe(true);
        }
        const countVisibleByMatId = (matId: string): number => {
          let n = 0;
          root.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            for (let c: THREE.Object3D | null = o; c; c = c.parent) if (c.visible === false) return;
            const mt = mesh.material as THREE.Material | undefined;
            // material.visible=false 与对象隐藏同效（合批按材质显隐的语义，见 Game.ts）
            if (mt && mt.visible === false) return;
            if ((mt?.userData as { sculptMaterial?: { id?: string } } | undefined)?.sculptMaterial?.id === matId) {
              n += 1;
            }
          });
          return n;
        };
        const woodBefore = countVisibleByMatId('wood');
        expect(woodBefore).toBeGreaterThanOrEqual(2); // 可见 wood + 座舱遮挡克隆并存
        // 隐藏遮挡材质后，同 id 的可见件必须仍在（证明遮挡是独立实例、没被并掉）
        for (const m of occluders) m.visible = false;
        const woodVisibleAfter = countVisibleByMatId('wood');
        for (const m of occluders) m.visible = true;
        expect(woodVisibleAfter).toBeGreaterThanOrEqual(1);
        expect(woodVisibleAfter).toBeLessThan(woodBefore);

        // ── 5. tri 双口径红线（可见 + #assembled 全量，常量同样取自适配器）──
        const triOf = (geo: THREE.BufferGeometry): number => {
          const i = geo.getIndex();
          return (i ? i.count : geo.getAttribute('position').count) / 3;
        };
        const meshVisible = (o: THREE.Object3D): boolean => {
          for (let c: THREE.Object3D | null = o; c; c = c.parent) if (c.visible === false) return false;
          return true;
        };
        let triVisible = 0;
        let triAssembled = 0;
        root.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const t = triOf(mesh.geometry) * ((mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1);
          triAssembled += t;
          if (meshVisible(o)) triVisible += t;
        });
        expect(triVisible).toBeLessThanOrEqual(V800_VISIBLE_TRI_BUDGET);
        expect(triAssembled).toBeLessThanOrEqual(V800_ASSEMBLED_TRI_BUDGET);

        car.dispose();
      } finally {
        restore();
      }
    },
    30000
  );
});
