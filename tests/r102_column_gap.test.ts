/**
 * R102 · 柱位邻域车心限跳变 vs R101 scrub ε 叠加出缝（柱间 10.000 → 柱位 10.117）。
 *
 * 缺陷（深度审查 §2.3）：柱间墙车心限 = BOUNDS.arcadeHalfW = 10.000，柱位邻域车心限
 * (R100) = ARCADE_PILLAR_CAR_CENTER = 10.117，在柱位邻域边界 |z−z_pillar| = 1.303 处瞬时
 * 跳变 0.117 m。车贴柱间墙（|x| = 10.000）滑入柱位邻域时，R101 旧接触判定 = 10.000 ≥
 * 10.117 − WALL_SCRUB_CONTACT_EPS(0.05) = 10.067 不成立 ⇒ 误判「离墙」⇒ wallScrubN 清零一帧。
 * ε=0.05 < 跳变 0.117 ⇒ 0.117 − 0.05 = 0.067 m 缺口。
 *
 * 修复（dev-scrub-contact 的 R102 离墙滞后带）：已贴墙态（wallSideTouchLatch=true）改用
 * WALL_SCRUB_RELEASE_EPS(1.2) 维持 sideTouch，未贴墙态仍用 ε(0.05) 进入。1.2 > 最大段间
 * 跳变 1.003 + 0.117 = 1.114 ⇒ 柱位邻域这 0.067 缺口被滞后带天然覆盖，scrub 不再闪断。
 * 本文件钉住该场景：车心 x=10.000 从柱间滑入柱位邻域（pitch 8.8 周期），断言 scrub 全程
 * 不清零一帧（纯 FreeDrive.step 数值断言，经只读观测口 scrubN）。
 *
 * 真源口径：R30_ARCADE / INNER / VEHICLE / BOUNDS 一律 import 派生，
 * 禁止写死 10.117 / 11.12 / 8.8 / 1.303。隐私红线：不读 git / 不读本机绝对路径。
 */
import { describe, expect, it } from 'vitest';
import {
  BOUNDS,
  WALL_SCRUB_CONTACT_EPS,
  WALL_SCRUB_DECEL,
  WALL_SCRUB_RELEASE_EPS,
  FreeDrive,
  corridorCenterHalfWidth
} from '../src/core/FreeDrive';
import { VEHICLE } from '../src/config/physics';
import { INNER } from '../src/render/scene/r28Layout';
import { R30_ARCADE } from '../src/render/scene/castleKit';

const DT = 1 / 120;

/** 车半宽真源（physics.ts，勿写死） */
const CAR_HALF = VEHICLE.widthM / 2; // 1.003
/** 拱廊柱半径 / 柱心外偏 / 整体内移（castleDetail.ts:1397,1410 / castleKit.ts:3474，真源不可 import） */
const COL_R = 0.3;
const COL_OFFSET = 0.12;
const ARCADE_TRANSLATE = 1.0;
/** 拱廊柱可见内缘 = faceHalf − width − translate + colOffset = 11.12 */
const PILLAR_INNER = INNER.faceHalf - R30_ARCADE.width - ARCADE_TRANSLATE + COL_OFFSET;
/** 柱位车心限 = 柱内缘 − 车半宽 = 10.117 */
const PILLAR_CAR_CENTER = PILLAR_INNER - CAR_HALF;
/** 柱位 z 邻域半宽 = colR + 车半宽 = 1.303 */
const PILLAR_NEAR_HALF = COL_R + CAR_HALF;
/** 柱 z 节距 = R30_ARCADE.pitch = 8.8 */
const PILLAR_PITCH = R30_ARCADE.pitch;
/** 柱间 / 块心车心限 = BOUNDS.arcadeHalfW = 10.0 */
const BLOCK_CENTER = BOUNDS.arcadeHalfW;

/** 与 FreeDrive.CITY_BLOCK_Z 严格一致的 keep=10 街区区间（取 k0 块做场景，测试 fixture） */
const BLOCK_K0: readonly [number, number] = [-411.5, -365.5];
/** k0 块心 z */
const ZC = (BLOCK_K0[0] + BLOCK_K0[1]) / 2; // −388.5
/** 最近柱位 z = 块心 + 0.5·pitch = −384.1 */
const PILLAR_Z = ZC + 0.5 * PILLAR_PITCH;
/** 柱位邻域入口（柱间侧）= 柱位 z − 邻域半宽 */
const NEAR_ENTRY = PILLAR_Z - PILLAR_NEAR_HALF; // −385.403
/** 柱间起步 z：邻域入口外 0.5 m（仍柱间，dc≥3，距柱 > 1.303） */
const Z_START = NEAR_ENTRY - 0.5;

describe('R102 ① 根因：柱位邻域车心限跳变 0.117 > scrub ε 0.05 ⇒ 0.067 出缝', () => {
  it('柱间 10.000 / 柱位 10.117，跳变 0.117，纯 ε(0.05) 判定在 x=10.0 处漏判离墙', () => {
    expect(BLOCK_CENTER).toBeCloseTo(10.0, 12);
    expect(PILLAR_CAR_CENTER).toBeCloseTo(10.117, 12);
    expect(PILLAR_NEAR_HALF).toBeCloseTo(1.303, 12);
    expect(PILLAR_PITCH).toBeCloseTo(8.8, 12);
    // 几何跳变确实存在且大于 ε
    const jump = PILLAR_CAR_CENTER - BLOCK_CENTER;
    expect(jump).toBeCloseTo(0.117, 12);
    expect(jump).toBeGreaterThan(WALL_SCRUB_CONTACT_EPS);
    // 车贴柱间墙 x=10.0：柱位邻域 halfWnow=10.117，纯 ε 判定 10.0 ≥ 10.117−0.05=10.067 不成立
    const gap = PILLAR_CAR_CENTER - WALL_SCRUB_CONTACT_EPS - BLOCK_CENTER;
    expect(gap).toBeCloseTo(0.067, 12);
    expect(BLOCK_CENTER >= PILLAR_CAR_CENTER - WALL_SCRUB_CONTACT_EPS).toBe(false); // 旧判定漏判
    // 滞后带 1.2 覆盖：10.0 ≥ 10.117 − 1.2 = 8.917 成立
    expect(BLOCK_CENTER >= PILLAR_CAR_CENTER - WALL_SCRUB_RELEASE_EPS).toBe(true);
    expect(WALL_SCRUB_RELEASE_EPS).toBeGreaterThan(jump);
  });

  it('场景 z 取点：柱间起步 z=−386.4 为 10.0、柱位邻域内 z=−384.1 为 10.117', () => {
    expect(ZC).toBeCloseTo(-388.5, 12);
    expect(PILLAR_Z).toBeCloseTo(-384.1, 12);
    expect(corridorCenterHalfWidth(Z_START)).toBeCloseTo(BLOCK_CENTER, 12); // 柱间 10.0
    expect(corridorCenterHalfWidth(PILLAR_Z)).toBeCloseTo(PILLAR_CAR_CENTER, 12); // 柱位 10.117
  });
});

/**
 * 把车开到御桥段（z=−250，恒定车心限，且在城内 2D 占位域 [plazaZ,gateBackZ] 之外 ⇒
 * clampToFootprints 不激活）贴 +X 墙，撞墙建立 scrub，返回该 FreeDrive（scrubN>0、latch=true）。
 * 取桥段是为了**干净建立 scrub**：城内斜插进墙会触发 dev-stuck 的 2D 占位收紧（OBB 角
 * dx(θ) 越 xInner 线），把车心拉离 1D 墙、干扰纯 1D 柱位跳变场景。桥段无此干扰（r101 同源）。
 */
function establishScrubOnBridge(speed: number): FreeDrive {
  const BRIDGE_Z = -250;
  const limit = corridorCenterHalfWidth(BRIDGE_Z); // 10.997 恒定
  // heading=π+asin(0.3) ⇒ forward=(+0.3,+0.954)：朝 +X 墙(fn≈0.3 触发 side 撞击)、沿 +Z 滑
  const heading = Math.PI + Math.asin(0.3);
  const fd = new FreeDrive({ start: { x: limit - 0.5, z: BRIDGE_Z, heading } });
  fd.state.speed = speed;
  let hit = false;
  for (let i = 0; i < 400 && !hit; i += 1) {
    fd.step(DT);
    if (fd.state.x >= limit - 1e-9) hit = true; // 已被几何钳到墙 ⇒ 接触
  }
  expect(hit).toBe(true);
  expect(fd.scrubN).toBeGreaterThan(0); // 撞墙已建立 scrub
  return fd;
}

describe('R102 ② 车心 x=10.000 从柱间滑入柱位邻域：scrub 不因 0.067 缺口清零一帧', () => {
  it('贴柱间墙(10.0)切向 +Z 滑入柱位邻域(10.117)：全程 scrubN > 0，且确实穿越 10.117 跳变带', () => {
    const fd = establishScrubOnBridge(20); // 20 m/s 撞墙 ⇒ impactN≈6 ⇒ scrub≈4.8
    // 重摆到城内柱位邻域入口外（柱间 halfW=10.0），纯切向 +Z 平行墙滑行。
    // heading=π ⇒ forward=(0,+1) ⇒ dx=半宽 1.003，OBB x 伸展 10.0+1.003=11.003 < 柱内缘
    // 11.12 ⇒ clampToFootprints 不触发（hit=false），纯净隔离 1D 柱位跳变场景。
    fd.state.x = BLOCK_CENTER; // 10.0 贴柱间墙
    fd.state.z = Z_START; // 柱间，邻域入口外 0.5 m
    fd.state.heading = Math.PI;
    fd.state.speed = 10;
    fd.step(DT);
    expect(fd.scrubN).toBeGreaterThan(0); // 柱间段 scrub 仍维持（滞后带 1.2 兜住）
    expect(fd.state.x).toBeCloseTo(BLOCK_CENTER, 6); // 未被 2D 占位/1D 钳位移动（平行车）

    // 逐帧滑行穿过柱位邻域（0.5 s = 60 帧，足够从 Z_START 越过整个 2.606 m 邻域带）
    let minScrub = Infinity;
    let crossedPillarBand = false;
    let prevSpeed = Math.abs(fd.state.speed);
    for (let i = 0; i < 60; i += 1) {
      fd.step(DT);
      const cur = Math.abs(fd.state.speed);
      // 刮擦 + 阻力恒耗散 ⇒ 速度单调不升
      expect(cur).toBeLessThanOrEqual(prevSpeed + 1e-9);
      prevSpeed = cur;
      // 命中柱位邻域（halfWnow 跳到 10.117）——确认真的穿越了 0.117 跳变带
      if (corridorCenterHalfWidth(fd.state.z) === PILLAR_CAR_CENTER) crossedPillarBand = true;
      // 车心始终贴柱间钳位线 10.0（平行车不被 2D 占位拉走）
      expect(fd.state.x).toBeCloseTo(BLOCK_CENTER, 6);
      minScrub = Math.min(minScrub, fd.scrubN);
    }
    expect(crossedPillarBand).toBe(true); // 确实滑入过柱位邻域（10.117 跳变处）
    expect(minScrub).toBeGreaterThan(0); // 全程 scrub 未被清零（含柱位邻域跳变帧）
    // scrub 减速度确实持续作用：0.5 s 内速度较撞后切向基线明显下降（≈scrub·Δt 量级）
    expect(10 - prevSpeed).toBeGreaterThan(1.0);
  });

  it('对照：柱位邻域内若按纯 ε(0.05) 判定必然清零——证实是滞后带(1.2)在兜住，非 ε 本身', () => {
    const fd = establishScrubOnBridge(20);
    fd.state.x = BLOCK_CENTER; // 10.0
    fd.state.z = PILLAR_Z; // 柱位正中，halfWnow=10.117
    fd.state.heading = Math.PI; // 平行墙 ⇒ 2D 占位不触发
    fd.state.speed = 10;
    const halfWnow = corridorCenterHalfWidth(fd.state.z);
    expect(halfWnow).toBeCloseTo(PILLAR_CAR_CENTER, 12);
    // 纯 ε 判定：10.0 ≥ 10.117 − 0.05 = 10.067 ⇒ false（这就是旧缺陷的清零触发点）
    expect(Math.abs(fd.state.x) >= halfWnow - WALL_SCRUB_CONTACT_EPS).toBe(false);
    // 滞后带判定：10.0 ≥ 10.117 − 1.2 = 8.917 ⇒ true（修复后实际走的分支）
    expect(Math.abs(fd.state.x) >= halfWnow - WALL_SCRUB_RELEASE_EPS).toBe(true);
    // 实际 step 一帧：scrub 维持（未被清零），且未被 2D 占位拉走
    fd.step(DT);
    expect(fd.scrubN).toBeGreaterThan(0);
    expect(fd.state.x).toBeCloseTo(BLOCK_CENTER, 6);
  });
});
