/**
 * R99 · 撞墙瞬态（wall-scuff transient）回归（物理侧，不与 bounds 侧抢文件）。
 *
 * 用户诉求「撞击物理逼近真车」：旧版 resolveBounds 在一个 1/120s 步内用 slideHeading
 * 把车头硬掰到墙面切向（等效 ≈24rad/s ≈ 26×maxYawRate），并把速度整体乘系数
 * （等效 ≈44g 减速）。本修复几何钳位仍瞬时，运动学改由 IMPACT_TAU 一阶展开：
 *   ① 纯函数 impactHeadingStep 单帧有界 / 单调 / 无 wrap 跳变；
 *   ② resolveBounds 速度「法向吸收 + 切向保留」矢量分解；
 *   ③ FreeDrive 写回朝向一阶收敛、漂移态渐变、瞬态包络衰减。
 *
 * 采样点 z=−250（御桥段，车心限恒定 10.997），避开 r99-bounds 的块角 dc<3 过渡区。
 */
import { describe, expect, it } from 'vitest';
import {
  BOUNDS,
  FREE,
  FreeDrive,
  IMPACT_TAU,
  corridorCenterHalfWidth,
  forwardOf,
  impactHeadingStep,
  resolveBounds
} from '../src/core/FreeDrive';

const DT = 1 / 120;
const IMPACT_Z = -250; // 桥段，limits 恒定，避开块角
const LIMIT = corridorCenterHalfWidth(IMPACT_Z); // 10.997
const HEADING_TO_PLUS_X = -0.2; // f.x = +sin(0.2) > 0 ⇒ 朝 +X 墙斜擦

describe('R99 ① impactHeadingStep 一阶收敛（不再是单帧硬切）', () => {
  it('单帧只走 dt/tau 比例：Δh=0.2rad → 0.0139rad（≈0.79°），远小于 0.05', () => {
    const h = HEADING_TO_PLUS_X;
    const target = 0;
    const next = impactHeadingStep(h, target, IMPACT_TAU, DT);
    const moved = Math.abs(next - h);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(0.05); // 硬切版一帧 0.2rad 必红
    expect(moved).toBeCloseTo(0.2 * (DT / IMPACT_TAU), 6); // 0.013888...
  });

  it('多步单调逼近、无越界 / 无 wrap 跳变，≈3τ 收敛到 5% 以内', () => {
    let h = HEADING_TO_PLUS_X;
    const target = 0;
    const initialGap = Math.abs(target - h);
    let prevGap = initialGap;
    for (let i = 0; i < 48; i += 1) {
      // 48 步 = 0.4s ≈ 3.33τ（线性一阶剩余 (1−dt/τ)^48 ≈ 3.2%）
      h = impactHeadingStep(h, target, IMPACT_TAU, DT);
      const gap = Math.abs(target - h);
      expect(gap).toBeLessThanOrEqual(prevGap + 1e-12); // 单调逼近
      expect(gap).toBeLessThanOrEqual(initialGap + 1e-12); // 不越过目标
      prevGap = gap;
    }
    expect(prevGap).toBeLessThan(initialGap * 0.05);
  });

  it('跨越 ±π 取最短弧（不绕远路，无 2π 跳变）', () => {
    // h=3.1, target=−3.1（等价 +3.183）：最短角差 ≈ +0.0832，应往上走一小步
    const h = 3.1;
    const next = impactHeadingStep(h, -3.1, IMPACT_TAU, DT);
    expect(next).toBeGreaterThan(h);
    expect(next - h).toBeGreaterThan(0);
    expect(next - h).toBeLessThan(0.01);
  });

  it('大 dt 不过冲（alpha 钳到 1）', () => {
    expect(impactHeadingStep(HEADING_TO_PLUS_X, 0, IMPACT_TAU, 10)).toBeCloseTo(0, 12);
  });
});

describe('R99 ② resolveBounds 速度法向吸收 + 切向保留', () => {
  it('斜擦 fn≈0.199：speed≈19.61（切向保留）而非旧版 16.42；heading 不硬掰', () => {
    const r = resolveBounds(LIMIT + 5, IMPACT_Z, HEADING_TO_PLUS_X, 20);
    const fn = forwardOf(HEADING_TO_PLUS_X).x; // nx=+1 ⇒ fn≈0.1987
    const expectedSpeed = Math.hypot(
      20 * fn * (1 - FREE.wallDecay),
      20 * Math.sqrt(1 - fn * fn)
    );
    expect(r.kind).toBe('side');
    expect(r.x).toBeCloseTo(LIMIT, 12); // 几何钳位逐位不动
    expect(r.heading).toBeCloseTo(HEADING_TO_PLUS_X, 12); // 不再一帧硬切
    expect(r.speed).toBeCloseTo(expectedSpeed, 6); // ≈19.61
    expect(r.speed).toBeGreaterThan(19);
    expect(r.targetHeading).toBeCloseTo(0, 6); // slideHeading 终值：沿墙 −Z
    expect(r.impactN).toBeCloseTo(20 * fn, 6); // ≈3.97
  });

  it('正撞 fn→1：speed 落到 (1−wallDecay)·|v| 量级，slideHeading 兜底给出可用切向（不卡死）', () => {
    const r = resolveBounds(LIMIT + 5, IMPACT_Z, -Math.PI / 2, 20);
    expect(r.kind).toBe('side');
    expect(r.speed).toBeCloseTo(20 * (1 - FREE.wallDecay), 6); // 2.0 m/s
    expect(r.speed).toBeGreaterThanOrEqual(FREE.wallKeepMin * 20); // ≥1.6，不卡死
    expect(r.impactN).toBeCloseTo(20, 6);
    expect(r.targetHeading).toBeDefined();
    // 终值朝向必须沿墙切向：前向量 x 分量 ≈0（法向被剔干净）
    expect(Math.abs(forwardOf(r.targetHeading!).x)).toBeLessThan(1e-6);
  });

  it('impactN = |v|·fn 对 fn 单调；擦墙 fn→0 时 →0', () => {
    const impacts = [0, -0.05, -0.2, -0.6, -1.2, -Math.PI / 2].map((h) => {
      const f = forwardOf(h);
      return resolveBounds(LIMIT + 5, IMPACT_Z, h, 20).impactN!;
    });
    expect(impacts[0]).toBeCloseTo(0, 6); // 平行墙：无撞击
    for (let i = 1; i < impacts.length; i += 1) {
      expect(impacts[i]).toBeGreaterThan(impacts[i - 1]);
    }
    expect(impacts[impacts.length - 1]).toBeCloseTo(20, 6); // 正撞最大
  });

  it('end 分支同构：越过 zMax 后速度分解 + impactN/targetHeading', () => {
    // heading=π ⇒ forward=(0,+1)，nz=+1 ⇒ fn=1 正撞北端
    const r = resolveBounds(0, BOUNDS.zMax + 5, Math.PI, 20);
    expect(r.kind).toBe('end');
    expect(r.z).toBeCloseTo(BOUNDS.zMax, 12);
    expect(r.speed).toBeCloseTo(20 * (1 - FREE.wallDecay), 6);
    expect(r.impactN).toBeCloseTo(20, 6);
    expect(r.targetHeading).toBeDefined();
    // R100：hall 带 impactN 供 wallImpact 瞬态复用，speed 仍 0、无 targetHeading
    const hall = resolveBounds(0, BOUNDS.zMin, 0, 20);
    expect(hall.kind).toBe('hall');
    expect(hall.impactN).toBe(20); // |v|：正撞法向强度
    expect(hall.targetHeading).toBeUndefined();
  });
});

describe('R99 ③ FreeDrive 写回：朝向一阶收敛 / 漂移态渐变 / 瞬态包络', () => {
  it('撞墙帧：速度保留切向（>19m/s），heading 单帧只转一小步', () => {
    const fd = new FreeDrive({ start: { x: 10.5, z: IMPACT_Z, heading: HEADING_TO_PLUS_X } });
    fd.state.speed = 20;
    let wallHits = 0;
    fd.onEvent = (e) => {
      if (e === 'wall') wallHits += 1;
    };
    let hBefore = fd.state.heading;
    for (let i = 0; i < 200 && wallHits === 0; i += 1) {
      hBefore = fd.state.heading;
      fd.step(DT);
    }
    expect(wallHits).toBeGreaterThan(0);
    expect(fd.state.x).toBeCloseTo(LIMIT, 9);
    expect(fd.state.speed).toBeGreaterThan(19); // 旧版一帧掉到 16.42
    const dh = Math.abs(fd.state.heading - hBefore);
    expect(dh).toBeLessThan(0.05); // 旧版一帧转 0.2
  });

  it('撞墙后 heading 单调收敛到沿墙切向（target=0），无跳变', () => {
    const fd = new FreeDrive({ start: { x: 10.5, z: IMPACT_Z, heading: HEADING_TO_PLUS_X } });
    fd.state.speed = 20;
    let hit = false;
    const gaps: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      fd.step(DT);
      if (fd.state.x >= LIMIT - 1e-9) hit = true;
      if (hit) gaps.push(Math.abs(fd.state.heading)); // 终值 0
    }
    expect(hit).toBe(true);
    expect(gaps.length).toBeGreaterThan(6);
    for (let i = 1; i < gaps.length; i += 1) {
      expect(gaps[i]).toBeLessThanOrEqual(gaps[i - 1] + 1e-9);
    }
    expect(gaps[gaps.length - 1]).toBeLessThan(gaps[0] * 0.5);
  });

  it('撞墙后 beta/yawDyn 逐帧衰减（非一步归零），速度未跌破漂移门限', () => {
    const fd = new FreeDrive({ start: { x: 10.5, z: IMPACT_Z, heading: -0.4 } });
    fd.state.speed = 20;
    // 注入体轴侧向速度/动态偏航，使 beta≈0.197、moveHeading≈−0.203（仍朝 +X 墙）
    (fd as unknown as { vy: number }).vy = 4;
    (fd as unknown as { yawDyn: number }).yawDyn = 0.2;
    let hit = false;
    const betas: number[] = [];
    const yaws: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      fd.step(DT);
      if (fd.state.x >= LIMIT - 1e-9) hit = true;
      if (hit) {
        betas.push(Math.abs(fd.state.beta));
        yaws.push(Math.abs((fd as unknown as { yawDyn: number }).yawDyn));
        if (betas.length >= 8) break;
      }
    }
    expect(hit).toBe(true);
    expect(fd.state.speed).toBeGreaterThan(1.5); // 未被撞墙骤降打出漂移层（driftActive 门限）
    expect(betas.filter((b) => b > 1e-4).length).toBeGreaterThanOrEqual(3); // 非一步硬清零
    expect(yaws.filter((y) => y > 1e-4).length).toBeGreaterThanOrEqual(3);
    expect(betas[betas.length - 1]).toBeLessThan(betas[0]); // 逐帧收敛
  });

  it('瞬态包络：撞墙后 roll 出现可见瞬态并随包络指数衰减', () => {
    const fd = new FreeDrive({ start: { x: 10.5, z: IMPACT_Z, heading: HEADING_TO_PLUS_X } });
    fd.state.speed = 20;
    let hit = false;
    let peakRoll = 0;
    for (let i = 0; i < 200; i += 1) {
      fd.step(DT);
      if (fd.state.x >= LIMIT - 1e-9) hit = true;
      if (hit) peakRoll = Math.max(peakRoll, Math.abs(fd.state.roll));
    }
    expect(hit).toBe(true);
    expect(peakRoll).toBeGreaterThan(0); // 撞击进得了视觉侧倾
    expect(Math.abs(fd.state.roll)).toBeLessThan(peakRoll); // 之后衰减回来
    expect(peakRoll).toBeLessThan(FREE.rollMaxRad); // 不超灵魂上限
  });
});

