# QA 基线报告（Phase 1）— qa2 / 提速

- **捕获时间窗**：2026-10-16 17:14–17:25 (UTC+8)
- **git rev**：`9afac60`（只读，无任何 git 写操作）
- **捕获时代码状态（mtime）**：
  | 文件 | mtime (UTC+8) | 说明 |
  |---|---|---|
  | `src/model/createV800Model.ts` | 2026-10-16 12:42:54 | 捕获后 17:48 被 builder 再次修改 —— **本基线不含 17:48 后的工厂改动** |
  | `src/model/V800Adapter.ts` | 2026-10-16 12:43:50 | 捕获窗口内未变 |
  | `src/model/preview.ts` | 2026-10-16 17:12:59 | 前任座舱扩展版；本任务未改动（见缺陷 #1） |
- **环境**：Edge headless `--headless=new --disable-gpu`（SwiftShader 软渲染），Edg/155.0.4283.45；vite dev 5199；CDP 9333。
- **参考图基线口径**：`.refcache/` **不存在**（低清参考图按合规要求不入库），逐条对照以 `docs/reference-checklist.md`（82 图 → 83 条）+ 实测截图为准。

---

## 一、性能实测（index.html#perfhud-autodrive，60s 浸泡，43 个样本）

| 指标 | 实测 | 口径说明 |
|---|---|---|
| FPS avg / min / max | **1 / 1 / 1** | SwiftShader 软渲染，**不可作为真机帧率依据**；Phase 2 需同环境对比 |
| **draw calls（整帧峰值）** | **313** | `renderer.info` 整帧累计（autoReset=false，含阴影 + Bloom/SpeedBlur/Output 后处理） |
| **triangles（整帧峰值）** | **187,043** | 同上，多次 pass 累计 |
| DPR | 1.00 | headless 固定 1 |

⚠️ **整帧 calls 313 显著高于 MEMORY 记录的 ≈112（红线 150）**。两个候选解释，Phase 2 必须同环境复测裁定：
1. headless 下质量档 auto 判定为 high → transmission 透射 pass 开启使 DC 翻倍（MEMORY：transmission 会翻倍，已接质量档）；
2. 工厂/合批数字在当前树上已经变化。
样本全程：前段 308–313（行驶），34.9s 后降至 196–204（结算页 HUD 可见 `calls(frame) 204 | tris(frame) 183622`，见 `A-perfhud-endstate.png`，刹停成功结算正常）。

**preview.html 审查页（非游戏，无运行时合批）**：`__v800Info` = **289 calls / 81,704 tris**（转台机位 dist 9；含外壳全部 mesh + 阴影 pass）。车模运行时合批后 51 DC 的口径出自游戏内 `batchMerge.ts`，与审查页数字不可直接对比。

---

## 二、座舱捕获钩子缺陷（P0，QA 工具链阻断）

**现象**：`window.__v800CaptureCabin`（front/rear/third）与 `#cabin=front|rear|third` hash 模式输出的截图全部为纯背景色（`#241a1e`），`renderer.info` = **0 calls / 0 tris**。

**根因（已实机定位，非猜测）**：`preview.ts:65` 调用 `frameZunjieV800LuxuryMPVCamera(camera, model)`，该函数（`createV800Model.ts:7696`）执行
`camera.near = Math.max(0.01, distance - maxDim)` ≈ **12.02 − 6.44 = 5.58 m**，且**永久生效、无人恢复**。
- 转台机位 dist 9 能幸存纯属侥幸：最近车面 6.2 m > near 5.58；
- 座舱 POV 相机距座椅 0.3–0.5 m → 全部几何被 near 平面裁掉 → 0 draw calls。

**验证**：干净页复现（自建 renderer，near=0.05，同一套隐藏正则）一切正常 —— cabin-hide 状态 73 mesh / 137 calls / 44,976 tris（转台位），座舱内 POV 15 calls / 3,768 tris。

**建议修复（一行级，未越权改动）**：在 `applyCabinCamera()`（或 `__v800CaptureCabin`）内恢复 `camera.near = 0.05; camera.far = 60; camera.updateProjectionMatrix()`；`__v800Capture` 的近距机位同理。**我的白名单仅允许修类型错误，故只登记不修**，请主理人裁定由谁执行。

---

## 三、座舱内视基线（绕开缺陷的替代证据，G 系列）

用独立脚本在浏览器内复刻 preview 渲染管线（同 ACES + sRGB + exposure 0.9 + lookdev 灯光 + env，near=0.05），外壳隐藏（同 KEEP/HIDE 正则口径，73 mesh 可见）：

| 证据 | 结论 |
|---|---|
| `G-cabin-front/rear/third.png` | 三排 POV 有效。**第三排已建模**（`seat-third-row/-back/-headrest` 世界盒实测 z≈−1.73~−2.2；任务简报"三排未建模走外推兜底"已过时），`cabinEye('third')` 前缀 `seat-third` 可命中 |
| `G-lampgold-speaker-fl/rl.png`、`G-lampgold-tweeter-l.png` | **lamp-gold 共享材质缺陷实锤**：门板扬声器格栅呈发光奶油金圆盘（应为深色金属网罩）；tweeter 同样发光。与 MEMORY 记录一致（金色签名屏 emissiveMap 被 4 speaker + 2 tweeter 共用） |
| `G-cabin-rear-wide.png` | 座椅为素块：**无菱形绗缝、无打孔、无滚边**（checklist IN-03/05/08 未落地，视觉权重高）；后排控制屏呈"白盘+铜环"贴在座背上（IN-09 形态不符，应为 4 英寸翻转屏）；顶棚氛围灯带已到位；中岛/通道、杯架、水晶旋钮（球状，IN-32 应为圆柱+滚花环+顶徽）在位 |
| `G-starlight-up.png` | **星空顶星点不可见**：仰视只有平色条带 + 深色横带，无星点/流星（IN-16：星点数不足且曾退化堆原点；当前至少"不可辨识"） |
| `G-dash-screen.png` | 三联屏为整块深色板，**无任何 UI 贴图**（IN-21/IN-43）；下方水晶换挡旋钮为素球 |

## 四、外观基线（B 系列 8 方位 turntable，pitch 8 / dist 9）

`B-turntable-az000..315.png`。可观察项（对照 checklist）：
- **az000（车头）**：竖向大灯为白色发光竖块，无"外缘竖 LED 线 + 3 圆形点阵"结构（EX-08 部分覆盖的几何证据）；前脸封闭面板+盾标在位。
- **az180（车尾）**：尾灯为简单竖向白色单元 + 底部红反光条；**上/下 3+3 红横带与中部金色点阵屏不可见**（EX-28/EX-29 未落地——注意 MEMORY 说尾灯 Canvas 图集已做 3+3，若已做则本角度不可辨，Phase 2 需特写机位复核）。
- 车色为金/深棕双拼，整体轮廓方正 MPV 与 EX-14 一致；D 柱银白包边可见（EX-19）。

## 五、截图清单（`.img2threejs/renders/qa-baseline/`）

| 前缀 | 文件 | 状态 |
|---|---|---|
| A- | `A-perfhud-endstate.png` | ✅ 有效（结算页 + HUD） |
| B- | `B-turntable-az000..315.png`（8 张） | ✅ 有效 |
| C- | `C-cabin-front/rear/third.png` | ❌ 全黑（缺陷 #1 的证据本身） |
| D- | `D-lampgold-*.png`（4 张） | ❌ 全黑（同上） |
| E- | `E-cabin-*.png`（8 张） | ❌ 近距轨道位同裁切问题（1 张残影 576 tris） |
| F- | `F-cabin-stripped-right.png`、`F-full-stripped-right.png` | ❌ 同上（诊断用） |
| G- | `G-cabin-front/rear/third`、`G-lampgold-speaker-fl/rl`、`G-lampgold-tweeter-l`、`G-starlight-up`、`G-dash-screen`、`G-cabin-rear-wide`（9 张） | ✅ **有效座舱基线**（独立管线，未改仓库文件） |

另有 `qa-baseline-summary.json`（A 项原始样本）。

## 六、Phase 1 交付边界与遗留

- **未做 Phase 2**；未改任何白名单外文件；git 零写操作。
- 遗留裁定项：① preview.ts near-plane 一行级修复由谁执行；② 整帧 DC 313 的环境差异解释需 Phase 2 同环境复测；③ 尾灯 3+3/金色点阵需特写机位复核。
- 复现脚本（仓库外，`C:/Users/16896/.workbuddy/binaries/node/workspace/`）：`qa-baseline.mjs`、`qa-cabin-standalone.mjs`、`qa-debug2~6.mjs`（诊断链）。注意：**node 直spawn msedge 在本机当前被拒（EACCES），Edge 必须经 PowerShell `Start-Process` 拉起**——与 MEMORY 记录的 spawn 方式已不兼容，主理人知悉为盼。
