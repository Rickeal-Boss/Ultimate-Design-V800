/**
 * mirror.ts —— V800 外后视镜「手写几何」（R23-F）
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ 接线说明（本文件只产部件 + 独占材质，不接线；接线由集成层在 V800Adapter.ts   │
 * │ R23-F 区块完成，严禁在此文件外改 Adapter / spec / 工厂 / batchMerge）        │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 目标替换的 spec 占位件（实测 componentTree，共 6 件 / 双侧）：
 *   mirror-l    后视镜左   parent root  pos[1.1,1.17,0.965]  scale[0.22,0.13,0.11]  mat paint-upper
 *   mirror-cap-l 镀铬盖左  parent mirror-l
 *   mirror-arm-l 镜臂左    parent root  pos[1.02,1.15,0.98]  mat matte-black
 *   mirror-r / mirror-cap-r / mirror-arm-r  右侧完全镜像（x 取反）
 *   ⚠️ spec 占位件位姿错误（z=0.965 落在车身中段、y=1.17 高于窗线），
 *      与视觉实测「前门窗前角、距车头 15–18%、车高 35–40%」不符；
 *      ★ 本文件挂载位姿一律以 MIRROR_MOUNT 为准（见底部），接线层须忽略 spec 占位件位姿。
 *
 * 锚点（探针 + 视觉双校验，车头 = +Z，地面 y=0，车身半宽 ≈1.003）：
 *   · 前门窗前角（安装点）：z ≈ +1.82（取 15–18% 车长中值；front axle z=+1.715、车头 z=+2.72）
 *   · 镜壳中心高度：y ≈ +0.70（车高 1.84 × 0.38 ≈ 0.70；视觉 35–40% 中值）
 *   · 外伸：从车门蒙皮（x≈±1.00）向外伸至镜壳外缘 ≈±1.185；外伸总宽 ≈0.185（含支杆，≈任务 0.20）
 *   ★ 局部坐标系约定（本文件）：group 原点 = 车门蒙皮上的支杆根部（inboard 基准），
 *     +X = 车外侧（outboard）、+Y = 上、+Z = 车头向前；镜壳中心在 group 内偏移 HEAD_OFFSET_X 向外。
 *
 * 左右镜像（★ 反射不是旋转，与 tailLamp 同律）：
 *   左侧 = 规范件（outboard +X）；右侧 = group.scale.x = -1（纯 −x 反射，非旋转）。
 *   反射会翻转三角形绕序 → 所有材质统一 DoubleSide 兜底（R21-C 同律）。
 *   右侧经 −x 反射后：outboard→−X、镜面法线 X 分量取反 → 自然仍朝车内(inboard)与车尾(rear)。
 *
 * 几何构成（每材质 1 mesh，共 4 mesh/侧；tri 预算一对合计 ≤1600）：
 *   mirrorBodyMat   （独占 r23-mirror-body）   圆润流线镜壳（rounded-rect 挤出，弧段锁 4）
 *   mirrorChromeMat （独占 r23-mirror-chrome） 镀铬支杆 + 镀铬下缘基座（双色下缘）
 *   mirrorGlassMat  （独占 r23-mirror-glass）  深色高光镜面（朝后外偏 ~18°、微俯 ~12°）
 *   结构：单支杆一体化流线支撑臂从前门板前缘向外伸出；镜壳圆润无棱角。
 *
 * 独占材质铁律（R8/R12）：3 个 id 全 r23-mirror-*，不得并入全车共享批次，
 *   也不得把 materials.* 实例借给其他部件。接线层须将本部件挂入 batchMergeStatic
 *   的 excludeObjects（否则按 id 合批后材质改名不可寻址、且合批重算法线抹平镜面高光）。
 */
import * as THREE from 'three';

/* ================================================================
 * 0. 局部系常量（改尺寸只动这里）
 * ================================================================ */

/** 镜壳长（前后，沿车长 Z） */
export const MIRROR_LEN = 0.24;
/** 镜壳高（沿 Y） */
export const MIRROR_HEIGHT = 0.12;
/** 镜壳厚（内外，沿 X / outboard） */
export const MIRROR_THICK = 0.11;
/** 镜壳圆角半径（弧段锁 4，与 spec edgeTreatment.segments=4 一致） */
export const MIRROR_RADIUS = 0.03;
/** 镜壳挤出倒角（呼应 spec bevel，仅做微倒角去硬边） */
const HOUSING_BEVEL = 0.012;
/** 镜壳倒角段数（≤2；降段数省 tri，仍保圆润） */
const HOUSING_BEVEL_SEG = 1;
/** 镜壳中心相对支杆根部（group 原点）向外偏移 = 支杆长 + 半厚 */
export const HEAD_OFFSET_X = 0.13;
/** 镜面朝外偏转（rad，约 18°）：镜面法线相对车尾轴向内偏，镜顶随之外倾 */
const GLASS_TILT_OUT = (18 * Math.PI) / 180;
/** 镜面微俯（rad，约 12°）：法线微微下偏 */
const GLASS_TILT_DOWN = (12 * Math.PI) / 180;
/** 镜面半尺寸（深色高光板） */
const GLASS_HALF_W = 0.10;
const GLASS_HALF_H = 0.05;
const GLASS_THICK = 0.012;

/** 推荐挂载点（group 原点 = 支杆根部，落在车门蒙皮 x≈±1.00 处）。
 *  ⚠️ 与 spec 占位件位姿(1.1,1.17,0.965) 不同，必须以本常量挂载。
 *  y 取 0.70（视觉车高 35–40% 中值）；若实拍偏低/偏高，仅改此 y 即可。 */
export const MIRROR_MOUNT = { x: 1.0, y: 0.7, z: 1.82 } as const;

/** 接线层须隐藏的 spec 旧占位件 id（整组替换） */
export const MIRROR_HIDE_IDS = [
  'mirror-l', 'mirror-r',
  'mirror-cap-l', 'mirror-cap-r',
  'mirror-arm-l', 'mirror-arm-r'
] as const;

/* ================================================================
 * 1. 对外类型
 * ================================================================ */

export interface MirrorMaterials {
  /** 镜壳主体（车身同色亮漆，独占） */
  body: THREE.MeshPhysicalMaterial;
  /** 镀铬支杆 / 下缘基座（独占） */
  chrome: THREE.MeshPhysicalMaterial;
  /** 深色高光镜面（独占） */
  glass: THREE.MeshPhysicalMaterial;
}

export interface MirrorOptions {
  /** 'right' 用 group.scale.x = -1 做 −x 反射（非旋转） */
  side?: 'left' | 'right';
  /** 复用外部材质实例（接线时左右必须共用同一份） */
  materials?: MirrorMaterials;
}

export interface MirrorResult {
  /** 在支杆根部局部系原点构建的 Group（右侧已含 scale.x=-1 镜像） */
  group: THREE.Group;
  /** 本部件用到的 3 个独占材质 */
  materials: MirrorMaterials;
  /** 本侧三角形总数 */
  triangleCount: number;
}

/** 独占材质 id（batchMerge / 落地审查寻址用） */
export const MIRROR_MATERIAL_IDS = {
  body: 'r23-mirror-body',
  chrome: 'r23-mirror-chrome',
  glass: 'r23-mirror-glass'
} as const;

/* ================================================================
 * 2. 形状 / 挤出辅助（全部 CCW，同 R21-C / tailLamp）
 * ================================================================ */

/** 圆角矩形轮廓（CCW，中心在原点） */
function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
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

/** 圆角矩形挤出：profile 在 XY（w×h，CCW），沿 +Z 挤出 depth（0→depth 单侧）。
 *  bevel>0 时两端各外扩 bevel；curveSegments=4 ⇒ 弧段锁 4（呼应 spec 4-facet arcs）。 */
function extrudeRoundedRect(
  w: number, h: number, r: number, depth: number,
  bevel: number, curveSegments: number, bevelSegments: number
): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(roundedRectShape(w, h, r), {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments,
    steps: 1,
    curveSegments
  });
  g.computeBoundingBox();
  return g;
}

/* ================================================================
 * 3. 独占材质工厂（零外部图片；id 全 r23-mirror-*）
 * ================================================================ */

export function createMirrorMaterials(): MirrorMaterials {
  const mk = (
    id: string,
    params: THREE.MeshPhysicalMaterialParameters
  ): THREE.MeshPhysicalMaterial => {
    const m = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide, ...params });
    m.userData.sculptMaterial = { id };
    m.name = id;
    return m;
  };
  return {
    // 镜壳主体：匹配全车 paint-upper 曜石黑（#0F0F12 / clearcoat 1.0 / rough 0.28 / metal 0.7 / envInt 1.0）
    body: mk(MIRROR_MATERIAL_IDS.body, {
      color: 0x0f0f12,
      metalness: 0.7,
      roughness: 0.28,
      clearcoat: 1.0,
      clearcoatRoughness: 0.06,
      envMapIntensity: 1.0
    }),
    // 镀铬支杆 / 下缘：比共享 chrome 更镜（rough 0.08 / envInt 1.4，任务书口径；R8 不过拉满防锈斑）
    chrome: mk(MIRROR_MATERIAL_IDS.chrome, {
      color: 0xe8e9ec,
      metalness: 1.0,
      roughness: 0.08,
      envMapIntensity: 1.4
    }),
    // 深色高光镜面：rough 0.05 / color #1a2026（任务书口径）
    glass: mk(MIRROR_MATERIAL_IDS.glass, {
      color: 0x1a2026,
      metalness: 0.0,
      roughness: 0.05,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      envMapIntensity: 0.9
    })
  };
}

/* ================================================================
 * 4. 部件几何
 * ================================================================ */

/** 镜壳：rounded-rect 挤出（厚沿 X=outboard）。
 *  ⚠️ extrude 沿 0→depth 单侧不居中：rotateY(π/2) 后厚轴落 +X(0→T)，
 *     按侧约定同步 translate(-T/2,0,0) 居中（pos.x = depth/2 补偿）。 */
function buildHousing(): THREE.BufferGeometry {
  const g = extrudeRoundedRect(
    MIRROR_LEN, MIRROR_HEIGHT, MIRROR_RADIUS,
    MIRROR_THICK, HOUSING_BEVEL, 4, HOUSING_BEVEL_SEG
  );
  g.rotateY(Math.PI / 2); // 厚轴 Z → X（outboard）
  g.translate(-MIRROR_THICK / 2, 0, 0); // 居中厚轴（侧约定补偿）
  g.computeBoundingBox();
  return g;
}

/** 镀铬下缘基座：薄圆角板贴在镜壳底部外缘（双色下缘），proud 于底面防共面。 */
function buildChromeBase(): THREE.BufferGeometry {
  // profile 在 XY：X=长(沿车长 Z)，Y=厚(沿 X)；挤出 depth 沿 Z 后再旋到 Y(厚度)
  const g = extrudeRoundedRect(0.20, MIRROR_THICK + 0.02, 0.02, 0.035, 0, 4, 1);
  g.rotateX(-Math.PI / 2); // 挤出 Z(0→0.035) → Y(0→-0.035) 段；厚度落 Y
  g.computeBoundingBox();
  // 当前：长沿 X[-0.10,0.10]、厚沿 Z[-0.065,0.065]、Y∈[-0.035,0]
  // 平移到底部外缘：Y 底到镜壳底(-H/2=-0.06) → 中心 Y≈-0.05；X 居中 0；Z 略偏后
  g.translate(0, -0.05, -0.01);
  g.computeBoundingBox();
  return g;
}

/** 镀铬单支杆：胶囊沿 X，从支杆根部(车门外)伸向镜壳(inboard 面)。 */
function buildArm(): THREE.BufferGeometry {
  // 胶囊总长 = length + 2*radius；要覆盖 0→HEAD_OFFSET_X-THICK/2 ≈0.075，
  // 取 radius 0.018、length 0.04 ⇒ 总长 0.076。
  const g = new THREE.CapsuleGeometry(0.018, 0.04, 3, 6);
  g.rotateZ(Math.PI / 2); // 默认 Y 轴 → X 轴（沿车外伸方向）
  g.translate(0.038, -0.03, -0.02); // 支杆根部在 x≈0，略偏下偏后接镜壳下缘
  g.computeBoundingBox();
  return g;
}

/** 深色高光镜面：薄圆角板，法线朝 inboard(−X) + rear(−Z) + 微俯(−Y)。
 *  基准法线 +Z → Ry(π) 朝 −Z(车尾) → Ry(+GLASS_TILT_OUT) 内偏(镜顶外倾) → Rx(−GLASS_TILT_DOWN) 微俯。 */
function buildGlass(): THREE.BufferGeometry {
  const g = extrudeRoundedRect(
    GLASS_HALF_W * 2, GLASS_HALF_H * 2, 0.02, GLASS_THICK, 0, 4, 1
  );
  g.rotateY(Math.PI + GLASS_TILT_OUT); // 车尾向 + 外偏
  g.rotateX(-GLASS_TILT_DOWN); // 微俯
  // 落位到镜壳后内下角（head-local），proud 于 inboard 面 7mm 防埋入/共面
  g.translate(-0.062, 0.0, -0.07);
  g.computeBoundingBox();
  return g;
}

/* ================================================================
 * 5. 主构造
 * ================================================================ */

export function createMirror(options: MirrorOptions = {}): MirrorResult {
  const side = options.side ?? 'left';
  const materials = options.materials ?? createMirrorMaterials();

  const housingGeo = buildHousing();
  const chromeBaseGeo = buildChromeBase();
  const armGeo = buildArm();
  const glassGeo = buildGlass();

  const group = new THREE.Group();
  group.name = side === 'right' ? 'mirror-r-hand' : 'mirror-l-hand';
  group.userData.sculptComponent = { id: group.name };

  // 镜壳头（housing + 镜面 + 镀铬下缘）整体向外偏移 HEAD_OFFSET_X
  const head = new THREE.Group();
  head.name = 'mirror-head';
  head.position.set(HEAD_OFFSET_X, 0, 0);

  const addTo = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, name: string): void => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
  };
  addTo(head, housingGeo, materials.body, 'mirror-housing');
  addTo(head, glassGeo, materials.glass, 'mirror-glass');
  addTo(head, chromeBaseGeo, materials.chrome, 'mirror-chrome-base');
  group.add(head);

  // 支杆直接挂在 group（跨度：支杆根部 x=0 → 镜壳 inboard 面 x≈0.075）
  addTo(group, armGeo, materials.chrome, 'mirror-arm');

  // ★ 左右镜像：纯 −x 反射，非旋转（DoubleSide 兜绕序翻转）
  if (side === 'right') {
    group.scale.x = -1;
  }

  // tri 统计
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

/**
 * 便捷工厂：构建左右一对并各自就位（推荐接线入口）。
 * 左右共用一份 materials 实例（各材质 1 个 DC）。
 * 返回父 Group（已含两次子 group，分别就位于 ±MIRROR_MOUNT）。
 */
export function createMirrors(materials?: MirrorMaterials): { group: THREE.Group; materials: MirrorMaterials; triangleCount: number } {
  const mats = materials ?? createMirrorMaterials();
  const parent = new THREE.Group();
  parent.name = 'mirrors';

  const left = createMirror({ side: 'left', materials: mats });
  left.group.position.set(MIRROR_MOUNT.x, MIRROR_MOUNT.y, MIRROR_MOUNT.z);

  const right = createMirror({ side: 'right', materials: mats });
  right.group.position.set(-MIRROR_MOUNT.x, MIRROR_MOUNT.y, MIRROR_MOUNT.z);

  parent.add(left.group, right.group);
  parent.updateMatrixWorld(true);
  const triangleCount = left.triangleCount + right.triangleCount;
  return { group: parent, materials: mats, triangleCount };
}
