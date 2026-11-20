/**
 * R101 Phase2 · 撞墙切向刮擦摩擦（wall scrub）回归。
 *
 * 用户诉求：自由驾驶撞墙后「贴墙长距离平稳蹭滑」（撞后滑 28 m、贴墙 6 km/h 蹭 12 s）不真实。
 * 根因：resolveBounds 撞墙速度分解「法向吸收 90% + 切向 100% 保留」，撞后 heading 收敛到
 * 切向平行墙 ⇒ fn→0 ⇒ 恒不判撞、只剩几何钳位（只钳 x 不动速度）⇒ 边界成无摩擦导轨。
 * 修复：step() 纵向力段加独立刮擦减速度 scrub = min(impactN × WALL_SCRUB_DECEL, MAX)，
 * 只要仍贴墙（几何接触，不依赖 fn）就持续作用，堵死零摩擦蹭滑。
 *
 * 采样点 z=−250（御桥段，车心限恒定 10.997），避开块角 dc<3 过渡区（与 r99 同口径）。
 */
import { describe, expect, it } from 'vitest';
import {
  WALL_SCRUB_CONTACT_EPS,
  WALL_SCRUB_DECEL,
  WALL_SCRUB_DECEL_MAX,
  FreeDrive,
  corridorCenterHalfWidth
} from '../src/core/FreeDrive';

const DT = 1 / 120;
const IMPACT_Z = -250; // 桥段，limits 恒定，避开块角
const LIMIT = corridorCenterHalfWidth(IMPACT_Z); // 10.997
const START_X = LIMIT - 0.5; // 10.497：车心在界内，留 0.5 m 冲进墙触发撞击

// 斜擦 +X 墙且**沿 +Z 滑**：heading=π+asin(fn) ⇒ f=(+sin,+cos) 朝 +X 墙 / +Z。
// 选 +Z 是为了全程留在桥段（z≥gateFrontZ 恒 halfW 10.997）——若沿 −Z 会滑进城内段
// （halfW 扩到 10~11.3），车 x 落到界内 ⇒ 接触丢失 ⇒ scrub 提前结束（非本特性缺陷）。
function headingFor(fn: number): number {
  return Math.PI + Math.asin(fn);
}

/** 把车开到贴墙：撞 +X 墙，返回「撞墙事件当帧」已 step 完的 FreeDrive（油门松开） */
function driveToWallHeading(heading: number, speed: number): FreeDrive {
  const fd = new FreeDrive({ start: { x: START_X, z: IMPACT_Z, heading } });
  fd.state.speed = speed;
  let hit = false;
  for (let i = 0; i < 400 && !hit; i += 1) {
    fd.step(DT);
    if (fd.state.x >= LIMIT - 1e-9) hit = true; // 已被几何钳到墙 ⇒ 接触
  }
  expect(hit).toBe(true);
  return fd;
}

describe('R101 wall scrub · 常量标定', () => {
  it('scrub = min(impactN×0.8, 12)：200km/h 斜擦 fn≈0.3 封顶 12；轻擦 fn≈0.1 得 1.6', () => {
    // 封顶：impactN = 55.56×0.3 = 16.67 ⇒ 16.67×0.8 = 13.3 → 封顶 12
    expect(Math.min(55.56 * 0.3 * WALL_SCRUB_DECEL, WALL_SCRUB_DECEL_MAX)).toBeCloseTo(12, 6);
    // 轻擦：impactN = 20×0.1 = 2 ⇒ 2×0.8 = 1.6（不封顶）
    expect(Math.min(20 * 0.1 * WALL_SCRUB_DECEL, WALL_SCRUB_DECEL_MAX)).toBeCloseTo(1.6, 6);
  });
});

describe('R101 wall scrub ① 撞后松油：切向刮擦把车快速刮停（不再滑 28 m / 数百米）', () => {
  it('200km/h 斜擦(fn≈0.3)松油：speed 单调降到 <0.1，滑行 ≤140 m（< 解析 117 m+容差）', () => {
    const heading = headingFor(0.3); // f.x=+0.3 ⇒ fn≈0.3 斜擦 +X 墙，沿 +Z 滑
    const fd = driveToWallHeading(heading, 55.56); // 200 km/h
    // 撞墙当帧切向速度仍高（切向 100% 保留的分解值），刮擦从下一帧起作用
    const v0 = Math.abs(fd.state.speed);
    // R106 撞墙首帧法向速度骤降：fn≈0.3 斜擦扣掉入射法向分量的 KICK_RATIO ⇒ 当帧从
    // 旧 ~53 降一截（仍高、非硬切）。切向刮擦从下一帧起作用，总速单调降到 <0.1 的
    // 意图不变。R108 比例 0.4→0.7（用户要求更硬撞击）⇒ 当帧 ~43.9，阈值随新手感从
    // >48 重钉到 >40；R109 再乘 (1−STUN 0.35) 总速粘滞 ⇒ 当帧 28.2，阈值重钉到 >25
    // （仍 > 入射速 55.56 的 4 成半、非硬切/非瞬移）。
    expect(v0).toBeGreaterThan(25); // 斜擦扣一记法向分量+总速粘滞后当帧仍 >25 m/s（非硬切）
    // 松油持续 step：刮擦 scrub=min(55.56×0.3×0.8,12)=12 m/s² 持续耗散
    let dist = 0;
    let prev = Math.abs(fd.state.speed);
    let prevX = fd.state.x;
    let prevZ = fd.state.z;
    let stopped = -1;
    const speeds: number[] = [prev];
    for (let i = 0; i < 1200; i += 1) {
      // 1200 帧 = 10 s，足够 53 m/s @12 m/s² 刮停（≈4.4 s）
      fd.step(DT);
      const cur = Math.abs(fd.state.speed);
      const dx = fd.state.x - prevX;
      const dz = fd.state.z - prevZ;
      dist += Math.hypot(dx, dz);
      prevX = fd.state.x;
      prevZ = fd.state.z;
      speeds.push(cur);
      if (stopped < 0 && cur < 0.1) stopped = i;
      expect(cur).toBeLessThanOrEqual(prev + 1e-9); // 单调不升（刮擦+阻力恒耗散）
      prev = cur;
      if (stopped >= 0) break;
    }
    expect(stopped).toBeGreaterThanOrEqual(0); // 确实刮停到 <0.1
    expect(stopped * DT).toBeLessThan(8); // 8 s 内停住（解析 53/12≈4.4 s + 收敛余量）
    expect(dist).toBeLessThan(140); // 滑行 ≤140 m（旧机制数百米 + 贴墙无限蹭）
  });
});

describe('R101 wall scrub ② 贴墙含油门：刮擦 > 油门净加速（高速压不住，但低速可走）', () => {
  it('贴墙(平行)+油门：高速被刮到低速带 1~3 m/s 不再爬升（旧机制会爬到十几 km/h 蹭十几秒）', () => {
    const heading = headingFor(0.3);
    const fd = driveToWallHeading(heading, 55.56);
    fd.press('KeyW', true); // 含油门：恒扭矩段 motor 净加速 ≈6.08 m/s²，< scrub 12
    let peak = Math.abs(fd.state.speed);
    for (let i = 0; i < 1440; i += 1) {
      // 1440 帧 = 12 s：含油门净减速 (12−6.08)≈5.9 m/s²，55 m/s 刮停需 ≈9 s
      fd.step(DT);
      const cur = Math.abs(fd.state.speed);
      peak = Math.max(peak, cur);
      expect(fd.state.x).toBeGreaterThanOrEqual(LIMIT - 1e-6); // 仍贴墙
    }
    // R109 低速脱困：scrub×clamp(|v|/FADE_SPEED,0,1) 随速渐入 ⇒ 平衡点 ≈2.03 m/s
    // （不再是旧 R101 的"被钉死到 <2 且 0"）——玩家持续给油可沿墙走、能转向脱困。
    expect(Math.abs(fd.state.speed)).toBeGreaterThan(0.5); // 不再被钉死到 0（脱困）
    expect(Math.abs(fd.state.speed)).toBeLessThan(3); // 被刮到低速带（不爬升）
    expect(peak).toBeLessThan(55.6); // 全程未爬升（含油门也压不住刮擦）
  });
});

describe('R101 wall scrub ③ 轻擦(fn≈0.1)：scrub 下限保证仍有可感减速（用户诉求：掠擦不滑）', () => {
  it('20 m/s 轻擦：撞后 0.1s 仍 >9 m/s、1s 仍 >2 m/s（R110 WALL_TANGENT_FRICTION 压住掠擦滑开）', () => {
    const heading = headingFor(0.1); // fn≈0.0998 ⇒ impactN≈2；R109 下限 8 ⇒ scrub≈6.4
    const fd = driveToWallHeading(heading, 20);
    // 撞墙当帧：R108 法向 kick（∝fn 小）+ R109 总速 stun 0.35 ⇒ 当帧 ≈11.7（仍高、非瞬停）
    expect(Math.abs(fd.state.speed)).toBeGreaterThan(9);
    for (let i = 0; i < 12; i += 1) fd.step(DT); // 0.1 s
    expect(Math.abs(fd.state.speed)).toBeGreaterThan(9); // 刮擦下限持续减速（实测 10.97）
    for (let i = 0; i < 108; i += 1) fd.step(DT); // 累计 1 s
    expect(Math.abs(fd.state.speed)).toBeGreaterThan(2); // 1s 实测 3.52（R110 切向摩擦自 5.09 压到 ~3.5，非瞬停、渐进减速）
  });
});

describe('R101 wall scrub ④ 撞墙当帧 speed 不破 r99 语义（R106 首帧顿挫后仍保留切向）', () => {
  it('撞墙当帧 speed 仍 >18（R106 首帧扣一记法向分量，斜擦 fn≈0.199 当帧 ~18.36，非硬切）', () => {
    const heading = -0.2; // 与 r99 同：fn≈0.1987
    const fd = driveToWallHeading(heading, 20);
    // R106：当帧扣掉入射法向分量的 KICK_RATIO ⇒ 斜擦 fn≈0.199 当帧降一截。仍远高于 0，
    // 切向保留 + 法向只扣一个比例 ⇒ R99 防硬切意图保留；R108 比例 0.4→0.7（更硬撞击）⇒
    // 当帧 ~17.17，阈值随新手感从 >18 重钉到 >17；R109 再乘 (1−STUN 0.35) ⇒ 当帧 10.97，
    // 阈值重钉到 >9（仍 > 0、非硬切/非瞬移）。
    expect(fd.state.speed).toBeGreaterThan(9);
    expect(fd.state.x).toBeCloseTo(LIMIT, 9); // 几何钳位逐位不动
  });

  it('离墙后刮擦清零：不贴墙时 scrub 不作用（正常驾驶不受影响）', () => {
    // 路中央直线（x=0 远离两侧墙、未触 z 端）：wallScrubN 恒 0 ⇒ 无刮擦减速
    const fd = new FreeDrive({ start: { x: 0, z: IMPACT_Z, heading: 0 } });
    fd.state.speed = 30;
    for (let i = 0; i < 30; i += 1) fd.step(DT); // 路中央直线，不贴墙
    // 无刮擦：只受阻力/滚阻，速度远未归零（若误刮擦 12 m/s² 早停）
    expect(Math.abs(fd.state.speed)).toBeGreaterThan(25);
    expect(Math.abs(fd.state.x)).toBeLessThan(LIMIT - WALL_SCRUB_CONTACT_EPS); // 确实未贴墙
  });
});
