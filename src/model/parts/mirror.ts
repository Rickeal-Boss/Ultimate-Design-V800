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
 * 锚点（R27 运行时探针实证，车头 = +Z，地面 y=0，车身半宽 ≈1.00；数值依据见 MIRROR_MOUNT）：
 *   · 前门窗前角（安装点）：局部 z ≈ +1.48（A 柱脚/风挡下沿实测局部 z≈+1.63，
 *     镜壳长 0.24 → 前缘 z≈+1.60 贴角；R27 前的 +1.82 已越过风挡落到前翼子板上方）
 *   · 镜壳中心高度：y ≈ +1.10（装配态腰带线实测 y≈1.095–1.115；R27 前的 0.70 在
 *     前轮顶 0.88 之下 = 用户指认的「镜子跑到车轮附近」）
 *   · 外伸：从车门蒙皮（x≈±1.00，实测 y≤1.05 处 |x|≈0.99–1.01）向外伸至镜壳外缘
 *     ≈±1.185；外伸总宽 ≈0.185（含支杆）
 *   ★ 局部坐标系约定（本文件）：group 原点 = 车门蒙皮上的支杆根部（inboard 基准），
 *     +X = 车外侧（outboard）、+Y = 上、+Z = 车头向前；镜壳中心在 group 内偏移 HEAD_OFFSET_X 向外。
 *
 * 左右镜像（R30-C1 起改为**几何烘焙**，与 tailLamp 同律）：
 *   左侧 = 规范件（outboard +X）；右侧 = mirrorGeometryX 烘焙进几何（旧写法为
 *   group.scale.x = -1 反射）。烘焙含绕序反转 + 法线 x 取反，故材质可全部
 *   FrontSide（本部件 4 件全是封闭实心：挤出镜壳 / 胶囊支杆 / 挤出 accent / 厚玻璃板），
 *   不再需要 DoubleSide 兜底。
 *   右侧烘焙后：outboard→−X、镜面法线 X 分量取反 → 自然仍朝车内(inboard)与车尾(rear)。
 *
 * 几何构成（每材质 1 mesh，共 5 mesh/侧；tri 预算一对合计 ≤1600）：
 *   mirrorBodyMat   （独占 r23-mirror-body）   圆润流线镜壳（rounded-rect 挤出，弧段锁 4）
 *   mirrorChromeMat （独占 r23-mirror-chrome） 镀铬支杆
 *   mirrorAccentMat （独占 r23-mirror-accent） 镜壳下缘 accent 条（R24-B 从 chrome 拆出）
 *   mirrorGlassMat  （独占 r23-mirror-glass）  深色高光镜面（朝后外偏 ~18°、微俯 ~12°）
 *   结构：单支杆一体化流线支撑臂从前门板前缘向外伸出；镜壳圆润无棱角。
 *
 * R24-B accent 独立材质：镜壳下缘条此前与支杆共用 materials.chrome —— 任何针对下缘
 *   的色相/反射调整都会连坐支杆（合批按**材质实例**分桶，改实例即改两处）。且真车此处
 *   是中性铬（0xe8e9ec），而 RoomEnvironment 是暖色软光箱：metalness 1.0 +
 *   envMapIntensity 1.4 会把中性铬整条反射成暖铜（外部审查 P3「bronze 面漆感、过橙」）。
 *   处置：拆出独占 r23-mirror-accent（+1 DC），color/roughness/metalness 对齐文件内
 *   chrome 参数，envMapIntensity 1.4 → 1.0 收敛暖反射。
 *
 * 独占材质铁律（R8/R12）：4 个 id 全 r23-mirror-*，不得并入全车共享批次，
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
 *
 *  R27 实证重标（.qa/r27_mirror_probe.mjs + .qa/r27_silhouette.mjs，装配态世界 bbox/射线）：
 *  · 旧值 y=0.70 / z=1.82 的来历是「车高 35–40%」「距车头 15–18%」的**字面换算**，
 *    但装配态实测：腰带线（侧窗下沿）y≈1.095–1.115、风挡下沿（A 柱脚）局部 z≈+1.63、
 *    前轮顶 y≈0.88 —— 旧值落点 (y0.70, z1.82) 恰好插进前轮正上方（轮顶下方 0.18m、
 *    轮距带内），即用户指认的「镜子偏移到车轮附近」。
 *  · 新值：y=1.10（镜壳中心贴腰带线；支杆根部 y−0.03≈1.07 正落在门皮 |x|≈1.00 上）、
 *    z=1.48（镜壳长 0.24 → 前缘 z≈1.60，贴着 A 柱脚 1.615/1.631 的后侧，即「前门窗前角」）。
 *  · x=1.00 不变：z∈[−1.7,−1.1] 实测门皮 |x|≈0.99–1.01（y≤1.05），根部正好扎在蒙皮上。
 *  若实拍仍需微调，只动 y / z 即可。 */
export const MIRROR_MOUNT = { x: 1.0, y: 1.1, z: 1.48 } as const;

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
  /** 镀铬支杆（独占） */
  chrome: THREE.MeshPhysicalMaterial;
  /** 镜壳下缘 accent 条：中性铬（独占，R24-B 从 chrome 拆出，不再连坐支杆） */
  accent: THREE.MeshPhysicalMaterial;
  /** 深色高光镜面（独占） */
  glass: THREE.MeshPhysicalMaterial;
}

export interface MirrorOptions {
  /** 'right' 用 mirrorGeometryX 烘焙进几何（R30-C1，替代 scale.x=-1 反射） */
  side?: 'left' | 'right';
  /** 复用外部材质实例（接线时左右必须共用同一份） */
  materials?: MirrorMaterials;
}

export interface MirrorResult {
  /** 在支杆根部局部系原点构建的 Group（右侧已含烘焙镜像，无负尺度） */
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
  accent: 'r23-mirror-accent',
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
    // R30-C1：4 件全为封闭实心（镜壳挤出 / 胶囊支杆 / accent 挤出 / 厚玻璃板）→ FrontSide
    const m = new THREE.MeshPhysicalMaterial({ side: THREE.FrontSide, ...params });
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
    // 镀铬支杆：比共享 chrome 更镜（rough 0.08 / envInt 1.4，任务书口径；R8 不过拉满防锈斑）
    chrome: mk(MIRROR_MATERIAL_IDS.chrome, {
      color: 0xe8e9ec,
      metalness: 1.0,
      roughness: 0.08,
      envMapIntensity: 1.4
    }),
    // 镜壳下缘 accent 条（R24-B）：真车是中性铬，不是暗铜面漆。
    // color / metalness / roughness 与上方 chrome 对齐；envMapIntensity 1.4 → 1.0
    // —— 暖色 RoomEnvironment 在满反射金属上会把 0xe8e9ec 整条染成暖铜（过橙），
    //    压一档环境反射后回到中性铬读感（独占实例，不影响支杆）。
    accent: mk(MIRROR_MATERIAL_IDS.accent, {
      color: 0xe8e9ec,
      metalness: 1.0,
      roughness: 0.08,
      envMapIntensity: 1.0
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
 * 4.5 左右镜像：子树烘焙（R30-C1，替代 group.scale.x = -1）
 * ================================================================ */

/**
 * 把 group 子树按 x=0 平面**整体烘焙镜像**（含子节点变换）。
 * 为什么不能只烘几何：本部件镜壳头是子 Group（head.position.x = HEAD_OFFSET_X），
 * group.scale.x=-1 会连子节点 position 一起镜像，只烘几何不烘变换会把头留在原侧、
 * 与支杆撕裂（R30-C 首版实测右镜 bbox 宽 0.367 ≠ 左 0.261）。
 * 做法：对每个后代节点，把「S_x · 相对 group 的局部矩阵」烘进几何（applyMatrix4
 * 含法线矩阵），随后把该节点局部变换复位为单位阵；det<0 ⇒ 同步反转三角形绕序
 * （索引几何换 index 2/3 项，非索引几何交换每三角第 2、3 顶点全部属性）。
 * group 自身 transform 不动（调用方设的 position 保持）。
 * 世界位姿与旧 scale.x=-1 逐位一致（左右 bbox 对称，探针实证 .qa/r30c）。
 */
function bakeSubtreeMirrorX(group: THREE.Object3D): void {
  const S = new THREE.Matrix4().makeScale(-1, 1, 1);
  group.updateMatrixWorld(true);
  const items: Array<{ node: THREE.Object3D; rel: THREE.Matrix4 }> = [];
  const walk = (node: THREE.Object3D, parentRel: THREE.Matrix4): void => {
    node.updateMatrix();
    const rel = new THREE.Matrix4().multiplyMatrices(parentRel, node.matrix);
    items.push({ node, rel });
    for (const c of node.children) walk(c, rel);
  };
  walk(group, new THREE.Matrix4()); // group 自身矩阵不计入（其 position 由调用方设置）
  for (const { node, rel } of items) {
    if (node === group) continue;
    node.position.set(0, 0, 0);
    node.quaternion.identity();
    node.scale.set(1, 1, 1);
    node.updateMatrix();
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) continue;
    // S_x · rel：位置与法线一次烘入（applyMatrix4 走 normal matrix = (M)⁻ᵀ）
    mesh.geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(S, rel));
    // det(S_x·rel) < 0 ⇒ 三角形绕序反转（否则 FrontSide 下外面被剔除）
    const g = mesh.geometry;
    const index = g.getIndex();
    if (index) {
      const arr = index.array;
      for (let i = 0; i < arr.length; i += 3) {
        const t = arr[i + 1];
        arr[i + 1] = arr[i + 2];
        arr[i + 2] = t;
      }
      index.needsUpdate = true;
    } else {
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
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
    }
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }
  group.updateMatrixWorld(true);
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
  // R24-B：下缘 accent 条走独占材质，与支杆的 chrome 解耦
  addTo(head, chromeBaseGeo, materials.accent, 'mirror-chrome-base');
  group.add(head);

  // 支杆直接挂在 group（跨度：支杆根部 x=0 → 镜壳 inboard 面 x≈0.075）
  addTo(group, armGeo, materials.chrome, 'mirror-arm');

  // ★ 左右镜像：子树烘焙（R30-C1，替代 scale.x=-1 负尺度；含子节点变换，绕序已随烘焙反转）
  if (side === 'right') {
    bakeSubtreeMirrorX(group);
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
