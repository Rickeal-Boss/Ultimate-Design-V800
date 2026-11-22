/**
 * R138 · 门楼飞扶壁双墩（御桥段 z>gateFrontZ）2D 占位 + 激活域上界北扩。
 *
 * 背景：门楼飞扶壁（castleKit.ts:1544-1558）双墩立御桥段 z≈−346.35（门楼前脸之前
 * 步道位），外墩 |x|∈[10.2,12.4]。御桥段 1D 限车心 10.997（车缘 12.0 贴桥沿）不挡墩 ⇒
 * 车贴桥沿经过穿外墩最多 1.8m（R125 defer「桥段 2D 红线」）。本测试钉死：
 *  ① buildCityFootprints 含内/外墩两条 buttressBase footprint（几何精确对齐）；
 *  ② GATE_FLY_Z_MAX 导出 = 墩带北界（供 FreeDrive 激活域上界派生）；
 *  ③ clampToFootprints：贴桥沿车（x=10.997, z=墩心）被挡（hit + 目标收进内墩内缘），
 *     门洞中央车（x=0）不 hit（正常通行），墩带外车不 hit。
 *  ④ 门楼飞扶壁墩与既有 gatePier/doorLeaf 不冲突（z 带分离）。
 *
 * ⚠ 纯数值模块断言（cityFootprints 禁 three/DOM），与 r102/r105/r110 同风格。
 */
import { describe, it, expect } from 'vitest';
import {
  buildCityFootprints,
  clampToFootprints,
  getCityFootprints,
  GATE_FLY_Z_MAX
} from '../src/core/cityFootprints';

/** 车半尺寸（physics.ts 真源，勿写死 2.7475/1.003）——与 cityFootprints 同派生 */
const HALF_L = 5.495 / 2; // 2.7475
const HALF_W = 2.006 / 2; // 1.003

/** 门楼飞扶壁几何（与 cityFootprints 常量同派生，禁写死——这里只做交叉验证） */
const GATE_FLY_Z_CENTER = -351.5 + (6 - 1.7 / 2); // −346.35
const GATE_FLY_Z_HALF = (1.7 + 1.1) / 2; // 1.4

describe('R138 门楼飞扶壁双墩 footprint', () => {
  it('① buildCityFootprints 含门楼飞扶壁内/外墩两条 buttressBase（几何精确）', () => {
    const fps = buildCityFootprints();
    // 门楼飞扶壁：z∈[−347.75,−344.95]，内墩 [7.8,10.0] / 外墩 [10.2,12.4]
    const inner = fps.filter(
      (f) =>
        f.kind === 'buttressBase' &&
        Math.abs(f.zMin - (GATE_FLY_Z_CENTER - GATE_FLY_Z_HALF)) < 1e-6 &&
        Math.abs(f.zMax - (GATE_FLY_Z_CENTER + GATE_FLY_Z_HALF)) < 1e-6 &&
        Math.abs(f.xInner - 7.8) < 1e-6 &&
        Math.abs(f.xOuter - 10.0) < 1e-6
    );
    const outer = fps.filter(
      (f) =>
        f.kind === 'buttressBase' &&
        Math.abs(f.zMin - (GATE_FLY_Z_CENTER - GATE_FLY_Z_HALF)) < 1e-6 &&
        Math.abs(f.zMax - (GATE_FLY_Z_CENTER + GATE_FLY_Z_HALF)) < 1e-6 &&
        Math.abs(f.xInner - 10.2) < 1e-6 &&
        Math.abs(f.xOuter - 12.4) < 1e-6
    );
    expect(inner.length).toBe(1);
    expect(outer.length).toBe(1);
  });

  it('② GATE_FLY_Z_MAX 导出 = 墩带北界（供 FreeDrive 激活域上界派生）', () => {
    expect(GATE_FLY_Z_MAX).toBeCloseTo(-344.95, 6);
    // 墩带北界 > 门墩塔基北界（−350.9）⇒ 激活域上界由墩带主导
    expect(GATE_FLY_Z_MAX).toBeGreaterThan(-350.9);
  });

  it('③a clampToFootprints：贴桥沿车（x=10.997, z=墩心）被门楼飞扶壁墩挡住', () => {
    const fp = clampToFootprints(10.997, GATE_FLY_Z_CENTER, 0);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('buttressBase');
    // 目标收进内墩内缘（车缘 7.8 贴内墩内缘）：x 目标 ≈ 7.8 − 车半宽
    expect(fp.x).toBeCloseTo(7.8 - HALF_W, 3);
    // 真实 SAT 穿透（车 OBB x 与命中盒公共长度）≥ 0（车已嵌墩带）
    expect(fp.xPen).toBeGreaterThan(0);
  });

  it('③b clampToFootprints：门洞中央车（x=0, z=墩心）不受影响（正常通行）', () => {
    const fp = clampToFootprints(0, GATE_FLY_Z_CENTER, 0);
    expect(fp.hit).toBe(false);
    expect(fp.x).toBeCloseTo(0, 6);
  });

  it('③c clampToFootprints：墩带外（z=−335，北侧）车不受影响', () => {
    const fp = clampToFootprints(10.997, -335, 0);
    expect(fp.hit).toBe(false);
  });

  it('④ 门楼飞扶壁墩与 gatePier/doorLeaf z 带分离（不冲突）', () => {
    const fps = getCityFootprints();
    const gateFly = fps.filter(
      (f) =>
        f.kind === 'buttressBase' &&
        Math.abs(f.zMin - (GATE_FLY_Z_CENTER - GATE_FLY_Z_HALF)) < 1e-6
    );
    // 门楼飞扶壁 z 带 [−347.75,−344.95]；gatePier 塔基 [−366.1,−350.9]；doorLeaf [−359.72,−351.28]
    // 全部 z 分离（飞扶壁在北，门带在南），同一车不会同时命中
    for (const gf of gateFly) {
      for (const f of fps) {
        if (f === gf) continue;
        if (f.kind === 'gatePier' || f.kind === 'doorLeaf') {
          // z 带分离：飞扶壁 zMin > 其它 zMax 或 zMax < 其它 zMin
          const sep = gf.zMin > f.zMax || gf.zMax < f.zMin;
          expect(sep).toBe(true);
        }
      }
    }
  });

  it('⑤ 车体 OBB 与门楼飞扶壁墩的真实穿透上限 = 贴桥沿场景（x=10.997 穿外墩 1.8m）', () => {
    // 车贴桥沿 x=10.997，车体 x∈[9.994,12.0]；外墩 [10.2,12.4]
    const overlap = Math.min(12.0, 12.4) - Math.max(10.997 - HALF_W, 10.2);
    expect(overlap).toBeCloseTo(1.8, 3);
    // 车体无法嵌入 0.2m 缝隙（内/外墩间 [10.0,10.2]），双墩必有一命中
    expect(HALF_W * 2).toBeGreaterThan(0.2);
  });

  it('⑥ 门带入口窗口北半（z≥−350.4975）：车 OBB 跨御桥段门楼飞扶壁墩带+门洞门扇带，最紧界=内墩', () => {
    // 车心 x=9.6, z=−350（窗口北半）：车 OBB z∈[−352.75,−347.25] 与门楼飞扶壁墩带
    // [−347.75,−344.95] 重叠（车尾穿内墩）+ 门洞门扇带（车头穿门扇）。最紧界 = 内墩
    // （xInner 7.8 < 门扇 9.0 < 门墩 10）。r119 该窗口南半测 doorLeaf，北半由本测试接管。
    const fp = clampToFootprints(9.6, -350, 0);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('buttressBase');
    const edge = Math.abs(fp.x) + HALF_W;
    expect(edge).toBeLessThanOrEqual(10 + 1e-9); // 车缘 ≤ 门墩内缘 10（更紧，不穿门墩）
    // 门楼飞扶壁内墩接管后目标 = 内墩内缘 7.8 − 车半宽
    expect(fp.x).toBeCloseTo(7.8 - HALF_W, 3);
  });
});
