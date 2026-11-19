/**
 * R100 · 挡车边界精度贴可见实体（R103 阶段二「看不见空隙不挡」重钉 · 设计 B）。
 *
 * 用户铁律（最高优先级）：看得见实体的地方贴着实体挡，看不见空隙的地方不挡。
 * R103 阶段二落地「设计 B」——块心 1D 只保留**连续墙**包络，周期突出物（柱列 / 飞扶壁墩）
 * 全部下沉到 2D clampToFootprints（车 OBB SAT 真相交才钳，只收紧不放宽、无瞬移）：
 *   - 殿身段（|z−块心| ≤ hallW/2+0.6）：连续墙 = 殿前大理石带 15.0 ⇒ 车心限 13.997；
 *   - 其余块心段：连续墙 = 建筑前脸 15.5 ⇒ 车心限 14.497；
 *   - 柱位 z 带**不再有 10.117 窄带**，1D 限 = 它所在的包络（殿身 / 前脸）；
 *   - 柱（11.12）/ 连墙墩（11.35）/ 角塔墩（11.35）由 2D 兜底防穿模。
 *
 * 本文件钉：
 *   ① 真源派生（殿身/前脸包络、柱内缘、节距、角塔带）；
 *   ② 柱位 z 两类（zc±4.4 殿身 / zc±13.2 前脸）1D 限 = 所在包络、车缘 ≤ 对应面线；
 *      柱不穿模改由 2D clampToFootprints 斜插收紧到「柱内缘 11.12 − dx(θ)」；
 *      柱位邻域 1D 连续无跳变（无 10.117 窄带）；块心 = 真实连续墙包络；
 *      前脸 14.497 越过墩内缘 11.35 合法，墩由 2D 收紧兜底；
 *   ③ 空档角塔带（不变）：带内 13.897 / 带外 14.497；
 *   ④ resolveBounds 落在新车心限 + corridorHalfWidth / BOUNDS 逐位不变。
 *
 * 真源口径：R30_ARCADE / INNER / TOWER / VEHICLE / R97_CITY_BUTTRESS 一律 import 派生，
 * 禁止写死 13.997 / 14.497 / 11.12 / 11.35 / 6.85 / 2.6 / 13.897 / 14.9。
 * ⚠ 隐私红线：不读 git / 不读本机绝对路径。
 */
import { describe, expect, it } from 'vitest';
import {
  BOUNDS,
  CITY_BLOCK_Z,
  corridorCenterHalfWidth,
  corridorHalfWidth,
  resolveBounds
} from '../src/core/FreeDrive';
import { clampToFootprints, getCityFootprints } from '../src/core/cityFootprints';
import { VEHICLE } from '../src/config/physics';
import { INNER, TOWER } from '../src/render/scene/r28Layout';
import { R30_ARCADE, R97_CITY_BUTTRESS } from '../src/render/scene/castleKit';

/** 车半宽 / 半长真源（physics.ts，勿写死） */
const CAR_HALF = VEHICLE.widthM / 2; // 1.003
const CAR_HALF_L = VEHICLE.lengthM / 2; // 2.7475

/** 拱廊柱心外偏 / 整体内移（castleDetail.ts:1410 / castleKit.ts:3474，真源不可 import） */
const COL_OFFSET = 0.12;
const ARCADE_TRANSLATE = 1.0;
/** 拱廊柱可见内缘：faceHalf − width − translate + colOffset（colR 与 +colR 抵消）= 11.12 */
const PILLAR_INNER = INNER.faceHalf - R30_ARCADE.width - ARCADE_TRANSLATE + COL_OFFSET;
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

/** 殿前大理石带单侧宽（castleKit.ts:3156 box(0.5)）/ z 半外扩（cityFootprints hallBase 同源） */
const MARBLE_BAND = 0.5;
const HALL_Z_OVERHANG = 0.6;
/** 殿前大理石带内缘 = faceHalf − 0.5 = 15.0（连续墙）；殿身车心限 13.997 */
const HALL_MARBLE_INNER = INNER.faceHalf - MARBLE_BAND;
const HALL_ENVELOPE = HALL_MARBLE_INNER - CAR_HALF;
/** 殿身 |z−块心| 包络 = hallW/2 + 大理石带 z 半外扩 = 6.85 */
const HALL_ZR_EXTENT = TOWER.hallW / 2 + HALL_Z_OVERHANG;
/** 建筑前脸 / 空档开放车心限 = cityOpenHalfW − 车半宽 = 14.497（前脸连续墙包络） */
const OPEN_CAR_CENTER = BOUNDS.cityOpenHalfW - CAR_HALF;

/** 飞扶壁墩内缘（castleKit.ts:319-323 reach + castleDetail.ts:337 −0.55 基座）= 11.35 */
const BUTTRESS_INNER = INNER.faceHalf - R97_CITY_BUTTRESS.linkReach - 0.55;

/** 块长（r28Layout INNER.blockLen = 46） */
const BLOCK_LEN = INNER.blockLen;
/** 前排塔基进深 castleKit.ts:3254 box(9.4,…,depth/2)，depth=8 ⇒ 9.4/2 = 4.7（真源不可 import） */
const FRONT_TOWER_DEPTH = 4.7;
/** 连墙段（塔→殿）局部中点 = (−blockLen/2 + −(blockLen/4+4.7))/2 = −19.6 */
const LINK_SEG_MID_LOCAL = (-(BLOCK_LEN / 2) + -(BLOCK_LEN / 4 + FRONT_TOWER_DEPTH)) / 2;

/** 单侧柱数 n = floor((blockLen−2)/2/pitch) */
const PILLAR_COUNT = Math.floor((CITY_BLOCK_Z[0][1] - CITY_BLOCK_Z[0][0] - 2) / 2 / PILLAR_PITCH);
/** 朝 +X 墙开（heading=−π/2 ⇒ forward.x=+1 ⇒ fn>0 ⇒ kind='side'） */
const HEADING_TO_PLUS_X = -Math.PI / 2;
/** 2D 斜插角（30°）：车 OBB x 伸展 dx = 半长|sinθ| + 半宽|cosθ| > 车半宽 */
const OBLIQUE = Math.PI / 6;
/** 车 OBB 4 角点相对车心的 x 最大伸展（与 clampToFootprints 同式） */
function dxAt(heading: number): number {
  return CAR_HALF_L * Math.abs(Math.sin(heading)) + CAR_HALF * Math.abs(Math.cos(heading));
}

/** 车缘 = 车心限 + 车半宽 */
function carEdge(z: number): number {
  return corridorCenterHalfWidth(z) + CAR_HALF;
}
/** 给定 |z−块心|，1D 连续墙包络（殿身 13.997 / 前脸 14.497） */
function envelopeAt(zr: number): number {
  return zr <= HALL_ZR_EXTENT ? HALL_ENVELOPE : OPEN_CAR_CENTER;
}
/** 给定 |z−块心|，包络对应的可见面线（殿身大理石带 15.0 / 建筑前脸 15.5） */
function faceAt(zr: number): number {
  return zr <= HALL_ZR_EXTENT ? HALL_MARBLE_INNER : INNER.faceHalf;
}

describe('R100 ① 真源派生（非写死派生数值）', () => {
  it('柱内缘 / 节距 / 单侧柱数 / 车半宽全部来自 import 真源', () => {
    expect(CAR_HALF).toBeCloseTo(1.003, 12);
    expect(R30_ARCADE.width).toBeCloseTo(3.5, 12);
    expect(R30_ARCADE.pitch).toBeCloseTo(8.8, 12);
    expect(PILLAR_INNER).toBeCloseTo(11.12, 12);
    expect(PILLAR_COUNT).toBe(2);
  });

  it('殿身 / 前脸连续墙包络 / 殿身 z 包络来自 import 真源', () => {
    expect(HALL_MARBLE_INNER).toBeCloseTo(15.0, 12);
    expect(HALL_ENVELOPE).toBeCloseTo(13.997, 12);
    expect(HALL_ZR_EXTENT).toBeCloseTo(6.85, 12);
    expect(OPEN_CAR_CENTER).toBeCloseTo(14.497, 12);
  });

  it('角塔覆盖带 / 车心限来自 import 真源', () => {
    expect(CORNER_BASE_INNER).toBeCloseTo(14.9, 12);
    expect(CORNER_CAR_CENTER).toBeCloseTo(13.897, 12);
    expect(CORNER_Z_REACH).toBeCloseTo(2.6, 12);
  });
});

describe('R103 阶段二 · 柱位 z 1D=所在包络 / 柱·墩由 2D 兜底', () => {
  it('全部 10 块 × 双端柱位 z：1D 限 = 殿身/前脸包络、车缘 ≤ 对应面线（无 10.117 窄带）', () => {
    let count = 0;
    for (const [zmin, zmax] of CITY_BLOCK_Z) {
      const zc = (zmin + zmax) / 2;
      for (let i = 0; i < PILLAR_COUNT; i += 1) {
        const offset = (i + 0.5) * PILLAR_PITCH;
        for (const sign of [-1, 1] as const) {
          const z = zc + sign * offset;
          const zr = Math.abs(offset); // |z−块心| = 柱偏移（4.4 / 13.2）
          expect(corridorCenterHalfWidth(z)).toBeCloseTo(envelopeAt(zr), 12);
          // 车缘 ≤ 该包络的可见面线（殿身 15.0 / 前脸 15.5），不再被柱位收窄到 11.12
          expect(carEdge(z)).toBeLessThanOrEqual(faceAt(zr) + 1e-9);
          count += 1;
        }
      }
    }
    expect(count).toBe(40); // 10 块 × 4 柱位
  });

  it('柱不穿模改由 2D 兜底：斜插车被 clampToFootprints 收紧到「柱内缘 11.12 − dx(θ)」', () => {
    const zc = (CITY_BLOCK_Z[0][0] + CITY_BLOCK_Z[0][1]) / 2;
    const bound = PILLAR_INNER - dxAt(OBLIQUE);
    // 两类柱位 z（殿身 zr=4.4 / 前脸 zr=13.2）都由同一 arcadeCol 2D 占位收紧
    for (const off of [0.5 * PILLAR_PITCH, 1.5 * PILLAR_PITCH]) {
      for (const sign of [-1, 1] as const) {
        const z = zc + sign * off;
        const r = clampToFootprints(OPEN_CAR_CENTER, z, OBLIQUE);
        expect(r.hit).toBe(true);
        expect(r.kind).toBe('arcadeCol');
        expect(r.x).toBeCloseTo(bound, 12);
      }
    }
  });

  it('柱位邻域 1D 连续无跳变（不再有 10.117 窄带，越柱位带不回落）', () => {
    const zc = (CITY_BLOCK_Z[0][0] + CITY_BLOCK_Z[0][1]) / 2;
    const zp = zc + 0.5 * PILLAR_PITCH; // 殿身柱位 −384.1（zr=4.4）
    // 柱位邻域内外连续采样：1D 限恒等于殿身包络，无任何窄带跳变
    for (const d of [-2.0, -1.303, -0.5, 0, 0.5, 1.303, 1.304, 2.0]) {
      expect(corridorCenterHalfWidth(zp + d)).toBeCloseTo(HALL_ENVELOPE, 12);
    }
  });

  it('柱间 / 块心（−388.5 殿身 / −408.5·−368.5 前脸）= 真实连续墙包络', () => {
    expect(corridorCenterHalfWidth(-388.5)).toBeCloseTo(HALL_ENVELOPE, 12); // zr=0 殿身
    for (const z of [-408.5, -368.5]) {
      expect(corridorCenterHalfWidth(z)).toBeCloseTo(OPEN_CAR_CENTER, 12); // zr=20 前脸
    }
    // 车缘 = 限 + 车半宽，恰贴对应连续墙面线
    expect(carEdge(-388.5)).toBeCloseTo(HALL_MARBLE_INNER, 12); // 15.0 大理石带
    expect(carEdge(-408.5)).toBeCloseTo(INNER.faceHalf, 12); // 15.5 前脸
    expect(carEdge(-368.5)).toBeCloseTo(INNER.faceHalf, 12); // 15.5 前脸
  });

  it('前脸包络 14.497 越过墩内缘 11.35 合法：墩是周期突出物，由 2D 收紧兜底', () => {
    // 1D 已放宽到前脸 14.497 > 飞扶壁墩内缘 11.35 ⇒ 1D 不再为墩保守收窄（旧「必撞墩」premise 推翻）
    expect(OPEN_CAR_CENTER).toBeGreaterThan(BUTTRESS_INNER);
    // 2D 兜底：斜插车在连墙墩位被收紧到「墩内缘 11.35 − dx(θ)」，防穿墩
    const zc = (CITY_BLOCK_Z[0][0] + CITY_BLOCK_Z[0][1]) / 2;
    const pierZ = zc + LINK_SEG_MID_LOCAL; // k0 下连墙墩 −408.1
    const pier = getCityFootprints().find(
      (f) => f.kind === 'buttressBase' && Math.abs((f.zMin + f.zMax) / 2 - pierZ) < 1e-6
    );
    expect(pier).toBeDefined();
    expect(pier!.xInner).toBeCloseTo(BUTTRESS_INNER, 12);
    const r = clampToFootprints(OPEN_CAR_CENTER, pierZ, OBLIQUE);
    expect(r.hit).toBe(true);
    expect(r.kind).toBe('buttressBase');
    expect(r.x).toBeCloseTo(BUTTRESS_INNER - dxAt(OBLIQUE), 12);
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

  it('全程车缘 ≤ 可见实体内缘（角带贴基座 / 块心贴连续墙 / 空档贴前脸线）', () => {
    for (let z = -1285; z <= -366; z += 0.5) {
      const edge = carEdge(z);
      // 可见内缘的最大包络：角塔基座 14.9 / 殿身大理石带 15.0 / 建筑前脸线 15.5
      expect(edge).toBeLessThanOrEqual(INNER.faceHalf + 1e-9);
    }
  });
});

describe('R100 ④ resolveBounds 落在新车心限 + 未触碰口径不变', () => {
  it('柱位 / 角带 / 深空档撞侧墙 x 等于对应车心限', () => {
    const zc = (CITY_BLOCK_Z[0][0] + CITY_BLOCK_Z[0][1]) / 2;
    const zPillar = zc + 0.5 * PILLAR_PITCH; // 殿身柱位 −384.1
    expect(resolveBounds(20, zPillar, HEADING_TO_PLUS_X, 10).x).toBeCloseTo(HALL_ENVELOPE, 12);
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
