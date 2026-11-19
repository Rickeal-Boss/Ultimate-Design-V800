/**
 * R99 · 块角不穿可见角塔基座护栏（多边形角穿模修复）。
 *
 * 回归点：R98 只断言 corridorCenterHalfWidth === corridorHalfWidth（面线语义），
 * 没断言「车缘 ≤ 可见实体内缘」，故漏检块角 3m 过渡车缘冲到 16.503、嵌基座 1.603m。
 * R99 把过渡外端点从抽象面线 15.5 改成可见实体「街区角塔大理石基座内缘 14.9」
 * 再扣车半宽 = 13.897：dc=0 车缘恰贴 14.9，dc≥3 仍 11.003 保持 R97 净空。
 *
 * 真源口径：INNER.faceHalf / VEHICLE.widthM 一律 import；1.2 为 castleKit.ts:3381
 * 基座裙外扩量（与 R30_CORNER.w 相消后仅剩此项），禁止写死派生值 14.9 / 13.897。
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

/** 车半宽真源（physics.ts，勿写死） */
const CAR_HALF_W = VEHICLE.widthM / 2; // 1.003
/** 基座裙外扩真源（castleKit.ts:3381 `ctw + 1.2`，与 R30_CORNER.w 相消） */
const MARBLE_SKIRT = 1.2;
/** 可见实体：街区角塔大理石基座内缘 = 15.5 − 1.2/2 = 14.9 */
const CORNER_BASE_INNER = INNER.faceHalf - MARBLE_SKIRT / 2;
/** 角点车心限 = 14.9 − 1.003 = 13.897 */
const CORNER_CAR_CENTER = CORNER_BASE_INNER - CAR_HALF_W;
/** 块心车心限（R97 不变） */
const BLOCK_CENTER = BOUNDS.arcadeHalfW; // 10.0
/** 块心车缘（R97 净空：11.003 < 柱内缘 11.12） */
const BLOCK_CAR_EDGE = BLOCK_CENTER + CAR_HALF_W; // 11.003

/** 朝 +X 墙开（heading=−π/2 ⇒ forward.x=+1 ⇒ fn>0 ⇒ kind='side'） */
const HEADING_TO_PLUS_X = -Math.PI / 2;

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

/** 车缘 = 车心限 + 车半宽 */
function carEdge(z: number): number {
  return corridorCenterHalfWidth(z) + CAR_HALF_W;
}

/**
 * 纯城内块角点（排除与分段边界重合的两点）：
 *   −365.5 = gateBackZ ⇒ 归城门带（车心限 8.997，见 r98 ② 第三例）；
 *   −1285.5 = plazaZ ⇒ 归主殿广场（车心限 14.497）。
 * 这两点分段顺序未改，不属于 R99 块角修复范围。
 */
const PURE_CITY_CORNERS: ReadonlyArray<number> = CITY_BLOCK_Z.flatMap(([zmin, zmax]) =>
  [zmin, zmax].filter((z) => z !== BOUNDS.gateBackZ && z !== BOUNDS.plazaZ)
);

describe('R99 ① 块角车缘 ≤ 可见角塔基座内缘 14.9', () => {
  it('真源派生：基座内缘 14.9 / 角点车心限 13.897（非写死）', () => {
    expect(CAR_HALF_W).toBeCloseTo(1.003, 12);
    expect(CORNER_BASE_INNER).toBeCloseTo(14.9, 12);
    expect(CORNER_CAR_CENTER).toBeCloseTo(13.897, 12);
  });

  it('全部 10 个街区角点：车心限 13.897、车缘恰贴 14.9（修复前 16.503 嵌 1.603m）', () => {
    expect(PURE_CITY_CORNERS.length).toBe(18); // 20 个端点 − 2 个分段重合点
    for (const z of PURE_CITY_CORNERS) {
      expect(corridorCenterHalfWidth(z)).toBeCloseTo(CORNER_CAR_CENTER, 12);
      expect(carEdge(z)).toBeCloseTo(CORNER_BASE_INNER, 12);
      expect(carEdge(z)).toBeLessThanOrEqual(CORNER_BASE_INNER + 1e-9);
    }
  });

  it('块角过渡区任意 z：车缘始终 ≤ 基座内缘 14.9（单调不越界）', () => {
    for (const [zmin, zmax] of CITY_BLOCK_Z) {
      for (const edge of [zmin, zmax]) {
        const sign = edge === zmin ? 1 : -1;
        for (let dc = 0; dc <= 3; dc += 0.25) {
          const z = edge + sign * dc;
          if (z === BOUNDS.gateBackZ || z === BOUNDS.plazaZ) continue;
          expect(carEdge(z)).toBeLessThanOrEqual(CORNER_BASE_INNER + 1e-9);
        }
      }
    }
  });
});

describe('R99 ② 折线顶点与块心净空（R97 不变）', () => {
  it('k=0 下角 −411.5：dc=0→13.897 / dc=0.5→线性插值 / dc=3→10.0', () => {
    expect(corridorCenterHalfWidth(-411.5)).toBeCloseTo(CORNER_CAR_CENTER, 12); // dc=0 车缘 14.9
    const atHalfMeter =
      CORNER_CAR_CENTER + (BLOCK_CENTER - CORNER_CAR_CENTER) * (0.5 / 3);
    expect(corridorCenterHalfWidth(-411.0)).toBeCloseTo(atHalfMeter, 12); // dc=0.5
    expect(carEdge(-411.0)).toBeLessThanOrEqual(CORNER_BASE_INNER + 1e-9);
    expect(corridorCenterHalfWidth(-408.5)).toBeCloseTo(BLOCK_CENTER, 12); // dc=3 衔接
    expect(carEdge(-408.5)).toBeCloseTo(BLOCK_CAR_EDGE, 12); // 11.003
  });

  it('块心 z=−388.5 仍 10.0（车缘 11.003 < 拱廊柱内缘 11.12）', () => {
    expect(corridorCenterHalfWidth(-388.5)).toBe(BLOCK_CENTER);
    expect(carEdge(-388.5)).toBeCloseTo(BLOCK_CAR_EDGE, 12);
  });

  it('块上角过渡终点 −368.5 仍衔接到 10.0（镜像连续）', () => {
    expect(corridorCenterHalfWidth(-368.5)).toBeCloseTo(BLOCK_CENTER, 12);
    expect(carEdge(-368.5)).toBeCloseTo(BLOCK_CAR_EDGE, 12);
  });

  it('分段重合点未改：−365.5 归城门带 8.997 / −1285.5 归广场 14.497', () => {
    expect(corridorCenterHalfWidth(BOUNDS.gateBackZ)).toBeCloseTo(10.0 - CAR_HALF_W, 12);
    expect(corridorCenterHalfWidth(BOUNDS.plazaZ)).toBeCloseTo(15.5 - CAR_HALF_W, 12);
  });
});

describe('R99 ③ resolveBounds 撞侧墙落在新车心限', () => {
  it('角点 z=−411.5：+X 撞墙 x=13.897、kind=side', () => {
    const r = resolveBounds(20, -411.5, HEADING_TO_PLUS_X, 10);
    expect(r.x).toBeCloseTo(CORNER_CAR_CENTER, 12);
    expect(r.kind).toBe('side');
    expect(r.x + CAR_HALF_W).toBeLessThanOrEqual(CORNER_BASE_INNER + 1e-9);
  });

  it('块心 z=−388.5：撞墙 x 仍 10.0（R97 未回归）', () => {
    const r = resolveBounds(20, -388.5, HEADING_TO_PLUS_X, 10);
    expect(r.x).toBeCloseTo(BLOCK_CENTER, 12);
    expect(r.kind).toBe('side');
  });

  it('−X 镜像撞墙 x=−13.897（put side 镜像对称性）', () => {
    const r = resolveBounds(-20, -411.5, Math.PI / 2, 10);
    expect(r.x).toBeCloseTo(-CORNER_CAR_CENTER, 12);
    expect(r.kind).toBe('side');
  });
});

describe('R99 ④ 未触碰口径逐位不变（CameraRig / r97 / r98 依赖）', () => {
  it('corridorHalfWidth 分段值不变，角点仍是面线 15.5', () => {
    expect(corridorHalfWidth(0)).toBe(12.0);
    expect(corridorHalfWidth(-358.5)).toBe(10.0);
    expect(corridorHalfWidth(-411.5)).toBe(15.5); // 面线未改（我们只改车心限）
    expect(corridorHalfWidth(-388.5)).toBe(10.0);
    expect(corridorHalfWidth(-600)).toBe(15.5);
    expect(corridorHalfWidth(-1290)).toBe(15.5);
  });

  it('其它段车心限不变：桥 10.997 / 门 8.997 / 空档 14.497 / 广场 14.497', () => {
    expect(corridorCenterHalfWidth(0)).toBeCloseTo(12.0 - CAR_HALF_W, 12);
    expect(corridorCenterHalfWidth(-358.5)).toBeCloseTo(10.0 - CAR_HALF_W, 12);
    expect(corridorCenterHalfWidth(-600)).toBeCloseTo(15.5 - CAR_HALF_W, 12);
    expect(corridorCenterHalfWidth(-1290)).toBeCloseTo(15.5 - CAR_HALF_W, 12);
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
});
