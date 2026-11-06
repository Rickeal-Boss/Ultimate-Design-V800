/**
 * R47 · 高精度方向盘内饰件运行时（外部 GLB 资产）。
 *
 * 资产由内饰资产线 bake（`.img2threejs/tools/r47_steer_bake.py`），装配契约见
 * `.qa/r47/STEERING_CONTRACT.md`。源 1.5M-tri 扫描盘经温和裁切 + QEM 减面到 52k tri，
 * 贴图 4096² → 1024² webp；UV 与减面后几何一一对应，无需重打包。
 *
 * ── 主理人裁决：契约 §2.3 的 position/scale 组合不成立 ──────────────────────
 * body 组只有 `rotation.y = π`（V800Adapter.ts:1826），**没有 scale**。外部壳件在
 * 各自 mesh 上 `setScalar(manifest.scale)`；而 **`mesh.scale` 只缩放几何顶点，
 * 不缩放 `mesh.position`**（实测探针：position 0.113684 的世界原点是 −0.113684，
 * 而程序化方向盘在 −0.54 m ⇒ 契约把 position 也除以 scale 会让盘跑到车身中心）。
 * 程序化 spec 坐标是「米」且直接放在 body 组里 ⇒ 新方向盘 position 必须用 spec 米；
 * 交付几何是「米 ÷ scale」口径 ⇒ scale 必须 = manifest.scale 把顶点放大回米。
 * 唯一正确组合：**position = spec_m，scale = manifest.scale**
 *   V800 世界原点 [−0.54, 1.02, −1.27] m、直径 0.094737×4.75 = 0.45 m ✅
 * 契约的 `scale=[1,1,1]` 会让盘只剩 ~9 cm；契约的 `position/scale` 会让盘错位 4.75×。
 *
 * 失败语义：任何 fetch / parse / 贴图解码失败 ⇒ 返回 null，程序化方向盘保持完整，
 * 游戏零感知（与 ExternalShell.ts 同纪律）。
 * Node / vitest 隔离：`import.meta.env.MODE === 'test'` 直接返回 null，绝不发 fetch。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type SteeringCarId = 'v800' | 'r7';

/**
 * 装配位置（**米 / spec 坐标**，车头 +Z，未含 body.rotation.y=π）。
 * 真源 = 程序化方向盘 spec 位置：R7 `createR7Model.ts:4643` [0.36, 0.925, 0.64]、
 * V800 `createV800Model.ts:4107` [0.54, 1.02, 1.27]。挂在 body 组（与其它外部壳
 * 同父），由 body 矩阵统一 rotY(π)。⚠ 不要除以 scale —— scale 只作用于几何顶点。
 */
export const STEERING_PLACEMENT: Readonly<Record<SteeringCarId, readonly [number, number, number]>> = {
  r7: [0.36, 0.925, 0.64],
  v800: [0.54, 1.02, 1.27]
};

/** 静态 URL 表：文件名必须与磁盘逐字符一致（R45 lamp-front→lamp_front 404 事故） */
const STEERING_URLS: Record<SteeringCarId, { glb: string; base: string }> = {
  v800: {
    glb: new URL('../../assets/cars/v800/steering.glb', import.meta.url).href,
    base: new URL('../../assets/cars/v800/steering_basecolor.webp', import.meta.url).href
  },
  r7: {
    glb: new URL('../../assets/cars/r7/steering.glb', import.meta.url).href,
    base: new URL('../../assets/cars/r7/steering_basecolor.webp', import.meta.url).href
  }
};

function inTestEnv(): boolean {
  try {
    return (import.meta as { env?: { MODE?: string } }).env?.MODE === 'test';
  } catch {
    return false;
  }
}

/**
 * 装载并装配一台车的高精度方向盘。
 * @param scale manifest.scale —— 只把几何顶点从「模型单位」放大到米；**不影响 position**。
 */
export async function loadInteriorSteering(
  car: SteeringCarId,
  scale: number
): Promise<THREE.Mesh | null> {
  if (inTestEnv()) { console.info('[InteriorSteering] skipped in test env'); return null; }
  try {
    const urls = STEERING_URLS[car];
    console.info(`[InteriorSteering] ${car} fetching ${urls.glb.split('/').pop()} scale=${scale}`);
    const glbRes = await fetch(urls.glb);
    if (!glbRes.ok) { console.warn(`[InteriorSteering] glb HTTP ${glbRes.status}`); return null; }
    const gltf = await new GLTFLoader().parseAsync(await glbRes.arrayBuffer(), '');
    let mesh: THREE.Mesh | null = null;
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.name === 'steering') mesh = m;
    });
    if (!mesh) { console.warn(`[InteriorSteering] ${car} steering mesh missing in gltf.scene`); return null; }

    // 贴图走 blob: URL（与 ExternalShell.loadTexture 同口径：显式 HTTP 校验 + flipY=false）
    const texRes = await fetch(urls.base);
    if (!texRes.ok) { console.warn(`[InteriorSteering] basecolor HTTP ${texRes.status}`); return null; }
    const objectUrl = URL.createObjectURL(await texRes.blob());
    let tex: THREE.Texture;
    try {
      tex = await new THREE.TextureLoader().loadAsync(objectUrl);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    tex.flipY = false; // glTF UV 约定
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    tex.needsUpdate = true;

    const steering = mesh as THREE.Mesh;
    steering.material = new THREE.MeshStandardMaterial({
      map: tex,
      metalness: 0.1, // 源材质 metal=1 是扫描导出默认值（会读成全金属黑），契约 §3 重标定
      roughness: 0.65,
      side: THREE.FrontSide
    });
    steering.position.set(...STEERING_PLACEMENT[car]);
    // 源扫描自带盘面倾角（R7 ≈20–30° / V800 ≈40–45°），rotation 保持 0；
    // 若真机 cabin 机位看着太躺/太立，只在 ±0.15 rad 内微调 rotation.x（契约 §7.1）。
    steering.rotation.set(0, 0, 0);
    steering.scale.setScalar(scale);
    /* ── R52-A1 · 高精度方向盘盘面朝向修正（修「V800 方向盘方向装错」）──────────
     * 根因同 R47 车轮：body 组带 rotY(π)（V800Adapter.ts:1826），挂在 body 下的挂件
     *   一并翻转 180°。车轮靠 R47 `geometry.rotateY(π)` 补偿，方向盘**漏做**这一步 ⇒ 盘面
     *   被翻到朝风挡（+Z）而非驾驶者（−Z）。
     * 定量（.qa/r52/glb_orient.py）：V800 GLB 盘面法线 local≈[-Y,-Z]，经 body rotY(π) 后
     *   世界法线≈[-Y,+Z]（朝风挡）错误；程序化方向盘（rotation.x=0.42，同在 body 下）世界
     *   法线≈[-Y,-Z]（朝驾驶者）正确。补 `geometry.rotateY(π)` 与 body 抵消，恢复 GLB 原生
     *   「盘面朝驾驶者」朝向，与程序化一致（倾角符号也逐位匹配，仅幅值 45° vs 24° 为源扫描
     *   固有，契约已接受）。零资产变更、零挂载矩阵变更、零自转影响。
     * QA 回滚：`#r52steering=off` ⇒ 保持原状（A/B 唯一变量）。R7 同病（local 法线[-Y,-Z]
     *   翻后朝 +Z），共享本修正一并修复。 */
    if (!/(?:^|[#&])r52steering=off/i.test(
      typeof window === 'undefined' ? '' : window.location.hash
    )) {
      steering.geometry.rotateY(Math.PI);
    }
    steering.castShadow = false; // 内饰不投影，省 shadow DC
    steering.receiveShadow = false;
    steering.visible = false; // 由 setPaintShadow(interior) 接管：仅车内机位可见
    // setExteriorHidden 遍历 root 时必须跳过（否则被「id-less 材质按名隐藏」规则藏掉）
    (steering.userData as { r44External?: boolean }).r44External = true;
    console.info(`[InteriorSteering] ${car} ready tri=${(steering.geometry.index?.count ?? 0) / 3} `
      + `pos=${steering.position.toArray().join(',')} scale=${scale}`);
    return steering;
  } catch (err) {
    console.warn(`[InteriorSteering] ${car} 装载失败，保持程序化方向盘：`, err);
    return null;
  }
}
