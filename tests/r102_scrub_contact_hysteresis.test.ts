/**
 * R102 · wall scrub 接触判定离墙滞后（hysteresis）回归。
 *
 * 用户主诉：-Z 方向撞墙刮擦 2.842 s 后永久失效。根因：corridorCenterHalfWidth(z) 段间跳变
 * （桥 10.997 → 隧道 8.997 → 块心 10.0 → 柱位 10.117 → 空档角塔 13.897），车贴上一段墙 x
 * 不变而 halfWnow 变大时 |x| < halfWnow−0.05 ⇒ sideTouch 闪断 ⇒ wallScrubN 被 :812-816 误清零。
 * 修复：双阈值滞后——已贴墙态（latch=true）用 WALL_SCRUB_RELEASE_EPS(1.2) 维持接触，
 * 未贴墙态用 WALL_SCRUB_CONTACT_EPS(0.05) 进入；1.2 > 最大段间跳变 0.997+0.117=1.114。
 */
import { describe, expect, it } from 'vitest';
import {
  WALL_SCRUB_CONTACT_EPS,
  WALL_SCRUB_RELEASE_EPS,
  FreeDrive,
  corridorCenterHalfWidth
} from '../src/core/FreeDrive';

const DT = 1 / 120;
const BRIDGE_Z = -250; // 桥段，limits 恒定 10.997
const BRIDGE_LIMIT = corridorCenterHalfWidth(BRIDGE_Z); // 10.997

// 斜擦 +X 墙且沿 **-Z** 滑：forwardOf(h)=(-sin h, -cos h)，取 h=−asin(fn)
// ⇒ f=(+sin(asin fn), −cos(asin fn))=(+fn, −cos) 朝 +X 墙 / −Z。
function headingForNegZ(fn: number): number {
  return -Math.asin(fn);
}

/** 把车开到贴 +X 桥段墙，返回撞墙当帧已 step 完的 FreeDrive（油门松开） */
function driveToBridgeWallNegZ(heading: number, speed: number): FreeDrive {
  const startX = BRIDGE_LIMIT - 0.5; // 10.497：留 0.5 m 冲进墙触发撞击
  const fd = new FreeDrive({ start: { x: startX, z: BRIDGE_Z, heading } });
  fd.state.speed = speed;
  let hit = false;
  for (let i = 0; i < 400 && !hit; i += 1) {
    fd.step(DT);
    if (fd.state.x >= BRIDGE_LIMIT - 1e-9) hit = true;
  }
  expect(hit).toBe(true);
  return fd;
}

describe('R102 wall scrub 接触滞后 ① -Z 主诉：撞桥段 +X 墙后沿 -Z 滑进城内段，scrub 不被误清零', () => {
  it('200km/h 斜擦(fn≈0.3)沿 -Z 滑：经隧道(halfW 8.997)进城内段(halfW 10.0)，wallScrubN 不归零、车被刮停', () => {
    const heading = headingForNegZ(0.3); // fn≈0.3 斜擦 +X 墙，沿 -Z 滑
    const fd = driveToBridgeWallNegZ(heading, 55.56); // 200 km/h

    // 撞墙当帧：切向速度仍高（r99 语义）
    expect(Math.abs(fd.state.speed)).toBeGreaterThan(50);

    // 松油沿 -Z 滑行：scrub 持续作用
    // 旧机制路径：隧道把 x 钳到 8.997，进城后 halfW=10.0，
    //   |8.997| < 10.0−0.05=9.95 ⇒ sideTouch=false ⇒ wallScrubN=0 ⇒ 长距离滑行
    // 新机制：latch=true 用 RELEASE_EPS=1.2，
    //   |8.997| ≥ 10.0−1.2=8.8 ⇒ sideTouch=true ⇒ wallScrubN 维持 ⇒ 刮停
    let totalDist = 0;
    let prevX = fd.state.x;
    let prevZ = fd.state.z;
    let stopped = -1;

    for (let i = 0; i < 1440; i += 1) {
      // 12 s 足够 53 m/s @ 12 m/s² 刮停（解析 ≈4.4 s）
      fd.step(DT);
      const cur = Math.abs(fd.state.speed);
      const dx = fd.state.x - prevX;
      const dz = fd.state.z - prevZ;
      totalDist += Math.hypot(dx, dz);
      prevX = fd.state.x;
      prevZ = fd.state.z;
      if (cur < 0.1) { stopped = i; break; }
    }

    expect(stopped).toBeGreaterThanOrEqual(0); // 确实刮停到 <0.1 m/s
    expect(stopped * DT).toBeLessThan(10); // 10 s 内停住（旧机制会滑数百米不停）
    expect(totalDist).toBeLessThan(200); // 总滑行 < 200 m（含桥段→城内全路径）
  });
});

describe('R102 wall scrub 接触滞后 ② 柱位邻域：halfW 从 10.0 跳到 10.117，scrub 不中断', () => {
  it('城内块心段贴 +X 墙(halfW=10.0)，滑入柱位邻域(halfW=10.117)时 scrubN 不被误清零', () => {
    // z=−509 落在城内块区块心段（dc≥3），halfW=10.0
    const CITY_Z = -509;
    const cityLimit = corridorCenterHalfWidth(CITY_Z); // 10.0
    expect(cityLimit).toBeCloseTo(10.0, 1);

    // 直接把车放到超出墙的位置（x=10.5 > 10.0），第一步 step 触发撞击建立 scrubN
    const heading = headingForNegZ(0.3);
    const fd = new FreeDrive({ start: { x: cityLimit + 0.5, z: CITY_Z, heading } });
    fd.state.speed = 30;
    fd.step(DT); // 触发撞击：resolveBounds 钳 x → impact → scrubN 建立
    expect(fd.scrubN).toBeGreaterThan(0); // 撞墙后 scrub 已建立

    // 沿 -Z 滑行，追踪 z 进入柱位邻域（halfW=10.117）时 scrubN 是否维持
    // 旧机制：|10.0| < 10.117−0.05=10.067 ⇒ sideTouch=false ⇒ scrubN=0
    // 新机制：latch=true，|10.0| ≥ 10.117−1.2=8.917 ⇒ sideTouch=true ⇒ scrubN 维持
    let scrubMaintainedInPillar = false;
    let enteredPillarZone = false;
    for (let i = 0; i < 300; i += 1) {
      fd.step(DT);
      const hw = corridorCenterHalfWidth(fd.state.z);
      if (hw > 10.05 && hw < 10.2) enteredPillarZone = true; // 柱位邻域
      if (enteredPillarZone && fd.scrubN > 0) scrubMaintainedInPillar = true;
    }
    expect(enteredPillarZone).toBe(true); // 确实经过柱位邻域
    expect(scrubMaintainedInPillar).toBe(true); // 柱位邻域内 scrubN > 0（未被误清）
  });
});

describe('R102 wall scrub 接触滞后 ③ 常量正确性', () => {
  it('WALL_SCRUB_RELEASE_EPS=1.2 > 最大段间跳变 0.997+0.117=1.114', () => {
    // 桥→块心：10.997−10.0=0.997（隧道钳位后再入城内，差 10.0−8.997=1.003）
    // 块心→柱位：10.117−10.0=0.117
    // 合计最大跳变 1.003+0.117=1.120… 但注意隧道钳位 x=8.997、进城 halfW=10.0，差=1.003；
    // 柱位再+0.117=1.120 > RELEASE_EPS=1.2？ 不——1.003 是隧道→城内的跳变，
    // 柱位偏移是城内内部的+0.117，两者不叠加（不同段），各自均<1.2 ⇒ 覆盖。
    expect(WALL_SCRUB_RELEASE_EPS).toBeGreaterThan(1.114);
    expect(WALL_SCRUB_RELEASE_EPS).toBeCloseTo(1.2, 6);
    expect(WALL_SCRUB_CONTACT_EPS).toBeCloseTo(0.05, 6);
  });
});
