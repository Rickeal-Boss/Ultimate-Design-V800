/**
 * R104 · 撞墙「顿挫感」通道回归（真源派生，纯 FreeDrive.step 数值断言）。
 *
 * 主诉：R99~R101 把撞墙从单帧硬切改成一阶收敛后，速度与 heading **共用 τ=0.12 平行收敛**
 * ⇒ 速度收敛目标 r.speed 依赖随收敛递减的 fn ⇒ 目标漂移 ⇒ 正撞 20m/s 只掉 ~43%、摊在 0.2s
 * 里，撞墙瞬间看不到速度骤降；yaw 注入是「每帧速率项」且下一帧被 yawRateFor 整体覆盖
 * ⇒「被顶一下」不可见（详见 verify/r104_probe_impact.md）。
 *
 * 本轮只做两件事（探测报告 §4 推荐组合 ③+④），全部避开锁定红线（不改任何既有常量）：
 *   ③ 新增 WALL_IMPACT_HEADING_TAU（独立于 IMPACT_TAU，仅用于 step() 的 impactHeadingStep）：
 *      heading 收敛放慢 ⇒ 车头多指向墙 ⇒ fn=f·n 停留更大 ⇒ 撞后几帧持续刮擦减速（顿挫）；
 *      速度仍走 IMPACT_TAU 一阶（R99 防硬切成果保留）。
 *   ④ 新增 WALL_IMPACT_KICK_MS / WALL_IMPACT_KICK_MAX：yaw 注入从「每帧速率项」改为
 *      「一次性短冲量」——撞墙帧记 wallKick=min(wallImpact, KICK_MAX)，在 KICK_MS 窗口内
 *      每帧分摊 wallKick·(dt/KICK_MS) 加到 yawRate，窗口走完即放完（不再被每帧覆盖）。
 *
 * 采样点 z=−250（御桥段，车心限恒定 10.997），避开块角 dc<3 过渡区（与 r99/r101 同口径）。
 */
import { describe, expect, it } from 'vitest';
import {
  FREE,
  FreeDrive,
  IMPACT_TAU,
  WALL_IMPACT_HEADING_TAU,
  WALL_IMPACT_KICK_MAX,
  WALL_IMPACT_KICK_MS,
  corridorCenterHalfWidth,
  forwardOf,
  impactHeadingStep,
  resolveBounds
} from '../src/core/FreeDrive';

const DT = 1 / 120;
const IMPACT_Z = -250; // 桥段，limits 恒定，避开块角
const LIMIT = corridorCenterHalfWidth(IMPACT_Z); // 10.997
const HEAD_ON = -Math.PI / 2; // forward.x = −sin(−π/2) = +1 ⇒ 正撞 +X 侧墙（fn=1）

/** 把车开到贴 +X 侧墙（正撞），返回「撞墙当帧」已 step 完的 FreeDrive（松油门）。 */
function driveHeadOn(speed: number): FreeDrive {
  const fd = new FreeDrive({ start: { x: LIMIT - 2, z: IMPACT_Z, heading: HEAD_ON } });
  fd.state.speed = speed;
  let hit = false;
  for (let i = 0; i < 400 && !hit; i += 1) {
    fd.step(DT);
    if (fd.state.x >= LIMIT - 1e-9) hit = true;
  }
  expect(hit).toBe(true);
  return fd;
}

/**
 * 参照模型：撞墙后「速度 + heading 解耦一阶收敛」（**不含** scrub / 阻力 / 油门），
 * 用真源纯函数 impactHeadingStep + resolveBounds 复现耦合，用于隔离 ③「heading-τ 放慢」
 * 对 fn 停留 / 速度损失的影响。给定 heading 收敛 τ，返回 secs 秒后的速度。
 * 速度仍按 IMPACT_TAU 一阶收敛（与 step() 的 damp(...,1/IMPACT_TAU,dt) 同口径）。
 */
function refSpeed(tauHead: number, v0: number, secs: number): number {
  const targetH = resolveBounds(LIMIT + 5, IMPACT_Z, HEAD_ON, v0).targetHeading!;
  let h = HEAD_ON;
  let v = v0;
  const n = Math.round(secs / DT);
  for (let i = 0; i < n; i += 1) {
    h = impactHeadingStep(h, targetH, tauHead, DT);
    // 真源分解：当前 h/v 下「法向吸收 + 切向保留」的目标速，再按 IMPACT_TAU 一阶收敛
    const tgt = resolveBounds(LIMIT + 5, IMPACT_Z, h, v).speed;
    v += (tgt - v) * (1 - Math.exp(-DT / IMPACT_TAU));
  }
  return v;
}

describe('R104 ① 撞墙域常量（③④ 新增，独立于 IMPACT_* 且不改既有值）', () => {
  it('WALL_IMPACT_HEADING_TAU > IMPACT_TAU（heading 慢于速度收敛）；KICK 常量为正', () => {
    expect(WALL_IMPACT_HEADING_TAU).toBeGreaterThan(IMPACT_TAU);
    expect(WALL_IMPACT_KICK_MS).toBeGreaterThan(0);
    expect(WALL_IMPACT_KICK_MAX).toBeGreaterThan(0);
  });
});

describe('R104 ② 正撞顿挫（③ 放慢 heading 收敛 ⇒ fn 停留 ⇒ 更多刮擦掉速）', () => {
  it('隔离机制：同 v0=20 正撞，WALL_IMPACT_HEADING_TAU 的 0.2s 掉速明显大于旧 IMPACT_TAU 参照', () => {
    const v0 = 20;
    const slow = refSpeed(WALL_IMPACT_HEADING_TAU, v0, 0.2); // 实际 ③
    const fast = refSpeed(IMPACT_TAU, v0, 0.2); // 旧 τ 参照
    // 放慢 heading ⇒ 车头更久指向墙 ⇒ fn 更大 ⇒ 目标速更低 ⇒ 0.2s 掉速更多
    expect(slow).toBeLessThan(fast);
    // 差距可观（顿挫感来源）：慢 τ 相对快 τ 多掉一段速度
    expect(fast - slow).toBeGreaterThan(0.5);
    // 且慢 τ 确实掉了一大截（不是几乎不掉）
    expect(v0 - slow).toBeGreaterThan(v0 * 0.4);
  });

  it('实车正撞 0.2s 速度损失超过旧 IMPACT_TAU 参照（顿挫，含刮擦叠加）', () => {
    const v0 = 20;
    const fast = refSpeed(IMPACT_TAU, v0, 0.2);
    const fd = driveHeadOn(v0);
    const vImpact = Math.abs(fd.state.speed);
    for (let i = 0; i < 24; i += 1) fd.step(DT); // 撞墙后再走 0.2s
    const vAfter = Math.abs(fd.state.speed);
    // 实际掉速（慢 heading + R106 首帧顿挫 + scrub 叠加）严格大于旧 τ 纯耦合参照
    expect(v0 - vAfter).toBeGreaterThan(v0 - fast);
    expect(vAfter).toBeLessThan(fast);
    // R106 撞墙首帧法向速度骤降：正撞当帧从旧 ~18.77 降到 ~10.78（首帧掉速 ~46%，顿挫）。
    // R108 比例 0.4→0.7（用户要求更硬撞击/硬切感）⇒ 0.2s 后速度 ~4.79（掉速更多，顿挫更强）。
    // 仍远高于 0 ⇒ R99 防瞬移保留（不归零）；阈值随新手感从 >10 重钉到 >4（真源：非零即防瞬移）。
    expect(vImpact).toBeGreaterThan(4);
  });
});

describe('R104 ③ 防硬切（保留 R99 一阶收敛成果）', () => {
  it('正撞当帧速度不归零、不瞬移（R108 放宽「不腰斩」→ 硬切感，但仍非归零/非瞬移）', () => {
    const fd = driveHeadOn(20);
    const vImpact = Math.abs(fd.state.speed);
    // R108 首帧顿挫：正撞当帧 ~6（首帧掉速 ~70%，用户要求硬切感），仍远高于 0 ⇒ 不归零、非瞬移。
    // R99「不腰斩（首帧 <50% 掉速）」原为防瞬移，但用户显式要求更硬撞击 ⇒ 放宽「不腰斩」、
    //   保留「不归零/不瞬移」红线。阈值随新手感从 >10 重钉到 >4（真源：非零即防瞬移）。
    expect(vImpact).toBeGreaterThan(4); // 当帧仍高（旧单帧硬切会掉到分解值 2.0 或归零）
    let framesToHalf = -1;
    for (let i = 0; i < 120; i += 1) {
      fd.step(DT);
      const cur = Math.abs(fd.state.speed);
      expect(cur).toBeGreaterThanOrEqual(0); // 沿墙滑行不反向
      if (framesToHalf < 0 && cur <= vImpact / 2) framesToHalf = i + 1;
    }
    expect(framesToHalf).toBeGreaterThan(3); // 多帧才腰斩 ⇒ 一阶收敛，非单帧硬切
  });
});

describe('R104 ④ yaw 一次性短冲量（区别于旧的每帧速率项）', () => {
  it('撞墙后 KICK_MS 窗口内获得一次性可见横摆冲量，窗口走完即回落（不再持续累加）', () => {
    const fd = driveHeadOn(20);
    const winFrames = Math.round(WALL_IMPACT_KICK_MS / DT);
    // 撞墙当帧已注入首帧冲量；逐帧记录 |yawRate|（无转向输入 ⇒ yawRateFor=0，只剩冲量）
    const yaw: number[] = [Math.abs(fd.state.yawRate)];
    for (let i = 0; i < 119; i += 1) {
      fd.step(DT);
      yaw.push(Math.abs(fd.state.yawRate));
    }
    const inWin = yaw.slice(0, winFrames);
    const peakWin = Math.max(...inWin);
    // 窗口内：冲量可见（≈wallKick 每帧分摊量量级），且被 clamp 收在灵魂上限内
    expect(peakWin).toBeGreaterThan(0.04); // 可见的「被顶一下」（旧速率项仅 ≈0.028 且被覆盖）
    expect(peakWin).toBeLessThanOrEqual(FREE.maxYawRate + 1e-12);
    // 窗口后：冲量放完即止，横摆回落到远低于窗口峰（区别于速率项的持续注入）
    const afterWin = yaw.slice(winFrames + 6);
    const peakAfter = Math.max(...afterWin);
    expect(peakAfter).toBeLessThan(peakWin * 0.4);
  });
});
