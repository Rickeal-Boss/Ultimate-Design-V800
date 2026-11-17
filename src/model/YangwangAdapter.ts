/**
 * 仰望 U8L（第三辆车）运行时适配器 · R92。
 *
 * 路径 C：扫描 GLB 负责外观（烘焙产物 `src/assets/cars/yangwang/yangwang.glb`），
 * 车内**复用 V800 程序化内饰**（直接挂 `createV800CarAdapter(tier).body`，
 * 只保留其座舱子树；车外态整棵隐藏、车内态调它的 applyVisibility(true)）。
 * 这样不必为仰望重做仪表/座椅/踏板/方向盘，也不碰 V800/R7 的冻结文件。
 *
 * 契约坐标：root = 物理中枢（identity）；body.rotation.y = π 把工厂 +Z 车头
 * 对齐世界 -Z；shell 子组 scale=4.5 把扫描原生 bbox（长 1.1716m）放到 5.27m。
 * 烘焙阶段已把纹理.glb 的 rotX(+90°) 烘进顶点，运行时不再二次旋转。
 *
 * 爆胎视觉：`snapTire(index)` 只改独立 `deform` 组的 scale.y / rotation.z，
 * 绝不动 body 姿态；`spin` 组仍是唯一的绕 X 滚动轴，半径换算不受形变影响。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CarLike, WheelPivot, CarVisibilityState } from './V800Adapter';
import { createV800CarAdapter } from './V800Adapter';
import { createYangwangDetails, YANGWANG_DETAIL_IDLE } from './parts/yangwangFront';
import { setFxWheelOffsets } from '../fx';
import { damp } from '../util/math';
import type { QualityTier } from '../config/quality';

export type { CarLike, WheelPivot };

/** 扫描原生 bbox 到目标车长 5.27m 的统一缩放（1.1716 × 4.5 ≈ 5.27）。 */
const SHELL_SCALE = 4.5;
/** 原生轮半径（拆解.glb 四轮 bbox y 跨度 0~0.157 / 2），乘 scale 后 0.353m。 */
const NATIVE_WHEEL_RADIUS = 0.0785;
const WHEEL_SPIN_RADIUS = NATIVE_WHEEL_RADIUS * SHELL_SCALE;
/** 与 V800 相同的视觉轮速系数 + 20 开窗奈奎斯特钳位，禁止改值。 */
const MS_TO_RPM_SCALE = 2.6;
const MAX_WHEEL_STEP_PER_FRAME = (Math.PI / 20) * 0.9;
/** 轮轴 native 中心（+X = 左，与 V800 WHEEL_HUB_CENTERS 同约定；+Z = 车头）。 */
const HUBS_NATIVE: ReadonlyArray<readonly [number, number, number]> = [
  [0.187, 0.0785, 0.363 - 0.0075], // fl
  [-0.187, 0.0785, 0.363 - 0.0075], // fr
  [0.187, 0.0785, -0.348 - 0.0075], // rl
  [-0.187, 0.0785, -0.348 - 0.0075] // rr
];
const DETAIL_IDLE = YANGWANG_DETAIL_IDLE;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Game.pollShellGate 读的 window.__r44Shell 台账；model 层不 import config/ExternalShell。 */
type ShellLedger = Record<string, { state?: string }>;
function setYangwangShellState(state: 'loading' | 'ready' | 'failed'): void {
  if (typeof window === 'undefined') return;
  const host = window as unknown as { __r44Shell?: ShellLedger };
  const prev = host.__r44Shell ?? {};
  // 浅合并：v800/r7 两个 key 原样保留，绝不覆盖其他车的装载态。
  host.__r44Shell = { ...prev, yangwang: { ...(prev.yangwang ?? {}), state } };
}

/**
 * 三处车内机位（**装配局部坐标**，未含 body.rotation.y=π；CameraRig 会把 x/z 取反）。
 * driver 值与 CameraRig 内置 cabin 回退逐位等价（世界 [-0.40,1.34,-0.72] → 局部
 * [+0.40,1.34,+0.72]），所以三机位注入不会改变既有主驾视角；passenger/rear 仅把
 * 原本重合成同一 cabin 偏移的两个槽位分开，适配复用 V800 座舱的左右座位与后排。
 */
const YANGWANG_INTERIOR_VIEWS = {
  driver: { eye: [0.40, 1.34, 0.72], target: [0.30, 0.98, 9.0] },
  passenger: { eye: [-0.40, 1.34, 0.72], target: [-0.30, 0.98, 9.0] },
  rear: { eye: [0.0, 1.30, -1.20], target: [0.0, 1.02, 9.0] }
} as const;

interface WheelRig {
  readonly anchor: THREE.Group;
  readonly deform: THREE.Group;
  readonly spin: THREE.Group;
  readonly fallback: THREE.Mesh;
  loaded: THREE.Mesh | null;
}

/** 把原厂图集色乘上变体 tint：null / champagne = 完全不碰（原厂香槟金）。 */
function applyPaintVariant(materials: Iterable<THREE.Material>, paintId: string | null): void {
  if (paintId === null || paintId === 'champagne') return;
  const tint: Record<string, { color: number; metalness: number; roughness: number }> = {
    obsidian: { color: 0x4c5058, metalness: 0.72, roughness: 0.22 },
    black: { color: 0x454950, metalness: 0.68, roughness: 0.24 },
    pearl: { color: 0xf4f4f2, metalness: 0.28, roughness: 0.32 },
    white: { color: 0xf4f4f2, metalness: 0.28, roughness: 0.32 },
    amber: { color: 0xe0ac22, metalness: 0.5, roughness: 0.3 },
    deepblue: { color: 0x6684bd, metalness: 0.62, roughness: 0.28 }
  };
  const spec = tint[paintId];
  if (!spec) return;
  for (const mat of materials) {
    const std = mat as THREE.MeshStandardMaterial;
    if (!std.isMeshStandardMaterial) continue;
    std.color.setHex(spec.color);
    std.metalness = spec.metalness;
    std.roughness = spec.roughness;
    std.needsUpdate = true;
  }
}

/**
 * @param tier 质量档（透传给 V800 内饰适配器）
 * @param paintId 外观变体；null / 'champagne' = 原厂香槟金（与 resolveAssemblyPaintId 语义一致）
 */
export function createYangwangCarAdapter(tier: QualityTier = 'high', paintId: string | null = null): CarLike {
  const root = new THREE.Group();
  root.name = 'yangwang-root';
  const body = new THREE.Group();
  body.name = 'yangwang-body-pivot';
  body.rotation.y = Math.PI;
  root.add(body);

  // 扫描壳容器：烘焙后的 GLB body + 四轮 anchor 均在此坐标（native 米，整体 ×4.5）。
  const shell = new THREE.Group();
  shell.name = 'yangwang-shell';
  shell.scale.setScalar(SHELL_SCALE);
  body.add(shell);

  // 程序化灯/徽标细节（装配局部坐标，米）。
  const details = createYangwangDetails();
  body.add(details.group);

  // 复用 V800 座舱：只把它的 body 子组挂进来，并把它的内部基准偏航清零，
  // 避免与仰望 body 的 π 叠成 2π（座舱会朝车尾）。V800.root 保持游离，
  // dispose 时仍由 v800.dispose() 释放其自有资源。
  // R93：interiorOnly=true —— 复用 V800 程序化座舱但**绝不下载 v800 外部壳**（28MB），
  // 否则与 yangwang 自身 GLB 并发下载会拖死加载门（线上 3/3 复现的 P0 卡加载）。
  const v800 = createV800CarAdapter(tier, undefined, { interiorOnly: true }) as CarLike & {
    applyVisibility?: (s: CarVisibilityState) => void;
  };
  const interiorRoot = v800.body;
  interiorRoot.rotation.y = 0;
  interiorRoot.name = 'yangwang-v800-interior';
  interiorRoot.visible = false;
  markV800Subtree(interiorRoot);
  body.add(interiorRoot);
  // R94 · 车内态「米黄色光面中间隔板」根治（只动材质 visible，零几何 / 零新增 DC）。
  cullV800ExteriorMaterials(interiorRoot);

  // ---- 四轮 rig：anchor → deform（爆胎形变）→ spin（唯一滚动轴）→ mesh ----
  const rigs: WheelRig[] = [];
  const wheels: WheelPivot[] = [];
  const tireGeo = new THREE.CylinderGeometry(NATIVE_WHEEL_RADIUS, NATIVE_WHEEL_RADIUS, 0.13, 20);
  tireGeo.rotateZ(Math.PI / 2);
  const fallbackTireMat = new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.9 });
  for (let i = 0; i < 4; i++) {
    const anchor = new THREE.Group();
    anchor.name = `yangwang-wheel-${i}-anchor`;
    anchor.position.set(HUBS_NATIVE[i][0], HUBS_NATIVE[i][1], HUBS_NATIVE[i][2]);
    const deform = new THREE.Group();
    deform.name = `yangwang-wheel-${i}-deform`;
    const spin = new THREE.Group();
    spin.name = `yangwang-wheel-${i}-spin`;
    const fallback = new THREE.Mesh(tireGeo, fallbackTireMat);
    fallback.name = `yangwang-wheel-${i}-fallback`;
    spin.add(fallback);
    deform.add(spin);
    anchor.add(deform);
    shell.add(anchor);
    rigs.push({ anchor, deform, spin, fallback, loaded: null });
    wheels.push({ spin });
    // 制动钳挂在 deform 下：随轮心位移但不随轮辐旋转。
    // 制动钳必须待在轮辋内侧：native 坐标下轮宽 x∈[±0.154,±0.221]，
    // 旧写法把 offset 放到 outward +0.055（×4.5 = 0.25m）⇒ 方块飘到车门腰线下。
    // 现改 inward −0.022（左右符号相反），并缩小到轮内可容纳的尺寸。
    const caliper = new THREE.Mesh(
      new THREE.BoxGeometry(0.008, 0.028, 0.040),
      details.caliperMaterials[0]
    );
    caliper.position.set(HUBS_NATIVE[i][0] > 0 ? -0.022 : 0.022, 0.020, 0.006);
    // 官图轮心无红色卡钳；近景里任何外露红块都读成穿帮。保留材质/挂载契约但不出图。
    caliper.visible = false;
    deform.add(caliper);
  }

  // 扫描壳未到达前的兜底车身（避免第三辆车在慢网/加载失败时完全消失）。
  const fallbackBodyMat = new THREE.MeshStandardMaterial({
    color: 0xc9a86b,
    metalness: 0.45,
    roughness: 0.42
  });
  const fallbackBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.49, 0.33, 1.16),
    fallbackBodyMat
  );
  fallbackBody.position.set(0, 0.17, -0.0328);
  fallbackBody.name = 'yangwang-fallback-body';
  shell.add(fallbackBody);

  // fx 轮位与世界系对齐（body.rotation.y = π ⇒ 世界 xz = −native xz × scale）。
  setFxWheelOffsets(
    HUBS_NATIVE.map(([x, , z]) => [-x * SHELL_SCALE, -z * SHELL_SCALE] as const)
  );

  let disposed = false;
  let shellReady = false;
  let brakeTarget = 0;
  let brakeLevel = 0;
  let snapT = 0;
  let headTarget: number = DETAIL_IDLE.head;
  let headLevel: number = DETAIL_IDLE.head;
  let heat = 0;
  let lastSpeedKmh = 0;
  let lastForceN = 0;
  let lastG = 0;
  let lastGear = 'P';
  let lastClusterAt = -1;
  const bodyMaterials = new Set<THREE.Material>();

  // GLB 异步装载；Node/测试环境不触发网络，保持 fallback 壳可构造。
  if (typeof window !== 'undefined') {
    const loader = new GLTFLoader();
    const url = new URL('../assets/cars/yangwang/yangwang.glb', import.meta.url).href;
    loader.load(
      url,
      (gltf) => {
        if (disposed) {
          disposeGltf(gltf.scene);
          return;
        }
        // P0：GLB 已解析、尚未挂树 ⇒ 台账先置 loading（Game 加载门主路径读此表）。
        setYangwangShellState('loading');
        const bodyNode = gltf.scene.getObjectByName('yangwang-body');
        if (bodyNode) {
          bodyNode.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            // P0：Game.hasMountedExternalShell 靠此标记确认 GLB 真已挂树（与 V800/R7 同构）。
            (mesh.userData as { r44External?: boolean }).r44External = true;
            const arr = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (const mat of arr) bodyMaterials.add(mat);
          });
          shell.add(bodyNode);
        }
        for (let i = 0; i < 4; i++) {
          const tag = ['wheel-fl', 'wheel-fr', 'wheel-rl', 'wheel-rr'][i];
          const node = gltf.scene.getObjectByName(tag);
          const src = node
            ? (((node as THREE.Mesh).isMesh
                ? node
                : node.children.find((c) => (c as THREE.Mesh).isMesh)) as
                | THREE.Mesh
                | undefined)
            : undefined;
          if (!src) continue;
          // 烘焙时轮几何已 hub 居中；清掉源节点平移，避免 anchor 上二次位移。
          const mesh = new THREE.Mesh(src.geometry, src.material);
          mesh.name = `${tag}-runtime`;
          (mesh.userData as { r44External?: boolean }).r44External = true;
          mesh.position.set(0, 0, 0);
          mesh.rotation.set(0, 0, 0);
          mesh.scale.set(1, 1, 1);
          rigs[i].spin.add(mesh);
          rigs[i].loaded = mesh;
          rigs[i].fallback.visible = false;
        }
        fallbackBody.visible = false;
        applyPaintVariant(bodyMaterials, paintId);
        shellReady = true;
        setYangwangShellState('ready');
        setFxWheelOffsets(
          HUBS_NATIVE.map(([x, , z]) => [-x * SHELL_SCALE, -z * SHELL_SCALE] as const)
        );
      },
      undefined,
      () => {
        // 缺资产时静默保留 fallback 壳；不把本机路径/网络细节写进日志。
        if (!disposed) {
          shellReady = false;
          setYangwangShellState('failed');
        }
      }
    );
  }

  const applyVisibility = (state: CarVisibilityState): void => {
    const interior = !!state.interior;
    // 扫描壳与细节只在车外绘制；车内交给 V800 程序化座舱（R91 教训：1.5M 母版糊屏）。
    shell.visible = !interior;
    details.group.visible = !interior;
    interiorRoot.visible = interior;
    v800.applyVisibility?.({ interior });
  };
  // 首帧基线：车外态。
  applyVisibility({ interior: false });

  const api: CarLike = {
    root,
    body,
    wheels,
    get currentHeat() {
      return heat;
    },
    set currentHeat(value: number) {
      heat = clamp01(value);
    },
    spinWheels(dist: number, _dt: number): void {
      const raw = (dist / WHEEL_SPIN_RADIUS) * MS_TO_RPM_SCALE;
      const step = Math.sign(raw) * Math.min(Math.abs(raw), MAX_WHEEL_STEP_PER_FRAME);
      if (step === 0) return;
      for (const rig of rigs) {
        const next = rig.spin.rotation.x - step;
        rig.spin.rotation.x = THREE.MathUtils.euclideanModulo(next + Math.PI, Math.PI * 2) - Math.PI;
      }
    },
    setBrakeLights(intensity: number): void {
      brakeTarget = intensity;
    },
    flashBrakeSnap(): void {
      snapT = 1;
    },
    setHeadlights(on: boolean): void {
      headTarget = on ? 1.25 : DETAIL_IDLE.head;
    },
    setBrakeHeat(t: number): void {
      heat = clamp01(t);
    },
    updateCluster(speedKmh: number, forceN: number, g: number, gear: string): void {
      lastSpeedKmh = speedKmh;
      lastForceN = forceN;
      lastG = g;
      lastGear = gear;
      // 15Hz 节流：与 V800 仪表口径一致，避免每帧 Canvas 上传。
      const now = performance.now() * 0.001;
      if (now - lastClusterAt < 1 / 15) return;
      lastClusterAt = now;
      v800.updateCluster(lastSpeedKmh, lastForceN, lastG, lastGear);
    },
    setSteer(angle: number): void {
      // 直线赛道无转向输入；保留 V800 的转向轮联动（当前为空实现）。
      v800.setSteer(angle);
    },
    snapPedal(): void {
      v800.snapPedal();
    },
    resetPedal(): void {
      v800.resetPedal();
    },
    update(camera: THREE.Camera, dt: number): void {
      brakeLevel = damp(brakeLevel, brakeTarget, 12, dt);
      snapT = damp(snapT, 0, 6, dt);
      if (snapT < 0.001) snapT = 0;
      headLevel = damp(headLevel, headTarget, 14, dt);
      for (const mat of details.headMaterials) mat.emissiveIntensity = headLevel;
      const tailEi = Math.min(1.15, DETAIL_IDLE.tail + brakeLevel * 0.65 + snapT * 0.35);
      for (const mat of details.tailMaterials) mat.emissiveIntensity = tailEi;
      for (const mat of details.caliperMaterials) mat.emissiveIntensity = heat * 1.1;
      // V800 内饰的踏板动画/仪表纹理/轮标 billboard 继续由原适配器自驱。
      v800.update(camera, dt);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      v800.dispose();
      root.traverse((o) => {
        // V800 内饰子树由 v800.dispose() 自有释放链处理，避免二次 dispose。
        if ((o.userData as { yangwangV800Interior?: boolean }).yangwangV800Interior) return;
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          if (!mat) continue;
          const rec = mat as unknown as Record<string, unknown>;
          for (const slot of TEXTURE_SLOTS) {
            const tex = rec[slot];
            if (tex && (tex as THREE.Texture).isTexture) (tex as THREE.Texture).dispose();
          }
          mat.dispose();
        }
      });
      root.removeFromParent();
    }
  };

  // 额外能力（可选字段，不进 CarLike 冻结契约）：Game/爆胎线按结构类型调用。
  const extended = api as CarLike & {
    applyVisibility: (s: CarVisibilityState) => void;
    snapTire: (index: number) => void;
    resetTires: () => void;
    readonly shellReady: boolean;
    interiorViews: NonNullable<CarLike['interiorViews']>;
  };
  extended.applyVisibility = applyVisibility;
  extended.interiorViews = YANGWANG_INTERIOR_VIEWS as NonNullable<CarLike['interiorViews']>;
  extended.snapTire = (index: number): void => {
    const rig = rigs[Math.min(3, Math.max(0, Math.floor(index)))];
    if (!rig) return;
    // 只压扁该轮自己的 deform 组：body 位姿、其他轮、spin 轴全部零影响。
    rig.deform.scale.y = 0.55;
    rig.deform.rotation.z = (rig.anchor.position.x >= 0 ? 1 : -1) * 0.11;
    rig.deform.updateMatrixWorld(true);
  };
  extended.resetTires = (): void => {
    for (const rig of rigs) {
      rig.deform.scale.y = 1;
      rig.deform.rotation.z = 0;
      rig.deform.updateMatrixWorld(true);
    }
  };
  Object.defineProperty(extended, 'shellReady', { get: () => shellReady });

  root.userData.yangwang = {
    shellScale: SHELL_SCALE,
    shellReady: () => shellReady,
    wheelSpinRadius: WHEEL_SPIN_RADIUS,
    interiorSource: 'v800-procedural',
    triangles: 'bake manifest'
  };
  return extended;
}

const TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap',
  'alphaMap', 'lightMap', 'bumpMap', 'displacementMap', 'envMap'
] as const;

function markV800Subtree(root: THREE.Object3D): void {
  root.traverse((o) => {
    o.userData.yangwangV800Interior = true;
  });
}

/**
 * R94 · 座舱内饰材质白名单（**逐位复刻** V800Adapter 的 `R44_INTERIOR_MATERIAL_IDS`，
 * 见其 L5544-5548）。
 *
 * ⚠ 同步纪律：该白名单在 V800Adapter 里是**函数内局部常量、未导出**，无法 import；
 * 若 V800 侧新增 / 删除内饰材质 id，本表**必须同步**，否则车内态会把新内饰件一起裁掉
 * （或放过新外观件）。`tests/r94_yangwang_cabin.test.ts` 以源码字符串断言钉死两表一致，
 * 漂移会在 CI 上立刻红。
 */
const V800_INTERIOR_MATERIAL_IDS: ReadonlySet<string> = new Set([
  'carpet', 'curtain', 'crystal', 'gauge-ui', 'headliner-suede', 'leather-dark',
  'leather-ivory', 'leather-warm', 'pillar-trim', 'screen-ui', 'starlight', 'wood'
]);

/** 同上映：V800Adapter 的 `R44_KEEP_MESH_NAMES`（L5551-5556，id-less 材质的 mesh 名白名单）。 */
const V800_KEEP_MESH_NAMES: ReadonlySet<string> = new Set([
  'brake-pedal', 'cabin-floor-carpet', 'cabin-roof-carpet', 'welcome-carpet',
  'cabin-roof-carpet-ext-rear', 'cabin-roof-carpet-ext-front'
]);

/**
 * R94 · 一次性裁掉 V800 程序化「外壳件」材质 —— 治仰望车内「米黄色光面中间隔板」。
 *
 * ── 根因（探针 `.qa/r94/probe_interior.ts` 实锤，非目检推测）──
 * 本适配器以 `{interiorOnly:true}` 复用 V800 座舱 ⇒ V800Adapter 的外壳 IIFE 在其顶部早退
 * （L5567-5569，R93 防 28MB 并发下载的护栏），于是两件事同时失效：
 *   1. `buildVisibilityTable(...)`（L5596，**只在外壳就绪回调里调用**）从未执行
 *      ⇒ `matEntries` / `meshEntries` 恒为空数组，`applyVisibility` 的 pass-1/pass-2 空转；
 *   2. `shellHandle == null` ⇒ `applyVisibility` 里 `exteriorShellReady` 恒 false。
 * ⇒ V800 那套「外壳就绪后按内饰白名单永久隐藏程序化外观」的幂等状态表对本实例**整体不生效**：
 *   程序化外壳件（glass-clear 风挡 / paint-* 车身 / tire / 轮毂 / 后视镜 / 车顶模块 /
 *   车灯 / 格栅 / 铬饰条 …）全留在座舱里照常绘制。车内态可见 mesh 达 **133** 个。
 *
 * ── 症状读数（主驾眼位 7×7 方向栅格 Raycaster，眼点 = 世界 (-0.40,1.34,-0.72)）──
 *   裁切前：`windshield`（材质 `glass-clear`：color #878F99、roughness **0.03**、
 *     metalness 0.02、envMapIntensity **0.7**、opacity 0.66 —— 一块近镜面反射板）命中
 *     **28/49 条射线 = 57% 画面**，贴脸 dmin 0.66m；它反射暖色软光箱 ⇒ 读作「米黄色光面隔板」。
 *     后排眼点则被 `batch/paint-upper`（材质 `paint-upper` 香槟金 **#D3AC5D** = 米黄色、
 *     metalness 0.45 / roughness 0.38 = 光面）以 dmin **0.49m** 命中 **17/49**。
 *   裁切后：两者命中均 **0/49**，车内可见 mesh 133 → **32**（只剩仪表台 / 三联屏 / 方向盘 /
 *     后排座椅 / 顶棚 / 地毯 / 水晶件 / 窗帘 / 氛围件）。
 *   该结果与 V800 自身 cabin 稳态（外壳已就绪 + interior=true）逐条同构 —— 也正是 V800
 *   历史上同一类病灶：R13 注释记录用户把这块 glass-clear 认作「奶白色面板 / 白板」，
 *   R15c/R16 注释记录第一排座椅被认作「中央隔板实体模块」。
 *
 * ── 为什么改 `material.visible` 而不是逐个藏 mesh ──
 *   V800 的外观件多是 batchMerge 后的**合批网格**（`batch/paint-upper` 一个 mesh 含
 *   body-lower / hood-panel / roof-panel / front-end），整批共享一个材质实例；按名字逐个
 *   藏 mesh 必然漏（V800 自己的 R15c 注释记录过同款教训）。按材质实例判词 + 去重，
 *   与 V800 pass-1（`matSeen` 去重、按 traverse 先序取首见 mesh）逐条同构。
 *
 * ── 三条判词（对齐 V800Adapter `applyVisibility` pass-1，L5420-5423）──
 *   · `userData.cabinHidable === true` → 隐：第一排座椅 / 中控的座舱遮挡克隆
 *     （V800Adapter L3878 / L3919 打的标），即 R15c 记录的「中央隔板」本体；
 *   · 有 `sculptMaterial.id` → 按内饰白名单：`glass-clear` / `glass-dark` / `paint-*` /
 *     `tire` / `wheel-alloy` / `chrome` / 后视镜 / 车顶模块 / 车灯 … 全被裁；
 *   · id-less → 按 mesh 名白名单：`cabin-roof-carpet` / `cabin-floor-carpet` /
 *     `welcome-carpet` / `brake-pedal` 等深色顶棚衬毯与地板件**保留**。
 *     （⚠ 这一条比 V800 pass-1 更宽松一格：V800 对 id-less 材质一律 `!exteriorShellReady`
 *     判隐，会把顶棚衬毯一起藏掉、车内露空顶；此处刻意保留深色衬毯，避免出现新破洞。
 *     若 V800 侧改了这两张白名单，请同步本函数的注释与判词。）
 *
 * 幂等；只写 `material.visible`，**不 dispose、不动几何、不换贴图**；对 `batch/*` 合批件
 * 同样生效（共享材质实例）。回滚：删掉本调用即逐位回到裁切前状态。
 */
function cullV800ExteriorMaterials(scope: THREE.Object3D): void {
  const verdict = new Map<THREE.Material, boolean>();
  scope.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const arr = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mt of arr) {
      if (!mt || verdict.has(mt)) continue;
      const ud = mt.userData as { sculptMaterial?: { id?: string }; cabinHidable?: boolean };
      const id = ud?.sculptMaterial?.id ?? null;
      let keep: boolean;
      if (ud?.cabinHidable === true) keep = false;
      else if (id != null) keep = V800_INTERIOR_MATERIAL_IDS.has(id);
      else keep = V800_KEEP_MESH_NAMES.has(mesh.name);
      verdict.set(mt, keep);
    }
  });
  for (const [mt, keep] of verdict) mt.visible = keep;
}

function disposeGltf(scene: THREE.Object3D): void {
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) mat?.dispose();
  });
}
