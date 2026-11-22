/**
 * R127 · 撞击事件携带强度（wall/hall 事件对象化）回归。
 *
 * 背景：R126 遗留 —— 自由探索撞墙/撞主殿的相机 shake 与音效是**固定幅度**（wall 0.12 /
 * hall 0.32），不随撞击强度缩放，撞得再狠晃得一样。本测试钉死修复后的契约：
 *   ① wall/hall 事件为对象 `{ kind, strength }`，strength ∈ [0,1]；
 *   ② strength 由 impactN（法向入射强度 m/s）经 FREE_IMPACT_STRENGTH_N_REF 归一化，
 *      与 crashWorld CrashImpact.strength 同一口径 ⇒ Game 侧 `gain × strength`；
 *   ③ 撞得越狠 strength 越大（单调），撞 25 m/s 满幅 clamp 到 1；
 *   ④ 掠擦（fn→0 ⇒ impactN→0）strength 近零 ——「擦过去不抖」；
 *   ⑤ hall 正撞 strength = |speed|/REF（撞 15 m/s → 0.6）。
 */
import { describe, expect, it } from 'vitest';
import {
  BOUNDS,
  FREE_IMPACT_STRENGTH_N_REF,
  FreeDrive,
  corridorCenterHalfWidth
} from '../src/core/FreeDrive';

const DT = 1 / 120;
const SIDE_Z = -250; // 桥段，limits 恒定，避开块角过渡区
const SIDE_LIMIT = corridorCenterHalfWidth(SIDE_Z);

/** 撞到首个撞击事件后返回该事件（wall/hall），带 strength。 */
function firstImpact(
  start: { x: number; z: number; heading: number },
  speed: number
): { kind: 'wall' | 'hall'; strength: number } | null {
  const fd = new FreeDrive({ start });
  fd.state.speed = speed;
  let got: { kind: 'wall' | 'hall'; strength: number } | null = null;
  fd.onEvent = (e) => {
    if (typeof e === 'object' && !got) got = e;
  };
  for (let i = 0; i < 600; i += 1) {
    fd.step(DT);
    if (got) break;
  }
  return got;
}

/** side 正撞 +X 侧墙：heading=−π/2 ⇒ forward.x=+1（法向入射，fn≈1）。 */
const sideHit = (speed: number): { kind: 'wall' | 'hall'; strength: number } | null =>
  firstImpact({ x: SIDE_LIMIT - 2, z: SIDE_Z, heading: -Math.PI / 2 }, speed);

/** hall 正撞主殿：heading=0 ⇒ forward.z=−1，起点 zMin 内侧 8m。 */
const hallHit = (speed: number): { kind: 'wall' | 'hall'; strength: number } | null =>
  firstImpact({ x: 0, z: BOUNDS.zMin + 8, heading: 0 }, speed);

/** 掠擦 +X 侧墙：几乎沿墙（偏 6°），fn≈sin(6°)≈0.105 ⇒ impactN=|v|·0.105 很小。 */
const grazeHit = (speed: number): { kind: 'wall' | 'hall'; strength: number } | null =>
  firstImpact({ x: SIDE_LIMIT - 0.6, z: SIDE_Z, heading: -Math.PI / 2 + 1.466 }, speed);

describe('R127 ① 事件结构：wall/hall 对象化且强度有界', () => {
  it('撞墙事件为 { kind: "wall", strength: number }，strength ∈ [0,1]', () => {
    const ev = sideHit(20);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('wall');
    expect(typeof ev!.strength).toBe('number');
    expect(ev!.strength).toBeGreaterThanOrEqual(0);
    expect(ev!.strength).toBeLessThanOrEqual(1);
  });

  it('归一化基准为正（真源标定 25 m/s 满幅）', () => {
    expect(FREE_IMPACT_STRENGTH_N_REF).toBeGreaterThan(0);
  });
});

describe('R127 ② 强度随撞速单调 + 数值标定', () => {
  it('side 正撞 20 m/s → strength≈0.8（20/25；±0.005 容忍到墙前阻力微降）', () => {
    const ev = sideHit(20);
    expect(ev!.strength).toBeCloseTo(20 / FREE_IMPACT_STRENGTH_N_REF, 2);
  });

  it('side 正撞 5 m/s → strength≈0.2（低速轻反馈；±0.005 容忍低速阻力占比大）', () => {
    const ev = sideHit(5);
    expect(ev!.strength).toBeCloseTo(5 / FREE_IMPACT_STRENGTH_N_REF, 2);
  });

  it('单调：撞 10 < 20 < 30 m/s，强度递增', () => {
    const s10 = sideHit(10)!.strength;
    const s20 = sideHit(20)!.strength;
    const s30 = sideHit(30)!.strength;
    expect(s10).toBeLessThan(s20);
    expect(s20).toBeLessThan(s30);
  });

  it('撞 40 m/s → 满幅 clamp 到 1（超 REF 不超界）', () => {
    const ev = sideHit(40);
    expect(ev!.strength).toBe(1);
  });
});

describe('R127 ③ 掠擦近零 + hall 强度', () => {
  it('掠擦（偏 6°）strength 近零 —— 擦过去不抖', () => {
    const ev = grazeHit(20);
    expect(ev).not.toBeNull();
    expect(ev!.strength).toBeLessThan(0.15); // fn≈0.105 ⇒ 理论 ≈0.084
  });

  it('hall 正撞 15 m/s → strength=0.6（|speed|/REF；±0.005 容忍到位前微降）', () => {
    const ev = hallHit(15);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('hall');
    expect(ev!.strength).toBeCloseTo(15 / FREE_IMPACT_STRENGTH_N_REF, 2);
  });

  it('hall 撞 30 m/s → 满幅 1（高速撞主殿最大震）', () => {
    const ev = hallHit(30);
    expect(ev!.strength).toBe(1);
  });
});
