/**
 * 车漆配色表（R37-C 开始界面多色选择）。
 *
 * 设计口径：
 *  - **单一真源**：色表在 config 层，UI（Menu 色块）与装配层（V800Adapter / R7Adapter）
 *    都从这里读，避免「菜单显示一个色、车模刷成另一个色」。
 *  - **换色 = 改既有材质实例**，不 new 材质 ⇒ 材质实例数不涨（预算 80 铁律）。
 *    适配器按 `material.userData.sculptMaterial.id` 找漆面材质（**勿按组件 id**，
 *    合批后组件 id 会丢，见 V800Adapter 材质索引注释）。
 *  - 双拼语义：V800 是「上段主色 + 下段深色」双拼（paint-upper / paint-lower）；
 *    R7 只有单支漆面（paint-green），吃 `upper` 一档即可（见 PAINT_MATERIAL_IDS）。
 *  - **默认档逐位不动**：`champagne` 一档的数值就是 R36-V1 标定现值
 *    （color #C9A86B + HSL(+0.12 s, +0.02 l) / metalness .45 / rough .38 / env .7；
 *    下段 #111014 / metal .45 / rough .42 / env .7），且**不覆写 clearcoat**
 *    （沿用工厂值）⇒ 不换色时车模与 R36 逐位一致。
 *
 * 数值取向（参考图 + 主理人指定）：
 *  - 曜石黑：纯黑要读出**清漆高光** ⇒ 高 clearcoat(1.0) + 低 clearcoatRoughness(.04)
 *    + 抬 envMapIntensity(.95)，否则纯黑在软光箱下读作「死黑塑料」。
 *  - 珍珠白：**低金属度**（.12，金属度一高白漆就发灰发蓝）+ 适中 clearcoat(.85)。
 *  - 香槟金/明黄：金属漆语义，中金属度 + 中粗糙，保「金/黄」身份可辨。
 *  - 深空蓝：金属漆 + 清漆，env 略抬让暗色蓝在阴天下不糊成黑。
 */
import type { MeshPhysicalMaterial } from 'three';

export type PaintId = 'champagne' | 'obsidian' | 'pearl' | 'amber' | 'deepblue';

/** 单个涂装槽（上段 / 下段）的材质参数 */
export interface PaintSlot {
  /** 基色 */
  color: number;
  /** 可选 HSL 偏移 [h, s, l]（在基色之上再微调，保「金身份」那类标定） */
  hsl?: readonly [number, number, number];
  metalness: number;
  roughness: number;
  envMapIntensity: number;
  /** 清漆强度；**undefined = 不覆写**（沿用工厂/spec 现值，默认档靠这个保逐位一致） */
  clearcoat?: number;
  /** 清漆粗糙度；同上，undefined = 不覆写 */
  clearcoatRoughness?: number;
}

export interface PaintSpec {
  id: PaintId;
  /** 中文名（UI 文案 + aria-label） */
  label: string;
  /** UI 色块颜色（CSS hex；与 upper 基色同色系，供未建模时肉眼比对） */
  swatch: string;
  /** 上段主色（R7 整车漆面也吃这一档） */
  upper: PaintSlot;
  /** 双拼下段；undefined ⇒ 该配色无下段档，下段沿用工厂原色 */
  lower?: PaintSlot;
}

/**
 * 车漆色表（顺序 = UI 色块顺序）。
 * ⚠️ 第一项 `champagne` 是默认档，改动它等于改 R36 基线外观 —— 除非主理人明确要求，
 *    其 upper/lower 数值与「是否覆写 clearcoat」都必须保持现状。
 */
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

export const PAINT_IDS: readonly PaintId[] = PAINT_SPECS.map((s) => s.id);

const PAINT_ID_SET: ReadonlySet<string> = new Set(PAINT_IDS);

/** 默认车漆（= R36 基线香槟金，必须永远等于 PAINT_SPECS[0].id） */
export const DEFAULT_PAINT_ID: PaintId = 'champagne';

/**
 * 「原厂色」选择项：仅 **R7** 提供。
 *
 * 为什么 R7 需要它、V800 不需要：V800 的默认档 champagne 就是 R36 基线外观本身
 * （色表数值 = 适配器历史值）⇒ 默认值 ≡ 原厂。R7 基线是**工厂墨绿**（paint-green，
 * 适配器从不覆写它的 color），若把 5 色的 champagne 当默认值套上去，R7 会凭空
 * 变成金色 —— 那是一条本轮没被授权的 R7 基线外观变更。故 R7 的默认项是
 * 「原厂墨绿」= **装配层不碰 color**，只有玩家显式选了 5 色之一才落色。
 */
export const FACTORY_PAINT_CHOICE = 'r7-factory';

/** 原厂项的展示元数据（色块取 R7 工厂墨绿的近似色，仅供 UI 色块，不参与装配） */
export const FACTORY_PAINT_META: Readonly<{ label: string; swatch: string }> = {
  label: '原厂墨绿',
  swatch: '#21402f'
};

/** 菜单可选值 = 5 色 +（R7 专有）原厂色 */
export type PaintChoice = PaintId | typeof FACTORY_PAINT_CHOICE;

/** 纯函数：菜单项的中文名（5 色查表，原厂项取 FACTORY_PAINT_META） */
export function paintChoiceLabel(choice: PaintChoice): string {
  if (choice === FACTORY_PAINT_CHOICE) return FACTORY_PAINT_META.label;
  return getPaintSpec(choice).label;
}

/** 纯函数：菜单色块颜色（同上） */
export function paintChoiceSwatch(choice: PaintChoice): string {
  if (choice === FACTORY_PAINT_CHOICE) return FACTORY_PAINT_META.swatch;
  return getPaintSpec(choice).swatch;
}

/** 纯函数：某车型菜单里可点的项（R7 多一个「原厂墨绿」在首位） */
export function paintChoicesFor(vehicleId: 'v800' | 'r7'): readonly PaintChoice[] {
  return vehicleId === 'r7' ? [FACTORY_PAINT_CHOICE, ...PAINT_IDS] : PAINT_IDS;
}

/**
 * localStorage 键 —— **按车型分 key**（R37 P2-9 修）。
 *
 * ⚠ 为什么必须分：原先只有一个全局 key 'v800.paint'，而 `resolveAssemblyPaintId('r7')`
 *   直接吃它 ⇒ **玩家只要在 V800 下选过任何颜色，切到 R7 就不再是原厂墨绿**
 *   （实测：`v800.paint=obsidian` 时 `resolveAssemblyPaintId('r7')` 返回 obsidian、
 *   菜单还高亮 obsidian）。R7 的「原厂墨绿」是它的**基线外观**，不能被另一辆车的
 *   选择污染。
 *
 * 迁移口径：
 *   · V800 继续用历史的 'v800.paint' ⇒ 老用户已存的颜色**原样继续生效**（零迁移）；
 *   · R7 用独立的 'v800.paint.r7' ⇒ **不兼容读取** 'v800.paint'（这正是隔离的意义：
 *     宁可让 R7 回到原厂墨绿，也不让它继承 V800 的历史值）。
 *   · URL hash `#paint=` 仍然**车型无关**（显式调试意图，优先级最高，两车都认）。
 */
const STORAGE_KEY_BY_VEHICLE: Readonly<Record<'v800' | 'r7', string>> = {
  v800: 'v800.paint',
  r7: 'v800.paint.r7'
};

function isPaintId(v: string | null | undefined): v is PaintId {
  return v != null && PAINT_ID_SET.has(v);
}

function isPaintChoice(v: string | null | undefined): v is PaintChoice {
  return v === FACTORY_PAINT_CHOICE || isPaintId(v);
}

function readHash(): PaintChoice | null {
  if (typeof window === 'undefined') return null;
  const m = /(?:^|[#&])paint=([a-z0-9-]+)/i.exec(window.location.hash);
  const raw = m?.[1]?.toLowerCase();
  return isPaintChoice(raw) ? raw : null;
}

function readStorage(vehicleId: 'v800' | 'r7'): PaintChoice | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BY_VEHICLE[vehicleId]);
    return isPaintChoice(raw) ? raw : null;
  } catch {
    // Safari 无痕/禁用存储：静默降级到默认值，不允许让换色逻辑把主流程搞崩
    return null;
  }
}

/** 原始选择（可能含 R7 原厂项）：URL `#paint=obsidian` > 该车型自己的 localStorage > null */
function resolvePaintChoice(vehicleId: 'v800' | 'r7'): PaintChoice | null {
  return readHash() ?? readStorage(vehicleId);
}

/**
 * 当前生效车漆：URL `#paint=` > 该车型 localStorage > 香槟金。
 * 非 5 色的取值（R7 原厂项 / 无效值）一律回落到 champagne —— V800 没有「原厂」之外的
 * 另一套基线外观，回落即等于 R36 基线。
 */
export function resolvePaintId(vehicleId: 'v800' | 'r7' = 'v800'): PaintId {
  const raw = resolvePaintChoice(vehicleId);
  return isPaintId(raw) ? raw : DEFAULT_PAINT_ID;
}

/**
 * 装配层取值：**null = 不要碰漆面颜色**（R7 原厂墨绿路径）。
 * V800 永远返回 5 色之一（默认 champagne）。
 * ⚠ 读的是**该车型自己的 key** ⇒ V800 选过色不会影响 R7。
 */
export function resolveAssemblyPaintId(vehicleId: 'v800' | 'r7'): PaintId | null {
  const raw = resolvePaintChoice(vehicleId);
  if (vehicleId === 'r7') return isPaintId(raw) ? raw : null;
  return isPaintId(raw) ? raw : DEFAULT_PAINT_ID;
}

/** 菜单当前高亮项（R7 未选过任何色时高亮「原厂墨绿」，与装配层同源同 key） */
export function resolvePaintChoiceFor(vehicleId: 'v800' | 'r7'): PaintChoice {
  const raw = resolvePaintChoice(vehicleId);
  if (isPaintChoice(raw)) return raw;
  return vehicleId === 'r7' ? FACTORY_PAINT_CHOICE : DEFAULT_PAINT_ID;
}

export function getPaintSpec(id: PaintId = resolvePaintId()): PaintSpec {
  return PAINT_SPECS.find((s) => s.id === id) ?? PAINT_SPECS[0];
}

/**
 * 写入选择（调用方随后 location.reload() 重建装配态；与选车同机制）。
 * @param vehicleId 写哪个车型的 key —— **必传**（默认 v800 只为兼容旧调用点；
 *   菜单里一律显式传当前车型，否则会出现「在 R7 选色写进 V800 的 key」）。
 */
export function setActivePaint(choice: PaintChoice, vehicleId: 'v800' | 'r7' = 'v800'): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY_BY_VEHICLE[vehicleId], choice);
  } catch {
    /* 存储不可用时忽略：本次会话仍以 URL hash / 默认值运行 */
  }
}

/**
 * 纯函数：把 PaintSlot 落到一支既有漆面材质实例上（**不 new 材质**）。
 *
 * 抽出来是为了让「换色不改材质实例数」这条预算铁律可被单测直接钉住
 * （见 tests/r37_paint.test.ts）：装配层与测试共用同一段应用逻辑，
 * 不会出现「适配器多 new 了一个 clone、测试没看见」。
 */
export function applyPaintSlot(mat: MeshPhysicalMaterial, slot: PaintSlot): void {
  mat.color.set(slot.color);
  if (slot.hsl) mat.color.offsetHSL(slot.hsl[0], slot.hsl[1], slot.hsl[2]);
  mat.metalness = slot.metalness;
  mat.roughness = slot.roughness;
  mat.envMapIntensity = slot.envMapIntensity;
  // clearcoat 两档是「可选覆写」：默认香槟金档不写，沿用工厂值 ⇒ R36 外观逐位不动
  if (slot.clearcoat !== undefined) mat.clearcoat = slot.clearcoat;
  if (slot.clearcoatRoughness !== undefined) mat.clearcoatRoughness = slot.clearcoatRoughness;
  mat.needsUpdate = true;
}

/**
 * 漆面材质 id 接线表（按 `material.userData.sculptMaterial.id`，**勿按组件 id**）。
 * R7 只有单支整车漆面 paint-green ⇒ 吃 upper 一档、无 lower（与本轮 V800 双拼
 * 结构不同，故单独登记而不是复用 V800 的两个 id）。
 */
export const PAINT_MATERIAL_IDS = {
  v800: { upper: 'paint-upper', lower: 'paint-lower' },
  r7: { upper: 'paint-green', lower: null }
} as const;
