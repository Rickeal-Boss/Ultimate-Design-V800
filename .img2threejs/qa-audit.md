# P5 独立复核报告（auditor）— 傍晚波返工复验

- **审计人**：复核（未参与本波任何开发，未采信开发自述，全部独立实测）
- **时间**：2026-10-16 21:00–21:40 (UTC+8)
- **对象**：git 9afac60 + 未提交工作树（spec 170 组件 / 工厂重产 / lighter2 材质波 / preview 座舱捕获）
- **环境**：Edge headless `--headless=new --enable-unsafe-swiftshader` Edg/155.0.4283.45（与 QA 基线同版本；**未加 --disable-gpu**，FPS 读数不可比，calls/tris 为 CPU 提交口径可比）；vite 5201；CDP 9334（PowerShell Start-Process 编排，node 直 spawn msedge EACCES 复现）
- **证据**：`.img2threejs/renders/qa-audit/`（19 张 P5-* 截图 + qa-audit-data.json），全部为本审计独立重拍/重算，未复用开发者截图
- **git 零写操作**；源码/spec 只读

---

## A. 返工 4 项独立复验

### A1 屏幕 UI —— PASS
| 证据 | 内容 |
|---|---|
| P5-tri-screen-frontal | 三联屏 HarmonyOS 风时钟 UI「10:36 / 10月16日 周五」清晰 |
| P5-gauge-screen-frontal | 仪表「0 km/h」UI 可辨 |
| P5-rear-ctrl-screen | 后排控制屏完整 UI：后排控制 / 24℃ 温度 / 座椅 加热 / 遮阳 / 氛围 |
| P5-seat-screen-l-b | 扶手屏 UI 文字可见（屏面环境反射较强，非素板） |

机位经 `car.body.matrixWorld` 8 角点映射独立复算：三联屏世界盒中心 z=−1.14（车头侧）、尾灯 z=+2.85 —— **qa-final2/3 把车头拍成尾灯的坐标系坑确认已修**。

### A2 菱格 —— PASS（附钩子判据漏洞登记）
- P5-quilt-rearl-back-close / -cabin：菱形绗缝 + 缝点清晰、**等密度、无水平乱纹**（qa-final N2 的"整面水平拉丝"已消除）；P5-quilt-cushion-high 顶部两角座面菱格同观感；P5-quilt-third-back 三排为素面（设计口径，非缺陷）。
- #uvassert 串味判据重跑：leather-warm 6,240 / screen-ui 1,152 / housing-dark 536 / lamp-white 576 / lamp-gold 2,560 —— **0 越界**。
- 密度扩展判据：**钩子存在判据漏洞** —— quiltTiled 分支（V800Adapter.ts:2267）设 `regionKey='tile'` 后仍走 `if (ri < 0) continue`（:2292），**菱格合并组全部三角形被跳过**，console.info「图案分区无超阈」对菱格组是**空集结论**。本审计在浏览器内对菱格合并组独立复算（同算法不含 skip）：**1,264 个有效三角（≥0.1cm² 非折边），各向异性中位 1.41×、P90 1.41×、0 超 4x、0 超 8x** —— 结论补实为真值，视觉与数值双证。钩子须修（见登记项 R1）。

### A3 speaker 素面金 —— PASS
P5-speaker-rl-macro / P5-tweeter-l-macro：深色拉丝金属圆盘 + 金属环，无金色点阵串味（lamp-gold 素面区 2,176 三角归位；同 H5-speaker-rl-macro 机位重拍）。

### A4 尾灯真车尾 —— PASS
- 世界坐标独立复算：taillamp-l/r 中心 **z=+2.85**、签名屏 z=+2.873（世界 +z 为车尾，与简报口径一致）。
- P5-tail-wide-trueRear：双尾灯对称、铬框内**红横带上下分组 + 中段黑场承载 EX-29 金色点阵签名屏**、车尾无三联屏/盾标（确证非车头）。
- P5-taillamp-l-macro-trueRear / P5-signature-macro-trueRear：金点阵屏特写清晰，红带（特写下计上 2+下 2 块，受签名屏框分隔；wide 机位下 3+3 分组观感成立）、铬框银白在位。红带逐条精确计数属美术精判，不在本审计裁决范围。

## B. 结构与版本 —— PASS
- `package.json:15` `"three": "0.186.1"` 精确钉版（无 ^/~）；全仓 **0** 个 CDN URL（unpkg/jsdelivr/cdn/http 扫描无命中）。
- 废弃/移除 API 扫描 0 命中：outputEncoding / sRGBEncoding / physicallyCorrectLights / THREE.Geometry / examples\/js\// MeshFaceMaterial / MultiMaterial / PointCloud / useLegacyLights / GammaEncoding / LinearEncoding。
- 目标版本（r186）写法核验：`outputColorSpace = SRGBColorSpace`（Renderer.ts:20，r152+）；Canvas 贴图 colorSpace 14 处 SRGB + **法线/数据贴图 NoColorSpace**（V800Adapter.ts:715）—— 无色彩空间错配。
- **webgl_audit.mjs（meimei 插件内）退出码 0 / error 0 / warn 1**：唯一 warn W07「未检出固定版本」为**误报**——判据按 CDN URL 设计，本项目 npm 精确钉版比 CDN 固定更严（与上波 P5 同款误报）。

## C. 工厂一致性 —— PASS（全量，超出抽验 ≥10 件要求）
- 生成标记：createV800Model.ts 文件头**无**生成标记。核实：生成器 `generate_threejs_factory.py` 本身不输出头标记，HEAD 旧版同样无 —— "文件头应有生成标记"预期不成立（生成器无此设计），改为实质一致性核验。
- spec componentTree **170** ↔ 工厂 sculpt mesh **170**，双向 id 集合无差（0 missing / 0 多余）。
- transform 全量比对 **170/170 一致**（容差 1e-4，rotation 1e-3）：position/rotation 取 `node_*.set`；scale 按工厂约定核对 `mesh_*Geometry.scale()`（node.scale 恒 1,1,1，尺寸真源烘进几何——与 MEMORY 硬坑①口径一致）。

## D. 合批与预算 —— PASS（附 2 项登记）
- **#batchmerge 重跑复现**：mesh 170→66、可见 164→60、**DC −104**；自校验 problems 空。
- game 内车模可见 DC **60 ≤ spec 预算 60（余量 0，贴线）**——后续任何 +DC 改动需先腾预算。
- 整帧（60s 浸泡 31 样本）：峰值 calls **333** / tris 203,139（qa-baseline 313 → qa-final 331 → 333，同量级缓增，与 builder2 几何增长一致；口径含 transmission 透射 pass 翻倍 + Bloom/SpeedBlur/Output 多 pass，headless auto 高档）。**PERF.md 红线 150 的原始估算 ≈112 未计入高档透射翻倍**（见登记项 R2）。非本波回归。
- setPixelRatio 上限：quality.ts high=Math.min(dpr,2) / medium=1.5 / low=1，**有上限** ✓；实机 DPR 1.00。

## E. 资产与许可 —— PASS（附 1 项文档整改）
- **实机网络监听**：两测试页全部请求中图片/模型/字体/HDRI/GLB 类资源 **0 个**（netImageRequests=[]）。
- 代码静态：src/ 零外部资产引用；`TextureLoader` 路径（createV800Model.ts:493）被 textureless 30/30 封死（`referenceMapUrl` 只读 `textureProjection.url`；spec 中 7 处图片字符串均为 evidence **文本引用**非 url 字段）→ 死代码路径，运行时零加载。
- 新增 Canvas 贴图全部程序化（无图片文件加载、无照片像素投影）。
- **R3（整改，低）**：README/ASSETS.md「仓库内 29 张自渲染截图」已过期——`find` 实测 renders/ 下 **232 张**（qa-baseline 37 + qa-final 151 + 历史波次 44），性质不变（本项目自渲染、代码零引用、非第三方素材），数字口径需更新。

## F. 回归 —— PASS
`npx tsc --noEmit` exit 0；`npm test` **37/37**；`npm run build` exit 0（JS 1,679.26 kB / gzip 283.97 kB；chunk>1600kB 提示为既有登记项）。

## G. 七要素 —— PASS
- **Game.ts**：渲染器（createRenderer）/场景/相机（CameraRig）/渲染循环（Loop rAF → update → postfx.render():528）/resize（:539 setSize + rig.resize 相机 aspect + postfx.resize，:129 监听 + orientationchange）/几何体（Road/Terrain/car）/光源（Lighting+Environment）✓；**dispose 链完整**（:549 监听解绑/loop/sfx/fx/postfx/crashWorld/car/renderer，ownedTextures 材质槽级联 + 孤儿兜底）。
- **preview.ts**：渲染器/场景/相机/光源/几何体 ✓；**无渲染循环与 resize** —— dev-only 单帧审查页（vite build 不含此入口），按用途不构成缺陷，注明口径。

## Warn 逐条判断
1. webgl_audit W07：npm 钉版误报（见 B），不成立。
2. "Multiple instances of Three.js"（探针页）：本审计 harness 在页面内二次 import three 所致，非产物问题。
3. WebGLProgram X4122 double precision：SwiftShader/ANGLE 编译器精度警告，无功能影响。

## UNEVALUATED（缺真机 GL 环境，不下结论）
真机帧率与真机整帧 DC（headless 口径不可外推）；美术观感终审（素面粒面 normalMap 的 blob 观感、木纹波纹等"好不好看"由主理人/美术裁决）。

## 登记项（非阻断）
- **R1**（QA 工具链）：#uvassert 密度判据对 quiltTiled 组 skip 漏洞（V800Adapter.ts:2267-2292）——本次由外部复算补实（1,264 三角 / 中位 1.41× / 0 超阈），钩子仍须修，否则菱格组回归无机器门禁。
- **R2**（文档）：PERF.md 整帧红线 150 与高档实测 333 的口径差（transmission 翻倍 + 后处理多 pass），建议在 PERF.md 登记高档实测值或校准红线口径。
- **R3**（文档）：README/ASSETS.md 图片计数 29 → 232（性质不变）。

## 总体结论：**通过**

A 项 4/4 PASS（独立重拍重算）、B/C/D/E/F/G 全 PASS；机器核验退出码 0（error 0 / warn 1，warn 为误报）；无废弃 API、无 CDN、无外部资产、无越界串味、合批 −104 复现、回归全绿。登记项 R1-R3 不阻断交付，建议随下波处理。
