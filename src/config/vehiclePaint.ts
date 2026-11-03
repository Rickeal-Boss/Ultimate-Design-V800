/**
 * 车漆/外观选择配置（R44 外观 GLB 资产化后 = **变体表**单一真源）。
 *
 * R44 语义变更（BRIEF §一）：
 *  - 车漆选择从「程序化 5 色落色」改为「外部壳 baseColor 变体」：
 *      v800 = 白 / 黑 / 浅金；r7 = 白 / 紫 / 绿。
 *  - 变体切换 = 懒加载换 baseColor 贴图（ExternalShell.setVariant，同时只驻留当前变体）；
 *  - localStorage key 兼容沿用（'v800.paint' / 'v800.paint.r7'），旧值（R37 5 色 id）
 *    在新变体表 miss ⇒ 回落到各车默认 'white'；
 *  - URL `#paint=` 仍车型无关、优先级最高。
 *
 * 程序化基线保留：PAINT_SPECS（R37 5 色）不再由菜单消费，仅作为
 * 「外部壳装载失败」回退路径的程序化车漆基线（V800 香槟金 = R36 基线逐位不动；
 * R7 工厂墨绿 = 装配层从不覆写 color）。applyPaintSlot 仍是「改既有实例 0 new」
 * 的纯函数，预算铁律测试继续钉住它。
 */
import type { MeshPhysicalMaterial } from 'three';

/* ───────────────────────── 程序化基线（回退路径专用） ───────────────────────── */

export type PaintId = 'champagne' | 'obsidian' | 'pearl' | 'amber' | 'deepblue';

/** 单个涂装槽（上段 / 下段）的材质参数 */
export interface PaintSlot {
  color: number;
  hsl?: readonly [number, number, number];
  metalness: number;
  roughness: number;
  envMapIntensity: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
}

export interface PaintSpec {
  id: PaintId;
  label: string;
  swatch: string;
  upper: PaintSlot;
  lower?: PaintSlot;
}

export const PAINT_SPECS: readonly PaintSpec[] = [
  {
    id: 'champagne',
    label: '香槟金',
    swatch: '#c9a86b',
    upper: {
      color: 0xc9a86b,
      hsl: [0, 0.12, 0.02],
      metalness: 0.45,
      roughness: 0.38,
      envMapIntensity: 0.7
    },
    lower: {
      color: 0x111014,
      metalness: 0.45,
      roughness: 0.42,
      envMapIntensity: 0.7
    }
  },
  {
    id: 'obsidian',
    label: '曜石黑',
    swatch: '#0a0b0e',
    upper: {
      color: 0x0a0b0e,
      metalness: 0.55,
      roughness: 0.22,
      envMapIntensity: 0.95,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04
    },
    lower: {
      color: 0x07080a,
      metalness: 0.5,
      roughness: 0.28,
      envMapIntensity: 0.8,
      clearcoat: 1.0,
      clearcoatRoughness: 0.06
    }
  },
  {
    id: 'pearl',
    label: '珍珠白',
    swatch: '#e9eaea',
    upper: {
      color: 0xe9eaea,
      metalness: 0.12,
      roughness: 0.32,
      envMapIntensity: 0.8,
      clearcoat: 0.85,
      clearcoatRoughness: 0.12
    },
    lower: {
      color: 0x2a2c30,
      metalness: 0.2,
      roughness: 0.45,
      envMapIntensity: 0.6
    }
  },
  {
    id: 'amber',
    label: '明黄',
    swatch: '#efb90a',
    upper: {
      color: 0xefb90a,
      metalness: 0.35,
      roughness: 0.34,
      envMapIntensity: 0.75,
      clearcoat: 0.9,
      clearcoatRoughness: 0.1
    },
    lower: {
      color: 0x14100a,
      metalness: 0.4,
      roughness: 0.42,
      envMapIntensity: 0.7
    }
  },
  {
    id: 'deepblue',
    label: '深空蓝',
    swatch: '#1b3a6b',
    upper: {
      color: 0x1b3a6b,
      metalness: 0.5,
      roughness: 0.3,
      envMapIntensity: 0.85,
      clearcoat: 1.0,
      clearcoatRoughness: 0.07
    },
    lower: {
      color: 0x0d1a30,
      metalness: 0.45,
      roughness: 0.38,
      envMapIntensity: 0.7
    }
  }
] as const;

/** 程序化基线默认档（= R36 香槟金）。回退路径唯一消费的档位。 */
export const BASELINE_PAINT_ID: PaintId = 'champagne';

export const PAINT_IDS: readonly PaintId[] = PAINT_SPECS.map((s) => s.id);

/** 漆面材质 id 接线表（按 material.userData.sculptMaterial.id，勿按组件 id） */
export const PAINT_MATERIAL_IDS = {
  v800: { upper: 'paint-upper', lower: 'paint-lower' },
  r7: { upper: 'paint-green', lower: null }
} as const;

/** 纯函数：把 PaintSlot 落到一支既有漆面材质实例上（不 new 材质） */
export function applyPaintSlot(mat: MeshPhysicalMaterial, slot: PaintSlot): void {
  mat.color.set(slot.color);
  if (slot.hsl) mat.color.offsetHSL(slot.hsl[0], slot.hsl[1], slot.hsl[2]);
  mat.metalness = slot.metalness;
  mat.roughness = slot.roughness;
  mat.envMapIntensity = slot.envMapIntensity;
  if (slot.clearcoat !== undefined) mat.clearcoat = slot.clearcoat;
  if (slot.clearcoatRoughness !== undefined) mat.clearcoatRoughness = slot.clearcoatRoughness;
  mat.needsUpdate = true;
}

export function getPaintSpec(id: PaintId = BASELINE_PAINT_ID): PaintSpec {
  return PAINT_SPECS.find((s) => s.id === id) ?? PAINT_SPECS[0];
}

/* ───────────────────────── R44 外观变体表（菜单消费） ───────────────────────── */

export interface VehicleVariant {
  /** 变体 id = bake 产物 basecolor-<id>.webp 的 <id>（manifest.variants 同源） */
  id: string;
  label: string;
  /** UI 色块（取自染色版主漆色的近似值） */
  swatch: string;
}

/**
 * 外观变体表（顺序 = UI 色块顺序；第一项 = 默认档）。
 * 与 manifest.json variants 严格同源：v800 白/黑/浅金，r7 白/紫/绿。
 */
export const VEHICLE_VARIANTS: Readonly<Record<'v800' | 'r7', readonly VehicleVariant[]>> = {
  v800: [
    { id: 'white', label: '珍珠白', swatch: '#e9e9e7' },
    { id: 'black', label: '曜石黑', swatch: '#14161c' },
    { id: 'gold', label: '浅金', swatch: '#c9b48a' }
  ],
  r7: [
    { id: 'white', label: '珍珠白', swatch: '#e9e9e7' },
    { id: 'purple', label: '星夜紫', swatch: '#4b3f78' },
    { id: 'green', label: '原厂绿', swatch: '#2f5340' }
  ]
};

export type VehicleKey = 'v800' | 'r7';

/** 各车默认变体 = 变体表第一项 */
export const DEFAULT_VARIANT: Readonly<Record<VehicleKey, string>> = {
  v800: VEHICLE_VARIANTS.v800[0].id,
  r7: VEHICLE_VARIANTS.r7[0].id
};

/** 菜单可选值 = 该车变体表（R44 起 R7 不再有「原厂墨绿」独立项：它就是变体 green） */
export type PaintChoice = string;

function isVariantId(vehicleId: VehicleKey, v: string | null | undefined): v is string {
  return v != null && VEHICLE_VARIANTS[vehicleId].some((s) => s.id === v);
}

/** 纯函数：菜单项的中文名（跨车变体表查表；miss 回 '未知' 防脏值崩 UI） */
export function paintChoiceLabel(choice: PaintChoice): string {
  for (const key of ['v800', 'r7'] as const) {
    const hit = VEHICLE_VARIANTS[key].find((s) => s.id === choice);
    if (hit) return hit.label;
  }
  return String(choice);
}

/** 纯函数：菜单色块颜色（同上） */
export function paintChoiceSwatch(choice: PaintChoice): string {
  for (const key of ['v800', 'r7'] as const) {
    const hit = VEHICLE_VARIANTS[key].find((s) => s.id === choice);
    if (hit) return hit.swatch;
  }
  return '#888888';
}

/** 纯函数：某车型菜单里可点的项 */
export function paintChoicesFor(vehicleId: VehicleKey): readonly string[] {
  return VEHICLE_VARIANTS[vehicleId].map((s) => s.id);
}

/**
 * localStorage 键 —— 按车型分 key（R37 P2-9 修复，R44 沿用不迁移）。
 * 旧值（R37 5 色 id）在新变体表 miss ⇒ 回默认 'white'（BRIEF：旧值 miss 时回默认）。
 */
const STORAGE_KEY_BY_VEHICLE: Readonly<Record<VehicleKey, string>> = {
  v800: 'v800.paint',
  r7: 'v800.paint.r7'
};

function readHash(): string | null {
  if (typeof window === 'undefined') return null;
  const m = /(?:^|[#&])paint=([a-z0-9-]+)/i.exec(window.location.hash);
  return m?.[1]?.toLowerCase() ?? null;
}

function readStorage(vehicleId: VehicleKey): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(STORAGE_KEY_BY_VEHICLE[vehicleId]);
  } catch {
    return null;
  }
}

function resolveVariantChoice(vehicleId: VehicleKey): string | null {
  const raw = readHash() ?? readStorage(vehicleId);
  return isVariantId(vehicleId, raw) ? raw : null;
}

/**
 * 当前生效外观变体：URL `#paint=` > 该车型 localStorage > 各车默认（白）。
 * 旧值 miss / 脏值一律回落，不把装配层带崩。
 */
export function resolveAssemblyPaintId(vehicleId: VehicleKey): string {
  return resolveVariantChoice(vehicleId) ?? DEFAULT_VARIANT[vehicleId];
}

/** 菜单当前高亮项（与装配层同源同 key） */
export function resolvePaintChoiceFor(vehicleId: VehicleKey): string {
  return resolveAssemblyPaintId(vehicleId);
}

/**
 * R37 兼容出口（原语义 = 5 色之一）。R44 起返回变体 id；R7 不再返回 null
 * （原厂墨绿 = 变体 green，不再是「不碰漆面」路径）。
 */
export function resolvePaintId(vehicleId: VehicleKey = 'v800'): string {
  return resolveAssemblyPaintId(vehicleId);
}

/** 写入选择（调用方随后 location.reload() 重建装配态；与选车同机制） */
export function setActivePaint(choice: PaintChoice, vehicleId: VehicleKey = 'v800'): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY_BY_VEHICLE[vehicleId], choice);
  } catch {
    /* 存储不可用时忽略：本次会话仍以 URL hash / 默认值运行 */
  }
}
