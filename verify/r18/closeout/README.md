# R18 收尾报告 — 极限刹车挑战·尊界 V800

日期：2026-10-19
基线：`ecec0b6`（R17b）→ R18 工作树
验证：`tsc --noEmit` 0 错 / `vitest run` **79 passed (79)** / 5 个测试文件全绿

---

## 一、用户指认 9 项 · 终审判定

| # | 用户原话 | 判定 | 根因 / 修法 | 证据 |
|---|---------|------|------------|------|
| ① | 前后绿牌不应有文字 | **PASS** | `plateTexture.ts` 重写：只画绿渐变底 + 白圆角外框，删净 `fillText` | `final_tail.png`、`final_frontlow.png` |
| ② | V800 尾部大平方块 | **PARTIAL** | spec 新增 `rear-bumper`/`rear-valance`/`d-pillar-rear-l/r`，`tailgate` scale 0.93，尾灯外移 ±0.92 → 方板感明显削弱，但尾门 1.95m 宽仍偏平 | `final_tailclose.png` |
| ③ | 车灯被隐藏 | **PASS** | 尾灯 z 由埋在尾门体内 16mm 外移到 −2.839 露出；前灯 housing + LED 点阵可见 | `final_noseclose.png`、`final_tailclose.png` |
| ④ | 四轮外围突出围边 | **PASS** | `V800Adapter.ts` 整块删除 `wheel-arch-liner` 四轮衬筒；轮位外推至 x=±1.015 | `final_side34.png` |
| ⑤ | V800 座舱「中央隔板」 | **PASS** | 真因 = `body-lower` 挤出壳顶面 y≈1.09 的 paint-upper 体漆平面。新增 `cabin-floor-carpet`（1.86×0.012×2.70，y 1.098）覆盖 | `v800_车内_base.png` |
| ⑥ | R7 副驾座舱遮挡 | **PASS** | 真因二合一：body-lower 壳顶（0.67m）+ `center-screen-frame`（matte-black，0.848m 高悬浮黑板）。后者独占克隆入 `cabinOccluderMats`（3→4），加座舱衬毯 | `r7_副驾_base.png` |
| ⑦ | 三联屏贴图退化 | **PASS（本轮 R18e 二次修）** | 两段根因：① `refTextures.flushPending` 队列丢任务 → 贴图永远停在程序化图集（已修）；② R18d 把屏下移到 y 0.990，被 `body-lower` 顶面 y=1.090 埋掉 64%。R18e 抬到 y=1.130 | `triH_cabin.png` |
| ⑧ | 星空顶错位到引擎盖上方 | **PASS** | `starlight-headliner` 后移至 z=−1.45（深 1.8），并收窄到 starlight + headliner-front 专属 | `triC_cabin.png` |
| ⑨ | 水面过低遮挡、应与桥面平齐 | **PASS** | `waterY` −4.4 → **−0.14**，`bedY` −5.6 → −1.45；水面 295×155m；删桥墩/湿痕（4 DC / 96 tri）。`World.ts` 同步河床碰撞 y=−2.05（顶面 −1.45） | `final_bridge_side.png`、`final_bridge_chase.png` |

**结论：9 项中 8 项 PASS，1 项 PARTIAL（②尾部仍偏平，属建模深度限制而非回归）。**

---

## 二、R18e 关键数值（三联屏）

遮挡件不是仪表台，是 **`body-lower` 壳体顶面**（全宽 2.03m 的平顶，y 上限 1.090）+ 本轮新增衬毯 y 1.098。

座舱可用净高 = 1.098 → 眼点 1.20 = **10.2cm**，装不下 21.2cm 高的屏。三种取值实测：

| y | span | 可见比例 | 顶沿 vs 眼点 1.20 |
|---|------|---------|------------------|
| 0.990（R18d） | 0.885–1.096 | 32% | −10.4cm |
| 1.060（首轮尝试） | 0.955–1.166 | 46% | −3.4cm |
| **1.130（定稿）** | **1.025–1.236** | **65%** | **+3.5cm（距眼 0.74m ≈ 2.7°）** |

选 1.130 的理由：可见比例最高而遮挡角仅 2.7°，实测状态栏、23:25 时钟、屏间拼缝、右侧圆角全部可读。

---

## 三、R18 变更文件（15 改 + 3 新增）

**车模 / spec**
- `.img2threejs/object-sculpt-spec.json` — 尾部重构 5 件 + 星空顶后移 + 三联屏 y 1.130（185 组件不变）
- `.img2threejs/r7-sculpt-spec.json` — R7 前脸分体大灯/铬刃/盾徽/三段进气（133 组件）
- `src/model/createV800Model.ts` / `createR7Model.ts` — 工厂重产（禁手改）

**适配层**
- `V800Adapter.ts` — 删 `wheel-arch-liner`；新增 `cabin-floor-carpet`
- `R7Adapter.ts` — `center-screen-frame` 入遮挡克隆；新增 `cabin-floor-carpet`
- `refTextures.ts` — 修 `flushPending` 队列丢任务（三联屏 / 皮革贴图的真根因）
- `plateTexture.ts` — 绿牌去文字
- `preview.ts` — 3 处 `camera.near = 0.05`（frame 函数永久置 5.58 导致近距裁切）

**场景 / 物理**
- `render/scene/Waterway.ts` + `waterTexture.ts` — 水面 −0.14、河床 −1.45
- `render/scene/Road.ts` — `envMapIntensity` 0.9→0.45、`roughness` 0.38→0.50（A/B 实测棕色收敛）
- `physics/World.ts` — `WATER_Y` 同步、河床碰撞中心 y −2.05

**QA 工具（新增）**
- `.qa/screen-probe.mjs` — 运行时屏幕材质探针（贴图挂载状态）
- `.qa/occluders.mjs` — 几何相交扫描，定位遮挡件（替代猜测）
- `.img2threejs/tools/r18e_triscreen.py` — 三联屏抬升，幂等

---

## 四、遗留与风险

1. **`body-lower` 壳体顶面 y=1.090 是全模型的结构性限制**：它让「座舱地板」高到窗台高度，三联屏、仪表台、中控全部被压扁在 10.2cm 净高内。彻底解决需重做 body-lower 拓扑（切出座舱凹槽），超出 R18 范围。
2. **V800 尾部仍偏平**：尾门 1.95m 宽 × 0.955m 高的单块板，缺少实拍的上下分层折线。
3. `validate_sculpt_spec.py` 在 R18 中被失败代理误删，工厂重产未受阻但该校验器需重建。
4. 项目根目录残留 Windows 保留名空目录 `nul/`（`2>nul` 重定向误建），trash / .NET / `\\?\` 三种方式均拒绝删除，已加入 `.gitignore` 忽略。

---

## 五、证据清单

| 文件 | 对应判据 |
|------|---------|
| `final_tail.png` / `final_tailclose.png` | ①②③ |
| `final_noseclose.png` / `final_frontlow.png` | ①③ |
| `final_side34.png` | ④ |
| `v800_车内_base.png` | ⑤⑦ |
| `r7_副驾_base.png` | ⑥ |
| `triH_cabin.png` | ⑦ 三联屏（y 1.130 定稿） |
| `triC_cabin.png` | ⑧ 星空顶 |
| `final_bridge_side.png` / `final_bridge_chase.png` | ⑨ 水面 |
| `final_roof34.png` | ⑧ 车顶全景 |

原始 146 张工作截图保留在 `verify/r18/` 各子目录（未入库，`verify/r18/closeout/` 为精选入库集）。
