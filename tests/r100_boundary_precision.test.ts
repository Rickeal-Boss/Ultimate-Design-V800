/**
 * R100 · 挡车边界精度贴可见实体（柱列周期 + 空档角塔带）。
 *
 * 用户澄清（最高优先级）：车能开上人行道/广场、能开出边界都没问题；要解决的是
 * 「挡车边界精确贴合可见实体」——看得见实体的地方贴着实体挡，看不见空隙的地方不挡。
 * 不补可见街沿、不加兜底墙（回避方案已被主理人否决）。
 *
 * 本文件钉：
 *   ① 柱位 z（zc±4.4/±13.2，pitch=8.8）车心限 10.117、车缘 11.12 = 柱内缘；
 *   ② 柱间邻域维持 R97 10.0（车缘 11.003），**不放宽**到 14.497 —— 飞扶壁墩内缘
 *      11.125/11.35 < 14.497，放宽必撞墩（审查团 §2.1），故窄带是正确产品决策；
 *   ③ 空档块边界外侧 0~2.6m 角塔基座覆盖带车心限 13.897（车缘 14.9 贴基座）；
 *   ④ 覆盖带外端 0.4m 线性过渡，带外 (>3.0m) 恢复 14.497；
 *   ⑤ 全程车缘 ≤ 可见实体内缘；corridorHalfWidth / BOUNDS 逐位不变（CameraRig 依赖）。
 *
 * 真源口径：R30_ARCADE / INNER / VEHICLE / R97_CITY_BUTTRESS 一律 import 派生，
 * 禁止写死 10.117 / 11.12 / 8.8 / 1.303 / 2.6 / 13.897 / 14.9 / 14.497。
 * ⚠ 隐私红线：不读 git / 不读本机绝对路径。
 */
import { describe, expect, it } from 'vitest';
import {
  BOUNDS,
  corridorCenterHalfWidth,
  corridorHalfWidth,
  resolveBounds
} from '../src/core/FreeDrive';
import { VEHICLE } from '../src/config/physics';
import { INNER } from '../src/render/scene/r28Layout';
import { R30_ARCADE, R97_CITY_BUTTRESS } from '../src/render/scene/castleKit';

/** 车半宽真源（physics.ts，勿写死） */
const CAR_HALF = VEHICLE.widthM / 2; // 1.003
/** 拱廊柱半径 / 柱心外偏 / 整体内移（castleDetail.ts:1397,1410 / castleKit.ts:3474，真源不可 import） */
const COL_R = 0.3;
const COL_OFFSET = 0.12;
const ARCADE_TRANSLATE = 1.0;
/** 拱廊柱可见内缘：faceHalf − width − translate + colOffset（colR 与 +colR 抵消）= 11.12 */
const PILLAR_INNER = INNER.faceHalf - R30_ARCADE.width - ARCADE_TRANSLATE + COL_OFFSET;
/** 柱位车心限 = 柱内缘 − 车半宽 = 10.117 */
const PILLAR_CAR_CENTER = PILLAR_INNER - CAR_HALF;
/** 柱位 z 邻域半宽 = colR + 车半宽 = 1.303 */
const PILLAR_NEAR_HALF = COL_R + CAR_HALF;
/** 柱 z 节距 = R30_ARCADE.pitch = 8.8；单侧柱数 n = floor((blockLen−2)/2/pitch) */
const PILLAR_PITCH = R30_ARCADE.pitch;
/** 角塔基座裙 / 进深 / 块端内偏（castleKit.ts:3381,330,3461，真源不可 import） */
const CORNER_SKIRT = 1.2;
const CORNER_D = 5;
const CORNER_BLOCK_END_INSET = 0.5;
/** 角塔基座可见内缘 = faceHalf − skirt/2 = 14.9；车心限 13.897 */
const CORNER_BASE_INNER = INNER.faceHalf - CORNER_SKIRT / 2;
const CORNER_CAR_CENTER = CORNER_BASE_INNER - CAR_HALF;
/** 基座伸进空档的覆盖带 = (d+skirt)/2 − 块端内偏 = 2.6；过渡带 0.4 */
const CORNER_Z_REACH = (CORNER_D + CORNER_SKIRT) / 2 - CORNER_BLOCK_END_INSET;
const CORNER_Z_FADE = 0.4;
/** 空档开放车心限 = 建筑前脸线 − 车半宽 = 14.497；块心车心限（R97）= 10.0 */
const OPEN_CAR_CENTER = 15.5 - CAR_HALF;
const BLOCK_CENTER = BOUNDS.arcadeHalfW; // 10.0
/** 飞扶壁墩内缘（castleKit.ts:319-323 reach + castleDetail.ts:337 −0.55 基座）= 11.35 / hi 11.125 */
const BUTTRESS_INNER = INNER.faceHalf - R97_CITY_BUTTRESS.linkReach - 0.55; // 11.35
const BUTTRESS_INNER_HI = BUTTRESS_INNER - 0.225; // 11.125

/** 与 FreeDrive.CITY_BLOCK_Z 严格一致的 10 个 keep=10 街区区间（测试 fixture） */
const CITY_BLOCK_Z: ReadonlyArray<readonly [number, number]> = [
  [-411.5, -365.5],
  [-457.5, -411.5],
  [-503.5, -457.5],
  [-549.5, -503.5],
  [-687.5, -641.5],
  [-779.5, -733.5],
  [-917.5, -871.5],
  [-1055.5, -1009.5],
  [-1147.5, -1101.5],
  [-1285.5, -1239.5]
];
const PILLAR_COUNT = Math.floor((CITY_BLOCK_Z[0][1] - CITY_BLOCK_Z[0][0] - 2) / 2 / PILLAR_PITCH);
/** 朝 +X 墙开（heading=−π/2 ⇒ forward.x=+1 ⇒ fn>0 ⇒ kind='side'） */
const HEADING_TO_PLUS_X = -Math.PI / 2;

/** 车缘 = 车心限 + 车半宽 */
function carEdge(z: number): number {
  return corridorCenterHalfWidth(z) + CAR_HALF;
}

describe('R100 ① 真源派生（非写死派生数值）', () => {
  it('柱内缘 / 柱位车心限 / 邻域半宽 / 节距全部来自 import 真源', () => {
    expect(CAR_HALF).toBeCloseTo(1.003, 12);
    expect(R30_ARCADE.width).toBeCloseTo(3.5, 12);
    expect(R30_ARCADE.pitch).toBeCloseTo(8.8, 12);
    expect(PILLAR_INNER).toBeCloseTo(11.12, 12);
    expect(PILLAR_CAR_CENTER).toBeCloseTo(10.117, 12);
    expect(PILLAR_NEAR_HALF).toBeCloseTo(1.303, 12);
    expect(PILLAR_COUNT).toBe(2);
  });

  it('角塔覆盖带 / 车心限来自 import 真源', () => {
    expect(CORNER_BASE_INNER).toBeCloseTo(14.9, 12);
    expect(CORNER_CAR_CENTER).toBeCloseTo(13.897, 12);
    expect(CORNER_Z_REACH).toBeCloseTo(2.6, 12);
    expect(OPEN_CAR_CENTER).toBeCloseTo(14.497, 12);
  });
});

describe('R100 ② 柱列周期贴实体（柱位 10.117 / 柱间 10.0）', () => {
  it('全部 10 块 × 双端柱位 z：车心限 10.117、车缘 11.12 = 柱内缘（不穿柱）', () => {
    let count = 0;
    for (const [zmin, zmax] of CITY_BLOCK_Z) {
      const zc = (zmin + zmax) / 2;
      for (let i = 0; i < PILLAR_COUNT; i += 1) {
        const offset = (i + 0.5) * PILLAR_PITCH;
        for (const sign of [-1, 1] as const) {
          const z = zc + sign * offset;
          expect(corridorCenterHalfWidth(z)).toBeCloseTo(PILLAR_CAR_CENTER, 12);
          expect(carEdge(z)).toBeCloseTo(PILLAR_INNER, 12);
          expect(carEdge(z)).toBeLessThanOrEqual(PILLAR_INNER + 1e-9);
          count += 1;
        }
      }
    }
    expect(count).toBe(40); // 10 块 × 4 柱位
  });

  it('柱位邻域边界 |z−z_pillar|=1.303 仍贴柱，越界即回 10.0', () => {
    const zc = (CITY_BLOCK_Z[0][0] + CITY_BLOCK_Z[0][1]) / 2; // k0 块心 −388.5
    const zp = zc + 0.5 * PILLAR_PITCH; // −384.1
    expect(corridorCenterHalfWidth(zp + PILLAR_NEAR_HALF)).toBeCloseTo(PILLAR_CAR_CENTER, 12);
    expect(corridorCenterHalfWidth(zp - PILLAR_NEAR_HALF)).toBeCloseTo(PILLAR_CAR_CENTER, 12);
    // +1mm 越界（仍在 dc≥3 且不与邻柱/角过渡重叠）⇒ 回 10.0
    expect(corridorCenterHalfWidth(zp + PILLAR_NEAR_HALF + 0.001)).toBeCloseTo(BLOCK_CENTER, 12);
  });

  it('柱间 / 块心（−388.5 / −408.5 / −368.5）保持 10.0，车缘 11.003', () => {
    for (const z of [-388.5, -408.5, -368.5]) {
      expect(corridorCenterHalfWidth(z)).toBeCloseTo(BLOCK_CENTER, 12);
      expect(carEdge(z)).toBeCloseTo(11.003, 12);
    }
  });

  it('柱间为何不放宽：11.003 车缘 < 飞扶壁墩内缘 11.125/11.35，放到 14.497 必撞墩', () => {
    const blockEdge = BLOCK_CENTER + CAR_HALF; // 11.003
    expect(blockEdge).toBeLessThan(BUTTRESS_INNER); // 11.003 < 11.35
    expect(blockEdge).toBeLessThan(BUTTRESS_INNER_HI); // 11.003 < 11.125
    expect(OPEN_CAR_CENTER).toBeGreaterThan(BUTTRESS_INNER_HI); // 14.497 > 11.125 ⇒ 放宽必撞墩
    // 净空：到 hi 墩 0.122m、到普通墩 0.347m；柱位贴柱后净空 0.005m（11.125−11.12）
    expect(BUTTRESS_INNER_HI - blockEdge).toBeCloseTo(0.122, 9);
    expect(BUTTRESS_INNER_HI - PILLAR_INNER).toBeCloseTo(0.005, 9);
  });
});

describe('R100 ③ 空档角塔带贴实体（带内 13.897 / 带外 14.497）', () => {
  it('各空档块边界外侧 0~2.6m：车心限 13.897、车缘 14.9 贴基座', () => {
    // 取真实存在空档的块边界（相邻块共享边界的除外）：k3 下界、k4 上界、k9 上界
    const gapEdges: ReadonlyArray<{ z: number; sign: -1 | 1 }> = [
      { z: CITY_BLOCK_Z[3][0], sign: -1 }, // −549.5 下边界，空档在其下（z 更小）
      { z: CITY_BLOCK_Z[4][1], sign: 1 }, // −641.5 上边界，空档在其上（z 更大）
      { z: CITY_BLOCK_Z[9][1], sign: 1 } // −1239.5 上边界
    ];
    for (const { z: edge, sign } of gapEdges) {
      for (const d of [0.1, 1.0, CORNER_Z_REACH]) {
        const z = edge + sign * d;
        expect(corridorCenterHalfWidth(z)).toBeCloseTo(CORNER_CAR_CENTER, 12);
        expect(carEdge(z)).toBeCloseTo(CORNER_BASE_INNER, 12);
        expect(carEdge(z)).toBeLessThanOrEqual(CORNER_BASE_INNER + 1e-9);
      }
    }
  });

  it('覆盖带外端 0.4m 线性过渡，带外 (>3.0m) 恢复 14.497', () => {
    const edge = CITY_BLOCK_Z[3][0]; // −549.5
    const zAt = (d: number) => edge - d;
    // 带内端点
    expect(corridorCenterHalfWidth(zAt(CORNER_Z_REACH))).toBeCloseTo(CORNER_CAR_CENTER, 12);
    // 过渡中点
    const midD = CORNER_Z_REACH + CORNER_Z_FADE / 2; // 2.8
    expect(corridorCenterHalfWidth(zAt(midD))).toBeCloseTo(
      (CORNER_CAR_CENTER + OPEN_CAR_CENTER) / 2,
      12
    );
    // 过渡终点 / 带外
    expect(corridorCenterHalfWidth(zAt(CORNER_Z_REACH + CORNER_Z_FADE))).toBeCloseTo(
      OPEN_CAR_CENTER,
      12
    );
    expect(corridorCenterHalfWidth(zAt(CORNER_Z_REACH + CORNER_Z_FADE + 2))).toBeCloseTo(
      OPEN_CAR_CENTER,
      12
    );
  });

  it('深空档（z=−600）仍 14.497，未受角塔带影响', () => {
    expect(corridorCenterHalfWidth(-600)).toBeCloseTo(OPEN_CAR_CENTER, 12);
    expect(carEdge(-600)).toBeCloseTo(15.5, 12);
  });

  it('全程车缘 ≤ 可见实体内缘（柱位贴柱 / 角带贴基座 / 空档贴前脸线）', () => {
    for (let z = -1285; z <= -366; z += 0.5) {
      const edge = carEdge(z);
      // 可见内缘的最大包络：柱内缘 11.12 / 角塔基座 14.9 / 建筑前脸线 15.5
      expect(edge).toBeLessThanOrEqual(INNER.faceHalf + 1e-9);
    }
  });
});

describe('R100 ④ resolveBounds 落在新车心限 + 未触碰口径不变', () => {
  it('柱位 / 角带 / 深空档撞侧墙 x 等于对应车心限', () => {
    const zc = (CITY_BLOCK_Z[0][0] + CITY_BLOCK_Z[0][1]) / 2;
    const zPillar = zc + 0.5 * PILLAR_PITCH;
    expect(resolveBounds(20, zPillar, HEADING_TO_PLUS_X, 10).x).toBeCloseTo(PILLAR_CAR_CENTER, 12);
    expect(resolveBounds(20, CITY_BLOCK_Z[3][0] - 1, HEADING_TO_PLUS_X, 10).x).toBeCloseTo(
      CORNER_CAR_CENTER,
      12
    );
    expect(resolveBounds(20, -600, HEADING_TO_PLUS_X, 10).x).toBeCloseTo(OPEN_CAR_CENTER, 12);
    expect(resolveBounds(20, zPillar, HEADING_TO_PLUS_X, 10).kind).toBe('side');
  });

  it('corridorHalfWidth 面线逐位不变（CameraRig 依赖）', () => {
    expect(corridorHalfWidth(0)).toBe(12.0);
    expect(corridorHalfWidth(-358.5)).toBe(10.0);
    expect(corridorHalfWidth(-388.5)).toBe(10.0);
    expect(corridorHalfWidth(-411.5)).toBe(15.5);
    expect(corridorHalfWidth(-600)).toBe(15.5);
    expect(corridorHalfWidth(-1290)).toBe(15.5);
  });

  it('BOUNDS 关键常量不变', () => {
    expect(BOUNDS.bridgeHalfW).toBe(12.0);
    expect(BOUNDS.tunnelHalfW).toBe(10.0);
    expect(BOUNDS.arcadeHalfW).toBe(10.0);
    expect(BOUNDS.cityOpenHalfW).toBe(15.5);
    expect(BOUNDS.plazaHalfW).toBe(15.5);
    expect(BOUNDS.zMin).toBe(-1297);
    expect(BOUNDS.zMax).toBe(70);
    expect(BOUNDS.hallZ).toBe(-1297.5);
    expect(BOUNDS.hallHalfW).toBe(24);
  });

  it('其它段车心限不变：桥 10.997 / 门 8.997 / 广场 14.497', () => {
    expect(corridorCenterHalfWidth(0)).toBeCloseTo(12.0 - CAR_HALF, 12);
    expect(corridorCenterHalfWidth(-358.5)).toBeCloseTo(10.0 - CAR_HALF, 12);
    expect(corridorCenterHalfWidth(-1290)).toBeCloseTo(15.5 - CAR_HALF, 12);
  });
});
