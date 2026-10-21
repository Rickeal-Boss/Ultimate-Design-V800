# R22-A · body-lower loft 接线（清单 C 收官）

> 执行人：耿键码（v800-dev-a） · 状态：**spec 已改 + 工厂已重产 + node 数值回归全绿**；
> **浏览器 QA 未跑**（等主理人放行，见 §7 遗留项）。
> 结论：**几何层面可接线（已接线）**；但 §6 有一个必须先向主理人澄清的口径问题
> （loft 是**纯细分、外形逐点不变**），以及一个 #assembled 绝对口径对不上的问题。

---

## 1. 变更清单（只动白名单内文件）

| 文件 | 变更 | diff |
|---|---|---|
| `.img2threejs/object-sculpt-spec.json` | `componentTree[1]`（body-lower）`geometryDescriptor` 末尾追加 `"loft": {"rings": 13}` | **+4 / −1**（行数量级，无噪声） |
| `src/model/createV800Model.ts` | 工厂重产覆盖（**未手改**）：新增 `buildLoftedExtrudeGeometry` + `LoftSpine` 接口（74 行）+ body-lower 调用由 `buildExtrudeGeometry(...)` → `buildLoftedExtrudeGeometry(..., {"rings":13})` + 两处 `userData.sculptComponent` 内联 `loft` 字段 | **+77 / −3** |
| `verify/r22/loft/` | 本报告 + `probe_run.log` | — |
| `.img2threejs/tools/r22_*` | 临时探针（spec 改写脚本 + round-trip 干跑 + node shim 回归） | — |

落盘事实（写盘竞态自查）：
- `src/model/createV800Model.ts` mtime = **2026-10-21 02:07:13**（重产前 2026-10-20 21:25:51），size 1,714,157 → **1,717,625**（Δ+3,468 B），行数 8,733。
- 重产后复查 mtime 未再变动 → 期间无他人覆盖。

### 1.1 spec 写盘铁律（本机实证，与既往记忆有出入，记下）
- 现状 spec 是 **CRLF**（CRLF 计数 == LF 计数 == 47,230），且**文件末尾无换行**。
- 实测 round-trip：`json.dump(indent=1, ensure_ascii=False)` → `\n` 换回 `\r\n` → **不加末尾换行**
  ⇒ 与现状 **byte-identical**（`IDENTICAL: True`，961,110 B）。
- 若写成 LF 或加了末尾换行，会产生 47k 行级别的伪 diff（`core.autocrlf=true` 只能救 git diff，救不了工作树字节）。
- 脚本 `.img2threejs/tools/r22_spec_add_loft.py` 内置**回退自检**：写盘前先「去掉 loft 再 dump」与原文比对，不等即拒绝写盘。

---

## 2. 校验 / 构建 / 测试

| 门 | 命令 | 结果 |
|---|---|---|
| spec 校验（普通） | `cd forge/stage2_spec && python validate_sculpt_spec.py <spec>` | **PASS** |
| spec 校验（严格） | 同上 `--strict-quality` | **PASS**（`loft` 字段未被 schema 拒：`validate_geometry_descriptor` 只校验已知键，无 `additionalProperties` 拒绝） |
| 工厂重产 | `generate_threejs_factory.py <spec> --out src/model/createV800Model.ts --pass-id lighting-pass --force` | exit 0 |
| tsc | `node ./node_modules/typescript/bin/tsc --noEmit` | **exit 0，0 error** |
| vitest | `vitest run` | **79/79 passed（5 files）** |

> `npm run build`（= `tsc --noEmit && vite build`）的 `vite build` 半段未跑：它会写 `dist/`，
> 超出本次文件白名单。类型检查半段已单独跑通。

---

## 3. 数字口径表（node shim 跑真实 THREE，无浏览器）

探针：`.img2threejs/tools/r22_loft_probe.ts`（bundle 后由 node 跑），
**直接吃工厂重产后的真实产物** `src/model/createV800Model.ts`，
控制组「现状 steps=1」用工厂未导出的 `buildExtrudeGeometry` 的**逐字副本**重建
（已核对 `createV800Model.ts:285` 起与副本逐行一致）。

### 3.1 body-lower 本体（本地坐标；本地 z = 车宽方向，本地 x = 车长方向）

| 指标 | 现状 steps=1 | loft rings=13 | 判据 | 结论 |
|---|---|---|---|---|
| tri | 1,340 | **3,188** | 3,188 ± 50 | **PASS** |
| verts | 968 | 2,068 | — | Δ+1,100 |
| distinctLocalZ（5mm 桶） | 22 | **69** | — | — |
| 5mm 桶填充 | 22 / 408 | **69 / 408** | — | — |
| **zCoreShare** | **0.0 %** | **46.7 %** | ≥ 40 % | **PASS** |
| **maxGapRatio** | **0.948** | **0.076** | ≤ 0.15 | **PASS** |
| zSpan | 2.0300 m | 2.0300 m | 不变 | PASS |
| 本地 bbox | min(−2.8300, 0.2000, −0.0120) / max(2.3680, 1.6600, 2.0180) | **逐位相同** | 不变 | PASS |
| uv 属性 | position/uv/normal | position/uv/normal | 齐备 | PASS |
| uv 唯一行数 | 762 | 1,686 | scheme 不变、行数随环数增 | 预期内 |
| Δtri | — | **+1,848** | ≤ 4k 预算 | PASS |

病段核心（z-span 中心 z≈1.003）：现状 **28 verts**（都是端点/倒角假阳性堆积，中段实为空）
→ loft 后 **100 verts**，且 z≈0.190 / 1.490 各桶均有 11 / 33 verts，**车宽向 X 极差 4.98 / 5.19 m（全幅）**。

### 3.2 整车 tri（`#assembled` = `createV800CarAdapter('high')`，node 静态遍历）

浏览器权威口径是 `__v800Info().tris = renderer.info.render.triangles`。node 无 renderer，给四档供对账：

| 口径 | 接线后 | 推算接线前（后 − 1,848） | 说明 |
|---|---|---|---|
| A all（含隐藏件/碰撞体，Instanced ×count） | 91,662 | 89,814 | node 上界 |
| B all（含隐藏件/碰撞体，Instanced 不翻倍） | 83,022 | 81,174 | |
| C visible（非碰撞体，Instanced ×count） | **87,766** | 85,918 | 最接近 renderer 口径 |
| D visible（非碰撞体，Instanced 不翻倍） | 79,126 | 77,278 | |

- **本次改动引入的 Δtri = +1,848，与口径无关**（body-lower 多出的 1,848 tri 全部参与渲染，合批不减面）。
- mesh 数（= DC 上界，非整帧）：all 129 / visible（非碰撞体）96。
- ⚠ **四档都对不上主理人给的「现状 72,840」**。72,840 出自 `verify/r20/tailgate-defect-report.md` 的
  R20-1c「开发静态口径」，而 R21 波已新增尾门折线几何（+3,580 tri，日志实锤：`[V800Adapter] 尾门折线几何 → 3580 tri`）
  与前后灯手写灯组，故该基线很可能已过期。**绝对值必须以浏览器 `__v800Info()` 为准**，见 §7。
- 参照 R20 报告自身确立的红线「总 tri ≤ 90,000」：四档口径 A~D 全部 **≤ 90,000 ✓**。
  若按主理人给的 78k 红线，则口径 A/B/C 在**接线前就已超**，说明 78k 与我的 node 口径不同源。

---

## 4. 回归结果（判据逐条）

```
tri = 3188±50                : PASS  (实测 3188)
zCoreShare ≥ 40%             : PASS  (实测 46.7%)
maxGapRatio ≤ 0.15           : PASS  (实测 0.076)
形状保形（max dev < 1e-6 m） : PASS  (实测 2.227e-14)
尾立面 z=-2.82 未位移(±2cm)  : PASS  (实测 -2.8300)
#assembled(visible) ≤ 78000  : FAIL  (实测 87766) ← 口径问题，见 §6.2/§7
#assembled(preview) ≤ 78000  : FAIL  (实测 87766) ← 同上
```

---

## 5. 风险复核

### 5.1 「88 件 bevel 后处理」是否被破坏 —— **未破坏，且不存在该后处理**
- spec `componentTree` 共 **185** 件，其中 `geometryDescriptor.profile2D.bevel` 非空的 **89** 件（≈ 主理人说的 88 件），
  `primitive: extrude` 共 132 件；**带 `loft` 字段的只有 body-lower 1 件**。
- 工厂（8,733 行）里**没有任何全局 bevel/倒角后处理函数**——倒角是逐组件在 `buildExtrudeGeometry`
  里由 `profile2D.bevel` 烘焙的（`ExtrudeGeometry` 的 `bevelEnabled` 段）。
  `git diff` 实证：本次 77 行插入 = 新增函数 74 行 + 2 处 userData + 1 处调用；
  **删除仅 3 行，全部属于 body-lower**，其余 184 件逐位未动 → 向后兼容成立。
- `V800Adapter.ts` 对 body-lower 只做**换材质**（R19f 内舱暗面，`paintShadowPairs`），
  **不碰几何**；`batchMerge.ts` 只做 `geometry.clone().applyMatrix4()` + `mergeGeometries()`，
  **不减面、不假设环数**。
- 相邻件（wheel-arch / rocker / chrome-belt）对齐：见 §6.1 —— loft 后外形逐点不变（max dev 2.2e-14 m），
  故对齐**在数学上不可能被破坏**。

### 5.2 tailgate 接缝 z≈−2.82 —— **PASS，且无新增间隙**
- body-lower 世界 bbox zMin = **−2.8300**（与接线前一致，未位移）。
- tailgate 世界 bbox z ∈ [−2.8360, −2.7660]，厚 70 mm 的折线板**骑在**车身尾立面上：
  向车后出 6 mm、向车前伸 64 mm ⇒ **z 向交叠 64 mm，无缝隙**。
- 注：tailgate 已在 R21 被适配层手写成折线几何（3,580 tri），不再是 2 平面平板，本波未动它。

### 5.3 `#uvassert` —— node 侧前哨通过，浏览器侧待验
- loft 后 geometry 属性齐备（`position / uv / normal`），uv scheme 未变（唯一行数 762 → 1,686，
  随环数线性增属预期，非串色）。
- UV 由 `ExtrudeGeometry` 按环生成；环数增多只增加行数，`#uvassert` 的两条判据（越界 / 各向异性）
  语义不变。仍建议浏览器放行后实跑一次 `#uvassert` 确认（本波未跑）。

---

## 6. 两个必须先向主理人澄清的点

### 6.1 ⚠ loft 是**纯细分，外形逐点不变**（重要，可能影响「是否值得接线」的判断）
- 实证：loft 后 690 个采样顶点到「现状曲面」的最短距离 **max = 2.227e-14 m、mean = 1.305e-16 m**
  （即浮点噪声，几何上就是同一张曲面）；本地/世界 bbox 逐位相同。
- 机理：`applyExtrudeShaping` 的缩放系数 `m = f(sx, sy)`（车长 x 与高 y 的函数），
  **与环序号无关**；`z_new = depth/2 − (depth/2 − z_r)·m` 对 `z_r` 是**仿射**的
  ⇒ 中间环插入后仍共线，直纹面形状不变。`steps` 只加密顶点。
- 因此 loft 治愈的是**顶点密度**（zCoreShare 0%→46.7%、maxGapRatio 0.948→0.076），
  **不是形状**。收益落在逐顶点法线/高光插值（1.9 m 长四边形条带 → 12 段），
  形状/对齐/剪影**零变化**。若清单 C 的原始诉求是「车身侧面看起来不对（形变没生效）」，
  那么 **loft 不会改变外观形状**，需要在浏览器 QA 里重新确认诉求是否被满足。

### 6.2 ⚠ `#assembled` 绝对口径对不上（72,840 vs 我的 77.3k~89.8k）
见 §3.2。我的四档 node 口径都对不上 72,840；但 **Δ = +1,848 是硬的**。
按 R20 报告自身红线「≤ 90,000 tri」：四档全过。按 78k：接线前就超 ⇒ 口径不同源。
建议：浏览器 QA 里直接读 `__v800Info().tris`，以此定基线；若确实已 > 78k，
那是 R21 尾门/灯组累计的结果，不是本波 +1,848 的锅。

---

## 7. 遗留项 / 待主理人放行

1. **浏览器 QA 未跑**（按指令等放行）。放行后要做：
   - `npm run dev`（vite 监听 **127.0.0.1:4317**）+ Edge headless（PowerShell 单次调用内
     `msedge --headless=new` + `puppeteer-core connect`）。
   - `preview.html#assembled`（先 `about:blank` 再进，同文档 hash 导航不重载）。
   - 跑 `#uvassert`（几何波后必跑）、`#batchmerge`、读 `__v800Info().tris` 与 `calls`；
     近距机位把 near/far 恢复到 0.05 / 60。
   - **至少出 1 张 `#assembled` 三视图截图自查**（数值探针全对 ≠ 渲染正确）。
2. **放行事前建议先裁 §6.1**：若 loft 只是加密顶点、不改形状，是否需要
   （a）接受它（法线/高光插值收益），还是（b）改走**自定义 spine 路径**做真形变。
   ⚠ (b) 有雷：spine 路径**不含 bevel**，用在 body-lower 会丢两端 15 mm 倒角 → 与相邻件错位
   （R21 预研 §2.2 已定罪）。要走 (b) 必须先解决 bevel，属新方案，需主理人单独派单。
3. `vite build` 半段未跑（写 `dist/` 越白名单）。
4. 与 v800-dev-b / v800-dev-c 的写盘竞态已预警（工厂重产会整文件覆盖
   `src/model/createV800Model.ts`）；已告知二者本次重产后的 mtime/size，
   请他们以此为基线做手写几何增量。

---

## 9. 追加：body-lower 侧壁顶边曲线实测（team-lead 追加需求 / dev-c 依赖）

探针：`.img2threejs/tools/r22_topedge_probe.ts`（输出 `verify/r22/loft/topedge_run.log`）。
**重测前已对 mtime**：`createV800Model.ts` 仍为 2026-10-21 02:07:13（未被他人覆盖）。

方法：解析法，**用平面 `x_local = s` 切 body-lower 三角网格**（`x_local` = 车长方向），
得横截面线段集，按 1mm 的 y 桶记录 `|world_x| = |1.003 − z_local|` 的最大值
（`body-lower` transform: `position [1.003,0,0]`, `rotation [0,−1.5708,0]` ⇒ `world_x = 1.003 − z_local`，
`world_z(工厂裸, 车头+Z) = x_local`，`world_z(#assembled, 车头−Z) = −x_local`）。
与 dev-c 的 −x 射线扫描等价，但不暴力 raycast。

### 9.1 需求① 六点采样（#assembled 世界系，车头 −Z / 车尾 +Z）

| z_a (assembled) | z_f (工厂裸) | x_local (车长,+车头) | **y_top** | \|x\| @顶（**倒角棱**） | \|x\| @顶−30mm（**完整侧壁**） |
|---|---|---|---|---|---|
| +1.60 | −1.60 | −1.60 | **1.5400** | 0.9890 | 1.0033 |
| +1.00 | −1.00 | −1.00 | **1.6600** | 0.9900 | 1.0031 |
| 0.00 | 0.00 | 0.00 | **1.6600** | 0.9904 | 1.0031 |
| −1.00 | +1.00 | +1.00 | **1.2530** | 0.9910 | 1.0047 |
| −1.60 | +1.60 | +1.60 | **1.0620** | 0.9853 | 0.9957 |
| −2.50 | +2.50 | +2.50 | **n/a** | n/a | n/a |

> z_a = −2.50 对应 x_local = +2.50，**超出 body-lower 前端（x_local max = 2.368）**，无截面。
> 车身最前端在 assembled 系 **z_a = −2.368**，该处 y_top ≈ 1.030。

⚠ **顶边 x 的两个口径别混**：顶边棱本身已被 `bevel {size:0.012}` 内缩，所以 `|x|@顶 ≈ 0.990`；
倒角以下 30mm 才是完整侧壁 `|x| ≈ 1.003`。**dev-c 量到的 1.0066~1.0071 是侧壁（含 waistBulge 外鼓），
不是顶棱** —— 两者差 13~17mm，做贴面常量表时必须分清取哪个。

### 9.2 需求② bbox 与 tri

| 项 | 值 |
|---|---|
| 工厂裸模型世界 bbox | min(−1.0150, 0.2000, −2.8300) / max(1.0150, 1.6600, 2.3680) |
| #assembled 世界 bbox（rotY π） | min(−1.0150, 0.2000, −2.3680) / max(1.0150, 1.6600, 2.8300) |
| tri | **3,188**（verts 2,068） |
| loft | `{ "rings": 13 }` |

### 9.3 需求③ 门区仲裁：**y = 1.660，不是 1.090** —— 两者都存在，是分段

顶边按车长**分段**（`x_local` = 车长，+ 为车头）：

| x_local 区间 | (assembled z_a 区间) | y_top | 含义 |
|---|---|---|---|
| [1.05, 2.35] | z_a ∈ [−2.35, −1.05] | 1.030 → 1.090 | **前舱 / 机盖段** ← 旧注释「挤出壳顶面 y≈1.090」指的就是这里（R19f 内舱暗面注释的语境） |
| [0.55, 1.05] | z_a ∈ [−1.05, −0.55] | 1.090 → 1.660 | A 柱上升斜坡（陡） |
| **[−1.45, 0.55]** | **z_a ∈ [−0.55, 1.45]** | **1.660（平顶）** | **门区 / 座舱侧壁高墙** ← dev-c 说被盖住的正是这段 |
| [−1.80, −1.45] | z_a ∈ [1.45, 1.80] | 1.660 → 1.090 | D 柱下降斜坡（陡，斜率 ≈ 1.8 y/m） |
| [−2.82, −1.80] | z_a ∈ [1.80, 2.82] | 1.035 → 0.985 | 尾段顶 |

**结论：两者不矛盾 —— 1.090 是前舱机盖段，1.660 是门区段。team-lead 问的「门区 z≈+0.5..+1.2」落在
x_local ∈ [−1.2, −0.5]，y_top = 1.6600，`|x|@顶 = 0.9904`、`|x|@侧壁 = 1.0031`。**

侧窗遮挡复核（支持 dev-c 的定性结论，量值略差）：
- `greenhouse-glass` 世界 bbox |x| = **0.9620**、顶 y = **1.7620**；body-lower 门区顶 y = 1.6600。
- ⇒ 门区**可见窗带 = 1.7620 − 1.6600 = 102 mm**（dev-c 报 74 mm，量值有差，但「窗被侧壁压掉大半」的定性结论成立）。
- 量值差异根因待查：dev-c 的 z 轴可能与本表有偏移（见 9.5）。

### 9.4 需求④ loft **没有**改变这条上边缘（Δ = 0）

| z_a | y_top: loft → 现状 | Δy | \|x\|@顶: loft → 现状 | Δx |
|---|---|---|---|---|
| +1.60 | 1.5400 → 1.5400 | 0 | 0.9890 → 0.9890 | 0 |
| +1.00 | 1.6600 → 1.6600 | 0 | 0.9900 → 0.9900 | 0 |
| 0.00 | 1.6600 → 1.6600 | 0 | 0.9904 → 0.9904 | 0 |
| −1.00 | 1.2530 → 1.2530 | 0 | 0.9910 → 0.9910 | 0 |
| −1.60 | 1.0620 → 1.0620 | 0 | 0.9853 → 0.9853 | 0 |

全域（step 0.05 m）最大差：**Δy_top = 0.000e+0 m，Δ|x_outer| = 0.000e+0 m**。
⇒ **dev-c 的 `OUTER_X` 常量表不需要重建**（loft 是纯细分，见 §6.1）。

### 9.5 与 dev-c 锚点的差异（请他复核 z 轴）

dev-c 报「z=−1.75 → y=1.665@x=0.9979；z=−1.71 → y=1.312」。本探针两种读法：

| dev-c 的 z | 按 assembled(车头−Z) 读 | 按 factory(车头+Z) 读 |
|---|---|---|
| −1.75 | x_local=+1.75 → y_top **1.0550**, \|x\|@顶 0.9797 | x_local=−1.75 → y_top **1.1900**, \|x\|@顶 0.9913 |
| −1.71 | x_local=+1.71 → y_top **1.0570**, \|x\|@顶 0.9808 | x_local=−1.71 → y_top **1.2860**, \|x\|@顶 0.9898 |

- 后者（factory 读法）在 z=−1.71 上与 dev-c 的 1.312 **吻合到 26mm** ⇒ dev-c 用的应是 **factory（车头 +Z）** 系。
- 但 z=−1.75 我读到 1.1900、他读到 1.665 —— **D 柱斜坡段斜率 ≈1.8 y/m，0.04 m 的 z 差就能让 y 差 0.35 m**，
  怀疑是他的 z 采样点在斜坡上有网格偏移，或该行取到了斜坡顶端的 plateau。
- 建议 dev-c 用 §9.3 的分段表（factory 系：门区 plateau 只到 **x_local = −1.45**，不是 −1.75）复核其扫描网格。

---

## 8. 交付物

- `.img2threejs/tools/r22_spec_add_loft.py` —— spec 改写脚本（带回退自检）
- `.img2threejs/tools/r22_roundtrip_dry*.py` —— 写盘铁律干跑验证（CRLF / 无尾换行 / indent=1）
- `.img2threejs/tools/r22_loft_probe.ts` + `.bundle.mjs` —— node shim 权威回归（真实工厂产物）
- `verify/r22/loft/probe_run.log` —— 本次回归完整输出
- 本报告 `verify/r22/loft/README.md`
