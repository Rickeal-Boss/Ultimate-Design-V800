/**
 * headLamp.ts —— V800 前大灯「竖向窄高单元」手写几何（R21-C）
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 接线说明（本文件只产部件 + 材质，不接线；接线由集成层在                      │
 * │ V800Adapter.ts 的 R21-C 区块完成，严禁在此文件外改 Adapter / spec / 工厂） │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 目标替换组件（spec componentTree 全量，parent 链见下）：
 *   headlamp-l / headlamp-r   —— 竖向大灯总成 左/右，parent = front-end
 *   其下 headlamp-led-l/r（竖向细灯条）、headlamp-star-l/r（星点平面卡）一并被
 *   本部件取代。旧件是「竖向细灯条 + 平面卡」，与真车（顶部横置 DRL + 方形投影
 *   透镜堆叠）不符，故整组手写替换。
 *
 * 对齐锚点（局部系，与工厂 headlamp-l 挤出件逐位同一坐标系，替换无需矩阵补偿）：
 *   x ∈ [-0.075, +0.075]（宽 0.15，half 0.075）
 *   y ∈ [-0.23,  +0.23 ]（高 0.46，half 0.23）
 *   z ∈ [0, 0.07]        （挤出沿 0→depth，front face = z=0.07，朝 +z 即车头）
 *   本 Group 即在此局部系原点构建；headlamp-l 自身 transform (position
 *   [0.8,-0.074,0.081]) 由父节点 front-end → body rotY(π) 提供世界位姿，
 *   本 Group 不需要任何额外矩阵补偿。
 *
 * 必须在 batchMergeStatic 之前替换（红线，与 R20 尾门同律）：
 *   合批会把 headlamp-l/r 子树并成 batch/* 件且丢失 sculptComponent。应在合批前：
 *   1) 找到 userData.sculptComponent.id === 'headlamp-l' / 'headlamp-r' 的 mesh（各 1 件）；
 *   2) 该 pivot 设 visible=false（或 geometry 换空 BufferGeometry），并删去其 led/star 子节点；
 *   3) 用同一份 createHeadLampMaterials() 产物，调用
 *        createHeadLamp({ side:'left',  materials })
 *        createHeadLamp({ side:'right', materials })
 *      把返回的 group 作为子节点挂到对应 pivot（group 局部系 = 上述锚点系）。
 *
 * 独占材质克隆警告（红线，最重要）：
 *   本部件自带的 6 个材质 id 全为 r21-head-lamp-*（独占、零外部图）。
 *   绝不可把它们并入共享批次（housing-dark / lamp-head / lamp-star 等）——否则
 *   batchMerge 按材质实例把本部件几何吞并进全车大批次，会丢光 emissive/高光且
 *   不可单独寻址/联动。接线时把 headlamp-l/r pivot 传进 batchMergeStatic 的
 *   excludeObjects（或 excludeIds:['headlamp-l','headlamp-r']），整棵子树退出合批。
 *   左右共用同一材质实例（见上）→ 仅左右各 1 组 DC，无额外开销。
 *   材质统一 side=DoubleSide：本部件含薄件（DRL 刃/透镜玻璃/星点），且右侧用
 *   group.scale.x=-1 做 −x 镜像（非旋转），DoubleSide 同时兜住镜像后的绕序翻转。
 *
 * 几何约定（与 project 铁律一致）：
 *   · profile / 轮廓一律 CCW（shoelace > 0），ExtrudeGeometry 据此前向法线才会朝外；
 *   · 挤出沿 +z（0→depth），不居中（与工厂挤出件同律，front face = z=depth）；
 *   · 右侧镜像用 group.scale.x = -1（纯镜像，无 rotation）；
 *   · ≤ 2.5k tri/侧（实测 ≈ 540/侧，见 .qa/r21_headlamp.mjs 输出）。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';

/* ================================================================
 * 0. 局部系常量（与工厂 headlamp-l 挤出件逐位一致）
 * ================================================================ */

/** 单元半宽（spec dimensions.width 0.15 → half 0.075） */
export const HALF_W = 0.075;
/** 单元半高（spec dimensions.height 0.46 → half 0.23） */
export const HALF_H = 0.23;
/** 挤出深度 = 单元总厚（spec dimensions.depth 0.07）；front face 落在 z = DEPTH */
export const DEPTH = 0.07;
/** front face 的世界-局部 z（= DEPTH），所有发光/透镜件贴此面前方 */
export const FRONT_Z = DEPTH;

/* ================================================================
 * 1. 对外类型
 * ================================================================ */

export interface HeadLampMaterials {
  /** 深色底座（housing-dark 质感，独占） */
  housing: THREE.MeshStandardMaterial;
  /** 顶部横向 DRL 白光刃（emissive，独占） */
  drl: THREE.MeshStandardMaterial;
  /** 方形投影透镜 chrome 边圈（独占） */
  lensFrame: THREE.MeshStandardMaterial;
  /** 透镜深色玻璃芯（高光，独占） */
  lensGlass: THREE.MeshStandardMaterial;
  /** 透镜中心微凸点亮态（emissive，独占） */
  lensCore: THREE.MeshStandardMaterial;
  /** 顶部星点装饰（emissive，独占） */
  star: THREE.MeshStandardMaterial;
}

export interface HeadLampOptions {
  /** 左右镜像：'right' 用 group.scale.x = -1 做 −x 镜像（非旋转） */
  side?: 'left' | 'right';
  /** 复用外部材质实例（接线时必须左右共用同一份，否则合批无法左右并 DC） */
  materials?: HeadLampMaterials;
}

export interface HeadLampResult {
  /** 在 headlamp 局部系原点构建的 Group（右侧已含 scale.x=-1 镜像） */
  group: THREE.Group;
  /** 本部件用到的 6 个独占材质 */
  materials: HeadLampMaterials;
  /** 本侧三角形总数（索引/非索引统一折算） */
  triangleCount: number;
}

/* ================================================================
 * 2. 形状 / 挤出辅助（全部 CCW）
 * ================================================================ */

/** 圆角矩形轮廓（CCW，中心在原点）。_seg 预留：圆角弧段数（当前走 THREE.Shape.absarc 默认细分）。 */
function roundedRectShape(w: number, h: number, r: number, _seg = 6): THREE.Shape {
  const hw = w / 2;
  const hh = h / 2;
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh);
  s.absarc(hw - r, -hh + r, r, -Math.PI / 2, 0, false);
  s.lineTo(hw, hh - r);
  s.absarc(hw - r, hh - r, r, 0, Math.PI / 2, false);
  s.lineTo(-hw + r, hh);
  s.absarc(-hw + r, hh - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-hw, -hh + r);
  s.absarc(-hw + r, -hh + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/**
 * 圆角矩形「框」（外轮廓 + 反向绕序的内孔），用于透镜 chrome 边圈。
 * 内孔用顺时针（true）以保证与外侧 CCW 相反，ExtrudeGeometry 才能正确掏洞。
 */
function roundedRectFrameShape(
  w: number, h: number, r: number,
  iw: number, ih: number, ir: number,
  seg = 6
): THREE.Shape {
  const outer = roundedRectShape(w, h, r, seg);
  const hole = new THREE.Path();
  const hw = iw / 2;
  const hh = ih / 2;
  hole.moveTo(-hw + ir, -hh);
  hole.lineTo(hw - ir, -hh);
  hole.absarc(hw - ir, -hh + ir, ir, -Math.PI / 2, 0, true);
  hole.lineTo(hw, hh - ir);
  hole.absarc(hw - ir, hh - ir, ir, 0, Math.PI / 2, true);
  hole.lineTo(-hw + ir, hh);
  hole.absarc(-hw + ir, hh - ir, ir, Math.PI / 2, Math.PI, true);
  hole.lineTo(-hw, -hh + ir);
  hole.absarc(-hw + ir, -hh + ir, ir, Math.PI, Math.PI * 1.5, true);
  outer.holes.push(hole);
  return outer;
}

/** 挤出 0→depth（front cap 在 z=depth），带小圆角倒边；返回非索引几何并刷 bbox。 */
function extrude(shape: THREE.Shape, depth: number, bevel = 0.003): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 6
  });
  g.computeBoundingBox();
  return g;
}

/** 把几何平移到目标位置（合并同材质件前，先烘焙好各自的世界-局部偏移）。 */
function at(g: THREE.BufferGeometry, x: number, y: number, z: number): THREE.BufferGeometry {
  g.translate(x, y, z);
  g.computeBoundingBox();
  return g;
}

/* ================================================================
 * 3. 独占材质工厂（零外部图片；id 全 r21-head-lamp-*）
 * ================================================================ */

export function createHeadLampMaterials(): HeadLampMaterials {
  const mk = (id: string, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, ...params });
    m.userData.sculptMaterial = { id };
    return m;
  };
  return {
    housing: mk('r21-head-lamp-housing', {
      color: 0x14171c, metalness: 0.42, roughness: 0.55
    }),
    drl: mk('r21-head-lamp-drl', {
      color: 0xffffff, emissive: 0xeaf2ff, emissiveIntensity: 1.4, metalness: 0.0, roughness: 0.3
    }),
    lensFrame: mk('r21-head-lamp-lens-frame', {
      color: 0xc9ccd2, metalness: 1.0, roughness: 0.18
    }),
    lensGlass: mk('r21-head-lamp-lens-glass', {
      color: 0x0a0c10, metalness: 0.25, roughness: 0.08
    }),
    lensCore: mk('r21-head-lamp-lens-core', {
      color: 0x222a33, emissive: 0xbfe0ff, emissiveIntensity: 1.2, metalness: 0.0, roughness: 0.25
    }),
    star: mk('r21-head-lamp-star', {
      color: 0xffffff, emissive: 0xfff2cc, emissiveIntensity: 0.9, metalness: 0.3, roughness: 0.3
    })
  };
}

/* ================================================================
 * 4. 主构造
 * ================================================================ */

export function createHeadLamp(options: HeadLampOptions = {}): HeadLampResult {
  const side = options.side ?? 'left';
  const materials = options.materials ?? createHeadLampMaterials();

  // ---- 4.1 深色底座（含底部装饰条，同材质合并）----
  const housingParts: THREE.BufferGeometry[] = [];
  // 外壳：比 spec 轮廓略内收 2mm，留 1 道 3mm 倒边，front face 落在 z = DEPTH
  housingParts.push(
    extrude(roundedRectShape(2 * (HALF_W - 0.002), 2 * (HALF_H - 0.006), 0.028, 4), DEPTH, 0)
  );
  // 底部小装饰条（深色，嵌在 front face 前方 0.5mm，读成「底部装饰区」）
  housingParts.push(
    at(extrude(roundedRectShape(0.10, 0.020, 0.006, 3), 0.006, 0), 0, -0.205, FRONT_Z - 0.002)
  );
  const housingGeo = mergeSafe(housingParts);

  // ---- 4.2 顶部横向 DRL 白光刃（贯穿罩宽 ~83%，微圆角）----
  const drlGeo = at(
    extrude(roundedRectShape(0.125, 0.020, 0.006, 3), 0.008, 0),
    0, 0.178, FRONT_Z - 0.004
  );

  // ---- 4.3 4 颗方形投影透镜（chrome 边圈 + 深色玻璃芯 + 中心微凸亮点）----
  const yCenters = [0.105, 0.02, -0.065, -0.15];
  const frameParts: THREE.BufferGeometry[] = [];
  const glassParts: THREE.BufferGeometry[] = [];
  const coreParts: THREE.BufferGeometry[] = [];
  for (const yc of yCenters) {
    // chrome 边圈：外 0.095 / 内 0.074，边框厚 1.8mm，front 凸出 face 1.4mm
    frameParts.push(
      at(
        extrude(roundedRectFrameShape(0.095, 0.095, 0.012, 0.074, 0.074, 0.009, 2), 0.018, 0),
        0, yc, FRONT_Z - 0.004
      )
    );
    // 玻璃芯：0.074 见方，内凹 4mm（front 在 face+1mm，比边圈 front 低 4mm → 陷进罩内）
    glassParts.push(
      at(new THREE.BoxGeometry(0.074, 0.074, 0.014), 0, yc, FRONT_Z - 0.004)
    );
    // 中心亮点：0.022 见方，凸出 4mm 过边圈 front（ bulge 点亮态）
    coreParts.push(
      at(new THREE.BoxGeometry(0.022, 0.022, 0.020), 0, yc, FRONT_Z + 0.012)
    );
  }
  const frameGeo = mergeSafe(frameParts);
  const glassGeo = mergeSafe(glassParts);
  const coreGeo = mergeSafe(coreParts);

  // ---- 4.4 顶部星点装饰（替代旧 headlamp-star 平面卡；零图，emissive 微光）----
  const starGeo = at(new THREE.BoxGeometry(0.024, 0.024, 0.006), 0, 0.2, FRONT_Z - 0.004);

  // ---- 4.5 装配：每材质 1 个 mesh，挂到 Group ----
  const group = new THREE.Group();
  group.name = side === 'right' ? 'headlamp-r-hand' : 'headlamp-l-hand';
  group.userData.sculptComponent = { id: side === 'right' ? 'headlamp-r' : 'headlamp-l' };

  const addMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string): void => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    group.add(mesh);
  };
  addMesh(housingGeo, materials.housing, 'hl-housing');
  addMesh(drlGeo, materials.drl, 'hl-drl');
  addMesh(frameGeo, materials.lensFrame, 'hl-lens-frame');
  addMesh(glassGeo, materials.lensGlass, 'hl-lens-glass');
  addMesh(coreGeo, materials.lensCore, 'hl-lens-core');
  addMesh(starGeo, materials.star, 'hl-star');

  // ---- 4.6 左右镜像：纯 −x 镜像，非旋转 ----
  if (side === 'right') {
    group.scale.x = -1;
  }

  // ---- 4.7 统计 tri 数 ----
  let triangleCount = 0;
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    triangleCount += g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
  });
  group.updateMatrixWorld(true);

  return { group, materials, triangleCount };
}
