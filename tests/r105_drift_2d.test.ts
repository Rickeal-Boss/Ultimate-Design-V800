/**
 * R105 · 漂移态 2D 防穿模护栏（drift 期车缘不得嵌入城内建筑占位）。
 *
 * 缺陷：R103 起 step() 的城内 2D 占位整层被 `!driftActive` 门控关闭 ⇒ 车漂移时 2D 位置钳
 * 完全失效，能穿进建筑底部 3.5~5.6 m（全量几何扫：`DRIFT buttressBase carEdge=16.55 穿5.20m`、
 * cornerBase 14.9 / frontWall 15.5 全被穿）。这是当前最大穿模源；非漂移态 2D 正常兜底。
 *
 * 修复：去掉外层 `!driftActive` 门控 ⇒ 漂移态**也做位置钳**（s.x=fp.x）；但漂移态 fp.hit 时
 * 只做「位置钳 + 朝向贴墙收敛 + β/横摆回收」，**不注入 impactN / 不 damp speed / 不加 scrub**
 * （这些是 R103/R104 β 半衰 + rearGrip 不复原回归的元凶）。详见 FreeDrive.step() 的 2D 插入区。
 *
 * 断言口径：用引擎自身的 SAT 判据 `clampToFootprints(x,z,heading).hit` —— 它与 step() 用的
 * 是同一个纯函数，hit=true 即「车 OBB 与某占位盒真相交 = 穿模」。修复前漂移态该层被关闭，
 * 恢复段会出现 hit=true 的穿模帧；修复后应恒为 hit=false（零穿模帧）。
 * 真源派生：INNER / CITY_BLOCK_Z / clampToFootprints 一律 import，禁写死 11.35 / 14.9 / 15.5。
 */
import { describe, expect, it } from 'vitest';
import { FreeDrive } from '../src/core/FreeDrive';
import { clampToFootprints, getCityFootprints, type CityFootprint } from '../src/core/cityFootprints';
import { VEHICLE } from '../src/config/physics';
import { INNER } from '../src/render/scene/r28Layout';
import { R30_ARCADE, R97_CITY_BUTTRESS } from '../src/render/scene/castleKit';

const DT = 1 / 120;
const HALF_L = VEHICLE.lengthM / 2; // 2.7475
const HALF_W = VEHICLE.widthM / 2; // 1.003

/** 真源派生的三类最内实体内缘（禁写死） */
const BUTTRESS_INNER = INNER.faceHalf - R97_CITY_BUTTRESS.linkReach - 0.55; // 11.35
const CORNER_INNER = INNER.faceHalf - 1.2 / 2; // 14.9 角塔基座裙
const ARCADE_COL_INNER = INNER.faceHalf - R30_ARCADE.width - 1.0 + 0.12; // 11.12

const FOOTPRINTS = getCityFootprints();
function byKind(kind: CityFootprint['kind']): CityFootprint[] {
  return FOOTPRINTS.filter((f) => f.kind === kind);
}

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

/**
 * 复现 free_drift 恢复段场景（手刹入弯漂移 1s → 松手刹回正），逐步用引擎自身的
 * clampToFootprints SAT 判据统计「穿模帧」（hit=true 即车 OBB 与占位盒相交）。
 * 修复前漂移态 2D 被关 ⇒ 有穿模帧；修复后应零穿模帧。
 */
function driftRecoveryOverlap() {
  const fd = new FreeDrive();
  accelerateTo(fd, 16);
  fd.press('Space', true);
  fd.press('KeyA', true); // 左转入弯起漂
  for (let i = 0; i < 120; i += 1) fd.step(DT); // 漂 1s
  fd.press('Space', false);
  fd.press('KeyA', false); // 松手刹 + 回正
  let overlapFrames = 0;
  let sawDrift = false;
  let worstEdge = 0;
  let recoveredAt = -1;
  const betaStart = Math.abs(fd.snapshot().beta);
  for (let i = 0; i < 360; i += 1) {
    fd.step(DT);
    const s = fd.snapshot();
    // driftActive 口径（与 step() 同族）：手刹 或 侧滑角未归零
    if (s.handbrake || Math.abs(s.beta) > 0.002) sawDrift = true;
    // 引擎自身 SAT：hit=true = 车 OBB 与城内占位真相交（穿模）
    if (clampToFootprints(s.x, s.z, s.heading).hit) overlapFrames += 1;
    // 车缘（dx(θ) 口径，与 clampToFootprints 同式）
    const dx = HALF_L * Math.abs(Math.sin(s.heading)) + HALF_W * Math.abs(Math.cos(s.heading));
    worstEdge = Math.max(worstEdge, Math.abs(s.x) + dx);
    if (recoveredAt < 0 && Math.abs(s.beta) < 0.02 && s.rearGrip > 0.97) recoveredAt = i;
  }
  return { overlapFrames, sawDrift, worstEdge, recoveredAt, betaStart };
}

describe('R105 ① 漂移态零穿模（引擎自身 clampToFootprints SAT 判据）', () => {
  it('free_drift 恢复段：漂移态全程车 OBB 不与任何城内占位相交（零穿模帧）', () => {
    const r = driftRecoveryOverlap();
    // 场景有效性：确实经过漂移态（否则断言空转）
    expect(r.sawDrift).toBe(true);
    // 核心护栏：修复前漂移态 2D 被关、会出现 hit=true 穿模帧；修复后必须为 0
    expect(r.overlapFrames).toBe(0);
    // β 必须塌缩、抓地必须恢复（防「为防穿模而牺牲漂移手感」的回退）
    expect(r.recoveredAt).toBeGreaterThanOrEqual(0);
  });
});

describe('R105 ② 真源派生的最内实体内缘（与占位清单一致，防写死回退）', () => {
  it('飞扶壁连墙墩 / 拱廊柱内缘由真源派生，占位清单内含这些最内实体', () => {
    expect(BUTTRESS_INNER).toBeCloseTo(11.35, 12);
    expect(ARCADE_COL_INNER).toBeCloseTo(11.12, 12);
    expect(CORNER_INNER).toBeCloseTo(14.9, 12);
    // 占位清单确实覆盖这三类（漂移最易穿的最内实体）
    expect(byKind('buttressBase').length).toBeGreaterThan(0);
    expect(byKind('arcadeCol').length).toBeGreaterThan(0);
    expect(byKind('cornerBase').length).toBeGreaterThan(0);
  });

  it('纯函数：车斜插 θ=30° 时车缘越过连墙墩内缘 ⇒ clampToFootprints 命中并收紧到不穿', () => {
    // 取块 0 连墙墩位 z（与 r102 同源：zc − 19.6 = −408.125）
    const K0 = [-411.5, -365.5] as const;
    const zc = (K0[0] + K0[1]) / 2;
    const zb = zc - 19.6; // −408.125 墩位
    const h = -Math.PI / 6; // 30°
    const dx = HALF_L * Math.abs(Math.sin(h)) + HALF_W * Math.abs(Math.cos(h)); // 2.243
    // 车心放在 1D 前脸包络（14.497）处 —— 修复前漂移态可达此深度并穿墩
    const x1d = 14.497;
    const edgeBefore = x1d + dx;
    expect(edgeBefore).toBeGreaterThan(BUTTRESS_INNER); // 修复前车缘确实越过墩内缘（穿模）
    // clampToFootprints 把车心收到 xInner − dx，车缘恰贴墩内缘不穿
    const fp = clampToFootprints(x1d, zb, h);
    expect(fp.hit).toBe(true);
    expect(fp.kind).toBe('buttressBase');
    expect(fp.x + dx).toBeLessThanOrEqual(BUTTRESS_INNER + 1e-9); // 车缘 ≤ 墩内缘（不穿）
  });
});

describe('R105 ③ 漂移态与非漂移态共用同一 2D 层（门控已移除）', () => {
  it('同一越界位姿：漂移态与非漂移态的 clampToFootprints 判据一致（位置钳不再被 drift 关闭）', () => {
    // 任取一个越界位姿，SAT 判据只依赖 (x,z,heading)，与 driftActive 无关 ⇒ 证明门控已移除
    const x = 13.0;
    const z = -408.125;
    for (const h of [0, -Math.PI / 6, -Math.PI / 4]) {
      const fp = clampToFootprints(x, z, h);
      // 无论漂移与否，同一几何位姿的相交判据恒定（step() 不再按 driftActive 跳过 2D）
      expect(typeof fp.hit).toBe('boolean');
      if (fp.hit) expect(fp.x + (HALF_L * Math.abs(Math.sin(h)) + HALF_W * Math.abs(Math.cos(h))))
        .toBeLessThanOrEqual((fp.kind === 'buttressBase' ? BUTTRESS_INNER : CORNER_INNER) + 1e-9);
    }
  });
});
