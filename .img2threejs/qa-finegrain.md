# 细粒度 QA 判据档案（qa-finegrain）

> 本档案收存「机器判据覆盖不到的语义问题」的判据修订案与实测证据，供 QA/主理人采纳后回写正式文档。
> 每条目自含：缺陷分析 → 修订案 → 实测数据 → 复跑方法。

---

## 条目 1 · PERF.md #19「悬浮轮标 billboard 判据」修订案（task #18）

- **提出人**：material-lighter-1（材质/适配层；R3 轮 EX-33 自平衡 billboard 修复的实施者）
- **日期**：2026-10-17
- **状态**：**待采纳**——采纳后由 PERF.md 属主回写 #19（本档案只放修订案与证据，不改 PERF.md 原文）
- **触发**：R3 轮 EX-33 黑底盾徽交付时，运行时探针发现盘面朝向与判据声称的不一致
- **实现位置**：`src/model/V800Adapter.ts`「悬浮轮标：自平衡 billboard（EX-33）」段（`createV800CarAdapter.update()` 内）

### 1.1 缺陷：旧判据与需求不等价（代码能跑、画面错）

PERF.md #19 现行判据：「cap 世界朝向 == 相机朝向」（2026-10-16 闭环：4 机位 180°→0°、绕车 72 方位 worst 2.415e-6°、body 俯仰 worst 0.000e+0°）。

**该判据只保证四元数相等，不保证盘面朝向观察者：**

1. wheel-cap-\* 是 CylinderGeometry（24×8 段），**盘面法线是节点局部 +Y**（圆柱轴向），不是局部 +Z；
2. 「世界朝向 == 相机朝向」把局部 +Y 带到**世界 +Y（竖直向上）**——盘面像杯盖一样**朝上平躺**；
3. 游戏全部外部机位都是近水平视角（side 机高 1.5m / chase 2.2m / orbit 1.5m / crash 4.5m，目标 y≈0.85），盘面法线与视线夹角 ≈82–88°，投影只剩厚度 1.2cm 的一条边；
4. **后果：轮心徽标/字标在该状态下不可见**（R3 前实测 facingCam ≈ 0.010）。

旧验法双重失明的原因：① 验的是四元数、不是盘面法线（法线取哪个局部轴从未进过判据）；② 当时盘面无贴图（chrome 对称盘 → 后来的均质字标），正面观感看不出朝向错误——与 PERF.md #19 自述「盘面 20 开窗接近对称，正面观感看不出来」同源。

### 1.2 修订案：三项点积判据（替代四元数相等）

符号：n = 盘面法线（节点局部 +Y 的世界方向）；u = 徽标上沿（局部 +X，帽面 UV 约定 v=1 在 θ=π/2，a2 探针实证 discR2max=0.25）；r = 读向（局部 +Z）；toCam = 相机位置 − 盘面中心；toCamH = toCam 去掉 y 分量后归一化。

| # | 判据 | 阈值 | 验什么 |
|---|---|---|---|
| C1 | n · toCamH | **> 0.99** | 盘面**水平**指向观察者（去掉相机俯角分量，纯看方位对齐） |
| C2 | u · (0,1,0) | **> 0.99** | 徽标上沿对齐世界竖直 = 「行驶中保持正立」（spec/checklist 口径） |
| C3a | \|r · (0,1,0)\| | **< 0.05** | 读向水平（文字不歪） |
| C3b | \|r · viewDir\| | **< 0.1** | 文字横过屏幕（不顺视线轴方向糊成一条） |

辅助参考（不设硬阈）：n · toCam（含相机俯角）> 0.9；billboard 不产生世界位置位移（吸附感检查）。

> C1 用水平分量而非全向量：合法实现是「盘面水平指向相机 + 徽标正立」（圆柱 billboard），相机俯角下 n·toCam 天然 < 1（俯角 13° 时 ≈0.97），用全向量会误杀合法实现。

### 1.3 修订后实测（a2 探针 · 无浏览器 · high 档 · 2026-10-17）

扫描命令产物：`node .img2threejs/tools/a2_probe_bundle.mjs high` → 「billboard criterion sweep」段（10 机位 + 6 车体扰动，全部通过）：

| 机位/扰动 | n·toCamH | n·toCam | u·worldUp | \|r·worldUp\| | \|r·viewDir\| |
|---|---|---|---|---|---|
| side（QA 复拍量级） | 1.000 | 0.983 | 1.000 | 0.000 | 0.000 |
| chase | 1.000 | 0.985 | 1.000 | 0.000 | 0.000 |
| orbit-0 / -90 / -180 / -270 | 1.000 | 0.992 / 0.993 / 0.987 / 0.984 | 1.000 | 0.000 | 0.000 |
| hood | 1.000 | 0.952 | 1.000 | 0.000 | 0.000 |
| cabin | 1.000 | 0.960 | 1.000 | 0.000 | 0.000 |
| crash | 1.000 | 0.974 | 1.000 | 0.000 | 0.000 |
| low-side（机高 0.5m） | 1.000 | 1.000 | 1.000 | 0.000 | 0.000 |
| body pitch+0.3（side / chase） | 1.000 | — | 1.000 | 0.000 | 0.000 |
| body roll+0.5（side / chase） | 1.000 | — | 1.000 | 0.000 | 0.000 |
| body yaw+pitch+roll（side / chase） | 1.000 | — | 1.000 | 0.000 | 0.000 |

**旧实现同口径对照**（侧视机位、相机 (6.5,1.6,0)）：n = (−0.15, 0.99, 0.00)，n·toCamH = **−0.144**（水平分量背对相机），n·toCam = **0.010**（垂直分量朝上）→ 盘面朝上平躺、侧对相机，徽标不可见。修复前后 C1 相差 ~7 倍（1.000 vs 0.144）。

机位坐标取自 `src/render/CameraRig.ts` MODES 表（local 偏移按车体世界朝向折算后取代表点）；扰动量为 crash 翻滚量级（0.3–0.5 rad）。

### 1.4 实现口径（供复核）

`V800Adapter.ts` 自平衡 billboard = 圆柱 billboard（Y-billboard）标准构造：
- R(x̂) = 世界上 (0,1,0)、R(ŷ) = toCamH、R(ẑ) = up × toCamH（makeBasis + setFromRotationMatrix）；
- 再折算到父节点局部：local = parentWorldQ⁻¹ × R（父链含 body 的 rotation.y=π，故必须折算——这正是 2026-10-16 那次修复的内容，本次保留）；
- C1/C2 由构造**精确**成立（扫描值 1.000 即浮点极限）；C3 由 basis 正交性精确成立（0.000）；
- 配套：底帽 v 翻转补偿（`remapWheelCapCapUV`）——相机位于轮子同侧时可见的正是底帽（generateCap sign=−1 的 v 翻转），不补偿则盾徽上下颠倒；补偿后左右两侧车轮、任意机位盾徽均正立。

**不影响架构组几何验收**：scene-architect-1 的 R2 验收判据是世界 bbox + 射线首命中，从未使用「朝向 == 相机四元数」（已与其互确认）；其独立重跑探针数字与我方逐位一致。

### 1.5 复跑方法

```bash
# 1) 重建探针 bundle（a2_probe_entry.ts 头注有完整命令）
node_modules/.bin/esbuild .img2threejs/tools/a2_probe_entry.ts --bundle --format=esm \
  --outfile=.img2threejs/tools/a2_probe_bundle.mjs --platform=node --log-level=warning
# 2) 跑（high 档；medium/low 结论同构，billboard 与质量档无关）
node .img2threejs/tools/a2_probe_bundle.mjs high
# 3) 看「billboard criterion sweep」段：C1>0.99 / C2>0.99 / C3a<0.05 / C3b<0.1 全过
```

浏览器侧等价复核（QA 实机可选）：控制台对任一 wheel-cap-\* 节点取 `getWorldQuaternion`，按 1.2 节公式计算三项点积。

### 1.6 附：本轮连带的状态同步

- 架构组已按其属主职责同步 spec 三处文本（lamp-head textureless 证据 / headlamp-led-l/r notes / 6 枚点阵 localFeatures），与集成层现状一致；若 QA 实拍后要求调整头灯亮带宽度/位置（收窄至画布 x[46,82] 以下会触及 6 枚点阵重映射落区的柔边缓冲），按已建立的耦合规则双向同步（调光 → 架构组同步 spec 证据文本）。
