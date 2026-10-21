# R22-B 涡轮盘式轮毂手写几何 —— 验证报告

交付物：`src/model/parts/wheelHub.ts`（新建，纯程序化几何 + 零外部图片）
参考：`C:/Users/WB/Desktop/bilibili.mp4_000030.100.jpg`（尊界 V800 轮毂特写）
外部视觉分析：`vision_wheel2.json`（其「10 窗」结论与像素实测不符，见 §2）

---

## 1. 结论（全绿）

| 口径 | 值 | 预算 | 判定 |
| :--- | :--- | :--- | :--- |
| 单轮 tri | **1554** | ≤1600 | PASS |
| 4 轮 tri | **6216** | ≤6400 | PASS |
| 每轮 mesh / 材质 | 4 / 4（独占 id `r22-hub-*`） | — | PASS |
| DC 口径 | 共享材质 **4 DC** / 独占材质 16 DC | 整帧红线 150 | PASS |
| 接线后整车 tri | 71320 − 7392（退役旧件）+ 6216 = **70144**（净 **−1176**） | 红线 90k | PASS |
| bbox（轮心局部系） | r ≤ 0.3000，z ∈ [0.1300, 0.1600] | 旧 rim 包络 z ≤0.160 | PASS |
| 与轮胎间隙 | 轮胎外端面 world x 0.9825 → 本件 0.9850，**+2.5mm** | 防 z-fight | PASS |
| 几何自查 | 退化三角 0 / NaN 0 / 绕序一致 1554/1554 / 法线单位化 0 偏差 / 母线法线连续 61.4° | — | PASS |
| 轮面覆盖率 | 1440 条射线自车外侧打入，**miss=0** | 无漏视轮胎 | PASS |
| tsc --noEmit | 0 error | — | PASS |
| vitest run | 79 passed / 5 files | — | PASS |

机读日志：`qa_output.txt`、`probe_wiring.txt`、`probe_budget.txt`、`probe_rim_frame.txt`

---

## 2. 参考图定量实测（自己做的像素测量，非外部模型结论）

方法：`measure_ellipse.py` → 轮盘外缘点圆锥曲线最小二乘拟合 + 极坐标归一化，
再在归一化坐标系里做角向/径向剖面。

```
椭圆拟合：cx=851.37 cy=538.45 a=581.99 b=525.75 θ=-20.97°（透视压缩比 0.903）
归一化残差：p50=1.030 p90=1.126（半径整体偏 3%，窗带占比已按此修正）
```

| 项目 | 实测 | 本件取值 |
| :--- | :--- | :--- |
| 窗数 | **18**（上半周角距 20.1°，下半周 21.8°；三段连通域实测 23.7°/21.6°） | 18 |
| 窗角距 | 20° | 20.000° |
| 窗角宽 | 约占角距 57–61% | 12.2°（61%） |
| 窗径向 | 0.72R–0.93R（归一化 rho，已除 1.03 残差） | 0.702R–0.918R（含 9° 倾角外接） |
| 外唇宽 | 0.06R–0.09R 亮面 | 0.057R（0.943R–1.0R） |
| 黑盖半径 | 0.082R（Ø49mm @R=300） | 0.083R（Ø50mm） |
| 滚花镀铬环外径 | 0.124R；平滑铬环到 0.148R | 碟窝 Ø57–104mm（0.19–0.35R 区段） |
| 徽标 | 竖菱形线框 + MAEXTRO，高 ≈0.6×盖径 | Ø33mm 圆面，图形 16.5×28mm |

⚠️ 与外部视觉模型的差异：它给「10 窗 / 窗长轴切向 / 1:3.5 长条」，
像素实测为 **18 窗、近方梯形（径向 53mm × 切向 48mm）**，以实测为准。

证据图：
- `compare_ref_vs_model.png` — 参考图按椭圆反投影成正圆 vs 本件 z-buffer 正视图（同尺度）
- `_strip.png` / `_unwrap_ell.png` — 归一化极坐标展开（数窗用）
- `_ellipses.png` — 椭圆拟合叠加校验

---

## 3. 几何构成（每轮 4 mesh，按材质分桶）

| 材质 id | 内容 | tri |
| :--- | :--- | ---: |
| `r22-hub-bright` | 外唇环（母线 5 点 × 28 段）+ 主盘穹顶/凸台/铬碟窝（母线 8 点 × 28 段）+ 窗带真开窗（28 边形边界 + 18 孔 earcut）+ 18 条机加工倒角窗框 | 1356 |
| `r22-hub-dark` | 窗带后的暗腔整环（内深外浅锥面 z 0.1358→0.1455） | 56 |
| `r22-hub-cap` | 黑亮圆盖（MeshPhysical clearcoat，母线 4 点 × 24 段） | 120 |
| `r22-hub-emblem` | 徽标贴图圆面（24 边形，UV 归一到 canvas） | 22 |

关键尺寸（轮心局部系，+Z = 车外侧）：
```
z=0.1275  轮胎外端面（tire-* world x=±0.9825）
z=0.1300  本件最外壁底（→ 与胎面留 2.5mm）
z=0.1468  窗带内缘（r=0.203）           z=0.1500 窗带外缘（r=0.283），微锥
z=0.1600  外唇顶（r=0.2885，最亮机加工环）＝ 旧 rim 盘面高度
z=0.1586  主盘穹顶峰值（r=0.078，比窗带内缘高 12mm）
z=0.1470  中心碟窝收口（r=0.025）        z=0.1496 黑盖平顶
r: 窗 0.2106–0.2754 | 窗框 0.2071–0.2789 | 窗带 0.203–0.283 | 外唇 0.283–0.300
```

---

## 4. 接线须知（主理人）

```ts
import { createWheelHub, createWheelHubMaterials, WHEEL_HUB_CENTERS }
  from './parts/wheelHub';

const mats = createWheelHubMaterials();            // ★4 轮共享 → 4 DC
for (const c of Object.values(WHEEL_HUB_CENTERS)) { // fl/fr/rl/rr
  const hub = createWheelHub(c.side, mats);
  hub.position.set(c.x, c.y, c.z);                  // 轮心世界坐标
  root.add(hub);                                    // 或挂到 wheel-* 节点：pos=(0,0,0.382)
}
```

1. **必须先隐藏旧件**：`userData.sculptComponent.id` 精确匹配 `rim-fl/fr/rl/rr` 与
   `wheel-cap-fl/fr/rl/rr`（各 2 个同 id 节点：pivot Group + mesh，都设 visible=false 即可，
   两者合计 7392 tri）。
2. **不要复用旧 rim pivot 的 rotZ(π/2)**：本 group 已自带 `rotation.y = side*π/2`，
   只设 position。旧 pivot 的 rotZ 只是 lathe 轴由 Y 改 X 的内部补偿。
3. **cap-fl/fr/rl/rr（滚花齿环）无需隐藏**：本件 r<0.15 处 z ≥ 0.1470，已把半径 0.148、
   z 0.127–0.135 的整环埋进实体内 → 不可见、无 z-fight。若想省 4 DC（每件 256 tri）可一并隐藏。
4. **必须进 `batchMergeStatic` 的 excludeObjects**：4 个 `r22-hub-*` 材质独占，
   入批会改名不可寻址，且合批重算法线会磨平镜面盘面高光。
5. 旧 rim 自身中心在 world z=1.727（比胎心 1.715 前移 12mm）是旧件偏心；
   本件严格对胎心建，旧件隐藏后不会出现 12mm 错位。

---

## 5. 遗留项 / 风险

| # | 项 | 说明 |
| :--- | :--- | :--- |
| 1 | 窗框微纹理 | 参考图窗框有细密滚花/拉丝，未做（需独占贴图 + 1 DC）。屏幕尺度不可见，hero 近景可见差异。 |
| 2 | 中心滚花环 | 参考图黑盖外圈是「细密径向滚花」镀铬环，本件用平滑碟窝 + canvas 徽标近似；几何级滚花需 28 段 × N 齿，tri 不允许。 |
| 3 | 盘面各向异性 | 参考图盘面有极轻微同心拉丝反光，本件纯镜面（rough 0.16）。若要更亮可调 `r22-hub-bright.envMapIntensity` 0.75→0.9，但 R8 有「镜面轮圈把 RoomEnvironment 暖光读作锈斑」前科，建议保持 ≤0.8。 |
| 4 | 窗倾角方向 | 9° 倾角在局部系固定，左右两侧因 group 旋转 π 呈镜像对称（与真车分左右件一致）。若要求两侧「同一旋向」，把 `WIN_TILT` 乘以 side 即可。 |
| 5 | enbMapIntensity / 材质微调 | 4 个材质均为新建实例，环境贴图由 `scene.environment`（RoomEnvironment PMREM）统一提供，不需 Adapter 额外接线。 |
| 6 | 合批后的法线 | 若被误并入批次，`computeVertexNormals` 会把穹顶平滑法线改成面法线 → 高光碎成块。这是第 4 条红线的真实后果，务必 exclude。 |

---

## 6. 复现命令

```bash
cd .img2threejs/tools/r22_wheel
NODE="C:/Users/16896/.workbuddy/binaries/node/versions/22.12.0/node.exe"
NODE_PATH="C:/Users/16896/.workbuddy/binaries/node/workspace/node_modules"

# 像素测量（参考图 -> 18 窗/椭圆参数）
C:/Users/16896/.workbuddy/binaries/python/versions/3.13.12/python.exe \
  ../../../.img2threejs/tools/r22_wheel/measure_ellipse.py

# 几何 QA（tri/bbox/窗循环/材质/绕序/退化/覆盖率）
$NODE build.mjs qa_wheel && $NODE qa_wheel.mjs

# 虚拟接线（真实工厂模型里摆 4 轮 + 隐藏旧件 + 邻件间隙）
$NODE build.mjs probe_wiring && $NODE probe_wiring.mjs

# 软件光栅化（不开浏览器）：正视 / 3-4 视 / 与参考并排
$NODE build.mjs dump_project && $NODE dump_project.mjs
python render_zbuf.py face 760
python render_zbuf.py q34 760
python compare_ref.py
```
