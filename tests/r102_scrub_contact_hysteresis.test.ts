/**
 * R102 · wall scrub 接触判定离墙滞后（hysteresis）回归 —— R103 阶段二（设计 B）pivot 版。
 *
 * 【旧 premise 已消失】设计 B 把拱廊柱列（内缘 11.12）从 1D 完全移除、下沉到 2D
 * clampToFootprints；块心 1D 改为「连续墙包络」：殿身（|z−块心|≤6.85）→ 13.997、
 * 其余块心 → 14.497（前脸 15.5 − 车半宽 1.003）。因此旧用例钉的「柱间 10.0 / 柱位
 * 10.117」的 0.117 段间跳变在块心段**已不存在**——1D 在块内是平滑包络，唯一的块内
 * 跳变只剩「殿身 13.997 ↔ 前脸 14.497」（幅度 0.5）。FreeDrive 已删 pillar 1D 常量与
 * R30_ARCADE import。
 *
 * 【新不变量】scrub 离墙滞后常量 WALL_SCRUB_RELEASE_EPS(1.2) / WALL_SCRUB_LATCH_FAR_FRAMES(60)
 * 未改。现块内最大跳变 0.5 < 1.2（release band 天然覆盖殿身↔前脸）；跨段更宽的
 * 隧道(8.997)→城内(13.997/14.497) 跳变（~4.9 m）由 LATCH_FAR_FRAMES(60=0.5s) 闸门覆盖——
 * latch 在车真正离墙满 60 帧后才清，跳变当帧绝不闪断。
 */
import { describe, expect, it } from 'vitest';
import {
  WALL_SCRUB_CONTACT_EPS,
  WALL_SCRUB_RELEASE_EPS,
  WALL_SCRUB_LATCH_FAR_FRAMES,
  FreeDrive,
  corridorCenterHalfWidth,
  CITY_BLOCK_Z
} from '../src/core/FreeDrive';
import { INNER, TOWER } from '../src/render/scene/r28Layout';
import { VEHICLE } from '../src/config/physics';

const DT = 1 / 120;
const CAR_HALF = VEHICLE.widthM / 2; // 1.003

/** 殿身 / 前脸车心限（真源派生，禁写死） */
const HALL_CC = INNER.faceHalf - 0.5 - CAR_HALF; // 15.0 − 1.003 = 13.997
const FRONT_CC = 15.5 - CAR_HALF; // 前脸线扣车半宽 = 14.497
/** 殿身 |z−块心| 包络 = hallW/2 + 大理石带 z 半外扩 0.6（与 FreeDrive 同源派生） */
const HALL_ZR = TOWER.hallW / 2 + 0.6; // 6.85

// 斜擦 +X 墙且沿 **-Z** 滑：forwardOf(h)=(-sin h, -cos h)，取 h=−asin(fn)
// ⇒ f=(+sin(asin fn), −cos(asin fn))=(+fn, −cos) 朝 +X 墙 / −Z。
function headingForNegZ(fn: number): number {
  return -Math.asin(fn);
}

describe('R102 wall scrub 接触滞后 ① 跨段放宽跳变：隧道(8.997)→城内块心(13.997/14.497)，scrub 不被瞬间误清', () => {
  it('200km/h 斜擦(fn≈0.3)贴隧道 +X 墙沿 -Z 滑进城内：跳变当帧 scrubN 不归零，离墙满 60 帧后才正常衰减', () => {
    // 城门带（隧道）mid z，恒定车心限 8.997
    const TUN_Z = -358.5;
    const tunLimit = corridorCenterHalfWidth(TUN_Z);
    expect(tunLimit).toBeCloseTo(10.0 - CAR_HALF, 6); // 8.997

    const heading = headingForNegZ(0.3); // fn≈0.3 斜擦 +X 墙，沿 -Z 滑
    const fd = new FreeDrive({ start: { x: tunLimit - 0.5, z: TUN_Z, heading } });
    fd.state.speed = 55.56; // 200 km/h
    let hit = false;
    for (let i = 0; i < 400 && !hit; i += 1) {
      fd.step(DT);
      if (fd.state.x >= tunLimit - 1e-9) hit = true; // 撞隧道墙建立 scrub
    }
    expect(hit).toBe(true);
    expect(fd.scrubN).toBeGreaterThan(0); // 撞墙已建立 scrub

    // 沿 -Z 滑进城内：halfW 从 8.997 跳到 13.997/14.497（放宽 ~4.9 m）
    // 旧机制（纯 ε=0.05）：|8.997| < halfWnow−0.05 ⇒ sideTouch 闪断 ⇒ scrubN 当帧清零
    // 新机制：latch=true 用 RELEASE_EPS 维持 + LATCH_FAR_FRAMES(60) 闸门 ⇒ 跳变当帧不闪断
    let crossed = -1; // 进入城内（halfW 跳大）当帧
    let firstZero = -1; // scrubN 首次归零帧
    let minScrubInGrace = Infinity; // 跨越后宽限窗内 scrubN 最小值
    for (let i = 0; i < 1440; i += 1) {
      fd.step(DT);
      const hw = corridorCenterHalfWidth(fd.state.z);
      if (crossed < 0 && hw > tunLimit + 0.5) crossed = i;
      if (crossed >= 0) {
        // 宽限窗（跨越后 ~LATCH_FAR_FRAMES 帧内）scrub 应维持 >0
        if (i - crossed <= WALL_SCRUB_LATCH_FAR_FRAMES / 2) {
          minScrubInGrace = Math.min(minScrubInGrace, fd.scrubN);
        }
        if (firstZero < 0 && fd.scrubN <= 0) firstZero = i;
      }
    }

    expect(crossed).toBeGreaterThanOrEqual(0); // 确实跨越了隧道→城内放宽跳变
    // ① 跳变当帧 scrubN 未归零：宽限窗内 scrubN 全程 > 0（旧机制会当帧清零）
    expect(minScrubInGrace).toBeGreaterThan(0);
    // ② 不永久假维持：车在更宽走廊里真正离墙满 60 帧后 scrub 正常衰减归零
    expect(firstZero).toBeGreaterThanOrEqual(0);
    expect(firstZero).toBeGreaterThan(crossed + WALL_SCRUB_LATCH_FAR_FRAMES / 2); // 归零发生在宽限窗之后，非跳变当帧
  });
});

describe('R102 wall scrub 接触滞后 ② 块内唯一跳变：殿身(13.997)↔前脸(14.497) 0.5 跳变，release band 覆盖、1D 无柱位窄带', () => {
  it('块心 1D 是平滑包络：殿身段=13.997、前脸段=14.497，全程无 10.0/10.117 柱位窄带', () => {
    const [zmin, zmax] = CITY_BLOCK_Z[0];
    const zc = (zmin + zmax) / 2; // −388.5
    // 殿身（zr=0 ≤ 6.85）→ 13.997
    expect(corridorCenterHalfWidth(zc)).toBeCloseTo(HALL_CC, 6);
    // 殿身包络外沿（zr 刚超 6.85，仍 dc≥3）→ 前脸 14.497
    expect(corridorCenterHalfWidth(zc + HALL_ZR + 0.05)).toBeCloseTo(FRONT_CC, 6);
    // 块内唯一跳变 = 前脸 − 殿身 = 0.5
    const jump = FRONT_CC - HALL_CC;
    expect(jump).toBeCloseTo(0.5, 6);

    // 扫描块心段（dc≥3）：每个 z 的 1D 限只取 HALL_CC 或 FRONT_CC，绝无 10.0/10.117 柱位窄带
    for (let dz = 3; dz <= 20; dz += 0.5) {
      for (const z of [zmin + dz, zmax - dz]) {
        const hw = corridorCenterHalfWidth(z);
        expect(Math.min(Math.abs(hw - HALL_CC), Math.abs(hw - FRONT_CC))).toBeLessThan(1e-6);
        expect(Math.abs(hw - 10.0)).toBeGreaterThan(1.0); // 不是空气墙 10.0
        expect(Math.abs(hw - (11.12 - CAR_HALF))).toBeGreaterThan(1.0); // 不是柱位窄带 10.117
      }
    }
  });

  it('0.5 跳变 < RELEASE_EPS(1.2)：贴殿身墙(13.997)的车在前脸包络下仍在 release band 内 ⇒ scrub 不闪断', () => {
    const jump = FRONT_CC - HALL_CC; // 0.5
    expect(WALL_SCRUB_RELEASE_EPS).toBeGreaterThan(jump);
    // 车贴殿身墙 |x|=13.997，滑入前脸段 halfWnow=14.497：
    //   纯 ε(0.05) 判定 13.997 ≥ 14.497−0.05=14.447 ⇒ false（会闪断）
    expect(HALL_CC >= FRONT_CC - WALL_SCRUB_CONTACT_EPS).toBe(false);
    //   release band 判定 13.997 ≥ 14.497−1.2=13.297 ⇒ true（latch 维持，scrub 不清）
    expect(HALL_CC >= FRONT_CC - WALL_SCRUB_RELEASE_EPS).toBe(true);
  });

  it('贴殿身墙 scrubN 维持、真正离墙后 60 帧闸门到才归零', () => {
    // 干净建立 scrub（御桥段无 2D 占位干扰）
    const BRIDGE_Z = -250;
    const blimit = corridorCenterHalfWidth(BRIDGE_Z);
    const fd = new FreeDrive({ start: { x: blimit - 0.5, z: BRIDGE_Z, heading: Math.PI + Math.asin(0.3) } });
    fd.state.speed = 20;
    let hit = false;
    for (let i = 0; i < 400 && !hit; i += 1) {
      fd.step(DT);
      if (fd.state.x >= blimit - 1e-9) hit = true;
    }
    expect(fd.scrubN).toBeGreaterThan(0);

    const [zmin, zmax] = CITY_BLOCK_Z[0];
    const zc = (zmin + zmax) / 2;
    // 重摆到殿身墙（块心 zr=0，柱位 zr=4.4 远离车 z 伸展 ±2.75 ⇒ 2D 占位不干扰单帧接触判定）
    fd.state.x = HALL_CC; // 贴殿身墙
    fd.state.z = zc;
    fd.state.heading = 0; // 平行墙沿 -Z
    fd.state.speed = 10;
    fd.step(DT);
    expect(fd.scrubN).toBeGreaterThan(0); // 贴墙 scrub 维持
    expect(fd.state.x).toBeCloseTo(HALL_CC, 6); // 未被 1D/2D 移动（平行车贴墙）

    // 真正离墙（|x|=0 远超 release band）：60 帧闸门到才归零，不瞬间清
    fd.state.x = 0;
    let zeroFrame = -1;
    for (let i = 0; i < 200; i += 1) {
      fd.step(DT);
      if (zeroFrame < 0 && fd.scrubN <= 0) zeroFrame = i;
    }
    expect(zeroFrame).toBeGreaterThanOrEqual(0); // 离墙后确实归零
    expect(zeroFrame).toBeGreaterThanOrEqual(WALL_SCRUB_LATCH_FAR_FRAMES - 5); // 经 60 帧闸门，非瞬间清
  });
});

describe('R102 wall scrub 接触滞后 ③ 常量正确性（设计 B）', () => {
  it('RELEASE_EPS=1.2 > 块内最大跳变 0.5；CONTACT_EPS=0.05；LATCH_FAR_FRAMES=60 覆盖隧道→城内大跳变', () => {
    const intraBlockJump = FRONT_CC - HALL_CC; // 0.5
    expect(intraBlockJump).toBeCloseTo(0.5, 6);
    expect(WALL_SCRUB_RELEASE_EPS).toBeGreaterThan(intraBlockJump);
    expect(WALL_SCRUB_RELEASE_EPS).toBeCloseTo(1.2, 6);
    expect(WALL_SCRUB_CONTACT_EPS).toBeCloseTo(0.05, 6);
    expect(WALL_SCRUB_LATCH_FAR_FRAMES).toBeCloseTo(60, 6);
    // 跨段隧道(8.997)→城内(~13.997) 跳变 ~5 m 远超 release band ⇒ 由 60 帧(0.5s) 闸门兜，
    // 而非 release band 本身（release band 只管 ≤1.2 的近墙跳变）。
    const crossSegJump = HALL_CC - (10.0 - CAR_HALF); // 13.997 − 8.997 = 5.0
    expect(crossSegJump).toBeGreaterThan(WALL_SCRUB_RELEASE_EPS);
  });
});
