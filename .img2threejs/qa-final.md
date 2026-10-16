# QA 终验报告（Phase 2）— qa2 / 提速

- **捕获时间窗**：2026-10-16 18:26–19:05 (UTC+8)
- **git rev**：`9afac60`（工作树含集成波改动、未提交；只读，零 git 写操作）
- **捕获时代码状态（mtime, UTC+8）**：

| 文件 | mtime | 说明 |
|---|---|---|
| `src/model/createV800Model.ts` | 18:19:52 | builder2 几何波（149→170 组件） |
| `src/model/V800Adapter.ts` | 18:15:51 | lighter2 材质波 + QA 钩子 |
| `src/model/preview.ts` | 18:52 前后 | 本任务改 1 行（见 §五白名单声明） |

- **环境（与 Phase 1 完全同口径）**：Edge headless `--headless=new --disable-gpu`（SwiftShader 软渲染），**Edg/155.0.4283.45（与基线同版本）**，DPR 1.00，vite dev 5199，CDP 9333。
- **⚠️ 管线口径修正（重要，影响读数）**：本轮实机定位确认 `preview.html` / 独立管线**只渲染工厂裸模**——`createV800CarAdapter`（材质层/合批/盘面贴图/钩子）仅被 `Game.ts`（index.html）调用。因此：
  - 工厂级缺陷复核 → preview 裸模口径（与 Phase 1 基线可比）；
  - 材质波成果复核（轮面贴图/菱格/素面金/尾灯图集）→ 本轮新增 **adapter 换装管线**（`createV800CarAdapter('high')` + 同 lookdev 配置），特写 H3/H4 系列。Phase 1 的 G 系列（工厂级）结论不能直接用来判定 lighter2 的修复，必须以 H3/H4 为准。

---

## 一、性能实测 vs 基线（同环境同口径）

### A. index.html#perfhud-autodrive，60s 浸泡，56 样本（基线 43 样本）

| 指标 | Phase 1 基线 | Phase 2 终验 | Δ |
|---|---|---|---|
| FPS avg / min / max | 1 / 1 / 1 | 6.5 / 5 / 7 | SwiftShader 软渲染环境噪声，**不可作为真机帧率依据** |
| **draw calls（整帧峰值）** | **313** | **331** | **+18（+5.8%）** |
| **triangles（整帧峰值）** | **187,043** | **203,171** | **+16,128（+8.6%）** |
| 结算页 calls（末段） | 196–204 | 214 | +5% 左右 |
| DPR | 1.00 | 1.00 | 同 |

- 面数增幅与 builder2 几何波一致（+6,480 净面 + 21 个新组件；整帧含阴影/后处理多 pass，增幅放大）。
- **整帧 calls 331 仍高于 300**：与基线 313 同因（整帧口径含 transmission 透射 pass + Bloom/SpeedBlur/Output 后处理多 pass）。**合批后 game 内可见 DC 口径**见下——该口径才是 MEMORY 红线 150 的对应口径。

### B. 各管线 Draw Call / 面数对照

| 口径 | 基线 | 终验 | 说明 |
|---|---|---|---|
| preview 裸模（`__v800Info`，转台位，含外壳+阴影 pass） | 289 calls / 81,704 tris | **325 calls / 91,352 tris** | 工厂 149→170 组件的直接体现 |
| adapter 换装 + 静态合批（独立管线整帧） | —（基线无此管线） | **85 calls / 78,008 tris** | 合批把可见 DC 压下来 |
| #batchmerge 钩子 | — | **mesh 170 → 65，可见 164 → 59，Draw Call −105** | game 内可见 59 DC ≪ 红线 150 ✅ |

**瓶颈判断**：面数 203k（整帧多 pass）对预算 500k 余量充足，不是瓶颈；DC 的压力集中在裸模/整帧口径，运行时合批（−105 DC）已把 game 内可见 DC 压到 59。**CPU 侧提交仍是主要限制，合批是正确的一刀**；transmission pass 的整帧翻倍效应依旧存在（313→331 同源），真机验收建议以 game 内可见 DC + 真机 perfhud 为准。

---

## 二、基线 7 项缺陷逐项闭环判定

| # | 基线缺陷 | 判定 | 证据 |
|---|---|---|---|
| 1 | **P0** preview.ts 近截面导致座舱捕获全黑（0 calls/0 tris） | ✅ **PASS** | `applyCabinCamera` 已恢复 `near=0.05/far=60`（preview.ts:259）。C2/C3 三排 POV 全部出图：front 59 calls/10,808 tris、rear 43/8,608、third 15/2,592 |
| 2 | lamp-gold 串味：speaker/tweeter 呈发光金点阵 | 🟡 **部分 PASS** | #uvassert：lamp-gold 2,560 tris **0 越界**（素面区 2,176 / 点阵区 384）；H4-speaker-rl-macro 点阵已消失 ✅。但素面区观感呈**奶油色 blob 状凸起**，非"素面拉丝金"（见新缺陷 N3） |
| 3 | 座椅素块：无菱形绗缝/打孔/滚边 | 🟡 **部分 PASS** | 菱格纹理存在：leather-warm 分区1 有 1,968 tris；特写中可见菱形+缝点（H3-wood-tunnel-top 左下角、H3-crystal-shifter 上部）。**但后排椅背背面整面呈水平拉丝乱纹**（H4-quilt-rearl-back-close），舱内侧面为素面无菱格（H4-quilt-rearl-back-cabin）——菱格覆盖位置与预期不符 + UV 拉伸（见 N2） |
| 4 | 后排控制屏"白盘+铜环"形态不符（IN-09） | ✅ **PASS（几何）** | `seat-rear-l/r-screen` + `seat-rear-l/r-plate` 已建模（探针盒实测：screen 0.07×0.009×0.049 m 于腿靠上方，plate 0.05×0.022 于头枕后 y≈1.37）。屏面 UI 缺失归入 #6 |
| 5 | 星空顶星点不可见（IN-16） | ✅ **PASS** | H3-starlight-up：深色底 + 星点清晰（亮度差/疏密自然）；H3-cabin-front 顶部亦见星点与流星感。基线"平色条带"已消除 |
| 6 | 三联屏无任何 UI 贴图（IN-21/43） | ❌ **FAIL** | H4-tri-screen-frontal：屏面为灰白渐变发光素板，无 HarmonyOS 风 UI；换装模型仪表位（gauge）近摄同样不可辨 UI。screen-ui 的 Canvas（emissiveMap+map）未生效或被 uniform emissive 盖住 |
| 7 | 尾灯 3+3 红带 + 金色点阵屏不可见（EX-28/29） | ❌ **FAIL / 存疑** | 换装模型 taillamp-l 微距（H4-taillamp-l-macro）：铬框内为**白光竖条（带星尘点）**，红带不可见；taillamp-bar-top-l 微距同。而工厂级 F2-taillamp-bar-close 曾见「红带上/下+黑带中段+白心」结构 → 图集疑似已绘制但被白光 emissive 覆盖或材质在适配层被改写。金色点阵屏（EX-29）在尾灯特写中未出现。需 lighter2 用同机位复核 |

**闭环记分：PASS 3 / 部分 2 / FAIL 2。**

---

## 三、新增复核项判定

| 项 | 判定 | 证据与说明 |
|---|---|---|
| 轮面贴图特写 | ✅ **PASS** | H3-wheel-rim-fl-face：盘面 **20 开窗 + 中央 MAEXTRO 盾标 + 金色曜日纹**清晰；rim 盒实测宽 0.27（x 0.74→1.01）凸出胎面（1.003）**7mm 实证**。builder2 提示的"侧面 7mm 环带取贴图边缘像素"——本轮机位为正视，**环带观感未覆盖**，登记为待复核项 |
| 木纹中岛 | ✅ **PASS** | H3-wood-tunnel-top：顶面高光缎面红棕树瘤木纹 + 反射，质感成立。同款波纹图案大面积出现在 dash/门板时观感偏乱（归入 N2） |
| 水晶旋钮特写 | 🟡 **部分** | H3-crystal-shifter：球状旋钮在位；IN-32 期望的圆柱+滚花环+顶徽在 0.6m 距离不可辨——几何精度遗留（工厂级，非本波引入） |
| greenhouse 透视 | ✅ **PASS（弱证据）** | H3-greenhouse-inside-left：上部可见深色背景透过侧窗（玻璃非不透明）；H3-greenhouse-inside-front 前向透光呈灰调。SwiftShader 下 transmission 观感偏灰，真机需复验 |
| #uvassert | ✅ **PASS** | 4 图集材质全 0 越界：leather-warm 6,240（素面 4,272/菱格 1,968）、housing-dark 536、lamp-white 576、lamp-gold 2,560（素面 2,176/点阵 384）。**串味机器判据全绿** |
| #batchmerge | ✅ **PASS** | mesh 170→65，可见 164→59，DC −105；自校验 problems 为空（无 error 日志） |

---

## 四、新引入 / 仍存缺陷清单

| # | 缺陷 | 严重度 | 定位建议 |
|---|---|---|---|
| N1 | **屏幕全家族无 UI**：三联屏/仪表/后排屏均为均匀发光素板 | 高（视觉权重最高件之一） | screen-ui Canvas 未挂上或 emissive 未用 map；若非本波范围，请明确登记归属 |
| N2 | **程序纹理拉伸/乱纹**：后排椅背背面整面水平大理石拉丝、dash 屏周与地板呈波纹乱纹 | 高 | 疑似 UV 纹素密度失控（uvassert 只验证分区归属，不验证拉伸）。建议 lighter2 增加"纹素密度/各向异性拉伸"机器判据 |
| N3 | speaker/tweeter 素面金呈奶油色 blob 凸起，非拉丝金 | 中 | 素面区贴图内容/normalMap 观感问题（7 张 NoColorSpace normalMap 之一？） |
| N4 | 尾灯铬框内白光竖条盖住 3+3 红带；EX-29 金色点阵屏不可见 | 高（EX 身份特征） | 换装层材质覆盖顺序/白光 emissive；工厂级曾见红带结构 |
| N5 | 水晶旋钮滚花环+顶徽不可辨 | 低 | 工厂几何精度（IN-32），非本波引入 |
| N6 | 轮面侧面 7mm 环带（贴图边缘像素）观感未复核 | 低 | 需补一个侧向机位 |

---

## 五、白名单与改动声明

- **preview.ts 改动 1 处（白名单内，一行级）**：`cabinEye('front')` 前排锚点原为 `front.max.z + 0.3` ≈ z 1.474，实测落进 dash 几何内部（dash-lower z 1.25..1.55）导致钩子 POV 被仪表台剖切（P0 修复后暴露的次生问题）；改为座椅中心 `center.z + 0.15` ≈ 1.07。C3 三排复拍有效。预览页 dev-only（vite build 不含此入口），不影响游戏产物。
- 其余全部为**只读捕获**：git 零写操作；新增文件仅 `.img2threejs/renders/qa-final/*`、`.img2threejs/qa-final.md`（本文件）与仓库外 `C:/Users/16896/.workbuddy/binaries/node/workspace/qa-final*.mjs`。

## 六、结论：**打回（定向返工，不需整体回滚）**

**达标**：P0 座舱捕获、静态合批（−105 DC，game 内可见 59 ≪ 红线 150）、#uvassert 串味全绿、轮面贴图、木纹中岛、星空顶、后排屏几何、greenhouse 透射、面数预算（203k/500k）。

**打回项（4）**：① 屏幕家族无 UI（N1）；② 程序纹理拉伸乱纹（N2）；③ speaker 素面金观感（N3）；④ 尾灯 3+3/金色点阵被白光覆盖（N4）。

四项均可定位到 lighter2 纹理波与 EX-28/29 的集成细节，建议定向返工后仅复验对应机位（本报告 H3/H4 系列机位可直接复用）；性能侧无打回项。

## 七、截图索引（`.img2threejs/renders/qa-final/`）

| 前缀 | 内容 | 状态 |
|---|---|---|
| A-perfhud-endstate | perfhud 60s 浸泡结算帧 | ✅ |
| B2-turntable-az000..315 | 8 方位转台（工厂裸模口径，与基线 B 系列同机位） | ✅ |
| C2/C3-cabin-front/rear/third | preview 钩子座舱 POV（P0 修复前/后对照） | ✅ 非 black |
| D2/D3-lampgold-* | preview 钩子 lamp-gold 机位（工厂级） | ✅ |
| H3-wheel-rim-fl-face | 轮面贴图（换装层） | ✅ |
| H3-quilt-* / H4-quilt-* | 菱格复核（4 机位） | 🟡 |
| H3-wood-tunnel-top / H3-crystal-shifter | 木纹/水晶旋钮 | ✅/🟡 |
| H3-starlight-up | 星空顶 | ✅ |
| H3-tri-screen / H4-tri-screen-frontal / H4-gauge-screen-frontal | 屏幕 UI | ❌ |
| H3-taillamp-close / H4-taillamp-l-macro / H4-taillamp-bar-top-l-macro | 尾灯 3+3 | ❌ |
| H3-greenhouse-inside-left/front | 玻璃透射 | ✅ |
| H3/H4-speaker-*, H3-lampgold-tweeter-l | 素面金 | 🟡 |
| qa-final-summary.json / qa-final-summary2.json / probe-parts.json | 原始数据（perf 样本/钩子表/组件盒） | ✅ |
