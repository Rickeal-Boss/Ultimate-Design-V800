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
/** 外墩基座外缘 |x| = wx + pairGap/2 + 基座半宽 + 大脚（R122 起 footprint 延展覆盖） */
const OUTER_EDGE = WX + PAIR_GAP / 2 + BASE_HALF_X + HI_EXTRA; // 16.65
const PIER_Z = Z_FRONT + (REACH - PIER_W / 2); // -1294.3
const Z_HALF = (PIER_W + 1.1) / 2; // 1.85

describe('R105 主殿前排飞扶壁内墩 2D 占位', () => {
  it('广场域存在主殿飞扶壁墩对 footprint（真源派生内缘 10.425 / 外缘 16.65 / z -1294.3）', () => {
    const fp = getCityFootprints().find(
      (f) => f.kind === 'buttressBase' && f.zMin > -1297 && f.zMax < -1290
    );
    expect(fp).toBeDefined();
    expect(fp!.xInner).toBeCloseTo(INNER, 6);
    expect(fp!.xInner).toBeLessThan(13.425 + 1e-9); // hi-detail 大脚内缘（保守防 hi 档穿模）
    // R122：xOuter 延展到外墩外缘（覆盖整墩对，外墩不再纯视觉漏占位）
    expect(fp!.xOuter).toBeCloseTo(OUTER_EDGE, 6);
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

  it('R122 外墩车可达 ⇒ footprint 覆盖至外墩外缘（不再漏占位，免 x=14.4 穿 1.55m）', () => {
    const outerPierCenter = WX + PAIR_GAP / 2; // 15.1
    const outerInner = outerPierCenter - BASE_HALF_X - HI_EXTRA; // 13.55
    // 外墩内缘 13.55 < 车右缘上限 15.5 ⇒ 车可达，R105「不可达不占位」判定对 wx=13.5 失效
    expect(outerInner).toBeLessThan(15.5);
    expect(outerInner).toBeGreaterThan(INNER); // 外墩比内墩更靠外
    // 广场域 footprint 仍只 1 条（延展而非新增），xOuter ≥ 外墩外缘（整墩对覆盖）
    const plazaButtress = getCityFootprints().filter(
      (f) => f.kind === 'buttressBase' && f.zMin > -1297 && f.zMax < -1290
    );
    expect(plazaButtress.length).toBe(1);
    expect(plazaButtress[0].xOuter).toBeGreaterThanOrEqual(outerPierCenter + BASE_HALF_X + HI_EXTRA - 1e-9);
  });

  it('R122 probe-B 复现：车在墩对 z 带外墩位（x=14.4）⇒ clamp 接管（原 hit=false 漏占位）', () => {
    // probe-B：x=14.4 z=-1294.3 车 OBB x[13.397,15.403] 与外墩实体 [13.85,16.35] 重叠 1.55m，
    // 原 inner footprint x[10.35,13.15] 覆盖不到（车 OBB 内缘 13.397 > 13.15）⇒ hit=false 穿外墩。
    // R122 xOuter=16.65 延展后：车 OBB 重叠整墩对 ⇒ clamp 接管（远侧推 10.425−dx，车不穿）。
    const hit = clampToFootprints(14.4, PIER_Z, 0);
    expect(hit.hit).toBe(true);
    expect(hit.kind).toBe('buttressBase');
    expect(hit.x).toBeCloseTo(INNER - HALF_W, 6); // 10.425 - 1.003 = 9.422（远侧推，车右缘贴内墩内缘）
    // 车右缘 = hit.x + HALF_W ≤ INNER ⇒ 车 OBB 不再重叠外墩（不穿模）
    expect(hit.x + HALF_W).toBeLessThanOrEqual(INNER + 1e-9);
  });
});
