/**
 * R29 走廊探针入口 —— 只为 `tools/r29_corridor_probe.mjs` 服务。
 *
 * castleKit.ts 是 TS + three，浏览器侧代码；node 里没法直接 import。
 * 这里把 8 个工厂函数 + Terrain（查远景岩环是否横穿走廊）原样 re-export，
 * 由 `r29_probe_build.mjs` 用 esbuild JS API 打成 `r29_probe_bundle.mjs`
 * （**不能用 esbuild CLI**：本机 CLI 会 exit 2 无输出）。
 */
export {
  makeViaduct,
  makeParapet,
  makeLamps,
  makeGate,
  makeTowerGroup,
  makeInnerCity,
  makeMainHall,
  makePaving,
  setDetailLevel
} from '../src/render/scene/castleKit';
export type { StoneBuckets } from '../src/render/scene/castleKit';
export { Terrain } from '../src/render/scene/Terrain';
