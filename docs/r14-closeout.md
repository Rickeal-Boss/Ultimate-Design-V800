# R14 波收尾报告（2026-10-18）

基线 `d888b80`（R13）。本波四条并行线：玩法（play）、几何（geo）、座舱（intex）、性能（perf）。

## 结论速览

| 线 | 状态 | 落点 |
|---|---|---|
| play | ✅ 完成 | 制动温度 ×4 + 2s 热保护断力，测试 20→26 |
| perf | ✅ 完成 | 相机 dt 解耦（抽搐根因）、核显画质收敛、HUD 载荷复用、`#fprobe` |
| geo | ✅ 完成 | MPV 臀线（最浅内收 0.412→0.160 m）、纵向尾灯、顶盖后檐减薄 0.24→0.096 |
| scene | ✅ 完成 | 河谷 z=−450 / 水面 y=−4.4 / 桥面 ±7.4 / 落水阻尼，桥下是水、车能翻下桥 |
| intex | ⚠️ 部分 | 座舱机位与视野已修；参考图贴图（P1）未启动，转 R15 |

## 验证

- `npx tsc --noEmit` → 0 error
- `npx vitest run` → **66/66**（audio 19 + redundancy 21 + physics 26）
- `npx vite build` → ✓
- `#uvassert` 全部三角形 UV 在合法分区、无 >8x 各向异性拉伸
- `#batchmerge` mesh 188 → 72，可见 182 → 66，Draw Call −116
- 车模 `#assembled`：tris 62,672 / DC 71（可见 66）

## 两个被证伪的假设（重要）

1. **「后风挡是个洞」—— 证伪。** 从车尾 +Z 侧做 Y 1.20→1.86 射线扫描，
   Y=1.46~1.74 稳定命中 `greenhouse-glass@2.818~2.820`：后窗有玻璃，只是 `glass-dark`
   隐私玻璃透出舱内座椅，视觉上像空洞。**不要**再把它当几何缺口去补。
2. **「仪表台存在 1.3 m³ 实体大方块」—— 证伪。** `steering-spokes` 的 bbox 是
   InstancedMesh 探针伪影（射线未乘 instanceMatrix）。真正的遮挡来自「眼点在座椅壳内
   ＋前挡从车内是灰板」，见 `docs/wip-intex-r14.md`。

## 探针工具（本波新增，可复用）

- `.img2threejs/tools/r14_cdp.mjs` — 连已启动的 Edge，支持
  `meshes | vscan | pick | camsweep | shots | closeup | hide`；
  `closeup` 支持 `HIDEMAT` / `HIDECOMP` 前置隐藏（消去法）。
- `.img2threejs/tools/r14-run.ps1` — 一条 PowerShell 内完成「起 Edge → 跑探针 → 杀进程」。
  **本机从 Git Bash / node 直接 spawn Edge 会 EACCES，必须走这个包装。**
- `.img2threejs/tools/r14_game.mjs` — 游戏内截图：点「开始挑战」→ 等倒计时 →
  点 `.view-btn[data-view=cabin]`（机位按钮在 countdown 阶段会被忽略，必须先等）。

## 遗留

1. 三联屏顶沿 1.287 m 接近眼高，正前方路面仍被屏幕压住；下移 6~10 cm 需要动 spec。
2. `src/assets/ref/*` 6 张参考图未接线（座椅菱格 / 星空顶 / 中控屏 / 门板）。
3. 真机核显 FPS 未测（本环境 SwiftShader 无参考价值）。
4. 得分天花板：热保护使满刹变成「必答 2 s 断力」，停时被压成平台，单局上限 8908 → 5487。
