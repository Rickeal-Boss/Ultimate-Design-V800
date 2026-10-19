# R19 收尾报告 — 车内「中央隔板实体模块」定罪与收口

提交：`b3f9505` · CI run 39303268113 · 基线 commit 前身 `c570162`（R18）

---

## 1. 用户指认（原话）

> 车内贴图依旧被模型「中央隔板实体模块」所挡，需要按照计划解决。
> 这个几何体的上半截插在视野中央，把下半截给"吞进"了画面下方不可见区域。
> 这说明这个模块的 Z 轴（纵深）位置有问题，或者深度排序异常。上半截深度判断出错，覆盖在车内空间。

指认图：`v800_车内_base.png`（同目录）。

---

## 2. 定罪链（三重取证，全部可复跑）

### ① 网格射线：`r19face.mjs`（12×12 屏幕网格 + 面法线）

画面上半（sy<400）**71/72 格首命中 `batch/paint-upper`**：

```
sy= 32..348 | batch/paint-upper | d=0.28..0.65
pt ≈ (x, 1.20..1.34, -0.97..-1.02)    n = [0, +0.35, -0.94]
```

- 法线 `+y / −z` = 朝上、朝车头 → 指向 R19 挖出的**座舱凹槽前坡**
  （spec local `z 1.05→0.55`，`y 1.09→1.66`，坡度约 20°）。
- 命中点 y 1.20~1.34 与眼点 y 1.20 同高 → 该坡**横插在视线高度**，正是「上半截占据视野中央」。
- ⚠️ 该轮探针相机仍在**插值途中**（见 §4），结论须用收敛后相机复核（下条）。

### ② 消去法：`r19h_band.mjs`（隐藏整车对比逐像素）

| 屏幕 y | A 现状 | B 隐藏壳体 | C 隐藏整车 |
|---|---|---|---|
| 100 | (122,72,61) | (122,72,61) | (122,72,61) |
| 200 | (184,122,89) | (184,122,89) | (184,122,89) |
| 300 | (194,123,89) | (194,123,89) | (194,123,89) |
| 450 | (219,213,208) | (219,213,208) | (61,38,34) |

上部铜/橙色带在 **隐藏整车后逐像素完全不变** → 那是**黄昏天空**，不是车体。
R18 那张「亮铜色金属板」在 R19 材质改造后已经不在了。

### ③ 收敛后射线：`r19e_ceiling.mjs`（真实 cabin 机位 `(-0.40, 1.20, -0.72)`）

| 方向 | 首命中 | 距离 | 世界点 | 法线 |
|---|---|---|---|---|
| UP | `cabin-roof-carpet` | 0.462 | y **1.662** | (0,−1,0) |
| FWD / C-MID | `tri-screen` | 0.715 | (−0.391, 1.181, −1.435) | (0,−0.1,1) |
| FWD-DOWN | `steering-spokes` | 0.566 | (−0.394, 1.001, −1.249) | (0,−0.41,−0.91) |
| DOWN | `batch/carpet` | 0.883 | y 0.317 | (0,1,0) |
| C-TOP / FWD+UP / LEFT / RIGHT | **MISS** | — | — | 透空见天空 |

→ 座舱净高 **1.098..1.662 = 56 cm**；正前方是三联屏，下方方向盘+仪表台，地面地毯。
**没有任何遮挡件**。`paintShadow` 开/关两态结果完全一致。

---

## 3. 修复

| # | 缺陷 | 处置 |
|---|---|---|
| 1 | **内舱暗面用 `BackSide` 是错的**：`body-lower`/`root` 是单壳**实心挤出体**，切 BackSide 后外表面被剔除、相机看穿进壳内 → 整屏暗面自发光底色 `(13,8,8)`，内饰全被吞（比原问题更糟） | 改为**换材质**：外壳恒 `FrontSide`；车内机位把 `paint-*` 批次换成「暗车漆」克隆（`#2a211c` / metalness 0 / roughness 0.92 / emissiveIntensity 0.55），离车切回原漆。V800 `#2a211c`、R7 `#23282a` |
| 2 | 克隆目标取「子树全部 Mesh」→ `root` 子树含整车外板，**误克隆 24 件**直接毁掉外观 | 改为按 `userData.sculptComponent.id` **精确匹配自身** mesh（pivot 与 mesh 同名） |
| 3 | `byId.get('body-lower'/'root')` 命中的是 **Group pivot**（非 Mesh），旧代码 `if (!isMesh) continue` 静默跳过 → 暗面只覆盖了合批批次 | 同上，子树内按 id 筛选 |
| 4 | headless 截图拍在**机位插值途中**（见 §4） | `game.mjs` / `r19e_ceiling.mjs` 增加位姿收敛等待 |
| 5 | `ensure-vite.mjs` 探 `::1` 被沙箱代理假连通 → 探针 `ERR_CONNECTION_REFUSED` | 探测与 `--host` 统一 `127.0.0.1`，并用真实 HTTP 请求复检 |
| 6 | R18 遗留：`forge/stage3_build/validate_sculpt_spec.py` 被误删 | 从 `forge/stage2_spec/` 拷回 |

---

## 4. 本轮最大坑：QA 时序假象

`CameraRig` 的机位切换是**每帧插值**，`cabin` 位姿需要 **6.5–8 s** 才收敛：

```
未收敛（1.5s 后）：cam = ( 0.954, 1.288, -2.311)   fov 55.04
已收敛（8.2s 后）：cam = (-0.400, 1.200, -0.720)   fov 67.99   ← 目标位姿
```

两者相差 **1.3 m**。此前所有固定 `sleep 2500~3000ms` 的 headless 截图都拍在插值途中，
相机穿在壳体附近/内部 → 画面被暗面材质糊住 → 连续多轮被误判成「渲染 bug」「几何 Z 轴错位」。

判据（已内置）：`camera.position` 连续 12 次采样（间隔 120 ms）位移 < 0.5 mm 才出图。

```js
let last = null, same = 0, waited = 0;
while (waited < 20000) {
  await new Promise(r => setTimeout(r, 120)); waited += 120;
  const p = cam.position.toArray().map(v => +v.toFixed(4));
  if (last && p.every((v, i) => Math.abs(v - last[i]) < 5e-4)) same++; else same = 0;
  last = p;
  if (same >= 12) break;
}
```

附加无效通道：`preserveDrawingBuffer: false` 下用 2D `drawImage(glCanvas)` 读像素**恒为 (0,0,0)**（帧外 buffer 已清空）——同帧取证只能走 CDP 截图。

---

## 5. 验证

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错 |
| `npm test`（vitest） | **79 / 79 绿**（physics 26 / redundancy 21 / audio / vehicles 7 / refTextures 6） |
| `npm run build` | 通过，`dist/assets/index-*.js 2 737.83 kB`（既有 >1600kB 告警） |
| 目检 V800 车内 | `r19h_A_current.png` — 天空/风挡在上，三联屏横带居中，方向盘+仪表台在下 |
| 目检 R7 副驾 | `r7_副驾_cabinPassenger.png` — 道路/天空通透，A 柱正常 |
| 内舱暗面配对 | V800 `3 组`（2 合批批次 + root 自身）、R7 `2 组` |

---

## 6. 证据清单

| 文件 | 用途 |
|---|---|
| `v800_车内_base.png` | 用户指认原图（R18 状态） |
| `r19h_A_current.png` | 修复后同机位（收敛） |
| `r19h_B_no_shell.png` / `r19h_C_no_car.png` | 消去法对照（证明铜色=天空） |
| `r19e_shadow_on.png` / `r19e_shadow_off.png` | 内舱暗面开/关两态 |
| `v800_车内_cabin.png` | 游戏内机位终审 |
| `r7_副驾_cabinPassenger.png` | R7 副驾机位终审 |

探针脚本（`.qa/` 在 .gitignore，不入库）：`r19face.mjs`、`r19h_band.mjs`、`r19e_ceiling.mjs`、
`r19g_sameframe.mjs`、`r19cabin.mjs`、`game.mjs`。

---

## 7. 遗留（未在本轮收口）

1. ~~R7 副驾顶部两块悬浮深色四边形~~ → **R19i 已收口，见 §8**
2. `r19d_move_notch.py`（把凹槽前坡前移到风挡之后）已写未执行 —— 收敛后射线证明
   凹槽前坡不构成遮挡，故本轮不动 spec，避免引入新风险。
3. R18 遗留：V800 尾部尾门仍偏平（1.95×0.955 单板缺上下折线）；`nul/` 目录删不掉已 ignore；
   R7 lazy import；真机核显 FPS 未复测。

---

# R19i — R7 副驾顶部「两块悬浮深色四边形」收口

## 1. 结论先行

**两块都不是"深度排序"问题，是 spec 里的 z 值越过了顶棚前缘。** 用户 R19 阶段的直觉
（"这个模块的 Z 轴纵深位置有问题"）在 R7 上第二次复现并被实锤。

| 屏幕块 | 像素范围（1280×760） | 首命中组件 | spec local 位置 | 顶棚前缘 | 判定 |
|---|---|---|---|---|---|
| 左块 | x 244–519 / y 63–166 | `rear-view-mirror`（matte-black 批次） | `z=0.470`（占 0.451–0.489） | `z=0.340` | 整块越界 11cm，悬在风挡玻璃区 |
| 右块 | x 608–1023 / y 63–120（宽 416px） | `sun-visor-l`（leather-ivory 批次，`y=1.479` 下表面） | `z=0.420`（占 0.335–0.505） | `z=0.340` | 17cm 厚度中 16.5cm 越界 |

## 2. 定罪方法（先客观测量，再解释）

1. **暗块行游程扫描**（PIL，`max(rgb)<70` 且连续长度 ≥12px，y 步长 12px）：把"我看到两块"
   变成"y63 行有两段 371px / 416px 连续暗像素"。避免缩略图目检的主观误差。
2. **像素级射线**（`.qa/r19j_seam.mjs`，20×9 细网格，屏幕像素直接转 NDC）：报首命中组件 +
   世界点 + 面法线，并把 `rear-view-mirror` 追溯到 `batchMerged.from` 成员表。
3. **bbox 交叉验证**：`headliner` / `roof-glass` / `roof-header` 的 world bbox 统一止于
   `z=-0.34`（= spec local `+0.34`），与 `windshield` 剖面 `z 0.326..0.980` 的上沿闭合。
4. **反向排除**：R7 spec 的车顶系件全部在 `local z ≤ 0.34`，唯一越过前缘的就是
   遮阳板与后视镜 —— 与屏幕暗块数量、位置一一对应。

## 3. 修复（改幂等真源 `build_spec_r7.py`，不手改 JSON）

| 组件 | 改前 | 改后 | 依据 |
|---|---|---|---|
| `sun-visor-l/r` | `(±0.400, 1.492, 0.420)` | `(±0.400, 1.472, 0.245)` | z 收进 `0.160–0.330`，全部落在顶棚覆盖区；y 下移贴合顶棚下表面 |
| `rear-view-mirror` | `(0, 1.462, 0.470)` | `(0, 1.462, 0.395)` | 后表面 `0.376` 贴 `roof-header` 前缘 `0.375`，上沿与横梁重叠 2.65cm → 不再悬空 |
| `mirror-face`（**新增**） | — | `(0, 1.462, 0.373)`，`0.238×0.062×0.004`，`chrome` | 原后视镜是纯黑整块，读成"悬浮黑方块"；补一片朝乘员（local −Z）的高反射镜面，复用既有 `chrome` 材质（零新增材质），读成「黑框银镜」 |

管线：`build_spec_r7.py` → 134 组件（原 133）→ `validate_sculpt_spec.py --strict-quality`
= **PASS** → `generate_threejs_factory.py --pass-id blockout --force`
→ `src/model/createR7Model.ts`。`buildPasses.componentRefs` 是自动枚举全部 id，新增件无需手工登记。

## 4. 验证

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 0 错 |
| `vitest` | **79/79 绿** |
| `vite build` | 通过（chunk 2742kB，既有告警不变） |
| 副驾机位暗块游程 | 右块 416px → **0**（彻底消失）；左块 272px → 73px（镜面反光后不再是暗像素，只剩黑框） |
| 副驾机位纵扫 `x=300` | `y48` 暗棕横梁 → `y51–63` 纯黑框 → `y66–117` 镜面渐变 → `y120–141` 黑框下沿 → `y144+` 天空。**无橙色缝隙** |
| 主驾机位纵扫 `x=800` | `y20–30` 顶棚 → `y35–50` 横梁 → `y55–65` 上框 → `y70–135` 镜面反射 → `y140` 下框。**无缝隙** |
| 三机位目检 | 副驾 / 主驾 / 后排全部通透，后排可见两块象牙色遮阳板正常贴顶棚下 |

## 5. 顺带查清的 QA 陷阱（重要）

`game.mjs` 传 `cabin` 模式时，`CameraRig` 走的是**内置 `CABIN_EYE`**（`-0.40, 1.20, -0.72`，
为 V800 标定），**不会**用 R7 注入的 `interiorViews`；只有 `cabinDriver/cabinPassenger/cabinRear`
才走 `setInteriorPose`。用 `cabin` 拍 R7 会把相机放到 `local z=+0.72`（风挡上沿 `0.326` 之前
40cm，等于引擎盖上方），画面顶部整片漏天 —— **是机位误用，不是模型缺陷**。
R7 三机位正确值：driver `world(-0.300,1.285,0.090)`、passenger `world(0.300,1.285,0.090)`、
rear `world(0,1.230,0.700)`。

## 6. 证据清单（新增）

| 文件 | 用途 |
|---|---|
| `r19i_compare_pass.png` | 副驾顶部带 修复前/后 对照条 |
| `r19i_crop_center.png` / `r19i_crop_center_after.png` | 左块（后视镜）修复前后放大 |
| `r19i_crop_right.png` | 右块（遮阳板）修复前放大 |
| `r19i_crop_driver_mirror.png` | 主驾视角镜体放大（黑框 + 镜面，上沿贴横梁） |
| `r7_副驾_cabinPassenger.png` / `r7_主驾_cabinDriver.png` / `r7_后排_cabinRear.png` | 三机位终审 |
| `r19i_r7top.json` / `r19j_seam.json` | 射线原始数据（含 batchMerged.from 成员表） |

探针脚本：`.qa/r19i_r7top.mjs`、`.qa/r19j_seam.mjs`（.qa 在 .gitignore，不入库）。
