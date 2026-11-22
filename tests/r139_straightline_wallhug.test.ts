/**
 * R139 · Fix-2 直行贴墙平滑钉死（cornerBase / frontBase / fire basin 单帧 yank 根治防回归）。
 *
 * 背景：Fix-2 根治广场 approach 直行贴墙单帧 0.5~1.05m 横向 yank（cornerBase / frontBase /
 * fire basin）。根因 = 这三类占位盒**均非** isSolidEntryKind（buttressBase/hallBase/doorLeaf）
 * 亦**非** isEntryKind（gatePier/buttressBase/arcadeCol/hallBase 入激活域类），车直行贴墙
 * （heading=0，sinH=0，车头沿 z 为主）时车 OBB 纵向深嵌（zOv≫xPenRaw：cornerBase zOv/xPen≈6~7、
 * frontBase≈9、fire basin 方体 zOv/xPen≈1.000），R123 fix-1b 的 `zOv < xPenRaw` 判据为 false
 * （纵向深嵌反向）且 `(sinHAbs<=0.5 && isEntryKind)` 不命中（kind 不在入域类）⇒ xPenSmooth=false
 * ⇒ 单帧推回 = 真实穿透 0.5~1.05m（>X_Z_PEN_SMOOTH_CAP=0.35）= 贴墙横向 yank（真空气墙）。
 *
 * Fix-2（本测试钉死）：把 `sinHAbs<=0.5 && isEntryKind` 泛化为 `sinHAbs<=0.5`（去 zOv<xPenRaw
 * 判别与 isEntryKind 门控）——凡车头沿 z 为主（sinH≤0.5）恒平滑（min(xPenRaw, 0.35)），不再依赖
 * 纵向/横向深嵌判别。isEntryKind 常量移除。最终 clamp 目标（best = xInner−dx 远侧收紧）不变，
 * 仅限 FreeDrive 单帧推回到 X_Z_PEN_SMOOTH_CAP=0.35（收敛速率，2~3 帧贴界，无残留无卡死）。
 *
 * ⚠ 本测试只断言 clampToFootprints 纯函数行为（与 v800-tester 探测相同坐标），不做 step()
 * 集成（resolveBounds 1D 阶跃在块边界贡献单帧横移，与 Fix-2 的 2D 平滑正交，会误报）。
 *
 * 真源口径：INNER / VEHICLE 一律 import 派生，禁写死 13.897 / 13.797 / 13.347 / 0.35。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clampToFootprints } from '../src/core/cityFootprints';
import { VEHICLE } from '../src/config/physics';
import { INNER } from '../src/render/scene/r28Layout';

/** 车半宽（physics.ts 真源，勿写死 1.003） */
const CAR_HALF_W = VEHICLE.widthM / 2;

/** Fix-2 平滑上限 X_Z_PEN_SMOOTH_CAP（cityFootprints 同源，勿写死漂移） */
const SMOOTH_CAP = 0.35;

/* ── 最终 clamp 目标真源派生（= 远侧收紧界 = xInner − 半宽，Fix-2 只限速率不改目标）── */
/** cornerBase 内缘 = faceHalf − 基座裙/2 = 15.5 − 0.6 = 14.9 ⇒ 目标 14.9 − 1.003 = 13.897 */
const CORNER_BASE_TARGET = INNER.faceHalf - 1.2 / 2 - CAR_HALF_W;
/** frontBase 内缘 = faceHalf − 0.7 = 14.8 ⇒ 目标 13.797（R104 真实可见内缘） */
const FRONT_BASE_TARGET = INNER.faceHalf - 0.7 - CAR_HALF_W;
/** fire basin 内缘 = faceHalf − 0.7 − 0.45 = 14.35 ⇒ 目标 13.347（R123 墙根/街面火盆） */
const FIRE_BASIN_TARGET = INNER.faceHalf - 0.7 - 0.45 - CAR_HALF_W;

/** 源文件路径（相对本测试，供结构断言） */
const SRC_PATH = fileURLToPath(new URL('../src/core/cityFootprints.ts', import.meta.url));
/** 源文件全文（Fix-2 结构断言） */
const SRC = readFileSync(SRC_PATH, 'utf8');

describe('R139 ① Fix-2 直行贴墙平滑 · cornerBase（角塔大理石基座，k9 南端）', () => {
  it('a cornerBase x=14.4 z=−1287.17 θ=0：单帧推回（xPen）≤0.35、最终目标 13.897 不变', () => {
    // Fix-2 前 xPenRaw≈0.503（真实 x 轴穿透）>0.35 且 zOv/xPen≈6~7（纵向深嵌）⇒ xPenSmooth=false
    //   ⇒ 单帧推回 0.503m yank。Fix-2 后 sinH=0≤0.5 恒平滑 ⇒ xPen=min(0.503,0.35)=0.35。
    //   最终目标 = 远侧收紧界 14.9−1.003=13.897（与 Fix-2 前一致，Fix-2 不改 best）。
    const fp = clampToFootprints(14.4, -1287.17, 0);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('cornerBase');
    // 单帧推回上限 ≤0.35（Fix-2 平滑钉死；float 余量 1e-9）
    expect(fp.xPen).toBeLessThanOrEqual(SMOOTH_CAP + 1e-9);
    // 最终 clamp 目标不变（Fix-2 前一致，真源派生）
    expect(fp.x).toBeCloseTo(CORNER_BASE_TARGET, 9);
  });

  it('b cornerBase x=14.497 z=−1287.17 θ=0（1D 车心面线走廊位）：≤0.35、目标 13.897', () => {
    // x=14.497 恰在 1D 车心面线走廊（cityOpenHalfW−halfW），贴墙最极端：xPenRaw=0.600（车缘
    //   15.5 恰贴前脸）仍被平滑到 0.35（旧 0.6 yank 根治）。
    const fp = clampToFootprints(14.497, -1287.17, 0);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('cornerBase');
    expect(fp.xPen).toBeLessThanOrEqual(SMOOTH_CAP + 1e-9);
    expect(fp.x).toBeCloseTo(CORNER_BASE_TARGET, 9);
  });
});

describe('R139 ② Fix-2 直行贴墙平滑 · frontBase（前排塔基，k9 块南侧）', () => {
  it('c frontBase x=14.4 z=−1274 θ=0：≤0.35、目标 13.797', () => {
    // frontBase 内缘 14.8（R104 真实可见内缘），x=14.4 贴墙：xPenRaw=0.603、zOv/xPen≈9（纵向深嵌）
    //   ⇒ Fix-2 前不平滑单帧 0.603 yank；Fix-2 后 xPen=0.35。
    const fp = clampToFootprints(14.4, -1274, 0);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('frontBase');
    expect(fp.xPen).toBeLessThanOrEqual(SMOOTH_CAP + 1e-9);
    expect(fp.x).toBeCloseTo(FRONT_BASE_TARGET, 9);
  });
});

describe('R139 ③ Fix-2 直行贴墙平滑 · fire basin（墙根火盆，k9 块 zc−21）', () => {
  it('d frontWall fire basin x=14.4 z=−1283.5 θ=0：≤0.35、目标 13.347', () => {
    // fire basin 内缘 14.35（贴墙突出 0.9×0.9 方体），x=14.4 贴墙：xPenRaw=0.900、
    //   zOv/xPen≈1.000（方体 z 半宽=车 z 半宽覆盖，精确等值）⇒ Fix-2 前 `zOv<xPenRaw` 严格判据
    //   漏掉（zOv/xPen=1.000 非严格小于）⇒ 不平滑单帧 0.9 yank；Fix-2 去 zOv 判别后 xPen=0.35。
    const fp = clampToFootprints(14.4, -1283.5, 0);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('frontWall');
    expect(fp.xPen).toBeLessThanOrEqual(SMOOTH_CAP + 1e-9);
    expect(fp.x).toBeCloseTo(FIRE_BASIN_TARGET, 9);
  });
});

describe('R139 ④ 对照 · 斜插 sinH>0.5 不平滑（r105/r119 语义保留）', () => {
  it('e arcadeCol x=9.4 z=−496 h=0.7：hit、xPen 保持原始穿透（>0.35，未被低角项误平滑）', () => {
    // 对照：sinH=|sin0.7|≈0.644>0.5（车头非 z 为主），arcadeCol 柱带（窄 0.60m）斜插。
    //   Fix-2 低角项 `sinHAbs<=0.5` 不命中 ⇒ xPenSmooth 保持 false（isSolidEntryKind=false 且
    //   arcadeCol 非门墩 zOv<xPenRaw 判别：柱带窄 xPenRaw=0.60 恰等于带宽）⇒ xPen 保留原始
    //   穿透 0.60（r105/r119 单帧消除穿模语义不变，非被压到 0.35）。
    //   ⚠ 若 Fix-2 误泛化到 sinH>0.5（去 sinH 门控），xPen 会被压到 0.35 ⇒ 本断言防回归。
    const fp = clampToFootprints(9.4, -496, 0.7);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('arcadeCol');
    // 未被低角项误平滑：xPen 保留原始穿透（>0.35）
    expect(fp.xPen).toBeGreaterThan(SMOOTH_CAP);
    // 原始穿透 = 柱带宽（0.60，车 OBB x 投影与柱带公共长度），非 0.35 平滑值
    expect(fp.xPen).toBeCloseTo(0.60, 2);
  });

  it('e2 arcadeCol 柱位 x=9.4 z=−485.9 h=0.7：xPen>0.35 且 z 深嵌单帧消除保留（r105 漂移语义）', () => {
    // 柱位 z=−485.9（k2 zc−4.4）：车 OBB z 深嵌柱带（zPen≈2.05）> xPen(0.60) ⇒ zPenSmooth=false
    //   （xPenRaw>zPenRaw 判据反向）⇒ z 单帧消除保留（r105 漂移贴墙纵向深嵌收敛尾部零穿模）。
    const fp = clampToFootprints(9.4, -485.9, 0.7);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('arcadeCol');
    expect(fp.xPen).toBeGreaterThan(SMOOTH_CAP); // x 不平滑
    expect(fp.zPen).toBeGreaterThan(SMOOTH_CAP); // z 深嵌单帧消除保留（>0.35 不平滑）
  });
});

describe('R139 ⑤ 最终 clamp 目标不变（Fix-2 只限速率不改 best，与 Fix-2 前一致）', () => {
  it('f 三场景目标 = 远侧收紧界（xInner−半宽），真源派生，Fix-2 前一致', () => {
    // Fix-2 只改 xPenSmooth 条件（限 FreeDrive 单帧推回），不改 clampToFootprints 的 best
    //   （远侧收紧界 xInner−dx）。三场景目标逐位 = Fix-2 前（r119/r102 已钉 13.897/13.797/13.347）。
    //   用真源派生交叉验证（禁写死）。
    expect(CORNER_BASE_TARGET).toBeCloseTo(13.897, 9);
    expect(FRONT_BASE_TARGET).toBeCloseTo(13.797, 9);
    expect(FIRE_BASIN_TARGET).toBeCloseTo(13.347, 9);
    // clamp 目标 = 派生值（已由 ①~③ 断言，此处再显式钉目标公式）
    expect(clampToFootprints(14.4, -1287.17, 0).x).toBeCloseTo(CORNER_BASE_TARGET, 9);
    expect(clampToFootprints(14.4, -1274, 0).x).toBeCloseTo(FRONT_BASE_TARGET, 9);
    expect(clampToFootprints(14.4, -1283.5, 0).x).toBeCloseTo(FIRE_BASIN_TARGET, 9);
  });
});

describe('R139 ⑥ 结构断言 · cityFootprints.ts 无 isEntryKind 残留、xPenSmooth 条件含 sinHAbs<=0.5', () => {
  it('g1 源文件不含 isEntryKind 常量声明（Fix-2 已移除变量）', () => {
    // Fix-2 把 `sinHAbs<=0.5 && isEntryKind` 泛化为 `sinHAbs<=0.5`，isEntryKind 变量删除。
    //   仅钉「常量/变量声明」不存在（注释里允许提及 isEntryKind 说明历史，故不扫注释）。
    expect(SRC).not.toMatch(/const\s+isEntryKind\b/);
    expect(SRC).not.toMatch(/\bisEntryKind\s*=\s*/);
  });

  it('g2 xPenSmooth 条件 = isSolidEntryKind || isSteepNonEntryKind || (!isGatePierKind && zOv<xPenRaw) || sinHAbs<=0.5', () => {
    // Fix-2 核心：低角项从 `sinHAbs<=0.5 && isEntryKind` 改为 `sinHAbs<=0.5`（去 isEntryKind 门控）。
    //   R140：插入 isSteepNonEntryKind（cornerBase/frontBase/frontWall 陡角深嵌恒平滑，见
    //   tests/r140_steep_nonentry_smooth.test.ts）。多行正则钉死 xPenSmooth 赋值块（防注释/历史匹配）。
    //   ⚠ 条件内 R140 加了行内 `// R140：...` 注释，先剥离 `/* */` 与 `//` 注释再匹配代码主体
    //   （与 g3 同法），否则注释文本打断正则。
    const codeBody = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(codeBody).toMatch(
      /const\s+xPenSmooth\s*=\s*xPenRaw\s*>\s*0\.35\s*&&\s*\(\s*isSolidEntryKind\s*\|\|\s*isSteepNonEntryKind\s*\|\|\s*\(!isGatePierKind\s*&&\s*zOv\s*<\s*xPenRaw\)\s*\|\|\s*sinHAbs\s*<=\s*0\.5\s*\)/s
    );
  });

  it('g3 代码主体不残留旧式 `sinHAbs<=0.5 && isEntryKind`（Fix-2 已去 isEntryKind 门控）', () => {
    // 旧式低角项（已删除）：`(sinHAbs<=0.5 && isEntryKind)`。⚠ 源注释仍提及 isEntryKind 说明
    //   历史（Fix-2 改后注释保留），故先剥离 `/* */` 块注释与 `//` 行注释再断言**代码主体**。
    const codeBody = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(codeBody).not.toMatch(/sinHAbs\s*<=\s*0\.5\s*&&\s*isEntryKind/);
  });
});
