/**
 * R46 / Phase 2 · 高精度车模加载偏好与取消信号（LOAD-A 配置真源）。
 *
 * 设计口径（REPORT_PHASE1B.md §2.3 / §2.4）：
 *  - 偏好 key `v800.highDetail`，值 `'on' | 'off'`，缺省/脏值一律回落 `'on'`；
 *    优先级 URL `#highDetail=on|off` > localStorage > 默认 on —— 与
 *    `config/vehicles.ts`（`v800.vehicle`）/ `config/vehiclePaint.ts`（`v800.paint`）同风格。
 *  - 取消信号用**发布订阅**放在本模块（配置真源），`ExternalShell.ts` 订阅、
 *    `Menu.ts` 发布 ⇒ UI 线不依赖 ExternalShell 内部实现，加载控制仍由几何/运行时线
 *    在 ExternalShell.ts 统一实现（BRIEF.md:47 接口契约）。
 *
 * ⚠ Node / vitest 隔离（BRIEF.md:53）：模块顶层**绝不**访问 window / localStorage；
 * 所有读写入口都在函数内带 `typeof window/localStorage === 'undefined'` 守卫 + try/catch。
 * `ExternalShell.inTestEnv()` 是 `loadExternalShell` 的第一条语句，测试环境下新门禁根本
 * 不会被执行，故不会触碰本地存储、也不会发 fetch。
 */
export type ShellCancelReason = 'user' | 'preference';

/**
 * 各车高精度资产总量（MB，解压后口径）—— HUD 进度文案与菜单恢复文案的**单一真源**。
 * 实测：v800 ≈48M（body 38M + glass 6M + 语义件/贴图），r7 ≈47M（body 27M + 双轮 15.1M + …）。
 * 取代 R45 写死的「首次加载约 45 MB」（REPORT_PHASE1B.md §1.3 感知源 ③）。
 */
export const SHELL_TOTAL_MB: Readonly<Record<'v800' | 'r7', number>> = {
  v800: 48,
  r7: 47
};

const STORAGE_KEY = 'v800.highDetail';
const HASH_RE = /(?:^|[#&])highDetail=(on|off)/i;

/** URL hash 覆盖（QA / 分享链接直达）；Node 下返回 null 交给 localStorage/默认值 */
function readHashOverride(): boolean | null {
  if (typeof window === 'undefined') return null;
  const m = HASH_RE.exec(window.location.hash);
  return m ? m[1].toLowerCase() === 'on' : null;
}

/** 本地偏好；存储不可用 / 脏值一律回落「允许高精度」 */
function readPreference(): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    // Safari 无痕 / 禁用存储：静默降级，不允许把主流程搞崩
    return true;
  }
}

/** 当前是否允许下载高精度车模：URL > localStorage > 默认 on */
export function isHighDetailEnabled(): boolean {
  return readHashOverride() ?? readPreference();
}

/** 写入偏好（调用方：Menu 的停止/恢复按钮；调用方随后按需 location.reload()） */
export function setHighDetailEnabled(on: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* 存储不可用时忽略：本次会话仍以 URL hash / 默认值运行 */
  }
}

/* ───────────────────────────── 取消信号（发布订阅） ───────────────────────────── */

type CancelListener = (reason: ShellCancelReason) => void;
const cancelListeners = new Set<CancelListener>();
let lastCancelReason: ShellCancelReason | null = null;

/** 订阅取消事件；返回 unsubscribe（调用方在加载结束时注销，防泄漏） */
export function onShellCancel(listener: CancelListener): () => void {
  cancelListeners.add(listener);
  return () => {
    cancelListeners.delete(listener);
  };
}

/**
 * 发布取消。幂等：重复调用只是重复通知订阅者（AbortController.abort 本身幂等）。
 * `reason='user'` = 菜单点「停止下载」；`reason='preference'` = 落盘的默认普通车模。
 */
export function cancelExternalShellLoad(reason: ShellCancelReason = 'user'): void {
  lastCancelReason = reason;
  for (const fn of [...cancelListeners]) {
    try {
      fn(reason);
    } catch (err) {
      console.warn('[highDetail] cancel listener failed:', err);
    }
  }
}

/** 本次会话是否已取消（reload 后模块级状态自然复位） */
export function isShellLoadCancelled(): boolean {
  return lastCancelReason !== null;
}

export function shellCancelReason(): ShellCancelReason | null {
  return lastCancelReason;
}
