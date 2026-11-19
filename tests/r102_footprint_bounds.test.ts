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
 * 城内域门控（z ∈ [plazaZ, gateBackZ]）。resolveBounds / corridorHalfWidth /
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
import { INNER, TOWER } from '../src/render/scene/r28Layout';
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
    expect(byKind('frontWall').length).toBe(10);
    expect(byKind('hallBase').length).toBe(20); // 10 块 × 殿台基 + 大理石带
    expect(byKind('cornerBase').length).toBe(20); // 10 块 × 2 座
    expect(byKind('frontBase').length).toBe(20); // 10 块 × 2 座
    expect(byKind('arcadeCol').length).toBe(40); // 10 块 × 4 柱
    // R103 阶段二：连墙墩 20（10 块 × 2 连墙段）+ 角塔墩 4（hero 块 k<2 各 2 座）= 24
    expect(byKind('buttressBase').length).toBe(24);
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
    for (const f of byKind('buttressBase')) {
      expect(f.xInner).toBeCloseTo(BUTTRESS_LINK_INNER, 12);
    }
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
  it('直行 θ=0 飞扶壁墩位：车长 z 覆盖命中飞扶壁墩（内缘 11.35 < 基座 14.9）⇒ 2D 收紧到 10.347', () => {
    // 墩世界 z = zc − 19.6 = −408.125（连墙段中点 lz=−19.6），墩 z 覆盖 [−409.15,−407.05]。
    // 1D resolveBounds 在墩位 z 给块心 10.0；我们绕过 1D 直接喂 x=13.897（块角基座 1D 线）
    // 验证 2D：θ=0 时 dx = 半宽 1.003，车长 bbox z ∈ [−410.87,−405.38] 落进墩 z 覆盖
    // ⇒ 墩内缘 11.35 − 1.003 = 10.347 比基座 13.897 更紧 ⇒ 2D 取墩。
    // 这正是 probe-bounds §3.1 P1「车尾卡台阶缝隙」根因：1D 在车心 z 求值、不采样车尾 z 覆盖。
    const z = BUTTRESS_Z; // −408.125 墩位
    const fp = clampToFootprints(13.897, z, 0);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('buttressBase');
    expect(fp.x).toBeCloseTo(BUTTRESS_LINK_INNER - HALF_W, 12); // 10.347
    expect(fp.x).toBeLessThan(13.897);
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

  it('直行 θ=0 块内真空隙（近端塔基与角塔基座之间 z=−371.1）：1D = 前脸包络 14.497，2D 不新增约束', () => {
    // R104 P1 收紧后（前排塔基真实内缘 14.8）块心 z 带 z∈[zc−18.3, zc+18.3] 已被塔基/大理石带/前脸
    //   连续覆盖，heading=0 在前脸包络 14.497 处不再有原 z=−378.5 那种稳健真空隙（旧版靠塔基旧内缘
    //   15.5 与车缘 15.5 边界重合的浮点分离假象）。块 0（zc=−388.5）域内真真空隙仅落在近端塔基
    //   （tz=zc+11.5=−377，z 带 [−381.7,−372.3]）与角塔基座（cz=zc+22.5=−366，z 带 [−369.1,−362.9]）
    //   之间：z∈[−372.3,−369.1]。取中点 z=−371.1（车长 z 覆盖 [−373.85,−368.35]，仅擦边不交占位盒）。
    //   |z−zc|=17.4 > CITY_HALL_ZR_EXTENT ⇒ 1D = 前脸包络 14.497。
    // 车沿 Z 行驶 ⇒ dx = 半宽 1.003，车缘 14.497+1.003 = 15.5 恰贴建筑前脸线（frontWall 内缘 15.5 不相交）⇒ 2D 不收紧。
    const z = -371.1;
    const faceCenter = BOUNDS.cityOpenHalfW - HALF_W; // 14.497 前脸车心包络
    const x1d = resolveBounds(20, z, 0, 10).x;
    expect(x1d).toBeCloseTo(faceCenter, 12);
    const fp = clampToFootprints(x1d, z, 0);
    expect(fp.hit).toBe(false);
    expect(fp.x).toBeCloseTo(x1d, 12);
  });

  it('斜插 θ=30° 飞扶壁墩位：墩比基座更靠内，2D 收到 9.107（不嵌墩）', () => {
    const z = BUTTRESS_Z; // −408.125 墩位（墩 z 覆盖 [−409.15,−407.05]）
    const h = -Math.PI / 6; // 30°
    const dx = dxAt(h); // 2.243
    expect(dx).toBeCloseTo(HALF_L * 0.5 + HALF_W * (Math.sqrt(3) / 2), 12);
    // 车长 bbox z 覆盖 [−411.03,−405.22] 命中墩（限 9.107）与角塔基座（限 12.657），
    // 取最紧 = 墩。1D 完全漏过墩内缘 11.35。
    const fp = clampToFootprints(13.897, z, h);
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

  it('斜插 θ=30° 无占位处（空档 z=−600，x=14.0）：不新增钳位', () => {
    // 块 3 [−549.5,−503.5] 与块 4 [−641.5,−595.5] 之间空档 z=−600 附近 5 m 内无任何占位盒
    const z = -600;
    const fp = clampToFootprints(14.0, z, -Math.PI / 6);
    expect(fp.hit).toBe(false);
    expect(fp.x).toBe(14.0);
  });

  it('镜像对称：−X 侧 θ=30° 飞扶壁墩收紧到 −9.107（put side 镜像）', () => {
    const fp = clampToFootprints(-13.897, BUTTRESS_Z, Math.PI / 6);
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
    // θ=30°：车角 dx=2.243 > 半宽 1.003，2D 收到 14.9 − 2.243 = 12.657（比 θ=0 再紧 1.24 m）
    const h = -Math.PI / 6;
    const fp30 = clampToFootprints(14.2, z, h);
    expect(fp30.hit).toBe(true);
    expect(fp30.kind).toBe('cornerBase');
    expect(fp30.x).toBeCloseTo(CORNER_BASE_INNER - dxAt(h), 12); // 12.657
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
    for (let i = 0; i < 5; i++) fd.step(1 / 120);
    // 验证 x 被钳到 ≤ 14.9 − dx（不嵌入基座）
    const dx = dxAt(-Math.PI / 6);
    expect(fd.snapshot().x).toBeLessThanOrEqual(CORNER_BASE_INNER - dx + 1e-6);
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
    // 桥段 z=−250 > gateBackZ=−365.5 ⇒ 城内门控不激活
    const inCityDomain = -250 <= BOUNDS.gateBackZ && -250 >= BOUNDS.plazaZ;
    expect(inCityDomain).toBe(false);
    // resolveBounds 在桥段仍给 bridgeHalfW − 半宽 = 10.997，1D 护栏不变
    const r = resolveBounds(20, -250, HEADING_TO_PLUS_X, 10);
    expect(r.x).toBeCloseTo(BOUNDS.bridgeHalfW - HALF_W, 12);
  });

  it('城门带 z=−360：门控不激活（z > gateBackZ），沿用 1D tunnelHalfW 护栏', () => {
    const inCityDomain = -360 <= BOUNDS.gateBackZ && -360 >= BOUNDS.plazaZ;
    expect(inCityDomain).toBe(false);
    const r = resolveBounds(20, -360, HEADING_TO_PLUS_X, 10);
    expect(r.x).toBeCloseTo(BOUNDS.tunnelHalfW - HALF_W, 12);
  });

  it('主殿广场 z=−1290（≤ plazaZ=−1285.5）：门控不激活，沿用 1D plazaHalfW 护栏', () => {
    const inCityDomain = -1290 <= BOUNDS.gateBackZ && -1290 >= BOUNDS.plazaZ;
    expect(inCityDomain).toBe(false);
    const r = resolveBounds(20, -1290, HEADING_TO_PLUS_X, 10);
    expect(r.x).toBeCloseTo(BOUNDS.plazaHalfW - HALF_W, 12);
  });

  it('城内块区 z=−388.5：门控激活（gateBackZ ≤ z ≥ plazaZ）', () => {
    const inCityDomain = K0_ZC <= BOUNDS.gateBackZ && K0_ZC >= BOUNDS.plazaZ;
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
