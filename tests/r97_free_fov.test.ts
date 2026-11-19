/**
 * R97 · F4 自由探索机位动态 FOV 回归网（文件白名单：只写本文件）
 *
 * ═══ 定罪与护栏对应 ═════════════════════════════════════════════════════════
 * `src/render/CameraRig.ts` 的 chase 机位（:203-215）有动态 FOV 55→68 随速度，
 * 但 free 机位（旧 :255-262）忽略 speed 参数、FOV 恒定 60；而 Game.ts 早已把
 * absSpeed 传进 rig.update 的 speed 形参 —— 参数传了，free 没消费。
 * 结果自由探索全程零速度感。R97 修法：抽导出纯函数 freeFovForSpeed(speed)，
 * free 机位内部调用它；本网同时钉死数值契约与「构图量不随速度漂移」。
 *
 * ═══ 断言强度分层 ═════════════════════════════════════════════════════════
 *  【强 · 纯函数真实执行】直接 import freeFovForSpeed，钉死 0/27.5/55 三点、
 *    饱和、线性斜率、单调性 —— 不依赖相机逐帧 FOV 阻尼收敛，完全确定。
 *  【强 · 运行时 CameraRig】drive free 机位不同 speed，验证 camera.position /
 *    near 逐位一致（构图不随速度回归）、仅 fov 随速度变化，且运行时 fov 与纯函数一致。
 *  【弱 · 源码字面量】offset/look/k/near/local 六项逐字未被本波改动（防构图回归）。
 *
 * ⚠ 纪律：不读 .qa/ dist/ tools/ 未入库文件 / 本机绝对路径；只 import 生产模块。
 * ⚠ 不放宽任何既有断言；本文件纯新增。
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { freeFovForSpeed, CameraRig } from '../src/render/CameraRig';

/* ═══════ 1. 纯函数数值契约（强 · 真实执行） ═══════ */

describe('R97 · F4 · 1. freeFovForSpeed 数值契约：60→72 随速度', () => {
  it('speed=0 → 60（自由探索静止基线，与旧恒定值一致）', () => {
    expect(freeFovForSpeed(0)).toBe(60);
  });

  it('speed=27.5 → 66（线性段中点）', () => {
    expect(freeFovForSpeed(27.5)).toBe(66);
  });

  it('speed=55 → 72（自由探索上限；与 chase 的 55→68 刻意区分）', () => {
    expect(freeFovForSpeed(55)).toBe(72);
  });

  it('speed≥55 饱和在 72，不再增长', () => {
    expect(freeFovForSpeed(55)).toBe(72);
    expect(freeFovForSpeed(80)).toBe(72);
    expect(freeFovForSpeed(200)).toBe(72);
  });

  it('线性段斜率恒为 12/55 且单调不减（无跳变 / 无回退）', () => {
    const slope = 12 / 55;
    for (const s of [0, 5, 13.75, 27.5, 41.25, 54.999]) {
      expect(freeFovForSpeed(s), `speed=${s} 应落在线性段`).toBeCloseTo(60 + slope * s, 9);
    }
    let prev = -Infinity;
    for (let s = 0; s <= 60; s += 0.5) {
      const v = freeFovForSpeed(s);
      expect(v, `speed=${s} 处 FOV 不得回退`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

/* ═══════ 2. 运行时构图防回归（强 · CameraRig 真跑） ═══════ */

describe('R97 · F4 · 2. free 机位运行时：仅 FOV 随速度变化，构图量逐位不动', () => {
  const anchor = new THREE.Vector3(0, 0, 0);
  const quat = new THREE.Quaternion();

  /** 让 free 机位收敛到稳态：dt=1 ⇒ FOV 阻尼系数 min(1,dt*2)=1 一帧精确落位；
   *  offset 阻尼 s=1-e^(-k·dt)，20 帧后残差可忽略 ⇒ camera.position 完全收敛。 */
  function settledRig(speed: number): CameraRig {
    const rig = new CameraRig(16 / 9);
    rig.setMode('free');
    for (let i = 0; i < 20; i++) rig.update(1, anchor, speed, quat);
    return rig;
  }

  it('运行时 camera.fov 与纯函数逐点一致（0/27.5/55/饱和）', () => {
    for (const s of [0, 27.5, 55, 120]) {
      expect(settledRig(s).camera.fov, `speed=${s} 运行时 FOV 偏离纯函数`).toBeCloseTo(
        freeFovForSpeed(s),
        6
      );
    }
  });

  it('构图不随速度漂移：不同 speed 下 camera.position / near 逐位一致', () => {
    const slow = settledRig(0).camera;
    const mid = settledRig(27.5).camera;
    const fast = settledRig(55).camera;
    // offset/look 不含 speed ⇒ 稳态机位（含 free 边界钳位后位置）必须逐位相同
    expect(mid.position.toArray(), 'speed=27.5 机位漂移').toEqual(slow.position.toArray());
    expect(fast.position.toArray(), 'speed=55 机位漂移').toEqual(slow.position.toArray());
    expect(mid.near).toBe(slow.near);
    expect(fast.near).toBe(slow.near);
    expect(slow.near).toBe(0.1);
    // FOV 确实随速度变了，避免上面的一致性断言把本测试变成假绿
    expect(slow.fov).not.toBe(fast.fov);
  });
});

/* ═══════ 3. 构图量基线（offset / look / near 不随 speed 变化） ═══════ */

describe('R97 · F4 · 3. offset/look/near 构图基线未被本波改动（只动 FOV 一项）', () => {
  const anchor = new THREE.Vector3(0, 0, 0);
  const quat = new THREE.Quaternion();

  function settledCam(speed: number): THREE.PerspectiveCamera {
    const rig = new CameraRig(16 / 9);
    rig.setMode('free');
    for (let i = 0; i < 20; i++) rig.update(1, anchor, speed, quat);
    return rig.camera;
  }

  it('look 不随速度变化：不同 speed 下相机朝向（quaternion）逐位一致', () => {
    const slow = settledCam(0).quaternion.toArray();
    const mid = settledCam(27.5).quaternion.toArray();
    const fast = settledCam(55).quaternion.toArray();
    for (let i = 0; i < 4; i++) {
      expect(mid[i], `quaternion[${i}] speed=27.5 look 漂移`).toBeCloseTo(slow[i], 6);
      expect(fast[i], `quaternion[${i}] speed=55 look 漂移`).toBeCloseTo(slow[i], 6);
    }
  });

  it('offset 高度 / near 基线未改：y=3.4、near=0.1', () => {
    const cam = settledCam(0);
    expect(cam.position.y, 'free 机位高度 3.4m 被改').toBeCloseTo(3.4, 6);
    expect(cam.near, 'free 机位 near 被改').toBe(0.1);
  });
});
