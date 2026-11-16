/**
 * R89 · R7 主驾座舱 1.5M-tri「外部参考母版」完整装配（不抽稀、不拆簇）。
 *
 * 资产：1 个 GLB / 1 node / 1 mesh / 1 prim / 0 材质 / 0 贴图 / 749,861 verts /
 * 1,499,982 tri，POSITION stride=12（**无 NORMAL、无 UV、无 COLOR**）。第三方视觉
 * 模型独立裁定为「已按真实装配位置摆好的完整主驾座舱」，1177 连通域簇是座舱内多个
 * 独立零件而非台面展开图 ⇒ 无需逐簇拆分、无需 1177 个 Mesh。
 *
 * ── 装配契约（对共享 geometry 一次性做完，顺序不可换）──────────────────────
 *   rotateY(R89_CABIN_YAW) → scale(4.323³) → translate(0.2,-0.25,-0.3)
 *   → computeVertexNormals()（源无 NORMAL，不补会全黑）→ 写 color 顶点色属性
 * 变换全部烘进 geometry：挂 body 组（与 loadInteriorSteering 同父，body 只带
 * rotY(π) 无 scale）。yaw/scale/translate 均为本模块导出的具名常量，真机目检
 * 若发现车头反向或左右镜像，只改 R89_CABIN_YAW（或 `#r89r7yaw=neg`），
 * **不要改 body 的 rotY(π)**。
 *
 * ── 单一材质 / 单一 DC ────────────────────────────────────────────────────
 * 白模无贴图无 UV ⇒ 单一 MeshStandardMaterial({ vertexColors:true })，按顶点
 * y / |x| 分色（仪表台深灰 / 座椅门板暖皮革 / 顶棚饰条银）。**材质 userData
 * 不带 sculptMaterial.id**（避开 CABIN_HIDE_MATERIAL_IDS / cabinOccluderMats /
 * pokeList）；整棵子树打 `userData.r44External = true` ⇒ W1 buildVisibilityTable
 * 自动跳过、不纳管。visible 的唯一写入点是 R7Adapter.applyVisibility 末尾那一行
 * `if (masterCabin) masterCabin.visible = interior;`（禁止再加第 14 组显隐补丁）。
 *
 * ── P0 取舍：完整 1.5M 但外景零成本 ──────────────────────────────────────
 * 用户口径「面数可抬高、首建时长无限制、P0 恒为运行时流畅度」。R7 现状
 * 1,373,463 tri + 1,499,982 = 2.87M（超 1.65M 预算 74%），但**只在 interior=true
 * 时 visible=true**：外景态（追尾/机盖/环绕/侧跟主玩法）visible=false ⇒ 不进
 * 渲染队列、零 tri / 零 DC / 零材质开销；cabin 是静态观察，1 个 DC 不炸。
 *
 * ── 失败语义 / 测试隔离 ───────────────────────────────────────────────────
 * 任何 fetch / parse / 装配失败 ⇒ 返回 null，程序化座舱保持完整，游戏零感知
 * （与 ExternalShell.inTestEnv / InteriorSteering 同纪律）。vitest/Node 下
 * `inTestEnv()` 早退，**绝不发 fetch、绝不读 GLB**。
 *
 * 护栏：getMasterCabinAudit(target) 是纯函数（只读遍历、不发 fetch、不改入参），
 * 供 CI 断言「装配后 mesh 数=1、材质数=1、材质无 sculptMaterial.id、子树
 * 已 r44External 免纳管」。R89_MASTER_CABIN_CONTRACT 是期望值常量。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** 母版 URL 字面量 —— vite 构建期静态重写；不动 ASSET_URLS 表 / ExternalShell.ts。 */
const MASTER_URL = new URL('../../assets/cars/r7/interior-master.glb', import.meta.url).href;

/** 源资产 #assembled 口径：1,499,982 tri / 749,861 verts。 */
export const R89_MASTER_TRI = 1_499_982;
export const R89_MASTER_VERTS = 749_861;

/**
 * 车长轴 X → body-local Z 的偏航。默认 +π/2（主理人 numpy 四朝向实测定罪：
 * rotY90 与整车逐维吻合度 0.9646 最高）。`#r89r7yaw=neg` ⇒ −π/2，供真机
 * 目检反向时一行切换（body 的 rotY(π) 对壳/母版同时生效，不是镜像根因）。
 */
export const R89_CABIN_YAW: number =
  (typeof window !== 'undefined' && /(?:^|[#&])r89r7yaw=neg/i.test(window.location.hash) ? -1 : 1)
  * Math.PI / 2;

/** 与整车 manifest.scale 同源（模型单位 → 米）。 */
export const R89_CABIN_SCALE = 4.323;
/** 装配平移（米，body-local）—— 主理人探测四朝向扫参后的定值。 */
export const R89_CABIN_TRANSLATE: readonly [number, number, number] = [0.2, -0.25, -0.3];

/* ══════════ R90 根治：保留整车尺度 4.323，重标定 translate ══════════════
 * ⚠ 首版假设「scale 4.323 把座舱放大成整车」**已被实锤推翻**：源 GLB 本身就是
 *   带车身外壳/车门/车轮的**整车扫描**（1,499,982 tri 单 mesh），相机落在车内
 *   属正常（distToCenter=0.84m 是车内地合理值）。误缩到 s=2.20 反把整车变成
 *   玩具壳包在相机外（实测 distToCenter=0.61m 仍在内部且门板更贴脸）。
 *   ⇒ R90 保留 scale=4.323（与 manifest 同源），只重标定 translate。
 *
 * 真机定点（dev-cabin 射线 + 截图实证）：R89 translate (0.2,-0.25,-0.3) 让
 * 座舱地板沉到 y=-0.25、整车中心偏后，主驾眼点 world≈(-0.3,1.29,0.09) 前方
 * 正对的是副驾侧围/门板（浅棕大块贴脸 45-50%）。改用 [0.2,0.2,-0.1]：地板抬到
 * y≈0.2 对齐车内地毯、z 前移 0.2m 让仪表台落在眼点前方 ≈1.0m（可辨识而非贴脸），
 * 副驾座椅落在 0.4-0.9m 侧前方。
 *   `#r90cabinscale=off` ⇒ 逐位回 R89 的 4.323 / (0.2,-0.25,-0.3)。 */
export const R90_CABIN_SCALE_ON: boolean =
  typeof window === 'undefined' || !/(?:^|[#&])r90cabinscale=off/i.test(window.location.hash);
export const R90_CABIN_SCALE = 4.323;
export const R90_CABIN_TRANSLATE: readonly [number, number, number] = [0.2, 0.2, -0.1];
/** 实际生效值（A/B 开关感知）。 */
export const CABIN_SCALE = R90_CABIN_SCALE_ON ? R90_CABIN_SCALE : R89_CABIN_SCALE;
export const CABIN_TRANSLATE: readonly [number, number, number] =
  R90_CABIN_SCALE_ON ? R90_CABIN_TRANSLATE : R89_CABIN_TRANSLATE;

/* R90-VIS：`#r90mastervis=off` ⇒ 回退到只写 root.visible（复现 mesh.visible 恒 false 的 bug
 * 供 A/B 对照）。默认 ON = root + mesh 双写唯一真源。 */
export const R90_MASTER_VIS_ON: boolean =
  typeof window === 'undefined' || !/(?:^|[#&])r90mastervis=off/i.test(window.location.hash);

/* ── R89 A/B 回滚开关（默认 ON，解析口径与 V800Adapter R88_V800_CABINROOF_ON 同构）──
 * `#r89r7master=off` 是总闸：完全不装配母版，且 B 项三处外部壳改动全部逐位回 R88。
 * `#r89r7glass=off` / `#r89r7roofcull=off` / `#r89r7side=off` 可单独回退 B 的
 * 玻璃恒显 / 不剔顶 / FrontSide 三个子项（总闸关闭时一律回 R88）。 */
export const R89_R7_MASTER_ON: boolean =
  typeof window === 'undefined' || !/(?:^|[#&])r89r7master=off/i.test(window.location.hash);

/* ── R91 · R7 母版去除异常（用户「R7 内饰需要去除异常」）────────────────────
 * 默认 false：1.5M 母版不装配、不加载，R7 回程序化内饰（去掉巨型模糊座椅）。
 * `#r91r7master=on` ⇒ 重新启用母版（逐位回 R89/R90 行为，A/B 回滚）。
 * 与 R89_R7_MASTER_ON 正交：本开关**只管母版本身**，不触碰 R89 三处外部壳
 * 黑板根治（GLASS / NO_ROOFCULL / FRONTSIDE）——那些是独立修复，母版移除后
 * 仍须保持生效（R7Adapter 经 r89Master=R89_R7_MASTER_ON 消费，不接本开关）。
 * 解析口径与 R89 同构（inline regex，无 FLAG helper）。 */
export const R91_R7_MASTER_ON: boolean =
  typeof window !== 'undefined' && /(?:^|[#&])r91r7master=on/i.test(window.location.hash);
export const R89_R7_GLASS_ON: boolean =
  typeof window === 'undefined' || !/(?:^|[#&])r89r7glass=off/i.test(window.location.hash);
export const R89_R7_NO_ROOFCULL_ON: boolean =
  typeof window === 'undefined' || !/(?:^|[#&])r89r7roofcull=off/i.test(window.location.hash);
export const R89_R7_FRONTSIDE_ON: boolean =
  typeof window === 'undefined' || !/(?:^|[#&])r89r7side=off/i.test(window.location.hash);

/** CI 断言期望值（护栏只读常量，勿改成运行时可变状态）。 */
export const R89_MASTER_CABIN_CONTRACT = Object.freeze({
  tri: R89_MASTER_TRI,
  meshCount: 1,
  materialCount: 1,
  hasSculptId: false,
  isExternal: true
});

export interface MasterCabinAudit {
  /** #assembled 口径（index.count/3）。 */
  tri: number;
  /** 子树内 Mesh 数（必须 =1，禁止按 1177 簇拆 Mesh）。 */
  meshCount: number;
  /** 去重后的材质实例数（必须 =1）。 */
  materialCount: number;
  /** 任一材质是否带 sculptMaterial.id（必须 false，避开 cabinOccluderMats 等通道）。 */
  hasSculptId: boolean;
  /** 整棵子树是否 r44External 免纳管（必须 true ⇒ visible 只由 applyVisibility 写）。 */
  isExternal: boolean;
}

export interface MasterCabinHandle {
  /** 挂 body 的容器（唯一写入点 = applyVisibility）。 */
  readonly root: THREE.Group;
  /** 唯一 Mesh。 */
  readonly mesh: THREE.Mesh;
  /** 唯一材质（vertexColors，无 sculptMaterial.id）。 */
  readonly material: THREE.MeshStandardMaterial;
  readonly tri: number;
  readonly audit: MasterCabinAudit;
}

/** vitest / Node 硬隔离：绝不发 fetch（与 ExternalShell.inTestEnv 同口径）。 */
function inTestEnv(): boolean {
  try {
    return (import.meta as { env?: { MODE?: string } }).env?.MODE === 'test';
  } catch {
    return false;
  }
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const idx = geometry.getIndex();
  const n = idx ? idx.count : (geometry.getAttribute('position')?.count ?? 0);
  return Math.round(n / 3);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 纯函数护栏：只读遍历目标子树，返回装配审计值。不发 fetch、不改入参、不依赖
 * 模块全局状态 ⇒ vitest 可直接用 `assembleMasterCabin(假几何)` 的产物做 CI 断言。
 */
export function getMasterCabinAudit(
  target: THREE.Object3D | null | undefined
): MasterCabinAudit {
  if (!target) {
    return { tri: 0, meshCount: 0, materialCount: 0, hasSculptId: false, isExternal: false };
  }
  let meshCount = 0;
  let tri = 0;
  let hasSculptId = false;
  let isExternal = (target.userData as { r44External?: boolean } | undefined)?.r44External === true;
  const materials = new Set<THREE.Material>();
  target.traverse((o) => {
    if ((o.userData as { r44External?: boolean } | undefined)?.r44External === true) isExternal = true;
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshCount += 1;
    tri += triangleCount(m.geometry);
    const list = Array.isArray(m.material) ? m.material : [m.material];
    for (const mt of list) {
      if (!mt) continue;
      materials.add(mt);
      const id = (mt.userData as { sculptMaterial?: { id?: string } } | undefined)
        ?.sculptMaterial?.id;
      if (id != null) hasSculptId = true;
    }
  });
  return {
    tri,
    meshCount,
    materialCount: materials.size,
    hasSculptId,
    isExternal
  };
}

/**
 * 把源 GLB 的**共享 geometry** 一次性变换 + 上色 + 包成 1 Mesh / 1 材质 / 1 DC。
 * 纯装配工厂（会原地改传入的 geometry；transform 链只跑一次，不可对多个 mesh 重复调）。
 * 顶点色用 THREE.Color(hex) 读线性分量（three 色彩管理默认开，shader 不再做 sRGB 转换）。
 */
export function assembleMasterCabin(geometry: THREE.BufferGeometry): MasterCabinHandle {
  // ① 变换链：yaw → scale → translate（对 position / normal 同步生效）
  // R90：scale/translate 改走 A/B 感知常量（`#r90cabinscale=off` 回 R89 整车尺寸）
  geometry.rotateY(R89_CABIN_YAW);
  geometry.scale(CABIN_SCALE, CABIN_SCALE, CABIN_SCALE);
  geometry.translate(CABIN_TRANSLATE[0], CABIN_TRANSLATE[1], CABIN_TRANSLATE[2]);
  // ② 源无 NORMAL：不补会全黑；GLTFLoader 若已自动补过则跳过（rotateY 已同步旋转法线）
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();

  // ③ 顶点色：仪表台深灰 / 座椅门板暖皮革 / 顶棚饰条银，按 y 平滑过渡、|x| 侧向压暗
  const pos = geometry.getAttribute('position');
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const dash = new THREE.Color(0x2b2e33);
  const leather = new THREE.Color(0x9a7853);
  const trim = new THREE.Color(0xc2c8d0);
  const headliner = new THREE.Color(0x373a3f);
  for (let i = 0; i < count; i += 1) {
    const y = pos.getY(i);
    const a = smoothstep(0.10, 0.50, y);   // 深灰仪表台 → 暖皮革
    const b = smoothstep(1.30, 1.60, y);   // 暖皮革 → 银饰条
    const c = smoothstep(1.60, 1.90, y);   // 银饰条 → 顶棚深灰
    let r = dash.r + (leather.r - dash.r) * a;
    let g = dash.g + (leather.g - dash.g) * a;
    let bl = dash.b + (leather.b - dash.b) * a;
    r += (trim.r - r) * b; g += (trim.g - g) * b; bl += (trim.b - bl) * b;
    r += (headliner.r - r) * c; g += (headliner.g - g) * c; bl += (headliner.b - bl) * c;
    const side = 1 - 0.18 * smoothstep(0.65, 1.05, Math.abs(pos.getX(i)));
    const k = i * 3;
    colors[k] = r * side; colors[k + 1] = g * side; colors[k + 2] = bl * side;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // ④ 单一材质：无贴图/无 UV/无 sculptMaterial.id；DoubleSide 兜住扫描件不一致的绕序
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    metalness: 0.06,
    roughness: 0.72,
    side: THREE.DoubleSide
  });
  // 中性标记（**不是** sculptMaterial.id）⇒ 不进 CABIN_HIDE_MATERIAL_IDS /
  // cabinOccluderMats / buildPokeList，也不被 Game 的 #hidemat 材质级钩子命中
  (material.userData as { r89MasterCabin?: boolean }).r89MasterCabin = true;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'r89-master-cabin';
  mesh.castShadow = false;   // 内饰不投影，省 shadow DC
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  /* R90-VIS 根治：R89 这里写 `mesh.visible=false` 并注释「此后只由 applyVisibility
   * 覆盖」，但 R7Adapter.applyVisibility 只写 root.visible ⇒ mesh 恒 false、母版永不
   * 渲染（真机 A/B 隐藏母版零像素差定罪）。现改为 mesh 恒 true：显隐唯一真源是
   * root.visible（applyVisibility 末尾），mesh 不再持有第二份可漂移状态。
   * `#r90mastervis=off` ⇒ 恢复 R89 的 mesh.visible=false 供 A/B 对照。 */
  mesh.visible = R90_MASTER_VIS_ON;
  (mesh.userData as { r44External?: boolean }).r44External = true;

  const root = new THREE.Group();
  root.name = 'R89MasterCabin';
  (root.userData as { r44External?: boolean }).r44External = true;
  root.visible = false;
  root.add(mesh);

  const tri = triangleCount(geometry);
  return { root, mesh, material, tri, audit: getMasterCabinAudit(root) };
}

/**
 * 装载并装配母版。test 环境 / 总闸关闭 / 任何失败 ⇒ null（游戏零感知）。
 * 与 ExternalShell / InteriorSteering 一样走 `fetch + GLTFLoader.parseAsync`。
 */
export async function loadMasterCabin(): Promise<MasterCabinHandle | null> {
  if (inTestEnv()) {
    console.info('[InteriorCabinMaster] skipped in test env');
    return null;
  }
  if (!R89_R7_MASTER_ON || !R91_R7_MASTER_ON) {
    console.info(
      '[InteriorCabinMaster] force-OFF (R89 #r89r7master=off or R91 default-off); procedural cabin stays'
    );
    return null;
  }
  try {
    console.info('[InteriorCabinMaster] fetching interior-master.glb');
    const res = await fetch(MASTER_URL);
    if (!res.ok) {
      console.warn(`[InteriorCabinMaster] glb HTTP ${res.status}`);
      return null;
    }
    const gltf = await new GLTFLoader().parseAsync(await res.arrayBuffer(), '');
    let source: THREE.BufferGeometry | null = null;
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!source && m.isMesh && m.geometry) source = m.geometry;
    });
    if (!source) {
      console.warn('[InteriorCabinMaster] mesh missing in gltf.scene');
      return null;
    }
    const handle = assembleMasterCabin(source);
    console.info(
      `[InteriorCabinMaster] ready tri=${handle.tri} mesh=${handle.audit.meshCount} ` +
      `mat=${handle.audit.materialCount} sculptId=${handle.audit.hasSculptId} ` +
      `external=${handle.audit.isExternal} yaw=${R89_CABIN_YAW.toFixed(4)} scale=${CABIN_SCALE} ` +
      `trans=[${CABIN_TRANSLATE.join(',')}] vis=${R90_MASTER_VIS_ON}`
    );
    return handle;
  } catch (err) {
    console.warn('[InteriorCabinMaster] 装配失败，保持程序化座舱：', err);
    return null;
  }
}
