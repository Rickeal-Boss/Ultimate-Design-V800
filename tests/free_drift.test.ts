/**
 * R36-P1 · 自由探索手刹漂移行为回归（仿真产物判据）。
 *
 * 验收（用户诉求「空格手刹漂移」+ 主理人 P 线契约）：
 *   ① 手刹入弯横摆角速度符号正确（与转向同号起步；漂移由轮胎侧偏/摩擦圆产生，
 *      不是贴动画 —— 断言动态量 beta/rearGrip 参与且连续演化）；
 *   ② 漂移纵向减速度**低于满刹**（摩擦圆把纵向让给侧向 ⇒ 速度衰减合理）；
 *   ③ 松开手刹 + 回正方向盘后**恢复抓地时间有限**（beta 归零、rearGrip 回 1）。
 *
 * 锁定契约隔离（不在本文件触碰）：主线普通制动 mech=min(demand,μg)、
 * decelPerNewton=ABS_MAX_DECEL/1612、限速只钳速、b=1.0 1.77s 断裂、路障 1300m。
 */
import { describe, expect, it } from 'vitest';
import { FreeDrive } from '../src/core/FreeDrive';
import { BRAKE } from '../src/config/physics';

const DT = 1 / 120;

/** 挂挡加速到 ≥ target m/s */
function accelerateTo(fd: FreeDrive, target: number, maxSteps = 600): number {
  fd.press('KeyW', true);
  let steps = 0;
  while (fd.snapshot().speed < target && steps < maxSteps) {
    fd.step(DT);
    steps += 1;
  }
  fd.press('KeyW', false);
  return steps;
}

describe('R36-P1 手刹漂移（仿真：轮胎侧偏 + 摩擦圆）', () => {
  it('手刹入弯：横摆角速度与转向同号起步，beta/rearGrip 参与演化', () => {
    const fd = new FreeDrive();
    accelerateTo(fd, 16);
    fd.press('Space', true);
    fd.press('KeyA', true); // 左转（steer 为正）
    let yawInit = 0;
    for (let i = 0; i < 60; i += 1) {
      fd.step(DT);
      const s = fd.snapshot();
      if (Math.abs(s.yawRate) > 0.05 && yawInit === 0) yawInit = s.yawRate;
    }
    const s = fd.snapshot();
    // ① 起步横摆与转向同号（左转 = 正 yaw，坐标约定见 FreeDrive 头注）
    expect(yawInit).toBeGreaterThan(0);
    expect(s.yawRate).toBeGreaterThan(0);
    // 仿真产物判据：后轴抓地被手刹收紧（≠1）、侧滑角已生长（≠0）
    expect(s.rearGrip).toBeLessThan(0.95);
    expect(Math.abs(s.beta)).toBeGreaterThan(0.01);
    fd.press('Space', false);
    fd.press('KeyA', false);
  });

  it('漂移纵向减速度低于满刹（摩擦圆让出侧向）', () => {
    const fd = new FreeDrive();
    accelerateTo(fd, 16);
    // 满刹基线：直线全力制动的减速度
    fd.press('KeyS', true);
    let brakeDecel = 0;
    for (let i = 0; i < 20; i += 1) {
      fd.step(DT);
      brakeDecel = Math.max(brakeDecel, -fd.snapshot().accel);
    }
    fd.press('KeyS', false);
    expect(brakeDecel).toBeGreaterThan(5); // 满刹确实有力（基线有效）

    // 手刹入弯漂移段的纵向减速度
    const fd2 = new FreeDrive();
    accelerateTo(fd2, 16);
    fd2.press('Space', true);
    fd2.press('KeyA', true);
    let driftDecel = 0;
    for (let i = 0; i < 40; i += 1) {
      fd2.step(DT);
      driftDecel = Math.max(driftDecel, -fd2.snapshot().accel);
    }
    // ② 漂移减速 < 满刹（留 15% 余量防数值抖动）
    expect(driftDecel).toBeLessThan(brakeDecel * 0.85);
    fd2.press('Space', false);
    fd2.press('KeyA', false);
  });

  it('松手刹 + 回正：恢复抓地时间有限（beta 塌缩、rearGrip 回 1）', () => {
    const fd = new FreeDrive();
    accelerateTo(fd, 16);
    fd.press('Space', true);
    fd.press('KeyA', true);
    for (let i = 0; i < 120; i += 1) fd.step(DT); // 漂 1s
    const betaStart = Math.abs(fd.snapshot().beta);
    expect(betaStart).toBeGreaterThan(0.02);

    // 松开手刹 + 回正方向盘
    fd.press('Space', false);
    fd.press('KeyA', false);
    let recoveredAt = -1;
    let betaHalfAt = -1;
    for (let i = 0; i < 360; i += 1) {
      // 回正期间继续给油保持车速（抓地恢复不依赖停车）
      fd.press('KeyW', true);
      fd.step(DT);
      const s = fd.snapshot();
      const betaAbs = Math.abs(s.beta);
      if (betaHalfAt < 0 && betaAbs < betaStart * 0.25) betaHalfAt = i;
      // 「恢复抓地」口径：侧滑角塌进 ±1.15° 且后轴抓地基本复原
      if (betaAbs < 0.02 && s.rearGrip > 0.97) {
        recoveredAt = i;
        break;
      }
    }
    // ③ 恢复抓地时间有限（≤3s）；2s 内 beta 已塌缩 ≥75%
    expect(recoveredAt).toBeGreaterThanOrEqual(0);
    expect(recoveredAt * DT).toBeLessThanOrEqual(3);
    expect(betaHalfAt).toBeGreaterThanOrEqual(0);
    expect(betaHalfAt * DT).toBeLessThanOrEqual(2);
  });

  it('反打方向可维持漂移（beta 有界、不甩尾失控）', () => {
    const fd = new FreeDrive();
    accelerateTo(fd, 16);
    fd.press('Space', true);
    fd.press('KeyA', true); // 入弯
    for (let i = 0; i < 40; i += 1) fd.step(DT);
    fd.press('KeyA', false);
    fd.press('KeyD', true); // 反打
    fd.press('KeyW', true); // 给油维持（真实漂移维持手法）
    let betaMax = 0;
    for (let i = 0; i < 160; i += 1) {
      fd.step(DT);
      betaMax = Math.max(betaMax, Math.abs(fd.snapshot().beta));
    }
    // 反打后侧滑角有界（< 35°，非原地打转）
    expect(betaMax).toBeLessThan(0.6);
    const s = fd.snapshot();
    expect(s.speed).toBeGreaterThan(5); // 漂移未把车速拖死
    fd.press('Space', false);
    fd.press('KeyD', false);
    fd.press('KeyW', false);
  });
});
