/**
 * 仰望 U8L · 程序化灯组/中网徽标细节件（R92）。
 *
 * 外观主体来自烘焙扫描 GLB（单张 PBR 贴图，无法单独驱动灯组 emissive），
 * 因此本模块只补「需要运行时反馈」的少量发光/徽标几何：
 *   · 分体式大灯：上方贯穿 L 形日行灯 + 下方 6 枚菱形透镜；
 *   · 车尾：横向分段红色尾灯；
 *   · 中网：香槟金竖长方形徽标 + 黑色抽象线条；
 *   · 制动钳：四轮内侧暗红自发光片（跟随 heat）。
 *
 * 坐标口径 = 装配局部坐标（工厂车头 +Z），单位 m；由 YangwangAdapter 挂到
 * `body` 下（body.rotation.y = π 后与世界前进方向 -Z 对齐）。
 * 零贴图、零 transmission，避免重蹈 R12 的透射 pass 整帧 DC 翻倍。
 */
import * as THREE from 'three';

export interface YangwangDetailKit {
  /** 细节件总根（挂到装配 body 下） */
  readonly group: THREE.Group;
  /** 前灯发光材质（DRL + 透镜共用，headlights 开关驱动） */
  readonly headMaterials: readonly THREE.MeshStandardMaterial[];
  /** 尾灯发光材质（brake 强度 + snap 爆闪驱动） */
  readonly tailMaterials: readonly THREE.MeshStandardMaterial[];
  /** 制动钳材质（heat 驱动） */
  readonly caliperMaterials: readonly THREE.MeshStandardMaterial[];
}

const HEAD_IDLE = 0.12;
const TAIL_IDLE = 0.18;

function headMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xdcecff,
    emissive: 0xaad4ff,
    emissiveIntensity: HEAD_IDLE,
    metalness: 0.1,
    roughness: 0.25,
    transparent: true,
    opacity: 0.92
  });
  mat.name = 'yangwang-drl';
  return mat;
}

function tailMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    // 深红 + 低 emissive：避免 ACES 下被环境光冲成白色方块。
    color: 0x3a0a08,
    emissive: 0x5a0c09,
    emissiveIntensity: TAIL_IDLE,
    metalness: 0.2,
    roughness: 0.35
  });
  mat.name = 'yangwang-tail';
  return mat;
}

function addBar(
  parent: THREE.Object3D,
  mat: THREE.Material,
  size: readonly [number, number, number],
  at: readonly [number, number, number]
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
  mesh.position.set(at[0], at[1], at[2]);
  mesh.userData.yangwangDetail = true;
  parent.add(mesh);
  return mesh;
}

/** 构造仰望细节件。所有几何均为低面数基础体（合计 < 2k tri）。 */
export function createYangwangDetails(): YangwangDetailKit {
  const group = new THREE.Group();
  group.name = 'yangwang-details';

  const head = headMaterial();
  const tail = tailMaterial();
  const caliper = new THREE.MeshStandardMaterial({
    color: 0x4a1010,
    emissive: 0x7a1712,
    emissiveIntensity: 0,
    metalness: 0.35,
    roughness: 0.5
  });
  caliper.name = 'yangwang-caliper';

  // 前脸（bake bbox: z ∈ [-2.7837, +2.4885], y ∈ [0, 1.555]）
  // L 形日行灯：拆解.glb 灯组 z∈[0.444,0.530]（×4.5 ⇒ 2.00~2.39），而 z=2.495
  // 是整车最外凸鼻尖；旧灯条贴在鼻尖平面 ⇒ 在灯腔两侧悬空成伸向背景的白横臂。
  // 收进灯腔横向范围并贴回 z=2.41（灯面实际深度）。
  for (const side of [-1, 1]) {
    addBar(group, head, [0.22, 0.026, 0.026], [side * 0.42, 0.995, 2.41]);
    addBar(group, head, [0.026, 0.14, 0.026], [side * 0.53, 0.92, 2.41]);
  }
  addBar(group, head, [0.80, 0.022, 0.026], [0, 0.995, 2.41]);

  // 6 枚菱形透镜（两排 × 三列），上下错开避开 DRL 折线。
  const lensGeo = new THREE.OctahedronGeometry(0.052, 0);
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const lens = new THREE.Mesh(lensGeo, head);
      lens.position.set((col - 1) * 0.36, 0.76 - row * 0.14, 2.515);
      lens.scale.set(0.85, 0.62, 0.45);
      lens.userData.yangwangDetail = true;
      group.add(lens);
    }
  }

  // 中网中央香槟金竖标 + 黑色抽象线条。
  const badge = new THREE.MeshStandardMaterial({
    color: 0xc9a86b,
    emissive: 0x2a1e08,
    emissiveIntensity: 0.15,
    metalness: 0.8,
    roughness: 0.28
  });
  badge.name = 'yangwang-badge';
  const ink = new THREE.MeshStandardMaterial({ color: 0x0b0c10, metalness: 0.2, roughness: 0.6 });
  ink.name = 'yangwang-badge-ink';
  addBar(group, badge, [0.17, 0.38, 0.018], [0, 0.58, 2.518]);
  addBar(group, ink, [0.018, 0.24, 0.006], [0, 0.58, 2.532]);
  addBar(group, ink, [0.09, 0.014, 0.006], [0, 0.66, 2.532]);

  // 车尾横向细长分段尾灯。拆解.glb 尾灯组件 x∈[0.088,0.193]、z∈[-0.601,-0.504]
  // （×4.5 ⇒ |x| 0.40~0.87、z −2.70~−2.27）。旧灯条 x 落在牌照框上、z=-2.805
  // 又比灯面探出 ~10cm ⇒ 后45 读作一条从尾灯横跨牌照框伸向车外的细长白/红线。
  // 现在只覆盖真实尾灯区，并贴回 z=-2.70。
  for (const side of [-1, 1]) {
    // 两段足够覆盖灯腔；旧第 3 段（|x|=0.78）贴到尾角外，删掉。
    for (let i = 0; i < 2; i++) {
      addBar(group, tail, [0.12, 0.028, 0.014], [side * (0.50 + i * 0.16), 0.86, -2.68]);
    }
  }

  // 四轮制动钳片（实际挂到 wheel anchor 下由适配器定位，这里只提供材质）。
  return {
    group,
    headMaterials: [head],
    tailMaterials: [tail],
    caliperMaterials: [caliper]
  };
}

/** 细节材质待机值（供适配器统一复位） */
export const YANGWANG_DETAIL_IDLE = { head: HEAD_IDLE, tail: TAIL_IDLE } as const;
