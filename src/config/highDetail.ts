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
 *
 * ══ R137 · 高精度 GLB 按 GPU 类别默认门控（数据驱动，承 R133 核显像素预算）══════
 * 实测（本机 Arc iGPU + 生产构建 #perfhud）：高精度外部壳 `body.glb 966,484 + 4 轮 303,521
 * = 1,270,005 tri`（V800Adapter.ts:5598），整帧 `tris(frame) 1,503,898`（车 1.27M + 城 185k
 * + 地形/路 ~30k）；`#highDetail=off` 对照整帧 `tris 145,900` ⇒ **车模 GLB 是核显几何成本主因**
 * （8.7×），非建筑。R132–R136 优化的是城市填充率（185k），车模 1.27M 才是帧时大头。
 * 处方：**核显默认不自动加载高精度 GLB（回落程序化 82k 车模），显式 `#highDetail=on` /
 * localStorage='on' 仍可强制开启**——P0=运行时流畅度、R43 瓶颈=填充率/顶点吞吐，1.27M 在
 * iGPU 上 60fps 需 ~270M vert/s（远超其吞吐）。默认改为 GPU 感知：`hash > 存储 > (核显 ? off : on)`，
 * 离散机行为逐位不变。
 */
export type ShellCancelReason = 'user' | 'preference';

import type { GpuClass } from './quality';

/**
 * 各车高精度资产总量（MB，解压后口径）—— HUD 进度文案与菜单恢复文案的**单一真源**。
 * 实测：v800 ≈48M（body 38M + glass 6M + 语义件/贴图），r7 ≈47M（body 27M + 双轮 15.1M + …）。
 * 取代 R45 写死的「首次加载约 45 MB」（REPORT_PHASE1B.md §1.3 感知源 ③）。
 *
 * R98：仰望单 GLB ≈40MB 亦纳入本表，令 YangwangAdapter 复用 ExternalShell 的统一 HUD
 * 进度函数（`shellHudProgress` 读本表算总量口径），不再各写一套 MB 文案。
 */
export const SHELL_TOTAL_MB: Readonly<Record<'v800' | 'r7' | 'yangwang', number>> = {
  v800: 48,
  r7: 47,
  yangwang: 40
};

const STORAGE_KEY = 'v800.highDetail';
const HASH_RE = /(?:^|[#&])highDetail=(on|off)/i;

/** URL hash 覆盖（QA / 分享链接直达）；Node 下返回 null 交给 localStorage/默认值 */
function readHashOverride(): boolean | null {
  if (typeof window === 'undefined') return null;
  const m = HASH_RE.exec(window.location.hash);
  return m ? m[1].toLowerCase() === 'on' : null;
}

/**
 * 本地偏好；`null` = 无存储值（区分「未设置」与「显式 off」，R137 需要把「未设置」交给
 * GPU 感知默认）。存储不可用 / 脏值 → `null`（回落默认）。
 */
function readStoredPreference(): boolean | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === null) return null;
    return v !== 'off';
  } catch {
    // Safari 无痕 / 禁用存储：静默降级，不允许把主流程搞崩
    return null;
  }
}

/* ───────────────────────── R137 · GPU 类别注入（配置真源） ─────────────────────────
 * main.ts 在 `createQualitySettings()` 后调用 `setActiveGpuClass(quality.gpuClass)` 注入
 * 运行时 GPU 类别（`quality.gpuClass = #gpufake ?? detectGpuClass()`，故 DEV 下 `#gpufake`
 * 仍可 A/B 门控）。默认 'unknown' ⇒ 高精度默认开（离散机/未知行为不变）。
 */
let activeGpuClass: GpuClass = 'unknown';

export function setActiveGpuClass(gpu: GpuClass): void {
  activeGpuClass = gpu;
}

export function getActiveGpuClass(): GpuClass {
  return activeGpuClass;
}

/**
 * 当前是否允许下载高精度车模：URL > localStorage > GPU 感知默认。
 * R137：默认 = `gpuClass` 非弱类（`integrated` / `software` 回落程序化车模，
 * `discrete` / `unknown` 仍开——unknown 不改行为避免误降未识别机）。
 * 显式 `#highDetail=on` / localStorage='on' 优先级最高，弱类仍可强制开启。
 */
export function isHighDetailEnabled(gpuClass: GpuClass = getActiveGpuClass()): boolean {
  const hash = readHashOverride();
  if (hash !== null) return hash;
  const stored = readStoredPreference();
  if (stored !== null) return stored;
  // 弱 GPU 类（核显 / 软渲）默认回落程序化车模；离散 / 未知保持高精度
  return gpuClass !== 'integrated' && gpuClass !== 'software';
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
