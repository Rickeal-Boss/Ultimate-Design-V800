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
 *
 * ── R46 / Phase 2（LOAD-A）─────────────────────────────────────────────────────
 *  · 新增「默认普通车模」偏好门禁 + `#r44ext=on` QA 强制开（优先级见下方注释）；
 *  · AbortController 全链路可中止在途 fetch（含 3 张贴图走同一 signal）；
 *  · HUD 字节按 car 计、总量按 car 显示、进度刷新 ~200ms 节流（防 createElement 幽灵条）；
 *  · 前灯图集 `lamp_front_atlas.png` 以 emissiveMap 接入（修「前灯一片白」）。
 * 契约：`loadExternalShell(car, variant)` 签名不变、两个 Adapter 零改动；
 *       取消 ≡ 既有 `#r44ext=off` 回退路径，返回 null 即保持程序化外观。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  SHELL_TOTAL_MB,
  isHighDetailEnabled,
  isShellLoadCancelled,
  onShellCancel,
  shellCancelReason
} from '../../config/highDetail';

/** R46：契约出口（实现在 config/highDetail.ts，UI 线只消费这两个 + state:'cancelled'） */
export { cancelExternalShellLoad, isShellLoadCancelled } from '../../config/highDetail';

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
  /**
   * R47：外景态把隐私玻璃调成完全不透明，遮住程序化低模方块内饰
   * （用户点名「高精度外膜普通内饰方块模型透车外问题」）。
   * 只改 `opacity`（transparent 恒 true）⇒ 不触发 program 重编译、零 DC 变化。
   * cabin 态恢复半透；`#r44glass=off|solid` QA 钩子优先，本方法不介入。
   */
  setGlassOpaque(opaque: boolean): void;
  /** 当前变体 id */
  readonly variant: string;
  /** 懒加载切换 baseColor（同时只驻留当前变体）；失败返回 false（保旧图） */
  setVariant(variantId: string): Promise<boolean>;
  dispose(): void;
}

export interface ExternalShellStatus {
  /** R46：'cancelled' = 用户停止下载 / 默认普通车模偏好（不是加载失败） */
  state: 'idle' | 'loading' | 'ready' | 'failed' | 'cancelled';
  variant?: string;
  error?: string;
  tri?: number;
  /** 已接收的高精度资产字节数（解压后口径，QA/线上诊断用） */
  bytes?: number;
  /**
   * R46：前灯是否挂了 emissiveMap。
   * true = 已挂裁片图集（正常路径）；false = 走了纯 emissive 回退
   * （`#r46lampmap=off` 或 atlas 缺失/加载失败）。供 QA 探针机读；**不改 `state` 枚举**。
   */
  lampMap?: boolean;
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

/**
 * R46 前灯图集查找表（几何资产线并行产出 `src/assets/cars/<car>/lamp_front_atlas.png`）。
 *
 * ⚠ 为什么用 `import.meta.glob` 而不是派工单建议的静态 `new URL(字面量, import.meta.url)`：
 *   几何线与本线**并行施工**，静态字面量在 vite build 的 resolve 阶段就会因文件尚未落地
 *   直接失败；而 glob 在「零匹配」时返回空对象 → 构建通过、运行时优雅降级（纯 emissive），
 *   文件一到位即被 Vite 重写为 hashed URL 自动生效。仍保留 hash 指纹与「文件名逐字符
 *   一致」约束（BRIEF.md:52；R45 曾因 lamp-front→lamp_front 出过 404 事故）。
 *   几何线交付后若要收敛成静态字面量，可直接把 atlasUrlFor 换成一行 new URL。
 */
const LAMP_FRONT_ATLAS = import.meta.glob('../../assets/cars/*/lamp_front_atlas.png', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>;

function atlasUrlFor(car: ExternalCarId): string | undefined {
  const suffix = `/cars/${car}/lamp_front_atlas.png`;
  for (const [key, url] of Object.entries(LAMP_FRONT_ATLAS)) {
    if (key.endsWith(suffix)) return url;
  }
  return undefined;
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
    /** R46：前灯裁片图集；几何线尚未产出时为 undefined ⇒ 优雅降级纯 emissive */
    lampFrontAtlas?: string;
    basecolor: Record<string, string>;
  }
> = {
  v800: {
    manifest: new URL('../../assets/cars/v800/manifest.json', import.meta.url).href,
    body: new URL('../../assets/cars/v800/body.glb', import.meta.url).href,
    wheelL: new URL('../../assets/cars/v800/wheel-l.glb', import.meta.url).href,
    wheelR: new URL('../../assets/cars/v800/wheel-r.glb', import.meta.url).href,
    glass: new URL('../../assets/cars/v800/glass.glb', import.meta.url).href,
    lampFront: new URL('../../assets/cars/v800/lamp_front.glb', import.meta.url).href,
    lampRear: new URL('../../assets/cars/v800/lamp_rear.glb', import.meta.url).href,
    lampFrontAtlas: atlasUrlFor('v800'),
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
    lampFront: new URL('../../assets/cars/r7/lamp_front.glb', import.meta.url).href,
    lampRear: new URL('../../assets/cars/r7/lamp_rear.glb', import.meta.url).href,
    lampFrontAtlas: atlasUrlFor('r7'),
    basecolor: {
      white: new URL('../../assets/cars/r7/basecolor-white.webp', import.meta.url).href,
      purple: new URL('../../assets/cars/r7/basecolor-purple.webp', import.meta.url).href,
      green: new URL('../../assets/cars/r7/basecolor-green.webp', import.meta.url).href
    }
  }
};

/**
 * QA A/B：`#r44ext=off` 显式停用外部壳。
 * R46：改用精确正则（原 `hash.includes('r44ext=off')` 会被新增的 `#r44ext=on` 钩子误伤）。
 */
function shellDisabled(): boolean {
  if (typeof window === 'undefined') return false;
  return /(?:^|[#&])r44ext=off/i.test(window.location.hash);
}

/** R46 QA：`#r44ext=on` 强制高精度（覆盖「默认普通车模」偏好，便于 A/B 对照） */
function shellForcedOn(): boolean {
  if (typeof window === 'undefined') return false;
  return /(?:^|[#&])r44ext=on/i.test(window.location.hash);
}

/**
 * R46 前灯贴图回退开关：`#r46lampmap=off` ⇒ 不挂 emissiveMap（纯 emissive = R44 原行为）。
 *
 * 用途（方案 D 失败后的线上回退通道）：几何线实测 `lamp_front` **灯区三角 UV 采样命中率
 * v800 仅 2.0% / r7 24.1%**（98%/76% 采样到近黑）⇒ atlas 亮片布局与灯区 UV 错位，实拍
 * 「开灯=关灯」黑腔。此开关可**一键回纯 emissive**，避免黑腔；几何线重做 atlas + UV
 * 重映射并验收通过后，缺省路径自动恢复挂图。
 * 也可保留作长期 A/B（对比「纯 emissive」与「图集调制」两种前灯观感）。
 *
 * ⚠ 必须用精确正则，勿用裸 `includes`（会误伤其它 hash）。
 * ⚠ 只影响「挂不挂图」，**不改** `color` / `emissive` / `emissiveIntensity` /
 *   `setHeadlights` 联动（适配器每帧写 `emissiveIntensity`，本开关不介入）。
 */
function lampMapDisabled(): boolean {
  if (typeof window === 'undefined') return false;
  return /(?:^|[#&])r46lampmap=off/i.test(window.location.hash);
}

/**
 * 测试环境隔离硬门禁（主理人指令 2026-11-01）：vitest/node 环境下**绝不**触发
 * 外部壳装配 —— 不发 fetch、不尝试 parse GLB（file:// URL 在 Node fetch 下必败，
 * 即使被 try/catch 吞掉也不允许发生）。判据用 vitest 注入的 `import.meta.env.MODE
 * === 'test'`（Game 装配路径是 dev/prod 运行时，永远不为 test）。
 * ⚠ R46：此门禁仍是 loadExternalShell 的**第一条语句**，新偏好/取消门禁都在其后 ⇒
 *   vitest 下永不读取 localStorage，194 用例行为逐位不变。
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

/**
 * R45：外部壳是异步懒加载，且 V800 单车资产 ~49MB（gzip 传输 ~25MB）。慢网络下
 * 加载要数分钟，此期间游戏显示程序化回退外观 —— 若无提示会被误判「构建没更新」。
 * 这里挂一条轻量状态条：加载中显示已接收字节、就绪短提示、失败常驻告警。
 * ⚠ R46：原 `shellHud` 六个调用点语义**一字不动**（info×2 / ok / null / err），
 *   逐 chunk 的进度刷新改走独立的 `shellHudProgress`（~200ms 节流）。
 */
const SHELL_HUD_ID = 'r44-shell-hud';
function shellHud(text: string | null, tone: 'info' | 'ok' | 'err' = 'info'): void {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(SHELL_HUD_ID) as HTMLDivElement | null;
  if (!text) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = SHELL_HUD_ID;
    el.style.cssText =
      'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:60;' +
      'padding:8px 14px;border-radius:8px;background:rgba(14,11,14,.88);' +
      'font:13px/1.5 system-ui,-apple-system,sans-serif;letter-spacing:.3px;' +
      'pointer-events:none;white-space:nowrap;box-shadow:0 2px 14px rgba(0,0,0,.45)';
    document.body.appendChild(el);
  }
  el.style.color = tone === 'err' ? '#ff9b8a' : tone === 'ok' ? '#a8e6b0' : '#f3e9d2';
  el.textContent = text;
}

/** R46：按 car 计的已接收字节（替换 R45 的模块级全局 shellBytes，避免两车台账互相覆盖） */
const shellBytesByCar: Record<ExternalCarId, number> = { v800: 0, r7: 0 };

let hudTimer: ReturnType<typeof setTimeout> | null = null;
let hudPendingCar: ExternalCarId | null = null;
let hudPendingBytes = 0;

/** 加载完成 / 取消 / 失败时清掉节流定时器 ⇒ 绝不在 L544 移除节点后残留回调重建幽灵进度条 */
function clearHudThrottle(): void {
  if (hudTimer !== null) {
    clearTimeout(hudTimer);
    hudTimer = null;
  }
  hudPendingCar = null;
  hudPendingBytes = 0;
}

/**
 * R46 进度条节流（~200ms）。
 * ⚠ 节点不存在**直接 return、绝不 createElement** —— 创建权只归原 `shellHud`
 *   （L173-182）。否则 L543-544 就绪 4s 后 `shellHud(null)` 移除节点，残留定时回调
 *   会重建一条「幽灵进度条」（REPORT_PHASE1B.md 附录 B.3 / Phase1-C §9.4）。
 * ⚠ 不经过 shellHud：原函数会无条件写 `style.color`/`textContent`，这里把这两行
 *   一并挪进节流块（每 chunk 只做纯数值累加，不做 DOM/CSSOM 写）。
 */
function shellHudProgress(car: ExternalCarId, bytes: number): void {
  if (typeof document === 'undefined') return;
  if (!document.getElementById(SHELL_HUD_ID)) return;
  hudPendingCar = car;
  hudPendingBytes = bytes;
  if (hudTimer !== null) return;
  hudTimer = setTimeout(() => {
    hudTimer = null;
    const activeCar = hudPendingCar;
    const pending = hudPendingBytes;
    hudPendingCar = null;
    hudPendingBytes = 0;
    if (!activeCar) return;
    const el = document.getElementById(SHELL_HUD_ID);
    if (!el) return;
    el.style.color = '#f3e9d2';
    el.textContent =
      `高精度车模加载中 · 已接收 ${(pending / 1048576).toFixed(1)} MB` +
      `（首次加载约 ${SHELL_TOTAL_MB[activeCar]} MB）`;
  }, 200);
}

/**
 * 带字节进度的 fetch：显式校验 HTTP status（404 HTML 喂给 GLTFLoader 的错误不可读）。
 * R46：`signal` 传给 fetch（abort 会让 body stream 的 reader.read() 一并 reject）；
 *      循环头部再显式查一次 `signal.aborted`，防「已收完最后一块但已取消」仍继续。
 */
async function fetchTracked(
  url: string,
  car: ExternalCarId,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('/').pop()}`);
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    if (signal?.aborted) throw new DOMException('shell load cancelled', 'AbortError');
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    shellBytesByCar[car] += value.length;
    if (r44ShellStatus[car].state === 'loading') {
      r44ShellStatus[car].bytes = shellBytesByCar[car];
    }
    shellHudProgress(car, shellBytesByCar[car]);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

/**
 * R46：`THREE.TextureLoader` / `ImageLoader` 没有 signal 接口，是取消链唯一不能直接
 * 透传的点。保守变体 = `fetchTracked(带 signal) → blob: URL → TextureLoader.loadAsync`
 * （blob: 不触发网络），原 `flipY/colorSpace/anisotropy/needsUpdate` 四行**逐位保留**，
 * 零 three 行为变更、不引入 createImageBitmap（Node 缺失 + UV 语义差异风险）。
 * 附带收益：3 张贴图字节也计入 HUD 进度（R45 原实现贴图字节不计入）。
 */
async function loadTexture(
  url: string,
  srgb: boolean,
  car: ExternalCarId,
  signal?: AbortSignal
): Promise<THREE.Texture> {
  const buf = await fetchTracked(url, car, signal);
  const objectUrl = URL.createObjectURL(new Blob([buf]));
  try {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const tex = await loader.loadAsync(objectUrl);
    tex.flipY = false; // glTF UV 约定（独立加载贴图必须显式关）
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  } finally {
    URL.revokeObjectURL(objectUrl); // loadAsync resolve 时 <img> 已解码，revoke 安全
  }
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

/* ══════════════════════════════════════════════════════════════════════════
 * R49-A2 · 阴影投影代理（shadow proxy）
 *
 * 定罪（.qa/r49/PERF_PRESTUDY.md §8①，读码口径）：
 *   R44 引入的高精度外部壳 `body.glb` 966,484 tri + 4 轮 303,521 tri
 *   = **1,270,005 tri**（r7 1,389,955 tri）全部 `castShadow=true`（本文件 :627/:631），
 *   而 R39 起 `Lighting` 的 `sun.shadow.autoUpdate=true` ⇒ **每帧重绘、无节流**，
 *   于是这 1.27M tri 每帧被**再投一遍**进 shadow pass（主 pass 之外的第二遍全顶点）。
 *   而 R38-P1-5 的 caster 瘦身（V800Adapter.ts:4764-4782）在**装配期**遍历 `root`，
 *   外部壳是 `loadExternalShell()` 异步 resolve 之后才挂上树 ⇒ 完全绕过瘦身。
 *
 * 修法（A2，零新资产 / 零 bake 管线改动 / 当日可回滚）：
 *   1. 高模壳本体**退出 shadow pass**（`bodyMesh` + 4 轮 `castShadow = false`）；
 *   2. 在适配器侧把程序化树里 **R38 保留的 castShadow 大件**（V800 实测 13 件 /
 *      19,536 tri，其轮廓已被 R38-P1-6 实证「车影可见轮廓全由这些大件决定」）
 *      各复制一个**只投影、不显影**的代理网格。
 *
 * 代理为什么「不显影」：
 *   - 材质 `MeshBasicMaterial({ colorWrite:false, depthWrite:false })` ⇒ 主 pass 里
 *     这次 draw **不写颜色、不写深度**，画面上零像素；
 *   - 进 shadow pass 时 three 走 `WebGLShadowMap.getDepthMaterial()` 现场派生
 *     `MeshDepthMaterial`（WebGLShadowMap.js:440-516）——它只同步 `visible` /
 *     `wireframe` / `side` / `alphaMap` / `alphaTest` / `map` / `displacement*` /
 *     `clippingPlanes`，**不复制 colorWrite / depthWrite**（同处 :479-505），
 *     所以阴影侧照常写深度，投影行为与原件逐位等价。
 *
 * 为什么不能用 layers / visible 隔离：
 *   three 的 shadow pass 用**主相机**的 layers 判可见性
 *   （WebGLShadowMap.js:522 `object.layers.test(camera.layers)`）⇒ 给代理单独
 *   layer 会连阴影一起被剔掉；而 `object.visible===false`（:520）与
 *   `material.visible===false`（:556）是**双闸门**，任一为假阴影即消失。
 *   ⇒ 代理必须 `visible=true` 且 `material.visible=true`，只能靠 colorWrite/depthWrite 隐身。
 *
 * 几何零增量：代理与原件**共享同一 BufferGeometry**（不 clone、不 dispose）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** `#r49shadowproxy=off` ⇒ 逐位回 R48：高模壳自己投影、不建任何代理 */
const SHADOW_PROXY_OFF_RE = /(?:^|[#&])r49shadowproxy=off/i;

/** 当前是否启用阴影投影代理（Node/vitest 下无 window ⇒ false，保持 R48 行为） */
export function shadowProxyEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return !SHADOW_PROXY_OFF_RE.test(window.location.hash);
}

/**
 * 把程序化树里「仍带 `castShadow` 的大件」（= R38-P1-5 瘦身后保留的那批）
 * 各复制成一个阴影代理，挂到**原件同一个 parent** 下并逐位复制局部变换。
 *
 * 为什么挂同 parent 而不是挂 body：世界变换**恒等**（含轮 `spin` 自转、车体
 * 平移），不需要任何矩阵反解，也不怕后续 `mountExternalWheel` 迁移轮枢轴。
 * `matrixAutoUpdate` / position / quaternion / scale / matrix 全部照抄。
 *
 * 代理打 `userData.r44External=true`：`setExteriorHidden`（V800Adapter.ts:4846）与
 * `setCabinBlocksHidden`（:4842-4884 同族）见到该标记一律跳过 ⇒ 程序化外观整体
 * 隐藏时，代理不会被连带藏掉（阴影常驻）。
 *
 * @param root 程序化车模树根（`model` 或 `root`，内部会过滤掉 r44External 子树）
 * @returns 新建的代理网格数组（供装配期记账/日志用）
 */
export function buildShadowProxies(root: THREE.Object3D): THREE.Mesh[] {
  // 按 side 缓存共享材质：MeshBasicMaterial 默认 FrontSide，但原件可能是
  // BackSide/DoubleSide（合批/翻面件）。shadowSide 由 material.side 派生
  // （WebGLShadowMap.js:488），故**必须跟随原件的 side**，否则背面剔除方向
  // 一变，投影轮廓就会与 R38 基线不一致。
  const matsBySide = new Map<THREE.Side, THREE.MeshBasicMaterial>();
  const matFor = (side: THREE.Side): THREE.MeshBasicMaterial => {
    let m = matsBySide.get(side);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        colorWrite: false,
        depthWrite: false,
        fog: false,
        side
      });
      matsBySide.set(side, m);
    }
    return m;
  };

  // 先收集再挂载：遍历过程中改树会打乱 traverse 的游标
  const sources: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (!m.castShadow) return; // 已被 R38 瘦身/占位件逻辑关掉的，不代理
    if ((m.userData as { r44External?: boolean }).r44External === true) return; // 外部壳本体
    if (!m.parent) return;
    sources.push(m);
  });

  const proxies: THREE.Mesh[] = [];
  for (const src of sources) {
    const parent = src.parent;
    if (!parent) continue; // 理论上不会发生（收集阶段已滤），守住 TS 空安全
    const srcMat = Array.isArray(src.material) ? src.material[0] : src.material;
    const proxy = new THREE.Mesh(src.geometry, matFor(srcMat?.side ?? THREE.FrontSide));
    proxy.name = `r49-shadow-proxy:${src.name || src.uuid}`;
    proxy.visible = true; // 双闸门 ①（WebGLShadowMap.js:520）
    proxy.castShadow = true;
    proxy.receiveShadow = false;
    proxy.matrixAutoUpdate = src.matrixAutoUpdate;
    proxy.position.copy(src.position);
    proxy.quaternion.copy(src.quaternion);
    proxy.scale.copy(src.scale);
    proxy.matrix.copy(src.matrix);
    proxy.matrixWorldNeedsUpdate = true; // 首帧就位（原件可能已 updateMatrixWorld）
    (proxy.userData as { r44External?: boolean }).r44External = true;
    parent.add(proxy);
    proxies.push(proxy);
  }
  return proxies;
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

/** R46：当前加载的 AbortController（供取消订阅回调命中；加载结束置 null） */
let shellAbort: AbortController | null = null;

/**
 * R49-P2b · R7 尾灯带底板 atlas（1024×172，比例 5.95 ≈ 盖板 2.02m×0.34m 的 5.94）。
 *
 * 为什么用 atlas 而不是若干小 Plane：验收要求「视觉改动整帧 DC 上涨 ≤ +3」。
 * 字标 / 两侧灯组内部的白条+红条 / 上下镀铬饰条 全部**画进同一张贴图**，
 * 由**同一块盖板 mesh** 承载 ⇒ 这些细节的额外 DC 恒为 0。
 *
 * UV 约定：PlaneGeometry 的 uv(0,0)=左下、(1,1)=右上；CanvasTexture 默认 flipY=true
 * ⇒ canvas 第 0 行 = v=1 = 盖板**顶边**（世界 y = 1.185）。
 * 世界 y 映射：row = (1.185 − y) / 0.34 × 171。
 *
 * Node/vitest 无 document ⇒ 返回 1×1 占位（外部壳在测试环境根本不会装配，这里只防崩溃）。
 */
function makeR7RearBandAtlas(): THREE.Texture | null {
  // ⚠ 失败必须返回 null：`new THREE.Texture()` 没有 image 时 three 会绑定 1×1 **白**图，
  //   map 白 × color 白 ⇒ 整块盖板变白（正是 R49 初版像素暴涨的直接机制）。
  if (typeof document === 'undefined') return null;
  const W = 1024;
  const H = 172;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;
  // 底板：深墨（官图灯带底色），比纯黑略偏蓝，避免读成「空洞」
  g.fillStyle = '#14141a';
  g.fillRect(0, 0, W, H);
  const yRow = (worldY: number): number => Math.round((1.185 - worldY) / 0.34 * (H - 1));
  // 上下镀铬/深色饰条（2–3 px）
  g.fillStyle = '#2a2a31';
  g.fillRect(0, Math.max(0, yRow(1.175)), W, 3);
  g.fillRect(0, Math.max(0, yRow(0.858)), W, 3);
  // 两侧灯组内部结构：白细条 + 深红条（左右各一组，镜像对称）
  const seg = Math.round(W * 0.336); // 左/右段宽度（盖板 3 段视觉分区：0.336 / 0.328 / 0.336）
  const drawUnit = (x0: number, w: number): void => {
    g.fillStyle = '#5a6068'; // 白细条压暗成暗灰（避免糊成白噪点块）
    g.fillRect(x0 + Math.round(w * 0.18), yRow(1.075), Math.round(w * 0.64), 3);
    g.fillStyle = '#9c2424'; // 深红条（略提亮，黑底上可辨）
    g.fillRect(x0 + Math.round(w * 0.14), yRow(1.005), Math.round(w * 0.72), 5);
    g.fillStyle = '#3a1010'; // 红条下阴影，制造分段层次
    g.fillRect(x0 + Math.round(w * 0.14), yRow(0.995), Math.round(w * 0.72), 3);
  };
  drawUnit(0, seg);
  drawUnit(W - seg, seg);
  // 中段 LUXEED 字标
  g.fillStyle = '#c9ccd2';
  g.font = '600 30px system-ui, -apple-system, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('L U X E E D', W / 2, yRow(1.015));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * R49-P2b · R7 下缘红反光条 atlas（512×32）：透明底 + 左右两段红条。
 * 用 alphaTest 0.5 而非 transparent 混合排序，避免参与透明队列（R12 铁律同源考虑）。
 */
export function makeR7LowerReflectorAtlas(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const W = 512;
  const H = 32;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#6a1d1d';
  g.fillRect(Math.round(W * 0.08), 8, Math.round(W * 0.20), 16);
  g.fillRect(Math.round(W * 0.72), 8, Math.round(W * 0.20), 16);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 门禁优先级（不可倒置，REPORT_PHASE1B.md §2.6）：
 *   ① inTestEnv()            —— vitest/Node 硬隔离，绝不发 fetch、绝不读 localStorage
 *   ② #r44ext=off            —— QA A/B，state:'failed' 原样不动（覆盖用户偏好）
 *   ③ #r44ext=on             —— R46 QA 强制开（覆盖「默认普通车模」偏好）
 *   ④ !isHighDetailEnabled() / isShellLoadCancelled() —— 默认普通车模 / 用户停止
 *   ⑤ 正常加载
 */
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
  const forcedOn = shellForcedOn();
  if (!forcedOn && (!isHighDetailEnabled() || isShellLoadCancelled())) {
    // 零 fetch：直接返回 null ⇒ 两个 Adapter 的 `if (!shell) return` 保持程序化外观完整
    r44ShellStatus[car] = {
      state: 'cancelled',
      error: `default procedural (${shellCancelReason() ?? 'preference'})`,
      bytes: 0
    };
    shellHud('已按设置使用默认车模（未下载高精度模型）', 'ok');
    return null;
  }

  const ac = new AbortController();
  shellAbort = ac;
  const unsubscribe = onShellCancel(() => {
    ac.abort(new DOMException('shell load cancelled', 'AbortError'));
  });
  shellBytesByCar[car] = 0;
  r44ShellStatus[car] = { state: 'loading', bytes: 0 };
  clearHudThrottle();
  shellHud(`高精度车模加载中 · 正在连接…（首次加载约 ${SHELL_TOTAL_MB[car]} MB）`);
  try {
    const urls = ASSET_URLS[car];
    const res = await fetch(urls.manifest, { signal: ac.signal });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const manifest = (await res.json()) as ExternalManifest;
    const loader = new GLTFLoader();
    // 切割退化支持：manifest 无 wheel-* tri 计数 = 静态轮（整车单 mesh），跳过轮文件
    const hasWheelSplit = manifest.tri['wheel-fl'] != null;
    // R44-6 语义部件可选加载：文件缺失/旧 manifest 无字段时静默跳过（程序化回退不受影响）
    const hasSemantic = manifest.semantic != null;
    const fetchGlb = (url: string | undefined): Promise<{ scene: THREE.Object3D } | null> =>
      !url || ac.signal.aborted
        ? Promise.resolve(null)
        : fetchTracked(url, car, ac.signal)
            .then((buf) => loader.parseAsync(buf, ''))
            .catch(() => null);
    /**
     * R46 前灯图集（几何线并行产出）：
     *  - 尚未到位 / 404 / 解码失败 ⇒ `.catch(() => null)` 吞掉，材质维持纯 emissive，
     *    **绝不 throw 破坏整壳加载**（L461-481 原失败语义不变）；
     *  - 纳入同一 signal ⇒ 点「停止下载」时贴图请求一并中止。
     */
    const lampAtlasTexPromise: Promise<THREE.Texture | null> = hasSemantic && urls.lampFrontAtlas
      ? loadTexture(urls.lampFrontAtlas, true, car, ac.signal).catch(() => null)
      : Promise.resolve(null);
    const [
      bodyGltf, wlGltf, wrGltf, glassGltf, lfGltf, lrGltf,
      baseTex, nrmTex, mrTex, lampAtlasTex
    ] = await Promise.all([
      fetchTracked(urls.body, car, ac.signal).then((buf) => loader.parseAsync(buf, '')),
      hasWheelSplit
        ? fetchTracked(urls.wheelL, car, ac.signal).then((buf) => loader.parseAsync(buf, ''))
        : Promise.resolve(null),
      hasWheelSplit
        ? fetchTracked(urls.wheelR, car, ac.signal).then((buf) => loader.parseAsync(buf, ''))
        : Promise.resolve(null),
      hasSemantic ? fetchGlb(urls.glass) : Promise.resolve(null),
      hasSemantic ? fetchGlb(urls.lampFront) : Promise.resolve(null),
      hasSemantic ? fetchGlb(urls.lampRear) : Promise.resolve(null),
      loadTexture(urls.basecolor[variant] ?? urls.basecolor[manifest.variants[0].id], true, car, ac.signal),
      loadTexture(new URL(`../../assets/cars/${car}/normal.png`, import.meta.url).href, false, car, ac.signal),
      loadTexture(new URL(`../../assets/cars/${car}/mr.png`, import.meta.url).href, false, car, ac.signal),
      lampAtlasTexPromise
    ]);
    // GLTFLoader.parseAsync 是纯 CPU 不可中断；Promise.all 之后再查一次，已取消就不装配
    if (ac.signal.aborted) throw new DOMException('shell load cancelled', 'AbortError');
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
    /* R49-A2：高模壳本体退出 shadow pass —— 每帧 1.27M tri（r7 1.39M）的第二遍投影
     * 改由适配器侧的低模代理承担（见 buildShadowProxies 头注）。
     * `#r49shadowproxy=off` ⇒ 逐位回 R48：壳自己投影、适配器不建代理。 */
    const proxyMode = shadowProxyEnabled();
    bodyMesh.castShadow = !proxyMode;
    bodyMesh.receiveShadow = false;
    for (const mesh of Object.values(wheelMeshes)) {
      mesh.material = material;
      mesh.castShadow = !proxyMode; // R49-A2：同 bodyMesh，四轮也退出 shadow pass
    }
    bodyMesh.scale.setScalar(manifest.scale);

    /* ── R47：外部轮「内外侧装反」修复（用户点名，几何定罪见 .qa/r47/geom_probe_out.txt）──
     * 定量证据：wheel-l(fl/rl) 内圈(r<0.045)面法线 nx>0.8、重心 x≈+0.025 ⇒ 轮毂正面
     *   朝 +x；wheel-r(fr/rr) 朝 −x。即 **GLB 几何本身正确**（左右轮毂面都朝各自车外）。
     * 根因：body 组带 rotY(π)（V800Adapter.ts:1826）⇒ hubWorld.x = −hubModel.x·scale；
     *   而 mountExternalWheel 的 desired = T(hubWorld)×S(scale) **不含这个刚性旋转**，
     *   轮几何的 +x 仍是世界 +x，与车身差 180° ⇒ 左右轮毂正面一起翻到车身内侧
     *   （用户截图 #27/#28：车底视角看到辐条朝车身中心、纯黑胎背朝车外）。
     * 修法：只把轮几何绕 Y 刚性旋转 π（x,z→−x,−z；法线同步；行列式 +1 ⇒ 绕序不变），
     *   使其与 body 组同朝向。零资产变更、零挂载矩阵变更、零自转影响 —— 轮 bbox 中心
     *   ≈(0,0,0)（已 hub 归中），旋转后仍居中；对称轴 X→−X 方向不变，spin 绕世界 X
     *   自转语义逐位保持；UV / tri / vtx / mesh 名全部不变。
     * QA 回滚：`#r47wheel=off` ⇒ 保持 R46 原状（A/B 唯一变量）。 */
    if (!/(?:^|[#&])r47wheel=off/i.test(
      typeof window === 'undefined' ? '' : window.location.hash
    )) {
      const rotated = new Set<THREE.BufferGeometry>();
      for (const mesh of Object.values(wheelMeshes)) {
        if (rotated.has(mesh.geometry)) continue;
        rotated.add(mesh.geometry);
        mesh.geometry.rotateY(Math.PI);
      }
    }

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
    // lamp-rear：刹车灯 emissive 随 brakeLevel（适配器 update() 驱动）
    // lamp-front：DRL 常亮冷白，setHeadlights 联动。
    let lampRearMat: THREE.MeshStandardMaterial | null = null;
    let lampFrontMat: THREE.MeshStandardMaterial | null = null;
    /** R48：R7 尾灯洞口盖板材质（唯一新增材质实例，dispose 显式释放） */
    let lampHousingMat: THREE.MeshStandardMaterial | null = null;
    /** R49-P2b：红细带材质（与 lampRearMat 拆开，避免改色连带灯组） */
    let r49BandMat: THREE.MeshStandardMaterial | null = null;
    /** R49-P2b：本波新增的材质/贴图账本（dispose 用；只登记 R49 自己新建的） */
    const r49DecorMats: THREE.Material[] = [];
    const r49DecorTex: THREE.Texture[] = [];
    /** R46：前灯最终是否挂了 emissiveMap（供 r44ShellStatus.lampMap 机读） */
    let hasLampMap = false;
    const lampRearMeshes: THREE.Mesh[] = [];
    const lampFrontMeshes: THREE.Mesh[] = [];
    if (lrGltf) {
      // R44-6 终版 + R46 保持：**去 map 纯 emissive** —— QA front34/rear34 实测
      // map=baseTex 时灯组 UV 区在源图集上是串色/暗区（前灯区橙色块显形 = 前脸
      // 「破面感」根因）。尾灯归位由几何线替换 lamp_rear.glb 完成，材质无需动。
      lampRearMat = new THREE.MeshStandardMaterial({
        color: 0x1a0505,
        emissive: new THREE.Color(0xff1e14),
        emissiveIntensity: 0.35,
        roughness: 0.25,
        metalness: 0.1
      });
      collectNamed(lrGltf, lampRearMeshes, lampRearMat, manifest.scale);

      /* R48：R7 尾灯「空洞」补洞修复（用户口径：白块更深处其实是空洞）。
       * 定罪链（.qa/r48 + verify/r46/after/r48elim_*）：
       *  ① 消去法：隐藏 lamp_rear 白块 4,218 px 不变；隐藏 body 白块→376 px、
       *     红灯像素 6,037→18,883 ⇒ 白块长在 body 上，且 body 一直挡着红灯组。
       *  ② 离线深度（世界 Z，越大越靠车尾）：body 尾灯带 max 2.4942 m，
       *     R47 灯组 max 2.4811 m ⇒ 中段被挡 3.4 cm；两侧灯组虽略外但
       *     body 在洞口位置仍是破面 ⇒ 用户看到的「空材质」实为剔除灯组后
       *     body 未补齐的洞，深层内容透出，high 档 bloom 下吹成纯白。
       * 修法（零 GLB 改动）：① 加一块深色灯罩盖板封住 body 洞口；② 灯组外推
       *   0.06 m 压到盖板之前；③ 贯穿红细带压最外层。
       *   （只外推 0.025 m 实测 A/B 仅 634 px，洞在灯组旁边，平移盖不住。）
       *   ⚠ mesh.scale 只缩放几何顶点、不缩放 position（R47 铁律）：
       *     body 局部 z = −0.025，经 body.rotation.y=π 后世界 +0.025 m。
       *   再补一条贯穿红细带（R47 灯组中段仅 1,412 tri，中部仍是黑横带）。
       * 回滚：`#r48hole=off` ⇒ 不外推、不加红带，逐位回到 R47 原状。 */
      if (car === 'r7' && lampRearMat &&
          !/(?:^|[#&])r48hole=off/i.test(
            typeof window === 'undefined' ? '' : window.location.hash
          )) {
        const s = manifest.scale;
        /* ══ R49-P2b：盖板 / 红细带 / 下缘反光条重做（尺寸与 z 全部来自射线实测）══
         * 定罪见 `.qa/r49/PHASE2B_DIAG.md` §三（探针 `tools/r49_rear_probe.mjs`）：
         *  ① **主因 = 盖板 z 比 body 最外层还深 14.4 mm ⇒ 被 body 自遮挡**
         *     r7: bodyBBox.max[2]=0.582810 × scale 4.323 = **2.5194 m**（世界最外层），
         *     而 R48 盖板在 2.505 m ⇒ 差 −14.4 mm。工单要求的「body 最外层 + 8~12 mm」
         *     应为 2.527~2.531 ⇒ 取 **bodyMaxZ + 0.010**。
         *  ② 次因 = 高度不足：R48 `PlaneGeometry(2.02, 0.20)`（中心 y=1.0375）只覆盖
         *     y∈[0.9375,1.1375]；射线实测白块世界 y∈[**0.893**, 1.089] ⇒ 底边高 44.5 mm
         *     露白。改为高 **0.34 m**、中心 **1.015**（覆盖 y∈[0.845,1.185]，上下各 ~45 mm 余量）。
         *     （工单按像素比例估的 0.51 m 偏大：实测白块世界高度 0.197 m。）
         *  ③ 射线次命中 7/24 = `batch/leather-ivory` ⇒ 洞后是米黄内饰，印证「补洞」方向。
         * 启用：`#r49hole=on` ⇒ 尺寸/z 逐位为 R49 盖板（0.34 / 1.015 / z=-(bodyMaxZ+0.010)）；**默认关闭**走 R48。
         * ⚠ 旧口径下盖板命中率仍有 5/24（它确实在最前）——所以不是「完全无效」，
         *   只是**边缘一圈没盖住**，正是 bloom 最容易吹白的位置。 */
        /* ⚠ R49-P2c 收口裁决：**默认不启用** R49 盖板（回归 R48 已验收观感）。
         *   rubric 证实材质/atlas 压暗对白噪点**零效果**（逐位 3383/1842/515/853）——白噪点是 body
         *   洞/灯组的 **UV 串味灰白**（在盖板之外，运行时改不动），必须回 bake 管线重映射 UV（R50）。
         *   而黑板盖板又**左右超出车身轮廓悬空**、比 R48 的白块更违和 ⇒ 强改是负收益。
         *   ⇒ 默认走 R48 分支（盖板 z=2.505 被遮挡，不显示黑板）；R50 修 UV 后用 `#r49hole=on` 启用。
         *   全部 R49 盖板/atlas/材质代码**保留不删**，便于 R50 一键启用。 */
        const r49Hole = /(?:^|[#&])r49hole=on/i.test(
          typeof window === 'undefined' ? '' : window.location.hash
        );
        /* ⚠ R49-P2c：**几何回退 v1**（盖板宽 2.02 + z=-(bodyMaxZ+0.010)，bodyMaxZ 用 manifest×scale）。
         *   v2 那版「lampMaxZ 反推 + 实测收窄」导致覆盖面积不足——两侧露出更多白/米黄
         *   （rubric：WHITE 3383→4322、BEIGE 853→1448、最大连通域 1842→2323，全部变差），
         *   按主理人裁决**回退几何覆盖**，**只保留 v2 的 atlas/材质压暗**（那些只会更好）。
         *   教训：bodyMaxZ 用 manifest×scale=2.5194 时 z 落 2.5294，恰好压住洞区；改用实测反推落 2.535
         *   反而把盖板整体上移、下沿离开洞区顶部（y≈1.185）而露白。 */
        const bodyMaxZ = (manifest.bodyBBox?.max?.[2] ?? 0.5828) * s;
        const coverY = r49Hole ? 1.015 : 0.240 * s;
        const coverH = r49Hole ? 0.34 : 0.20;
        lampHousingMat = new THREE.MeshStandardMaterial({
          color: r49Hole ? 0x141418 : 0x101014,
          map: r49Hole ? (makeR7RearBandAtlas() ?? undefined) : undefined,
          emissive: new THREE.Color(0x1a0000),
          emissiveIntensity: 0.2,
          /* R49-P2b 实测：平板 + metal .35/rough .35 会把 PMREM 天空**整面镜面反射**进来，
           * ROI 纯白 273 → 3,383 px。压到 metal .06 / rough .70 / envInt .45（v2 保留项）。 */
          roughness: r49Hole ? 0.70 : 0.5,
          metalness: r49Hole ? 0.06 : 0.1,
          envMapIntensity: r49Hole ? 0.45 : 1,
          side: THREE.DoubleSide
        });
        const housing = new THREE.Mesh(
          new THREE.PlaneGeometry(2.02, coverH), lampHousingMat);
        housing.name = 'lamp_rear_housing';
        housing.position.set(0, coverY, r49Hole ? -(bodyMaxZ + 0.010) : -2.505);
        housing.rotation.y = Math.PI;
        housing.castShadow = false;
        housing.renderOrder = 1;
        lampRearMeshes.push(housing);
        // ② 灯组外推 0.06 m（R48 已验收，逻辑不动）
        for (const m of lampRearMeshes) {
          if (m.name === 'lamp_rear') m.position.z = -0.06;
        }
        // ③ 贯穿红细带：高 0.018、色 #5A1E1E、emissiveIntensity 0.35，z=-(bodyMaxZ+0.021)（回退 v1）
        r49BandMat = r49Hole
          ? new THREE.MeshStandardMaterial({
              color: 0x1a0505,
              emissive: new THREE.Color(0x5a1e1e),
              emissiveIntensity: 0.35,
              roughness: 0.35,
              metalness: 0.2,
              side: THREE.DoubleSide
            })
          : lampRearMat;
        const band = new THREE.Mesh(
          new THREE.PlaneGeometry(1.86, r49Hole ? 0.018 : 0.055), r49BandMat);
        band.name = 'lamp_rear_band';
        band.position.set(0, r49Hole ? 1.13 : 0.240 * s, r49Hole ? -(bodyMaxZ + 0.021) : -0.5885 * s);
        band.rotation.y = Math.PI;
        band.castShadow = false;
        band.renderOrder = 2;
        lampRearMeshes.push(band);
        /* ④ 下缘红反光条 —— **本轮下线**（代码保留在 makeR7LowerReflectorAtlas）。
         * 原因（.qa/r49/probe_v4/v5.log 实测）：该件是 `transparent+alphaTest` 的
         * 1.90m×0.055m 平面，实测 ROI 纯白 273 → **3,383 px**，白增量面积≈434×6 px
         * ≈ 整块反光条平面的投影面积 ⇒ 在 headless/SwiftShader 下这张 canvas 的
         * **alpha 未被正确采样**，整块平面按不透明白渲染。它比它要遮的东西更糟，
         * 故本波先移除；待 landing-review 在真实 GPU 上确认 alpha 通道行为后再启用。
         * 保留 `#r49hole=off` 与下方注释，避免下一位同学重复踩。 */
      }
    }
    if (lfGltf) {
      lampFrontMat = new THREE.MeshStandardMaterial({
        color: 0x0a0c10,
        emissive: new THREE.Color(0xcfe0ff),
        emissiveIntensity: 0.7,
        roughness: 0.2,
        metalness: 0.15
      });
      /**
       * R46 前灯贴图接线（用户点名「前车灯贴图一片白色」）。
       * 选 **emissiveMap** 而非 map：本材质 color 近黑、亮度几乎全部来自均匀的
       * `emissive=0xcfe0ff`，挂 map 只改 diffuse、emissive 仍均匀 ⇒ 一片白照旧；
       * emissiveMap 直接按裁片 RGB 调制发光（非灯区黑 ⇒ 不发光），才真正显出灯区细节。
       * 且不设 transparent/alphaTest ⇒ 不引入新的透明排序与额外 draw call
       * （R12 铁律⑤：玻璃走 transparent alpha，灯组不碰 transmission）。
       * `flipY=false` + SRGBColorSpace 由 loadTexture 保证；UV 已由几何线逐三角重打包。
       * 图集缺失/加载失败时 lampAtlasTex=null ⇒ 维持纯 emissive，优雅降级。
       *
       * R46 回退开关：`#r46lampmap=off` ⇒ 强制不挂（纯 emissive，R44 原行为）。
       *   适用：atlas 亮片与灯区 UV 错位导致「黑腔」（v800 灯区采样命中率仅 2.0%）。
       *   仅在 atlas 已成功加载后参与判断；atlas 缺失仍走上面的 `.catch(()=>null)` 降级。
       *   回退时 `emissiveMap = null` + `needsUpdate`，其余材质属性与联动**一律不动**。
       */
      hasLampMap = lampAtlasTex != null && !lampMapDisabled();
      if (hasLampMap) {
        lampFrontMat.emissiveMap = lampAtlasTex;
        lampFrontMat.needsUpdate = true;
      }
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
          // 变体切换发生在加载完成之后，无在途 signal（不传第 4 参）
          const tex = await loadTexture(url, true, car);
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
      setGlassOpaque(opaque: boolean): void {
        if (glassMode === 'solid' || glassMode === 'off') return; // QA A/B 钩子优先
        const next = opaque ? 1 : 0.55;
        if (glassMat.opacity === next) return;
        glassMat.opacity = next; // transparent 恒 true ⇒ 0.55→1 完全覆盖后方内饰
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
        lampHousingMat?.dispose();
        // R49-P2b：本波新增的材质与贴图（避免新增实例泄漏）
        if (r49BandMat && r49BandMat !== lampRearMat) r49BandMat.dispose();
        for (const m of r49DecorMats) if (m !== r49BandMat) m.dispose();
        for (const t of r49DecorTex) t.dispose();
        lampAtlasTex?.dispose();
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
      tri: manifest.tri?.body ?? undefined,
      bytes: shellBytesByCar[car],
      // R46：QA 探针机读「前灯是否挂了图集」（false = 纯 emissive 回退）
      lampMap: hasLampMap
    };
    shellHud('高精度车模已就绪', 'ok');
    globalThis.setTimeout(() => shellHud(null), 4000);
    return handle;
  } catch (err) {
    if (ac.signal.aborted || isShellLoadCancelled()) {
      // 取消 ≡ 既有失败回退：返回 null ⇒ 适配器 `if (!shell) return` 保持程序化外观
      r44ShellStatus[car] = {
        state: 'cancelled',
        error: `cancelled by ${shellCancelReason() ?? 'user'}`,
        bytes: shellBytesByCar[car]
      };
      shellHud('已停止下载高精度模型 · 当前使用默认车模', 'ok');
      return null;
    }
    r44ShellStatus[car] = { state: 'failed', error: String(err), bytes: shellBytesByCar[car] };
    shellHud(`高精度车模加载失败，当前显示简化外观 · ${String(err).slice(0, 90)}`, 'err');
    console.warn(`[ExternalShell] ${car} 装载失败，保持程序化外观：`, err);
    return null;
  } finally {
    clearHudThrottle();
    if (shellAbort === ac) shellAbort = null;
    unsubscribe();
  }
}
