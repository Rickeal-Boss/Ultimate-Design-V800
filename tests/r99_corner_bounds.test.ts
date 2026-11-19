/**
 * R99 · 块角不穿可见角塔基座护栏（多边形角穿模修复）。
 *
 * 回归点：R98 只断言 corridorCenterHalfWidth === corridorHalfWidth（面线语义），
 * 没断言「车缘 ≤ 可见实体内缘」，故漏检块角 3m 过渡车缘冲到 16.503、嵌基座 1.603m。
 * R99 把过渡外端点从抽象面线 15.5 改成可见实体「街区角塔大理石基座内缘 14.9」
 * 再扣车半宽 = 13.897：dc=0 车缘恰贴 14.9。
 *
 * R103 阶段二（设计 B）重钉：块心 1D 不再保守钳 10.0（那是柱间/墩间空气墙）。
 *   - 块心段（dc≥3）= **连续墙包络**：殿身（|z−块心| ≤ hallW/2+0.6）贴殿前大理石带内缘
 *     15.0 − 车半宽 = 13.997；其余块心贴建筑前脸 15.5 − 车半宽 = 14.497。
 *   - 块角段（dc<3）从角塔基座 13.897 线性升到 dc=3 处的包络（殿身/前脸），全程无 10.0。
 *   - 柱列 11.12 / 飞扶壁墩 11.35 是周期突出物，已下沉到 2D clampToFootprints（不在此钉）。
 * 块角 3m 过渡终点现在衔接到**包络**（殿身 13.997 / 前脸 14.497），而非旧 10.0；
 * 因包络 ≤ 角塔基座内缘 14.9，块角过渡区「车缘 ≤ 14.9 单调不越界」仍成立。
 *
 * 真源口径：INNER.faceHalf / TOWER.hallW / VEHICLE.widthM 一律 import；1.2 为
 * castleKit.ts:3381 基座裙外扩量（与 R30_CORNER.w 相消后仅剩此项），禁止写死
 * 14.9 / 13.897 / 13.997 / 14.497。
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
import { INNER, TOWER } from '../src/render/scene/r28Layout';

/** 车半宽真源（physics.ts，勿写死） */
const CAR_HALF_W = VEHICLE.widthM / 2; // 1.003
/** 基座裙外扩真源（castleKit.ts:3381 `ctw + 1.2`，与 R30_CORNER.w 相消） */
const MARBLE_SKIRT = 1.2;
/** 可见实体：街区角塔大理石基座内缘 = 15.5 − 1.2/2 = 14.9 */
const CORNER_BASE_INNER = INNER.faceHalf - MARBLE_SKIRT / 2;
/** 角点车心限 = 14.9 − 1.003 = 13.897 */
const CORNER_CAR_CENTER = CORNER_BASE_INNER - CAR_HALF_W;

/* ── R103 阶段二包络真源派生 ── */
/** 殿前大理石带内缘 = faceHalf − 带半宽 0.5 = 15.0（castleKit.ts:3156，与 FreeDrive 同源公式） */
const HALL_MARBLE_INNER = INNER.faceHalf - 0.5;
/** 殿身车心限 = 15.0 − 车半宽 = 13.997（车缘恰贴大理石带） */
const HALL_CAR_CENTER = HALL_MARBLE_INNER - CAR_HALF_W;
/** 建筑前脸车心限 = faceHalf − 车半宽 = 14.497（其余块心包络） */
const FRONT_CAR_CENTER = INNER.faceHalf - CAR_HALF_W;
/** 殿身 |z−块心| 包络 = hallW/2 + 大理石带 z 半外扩 0.6 = 6.85（FreeDrive.CITY_HALL_ZR_EXTENT 同源） */
const HALL_ZR_EXTENT = TOWER.hallW / 2 + 0.6;

/** 块角过渡宽度（FreeDrive.EDGE_TRANSITION = 3，块角→块心包络线性淡出） */
const EDGE_TRANSITION = 3;

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
 * 块心包络真源：|z−块心| ≤ HALL_ZR_EXTENT ⇒ 殿身 13.997；否则前脸 14.497。
 * （块心段 dc≥3 的 1D 限，取代旧 10.0 空气墙。）
 */
function blockEnvelope(z: number): number {
  const [zmin, zmax] = CITY_BLOCK_Z.find(([a, b]) => z >= a && z <= b)!;
  const zc = (zmin + zmax) / 2;
  return Math.abs(z - zc) <= HALL_ZR_EXTENT ? HALL_CAR_CENTER : FRONT_CAR_CENTER;
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
  it('真源派生：基座内缘 14.9 / 角点车心限 13.897 / 殿身 13.997 / 前脸 14.497（非写死）', () => {
    expect(CAR_HALF_W).toBeCloseTo(1.003, 12);
    expect(CORNER_BASE_INNER).toBeCloseTo(14.9, 12);
    expect(CORNER_CAR_CENTER).toBeCloseTo(13.897, 12);
    expect(HALL_MARBLE_INNER).toBeCloseTo(15.0, 12);
    expect(HALL_CAR_CENTER).toBeCloseTo(13.997, 12);
    expect(FRONT_CAR_CENTER).toBeCloseTo(14.497, 12);
  });

  it('全部 10 个街区角点：车心限 13.897、车缘恰贴 14.9（修复前 16.503 嵌 1.603m）', () => {
    expect(PURE_CITY_CORNERS.length).toBe(18); // 20 个端点 − 2 个分段重合点
    for (const z of PURE_CITY_CORNERS) {
      expect(corridorCenterHalfWidth(z)).toBeCloseTo(CORNER_CAR_CENTER, 12);
      expect(carEdge(z)).toBeCloseTo(CORNER_BASE_INNER, 12);
      expect(carEdge(z)).toBeLessThanOrEqual(CORNER_BASE_INNER + 1e-9);
    }
  });

  it('块角过渡区任意 z：dc<3 车缘 ≤ 基座内缘 14.9；dc=3 终点衔接包络（≤ 前脸 15.5）', () => {
    for (const [zmin, zmax] of CITY_BLOCK_Z) {
      for (const edge of [zmin, zmax]) {
        const sign = edge === zmin ? 1 : -1;
        for (let dc = 0; dc <= EDGE_TRANSITION; dc += 0.25) {
          const z = edge + sign * dc;
          if (z === BOUNDS.gateBackZ || z === BOUNDS.plazaZ) continue;
          if (Math.abs(dc - EDGE_TRANSITION) < 1e-9) {
            // 过渡终点（dc=3）现在等于块心包络（殿身 13.997 / 前脸 14.497），而非旧 10.0
            expect(corridorCenterHalfWidth(z)).toBeCloseTo(blockEnvelope(z), 12);
            // 包络 ≤ 建筑前脸 15.5（车缘不越可见面线）
            expect(carEdge(z)).toBeLessThanOrEqual(INNER.faceHalf + 1e-9);
          } else {
            // 过渡区（dc<3）：1D 从角塔基座 13.897 单调升向包络，全程是连续墙包络
            // （≤ 前脸 15.5、≥ 角点 13.897）。基座 14.9 本身由 2D clampToFootprints 兜底，
            // 故 1D 车缘可到 14.9~15.5（贴前脸），不会回到旧 10.0 空气墙。
            expect(carEdge(z)).toBeLessThanOrEqual(INNER.faceHalf + 1e-9); // ≤ 前脸 15.5
            expect(carEdge(z)).toBeGreaterThanOrEqual(CORNER_CAR_CENTER + CAR_HALF_W - 1e-9);
          }
        }
      }
    }
  });
});

describe('R99 ② 折线顶点与块心包络（R103 阶段二设计 B）', () => {
  it('k=0 下角 −411.5：dc=0→13.897 / dc=0.5→线性插值 / dc=3→前脸包络 14.497', () => {
    expect(corridorCenterHalfWidth(-411.5)).toBeCloseTo(CORNER_CAR_CENTER, 12); // dc=0 车缘 14.9
    // dc=0.5：向 dc=3 处的包络线性升（z=−411.0 是 zr=22.5 → 前脸 14.497，非殿身）
    const envAt3 = blockEnvelope(-408.5); // 14.497
    const atHalfMeter =
      CORNER_CAR_CENTER + (envAt3 - CORNER_CAR_CENTER) * (0.5 / EDGE_TRANSITION);
    expect(corridorCenterHalfWidth(-411.0)).toBeCloseTo(atHalfMeter, 12); // dc=0.5
    // 过渡区车缘在基座 14.9 与前脸 15.5 之间单调上升，不越可见面线 15.5
    expect(carEdge(-411.0)).toBeLessThanOrEqual(INNER.faceHalf + 1e-9);
    expect(carEdge(-411.0)).toBeGreaterThanOrEqual(CORNER_BASE_INNER - 1e-9);
    // dc=3 现在衔接**包络**（z=−408.5，zr=20 > 6.85 ⇒ 前脸 14.497），不再是旧 10.0
    expect(corridorCenterHalfWidth(-408.5)).toBeCloseTo(FRONT_CAR_CENTER, 12);
    expect(carEdge(-408.5)).toBeCloseTo(INNER.faceHalf, 12); // 车缘 15.5 贴前脸
    expect(carEdge(-408.5)).toBeLessThanOrEqual(INNER.faceHalf + 1e-9);
  });

  it('块心 z=−388.5 殿身包络 13.997（车缘 15.0 贴殿前大理石带，无 10.0 空气墙）', () => {
    expect(corridorCenterHalfWidth(-388.5)).toBeCloseTo(HALL_CAR_CENTER, 12);
    expect(carEdge(-388.5)).toBeCloseTo(HALL_MARBLE_INNER, 12); // 车缘 15.0
  });

  it('块上角过渡终点 −368.5 衔接到前脸包络 14.497（镜像连续，非旧 10.0）', () => {
    expect(corridorCenterHalfWidth(-368.5)).toBeCloseTo(FRONT_CAR_CENTER, 12);
    expect(carEdge(-368.5)).toBeCloseTo(INNER.faceHalf, 12); // 车缘 15.5 贴前脸
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

  it('块心 z=−388.5：撞墙 x=13.997（殿身包络，R103 阶段二）', () => {
    const r = resolveBounds(20, -388.5, HEADING_TO_PLUS_X, 10);
    expect(r.x).toBeCloseTo(HALL_CAR_CENTER, 12);
    expect(r.kind).toBe('side');
    expect(r.x + CAR_HALF_W).toBeLessThanOrEqual(HALL_MARBLE_INNER + 1e-9); // 车缘 ≤ 15.0
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
