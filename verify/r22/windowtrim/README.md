# R22-C 侧窗整圈镀铬包边 + D 柱银色包面 —— 交付与验证

交付物：`src/model/parts/windowTrim.ts`（新建，唯一生产文件）
工具/证据：`.img2threejs/tools/r22_windowtrim/`（探针 + 验证 + 预览渲染）
本目录：证据与数字口径

---

## 1. 接口签名（接线契约）

```ts
import {
  createWindowTrim,            // (side: 1 | -1, materials?: WindowTrimMaterials) => THREE.Group
  createWindowTrimMaterials,   // () => { chrome, pillar }  // 材质独占，左右必须共用同一份
  countTrimTriangles,          // (group) => number
  DLO_PATH, OUTER_X, PROUD, W_FRAME, W_BELT, DPILLAR_PROUD, TRIM_MATERIAL_ID,
} from './parts/windowTrim';
```

* `createWindowTrim(1)` = 左侧（+x）；`createWindowTrim(-1)` = 右侧，内部 `group.scale.x = -1` **纯镜像**（非旋转，与 `headLamp.ts` 同律）。
* Group 无 position 偏移，局部系 = 车身世界系（y 上正、z 车头为正），挂到 root 级即可。
* `group.userData.sculptComponent.id` 刻意写成 `window-belt-l` / `window-belt-r`（= 被替换件 id），另附 `group.userData.r22 = {part:'window-trim', side, replaces}`。
* 两个子 mesh 名：`trim-chrome-frame`、`trim-dpillar-cover`；材质 id：`r22-trim-chrome`、`r22-trim-dpillar`（`mat.userData.sculptMaterial.id`，供 `V800Adapter` 建表，**勿并入共享批次**）。

### 接线步骤（主理人侧）
1. **合批之前**：遍历模型，找 `userData.sculptComponent.id === 'window-belt-l' | 'window-belt-r'` 的 mesh → `visible = false`（保留 pivot，别删，避免索引漂移）。
2. `const mats = createWindowTrimMaterials();` 只调一次；`root.add(createWindowTrim(1, mats)); root.add(createWindowTrim(-1, mats));`
3. `batchMergeStatic` 的 `excludeObjects` 里排除这两个 Group（材质独占 → 一旦被吞并就丢高光且不可寻址）。
4. 建议同时在 `V800Adapter` 材质表登记 `r22-trim-chrome` / `r22-trim-dpillar`（envMapIntensity 已内置 1.35/1.15，若整车有统一 env 强度再乘一次会过曝，注意别重复乘）。

---

## 2. 数字口径（`verify_windowtrim.json`，node shim 直跑，无浏览器）

| 项 | 值 |
|---|---|
| tri（左/右/合计） | **346 / 346 / 692**（预算 ≤900/侧、≤1800/两侧） |
| 顶点数（单侧） | 972（非索引 324 tri） |
| bbox 左 | min `(0.9220, 1.0859, −2.8000)` max `(1.0111, 1.7725, 1.6278)` |
| bbox 右 | x 轴反号，y/z 完全一致（镜像校验通过，误差 <1e-6） |
| 路径点数 N | 54 |
| 路径段长 | min 0.0125 m / max 0.4891 m |
| **闭合性** | 环闭合段（末点→首点）= **0.0280 m**（= 一段正常段长，无重复首点；环向拓扑边界边 = 108 = 2N，恰好只有「裙边底边 + 内收边」两条开放长边，非流形边 0） |
| 有向面积 ×2 | +5.28910 → **CCW ✓**（法线朝外前提） |
| 法线朝外 | 左 636/636 朝 +x、右 636/636 朝 −x（世界系，含镜像法线矩阵），退化法线 0 |
| 贴面余量 | 铬条外棱与 `OUTER_X[i]+PROUD` 偏差 **0.00000 m**（逐点核对，idx 31 最紧） |
| D 柱包面 bbox | z 宽 **0.140 m**、y 高 **0.587 m**（z −2.800…−2.660，y 1.148…1.735） |
| 材质 id | 仅 `r22-trim-chrome`、`r22-trim-dpillar` |

复现：

```
node .img2threejs/tools/r22_windowtrim/build_x.mjs        # 重新实测 OUTER_X（改路径后必跑）
node .img2threejs/tools/r22_windowtrim/build_verify.mjs   # 全量校验，PASS/FAIL + json
python .img2threejs/tools/r22_windowtrim/render_side_preview.py   # 侧视预览 PNG
```

预览：`side_preview.png`（底图=射线实测「最外件」分组着色，前景=本件三角面按 x 排序 + 光照），
`_preview_front.png` / `_preview_rear.png` 为两端放大。

---

## 3. 车身实测参数表（构建依据，逐点 OUTER_X 来源）

对 factory 产物做 **−x 方向射线扫描**（`probe_body/probe_vert/probe_dp/probe_x.ts`），左半 x>0：

| 区域 | z 范围 | 最外件 | 实测 x | 说明 |
|---|---|---|---|---|
| A 柱边 | 1.61 → 1.17 | `apillar-l` | 0.9675 | 恒值，A 柱件外表面 |
| 顶沿 | 0.68 → −2.70 | `roof-panel` 侧沿 | 0.9700 | 车顶板侧立面 |
| 顶沿（后段） | −2.10 / −2.40 | `dpillar-l` | 0.9799 / 0.9831 | 宽黑柱**高出顶沿 15mm**，铬条须外扩否则被挡 0.46m |
| 后缘竖段 | −2.75 | `greenhouse-glass` | 0.9515 → 0.9610 | 玻璃 tumblehome |
| 腰带后段 | −2.60 → −1.80 | `greenhouse-glass` 下沿倒角 | 0.9341 / 0.9310 | 落在窗槽里 |
| 腰带前段 | −1.775 → 0.90 | `body-lower` 侧壁 | 1.0066 → 1.0071 | 车身最宽处 |
| 腰带前末 | 1.20 / 1.50 / 1.57 | `door-panel-fl` / 玻璃 | 0.9750 / 0.9618 / 0.9599 | 前门与前翼子板台阶 |

玻璃面 tumblehome 实测（`glassX()` 折线）：y=1.20→0.961、1.50→0.955、1.66→0.949、1.72→0.935、1.76→0.912。

几何口径（其余常量）：
* 上沿 / A 柱 / 后缘带 `W_FRAME` = **21 mm**；腰带段 `W_BELT` = **30 mm**（参考图实测 22mm / ~30mm，按车长 269 px/m 换算）。
* 外扩 `PROUD` = **4 mm**；裙边深 13 mm、内收边 3.5 mm（卷边横截面 4 点 3 带）。
* D 柱包面：玻璃面 +8 mm，y>1.70 平滑外扩到 x=0.9745 压过车顶侧沿 0.970；宽度上宽下窄（顶 126 mm → 底 71 mm），与铬框后缘竖段（21 mm）合起来 ≈120–147 mm 宽的 D 柱银包。
* 腰带线 `beltY(z)` 直接取 spec `greenhouse-glass` profile2D 折线：`(−2.770,1.160) (−2.398,1.145) (−2.381,1.139) (1.600,1.1006)`。

---

## 4. 必须知晓的实测发现（影响他线）

### 4.1 body-lower 侧壁把侧窗遮住了（→ R22-A）
`body-lower` 的侧壁在 **z ∈ [−1.75, 1.00]、y ∈ [1.10, 1.665] 一直是 x≈1.006~1.008**，
而玻璃带外表面只有 0.949~0.961（内凹 45~57 mm）。即：
* 滑动门/前门区的「可见侧窗」目前只有 **y 1.665…1.739 的 74 mm 窄缝**；
* `greenhouse-glass` 声明的大窗带（y 1.10…1.76）在门区被车身皮彻底盖住；
* 原有 `window-belt-l/r`（x=0.9175）**整根埋在车身里，完全不可见** —— 这就是它「看不出有窗线」的根因。

本件的处理：铬条不贴玻璃平面，而是**逐点贴「该处最外表面 +4mm」**，所以在现状下依然全程可见：
腰带段落在车身壁面（1.0070→外扩 1.0110），上沿落在车顶侧沿，玻璃裸露段（z<−1.75、z>1.0）落在玻璃面。
**若 R22-A 把 body-lower 改成开窗 loft（侧壁顶只到 y≈1.10）**：本件无需改动即自动「落回」玻璃面附近——
但 `OUTER_X` 是按当前产物实测的常量表，weight 上会出现 ≤45 mm 的悬空/内陷；
届时跑一次 `build_x.mjs` 重测并替换该表即可（文件里已加长度/一致性断言与说明）。

### 4.2 铬条与既有 chrome-belt 距离
`chrome-belt-l/r`（y 0.990…1.020）与本件腰带（y ≈1.10~1.18）只差 **80~130 mm**，
比参考图（腰带亮条与下方车门亮条相距 ≈350 mm）近很多。若审查觉得「两条平行亮线太挤」，
可在接线时把 `chrome-belt-l/r` 一并 `visible=false`（本件腰带已足够承担窗台下沿亮条的角色）。

### 4.3 D 柱位置
`dpillar-l/r`（z −2.55…−2.09、x 至 0.990、matte-black）**没有动**，本件的银包面放在
z −2.800…−2.660（= 玻璃带真正的后缘段，与参考图「宽银包在最尾端」一致）。
两者 z 区间不重叠，不会互相穿插；银包面外表面 0.947~0.975，`dpillar-l` 0.9799~0.9831
（宽黑柱比银面更外、更靠前），从侧后 3/4 看是「黑柱在前、银包在后」的层次。
**如果审查认为 `dpillar-l` 应该就是银包本身（而不是玻璃带中段的一块黑）**，
那属于 R22 的另一条改动（改材质/位置），本件可退化为只保留 21 mm 铬框后缘段。

---

## 5. 遗留风险

1. **腰带前段贴的是车身皮而不是玻璃**（见 4.1）：现状下窗带中段「黑区」实为黑漆，
   车身壁顶棱（y=1.665 的 45 mm 台阶）会在铬框内侧留一道极淡的横向折线。
   黑漆/黑玻璃同为暗色，实际渲染几乎不可辨；R22-A 开窗后此现象自动消失。
2. **`OUTER_X` 是快照常量表**：任何改动 `body-lower / roof-panel / dpillar / aplillar / door-panel`
   的轮次都必须重跑 `build_x.mjs`。文件内已有 `OUTER_X.length !== DLO_PATH.length` 抛错保护，
   但**长度一致而数值漂移**不会报错 —— 建议把 `build_verify.mjs` 的 CLEARANCE 检查（≤1 mm）纳入回归。
3. **A 柱底角**：DLO 前下角在 (z≈1.60, y≈1.10)，正落在后视镜基座后方；实测该处表面从 0.9916（车身）
   跳到 0.9675（A 柱件），铬条有一处约 24 mm 的横向错位（一段内完成）。属车身台阶，非退化几何。
4. 未做 GPU 渲染验证（本轮约定 node shim，不开浏览器）；侧视几何正确性由 `side_preview.png` 佐证，
   **3/4 视角与高光观感需要主理人在实机截图复核**（尤其 chrome 的 envMapIntensity 与粗糙度）。
5. `TH_SKIRT=13 mm` 的裙边在极掠射角下可能露出 ≤2 mm 缝隙（裙边要遮住表面起伏）。若实机可见，
   把 `PROUD` 降到 0.002 或 `TH_SKIRT` 提到 0.016 即可（两者都在文件顶部常量区）。

---

## 6. 工厂重产回归（R22-A body-lower 改 loft 之后）

dev-a 于 `2026-10-21 02:07:13` 重产 `src/model/createV800Model.ts`
（size 1,714,157 → 1,717,625，+77/−3 行；body-lower 改走 `buildLoftedExtrudeGeometry`，rings=13，
**纯细分**，外轮廓/bbox 逐位不变，tri 1,340→3,188）。

本件依赖的是「车身外表面 x」，故重跑 `build_x.mjs` 逐点复核 `OUTER_X`：

| 项 | 结果 |
|---|---|
| 逐点比对 | **53/54 点完全逐位一致**（Δ=0） |
| 唯一差异 | idx14（z=0.678, y=1.7604）实测 0.9170 vs 表内 0.9700，**-53mm** |
| 该差异性质 | **刻意的手动覆盖，不是漂移**：idx14 正压在车顶下沿，射线先撞到「紧贴车顶的玻璃倒角」(0.9170)，而同邻域 roof-panel 侧沿 = 0.9700；铬条必须压在顶沿棱线上，否则这一段会被车顶外悬吃掉。文件内 `OUTER_X` 注释已注明 |
| 结论 | **无需回灌**，`OUTER_X` 与 D 柱包面坐标全部继续有效 |

重产后复跑：

```
build_verify.mjs   → RESULT = PASS（tri 346/346/692、bbox、镜像、闭合 0.0280、CCW、法线 636/636、拓扑 108、CLEARANCE 0.00000、材质独占）—— 与上表逐项一致
tsc --noEmit       → 0 error
render_side_preview.py → side_preview.png 已按新产物重生成，几何无变化
```

> 触发条件提醒：**任何**改动 `body-lower / roof-panel / dpillar / aplillar / door-panel` 的轮次，
> 都请重跑 `build_x.mjs`；只有外轮廓不变时可跳过（如本次）。

---

## 7. 本轮验证结论

```
tsc --noEmit            → 0 error（strict + noUnusedLocals）
vitest run              → 5 files / 79 tests 全绿
verify_windowtrim.ts    → RESULT = PASS（tri / bbox / 镜像 / 路径闭合 / CCW / 法线 / 拓扑 / 贴面余量 / 材质独占）
```
