/**
 * R97-F3 · 建筑边界碰撞 / 穿模净空护栏（用户明确诉求，P0）。
 *
 * R96 的 corridorHalfWidth 只钳**车中心** x，从未扣除车半宽（VEHICLE.widthM/2=1.003），
 * 导致拱廊柱 / 飞扶壁外墩 / 主殿台基被车缘嵌入。本文件钉五条硬护栏：
 *   ① arcadeHalfW = 10.0（R96 10.5 → R97 10.0）；
 *   ② 车缘（中心 + 车半宽）≤ 拱廊柱内缘 11.12，留 0.117m 净空；
 *   ③ 飞扶壁外墩内缘 ≥ 车缘（连墙 / 角塔两类，含 hi 档基座包络）；
 *   ④ 主殿台基前沿 ≤ 车鼻 −1299.75（车鼻不嵌入台基，撞击立面 −1300 不动）；
 *   ⑤ corridor 分段采样值（御桥 12 / 城门洞 10 / 块区 10 / 空档 15.5 / 广场 15.5）。
 *
 * 净空判据一律用 physics.ts:24-25 真源 VEHICLE.lengthM / widthM，禁止写死车尺寸。
 * ⚠ 隐私红线：不读 git / 不读本机绝对路径。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { BOUNDS, corridorHalfWidth } from '../src/core/FreeDrive';
import { VEHICLE } from '../src/config/physics';
import { flyingButtress } from '../src/render/scene/castleDetail';
import { makeMainHall, R30_ARCADE, R97_CITY_BUTTRESS } from '../src/render/scene/castleKit';
import { INNER, MAIN_HALL } from '../src/render/scene/r28Layout';

/** 车半宽 / 车半长（physics.ts 真源，勿写死） */
const CAR_HALF_W = VEHICLE.widthM / 2; // 1.003
const CAR_HALF_L = VEHICLE.lengthM / 2; // 2.7475
/** 块区车心钳位后的车缘（最外可达点） */
const CAR_EDGE = BOUNDS.arcadeHalfW + CAR_HALF_W; // 11.003

/**
 * 拱廊柱内缘：castleDetail.corridorRun:1410 `cx = −width + colR + 0.12`，
 * 柱底半宽 colR（pierColumn(colR*2,…)）与 cx 的 +colR 抵消 ⇒ 柱面 = −width+0.12；
 * castleKit:3433 再 translate(−1.0)，世界化 side=+1 加 faceHalf ⇒
 *   内缘 = faceHalf − R30_ARCADE.width − 1.0 + 0.12 = 15.5−3.5−1.0+0.12 = 11.12。
 */
const ARCADE_TRANSLATE = 1.0; // castleKit.ts:3433 街面低拱廊外移量
const COL_CENTER_OFFSET = 0.12; // castleDetail.ts:1410 柱心相对廊宽的外偏
const ARCADE_COL_INNER = INNER.faceHalf - R30_ARCADE.width - ARCADE_TRANSLATE + COL_CENTER_OFFSET; // 11.12

/* castleKit 主殿生成会走 finishArch / 桶构造；沿用 r32_castle_r36 的最小 DOM shim */
const REAL_DOC = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  (globalThis as { document: unknown }).document = REAL_DOC ?? {};
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = REAL_DOC;
});

/** 由真实 flyingButtress 几何量出外墩内缘世界 |x|（主理人要求「务必实测坐标」）。 */
function measuredPierInner(reach: number, pierW: number): number {
  const parts = flyingButtress({
    baseY: 0,
    springY: 9.5,
    topY: 11.9,
    reach,
    depth: 1.0,
    band: 0.55,
    pierW,
    pinnacle: false,
    secondArch: false
  });
  // ① 外墩第一块基座 = ashlar[0]（castleDetail.ts:344），中心局部 x=pierX、宽 pierW+1.1
  const base = parts.ashlar[0];
  expect(base).toBeDefined();
  base!.computeBoundingBox();
  const bb = base!.boundingBox!;
  const localCx = (bb.min.x + bb.max.x) / 2;
  const halfW = (bb.max.x - bb.min.x) / 2;
  // 换算真源（castleDetail.ts:337）：pierX = reach − pierW/2
  expect(localCx).toBeCloseTo(reach - pierW / 2, 5);
  expect(halfW).toBeCloseTo((pierW + 1.1) / 2, 5);
  // 世界化侧镜像把局部 +x 折回路心 ⇒ 世界 |x| = faceHalf − localCx（castleKit.ts:3450）
  return INNER.faceHalf - localCx - halfW;
}

/** 由真实 makeMainHall 几何量出台基（y≤2.2、x 宽>80）的前沿 max z。 */
function measuredPlinthFrontZ(): number {
  const hall = makeMainHall();
  let frontZ = -Infinity;
  for (const g of hall.ashlar) {
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    if (!bb) continue;
    const width = bb.max.x - bb.min.x;
    // 台基两层：frontW+3=91 / frontW+1.4=89.4 宽，y 0..2.2，z ∈ [−1332,−1300]
    if (width > 80 && bb.min.y >= -0.01 && bb.max.y <= 2.21 && bb.max.z < -1290 && bb.min.z > -1340) {
      frontZ = Math.max(frontZ, bb.max.z);
    }
  }
  return frontZ;
}

describe('R97-F3 ① arcadeHalfW 钳位', () => {
  it('arcadeHalfW = 10.0（R96 10.5 收窄，车缘不再嵌柱）', () => {
    expect(BOUNDS.arcadeHalfW).toBe(10.0);
    // 兼容口径保留（旧档引用），不参与新逻辑
    expect(BOUNDS.cityHalfW).toBe(14.5);
  });

  it('车半宽真源 = 1.003，块区车缘 = 11.003', () => {
    expect(CAR_HALF_W).toBeCloseTo(1.003, 6);
    expect(CAR_EDGE).toBeCloseTo(11.003, 6);
  });
});

describe('R97-F3 ② 拱廊柱净空', () => {
  it('拱廊柱内缘 = 11.12 且车缘 11.003 < 内缘（净空 0.117m）', () => {
    expect(ARCADE_COL_INNER).toBeCloseTo(11.12, 6);
    expect(CAR_EDGE).toBeLessThan(ARCADE_COL_INNER);
    expect(ARCADE_COL_INNER - CAR_EDGE).toBeCloseTo(0.117, 6);
  });
});

describe('R97-F3 ③ 飞扶壁外墩净空（真实几何实测）', () => {
  it('连墙飞扶壁外墩内缘 11.35 ≥ 车缘 11.003（hi 档 11.125 亦净空）', () => {
    const { linkReach, linkPierW } = R97_CITY_BUTTRESS;
    expect(linkReach).toBe(3.6);
    expect(linkPierW).toBe(1.4);
    const inner = measuredPierInner(linkReach, linkPierW);
    expect(inner).toBeCloseTo(11.35, 6); // 14.95 − reach
    expect(inner).toBeGreaterThanOrEqual(CAR_EDGE);
    // hi 档基座 pierW+1.55（castleDetail.ts:364）：内缘再退 0.225
    expect(inner - 0.225).toBeCloseTo(11.125, 6);
    expect(inner - 0.225).toBeGreaterThanOrEqual(CAR_EDGE);
  });

  it('街区角塔飞扶壁外墩内缘 11.35 ≥ 车缘 11.003（hi 档 11.125 亦净空）', () => {
    const { cornerReach, cornerPierW } = R97_CITY_BUTTRESS;
    expect(cornerReach).toBe(3.6);
    expect(cornerPierW).toBe(1.3);
    const inner = measuredPierInner(cornerReach, cornerPierW);
    expect(inner).toBeCloseTo(11.35, 6);
    expect(inner).toBeGreaterThanOrEqual(CAR_EDGE);
    expect(inner - 0.225).toBeGreaterThanOrEqual(CAR_EDGE);
  });

  it('reach 只挪顶点不改面数：外推前后 flyingButtress 总 tri 相等（tri/DC 零回归）', () => {
    const triOf = (reach: number, pierW: number): number => {
      const parts = flyingButtress({
        baseY: 0,
        springY: 9.5,
        topY: 11.9,
        reach,
        depth: 1.0,
        band: 0.55,
        pierW,
        pinnacle: false,
        secondArch: false
      });
      return Object.values(parts).reduce((sum, arr) => {
        if (!arr) return sum;
        return (
          sum +
          arr.reduce((n, g) => {
            const idx = g.getIndex();
            return n + (idx ? idx.count : g.getAttribute('position').count) / 3;
          }, 0)
        );
      }, 0);
    };
    // 连墙 / 角塔两类：reach 6.5→3.6、6→3.6 均不改变任何段的顶点数（cl 固定 6 点）
    expect(triOf(3.6, 1.4)).toBe(triOf(6.5, 1.4));
    expect(triOf(3.6, 1.3)).toBe(triOf(6, 1.3));
  });

  it('回归对照：R96 reach 6.5 实测内缘 8.45（犯罪现场，与 probe-bounds 一致）', () => {
    // 用同函数反证旧值确实穿模：8.45 < 11.003（嵌入 2.553m）
    const oldInner = measuredPierInner(6.5, 1.4);
    expect(oldInner).toBeCloseTo(8.45, 6);
    expect(oldInner).toBeLessThan(CAR_EDGE);
    // 主理人原议 5.3 实测内缘仅 9.65 —— 方向对但幅度不足，故取 3.6
    expect(measuredPierInner(5.3, 1.4)).toBeCloseTo(9.65, 6);
  });
});

describe('R97-F3 ④ 主殿台基前沿不嵌车鼻', () => {
  it('台基前沿 = −1300 ≤ 车鼻 −1299.75（撞击立面 −1300 不动）', () => {
    const frontZ = measuredPlinthFrontZ();
    expect(frontZ).toBeCloseTo(MAIN_HALL.z, 4); // −1300
    const carNoseZ = BOUNDS.zMin - CAR_HALF_L; // −1297 − 2.7475 = −1299.7475
    expect(carNoseZ).toBeCloseTo(-1299.7475, 4);
    expect(frontZ).toBeLessThanOrEqual(carNoseZ);
    // 撞击锚点未动
    expect(BOUNDS.zMin).toBe(-1297);
    expect(MAIN_HALL.z).toBe(-1300);
  });
});

describe('R97-F3 ⑤ corridor 分段采样', () => {
  it('御桥 12 / 城门洞 10 / 块区 10 / 空档 15.5 / 广场 15.5', () => {
    expect(corridorHalfWidth(0)).toBe(12.0); // 御桥（z ≥ gateFrontZ）
    expect(corridorHalfWidth(-358.5)).toBe(10.0); // 城门带
    expect(corridorHalfWidth(-388.5)).toBe(10.0); // 块区中心（k=0 块心）
    expect(corridorHalfWidth(-600)).toBe(15.5); // 空档（-641.5..-549.5 无街区）
    expect(corridorHalfWidth(-1290)).toBe(15.5); // 主殿广场
  });

  it('块边界仍是建筑前脸线 15.5（连续过渡，非空气墙）', () => {
    expect(corridorHalfWidth(BOUNDS.plazaZ)).toBe(15.5);
    expect(corridorHalfWidth(BOUNDS.gateBackZ)).toBe(10.0);
    expect(BOUNDS.cityOpenHalfW).toBe(15.5);
    expect(BOUNDS.plazaHalfW).toBe(15.5);
  });
});
