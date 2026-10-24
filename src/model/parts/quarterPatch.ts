/**
 * quarterPatch.ts —— V800 侧围后部破洞补面（R30-C3）
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 本文件只产部件 + 材质，不接线。接线由集成层在 V800Adapter.ts 完成           │
 * │（batchMergeStatic 之前，独占材质进 excludeObjects）。                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 病灶（外部深度审计 P1，p2_side.png 与 verify/r11_final_side34.png 同位置；
 * R30-C 射线探针实证 .qa/r30c/c3-probe*，工厂系车头 +Z）：
 *   侧围后部腰线带是一条**纵向通洞**——body-lower 侧壁顶沿在后段（z≈−1.75 之后）
 *   下收到 y≈1.02~1.10，而侧窗玻璃带下沿（腰线）在 y≈1.14~1.16，中间夹出
 *   |x|∈[0.93,1.01]、y∈[1.03,1.16]、z∈[−2.78,−1.55] 的敞开带（后段还与尾灯顶缘
 *   y≈1.06 / D 柱根 / d-pillar-rear 前面合成一个楔形空洞），从侧视与后 3/4 机位
 *   直接透视进车内。spec 工厂禁改 ⇒ 按 R20/R22 手写件先例补一条封闭面片。
 *
 * 几何：双侧沿腰线走行的条带（下边 y=1.012 埋进侧壁/尾灯/d-pillar-rear 包络内，
 *   上边后段贴 D 柱根（y≈1.164）、前段贴腰线上沿 +4mm 略外凸于镀铬腰线
 *   x=0.940 防 grazing 透视）；左右两侧镜像烘焙（R30-C1 同律，替代 scale.x=-1），
 *   合并为 1 mesh（+1 DC，约 60 tri）。
 * 材质：r30-quarter-patch —— 与全车 paint-upper 曜石黑同参（mirror.ts body
 *   同口径：#0F0F12 / metal 0.7 / rough 0.28 / clearcoat 1.0 / envInt 1.0），
 *   单面片保留 DoubleSide（车内侧后视可能见其背面）。
 */
import * as THREE from 'three';
import { mergeSafe } from '../../util/geo';
import { beltY } from './windowTrim';

/** 独占材质 id（勿并入共享批次） */
export const QUARTER_PATCH_MATERIAL_ID = 'r30-quarter-patch';

/** 条带 z 采样列（工厂系；后 −2.78 → 前 −1.55） */
const STRIP_Z: readonly number[] = [
  -2.78, -2.72, -2.66, -2.62, -2.58, -2.52, -2.46, -2.4, -2.34, -2.26, -2.18, -2.1, -2.02, -1.94, -1.86, -1.78, -1.7, -1.62, -1.55
];
/** 下边（埋进包络）：y / x（工厂系，左侧 +x） */
const ROW_BOTTOM = { y: 1.012, x: 1.0 } as const;
/** 上边后段（贴 D 柱根，z < STRIP_TOP_SWITCH）：y / x */
const ROW_TOP_REAR = { y: 1.164, x: 0.972 } as const;
/** 上边前后段切换 z（此列起改走腰线） */
const STRIP_TOP_SWITCH = -2.62;
/** 上边前段（腰线上沿 +4mm；x 略外凸于镀铬腰线 0.935 防 slot） */
const ROW_TOP_BELT = { x: 0.94, dy: 0.004 } as const;

/** 补面材质（与 paint-upper 同参；单面件保留 DoubleSide） */
export function createQuarterPatchMaterial(): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0x0f0f12,
    metalness: 0.7,
    roughness: 0.28,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    envMapIntensity: 1.0,
    side: THREE.DoubleSide // 单面补片：车内侧后视/掠射机位可能见其背面
  });
  m.name = QUARTER_PATCH_MATERIAL_ID;
  m.userData.sculptMaterial = { id: QUARTER_PATCH_MATERIAL_ID };
  return m;
}

/** 上边在列 z 处的 (x, y)（左侧规范） */
function topEdgeAt(z: number): { x: number; y: number } {
  if (z < STRIP_TOP_SWITCH) return { x: ROW_TOP_REAR.x, y: ROW_TOP_REAR.y };
  return { x: ROW_TOP_BELT.x, y: beltY(z) + ROW_TOP_BELT.dy };
}

/** 规范侧（左，+x）条带几何：每列 2 三角，绕序外法线 +x */
function buildPatchGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const bottom = (z: number): [number, number, number] => [ROW_BOTTOM.x, ROW_BOTTOM.y, z];
  const top = (z: number): [number, number, number] => {
    const t = topEdgeAt(z);
    return [t.x, t.y, z];
  };
  const tri = (a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number]): void => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  };
  for (let i = 0; i < STRIP_Z.length - 1; i += 1) {
    const z0 = STRIP_Z[i];
    const z1 = STRIP_Z[i + 1];
    const b0 = bottom(z0);
    const t0 = top(z0);
    const b1 = bottom(z1);
    const t1 = top(z1);
    // (b0,t0,t1) 叉积外法线 +x（左侧规范）；右侧由 mirrorGeometryX 统一反转
    tri(b0, t0, t1);
    tri(b0, t1, b1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * 把几何按 x=0 平面**烘焙镜像**（R30-C1，替代 group.scale.x = -1 负尺度）：
 * position.x / normal.x 取反 + 三角形绕序反转（非索引几何交换每三角第 2、3
 * 顶点全部属性）。世界位姿与旧负尺度写法逐位一致（左右 bbox 对称，探针实证）。
 */
function mirrorGeometryX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
  for (let i = 0; i < pos.count; i += 1) {
    pos.setX(i, -pos.getX(i));
    if (nrm) nrm.setX(i, -nrm.getX(i));
  }
  pos.needsUpdate = true;
  if (nrm) nrm.needsUpdate = true;
  for (let i = 0; i < pos.count; i += 3) {
    for (const name of Object.keys(g.attributes)) {
      const attr = g.attributes[name] as THREE.BufferAttribute;
      const n = attr.itemSize;
      const a = attr.array as Float32Array;
      for (let k = 0; k < n; k += 1) {
        const i1 = (i + 1) * n + k;
        const i2 = (i + 2) * n + k;
        const t = a[i1];
        a[i1] = a[i2];
        a[i2] = t;
      }
    }
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export interface QuarterPatchResult {
  /** 双侧补面合并后的 Group（1 mesh，+1 DC；userData.sculptComponent.id='quarter-patch'） */
  group: THREE.Group;
  materials: THREE.MeshPhysicalMaterial;
  triangleCount: number;
}

/** 构建侧围后部补面（左右一对，合并为单 mesh） */
export function createQuarterPatch(materials?: THREE.MeshPhysicalMaterial): QuarterPatchResult {
  const mat = materials ?? createQuarterPatchMaterial();
  const left = buildPatchGeometry(); // 规范侧（左，+x）
  const right = mirrorGeometryX(buildPatchGeometry()); // 右侧 = 规范侧烘焙镜像
  const merged = mergeSafe([left, right]);
  const group = new THREE.Group();
  group.name = 'quarter-patch';
  group.userData.sculptComponent = { id: 'quarter-patch' };
  group.userData.r30 = { part: 'quarter-patch', fixes: 'C3 侧围后部破洞' };
  const mesh = new THREE.Mesh(merged, mat);
  mesh.name = 'quarter-patch-mesh';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  group.add(mesh);
  const triangleCount = merged.index ? merged.index.count / 3 : merged.getAttribute('position').count / 3;
  group.updateMatrixWorld(true);
  return { group, materials: mat, triangleCount };
}
