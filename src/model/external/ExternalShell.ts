/**
 * ExternalShell.ts —— R44 车模外观 GLB 资产化运行时（外部壳）。
 *
 * 职责：把 bake 管线（.img2threejs/tools/r44_bake.py）产出的
 * `src/assets/cars/{v800|r7}/`（body.glb + wheel-l/r.glb + basecolor-<variant>.webp
 * + normal.png + mr.png + manifest.json）装配为 three.js 网格，供两台适配器
 * 「装配尾挂外部壳」：
 *   · body(+玻璃) 一个 mesh 挂适配器 body 组（body 已 rotY(π)，GLB +Z 车头一致）；
 *   · 4 个 hub 居中的外部轮 mesh 由适配器挂进现有 wheels[i].spin 并把 spin 迁到外部
 *     hub（见 mountExternalWheel：用矩阵反解局部变换，兼容 V800 hub 组与 R7
 *     rotZ(90°) 基准四元数两种 spin 结构）；
 *   · 变体切换 = 懒加载换 baseColor 贴图（同时只驻留当前变体）。
 *
 * 材质口径（BRIEF §一）：贴图独立加载 ⇒ texture.flipY=false（glTF UV 约定）；
 * baseColor SRGBColorSpace，normal/MR 线性（NoColorSpace）；MR 一张图双槽
 * （roughnessMap 取 G / metalnessMap 取 B），material.roughness=metalness=1。
 * MeshPhysicalMaterial clearcoat=0.4 汽车漆感（R45 可 A/B）。
 *
 * 失败语义：任何一步 fetch/parse 失败 ⇒ 返回 null，适配器保持程序化外观完整
 * （不可见不 dispose 的回退路径），游戏零感知。
 *
 * QA：`#r44ext=off` 显式停用外部壳（A/B 对照）；window.__r44Shell 暴露装载状态
 * 供 headless 探针断言（DEV + QA 均可用，体量恒小）。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type ExternalCarId = 'v800' | 'r7';

export interface ExternalManifest {
  car: ExternalCarId;
  scale: number;
  wheelRadius: number;
  hubs: Record<string, [number, number, number]>;
  bodyBBox: { min: number[]; max: number[] };
  variants: ReadonlyArray<{ id: string; file: string }>;
  tri: Record<string, number>;
  /** R44-6 语义分组（r44_semantic_split.py 产出；旧 manifest 无此字段 = 无语义件） */
  semantic?: Record<string, { tri: number; parts: number[] }>;
}

export interface ExternalShellHandle {
  readonly car: ExternalCarId;
  readonly manifest: ExternalManifest;
  /** 已按 manifest.scale 缩放的车身壳（含玻璃），挂适配器 body 组用 */
  readonly bodyMesh: THREE.Mesh;
  /** hub 居中的外部轮，key = fl/fr/rl/rr（模型单位原点 = 轮毂中心） */
  readonly wheelMeshes: Readonly<Record<string, THREE.Mesh>>;
  readonly wheelRadius: number;
  /** R44-6 语义部件：透明玻璃（与 bodyMesh 同级挂 body 组；cabin 态随外壳隐藏） */
  readonly glassMeshes: readonly THREE.Mesh[];
  /** R44-6 语义部件：灯组 mesh（前后灯，挂 body 组；cabin 态随外壳隐藏） */
  readonly lampMeshes: readonly THREE.Mesh[];
  /** 尾灯材质（emissive 红，适配器 update() 按 brakeLevel 驱动）；无语义件时 null */
  readonly lampRearMat: THREE.MeshStandardMaterial | null;
  /** 头灯材质（emissive 冷白，setHeadlights 联动）；无语义件时 null */
  readonly lampFrontMat: THREE.MeshStandardMaterial | null;
  /** 当前变体 id */
  readonly variant: string;
  /** 懒加载切换 baseColor（同时只驻留当前变体）；失败返回 false（保旧图） */
  setVariant(variantId: string): Promise<boolean>;
  dispose(): void;
}

export interface ExternalShellStatus {
  state: 'idle' | 'loading' | 'ready' | 'failed';
  variant?: string;
  error?: string;
  tri?: number;
}

/** QA 探针读的装载台账（模块级，进程内单例） */
export const r44ShellStatus: Record<ExternalCarId, ExternalShellStatus> = {
  v800: { state: 'idle' },
  r7: { state: 'idle' }
};

if (typeof window !== 'undefined') {
  (window as unknown as { __r44Shell?: Record<ExternalCarId, ExternalShellStatus> }).__r44Shell =
    r44ShellStatus;
}

/** 显式静态 URL 表：vite 对 new URL(字面量, import.meta.url) 做构建期重写 */
const ASSET_URLS: Record<
  ExternalCarId,
  {
    manifest: string;
    body: string;
    wheelL: string;
    wheelR: string;
    glass?: string;
    lampFront?: string;
    lampRear?: string;
    basecolor: Record<string, string>;
  }
> = {
  v800: {
    manifest: new URL('../../assets/cars/v800/manifest.json', import.meta.url).href,
    body: new URL('../../assets/cars/v800/body.glb', import.meta.url).href,
    wheelL: new URL('../../assets/cars/v800/wheel-l.glb', import.meta.url).href,
    wheelR: new URL('../../assets/cars/v800/wheel-r.glb', import.meta.url).href,
    glass: new URL('../../assets/cars/v800/glass.glb', import.meta.url).href,
    lampFront: new URL('../../assets/cars/v800/lamp-front.glb', import.meta.url).href,
    lampRear: new URL('../../assets/cars/v800/lamp-rear.glb', import.meta.url).href,
    basecolor: {
      white: new URL('../../assets/cars/v800/basecolor-white.webp', import.meta.url).href,
      black: new URL('../../assets/cars/v800/basecolor-black.webp', import.meta.url).href,
      gold: new URL('../../assets/cars/v800/basecolor-gold.webp', import.meta.url).href
    }
  },
  r7: {
    manifest: new URL('../../assets/cars/r7/manifest.json', import.meta.url).href,
    body: new URL('../../assets/cars/r7/body.glb', import.meta.url).href,
    wheelL: new URL('../../assets/cars/r7/wheel-l.glb', import.meta.url).href,
    wheelR: new URL('../../assets/cars/r7/wheel-r.glb', import.meta.url).href,
    glass: new URL('../../assets/cars/r7/glass.glb', import.meta.url).href,
    lampFront: new URL('../../assets/cars/r7/lamp-front.glb', import.meta.url).href,
    lampRear: new URL('../../assets/cars/r7/lamp-rear.glb', import.meta.url).href,
    basecolor: {
      white: new URL('../../assets/cars/r7/basecolor-white.webp', import.meta.url).href,
      purple: new URL('../../assets/cars/r7/basecolor-purple.webp', import.meta.url).href,
      green: new URL('../../assets/cars/r7/basecolor-green.webp', import.meta.url).href
    }
  }
};

/** QA A/B：`#r44ext=off` 显式停用外部壳 */
function shellDisabled(): boolean {
  return typeof window !== 'undefined' && window.location.hash.includes('r44ext=off');
}

/**
 * 测试环境隔离硬门禁（主理人指令 2026-11-01）：vitest/node 环境下**绝不**触发
 * 外部壳装配 —— 不发 fetch、不尝试 parse GLB（file:// URL 在 Node fetch 下必败，
 * 即使被 try/catch 吞掉也不允许发生）。判据用 vitest 注入的 `import.meta.env.MODE
 * === 'test'`（Game 装配路径是 dev/prod 运行时，永远不为 test）。
 */
function inTestEnv(): boolean {
  try {
    return (import.meta as { env?: { MODE?: string } }).env?.MODE === 'test';
  } catch {
    return false;
  }
}

/**
 * 每变体金属度因子（× MR 图 B 通道）。
 * 源资产 MR 是「黑车」标定（metal≈1 + 低粗糙）⇒ 白变体若照搬会读成镜面铬
 * （实测：白壳整体 crumpled chrome、车漆读不出白）。按变体给因子压金属度，
 * roughness 仍由 MR G 通道驱动（factor=1 不动）。来源：R44 QA render_debug A/B
 * （metalness 1.0 vs 0.2 对照，.qa/r44_car/_dbg_default.png）。
 */
const VARIANT_METALNESS: Record<string, number> = {
  white: 0.12,
  black: 0.9,
  gold: 0.55,
  purple: 0.6,
  green: 0.5
};

function loadTexture(url: string, srgb: boolean): Promise<THREE.Texture> {
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  return loader.loadAsync(url).then((tex) => {
    tex.flipY = false; // glTF UV 约定（独立加载贴图必须显式关）
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  });
}

/**
 * 把外部轮 mesh 挂进既有 spin 枢轴并把 spin 迁到外部 hub。
 * 通用矩阵反解（不假设 spin 结构）：
 *   1. hubWorld = 壳 root.matrixWorld × hub（模型单位）
 *   2. spin.position = spin.parent.worldToLocal(hubWorld)（spin 原点 = 外部轮心）
 *   3. meshLocal = spin.matrixWorld⁻¹ × T(hubWorld) ⇒ 静止时 mesh 世界变换 =
 *      纯平移（几何 X 轴 = 世界 X 车轴），spin 旋转时绕世界 X 自转 —— 对 V800
 *      hub 组（identity）与 R7 rotZ(90°) 基准四元数两种结构都成立（共轭旋转轴
 *      都落在世界 X 上）。
 */
export function mountExternalWheel(
  shellRoot: THREE.Object3D,
  hubModel: readonly [number, number, number],
  spin: THREE.Object3D,
  mesh: THREE.Mesh,
  scaleFactor: number
): void {
  // ⚠ 必须用 updateWorldMatrix(true, false)（自底向上重算**全祖先链**）——
  // updateMatrixWorld(true) 只从 parent.matrixWorld（可能还是构造期陈值）往下算，
  // 实测导致 spin.matrixWorld 缺祖先变换 ⇒ 局部分解出 x/z 31.5× 的剪切缩放
  // （= QA 图里「车旁巨大黑色翼状物」= 被拉成大饼的外部轮）。
  shellRoot.updateWorldMatrix(true, false);
  spin.updateWorldMatrix(true, false);
  const hubWorld = new THREE.Vector3(hubModel[0], hubModel[1], hubModel[2]);
  shellRoot.localToWorld(hubWorld);
  spin.position.copy(spin.parent!.worldToLocal(hubWorld.clone()));
  spin.updateMatrixWorld(true);
  // mesh 静止时世界变换 = T(hubWorld)×S(scale)（几何是模型单位，轮半径 ~0.09 ⇒
  // 必须带上 manifest.scale 才是 0.41m 真车轮；漏带时轮渲染成 1/4.75 小轮埋进轮拱）。
  const desired = new THREE.Matrix4()
    .multiplyMatrices(new THREE.Matrix4().makeTranslation(hubWorld.x, hubWorld.y, hubWorld.z),
      new THREE.Matrix4().makeScale(scaleFactor, scaleFactor, scaleFactor));
  // ⚠ 不做 decompose：spin 祖先链含多级 rotY(π) 四元数，position/quaternion/scale
  // 三元组表达不了其中的剪切成分（实测分解出 x/z 31.5× 的错缩放 = 巨型大饼轮）。
  // 直接把 local 矩阵钉在 mesh.matrix（matrixAutoUpdate=false），世界变换严格等于
  // spinWorld × spinWorld(0)⁻¹ × desired —— 自转 = spin 每帧旋转对 hub 的共轭，精确。
  const local = new THREE.Matrix4().copy(spin.matrixWorld).invert().multiply(desired);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(local);
  mesh.matrixWorldNeedsUpdate = true;
  spin.add(mesh);
}

/** 计算外部壳 root 系（= 世界系 xz）四轮偏移，供 fx WHEEL_LOCAL 同步 */
export function wheelOffsetsWorldXZ(
  manifest: ExternalManifest
): ReadonlyArray<readonly [number, number]> {
  const order = ['fl', 'fr', 'rl', 'rr'] as const;
  return order.map((tag) => {
    const h = manifest.hubs[tag];
    // body 已 rotY(π)：世界 xz = (−x·s, −z·s)
    return [-h[0] * manifest.scale, -h[2] * manifest.scale] as const;
  });
}

/** QA A/B：`#r44mat=plain|maponly|mapnormal|full` 材质通道开关（定位 crumple 根因用） */
function materialOverride(): string | null {
  if (typeof window === 'undefined') return null;
  return /[#&]r44mat=([a-z]+)/.exec(window.location.hash)?.[1] ?? null;
}

/** 语义部件收集：gltf.scene 下全部 mesh 赋材质+缩放；mat=null 时只清空不产出 */
function collectNamed(
  gltf: { scene: THREE.Object3D } | null,
  out: THREE.Mesh[],
  mat: THREE.Material | null,
  scale: number
): void {
  if (!gltf || !mat) return;
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = mat;
    mesh.scale.setScalar(scale);
    mesh.renderOrder = 2; // 透明玻璃后绘
    out.push(mesh);
  });
}

export async function loadExternalShell(
  car: ExternalCarId,
  variant: string
): Promise<ExternalShellHandle | null> {
  if (inTestEnv()) {
    r44ShellStatus[car] = { state: 'failed', error: 'skipped in test env (isolation gate)' };
    return null;
  }
  if (shellDisabled()) {
    r44ShellStatus[car] = { state: 'failed', error: 'disabled by #r44ext=off' };
    return null;
  }
  r44ShellStatus[car] = { state: 'loading' };
  try {
    const urls = ASSET_URLS[car];
    const res = await fetch(urls.manifest);
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const manifest = (await res.json()) as ExternalManifest;
    const loader = new GLTFLoader();
    // 切割退化支持：manifest 无 wheel-* tri 计数 = 静态轮（整车单 mesh），跳过轮文件
    const hasWheelSplit = manifest.tri['wheel-fl'] != null;
    // R44-6 语义部件可选加载：文件缺失/旧 manifest 无字段时静默跳过（程序化回退不受影响）
    const hasSemantic = manifest.semantic != null;
    const fetchGlb = (url: string | undefined): Promise<{ scene: THREE.Object3D } | null> =>
      !url
        ? Promise.resolve(null)
        : fetch(url)
            .then((r) => (r.ok ? (r.arrayBuffer() as Promise<ArrayBuffer>) : Promise.reject(new Error(String(r.status)))))
            .then((buf) => loader.parseAsync(buf, ''))
            .catch(() => null);
    const [bodyGltf, wlGltf, wrGltf, glassGltf, lfGltf, lrGltf, baseTex, nrmTex, mrTex] = await Promise.all([
      fetch(urls.body).then((r) => r.arrayBuffer()).then((buf) => loader.parseAsync(buf, '')),
      hasWheelSplit
        ? fetch(urls.wheelL).then((r) => r.arrayBuffer()).then((buf) => loader.parseAsync(buf, ''))
        : Promise.resolve(null),
      hasWheelSplit
        ? fetch(urls.wheelR).then((r) => r.arrayBuffer()).then((buf) => loader.parseAsync(buf, ''))
        : Promise.resolve(null),
      hasSemantic ? fetchGlb(urls.glass) : Promise.resolve(null),
      hasSemantic ? fetchGlb(urls.lampFront) : Promise.resolve(null),
      hasSemantic ? fetchGlb(urls.lampRear) : Promise.resolve(null),
      loadTexture(urls.basecolor[variant] ?? urls.basecolor[manifest.variants[0].id], true),
      loadTexture(new URL(`../../assets/cars/${car}/normal.png`, import.meta.url).href, false),
      loadTexture(new URL(`../../assets/cars/${car}/mr.png`, import.meta.url).href, false)
    ]);
    const byName = (scene: THREE.Object3D): Map<string, THREE.Mesh> => {
      const m = new Map<string, THREE.Mesh>();
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.name) m.set(mesh.name, mesh);
      });
      return m;
    };
    const bodyFound = byName(bodyGltf.scene).get('body');
    if (!bodyFound) throw new Error('body mesh missing');
    const wheelMeshes: Record<string, THREE.Mesh> = {};
    if (hasWheelSplit && wlGltf && wrGltf) {
      const wl = byName(wlGltf.scene);
      const wr = byName(wrGltf.scene);
      for (const [tag, src] of [
        ['fl', wl.get('wheel-fl')],
        ['rl', wl.get('wheel-rl')],
        ['fr', wr.get('wheel-fr')],
        ['rr', wr.get('wheel-rr')]
      ] as const) {
        if (!src) throw new Error(`wheel mesh ${tag} missing`);
        wheelMeshes[tag] = src;
      }
    }

    const material = new THREE.MeshPhysicalMaterial({
      map: baseTex,
      normalMap: nrmTex,
      roughnessMap: mrTex, // G 通道
      metalnessMap: mrTex, // B 通道
      roughness: 1,
      metalness: VARIANT_METALNESS[variant] ?? 0.6,
      // R44-6：clearcoat 0.4→0.15 —— QA front34 实测 0.4 时涂层高光把 AI 法线图
      // 的微噪声放大成引擎盖「锈斑状白噪点」（侧视弱、逆光掠射严重）；0.15 保留
      // 漆面湿润感的同时压掉高光破碎。envMapIntensity 0.9→0.7 同向。
      clearcoat: 0.15,
      clearcoatRoughness: 0.35,
      envMapIntensity: 0.7,
      // FrontSide + 烘焙期对拱内壁三角翻绕序（r44_uv_fix 橙三角清单 → bake 翻面）：
      // 内壁面朝外渲染为黑漆（UV 已黑化）。DoubleSide 方案实测会让内衬与外皮
      // z-fighting 出白噪点（QA closeup8），故弃用。
      side: THREE.FrontSide
    });
    // QA 材质 A/B（#r44mat=）：plain=无贴图素材 / maponly=仅 basecolor /
    // mapnormal=+法线 / full=全量（默认）
    const mo = materialOverride();
    if (mo === 'plain') {
      material.map = null;
      material.normalMap = null;
      material.roughnessMap = null;
      material.metalnessMap = null;
      material.metalness = 0;
      material.roughness = 0.5;
      material.color.setHex(0xeeeeee);
    } else if (mo === 'maponly') {
      material.normalMap = null;
      material.roughnessMap = null;
      material.metalnessMap = null;
      material.metalness = 0;
      material.roughness = 0.6;
    } else if (mo === 'mapnormal') {
      material.roughnessMap = null;
      material.metalnessMap = null;
      material.metalness = 0;
      material.roughness = 0.6;
    }

    const bodyMesh = bodyFound;
    bodyMesh.material = material;
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = false;
    for (const mesh of Object.values(wheelMeshes)) {
      mesh.material = material;
      mesh.castShadow = true;
    }
    bodyMesh.scale.setScalar(manifest.scale);

    // ── R44-6 语义部件（glass 透明 / lamp emissive）──
    // glass：深 tint 隐私玻璃（外景态程序化内饰恢复可见 = 透过玻璃看到内饰；
    // cabin 态随外壳整体隐藏，维持 R44 终解「整树切换」语义）。DoubleSide 让
    // 车内视角（极近距离）玻璃内面也有材质；depthWrite=false 防与内饰排序冲突。
    const glassMeshes: THREE.Mesh[] = [];
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0b1016,
      transparent: true,
      opacity: 0.55,
      roughness: 0.06,
      metalness: 0,
      envMapIntensity: 1.6,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    // QA：#r44glass=off|solid 调透明策略（off=隐藏玻璃件 / solid=不透明）
    const glassMode = typeof window !== 'undefined'
      ? /[#&]r44glass=([a-z]+)/.exec(window.location.hash)?.[1] ?? null
      : null;
    if (glassMode === 'solid') {
      glassMat.transparent = false;
      glassMat.opacity = 1;
      glassMat.depthWrite = true;
    }
    collectNamed(glassGltf, glassMeshes, glassMode === 'off' ? null : glassMat, manifest.scale);
    // lamp-rear：刹车灯 emissive 随 brakeLevel（适配器 update() 驱动），map 共享 baseTex
    // 保留灯罩纹理；lamp-front：DRL 常亮冷白，setHeadlights 联动。
    let lampRearMat: THREE.MeshStandardMaterial | null = null;
    let lampFrontMat: THREE.MeshStandardMaterial | null = null;
    const lampRearMeshes: THREE.Mesh[] = [];
    const lampFrontMeshes: THREE.Mesh[] = [];
    if (lrGltf) {
      // R44-6 终版：**去 map 纯 emissive** —— QA front34/rear34 实测 map=baseTex 时
      // 灯组 UV 区在源图集上是串色/暗区（前灯区橙色块显形 = 前脸「破面感」根因）；
      // 灯组本就是发光体，纯 emissive 观感即官图点亮态。
      lampRearMat = new THREE.MeshStandardMaterial({
        color: 0x1a0505,
        emissive: new THREE.Color(0xff1e14),
        emissiveIntensity: 0.35,
        roughness: 0.25,
        metalness: 0.1
      });
      collectNamed(lrGltf, lampRearMeshes, lampRearMat, manifest.scale);
    }
    if (lfGltf) {
      lampFrontMat = new THREE.MeshStandardMaterial({
        color: 0x0a0c10,
        emissive: new THREE.Color(0xcfe0ff),
        emissiveIntensity: 0.7,
        roughness: 0.2,
        metalness: 0.15
      });
      collectNamed(lfGltf, lampFrontMeshes, lampFrontMat, manifest.scale);
    }

    let currentVariant = variant;
    const handle: ExternalShellHandle = {
      car,
      manifest,
      bodyMesh,
      wheelMeshes,
      wheelRadius: manifest.wheelRadius,
      glassMeshes,
      lampMeshes: [...lampRearMeshes, ...lampFrontMeshes],
      lampRearMat,
      lampFrontMat,
      get variant() {
        return currentVariant;
      },
      async setVariant(variantId: string): Promise<boolean> {
        const url = urls.basecolor[variantId];
        if (!url || variantId === currentVariant) return variantId === currentVariant;
        try {
          const tex = await loadTexture(url, true);
          const old = material.map;
          material.map = tex;
          material.metalness = VARIANT_METALNESS[variantId] ?? material.metalness;
          material.needsUpdate = true;
          // R44-6 终版：灯组纯 emissive 无 map，变体切换无需同步（map 已移除）
          old?.dispose();
          currentVariant = variantId;
          r44ShellStatus[car] = { state: 'ready', variant: variantId };
          return true;
        } catch (err) {
          r44ShellStatus[car] = {
            state: 'ready',
            variant: currentVariant,
            error: `variant ${variantId} failed: ${String(err)}`
          };
          return false;
        }
      },
      dispose(): void {
        bodyMesh.geometry.dispose();
        for (const mesh of Object.values(wheelMeshes)) mesh.geometry.dispose();
        for (const mesh of [...glassMeshes, ...lampRearMeshes, ...lampFrontMeshes]) {
          mesh.geometry.dispose();
        }
        glassMat.dispose();
        lampRearMat?.dispose();
        lampFrontMat?.dispose();
        material.map?.dispose();
        material.normalMap?.dispose();
        material.roughnessMap?.dispose();
        material.metalnessMap?.dispose();
        material.dispose();
      }
    };
    r44ShellStatus[car] = {
      state: 'ready',
      variant,
      tri: manifest.tri?.body ?? undefined
    };
    return handle;
  } catch (err) {
    r44ShellStatus[car] = { state: 'failed', error: String(err) };
    console.warn(`[ExternalShell] ${car} 装载失败，保持程序化外观：`, err);
    return null;
  }
}
