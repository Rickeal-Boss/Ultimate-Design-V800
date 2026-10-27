/**
 * R33 · 智界 R7 前脸精修（装配层手作件，不动物种 spec）
 *
 * 参考图实测（C:/Users/WB/Desktop/R7/294abcf1…jpg）：
 *   · 大灯是**横向斜切楔形灯腔**：外端高、内端低，上缘贴镀铬刃；
 *   · 每侧 4 颗投影透镜沿灯腔斜线排列，外圈镀铬、内芯冷白；
 *   · 灯腔上方是墨绿机盖，灯腔之间由一条贯穿全宽的镀铬刃分隔；
 *   · 下部是宽幅黑色分段格栅 + 两侧竖向导流槽 + 深色前唇。
 *
 * 现有 spec `front-fascia` 仍是一块 1.88×0.735 的平板，`headlamp-l/r` 是两颗
 * 矩形黑卡。本件在装配层覆盖这两处最伤观感的形体（旧灯组由适配器隐藏）：
 *   ① 斜切灯腔 + 镀铬灯眉 + 4 透镜；
 *   ② 贯穿镀铬刃；
 *   ③ 宽幅下格栅 + 竖向导流槽 + 前唇压条。
 *
 * 坐标：工厂局部系，车头 +Z、z=2.44 为前脸表面；body 的 rotY(π) 由适配器负责。
 * 资产：全部程序化，零外部贴图/FBX。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';

const Z_FACE = 2.444;
const Z_LENS = Z_FACE + 0.006;
const Z_DETAIL = Z_FACE + 0.012;

/**
 * R34 · 前唇贴合口径（★唯一真源，禁止在别处硬编码）
 *
 * 实测（node shim .qa/r34car，工厂局部系）：spec `front-fascia` 是
 *   x[-0.940,0.940] y[0.210,0.945] z[2.383,2.428] 的平板挤出体，
 *   ⇒ **底缘是一张 y=0.210 的水平面**（整宽等高）。
 * R33 旧 lipBar 置于局部 y=0.105（z 2.419..2.469），顶面 y=0.118 距 fascia
 * 底缘 0.210 还差 92mm ⇒ 真机侧视读作一条「悬在前脸下方的黑条」（P1 悬浮缝）。
 *
 * 修复：把 lipBar **顶面对齐 fascia 底缘**（top = 0.210 ⇒ center = 0.210 − h/2），
 * 并在 z 上与 fascia 本体重叠 ≥20mm（fascia zmax=2.428，bar z ∈ [2.407,2.457]
 * ⇒ 重叠 21mm、外探 29mm），使悬空态在几何上不可能发生；再补左右端头封口块
 * （埋进 fascia 内部，只负责消除端头读感缝隙）。
 *
 * `lipBarBounds()` 是**由真实几何算出**的纯函数（测试直接断言 MISSING GAP），
 * 不是另一份手抄常量 —— 改 buildLipBar 而忘了改这里，断言必红。
 */
export const R7_FASCIA_BOTTOM_Y = 0.21;
/** 前唇压条：宽 / 高 / 厚 */
const LIP_BAR = { w: 1.62, h: 0.026, d: 0.05 } as const;
/** 压条顶面 y（= fascia 底缘）⇒ 中心 y */
const LIP_BAR_TOP_Y = R7_FASCIA_BOTTOM_Y;
const LIP_BAR_CENTER_Y = LIP_BAR_TOP_Y - LIP_BAR.h / 2;
/** 压条 z 中心：与 fascia 本体（zmax 2.428）重叠 21mm */
const LIP_BAR_CENTER_Z = Z_FACE - 0.012;
/** 端头封口块（埋进 fascia 内部，不参与外观读数） */
const LIP_END_CAP = { w: 0.03, h: 0.05, d: 0.05 } as const;
/** 贴合判定容差（m）：6mm ≈ 屏幕 1px 以下 */
export const R7_LIP_CONTACT_EPSILON = 0.006;

/** 构造前唇压条 + 端头封口的真实几何（↔ createR7FrontDetails 共用同一份代码） */
export function buildLipBar(): THREE.BufferGeometry[] {
  const geos: THREE.BufferGeometry[] = [];
  const bar = new THREE.BoxGeometry(LIP_BAR.w, LIP_BAR.h, LIP_BAR.d);
  bar.translate(0, LIP_BAR_CENTER_Y, LIP_BAR_CENTER_Z);
  geos.push(bar);
  for (const sx of [1, -1] as const) {
    const cap = new THREE.BoxGeometry(LIP_END_CAP.w, LIP_END_CAP.h, LIP_END_CAP.d);
    // 顶到 fascia 底缘之上 25mm（埋进本体），下端落到压条底之下 11mm
    cap.translate(sx * (LIP_BAR.w / 2 - LIP_END_CAP.w / 2), R7_FASCIA_BOTTOM_Y + 0.025 - LIP_END_CAP.h / 2, LIP_BAR_CENTER_Z);
    geos.push(cap);
  }
  return geos;
}

export interface R7LipBounds {
  /** 压条本体（不含端头封口）y 上下限 */
  barMinY: number;
  barMaxY: number;
  /** 压条 z 前后限 */
  barMinZ: number;
  barMaxZ: number;
  /** 含端头封口的整体 y 上限（需 ≥ fascia 底缘 ⇒ 确认埋进本体） */
  capMaxY: number;
  /** 压条顶面到 fascia 底缘的间隙（m）；0 = 完全贴合 */
  topGap: number;
  /** 压条与 fascia 本体在 z 上的重叠深度（m）；> 0 表示有实体搭接，不是企口对接 */
  zOverlap: number;
}

/** 由真实几何反算前唇贴合数据（QA / 单元测试消费） */
export function lipBarBounds(): R7LipBounds {
  const [bar, ...caps] = buildLipBar();
  bar.computeBoundingBox();
  const bb = bar.boundingBox!;
  let capMaxY = -Infinity;
  for (const c of caps) {
    c.computeBoundingBox();
    capMaxY = Math.max(capMaxY, c.boundingBox!.max.y);
  }
  return {
    barMinY: bb.min.y,
    barMaxY: bb.max.y,
    barMinZ: bb.min.z,
    barMaxZ: bb.max.z,
    capMaxY,
    topGap: Math.abs(bb.max.y - R7_FASCIA_BOTTOM_Y),
    zOverlap: 2.428 - bb.min.z
  };
}

export const R7_FRONT_DETAIL_MATERIAL_IDS = {
  housing: 'r33-r7-lamp-housing',
  chrome: 'r33-r7-chrome',
  lens: 'r33-r7-lamp-lens',
  projector: 'r33-r7-projector',
  drl: 'r33-r7-drl',
  intake: 'r33-r7-intake',
  lip: 'r33-r7-lip'
} as const;

export interface R7FrontDetailMaterials {
  housing: THREE.MeshPhysicalMaterial;
  chrome: THREE.MeshPhysicalMaterial;
  lens: THREE.MeshPhysicalMaterial;
  projector: THREE.MeshStandardMaterial;
  drl: THREE.MeshStandardMaterial;
  intake: THREE.MeshStandardMaterial;
  lip: THREE.MeshStandardMaterial;
}

export interface R7FrontDetailResult {
  group: THREE.Group;
  materials: R7FrontDetailMaterials;
  triangleCount: number;
  /** 旧灯组组件 id：适配器据此隐藏原始矩形灯卡（不删 spec 组件） */
  hiddenComponentIds: readonly string[];
}

function makeMaterials(): R7FrontDetailMaterials {
  const mkPhys = (id: string, params: THREE.MeshPhysicalMaterialParameters): THREE.MeshPhysicalMaterial => {
    const m = new THREE.MeshPhysicalMaterial({ side: THREE.FrontSide, ...params });
    m.userData.sculptMaterial = { id };
    return m;
  };
  const mkStd = (id: string, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ side: THREE.FrontSide, ...params });
    m.userData.sculptMaterial = { id };
    return m;
  };
  return {
    housing: mkPhys(R7_FRONT_DETAIL_MATERIAL_IDS.housing, {
      color: 0x070b0d,
      metalness: 0.55,
      roughness: 0.28,
      clearcoat: 0.65,
      clearcoatRoughness: 0.18
    }),
    chrome: mkPhys(R7_FRONT_DETAIL_MATERIAL_IDS.chrome, {
      color: 0xd9e2e4,
      metalness: 1,
      roughness: 0.16,
      envMapIntensity: 1.35
    }),
    lens: mkPhys(R7_FRONT_DETAIL_MATERIAL_IDS.lens, {
      color: 0x10171a,
      metalness: 0.42,
      roughness: 0.08,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      envMapIntensity: 1.55
    }),
    projector: mkStd(R7_FRONT_DETAIL_MATERIAL_IDS.projector, {
      color: 0xe8eef0,
      emissive: 0xbcd8e6,
      emissiveIntensity: 0.55,
      metalness: 0.35,
      roughness: 0.18
    }),
    drl: mkStd(R7_FRONT_DETAIL_MATERIAL_IDS.drl, {
      color: 0xffffff,
      emissive: 0xf2f7ff,
      emissiveIntensity: 2.2,
      metalness: 0.05,
      roughness: 0.2
    }),
    intake: mkStd(R7_FRONT_DETAIL_MATERIAL_IDS.intake, {
      color: 0x080a0b,
      metalness: 0.12,
      roughness: 0.72
    }),
    lip: mkStd(R7_FRONT_DETAIL_MATERIAL_IDS.lip, {
      color: 0x111517,
      metalness: 0.3,
      roughness: 0.5
    })
  };
}

function polygonShape(points: ReadonlyArray<readonly [number, number]>): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) s.lineTo(points[i][0], points[i][1]);
  s.closePath();
  return s;
}

function extrudedShape(
  shape: THREE.Shape,
  depth: number,
  x: number,
  y: number,
  z: number
): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    curveSegments: 1,
    steps: 1
  });
  g.translate(x, y, z);
  return g;
}

function addBox(
  parts: THREE.BufferGeometry[],
  mat: THREE.Material,
  bucket: Map<THREE.Material, THREE.BufferGeometry[]>,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number
): void {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  parts.push(g);
  const list = bucket.get(mat) ?? [];
  list.push(g);
  bucket.set(mat, list);
}

export function createR7FrontDetails(): R7FrontDetailResult {
  const materials = makeMaterials();
  const group = new THREE.Group();
  group.name = 'r7-front-details';
  group.userData.sculptComponent = { id: 'r7-front-details' };

  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const push = (mat: THREE.Material, g: THREE.BufferGeometry): void => {
    const list = byMat.get(mat) ?? [];
    list.push(g);
    byMat.set(mat, list);
  };

  /* ── ① 斜切灯腔（左右镜像烘焙；外端高、内端低） ───────────────── */
  const lampOuter = [
    [0.43, 0.775],
    [0.49, 0.812],
    [0.66, 0.833],
    [0.91, 0.851],
    [0.928, 0.792],
    [0.76, 0.773],
    [0.55, 0.758],
    [0.45, 0.758]
  ] as const;
  const lampLens = [
    [0.465, 0.786],
    [0.515, 0.806],
    [0.665, 0.824],
    [0.895, 0.84],
    [0.908, 0.802],
    [0.755, 0.787],
    [0.565, 0.772],
    [0.48, 0.77]
  ] as const;

  for (const side of [1, -1] as const) {
    const mirror = (pts: ReadonlyArray<readonly [number, number]>): Array<readonly [number, number]> =>
      pts.map(([x, y]) => [side * x, y] as const);

    // 镀铬外框（比灯腔大 1.5%，作为亮边露在镜片外）
    const bezelPts = lampOuter.map(([x, y]) => [side * x, y + (y > 0.8 ? 0.006 : -0.006)] as const);
    push(materials.chrome, extrudedShape(polygonShape(bezelPts), 0.006, 0, 0, Z_FACE));
    // 深色灯腔（镜片底座）
    push(materials.housing, extrudedShape(polygonShape(mirror(lampOuter)), 0.008, 0, 0, Z_FACE + 0.004));
    // 烟熏镜片
    push(materials.lens, extrudedShape(polygonShape(mirror(lampLens)), 0.003, 0, 0, Z_LENS));

    // 4 颗投影透镜：沿灯腔上缘斜线排列，外大内小
    for (let i = 0; i < 4; i += 1) {
      const x = side * (0.835 - i * 0.086);
      const y = 0.818 - i * 0.017;
      const r = 0.0195 - i * 0.0012;
      const ring = new THREE.TorusGeometry(r + 0.004, 0.0028, 6, 14);
      ring.translate(x, y, Z_DETAIL);
      push(materials.chrome, ring);
      const lens = new THREE.CylinderGeometry(r, r, 0.006, 14);
      lens.rotateX(Math.PI / 2);
      lens.translate(x, y, Z_DETAIL + 0.002);
      push(materials.projector, lens);
    }

    // 下缘 DRL 断续光刃（8 段；参考图灯腔下缘为细密点阵光带）
    for (let i = 0; i < 8; i += 1) {
      const t = i / 7;
      const x = side * (0.49 + t * 0.355);
      const y = 0.782 - t * 0.008;
      addBox(
        [],
        materials.drl,
        byMat,
        side > 0 ? 0.034 : 0.034,
        0.007,
        0.005,
        x,
        y,
        Z_DETAIL + 0.001
      );
    }
  }

  /* ── ② 贯穿镀铬刃（灯腔下缘略上，全宽） ───────────────────────── */
  {
    const g = new THREE.BoxGeometry(1.76, 0.011, 0.007);
    g.translate(0, 0.733, Z_FACE + 0.007);
    push(materials.chrome, g);
    // 刃下方一条极细暗缝，避免镀铬与车漆糊在一起
    const seam = new THREE.BoxGeometry(1.7, 0.006, 0.004);
    seam.translate(0, 0.723, Z_FACE + 0.004);
    push(materials.intake, seam);
  }

  /* ── ③ 下部格栅：宽幅黑框 + 6 道横向叶片 + 中央竖隔 ─────────────── */
  {
    const grilleW = 1.06;
    const grilleH = 0.17;
    const grilleY = 0.325;
    // 底部深腔（整块）
    const cavity = new THREE.BoxGeometry(grilleW, grilleH, 0.03);
    cavity.translate(0, grilleY, Z_FACE - 0.002);
    push(materials.intake, cavity);
    // 外框（上/下/左/右四条，微凸）
    for (const [w, h, x, y] of [
      [grilleW + 0.045, 0.018, 0, grilleY + grilleH / 2 + 0.002],
      [grilleW + 0.045, 0.018, 0, grilleY - grilleH / 2 - 0.002],
      [0.018, grilleH, -grilleW / 2 - 0.002, grilleY],
      [0.018, grilleH, grilleW / 2 + 0.002, grilleY]
    ] as const) {
      addBox([], materials.lip, byMat, w, h, 0.012, x, y, Z_DETAIL);
    }
    // 横向叶片 ×5（留出上缘呼吸缝）
    for (let i = 0; i < 5; i += 1) {
      addBox([], materials.lip, byMat, grilleW - 0.03, 0.012, 0.007, 0, grilleY - 0.045 + i * 0.026, Z_DETAIL);
    }
    // 中央竖隔 + 两侧小竖隔（三段式，参考图中央格栅分块）
    for (const x of [-0.17, 0, 0.17]) {
      addBox([], materials.lip, byMat, 0.014, grilleH - 0.01, 0.014, x, grilleY, Z_DETAIL);
    }

    // 两侧竖向空气导流槽（外端深、内端浅）
    for (const side of [1, -1] as const) {
      const scoop = new THREE.BoxGeometry(0.115, 0.19, 0.045);
      scoop.translate(side * 0.805, 0.31, Z_FACE - 0.012);
      push(materials.intake, scoop);
      const edge = new THREE.BoxGeometry(0.012, 0.205, 0.012);
      edge.translate(side * 0.745, 0.31, Z_DETAIL);
      push(materials.chrome, edge);
    }

    // 前唇压条（R34：顶面对齐 fascia 底缘 y=0.210，几何见 lipBarBounds 口径注释）
    for (const g of buildLipBar()) push(materials.lip, g);
    // 前唇镀铬饰条：贴在压条正面上缘（原 y=0.13 是旧悬浮位，会漂在 bar 上方 3cm）
    const lipChrome = new THREE.BoxGeometry(1.3, 0.008, 0.01);
    lipChrome.translate(
      0,
      LIP_BAR_TOP_Y - 0.005,
      LIP_BAR_CENTER_Z + LIP_BAR.d / 2 + 0.0035 - 0.005
    );
    push(materials.chrome, lipChrome);
  }

  // 每材质合一 mesh（DC = 材质数，合并前仅 7）
  let triangleCount = 0;
  for (const [mat, list] of byMat) {
    if (list.length === 0) continue;
    const geo = mergeSafe(list);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `r7-front-${String(mat.userData?.sculptMaterial?.id ?? 'detail').replace('r33-r7-', '')}`;
    group.add(mesh);
    triangleCount += (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
  }
  group.updateMatrixWorld(true);
  return {
    group,
    materials,
    triangleCount,
    hiddenComponentIds: [
      'headlamp-l',
      'headlamp-r',
      'lamp-edging-l',
      'lamp-edging-r',
      // R33：旧全宽发光刃与新手作灯腔叠加会读成双白线；参考图该处是冷银镀铬刃，
      // 发光点阵只应在灯腔内 ⇒ 隐藏旧刃，由本件 chrome + 8 段 DRL 承担。
      'light-bar-front',
      'headlamp-projector-1-l',
      'headlamp-projector-2-l',
      'headlamp-projector-3-l',
      'headlamp-projector-4-l',
      'headlamp-projector-1-r',
      'headlamp-projector-2-r',
      'headlamp-projector-3-r',
      'headlamp-projector-4-r'
    ]
  };
}
