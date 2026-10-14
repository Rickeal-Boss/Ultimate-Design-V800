/**
 * 踏板力模型（纯函数，保留原版高潮机制）：
 * - b ≥ 0.98：过载爬升 pedalForce += (rampBase + 2×rampGrowth×holdTime)×dt，
 *   达 breakForceN → brake_snap
 * - b < 0.98 且未断裂：pedalForce 以 releaseRate 向 b×breakForceN 松弛
 */
import { BRAKE } from '../config/physics';

export interface PedalState {
  /** 当前踏板力 N */
  pedalForce: number;
  /** 满程保持时长 s */
  holdTime: number;
  /** 是否已断裂 */
  snapped: boolean;
}

export function createPedalState(): PedalState {
  return { pedalForce: 0, holdTime: 0, snapped: false };
}

/**
 * @param brake 刹车滑条 0~1
 * @returns 本步是否触发断裂
 */
export function stepPedal(state: PedalState, dt: number, brake: number): boolean {
  if (state.snapped) return false;
  if (brake >= 0.98) {
    state.holdTime += dt;
    state.pedalForce += (BRAKE.rampBase + 2 * BRAKE.rampGrowth * state.holdTime) * dt;
  } else {
    state.holdTime = 0;
    const target = brake * BRAKE.breakForceN;
    const delta = BRAKE.releaseRate * dt;
    if (state.pedalForce > target) {
      state.pedalForce = Math.max(target, state.pedalForce - delta);
    } else {
      state.pedalForce = Math.min(target, state.pedalForce + delta);
    }
  }
  if (state.pedalForce >= BRAKE.breakForceN) {
    state.pedalForce = BRAKE.breakForceN;
    state.snapped = true;
  }
  return state.snapped;
}

/** 手动判定断裂（撞路障结算时同步钳位用） */
export function forceSnap(state: PedalState): void {
  state.pedalForce = BRAKE.breakForceN;
  state.holdTime = 0;
  state.snapped = true;
}

export function resetPedal(state: PedalState): void {
  state.pedalForce = 0;
  state.holdTime = 0;
  state.snapped = false;
}
