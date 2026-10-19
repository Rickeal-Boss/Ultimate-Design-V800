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

1. **R7 副驾顶部两块悬浮深色四边形**（`r7_副驾_cabinPassenger.png` 顶部 y 55–130）——
   疑似遮阳板/顶棚件位置错，未定罪。
2. `r19d_move_notch.py`（把凹槽前坡前移到风挡之后）已写未执行 —— 收敛后射线证明
   凹槽前坡不构成遮挡，故本轮不动 spec，避免引入新风险。
3. R18 遗留：V800 尾部尾门仍偏平（1.95×0.955 单板缺上下折线）；`nul/` 目录删不掉已 ignore；
   R7 lazy import；真机核显 FPS 未复测。
