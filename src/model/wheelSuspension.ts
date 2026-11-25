import * as THREE from 'three';

/**
 * R158 · 簧下轮跳位置补偿：轮心贴地局部位置（纯 THREE 计算，无 window/DOM 依赖，可 node 单测）。
 *
 * 目标：车身转 roll+pitch（body.rotation = Euler(pitch, π, roll)，π 为基准偏航）后，
 * 轮心**世界高度保持贴地**（= 车身只转基准偏航 Euler(0,π,0) 时的轮心世界高度）。
 * 解 pivot.position = R_body⁻¹ · R_yaw · basePos：
 *   · R_body = Euler(pitch, π, roll)（车身当前姿态，含侧倾/俯仰/基准偏航）；
 *   · R_yaw  = Euler(0, π, 0)（只基准偏航，贴地基准）；
 *   · basePos = 轮心初始局部位置（构造记录，model 系，如 wheel-fl=(0.855,0.382,1.333)）。
 * 验证：R_body · pivot.position 的 y 分量 == R_yaw · basePos 的 y 分量（精确恒定）。
 *
 * ⚠ 不能只补 y（小角 y' = by + bx·roll + bz·pitch 会漏 x/z 耦合 → 2 倍漂移），
 *   须完整四元数 x/y/z 全补（tests/r158_wheel_suspension.test.ts 精确回归护栏）。
 * 返回补偿后局部位置（world-y 贴地）。
 */
export function wheelSuspensionLocal(
  roll: number,
  pitch: number,
  basePos: readonly [number, number, number]
): { x: number; y: number; z: number } {
  const qA = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(pitch, Math.PI, roll, 'XYZ'))
    .invert();
  const qB = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0, 'XYZ'));
  const v = new THREE.Vector3(basePos[0], basePos[1], basePos[2])
    .applyQuaternion(qB)
    .applyQuaternion(qA);
  return { x: v.x, y: v.y, z: v.z };
}
