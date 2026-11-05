/**
 * R47 · 动态模糊（SpeedBlur）用户开关配置真源。
 *
 * 用户明确要求「加入动态模糊开关的选项，默认不开」：
 *  - 缺省 = **关闭**（与 R46 的缺省开启相反，本模块是唯一真源）；
 *  - 打开后才走 R46 FX-A（真实渲染跳距驱动 + 一阶滞后）；
 *  - 关闭时 Game 直接把强度写 0 且 `dt=0, smooth=false` ⇒ Postfx 走「直写」分支，
 *    **无滞后余晖**（不会出现关掉后还糊一帧）。
 *
 * 优先级：URL `#motionBlur=on|off` > localStorage > 默认 off。与
 * `config/highDetail.ts` / `config/vehiclePaint.ts` 同风格。
 *
 * ⚠ 性能：`isMotionBlurEnabled()` 每帧被 Game 调 2 次（挑战 / 自由各 1），
 *   因此用模块级 `cached` 缓存，首读之后不再碰 localStorage / window.location。
 *   `setMotionBlurEnabled()` 同时刷新缓存 ⇒ 菜单点开关**即时生效，无需 reload**。
 * ⚠ Node / vitest 隔离：模块顶层绝不访问 window / localStorage；所有读写在
 *   函数内带 typeof 守卫 + try/catch；`resetMotionBlurForTest()` 供契约测试复位。
 */
const STORAGE_KEY = 'v800.motionBlur';
const HASH_RE = /(?:^|[#&])motionBlur=(on|off)/i;

/** URL hash 覆盖（QA / 分享链接直达）；Node 下返回 null 交给偏好/默认值 */
function readHashOverride(): boolean | null {
  if (typeof window === 'undefined') return null;
  const m = HASH_RE.exec(window.location.hash);
  return m ? m[1].toLowerCase() === 'on' : null;
}

/** 本地偏好；存储不可用 / 脏值（含缺省）一律回落「关闭」 */
function readPreference(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

let cached: boolean | null = null;

/** 当前是否启用动态模糊：URL > localStorage > 默认 off */
export function isMotionBlurEnabled(): boolean {
  if (cached === null) cached = readHashOverride() ?? readPreference();
  return cached;
}

/** 写入偏好并即时刷新缓存（调用方：Menu 的开关按钮；不 reload） */
export function setMotionBlurEnabled(on: boolean): void {
  cached = on;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* 存储不可用时忽略：本次会话仍以缓存值运行 */
  }
}

/** 仅测试用：复位模块级缓存（模拟新会话 / 换 hash 后重读） */
export function resetMotionBlurForTest(): void {
  cached = null;
}
