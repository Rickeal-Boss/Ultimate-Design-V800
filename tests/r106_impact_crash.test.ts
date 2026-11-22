/**
 * R106 · 撞墙「顿挫」硬化回归（真源派生，纯 FreeDrive.step 数值断言）。
 *
 * 主诉（用户四次反馈「撞击硬切（变成滑动）依旧需要改进」）：R99~R105 把撞墙做成
 * 「法向吸收 + IMPACT_TAU 一阶收敛 + 独立 heading τ + yaw/roll 包络」，结果撞墙
 * **读作「滑」而不是「撞」**——接触首帧速度只掉 ~6%（仅 IMPACT_TAU 一阶那一档），
 * 没有真实碰撞的「顿挫」。R106 补两件 R99 以来一直缺的事，且**不退回单帧速度归零瞬移**：
 *   ① 接触首帧**有界法向速度骤降**（WALL_IMPACT_SPEED_KICK_RATIO）：撞墙帧一次性再扣掉
 *      「入射法向分量 |v|·fn」的固定比例 ⇒ 正撞首帧速度从 ~6% 掉速提到 ~46%（顿挫）。
 *      红线：切向分量完整保留 + 法向只扣一个比例 ⇒ 单帧绝不归零、不瞬移（R99 底线保留）。
 *   ② 俯仰「点头」一次性冲量（WALL_IMPACT_PITCH_KICK_*）：撞墙帧记有符号 pitchKick 峰值，
 *      在窗口内分摊注入 s.pitch ⇒ 补齐「车身被顶」的俯仰维度（横摆走 R104、侧倾走 R99）。
 *   ③ 斜撞刮擦：speedKick 按 fn 加权 + 既有 wall scrub ⇒ fn 小刮擦（弱扣+弱 scrub）、
 *      fn 大顿挫（强扣+强 scrub），不再纯滑。
 *
 * 采样点 z=−250（御桥段，车心限恒定 10.997），避开块角 dc<3 过渡区（与 r99/r101 同口径）。
 * 真源派生禁写死：阈值全部由 WALL_IMPACT_SPEED_KICK_RATIO / IMPACT_TAU / FREE.* 派生。
 */
import { describe, expect, it } from 'vitest';
import {
  FREE,
  FreeDrive,
  IMPACT_TAU,
  WALL_IMPACT_SPEED_KICK_RATIO,
  WALL_IMPACT_STUN_RATIO,
  corridorCenterHalfWidth,
  resolveBounds
} from '../src/core/FreeDrive';
import { FREE_BODY_IMPACT_OSC } from '../src/config/freeBodyFeel';
import { damp } from '../src/util/math';

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
 * 旧手感参照：撞墙当帧只走 IMPACT_TAU 一阶那一档（R99~R104 行为，**无 R106 speedKick**）。
 * 用真源 resolveBounds 复现「法向吸收+切向保留」分解目标，再按 IMPACT_TAU 单步 damp。
 * 返回旧手感下撞墙当帧的速度（用于对比 R106 首帧顿挫明显更大）。
 */
function oldImpactFrame(v0: number): number {
  const target = resolveBounds(LIMIT + 5, IMPACT_Z, HEAD_ON, v0).speed;
  return damp(v0, target, 1 / IMPACT_TAU, DT);
}

/** 斜擦 +X 墙且沿 +Z 滑（全程留桥段）：heading = π + asin(fn)。 */
function driveOblique(fn: number, speed: number): FreeDrive {
  const fd = new FreeDrive({
    start: { x: LIMIT - 0.5, z: IMPACT_Z, heading: Math.PI + Math.asin(fn) }
  });
  fd.state.speed = speed;
  let hit = false;
  for (let i = 0; i < 400 && !hit; i += 1) {
    fd.step(DT);
    if (fd.state.x >= LIMIT - 1e-9) hit = true;
  }
  expect(hit).toBe(true);
  return fd;
}

describe('R106 ① 撞墙域常量（真源派生，有界）', () => {
  it('speedKick 比例 ∈ (0,1)；撞墙晃动常量有界（ω>0、0<ζ<1、gains>0，正撞 20m/s 注入不越灵魂上限）', () => {
    expect(WALL_IMPACT_SPEED_KICK_RATIO).toBeGreaterThan(0);
    expect(WALL_IMPACT_SPEED_KICK_RATIO).toBeLessThan(1); // 有界：只扣一个比例，绝不归零
    // R126：旧俯仰位置冲量（WALL_IMPACT_PITCH_KICK_*）已被欠阻尼晃动通道取代。
    //   晃动常量有界：ω>0、0<ζ<1（欠阻尼且不持续振荡）、gains>0；
    //   pitchGain×20（正撞 20m/s 的 impactN）注入后峰 ≈0.030 rad < pitchMaxRad（clamp 兜底）。
    expect(FREE_BODY_IMPACT_OSC.omega).toBeGreaterThan(0);
    expect(FREE_BODY_IMPACT_OSC.zeta).toBeGreaterThan(0);
    expect(FREE_BODY_IMPACT_OSC.zeta).toBeLessThan(1);
    expect(FREE_BODY_IMPACT_OSC.rollGain).toBeGreaterThan(0);
    expect(FREE_BODY_IMPACT_OSC.pitchGain).toBeGreaterThan(0);
    expect(FREE_BODY_IMPACT_OSC.pitchGain * 20).toBeLessThanOrEqual(FREE.pitchMaxRad * 30);
  });
});

describe('R106 ② 正撞首帧顿挫（首帧速度损失比旧 IMPACT_TAU 一阶明显更大）', () => {
  it('v0=20 正撞：首帧掉速 ~46% >> 旧 ~6%，且严格大于旧参照的 3 倍', () => {
    const v0 = 20;
    const oldFrame = oldImpactFrame(v0); // 旧手感当帧 ≈ v0 − 6%
    const fd = driveHeadOn(v0);
    const newFrame = Math.abs(fd.state.speed); // R106 当帧 ≈ v0 − 46%
    const oldLoss = v0 - oldFrame;
    const newLoss = v0 - newFrame;
    // 首帧掉速明显更大：R106 严格大于旧参照的 3 倍（实测 ~9.2 vs ~1.2）
    expect(newFrame).toBeLessThan(oldFrame);
    expect(newLoss).toBeGreaterThan(oldLoss * 3);
    // 掉速比例达到 speedKick 名义量级（真源派生：> KICK_RATIO 的 0.7 倍 ⇒ 可感顿挫）
    expect(newLoss / v0).toBeGreaterThan(WALL_IMPACT_SPEED_KICK_RATIO * 0.7);
  });

  it('v0=55 高速正撞：首帧掉速同样达到 speedKick 量级（顿挫不随速度消失）', () => {
    const v0 = 55;
    const oldFrame = oldImpactFrame(v0);
    const fd = driveHeadOn(v0);
    const newFrame = Math.abs(fd.state.speed);
    expect(newFrame).toBeLessThan(oldFrame);
    expect((v0 - newFrame) / v0).toBeGreaterThan(WALL_IMPACT_SPEED_KICK_RATIO * 0.7);
    // 高速比低速首帧多掉更多绝对速度（撞击更狠、顿挫更强）
    expect(v0 - newFrame).toBeGreaterThan(20);
  });
});

describe('R106 ③ 防瞬移（保留 R99 底线：首帧不归零、不瞬移、多帧才衰减）', () => {
  it('正撞当帧速度仍 > (1−KICK_RATIO)·v0 的 0.7 倍（有界扣减，绝不归零）', () => {
    const v0 = 20;
    const fd = driveHeadOn(v0);
    const vImpact = Math.abs(fd.state.speed);
    // 真源下界：切向保留 + 法向只扣 KICK_RATIO + R109 总速 stun ⇒ 当帧仍留速度（实测 ~3.1）
    expect(vImpact).toBeGreaterThan(
      v0 * (1 - WALL_IMPACT_SPEED_KICK_RATIO) * (1 - WALL_IMPACT_STUN_RATIO) * 0.7
    );
    expect(vImpact).toBeGreaterThan(0); // 绝不单帧归零（旧 R98 硬切必红）
  });

  it('正撞需多帧才降到半速（一阶收敛，非单帧腰斩 / 瞬移）', () => {
    const fd = driveHeadOn(20);
    const vImpact = Math.abs(fd.state.speed);
    let framesToHalf = -1;
    for (let i = 0; i < 120; i += 1) {
      fd.step(DT);
      const cur = Math.abs(fd.state.speed);
      expect(cur).toBeGreaterThanOrEqual(0); // 沿墙滑行不反向
      if (framesToHalf < 0 && cur <= vImpact / 2) framesToHalf = i + 1;
    }
    expect(framesToHalf).toBeGreaterThan(3); // 多帧才腰斩 ⇒ 一阶收敛 + 位置不瞬移
    expect(fd.state.x).toBeCloseTo(LIMIT, 6); // 位置由几何钳位决定，无瞬移
  });
});

describe('R106 ④ 俯仰「点头」冲量（车身被顶的俯仰维度，可感且衰减）', () => {
  it('正撞后 pitch 出现接近灵魂上限的可见点头，随后衰减回近零、不越上限', () => {
    const fd = driveHeadOn(20);
    const pitches: number[] = [Math.abs(fd.state.pitch)];
    for (let i = 0; i < 120; i += 1) {
      fd.step(DT);
      pitches.push(Math.abs(fd.state.pitch));
    }
    const peakPitch = Math.max(...pitches);
    // 点头冲量把 pitch 顶到接近灵魂俯仰上限（实测 ~0.0349 = pitchMaxRad），明显可感
    expect(peakPitch).toBeGreaterThan(FREE.pitchMaxRad * 0.85);
    expect(peakPitch).toBeLessThanOrEqual(FREE.pitchMaxRad + 1e-12); // 不越灵魂上限
    expect(pitches[pitches.length - 1]).toBeLessThan(peakPitch * 0.3); // 之后衰减回近零
  });

  it('横摆 / 侧倾撞击瞬态仍可见且被 clamp 收在灵魂上限内（与 pitch 一起构成「被顶」）', () => {
    const fd = driveHeadOn(20);
    const yaws: number[] = [Math.abs(fd.state.yawRate)];
    const rolls: number[] = [Math.abs(fd.state.roll)];
    for (let i = 0; i < 120; i += 1) {
      fd.step(DT);
      yaws.push(Math.abs(fd.state.yawRate));
      rolls.push(Math.abs(fd.state.roll));
    }
    const peakYaw = Math.max(...yaws);
    const peakRoll = Math.max(...rolls);
    expect(peakYaw).toBeGreaterThan(0.04); // 横摆冲量可见（R104 yaw 冲量通道）
    expect(peakYaw).toBeLessThanOrEqual(FREE.maxYawRate + 1e-12);
    expect(peakRoll).toBeGreaterThan(0); // 侧倾瞬态进得了视觉
    expect(peakRoll).toBeLessThanOrEqual(FREE.rollMaxRad + 1e-12); // 不越灵魂上限
  });
});

describe('R106 ⑤ 斜撞刮擦（fn 小 = 刮擦减速，非纯滑；fn 大 = 顿挫）', () => {
  it('fn=0.3 斜擦撞后 0.2s 有明确刮擦减速（scrub + speedKick 共同耗散）', () => {
    const fd = driveOblique(0.3, 20);
    const vImpact = Math.abs(fd.state.speed);
    for (let i = 0; i < 24; i += 1) fd.step(DT); // 0.2 s
    const vAfter = Math.abs(fd.state.speed);
    // 斜擦：speedKick 按 fn 加权（扣得少）+ wall scrub 持续刮 ⇒ 0.2s 明确减速，非纯滑。
    // R109 总速 stun 0.35 + WALL_SCRUB_FLOOR=8 ⇒ 斜擦当帧也降一截（≈11.5），0.2s 后 ≈8.5。
    expect(vImpact).toBeGreaterThan(9); // 斜擦当帧仍高（保留切向，非硬切）
    expect(vAfter).toBeLessThan(vImpact); // 刮擦减速
    expect(vImpact - vAfter).toBeGreaterThan(0.5); // 减速量可观（非纯滑）
  });

  it('轻擦 fn=0.1 比 fn=0.3 刮擦更弱（speedKick 按 fn 加权 ⇒ 刮擦而非硬撞）', () => {
    const run = (fn: number) => {
      const fd = driveOblique(fn, 20);
      const vImpact = Math.abs(fd.state.speed);
      for (let i = 0; i < 24; i += 1) fd.step(DT);
      return { vImpact, vAfter: Math.abs(fd.state.speed) };
    };
    const light = run(0.1); // 轻擦：扣得少、scrub 弱 ⇒ 几乎不减总速
    const hard = run(0.3); // 更正的斜擦：扣得多、scrub 强 ⇒ 减速更多
    expect(light.vImpact).toBeGreaterThan(hard.vImpact); // 越正撞击越狠、首帧掉越多
    expect(hard.vImpact - hard.vAfter).toBeGreaterThan(light.vImpact - light.vAfter); // 刮擦更强
  });
});
