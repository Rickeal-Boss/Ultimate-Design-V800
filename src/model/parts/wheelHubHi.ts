/**
 * R83 · 高精度轮毂 GLB 运行时装载（`wheel-hub-hi.glb`，默认 **OFF**）。
 *
 * ┌──────────────────────────────────────────────────────────────────────────────┐
 * │ ★ 本模块是「反向开关」：绝大多数 R68/R69 开关默认 ON、`#…=off` 回滚；本开关      │
 * │   **默认 OFF**（零风险：不加载、不挂载、tri/DC 逐位不变），只有显式              │
 * │   `#r83wheelhub=on` 才装载 GLB 并替换程序化轮毂。原因见下方预算评估。           │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * 资产（`src/assets/cars/v800/wheel-hub-hi.glb`，18.9 MB）：
 *   · generator 标签 = `R69 bake_wheel_hub` —— 与 `steering.glb`（`r47_steer_bake`）
 *     同一条 Python bake 减面管线（QEM 网格简化 + 贴图缩采样），**不是** gltf-transform /
 *     gltfpack / Draco / meshopt 压缩（本项目零压缩扩展，见 extensionsUsed=[]）。
 *   · 1 mesh / 1 material（`wheelHubHi`，PBR：baseColor + MR + normal 三张内嵌 PNG）、
 *     **288,590 tri**、非索引化 float32 顶点（POSITION/NORMAL/TEXCOORD_0 各一份）。
 *   · ⚠️ 资产规格违规：JSON chunk 长度标 1564 但 JSON 正文只到 1561，尾部补了 **3 个
 *     NUL 字节**（GLB 2.0 要求 0x20 空格补齐）。three 的 GLTFLoader 内部用
 *     `JSON.parse(text)` ⇒ 遇 `\u0000` 直接抛 `Unexpected token`。本模块在 parse 前
 *     **只**把 JSON chunk 截到首个 NUL、保留其后 18 MB BIN chunk（重打包 GLB，见
 *     loadWheelHubHi 内注），逐位规避该违规。
 *
 * 预算评估（为何默认 OFF）：
 *   V800_VISIBLE_TRI_BUDGET = 1,650,000（V800Adapter.ts:1928），当前递交 ~1,505,043
 *   （headroom ~8.8%）。本 GLB ×4 轮 = 288,590 × 4 = **+1,154,360 tri** ⇒ 递交
 *   ~2,659,403 = **预算的 161%（超 61%）**。故：
 *     · 默认 OFF ⇒ 默认构建/运行时 tri/DC **零变化**（`R83_WHEELHUB_HI_ON=false` 时
 *       `loadWheelHubHi` 首行早退 return null，零 fetch / 零 parse / 零挂载）。
 *     · 仅 `#r83wheelhub=on` 显式开启（真机 perfhud 验证不掉帧 + 后续减面/LOD 立项后
 *       才考虑转默认 ON，见 docs/handoff-20261111-1700.md §6）。
 *
 * 挂载契约（与 mountExternalWheel 同纪律，但不走矩阵反解 —— 本件挂 wheel spin 枢轴）：
 *   · **几何口径**：GLB 顶点在「米」（探针实测 radial X max 0.484 / Y max 1.040 /
 *     Z ∈ [-0.433, +0.186]，radial≈0.52 m ⇒ 是「米」不是「模型单位」）。递交几何在
 *     「spec 米」= 真实米 ÷ manifest.scale（=4.75）。故 mesh.scale = 1 / manifest.scale
 *     （**不用** manifest.scale 放大 —— 那是把「模型单位」放大回米的口径，方向相反）。
 *   · **朝向**：探针证实 GLB 轮轴沿 **Z**（Z 跨度 0.62 ≪ X/Y 跨度 ~1.0）、轮心在
 *     (x≈0, y≈0.52, z≈0)，与现有 wheel-l.glb 同口径（radial X-Y、axle Z）。
 *     wheel spin 枢轴的旋转轴 = 局部 X（车轴）⇒ 挂上后 spin 每帧 rotation.x 自转，
 *     **GLB 自身无需绕 X/Y/Z 额外旋转**（wheel-l 也是 Z 轴直接挂 spin，同律）。
 *   · **几何重定位**：GLB 轮心不在原点（y≈0.52）⇒ 必须把 geometry **先平移 -center**
 *     把轮心归到原点，再挂到 spin（spin 原点 = 轮心，R8 轮心对轴）。本模块在 load 时
 *     对**共享 geometry** 做一次 translate（×1 几何，4 实例共享），零每帧成本。
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
 *   · `#r83wheelhub=on` ⇒ 四轮挂 288,590-tri GLB，控制台打印 `[WheelHubHi] ready
 *     wheels=4 tri=288590 scale=…`，perf hud 可见 tri 飙升（预期 +1.15M）。
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

/** 静态 URL（vite 构建期重写；文件名与磁盘逐字符一致，R45 lamp-front→lamp_front 教训） */
const WHEEL_HUB_HI_URL = new URL(
  '../../assets/cars/v800/wheel-hub-hi.glb',
  import.meta.url
).href;

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
    // ── 修资产规格违规：GLB JSON chunk 尾部补了 NUL 字节（应为 0x20）──────
    // GLTFLoader 内部 `JSON.parse(text)` 遇 `\u0000` 抛 `Unexpected token` ⇒ 必须在
    // parse 前**只**把 JSON chunk 截到首个 NUL、保留其后 BIN chunk（18 MB 几何，NUL
    // 在 binary 里合法）。做法：按 GLB 2.0 布局重打包 = 12B header + 修好的 JSON chunk
    // + 原样 BIN chunk。
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
    // 在 JSON 正文里找首个 NUL（= 实际 JSON 结束位）
    let jsonEnd = jsonLen;
    for (let i = 0; i < jsonLen; i++) {
      if (raw[JSON_CHUNK_BODY + i] === 0) { jsonEnd = i; break; }
    }
    const binHeaderOff = JSON_CHUNK_BODY + jsonLen;
    const binLen = u32(binHeaderOff);
    const binBodyOff = binHeaderOff + 8;
    // 重打包：header(12) + JSON chunk header(8) + trimmed JSON + BIN chunk header(8) + BIN body
    const trimmedJsonLen = jsonEnd;
    const totalLen = JSON_CHUNK_BODY + trimmedJsonLen + 8 + binLen;
    const out = new Uint8Array(totalLen);
    out.set(raw.subarray(0, JSON_CHUNK_BODY), 0);           // header + JSON chunk header
    out.set(raw.subarray(JSON_CHUNK_BODY, JSON_CHUNK_BODY + trimmedJsonLen), JSON_CHUNK_BODY); // trimmed JSON
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
    const gltf = await new GLTFLoader().parseAsync(out.buffer as ArrayBuffer, '');
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
      // ⚠️ 无需绕 X/Y/Z 旋转：探针证实 GLB 轮轴沿 Z、与 wheel-l.glb 同口径，
      //    wheel spin 枢轴的旋转轴 = 局部 X（车轴）⇒ 直接挂即可随轮自转（同 wheel-l）。
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
