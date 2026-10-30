/**
 * 顶层编排：组装场景 / 物理 / 后处理 / UI / 音效，驱动固定步长模拟与渲染循环。
 * 玩法流程：MENU → COUNTDOWN → ACCEL（油门滑条）→ BRAKE（刹车滑条）→ STOPPED / CRASHED。
 */
import * as THREE from 'three';
import { Sfx, vibrate } from '../audio/Sfx';
import { BRAKE, CRASH, MS_TO_KMH, REDUNDANCY, VEHICLE } from '../config/physics';
import { getVehicleProfile, resolveVehicleId, type InteriorViews } from '../config/vehicles';
import { resolveAssemblyPaintId } from '../config/vehiclePaint';
import { AdaptiveQuality, type QualitySettings, type QualityTier } from '../config/quality';
import { World } from '../physics/World';
import type { VehicleState } from '../physics/Vehicle';
import { FxSystems } from '../fx';
import { cycleViewsFor, CameraRig, isInteriorMode } from '../render/CameraRig';
import type { CameraMode } from '../render/CameraRig';
import { Postfx } from '../render/Postfx';
import { createRenderer } from '../render/Renderer';
import { createV800CarAdapter, type CarLike } from '../model/V800Adapter';
import { Environment } from '../render/scene/Environment';
import { ContactShadow } from '../render/scene/ContactShadow';

import { Lighting } from '../render/scene/Lighting';
import { Road } from '../render/scene/Road';
import { Castle } from '../render/scene/castle';
import { Terrain } from '../render/scene/Terrain';
import { clamp, damp, lerp } from '../util/math';
import { Hud } from '../ui/Hud';
import type { HudInput } from '../ui/Hud';
import { Menu } from '../ui/Menu';
import { Result } from '../ui/Result';
import { Sliders } from '../ui/Sliders';
import { Loop } from './Loop';
import { FREE_START, FreeDrive, type FreeDriveEvent } from './FreeDrive';
import type { GameEvent, RunResult, Sample } from './StateMachine';
import { StateMachine } from './StateMachine';

const PHYSICS_HZ = 120;

/**
 * B5（R30-D4）：R7 适配器按需动态加载（原 L18 静态 import 的改造）。
 *
 * 改前：`import { createR7CarAdapter } from '../model/R7Adapter'` 是静态 import ——
 * R7 模型工厂（createR7Model 六千余行 + R7Adapter 一千余行）被整个拖进主 chunk，
 * 而一次会话只用一台车（Menu 选车即 location.reload，见 Menu.pick 注释），
 * V800 玩家永远在下载一份用不到的代码（外部审查估 gzip −150~200KB）。
 *
 * 改后：仅当**活动车型**是 r7 时才发起 import()（V800 玩家整个 chunk 不进网络）。
 * 为什么用顶层 await 预取、而不是在 createCar() 里 await：Game 构造器是同步的
 * （main.ts 直接 `new Game(...)`，且构造期紧接着就要用 this.car：读内饰机位 /
 * 挂 scene / 遍历前挡……），把构造器拆成「同步前半 + 异步尾部」是大重构，
 * 不在本轮窄范围内。顶层 await 让 import() 与 createQualitySettings() 等同步
 * 装配**并发**起飞，模块求值完成后 `new Game()` 才执行 —— r7 的 chunk 获取
 * 被 index.html 静态 #loading 屏覆盖；V800 条件为假，await 不执行、零成本。
 * 走到 createCar() 时 r7 模块必已 resolve（模块求值→构造在同一任务内完成，
 * 无事件轮次，hash/localStorage 不可能在此期间被改写），故可同步消费。
 */
type R7AdapterModule = typeof import('../model/R7Adapter');
const R7_ADAPTER: R7AdapterModule | null =
  resolveVehicleId() === 'r7' ? await import('../model/R7Adapter') : null;

/**
 * 冗余制动期间的刹车灯亮度。
 * 断裂后 pedalForce 归零，若沿用 `pedalForce > 1 ? 8 : 1.6` 会让灯掉回怠速 ——
 * 车明明在减速却灭灯。取 4.5（介于怠速 1.6 与全力 8 之间）：在刹，但不是你踩的。
 */
const REDUNDANT_BRAKE_LIGHT = 4.5;
/**
 * 车模基准偏航（弧度）：spec 坐标系车头 +Z，游戏前进方向 -Z，
 * createV800CarAdapter 构建时给 body.rotation.y = π。任何复位/翻滚重置
 * 都必须保留该偏航、只清俯仰/横滚——清零即整车调头（2026-10-17 外部审查实锤）。
 */
const MODEL_BASE_YAW = Math.PI;

/**
 * 自由探索（R29）机位选择：用 `side` 而不是 `chase`。
 * 原因：chase 在 CameraRig 里是 **世界系**偏移（local: false），车头转向后相机会留在
 * 世界 +Z 侧 = 「车横着开、镜头不跟着转」。`side` 是 **车体局部**偏移（local: true），
 * 相机随 root.quaternion（= heading）旋转 —— 这才是转向自由驾驶需要的跟随第三人称，
 * 且它天然支持鼠标拖拽环绕 + 滚轮缩放（CameraRig 的外部机位分支）。
 * 代价：side 的默认构图偏侧后方（偏移 4.6 侧 / 0.6 后 / 1.5 高，FOV 45），
 * 比 chase 更「转播机位」一点，但这是不改 CameraRig 前提下唯一正确跟随的既有模式。
 */
const FREE_CAMERA_MODE = 'free' as const;

/**
 * QA 专用（DEV only）：合成一局「200 km/h 成功刹停」的结算数据。
 * 只为 headless 截图把结算面板弹出来（真实一局要跑 30 s+ 且时序不可控）；
 * 不进任何玩法逻辑，构建产物不含。
 */
function syntheticResult(): RunResult {
  const total = 5.6;
  const samples: Sample[] = [];
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * total;
    const k = 1 - t / total;
    samples.push({
      t,
      speedKmh: 200 * k * k,
      force: 1450 * Math.min(1, t / 0.35),
      distance: 170 * (1 - k * k * k)
    });
  }
  return {
    success: true,
    reason: undefined,
    degraded: false,
    snapTime: null,
    redundancyDistance: null,
    v0Kmh: 200,
    stopSeconds: total,
    stopDistance: 170,
    peakForce: 1450,
    score: Math.round((200 * 200) / total),
    samples
  };
}

/**
 * R39 帧成本探针（DEV only，URL hash `#r39perf` 触发；构建产物为死代码）。
 *
 * 为什么需要它：「移动速度越快越跳帧」是本轮用户主诉，而既有 `#fprobe` 只记
 * 每帧位置/DC，**记不到两件关键事实**：
 *   ① 这一帧的阴影贴图到底有没有重绘（`drew`）——只能从 three 自己的状态门
 *      `sun.shadow.needsUpdate` 在 render 前后的翻转读出（它在真正绘完才清零，
 *      所以「render 前 true、render 后 false」== 本帧确实重绘过；被外层
 *      `renderer.shadowMap` 闸门拦下时该标志会**粘住**保持 true）；
 *   ② （R39 定稿后已无节流 ⇒ `due`/`jump` 恒 0；字段保留只为与历史 dump 对齐。
 *      节流期的证据留在 `.qa/r39_perf/r39_probe_baseline_B.json`：jump 命中率 100%）
 *
 * 全部写入**预分配 TypedArray**（零分配）：探针自己若每帧 new 对象，会把 GC 抖动
 * 混进被测的帧时分布里，等于用污染的尺子量抖动。
 */
interface R39Probe {
  cap: number;
  n: number;
  /** performance.now() 采样点（wall dt 由离线脚本差分，避开 Loop 的 0.1s 上限钳制） */
  t: Float64Array;
  /** Loop 传给 frame 的 dt（已按 maxFrameTime 钳制，仅作对照） */
  dt: Float32Array;
  speed: Float32Array;
  carZ: Float32Array;
  /** 本帧阴影贴图是否真的重绘（0/1） */
  drew: Uint8Array;
  /** 本帧光照节流是否由「焦点跳变」命中（0/1） */
  jump: Uint8Array;
  /** 本帧光照节流是否置了 needsUpdate（0/1，含间隔命中与强制） */
  due: Uint8Array;
  calls: Uint16Array;
  tris: Uint32Array;
  /** 城堡当前可见分区数（判「流式显隐」是否与尖峰同帧） */
  zones: Uint8Array;
  /**
   * 已上传的 GPU 几何数（`renderer.info.memory.geometries`，只在首次绑定/上传时自增）。
   * 用它证明「行车中仍有首见即上传」——即冷启动预算还没吃干净（R39 预热依据）。
   */
  geo: Uint16Array;
  /** 已编译 program 数（同上口径，`info.programs.length`） */
  prog: Uint16Array;
  /** 已上传贴图数（`info.memory.textures`；城堡「先上架后升级」的热替换会在行车段自增） */
  tex: Uint16Array;
  /** 当前像素比（`AdaptiveQuality.pixelRatio`；变更即重建全部 RT ⇒ 已知一次性大 hitch） */
  dpr: Float32Array;
  /** 当前处于近档（hi）的分区数（与 zones 一起区分「显隐切换」与「远近档换入」） */
  ztier: Uint8Array;
  /** 探针脚本打的干扰标记时间点（如 teleport 复位），离线按 ±200ms 剔除 */
  marks: number[];
}

/** 帧探针记录（perf-r14，字段全部是原始量，判据在离线脚本里算） */
interface FrameProbeRecord {
  t: number;
  dt: number;
  alpha: number;
  ticks: number;
  distance: number;
  prevDistance: number;
  carZ: number;
  carX: number;
  camZ: number;
  camX: number;
  anchorZ: number;
  speed: number;
  fov: number;
  dpr: number;
  calls: number;
  tris: number;
  phase: number;
}

export class Game {
  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly rig: CameraRig;
  private readonly postfx: Postfx;
  private readonly env: Environment;
  private readonly lighting: Lighting;
  private readonly contactShadow: ContactShadow;
  private readonly castle: Castle;
  private readonly car: CarLike;
  /** 活动车型档位（URL #vehicle= > localStorage > v800） */
  private readonly profile = getVehicleProfile(resolveVehicleId());
  /** 装配层注入的内饰三机位（可能为 null → CameraRig 退回内置 cabin 偏移） */
  private readonly interiorViews: InteriorViews | null;
  /** 质量档（createCar 装配注入点要用） */
  private readonly tier: QualityTier;
  private readonly fx: FxSystems;
  private readonly crashWorld: World;
  private readonly sfx = new Sfx();
  private readonly sm = new StateMachine(getVehicleProfile(resolveVehicleId()));
  private readonly hud: Hud;
  private readonly menu: Menu;
  private readonly result: Result;
  private readonly sliders: Sliders;
  private readonly loop: Loop;
  private readonly qualityGovernor: AdaptiveQuality;
  /**
   * 自由探索驾驶器（R29）。非 null 即处于自由探索模式 —— 这是模式判据的唯一真源，
   * tick / frame 都按它分流，退出时置 null 并 detach（键盘监听随之解绑）。
   */
  private freeDrive: FreeDrive | null = null;

  private time = 0;
  /** 窗口事件句柄（dispose 时统一解绑，避免 HMR 泄漏） */
  private readonly onResize = (): void => this.resize();
  private readonly onOrientation = (): void => {
    window.setTimeout(() => this.resize(), 250);
  };
  private prevDistance = 0;
  /**
   * R40 P0-B：自由探索「上一物理步」的位姿快照（**值拷贝**，非引用）。
   * frameFree 用 alpha 在 [prevFree, 当前步] 间插值，抹平「每帧 tick 数量化」的位移抖动；
   * 与挑战路径 L1108 的 prevDistance 同语义（Gaffer 固定步长插值）。
   */
  private prevFreeX = 0;
  private prevFreeZ = 0;
  private brakeFlash = 0;
  private pendingResult: { result: RunResult; delay: number } | null = null;
  private crashElapsed = 0;
  private forceBrakeTick = false;
  /** V 键循环游标（ACCEL/BRAKE 段可用视角） */
  private cycleIndex = 0;
  /**
   * 当前车型的 V 键循环表（V800 5 档 / R7 7 档含三内饰机位），见 cycleViewsFor()：
   * - V800：chase / hood / cabin / orbit / side
   * - R7  ：chase / hood / cabinDriver / cabinPassenger / cabinRear / orbit / side
   */
  private readonly cycleViews: readonly CameraMode[];
  /** 车内机位（用于断裂特写回退 / 前挡遮挡判定的代表机位） */
  private readonly interiorMode: CameraMode;
  /** 结算段自动机位计时（side 2s → orbit；crash 段 crash 2s → side 2s → orbit） */
  private settleTimer = 0;
  private lastImpactStrength = 0;
  /** 自动测试钩子：URL hash 含 autodrive 时，油门全开→限速自动切入→b=0.9 刹车（QA 用） */
  private readonly autoDrive = window.location.hash.includes('autodrive');
  /** 断裂路径钩子：autodrive + snapdrive 时刹车滑条拉满（1.0），用于冗余制动回归 */
  private readonly snapDrive = window.location.hash.includes('snapdrive');
  /** 断裂后车内视角停留计时（看踏板脱落），≤0 时交还常规机位 */
  private snapCamTimer = 0;
  private snapCamReturn: CameraMode | null = null;
  /** 自由视角输入解绑器（与 Sliders 同模式：一次性 AbortController） */
  private lookAbort: AbortController | null = null;
  /**
   * perf-r14 帧探针（仅 DEV + URL hash 含 `fprobe` 时启用，构建产物为死代码）：
   * 逐帧记录 {dt, alpha, ticks, distance, carZ, camZ, anchorZ, speed} ——
   * 「前后抽搐」是位置序列问题，必须看原始数值序列而非体感。
   */
  private probeFrames: FrameProbeRecord[] | null = null;
  private probeTicks = 0;
  /** R39 帧成本探针缓冲（null = 未启用；`#r39perf` 时分配，见构造函数） */
  private r39: R39Probe | null = null;
  /* R39 阴影参与度的判定口径（留档，防后人重踩）：
   * 不用 `sun.shadow.needsUpdate` 翻转（autoUpdate=true 后没人再写它，恒 false）；
   * 也不用包装 `WebGLShadowMap.render` 数 draw call 增量 —— 实测包装器每帧被调 16 次、
   * 增量却恒 0，而「整帧 DC 类别」同时显示 159→168（+9 = 阴影 pass），两者矛盾，
   * 说明该增量在 three 内部不是同步可见的。**结论：用整帧 DC 类别判**，
   * 由离线脚本出表（.qa/r39_perf/r39_probe.mjs 的 shadowClass 段）。 */
  /** cabin 机位专用遮挡件（前挡玻璃），进入/离开车内视角时切换可见性 */
  private readonly windshieldMeshes: THREE.Mesh[] = [];
  /** cabin 机位专用遮挡材质（第一排座椅独占克隆）—— 按材质开关，与合批解耦 */
  private readonly cabinOccluderMaterials: readonly THREE.Material[];
  /** R19：内舱暗面开关（null = 该车未实现，安全跳过） */
  private readonly paintShadow: ((interior: boolean) => void) | null;
  private windshieldHidden = false;
  /**
   * 复用同一份 HUD 载荷对象（perf-r14 热点分配清扫）：原先每帧 `hud.update({...})`
   * 要新建一个 12 字段对象字面量（60 fps × 12 字段 = 纯垃圾），Hud.update 只同步读、
   * 不持有引用，故可安全原地改写。
   */
  private readonly hudInput: HudInput = {    speedKmh: 0,
    brakeSeconds: 0,
    distanceToBarrier: 0,
    pedalForce: 0,
    regenPowerKw: 0,
    brakeTemp: 0,
    overheat: false,
    thermalHold: 0,
    scorePreview: 0,
    canBrake: false,
    braking: false,
    atLimiter: false,
    redundancy: false
  };

  constructor(
    container: HTMLElement,
    quality: QualitySettings,
    onFirstFrame: () => void
  ) {
    this.renderer = createRenderer(container, quality);
    this.tier = quality.tier;
    this.qualityGovernor = new AdaptiveQuality(quality);

    this.rig = new CameraRig(window.innerWidth / window.innerHeight);
    this.env = new Environment(this.scene, this.renderer, quality.envMapSize);
    this.lighting = new Lighting(this.scene, quality, this.env.sunDirection);
    this.contactShadow = new ContactShadow(this.scene);
    // Road 仅装配期构建（R28 起 update 是空壳、无 dispose），同 Terrain 不持引用
    new Road(this.scene, this.renderer.capabilities.getMaxAnisotropy());
    new Terrain(this.scene);
    this.castle = new Castle(this.scene, quality);
    this.car = this.createCar();
    this.interiorViews = this.readInteriorViews();
    this.cabinOccluderMaterials = this.car.cabinOccluderMaterials ?? [];
    // R19：车漆内舱暗面开关（body-lower/root 反面在 cabin 机位切 BackSide 深色）
    this.paintShadow = this.car.setPaintShadow ?? null;
    if (import.meta.env.DEV) {
      console.info(`[cabin] 遮挡材质 ${this.cabinOccluderMaterials.length} 个`);
    }
    this.scene.add(this.car.root);
    // R14 座舱机位：从车内看，前挡（glass-clear，全车唯一）会糊成一块灰板
    // （env 反射 + 单面材质从背面看 = 半透明灰皮），驾驶视野被吃掉。
    // 只在 cabin 机位期间隐藏前挡，其余机位原样保留 —— 只影响玻璃网格本身。
    this.car.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mt of mats) {
        const id = (mt as THREE.MeshPhysicalMaterial)?.userData?.sculptMaterial?.id;
        if (id === 'glass-clear') {
          this.windshieldMeshes.push(m);
          break;
        }
      }
    });
    this.fx = new FxSystems(this.scene, quality.tier);

    // ---- QA 消去法钩子：`#hidemat=<id1,id2>` 隐藏指定材质（合批后仍可按材质定罪）----
    // 用途：车内视角被某块面挡住时，逐材质隐藏 + 截图对照，判断遮挡由哪一族材质构成。
    // 只在 hash 显式给出时生效，正常玩法零开销；材质隐藏不影响 draw call 统计口径。
    {
      const m = /[#&]hidemat=([^&]+)/.exec(window.location.hash);
      if (m) {
        const ids = decodeURIComponent(m[1]).split(',').filter(Boolean);
        let hit = 0;
        this.car.root.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const arr = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mt of arr) {
            const id = (mt as THREE.MeshPhysicalMaterial)?.userData?.sculptMaterial?.id as string | undefined;
            if (id && ids.includes(id)) {
              mt.visible = false;
              hit++;
            }
          }
        });
        console.info(`[QA] hidemat=${ids.join(',')} → 隐藏 ${hit} 个材质实例`);
      }
    }

    this.postfx = new Postfx(this.renderer, this.scene, this.rig.camera, quality);
    this.crashWorld = new World(this.scene, (impact) => {
      this.lastImpactStrength = impact.strength;
      this.sfx.impact(impact.strength);
      this.rig.addShake(0.25 * impact.strength);
    });

    // ---- 车型视角接线 ----
    // CarLike.interiorViews? 由装配层（V800Adapter / R7Adapter）提供，属**可选**字段：
    // 结构化访问，避免依赖尚未合并的 model 改动；缺失则 CameraRig 退回内置 cabin 偏移。
    this.rig.setInteriorViews(this.interiorViews);
    this.rig.setViewScale(this.profile.cameraScale ?? 1);
    // V800 无内饰三机位 → 5 档；注入了 → 7 档（含主驾/副驾/后排）
    this.cycleViews = cycleViewsFor(this.interiorViews !== null);
    this.interiorMode = this.interiorViews ? 'cabinDriver' : 'cabin';

    // ---- UI ----
    this.hud = new Hud({
      onSelectView: (mode) => this.selectView(mode),
      onExitFree: () => this.exitFreeExplore()
    });
    this.menu = new Menu(
      () => this.startRun(),
      () => this.sfx.setMuted(!this.sfx.isMuted),
      () => this.enterFreeExplore()
    );
    this.result = new Result(
      () => this.startRun(),
      () => {
        this.sfx.unlock();
        this.sfx.uiClick();
      },
      () => this.enterFreeExplore()
    );
    this.sliders = new Sliders({
      onCutInBrake: () => this.engageBrake(),
      onCameraSwitch: () => this.cycleCamera()
    });
    this.hud.cutInButton.addEventListener('click', () => this.engageBrake());

    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onOrientation);
    this.wireFreeLook();

    this.loop = new Loop(
      {
        tick: (step) => this.tick(step),
        frame: (dt, alpha) => this.frame(dt, alpha)
      },
      PHYSICS_HZ,
      // 自动测试模式下放宽单帧模拟上限，避免后台窗口 rAF 节流导致测试过慢
      this.autoDrive ? 0.35 : 0.1
    );
    this.loop.start();
    // 帧探针（perf-r14）：必须在 loop.start 之后挂 window，但 buffer 已就绪，
    // 漏掉的前 1~2 帧不影响统计口径。
    if (import.meta.env.DEV && window.location.hash.includes('fprobe')) {
      this.renderer.info.autoReset = false;
      // QA：`#noshadowupd` 冻结阴影贴图更新 = 精确量出「每帧重绘 2048² 阴影」的单价
      if (window.location.hash.includes('noshadowupd')) this.renderer.shadowMap.autoUpdate = false;
      this.probeFrames = [];
      (window as unknown as { __v800Probe: unknown }).__v800Probe = {
        frames: this.probeFrames,
        clear: (): void => {
          this.probeFrames!.length = 0;
        }
      };
    }
    /* ---- R39 帧成本探针（DEV + `#r39perf`）：真值口径，不预测、不推断 ----
     * 采到的四件事各自证伪一条假设（详见 R39Probe 注释）：
     *   drew  → 阴影重绘**实际**节拍（vs 代码里「以为」的节拍）
     *   jump  → 「跳变阈值」在高速下是否每帧误触
     *   zones → 城堡分区流式显隐是否与帧时尖峰同帧
     *   t     → wall dt（绕开 Loop 的 0.1s 钳制，否则慢帧会被记成 100ms 整） */
    if (import.meta.env.DEV && window.location.hash.includes('r39perf')) {
      const cap = 30000;
      const probe: R39Probe = {
        cap,
        n: 0,
        t: new Float64Array(cap),
        dt: new Float32Array(cap),
        speed: new Float32Array(cap),
        carZ: new Float32Array(cap),
        drew: new Uint8Array(cap),
        jump: new Uint8Array(cap),
        due: new Uint8Array(cap),
        calls: new Uint16Array(cap),
        tris: new Uint32Array(cap),
        zones: new Uint8Array(cap),
        geo: new Uint16Array(cap),
        prog: new Uint16Array(cap),
        tex: new Uint16Array(cap),
        dpr: new Float32Array(cap),
        ztier: new Uint8Array(cap),
        marks: []
      };
      this.r39 = probe;
      this.renderer.info.autoReset = false;
      (window as unknown as Record<string, unknown>).__r39perf = {
        clear: (): void => {
          probe.n = 0;
          probe.marks.length = 0;
        },
        mark: (): void => {
          probe.marks.push(performance.now());
        },
        dump: (): unknown => ({
          n: probe.n,
          marks: probe.marks,
          t: Array.from(probe.t.subarray(0, probe.n)),
          dt: Array.from(probe.dt.subarray(0, probe.n)),
          speed: Array.from(probe.speed.subarray(0, probe.n)),
          carZ: Array.from(probe.carZ.subarray(0, probe.n)),
          drew: Array.from(probe.drew.subarray(0, probe.n)),
          jump: Array.from(probe.jump.subarray(0, probe.n)),
          due: Array.from(probe.due.subarray(0, probe.n)),
          calls: Array.from(probe.calls.subarray(0, probe.n)),
          tris: Array.from(probe.tris.subarray(0, probe.n)),
          zones: Array.from(probe.zones.subarray(0, probe.n)),
          geo: Array.from(probe.geo.subarray(0, probe.n)),
          prog: Array.from(probe.prog.subarray(0, probe.n)),
          tex: Array.from(probe.tex.subarray(0, probe.n)),
          dpr: Array.from(probe.dpr.subarray(0, probe.n)),
          ztier: Array.from(probe.ztier.subarray(0, probe.n))
        })
      };
    }
    // 首帧后回调（隐藏加载屏）
    // R39：先把「首见即上传 / 首次编译」的冷启动成本在加载期一次性吃掉（见方法注释），
    // 放在 rAF 之前 —— 本任务内同步执行，第一帧渲染时资源已就绪。
    if (!import.meta.env.DEV || !window.location.hash.includes('noprewarm')) this.prewarmGpu();
    requestAnimationFrame(() => onFirstFrame());

    this.menu.show(true);
    this.rig.setMode('orbit');
    this.car.setBrakeLights(1.6);

    // ---- QA 钩子：`#view=<mode>` 直接切机位（跳过「开始挑战」，供 headless 截图）----
    // 用法：index.html#view=cabin 或 #view=cabinDriver / cabinPassenger / cabinRear。
    // 车内遮挡切换（windshield/座椅/内舱暗面）走 selectView 同一条路径，所见即游戏内。
    {
      const m = /[#&]view=([a-zA-Z]+)/.exec(window.location.hash);
      if (m) {
        const mode = m[1] as CameraMode;
        const known = new Set<string>(['chase', 'hood', 'cabin', 'cabinDriver', 'cabinPassenger', 'cabinRear', 'orbit', 'side']);
        if (known.has(mode)) {
          // selectView 有 phase 门禁（仅 accel/brake），未开局会被拦 → QA 钩子直接
          // 驱动 rig + 遮挡切换，与 frame 内 wantHide 同一条路径（含 setPaintShadow）。
          requestAnimationFrame(() => {
            this.rig.setMode(mode as CameraMode);
            this.hud.setActiveView(mode as CameraMode);
            const hide = isInteriorMode(mode as CameraMode);
            this.windshieldHidden = hide;
            for (const wm of this.windshieldMeshes) wm.visible = !hide;
            for (const om of this.cabinOccluderMaterials) om.visible = !hide;
            this.paintShadow?.(hide);
            console.info(`[QA] #view=${mode} 已切换`);
          });
        }
      }
    }

    // ---- QA 钩子 · R29 自由探索 ----
    // 为什么要它：① 结算面板要跑完一整局才出现（#autodrive 也要 30 s+），headless 截图
    // 需要确定性入口；② SwiftShader 下真人按键时序不可控，键盘必须能脚本化驱动。
    // 全部只在 DEV 生效，构建产物不含。
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__v800Free = {
        enter: (): void => this.enterFreeExplore(),
        exit: (): void => this.exitFreeExplore(),
        state: (): unknown => this.freeDrive?.snapshot() ?? null,
        press: (code: string, down: boolean): void => this.freeDrive?.press(code, down),
        teleport: (x: number, z: number, heading: number): void =>
          this.freeDrive?.teleport(x, z, heading),
        /** 直接弹结算面板（合成一局成功刹停），供结算页截图 */
        showResult: (): void => {
          this.menu.show(false);
          this.hud.setVisible(false);
          this.result.show(syntheticResult());
        }
      };
      if (window.location.hash.includes('freedrive')) {
        requestAnimationFrame(() => this.enterFreeExplore());
      }
    }

    // ---- QA 钩子 · R26 环境验收：世界坐标自由机位 + 城堡预算读数 ----
    // 为什么必须有它：`preview.html` 是纯车模预览页（自建迷你 scene），拍不到
    // Castle/Road/Terrain/天空；而 `#eye=` 只能覆盖 cabin 机位、要整页 reload 才生效。
    // 这里直接摆相机 + 同帧 render + 读 canvas，一次加载拍任意多个机位。
    // 用法：page.evaluate(() => window.__v800EnvShot('x', 0,3,60, 0,10,-300))
    {
      const cam = this.rig.camera;
      const gl = this.renderer;

      /* ── QA 钩子 · 材质隐藏消去法（R37 落地审查 P2-4 补齐）──────────────────────
       * 为什么需要：`src/model/preview.ts` 里那份 `__v800HideMat` 只作用于
       *   **preview.html 的迷你 scene**（拍不到 Castle/Road/Terrain）⇒ 游戏页里
       *   根本没有这个钩子，城堡侧的「遮一类材质 → 同机位重拍 → 像素差热力图」
       *   消去法做不了（本轮审查只能用热力图 + Node UV 密度解码替代）。
       *
       * 与 preview 版的差别（**故意加宽**，因为城堡桶不是 sculptMaterial 语义）：
       *   key 依次匹配 ① `mesh.name`（城堡分区桶：`castle-ashlar-z0` / `castle-gold-z1`
       *   / `castle-grey-z1` / `castle-flame` …）② `material.userData.sculptMaterial.id`
       *   （车模族：`paint-upper` / `chrome` …）③ `material.uuid`（单点定位某个实例）。
       *   命中即整 mesh `visible=false`，返回隐藏的 mesh 数。
       *
       * ⚠ 调用顺序（**很重要的坑**）：`__v800EnvShot` 内部会先 `revealAllZones()`
       *   把全部分区可见，**会把先前的隐藏抹掉**。故本钩子把隐藏集合持久化，
       *   并由 `__v800EnvShot` 在 `gl.render` **前**重新应用（见下面 applyHidden 调用）
       *   ⇒ 正确用法是「先 hide、再 EnvShot」，两者任意顺序都成立。
       *
       * 恢复语义：
       *   · `__v800HideMat(key, false)` —— 只放开 **这一把** key：从集合里删掉它，
       *     再 `castle.revealAllZones()` 回到「全可见」基准 + 重新应用**剩余** key，
       *     不会把别的 key 也放开。
       *   · `__v800HideMat('', false)` —— **一次性全恢复**（空 key + hide=false
       *     被特判为「清空隐藏集合」）。
       *   返回值 = **当前累计**隐藏的 mesh 数（不是本次增量）。消去法脚本按
       *   「hide 一类 → 截图 → 全恢复 → hide 下一类」的节奏用，
       *   所以增量和累计都不该拿来做逻辑判断，只用于打印/断言 >0。
       */
      const hiddenKeys = new Set<string>();
      const applyHidden = (): number => {
        if (hiddenKeys.size === 0) return 0;
        let n = 0;
        this.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          if (hiddenKeys.has(m.name)) {
            m.visible = false;
            n += 1;
            return;
          }
          const arr = Array.isArray(m.material) ? m.material : [m.material];
          for (const mt of arr) {
            const mid = (mt as THREE.MeshPhysicalMaterial | undefined)?.userData?.sculptMaterial
              ?.id as string | undefined;
            if ((mid && hiddenKeys.has(mid)) || hiddenKeys.has(mt.uuid)) {
              m.visible = false;
              n += 1;
              return;
            }
          }
        });
        return n;
      };
      (window as unknown as Record<string, unknown>).__v800HideMat = (
        key: string,
        hide: boolean
      ): number => {
        if (hide) {
          if (key) hiddenKeys.add(key);
        } else {
          // 空 key + hide=false = 一次性全恢复（见上方注释的恢复语义）
          if (key === '') hiddenKeys.clear();
          else hiddenKeys.delete(key);
          // 回到「全可见」基准再重放剩余隐藏集：否则被 updateViewerZ/revealAllZones
          // 接管过的 visible 状态无法逐 mesh 还原。
          this.castle.revealAllZones();
        }
        return applyHidden();
      };

      (window as unknown as Record<string, unknown>).__v800EnvShot = (
        _name: string,
        x: number, y: number, z: number,
        tx: number, ty: number, tz: number,
        fov = 55
      ): string => {
        // 环境机位动辄 400m 视线：near 必须抬到 1，far 覆盖到 3000（天空球在 5000）
        cam.fov = fov;
        cam.near = 1;
        // far 必须大于天空球半径（5000）：天空 shader 把 gl_Position 写成 z=w
        // （永远贴在远平面），球体顶点本身若超出 far 会被裁掉 —— 抬头看天顶时
        // 顶部那一圈就整片丢失，露出后面未定义的缓冲（实测呈品红色带）。
        cam.far = 20000;
        cam.position.set(x, y, z);
        cam.lookAt(tx, ty, tz);
        cam.updateProjectionMatrix();
        // 天空球每帧跟着相机平移（Environment.update）。同帧摆相机后如果不补这一步，
        // 天空球还停在上一个机位中心 —— 大跨度跳机位时球体会被甩到相机背后，
        // 截出来就是「黑天」（dev-b 在 verify/r26d 实测过一次）。
        this.env.update(cam.position);
        // R31 治理②：自由机位绕过帧循环 ⇒ 先放开全部分区（否则保留上一个行车
        // 机位的距离显隐态，环境验收截图缺远区件）；下一帧按真实机位重算。
        this.castle.revealAllZones();
        // R37-P2-4：revealAllZones 刚把全部分区放开 ⇒ 必须**在 render 前重放**
        // 消去法的隐藏集合，否则「先 hide 再 EnvShot」的隐藏会被这行抹掉。
        applyHidden();
        gl.render(this.scene, cam);
        return gl.domElement.toDataURL('image/png');
      };
      // 预算读数（dev-2 报告遗留项 4）：tri/DC 由 castle 自己累计
      // R28 口径升级（r28_audit §6 口径提醒 2）：__v800EnvStats = castle+terrain+road
      // 合计 tri/dc。⚠ 缺口：Terrain/Road 目前没有统计接口（两文件归 L2 线，不在
      // L4 白名单内；Terrain 实例构造后也未持引用），暂只能并入 castle —— frameTri
      // 对账仍缺 Terrain（≈6.8k tri / 2 DC）与 Road 两块，待 L2 提供
      // getTerrainStats()/getRoadStats() 后在此并入。
      (window as unknown as Record<string, unknown>).__v800EnvStats = (): unknown => {
        const castle = this.castle.getCastleStats();
        return {
          tris: castle.tris,
          dc: castle.dc,
          castle,
          terrain: null,
          road: null
        };
      };
      // 兼容别名：旧探针（.qa/r27_env_final.mjs stats 命令等）仍读 __v800CastleStats
      (window as unknown as Record<string, unknown>).__v800CastleStats = (): unknown =>
        this.castle.getCastleStats();
    }
  }

  /** renderer 初始化见 render/Renderer.ts（结构要素 1：WebGLRenderer） */

  /**
   * R39 · 冷启动预算转移：把「首见即上传 / 首次编译」的一次性 hitch 从**行车段**
   * 挪到**加载段**（用户指令：构建/加载时长不限，运行时每一帧必须平稳）。
   *
   * 为什么需要（这是本作最隐蔽的一类尖峰）：three 的 GPU 资源是**惰性创建**的 ——
   * program 在材质首次参与绘制时编译（单个可 20~100ms），BufferGeometry 在 mesh
   * 首次真正被绘制时上传（万级三角的城堡分区可 1~2ms/个）。而城堡分区是**按观看距离
   * 流式显隐**的（castle.updateViewerZ），车上高速时新分区弹出的频率 ∝ 车速
   * ⇒ 这类 hitch 天然「越快越密」，正好落在用户主诉上。
   * 实测手段：探针逐帧记 `renderer.info.memory.geometries` / `info.programs.length`
   * （只在首次上传/编译时自增），`__r39perf.dump()` 里的 geo/prog 序列能直接看到
   * 「行车段还在长」的那些帧。
   *
   * 做法（两步都不改变任何几何/密度，只是**提前**做）：
   *   ① `renderer.compile(scene, camera)`：把场景里全部材质（含当前不可见的分区、
   *      内饰件、特效粒子）的 program 一次编译完；
   *   ② `castle.revealAllZones()` 把全部分区放开成近档，用一台「看全场景」的相机
   *      渲一帧到 **8×8 离屏 RT** —— 每个 mesh 都真正走一次绘制流水线 ⇒ buffer 上传完；
   *      渲到离屏小目标 ⇒ 屏幕上不会闪一帧「全部分区同时出现」。
   * 随后 `updateViewerZ(相机 z)` 还原真实显隐态（revealAllZones 会把 lastViewerZ 置
   * NaN，所以这里一定能重算）。
   *
   * 成本：一次全场景绘制 + 一次全材质编译，只发生在加载期（用户已授权）。
   * 失败兜底：整体 try/catch —— 预热失败最坏只是退回「首见即上传」的老行为，
   * 绝不允许它把开局拖死（QA 钩子 `#noprewarm` 可在 DEV 下跳过，用于 A/B）。
   */
  private prewarmGpu(): void {
    try {
      /* 分段计时（R39 主理人要求）：三段的绝对增量必须可分——
       *   compile   = `renderer.compile` 全材质 program 编译（真机预期最大的一段）；
       *   rtWarm    = 8×8 离屏全场景渲染（含 400k tri 的 buffer 首传）；
       *   restore   = revealAllZones 后的 updateViewerZ 还原。
       * 真机与 SwiftShader 的量级差一个数量级以上，故只在 DEV 打，且必须分段。 */
      const tStart = performance.now();
      this.renderer.compile(this.scene, this.rig.camera);
      const tCompile = performance.now();
      this.castle.revealAllZones();
      // 相机要能框住整条走廊（z 从 +70 到 −1300，城堡塔尖 y < 120）：
      // 高度 900 + fov 120 ⇒ 可见半径 900·tan60° ≈ 1558m，俯视即可全覆盖。
      const cam = new THREE.PerspectiveCamera(120, 1, 1, 20000);
      cam.position.set(0, 900, -600);
      cam.lookAt(0, 0, -640);
      const rt = new THREE.WebGLRenderTarget(8, 8);
      this.renderer.setRenderTarget(rt);
      this.renderer.render(this.scene, cam);
      this.renderer.setRenderTarget(null);
      rt.dispose();
      const tWarm = performance.now();
      this.castle.updateViewerZ(this.rig.camera.position.z);
      const tRestore = performance.now();
      if (import.meta.env.DEV) {
        const compile = tCompile - tStart;
        const rtWarm = tWarm - tCompile;
        const restore = tRestore - tWarm;
        const total = tRestore - tStart;
        console.info(
          `[R39] 加载期 GPU 预热 ${total.toFixed(0)}ms = compile ${compile.toFixed(0)}` +
            ` + rtWarm(8×8 全场景) ${rtWarm.toFixed(0)} + restore ${restore.toFixed(0)}` +
            ` | geometries=${this.renderer.info.memory.geometries}` +
            ` programs=${this.renderer.info.programs?.length ?? 0}`
        );
        // 首屏预算告警线（主理人口径）：>2500ms 说明真机上这一段过重，需要拆帧或延后
        if (total > 2500) {
          console.warn(
            `[R39] 预热耗时 ${total.toFixed(0)}ms 超首屏预算 2500ms —— 申请拆帧执行（当前为加载屏内同步）`
          );
        }
      }
    } catch (e) {
      // 预热是「收益项」不是「正确性项」：失败只回退到惰性加载，不影响玩法
      console.warn('[R39] GPU 预热失败（已忽略，退回惰性上传）：', e);
    }
  }

  /**
   * 【车型装配注入点】按活动车型构建车模。
   * 主理人接线：R7 模型就绪后在此按 this.profile.id 分支选择装配入口，例如
   *   return this.profile.id === 'r7' ? createR7CarAdapter(quality.tier) : createV800CarAdapter(quality.tier);
   * 换车必须重载页面（Menu 选车即 reload），见 Menu.pick()。
   */
  /**
   * 【车型装配注入点】按活动车型构建车模（R15 双车）。
   * 换车 = Menu 选车后 location.reload()，因此这里只做一次性分支，不需要 dispose/热切换。
   * 两车共用同一份 CarLike 契约与材质 ID 语义族，灯光/热量/仪表驱动路径零分叉。
   */
  private createCar(): CarLike {
    // B5（R30-D4）：r7 适配器经模块顶层预取（见文件头 R7_ADAPTER 注释），此处同步消费。
    // 兜底 throw：正常不可达（模块求值与构造同一任务内完成，车型不可能中途被改写）——
    // 若将来有人破坏该不变式（如把本方法改成异步调用），这里给明确报错而非静默加载错车。
    // R37-C 车漆：装配期一次性消费（换色与换车同机制 —— Menu 落盘后 location.reload()）。
    // resolveAssemblyPaintId 对 r7 返回 null 表示「保留原厂墨绿」，v800 恒为 5 色之一
    // （默认 champagne，数值 = R36 基线 ⇒ 不换色时车模逐位不变）。
    const paintId = resolveAssemblyPaintId(this.profile.id);
    if (this.profile.id === 'r7') {
      if (!R7_ADAPTER) {
        throw new Error('[Game] r7 适配器未预取：活动车型在模块求值后被改写？');
      }
      return R7_ADAPTER.createR7CarAdapter(this.tier, paintId);
    }
    return createV800CarAdapter(this.tier, paintId ?? undefined);
  }

  /**
   * 读取装配层注入的内饰三机位。结构化访问（`interiorViews?` 是 V800Adapter 的
   * **可选**字段，另一端尚未合并），缺失返回 null。
   */
  private readInteriorViews(): InteriorViews | null {
    const iv = (this.car as CarLike & { interiorViews?: InteriorViews }).interiorViews;
    return iv ?? null;
  }

  private startRun(): void {
    this.sfx.unlock();
    this.resetVisuals();
    this.fx.clear();
    this.menu.show(false);
    this.result.hide();
    this.hud.setVisible(true);
    this.hud.hideToast();
    this.sliders.reset();
    this.sliders.showCutIn();
    this.crashWorld.reset();
    this.hud.setRedundancyActive(false);
    this.snapCamTimer = 0;
    this.snapCamReturn = null;
    this.car.resetPedal();
    this.sm.start();
    this.rig.setMode('chase');
    this.cycleIndex = 0;
    this.settleTimer = 0;
    this.hud.setActiveView('chase');
    this.sfx.countdownBeep(false);
  }

  private resetVisuals(): void {
    this.crashWorld.reset();
    this.car.root.position.set(0, 0, 0);
    this.car.root.quaternion.identity();
    // 模型 spec 坐标系车头朝 +Z（preview 审查页口径），游戏前进方向为 -Z：
    // body 恒定偏航 π（见 V800Adapter 构建处）。复位只清俯仰/横滚——
    // 清成 0 会整车调头 180°（车尾朝前跑，即用户主诉的「正反面颠倒」）。
    this.car.body.rotation.set(0, MODEL_BASE_YAW, 0);
    this.car.setBrakeHeat(0);
    this.car.setBrakeLights(1.6);
    this.prevDistance = 0;
    this.brakeFlash = 0;
    this.pendingResult = null;
    this.crashElapsed = 0;
  }

  private engageBrake(): void {
    this.sfx.unlock();
    this.forceBrakeTick = true;
  }

  // ==================== 自由探索模式（R29） ====================

  /**
   * 进入自由探索：隐藏结算/菜单 → 车辆复位到城门外起点 → 绑定键盘 → 切跟随机位。
   * 挑战态（会话状态机 / 踏板 / 撞击结算）整体让位给 core/FreeDrive 的运动学驾驶器。
   */
  private enterFreeExplore(): void {
    this.sfx.unlock();
    this.sfx.uiClick();
    this.result.hide();
    this.menu.show(false);
    this.hud.hideToast();
    this.hud.showCountdown(null);
    // 挂着结算延迟就进自由模式会在几秒后把结算面板弹回来 —— 必须先清
    this.pendingResult = null;
    this.crashElapsed = 0;
    this.forceBrakeTick = false;
    this.settleTimer = 0;
    this.snapCamTimer = 0;
    this.snapCamReturn = null;
    this.brakeFlash = 0;
    this.fx.clear();
    this.crashWorld.reset();
    this.sm.toMenu();
    this.sliders.reset();
    this.sliders.hideCutIn();
    this.sliders.root.style.display = 'none';
    this.hud.setRedundancyActive(false);

    // 车模复位（resetVisuals 保住 body 基准偏航 π，只清俯仰/横滚）
    this.resetVisuals();
    this.car.resetPedal();
    this.car.setBrakeHeat(0);
    this.car.setBrakeLights(1.6);
    this.car.setHeadlights(true);
    this.car.root.position.set(FREE_START.x, 0, FREE_START.z);
    this.car.root.rotation.set(0, FREE_START.heading, 0);

    const fd = new FreeDrive({ maxSpeedKmh: this.profile.maxSpeedKmh });
    fd.onEvent = (e) => this.onFreeEvent(e);
    fd.attach();
    this.freeDrive = fd;

    this.hud.setVisible(true);
    this.hud.setFreeMode(true);
    this.hud.updateFree(0, 'D');
    this.hud.showToast(
      '自由探索：W/S 油门刹车 · A/D 转向 · Space 手刹 · R 复位 · Esc 结束',
      false,
      3600
    );
    this.rig.setMode(FREE_CAMERA_MODE);
    this.hud.setActiveView(FREE_CAMERA_MODE);
    this.cycleIndex = 0;
  }

  /**
   * 退出自由探索 → **回到菜单**（不直接重开一局）。
   * 理由：自由探索没有成绩语义，玩家从结算页进来时刚看过一次结算；直接丢进倒计时
   * 等于替玩家做了「再来一次」的决定。回菜单把「重开挑战 / 再探索一次 / 换车」三个
   * 选择都留给他 —— 与结算页「再来一次」按钮的语义区分开，不重复。
   */
  private exitFreeExplore(): void {
    if (!this.freeDrive) return;
    this.freeDrive.detach();
    this.freeDrive = null;
    this.hud.setFreeMode(false);
    this.hud.hideToast();
    this.hud.setVisible(false);
    this.sliders.root.style.display = '';
    this.sliders.reset();
    this.sliders.showCutIn();
    this.pendingResult = null;
    this.brakeFlash = 0;
    this.fx.clear();
    this.crashWorld.reset();
    this.sm.toMenu();
    // 车辆位姿与相机复位（resetVisuals 内含 root 归零 + body 回到基准偏航 π）
    this.resetVisuals();
    this.car.resetPedal();
    this.car.setBrakeHeat(0);
    this.car.setBrakeLights(1.6);
    this.car.setHeadlights(false);
    this.car.setSteer(0);
    this.car.updateCluster(0, 0, 0, 'P');
    this.sfx.updateEngine(0, false);
    this.sfx.updateWind(0);
    this.sfx.updateSqueal(0, 0);
    this.sfx.updateRegen(false);
    this.rig.setMode('orbit');
    this.hud.setActiveView('orbit');
    this.hud.setRedundancyActive(false);
    this.menu.show(true);
    this.sfx.uiClick();
  }

  /** 自由探索事件（撞击 / 复位 / 退出 / 帮助卡），由 FreeDrive 去抖后派发 */
  private onFreeEvent(e: FreeDriveEvent): void {
    switch (e) {
      case 'hall':
        // 复用挑战模式「撞上主殿」文案（R28 换皮后的用户口径）
        this.hud.showToast('撞上主殿！', true, 1800);
        this.sfx.impact(0.6);
        this.rig.addShake(0.45);
        vibrate([40, 30, 90]);
        break;
      case 'wall':
        this.sfx.impact(0.22);
        this.rig.addShake(0.16);
        break;
      case 'reset':
        this.hud.showToast('已复位到城门外', false, 1400);
        break;
      case 'help':
        this.hud.toggleFreeHelp();
        this.sfx.uiClick();
        break;
      case 'exit':
        this.exitFreeExplore();
        break;
    }
  }

  /** 自由探索渲染帧：车体位姿 / 车轮 / 音效 / 相机 / HUD（不碰挑战链路） */
  private frameFree(dt: number, alpha: number): void {
    const fd = this.freeDrive;
    if (!fd) return;
    const s = fd.state;
    const absSpeed = Math.abs(s.speed);
    const speedKmh = absSpeed * MS_TO_KMH;
    const reverse = s.speed < -0.2;
    const braking = s.handbrake || (s.brake > 0 && s.speed > 0.2);

    // ---- 车体位姿 ----
    // root 承载偏航（root.quaternion 同时喂给 CameraRig 的 local 机位）；
    // body 只承载基准偏航 π + 视觉俯仰/侧倾（基准偏航由 resetVisuals 写入，此处不动）。
    // R40 P0-B：按 alpha 在「上一物理步 prevFree ↔ 当前步 s」间插值（Gaffer 同挑战路径 L1241），
    // 抹平「每帧 tick 数量化」的位移抖动（R39 探针实测的正是这条无插值路径）。
    // 防拉丝：两态距离 > 5m（≈远大于单步 travel<1m、又远小于传送/复位的百米级）时
    // 视为传送/复位/R 键/首帧未初始化，直接吸附到当前态（此帧不插值）。
    const jumpX = s.x - this.prevFreeX;
    const jumpZ = s.z - this.prevFreeZ;
    if (jumpX * jumpX + jumpZ * jumpZ > 25) {
      this.prevFreeX = s.x;
      this.prevFreeZ = s.z;
    }
    this.car.root.position.set(
      lerp(this.prevFreeX, s.x, alpha),
      0,
      lerp(this.prevFreeZ, s.z, alpha)
    );
    this.car.root.rotation.y = s.heading;
    this.car.body.rotation.x = s.pitch;
    this.car.body.rotation.z = s.roll;
    // 车轮：弧长 = v·dt（有符号，倒车反转）；前轮转角走适配层既有 setSteer
    this.car.spinWheels(s.speed * dt, dt);
    this.car.setSteer(s.steer);
    this.car.setBrakeLights(braking ? 8 : 1.6);
    this.car.setHeadlights(true);
    this.car.updateCluster(speedKmh, 0, Math.abs(s.accel) / 9.81, reverse ? 'R' : 'D');
    this.car.update(this.rig.camera, dt);

    // ---- 灯光 / 接地阴影 ----
    const focus = this.car.root.position;
    this.lighting.update(focus);
    this.contactShadow.update(this.car.body);

    // ---- 特效 / 音效（Sfx 的 spool 一阶滞后常量不动，只喂速度）----
    this.fx.update(dt, {
      carRoot: this.car.root,
      brakeIntensity: braking && absSpeed > 3 ? 0.35 : 0,
      speedMs: absSpeed,
      braking: braking && absSpeed > 3
    });
    this.sfx.updateEngine(speedKmh, s.throttle > 0);
    this.sfx.updateWind(absSpeed / (VEHICLE.maxSpeedKmh / MS_TO_KMH));
    this.sfx.updateSqueal(0, absSpeed);
    this.sfx.updateRegen(false);

    // ---- 相机 + 后处理 ----
    this.rig.update(dt, focus, absSpeed, this.car.root.quaternion);
    this.syncInteriorOcclusion();
    // R31 运行时治理②：城堡分区按观看距离显隐（内部 20m 滞回，零遍历开销）
    this.castle.updateViewerZ(this.rig.camera.position.z);
    this.env.update(this.rig.camera.position);
    this.postfx.setSpeedBlur(Math.min(1, absSpeed / 72) ** 1.6 * 0.07);
    this.postfx.setFlash(0);

    // ---- HUD（只写速度 + 挡位，踏板力/距离统计属挑战语义，不显示）----
    this.hud.updateFree(speedKmh, reverse ? 'R' : 'D');
    this.renderTail(dt, null);
  }

  /**
   * 车内机位遮挡切换（前挡 / 第一排座椅 / 车漆内舱暗面）：
   * 仅在模式变化时写，零每帧开销。自由探索也能切到 cabin 系机位，故两模式共用。
   */
  private syncInteriorOcclusion(): void {
    const wantHide = isInteriorMode(this.rig.mode);
    if (wantHide === this.windshieldHidden) return;
    this.windshieldHidden = wantHide;
    for (const m of this.windshieldMeshes) m.visible = !wantHide;
    for (const m of this.cabinOccluderMaterials) m.visible = !wantHide;
    this.paintShadow?.(wantHide);
  }

  /**
   * 自由视角输入（决策③）：画布上拖拽 = 环绕/转头，滚轮 = 缩放，双击 = 回正。
   * 滑条与视角按钮是独立 DOM 且已各自 setPointerCapture，事件不会冒泡到此处，
   * 因此直接挂在 renderer.domElement 上零冲突；全部经一个 AbortController 解绑。
   */
  private wireFreeLook(): void {
    const canvas = this.renderer.domElement;
    const ac = new AbortController();
    this.lookAbort = ac;
    const opts = { signal: ac.signal } as const;
    let pointerId = -1;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener(
      'pointerdown',
      (e) => {
        if (pointerId !== -1) return;
        pointerId = e.pointerId;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
      },
      opts
    );
    canvas.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId !== pointerId) return;
        this.rig.addLook(e.clientX - lastX, e.clientY - lastY);
        lastX = e.clientX;
        lastY = e.clientY;
      },
      opts
    );
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      pointerId = -1;
      this.rig.endLook();
    };
    canvas.addEventListener('pointerup', release, opts);
    canvas.addEventListener('pointercancel', release, opts);
    canvas.addEventListener('dblclick', () => this.rig.resetLook(), opts);
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.rig.addZoom(e.deltaY);
      },
      { signal: ac.signal, passive: false }
    );
    canvas.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
  }

  /** V 键：ACCEL/BRAKE 段按车型循环（V800 5 档 / R7 7 档）；自由探索段不受 phase 门禁 */
  private cycleCamera(): void {
    if (!this.freeDrive && this.sm.phase !== 'accel' && this.sm.phase !== 'brake') return;
    this.cycleIndex = (this.cycleIndex + 1) % this.cycleViews.length;
    this.rig.setMode(this.cycleViews[this.cycleIndex]);
    this.hud.setActiveView(this.cycleViews[this.cycleIndex]);
    this.sfx.uiClick();
  }

  /** HUD 视角按钮：直接切到指定视角（HUD 只渲染本车存在的按钮）；自由探索段不受 phase 门禁 */
  private selectView(mode: CameraMode): void {
    if (!this.freeDrive && this.sm.phase !== 'accel' && this.sm.phase !== 'brake') return;
    const idx = this.cycleViews.indexOf(mode);
    if (idx >= 0) this.cycleIndex = idx;
    this.rig.setMode(mode);
    this.hud.setActiveView(mode);
    this.sfx.uiClick();
  }

  /** 固定步长物理推进（1/120s） */  private tick(step: number): void {
    if (this.probeFrames !== null) this.probeTicks++;
    // 自由探索：整条挑战链路（会话状态机 / 踏板 / 撞击结算）全部让位给运动学驾驶器
    if (this.freeDrive) {
      // R40 P0-B：step **之前**快照当前位姿到 prevFree*（值拷贝）。
      // 每步都覆写 ⇒ 一帧跑 N 步时 prevFree 落在「最后一步之前」，alpha∈[0,1) 只插最后一步，
      // 与挑战路径 prevDistance（L1108 同样在 sm.step 前赋值）完全同语义。
      // 只读驾驶器 state，不写回 ⇒ 不触碰 FreeDrive 内部物理态。
      this.prevFreeX = this.freeDrive.state.x;
      this.prevFreeZ = this.freeDrive.state.z;
      this.freeDrive.step(step);
      return;
    }
    this.prevDistance = this.sm.vehicle.distance;
    // 自动切入：加速段达到电子限速稳态（仅 #autodrive；正常玩法限速只钳速不断动力）
    if (this.autoDrive && this.sm.phase === 'accel' && this.sm.atLimiter) this.forceBrakeTick = true;
    const phase = this.sm.phase;
    const autoThrottle = this.autoDrive && phase === 'accel' ? 1 : 0;
    // 0.9：低于断裂阈值，验证成功刹停路径；#snapdrive 时拉满 1.0 验证断裂→冗余路径
    const autoBrake = this.autoDrive && phase === 'brake' ? (this.snapDrive ? 1 : 0.9) : 0;
    const events = this.sm.step(step, {
      throttle: Math.max(autoThrottle, this.sliders.throttle),
      brake: Math.max(autoBrake, this.sliders.brake),
      brakePressed:
        this.sliders.brakePressed ||
        this.forceBrakeTick ||
        (this.autoDrive && (phase === 'accel' || phase === 'brake'))
    });
    this.forceBrakeTick = false;
    for (const event of events) this.handleEvent(event);
  }

  private handleEvent(event: GameEvent): void {
    switch (event.type) {
      case 'countdown':
        this.hud.showCountdown(`${event.value}`);
        this.sfx.countdownBeep(false);
        this.sfx.revBlip();
        break;
      case 'start':
        this.hud.showCountdown('GO');
        this.sfx.countdownBeep(true);
        window.setTimeout(() => this.hud.showCountdown(null), 700);
        break;
      case 'brake_too_early':
        this.hud.showToast(`车速达到 100 km/h 后才能刹车`);
        this.sfx.warn();
        break;
      case 'brake_start':
        this.rig.setMode('chase');
        this.cycleIndex = 0;
        this.hud.setActiveView('chase');
        this.sliders.lockThrottle();
        this.sliders.hideCutIn();
        this.sfx.brakeClick();
        vibrate(20);
        this.hud.showToast(`动力切断 · 初速度 ${event.v0Kmh.toFixed(1)} km/h`);
        break;
      case 'pedal_snap':
        // 断裂不再翻滚：踏板脱开 + 冗余回路接管，车辆继续行驶至停稳（判负）
        this.sfx.snap();
        this.car.flashBrakeSnap();
        this.car.snapPedal();
        this.brakeFlash = 0.85;
        this.rig.addShake(0.5);
        vibrate([90, 40, 200]);
        this.hud.setRedundancyActive(true);
        this.hud.showToast(
          `刹车踏板断裂！紧急制动安全冗余介入（${Math.round(REDUNDANCY.forceRatio * 100)}% 力度）`,
          true,
          2400
        );
        // 车内视角停留看踏板脱落，之后交还常规机位（玩家仍可自由拖拽环视）。
        // 已在车内则不必切（也没地方还）；R7 用首个内饰机位（主驾），
        // 且 R7 踏板不会断裂 → 该事件本就不会派发。
        this.snapCamReturn = isInteriorMode(this.rig.mode) ? null : this.rig.mode;
        this.rig.setMode(this.interiorMode);
        this.hud.setActiveView(this.interiorMode);
        this.snapCamTimer = REDUNDANCY.cabinHoldSeconds;
        break;
      case 'stopped': {
        // 结算段：电影侧机位 2s → orbit（frame 内按 settleTimer 推进）
        const degraded = event.result.degraded;
        this.settleTimer = 0;
        this.rig.setMode('side');
        this.hud.setActiveView('side');
        this.hud.setRedundancyActive(false);
        if (degraded) {
          this.sfx.warn();
          this.hud.showToast('冗余制动拖停 · 制动系统已失效（判负）', true, 2200);
        } else {
          this.sfx.success();
          vibrate([30, 50, 30]);
          this.hud.showToast('完美刹停！', false, 1600);
        }
        this.pendingResult = { result: event.result, delay: 1.8 };
        break;
      }
      case 'crash': {
        // 翻滚演出只留给撞主殿撞击面（CrashReason='barrier' 枚举冻结；断裂已改为
        // 冗余接管，不再有凭空的翻滚能量来源）
        const speedMs = this.sm.vehicle.speed;
        this.rig.setMode('crash');
        this.hud.setActiveView('crash');
        this.settleTimer = 0;
        this.hud.setRedundancyActive(false);
        this.car.body.rotation.set(0, MODEL_BASE_YAW, 0); // 保留基准偏航 π，只清俯仰/横滚
        this.crashWorld.begin(this.car.root, speedMs); // 主殿实心撞击，无飞散路障块
        this.crashElapsed = 0;
        this.sfx.impact(1);
        this.fx.burstSparks(this.car.root.localToWorld(new THREE.Vector3(0, 0.6, -2.7)));
        this.brakeFlash = 0.5;
        this.rig.addShake(0.8);
        this.hud.showToast('撞上主殿！', true, 2200);
        vibrate([90, 40, 200]);
        this.pendingResult = { result: event.result, delay: CRASH.resultDelaySeconds };
        break;
      }
    }
  }

  /** 渲染帧：视觉更新 + 后处理 + HUD（结构要素 4：渲染循环内部） */
  private frame(dt: number, alpha: number): void {
    this.time += dt;
    // R29：自由探索走独立分支（驾驶器 / 车体位姿 / HUD 全不同），帧尾渲染共用
    if (this.freeDrive) {
      this.frameFree(dt, alpha);
      return;
    }
    let simDt = dt;

    if (this.sm.phase === 'crashed' && this.crashWorld.active) {
      // 慢动作（原版语义：slowMoScale 0.28，1.6s 后回升）
      this.crashElapsed += dt;
      simDt =
        this.crashElapsed < CRASH.slowMoSeconds
          ? dt * CRASH.slowMoScale
          : dt * Math.min(1, CRASH.slowMoScale + (this.crashElapsed - CRASH.slowMoSeconds) * 0.8);
      this.crashWorld.update(simDt);
    }

    const vehicle = this.sm.vehicle;
    const braking = this.sm.phase === 'brake';
    const pedaling = this.sm.phase === 'accel' || braking;

    // ---- 车体视觉（插值 + 俯仰 + 热量 + 灯光）----
    const distance = lerp(this.prevDistance, vehicle.distance, alpha);
    const prevZ = this.car.root.position.z;
    if (this.sm.phase !== 'crashed') this.car.root.position.z = -distance;
    this.car.spinWheels(prevZ - this.car.root.position.z, dt);
    const pitchTarget = clamp(vehicle.accel * 0.0045, -0.05, 0.03);
    this.car.body.rotation.x = damp(this.car.body.rotation.x, pitchTarget, 4, dt);
    const heatRatio = this.car.currentHeat;
    const nextHeat = clamp(
      heatRatio + ((this.sm.pedal.pedalForce / BRAKE.breakForceN) * vehicle.speed * 0.012 - 0.12) * dt,
      0,
      1
    );
    this.car.setBrakeHeat(nextHeat);
    // 断裂后踏板力归零，但车仍在减速：冗余期间刹车灯保持中亮（不是你踩的，但在刹）
    const redundant = this.sm.redundancyActive;
    this.car.setBrakeLights(
      braking && redundant
        ? REDUNDANT_BRAKE_LIGHT
        : braking && this.sm.pedal.pedalForce > 1
          ? 8
          : 1.6
    );
    this.car.setHeadlights(this.sm.phase !== 'menu');
    this.car.update(this.rig.camera, dt);

    // ---- 灯光 / 环境 / 路侧 ----
    const focus = this.sm.phase === 'crashed' ? this.crashWorld.focus : this.car.root.position;
    this.lighting.update(focus);
    this.contactShadow.update(this.car.body);
    this.env.update(this.rig.camera.position);
    // road.update 已摘除（R28，r28_audit §1.2）：警示灯删除后 Road.update 留空壳

    // ---- 内饰仪表 ----
    this.car.updateCluster(
      this.sm.phase === 'crashed' ? this.crashWorld.carSpeed * MS_TO_KMH : this.sm.speedKmh,
      this.sm.pedal.pedalForce,
      Math.abs(vehicle.accel) / 9.81,
      braking ? 'B' : 'D'
    );

    // ---- 断裂特写：车内视角停留 cabinHoldSeconds 后交还原机位 ----
    if (this.snapCamTimer > 0 && this.sm.phase === 'brake') {
      this.snapCamTimer -= dt;
      if (this.snapCamTimer <= 0 && isInteriorMode(this.rig.mode) && this.snapCamReturn) {
        this.rig.setMode(this.snapCamReturn);
        this.hud.setActiveView(this.snapCamReturn);
        this.snapCamReturn = null;
      }
    }

    // ---- 结算段自动机位：crash 2s → side 2s → orbit；stopped: side 2s → orbit ----
    if (this.sm.phase === 'stopped' || this.sm.phase === 'crashed') {
      this.settleTimer += dt;
      const stage: CameraMode =
        this.sm.phase === 'crashed'
          ? this.settleTimer < 2
            ? 'crash'
            : this.settleTimer < 4
              ? 'side'
              : 'orbit'
          : this.settleTimer < 2
            ? 'side'
            : 'orbit';
      if (this.rig.mode !== stage) {
        this.rig.setMode(stage);
        this.hud.setActiveView(stage);
      }
    }

    // ---- 相机与后处理 ----
    this.rig.update(dt, focus, vehicle.speed, this.car.root.quaternion);
    // 车内机位遮挡切换（前挡从内部看是灰板）：仅在模式变化时写，零每帧开销
    // 第一排座椅：车内视角不画自己的座椅（否则正前方是两块绗缝大板）。
    // R15c 实证：按对象隐藏会被合批吞并 → 走独占材质，整批开关。
    // R19：车漆内舱暗面 —— 车内机位把 body-lower/root 切到 BackSide，离开时切回 FrontSide。
    this.syncInteriorOcclusion();
    // R31 运行时治理②：城堡分区按观看距离显隐（内部 20m 滞回，零遍历开销）
    this.castle.updateViewerZ(this.rig.camera.position.z);
    // R40 P0-C：速度自适应运动模糊按「本帧世界位移」给强度，覆盖掉帧帧的位移放大（M1）。
    // 基准 = 顶速 55.5 m/s × 16.7ms ≈ 0.925m/帧 → 强度 0.12；掉帧帧（33ms→1.83m）线性
    // 上探、硬上限 0.18 防糊死；低速（v=5→0.0108）几乎不糊。仅 pedaling 且非 countdown。
    const frameDisp = Math.abs(vehicle.speed) * dt;
    const speedBlur =
      pedaling && this.sm.phase !== 'countdown'
        ? Math.min(0.18, (frameDisp / 0.925) * 0.12)
        : 0;
    this.postfx.setSpeedBlur(speedBlur);
    this.brakeFlash = Math.max(0, this.brakeFlash - dt * 2.2);
    this.postfx.setFlash(this.brakeFlash);

    // ---- 音效（电机 / 风噪 / 胎啸 / 回收提示）----
    // 冗余制动段胎啸按固定 1/4 力度给（比静默滑行更有「电子泵介入」的听感）
    this.sfx.updateEngine(this.sm.speedKmh, pedaling && !braking);
    this.sfx.updateWind(vehicle.speed / (VEHICLE.maxSpeedKmh / MS_TO_KMH));
    this.sfx.updateSqueal(
      // 热保护锁定期间机械制动力被切断 → 不应有胎啸（否则「没刹车却在尖叫」露馅）
      braking && vehicle.thermalHold <= 0
        ? redundant
          ? REDUNDANCY.forceRatio
          : Math.min(1, this.sm.pedal.pedalForce / BRAKE.breakForceN)
        : 0,
      vehicle.speed
    );
    this.sfx.updateRegen(vehicle.regenPowerKw > 1);

    // ---- 特效（轮胎烟 / 刹车痕 / 火花；low 档内部自动关闭）----
    this.fx.update(dt, {
      carRoot: this.car.root,
      brakeIntensity: braking
        ? redundant
          ? REDUNDANCY.forceRatio
          : Math.min(1, this.sm.pedal.pedalForce / BRAKE.breakForceN)
        : 0,
      speedMs: vehicle.speed,
      braking
    });

    // ---- 结算延迟 ----
    if (this.pendingResult) {
      this.pendingResult.delay -= dt;
      if (this.pendingResult.delay <= 0) {
        const { result } = this.pendingResult;
        this.pendingResult = null;
        this.hud.setVisible(false);
        this.result.show(result);
      }
    }

    // ---- HUD（复用载荷对象，避免每帧字面量分配）----
    const h = this.hudInput;
    h.speedKmh = this.sm.phase === 'crashed' ? this.crashWorld.carSpeed * MS_TO_KMH : this.sm.speedKmh;
    h.brakeSeconds = this.sm.brakeElapsed;
    h.distanceToBarrier = this.sm.distanceToBarrier;
    h.pedalForce = this.sm.pedal.pedalForce;
    h.regenPowerKw = vehicle.regenPowerKw;
    h.brakeTemp = vehicle.brakeTemp;
    h.overheat = vehicle.overheat;
    h.thermalHold = vehicle.thermalHold;
    h.scorePreview = this.sm.scorePreview;
    h.canBrake = this.sm.canBrake;
    h.braking = braking;
    h.atLimiter = this.sm.atLimiter;
    h.redundancy = redundant;
    this.hud.update(h);
    this.sliders.setCutInEnabled(this.sm.canBrake || braking, this.sm.canBrake && !braking);
    this.sliders.render(dt);

    this.renderTail(dt, vehicle, alpha);
  }

  /**
   * 帧尾（挑战模式与自由探索共用）：后处理渲染 → 自适应画质 → 帧探针。
   * @param vehicle 挑战模式的车辆状态；自由探索传 null（帧探针只在挑战链路有意义）
   */
  private renderTail(dt: number, vehicle: VehicleState | null, alpha = 0): void {
    /* ══ R39：删掉这里原有的「高速阴影节流」块（R36-P2 遗留）══
     * 原实现：`speed > 8` 时置 `renderer.shadowMap.autoUpdate = false` +
     * `needsUpdate = (shadowFrame===0)`（每 2 帧），低速则 `autoUpdate = true`。
     * 与当时的 `Lighting.update`（`sun.shadow.autoUpdate=false` + **每 N 帧**置灯门，
     * 那 N 就是**已删除**的 `quality.shadowUpdateInterval`）是**两套并联闸门**，
     * 语义互相矛盾，实测后果（.qa/r39_perf）：
     *   · three 的阴影 pass 门有两级：外层 `renderer.shadowMap`（WebGLShadowMap.js:95）
     *     与每灯 `shadow.needsUpdate`（:170）；外层门关掉时**不清**灯门（:376 只清外层），
     *     所以灯门会「粘住」，下一帧外层一开就立刻重绘 ⇒ 实际节拍 = min(两套间隔)，
     *     高速下变成 **2 帧**（设计是 4 帧；节拍直方图实测 {2:146}）。
     *   · 「高速才节流、低速每帧全开」的语义与性能直觉相反：低速段反而最贵。
     * ══ R39 终态（**节流整体拆除，不再有 interval 配置项**）══════════════════════
     * 刷新节拍现在只由 `Lighting` 一处决定：构造期 `sun.shadow.autoUpdate = true`
     * ⇒ **每帧重绘、无节流、无 N 帧门**（`quality.shadowUpdateInterval` 键已删除）。
     * 代价由两件事抵掉，且都**不改观感**：
     *   ① 正交盒/贴图缩档：`shadowOrtho 20→10`、`shadowMapSize 2048→1024`（high）
     *      ⇒ **texel 尺寸 0.01953m 逐位不变**（2048/20 = 1024/10）、覆盖面积 **0.25×**；
     *   ② 加载期 `prewarmGpu()` 预热（首帧不把 shader/贴图冷启动算进帧时）。
     * 收益：整帧 tri/DC **恒定**（168 / 103,953），不再有「奇偶帧交替」——
     *   旧节流下轻重帧交替，逐帧探针会读到两种口径，预算账根本对不上。
     * 高低速同一节拍 ⇒ 每帧成本与车速解耦（这正是用户主诉要的东西）。
     * ⚠ 别再把节流写回这里：两处闸门必然漂移，而漂移后的「实际节拍」只能靠探针才看得见。 */

    // ---- 渲染（结构要素 1 的最终呈现）----
    // 阴影是否参与本帧：R39 起 `autoUpdate=true` ⇒ **恒定参与**，判据改为「整帧 DC 类别」
    // （离线出表：只有一类且比冻结态多 9 DC = 每帧都画）。这里只记录一个常量供 dump 对齐。
    this.postfx.render();
    const drewShadow = true;

    // ---- 自适应画质 ----
    const dr = this.qualityGovernor.update(dt);
    if (dr !== 0) {
      this.renderer.setPixelRatio(this.qualityGovernor.pixelRatio);
      this.postfx.setPixelRatio(this.qualityGovernor.pixelRatio);
    }
    void this.lastImpactStrength;

    // ---- R39 帧成本探针（DEV only；读后清零 info 保证读数是整帧累计）----
    if (this.r39 !== null) {
      const p = this.r39;
      const info = this.renderer.info;
      if (p.n < p.cap) {
        const i = p.n;
        p.t[i] = performance.now();
        p.dt[i] = dt;
        p.speed[i] = Math.abs(vehicle ? vehicle.speed : (this.freeDrive?.state.speed ?? 0));
        p.carZ[i] = this.car.root.position.z;
        p.drew[i] = drewShadow ? 1 : 0;
        // R39：阴影改为每帧重绘后，`due`/`jump` 两条节流口径已不存在（字段保留仅为
        // 与历史 dump 对齐；恒 0 = 本帧没有「节流命中」，因为根本没有节流）。
        // R39 定稿后无节流 ⇒ due/jump 恒 0（字段保留仅为与历史 dump 对齐）。
        // 「阴影每帧都画」的证据在 calls 类别（整轮单一类别，且 = 冻结态 + 9 DC）。
        p.due[i] = 0;
        p.jump[i] = 0;
        p.calls[i] = Math.min(65535, info.render.calls);
        p.tris[i] = Math.min(4294967295, info.render.triangles);
        // 城堡可见分区数：判「流式显隐」是否与帧时尖峰同帧（zoneViews 是运行时私有字段，
        // 这里按 DEV 探针惯例结构化读取，不新增公开接口）
        const zones = (this.castle as unknown as {
          zoneViews?: { mesh: THREE.Mesh; tier?: 'hi' | 'lo' }[];
        }).zoneViews;
        let zVis = 0;
        let zHi = 0;
        if (zones) {
          for (const zv of zones) {
            if (zv.mesh.visible) zVis += 1;
            if (zv.tier === 'hi') zHi += 1;
          }
        }
        p.zones[i] = zVis;
        p.ztier[i] = zHi;
        p.geo[i] = Math.min(65535, info.memory.geometries);
        p.prog[i] = Math.min(65535, info.programs?.length ?? 0);
        p.tex[i] = Math.min(65535, info.memory.textures);
        p.dpr[i] = this.qualityGovernor.pixelRatio;
        p.n += 1;
      }
      this.probeTicks = 0;
      info.reset();
    }

    // ---- perf-r14 帧探针（DEV only；读后清零 info 保证读数是整帧累计）----
    if (this.probeFrames !== null && vehicle !== null) {
      const info = this.renderer.info;
      const cam = this.rig.camera;
      this.probeFrames.push({
        t: performance.now(),
        dt,
        alpha,
        ticks: this.probeTicks,
        distance: vehicle.distance,
        prevDistance: this.prevDistance,
        carZ: this.car.root.position.z,
        carX: this.car.root.position.x,
        camZ: cam.position.z,
        camX: cam.position.x,
        anchorZ: this.rig.anchorView.z,
        speed: vehicle.speed,
        fov: cam.fov,
        dpr: this.renderer.getPixelRatio(),
        calls: info.render.calls,
        tris: info.render.triangles,
        phase: { menu: 0, countdown: 1, accel: 2, brake: 3, stopped: 4, crashed: 5 }[
          this.sm.phase
        ]
      });
      this.probeTicks = 0;
      info.reset();
    }
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.qualityGovernor.pixelRatio);
    this.renderer.setSize(w, h);
    this.rig.resize(w / h);
    this.postfx.setPixelRatio(this.qualityGovernor.pixelRatio);
    this.postfx.resize(w, h);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onOrientation);
    this.lookAbort?.abort();
    this.lookAbort = null;
    // 自由探索的键盘监听必须随 dispose 一起解绑（否则 HMR / 重建时在 window 上累积）
    this.freeDrive?.detach();
    this.freeDrive = null;
    this.loop.dispose();
    this.sfx.dispose();
    this.fx.dispose();
    this.sliders.dispose();
    this.postfx.dispose();
    this.contactShadow.dispose();
    this.castle.dispose();
    this.crashWorld.dispose();
    this.car.dispose();
    this.result.destroy();
    this.renderer.dispose();
  }
}
