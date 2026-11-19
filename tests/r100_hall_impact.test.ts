/**
 * R100 Phase2 · 撞主殿（hall）瞬态回归（物理侧，不与几何/bounds 侧抢文件）。
 *
 * 契约（审查团 §2.2 四条打回触发逐条钉死）：
 *   - hall 正撞仍 speed:0 彻底停 + z 弹 0.8m（1300m 路障 /「一次性停」语义不变）；
 *   - 姿态复用 R99 wallImpact 包络：impactN=|v| 注入 → yawRate/roll 短暂「被顶一下」、
 *     beta/yawDyn 按 IMPACT_TAU 一阶收敛（非瞬时清零）；
 *   - 不写 car.body.rotation、不接 crashWorld、不改 zMin/hallBounce/hallHalfW、
 *     不触发二次 hall 抖动；challenge 模式 crash 演出一行不碰。
 */
import { describe, expect, it } from 'vitest';
import { BOUNDS, FREE, FreeDrive, IMPACT_TAU, resolveBounds } from '../src/core/FreeDrive';

const DT = 1 / 120;
/** 撞后车心 z 落点（BOUNDS.zMin + hallBounce = −1296.2） */
const HALL_REST_Z = BOUNDS.zMin + BOUNDS.hallBounce;

/** teleport 会清零漂移态，必须在摆位之后注入 */
function injectDrift(fd: FreeDrive, vy: number, yawDyn: number): void {
  (fd as unknown as { vy: number }).vy = vy;
  (fd as unknown as { yawDyn: number }).yawDyn = yawDyn;
  fd.state.beta = Math.atan2(vy, Math.abs(fd.state.speed));
}

describe('R100 hall ① resolveBounds 纯函数：impactN=|v|、speed 仍 0、无 targetHeading', () => {
  it('正撞 hall：impactN=|v|、speed=0、z=zMin+0.8、heading 原样、targetHeading undefined', () => {
    const r = resolveBounds(0, BOUNDS.zMin, 0, 20);
    expect(r.kind).toBe('hall');
    expect(r.speed).toBe(0);
    expect(r.x).toBe(0);
    expect(r.z).toBeCloseTo(HALL_REST_Z, 12);
    expect(r.heading).toBeCloseTo(0, 12);
    expect(r.impactN).toBeCloseTo(20, 12);
    expect(r.targetHeading).toBeUndefined(); // 不二次撞击：heading 不被收敛到切向
  });

  it('impactN 随 |v| 线性；z 弹开 / speed 归零 / heading 原样与入射强度无关', () => {
    for (const v of [0, 1, 7.5, 20, 55, -8]) {
      const r = resolveBounds(3, BOUNDS.zMin - 0.2, 0.3, v);
      expect(r.kind).toBe('hall');
      expect(r.impactN).toBeCloseTo(Math.abs(v), 12);
      expect(r.speed).toBe(0);
      expect(r.z).toBeCloseTo(HALL_REST_Z, 12);
      expect(r.x).toBe(3);
      expect(r.heading).toBeCloseTo(0.3, 12);
      expect(r.targetHeading).toBeUndefined();
    }
  });

  it('hall 契约锚冻结：hallHalfW 外侧不误判；zMin / hallBounce / hallHalfW 逐位不变', () => {
    expect(resolveBounds(BOUNDS.hallHalfW + 1, BOUNDS.zMin, 0, 20).kind).not.toBe('hall');
    expect(BOUNDS.zMin).toBe(-1297);
    expect(BOUNDS.hallBounce).toBeCloseTo(0.8, 12);
    expect(BOUNDS.hallHalfW).toBe(24);
  });
});

describe('R100 hall ② 集成：speed=0 彻底停、无二次 hall、heading 不偏', () => {
  it('撞主殿后 hall 事件仅一次，speed 恒 0，z 停在弹开点，滑行 7s 不再触发', () => {
    const fd = new FreeDrive({ start: { x: 0, z: -1250, heading: 0 } });
    fd.state.speed = 25;
    let hallHits = 0;
    fd.onEvent = (e) => {
      if (e === 'hall') hallHits += 1;
    };
    for (let i = 0; i < 900; i += 1) fd.step(DT); // 7.5s ≈ 4.7×hallCd

    expect(hallHits).toBe(1); // 一次性停，包络瞬态不引入二次撞击
    const s = fd.snapshot();
    expect(s.speed).toBe(0);
    expect(s.z).toBeCloseTo(HALL_REST_Z, 9);
    expect(s.heading).toBeCloseTo(0, 12); // 无 targetHeading ⇒ 不收敛、不二次撞击
    expect(s.x).toBeCloseTo(0, 12);
  });
});

describe('R100 hall ③ beta / yawDyn 一阶收敛（非一帧清零）', () => {
  it('hall 帧对 beta/yawDyn 只走 exp(-dt/IMPACT_TAU) 比例，而非瞬时归零', () => {
    // 对照实验：同初速 / 同注入侧滑，一发撞主殿（hit），一发不撞（free，z 远）。
    // 碰撞前的纵向力与侧偏动力学完全同构（x=0 无侧墙），唯一差异是 hall 写回的一阶衰减。
    const runOneStep = (z: number) => {
      const fd = new FreeDrive({ start: { x: 0, z, heading: 0 } });
      fd.state.speed = 20;
      injectDrift(fd, 2, 0.2);
      fd.step(DT);
      return {
        beta: Math.abs(fd.state.beta),
        yaw: Math.abs((fd as unknown as { yawDyn: number }).yawDyn),
        speed: fd.state.speed
      };
    };
    const hit = runOneStep(BOUNDS.zMin + 0.05); // 一步内越过 zMin ⇒ kind='hall'
    const free = runOneStep(-1250); // 同初态但不撞

    expect(free.beta).toBeGreaterThan(0.01);
    expect(free.yaw).toBeGreaterThan(0.01);
    expect(hit.speed).toBe(0); // 速度契约：仍然彻底停
    // 一阶衰减比例 = exp(-dt/tau)，残留 > 0（旧实现 speed<1.5 退出漂移层瞬时清零必红）
    const keep = Math.exp(-DT / IMPACT_TAU);
    expect(hit.beta).toBeCloseTo(free.beta * keep, 6);
    expect(hit.yaw).toBeCloseTo(free.yaw * keep, 6);
    expect(hit.beta).toBeGreaterThan(0);
    expect(hit.yaw).toBeGreaterThan(0);
  });
});

describe('R100 hall ④ 姿态瞬态：yawRate / roll 被顶一下后指数衰减', () => {
  it('撞主殿后 yawRate/roll 出现非零冲击瞬态，随后衰减回近零且不超灵魂幅值上限', () => {
    const fd = new FreeDrive({ start: { x: 0, z: -1250, heading: 0 } });
    fd.state.speed = 25;
    let hallHits = 0;
    fd.onEvent = (e) => {
      if (e === 'hall') hallHits += 1;
    };
    const yawTrace: number[] = [];
    const rollTrace: number[] = [];
    for (let i = 0; i < 500; i += 1) {
      fd.step(DT);
      if (hallHits > 0) {
        yawTrace.push(Math.abs(fd.snapshot().yawRate));
        rollTrace.push(Math.abs(fd.snapshot().roll));
      }
    }
    expect(hallHits).toBeGreaterThan(0);
    expect(yawTrace.length).toBeGreaterThan(60); // 撞击后有足够观察窗
    const peakYaw = Math.max(...yawTrace);
    const peakRoll = Math.max(...rollTrace);
    expect(peakYaw).toBeGreaterThan(0); // 瞬态进得了视觉横摆
    expect(peakRoll).toBeGreaterThan(0); // 瞬态进得了视觉侧倾
    expect(yawTrace[yawTrace.length - 1]).toBeLessThan(peakYaw * 0.1); // 指数衰减
    expect(rollTrace[rollTrace.length - 1]).toBeLessThan(peakRoll * 0.1);
    expect(peakRoll).toBeLessThan(FREE.rollMaxRad); // 灵魂 12 参数幅值上限不动
  });
});
