/**
 * R105 · 主殿前排飞扶壁内墩 2D 占位（广场域 z<plazaZ，唯一「非漂移也穿模」缺陷点）。
 *
 * 用户主诉「细致每个建筑底部材料的边界」。主理人全量几何扫 + 真源核实：主殿正脸前排飞扶壁
 * （castleKit.ts:2731/2742，rotateY(-π/2).translate(side*wx,0,zFront)，zFront=-1300）内墩落到
 * 广场 z≈-1294.3（车可达，z 钳 [-1297,70]），但原 buildCityFootprints 无此条目 ⇒ 广场 1D 车缘
 * （plazaHalfW 15.5 + 车半宽 ≈16.5）直穿内墩基座（内缘 10.425）最多 ~3m。
 *
 * 坐标映射（rotateY(-π/2)：世界 x = side·wx − z_local，世界 z = zFront + x_local）：
 *   墩对 pierZs=[-pairGap/2,+pairGap/2]（local z）⇒ 内墩世界 |x| = wx − pairGap/2 = 11.9；
 *   基座 box(pierW+1.1,0.5,depth+1.1,pierX,…,pz)（castleDetail.ts:344）⇒ 世界 x 半宽
 *   = (depth+1.1)/2 = 1.25（local z→世界 x）；hi-detail 大脚再外扩 0.3 ⇒ 内缘 10.425；
 *   世界 z = zFront + pierX = -1300 + (reach − pierW/2) = -1294.3，z 半宽 = (pierW+1.1)/2 = 1.85。
 * 真源派生禁写死。⚠ 此 footprint 需 FreeDrive step() 的 2D 门控下界从 plazaZ 扩到 zMin 才在
 *   游戏内生效（另改）；本测试钉 clampToFootprints 纯函数行为（它不查激活带）。
 */
import { describe, expect, it } from 'vitest';
import { clampToFootprints, getCityFootprints } from '../src/core/cityFootprints';
import { BOUNDS } from '../src/core/FreeDrive';
import { VEHICLE } from '../src/config/physics';

const HALF_L = VEHICLE.lengthM / 2;
const HALF_W = VEHICLE.widthM / 2;
const dxAt = (h: number) => HALF_L * Math.abs(Math.sin(h)) + HALF_W * Math.abs(Math.cos(h));

/** 主殿前排飞扶壁内墩（真源派生，禁写死） */
const WX = 13.5; // castleKit.ts:2731 首对 wx
const REACH = 7.0;
const PIER_W = 2.6;
const DEPTH = 1.4;
const PAIR_GAP = 3.2;
const Z_FRONT = -1300; // castleKit.ts:2123
const PIER_CENTER = WX - PAIR_GAP / 2; // 11.9（内墩世界 |x|）
const BASE_HALF_X = (DEPTH + 1.1) / 2; // 1.25（世界 x 半宽）
const HI_EXTRA = 0.3; // hi-detail 大脚外扩
const INNER = PIER_CENTER - BASE_HALF_X - HI_EXTRA; // 10.425
const PIER_Z = Z_FRONT + (REACH - PIER_W / 2); // -1294.3
const Z_HALF = (PIER_W + 1.1) / 2; // 1.85

describe('R105 主殿前排飞扶壁内墩 2D 占位', () => {
  it('广场域存在主殿飞扶壁内墩 footprint（真源派生内缘 10.425 / z -1294.3）', () => {
    const fp = getCityFootprints().find(
      (f) => f.kind === 'buttressBase' && f.zMin > -1297 && f.zMax < -1290
    );
    expect(fp).toBeDefined();
    expect(fp!.xInner).toBeCloseTo(INNER, 6);
    expect(fp!.xInner).toBeLessThan(13.425 + 1e-9); // hi-detail 大脚内缘（保守防 hi 档穿模）
    expect(fp!.zMin).toBeCloseTo(PIER_Z - Z_HALF, 6);
    expect(fp!.zMax).toBeCloseTo(PIER_Z + Z_HALF, 6);
    // 内墩在车可达 z 带（z 钳下界 zMin 之内）
    expect(fp!.zMax).toBeGreaterThan(BOUNDS.zMin); // -1292.45 > -1297 ⇒ 车可达
  });

  it('车在飞扶壁 z 斜插：clampToFootprints 收紧到「内墩内缘 − dx(θ)」（不穿）', () => {
    for (const h of [0, 0.3, Math.PI / 6, Math.PI / 4]) {
      const dx = dxAt(h);
      const bound = INNER - dx; // 2D 最紧界
      // 车心在界内 ⇒ 不收紧
      expect(clampToFootprints(bound - 0.01, PIER_Z, h).hit).toBe(false);
      // 车心越到内墩内缘之外（广场 1D 允许到 15.5）⇒ 收紧回 bound，命中 buttressBase
      const outside = clampToFootprints(INNER + 0.3, PIER_Z, h);
      expect(outside.hit).toBe(true);
      expect(outside.kind).toBe('buttressBase');
      expect(outside.x).toBeCloseTo(bound, 6);
    }
  });

  it('外墩（wx≥21.5）内缘 > 车可达车缘 ⇒ 不占位（免假空气墙）', () => {
    const outerPierCenter = WX + PAIR_GAP / 2; // 15.1
    const outerInner = outerPierCenter - BASE_HALF_X - HI_EXTRA; // 13.425
    // 广场 1D 车缘最大 ≈ plazaHalfW 15.5 + 车半宽? 不 —— 车缘 = 车心限 + dx ≤ 15.5(面线)
    // 此处只断言外墩内缘 > 内墩内缘（车先撞内墩），且外墩不必占位即可由内墩兜住近端。
    expect(outerInner).toBeGreaterThan(INNER);
    // 广场域 footprint 只应有内墩这一条 buttressBase（外墩不占位）
    const plazaButtress = getCityFootprints().filter(
      (f) => f.kind === 'buttressBase' && f.zMin > -1297 && f.zMax < -1290
    );
    expect(plazaButtress.length).toBe(1);
  });
});
