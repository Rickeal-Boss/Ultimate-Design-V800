/**
 * R104 · 建筑底部材料边界防回退护栏（「细致每个建筑底部材料的边界」）。
 *
 * R103 后仍有两处「真源派生错误」导致穿模 / 空气墙，本文件把修正后的**材料真实边界**
 * 钉成护栏，禁写死派生值（一律由 INNER / castleKit boxW / castleDetail colR 派生）：
 *
 * P1 前排塔基穿模 0.7 m（40 处）：castleKit.ts:3254 `box('ashlar', 9.4, 1.2, 9.4, depth/2, …)`
 *   塔基 box **宽 9.4**、局部 x 中心 = depth/2（depth = 8，:3078）⇒ 局部 x∈[−0.7, 8.7]，
 *   put() 世界内缘 = faceHalf − 0.7 = **14.8**（旧 15.5 让车穿进塔基 0.7 m）。
 *   0.7 = boxW/2 − depth/2 = 9.4/2 − 8/2 = 4.7 − 4（真源派生，禁写死）。
 *
 * A1 拱廊柱 AABB z 向过宽 ⇒ 4.38 m 空气墙（每 8.8 m 一处）：castleDetail.ts:1397 `colR = 0.3`、
 *   :1411 `pierColumn(colR*2, colR*1.7, …)` ⇒ 柱实际 z 半宽 = colR = **0.3**（旧 AABB 取 colR+0.6=0.9，
 *   让车被 2D 挡在离柱 0.6 m 外）。R104 收紧到 colR + 0.1 = **0.4**（微小稳定余量防 SAT 边界抖动）。
 *
 * 真源口径：INNER / R30_ARCADE / VEHICLE / CITY_BLOCK_Z 一律 import；castleKit 塔基 boxW=9.4 /
 * depth=8 与 castleDetail colR=0.3 为私有常量不可 import，按几何等价独立重算（禁写死 14.8 / 0.4）。
 */
import { describe, expect, it } from 'vitest';
import { CITY_BLOCK_Z } from '../src/core/FreeDrive';
import {
  clampToFootprints,
  getCityFootprints,
  type CityFootprint
} from '../src/core/cityFootprints';
import { VEHICLE } from '../src/config/physics';
import { INNER } from '../src/render/scene/r28Layout';
import { R30_ARCADE } from '../src/render/scene/castleKit';

/** 车长 / 车宽半尺寸真源（physics.ts，勿写死） */
const HALF_L = VEHICLE.lengthM / 2; // 2.7475
const HALF_W = VEHICLE.widthM / 2; // 1.003

/** 块 0 便于断言 */
const K0 = CITY_BLOCK_Z[0];
const K0_ZC = (K0[0] + K0[1]) / 2; // −388.5

/* ── 真源派生（与 cityFootprints 内部公式独立重算，防同源写死）── */
/** castleKit.ts:3254 塔基 box 宽（私有常量，几何等价取值） */
const TOWER_BOX_W = 9.4;
/** castleKit.ts:3078 闭包 depth（私有常量） */
const TOWER_DEPTH = 8;
/** 塔基越过前脸量 = boxW/2 − depth/2（真源派生 0.7，P1 核心） */
const TOWER_FACE_INSET = TOWER_BOX_W / 2 - TOWER_DEPTH / 2; // 0.7
/** 前排塔基真实可见内缘（P1 修正后） */
const FRONT_TOWER_INNER = INNER.faceHalf - TOWER_FACE_INSET; // 14.8
/** castleDetail.ts:1397 拱廊柱半径（私有常量） */
const COL_R = 0.3;
/** 拱廊柱占位 z 半宽 = colR + 0.1 微稳定余量（A1 修正后，禁写死 0.4） */
const COL_AABB_HALF = COL_R + 0.1; // 0.4
/** 拱廊柱内缘（与 cityFootprints 同源公式；colR 抵消） */
const ARCADE_COL_INNER = INNER.faceHalf - R30_ARCADE.width - 1.0 + 0.12; // 11.12

/** 城内 2D 占位清单 */
const FOOTPRINTS = getCityFootprints();

/** 按 kind 取所有占位 */
function byKind(kind: CityFootprint['kind']): CityFootprint[] {
  return FOOTPRINTS.filter((f) => f.kind === kind);
}

describe('R104 ① P1 前排塔基真实内缘 14.8（真源派生，防回退到穿模 15.5）', () => {
  it('塔基越过前脸量 = boxW/2 − depth/2 = 0.7（真源派生，非写死）', () => {
    expect(TOWER_BOX_W).toBe(9.4); // castleKit.ts:3254
    expect(TOWER_DEPTH).toBe(8); // castleKit.ts:3078
    expect(TOWER_FACE_INSET).toBeCloseTo(0.7, 12);
  });

  it('全部 20 处前排塔基 xInner = faceHalf − 0.7 = 14.8（< 15.5，比 R103 更贴材料）', () => {
    expect(byKind('frontBase').length).toBe(20); // 10 块 × 2 座
    for (const f of byKind('frontBase')) {
      expect(f.xInner).toBeCloseTo(FRONT_TOWER_INNER, 12);
      expect(f.xInner).toBeLessThan(INNER.faceHalf); // 14.8 < 15.5：真贴塔基材料（P1 修正）
    }
  });

  it('车缘 ≤ 14.8 不穿塔基（θ=0 车缘 = xInner + 半宽 = 15.803 命中 ⇒ 2D 收紧到 13.797）', () => {
    // 取块 0 近端塔基 tz = zc + blockLen/4，车心 z 落在塔基 z 带中心
    const towerZ = K0_ZC + INNER.blockLen / 4;
    const fp = clampToFootprints(14.0, towerZ, 0);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('frontBase');
    // 2D 收紧线 = 14.8 − 半宽 1.003 = 13.797（车缘恰贴塔基真实内缘 14.8，不穿）
    expect(fp.x).toBeCloseTo(FRONT_TOWER_INNER - HALF_W, 12);
    expect(fp.x + HALF_W).toBeCloseTo(FRONT_TOWER_INNER, 12); // 车缘 ≤ 14.8
  });
});

describe('R104 ② A1 拱廊柱占位 z 半宽 0.4（真源派生，防回退到 0.9 空气墙）', () => {
  it('柱占位 z 半宽 = colR + 0.1 = 0.4（真源派生，非写死；< R103 的 0.9）', () => {
    expect(COL_R).toBe(0.3); // castleDetail.ts:1397
    expect(COL_AABB_HALF).toBeCloseTo(0.4, 12);
    expect(COL_AABB_HALF).toBeLessThan(0.9); // 比 R103 旧值窄 ⇒ 空气墙减小
    // 全部 40 根柱 z 半宽一致
    const cols = byKind('arcadeCol');
    expect(cols.length).toBe(40); // 10 块 × 4 柱
    for (const f of cols) {
      const zHalf = (f.zMax - f.zMin) / 2;
      expect(zHalf).toBeCloseTo(COL_AABB_HALF, 12);
    }
  });

  it('空气墙宽度减小：柱 z 带内车缘可更接近柱内缘 11.12（θ=0 收紧到 10.117，未再外推）', () => {
    // 块 0 首柱 z = zc + 0.5·pitch；θ=0 车长沿 Z、车缘 x = xInner 限
    const colZ = K0_ZC + 0.5 * R30_ARCADE.pitch;
    const fp = clampToFootprints(ARCADE_COL_INNER - HALF_W, colZ, 0);
    // 车心已在柱内缘 − 半宽（车缘恰贴 11.12），2D 不再收紧（柱 z 带窄到 0.4，车 z 覆盖擦边不交）
    expect(fp.hit).toBe(false);
    expect(fp.x).toBeCloseTo(ARCADE_COL_INNER - HALF_W, 12); // 10.117
  });
});

describe('R104 ③ 六类地面实体占位边界扫描（不穿 + 不过度挡）', () => {
  it('每类 xInner ≤ 真源可见内缘（不穿）且 ≥ 合理下界（不过度挡）', () => {
    // 真源可见内缘（面 y ≤ 1.85 地面层）：各实体靠路心一侧的真实边界
    const innerBy = {
      frontWall: INNER.faceHalf, // 15.5 前脸
      // hallBase 含两子类：殿台基 15.5 / 殿前大理石带 15.0，均 ≤ faceHalf ⇒ 上界取 faceHalf
      hallBase: INNER.faceHalf,
      cornerBase: INNER.faceHalf - 1.2 / 2, // 14.9 角塔基座裙
      frontBase: FRONT_TOWER_INNER, // 14.8 前排塔基（P1 修正）
      arcadeCol: ARCADE_COL_INNER, // 11.12 拱廊柱
      buttressBase: INNER.faceHalf - 2.15 - 0.55 // 11.35 飞扶壁墩（linkReach=2.15）
    } as const;
    const lowerBound = 9.0; // 合理下界：城内最内实体（柱/墩 11.12/11.35）不应被占位推到 9.0 以内
    for (const kind of Object.keys(innerBy) as (keyof typeof innerBy)[]) {
      const rows = byKind(kind);
      expect(rows.length).toBeGreaterThan(0);
      for (const f of rows) {
        // 不穿：占位内缘 ≤ 真源可见内缘（占位不比真实材料更靠外）
        expect(f.xInner).toBeLessThanOrEqual(innerBy[kind] + 1e-9);
        // 不过度挡：占位内缘 ≥ 合理下界
        expect(f.xInner).toBeGreaterThanOrEqual(lowerBound);
      }
    }
  });

  it('占位盒总数与六类齐备（10 块全量覆盖）', () => {
    expect(CITY_BLOCK_Z.length).toBe(10);
    expect(FOOTPRINTS.length).toBeGreaterThanOrEqual(10 * 6);
    expect(byKind('frontWall').length).toBe(10);
    expect(byKind('hallBase').length).toBe(20);
    expect(byKind('cornerBase').length).toBe(20);
    expect(byKind('frontBase').length).toBe(20);
    expect(byKind('arcadeCol').length).toBe(40);
    expect(byKind('buttressBase').length).toBe(25); // 连墙 20 + 角塔 4（hero 块）+ 主殿前排飞扶壁 1（R105 广场域）
  });
});
