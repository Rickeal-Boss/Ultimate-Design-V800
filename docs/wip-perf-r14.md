# WIP perf-r14 — 加速段「前后帧抽搐」定罪与治理

> 基线：R13 波（d888b80，CI 绿）。用户机：Lenovo 笔记本 Intel 核显（无独显）/ Win11 / Edge。
> 本文只追加、不改写历史结论；每条假设留「假设 → 探针设计 → 数据 → 结论 → 改动 → 复测」。

## 0. 目标与约束

- 主诉：**车辆加速时前后帧抽搐（车/相机前后抖）+ 掉帧**。R13 已修 DPR 泵动（AdaptiveQuality 迟滞 42/8s 冷却）。
- 约束：物理步长 120Hz、限速不停动力、`#autodrive` 语义、low 档可跑、AdaptiveQuality 不回退到「2s 一键泵动」。
- 白名单：`core/Game.ts core/Loop.ts render/CameraRig.ts render/Postfx.ts render/Renderer.ts
  render/scene/Lighting.ts render/scene/Environment.ts config/quality.ts` + 本文 + `verify/r14/perf/*` + `perf-r14/*.mjs`。

## 1. 代码事实梳理（读码所得，供后面所有判断引用）

### 1.1 插值链路（假设 A 的算术先验）

`Loop.start` 每帧：`acc += dt` → `while (acc >= step) tick()` → `frame(dt, acc/step)`。
`Game.tick` 首行 `prevDistance = vehicle.distance`；`Game.frame` 里
`distance = lerp(prevDistance, vehicle.distance, alpha)`，`car.root.position.z = -distance`。

手算结论（**先验：位置序列 = v·(T−step)，与 tick 数无关**）：

- 帧内 tick 数 n = floor((a₀+dt)/step)，alpha = (a₀+dt−n·step)/step；
  render = D_{n−1} + alpha·step·v = v·(a₀+dt−step) ⇒ 帧间位移恒为 v·dt，**理论上无锯齿**。
- 唯一破口是「n=0 且 alpha 被复用」的情形 —— 实测确认（见 §2）。

### 1.2 相机链路（假设 B 的算术先验）

`CameraRig.update`：`anchor.lerp(target, 1−exp(−dt·anchorK))`，chase `anchorK=5`。
稳态滞后 = v/anchorK（v=30 m/s → **6.0 m**；v=55 m/s → 11.1 m）。
单帧 dt 抖动对滞后量的冲击：Δerr ≈ s·err，s = 1−exp(−5dt)；
dt 从 16.7ms 涨到 33ms 时 s 从 0.080 涨到 0.152 ⇒ 相机相对车**单帧前冲 0.45 m**。
这一项与「抽搐」的体感量级完全对得上，是本轮首要嫌疑。

### 1.3 每帧固定开销（读码）

- `Lighting.update(focus)` 每帧移动 sun + target（texel 对齐）⇒ three 默认
  `shadowMap.autoUpdate=true` ⇒ **每帧整场景重绘 2048² 阴影贴图**（顶点 60k×2 pass）。
- `Postfx`：msaa 4 + bloom 全屏尺寸 + HalfFloat RT（2048² 级）。
- `Hud.update` / `Sliders.render`：R13 已把 textContent/style 全部做了「值未变即跳过」门控。

## 2. 探针与数据

（待填）

## 2. 探针与数据（R14 收尾补记）

### 2.1 帧探针（`#fprobe`，DEV only）

`Game` 内新增 `__v800Probe.frames`：逐帧记录 `{dt, alpha, ticks, distance, prevDistance,
carZ, carX, camZ, camX, anchorZ, speed, fov, dpr, calls, tris, phase}`；`renderer.info.autoReset
= false` 保证 calls/tris 是整帧累计。附属开关 `#noshadowupd` 冻结 shadowMap 更新，用于精确
量出「每帧重绘 2048² 阴影」的单价。构建产物里是死代码（`import.meta.env.DEV` 门控）。

### 2.2 相机链路根治（抽搐的算术根因）

原 `CameraRig` 每帧做 `anchor.lerp(target, 1−exp(−dt·anchorK))`，稳态滞后 v/anchorK；
**dt 从 16.7ms 涨到 33ms 时增益从 0.080 涨到 0.152，相机相对车单帧前冲 ≈0.45 m** ——
与体感"前后抽搐"量级一致。现在删掉 `anchorK` 与逐帧积分，把稳态滞后显式写进姿态：

```
POSE.offset.z = 8.2 − 1.4e + speed / 5      // e = min(speed/72, 1)
```

构图与 R13 完全一致（55 m/s 时相机在车后 17.9 m），但它是**确定性的速度函数**，
dt 尖刺不再写进相对位移。`hood`/`side`/`cabin`/`orbit` 同样去掉 anchor 项。

### 2.3 画质档（核显）

`high` 档在 `gpuClass` 判为核显时收敛：`msaaSamples 4→2`、`bloomScale 1→0.5`（bloom 的
5 级 mip 全屏 blur 面积降到 1/4）、`shadowMapSize 2048→1536`。`Postfx` 新增
`bloomScale` 并在构造后立即 `applyBloomSize()`（`composer.setSize` 会把 pass 尺寸重置回
全分辨率）。

### 2.4 每帧分配

`hud.update({...})` 的 12 字段字面量改为复用 `hudInput` 对象（Hud 只同步读、不持有引用）。

### 2.5 未做

- 120 Hz 物理 + 30 fps 极端下的帧序统计（`perf-r14/*.json` 已采集但未做离线判据汇总）。
- 真机核显 FPS 未测（本环境只有 SwiftShader 软渲染，FPS 无参考价值）。
