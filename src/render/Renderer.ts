/**
 * WebGLRenderer + 质量档。
 * antialias 按 quality、pixelRatio ≤ 2、ACESFilmic exposure 0.85、
 * SRGB 输出、PCF 阴影。
 * 注：three r186 已移除 PCFSoftShadowMap（运行时警告并强制回退 PCFShadowMap，
 * 见 WebGLShadowMap.js），故直接显式使用 PCFShadowMap，消除控制台警告。
 *
 * ── R68 P1-7 · 方向盘高精度移动黑帧「真机定标」钩子 ───────────────────────────
 * 开发线 Phase 1 实证：全库 `webglcontextlost` / `contextrestored` 监听**零命中**；
 * 运行时加载的是库内 52k-tri 减面版 `steering.glb`（非桌面 1.5M 版），本环境不可复现，
 * 判真机 GPU 侧 WebGL 上下文丢失 / TDR ⇒ **不盲改方向盘几何 / 材质 / 贴图**，
 * 只加只读诊断钩子，把「黑帧是否伴随 contextLost」变成可机读证据。
 * 开关真源 `R68_GLDIAG_ON` 在 ExternalShell.ts 文件末尾（七个 R68 开关同源）；
 * `#r68gldiag=off` ⇒ 不注册监听、不挂全局，逐位回 R67。
 * ⚠ 生产构建亦可用（不依赖 import.meta.env.DEV）⇒ 线上真机 `#framelog` / `#perfhud`
 *   DEV-only 取不到数时，本钩子仍可导出证据。
 */
import * as THREE from 'three';
import type { QualitySettings } from '../config/quality';
import { R68_GLDIAG_ON } from '../model/external/ExternalShell';

/** 真机诊断台账（挂 `window.__r68glDiag`，QA / console 直接读）。 */
export interface R68GlDiag {
  readonly enabled: boolean;
  contextLostCount: number;
  contextRestoredCount: number;
  /** performance.now() 时间戳（ms），null = 未发生 */
  lastContextLostAt: number | null;
  lastContextRestoredAt: number | null;
  /** 当前机位（由 Game / QA 侧 setContext 注入；本波不扩 Game.ts 白名单，恒 null 待接线） */
  view: string | null;
  /** 方向盘 mesh tri（同上，待接线） */
  steeringTriangles: number | null;
  /** 恢复后回调预留（本波只留钩子、不切档） */
  onRestored: (() => void) | null;
  /** 机位分档加载开关预留（本波不切档） */
  tierByView: boolean;
  /** 一次性快照：renderer.info + GL 名 + 上下文丢失计数 */
  snapshot(): Record<string, unknown>;
  /** 供 Game / QA 注入机位与方向盘 tri（不改 Game.ts 也能用） */
  setContext(view: string | null, steeringTriangles: number | null): void;
}

/** 读真实 GPU 名（WEBGL_debug_renderer_info 取不到退回空串，与 quality.ts:134 同源取法）。 */
function gpuName(renderer: THREE.WebGLRenderer): string {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info') as
      | { UNMASKED_RENDERER_WEBGL: number }
      | null;
    if (!ext) return '';
    return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '');
  } catch {
    return '';
  }
}

export function createRenderer(container: HTMLElement, quality: QualitySettings): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: quality.antialias,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(quality.pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  if (R68_GLDIAG_ON && typeof window !== 'undefined') {
    const diag: R68GlDiag = {
      enabled: true,
      contextLostCount: 0,
      contextRestoredCount: 0,
      lastContextLostAt: null,
      lastContextRestoredAt: null,
      view: null,
      steeringTriangles: null,
      onRestored: null,
      tierByView: false,
      setContext(view, steeringTriangles) {
        this.view = view;
        this.steeringTriangles = steeringTriangles;
      },
      snapshot() {
        const info = renderer.info;
        return {
          t: performance.now(),
          gpu: gpuName(renderer),
          pixelRatio: renderer.getPixelRatio(),
          contextLostCount: this.contextLostCount,
          contextRestoredCount: this.contextRestoredCount,
          lastContextLostAt: this.lastContextLostAt,
          lastContextRestoredAt: this.lastContextRestoredAt,
          view: this.view,
          steeringTriangles: this.steeringTriangles,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
          programs: info.programs?.length ?? 0,
          calls: info.render.calls,
          triangles: info.render.triangles,
          frame: info.render.frame
        };
      }
    };
    const canvas = renderer.domElement;
    canvas.addEventListener('webglcontextlost', (event) => {
      // 必须 preventDefault：否则浏览器不会派发 contextrestored（three 自身监听也这么做）
      event.preventDefault();
      diag.contextLostCount += 1;
      diag.lastContextLostAt = performance.now();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      // three r186 的 WebGLRenderer 自己会在 restored 时 initGLContext() 重建资源；
      // 这里只记录 + 复位统计 + 暴露回调，**不重复创建 renderer**（会破坏 Game 引用）。
      diag.contextRestoredCount += 1;
      diag.lastContextRestoredAt = performance.now();
      renderer.info.reset();
      diag.onRestored?.();
    });
    (window as unknown as { __r68glDiag?: R68GlDiag }).__r68glDiag = diag;
  }

  return renderer;
}
