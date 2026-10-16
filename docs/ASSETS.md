# 资产许可登记表 — 极限刹车挑战 · 尊界V800

登记人：理资（资产与许可管理员） · 核对日期：2026-10-14 · 工程版本：package.json v0.2.0

**结论先行：运行时产物零外部资产文件；仓库曾入库的 12 张第三方官方宣传图裁片，已于 2026-10-14 全部移除（清单见第 7 节）。** 全部模型 / 贴图 / 音效 / 环境贴图均为程序化生成（自制），npm 依赖许可已逐项核实。来源不明资产清单为空，无遗留 P0 问题。

---

## 1. 外部文件资产（图片 / 模型 / 音频 / 字体 / HDRI）

**数量：0。** 逐项核实方法与结果：

| 核查项 | 方法（Grep / Read 实际执行） | 覆盖范围 | 结果 |
|---|---|---|---|
| 资源加载调用（`load(`/`Loader`/`fetch(`/`XMLHttpRequest`/`new Image`） | 正则扫描 | `src/` 全部 30 个文件 | **无匹配** |
| 图片 / 模型 / 字体文件引用（`.png` `.jpg` `.webp` `.glb` `.gltf` `.hdr` `.woff` `.ttf` `url(` `@import` `font-face`） | 正则扫描 | `src/` 全部 30 个文件 | **无匹配** |
| 音频文件 / `new Audio`（`.mp3` 等） | 正则扫描 | `src/` 全部 30 个文件 | **无匹配** |
| HTML 外链（字体 / CDN / 脚本） | 通读 `index.html`；扫描 `dist/index.html` 外部 URL | 入口 + 构建产物 | **无字体 / CDN / 脚本外链**；仅第 4 节要求的许可署名链接（threejs.org / cannon-es / typescriptlang.org），不加载任何资源 |
| 仓库内图片文件（`.png` `.jpg`） | 文件系统遍历 + `find` 全仓扫描 | 仓库全部目录（含 `.img2threejs/`） | **曾命中 12 张第三方裁片，2026-10-14 已全部删除**；现仓库内图片 **29 张**，全部位于 `.img2threejs/renders/`，为本项目 QA 门禁的**自渲染截图**（代码零引用、非第三方素材），清单见第 7 节 |
| `import` 语句来源 | 全量 import 扫描 | `src/` 全部 30 个文件 | 仅本地模块 + `three` / `cannon-es` / `three/addons/*`（npm 包内文件，非外部资产） |

> **运行时产物口径**：上表第 1–4 项针对 `src/` 与 `dist/` 运行时产物，结果为「零外部资产、全程序化生成」；第 5 项针对仓库工作区，历史上曾存在第三方图片（第 7 节登记），现已清空。

## 2. npm 依赖许可登记

许可核实依据：逐个读取 `node_modules/<pkg>/package.json` 的 `license` 字段，并确认包根目录存在 LICENSE 文件（非凭记忆填写）。

| 名称 | 版本（实测安装） | 许可类型 | 用途 | 依据 | 引用路径 |
|---|---|---|---|---|---|
| three | 0.186.1 | MIT | 3D 渲染（场景 / 材质 / 后处理 EffectComposer 等 addons） | `node_modules/three/package.json` + `node_modules/three/LICENSE` | `package.json` dependencies；`src/render/**`、`src/fx/index.ts`、`src/config/theme.ts` 等 14 处 import |
| cannon-es | 0.20.0 | MIT | 刚体物理（车辆 / 碰撞） | `node_modules/cannon-es/package.json` + `node_modules/cannon-es/LICENSE` | `package.json` dependencies；`src/physics/World.ts` |
| @types/three | 0.186.0 | MIT | three 的 TypeScript 类型定义（仅开发期） | `node_modules/@types/three/package.json` + LICENSE | `package.json` devDependencies；不进入运行时产物 |
| typescript | 5.9.3 | Apache-2.0 | 编译 / 类型检查（仅开发期） | `node_modules/typescript/package.json` + `LICENSE.txt` + `ThirdPartyNoticeText.txt` | `package.json` devDependencies；`npm run build` 中 `tsc --noEmit` |
| vite | 7.3.7 | MIT | 构建 / 开发服务器（仅开发期） | `node_modules/vite/package.json` + `LICENSE.md` | `package.json` devDependencies；构建工具链 |

> 版本号以 node_modules 实际安装为准（`vite` package.json 声明 `^7.1.0`，实装 7.3.7；`typescript` 声明 `~5.9.2`，实装 5.9.3）。

## 3. 自制资产登记（程序化生成）

均标注：**自制（本项目程序化生成）**，来源 = 本项目源码，无外部素材输入。

| 名称 | 生成方式 | 来源 | 引用路径 |
|---|---|---|---|
| 车身 / 车轮 / 内饰几何 | 程序化几何体拼装（BoxGeometry / 顶点级 sculpt 组件树） | 自制 | `src/model/createV800Model.ts`（原 `render/scene/Car.ts`、`Interior.ts` 已于 2026-10-14 核实 0 引用后作为死代码删除） |
| 车漆 / 玻璃 / 铬材质 | MeshPhysicalMaterial 参数化（材质表 + `config/theme.ts`） | 自制 | `src/model/createV800Model.ts`、`src/config/theme.ts`、`src/render/scene/Road.ts` |
| MAEXTRO / V800 字标贴图 | Canvas 2D 文字绘制（厂内 `makeCanvas` + `THREE.CanvasTexture`） | 自制 | `src/model/createV800Model.ts`（Canvas 绘制文字，非官方 logo 矢量图）；发光驱动见 `src/model/V800Adapter.ts` |
| 沥青 / 噪点贴图 | Canvas 噪点绘制（`paintNoise` / `canvasTexture`） | 自制 | `src/util/canvasTex.ts`、`src/render/scene/Road.ts` |
| 环境贴图（HDRI 替代） | PMREMGenerator 对程序化天空球 / 色块场景烘焙 | 自制 | `src/render/scene/Environment.ts`（`bakeEnvironment`） |
| 天空 / 地形 / 道路 | ShaderMaterial 天空球、MeshBasicMaterial 地形、Canvas 贴图路面 | 自制 | `src/render/scene/Environment.ts`、`Terrain.ts`、`Road.ts` |
| 全部音效（电机 / 风噪 / 胎啸 / 事件音） | WebAudio 振荡器 + 噪声缓冲实时合成，**零音频文件** | 自制 | `src/audio/Sfx.ts`（文件头注释明确「全部振荡器/噪声合成，零外部音频文件」） |
| 车辆物理参数 | 公开报道/公开申报资料取值（仅数值，非素材） | 自制整理 | `src/config/physics.ts`（注释标明出处口径） |

## 4. 署名要求清单

| 资产 | 许可 | 署名要求 | 处置 |
|---|---|---|---|
| three / cannon-es / @types/three / vite（MIT） | MIT | **需保留版权与许可声明** | 分发包（含 dist 部署页脚或 ABOUT/README）保留四包的版权声明与 MIT 文本；本仓库已保留 `node_modules` 内 LICENSE 文件，`docs/ASSETS.md` 本节即为声明锚点；**已落地**：`index.html` 页脚 `#credits` 含 three.js / cannon-es 署名与外链，`vite build` 后随 `dist/index.html` 分发 |
| typescript（Apache-2.0） | Apache-2.0 | **需保留版权声明与 Apache-2.0 文本； NOTICE 要求一并保留** | 同上；`node_modules/typescript/ThirdPartyNoticeText.txt` 为现成 NOTICE 文本；**已落地**：`index.html` 页脚 `#credits` 含 TypeScript 署名与 typescriptlang.org 外链，随 `dist/index.html` 分发 |
| 自制资产 | 本项目 | 无强制署名要求 | — |
| three.js addons（RoundedBoxGeometry、EffectComposer 等，随 three 包分发） | MIT（随 three） | 同 three | 同 three |

**要点**：MIT / Apache-2.0 均允许商用，但** redistribution 时必须保留版权与许可声明**——若将 dist 部署为公开页面并随包分发依赖代码，发布页需可访问上述声明（常见做法：页脚「Powered by three.js / cannon-es」+ 链接至本文件，或附 LICENSES 汇总文件）。

## 5. 商标与品牌提示（非资产许可，单独登记）

| 项 | 内容 | 代码出现位置 |
|---|---|---|
| 「尊界」品牌名 | 真实品牌商标，权利方为相关车企 | `src/config/physics.ts`、`src/ui/Menu.ts`、`src/ui/Result.ts`、`src/model/createV800Model.ts`、`src/ui/styles.css`、`index.html` |
| 「MAEXTRO / V800」字样 | 真实品牌/车型命名 | `src/model/createV800Model.ts`（Canvas 文字绘制）、`src/ui/Menu.ts` |
| 「华为」关联 | 尊界品牌与华为技术相关；本项目**未**在代码中绘制华为 logo | 仅出现在参数来源注释（`src/config/physics.ts`） |
| 官方 logo / 矢量标识 | **未使用**。车标为 Canvas 手绘文字（`CanvasTexture`），非官方标志文件 | `src/model/createV800Model.ts` |
| 商标引用性质 | **仅文字性引用**（标题 / 文案 / Canvas 文字），非官方模型、非工程级还原 | `README.md`、`index.html`、`src/ui/Menu.ts`、`src/model/createV800Model.ts` |

本项目性质为**个人学习/演示用途的程序化示意复刻，非官方模型**。免责声明已落实：**`README.md`（本次新建）含完整免责声明**（项目性质 / 学习用途 / 品牌归权利方 / 数据来自公开报道 / 非商业用途）。此类商标属示意引用，建议保持非商业、可联系移除的姿态（已写入 README）。

**含未获证实特征的声明**：模型 spec 中有 2 项细节（车顶行李架纵轨 `d-roof-rail`、尾门高位刹车灯 `d-third-brakelight`）在全部 82 张本地参考图中均未出现，属按车型惯例的推定而非实测证据，已在 `.img2threejs/object-sculpt-spec.json` 中标 `confidence: 0.5` 并附 note；其中 `high-mount-stop` 组件已从 spec 删除。其余细节的覆盖状态可对照 `docs/reference-checklist.md`（83 条特征的逐条对账）。

## 6. 与参考仓库的关系

参考仓库仅作**行为基准阅读**（玩法参照），**未复制其任何代码或美术资产**；计分玩法与全部文案为本项目原创实现。

## 7. 第三方素材登记与移除记录（P0 项，已处置）

**性质**：以下 12 张图片为第三方（华为 / 鸿蒙智行 · 尊界 V800 官方宣传图）的裁片与材质证据图，由本机建模管线在参考分析阶段自动切出并写入仓库，**属于未授权的第三方图片再分发**，登记为 P0 项。

**处置**：2026-10-14 已从仓库工作区**全部删除**（仅做文件系统删除，git 索引与历史由仓库维护者统一处理）。**第三方**图片文件数现为 **0**，原图未随仓库分发，删除目录：`.img2threejs/details/`、`.img2threejs/material-evidence/`。

| # | 文件名（已删除） | 来源性质 | 入库路径 | 移除日期 |
|---|---|---|---|---|
| 1 | `zone-r0c0.png` | 官方宣传图裁片（3×3 分区） | `.img2threejs/details/` | 2026-10-14 |
| 2 | `zone-r0c1.png` | 同上 | `.img2threejs/details/` | 2026-10-14 |
| 3 | `zone-r0c2.png` | 同上 | `.img2threejs/details/` | 2026-10-14 |
| 4 | `zone-r1c0.png` | 同上 | `.img2threejs/details/` | 2026-10-14 |
| 5 | `zone-r1c1.png` | 同上 | `.img2threejs/details/` | 2026-10-14 |
| 6 | `zone-r1c2.png` | 同上 | `.img2threejs/details/` | 2026-10-14 |
| 7 | `zone-r2c0.png` | 同上 | `.img2threejs/details/` | 2026-10-14 |
| 8 | `zone-r2c1.png` | 同上 | `.img2threejs/details/` | 2026-10-14 |
| 9 | `zone-r2c2.png` | 同上 | `.img2threejs/details/` | 2026-10-14 |
| 10 | `crop-leather.jpg` | 官方宣传图材质证据裁片（皮革） | `.img2threejs/material-evidence/` | 2026-10-14 |
| 11 | `crop-paint-gold.jpg` | 官方宣传图材质证据裁片（金漆） | `.img2threejs/material-evidence/` | 2026-10-14 |
| 12 | `ref-side-cropped.jpg` | 官方宣传图裁切（侧视参考） | `.img2threejs/material-evidence/` | 2026-10-14 |

**权利人移除通道**：如权利方认为存在不适宜之处，请通过本仓库 **GitHub Issues**（或 README 载明的联系方式）提出，**将在 48 小时内移除**相关内容；本记录长期保留以便溯源。

**仓库内无任何第三方图片实体**：上表 12 张图片已从工作区删除，`find` 全仓扫描确认第三方图片文件数 = 0（2026-10-16 起仓库内另有 29 张 QA 自渲染截图，均位于 `.img2threejs/renders/`，代码零引用，不构成第三方素材）。分析记录（`.img2threejs/assessment.json` / `detail-inventory.json` / `state.json` / `object-sculpt-spec.json`）中仍保留这些裁片的引用，但一律改写为 `已移除:<原文件名>` 形式（如 `已移除:zone-r0c0.png`、`已移除:crop-paint-gold.jpg`，含目录项 `已移除:details`），**不再保留任何形似路径的指向**；保留目的仅为审计线索——标明「哪个分析结论依据哪张裁片得出」，不构成图片再分发，也避免自动化扫描误判仓库内仍存在该文件。

**其他合规处置（同批次）**：
- 本机绝对路径（`C:/Users/<user>/...`）已在 `.img2threejs/` 全部脚本与记录中脱敏为 `<workspace>` / `<local-reference>` 占位（共 53 处，详见文末留痕）。
- 商标「尊界 / MAEXTRO / V800 / HUAWEI」统一为**文字性引用**口径，README 与本节均已声明「非官方模型、非工程级还原」。

## 8. 来源不明资产清单（P0 项）

**空（就运行时产物而言）。** `src/` 与 `dist/` 未发现任何未登记或来源不明的外部资产；仓库工作区曾出现的第三方图片已在第 7 节登记并移除。

---

*核对方法留痕：Grep 正则扫描（`src/` 30 文件 × 多组模式）、`find` 全仓图片文件遍历、通读 `index.html` / `Sfx.ts` / `canvasTex.ts` / `Environment.ts`、`node_modules/*/package.json` license 字段读取、LICENSE 文件存在性检查。*
*2026-10-14 变更留痕：删除第三方图片 12 张（第 7 节）；`.img2threejs/` 路径脱敏 53 处（`C:/Users/...` → `<workspace>` / `<local-reference>`）；指向已删图片的 30 处引用改写为 `已移除:<原文件名>` 标记（`assessment.json` 14、`detail-inventory.json` 14（含目录项 1）、`state.json` 1，另 `object-sculpt-spec.json` 14 由 spec-model 同格式处理）；删除 0 引用死代码 `src/render/scene/Car.ts`、`Interior.ts`（801 行）；`index.html` 新增 `#credits` 许可署名并验证进入 `dist/index.html`。*
