/**
 * R103 阶段二「看不见空隙不挡」（设计 B）护栏 —— 防回退。
 *
 * 铁律：看得见实体贴着挡、看不见空隙不挡。阶段二把块心段 1D 从保守 10.0（柱间/墩间
 * 空气墙）改为**连续墙包络**，周期突出物下沉到 2D clampToFootprints：
 *   - 块心段（dc≥3）1D = 殿身（|z−块心| ≤ hallW/2+0.6）贴殿前大理石带 15.0 → 车心 13.997；
 *     其余块心贴建筑前脸 15.5 → 车心 14.497。
 *   - 块角段（dc<3）从角塔基座 13.897 线性升到 dc=3 处包络，全程无 10.0。
 *   - 柱列 11.12 / 连墙墩 11.35 / 角塔墩 11.35（hero 块 k<2 only）= 周期突出物，
 *     由 2D clampToFootprints 按车 OBB SAT 真相交防穿模（只收紧不放宽、无瞬移）。
 *
 * 本文件钉死 5 条核心不变量（全部真源派生，禁写死 13.997 / 14.497 / 13.897 / 11.12 /
 * 11.35 / 6.85 等）：①块心开放 ②柱不穿模（2D）③殿身 13.997 ④角塔墩 hero-only
 * ⑤漂移豁免。风格参照 r102_footprint_bounds / r100_boundary_precision。
 * ⚠ 隐私红线：不读 git / 不读本机绝对路径。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOUNDS,
  CITY_BLOCK_Z,
  corridorCenterHalfWidth
} from '../src/core/FreeDrive';
import {
  clampToFootprints,
  getCityFootprints,
  type CityFootprint
} from '../src/core/cityFootprints';
import { VEHICLE } from '../src/config/physics';
import { INNER, TOWER } from '../src/render/scene/r28Layout';
import { R30_ARCADE, R97_CITY_BUTTRESS } from '../src/render/scene/castleKit';

/** 车长 / 车宽半尺寸真源（physics.ts，勿写死） */
const HALF_L = VEHICLE.lengthM / 2; // 2.7475
const HALF_W = VEHICLE.widthM / 2; // 1.003

/* ── 包络真源派生（与 FreeDrive / cityFootprints 同源公式，独立重算）── */
/** 殿前大理石带内缘 = faceHalf − 0.5 = 15.0（castleKit.ts:3156） */
const HALL_MARBLE_INNER = INNER.faceHalf - 0.5;
/** 殿身车心限 = 15.0 − 车半宽 = 13.997 */
const HALL_CAR_CENTER = HALL_MARBLE_INNER - HALF_W;
/** 建筑前脸车心限 = faceHalf − 车半宽 = 14.497 */
const FRONT_CAR_CENTER = INNER.faceHalf - HALF_W;
/** 殿身 |z−块心| 包络 = hallW/2 + 0.6 = 6.85 */
const HALL_ZR_EXTENT = TOWER.hallW / 2 + 0.6;
/** 角塔大理石基座内缘 = faceHalf − 1.2/2 = 14.9 */
const CORNER_BASE_INNER = INNER.faceHalf - 1.2 / 2;
/** 角点车心限 = 14.9 − 车半宽 = 13.897 */
const CORNER_CAR_CENTER = CORNER_BASE_INNER - HALF_W;
/** 拱廊柱内缘 = faceHalf − width − translate + 0.12 = 11.12 */
const ARCADE_COL_INNER = INNER.faceHalf - R30_ARCADE.width - 1.0 + 0.12;
/** 飞扶壁角塔外墩内缘 = faceHalf − cornerReach − 0.55 = 11.35 */
const BUTTRESS_CORNER_INNER = INNER.faceHalf - R97_CITY_BUTTRESS.cornerReach - 0.55;
/** 块角过渡宽度 */
const EDGE_TRANSITION = 3;

/** dx(θ) = 半长|sinθ| + 半宽|cosθ|：车 OBB 4 角点相对车心的 x 最大伸展 */
function dxAt(heading: number): number {
  return HALF_L * Math.abs(Math.sin(heading)) + HALF_W * Math.abs(Math.cos(heading));
}

/** 块心包络真源：|z−块心| ≤ HALL_ZR_EXTENT ⇒ 殿身 13.997；否则前脸 14.497 */
function blockEnvelope(z: number): number {
  const [zmin, zmax] = CITY_BLOCK_Z.find(([a, b]) => z >= a && z <= b)!;
  const zc = (zmin + zmax) / 2;
  return Math.abs(z - zc) <= HALL_ZR_EXTENT ? HALL_CAR_CENTER : FRONT_CAR_CENTER;
}

/** 城内 2D 占位清单 */
const FOOTPRINTS = getCityFootprints();

describe('R103 阶段二 ① 块心开放：1D 无 10.0 空气墙', () => {
  it('遍历 hero 块 0 全段 zc±(0..22) 步长 0.5：1D 限 ∈ {殿身, 前脸, 块角过渡}，≥ 13.897', () => {
    const [zmin, zmax] = CITY_BLOCK_Z[0];
    const zc = (zmin + zmax) / 2;
    // 期望的离散值集合：两端包络 + 过渡插值（角塔基座 13.897 → 包络）
    const expected = new Set<number>([HALL_CAR_CENTER, FRONT_CAR_CENTER]);
    for (let dc = 0; dc <= EDGE_TRANSITION; dc += 0.5) {
      for (const edge of [zmin, zmax]) {
        const z = edge + (edge === zmin ? 1 : -1) * dc;
        expected.add(corridorCenterHalfWidth(z));
      }
    }
    let sawFront = false;
    for (let dz = 0; dz <= 22; dz += 0.5) {
      for (const s of [-1, 1]) {
        const z = zc + s * dz;
        const v = corridorCenterHalfWidth(z);
        // 落在期望离散值集合内（1e-9 容差）
        expect([...expected].some((e) => Math.abs(e - v) < 1e-9)).toBe(true);
        // 永不回到旧 10.0 空气墙：≥ 角点车心限 13.897
        expect(v).toBeGreaterThanOrEqual(CORNER_CAR_CENTER - 1e-9);
        // 车缘不越可见面线：车心限 ≤ 前脸包络
        expect(v).toBeLessThanOrEqual(FRONT_CAR_CENTER + 1e-9);
        if (Math.abs(v - FRONT_CAR_CENTER) < 1e-9) sawFront = true;
      }
    }
    expect(sawFront).toBe(true); // 真空隙（前脸）可达
  });

  it('真空隙（柱间隙 zc±8.8，柱内缘 11.12）1D = 前脸包络 14.497，不再被挡在 10.0', () => {
    const [zmin, zmax] = CITY_BLOCK_Z[0];
    const zc = (zmin + zmax) / 2;
    const zGap = zc + 8.8; // i=1 柱位外侧的柱间空隙，落在殿身包络外
    // zr=8.8 > 6.85 ⇒ 前脸包络（非殿身），1D 放到 14.497（柱本身由 2D 防）
    expect(Math.abs(zGap - zc)).toBeGreaterThan(HALL_ZR_EXTENT);
    expect(corridorCenterHalfWidth(zGap)).toBeCloseTo(FRONT_CAR_CENTER, 12);
    expect(corridorCenterHalfWidth(zGap)).toBeGreaterThan(ARCADE_COL_INNER); // > 11.12
  });
});

describe('R103 阶段二 ② 柱不穿模：1D 放宽由 2D clampToFootprints 兜底', () => {
  it('车在柱位 z、斜插 θ=30°：1D 是包络（13.997 > 柱内缘 11.12），2D 收紧到 ≤ 11.12 − dx', () => {
    const [zmin, zmax] = CITY_BLOCK_Z[0];
    const zc = (zmin + zmax) / 2;
    const zp = zc + 0.5 * R30_ARCADE.pitch; // i=0 柱位 z = zc ± 4.4
    const h = -Math.PI / 6; // θ=30°
    const dx = dxAt(h); // 2.243
    // 1D 在柱位 z 给的是连续墙包络（殿身 13.997），可能 > 柱内缘 11.12 ⇒ 1D 不防柱
    const oneD = corridorCenterHalfWidth(zp);
    expect(oneD).toBeCloseTo(HALL_CAR_CENTER, 12);
    expect(oneD).toBeGreaterThan(ARCADE_COL_INNER);
    // 2D：车 OBB 与柱 AABB SAT 真相交 ⇒ x 收紧到柱内缘 − dx（不嵌柱）
    const fp = clampToFootprints(oneD, zp, h);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('arcadeCol');
    expect(fp.x).toBeCloseTo(ARCADE_COL_INNER - dx, 9);
    expect(fp.x).toBeLessThan(oneD); // 2D 比 1D 更紧
    expect(fp.x + dx).toBeLessThanOrEqual(ARCADE_COL_INNER + 1e-9); // 车角不越柱内缘
  });

  it('镜像：−X 侧柱位 θ=30° 收紧到 −(11.12 − dx)，外法向指向 +X（推向路内）', () => {
    const [zmin, zmax] = CITY_BLOCK_Z[0];
    const zc = (zmin + zmax) / 2;
    const zp = zc - 0.5 * R30_ARCADE.pitch;
    const h = Math.PI / 6;
    const fp = clampToFootprints(-HALL_CAR_CENTER, zp, h);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('arcadeCol');
    expect(fp.x).toBeCloseTo(-(ARCADE_COL_INNER - dxAt(h)), 9);
    expect(fp.nx).toBe(1);
  });
});

describe('R103 阶段二 ③ 殿身包络 13.997（车缘贴殿前大理石带 15.0）', () => {
  it('殿身内（|zr| ≤ 6.85）1D = 15.0 − 车半宽 = 13.997，车缘 ≤ 15.0', () => {
    const [zmin, zmax] = CITY_BLOCK_Z[0];
    const zc = (zmin + zmax) / 2;
    for (let dz = 0; dz <= HALL_ZR_EXTENT; dz += 0.5) {
      for (const s of [-1, 1]) {
        const z = zc + s * dz;
        expect(Math.abs(z - zc)).toBeLessThanOrEqual(HALL_ZR_EXTENT + 1e-9);
        expect(corridorCenterHalfWidth(z)).toBeCloseTo(HALL_CAR_CENTER, 12);
        expect(corridorCenterHalfWidth(z) + HALF_W).toBeLessThanOrEqual(HALL_MARBLE_INNER + 1e-9);
      }
    }
  });

  it('殿身包络边界连续：zr=6.85 内 13.997、刚好越界即前脸 14.497（单调不跳变）', () => {
    const [zmin, zmax] = CITY_BLOCK_Z[0];
    const zc = (zmin + zmax) / 2;
    expect(corridorCenterHalfWidth(zc + HALL_ZR_EXTENT)).toBeCloseTo(FRONT_CAR_CENTER, 12);
    expect(corridorCenterHalfWidth(zc + HALL_ZR_EXTENT - 0.01)).toBeCloseTo(HALL_CAR_CENTER, 12);
  });
});

describe('R103 阶段二 ④ 角塔飞扶壁墩 hero-only（k<2）', () => {
  /** 取某块某角（sign=±1）附近 z 覆盖重叠的角塔墩占位 */
  function cornerButtresses(k: number, sign: -1 | 1): CityFootprint[] {
    const [zmin, zmax] = CITY_BLOCK_Z[k];
    const zc = (zmin + zmax) / 2;
    const half = (zmax - zmin) / 2;
    const cz = zc + sign * (half - 0.5); // 角塔中心 = 块端内偏 0.5
    return FOOTPRINTS.filter(
      (f) =>
        f.kind === 'buttressBase' &&
        Math.abs((f.zMin + f.zMax) / 2 - cz) < 0.01 &&
        Math.abs(f.xInner - BUTTRESS_CORNER_INNER) < 1e-9
    );
  }

  it('真源派生：角塔墩内缘 11.35（非写死）；连墙墩与角塔墩同为 buttressBase 共 26 座（含主殿前排飞扶壁 + 跨街承托柱）', () => {
    expect(BUTTRESS_CORNER_INNER).toBeCloseTo(11.35, 12);
    // 20 连墙墩（10 块 × 2 段）+ 4 角塔墩（hero 块 k=0,1 各 2 角）+ 1 主殿前排飞扶壁内墩（R105 广场域）
    // + 1 跨街连廊承托柱（R123 Fix 2）
    expect(FOOTPRINTS.filter((f) => f.kind === 'buttressBase').length).toBe(26);
  });

  it('hero 块（k=0,1）每块有 2 个角塔墩 2D 占位（内缘 11.35，z 同角塔中心）', () => {
    for (const k of [0, 1]) {
      const lower = cornerButtresses(k, -1);
      const upper = cornerButtresses(k, 1);
      expect(lower.length).toBe(1);
      expect(upper.length).toBe(1);
      for (const f of [...lower, ...upper]) {
        expect(f.xInner).toBeCloseTo(BUTTRESS_CORNER_INNER, 12);
      }
    }
  });

  it('非 hero 块（k≥2）角塔处无角塔墩占位（渲染端不建 ⇒ 不造假空气墙）', () => {
    for (let k = 2; k < CITY_BLOCK_Z.length; k++) {
      expect(cornerButtresses(k, -1).length).toBe(0);
      expect(cornerButtresses(k, 1).length).toBe(0);
    }
  });
});

describe('R105 漂移态 2D 启用：城内/广场 2D 唯一入口 = clampToFootprints（结构断言）', () => {
  it('clampToFootprints 是纯函数：2D 收紧在 [zMin,gateBackZ] 对非漂移+漂移都激活（结构断言）', () => {
    // R105：去掉 !driftActive 门控 ⇒ 漂移态也做 2D 位置钳（堵死漂移穿模 3.5~5.6m）。
    //   漂移分支只做「位置钳 + 朝向贴墙收敛 + β/横摆回收」，不注入 impactN/speed/scrub
    //   （那是 R103 β 半衰回归的元凶）。漂移手感回归由 free_drift.test.ts 覆盖（β 塌缩 /
    //   rearGrip 复原），此处只钉「城内/广场 2D 唯一入口 = clampToFootprints」结构不变量。
    const src = readFileSync(
      resolve(__dirname, '../src/core/FreeDrive.ts'),
      'utf8'
    );
    // step() 2D 门控：城内+广场+城门带域 [zMin, 塔基北界+半长]（R118 上界 gateBackZ→gateFrontZ
    //   纳入城门带门墩；R105 下界 plazaZ→zMin，纳入主殿飞扶壁；R119 北扩 CAR_HALF_L；R120 上界
    //   再北扩到 GATE_PIER_Z_MAX + CAR_HALF_L（门墩塔基实体北界，车头一触塔基即 2D 接管））
    expect(src).toMatch(/nz <= GATE_PIER_Z_MAX \+ CAR_HALF_L && nz >= BOUNDS\.zMin/);
    // 非漂移 + 漂移两处都调 clampToFootprints（漂移态不再被整体跳过）
    expect(src).toMatch(/clampToFootprints\(s\.x, s\.z, s\.heading\)/);
  });

  it('clampToFootprints 纯函数行为：非漂移态语义（只收紧不放宽、R121 缺块补街 frontWall 接管斜插）', () => {
    // R121 ⑥c：空档 z=−600（缺块 k=5 [−641.5,−595.5]，R99 补街殿身/连墙前脸 |x|=15.5）已补
    //   frontWall footprint ⇒ 斜插 θ=−30° 车角（dx=2.2424）穿补墙被钳到 15.5−2.2424=13.2576
    //   （旧版无 footprint ⇒ hit=false 原样放行 = 空档斜插穿模 1.24m 的固化缺陷）。
    const fp = clampToFootprints(14.0, -600, -Math.PI / 6);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('frontWall');
    expect(fp.x).toBeCloseTo(15.5 - 2.2424, 3);
    // 直行 θ=0 车缘 14.497+1.003=15.5 恰贴补墙 ⇒ 2D 零收紧（无新空气墙）
    const fpStraight = clampToFootprints(14.0, -600, 0);
    expect(fpStraight.hit).toBe(false);
    expect(fpStraight.x).toBe(14.0);
    // 块心殿身无柱/墩（z=zc，zr=0）：2D 不新增钳位（1D 包络 13.997 已是最紧连续墙）
    const [zmin, zmax] = CITY_BLOCK_Z[0];
    const zc = (zmin + zmax) / 2;
    const fpHall = clampToFootprints(HALL_CAR_CENTER, zc, 0);
    expect(fpHall.hit).toBe(false);
  });
});
