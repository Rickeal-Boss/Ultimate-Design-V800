# 资产许可登记表 — 极限刹车挑战 · 尊界V800

登记人：理资（资产与许可管理员） · 核对日期：2026-10-14 · 工程版本：package.json v0.2.0

**结论先行：本项目零外部资产文件。** 全部模型 / 贴图 / 音效 / 环境贴图均为程序化生成（自制），npm 依赖许可已逐项核实。来源不明资产清单为空，无 P0 问题。

---

## 1. 外部文件资产（图片 / 模型 / 音频 / 字体 / HDRI）

**数量：0。** 逐项核实方法与结果：

| 核查项 | 方法（Grep / Read 实际执行） | 覆盖范围 | 结果 |
|---|---|---|---|
| 资源加载调用（`load(`/`Loader`/`fetch(`/`XMLHttpRequest`/`new Image`） | 正则扫描 | `src/` 全部 32 个文件 | **无匹配** |
| 图片 / 模型 / 字体文件引用（`.png` `.jpg` `.webp` `.glb` `.gltf` `.hdr` `.woff` `.ttf` `url(` `@import` `font-face`） | 正则扫描 | `src/` 全部文件 | **无匹配** |
| 音频文件 / `new Audio`（`.mp3` 等） | 正则扫描 | `src/` 全部文件 | **无匹配** |
| HTML 外链（字体 / CDN / 脚本） | 通读 `index.html`；扫描 `dist/index.html` 外部 URL | 入口 + 构建产物 | **无外部 URL** |
| `import` 语句来源 | 全量 import 扫描 | `src/` 全部文件 | 仅本地模块 + `three` / `cannon-es` / `three/addons/*`（npm 包内文件，非外部资产） |

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
| 车身 / 车轮 / 内饰几何 | RoundedBoxGeometry / BoxGeometry 等几何体拼装 | 自制 | `src/render/scene/Car.ts`、`src/render/scene/Interior.ts` |
| 车漆 / 玻璃 / 铬材质 | MeshPhysicalMaterial 参数化（`config/theme.ts`） | 自制 | `src/config/theme.ts`、`src/render/scene/Car.ts`、`src/render/scene/Road.ts` |
| MAEXTRO / V800 字标贴图 | Canvas 2D 文字绘制（`textTexture`） | 自制 | `src/render/scene/Car.ts`（`makeBadgeTexture` 等，Canvas 绘制文字，非官方 logo 矢量图） |
| 沥青 / 噪点贴图 | Canvas 噪点绘制（`paintNoise` / `canvasTexture`） | 自制 | `src/util/canvasTex.ts`、`src/render/scene/Road.ts`、`Car.ts`、`Interior.ts` |
| 环境贴图（HDRI 替代） | PMREMGenerator 对程序化天空球 / 色块场景烘焙 | 自制 | `src/render/scene/Environment.ts`（`bakeEnvironment`） |
| 天空 / 地形 / 道路 | ShaderMaterial 天空球、MeshBasicMaterial 地形、Canvas 贴图路面 | 自制 | `src/render/scene/Environment.ts`、`Terrain.ts`、`Road.ts` |
| 全部音效（电机 / 风噪 / 胎啸 / 事件音） | WebAudio 振荡器 + 噪声缓冲实时合成，**零音频文件** | 自制 | `src/audio/Sfx.ts`（文件头注释明确「全部振荡器/噪声合成，零外部音频文件」） |
| 车辆物理参数 | 公开报道/公开申报资料取值（仅数值，非素材） | 自制整理 | `src/config/physics.ts`（注释标明出处口径） |

## 4. 署名要求清单

| 资产 | 许可 | 署名要求 | 处置 |
|---|---|---|---|
| three / cannon-es / @types/three / vite（MIT） | MIT | **需保留版权与许可声明** | 分发包（含 dist 部署页脚或 ABOUT/README）保留四包的版权声明与 MIT 文本；本仓库已保留 `node_modules` 内 LICENSE 文件，`docs/ASSETS.md` 本节即为声明锚点 |
| typescript（Apache-2.0） | Apache-2.0 | **需保留版权声明与 Apache-2.0 文本； NOTICE 要求一并保留** | 同上；`node_modules/typescript/ThirdPartyNoticeText.txt` 为现成 NOTICE 文本 |
| 自制资产 | 本项目 | 无强制署名要求 | — |
| three.js addons（RoundedBoxGeometry、EffectComposer 等，随 three 包分发） | MIT（随 three） | 同 three | 同 three |

**要点**：MIT / Apache-2.0 均允许商用，但** redistribution 时必须保留版权与许可声明**——若将 dist 部署为公开页面并随包分发依赖代码，发布页需可访问上述声明（常见做法：页脚「Powered by three.js / cannon-es」+ 链接至本文件，或附 LICENSES 汇总文件）。

## 5. 商标与品牌提示（非资产许可，单独登记）

| 项 | 内容 | 代码出现位置 |
|---|---|---|
| 「尊界」品牌名 | 真实品牌商标，权利方为相关车企 | `src/config/physics.ts`、`src/ui/Menu.ts`、`src/ui/Result.ts`、`src/render/scene/Car.ts`、`src/ui/styles.css`、`index.html` |
| 「MAEXTRO / V800」字样 | 真实品牌/车型命名 | `src/render/scene/Car.ts`（Canvas 文字绘制）、`src/ui/Menu.ts` |
| 「华为」关联 | 尊界品牌与华为技术相关；本项目**未**在代码中绘制华为 logo | 仅出现在参数来源注释（`src/config/physics.ts`） |
| 官方 logo / 矢量标识 | **未使用**。车标为 Canvas 手绘文字（`textTexture`），非官方标志文件 | `src/render/scene/Car.ts` |

本项目性质为**个人学习/演示用途的程序化示意复刻，非官方模型**。免责声明已落实：**`README.md`（本次新建）含完整免责声明**（项目性质 / 学习用途 / 品牌归权利方 / 数据来自公开报道 / 非商业用途）。此类商标属示意引用，建议保持非商业、可联系移除的姿态（已写入 README）。

## 6. 与参考仓库的关系

参考仓库仅作**行为基准阅读**（玩法参照），**未复制其任何代码或美术资产**；计分玩法与全部文案为本项目原创实现。

## 7. 来源不明资产清单（P0 项）

**空。** 未发现任何未登记或来源不明的外部资产。

---

*核对方法留痕：Grep 正则扫描（`src/` 32 文件 × 多组模式）、通读 `index.html` / `Sfx.ts` / `canvasTex.ts` / `Environment.ts`、`node_modules/*/package.json` license 字段读取、LICENSE 文件存在性检查。*
