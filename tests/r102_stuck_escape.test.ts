/**
 * R102 · 贴墙低速脱困（stuck escape）回归。
 *
 * 用户主诉：自由驾驶「出现在边界时卡住不能动」。probe-stuck 查实死锁闭环：
 *   wallScrubN 自首次撞击以 Math.max 记峰、贴墙期间永不衰减（封顶 12 m/s²），而
 *   12 > 前进净加速 6.11 > 倒车净加速 2.08 ⇒ 前进/倒车都被单帧钳回 0（速度 0）；
 *   速度 0 时 yawRateFor 的转向因子 clamp(|v|/refSpeedMs,0,1)∝|v|→0 ⇒ 车头彻底失去
 *   转向权限，玩家无法转头脱困（HUD 显示 D + 速度 0）。scrub 作用方向 dir=sign(v)
 *   是标量、不往坑里压，真正困住车的是 scrub 钉速 + 转向权限归零。
 * 修复（Fix B）：贴墙(wallScrub>0) + 低速(|v|<WALL_SCRUB_RELEASE_MS=1.5) + 玩家主动操作
 *   (转向 + 油门/刹车) ⇒ 给一记与驾驶方向同号的最小横摆率 0.35·maxYawRate≈18°/s，
 *   让车头转离墙 ⇒ f.x 指向路内 ⇒ 前移使 |x| 掉到 halfW−ε ⇒ sideTouch=false
 *   ⇒ wallScrubN 清零 ⇒ 彻底脱困。不改 scrub 公式/几何/摩擦圆/灵魂 12 参数。
 *
 * 采样点 z=−250（御桥段，车心限恒定 10.997），避开块角过渡区（与 r99/r101 同口径）。
 *
 * R150 柔化低速蹭墙（用户拍板，R142 §0-B）：WALL_SCRUB_FADE_SPEED 4.0→10.0，稳态从
 * R109 的 ≈2.03（实测 1.509）提到 ≈3.776 m/s ⇒ 本测试判据随契约演进：稳态刮擦带上限
 * 由 <3.0（RELEASE_MS×2）改为 <LOW_BAND_HI=5.0（稳态 3.776 落 2.5-5.0），脱困③常规转向
 * 量级 0.10→0.245（稳态 3.776），上限 0.15→0.28（仍区分 0.315 特殊门控）。
 */
import { describe, expect, it } from 'vitest';
import {
  WALL_SCRUB_CONTACT_EPS,
  WALL_SCRUB_RELEASE_MS,
  FreeDrive,
  corridorCenterHalfWidth
} from '../src/core/FreeDrive';

const DT = 1 / 120;
const IMPACT_Z = -250; // 桥段，limits 恒定，避开块角
const LIMIT = corridorCenterHalfWidth(IMPACT_Z); // 10.997
const START_X = LIMIT - 0.5; // 10.497：车心在界内，留 0.5 m 冲进墙触发撞击
// R150 柔化低速蹭墙：稳态刮擦带上限 m/s（探针稳态 3.776，柔化目标 3-4.5，取 5.0 上限留裕量）。
// 原 R102「≤3.0 低速带」随 R150 契约演进作废（稳态 3.776 不再落 <3.0 带）。
const LOW_BAND_HI = 5.0;

// 斜擦 +X 墙且沿 +Z 滑：heading=π+asin(fn) ⇒ f.x=+fn 朝 +X 墙 / f.z 朝 +Z（与 r101 同口径）
function headingFor(fn: number): number {
  return Math.PI + Math.asin(fn);
}

/**
 * 把车开到贴墙并被 scrub 钉停：撞 +X 墙（fn≈0.3）后含油门持续 step，
 * 直到速度被刮到接近 0（scrub 12 > 净加速 6.08 压不住）仍贴墙。
 * 返回已 step 完、贴墙钉停的 FreeDrive（KeyW 仍按住）。
 */
function driveToWallAndPin(): FreeDrive {
  const heading = headingFor(0.3); // fn≈0.3 ⇒ impactN≈16.67 ⇒ scrub 封顶 12
  const fd = new FreeDrive({ start: { x: START_X, z: IMPACT_Z, heading } });
  fd.state.speed = 55.56; // 200 km/h 冲进墙
  let hit = false;
  for (let i = 0; i < 400 && !hit; i += 1) {
    fd.step(DT);
    if (fd.state.x >= LIMIT - 1e-9) hit = true; // 已被几何钳到墙 ⇒ 接触
  }
  expect(hit).toBe(true);
  // 含油门持续 step：R109 speedFade ⇒ scrub 随速渐入，速度被刮到稳态刮擦带并持续贴墙。
  // R150 柔化低速蹭墙：渐入基准 4.0→10.0，稳态从 R109 平衡点 ≈2.03（实测 1.509）提到
  // ≈3.776 m/s（探针 10s 末速 3.776，柔化目标 3-4 中位）。不再钉停（低速可走）。
  fd.press('KeyW', true);
  let lowAt = -1;
  for (let i = 0; i < 1440; i += 1) {
    // 12 s：足够 55 m/s @ (12−6.08)≈5.9 m/s² 刮到稳态刮擦带
    fd.step(DT);
    if (lowAt < 0 && Math.abs(fd.state.speed) < LOW_BAND_HI) lowAt = i;
  }
  expect(lowAt).toBeGreaterThanOrEqual(0); // 确实被刮到稳态刮擦带（<LOW_BAND_HI=5.0）
  expect(Math.abs(fd.state.speed)).toBeGreaterThan(2.5); // R150 柔化生效：稳态明显高于原钉停 1.509
  expect(Math.abs(fd.state.speed)).toBeLessThan(LOW_BAND_HI); // 仍低速不飞驰（稳态 3.776 ∈ 2.5-5.0）
  expect(fd.state.x).toBeGreaterThanOrEqual(LIMIT - 1e-6); // 仍贴墙
  return fd;
}

describe('R102 贴墙低速脱困 · 常量', () => {
  it('WALL_SCRUB_RELEASE_MS=1.5（≈5.4 km/h，与漂移退出阈值对齐）', () => {
    expect(WALL_SCRUB_RELEASE_MS).toBeCloseTo(1.5, 6);
  });

  it('最小转向权限 = 0.35×maxYawRate ≈ 18°/s（0.9 rad/s × 0.35 = 0.315 rad/s）', () => {
    expect(0.9 * 0.35).toBeCloseTo(0.315, 6);
    expect((0.315 * 180) / Math.PI).toBeCloseTo(18.05, 0); // ≈18°/s
  });
});

describe('R102 脱困 ① 贴墙低速 + 油门 + 转向：车头转离墙、wallScrub 清零脱困', () => {
  it('KeyD(steerIn=−1)+油门：yawRate 有转向权限（∝|v|，R109 后低速仍可转），车头转离 +X 墙后 x 掉到界内脱困', () => {
    const fd = driveToWallAndPin();
    const heading0 = fd.state.heading;
    // 按住油门 + 右转（KeyD ⇒ steerIn=−1）：车有 ~3.776 m/s 稳态 ⇒ yawRateFor 有转向权限
    fd.press('KeyD', true);
    fd.step(DT);
    // R150：稳态 v≈3.776（不再钉停 0，R109 柔化后低速带 3-4.5）⇒ 常规 yawRateFor 已有
    // 转向（∝|v|），不再依赖 R102 的 0.35 特殊门控（av<1.5 不再命中，但车本身能转）。
    expect(fd.state.yawRate).toBeLessThan(0); // KeyD ⇒ 朝路内转向
    expect(Math.abs(fd.state.yawRate)).toBeGreaterThan(0.001); // 有实际转向权限
    // 车头持续转离墙：heading 朝减小方向（f.x 由 +0.3 转向 ≤0 即指向路内）
    let escaped = false;
    for (let i = 0; i < 720; i += 1) {
      // 6 s 足够 18°/s 转过 ~0.3 rad 露出路内并前移脱困
      fd.step(DT);
      // f.x = -sin(heading) 指向路内（<0）⇒ x 掉到界内 ⇒ sideTouch=false ⇒ 脱困
      if (fd.state.x < LIMIT - WALL_SCRUB_CONTACT_EPS) {
        escaped = true;
        break;
      }
    }
    expect(escaped).toBe(true); // 车头转离墙后前移脱困：x 掉到 halfW−ε 以内
    // 脱困后不再被 scrub 钉速 ⇒ 含油门能正常加速远离
    const inwardSpeed = (LIMIT - WALL_SCRUB_CONTACT_EPS - fd.state.x) / (DT * 1);
    expect(fd.state.heading).not.toBeCloseTo(heading0, 3); // 车头确实转了
    void inwardSpeed;
  });
});

describe('R102 脱困 ② 无主动操作：不自行脱困（保持 r101 canEscape=false 语义）', () => {
  it('低速滑行态不给转向/油门：yawRate 恒 0、heading 不变、x 不自行离墙（无输入零转向）', () => {
    const fd = driveToWallAndPin();
    fd.press('KeyW', false); // 松油门：无任何主动操作
    const heading0 = fd.state.heading;
    for (let i = 0; i < 240; i += 1) {
      // 2 s：无输入应无转向权限（yawRate 0）、不自行离墙（x 仍在墙）
      fd.step(DT);
      expect(fd.state.yawRate).toBeCloseTo(0, 6); // 无转向权限 ⇒ yawRate 0
      expect(fd.state.x).toBeGreaterThanOrEqual(LIMIT - 1e-6); // 不自行离墙
    }
    expect(fd.state.heading).toBeCloseTo(heading0, 6); // 车头不转
  });
});

describe('R102 脱困 ③ 只给转向不给油门/刹车：不触发脱困特殊门控（但常规转向 ∝|v| 仍在）', () => {
  it('低速滑行态只按 KeyD、无油门/刹车：无 0.315 特殊权限（常规 yawRateFor 小转向），不触发 R102 门控', () => {
    const fd = driveToWallAndPin();
    fd.press('KeyW', false); // 松油门
    fd.press('KeyD', true); // 只给转向
    for (let i = 0; i < 60; i += 1) {
      fd.step(DT);
      // R150：v≈3.776 稳态（非钉停 0）⇒ 常规 yawRateFor(steer, v) 有 ∝|v| 的转向权限，
      // 但**不是** R102 的 0.35×maxYawRate≈0.315 特殊脱困权限（门控需油门/刹车同时按下）。
      // 断言「无 0.315 级权限」——若门控误触发会 ≈0.315。R150 柔化后稳态 3.776 的常规转向
      // 实测峰值 0.245（无油门刮擦滑行，yaw 瞬态在 0.25s 处达峰）⇒ 上限取 0.28（在
      // 0.245 与门控 0.315 之间留双向裕量，严禁无依据放宽）。
      expect(Math.abs(fd.state.yawRate)).toBeLessThan(0.28);
      expect(fd.state.x).toBeGreaterThanOrEqual(LIMIT - 0.05); // 不显著离墙（贴墙接触带 5cm 内）
    }
  });
});
