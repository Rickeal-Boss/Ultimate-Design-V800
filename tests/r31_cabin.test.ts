import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraRig, isInteriorMode } from '../src/render/CameraRig';

/**
 * R31 C 线：座舱黑屏（P0）根因回归。
 *
 * 根因（实测定罪，非猜测）：外部↔内部机位切换时 CameraRig 的指数阻尼让相机
 * 穿越车体（orbit 半径 7.8m → cabin 眼点舱内），过渡期约 1~8s 全程相机位于
 * 壳体内部/背后 —— FrontSide 把外板背面剔除、内舱漆是暗面克隆（#2a211c），
 * 于是满屏黑/暗带，收敛后才恢复正常。R19 起该现象被反复误报为「座舱黑屏回归」
 * （QA 截图早于收敛会采到同一假象，见 .qa/game.mjs 收敛等待注释）。
 *
 * 修复：setMode 涉及车内机位（isInteriorMode 变化）时下一帧直接落位（s=1），
 * 不做穿越式过渡；外部↔外部切换保留原指数阻尼。
 *
 * 判据：切换后**一帧**相机必须精确到达目标机位（涉内）或明确未到达（涉外）。
 */

const DT = 1 / 60;
const ANCHOR = new THREE.Vector3(0, 0, 0);
const IDENT = new THREE.Quaternion();
const YAW_PI = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));

function drive(rig: CameraRig, frames: number, quat: THREE.Quaternion = IDENT, speed = 0): void {
  for (let i = 0; i < frames; i += 1) rig.update(DT, ANCHOR, speed, quat);
}

describe('R31 座舱黑屏修复：涉内机位切换首帧落位', () => {
  it('orbit → cabin：一帧精确落到 CABIN_EYE（修复前 ~96% 在途中 = 满屏黑）', () => {
    const rig = new CameraRig(16 / 9);
    rig.setMode('orbit');
    drive(rig, 5);
    rig.setMode('cabin');
    rig.update(DT, ANCHOR, 0, IDENT);
    // CABIN_EYE = [-0.40, 1.34, -0.72]（local=true，identity 四元数不旋转）
    expect(rig.camera.position.x).toBeCloseTo(-0.40, 6);
    expect(rig.camera.position.y).toBeCloseTo(1.34, 6);
    expect(rig.camera.position.z).toBeCloseTo(-0.72, 6);
  });

  it('cabin → hood（反向跨界）同样一帧落位到 hood 静态机位', () => {
    const rig = new CameraRig(16 / 9);
    rig.setMode('cabin');
    drive(rig, 60);
    expect(rig.camera.position.distanceTo(new THREE.Vector3(-0.40, 1.34, -0.72))).toBeLessThan(1e-6);
    rig.setMode('hood');
    rig.update(DT, ANCHOR, 0, IDENT);
    // MODES.hood：offset (0, 1.45, -1.45) 静态
    expect(rig.camera.position.x).toBeCloseTo(0, 6);
    expect(rig.camera.position.y).toBeCloseTo(1.45, 6);
    expect(rig.camera.position.z).toBeCloseTo(-1.45, 6);
  });

  it('落位后持续稳定（snap 只触发一帧，之后 offset 已在目标位）', () => {
    const rig = new CameraRig(16 / 9);
    rig.setMode('orbit');
    drive(rig, 5);
    rig.setMode('cabin');
    rig.update(DT, ANCHOR, 0, IDENT);
    drive(rig, 30);
    expect(rig.camera.position.distanceTo(new THREE.Vector3(-0.40, 1.34, -0.72))).toBeLessThan(1e-6);
  });

  it('车身偏航 π 时 cabin 眼点随车体局部系旋转（snap 不破坏 local 旋转）', () => {
    const rig = new CameraRig(16 / 9);
    rig.setMode('orbit');
    drive(rig, 5, YAW_PI);
    rig.setMode('cabin');
    rig.update(DT, ANCHOR, 0, YAW_PI);
    // (-0.40, 1.34, -0.72) 绕 y 旋 π → (0.40, 1.34, 0.72)
    expect(rig.camera.position.x).toBeCloseTo(0.40, 6);
    expect(rig.camera.position.y).toBeCloseTo(1.34, 6);
    expect(rig.camera.position.z).toBeCloseTo(0.72, 6);
  });

  it('外部↔外部（side → chase）仍走指数阻尼：一帧不落位', () => {
    const rig = new CameraRig(16 / 9);
    rig.setMode('side');
    drive(rig, 120); // 收敛到 side 静态机位 (4.6, 1.5, 0.6)
    rig.setMode('chase');
    rig.update(DT, ANCHOR, 0, IDENT);
    // chase@speed0 静态机位 (1.6, 2.2, 8.2)；side→chase 原始间距 >7m，
    // 一帧阻尼仅推进 ~6% ⇒ 必须仍距目标 >1m（若误触 snap 则 =0，测试红）
    const d = rig.camera.position.distanceTo(new THREE.Vector3(1.6, 2.2, 8.2));
    expect(d).toBeGreaterThan(1);
  });

  it('isInteriorMode 口径不变（cabin 四机位为内、hood/chase/orbit/side/free 为外）', () => {
    expect(isInteriorMode('cabin')).toBe(true);
    expect(isInteriorMode('cabinDriver')).toBe(true);
    expect(isInteriorMode('cabinPassenger')).toBe(true);
    expect(isInteriorMode('cabinRear')).toBe(true);
    expect(isInteriorMode('hood')).toBe(false);
    expect(isInteriorMode('chase')).toBe(false);
    expect(isInteriorMode('orbit')).toBe(false);
    expect(isInteriorMode('side')).toBe(false);
    expect(isInteriorMode('free')).toBe(false);
  });
});
