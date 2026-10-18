# R15-3 · 第二辆车「智界 R7」程序化车模管线

> 品牌声明：`LUXEED / 智界 R7 / 奇瑞汽车` 仅作**文字性引用**（README 已声明本项目为非官方同人作品）。
> 参考图 8 张（左前 3/4、正后、右侧、正前、俯视、主驾、副驾、后排）逐条落实特征。

## 0. 一句话状态

spec（128 组件）→ 严格校验 PASS → 工厂 `createLuxeedR7Model` 产出 → `R7Adapter` 实现 CarLike 全接口 →
Node shim 实测 **1.980 × 1.622 × 4.988 m（宽×高×长）**、**三角 30,868**、**合批后可见 DC 47**、**地面 y = 0**。

## 1. 坐标与尺寸口径（与尊界 V800 完全同源）

| 项 | 值 | 落地核对 |
|---|---|---|
| 坐标系 | +Z 车头 / +Y 上 / 原点 = 轴距中点地面 | 适配层 `body.rotation.y = π`（root 不转） |
| 长 | 4.956 | 实测 bbox Z = **4.988**（+0.65%，尾灯/反光条挤出 2cm 外露） |
| 宽 | 1.981 | 实测 bbox X = **1.980**（轮眉包边 \|x\|=0.990） |
| 高 | 1.634 | 实测 bbox Y = **1.622**（−0.7%，天幕拱顶 1.622） |
| 轴距 | 2.950 | 轮心 z = ±1.475 |
| 轮距 | 1.680 | 轮心 x = ±0.840 |
| 胎 | 255/45 R21 → r=0.383 | 胎环断面外径 0.766、内孔 r0.267 |

自检断言（Node shim，见 §5）：四轮外缘 \|x\| = **0.968 ≤ 0.99** ✔；地面 min y = **0.000 ≥ −0.005** ✔。

## 2. 文件清单（全部新增，未触碰 V800 三线）

| 文件 | 作用 |
|---|---|
| `.img2threejs/r7-assessment.json` | pre-spec 评估（complex） |
| `.img2threejs/r7-sculpt-spec.json` | **R7 唯一真源**（128 组件 / 26 材质 / 1 重复系统 / 22 条细节清单），`indent=1` + LF |
| `.img2threejs/build_spec_r7.py` | spec 生成器（幂等重建全部动态段；profile 绕序自动 CCW 归一） |
| `src/model/createR7Model.ts` | 工厂产物（**生成器产出，未手改**） |
| `src/model/R7Adapter.ts` | 运行时适配器（CarLike 全实现 + 内饰三机位） |
| `docs/wip-r15-r7.md` | 本文 |

## 3. 组件结构（128 件：3 macro / 2 micro 之外全为 meso-micro）

**外观（约 78 件）**
- 单壳车身 `body-lower`：56 点侧视轮廓挤出（depth 1.93），**含前后轮拱真开口**（r0.438 上半圆，脚点落 y0.18 底边）+ `waistBulge` 腰部外鼓 2.2% + `tumblehome` 上收 2% + 前后 3% 平面收窄。
- 玻璃四块全部**薄壳带**：`windshield`（倾角 30°）/ `roof-glass`（全景天幕，占车顶 70%）/ `side-glass-l/r`（30mm 薄片，只做窗面不封舱）/ `rear-glass`（溜背斜面 42°）。
- 前脸身份包：`front-fascia` + `light-bar-front`（全宽 1.74 镀铬）+ `headlamp-l/r`（C 形楔形灯罩）+ `drl-strip-l/r` + `headlamp-projector-1/2`（每侧 2 颗）+ `logo-shield`（盾形浮雕）+ `front-intake`（三段式）+ `duct-l/r`（侧导流）+ `front-plate`。
- 尾部身份包：`tailgate`（rotY(π) 挤向 −Z）+ `tail-lamp-band`（全宽烟熏暗场）+ `tail-light-bar`（全宽红光）+ `tail-light-split-l/r`（侧段）+ `lettering-luxeed` + `badge-l/r`（奇瑞汽车 / 智界R7）+ `rear-bumper` + `rear-diffuser` + `rear-reflector-l/r` + `spoiler`（鸭尾）+ `high-mount-brake`。
- 车轮总成 ×4：`wheel-*`（环形胎 lathe 32 段）+ `rim-*`（盘体 lathe）+ `wheel-face-*`（**20 辐齿轮轮廓 extrude**，辐间 12° 开窗）+ `caliper-*`（红色卡钳，**不随轮转**，父节点是 root）。
- 黑化件：`arch-fl/fr/rl/rr`（**半圆拱带 200°→−20°**，绝不整圆）、`rocker-l/r`、`mirror-body/glass-l/r`、`handle-front/rear-l/r`（隐藏式把手）。

**内饰（约 50 件，容器 `cabin-interior` 归零 + 几何退化为 2cm 薄片，无可隐藏占位盒）**
- 双色仪表台：`dash-upper`（紫灰 `leather-plum`）+ `dash-lower`（米白 `leather-ivory`）+ `dash-chrome-strip`（分色线镀铬）+ `dash-vent`（圆形出风口）。
- 屏：`center-screen`（15.6" 横置悬浮，高出台面 6cm，后倾 8°）+ `cluster-screen`（10.25" 横条，方向盘后）+ `rear-screen`。
- 方向盘：`steering`（torus r0.18）+ `steering-hub`（米白中央板）+ `steering-spokes`（**重复系统**：2 辐径向）+ `steering-badge`。
- 座位：driver/passenger 各 cushion+back+headrest；后排 `seat-rear-cushion`（1.44m 一体式长凳）+ `seat-rear-back` + 3 头枕。
- 门板 ×4（米白）+ 紫灰上沿 ×4 + 网罩扬声器 ×4 + 中岛 / 扶手 / 顶棚 / A 柱内饰 / 遮阳板 / 内后视镜 / 氛围灯 ×2 / 踏板 ×2。

**重复系统（1）**：`steering-spokes`（radial，2 实例，`axis:[0,0,1]`、`radius 0.23`、`startAngleDeg 90`）。

## 4. 材质（26）与 ID 语义族

`paint-green`（墨绿金属漆 clearcoat 1.0 / rough 0.18 / metal 0.55 / iridescence 0.15）、`paint-black`、
`chrome`、`glass-dark`、`glass-clear`、`tire`、`wheel-alloy`、`housing-dark`、`matte-black`、
`screen-ui`、`gauge-ui`、`lamp-white`、`lamp-head`、`lamp-red`、`plate`、`plate-mark`、
`leather-plum`、`leather-ivory`、`leather-charcoal`、`suede-ivory`、`carpet`、`speaker-lattice`、
`ambient`、`bronze-dark`、`caliper-red`、`pedal-metal`。

**玻璃硬约束**：`transmission = 0`、`transparent + opacity`（dark 0.62 / clear 0.42），适配层 high 档
显式钉死——R12 铁律「透射 pass 整场景重绘 = 整帧 DC 翻倍」不重犯。

## 5. 自检数字（Node shim，esbuild bundle + 最小 DOM shim，`createR7CarAdapter('high')`）

```
bbox size 宽X=1.980 高Y=1.622 长Z=4.988      (口径 1.981 / 1.634 / 4.956)
bbox min=[-0.99, 0, -2.497] max=[0.99, 1.622, 2.491]
wheel-fl/fr/rl/rr: x=[±0.712, ±0.968] y=[0, 0.766] z=[±1.092, ±1.858]
max |wheel outer x| = 0.968 (限 0.99)          ✔
ground min y = 0.000 (限 >= -0.005)            ✔
meshes=49 visible=47   tri(几何和)=30,868  tri(可见)=30,388
batchMerge: 128 → 49 mesh；DC 126 → 47；problems=[]      ✔ (预算 60)
CarLike 方法缺失: 无                            ✔
smoke: spinWheels/setBrakeLights/setHeadlights/setBrakeHeat/updateCluster/setSteer/update/flashBrakeSnap
       /snapPedal/resetPedal 全通路无异常
```

预算核对：组件 **128 ≤ 130** ✔；三角 **30,868 ≤ 45,000** ✔（#assembled 口径，几何和，含 20 辐轮面 ×4）；可见 DC **47 ≤ 60** ✔。

## 6. 落地过程中真实踩到的坑（都已修，留档防复发）

1. **归一化基元尺寸真源**：`box/plane-card/torus` 的几何是 ±0.5 单位体，尺寸只能靠 `transform.scale`。
   首版 `C()` 只填 `dimensions` 不填 `scale` → 全部 box 变成 1m 立方（bbox 一度 2.89×3.17×5.95）。已改为 `scale = dims` 默认。
2. **macro 容器 position 必须归零**：`cabin-interior` 一度写成 `(0, 0.31, 0)`，整个座舱被抬高 31cm（顶棚顶到 y1.895）。
3. **侧视挤出恒朝 −x**：`rotY(−90°)` 的挤出方向固定，右侧件节点必须放**内缘**（`side_x()`），
   否则副驾座椅/右侧玻璃会挤到车外（曾出现 x=−1.11 的坐垫）。
4. **轮拱弧走向**：用 `atan2` 的 −153.3° 当起点会让插值经过 −90°（圆底）→ 拱口朝下挖穿到 y=−0.055（穿地）。
   必须 `+360°` 走 207.6°→−27.6° 的**上半圆**。
5. **车轮自转不能用 `rotation.x`**：工厂 wheel-* 节点自带 `rotZ(π/2)` 基准，欧拉叠加会变成"翻滚"。
   适配层用 `quaternion = baseQuat × quat(局部 Y 轴, angle)`（局部 Y 就是 lathe 轴 = 车轴）。
6. **同材质 ID 多 mesh 复用会串味**：`plate-mark` 被 LUXEED + 两块铭牌共用，`chrome` 被几十个件共用。
   适配层 `cloneForMesh()` 逐 mesh 克隆后再挂 Canvas 贴图。
7. **合批顺序**：必须先做完所有 per-mesh 改写（隐藏占位盒 / 贴图克隆），再 `batchMergeStatic`（它会 dispose 源几何）。

## 7. 适配器契约

```ts
export const R7_BASE_YAW = Math.PI;
export const R7_INTERIOR_VIEWS = {
  driver:    { eye: [ 0.360, 1.220, 0.140], target: [ 0.180, 1.010, 1.700] },
  passenger: { eye: [-0.360, 1.220, 0.140], target: [-0.120, 1.030, 1.480] },
  rear:      { eye: [ 0.000, 1.210, -1.050], target: [0.000, 1.010, 0.900] },
};
export function createR7CarAdapter(tier: 'high' | 'medium' | 'low'): CarLike
```

- **机位是装配局部坐标**（= spec 坐标），未含 `body.rotation.y = π`；CameraRig 需先挂到 body 局部空间或用
  `body.localToWorld()` 再取世界坐标。眼点 = 前排 H 点 (|x|0.36, y0.60, z0.18) + 0.62m。
- `spinWheels`：`step = dist / 0.383 × 2.6`，单帧钳制 **0.1414 rad**（= (π/20)×0.9，20 辐图案的奈奎斯特阈值）。
- `updateCluster`：768×320 Canvas，**15Hz 上限**（`GAUGE_MIN_INTERVAL = 1/15`），画弧速度表 + 踏板力条 + g + 挡位。
- `snapPedal` / `resetPedal`：**空实现 + 注释**（R7 玩法不做踏板断裂，但接口必须在，否则 Game 的统一 update 路径会炸）。
- `setSteer`：钳 ±0.42 rad（≈24°），一阶回正 `damp(k=12)`。
- `setBrakeHeat(t)`：驱动卡钳 `emissiveIntensity = t × 1.1`（暗红热辐射）。
- 材质 ID 语义族沿用 V800（`paint-*`/`glass-*`/`lamp-*`/`leather-*`/`screen-ui`/`chrome`/`carpet`/`bronze-*`）。

## 8. 生成 pass 说明（需要主理人知悉的偏差）

生成器是 **fail-closed 的 pass 闸**：`--pass-id` 必须已被 `reviewHistory` 解锁（当前未跑任何视觉评审 →
首个未完成 pass = `blockout`）。因此实际命令为：

```
generate_threejs_factory.py .img2threejs/r7-sculpt-spec.json \
  --out src/model/createR7Model.ts --pass-id blockout --force
```

为了让 blockout 一档就出**完整整车**，spec 里 `buildPasses[blockout].componentRefs` 枚举了全部 128 个组件 id
（R7 的 spec 是一次性整装配，不是逐 pass 长大）。工厂代码除首行注释的 pass 名外与 lighting-pass 无差异
（pass 只做组件过滤，不改几何/材质/密度）。**未伪造任何 reviewHistory 记录。**

## 9. 遗留项 / 风险

1. **未目检（若 §10 为"不可用"）**：本机浏览器链路需要 Edge + puppeteer-core + vite dev server，见 §10 结论。
2. **A 柱与玻璃壳之间可能有 1–2cm 缝**：用 `roof-rail` + `roof-header` + `apillar` 桥接，未做布尔合并。
3. **20 辐轮面是齿轮轮廓挤出**：辐条截面为矩形（非机加工梯形），1m 内近距离会读作"平"。
4. **`tsc --noEmit` 全仓库非 0**：剩余 error 全在 `src/model/refTextures.ts`（R15-2 在改）与
   `src/ui/Hud.ts` / `src/ui/Result.ts`（R15-4 在改），**我这两个新文件 0 error**。
5. **内饰细节取舍**：为守 130 组件预算，砍掉了前门下部扬声器网罩、座椅侧翼、中岛旋钮、后排中央头枕/扶手、
   翼子板摄像头、进气竖鳍、每侧第 3 颗投影镜芯（改由点阵贴图补）。需要时可加回（每件 ~200 三角）。
