// ⚠ 从 'vitest/config' 取 defineConfig 而不是 'vite'：下面带 `test` 段，
//   用 vite 的 defineConfig 会被 tsc 判「对象字面量只能指定已知属性」（vite.config.ts 在
//   tsconfig 的 include 里，属于 `npm run build` 的 `tsc --noEmit` 门禁范围）。
//   'vitest/config' 导出的是 vite UserConfig 的超集，build 段行为完全一致。
import { defineConfig } from 'vitest/config';

// three@0.186.1 的 package.json exports 已内置 "three/addons/*" 映射，
// 无需额外 alias；base 用相对路径便于静态托管。

/**
 * R7 懒加载 chunk 的**共享模块集**（main 入口 ∩ R7Adapter 动态入口的传递闭包交集）。
 * 推导探针（esbuild metafile，只读不改构建）：`.qa/r32_tmp_audit/r32_policy_probe.mjs`
 * 同款的 shared-chunk 分析法 —— 结论写死在下表，共 6 个 src 模块 + node_modules/three 全域。
 *
 * ⚠ 维护纪律：若 A/D 线改了 `src/model`、`src/util`、`src/config/quality.ts` 的跨车
 *   import 关系（新增/删除 R7Adapter 与主装配路径的共用模块），必须重跑探针同步本表 ——
 *   否则 rollup 会把漏登记的共用模块另建一个**启发式命名的自动块**（三块结构被破坏，
 *   正是 N13 要消灭的「plateTexture」式误名回归）。
 *
 * R32 C-3 C2 线静态复核（2026-10-25，**未跑 vite build**，纯读码取证）：
 *   主装配路径（静态）= `Game.ts:17 import { createV800CarAdapter } from '../model/V800Adapter'`
 *     ⇒ V800Adapter → createV800Model + parts/* + batchMerge/refTextures/plateTexture
 *       + interiorTextures + util/geo + util/math + config/quality + config/physics；
 *   懒加载入口（动态）= `Game.ts:58 await import('../model/R7Adapter')`（仅 resolveVehicleId()==='r7'）
 *     ⇒ R7Adapter → batchMerge / refTextures / plateTexture / config/quality / util/math
 *       + createR7Model（**R7 独有**，六千余行）。
 *   交集（→ 必须进 shared）：three 核心 + addons（EffectComposer/RenderPass/UnrealBloomPass/
 *     RoomEnvironment/OrbitControls/BokehPass 两边都引用，**不存在 R7 独有 addon**）
 *     + 上表 6 个 src 模块 ⇒ 登记完整，无漏项。
 *   R7 独有：createR7Model + R7Adapter 本体 ⇒ manualChunks 返回 undefined ⇒ 留在懒加载块，
 *     V800 玩家不下载 ⇒ **R7 懒加载收益未被破坏**。
 *   ⚠ 构建数字（块名/体积）本线不验，由后续阶段统一跑 build 核对。
 */
const SHARED_SRC = [
  'src/config/quality.ts',
  'src/model/batchMerge.ts',
  'src/model/plateTexture.ts',
  'src/model/refTextures.ts',
  'src/util/geo.ts',
  'src/util/math.ts'
] as const;

export default defineConfig({
  base: './',
  /**
   * R33 F1 · 小内存机器上的 vitest 鲁棒性（`tests/r32_zone.test.ts` OOM）。
   *
   * 根因：r32_zone.test.ts 里 5 个 `it` 各自 `new Castle(scene, high)`（high 档城堡
   * 全量几何 + 石材贴图 canvas），默认 pool 是 **threads**（worker_threads），
   * 多文件并发时**每个 worker 各自持一份 Castle 常驻堆**且 dispose 后 worker
   * 不立刻释放 ⇒ 峰值内存 = 并发文件数 × 城堡堆。本机 RAM 受限时直接 OOM：
   * 而且是**确定性**的（与 A 线几何同向增长，A 线再铺量只会更早炸）。
   *
   * 为什么选 `pool: 'forks'` 而不是别的：
   *   · forks = 一测试文件一子进程 ⇒ 进程退出时**整段堆被 OS 回收**，
   *     不存在 threads 那种「worker 复用 + GC 不彻底」的驻留；
   *   · 代价只是进程启动开销（本仓库测试文件少、单文件跑 5~10s，启动成本可忽略）；
   *   · 不用 `isolate:false`（那会让同进程内多文件共享堆，**更**容易 OOM），
   *     也不用 `singleThread`（会把全部文件塞进一个进程，同样堆叠加）。
   *   · `maxWorkers=2` 仍由命令行给（CI/本机按需调），配置里不写死并发数。
   * 若仍 OOM ⇒ 走 F1 ②号预案（改 r32_zone.test.ts 用 low 档 Castle，见该文件注释）。
   */
  test: {
    pool: 'forks'
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        /**
         * N13（R32 C-3）：manualChunks 语义命名。
         *
         * 改前：无 manualChunks ⇒ rollup 对「入口 ∩ 动态 import」自动共享块用启发式
         * 命名，实测把**整团共用模块**（three 核心 + addons + 跨车共享的 src 挂件层）
         * 命名为 `plateTexture-*.js`（误导：块内 95% 是 three 核心符号，与车牌贴花
         * 模块无关；dist 实测 main 1,582KB + plateTexture 609KB + R7Adapter 722KB）。
         *
         * 改后：显式把共用模块集归入 `shared` 块 ⇒ 仍是 main + shared + R7Adapter
         * **三块结构**、体积不变（只改名），R7 懒加载收益不受影响（V800 玩家不下载
         * R7Adapter；shared 被两边共用故必下）。
         * 为什么不再拆 `vendor`：three 核心与 addons 没有第三个消费方，拆开只会多出
         * 一块、破坏「main 1,582KB + shared 609KB + R7Adapter 722KB」现状。
         */
        manualChunks(id: string): string | undefined {
          // rollup 的 id 在 Windows 可能是反斜杠，统一成正斜杠再匹配
          const p = id.split('\\').join('/');
          if (p.includes('/node_modules/three/')) return 'shared';
          if (SHARED_SRC.some((m) => p.endsWith('/' + m))) return 'shared';
          return undefined;
        }
      }
    }
  }
});
