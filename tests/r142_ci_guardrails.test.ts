/**
 * R142 · 深度审查报告 P1-5「补 4 条 CI 判据」前三条：把 R138 已达标的关键物理契约钉进回归，
 * 防未来改动回归（空气墙/穿模精细化收尾护栏）。
 *
 * 依据：V800_R110-R138 深度审查报告 §8 P1-5 —— 建议补 CI 判据：
 *   · `−Z 15 s 不反弹 >5 m/s`（主诉方向速度不反弹，自由驾驶末速高）
 *   · `贴墙 W 10 s 位移 ≥10 m`（贴墙低速脱困契约）
 *   · `2D 接触单帧横移 ≤0.30 m`（本测试用渲染后轨迹口径 ≤ X_Z_PEN_SMOOTH_CAP=0.35，
 *     WALL_2D_MAX_LATERAL_STEP=0.30 为静态步长，R115 车已穿模时动态放大到 0.35 为设计值）
 *
 * 探针实测（HEAD=86eef24=R141，FreeDrive.step() 真源码仿真，DT=1/120）：
 *   ① 中线自由驾驶 15s：endV=55.148 m/s，minV=20（起始），bounced=false
 *   ② 贴墙 +X W 10s：位移 14.785 m（报告 R138 实测 14.79），endV=1.509 m/s（报告 1.509）
 *   ③ 贴墙直行 max|Δx|/帧 = 0.3500 m（X_Z_PEN_SMOOTH_CAP）
 *
 * 红线：本测试只新增，不碰 src/；resolveBounds 函数体 / WALL_* / IMPACT_TAU / 灵魂12 / 摩擦圆
 *       全未动。断言值含裕量，防浮点/版本漂移误报。
 *
 * R144 补第 4 条判据：御桥段纯 1D 边界「倒车脱困契约」（见下方 ④）——锁定 R144 方向性 scrub
 *   渐出 + reverseEscaping 门控（FreeDrive.ts 倒车时墙 scrub 降 30% + 倒车全程保持 18°/s 脱困
 *   横摆），防「御桥段桥沿倒车+转向卡死」（修复前 10s 位移 0.01m 原地自转不出墙）回归。
 *
 * R150 补第 6 条判据：贴墙 W 稳态末速 ∈ [3.0, 4.5]（见下方 ⑥）——锁定 R150 柔化低速蹭墙
 *   （WALL_SCRUB_FADE_SPEED 4.0→10.0，用户拍板 R142 §0-B），防回退 R109 龟速 1.509 蹭墙回归。
 *   判据② 低速带上限同步 3.0→4.0（R150 稳态 3.776 落新带，探针位移 14.785→35.626）。
 *
 * R151 继续柔化低速蹭墙（用户指令，R150 之后）：WALL_SCRUB_FADE_SPEED 10.0→11.0，稳态
 *   ≈3.776→≈4.154 m/s（探针 v_ss=0.3776×FADE）。判据② 低速带上限同步 4.0→4.2（R151 稳态
 *   4.154 落新带）；判据⑥ [3.0,4.5] 不改（4.154 过）。
 *
 * R152 继续柔化到稳态维度极限（用户第三次指令）：WALL_SCRUB_FADE_SPEED 11.0→11.9，稳态
 *   ≈4.154→≈4.493 m/s（v_ss=0.3776×FADE）。判据② 低速带上限同步 4.2→4.6（R152 稳态 4.493
 *   落新带）；判据⑥ [3.0,4.5] 不改（4.493 过）。
 */
import { describe, expect, it } from 'vitest';
import {
  IMPACT_TAU,
  WALL_2D_MAX_LATERAL_STEP,
  WALL_IMPACT_SPEED_KICK_RATIO,
  WALL_SCRUB_DECEL,
  WALL_TANGENT_FRICTION,
  FreeDrive,
  corridorCenterHalfWidth,
  FREE_START
} from '../src/core/FreeDrive';

const DT = 1 / 120;

describe('R142 CI 判据 ① 中线自由驾驶 15s：速度不反弹 + 末速高', () => {
  it('主诉方向（−Z）速度从不显著掉速（不反弹），15s 末速 >5 m/s，且自由加速正常（>40 m/s）', () => {
    const fd = new FreeDrive({ start: { x: FREE_START.x, z: FREE_START.z, heading: FREE_START.heading } });
    fd.state.speed = 20;
    fd.press('KeyW', true);
    let bounced = false;
    let prevV = 20;
    let minV = 20;
    for (let i = 0; i < 1800; i += 1) {
      fd.step(DT);
      const v = fd.state.speed;
      if (v < prevV - 0.5) bounced = true; // 显著掉速（撞墙反弹）
      if (v < minV) minV = v;
      prevV = v;
    }
    expect(bounced).toBe(false); // 不反弹（自由驾驶不撞墙）
    expect(fd.state.speed).toBeGreaterThan(5); // 契约：15s 末速 >5 m/s
    expect(fd.state.speed).toBeGreaterThan(40); // 自由加速正常（探针 55.1）
    expect(minV).toBeGreaterThanOrEqual(19.9); // 从不显著掉速
    expect(fd.state.z).toBeLessThan(-400); // 确实在 −Z 南行
  });
});

describe('R142 CI 判据 ② 贴墙 W 10s 位移 ≥10m（贴墙低速脱困）', () => {
  it('贴 +X 墙沿 +Z 刮擦后含油门 10s，位移 ≥10m，末速处于低速带（蹭墙平衡），仍贴墙', () => {
    const IMPACT_Z = -250;
    const LIMIT = corridorCenterHalfWidth(IMPACT_Z); // 10.997
    const START_X = LIMIT - 0.5;
    const heading = Math.PI + Math.asin(0.3); // 斜擦 +X 墙且沿 +Z 滑（r101/r102 同口径）
    const fd = new FreeDrive({ start: { x: START_X, z: IMPACT_Z, heading } });
    fd.state.speed = 55.56; // 200 km/h 冲进墙
    for (let i = 0; i < 400; i += 1) fd.step(DT); // 撞墙 + 刮到低速带
    fd.press('KeyW', true);
    const z0 = fd.state.z;
    for (let i = 0; i < 1200; i += 1) fd.step(DT); // 10s
    const disp = Math.abs(fd.state.z - z0);
    expect(disp).toBeGreaterThanOrEqual(10); // 契约：≥10m（R150 探针 35.626，R142 原探针 14.785）
    expect(Math.abs(fd.state.speed)).toBeGreaterThanOrEqual(0.5); // 低速带下限（可走不卡死）
    expect(Math.abs(fd.state.speed)).toBeLessThanOrEqual(4.6); // 低速带上限（R152 稳态维度极限 ≈4.493）
    expect(fd.state.x).toBeGreaterThanOrEqual(LIMIT - 1e-6); // 仍贴墙
  });
});

describe('R142 CI 判据 ③ 2D 接触单帧横移 ≤ X_Z_PEN_SMOOTH_CAP（渲染后轨迹口径）', () => {
  it('贴墙直行（承托柱接触场景）全程单帧 |Δx| ≤0.35m（X_Z_PEN_SMOOTH_CAP 平滑上限）', () => {
    const fd = new FreeDrive({ start: { x: 10.0, z: -415.0, heading: 0 } });
    fd.state.speed = 30;
    fd.press('KeyW', true);
    let maxDx = 0;
    let prevX = 10.0;
    for (let i = 0; i < 300; i += 1) {
      fd.step(DT);
      const dx = Math.abs(fd.state.x - prevX);
      if (dx > maxDx) maxDx = dx;
      prevX = fd.state.x;
    }
    expect(maxDx).toBeLessThanOrEqual(0.35); // 探针 0.3500（X_Z_PEN_SMOOTH_CAP 设计值）
  });
});

/**
 * R142 CI 判据 ④ 倒车脱困契约（御桥段纯 1D 边界，锁定 R144 方向性 scrub 渐出 + reverseEscaping 门控）：
 *   · +X 墙正确转向（S+D 使车尾转向路内）10s 位移 ≥5m（探针 25.41m；R144 修复前 0.01m 原地自转不出墙）
 *   · −X 墙镜像正确转向（S+A）10s 位移 ≥5m（镜像对称，探针 25.41m）
 *   · 全程（冲墙收敛 + 倒车脱困）单帧 |Δx| ≤ 0.35（X_Z_PEN_SMOOTH_CAP，无瞬移，探针 0.1004）
 * 背景：R142 ①②③ 只测前进（中线/贴墙 W/2D 横移），未覆盖倒车 ⇒ 补第 4 条锁住 R144 倒车脱困，
 *       防「御桥段倒车+转向卡死」（曾 10s 位移 0.01m）回归。镜像对称：+X 用 D、−X 用 A（反车
 *       把车尾转向路内才脱困；转向墙内被墙抵抗 = 物理正确）。
 */
function runReverseEscape(side: 1 | -1, steerKey: 'KeyA' | 'KeyD'): { disp: number; maxDx: number } {
  const IMPACT_Z = -250;
  const LIMIT = corridorCenterHalfWidth(IMPACT_Z); // 10.997（御桥段纯 1D 边界）
  const startX = side * (LIMIT - 1.0); // ±9.997（近墙）
  const heading = Math.PI + Math.asin(0.3) * side; // 斜擦 ±X 墙（+X 用 π+0.305，−X 用 π−0.305）
  const fd = new FreeDrive({ start: { x: startX, z: IMPACT_Z, heading } });
  fd.state.speed = 40; // 40 m/s 冲墙收敛（r144_stuck_sim 同口径）
  let maxDx = 0;
  let prevX = fd.state.x;
  const track = () => {
    const dx = Math.abs(fd.state.x - prevX);
    if (dx > maxDx) maxDx = dx;
    prevX = fd.state.x;
  };
  fd.press('KeyW', true);
  for (let i = 0; i < 480; i += 1) {
    fd.step(DT); // 冲墙 + 刮到贴墙（4s）
    track();
  }
  fd.press('KeyW', false);
  const x0 = fd.state.x;
  const z0 = fd.state.z;
  fd.press('KeyS', true); // 倒车（brakeIn=1）
  fd.press(steerKey, true); // 正确转向：+X 用 D、−X 用 A（车尾转向路内）
  for (let i = 0; i < 1200; i += 1) {
    fd.step(DT); // 10s
    track();
  }
  return { disp: Math.hypot(fd.state.x - x0, fd.state.z - z0), maxDx };
}

describe('R142 CI 判据 ④ 倒车脱困契约（御桥段纯 1D 边界，R144 方向性 scrub 渐出）', () => {
  it('+X 墙正确转向（S+D）10s 位移 ≥5m，全程单帧 |Δx| ≤0.35（无瞬移）', () => {
    const r = runReverseEscape(1, 'KeyD');
    expect(r.disp).toBeGreaterThanOrEqual(5); // 探针 25.41m（R144 修复前 0.01m）
    expect(r.maxDx).toBeLessThanOrEqual(0.35); // 探针 0.1004
  });

  it('−X 墙镜像正确转向（S+A）10s 位移 ≥5m，全程单帧 |Δx| ≤0.35', () => {
    const r = runReverseEscape(-1, 'KeyA');
    expect(r.disp).toBeGreaterThanOrEqual(5); // 探针 25.41m（镜像对称）
    expect(r.maxDx).toBeLessThanOrEqual(0.35); // 探针 0.1004
  });
});

/**
 * R142 CI 判据 ⑥ 低速蹭墙柔化契约（R150）：判据②同场景贴墙 W 10s 稳态末速 ∈ [3.0, 4.5]。
 * 与判据②互补：判据②锁「位移 ≥10m + 低速带 ≤4.0」，本判据锁「稳态 3-4.5」——防回退
 * R109 龟速 1.509 蹭墙（柔化前稳态落 <2，玩家仍感「蹭墙太肉」），也防 FADE 过大致稳态
 * >4.5 飞驰刮墙（FADE=12 探针稳态已 4.531 > 4.5 ⇒ 契约锁 FADE ≲ 10-11）。
 * 探针 FADE=10 实测稳态 3.776（柔化目标 3-4 中位）。
 */
describe('R142 CI 判据 ⑥ 低速蹭墙柔化契约（R150）', () => {
  it('贴 +X 墙含油门 10s，稳态末速 ∈ [3.0, 4.5]（R150 柔化锁定，防回退 1.509 龟速）', () => {
    const IMPACT_Z = -250;
    const LIMIT = corridorCenterHalfWidth(IMPACT_Z); // 10.997
    const START_X = LIMIT - 0.5;
    const heading = Math.PI + Math.asin(0.3); // 斜擦 +X 墙且沿 +Z 滑（判据②同口径）
    const fd = new FreeDrive({ start: { x: START_X, z: IMPACT_Z, heading } });
    fd.state.speed = 55.56; // 200 km/h 冲进墙
    for (let i = 0; i < 400; i += 1) fd.step(DT); // 撞墙 + 刮到稳态
    fd.press('KeyW', true);
    for (let i = 0; i < 1200; i += 1) fd.step(DT); // 10s
    const v = Math.abs(fd.state.speed);
    expect(v).toBeGreaterThanOrEqual(3.0); // 柔化生效：稳态 ≥3.0（探针 3.776，远高于原 1.509）
    expect(v).toBeLessThanOrEqual(4.5); // 不飞驰：稳态 ≤4.5（FADE=10 探针 3.776，FADE=12 已 4.531）
    expect(fd.state.x).toBeGreaterThanOrEqual(LIMIT - 1e-6); // 仍贴墙
  });
});

describe('R142 结构断言：空气墙红线常量仍在（防误改）', () => {
  it('WALL_2D_MAX_LATERAL_STEP=0.30 / WALL_SCRUB_DECEL=0.8 / WALL_TANGENT_FRICTION=0.25 / WALL_IMPACT_SPEED_KICK_RATIO=0.7 / IMPACT_TAU=0.12', () => {
    expect(WALL_2D_MAX_LATERAL_STEP).toBe(0.30);
    expect(WALL_SCRUB_DECEL).toBe(0.8);
    expect(WALL_TANGENT_FRICTION).toBe(0.25);
    expect(WALL_IMPACT_SPEED_KICK_RATIO).toBe(0.7);
    expect(IMPACT_TAU).toBe(0.12);
  });
});
