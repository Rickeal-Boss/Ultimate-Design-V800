/**
 * roofPod.ts —— V800 车顶前部激光雷达 pod 手写几何（R23-C）
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 接线说明（本文件只产部件 + 材质，不接线；接线由集成层在 V800Adapter.ts      │
 * │ R23-C 区块完成，严禁在此文件外改 Adapter / spec / 工厂）                    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 目标替换 / 隐藏组件（实测场景树，python 遍历 .img2threejs/object-sculpt-spec.json
 * componentTree 全 185 件，含 roof/top/sensor/lidar/pod 关键字命中列表）：
 *   lidar-wedge        激光雷达楔形块   parent=root   pos[0,1.78,0.35]
 *                       scale[0.14,0.045,0.3]  dim 0.17×0.05×0.32  matte-black
 *                       rotation[0.1,0,0]   → world bbox ≈
 *                       x[-0.085,0.085]  y[1.755,1.805]  z[0.19,0.51]
 *   （其余命中件：roof-panel / roof-rails / roof-spoiler / sunroof-glass /
 *    headliner-* / overhead-console / starlight-headliner / ambient-strip-* /
 *    taillamp-bar-top-* —— 均非车顶前部传感器，仅 roof-rails(1.847) /
 *    sunroof-glass(1.836) / windshield(1.82) 用作「车顶面高度」探针锚点。）
 *
 * ★ 占位件 lidar-wedge 与参考图设计位置不符：它在车顶**中部**（z=+0.35），且尺寸
 *   偏小（0.17×0.05×0.32）；参考图视觉分析（车头 +Z、鼻尖 z≈+2.72、L=5.44）要求
 *   的激光雷达 pod 在「挡风玻璃正上方车顶前缘」——纵向中心 0.09L → spec local
 *   z≈+2.23。故本件按参考坐标构建为**附加件**（挂 root），主理人接线时：
 *     1) 隐藏 lidar-wedge（visible=false，或移出批次）；
 *     2) 把本 group 挂 root，position 用 ROOF_POD_POSITION（见下「⚠️ 坐标框」）。
 *
 * ⚠️ 坐标框（重要，已与团队主理人核对口径）：
 *   任务书给的参考坐标是 z≈+2.23（0.09L 照片测量）。但 python 探针实测 spec 模型：
 *     车顶 / 座舱顶（windshield 顶 z≈+1.13±0.43 ⇒ 顶到 z≈+1.56；
 *     roof-panel 深 3.36 居中 z=0 ⇒ 前缘 z≈+1.68；roof-rails/sunroof y≈1.84）。
 *   即 spec 模型里 z>+1.68 已是风挡前 / 引擎盖（cowl-panel z+1.54 y1.10、
 *   front-end z+2.33 y0.86）——z=+2.23 处车身面约 y0.86~1.10，pod 会**悬在引擎盖
 *   上方约 0.7m**。本文件默认仍按任务书字面 ROOF_POD_POSITION=[0,1.82,2.23] 交付，
 *   但提供经 spec 框校正的位置常量 ROOF_POD_POSITION_SPEC_FRAME=[0,1.82,1.65]
 *   （落在真实「风挡上方车顶前缘」）。请主理人落地 QA 目视后二选一改一处即可。
 *   y=1.82 为任务书 fallback（探到的车顶面锚点 1.78~1.85 区间内，取顶沿）。
 *
 * 几何约定（与 project 铁律一致）：
 *   · 圆角矩形 profile 弧段**锁死 4 段**（每 90° 角 4 条折线，无 absarc/curveSegments
 *     歧义——显式 lineTo 点列，保证每角恰 4 facet，避免帽沿硬边暴增）；
 *   · profile 绕序 CCW（shoelace>0），ExtrudeGeometry 前向法线朝外；
 *   · 挤出沿 +z(0→depth) 后 rotateX(-π/2) 立起：depth→世界 +Y（高）、
 *     shape-Y(长 0.22)→世界 ∓Z（车前后）、shape-X(宽 0.20)→世界 X（车左右）；
 *   · 车头 = +Z，**勿 rotY(π)**（它不是车尾件）；group 默认 rotation=[0,0,0]；
 *   · 垫高式：基座（matte）占高 ~60% + 薄传感器罩（matte）~40%，顶面内嵌黑色
 *     玻璃窗口（roofPodGlass，roughness 0.2）；顶面平顶（2–3° 微斜按任务书「可忽略」
 *     省略，避免高度预算超 0.055m）。
 *
 * 预算（tri ≤ 800）：基座 ~76 + 罩 ~76（mergeSafe 合成 1 个 matte mesh） +
 *   玻璃面板 ~18 ≈ **170 tri**（traverse 实测见 triangleCount）。
 *
 * 独占材质（铁律 8）：2 个 id 全 r23-roof-pod-*，不得并入全车共享批次（否则按材质
 *   实例入批后材质改名不可寻址）；本 group 须进 batchMergeStatic 的 excludeObjects。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';

/* ================================================================
 * 0. 局部系常量（改尺寸 / 位置只动这里）
 * ================================================================ */

/** 基座宽（X，车左右）≈ 0.20m */
export const POD_W = 0.2;
/** 基座长（Z，车前后）≈ 0.22m（0.04L） */
export const POD_L = 0.22;
/** 基座圆角半径 */
export const POD_R = 0.035;
/** 基座高（占高 ~60%） */
export const POD_BASE_H = 0.033;
/** 传感器罩宽（略小于基座） */
export const CAP_W = 0.16;
/** 传感器罩长 */
export const CAP_L = 0.18;
/** 传感器罩圆角半径 */
export const CAP_R = 0.03;
/** 传感器罩高（占高 ~40%） */
export const CAP_H = 0.022;
/** 圆角每角折线段数（铁律：锁 4） */
export const CORNER_SEGS = 4;
/** 顶面玻璃窗口内嵌下凹量（防共面闪烁） */
export const GLASS_INSET = 0.001;

/**
 * 默认挂载位置（任务书字面参考坐标 z≈+2.23）。
 * ⚠️ 见头部「坐标框」：spec 模型里此 z 落在引擎盖上方，会悬空；请主理人按
 * ROOF_POD_POSITION_SPEC_FRAME 校正或落地 QA 后微调。
 */
export const ROOF_POD_POSITION: [number, number, number] = [0, 1.82, 2.23];

/** spec 模型框校正位置：真实「风挡上方车顶前缘」（落在车顶，不悬空） */
export const ROOF_POD_POSITION_SPEC_FRAME: [number, number, number] = [0, 1.82, 1.65];

/** 本部件整组替换 / 隐藏的旧组件 id（接线遍历 / 排除名单用） */
export const ROOF_POD_REPLACE_IDS = ['lidar-wedge'] as const;

/** 独占材质 id（batchMerge / 落地审查寻址用） */
export const ROOF_POD_MATERIAL_IDS = {
  matte: 'r23-roof-pod-matte',
  glass: 'r23-roof-pod-glass'
} as const;

/* ================================================================
 * 1. 对外类型
 * ================================================================ */

export interface RoofPodMaterials {
  /** 整体哑光黑罩体（独占） */
  matte: THREE.MeshStandardMaterial;
  /** 顶面内嵌黑色玻璃窗口（独占，roughness 0.2） */
  glass: THREE.MeshStandardMaterial;
}

export interface RoofPodOptions {
  /** 世界挂载位置（默认 ROOF_POD_POSITION，见头部坐标框） */
  position?: [number, number, number];
  /** 整组旋转（默认 [0,0,0]；车头 +Z，勿 rotY(π)） */
  rotation?: [number, number, number];
  /** 复用外部材质实例（接线时若需 4 视角共用可传） */
  materials?: RoofPodMaterials;
}

export interface RoofPodResult {
  /** 局部系：基座底面在 y=0，沿 +Y 立起；长沿 Z、宽沿 X；居中 x=0,z=0。
   *  接线只需给 group.position（与可选 rotation）。 */
  group: THREE.Group;
  /** 本部件用到的 2 个独占材质 */
  materials: RoofPodMaterials;
  /** 本件三角形总数（traverse 实测） */
  triangleCount: number;
}

/* ================================================================
 * 2. 形状 / 挤出辅助（圆角矩形显式点列，弧段锁 4）
 * ================================================================ */

/** 圆角矩形轮廓点列（CCW，中心原点；x=宽、y=长），每 90° 角恰 cornerSegs 段折线 */
function roundedRectPoints(w: number, l: number, r: number, seg: number): Array<[number, number]> {
  const hw = w / 2;
  const hl = l / 2;
  const pts: Array<[number, number]> = [];
  // 起始：底边左端 = 左下角 end 切线点
  pts.push([-hw + r, -hl]);
  // 底边 → 右下角 start 切线点
  pts.push([hw - r, -hl]);
  // 右下角：-90°→0°
  for (let k = 1; k <= seg; k += 1) {
    const a = -Math.PI / 2 + (Math.PI / 2) * (k / seg);
    pts.push([hw - r + r * Math.cos(a), -hl + r + r * Math.sin(a)]);
  }
  // 右边 → 右上角 start 切线点
  pts.push([hw, hl - r]);
  // 右上角：0°→90°
  for (let k = 1; k <= seg; k += 1) {
    const a = 0 + (Math.PI / 2) * (k / seg);
    pts.push([hw - r + r * Math.cos(a), hl - r + r * Math.sin(a)]);
  }
  // 顶边 → 左上角 start 切线点
  pts.push([-hw + r, hl]);
  // 左上角：90°→180°
  for (let k = 1; k <= seg; k += 1) {
    const a = Math.PI / 2 + (Math.PI / 2) * (k / seg);
    pts.push([-hw + r + r * Math.cos(a), hl - r + r * Math.sin(a)]);
  }
  // 左边 → 左下角 start 切线点
  pts.push([-hw, -hl + r]);
  // 左下角：180°→270°（不 emit 末点，与起始点重合 → 闭合去重）
  for (let k = 1; k < seg; k += 1) {
    const a = Math.PI + (Math.PI / 2) * (k / seg);
    pts.push([-hw + r + r * Math.cos(a), -hl + r + r * Math.sin(a)]);
  }
  return pts;
}

/** 由显式点列构建 CCW 闭合 Shape */
function roundedRectShape(w: number, l: number, r: number, seg: number): THREE.Shape {
  const pts = roundedRectPoints(w, l, r, seg);
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  return shape;
}

/**
 * 立起的圆角矩形板：shape(X=宽, Y=长) 沿 +Z 挤出 depth(=高)，再 rotateX(-π/2)
 * 使挤出方向→世界 +Y（高）、shape-Y(长)→世界 ∓Z（车前后）。底面落在 y=0。
 */
function standingSlab(w: number, l: number, r: number, h: number, seg: number): THREE.BufferGeometry {
  const shape = roundedRectShape(w, l, r, seg);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: h,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1
  });
  g.rotateX(-Math.PI / 2);
  g.computeBoundingBox();
  return g;
}

/** 顶面内嵌玻璃面板（平躺于 XZ 平面，法线 +Y），置于 y=topY-GLASS_INSET */
function glassPanel(w: number, l: number, r: number, topY: number, seg: number): THREE.BufferGeometry {
  const shape = roundedRectShape(w, l, r, seg);
  const g = new THREE.ShapeGeometry(shape, 1);
  g.rotateX(-Math.PI / 2);
  g.translate(0, topY - GLASS_INSET, 0);
  g.computeBoundingBox();
  return g;
}

/* ================================================================
 * 3. 独占材质工厂（零外部图片；id 全 r23-roof-pod-*）
 * ================================================================ */

export function createRoofPodMaterials(): RoofPodMaterials {
  const mk = (
    id: string,
    params: THREE.MeshStandardMaterialParameters
  ): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...params });
    m.userData.sculptMaterial = { id };
    m.name = id;
    return m;
  };
  return {
    // 整体哑光黑（任务书：roughness≈0.85 / metalness≈0.1 / #0a0a0c，无镀铬无自发光）
    matte: mk(ROOF_POD_MATERIAL_IDS.matte, {
      color: 0x0a0a0c,
      roughness: 0.85,
      metalness: 0.1
    }),
    // 顶面内嵌黑色玻璃窗口（任务书可选：更亮的黑色玻璃，roughness 0.2）
    glass: mk(ROOF_POD_MATERIAL_IDS.glass, {
      color: 0x060608,
      roughness: 0.2,
      metalness: 0.0,
      envMapIntensity: 1.0
    })
  };
}

/* ================================================================
 * 4. 主构造
 * ================================================================ */

export function createRoofPod(options: RoofPodOptions = {}): THREE.Group {
  const mats = options.materials ?? createRoofPodMaterials();
  const group = new THREE.Group();
  group.name = 'r23-roof-pod';

  /* ---- 4.1 基座（matte，y 0..POD_BASE_H）---- */
  const baseGeo = standingSlab(POD_W, POD_L, POD_R, POD_BASE_H, CORNER_SEGS);

  /* ---- 4.2 传感器罩（matte，叠在基座顶，y POD_BASE_H..POD_BASE_H+CAP_H）---- */
  const capGeo = standingSlab(CAP_W, CAP_L, CAP_R, CAP_H, CORNER_SEGS);
  capGeo.translate(0, POD_BASE_H, 0);

  /* ---- 4.3 基座 + 罩 合成 1 个 matte mesh（合批按材质实例分桶）---- */
  const bodyGeo = mergeSafe([baseGeo, capGeo]);

  /* ---- 4.4 顶面玻璃窗口（glass，内嵌于罩顶）---- */
  const glassGeo = glassPanel(CAP_W - 0.04, CAP_L - 0.04, CAP_R * 0.7, POD_BASE_H + CAP_H, CORNER_SEGS);

  /* ---- 4.5 装配：每材质 1 mesh ---- */
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string): void => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  add(bodyGeo, mats.matte, ROOF_POD_MATERIAL_IDS.matte);
  add(glassGeo, mats.glass, ROOF_POD_MATERIAL_IDS.glass);

  /* ---- 4.6 挂载位姿（局部系原点即基座底面中心）---- */
  const pos = options.position ?? ROOF_POD_POSITION;
  group.position.set(pos[0], pos[1], pos[2]);
  const rot = options.rotation ?? [0, 0, 0];
  group.rotation.set(rot[0], rot[1], rot[2]);

  /* ---- 4.7 tri 统计 ---- */
  let triangleCount = 0;
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    triangleCount += g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
  });
  group.updateMatrixWorld(true);

  group.userData.sculptComponent = { id: group.name };
  group.userData.r23RoofPod = {
    triangleCount,
    materialIds: ROOF_POD_MATERIAL_IDS,
    replaceIds: ROOF_POD_REPLACE_IDS
  };
  return group;
}

/** 需要 materials / tri 数时用它（等价 createRoofPod + 回收统计） */
export function createRoofPodResult(options: RoofPodOptions = {}): RoofPodResult {
  const materials = options.materials ?? createRoofPodMaterials();
  const group = createRoofPod({ ...options, materials });
  const info = group.userData.r23RoofPod as { triangleCount: number };
  return { group, materials, triangleCount: info.triangleCount };
}
