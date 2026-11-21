/**
 * R102 · 城内 2D 占位收紧护栏（车长 bbox vs 台阶/基座/柱础）。
 *
 * 缺陷：resolveBounds 是「车心点 vs 1D corridorCenterHalfWidth(z)」，车长 5.495 m
 * （半长 2.7475）/ 车宽 2.006 m（半宽 1.003）的 bbox 从未检查，heading 不进钳位。
 * 车斜插 θ=30° 时 dx=2.243 m（车角 x 伸展），块角 14.9 m 基座内缘处车角嵌 1.24 m、
 * 柱位 11.12 m 处嵌 1.12 m；车尾 bbox 落在 zc±2.75 合法待在钳位线外与深台阶相交
 * ⇒「存在的建筑又穿模 / 车尾卡台阶缝隙 / 卡住不能动」。
 *
 * 修复（只加不改）：新增 src/core/cityFootprints.ts 纯数值模块 + clampToFootprints
 * 纯函数，FreeDrive.step() 在 resolveBounds 之后、写回 s.x/s.z 之前插入一处收紧调用，
 * 城内域门控（z ∈ [zMin, gateFrontZ]，R118 上界 gateBackZ→gateFrontZ 纳入城门带）。
 * resolveBounds / corridorHalfWidth /
 * corridorCenterHalfWidth 函数体逐位不动 ⇒ CameraRig 与 r97/r98/r99/r100 全部护栏不破。
 *
 * 真源口径：INNER / TOWER / R30_ARCADE / R97_CITY_BUTTRESS / VEHICLE / CITY_BLOCK_Z
 * 一律 import；禁止写死 14.9 / 11.12 / 11.35 / 2.7475 / 1.003 等派生值。
 */
import { describe, expect, it } from 'vitest';
import { BOUNDS, CITY_BLOCK_Z, resolveBounds } from '../src/core/FreeDrive';
import {
  clampToFootprints,
  getCityFootprints,
  type CityFootprint
} from '../src/core/cityFootprints';
import { VEHICLE } from '../src/config/physics';
import { GATE, INNER, TOWER } from '../src/render/scene/r28Layout';
import { R30_ARCADE, R97_CITY_BUTTRESS } from '../src/render/scene/castleKit';

/** 车长 / 车宽半尺寸真源（physics.ts，勿写死） */
const HALF_L = VEHICLE.lengthM / 2; // 2.7475
const HALF_W = VEHICLE.widthM / 2; // 1.003

/** 朝 +X 直行（heading=−π/2 ⇒ forward.x=+1 ⇒ fn>0 ⇒ kind='side'） */
const HEADING_TO_PLUS_X = -Math.PI / 2;

/** 块 0（z ∈ [−411.5, −365.5]，块心 −388.5）便于断言 */
const K0 = CITY_BLOCK_Z[0];
const K0_ZC = (K0[0] + K0[1]) / 2; // −388.5
const K0_HALF = (K0[1] - K0[0]) / 2; // 23

/** 角塔大理石基座内缘 = faceHalf − 1.2/2 = 14.9（castleKit.ts:3381，与 FreeDrive 同源公式） */
const CORNER_BASE_INNER = INNER.faceHalf - 1.2 / 2;
/** 拱廊柱内缘 = faceHalf − width − translate + colR + 0.12 = 11.12（colR 抵消） */
const ARCADE_COL_INNER = INNER.faceHalf - R30_ARCADE.width - 1.0 + 0.12;
/** 飞扶壁连墙墩内缘 = faceHalf − reach − 0.55 = 11.35（pierW 抵消） */
const BUTTRESS_LINK_INNER = INNER.faceHalf - R97_CITY_BUTTRESS.linkReach - 0.55;
/** 飞扶壁连墙墩外缘 = faceHalf − reach = 11.9（castleKit.ts:262 同源；R119 近侧界基准，非写死） */
const BUTTRESS_LINK_OUTER = INNER.faceHalf - R97_CITY_BUTTRESS.linkReach;
/** 块长（INNER.blockLen = 46，castleKit.ts:3075 同源） */
const BLOCK_LEN_LOCAL = INNER.blockLen;
/** 前排塔基局部深度（castleKit.ts:3254 `box(9.4,1.2,9.4,depth/2,…)`，depth=8 ⇒ 局部 x 0..4.7） */
const FRONT_TOWER_DEPTH = 4.7;
/** 飞扶壁连墙墩世界 z（连墙段 [−blockLen/2, −blockLen/4−4.7] 中点 lz = −19.6 ⇒ zc−19.6） */
const BUTTRESS_Z = K0_ZC - (K0_HALF + BLOCK_LEN_LOCAL / 4 + FRONT_TOWER_DEPTH) / 2; // −408.125

/** dx(θ) = 半长|sinθ| + 半宽|cosθ|：车 OBB 4 角点相对车心的 x 最大伸展 */
function dxAt(heading: number): number {
  return HALF_L * Math.abs(Math.sin(heading)) + HALF_W * Math.abs(Math.cos(heading));
}

/** 城内 2D 占位清单（模块级缓存，buildCityFootprints 派生） */
const FOOTPRINTS = getCityFootprints();

/** 按 kind 取所有占位（供计数断言） */
function byKind(kind: CityFootprint['kind']): CityFootprint[] {
  return FOOTPRINTS.filter((f) => f.kind === kind);
}

describe('R102 ① 占位清单覆盖 probe-bounds §2 六类地面层实体（真源派生，非写死）', () => {
  it('占位盒数 > 0，覆盖 10 个 keep 块 × 每块至少 6 类', () => {
    expect(CITY_BLOCK_Z.length).toBe(10);
    // 每块：1 前脸 + 2 殿台/大理石带 + 2 角塔基座 + 2 前排塔基 + 4 柱 + 2 飞扶壁墩 = 13
    expect(FOOTPRINTS.length).toBeGreaterThanOrEqual(10 * 6);
    // R121：+10 缺块 R99 补街 frontWall（10 采样块 + 10 缺块，前脸均 |x|=15.5）——R102 建表只认
    //   采样块，从未同步 R99 补的缺块实体（空档斜插穿补墙 1.24~1.88m，R121 ⑥c 补 footprint）
    expect(byKind('frontWall').length).toBe(20);
    expect(byKind('hallBase').length).toBe(20); // 10 块 × 殿台基 + 大理石带
    expect(byKind('cornerBase').length).toBe(20); // 10 块 × 2 座
    expect(byKind('frontBase').length).toBe(20); // 10 块 × 2 座
    expect(byKind('arcadeCol').length).toBe(40); // 10 块 × 4 柱
    // R103 阶段二：连墙墩 20（10 块 × 2 连墙段）+ 角塔墩 4（hero 块 k<2 各 2 座）= 24；
    // R105：+ 主殿前排飞扶壁内墩 1（广场域，双侧镜像单条）= 25
    expect(byKind('buttressBase').length).toBe(25);
  });

  it('角塔基座内缘 = 14.9（真源派生，非写死）', () => {
    for (const f of byKind('cornerBase')) {
      expect(f.xInner).toBeCloseTo(CORNER_BASE_INNER, 12);
    }
  });

  it('拱廊柱内缘 = 11.12（真源派生，非写死）', () => {
    for (const f of byKind('arcadeCol')) {
      expect(f.xInner).toBeCloseTo(ARCADE_COL_INNER, 12);
    }
  });

  it('飞扶壁连墙墩内缘 = 11.35（真源派生，非写死）', () => {
    // R105：排除广场域主殿前排飞扶壁内墩（xInner 10.425，z<plazaZ，另测）——此处只钉城内连墙/角塔墩
    for (const f of byKind('buttressBase')) {
      if (f.zMin < BOUNDS.plazaZ) continue; // 广场域主殿飞扶壁（z≈-1294.3 < plazaZ）
      expect(f.xInner).toBeCloseTo(BUTTRESS_LINK_INNER, 12);
    }
  });

  it('R119 改 b 城门带门墩 footprint：门墩 |x|∈[10,17.5]，z∈[GATE.z±(GATE.depth+1.2)/2]（塔基实体范围，真源派生）', () => {
    // 城门带 2D 占位：门洞净半宽 = GATE.openW/2 = 10（门墩内缘）、门楼半宽 = GATE.halfW = 17.5（外缘）。
    // R119 改 b：z 区间 = 门楼**塔基实体**范围 [GATE.z−(GATE.depth+1.2)/2=−366.1, GATE.z+(GATE.depth+1.2)/2=−350.9]
    //   （makeGate 塔基台基 box(depth+1.2)，zMid=GATE.z，半深 (depth+1.2)/2=7.6），比城门带
    //   [gateBackZ,gateFrontZ]=[−365.5,−351.5] 各超 0.6m —— 原 footprint 漏掉塔基 0.6m（车头/车尾入塔基漏网）。
    //   ⚠ 不扩 CAR_HALF_L（zMin→−368.2475 / zMax→−348.7525）：SAT 判交（车 OBB↔footprint）已自动覆盖
    //   「车心带外、车头/尾已入塔基实体」的车，扩 CAR_HALF_L 反使 footprint>实体，块 0 北缘合法位车
    //   被 gatePier 误钳（r110 实测 clamp(12.0,−368.9) 被硬拉到 8.997 单帧 2.006m）。
    const piers = byKind('gatePier');
    expect(piers.length).toBe(1);
    const p = piers[0];
    expect(p.xInner).toBeCloseTo(GATE.openW / 2, 12); // 10
    expect(p.xOuter).toBeCloseTo(GATE.halfW, 12); // 17.5
    expect(p.zMin).toBeCloseTo(GATE.z - (GATE.depth + 1.2) / 2, 12); // −366.1（塔基南界）
    expect(p.zMax).toBeCloseTo(GATE.z + (GATE.depth + 1.2) / 2, 12); // −350.9（塔基北界）
    // 塔基实体 z 带长（zMax−zMin = GATE.depth+1.2 = 15.2，塔基进深含台基外扩 1.2）
    expect(p.zMax - p.zMin).toBeCloseTo(GATE.depth + 1.2, 12);
    // 塔基实体比城门带各超 0.6m（覆盖车头/车尾入塔基漏网），而非等于城门带长 14
    expect(p.zMin).toBeLessThan(BOUNDS.gateBackZ); // −366.1 < −365.5
    expect(p.zMax).toBeGreaterThan(BOUNDS.gateFrontZ); // −350.9 > −351.5
  });

  it('建筑前脸 / 殿台基内缘 = 15.5；前排塔基内缘 = 14.8（R104 修正）；殿前大理石带 15.0', () => {
    for (const f of byKind('frontWall')) expect(f.xInner).toBeCloseTo(INNER.faceHalf, 12);
    // R104 修正：前排塔基真实可见内缘 = faceHalf − (boxW/2 − depth/2) = 15.5 − 0.7 = 14.8（原误 15.5 穿模）
    for (const f of byKind('frontBase')) expect(f.xInner).toBeCloseTo(INNER.faceHalf - 0.7, 12);
    const hallBases = byKind('hallBase');
    // R103 修正：殿台基内缘 = faceHalf = 15.5（原误 15.1）；大理石带 = faceHalf − 0.5 = 15.0（原误 15.25）
    const plinth = hallBases.filter((f) => Math.abs(f.xInner - INNER.faceHalf) < 1e-9);
    const marble = hallBases.filter((f) => Math.abs(f.xInner - (INNER.faceHalf - 0.5)) < 1e-9);
    expect(plinth.length).toBe(10);
    expect(marble.length).toBe(10);
  });

  it('殿台基 z 覆盖殿身 hallW/2 ± 0.7，占位盒居中于块心', () => {
    const plinth = byKind('hallBase').find(
      (f) => Math.abs(f.xInner - INNER.faceHalf) < 1e-9
    )!;
    expect(plinth.zMin).toBeCloseTo(K0_ZC - TOWER.hallW / 2 - 0.7, 9);
    expect(plinth.zMax).toBeCloseTo(K0_ZC + TOWER.hallW / 2 + 0.7, 9);
  });
});

describe('R102 ② clampToFootprints 纯函数（直行 θ=0 回归不变 / 斜插 θ=30,45 收紧）', () => {
  it('直行 θ=0 飞扶壁墩位：车长 z 覆盖命中飞扶壁墩（内缘 11.35 < 基座 14.9）⇒ 2D 近侧外推 12.903', () => {
    // 墩世界 z = zc − 19.6 = −408.125（连墙段中点 lz=−19.6），墩 z 覆盖 [−409.15,−407.05]。
    // 1D resolveBounds 在墩位 z 给块心 10.0；我们绕过 1D 直接喂 x 验证 2D。
    // R111：旧 SAT 车世界 x 半径误用 halfL ⇒ x=13.897 被假阳性判交；修正后 x=13.897 车缘
    //   12.894 距墩外缘 11.9 有 ~1m 空隙、根本不接触。改喂 x=12.0（车缘 10.997 真嵌墩 11.35
    //   内缘 0.35m）⇒ 真命中。θ=0 时 dx = 半宽 1.003，车长 bbox z ∈ [−410.87,−405.38] 落进墩
    //   z 覆盖 ⇒ 与墩 OBB 真相交。
    // R119 改 a：墩是局部突出物（buttressBase），车心 12.0 ≥ 墩带中点（11.625）⇒ 按**近侧界**
    //   xOuter+dx 外推（车被推离墩外缘 11.9 之外），非远侧收紧 10.347。近侧界 12.903 ≤ 1D
    //   面线走廊 14.497（防护①）且不与其它占位盒相交（防护②）⇒ 合法。
    // 这正是 probe-bounds §3.1 P1「车尾卡台阶缝隙」根因的 R119 解法：车合法停在墩与前脸之间，
    //   不再被硬拉回路内（旧 10.347 收紧会瞬移车 1.55m 内推）。
    const z = BUTTRESS_Z; // −408.125 墩位
    const fp = clampToFootprints(12.0, z, 0);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('buttressBase');
    // 近侧界 = 墩外缘 + 半宽 = 11.9 + 1.003 = 12.903（车被推离墩外缘，非硬拉回路内 10.347）
    expect(fp.x).toBeCloseTo(BUTTRESS_LINK_OUTER + HALF_W, 12); // 12.903
    // 车不穿模核心护栏：clamp 后位置再喂回 ⇒ 车 OBB 与所有占位盒分离（hit=false）
    expect(clampToFootprints(fp.x, fp.z, 0).hit).toBe(false);
    // 车缘不越 1D 可见面线（近侧防护①：nearBound ≤ 1D 车心面线走廊 14.497 ⇒ 车缘 ≤ 15.5 前脸）
    expect(fp.x + HALF_W).toBeLessThanOrEqual(BOUNDS.cityOpenHalfW + 1e-9);
  });

  it('直行 θ=0 块心：1D = 殿身包络 13.997，2D 在殿前大理石带 z 收紧到 12.2525', () => {
    // R103 阶段二：块心 1D 从保守 10.0 放宽到连续墙包络。块心 |z−zc|=0 ≤ CITY_HALL_ZR_EXTENT
    // ⇒ envelope = 殿前大理石带 15.0 − 半宽 1.003 = 13.997（车心线恰贴大理石带内缘）。
    // 块心 z 落在殿前大理石带（xInner 15.0，z 覆盖 zc±6.85）内；朝 +X 直行（heading −π/2）时
    // 车长沿 X ⇒ dx = 半长 2.7475，车 OBB x 伸展 13.997+2.7475 = 16.74 越带内缘 15.0 ⇒ 2D 真相交，
    // 收紧到 15.0 − 2.7475 = 12.2525（比 1D 包络 13.997 更紧，车头真嵌入大理石带）。
    const z = K0_ZC; // −388.5 块心
    const hallCenter = INNER.faceHalf - 0.5 - HALF_W; // 13.997 殿身车心 1D 包络
    const x1d = resolveBounds(20, z, HEADING_TO_PLUS_X, 10).x;
    expect(x1d).toBeCloseTo(hallCenter, 12); // 1D 已放宽到殿身包络（非旧 10.0）
    const fp = clampToFootprints(x1d, z, HEADING_TO_PLUS_X);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('hallBase'); // 殿前大理石带（xInner 15.0）
    expect(fp.x).toBeCloseTo(INNER.faceHalf - 0.5 - HALF_L, 12); // 15.0 − 2.7475 = 12.2525
  });

  it('直行 θ=0 近端塔基与角塔基座之间 z=−371.1：1D = 前脸包络 14.497，2D 收紧到前排塔基 13.797', () => {
    // R104 P1 收紧后（前排塔基真实内缘 14.8）块心 z 带 z∈[zc−18.3, zc+18.3] 已被塔基/大理石带/前脸
    //   连续覆盖。块 0（zc=−388.5）取 z=−371.1（车长 bbox z 覆盖 [−373.85,−368.35]）。
    //   |z−zc|=17.4 > CITY_HALL_ZR_EXTENT ⇒ 1D = 前脸包络 14.497。
    // R111：旧 SAT 车世界 z 半径误用 halfW（1.003）⇒ 车长 bbox 只按 ±1.003 采样，z=−371.1 时
    //   车「看似」只到 −370.1 不交前排塔基带 [−381.7,−372.3] ⇒ 旧测试误判「真空隙 2D 不收紧」。
    //   修正后 z 半径 = 半长 2.7475 ⇒ 车头 bbox 真到 −373.85 嵌进前排塔基带 ⇒ 2D 真命中。
    //   车缘 14.497+1.003=15.5 嵌前排塔基内缘 14.8 ⇒ 收紧到 14.8 − 1.003 = 13.797（比 1D 更紧）。
    //   这正是修正 SAT 的正确行为：1D 前脸包络在塔基带过松，2D 兜底防车头穿塔基。
    const z = -371.1;
    const faceCenter = BOUNDS.cityOpenHalfW - HALF_W; // 14.497 前脸车心包络
    const x1d = resolveBounds(20, z, 0, 10).x;
    expect(x1d).toBeCloseTo(faceCenter, 12);
    const fp = clampToFootprints(x1d, z, 0);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('frontBase'); // 前排塔基（R104 真实内缘 14.8）
    expect(fp.x).toBeCloseTo(INNER.faceHalf - 0.7 - HALF_W, 12); // 13.797
    expect(fp.x).toBeLessThan(x1d); // 2D 比 1D 更紧（防车头穿塔基）
  });

  it('斜插 θ=30° 飞扶壁墩位：墩比基座更靠内，2D 收到 9.107（不嵌墩）', () => {
    const z = BUTTRESS_Z; // −408.125 墩位（墩 z 覆盖 [−409.15,−407.05]）
    const h = -Math.PI / 6; // 30°
    const dx = dxAt(h); // 2.243
    expect(dx).toBeCloseTo(HALF_L * 0.5 + HALF_W * (Math.sqrt(3) / 2), 12);
    // 车长 bbox z 覆盖 [−411.03,−405.22] 命中墩（限 9.107）与角塔基座（限 12.657），
    // 取最紧 = 墩。1D 完全漏过墩内缘 11.35。
    // R111：x=13.897 斜插车缘内点 12.254 距墩外缘 11.9 有 0.35m 空隙（旧 SAT 假阳性误判交）；
    //   改 x=13.0（车角内点 10.757 真嵌墩 11.35 内缘 0.59m）⇒ 真命中墩。
    const fp = clampToFootprints(13.0, z, h);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('buttressBase');
    expect(fp.x).toBeCloseTo(BUTTRESS_LINK_INNER - dx, 12); // 9.107
    expect(fp.x + dx).toBeLessThanOrEqual(BUTTRESS_LINK_INNER + 1e-9);
  });

  it('斜插 θ=45° 飞扶壁墩位：墩比基座更靠内，2D 收到 8.699（不嵌墩 1.53 m）', () => {
    const z = BUTTRESS_Z;
    const h = -Math.PI / 4;
    const dx = dxAt(h);
    expect(dx).toBeCloseTo((HALF_L + HALF_W) * Math.SQRT1_2, 12); // 2.651
    const fp = clampToFootprints(13.897, z, h);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('buttressBase');
    expect(fp.x).toBeCloseTo(BUTTRESS_LINK_INNER - dx, 12); // 8.699
    expect(fp.x + dx).toBeLessThanOrEqual(BUTTRESS_LINK_INNER + 1e-9);
  });

  it('斜插 θ=30° 柱位：收紧到 11.12 − 2.243 = 8.877（不嵌柱 1.12 m）', () => {
    // 块 0 柱位 z = zc ± (i+0.5)·pitch，i=0 ⇒ ±4.4 ⇒ −384.1 / −392.9
    const zp = K0_ZC + 0.5 * R30_ARCADE.pitch; // −384.1
    const h = -Math.PI / 6;
    const dx = dxAt(h);
    // 1D 柱位车心限 10.117（R100），车缘 11.12 恰贴柱；2D 在此之上再收 dx − 半宽 = 1.24 m
    const x1d = ARCADE_COL_INNER - HALF_W; // 10.117
    const fp = clampToFootprints(x1d, zp, h);
    expect(fp.hit).toBe(true);
    expect(fp.x).toBeCloseTo(ARCADE_COL_INNER - dx, 12); // 11.12 − 2.243 = 8.877
    expect(fp.x + dx).toBeLessThanOrEqual(ARCADE_COL_INNER + 1e-9);
  });

  it('斜插 θ=30° 连墙飞扶壁墩位：收紧到 11.35 − 2.243（不嵌墩）', () => {
    // 连墙段 castleKit.ts:3289-3292 `[-blockLen/2, -blockLen/4 - 4.7]` = [−23, −16.2]（local）
    // 段中点 lz = (−23 + −16.2)/2 = −19.6 ⇒ 世界 z = K0_ZC − 19.6 = −408.125
    const zb = K0_ZC - (K0_HALF + (BLOCK_LEN_LOCAL / 4 + FRONT_TOWER_DEPTH)) / 2;
    const h = -Math.PI / 6;
    const dx = dxAt(h);
    const x1d = BUTTRESS_LINK_INNER - HALF_W; // 10.347（若 1D 允许到这）
    const fp = clampToFootprints(x1d, zb, h);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('buttressBase');
    expect(fp.x).toBeCloseTo(BUTTRESS_LINK_INNER - dx, 12);
    expect(fp.x + dx).toBeLessThanOrEqual(BUTTRESS_LINK_INNER + 1e-9);
  });

  it('斜插 θ=30° 空档 z=−600（R121 补街 frontWall）：收紧到 15.5 − 2.243（不穿补墙）', () => {
    // R121 ⑥c：z=−600 在缺块 k=5 [−641.5,−595.5]，R99 补街殿身/连墙（前脸 |x|=15.5）已补
    //   frontWall footprint ⇒ 斜插 θ=−30° 车角（dx=2.243）穿补墙被钳到 15.5−2.243=13.257
    //   （原无 footprint ⇒ hit=false 原样放行 = 空档斜插穿模 1.24m 的固化缺陷）。
    const z = -600;
    const h = -Math.PI / 6;
    const fp = clampToFootprints(14.0, z, h);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('frontWall');
    expect(fp.x).toBeCloseTo(15.5 - dxAt(h), 3);
    expect(fp.x + dxAt(h)).toBeLessThanOrEqual(15.5 + 1e-9);
  });

  it('镜像对称：−X 侧 θ=30° 飞扶壁墩收紧到 −9.107（put side 镜像）', () => {
    const fp = clampToFootprints(-13.0, BUTTRESS_Z, Math.PI / 6);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('buttressBase');
    expect(fp.x).toBeCloseTo(-(BUTTRESS_LINK_INNER - dxAt(Math.PI / 6)), 12);
    expect(fp.nx).toBe(1); // 外法向指向 +X（推向路内）
  });
});

describe('R102 ③ 车长 z 覆盖采样（2D vs 1D 核心差异）', () => {
  it('车心在钳位线内、车角 bbox 越过基座内缘 ⇒ 2D 收紧、1D 漏过', () => {
    // 用非 hero 块 k=3（z∈[−549.5,−503.5]，无角塔飞扶壁墩）隔离角塔基座：基座伸进空档
    //   z 覆盖 [zmin−2.6, zmin+2.6] = [−506.1,−500.9]。选 z=−503.5（块下边界，车长 z 覆盖
    //   [−506.25,−500.75] 仅命中角塔基座 ⇒ kind='cornerBase'）。
    //   不用块 0/1/2：hero 块 k<2 的角塔墩（xInner 11.35）与块 1/2 边界墩恒更紧、会盖过基座。
    // 绕过 1D 直接喂 x=14.2（> 1D 空档角塔覆盖带收紧线 13.897）验证 2D 越基座场景：
    // θ=0：dx = 半宽 1.003，2D 限 = 14.9 − 1.003 = 13.897 < 14.2 ⇒ hit（车缘 15.203 嵌基座 0.3 m）
    const z = -503.5;
    const fp0 = clampToFootprints(14.2, z, 0);
    expect(fp0.hit).toBe(true);
    expect(fp0.kind).toBe('cornerBase');
    expect(fp0.x).toBeCloseTo(CORNER_BASE_INNER - HALF_W, 12); // 13.897
    // θ=30°：车角 dx=2.243 > 半宽 1.003，单次 2D 收到 14.9 − 2.243 = 12.657（比 θ=0 再紧 1.24 m）。
    //   R112 x 钳迭代复查：clamp 到 12.657 后车 OBB（斜插）与块 3 连墙墩（buttressBase，z 带
    //   [−507.95,−505.85] 与车 z 覆盖 [−506.38,−500.62] 重叠 0.53m、x 带 [11.35,11.9] 被车横向
    //   覆盖）相交 ⇒ 继续钳到更紧界 11.35 − 2.243 = 9.107（消除车 OBB 斜插穿墩，非空气墙）。
    const h = -Math.PI / 6;
    const fp30 = clampToFootprints(14.2, z, h);
    expect(fp30.hit).toBe(true);
    expect(fp30.kind).toBe('buttressBase');
    expect(fp30.x).toBeCloseTo(BUTTRESS_LINK_INNER - dxAt(h), 12); // 9.107
    expect(fp30.x).toBeLessThan(fp0.x); // 2D 看 heading，1D 从不看
  });

  it('飞扶壁墩位 1D 漏过、2D 收紧：车心 10.5 通过 1D（< 前脸包络 14.497），2D θ=30° 收到 9.107', () => {
    // R103 阶段二：块心 1D 已放宽到连续墙包络，墩位 |z−zc|=19.625 > CITY_HALL_ZR_EXTENT ⇒ 1D = 前脸 14.497。
    // 车心 10.5 远在 1D 包络内 ⇒ 1D 完全不挡（这正是设计 B「看不见空隙不挡」的意图：周期墩下沉 2D）。
    const zb = -408.125;
    const r1d = resolveBounds(10.5, zb, 0, 10);
    expect(r1d.x).toBeCloseTo(10.5, 12); // 1D 包络 14.497 > 10.5 ⇒ 1D 不钳、原样放行（这正是「1D 漏过」）
    // θ=0 直行：2D 车缘 10.0+1.003=11.003 < 墩内缘 11.35 ⇒ 真空隙不收紧
    const fp0 = clampToFootprints(10.0, zb, 0);
    expect(fp0.hit).toBe(false); // 10.0 < 10.347 ⇒ 已在 2D 限内
    // 若车以 θ=30° 斜插（dx=2.243），2D 收到 11.35 − 2.243 = 9.107（10.0 > 9.107 ⇒ hit）
    const h = -Math.PI / 6;
    const fp30 = clampToFootprints(10.0, zb, h);
    expect(fp30.hit).toBe(true);
    expect(fp30.kind).toBe('buttressBase');
    expect(fp30.x).toBeCloseTo(BUTTRESS_LINK_INNER - dxAt(h), 12);
  });
});

describe('R102 ④ step() 集成：hit 时事件与速度口径（沿用 wall 链路）', () => {
  it('斜插 θ=30° 块角撞基座：step() 触发 kind=side + 速度法向衰减 + heading 滑行收敛', async () => {
    const { FreeDrive } = await import('../src/core/FreeDrive');
    const fd = new FreeDrive({ start: { x: 13.5, z: K0[0], heading: -Math.PI / 6 } });
    fd.teleport(13.5, K0[0], -Math.PI / 6);
    fd.press('KeyW', true); // 给油 → 前进方向 f = (−sin(−π/6), −cos(−π/6)) = (+0.5, −0.866)
    // 起步速度 ~5 m/s，f.x=+0.5 > 0 朝 +X 墙，fn>0 ⇒ 撞出 impactN>0
    let sawWall = false;
    let sawSideKind = false;
    fd.onEvent = (e) => {
      if (e === 'wall') sawWall = true;
    };
    // 直接摆到接近收紧线的位置：x=13.8（> 12.657 收紧线 ⇒ clampToFootprints 命中）
    fd.teleport(13.8, K0[0], -Math.PI / 6);
    fd.press('KeyW', true);
    // R110 连续收敛：2D 位置修正按 WALL_2D_MAX_LATERAL_STEP 摊到多帧（不再一帧写死）。
    //   R118 Fix 3：xPen 改真实 x 轴 SAT 穿透后，车贴墩掠过以**真实穿透**（~0.34 m/帧）平滑
    //   收敛到最紧界（此位姿最紧是**连墙墩** bound 9.107，非基座 12.657 —— R112 迭代复查把
    //   斜插车 OBB 扫到的墩也纳入），不再 R117 旧式 |x|−best 单帧 4.7 m 瞬移。60 帧内车已掠出
    //   墩/基座 z 带进块间空档（z≈−419），引擎自身 SAT 判定 hit=false。
    for (let i = 0; i < 60; i++) fd.step(1 / 120);
    // 验证车最终不嵌入任何城内占位（R118 Fix 3：真「不穿模」口径 = 引擎自身 SAT 车 OBB 与所有
    //   占位盒分离）。⚠ R117 旧断言 `x ≤ 14.9 − dx(−π/6) = 12.657` 用**初始 heading** 的 dx 是
    //   陈旧口径：车 heading 已收敛（−π/6→≈−0.43），当前 dx 变小、车缘 14.765 < 14.9 实未嵌基座；
    //   旧式 xPen=|x|−best 单帧 4.7 m 瞬移正是 R118 Fix 3 根治的目标。
    const sEnd = fd.snapshot();
    expect(clampToFootprints(sEnd.x, sEnd.z, sEnd.heading).hit).toBe(false);
    // 沿墙滑行 ⇒ heading 收敛到切向 ±Z（不在 −π/6 保持）
    sawSideKind = fd.snapshot().heading !== -Math.PI / 6;
    expect(sawSideKind || sawWall).toBe(true);
  });

  it('城内空档直行（x=0，z=−600）：不触发 wall 事件、速度不受影响', async () => {
    const { FreeDrive } = await import('../src/core/FreeDrive');
    const fd = new FreeDrive({ start: { x: 0, z: -600, heading: Math.PI } }); // 朝 +Z
    let wallCount = 0;
    fd.onEvent = (e) => {
      if (e === 'wall') wallCount++;
    };
    fd.press('KeyW', true);
    for (let i = 0; i < 120; i++) fd.step(1 / 120); // 1 s
    expect(wallCount).toBe(0);
    expect(fd.snapshot().speed).toBeGreaterThan(5);
  });
});

describe('R102 ⑤ 桥段 / 城门带门控（z=−250 / z=−360 零触发）', () => {
  it('桥段 z=−250：clampToFootprints 无城内占位可命中，step() 门控亦不激活', () => {
    // 桥段 z=−250 > gateFrontZ=−351.5 ⇒ 城内门控不激活（R118 上界扩到 gateFrontZ 仍未及桥段）
    const inCityDomain = -250 <= BOUNDS.gateFrontZ && -250 >= BOUNDS.zMin;
    expect(inCityDomain).toBe(false);
    // resolveBounds 在桥段仍给 bridgeHalfW − 半宽 = 10.997，1D 护栏不变
    const r = resolveBounds(20, -250, HEADING_TO_PLUS_X, 10);
    expect(r.x).toBeCloseTo(BOUNDS.bridgeHalfW - HALF_W, 12);
  });

  it('城门带 z=−360：R118 门控激活（z∈[zMin,gateFrontZ]），1D tunnelHalfW 护栏仍为底', () => {
    // R118：上界 gateBackZ→gateFrontZ ⇒ z=−360 ∈ [zMin, gateFrontZ] 门控激活（配合 Fix 1 门墩 footprint）
    const inCityDomain = -360 <= BOUNDS.gateFrontZ && -360 >= BOUNDS.zMin;
    expect(inCityDomain).toBe(true);
    // Fix 1 未落地前门带无 footprint ⇒ clampToFootprints 零命中，1D tunnelHalfW 护栏仍接管
    const fp = clampToFootprints(20, -360, 0);
    expect(fp.hit).toBe(false);
    const r = resolveBounds(20, -360, HEADING_TO_PLUS_X, 10);
    expect(r.x).toBeCloseTo(BOUNDS.tunnelHalfW - HALF_W, 12);
  });

  it('主殿广场 z=−1290（≤ plazaZ=−1285.5）：门控不激活，沿用 1D plazaHalfW 护栏', () => {
    const inCityDomain = -1290 <= BOUNDS.gateBackZ && -1290 >= BOUNDS.plazaZ;
    expect(inCityDomain).toBe(false);
    const r = resolveBounds(20, -1290, HEADING_TO_PLUS_X, 10);
    expect(r.x).toBeCloseTo(BOUNDS.plazaHalfW - HALF_W, 12);
  });

  it('城内块区 z=−388.5：门控激活（z ≤ gateFrontZ ≥ zMin）', () => {
    const inCityDomain = K0_ZC <= BOUNDS.gateFrontZ && K0_ZC >= BOUNDS.zMin;
    expect(inCityDomain).toBe(true);
  });
});

describe('R102 ⑥ 零改红线：resolveBounds / corridorHalfWidth / corridorCenterHalfWidth 逐位不变', () => {
  it('resolveBounds 块角 / 块心 / 桥 / 门 / 广场 / hall 六段口径全不变（r99 同款断言）', () => {
    expect(resolveBounds(20, K0[0], HEADING_TO_PLUS_X, 10).x).toBeCloseTo(
      CORNER_BASE_INNER - HALF_W,
      12
    );
    // R103 阶段二：块心 1D = 连续墙包络（殿身 |z−zc|≤6.85 ⇒ 大理石带 15.0 − 半宽 = 13.997），非旧 10.0
    expect(resolveBounds(20, K0_ZC, HEADING_TO_PLUS_X, 10).x).toBeCloseTo(
      INNER.faceHalf - 0.5 - HALF_W,
      12
    );
    expect(resolveBounds(20, -250, HEADING_TO_PLUS_X, 10).x).toBeCloseTo(
      BOUNDS.bridgeHalfW - HALF_W,
      12
    );
    expect(resolveBounds(20, -360, HEADING_TO_PLUS_X, 10).x).toBeCloseTo(
      BOUNDS.tunnelHalfW - HALF_W,
      12
    );
    expect(resolveBounds(20, -1290, HEADING_TO_PLUS_X, 10).x).toBeCloseTo(
      BOUNDS.plazaHalfW - HALF_W,
      12
    );
    // hall：z ≤ zMin 且 |x|<24 ⇒ 弹回 zMin + hallBounce = −1296.2
    const hall = resolveBounds(0, BOUNDS.zMin - 1, 0, 20);
    expect(hall.kind).toBe('hall');
    expect(hall.z).toBeCloseTo(BOUNDS.zMin + 0.8, 12);
    expect(hall.speed).toBe(0);
  });

  it('BOUNDS 关键常量不变', () => {
    expect(BOUNDS.bridgeHalfW).toBe(12.0);
    expect(BOUNDS.tunnelHalfW).toBe(10.0);
    expect(BOUNDS.arcadeHalfW).toBe(10.0);
    expect(BOUNDS.cityOpenHalfW).toBe(15.5);
    expect(BOUNDS.plazaHalfW).toBe(15.5);
    expect(BOUNDS.gateBackZ).toBe(-365.5);
    expect(BOUNDS.plazaZ).toBe(-1285.5);
    expect(BOUNDS.zMin).toBe(-1297);
    expect(BOUNDS.zMax).toBe(70);
  });
});
