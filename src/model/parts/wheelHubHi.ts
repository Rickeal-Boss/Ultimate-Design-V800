/**
 * R83/R86 · 高精度轮毂 GLB 运行时装载（默认 **OFF**）。
 *
 * ┌──────────────────────────────────────────────────────────────────────────────┐
 * │ ★ 本模块是「反向开关」：绝大多数 R68/R69 开关默认 ON、`#…=off` 回滚；本开关      │
 * │   **默认 OFF**（零风险：不加载、不挂载、tri/DC 逐位不变），只有显式              │
 * │   `#r83wheelhub=on` 才装载 GLB 并替换程序化轮毂。原因见下方预算评估。           │
 * │ ★ R86：装载的 GLB 由 R69 bake 的 288,590-tri `wheel-hub-hi.glb` 换成用户       │
 * │   **1.5M-tri 母版** `wheel-hub-master.glb`（webp 压缩 77.7→46.6 MB，自带        │
 * │   baseColor+MR+normal）。`#hubmaster=off` 回退旧 288K 文件。默认仍 OFF 保 P0。  │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * 资产（R86 默认：`src/assets/cars/v800/wheel-hub-master.glb`，46.6 MB webp 压缩版）：
 *   · 源母版 = 用户 `轮毂绘制.glb`（Khronos glTF Blender I/O v4.0.43 导出，1.5M tri /
 *     77.7 MB / 三张内嵌 PNG）。`@gltf-transform/cli webp` 把三张 PNG 转 webp ⇒ 46.6 MB
 *     （余量主要是 1.5M-tri 几何，webp 不碰几何）。`extensionsUsed=[EXT_texture_webp,
 *     KHR_materials_specular]`，three GLTFLoader 内建支持（浏览器均支持 webp）。
 *   · 1 mesh / 1 material（baseColor+MR+normal）、**1,500,000 tri**、indexed。
 *   · ✅ JSON chunk 干净（无 R69 bake 的尾 NUL 违规）⇒ 直接 `parseAsync`，无需重打包。
 *     但 `#hubmaster=off` 回退的旧 `wheel-hub-hi.glb` 仍有 NUL 违规，故保留「探测到 NUL
 *     才重打包」的防御（对 master 是 no-op，见 loadWheelHubHi 内注）。
 *
 * 预算评估（为何默认 OFF）：
 *   V800_VISIBLE_TRI_BUDGET = 1,650,000（V800Adapter.ts:1928），当前递交 ~1,505,043
 *   （headroom ~8.8%）。母版 ×4 轮 = 1,500,000 × 4 = **+6,000,000 tri** ⇒ 远超预算
 *   （~455%），核显 vertex throughput ~100-300 Mtri/s 顶点饱和 ⇒ 预估 5-15 fps，**破 P0**。
 *   故：
 *     · 默认 OFF ⇒ 默认构建/运行时 tri/DC **零变化**（`R83_WHEELHUB_HI_ON=false` 时
 *       `loadWheelHubHi` 首行早退 return null，零 fetch / 零 parse / 零挂载）。
 *     · 仅 `#r83wheelhub=on` 显式开启（真机 perfhud 验证；1.5M 母版在核显上必掉帧，
 *       仅作 A/B 取证态。若要默认开需先减面到 ~300-500K，见 probe-wheel-steer §A）。
 *     · `#hubmaster=off` ⇒ 回退 R69 bake 的 288,590-tri 旧文件（+1.15M tri，161% 预算，
 *       已验证可跑量级），供真机对比 / 母版掉帧时兜底。
 *
 * 挂载契约（与 mountExternalWheel 同纪律，但不走矩阵反解 —— 本件挂 wheel spin 枢轴）：
 *   · **几何口径**：GLB 顶点在「米」（探针实测 bbox size X 0.978 / Y 0.618 / Z 1.040，
 *     radial≈1.0 m ⇒ 是「米」不是「模型单位」）。递交几何在「spec 米」= 真实米 ÷
 *     manifest.scale（=4.75）。故 mesh.scale = 1 / manifest.scale（**不用** manifest.scale
 *     放大 —— 那是把「模型单位」放大回米的口径，方向相反）。
 *   · **朝向（R86 修正）**：探针实测母版 bbox size **Y=0.618 最薄** ⇒ 轮轴沿 **Y**
 *     （⚠️ 派单稿称「轮轴沿 Z、rotation.y=-π/2 逐位复用」是误读 bbox 数字——最薄维是 Y
 *     不是 Z；旧 `wheel-hub-hi.glb` 才是 Z 轴 Y1.040/Z0.619）。故不能沿用 rotation.y=-π/2
 *     （那把 GLB Z→X，对 Y 轴轮会让轮轴仍沿 Y、spin.rotation.x 绕 X 自转 ⇒ 错滚/打转）。
 *     改用 **rotation.z = -π/2**：rotateZ(-π/2) 把 GLB Y（轮轴）→ 车 X 轴，径向 X-Z 平面
 *     → Y-Z 平面，spin.rotation.x 绕 X 自转 ⇒ 正常滚动。外圈面朝向（-π/2 vs +π/2）与旧
 *     件同样存在左右侧 outward 二义，默认 -π/2，如真机目检外圈面朝内可换 +π/2（axle→-X）。
 *   · **几何重定位**：GLB 轮心不在原点（探针 bbox 中心 y≈-0.124）⇒ 必须把 geometry
 *     **先平移 -center** 把轮心归到原点，再挂到 spin（spin 原点 = 轮心，R8 轮心对轴）。
 *     本模块在 load 时对**共享 geometry** 做一次 translate（×1 几何，4 实例共享），零每帧成本。
 *   · **自转**：mesh 挂 spin（wheel-{fl,fr,rl,rr} 的 spin 枢轴）⇒ 自动随轮滚动，
 *     无需额外每帧驱动。
 *   · **合批/阴影/可见性**：spin 子树已在 batchMergeStatic 的 wheelKeep 集合内
 *     （V800Adapter.ts:4627 按 `w.spin.traverse` 建集合）⇒ 自动免疫合批（丢高光/刹车
 *     联动失效）；阴影投影代理（R49-A2）同样按 spin 子树计 ⇒ 本件不进 shadow pass，
 *     castShadow/receiveShadow 恒 false（与四轮本体同律，省 DC）。
 *   · **失败语义**：任何 fetch / parse / 几何缺失 ⇒ 返回 null，程序化轮毂保持完整
 *     （游戏零感知；与 InteriorSteering / ExternalShell 同纪律）。
 *   · **测试隔离**：vitest/node 环境下绝不发 fetch（`import.meta.env.MODE === 'test'`
 *     早退），与 ExternalShell.inTestEnv 同口径。
 *
 * QA：
 *   · 默认（无 hash）⇒ 逐位回 R82 基线，本模块完全不执行；
 *   · `#r83wheelhub=on` ⇒ 四轮挂 1.5M-tri 母版，控制台打印 `[WheelHubHi] ready
 *     wheels=4 tri=1500000 scale=…`，perf hud 可见 tri 飙升（预期 +6M，核显必掉帧）；
 *   · `#r83wheelhub=on&hubmaster=off` ⇒ 回退 288,590-tri 旧件（+1.15M，已验证量级）。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * R83 · 高精度轮毂开关（**默认 OFF**，`#r83wheelhub=on` 启用）。
 *
 * ⚠️ 与多数开关反向：R68/R69 系列默认 ON、`#…=off` 回滚；本开关默认 OFF、
 * `#r83wheelhub=on` 才 ON。原因：高模 GLB ×4 = +1.15M tri ⇒ 撞穿 1.65M 预算（+61%），
 * 只能在显式 perfhud 验证下开启。
 */
export const R83_WHEELHUB_HI_ON = (() => {
  if (typeof window === 'undefined') return false;
  return /(?:^|[#&])r83wheelhub=on/i.test(window.location.hash);
})();

/**
 * R86 · 母版换装开关（**默认 ON** = 装载 1.5M-tri `wheel-hub-master.glb`；
 * `#hubmaster=off` 回退 R69 bake 的 288,590-tri 旧 `wheel-hub-hi.glb`）。
 *
 * 仅在 `R83_WHEELHUB_HI_ON` 已显式开启时才生效（本模块默认 OFF，两个开关都干净 ⇒ 完全不加载）。
 * 用途：母版 1.5M×4=6M tri 在核显上必掉帧，`#hubmaster=off` 供真机 A/B 对比 / 兜底回退到
 * 已验证可跑的 288K 量级。旧文件保留在仓库不删。
 */
export const HUB_MASTER_ON = (() => {
  if (typeof window === 'undefined') return true;
  return !/(?:^|[#&])hubmaster=off/i.test(window.location.hash);
})();

/** 静态 URL（vite 构建期重写；文件名与磁盘逐字符一致，R45 lamp-front→lamp_front 教训） */
const WHEEL_HUB_MASTER_URL = new URL(
  '../../assets/cars/v800/wheel-hub-master.glb',
  import.meta.url
).href;
const WHEEL_HUB_HI_LEGACY_URL = new URL(
  '../../assets/cars/v800/wheel-hub-hi.glb',
  import.meta.url
).href;
// R86：默认指 1.5M 母版；`#hubmaster=off` 回退旧 288K 文件（保留不删）。
const WHEEL_HUB_HI_URL = HUB_MASTER_ON ? WHEEL_HUB_MASTER_URL : WHEEL_HUB_HI_LEGACY_URL;

function inTestEnv(): boolean {
  try {
    return (import.meta as { env?: { MODE?: string } }).env?.MODE === 'test';
  } catch {
    return false;
  }
}

/**
 * 装载高精度轮毂 GLB 并返回 4 个 mesh（共享几何 + 共享材质，×4 DC）。
 * @param scale manifest.scale（=4.75）—— 用于把 GLB「米」顶点压回「spec 米」；
 *              mesh.scale = 1 / scale（注意：与 InteriorSteering 的 scale 放大方向相反，
 *              因为本 GLB 顶点已是米、不是模型单位）。
 * @returns 4 个 mesh（fl/fr/rl/rr 顺序不敏感，调用方按 side 自行挂到对应 spin）；
 *          失败返回 null ⇒ 调用方保持程序化轮毂，游戏零感知。
 */
export async function loadWheelHubHi(
  scale: number
): Promise<THREE.Mesh[] | null> {
  if (!R83_WHEELHUB_HI_ON) return null; // 默认 OFF：早退，零 fetch / 零 parse
  if (inTestEnv()) {
    console.info('[WheelHubHi] skipped in test env');
    return null;
  }
  try {
    console.info(`[WheelHubHi] fetching ${WHEEL_HUB_HI_URL.split('/').pop()} scale=${scale}`);
    const res = await fetch(WHEEL_HUB_HI_URL);
    if (!res.ok) {
      console.warn(`[WheelHubHi] HTTP ${res.status}`);
      return null;
    }
    const raw = new Uint8Array(await res.arrayBuffer());
    // ── 资产规格防御：旧 `wheel-hub-hi.glb`（R69 bake）JSON chunk 尾部补了 NUL 字节 ──
    // GLTFLoader 内部 `JSON.parse(text)` 遇 `\u0000` 抛 `Unexpected token`。R86 母版
    // `wheel-hub-master.glb`（Blender/gltf-transform 导出）JSON 干净无 NUL ⇒ 直接 parse。
    // 故**先探测 JSON chunk 是否含 NUL**：无 ⇒ 用原始 buffer 直接 parseAsync（master 走这条，
    // 零重打包开销）；有 ⇒ 才按 GLB 2.0 布局重打包（截 JSON 到首个 NUL、保留其后 BIN chunk）。
    //   header: magic(4) version(4) length(4) → JSON chunk header 在 12..20
    //   JSON chunk header: length(4) type(4='JSON') → 正文在 20..20+jsonLen
    //   BIN chunk header 紧随（20+jsonLen..+8），正文其后。
    const u32 = (off: number): number =>
      raw[off] | (raw[off + 1] << 8) | (raw[off + 2] << 16) | (raw[off + 3] << 24);
    const MAGIC = 0x46546c67; // 'glTF'
    if (u32(0) !== MAGIC || u32(4) !== 2) {
      console.warn('[WheelHubHi] not a GLB v2 file');
      return null;
    }
    const JSON_CHUNK_HEADER = 12;
    const JSON_CHUNK_BODY = 20;
    const jsonLen = u32(JSON_CHUNK_HEADER);
    const jsonType = u32(JSON_CHUNK_HEADER + 4);
    const JSON_TYPE = 0x4e4f534a; // 'JSON'
    if (jsonType !== JSON_TYPE) {
      console.warn('[WheelHubHi] first chunk is not JSON');
      return null;
    }
    // 在 JSON 正文里找首个 NUL（= 实际 JSON 结束位）；找不到（master）⇒ jsonEnd = jsonLen
    let jsonEnd = jsonLen;
    for (let i = 0; i < jsonLen; i++) {
      if (raw[JSON_CHUNK_BODY + i] === 0) { jsonEnd = i; break; }
    }
    let glbBuffer: ArrayBuffer;
    if (jsonEnd === jsonLen) {
      // 无 NUL 违规（R86 master）⇒ 直接用原始 buffer，零重打包
      glbBuffer = raw.buffer as ArrayBuffer;
    } else {
      // 有 NUL（legacy wheel-hub-hi.glb）⇒ 重打包：header(12) + 修好的 JSON chunk + BIN chunk
      const binHeaderOff = JSON_CHUNK_BODY + jsonLen;
      const binLen = u32(binHeaderOff);
      const binBodyOff = binHeaderOff + 8;
      const trimmedJsonLen = jsonEnd;
      const totalLen = JSON_CHUNK_BODY + trimmedJsonLen + 8 + binLen;
      const out = new Uint8Array(totalLen);
      out.set(raw.subarray(0, JSON_CHUNK_BODY), 0);           // header + JSON chunk header
      out.set(raw.subarray(JSON_CHUNK_BODY, JSON_CHUNK_BODY + trimmedJsonLen), JSON_CHUNK_BODY);
      // 写回修正后的 JSON chunk length（低 32 位够用，GLB 长度远小于 4 GB）
      out[JSON_CHUNK_HEADER] = trimmedJsonLen & 0xff;
      out[JSON_CHUNK_HEADER + 1] = (trimmedJsonLen >>> 8) & 0xff;
      out[JSON_CHUNK_HEADER + 2] = (trimmedJsonLen >>> 16) & 0xff;
      out[JSON_CHUNK_HEADER + 3] = (trimmedJsonLen >>> 24) & 0xff;
      // BIN chunk header + body 原样拷贝
      out.set(raw.subarray(binHeaderOff, binBodyOff + binLen), JSON_CHUNK_BODY + trimmedJsonLen);
      // 修正总长度字段（offset 8..12）
      out[8] = totalLen & 0xff;
      out[9] = (totalLen >>> 8) & 0xff;
      out[10] = (totalLen >>> 16) & 0xff;
      out[11] = (totalLen >>> 24) & 0xff;
      glbBuffer = out.buffer as ArrayBuffer;
    }
    const gltf = await new GLTFLoader().parseAsync(glbBuffer, '');
    // 抽出唯一 mesh（generator 产出单 mesh 单 material）
    let src: THREE.Mesh | null = null;
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !src) src = m;
    });
    if (!src) {
      console.warn('[WheelHubHi] no mesh in gltf.scene');
      return null;
    }
    const source = src as THREE.Mesh;
    const geometry = source.geometry;
    // ── 几何重定位：GLB 轮心不在原点（探针 y≈0.52）⇒ 平移 -bbox 中心归到原点 ──────
    // spin 原点 = 轮心（R8 轮心对轴），mesh 挂 spin 后 position 恒 (0,0,0)；不平移会
    // 让轮毂在轮拱内偏移 ~0.52 m（spec 口径 ~0.11 m）⇒ 明显错位。
    // ⚠️ 共享 geometry 只 translate 一次（4 实例共用），零每帧成本、零显存增量。
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    if (bb) {
      const cx = (bb.min.x + bb.max.x) / 2;
      const cy = (bb.min.y + bb.max.y) / 2;
      const cz = (bb.min.z + bb.max.z) / 2;
      geometry.translate(-cx, -cy, -cz);
    }
    const material = source.material as THREE.Material;
    // R49-A2 阴影代理同律：四轮本体已退出 shadow pass，本件也不投（castShadow=false）
    const kScale = 1 / scale;
    const meshes: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = 'r83-hub-hi';
      mesh.scale.setScalar(kScale);           // 米 → spec 米
      // ⚠️ R86 修正：必须绕 Z 旋转 -π/2。母版轮轴沿 **Y**（探针 bbox size Y=0.618 最薄，
      //    见头注），而 spin.rotation.x 绕局部 X 自转 ⇒ 需把 GLB Y（轮轴）映射到车 X 轴。
      //    rotateZ(-π/2) 把 +Y→+X、径向 X-Z 平面→Y-Z 平面 ⇒ 轮盘落在 Y-Z 面、绕 X 正常滚动。
      //    （旧 wheel-hub-hi.glb 是 Z 轴才用 rotateY(-π/2)；母版换成 Y 轴后沿用会错滚/打转。）
      //    外圈面朝向二义同旧件：默认 -π/2（+Y→+X），如真机目检外圈面朝内可换 +π/2（+Y→-X）。
      mesh.rotation.set(0, 0, -Math.PI / 2);
      mesh.position.set(0, 0, 0);             // spin 原点已是轮心（geometry 已重定位）
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.visible = true;
      // 标 r44External：免疫 setExteriorHidden 按「id-less 材质」规则藏（与四轮本体同律）
      (mesh.userData as { r44External?: boolean }).r44External = true;
      meshes.push(mesh);
    }
    const tri = (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
    console.info(`[WheelHubHi] ready wheels=${meshes.length} tri=${tri} scale=${kScale}`);
    return meshes;
  } catch (err) {
    console.warn('[WheelHubHi] 装载失败，保持程序化轮毂：', err);
    return null;
  }
}
