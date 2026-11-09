/**
 * badgeCore.ts —— V800 前脸中央徽标「发光内芯」手写几何（R24-B）
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 接线说明（本文件只产部件 + 独占材质，不接线；接线由集成层在 V800Adapter.ts   │
 * │ R24-B 区块完成，严禁在此文件外改 Adapter / spec / 工厂 / batchMerge）        │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 外部审查（R21–R23）P2：前脸中央徽标呈「平坦米色盾形」，内部曜日纹/发光白芯
 * 未渲染，近看像挂坠。承载面是工厂组件 `shield-emblem-panel`（lamp-white，
 * 实测世界 bbox 0.060 × 0.169 × 0.024，中心 (0, 0.893, 2.433) @工厂系）。
 * 本件在其外表面贴一块**竖盾形白亮发光内芯**，把「内芯」这一层补出来。
 *
 * 几何（每材质 1 mesh；单件 tri ≤ 300）：
 *   ① 外盾板：竖盾 profile2D 挤出，厚 depth（默认 2mm）——盾座轮廓；
 *   ② 内盾芯：同一 profile 缩小 0.62 后挤出，比外盾板再外凸 RAISE（默认 1.2mm）
 *      ——读作「内芯」的立体台阶（近距下台阶边把芯从盾座里托出来）。
 *   两者 mergeSafe 成 1 个几何 / 1 个材质 / 1 个 draw call。
 *
 * ★ 只出 1 个独占材质（DC +1）。若要「盾座更暗 + 内芯更亮」的强对比读感，
 *   需再拆一个 rim 材质（再 +1 DC）—— 本轮按最小 DC 口径保留为后续项。
 *
 * 坐标 / 朝向约定：
 *   · 几何在**本件局部系**构建：profile 在 XY 平面（+X 右 / +Y 上 / +Z 外法线），
 *     挤出沿 0→depth 后整体 translate(0,0,-depth/2) 居中 ⇒ z ∈ [−d/2, +d/2]。
 *   · 因此「放置点」= 徽标外表面点 + 外法线 × 1.5mm（集成层算），
 *     内芯背面仍在徽标面外 0.5mm（不共面、不 z-fight），正面外凸 2.5mm。
 *   · ★ 朝向一律由集成层按徽标 mesh 的 **world 矩阵**实测定向（车头方向不是
 *     注释推导出来的：#assembled 世界系车头 = −Z、车尾 = +Z，与工厂系相反）。
 *
 * 几何约定（project 铁律）：
 *   · profile 绕序必须 CCW（shoelace > 0），ExtrudeGeometry 前向法线朝外；
 *     本文件 SHIELD_PROFILE 的 shoelace = +1.49（已核算）。
 *   · 实心挤出体不翻 BackSide（铁律12）→ 统一 FrontSide。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';

/* ================================================================
 * 0. 尺寸常量（世界米；改尺寸只动这里）
 * ================================================================ */

/** 默认内芯尺寸（世界米；接线层按徽标 world bbox 缩放后覆盖） */
export const BADGE_CORE_DEFAULT_SIZE = {
  width: 0.034,
  height: 0.098,
  depth: 0.002
} as const;

/** 内芯（②）相对外盾板（①）的外凸量（世界米） */
const RAISE = 0.0012;
/** 内芯轮廓相对外盾轮廓的等比缩小系数（单位空间内缩放 ⇒ 竖盾形状不变） */
const INNER_SCALE = 0.62;

/** 独占材质 id（batchMerge / 落地审查寻址用；绝不并入共享批次） */
export const BADGE_CORE_MATERIAL_IDS = {
  core: 'r24-badge-core'
} as const;

/**
 * 竖盾 profile（单位空间：x ∈ [−0.5, 0.5]、y ∈ [−0.5, 0.5]，y 向上，CCW）。
 * 造型：上缘平 + 两侧斜切肩、腰部最宽、下缘收成尖 —— 与 spec `shield-logo`
 * 「细长六边盾」同语汇。绕序 CCW（shoelace = +1.49 > 0，见头部）。
 */
const SHIELD_PROFILE: readonly (readonly [number, number])[] = [
  [0.0, -0.5], // 下尖
  [0.3, -0.3], // 右下斜
  [0.5, 0.05], // 右腰最宽
  [0.5, 0.22],
  [0.34, 0.5], // 右上肩斜切
  [-0.34, 0.5], // 左上肩斜切
  [-0.5, 0.22],
  [-0.5, 0.05], // 左腰最宽
  [-0.3, -0.3] // 左下斜
];

/* ================================================================
 * R65 · 曜日纹菱格 + MAEXTRO 发光横带（官图 G2 车标）
 * ================================================================
 * 用户 R65：前部车标应贴官图 G2「曜日纹菱形 + MAEXTRO 横带」，而非纯白盾/红旗盾。
 * 官图造型：竖向六边形（尖顶底）面板，内部上下各一半「放射状三角菱格」（曜日纹），
 *   正中一条发光横带写 MAEXTRO。整体银白发光、纹线为暗色细线。
 * 实现：程序化 Canvas 贴图（零外部图片，铁律），同时作 map + emissiveMap
 *   ⇒ 横带/菱格自发光、暗线不发光。贴图只作用于**内芯正面**（挤出体前面 UV 即
 *   profile 单位坐标，需归一到 [0,1]；侧面 UV 会被 ClampToEdge 采样到边缘色，可接受）。
 */

/** 归一几何 UV 到 [0,1]（按 position bbox），使贴图铺满正面（侧面采样边缘色）。
 * R65 实测（近距 __v800Capture）：徽标簇安装**未**绕 Y 转 π（外法线与 local+Z 同向），
 * 直接归一 UV 文字即正读；若此处翻 u 反而镜像（MAEXTRO→ORTEXAEM）。故保持正向归一。 */
function remapBadgeUV(geo: THREE.BufferGeometry): void {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (!bb) return;
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  if (!pos || !uv) return;
  const sx = bb.max.x - bb.min.x || 1;
  const sy = bb.max.y - bb.min.y || 1;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    uv.setXY(i, (x - bb.min.x) / sx, (y - bb.min.y) / sy);
  }
  uv.needsUpdate = true;
}

/** 画曜日纹菱格 + MAEXTRO 横带。无 DOM（Node/vitest）返回 null，调用方回退纯色。 */
function makeMaextroBadgeTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const W = 256, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  // 底：暗银灰（菱格之间的缝隙色）
  ctx.fillStyle = '#3a3d44';
  ctx.fillRect(0, 0, W, H);
  // 发光底色（横带区更亮）
  const bandY0 = H * 0.44, bandY1 = H * 0.56;
  // 曜日纹菱格：从中心带向上下放射的三角网格
  ctx.strokeStyle = '#e8ecf2';
  ctx.lineWidth = 2;
  const cx = W / 2;
  const rows = 9; // 上下各 9 条横线
  const cols = 7;  // 每行 7 格宽
  const cellH = (H * 0.44) / rows; // 半幅（中心带到顶/底）分 9 行
  const cellW = W / cols;
  // 上下两半放射菱格：以中心带为基准向顶/底交错
  for (let half = 0; half < 2; half++) {
    const dir = half === 0 ? -1 : 1; // -1 向上、+1 向下
    const originY = half === 0 ? bandY0 : bandY1;
    for (let r = 0; r <= rows; r++) {
      const y = originY + dir * r * cellH;
      // 交错横线（菱格上下顶点）
      ctx.beginPath();
      const inset = r * (W * 0.02); // 向顶/底略收（贴合六边收尖）
      ctx.moveTo(inset, y);
      ctx.lineTo(W - inset, y);
      ctx.stroke();
      // 斜线（菱格左右边，隔行交错）
      if (r < rows) {
        const yN = originY + dir * (r + 1) * cellH;
        for (let c = 0; c <= cols; c++) {
          const x = c * cellW;
          const xShift = (r % 2 === 0) ? cellW / 2 : 0;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(Math.min(W, Math.max(0, x - cellW / 2 + xShift)), yN);
          ctx.stroke();
        }
      }
    }
  }
  // 中央发光横带（MAEXTRO）
  const grad = ctx.createLinearGradient(0, bandY0, 0, bandY1);
  grad.addColorStop(0, '#c9ced8');
  grad.addColorStop(0.5, '#ffffff');
  grad.addColorStop(1, '#c9ced8');
  ctx.fillStyle = grad;
  ctx.fillRect(0, bandY0, W, bandY1 - bandY0);
  // MAEXTRO 字样（暗色，居中）
  ctx.fillStyle = '#1a1c22';
  ctx.font = 'bold 44px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('MAEXTRO', cx, (bandY0 + bandY1) / 2 + 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/* ================================================================
 * 1. 对外类型
 * ================================================================ */

export interface BadgeCoreMaterials {
  /** 发光内芯（白亮 emissive，独占） */
  core: THREE.MeshStandardMaterial;
}

export interface BadgeCoreOptions {
  /** 外盾板宽（世界米，X） */
  width?: number;
  /** 外盾板高（世界米，Y） */
  height?: number;
  /** 外盾板厚（世界米，Z） */
  depth?: number;
  /** 复用外部材质实例（接线层左右/整组共用同一份，避免重复 DC） */
  materials?: BadgeCoreMaterials;
}

export interface BadgeCoreResult {
  /** 局部系原点 = 盾形几何中心（z 居中），由集成层摆到徽标外表面 */
  group: THREE.Group;
  /** 独占材质 */
  materials: BadgeCoreMaterials;
  /** 本件三角形总数 */
  triangleCount: number;
}

/* ================================================================
 * 2. profile / 挤出辅助（CCW，同 headLamp / tailLamp）
 * ================================================================ */

/** 单位 profile → 目标尺寸的 Shape（CCW 绕序保持） */
function shieldShape(w: number, h: number, scale: number): THREE.Shape {
  const s = new THREE.Shape();
  SHIELD_PROFILE.forEach(([ux, uy], i) => {
    const x = ux * w * scale;
    const y = uy * h * scale;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  });
  s.closePath();
  return s;
}

/** 挤出 0→depth 后把厚轴居中到原点（z ∈ [−d/2, +d/2]） */
function extrudeCentered(shape: THREE.Shape, depth: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1
  });
  g.translate(0, 0, -depth / 2);
  g.computeBoundingBox();
  return g;
}

/* ================================================================
 * 3. 部件几何：外盾板 + 外凸内盾芯（合并 1 mesh）
 * ================================================================ */

function buildBadgeCoreGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  // ① 外盾板：z ∈ [−d/2, +d/2]
  const outer = extrudeCentered(shieldShape(w, h, 1), d);
  // ② 内盾芯：等比缩小后，正面比外盾板再外凸 RAISE
  const innerDepth = d + RAISE;
  const inner = extrudeCentered(shieldShape(w, h, INNER_SCALE), innerDepth);
  inner.translate(0, 0, RAISE / 2); // 背面与外盾板背面齐平，正面外凸 RAISE
  const merged = mergeSafe([outer, inner]);
  // R65：UV 归一到 [0,1] ⇒ 曜日纹贴图铺满正面（侧面 ClampToEdge 采样边缘色）
  remapBadgeUV(merged);
  merged.computeBoundingBox();
  return merged;
}

/* ================================================================
 * 4. 独占材质工厂（零外部图片；id 全 r24-badge-core）
 * ================================================================ */

export function createBadgeCoreMaterials(): BadgeCoreMaterials {
  // R65：曜日纹菱格 + MAEXTRO 横带贴图，同时作 map（固有色）与 emissiveMap（自发光）
  // ⇒ 菱格亮线与横带发光、缝隙暗色不发光，复现官图 G2 银白发光车标。
  // 无 DOM（Node/vitest）⇒ badgeTex=null，回退纯白发光（与 R64 前观感一致）。
  const badgeTex = makeMaextroBadgeTexture();
  const core = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: badgeTex ?? undefined,
    emissive: 0xffffff,
    emissiveMap: badgeTex ?? undefined,
    emissiveIntensity: badgeTex ? 1.6 : 2.2,
    metalness: 0.1,
    roughness: 0.35,
    side: THREE.FrontSide // 实心挤出体不翻 BackSide（铁律12）
  });
  core.userData.sculptMaterial = { id: BADGE_CORE_MATERIAL_IDS.core };
  core.name = BADGE_CORE_MATERIAL_IDS.core;
  return { core };
}

/* ================================================================
 * 5. 主构造
 * ================================================================ */

export function createBadgeCore(options: BadgeCoreOptions = {}): BadgeCoreResult {
  const w = options.width ?? BADGE_CORE_DEFAULT_SIZE.width;
  const h = options.height ?? BADGE_CORE_DEFAULT_SIZE.height;
  const d = options.depth ?? BADGE_CORE_DEFAULT_SIZE.depth;
  const materials = options.materials ?? createBadgeCoreMaterials();

  const geo = buildBadgeCoreGeometry(w, h, d);
  const mesh = new THREE.Mesh(geo, materials.core);
  mesh.name = 'badge-core-mesh';
  mesh.castShadow = false; // 自发光面片：不参与阴影，省一趟 shadow pass
  mesh.receiveShadow = false;

  const group = new THREE.Group();
  group.name = 'badge-core';
  group.userData.sculptComponent = { id: 'badge-core' };
  group.add(mesh);

  const g = mesh.geometry;
  const triangleCount = g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
  group.updateMatrixWorld(true);

  return { group, materials, triangleCount };
}
