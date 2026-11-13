/**
 * tailLampC2.ts —— R67 · V800 外部高精度壳「C2 官图竖灯」程序化重建（零副作用纯模块）
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ 本模块**只依赖 three + 纯函数/常量**：禁 import ExternalShell / V800Adapter /  │
 * │   config/quality。后者在模块求值期读 window.devicePixelRatio，静态 import 会让    │
 * │   vitest collect 阶段抛 `window is not defined`（tests/r32_car_material.test.ts  │
 * │   :36-40 实证）。装配由 ExternalShell.ts 的 V800 分支完成，本文件不接线。        │
 * └──────────────────────────────────────────────────────────────────────────────────┘
 *
 * ══ 定罪背景（审查线运行时逐 mesh A/B 实证，R67 Phase1-B）══════════════════════
 *  · 外部壳 on 态「全宽 jagged 红带」= `src/assets/cars/v800/lamp_rear.glb` 的单 mesh
 *    `lamp_rear`（17,485 tri，局部 x[-0.1889,0.1847] / y[0.2200,0.2600] /
 *    z[-0.5650,-0.5150]）被 `ExternalShell.ts:2337-2350` 的 `lampRearMat` 整块刷成
 *    纯色深红 emissive。GLB 内 `materials/images/textures/samplers` 全 0，
 *    `TEXCOORD_0` accessor 存在但**无任何贴图消费它** ⇒ 锯齿来自几何层三角化/破面
 *    （按 x 分 48 桶上边缘抖动 25.84mm），R65-G7 的「atlas texel 拉伸」已证伪。
 *  · 中央「白色梯形」= body 白色车漆透过 lamp_rear 中央缺口，不是独立徽标件。
 *  · hide `lamp_rear` 后车身尾门露出一条**横向深色开口** ⇒ 不能只隐藏了事。
 *
 * ══ 三段式方案（主理人综合规格，Phase2 派单 §二）══════════════════════════════
 *  ① `lamp_rear` 由 ExternalShell 置 `visible=false`（几何/材质/dispose 账本保留，
 *     不从 `lampRearMeshes` 摘除，回滚逐位）；
 *  ② **全宽深色不透明尾门盖板**（本文件 `r67_tail_cover`，2 tri）盖住开口 + 中央白梯形；
 *  ③ **两侧 C2 竖灯**（`r67_tail_c2_face` + `r67_tail_c2_strips`）叠在盖板之前。
 *  左右同材质 quad 分别用 `mergeSafe` 合并 ⇒ 新增 mesh 恒 3 个（盖板 1 + face 1 + 红条 1），
 *  DC 预算 +3（隐藏原 1 DC ⇒ 净 +2），tri 预算 36（盖板薄盒 12 + face 4 + 红条 20 ⇒ 净 −17,449）。
 *
 * ══ 坐标与尺寸（**GLB 局部系**，× `manifest.scale` = 世界系）════════════════════
 *  · scale **由调用方从 `src/assets/cars/v800/manifest.json` 读**（当前 4.75），本模块
 *    只接收 `opts.scale` 并 `mesh.scale.setScalar(scale)`，**禁写死**。
 *  · 局部 −Z = 车尾外侧；`body` 组带 `rotY(π)` ⇒ 世界 +Z 为车尾、x 号翻转。
 *  · 新 mesh 与语义件同级（各自 scale），**不得挂在被 visible=false 的 `lamp_rear` 下**
 *    （three 隐藏父会连带隐藏整棵子树）。
 *  · 盖板定标来自离线 GLB 探针 `.qa/r67/dev/r67_cover_probe.json`（读 body.glb POSITION）：
 *      body 尾门最外层 z = −0.56751，轮廓 1%~99% 宽 = 0.41984；
 *      ⇒ 盖板半宽 0.19428（clamp 在轮廓内，不悬空，R49 教训①）、
 *        z = −0.56962（比 body 最外层再向外 10mm 世界，R49 教训② 防自遮挡）。
 *      y∈[0.214,0.266] 覆盖横带 y∈[0.220,0.260] 并上下各留 6mm 局部余量；
 *      上方 MAEXTRO 镀铬带（r58BuildRearBadge，yC=0.353 / h=0.014）高于盖板上沿
 *      0.266 ⇒ 不会被遮。
 *  · 竖灯首版标定 x=±0.155 / y∈[0.126,0.261] / faceZ=−0.57022（盖板外凸约 2.8mm 世界）、
 *    红条 z=−0.57037（再外凸 0.7mm 防 z-fighting）。**数值必须经三机位目检微调，
 *    不假装精确**；尤其 `rotY(π)` 翻 x 后「凤凰头朝左」是否被镜像成朝右，须 A/B 确认
 *    （与 parts/tailLamp.ts:66-68 的烘焙镜像同律）。
 *
 * ══ 刹车联动 / 画质纪律 ════════════════════════════════════════════════════════
 *  · 红条 mesh **直接复用 `lampRearMat` 同一实例** ⇒ `V800Adapter.ts:5181-5199` 每帧写
 *    `emissiveIntensity`（R51 clamp ≤1.15）自动覆盖，`V800Adapter.ts` 零改动、不扩
 *    `ExternalShellHandle`。
 *  · 盖板 / 底 / 镀铬框 / 金色点阵凤凰用独立**静态**材质（凤凰弱发光，不随刹车变亮，D-4）。
 *  · 单张不透明 CanvasTexture（1024×512，左右灯各半幅、右灯镜像）；**不用
 *    transparent+alphaTest**（R49 SwiftShader 整块泛白坑）；零外部图片资产
 *    （无 TextureLoader / 无 `new URL('*.png')`）。
 *  · 用户「两个红色」= **上下两簇红色区**（不是 2 条）；默认 3 上 / 2 下贴官图
 *    （与 parts/tailLamp.ts:151-165 `TAIL_LAMP_BLADES` 同源），可用
 *    `#r67tailtop=N` / `#r67tailbottom=M` 扫参（resolveC2StripCounts）。
 *  · 共享贴图 UV 用 `remapUVToRegion` 按 **mesh 自身 UV bbox 归一**（禁线性 remap），
 *    左右半幅各自映射；合批 `mergeSafe` 按材质实例分桶（同材质 quad 才合并）。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';

/* ══════════════════════ 1. 对外常量 / 参数 ══════════════════════ */

/** 用户口径「两个红色」= 上下两簇红色区；条数参数化，默认 3+2 贴官图。 */
export const C2_STRIP_COUNTS = { top: 3, bottom: 2 } as const;

/**
 * C2 atlas 尺寸（左右灯各占半幅）。
 * ⚠ Phase 2b 目检根因修正：原 1024×512（半幅 512×512 正方形）贴到宽:高 = 0.075:0.135
 *   （=0.5556）的竖灯上会被**纵向拉伸 1.8 倍**，把展翅凤凰压成一条竖直拖尾。
 *   改 1024×1024（半幅 512×1024，比例 0.5）贴近竖灯内框比例 ⇒ 残余拉伸仅 1.11 倍。
 */
export const C2_ATLAS_W = 1024;
export const C2_ATLAS_H = 1024;

/**
 * 金色点阵凤凰面板：22×30 网格，占灯高 ~82%（v∈[0.10,0.92]），点阵而非渐变。
 * 布局（主理人 Phase 2b 规格）：头喙在上部偏一侧、双翼向左右外展上扬（翼尖 u≈0.06/0.94、
 * v≈0.86）、身体中央竖列向下收窄、尾羽下部向斜下分叉 ⇒ 点阵占满竖灯内宽。
 */
export const C2_PHOENIX_PANEL = {
  cols: 22,
  rows: 30,
  /** R68 基线凤冠顶（`#r69c2lamp=off` 回此）。 */
  vLo: 0.10,
  /** R68 基线凤尾底（`#r69c2lamp=off` 回此）。 */
  vHi: 0.92
} as const;

/** R69 凤凰收窄基线：v 区间 [0.10,0.92]→[0.19,0.83]（高度 ×0.755），上下留更多黑底，治「黄凤凰贴牌偏大」。 */
export const C2_PHOENIX_VLO_R69 = 0.19;
export const C2_PHOENIX_VHI_R69 = 0.83;

/** 当前生效的凤凰 v 区间：R69 ON 收窄、off 回 R68 基线（护栏只钉 cols/rows/点亮比，不钉 vLo/vHi）。 */
export function phoenixVRangeActive(): { vLo: number; vHi: number } {
  return R69_C2_LAMP_ON
    ? { vLo: C2_PHOENIX_VLO_R69, vHi: C2_PHOENIX_VHI_R69 }
    : { vLo: C2_PHOENIX_PANEL.vLo, vHi: C2_PHOENIX_PANEL.vHi };
}
/** 内部取值（paintC2Atlas 用）。 */
function phoenixVRange(): { vLo: number; vHi: number } {
  return phoenixVRangeActive();
}

/**
 * GLB 局部坐标定标（× manifest.scale = 世界系）。
 * coverZ / faceZ / stripZ 由 `.qa/r67/dev/r67_cover_probe.json` 实测推导，见头注。
 */
export const C2_GEOM = {
  coverHalfW: 0.19428,
  coverYLo: 0.214,
  coverYHi: 0.266,
  coverZ: -0.56962,
  lampCenterX: 0.155,
  lampHalfW: 0.0375,
  lampYLo: 0.126,
  lampYHi: 0.261,
  faceZ: -0.57022,
  stripZ: -0.57037,
  stripHalfW: 0.030,
  stripHalfH: 0.003
} as const;

/**
 * R68 P0-4 · 盖板侧视悬空黑板收口「标量白名单」（主理人修正 A / D 终裁）。
 *
 * 修正 D 覆盖原派单与修正 A 的「宽度 clamp / 重标 z / 重标 face UV」：`tests/r67_tail_c2.test.ts`
 * 对 `C2_GEOM` 有等号级断言（:445-455）+ 36/32/16 tri（:384/:393/:429/:441）+
 * dispose 账本位置（:206-212），且 `tests/**` 归 tester、开发线禁碰 ⇒
 * **本波 P0-4 必须零护栏改动**：`C2_GEOM` 全字段逐字不动、几何拓扑逐字不动、
 * `C2_TRI_BUDGET=36` / `C2_STRIP_COUNTS` 不动、恒 3 mesh / 36 tri / 3 DC。
 *
 * 允许的 3 处（全部零 tri / 零 DC / 零新增材质贴图）：
 *  ① `coverDepth` 标量 10mm → 0.5mm（下面两个具名常量；护栏未钉死 coverDepth，已 grep 实证）；
 *  ② `paintC2Atlas(p,w,h,surround)` Canvas 内画中央白块深色 surround；
 *  ③ 盖板材质标量 color / roughness（下面成对具名常量）。
 * `#r68c2cover=off` ⇒ `opts.coverTweak=false` ⇒ 三处逐位回 R67 基线。
 *
 * ⚠ 具名常量供 tester 护栏读做 off 逐位回滚断言（主理人索取的可读命名）：
 *   `C2_COVER_DEPTH_BASELINE_M` / `C2_COVER_DEPTH_R68_M`、
 *   `C2_COVER_COLOR_BASELINE` / `C2_COVER_COLOR_R68`、
 *   `C2_COVER_ROUGHNESS_BASELINE` / `C2_COVER_ROUGHNESS_R68`。
 */
/** 盖板薄盒世界厚度（m）：R67 基线 10mm → R68 近共面 0.5mm，端面投影 −95%。 */
export const C2_COVER_DEPTH_BASELINE_M = 0.010;
export const C2_COVER_DEPTH_R68_M = 0.0005;
/** 盖板材质标量：R68 略微提亮 + 降反射，缓和与牌照白框的反差。 */
export const C2_COVER_COLOR_BASELINE = 0x1c1c22;
export const C2_COVER_COLOR_R68 = 0x24242c;

/* ══════════════════════ R69 · C2 竖灯缩小 + 侧贴完整尾灯纹理 ══════════════════════
 * 用户真机反馈（R69）：两侧 C2 竖灯太长太宽、两灯应「合并」成约两块大小；
 * 侧面金色竖条漏洞需侧贴**完整尾灯纹理**掩盖（非纯黑）。
 * 主理人终裁参数：高度 ×0.48 / 宽度 ×0.40 / 两灯间距保持（lampCenterX 不动）。
 *
 * ⚠ 零护栏改动：`C2_GEOM` 全字段逐字不动（`tests/r68_visual.test.ts:247` toEqual 钉死），
 * 改用下面「有效缩放」在 builder 内按 R69 系数算 face/strip 几何；`#r69c2lamp=off`
 * ⇒ 逐位回 R68 基线。tri 恒 36 + side 4 = 40 ≤ C2_TRI_BUDGET(36) 的语义边界
 * ⇒ 本波把 face 侧壁并入 faceMesh（同 atlas 材质、同 4-tri/侧），恒 3 mesh / 3 DC。
 *
 * ⚠ 本地 hash 判据（字节等价 ExternalShell 的私有 r51HookOff）：tailLampC2 被
 * ExternalShell 反向 import，若从这里 import ExternalShell 会成环 ⇒ 就地复制同语义正则，
 * 避开 :1987 前 slice 锚点与 r64/r67 追加段黑名单。
 */
/** R69 竖灯高度缩放：span × 0.48（世界 0.643m → 0.309m）。 */
export const C2_LAMP_SHRINK_HEIGHT = 0.48;
/** R69 竖灯宽度缩放：lampHalfW / stripHalfW × 0.40（世界 0.356m → 0.142m）。 */
export const C2_LAMP_SHRINK_WIDTH = 0.40;
/** R71 重做：侧面竖灯沿 z 进深（GLB 局部 m），从 faceZ 向 +z 延伸。
 *  上一轮 0.02（世界 ≈0.095m）力度严重不足 ⇒ 侧面仍是光秃黑柱；本波放大到 0.12
 *  （世界 ≈0.57m）配合 y 半高 0.10，把侧壁 quad 撑成一块完整的「侧面竖灯大面」。 */
export const C2_LAMP_SIDE_DEPTH = 0.12;

/** 本地 hash 开关判据（与 ExternalShell.ts:78 r51HookOff 字节等价；node/SSR 无 window ⇒ false=ON）。 */
function r69HookOff(key: string): boolean {
  if (typeof window === 'undefined') return false;
  return new RegExp(`(?:^|[#&])${key}=off`, 'i').test(window.location.hash);
}

/** R69 C2 竖灯缩小 + 侧贴完整纹理开关（默认 ON，`#r69c2lamp=off` 回 R68 基线）。 */
export const R69_C2_LAMP_ON = !r69HookOff('r69c2lamp');

/* ── R70 · 盖板横杠缩短至与竖灯对齐 ──
 * 用户反馈：车尾正面深色横杠（盖板）明显比两侧竖灯宽，需缩短至与灯对齐。
 * 竖灯外缘 = lampCenterX(0.155) + lampHalfW×0.40(0.015) = 0.170 local；
 * 盖板 coverHalfW 0.19428 × 0.875 = 0.170 ⇒ 两端与竖灯外缘平齐。
 * ⚠ 上波 R69 曾试缩到 0.097（比灯窄）露出 body 残留红带而撤销；本次缩到 0.170
 *   （与灯平齐）竖灯遮住边缘、仅两灯之间中央区可能露红带 ⇒ 需目检，露则迭代。
 * `#r70c2align=off` ⇒ coverHalfW 回 R68 全宽 0.19428。 */
/** R70 盖板宽度缩放：coverHalfW × 0.875 ⇒ 0.19428→0.170（与竖灯外缘平齐）。 */
export const C2_COVER_ALIGN_SCALE = 0.875;
/** R70 盖板对齐竖灯开关（默认 ON，`#r70c2align=off` 回 R68 全宽盖板）。 */
export const R70_C2_ALIGN_ON = !r69HookOff('r70c2align');
export const C2_COVER_ROUGHNESS_BASELINE = 0.72;
export const C2_COVER_ROUGHNESS_R68 = 0.78;
/** atlas 内深色 surround 颜色（不透明、非渐变、零几何）。 */
export const C2_ATLAS_SURROUND_COLOR = '#101016';

/* ── R71 · C2 竖灯侧面大面重做 + 盖板侧面黑填充 ──
 * 用户反馈（R71 二轮）：上一轮（commit 7497d34）只做毫米级改动（侧壁外扩 6mm、盖板填 2cm），
 * 侧面仍是光秃黑柱 + 锯齿破面，力度严重不足。本波把**现有的薄侧壁 quad 撑成完整侧面竖灯大面**：
 * ① 侧面竖灯大面：复用侧壁 quad（已 faceMat + atlas、法线 ±X），把它的 y 范围从跟随 R69
 *    缩小后的 lampYLo..lampYHi（高 0.0648）改成固定 sideYLo..sideYHi（半高 C2_LAMP_SIDE_HALF_H
 *    = 0.10 ⇒ 高 0.20，**比正面大**），沿 z 从 faceZ 向 +z 延伸 C2_LAMP_SIDE_DEPTH = 0.12，
 *    UV remap 到 atlas 半幅（凤凰点阵完整居中）。x 外缘仍外推 C2_LAMP_SIDE_OUTSET（外凸）。
 *    **零 tri 增量**（仍是左右各 1 quad，face 8 tri 不变）——这是与上一轮的本质区别：
 *    不是把 quad 微微外推，而是把同一块 quad 的尺寸撑到能覆盖整段黑柱。
 * ② 盖板侧面黑填充：盖板 ±x 端各一个 quad（x=±coverHalfW、法线 ±X、z 从 coverZ 向内
 *    C2_COVER_FILL_DEPTH、coverYLo..coverYHi 全高），复用 coverMat。本波进深 2cm→6cm（≥0.05）
 *    真正遮住端面斜视角缝隙。+2 quad = +4 tri。
 * 两处各自 `#r71c2side=off` / `#r71c2coverfill=off` ⇒ 逐位回 R70。 */
/** R71 侧壁外扩量（GLB 局部 m）：侧壁外缘比正面外缘更外凸。 */
export const C2_LAMP_SIDE_OUTSET = 0.006;
/** R71 侧面竖灯半高（GLB 局部 m）：sideYLo/Hi = lampCy ∓ 此值，高 0.20 比正面(0.0648)大。 */
export const C2_LAMP_SIDE_HALF_H = 0.10;
/** R71 盖板侧面填充深度（GLB 局部 m）：沿 +z 从 coverZ 向内，掩端面缝隙。
 *  上一轮 0.02 太薄 ⇒ 本波 0.06（≥0.05 进深）真正遮住。 */
export const C2_COVER_FILL_DEPTH = 0.06;
/** R71 竖灯侧面外扩开关（默认 ON，`#r71c2side=off` 回 R70）。 */
export const R71_C2_SIDE_ON = !r69HookOff('r71c2side');
/** R71 盖板侧面黑填充开关（默认 ON，`#r71c2coverfill=off` 回 R70）。 */
export const R71_C2_COVERFILL_ON = !r69HookOff('r71c2coverfill');

/** 预算上限（护栏消费）。新增 mesh 恒 3；tri = 盖板薄盒 12 + face 4 + 2·(top+bottom)·2。
 *  R69：竖灯缩小（高×0.48/宽×0.40）+ 侧面贴完整尾灯纹理 ⇒ face 并入左右侧壁 +4 ⇒ 默认 40。
 *  `#r69c2lamp=off` ⇒ 无侧壁 ⇒ 回 R68 的 36。 */
export const C2_DC_BUDGET = 3;
/** tri 上限：base 40（盖板12 + face4/侧壁8 + 红条20），R71 盖板侧面填充 +4 ⇒ 44。
 *  `#r71c2coverfill=off` ⇒ 回 40；`#r69c2lamp=off` ⇒ 回 36 基线。 */
export const C2_TRI_BUDGET = 36 + (R69_C2_LAMP_ON ? 4 : 0) + (R71_C2_COVERFILL_ON ? 4 : 0);
export const C2_MAT_BUDGET = 2;
export const C2_TEX_BUDGET = 1;

/**
 * 扫参钩子：解析 `#r67tailtop=N` / `#r67tailbottom=M`（纯函数，读调用方传入的 hash）。
 * clamp [0,6]；缺省回落 C2_STRIP_COUNTS。键名不含 `noprewarm` 子串（Game.ts 入口守卫）。
 */
export function resolveC2StripCounts(hash: string): { top: number; bottom: number } {
  const clamp = (v: number): number => Math.min(6, Math.max(0, Math.round(v)));
  const mt = /(?:^|[#&])r67tailtop=(\d+)/i.exec(hash);
  const mb = /(?:^|[#&])r67tailbottom=(\d+)/i.exec(hash);
  return {
    top: mt ? clamp(Number(mt[1])) : C2_STRIP_COUNTS.top,
    bottom: mb ? clamp(Number(mb[1])) : C2_STRIP_COUNTS.bottom
  };
}

/* ══════════════════════ 2. 金色点阵凤凰：解析遮罩 ══════════════════════ */

interface Pt {
  x: number;
  y: number;
}

/** 点 p 是否在「中心 c、轴向 dir、半长 a、半宽 b」的旋转椭圆内（uv 系，v 向下）。 */
function inRotEllipse(p: Pt, c: Pt, dir: Pt, a: number, b: number): boolean {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const along = dx * dir.x + dy * dir.y;
  const across = dx * -dir.y + dy * dir.x;
  return (along / a) * (along / a) + (across / b) * (across / b) <= 1;
}

/** 点是否在三角形内（叉积同侧法）。 */
function inTri(p: Pt, t0: Pt, t1: Pt, t2: Pt): boolean {
  const s1 = (t1.x - t0.x) * (p.y - t0.y) - (t1.y - t0.y) * (p.x - t0.x);
  const s2 = (t2.x - t1.x) * (p.y - t1.y) - (t2.y - t1.y) * (p.x - t1.x);
  const s3 = (t0.x - t2.x) * (p.y - t2.y) - (t0.y - t2.y) * (p.x - t2.x);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

/**
 * 凤凰解析遮罩（uv∈[0,1]²，v 向下）。返回 0=熄灭点 / 1=常亮金点 / 2=高亮羽尖。
 * 布局：头朝**画布左**（u≈0.27）+ 喙、竖直躯干、左右翼展（凤凰比鹰更宽）、
 * 3 片向右下飘的尾羽。点阵采样后读成 LED 点阵屏而非渐变剪影。
 */
export function phoenixMask(u: number, v: number): 0 | 1 | 2 {
  const p: Pt = { x: u, y: v };
  // 头（Phase 2c 强化）：半径 0.065→0.085、上移到双翼上方居中、头顶加横向羽冠、
  // 喙加长加宽。头与翼根（shoulder 行 11）之间留 1~2 格空隙（行 9-10 不填充），
  // 使特写下读作「有冠的鸟头」独立轮廓，而非与翼根融成一团。
  const hc: Pt = { x: 0.40, y: 0.80 };
  const dhx = p.x - hc.x;
  const dhy = p.y - hc.y;
  if (dhx * dhx + dhy * dhy <= 0.085 * 0.085) return 1;
  // 头顶羽冠：一条横向短带（约 3 格宽、半格高）；红条最下一条落在其上方 ⇒ 不被压
  if (inRotEllipse(p, { x: 0.40, y: 0.885 }, { x: 1, y: 0 }, 0.075, 0.028)) return 1;
  // 喙（加长加宽的小三角 + 喙尖，从头右前缘伸出）
  if (inTri(p, { x: 0.47, y: 0.78 }, { x: 0.62, y: 0.815 }, { x: 0.47, y: 0.845 })) return 1;
  // 身体中央竖列，向下收窄
  if (inRotEllipse(p, { x: 0.47, y: 0.48 }, { x: 0.05, y: 1 }, 0.17, 0.046)) return 1;
  // 双翼：3 道放射羽片 / 侧，自胸部外展上扬到翼尖 u≈0.10 / 0.90、v≈0.78。
  // ⚠ 半宽 0.062~0.046（≈1.2~1.4 格）确保每片羽在 22 宽网格上稳定命中，
  //   否则会退化成主理人指出的「竖直拖尾 / Y 形」。
  const shoulder: Pt = { x: 0.47, y: 0.62 };
  for (const side of [-1, 1]) {
    for (let k = 0; k < 3; k += 1) {
      const tip: Pt = { x: 0.5 + side * (0.40 - k * 0.03), y: 0.78 - k * 0.05 };
      const wx = tip.x - shoulder.x;
      const wy = tip.y - shoulder.y;
      const L = Math.hypot(wx, wy) || 1;
      const dir: Pt = { x: wx / L, y: wy / L };
      if (inRotEllipse(
        p,
        { x: shoulder.x + dir.x * L * 0.5, y: shoulder.y + dir.y * L * 0.5 },
        dir, L * 0.5 + 0.035, 0.062 - k * 0.008
      )) {
        return k <= 1 ? 2 : 1;
      }
    }
  }
  // 尾羽：下部向斜下分叉 2 片（v≈0.13~0.27）
  const tail: Pt = { x: 0.46, y: 0.27 };
  for (const side of [-1, 1]) {
    const tip: Pt = { x: 0.46 + side * 0.16, y: 0.13 };
    const tx = tip.x - tail.x;
    const ty = tip.y - tail.y;
    const L = Math.hypot(tx, ty) || 1;
    const dir: Pt = { x: tx / L, y: ty / L };
    if (inRotEllipse(
      p,
      { x: tail.x + dir.x * L * 0.5, y: tail.y + dir.y * L * 0.5 },
      dir, L * 0.5 + 0.03, 0.05
    )) {
      return 1;
    }
  }
  return 0;
}

/** 确定性伪随机（点亮度抖动；node / browser 两侧同一序列，护栏可复算）。 */
function hash2(i: number, j: number): number {
  const s = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/* ══════════════════════ 3. 程序化贴图（painter 注入） ══════════════════════ */

/**
 * 2D 绘制指令抽象：浏览器走 CanvasRenderingContext2D 适配层，node / vitest 走
 * 内存 shim 录制指令序列做「程序化贴图数据指纹」断言，同一份纯函数两处验证。
 */
export interface C2Painter {
  /** 全画布铺底 */
  fill(w: number, h: number, color: string): void;
  /** 实心矩形 */
  rect(x: number, y: number, w: number, h: number, color: string): void;
  /** 实心圆点（点阵凤凰 / 熄灭点） */
  dot(x: number, y: number, r: number, color: string): void;
}

/**
 * C2 atlas 绘制（**纯函数**，零 DOM 依赖）：
 *  · 不透明黑烟熏底 `#0a0a0e` —— 不用 transparent+alphaTest（R49 SwiftShader 泛白坑）；
 *  · 镀铬圆角观感用「外亮边 + 内暗边」两层矩形实现（避免 roundRect 弧段面数问题）；
 *  · 中部金色点阵凤凰（点阵而非渐变、黑底、占灯高 ~55%）；
 *  · **不画红条**：红条由独立 mesh 复用 `lampRearMat` 承担，随 brakeLevel 联动；
 *  · 左右半幅镜像对称（右灯 u 取反），最终画面「头朝左」需 A/B 确认（body rotY(π) 翻 x）。
 */
export function paintC2Atlas(
  p: C2Painter, w: number, h: number, surround = false
): void {
  p.fill(w, h, '#0a0a0e');
  const half = w / 2;
  for (const side of [0, 1]) {
    const ox = side * half;
    const inset = Math.round(half * 0.045);
    const x0 = ox + inset;
    const y0 = inset;
    const bw = half - inset * 2;
    const bh = h - inset * 2;
    // 镀铬厚圆角框：外亮银 + 内暗灰 + 再内一圈高光，形成「厚镀铬包边」读感
    p.rect(x0, y0, bw, bh, '#c2c6cd');
    p.rect(x0 + 6, y0 + 6, bw - 12, bh - 12, '#4a4d55');
    p.rect(x0 + 10, y0 + 10, bw - 20, bh - 20, '#0d0d12');
    p.rect(x0 + 10, y0 + 10, bw - 20, 4, '#d6dae2');
    p.rect(x0 + 10, y0 + bh - 14, bw - 20, 4, '#8f949d');
    // 黑烟熏底拉丝（极淡横纹，非渐变）
    for (let yy = y0 + 20; yy < y0 + bh - 20; yy += 12) {
      p.rect(x0 + 12, yy, bw - 24, 1, '#121218');
    }
    // 金色点阵凤凰（22×30 网格，R69 收窄 v 区间治「凤凰偏大」；off 回 [0.10,0.92] 基线）
    const cols = C2_PHOENIX_PANEL.cols;
    const rows = C2_PHOENIX_PANEL.rows;
    const vr = phoenixVRange();
    const gy0 = h * vr.vLo;
    const gy1 = h * vr.vHi;
    const cw = (bw - 28) / cols;
    const ch = (gy1 - gy0) / rows;
    const r = Math.min(cw, ch) * 0.33;
    for (let j = 0; j < rows; j += 1) {
      for (let i = 0; i < cols; i += 1) {
        // 半幅内归一 u；右灯镜像 ⇒ 两灯翼展向车中（朝向待 A/B 确认，见交付遗留项）
        const uRaw = (i + 0.5) / cols;
        const u = side === 1 ? 1 - uRaw : uRaw;
        // ⚠ v 翻转：canvas y 向下（j=0 = 屏顶），而 phoenixMask 用「v 大 = 上部」
        //   （头 v≈0.74 / 翼尖 v≈0.86 在上、尾羽 v≈0.13~0.30 在下）⇒ 不翻转凤凰会倒挂。
        const v = 1 - (j + 0.5) / rows;
        const cx = x0 + 14 + (i + 0.5) * cw;
        const cy = gy0 + (j + 0.5) * ch;
        const m = phoenixMask(u, v);
        if (m === 0) {
          p.dot(cx, cy, r * 0.62, 'rgba(154,120,52,0.20)');
        } else {
          const light = 46 + (m === 2 ? 16 : 0) + Math.round(hash2(i, j) * 14);
          p.dot(cx, cy, r, `hsl(43, 84%, ${light}%)`);
        }
      }
    }
  }
  /* R68 P0-4 · 中央白块深色 surround（修正 A/D：直接画进现有 atlas Canvas，
   * 零新增几何 / 零 DC / 零材质 / 零贴图）。画在两半幅下沿，把深色盖板与牌照白框
   * 之间读成「深色面板包白框」，缓和反差。surround=false ⇒ 逐位回 R67 原 atlas。 */
  if (surround) {
    const sh = Math.round(h * 0.055);
    for (const side of [0, 1]) {
      const ox = side * half;
      const x0 = ox + Math.round(half * 0.045);
      const bw = half - Math.round(half * 0.045) * 2;
      p.rect(x0 + 10, h - sh - 16, bw - 20, sh, C2_ATLAS_SURROUND_COLOR);
      p.rect(x0 + 10, h - sh - 16, bw - 20, 3, '#33343c');
    }
  }
}

/** CanvasTexture。node（无 document）返回 null ⇒ 调用方降级为无图材质，QA shim 不受影响。
 *  `surround=false`（默认）⇒ 与 R67 逐位一致；`true` ⇒ 同一张 atlas 内加深色 surround。 */
export function makeC2AtlasTexture(surround = false): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = C2_ATLAS_W;
  canvas.height = C2_ATLAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const p: C2Painter = {
    fill: (w, h, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
    },
    rect: (x, y, w, h, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    },
    dot: (x, y, r, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  paintC2Atlas(p, C2_ATLAS_W, C2_ATLAS_H, surround);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/* ══════════════════════ 4. UV 归一（禁线性 remap） ══════════════════════ */

/**
 * 按 **mesh 自身 UV bbox** 归一到 0..1，再映射到 atlas 目标 region。
 * ⚠ 禁线性 remap（R4 圆角 extrude UV 曾 u∈[-0.5,0.5] / v∈[-0.5,1.0]，
 *   `盒基元 UV 恒 0..1` 前提失效 ⇒ #uvassert 实测 232/304 串味）。
 */
export function remapUVToRegion(
  geo: THREE.BufferGeometry,
  u0: number,
  u1: number,
  v0: number,
  v1: number
): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv) return;
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < uv.count; i += 1) {
    minU = Math.min(minU, uv.getX(i));
    maxU = Math.max(maxU, uv.getX(i));
    minV = Math.min(minV, uv.getY(i));
    maxV = Math.max(maxV, uv.getY(i));
  }
  const du = maxU - minU || 1;
  const dv = maxV - minV || 1;
  for (let i = 0; i < uv.count; i += 1) {
    const nu = (uv.getX(i) - minU) / du;
    const nv = (uv.getY(i) - minV) / dv;
    uv.setXY(i, u0 + nu * (u1 - u0), v0 + nv * (v1 - v0));
  }
  uv.needsUpdate = true;
}

/* ══════════════════════ 5. 几何装配 ══════════════════════ */

/**
 * 单个朝向 −Z（局部车尾外侧）的 quad。
 * 顶点序 左上/右上/左下/右下，索引 (0,1,2)+(1,3,2) ⇒ 叉积恒 −Z。
 * UV 先给 0..1，由 remapUVToRegion 按自身 bbox 归一到 atlas region。
 */
function makeQuad(
  x0: number, x1: number, y0: number, y1: number, z: number
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    x0, y1, z, x1, y1, z, x0, y0, z, x1, y0, z
  ], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1
  ], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 1, 1, 1, 0, 0, 1, 0
  ], 2));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  return g;
}

/** 合并同材质 quad（mergeSafe 统一转 non-indexed，避免 indexed/non-indexed 混拼返回 null）。 */
function mergeQuads(quads: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeSafe(quads);
  for (const q of quads) q.dispose();
  return merged;
}

/** 扫参到 0 上 / 0 下时给一枚「有 position 属性、0 顶点」的空几何，避免 mesh 无 attribute 崩溃。 */
function emptyQuadGeo(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([], 2));
  return g;
}

export interface C2BuildOptions {
  /** 由调用方从 `src/assets/cars/v800/manifest.json` 读，禁写死。 */
  scale: number;
  /** 复用同一实例 ⇒ V800Adapter.update() 每帧写 emissiveIntensity 自动联动。 */
  lampRearMat: THREE.Material;
  stripTop?: number;
  stripBottom?: number;
  /**
   * R68 P0-4（修正 A/D 终裁）：只驱动 3 处**标量**——coverDepth 10mm→0.5mm、
   * `paintC2Atlas` 内深色 surround、盖板材质标量；`C2_GEOM` 全字段与几何拓扑不动。
   * 缺省 / false ⇒ **逐位回 R67 三段式**（3 mesh / 36 tri / 3 DC，护栏断言全部成立）。
   */
  coverTweak?: boolean;
}

export interface C2BuildResult {
  /** 恒 3 个 mesh：盖板 / face / 红条，全部追加进 ExternalShell 的 lampRearMeshes。 */
  meshes: THREE.Mesh[];
  coverMesh: THREE.Mesh;
  faceMesh: THREE.Mesh;
  redStripMesh: THREE.Mesh;
  /** 本波新建的材质（不含复用的 lampRearMat）。 */
  mats: THREE.Material[];
  geos: THREE.BufferGeometry[];
  tex: THREE.Texture[];
  budget: { dc: number; tri: number; mat: number; tex: number };
}

function markExternal(
  mesh: THREE.Mesh,
  name: string,
  scale: number,
  renderOrder: number
): THREE.Mesh {
  mesh.name = name;
  mesh.scale.setScalar(scale);
  // R57/R59 铁律：setExteriorHidden 必须跳过外部壳件（否则 cabin 态被 id-less 规则连藏）
  (mesh.userData as { r44External?: boolean }).r44External = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.renderOrder = renderOrder;
  return mesh;
}

/**
 * 构建「盖板 + 两侧 C2 竖灯」。纯装配，零 DOM 读（贴图内部降级为 null 时仍可构建）。
 * 所有几何写 GLB 局部坐标，由 mesh.scale 统一放大；调用方把它们挂到 body 组即可。
 */
export function buildTailLampC2(opts: C2BuildOptions): C2BuildResult {
  const counts = {
    top: opts.stripTop ?? C2_STRIP_COUNTS.top,
    bottom: opts.stripBottom ?? C2_STRIP_COUNTS.bottom
  };
  const G = C2_GEOM;
  // 修正 D：`coverTweak` 只驱动 3 处标量（coverDepth / atlas surround / 材质标量），
  // **不驱动任何几何拓扑**；默认 / off 态三处逐位回 R67 基线。
  const tweak = opts.coverTweak === true;
  // R69 终裁：竖灯缩小（高 ×0.48 / 宽 ×0.40）+ 侧贴完整尾灯纹理 + 盖板宽度 ×0.50。
  // `C2_GEOM` 逐字不动（r68_visual:247 toEqual 钉死）；`#r69c2lamp=off` ⇒ 全部回 R68 基线。
  const r69 = R69_C2_LAMP_ON;
  const r70Align = R70_C2_ALIGN_ON;
  const tex = makeC2AtlasTexture(tweak);
  const texList: THREE.Texture[] = tex ? [tex] : [];

  // 盖板：深墨不发光、不透明（FrontSide）；盖住横带开口 + 中央白梯形/圆徽。
  // Phase 2b-B（主理人目检）：0x141418 → 0x1c1c22 提亮一档，读作「深色面板」而非纯黑洞；
  // roughness 0.82 → 0.72 配合提亮给一点环境反射层次。不做跟随 variant 车漆（需扩
  // V800Adapter setVariant 钩子，本波不做，列下一波）。
  // ⚠ 不碰 side（恒 FrontSide）、不碰 transparent（修正 D 硬约束）。
  const coverMat = new THREE.MeshStandardMaterial({
    color: tweak ? C2_COVER_COLOR_R68 : C2_COVER_COLOR_BASELINE,
    roughness: tweak ? C2_COVER_ROUGHNESS_R68 : C2_COVER_ROUGHNESS_BASELINE,
    metalness: 0.08,
    side: THREE.FrontSide
  });
  // 竖灯面：atlas 作 map + emissiveMap ⇒ 金色点阵凤凰弱自发光（静态，不接 brakeLevel）
  const faceMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: tex ?? undefined,
    emissive: new THREE.Color(0x2a1e08),
    emissiveMap: tex ?? undefined,
    emissiveIntensity: 0.55,
    roughness: 0.55,
    metalness: 0.12,
    side: THREE.FrontSide
  });

  // Phase 2b-C（侧缘接缝自查）：盖板由单面 2-tri plane 改**薄盒**（BoxGeometry 6 面 = 12 tri）。
  // rear34 后 3/4 视角下，单面 plane 的侧缘会读作一条贴片（z 外凸 body 尾门 10mm 世界）；
  // 薄盒给盖板 z 方向真实厚度、内表面嵌到 body 尾门面 ⇒ 3/4 下看到侧壁而非悬空片。
  // 代价：盖板 2 tri → 12 tri（+10），DC 不变、材质不变 ⇒ 全车净 −17,449 tri（远小于原 17,485）。
  // 用 BoxGeometry 而非 4 片手写侧壁 quad ⇒ 法线/绕序由 three 保证，避绕向踩坑；纯色无 UV 需求。
  // 修正 D：`C2_GEOM` 全字段逐字使用、BoxGeometry 拓扑逐字不变（恒 12 tri）。
  // 唯一标量：世界厚度 10mm → 0.5mm ⇒ 侧视/3/4 的端面投影面积 −95%，侧壁不再读作黑板。
  const coverDepth =
    (tweak ? C2_COVER_DEPTH_R68_M : C2_COVER_DEPTH_BASELINE_M) / opts.scale;
  // 盖板宽度：R70 缩到与竖灯外缘平齐（lampCenterX + 生效 lampHalfW），遮住边缘红带；
  // 两灯之间中央区可能露 body 残留红带 ⇒ 目检，露则迭代。`#r70c2align=off` 回 R68 全宽。
  const effLampHalfW = r69 ? G.lampHalfW * C2_LAMP_SHRINK_WIDTH : G.lampHalfW;
  const coverHalfW = r70Align ? G.lampCenterX + effLampHalfW : G.coverHalfW;
  const coverBox = new THREE.BoxGeometry(
    coverHalfW * 2, G.coverYHi - G.coverYLo, coverDepth
  );
  // BoxGeometry 原点在盒心 ⇒ 平移使「外表面 = coverZ、内表面嵌到 body 尾门面」
  coverBox.translate(0, (G.coverYLo + G.coverYHi) / 2, G.coverZ + coverDepth / 2);
  // R71 盖板侧面黑填充：左右端各加一个 quad（x=±coverHalfW、法线 ±X、z 从 coverZ
  // 向内 C2_COVER_FILL_DEPTH、coverYLo..coverYHi 全高），复用 coverMat 纯色零新材质，
  // 掩盖薄盒 ±x 端面斜视角缝隙/漏洞。合并进 coverGeo ⇒ 恒 3 mesh / 零 DC / 零新材质。
  let coverGeo: THREE.BufferGeometry = coverBox;
  if (R71_C2_COVERFILL_ON) {
    const fillQuads: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const fq = new THREE.BufferGeometry();
      const nx = side < 0 ? -1 : 1;
      // 顶点：yLo/zIn、yHi/zIn、yLo/coverZ、yHi/coverZ（绕序同侧壁 quad，法线 ±X）
      fq.setAttribute('position', new THREE.Float32BufferAttribute([
        side * coverHalfW, G.coverYLo, G.coverZ + C2_COVER_FILL_DEPTH,
        side * coverHalfW, G.coverYHi, G.coverZ + C2_COVER_FILL_DEPTH,
        side * coverHalfW, G.coverYLo, G.coverZ,
        side * coverHalfW, G.coverYHi, G.coverZ
      ], 3));
      fq.setAttribute('normal', new THREE.Float32BufferAttribute([
        nx, 0, 0, nx, 0, 0, nx, 0, 0, nx, 0, 0
      ], 3));
      fq.setAttribute('uv', new THREE.Float32BufferAttribute([
        0, 0, 0, 1, 1, 0, 1, 1
      ], 2));
      fq.setIndex([0, 1, 2, 1, 3, 2]);
      fillQuads.push(fq);
    }
    coverGeo = mergeSafe([coverBox, ...fillQuads]);
    coverBox.dispose();
    for (const q of fillQuads) q.dispose();
  }
  const coverMesh = markExternal(
    new THREE.Mesh(coverGeo, coverMat), 'r67_tail_cover', opts.scale, 2
  );
  // 修正 A/D：中央白块 surround **不再新增任何几何**，改由 `paintC2Atlas(...,true)`
  // 画进现有 atlas（见本文件 §3）⇒ 恒 3 mesh / 36 tri / 3 DC / 2 材质 / 1 贴图。

  // R69：竖灯缩小 + 侧贴（r69 已在 builder 顶部声明）
  const lampHalfW = r69 ? G.lampHalfW * C2_LAMP_SHRINK_WIDTH : G.lampHalfW;
  const lampCy = (G.lampYLo + G.lampYHi) / 2;
  const lampHalfH = r69
    ? ((G.lampYHi - G.lampYLo) / 2) * C2_LAMP_SHRINK_HEIGHT
    : (G.lampYHi - G.lampYLo) / 2;
  const lampYLo = lampCy - lampHalfH;
  const lampYHi = lampCy + lampHalfH;
  const sideDepth = r69 ? C2_LAMP_SIDE_DEPTH : 0;
  // R71 重做：侧面竖灯大面的 y 范围固定为 lampCy ∓ C2_LAMP_SIDE_HALF_H（高 0.20），
  // **比正面竖灯**（R69 缩小后高 0.0648）大，覆盖车尾侧面那段光秃黑柱。
  const sideYLo = lampCy - C2_LAMP_SIDE_HALF_H;
  const sideYHi = lampCy + C2_LAMP_SIDE_HALF_H;

  // face：左右各 1 quad（竖灯正面）+ 左右各 1 侧壁 quad（贴完整 atlas 纹理，掩侧看金竖条）
  const faceQuads: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const cx = side * G.lampCenterX;
    const xOut = cx + side * lampHalfW; // 外侧棱
    const q = makeQuad(cx - lampHalfW, cx + lampHalfW, lampYLo, lampYHi, G.faceZ);
    // 局部 −x 用左半幅、+x 用右半幅；body rotY(π) 会翻世界 x，最终朝向待 A/B 目检
    remapUVToRegion(q, side < 0 ? 0 : 0.5, side < 0 ? 0.5 : 1, 0, 1);
    faceQuads.push(q);
    if (sideDepth > 0) {
      // 侧面竖灯大面（R71 重做）：x=xWall 平面、沿 z 从 faceZ（外）到 faceZ+sideDepth（内）、
      // y 用 sideYLo..sideYHi（高 0.20，比正面大）；显式外向法线（±X）+ atlas 半幅 UV
      // （凤凰点阵完整居中，与正面同款）。makeQuad 会退化（x0=x1 ⇒ normal 坏/UV 除零），故手写。
      const zIn = G.faceZ + sideDepth;
      const sq = new THREE.BufferGeometry();
      // 顶点：sideYLo/zIn、sideYHi/zIn、sideYLo/faceZ、sideYHi/faceZ
      // R71：外缘再外推 C2_LAMP_SIDE_OUTSET ⇒ 侧面竖灯比正面外缘更外凸
      const xWall = R71_C2_SIDE_ON ? xOut + side * C2_LAMP_SIDE_OUTSET : xOut;
      sq.setAttribute('position', new THREE.Float32BufferAttribute([
        xWall, sideYLo, zIn, xWall, sideYHi, zIn,
        xWall, sideYLo, G.faceZ, xWall, sideYHi, G.faceZ
      ], 3));
      const nx = side < 0 ? -1 : 1;
      sq.setAttribute('normal', new THREE.Float32BufferAttribute([
        nx, 0, 0, nx, 0, 0, nx, 0, 0, nx, 0, 0
      ], 3));
      sq.setAttribute('uv', new THREE.Float32BufferAttribute([
        0, 0, 0, 1, 1, 0, 1, 1
      ], 2));
      sq.setIndex([0, 1, 2, 1, 3, 2]);
      // UV 按 bbox 归一后映射到 atlas 半幅（同正面：−x 左半幅 / +x 右半幅），凤凰点阵居中
      remapUVToRegion(sq, side < 0 ? 0 : 0.5, side < 0 ? 0.5 : 1, 0, 1);
      faceQuads.push(sq);
    }
  }
  const faceGeo = mergeQuads(faceQuads);
  for (const q of faceQuads) q.dispose();
  const faceMesh = markExternal(
    new THREE.Mesh(faceGeo, faceMat), 'r67_tail_c2_face', opts.scale, 3
  );

  // 红条：上下两簇（默认 3+2）×左右 2 侧；复用 lampRearMat ⇒ brakeLevel 联动
  // R69：条宽 stripHalfW × 0.40、y 按缩小后 span 重算，跟 face 同步收进灯内
  const stripQuads: THREE.BufferGeometry[] = [];
  const span = lampYHi - lampYLo;
  const stripHalfW = r69 ? G.stripHalfW * C2_LAMP_SHRINK_WIDTH : G.stripHalfW;
  // Phase 2b 目检：gap 0.11 时 3 条上红条占到灯顶 ~33%、压住凤凰头/翼 ⇒ 改 0.06 把
  // 上下红条压向灯顶/灯底（各约 18% / 12%），中部 v≈0.14~0.80 留给凤凰不受遮挡。
  const gap = span * 0.06;
  const ys: number[] = [];
  for (let i = 0; i < counts.top; i += 1) ys.push(lampYHi - (i + 1) * gap);
  for (let i = 0; i < counts.bottom; i += 1) ys.push(lampYLo + (i + 1) * gap);
  for (const side of [-1, 1]) {
    const cx = side * G.lampCenterX;
    for (const cy of ys) {
      stripQuads.push(makeQuad(
        cx - stripHalfW, cx + stripHalfW,
        cy - G.stripHalfH, cy + G.stripHalfH, G.stripZ
      ));
    }
  }
  const stripGeo = stripQuads.length > 0 ? mergeQuads(stripQuads) : emptyQuadGeo();
  const redStripMesh = markExternal(
    new THREE.Mesh(stripGeo, opts.lampRearMat), 'r67_tail_c2_strips', opts.scale, 4
  );

  // 恒 3 mesh / 36 tri（修正 D：零护栏改动，on/off 两态拓扑逐位一致）
  const meshes = [coverMesh, faceMesh, redStripMesh];
  const tri =
    (coverGeo.getIndex()?.count ?? coverGeo.getAttribute('position').count) / 3 +
    faceGeo.getAttribute('position').count / 3 +
    stripGeo.getAttribute('position').count / 3;

  return {
    meshes,
    coverMesh,
    faceMesh,
    redStripMesh,
    mats: [coverMat, faceMat],
    geos: [coverGeo, faceGeo, stripGeo],
    tex: texList,
    budget: {
      dc: meshes.length,
      tri,
      mat: 2,
      tex: texList.length
    }
  };
}
