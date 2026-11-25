/**
 * R158 · 簧下轮跳位置补偿（轮心贴地）纯函数验证。
 *
 * wheelSuspensionLocal(roll, pitch, basePos) = R_body⁻¹ · R_yaw · basePos，
 *   R_body=Euler(pitch,π,roll)（车身当前姿态）、R_yaw=Euler(0,π,0)（只基准偏航）。
 * 性质：车身转 roll+pitch 后，轮心世界高度 = 只转基准偏航时的高度（贴地恒定）。
 * 验证：对任意 roll/pitch/base，R_body·pivot.position 的 y == R_yaw·base 的 y（精确）。
 *   ⚠ 只补 y 的小角公式（y'=by+bx·roll+bz·pitch）会漏 x/z 耦合 → 2 倍漂移（回归护栏）。
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { wheelSuspensionLocal } from '../src/model/wheelSuspension';

// 四轮初始局部位置（createV800Model wheel-fl/fr/rl/rr，model 系）
const WHEEL_BASES: ReadonlyArray<readonly [number, number, number]> = [
  [0.855, 0.382, 1.333], // wheel-fl
  [-0.855, 0.382, 1.333], // wheel-fr
  [0.855, 0.382, -1.333], // wheel-rl
  [-0.855, 0.382, -1.333] // wheel-rr
];

function worldYOf(local: { x: number; y: number; z: number }, pitch: number, roll: number): number {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, Math.PI, roll, 'XYZ'));
  return new THREE.Vector3(local.x, local.y, local.z).applyQuaternion(q).y;
}

function refWorldY(base: readonly [number, number, number]): number {
  const qY = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0, 'XYZ'));
  return new THREE.Vector3(base[0], base[1], base[2]).applyQuaternion(qY).y;
}

describe('R158 簧下轮跳位置补偿 · 纯函数', () => {
  it('轮心世界高度恒定（贴地）：任意 roll/pitch 下 R_body·pos.y == R_yaw·base.y', () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [0, 0], // 静止
      [0.0611, 0], // 满侧倾 3.5°
      [0, 0.0349], // 满俯仰 2°
      [0.0611, 0.0349], // 复合（过弯+刹车）
      [-0.0611, -0.0349], // 反向复合
      [0.0306, 0.0175] // 中幅
    ];
    for (const base of WHEEL_BASES) {
      const ref = refWorldY(base);
      for (const [roll, pitch] of cases) {
        const loc = wheelSuspensionLocal(roll, pitch, base);
        const wy = worldYOf(loc, pitch, roll);
        expect(wy).toBeCloseTo(ref, 6); // 轮心世界 y 精确恒定（±1e-6）
      }
    }
  });

  it('静止（roll=pitch=0）时位置 = basePos（补偿零改）', () => {
    for (const base of WHEEL_BASES) {
      const loc = wheelSuspensionLocal(0, 0, base);
      expect(loc.x).toBeCloseTo(base[0], 6);
      expect(loc.y).toBeCloseTo(base[1], 6);
      expect(loc.z).toBeCloseTo(base[2], 6);
    }
  });

  it('满侧倾 3.5°：右轮相对车身下移、左轮上移（悬挂行程 ±5cm 级，方向正确）', () => {
    // roll=+0.0611（绕 body 局部 z 正转，+x 侧抬起）：右侧轮（bx>0）相对车身应下移
    // （轮心世界贴地，车身右侧抬起 ⇒ 车轮相对车身下沉），左侧轮（bx<0）相对车身应上移。
    const roll = 3.5 * Math.PI / 180;
    const fl = wheelSuspensionLocal(roll, 0, WHEEL_BASES[0]); // bx=+0.855 右轮
    const fr = wheelSuspensionLocal(roll, 0, WHEEL_BASES[1]); // bx=-0.855 左轮
    expect(fl.y).toBeLessThan(WHEEL_BASES[0][1]); // 右轮相对车身下沉（贴地）
    expect(fr.y).toBeGreaterThan(WHEEL_BASES[1][1]); // 左轮相对车身上浮（贴地）
    const dyRight = WHEEL_BASES[0][1] - fl.y;
    const dyLeft = fr.y - WHEEL_BASES[1][1];
    expect(dyRight).toBeGreaterThan(0.04); // ≥4cm 级（理论 5.2cm）
    expect(dyLeft).toBeGreaterThan(0.04);
  });

  it('满俯仰 2°：前轮相对车身下移、后轮上浮（刹车点头贴地）', () => {
    const pitch = 2 * Math.PI / 180;
    const fl = wheelSuspensionLocal(0, pitch, WHEEL_BASES[0]); // 前轮 bz=+1.333
    const rl = wheelSuspensionLocal(0, pitch, WHEEL_BASES[2]); // 后轮 bz=-1.333
    expect(fl.y).toBeLessThan(WHEEL_BASES[0][1]); // 前轮下沉
    expect(rl.y).toBeGreaterThan(WHEEL_BASES[2][1]); // 后轮上浮
  });
});
