/**
 * R37-C · 开始界面车辆多色选择（色表 / 装配落色 / 预算不改）回归。
 *
 * 锁四条契约：
 *  ① 色表：5 色齐全（香槟金默认 / 曜石黑 / 珍珠白 / 明黄 / 深空蓝），默认档 = 香槟金；
 *  ② **默认档逐位不动**：不换色时车模外观必须等于 R36 基线 —— 这是本轮最大的回归风险
 *     （色表一旦写错，所有默认用户的车都会变色）；
 *  ③ **0 新材质实例**：换色只改既有实例，材质实例数不涨（预算 80 铁律）；
 *  ④ 换色确实落到 `material.userData.sculptMaterial.id` 对应的漆面上（v800 双拼
 *     paint-upper/paint-lower；r7 单支 paint-green，且 null = 保留原厂墨绿）。
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_PAINT_ID,
  FACTORY_PAINT_CHOICE,
  PAINT_IDS,
  PAINT_MATERIAL_IDS,
  PAINT_SPECS,
  applyPaintSlot,
  getPaintSpec,
  paintChoicesFor,
  paintChoiceLabel,
  resolveAssemblyPaintId,
  resolvePaintChoiceFor,
  setActivePaint,
  type PaintChoice
} from '../src/config/vehiclePaint';

/** 与 tests/r32_car_material.test.ts 同款 Node DOM shim（无 GL、无网络） */
function shim(): () => void {
  const REAL_DOC = (globalThis as { document?: unknown }).document;
  const REAL_WIN = (globalThis as { window?: unknown }).window;
  const REAL_LS = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { document: unknown }).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext: () =>
          new Proxy({} as Record<string, unknown>, {
            get: (_t, p) => {
              if (p === 'createImageData' || p === 'getImageData')
                return (w: number, h: number) => ({
                  data: new Uint8ClampedArray(w * h * 4),
                  width: w,
                  height: h
                });
              if (p === 'measureText') return () => ({ width: 0 });
              if (p === 'createLinearGradient' || p === 'createRadialGradient')
                return () => ({ addColorStop: () => {} });
              if (p === 'createPattern') return () => null;
              return () => {};
            },
            set: () => true
          })
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
  delete (globalThis as { localStorage?: unknown }).localStorage;
  return () => {
    (globalThis as { document: unknown }).document = REAL_DOC;
    (globalThis as { window: unknown }).window = REAL_WIN;
    if (REAL_LS !== undefined) (globalThis as { localStorage: unknown }).localStorage = REAL_LS;
  };
}

/** 装配树里按 sculptMaterial.id 取材质实例（与适配层同口径，勿按组件 id） */
function matById(root: THREE.Object3D, id: string): THREE.MeshPhysicalMaterial | null {
  let hit: THREE.MeshPhysicalMaterial | null = null;
  root.traverse((o) => {
    if (hit) return;
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const arr = Array.isArray(m.material) ? m.material : [m.material];
    for (const mt of arr) {
      const mid = (mt as THREE.MeshPhysicalMaterial | undefined)?.userData?.sculptMaterial?.id as
        | string
        | undefined;
      if (mid === id) {
        hit = mt as THREE.MeshPhysicalMaterial;
        return;
      }
    }
  });
  return hit;
}

function countMaterials(root: THREE.Object3D): number {
  const set = new Set<string>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const arr = Array.isArray(m.material) ? m.material : [m.material];
    for (const mt of arr) if (mt) set.add(mt.uuid);
  });
  return set.size;
}

/** 色表期望色（把 hsl 偏移算进去，与 applyPaintSlot 同式） */
function expectedHex(slot: ReturnType<typeof getPaintSpec>['upper']): number {
  const c = new THREE.Color(slot.color);
  if (slot.hsl) c.offsetHSL(slot.hsl[0], slot.hsl[1], slot.hsl[2]);
  return c.getHex();
}

describe('R37-C 车漆色表', () => {
  it('5 色齐全 + 默认档 = 香槟金（第一项）', () => {
    expect(PAINT_IDS).toEqual(['champagne', 'obsidian', 'pearl', 'amber', 'deepblue']);
    expect(DEFAULT_PAINT_ID).toBe('champagne');
    expect(PAINT_SPECS[0].id).toBe(DEFAULT_PAINT_ID);
    for (const s of PAINT_SPECS) {
      expect(s.label.length, s.id).toBeGreaterThan(0);
      expect(s.swatch, s.id).toMatch(/^#[0-9a-f]{6}$/i);
      // 上段必填；数值都在合法区间（写错成 1.5 的金属度会在渲染期才炸）
      expect(s.upper.metalness).toBeGreaterThanOrEqual(0);
      expect(s.upper.metalness).toBeLessThanOrEqual(1);
      expect(s.upper.roughness).toBeGreaterThan(0);
      expect(s.upper.roughness).toBeLessThanOrEqual(1);
      expect(s.upper.envMapIntensity).toBeGreaterThan(0);
    }
  });

  it('指定取向：黑=高亮清漆、白=低金属度', () => {
    const black = getPaintSpec('obsidian');
    const white = getPaintSpec('pearl');
    const gold = getPaintSpec('champagne');
    // 曜石黑：清漆拉满 + 清漆粗糙度最低 ⇒ 纯黑也能读出高光
    expect(black.upper.clearcoat).toBe(1.0);
    expect(black.upper.clearcoatRoughness!).toBeLessThan(0.06);
    expect(black.upper.envMapIntensity).toBeGreaterThan(gold.upper.envMapIntensity);
    // 珍珠白：金属度必须显著低于金属漆档（金属度一高白漆就发灰发蓝）
    expect(white.upper.metalness).toBeLessThan(0.2);
    expect(white.upper.metalness).toBeLessThan(gold.upper.metalness);
    // 明黄/深空蓝都应有明确色相（不与默认金撞色）
    const amberHex = getPaintSpec('amber').upper.color;
    const blueHex = getPaintSpec('deepblue').upper.color;
    expect(amberHex).not.toBe(gold.upper.color);
    expect(blueHex).not.toBe(gold.upper.color);
  });

  it('默认档不覆写 clearcoat（沿用工厂值 ⇒ R36 外观逐位不动）', () => {
    const champagne = getPaintSpec('champagne');
    expect(champagne.upper.clearcoat).toBeUndefined();
    expect(champagne.lower!.clearcoat).toBeUndefined();
    // 其余 4 色是新增外观，允许（且需要）覆写清漆
    for (const id of ['obsidian', 'pearl', 'amber', 'deepblue'] as const) {
      expect(getPaintSpec(id).upper.clearcoat, id).toBeDefined();
    }
  });

  it('菜单项：V800 = 5 色；R7 = 原厂墨绿 + 5 色，且有中文名', () => {
    expect(paintChoicesFor('v800')).toEqual(PAINT_IDS);
    expect(paintChoicesFor('v800')).not.toContain(FACTORY_PAINT_CHOICE);
    expect(paintChoicesFor('r7')[0]).toBe(FACTORY_PAINT_CHOICE);
    expect(paintChoicesFor('r7')).toHaveLength(PAINT_IDS.length + 1);
    for (const c of paintChoicesFor('r7')) {
      expect(paintChoiceLabel(c), String(c)).toMatch(/[一-龥]/);
    }
  });
});

describe('R37-C 装配落色（V800 双拼 / R7 单支）', () => {
  it(
    '默认档 = R36 基线色；换色后色变但材质实例数不涨（0 新实例）',
    async () => {
      const restore = shim();
      try {
        const mod = await import('../src/model/V800Adapter');
        const base = mod.createV800CarAdapter('high', 'champagne');
        /* ② 默认档逐位不动 —— ⚠ **必须比对字面量，不能比对色表**。
         * 测试线挑出的弱判据：原先写
         *   `expect(upper.color.getHex()).toBe(expectedHex(getPaintSpec('champagne').upper))`
         * 两边**同源**（都从 PAINT_SPECS 来）⇒ 把色表改坏也全绿，等于没断言。
         * 现改为 **R36 字面量**：0xC9A86B + offsetHSL(0, 0.12, 0.02) 的独立反算结果。
         * 反算命令（可在仓库根直接复现，勿凭记忆）：
         *   node -e "const T=require('three');const c=new T.Color(0xc9a86b);
         *            c.offsetHSL(0,0.12,0.02);console.log(c.getHexString())"  ⇒ d5ad5d
         * ⇒ 这条现在能真正钉住「默认香槟金 = R36 渲染产物」。 */
        const R36_CHAMPAGNE_UPPER = 0xd5ad5d;
        const R36_CHAMPAGNE_LOWER = 0x111014;
        const upper = matById(base.root, PAINT_MATERIAL_IDS.v800.upper);
        const lower = matById(base.root, PAINT_MATERIAL_IDS.v800.lower);
        expect(upper).not.toBeNull();
        expect(lower).not.toBeNull();
        expect(upper!.color.getHex()).toBe(R36_CHAMPAGNE_UPPER);
        expect(lower!.color.getHex()).toBe(R36_CHAMPAGNE_LOWER);
        expect(upper!.metalness).toBeCloseTo(0.45, 10);
        expect(upper!.roughness).toBeCloseTo(0.38, 10);
        expect(upper!.envMapIntensity).toBeCloseTo(0.7, 10);
        expect(lower!.metalness).toBeCloseTo(0.45, 10);
        expect(lower!.roughness).toBeCloseTo(0.42, 10);
        expect(lower!.envMapIntensity).toBeCloseTo(0.7, 10);
        const baseCount = countMaterials(base.root);
        expect(baseCount).toBeGreaterThan(0);

        // ③ 换色只改实例、不 new：实例数与默认档逐位相同
        const dark = mod.createV800CarAdapter('high', 'obsidian');
        expect(countMaterials(dark.root)).toBe(baseCount);
        expect(countMaterials(dark.root)).toBeLessThanOrEqual(mod.V800_MATERIAL_INSTANCE_BUDGET);
        // 换了色：上/下段确实吃到曜石黑（同样比对**字面量**，理由见上）
        const dUpper = matById(dark.root, PAINT_MATERIAL_IDS.v800.upper);
        const dLower = matById(dark.root, PAINT_MATERIAL_IDS.v800.lower);
        expect(dUpper!.color.getHex()).toBe(0x0a0b0e);
        expect(dLower!.color.getHex()).toBe(0x07080a);
        expect(dUpper!.metalness).toBeCloseTo(0.55, 10);
        expect(dUpper!.clearcoat).toBeCloseTo(1.0, 10);
      } finally {
        restore();
      }
    },
    60000
  );

  it(
    'R7：null = 保留原厂墨绿（不吃 5 色）；显式选色才落色',
    async () => {
      const restore = shim();
      try {
        const mod = await import('../src/model/R7Adapter');
        const factory = mod.createR7CarAdapter('high', null);
        const fm = matById(factory.root, PAINT_MATERIAL_IDS.r7.upper);
        expect(fm).not.toBeNull();
        const factoryHex = fm!.color.getHex();
        // 原厂色不应等于色表里任何一档（否则说明默认值被误套成 5 色之一）
        for (const id of PAINT_IDS) {
          expect(factoryHex, `原厂色撞上 ${id}`).not.toBe(expectedHex(getPaintSpec(id).upper));
        }
        // iridescence 是 R7 车漆身份参数，任何路径都得留着
        expect(fm!.iridescence).toBeGreaterThan(0);

        const amber = mod.createR7CarAdapter('high', 'amber');
        const am = matById(amber.root, PAINT_MATERIAL_IDS.r7.upper);
        expect(am!.color.getHex()).toBe(expectedHex(getPaintSpec('amber').upper));
        // 换色不涨材质实例
        expect(countMaterials(amber.root)).toBe(countMaterials(factory.root));
        // iridescence 在换色后仍保留（随配色一起保身份）
        expect(am!.iridescence).toBeGreaterThan(0);
      } finally {
        restore();
      }
    },
    60000
  );
});

describe('R37-C 选择解析（hash > localStorage > 默认；**车漆 key 按车型隔离**）', () => {
  /** 两车型各自的 storage key（与 vehiclePaint.ts 的 STORAGE_KEY_BY_VEHICLE 同值） */
  const K_V800 = 'v800.paint';
  const K_R7 = 'v800.paint.r7';

  /**
   * 注入 window.hash + localStorage（两个真源，与运行时同判据）。
   * @param stored 该 key 的存量值；分车型给，才能验「隔离」
   */
  function withEnv(
    hash: string,
    stored: Partial<Record<'v800' | 'r7', string>> | null,
    fn: () => void,
    legacyGlobalKey?: string
  ): void {
    const REAL_WIN = (globalThis as { window?: unknown }).window;
    const REAL_LS = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { window: unknown }).window = { location: { hash, href: '' } };
    const map = new Map<string, string>();
    if (stored?.v800 !== undefined) map.set(K_V800, stored.v800);
    if (stored?.r7 !== undefined) map.set(K_R7, stored.r7);
    // 迁移用例：把值写进「旧全局 key」= 现在的 V800 key
    if (legacyGlobalKey !== undefined) map.set(K_V800, legacyGlobalKey);
    (globalThis as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v)
    };
    try {
      fn();
    } finally {
      (globalThis as { window: unknown }).window = REAL_WIN;
      if (REAL_LS === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else (globalThis as { localStorage: unknown }).localStorage = REAL_LS;
    }
  }

  it('默认（无 hash 无存储）：V800 → 香槟金；R7 → null（原厂墨绿）', () => {
    withEnv('', null, () => {
      expect(resolveAssemblyPaintId('v800')).toBe(DEFAULT_PAINT_ID);
      expect(resolveAssemblyPaintId('r7')).toBeNull();
      expect(resolvePaintChoiceFor('v800')).toBe(DEFAULT_PAINT_ID);
      expect(resolvePaintChoiceFor('r7')).toBe(FACTORY_PAINT_CHOICE);
    });
  });

  it('hash 优先于 localStorage（且 hash 是车型无关的显式调试意图）', () => {
    withEnv('#paint=obsidian', { v800: 'pearl' }, () => {
      expect(resolveAssemblyPaintId('v800')).toBe('obsidian');
      expect(resolveAssemblyPaintId('r7')).toBe('obsidian');
    });
  });

  it('★ key 隔离：V800 存了色 ⇒ R7 仍走原厂墨绿（不被污染）', () => {
    // 这条正是 P2-9 的回归护栏。修前 R7 会读到 V800 的 'v800.paint' ⇒ 返回 amber。
    withEnv('', { v800: 'amber' }, () => {
      expect(resolveAssemblyPaintId('v800')).toBe('amber'); // V800 自己照常
      expect(resolveAssemblyPaintId('r7')).toBeNull(); // ← 修前是 'amber'（bug）
      expect(resolvePaintChoiceFor('r7')).toBe(FACTORY_PAINT_CHOICE); // ← 修前是 'amber'
    });
  });

  it('★ key 隔离：R7 存了色 ⇒ V800 不受影响；两车各读各的', () => {
    withEnv('', { v800: 'deepblue', r7: 'pearl' }, () => {
      expect(resolveAssemblyPaintId('v800')).toBe('deepblue');
      expect(resolveAssemblyPaintId('r7')).toBe('pearl');
      expect(resolvePaintChoiceFor('v800')).toBe('deepblue');
      expect(resolvePaintChoiceFor('r7')).toBe('pearl');
    });
    // 只有 R7 存过：V800 回落默认香槟金
    withEnv('', { r7: 'amber' }, () => {
      expect(resolveAssemblyPaintId('v800')).toBe(DEFAULT_PAINT_ID);
      expect(resolveAssemblyPaintId('r7')).toBe('amber');
    });
  });

  it('迁移：旧值留在 V800 key ⇒ V800 继续生效，R7 不继承', () => {
    withEnv('', null, () => {
      expect(resolveAssemblyPaintId('v800')).toBe('obsidian');
      expect(resolveAssemblyPaintId('r7')).toBeNull();
    }, 'obsidian');
  });

  it('R7 存了「原厂墨绿」→ null（不碰漆面）；V800 存了它 → 回落香槟金', () => {
    withEnv('', { v800: FACTORY_PAINT_CHOICE, r7: FACTORY_PAINT_CHOICE }, () => {
      // V800 没有「原厂」这一档 ⇒ 回落默认香槟金（等于 R36 基线）
      expect(resolveAssemblyPaintId('v800')).toBe(DEFAULT_PAINT_ID);
      expect(resolveAssemblyPaintId('r7')).toBeNull();
      expect(resolvePaintChoiceFor('r7')).toBe(FACTORY_PAINT_CHOICE);
    });
  });

  it('setActivePaint 按车型写各自的 key（不串台）', () => {
    withEnv('', null, () => {
      setActivePaint('obsidian', 'v800');
      setActivePaint('pearl', 'r7');
      expect(resolveAssemblyPaintId('v800')).toBe('obsidian');
      expect(resolveAssemblyPaintId('r7')).toBe('pearl');
      // 只写 R7 不会动 V800
      setActivePaint(FACTORY_PAINT_CHOICE, 'r7');
      expect(resolveAssemblyPaintId('v800')).toBe('obsidian');
      expect(resolveAssemblyPaintId('r7')).toBeNull();
    });
  });

  it('脏值（旧版本残留 / 手改 localStorage）一律回落，不把装配层带崩', () => {
    for (const dirty of ['', 'CHAMPAGNE', 'not-a-color', 'paint-upper', 'r7-factory-x']) {
      // 两个 key 都灌脏值：两车都必须各自安全回落
      withEnv('', { v800: dirty, r7: dirty }, () => {
        expect(resolveAssemblyPaintId('v800'), `dirty=${dirty}`).toBe(DEFAULT_PAINT_ID);
        expect(resolveAssemblyPaintId('r7'), `dirty=${dirty}`).toBeNull();
        expect(resolvePaintChoiceFor('v800'), `dirty=${dirty}`).toBe(DEFAULT_PAINT_ID);
        expect(resolvePaintChoiceFor('r7'), `dirty=${dirty}`).toBe(FACTORY_PAINT_CHOICE);
      });
    }
  });
});

describe('R37-C applyPaintSlot 纯函数', () => {
  it('落到既有实例上：改色改参、不 new 材质', () => {
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff });
    const before = mat;
    // ⚠ THREE.Material.needsUpdate 是 **只写** 访问器（读回来是 undefined），
    // 所以「是否标了重编译」要看 version —— 每次置 needsUpdate 都会 ++。
    const v0 = mat.version;
    for (const id of PAINT_IDS) {
      const spec = getPaintSpec(id);
      applyPaintSlot(mat, spec.upper);
      // 同一实例（没有 clone/new）
      expect(mat).toBe(before);
      expect(mat.color.getHex()).toBe(expectedHex(spec.upper));
      expect(mat.metalness).toBe(spec.upper.metalness);
      expect(mat.roughness).toBe(spec.upper.roughness);
      expect(mat.envMapIntensity).toBe(spec.upper.envMapIntensity);
      if (spec.upper.clearcoat !== undefined) expect(mat.clearcoat).toBe(spec.upper.clearcoat);
    }
    // 每落一次色都要标重编译（5 色 ⇒ version 至少 +5）
    expect(mat.version).toBeGreaterThanOrEqual(v0 + PAINT_IDS.length);
  });

  it('clearcoat 未定义时不覆写（默认档靠这条保逐位一致）', () => {
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, clearcoat: 0.33 });
    const champagne: PaintChoice = 'champagne';
    applyPaintSlot(mat, getPaintSpec(champagne as 'champagne').upper);
    expect(mat.clearcoat).toBeCloseTo(0.33, 12);
  });
});
