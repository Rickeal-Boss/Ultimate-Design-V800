/**
 * R102 · 柱位邻域 1D 跳变 vs R101 scrub ε 出缝 —— R103 阶段二（设计 B）**整体 pivot** 版。
 *
 * 【旧 premise 已消失】本文件旧版钉的是「柱间墙车心限 = 10.000、柱位邻域车心限 = 10.117，
 * 在 |z−z_pillar|=1.303 处跳变 0.117 > WALL_SCRUB_CONTACT_EPS(0.05) ⇒ 0.067 m scrub 出缝」。
 * 设计 B（「看不见空隙不挡」）把拱廊柱列（内缘 11.12 / 节距 8.8）从 1D **完全移除**、下沉到
 * 2D clampToFootprints；块心 1D 改为「连续墙包络」：殿身（|z−块心|≤6.85）→ 13.997、其余块心
 * → 14.497（前脸 15.5 − 车半宽 1.003）。因此：
 *   - 1D 对柱位**不再收窄**，柱间/柱位的 10.0 / 10.117 / 0.117 跳变 / 0.067 出缝**全部消失**；
 *   - 柱不穿模改由 2D clampToFootprints 按车 OBB 是否**真相交**来钳（SAT，只收紧不放宽、无瞬移）。
 *
 * 【新不变量】本文件改钉设计 B 下的真实几何：
 *   ① 块心**真空隙**（柱与柱之间）1D 限 = 前脸包络 14.497（不再是 10.0 空气墙）；
 *   ② 柱位 z 的 1D 限同样是包络（无 10.117 窄带），即 1D 对柱位不收窄；
 *   ③ 柱不穿模由 2D 断言：车在柱位 z 斜插，clampToFootprints 收紧到「柱内缘 11.12 − dx(θ)」；
 *   ④ 旧 0.067 scrub 出缝已随柱位移除 1D 而消失——1D 块心段连续、无柱位周期跳变。
 *
 * 真源口径：VEHICLE / INNER / TOWER / R30_ARCADE / BOUNDS 一律 import 派生；柱内缘与柱位 z
 * 直接从 cityFootprints.getCityFootprints() 的 arcadeCol 占位读，禁写死 10.117 / 11.12 / 8.8。
 * 隐私红线：不读 git / 不读本机绝对路径。
 */
import { describe, expect, it } from 'vitest';
import {
  BOUNDS,
  WALL_SCRUB_CONTACT_EPS,
  WALL_SCRUB_RELEASE_EPS,
  corridorCenterHalfWidth,
  CITY_BLOCK_Z
} from '../src/core/FreeDrive';
import { clampToFootprints, getCityFootprints } from '../src/core/cityFootprints';
import { VEHICLE } from '../src/config/physics';
import { INNER, TOWER } from '../src/render/scene/r28Layout';
import { R30_ARCADE } from '../src/render/scene/castleKit';

/** 车半宽 / 半长（physics.ts 真源，勿写死） */
const CAR_HALF = VEHICLE.widthM / 2; // 1.003
const CAR_HALF_L = VEHICLE.lengthM / 2; // 2.75
/** 殿身车心限 = 大理石带内缘(15.0) − 车半宽 = 13.997（真源派生） */
const HALL_CC = INNER.faceHalf - 0.5 - CAR_HALF;
/** 前脸车心限 = 前脸线(15.5) − 车半宽 = 14.497（真源派生） */
const FRONT_CC = BOUNDS.cityOpenHalfW - CAR_HALF;
/** 殿身 |z−块心| 包络 = hallW/2 + 0.6（与 FreeDrive 同源派生） */
const HALL_ZR = TOWER.hallW / 2 + 0.6; // 6.85
/** 柱 z 节距（真源） */
const PILLAR_PITCH = R30_ARCADE.pitch; // 8.8

/** 取 k0 块做场景 fixture（与 FreeDrive.CITY_BLOCK_Z 严格一致） */
const BLOCK_K0 = CITY_BLOCK_Z[0];
const ZC = (BLOCK_K0[0] + BLOCK_K0[1]) / 2; // −388.5

/** 从 2D 占位真源读 k0 块心附近的拱廊柱（+X 侧，xInner>0）：柱内缘 + 柱位 z 列表 */
function arcadeColsNearBlockCenter(): { inner: number; z: number }[] {
  return getCityFootprints()
    .filter(f => f.kind === 'arcadeCol' && f.xInner > 0)
    .map(f => ({ inner: f.xInner, z: (f.zMin + f.zMax) / 2 }))
    .filter(c => Math.abs(c.z - ZC) < 2 * PILLAR_PITCH) // 块心 ±2 节距内的柱
    .sort((a, b) => a.z - b.z);
}
const COLS = arcadeColsNearBlockCenter();
/** 柱内缘（真源，11.12） */
const PILLAR_INNER = COLS[0].inner;
/** 柱间真空隙 z：相邻柱位中点（块心外第 0、1 柱之间） */
const GAP_Z = (COLS.find(c => c.z > ZC)!.z + COLS.find(c => c.z > ZC + PILLAR_PITCH)!.z) / 2;

describe('R102 ① 设计 B：块心真空隙 1D 开放到前脸包络（空气墙已移除）', () => {
  it('柱间真空隙 z 的 1D 限 = 前脸包络 14.497，不再是 10.0 空气墙', () => {
    expect(COLS.length).toBeGreaterThanOrEqual(2); // fixture 有相邻柱可取中点
    const hw = corridorCenterHalfWidth(GAP_Z);
    expect(hw).toBeCloseTo(FRONT_CC, 6); // 开放到前脸 14.497
    expect(hw).toBeGreaterThan(BOUNDS.arcadeHalfW + 1.0); // 远离旧空气墙 10.0（差 >1 m）
    // 真空隙处 1D 限 ≥ 前脸包络，车可合法停在柱与前脸之间的空隙
    expect(hw).toBeCloseTo(BOUNDS.cityOpenHalfW - CAR_HALF, 6);
  });
});

describe('R102 ② 设计 B：柱位 z 的 1D 不再收窄（无 10.117 窄带）', () => {
  it('柱位 z 的 1D 限 = 包络（殿身段 13.997 / 前脸段 14.497），绝无 10.117 / 10.0 窄带', () => {
    expect(PILLAR_INNER).toBeCloseTo(11.12, 6); // 柱内缘真源（castleKit R30_ARCADE 同源）
    for (const col of COLS) {
      const hw = corridorCenterHalfWidth(col.z);
      const zr = Math.abs(col.z - ZC);
      // 柱位 1D 限就是该 z 的连续墙包络（殿身 / 前脸），与柱是否存在无关
      expect(hw).toBeCloseTo(zr <= HALL_ZR ? HALL_CC : FRONT_CC, 6);
      // 不再收窄到柱位车心限 10.117，也不是旧空气墙 10.0
      expect(Math.abs(hw - (PILLAR_INNER - CAR_HALF))).toBeGreaterThan(1.0); // ≠ 10.117
      expect(Math.abs(hw - BOUNDS.arcadeHalfW)).toBeGreaterThan(1.0); // ≠ 10.0
    }
  });
});

describe('R102 ③ 柱不穿模改由 2D 断言：clampToFootprints 收紧到「柱内缘 − dx(θ)」', () => {
  it('车在柱位 z 斜插：1D 放到包络(13.997)不挡，2D clampToFootprints 按 OBB 收到 11.12−dx(θ)', () => {
    const pillarZ = COLS.find(c => c.z > ZC)!.z; // 取块心外第 0 柱
    // 1D 在柱位不挡（放到包络），单靠 1D 会穿柱 ⇒ 必须 2D 兜底
    expect(corridorCenterHalfWidth(pillarZ)).toBeGreaterThan(PILLAR_INNER);

    for (const h of [0, 0.3, Math.PI / 6, Math.PI / 4]) {
      // dx(θ) = 半长·|sinθ| + 半宽·|cosθ|：车 OBB 4 角点相对车心的 x 最大伸展（cityFootprints 同源）
      const dx = CAR_HALF_L * Math.abs(Math.sin(h)) + CAR_HALF * Math.abs(Math.cos(h));
      const bound = PILLAR_INNER - dx; // 2D 最紧界
      // 车心放在界内 ⇒ 不收紧（hit=false）
      const inside = clampToFootprints(bound - 0.01, pillarZ, h);
      expect(inside.hit).toBe(false);
      // 车心越到柱内缘之外 ⇒ OBB 与柱 AABB（R104 收紧到 colAabbHalf=0.4）真相交 ⇒ 收紧回 bound
      // （旧 +0.5 偏移是按旧 0.9 宽柱校准的，收紧后斜插 h 的 SAT 会判不交，故改用车心过内缘 11.12）
      const outside = clampToFootprints(PILLAR_INNER + 0.3, pillarZ, h);
      expect(outside.hit).toBe(true);
      expect(outside.kind).toBe('arcadeCol');
      expect(outside.x).toBeCloseTo(bound, 6);
    }
  });
});

describe('R102 ④ 旧 0.067 scrub 出缝已随柱位移除 1D 而消失（新不变量：1D 块心连续、无柱位周期跳变）', () => {
  it('块心段 1D 限连续，无 10.0/10.117、无 0.117 跳变 ⇒ 0.067 出缝前提不复存在', () => {
    // 旧缺陷：柱间 10.000 → 柱位 10.117 跳变 0.117 > ε(0.05) ⇒ 0.067 缺口
    // 设计 B：柱位移除 1D ⇒ 块心 1D 只剩殿身↔前脸 0.5 跳变（< RELEASE_EPS 1.2），无柱位周期跳变
    const jump = FRONT_CC - HALL_CC; // 0.5，块内唯一跳变
    expect(jump).toBeCloseTo(0.5, 6);
    expect(jump).toBeLessThan(WALL_SCRUB_RELEASE_EPS); // < 1.2，release band 天然覆盖

    // 沿整块扫描：1D 限只取 HALL_CC / FRONT_CC（及块角 ramp），无任何落在 10.0~10.117 的窄带，
    // 也无以节距 8.8 为周期的柱位凹陷 ⇒ scrub 不可能在柱位出缝。
    const [zmin, zmax] = BLOCK_K0;
    for (let dz = 3; dz <= 20; dz += 0.25) {
      for (const z of [zmin + dz, zmax - dz]) {
        const hw = corridorCenterHalfWidth(z);
        expect(Math.min(Math.abs(hw - HALL_CC), Math.abs(hw - FRONT_CC))).toBeLessThan(1e-6);
      }
    }
    // 柱位与相邻柱间真空隙的 1D 限差：不再是 0.117，而是「殿身/前脸包络的自然差（0 或 0.5）」
    const gapHw = corridorCenterHalfWidth(GAP_Z);
    const pillarHw = corridorCenterHalfWidth(COLS.find(c => c.z > ZC)!.z);
    const diff = Math.abs(gapHw - pillarHw);
    expect(diff === 0 || Math.abs(diff - 0.5) < 1e-6).toBe(true); // 只可能是 0 或殿身↔前脸 0.5
    expect(Math.abs(diff - 0.117)).toBeGreaterThan(0.1); // 旧 0.117 跳变不存在
    // 旧 0.067 出缝 = 柱位跳变 0.117 − ε 0.05；现无 0.117 跳变 ⇒ 出缝前提消失
    expect(Math.abs(diff - (0.117 - WALL_SCRUB_CONTACT_EPS))).toBeGreaterThan(0.1);
  });
});
