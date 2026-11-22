/**
 * R136：perfhud 文本格式化（纯函数，可单测）。
 *
 * 背景：main.ts 的 perfhud 角标原本被 `import.meta.env.DEV` 门控 ⇒ **生产构建完全不含**，
 * 用户线上（Pages）无法用 `#perfhud` 实测 FPS/DPR，只能凭"感觉"反馈「继续优化」；
 * 而项目内 Renderer.ts 的 R68_GLDIAG 钩子（`R68_GLDIAG_ON`，默认 on）**已是生产可用**——
 * 注释明确「生产构建亦可用（不依赖 import.meta.env.DEV）⇒ 线上真机 `#framelog`/`#perfhud`
 * DEV-only 取不到数时，本钩子仍可导出证据」。main.ts 的 DEV 门控与之不一致（遗漏）。
 *
 * R136 修复：① main.ts perfhud 改为生产可用（仅 hash 门控，默认关，运行时零开销）；
 * ② 角标新增**质量档行**——gpuClass / tier / msaa / bloom / shadow / floor，让用户一眼
 * 确认 R133（Arc 核显→integrated 预算）真生效、并观测自适应 pixelRatio 实时降档。
 * 本文件只做**字符串格式化**（无 DOM、无 three 依赖），供 main.ts 与 r136 测试共用。
 */
import type { QualitySettings } from '../config/quality';

/** perfhud 每 500ms 一刷的实测快照（main.ts 采集，本模块只格式化） */
export interface PerfHudStats {
  fps: number;
  dpr: number;
  calls: number;
  tris: number;
  t: number;
}

/**
 * 两行角标文本：
 * 行 1 = 运行时实测（FPS / 自适应后 DPR / 整帧累计 draw call / 三角面数 / 运行秒）；
 * 行 2 = 质量档（GPU 分类 / tier / MSAA / bloom 分辨率 / shadow 尺寸 / pixelRatio 降档 floor）。
 * 行 2 是 R133-R135 修复的**落地可见证据**：用户本机若显示 `GPU integrated | msaa 2 | bloom 0.375
 * | shadow 768`，即确认核显预算生效（旧逻辑会错误显示 `GPU discrete | msaa 4 | bloom 1`）。
 */
export function formatPerfHudText(quality: QualitySettings, s: PerfHudStats): string {
  const line1 =
    `FPS ${s.fps} | DPR ${s.dpr.toFixed(2)} | ` +
    `calls(frame) ${s.calls} | tris(frame) ${s.tris} | t=${s.t.toFixed(1)}s`;
  const line2 =
    `GPU ${quality.gpuClass} | tier ${quality.tier} | msaa ${quality.msaaSamples} | ` +
    `bloom ${quality.bloomScale} | shadow ${quality.shadowMapSize} | floor ${quality.minPixelRatio}`;
  return `${line1}\n${line2}`;
}
