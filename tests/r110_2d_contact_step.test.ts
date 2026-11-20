/**
 * R110 · 城内 2D 接触「连续收敛 + 真撞击」护栏（空气墙/穿模单帧瞬移 + 撞击滑开）。
 *
 * 缺陷（探测实证，都在 FreeDrive.step() 城内 2D 接触块）：
 *  Bug1 空气墙/穿模：:1199 `s.x = fp.x` 一帧写死横向位置 —— 合法 1D 位置进入柱/墩 z 带时
 *        单帧钳位最大 6.34 m（z=-1296.2 广场飞扶壁 h=0.5）、h=0 最大 5.15 m；
 *        扫 z∈[-1300,70]×h∈[0,±0.5] 采样点 55% SAT 相交、52.79% 钳位>0.3m ⇒ 读作空气墙/瞬移。
 *  Bug2 撞击滑开主因：:1229 `nxSide = fp.nx` 法向符号错（fp.nx 指向路内，与 resolveBounds
 *        :705 的 nx=x>=0?1:-1 指向墙外符号相反）⇒ fnSide 恒 ≤0 ⇒ 2D 接触从不扣速度 = 滑开。
 *
 * 修复：:1199/:1226 改一帧写死为每帧最大步长 WALL_2D_MAX_LATERAL_STEP=0.30 收敛；
 *       :1229 改 `nxSide = -fp.nx`（与 1D 同约定）⇒ 朝墙走 fnSide>0 ⇒ 真撞击进 impactN。
 *
 * 断言口径：一律 import 引擎真源（FreeDrive / clampToFootprints / WALL_2D_MAX_LATERAL_STEP /
 * CITY_BLOCK_Z），禁写死派生值（14.9 / 11.12 / 2.7475 / 1.003）。
 * 场景：块 0 近 gateBack 侧飞扶壁外墩 z 带 [-369.95,-367.85]（中心 -368.9），
 *       该处 1D halfW=14.497（不拦）、2D 墩 xInner=11.35 ⇒ 2D 接触先于 1D 触发（纯 2D 场景）。
 * R111：旧 SAT 车世界 x 半径误用 halfL（2.7475）⇒ 车在 x=13.5 直行时被「提前」判交（假阳性空气墙），
 *       实测 x=13.5 车缘 12.497 距墩外缘 11.9 有 0.6m 空隙、根本不接触。修正后 SAT 用真实车体
 *       半径（h=0 时 x 半径 = 半宽 1.003）⇒ 原场景 x=13.5 不再误触发。为使测试仍守护「真实接触」，
 *       起点改为 x=12.0（车缘 10.997 真嵌墩 11.35 内缘 0.35m）、x=10.0（斜插 θ=30° 真嵌墩）。
 */
import { describe, expect, it } from 'vitest';
import { FreeDrive, CITY_BLOCK_Z, WALL_2D_MAX_LATERAL_STEP } from '../src/core/FreeDrive';
import { clampToFootprints } from '../src/core/cityFootprints';

const DT = 1 / 120;

/** 块 0（z ∈ [−411.5, −365.5]）近 gateBack 侧飞扶壁外墩 z 带 [−369.95,−367.85]，取中心 */
const K0 = CITY_BLOCK_Z[0];
const Z_TEST = -368.9;

describe('R110 ① 2D 接触首帧单帧横向钳位 ≤ 步长上限（无空气墙/瞬移）', () => {
  it('z=-368.9 墩带合法 1D 起点 x=12.0 直行：任意相邻帧 |Δx| ≤ WALL_2D_MAX_LATERAL_STEP', () => {
    // R111：x=12.0 车缘 10.997 真嵌墩内缘 11.35（旧 x=13.5 是假阳性，已修正 SAT 不再判交）
    const fd = new FreeDrive({ start: { x: 12.0, z: Z_TEST, heading: 0 } });
    fd.press('KeyW', true);
    let prevX = fd.snapshot().x;
    let maxStep = 0;
    let saw2DHit = false;
    for (let i = 0; i < 120; i += 1) {
      fd.step(DT);
      const s = fd.snapshot();
      maxStep = Math.max(maxStep, Math.abs(s.x - prevX));
      prevX = s.x;
      if (clampToFootprints(s.x, s.z, s.heading).hit) saw2DHit = true;
    }
    // 场景有效性：确实进入 2D 接触（否则断言空转）
    expect(saw2DHit).toBe(true);
    // 核心护栏：单帧横向钳位绝不超步长上限（旧版一帧写死会单帧 ≥5 m）
    expect(maxStep).toBeLessThanOrEqual(WALL_2D_MAX_LATERAL_STEP + 1e-9);
  });
});

describe('R110 ② 命中后多帧收敛到 clampToFootprints 目标（不再一帧到位）', () => {
  it('z=-368.9 墩带 x=12.0 直行：hit 帧数 > 1（多帧收敛），运行中贴近目标到一步内', () => {
    const fd = new FreeDrive({ start: { x: 12.0, z: Z_TEST, heading: 0 } });
    fd.press('KeyW', true);
    let hitFrames = 0;
    let minGap = Infinity;
    for (let i = 0; i < 120; i += 1) {
      fd.step(DT);
      const s = fd.snapshot();
      const fp = clampToFootprints(s.x, s.z, s.heading);
      if (fp.hit) {
        hitFrames += 1;
        minGap = Math.min(minGap, Math.abs(s.x - fp.x));
      }
    }
    // 收敛应摊到多帧（旧版一帧写死 ⇒ hitFrames 恰为 1 或首帧即到位）；实测 ~10 帧
    expect(hitFrames).toBeGreaterThan(1);
    // 收敛判定：运行中车心贴近过 clampToFootprints 目标到「一步收敛」精度内。车沿墙滑动 ⇒
    // 目标随占位盒移动，实测最佳 ~0.153 m（< 一步 0.30），远低于旧版一帧 6.34 m 巨幅瞬移。
    expect(minGap).toBeLessThan(WALL_2D_MAX_LATERAL_STEP);
  });
});

describe('R110 ③ 2D 接触产生真实撞击速度损失（Bug2 法向符号修，不再滑开）', () => {
  it('z=-368.9 墩带斜插 θ=30°（fn=0.5>0）带速入墩：0.2s 后速度明显下降（>5%）', () => {
    // R111：x=9.5 斜插角真未达墩（角点在 z=-370.78 带外），改 x=10.0 使车角真嵌墩内缘
    const fd = new FreeDrive({ start: { x: 10.0, z: Z_TEST, heading: -Math.PI / 6 } });
    fd.state.speed = 15; // 注入初速（等效于行驶中接近墩带；teleport 会归零故用 state 注入）
    fd.press('KeyW', true);
    const preHitSpeed = 15;
    // 撞后 0.2s（24 帧），读速度
    for (let i = 0; i < 24; i += 1) fd.step(DT);
    const postSpeed = fd.snapshot().speed;
    // 核心护栏：Bug2 修后 fnSide=0.5>0 ⇒ fpImpact=0.5·|v|>0 ⇒ 撞击减速（旧版恒 0 ⇒ 不降速=滑开）
    expect(postSpeed).toBeLessThan(preHitSpeed * 0.95);
  });
});

describe('R110 ④ 离墙不误触发（无 2D 接触时零 wall 事件、零减速）', () => {
  it('x=0 路中央正常直行 1s：无 wall 事件、速度不降', () => {
    const fd = new FreeDrive({ start: { x: 0, z: -600, heading: Math.PI } });
    let wallCount = 0;
    fd.onEvent = (e) => {
      if (e === 'wall') wallCount += 1;
    };
    fd.press('KeyW', true);
    const v0 = fd.snapshot().speed;
    for (let i = 0; i < 120; i += 1) fd.step(DT); // 1 s
    expect(wallCount).toBe(0);
    expect(fd.snapshot().speed).toBeGreaterThan(v0); // 加速中，不降
    expect(fd.snapshot().speed).toBeGreaterThan(5);
  });
});
