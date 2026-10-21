# R22-D：尾部车顶上方「悬浮深色矩形」诊断报告

裁决：**打回（dpillar-l/r 几何/朝向问题）** —— 非删件、非渲染 bug，是 spec 几何把 D 柱包边做成了「凸出玻璃面的深色斜板」。

诊断人：v800-landing-review 秦核源 ｜ 日期：2026-10-21 ｜ 只诊断，未改任何 src/spec。

---

## 1. 现象与像素量化（先测量后解释）

截图源：`verify/r21/wired2/tg34.png`、`tail34.png`（1280×760）。探针：`.qa/r22_topprofile.py`（列顶部轮廓）、`.qa/r22_darkscan.py`。

- **顶部轮廓无穿顶**：两图全宽 y_top 平滑（tg34 y≈106→148 连续下降；tail34 y≈281→354），**无任何 x 段高出车顶轮廓基线 ≥10px**。即暗块并未「凸出车顶轮廓线」，是凸出/叠在**后风挡与尾门上沿**的视觉区（任务描述的「凸出车顶」属目视误判，Read 工具缩放截图不可信——已用游程扫描证伪）。
- **暗块坐标（1280×760 实像素）**：
  - tg34：主悬浮板 x≈444..557、y≈154..415（圆角矩形、右上倾）；旁伴亮边 L 形面 x≈555..645、y≈160..280。
  - tail34：车顶后缘立鳍 x≈495..590、y≈385..520（顶缘有圆角缺口）。
- 背景色标定：背景 (36,26,30) r−g=+10（酒红调）；车漆/玻璃中性 r−g≤5 —— 以 `r−g≥6` 为背景判据做轮廓分割（`.qa/r22_topprofile.py`）。

## 2. 射线定罪链（assembled #assembled，CDP 9335，vite 127.0.0.1:4317）

探针：`.qa/r22_roofprobe.mjs` → `verify/r22/rearroof/r22_roofprobe.json`、`r22_tail34.png`、`r22_tg34.png`（fresh 渲染，现象复现）。

- 暗块区域 NDC 射线网格首命中分布：
  - tg34 slab 区（x430..630,y150..420）：`batch/paint-upper` 22、`greenhouse-glass` 60、**`batch/matte-black` 28** ← 暗块本体
  - tail34 鳍区（x470..610,y360..540）：`batch/paint-upper` 24、`rear-glass-upper` 5、`greenhouse-glass` 19、**`batch/matte-black` 8**
- `batch/matte-black` 成员（`userData.batchMerged.from`）：dpillar-l/r、bpillar-l/r、cpillar-l/r、apillar-l/r、roof-rails、rear-valance。
- bbox 口径换算验证：裸工厂成员 union（spec 镜像 Z）= lo[−0.99,0.14,−1.647] hi[0.99,1.869,2.895]，与 assembled 实测 batch bbox lo[−1.045,0.14,−1.721] hi[1.045,1.869,2.895] 吻合（bevel 差 <5.5cm）→ 镜像换算口径可信。

## 3. 消去法截图定罪（raw 裸模型逐组件隐藏，镜像机位 az150≡assembled az30）

探针：`.qa/r22_elim.mjs`（投影 bbox 相交筛选候选 → 逐个隐藏→截图→恢复）；diff：`.qa/r22_elimdiff.py`。

**tail34 鳍区 (660,370)-(810,550) 像素变化数：**

| 组件 | 变化 px | 备注 |
|---|---|---|
| body-lower / greenhouse-glass | 1464 / 1278 | 隐藏后露背景/舱内，非定罪 |
| **dpillar-l** | **688** | ← 暗块独立贡献第一名（实体件） |
| d-pillar-rear-l | 456 | 尾角回包下部入区，合法件 |
| rear-glass-upper | 370 | 隐私玻璃，合法件 |
| 其余 60 候选 | 0 | |

**tg34 slabA 区 (700,130)-(860,440)：dpillar-l = 5139 px（玻璃 8120 为露舱假阳性；body-lower 3651 同为假阳性）；slabB 区 dpillar-l = 556 px。**

目检对照（左右并排图）：
- `cmp_tg34_dpillarl.png`：隐藏 dpillar-l 后**悬浮圆角深色板消失**，尾窗完整。
- `cmp_tail34_dpillarl.png`：隐藏 dpillar-l 后**车顶后缘立鳍消失**。

tg34 视角的「2–3 块矩形」实为同一 dpillar-l 的三个可见面（深色 rear face 圆角矩形 + 受光顶缘 L 形面 + 玻璃接缝暗带），非三个独立部件。

## 4. 定罪组件数据

**id：`dpillar-l`（左）/ `dpillar-r`（右，被车身遮挡未见）｜ 名称「D 柱银白宽包边」｜ 材质 matte-black ｜ 源：`src/model/createV800Model.ts` ≈L1406/1523**

| 项 | 值（spec local，车头=+Z） | assembled 世界（镜像 Z） |
|---|---|---|
| transform.position | [0.885, 1.4375, −2.55] | z=+2.55 |
| scale | [0.13, 0.675, 0.46] | — |
| rotation | rotZ −0.12（−6.9°，顶向外倾） | — |
| 世界 bbox | y 1.095..1.78、z −2.78..−2.32、x 0.78..0.99 | y 1.095..1.78、z 2.09..2.55 |
| 几何 | 圆角矩形挤出 profile（±0.5 圆角 22.5° 四面弧），depth 1×scale | — |

邻件参照（同口径）：rear-glass-upper（后风挡）y 1.14..1.77、z −2.824..−2.794；roof-panel y 1.739..1.848、z −2.825..1.14；sunroof-glass 顶 y≈1.84。

**已排除项（同样有嫌疑但证伪）：**
- `roof-spoiler`（车顶扰流小尾翼）：实际世界 bbox y 1.839..1.857、z 2.66..2.8、x ±0.7 —— 平贴顶盖后缘、仅高出顶面 ~9mm，投影不落入暗块区，隐藏无变化。⚠️ 顺带发现 spec 自述矛盾：其 note/localFeatures 称「后缘上翘至 y≈1.563、前缘 z−2.34」，实际位置 y≈1.848/z−2.73 —— note 与几何不同源，建议 dev 核对（非本次观感缺陷成因）。
- `d-pillar-rear-l/r`（尾角回包 0.18×0.95×0.09）：世界 y 0.5..1.45、z 2.766..2.856 —— 尾角侧面 legit 件，仅区缘 456px，非悬浮板。
- `roof-rails`：y 1.825..1.869 平贴顶面两侧长条，非竖立板。
- **删件/破碎类误判**：不成立 —— 组件存在、visible、命中正常。
- **写盘竞态**：已排除 —— 最后源码写盘 V800Adapter 00:29 < tail34 00:32 < tg34 00:40 < commit 01:44；且本次 fresh 重渲（r22_tail34/tg34.png）现象复现。

## 5. 根因（对照组件自身设计意图）

该变换自 R13（commit d888b80）引入后未再改动。R21 隐私玻璃波（53742d8）把后风挡改暗改亮面后，衬底对比变强，此板才被看见。

1. **深度失控**：scale.z=0.46 —— 一条「柱包边」做成 46cm 纵深的板，占据 z 2.09..2.55（后风挡玻璃面 z≈2.81 的正前方 26~72cm），在尾窗两侧整片立起。
2. **朝向反 rake**：rotZ ∓0.12 使顶边**向外**倾 7°（D 柱正确 rake 应随玻璃house内收），外顶角凸出，侧后 3/4 视角轮廓脱离玻璃面。
3. **后缘未按自述对位**：R13 note「银白包边后缘跟随立直后的玻璃尾面（z=−2.82）」—— 实际后缘面 = −2.55+0.23 = −2.78，差 4cm；前缘 −2.32 悬在尾窗侧前方，形成「漂浮」。
4. **命名/材质矛盾**：组件名与 colorMaterialRecipe 均为「银白 rgba(216,217,220)」，但 material=matte-black 渲染纯黑 —— 黑色大板 + 亮玻璃衬底放大观感违和（若 blackout 是有意为之则保留，但需 dev 确认）。

## 6. 修复建议（只建议，不动手）

按效果优先级，改 `dpillar-l` / `dpillar-r` 的 spec `transform`：

1. **收深度**（主修）：`scale` z 0.46 → **0.30**，同时 `position` z −2.55 → **−2.67**（后缘面落 −2.82 与 R13 note 对齐，前缘 −2.52 仍压住尾角）。
2. **正朝向**：`rotation` rotZ ∓0.12 → **0**（或按玻璃house rake 内倾 +0.06~0.08），消除顶外倾凸出。
3. **压顶线**（可选）：`scale` y 0.675 → **0.60**（顶 1.71 < 玻璃顶 1.77），彻底消除板顶与顶盖棚位冲突。
4. **材质确认**：与设计核对「银白包边 vs matte-black」，若改银白需评估与 dpillar 铬条/尾灯光晕的连带。
5. 文档一致性：修 `roof-spoiler` 的 note（y 1.563/z−2.50 与实际 1.848/−2.73 不符），防下次 QA 同源误判（R21 尾灯教训）。

## 7. 产物清单

| 文件 | 说明 |
|---|---|
| `verify/r22/rearroof/r22_roofprobe.json` | 射线网格 + 组件 bbox 原始数据 |
| `r22_tail34.png` / `r22_tg34.png` | fresh #assembled 复现截图 |
| `r22e_tail34_base.png` / `r22e_tg34_base.png` | 消去法基线 |
| `r22e_*_hide_*.png` | 逐组件隐藏对照（tail34×45、tg34×66） |
| `cmp_tg34_dpillarl.png` / `cmp_tail34_dpillarl.png` | 定罪并排对照图 |
| `.qa/r22_topprofile.py` / `r22_darkscan.py` / `r22_roofprobe.mjs` / `r22_elim.mjs` / `r22_elimdiff.py` / `r22_members.mjs` | 可复跑探针 |
