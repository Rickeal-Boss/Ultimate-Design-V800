/**
 * r7TailWrap.ts —— R68 · R7 外部高精度壳「尾灯包裹 / 缩小 / 侧贴」程序化重建（零副作用纯模块）
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ 本模块**只依赖 three + 纯函数/常量**：禁 import ExternalShell / Adapter / config。 │
 * │   装配由 ExternalShell.ts 的 `car === 'r7'` 分支完成，本文件不接线、不改既有字面量。 │
 * └──────────────────────────────────────────────────────────────────────────────────┘
 *
 * ══ 定罪背景（开发线 Phase 1 GLB 直读实测）══════════════════════════════════════
 *  · `src/assets/cars/r7/lamp_rear.glb` 单 mesh 14,333 tri，局部
 *    x[-0.2107,0.2101] / y[0.2200,0.2600] / z[-0.5739,-0.5529]、materials/textures 全 0。
 *  · 按 x 分 48 桶：**b13..b34 共 22 桶零顶点** ⇒ 中央实缺口
 *    x∈[-0.0967,0.0962] local = 世界 [-0.418,+0.416] m、宽 **0.834 m**；
 *    上边缘顶点抖动 4.64mm local = **20.06mm 世界** ⇒ 「红色碎裂片 / 漏洞」是纯几何层破面，
 *    与 UV/贴图无关（同 R67 V800 的 17,485 tri jagged 横带定罪）。
 *  · 用户口径：三个黑色方形模块组合包住漏洞区域；尾灯稍微缩小；侧面也贴同样尾灯掩盖漏洞。
 *
 * ══ 三套坐标系（⚠ 禁混）════════════════════════════════════════════════════════
 *  · 本模块全部几何写 **装配局部「世界米」**：R7 分支新建 mesh 挂在 `body` 组下，
 *    `body` 只有 rotY(π)、**没有 scale** ⇒ 不设 `mesh.scale`（R47 铁律：scale 只缩顶点）。
 *  · GLB 语义件 `lamp_rear` 是「模型单位 × manifest.scale=4.323」；V800 C2 的
 *    tailLampC2.ts 又是「GLB 局部 + mesh.scale.setScalar(4.75)」——两者都不可照抄。
 *  · 尺寸真源：`opts.bodyMaxZ = manifest.bodyBBox.max[2] * scale`（R7 = 2.5194 m），
 *    `opts.bodyHalfWidth = manifest.bodyBBox.max[0] * scale`（R7 ≈ 1.1127 m）。
 *
 * ══ 三机位裁量（主理人 R68 派单）══════════════════════════════════════════════
 *  · 三模块取「左 / 中 / 右」横向一排（不是「左/上/下」Π 形）：缺口实测是
 *    **0.834 m 宽 × 0.173 m 高**的横向扁孔，Π 形会把正中段完全暴露；横向三连
 *    每块 0.278 m 见方恰好铺满 0.834 m。视觉模型分歧按车身轮廓裁量，目检交 Phase 3。
 *  · z 基准按修正 B 重定：默认路径最外层可见件是 `lamp_rear_band` 的 `-0.5885*s =
 *    2.54409 m`（不是 R49 分支的 `bodyMaxZ+0.010=2.52949`）；三黑模块内缩 12mm 落
 *    `−2.53209`，缩小尾灯带落 `−2.54409`（与原 band 同平面，原 band 已从出口移除）。
 *    缺口区本就零 lamp_rear 顶点 ⇒ 不会被灯带挡住。
 *  · 缩小尾灯：新增并行 `r68_r7_tail_band`（1.86 × 0.75 = 1.395 m）复用 `lampRearMat`
 *    ⇒ 刹车联动零改动；**不改** R49/R51 既有 `lamp_rear_band` / `housing` 任何字面量
 *    （r48_lamp / r49_visual / r51_visual / r67_tail_c2 四套护栏逐字钉死）。
 *  · 侧贴：左右各 1 quad，共享调用方传入的 atlas（与 R49 同一张 CanvasTexture），
 *    UV 必须走 `remapUVToRegion` 按 mesh 自身 UV bbox 归一（禁线性 remap，R4 #uvassert 教训）。
 *
 * ══ 回滚 ══════════════════════════════════════════════════════════════════════
 *  `#r68r7tail=off` ⇒ 调用方不建本模块、不过滤出口数组 ⇒ 逐位回 R51/R48 基线。
 *  隐藏语义件必须**从 `lampMeshes` 出口数组 filter**（V800Adapter:4779 / R7Adapter:1413
 *  的 `sm.visible = !interior` 每帧复位壳侧 `visible=false`）。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';

/* ══════════════════════ 1. 对外常量（装配局部 = 世界米）══════════════════════ */

export const R7_TAIL_WRAP_GEOM = {
  /** 中央缺口半宽（世界 m）：0.834 / 2 */
  gapHalfW: 0.417,
  /** 单个黑色方模块边长（世界 m）：R80 由 0.278 → 0.30，三连 = 0.90（±0.45, 缺口 ±0.417
   *  ⇒ 每侧多盖 33mm，把 GLB 非流形边抖动带压进黑面下） */
  moduleSize: 0.30,
  /** 尾灯带中心高（世界 m）：R7 默认 coverY = 0.240 × 4.323 = 1.0375 */
  bandY: 1.0375,
  /** R7 既有 `lamp_rear_band` 高（世界 m），缩小版沿用 */
  bandHeight: 0.055,
  /** R7 既有 `lamp_rear_band` 宽（世界 m） */
  bandWidthBase: 1.86,
  /** 用户「稍微缩小」基准（主理人官图标定 1:4.5–5 竖灯比例后取 0.75） */
  shrink: 0.75,
  /** 侧贴灯：距车尾的 z（世界 m） */
  sideZ: -2.44,
  /** 侧贴灯：沿 z 的宽 / 沿 y 的高（世界 m） */
  sideW: 0.20,
  sideH: 0.12
} as const;

/**
 * R7 默认 R48 分支 `lamp_rear_band` 的 z 系数（`ExternalShell.ts:2515` 的 `-0.5885 * s`）。
 * 修正 B 实证（`R51_BAND_ON` 默认 false ⇒ 走 `r49Hole=false`）：
 *   · 默认路径**最外层可见尾灯件** = 0.5885 × 4.323 = **2.54409 m**；
 *   · `bodyMaxZ+0.010` = 2.52949 是 R49/R51 分支值，比默认 band **内缩 14.60mm**、
 *     比自遮挡不可见的 housing(2.505) **外凸 24.49mm** ⇒ 会读作「前浮/悬空」（R49 教训②重演）。
 * ⇒ 本波以 2.54409 为唯一 z 基准，不再用 bodyMaxZ+0.010。
 */
export const R7_TAIL_BAND_Z_COEFF = 0.5885;
/** 三黑模块相对默认可见最外层的内缩量（m）：读作灯罩内构件，不「前浮」。 */
export const R7_WRAP_MODULE_INSET_M = 0.012;
/** 相对尾门基准面（bodyMaxZ）的最小外凸量（m），防被 body 自遮挡（R49 教训②）。 */
export const R7_WRAP_MIN_OUT_M = 0.006;

/* ══════════════════════ 2. quad 构造 ══════════════════════ */

/** 朝 −Z（车尾外侧）的 quad：顶点序 左上/右上/左下/右下 ⇒ 叉积恒 −Z。 */
function tailQuad(x0: number, x1: number, y0: number, y1: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    x0, y1, z, x1, y1, z, x0, y0, z, x1, y0, z
  ], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1
  ], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  return g;
}

/**
 * 朝 ±X（车身侧面）的 quad：`side = +1` 法线 +X、`side = −1` 法线 −X。
 * u 沿 z（车尾→车头），v 沿 y（下→上）。
 */
function sideQuad(
  side: 1 | -1, x: number, z0: number, z1: number, y0: number, y1: number
): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // 顶点序使 (0,1,2) 叉积指向 side·X
  if (side > 0) {
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      x, y1, z0, x, y1, z1, x, y0, z0, x, y0, z1
    ], 3));
  } else {
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      x, y1, z1, x, y1, z0, x, y0, z1, x, y0, z0
    ], 3));
  }
  const n = side;
  g.setAttribute('normal', new THREE.Float32BufferAttribute([
    n, 0, 0, n, 0, 0, n, 0, 0, n, 0, 0
  ], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  return g;
}

/** tri 口径统一：indexed 用 index.count/3，non-indexed 用 position.count/3。
 *  ⚠ mergeSafe 产物恒 non-indexed，但直接新建的 quad 是 indexed（4 顶点 / 6 索引）
 *    ⇒ 直接 position.count/3 会把 2 tri 误算成 1.333 tri。 */
function triOf(g: THREE.BufferGeometry): number {
  return (g.getIndex()?.count ?? g.getAttribute('position').count) / 3;
}

function marked(mesh: THREE.Mesh, name: string, renderOrder: number): THREE.Mesh {
  mesh.name = name;
  // R57/R59 铁律：setExteriorHidden / setCabinBlocksHidden / buildPokeList 三条遍历统一跳过
  (mesh.userData as { r44External?: boolean }).r44External = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  mesh.renderOrder = renderOrder;
  return mesh;
}

/* ══════════════════════ 3. 对外装配 ══════════════════════ */

export interface R7TailWrapOptions {
  /** manifest.scale（R7 = 4.323）；本模块只用其做账本回报，不缩放几何 */
  scale: number;
  /** manifest.bodyBBox.max[2] * scale（R7 = 2.5194 m） */
  bodyMaxZ: number;
  /** manifest.bodyBBox.max[0] * scale（R7 ≈ 1.1127 m） */
  bodyHalfWidth: number;
  /** 复用同一实例 ⇒ 适配器 update() 每帧 emissiveIntensity 联动 */
  lampRearMat: THREE.Material;
  /** 与 R49 盖板共享的同一张 CanvasTexture（Node 无 DOM 时为 null ⇒ 优雅降级） */
  atlasTex?: THREE.Texture | null;
  /** 缩小基准，缺省 0.75 */
  shrink?: number;
}

export interface R7TailWrapResult {
  /** 恒 3 个 mesh：黑色模块 / 缩小尾灯带 / 侧贴灯 */
  meshes: THREE.Mesh[];
  /** 本模块新建的材质（不含复用的 lampRearMat） */
  mats: THREE.Material[];
  geos: THREE.BufferGeometry[];
  /** 由调用方创建并传入的贴图不在此登记（调用方账本负责释放） */
  tex: THREE.Texture[];
  budget: { dc: number; tri: number; mat: number; tex: number };
}

/** 构建「三黑模块 + 缩小尾灯带 + 双侧贴灯」。纯装配，零 DOM 读。 */
export function buildR7TailWrap(opts: R7TailWrapOptions): R7TailWrapResult {
  const G = R7_TAIL_WRAP_GEOM;
  const k = opts.shrink ?? G.shrink;
  // 修正 B：以「默认路径实际可见尾灯最外层」为基准，而非 R49 分支的 bodyMaxZ+0.010。
  //   bandPlane = 0.5885*s = 2.54409 m；modulePlane = bandPlane − 12mm = 2.53209 m
  //   ⇒ 比尾门 2.51949 外凸 12.6mm（不自遮挡）、比可见 band 内缩 12mm（不前浮）、
  //     落在 lamp_rear GLB 腔深（外面 2.54097）之内 8.9mm（读作灯罩内构件）。
  const tailSurface = opts.bodyMaxZ;
  const bandPlane = R7_TAIL_BAND_Z_COEFF * opts.scale;
  const modulePlane = Math.max(
    bandPlane - R7_WRAP_MODULE_INSET_M,
    tailSurface + R7_WRAP_MIN_OUT_M
  );
  const zModules = -modulePlane;
  const zBand = -bandPlane;

  // ① 三黑方模块：横向左 / 中 / 右，铺满中央缺口并**向左右各外扩 33mm**（R80）。
  //   缺口实测 ±0.417（b13..b34 零顶点段），模块行现覆盖 ±0.45 ⇒ 每侧多盖 33mm，
  //   把 GLB 非流形边（上边缘抖动 20.06mm 世界）也压进黑面之下，不再露锯齿。
  const moduleGeos: THREE.BufferGeometry[] = [];
  const s = G.moduleSize;
  for (const cx of [-s, 0, s]) {
    moduleGeos.push(tailQuad(cx - s / 2, cx + s / 2, G.bandY - s / 2, G.bandY + s / 2, zModules));
  }
  const moduleGeo = mergeSafe(moduleGeos);
  for (const g of moduleGeos) g.dispose();
  const moduleMat = new THREE.MeshStandardMaterial({
    color: 0x14141a,
    roughness: 0.70,
    metalness: 0.06,
    side: THREE.FrontSide
  });
  const moduleMesh = marked(
    new THREE.Mesh(moduleGeo, moduleMat), 'r68_r7_tail_modules', 5
  );

  // ①b 四边封边（R69 上下两条 → R80 升级为**完整矩形框**）
  //   用户 11-13 截图：上下封边后仍从左右两侧与转角透出米色菱格 + 白色锯齿。
  //   改为「上下两条横向封边 + 左右两条竖向封边」，四条同材质、同 z 平面、接缝重叠 2mm
  //   ⇒ 中央缺口被围成完全封闭的矩形包裹。
  const edgeH = 0.06;
  const edgeGeos: THREE.BufferGeometry[] = [];
  const edgeX0 = -s * 1.5;
  const edgeX1 = s * 1.5;
  const edgeY0 = G.bandY - s / 2 - edgeH;
  const edgeY1 = G.bandY + s / 2 + edgeH;
  edgeGeos.push(tailQuad(edgeX0, edgeX1, G.bandY + s / 2 - 0.002, G.bandY + s / 2 + edgeH, zModules));
  edgeGeos.push(tailQuad(edgeX0, edgeX1, edgeY0, G.bandY - s / 2 + 0.002, zModules));
  // 左右竖封边：宽度 0.06，纵向覆盖 上封边上沿→下封边下沿（含 2mm 搭接）
  edgeGeos.push(tailQuad(edgeX0, edgeX0 + edgeH, edgeY0, edgeY1, zModules));
  edgeGeos.push(tailQuad(edgeX1 - edgeH, edgeX1, edgeY0, edgeY1, zModules));
  const edgeGeo = mergeSafe(edgeGeos);
  for (const g of edgeGeos) g.dispose();
  const edgeMesh = marked(
    new THREE.Mesh(edgeGeo, moduleMat), 'r68_r7_tail_edge', 5
  );

  // ② 缩小尾灯带：复用 lampRearMat ⇒ brakeLevel 联动零改动
  const bandW = G.bandWidthBase * k;
  const bandGeo = tailQuad(-bandW / 2, bandW / 2, G.bandY - G.bandHeight / 2, G.bandY + G.bandHeight / 2, zBand);
  const bandMesh = marked(
    new THREE.Mesh(bandGeo, opts.lampRearMat), 'r68_r7_tail_band', 6
  );

  // ③ 侧贴（R80 默认**关闭**）
  //   用户 11-13 真机截图定罪：R69 的黑色侧贴 quad 在 x=±(bodyHalfWidth−0.06)=±1.0527、
  //   z=−2.44 处读作「车轮外侧悬着的一块黑底红条方片」，且把同机位本该完整的
  //   `lamp_rear_band` 遮掉了一截 ⇒ 侧贴这个补丁本身制造了新的穿帮。
  //   裁决：默认不建侧贴（尾灯包裹交给 ①/①b 的封闭矩形框）。`#r80r7side=on` 可恢复
  //   R69 旧侧贴供 A/B 对照。
  /* ── R81 P0-1 · 默认分支彻底不建 sideMesh / sideGeo ─────────────────────────
   * R80 虽然把侧贴从 meshes 里摘掉，但仍无条件 `mergeSafe(sideQuads)`（空数组）、
   * 无条件 `new Mesh(空 geometry)` 并把空 geometry 塞进 geos ⇒ mergeGeometries([]) 抛
   * TypeError ⇒ loadExternalShell catch 把 r44ShellStatus 置 failed ⇒ R66-D 原子回滚
   * ⇒ 默认路径只剩 82 件程序化低模（用户「R7 无法进入」）。
   * 修：默认分支不创建 sideQuads / sideGeo / sideMesh，geos 只放 module/edge/band；
   *   tri 与 dc 沿用现有三元式（与 R80 交接文档「撤侧贴后少 1 DC、少 4 tri」对齐）。
   * 与 src/util/geo.ts 的 mergeSafe 空数组防御构成双保险（别的 parts 也可能踩）。
   * 回滚：`#r81r7sideskip=off` ⇒ 逐位回 R80 旧路径（仍建空 sideGeo 并入 geos，A/B
   *   验证「空 geometry 是否入账本」这一唯一变量）。 */
  const R81_R7_SIDE_SKIP: boolean =
    typeof window === 'undefined' || !/(?:^|[#&])r81r7sideskip=off/i.test(window.location.hash);
  const R80_R7_SIDE_ON =
    typeof window !== 'undefined' && /(?:^|[#&])r80r7side=on/i.test(window.location.hash);
  let sideGeo: THREE.BufferGeometry | null = null;
  let sideMesh: THREE.Mesh | null = null;
  if (R80_R7_SIDE_ON || !R81_R7_SIDE_SKIP) {
    const sideQuads: THREE.BufferGeometry[] = [];
    if (R80_R7_SIDE_ON) {
      for (const side of [-1, 1] as const) {
        const x = side * (opts.bodyHalfWidth - 0.06);
        const q = sideQuad(
          side, x, G.sideZ - G.sideW / 2, G.sideZ + G.sideW / 2,
          G.bandY - G.sideH / 2, G.bandY + G.sideH / 2
        );
        sideQuads.push(q);
      }
    }
    sideGeo = mergeSafe(sideQuads);
    for (const q of sideQuads) q.dispose();
    sideMesh = marked(new THREE.Mesh(sideGeo, moduleMat), 'r68_r7_tail_side', 4);
  }

  const meshes: THREE.Mesh[] = [moduleMesh, edgeMesh, bandMesh];
  if (R80_R7_SIDE_ON && sideMesh) meshes.push(sideMesh);
  const tri = triOf(moduleGeo) + triOf(edgeGeo) + triOf(bandGeo) +
    (R80_R7_SIDE_ON && sideGeo ? triOf(sideGeo) : 0);

  return {
    meshes,
    mats: [moduleMat],
    geos: sideGeo
      ? [moduleGeo, edgeGeo, bandGeo, sideGeo]
      : [moduleGeo, edgeGeo, bandGeo],
    tex: [],
    budget: {
      dc: meshes.length,
      tri,
      mat: 1,
      tex: 0
    }
  };
}
