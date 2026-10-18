# WIP intex-r14（座舱遮挡 + 参考图贴图）

## 目标
1. **P0 舱内大板遮挡**：用户截图 cabin 视角下半屏被一整块灰褐实体面占满（顶部水平硬边 + 两个 softbox 高光），
   仪表台/中控存在超大实体块。要定位定罪 → 改成「薄台面 + 屏带 + 出风口 + 膝部空间」；
   方向盘应落在驾驶位正前方；cabin 机位可见方向盘/三联屏/中控/副驾/A 柱。
2. **P1 参考图贴图**：`src/assets/ref/*.jpg` → `src/model/refTextures.ts`（异步 TextureLoader + SRGB），
   座椅菱格 / 星空顶（map+emissiveMap）/ 中控副驾屏（主驾仪表保留程序化 updateCluster）/ 门板（可选）。

## 禁区
- 禁 git；只改 `src/model/V800Adapter.ts`、`src/model/interiorTextures.ts`、新增 `src/model/refTextures.ts`、
  `src/assets/ref/*`、`docs/wip-intex-r14.md`、`verify/r14/intex/*`。
- 不碰 spec / createV800Model.ts / src/core / src/render / src/physics。

## 计划
- [ ] 1. 起 vite dev + puppeteer 探针；`#assembled` 装配态
- [ ] 2. `__v800Parts()` 打印舱内组件 world bbox，找超大件
- [ ] 3. `__v800HideMat(matId,true)` 消去法 + `__v800CabinShot` 机位截图（依次 leather-warm / leather-dark / suede / wood / plate / carpet）
- [ ] 4. 定罪 → 改仪表台/方向盘
- [ ] 5. refTextures.ts + 座椅/星空顶/屏幕贴图接线
- [ ] 6. build + vitest + uvassert + batchmerge + 截图目检

## 进展（追加）

---

## R14 收尾结论（主理人接管，23:4x）

### 定罪：不是「仪表台存在超大实体块」，是两个更朴素的原因

1. **眼点在驾驶座靠背实体内部。** 机位 `(-0.55, 1.16, -0.45)`（装配世界坐标，与
   `MODES.cabin` 本地值同号）做全向射线扫描，**11×15 条射线全部命中 `batch/leather-warm`
   且距离仅 0.09~0.13 m** —— 相机被包在座椅壳里，看到的"灰褐大板"就是皮革壳内壁。
2. **前挡从车内看是一块灰板。** `glass-clear`（全车唯一，仅前挡）在车内视角因单面 + env
   反射呈现为不透明灰皮；隐藏该材质后同一机位立刻能看见路面/护栏/路牌（见
   `verify/r14/cabin-try/g3.png` vs `f3.png`）。驾驶视野被这块玻璃吃掉，与座椅壳叠加
   才形成"半屏被实体面占满"。

> 排查中被排除的伪线索：`steering-spokes` 的 world bbox 是 1.0×1.32×1.32 m 的大方块，
> 看似巨大遮挡物 —— 实为 **InstancedMesh 探针伪影**（射线用的是 geo 顶点，未乘
> instanceMatrix）。真正渲染的只有 2 根 0.165×0.055×0.022 的辐条。同类伪影也会出现在
> 所有 `repetitionSystems` 集群（rim-spokes 等）上，后续探针必须排除 InstancedMesh。

### 已修（`src/render/CameraRig.ts` + `src/core/Game.ts`）

- `MODES.cabin`：眼点 `(-0.55,1.16,-0.45)` → `(-0.55,1.33,-0.58)`，注视点 `1.12→1.04`。
  台面占屏从 ~55% 降到 ~25%，路面/护栏/路牌进入画面。
- Game：cabin 机位期间隐藏 `glass-clear`（仅前挡）网格，离开即恢复；只在模式变化时写，
  零每帧开销。实测 `verify/r14/game/cabin_r14b.png`。

### 未做（转入 R15）

- `src/assets/ref/*` 6 张参考图（座椅菱格/星空顶/中控屏/门板）仍未接线，`refTextures.ts`
  未创建 —— 材质升级整条线未启动。
- 三联屏顶沿 1.287 m 已到眼高（1.33 m）以下 4 cm，屏幕仍挡住正前方路面；若要"看得见
  远路"，需要把 `tri-screen` 下移 6~10 cm（spec 几何，需重跑 uvassert）。
