/**
 * 踏板力模型（纯函数，保留原版高潮机制）：
 * - b ≥ 0.98：过载爬升 pedalForce += (rampBase + 2×rampGrowth×holdTime)×dt，
 *   达 breakForceN → brake_snap
 * - b < 0.98 且未断裂：pedalForce 以 releaseRate 向 b×breakForceN 松弛
 */
import { BRAKE, REDUNDANCY } from '../config/physics';

export interface PedalState {
  /** 当前踏板力 N（断裂后归零：踏板已脱开，驾驶员踩空） */
  pedalForce: number;
  /** 满程保持时长 s */
  holdTime: number;
  /** 是否已断裂 */
  snapped: boolean;
  /** 断裂时刻（刹车段计时 s），未断裂为 null —— 冗余制动与结算展示用 */
  snapTime: number | null;
  /** 冗余制动建压进度 0~1（断裂后从 0 平滑升到 1，避免制动力阶跃） */
  redundancy: number;
}

export function createPedalState(): PedalState {
  return { pedalForce: 0, holdTime: 0, snapped: false, snapTime: null, redundancy: 0 };
}

/**
 * 推进一步踏板状态。
 *
 * 断裂语义（玩法改版，与旧版的关键差异）：
 * - 旧版：断裂 → 上层立即 crash('brake_snap') → cannon 翻滚 → 失败结算
 * - 新版：断裂 → 踏板力归零（踩空）+ 冗余建压接管，车辆继续行驶直至停下。
 *   是否判负由上层决定：冗余刹停 = 判负（制动系统已失效），撞路障 = 判负（翻滚）。
 *
 * @param brake 刹车滑条 0~1
 * @param elapsed 刹车段已用时 s（记录断裂时刻）
 * @returns 本步是否**新**触发断裂（已断裂时返回 false，避免重复派发事件）
 */
export function stepPedal(
  state: PedalState,
  dt: number,
  brake: number,
  elapsed = 0
): boolean {
  if (state.snapped) {
    // 踏板已脱开：踏板力保持 0，冗余制动持续建压直至满压
    state.redundancy = Math.min(1, state.redundancy + dt / Math.max(1e-3, REDUNDANCY.rampSeconds));
    return false;
  }
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
    // 断裂瞬间：峰值由上层记录（peakForce = breakForceN），此处踏板力归零
    // —— 踏板已脱开，驾驶员踩空，滑条再怎么踩都不产生作用力
    state.pedalForce = 0;
    state.snapped = true;
    state.snapTime = elapsed;
    state.holdTime = 0;
    state.redundancy = 0;
    return true;
  }
  return false;
}

/** 冗余制动当前生效的减速度 m/s²（建压未完成时为 0~目标值之间；未断裂恒为 0） */
export function redundancyDecel(state: PedalState): number {
  if (!state.snapped) return 0;
  return (
    BRAKE.breakForceN *
    REDUNDANCY.forceRatio *
    BRAKE.decelPerNewton *
    Math.min(1, state.redundancy)
  );
}

/** 手动判定断裂（结算/诊断同步钳位用）；冗余立即满压 */
export function forceSnap(state: PedalState): void {
  state.pedalForce = 0;
  state.holdTime = 0;
  state.snapped = true;
  state.redundancy = 1;
}

export function resetPedal(state: PedalState): void {
  state.pedalForce = 0;
  state.holdTime = 0;
  state.snapped = false;
  state.snapTime = null;
  state.redundancy = 0;
}
