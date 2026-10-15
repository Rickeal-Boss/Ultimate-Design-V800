# 性能报告 · 极限刹车挑战 · 尊界V800

> 维护人：性能优化工程师·提速 ｜ 更新日期：2026-10-14 ｜ Three.js 0.186.1 + cannon-es 0.20.0（Vite 7）
>
> **数据口径声明**：本版已从「静态估算」切换为 **Node shim 实测**——用最小 DOM/Canvas shim 在 Node 里
> 直接运行真实的 `createZunjieV800LuxuryMPVModel` / `createV800CarAdapter` 工厂代码，逐 mesh 数面、
> 数 draw call、读材质状态（`textureSize=64` 不生成贴图，避免把贴图生成耗时混入几何统计）。
> 静态估算部分保留在附录 A（公式与推导）。**浏览器内实测（`#perfhud`）仍待 QA 在前台标签执行**，
> 见 §7 遗留项 8；未实测前，帧率类结论按估算口径验收，几何/材质类结论按实测口径验收。

---

## 1. 预算总表

| 指标 | 桌面档 high【实测】 | 移动档 medium【实测】 | 预算 | 结论 |
|---|---|---|---|---|
| 三角面数（车模） | 22,656 | 22,656（同场景图） | ≤ 58,000（spec performanceBudget） | ✅ 38.7% |
| 三角面数（整帧场景） | ≈ 59,500 | 同左 | ≤ 500,000 | ✅ 面数不是瓶颈 |
| Draw Call（整帧，含阴影+后处理） | **≈ 151**（估算，见 §3） | 同左 | < 150 | ⚠️ **贴线**，遗留项见 §7 |
| 车模贴图尺寸 | 1024² | 512²（low 256²） | ≤ 2048 | ✅ 按档缩放 |
| 仍在生成贴图的材质 | **7 / 30** | 7 / 30 | — | ✅ textureless 23 个 |
| 车模启动同步生成耗时 | ≈ 6.5 s（估算） | ≈ 1.7 s | < 3 s | ⚠️ high 档仍偏长，见 §7 |
| Canvas 每帧重绘 | ≤ 15 Hz（仪表） | 同左 | 不应每帧 | ✅ 时间节流已回补 |
| 透射 pass（transmission） | 玻璃 + 水晶共 4 材质 | **0** | — | ✅ 移动端已关 |
| pixelRatio 上限 | 2 | 1.5 | 必须有上限 | ✅ |
| 首屏 JS | 1,242.18 kB / gzip 241.13 kB | 同左 | — | ⚠️ 见 §6 |

---

## 2. 三角面数明细【实测】

车模在 Node shim 中逐 mesh 统计（`textureSize=64`）：

| 来源 | 三角面 | 说明 |
|---|---|---|
| V800 车模（95 mesh / 28 材质在用） | **22,656** | 含四轮、车内外饰、尾灯三件套、星空顶薄板、水晶壁灯 |
| ~~4 个重复系统~~ | ~~75,648~~ | **已删除**：分布 schema 生成器不支持，全部退化为堆在原点的实例，占原车模 83% 面且不可见 |
| 道路（Road.ts） | 33,600 | 护栏立柱 InstancedMesh 1780×12=21,360 为大头；路灯 146 实例合批 8,176 |
| 远山 ×2 环 | 880 | 220 段环形条带，MeshBasic + 顶点色 |
| 天空球 | 2,256 | Sphere(5000, 48, 24)，单 pass shader |
| FX（烟/痕/花） | ~100 | Points 与 2 三角面实例，池化 |
| **合计** | **≈ 59,500** | 预算 500k 的 12% |

**判断：面数不是瓶颈，不要再在这里花优化预算。**

车模自身从 `295193b` 的 91,468 面降到 22,656 面（**−75.2%**），且三角面构成从
「83% 是不可见的原点堆叠实例」变成「100% 可见结构」。

---

## 3. Draw Call 明细【实测 mesh 数 + 估算折算】

车模 mesh 实测：**95 个 total / 89 visible / 6 hidden**（hidden = root 与 cabin-interior
两个实心容器占位箱 + 4 个 `wheel-*` 方块占位盒）。其中 `cabin-interior` 子树 34 个 mesh。

| 模块 | DC（估算） | 备注 |
|---|---|---|
| 车模·外观件 | ≈ 56 | 89 visible − 33 座舱件 |
| 车模·座舱件 | 33 | cabin-interior 子树；相机在车内外都会提交（不被视锥剔除） |
| 刹车踏板（集成层） | **+1（仅车内）** | 臂+面板+防滑条合并为单 mesh；`visible` 按「相机到踏板世界距离 < 2.5m」门控，车外各机位（hood 3.0 / side 4.6 / chase 8）全部剔除 |
| 道路 | 42 | 标牌 14、路障 14、InstancedMesh×4、合批若干 |
| 地形 / 天空 / FX | 2 / 1 / 3 | FX 池即使空载也各占 1 DC（frustumCulled=false，接受） |
| **主 pass 小计** | **≈ 137** | |
| 阴影 pass | ≈ 8–12 | castShadow 对象被 ±28m 正交阴影视锥剔除后，实际车体 7 + 邻近护栏/灯杆 |
| 后处理全屏 pass | ≈ 4–6 | RenderPass + Bloom×3 内部 + SpeedBlur + Output |
| **整帧合计** | **≈ 150** | **贴红线，见 §7 遗留项 1** |

> 旧基线（Car.ts + Interior.ts 时代）主 pass ≈ 108；新车模把 60 DC 的车身/内饰换成 89 DC，
> 净增 ≈ 29 DC。这是 125 组件全程序化重建的代价，**已登记为下一轮第一优化项**。

---

## 4. 本轮修复清单（每项均过 `npx tsc --noEmit` 与 `npx vite build`）

### 4.1 启动与显存（最大收益项）

| # | 位置 | 问题 | 修复 | 收益（实测/估算） |
|---|---|---|---|---|
| 1 | 重复系统 | 4 个系统（160/48/160/26 实例）因 `distribution` schema 生成器不识别，`radius=0` 全部堆在车底原点，75,648 面 + castShadow 参与阴影 pass | spec 整体删除，改由 `starlight-headliner` / `lantern-signature` / `vent-grille` 单组件 + 集成层 Canvas 贴图承担 | **−75,648 面 / −4 InstancedMesh / −4 DC** |
| 2 | `textureSize` | 适配器硬编码 1024，不随质量档缩放；26 材质 × 5 通道 1024² 同步生成 | `quality.ts` 加 `carTextureSize`（1024/512/256）+ 导出 `carTextureSizeFor(tier)`，适配器按档传参 | 256 档立省 94% 生成时间 |
| 3 | 材质 textureless | 26 材质无一声明 textureless，每个都同步生成 5 张 1024² Canvas 贴图（CPU 原始 ≈352MB） | 23/30 声明 textureless（光滑金属、玻璃、透射、emissive、车漆 clearcoat 类） | 贴图材质 26 → **7**；1024 档生成耗时 24.2s → ≈6.5s |
| 4 | 集成层贴图 | 星空顶/字标/金色点阵屏/轮圈盘面若走几何阵列，DC 与面数双涨 | 全部改为 Canvas `emissiveMap`/`map`，各 1 个 draw call | +4 张贴图、+0 mesh |

### 4.2 灯光联动（本轮最高优先级的功能修复）

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| 5 | 刹车灯不随踏板亮、头灯常暗、无字标呼吸 | 适配器按**组件 ID** 找材质，15 个引用里 11 个在工厂不存在（`lantern-core-l/r`、`high-mount-stop`、`headlamp-led-l/r`、`maextro-mark`、`cap-*` 全 0 命中），被 `if (mat)` 守卫静默吞掉 | 改为按**材质 ID** 建表（`material.userData.sculptMaterial.id`）+ 回退链 + 只 warn 一次 |
| 6 | `lamp-white` 被头灯认领，星空顶跟着头灯一起亮 | 头灯与星空顶共用一个白光材质 | spec 拆出独立 `lamp-head` / `starlight` 材质，适配器按优先级认领（尾灯>头灯>字标） |
| 7 | 字标/轮标/头灯内芯/高位刹车灯组件写进 spec 却进不了工厂 | `PASS_LEVELS` 规定 structural-pass 只发射 macro+meso，59 件 micro 被静默丢弃 | 把集成层必须驱动的 10 件提到 meso；不推进 form-refinement 的理由写进 `sculptPipeline.blockedReason` |
| 8 | 尾灯是镀铬盒不发光 | `taillamp-l/r` 材质是 `chrome` | 改 `lamp-red`，并新增 `lantern-emitter-l/r`（红横带）+ `lantern-signature-l/r`（金色点阵屏）+ `lantern-bezel-l/r`（铬框） |

**实测联动结果**（Node shim，满刹车 `setBrakeLights(8)`）：
`lamp-red = 8.000`、`lamp-gold = 6.000`（= 0.75 × red）、`lamp-head = 2.500`、
`lamp-mark = 2.449`（呼吸中）、`starlight = 0.958`（独立呼吸）。三档均 `console.warn = (无)`。

### 4.3 每帧热路径

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 9 | 仪表 Canvas | 只有 content-key 门控、无时间节流；刹车段车速逐帧变 → 每帧 512×288 重绘 + 纹理上传 | 补回 15Hz 时间节流（key 门控 + `≥1/15s` 双门控） |
| 10 | `spinWheels` | 单帧转角无钳制（200km/h@60fps ≈ 6.3 rad）→ 频闪/倒转错觉；`rotation.x` 无界增长 | 钳制到 `(π/20)×0.9 ≈ 0.1414 rad/帧`（20 开窗图案的奈奎斯特阈值 × 0.9 安全系数），并用 `euclideanModulo` 归一到 ±π。实测 20000 帧后 `rotation.x = −0.2827`，有界 |
| 11 | 灯光平滑 | `+= (target−level)*0.28` 固定系数/帧，120Hz 设备快一倍 | 改 `damp()`（dt 指数阻尼，帧率无关），`CarLike.update(camera, dt)` |
| 12 | `dispose()` | 不级联贴图；`Game.dispose()` 未调 `car.dispose()` | 遍历释放 21 个贴图槽 + `ownedTextures` 兜底；`Game.dispose()` 接线 |

### 4.4 透射 pass（移动端第一杠杆）

| 档位 | transmission 实测 |
|---|---|
| high | `glass-dark 0.5` / `glass-clear 0.85` / `crystal 0.9`（保留拟真） |
| medium / low | **全部 0**，切 `transparent=true` + `opacity`（深色隐私玻璃 0.55 / 前挡 0.40 / 水晶 0.60） |

---

## 5. 质量档分档表（`src/config/quality.ts`）

| 参数 | high | medium | low |
|---|---|---|---|
| pixelRatio 上限 | min(DPR, 2) | min(DPR, 1.5) | 1 |
| shadowMapSize | 2048 | 1536 | 1024 |
| msaaSamples | 4 | 2 | 0 |
| bloom | ✅ | ✅ | ❌ |
| envMapSize | 900 | 512 | 256 |
| **carTextureSize** | **1024** | **512** | **256** |
| 星空顶星点数 | 800 | 450 | 220（真车 800+，低档降级） |
| 轮圈盘面贴图 | 512 | 512 | 256 |
| transmission | 开 | **关** | **关** |

---

## 6. 包体

| 版本 | JS | gzip |
|---|---|---|
| `295193b`（车模重构后） | 1,088.13 kB | 226.01 kB |
| 本轮（spec 收尾 + 集成层贴图后） | 1,235.62 kB | 238.78 kB |
| 玩法改版（冗余制动 + 自由视角 + 踏板后） | **1,242.18 kB** | **241.13 kB** |

+147 kB / +12.8 kB gzip。增量来源：① 工厂从 78 → 95 mesh 的生成代码；② 4 张集成层
Canvas 贴图生成函数（星空 800 星点 + 金色点阵字符画 + 字标 + 轮圈盘面）；
③ 尾灯/车标/水晶壁灯/门把手星辰等新组件。

玩法改版再 +6.6 kB / +2.4 kB gzip：冗余制动状态机与事件、CameraRig 自由视角覆盖层、
Input 接线、HUD/Result 三档结算文案与样式、踏板几何（无新依赖；vitest 为 devDependency，
不进产物）。

> **已知冗余（下一轮）**：`sculptComponent` / `actionProfile` 元数据在 node 与 mesh 上各内联一份，
> 运行时只读 `id` 一个字段。加 `stripMetadata` 生产构建开关预计可收回大部分增量（上一轮外部审查 §4.7）。

---

## 7. 取舍、遗留与移交

| # | 项 | 说明 | 处置 |
|---|---|---|---|
| 1 | **DC 贴红线（≈150）** | 车模 89 visible DC 里 33 个是座舱件，相机在车外也会提交；旧基线同位置只有 17 | **下一轮第一优化项**：优先合批座舱小件（三排座椅/门板/杯架/扬声器同材质 merge），预期 −20 DC。本轮未动——合批要保证几何等价，宁可留到有回归测试护航时做 |
| 2 | high 档启动 ≈6.5s | 7 个材质 × 5 通道 1024² 逐像素生成仍在中端 CPU 上偏长 | 下一轮：OffscreenCanvas Worker 化，或降为按需烘焙 |
| 3 | 包体 +147 kB | 见 §6 已知冗余 | 加 `stripMetadata` 生产开关 |
| 4 | 轮圈辐条几何 | 已删除（15,360 面全被实心 cylinder 包住不可见），盘缘开窗改贴图 | 已闭环；若后续把 `tire-*` 改 torus 可恢复真辐条，属 P3 |
| 5 | 座舱布局 | 参考图判定真车是三排（前 2 + 二排 2 航空座 + 三排长椅），spec 现为四座豪华舱 | 结构性改动，已登记 `spec.risks`，下一轮 |
| 6 | 尺寸口径 | spec 元数据用实测几何 5.495×2.006×1.85；游戏碰撞盒已对齐宽度（半宽 1.1→1.01，原比车宽半值宽 9.7%），z 半长保守保留 2.66 以维持撞障点回归数值 | 已闭环 |
| 7 | 含未获证实的推定特征 | `d-roof-rail`（车顶行李架纵轨）与 `d-third-brakelight`（高位刹车灯）在 82 张参考图中均未出现，已在 spec 标 `confidence 0.5` + note；`high-mount-stop` 组件已从 spec 删除 | 已闭环，对外口径见 `docs/ASSETS.md` 第 5/7 节 |
| 8 | `#perfhud` 浏览器内实测 | Node shim 已覆盖几何/材质/DC 结构，但**帧率**受软渲染/后台标签影响，本环境不可靠 | **移交 QA**：前台打开页面加 `#perfhud`，10 秒内核对 §1 与 §3 的 DC/tris 行 |
| 9 | 外部审查·非车模型轮修复（B-1~B-4） | 限速处动力主动退出（accel 归零 + 电机音降档）；Result resize 监听具名化解绑并接入 Game.dispose；crash 重力统一引用 GRAVITY；满踏板力 1612N 严格 = absMaxDecel（差 0.08% 消除） | 已闭环（2026-10-15 第二轮），Node 真实模块数值复验 13 项断言全 PASS |
| 10 | 外部审查·A-2 fx 轮位 | `WHEEL_LOCAL` 从已删除的 Car.ts 口径（±0.88 / ∓1.55 ±1.88）对齐到新工厂实测轮位（x±0.875 / z±1.715），纵向偏差 16.5cm 消除 | 已闭环 |
| 11 | 外部审查·A-5/G-2 热衰减 | 原「仅 >93% 抓地时升温 + 速率上限 0.063/s」永不可触发（8s 满踩只攒 0.5）；改为摩擦功积分（F×v×dt），标定一次满刹 ΔT≈0.53、连续两把触发 ×0.85，HUD 温度条同步变「制动衰减」 | 已闭环；过热凹口已量化（b=0.99 时 12.51→10.90 m/s²，仍 >10，属「踏板变软」的真实手感而非反转） |
| 12 | 浏览器实机复验 | 本环境 Edge 二进制 spawn 被 EACCES 拦截（沙箱内外均如此，机器级限制），`verify-game.mjs` 无法运行 | **移交 QA**：在有浏览器的环境跑一次 `#autodrive` + `#lightassert`（后者为新增断言钩子，输出灯组命中表）。断裂路径用 `#autodrive-snapdrive`（刹车滑条拉满 1.0） |
| 13 | **回归测试基线（2026-10-15 新增）** | 引入 Vitest，`npm test` 37 项全绿（物理 16 + 冗余契约 21）。此前 DC 优化（座舱合批）因「无回归网护航」被搁置 | 已闭环：座舱合批可开工；后续每次改物理常量先跑 `npm test` |
| 14 | 路障距离 2600 → 1300m | 2600m 下冗余制动最远 1107m，「断裂撞障」结局数学上不可达 | 已闭环：三档结局余量见 `physics.ts` TRACK 注释（正常 466m / 冗余 193m / 晚切 300m 撞障） |
| 15 | 热衰减在单局内不可达 | 实测单把满刹峰值温度 0.494 < 阈值 1.0；跨局残留被加速段风冷（18s × 0.25/s）完全抹平 | **登记不改**：保持「不惩罚正确操作」；要让它进入博弈需「连续多刹」耐力模式（后续项） |
| 16 | 加速段时长占比（≈77%） | 0→200km/h 18.4s vs 刹停 5.4s，玩家大半时间在等加速 | **下一轮**：初速档位选择（100/140/180/200 km/h），同时给「扫段赛」玩法空间 |
| 17 | 踏板几何未走 spec 工厂 | 踏板需要运行时脱落动画，工厂产物不可手改、本轮不重跑生成器 | 已登记为集成层资产；下一轮动 spec 时迁为 **meso** 组件（micro 会被 PASS_LEVELS 丢弃） |

---

## 附录 A · 静态估算公式（保留）

`CylinderGeometry(r,r,h,seg) ≈ seg×4 面`；`Box ≈ 12 面`；`Sphere(w,h) ≈ w×(h−1)×2+2w 面`；
`RoundedBoxGeometry(w,h,d,s) ≈ 6s² 面`（取上界）。

## 附录 B · 实测操作指引（QA）

1. `npm run dev`，浏览器**前台**打开 `http://localhost:5173/#perfhud-autodrive`
2. 加速段（t≈8s，接近 200km/h）与全力刹车段（t≈15s）各读一次左下角标：
   `calls(frame)` 对比 150、`tris(frame)` 对比 500k、FPS 对比 60/45
3. 移动端用真机 Chrome 远程调试 `chrome://inspect` 读同一角标

## 附录 C · 本轮验证记录

| 项 | 结果 |
|---|---|
| `validate_sculpt_spec.py --strict-quality` | **PASS** |
| `generate_threejs_factory.py --pass-id structural-pass --force` | 成功 |
| `npx tsc --noEmit`（strict） | **0 错误** |
| `npx vitest run` | **37/37 PASS**（physics 16 + redundancy 21） |
| `npx vite build` | 通过，JS 1,242.18 kB / gzip 241.13 kB |
| Node shim 车模统计 | Mesh 95 / InstancedMesh 0 / 材质在用 28 / 三角面 22,656 / world min Y −0.890 |
| Node shim 三档行为 | transmission（high 保留 / medium·low 归零）、灯光联动、贴图挂载、轮速钳制、`console.warn` 均符合预期 |
