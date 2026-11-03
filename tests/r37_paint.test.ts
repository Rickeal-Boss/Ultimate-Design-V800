/**
 * R44 · 外观变体表（车漆选择 GLB 资产化后）回归。
 *
 * R44 语义（BRIEF §一）：车漆选择从 R37 的「程序化 5 色落色」改为「外部壳
 * baseColor 变体」：v800 = 白/黑/浅金，r7 = 白/紫/绿。锁五条契约：
 *  ① 变体表：两车各 3 档，第一项 = 默认 'white'，中文名 + 色块齐全；
 *  ② 解析链：URL `#paint=` > 该车型 localStorage > 默认白；**key 按车型隔离**
 *     （R37 P2-9 契约延续）；旧值（R37 5 色 id）/脏值 miss ⇒ 安全回落默认；
 *  ③ 程序化基线保留：V800 默认装配仍把香槟金基线落到 paint-upper/lower
 *     （外部壳装载失败时的回退外观，R36 字面量钉死）；R7 工厂墨绿不被覆写；
 *  ④ 0 新材质实例：程序化路径换「变体」不再触碰材质实例（变体 = 换 baseColor
 *     贴图，材质实例恒 1）；applyPaintSlot 纯函数仍是改实例不 new；
 *  ⑤ manifest.json ↔ 变体表同源（variants id 集合一致）。
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import {
  BASELINE_PAINT_ID,
  DEFAULT_VARIANT,
  PAINT_MATERIAL_IDS,
  PAINT_SPECS,
  VEHICLE_VARIANTS,
  applyPaintSlot,
  getPaintSpec,
  paintChoicesFor,
  paintChoiceLabel,
  paintChoiceSwatch,
  resolveAssemblyPaintId,
  resolvePaintChoiceFor,
  setActivePaint
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
    (globalThis as { window: unknown }).window = REAL_WIN;
    (globalThis as { document: unknown }).document = REAL_DOC;
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

describe('R44 外观变体表', () => {
  it('两车各 3 档；第一项 = 默认 white；中文标签 + 色块齐全', () => {
    expect(paintChoicesFor('v800')).toEqual(['white', 'black', 'gold']);
    expect(paintChoicesFor('r7')).toEqual(['white', 'purple', 'green']);
    expect(DEFAULT_VARIANT.v800).toBe('white');
    expect(DEFAULT_VARIANT.r7).toBe('white');
    for (const key of ['v800', 'r7'] as const) {
      for (const v of VEHICLE_VARIANTS[key]) {
        expect(v.label, `${key}/${v.id}`).toMatch(/[一-龥]/);
        expect(v.swatch, `${key}/${v.id}`).toMatch(/^#[0-9a-f]{6}$/i);
        expect(paintChoiceLabel(v.id), v.id).toBe(v.label);
        expect(paintChoiceSwatch(v.id), v.id).toBe(v.swatch);
      }
    }
  });

  it('程序化基线保留：PAINT_SPECS 香槟金默认档未动（回退路径 R36 基线）', () => {
    expect(BASELINE_PAINT_ID).toBe('champagne');
    expect(PAINT_SPECS[0].id).toBe('champagne');
    expect(getPaintSpec().id).toBe('champagne');
    // 默认档不覆写 clearcoat（沿用工厂值 ⇒ R36 外观逐位不动）
    expect(getPaintSpec().upper.clearcoat).toBeUndefined();
    expect(getPaintSpec().lower!.clearcoat).toBeUndefined();
  });
});

describe('R44 选择解析（hash > localStorage > 默认；key 按车型隔离；旧值 miss 回默认）', () => {
  const K_V800 = 'v800.paint';
  const K_R7 = 'v800.paint.r7';

  function withEnv(
    hash: string,
    stored: Partial<Record<'v800' | 'r7', string>> | null,
    fn: () => void
  ): void {
    const REAL_WIN = (globalThis as { window?: unknown }).window;
    const REAL_LS = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { window: unknown }).window = { location: { hash, href: '' } };
    const map = new Map<string, string>();
    if (stored?.v800 !== undefined) map.set(K_V800, stored.v800);
    if (stored?.r7 !== undefined) map.set(K_R7, stored.r7);
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

  it('默认（无 hash 无存储）：两车都回白', () => {
    withEnv('', null, () => {
      expect(resolveAssemblyPaintId('v800')).toBe('white');
      expect(resolveAssemblyPaintId('r7')).toBe('white');
      expect(resolvePaintChoiceFor('r7')).toBe('white');
    });
  });

  it('hash 优先于 localStorage（显式调试意图；但越权变体仍按该车表校验）', () => {
    withEnv('#paint=gold', { v800: 'black' }, () => {
      expect(resolveAssemblyPaintId('v800')).toBe('gold');
      // gold 不在 R7 变体表 ⇒ 不放行（防脏值穿透装配层），回落 R7 默认
      expect(resolveAssemblyPaintId('r7')).toBe('white');
    });
  });

  it('★ key 隔离：V800 存了色 ⇒ R7 仍读自己的 key', () => {
    withEnv('', { v800: 'black', r7: 'purple' }, () => {
      expect(resolveAssemblyPaintId('v800')).toBe('black');
      expect(resolveAssemblyPaintId('r7')).toBe('purple');
    });
    withEnv('', { v800: 'black' }, () => {
      expect(resolveAssemblyPaintId('v800')).toBe('black');
      expect(resolveAssemblyPaintId('r7')).toBe('white'); // R7 自己的 key 空 → 默认
    });
  });

  it('★ 旧值迁移：R37 5 色 id（champagne/obsidian…）miss ⇒ 回默认白，不崩', () => {
    for (const legacy of ['champagne', 'obsidian', 'pearl', 'amber', 'deepblue', 'r7-factory']) {
      withEnv('', { v800: legacy, r7: legacy }, () => {
        expect(resolveAssemblyPaintId('v800'), `legacy=${legacy}`).toBe('white');
        expect(resolveAssemblyPaintId('r7'), `legacy=${legacy}`).toBe('white');
        expect(resolvePaintChoiceFor('v800'), `legacy=${legacy}`).toBe('white');
      });
    }
  });

  it('脏值一律回落，setActivePaint 按车型写各自的 key（不串台）', () => {
    for (const dirty of ['', 'CHAMPAGNE', 'not-a-color', 'paint-upper']) {
      withEnv('', { v800: dirty, r7: dirty }, () => {
        expect(resolveAssemblyPaintId('v800'), `dirty=${dirty}`).toBe('white');
        expect(resolveAssemblyPaintId('r7'), `dirty=${dirty}`).toBe('white');
      });
    }
    withEnv('', null, () => {
      setActivePaint('gold', 'v800');
      setActivePaint('green', 'r7');
      expect(resolveAssemblyPaintId('v800')).toBe('gold');
      expect(resolveAssemblyPaintId('r7')).toBe('green');
    });
  });

  it('hash 越界值（他车变体/乱码）→ 回默认（hash 不白名单放行脏值）', () => {
    withEnv('#paint=1337', null, () => {
      expect(resolveAssemblyPaintId('v800')).toBe('white');
    });
  });
});

describe('R44 程序化基线装配（外部壳失败时的回退外观）', () => {
  it(
    'V800：任意外观变体下，paint-upper/lower 仍 = R36 香槟金字面量；实例数不随变体变化',
    async () => {
      const restore = shim();
      try {
        const mod = await import('../src/model/V800Adapter');
        const R36_CHAMPAGNE_UPPER = 0xd5ad5d;
        const R36_CHAMPAGNE_LOWER = 0x111014;
        const base = mod.createV800CarAdapter('high', 'white');
        const upper = matById(base.root, PAINT_MATERIAL_IDS.v800.upper);
        const lower = matById(base.root, PAINT_MATERIAL_IDS.v800.lower);
        expect(upper).not.toBeNull();
        expect(lower).not.toBeNull();
        expect(upper!.color.getHex()).toBe(R36_CHAMPAGNE_UPPER);
        expect(lower!.color.getHex()).toBe(R36_CHAMPAGNE_LOWER);
        expect(upper!.metalness).toBeCloseTo(0.45, 10);
        expect(upper!.roughness).toBeCloseTo(0.38, 10);
        const baseCount = countMaterials(base.root);
        expect(baseCount).toBeGreaterThan(0);
        // 变体只影响外部壳贴图 ⇒ 程序化树逐位一致、实例数相同
        const dark = mod.createV800CarAdapter('high', 'black');
        const dUpper = matById(dark.root, PAINT_MATERIAL_IDS.v800.upper);
        expect(dUpper!.color.getHex()).toBe(R36_CHAMPAGNE_UPPER);
        expect(countMaterials(dark.root)).toBe(baseCount);
        expect(countMaterials(dark.root)).toBeLessThanOrEqual(mod.V800_MATERIAL_INSTANCE_BUDGET);
        base.dispose();
        dark.dispose();
      } finally {
        restore();
      }
    },
    60000
  );

  it(
    'R7：paint-green 工厂墨绿不被任何变体覆写（iridescence 身份参数保留）',
    async () => {
      const restore = shim();
      try {
        const mod = await import('../src/model/R7Adapter');
        const car = mod.createR7CarAdapter('high', 'purple');
        const fm = matById(car.root, PAINT_MATERIAL_IDS.r7.upper);
        expect(fm).not.toBeNull();
        expect(fm!.iridescence).toBeGreaterThan(0);
        // 墨绿基线（工厂 spec 色）不被 champagne 覆写
        for (const spec of PAINT_SPECS) {
          expect(fm!.color.getHex(), spec.id).not.toBe(new THREE.Color(spec.upper.color).getHex());
        }
        car.dispose();
      } finally {
        restore();
      }
    },
    60000
  );
});

describe('R44 applyPaintSlot 纯函数（回退基线路径仍钉 0 new 实例）', () => {
  it('落到既有实例上：改色改参、不 new 材质', () => {
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff });
    const before = mat;
    const v0 = mat.version;
    for (const spec of PAINT_SPECS) {
      applyPaintSlot(mat, spec.upper);
      expect(mat).toBe(before);
      expect(mat.metalness).toBe(spec.upper.metalness);
      expect(mat.roughness).toBe(spec.upper.roughness);
      expect(mat.envMapIntensity).toBe(spec.upper.envMapIntensity);
    }
    expect(mat.version).toBeGreaterThanOrEqual(v0 + PAINT_SPECS.length);
  });
});

describe('R44 manifest ↔ 变体表同源', () => {
  it('manifest.variants id 集合 = VEHICLE_VARIANTS；tri/轮毂台账齐全', () => {
    for (const key of ['v800', 'r7'] as const) {
      const m = JSON.parse(
        readFileSync(new URL(`../src/assets/cars/${key}/manifest.json`, import.meta.url), 'utf-8')
      ) as {
        scale: number;
        wheelRadius: number;
        hubs: Record<string, [number, number, number]>;
        variants: ReadonlyArray<{ id: string; file: string }>;
        tri: Record<string, number>;
      };
      expect(m.variants.map((v) => v.id).sort()).toEqual(
        [...VEHICLE_VARIANTS[key].map((v) => v.id)].sort()
      );
      expect(Object.keys(m.hubs).sort()).toEqual(['fl', 'fr', 'rl', 'rr']);
      expect(m.scale).toBeGreaterThan(3);
      expect(m.wheelRadius).toBeGreaterThan(0.3);
      expect(m.tri.body).toBeGreaterThan(500_000);
      for (const tag of ['fl', 'fr', 'rl', 'rr']) {
        // 轮底贴地自洽：hub.y × scale ≈ wheelRadius
        expect(Math.abs(m.hubs[tag][1] * m.scale - m.wheelRadius)).toBeLessThan(0.02);
      }
    }
  });
});
