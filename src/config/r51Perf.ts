/**
 * R51 Phase 2-A · 性能线配置真源 + 加载期 gate 状态机
 * （白名单独占：src/config/**；只被 Game.ts / src/fx/index.ts 消费，不进 R7 动态入口）
 *
 * ══ 为什么把 gate 放在 config/ 而不是 Game.ts 内联 ═══════════════════════════
 * 主理人 Phase 2-A 裁决：方案 A 必须采用 `markShellAssembled()` **显式标记**，
 * 且标记须挂在「外部壳真实装配完成 + 首帧已渲染」之后，**不是 fetch 完成**；
 * R45 曾因异步壳加载期间提前结束 loading 导致线上高精度车模不可见（ExternalShell.ts
 * 的字节进度 / 就绪 / 失败状态条修复），禁止回退。
 *
 * 本模块只提供「信号 + 状态机」，**不判定装配是否完成**：装配硬证据由 Game.ts 在
 * `postfx.render()` 之后（= 首帧已渲染）遍历场景树读 `userData.r44External` 得到
 * （该标记是 V800Adapter/R7Adapter 在 `body.add(shell.bodyMesh)` 之前打的，属「已挂树」
 * 证据，而非 `r44ShellStatus.state==='ready'` 的 fetch/parse 完成态）。
 * ⇒ Game 侧检测到「state=ready + 已挂树 + 本帧已渲染」三条件同时成立后，才调用本模块的
 *   `markShellAssembled()`；调用点即主理人要求的显式标记点。
 *
 * ══ 8s 软超时语义（主理人裁决，极易被误实现，写在最前面）═════════════════════
 * `SHELL_GATE_TIMEOUT_MS` 到点**只置 `timedOut` 标记**（供 DEV 诊断日志），
 * **绝不 resolve gate、绝不触发 onReady、绝不提前 hideLoading()**。
 * 放行只有两个入口：
 *   ① `markShellAssembled()` —— 壳真实装配完成且首帧已渲染；
 *   ② `markShellUnavailable()` —— `r44ShellStatus.state === 'failed' | 'cancelled'`
 *      （ExternalShell.ts:1125-1138 的既有失败/取消终态，二者都不会再有壳到达）。
 * 用户已授权「首次构建时长无限制」⇒ 48MB 慢网继续等加载屏是**预期行为**，
 * 而不是 bug；宁可加载屏多等，也不能重演 R45「提前放行 ⇒ 高模不可见」。
 *
 * ⚠ Node / vitest 隔离：模块顶层**绝不**访问 window / localStorage；所有 hash 读取
 *   在函数内带 `typeof window === 'undefined'` 守卫。`resetShellGateForTest()` 供契约测试复位。
 * ⚠ 键名不得含子串 `noprewarm`：Game.ts:575 的入口守卫是 `hash.includes('noprewarm')`，
 *   命中会连带跳过整段 prewarmGpu（R41 已有一次踩坑，见 prewarmGpu 注释）。
 */
import type { VehicleId } from './vehicles';

/** 8s 软超时：仅诊断标记，不放行（见文件头） */
export const SHELL_GATE_TIMEOUT_MS = 8000;

/** 不会有任何外部壳到达的终态（放行条件②） */
export const SHELL_NO_SHELL_STATES: readonly string[] = ['failed', 'cancelled'];

/** 只有显式给出 `=off` 才关闭；缺省 / 脏值一律默认开启（与 R46/R47 钩子同风格） */
function readOff(key: string): boolean {
  if (typeof window === 'undefined') return false;
  return new RegExp(`(?:^|[#&])${key}=off`, 'i').test(window.location.hash);
}

/** A：加载期 gate（默认开）。`#r51loadgate=off` ⇒ 逐位回 R50：首帧 rAF 即 hideLoading */
export function isR51LoadGateEnabled(): boolean {
  return !readOff('r51loadgate');
}
/** B：FX 空池零递交（默认开）。`#r51fxidle=off` ⇒ 恢复恒全量递交 */
export function isR51FxIdleEnabled(): boolean {
  return !readOff('r51fxidle');
}
/** E：每物理步 SessionInput 载荷复用（默认开）。`#r51zerogc=off` ⇒ 恢复每步对象字面量 */
export function isR51ZeroGcEnabled(): boolean {
  return !readOff('r51zerogc');
}
/** A2：静态子树矩阵冻结（默认开）。`#r51matfreeze=off` 回退 */
export function isR51MatFreezeEnabled(): boolean {
  return !readOff('r51matfreeze');
}
/** A3：cabin↔外景双 program 变体加载期预编译（默认开）。`#r51sidewarm=off` 回退 */
export function isR51SideWarmEnabled(): boolean {
  return !readOff('r51sidewarm');
}

export type ShellGateState = 'waiting' | 'assembled' | 'no-shell';

let gateState: ShellGateState = 'waiting';
let gateReady: (() => void) | null = null;
let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
let timedOut = false;

function clearTimer(): void {
  if (timeoutHandle !== null) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
}

function settle(next: Exclude<ShellGateState, 'waiting'>): void {
  if (gateState !== 'waiting') return; // 幂等：只放行一次
  gateState = next;
  clearTimer();
  const fn = gateReady;
  gateReady = null;
  if (fn) fn();
}

/**
 * 注册 gate 等待者。`onReady` **只**由 markShellAssembled / markShellUnavailable 触发，
 * 8s timer 到点不触发（见文件头）。若 gate 已 settle（例如终态早于注册），立即同步回调。
 */
export function waitForShellGate(onReady: () => void): void {
  if (gateState !== 'waiting') {
    onReady();
    return;
  }
  gateReady = onReady;
  if (timeoutHandle === null) {
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      timedOut = true; // 只记标记：不 settle、不 onReady、不 hideLoading
    }, SHELL_GATE_TIMEOUT_MS);
  }
}

/**
 * 显式标记：外部壳**真实装配完成**且**首帧已渲染**。
 * 唯一调用点 = Game.pollShellGate()，位于 postfx.render() 之后。
 */
export function markShellAssembled(): void {
  settle('assembled');
}

/** 显式标记：加载失败 / 用户取消下载 / QA 停用外部壳 ⇒ 走既有失败分支 */
export function markShellUnavailable(): void {
  settle('no-shell');
}

export function shellGateState(): ShellGateState {
  return gateState;
}

/** 8s 软超时是否已到（仅诊断，不代表可放行） */
export function shellGateTimedOut(): boolean {
  return timedOut;
}

/** 仅测试用：复位模块级状态（模拟新会话） */
export function resetShellGateForTest(): void {
  clearTimer();
  gateState = 'waiting';
  gateReady = null;
  timedOut = false;
}

/**
 * 读取当前车型外部壳状态（Game.pollShellGate 每帧调，仅 gate 未 settle 期间）。
 * 只读 window.__r44Shell 台账（ExternalShell.ts:107-114 暴露），不 import model/**，
 * 避免跨白名单依赖；Node / 台账未建立时返回 null（≠ 放行，只是继续等）。
 */
export function readShellStatus(car: VehicleId): string | null {
  if (typeof window === 'undefined') return null;
  const table = (window as unknown as {
    __r44Shell?: Record<string, { state?: string }>;
  }).__r44Shell;
  return table?.[car]?.state ?? null;
}
